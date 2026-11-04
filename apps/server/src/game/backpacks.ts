import {
  createHash,
  randomUUID
} from "node:crypto";
import {
  BACKPACK_DEFINITIONS,
  DEFAULT_PLAYER_CARRY_CAPACITY_GRAMS,
  getBackpackWeightGrams,
  requireBackpackLevel,
  MAX_BACKPACK_UPGRADE_LEVEL,
  requireBackpackDefinition,
  type BackpackAction,
  type BackpackDefinitionId,
  type BackpackErrorCode,
  type BackpackInstanceSnapshot,
  type BackpackOperationResult,
  type BackpackSnapshot,
  type BackpackUnequipDiagnostic,
  type EquippedBackpackSlots
} from "@ash-atlas/shared";
import type pg from "pg";
import { ownedBackpackVisibleSql } from "./droppedItems.js";
import {
  DEFAULT_INVENTORY_VARIANT,
  InventoryService,
  assertInventoryWeightInTransaction,
  lockInventoryCapacity
} from "./inventory.js";
import {
  WalletOperationError,
  WalletService
} from "./wallet.js";
import { requireTradeSkillGate } from "./skills/tradeSkillRank.js";

type Queryable = Pick<pg.PoolClient, "query">;
type BackpackWallet = Pick<WalletService, "debitForOperationInTransaction">;
type BackpackInventory = Pick<
  InventoryService,
  "debitItemsForOperationInTransaction" | "snapshotInTransaction"
