import {
  MANOR_WARFARE_PROFILE,
  STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS,
  STRUCTURE_WARFARE_ATTACK_DAMAGE,
  STRUCTURE_WARFARE_INTERACTION_RADIUS_M,
  STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER,
  distanceMeters,
  manorHealthAt,
  type ManorWarfareSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import { declareFlagEnemy } from "./personalFlagWarfare.js";

/*
 * Manor warfare  (houses are attackable). The state lives on the
 * Manor's own player_manors row as a checkpoint (health, health_at,
 * burning_since, the owner's repair), projected with the shared rates
 * (manorHealthAt), exactly like city buildings (cityStructureWarfare.ts).
 *
 * Attack permission is the personal-flag rule: anyone but the owner, while
 * online and standing still within reach; the realtime handler applies the
 * same settled / anti-spoof / arrival-hold gates (raidAllowed) as a flag
 * attack, and an attack declares the attacker and owner enemies as a flag
 * attack does. Reaching the 50% threshold ignites the Manor; a burn that
 * reaches 0 leaves it "burnt" (never deleted or unbuilt): every stored item,
 * furniture placement and station stays, and nobody can enter until the owner
 * repairs it above 0.
 */

type Queryable = Pick<pg.PoolClient, "query">;

export class ManorWarfareError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ManorWarfareError";
  }
}

export type ManorWarfarePlayer = Readonly<{
  position: Readonly<{ lat: number; lon: number }>;
  target: Readonly<{ lat: number; lon: number }> | null;
  online: boolean;
}>;

type ManorWarfareRow = {
  id: string;
  owner_player_id: string;
  world_lat: number | null;
  world_lon: number | null;
  built_at: Date | string | null;
  health: number | null;
  health_at: Date | string | null;
  burning_since: Date | string | null;
  repair_player_id: string | null;
  repair_started_at: Date | string | null;
  db_now: Date | string;
};

export type LockedManor = Readonly<{
  row: ManorWarfareRow;
  nowMs: number;
  health: number;
  burning: boolean;
  repairing: boolean;
  position: Readonly<{ lat: number; lon: number }>;
}>;

