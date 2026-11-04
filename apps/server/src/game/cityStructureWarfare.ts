import {
  STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS,
  STRUCTURE_WARFARE_ATTACK_DAMAGE,
  STRUCTURE_WARFARE_BOMBER_DAMAGE,
  STRUCTURE_WARFARE_INTERACTION_RADIUS_M,
  STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER,
  cityBuildingDisplayName,
  cityBuildingHealthAt,
  cityBuildingWarfareProfile,
  distanceMeters,
  type CityBuildingWarfareProfile
} from "@ash-atlas/shared";
import type pg from "pg";

import {
  forcedPeaceRefusalInTransaction,
  loadPlayerOrganizations,
  recordOrganizationHostilityInTransaction
} from "./warStructures.js";

/*
 * City building warfare (war part C3). The state lives on the building's own
 * city_structures row: a health checkpoint (health, health_at), burning_since
 * and the active repairer. Current health is projected from that checkpoint
 * with the shared burn / repair rates (cityBuildingHealthAt). Every damage or
 * repair write first settles the projection at the database clock.
 *
 * Damage writers lock only the building row. A building that reaches 0
 * health keeps a zero-health marker; the warfare sweep destroys it later in
 * the city-structure advisory -> player row order
 * (CityStructureService.destroyFallenBuildingForWar).
 */

type Queryable = Pick<pg.PoolClient, "query">;

export class CityStructureWarfareError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CityStructureWarfareError";
  }
}

export type CityStructureWarfarePlayer = Readonly<{
  position: Readonly<{ lat: number; lon: number }>;
  target: Readonly<{ lat: number; lon: number }> | null;
  online: boolean;
}>;

type WarfareRow = {
  structure_id: string;
  city_id: string;
  structure_type: string;
  state: string;
  owner_player_id: string | null;
  lat: number;
  lon: number;
  footprint_radius_m: number;
  health: number | null;
  health_at: Date | string | null;
  burning_since: Date | string | null;
  repair_player_id: string | null;
  repair_started_at: Date | string | null;
  city_controller_kind: string | null;
  city_active: boolean;
  db_now: Date | string;
};

export type LockedCityBuilding = Readonly<{
  row: WarfareRow;
  profile: CityBuildingWarfareProfile;
  nowMs: number;
  health: number;
  burning: boolean;
  repairing: boolean;
  position: Readonly<{ lat: number; lon: number }>;
}>;

