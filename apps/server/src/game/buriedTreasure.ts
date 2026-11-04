import { createHash, randomUUID } from "node:crypto";

import {
  SHOVEL_ITEM_ID,
  SHOVEL_MAX_USES,
  SHOVEL_RECIPE,
  TREASURE_AREA_CAPS,
  TREASURE_AREA_RADIUS_M,
  TREASURE_AREA_TOTAL_CAP,
  TREASURE_DIG_RADIUS_M,
  TREASURE_GLOBAL_CAP,
  TREASURE_LANDMARK_KINDS,
  TREASURE_LANDMARK_MAX_OFFSET_M,
  TREASURE_LANDMARK_MIN_OFFSET_M,
  TREASURE_LANDMARK_SEARCH_M,
  TREASURE_LIFETIME_MS,
  TREASURE_MIN_SPACING_M,
  TREASURE_NEARBY_RADIUS_M,
  TREASURE_SPAWN_MAX_DISTANCE_M,
  TREASURE_SPAWN_MIN_DISTANCE_M,
  TREASURE_SPAWN_WEIGHTS,
  TREASURE_TIERS,
  TREASURE_TIER_NAMES,
  TREASURE_TIER_REQUIRED_CARTOGRAPHY_RANK,
  destinationPoint,
  distanceMeters,
  isTreasureTier,
  paidCharacterLevel,
  rollTreasureRewards,
  treasureTierVisible,
  type ResourceType,
  type TreasureCacheSnapshot,
  type TreasureLandmarkKind,
  type TreasureReward,
  type TreasureStateSnapshot,
  type TreasureTier
} from "@ash-atlas/shared";
import type pg from "pg";

import type { EquipmentService } from "./equipment.js";
import { isInventoryCapacityError, type InventoryService } from "./inventory.js";
import { requireTradeSkillGate, tradeSkillRank } from "./skills/tradeSkillRank.js";

type LatLon = Readonly<{ lat: number; lon: number }>;
type TreasureInventory = Pick<InventoryService, "debitItemsForOperationInTransaction" | "grantItemsForOperationInTransaction">;
type TreasureEquipment = Pick<EquipmentService, "grantPackageInstancesInTransaction">;

export class TreasureError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "TreasureError";
  }
}

function requireRequestId(requestId: unknown): asserts requestId is string {
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 128) {
    throw new TreasureError("TREASURE_REQUEST_INVALID", "A request id is required.");
  }
}

function requirePosition(position: LatLon | null | undefined): asserts position is LatLon {
  if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)) {
    throw new TreasureError("TREASURE_POSITION_REQUIRED", "Connect to the game world first.", 409);
  }
}

function sha256Bytes(value: string): Uint8Array {
  return createHash("sha256").update(value).digest();
}

/** What a dig returns to the digger (and what a replay returns again). */
export type TreasureDigResult = Readonly<{
  treasureId: string;
  tier: TreasureTier;
  items: readonly TreasureReward[];
  ring: string | null;
  shovelBroke: boolean;
  shovelUsesRemaining: number | null;
  replayed: boolean;
  message: string;
}>;

export type TreasureCraftResult = Readonly<{ replayed: boolean; message: string }>;

type StoredDig = Omit<TreasureDigResult, "replayed" | "message">;

const ITEM_NAMES: Readonly<Record<string, string>> = {
  wood: "Wood", stone: "Stone", iron: "Iron Ore", leather: "Leather", flax_fiber: "Flax Fiber",
  crude_oil: "Crude Oil", sulfur: "Sulfur", pearl: "Pearl", crystal: "Crystal", brood_silk: "Brood Silk",
  lamp_sheath: "Lamp Sheath",
  ring_plain: "Plain Ring"
};

function digMessage(stored: StoredDig): string {
  const parts = stored.items.map((item) => `${item.quantity} ${ITEM_NAMES[item.itemId] ?? item.itemId}`);
  if (stored.ring) parts.push(`a ${ITEM_NAMES[stored.ring] ?? stored.ring}`);
  const found = parts.length ? parts.join(", ") : "nothing of value";
  return `You dug up the ${TREASURE_TIER_NAMES[stored.tier]}: ${found}.${stored.shovelBroke ? " Your Shovel wore out." : ""}`;
}

