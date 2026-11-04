import { createHash } from "node:crypto";
import { enqueueNativePush, type NativePushAudience } from "../notifications/nativePushOutbox.js";

import {
  INVENTORY_CATALOG,
  PLAYER_PACKAGE_LIMITS,
  createPlayerPackageCampaignSchema,
  playerPackageCatalog,
  requireInventoryCatalogItem,
  type CreatePlayerPackageCampaignInput,
  type EquipmentDefinitionId,
  type PlayerPackageCampaignSummary,
  type PlayerPackageAssetKind,
  type PlayerPackageCharacterSearchResult,
  type PlayerPackageCityCredit,
  type PlayerPackageClaimLineResult,
  type PlayerPackageClaimResult,
  type PlayerPackageKind,
  type PlayerPackageSnapshot,
  type ResourceType,
  isShopCopyItemId
} from "@ash-atlas/shared";
import type pg from "pg";

import {
  EquipmentService
} from "./equipment.js";
import type { FishingService } from "./fishing.js";
import {
  InventoryService,
  inventoryWeightSnapshotInTransaction,
  lockInventoryCapacity,
  type InventoryGrantResult
} from "./inventory.js";
import { CityTreasuryService } from "./cityTreasury.js";
import { markPlayerPackageReadInTransaction } from "./inboxReadReceipts.js";
import { requireRuntimeItemDefinition } from "./items.js";
import { WalletService } from "./wallet.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type PackageHeaderRow = {
  package_id: string;
  campaign_id: string;
  recipient_player_id: string;
  title: string;
  message: string;
  status: "unopened" | "partial" | "claimed";
  read_at: Date | string | null;
  first_claimed_at: Date | string | null;
  claimed_at: Date | string | null;
  created_at: Date | string;
  revision: string;
  kind: PlayerPackageKind;
  sender_player_id: string | null;
  sender_name: string | null;
};

type PackageItemRow = {
  package_id: string;
  line_number: number;
  item_kind: PlayerPackageAssetKind;
  canonical_item_id: string | null;
  variant: string | null;
  original_quantity: string;
  remaining_quantity: string;
};

type NormalizedLine = Readonly<{
  itemKind: PlayerPackageAssetKind;
  itemId: string;
  variant: string | null;
  quantity: number;
}>;

type ClaimReceipt = Readonly<{
  lines: readonly PlayerPackageClaimLineResult[];
  cityCredit: PlayerPackageCityCredit | null;
  message: string;
}>;

export class PlayerPackageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly currentPackage?: PlayerPackageSnapshot
  ) {
    super(message);
    this.name = "PlayerPackageError";
  }
}

export class PlayerPackageService {
  private readonly pushEnqueueEnabled: boolean;
  private readonly pushAudience: NativePushAudience | undefined;
  private readonly inventory: InventoryService;
  private readonly equipment: EquipmentService;
  private readonly fishing: Pick<FishingService, "grantDurableRodsInTransaction"> | null;
  private readonly wallet: WalletService;
  private readonly cityTreasury: CityTreasuryService;

  constructor(
    private readonly pool: pg.Pool,
    options: Readonly<{
      pushEnqueueEnabled?: boolean;
      pushAudience?: NativePushAudience;
      inventory?: InventoryService;
      equipment?: EquipmentService;
      fishing?: Pick<FishingService, "grantDurableRodsInTransaction">;
      wallet?: WalletService;
      cityTreasury?: CityTreasuryService;
    }> = {}
  ) {
    this.pushEnqueueEnabled = options.pushEnqueueEnabled ?? false;
    this.pushAudience = options.pushAudience;
    this.inventory = options.inventory ?? new InventoryService(pool);
    this.equipment = options.equipment ?? new EquipmentService(pool);
    this.fishing = options.fishing ?? null;
    this.wallet = options.wallet ?? new WalletService();
    this.cityTreasury = options.cityTreasury ?? new CityTreasuryService(pool);
  }

  catalog() {
    return playerPackageCatalog().map((item) => item.assetType === "physical"
      ? { ...item, maxStack: requireRuntimeItemDefinition(item.itemId).maxStack ?? 1 }
      : item);
  }