export type CityBuildingHit = Readonly<{
  structureId: string;
  cityId: string;
  dealt: number;
  health: number;
  ignited: boolean;
  /** Zero health: the sweep destroys the building. */
  fallen: boolean;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LOCK_SELECT = `SELECT s.structure_id::text,s.city_id::text,s.structure_type,s.state,s.owner_player_id,
       s.lat,s.lon,s.footprint_radius_m,s.health,s.health_at,s.burning_since,
       s.repair_player_id,s.repair_started_at,
       c.controller_kind AS city_controller_kind,c.active AS city_active,
       clock_timestamp() AS db_now
FROM city_structures s
JOIN cities c ON c.id=s.city_id
WHERE s.structure_id=$1::uuid
FOR UPDATE OF s`;

function error(code: string, message: string): CityStructureWarfareError {
  return new CityStructureWarfareError(code, message);
}

/** Locks a building that has war health; null for an unknown or immune building. */
export async function lockCityBuildingInTransaction(
  client: Queryable,
  structureId: string
): Promise<LockedCityBuilding | null> {
  if (!UUID_PATTERN.test(structureId)) return null;
  const result = await client.query<WarfareRow>(LOCK_SELECT, [structureId]);
  const row = result.rows[0];
  if (!row) return null;
  const profile = cityBuildingWarfareProfile(row.structure_type);
  // Goblin / NPC villages stay immune, like system-controlled territory.
  if (!profile || row.city_controller_kind === "npc") return null;
  const nowMs = new Date(row.db_now).getTime();
  const burning = row.burning_since !== null;
  const repairing = row.repair_player_id !== null;
  const health = cityBuildingHealthAt(profile, {
    health: row.health === null ? null : Number(row.health),
    healthAtMs: row.health_at === null ? null : new Date(row.health_at).getTime(),
    burning,
    repairing
  }, nowMs);
  return {
    row,
    profile,
    nowMs,
    health,
    burning,
    repairing,
    position: { lat: Number(row.lat), lon: Number(row.lon) }
  };
}

async function writeCheckpoint(
  client: Queryable,
  target: LockedCityBuilding,
  next: Readonly<{
    health: number;
    burning: boolean;
    repair: Readonly<{ playerId: string; startedAtMs: number }> | null;
  }>
): Promise<void> {
  const health = Math.max(0, Math.min(target.profile.maximumHealth, Math.floor(next.health)));
  const burning = next.burning && health > 0;
  const repair = health > 0 ? next.repair : null;
  const untouched = health >= target.profile.maximumHealth && !burning && repair === null;
  const at = new Date(target.nowMs);
  await client.query(
    `UPDATE city_structures
     SET health=$2,health_at=$3,
         burning_since=CASE WHEN $4::boolean THEN COALESCE(burning_since,$3) ELSE NULL END,
         repair_player_id=$5,repair_started_at=$6,updated_at=clock_timestamp()
     WHERE structure_id=$1::uuid`,
    [
      target.row.structure_id,
      untouched ? null : health,
      untouched ? null : at,
      burning,
      repair?.playerId ?? null,
      repair ? new Date(repair.startedAtMs) : null
    ]
  );
}

function requireActive(target: LockedCityBuilding | null): LockedCityBuilding {
  if (!target || target.row.state !== "active" || !target.row.city_active) {
    throw error("CITY_BUILDING_TARGET_INVALID", "That city building cannot be attacked.");
  }
  if (target.health <= 0) {
    throw error("CITY_BUILDING_FALLEN", "That city building has already fallen.");
  }
  return target;
}

/**
 * Ally and peace rules for every hostile action: a member of the building's
 * city cannot attack it, and no side in a forced peace with the city can.
 */
export async function requireHostileCityBuildingInTransaction(
  client: Queryable,
  target: LockedCityBuilding | null,
  attackerPlayerId: string
): Promise<LockedCityBuilding> {
  const active = requireActive(target);
  const organizations = await loadPlayerOrganizations(client, attackerPlayerId);
  if (organizations.cityId === active.row.city_id) {
    throw error("CITY_BUILDING_ATTACK_ALLY", "You cannot attack a building of your own city.");
  }
  const peace = await forcedPeaceRefusalInTransaction(client, attackerPlayerId, {
    kind: "city",
    id: active.row.city_id
  });
  if (peace) throw error("CITY_BUILDING_FORCED_PEACE", peace);
  return active;
}

/** Bomber target rules on top of the hostile rules: ember bombs never hit houses or burning buildings. */
export function requireBombableCityBuilding(target: LockedCityBuilding): void {
  if (!target.profile.bombable) {
    throw error("CITY_BUILDING_BOMB_IMMUNE", "Ember bombs cannot target a City House.");
  }
  if (target.burning && !target.repairing) {
    throw error("CITY_BUILDING_BURNING", "A burning building cannot be bombed.");
  }
}

/**
 * Applies hostile damage to a locked building. Damage counts 3x while a
 * repair runs. Hand attacks and Sieges always stop at the burn threshold;
 * a Bomber stops there too unless the building is being repaired, in which
 * case it can take the building to 0. Reaching the threshold ignites an
 * unrepaired building.
 */
export async function applyCityBuildingDamageInTransaction(
  client: Queryable,
  target: LockedCityBuilding,
  input: Readonly<{
    attackerPlayerId: string;
    baseDamage: number;
    source: "hand" | "siege" | "bomber";
  }>
): Promise<CityBuildingHit> {
  const damage = Math.max(0, Math.floor(input.baseDamage)) *
    (target.repairing ? STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER : 1);
  const floor = input.source === "bomber" && target.repairing ? 0 : target.profile.burnThreshold;
  const next = target.health <= floor ? target.health : Math.max(floor, target.health - damage);
  const dealt = target.health - next;
  const fallen = next <= 0;
  const ignited = !fallen && !target.repairing && !target.burning && next <= target.profile.burnThreshold;
  await writeCheckpoint(client, target, {
    health: next,
    burning: !fallen && (target.burning || ignited),
    repair: fallen || !target.row.repair_player_id || !target.row.repair_started_at
      ? null
      : { playerId: target.row.repair_player_id, startedAtMs: new Date(target.row.repair_started_at).getTime() }
  });
  if (dealt > 0 || ignited) {
    const label = cityBuildingDisplayName(target.row.structure_type);
    await recordOrganizationHostilityInTransaction(client, {
      attackerPlayerId: input.attackerPlayerId,
      defender: { kind: "city", id: target.row.city_id },
      profile: { kind: "city_flag" },
      structureLabel: "building",
      structureName: label
    });
  }
  return {
    structureId: target.row.structure_id,
    cityId: target.row.city_id,
    dealt,
    health: next,
    ignited,
    fallen
  };
}

/** One Bomber strike (1,150 damage, 3x while repairing). The caller holds the military channel. */
export async function applyCityBuildingBombInTransaction(
  client: Queryable,
  structureId: string,
  bomberPlayerId: string
): Promise<CityBuildingHit> {
  const target = await requireHostileCityBuildingInTransaction(
    client,
    await lockCityBuildingInTransaction(client, structureId),
    bomberPlayerId
  );
  requireBombableCityBuilding(target);
  return applyCityBuildingDamageInTransaction(client, target, {
    attackerPlayerId: bomberPlayerId,
    baseDamage: STRUCTURE_WARFARE_BOMBER_DAMAGE,
    source: "bomber"
  });
}

export type CityBuildingAttackResult = Readonly<{
  structureId: string;
  cityId: string;
  damage: number;
  replayed: boolean;
}>;

/** Hand attack: 25 damage (3x while repairing), once per building per 24 h, never below the threshold. */
export async function attackCityBuilding(
  pool: pg.Pool,
  input: Readonly<{
    playerId: string;
    structureId: string;
    requestId: string;
    player: CityStructureWarfarePlayer;
  }>
): Promise<CityBuildingAttackResult> {
  if (!input.player.online) throw error("CITY_BUILDING_ATTACK_DISCONNECTED", "You must be online to attack a building.");
  if (input.player.target) throw error("CITY_BUILDING_ATTACK_MOVING", "Stop moving before attacking a building.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `city-building-attack:${input.playerId}:${input.requestId}`
    ]);
    const prior = await client.query<{ structure_id: string; damage: number }>(
      `SELECT op.structure_id::text,op.damage
       FROM city_structure_attack_operations op
       WHERE op.player_id=$1 AND op.request_id=$2`,
      [input.playerId, input.requestId]
    );
    if (prior.rows[0]) {
      if (prior.rows[0].structure_id !== input.structureId) {
        throw error("CITY_BUILDING_ATTACK_IDEMPOTENCY_CONFLICT", "That attack request was already used for another building.");
      }
      const city = await client.query<{ city_id: string }>(
        "SELECT city_id::text FROM city_structures WHERE structure_id=$1::uuid",
        [input.structureId]
      );
      await client.query("COMMIT");
      return {
        structureId: input.structureId,
        cityId: city.rows[0]?.city_id ?? "",
        damage: Number(prior.rows[0].damage),
        replayed: true
      };
    }
    const target = await requireHostileCityBuildingInTransaction(
      client,
      await lockCityBuildingInTransaction(client, input.structureId),
      input.playerId
    );
    if (
      distanceMeters(input.player.position, target.position) >
      STRUCTURE_WARFARE_INTERACTION_RADIUS_M + Number(target.row.footprint_radius_m)
    ) {
      throw error("CITY_BUILDING_ATTACK_OUT_OF_RANGE", "Move closer to the building before attacking it.");
    }
    if (target.burning) {
      throw error("CITY_BUILDING_BURNING", "A building cannot be attacked while it is burning.");
    }
    if (target.health <= target.profile.burnThreshold) {
      throw error("CITY_BUILDING_THRESHOLD_REACHED", "This building is ready to burn; no more attacks are needed.");
    }
    const cooldown = await client.query<{ remaining_ms: string | number }>(
      `SELECT GREATEST(0,EXTRACT(EPOCH FROM (
                max(created_at)+($3::bigint*interval '1 millisecond')-clock_timestamp()))*1000)::bigint AS remaining_ms
       FROM city_structure_attack_operations
       WHERE structure_id=$1::uuid AND player_id=$2`,
      [input.structureId, input.playerId, STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS]
    );
    const remainingMs = Number(cooldown.rows[0]?.remaining_ms ?? 0);
    if (remainingMs > 0) {
      const hours = Math.ceil(remainingMs / 3_600_000);
      throw error("CITY_BUILDING_ATTACK_COOLDOWN", `You can attack this building again in about ${hours} hour${hours === 1 ? "" : "s"}.`);
    }
    const hit = await applyCityBuildingDamageInTransaction(client, target, {
      attackerPlayerId: input.playerId,
      baseDamage: STRUCTURE_WARFARE_ATTACK_DAMAGE,
      source: "hand"
    });
    await client.query(
      `INSERT INTO city_structure_attack_operations (structure_id,player_id,request_id,damage)
       VALUES ($1::uuid,$2,$3,$4)`,
      [input.structureId, input.playerId, input.requestId, hit.dealt]
    );
    await client.query("COMMIT");
    return { structureId: hit.structureId, cityId: hit.cityId, damage: hit.dealt, replayed: false };
  } catch (caught) {
    await client.query("ROLLBACK");
    throw caught;
  } finally {
    client.release();
  }
}