/**
 * Server authority for buried treasure: the nearby list (tier-gated), crafting
 * the Shovel and digging. Lock order: the actor's player row, the treasure row,
 * then the inventory (inside the debit / grant).
 */
export class TreasureService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: TreasureInventory,
    private readonly equipment: TreasureEquipment
  ) {}

  async state(playerId: string, position: LatLon | null): Promise<TreasureStateSnapshot> {
    const [level, cartographyRank, items, wear, clock] = await Promise.all([
      playerLevel(this.pool, playerId),
      tradeSkillRank(this.pool, playerId, "cartography"),
      this.pool.query<{ item_id: string; quantity: string }>(
        `SELECT resource_type AS item_id, COALESCE(sum(quantity),0)::text AS quantity
         FROM player_inventory WHERE player_id=$1 AND resource_type = ANY($2::text[])
         GROUP BY resource_type`,
        [playerId, [SHOVEL_ITEM_ID, ...SHOVEL_RECIPE.map((entry) => entry.itemId)]]
      ),
      this.pool.query<{ uses_on_current: number }>("SELECT uses_on_current FROM player_shovel_wear WHERE player_id=$1", [playerId]),
      this.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ]);
    const have = (itemId: string) => Number(items.rows.find((row) => row.item_id === itemId)?.quantity ?? 0);
    const shovels = have(SHOVEL_ITEM_ID);
    const visibleTiers = TREASURE_TIERS.filter((tier) => treasureTierVisible(tier, cartographyRank));
    let caches: TreasureCacheSnapshot[] = [];
    if (position && Number.isFinite(position.lat) && Number.isFinite(position.lon)) {
      const rows = await this.pool.query<{
        treasure_id: string; tier: string; lat: number; lon: number; expires_at: Date;
        place_label: string | null; landmark_kind: string | null;
      }>(
        `SELECT treasure_id::text, tier, ST_Y(geom) AS lat, ST_X(geom) AS lon, expires_at, place_label, landmark_kind
         FROM buried_treasures
         WHERE status='buried' AND expires_at > clock_timestamp() AND tier = ANY($4::text[])
           AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
         ORDER BY spawned_at, treasure_id
         LIMIT 60`,
        [position.lat, position.lon, TREASURE_NEARBY_RADIUS_M, visibleTiers]
      );
      caches = rows.rows.filter((row) => isTreasureTier(row.tier)).map((row) => {
        const point = { lat: Number(row.lat), lon: Number(row.lon) };
        const distanceM = Math.round(distanceMeters(position, point));
        return {
          id: row.treasure_id,
          tier: row.tier as TreasureTier,
          lat: point.lat,
          lon: point.lon,
          expiresAt: new Date(row.expires_at).toISOString(),
          distanceM,
          reachable: distanceM <= TREASURE_DIG_RADIUS_M,
          placeLabel: row.place_label,
          landmarkKind: (TREASURE_LANDMARK_KINDS as readonly string[]).includes(row.landmark_kind ?? "")
            ? row.landmark_kind as TreasureLandmarkKind
            : null
        };
      });
    }
    return {
      serverTime: new Date(clock.rows[0]!.now).toISOString(),
      level,
      cartographyRank,
      shovels,
      shovelUsesRemaining: shovels > 0 ? SHOVEL_MAX_USES - Number(wear.rows[0]?.uses_on_current ?? 0) : null,
      shovelMaxUses: SHOVEL_MAX_USES,
      recipe: SHOVEL_RECIPE.map((entry) => ({ itemId: entry.itemId, quantity: entry.quantity, have: have(entry.itemId) })),
      caches,
      hiddenTiers: TREASURE_TIERS
        .filter((tier) => !treasureTierVisible(tier, cartographyRank))
        .map((tier) => ({ tier, requiredRank: TREASURE_TIER_REQUIRED_CARTOGRAPHY_RANK[tier] }))
    };
  }

  /** SHOVEL_RECIPE (Crude Oil, Wood and Iron Bars) makes one Shovel. */
  async artisanShovel(playerId: string, requestId: string): Promise<TreasureCraftResult> {
    requireRequestId(requestId);
    return this.transaction(async (client) => {
      await lockPlayer(client, playerId);
      const prior = await priorOperation(client, playerId, requestId, "artisan_shovel");
      if (prior) return { replayed: true, message: "Shovel crafted." };
      await requireTradeSkillGate(client, playerId, "artisan_shovel", (message) => new TreasureError("TREASURE_SKILL_REQUIRED", message, 403));
      const before = await shovelCount(client, playerId);
      const operationKey = `buried-treasure-craft:${playerId}:${requestId}`;
      try {
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey,
          playerId,
          source: "buried_treasure_shovel_craft",
          sourceEntityType: "buried_treasure",
          sourceEntityId: SHOVEL_ITEM_ID,
          metadata: { requestId },
          debits: SHOVEL_RECIPE.map((entry) => ({ itemId: entry.itemId as ResourceType, variant: null, quantity: entry.quantity }))
        });
        await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `${operationKey}:grant`,
          playerId,
          source: "buried_treasure_shovel_craft",
          sourceEntityType: "buried_treasure",
          sourceEntityId: SHOVEL_ITEM_ID,
          metadata: { requestId },
          grants: [{ itemId: SHOVEL_ITEM_ID, variant: null, quantity: 1 }]
        });
      } catch (error) {
        if (isInventoryCapacityError(error)) {
          throw new TreasureError("TREASURE_PACK_FULL", "You cannot carry another Shovel.", 409);
        }
        if (error instanceof Error && /enough items/iu.test(error.message)) {
          throw new TreasureError("TREASURE_MATERIALS_REQUIRED", `A Shovel needs ${SHOVEL_RECIPE.map((entry) => `${entry.quantity} ${entry.itemId.replace(/_/gu, " ")}`).join(", ")}.`, 409);
        }
        throw error;
      }
      // A fresh Shovel starts unworn; wear only carries over a Shovel already in the pack.
      if (before === 0) {
        await client.query(
          `INSERT INTO player_shovel_wear (player_id, uses_on_current) VALUES ($1, 0)
           ON CONFLICT (player_id) DO UPDATE SET uses_on_current = 0, updated_at = clock_timestamp()`,
          [playerId]
        );
      }
      await recordOperation(client, operationKey, playerId, requestId, "artisan_shovel", null, null, { crafted: true });
      return { replayed: false, message: "Shovel crafted." };
    });
  }

  /**
   * Dig a cache within reach. The first digger wins: the row lock serializes
   * diggers, the loser sees status 'dug', and a unique operation index backs it up.
   */
  async dig(playerId: string, position: LatLon | null, treasureId: string, requestId: string): Promise<TreasureDigResult> {
    requireRequestId(requestId);
    requirePosition(position);
    if (!/^[0-9a-f-]{36}$/iu.test(treasureId)) throw new TreasureError("TREASURE_NOT_FOUND", "There is nothing buried there.", 404);
    return this.transaction(async (client) => {
      await lockPlayer(client, playerId);
      const prior = await priorOperation(client, playerId, requestId, "dig");
      if (prior) {
        const stored = prior.result as StoredDig;
        return { ...stored, replayed: true, message: digMessage(stored) };
      }
      const cartographyRank = await tradeSkillRank(client, playerId, "cartography");
      const located = await client.query<{
        tier: string; status: string; expired: boolean; reachable: boolean;
      }>(
        `SELECT tier, status, expires_at <= clock_timestamp() AS expired,
                ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, $4) AS reachable
         FROM buried_treasures WHERE treasure_id=$1::uuid FOR UPDATE`,
        [treasureId, position.lat, position.lon, TREASURE_DIG_RADIUS_M]
      );
      const row = located.rows[0];
      // A tier the digger cannot see is indistinguishable from a cache that is not there.
      if (!row || !isTreasureTier(row.tier) || !treasureTierVisible(row.tier, cartographyRank)) {
        throw new TreasureError("TREASURE_NOT_FOUND", "There is nothing buried there.", 404);
      }
      const tier = row.tier;
      if (row.status !== "buried" || row.expired) {
        throw new TreasureError("TREASURE_GONE", "That cache was already dug up or has been lost to time.", 409);
      }
      if (!row.reachable) {
        throw new TreasureError("TREASURE_OUT_OF_RANGE", `Move within ${TREASURE_DIG_RADIUS_M} m of the cache to dig.`, 409);
      }

      if (await shovelCount(client, playerId) < 1) {
        throw new TreasureError("TREASURE_SHOVEL_REQUIRED", "You need a Shovel to dig.", 409);
      }
      await client.query(
        "INSERT INTO player_shovel_wear (player_id, uses_on_current) VALUES ($1, 0) ON CONFLICT (player_id) DO NOTHING",
        [playerId]
      );
      const worn = await client.query<{ uses_on_current: number }>(
        "SELECT uses_on_current FROM player_shovel_wear WHERE player_id=$1 FOR UPDATE",
        [playerId]
      );
      const used = Number(worn.rows[0]?.uses_on_current ?? 0) + 1;
      const shovelBroke = used >= SHOVEL_MAX_USES;

      const rewards = rollTreasureRewards(tier, treasureId, sha256Bytes);
      try {
        if (shovelBroke) {
          await this.inventory.debitItemsForOperationInTransaction(client, {
            operationKey: `buried-treasure-shovel:${treasureId}`,
            playerId,
            source: "buried_treasure_shovel_worn",
            sourceEntityType: "buried_treasure",
            sourceEntityId: treasureId,
            metadata: { requestId },
            debits: [{ itemId: SHOVEL_ITEM_ID, variant: null, quantity: 1 }]
          });
        }
        await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `buried-treasure:${treasureId}`,
          playerId,
          source: "buried_treasure_dig",
          sourceEntityType: "buried_treasure",
          sourceEntityId: treasureId,
          metadata: { requestId, tier },
          grants: rewards.items.map((item) => ({ itemId: item.itemId as ResourceType, variant: null, quantity: item.quantity }))
        });
        if (rewards.ring) {
          await this.equipment.grantPackageInstancesInTransaction(client, {
            operationKey: `buried-treasure-ring:${treasureId}`,
            playerId,
            grants: [{ definitionId: rewards.ring, quantity: 1 }]
          });
        }
      } catch (error) {
        if (isInventoryCapacityError(error) || (error as { code?: unknown })?.code === "EQUIPMENT_INVENTORY_FULL") {
          throw new TreasureError("TREASURE_PACK_FULL", "Your pack is too full to carry what is buried here. Make room and dig again.", 409);
        }
        throw error;
      }

      await client.query(
        "UPDATE player_shovel_wear SET uses_on_current=$2, updated_at=clock_timestamp() WHERE player_id=$1",
        [playerId, shovelBroke ? 0 : used]
      );
      await client.query(
        `UPDATE buried_treasures
         SET status='dug', dug_by_player_id=$2, dug_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE treasure_id=$1::uuid`,
        [treasureId, playerId]
      );
      const stored: StoredDig = {
        treasureId,
        tier,
        items: rewards.items,
        ring: rewards.ring,
        shovelBroke,
        shovelUsesRemaining: shovelBroke ? null : SHOVEL_MAX_USES - used
      };
      await recordOperation(client, `buried-treasure-dig:${treasureId}`, playerId, requestId, "dig", treasureId, tier, stored);
      return { ...stored, replayed: false, message: digMessage(stored) };
    });
  }

  /** Marks lost caches expired and forgets finished ones after a few days (cleanup only; reads check the clock). */
  async expireFinished(): Promise<number> {
    const expired = await this.pool.query(
      "UPDATE buried_treasures SET status='expired', updated_at=clock_timestamp() WHERE status='buried' AND expires_at <= clock_timestamp()"
    );
    await this.pool.query(
      "DELETE FROM buried_treasures WHERE status IN ('expired','dug') AND updated_at < clock_timestamp() - interval '3 days'"
    );
    return expired.rowCount ?? 0;
  }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function playerLevel(queryable: Pick<pg.Pool, "query">, playerId: string): Promise<number> {
  const result = await queryable.query<{ total_xp: number; level: number }>(
    "SELECT total_xp, level FROM player_progression_profiles WHERE player_id=$1",
    [playerId]
  );
  return paidCharacterLevel(Number(result.rows[0]?.total_xp ?? 0), result.rows[0]?.level);
}