  async eligibleCharacterCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM players"
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async searchCharacters(
    search: string,
    limit: number,
    cursor?: string
  ): Promise<Readonly<{
    characters: PlayerPackageCharacterSearchResult[];
    nextCursor: string | null;
  }>> {
    const normalized = search.trim();
    if (normalized.length > 64) {
      throw new PlayerPackageError(
        "PLAYER_PACKAGE_SEARCH_INVALID",
        "Enter a valid character name"
      );
    }
    const boundedLimit = Math.min(
      PLAYER_PACKAGE_LIMITS.maximumCharacterSearchResults,
      Math.max(1, Math.floor(limit))
    );
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new PlayerPackageError(
        "PLAYER_PACKAGE_SEARCH_INVALID",
        "Character search cursor is invalid"
      );
    }
    const result = await this.pool.query<{
      id: string;
      username: string;
      online: boolean;
    }>(
      `SELECT id, username, online
       FROM players
       WHERE $1 = ''
          OR username_normalized LIKE lower($1) || '%'
          OR username ILIKE '%' || $1 || '%'
       ORDER BY
         (username_normalized = lower($1)) DESC,
         username_normalized,
         id
       LIMIT $2
       OFFSET $3`,
      [normalized, boundedLimit + 1, offset]
    );
    const hasMore = result.rows.length > boundedLimit;
    const characters = result.rows.slice(0, boundedLimit).map((row) => ({
      playerId: row.id,
      displayName: row.username,
      identityHint: row.id.slice(-8),
      online: row.online
    }));
    return {
      characters,
      nextCursor: hasMore ? String(offset + boundedLimit) : null
    };
  }

  async createCampaign(
    actor: Readonly<{
      subject: string;
      playerId: string | null;
    }>,
    rawInput: CreatePlayerPackageCampaignInput
  ): Promise<Readonly<{
    campaignId: string;
    recipientCount: number;
    packageCount: number;
    replayed: boolean;
    recipientPlayerIds: readonly string[];
    packages: readonly PlayerPackageSnapshot[];
  }>> {
    const parsed = createPlayerPackageCampaignSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PlayerPackageError(
        "PLAYER_PACKAGE_SEND_INVALID",
        "Package request is invalid"
      );
    }
    const input = parsed.data;
    const lines = normalizeLines(input.items);
    const requestHash = campaignRequestHash(input, lines);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [input.operationKey]
      );
      const existing = await client.query<{
        id: string;
        request_hash: string;
        created_by_subject: string;
        recipient_count: number;
      }>(
        `SELECT id::text, request_hash, created_by_subject, recipient_count
         FROM player_package_campaigns
         WHERE operation_key = $1
         FOR UPDATE`,
        [input.operationKey]
      );
      if (existing.rowCount) {
        const campaign = existing.rows[0]!;
        if (
          campaign.request_hash !== requestHash ||
          campaign.created_by_subject !== actor.subject
        ) {
          throw new PlayerPackageError(
            "PLAYER_PACKAGE_IDEMPOTENCY_CONFLICT",
            "This package operation key was already used for different contents",
            409
          );
        }
        const packages = await snapshotsForCampaign(client, campaign.id);
        const recipientPlayerIds = await recipientIdsForCampaign(
          client,
          campaign.id
        );
        await client.query("COMMIT");
        return {
          campaignId: campaign.id,
          recipientCount: campaign.recipient_count,
          packageCount: packages.length,
          replayed: true,
          recipientPlayerIds,
          packages
        };
      }

      const recipientPlayerIds = await resolveRecipients(client, input);
      if (recipientPlayerIds.length === 0) {
        throw new PlayerPackageError(
          "PLAYER_PACKAGE_NO_RECIPIENTS",
          "No existing playable characters match this package",
          409
        );
      }
      const insertedCampaign = await client.query<{ id: string }>(
        `INSERT INTO player_package_campaigns (
           operation_key, request_hash, created_by_subject,
           created_by_player_id, target_mode, title, message, recipient_count
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id::text`,
        [
          input.operationKey,
          requestHash,
          actor.subject,
          actor.playerId,
          input.targetMode,
          input.title,
          input.message,
          recipientPlayerIds.length
        ]
      );
      const campaignId = insertedCampaign.rows[0]!.id;
      await client.query(
        `INSERT INTO player_packages (campaign_id, recipient_player_id)
         SELECT $1, recipient_id
         FROM unnest($2::text[]) recipient_id
         ON CONFLICT (campaign_id, recipient_player_id) DO NOTHING`,
        [campaignId, recipientPlayerIds]
      );
      await client.query(
        `INSERT INTO player_package_items (
           package_id, line_number, item_kind, canonical_item_id,
           variant, original_quantity, remaining_quantity, metadata
         )
         SELECT package.id,
                line.line_number,
                line.item_kind,
                line.item_id,
                line.variant,
                line.quantity,
                line.quantity,
                '{}'::jsonb
         FROM player_packages package
         CROSS JOIN unnest(
           $2::smallint[],
           $3::text[],
           $4::text[],
           $5::text[],
           $6::bigint[]
         ) AS line(line_number, item_kind, item_id, variant, quantity)
         WHERE package.campaign_id = $1`,
        [
          campaignId,
          lines.map((_, index) => index + 1),
          lines.map((line) => line.itemKind),
          lines.map((line) =>
            line.itemKind === "gold" || line.itemKind === "city_coins"
              ? null
              : line.itemId
          ),
          lines.map((line) => line.variant),
          lines.map((line) => line.quantity)
        ]
      );
      const packages = await snapshotsForCampaign(client, campaignId);
      if (this.pushEnqueueEnabled) {
        const deliveries = await client.query<{ id: string; recipient_player_id: string }>("SELECT id,recipient_player_id FROM player_packages WHERE campaign_id=$1", [campaignId]);
        for (const entry of deliveries.rows) await enqueueNativePush(client, { enabled: true, audience:this.pushAudience, kind: "package", playerId: entry.recipient_player_id, sourceId: entry.id, eventKey: `package:${entry.id}` });
      }
      await client.query("COMMIT");
      return {
        campaignId,
        recipientCount: recipientPlayerIds.length,
        packageCount: packages.length,
        replayed: false,
        recipientPlayerIds,
        packages
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async campaignHistory(limit = 25): Promise<PlayerPackageCampaignSummary[]> {
    const result = await this.pool.query<{
      campaign_id: string;
      title: string;
      target_mode: "all" | "specific";
      recipient_count: number;
      unopened_count: string;
      partial_count: string;
      claimed_count: string;
      created_at: Date | string;
    }>(
      `SELECT campaign.id::text AS campaign_id,
              campaign.title,
              campaign.target_mode,
              campaign.recipient_count,
              count(package.id) FILTER (WHERE package.status = 'unopened')::text
                AS unopened_count,
              count(package.id) FILTER (WHERE package.status = 'partial')::text
                AS partial_count,
              count(package.id) FILTER (WHERE package.status = 'claimed')::text
                AS claimed_count,
              campaign.created_at
       FROM player_package_campaigns campaign
       JOIN player_packages package ON package.campaign_id = campaign.id
       WHERE campaign.kind = 'admin'
       GROUP BY campaign.id
       ORDER BY campaign.created_at DESC, campaign.id DESC
       LIMIT $1`,
      [Math.min(100, Math.max(1, Math.floor(limit)))]
    );
    return result.rows.map((row) => ({
      campaignId: row.campaign_id,
      title: row.title,
      targetMode: row.target_mode,
      recipientCount: row.recipient_count,
      unopenedCount: Number(row.unopened_count),
      partialCount: Number(row.partial_count),
      claimedCount: Number(row.claimed_count),
      createdAt: iso(row.created_at)
    }));
  }

  async inbox(playerId: string): Promise<PlayerPackageSnapshot[]> {
    return snapshotsForPlayer(this.pool, playerId);
  }

  async claim(
    playerId: string,
    packageId: string,
    requestId: string,
    expectedRevision: string
  ): Promise<PlayerPackageClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [requestId]
      );
      const replay = await client.query<{
        package_id: string;
        player_id: string;
        expected_revision: string;
        result: unknown;
        completed_at: Date | string | null;
      }>(
        `SELECT package_id::text, player_id, expected_revision::text,
                result, completed_at
         FROM player_package_claim_operations
         WHERE request_id = $1
         FOR UPDATE`,
        [requestId]
      );
      if (replay.rowCount) {
        const row = replay.rows[0]!;
        if (
          row.package_id !== packageId ||
          row.player_id !== playerId ||
          row.expected_revision !== expectedRevision ||
          !row.completed_at
        ) {
          throw new PlayerPackageError(
            "PLAYER_PACKAGE_IDEMPOTENCY_CONFLICT",
            "This claim request ID was already used",
            409
          );
        }
        const receipt = parseClaimReceipt(row.result);
        await markPlayerPackageReadInTransaction(
          client,
          playerId,
          packageId
        );
        const result = await currentClaimResult(
          client,
          this.inventory,
          this.equipment,
          playerId,
          packageId,
          requestId,
          receipt,
          true
        );
        await client.query("COMMIT");
        return result;
      }

      const header = await lockPackage(client, packageId);
      if (!header) {
        throw new PlayerPackageError(
          "PLAYER_PACKAGE_NOT_FOUND",
          "Package not found",
          404
        );
      }
      if (header.recipient_player_id !== playerId) {
        throw new PlayerPackageError(
          "PLAYER_PACKAGE_NOT_FOUND",
          "Package not found",
          404
        );
      }
      const currentBefore = await snapshotFromHeader(client, header);
      if (header.status === "claimed") {
        throw new PlayerPackageError(
          "PLAYER_PACKAGE_ALREADY_CLAIMED",
          "This package has already been opened",
          409,
          currentBefore
        );
      }
      if (header.revision !== expectedRevision) {
        throw new PlayerPackageError(
          "PLAYER_PACKAGE_STALE",
          "This package changed. Review the current contents and try again.",
          409,
          currentBefore
        );
      }
      const itemRows = await packageItems(client, packageId, true);
      const isGift = header.kind === "player_gift";
      if (isGift) {
        // Escrowed instances change owner sender -> recipient; take both carry
        // locks in sorted order, the same order a concurrent send uses.
        const owners = await client.query<{ owner_player_id: string }>(
          `SELECT DISTINCT owner_player_id FROM equipment_instances
           WHERE gift_package_id = $1`,
          [packageId]
        );
        for (const id of [...new Set([playerId, ...owners.rows.map((row) => row.owner_player_id)])].sort()) {
          await lockInventoryCapacity(client, id);
        }
      }
      await client.query(
        `INSERT INTO player_package_claim_operations (
           request_id, package_id, player_id, expected_revision
         ) VALUES ($1,$2,$3,$4::bigint)`,
        [requestId, packageId, playerId, expectedRevision]
      );

      const rodLines = itemRows.filter(
        (line) =>
          line.item_kind === "resource" &&
          line.canonical_item_id === "fishing_rod" &&
          BigInt(line.remaining_quantity) > 0n
      );
      const resourceLines = itemRows.filter(
        (line) =>
          (line.item_kind === "resource" || line.item_kind === "consumable") &&
          line.canonical_item_id !== "fishing_rod" &&
          BigInt(line.remaining_quantity) > 0n
      );
      const equipmentLines = itemRows.filter(
        (line) => line.item_kind === "equipment" && BigInt(line.remaining_quantity) > 0n
      );
      const goldLine = itemRows.find(
        (line) => line.item_kind === "gold" && BigInt(line.remaining_quantity) > 0n
      );
      const cityCoinLine = itemRows.find(
        (line) =>
          line.item_kind === "city_coins" &&
          BigInt(line.remaining_quantity) > 0n
      );
      const resourceResult = resourceLines.length
        ? await this.inventory.grantItemsForOperationInTransaction(client, {
            operationKey: `package-claim:${requestId}:inventory`,
            playerId,
            source: isGift ? "player_gift_claim" : "player_package_claim",
            sourceEntityType: "player_package",
            sourceEntityId: packageId,
            metadata: { packageId, requestId },
            allowPartial: true,
            grants: resourceLines.map((line) => ({
              itemId: line.canonical_item_id as ResourceType,
              variant: line.variant,
              quantity: BigInt(line.remaining_quantity)
            }))
          })
        : {
            applied: false,
            inventory: await this.inventory.snapshotInTransaction(client, playerId),
            grants: [] as InventoryGrantResult[]
          };
      const rodResult = rodLines.length
        ? await this.requireFishing().grantDurableRodsInTransaction(client, {
            operationKey: `package-claim:${requestId}:fishing-rods`,
            playerId,
            quantity: rodLines.reduce(
              (total, line) => total + BigInt(line.remaining_quantity),
              0n
            ),
            source: "player_package_claim",
            sourceEntityType: "player_package",
            sourceEntityId: packageId,
            metadata: { packageId, requestId },
            allowPartial: true
          })
        : null;
      const equipmentResult = isGift
        ? await this.transferGiftEquipmentInTransaction(client, playerId, packageId)
        : await this.equipment.grantPackageInstancesInTransaction(
          client,
          {
            operationKey: `package-claim:${requestId}:equipment`,
            playerId,
            grants: equipmentLines.map((line) => ({
              definitionId: line.canonical_item_id as EquipmentDefinitionId,
              quantity: Number(line.remaining_quantity)
            }))
          }
        );
      const goldResult = goldLine
        ? await this.wallet.creditForOperationInTransaction(client, {
            operationKey: `package-claim:${requestId}:gold`,
            playerId,
            accountId: await accountIdForPlayerInTransaction(client, playerId),
            amount: BigInt(goldLine.remaining_quantity),
            reason: "player_package_claim",
            metadata: { packageId, requestId }
          })
        : null;
      let cityCredit: PlayerPackageCityCredit | null = null;
      if (cityCoinLine) {
        const membership =
          await this.cityTreasury.activeMembershipForPlayerInTransaction(
            client,
            playerId
          );
        if (membership) {
          const creditedAmount = Number(cityCoinLine.remaining_quantity);
          const credit =
            await this.cityTreasury.creditContributionInTransaction(client, {
              operationKey: `package-claim:${requestId}:city-coins`,
              cityId: membership.cityId,
              playerId,
              membershipId: membership.membershipId,
              amount: creditedAmount,
              sourceType: "player_package",
              sourceId: packageId,
              ledgerEntryType: "package_grant",
              metadata: { packageId, requestId }
            });
          cityCredit = {
            creditedAmount,
            cityId: membership.cityId,
            cityName: membership.cityName,
            treasuryBalance: credit.balance,
            playerContribution: credit.contribution
          };
        }
      }

      const resourceByIdentity = new Map(
        resourceResult.grants.map((grant) => [
          `${grant.itemId}\0${grant.variant ?? "default"}`,
          grant
        ])
      );
      const rodGrantedQuantity = rodResult?.grants.reduce(
        (total, grant) => total + grant.grantedQuantity,
        0
      ) ?? 0;
      const equipmentByDefinition = new Map(
        equipmentResult.grants.map((grant) => [grant.definitionId, grant])
      );
      const lines: PlayerPackageClaimLineResult[] = [];
      let totalGranted = 0;
      for (const line of itemRows) {
        const requestedQuantity = Number(line.remaining_quantity);
        const itemId = line.canonical_item_id ?? line.item_kind;
        const grantedQuantity = requestedQuantity === 0
          ? 0
          : line.item_kind === "equipment"
            ? equipmentByDefinition.get(
                line.canonical_item_id as EquipmentDefinitionId
              )?.grantedQuantity ?? 0
          : line.item_kind === "resource" && line.canonical_item_id === "fishing_rod"
            ? rodGrantedQuantity
            : line.item_kind === "resource" || line.item_kind === "consumable"
              ? resourceByIdentity.get(
                  `${line.canonical_item_id}\0${line.variant ?? "default"}`
                )?.grantedQuantity ?? 0
              : line.item_kind === "gold"
                ? goldResult
                  ? requestedQuantity
                  : 0
                : cityCredit
                  ? requestedQuantity
                  : 0;
        const remainingQuantity = requestedQuantity - grantedQuantity;
        totalGranted += grantedQuantity;
        if (grantedQuantity > 0) {
          await client.query(
            `UPDATE player_package_items
             SET remaining_quantity = $3
             WHERE package_id = $1
               AND line_number = $2
               AND remaining_quantity = $4`,
            [
              packageId,
              line.line_number,
              remainingQuantity,
              requestedQuantity
            ]
          );
        }
        lines.push({
          lineNumber: line.line_number,
          itemKind: line.item_kind,
          itemId,
          variant: line.variant,
          requestedQuantity,
          grantedQuantity,
          remainingQuantity,
          status: requestedQuantity === 0
            ? "already_consumed"
            : line.item_kind === "city_coins" && !cityCredit
              ? "blocked_city_membership"
              : grantedQuantity === 0
                ? "blocked_inventory_capacity"
                : remainingQuantity > 0
                  ? "partially_granted"
                  : "granted",
          blockedReason: line.item_kind === "city_coins" && !cityCredit
            ? "CITY_MEMBERSHIP_REQUIRED"
            : requestedQuantity > 0 && grantedQuantity === 0
              ? "INVENTORY_CAPACITY"
              : null
        });
      }
      const allClaimed = lines.every((line) => line.remainingQuantity === 0);
      if (totalGranted > 0) {
        await client.query(
          `UPDATE player_packages
           SET status = $2,
               first_claimed_at = COALESCE(first_claimed_at, now()),
               claimed_at = CASE WHEN $2 = 'claimed' THEN now() ELSE NULL END,
               revision = revision + 1
           WHERE id = $1`,
          [packageId, allClaimed ? "claimed" : "partial"]
        );
      }
      await markPlayerPackageReadInTransaction(client, playerId, packageId);
      const message = claimMessage(lines, totalGranted, allClaimed, header.kind === "player_gift");
      const receipt: ClaimReceipt = { lines, cityCredit, message };
      await client.query(
        `UPDATE player_package_claim_operations
         SET result = $2::jsonb, completed_at = now()
         WHERE request_id = $1`,
        [requestId, JSON.stringify(receipt)]
      );
      const updatedPackage = await packageSnapshot(client, packageId);
      if (!updatedPackage) throw new Error("Package disappeared during claim");
      const wallet = await walletBalanceForPlayer(client, playerId);
      await client.query("COMMIT");
      this.equipment.installAuthoritativeSnapshot(
        playerId,
        equipmentResult.equipment
      );
      return {
        requestId,
        replayed: false,
        walletGold: wallet.gold,
        walletVersion: wallet.revision,
        cityCredit,
        inventory: rodResult?.inventory ?? resourceResult.inventory,
        equipment: equipmentResult.equipment,
        package: updatedPackage,
        lines,
        message
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Gifts carry existing instances: move each escrowed instance to the
   * recipient while it fits by weight (checked before the move, never left to
   * the deferred carry guard); the rest stays in escrow for a later claim.
   */
  private async transferGiftEquipmentInTransaction(
    client: pg.PoolClient,
    playerId: string,
    packageId: string
  ): Promise<Readonly<{
    equipment: Awaited<ReturnType<EquipmentService["snapshotInTransaction"]>>;
    grants: ReadonlyArray<Readonly<{ definitionId: string; grantedQuantity: number }>>;
  }>> {
    const pending = await client.query<{ instance_id: string; definition_id: string }>(
      `SELECT link.instance_id::text, instance.definition_id
       FROM player_gift_equipment_instances link
       JOIN equipment_instances instance ON instance.instance_id = link.instance_id
       WHERE link.package_id = $1 AND link.delivered_at IS NULL
       ORDER BY link.line_number, link.instance_id
       FOR UPDATE OF link, instance`,
      [packageId]
    );
    const granted = new Map<string, number>();
    if (pending.rows.length > 0) {
      const weight = await inventoryWeightSnapshotInTransaction(client, playerId);
      let remaining = weight.allowedWeightGrams > weight.currentWeightGrams
        ? weight.allowedWeightGrams - weight.currentWeightGrams
        : 0n;
      for (const row of pending.rows) {
        const unitWeight = BigInt(requireRuntimeItemDefinition(row.definition_id).unitWeightGrams);
        if (unitWeight > remaining) continue;
        const moved = await client.query(
          `UPDATE equipment_instances
           SET owner_player_id = $2, location = 'inventory', gift_package_id = NULL
           WHERE instance_id = $1 AND location = 'gift_escrow' AND gift_package_id = $3`,
          [row.instance_id, playerId, packageId]
        );
        if (moved.rowCount !== 1) {
          throw new PlayerPackageError(
            "PLAYER_PACKAGE_CLAIM_FAILED",
            "Gift equipment changed; try again",
            409
          );
        }
        await client.query(
          "UPDATE player_gift_equipment_instances SET delivered_at = now() WHERE instance_id = $1",
          [row.instance_id]
        );
        remaining -= unitWeight;
        granted.set(row.definition_id, (granted.get(row.definition_id) ?? 0) + 1);
      }
      if (granted.size > 0) {
        await client.query(
          `UPDATE player_equipment_state
           SET inventory_revision = inventory_revision + 1
           WHERE player_id = $1`,
          [playerId]
        );
      }
    }
    return {
      equipment: await this.equipment.snapshotInTransaction(client, playerId),
      grants: [...granted].map(([definitionId, grantedQuantity]) => ({ definitionId, grantedQuantity }))
    };
  }

  private requireFishing(): Pick<FishingService, "grantDurableRodsInTransaction"> {
    if (!this.fishing) {
      throw new PlayerPackageError(
        "PLAYER_PACKAGE_FISHING_UNAVAILABLE",
        "Fishing Rod delivery is unavailable"
      );
    }
    return this.fishing;
  }
}

