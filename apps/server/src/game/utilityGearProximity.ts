import { EQUIPMENT_DEFINITIONS, EQUIPMENT_MAX_CONDITION, SAPLING_INTERACT_RANGE_M, type EquipmentDefinitionId } from "@ash-atlas/shared";
import type pg from "pg";

import { DROPPED_ITEM_PICKUP_RADIUS_M, DroppedItemError, assertDropLocationAndRange } from "./droppedItems.js";
import { goblinMarketEquipmentOfferGold } from "./goblinMarketPricing.js";
import { coinwrightDumpBonusInTransaction, spendUtilityGearUseInTransaction, type UtilityGearHooks } from "./utilityGear.js";
import { zoneIdForRegion, type PlayerRecord } from "./state.js";
import type { WalletService } from "./wallet.js";
import type { GivingSaplingService } from "./givingSaplings.js";

/** Most items one boot dumps per player per tick (the next tick takes the rest). */
const MAGNETIC_ITEMS_PER_TICK = 4;

export type LodestoneDumpEvent = Readonly<{
  playerId: string;
  dumped: number;
  gold: bigint;
  walletGold: string;
  walletVersion: string;
  lat: number;
  lon: number;
  /** Where each dumped drop lay, so nearby clients can drop it from the map. */
  positions: readonly Readonly<{ lat: number; lon: number }>[];
}>;

export type UtilityGearProximityDependencies = Readonly<{
  pool: pg.Pool;
  wallet: Pick<WalletService, "creditForOperationInTransaction">;
  hooks: UtilityGearHooks;
  /** Players currently standing in the open world. */
  onlineWorldPlayers(): readonly PlayerRecord[];
  onLodestoneDump?(event: LodestoneDumpEvent): void;
  /** Tiller Boot auto-tend. */
  saplings?: Pick<GivingSaplingService, "listNear" | "autoTend">;
  groveLoreRank?(playerId: string): Promise<number>;
  logger?: Readonly<{ warn(object: unknown, message?: string): void }>;
}>;

type DropRow = {
  id: string;
  equipment_instance_id: string;
  item_id: EquipmentDefinitionId;
  region_code: string;
  zone_id: string;
  lat: number;
  lon: number;
  manor_id: string | null;
  space_id: null;
  local_x: null;
  local_y: null;
  dropped_by: string;
};

/**
 * Utility boots that act on the world around the wearer. The Lodestone Boot dumps plain +0
 * weapons and armor lying within pickup reach: one transaction per item removes the ground
 * item, spends a use and credits the NPC dump gold, so two ticks can never both claim one item.
 */
export class UtilityGearProximityService {
  private running = false;
  /** Saplings that are not the wearer's, so the tick does not retry them (id -> expiry ms). */
  private readonly notOwn = new Map<string, number>();

  constructor(private readonly deps: UtilityGearProximityDependencies) {}