async function shovelCount(queryable: Pick<pg.Pool, "query">, playerId: string): Promise<number> {
  const result = await queryable.query<{ quantity: string }>(
    "SELECT COALESCE(sum(quantity),0)::text AS quantity FROM player_inventory WHERE player_id=$1 AND resource_type=$2",
    [playerId, SHOVEL_ITEM_ID]
  );
  return Number(result.rows[0]?.quantity ?? 0);
}

async function lockPlayer(client: pg.PoolClient, playerId: string): Promise<void> {
  const locked = await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [playerId]);
  if (!locked.rowCount) throw new TreasureError("TREASURE_PLAYER_REQUIRED", "Player onboarding is required.", 401);
}

async function priorOperation(
  client: pg.PoolClient,
  playerId: string,
  requestId: string,
  action: "dig" | "artisan_shovel"
): Promise<{ result: unknown } | null> {
  const prior = await client.query<{ action: string; result: unknown }>(
    "SELECT action, result FROM buried_treasure_operations WHERE player_id=$1 AND request_id=$2",
    [playerId, requestId]
  );
  const row = prior.rows[0];
  if (!row) return null;
  if (row.action !== action) {
    throw new TreasureError("TREASURE_REPLAY_CONFLICT", "That request id was already used for a different action.", 409);
  }
  return row;
}

