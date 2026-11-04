import { randomUUID } from "node:crypto";

import {
  HOLLIN_ANGER_MS,
  HOLLIN_FARMER_COUNT,
  HOLLIN_FARMER_RING_RADIUS_M,
  HOLLIN_HUT_REPAIR_DELAY_MS,
  HOLLIN_HUT_EXCLUSION_RADIUS_M,
  HOLLIN_HUT_REPAIR_FRACTION_PER_SECOND,
  HOLLIN_HUT_RESPAWN_MS,
  HOLLIN_ELDER_HEAL_FRACTION_PER_SECOND,
  HOLLIN_GRUDGE_MS,
  HOLLIN_HIT_TRADE_BAN_MS,
  HOLLIN_INITIAL_GUARDS,
  HOLLIN_INTERACTION_RADIUS_M,
  HOLLIN_MAX_DEFENDERS,
  HOLLIN_RAID_WAVE_HEALTH,
  HOLLIN_SIGHT_RANGE_M,
  HOLLIN_ORCHARD_PLANT_KEY,
  HOLLIN_ORCHARD_RADIUS_M,
  HOLLIN_ORCHARD_REGROW_MS,
  HOLLIN_ORCHARD_TRADE_BAN_MS,
  HOLLIN_ORCHARD_TREE_COUNT,
  HOLLIN_ORCHARD_YIELD_ITEM,
  HOLLIN_ORCHARD_YIELD_QUANTITY,
  HOLLIN_RAID_TRADE_BAN_MS,
  HOLLIN_HEAL_COST_GOLD,
  HOLLIN_LORE_EGG_COST,
  HOLLIN_LORE_EGG_ITEM,
  HOLLIN_RAID_LOOT_MIN_DAMAGE,
  INVENTORY_CATALOG,
  destinationPoint,
  distanceMeters,
  hollinDiscountedUnitPrice,
  hollinHutEntityId,
  hollinHutIdFromEntityId,
  hollinHutLifetimeMs,
  hollinShopDiscountPercent,
  hollinStockEpoch,
  hollinStockForHut,
  hollinStockRefreshesAtMs,
  hollinWaveComposition,
  rollHollinRaidLoot,
  type HollinBanReason,
  type HollinDefenderKind,
  type HollinHutShopSnapshot,
  type LatLon,
  type PlayerInventorySnapshot,
  type ResourceType,
  type WorldZoneBiome
} from "@ash-atlas/shared";
import type pg from "pg";

import type { CombatEngine } from "./combat/combatEngine.js";
import type { DungeonSkillTurnInResult } from "./dungeonSkills.js";
import type { InventoryService } from "./inventory.js";
import { populationZoneV2IdForPoint } from "./populationZonesV2Geometry.js";
import { packageIdForPosition, zoneIdForPosition } from "./spatialZones.js";
import type { WalletService } from "./wallet.js";

export class HollinHutError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HollinHutError";
  }
}

export type HollinHutRecord = Readonly<{
  hutId: string;
  /** Null for huts Population V2 placed (and for developer huts whose creator was deleted). */
  creatorPlayerId: string | null;
  /**
   * "population": the hut body is the Population V2 entity `populationEntityId` (life 0) and the hut
   * id derives from it. "developer": a developer-tool spawn whose body this service owns.
   */
  source: "developer" | "population";
  populationEntityId: string | null;
  requestId: string;
  regionCode: string;
  zoneId: string;
  position: LatLon;
  state: "standing" | "destroyed";
  /** Incremented every respawn; part of the combat entity id so a new body never collides with the old one. */
  life: number;
  respawnAt: Date | null;
  /** When a population hut despawns for good (6-8 days after adoption); null for developer huts, which never expire. */
  expiresAt: Date | null;
}>;

export type HollinHutInput = Readonly<{
  creatorPlayerId: string;
  requestId: string;
  regionCode: string;
  zoneId: string;
  position: LatLon;
}>;

/** One player's standing with one hut. Bans are per player: they never affect other players. */
export type HollinStanding = Readonly<{
  tradeBannedUntil: Date | null;
  banReason: HollinBanReason | null;
  angryUntil: Date | null;
  /** Set when this player broke a hut: every Hollin attacks them on sight until then. */
  grudgeUntil: Date | null;
}>;
export const NO_STANDING: HollinStanding = Object.freeze({ tradeBannedUntil: null, banReason: null, angryUntil: null, grudgeUntil: null });

export interface HollinHutStore {
  insertHut(input: HollinHutInput, hutId: string): Promise<HollinHutRecord>;
  /**
   * Idempotent: a Population V2 hut body becomes (or already is) a hut row keyed by its entity id.
   * Returns null, inserting nothing, when another unexpired hut stands within
   * HOLLIN_HUT_EXCLUSION_RADIUS_M. The check and the insert are atomic across concurrent adoptions.
   */
  adoptPopulationHut(input: Readonly<{
    populationEntityId: string; regionCode: string; zoneId: string; position: LatLon; expiresAt: Date;
  }>, now: Date): Promise<HollinHutRecord | null>;
  /**
   * Standing population huts whose body Population V2 still owns (life 0) although their slot no
   * longer exists (the generation was cleaned up): they need a service-owned body.
   */
  listOrphanedPopulationHuts(): Promise<HollinHutRecord[]>;
  /** Hands a standing life-0 population hut's body to the service (life + 1); null when that no longer applies. */
  detachPopulationBody(hutId: string): Promise<HollinHutRecord | null>;
  /** True when Giving Trees grow at the point: its Population V2 zone has tree habitat. */
  hasGivingTrees(position: LatLon): Promise<boolean>;
  /** Removes a hut row, its standings and its orchard trees. */
  deleteHut(hutId: string): Promise<void>;
  /** True when the point lies inside a claimed flag or city territory. */
  isInsideClaimedTerritory(position: LatLon): Promise<boolean>;
  listHuts(): Promise<HollinHutRecord[]>;
  getHut(hutId: string): Promise<HollinHutRecord | null>;
  markDestroyed(hutId: string, respawnAt: Date): Promise<void>;
  respawn(hutId: string): Promise<HollinHutRecord | null>;
  getStanding(hutId: string, playerId: string): Promise<HollinStanding>;
  setStanding(hutId: string, playerId: string, standing: HollinStanding): Promise<void>;
  /** Latest active grudge across every hut, or null. One indexed lookup per player. */
  getGrudgeUntil(playerId: string): Promise<Date | null>;
  /** Berry pacify: forgives the player everywhere. */
  clearGrudge(playerId: string): Promise<void>;
  ensureOrchardTrees(hut: HollinHutRecord, trees: readonly Readonly<{ entityId: string; position: LatLon }>[]): Promise<void>;
  /** Makes trees harvested at or before the cutoff harvestable again; returns how many regrew. */
  regrowOrchardTrees(harvestedBefore: Date): Promise<number>;
  clearAll(): Promise<number>;
}

type HutRow = {
  hut_id: string; creator_player_id: string | null; request_id: string; region_code: string;
  zone_id: string; lat: number | string; lon: number | string; state: string; life: number | string;
  respawn_at: Date | string | null; source: string; population_entity_id: string | null;
  expires_at: Date | string | null;
};
const HUT_COLUMNS = "hut_id,creator_player_id,request_id,region_code,zone_id,lat,lon,state,life,respawn_at,source,population_entity_id,expires_at";
/** Serializes hut adoption world-wide so two cells can never both pass the exclusion check. */
const ADOPTION_LOCK_KEY = "hollin_hut_adoption";

function rowToHut(row: HutRow): HollinHutRecord {
  return {
    hutId: row.hut_id,
    creatorPlayerId: row.creator_player_id,
    source: row.source === "population" ? "population" : "developer",
    populationEntityId: row.population_entity_id,
    requestId: row.request_id,
    regionCode: row.region_code,
    zoneId: row.zone_id,
    position: { lat: Number(row.lat), lon: Number(row.lon) },
    state: row.state === "destroyed" ? "destroyed" : "standing",
    life: Number(row.life),
    respawnAt: row.respawn_at === null ? null : new Date(row.respawn_at),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at)
  };
}

export class PostgresHollinHutStore implements HollinHutStore {
  constructor(private readonly pool: Pick<pg.Pool, "query" | "connect">) {}

