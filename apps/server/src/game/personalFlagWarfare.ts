import { randomInt } from "node:crypto";
import {
  PET_TAIL_LASH_STRUCTURE_DAMAGE,
  STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS,
  STRUCTURE_WARFARE_ATTACK_DAMAGE,
  STRUCTURE_WARFARE_BASE_BURN_DURATION_MS,
  STRUCTURE_WARFARE_BOMBER_DAMAGE,
  STRUCTURE_WARFARE_DISRUPT_DURATION_MS,
  STRUCTURE_WARFARE_INTERACTION_RADIUS_M,
  STRUCTURE_WARFARE_REPAIR_COST_BY_TIER,
  STRUCTURE_WARFARE_REPAIR_DURATION_MS,
  STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER,
  STRUCTURE_WARFARE_STONE_BURN_DURATION_MS,
  STRUCTURE_WARFARE_TORCH_COST,
  STRUCTURE_WARFARE_TOWER_HEALTH,
  formatStructureWarfareDuration,
  structureWarfareBurnDurationForReinforcementLevel,
  structureWarfareDisplayKind,
  structureWarfareFullRepairMs,
  type PlayerInventorySnapshot,
  type StructureWarfareProfile,
  distanceMeters
} from "@ash-atlas/shared";
import type pg from "pg";

import { DEFAULT_INVENTORY_VARIANT, type InventoryService } from "./inventory.js";
import {
  forcedPeaceRefusalInTransaction,
  hasActiveRepair,
  isAlliedOrganizationStructure,
  loadPlayerOrganizations,
  organizationLeaderId,
  organizationOfFlag,
  recordOrganizationHostilityInTransaction,
  warfareProfileForRow,
  type WarfareFlagRow
} from "./warStructures.js";
import { monolithAdjustedBuildingDamage } from "./monoliths.js";
import { formatFlagRelativeCity } from "./flagPresentation.js";
import { kingdomStructureDamageReduction, reducedStructureHit } from "./kingdomPerks.js";
import type { BurnFlagDeletionResult, PersonalFlagWarfareFlagService } from "./flagServiceContracts.js";
import {
  PERSONAL_FLAG_WARFARE_KIND,
  StructureWarfareError,
  type StructureWarfareAdapter,
  type StructureWarfareAttackInput,
  type StructureWarfareAttackResult,
  type StructureWarfareDeletionResult,
  type StructureWarfareDisruptCompletion,
  type StructureWarfareDisruptOperation,
  type StructureWarfareDisruptStartResult,
  type StructureWarfareIgnitionCompletion,
  type StructureWarfareIgnitionInput,
  type StructureWarfareIgnitionOperation,
  type StructureWarfareIgnitionStartResult,
  type StructureWarfareRepairCompletion,
  type StructureWarfareRepairOperation,
  type StructureWarfareRepairPlayer,
  type StructureWarfareRepairProgress,
  type StructureWarfareRepairStartResult
} from "./structureWarfare.js";

const FLAG_BURN_EVENT_KIND = "flag_burn_started";
/**
 * The defender of a flag row `f`: the owner of a personal flag, or the
 * current Mayor / Kingdom leader of a city or kingdom structure (falling back
 * to the recorded owner when the organization has none).
 */
const VICTIM_PLAYER_SQL = `COALESCE(
  CASE
    WHEN f.control_type IN ('city','city_seat') THEN (SELECT mayor_player_id FROM cities WHERE id=f.city_id)
    WHEN f.control_type IN ('kingdom','kingdom_seat') THEN (SELECT leader_player_id FROM kingdoms WHERE id=f.kingdom_id)
  END,
  f.owner_id)`;

type AttackTargetRow = {
  owner_id: string;
  control_type: string;
  anchor_kind: string;
  system_controlled: boolean;
  city_id: string | null;
  kingdom_id: string | null;
  reinforcement_level: number;
  tower_level?: number | null;
  obelisk_level?: number | null;
  war_structure_kind?: string | null;
  health: number | null;
  maximum_health: number | null;
  lat: number;
  lon: number;
  burning_reason: string | null;
  damage_cycle_id: string | null;
  developer_test_target: boolean;
  developer_test_creator_id: string | null;
  territory_collapse_id: string | null;
  name: string;
};

type BurnTargetRow = {
  flag_id: string;
  victim_player_id: string;
  flag_name: string;
  flag_lat: number;
  flag_lon: number;
  control_type: string;
  anchor_kind: string;
  system_controlled: boolean;
  reinforcement_level: number;
  tower_level?: number | null;
  obelisk_level?: number | null;
  war_structure_kind?: string | null;
  health: number | null;
  maximum_health: number | null;
  burning_reason: string | null;
  city_id: string | null;
  kingdom_id: string | null;
  city_name: string | null;
  city_lat: number | null;
  city_lon: number | null;
  victim_username: string;
  damage_cycle_id: string | null;
  developer_test_target: boolean;
  developer_test_creator_id: string | null;
  territory_collapse_id: string | null;
};

type BurnOperationRow = {
  operation_id: string;
  burner_player_id: string;
  victim_player_id: string;
  flag_id: string;
  request_id: string;
  flag_name: string;
  flag_lat: number;
  flag_lon: number;
  notice_message: string;
  started_at: Date | string;
  completes_at: Date | string;
  status: "active" | "cancelled" | "completed";
  reinforcement_level: number;
  burn_duration_ms: number;
  damage_cycle_id: string | null;
  remaining_duration_ms: number | string;
  paused_at: Date | string | null;
};

type DamageBurnTargetRow = {
  flag_id: string;
  victim_player_id: string;
  flag_name: string;
  flag_lat: number;
  flag_lon: number;
  control_type: string;
  anchor_kind: string;
  system_controlled: boolean;
  reinforcement_level: number;
  tower_level?: number | null;
  obelisk_level?: number | null;
  war_structure_kind?: string | null;
  health: number | null;
  maximum_health: number | null;
  burning_reason: string | null;
  city_id: string | null;
  kingdom_id: string | null;
  damage_cycle_id: string | null;
  developer_test_target: boolean;
  developer_test_creator_id: string | null;
  territory_collapse_id: string | null;
  city_name: string | null;
  city_lat: number | null;
  city_lon: number | null;
};

type ActiveDamageBurnOperationRow = BurnOperationRow & {
  source_kind: "player" | "developer_test" | "legendary_bird";
  developer_test_creator_id: string | null;
};

type RepairOperationRow = {
  operation_id: string;
  owner_player_id: string;
  flag_id: string;
  burn_operation_id: string | null;
  damage_cycle_id: string;
  request_id: string;
  flag_name: string;
  flag_lat: number;
  flag_lon: number;
  started_at: Date | string;
  completes_at: Date | string;
  paused_burn_remaining_ms: number | string;
  repair_kit_quantity: number;
  stone_quantity: number;
  status: "active" | "cancelled" | "completed" | "disrupted" | "server_refunded";
  cancel_reason?: string | null;
  completed_at?: Date | string | null;
  refund_applied?: boolean;
  result?: StoredRepairCompletion | null;
  repair_mode: "legacy" | "progressive";
  maximum_health: number | null;
  full_repair_ms: number | string | null;
  health_restored: number;
  organization_kind: "city" | "kingdom" | null;
  organization_id: string | null;
};

type DisruptOperationRow = {
  operation_id: string;
  contributor_player_id: string;
  flag_id: string;
  repair_operation_id: string;
  damage_cycle_id: string;
  request_id: string;
  started_at: Date | string;
  completes_at: Date | string;
  flag_lat: number;
  flag_lon: number;
  status: "active" | "cancelled" | "completed";
  result?: unknown;
};

type RepairTargetRow = {
  flag_id: string;
  owner_id: string;
  control_type: string;
  anchor_kind: string;
  system_controlled: boolean;
  city_id: string | null;
  kingdom_id: string | null;
  reinforcement_level: number;
  tower_level?: number | null;
  obelisk_level?: number | null;
  war_structure_kind?: string | null;
  health: number | null;
  maximum_health: number | null;
  burning_reason: string | null;
  lat: number;
  lon: number;
  name: string;
  damage_cycle_id: string | null;
  territory_collapse_id: string | null;
};

const REPAIR_TARGET_SELECT = `SELECT id::text AS flag_id,owner_id,control_type,anchor_kind,system_controlled,
       city_id::text,kingdom_id::text,reinforcement_level,tower_level,obelisk_level,war_structure_kind,health,maximum_health,
       burning_reason,lat,lon,name,damage_cycle_id::text,territory_collapse_id::text
FROM flags WHERE id=$1`;

const BURN_OPERATION_SELECT = `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
       request_id,flag_name,flag_lat,flag_lon,notice_message,
       started_at,completes_at,status,reinforcement_level,burn_duration_ms,
       damage_cycle_id,remaining_duration_ms,paused_at
FROM flag_burn_operations`;

const REPAIR_OPERATION_COLUMNS = `operation_id::text,owner_player_id,flag_id::text,burn_operation_id::text,
       damage_cycle_id::text,request_id,flag_name,flag_lat,flag_lon,
       started_at,completes_at,paused_burn_remaining_ms,repair_kit_quantity,
       stone_quantity,status,cancel_reason,completed_at,refund_applied,result,
       repair_mode,maximum_health,full_repair_ms,health_restored,
       organization_kind,organization_id::text`;

type StoredCompletion = Readonly<{
  inventory: PlayerInventorySnapshot;
  deletion: BurnFlagDeletionResult;
  replayed: boolean;
}>;

type StoredRepairCompletion = Readonly<{
  structureId: string;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
}>;

/** Durable warfare adapter for the retained personal Flag lifecycle. */
export class PersonalFlagWarfareAdapter implements StructureWarfareAdapter {
  readonly kind = PERSONAL_FLAG_WARFARE_KIND;

  constructor(
    private readonly flags: PersonalFlagWarfareFlagService,
    private readonly inventory: InventoryService
  ) {}