function normalizeLines(
  input: CreatePlayerPackageCampaignInput["items"]
): NormalizedLine[] {
  const combined = new Map<string, NormalizedLine>();
  for (const raw of input) {
    const virtual = raw.itemKind === "gold" || raw.itemKind === "city_coins";
    const item = virtual
      ? playerPackageCatalog().find((candidate) =>
          candidate.kind === raw.itemKind && candidate.itemId === raw.itemId
        )
      : requireInventoryCatalogItem(raw.itemId);
    // Tagged shop copies are never minted or copied by a campaign: they come only from the
    // Glimmer Shop (a campaign line naming a copy would hand the same copy to every recipient).
    if (!virtual && isShopCopyItemId(raw.itemId)) {
      throw new PlayerPackageError(
        "PLAYER_PACKAGE_ITEM_INVALID",
        "Masks and Manor skins come only from the Glimmer Shop and cannot be sent in a package campaign."
      );
    }
    if (!item || item.kind !== raw.itemKind || !item.packageGrantable) {
      throw new PlayerPackageError(
        "PLAYER_PACKAGE_ITEM_INVALID",
        "Package asset kind does not match its authoritative catalog entry"
      );
    }
    const variant = virtual ? null : raw.variant ?? "default";
    if (!virtual && !item.supportedVariants.includes(variant!)) {
      throw new PlayerPackageError(
        "PLAYER_PACKAGE_ITEM_INVALID",
        `Variant is not grantable for ${item.displayName}`
      );
    }
    const normalizedVariant = variant === "default" ? null : variant;
    const key = `${item.kind}\0${item.itemId}\0${normalizedVariant ?? "default"}`;
    const existing = combined.get(key);
    const quantity = (existing?.quantity ?? 0) + raw.quantity;
    if (item.itemId === "fishing_rod" && quantity !== 1) {
      throw new PlayerPackageError(
        "PLAYER_PACKAGE_QUANTITY_INVALID",
        "Fishing Rod packages can contain exactly one durable rod"
      );
    }
    if (
      !Number.isSafeInteger(quantity) ||
      quantity > PLAYER_PACKAGE_LIMITS.maximumQuantityPerLine
    ) {
      throw new PlayerPackageError(
        "PLAYER_PACKAGE_QUANTITY_INVALID",
        `Quantity exceeds the package limit for ${item.displayName}`
      );
    }
    combined.set(key, {
      itemKind: item.kind,
      itemId: item.itemId,
      variant: normalizedVariant,
      quantity
    });
  }
  const normalized = [...combined.values()].sort((left, right) =>
    left.itemKind.localeCompare(right.itemKind) ||
    left.itemId.localeCompare(right.itemId) ||
    (left.variant ?? "").localeCompare(right.variant ?? "")
  );
  if (normalized.length > PLAYER_PACKAGE_LIMITS.maximumLines) {
    throw new PlayerPackageError(
      "PLAYER_PACKAGE_LINES_INVALID",
      "Package contains too many unique items"
    );
  }
  const equipmentCount = normalized
    .filter((line) => line.itemKind === "equipment")
    .reduce((total, line) => total + line.quantity, 0);
  if (equipmentCount > PLAYER_PACKAGE_LIMITS.maximumEquipmentInstances) {
    throw new PlayerPackageError(
      "PLAYER_PACKAGE_EQUIPMENT_LIMIT",
      "Package contains too many equipment instances"
    );
  }
  return normalized;
}

