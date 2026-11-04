import { createHash } from "node:crypto";

import {
  EQUIPMENT_MAX_CONDITION,
  GIFT_BOX_ITEM_ID,
  GIFT_BOX_MAX_PURCHASE_QUANTITY,
  GIFT_BOX_PRICE_GOLD,
  GIFT_MAX_HELD,
  GIFT_MAX_LINES,
  GIFT_MAX_PER_PAIR_PER_DAY,
  GIFT_MAX_SENT_PER_DAY,
  GIFT_MIN_SENDER_LEVEL,
  INVENTORY_CATALOG,
  PLAYER_PACKAGE_LIMITS,
  clampEquipmentCondition,
  equipmentRepairCostForFamily,
  isGiftableItem,
  requireEquipmentDefinition,
  type EquipmentSnapshotV2,
  type PlayerGiftErrorCode,
  type PlayerGiftStatus,
  type PlayerInventorySnapshot,
  type PlayerPackageSnapshot,
  type ResourceType,
  type SendPlayerGiftInput,
  isShopCopyId,
  isShopCopyItemId
} from "@ash-atlas/shared";
import type pg from "pg";

import { isSettledNow } from "../auth/trust/settlement.js";
import { isTrustReviewAccount, type TrustReviewConfig } from "../auth/trust/trustReviewAccounts.js";
import { enqueueNativePush, type NativePushAudience } from "../notifications/nativePushOutbox.js";
import type { EquipmentService } from "./equipment.js";
import {
  InventoryCapacityError,
  isInventoryItemEquippedError,
  lockInventoryCapacity,
  type InventoryService
} from "./inventory.js";
import { packageSnapshot } from "./playerPackages.js";
import { lockPlayerPair } from "./profiles.js";
import { WalletOperationError, type WalletService } from "./wallet.js";

type Queryable = Pick<pg.PoolClient, "query">;

export class PlayerGiftError extends Error {
  constructor(readonly code: PlayerGiftErrorCode, message: string) {
    super(message);
    this.name = "PlayerGiftError";
  }
}

export type GiftBoxPurchaseResult = Readonly<{
  requestId: string;
  replayed: boolean;
  quantity: number;
  totalPriceGold: string;
  walletGold: string;
  walletVersion: string;
  inventory: PlayerInventorySnapshot;
}>;

export type PlayerGiftSendResult = Readonly<{
  requestId: string;
  replayed: boolean;
  packageId: string;
  recipientPlayerId: string;
  recipientName: string;
  inventory: PlayerInventorySnapshot;
  equipment: EquipmentSnapshotV2;
  /** The recipient's new inbox entry (send PLAYER_PACKAGE_AVAILABLE after commit unless replayed). */
  package: PlayerPackageSnapshot;
}>;

type GiftLine = Readonly<{
  itemKind: "resource" | "consumable";
  itemId: string;
  variant: string | null;
  quantity: number;
}>;

const NOT_ENOUGH_ITEMS = "Inventory does not contain enough items";