async function recordOperation(
  client: pg.PoolClient,
  operationKey: string,
  playerId: string,
  requestId: string,
  action: "dig" | "artisan_shovel",
  treasureId: string | null,
  tier: TreasureTier | null,
  result: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO buried_treasure_operations (operation_key, player_id, request_id, action, treasure_id, tier, result)
     VALUES ($1,$2,$3,$4,$5::uuid,$6,$7::jsonb)`,
    [operationKey, playerId, requestId, action, treasureId, tier, JSON.stringify(result)]
  );
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export type TreasureLandResult = Readonly<{ land: boolean; label: string | null }>;

export type TreasureRuntimeDependencies = Readonly<{
  pool: Pick<pg.Pool, "query">;
  /** Players standing on the world map, with their live positions. */
  playerPositions(): ReadonlyArray<Readonly<{ playerId: string; lat: number; lon: number }>>;
  /** Land check (and a real-world place name) for candidate points; fail closed on any lookup trouble. */
  lookupLand(points: readonly LatLon[]): Promise<readonly TreasureLandResult[]>;
  expireFinished?(): Promise<number>;
  now?: () => number;
  random?: () => number;
}>;

const SPAWN_INTERVAL_MS = 45_000;
const SPAWN_PLAYERS_PER_PASS = 8;
const SPAWN_ATTEMPTS = 4;
const EXPIRE_INTERVAL_MS = 5 * 60_000;

/**
 * Buries caches near active players: bounded per area and tier, with a global
 * ceiling. Silver and gold lean toward an in-game landmark (city, Atlas Shrine,
 * Hollin hut, kingdom seat) so a gold cache reads as "buried near somewhere".
 */
export class TreasureRuntime {
  private lastSpawnAt = 0;
  private lastExpireAt = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: TreasureRuntimeDependencies) {}

  tick(): void {
    const now = this.now();
    if (!this.running && now - this.lastSpawnAt >= SPAWN_INTERVAL_MS) {
      this.lastSpawnAt = now;
      this.running = this.spawnPass().then(() => undefined, () => undefined).finally(() => { this.running = null; });
    }
    if (this.deps.expireFinished && now - this.lastExpireAt >= EXPIRE_INTERVAL_MS) {
      this.lastExpireAt = now;
      void this.deps.expireFinished().catch(() => undefined);
    }
  }

  async spawnPass(): Promise<number> {
    const players = [...this.deps.playerPositions()];
    for (let index = players.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(this.random() * (index + 1));
      [players[index], players[swap]] = [players[swap]!, players[index]!];
    }
    let spawned = 0;
    for (const player of players.slice(0, SPAWN_PLAYERS_PER_PASS)) {
      if (await this.spawnNear(player)) spawned += 1;
    }
    return spawned;
  }

  /** Buries at most one cache near `position`; returns its id or null (capped, no land, unlucky). */
  async spawnNear(position: LatLon): Promise<string | null> {
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lon)) return null;
    const counts = await this.deps.pool.query<{ tier: string; count: string; global_count: string }>(
      `SELECT t.tier, count(*)::text AS count,
              (SELECT count(*) FROM buried_treasures WHERE status='buried' AND expires_at > clock_timestamp())::text AS global_count
       FROM buried_treasures t
       WHERE t.status='buried' AND t.expires_at > clock_timestamp()
         AND ST_DWithin(t.geom::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
       GROUP BY t.tier`,
      [position.lat, position.lon, TREASURE_AREA_RADIUS_M]
    );
    const perTier = new Map(counts.rows.map((row) => [row.tier, Number(row.count)]));
    const total = [...perTier.values()].reduce((sum, value) => sum + value, 0);
    const globalCount = Number(counts.rows[0]?.global_count ?? (await this.globalCount()));
    if (total >= TREASURE_AREA_TOTAL_CAP || globalCount >= TREASURE_GLOBAL_CAP) return null;
    const open = TREASURE_TIERS.filter((tier) => (perTier.get(tier) ?? 0) < TREASURE_AREA_CAPS[tier]);
    if (open.length === 0) return null;
    const tier = this.pickTier(open);

    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt += 1) {
      const landmark = tier === "bronze" ? null : await this.pickLandmark(position);
      const candidate = landmark
        ? destinationPoint(
            landmark,
            TREASURE_LANDMARK_MIN_OFFSET_M + this.random() * (TREASURE_LANDMARK_MAX_OFFSET_M - TREASURE_LANDMARK_MIN_OFFSET_M),
            this.random() * 360
          )
        : destinationPoint(
            position,
            TREASURE_SPAWN_MIN_DISTANCE_M + this.random() * (TREASURE_SPAWN_MAX_DISTANCE_M - TREASURE_SPAWN_MIN_DISTANCE_M),
            this.random() * 360
          );
      const crowded = await this.deps.pool.query(
        `SELECT 1 FROM buried_treasures
         WHERE status='buried' AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
         LIMIT 1`,
        [candidate.lat, candidate.lon, TREASURE_MIN_SPACING_M]
      );
      if (crowded.rowCount) continue;
      const [land] = await this.deps.lookupLand([candidate]);
      if (!land?.land) continue;
      const treasureId = randomUUID();
      await this.deps.pool.query(
        `INSERT INTO buried_treasures (treasure_id, tier, geom, place_label, landmark_kind, spawned_at, expires_at)
         VALUES ($1::uuid, $2, ST_SetSRID(ST_MakePoint($4,$3),4326), $5, $6,
                 clock_timestamp(), clock_timestamp() + ($7::bigint * interval '1 millisecond'))`,
        [treasureId, tier, candidate.lat, candidate.lon, land.label?.slice(0, 160) || null, landmark?.kind ?? null, TREASURE_LIFETIME_MS[tier]]
      );
      return treasureId;
    }
    return null;
  }

  private async globalCount(): Promise<number> {
    const result = await this.deps.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM buried_treasures WHERE status='buried' AND expires_at > clock_timestamp()"
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private pickTier(open: readonly TreasureTier[]): TreasureTier {
    const total = open.reduce((sum, tier) => sum + TREASURE_SPAWN_WEIGHTS[tier], 0);
    let pick = this.random() * total;
    return open.find((tier) => (pick -= TREASURE_SPAWN_WEIGHTS[tier]) < 0) ?? open[open.length - 1]!;
  }

  private async pickLandmark(position: LatLon): Promise<(LatLon & { kind: TreasureLandmarkKind }) | null> {
    const result = await this.deps.pool.query<{ kind: string; lat: number; lon: number }>(
      `SELECT l.kind, l.lat, l.lon FROM (
         SELECT 'city'::text AS kind, hall_lat AS lat, hall_lon AS lon FROM cities WHERE active
         UNION ALL SELECT 'kingdom_seat', lat, lon FROM kingdom_seats WHERE status='active'
         UNION ALL SELECT 'atlas_shrine', lat, lon FROM flags WHERE atlas_shrine_slot_number IS NOT NULL
         UNION ALL SELECT 'hollin_hut', lat, lon FROM hollin_huts WHERE state='standing'
       ) l
       WHERE ST_DWithin(ST_SetSRID(ST_MakePoint(l.lon,l.lat),4326)::geography,
                        ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
       ORDER BY random() LIMIT 1`,
      [position.lat, position.lon, TREASURE_LANDMARK_SEARCH_M]
    );
    const row = result.rows[0];
    return row ? { kind: row.kind as TreasureLandmarkKind, lat: Number(row.lat), lon: Number(row.lon) } : null;
  }

  private random(): number {
    return (this.deps.random ?? Math.random)();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
