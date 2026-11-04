import {
  MILITARY_BALLISTA_VOLLEY_CADENCE_MS,
  MILITARY_UNIT_INTERACTION_RADIUS_M,
  STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS,
  STRUCTURE_WARFARE_ATTACK_DAMAGE,
  STRUCTURE_WARFARE_BOMBER_DAMAGE,
  STRUCTURE_WARFARE_INTERACTION_RADIUS_M,
  WAR_CAMP_BURN_DURATION_MS,
  WAR_CAMP_BURN_THRESHOLD,
  distanceMeters,
  isWithinSiegeAttackRange,
  planBallistaStructuralDamage,
  type WarCampAttackMode
} from "@ash-atlas/shared";
import type pg from "pg";

import { MilitaryIndustryError } from "./militaryIndustry.js";
import {
  attackingOrganization,
  forcedPeaceRefusalInTransaction,
  loadPlayerOrganizations
} from "./warStructures.js";

/**
 * War Camp warfare (B2). A standing War Camp has 2,200 HP. Enemies damage it
 * by the structure rules: a hand attack deals 25 once per attacker and camp
 * every 24 h from within 50 m; a Bomber strike spends one available Bomber of
 * a deployed group within reach and deals 1,150; a Siege volley deals the
 * group's structural damage on the Siege cadence from within Siege range.
 * Every source stops at the 1,100 burn threshold (must-burn) and reaching it
 * ignites a 1 h burn; reconcileBurnedOutWarCamps then removes the camp and
 * leaves its garrison standing in the field. The owner and members of the
 * owner's city or kingdom cannot damage it.
 *
 * Lock order: the attacker's military channel advisory lock (bomber / siege),
 * then the camp row, then the attacker's group rows. Replays: one damage row
 * per (player, request), checked under the camp lock.
 */
export type WarCampAttackInput = Readonly<{
  playerId: string;
  position: Readonly<{ lat: number; lon: number }>;
  campId: string;
  requestId: string;
  mode: WarCampAttackMode;
  groupId?: string;
}>;

export type WarCampAttackResult = Readonly<{
  campId: string;
  ownerPlayerId: string;
  damage: number;
  health: number;
  ignited: boolean;
  replayed: boolean;
}>;

type CampRow = {
  camp_id: string;
  owner_player_id: string;
  lat: number;
  lon: number;
  health: number;
  burning_until: Date | string | null;
  damage_cycle_id: string | null;
};

type GroupRow = {
  group_id: string;
  unit_type: string;
  location_state: string;
  movement_order: string | null;
  lat: number | null;
  lon: number | null;
  next_fire_at: Date | string | null;
};

function warCampError(code: string, message: string): MilitaryIndustryError {
  return new MilitaryIndustryError(code, message);
}

export class WarCampWarfareService {
  constructor(private readonly pool: pg.Pool) {}