  async insertHut(input: HollinHutInput, hutId: string): Promise<HollinHutRecord> {
    await this.pool.query(
      `INSERT INTO hollin_huts (hut_id,creator_player_id,request_id,region_code,zone_id,lat,lon)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [hutId, input.creatorPlayerId, input.requestId, input.regionCode, input.zoneId, input.position.lat, input.position.lon]
    );
    const result = await this.pool.query<HutRow>(
      `SELECT ${HUT_COLUMNS} FROM hollin_huts WHERE creator_player_id IS NOT DISTINCT FROM $1 AND request_id=$2`,
      [input.creatorPlayerId, input.requestId]
    );
    if (!result.rows[0]) throw new Error("Hollin Hut was not persisted");
    return rowToHut(result.rows[0]);
  }

  async adoptPopulationHut(input: Readonly<{
    populationEntityId: string; regionCode: string; zoneId: string; position: LatLon; expiresAt: Date;
  }>, now: Date): Promise<HollinHutRecord | null> {
    const hutId = `hollin-hut:${input.populationEntityId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Held to commit: a concurrent adoption waits here, then sees this one's row (READ COMMITTED
      // takes a fresh snapshot per statement), so the 30 km check and the insert never interleave.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ADOPTION_LOCK_KEY]);
      const existing = await client.query<HutRow>(`SELECT ${HUT_COLUMNS} FROM hollin_huts WHERE hut_id=$1`, [hutId]);
      let row = existing.rows[0];
      if (!row) {
        const blocked = await client.query(
          `SELECT 1 FROM hollin_huts
            WHERE (expires_at IS NULL OR expires_at > $3)
              AND ST_DWithin(ST_SetSRID(ST_MakePoint(lon,lat),4326)::geography,
                             ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $4)
            LIMIT 1`,
          [input.position.lon, input.position.lat, now, HOLLIN_HUT_EXCLUSION_RADIUS_M]
        );
        if ((blocked.rowCount ?? 0) === 0) {
          const inserted = await client.query<HutRow>(
            `INSERT INTO hollin_huts
               (hut_id,creator_player_id,request_id,region_code,zone_id,lat,lon,source,population_entity_id,expires_at)
             VALUES ($1,NULL,$2,$3,$4,$5,$6,'population',$7,$8)
             RETURNING ${HUT_COLUMNS}`,
            [hutId, `population:${input.populationEntityId}`, input.regionCode, input.zoneId,
              input.position.lat, input.position.lon, input.populationEntityId, input.expiresAt]
          );
          row = inserted.rows[0];
        }
      }
      await client.query("COMMIT");
      return row ? rowToHut(row) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listOrphanedPopulationHuts(): Promise<HollinHutRecord[]> {
    const result = await this.pool.query<HutRow>(
      `SELECT ${HUT_COLUMNS} FROM hollin_huts hut
        WHERE hut.source='population' AND hut.life=0 AND hut.state='standing'
          AND NOT EXISTS (SELECT 1 FROM population_spawn_slots_v2 slot WHERE slot.entity_id=hut.population_entity_id)`
    );
    return result.rows.map(rowToHut);
  }

  async detachPopulationBody(hutId: string): Promise<HollinHutRecord | null> {
    const result = await this.pool.query<HutRow>(
      `UPDATE hollin_huts SET life=life+1
        WHERE hut_id=$1 AND source='population' AND life=0 AND state='standing'
        RETURNING ${HUT_COLUMNS}`,
      [hutId]
    );
    return result.rows[0] ? rowToHut(result.rows[0]) : null;
  }

  async hasGivingTrees(position: LatLon): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM population_zones_v2 WHERE zone_id=$1 AND tree_km2 > 0 LIMIT 1",
      [populationZoneV2IdForPoint(position)]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteHut(hutId: string): Promise<void> {
    await this.pool.query("DELETE FROM developer_spawned_plants WHERE plant_key=$1 AND entity_id LIKE $2",
      [HOLLIN_ORCHARD_PLANT_KEY, `plant:dev:hollin-orchard:${hutId}:%`]);
    await this.pool.query("DELETE FROM hollin_huts WHERE hut_id=$1", [hutId]);
  }

  async isInsideClaimedTerritory(position: LatLon): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM flags flag
        WHERE ST_DWithin(flag.geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, flag.claim_radius_m + 25)
        LIMIT 1`,
      [position.lon, position.lat]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listHuts(): Promise<HollinHutRecord[]> {
    const result = await this.pool.query<HutRow>(`SELECT ${HUT_COLUMNS} FROM hollin_huts ORDER BY created_at,hut_id`);
    return result.rows.map(rowToHut);
  }

  async getHut(hutId: string): Promise<HollinHutRecord | null> {
    const result = await this.pool.query<HutRow>(`SELECT ${HUT_COLUMNS} FROM hollin_huts WHERE hut_id=$1`, [hutId]);
    return result.rows[0] ? rowToHut(result.rows[0]) : null;
  }

  async markDestroyed(hutId: string, respawnAt: Date): Promise<void> {
    await this.pool.query(
      "UPDATE hollin_huts SET state='destroyed',respawn_at=$2 WHERE hut_id=$1 AND state='standing'",
      [hutId, respawnAt]
    );
  }

  async respawn(hutId: string): Promise<HollinHutRecord | null> {
    const result = await this.pool.query<HutRow>(
      `UPDATE hollin_huts SET state='standing',respawn_at=NULL,life=life+1
        WHERE hut_id=$1 AND state='destroyed' RETURNING ${HUT_COLUMNS}`,
      [hutId]
    );
    return result.rows[0] ? rowToHut(result.rows[0]) : null;
  }

  async getStanding(hutId: string, playerId: string): Promise<HollinStanding> {
    const result = await this.pool.query<{
      trade_banned_until: Date | string | null; ban_reason: HollinBanReason | null; angry_until: Date | string | null;
      grudge_until: Date | string | null;
    }>(
      "SELECT trade_banned_until,ban_reason,angry_until,grudge_until FROM hollin_hut_player_standing WHERE hut_id=$1 AND player_id=$2",
      [hutId, playerId]
    );
    const row = result.rows[0];
    if (!row) return NO_STANDING;
    return {
      tradeBannedUntil: row.trade_banned_until === null ? null : new Date(row.trade_banned_until),
      banReason: row.ban_reason,
      angryUntil: row.angry_until === null ? null : new Date(row.angry_until),
      grudgeUntil: row.grudge_until === null ? null : new Date(row.grudge_until)
    };
  }

  async getGrudgeUntil(playerId: string): Promise<Date | null> {
    const result = await this.pool.query<{ until: Date | string | null }>(
      "SELECT max(grudge_until) AS until FROM hollin_hut_player_standing WHERE player_id=$1 AND grudge_until > now()",
      [playerId]
    );
    const until = result.rows[0]?.until;
    return until ? new Date(until) : null;
  }

  async clearGrudge(playerId: string): Promise<void> {
    await this.pool.query(
      "UPDATE hollin_hut_player_standing SET grudge_until=NULL,updated_at=now() WHERE player_id=$1 AND grudge_until IS NOT NULL",
      [playerId]
    );
  }

  async setStanding(hutId: string, playerId: string, standing: HollinStanding): Promise<void> {
    await this.pool.query(
      `INSERT INTO hollin_hut_player_standing (hut_id,player_id,trade_banned_until,ban_reason,angry_until,grudge_until,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (hut_id,player_id) DO UPDATE
         SET trade_banned_until=EXCLUDED.trade_banned_until,ban_reason=EXCLUDED.ban_reason,
             angry_until=EXCLUDED.angry_until,grudge_until=EXCLUDED.grudge_until,updated_at=now()`,
      [hutId, playerId, standing.tradeBannedUntil, standing.banReason, standing.angryUntil, standing.grudgeUntil]
    );
  }

  async ensureOrchardTrees(hut: HollinHutRecord, trees: readonly Readonly<{ entityId: string; position: LatLon }>[]): Promise<void> {
    for (const tree of trees) {
      await this.pool.query(
        `INSERT INTO developer_spawned_plants
           (entity_id,creator_player_id,request_id,plant_key,resource_type,quantity,region_code,zone_id,spawn_lat,spawn_lon)
         VALUES ($1,NULL,$1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (entity_id) DO NOTHING`,
        [tree.entityId, HOLLIN_ORCHARD_PLANT_KEY, HOLLIN_ORCHARD_YIELD_ITEM, HOLLIN_ORCHARD_YIELD_QUANTITY,
          hut.regionCode, hut.zoneId, tree.position.lat, tree.position.lon]
      );
    }
  }

  async regrowOrchardTrees(harvestedBefore: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE developer_spawned_plants
          SET state='available',state_revision=state_revision+1,harvested_at=NULL,harvested_by_player_id=NULL
        WHERE plant_key=$1 AND state='harvested' AND harvested_at <= $2`,
      [HOLLIN_ORCHARD_PLANT_KEY, harvestedBefore]
    );
    return result.rowCount ?? 0;
  }

  async clearAll(): Promise<number> {
    await this.pool.query("DELETE FROM developer_spawned_plants WHERE plant_key=$1", [HOLLIN_ORCHARD_PLANT_KEY]);
    const result = await this.pool.query("DELETE FROM hollin_huts");
    return result.rowCount ?? 0;
  }
}

/** Process-local store used by unit tests. */
export class InMemoryHollinHutStore implements HollinHutStore {
  readonly huts = new Map<string, HollinHutRecord>();
  readonly standings = new Map<string, HollinStanding>();

  async insertHut(input: HollinHutInput, hutId: string): Promise<HollinHutRecord> {
    const existing = [...this.huts.values()].find((hut) =>
      hut.creatorPlayerId === input.creatorPlayerId && hut.requestId === input.requestId);
    if (existing) return existing;
    const record: HollinHutRecord = {
      hutId, creatorPlayerId: input.creatorPlayerId, source: "developer", populationEntityId: null,
      requestId: input.requestId, regionCode: input.regionCode,
      zoneId: input.zoneId, position: input.position, state: "standing", life: 0, respawnAt: null, expiresAt: null
    };
    this.huts.set(hutId, record);
    return record;
  }
  /** Test hooks: Population V2 slots that were cleaned up, claimed territory, and tree habitat. */
  readonly orphanedPopulationEntities = new Set<string>();
  claimedTerritory: (position: LatLon) => boolean = () => false;
  givingTrees: (position: LatLon) => boolean = () => false;
  /** Synchronous between the existence check and the insert, so concurrent adoptions cannot both win. */
  async adoptPopulationHut(input: Readonly<{
    populationEntityId: string; regionCode: string; zoneId: string; position: LatLon; expiresAt: Date;
  }>, now: Date): Promise<HollinHutRecord | null> {
    const hutId = `hollin-hut:${input.populationEntityId}`;
    const existing = this.huts.get(hutId);
    if (existing) return existing;
    const blocked = [...this.huts.values()].some((hut) =>
      (hut.expiresAt === null || hut.expiresAt > now) && distanceMeters(hut.position, input.position) <= HOLLIN_HUT_EXCLUSION_RADIUS_M);
    if (blocked) return null;
    const record: HollinHutRecord = {
      hutId, creatorPlayerId: null, source: "population", populationEntityId: input.populationEntityId,
      requestId: `population:${input.populationEntityId}`, regionCode: input.regionCode, zoneId: input.zoneId,
      position: input.position, state: "standing", life: 0, respawnAt: null, expiresAt: input.expiresAt
    };
    this.huts.set(hutId, record);
    return record;
  }
  async listOrphanedPopulationHuts(): Promise<HollinHutRecord[]> {
    return [...this.huts.values()].filter((hut) =>
      hut.source === "population" && hut.life === 0 && hut.state === "standing"
      && hut.populationEntityId !== null && this.orphanedPopulationEntities.has(hut.populationEntityId));
  }
  async detachPopulationBody(hutId: string): Promise<HollinHutRecord | null> {
    const hut = this.huts.get(hutId);
    if (!hut || hut.source !== "population" || hut.life !== 0 || hut.state !== "standing") return null;
    const next: HollinHutRecord = { ...hut, life: 1 };
    this.huts.set(hutId, next);
    return next;
  }
  async hasGivingTrees(position: LatLon): Promise<boolean> { return this.givingTrees(position); }
  async deleteHut(hutId: string): Promise<void> {
    this.huts.delete(hutId);
    for (const key of [...this.standings.keys()]) if (key.startsWith(`${hutId}|`)) this.standings.delete(key);
    for (const key of [...this.orchardTrees.keys()]) if (key.includes(hutId)) this.orchardTrees.delete(key);
  }
  async isInsideClaimedTerritory(position: LatLon): Promise<boolean> { return this.claimedTerritory(position); }
  async listHuts(): Promise<HollinHutRecord[]> { return [...this.huts.values()]; }
  async getHut(hutId: string): Promise<HollinHutRecord | null> { return this.huts.get(hutId) ?? null; }
  async markDestroyed(hutId: string, respawnAt: Date): Promise<void> {
    const hut = this.huts.get(hutId);
    if (hut?.state === "standing") this.huts.set(hutId, { ...hut, state: "destroyed", respawnAt });
  }
  async respawn(hutId: string): Promise<HollinHutRecord | null> {
    const hut = this.huts.get(hutId);
    if (!hut || hut.state !== "destroyed") return null;
    const next: HollinHutRecord = { ...hut, state: "standing", respawnAt: null, life: hut.life + 1 };
    this.huts.set(hutId, next);
    return next;
  }
  async getStanding(hutId: string, playerId: string): Promise<HollinStanding> {
    return this.standings.get(`${hutId}|${playerId}`) ?? NO_STANDING;
  }
  async setStanding(hutId: string, playerId: string, standing: HollinStanding): Promise<void> {
    this.standings.set(`${hutId}|${playerId}`, standing);
  }
  now = (): number => Date.now();
  async getGrudgeUntil(playerId: string): Promise<Date | null> {
    let latest: Date | null = null;
    for (const [key, standing] of this.standings) {
      if (!key.endsWith(`|${playerId}`) || !standing.grudgeUntil || standing.grudgeUntil.getTime() <= this.now()) continue;
      if (!latest || standing.grudgeUntil > latest) latest = standing.grudgeUntil;
    }
    return latest;
  }
  async clearGrudge(playerId: string): Promise<void> {
    for (const [key, standing] of this.standings) {
      if (key.endsWith(`|${playerId}`) && standing.grudgeUntil) this.standings.set(key, { ...standing, grudgeUntil: null });
    }
  }
  readonly orchardTrees = new Map<string, { position: LatLon; harvestedAt: number | null }>();
  async ensureOrchardTrees(_hut: HollinHutRecord, trees: readonly Readonly<{ entityId: string; position: LatLon }>[]): Promise<void> {
    for (const tree of trees) if (!this.orchardTrees.has(tree.entityId)) this.orchardTrees.set(tree.entityId, { position: tree.position, harvestedAt: null });
  }
  async regrowOrchardTrees(harvestedBefore: Date): Promise<number> {
    let count = 0;
    for (const tree of this.orchardTrees.values()) {
      if (tree.harvestedAt !== null && tree.harvestedAt <= harvestedBefore.getTime()) { tree.harvestedAt = null; count += 1; }
    }
    return count;
  }
  async clearAll(): Promise<number> {
    const count = this.huts.size;
    this.huts.clear();
    this.standings.clear();
    return count;
  }
}

type HutCombat = Pick<CombatEngine, "spawnMob" | "despawnMob" | "entity" | "directMobTarget" | "healMob" | "healEntity" | "cancelCombat">
  & Partial<Pick<CombatEngine, "despawnPopulationManagedMob">>;
type HutRanks = Readonly<{
  ensureLoaded(playerId: string): Promise<void>;
  rankOf(playerId: string, skillId: "wildkin_lore"): number;
  /** Discovers Hollin Lore for Giant Eggs: the same authority the Eyrie egg nest uses. */
  turnIn?(playerId: string, skillId: "wildkin_lore", requestId: string): Promise<DungeonSkillTurnInResult>;
  hasDiscovered?(playerId: string, skillId: "wildkin_lore"): Promise<boolean>;
}>;
type HutWallet = Pick<WalletService, "snapshot" | "debitForOperationInTransaction">;
type HutInventory = Pick<InventoryService, "grantItemsForOperationInTransaction" | "debitItemsForOperationInTransaction" | "getInventorySnapshot">;

type Transaction = <T>(work: (client: pg.PoolClient) => Promise<T>) => Promise<T>;

export type HollinHutDeps = Readonly<{
  store: HollinHutStore;
  combat: HutCombat;
  wallet: HutWallet;
  inventory: HutInventory;
  ranks: HutRanks;
  transaction: Transaction;
  now?: () => number;
  /** Connected players in the world, for on-sight grudge checks. */
  onlinePlayers?: () => readonly Readonly<{ playerId: string; position: LatLon }>[];
  /** The biome at a point (the same lookup biome discovery uses); decides a population hut's ingredient stock. */
  biomeAt?: (position: LatLon) => Promise<WorldZoneBiome>;
  /** Called after a defeated hut's loot was granted to a contributor. */
  onRaidLoot?: (event: Readonly<{
    playerId: string;
    hutId: string;
    loot: readonly Readonly<{ itemId: string; quantity: number }>[];
    inventory: PlayerInventorySnapshot;
  }>) => void;
  logger?: Readonly<{ warn(context: object, message: string): void }>;
}>;

export type HollinServiceResult = Readonly<{
  service: "heal" | "turn_in_eggs";
  hutId: string;
  message: string;
  snapshot: HollinHutShopSnapshot;
  inventory?: PlayerInventorySnapshot;
  walletGold?: string;
  walletVersion?: string;
  /** Present after a discovery so the caller can refresh the skill tree. */
  skills?: Extract<DungeonSkillTurnInResult, { status: "discovered" }>["snapshot"];
}>;

export type HollinPlayer = Readonly<{ playerId: string; position: LatLon }>;

export type HollinPurchaseResult = Readonly<{
  replayed: boolean;
  itemId: string;
  quantity: number;
  totalGold: string;
  snapshot: HollinHutShopSnapshot;
  inventory: PlayerInventorySnapshot;
  walletGold: string;
  walletVersion: string;
}>;

export function poolTransaction(pool: pg.Pool): Transaction {
  return async (work) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
}

type HutRuntime = {
  lastAttackedAt: number;
  /** Raid waves already sent this attack (0 = first hit, 1..3 = the health thresholds). */
  wavesFired: Set<number>;
  /** Players already given the 12h hit-a-Hollin ban during this attack. */
  hitBanned: Set<string>;
  guardSeq: number;
  guards: Set<string>;
  /** Players the hut's defenders may attack, with the time that hostility lapses. */
  hostile: Map<string, number>;
  /** Damage each player has dealt to this hut body since the attack began (raid loot share). */
  damage: Map<string, number>;
};

const DEFENDER_ID = /^mob:hollin-(guard|brute|elder):(hollin-hut:[0-9a-f-]{36}):(\d+):(\d+)$/u;
const FARMER_ID = /^mob:hollin-farmer:(hollin-hut:[0-9a-f-]{36}):/u;
const HELPER_ID = /^mob:hollin-helper:/u;
const GRUDGE_SCAN_INTERVAL_MS = 2_000;
const GRUDGE_CACHE_MS = 20_000;
const ORPHAN_SWEEP_INTERVAL_MS = 60_000;
const ORCHARD_ID = /^plant:dev:hollin-orchard:(hollin-hut:[0-9a-f-]{36}):(\d+)$/u;

/**
 * The Population V2 `onRuntimeMobSpawned` hook for Hollin Huts: adopts the body the runtime just
 * spawned (or re-woke). Returns the adoption promise so tests can await it; callers may ignore it.
 */
export function hollinHutSpawnAdopter(
  service: Pick<HollinHutService, "onPopulationBodySpawned">,
  logger?: Readonly<{ warn(context: object, message: string): void }>
): (entity: Readonly<{ entityKind: string; entityId: string }>, position: LatLon) => Promise<void> {
  return async (entity, position) => {
    if (entity.entityKind !== "hollin_hut") return;
    try {
      await service.onPopulationBodySpawned({
        entityId: entity.entityId,
        regionCode: packageIdForPosition(position),
        zoneId: zoneIdForPosition(position),
        position
      });
    } catch (error) {
      logger?.warn({ err: error, entityId: entity.entityId }, "Hollin Hut adoption failed");
    }
  };
}

export function hollinOrchardTreeId(hutId: string, index: number): string {
  return `plant:dev:hollin-orchard:${hutId}:${index}`;
}

export class HollinHutService {
  protected readonly now: () => number;
  private readonly runtime = new Map<string, HutRuntime>();
  private lastTickAt: number;
  private lastRegrowAt = 0;
  private standingHuts: readonly HollinHutRecord[] = [];
  private lastGrudgeScanAt = 0;
  private scanningGrudges = false;
  private readonly grudgeCache = new Map<string, { until: number; checkedAt: number }>();
  private lastOrphanSweepAt = 0;
  /** Population V2 hut bodies currently known: combat entity id to hut id. */
  private readonly populationBodies = new Map<string, string>();
  /** Biome per population hut id, resolved lazily at shop time. */
  private readonly hutBiomes = new Map<string, WorldZoneBiome>();
  /** Whether Giving Trees grow at each hut (it sells berries), resolved lazily at shop time. */
  private readonly hutGivingTrees = new Map<string, boolean>();

  constructor(protected readonly deps: HollinHutDeps) {
    this.now = deps.now ?? Date.now;
    this.lastTickAt = this.now();
  }

  /** Spawns a developer hut (idempotent per creator and request id). Population V2 huts arrive through onPopulationBodySpawned. */
  async spawnHut(input: HollinHutInput): Promise<HollinHutRecord> {
    const record = await this.deps.store.insertHut(input, `hollin-hut:${randomUUID()}`);
    await this.project(record);
    return record;
  }

  /** Rebuilds every hut body after a restart. */
  async recover(): Promise<number> {
    const huts = await this.deps.store.listHuts();
    for (const hut of huts) {
      if (this.populationOwnsBody(hut)) this.populationBodies.set(hut.populationEntityId!, hut.hutId);
      await this.project(hut);
    }
    this.standingHuts = huts.filter((hut) => hut.state === "standing");
    return huts.length;
  }

  async clearAll(): Promise<number> {
    for (const hut of await this.deps.store.listHuts()) this.despawnBodies(hut);
    this.runtime.clear();
    return this.deps.store.clearAll();
  }

  ownsHutEntity(entityId: string): boolean {
    return this.hutIdOfBody(entityId) !== null;
  }

  /** Attack authority: null when the entity is not a Hollin body (callers fall through). */
  canPlayerAttack(_playerId: string, entityId: string): boolean | null {
    if (this.hutIdOfBody(entityId)) return true;
    if (DEFENDER_ID.test(entityId) || FARMER_ID.test(entityId)) return true;
    if (HELPER_ID.test(entityId)) return false;
    return null;
  }

  /**
   * Hollins (defenders and farmers) only fight players they are hostile to: per player, so a party
   * member who attacked nothing is never targeted. Huts and helpers never attack.
   */
  canMobAttack(entityId: string, playerId: string): boolean | null {
    const hutId = DEFENDER_ID.exec(entityId)?.[2] ?? FARMER_ID.exec(entityId)?.[1];
    if (hutId) {
      const until = this.runtime.get(hutId)?.hostile.get(playerId);
      return until !== undefined && until > this.now();
    }
    if (this.hutIdOfBody(entityId) || HELPER_ID.test(entityId)) return false;
    return null;
  }

  /** Combat hook: records raids. Wire to the engine's analytics callback. */
  onCombatEvent(event: Readonly<{
    kind: string; actorId: string; actorKind: string; targetId: string;
    damageApplied?: number | null; targetHealthAfter?: number | null;
  }>): void {
    if (event.kind !== "damage_applied" || event.actorKind !== "player") return;
    const hutId = this.hutIdOfBody(event.targetId);
    if (hutId) {
      this.recordRaid(hutId, event.actorId, event.damageApplied ?? 0, event.targetHealthAfter ?? null);
      return;
    }
    const hollinHutId = DEFENDER_ID.exec(event.targetId)?.[2] ?? FARMER_ID.exec(event.targetId)?.[1];
    if (hollinHutId) this.recordHollinHit(hollinHutId, event.actorId);
  }

  /** The hut mob was destroyed: schedule the respawn and stand the defenders down. */
  async onHutDefeated(entityId: string): Promise<void> {
    const hutId = this.hutIdOfBody(entityId);
    if (!hutId) return;
    const hut = await this.deps.store.getHut(hutId);
    if (!hut || hut.state !== "standing") return;
    // Loot first: it is idempotent per contributor, so a retried defeat never double-grants.
    await this.grantRaidLoot(hut);
    await this.banContributors(hut);
    await this.deps.store.markDestroyed(hutId, new Date(this.now() + HOLLIN_HUT_RESPAWN_MS));
    this.dismissGuards(hutId);
    this.runtime.delete(hutId);
    for (let index = 0; index < HOLLIN_FARMER_COUNT; index += 1) {
      this.deps.combat.despawnMob(`mob:hollin-farmer:${hut.hutId}:${hut.life}:${index}`);
    }
  }

  /**
   * Harvest hook: starting an orchard harvest without Hollin Lore rank 2 angers that hut's Hollins
   * at this player only. Returns true when the player was angered.
   */
  async onOrchardHarvestStart(playerId: string, nodeId: string): Promise<boolean> {
    const match = ORCHARD_ID.exec(nodeId);
    if (!match) return false;
    await this.deps.ranks.ensureLoaded(playerId);
    if (this.deps.ranks.rankOf(playerId, "wildkin_lore") >= 2) return false;
    const hut = await this.deps.store.getHut(match[1]!);
    if (!hut || hut.state !== "standing") return false;
    const now = this.now();
    const standing = await this.deps.store.getStanding(hut.hutId, playerId);
    await this.deps.store.setStanding(hut.hutId, playerId, this.withBan(standing, "orchard", now + HOLLIN_ORCHARD_TRADE_BAN_MS, now));
    this.makeHostile(hut.hutId, playerId, now);
    this.runtimeFor(hut.hutId).lastAttackedAt = now;
    this.dispatchDefenders(hut, Array<HollinDefenderKind>(HOLLIN_INITIAL_GUARDS).fill("guard"), [playerId]);
    return true;
  }

  /**
   * Greed: starting to chop any tree (wild, Giving Tree, planted) within sight of a Hollin Hut angers
   * its Hollins at this player only, with the short orchard trade ban. Hollin Lore rank 2 is exempt.
   * The hut's own orchard is handled by onOrchardHarvestStart. Uses the in-memory hut index, so it
   * costs one pass over the standing huts and no database read unless it fires.
   */
  async onTreeChopStart(playerId: string, position: LatLon, nodeId: string): Promise<boolean> {
    if (ORCHARD_ID.test(nodeId)) return false;
    const near = this.nearestHutInSight(position);
    if (!near) return false;
    await this.deps.ranks.ensureLoaded(playerId);
    if (this.deps.ranks.rankOf(playerId, "wildkin_lore") >= 2) return false;
    const hut = await this.deps.store.getHut(near.hutId);
    if (!hut || hut.state !== "standing") return false;
    const now = this.now();
    const standing = await this.deps.store.getStanding(hut.hutId, playerId);
    await this.deps.store.setStanding(hut.hutId, playerId, this.withBan(standing, "orchard", now + HOLLIN_ORCHARD_TRADE_BAN_MS, now));
    this.makeHostile(hut.hutId, playerId, now);
    this.runtimeFor(hut.hutId).lastAttackedAt = now;
    this.dispatchDefenders(hut, Array<HollinDefenderKind>(HOLLIN_INITIAL_GUARDS).fill("guard"), [playerId]);
    return true;
  }

  private nearestHutInSight(position: LatLon): HollinHutRecord | null {
    let best: HollinHutRecord | null = null;
    let bestDistance = HOLLIN_SIGHT_RANGE_M;
    for (const hut of this.standingHuts) {
      if (Math.abs(hut.position.lat - position.lat) > 0.003) continue;
      const distance = distanceMeters(position, hut.position);
      if (distance <= bestDistance) { best = hut; bestDistance = distance; }
    }
    return best;
  }

  /** Scheduler tick: respawns, hut repair, raid-wave re-arming, Elder healing, grudges and orchard regrowth. */
  async tick(): Promise<void> {
    const now = this.now();
    const elapsedS = Math.max(0, now - this.lastTickAt) / 1_000;
    this.lastTickAt = now;
    const huts: HollinHutRecord[] = [];
    for (const hut of await this.deps.store.listHuts()) {
      if (hut.expiresAt && hut.expiresAt.getTime() <= now) await this.retireHut(hut);
      else huts.push(hut);
    }
    this.standingHuts = huts.filter((hut) => hut.state === "standing");
    if (this.deps.onlinePlayers && !this.scanningGrudges && now - this.lastGrudgeScanAt >= GRUDGE_SCAN_INTERVAL_MS) {
      this.lastGrudgeScanAt = now;
      this.scanningGrudges = true;
      void this.scanGrudges(now).catch((error: unknown) =>
        this.deps.logger?.warn({ err: error }, "Hollin grudge scan failed")).finally(() => { this.scanningGrudges = false; });
    }
    for (const hut of huts) {
      if (hut.state === "destroyed") {
        if (hut.respawnAt && hut.respawnAt.getTime() <= now) {
          this.despawnServiceBody(hut);
          const revived = await this.deps.store.respawn(hut.hutId);
          if (revived) await this.project(revived);
        }
        continue;
      }
      this.tickStanding(hut, now, elapsedS);
    }
    if (now - this.lastOrphanSweepAt >= ORPHAN_SWEEP_INTERVAL_MS) {
      this.lastOrphanSweepAt = now;
      await this.detachOrphanedHuts();
    }
    if (now - this.lastRegrowAt >= 10_000) {
      this.lastRegrowAt = now;
      await this.deps.store.regrowOrchardTrees(new Date(now - HOLLIN_ORCHARD_REGROW_MS));
    }
  }

  private tickStanding(hut: HollinHutRecord, now: number, elapsedS: number): void {
    const state = this.runtime.get(hut.hutId);
    const body = this.deps.combat.entity(this.bodyEntityId(hut));
    if (!state) {
      if (body && body.currentHealth < body.maxHealth) this.repair(hut, body.maxHealth, elapsedS);
      return;
    }
    for (const [playerId, until] of state.hostile) if (until <= now) state.hostile.delete(playerId);
    for (const guardId of [...state.guards]) {
      if (this.deps.combat.entity(guardId)?.lifeState !== "alive") state.guards.delete(guardId);
    }
    // A health threshold re-arms only once repair has healed the hut back above it.
    for (const index of state.wavesFired) {
      if (index > 0 && body && body.currentHealth > HOLLIN_RAID_WAVE_HEALTH[index]!) state.wavesFired.delete(index);
    }
    this.elderHealing(state, elapsedS);
    const sinceAttack = now - state.lastAttackedAt;
    if (sinceAttack >= HOLLIN_HUT_REPAIR_DELAY_MS) {
      if (body && body.currentHealth < body.maxHealth) this.repair(hut, body.maxHealth, elapsedS);
      if (state.hostile.size === 0) {
        this.dismissGuards(hut.hutId);
        if (!body || body.currentHealth >= body.maxHealth) this.runtime.delete(hut.hutId);
      }
      return;
    }
  }

  /** Every live Elder (counting at most two) heals each wounded defender a little each second. */
  private elderHealing(state: HutRuntime, elapsedS: number): void {
    const { combat } = this.deps;
    let elders = 0;
    for (const id of state.guards) if (id.startsWith("mob:hollin-elder:") && combat.entity(id)?.lifeState === "alive") elders += 1;
    if (elders === 0) return;
    for (const id of state.guards) {
      const defender = combat.entity(id);
      if (!defender || defender.lifeState !== "alive" || defender.currentHealth >= defender.maxHealth) continue;
      combat.healMob(id, defender.maxHealth * HOLLIN_ELDER_HEAL_FRACTION_PER_SECOND * Math.min(2, elders) * Math.max(1, elapsedS));
    }
  }

  private repair(hut: HollinHutRecord, maxHealth: number, elapsedS: number): void {
    this.deps.combat.healMob(
      this.bodyEntityId(hut),
      maxHealth * HOLLIN_HUT_REPAIR_FRACTION_PER_SECOND * Math.max(1, elapsedS)
    );
  }

  private runtimeFor(hutId: string): HutRuntime {
    let state = this.runtime.get(hutId);
    if (!state) {
      state = { lastAttackedAt: 0, wavesFired: new Set(), hitBanned: new Set(), guardSeq: 0, guards: new Set(), hostile: new Map(), damage: new Map() };
      this.runtime.set(hutId, state);
    }
    return state;
  }

  private makeHostile(hutId: string, playerId: string, now: number): void {
    this.runtimeFor(hutId).hostile.set(playerId, now + HOLLIN_ANGER_MS);
  }

  private withBan(standing: HollinStanding, reason: HollinBanReason, untilMs: number, now: number): HollinStanding {
    const currentUntil = standing.tradeBannedUntil && standing.tradeBannedUntil.getTime() > now
      ? standing.tradeBannedUntil.getTime()
      : 0;
    const raid = reason === "raid" || standing.banReason === "raid";
    return {
      tradeBannedUntil: new Date(Math.max(currentUntil, untilMs)),
      banReason: raid ? "raid" : "orchard",
      angryUntil: new Date(now + HOLLIN_ANGER_MS),
      grudgeUntil: standing.grudgeUntil
    };
  }

  /**
   * A hit on the hut body: the Hollins fight this player for the raid (combat aggro only, no ban).
   * Waves fire once each: one on the first hit and one each time the hut drops to a threshold.
   */
  private recordRaid(hutId: string, playerId: string, damage: number, healthAfter: number | null): void {
    const now = this.now();
    const state = this.runtimeFor(hutId);
    if (Number.isFinite(damage) && damage > 0) state.damage.set(playerId, (state.damage.get(playerId) ?? 0) + damage);
    state.lastAttackedAt = now;
    this.makeHostile(hutId, playerId, now);
    const due: number[] = [];
    HOLLIN_RAID_WAVE_HEALTH.forEach((threshold, index) => {
      if (state.wavesFired.has(index)) return;
      if (index === 0 || (healthAfter !== null && healthAfter <= threshold)) due.push(index);
    });
    for (const index of due) state.wavesFired.add(index);
    const attackers = [...state.hostile.keys()];
    void this.deps.store.getHut(hutId).then((hut) => {
      if (hut?.state !== "standing") return;
      if (due.length > 0) for (const index of due) this.dispatchDefenders(hut, hollinWaveComposition(index, attackers.length), attackers);
      else this.directIdleDefenders(hut.hutId, attackers);
    }).catch((error: unknown) => this.deps.logger?.warn({ err: error, hutId }, "Hollin raid wave failed"));
  }

  /** Landing a hit on any Hollin earns that player a 12 hour trade ban at that hut (never shortening a longer one). */
  private recordHollinHit(hutId: string, playerId: string): void {
    const now = this.now();
    const state = this.runtimeFor(hutId);
    this.makeHostile(hutId, playerId, now);
    if (state.hitBanned.has(playerId)) return;
    state.hitBanned.add(playerId);
    void this.deps.store.getStanding(hutId, playerId).then((standing) =>
      this.deps.store.setStanding(hutId, playerId, this.withBan(standing, "raid", now + HOLLIN_HIT_TRADE_BAN_MS, now)))
      .catch((error: unknown) => this.deps.logger?.warn({ err: error, hutId, playerId }, "failed to persist Hollin hit ban"));
  }

  /** Breaking the hut: every damage contributor gets the 24h ban and a 24h on-sight grudge. */
  private async banContributors(hut: HollinHutRecord): Promise<void> {
    const state = this.runtime.get(hut.hutId);
    if (!state) return;
    const now = this.now();
    for (const [playerId, damage] of state.damage) {
      if (!(damage > 0)) continue;
      const standing = await this.deps.store.getStanding(hut.hutId, playerId);
      const banned = this.withBan(standing, "raid", now + HOLLIN_RAID_TRADE_BAN_MS, now);
      const grudge = Math.max(standing.grudgeUntil?.getTime() ?? 0, now + HOLLIN_GRUDGE_MS);
      await this.deps.store.setStanding(hut.hutId, playerId, { ...banned, grudgeUntil: new Date(grudge) });
      this.grudgeCache.delete(playerId);
    }
  }

  /** The player's active grudge end time (ms), cached briefly so the sight scan stays cheap. */
  private async grudgeEndsAt(playerId: string, now: number): Promise<number> {
    const cached = this.grudgeCache.get(playerId);
    if (cached && now - cached.checkedAt < GRUDGE_CACHE_MS) return cached.until;
    const until = (await this.deps.store.getGrudgeUntil(playerId))?.getTime() ?? 0;
    this.grudgeCache.set(playerId, { until, checkedAt: now });
    return until;
  }

  /**
   * On-sight aggression: any Hollin at any hut attacks a player carrying a grudge when they come
   * within sight. Per player only; party members without a grudge are never targeted.
   */
  private async scanGrudges(now: number): Promise<void> {
    for (const player of this.deps.onlinePlayers?.() ?? []) {
      const near = this.standingHuts.filter((hut) =>
        Math.abs(hut.position.lat - player.position.lat) <= 0.003 && distanceMeters(player.position, hut.position) <= HOLLIN_SIGHT_RANGE_M);
      if (near.length === 0) continue;
      const until = await this.grudgeEndsAt(player.playerId, now);
      if (until <= now) continue;
      for (const hut of near) {
        this.makeHostile(hut.hutId, player.playerId, now);
        const state = this.runtimeFor(hut.hutId);
        if (state.guards.size === 0) {
          this.dispatchDefenders(hut, Array<HollinDefenderKind>(HOLLIN_INITIAL_GUARDS).fill("guard"), [player.playerId]);
        } else {
          this.directIdleDefenders(hut.hutId, [player.playerId]);
        }
        for (let index = 0; index < HOLLIN_FARMER_COUNT; index += 1) {
          const farmerId = `mob:hollin-farmer:${hut.hutId}:${hut.life}:${index}`;
          const farmer = this.deps.combat.entity(farmerId);
          if (farmer && !farmer.targetEntityId) this.deps.combat.directMobTarget(farmerId, player.playerId);
        }
      }
    }
  }

  /**
   * Spawns the given defenders (elites are listed first, so a full hut keeps them) up to the live
   * defender cap, then sends every idle defender after the given players.
   */
  private dispatchDefenders(hut: HollinHutRecord, kinds: readonly HollinDefenderKind[], targets: readonly string[]): void {
    if (targets.length === 0) return;
    const state = this.runtimeFor(hut.hutId);
    const { combat } = this.deps;
    for (const id of [...state.guards]) if (combat.entity(id)?.lifeState !== "alive") state.guards.delete(id);
    // A full hut makes room for elites by sending its plain guards home (oldest first), so the
    // later, stronger waves are never starved by earlier, weaker ones.
    const eliteCount = kinds.filter((kind) => kind !== "guard").length;
    let deficit = Math.min(eliteCount, Math.max(0, kinds.length - Math.max(0, HOLLIN_MAX_DEFENDERS - state.guards.size)));
    for (const id of [...state.guards]) {
      if (deficit <= 0) break;
      if (!id.startsWith("mob:hollin-guard:")) continue;
      combat.despawnMob(id);
      state.guards.delete(id);
      deficit -= 1;
    }
    const room = Math.max(0, HOLLIN_MAX_DEFENDERS - state.guards.size);
    for (const kind of kinds.slice(0, room)) {
      const entityId = `mob:hollin-${kind}:${hut.hutId}:${hut.life}:${state.guardSeq}`;
      state.guardSeq += 1;
      const position = destinationPoint(hut.position, 12 + (state.guardSeq % 4) * 3, (state.guardSeq * 67) % 360);
      combat.spawnMob({
        entityId, archetype: `hollin_${kind}`, position, homePosition: position,
        regionCode: hut.regionCode, zoneId: hut.zoneId, worldAi: true, summoned: true
      });
      state.guards.add(entityId);
    }
    this.directIdleDefenders(hut.hutId, targets);
  }

  /** Spreads the idle defenders across the attackers, round-robin. */
  private directIdleDefenders(hutId: string, targets: readonly string[]): void {
    const state = this.runtime.get(hutId);
    if (!state || targets.length === 0) return;
    let next = 0;
    for (const id of state.guards) {
      const defender = this.deps.combat.entity(id);
      if (!defender || defender.targetEntityId) continue;
      this.deps.combat.directMobTarget(id, targets[next % targets.length]!);
      next += 1;
    }
  }

  private dismissGuards(hutId: string): void {
    const state = this.runtime.get(hutId);
    if (!state) return;
    for (const guardId of state.guards) this.deps.combat.despawnMob(guardId);
    state.guards.clear();
  }

  /** Stand the defenders down for one player (berry pacify). */
  private calmPlayer(hutId: string, playerId: string): void {
    const state = this.runtime.get(hutId);
    if (!state) return;
    state.hostile.delete(playerId);
    for (const guardId of state.guards) {
      if (this.deps.combat.entity(guardId)?.targetEntityId === playerId) this.deps.combat.cancelCombat(guardId);
    }
  }

  /** World Map destinations for Hollin Lore rank 1+: every standing hut, however far away. */
  async visibleDestinations(playerId: string): Promise<{ kind: "hollin_hut"; id: string; name: string; lat: number; lon: number; visible: boolean }[]> {
    await this.deps.ranks.ensureLoaded(playerId);
    if (this.deps.ranks.rankOf(playerId, "wildkin_lore") < 1) return [];
    return (await this.deps.store.listHuts())
      .filter((hut) => hut.state === "standing")
      .map((hut) => ({ kind: "hollin_hut" as const, id: hut.hutId, name: "Hollin Hut", lat: hut.position.lat, lon: hut.position.lon, visible: true }));
  }

  /** Where a visiting player arrives, or an error when they may not visit this hut. */
  async visitTarget(playerId: string, hutId: string): Promise<LatLon> {
    await this.deps.ranks.ensureLoaded(playerId);
    if (this.deps.ranks.rankOf(playerId, "wildkin_lore") < 1) {
      throw new HollinHutError("HOLLIN_LORE_REQUIRED", "You need Hollin Lore to visit distant Hollin Huts.");
    }
    const hut = await this.requireStandingHut(hutId);
    return destinationPoint(hut.position, HOLLIN_FARMER_RING_RADIUS_M + 18, 200);
  }

  async shopFor(player: HollinPlayer, accountId: string, hutId: string): Promise<HollinHutShopSnapshot> {
    const hut = await this.requireStandingHut(hutId);
    this.requireNear(player, hut);
    return this.snapshot(player.playerId, accountId, hut);
  }

  async buy(player: HollinPlayer, accountId: string, input: Readonly<{
    requestId: string; hutId: string; itemId: string; quantity: number; expectedUnitPriceGold: string;
  }>): Promise<HollinPurchaseResult> {
    if (!input.requestId) throw new HollinHutError("HOLLIN_BAD_REQUEST", "A request id is required");
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new HollinHutError("HOLLIN_INVALID_QUANTITY", "Purchase quantity must be a positive whole number");
    }
    const hut = await this.requireStandingHut(input.hutId);
    const line = (await this.stockFor(hut)).find((entry) => entry.itemId === input.itemId);
    if (!line) throw new HollinHutError("HOLLIN_ITEM_UNAVAILABLE", "The Hollins are not selling that today");
    if (input.quantity > line.maxQuantity) {
      throw new HollinHutError("HOLLIN_INVALID_QUANTITY", `The Hollins will sell at most ${line.maxQuantity} at a time`);
    }
    this.requireNear(player, hut);
    await this.requireTrading(hut, player.playerId);
    await this.deps.ranks.ensureLoaded(player.playerId);
    const rank = this.deps.ranks.rankOf(player.playerId, "wildkin_lore");
    const unitPrice = hollinDiscountedUnitPrice(line.basePriceGold, rank);
    if (input.expectedUnitPriceGold !== String(unitPrice)) {
      throw new HollinHutError("HOLLIN_PRICE_CHANGED", "The Hollins' price changed");
    }
    const totalGold = BigInt(unitPrice) * BigInt(input.quantity);
    const done = await this.deps.transaction(async (client) => {
      const wallet = await this.deps.wallet.debitForOperationInTransaction(client, {
        playerId: player.playerId,
        accountId,
        amount: totalGold,
        operationKey: `hollin-purchase:${player.playerId}:${input.requestId}`,
        reason: "hollin_hut_purchase",
        metadata: { hutId: hut.hutId, itemId: input.itemId, quantity: input.quantity, rank }
      });
      const granted = await this.deps.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `hollin-purchase:${player.playerId}:${input.requestId}:items`,
        playerId: player.playerId,
        source: "hollin_hut_purchase",
        sourceEntityType: "hollin_hut",
        sourceEntityId: hut.hutId,
        metadata: { itemId: input.itemId, quantity: input.quantity },
        grants: [{ itemId: input.itemId as ResourceType, variant: null, quantity: input.quantity }]
      });
      return { wallet, granted };
    });
    return {
      replayed: !done.wallet.applied,
      itemId: input.itemId,
      quantity: input.quantity,
      totalGold: totalGold.toString(),
      snapshot: await this.snapshot(player.playerId, accountId, hut),
      inventory: done.granted.inventory,
      walletGold: done.wallet.goldBalance.toString(),
      walletVersion: done.wallet.version.toString()
    };
  }