async function resolveRecipients(
  queryable: Queryable,
  input: CreatePlayerPackageCampaignInput
): Promise<string[]> {
  if (input.targetMode === "all") {
    const result = await queryable.query<{ id: string }>(
      `SELECT id
       FROM players
       ORDER BY id
       FOR SHARE`
    );
    return result.rows.map((row) => row.id);
  }
  const requested = [...new Set(input.recipientPlayerIds)].sort();
  const result = await queryable.query<{ id: string }>(
    `SELECT id
     FROM players
     WHERE id = ANY($1::text[])
     ORDER BY id
     FOR SHARE`,
    [requested]
  );
  if (result.rows.length !== requested.length) {
    throw new PlayerPackageError(
      "PLAYER_PACKAGE_RECIPIENT_INVALID",
      "One or more selected characters no longer exist",
      400
    );
  }
  return result.rows.map((row) => row.id);
}

function campaignRequestHash(
  input: CreatePlayerPackageCampaignInput,
  lines: readonly NormalizedLine[]
): string {
  return createHash("sha256").update(JSON.stringify({
    targetMode: input.targetMode,
    recipientPlayerIds: input.targetMode === "specific"
      ? [...new Set(input.recipientPlayerIds)].sort()
      : [],
    title: input.title,
    message: input.message,
    lines
  })).digest("hex");
}