  async attack(input: WarCampAttackInput): Promise<WarCampAttackResult> {
    if (input.requestId.length < 1 || input.requestId.length > 128) {
      throw warCampError("WAR_CAMP_ATTACK_INVALID", "A valid request is required.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `military-industry-player:${input.playerId}`
      ]);
      const locked = await client.query<CampRow>(
        `SELECT camp_id::text, owner_player_id, lat, lon, health, burning_until, damage_cycle_id::text
         FROM war_camps WHERE camp_id = $1::uuid AND removed_at IS NULL FOR UPDATE`,
        [input.campId]
      );
      const prior = await client.query<{ camp_id: string; damage: number; health_after: number; ignited: boolean }>(
        `SELECT camp_id::text, damage, health_after, ignited FROM war_camp_damage_operations
         WHERE player_id = $1 AND request_id = $2`,
        [input.playerId, input.requestId]
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.camp_id !== input.campId) {
          throw warCampError("WAR_CAMP_ATTACK_REPLAY_CONFLICT", "That request was already used for another War Camp.");
        }
        await client.query("COMMIT");
        return {
          campId: row.camp_id,
          ownerPlayerId: locked.rows[0]?.owner_player_id ?? "",
          damage: Number(row.damage),
          health: Number(row.health_after),
          ignited: row.ignited,
          replayed: true
        };
      }
      const camp = locked.rows[0];
      if (!camp) throw warCampError("WAR_CAMP_NOT_FOUND", "That War Camp no longer stands.");
      await this.assertHostile(client, input.playerId, camp.owner_player_id);
      if (camp.burning_until !== null || Number(camp.health) <= WAR_CAMP_BURN_THRESHOLD) {
        throw warCampError("WAR_CAMP_BURNING", "This War Camp is already burning.");
      }
      const campPosition = { lat: Number(camp.lat), lon: Number(camp.lon) };
      let damage: number;
      let groupId: string | null = null;
      if (input.mode === "hand") {
        if (distanceMeters(input.position, campPosition) > STRUCTURE_WARFARE_INTERACTION_RADIUS_M) {
          throw warCampError(
            "WAR_CAMP_OUT_OF_RANGE",
            `Move within ${STRUCTURE_WARFARE_INTERACTION_RADIUS_M} m of the War Camp before attacking it.`
          );
        }
        const cooldown = await client.query<{ remaining_ms: string }>(
          `SELECT GREATEST(0, EXTRACT(EPOCH FROM (
                    attacked_at + ($3::bigint * interval '1 millisecond') - clock_timestamp()
                  )) * 1000)::bigint::text AS remaining_ms
           FROM war_camp_attack_cooldowns WHERE camp_id = $1::uuid AND player_id = $2 FOR UPDATE`,
          [input.campId, input.playerId, STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS]
        );
        const remainingMs = Number(cooldown.rows[0]?.remaining_ms ?? 0);
        if (remainingMs > 0) {
          const hours = Math.ceil(remainingMs / 3_600_000);
          throw warCampError(
            "WAR_CAMP_ATTACK_COOLDOWN",
            `You can attack this War Camp again in about ${hours} hour${hours === 1 ? "" : "s"}.`
          );
        }
        await client.query(
          `INSERT INTO war_camp_attack_cooldowns (camp_id, player_id, attacked_at)
           VALUES ($1::uuid, $2, clock_timestamp())
           ON CONFLICT (camp_id, player_id) DO UPDATE SET attacked_at = EXCLUDED.attacked_at`,
          [input.campId, input.playerId]
        );
        damage = STRUCTURE_WARFARE_ATTACK_DAMAGE;
      } else {
        if (!input.groupId) throw warCampError("WAR_CAMP_GROUP_REQUIRED", "Choose a Bomber or Siege group.");
        groupId = input.groupId;
        damage = input.mode === "bomber"
          ? await this.spendBomber(client, input.playerId, input.groupId, campPosition)
          : await this.fireSiege(client, input.playerId, input.groupId, campPosition);
      }
      const health = Number(camp.health);
      const healthAfter = Math.max(WAR_CAMP_BURN_THRESHOLD, health - damage);
      const dealt = health - healthAfter;
      const ignited = healthAfter <= WAR_CAMP_BURN_THRESHOLD;
      const updated = await client.query<{ damage_cycle_id: string }>(
        `UPDATE war_camps
         SET health = $2,
             damage_cycle_id = COALESCE(damage_cycle_id, gen_random_uuid()),
             burning_started_at = CASE WHEN $3 THEN clock_timestamp() ELSE burning_started_at END,
             burning_until = CASE WHEN $3 THEN clock_timestamp() + ($4::bigint * interval '1 millisecond')
                                  ELSE burning_until END,
             updated_at = clock_timestamp()
         WHERE camp_id = $1::uuid
         RETURNING damage_cycle_id::text`,
        [input.campId, healthAfter, ignited, WAR_CAMP_BURN_DURATION_MS]
      );
      await client.query(
        `INSERT INTO war_camp_damage_operations (
           camp_id, player_id, request_id, source, group_id, damage, health_after, ignited, damage_cycle_id
         ) VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6,$7,$8,$9::uuid)`,
        [input.campId, input.playerId, input.requestId, input.mode, groupId, dealt, healthAfter, ignited,
          updated.rows[0]!.damage_cycle_id]
      );
      await client.query("COMMIT");
      return { campId: input.campId, ownerPlayerId: camp.owner_player_id, damage: dealt, health: healthAfter, ignited, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Removes War Camps whose 1 h burn ended: the garrison and its groups stand
   * in the field at the camp, pending rallies to it are cancelled. Idempotent
   * (removed camps are skipped); safe to run on several workers.
   */
  async reconcileBurnedOutWarCamps(limit = 50): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{ camp_id: string; owner_player_id: string; lat: number; lon: number }>(
        `SELECT camp_id::text, owner_player_id, lat, lon FROM war_camps
         WHERE removed_at IS NULL AND burning_until IS NOT NULL AND burning_until <= clock_timestamp()
         ORDER BY burning_until, camp_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [Math.max(1, Math.min(200, Math.trunc(limit)))]
      );
      for (const camp of due.rows) {
        await client.query(
          `UPDATE military_rally_operations SET status = 'cancelled', completed_at = clock_timestamp()
           WHERE camp_id = $1::uuid AND status = 'pending'`,
          [camp.camp_id]
        );
        for (const table of ["military_units", "military_unit_groups"]) {
          await client.query(
            `UPDATE ${table}
             SET location_state = 'DEPLOYED_FIELD', war_camp_id = NULL, lat = $2, lon = $3,
                 revision = revision + 1, updated_at = clock_timestamp()
             WHERE war_camp_id = $1::uuid`,
            [camp.camp_id, Number(camp.lat), Number(camp.lon)]
          );
        }
        await client.query(
          `UPDATE war_camps
           SET removed_at = clock_timestamp(), removed_reason = 'burned', health = 0,
               burning_started_at = NULL, burning_until = NULL, updated_at = clock_timestamp()
           WHERE camp_id = $1::uuid AND removed_at IS NULL`,
          [camp.camp_id]
        );
      }
      await client.query("COMMIT");
      return [...new Set(due.rows.map((camp) => camp.owner_player_id))];
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertHostile(client: pg.PoolClient, attackerId: string, ownerId: string): Promise<void> {
    if (attackerId === ownerId) throw warCampError("WAR_CAMP_ATTACK_ALLY", "You cannot attack your own War Camp.");
    const [attacker, owner] = await Promise.all([
      loadPlayerOrganizations(client, attackerId),
      loadPlayerOrganizations(client, ownerId)
    ]);
    if ((attacker.cityId !== null && attacker.cityId === owner.cityId) ||
        (attacker.kingdomId !== null && attacker.kingdomId === owner.kingdomId)) {
      throw warCampError("WAR_CAMP_ATTACK_ALLY", "You cannot attack the War Camp of your own city or kingdom.");
    }
    const side = attackingOrganization(owner);
    const peace = side ? await forcedPeaceRefusalInTransaction(client, attackerId, side) : null;
    if (peace) throw warCampError("WAR_CAMP_FORCED_PEACE", peace);
  }

  private async lockGroup(client: pg.PoolClient, playerId: string, groupId: string): Promise<GroupRow> {
    const result = await client.query<GroupRow>(
      `SELECT group_id::text, unit_type, location_state, movement_order, lat, lon, next_fire_at
       FROM military_unit_groups WHERE group_id = $1::uuid AND owner_player_id = $2 FOR UPDATE`,
      [groupId, playerId]
    );
    const group = result.rows[0];
    if (!group) throw warCampError("MILITARY_GROUP_NOT_FOUND", "That military group is not yours.");
    if (!["FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.location_state) ||
        group.movement_order === "MOVE_TO_COORDINATE" || group.lat === null || group.lon === null) {
      throw warCampError("MILITARY_GROUP_NOT_DEPLOYED", "Deploy or follow with the group first.");
    }
    return group;
  }

  /** Spends one available Bomber of a deployed group within reach of the camp. */
  private async spendBomber(
    client: pg.PoolClient,
    playerId: string,
    groupId: string,
    campPosition: Readonly<{ lat: number; lon: number }>
  ): Promise<number> {
    const group = await this.lockGroup(client, playerId, groupId);
    if (group.unit_type !== "bomber") throw warCampError("MILITARY_BOMBER_REQUIRED", "Only a Bomber group can bomb a War Camp.");
    if (distanceMeters({ lat: Number(group.lat), lon: Number(group.lon) }, campPosition) > MILITARY_UNIT_INTERACTION_RADIUS_M) {
      throw warCampError("WAR_CAMP_OUT_OF_RANGE", "Bring the Bombers next to the War Camp first.");
    }
    const consumed = await client.query<{ unit_id: string }>(
      `UPDATE military_units
       SET current_hp = 0, status = 'destroyed', location_state = 'DEPLOYED_FIELD', group_id = NULL,
           station_city_id = NULL, war_camp_id = NULL, target_flag_id = NULL, next_fire_at = NULL,
           revision = revision + 1, updated_at = clock_timestamp()
       WHERE unit_id = (
         SELECT unit_id FROM military_units
         WHERE group_id = $1::uuid AND owner_player_id = $2 AND unit_type = 'bomber'
           AND status = 'available' AND current_hp > 0
         ORDER BY created_at, unit_id LIMIT 1 FOR UPDATE
       )
       RETURNING unit_id::text`,
      [groupId, playerId]
    );
    if (!consumed.rows[0]) throw warCampError("MILITARY_BOMBER_REQUIRED", "No available Bomber remains in this group.");
    await client.query(
      "UPDATE military_unit_groups SET revision = revision + 1, updated_at = clock_timestamp() WHERE group_id = $1::uuid",
      [groupId]
    );
    return STRUCTURE_WARFARE_BOMBER_DAMAGE;
  }

  /** One Siege volley on the Siege cadence, from within Siege range. */
  private async fireSiege(
    client: pg.PoolClient,
    playerId: string,
    groupId: string,
    campPosition: Readonly<{ lat: number; lon: number }>
  ): Promise<number> {
    const group = await this.lockGroup(client, playerId, groupId);
    if (group.unit_type !== "field_ballista") throw warCampError("MILITARY_BALLISTA_REQUIRED", "Only a Siege group can fire on a War Camp.");
    if (!isWithinSiegeAttackRange(distanceMeters({ lat: Number(group.lat), lon: Number(group.lon) }, campPosition))) {
      throw warCampError("WAR_CAMP_OUT_OF_RANGE", "The War Camp is outside this Siege's range.");
    }
    if (group.next_fire_at !== null && new Date(group.next_fire_at).getTime() > Date.now()) {
      throw warCampError("MILITARY_BALLISTA_COOLDOWN", "This Siege group is still reloading.");
    }
    const ballistas = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM military_units
       WHERE group_id = $1::uuid AND owner_player_id = $2 AND unit_type = 'field_ballista'
         AND status = 'available' AND current_hp > 0`,
      [groupId, playerId]
    );
    const fusion = Number(ballistas.rows[0]?.count ?? 0);
    if (fusion <= 0) throw warCampError("MILITARY_BALLISTA_UNAVAILABLE", "No Siege in this group can fire.");
    await client.query(
      `UPDATE military_unit_groups
       SET next_fire_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
           revision = revision + 1, updated_at = clock_timestamp()
       WHERE group_id = $1::uuid`,
      [groupId, MILITARY_BALLISTA_VOLLEY_CADENCE_MS]
    );
    return planBallistaStructuralDamage(Number.MAX_SAFE_INTEGER, fusion, 0);
  }
}