export class PlayerGiftService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: Readonly<{
      inventory: InventoryService;
      equipment: EquipmentService;
      wallet: WalletService;
      trustConfig?: TrustReviewConfig;
      /** True while developer login is enabled: developer profiles may gift unsettled. */
      devProfilesExempt?: () => boolean;
      pushEnqueueEnabled?: boolean;
      pushAudience?: NativePushAudience;
      now?: () => Date;
    }>
  ) {}

  async buyGiftBoxes(playerId: string, requestId: string, quantity: number): Promise<GiftBoxPurchaseResult> {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > GIFT_BOX_MAX_PURCHASE_QUANTITY) {
      throw new PlayerGiftError("GIFT_BOX_INVALID_QUANTITY", `Buy 1 to ${GIFT_BOX_MAX_PURCHASE_QUANTITY} Gift Boxes at a time.`);
    }
    const total = BigInt(GIFT_BOX_PRICE_GOLD) * BigInt(quantity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`gift-box-purchase:${playerId}:${requestId}`]);
      const accountId = await requireAccountId(client, playerId);
      let applied: boolean;
      try {
        applied = (await this.deps.wallet.debitForOperationInTransaction(client, {
          playerId,
          accountId,
          amount: total,
          operationKey: `gift-box-purchase:${playerId}:${requestId}`,
          reason: "gift_box_purchase",
          metadata: { quantity, unitPriceGold: GIFT_BOX_PRICE_GOLD }
        })).applied;
      } catch (error) {
        if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
          throw new PlayerGiftError("GIFT_BOX_INSUFFICIENT_GOLD", `You need ${total} Gold to buy ${quantity === 1 ? "a Gift Box" : `${quantity} Gift Boxes`}.`);
        }
        if (error instanceof WalletOperationError && error.code === "WALLET_IDEMPOTENCY_CONFLICT") {
          throw new PlayerGiftError("GIFT_BOX_IDEMPOTENCY_CONFLICT", "This purchase request was already used for a different quantity.");
        }
        throw error;
      }
      let inventory: PlayerInventorySnapshot;
      try {
        inventory = (await this.deps.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `gift-box-purchase:${playerId}:${requestId}:items`,
          playerId,
          source: "gift_box_purchase",
          metadata: { quantity },
          grants: [{ itemId: GIFT_BOX_ITEM_ID as ResourceType, variant: null, quantity }]
        })).inventory;
      } catch (error) {
        if (error instanceof InventoryCapacityError) {
          throw new PlayerGiftError("GIFT_BOX_OVER_WEIGHT", "You are carrying too much to take more Gift Boxes.");
        }
        throw error;
      }
      const wallet = await this.deps.wallet.snapshotInTransaction(client, playerId, accountId);
      await client.query("COMMIT");
      return {
        requestId,
        replayed: !applied,
        quantity,
        totalPriceGold: total.toString(),
        walletGold: wallet.gold,
        walletVersion: wallet.revision,
        inventory
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async status(playerId: string): Promise<PlayerGiftStatus> {
    const boxes = await this.pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity), 0)::text AS quantity FROM player_inventory
       WHERE player_id = $1 AND resource_type = $2`,
      [playerId, GIFT_BOX_ITEM_ID]
    );
    const sender = await senderFacts(this.pool, playerId);
    const sentToday = await sentInLastDay(this.pool, playerId, null);
    const held = await heldGiftCount(this.pool, playerId);
    const settledOk = sender ? this.settled(sender) : false;
    const level = sender?.level ?? 0;
    return {
      giftBoxPriceGold: String(GIFT_BOX_PRICE_GOLD),
      giftBoxesOwned: Number(boxes.rows[0]?.quantity ?? 0),
      sentToday,
      maxSentPerDay: GIFT_MAX_SENT_PER_DAY,
      maxPerRecipientPerDay: GIFT_MAX_PER_PAIR_PER_DAY,
      minSenderLevel: GIFT_MIN_SENDER_LEVEL,
      senderLevel: level,
      levelOk: level >= GIFT_MIN_SENDER_LEVEL,
      settledOk,
      heldCount: held,
      maxHeld: GIFT_MAX_HELD,
      maxLines: GIFT_MAX_LINES
    };
  }

  async send(playerId: string, input: SendPlayerGiftInput): Promise<PlayerGiftSendResult> {
    const lines = normalizeGiftLines(input.items);
    const equipmentIds = [...new Set(input.equipmentInstanceIds)].sort();
    if (lines.length + equipmentIds.length === 0) {
      throw new PlayerGiftError("PLAYER_GIFT_EMPTY", "Add at least one item to the gift.");
    }
    if (lines.length + equipmentIds.length > GIFT_MAX_LINES) {
      throw new PlayerGiftError("PLAYER_GIFT_TOO_MANY_LINES", `A gift can hold at most ${GIFT_MAX_LINES} items.`);
    }
    const message = (input.message ?? "").trim();
    const requestHash = createHash("sha256").update(JSON.stringify({
      recipientPlayerId: input.recipientPlayerId,
      message,
      lines,
      equipmentIds
    })).digest("hex");
    const subject = `player:${playerId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.requestId]);
      const existing = await client.query<{ request_hash: string; created_by_subject: string; package_id: string; recipient_player_id: string }>(
        `SELECT campaign.request_hash, campaign.created_by_subject,
                package.id::text AS package_id, package.recipient_player_id
         FROM player_package_campaigns campaign
         JOIN player_packages package ON package.campaign_id = campaign.id
         WHERE campaign.operation_key = $1`,
        [input.requestId]
      );
      if (existing.rowCount) {
        const row = existing.rows[0]!;
        if (row.created_by_subject !== subject || row.request_hash !== requestHash) {
          throw new PlayerGiftError("PLAYER_GIFT_IDEMPOTENCY_CONFLICT", "This gift request was already used for different contents.");
        }
        const result = await this.sendResult(client, playerId, input.requestId, row.package_id, true);
        await client.query("COMMIT");
        this.deps.equipment.installAuthoritativeSnapshot(playerId, result.equipment);
        return result;
      }

      if (input.recipientPlayerId === playerId) {
        throw new PlayerGiftError("PLAYER_GIFT_SELF", "You cannot send a gift to yourself.");
      }
      const recipient = await client.query<{ account_id: string | null; username: string }>(
        "SELECT account_id::text, username FROM players WHERE id = $1",
        [input.recipientPlayerId]
      );
      const recipientRow = recipient.rows[0];
      if (!recipientRow) {
        throw new PlayerGiftError("PLAYER_GIFT_RECIPIENT_NOT_FOUND", "That player could not be found.");
      }
      const sender = await senderFacts(client, playerId);
      if (!sender) throw new PlayerGiftError("PLAYER_GIFT_FAILED", "Your character could not be found.");
      if (sender.accountId && sender.accountId === recipientRow.account_id) {
        throw new PlayerGiftError("PLAYER_GIFT_SAME_ACCOUNT", "You cannot send gifts between characters on the same account.");
      }
      // A block racing this send is serialized by the same pair lock profiles use.
      await lockPlayerPair(client, playerId, input.recipientPlayerId);
      const blocked = await client.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM player_blocks
           WHERE (blocker_id = $1 AND blocked_id = $2)
              OR (blocker_id = $2 AND blocked_id = $1)
         ) AS blocked`,
        [playerId, input.recipientPlayerId]
      );
      if (blocked.rows[0]?.blocked) {
        throw new PlayerGiftError("PLAYER_GIFT_BLOCKED", "You cannot send gifts to this player.");
      }
      if (sender.level < GIFT_MIN_SENDER_LEVEL) {
        throw new PlayerGiftError("PLAYER_GIFT_SENDER_LEVEL", `Reach level ${GIFT_MIN_SENDER_LEVEL} to send gifts.`);
      }
      if (!this.settled(sender)) {
        throw new PlayerGiftError("PLAYER_GIFT_SENDER_UNSETTLED", "You can send gifts once you've settled in. Keep playing from your home area.");
      }
      // One gift lock per player, in sorted order: serializes the sender's
      // daily count and the recipient's held count without deadlocks.
      for (const id of [playerId, input.recipientPlayerId].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`player-gift:${id}`]);
      }
      if (await sentInLastDay(client, playerId, null) >= GIFT_MAX_SENT_PER_DAY) {
        throw new PlayerGiftError("PLAYER_GIFT_DAILY_LIMIT", `You can send ${GIFT_MAX_SENT_PER_DAY} gifts per day.`);
      }
      if (await sentInLastDay(client, playerId, input.recipientPlayerId) >= GIFT_MAX_PER_PAIR_PER_DAY) {
        throw new PlayerGiftError("PLAYER_GIFT_PAIR_LIMIT", `You can send ${recipientRow.username} ${GIFT_MAX_PER_PAIR_PER_DAY} gifts per day.`);
      }
      if (await heldGiftCount(client, input.recipientPlayerId) >= GIFT_MAX_HELD) {
        throw new PlayerGiftError("PLAYER_GIFT_RECIPIENT_FULL", `${recipientRow.username} is already holding ${GIFT_MAX_HELD} gifts.`);
      }
      for (const id of [playerId, input.recipientPlayerId].sort()) {
        await lockInventoryCapacity(client, id);
      }
      const equipmentLines = await this.lockGiftableEquipment(client, playerId, equipmentIds);

      const campaign = await client.query<{ id: string }>(
        `INSERT INTO player_package_campaigns (
           operation_key, request_hash, created_by_subject, created_by_player_id,
           target_mode, title, message, recipient_count, kind
         ) VALUES ($1,$2,$3,$4,'specific',$5,$6,1,'player_gift')
         RETURNING id::text`,
        [input.requestId, requestHash, subject, playerId, `Gift from ${sender.username}`.slice(0, 80), message]
      );
      const pkg = await client.query<{ id: string }>(
        `INSERT INTO player_packages (campaign_id, recipient_player_id)
         VALUES ($1,$2) RETURNING id::text`,
        [campaign.rows[0]!.id, input.recipientPlayerId]
      );
      const packageId = pkg.rows[0]!.id;
      const allLines = [
        ...lines.map((line) => ({ kind: line.itemKind, itemId: line.itemId, variant: line.variant, quantity: line.quantity })),
        ...equipmentLines.map((line) => ({ kind: "equipment", itemId: line.definitionId, variant: null, quantity: line.instanceIds.length }))
      ];
      await client.query(
        `INSERT INTO player_package_items (
           package_id, line_number, item_kind, canonical_item_id,
           variant, original_quantity, remaining_quantity, metadata
         )
         SELECT $1, line.line_number, line.item_kind, line.item_id, line.variant,
                line.quantity, line.quantity, '{}'::jsonb
         FROM unnest($2::smallint[], $3::text[], $4::text[], $5::text[], $6::bigint[])
           AS line(line_number, item_kind, item_id, variant, quantity)`,
        [
          packageId,
          allLines.map((_, index) => index + 1),
          allLines.map((line) => line.kind),
          allLines.map((line) => line.itemId),
          allLines.map((line) => line.variant),
          allLines.map((line) => line.quantity)
        ]
      );

      await this.debit(client, {
        operationKey: `player-gift-send:${input.requestId}:box`,
        playerId,
        source: "gift_box_consume",
        sourceEntityType: "player_package",
        sourceEntityId: packageId,
        metadata: { packageId },
        debits: [{ itemId: GIFT_BOX_ITEM_ID as ResourceType, variant: null, quantity: 1 }]
      }, "PLAYER_GIFT_NO_GIFT_BOX", "You need a Gift Box to send a gift.");
      if (lines.length > 0) {
        await this.debit(client, {
          operationKey: `player-gift-send:${input.requestId}:items`,
          playerId,
          source: "player_gift_send",
          sourceEntityType: "player_package",
          sourceEntityId: packageId,
          metadata: { packageId, recipientPlayerId: input.recipientPlayerId },
          debits: lines.map((line) => ({ itemId: line.itemId as ResourceType, variant: line.variant, quantity: line.quantity }))
        }, "PLAYER_GIFT_ITEMS_UNAVAILABLE", "You no longer have all of those items.");
      }
      if (equipmentLines.length > 0) {
        const instanceIds = equipmentLines.flatMap((line) => line.instanceIds);
        const moved = await client.query(
          `UPDATE equipment_instances
           SET location = 'gift_escrow', gift_package_id = $3
           WHERE instance_id = ANY($1::uuid[]) AND owner_player_id = $2 AND location = 'inventory'
             AND NOT ring_rough`,
          [instanceIds, playerId, packageId]
        );
        if (moved.rowCount !== instanceIds.length) {
          throw new PlayerGiftError("PLAYER_GIFT_EQUIPMENT_NOT_ELIGIBLE", "That equipment is no longer in your inventory.");
        }
        await client.query(
          `INSERT INTO player_gift_equipment_instances (instance_id, package_id, line_number)
           SELECT instance_id, $2, line_number
           FROM unnest($1::uuid[], $3::smallint[]) AS link(instance_id, line_number)`,
          [
            instanceIds,
            packageId,
            equipmentLines.flatMap((line, index) => line.instanceIds.map(() => lines.length + index + 1))
          ]
        );
        await client.query(
          "UPDATE player_equipment_state SET inventory_revision = inventory_revision + 1 WHERE player_id = $1",
          [playerId]
        );
      }
      await enqueueNativePush(client, {
        enabled: this.deps.pushEnqueueEnabled ?? false,
        audience: this.deps.pushAudience,
        kind: "package",
        playerId: input.recipientPlayerId,
        sourceId: packageId,
        eventKey: `package:${packageId}`
      });
      const result = await this.sendResult(client, playerId, input.requestId, packageId, false);
      await client.query("COMMIT");
      this.deps.equipment.installAuthoritativeSnapshot(playerId, result.equipment);
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private settled(sender: SenderFacts): boolean {
    if (sender.devProfile && (this.deps.devProfilesExempt?.() ?? false)) return true;
    if (isTrustReviewAccount(this.deps.trustConfig ?? {}, sender.accountId)) return true;
    return isSettledNow(
      { settledAt: sender.settledAt, provisionalUntil: sender.provisionalUntil },
      this.deps.now?.() ?? new Date()
    );
  }

  private async debit(
    client: pg.PoolClient,
    input: Parameters<InventoryService["debitItemsForOperationInTransaction"]>[1],
    code: PlayerGiftErrorCode,
    message: string
  ): Promise<void> {
    try {
      await this.deps.inventory.debitItemsForOperationInTransaction(client, input);
    } catch (error) {
      if (error instanceof Error && error.message === NOT_ENOUGH_ITEMS) {
        throw new PlayerGiftError(code, message);
      }
      if (isInventoryItemEquippedError(error)) throw new PlayerGiftError("PLAYER_GIFT_ITEM_NOT_GIFTABLE", error.message);
      throw error;
    }
  }

  /** Same per-instance refusals as a market listing; equipped items must be unequipped first. */
  private async lockGiftableEquipment(
    client: pg.PoolClient,
    playerId: string,
    instanceIds: readonly string[]
  ): Promise<Array<{ definitionId: string; instanceIds: string[] }>> {
    if (instanceIds.length === 0) return [];
    if (this.deps.equipment.pendingActivation(playerId)) {
      throw new PlayerGiftError("PLAYER_GIFT_EQUIPMENT_NOT_ELIGIBLE", "Equipment cannot be gifted during a combat-kit change.");
    }
    const rows = await client.query<{
      instance_id: string;
      definition_id: string;
      owner_player_id: string;
      location: string;
      condition: number;
      blocked: boolean;
    }>(
      `SELECT instance.instance_id::text, instance.definition_id, instance.owner_player_id,
              instance.location, instance.condition,
              (
                EXISTS (SELECT 1 FROM player_unique_item_protections protection
                        WHERE protection.player_id = $2
                          AND protection.equipment_instance_id = instance.instance_id
                          AND protection.protected)
                OR EXISTS (SELECT 1 FROM combat_kit_items kit
                           WHERE kit.player_id = $2 AND kit.instance_id = instance.instance_id)
                OR EXISTS (SELECT 1 FROM equipment_operations operation
                           WHERE operation.player_id = $2
                             AND operation.instance_id = instance.instance_id
                             AND operation.completed_at IS NULL)
              ) AS blocked
       FROM equipment_instances instance
       WHERE instance.instance_id = ANY($1::uuid[])
       ORDER BY instance.instance_id
       FOR UPDATE OF instance`,
      [instanceIds, playerId]
    );
    if (rows.rows.length !== instanceIds.length) {
      throw new PlayerGiftError("PLAYER_GIFT_EQUIPMENT_NOT_ELIGIBLE", "That equipment is not in your inventory.");
    }
    const byDefinition = new Map<string, string[]>();
    for (const row of rows.rows) {
      if (row.owner_player_id !== playerId || row.location !== "inventory") {
        throw new PlayerGiftError("PLAYER_GIFT_EQUIPMENT_NOT_ELIGIBLE", "Unequip the item and keep it in your inventory to gift it.");
      }
      const definition = requireEquipmentDefinition(row.definition_id);
      if (!definition.marketTradable) {
        throw new PlayerGiftError("PLAYER_GIFT_EQUIPMENT_NOT_ELIGIBLE", `${definition.displayName} cannot be gifted.`);
      }
      if (
        definition.category === "chest_armor" &&
        equipmentRepairCostForFamily(definition.gameplayFamilyId) &&
        clampEquipmentCondition(row.condition) < EQUIPMENT_MAX_CONDITION
      ) {
        throw new PlayerGiftError("PLAYER_GIFT_EQUIPMENT_NOT_ELIGIBLE", "Chest armor must be fully repaired before it can be gifted.");
      }
      if (row.blocked) {
        throw new PlayerGiftError("PLAYER_GIFT_EQUIPMENT_NOT_ELIGIBLE", "Protected, saved-kit, or pending equipment cannot be gifted.");
      }
      byDefinition.set(row.definition_id, [...(byDefinition.get(row.definition_id) ?? []), row.instance_id]);
    }
    return [...byDefinition].sort(([left], [right]) => left.localeCompare(right))
      .map(([definitionId, ids]) => ({ definitionId, instanceIds: ids }));
  }

  private async sendResult(
    client: pg.PoolClient,
    playerId: string,
    requestId: string,
    packageId: string,
    replayed: boolean
  ): Promise<PlayerGiftSendResult> {
    const snapshot = await packageSnapshot(client, packageId);
    if (!snapshot) throw new PlayerGiftError("PLAYER_GIFT_FAILED", "Gift could not be loaded.");
    const recipient = await client.query<{ id: string; username: string }>(
      `SELECT player.id, player.username FROM player_packages package
       JOIN players player ON player.id = package.recipient_player_id
       WHERE package.id = $1`,
      [packageId]
    );
    return {
      requestId,
      replayed,
      packageId,
      recipientPlayerId: recipient.rows[0]!.id,
      recipientName: recipient.rows[0]!.username,
      inventory: await this.deps.inventory.snapshotInTransaction(client, playerId),
      equipment: await this.deps.equipment.snapshotInTransaction(client, playerId),
      package: snapshot
    };
  }
}

type SenderFacts = Readonly<{
  accountId: string | null;
  username: string;
  level: number;
  settledAt: Date | null;
  provisionalUntil: Date | null;
  devProfile: boolean;
}>;

async function senderFacts(queryable: Queryable, playerId: string): Promise<SenderFacts | null> {
  const result = await queryable.query<{
    account_id: string | null;
    username: string;
    level: number | null;
    settled_at: Date | null;
    provisional_until: Date | null;
    dev_profile: boolean;
  }>(
    `SELECT p.account_id::text, p.username, progression.level,
            st.settled_at, st.provisional_until,
            EXISTS (
              SELECT 1 FROM account_identities i
              WHERE i.account_id = p.account_id
                AND i.provider_subject LIKE 'ash-atlas-dev:%'
            ) AS dev_profile
     FROM players p
     LEFT JOIN player_progression_profiles progression ON progression.player_id = p.id
     LEFT JOIN account_settlement st ON st.account_id = p.account_id
     WHERE p.id = $1`,
    [playerId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    accountId: row.account_id,
    username: row.username,
    level: row.level ?? 0,
    settledAt: row.settled_at,
    provisionalUntil: row.provisional_until,
    devProfile: row.dev_profile
  };
}

async function sentInLastDay(queryable: Queryable, senderId: string, recipientId: string | null): Promise<number> {
  const result = await queryable.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM player_package_campaigns campaign
     JOIN player_packages package ON package.campaign_id = campaign.id
     WHERE campaign.kind = 'player_gift'
       AND campaign.created_by_player_id = $1
       AND campaign.created_at > now() - interval '24 hours'
       AND ($2::text IS NULL OR package.recipient_player_id = $2)`,
    [senderId, recipientId]
  );
  return result.rows[0]?.count ?? 0;
}