async function lockPackage(
  queryable: Queryable,
  packageId: string
): Promise<PackageHeaderRow | null> {
  const result = await queryable.query<PackageHeaderRow>(
    `${PACKAGE_HEADER_SELECT}
     WHERE package.id = $1
     FOR UPDATE OF package`,
    [packageId]
  );
  return result.rows[0] ?? null;
}

export async function packageSnapshot(
  queryable: Queryable,
  packageId: string
): Promise<PlayerPackageSnapshot | null> {
  const result = await queryable.query<PackageHeaderRow>(
    `${PACKAGE_HEADER_SELECT}
     WHERE package.id = $1`,
    [packageId]
  );
  return result.rows[0]
    ? snapshotFromHeader(queryable, result.rows[0])
    : null;
}

async function snapshotsForPlayer(
  queryable: Queryable,
  playerId: string
): Promise<PlayerPackageSnapshot[]> {
  const result = await queryable.query<PackageHeaderRow>(
    `${PACKAGE_HEADER_SELECT}
     WHERE package.recipient_player_id = $1
     ORDER BY package.created_at DESC, package.id DESC
     LIMIT 500`,
    [playerId]
  );
  return snapshotsFromHeaders(queryable, result.rows);
}

async function snapshotsForCampaign(
  queryable: Queryable,
  campaignId: string
): Promise<PlayerPackageSnapshot[]> {
  const result = await queryable.query<PackageHeaderRow>(
    `${PACKAGE_HEADER_SELECT}
     WHERE package.campaign_id = $1
     ORDER BY package.recipient_player_id`,
    [campaignId]
  );
  return snapshotsFromHeaders(queryable, result.rows);
}