>;
type BackpackRow = {
  instance_id: string;
  owner_player_id: string;
  definition_id: BackpackDefinitionId;
  upgrade_level: number;
  location: "inventory" | "equipped" | "manor_storage" | "world_drop" | "destroyed";
  equipped_slot: number | null;
  inventory_slot_index: number | null;
  manor_id: string | null;
  manor_slot_index: number | null;
  version: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type OperationRow = {
  player_id: string;
  account_id: string;
  request_id: string;
  action: BackpackAction;
  request_hash: string;
  original_result: unknown;
  completed_at: Date | string | null;
};

export type BackpackActor = {
  playerId: string;
  accountId: string;
};

export type BackpackServiceOptions = {
  inventory?: BackpackInventory;
  wallet?: BackpackWallet;
  afterDebit?: () => void | Promise<void>;
};

export class BackpackError extends Error {
  constructor(
    readonly code: BackpackErrorCode,
    message: string,
    readonly diagnostic?: BackpackUnequipDiagnostic
  ) {
    super(message);
    this.name = "BackpackError";
  }
}

export class BackpackService {
  private readonly inventory: BackpackInventory;
  private readonly wallet: BackpackWallet;
  private readonly afterDebit: () => void | Promise<void>;

  constructor(
    private readonly pool: pg.Pool,
    options: BackpackServiceOptions = {}
  ) {
    this.inventory = options.inventory ?? new InventoryService(pool);
    this.wallet = options.wallet ?? new WalletService();
    this.afterDebit = options.afterDebit ?? (() => undefined);
  }

  async getSnapshot(playerId: string): Promise<BackpackSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMutation(client, playerId);
      await lockInventoryCapacity(client, playerId);
      await ensureBackpackState(client, playerId);
      const snapshot = await backpackSnapshot(client, playerId);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async snapshotInTransaction(
    queryable: Queryable,
    playerId: string
  ): Promise<BackpackSnapshot> {
    await ensureBackpackState(queryable, playerId);
    await lockInventoryCapacity(queryable, playerId);
    return backpackSnapshot(queryable, playerId);
  }

  async destroyCarriedInstanceForGoblinSaleInTransaction(
    queryable: Queryable,
    playerId: string,
    instanceId: string
  ): Promise<BackpackSnapshot> {
    await ensureBackpackState(queryable, playerId);
    const changed = await queryable.query(
      `UPDATE player_backpack_instances
       SET location='destroyed',equipped_slot=NULL,inventory_slot_index=NULL,
           manor_id=NULL,manor_slot_index=NULL,version=version+1,updated_at=now()
       WHERE instance_id=$1 AND owner_player_id=$2 AND location='inventory'
       RETURNING instance_id`,
      [instanceId, playerId]
    );
    if (changed.rowCount !== 1) {
      throw new BackpackError(
        "BACKPACK_NOT_IN_INVENTORY",
        "Only a backpack carried in inventory can be sold"
      );
    }
    await advanceBackpackState(queryable, playerId);
    return backpackSnapshot(queryable, playerId);
  }

  /** Crafting-menu entry point. A new backpack is an owned inventory item. */
  craft(actor: BackpackActor, requestId: string): Promise<BackpackOperationResult> {
    return this.runOperation(actor, requestId, "create", {}, async (client, operationKey, capacityBefore) => {
      await requireTradeSkillGate(client, actor.playerId, "craft_backpack", (message) => new BackpackError("BACKPACK_SKILL_REQUIRED", message));
      const definition = BACKPACK_DEFINITIONS.starter_backpack;
      const level = requireBackpackLevel(0);
      await this.consumeCost(client, actor, operationKey, level.upgradeCost.leather, level.upgradeCost.gold);
      const instanceId = randomUUID();
      await client.query(`INSERT INTO player_backpack_instances (
       instance_id, owner_player_id, definition_id, location,
       equipped_slot, inventory_slot_index, created_by_operation_key
      ) VALUES ($1,$2,$3,'inventory',NULL,NULL,$4)`, [
        instanceId,
        actor.playerId,
        definition.definitionId,
        operationKey
      ]);
      await advanceBackpackState(client, actor.playerId);
      const capacityAfter = await lockInventoryCapacity(client, actor.playerId);
      await writeBackpackEvent(client, {
        operationKey,
        playerId: actor.playerId,
        action: "create",
        instanceId,
        definitionBefore: null,
        definitionAfter: definition.definitionId,
        locationBefore: null,
        locationAfter: "inventory",
        equippedSlotBefore: null,
        equippedSlotAfter: null,
        capacityBefore,
        capacityAfter
      });
      return {
        instanceId,
        requestedTier: definition.definitionId,
        leatherCost: level.upgradeCost.leather,
        goldCost: level.upgradeCost.gold,
        capacityAfter,
        message: "Backpack +0 crafted and added to Player Inventory."
      };
    });
  }

  /**
   * Legacy onboarding entry point. The target slot is accepted for wire
   * compatibility but intentionally ignored: backpacks are never gated on an
   * equipped slot and always enter the persistent inventory collection.
  */
  createStarter(actor: BackpackActor, requestId: string, _targetEquippedSlot = 0): Promise<BackpackOperationResult> {
    // Keep the legacy target in the idempotency hash so a retry of a
    // pre-migration onboarding request still replays instead of conflicting;
    // the value no longer controls custody or capacity.
    return this.runOperation(actor, requestId, "create", { targetEquippedSlot: _targetEquippedSlot }, async (client, operationKey, capacityBefore) => {
      const definition = BACKPACK_DEFINITIONS.starter_backpack;
      const level = requireBackpackLevel(0);
      await this.consumeCost(client, actor, operationKey, level.upgradeCost.leather, level.upgradeCost.gold);
      const instanceId = randomUUID();
      await client.query(`INSERT INTO player_backpack_instances (
       instance_id, owner_player_id, definition_id, location,
       equipped_slot, inventory_slot_index, created_by_operation_key
      ) VALUES ($1,$2,$3,'inventory',NULL,NULL,$4)`, [
        instanceId,
        actor.playerId,
        definition.definitionId,
        operationKey
      ]);
      await advanceBackpackState(client, actor.playerId);
      const capacityAfter = await lockInventoryCapacity(client, actor.playerId);
      await writeBackpackEvent(client, {
        operationKey,
        playerId: actor.playerId,
        action: "create",
        instanceId,
        definitionBefore: null,
        definitionAfter: definition.definitionId,
        locationBefore: null,
        locationAfter: "inventory",
        equippedSlotBefore: null,
        equippedSlotAfter: null,
        capacityBefore,
        capacityAfter
      });
      return {
        instanceId,
        requestedTier: definition.definitionId,
        leatherCost: level.upgradeCost.leather,
        goldCost: level.upgradeCost.gold,
        capacityAfter,
        message: "Backpack +0 created and added to Player Inventory."
      };
    });
  }

  /**
   * Slot-era mutations remain as rejected wire-compatibility entry points.
   * Ownership, capacity, and custody are changed only by create/upgrade and
   * the canonical manor transfer service; no request can equip a backpack.
   */
  equip(
    actor: BackpackActor,
    requestId: string,
    instanceId: string,
    targetEquippedSlot: number
  ): Promise<BackpackOperationResult> {
    void actor;
    void requestId;
    void instanceId;
    void targetEquippedSlot;
    return Promise.reject(new BackpackError(
      "BACKPACK_INVALID_REQUEST",
      "Backpack equip and unequip actions are no longer supported."
    ));
  }
  unequip(
    actor: BackpackActor,
    requestId: string,
    instanceId: string
  ): Promise<BackpackOperationResult> {
    void actor;
    void requestId;
    void instanceId;
    return Promise.reject(new BackpackError(
      "BACKPACK_INVALID_REQUEST",
      "Backpack equip and unequip actions are no longer supported."
    ));
  }
  upgrade(actor: BackpackActor, requestId: string, instanceId: string): Promise<BackpackOperationResult> {
    return this.runOperation(actor, requestId, "upgrade", { instanceId }, async (client, operationKey, capacityBefore) => {
      const item = await lockOwnedBackpack(client, actor.playerId, instanceId);
      if (item.location !== "inventory" && item.location !== "equipped" && item.location !== "manor_storage") {
        throw new BackpackError("BACKPACK_NOT_IN_INVENTORY", "That backpack is not available to upgrade.");
      }
      const current = requireBackpackDefinition(item.definition_id);
      if (item.upgrade_level >= MAX_BACKPACK_UPGRADE_LEVEL) {
        throw new BackpackError("BACKPACK_MAXIMUM_TIER", "This backpack is already at maximum upgrade +10.");
      }
      const next = requireBackpackLevel(item.upgrade_level + 1);
      await this.consumeCost(client, actor, operationKey, next.upgradeCost.leather, next.upgradeCost.gold);
      await client.query(`UPDATE player_backpack_instances
      SET upgrade_level=$3, version=version+1, updated_at=now()
      WHERE owner_player_id=$1 AND instance_id=$2::uuid`, [actor.playerId, instanceId, next.level]);
      await advanceBackpackState(client, actor.playerId);
      const capacityAfter = await lockInventoryCapacity(client, actor.playerId);
      await writeBackpackEvent(client, {
        operationKey,
        playerId: actor.playerId,
        action: "upgrade",
        instanceId,
        definitionBefore: current.definitionId,
        definitionAfter: current.definitionId,
        locationBefore: item.location,
        locationAfter: item.location,
        equippedSlotBefore: item.equipped_slot,
        equippedSlotAfter: item.equipped_slot,
        capacityBefore,
        capacityAfter
      });
      return {
        instanceId,
        requestedTier: current.definitionId,
        leatherCost: next.upgradeCost.leather,
        goldCost: next.upgradeCost.gold,
        capacityAfter,
        message: `Backpack upgraded to +${next.level}.`
      };
    });
  }

  private async consumeCost(
    client: pg.PoolClient,
    actor: BackpackActor,
    operationKey: string,
    leather: number,
    gold: number
  ): Promise<void> {
    const available = await client.query<{ quantity: string }>(
      `SELECT quantity::text
       FROM player_inventory
       WHERE player_id=$1 AND resource_type='leather' AND variant=$2
       FOR UPDATE`,
      [actor.playerId, DEFAULT_INVENTORY_VARIANT]
    );
    if (BigInt(available.rows[0]?.quantity ?? "0") < BigInt(leather)) {
      throw new BackpackError(
        "BACKPACK_INSUFFICIENT_LEATHER",
        `This backpack requires ${leather} leather.`
      );
    }
    await this.inventory.debitItemsForOperationInTransaction(client, {
      operationKey: `${operationKey}:leather`,
      playerId: actor.playerId,
      source: "backpack",
      sourceEntityType: "backpack_operation",
      sourceEntityId: operationKey,
      debits: [{
        itemId: "leather",
        variant: DEFAULT_INVENTORY_VARIANT,
        quantity: leather
      }]
    });
    try {
      await this.wallet.debitForOperationInTransaction(client, {
        playerId: actor.playerId,
        accountId: actor.accountId,
        amount: BigInt(gold),
        operationKey: `${operationKey}:gold`,
        reason: "backpack_operation_v1",
        metadata: { operationKey }
      });
    } catch (error) {
      if (
        error instanceof WalletOperationError &&
        error.code === "WALLET_INSUFFICIENT_FUNDS"
      ) {
        throw new BackpackError(
          "BACKPACK_INSUFFICIENT_GOLD",
          `This backpack requires ${gold} gold.`
        );
      }
      throw error;
    }
    await this.afterDebit();
  }
  private async runOperation(actor: BackpackActor, requestId: string, action: BackpackAction, intent: Readonly<Record<string, unknown>>, mutate: (client: pg.PoolClient, operationKey: string, capacityBefore: number) => Promise<{
    instanceId: string;
    requestedTier: BackpackDefinitionId | null;
    leatherCost: number;
    goldCost: number;
    capacityAfter: number;
    message: string;
  }>): Promise<BackpackOperationResult> {
    assertRequestId(requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMutation(client, actor.playerId);
      const capacityBefore = await lockInventoryCapacity(client, actor.playerId);
      await ensureBackpackState(client, actor.playerId);
      await client.query(`SELECT revision
     FROM player_backpack_state
     WHERE player_id=$1
     FOR UPDATE`, [actor.playerId]);
      const operationKey = `backpack:${actor.playerId}:${requestId}`;
      const requestHash = hashRequest(action, intent);
      const replay = await reserveOperation(client, operationKey, actor, requestId, action, requestHash);
      if (replay) {
        const currentBackpacks = await backpackSnapshot(client, actor.playerId);
        const currentInventory = await this.inventory.snapshotInTransaction(client, actor.playerId);
        const currentWallet = await walletBalance(client, actor);
        await client.query("COMMIT");
        return { ...replay, replayed: true, backpacks: currentBackpacks,
          inventory: currentInventory, walletGold: currentWallet.gold,
          walletVersion: currentWallet.revision };
      }
      const mutation = await mutate(client, operationKey, capacityBefore);
      await assertInventoryWeightInTransaction(client, actor.playerId);
      const backpacks = await backpackSnapshot(client, actor.playerId);
      const inventory = await this.inventory.snapshotInTransaction(client, actor.playerId);
      const walletSnapshot = await walletBalance(client, actor);
      const result: BackpackOperationResult = {
        requestId,
        action,
        replayed: false,
        backpacks,
        inventory,
        walletGold: walletSnapshot.gold,
        walletVersion: walletSnapshot.revision,
        message: mutation.message
      };
      await client.query(`UPDATE backpack_operations
     SET instance_id=$2::uuid,
       target_equipped_slot=$3,
       requested_tier=$4,
       leather_cost=$5,
       gold_cost=$6,
       capacity_before=$7,
       capacity_after=$8,
       original_result=$9::jsonb,
       completed_at=now()
     WHERE operation_key=$1`, [
        operationKey,
        mutation.instanceId,
        typeof intent.targetEquippedSlot === "number"
          ? intent.targetEquippedSlot
          : null,
        mutation.requestedTier,
        mutation.leatherCost,
        mutation.goldCost,
        capacityBefore,
        mutation.capacityAfter,
        JSON.stringify(result)
      ]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapBackpackError(error);
    } finally {
      client.release();
    }
  }
}

async function lockPlayerMutation(queryable: Queryable, playerId: string): Promise<void> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [playerId]
  );
}