/**
 * Starts a free, time-only repair: health returns at 5x the burn rate and any
 * burn pauses while the repairer stays. Any member of the building's city can
 * repair it; one repairer per building and one building per player.
 */
export async function startCityBuildingRepair(
  pool: pg.Pool,
  input: Readonly<{
    playerId: string;
    structureId: string;
    player: CityStructureWarfarePlayer;
  }>
): Promise<Readonly<{ structureId: string; cityId: string; replayed: boolean }>> {
  if (!input.player.online) throw error("CITY_BUILDING_REPAIR_DISCONNECTED", "You must be online to repair a building.");
  if (input.player.target) throw error("CITY_BUILDING_REPAIR_MOVING", "Stop moving before repairing a building.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = requireActive(await lockCityBuildingInTransaction(client, input.structureId));
    if ((await loadPlayerOrganizations(client, input.playerId)).cityId !== target.row.city_id) {
      throw error("CITY_BUILDING_REPAIR_MEMBER_REQUIRED", "Only members of this city can repair its buildings.");
    }
    if (target.row.repair_player_id === input.playerId) {
      await client.query("COMMIT");
      return { structureId: target.row.structure_id, cityId: target.row.city_id, replayed: true };
    }
    if (target.row.repair_player_id !== null) {
      throw error("CITY_BUILDING_REPAIR_ACTIVE", "Another city member is already repairing this building.");
    }
    if (
      distanceMeters(input.player.position, target.position) >
      STRUCTURE_WARFARE_INTERACTION_RADIUS_M + Number(target.row.footprint_radius_m)
    ) {
      throw error("CITY_BUILDING_REPAIR_OUT_OF_RANGE", "Move closer to the building before repairing it.");
    }
    if (target.health >= target.profile.maximumHealth && !target.burning) {
      throw error("CITY_BUILDING_REPAIR_NOT_NEEDED", "This building is not damaged.");
    }
    const other = await client.query(
      "SELECT 1 FROM city_structures WHERE repair_player_id=$1 AND structure_id<>$2::uuid",
      [input.playerId, input.structureId]
    );
    if (other.rowCount) throw error("CITY_BUILDING_REPAIR_BUSY", "You are already repairing another building.");
    await writeCheckpoint(client, target, {
      health: target.health,
      burning: target.burning,
      repair: { playerId: input.playerId, startedAtMs: target.nowMs }
    });
    await client.query("COMMIT");
    return { structureId: target.row.structure_id, cityId: target.row.city_id, replayed: false };
  } catch (caught) {
    await client.query("ROLLBACK");
    throw caught;
  } finally {
    client.release();
  }
}