async function snapshotsFromHeaders(
  queryable: Queryable,
  headers: readonly PackageHeaderRow[]
): Promise<PlayerPackageSnapshot[]> {
  if (headers.length === 0) return [];
  const items = await queryable.query<PackageItemRow>(
    `${PACKAGE_ITEM_SELECT}
     WHERE item.package_id = ANY($1::uuid[])
     ORDER BY item.package_id, item.line_number`,
    [headers.map((header) => header.package_id)]
  );
  const byPackage = new Map<string, PackageItemRow[]>();
  for (const item of items.rows) {
    const rows = byPackage.get(item.package_id) ?? [];
    rows.push(item);
    byPackage.set(item.package_id, rows);
  }
  return headers.map((header) =>
    snapshot(header, byPackage.get(header.package_id) ?? [])
  );
}

async function snapshotFromHeader(
  queryable: Queryable,
  header: PackageHeaderRow
): Promise<PlayerPackageSnapshot> {
  return snapshot(
    header,
    await packageItems(queryable, header.package_id, false)
  );
}

async function packageItems(
  queryable: Queryable,
  packageId: string,
  lock: boolean
): Promise<PackageItemRow[]> {
  const result = await queryable.query<PackageItemRow>(
    `${PACKAGE_ITEM_SELECT}
     WHERE item.package_id = $1
     ORDER BY item.line_number
     ${lock ? "FOR UPDATE" : ""}`,
    [packageId]
  );
  return result.rows;
}