  /**
   * Hollin Lore rank 3: offering a Giving Berry calms the hut's Hollins and lifts this player's
   * trade ban (and anger) at this hut only.
   */
  async pacify(player: HollinPlayer, accountId: string, input: Readonly<{ requestId: string; hutId: string }>): Promise<Readonly<{
    hutId: string; message: string; snapshot: HollinHutShopSnapshot; inventory: PlayerInventorySnapshot;
  }>> {
    const hut = await this.requireStandingHut(input.hutId);
    this.requireNear(player, hut);
    await this.deps.ranks.ensureLoaded(player.playerId);
    if (this.deps.ranks.rankOf(player.playerId, "wildkin_lore") < 3) {
      throw new HollinHutError("HOLLIN_LORE_REQUIRED", "You need Hollin Lore rank 3 to calm angry Hollins.");
    }
    const standing = await this.activeStanding(hut.hutId, player.playerId);
    const grudge = (await this.grudgeEndsAt(player.playerId, this.now())) > this.now();
    const raidHostile = (this.runtime.get(hut.hutId)?.hostile.get(player.playerId) ?? 0) > this.now();
    if (!standing.tradeBannedUntil && !standing.angryUntil && !grudge && !raidHostile) {
      throw new HollinHutError("HOLLIN_NOT_ANGRY", "The Hollins are not angry with you.");
    }
    const debited = await this.deps.transaction((client) => this.deps.inventory.debitItemsForOperationInTransaction(client, {
      operationKey: `hollin-pacify:${player.playerId}:${input.requestId}`,
      playerId: player.playerId,
      source: "hollin_hut_pacify",
      sourceEntityType: "hollin_hut",
      sourceEntityId: hut.hutId,
      metadata: { itemId: "giving_berry" },
      debits: [{ itemId: "giving_berry", variant: null, quantity: 1 }]
    }));
    await this.deps.store.setStanding(hut.hutId, player.playerId, NO_STANDING);
    // The berry forgives the on-sight grudge everywhere and stands every nearby Hollin down.
    await this.deps.store.clearGrudge(player.playerId);
    this.grudgeCache.delete(player.playerId);
    for (const hutId of this.runtime.keys()) this.calmPlayer(hutId, player.playerId);
    return {
      hutId: hut.hutId,
      message: "The Hollins accept the berry and calm down.",
      snapshot: await this.snapshot(player.playerId, accountId, hut),
      inventory: debited.inventory
    };
  }