  async attack(input: StructureWarfareAttackInput): Promise<StructureWarfareAttackResult> {
    if (!input.player.online) {
      throw warfareError("attack", "FLAG_ATTACK_DISCONNECTED", "You must be online to attack a Flag.");
    }
    if (input.player.target && !input.strike) {
      throw warfareError("attack", "FLAG_ATTACK_MOVING", "Stop moving before attacking a Flag.");
    }
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`flag-attack:${input.playerId}:${input.requestId}`]
      );
      const existing = await client.query<{ flag_id: string; damage: number }>(
        `SELECT flag_id::text,damage
         FROM flag_attack_operations
         WHERE player_id=$1 AND request_id=$2
         FOR UPDATE`,
        [input.playerId, input.requestId]
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.flag_id !== input.structureId) {
          throw warfareError(
            "attack",
            "FLAG_ATTACK_IDEMPOTENCY_CONFLICT",
            "Flag attack request ID was reused for a different Flag."
          );
        }
        await client.query("COMMIT");
        const replayedFlag = await this.flags.getMapFlag(input.structureId);
        if (!replayedFlag) throw warfareError("attack", "FLAG_NOT_FOUND", "Flag does not exist.");
        return { structure: replayedFlag, damage: Number(prior.damage), replayed: true };
      }

      const locked = await client.query<AttackTargetRow>(
        `SELECT flags.owner_id,flags.control_type,flags.anchor_kind,flags.system_controlled,
                flags.city_id::text,flags.kingdom_id::text,flags.reinforcement_level,flags.tower_level,flags.obelisk_level,flags.war_structure_kind,flags.health,
                flags.maximum_health,flags.lat,flags.lon,flags.burning_reason,
                flags.damage_cycle_id,flags.developer_test_target,
                flags.territory_collapse_id::text,flags.name,
                test.creator_player_id AS developer_test_creator_id
         FROM flags
         LEFT JOIN developer_spawned_test_flags test ON test.flag_id=flags.id
         WHERE flags.id=$1 FOR UPDATE OF flags`,
        [input.structureId]
      );
      const flag = locked.rows[0];
      if (!flag) throw warfareError("attack", "FLAG_NOT_FOUND", "Flag does not exist.");
      // A marked developer fixture has a dedicated enemy identity. Its raw
      // creator owner is retained only for cleanup/replay bookkeeping, so it
      // must not make the fixture friendly to the creator or invisible to
      // another ordinary combatant.
      const isDeveloperTestTarget = flag.developer_test_target === true;
      const profile = warfareProfileForRow(flag);
      const organization = organizationOfFlag(flag);
      if (
        !profile ||
        (flag.territory_collapse_id ?? null) !== null ||
        (!organization && flag.owner_id === input.playerId && !isDeveloperTestTarget)
      ) {
        throw warfareError(
          "attack",
          "FLAG_ATTACK_TARGET_INVALID",
          "Only another player's Flag or a hostile city or kingdom structure can be attacked."
        );
      }
      if (organization && isAlliedOrganizationStructure(await loadPlayerOrganizations(client, input.playerId), flag)) {
        throw warfareError(
          "attack",
          "FLAG_ATTACK_ALLY",
          "You cannot attack a structure of your own city or kingdom."
        );
      }
      const attackPeace = organization
        ? await forcedPeaceRefusalInTransaction(client, input.playerId, organization)
        : null;
      if (attackPeace) throw warfareError("attack", "FLAG_ATTACK_FORCED_PEACE", attackPeace);
      if (flag.burning_reason !== null) {
        throw warfareError(
          "attack",
          "FLAG_ATTACK_BURNING",
          "A Flag cannot be attacked while it is burning."
        );
      }
      const reachOrigin = input.strike?.origin ?? input.player.position;
      const reachRadiusM = input.strike?.radiusM ?? STRUCTURE_WARFARE_INTERACTION_RADIUS_M;
      if (distanceMeters(reachOrigin, { lat: Number(flag.lat), lon: Number(flag.lon) }) > reachRadiusM) {
        throw warfareError(
          "attack",
          "FLAG_ATTACK_OUT_OF_RANGE",
          `Move within ${STRUCTURE_WARFARE_INTERACTION_RADIUS_M}m of the Flag before attacking it.`
        );
      }
      if (
        flag.health === null ||
        flag.maximum_health === null ||
        Number(flag.maximum_health) !== profile.maximumHealth
      ) {
        throw warfareError(
          "attack",
          "FLAG_ATTACK_TARGET_INVALID",
          "This Flag has no attackable health."
        );
      }
      // Hand attacks never push a structure below its burn threshold; for city
      // and kingdom structures this is the must-burn rule.
      const breachThreshold = profile.burnThreshold;
      const health = Number(flag.health);
      if (health <= breachThreshold) {
        throw warfareError(
          "attack",
          "FLAG_ATTACK_THRESHOLD_REACHED",
          "This Flag is ready to burn; no more attacks are needed."
        );
      }
      // Braced Foundations / Warded Monuments soften each hit on the
      // defending kingdom's structures.
      // A pet strike (Tail Lash) hits for 100-120 instead of the normal 25, with the same
      // reductions, and never past the burn threshold.
      const baseHit = input.strike?.damage !== undefined
        ? input.strike.damage
        : input.strike
        ? randomInt(PET_TAIL_LASH_STRUCTURE_DAMAGE.min, PET_TAIL_LASH_STRUCTURE_DAMAGE.max + 1)
        : STRUCTURE_WARFARE_ATTACK_DAMAGE;
      const reducedHit = reducedStructureHit(
        baseHit *
          (await hasActiveRepair(client, input.structureId) ? STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER : 1),
        await kingdomStructureDamageReduction(client, input.structureId)
      );
      const attackDamage = input.strike ? Math.min(reducedHit, health - breachThreshold) : reducedHit;
      const cooldown = await client.query<{ remaining_ms: number | string }>(
        `SELECT GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (
                    attacked_at + ($3::bigint * interval '1 millisecond') - now()
                  )) * 1000
                )::bigint AS remaining_ms
         FROM flag_attack_cooldowns
         WHERE flag_id=$1 AND player_id=$2
         FOR UPDATE`,
        [input.structureId, input.playerId, STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS]
      );
      const remainingMs = Number(cooldown.rows[0]?.remaining_ms ?? 0);
      if (remainingMs > 0) {
        const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1_000));
        throw warfareError(
          "attack",
          "FLAG_ATTACK_COOLDOWN",
          `You can attack this Flag again in about ${remainingHours} hour${remainingHours === 1 ? "" : "s"}.`
        );
      }
      const updated = await client.query<{ health: number; damage_cycle_id: string }>(
        `UPDATE flags
         SET health=GREATEST($3::integer,health-$2::integer),
             damage_cycle_id=COALESCE(damage_cycle_id,gen_random_uuid())
         WHERE id=$1 AND health > $3::integer
         RETURNING health,damage_cycle_id::text`,
        [input.structureId, attackDamage, breachThreshold]
      );
      if (updated.rowCount !== 1) {
        throw warfareError("attack", "FLAG_ATTACK_THRESHOLD_REACHED", "This Flag is ready to burn.");
      }
      const dealtDamage = health - Number(updated.rows[0]!.health);
      await client.query(
        `INSERT INTO flag_attack_cooldowns (flag_id,player_id,attacked_at)
         VALUES ($1,$2,now())
         ON CONFLICT (flag_id,player_id) DO UPDATE SET attacked_at=EXCLUDED.attacked_at`,
        [input.structureId, input.playerId]
      );
      const operation = await client.query<{ flag_id: string; damage: number }>(
        `INSERT INTO flag_attack_operations (flag_id,player_id,request_id,damage,damage_cycle_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (player_id,request_id) DO NOTHING
         RETURNING flag_id::text,damage`,
        [input.structureId, input.playerId, input.requestId, dealtDamage, updated.rows[0]!.damage_cycle_id]
      );
      if (operation.rowCount !== 1) {
        const replay = await client.query<{ flag_id: string; damage: number }>(
          `SELECT flag_id::text,damage
           FROM flag_attack_operations
           WHERE player_id=$1 AND request_id=$2
           FOR UPDATE`,
          [input.playerId, input.requestId]
        );
        const replayed = replay.rows[0];
        if (!replayed || replayed.flag_id !== input.structureId) {
          throw warfareError(
            "attack",
            "FLAG_ATTACK_IDEMPOTENCY_CONFLICT",
            "Flag attack request ID was reused for a different Flag."
          );
        }
        await client.query("COMMIT");
        const replayedFlag = await this.flags.getMapFlag(input.structureId);
        if (!replayedFlag) throw warfareError("attack", "FLAG_NOT_FOUND", "Flag does not exist.");
        return { structure: replayedFlag, damage: Number(replayed.damage), replayed: true };
      }
      // Developer fixtures intentionally keep the creator as the durable
      // cleanup owner. Declaring that owner (or any attacker) hostile would
      // mutate ordinary social state; the durable marker above is the narrow
      // hostility identity for this test target instead.
      if (organization) {
        // City and kingdom structures belong to the organization: the
        // hostility is a war (when the attacker fights for one) plus the
        // defender's "under attack" alert, never a personal enemy mark.
        await recordOrganizationHostilityInTransaction(client, {
          attackerPlayerId: input.playerId,
          defender: organization,
          profile,
          structureName: flag.name
        });
      } else if (!isDeveloperTestTarget) {
        await declareFlagEnemy(client, input.playerId, flag.owner_id);
      }
      await client.query("COMMIT");
      const updatedFlag = await this.flags.getMapFlag(input.structureId);
      if (!updatedFlag) throw warfareError("attack", "FLAG_NOT_FOUND", "Flag no longer exists.");
      return {
        structure: updatedFlag,
        damage: dealtDamage,
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveIgnition(input: StructureWarfareIgnitionInput): Promise<StructureWarfareIgnitionStartResult> {
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`flag-burn:${input.playerId}:${input.requestId}`]
      );
      const existing = await client.query<BurnOperationRow>(
        `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
                request_id,flag_name,flag_lat,flag_lon,notice_message,
                started_at,completes_at,status,reinforcement_level,burn_duration_ms,
                damage_cycle_id,remaining_duration_ms,paused_at
         FROM flag_burn_operations
         WHERE source_kind IN ('player','developer_test') AND burner_player_id=$1 AND request_id=$2
         FOR UPDATE`,
        [input.playerId, input.requestId]
      );
      if (existing.rows[0]) {
        const row = existing.rows[0]!;
        if (row.flag_id !== input.structureId) {
          throw warfareError(
            "ignition",
            "FLAG_BURN_IDEMPOTENCY_CONFLICT",
            "Flag burn request ID was reused for a different Flag."
          );
        }
        const inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
        await client.query("COMMIT");
        return {
          operation: operationFromRow(row),
          replayed: true,
          status: row.status,
          inventory
        };
      }

      const target = await client.query<BurnTargetRow>(
        `SELECT f.id::text AS flag_id,${VICTIM_PLAYER_SQL} AS victim_player_id,f.name AS flag_name,
                f.lat AS flag_lat,f.lon AS flag_lon,f.control_type,f.anchor_kind,
                f.system_controlled,f.reinforcement_level,f.tower_level,f.obelisk_level,f.war_structure_kind,f.health,f.maximum_health,
                f.burning_reason,f.city_id::text,f.kingdom_id::text,
                f.territory_collapse_id::text,
                f.damage_cycle_id,
                owner.username AS victim_username,
                f.developer_test_target,
                test.creator_player_id AS developer_test_creator_id,
                nearest.name AS city_name,nearest.hall_lat AS city_lat,nearest.hall_lon AS city_lon
         FROM flags f
         JOIN players owner ON owner.id=${VICTIM_PLAYER_SQL}
         LEFT JOIN developer_spawned_test_flags test ON test.flag_id=f.id
         LEFT JOIN LATERAL (
           SELECT city.name,city.hall_lat,city.hall_lon
           FROM cities city
           WHERE city.active
           ORDER BY ST_Distance(city.hall_geom::geography,f.geom::geography),city.id
           LIMIT 1
         ) nearest ON true
         WHERE f.id=$1
         FOR UPDATE OF f`,
        [input.structureId]
      );
      const flag = target.rows[0];
      if (!flag) throw warfareError("ignition", "FLAG_NOT_FOUND", "Flag does not exist.");
      const active = await client.query<ActiveDamageBurnOperationRow>(
        `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
                request_id,flag_name,flag_lat,flag_lon,notice_message,
                started_at,completes_at,status,reinforcement_level,burn_duration_ms,
                damage_cycle_id,remaining_duration_ms,paused_at,
                source_kind,developer_test_creator_id
         FROM flag_burn_operations
         WHERE flag_id=$1::uuid AND status='active'
           AND source_kind IN ('player','developer_test')
         ORDER BY operation_id
         LIMIT 1`,
        [input.structureId]
      );
      const activeOperation = active.rows[0];
      if (activeOperation) {
        if (flag.health !== null && Number(flag.health) <= 0) {
          await client.query(
            `UPDATE flag_burn_operations
             SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp(),paused_at=NULL
             WHERE operation_id=$1::uuid AND status='active'`,
            [activeOperation.operation_id]
          );
          await client.query(
            `UPDATE flags
             SET burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
             WHERE id=$1::uuid`,
            [input.structureId]
          );
          await client.query("COMMIT");
          throw warfareError("ignition", "FLAG_BURN_TARGET_INVALID", "This Flag is not ready to burn.");
        }
        // A damage-triggered operation is already the canonical reservation,
        // so any later Torch/retry request may attach to it without another
        // debit.  Preserve the normal one-request/one-winner boundary for
        // concurrent manual ignition requests.
        if (
          activeOperation.request_id !== input.requestId &&
          !activeOperation.request_id.startsWith("damage-trigger:")
        ) {
          throw warfareError("ignition", "FLAG_BURN_ACTIVE", "That Flag is already being burned.");
        }
        await syncBurnPresentationInTransaction(client, activeOperation);
        const inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
        await client.query("COMMIT");
        return {
          operation: operationFromRow(activeOperation),
          replayed: true,
          status: activeOperation.status,
          inventory
        };
      }
      const profile = assertBurnableDatabaseTarget(input.playerId, flag);
      const organization = organizationOfFlag(flag);
      if (organization && isAlliedOrganizationStructure(await loadPlayerOrganizations(client, input.playerId), flag)) {
        throw warfareError(
          "ignition",
          "FLAG_BURN_ALLY",
          "You cannot burn a structure of your own city or kingdom."
        );
      }
      const burnPeace = organization
        ? await forcedPeaceRefusalInTransaction(client, input.playerId, organization)
        : null;
      if (burnPeace) throw warfareError("ignition", "FLAG_BURN_FORCED_PEACE", burnPeace);
      if (
        distanceMeters(input.player.position, { lat: Number(flag.flag_lat), lon: Number(flag.flag_lon) }) >
        STRUCTURE_WARFARE_INTERACTION_RADIUS_M
      ) {
        throw warfareError(
          "ignition",
          "FLAG_BURN_OUT_OF_RANGE",
          `Move within ${STRUCTURE_WARFARE_INTERACTION_RADIUS_M}m of the Flag before burning it.`
        );
      }
      const legendaryEvent = await client.query(
        `SELECT 1 FROM legendary_bird_events
         WHERE flag_id=$1 AND status IN ('pending','active') LIMIT 1`,
        [input.structureId]
      );
      if (legendaryEvent.rowCount !== 0) {
        throw warfareError(
          "ignition",
          "FLAG_BURN_TARGET_INVALID",
          "This Flag cannot be burned while its legendary encounter is available."
        );
      }
      const developerTestCreatorId =
        flag.developer_test_target === true &&
        flag.developer_test_creator_id === input.playerId &&
        flag.victim_player_id === input.playerId
          ? flag.developer_test_creator_id
          : null;
      const burnSourceKind = developerTestCreatorId === null ? "player" : "developer_test";
      await this.inventory.lockPlayerInventoryForOperationInTransaction(client, input.playerId);
      const torch = await client.query<{ quantity: string }>(
        `SELECT COALESCE(sum(quantity),0)::text AS quantity
         FROM player_inventory
         WHERE player_id=$1 AND resource_type='torch' AND variant='default'`,
        [input.playerId]
      );
      if (BigInt(torch.rows[0]?.quantity ?? "0") < BigInt(STRUCTURE_WARFARE_TORCH_COST.quantity)) {
        throw warfareError("ignition", "FLAG_BURN_TORCH_REQUIRED", "You need a Torch to burn a Flag.");
      }
      const durationMs = profile.burnDurationMs;
      const noticeMessage = buildBurnNotice(flag, durationMs, profile.kind);
      const operation = await client.query<BurnOperationRow>(
        `INSERT INTO flag_burn_operations (
           burner_player_id,victim_player_id,flag_id,request_id,flag_name,
           flag_lat,flag_lon,notice_message,started_at,completes_at,
           reinforcement_level,burn_duration_ms,damage_cycle_id,remaining_duration_ms,
           source_kind,developer_test_creator_id,burn_start_health,burn_damage_budget
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),
                   now()+($9::bigint * interval '1 millisecond'),$10,$9,
                   COALESCE($11,gen_random_uuid()),$9,$12,$13,$14,$15)
         ON CONFLICT DO NOTHING
         RETURNING operation_id::text,burner_player_id,victim_player_id,flag_id::text,
                   request_id,flag_name,flag_lat,flag_lon,notice_message,
                   started_at,completes_at,status,reinforcement_level,burn_duration_ms,
                   damage_cycle_id,remaining_duration_ms,paused_at`,
        [
          input.playerId,
          flag.victim_player_id,
          input.structureId,
          input.requestId,
          flag.flag_name,
          Number(flag.flag_lat),
          Number(flag.flag_lon),
          noticeMessage,
          durationMs,
          Number(flag.reinforcement_level),
          flag.damage_cycle_id,
          burnSourceKind,
          developerTestCreatorId,
          Number(flag.health),
          Math.floor(Number(flag.maximum_health) / 2)
        ]
      );
      if (operation.rowCount !== 1) {
        const byRequest = await client.query<BurnOperationRow>(
          `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
                  request_id,flag_name,flag_lat,flag_lon,notice_message,
                  started_at,completes_at,status,reinforcement_level,burn_duration_ms,
                  damage_cycle_id,remaining_duration_ms,paused_at
           FROM flag_burn_operations
           WHERE source_kind IN ('player','developer_test') AND burner_player_id=$1 AND request_id=$2
           FOR UPDATE`,
          [input.playerId, input.requestId]
        );
        const row = byRequest.rows[0];
        if (row) {
          const inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
          await client.query("COMMIT");
          return { operation: operationFromRow(row), replayed: true, status: row.status, inventory };
        }
        throw warfareError("ignition", "FLAG_BURN_ACTIVE", "That Flag is already being burned.");
      }
      const row = operation.rows[0]!;
      if (organization) {
        await recordOrganizationHostilityInTransaction(client, {
          attackerPlayerId: input.playerId,
          defender: organization,
          profile,
          structureName: flag.flag_name
        });
      } else if (!flag.developer_test_target) {
        await declareFlagEnemy(client, input.playerId, flag.victim_player_id);
      }
      await client.query(
        `INSERT INTO player_inbox_entries (
         id,player_id,entry_kind,message,created_at,status,event_kind,event_id
         ) VALUES (gen_random_uuid(),$1,'game_notice',$2,now(),'notice',$3,$4)
         ON CONFLICT (player_id,event_kind,event_id)
           WHERE entry_kind='game_notice' DO NOTHING`,
        [flag.victim_player_id, noticeMessage, FLAG_BURN_EVENT_KIND, row.operation_id]
      );
      await client.query(
        `UPDATE flags
         SET burning_started_at=$2, burning_until=$3, burning_reason='flag_burn',
             damage_cycle_id=COALESCE(damage_cycle_id,$4)
         WHERE id=$1`,
        [input.structureId, row.started_at, row.completes_at, row.damage_cycle_id]
      );
      // Torch consumption is part of the successful ignition transaction. It
      // follows every target revalidation and is rolled back with the operation
      // if any later write fails.
      const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `flag-burn:${row.operation_id}:torch`,
        playerId: input.playerId,
        source: "flag_burn",
        sourceEntityType: "flag_burn_operation",
        sourceEntityId: row.operation_id,
        debits: [{ ...STRUCTURE_WARFARE_TORCH_COST, variant: DEFAULT_INVENTORY_VARIANT }]
      });
      await client.query("COMMIT");
      return {
        operation: operationFromRow(row),
        replayed: false,
        status: "active",
        inventory: debited.inventory
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryShortage(error)) {
        throw warfareError("ignition", "FLAG_BURN_TORCH_REQUIRED", "You need a Torch to burn a Flag.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async completeIgnition(input: Readonly<{
    kind: typeof PERSONAL_FLAG_WARFARE_KIND;
    operationId: string;
    playerId: string;
    structureId: string;
    now: number;
  }>): Promise<StructureWarfareIgnitionCompletion | null> {
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<BurnOperationRow & { result: StoredCompletion | null }>(
        `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
                request_id,flag_name,flag_lat,flag_lon,notice_message,
                started_at,completes_at,status,reinforcement_level,burn_duration_ms,
                damage_cycle_id,remaining_duration_ms,paused_at,result
         FROM flag_burn_operations
         WHERE source_kind IN ('player','developer_test') AND operation_id=$1 AND burner_player_id=$2 AND flag_id=$3
         FOR UPDATE`,
        [input.operationId, input.playerId, input.structureId]
      );
      const row = current.rows[0];
      if (!row || row.status !== "active" || row.paused_at != null) {
        await client.query("COMMIT");
        return null;
      }
      const due = await client.query<{ due: boolean }>(
        "SELECT clock_timestamp() >= $1::timestamptz AS due",
        [row.completes_at]
      );
      if (!due.rows[0]?.due) {
        await client.query("COMMIT");
        return null;
      }
      const result = await this.completeBurnInTransaction(client, row);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async completeBurnInTransaction(
    client: pg.PoolClient,
    operation: BurnOperationRow
  ): Promise<StructureWarfareIgnitionCompletion> {
    const burnedOrganization = await burnOutOrganizationStructureInTransaction(client, operation);
    const flagDeletion = burnedOrganization ??
      await this.flags.deleteFlagForBurnInTransaction(client, operation.flag_id, operation.burner_player_id);
    const inventory = await this.inventory.snapshotInTransaction(client, operation.burner_player_id);
    const deletion: StructureWarfareDeletionResult = {
      structureId: flagDeletion.flagId,
      affectedStructureIds: flagDeletion.affectedFlagIds ?? [],
      notificationPlayerIds: flagDeletion.notificationPlayerIds ?? []
    };
    const result: StoredCompletion = { inventory, deletion: flagDeletion, replayed: false };
    await client.query(
      `UPDATE flag_burn_operations SET status='completed',completed_at=clock_timestamp(),result=$2::jsonb
       WHERE source_kind IN ('player','developer_test') AND operation_id=$1`,
      [operation.operation_id, JSON.stringify(result)]
    );
    return { inventory, deletion, replayed: false };
  }

  async cancelIgnition(input: Readonly<{
    kind: typeof PERSONAL_FLAG_WARFARE_KIND;
    operationId: string;
    structureId: string;
    reason: string;
  }>): Promise<void> {
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      const changed = await client.query(
        `UPDATE flag_burn_operations
         SET status='cancelled',cancel_reason=$2,completed_at=now(),paused_at=NULL
         WHERE source_kind IN ('player','developer_test') AND operation_id=$1 AND status='active' AND paused_at IS NULL`,
        [input.operationId, input.reason]
      );
      if ((changed.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE flags
           SET burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
           WHERE id=$1 AND burning_reason='flag_burn'`,
          [input.structureId]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileIgnitions(_kind: typeof PERSONAL_FLAG_WARFARE_KIND): Promise<readonly StructureWarfareIgnitionOperation[]> {
    void _kind;
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ActiveDamageBurnOperationRow>(
        `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
                request_id,flag_name,flag_lat,flag_lon,notice_message,
                started_at,completes_at,status,reinforcement_level,burn_duration_ms,
                damage_cycle_id,remaining_duration_ms,paused_at,
                source_kind,developer_test_creator_id
         FROM flag_burn_operations
         WHERE source_kind IN ('player','developer_test') AND status='active'
         ORDER BY flag_id,completes_at,operation_id`
      );
      const operations: StructureWarfareIgnitionOperation[] = [];
      for (const operation of result.rows) {
        // Match every damage writer's flag -> operation lock order.  The
        // operation may have completed between the initial scan and this
        // lock, so re-read it before publishing the reconciled session.
        const flag = await client.query<{ id: string; health: number | null; maximum_health: number | null }>(
          "SELECT id::text,health,maximum_health FROM flags WHERE id=$1::uuid FOR UPDATE",
          [operation.flag_id]
        );
        const lockedFlag = flag.rows[0];
        if (!lockedFlag) {
          // A durable burn must never outlive its target.  Retire an orphaned
          // operation while holding the same target-row lock used by damage
          // and completion paths (there is no row to mirror in this case).
          await client.query(
            `UPDATE flag_burn_operations
             SET status='cancelled',cancel_reason='flag-missing',completed_at=clock_timestamp(),paused_at=NULL
             WHERE operation_id=$1::uuid AND status='active'`,
            [operation.operation_id]
          );
          continue;
        }
        const current = await client.query<ActiveDamageBurnOperationRow>(
          `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
                  request_id,flag_name,flag_lat,flag_lon,notice_message,
                  started_at,completes_at,status,reinforcement_level,burn_duration_ms,
                  damage_cycle_id,remaining_duration_ms,paused_at,
                  source_kind,developer_test_creator_id
           FROM flag_burn_operations
           WHERE operation_id=$1::uuid AND status='active'
           FOR UPDATE SKIP LOCKED`,
          [operation.operation_id]
        );
        const row = current.rows[0];
        if (!row) {
          // A repair/completion may hold the burn lock while awaiting the Flag
          // lock. Do not wait in the reverse order or drop its runtime session.
          operations.push(operationFromRow(operation));
          continue;
        }
        if (lockedFlag.health !== null && Number(lockedFlag.health) <= 0) {
          // A final damage write may destroy a burning target before the
          // runtime poll observes it.  Close the operation and clear the
          // presentation mirror atomically so retries do not report a stale
          // active burn and no completion can outlive the structure.
          await client.query(
            `UPDATE flag_burn_operations
             SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp(),paused_at=NULL
             WHERE operation_id=$1::uuid AND status='active'`,
            [row.operation_id]
          );
          await client.query(
            `UPDATE flags
             SET burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
             WHERE id=$1::uuid AND burning_reason='flag_burn'`,
            [row.flag_id]
          );
          continue;
        }
        await syncBurnPresentationInTransaction(client, row);
        // Active elapsed time follows the durable deadline (shifted on resume).
        // Whole minute buckets carry fractional HP via the cumulative cursor.
        const damage = await client.query<{ health: number }>(
          `WITH progress AS (
             SELECT operation_id,flag_id,burn_damage_applied,
                    COALESCE(burn_damage_budget,$2::integer) AS damage_budget,
                    FLOOR(COALESCE(burn_damage_budget,$2::integer)
                      * FLOOR(GREATEST(0,LEAST(burn_duration_ms,
                          burn_duration_ms-EXTRACT(EPOCH FROM (completes_at-clock_timestamp()))*1000
                        ))/60000)*60000/burn_duration_ms::numeric)::integer AS damage_due
             FROM flag_burn_operations
             WHERE operation_id=$1::uuid AND status='active' AND paused_at IS NULL
               AND completes_at>clock_timestamp()
           ), applied AS (
             UPDATE flag_burn_operations operation
             SET burn_damage_budget=progress.damage_budget,
                 burn_damage_applied=GREATEST(progress.burn_damage_applied,progress.damage_due)
             FROM progress WHERE operation.operation_id=progress.operation_id
             RETURNING progress.flag_id,
               GREATEST(0,progress.damage_due-progress.burn_damage_applied) AS damage
           )
           UPDATE flags flag SET health=GREATEST(0,flag.health-applied.damage)
           FROM applied WHERE flag.id=applied.flag_id AND applied.damage>0 AND flag.health>0
           RETURNING flag.health`,
          [row.operation_id, Math.floor(Number(lockedFlag.maximum_health) / 2)]
        );
        if (damage.rows[0]?.health === 0) {
          // Low ignition HP and independent Siege hits shorten remaining life,
          // never the fixed rate. Use the same atomic terminal path as expiry.
          const completion = await this.completeBurnInTransaction(client, row);
          operations.push({ ...operationFromRow(row), completion });
        } else {
          operations.push({ ...operationFromRow(row), healthChanged: damage.rowCount !== 0 });
        }
      }
      await client.query("COMMIT");
      return operations;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Starts a progressive repair channel: health returns at 5x the burn rate,
   * an active burn pauses for as long as the channel runs, and materials are
   * billed per 25-health chunk (the first chunk up front). Owners repair
   * personal Stone Flags and Towers; any member (Mayor included) repairs city
   * structures and any member repairs kingdom structures.
   */
  async reserveRepair(input: Readonly<{
    kind: typeof PERSONAL_FLAG_WARFARE_KIND;
    playerId: string;
    structureId: string;
    requestId: string;
    player: StructureWarfareRepairPlayer;
  }>): Promise<StructureWarfareRepairStartResult> {
    if (!input.player.online) {
      throw warfareError("repair", "FLAG_REPAIR_DISCONNECTED", "You must be online to repair a Flag.");
    }
    if (input.player.target) {
      throw warfareError("repair", "FLAG_REPAIR_MOVING", "Stop moving before repairing a Flag.");
    }
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`flag-repair:${input.playerId}:${input.requestId}`]
      );
      const existing = await client.query<RepairOperationRow>(
        repairOperationSelect("owner_player_id=$1 AND request_id=$2") + " FOR UPDATE",
        [input.playerId, input.requestId]
      );
      if (existing.rows[0]) {
        const row = existing.rows[0]!;
        if (row.flag_id !== input.structureId) {
          throw warfareError("repair", "FLAG_REPAIR_IDEMPOTENCY_CONFLICT", "Flag repair request ID was reused for a different Flag.");
        }
        const inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
        await client.query("COMMIT");
        return { operation: repairOperationFromRow(row), replayed: true, status: row.status, inventory };
      }

      // Match every other Flag terminal path: disrupt -> repair -> burn ->
      // flag.  Locking an existing active repair before taking the burn lock
      // prevents owner demolition from deadlocking a concurrent reservation.
      const activeRepair = await client.query<{ operation_id: string }>(
        `SELECT operation_id
         FROM flag_repair_operations
         WHERE flag_id=$1 AND status='active'
         FOR UPDATE`,
        [input.structureId]
      );
      if (activeRepair.rowCount !== 0) {
        throw warfareError("repair", "FLAG_REPAIR_ACTIVE", "That Flag is already being repaired.");
      }

      const burn = await client.query<BurnOperationRow>(
        `${BURN_OPERATION_SELECT}
         WHERE source_kind IN ('player','developer_test') AND flag_id=$1 AND status='active'
         FOR UPDATE`,
        [input.structureId]
      );
      const burnRow = burn.rows[0] ?? null;
      if (burnRow && burnRow.paused_at !== null) {
        throw warfareError("repair", "FLAG_REPAIR_ACTIVE", "That Flag is already being repaired.");
      }
      let remainingMs = 0;
      if (burnRow) {
        const remaining = await client.query<{ remaining_ms: string }>(
          `SELECT GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (completes_at-clock_timestamp()))*1000)
                  )::bigint AS remaining_ms
           FROM flag_burn_operations WHERE operation_id=$1`,
          [burnRow.operation_id]
        );
        remainingMs = Number(remaining.rows[0]?.remaining_ms ?? 0);
        if (remainingMs <= 0) {
          throw warfareError("repair", "FLAG_REPAIR_BURN_EXPIRED", "This Flag's burn is completing now.");
        }
      }

      const locked = await client.query<RepairTargetRow>(
        `${REPAIR_TARGET_SELECT} FOR UPDATE`,
        [input.structureId]
      );
      const flag = locked.rows[0];
      if (!flag) throw warfareError("repair", "FLAG_NOT_FOUND", "Flag does not exist.");
      const profile = warfareProfileForRow(flag);
      const health = flag.health === null ? null : Number(flag.health);
      if (
        !profile || !profile.repairable ||
        (flag.territory_collapse_id ?? null) !== null ||
        health === null || health <= 0 || health >= profile.maximumHealth ||
        Number(flag.maximum_health) !== profile.maximumHealth ||
        (flag.burning_reason !== null && (
          flag.burning_reason !== "flag_burn" ||
          !burnRow ||
          flag.damage_cycle_id === null ||
          burnRow.damage_cycle_id !== flag.damage_cycle_id
        )) ||
        (flag.burning_reason === null && burnRow !== null)
      ) {
        throw warfareError(
          "repair",
          "FLAG_REPAIR_TARGET_INVALID",
          "Only a damaged Stone Flag, Tower, or city or kingdom structure can be repaired."
        );
      }
      const legendaryEvent = await client.query(
        `SELECT 1 FROM legendary_bird_events
         WHERE flag_id=$1 AND status IN ('pending','active') LIMIT 1`,
        [input.structureId]
      );
      if (legendaryEvent.rowCount !== 0) {
        throw warfareError("repair", "FLAG_REPAIR_TARGET_INVALID", "This Flag cannot be repaired while its legendary encounter is available.");
      }
      const organization = organizationOfFlag(flag);
      if (organization) {
        if (!isAlliedOrganizationStructure(await loadPlayerOrganizations(client, input.playerId), flag)) {
          throw warfareError(
            "repair",
            "FLAG_REPAIR_FORBIDDEN",
            organization.kind === "city"
              ? "Only members of this city can repair it."
              : "Only members of this kingdom can repair it."
          );
        }
      } else if (flag.owner_id !== input.playerId) {
        throw warfareError("repair", "FLAG_REPAIR_FORBIDDEN", "Only the owner can repair this Flag.");
      }
      if (distanceMeters(input.player.position, { lat: Number(flag.lat), lon: Number(flag.lon) }) > STRUCTURE_WARFARE_INTERACTION_RADIUS_M) {
        throw warfareError("repair", "FLAG_REPAIR_OUT_OF_RANGE", `Move within ${STRUCTURE_WARFARE_INTERACTION_RADIUS_M}m of the Flag before repairing it.`);
      }
      const cycle = await client.query<{ damage_cycle_id: string }>(
        `UPDATE flags SET damage_cycle_id=COALESCE(damage_cycle_id,gen_random_uuid())
         WHERE id=$1 RETURNING damage_cycle_id::text`,
        [input.structureId]
      );
      const fullRepairMs = structureWarfareFullRepairMs(profile);
      const projectedMs = projectedRepairMs(profile.maximumHealth - health, profile.maximumHealth, fullRepairMs);
      const inserted = await client.query<RepairOperationRow>(
        `INSERT INTO flag_repair_operations (
           owner_player_id,flag_id,burn_operation_id,damage_cycle_id,request_id,
           flag_name,flag_lat,flag_lon,started_at,completes_at,
           paused_burn_remaining_ms,repair_kit_quantity,stone_quantity,
           repair_mode,maximum_health,full_repair_ms,organization_kind,organization_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp(),
                   clock_timestamp()+($9::bigint*interval '1 millisecond'),$10,0,0,
                   'progressive',$11,$12,$13,$14::uuid)
         ON CONFLICT DO NOTHING
         RETURNING ${REPAIR_OPERATION_COLUMNS}`,
        [
          input.playerId, input.structureId, burnRow?.operation_id ?? null, cycle.rows[0]!.damage_cycle_id,
          input.requestId, flag.name, Number(flag.lat), Number(flag.lon), projectedMs, remainingMs,
          profile.maximumHealth, fullRepairMs,
          organization?.kind ?? null, organization?.id ?? null
        ]
      );
      if (inserted.rowCount !== 1) {
        throw warfareError("repair", "FLAG_REPAIR_ACTIVE", "That Flag is already being repaired.");
      }
      const row = inserted.rows[0]!;
      if (burnRow) {
        await client.query(
          `UPDATE flag_burn_operations
           SET paused_at=clock_timestamp(),
               remaining_duration_ms=$2,
               completes_at=clock_timestamp()+($2::bigint*interval '1 millisecond')
           WHERE source_kind IN ('player','developer_test') AND operation_id=$1 AND status='active' AND paused_at IS NULL`,
          [burnRow.operation_id, remainingMs]
        );
      }
      const current = await client.query<RepairOperationRow>(
        repairOperationSelect("operation_id=$1"),
        [row.operation_id]
      );
      const inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
      await client.query("COMMIT");
      return { operation: repairOperationFromRow(current.rows[0] ?? row), replayed: false, status: "active", inventory };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Advances one repair channel: applies the health earned since the channel
   * started (5x the burn rate) and completes at full health. Repair is free;
   * it costs only the time spent channeling in range.
   */
  async advanceRepair(input: Readonly<{
    kind: typeof PERSONAL_FLAG_WARFARE_KIND;
    operationId: string;
    playerId: string;
    structureId: string;
  }>): Promise<StructureWarfareRepairProgress | null> {
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      // All terminal paths for a Flag use disrupt -> repair -> burn -> flag
      // lock order.
      await client.query(
        `SELECT operation_id
         FROM flag_repair_disrupt_operations
         WHERE repair_operation_id=$1 AND status='active'
         ORDER BY operation_id
         FOR UPDATE`,
        [input.operationId]
      );
      const current = await client.query<RepairOperationRow>(
        repairOperationSelect("operation_id=$1 AND owner_player_id=$2") + " FOR UPDATE",
        [input.operationId, input.playerId]
      );
      const row = current.rows[0];
      if (!row || row.status !== "active" || row.repair_mode !== "progressive") {
        await client.query("COMMIT");
        if (row?.status === "completed" && row.result) {
          const structure = await this.flags.getMapFlag(input.structureId);
          return structure ? { status: "completed", structure, inventory: row.result.inventory, replayed: true } : null;
        }
        return null;
      }
      const burnRow = await lockRepairBurn(client, row);
      const locked = await client.query<RepairTargetRow>(`${REPAIR_TARGET_SELECT} FOR UPDATE`, [input.structureId]);
      const flag = locked.rows[0];
      const profile = flag ? warfareProfileForRow(flag) : null;
      const health = flag?.health === null || flag?.health === undefined ? null : Number(flag.health);
      if (
        !flag || !profile || health === null || health <= 0 ||
        (flag.territory_collapse_id ?? null) !== null ||
        Number(flag.maximum_health) !== Number(row.maximum_health) ||
        (row.burn_operation_id !== null && (!burnRow || burnRow.status !== "active" || burnRow.paused_at === null))
      ) {
        await endRepairInTransaction(client, row, burnRow, health ?? 0, profile?.burnThreshold ?? 0, "cancelled", "revalidation-failed");
        await client.query("COMMIT");
        return { status: "stopped", reason: "revalidation-failed" };
      }
      const elapsed = await client.query<{ elapsed_ms: string }>(
        `SELECT GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (clock_timestamp()-started_at))*1000))::bigint AS elapsed_ms
         FROM flag_repair_operations WHERE operation_id=$1`,
        [row.operation_id]
      );
      const maximumHealth = Number(row.maximum_health);
      const fullRepairMs = Number(row.full_repair_ms);
      const due = Math.floor((Number(elapsed.rows[0]?.elapsed_ms ?? 0) * maximumHealth) / fullRepairMs);
      const restored = Number(row.health_restored);
      const apply = Math.max(0, Math.min(due - restored, maximumHealth - health));
      if (apply > 0) {
        await client.query(
          "UPDATE flags SET health=LEAST(maximum_health,health+$2::integer) WHERE id=$1",
          [input.structureId, apply]
        );
        await client.query(
          "UPDATE flag_repair_operations SET health_restored=health_restored+$2 WHERE operation_id=$1",
          [row.operation_id, apply]
        );
      }
      const nextHealth = health + apply;
      if (nextHealth >= maximumHealth) {
        await client.query(
          `UPDATE flags
           SET health=maximum_health,burning_started_at=NULL,burning_until=NULL,burning_reason=NULL,damage_cycle_id=NULL
           WHERE id=$1`,
          [input.structureId]
        );
        if (burnRow?.status === "active") {
          await client.query(
            `UPDATE flag_burn_operations
             SET status='cancelled',cancel_reason='repaired',completed_at=clock_timestamp(),paused_at=NULL
             WHERE operation_id=$1 AND status='active'`,
            [burnRow.operation_id]
          );
        }
        await client.query(
          `UPDATE flag_repair_disrupt_operations
           SET status='cancelled',cancel_reason='repair-completed',completed_at=clock_timestamp()
           WHERE repair_operation_id=$1 AND status='active'`,
          [row.operation_id]
        );
        const inventory = await this.inventory.snapshotInTransaction(client, row.owner_player_id);
        const result: StoredRepairCompletion = { structureId: input.structureId, inventory, replayed: false };
        await client.query(
          `UPDATE flag_repair_operations
           SET status='completed',completed_at=clock_timestamp(),completes_at=GREATEST(started_at,clock_timestamp()),result=$2::jsonb
           WHERE operation_id=$1`,
          [row.operation_id, JSON.stringify(result)]
        );
        await client.query("COMMIT");
        const structure = await this.flags.getMapFlag(input.structureId);
        return structure ? { status: "completed", structure, inventory, replayed: false } : null;
      }
      const updated = await client.query<RepairOperationRow>(
        `UPDATE flag_repair_operations
         SET completes_at=GREATEST(started_at,clock_timestamp()+($2::bigint*interval '1 millisecond'))
         WHERE operation_id=$1
         RETURNING ${REPAIR_OPERATION_COLUMNS}`,
        [row.operation_id, projectedRepairMs(maximumHealth - nextHealth, maximumHealth, fullRepairMs)]
      );
      await client.query("COMMIT");
      const structure = apply > 0 ? await this.flags.getMapFlag(input.structureId) : null;
      return {
        status: "active",
        operation: repairOperationFromRow(updated.rows[0] ?? row),
        healthRestored: apply,
        ...(structure ? { structure } : {})
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeRepair(input: Readonly<{
    kind: typeof PERSONAL_FLAG_WARFARE_KIND;
    operationId: string;
    playerId: string;
    structureId: string;
    now: number;
  }>): Promise<StructureWarfareRepairCompletion | null> {
    const progress = await this.advanceRepair(input);
    return progress?.status === "completed"
      ? { structure: progress.structure, inventory: progress.inventory, replayed: progress.replayed }
      : null;
  }

  async cancelRepair(input: Readonly<{
    kind: typeof PERSONAL_FLAG_WARFARE_KIND;
    operationId: string;
    playerId: string;
    structureId: string;
    reason: string;
  }>): Promise<void> {
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT operation_id
         FROM flag_repair_disrupt_operations
         WHERE repair_operation_id=$1 AND status='active'
         ORDER BY operation_id
         FOR UPDATE`,
        [input.operationId]
      );
      const current = await client.query<RepairOperationRow>(
        repairOperationSelect("operation_id=$1 AND owner_player_id=$2") + " FOR UPDATE",
        [input.operationId, input.playerId]
      );
      const row = current.rows[0];
      if (!row || row.status !== "active") {
        await client.query("COMMIT");
        return;
      }
      const burnRow = await lockRepairBurn(client, row);
      const flag = await lockRepairTargetHealth(client, row.flag_id);
      await endRepairInTransaction(client, row, burnRow, flag.health, flag.threshold, "cancelled", input.reason);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverRepairsForServerShutdown(_kind: typeof PERSONAL_FLAG_WARFARE_KIND): Promise<void> {
    void _kind;
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      // Match completion and owner-demolition lock order so shutdown
      // recovery cannot deadlock an in-flight contributor channel.
      await client.query(
        `SELECT operation_id
         FROM flag_repair_disrupt_operations
         WHERE status='active'
         ORDER BY operation_id
         FOR UPDATE`
      );
      const active = await client.query<RepairOperationRow>(
        repairOperationSelect("status='active'") + " ORDER BY operation_id FOR UPDATE"
      );
      for (const row of active.rows) {
        const burnRow = await lockRepairBurn(client, row);
        const flag = await lockRepairTargetHealth(client, row.flag_id);
        await this.inventory.lockPlayerInventoryForOperationInTransaction(client, row.owner_player_id);
        // Progressive repair is free. Only a legacy fixed-cost row (from
        // before progressive repair) carries materials to return once.
        const grants = row.repair_mode === "legacy"
          ? [
              { itemId: "repair_kit" as const, variant: DEFAULT_INVENTORY_VARIANT, quantity: Number(row.repair_kit_quantity) },
              { itemId: "stone" as const, variant: DEFAULT_INVENTORY_VARIANT, quantity: Number(row.stone_quantity) }
            ].filter((grant) => grant.quantity > 0)
          : [];
        if (grants.length > 0) {
          await this.inventory.grantItemsForOperationInTransaction(client, {
            operationKey: `flag-repair:${row.operation_id}:server-refund`,
            playerId: row.owner_player_id,
            source: "flag_repair_server_refund",
            sourceEntityType: "flag_repair_operation",
            sourceEntityId: row.operation_id,
            grants
          });
        }
        await endRepairInTransaction(client, row, burnRow, flag.health, flag.threshold, "server_refunded", "server-shutdown");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileRepairs(_kind: typeof PERSONAL_FLAG_WARFARE_KIND): Promise<readonly StructureWarfareRepairOperation[]> {
    void _kind;
    const result = await this.flags.databasePool.query<RepairOperationRow>(
      repairOperationSelect("status='active'") + " ORDER BY completes_at,operation_id"
    );
    return result.rows.map(repairOperationFromRow);
  }

  async reserveDisrupt(input: Readonly<{
    kind: typeof PERSONAL_FLAG_WARFARE_KIND;
    playerId: string;
    structureId: string;
    repairOperationId: string;
    requestId: string;
    player: StructureWarfareRepairPlayer;
  }>): Promise<StructureWarfareDisruptStartResult> {
    if (!input.player.online) throw warfareError("disrupt", "FLAG_DISRUPT_DISCONNECTED", "You must be online to disrupt a repair.");
    if (input.player.target) throw warfareError("disrupt", "FLAG_DISRUPT_MOVING", "Stop moving before disrupting a repair.");
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`flag-disrupt:${input.playerId}:${input.requestId}`]);
      const existing = await client.query<DisruptOperationRow>(
        disruptOperationSelect("contributor_player_id=$1 AND request_id=$2") + " FOR UPDATE",
        [input.playerId, input.requestId]
      );
      if (existing.rows[0]) {
        const row = existing.rows[0]!;
        if (row.flag_id !== input.structureId) throw warfareError("disrupt", "FLAG_DISRUPT_IDEMPOTENCY_CONFLICT", "Disrupt request ID was reused for a different Flag.");
        await client.query("COMMIT");
        return { operation: disruptOperationFromRow(row), replayed: true, status: row.status };
      }
      const repair = await client.query<RepairOperationRow>(
        repairOperationSelect("operation_id=$1 AND flag_id=$2 AND status='active'") + " FOR UPDATE",
        [input.repairOperationId, input.structureId]
      );
      const repairRow = repair.rows[0];
      if (!repairRow) throw warfareError("disrupt", "FLAG_DISRUPT_REPAIR_NOT_ACTIVE", "That Flag is not being repaired.");
      const flag = await client.query<RepairTargetRow>(`${REPAIR_TARGET_SELECT} FOR UPDATE`, [input.structureId]);
      const flagRow = flag.rows[0];
      // A repair runs on burning and non-burning damaged structures alike.
      if (!flagRow || flagRow.damage_cycle_id !== repairRow.damage_cycle_id) {
        throw warfareError("disrupt", "FLAG_DISRUPT_TARGET_INVALID", "This repair is no longer active.");
      }
      if (distanceMeters(input.player.position, { lat: Number(flagRow.lat), lon: Number(flagRow.lon) }) > STRUCTURE_WARFARE_INTERACTION_RADIUS_M) {
        throw warfareError("disrupt", "FLAG_DISRUPT_OUT_OF_RANGE", `Move within ${STRUCTURE_WARFARE_INTERACTION_RADIUS_M}m of the Flag before disrupting it.`);
      }
      const contributor = await client.query(
        `SELECT 1 FROM flag_attack_operations
         WHERE flag_id=$1 AND player_id=$2 AND damage_cycle_id=$3 AND damage>0 LIMIT 1`,
        [input.structureId, input.playerId, repairRow.damage_cycle_id]
      );
      if (contributor.rowCount !== 1) throw warfareError("disrupt", "FLAG_DISRUPT_CONTRIBUTOR_REQUIRED", "Only a player who damaged this Flag during the current cycle can disrupt its repair.");
      const prior = await client.query(
        `SELECT 1 FROM flag_repair_disrupt_operations
         WHERE contributor_player_id=$1 AND flag_id=$2 AND damage_cycle_id=$3 AND status='completed' LIMIT 1`,
        [input.playerId, input.structureId, repairRow.damage_cycle_id]
      );
      if (prior.rowCount !== 0) throw warfareError("disrupt", "FLAG_DISRUPT_ALREADY_USED", "You have already successfully disrupted this damage cycle.");
      const inserted = await client.query<DisruptOperationRow>(
        `INSERT INTO flag_repair_disrupt_operations (
           contributor_player_id,flag_id,repair_operation_id,damage_cycle_id,request_id,
           flag_lat,flag_lon,started_at,completes_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now()+interval '8 seconds')
         ON CONFLICT DO NOTHING
         RETURNING operation_id::text,contributor_player_id,flag_id::text,repair_operation_id::text,
                   damage_cycle_id::text,request_id,flag_lat,flag_lon,started_at,completes_at,status,completed_at,result`,
        [input.playerId, input.structureId, input.repairOperationId, repairRow.damage_cycle_id, input.requestId, Number(flagRow.lat), Number(flagRow.lon)]
      );
      if (inserted.rowCount !== 1) throw warfareError("disrupt", "FLAG_DISRUPT_ACTIVE", "You already have a repair disruption in progress.");
      await client.query("COMMIT");
      const row = inserted.rows[0]!;
      return { operation: disruptOperationFromRow(row), replayed: false, status: "active" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeDisrupt(input: Readonly<{
    kind: typeof PERSONAL_FLAG_WARFARE_KIND;
    operationId: string;
    playerId: string;
    structureId: string;
    now: number;
  }>): Promise<StructureWarfareDisruptCompletion | null> {
    const client = await this.flags.databasePool.connect();
    try {
      await client.query("BEGIN");
      const disrupt = await client.query<DisruptOperationRow>(
        disruptOperationSelect("operation_id=$1 AND contributor_player_id=$2 AND flag_id=$3"),
        [input.operationId, input.playerId, input.structureId]
      );
      const initialRow = disrupt.rows[0];
      if (!initialRow || initialRow.status !== "active") {
        await client.query("COMMIT");
        return initialRow?.status === "completed"
          ? { repairOperationId: initialRow.repair_operation_id, replayed: true }
          : null;
      }
      // Lock every opportunity for this repair before locking the repair row.
      // Two contributors complete concurrently and each initially owns a
      // different disrupt row; taking the group lock first prevents the
      // winner from waiting on the loser's row while the loser waits on the
      // repair row.
      await client.query(
        `SELECT operation_id
         FROM flag_repair_disrupt_operations
         WHERE repair_operation_id=$1
         ORDER BY operation_id
         FOR UPDATE`,
        [initialRow.repair_operation_id]
      );
      const current = await client.query<DisruptOperationRow>(
        disruptOperationSelect("operation_id=$1 AND contributor_player_id=$2 AND flag_id=$3") + " FOR UPDATE",
        [input.operationId, input.playerId, input.structureId]
      );
      const row = current.rows[0];
      if (!row || row.status !== "active") {
        await client.query("COMMIT");
        return row?.status === "completed" ? { repairOperationId: row.repair_operation_id, replayed: true } : null;
      }
      const due = await client.query<{ due: boolean }>("SELECT clock_timestamp() >= $1::timestamptz AS due", [row.completes_at]);
      if (!due.rows[0]?.due) {
        await client.query("COMMIT");
        return null;
      }
      const repair = await client.query<RepairOperationRow>(
        repairOperationSelect("operation_id=$1 AND flag_id=$2") + " FOR UPDATE",
        [row.repair_operation_id, input.structureId]
      );
      const repairRow = repair.rows[0];
      const burnRow = repairRow ? await lockRepairBurn(client, repairRow) : null;
      const flag = await client.query<RepairTargetRow>(`${REPAIR_TARGET_SELECT} FOR UPDATE`, [input.structureId]);
      const flagRow = flag.rows[0];
      const profile = flagRow ? warfareProfileForRow(flagRow) : null;
      if (
        !repairRow || repairRow.status !== "active" ||
        repairRow.damage_cycle_id !== row.damage_cycle_id ||
        !flagRow || !profile || flagRow.damage_cycle_id !== row.damage_cycle_id ||
        flagRow.health === null || Number(flagRow.health) <= 0
      ) {
        await client.query("UPDATE flag_repair_disrupt_operations SET status='cancelled',cancel_reason='revalidation-failed',completed_at=clock_timestamp() WHERE operation_id=$1", [row.operation_id]);
        await client.query("COMMIT");
        return null;
      }
      const prior = await client.query(
        `SELECT 1 FROM flag_repair_disrupt_operations
         WHERE contributor_player_id=$1 AND flag_id=$2 AND damage_cycle_id=$3 AND status='completed' LIMIT 1`,
        [input.playerId, input.structureId, row.damage_cycle_id]
      );
      if (prior.rowCount !== 0) {
        await client.query("UPDATE flag_repair_disrupt_operations SET status='cancelled',cancel_reason='already-used',completed_at=clock_timestamp() WHERE operation_id=$1", [row.operation_id]);
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `UPDATE flag_repair_disrupt_operations
         SET status='completed',completed_at=clock_timestamp(),result=$2::jsonb
         WHERE operation_id=$1 AND status='active'`,
        [row.operation_id, JSON.stringify({ repairOperationId: row.repair_operation_id })]
      );
      // The disruption stops the channel; health already restored stays. A
      // paused burn resumes from the structure's current health.
      await endRepairInTransaction(
        client, repairRow, burnRow, Number(flagRow.health), profile.burnThreshold, "disrupted", "repair-disrupted"
      );
      await client.query("COMMIT");
      return { repairOperationId: repairRow.operation_id, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelDisrupt(input: Readonly<{
    kind: typeof PERSONAL_FLAG_WARFARE_KIND;
    operationId: string;
    playerId: string;
    structureId: string;
    reason: string;
  }>): Promise<void> {
    await this.flags.databasePool.query(
      `UPDATE flag_repair_disrupt_operations
       SET status='cancelled',cancel_reason=$4,completed_at=clock_timestamp()
       WHERE operation_id=$1 AND contributor_player_id=$2 AND flag_id=$3 AND status='active'`,
      [input.operationId, input.playerId, input.structureId, input.reason]
    );
  }

  async reconcileDisrupts(_kind: typeof PERSONAL_FLAG_WARFARE_KIND): Promise<readonly StructureWarfareDisruptOperation[]> {
    void _kind;
    const result = await this.flags.databasePool.query<DisruptOperationRow>(
      disruptOperationSelect("status='active'") + " ORDER BY completes_at,operation_id"
    );
    return result.rows.map(disruptOperationFromRow);
  }
}

/**
 * Starts or repairs the canonical Flag burn mirror after an authoritative
 * structure damage write. The damage writer already holds the target row lock;
 * this helper deliberately takes that same lock when called independently so
 * damage writers and manual ignition/reconciliation converge on one operation.
 * No Torch is charged here: the successful damage action is the initiating
 * action, and the durable burn row is the only source of truth.
 */
export async function ensureDamageTriggeredBurnInTransaction(
  client: Pick<pg.PoolClient, "query">,
  input: Readonly<{
    attackerPlayerId: string;
    structureId: string;
    damageCycleId?: string | null;
  }>
): Promise<void> {
  const targetResult = await client.query<DamageBurnTargetRow>(
    `SELECT f.id::text AS flag_id,${VICTIM_PLAYER_SQL} AS victim_player_id,f.name AS flag_name,
            f.lat AS flag_lat,f.lon AS flag_lon,f.control_type,f.anchor_kind,
            f.system_controlled,f.reinforcement_level,f.tower_level,f.obelisk_level,f.war_structure_kind,f.health,f.maximum_health,
            f.burning_reason,f.city_id::text,f.kingdom_id::text,f.damage_cycle_id,
            f.territory_collapse_id::text,
            f.developer_test_target,
            test.creator_player_id AS developer_test_creator_id,
            nearest.name AS city_name,nearest.hall_lat AS city_lat,nearest.hall_lon AS city_lon
     FROM flags f
     LEFT JOIN developer_spawned_test_flags test ON test.flag_id=f.id
     LEFT JOIN LATERAL (
       SELECT city.name,city.hall_lat,city.hall_lon
       FROM cities city
       WHERE city.active
       ORDER BY ST_Distance(city.hall_geom::geography,f.geom::geography),city.id
       LIMIT 1
     ) nearest ON true
     WHERE f.id=$1::uuid
     FOR UPDATE OF f`,
    [input.structureId]
  );
  const target = targetResult.rows[0];
  if (!target) return;
  const profile = warfareProfileForRow(target);
  // Personal Towers require a separate manual Torch action. Keep this guard
  // before operation discovery so Bomber retries cannot create or repair
  // ignition. City and kingdom structures ignite on reaching the threshold.
  if (!profile || profile.kind === "tower") return;

  // The operation row is authoritative.  If a previous transaction created
  // it but crashed before mirroring flags.burning_*, repair that presentation
  // while the target row is locked instead of creating a second burn.
  const activeResult = await client.query<ActiveDamageBurnOperationRow>(
    `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
            request_id,flag_name,flag_lat,flag_lon,notice_message,
            started_at,completes_at,status,reinforcement_level,burn_duration_ms,
            damage_cycle_id,remaining_duration_ms,paused_at,
            source_kind,developer_test_creator_id
     FROM flag_burn_operations
     WHERE flag_id=$1::uuid AND status='active'
     ORDER BY operation_id
     LIMIT 1`,
    [input.structureId]
  );
  const active = activeResult.rows[0];
  if (active) {
    if (target.health !== null && Number(target.health) <= 0) {
      // Close a destroyed target's durable burn before returning so no
      // completion timer can outlive the structure row.
      await client.query(
        `UPDATE flag_burn_operations
         SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp(),paused_at=NULL
         WHERE operation_id=$1::uuid AND status='active'`,
        [active.operation_id]
      );
      await client.query(
        `UPDATE flags
         SET burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
         WHERE id=$1::uuid`,
        [input.structureId]
      );
      return;
    }
    await syncBurnPresentationInTransaction(client, active);
    return;
  }

  // Legendary encounter burns own the same presentation fields but are not
  // initiated by structure damage.  Never replace that source or invent a
  // player operation around it.
  if (target.burning_reason === "legendary_event") return;
  const reinforcementLevel = Number(target.reinforcement_level);
  if (
    (target.territory_collapse_id ?? null) !== null ||
    target.maximum_health === null ||
    Number(target.maximum_health) !== profile.maximumHealth ||
    target.health === null ||
    Number(target.health) <= 0 ||
    Number(target.health) > profile.burnThreshold ||
    (target.burning_reason !== null && target.burning_reason !== "flag_burn")
  ) return;

  const isDeveloperTestSource = target.developer_test_target === true &&
    target.developer_test_creator_id === input.attackerPlayerId &&
    target.victim_player_id === input.attackerPlayerId;
  if (target.victim_player_id === input.attackerPlayerId && !isDeveloperTestSource) return;
  if (
    profile.organization &&
    isAlliedOrganizationStructure(await loadPlayerOrganizations(client, input.attackerPlayerId), target)
  ) return;

  // Every damage writer normally seeds the cycle in its atomic health update.
  // Keep the helper safe for older/administrative writers by seeding it here
  // without changing health, then use the durable cycle in the idempotency key.
  const cycleResult = await client.query<{ damage_cycle_id: string }>(
    `UPDATE flags
     SET damage_cycle_id=COALESCE(damage_cycle_id,$2::uuid,gen_random_uuid())
     WHERE id=$1::uuid AND health > 0
     RETURNING damage_cycle_id::text`,
    [input.structureId, input.damageCycleId ?? null]
  );
  const damageCycleId = cycleResult.rows[0]?.damage_cycle_id ?? target.damage_cycle_id ?? input.damageCycleId;
  if (!damageCycleId) return;

  const durationMs = profile.burnDurationMs;
  const noticeMessage = buildBurnNotice(target, durationMs, profile.kind);
  const sourceKind = isDeveloperTestSource ? "developer_test" : "player";
  const developerTestCreatorId = isDeveloperTestSource ? input.attackerPlayerId : null;
  const requestId = `damage-trigger:${input.structureId}:${damageCycleId}`;
  const inserted = await client.query<ActiveDamageBurnOperationRow>(
    `INSERT INTO flag_burn_operations (
       burner_player_id,victim_player_id,flag_id,request_id,flag_name,
       flag_lat,flag_lon,notice_message,started_at,completes_at,
       reinforcement_level,burn_duration_ms,damage_cycle_id,remaining_duration_ms,
       source_kind,developer_test_creator_id,burn_start_health,burn_damage_budget
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp(),
               clock_timestamp()+($9::bigint*interval '1 millisecond'),$10,$9,$11,$9,$12,$13,$14,$15)
     ON CONFLICT DO NOTHING
     RETURNING operation_id::text,burner_player_id,victim_player_id,flag_id::text,
               request_id,flag_name,flag_lat,flag_lon,notice_message,
               started_at,completes_at,status,reinforcement_level,burn_duration_ms,
               damage_cycle_id,remaining_duration_ms,paused_at,
               source_kind,developer_test_creator_id`,
    [
      input.attackerPlayerId,
      target.victim_player_id,
      input.structureId,
      requestId,
      target.flag_name,
      Number(target.flag_lat),
      Number(target.flag_lon),
      noticeMessage,
      durationMs,
      reinforcementLevel,
      damageCycleId,
      sourceKind,
      developerTestCreatorId,
      Number(target.health),
      Math.floor(Number(target.maximum_health) / 2)
    ]
  );
  if (inserted.rowCount !== 1) {
    // A concurrent source may have won the unique active-Flag boundary.  The
    // target lock normally serializes this path, but resolving the row here
    // keeps retries truthful even when an older writer omitted that lock.
    const winner = await client.query<ActiveDamageBurnOperationRow>(
      `SELECT operation_id::text,burner_player_id,victim_player_id,flag_id::text,
              request_id,flag_name,flag_lat,flag_lon,notice_message,
              started_at,completes_at,status,reinforcement_level,burn_duration_ms,
              damage_cycle_id,remaining_duration_ms,paused_at,
              source_kind,developer_test_creator_id
       FROM flag_burn_operations
       WHERE flag_id=$1::uuid AND status='active'
       ORDER BY operation_id
       LIMIT 1`,
      [input.structureId]
    );
    if (winner.rows[0]) await syncBurnPresentationInTransaction(client, winner.rows[0]!);
    return;
  }
  const operation = inserted.rows[0]!;
  await syncBurnPresentationInTransaction(client, operation);
  await client.query(
    `INSERT INTO player_inbox_entries (
       id,player_id,entry_kind,message,created_at,status,event_kind,event_id
     ) VALUES (gen_random_uuid(),$1,'game_notice',$2,clock_timestamp(),'notice',$3,$4)
     ON CONFLICT (player_id,event_kind,event_id)
       WHERE entry_kind='game_notice' DO NOTHING`,
    [target.victim_player_id, noticeMessage, FLAG_BURN_EVENT_KIND, operation.operation_id]
  );
}

export type OrganizationBomberStrike =
  | Readonly<{
      kind: "struck";
      flagId: string;
      health: number;
      /** True when a bomb on a repairing structure took it to zero health. */
      destroyed: boolean;
      notificationPlayerIds: string[];
    }>
  | Readonly<{ kind: "invalid"; message: string }>;

/**
 * Closes every live warfare channel on a structure a bomb just destroyed, so
 * no repair, burn, or disruption can outlive it.
 */
export async function cancelWarfareChannelsForDestroyedStructureInTransaction(
  client: Pick<pg.PoolClient, "query">,
  flagId: string
): Promise<void> {
  await client.query(
    `UPDATE flag_repair_disrupt_operations
     SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp()
     WHERE flag_id=$1::uuid AND status='active'`,
    [flagId]
  );
  await client.query(
    `UPDATE flag_repair_operations
     SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp()
     WHERE flag_id=$1::uuid AND status='active'`,
    [flagId]
  );
  await client.query(
    `UPDATE flag_burn_operations
     SET status='cancelled',cancel_reason='flag-destroyed',completed_at=clock_timestamp(),paused_at=NULL
     WHERE flag_id=$1::uuid AND status='active'`,
    [flagId]
  );
  await client.query(
    `UPDATE flags SET burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
     WHERE id=$1::uuid`,
    [flagId]
  );
}

/**
 * Bomber strike on a city or kingdom structure.
 *  - Not repairing (must-burn rule): the 1,150 damage stops at the burn
 *    threshold and reaching it ignites the structure; a burning structure
 *    cannot be bombed.
 *  - Repairing (repairing near enemies is dangerous): the
 *    floor does not apply, the damage counts 3x, and a structure whose burn is
 *    paused by the repair can be bombed. At zero health the structure is
 *    destroyed, not ignited: its channels close and the zero-health marker is
 *    settled by the organization fall sweep (a City Center / Castle collapses
 *    the territory; an ordinary flag breaks with the flags it alone connected).
 * Returns null for personal flags, which keep the canonical bomber path. The
 * caller holds the flag-control geometry lock.
 */
export async function applyOrganizationBomberStrikeInTransaction(
  client: pg.PoolClient,
  flagId: string,
  bomberPlayerId: string
): Promise<OrganizationBomberStrike | null> {
  // Lock order matches repair completion and the fall sweep: active disrupt ->
  // repair -> burn operation rows, then the flag row. The destroy path cancels
  // those channels, so taking the flag first could deadlock with a repair.
  for (const table of ["flag_repair_disrupt_operations", "flag_repair_operations", "flag_burn_operations"]) {
    await client.query(
      `SELECT operation_id FROM ${table}
       WHERE flag_id=$1::uuid AND status='active'
       ORDER BY operation_id
       FOR UPDATE`,
      [flagId]
    );
  }
  const locked = await client.query<WarfareFlagRow & {
    name: string;
    health: number | null;
    maximum_health: number | null;
    burning_reason: string | null;
    territory_collapse_id: string | null;
    owner_id: string | null;
    lat: number;
    lon: number;
  }>(
    `SELECT control_type,anchor_kind,system_controlled,city_id::text,kingdom_id::text,reinforcement_level,
            tower_level,obelisk_level,war_structure_kind,name,health,maximum_health,burning_reason,territory_collapse_id::text,
            owner_id,lat,lon
     FROM flags WHERE id=$1::uuid FOR UPDATE`,
    [flagId]
  );
  const flag = locked.rows[0];
  if (!flag) return null;
  const organization = organizationOfFlag(flag);
  const profile = warfareProfileForRow(flag);
  if (!organization || !profile) return null;
  if (isAlliedOrganizationStructure(await loadPlayerOrganizations(client, bomberPlayerId), flag)) {
    return { kind: "invalid", message: "You cannot bomb a structure of your own city or kingdom." };
  }
  const bombPeace = await forcedPeaceRefusalInTransaction(client, bomberPlayerId, organization);
  if (bombPeace) return { kind: "invalid", message: bombPeace };
  const repairing = await hasActiveRepair(client, flagId);
  if (
    (flag.territory_collapse_id ?? null) !== null ||
    (flag.burning_reason !== null && !(repairing && flag.burning_reason === "flag_burn")) ||
    flag.health === null || Number(flag.health) <= 0 ||
    Number(flag.maximum_health) !== profile.maximumHealth
  ) {
    return { kind: "invalid", message: "This structure cannot be bombed right now." };
  }
  const damage = reducedStructureHit(
    await monolithAdjustedBuildingDamage(
      client,
      STRUCTURE_WARFARE_BOMBER_DAMAGE * (repairing ? STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER : 1),
      { attacker: null, target: flag }
    ),
    await kingdomStructureDamageReduction(client, flagId)
  );
  const damaged = await client.query<{ health: number; damage_cycle_id: string }>(
    `UPDATE flags
     SET health=LEAST(health,GREATEST($3::integer,health-$2::integer)),
         damage_cycle_id=COALESCE(damage_cycle_id,gen_random_uuid())
     WHERE id=$1::uuid AND health > 0
     RETURNING health,damage_cycle_id::text`,
    [flagId, damage, repairing ? 0 : profile.burnThreshold]
  );
  const row = damaged.rows[0];
  if (!row) return { kind: "invalid", message: "The structure changed before it could be damaged." };
  const destroyed = Number(row.health) <= 0;
  if (destroyed) {
    await cancelWarfareChannelsForDestroyedStructureInTransaction(client, flagId);
  } else if (!repairing) {
    // A repair keeps any burn paused; ignition applies only to an unattended
    // structure that reached its threshold.
    await ensureDamageTriggeredBurnInTransaction(client, {
      attackerPlayerId: bomberPlayerId,
      structureId: flagId,
      damageCycleId: row.damage_cycle_id
    });
  }
  await recordOrganizationHostilityInTransaction(client, {
    attackerPlayerId: bomberPlayerId,
    defender: organization,
    profile,
    structureName: flag.name
  });
  const leader = await organizationLeaderId(client, organization);
  return {
    kind: "struck",
    flagId,
    health: Number(row.health),
    destroyed,
    notificationPlayerIds: leader ? [leader] : []
  };
}

/**
 * A city or kingdom structure that burns out is not deleted inside the burn
 * transaction: breaking it (and pruning the flags it alone connected, or
 * collapsing the whole territory for a City Center / Castle) must take the
 * organization network lock before the flag-control geometry lock. The burn
 * leaves the durable zero-health marker instead, and the organization fall
 * sweep (organizationStructureFall.ts) settles it in that lock order.
 * Returns null for personal flags, which keep the canonical deletion path.
 */
async function burnOutOrganizationStructureInTransaction(
  client: pg.PoolClient,
  operation: Pick<BurnOperationRow, "flag_id" | "victim_player_id">
): Promise<BurnFlagDeletionResult | null> {
  const locked = await client.query<WarfareFlagRow & { id: string }>(
    `SELECT id::text,control_type,anchor_kind,system_controlled,city_id::text,kingdom_id::text,
            reinforcement_level,tower_level,obelisk_level,war_structure_kind
     FROM flags WHERE id=$1::uuid FOR UPDATE`,
    [operation.flag_id]
  );
  const flag = locked.rows[0];
  if (!flag || !organizationOfFlag(flag)) return null;
  await client.query(
    `UPDATE flags
     SET health=0,burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
     WHERE id=$1::uuid`,
    [operation.flag_id]
  );
  return {
    flagId: operation.flag_id,
    affectedFlagIds: [operation.flag_id],
    notificationPlayerIds: [operation.victim_player_id]
  };
}

async function syncBurnPresentationInTransaction(
  client: Pick<pg.PoolClient, "query">,
  operation: Pick<ActiveDamageBurnOperationRow, "flag_id" | "source_kind" | "started_at" | "completes_at" | "damage_cycle_id">
): Promise<void> {
  const burningReason = operation.source_kind === "legendary_bird" ? "legendary_event" : "flag_burn";
  await client.query(
    `UPDATE flags
     SET burning_started_at=$2,burning_until=$3,burning_reason=$4,
         damage_cycle_id=COALESCE($5::uuid,damage_cycle_id)
     WHERE id=$1::uuid`,
    [operation.flag_id, operation.started_at, operation.completes_at, burningReason, operation.damage_cycle_id]
  );
}

function operationFromRow(row: BurnOperationRow): StructureWarfareIgnitionOperation {
  return {
    operationId: row.operation_id,
    attackerId: row.burner_player_id,
    defenderId: row.victim_player_id,
    structureId: row.flag_id,
    requestId: row.request_id,
    structureName: row.flag_name,
    reinforcementLevel: Number(row.reinforcement_level),
    position: { lat: Number(row.flag_lat), lon: Number(row.flag_lon) },
    startedAt: new Date(row.started_at).getTime(),
    completesAt: new Date(row.completes_at).getTime(),
    durationMs: Number(row.burn_duration_ms) ||
      structureWarfareBurnDurationForReinforcementLevel(Number(row.reinforcement_level)) ||
      (Number(row.reinforcement_level) === 0
        ? STRUCTURE_WARFARE_BASE_BURN_DURATION_MS
        : STRUCTURE_WARFARE_STONE_BURN_DURATION_MS),
    noticeMessage: row.notice_message
  };
}

function repairOperationSelect(where: string): string {
  return `SELECT ${REPAIR_OPERATION_COLUMNS}
          FROM flag_repair_operations WHERE ${where}`;
}

function disruptOperationSelect(where: string): string {
  return `SELECT operation_id::text,contributor_player_id,flag_id::text,
                 repair_operation_id::text,damage_cycle_id::text,request_id,
                 flag_lat,flag_lon,
                 started_at,completes_at,status,cancel_reason,completed_at,result
          FROM flag_repair_disrupt_operations WHERE ${where}`;
}

function repairOperationFromRow(row: RepairOperationRow): StructureWarfareRepairOperation {
  const startedAt = new Date(row.started_at).getTime();
  const completesAt = new Date(row.completes_at).getTime();
  const progressive = row.repair_mode === "progressive";
  return {
    operationId: row.operation_id,
    ownerId: row.owner_player_id,
    structureId: row.flag_id,
    requestId: row.request_id,
    structureName: row.flag_name,
    reinforcementLevel: progressive
      ? row.organization_kind === null && Number(row.maximum_health) >= STRUCTURE_WARFARE_TOWER_HEALTH ? 3 : 1
      : Number(row.stone_quantity) === STRUCTURE_WARFARE_REPAIR_COST_BY_TIER.tower.stone ? 3 : 1,
    position: { lat: Number(row.flag_lat), lon: Number(row.flag_lon) },
    startedAt,
    completesAt,
    durationMs: progressive ? Math.max(0, completesAt - startedAt) : STRUCTURE_WARFARE_REPAIR_DURATION_MS,
    pausedBurnRemainingMs: Number(row.paused_burn_remaining_ms),
    repairKitQuantity: Number(row.repair_kit_quantity),
    stoneQuantity: progressive ? 0 : Number(row.stone_quantity)
  };
}

function disruptOperationFromRow(row: DisruptOperationRow): StructureWarfareDisruptOperation {
  return {
    operationId: row.operation_id,
    contributorId: row.contributor_player_id,
    structureId: row.flag_id,
    repairOperationId: row.repair_operation_id,
    requestId: row.request_id,
    damageCycleId: row.damage_cycle_id,
    position: { lat: Number(row.flag_lat), lon: Number(row.flag_lon) },
    startedAt: new Date(row.started_at).getTime(),
    completesAt: new Date(row.completes_at).getTime(),
    durationMs: STRUCTURE_WARFARE_DISRUPT_DURATION_MS
  };
}

/** Projected milliseconds for a repair to restore `missing` health. */
function projectedRepairMs(missing: number, maximumHealth: number, fullRepairMs: number): number {
  if (missing <= 0 || maximumHealth <= 0) return 0;
  return Math.ceil((missing * fullRepairMs) / maximumHealth);
}

async function lockRepairBurn(
  client: Pick<pg.PoolClient, "query">,
  repair: Pick<RepairOperationRow, "burn_operation_id">
): Promise<BurnOperationRow | null> {
  if (!repair.burn_operation_id) return null;
  const burn = await client.query<BurnOperationRow>(
    `${BURN_OPERATION_SELECT}
     WHERE source_kind IN ('player','developer_test') AND operation_id=$1
     FOR UPDATE`,
    [repair.burn_operation_id]
  );
  return burn.rows[0] ?? null;
}

async function lockRepairTargetHealth(
  client: Pick<pg.PoolClient, "query">,
  flagId: string
): Promise<{ health: number; threshold: number }> {
  const locked = await client.query<RepairTargetRow>(`${REPAIR_TARGET_SELECT} FOR UPDATE`, [flagId]);
  const flag = locked.rows[0];
  const profile = flag ? warfareProfileForRow(flag) : null;
  return {
    health: flag?.health === null || flag?.health === undefined ? 0 : Number(flag.health),
    threshold: profile?.burnThreshold ?? 0
  };
}

/**
 * Ends a repair channel that did not reach full health. The paused burn is
 * extinguished when the repair lifted the structure above its burn
 * threshold; otherwise it resumes with the time its current health buys at
 * the fixed burn rate (restored health extends the burn, the 3x damage taken
 * while repairing shortens it).
 */
async function endRepairInTransaction(
  client: Pick<pg.PoolClient, "query">,
  repair: Pick<RepairOperationRow, "operation_id" | "flag_id">,
  burn: BurnOperationRow | null,
  health: number,
  burnThreshold: number,
  status: "cancelled" | "disrupted" | "server_refunded",
  reason: string
): Promise<void> {
  if (burn?.status === "active" && burn.paused_at !== null) {
    if (health > burnThreshold) {
      await client.query(
        `UPDATE flag_burn_operations
         SET status='cancelled',cancel_reason='repaired',completed_at=clock_timestamp(),paused_at=NULL
         WHERE operation_id=$1 AND status='active'`,
        [burn.operation_id]
      );
      await client.query(
        `UPDATE flags SET burning_started_at=NULL,burning_until=NULL,burning_reason=NULL
         WHERE id=$1::uuid AND burning_reason='flag_burn'`,
        [repair.flag_id]
      );
    } else {
      await resumeBurnFromHealth(client, burn.operation_id, Math.max(0, health));
    }
  }
  await client.query(
    `UPDATE flag_repair_disrupt_operations
     SET status='cancelled',cancel_reason=$2,completed_at=clock_timestamp()
     WHERE repair_operation_id=$1 AND status='active'`,
    [repair.operation_id, `repair-${status}`]
  );
  await client.query(
    `UPDATE flag_repair_operations
     SET status=$2,cancel_reason=$3,completed_at=clock_timestamp(),
         refund_applied=($2='server_refunded'),
         completes_at=CASE WHEN repair_mode='progressive'
           THEN GREATEST(started_at,LEAST(completes_at,clock_timestamp())) ELSE completes_at END
     WHERE operation_id=$1 AND status='active'`,
    [repair.operation_id, status, reason]
  );
}

async function resumeBurnFromHealth(
  client: Pick<pg.PoolClient, "query">,
  operationId: string,
  health: number
): Promise<void> {
  // remaining = health / (budget / duration); the cumulative damage cursor is
  // re-based to the elapsed share so the resumed burn neither spikes nor
  // stalls.
  await client.query(
    `UPDATE flag_burn_operations operation
     SET paused_at=NULL,
         remaining_duration_ms=resumed.remaining_ms,
         completes_at=clock_timestamp()+(resumed.remaining_ms*interval '1 millisecond'),
         burn_damage_applied=CASE WHEN operation.burn_damage_budget IS NULL THEN operation.burn_damage_applied
           ELSE FLOOR(operation.burn_damage_budget::numeric
             * (operation.burn_duration_ms-resumed.remaining_ms)/operation.burn_duration_ms)::integer END
     FROM (
       SELECT operation_id,
              LEAST(burn_duration_ms,GREATEST(1000,COALESCE(
                CEIL($2::numeric*burn_duration_ms/NULLIF(burn_damage_budget,0)),
                remaining_duration_ms)))::bigint AS remaining_ms
       FROM flag_burn_operations WHERE operation_id=$1
     ) resumed
     WHERE operation.operation_id=resumed.operation_id
       AND operation.source_kind IN ('player','developer_test') AND operation.status='active'`,
    [operationId, Math.max(0, Math.trunc(health))]
  );
  await client.query(
    `UPDATE flags flag
     SET burning_until=operation.completes_at,
         burning_started_at=COALESCE(flag.burning_started_at,operation.started_at),
         burning_reason='flag_burn'
     FROM flag_burn_operations operation
     WHERE operation.operation_id=$1 AND flag.id=operation.flag_id
       AND operation.source_kind IN ('player','developer_test') AND operation.status='active'`,
    [operationId]
  );
}

function warfareError(
  phase: "attack" | "ignition" | "repair" | "disrupt",
  code: string,
  message: string
): StructureWarfareError {
  return new StructureWarfareError(phase, code, message);
}

function assertBurnableDatabaseTarget(
  playerId: string,
  flag: Pick<
    BurnTargetRow,
    | "victim_player_id"
    | "control_type"
    | "anchor_kind"
    | "system_controlled"
    | "reinforcement_level"
    | "burning_reason"
    | "health"
    | "maximum_health"
    | "city_id"
    | "kingdom_id"
    | "developer_test_target"
    | "developer_test_creator_id"
    | "territory_collapse_id"
  >
): StructureWarfareProfile {
  const isDeveloperTestTarget = flag.developer_test_target === true;
  const isDeveloperTestCreator =
    isDeveloperTestTarget &&
    flag.developer_test_creator_id === playerId &&
    flag.victim_player_id === playerId;
  const profile = warfareProfileForRow(flag);
  if (
    !profile ||
    (flag.territory_collapse_id ?? null) !== null ||
    (flag.victim_player_id === playerId && !isDeveloperTestCreator) ||
    flag.burning_reason !== null ||
    flag.health === null ||
    flag.maximum_health === null ||
    Number(flag.health) <= 0 ||
    Number(flag.maximum_health) !== profile.maximumHealth ||
    Number(flag.health) > profile.burnThreshold
  ) {
    throw warfareError("ignition", "FLAG_BURN_TARGET_INVALID", "This Flag is not ready to burn.");
  }
  return profile;
}

function buildBurnNotice(
  flag: Pick<
    BurnTargetRow,
    "flag_lat" | "flag_lon" | "city_name" | "city_lat" | "city_lon" | "flag_name"
  >,
  durationMs: number,
  kind: StructureWarfareProfile["kind"] = "stone"
): string {
  const location = formatFlagRelativeCity({
    lat: Number(flag.flag_lat),
    lon: Number(flag.flag_lon),
    city_name: flag.city_name,
    city_lat: flag.city_lat === null ? null : Number(flag.city_lat),
    city_lon: flag.city_lon === null ? null : Number(flag.city_lon)
  });
  const organization = kind === "city_flag" || kind === "city_center"
    ? "your city's "
    : kind === "kingdom_flag" || kind === "castle"
      ? "your kingdom's "
      : "your ";
  const structure = kind === "base" || kind === "stone" || kind === "tower"
    ? "Flag"
    : structureWarfareDisplayKind(kind);
  return `A player began burning ${organization}${structure} “${flag.flag_name}”. ` +
    `It will complete in about ${formatStructureWarfareDuration(durationMs)}.` +
    (location ? ` The ${structure} is around ${location}.` : "");
}

function isInventoryShortage(error: unknown): boolean {
  return error instanceof Error && error.message === "Inventory does not contain enough items";
}

/** Personal-structure hostility (flags, Manors): drop friendship, mark both players enemies. */
export async function declareFlagEnemy(
  client: pg.PoolClient,
  actorPlayerId: string,
  targetPlayerId: string
): Promise<void> {
  await client.query(
    `DELETE FROM friendships
     WHERE player_low_id=LEAST($1::text,$2::text) AND player_high_id=GREATEST($1::text,$2::text)`,
    [actorPlayerId, targetPlayerId]
  );
  await client.query(
    `UPDATE player_inbox_entries
     SET status='cancelled'
     WHERE entry_kind='friend_request' AND status='pending'
       AND ((actor_player_id=$1 AND player_id=$2)
         OR (actor_player_id=$2 AND player_id=$1))`,
    [actorPlayerId, targetPlayerId]
  );
  await client.query(
    `DELETE FROM friend_requests
     WHERE (requester_id=$1 AND recipient_id=$2)
        OR (requester_id=$2 AND recipient_id=$1)`,
    [actorPlayerId, targetPlayerId]
  );
  await client.query(
    `DELETE FROM enemy_neutrality_requests
     WHERE player_low_id=LEAST($1::text,$2::text) AND player_high_id=GREATEST($1::text,$2::text)`,
    [actorPlayerId, targetPlayerId]
  );
  await client.query(
    `INSERT INTO player_enemy_marks (owner_id,target_id)
     VALUES (LEAST($1::text,$2::text),GREATEST($1::text,$2::text))
     ON CONFLICT (owner_id,target_id) DO NOTHING`,
    [actorPlayerId, targetPlayerId]
  );
  await client.query(
    `INSERT INTO player_inbox_entries (
       id,player_id,entry_kind,actor_player_id,enemy_declaration_id,
       status,message,created_at
     )
     SELECT gen_random_uuid(),$2,'enemy_declaration',$1,marks.id,
            'notice','Enemy declaration',now()
     FROM player_enemy_marks marks
     WHERE marks.owner_id=LEAST($1::text,$2::text) AND marks.target_id=GREATEST($1::text,$2::text)
       AND NOT EXISTS (
         SELECT 1 FROM player_inbox_entries existing
         WHERE existing.entry_kind='enemy_declaration'
           AND existing.enemy_declaration_id=marks.id
       )
     ON CONFLICT (enemy_declaration_id) WHERE enemy_declaration_id IS NOT NULL DO NOTHING`,
    [actorPlayerId, targetPlayerId]
  );
}