  /** One pass over every online player wearing a Lodestone Boot. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const wearers = await this.deps.pool.query<{ owner_player_id: string; definition_id: string }>(
        `SELECT owner_player_id, definition_id FROM equipment_instances
          WHERE definition_id IN ('lodestone_boot', 'tiller_boot') AND location = 'equipped' AND uses_remaining > 0`
      );
      if (wearers.rows.length === 0) return 0;
      const worn = new Map(wearers.rows.map((row) => [row.owner_player_id, row.definition_id]));
      let total = 0;
      for (const player of this.deps.onlineWorldPlayers()) {
        const boot = worn.get(player.playerId);
        if (!boot) continue;
        try {
          total += boot === "lodestone_boot" ? await this.lodestoneSweep(player) : await this.tillerSweep(player);
        } catch (error) {
          this.deps.logger?.warn({ err: error, playerId: player.playerId, boot }, "utility boot sweep failed");
        }
      }
      return total;
    } finally {
      this.running = false;
    }
  }

  /** Tends the wearer's own saplings that are due, within tending range; one boot use each. */
  async tillerSweep(player: PlayerRecord): Promise<number> {
    const saplings = this.deps.saplings;
    if (!saplings) return 0;
    const now = Date.now();
    let tended = 0;
    for (const item of saplings.listNear(player.position, SAPLING_INTERACT_RANGE_M)) {
      if (item.state !== "sapling" || item.phase === "healthy") continue;
      const skipUntil = this.notOwn.get(`${player.playerId}:${item.id}`);
      if (skipUntil !== undefined && skipUntil > now) continue;
      const rank = await (this.deps.groveLoreRank?.(player.playerId) ?? Promise.resolve(0)).catch(() => 0);
      if (await saplings.autoTend({ playerId: player.playerId, saplingId: item.id, position: player.position, groveLoreRank: rank })) {
        tended += 1;
      } else {
        // Someone else's sapling, or not tendable right now: look again in a minute.
        this.notOwn.set(`${player.playerId}:${item.id}`, now + 60_000);
      }
    }
    if (this.notOwn.size > 5000) this.notOwn.clear();
    return tended;
  }

  /** Dumps the eligible ground items around one player; returns how many were dumped. */
  async lodestoneSweep(player: PlayerRecord): Promise<number> {
    if (player.regionCode.startsWith("interior:")) return 0;
    const zoneId = zoneIdForRegion(player.regionCode);
    const candidates = await this.deps.pool.query<{ id: string }>(
      `SELECT drop_row.id::text AS id
         FROM world_equipment_drops drop_row
         JOIN equipment_instances instance ON instance.instance_id = drop_row.equipment_instance_id
        WHERE drop_row.status = 'active' AND drop_row.manor_id IS NULL
          AND drop_row.region_code = $1 AND drop_row.expires_at > now()
          AND instance.location = 'world_drop' AND instance.item_level = 0
          AND instance.enchantment_identity IS NULL AND instance.uses_remaining IS NULL
          AND instance.ring_bonuses IS NULL AND NOT instance.ring_rough
          AND ST_DWithin(drop_row.geom::geography, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, $4)
        ORDER BY drop_row.created_at, drop_row.id
        LIMIT $5`,
      [player.regionCode, player.position.lat, player.position.lon, DROPPED_ITEM_PICKUP_RADIUS_M, MAGNETIC_ITEMS_PER_TICK]
    );
    let dumped = 0;
    let gold = 0n;
    const positions: { lat: number; lon: number }[] = [];
    let last: { walletGold: string; walletVersion: string; lat: number; lon: number } | null = null;
    for (const candidate of candidates.rows) {
      const result = await this.dumpOne(player, zoneId, candidate.id);
      if (result === "boot_gone") break;
      if (result === "skipped") continue;
      dumped += 1;
      gold += result.gold;
      last = result;
      positions.push({ lat: result.lat, lon: result.lon });
    }
    if (dumped > 0 && last) {
      await this.deps.hooks.afterUse(player.playerId).catch(() => undefined);
      this.deps.onLodestoneDump?.({ playerId: player.playerId, dumped, gold, ...last, positions });
    }
    return dumped;
  }