  /** Pay a little gold to restore all health. Replay-safe: one debit per request id. */
  async heal(player: HollinPlayer, accountId: string, input: Readonly<{ requestId: string; hutId: string }>): Promise<HollinServiceResult> {
    if (!input.requestId) throw new HollinHutError("HOLLIN_BAD_REQUEST", "A request id is required");
    const hut = await this.requireStandingHut(input.hutId);
    this.requireNear(player, hut);
    await this.requireTrading(hut, player.playerId);
    const body = this.deps.combat.entity(player.playerId);
    if (!body || body.lifeState !== "alive") throw new HollinHutError("HOLLIN_CANNOT_HEAL", "The Hollins cannot help you right now.");
    if (body.currentHealth >= body.maxHealth) throw new HollinHutError("HOLLIN_NOT_HURT", "You are not hurt.");
    const wallet = await this.deps.transaction((client) => this.deps.wallet.debitForOperationInTransaction(client, {
      playerId: player.playerId,
      accountId,
      amount: BigInt(HOLLIN_HEAL_COST_GOLD),
      operationKey: `hollin-heal:${player.playerId}:${input.requestId}`,
      reason: "hollin_hut_heal",
      metadata: { hutId: hut.hutId }
    }));
    // A replayed request was already paid and healed once; it neither charges nor heals again.
    if (wallet.applied) this.deps.combat.healEntity(player.playerId, body.maxHealth - body.currentHealth, hut.hutId);
    return {
      service: "heal",
      hutId: hut.hutId,
      message: wallet.applied ? "The Hollins tend your wounds." : "The Hollins already tended your wounds.",
      snapshot: await this.snapshot(player.playerId, accountId, hut),
      walletGold: wallet.goldBalance.toString(),
      walletVersion: wallet.version.toString()
    };
  }