/**
 * Ends a repair at the restored health. Full health ends any burn; above the
 * threshold the burn is put out; at or below it the building burns on from
 * its current health (a building that reached the threshold while repairing
 * ignites now).
 */
async function endRepairInTransaction(client: Queryable, target: LockedCityBuilding): Promise<void> {
  const full = target.health >= target.profile.maximumHealth;
  await writeCheckpoint(client, target, {
    health: target.health,
    burning: !full && target.health <= target.profile.burnThreshold,
    repair: null
  });
}

/** Stops the player's repair (request, movement, travel, death or disconnect). */
export async function stopCityBuildingRepairForPlayer(
  pool: pg.Pool,
  playerId: string
): Promise<Readonly<{ structureId: string; cityId: string }> | null> {
  const found = await pool.query<{ structure_id: string }>(
    "SELECT structure_id::text FROM city_structures WHERE repair_player_id=$1",
    [playerId]
  );
  const structureId = found.rows[0]?.structure_id;
  if (!structureId) return null;
  return endRepair(pool, structureId, playerId);
}

async function endRepair(
  pool: pg.Pool,
  structureId: string,
  playerId: string | null
): Promise<Readonly<{ structureId: string; cityId: string }> | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await lockCityBuildingInTransaction(client, structureId);
    if (!target || !target.repairing || (playerId !== null && target.row.repair_player_id !== playerId)) {
      await client.query("COMMIT");
      return null;
    }
    await endRepairInTransaction(client, target);
    await client.query("COMMIT");
    return { structureId, cityId: target.row.city_id };
  } catch (caught) {
    await client.query("ROLLBACK");
    throw caught;
  } finally {
    client.release();
  }
}