  private async dumpOne(
    player: PlayerRecord,
    zoneId: string,
    dropId: string
  ): Promise<"skipped" | "boot_gone" | Readonly<{ gold: bigint; walletGold: string; walletVersion: string; lat: number; lon: number }>> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      // SKIP LOCKED: a pickup or another sweep already holding the item wins; this one moves on.
      const locked = await client.query<DropRow>(
        `SELECT id::text, equipment_instance_id::text, item_id, region_code, zone_id, lat, lon,
                manor_id::text, space_id, local_x, local_y, dropped_by
           FROM world_equipment_drops
          WHERE id = $1 AND status = 'active' AND manor_id IS NULL AND expires_at > now()
          FOR UPDATE SKIP LOCKED`,
        [dropId]
      );
      const row = locked.rows[0];
      if (!row) { await client.query("ROLLBACK"); return "skipped"; }
      const instance = await client.query<{
        definition_id: EquipmentDefinitionId; condition: number; account_id: string | null;
      }>(
        `SELECT instance.definition_id, instance.condition,
                (SELECT account_id FROM players WHERE id = $2) AS account_id
           FROM equipment_instances instance
          WHERE instance.instance_id = $1 AND instance.location = 'world_drop'
            AND instance.item_level = 0 AND instance.enchantment_identity IS NULL
            AND instance.uses_remaining IS NULL AND instance.ring_bonuses IS NULL AND NOT instance.ring_rough
          FOR UPDATE OF instance`,
        [row.equipment_instance_id, player.playerId]
      );
      const item = instance.rows[0];
      const definition = item ? EQUIPMENT_DEFINITIONS[item.definition_id] : undefined;
      if (!item || !definition || !item.account_id || !isDumpableCategory(definition.category) ||
        (definition.category === "chest_armor" && item.condition < EQUIPMENT_MAX_CONDITION)) {
        await client.query("ROLLBACK");
        return "skipped";
      }
      try {
        assertDropLocationAndRange({ ...player, zoneId }, row);
      } catch (error) {
        if (error instanceof DroppedItemError) { await client.query("ROLLBACK"); return "skipped"; }
        throw error;
      }
      const spent = await spendUtilityGearUseInTransaction(client, player.playerId, "lodestone_boot");
      if (!spent) { await client.query("ROLLBACK"); return "boot_gone"; }
      const baseGold = BigInt(goblinMarketEquipmentOfferGold({
        definitionId: item.definition_id, itemLevel: 0, enchantmentIdentity: null
      }));
      // Each auto-dumped item is its own dump action for a worn Coinwright Glove.
      const coinwright = await coinwrightDumpBonusInTransaction(client, player.playerId, [{ unitGold: baseGold, count: 1 }]);
      const amount = baseGold + coinwright.bonusGold;
      const operationKey = `lodestone-dump:${row.id}`;
      await client.query(
        `INSERT INTO equipment_operations (operation_key, player_id, action, instance_id, result, completed_at)
         VALUES ($1, $2, 'ground_pickup', $3, $4::jsonb, now())`,
        [operationKey, player.playerId, row.equipment_instance_id, JSON.stringify({ dropId: row.id, lodestone: true })]
      );
      const destroyed = await client.query(
        `UPDATE equipment_instances SET location = 'destroyed', updated_at = now()
          WHERE instance_id = $1 AND location = 'world_drop'`,
        [row.equipment_instance_id]
      );
      const closed = await client.query(
        `UPDATE world_equipment_drops
            SET status = 'picked_up', pickup_operation_key = $2, picked_up_by = $3, picked_up_at = now()
          WHERE id = $1 AND status = 'active'`,
        [row.id, operationKey, player.playerId]
      );
      if (destroyed.rowCount !== 1 || closed.rowCount !== 1) throw new Error("Lodestone dump lost custody of the ground item");
      const wallet = await this.deps.wallet.creditForOperationInTransaction(client, {
        playerId: player.playerId,
        accountId: item.account_id,
        amount,
        operationKey,
        reason: "lodestone_boot_dump",
        metadata: { dropId: row.id, definitionId: item.definition_id }
      });
      await client.query("COMMIT");
      return {
        gold: amount,
        walletGold: wallet.goldBalance.toString(),
        walletVersion: wallet.version.toString(),
        lat: Number(row.lat),
        lon: Number(row.lon)
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Weapons and armor only: rings, shields and utility gear are never taken. */
function isDumpableCategory(category: string): boolean {
  return category === "melee_weapon" || category === "ranged_weapon" || category === "head_armor" ||
    category === "chest_armor" || category === "gloves" || category === "boots";
}