export type ManorWarfareCheckpointColumns = Readonly<{
  health: number | null;
  health_at: Date | string | null;
  burning_since: Date | string | null;
  repair_player_id: string | null;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SQL column list for a Manor world snapshot's warfare checkpoint (alias `m`). */
export const MANOR_WARFARE_SNAPSHOT_COLUMNS = "m.health,m.health_at,m.burning_since,m.repair_player_id";

function error(code: string, message: string): ManorWarfareError {
  return new ManorWarfareError(code, message);
}

/** Wire projection of a checkpoint; undefined for an untouched Manor (full health). */
export function manorWarfareSnapshot(row: Partial<ManorWarfareCheckpointColumns>): ManorWarfareSnapshot | undefined {
  if (row.health === null || row.health === undefined) return undefined;
  return {
    maximumHealth: MANOR_WARFARE_PROFILE.maximumHealth,
    burnThreshold: MANOR_WARFARE_PROFILE.burnThreshold,
    burnDurationMs: MANOR_WARFARE_PROFILE.burnDurationMs,
    health: Number(row.health),
    healthAt: row.health_at ? new Date(row.health_at).toISOString() : null,
    burning: (row.burning_since ?? null) !== null,
    repairing: (row.repair_player_id ?? null) !== null,
    repairPlayerId: row.repair_player_id ?? null
  };
}

/** Projected health of a checkpoint at `nowMs`. */
export function manorCheckpointHealth(row: ManorWarfareCheckpointColumns, nowMs: number): number {
  return manorHealthAt({
    health: row.health === null ? null : Number(row.health),
    healthAtMs: row.health_at === null ? null : new Date(row.health_at).getTime(),
    burning: row.burning_since !== null,
    repairing: row.repair_player_id !== null
  }, nowMs);
}

/** Locks a built Manor's row; null for an unknown or unbuilt Manor. */
export async function lockManorInTransaction(client: Queryable, manorId: string): Promise<LockedManor | null> {
  if (!UUID_PATTERN.test(manorId)) return null;
  const result = await client.query<ManorWarfareRow>(
    `SELECT id::text,owner_player_id,world_lat,world_lon,built_at,health,health_at,burning_since,
            repair_player_id,repair_started_at,clock_timestamp() AS db_now
     FROM player_manors WHERE id=$1::uuid FOR UPDATE`,
    [manorId]
  );
  const row = result.rows[0];
  if (!row || row.built_at === null || row.world_lat === null || row.world_lon === null) return null;
  const nowMs = new Date(row.db_now).getTime();
  return {
    row,
    nowMs,
    health: manorCheckpointHealth(row, nowMs),
    burning: row.burning_since !== null,
    repairing: row.repair_player_id !== null,
    position: { lat: Number(row.world_lat), lon: Number(row.world_lon) }
  };
}

async function writeCheckpoint(
  client: Queryable,
  target: LockedManor,
  next: Readonly<{
    health: number;
    burning: boolean;
    repair: Readonly<{ playerId: string; startedAtMs: number }> | null;
  }>
): Promise<void> {
  const health = Math.max(0, Math.min(MANOR_WARFARE_PROFILE.maximumHealth, Math.floor(next.health)));
  const burning = next.burning && health > 0;
  // Unlike a city building, a burnt Manor (0 health) can be repaired.
  const repair = next.repair;
  const untouched = health >= MANOR_WARFARE_PROFILE.maximumHealth && !burning && repair === null;
  const at = new Date(target.nowMs);
  await client.query(
    `UPDATE player_manors
     SET health=$2,health_at=$3,
         burning_since=CASE WHEN $4::boolean THEN COALESCE(burning_since,$3) ELSE NULL END,
         repair_player_id=$5,repair_started_at=$6
     WHERE id=$1::uuid`,
    [
      target.row.id,
      untouched ? null : health,
      untouched ? null : at,
      burning,
      repair?.playerId ?? null,
      repair ? new Date(repair.startedAtMs) : null
    ]
  );
}

export type ManorAttackResult = Readonly<{
  manorId: string;
  ownerPlayerId: string;
  damage: number;
  health: number;
  ignited: boolean;
  replayed: boolean;
}>;

/** Hand attack: 25 damage (3x while repairing), once per attacker per 24 h, never below the threshold. */
export async function attackManor(
  pool: pg.Pool,
  input: Readonly<{
    playerId: string;
    manorId: string;
    requestId: string;
    player: ManorWarfarePlayer;
  }>
): Promise<ManorAttackResult> {
  if (!input.player.online) throw error("MANOR_ATTACK_DISCONNECTED", "You must be online to attack a Manor.");
  if (input.player.target) throw error("MANOR_ATTACK_MOVING", "Stop moving before attacking a Manor.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `manor-attack:${input.playerId}:${input.requestId}`
    ]);
    const prior = await client.query<{ manor_id: string; damage: number; owner_player_id: string; health: number | null }>(
      `SELECT op.manor_id::text,op.damage,m.owner_player_id,m.health
       FROM manor_attack_operations op JOIN player_manors m ON m.id=op.manor_id
       WHERE op.player_id=$1 AND op.request_id=$2`,
      [input.playerId, input.requestId]
    );
    if (prior.rows[0]) {
      if (prior.rows[0].manor_id !== input.manorId) {
        throw error("MANOR_ATTACK_IDEMPOTENCY_CONFLICT", "That attack request was already used for another Manor.");
      }
      await client.query("COMMIT");
      return {
        manorId: input.manorId,
        ownerPlayerId: prior.rows[0].owner_player_id,
        damage: Number(prior.rows[0].damage),
        health: prior.rows[0].health === null ? MANOR_WARFARE_PROFILE.maximumHealth : Number(prior.rows[0].health),
        ignited: false,
        replayed: true
      };
    }
    const target = await lockManorInTransaction(client, input.manorId);
    if (!target) throw error("MANOR_ATTACK_TARGET_INVALID", "That Manor cannot be attacked.");
    if (target.row.owner_player_id === input.playerId) {
      throw error("MANOR_ATTACK_TARGET_INVALID", "You cannot attack your own Manor.");
    }
    if (distanceMeters(input.player.position, target.position) > STRUCTURE_WARFARE_INTERACTION_RADIUS_M) {
      throw error(
        "MANOR_ATTACK_OUT_OF_RANGE",
        `Move within ${STRUCTURE_WARFARE_INTERACTION_RADIUS_M}m of the Manor before attacking it.`
      );
    }
    if (target.health <= 0) throw error("MANOR_BURNT", "This Manor has already burnt down.");
    if (target.burning) throw error("MANOR_ATTACK_BURNING", "A Manor cannot be attacked while it is burning.");
    if (target.health <= MANOR_WARFARE_PROFILE.burnThreshold) {
      throw error("MANOR_ATTACK_THRESHOLD_REACHED", "This Manor is ready to burn; no more attacks are needed.");
    }
    const cooldown = await client.query<{ remaining_ms: string | number }>(
      `SELECT GREATEST(0,EXTRACT(EPOCH FROM (
                max(created_at)+($3::bigint*interval '1 millisecond')-clock_timestamp()))*1000)::bigint AS remaining_ms
       FROM manor_attack_operations
       WHERE manor_id=$1::uuid AND player_id=$2`,
      [input.manorId, input.playerId, STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS]
    );
    const remainingMs = Number(cooldown.rows[0]?.remaining_ms ?? 0);
    if (remainingMs > 0) {
      const hours = Math.ceil(remainingMs / 3_600_000);
      throw error("MANOR_ATTACK_COOLDOWN", `You can attack this Manor again in about ${hours} hour${hours === 1 ? "" : "s"}.`);
    }
    const damage = STRUCTURE_WARFARE_ATTACK_DAMAGE *
      (target.repairing ? STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER : 1);
    const next = Math.max(MANOR_WARFARE_PROFILE.burnThreshold, target.health - damage);
    const dealt = target.health - next;
    const ignited = !target.repairing && next <= MANOR_WARFARE_PROFILE.burnThreshold;
    await writeCheckpoint(client, target, {
      health: next,
      burning: ignited,
      repair: target.repairing && target.row.repair_started_at
        ? { playerId: target.row.repair_player_id!, startedAtMs: new Date(target.row.repair_started_at).getTime() }
        : null
    });
    await client.query(
      `INSERT INTO manor_attack_operations (player_id,request_id,manor_id,damage)
       VALUES ($1,$2,$3::uuid,$4)`,
      [input.playerId, input.requestId, input.manorId, dealt]
    );
    await declareFlagEnemy(client as pg.PoolClient, input.playerId, target.row.owner_player_id);
    await client.query("COMMIT");
    return {
      manorId: input.manorId,
      ownerPlayerId: target.row.owner_player_id,
      damage: dealt,
      health: next,
      ignited,
      replayed: false
    };
  } catch (caught) {
    await client.query("ROLLBACK");
    throw caught;
  } finally {
    client.release();
  }
}

