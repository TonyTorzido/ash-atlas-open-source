import { createHash, randomUUID } from "node:crypto";

import {
  MONOLITH_BERSERKER_ATTACK_BONUS,
  MONOLITH_BUILD_SPARKS,
  MONOLITH_BURN_MS,
  MONOLITH_DISPLAY_NAMES,
  MONOLITH_HEALER_HEAL_FRACTION,
  MONOLITH_HEALER_TICK_MS,
  MONOLITH_IGNITE_ITEM_ID,
  MONOLITH_IGNITE_QUANTITY,
  MONOLITH_INERT_TYPES,
  MONOLITH_INTERACTION_RADIUS_M,
  MONOLITH_LIFETIME_MS,
  MONOLITH_RANGE_RADIUS_M,
  MONOLITH_RECHARGE_SPARKS,
  MONOLITH_REMNANT_MS,
  MONOLITH_REQUIRED_RANK,
  MONOLITH_SKILL_ID,
  MONOLITH_SPARK_ITEM_ID,
  distanceMeters,
  isMonolithType,
  monolithAllied,
  monolithBuildingDamage,
  monolithEffective,
  monolithHunterBonusPercent,
  monolithHunterYield,
  monolithPhase,
  type MonolithAllegiance,
  type MonolithSnapshot,
  type MonolithStateSnapshot,
  type MonolithType,
  type ResourceType
} from "@ash-atlas/shared";
import type pg from "pg";

import { FractionalHealCarry, nextBeatDueAt } from "./fractionalHeal.js";
import type { InventoryService } from "./inventory.js";
import type { OfferingInventory } from "./skills/skillOfferings.js";
import {
  attackingOrganization,
  forcedPeaceRefusalInTransaction,
  loadPlayerOrganizations
} from "./warStructures.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;
type LatLon = Readonly<{ lat: number; lon: number }>;

/** Nearby list radius: far enough to see a monolith's whole range from its edge. */
export const MONOLITH_NEARBY_RADIUS_M = 3_000;

export class MonolithError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "MonolithError";
  }
}

type MonolithInventory = Pick<InventoryService, "debitItemsForOperationInTransaction"> & OfferingInventory;

type MonolithRow = {
  monolith_id: string;
  monolith_type: string;
  owner_player_id: string;
  owner_name: string | null;
  lat: number;
  lon: number;
  placed_at: Date;
  expires_at: Date;
  remnant_until: Date;
  burn_until: Date | null;
  status: string;
};

function times(row: Pick<MonolithRow, "expires_at" | "remnant_until" | "burn_until">) {
  return {
    expiresAtMs: new Date(row.expires_at).getTime(),
    remnantUntilMs: new Date(row.remnant_until).getTime(),
    burnUntilMs: row.burn_until ? new Date(row.burn_until).getTime() : null
  };
}

function requireRequestId(requestId: unknown): asserts requestId is string {
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 128) {
    throw new MonolithError("MONOLITH_REQUEST_INVALID", "A request id is required.");
  }
}

function requirePosition(position: LatLon | null | undefined): asserts position is LatLon {
  if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)) {
    throw new MonolithError("MONOLITH_POSITION_REQUIRED", "Connect to the game world first.", 409);
  }
}

/** Field Engineering rank (0 when undiscovered or unranked). */
export async function fieldEngineeringRank(queryable: Queryable, playerId: string): Promise<number> {
  const result = await queryable.query<{ rank: number }>(
    "SELECT rank FROM player_skill_ranks WHERE player_id=$1 AND skill_id=$2",
    [playerId, MONOLITH_SKILL_ID]
  );
  return Number(result.rows[0]?.rank ?? 0);
}

/**
 * True when an effective monolith of `type` within range of `position`
 * belongs to an ally of the beneficiary (same player, or the owner's
 * current city / kingdom). Read-only; safe inside any transaction.
 */
