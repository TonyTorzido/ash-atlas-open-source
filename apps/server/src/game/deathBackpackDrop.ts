import {
  chooseDeathDropBackpack,
  deathBackpackDropSkipReason,
  paidCharacterLevel,
  requireEquipmentDefinition,
  type DeathDropOutcome,
  type DeathDropSpace,
  type DeathDropSummary,
  type DeathDropSummaryLine,
  type EquipmentDefinitionId,
  type InventoryItemType,
  type LatLon,
  type PlayerInventorySnapshot,
  type ServerMessage,
  planDeathDropOverflow
} from "@ash-atlas/shared";
import type pg from "pg";

import type { BackpackService } from "./backpacks.js";
import {
  createSystemGroundDropsInTransaction,
  dropBackpackToGroundInTransaction,
  dropEquipmentToGroundInTransaction,
  type GroundPlacement
} from "./droppedItems.js";
import type { EquipmentService } from "./equipment.js";
import { DEFAULT_INVENTORY_VARIANT, type InventoryService } from "./inventory.js";
import { lockInventoryProtection, materialProtectionAllocation } from "./inventoryProtection.js";
import { requireItemDefinition } from "./items.js";
import { zoneIdForRegion } from "./state.js";

/** Where the victim died, captured at defeat (before any respawn can move them). */
export type DeathDropContext = Readonly<{
  space: DeathDropSpace;
  position?: LatLon;
  regionCode?: string;
}>;

/** Metadata field written at defeat; absent on a death recovered after a restart. */
export const DEATH_DROP_METADATA_KEY = "deathDrop";

export type DeathBackpackDropResult = Readonly<{
  /** False when this death was already settled (replay). */
  applied: boolean;
  summary: DeathDropSummary;
  position: LatLon | null;
  inventory: PlayerInventorySnapshot | null;
  equipmentDropped: boolean;
}>;

type DeathDropInventory = Pick<
  InventoryService,
  "debitItemsForOperationInTransaction" | "lockPlayerInventoryForOperationInTransaction" | "snapshotInTransaction"
>;

type StoredResult = { summary: DeathDropSummary; position: LatLon | null };

/** The context written into the death metadata at defeat time (JSON-safe). */
export function deathDropContextAtDefeat(
  inDungeon: boolean,
  worldPresent: boolean,
  player: Readonly<{ position: LatLon; regionCode: string }> | undefined
): Record<string, unknown> {
  if (inDungeon) return { space: "dungeon" };
  if (!worldPresent || !player) return { space: "interior" };
  return { space: "overworld", lat: player.position.lat, lon: player.position.lon, regionCode: player.regionCode };
}

export function deathDropContextFromMetadata(metadata: Record<string, unknown> | undefined): DeathDropContext | null {
  const raw = metadata?.[DEATH_DROP_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.space === "dungeon" || value.space === "interior") return { space: value.space };
  if (
    value.space === "overworld" &&
    typeof value.lat === "number" && Number.isFinite(value.lat) &&
    typeof value.lon === "number" && Number.isFinite(value.lon) &&
    typeof value.regionCode === "string" && value.regionCode.length > 0
  ) {
    return { space: "overworld", position: { lat: value.lat, lon: value.lon }, regionCode: value.regionCode };
  }
  return null;
}

/**
 * Death backpack drop for one player death (order in
 * @ash-atlas/shared deathBackpackDrop.ts): the lowest-level carried backpack
 * plus whatever no longer fits leave the victim for the overworld ground.
 *
 * One transaction moves everything and records the outcome under the death's
 * operation key; an advisory lock on that key serializes replays and a replay
 * returns the first result without moving anything. Lock order: inventory
 * protection (always first, as in every manual drop), then the carry lock,
 * then the backpack, equipment and inventory rows, then player_equipment_state
 * (only when gear drops) and the ground-pile keys. Carry before equipment
 * state is the order repair, crafting, upgrades and equipment pickup use.
 */