async function heldGiftCount(queryable: Queryable, recipientId: string): Promise<number> {
  const result = await queryable.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM player_packages package
     JOIN player_package_campaigns campaign ON campaign.id = package.campaign_id
     WHERE package.recipient_player_id = $1
       AND package.status <> 'claimed'
       AND campaign.kind = 'player_gift'`,
    [recipientId]
  );
  return result.rows[0]?.count ?? 0;
}

async function requireAccountId(queryable: Queryable, playerId: string): Promise<string> {
  const result = await queryable.query<{ account_id: string | null }>(
    "SELECT account_id::text FROM players WHERE id = $1 FOR SHARE",
    [playerId]
  );
  const accountId = result.rows[0]?.account_id;
  if (!accountId) throw new PlayerGiftError("GIFT_BOX_PURCHASE_FAILED", "Your Gold wallet is unavailable.");
  return accountId;
}

function normalizeGiftLines(items: SendPlayerGiftInput["items"]): GiftLine[] {
  const combined = new Map<string, GiftLine>();
  for (const raw of items) {
    const item = INVENTORY_CATALOG[raw.itemId];
    if (!item || !isGiftableItem(raw.itemId) || item.kind !== raw.itemKind) {
      throw new PlayerGiftError("PLAYER_GIFT_ITEM_NOT_GIFTABLE", `${item?.displayName ?? "That item"} cannot be gifted.`);
    }
    const variant = raw.variant ?? "default";
    if (isShopCopyItemId(item.itemId) ? !isShopCopyId(variant) : !item.supportedVariants.includes(variant)) {
      throw new PlayerGiftError("PLAYER_GIFT_ITEM_NOT_GIFTABLE", `${item.displayName} cannot be gifted in that variant.`);
    }
    const normalizedVariant = variant === "default" ? null : variant;
    const key = `${item.itemId}\0${variant}`;
    const quantity = (combined.get(key)?.quantity ?? 0) + raw.quantity;
    if (!Number.isSafeInteger(quantity) || quantity > PLAYER_PACKAGE_LIMITS.maximumQuantityPerLine) {
      throw new PlayerGiftError("PLAYER_GIFT_INVALID", `Too many ${item.displayName} in one gift.`);
    }
    combined.set(key, { itemKind: raw.itemKind, itemId: item.itemId, variant: normalizedVariant, quantity });
  }
  return [...combined.values()].sort((left, right) =>
    left.itemId.localeCompare(right.itemId) || (left.variant ?? "").localeCompare(right.variant ?? "")
  );
}