export async function allyMonolithInRange(
  queryable: Queryable,
  type: MonolithType,
  position: LatLon,
  beneficiary: Readonly<{ playerId: string | null; cityId: string | null; kingdomId: string | null }>
): Promise<boolean> {
  if (!Number.isFinite(position.lat) || !Number.isFinite(position.lon)) return false;
  if (!beneficiary.playerId && !beneficiary.cityId && !beneficiary.kingdomId) return false;
  const result = await queryable.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM war_monoliths m
       WHERE m.status='standing' AND m.monolith_type=$1
         AND m.expires_at > clock_timestamp()
         AND (m.burn_until IS NULL OR m.burn_until > clock_timestamp())
         AND ST_DWithin(m.geom::geography, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, $4)
         AND (
           m.owner_player_id = $5
           OR ($6::uuid IS NOT NULL AND EXISTS (
             SELECT 1 FROM city_memberships cm
             JOIN cities c ON c.id=cm.city_id AND c.active
             WHERE cm.player_id=m.owner_player_id AND cm.left_at IS NULL AND cm.city_id=$6::uuid))
           OR ($7::uuid IS NOT NULL AND EXISTS (
             SELECT 1 FROM kingdom_memberships km
             JOIN kingdoms k ON k.id=km.kingdom_id AND k.status='active'
             WHERE km.player_id=m.owner_player_id AND km.status='active' AND km.kingdom_id=$7::uuid))
         )
     ) AS found`,
    [type, position.lat, position.lon, MONOLITH_RANGE_RADIUS_M,
      beneficiary.playerId, beneficiary.cityId, beneficiary.kingdomId]
  );
  return Boolean(result.rows[0]?.found);
}

/**
 * Building damage after monoliths: Frenzy near the attacking Siege's
 * owner side (+30%), Fortified near the target's side (x0.55). Bombers pass
 * `attacker: null` (Frenzy boosts Sieges only).
 */
export async function monolithAdjustedBuildingDamage(
  queryable: Queryable,
  baseDamage: number,
  input: Readonly<{
    attacker: Readonly<{ playerId: string; position: LatLon }> | null;
    target: Readonly<{ lat: number; lon: number; owner_id?: string | null; city_id: string | null; kingdom_id: string | null }>;
  }>
): Promise<number> {
  if (!(baseDamage > 0)) return baseDamage;
  const berserker = input.attacker
    ? await allyMonolithInRange(queryable, "berserker", input.attacker.position, {
        playerId: input.attacker.playerId,
        ...(await loadPlayerOrganizations(queryable, input.attacker.playerId))
      })
    : false;
  const fortified = await allyMonolithInRange(
    queryable,
    "fortified",
    { lat: Number(input.target.lat), lon: Number(input.target.lon) },
    {
      playerId: input.target.owner_id ?? null,
      cityId: input.target.city_id === null ? null : String(input.target.city_id),
      kingdomId: input.target.kingdom_id === null ? null : String(input.target.kingdom_id)
    }
  );
  if (!berserker && !fortified) return baseDamage;
  return monolithBuildingDamage(baseDamage, { berserker, fortified });
}

function hunterRoll(rollKey: string): number {
  const digest = createHash("sha256").update(`monolith-hunter-v1:${rollKey}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Hunter monolith yield for Bricks / City Coins earned at `position`: the
 * base quantity when no allied Hunter is in range. Deterministic per
 * `rollKey`, so a retried settlement pays the same.
 */
export async function monolithHunterQuantity(
  queryable: Queryable,
  input: Readonly<{ playerId: string; position: LatLon; quantity: number; rollKey: string }>
): Promise<number> {
  if (!(input.quantity > 0)) return input.quantity;
  const organizations = await loadPlayerOrganizations(queryable, input.playerId);
  const hunter = await allyMonolithInRange(queryable, "hunter", input.position, {
    playerId: input.playerId,
    ...organizations
  });
  if (!hunter) return input.quantity;
  const rank = await fieldEngineeringRank(queryable, input.playerId);
  return monolithHunterYield(input.quantity, monolithHunterBonusPercent(rank), hunterRoll(input.rollKey));
}