  /** Hand in Giant Eggs to discover Hollin Lore (the same discovery the Eyrie egg nest performs). */
  async turnInEggs(player: HollinPlayer, accountId: string, input: Readonly<{ requestId: string; hutId: string }>): Promise<HollinServiceResult> {
    if (!input.requestId) throw new HollinHutError("HOLLIN_BAD_REQUEST", "A request id is required");
    const hut = await this.requireStandingHut(input.hutId);
    this.requireNear(player, hut);
    await this.requireTrading(hut, player.playerId);
    if (!this.deps.ranks.turnIn) throw new HollinHutError("HOLLIN_UNAVAILABLE", "The Hollins cannot teach you right now.");
    const result = await this.deps.ranks.turnIn(player.playerId, "wildkin_lore", input.requestId);
    if (result.status === "already_discovered") throw new HollinHutError("HOLLIN_LORE_KNOWN", result.message);
    if (result.status === "insufficient") throw new HollinHutError("HOLLIN_NOT_ENOUGH_EGGS", result.message);
    return {
      service: "turn_in_eggs",
      hutId: hut.hutId,
      message: result.message,
      snapshot: await this.snapshot(player.playerId, accountId, hut),
      inventory: result.inventory,
      skills: result.snapshot
    };
  }

  /**
   * This hut's stock today: deterministic from the hut id, its biome and the rotation day. A hut's
   * position never changes, so its biome is resolved once and remembered; developer huts, a missing
   * lookup and a failed lookup all use the generic pool (a failure is not remembered, so it retries).
   */
  protected async stockFor(hut: HollinHutRecord): Promise<ReturnType<typeof hollinStockForHut>> {
    return hollinStockForHut(hut.hutId, hollinStockEpoch(this.now()), await this.biomeOf(hut), await this.givingTreesAt(hut));
  }