function snapshot(
  header: PackageHeaderRow,
  items: readonly PackageItemRow[]
): PlayerPackageSnapshot {
  return {
    packageId: header.package_id,
    campaignId: header.campaign_id,
    title: header.title,
    message: header.message,
    sender: header.kind === "player_gift"
      ? (header.sender_name ?? "A former player").slice(0, 80)
      : "Ash Atlas",
    kind: header.kind,
    senderPlayerId: header.kind === "player_gift" ? header.sender_player_id : null,
    status: header.status,
    readAt: header.read_at ? iso(header.read_at) : null,
    firstClaimedAt: header.first_claimed_at
      ? iso(header.first_claimed_at)
      : null,
    claimedAt: header.claimed_at ? iso(header.claimed_at) : null,
    createdAt: iso(header.created_at),
    revision: header.revision,
    items: items.map((row) => {
      const itemId = row.canonical_item_id ?? row.item_kind;
      // Gifts may hold items admins cannot grant (Lumen), so fall back to the
      // inventory catalog for physical lines.
      const inventoryItem = INVENTORY_CATALOG[itemId];
      const definition = playerPackageCatalog().find((candidate) =>
        candidate.kind === row.item_kind && candidate.itemId === itemId
      ) ?? (inventoryItem?.kind === row.item_kind ? inventoryItem : undefined);
      if (!definition) {
        throw new PlayerPackageError(
          "PLAYER_PACKAGE_ITEM_INVALID",
          `Unknown package asset ${row.item_kind}:${itemId}`
        );
      }
      return {
        lineNumber: row.line_number,
        itemKind: row.item_kind,
        itemId,
        variant: row.variant,
        displayName: definition.displayName,
        iconKey: definition.iconKey,
        category: definition.category,
        originalQuantity: Number(row.original_quantity),
        remainingQuantity: Number(row.remaining_quantity)
      };
    })
  };
}