type PriorOperation = { action: string; monolith_id: string };

export type MonolithMutationResult = Readonly<{
  monolithId: string | null;
  replayed: boolean;
  message: string;
}>;

/**
 * Server authority for placing, recharging and igniting monoliths and for
 * discovering Field Engineering. Lock order: the actor's player row, then
 * the monolith row, then the inventory (inside the debit).
 */
export class MonolithService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: MonolithInventory
  ) {}

  async state(playerId: string, position: LatLon | null): Promise<MonolithStateSnapshot> {
    const [skill, items, clock] = await Promise.all([
      this.pool.query<{ discovered: boolean; rank: number | null }>(
        `SELECT EXISTS (SELECT 1 FROM player_skill_world_unlocks WHERE player_id=$1 AND skill_id=$2) AS discovered,
                (SELECT rank FROM player_skill_ranks WHERE player_id=$1 AND skill_id=$2) AS rank`,
        [playerId, MONOLITH_SKILL_ID]
      ),
      this.pool.query<{ item_id: string; quantity: string }>(
        `SELECT resource_type AS item_id, COALESCE(sum(quantity),0)::text AS quantity
         FROM player_inventory WHERE player_id=$1 AND resource_type = ANY($2::text[])
         GROUP BY resource_type`,
        [playerId, [MONOLITH_SPARK_ITEM_ID, MONOLITH_IGNITE_ITEM_ID]]
      ),
      this.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ]);
    const now = new Date(clock.rows[0]!.now).getTime();
    const count = (itemId: string) => Number(items.rows.find((row) => row.item_id === itemId)?.quantity ?? 0);
    let monoliths: MonolithSnapshot[] = [];
    if (position && Number.isFinite(position.lat) && Number.isFinite(position.lon)) {
      const rows = await this.pool.query<MonolithRow>(
        `SELECT m.monolith_id::text, m.monolith_type, m.owner_player_id, p.username AS owner_name,
                ST_Y(m.geom) AS lat, ST_X(m.geom) AS lon,
                m.placed_at, m.expires_at, m.remnant_until, m.burn_until, m.status
         FROM war_monoliths m
         LEFT JOIN players p ON p.id = m.owner_player_id
         WHERE m.status='standing'
           AND m.remnant_until > clock_timestamp()
           AND (m.burn_until IS NULL OR m.burn_until > clock_timestamp())
           AND ST_DWithin(m.geom::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
         ORDER BY m.placed_at, m.monolith_id
         LIMIT 100`,
        [position.lat, position.lon, MONOLITH_NEARBY_RADIUS_M]
      );
      const viewer: MonolithAllegiance = { playerId, ...(await loadPlayerOrganizations(this.pool, playerId)) };
      const ownerOrganizations = new Map<string, MonolithAllegiance>();
      for (const row of rows.rows) {
        if (!ownerOrganizations.has(row.owner_player_id)) {
          ownerOrganizations.set(row.owner_player_id, {
            playerId: row.owner_player_id,
            ...(await loadPlayerOrganizations(this.pool, row.owner_player_id))
          });
        }
      }
      monoliths = rows.rows.filter((row) => isMonolithType(row.monolith_type)).map((row) => {
        const type = row.monolith_type as MonolithType;
        const point = { lat: Number(row.lat), lon: Number(row.lon) };
        return {
          id: row.monolith_id,
          type,
          ownerPlayerId: row.owner_player_id,
          ownerName: row.owner_name ?? "Unknown",
          lat: point.lat,
          lon: point.lon,
          rangeRadiusM: MONOLITH_RANGE_RADIUS_M,
          placedAt: new Date(row.placed_at).toISOString(),
          expiresAt: new Date(row.expires_at).toISOString(),
          remnantUntil: new Date(row.remnant_until).toISOString(),
          burnUntil: row.burn_until ? new Date(row.burn_until).toISOString() : null,
          phase: monolithPhase(times(row), now),
          allied: monolithAllied(ownerOrganizations.get(row.owner_player_id)!, viewer),
          own: row.owner_player_id === playerId,
          inert: MONOLITH_INERT_TYPES.has(type),
          distanceM: Math.round(distanceMeters(position, point))
        };
      });
    }
    return {
      serverTime: new Date(now).toISOString(),
      skill: { discovered: Boolean(skill.rows[0]?.discovered), rank: Number(skill.rows[0]?.rank ?? 0) },
      sparks: count(MONOLITH_SPARK_ITEM_ID),
      crudeOil: count(MONOLITH_IGNITE_ITEM_ID),
      monoliths
    };
  }

  async place(playerId: string, position: LatLon | null, type: unknown, requestId: string): Promise<MonolithMutationResult> {
    requireRequestId(requestId);
    if (!isMonolithType(type)) throw new MonolithError("MONOLITH_TYPE_INVALID", "Unknown monolith type.");
    requirePosition(position);
    return this.transaction(async (client) => {
      const prior = await priorOperation(client, playerId, requestId, "place");
      if (prior) return { monolithId: prior.monolith_id, replayed: true, message: `${MONOLITH_DISPLAY_NAMES[type]} placed.` };
      await lockPlayer(client, playerId);
      const rank = await fieldEngineeringRank(client, playerId);
      const required = MONOLITH_REQUIRED_RANK[type];
      if (rank < required) {
        throw new MonolithError(
          "MONOLITH_RANK_REQUIRED",
          `${MONOLITH_DISPLAY_NAMES[type]} needs Field Engineering rank ${required}.`,
          403
        );
      }
      // Finished monoliths retire; a remnant of the same type is replaced.
      await client.query(
        `UPDATE war_monoliths
         SET status='retired', retired_at=clock_timestamp(), updated_at=clock_timestamp(),
             retired_reason = CASE
               WHEN burn_until IS NOT NULL AND burn_until <= clock_timestamp() THEN 'burnt'
               WHEN remnant_until <= clock_timestamp() THEN 'expired'
               ELSE 'replaced' END
         WHERE owner_player_id=$1 AND monolith_type=$2 AND status='standing'
           AND (expires_at <= clock_timestamp() OR (burn_until IS NOT NULL AND burn_until <= clock_timestamp()))`,
        [playerId, type]
      );
      const standing = await client.query(
        "SELECT 1 FROM war_monoliths WHERE owner_player_id=$1 AND monolith_type=$2 AND status='standing'",
        [playerId, type]
      );
      if (standing.rowCount) {
        throw new MonolithError("MONOLITH_ALREADY_STANDING", `Your ${MONOLITH_DISPLAY_NAMES[type]} is still standing.`, 409);
      }
      const monolithId = randomUUID();
      const operationKey = `war-monolith:${playerId}:${requestId}`;
      await this.debit(client, playerId, operationKey, monolithId, "place", MONOLITH_SPARK_ITEM_ID, MONOLITH_BUILD_SPARKS);
      await client.query(
        `INSERT INTO war_monoliths (
           monolith_id, owner_player_id, monolith_type, owner_rank, geom,
           placed_at, expires_at, remnant_until
         ) VALUES (
           $1::uuid, $2, $3, $4, ST_SetSRID(ST_MakePoint($6,$5),4326),
           clock_timestamp(),
           clock_timestamp() + ($7::bigint * interval '1 millisecond'),
           clock_timestamp() + ($8::bigint * interval '1 millisecond')
         )`,
        [monolithId, playerId, type, Math.min(3, rank), position.lat, position.lon,
          MONOLITH_LIFETIME_MS, MONOLITH_LIFETIME_MS + MONOLITH_REMNANT_MS]
      );
      await recordOperation(client, operationKey, playerId, requestId, "place", monolithId, type,
        MONOLITH_SPARK_ITEM_ID, MONOLITH_BUILD_SPARKS);
      return { monolithId, replayed: false, message: `${MONOLITH_DISPLAY_NAMES[type]} placed. It stands for 20 hours.` };
    });
  }

  /** Owner or ally, within reach, not burning: 2 Sparks restart the 20 h life. */
  async recharge(playerId: string, position: LatLon | null, monolithId: string, requestId: string): Promise<MonolithMutationResult> {
    requireRequestId(requestId);
    requirePosition(position);
    return this.transaction(async (client) => {
      const prior = await priorOperation(client, playerId, requestId, "recharge");
      if (prior) return { monolithId: prior.monolith_id, replayed: true, message: "Monolith recharged." };
      await lockPlayer(client, playerId);
      const { row, type, phase } = await lockReachableMonolith(client, monolithId, position);
      if (phase === "gone") throw new MonolithError("MONOLITH_GONE", "That monolith is gone.", 409);
      if (phase === "burning") throw new MonolithError("MONOLITH_BURNING", "A burning monolith cannot be recharged.", 409);
      const owner = { playerId: row.owner_player_id, ...(await loadPlayerOrganizations(client, row.owner_player_id)) };
      const actor = { playerId, ...(await loadPlayerOrganizations(client, playerId)) };
      if (!monolithAllied(owner, actor)) {
        throw new MonolithError("MONOLITH_NOT_ALLIED", "Only the owner and their allies can recharge a monolith.", 403);
      }
      const operationKey = `war-monolith:${playerId}:${requestId}`;
      await this.debit(client, playerId, operationKey, monolithId, "recharge", MONOLITH_SPARK_ITEM_ID, MONOLITH_RECHARGE_SPARKS);
      await client.query(
        `UPDATE war_monoliths
         SET expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
             remnant_until = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             recharge_count = recharge_count + 1,
             updated_at = clock_timestamp()
         WHERE monolith_id=$1::uuid`,
        [monolithId, MONOLITH_LIFETIME_MS, MONOLITH_LIFETIME_MS + MONOLITH_REMNANT_MS]
      );
      await recordOperation(client, operationKey, playerId, requestId, "recharge", monolithId, type,
        MONOLITH_SPARK_ITEM_ID, MONOLITH_RECHARGE_SPARKS);
      return { monolithId, replayed: false, message: `${MONOLITH_DISPLAY_NAMES[type]} recharged for another 20 hours.` };
    });
  }

  /** Enemies only, within reach: 25 crude oil sets it burning; it is gone in 1 hour. */
  async ignite(playerId: string, position: LatLon | null, monolithId: string, requestId: string): Promise<MonolithMutationResult> {
    requireRequestId(requestId);
    requirePosition(position);
    return this.transaction(async (client) => {
      const prior = await priorOperation(client, playerId, requestId, "ignite");
      if (prior) return { monolithId: prior.monolith_id, replayed: true, message: "Monolith ignited." };
      await lockPlayer(client, playerId);
      const { row, type, phase } = await lockReachableMonolith(client, monolithId, position);
      if (phase === "gone") throw new MonolithError("MONOLITH_GONE", "That monolith is gone.", 409);
      if (phase === "burning") throw new MonolithError("MONOLITH_BURNING", "That monolith is already burning.", 409);
      const ownerOrganizations = await loadPlayerOrganizations(client, row.owner_player_id);
      const owner = { playerId: row.owner_player_id, ...ownerOrganizations };
      const actor = { playerId, ...(await loadPlayerOrganizations(client, playerId)) };
      if (monolithAllied(owner, actor)) {
        throw new MonolithError("MONOLITH_ALLIED", "You cannot ignite your own or an ally's monolith.", 403);
      }
      const defender = attackingOrganization(ownerOrganizations);
      const peace = defender ? await forcedPeaceRefusalInTransaction(client, playerId, defender) : null;
      if (peace) throw new MonolithError("MONOLITH_FORCED_PEACE", peace, 409);
      const operationKey = `war-monolith:${playerId}:${requestId}`;
      await this.debit(client, playerId, operationKey, monolithId, "ignite", MONOLITH_IGNITE_ITEM_ID, MONOLITH_IGNITE_QUANTITY);
      await client.query(
        `UPDATE war_monoliths
         SET burn_until = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
             ignited_by_player_id = $3,
             updated_at = clock_timestamp()
         WHERE monolith_id=$1::uuid`,
        [monolithId, MONOLITH_BURN_MS, playerId]
      );
      await recordOperation(client, operationKey, playerId, requestId, "ignite", monolithId, type,
        MONOLITH_IGNITE_ITEM_ID, MONOLITH_IGNITE_QUANTITY);
      return { monolithId, replayed: false, message: `${MONOLITH_DISPLAY_NAMES[type]} is burning. It falls in 1 hour.` };
    });
  }

  /** Retires burnt-out and fully expired monoliths (cleanup only; effects read the timestamps). */
  async retireFinished(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE war_monoliths
       SET status='retired', retired_at=clock_timestamp(), updated_at=clock_timestamp(),
           retired_reason = CASE WHEN burn_until IS NOT NULL AND burn_until <= clock_timestamp() THEN 'burnt' ELSE 'expired' END
       WHERE status='standing'
         AND (remnant_until <= clock_timestamp() OR (burn_until IS NOT NULL AND burn_until <= clock_timestamp()))`
    );
    return result.rowCount ?? 0;
  }

  private async debit(
    client: pg.PoolClient,
    playerId: string,
    operationKey: string,
    monolithId: string,
    action: "place" | "recharge" | "ignite",
    itemId: string,
    quantity: number
  ): Promise<void> {
    try {
      await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey,
        playerId,
        source: `war_monolith_${action}`,
        sourceEntityType: "war_monolith",
        sourceEntityId: monolithId,
        metadata: { action },
        debits: [{ itemId: itemId as ResourceType, variant: null, quantity }]
      });
    } catch (error) {
      if (error instanceof Error && /enough items/iu.test(error.message)) {
        const name = itemId === MONOLITH_IGNITE_ITEM_ID ? "Crude Oil" : "Crystal";
        throw new MonolithError("MONOLITH_MATERIALS_REQUIRED", `You need ${quantity} ${name}.`, 409);
      }
      throw error;
    }
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

async function lockPlayer(client: pg.PoolClient, playerId: string): Promise<void> {
  const locked = await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [playerId]);
  if (!locked.rowCount) throw new MonolithError("MONOLITH_PLAYER_REQUIRED", "Player onboarding is required.", 401);
}

async function priorOperation(
  client: pg.PoolClient,
  playerId: string,
  requestId: string,
  action: string
): Promise<PriorOperation | null> {
  const prior = await client.query<PriorOperation>(
    "SELECT action, monolith_id::text FROM war_monolith_operations WHERE player_id=$1 AND request_id=$2",
    [playerId, requestId]
  );
  const row = prior.rows[0];
  if (!row) return null;
  if (row.action !== action) {
    throw new MonolithError("MONOLITH_REPLAY_CONFLICT", "That request id was already used for a different action.", 409);
  }
  return row;
}

async function recordOperation(
  client: pg.PoolClient,
  operationKey: string,
  playerId: string,
  requestId: string,
  action: "place" | "recharge" | "ignite",
  monolithId: string,
  type: MonolithType,
  itemId: string,
  quantity: number
): Promise<void> {
  await client.query(
    `INSERT INTO war_monolith_operations (
       operation_key, player_id, request_id, action, monolith_id, monolith_type, item_id, item_quantity
     ) VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8)`,
    [operationKey, playerId, requestId, action, monolithId, type, itemId, quantity]
  );
}

async function lockReachableMonolith(
  client: pg.PoolClient,
  monolithId: string,
  position: LatLon
): Promise<{ row: MonolithRow; type: MonolithType; phase: ReturnType<typeof monolithPhase> }> {
  if (!/^[0-9a-f-]{36}$/iu.test(monolithId)) throw new MonolithError("MONOLITH_NOT_FOUND", "That monolith is gone.", 404);
  const locked = await client.query<MonolithRow & { now: Date; reachable: boolean }>(
    `SELECT monolith_id::text, monolith_type, owner_player_id, NULL::text AS owner_name,
            ST_Y(geom) AS lat, ST_X(geom) AS lon, placed_at, expires_at, remnant_until, burn_until, status,
            clock_timestamp() AS now,
            ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, $4) AS reachable
     FROM war_monoliths WHERE monolith_id=$1::uuid FOR UPDATE`,
    [monolithId, position.lat, position.lon, MONOLITH_INTERACTION_RADIUS_M]
  );
  const row = locked.rows[0];
  if (!row || row.status !== "standing" || !isMonolithType(row.monolith_type)) {
    throw new MonolithError("MONOLITH_NOT_FOUND", "That monolith is gone.", 404);
  }
  if (!row.reachable) {
    throw new MonolithError("MONOLITH_OUT_OF_RANGE", `Move within ${MONOLITH_INTERACTION_RADIUS_M} m of the monolith.`, 409);
  }
  return { row, type: row.monolith_type, phase: monolithPhase(times(row), new Date(row.now).getTime()) };
}

type RuntimeMonolith = Readonly<{
  type: MonolithType;
  lat: number;
  lon: number;
  owner: MonolithAllegiance;
  expiresAtMs: number;
  remnantUntilMs: number;
  burnUntilMs: number | null;
}>;

type RuntimeEntity = Readonly<{ lat: number; lon: number; maxHealth: number; currentHealth: number; lifeState: string }>;

export type MonolithRuntimeDependencies = Readonly<{
  pool: pg.Pool;
  activePlayerIds(): readonly string[];
  combat: Readonly<{
    entity(entityId: string): RuntimeEntity | null;
    healEntity(entityId: string, amount: number, sourceEntityId?: string): number;
  }>;
  /** False while the player is inside a dungeon (monoliths stand on the world map). */
  onWorldMap(playerId: string): boolean;
  retireFinished?(): Promise<number>;
  now?: () => number;
}>;

const RUNTIME_REFRESH_MS = 5_000;
const RUNTIME_RETIRE_MS = 60_000;

/**
 * Synchronous monolith effects for the game loop: the Frenzy attack
 * aura (read by the combat engine) and the Healer heal tick. Effective
 * Frenzy / Healer monoliths and the active players' memberships are
 * cached and refreshed every few seconds.
 */
export class MonolithRuntime {
  private monoliths: readonly RuntimeMonolith[] = [];
  private allegiances = new Map<string, MonolithAllegiance>();
  private refreshing: Promise<void> | null = null;
  private lastRefreshAt = 0;
  private lastRetireAt = 0;
  private lastHealAt = 0;
  private readonly healCarry = new FractionalHealCarry();

  constructor(private readonly deps: MonolithRuntimeDependencies) {}

  tick(): void {
    const now = this.now();
    if (!this.refreshing && now - this.lastRefreshAt >= RUNTIME_REFRESH_MS) {
      this.lastRefreshAt = now;
      this.refreshing = this.refresh().catch(() => undefined).finally(() => { this.refreshing = null; });
    }
    if (now - this.lastHealAt >= MONOLITH_HEALER_TICK_MS) {
      this.lastHealAt = nextBeatDueAt(this.lastHealAt, now, MONOLITH_HEALER_TICK_MS);
      this.healPass(now);
    }
    if (this.deps.retireFinished && now - this.lastRetireAt >= RUNTIME_RETIRE_MS) {
      this.lastRetireAt = now;
      void this.deps.retireFinished().catch(() => undefined);
    }
  }

  /** Frenzy attack bonus (0 or 0.28) for the player's current position. */
  attackBonus(playerId: string): number {
    return this.inAllyRange(playerId, "berserker", this.now()) ? MONOLITH_BERSERKER_ATTACK_BONUS : 0;
  }

  async refresh(): Promise<void> {
    const players = [...this.deps.activePlayerIds()];
    const [monoliths, memberships] = await Promise.all([
      this.deps.pool.query<{
        monolith_type: string; owner_player_id: string; lat: number; lon: number;
        expires_at: Date; remnant_until: Date; burn_until: Date | null;
        city_id: string | null; kingdom_id: string | null;
      }>(
        `SELECT m.monolith_type, m.owner_player_id, ST_Y(m.geom) AS lat, ST_X(m.geom) AS lon,
                m.expires_at, m.remnant_until, m.burn_until,
                (SELECT cm.city_id::text FROM city_memberships cm JOIN cities c ON c.id=cm.city_id AND c.active
                 WHERE cm.player_id=m.owner_player_id AND cm.left_at IS NULL ORDER BY cm.joined_at DESC LIMIT 1) AS city_id,
                (SELECT km.kingdom_id::text FROM kingdom_memberships km JOIN kingdoms k ON k.id=km.kingdom_id AND k.status='active'
                 WHERE km.player_id=m.owner_player_id AND km.status='active' LIMIT 1) AS kingdom_id
         FROM war_monoliths m
         WHERE m.status='standing' AND m.monolith_type IN ('berserker','healer')
           AND m.expires_at > clock_timestamp()
           AND (m.burn_until IS NULL OR m.burn_until > clock_timestamp())`
      ),
      players.length
        ? this.deps.pool.query<{ player_id: string; city_id: string | null; kingdom_id: string | null }>(
            `SELECT p.id AS player_id,
                    (SELECT cm.city_id::text FROM city_memberships cm JOIN cities c ON c.id=cm.city_id AND c.active
                     WHERE cm.player_id=p.id AND cm.left_at IS NULL ORDER BY cm.joined_at DESC LIMIT 1) AS city_id,
                    (SELECT km.kingdom_id::text FROM kingdom_memberships km JOIN kingdoms k ON k.id=km.kingdom_id AND k.status='active'
                     WHERE km.player_id=p.id AND km.status='active' LIMIT 1) AS kingdom_id
             FROM players p WHERE p.id = ANY($1::text[])`,
            [players]
          )
        : Promise.resolve({ rows: [] as Array<{ player_id: string; city_id: string | null; kingdom_id: string | null }> })
    ]);
    this.monoliths = monoliths.rows.filter((row) => isMonolithType(row.monolith_type)).map((row) => ({
      type: row.monolith_type as MonolithType,
      lat: Number(row.lat),
      lon: Number(row.lon),
      owner: { playerId: row.owner_player_id, cityId: row.city_id, kingdomId: row.kingdom_id },
      expiresAtMs: new Date(row.expires_at).getTime(),
      remnantUntilMs: new Date(row.remnant_until).getTime(),
      burnUntilMs: row.burn_until ? new Date(row.burn_until).getTime() : null
    }));
    this.allegiances = new Map(memberships.rows.map((row) => [row.player_id, {
      playerId: row.player_id, cityId: row.city_id, kingdomId: row.kingdom_id
    }]));
  }

  private healPass(now: number): void {
    if (!this.monoliths.some((monolith) => monolith.type === "healer")) return;
    for (const playerId of this.deps.activePlayerIds()) {
      if (!this.inAllyRange(playerId, "healer", now)) continue;
      const entity = this.deps.combat.entity(playerId);
      if (!entity || entity.currentHealth >= entity.maxHealth) continue;
      const amount = this.healCarry.take(playerId, entity.maxHealth * MONOLITH_HEALER_HEAL_FRACTION);
      if (amount > 0) this.deps.combat.healEntity(playerId, amount);
    }
  }

  private inAllyRange(playerId: string, type: MonolithType, now: number): boolean {
    if (!this.monoliths.length) return false;
    const allegiance = this.allegiances.get(playerId);
    if (!allegiance || !this.deps.onWorldMap(playerId)) return false;
    const entity = this.deps.combat.entity(playerId);
    if (!entity || entity.lifeState !== "alive") return false;
    return this.monoliths.some((monolith) =>
      monolith.type === type &&
      monolithEffective(monolith, now) &&
      monolithAllied(monolith.owner, allegiance) &&
      distanceMeters(entity, monolith) <= MONOLITH_RANGE_RADIUS_M
    );
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
