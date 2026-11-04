import { UTILITY_GEAR, isUtilityGearDefinitionId, coinwrightBonusGold, type UtilityGearDefinitionId } from "@ash-atlas/shared";
import type { EquipmentSnapshotV2, PlayerInventorySnapshot } from "@ash-atlas/shared";
import type pg from "pg";

type Queryable = Pick<pg.PoolClient, "query">;

/** The utility item worn in the gloves slot of an equipment snapshot (null when none). */
export function wornUtilityGlove(
  snapshot: Readonly<{ active: Readonly<{ gloves?: Readonly<{ definitionId: string }> | null }> }> | null | undefined
): UtilityGearDefinitionId | null {
  const id = snapshot?.active.gloves?.definitionId;
  return id && isUtilityGearDefinitionId(id) ? id : null;
}

/** City House footprint slack so standing at the door counts as home. */
const CITY_HOUSE_MARGIN_M = 5;

/**
 * Whether the player is at home: inside a Manor (House or Manor House) they own, or standing on
 * their own active City House. Read on the same connection as the change it guards.
 */
export async function playerIsAtHome(queryable: Queryable, playerId: string): Promise<boolean> {
  const result = await queryable.query<{ home: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM players player
           JOIN player_manors manor ON manor.id::text = player.location_id
          WHERE player.id = $1 AND player.location_kind = 'interior'
            AND player.location_type = 'manor' AND manor.owner_player_id = $1
       )
       OR EXISTS (
         SELECT 1 FROM players player
           JOIN city_structures house ON house.owner_player_id = player.id
          WHERE player.id = $1 AND player.location_kind = 'world'
            AND house.state = 'active' AND house.structure_type IN ('city_house', 'mayor_house')
            AND 2 * 6371000 * asin(sqrt(
                  power(sin(radians(house.lat - player.lat) / 2), 2) +
                  cos(radians(player.lat)) * cos(radians(house.lat)) *
                  power(sin(radians(house.lon - player.lon) / 2), 2)
                )) <= house.footprint_radius_m + ${CITY_HOUSE_MARGIN_M}
       )
     ) AS home`,
    [playerId]
  );
  return result.rows[0]?.home === true;
}

/**
 * Whether `definitionId` is worn in its slot with at least one use left, read from the database.
 * Decides a 1-second action at its start; the use itself is spent when the action completes.
 */
export async function wornUtilityGearReady(
  queryable: Queryable,
  playerId: string,
  definitionId: UtilityGearDefinitionId | null
): Promise<boolean> {
  if (!definitionId) return false;
  const result = await queryable.query(
    `SELECT 1 FROM equipment_instances
      WHERE owner_player_id = $1 AND location = 'equipped' AND equipped_slot = $2
        AND definition_id = $3 AND uses_remaining > 0
      LIMIT 1`,
    [playerId, UTILITY_GEAR[definitionId].slot, definitionId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Said when a glove action finishes but the glove was taken off or used up meanwhile; nothing is granted. */
export const UTILITY_GEAR_GONE_MESSAGE = "Your glove was used up or taken off before the action finished";

export type UtilityGearSpend = Readonly<{
  definitionId: UtilityGearDefinitionId;
  remaining: number;
  destroyed: boolean;
  /** Instance equipped in its place when the worn one ran out and another of the same item is carried. */
  replacementInstanceId: string | null;
}>;

/**
 * Spends one use of the utility item worn in its slot. One atomic statement takes the use; at 0 the
 * instance is destroyed and, when the player carries another of the same item, that one is
 * equipped automatically. Returns null (nothing changed) when the worn item is not that utility
 * item or has no uses left. Runs on the caller's connection so it commits with the action.
 */
export async function spendUtilityGearUseInTransaction(
  client: Queryable,
  playerId: string,
  definitionId: UtilityGearDefinitionId,
  /** Uses taken in one statement (pooled gear). The last uses are spent in full, never stranded. */
  count = 1
): Promise<UtilityGearSpend | null> {
  const spec = UTILITY_GEAR[definitionId];
  const spent = await client.query<{ instance_id: string; uses_remaining: number }>(
    `UPDATE equipment_instances
        SET uses_remaining = GREATEST(uses_remaining - $4::int, 0), updated_at = now()
      WHERE owner_player_id = $1 AND location = 'equipped' AND equipped_slot = $2
        AND definition_id = $3 AND uses_remaining > 0
      RETURNING instance_id::text, uses_remaining`,
    [playerId, spec.slot, definitionId, count]
  );
  const row = spent.rows[0];
  if (!row) return null;
  const remaining = Number(row.uses_remaining);
  if (remaining > 0) return { definitionId, remaining, destroyed: false, replacementInstanceId: null };
  await client.query(
    `UPDATE equipment_instances
        SET location = 'destroyed', equipped_slot = NULL, inventory_slot_index = NULL,
            manor_id = NULL, manor_slot_index = NULL, updated_at = now()
      WHERE instance_id = $1::uuid`,
    [row.instance_id]
  );
  const next = await client.query<{ instance_id: string }>(
    `UPDATE equipment_instances
        SET location = 'equipped', equipped_slot = $2, inventory_slot_index = NULL, updated_at = now()
      WHERE instance_id = (
        SELECT instance_id FROM equipment_instances
         WHERE owner_player_id = $1 AND location = 'inventory' AND definition_id = $3
           AND uses_remaining > 0
         ORDER BY uses_remaining, created_at, instance_id
         LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING instance_id::text`,
    [playerId, spec.slot, definitionId]
  );
  await client.query(
    `UPDATE player_equipment_state
        SET inventory_revision = inventory_revision + 1,
            active_revision = active_revision + 1,
            checkpoint_revision = checkpoint_revision + 1,
            active_kit_index = NULL
      WHERE player_id = $1`,
    [playerId]
  );
  return {
    definitionId,
    remaining: 0,
    destroyed: true,
    replacementInstanceId: next.rows[0]?.instance_id ?? null
  };
}

/**
 * The Coinwright Glove's part of a dump: one dump action costs one use (1% wear) however many items it
 * covers, and each item gains its own rounded-down 20%. Returns no bonus when no glove is worn.
 * Runs on the dump's own connection so the use, the item and the gold commit together.
 */
export async function coinwrightDumpBonusInTransaction(
  client: Queryable,
  playerId: string,
  items: readonly Readonly<{ unitGold: bigint; count: number }>[]
): Promise<Readonly<{ bonusGold: bigint; spent: UtilityGearSpend | null }>> {
  const spent = await spendUtilityGearUseInTransaction(client, playerId, "coinwright_glove");
  if (!spent) return { bonusGold: 0n, spent: null };
  let bonusGold = 0n;
  for (const item of items) {
    bonusGold += BigInt(coinwrightBonusGold(Number(item.unitGold))) * BigInt(item.count);
  }
  return { bonusGold, spent };
}

/** Called by the harvest and crafting services after a use committed, to refresh the runtime and the client. */
export type UtilityGearHooks = Readonly<{
  afterUse(playerId: string): Promise<void>;
}>;

export type UtilityGearCraftResult = Readonly<{
  replayed: boolean;
  definitionId: UtilityGearDefinitionId;
  instanceId: string;
  inventory: PlayerInventorySnapshot;
  equipment: EquipmentSnapshotV2;
  walletGold?: string;
  walletVersion?: string;
}>;