  /** Remembered per hut like the biome; a failed lookup sells no berries and is retried next time. */
  private async givingTreesAt(hut: HollinHutRecord): Promise<boolean> {
    const known = this.hutGivingTrees.get(hut.hutId);
    if (known !== undefined) return known;
    try {
      const trees = await this.deps.store.hasGivingTrees(hut.position);
      this.hutGivingTrees.set(hut.hutId, trees);
      return trees;
    } catch (error) {
      this.deps.logger?.warn({ err: error, hutId: hut.hutId }, "Hollin Hut Giving Tree lookup failed");
      return false;
    }
  }

  private async biomeOf(hut: HollinHutRecord): Promise<WorldZoneBiome | null> {
    if (hut.source !== "population" || !this.deps.biomeAt) return null;
    const known = this.hutBiomes.get(hut.hutId);
    if (known !== undefined) return known;
    try {
      const biome = await this.deps.biomeAt(hut.position);
      this.hutBiomes.set(hut.hutId, biome);
      return biome;
    } catch (error) {
      this.deps.logger?.warn({ err: error, hutId: hut.hutId }, "Hollin Hut biome lookup failed");
      return null;
    }
  }

  /** Raiders and haggling Hollins do not mix: a banned player gets no service at this hut. */
  protected async requireTrading(hut: HollinHutRecord, playerId: string): Promise<void> {
    if ((await this.activeStanding(hut.hutId, playerId)).tradeBannedUntil) {
      throw new HollinHutError("HOLLIN_TRADE_BANNED", "The Hollins refuse to trade with you.");
    }
  }