export async function applyDeathBackpackDrop(
  pool: pg.Pool,
  inventory: DeathDropInventory,
  input: Readonly<{
    deathOperationKey: string;
    victimPlayerId: string;
    metadata?: Record<string, unknown>;
    now?: Date;
    /** Uniform in [0, 1) for the random overflow order; Math.random by default. */
    random?: () => number;
  }>
): Promise<DeathBackpackDropResult> {
  const key = input.deathOperationKey;
  const playerId = input.victimPlayerId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`death-backpack-drop:${key}`]);
    const prior = await client.query<{ result: StoredResult }>(
      "SELECT result FROM player_death_backpack_drops WHERE operation_key=$1",
      [key]
    );
    if (prior.rows[0]) {
      await client.query("COMMIT");
      return {
        applied: false,
        summary: prior.rows[0].result.summary,
        position: prior.rows[0].result.position,
        inventory: null,
        equipmentDropped: false
      };
    }
    const record = async (
      outcome: DeathDropOutcome,
      result: StoredResult,
      backpack: { instanceId: string; dropId: string } | null = null
    ) => {
      await client.query(
        `INSERT INTO player_death_backpack_drops (
           operation_key,player_id,outcome,backpack_instance_id,backpack_drop_id,result
         ) VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6::jsonb)`,
        [key, playerId, outcome, backpack?.instanceId ?? null, backpack?.dropId ?? null, JSON.stringify(result)]
      );
    };
    const skipped = async (outcome: DeathDropOutcome): Promise<DeathBackpackDropResult> => {
      const summary: DeathDropSummary = { outcome, lines: [] };
      await record(outcome, { summary, position: null });
      await client.query("COMMIT");
      return { applied: true, summary, position: null, inventory: null, equipmentDropped: false };
    };

    const context = deathDropContextFromMetadata(input.metadata);
    const progression = await client.query<{ total_xp: string; level: number }>(
      "SELECT total_xp::text, level FROM player_progression_profiles WHERE player_id=$1",
      [playerId]
    );
    const level = paidCharacterLevel(Number(progression.rows[0]?.total_xp ?? 0), progression.rows[0]?.level);
    const skip = deathBackpackDropSkipReason({
      space: context?.space ?? null,
      killedByPlayer: typeof input.metadata?.killerPlayerId === "string",
      level
    });
    if (skip) return await skipped(skip);
    const position = context!.position!;
    const regionCode = context!.regionCode!;

    await lockInventoryProtection(client, playerId);
    await inventory.lockPlayerInventoryForOperationInTransaction(client, playerId);

    const backpackRows = await client.query<{
      instance_id: string;
      upgrade_level: number;
      location: "equipped" | "inventory";
      equipped_slot: number | null;
      capacity_bonus_grams: string;
    }>(
      `SELECT backpack.instance_id::text,backpack.upgrade_level,backpack.location,backpack.equipped_slot,
              level.capacity_bonus_grams::text
       FROM player_backpack_instances backpack
       JOIN backpack_level_definitions level ON level.level=backpack.upgrade_level
       WHERE backpack.owner_player_id=$1 AND backpack.location IN ('inventory','equipped')
       ORDER BY backpack.instance_id
       FOR UPDATE OF backpack`,
      [playerId]
    );
    const chosen = chooseDeathDropBackpack(backpackRows.rows.map((row) => ({
      instanceId: row.instance_id,
      upgradeLevel: Number(row.upgrade_level),
      location: row.location,
      equippedSlot: row.equipped_slot === null ? null : Number(row.equipped_slot),
      capacityBonusGrams: BigInt(row.capacity_bonus_grams)
    })));
    if (!chosen) return await skipped("no_backpack");

    const weight = (await client.query<{ current: string; maximum: string }>(
      `SELECT player_inventory_weight_grams($1)::text AS current,
              player_inventory_maximum_grams($1)::text AS maximum`,
      [playerId]
    )).rows[0]!;
    const protection = await materialProtectionAllocation(client, playerId);
    const stackRows = await client.query<{
      entry_id: string; resource_type: string; variant: string; quantity: string; unit_weight_grams: string;
    }>(
      `SELECT inventory.entry_id::text,inventory.resource_type,inventory.variant,inventory.quantity::text,
              definition.unit_weight_grams::text
       FROM player_inventory inventory
       JOIN item_definitions definition ON definition.item_id=inventory.resource_type
       WHERE inventory.player_id=$1 AND inventory.quantity>0`,
      [playerId]
    );
    const equipmentRows = await client.query<{
      instance_id: string; definition_id: EquipmentDefinitionId; unit_weight_grams: string; blocked: boolean;
    }>(
      `SELECT equipment.instance_id::text,equipment.definition_id,definition.unit_weight_grams::text,
              (equipment.ring_rough OR EXISTS (
                 SELECT 1 FROM player_unique_item_protections protection
                 WHERE protection.player_id=$1 AND protection.equipment_instance_id=equipment.instance_id
                   AND protection.protected
               ) OR EXISTS (
                 SELECT 1 FROM combat_kit_items kit
                 WHERE kit.player_id=$1 AND kit.instance_id=equipment.instance_id
               ) OR EXISTS (
                 SELECT 1 FROM equipment_operations operation
                 WHERE operation.player_id=$1 AND operation.instance_id=equipment.instance_id
                   AND operation.completed_at IS NULL
               )) AS blocked
       FROM equipment_instances equipment
       JOIN item_definitions definition ON definition.item_id=equipment.definition_id
       WHERE equipment.owner_player_id=$1 AND equipment.location='inventory'
       ORDER BY equipment.instance_id
       FOR UPDATE OF equipment`,
      [playerId]
    );
    const plan = planDeathDropOverflow({
      random: input.random ?? Math.random,
      carriedWeightGrams: BigInt(weight.current),
      maximumWeightGramsAfter: BigInt(weight.maximum) - chosen.capacityBonusGrams,
      stacks: stackRows.rows.map((row) => {
        const quantity = Number(row.quantity);
        return {
          itemId: row.resource_type,
          variant: protocolVariant(row.variant),
          quantity,
          droppableQuantity: isDroppableItem(row.resource_type)
            ? protection.byStackId.get(row.entry_id)?.movableQuantity ?? quantity
            : 0,
          unitWeightGrams: Number(row.unit_weight_grams)
        };
      }),
      equipment: equipmentRows.rows.map((row) => ({
        instanceId: row.instance_id,
        itemId: row.definition_id,
        unitWeightGrams: Number(row.unit_weight_grams),
        droppable: !row.blocked && isKnownEquipment(row.definition_id)
      }))
    });
    if (!plan.fits) return await skipped("cannot_fit");

    const createdAt = input.now ?? new Date();
    const zoneId = zoneIdForRegion(regionCode);
    // The pile reads in plan order: the backpack first, then each overflow
    // entry in the shuffled order it was chosen.
    let placement: GroundPlacement = {
      regionCode, zoneId, pileId: `death:${key}`, pileOrder: 0, position, createdAt
    };
    const stackEntries = plan.entries.flatMap((entry, planIndex) =>
      entry.kind === "stack" ? [{ ...entry, planIndex }] : []);
    if (stackEntries.length > 0) {
      await inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `death-drop:${key}:items`,
        playerId,
        source: "death_backpack_drop",
        sourceEntityType: "player_death",
        sourceEntityId: key,
        metadata: { backpackInstanceId: chosen.instanceId },
        debits: stackEntries.map((stack) => ({
          itemId: stack.itemId as InventoryItemType, variant: stack.variant, quantity: stack.quantity
        }))
      });
      const itemDrops = await createSystemGroundDropsInTransaction(client, {
        operationKey: `death-drop:${key}`,
        droppedByPlayerId: playerId,
        regionCode,
        zoneId,
        pileId: `death:${key}`,
        sourceEntityType: "player_death",
        sourceEntityId: key,
        position,
        reason: "death_drop",
        now: createdAt,
        lines: stackEntries.map((stack) => ({
          itemId: stack.itemId, variant: stack.variant, quantity: stack.quantity, pileOrder: 1 + stack.planIndex
        }))
      });
      const first = itemDrops[0]!;
      placement = {
        ...placement,
        pileId: first.pileId ?? placement.pileId,
        position: { lat: first.lat, lon: first.lon },
        // A merge into a nearby pile shifts every order by that pile's next free slot.
        pileOrder: Math.max(0, (first.pileOrder ?? 0) - (1 + stackEntries[0]!.planIndex))
      };
    }
    const backpackDrop = await dropBackpackToGroundInTransaction(client, {
      operationKey: `death-drop:${key}:backpack`,
      requestId: key,
      playerId,
      instanceId: chosen.instanceId,
      placement
    });
    const lines: DeathDropSummaryLine[] = [
      { kind: "backpack", itemId: backpackDrop.itemId, name: `Backpack +${chosen.upgradeLevel}`, quantity: 1 }
    ];
    for (const [planIndex, entry] of plan.entries.entries()) {
      if (entry.kind === "stack") {
        lines.push({ kind: "item", itemId: entry.itemId, name: requireItemDefinition(entry.itemId).displayName, quantity: entry.quantity });
        continue;
      }
      await dropEquipmentToGroundInTransaction(client, {
        operationKey: `death-drop:${key}:equipment:${entry.instanceId}`,
        playerId,
        instanceId: entry.instanceId,
        itemId: entry.itemId as EquipmentDefinitionId,
        placement: { ...placement, pileOrder: placement.pileOrder + 1 + planIndex }
      });
      lines.push({
        kind: "equipment", itemId: entry.itemId,
        name: requireEquipmentDefinition(entry.itemId).displayName, quantity: 1
      });
    }
    const summary: DeathDropSummary = { outcome: "dropped", lines };
    await record("dropped", { summary, position: placement.position }, {
      instanceId: chosen.instanceId,
      dropId: backpackDrop.dropId
    });
    const snapshot = await inventory.snapshotInTransaction(client, playerId);
    await client.query("COMMIT");
    return {
      applied: true,
      summary,
      position: placement.position,
      inventory: snapshot,
      equipmentDropped: plan.equipmentInstanceIds.length > 0
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs the death drop and tells everyone who needs to know: the victim gets
 * fresh inventory, backpack and (when gear dropped) equipment snapshots, and
 * nearby players see the new ground pile. Never throws: a failure is logged
 * and must not block the XP penalty or the respawn.
 */
export async function applyAndPublishDeathBackpackDrop(
  deps: Readonly<{
    pool: pg.Pool;
    inventory: DeathDropInventory;
    backpacks: Pick<BackpackService, "getSnapshot">;
    equipment: Pick<EquipmentService, "refreshInventorySlots">;
    send(playerId: string, message: ServerMessage): unknown;
    publishGroundLoot(positions: readonly LatLon[]): Promise<void>;
    logger: Readonly<{ error(context: object, message: string): void; warn(context: object, message: string): void }>;
  }>,
  input: Readonly<{ operationKey: string; playerId: string; metadata?: Record<string, unknown> }>
): Promise<DeathDropSummary | null> {
  let result: DeathBackpackDropResult | null = null;
  // Equipment writers take the carry lock and player_equipment_state in both
  // orders, so a rare deadlock with a concurrent equipment change is possible;
  // PostgreSQL aborts one side and the whole drop rolls back, so one retry
  // is safe (the death key keeps it from applying twice).
  for (let attempt = 1; attempt <= 2 && !result; attempt += 1) {
    try {
      result = await applyDeathBackpackDrop(deps.pool, deps.inventory, {
        deathOperationKey: input.operationKey,
        victimPlayerId: input.playerId,
        ...(input.metadata ? { metadata: input.metadata } : {})
      });
    } catch (error: unknown) {
      const retryable = (error as { code?: unknown } | null)?.code === "40P01";
      if (retryable && attempt === 1) continue;
      deps.logger.error({ err: error, playerId: input.playerId, operationKey: input.operationKey }, "failed to apply death backpack drop");
      return null;
    }
  }
  if (!result) return null;
  if (result.applied && result.summary.outcome === "dropped") {
    try {
      if (result.inventory) {
        deps.send(input.playerId, {
          type: "INVENTORY_STACK_UPDATED",
          requestId: `death-drop:${input.operationKey}`,
          action: "reorganize",
          inventory: result.inventory,
          serverTime: Date.now(),
          message: "You died and dropped your lowest backpack."
        });
      }
      deps.send(input.playerId, { type: "BACKPACK_SNAPSHOT", backpacks: await deps.backpacks.getSnapshot(input.playerId) });
      if (result.equipmentDropped) {
        deps.send(input.playerId, { type: "EQUIPMENT_SNAPSHOT", equipment: await deps.equipment.refreshInventorySlots(input.playerId) });
      }
      if (result.position) await deps.publishGroundLoot([result.position]);
    } catch (error: unknown) {
      deps.logger.warn({ err: error, playerId: input.playerId, operationKey: input.operationKey }, "failed to publish death backpack drop");
    }
  }
  return result.summary;
}

function isDroppableItem(itemId: string): boolean {
  try {
    return requireItemDefinition(itemId).droppable;
  } catch {
    return false;
  }
}

function isKnownEquipment(definitionId: string): boolean {
  try {
    requireEquipmentDefinition(definitionId);
    return true;
  } catch {
    return false;
  }
}

function protocolVariant(variant: string): string | null {
  return variant === DEFAULT_INVENTORY_VARIANT ? null : variant;
}