export type CityBuildingRepairerPresence = (
  playerId: string,
  building: Readonly<{ lat: number; lon: number; footprintRadiusM: number }>
) => boolean;

export type CityBuildingWarfareSweep = Readonly<{
  changedStructureIds: string[];
  stoppedRepairs: Array<Readonly<{ playerId: string; structureId: string; completed: boolean }>>;
}>;

/**
 * Warfare tick: stops repairs whose repairer left (or completes them at full
 * health), and marks burnt-out buildings with zero health. Destroying fallen
 * buildings is CityStructureService.destroyFallenBuildingsForWar.
 */
export async function reconcileCityBuildingWarfare(
  pool: pg.Pool,
  isRepairerPresent: CityBuildingRepairerPresence
): Promise<CityBuildingWarfareSweep> {
  const live = await pool.query<{
    structure_id: string;
    repair_player_id: string | null;
    lat: number;
    lon: number;
    footprint_radius_m: number;
  }>(
    `SELECT structure_id::text,repair_player_id,lat,lon,footprint_radius_m
     FROM city_structures
     WHERE state='active' AND (burning_since IS NOT NULL OR repair_player_id IS NOT NULL)
     ORDER BY structure_id`
  );
  const changedStructureIds: string[] = [];
  const stoppedRepairs: Array<{ playerId: string; structureId: string; completed: boolean }> = [];
  for (const candidate of live.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const target = await lockCityBuildingInTransaction(client, candidate.structure_id);
      if (!target || target.row.state !== "active") {
        await client.query("COMMIT");
        continue;
      }
      if (target.repairing) {
        const repairer = target.row.repair_player_id!;
        const present = isRepairerPresent(repairer, {
          lat: target.position.lat,
          lon: target.position.lon,
          footprintRadiusM: Number(target.row.footprint_radius_m)
        });
        const completed = target.health >= target.profile.maximumHealth;
        if (!present || completed) {
          await endRepairInTransaction(client, target);
          changedStructureIds.push(target.row.structure_id);
          stoppedRepairs.push({ playerId: repairer, structureId: target.row.structure_id, completed });
        }
      } else if (target.burning && target.health <= 0) {
        await writeCheckpoint(client, target, { health: 0, burning: false, repair: null });
        changedStructureIds.push(target.row.structure_id);
      }
      await client.query("COMMIT");
    } catch (caught) {
      await client.query("ROLLBACK");
      throw caught;
    } finally {
      client.release();
    }
  }
  return { changedStructureIds, stoppedRepairs };
}