async function currentClaimResult(
  queryable: Queryable,
  inventory: InventoryService,
  equipment: EquipmentService,
  playerId: string,
  packageId: string,
  requestId: string,
  receipt: ClaimReceipt,
  replayed: boolean
): Promise<PlayerPackageClaimResult> {
  const packageValue = await packageSnapshot(queryable, packageId);
  if (!packageValue) {
    throw new PlayerPackageError(
      "PLAYER_PACKAGE_NOT_FOUND",
      "Package not found",
      404
    );
  }
  const wallet = await walletBalanceForPlayer(queryable, playerId);
  return {
    requestId,
    replayed,
    walletGold: wallet.gold,
    walletVersion: wallet.revision,
    cityCredit: receipt.cityCredit,
    inventory: await inventory.snapshotInTransaction(queryable, playerId),
    equipment: await equipment.snapshotInTransaction(queryable, playerId),
    package: packageValue,
    lines: receipt.lines,
    message: receipt.message
  };
}

function parseClaimReceipt(value: unknown): ClaimReceipt {
  if (!value || typeof value !== "object") {
    throw new PlayerPackageError(
      "PLAYER_PACKAGE_CLAIM_INCOMPLETE",
      "Claim receipt is incomplete",
      409
    );
  }
  const receipt = value as {
    lines?: unknown;
    cityCredit?: PlayerPackageCityCredit | null;
    message?: unknown;
  };
  if (!Array.isArray(receipt.lines) || typeof receipt.message !== "string") {
    throw new PlayerPackageError(
      "PLAYER_PACKAGE_CLAIM_INCOMPLETE",
      "Claim receipt is incomplete",
      409
    );
  }
  return {
    lines: receipt.lines as PlayerPackageClaimLineResult[],
    cityCredit: receipt.cityCredit ?? null,
    message: receipt.message
  };
}

async function accountIdForPlayerInTransaction(
  queryable: Queryable,
  playerId: string
): Promise<string> {
  const result = await queryable.query<{ account_id: string | null }>(
    `SELECT account_id::text
     FROM players
     WHERE id=$1
     FOR SHARE`,
    [playerId]
  );
  const accountId = result.rows[0]?.account_id;
  if (!accountId) {
    throw new PlayerPackageError(
      "PLAYER_PACKAGE_WALLET_OWNERSHIP_INVALID",
      "The package recipient does not have an authoritative Gold wallet",
      409
    );
  }
  return accountId;
}

async function walletBalanceForPlayer(
  queryable: Queryable,
  playerId: string
): Promise<{ gold: string; revision: string }> {
  const result = await queryable.query<{ gold_balance: string; version: string }>(
    `SELECT wallet.gold_balance::text, wallet.version::text
     FROM player_wallets wallet
     WHERE wallet.player_id=$1`,
    [playerId]
  );
  return {
    gold: result.rows[0]?.gold_balance ?? "0",
    revision: result.rows[0]?.version ?? "0"
  };
}

function claimMessage(
  lines: readonly PlayerPackageClaimLineResult[],
  totalGranted: number,
  allClaimed: boolean,
  isGift = false
): string {
  if (allClaimed) return isGift ? "Gift opened." : "Package opened.";
  const cityBlocked = lines.some(
    (line) => line.status === "blocked_city_membership"
  );
  const inventoryBlocked = lines.some(
    (line) =>
      line.status === "blocked_inventory_capacity" ||
      line.status === "partially_granted"
  );
  if (cityBlocked && totalGranted > 0) {
    return "Other contents were claimed. Join a city before claiming the City Coins in this package.";
  }
  if (cityBlocked) {
    return "Join a city before claiming the City Coins in this package.";
  }
  if (inventoryBlocked && totalGranted > 0) {
    return "Your inventory was partially full. The remaining items are still in this package.";
  }
  return "Your inventory is full. Make room and try again.";
}

async function recipientIdsForCampaign(
  queryable: Queryable,
  campaignId: string
): Promise<string[]> {
  const result = await queryable.query<{ recipient_player_id: string }>(
    `SELECT recipient_player_id
     FROM player_packages
     WHERE campaign_id = $1
     ORDER BY recipient_player_id`,
    [campaignId]
  );
  return result.rows.map((row) => row.recipient_player_id);
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

const PACKAGE_HEADER_SELECT = `
  SELECT package.id::text AS package_id,
         package.campaign_id::text,
         package.recipient_player_id,
         campaign.title,
         campaign.message,
         package.status,
         package.read_at,
         package.first_claimed_at,
         package.claimed_at,
         package.created_at,
         package.revision::text,
         campaign.kind,
         CASE WHEN campaign.kind = 'player_gift'
           THEN campaign.created_by_player_id END AS sender_player_id,
         CASE WHEN campaign.kind = 'player_gift'
           THEN sender.username END AS sender_name
  FROM player_packages package
  JOIN player_package_campaigns campaign ON campaign.id = package.campaign_id
  LEFT JOIN players sender ON sender.id = campaign.created_by_player_id`;

const PACKAGE_ITEM_SELECT = `
  SELECT item.package_id::text,
         item.line_number,
         item.item_kind,
         item.canonical_item_id,
         item.variant,
         item.original_quantity::text,
         item.remaining_quantity::text
  FROM player_package_items item`;