/**
 * Starts the owner's free, time-only repair: health returns at 5x the burn
 * rate and the burn pauses while the owner stays beside the Manor. A burnt
 * Manor (0 health) can be repaired.
 */
export async function startManorRepair(
  pool: pg.Pool,
  input: Readonly<{ playerId: string; manorId: string; player: ManorWarfarePlayer }>
): Promise<Readonly<{ manorId: string; replayed: boolean }>> {
  if (!input.player.online) throw error("MANOR_REPAIR_DISCONNECTED", "You must be online to repair your Manor.");
  if (input.player.target) throw error("MANOR_REPAIR_MOVING", "Stop moving before repairing your Manor.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await lockManorInTransaction(client, input.manorId);
    if (!target) throw error("MANOR_REPAIR_TARGET_INVALID", "That Manor cannot be repaired.");
    if (target.row.owner_player_id !== input.playerId) {
      throw error("MANOR_REPAIR_OWNER_REQUIRED", "Only the owner can repair this Manor.");
    }
    if (target.row.repair_player_id === input.playerId) {
      await client.query("COMMIT");
      return { manorId: input.manorId, replayed: true };
    }
    if (distanceMeters(input.player.position, target.position) > STRUCTURE_WARFARE_INTERACTION_RADIUS_M) {
      throw error("MANOR_REPAIR_OUT_OF_RANGE", "Move next to your Manor to repair it.");
    }
    if (target.health >= MANOR_WARFARE_PROFILE.maximumHealth && !target.burning) {
      throw error("MANOR_REPAIR_NOT_NEEDED", "Your Manor is not damaged.");
    }
    await writeCheckpoint(client, target, {
      health: target.health,
      burning: target.burning,
      repair: { playerId: input.playerId, startedAtMs: target.nowMs }
    });
    await client.query("COMMIT");
    return { manorId: input.manorId, replayed: false };
  } catch (caught) {
    await client.query("ROLLBACK");
    throw caught;
  } finally {
    client.release();
  }
}