async function ensureBackpackState(queryable: Queryable, playerId: string): Promise<void> {
  await queryable.query(
    `INSERT INTO player_backpack_state (player_id)
     SELECT id FROM players WHERE id=$1
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId]
  );
}

async function advanceBackpackState(queryable: Queryable, playerId: string): Promise<void> {
  await queryable.query(
    `UPDATE player_backpack_state
     SET revision=revision+1, updated_at=now()
     WHERE player_id=$1`,
    [playerId]
  );
}

async function lockOwnedBackpack(
  queryable: Queryable,
  playerId: string,
  instanceId: string
): Promise<BackpackRow> {
  const result = await queryable.query<BackpackRow>(
    `${BACKPACK_ROW_SELECT}
     FROM player_backpack_instances
     WHERE owner_player_id=$1 AND instance_id=$2::uuid
     FOR UPDATE`,
    [playerId, instanceId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new BackpackError(
      "BACKPACK_NOT_OWNED",
      "That backpack is no longer owned."
    );
  }
  return row;
}

async function reserveOperation(
  queryable: Queryable,
  operationKey: string,
  actor: BackpackActor,
  requestId: string,
  action: BackpackAction,
  requestHash: string
): Promise<BackpackOperationResult | null> {
  const inserted = await queryable.query(
    `INSERT INTO backpack_operations (
       operation_key, player_id, account_id, request_id, action, request_hash
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (operation_key) DO NOTHING
     RETURNING operation_key`,
    [operationKey, actor.playerId, actor.accountId, requestId, action, requestHash]
  );
  if (inserted.rowCount === 1) return null;
  const existing = await queryable.query<OperationRow>(
    `SELECT player_id,account_id,request_id,action,request_hash,
            original_result,completed_at
     FROM backpack_operations
     WHERE operation_key=$1`,
    [operationKey]
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.player_id !== actor.playerId ||
    row.account_id !== actor.accountId ||
    row.request_id !== requestId ||
    row.action !== action ||
    row.request_hash !== requestHash
  ) {
    throw new BackpackError(
      "BACKPACK_IDEMPOTENCY_CONFLICT",
      "This request ID was already used for a different backpack action."
    );
  }
  if (!row.completed_at || !isStoredResult(row.original_result)) {
    throw new BackpackError(
      "BACKPACK_OPERATION_INCOMPLETE",
      "This backpack action did not finish. Please reconnect and try again."
    );
  }
  return row.original_result;
}

async function backpackSnapshot(queryable: Queryable, playerId: string): Promise<BackpackSnapshot> {
  const state = await queryable.query<{
    revision: string;
  }>("SELECT revision::text FROM player_backpack_state WHERE player_id=$1", [playerId]);
  const capacity = await queryable.query<{
    base_capacity_grams: string;
  }>(`SELECT base_capacity_grams::text
   FROM player_inventory_capacities WHERE player_id=$1`, [playerId]);
  const rows = await queryable.query<BackpackRow>(`${BACKPACK_ROW_SELECT}
   FROM player_backpack_instances
   WHERE owner_player_id=$1 AND location<>'destroyed'
     AND ${ownedBackpackVisibleSql("player_backpack_instances")}
   ORDER BY created_at,instance_id`, [playerId]);
  const instances = rows.rows.map(mapBackpack);
  const equipped: [
    BackpackInstanceSnapshot | null,
    BackpackInstanceSnapshot | null,
    BackpackInstanceSnapshot | null,
    BackpackInstanceSnapshot | null
  ] = [null, null, null, null];
  for (const item of instances) {
    if (item.location === "equipped" && item.equippedSlot !== null) {
      equipped[item.equippedSlot] = item;
    }
  }
  const capacityRow = capacity.rows[0];
  return {
    playerId,
    revision: safeRevision(state.rows[0]?.revision ?? "0"),
    baseCapacityGrams: Number(capacityRow?.base_capacity_grams ?? DEFAULT_PLAYER_CARRY_CAPACITY_GRAMS),
    backpackBonusGrams: instances.reduce((sum, item) => sum + (item.capacityBonusGrams ?? 0), 0),
    maximumCapacityGrams: Number(capacityRow?.base_capacity_grams ?? DEFAULT_PLAYER_CARRY_CAPACITY_GRAMS) +
      instances.reduce((sum, item) => sum + (item.capacityBonusGrams ?? 0), 0),
    equipped: equipped as EquippedBackpackSlots,
    instances
  };
}

function mapBackpack(row: BackpackRow): BackpackInstanceSnapshot {
  const definition = requireBackpackDefinition(row.definition_id);
  return {
    instanceId: row.instance_id,
    ownerPlayerId: row.owner_player_id,
    definitionId: definition.definitionId,
    displayName: `Backpack +${row.upgrade_level}`,
    location: row.location,
    upgradeLevel: row.upgrade_level,
    capacityBonusGrams: requireBackpackLevel(row.upgrade_level).capacityBonusGrams,
    unitWeightGrams: getBackpackWeightGrams(),
    equippedSlot: row.equipped_slot,
    manorId: row.manor_id,
    manorSlotIndex: row.manor_slot_index,
    version: safeRevision(row.version),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

async function walletBalance(
  queryable: Queryable,
  actor: BackpackActor
): Promise<{ gold: string; revision: string }> {
  await queryable.query(
    `INSERT INTO player_wallets (player_id,account_id,gold_balance,version)
     SELECT id,account_id,0,0 FROM players
     WHERE id=$1 AND account_id=$2
     ON CONFLICT (player_id) DO NOTHING`,
    [actor.playerId, actor.accountId]
  );
  const result = await queryable.query<{ gold_balance: string; version: string }>(
    `SELECT gold_balance::text, version::text
     FROM player_wallets
     WHERE player_id=$1 AND account_id=$2`,
    [actor.playerId, actor.accountId]
  );
  return {
    gold: result.rows[0]?.gold_balance ?? "0",
    revision: result.rows[0]?.version ?? "0"
  };
}

async function writeBackpackEvent(
  queryable: Queryable,
  input: {
    operationKey: string;
    playerId: string;
    action: BackpackAction;
    instanceId: string;
    definitionBefore: BackpackDefinitionId | null;
    definitionAfter: BackpackDefinitionId;
    locationBefore: string | null;
    locationAfter: string;
    equippedSlotBefore: number | null;
    equippedSlotAfter: number | null;
    capacityBefore: number;
    capacityAfter: number;
  }
): Promise<void> {
  await queryable.query(
    `INSERT INTO backpack_events (
       operation_key,player_id,action,instance_id,
       definition_before,definition_after,location_before,location_after,
       equipped_slot_before,equipped_slot_after,capacity_before,capacity_after
     ) VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.operationKey,
      input.playerId,
      input.action,
      input.instanceId,
      input.definitionBefore,
      input.definitionAfter,
      input.locationBefore,
      input.locationAfter,
      input.equippedSlotBefore,
      input.equippedSlotAfter,
      input.capacityBefore,
      input.capacityAfter
    ]
  );
}