  /**
   * Each contributor (enough damage to this hut) gets one loot roll, granted once per hut defeat.
   * The roll is seeded and the grant is keyed on hut, life and player, so a retry changes nothing.
   */
  private async grantRaidLoot(hut: HollinHutRecord): Promise<void> {
    const state = this.runtime.get(hut.hutId);
    if (!state) return;
    const contributors = [...state.damage].filter(([, damage]) => damage >= HOLLIN_RAID_LOOT_MIN_DAMAGE).map(([id]) => id);
    for (const playerId of contributors) {
      const loot = rollHollinRaidLoot(`hollin-raid-loot:${hut.hutId}:${hut.life}:${playerId}`);
      try {
        const granted = await this.deps.transaction((client) => this.deps.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `hollin-raid-loot:${hut.hutId}:${hut.life}:${playerId}`,
          playerId,
          source: "hollin_hut_raid_loot",
          sourceEntityType: "hollin_hut",
          sourceEntityId: hut.hutId,
          metadata: { life: hut.life },
          grants: loot.map((entry) => ({ itemId: entry.itemId as ResourceType, variant: null, quantity: entry.quantity }))
        }));
        if (granted.applied) this.deps.onRaidLoot?.({ playerId, hutId: hut.hutId, loot, inventory: granted.inventory });
      } catch (error) {
        this.deps.logger?.warn({ err: error, hutId: hut.hutId, playerId }, "Hollin raid loot grant failed");
      }
    }
  }

  /** The player's standing with expired bans and anger dropped. */
  protected async activeStanding(hutId: string, playerId: string): Promise<HollinStanding> {
    const standing = await this.deps.store.getStanding(hutId, playerId);
    const now = this.now();
    const banned = standing.tradeBannedUntil && standing.tradeBannedUntil.getTime() > now;
    const angry = standing.angryUntil && standing.angryUntil.getTime() > now;
    return {
      tradeBannedUntil: banned ? standing.tradeBannedUntil : null,
      banReason: banned ? standing.banReason : null,
      angryUntil: angry ? standing.angryUntil : null,
      grudgeUntil: standing.grudgeUntil && standing.grudgeUntil.getTime() > now ? standing.grudgeUntil : null
    };
  }

  protected async snapshot(playerId: string, accountId: string, hut: HollinHutRecord): Promise<HollinHutShopSnapshot> {
    await this.deps.ranks.ensureLoaded(playerId);
    const rank = this.deps.ranks.rankOf(playerId, "wildkin_lore");
    const standing = await this.activeStanding(hut.hutId, playerId);
    const wallet = await this.deps.wallet.snapshot(playerId, accountId);
    const epoch = hollinStockEpoch(this.now());
    const stock = await this.stockFor(hut);
    const body = this.deps.combat.entity(playerId);
    const hurt = !!body && body.lifeState === "alive" && body.currentHealth < body.maxHealth;
    const totals = (await this.deps.inventory.getInventorySnapshot(playerId)).totals as Record<string, number | undefined>;
    return {
      hutId: hut.hutId,
      stockRefreshesAt: new Date(hollinStockRefreshesAtMs(epoch)).toISOString(),
      heal: {
        costGold: String(HOLLIN_HEAL_COST_GOLD),
        currentHealth: body ? Math.round(body.currentHealth) : 0,
        maxHealth: body ? Math.round(body.maxHealth) : 0,
        canHeal: hurt && standing.tradeBannedUntil === null
      },
      eggs: {
        have: Number(totals[HOLLIN_LORE_EGG_ITEM] ?? 0),
        need: HOLLIN_LORE_EGG_COST,
        discovered: (await this.deps.ranks.hasDiscovered?.(playerId, "wildkin_lore")) ?? rank > 0
      },
      name: "Hollin Hut",
      rank,
      discountPercent: hollinShopDiscountPercent(rank),
      tradeBannedUntil: standing.tradeBannedUntil ? standing.tradeBannedUntil.toISOString() : null,
      banReason: standing.banReason,
      canPacify: rank >= 3 && standing.tradeBannedUntil !== null,
      walletGold: wallet.gold,
      lines: stock.map((line) => ({
        itemId: line.itemId,
        displayName: INVENTORY_CATALOG[line.itemId as keyof typeof INVENTORY_CATALOG]?.displayName ?? line.itemId,
        baseUnitPriceGold: String(line.basePriceGold),
        unitPriceGold: String(hollinDiscountedUnitPrice(line.basePriceGold, rank)),
        maxQuantity: line.maxQuantity
      }))
    };
  }

  protected async requireStandingHut(hutId: string): Promise<HollinHutRecord> {
    const hut = await this.deps.store.getHut(hutId);
    if (!hut || this.expired(hut)) throw new HollinHutError("HOLLIN_HUT_NOT_FOUND", "That Hollin Hut is gone.");
    if (hut.state !== "standing") throw new HollinHutError("HOLLIN_HUT_DESTROYED", "The Hollin Hut lies in ruins.");
    return hut;
  }

  protected requireNear(player: HollinPlayer, hut: HollinHutRecord): void {
    if (distanceMeters(player.position, hut.position) > HOLLIN_INTERACTION_RADIUS_M) {
      throw new HollinHutError("HOLLIN_TOO_FAR", "Move closer to the Hollin Hut.");
    }
  }

  /** Spawns the hut body and its idle Hollins when missing (idempotent). */
  protected async project(hut: HollinHutRecord): Promise<void> {
    if (hut.state !== "standing") return;
    const { combat } = this.deps;
    await this.deps.store.ensureOrchardTrees(hut, Array.from({ length: HOLLIN_ORCHARD_TREE_COUNT }, (_, index) => ({
      entityId: hollinOrchardTreeId(hut.hutId, index),
      position: destinationPoint(hut.position, HOLLIN_ORCHARD_RADIUS_M, (360 / HOLLIN_ORCHARD_TREE_COUNT) * index + 75)
    })));
    const base = { regionCode: hut.regionCode, zoneId: hut.zoneId, worldAi: true as const };
    // A population hut's first body (life 0) is the Population V2 entity; every other body is ours.
    if (!this.populationOwnsBody(hut)) {
      const hutEntityId = hollinHutEntityId(hut.hutId, hut.life);
      if (!combat.entity(hutEntityId)) {
        combat.spawnMob({ entityId: hutEntityId, archetype: "hollin_hut", position: hut.position, homePosition: hut.position, ...base });
      }
    }
    for (let index = 0; index < HOLLIN_FARMER_COUNT; index += 1) {
      const entityId = `mob:hollin-farmer:${hut.hutId}:${hut.life}:${index}`;
      if (combat.entity(entityId)) continue;
      const position = destinationPoint(hut.position, HOLLIN_FARMER_RING_RADIUS_M, (360 / HOLLIN_FARMER_COUNT) * index + 30);
      combat.spawnMob({ entityId, archetype: "hollin_farmer", position, homePosition: position, ...base });
    }
  }

  protected despawnBodies(hut: HollinHutRecord): void {
    const { combat } = this.deps;
    this.despawnServiceBody(hut);
    for (let index = 0; index < HOLLIN_FARMER_COUNT; index += 1) {
      combat.despawnMob(`mob:hollin-farmer:${hut.hutId}:${hut.life}:${index}`);
    }
  }

  /** The combat entity id of this hut's current body. */
  protected bodyEntityId(hut: HollinHutRecord): string {
    return this.populationOwnsBody(hut) ? hut.populationEntityId! : hollinHutEntityId(hut.hutId, hut.life);
  }

  /** Life 0 of a population hut belongs to Population V2 (it spawns, sleeps and wakes the body itself). */
  private populationOwnsBody(hut: HollinHutRecord): boolean {
    return hut.source === "population" && hut.life === 0 && hut.populationEntityId !== null;
  }

  private despawnServiceBody(hut: HollinHutRecord): void {
    if (!this.populationOwnsBody(hut)) this.deps.combat.despawnMob(hollinHutEntityId(hut.hutId, hut.life));
  }

  /** The hut a combat entity id is the body of: service-owned ids parse; Population V2 bodies are looked up. */
  private hutIdOfBody(entityId: string): string | null {
    return hollinHutIdFromEntityId(entityId) ?? this.populationBodies.get(entityId) ?? null;
  }

  /**
   * Population V2 spawned (or re-woke) a Hollin Hut body. Adopts it as a hut keyed by its stable
   * entity id and builds the farmers and orchard around it. The body is sent away instead when it
   * landed inside claimed territory (a flag or city), when another hut stands within 30 km (the
   * store checks that atomically), or when its hut already has a service-owned body (after a raid
   * respawn, or after its generation ended): Population V2 plans from habitat alone, so this is
   * where those rules are enforced and where a returning body is never doubled.
   */
  async onPopulationBodySpawned(input: Readonly<{
    entityId: string; regionCode: string; zoneId: string; position: LatLon;
  }>): Promise<void> {
    const hutId = `hollin-hut:${input.entityId}`;
    this.populationBodies.set(input.entityId, hutId);
    const sendAway = (): void => {
      this.populationBodies.delete(input.entityId);
      this.deps.combat.despawnPopulationManagedMob?.(input.entityId);
    };
    let hut = await this.deps.store.getHut(hutId);
    if (hut && this.expired(hut)) {
      await this.retireHut(hut);
      sendAway();
      return;
    }
    if (!hut) {
      if (await this.deps.store.isInsideClaimedTerritory(input.position)) {
        sendAway();
        return;
      }
      const now = this.now();
      hut = await this.deps.store.adoptPopulationHut({
        populationEntityId: input.entityId, regionCode: input.regionCode, zoneId: input.zoneId, position: input.position,
        expiresAt: new Date(now + hollinHutLifetimeMs(hutId))
      }, new Date(now));
      if (!hut) {
        sendAway();
        return;
      }
    }
    if (hut.state !== "standing" || !this.populationOwnsBody(hut)) sendAway();
    await this.project(hut);
  }

  private expired(hut: HollinHutRecord): boolean {
    return hut.expiresAt !== null && hut.expiresAt.getTime() <= this.now();
  }

  /**
   * A population hut outlives its Population V2 generation (48 h): once the slot is gone the
   * service takes over the body (life + 1, like a raid respawn), keeping the hut, its orchard and
   * the players' standings until it expires.
   */
  private async detachOrphanedHuts(): Promise<void> {
    for (const hut of await this.deps.store.listOrphanedPopulationHuts()) {
      const detached = await this.deps.store.detachPopulationBody(hut.hutId);
      if (!detached) continue;
      this.dismissGuards(hut.hutId);
      this.runtime.delete(hut.hutId);
      this.despawnBodies(hut);
      if (hut.populationEntityId) {
        this.populationBodies.delete(hut.populationEntityId);
        this.deps.combat.despawnPopulationManagedMob?.(hut.populationEntityId);
      }
      await this.project(detached);
    }
  }

  /** An expired hut despawns for good, with its Hollins, orchard and standings; its area may roll a new hut. */
  private async retireHut(hut: HollinHutRecord): Promise<void> {
    this.dismissGuards(hut.hutId);
    this.despawnBodies(hut);
    if (hut.populationEntityId) {
      if (this.populationOwnsBody(hut)) this.deps.combat.despawnPopulationManagedMob?.(hut.populationEntityId);
      this.populationBodies.delete(hut.populationEntityId);
    }
    this.runtime.delete(hut.hutId);
    this.hutBiomes.delete(hut.hutId);
    this.hutGivingTrees.delete(hut.hutId);
    await this.deps.store.deleteHut(hut.hutId);
  }
}