/**
 * Ends a repair at the restored health. Full health ends any burn; at or below
 * the threshold the Manor burns on from its current health; at 0 it stays burnt.
 */
async function endRepairInTransaction(client: Queryable, target: LockedManor): Promise<void> {
  const full = target.health >= MANOR_WARFARE_PROFILE.maximumHealth;
  await writeCheckpoint(client, target, {
    health: target.health,
    burning: !full && target.health <= MANOR_WARFARE_PROFILE.burnThreshold,
    repair: null
  });
}

/** Stops the player's Manor repair (request, movement, travel, death or disconnect). */
export async function stopManorRepairForPlayer(
  pool: pg.Pool,
  playerId: string
): Promise<Readonly<{ manorId: string }> | null> {
  const found = await pool.query<{ id: string }>(
    "SELECT id::text FROM player_manors WHERE repair_player_id=$1",
    [playerId]
  );
  const manorId = found.rows[0]?.id;
  if (!manorId) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await lockManorInTransaction(client, manorId);
    if (!target || target.row.repair_player_id !== playerId) {
      await client.query("COMMIT");
      return null;
    }
    await endRepairInTransaction(client, target);
    await client.query("COMMIT");
    return { manorId };
  } catch (caught) {
    await client.query("ROLLBACK");
    throw caught;
  } finally {
    client.release();
  }
}

export type ManorRepairerPresence = (
  playerId: string,
  manor: Readonly<{ lat: number; lon: number }>
) => boolean;

export type ManorWarfareSweep = Readonly<{
  changedManorIds: string[];
  stoppedRepairs: Array<Readonly<{ playerId: string; manorId: string; completed: boolean }>>;
}>;

/**
 * Warfare tick: stops repairs whose owner left (or completes them at full
 * health) and settles burnt-down Manors at 0 health. Never deletes a Manor.
 */
export async function reconcileManorWarfare(
  pool: pg.Pool,
  isRepairerPresent: ManorRepairerPresence
): Promise<ManorWarfareSweep> {
  const live = await pool.query<{ id: string }>(
    `SELECT id::text FROM player_manors
     WHERE burning_since IS NOT NULL OR repair_player_id IS NOT NULL
     ORDER BY id`
  );
  const changedManorIds: string[] = [];
  const stoppedRepairs: Array<{ playerId: string; manorId: string; completed: boolean }> = [];
  for (const candidate of live.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const target = await lockManorInTransaction(client, candidate.id);
      if (!target) {
        await client.query("COMMIT");
        continue;
      }
      if (target.repairing) {
        const repairer = target.row.repair_player_id!;
        const completed = target.health >= MANOR_WARFARE_PROFILE.maximumHealth;
        if (!isRepairerPresent(repairer, target.position) || completed) {
          await endRepairInTransaction(client, target);
          changedManorIds.push(target.row.id);
          stoppedRepairs.push({ playerId: repairer, manorId: target.row.id, completed });
        }
      } else if (target.burning && target.health <= 0) {
        await writeCheckpoint(client, target, { health: 0, burning: false, repair: null });
        changedManorIds.push(target.row.id);
      }
      await client.query("COMMIT");
    } catch (caught) {
      await client.query("ROLLBACK");
      throw caught;
    } finally {
      client.release();
    }
  }
  return { changedManorIds, stoppedRepairs };
}