function assertRequestId(requestId: string): void {
  if (!requestId || requestId.length > 120) {
    throw new BackpackError(
      "BACKPACK_INVALID_REQUEST",
      "Backpack request ID is required and must be at most 120 characters."
    );
  }
}

function hashRequest(
  action: BackpackAction,
  intent: Readonly<Record<string, unknown>>
): string {
  return createHash("sha256")
    .update(JSON.stringify({ action, ...intent }))
    .digest("hex");
}

function safeRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Backpack revision is outside the safe protocol range");
  }
  return revision;
}

function isoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error("Invalid backpack timestamp");
  return date.toISOString();
}

function isStoredResult(value: unknown): value is BackpackOperationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<BackpackOperationResult>;
  return typeof result.requestId === "string" &&
    typeof result.action === "string" &&
    typeof result.message === "string" &&
    typeof result.walletGold === "string" &&
    !!result.backpacks &&
    !!result.inventory;
}

function mapBackpackError(error: unknown): Error {
  if (error instanceof BackpackError) return error;
  if (
    error instanceof Error &&
    (error.message.includes("invalid input syntax for type uuid") ||
      error.message.includes("violates check constraint"))
  ) {
    return new BackpackError(
      "BACKPACK_INVALID_REQUEST",
      "That backpack request is invalid."
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

const BACKPACK_ROW_SELECT = `SELECT
 instance_id::text,
 owner_player_id,
 definition_id,
 upgrade_level,
 location,
 equipped_slot,
 inventory_slot_index,
 manor_id::text,
 manor_slot_index,
 version::text,
 created_at,
 updated_at`;
