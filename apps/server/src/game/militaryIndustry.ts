import { createHash, randomUUID } from "node:crypto";

import {
  ARMORY_REPAIR_KIT_DURATION_MS,
  ARMORY_REPAIR_KIT_INPUTS,
  ARMORY_REPAIR_KIT_MAX_BATCH,
  LODGE_CAPACITY_BY_LEVEL,
  LODGE_COSTS,
  LODGE_FOOTPRINT_RADIUS_M,
  LODGE_INTERACTION_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  MILITARY_FACILITY_QUEUE_CAPACITY,
  MILITARY_MAX_FUSION_SIZE,
  MILITARY_FUSION_RANGE_M,
  DEFAULT_PLAYER_SPEED_MPS,
  MILITARY_UNIT_MAX_HP,
  planMilitaryGroupAttack,
  MILITARY_UNIT_RECIPES,
  bomberCrudeOilCost,
  KINGDOM_PERK_PICKED_LEGION_ATTACK_BONUS,
  KINGDOM_PERK_UNYIELDING_ASSAULT_MULTIPLIER,
  planBallistaStructuralDamage,
  MILITARY_BALLISTA_VOLLEY_CADENCE_MS,
  STRUCTURE_WARFARE_BOMBER_DAMAGE,
  STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER,
  siegeOrganizationMinimumPlacementMeters,
  STRUCTURE_WARFARE_ATTACK_DAMAGE,
  STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS,
  structureWarfareHealthForReinforcementLevel,
  MILITARY_BOMBER_CHANNEL_DURATION_MS,
  militaryHumanRecoveryDurationMs,
  MILITARY_BALLISTA_REPAIR_AMOUNT,
  MILITARY_BALLISTA_REPAIR_COST,
  MILITARY_RALLY_DURATION_MS,
  MILITARY_FOLLOW_DISTANCE_M,
  MILITARY_FOLLOW_FORMATION_SPACING_M,
  MILITARY_FOLLOW_SPEED_RATIO,
  SIEGE_PACK_UP_DURATION_MS,
  MILITARY_WAR_CAMP_COST,
  MILITARY_WAR_CAMP_FOOTPRINT_RADIUS_M,
  MILITARY_WAR_CAMP_OUTDOOR_CLEARANCE_M,
  MILITARY_WAR_CAMP_RELOCATION_COOLDOWN_MS,
  MILITARY_UNIT_INTERACTION_RADIUS_M,
  POWDER_WORKS_TORCH_DURATION_MS,
  POWDER_WORKS_TORCH_INPUTS,
  POWDER_WORKS_TORCH_MAX_BATCH,
  POWDER_WORKS_TORCH_OUTPUT_QUANTITY,
  SIEGE_ATTACK_RANGE_METERS,
  isWithinSiegeAttackRange,
  SIEGE_CREW_CAPACITY_COST,
  distanceMeters,
  destinationPoint,
  moveToward,
  bearingDegrees,
  isFiniteLatLon,
  type LodgeLevel,
  type LatLon,
  type LodgeSnapshot,
  type MilitaryFacilityType,
  type MilitaryIndustrySnapshot,
  type MilitaryJobSnapshot,
  type MilitaryJobType,
  type MilitaryPersonnelStatus,
  type PersonnelSnapshot,
  type PlayerInventorySnapshot,
  type MilitaryUnitType,
  type MilitaryUnitStatus,
  type MilitaryUnitLocationState,
  type MilitaryGroupMovementOrder,
  type MilitaryUnitSnapshot,
  type MilitaryUnitGroupSnapshot,
  type WarCampSnapshot,
  type MilitaryBomberChannelSnapshot,
  type MilitarySiegeVolleyCue,
  type MilitaryBomberDetonationCue,
  type ResourceType,
} from "@ash-atlas/shared";
import { kingdomStructureDamageReduction, playerHasKingdomPerk, reducedStructureHit, watchfiresDelayRecovery } from "./kingdomPerks.js";
import type pg from "pg";

import { CombatRequestError, type CombatEngine } from "./combat/combatEngine.js";
import {
  CityStructureError,
  lockCity,
  lockPlayerAndCity,
  requireActiveCityMemberForMilitary,
  resolveCityAtPosition,
  validateCityTerritoryFootprint
} from "./cityStructures.js";
import { DEFAULT_INVENTORY_VARIANT, type InventoryService } from "./inventory.js";
import { lockFlagControlGeometry } from "./flagControlGeometry.js";
import { applyOrganizationBomberStrikeInTransaction, ensureDamageTriggeredBurnInTransaction } from "./personalFlagWarfare.js";
import {
  CityStructureWarfareError,
  applyCityBuildingBombInTransaction,
  applyCityBuildingDamageInTransaction,
  lockCityBuildingInTransaction,
  requireBombableCityBuilding,
  requireHostileCityBuildingInTransaction
} from "./cityStructureWarfare.js";
import {
  forcedPeaceRefusalInTransaction,
  hasActiveRepair,
  isAlliedOrganizationStructure,
  loadPlayerOrganizations,
  organizationOfFlag,
  recordOrganizationHostilityInTransaction,
  warfareProfileForRow,
  type PlayerOrganizations
} from "./warStructures.js";
import { monolithAdjustedBuildingDamage } from "./monoliths.js";
import type { PlayerRecord } from "./state.js";
import { WalletOperationError, WalletService } from "./wallet.js";
import { WarCampWarfareService } from "./warCampWarfare.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type LodgeRow = {
  lodge_id: string;
  owner_player_id: string;
  world_id: string;
  region_code: string;
  lat: number;
  lon: number;
  level: number;
  reserved_capacity: number;
  placement_revision: string;
  built_at: Date | string;
  upgraded_at: Date | string | null;
};

type PersonnelRow = {
  personnel_id: string;
  owner_player_id: string;
  personnel_type: "siege_crew";
  capacity_cost: number;
  status: MilitaryPersonnelStatus;
  created_at: Date | string;
  assignment_reference: string | null;
  revision: string;
};

type MilitaryUnitRow = {
  unit_id: string;
  owner_player_id: string;
  unit_type: MilitaryUnitType;
  home_city_id: string | null;
  current_hp: number;
  max_hp: number;
  status: MilitaryUnitStatus;
  location_state: MilitaryUnitLocationState;
  station_city_id: string | null;
  war_camp_id: string | null;
  lat: number | null;
  lon: number | null;
  group_id: string | null;
  next_recovery_at: Date | string | null;
  next_fire_at: Date | string | null;
  target_flag_id: string | null;
  movement_order: MilitaryGroupMovementOrder;
  movement_target_lat: number | null;
  movement_target_lon: number | null;
  packing_completes_at: Date | string | null;
  revision: string;
  created_at: Date | string;
};

type MilitaryUnitGroupRow = {
  group_id: string;
  owner_player_id: string;
  unit_type: MilitaryUnitType;
  location_state: MilitaryUnitLocationState;
  station_city_id: string | null;
  war_camp_id: string | null;
  lat: number | null;
  lon: number | null;
  target_flag_id: string | null;
  /** A Siege's durable city-building target (target_flag_id is then null). */
  target_city_structure_id?: string | null;
  movement_order: MilitaryGroupMovementOrder;
  movement_target_lat: number | null;
  movement_target_lon: number | null;
  next_fire_at: Date | string | null;
  packing_completes_at: Date | string | null;
  revision: string;
  created_at: Date | string;
};

type WarCampRow = {
  camp_id: string;
  owner_player_id: string;
  world_id: string;
  region_code: string;
  lat: number;
  lon: number;
  placement_revision: string;
  built_at: Date | string;
  removed_at: Date | string | null;
  relocation_available_at: Date | string | null;
  health?: number | null;
  maximum_health?: number | null;
  burning_until?: Date | string | null;
  owner_name?: string | null;
};

type BomberChannelRow = {
  request_id: string;
  group_id: string;
  flag_id: string;
  target_kind?: "flag" | "city_structure";
  started_at: Date | string;
  completes_at: Date | string;
};

type BomberFlagDeletion = Readonly<{
  flagId: string;
  affectedFlagIds: readonly string[];
  notificationPlayerIds: readonly string[];
}>;

type JobRow = {
  job_id: string;
  facility_structure_id: string;
  owner_player_id: string;
  job_type: MilitaryJobType;
  quantity: number;
  output_quantity: number;
  collected_quantity: number;
  request_id: string;
  request_hash: string;
  started_at: Date | string;
  completes_at: Date | string;
  cleared_at: Date | string | null;
};

type LodgeOperationRow = {
  player_id: string;
  request_id: string;
  action: "build" | "upgrade" | "destroy";
  request_hash: string;
  result: { lodge?: LodgeSnapshot | null; replayed?: boolean } | null;
  completed_at: Date | string | null;
};

export class MilitaryIndustryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MilitaryIndustryError";
  }
}

export type MilitaryMutationResult = Readonly<{
  snapshot: MilitaryIndustrySnapshot;
  inventory?: PlayerInventorySnapshot;
  walletGold?: string;
  walletVersion?: string;
  damage?: number;
  affectedFlagIds?: readonly string[];
  /** City buildings whose health changed (war part C3). */
  affectedCityStructureIds?: readonly string[];
  siegeVolleys?: readonly MilitarySiegeVolleyCue[];
  replayed: boolean;
}>;

export type DeveloperMilitarySpawnResult = Readonly<{
  snapshot: MilitaryIndustrySnapshot;
  unitId: string;
  groupId: string;
  replayed: boolean;
}>;

export const MILITARY_TRAVEL_WARNING = "Your troops will remain behind.";
const NO_SELECTED_SIEGE_TARGET_ID = "00000000-0000-0000-0000-000000000000";

export type MilitaryTravelInput = Readonly<{
  playerId: string;
  operationKind:
    | "flag"
    | "city"
    | "invite"
    | "party_manual"
    | "party_auto_follow"
    | "manor_jump"
    | "dev_mine"
    | "dev_teleport"
    | "pet_open_land"
    | "gps_relocate"
    | "whirlpool";
  destinationKind: "flag" | "city" | "world" | "manor";
  destinationId: string | null;
  destinationCenter: Readonly<{ lat: number; lon: number }>;
  lastKnownPosition: Readonly<{ lat: number; lon: number }>;
}>;

export type MilitaryTravelResult = Readonly<{
  accompaniedGroups: number;
  leftBehindGroups: number;
  warning: string | null;
}>;

/** Player state required to authorize commands against an already-visible
 * owned group.  The anchor and vision radius are authoritative GameState
 * values; callers from older internal paths may omit them and retain their
 * historical local-test behavior. */
type MilitaryCommandPlayer = Pick<PlayerRecord, "playerId" | "position"> & {
  online?: PlayerRecord["online"];
  target?: PlayerRecord["target"];
  anchor?: PlayerRecord["anchor"];
  resourceVision?: PlayerRecord["resourceVision"];
};

/** Minimal authoritative owner state consumed by the following movement tick. */
export type MilitaryFollowPlayerState = Readonly<{
  playerId: string;
  position: Readonly<{ lat: number; lon: number }>;
  target: Readonly<{ lat: number; lon: number }> | null;
  online?: boolean;
  worldPresent?: boolean;
}>;

/**
 * Durable V1 Lodge, unit roster, production, and field-siege authority. It
 * keeps unit members durable while exposing fused groups as one command entity.
 */
export class MilitaryIndustryService {
  private readonly wallet: WalletService;
  private warCampWarfare: WarCampWarfareService | null = null;

  /** War Camp health and damage (B2): hand, Bomber and Siege attacks, burn-out removal. */
  get warCamps(): WarCampWarfareService {
    this.warCampWarfare ??= new WarCampWarfareService(this.pool);
    return this.warCampWarfare;
  }

  /** Flag ids changed by background Ballista volleys. The realtime supervisor
   * drains this bounded set so cadence damage gets the same canonical
   * FLAG_UPDATED publication as an explicit volley command. */
  private readonly reconciledBallistaFlagIds = new Set<string>();
  private readonly reconciledCityStructureIds = new Set<string>();
  /** Background cadence volleys queued for owner-scoped realtime cues. */
  private readonly reconciledBallistaVolleyCues = new Map<string, MilitarySiegeVolleyCue[]>();
  private readonly reconciledBomberDetonationCues: Array<{ playerId: string; cue: MilitaryBomberDetonationCue }> = [];
  /** Trust hostile-action gate (NATIVE_ANTISPOOF_BUILD_PLAN.md 3.4): false
   * holds an owner's automatic Siege fire (the group stays deployed). */
  private automaticFirePolicy: ((ownerPlayerId: string) => Promise<boolean>) | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly worldId: string,
    private readonly inventory: Pick<
      InventoryService,
      "debitItemsForOperationInTransaction" |
      "grantItemsForOperationInTransaction" |
      "snapshotInTransaction"
    >,
    wallet?: WalletService,
    private readonly bomberFlagDeletion?: (client: pg.PoolClient, flagId: string, bomberPlayerId: string) => Promise<BomberFlagDeletion>,
    private readonly playerMovementSpeedMps = DEFAULT_PLAYER_SPEED_MPS,
    private readonly burningFlagDeletion?: (client: pg.PoolClient, flagId: string, burnerPlayerId: string) => Promise<BomberFlagDeletion>
  ) {
    this.wallet = wallet ?? new WalletService(pool);
  }

  setAutomaticFirePolicy(policy: ((ownerPlayerId: string) => Promise<boolean>) | null): void {
    this.automaticFirePolicy = policy;
  }

  async snapshot(playerId: string, viewer?: MilitaryCommandPlayer): Promise<MilitaryIndustrySnapshot> {
    await this.reconcileDueTrainingJobs();
    await this.reconcileDueRecovery();
    await this.reconcileDueRallies();
    await this.reconcileDueBomberDemolitions();
    await this.reconcileDueBallistaVolleys();
    await this.reconcileDueMilitarySiegePacking();
    const [lodge, personnel, units, groups, warCamp, jobs, bomberChannel, visible, visibleWarCamps] = await Promise.all([
      this.loadLodge(this.pool, playerId),
      this.loadPersonnel(this.pool, playerId),
      this.loadUnits(this.pool, playerId),
      this.loadGroups(this.pool, playerId),
      this.loadWarCamp(this.pool, playerId),
      this.loadPlayerJobs(this.pool, playerId),
      this.loadBomberChannel(this.pool, playerId),
      viewer ? this.loadVisibleGroups(this.pool, viewer) : Promise.resolve(null),
      viewer ? this.loadVisibleWarCamps(this.pool, viewer) : Promise.resolve(null)
    ]);
    const snapshot = snapshotOf(lodge, personnel, units, groups, warCamp, jobs, bomberChannel, Date.now(), visible);
    return visibleWarCamps ? { ...snapshot, visibleWarCamps: visibleWarCamps.map(mapWarCamp) } : snapshot;
  }

  async spawnDeveloperUnit(
    player: Pick<PlayerRecord, "playerId" | "position">,
    unitType: MilitaryUnitType,
    requestId: string
  ): Promise<DeveloperMilitarySpawnResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    if (
      player.position.lat < -90 ||
      player.position.lat > 90 ||
      player.position.lon < -180 ||
      player.position.lon > 180
    ) {
      throw new MilitaryIndustryError("MILITARY_INVALID_POSITION", "Your world position is unavailable.");
    }
    const maxHp = MILITARY_UNIT_MAX_HP[unitType];
    if (!Number.isSafeInteger(maxHp)) {
      throw new MilitaryIndustryError("MILITARY_INVALID_UNIT_TYPE", "That developer military unit type is unavailable.");
    }
    const requestHash = hashRequest(
      "developer_spawn",
      player.playerId,
      unitType,
      player.position.lat,
      player.position.lon
    );
    const operationKey = `military-developer-spawn:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await replayMilitaryOperation(
        client,
        player.playerId,
        requestId,
        "developer_spawn",
        requestHash
      );
      if (prior) {
        const unitId = typeof prior.result?.unitId === "string" ? prior.result.unitId : null;
        const groupId = typeof prior.result?.groupId === "string" ? prior.result.groupId : null;
        if (!unitId || !groupId) {
          throw new MilitaryIndustryError("MILITARY_REPLAY_CONFLICT", "That developer military request has no replayable result.");
        }
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { snapshot, unitId, groupId, replayed: true };
      }
      await reserveMilitaryOperation(
        client,
        operationKey,
        player.playerId,
        requestId,
        "developer_spawn",
        requestHash
      );
      // A developer Siege starts in the same packed field state as a normal
      // non-deployed field unit.  The explicit Deploy command is what arms
      // its target selection and volley cadence; the other developer unit
      // fixtures retain their deployed test-spawn behavior.
      const initialLocationState = unitType === "field_ballista"
        ? "PACKED_FIELD"
        : "DEPLOYED_FIELD";
      const groupResult = await client.query<{ group_id: string }>(
        `INSERT INTO military_unit_groups (
           owner_player_id,unit_type,location_state,lat,lon,revision
         ) VALUES ($1,$2,$3,$4,$5,1)
         RETURNING group_id::text`,
        [player.playerId, unitType, initialLocationState, player.position.lat, player.position.lon]
      );
      const groupId = groupResult.rows[0]?.group_id;
      if (!groupId) throw new MilitaryIndustryError("MILITARY_SPAWN_FAILED", "Developer military group could not be created.");
      const unitResult = await client.query<{ unit_id: string }>(
        `INSERT INTO military_units (
           owner_player_id,unit_type,home_city_id,current_hp,max_hp,status,
           location_state,station_city_id,war_camp_id,lat,lon,group_id,revision
         ) VALUES ($1,$2,NULL,$3,$3,'available',$4,NULL,NULL,$5,$6,$7::uuid,1)
         RETURNING unit_id::text`,
        [player.playerId, unitType, maxHp, initialLocationState, player.position.lat, player.position.lon, groupId]
      );
      const unitId = unitResult.rows[0]?.unit_id;
      if (!unitId) throw new MilitaryIndustryError("MILITARY_SPAWN_FAILED", "Developer military unit could not be created.");
      await completeMilitaryOperation(client, operationKey, { unitId, groupId, unitType });
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, unitId, groupId, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async buildLodge(
    player: Pick<PlayerRecord, "playerId" | "regionCode" | "position" | "anchor" | "moveLeashRadiusM">,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    const requestHash = hashRequest("build_lodge", player.playerId);
    const operationKey = `military-lodge:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const replay = await this.replayLodgeOperation(client, player.playerId, requestId, "build", requestHash);
      if (replay) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { snapshot, inventory, replayed: true };
      }
      const existing = await this.loadLodge(client, player.playerId, true);
      if (existing) throw new MilitaryIndustryError("LODGE_ALREADY_EXISTS", "You may own only one Lodge.");
      const positionedCityId = await resolveCityAtPosition(
        client,
        this.worldId,
        player.position,
        "lodge"
      );
      await lockPlayerAndCity(client, player.playerId, positionedCityId);
      await lockCity(client, positionedCityId, this.worldId);
      const lockedCityId = await resolveCityAtPosition(
        client,
        this.worldId,
        player.position,
        "lodge"
      );
      if (lockedCityId !== positionedCityId) {
        throw new MilitaryIndustryError(
          "LODGE_CITY_TERRITORY_CHANGED",
          "City territory changed before the Lodge could be placed."
        );
      }
      await requireActiveCityMemberForMilitary(
        client,
        player.playerId,
        positionedCityId,
        "Lodge"
      );
      await validateCityTerritoryFootprint(
        client,
        positionedCityId,
        player.position,
        LODGE_FOOTPRINT_RADIUS_M,
        "lodge"
      );
      await requireLodgeClearance(client, this.worldId, player.regionCode, player.position, player.anchor, player.moveLeashRadiusM);
      const lodgeId = randomUUID();
      await reserveLodgeOperation(client, {
        operationKey,
        playerId: player.playerId,
        requestId,
        action: "build",
        requestHash,
        lodgeId
      });
      const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:materials`,
        playerId: player.playerId,
        source: "lodge_construction",
        sourceEntityType: "player_lodge",
        sourceEntityId: lodgeId,
        metadata: { requestId, level: 1 },
        debits: LODGE_COSTS[1].materials.map((material) => ({
          itemId: material.itemId,
          variant: DEFAULT_INVENTORY_VARIANT,
          quantity: BigInt(material.quantity)
        }))
      });
      const inserted = await client.query<LodgeRow>(
        `INSERT INTO player_lodges (
           lodge_id,owner_player_id,world_id,region_code,lat,lon,geom,footprint_geom,
           footprint_radius_m,level
         ) VALUES ($1,$2,$3,$4,$5,$6,
           ST_SetSRID(ST_MakePoint($6,$5),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,$7)::geometry,
           $7,1
         ) RETURNING lodge_id,owner_player_id,world_id,region_code,lat,lon,level,
           reserved_capacity,placement_revision::text,built_at,upgraded_at`,
        [lodgeId, player.playerId, this.worldId, player.regionCode, player.position.lat, player.position.lon, LODGE_FOOTPRINT_RADIUS_M]
      );
      const lodge = requireRow(inserted.rows[0], "Lodge placement failed");
      const result = await this.snapshotInTransaction(client, player.playerId);
      await completeLodgeOperation(client, operationKey, { lodge: mapLodge(lodge) });
      await client.query("COMMIT");
      return { snapshot: result, inventory: debited.inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async upgradeLodge(
    playerId: string,
    requestId: string,
    expectedLevel: LodgeLevel
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    const requestHash = hashRequest("upgrade_lodge", playerId, expectedLevel);
    const operationKey = `military-lodge:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, playerId);
      const replay = await this.replayLodgeOperation(client, playerId, requestId, "upgrade", requestHash);
      if (replay) {
        const snapshot = await this.snapshotInTransaction(client, playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return { snapshot, inventory, replayed: true };
      }
      const lodge = await this.loadLodge(client, playerId, true);
      if (!lodge) throw new MilitaryIndustryError("LODGE_REQUIRED", "Build a Lodge first.");
      if (lodge.level !== expectedLevel) {
        throw new MilitaryIndustryError("LODGE_STALE_LEVEL", `Expected Lodge ${expectedLevel}; this Lodge is ${lodge.level}.`);
      }
      if (lodge.level >= 5) throw new MilitaryIndustryError("LODGE_MAXIMUM_LEVEL", "This Lodge is already Lodge V.");
      const targetLevel = (lodge.level + 1) as LodgeLevel;
      await reserveLodgeOperation(client, {
        operationKey,
        playerId,
        requestId,
        action: "upgrade",
        requestHash,
        lodgeId: lodge.lodge_id
      });
      await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:materials`,
        playerId,
        source: "lodge_upgrade",
        sourceEntityType: "player_lodge",
        sourceEntityId: lodge.lodge_id,
        metadata: { requestId, fromLevel: lodge.level, targetLevel },
        debits: LODGE_COSTS[targetLevel].materials.map((material) => ({
          itemId: material.itemId,
          variant: DEFAULT_INVENTORY_VARIANT,
          quantity: BigInt(material.quantity)
        }))
      });
      const updated = await client.query<LodgeRow>(
        `UPDATE player_lodges
         SET level=$2,placement_revision=placement_revision+1,upgraded_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE lodge_id=$1 AND owner_player_id=$3 AND level=$4 AND removed_at IS NULL
         RETURNING lodge_id,owner_player_id,world_id,region_code,lat,lon,level,
           reserved_capacity,placement_revision::text,built_at,upgraded_at`,
        [lodge.lodge_id, targetLevel, playerId, expectedLevel]
      );
      const next = requireRow(updated.rows[0], "Lodge level changed before the upgrade completed.");
      await completeLodgeOperation(client, operationKey, { lodge: mapLodge(next) });
      const snapshot = await this.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      return { snapshot, inventory: await this.inventory.snapshotInTransaction(client, playerId), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async destroyLodge(playerId: string, requestId: string): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    const requestHash = hashRequest("destroy_lodge", playerId);
    const operationKey = `military-lodge:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, playerId);
      const replay = await this.replayLodgeOperation(client, playerId, requestId, "destroy", requestHash);
      if (replay) {
        const snapshot = await this.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return { snapshot, replayed: true };
      }
      const lodge = await this.loadLodge(client, playerId, true);
      if (!lodge) throw new MilitaryIndustryError("LODGE_REQUIRED", "You do not own a Lodge.");
      const activePersonnel = await client.query(
        `SELECT 1 FROM (
           SELECT 1 FROM military_personnel
           WHERE owner_player_id=$1 AND status IN ('training','available','assigned','recovering')
           UNION ALL
           SELECT 1 FROM military_units
           WHERE owner_player_id=$1 AND status <> 'destroyed'
           UNION ALL
           SELECT 1 FROM military_facility_jobs
           WHERE owner_player_id=$1 AND cleared_at IS NULL
         ) active LIMIT 1`,
        [playerId]
      );
      if (activePersonnel.rowCount) {
        throw new MilitaryIndustryError("LODGE_PERSONNEL_PRESENT", "Settle all Lodge units, personnel, and jobs before removing the Lodge.");
      }
      await reserveLodgeOperation(client, {
        operationKey,
        playerId,
        requestId,
        action: "destroy",
        requestHash,
        lodgeId: lodge.lodge_id
      });
      const removed = await client.query<LodgeRow>(
        `UPDATE player_lodges SET removed_at=clock_timestamp(),removal_reason='player_request',
           placement_revision=placement_revision+1,updated_at=clock_timestamp()
         WHERE lodge_id=$1 AND owner_player_id=$2 AND removed_at IS NULL
         RETURNING lodge_id,owner_player_id,world_id,region_code,lat,lon,level,
           reserved_capacity,placement_revision::text,built_at,upgraded_at`,
        [lodge.lodge_id, playerId]
      );
      if (!removed.rows[0]) throw new MilitaryIndustryError("LODGE_STALE", "The Lodge changed before removal was confirmed.");
      await completeLodgeOperation(client, operationKey, { lodge: null });
      const snapshot = await this.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      return { snapshot, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async startSiegeCrewTraining(
    player: Pick<PlayerRecord, "playerId" | "position">,
    accountId: string,
    facilityStructureId: string,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    void player;
    void accountId;
    void facilityStructureId;
    void requestId;
    throw new MilitaryIndustryError(
      "SIEGE_CREW_RETIRED",
      "Standalone Siege Crew training has been retired; Field Ballista units include their crew."
    );
  }

  async startMilitaryUnitTraining(
    player: Pick<PlayerRecord, "playerId" | "position">,
    accountId: string,
    facilityStructureId: string,
    unitType: Exclude<MilitaryUnitType, "field_ballista">,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    return this.startJob(player, accountId, facilityStructureId, requestId, `train_${unitType}`, 1);
  }

  async manufactureFieldBallista(
    player: Pick<PlayerRecord, "playerId" | "position">,
    accountId: string,
    facilityStructureId: string,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    return this.startJob(player, accountId, facilityStructureId, requestId, "manufacture_field_ballista", 1);
  }

  async startRepairKitBatch(
    player: Pick<PlayerRecord, "playerId" | "position">,
    facilityStructureId: string,
    requestId: string,
    quantity: number
  ): Promise<MilitaryMutationResult> {
    return this.startJob(player, null, facilityStructureId, requestId, "repair_kit_batch", quantity);
  }

  async startTorchBatch(
    player: Pick<PlayerRecord, "playerId" | "position">,
    facilityStructureId: string,
    requestId: string,
    quantity: number
  ): Promise<MilitaryMutationResult> {
    return this.startJob(player, null, facilityStructureId, requestId, "torch_batch", quantity);
  }

  async startFieldBallistaKit(): Promise<never> {
    throw new MilitaryIndustryError(
      "FIELD_BALLISTA_FUTURE_GATED",
      "Field Ballista Kit production will be enabled with the siege deployment slice."
    );
  }

  async collectJob(
    player: Pick<PlayerRecord, "playerId" | "position">,
    jobId: string,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    const requestHash = hashRequest("collect_military_job", player.playerId, jobId);
    const operationKey = `military-collect:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      await this.reconcileDueTrainingJobsInTransaction(client);
      const prior = await client.query<{ request_hash: string; completed_at: Date | string | null }>(
        `SELECT request_hash,completed_at FROM military_job_operations
         WHERE player_id=$1 AND request_id=$2 FOR UPDATE`,
        [player.playerId, requestId]
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash || !prior.rows[0].completed_at) {
          throw new MilitaryIndustryError("MILITARY_REPLAY_CONFLICT", "That collection request ID was already used for different work.");
        }
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { snapshot, inventory, replayed: true };
      }
      const jobResult = await client.query<JobRow>(
        `SELECT job_id,facility_structure_id,owner_player_id,job_type,quantity,output_quantity,
           collected_quantity,request_id,request_hash,started_at,completes_at,cleared_at
         FROM military_facility_jobs WHERE job_id=$1::uuid AND owner_player_id=$2 FOR UPDATE`,
        [jobId, player.playerId]
      );
      const job = jobResult.rows[0];
      if (!job) throw new MilitaryIndustryError("MILITARY_JOB_NOT_FOUND", "That production job is unavailable.");
      if (job.job_type === "train_siege_crew" || unitTypeForJob(job.job_type)) {
        throw new MilitaryIndustryError("MILITARY_JOB_NO_OUTPUT", "Unit production settles directly into your Lodge roster.");
      }
      if (job.cleared_at || job.collected_quantity >= job.output_quantity) {
        throw new MilitaryIndustryError("MILITARY_JOB_ALREADY_COLLECTED", "That production output has already been collected.");
      }
      if (Date.now() < new Date(job.completes_at).getTime()) {
        throw new MilitaryIndustryError("MILITARY_OUTPUT_NOT_READY", "This production batch is not ready yet.");
      }
      if (job.job_type !== "repair_kit_batch" && job.job_type !== "torch_batch") {
        throw new MilitaryIndustryError("MILITARY_JOB_RETIRED", "That military production job has been retired.");
      }
      const outputItem: ResourceType = job.job_type === "repair_kit_batch" ? "repair_kit" : "torch";
      const remaining = job.output_quantity - job.collected_quantity;
      const grant = await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `military-job:${player.playerId}:${requestId}:output`,
        playerId: player.playerId,
        source: job.job_type === "repair_kit_batch"
          ? "demolition_factory_repair_kit_batch"
          : "demolition_factory_torch_batch",
        sourceEntityType: "military_facility_job",
        sourceEntityId: job.job_id,
        metadata: { requestId, jobType: job.job_type },
        grants: [{ itemId: outputItem, variant: DEFAULT_INVENTORY_VARIANT, quantity: remaining }],
        allowPartial: true
      });
      const granted = grant.grants[0]?.grantedQuantity ?? 0;
      if (granted <= 0) throw new MilitaryIndustryError("MILITARY_INVENTORY_FULL", "Make room in your Inventory before collecting this output.");
      await client.query(
        `UPDATE military_facility_jobs
         SET collected_quantity=collected_quantity+$2,
             cleared_at=CASE WHEN collected_quantity+$2>=output_quantity THEN clock_timestamp() ELSE NULL END,
             updated_at=clock_timestamp()
         WHERE job_id=$1`,
        [job.job_id, granted]
      );
      await client.query(
        `INSERT INTO military_job_operations (
           operation_key,player_id,request_id,action,request_hash,job_id,result,completed_at
         ) VALUES ($1,$2,$3,'collect',$4,$5,$6::jsonb,clock_timestamp())`,
        [operationKey, player.playerId, requestId, requestHash, job.job_id, JSON.stringify({ granted })]
      );
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, inventory: grant.inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async reconcileDueTrainingJobs(limit = 100): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const count = await this.reconcileDueTrainingJobsInTransaction(client, limit);
      await client.query("COMMIT");
      return count;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async reconcileDueTrainingJobsInTransaction(client: pg.PoolClient, limit = 100): Promise<number> {
    const due = await client.query<{ job_id: string }>(
      `SELECT job_id::text FROM military_facility_jobs
       WHERE cleared_at IS NULL AND completes_at<=clock_timestamp()
       ORDER BY completes_at,job_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    let completed = 0;
    for (const row of due.rows) {
      const job = await client.query<JobRow>(
        `SELECT job_id,facility_structure_id,owner_player_id,job_type,quantity,output_quantity,
           collected_quantity,request_id,request_hash,started_at,completes_at,cleared_at
         FROM military_facility_jobs WHERE job_id=$1::uuid FOR UPDATE`,
        [row.job_id]
      );
      const training = job.rows[0];
      if (!training || training.cleared_at) continue;
      const unitType = unitTypeForJob(training.job_type);
      if (unitType) {
        const facility = await client.query<{ city_id: string }>(
          `SELECT city_id::text FROM city_structures WHERE structure_id=$1::uuid AND state='active' FOR SHARE`,
          [training.facility_structure_id]
        );
        const cityId = facility.rows[0]?.city_id;
        if (!cityId) throw new MilitaryIndustryError("MILITARY_FACILITY_UNAVAILABLE", "The producing City no longer exists.");
        for (let index = 0; index < Number(training.quantity); index += 1) {
          const created = await client.query<{ unit_id: string }>(
            `INSERT INTO military_units (
               owner_player_id,unit_type,home_city_id,current_hp,max_hp,status,
               location_state,station_city_id,revision
             ) VALUES ($1,$2,$3,$4,$4,'available','STATIONED_CITY',$3,1)
             RETURNING unit_id::text`,
            [training.owner_player_id, unitType, cityId, MILITARY_UNIT_MAX_HP[unitType]]
          );
          const unitId = created.rows[0]?.unit_id;
          if (!unitId) throw new MilitaryIndustryError("MILITARY_TRAINING_INCOMPLETE", "Military unit training could not settle safely.");
          const group = await client.query<{ group_id: string }>(
            `INSERT INTO military_unit_groups (
               owner_player_id,unit_type,location_state,station_city_id,revision
             ) VALUES ($1,$2,'STATIONED_CITY',$3,1) RETURNING group_id::text`,
            [training.owner_player_id, unitType, cityId]
          );
          await client.query(
            `UPDATE military_units SET group_id=$2::uuid,updated_at=clock_timestamp() WHERE unit_id=$1::uuid`,
            [unitId, group.rows[0]!.group_id]
          );
        }
        await client.query(
          `UPDATE player_lodges lodge
           SET reserved_capacity=GREATEST(0,reserved_capacity-$2),updated_at=clock_timestamp()
           WHERE lodge.owner_player_id=$1 AND lodge.removed_at IS NULL`,
          [training.owner_player_id, Number(training.quantity)]
        );
      } else if (training.job_type === "train_siege_crew") {
        // A pre-0822 row is retired; migration normally clears it first.
        await client.query(
          `UPDATE player_lodges lodge
           SET reserved_capacity=GREATEST(0,reserved_capacity-$2),updated_at=clock_timestamp()
           WHERE lodge.owner_player_id=$1 AND lodge.removed_at IS NULL`,
          [training.owner_player_id, SIEGE_CREW_CAPACITY_COST]
        );
      } else {
        continue;
      }
      await client.query(
        `UPDATE military_facility_jobs
         SET collected_quantity=output_quantity,cleared_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE job_id=$1::uuid`,
        [training.job_id]
      );
      completed += 1;
    }
    return completed;
  }

  private async startJob(
    player: Pick<PlayerRecord, "playerId" | "position">,
    accountId: string | null,
    facilityStructureId: string,
    requestId: string,
    jobType: Exclude<MilitaryJobType, "field_ballista_kit">,
    quantity: number
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    const normalizedQuantity = requireQuantity(jobType, quantity);
    const requestHash = hashRequest(jobType, player.playerId, facilityStructureId, normalizedQuantity);
    const operationKey = `military-job:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      await this.reconcileDueTrainingJobsInTransaction(client);
      const existing = await client.query<JobRow>(
        `SELECT job_id,facility_structure_id,owner_player_id,job_type,quantity,output_quantity,
           collected_quantity,request_id,request_hash,started_at,completes_at,cleared_at
         FROM military_facility_jobs WHERE owner_player_id=$1 AND request_id=$2 FOR UPDATE`,
        [player.playerId, requestId]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw new MilitaryIndustryError("MILITARY_REPLAY_CONFLICT", "That request ID was already used for a different military job.");
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        const walletSnapshot = (unitTypeForJob(jobType) || jobType === "train_siege_crew") && accountId
          ? await this.wallet.snapshotInTransaction(client, player.playerId, accountId)
          : null;
        await client.query("COMMIT");
        return {
          snapshot,
          inventory,
          ...(walletSnapshot
            ? { walletGold: walletSnapshot.gold, walletVersion: walletSnapshot.revision }
            : {}),
          replayed: true
        };
      }
      await requireFacilityForMember(client, player.playerId, facilityStructureId, player.position, jobType);
      const facilityLock = await client.query<{ structure_id: string }>(
        `SELECT structure_id::text FROM city_structures WHERE structure_id=$1::uuid AND state='active' FOR UPDATE`,
        [facilityStructureId]
      );
      if (!facilityLock.rows[0]) throw new MilitaryIndustryError("MILITARY_FACILITY_UNAVAILABLE", "That City facility is unavailable.");
      const queue = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM military_facility_jobs
         WHERE facility_structure_id=$1::uuid AND cleared_at IS NULL`,
        [facilityStructureId]
      );
      if (Number(queue.rows[0]?.count ?? 0) >= MILITARY_FACILITY_QUEUE_CAPACITY) {
        throw new MilitaryIndustryError("MILITARY_QUEUE_FULL", "This facility's shared queue is full.");
      }
      const existingJobs = await client.query<{ completes_at: Date | string }>(
        `SELECT completes_at FROM military_facility_jobs
         WHERE facility_structure_id=$1::uuid AND cleared_at IS NULL ORDER BY completes_at DESC,job_id DESC LIMIT 1`,
        [facilityStructureId]
      );
      const now = Date.now();
      const scheduledStart = Math.max(now, existingJobs.rows[0] ? new Date(existingJobs.rows[0].completes_at).getTime() : now);
      if (jobType === "train_siege_crew") {
        throw new MilitaryIndustryError("SIEGE_CREW_RETIRED", "Standalone Siege Crew training has been retired.");
      }
      const unitType = unitTypeForJob(jobType);
      const unitRecipe = unitType ? MILITARY_UNIT_RECIPES[unitType] : null;
      const duration = unitRecipe?.durationMs ??
        jobType === "repair_kit_batch" ? ARMORY_REPAIR_KIT_DURATION_MS : POWDER_WORKS_TORCH_DURATION_MS;
      const outputQuantity = unitType ? normalizedQuantity :
        jobType === "repair_kit_batch" ? normalizedQuantity :
          normalizedQuantity * POWDER_WORKS_TORCH_OUTPUT_QUANTITY;
      let inventory: PlayerInventorySnapshot | undefined;
      let walletGold: string | undefined;
      let walletVersion: string | undefined;
      if (unitType) {
        if (!accountId) throw new MilitaryIndustryError("MILITARY_WALLET_REQUIRED", "An authenticated wallet is required to train a military unit.");
        const lodge = await this.loadLodge(client, player.playerId, true);
        if (!lodge) throw new MilitaryIndustryError("LODGE_REQUIRED", "Build a Lodge before training military units.");
        const occupiedResult = await client.query<{ occupied: string }>(
          `SELECT (
             COALESCE((SELECT count(*) FROM military_units WHERE owner_player_id=$1 AND status <> 'destroyed'),0)
             + COALESCE((SELECT sum(capacity_cost) FROM military_personnel
                         WHERE owner_player_id=$1 AND status IN ('available','assigned','recovering')),0)
           )::text AS occupied`,
          [player.playerId]
        );
        const occupied = Number(occupiedResult.rows[0]?.occupied ?? 0);
        const capacity = LODGE_CAPACITY_BY_LEVEL[lodge.level as LodgeLevel];
        if (occupied + lodge.reserved_capacity + normalizedQuantity > capacity) {
          throw new MilitaryIndustryError("LODGE_CAPACITY_FULL", `Your Lodge has no room for another military unit (${occupied + lodge.reserved_capacity}/${capacity} used).`);
        }
        const recipe = unitRecipe!;
        // Counted under the Lodge row lock above, so parallel trains cannot both pay the base price.
        const ownedBombers = unitType === "bomber"
          ? Number((await client.query<{ owned: string }>(
              `SELECT (
                 COALESCE((SELECT count(*) FROM military_units
                           WHERE owner_player_id=$1 AND unit_type='bomber' AND status <> 'destroyed'),0)
                 + COALESCE((SELECT sum(quantity) FROM military_facility_jobs
                             WHERE owner_player_id=$1 AND job_type='train_bomber' AND cleared_at IS NULL),0)
               )::text AS owned`,
              [player.playerId]
            )).rows[0]?.owned ?? 0)
          : 0;
        const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `${operationKey}:materials`,
          playerId: player.playerId,
          source: `${unitType}_training`,
          sourceEntityType: "military_facility_job",
          sourceEntityId: facilityStructureId,
          metadata: { requestId, jobType, quantity: normalizedQuantity },
          debits: recipe.materials.map((input) => ({
            itemId: input.itemId,
            variant: DEFAULT_INVENTORY_VARIANT,
            quantity: BigInt(unitType === "bomber" && input.itemId === "crude_oil"
              ? bomberCrudeOilCost(ownedBombers, normalizedQuantity)
              : input.quantity * normalizedQuantity)
          }))
        });
        inventory = debited.inventory;
        const wallet = await client.query<{ account_id: string }>("SELECT account_id::text FROM players WHERE id=$1 FOR UPDATE", [player.playerId]);
        if (wallet.rows[0]?.account_id !== accountId) throw new MilitaryIndustryError("MILITARY_WALLET_REQUIRED", "Authenticated wallet ownership is invalid.");
        if (recipe.gold > 0) {
          try {
            await this.wallet.debitForOperationInTransaction(client, {
              playerId: player.playerId,
              accountId,
              amount: BigInt(recipe.gold * normalizedQuantity),
              operationKey: `${operationKey}:gold`,
              reason: `${unitType}_training`,
              metadata: { requestId, facilityStructureId }
            });
          } catch (error) {
            if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
              throw new MilitaryIndustryError("MILITARY_GOLD_REQUIRED", `You need ${recipe.gold * normalizedQuantity} Gold for this unit.`);
            }
            throw error;
          }
        }
        const walletSnapshot = await this.wallet.snapshotInTransaction(client, player.playerId, accountId);
        walletGold = walletSnapshot.gold;
        walletVersion = walletSnapshot.revision;
        await client.query(
          `UPDATE player_lodges SET reserved_capacity=reserved_capacity+$2,updated_at=clock_timestamp()
           WHERE lodge_id=$1 AND removed_at IS NULL`,
          [lodge.lodge_id, normalizedQuantity]
        );
      } else {
        const inputs = jobType === "repair_kit_batch"
          ? ARMORY_REPAIR_KIT_INPUTS.map((input) => ({ itemId: input.itemId, quantity: input.quantity * normalizedQuantity }))
          : POWDER_WORKS_TORCH_INPUTS.map((input) => ({ itemId: input.itemId, quantity: input.quantity * normalizedQuantity }));
        const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `${operationKey}:materials`,
          playerId: player.playerId,
          source: jobType === "repair_kit_batch"
            ? "demolition_factory_repair_kit_batch"
            : "demolition_factory_torch_batch",
          sourceEntityType: "military_facility_job",
          sourceEntityId: facilityStructureId,
          metadata: { requestId, jobType, quantity: normalizedQuantity },
          debits: inputs.map((input) => ({ itemId: input.itemId, variant: DEFAULT_INVENTORY_VARIANT, quantity: BigInt(input.quantity) }))
        });
        inventory = debited.inventory;
      }
      const inserted = await client.query<JobRow>(
        `INSERT INTO military_facility_jobs (
           facility_structure_id,owner_player_id,job_type,quantity,output_quantity,
           request_id,request_hash,started_at,completes_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8 / 1000.0),to_timestamp($9 / 1000.0))
         RETURNING job_id,facility_structure_id,owner_player_id,job_type,quantity,output_quantity,
           collected_quantity,request_id,request_hash,started_at,completes_at,cleared_at`,
        [facilityStructureId, player.playerId, jobType, normalizedQuantity, outputQuantity, requestId, requestHash, scheduledStart, scheduledStart + duration]
      );
      requireRow(inserted.rows[0], "Military production job could not be started.");
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return {
        snapshot,
        ...(inventory ? { inventory } : {}),
        ...(walletGold !== undefined ? { walletGold } : {}),
        ...(walletVersion !== undefined ? { walletVersion } : {}),
        replayed: false
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  private async snapshotInTransaction(client: pg.PoolClient, playerId: string): Promise<MilitaryIndustrySnapshot> {
    const [lodge, personnel, units, groups, warCamp, jobs, bomberChannel] = await Promise.all([
      this.loadLodge(client, playerId),
      this.loadPersonnel(client, playerId),
      this.loadUnits(client, playerId),
      this.loadGroups(client, playerId),
      this.loadWarCamp(client, playerId),
      this.loadPlayerJobs(client, playerId),
      this.loadBomberChannel(client, playerId)
    ]);
    return snapshotOf(lodge, personnel, units, groups, warCamp, jobs, bomberChannel, Date.now());
  }

  /**
   * Reconcile durable field groups at the authoritative relocation boundary.
   * A following group can move with its owner only to an owned City or the
   * owner's exact War Camp anchor. Other relocations leave it in the field;
   * FOLLOWING_PLAYER is made explicit as DEPLOYED_FIELD so a reconnect cannot
   * infer that it should teleport with the player.
   */
  async preserveMilitaryOnTravel(
    input: MilitaryTravelInput,
    transactionClient?: pg.PoolClient
  ): Promise<MilitaryTravelResult> {
    requirePosition(input.destinationCenter);
    requirePosition(input.lastKnownPosition);
    const client = transactionClient ?? await this.pool.connect();
    const ownsTransaction = transactionClient === undefined;
    try {
      if (ownsTransaction) await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, input.playerId);
      const groups = await client.query<Pick<
        MilitaryUnitGroupRow,
        "group_id" | "location_state" | "lat" | "lon"
      >>(
        `SELECT group_id::text,location_state,lat,lon
         FROM military_unit_groups
         WHERE owner_player_id=$1
           AND location_state IN ('FOLLOWING_PLAYER','DEPLOYED_FIELD')
           AND EXISTS (
             SELECT 1 FROM military_units unit
             WHERE unit.group_id=military_unit_groups.group_id
               AND unit.owner_player_id=$1
               AND unit.status <> 'destroyed'
           )
         ORDER BY created_at,group_id
         FOR UPDATE`,
        [input.playerId]
      );
      if (groups.rows.length === 0) {
        if (ownsTransaction) await client.query("COMMIT");
        return { accompaniedGroups: 0, leftBehindGroups: 0, warning: null };
      }
      for (const group of groups.rows) {
        await cancelPendingBomberChannelsForGroup(client, group.group_id, input.playerId);
      }

      const canAccompany = input.operationKind !== "gps_relocate" &&
        await hasCompatibleMilitaryAnchor(client, this.worldId, input);
      if (canAccompany) {
        for (const group of groups.rows) {
          await client.query(
            `UPDATE military_units
             SET lat=$2,lon=$3,revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$4::uuid
               AND status <> 'destroyed'
               AND location_state IN ('FOLLOWING_PLAYER','DEPLOYED_FIELD')
               AND (lat IS DISTINCT FROM $2 OR lon IS DISTINCT FROM $3)`,
            [
              input.playerId,
              input.destinationCenter.lat,
              input.destinationCenter.lon,
              group.group_id
            ]
          );
          await client.query(
            `UPDATE military_unit_groups
             SET lat=$2,lon=$3,revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$4::uuid
               AND (lat IS DISTINCT FROM $2 OR lon IS DISTINCT FROM $3)`,
            [
              input.playerId,
              input.destinationCenter.lat,
              input.destinationCenter.lon,
              group.group_id
            ]
          );
        }
        if (ownsTransaction) await client.query("COMMIT");
        return {
          accompaniedGroups: groups.rows.length,
          leftBehindGroups: 0,
          warning: null
        };
      }

      for (const group of groups.rows) {
        await client.query(
          `UPDATE military_units
           SET location_state=CASE
                 WHEN location_state='FOLLOWING_PLAYER' THEN 'DEPLOYED_FIELD'
                 ELSE location_state
               END,
               station_city_id=NULL,war_camp_id=NULL,
               lat=COALESCE(lat,$2),lon=COALESCE(lon,$3),
               revision=revision+1,updated_at=clock_timestamp()
           WHERE owner_player_id=$1 AND group_id=$4::uuid
             AND status <> 'destroyed'
             AND location_state IN ('FOLLOWING_PLAYER','DEPLOYED_FIELD')
             AND (
               location_state='FOLLOWING_PLAYER'
               OR lat IS NULL OR lon IS NULL
             )`,
          [
            input.playerId,
            input.lastKnownPosition.lat,
            input.lastKnownPosition.lon,
            group.group_id
          ]
        );
        await client.query(
          `UPDATE military_unit_groups
           SET location_state=CASE
                 WHEN location_state='FOLLOWING_PLAYER' THEN 'DEPLOYED_FIELD'
                 ELSE location_state
               END,
               station_city_id=NULL,war_camp_id=NULL,
               lat=COALESCE(lat,$2),lon=COALESCE(lon,$3),
               revision=revision+1,updated_at=clock_timestamp()
           WHERE owner_player_id=$1 AND group_id=$4::uuid
             AND (
               location_state='FOLLOWING_PLAYER'
               OR lat IS NULL OR lon IS NULL
             )`,
          [
            input.playerId,
            input.lastKnownPosition.lat,
            input.lastKnownPosition.lon,
            group.group_id
          ]
        );
      }
      if (ownsTransaction) await client.query("COMMIT");
      return {
        accompaniedGroups: 0,
        leftBehindGroups: groups.rows.length,
        warning: MILITARY_TRAVEL_WARNING
      };
    } catch (error) {
      if (ownsTransaction) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  /** Cancel a pending Bomber demolition when an accepted world movement command
   * changes the player's approach. WorldRuntime retains ownership of movement;
   * this only closes the durable channel safely. */
  async cancelBomberDemolitionsForMovement(playerId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, playerId);
      await client.query(
        `UPDATE military_siege_operations
         SET status='cancelled',completed_at=clock_timestamp()
         WHERE player_id=$1 AND action='demolish_flag' AND status='pending'`,
        [playerId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async reconcileDueRecovery(limit = 100): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{ unit_id: string; home_city_id: string | null }>(
        `SELECT unit_id::text,home_city_id::text FROM military_units
         WHERE status='recovering' AND next_recovery_at IS NOT NULL
           AND next_recovery_at<=clock_timestamp()
         ORDER BY next_recovery_at,unit_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit]
      );
      for (const row of due.rows) {
        await client.query(
          `UPDATE military_units
           SET current_hp=max_hp,status='available',location_state='STATIONED_CITY',
               station_city_id=home_city_id,war_camp_id=NULL,lat=NULL,lon=NULL,
               next_recovery_at=NULL,
               revision=revision+1,updated_at=clock_timestamp()
           WHERE unit_id=$1::uuid`,
          [row.unit_id]
        );
      }
      await client.query("COMMIT");
      return due.rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Advances following field groups toward the owner's authoritative
   * formation point. This is deliberately a server tick operation: the
   * client only renders the coordinates published by the resulting snapshot.
   */
  async reconcileFollowingMilitaryGroups(
    players: Iterable<MilitaryFollowPlayerState>,
    deltaSeconds = 1,
    limit = 100
  ): Promise<number> {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new MilitaryIndustryError("MILITARY_INVALID_TICK", "Military movement tick duration is invalid.");
    }
    const playerById = new Map<string, MilitaryFollowPlayerState>();
    for (const player of players) {
      if (!player || typeof player.playerId !== "string") continue;
      playerById.set(player.playerId, player);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const following = await client.query<{
        group_id: string;
        owner_player_id: string;
        unit_type: MilitaryUnitType;
        location_state: MilitaryUnitLocationState;
        lat: number | null;
        lon: number | null;
        movement_order?: MilitaryGroupMovementOrder;
        movement_target_lat?: number | null;
        movement_target_lon?: number | null;
        created_at: Date | string;
      }>(
        `SELECT group_id::text,owner_player_id,unit_type,location_state,lat,lon,movement_order,
                movement_target_lat,movement_target_lon,created_at
         FROM military_unit_groups
         WHERE location_state='FOLLOWING_PLAYER'
            OR movement_order IN ('FOLLOW_PLAYER','MOVE_TO_COORDINATE')
         ORDER BY owner_player_id,created_at,group_id LIMIT $1`,
        [limit]
      );
      const formationSlots = new Map<string, number>();
      const groupsByOwner = new Map<string, typeof following.rows>();
      for (const row of following.rows) {
        const rowMovementOrder = row.movement_order ??
          (row.location_state === "FOLLOWING_PLAYER" ? "FOLLOW_PLAYER" : "NONE");
        if (rowMovementOrder !== "FOLLOW_PLAYER" || row.location_state !== "FOLLOWING_PLAYER") continue;
        const ownerGroups = groupsByOwner.get(row.owner_player_id) ?? [];
        ownerGroups.push(row);
        groupsByOwner.set(row.owner_player_id, ownerGroups);
      }
      for (const ownerGroups of groupsByOwner.values()) {
        ownerGroups
          .slice()
          .sort((left, right) => left.group_id.localeCompare(right.group_id))
          .forEach((row, index) => formationSlots.set(row.group_id, index));
      }
      let changed = 0;
      for (const row of following.rows) {
        const owner = playerById.get(row.owner_player_id);
        await lockPlayerMilitaryChannel(client, row.owner_player_id);
        const locked = await client.query<typeof row>(
          `SELECT group_id::text,owner_player_id,unit_type,lat,lon,movement_order,
                  movement_target_lat,movement_target_lon,location_state,created_at
           FROM military_unit_groups
           WHERE group_id=$1::uuid AND owner_player_id=$2
             AND (location_state='FOLLOWING_PLAYER' OR movement_order IN ('FOLLOW_PLAYER','MOVE_TO_COORDINATE'))
           FOR UPDATE SKIP LOCKED`,
          [row.group_id, row.owner_player_id]
        );
        const group = locked.rows[0];
        if (!group) continue;

        const unitType = group.unit_type ?? "field_ballista";
        const movementOrder = group.movement_order ??
          (group.location_state === "FOLLOWING_PLAYER" ? "FOLLOW_PLAYER" : "NONE");
        const isCoordinateOrder = movementOrder === "MOVE_TO_COORDINATE";
        const isFollowOrder = movementOrder === "FOLLOW_PLAYER" ||
          (movementOrder === "NONE" && group.location_state === "FOLLOWING_PLAYER");

        if (!isCoordinateOrder && (!isFollowOrder || group.location_state !== "FOLLOWING_PLAYER")) {
          await client.query(
            `UPDATE military_units
             SET movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$2::uuid AND status<>'destroyed'`,
            [row.owner_player_id, row.group_id]
          );
          await client.query(
            `UPDATE military_unit_groups
             SET movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$2::uuid`,
            [row.owner_player_id, row.group_id]
          );
          changed += 1;
          continue;
        }

        // A connected owner drives Follow movement. A temporarily disconnected
        // owner keeps the durable order and last coordinate so reconnect can
        // resume it; a missing/non-world/invalid owner safely cancels Follow.
        if (!isCoordinateOrder && (!owner || owner.worldPresent === false ||
            !isFiniteLatLon(owner.position.lat, owner.position.lon))) {
          await client.query(
            `UPDATE military_units
             SET location_state='DEPLOYED_FIELD',target_flag_id=NULL,next_fire_at=NULL,
                 movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$2::uuid
               AND location_state='FOLLOWING_PLAYER'
               AND status<>'destroyed'`,
            [row.owner_player_id, row.group_id]
          );
          await client.query(
            `UPDATE military_unit_groups
             SET location_state='DEPLOYED_FIELD',target_flag_id=NULL,next_fire_at=NULL,
                 movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$2::uuid
               AND location_state='FOLLOWING_PLAYER'`,
            [row.owner_player_id, row.group_id]
          );
          changed += 1;
          continue;
        }
        if (isFollowOrder && owner?.online === false) continue;

        const current = group.lat !== null && group.lon !== null &&
          isFiniteLatLon(Number(group.lat), Number(group.lon))
          ? { lat: Number(group.lat), lon: Number(group.lon) }
          : null;
        if (!current) {
          // A movement order must never teleport a missing-position group.
          // Cancel malformed legacy rows into a safe field state instead.
          const safeState = unitType === "field_ballista"
            ? "PACKED_FIELD"
            : "DEPLOYED_FIELD";
          await client.query(
            `UPDATE military_unit_groups
             SET location_state=$3,station_city_id=NULL,war_camp_id=NULL,
                 target_flag_id=NULL,next_fire_at=NULL,
                 movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$2::uuid`,
            [row.owner_player_id, row.group_id, safeState]
          );
          await client.query(
            `UPDATE military_units
             SET location_state=$3,station_city_id=NULL,war_camp_id=NULL,
                 target_flag_id=NULL,next_fire_at=NULL,
                 movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$2::uuid AND status<>'destroyed'`,
            [row.owner_player_id, row.group_id, safeState]
          );
          changed += 1;
          continue;
        }

        const target = isCoordinateOrder &&
          group.movement_target_lat !== null && group.movement_target_lat !== undefined &&
          group.movement_target_lon !== null && group.movement_target_lon !== undefined &&
          isFiniteLatLon(Number(group.movement_target_lat), Number(group.movement_target_lon))
          ? { lat: Number(group.movement_target_lat), lon: Number(group.movement_target_lon) }
          : isFollowOrder && owner
            ? followFormationPositionForPlayer(
              owner.position,
              owner.target,
              formationSlots.get(row.group_id) ?? 0
            )
            : null;
        if (!target) {
          await client.query(
            `UPDATE military_unit_groups
             SET location_state='PACKED_FIELD',station_city_id=NULL,war_camp_id=NULL,
                 target_flag_id=NULL,next_fire_at=NULL,
                 movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$2::uuid`,
            [row.owner_player_id, row.group_id]
          );
          await client.query(
            `UPDATE military_units
             SET location_state='PACKED_FIELD',station_city_id=NULL,war_camp_id=NULL,
                 target_flag_id=NULL,next_fire_at=NULL,
                 movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$2::uuid AND status<>'destroyed'`,
            [row.owner_player_id, row.group_id]
          );
          changed += 1;
          continue;
        }

        const step = this.playerMovementSpeedMps * MILITARY_FOLLOW_SPEED_RATIO * deltaSeconds;
        const distanceToTarget = distanceMeters(current, target);
        const next = moveToward(current, target, step);
        const arrived = isCoordinateOrder && distanceToTarget <= step;
        if (!arrived && distanceMeters(current, next) <= 1e-9) continue;

        if (arrived) {
          const arrivalState = unitType === "field_ballista"
            ? "PACKED_FIELD"
            : "DEPLOYED_FIELD";
          // The final tick clamps to the exact persisted endpoint and clears
          // the transient order. Siege arrives packed; human units arrive as
          // ordinary deployed field groups.
          await client.query(
            `UPDATE military_units
             SET location_state=$5,station_city_id=NULL,war_camp_id=NULL,
                 lat=$2,lon=$3,target_flag_id=NULL,next_fire_at=NULL,
                 movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$4::uuid AND status<>'destroyed'`,
            [row.owner_player_id, next.lat, next.lon, row.group_id, arrivalState]
          );
          await client.query(
            `UPDATE military_unit_groups
             SET location_state=$5,station_city_id=NULL,war_camp_id=NULL,
                 lat=$2,lon=$3,target_flag_id=NULL,next_fire_at=NULL,
                 movement_order='NONE',movement_target_lat=NULL,movement_target_lon=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$4::uuid`,
            [row.owner_player_id, next.lat, next.lon, row.group_id, arrivalState]
          );
        } else {
          await client.query(
            `UPDATE military_units
             SET lat=$2,lon=$3,movement_order=$5,movement_target_lat=$6,
                 movement_target_lon=$7,revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$4::uuid
               AND status<>'destroyed'`,
            [row.owner_player_id, next.lat, next.lon, row.group_id, movementOrder,
             isCoordinateOrder ? target.lat : null, isCoordinateOrder ? target.lon : null]
          );
          await client.query(
            `UPDATE military_unit_groups
             SET lat=$2,lon=$3,movement_order=$5,movement_target_lat=$6,
                 movement_target_lon=$7,revision=revision+1,updated_at=clock_timestamp()
             WHERE owner_player_id=$1 AND group_id=$4::uuid`,
            [row.owner_player_id, next.lat, next.lon, row.group_id, movementOrder,
             isCoordinateOrder ? target.lat : null, isCoordinateOrder ? target.lon : null]
          );
        }
        changed += 1;
      }
      await client.query("COMMIT");
      return changed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  /**
   * Complete authoritative Siege Pack Up transitions whose server deadline
   * has elapsed. The client may display a countdown, but only this durable
   * reconciliation path can convert PACKING_UP back to packed field state.
   */
  async reconcileDueMilitarySiegePacking(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new MilitaryIndustryError("MILITARY_INVALID_LIMIT", "The military reconciliation limit is invalid.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{
        group_id: string;
        owner_player_id: string;
      }>(
        `SELECT group_id::text,owner_player_id
         FROM military_unit_groups
         WHERE unit_type='field_ballista' AND location_state='PACKING_UP'
           AND packing_completes_at IS NOT NULL
           AND packing_completes_at<=clock_timestamp()
         ORDER BY packing_completes_at,group_id LIMIT $1`,
        [limit]
      );
      let completed = 0;
      for (const row of due.rows) {
        // Serialize completion with every player-owned military command. The
        // row lock above keeps independent groups concurrent while this lock
        // prevents a command and deadline transition from racing on one owner.
        await lockPlayerMilitaryChannel(client, row.owner_player_id);
        const locked = await client.query<{ group_id: string }>(
          `SELECT group_id::text
           FROM military_unit_groups
           WHERE group_id=$1::uuid AND owner_player_id=$2
             AND unit_type='field_ballista' AND location_state='PACKING_UP'
             AND packing_completes_at IS NOT NULL
             AND packing_completes_at<=clock_timestamp()
           FOR UPDATE SKIP LOCKED`,
          [row.group_id, row.owner_player_id]
        );
        if (!locked.rows[0]) continue;
        await client.query(
          `UPDATE military_units
            SET location_state='PACKED_FIELD',station_city_id=NULL,war_camp_id=NULL,
                target_flag_id=NULL,next_fire_at=NULL,movement_order='NONE',
                movement_target_lat=NULL,movement_target_lon=NULL,packing_completes_at=NULL,
               revision=revision+1,updated_at=clock_timestamp()
           WHERE owner_player_id=$1 AND group_id=$2::uuid
             AND unit_type='field_ballista' AND location_state='PACKING_UP'
             AND status<>'destroyed'`,
          [row.owner_player_id, row.group_id]
        );
        await client.query(
          `UPDATE military_unit_groups
           SET location_state='PACKED_FIELD',station_city_id=NULL,war_camp_id=NULL,
               target_flag_id=NULL,next_fire_at=NULL,movement_order='NONE',
               movement_target_lat=NULL,movement_target_lon=NULL,packing_completes_at=NULL,
               revision=revision+1,updated_at=clock_timestamp()
           WHERE owner_player_id=$1 AND group_id=$2::uuid
             AND unit_type='field_ballista' AND location_state='PACKING_UP'`,
          [row.owner_player_id, row.group_id]
        );
        completed += 1;
      }
      await client.query("COMMIT");
      return completed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async combineMilitaryGroups(
    player: MilitaryCommandPlayer,
    groupIds: readonly string[],
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    const playerId = player.playerId;
    const ids = uniqueIds(groupIds);
    if (ids.length !== groupIds.length || ids.length < 2 || ids.length > MILITARY_MAX_FUSION_SIZE) {
      throw new MilitaryIndustryError("MILITARY_FUSION_INVALID_SIZE", `Choose between two and ${MILITARY_MAX_FUSION_SIZE} compatible groups.`);
    }
    const requestHash = hashRequest("combine_military_groups", playerId, ...ids);
    const operationKey = `military-unit:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, playerId);
      const prior = await replayMilitaryOperation(client, playerId, requestId, "combine", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return { snapshot, replayed: true };
      }
      await reserveMilitaryOperation(client, operationKey, playerId, requestId, "combine", requestHash);
      const groups = await client.query<MilitaryUnitGroupRow>(
        `SELECT group_id::text,owner_player_id,unit_type,location_state,station_city_id::text,
           war_camp_id::text,lat,lon,target_flag_id::text,movement_order,
           movement_target_lat,movement_target_lon,next_fire_at,packing_completes_at,revision::text,created_at,
           target_city_structure_id::text
         FROM military_unit_groups
         WHERE owner_player_id=$1 AND group_id=ANY($2::uuid[])
         ORDER BY array_position($2::uuid[],group_id)
         FOR UPDATE`,
        [playerId, ids]
      );
      if (groups.rows.length !== ids.length) throw new MilitaryIndustryError("MILITARY_GROUP_NOT_FOUND", "One or more selected groups are unavailable.");
      const first = groups.rows[0]!;
      if (groups.rows.some((group) => group.location_state === "PACKING_UP")) {
        throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "A Siege that is packing up cannot be fused.");
      }
      if (groups.rows.some((group) => group.movement_order === "MOVE_TO_COORDINATE")) {
        throw new MilitaryIndustryError("MILITARY_GROUP_MOVING", "A Siege moving to a planned point cannot be fused.");
      }
      if (["RECOVERING"].includes(first.location_state)) throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "Recovering units cannot be fused.");
      const pendingChannel = await client.query(
        `SELECT 1
         FROM military_siege_operations
         WHERE group_id=ANY($1::uuid[]) AND status='pending'
         LIMIT 1`,
        [ids]
      );
      if (pendingChannel.rowCount !== 0) {
        throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "A military operation is already in progress.");
      }
      const firstAnchor = await resolveMilitaryGroupAnchor(client, first);
      if (!firstAnchor) {
        throw new MilitaryIndustryError("MILITARY_GROUP_INCOMPATIBLE", "The selected groups do not have compatible field anchors.");
      }
      for (const group of groups.rows) {
        await requireMilitaryGroupCommandScope(client, group, player);
        if (
          group.unit_type !== first.unit_type ||
          group.location_state !== first.location_state ||
          group.station_city_id !== first.station_city_id ||
          group.war_camp_id !== first.war_camp_id
        ) throw new MilitaryIndustryError("MILITARY_GROUP_INCOMPATIBLE", "Only identical nearby groups can be fused.");
        const groupAnchor = await resolveMilitaryGroupAnchor(client, group);
        if (!groupAnchor || distanceMeters(firstAnchor, groupAnchor) > MILITARY_FUSION_RANGE_M) {
          throw new MilitaryIndustryError("MILITARY_GROUP_INCOMPATIBLE", `Only compatible groups within ${MILITARY_FUSION_RANGE_M} meters can be fused.`);
        }
      }
      const members = await client.query<{ unit_id: string; group_id: string }>(
        `SELECT unit_id::text,group_id::text FROM military_units
         WHERE owner_player_id=$1 AND group_id=ANY($2::uuid[])
           AND unit_type=$3 AND status='available' AND current_hp > 0
         ORDER BY created_at,unit_id FOR UPDATE`,
        [playerId, ids, first.unit_type]
      );
      if (members.rows.length < 2 || members.rows.length > MILITARY_MAX_FUSION_SIZE) {
        throw new MilitaryIndustryError("MILITARY_FUSION_INVALID_SIZE", `A fused group may contain at most ${MILITARY_MAX_FUSION_SIZE} underlying units.`);
      }
      const memberCounts = new Map<string, number>();
      for (const member of members.rows) {
        memberCounts.set(member.group_id, (memberCounts.get(member.group_id) ?? 0) + 1);
      }
      if (ids.some((id) => !memberCounts.has(id))) {
        throw new MilitaryIndustryError("MILITARY_FUSION_INVALID_SIZE", "Every selected group must have an available surviving member.");
      }
      await client.query(
        `UPDATE military_units
         SET group_id=$2::uuid,location_state=$3,
             station_city_id=$4::uuid,war_camp_id=$5::uuid,
             lat=$6,lon=$7,target_flag_id=$8::uuid,next_fire_at=$9,
             movement_order=$10,movement_target_lat=$11,movement_target_lon=$12,
             packing_completes_at=$13,revision=revision+1,updated_at=clock_timestamp()
         WHERE unit_id=ANY($1::uuid[])`,
        [
          members.rows.map((row) => row.unit_id),
          first.group_id,
          first.location_state,
          first.station_city_id,
          first.war_camp_id,
          first.lat,
          first.lon,
          first.target_flag_id,
          first.next_fire_at,
          first.movement_order,
          first.movement_target_lat,
          first.movement_target_lon,
          first.packing_completes_at
        ]
      );
      await client.query(
        `DELETE FROM military_unit_groups WHERE owner_player_id=$1 AND group_id=ANY($2::uuid[]) AND group_id<>$3::uuid`,
        [playerId, ids, first.group_id]
      );
      await client.query(
        `UPDATE military_unit_groups SET revision=revision+1,updated_at=clock_timestamp() WHERE group_id=$1::uuid`,
        [first.group_id]
      );
      await completeMilitaryOperation(client, operationKey, { groupId: first.group_id });
      const snapshot = await this.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      return { snapshot, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async splitMilitaryGroup(
    playerId: string,
    groupId: string,
    splitSizes: readonly number[],
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    const requestHash = hashRequest("split_military_group", playerId, groupId, ...splitSizes);
    const operationKey = `military-unit:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, playerId);
      const prior = await replayMilitaryOperation(client, playerId, requestId, "split", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return { snapshot, replayed: true };
      }
      await reserveMilitaryOperation(client, operationKey, playerId, requestId, "split", requestHash);
      if (!isUuid(groupId) || splitSizes.length < 2 || splitSizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > MILITARY_MAX_FUSION_SIZE)) {
        throw new MilitaryIndustryError("MILITARY_SPLIT_INVALID", "Choose valid non-empty split sizes.");
      }
      const groupResult = await client.query<MilitaryUnitGroupRow>(
        `SELECT group_id::text,owner_player_id,unit_type,location_state,station_city_id::text,
           war_camp_id::text,lat,lon,target_flag_id::text,movement_order,
           movement_target_lat,movement_target_lon,next_fire_at,packing_completes_at,revision::text,created_at,
           target_city_structure_id::text
         FROM military_unit_groups WHERE group_id=$1::uuid AND owner_player_id=$2 FOR UPDATE`,
        [groupId, playerId]
      );
      const group = groupResult.rows[0];
      if (!group) throw new MilitaryIndustryError("MILITARY_GROUP_NOT_FOUND", "That military group is unavailable.");
      if (group.unit_type === "field_ballista" || group.unit_type === "bomber") {
        throw new MilitaryIndustryError("MILITARY_SPLIT_INVALID", "Fused Siege and Bomber groups cannot be split.");
      }
      if (group.movement_order === "MOVE_TO_COORDINATE") {
        throw new MilitaryIndustryError("MILITARY_GROUP_MOVING", "A Siege moving to a planned point cannot be split.");
      }
      if (group.location_state === "PACKING_UP") {
        throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "A Siege that is packing up cannot be split.");
      }
      if (group.location_state === "DEPLOYED_FIELD") {
        throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "Return a field group before splitting its members.");
      }
      const members = await client.query<{ unit_id: string }>(
        `SELECT unit_id::text FROM military_units WHERE group_id=$1::uuid AND owner_player_id=$2 AND status='available'
         ORDER BY created_at,unit_id FOR UPDATE`,
        [groupId, playerId]
      );
      if (splitSizes.reduce((sum, size) => sum + size, 0) !== members.rows.length) {
        throw new MilitaryIndustryError("MILITARY_SPLIT_INVALID", "Split sizes must preserve every underlying unit.");
      }
      const chunks: string[][] = [];
      let cursor = 0;
      for (const size of splitSizes) {
        chunks.push(members.rows.slice(cursor, cursor + size).map((row) => row.unit_id));
        cursor += size;
      }
      for (let index = 1; index < chunks.length; index += 1) {
        const created = await client.query<{ group_id: string }>(
          `INSERT INTO military_unit_groups (
             owner_player_id,unit_type,location_state,station_city_id,war_camp_id,lat,lon,
             target_flag_id,movement_order,movement_target_lat,movement_target_lon,next_fire_at,revision
           ) SELECT owner_player_id,unit_type,location_state,station_city_id,war_camp_id,lat,lon,
             target_flag_id,movement_order,movement_target_lat,movement_target_lon,next_fire_at,1 FROM military_unit_groups WHERE group_id=$1::uuid
           RETURNING group_id::text`,
          [groupId]
        );
        await client.query(
          `UPDATE military_units SET group_id=$2::uuid,revision=revision+1,updated_at=clock_timestamp()
           WHERE unit_id=ANY($1::uuid[])`,
          [chunks[index], created.rows[0]!.group_id]
        );
      }
      await client.query(
        `UPDATE military_unit_groups SET revision=revision+1,updated_at=clock_timestamp() WHERE group_id=$1::uuid`,
        [groupId]
      );
      await completeMilitaryOperation(client, operationKey, { groupId });
      const snapshot = await this.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      return { snapshot, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  /** Begin the durable 30-second Pack Up transition for a deployed Siege. */
  async packUpMilitaryGroup(
    player: MilitaryCommandPlayer,
    groupId: string,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    const requestHash = hashRequest("pack_up_military_group", player.playerId, groupId);
    const operationKey = `military-unit:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await replayMilitaryOperation(client, player.playerId, requestId, "pack_up", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { snapshot, replayed: true };
      }
      await reserveMilitaryOperation(client, operationKey, player.playerId, requestId, "pack_up", requestHash);
      const group = await lockGroupWithMembers(client, player.playerId, groupId);
      if (!group || !group.members.length) {
        throw new MilitaryIndustryError("MILITARY_GROUP_NOT_FOUND", "That military group is unavailable.");
      }
      if (group.group.unit_type !== "field_ballista") {
        throw new MilitaryIndustryError("MILITARY_GROUP_TYPE_INVALID", "Only a deployed Siege can Pack Up.");
      }
      if (group.group.location_state === "PACKING_UP") {
        throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "This Siege is already packing up.");
      }
      if (group.group.movement_order === "MOVE_TO_COORDINATE") {
        throw new MilitaryIndustryError("MILITARY_GROUP_MOVING", "The Siege must arrive at its planned point before it can Pack Up.");
      }
      if (group.group.location_state !== "DEPLOYED_FIELD") {
        throw new MilitaryIndustryError("MILITARY_GROUP_NOT_DEPLOYED", "Pack Up is available only while the Siege is deployed.");
      }
      if (group.members.some((unit) => unit.unit_type !== "field_ballista" || unit.status !== "available" ||
          unit.location_state !== "DEPLOYED_FIELD" || unit.current_hp <= 0)) {
        throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "A recovering or destroyed Siege member cannot be packed up.");
      }
      if (group.group.lat === null || group.group.lon === null ||
          !isFiniteLatLon(Number(group.group.lat), Number(group.group.lon))) {
        throw new MilitaryIndustryError("MILITARY_INVALID_POSITION", "The Siege has no valid field position.");
      }
      await requireMilitaryGroupCommandScope(client, group.group, player);
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = new Date(clock.rows[0]!.now);
      const packingCompletesAt = new Date(now.getTime() + SIEGE_PACK_UP_DURATION_MS);
      await client.query(
        `UPDATE military_units
         SET location_state='PACKING_UP',station_city_id=NULL,war_camp_id=NULL,
             target_flag_id=NULL,next_fire_at=NULL,movement_order='NONE',
             movement_target_lat=NULL,movement_target_lon=NULL,packing_completes_at=$2,
             revision=revision+1,updated_at=clock_timestamp()
         WHERE owner_player_id=$1 AND group_id=$3::uuid
           AND unit_type='field_ballista' AND status='available' AND current_hp>0`,
        [player.playerId, packingCompletesAt, groupId]
      );
      await client.query(
        `UPDATE military_unit_groups
         SET location_state='PACKING_UP',station_city_id=NULL,war_camp_id=NULL,
              target_flag_id=NULL,next_fire_at=NULL,movement_order='NONE',
              movement_target_lat=NULL,movement_target_lon=NULL,packing_completes_at=$2,
             revision=revision+1,updated_at=clock_timestamp()
         WHERE owner_player_id=$1 AND group_id=$3::uuid
           AND unit_type='field_ballista' AND location_state='DEPLOYED_FIELD'`,
        [player.playerId, packingCompletesAt, groupId]
      );
      await completeMilitaryOperation(client, operationKey, {
        groupId,
        state: "PACKING_UP",
        packingCompletesAt: packingCompletesAt.toISOString()
      });
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async buildWarCamp(
    player: Pick<PlayerRecord, "playerId" | "regionCode" | "position" | "anchor" | "moveLeashRadiusM">,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    const requestHash = hashRequest("build_war_camp", player.playerId, player.position.lat, player.position.lon);
    const operationKey = `military-unit:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await replayMilitaryOperation(client, player.playerId, requestId, "build_war_camp", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { snapshot, inventory, replayed: true };
      }
      await reserveMilitaryOperation(client, operationKey, player.playerId, requestId, "build_war_camp", requestHash);
      if (await this.loadWarCamp(client, player.playerId, true)) throw new MilitaryIndustryError("WAR_CAMP_ALREADY_EXISTS", "You may own only one active War Camp.");
      const removedCamp = await client.query<{ relocation_available_at: Date | string | null }>(
        `SELECT relocation_available_at
         FROM war_camps
         WHERE owner_player_id=$1 AND removed_at IS NOT NULL
         ORDER BY removed_at DESC, camp_id DESC
         LIMIT 1
         FOR UPDATE`,
        [player.playerId]
      );
      const cooldown = removedCamp.rows[0]?.relocation_available_at;
      if (cooldown && new Date(cooldown).getTime() > Date.now()) {
        throw new MilitaryIndustryError("WAR_CAMP_RELOCATION_COOLDOWN", "Your next War Camp placement is available once the 24-hour relocation cooldown ends.");
      }
      await requirePersonalTerritory(client, player.playerId, player.position);
      await requireWarCampClearance(client, this.worldId, player.regionCode, player.position, player.anchor, player.moveLeashRadiusM);
      const campId = randomUUID();
      const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:materials`,
        playerId: player.playerId,
        source: "war_camp_construction",
        sourceEntityType: "war_camp",
        sourceEntityId: campId,
        metadata: { requestId },
        debits: MILITARY_WAR_CAMP_COST.materials.map((material) => ({
          itemId: material.itemId,
          variant: DEFAULT_INVENTORY_VARIANT,
          quantity: BigInt(material.quantity)
        }))
      });
      await client.query(
        `INSERT INTO war_camps (
           camp_id,owner_player_id,world_id,region_code,lat,lon,geom,footprint_geom,
           footprint_radius_m,placement_revision
         ) VALUES ($1,$2,$3,$4,$5,$6,
           ST_SetSRID(ST_MakePoint($6,$5),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,$7)::geometry,
           $7,1)`,
        [campId, player.playerId, this.worldId, player.regionCode, player.position.lat, player.position.lon, MILITARY_WAR_CAMP_FOOTPRINT_RADIUS_M]
      );
      await completeMilitaryOperation(client, operationKey, { campId });
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, inventory: debited.inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async relocateWarCamp(
    player: Pick<PlayerRecord, "playerId" | "regionCode" | "position" | "anchor" | "moveLeashRadiusM">,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    const requestHash = hashRequest("relocate_war_camp", player.playerId, player.position.lat, player.position.lon);
    const operationKey = `military-unit:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await replayMilitaryOperation(client, player.playerId, requestId, "relocate_war_camp", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { snapshot, inventory, replayed: true };
      }
      await reserveMilitaryOperation(client, operationKey, player.playerId, requestId, "relocate_war_camp", requestHash);
      const camp = await this.loadWarCamp(client, player.playerId, true);
      if (!camp) throw new MilitaryIndustryError("WAR_CAMP_REQUIRED", "Build a War Camp before relocating it.");
      if (camp.relocation_available_at && new Date(camp.relocation_available_at).getTime() > Date.now()) {
        throw new MilitaryIndustryError("WAR_CAMP_RELOCATION_COOLDOWN", "Your War Camp can be relocated once every 24 hours.");
      }
      await requirePersonalTerritory(client, player.playerId, player.position);
      await requireWarCampClearance(client, this.worldId, player.regionCode, player.position, player.anchor, player.moveLeashRadiusM, camp.camp_id);
      const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:materials`,
        playerId: player.playerId,
        source: "war_camp_relocation",
        sourceEntityType: "war_camp",
        sourceEntityId: camp.camp_id,
        metadata: { requestId },
        debits: MILITARY_WAR_CAMP_COST.materials.map((material) => ({
          itemId: material.itemId,
          variant: DEFAULT_INVENTORY_VARIANT,
          quantity: BigInt(material.quantity)
        }))
      });
      await client.query(
        `UPDATE war_camps
         SET region_code=$2,lat=$3,lon=$4,
             geom=ST_SetSRID(ST_MakePoint($4,$3),4326),
             footprint_geom=ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,$5)::geometry,
             placement_revision=placement_revision+1,
             relocation_available_at=clock_timestamp()+($5::bigint * interval '1 millisecond'),
             updated_at=clock_timestamp()
         WHERE camp_id=$1::uuid AND owner_player_id=$6 AND removed_at IS NULL`,
        [camp.camp_id, player.regionCode, player.position.lat, player.position.lon, MILITARY_WAR_CAMP_RELOCATION_COOLDOWN_MS, player.playerId]
      );
      await client.query(
        `UPDATE military_units SET lat=$2,lon=$3,revision=revision+1,updated_at=clock_timestamp()
         WHERE owner_player_id=$1 AND war_camp_id=$4::uuid AND location_state='STATIONED_WAR_CAMP'`,
        [player.playerId, player.position.lat, player.position.lon, camp.camp_id]
      );
      await client.query(
        `UPDATE military_unit_groups SET lat=$2,lon=$3,revision=revision+1,updated_at=clock_timestamp()
         WHERE owner_player_id=$1 AND war_camp_id=$4::uuid AND location_state='STATIONED_WAR_CAMP'`,
        [player.playerId, player.position.lat, player.position.lon, camp.camp_id]
      );
      await completeMilitaryOperation(client, operationKey, { campId: camp.camp_id, relocationCooldownMs: MILITARY_WAR_CAMP_RELOCATION_COOLDOWN_MS });
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, inventory: debited.inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async removeWarCamp(playerId: string, requestId: string): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    const requestHash = hashRequest("remove_war_camp", playerId);
    const operationKey = `military-unit:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, playerId);
      const prior = await replayMilitaryOperation(client, playerId, requestId, "remove_war_camp", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return { snapshot, replayed: true };
      }
      await reserveMilitaryOperation(client, operationKey, playerId, requestId, "remove_war_camp", requestHash);
      const camp = await this.loadWarCamp(client, playerId, true);
      if (!camp) throw new MilitaryIndustryError("WAR_CAMP_REQUIRED", "You do not own an active War Camp.");
      const occupants = await client.query(
        `SELECT 1 FROM military_units WHERE owner_player_id=$1 AND war_camp_id=$2::uuid
           AND status<>'destroyed' LIMIT 1`,
        [playerId, camp.camp_id]
      );
      const rally = await client.query(
        `SELECT 1 FROM military_rally_operations WHERE player_id=$1 AND camp_id=$2::uuid AND status='pending' LIMIT 1`,
        [playerId, camp.camp_id]
      );
      if (occupants.rowCount || rally.rowCount) throw new MilitaryIndustryError("WAR_CAMP_GARRISON_PRESENT", "Remove the garrison and finish all rally operations before removing the War Camp.");
      await client.query(
        `UPDATE war_camps
         SET removed_at=clock_timestamp(),removed_reason='player_request',
             relocation_available_at=clock_timestamp()+($3::bigint * interval '1 millisecond'),
             updated_at=clock_timestamp()
         WHERE camp_id=$1::uuid AND owner_player_id=$2 AND removed_at IS NULL`,
        [camp.camp_id, playerId, MILITARY_WAR_CAMP_RELOCATION_COOLDOWN_MS]
      );
      await completeMilitaryOperation(client, operationKey, { campId: camp.camp_id, removed: true });
      const snapshot = await this.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      return { snapshot, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async callTroops(
    player: Pick<PlayerRecord, "playerId" | "position">,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    const requestHash = hashRequest("call_troops", player.playerId);
    const operationKey = `military-unit:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await replayMilitaryOperation(client, player.playerId, requestId, "call_troops", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { snapshot, replayed: true };
      }
      await reserveMilitaryOperation(client, operationKey, player.playerId, requestId, "call_troops", requestHash);
      const camp = await this.loadWarCamp(client, player.playerId, true);
      if (!camp) throw new MilitaryIndustryError("WAR_CAMP_REQUIRED", "Build a War Camp before calling troops.");
      if (distanceMeters(player.position, { lat: Number(camp.lat), lon: Number(camp.lon) }) > MILITARY_UNIT_INTERACTION_RADIUS_M) {
        throw new MilitaryIndustryError("WAR_CAMP_OUT_OF_RANGE", "Move near your War Camp before calling troops.");
      }
      const pendingRally = await client.query(
        `SELECT 1
         FROM military_rally_operations
         WHERE player_id=$1 AND camp_id=$2::uuid AND status='pending'
         LIMIT 1
         FOR UPDATE`,
        [player.playerId, camp.camp_id]
      );
      if (pendingRally.rowCount) throw new MilitaryIndustryError("MILITARY_RALLY_PENDING", "Your troops are already answering a rally.");
      const available = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM military_units
         WHERE owner_player_id=$1 AND status='available' AND location_state='STATIONED_CITY'`,
        [player.playerId]
      );
      if (Number(available.rows[0]?.count ?? 0) === 0) throw new MilitaryIndustryError("MILITARY_NO_TROOPS", "No available troops can answer the rally.");
      await client.query(
        `INSERT INTO military_rally_operations (
           operation_key,player_id,request_id,camp_id,started_at,completes_at,status
         ) VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+($5::bigint * interval '1 millisecond'),'pending')`,
        [operationKey, player.playerId, requestId, camp.camp_id, MILITARY_RALLY_DURATION_MS]
      );
      await completeMilitaryOperation(client, operationKey, { campId: camp.camp_id, rallyDurationMs: MILITARY_RALLY_DURATION_MS });
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async setMilitaryGroupState(
    player: MilitaryCommandPlayer,
    groupId: string,
    state: "FOLLOWING_PLAYER" | "DEPLOYED_FIELD" | "PACKED_FIELD" | "STATIONED_WAR_CAMP" | "STATIONED_CITY",
    requestId: string,
    fieldPosition?: Readonly<{ lat: number; lon: number }>
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    const action = state === "FOLLOWING_PLAYER"
      ? "follow"
      : state === "DEPLOYED_FIELD"
        ? "deploy"
        : state === "PACKED_FIELD"
          ? "stay"
          : state === "STATIONED_WAR_CAMP"
            ? "return"
            : "stop";
    if (fieldPosition) requireWorldPosition(fieldPosition);
    const requestHash = fieldPosition
      ? hashRequest(`${action}_military_group`, player.playerId, groupId, fieldPosition.lat, fieldPosition.lon)
      : hashRequest(`${action}_military_group`, player.playerId, groupId);
    const operationKey = `military-unit:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await replayMilitaryOperation(client, player.playerId, requestId, action, requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { snapshot, replayed: true };
      }
      await reserveMilitaryOperation(client, operationKey, player.playerId, requestId, action, requestHash);
      const group = await lockGroupWithMembers(client, player.playerId, groupId);
      if (!group || !group.members.length) throw new MilitaryIndustryError("MILITARY_GROUP_NOT_FOUND", "That military group is unavailable.");
      if (group.group.location_state === "PACKING_UP") {
        throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "This Siege is packing up and cannot accept another order.");
      }
      if (group.members.some((unit) => unit.status !== "available")) throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "A recovering or destroyed member cannot be moved.");
      const pendingRally = await client.query(
        `SELECT 1 FROM military_rally_operations
         WHERE player_id=$1 AND status='pending' LIMIT 1`,
        [player.playerId]
      );
      if (pendingRally.rowCount) throw new MilitaryIndustryError("MILITARY_RALLY_PENDING", "Wait for the active War Camp rally to finish before moving troops.");
      await requireMilitaryGroupCommandScope(client, group.group, player);
      if (state === "DEPLOYED_FIELD" && group.group.movement_order === "MOVE_TO_COORDINATE") {
        throw new MilitaryIndustryError("MILITARY_GROUP_MOVING", "The Siege must arrive at its planned point before it can deploy.");
      }
      if (state === "DEPLOYED_FIELD" && ![
        "FOLLOWING_PLAYER",
        "DEPLOYED_FIELD",
        ...(group.group.unit_type === "field_ballista" ? ["PACKED_FIELD"] : [])
      ].includes(group.group.location_state)) {
        throw new MilitaryIndustryError("MILITARY_GROUP_STATE_INVALID", "Deploy a group only after it is following you or already deployed in the field.");
      }
      if (state === "PACKED_FIELD" && group.group.unit_type !== "field_ballista") {
        throw new MilitaryIndustryError("MILITARY_GROUP_TYPE_INVALID", "Only a Siege can Stay in the field.");
      }
      if (state === "PACKED_FIELD" && !["PACKED_FIELD", "FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.group.location_state)) {
        throw new MilitaryIndustryError("MILITARY_GROUP_STATE_INVALID", "Stay is available only for a field group.");
      }
      if (state === "STATIONED_WAR_CAMP" && !["FOLLOWING_PLAYER", "DEPLOYED_FIELD", "STATIONED_WAR_CAMP"].includes(group.group.location_state)) {
        throw new MilitaryIndustryError("MILITARY_RALLY_REQUIRED", "Call troops to move a City garrison to your War Camp.");
      }
      await cancelPendingBomberChannelsForGroup(client, groupId, player.playerId);
      let stationCityId: string | null = null;
      let warCampId: string | null = null;
      const currentPosition = group.group.lat !== null && group.group.lon !== null &&
        isFiniteLatLon(Number(group.group.lat), Number(group.group.lon))
        ? { lat: Number(group.group.lat), lon: Number(group.group.lon) }
        : null;
      const followPosition = state === "FOLLOWING_PLAYER" && !currentPosition
        ? followPositionForPlayer(player.position, null, null)
        : null;
      const fieldCoordinate = fieldPosition ?? currentPosition ?? followPosition ?? player.position;
      let lat: number | null = state === "STATIONED_CITY" ? null : fieldCoordinate.lat;
      let lon: number | null = state === "STATIONED_CITY" ? null : fieldCoordinate.lon;
      let nextFireAt: Date | null = null;
      let targetFlagId: string | null = null;
      if (state === "STATIONED_WAR_CAMP") {
        const camp = await this.loadWarCamp(client, player.playerId, true);
        if (!camp) throw new MilitaryIndustryError("WAR_CAMP_REQUIRED", "Build a War Camp before returning troops there.");
        warCampId = camp.camp_id;
        lat = Number(camp.lat);
        lon = Number(camp.lon);
      } else if (state === "STATIONED_CITY") {
        stationCityId = group.members.find((unit) => unit.home_city_id)?.home_city_id ?? group.group.station_city_id;
        if (!stationCityId) throw new MilitaryIndustryError("MILITARY_CITY_REQUIRED", "This group has no home City for return.");
        await requireMilitaryCityCommandRange(client, stationCityId, player.position);
        lat = null;
        lon = null;
      } else if (state === "DEPLOYED_FIELD" && group.group.unit_type === "field_ballista") {
        // Deployment starts the existing cadence path with a deterministic
        // eligible target anchor. The volley resolver expands that anchor to
        // every currently eligible target on each hit, so a Siege deployed
        // directly over a test fortification begins firing without a separate
        // target-selection command.
        const deployGroup = {
          ...group.group,
          lat: fieldCoordinate.lat,
          lon: fieldCoordinate.lon
        };
        const deployTargets = await lockSiegeTargetsWithinRange(
          client,
          deployGroup,
          player.playerId,
          NO_SELECTED_SIEGE_TARGET_ID
        );
        targetFlagId = deployTargets.targets[0]?.id ?? null;
        const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
        nextFireAt = new Date(new Date(clock.rows[0]!.now).getTime() + MILITARY_BALLISTA_VOLLEY_CADENCE_MS);
      }
      await client.query(
        `UPDATE military_units
             SET location_state=$2,station_city_id=$3::uuid,war_camp_id=$4::uuid,lat=$5,lon=$6,
             target_flag_id=$7,next_fire_at=$8,movement_order=$9,
             movement_target_lat=NULL,movement_target_lon=NULL,packing_completes_at=NULL,
             revision=revision+1,updated_at=clock_timestamp()
         WHERE owner_player_id=$1 AND group_id=$10::uuid AND status='available'`,
         [player.playerId, state, stationCityId, warCampId, lat, lon, targetFlagId, nextFireAt,
          state === "FOLLOWING_PLAYER" ? "FOLLOW_PLAYER" : "NONE", groupId]
      );
      await client.query(
         `UPDATE military_unit_groups SET location_state=$2,station_city_id=$3::uuid,war_camp_id=$4::uuid,
            lat=$5,lon=$6,target_flag_id=$7,next_fire_at=$8,movement_order=$9,
            movement_target_lat=NULL,movement_target_lon=NULL,packing_completes_at=NULL,
           revision=revision+1,updated_at=clock_timestamp()
          WHERE owner_player_id=$1 AND group_id=$10::uuid`,
         [player.playerId, state, stationCityId, warCampId, lat, lon, targetFlagId, nextFireAt,
          state === "FOLLOWING_PLAYER" ? "FOLLOW_PLAYER" : "NONE", groupId]
      );
      await completeMilitaryOperation(client, operationKey, { groupId, state });
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  /** Queue a commanded field military group for a client-planned coordinate. The
   * destination is durable intent; the movement tick owns every coordinate
   * change and clamps the final step to the exact endpoint. */
  async moveMilitaryGroupToPosition(
    player: MilitaryCommandPlayer,
    groupId: string,
    destination: Readonly<{ lat: number; lon: number }>,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    requireWorldPosition(destination);
    const requestHash = hashRequest(
      "move_military_group",
      player.playerId,
      groupId,
      destination.lat,
      destination.lon
    );
    const operationKey = `military-unit:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await replayMilitaryOperation(client, player.playerId, requestId, "move_to_position", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { snapshot, replayed: true };
      }
      await reserveMilitaryOperation(client, operationKey, player.playerId, requestId, "move_to_position", requestHash);
      const group = await lockGroupWithMembers(client, player.playerId, groupId);
      if (!group || !group.members.length) {
        throw new MilitaryIndustryError("MILITARY_GROUP_NOT_FOUND", "That military group is unavailable.");
      }
      if (group.group.location_state === "PACKING_UP") {
        throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "This military group is packing up and cannot move.");
      }
      if (group.members.some((unit) => unit.status !== "available" || unit.current_hp <= 0)) {
        throw new MilitaryIndustryError("MILITARY_GROUP_UNAVAILABLE", "A recovering or destroyed member cannot be moved.");
      }
      if (![
        "FOLLOWING_PLAYER",
        "DEPLOYED_FIELD",
        "PACKED_FIELD"
      ].includes(group.group.location_state)) {
        throw new MilitaryIndustryError("MILITARY_GROUP_STATE_INVALID", "Only a field group can move to a planned point.");
      }
      await requireMilitaryGroupCommandScope(client, group.group, player);
      await cancelPendingBomberChannelsForGroup(client, groupId, player.playerId);
      await client.query(
        `UPDATE military_units
         SET station_city_id=NULL,war_camp_id=NULL,
             target_flag_id=NULL,next_fire_at=NULL,packing_completes_at=NULL,
             movement_order='MOVE_TO_COORDINATE',movement_target_lat=$2,movement_target_lon=$3,
             revision=revision+1,updated_at=clock_timestamp()
         WHERE owner_player_id=$1 AND group_id=$4::uuid AND status='available'`,
        [player.playerId, destination.lat, destination.lon, groupId]
      );
      await client.query(
        `UPDATE military_unit_groups
         SET station_city_id=NULL,war_camp_id=NULL,
             target_flag_id=NULL,next_fire_at=NULL,packing_completes_at=NULL,
             movement_order='MOVE_TO_COORDINATE',movement_target_lat=$2,movement_target_lon=$3,
             revision=revision+1,updated_at=clock_timestamp()
         WHERE owner_player_id=$1 AND group_id=$4::uuid`,
        [player.playerId, destination.lat, destination.lon, groupId]
      );
      await completeMilitaryOperation(client, operationKey, {
        groupId,
        state: group.group.location_state,
        movementOrder: "MOVE_TO_COORDINATE",
        position: { lat: destination.lat, lon: destination.lon }
      });
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async attackMilitaryGroup(
    player: MilitaryCommandPlayer,
    groupId: string,
    targetEntityId: string,
    requestId: string,
    combat: Pick<CombatEngine, "applyMilitaryAttack">
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    if (!targetEntityId || targetEntityId.length > 160) {
      throw new MilitaryIndustryError("MILITARY_INVALID_TARGET", "Choose a valid combat target.");
    }
    const requestHash = hashRequest("military_group_attack", player.playerId, groupId, targetEntityId);
    const operationKey = `military-unit:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await replayMilitaryOperation(client, player.playerId, requestId, "attack", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        const damage = Number(prior.result?.damage);
        return {
          snapshot,
          ...(Number.isFinite(damage) ? { damage } : {}),
          replayed: true
        };
      }
      await reserveMilitaryOperation(client, operationKey, player.playerId, requestId, "attack", requestHash);
      const group = await lockGroupWithMembers(client, player.playerId, groupId);
      if (!group || !group.members.length) {
        throw new MilitaryIndustryError("MILITARY_GROUP_NOT_FOUND", "That military group is unavailable.");
      }
      if (!["FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.group.location_state) ||
          group.group.movement_order === "MOVE_TO_COORDINATE") {
        throw new MilitaryIndustryError("MILITARY_GROUP_NOT_DEPLOYED", "Follow or deploy the group before attacking.");
      }
      const survivingMembers = group.members.filter(
        (unit) => unit.unit_type === group.group.unit_type && unit.status === "available" && unit.current_hp > 0
      ).length;
      // Picked Legion: the owner's kingdom drills Infantry and Archers (+4 attack each).
      const eliteBonus = (group.group.unit_type === "infantry" || group.group.unit_type === "archer") &&
        await playerHasKingdomPerk(client, player.playerId, "picked_legion")
        ? KINGDOM_PERK_PICKED_LEGION_ATTACK_BONUS
        : 0;
      const plan = planMilitaryGroupAttack(group.group.unit_type, survivingMembers, eliteBonus);
      if (!plan) {
        throw new MilitaryIndustryError("MILITARY_UNIT_COMBAT_RESTRICTED", "Field Ballistas can only attack structures.");
      }
      await requireMilitaryGroupCommandScope(client, group.group, player);
      await cancelPendingBomberChannelsForGroup(client, groupId, player.playerId);
      const attackOrigin = group.group.lat !== null && group.group.lon !== null
        ? { lat: Number(group.group.lat), lon: Number(group.group.lon) }
        : player.position;
      const damage = combat.applyMilitaryAttack({
        attackerPlayerId: player.playerId,
        targetEntityId,
        damage: plan.damage,
        rangeM: plan.rangeM,
        attackOrigin,
        sourceTechniqueId: plan.sourceTechniqueId
      });
      await completeMilitaryOperation(client, operationKey, {
        groupId,
        targetEntityId,
        memberCount: plan.memberCount,
        damage
      });
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, damage, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  /**
   * One tower arrow against a deployed hostile Siege or Bomber group. The
   * oldest surviving member takes the hit, like a player attack on a Siege;
   * the group is removed when no member survives. Returns the damage applied
   * (0 when the group is no longer a valid deployed target).
   */
  async applyTowerHitToGroup(groupId: string, damage: number): Promise<number> {
    if (!Number.isSafeInteger(damage) || damage <= 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const group = await lockGroupWithMembers(client, null, groupId);
      if (
        !group ||
        (group.group.unit_type !== "field_ballista" && group.group.unit_type !== "bomber") ||
        !["FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.group.location_state)
      ) {
        await client.query("ROLLBACK");
        return 0;
      }
      const member = group.members
        .filter((unit) => unit.unit_type === group.group.unit_type && unit.status === "available" && Number(unit.current_hp) > 0)
        .sort(compareMilitaryMembers)[0];
      if (!member) {
        await client.query("ROLLBACK");
        return 0;
      }
      const applied = Math.min(Number(member.current_hp), damage);
      const nextHp = Number(member.current_hp) - applied;
      if (nextHp > 0) {
        await client.query(
          `UPDATE military_units
           SET current_hp=$2::smallint,revision=revision+1,updated_at=clock_timestamp()
           WHERE unit_id=$1::uuid AND group_id=$3::uuid AND status='available'`,
          [member.unit_id, nextHp, groupId]
        );
      } else {
        await client.query(
          `UPDATE military_units
           SET current_hp=0,status='destroyed',location_state='DEPLOYED_FIELD',group_id=NULL,
               target_flag_id=NULL,next_fire_at=NULL,packing_completes_at=NULL,
               revision=revision+1,updated_at=clock_timestamp()
           WHERE unit_id=$1::uuid AND group_id=$2::uuid AND status='available'`,
          [member.unit_id, groupId]
        );
      }
      await client.query(
        `UPDATE military_unit_groups
         SET revision=revision+1,updated_at=clock_timestamp()
         WHERE group_id=$1::uuid`,
        [groupId]
      );
      const removed = await client.query(
        `DELETE FROM military_unit_groups group_row
         WHERE group_row.group_id=$1::uuid
           AND NOT EXISTS (
             SELECT 1 FROM military_units unit
             WHERE unit.group_id=group_row.group_id AND unit.status<>'destroyed'
           )`,
        [groupId]
      );
      if ((removed.rowCount ?? 0) > 0) {
        // A destroyed Bomber group can no longer finish its planting channel.
        await cancelPendingBomberChannelsForGroup(client, groupId, group.group.owner_player_id);
      }
      await client.query("COMMIT");
      return applied;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Resolve one ordinary player hit against another player's deployed Siege.
   * Siege members remain the durable health authority: damage is applied to
   * the oldest surviving Ballista member and the fused group is removed only
   * when no member remains alive.
   */
  async attackMilitarySiege(
    player: MilitaryCommandPlayer,
    groupId: string,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    if (player.online === false) {
      throw new MilitaryIndustryError("MILITARY_ATTACK_DISCONNECTED", "You must be online to attack a Siege.");
    }
    if (player.target) {
      throw new MilitaryIndustryError("MILITARY_ATTACK_MOVING", "Stop moving before attacking a Siege.");
    }
    const requestHash = hashRequest("military_siege_attack", player.playerId, groupId);
    const operationKey = `military-unit:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await replayMilitaryOperation(client, player.playerId, requestId, "attack", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        const damage = Number(prior.result?.damage);
        return {
          snapshot,
          ...(Number.isFinite(damage) ? { damage } : {}),
          replayed: true
        };
      }
      await reserveMilitaryOperation(client, operationKey, player.playerId, requestId, "attack", requestHash);

      const group = await lockGroupWithMembers(client, null, groupId);
      if (!group || group.group.owner_player_id === player.playerId) {
        throw new MilitaryIndustryError("MILITARY_SIEGE_NOT_FOUND", "That hostile Siege is unavailable.");
      }
      if (group.group.unit_type !== "field_ballista" ||
          !["FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.group.location_state) ||
          group.group.movement_order === "MOVE_TO_COORDINATE") {
        throw new MilitaryIndustryError("MILITARY_SIEGE_NOT_DEPLOYED", "Only a deployed hostile Siege can be attacked.");
      }
      await requireMilitaryGroupCommandScope(client, group.group, player);
      if (
        group.group.lat === null || group.group.lon === null ||
        !isFiniteLatLon(Number(group.group.lat), Number(group.group.lon))
      ) {
        throw new MilitaryIndustryError("MILITARY_SIEGE_POSITION_INVALID", "The hostile Siege has no valid field position.");
      }
      const siegePosition = { lat: Number(group.group.lat), lon: Number(group.group.lon) };
      if (distanceMeters(player.position, siegePosition) > MILITARY_UNIT_INTERACTION_RADIUS_M) {
        throw new MilitaryIndustryError(
          "MILITARY_SIEGE_OUT_OF_RANGE",
          `Move within ${MILITARY_UNIT_INTERACTION_RADIUS_M}m of the hostile Siege before attacking it.`
        );
      }

      const cooldown = await client.query<{ remaining_ms: number | string }>(
        `SELECT GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (
                    completed_at + ($3::bigint * interval '1 millisecond') - clock_timestamp()
                  )) * 1000
                )::bigint AS remaining_ms
         FROM military_unit_operations
         WHERE player_id=$1 AND action='attack'
           AND result->>'targetGroupId'=$2
           AND completed_at IS NOT NULL
         ORDER BY completed_at DESC
         LIMIT 1
         FOR UPDATE`,
        [player.playerId, groupId, STRUCTURE_WARFARE_ATTACK_COOLDOWN_MS]
      );
      const remainingMs = Number(cooldown.rows[0]?.remaining_ms ?? 0);
      if (remainingMs > 0) {
        const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1_000));
        throw new MilitaryIndustryError(
          "MILITARY_SIEGE_COOLDOWN",
          `You can attack this Siege again in about ${remainingHours} hour${remainingHours === 1 ? "" : "s"}.`
        );
      }

      const member = group.members
        .filter((unit) => unit.unit_type === "field_ballista" && unit.status === "available" && Number(unit.current_hp) > 0)
        .sort(compareMilitaryMembers)[0];
      if (!member) {
        throw new MilitaryIndustryError("MILITARY_SIEGE_NOT_FOUND", "That hostile Siege has no surviving members.");
      }
      const nextHp = Math.max(0, Number(member.current_hp) - STRUCTURE_WARFARE_ATTACK_DAMAGE);
      if (nextHp > 0) {
        await client.query(
          `UPDATE military_units
           SET current_hp=$2::smallint,revision=revision+1,updated_at=clock_timestamp()
           WHERE unit_id=$1::uuid AND group_id=$3::uuid AND status='available'`,
          [member.unit_id, nextHp, groupId]
        );
      } else {
        await client.query(
          `UPDATE military_units
           SET current_hp=0,status='destroyed',location_state='DEPLOYED_FIELD',group_id=NULL,
               target_flag_id=NULL,next_fire_at=NULL,packing_completes_at=NULL,
               revision=revision+1,updated_at=clock_timestamp()
           WHERE unit_id=$1::uuid AND group_id=$2::uuid AND status='available'`,
          [member.unit_id, groupId]
        );
      }
      await client.query(
        `UPDATE military_unit_groups
         SET revision=revision+1,updated_at=clock_timestamp()
         WHERE group_id=$1::uuid`,
        [groupId]
      );
      await client.query(
        `DELETE FROM military_unit_groups group_row
         WHERE group_row.group_id=$1::uuid
           AND NOT EXISTS (
             SELECT 1 FROM military_units unit
             WHERE unit.group_id=group_row.group_id AND unit.status<>'destroyed'
           )`,
        [groupId]
      );
      await completeMilitaryOperation(client, operationKey, {
        targetGroupId: groupId,
        targetOwnerPlayerId: group.group.owner_player_id,
        memberId: member.unit_id,
        damage: STRUCTURE_WARFARE_ATTACK_DAMAGE,
        memberDestroyed: nextHp <= 0
      });
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, damage: STRUCTURE_WARFARE_ATTACK_DAMAGE, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async demolishFlag(
    player: MilitaryCommandPlayer,
    groupId: string,
    targetFlagId: string,
    requestId: string,
    targetKind: "flag" | "city_structure" = "flag"
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    const requestHash = hashRequest("demolish_flag", player.playerId, groupId, targetFlagId);
    const operationKey = `military-siege:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await existingSiegeOperation(client, player.playerId, requestId, "demolish_flag", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return {
          snapshot,
          ...(prior.status === "complete" ? { damage: prior.damage } : {}),
          replayed: true
        };
      }
      const group = await lockGroupWithMembers(client, player.playerId, groupId);
      if (!group || group.group.unit_type !== "bomber") throw new MilitaryIndustryError("MILITARY_BOMBER_REQUIRED", "Only Bomber groups can demolish Flags.");
      if (!["FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.group.location_state) ||
          group.group.movement_order === "MOVE_TO_COORDINATE") {
        throw new MilitaryIndustryError("MILITARY_BOMBER_NOT_DEPLOYED", "Deploy or follow with the Bombers before demolishing a Flag.");
      }
      await requireMilitaryGroupCommandScope(client, group.group, player);
      const availableBombers = group.members.filter((unit) => unit.unit_type === "bomber" && unit.status === "available" && unit.current_hp > 0);
      if (!availableBombers.length) throw new MilitaryIndustryError("MILITARY_BOMBER_REQUIRED", "No available Bomber remains in this group.");
      // Structure-driven Bomber actions command the owned group remotely. The
      // charge-radius check is therefore anchored to the group's authoritative
      // field coordinate, not to the player's current position.
      const bomberPosition = group.group.lat !== null && group.group.lon !== null
        ? { lat: Number(group.group.lat), lon: Number(group.group.lon) }
        : undefined;
      const flag = targetKind === "city_structure"
        ? await lockBomberCityBuilding(client, targetFlagId, player.playerId, bomberPosition)
        : await lockBomberTarget(client, targetFlagId, player.playerId, bomberPosition);
      await client.query(
        `INSERT INTO military_siege_operations (
           operation_key,player_id,request_id,action,group_id,flag_id,damage,
           group_revision,member_revisions,target_lat,target_lon,status,started_at,completes_at,target_kind
         ) VALUES ($1,$2,$3,'demolish_flag',$4::uuid,$5::uuid,0,$6,$7::jsonb,$8,$9,'pending',clock_timestamp(),
           clock_timestamp()+($10::bigint * interval '1 millisecond'),$11)
         ON CONFLICT (player_id,request_id) DO NOTHING`,
        [
          operationKey,
          player.playerId,
          requestId,
          groupId,
          targetFlagId,
          group.group.revision,
          JSON.stringify(memberRevisionSnapshot(group.members)),
          Number(flag.lat),
          Number(flag.lon),
          MILITARY_BOMBER_CHANNEL_DURATION_MS,
          targetKind
        ]
      );
      const inserted = await client.query<{ operation_key: string }>(
        `SELECT operation_key FROM military_siege_operations WHERE player_id=$1 AND request_id=$2`,
        [player.playerId, requestId]
      );
      if (inserted.rows[0]?.operation_key !== operationKey) {
        throw new MilitaryIndustryError("MILITARY_REPLAY_CONFLICT", "That siege request is already in progress.");
      }
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async fireBallistaVolley(
    player: MilitaryCommandPlayer,
    groupId: string,
    targetFlagId: string,
    requestId: string,
    targetKind: "flag" | "city_structure" = "flag"
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    requirePosition(player.position);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      if (targetKind === "city_structure") {
        const result = await this.fireBallistaVolleyAtCityBuildingInTransaction(
          client, player.playerId, groupId, targetFlagId, requestId, player
        );
        if (!result) throw new MilitaryIndustryError("MILITARY_BALLISTA_UNAVAILABLE", "No Ballista can fire this volley.");
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return {
          snapshot,
          damage: result.damage,
          affectedCityStructureIds: [targetFlagId],
          ...(result.siegeVolley ? { siegeVolleys: [result.siegeVolley] } : {}),
          replayed: result.replayed
        };
      }
      const result = await this.fireBallistaVolleyInTransaction(
        client,
        player.playerId,
        groupId,
        targetFlagId,
        requestId,
        player.position,
        player
      );
      if (!result) throw new MilitaryIndustryError("MILITARY_BALLISTA_UNAVAILABLE", "No Ballista can fire this volley.");
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return {
        snapshot,
        damage: result.damage,
        affectedFlagIds: result.affectedFlagIds,
        ...(result.siegeVolley ? { siegeVolleys: [result.siegeVolley] } : {}),
        replayed: result.replayed
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  /**
   * One Siege volley at a hostile city building (war part C3): a single
   * target, the organization minimum placement for the fusion level, flat
   * damage that stops at the building's burn threshold (3x while it is being
   * repaired) and ignites it there. The group keeps the building as its
   * durable cadence target until the threshold is reached.
   */
  private async fireBallistaVolleyAtCityBuildingInTransaction(
    client: pg.PoolClient,
    actorPlayerId: string,
    groupId: string,
    structureId: string,
    requestId: string,
    commandPlayer?: MilitaryCommandPlayer
  ): Promise<{ damage: number; siegeVolley?: MilitarySiegeVolleyCue; replayed: boolean } | null> {
    const operationKey = `military-siege:${actorPlayerId}:${requestId}`;
    const requestHash = hashRequest("ballista_volley", actorPlayerId, groupId, structureId);
    const prior = await existingSiegeOperation(client, actorPlayerId, requestId, "ballista_volley", requestHash);
    if (prior) return { damage: prior.damage, replayed: true };
    const group = await lockGroupWithMembers(client, actorPlayerId, groupId);
    if (!group || group.group.unit_type !== "field_ballista" ||
        group.group.location_state !== "DEPLOYED_FIELD" ||
        group.group.movement_order === "MOVE_TO_COORDINATE") {
      return null;
    }
    if (commandPlayer) await requireMilitaryGroupCommandScope(client, group.group, commandPlayer);
    const ballistas = group.members.filter((unit) => unit.status === "available" && unit.unit_type === "field_ballista" && unit.current_hp > 0);
    if (!ballistas.length) {
      if (!commandPlayer) await pauseBallistaGroup(client, groupId);
      return null;
    }
    const target = await asMilitaryError(async () => requireHostileCityBuildingInTransaction(
      client,
      await lockCityBuildingInTransaction(client, structureId),
      actorPlayerId
    ));
    if (group.group.lat === null || group.group.lon === null) {
      throw new MilitaryIndustryError("MILITARY_INVALID_POSITION", "The Siege group has no valid field position.");
    }
    const distanceM = distanceMeters(
      { lat: Number(group.group.lat), lon: Number(group.group.lon) },
      target.position
    );
    if (!isWithinSiegeAttackRange(distanceM)) {
      throw new MilitaryIndustryError("MILITARY_SIEGE_OUT_OF_RANGE", "Target is out of siege range.");
    }
    const minimumM = siegeOrganizationMinimumPlacementMeters(ballistas.length);
    if (distanceM + 1e-6 < minimumM) {
      throw new MilitaryIndustryError(
        "MILITARY_SIEGE_TOO_CLOSE",
        `A fusion level ${ballistas.length} Siege must be placed at least ${minimumM} m from a city building.`
      );
    }
    const now = target.nowMs;
    if (commandPlayer && group.group.next_fire_at && new Date(group.group.next_fire_at).getTime() > now) {
      throw new MilitaryIndustryError("MILITARY_BALLISTA_COOLDOWN", "This Ballista group is still reloading.");
    }
    const hit = await applyCityBuildingDamageInTransaction(client, target, {
      attackerPlayerId: actorPlayerId,
      baseDamage: planBallistaStructuralDamage(Number.MAX_SAFE_INTEGER, ballistas.length, 0),
      source: "siege"
    });
    if (hit.dealt <= 0) {
      await pauseBallistaGroup(client, groupId);
      if (commandPlayer) {
        throw new MilitaryIndustryError("MILITARY_FLAG_TARGET_INVALID", "That building is already at its burn threshold.");
      }
      return null;
    }
    await client.query(
      `INSERT INTO military_siege_operations (
         operation_key,player_id,request_id,action,group_id,flag_id,damage,target_kind,
         status,started_at,completes_at,completed_at
       ) VALUES ($1,$2,$3,'ballista_volley',$4::uuid,$5::uuid,$6,'city_structure',
         'complete',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
      [operationKey, actorPlayerId, requestId, groupId, structureId, hit.dealt]
    );
    if (hit.health > target.profile.burnThreshold) {
      const nextFireAt = new Date(now + MILITARY_BALLISTA_VOLLEY_CADENCE_MS);
      await client.query(
        `UPDATE military_units SET next_fire_at=$2,target_flag_id=NULL,revision=revision+1,updated_at=clock_timestamp()
         WHERE unit_id=ANY($1::uuid[])`,
        [ballistas.map((unit) => unit.unit_id), nextFireAt]
      );
      await client.query(
        `UPDATE military_unit_groups
         SET next_fire_at=$2,target_flag_id=NULL,target_city_structure_id=$3::uuid,
             revision=revision+1,updated_at=clock_timestamp()
         WHERE group_id=$1::uuid`,
        [groupId, nextFireAt, structureId]
      );
    } else {
      await pauseBallistaGroup(client, groupId);
    }
    return { damage: hit.dealt, siegeVolley: { groupId, occurredAt: now }, replayed: false };
  }

  private async fireBallistaVolleyInTransaction(
    client: pg.PoolClient,
    actorPlayerId: string | null,
    groupId: string,
    targetFlagId: string,
    requestId: string,
    playerPosition?: Readonly<{ lat: number; lon: number }>,
    commandPlayer?: MilitaryCommandPlayer
  ): Promise<{
    damage: number;
    affectedFlagIds: readonly string[];
    siegeVolley?: MilitarySiegeVolleyCue;
    replayed: boolean;
  } | null> {
    const operationKey = actorPlayerId ? `military-siege:${actorPlayerId}:${requestId}` : null;
    const requestHash = actorPlayerId ? hashRequest("ballista_volley", actorPlayerId, groupId, targetFlagId) : null;
    if (actorPlayerId && operationKey && requestHash) {
      const prior = await existingSiegeOperation(client, actorPlayerId, requestId, "ballista_volley", requestHash);
      if (prior) return {
        damage: prior.damage,
        affectedFlagIds: prior.affectedFlagIds,
        replayed: true
      };
    }
    const group = await lockGroupWithMembers(client, actorPlayerId, groupId);
    if (!group || group.group.unit_type !== "field_ballista" ||
        group.group.location_state !== "DEPLOYED_FIELD" ||
        group.group.movement_order === "MOVE_TO_COORDINATE") {
      return null;
    }
    if (actorPlayerId) {
      if (!playerPosition) throw new MilitaryIndustryError("MILITARY_INVALID_POSITION", "Your world position is unavailable.");
      await requireMilitaryGroupCommandScope(
        client,
        group.group,
        commandPlayer ?? { playerId: actorPlayerId, position: playerPosition }
      );
    }
    const ballistas = group.members.filter((unit) => unit.status === "available" && unit.unit_type === "field_ballista" && unit.current_hp > 0);
    if (!ballistas.length) {
      if (!actorPlayerId) await pauseBallistaGroup(client, groupId);
      return null;
    }
    // Lock the selected target and the complete candidate set in one
    // deterministic id-ordered query. This preserves the selected target's
    // authorization contract while avoiding overlapping-volley deadlocks.
    const { selectedTarget, targets } = await lockSiegeTargetsWithinRange(
      client,
      group.group,
      actorPlayerId,
      targetFlagId
    );
    // Cadence is an area volley, so a previously selected anchor may become
    // friendly, burn, breach, or leave range between hits. Re-anchor the
    // durable cadence to the first currently damageable target instead of
    // pausing the whole Siege while another eligible target remains.
    const cadenceReanchor = requestId.startsWith("cadence:");
    // City and kingdom structures are never part of the area volley: the
    // Siege fires at the one selected structure, from at least the minimum
    // placement distance for its fusion level.
    const organizations = actorPlayerId && selectedTarget && organizationOfFlag(selectedTarget)
      ? await loadPlayerOrganizations(client, actorPlayerId)
      : null;
    if (organizations && selectedTarget && isAlliedOrganizationStructure(organizations, selectedTarget)) {
      throw new MilitaryIndustryError("MILITARY_FLAG_TARGET_ALLY", "You cannot siege a structure of your own city or kingdom.");
    }
    const siegePeace = organizations && actorPlayerId && selectedTarget
      ? await forcedPeaceRefusalInTransaction(client, actorPlayerId, organizationOfFlag(selectedTarget)!)
      : null;
    if (siegePeace) throw new MilitaryIndustryError("MILITARY_FORCED_PEACE", siegePeace);
    const singleTarget = organizations && selectedTarget && isEligibleOrganizationTarget(selectedTarget, organizations)
      ? selectedTarget
      : null;
    // Explicit commands retain the selected target's normal range/error
    // semantics even when it is currently outside the area set. Background
    // cadence is different: if its old anchor became ineligible, re-anchor
    // the same volley to the first current target rather than pausing a
    // still-valid area Siege.
    const resolvedSelectedTarget = singleTarget ?? (cadenceReanchor
      ? selectedTarget && targets.some((target) => target.id === selectedTarget.id)
        ? selectedTarget
        : targets[0] ?? null
      : selectedTarget && isEligibleSiegeTarget(selectedTarget, actorPlayerId)
        ? selectedTarget
        : null);
    if (!resolvedSelectedTarget || (!singleTarget && !isEligibleSiegeTarget(resolvedSelectedTarget, actorPlayerId))) {
      throw new MilitaryIndustryError(
        "MILITARY_FLAG_TARGET_INVALID",
        "Only another player's eligible Tower or a hostile city or kingdom structure can be targeted."
      );
    }
    requireSiegeAttackRange(group.group, resolvedSelectedTarget);
    if (singleTarget) {
      const minimumM = siegeOrganizationMinimumPlacementMeters(ballistas.length);
      const distanceM = distanceMeters(
        { lat: Number(group.group.lat), lon: Number(group.group.lon) },
        { lat: Number(singleTarget.lat), lon: Number(singleTarget.lon) }
      );
      if (distanceM + 1e-6 < minimumM) {
        throw new MilitaryIndustryError(
          "MILITARY_SIEGE_TOO_CLOSE",
          `A fusion level ${ballistas.length} Siege must be placed at least ${minimumM} m from a city or kingdom structure.`
        );
      }
    }
    const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = new Date(clock.rows[0]!.now).getTime();
    if (actorPlayerId && group.group.next_fire_at && new Date(group.group.next_fire_at).getTime() > now) {
      throw new MilitaryIndustryError("MILITARY_BALLISTA_COOLDOWN", "This Ballista group is still reloading.");
    }
    const targetResults: Array<{
      flagId: string;
      damage: number;
      health: number;
      damageCycleId: string;
    }> = [];
    // Unyielding Assault: the Siege owner's kingdom adds 35% structural damage.
    const siegeMultiplier = await playerHasKingdomPerk(client, group.group.owner_player_id, "unyielding_assault")
      ? KINGDOM_PERK_UNYIELDING_ASSAULT_MULTIPLIER
      : 1;
    for (const target of singleTarget ? [singleTarget] : targets) {
      const targetHealth = Number(target.health);
      // Siege applies flat damage through the ignition boundary on personal
      // Towers. City and kingdom structures must burn, so Siege stops at their
      // burn threshold; only a Bomber on a repairing structure goes below it.
      // Reaching half health only enables the separate, Torch-backed ignition
      // action. Damage dealt to a structure that is being repaired counts triple.
      const damageFloor = singleTarget ? warfareProfileForRow(singleTarget)!.burnThreshold : 0;
      const repairMultiplier = await hasActiveRepair(client, target.id) ? STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER : 1;
      // Monoliths: an allied Frenzy monolith near the Siege adds 30%; an allied
      // Fortified monolith near the target cuts the hit to 55%. Kingdom perks then
      // reduce hits on kingdom structures.
      const volleyDamage = reducedStructureHit(
        await monolithAdjustedBuildingDamage(
          client,
          planBallistaStructuralDamage(Number.MAX_SAFE_INTEGER, ballistas.length, 0) * repairMultiplier * siegeMultiplier,
          {
            attacker: {
              playerId: group.group.owner_player_id,
              position: { lat: Number(group.group.lat), lon: Number(group.group.lon) }
            },
            target
          }
        ),
        singleTarget ? await kingdomStructureDamageReduction(client, target.id) : 0
      );
      const damage = Math.min(Math.max(0, targetHealth - damageFloor), volleyDamage);
      if (damage <= 0) continue;
      const updated = await client.query<{ health: number; damage_cycle_id: string }>(
        `UPDATE flags SET health=GREATEST($3::integer,health-$2::integer),damage_cycle_id=COALESCE(damage_cycle_id,gen_random_uuid())
         WHERE id=$1::uuid AND health > $3::integer
         RETURNING health,damage_cycle_id::text`,
        [target.id, damage, damageFloor]
      );
      const row = updated.rows[0];
      if (!row) continue;
      const result = {
        flagId: target.id,
        damage,
        health: Number(row.health),
        damageCycleId: row.damage_cycle_id
      };
      targetResults.push(result);
      if (actorPlayerId && operationKey && requestId && requestHash) {
        await recordFlagCycleContributor(
          client,
          actorPlayerId,
          target.id,
          `${operationKey}:${target.id}`,
          damage,
          row.damage_cycle_id
        );
      }
      if (singleTarget && actorPlayerId) {
        await recordOrganizationHostilityInTransaction(client, {
          attackerPlayerId: actorPlayerId,
          defender: organizationOfFlag(singleTarget)!,
          profile: warfareProfileForRow(singleTarget)!,
          structureName: singleTarget.name ?? "Flag"
        });
      }
      if (result.health <= 0 && singleTarget) {
        // A destroyed city or kingdom structure keeps its zero-health marker;
        // the organization fall sweep breaks it (or collapses the territory
        // for a City Center / Castle) in the network -> geometry lock order.
        await cancelFlagOperationsForDestruction(client, target.id);
        await clearMilitaryFlagTargetReferencesInTransaction(client, target.id);
        continue;
      }
      if (result.health <= 0) {
        if (!actorPlayerId) {
          throw new MilitaryIndustryError(
            "MILITARY_FLAG_TARGET_INVALID",
            "A Siege volley requires an owning player to retire a destroyed Flag."
          );
        }
        // The final Siege hit owns the same terminal boundary as burn
        // completion. Cancel every competing channel and clear durable unit
        // anchors before reusing the canonical Flag deletion helper.
        await cancelFlagOperationsForDestruction(client, target.id);
        await clearMilitaryFlagTargetReferencesInTransaction(client, target.id);
        if (!this.burningFlagDeletion) {
          throw new MilitaryIndustryError(
            "MILITARY_FLAG_DESTRUCTION_UNAVAILABLE",
            "Flag destruction service is unavailable."
          );
        }
        await this.burningFlagDeletion(client, target.id, actorPlayerId);
      }
    }
    if (!targetResults.length) {
      if (!actorPlayerId) await pauseBallistaGroup(client, groupId);
      return null;
    }
    const nextFireAt = new Date(now + MILITARY_BALLISTA_VOLLEY_CADENCE_MS);
    if (actorPlayerId && operationKey && requestId && requestHash) {
      await client.query(
        `INSERT INTO military_siege_operations (
           operation_key,player_id,request_id,action,group_id,flag_id,damage,damage_cycle_id,target_results,
           status,started_at,completes_at,completed_at
         ) VALUES ($1,$2,$3,'ballista_volley',$4::uuid,$5::uuid,$6,$7::uuid,$8::jsonb,
           'complete',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
        [
          operationKey,
          actorPlayerId,
          requestId,
          groupId,
          targetFlagId,
          // Keep the legacy response/ledger field as one target's normal
          // damage. The complete area result is retained in target_results.
          targetResults[0]!.damage,
          targetResults[0]!.damageCycleId,
          JSON.stringify(targetResults)
        ]
      );
    }
    const nextTargetId = targetResults.find((result) => result.health > 0)?.flagId ?? null;
    if (nextTargetId === null) {
      await pauseBallistaGroup(client, groupId);
    } else {
      const memberIds = ballistas.map((unit) => unit.unit_id);
      await client.query(
        `UPDATE military_units SET next_fire_at=$2,target_flag_id=$3::uuid,revision=revision+1,updated_at=clock_timestamp()
         WHERE unit_id=ANY($1::uuid[])`,
        [memberIds, nextFireAt, nextTargetId]
      );
      await client.query(
        `UPDATE military_unit_groups SET next_fire_at=$2,target_flag_id=$3::uuid,target_city_structure_id=NULL,
           revision=revision+1,updated_at=clock_timestamp()
         WHERE group_id=$1::uuid`,
        [groupId, nextFireAt, nextTargetId]
      );
    }
    return {
      damage: targetResults[0]!.damage,
      affectedFlagIds: targetResults.map((result) => result.flagId),
      siegeVolley: { groupId, occurredAt: now },
      replayed: false
    };
  }

  async repairBallista(
    player: Pick<PlayerRecord, "playerId" | "position">,
    unitId: string,
    requestId: string
  ): Promise<MilitaryMutationResult> {
    requireRequestId(requestId);
    const requestHash = hashRequest("repair_ballista", player.playerId, unitId);
    const operationKey = `military-unit:${player.playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, player.playerId);
      const prior = await replayMilitaryOperation(client, player.playerId, requestId, "repair_ballista", requestHash);
      if (prior) {
        const snapshot = await this.snapshotInTransaction(client, player.playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return { snapshot, inventory, replayed: true };
      }
      await reserveMilitaryOperation(client, operationKey, player.playerId, requestId, "repair_ballista", requestHash);
      const result = await client.query<MilitaryUnitRow>(
        `SELECT unit_id::text,owner_player_id,unit_type,home_city_id::text,current_hp,max_hp,status,
           location_state,station_city_id::text,war_camp_id::text,lat,lon,group_id::text,
           next_recovery_at,next_fire_at,target_flag_id::text,movement_order,
           movement_target_lat,movement_target_lon,packing_completes_at,revision::text,created_at
         FROM military_units WHERE unit_id=$1::uuid AND owner_player_id=$2 FOR UPDATE`,
        [unitId, player.playerId]
      );
      const unit = result.rows[0];
      if (!unit || unit.unit_type !== "field_ballista" || unit.status === "destroyed") throw new MilitaryIndustryError("MILITARY_BALLISTA_UNAVAILABLE", "That Ballista is unavailable for repair.");
      if (unit.current_hp >= unit.max_hp) throw new MilitaryIndustryError("MILITARY_BALLISTA_NOT_DAMAGED", "That Ballista is already at full condition.");
      if (!["STATIONED_CITY", "STATIONED_WAR_CAMP"].includes(unit.location_state)) throw new MilitaryIndustryError("MILITARY_REPAIR_LOCATION_REQUIRED", "Repair a Ballista at a City or War Camp.");
      await requireMilitaryUnitStationRange(client, unit, player.position);
      const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:materials`,
        playerId: player.playerId,
        source: "ballista_repair",
        sourceEntityType: "military_unit",
        sourceEntityId: unitId,
        metadata: { requestId },
        debits: [
          { itemId: "repair_kit", variant: DEFAULT_INVENTORY_VARIANT, quantity: BigInt(MILITARY_BALLISTA_REPAIR_COST.repairKit) },
          { itemId: "wood", variant: DEFAULT_INVENTORY_VARIANT, quantity: BigInt(MILITARY_BALLISTA_REPAIR_COST.wood) },
          { itemId: "iron_bar", variant: DEFAULT_INVENTORY_VARIANT, quantity: BigInt(MILITARY_BALLISTA_REPAIR_COST.ironBar) }
        ]
      });
      await client.query(
        `UPDATE military_units SET current_hp=LEAST(max_hp,current_hp+$2::smallint),revision=revision+1,updated_at=clock_timestamp() WHERE unit_id=$1::uuid`,
        [unitId, MILITARY_BALLISTA_REPAIR_AMOUNT]
      );
      await completeMilitaryOperation(client, operationKey, { unitId, repaired: MILITARY_BALLISTA_REPAIR_AMOUNT });
      const snapshot = await this.snapshotInTransaction(client, player.playerId);
      await client.query("COMMIT");
      return { snapshot, inventory: debited.inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  /**
   * `attackerPlayerId` is the member who dealt the damage, when one did: a
   * defeated unit recovers 1.5x slower against a Watchfires kingdom at war with
   * its owner. (No live path damages human units yet; see the perk's effect line.)
   */
  async applyUnitDamage(playerId: string, unitId: string, damage: number, attackerPlayerId?: string): Promise<void> {
    if (!Number.isSafeInteger(damage) || damage <= 0) throw new MilitaryIndustryError("MILITARY_INVALID_DAMAGE", "Damage must be positive.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockPlayerMilitaryChannel(client, playerId);
      const result = await client.query<{ unit_type: MilitaryUnitType; current_hp: number; max_hp: number; home_city_id: string | null; group_id: string | null }>(
        `SELECT unit_type,current_hp,max_hp,home_city_id::text,group_id::text FROM military_units
         WHERE unit_id=$1::uuid AND owner_player_id=$2 AND status='available' FOR UPDATE`,
        [unitId, playerId]
      );
      const unit = result.rows[0];
      if (!unit) throw new MilitaryIndustryError("MILITARY_UNIT_NOT_FOUND", "That military unit is unavailable.");
      if (unit.group_id) await cancelPendingBomberChannelsForGroup(client, unit.group_id, playerId);
      const nextHp = Math.max(0, Number(unit.current_hp) - damage);
      if (nextHp > 0) {
        await client.query(`UPDATE military_units SET current_hp=$2,revision=revision+1,updated_at=clock_timestamp() WHERE unit_id=$1::uuid`, [unitId, nextHp]);
      } else if (unit.unit_type === "field_ballista") {
        await client.query(
          `UPDATE military_units SET current_hp=0,status='destroyed',location_state='DEPLOYED_FIELD',group_id=NULL,
             target_flag_id=NULL,next_fire_at=NULL,packing_completes_at=NULL,
             revision=revision+1,updated_at=clock_timestamp()
           WHERE unit_id=$1::uuid`,
          [unitId]
        );
      } else {
        const recoveryMs = militaryHumanRecoveryDurationMs(
          attackerPlayerId !== undefined && await watchfiresDelayRecovery(client, attackerPlayerId, playerId)
        );
        await client.query(
          `UPDATE military_units SET current_hp=0,status='recovering',location_state='RECOVERING',group_id=NULL,
             station_city_id=home_city_id,war_camp_id=NULL,
             next_recovery_at=clock_timestamp()+($2::bigint * interval '1 millisecond'),revision=revision+1,updated_at=clock_timestamp()
           WHERE unit_id=$1::uuid`,
          [unitId, recoveryMs]
        );
      }
      await client.query(`DELETE FROM military_unit_groups group_row WHERE group_row.owner_player_id=$1 AND NOT EXISTS (SELECT 1 FROM military_units unit WHERE unit.group_id=group_row.group_id AND unit.status<>'destroyed')`, [playerId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw translateMilitaryError(error);
    } finally {
      client.release();
    }
  }

  async reconcileDueRallies(limit = 100): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{ operation_key: string; player_id: string; camp_id: string }>(
        `SELECT operation_key,player_id,camp_id::text FROM military_rally_operations
         WHERE status='pending' AND completes_at<=clock_timestamp()
         ORDER BY player_id,completes_at,operation_key LIMIT $1`,
        [limit]
      );
      for (const row of due.rows) {
        await lockPlayerMilitaryChannel(client, row.player_id);
        const pending = await client.query<{ operation_key: string; player_id: string; camp_id: string }>(
          `SELECT operation_key,player_id,camp_id::text
           FROM military_rally_operations
           WHERE operation_key=$1 AND status='pending' AND completes_at<=clock_timestamp()
           FOR UPDATE SKIP LOCKED`,
          [row.operation_key]
        );
        if (!pending.rows[0]) continue;
        const rally = pending.rows[0];
        const camp = await client.query<{ camp_id: string }>(
          `SELECT camp_id::text FROM war_camps
           WHERE camp_id=$1::uuid AND owner_player_id=$2 AND removed_at IS NULL
           FOR UPDATE`,
          [rally.camp_id, rally.player_id]
        );
        if (!camp.rows[0]) {
          await client.query(
            `UPDATE military_rally_operations
             SET status='cancelled',completed_at=clock_timestamp()
             WHERE operation_key=$1 AND status='pending'`,
            [rally.operation_key]
          );
          continue;
        }
        await client.query(
          `UPDATE military_units
           SET location_state='STATIONED_WAR_CAMP',war_camp_id=$2::uuid,station_city_id=NULL,
               lat=camp.lat,lon=camp.lon,revision=revision+1,updated_at=clock_timestamp()
           FROM war_camps camp
           WHERE military_units.owner_player_id=$1
             AND military_units.status='available'
             AND military_units.location_state='STATIONED_CITY'
             AND camp.camp_id=$2::uuid AND camp.removed_at IS NULL`,
          [rally.player_id, rally.camp_id]
        );
        await client.query(
          `UPDATE military_unit_groups
           SET location_state='STATIONED_WAR_CAMP',war_camp_id=$2::uuid,station_city_id=NULL,
               lat=camp.lat,lon=camp.lon,revision=revision+1,updated_at=clock_timestamp()
           FROM war_camps camp
           WHERE military_unit_groups.owner_player_id=$1
             AND military_unit_groups.location_state='STATIONED_CITY'
             AND camp.camp_id=$2::uuid AND camp.removed_at IS NULL
             AND EXISTS (SELECT 1 FROM military_units unit WHERE unit.group_id=military_unit_groups.group_id AND unit.status='available')`,
          [rally.player_id, rally.camp_id]
        );
        await client.query(
          `UPDATE military_rally_operations SET status='complete',completed_at=clock_timestamp() WHERE operation_key=$1`,
          [rally.operation_key]
        );
      }
      await client.query("COMMIT");
      return due.rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileDueBomberDemolitions(limit = 100): Promise<number> {
    const client = await this.pool.connect();
    const detonations: Array<{ playerId: string; cue: MilitaryBomberDetonationCue }> = [];
    try {
      await client.query("BEGIN");
      const due = await client.query<{
        operation_key: string;
        player_id: string;
        request_id: string;
        group_id: string;
        flag_id: string;
        target_kind: "flag" | "city_structure";
        group_revision: string;
        member_revisions: Record<string, string | number>;
      }>(
        `SELECT operation_key,player_id,request_id,group_id::text,flag_id::text,target_kind,
                group_revision::text,member_revisions
         FROM military_siege_operations
         WHERE action='demolish_flag' AND status='pending' AND completes_at<=clock_timestamp()
         ORDER BY player_id,completes_at,operation_key
         LIMIT $1`,
        [limit]
      );
      let completed = 0;
      for (const row of due.rows) {
        await client.query("SAVEPOINT bomber_demolition");
        try {
          await lockPlayerMilitaryChannel(client, row.player_id);
          const pending = await client.query<typeof row>(
            `SELECT operation_key,player_id,request_id,group_id::text,flag_id::text,target_kind,
                    group_revision::text,member_revisions
             FROM military_siege_operations
             WHERE operation_key=$1 AND action='demolish_flag' AND status='pending'
               AND completes_at<=clock_timestamp()
             FOR UPDATE SKIP LOCKED`,
            [row.operation_key]
          );
          if (!pending.rows[0]) {
            await client.query("RELEASE SAVEPOINT bomber_demolition");
            continue;
          }
          const operation = pending.rows[0];
          const group = await lockGroupWithMembers(client, operation.player_id, operation.group_id);
          if (!group || group.group.unit_type !== "bomber" || !["FOLLOWING_PLAYER", "DEPLOYED_FIELD"].includes(group.group.location_state)) {
            throw new MilitaryIndustryError("MILITARY_BOMBER_NOT_DEPLOYED", "The Bomber channel no longer has a valid deployed group.");
          }
          if (group.members.some((unit) => unit.status !== "available" || unit.current_hp <= 0)) {
            throw new MilitaryIndustryError("MILITARY_BOMBER_INTERRUPTED", "The Bomber channel was interrupted.");
          }
          if (String(group.group.revision) !== String(operation.group_revision) || !sameMemberRevisions(group.members, operation.member_revisions)) {
            throw new MilitaryIndustryError("MILITARY_BOMBER_INTERRUPTED", "The Bomber channel was interrupted by a group change.");
          }
          const position = group.group.lat !== null && group.group.lon !== null
            ? { lat: Number(group.group.lat), lon: Number(group.group.lon) }
            : null;
          if (!position) throw new MilitaryIndustryError("MILITARY_INVALID_POSITION", "The Bomber group no longer has a valid field position.");
          let targetPosition: Readonly<{ lat: number; lon: number }>;
          if (operation.target_kind === "city_structure") {
            targetPosition = await lockBomberCityBuilding(client, operation.flag_id, operation.player_id, position);
            await asMilitaryError(() => applyCityBuildingBombInTransaction(client, operation.flag_id, operation.player_id));
            this.reconciledCityStructureIds.add(operation.flag_id);
          } else {
          const target = await lockBomberTarget(client, operation.flag_id, operation.player_id, position);
          targetPosition = { lat: Number(target.lat), lon: Number(target.lon) };
          let deletion: BomberFlagDeletion;
          try {
            if (this.bomberFlagDeletion) {
              deletion = await this.bomberFlagDeletion(client, operation.flag_id, operation.player_id);
            } else {
              deletion = await deleteBomberFlagInTransaction(client, operation.flag_id, operation.player_id);
            }
          } catch (error) {
            if (error instanceof MilitaryIndustryError) throw error;
            if (error instanceof Error && error.name === "FlagDestructionError") {
              throw new MilitaryIndustryError("MILITARY_FLAG_TARGET_INVALID", error.message);
            }
            throw error;
          }
          const targetStillExists = await client.query(
            "SELECT 1 FROM flags WHERE id=$1::uuid",
            [operation.flag_id]
          );
          if (targetStillExists.rowCount !== 1) {
            await cancelFlagOperationsForDestruction(client, operation.flag_id, operation.operation_key);
            await clearMilitaryFlagTargetReferencesInTransaction(client, operation.flag_id);
          }
          for (const flagId of deletion.affectedFlagIds) {
            this.reconciledBallistaFlagIds.add(flagId);
          }
          if (targetStillExists.rowCount !== 1) {
            this.reconciledBallistaFlagIds.add(operation.flag_id);
          }
          }
          const selected = [...group.members]
            .filter((unit) => unit.unit_type === "bomber" && unit.status === "available" && unit.current_hp > 0)
            .sort(compareMilitaryMembers)[0];
          if (!selected) throw new MilitaryIndustryError("MILITARY_BOMBER_REQUIRED", "No available Bomber remains in this group.");
          const consumed = await client.query<{ unit_id: string }>(
            `UPDATE military_units
             SET current_hp=0,status='destroyed',location_state='DEPLOYED_FIELD',group_id=NULL,
                 station_city_id=NULL,war_camp_id=NULL,target_flag_id=NULL,next_fire_at=NULL,
                 revision=revision+1,updated_at=clock_timestamp()
             WHERE unit_id=$1::uuid AND owner_player_id=$2 AND group_id=$3::uuid
               AND unit_type='bomber' AND status='available' AND current_hp > 0
             RETURNING unit_id::text`,
            [selected.unit_id, operation.player_id, operation.group_id]
          );
          if (!consumed.rows[0]) throw new MilitaryIndustryError("MILITARY_BOMBER_INTERRUPTED", "The Bomber channel was interrupted.");
          await client.query(
            `UPDATE military_unit_groups
             SET revision=revision+1,updated_at=clock_timestamp()
             WHERE group_id=$1::uuid AND owner_player_id=$2`,
            [operation.group_id, operation.player_id]
          );
          await client.query(
            `DELETE FROM military_unit_groups group_row
             WHERE group_row.group_id=$1::uuid AND group_row.owner_player_id=$2
               AND NOT EXISTS (
                 SELECT 1 FROM military_units unit
                 WHERE unit.group_id=group_row.group_id AND unit.status<>'destroyed'
               )`,
            [operation.group_id, operation.player_id]
          );
          await client.query(
            `UPDATE military_siege_operations
             SET status='complete',damage=$2,consumed_unit_id=$3::uuid,completed_at=clock_timestamp()
             WHERE operation_key=$1 AND status='pending'`,
            [operation.operation_key, STRUCTURE_WARFARE_BOMBER_DAMAGE, selected.unit_id]
          );
          await client.query("RELEASE SAVEPOINT bomber_demolition");
          detonations.push({ playerId: operation.player_id, cue: {
            requestId: operation.request_id, groupId: operation.group_id,
            occurredAt: Date.now(), position, targetPosition
          } });
          completed += 1;
        } catch (error) {
          if (!(error instanceof MilitaryIndustryError)) throw error;
          await client.query("ROLLBACK TO SAVEPOINT bomber_demolition");
          await client.query(
            `UPDATE military_siege_operations
             SET status='cancelled',completed_at=clock_timestamp()
             WHERE operation_key=$1 AND status='pending'`,
            [row.operation_key]
          );
          await client.query("RELEASE SAVEPOINT bomber_demolition");
        }
      }
      await client.query("COMMIT");
      // No presentation escapes a cancelled savepoint or a failed outer commit.
      this.reconciledBomberDetonationCues.push(...detonations);
      return completed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileDueBallistaVolleys(limit = 100): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{
        group_id: string;
        owner_player_id: string;
        target_flag_id: string | null;
        target_city_structure_id: string | null;
        next_fire_at: Date | string | null;
        lat: number | null;
        lon: number | null;
      }>(
        `SELECT group_id::text,owner_player_id,target_flag_id::text,target_city_structure_id::text,next_fire_at,lat,lon FROM (
           SELECT * FROM military_unit_groups
           WHERE location_state='DEPLOYED_FIELD' AND unit_type='field_ballista'
             AND movement_order<>'MOVE_TO_COORDINATE'
             AND (next_fire_at IS NULL OR next_fire_at<=clock_timestamp())
           ORDER BY updated_at,owner_player_id,group_id LIMIT $1
         ) due ORDER BY owner_player_id,group_id`,
        [limit]
      );
      let fired = 0;
      const volleyCues: Array<{ playerId: string; cue: MilitarySiegeVolleyCue }> = [];
      for (const row of due.rows) {
        try {
          await lockPlayerMilitaryChannel(client, row.owner_player_id);
          const pending = await client.query<typeof row>(
            `SELECT group_id::text,owner_player_id,target_flag_id::text,target_city_structure_id::text,next_fire_at,lat,lon
             FROM military_unit_groups
             WHERE group_id=$1::uuid AND location_state='DEPLOYED_FIELD'
               AND unit_type='field_ballista' AND movement_order<>'MOVE_TO_COORDINATE'
               AND (next_fire_at IS NULL OR next_fire_at<=clock_timestamp())
             FOR UPDATE SKIP LOCKED`,
            [row.group_id]
          );
          if (!pending.rows[0]) continue;
          const cadence = pending.rows[0];
          if (cadence.next_fire_at === null) {
            // Recover already deployed groups paused by an old invalid target,
            // including towers that appeared after deployment. Reuse the same
            // target authorization and range checks, and allow a full reload.
            const group = await lockGroupWithMembers(client, cadence.owner_player_id, cadence.group_id);
            if (!group) continue;
            const { targets } = await lockSiegeTargetsWithinRange(
              client, group.group, cadence.owner_player_id, NO_SELECTED_SIEGE_TARGET_ID
            );
            const targetId = group.members.some((unit) => unit.status === "available" && unit.current_hp > 0)
              ? targets[0]?.id ?? null : null;
            await client.query(
              "UPDATE military_unit_groups SET target_city_structure_id=NULL WHERE group_id=$1::uuid",
              [cadence.group_id]
            );
            for (const table of ["military_units", "military_unit_groups"] as const) {
              await client.query(
                `UPDATE ${table} SET target_flag_id=$2::uuid,
                   next_fire_at=CASE WHEN $2::uuid IS NULL THEN NULL ELSE
                     clock_timestamp()+($3::bigint*interval '1 millisecond') END,
                   revision=revision+CASE WHEN $2::uuid IS NULL THEN 0 ELSE 1 END,
                   updated_at=clock_timestamp() WHERE group_id=$1::uuid`,
                [cadence.group_id, targetId, MILITARY_BALLISTA_VOLLEY_CADENCE_MS]
              );
            }
            if (targetId) fired += 1; // Publish the recovered countdown snapshot.
            continue;
          }
          if (this.automaticFirePolicy && !(await this.automaticFirePolicy(cadence.owner_player_id))) {
            // Hold fire, not the group: re-arm one cadence later so the owner
            // fires again as soon as the gate allows it (Settled regained).
            for (const table of ["military_units", "military_unit_groups"] as const) {
              await client.query(
                `UPDATE ${table} SET next_fire_at=clock_timestamp()+($2::bigint*interval '1 millisecond'),
                   updated_at=clock_timestamp() WHERE group_id=$1::uuid`,
                [cadence.group_id, MILITARY_BALLISTA_VOLLEY_CADENCE_MS]
              );
            }
            continue;
          }
          const cadencePosition = cadence.lat !== null && cadence.lon !== null
            ? { lat: Number(cadence.lat), lon: Number(cadence.lon) }
            : undefined;
          const cadenceRequestId = `cadence:${cadence.group_id}:${new Date(cadence.next_fire_at).getTime()}`;
          if (cadence.target_city_structure_id) {
            const buildingVolley = await this.fireBallistaVolleyAtCityBuildingInTransaction(
              client,
              cadence.owner_player_id,
              cadence.group_id,
              cadence.target_city_structure_id,
              cadenceRequestId
            );
            this.reconciledCityStructureIds.add(cadence.target_city_structure_id);
            if (buildingVolley) {
              fired += 1;
              if (buildingVolley.siegeVolley) {
                volleyCues.push({ playerId: cadence.owner_player_id, cue: buildingVolley.siegeVolley });
              }
            }
            continue;
          }
          const result = await this.fireBallistaVolleyInTransaction(
            client,
            cadence.owner_player_id,
            cadence.group_id,
            cadence.target_flag_id ?? NO_SELECTED_SIEGE_TARGET_ID,
            cadenceRequestId,
            cadencePosition
          );
          if (result) {
            fired += 1;
            if (result.siegeVolley) {
              volleyCues.push({ playerId: cadence.owner_player_id, cue: result.siegeVolley });
            }
            for (const flagId of result.affectedFlagIds) {
              this.reconciledBallistaFlagIds.add(flagId);
            }
          }
        } catch (error) {
          if (!(error instanceof MilitaryIndustryError)) throw error;
          // A target can become invalid while the owner is offline. Pause the
          // selected target instead of retrying a permanently invalid volley.
          await pauseBallistaGroup(client, row.group_id);
        }
      }
      await client.query("COMMIT");
      for (const { playerId, cue } of volleyCues) {
        const cues = this.reconciledBallistaVolleyCues.get(playerId) ?? [];
        cues.push(cue);
        this.reconciledBallistaVolleyCues.set(playerId, cues);
      }
      return fired;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadLodge(queryable: Queryable, playerId: string, lock = false): Promise<LodgeRow | null> {
    const result = await queryable.query<LodgeRow>(
      `SELECT lodge_id::text,owner_player_id,world_id,region_code,lat,lon,level,
         reserved_capacity,placement_revision::text,built_at,upgraded_at
       FROM player_lodges WHERE owner_player_id=$1 AND removed_at IS NULL
       ORDER BY created_at,lodge_id LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
      [playerId]
    );
    return result.rows[0] ?? null;
  }

  private async loadPersonnel(queryable: Queryable, playerId: string): Promise<PersonnelRow[]> {
    const result = await queryable.query<PersonnelRow>(
      `SELECT personnel_id::text,owner_player_id,personnel_type,capacity_cost,status,
         created_at,assignment_reference,revision::text
       FROM military_personnel WHERE owner_player_id=$1
       ORDER BY created_at,personnel_id`,
      [playerId]
    );
    return result.rows;
  }

  private async loadUnits(queryable: Queryable, playerId: string): Promise<MilitaryUnitRow[]> {
    const result = await queryable.query<MilitaryUnitRow>(
      `SELECT unit_id::text,owner_player_id,unit_type,home_city_id::text,current_hp,max_hp,status,
         location_state,station_city_id::text,war_camp_id::text,lat,lon,group_id::text,
         next_recovery_at,next_fire_at,target_flag_id::text,movement_order,
         movement_target_lat,movement_target_lon,packing_completes_at,
         revision::text,created_at
       FROM military_units WHERE owner_player_id=$1
       ORDER BY created_at,unit_id`,
      [playerId]
    );
    return result.rows;
  }

  private async loadGroups(queryable: Queryable, playerId: string): Promise<MilitaryUnitGroupRow[]> {
    const result = await queryable.query<MilitaryUnitGroupRow>(
      `SELECT group_id::text,owner_player_id,unit_type,location_state,station_city_id::text,
         war_camp_id::text,lat,lon,target_flag_id::text,movement_order,
         movement_target_lat,movement_target_lon,next_fire_at,packing_completes_at,revision::text,created_at,
           target_city_structure_id::text
       FROM military_unit_groups WHERE owner_player_id=$1
       ORDER BY created_at,group_id`,
      [playerId]
    );
    return result.rows;
  }

  private async loadVisibleGroups(
    queryable: Queryable,
    viewer: MilitaryCommandPlayer
  ): Promise<{ groups: readonly MilitaryUnitGroupRow[]; units: readonly MilitaryUnitRow[] }> {
    const viewCenter = viewer.resourceVision?.center ?? viewer.anchor ?? viewer.position;
    const radiusM = viewer.resourceVision?.radiusM ?? DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M;
    if (
      !isFiniteLatLon(Number(viewCenter.lat), Number(viewCenter.lon)) ||
      !Number.isFinite(Number(radiusM)) || Number(radiusM) <= 0
    ) {
      return { groups: [], units: [] };
    }
    const groupsResult = await queryable.query<MilitaryUnitGroupRow>(
      `SELECT group_id::text,owner_player_id,unit_type,location_state,station_city_id::text,
         war_camp_id::text,lat,lon,target_flag_id::text,movement_order,
         movement_target_lat,movement_target_lon,next_fire_at,packing_completes_at,revision::text,created_at,
           target_city_structure_id::text
       FROM military_unit_groups
       WHERE owner_player_id<>$1
         AND unit_type='field_ballista'
         AND location_state IN ('FOLLOWING_PLAYER','DEPLOYED_FIELD')
         AND lat IS NOT NULL AND lon IS NOT NULL
       ORDER BY created_at,group_id`,
      [viewer.playerId]
    );
    const groups = groupsResult.rows.filter((group) =>
      group.lat !== null && group.lon !== null &&
      isFiniteLatLon(Number(group.lat), Number(group.lon)) &&
      distanceMeters(viewCenter, { lat: Number(group.lat), lon: Number(group.lon) }) <= Number(radiusM)
    );
    if (groups.length === 0) return { groups: [], units: [] };
    const unitsResult = await queryable.query<MilitaryUnitRow>(
      `SELECT unit_id::text,owner_player_id,unit_type,home_city_id::text,current_hp,max_hp,status,
         location_state,station_city_id::text,war_camp_id::text,lat,lon,group_id::text,
         next_recovery_at,next_fire_at,target_flag_id::text,movement_order,
         movement_target_lat,movement_target_lon,packing_completes_at,
         revision::text,created_at
       FROM military_units
       WHERE group_id=ANY($1::uuid[])
       ORDER BY created_at,unit_id`,
      [groups.map((group) => group.group_id)]
    );
    return { groups, units: unitsResult.rows };
  }

  /** Other players' standing War Camps inside the viewer's vision, nearest first. */
  private async loadVisibleWarCamps(queryable: Queryable, viewer: MilitaryCommandPlayer): Promise<WarCampRow[]> {
    const viewCenter = viewer.resourceVision?.center ?? viewer.anchor ?? viewer.position;
    const radiusM = viewer.resourceVision?.radiusM ?? DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M;
    if (!isFiniteLatLon(Number(viewCenter.lat), Number(viewCenter.lon)) ||
        !Number.isFinite(Number(radiusM)) || Number(radiusM) <= 0) {
      return [];
    }
    const result = await queryable.query<WarCampRow>(
      `SELECT camp.camp_id::text,camp.owner_player_id,camp.world_id,camp.region_code,camp.lat,camp.lon,
         camp.placement_revision::text,camp.built_at,camp.removed_at,camp.relocation_available_at,
         camp.health,camp.maximum_health,camp.burning_until,owner.username AS owner_name
       FROM war_camps camp
       LEFT JOIN players owner ON owner.id = camp.owner_player_id
       WHERE camp.owner_player_id <> $1 AND camp.removed_at IS NULL
         AND ST_DWithin(camp.geom::geography, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, $4)
       ORDER BY ST_Distance(camp.geom::geography, ST_SetSRID(ST_MakePoint($3,$2),4326)::geography), camp.camp_id
       LIMIT 20`,
      [viewer.playerId, Number(viewCenter.lat), Number(viewCenter.lon), Number(radiusM)]
    );
    return result.rows;
  }

  private async loadWarCamp(queryable: Queryable, playerId: string, lock = false): Promise<WarCampRow | null> {
    const result = await queryable.query<WarCampRow>(
      `SELECT camp_id::text,owner_player_id,world_id,region_code,lat,lon,
         placement_revision::text,built_at,removed_at,relocation_available_at,
         health,maximum_health,burning_until
       FROM war_camps WHERE owner_player_id=$1 AND removed_at IS NULL
       ORDER BY created_at,camp_id LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
      [playerId]
    );
    return result.rows[0] ?? null;
  }

  private async loadBomberChannel(queryable: Queryable, playerId: string): Promise<MilitaryBomberChannelSnapshot | null> {
    const result = await queryable.query<BomberChannelRow>(
      `SELECT request_id,group_id::text,flag_id::text,target_kind,started_at,completes_at
       FROM military_siege_operations
        WHERE player_id=$1 AND action='demolish_flag' AND status='pending'
       ORDER BY started_at,operation_key
       LIMIT 1`,
      [playerId]
    );
    const row = result.rows[0];
    return row
      ? {
          requestId: row.request_id,
          groupId: row.group_id,
          targetFlagId: row.flag_id,
          ...(row.target_kind === "city_structure" ? { targetKind: "city_structure" as const } : {}),
          startedAt: new Date(row.started_at).toISOString(),
          completesAt: new Date(row.completes_at).toISOString()
        }
      : null;
  }

  private async loadPlayerJobs(queryable: Queryable, playerId: string): Promise<JobRow[]> {
    const result = await queryable.query<JobRow>(
      `SELECT job_id::text,facility_structure_id::text,owner_player_id,job_type,quantity,output_quantity,
         collected_quantity,request_id,request_hash,started_at,completes_at,cleared_at
       FROM military_facility_jobs WHERE owner_player_id=$1 AND cleared_at IS NULL
       ORDER BY started_at,created_at,job_id`,
      [playerId]
    );
    return result.rows;
  }

  private async replayLodgeOperation(
    queryable: Queryable,
    playerId: string,
    requestId: string,
    action: LodgeOperationRow["action"],
    requestHash: string
  ): Promise<LodgeOperationRow | null> {
    const result = await queryable.query<LodgeOperationRow>(
      `SELECT player_id,request_id,action,request_hash,result,completed_at
       FROM military_lodge_operations WHERE player_id=$1 AND request_id=$2 FOR UPDATE`,
      [playerId, requestId]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.action !== action || row.request_hash !== requestHash || !row.completed_at || !row.result) {
      throw new MilitaryIndustryError("LODGE_REPLAY_CONFLICT", "That Lodge request ID was already used for different work.");
    }
    return row;
  }

  /** Return and clear the flag ids changed by background Siege cadence. */
  takeReconciledCityStructureIds(): readonly string[] {
    const ids = [...this.reconciledCityStructureIds].sort();
    this.reconciledCityStructureIds.clear();
    return ids;
  }

  takeReconciledBallistaFlagIds(): readonly string[] {
    const flagIds = [...this.reconciledBallistaFlagIds].sort();
    this.reconciledBallistaFlagIds.clear();
    return flagIds;
  }

  /** Drain committed Bomber detonations once, including those reconciled by snapshot(). */
  takeReconciledBomberDetonationCues(): ReadonlyArray<Readonly<{ playerId: string; cue: MilitaryBomberDetonationCue }>> {
    return this.reconciledBomberDetonationCues.splice(0);
  }

  /** Return and clear owner-scoped background Siege launch cues. */
  takeReconciledBallistaVolleyCues(): ReadonlyArray<Readonly<{
    playerId: string;
    cue: MilitarySiegeVolleyCue;
  }>> {
    const cues: Array<{ playerId: string; cue: MilitarySiegeVolleyCue }> = [];
    for (const [playerId, playerCues] of this.reconciledBallistaVolleyCues) {
      for (const cue of playerCues) cues.push({ playerId, cue });
    }
    this.reconciledBallistaVolleyCues.clear();
    return cues;
  }
}

function snapshotOf(
  lodge: LodgeRow | null,
  personnel: readonly PersonnelRow[],
  units: readonly MilitaryUnitRow[],
  groups: readonly MilitaryUnitGroupRow[],
  warCamp: WarCampRow | null,
  jobs: readonly JobRow[],
  bomberChannel: MilitaryBomberChannelSnapshot | null,
  nowMs: number,
  visible: { groups: readonly MilitaryUnitGroupRow[]; units: readonly MilitaryUnitRow[] } | null = null
): MilitaryIndustrySnapshot {
  const occupied = units
    .filter((row) => row.status !== "destroyed")
    .length + personnel
      .filter((row) => row.status !== "training")
      .reduce((total, row) => total + Number(row.capacity_cost), 0);
  return {
    lodge: lodge ? mapLodge(lodge, occupied) : null,
    personnel: personnel.map(mapPersonnel),
    units: units.map(mapUnit),
    groups: mapGroups(groups, units),
    ...(visible ? { visibleGroups: mapGroups(visible.groups, visible.units) } : {}),
    warCamp: warCamp ? mapWarCamp(warCamp) : null,
    bomberChannel,
    jobs: jobs.map((job) => mapJob(job, nowMs)),
    queueCapacity: MILITARY_FACILITY_QUEUE_CAPACITY,
    bomberCrudeOilPrice: bomberCrudeOilCost(
      units.filter((row) => row.unit_type === "bomber" && row.status !== "destroyed").length +
        jobs.filter((job) => job.job_type === "train_bomber" && !job.cleared_at)
          .reduce((total, job) => total + Number(job.quantity), 0)
    ),
    serverTime: nowMs,
    fieldBallistaKitEnabled: false,
    fieldBallistaEnabled: true
  };
}

function mapLodge(row: LodgeRow, occupiedCapacity?: number): LodgeSnapshot {
  const occupied = occupiedCapacity ?? 0;
  return {
    lodgeId: row.lodge_id,
    ownerPlayerId: row.owner_player_id,
    worldId: row.world_id,
    regionCode: row.region_code,
    lat: Number(row.lat),
    lon: Number(row.lon),
    level: row.level as LodgeLevel,
    capacity: LODGE_CAPACITY_BY_LEVEL[row.level as LodgeLevel],
    occupiedCapacity: occupied,
    reservedCapacity: Number(row.reserved_capacity),
    placementRevision: String(row.placement_revision),
    builtAt: new Date(row.built_at).toISOString(),
    upgradedAt: row.upgraded_at ? new Date(row.upgraded_at).toISOString() : null
  };
}

function mapPersonnel(row: PersonnelRow): PersonnelSnapshot {
  return {
    personnelId: row.personnel_id,
    ownerPlayerId: row.owner_player_id,
    personnelType: row.personnel_type,
    capacityCost: Number(row.capacity_cost),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    assignmentReference: row.assignment_reference,
    revision: String(row.revision)
  };
}

function mapUnit(row: MilitaryUnitRow): MilitaryUnitSnapshot {
  const movementOrder = row.movement_order ??
    (row.location_state === "FOLLOWING_PLAYER"
      ? "FOLLOW_PLAYER"
      : "NONE");
  return {
    unitId: row.unit_id,
    ownerPlayerId: row.owner_player_id,
    unitType: row.unit_type,
    homeCityId: row.home_city_id,
    currentHp: Number(row.current_hp),
    maxHp: Number(row.max_hp),
    status: row.status,
    locationState: row.location_state,
    stationCityId: row.station_city_id,
    warCampId: row.war_camp_id,
    lat: row.lat === null ? null : Number(row.lat),
    lon: row.lon === null ? null : Number(row.lon),
    groupId: row.group_id,
    nextRecoveryAt: row.next_recovery_at ? new Date(row.next_recovery_at).toISOString() : null,
    nextFireAt: row.next_fire_at ? new Date(row.next_fire_at).toISOString() : null,
    targetFlagId: row.target_flag_id,
    movementOrder,
    movementTarget: movementOrder === "MOVE_TO_COORDINATE" &&
      row.movement_target_lat !== null && row.movement_target_lon !== null
      ? { lat: Number(row.movement_target_lat), lon: Number(row.movement_target_lon) }
      : null,
    packingCompletesAt: row.packing_completes_at ? new Date(row.packing_completes_at).toISOString() : null,
    revision: String(row.revision),
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapGroups(groups: readonly MilitaryUnitGroupRow[], units: readonly MilitaryUnitRow[]): MilitaryUnitGroupSnapshot[] {
  const members = new Map<string, MilitaryUnitRow[]>();
  for (const unit of units) {
    if (!unit.group_id) continue;
    const list = members.get(unit.group_id) ?? [];
    list.push(unit);
    members.set(unit.group_id, list);
  }
  return groups
    .map((group) => {
      const movementOrder = group.movement_order ??
        (group.location_state === "FOLLOWING_PLAYER"
          ? "FOLLOW_PLAYER"
          : "NONE");
      const groupMembers = (members.get(group.group_id) ?? []).sort((left, right) =>
        left.created_at > right.created_at ? 1 : left.created_at < right.created_at ? -1 : left.unit_id.localeCompare(right.unit_id)
      );
      return {
        groupId: group.group_id,
        ownerPlayerId: group.owner_player_id,
        unitType: group.unit_type,
        memberUnitIds: groupMembers.map((unit) => unit.unit_id),
        memberCount: groupMembers.length,
        currentHp: groupMembers.reduce((sum, unit) => sum + Number(unit.current_hp), 0),
        maxHp: groupMembers.reduce((sum, unit) => sum + Number(unit.max_hp), 0),
        locationState: group.location_state,
        stationCityId: group.station_city_id,
        warCampId: group.war_camp_id,
        lat: group.lat === null ? null : Number(group.lat),
        lon: group.lon === null ? null : Number(group.lon),
        targetFlagId: group.target_flag_id,
        targetCityStructureId: group.target_city_structure_id ?? null,
        nextFireAt: group.next_fire_at ? new Date(group.next_fire_at).toISOString() : null,
        packingCompletesAt: group.packing_completes_at ? new Date(group.packing_completes_at).toISOString() : null,
        movementOrder,
        movementTarget: movementOrder === "MOVE_TO_COORDINATE" &&
          group.movement_target_lat !== null && group.movement_target_lon !== null
          ? { lat: Number(group.movement_target_lat), lon: Number(group.movement_target_lon) }
          : null,
        revision: String(group.revision)
      } satisfies MilitaryUnitGroupSnapshot;
    })
    .filter((group) => group.memberCount > 0);
}

function mapWarCamp(row: WarCampRow): WarCampSnapshot {
  return {
    campId: row.camp_id,
    ownerPlayerId: row.owner_player_id,
    worldId: row.world_id,
    regionCode: row.region_code,
    lat: Number(row.lat),
    lon: Number(row.lon),
    placementRevision: String(row.placement_revision),
    builtAt: new Date(row.built_at).toISOString(),
    removedAt: row.removed_at ? new Date(row.removed_at).toISOString() : null,
    relocationAvailableAt: row.relocation_available_at ? new Date(row.relocation_available_at).toISOString() : null,
    ...(row.health !== null && row.health !== undefined
      ? {
          health: Number(row.health),
          maximumHealth: Number(row.maximum_health ?? row.health),
          burningUntil: row.burning_until ? new Date(row.burning_until).toISOString() : null
        }
      : {}),
    ...(row.owner_name ? { ownerName: row.owner_name } : {})
  };
}

function mapJob(row: JobRow, nowMs: number): MilitaryJobSnapshot {
  const completesAt = new Date(row.completes_at).getTime();
  const finished = nowMs >= completesAt;
  return {
    jobId: row.job_id,
    facilityStructureId: row.facility_structure_id,
    ownerPlayerId: row.owner_player_id,
    jobType: row.job_type,
    quantity: Number(row.quantity),
    outputQuantity: Number(row.output_quantity),
    collectedQuantity: Number(row.collected_quantity),
    startedAt: new Date(row.started_at).toISOString(),
    completesAt: new Date(row.completes_at).toISOString(),
    productionFinished: finished,
    readyQuantity: finished ? Math.max(0, Number(row.output_quantity) - Number(row.collected_quantity)) : 0
  };
}

async function requireFacilityForMember(
  client: pg.PoolClient,
  playerId: string,
  structureId: string,
  position: Readonly<{ lat: number; lon: number }>,
  jobType: Exclude<MilitaryJobType, "field_ballista_kit">
): Promise<{ structureId: string; cityId: string; type: MilitaryFacilityType; lat: number; lon: number }> {
  const expectedType: MilitaryFacilityType = jobType === "train_siege_crew"
    || jobType === "train_infantry"
    || jobType === "train_archer"
    ? "barracks"
    : jobType === "train_bomber"
      ? "demolition_factory"
      : jobType === "manufacture_field_ballista"
      ? "demolition_factory"
      : jobType === "repair_kit_batch"
        ? "demolition_factory"
        : "demolition_factory";
  const result = await client.query<{ structureId: string; cityId: string; type: MilitaryFacilityType; lat: number; lon: number }>(
    `SELECT structure.structure_id::text AS "structureId",structure.city_id::text AS city_id,
       structure.city_id::text AS "cityId",structure.structure_type AS type,
       structure.tier,structure.district_type AS "districtType",structure.owner_player_id AS "ownerPlayerId",
       structure.world_id AS "worldId",structure.region_code AS "regionCode",structure.lat,structure.lon,
       structure.footprint_radius_m AS "footprintRadiusM",structure.placement_revision::text AS "placementRevision",
       structure.state,structure.construction_started_at AS "constructionStartedAt",
       structure.construction_completes_at AS "constructionCompletesAt",structure.built_at AS "builtAt",
       structure.upgraded_at AS "upgradedAt",structure.destroyed_at AS "destroyedAt"
     FROM city_structures structure
     JOIN cities city ON city.id=structure.city_id AND city.active
     JOIN city_memberships membership ON membership.city_id=city.id AND membership.player_id=$2 AND membership.left_at IS NULL
     WHERE structure.structure_id=$1::uuid
       AND structure.structure_type=$3
       AND structure.state='active'
       AND (structure.owner_player_id=$2 OR structure.owner_player_id IS NULL)
     FOR SHARE OF structure,city,membership`,
    [structureId, playerId, expectedType]
  );
  const row = result.rows[0];
  if (!row) throw new MilitaryIndustryError("MILITARY_ACCESS_DENIED", "Only the owner may use this personal military facility.");
  const distance = distanceMeters(position, { lat: Number(row.lat), lon: Number(row.lon) });
  if (distance > LODGE_INTERACTION_RADIUS_M) {
    throw new MilitaryIndustryError("MILITARY_FACILITY_PROXIMITY_REQUIRED", `Move within ${LODGE_INTERACTION_RADIUS_M} meters of the facility.`);
  }
  return row;
}

async function requirePersonalTerritory(
  client: pg.PoolClient,
  playerId: string,
  position: Readonly<{ lat: number; lon: number }>
): Promise<void> {
  const result = await client.query<{ covered: boolean }>(
    `WITH proposed AS (
       SELECT ST_Buffer(ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,$3)::geometry AS geom
     )
     SELECT EXISTS (
       SELECT 1 FROM flags flag,proposed
       WHERE flag.owner_id=$4 AND flag.city_id IS NULL AND flag.control_type='personal'
         AND ST_Covers(ST_Buffer(flag.geom::geography,flag.claim_radius_m)::geometry,proposed.geom)
     ) AS covered`,
    [position.lat, position.lon, LODGE_FOOTPRINT_RADIUS_M, playerId]
  );
  if (!result.rows[0]?.covered) {
    throw new MilitaryIndustryError("LODGE_PERSONAL_TERRITORY_REQUIRED", "Place the Lodge fully inside your personal territory.");
  }
}

async function requireLodgeClearance(
  client: pg.PoolClient,
  worldId: string,
  regionCode: string,
  position: Readonly<{ lat: number; lon: number }>,
  anchor: Readonly<{ lat: number; lon: number }>,
  moveLeashRadiusM: number
): Promise<void> {
  if (distanceMeters(position, anchor) > moveLeashRadiusM) {
    throw new MilitaryIndustryError("LODGE_PLACEMENT_RANGE_REQUIRED", "Move closer before placing your Lodge.");
  }
  const result = await client.query<{ lat: number; lon: number }>(
    `SELECT lat,lon FROM player_lodges WHERE world_id=$1 AND region_code=$2 AND removed_at IS NULL
     UNION ALL SELECT lat,lon FROM player_furnaces WHERE world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM player_tanneries WHERE world_id=$1 AND region_code=$2 AND removed_at IS NULL
     UNION ALL SELECT lat,lon FROM player_kitchens WHERE world_id=$1 AND region_code=$2 AND removed_at IS NULL
     UNION ALL SELECT lat,lon FROM city_structures WHERE world_id=$1 AND region_code=$2 AND state IN ('constructing','active')`,
    [worldId, regionCode]
  );
  if (result.rows.some((row) => distanceMeters(position, { lat: Number(row.lat), lon: Number(row.lon) }) < 30)) {
    throw new MilitaryIndustryError("LODGE_CLEARANCE_REQUIRED", "Outdoor structures must be at least 30 meters apart.");
  }
}

async function reserveLodgeOperation(
  client: pg.PoolClient,
  input: Readonly<{
    operationKey: string;
    playerId: string;
    requestId: string;
    action: "build" | "upgrade" | "destroy";
    requestHash: string;
    lodgeId: string;
  }>
): Promise<void> {
  const result = await client.query(
    `INSERT INTO military_lodge_operations (operation_key,player_id,request_id,action,request_hash,lodge_id)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (player_id,request_id) DO NOTHING RETURNING operation_key`,
    [input.operationKey, input.playerId, input.requestId, input.action, input.requestHash, input.lodgeId]
  );
  if (!result.rowCount) throw new MilitaryIndustryError("LODGE_REPLAY_CONFLICT", "That Lodge request is already in progress.");
}

async function completeLodgeOperation(
  client: pg.PoolClient,
  operationKey: string,
  result: { lodge: LodgeSnapshot | null }
): Promise<void> {
  await client.query(
    `UPDATE military_lodge_operations SET result=$2::jsonb,completed_at=clock_timestamp() WHERE operation_key=$1`,
    [operationKey, JSON.stringify(result)]
  );
}

async function lockPlayerMilitaryChannel(client: pg.PoolClient, playerId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`military-industry-player:${playerId}`]);
}

async function hasCompatibleMilitaryAnchor(
  client: pg.PoolClient,
  worldId: string,
  input: MilitaryTravelInput
): Promise<boolean> {
  if (input.destinationKind === "city" && input.destinationId && isUuid(input.destinationId)) {
    const city = await client.query(
      `SELECT 1
       FROM cities city
       JOIN city_memberships membership
         ON membership.city_id=city.id
        AND membership.player_id=$1
        AND membership.world_id=$3
        AND membership.left_at IS NULL
       WHERE city.id=$2::uuid AND city.world_id=$3 AND city.active
       LIMIT 1`,
      [input.playerId, input.destinationId, worldId]
    );
    if (city.rowCount) return true;
  }
  if (input.destinationKind !== "world") return false;
  const camp = await client.query(
    `SELECT 1 FROM war_camps
     WHERE owner_player_id=$1 AND world_id=$4 AND removed_at IS NULL
       AND ABS(lat-$2) < 0.0000001 AND ABS(lon-$3) < 0.0000001
     LIMIT 1`,
    [
      input.playerId,
      input.destinationCenter.lat,
      input.destinationCenter.lon,
      worldId
    ]
  );
  return Boolean(camp.rowCount);
}

function requireQuantity(jobType: Exclude<MilitaryJobType, "field_ballista_kit">, quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new MilitaryIndustryError("MILITARY_INVALID_QUANTITY", "Choose a positive production quantity.");
  if (jobType === "train_siege_crew" && quantity !== 1) throw new MilitaryIndustryError("MILITARY_INVALID_QUANTITY", "Train one Siege Crew at a time.");
  if (["train_infantry", "train_archer", "train_bomber", "manufacture_field_ballista"].includes(jobType) && quantity !== 1) {
    throw new MilitaryIndustryError("MILITARY_INVALID_QUANTITY", "Train one underlying military unit at a time.");
  }
  if (jobType === "repair_kit_batch" && quantity > ARMORY_REPAIR_KIT_MAX_BATCH) throw new MilitaryIndustryError("MILITARY_INVALID_QUANTITY", `Demolition Factory batches are limited to ${ARMORY_REPAIR_KIT_MAX_BATCH}.`);
  if (jobType === "torch_batch" && quantity > POWDER_WORKS_TORCH_MAX_BATCH) throw new MilitaryIndustryError("MILITARY_INVALID_QUANTITY", `Demolition Factory batches are limited to ${POWDER_WORKS_TORCH_MAX_BATCH}.`);
  return quantity;
}

function requireRequestId(requestId: string): void {
  if (!requestId || requestId.length > 128) throw new MilitaryIndustryError("MILITARY_INVALID_REQUEST", "A valid request ID is required.");
}

function requirePosition(position: Readonly<{ lat: number; lon: number }>): void {
  if (!Number.isFinite(position.lat) || !Number.isFinite(position.lon)) throw new MilitaryIndustryError("MILITARY_INVALID_POSITION", "Your world position is unavailable.");
}

function requireWorldPosition(position: Readonly<{ lat: number; lon: number }>): void {
  if (
    !Number.isFinite(position.lat) ||
    !Number.isFinite(position.lon) ||
    position.lat < -90 ||
    position.lat > 90 ||
    position.lon < -180 ||
    position.lon > 180
  ) {
    throw new MilitaryIndustryError("MILITARY_INVALID_POSITION", "The planned military position is invalid.");
  }
}

function unitTypeForJob(jobType: MilitaryJobType): MilitaryUnitType | null {
  switch (jobType) {
    case "train_infantry": return "infantry";
    case "train_archer": return "archer";
    case "train_bomber": return "bomber";
    case "manufacture_field_ballista": return "field_ballista";
    default: return null;
  }
}

function hashRequest(action: string, ...parts: Array<string | number>): string {
  return createHash("sha256").update(JSON.stringify([action, ...parts])).digest("hex");
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new MilitaryIndustryError("MILITARY_CONFLICT", message);
  return row;
}

function translateMilitaryError(error: unknown): unknown {
  if (error instanceof MilitaryIndustryError) return error;
  if (error instanceof CityStructureError || error instanceof CityStructureWarfareError) {
    return new MilitaryIndustryError(error.code, error.message);
  }
  if (error instanceof CombatRequestError) {
    return new MilitaryIndustryError(error.code, error.message);
  }
  if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
    return new MilitaryIndustryError("MILITARY_GOLD_REQUIRED", "You do not have enough Gold.");
  }
  if (error instanceof Error && /enough items|insufficient/i.test(error.message)) {
    return new MilitaryIndustryError("MILITARY_MATERIALS_REQUIRED", "You do not have the required materials.");
  }
  return error;
}

type LockedMilitaryGroup = Readonly<{
  group: MilitaryUnitGroupRow;
  members: MilitaryUnitRow[];
}>;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function uniqueIds(values: readonly string[]): string[] {
  const result = [...new Set(values)];
  if (result.some((value) => !isUuid(value))) throw new MilitaryIndustryError("MILITARY_INVALID_ID", "A military group identifier is invalid.");
  return result;
}

async function resolveMilitaryGroupAnchor(
  client: pg.PoolClient,
  group: MilitaryUnitGroupRow
): Promise<LatLon | null> {
  if (
    group.lat !== null && group.lon !== null &&
    Number.isFinite(Number(group.lat)) && Number.isFinite(Number(group.lon))
  ) {
    return { lat: Number(group.lat), lon: Number(group.lon) };
  }
  if (group.station_city_id) {
    const city = await client.query<{ lat: number; lon: number }>(
      `SELECT hall_lat AS lat,hall_lon AS lon FROM cities WHERE id=$1::uuid AND active`,
      [group.station_city_id]
    );
    const row = city.rows[0];
    if (row && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon))) {
      return { lat: Number(row.lat), lon: Number(row.lon) };
    }
  }
  if (group.war_camp_id) {
    const camp = await client.query<{ lat: number; lon: number }>(
      `SELECT lat,lon FROM war_camps WHERE camp_id=$1::uuid AND removed_at IS NULL`,
      [group.war_camp_id]
    );
    const row = camp.rows[0];
    if (row && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon))) {
      return { lat: Number(row.lat), lon: Number(row.lon) };
    }
  }
  return null;
}

/**
 * Authorize an owned group against the player's current authoritative view.
 * Command authority is intentionally scope-based rather than a short player
 * proximity leash: the player may command any own visible group, while the
 * server still rejects groups outside the current gameplay vision.
 */
async function requireMilitaryGroupCommandScope(
  client: pg.PoolClient,
  group: MilitaryUnitGroupRow,
  player: MilitaryCommandPlayer
): Promise<void> {
  let anchor = group.lat !== null && group.lon !== null
    ? { lat: Number(group.lat), lon: Number(group.lon) }
    : null;
  if (!anchor && group.station_city_id) {
    const city = await client.query<{ lat: number; lon: number }>(
      `SELECT hall_lat AS lat,hall_lon AS lon FROM cities WHERE id=$1::uuid AND active`,
      [group.station_city_id]
    );
    const row = city.rows[0];
    if (row) anchor = { lat: Number(row.lat), lon: Number(row.lon) };
  }
  if (!anchor && group.war_camp_id) {
    const camp = await client.query<{ lat: number; lon: number }>(
      `SELECT lat,lon FROM war_camps WHERE camp_id=$1::uuid AND removed_at IS NULL`,
      [group.war_camp_id]
    );
    const row = camp.rows[0];
    if (row) anchor = { lat: Number(row.lat), lon: Number(row.lon) };
  }
  const viewCenter = player.resourceVision?.center ?? player.anchor ?? player.position;
  const radiusM = player.resourceVision?.radiusM ?? DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M;
  if (!anchor || !isFiniteLatLon(anchor.lat, anchor.lon) ||
      !isFiniteLatLon(viewCenter.lat, viewCenter.lon) ||
      !Number.isFinite(radiusM) || radiusM <= 0 ||
      distanceMeters(viewCenter, anchor) > radiusM) {
    throw new MilitaryIndustryError(
      "MILITARY_GROUP_OUT_OF_SCOPE",
      "The military group is outside your current vision."
    );
  }
}

/** Resolve the formation point behind a player. While moving, the player's
 * current target supplies the forward bearing; while stationary, the current
 * group coordinate keeps a single group's formation side deterministic. */
function followPositionForPlayer(
  playerPosition: Readonly<{ lat: number; lon: number }>,
  playerTarget: Readonly<{ lat: number; lon: number }> | null,
  currentGroupPosition: Readonly<{ lat: number; lon: number }> | null
): { lat: number; lon: number } {
  const trailingBearing = trailingBearingForPlayer(playerPosition, playerTarget, currentGroupPosition);
  return destinationPoint(playerPosition, MILITARY_FOLLOW_DISTANCE_M, trailingBearing);
}

/** Compute one stable, non-overlapping slot per owner's sorted group list. */
function followFormationPositionForPlayer(
  playerPosition: Readonly<{ lat: number; lon: number }>,
  playerTarget: Readonly<{ lat: number; lon: number }> | null,
  slotIndex: number
): { lat: number; lon: number } {
  const trailingBearing = trailingBearingForPlayer(playerPosition, playerTarget, null);
  const center = destinationPoint(playerPosition, MILITARY_FOLLOW_DISTANCE_M, trailingBearing);
  const index = Math.max(0, Math.floor(slotIndex));
  if (index === 0) return center;
  const lateralDistance = Math.ceil(index / 2) * MILITARY_FOLLOW_FORMATION_SPACING_M;
  const lateralBearing = (trailingBearing + (index % 2 === 1 ? 90 : -90) + 360) % 360;
  return destinationPoint(center, lateralDistance, lateralBearing);
}

function trailingBearingForPlayer(
  playerPosition: Readonly<{ lat: number; lon: number }>,
  playerTarget: Readonly<{ lat: number; lon: number }> | null,
  currentGroupPosition: Readonly<{ lat: number; lon: number }> | null
): number {
  const travelDistance = playerTarget && isFiniteLatLon(playerTarget.lat, playerTarget.lon)
    ? distanceMeters(playerPosition, playerTarget)
    : 0;
  if (travelDistance > 0.01) return (bearingDegrees(playerPosition, playerTarget!) + 180) % 360;
  if (currentGroupPosition && isFiniteLatLon(currentGroupPosition.lat, currentGroupPosition.lon) &&
      distanceMeters(playerPosition, currentGroupPosition) > 0.01) {
    return bearingDegrees(playerPosition, currentGroupPosition);
  }
  return 180;
}

async function requireMilitaryCityCommandRange(
  client: pg.PoolClient,
  cityId: string,
  playerPosition: Readonly<{ lat: number; lon: number }>
): Promise<void> {
  const city = await client.query<{ lat: number; lon: number }>(
    `SELECT hall_lat AS lat,hall_lon AS lon FROM cities WHERE id=$1::uuid AND active`,
    [cityId]
  );
  const row = city.rows[0];
  if (!row || distanceMeters(playerPosition, { lat: Number(row.lat), lon: Number(row.lon) }) > MILITARY_UNIT_INTERACTION_RADIUS_M) {
    throw new MilitaryIndustryError(
      "MILITARY_CITY_OUT_OF_RANGE",
      `Move within ${MILITARY_UNIT_INTERACTION_RADIUS_M} meters of the home City before returning the group.`
    );
  }
}

async function requireMilitaryUnitStationRange(
  client: pg.PoolClient,
  unit: MilitaryUnitRow,
  playerPosition: Readonly<{ lat: number; lon: number }>
): Promise<void> {
  let anchor = unit.lat !== null && unit.lon !== null
    ? { lat: Number(unit.lat), lon: Number(unit.lon) }
    : null;
  if (!anchor && unit.station_city_id) {
    const city = await client.query<{ lat: number; lon: number }>(
      `SELECT hall_lat AS lat,hall_lon AS lon FROM cities WHERE id=$1::uuid AND active`,
      [unit.station_city_id]
    );
    const row = city.rows[0];
    if (row) anchor = { lat: Number(row.lat), lon: Number(row.lon) };
  }
  if (!anchor || distanceMeters(playerPosition, anchor) > MILITARY_UNIT_INTERACTION_RADIUS_M) {
    throw new MilitaryIndustryError(
      "MILITARY_REPAIR_OUT_OF_RANGE",
      `Move within ${MILITARY_UNIT_INTERACTION_RADIUS_M} meters of the Ballista station before repairing it.`
    );
  }
}

async function pauseBallistaGroup(client: pg.PoolClient, groupId: string): Promise<void> {
  await client.query(
    `UPDATE military_units
     SET target_flag_id=NULL,next_fire_at=NULL,revision=revision+1,updated_at=clock_timestamp()
     WHERE group_id=$1::uuid`,
    [groupId]
  );
  await client.query(
    `UPDATE military_unit_groups
     SET target_flag_id=NULL,target_city_structure_id=NULL,next_fire_at=NULL,revision=revision+1,updated_at=clock_timestamp()
     WHERE group_id=$1::uuid`,
    [groupId]
  );
}

async function cancelFlagOperationsForDestruction(
  client: pg.PoolClient,
  flagId: string,
  excludedOperationKey?: string
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
    `UPDATE military_siege_operations
     SET status='cancelled',completed_at=clock_timestamp()
     WHERE flag_id=$1::uuid AND action='demolish_flag' AND status='pending'
       AND ($2::text IS NULL OR operation_key<>$2)`,
    [flagId, excludedOperationKey ?? null]
  );
}

async function clearMilitaryFlagTargetReferencesInTransaction(
  client: pg.PoolClient,
  flagId: string
): Promise<void> {
  await client.query(
    `UPDATE military_units
     SET target_flag_id=NULL,next_fire_at=NULL,revision=revision+1,updated_at=clock_timestamp()
     WHERE target_flag_id=$1::uuid`,
    [flagId]
  );
  await client.query(
    `UPDATE military_unit_groups
     SET target_flag_id=NULL,next_fire_at=NULL,revision=revision+1,updated_at=clock_timestamp()
     WHERE target_flag_id=$1::uuid`,
    [flagId]
  );
}

async function replayMilitaryOperation(
  client: pg.PoolClient,
  playerId: string,
  requestId: string,
  action: string,
  requestHash: string
): Promise<{ result: Record<string, unknown> | null } | null> {
  const result = await client.query<{ action: string; request_hash: string; result: Record<string, unknown> | null; completed_at: Date | string | null }>(
    `SELECT action,request_hash,result,completed_at
     FROM military_unit_operations WHERE player_id=$1 AND request_id=$2 FOR UPDATE`,
    [playerId, requestId]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.action !== action || row.request_hash !== requestHash || !row.completed_at || !row.result) {
    throw new MilitaryIndustryError("MILITARY_REPLAY_CONFLICT", "That military request ID was already used for different work.");
  }
  return { result: row.result };
}

async function reserveMilitaryOperation(
  client: pg.PoolClient,
  operationKey: string,
  playerId: string,
  requestId: string,
  action: string,
  requestHash: string
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO military_unit_operations (operation_key,player_id,request_id,action,request_hash)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (player_id,request_id) DO NOTHING RETURNING operation_key`,
    [operationKey, playerId, requestId, action, requestHash]
  );
  if (inserted.rowCount !== 1) throw new MilitaryIndustryError("MILITARY_REPLAY_CONFLICT", "That military request is already in progress.");
}

async function completeMilitaryOperation(
  client: pg.PoolClient,
  operationKey: string,
  result: Record<string, unknown>
): Promise<void> {
  await client.query(
    `UPDATE military_unit_operations SET result=$2::jsonb,completed_at=clock_timestamp() WHERE operation_key=$1`,
    [operationKey, JSON.stringify(result)]
  );
}

async function existingSiegeOperation(
  client: pg.PoolClient,
  playerId: string,
  requestId: string,
  action: "bomber_breach" | "demolish_flag" | "ballista_volley",
  requestHash: string
): Promise<{
  damage: number;
  affectedFlagIds: readonly string[];
  consumedUnitId: string | null;
  status: "pending" | "complete" | "cancelled";
} | null> {
  const result = await client.query<{
    action: string;
    group_id: string;
    flag_id: string;
    damage: number;
    target_results: unknown;
    consumed_unit_id: string | null;
    status: "pending" | "complete" | "cancelled";
  }>(
    `SELECT action,group_id::text,flag_id::text,damage,target_results,consumed_unit_id::text,status
     FROM military_siege_operations WHERE player_id=$1 AND request_id=$2 FOR UPDATE`,
    [playerId, requestId]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.action !== action) throw new MilitaryIndustryError("MILITARY_REPLAY_CONFLICT", "That siege request ID was already used for different work.");
  // The operation key includes the request hash so a replay cannot mutate a
  // different target even if the caller reuses a request ID.
  const expected = hashRequest(action, playerId, row.group_id, row.flag_id);
  if (expected !== requestHash) throw new MilitaryIndustryError("MILITARY_REPLAY_CONFLICT", "That siege request ID was already used for different work.");
  return {
    damage: Number(row.damage),
    affectedFlagIds: siegeVolleyFlagIds(row.target_results, row.flag_id, Number(row.damage)),
    consumedUnitId: row.consumed_unit_id,
    status: row.status
  };
}

function siegeVolleyFlagIds(value: unknown, fallbackFlagId: string, damage: number): readonly string[] {
  if (Array.isArray(value)) {
    const ids = value
      .filter((entry): entry is { flagId?: unknown } => Boolean(entry) && typeof entry === "object")
      .map((entry) => entry.flagId)
      .filter((flagId): flagId is string => typeof flagId === "string" && flagId.length > 0);
    if (ids.length > 0) return [...new Set(ids)];
  }
  return damage > 0 && fallbackFlagId ? [fallbackFlagId] : [];
}

async function cancelPendingBomberChannelsForGroup(
  client: pg.PoolClient,
  groupId: string,
  playerId: string
): Promise<void> {
  await client.query(
    `UPDATE military_siege_operations
     SET status='cancelled',completed_at=clock_timestamp()
     WHERE group_id=$1::uuid AND player_id=$2 AND action='demolish_flag' AND status='pending'`,
    [groupId, playerId]
  );
}

function compareMilitaryMembers(left: MilitaryUnitRow, right: MilitaryUnitRow): number {
  const leftCreated = new Date(left.created_at).getTime();
  const rightCreated = new Date(right.created_at).getTime();
  return leftCreated - rightCreated || left.unit_id.localeCompare(right.unit_id);
}

function memberRevisionSnapshot(members: readonly MilitaryUnitRow[]): Record<string, string> {
  return Object.fromEntries(
    members
      .slice()
      .sort(compareMilitaryMembers)
      .map((member) => [member.unit_id, String(member.revision)])
  );
}

function sameMemberRevisions(members: readonly MilitaryUnitRow[], expected: Record<string, string | number> | null): boolean {
  if (!expected || typeof expected !== "object") return false;
  const actual = memberRevisionSnapshot(members);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  return expectedKeys.length === actualKeys.length &&
    expectedKeys.every((key, index) => key === actualKeys[index] && String(expected[key]) === actual[key]);
}

async function deleteBomberFlagInTransaction(
  client: pg.PoolClient,
  flagId: string,
  bomberPlayerId: string
): Promise<BomberFlagDeletion> {
  await lockFlagControlGeometry(client);
  const organizationStrike = await applyOrganizationBomberStrikeInTransaction(client, flagId, bomberPlayerId);
  if (organizationStrike?.kind === "invalid") {
    throw new MilitaryIndustryError("MILITARY_FLAG_TARGET_INVALID", organizationStrike.message);
  }
  if (organizationStrike) {
    return { flagId, affectedFlagIds: [flagId], notificationPlayerIds: organizationStrike.notificationPlayerIds };
  }
  const legendary = await client.query(
    `SELECT 1 FROM legendary_bird_events
     WHERE flag_id=$1::uuid AND status IN ('pending','active') LIMIT 1`,
    [flagId]
  );
  if (legendary.rowCount) {
    throw new MilitaryIndustryError("MILITARY_FLAG_TARGET_INVALID", "This Flag cannot be demolished while its legendary encounter is available.");
  }
  const locked = await client.query<{
    owner_id: string;
    reinforcement_level: number;
    tower_level: number | null;
    obelisk_level?: number | null;
    war_structure_kind?: string | null;
    health: number | null;
    maximum_health: number | null;
    lat: number;
    lon: number;
  }>(
    `SELECT owner_id,reinforcement_level,tower_level,obelisk_level,war_structure_kind,health,maximum_health,lat,lon
     FROM flags WHERE id=$1::uuid FOR UPDATE`,
    [flagId]
  );
  const flag = locked.rows[0];
  const expectedHealth = flag
    ? structureWarfareHealthForReinforcementLevel(Number(flag.reinforcement_level), flag.tower_level)
    : null;
  if (
    !flag || expectedHealth === null || flag.health === null || flag.maximum_health === null ||
    Number(flag.maximum_health) !== expectedHealth ||
    Number(flag.health) <= 0
  ) {
    throw new MilitaryIndustryError("MILITARY_FLAG_TARGET_INVALID", "Only another player's ordinary personal Flag can be demolished.");
  }
  const repairing = await hasActiveRepair(client, flagId);
  const bombDamage = await monolithAdjustedBuildingDamage(
    client,
    STRUCTURE_WARFARE_BOMBER_DAMAGE * (repairing ? STRUCTURE_WARFARE_REPAIRING_DAMAGE_MULTIPLIER : 1),
    { attacker: null, target: { ...flag, city_id: null, kingdom_id: null } }
  );
  const damaged = await client.query<{ owner_id: string; health: number; damage_cycle_id: string | null }>(
    `UPDATE flags
     SET health=GREATEST(0,health-$2::integer),
         damage_cycle_id=COALESCE(damage_cycle_id,gen_random_uuid())
     WHERE id=$1::uuid AND control_type='personal'
       AND (owner_id<>$3 OR developer_test_target)
       AND anchor_kind IN ('flag','buoy') AND system_controlled=false
       AND city_id IS NULL AND kingdom_id IS NULL
       AND (burning_reason IS NULL OR $5::boolean) AND maximum_health=$4::integer
       AND health IS NOT NULL AND health > 0
     RETURNING owner_id,health,damage_cycle_id::text`,
    [
      flagId,
      bombDamage,
      bomberPlayerId,
      expectedHealth,
      repairing
    ]
  );
  const row = damaged.rows[0];
  if (!row) throw new MilitaryIndustryError("MILITARY_FLAG_TARGET_INVALID", "The Flag changed before it could be damaged.");
  if (!repairing) {
    await ensureDamageTriggeredBurnInTransaction(client, {
      attackerPlayerId: bomberPlayerId,
      structureId: flagId,
      damageCycleId: row.damage_cycle_id
    });
  }
  if (Number(row.health) > 0) {
    return { flagId, affectedFlagIds: [flagId], notificationPlayerIds: [row.owner_id] };
  }
  // Keep the fallback path aligned with FlagService's canonical destruction
  // lifecycle when this service is used without an injected FlagService.
  await client.query(
    `UPDATE flag_repair_disrupt_operations
     SET status='cancelled',cancel_reason='flag-destroyed',completed_at=now()
     WHERE flag_id=$1 AND status='active'`,
    [flagId]
  );
  await client.query(
    `UPDATE flag_repair_operations
     SET status='cancelled',cancel_reason='flag-destroyed',completed_at=now()
     WHERE flag_id=$1 AND status='active'`,
    [flagId]
  );
  await client.query(
    `UPDATE flag_burn_operations
     SET status='cancelled',cancel_reason='flag-destroyed',completed_at=now(),paused_at=NULL
     WHERE flag_id=$1 AND status='active'`,
    [flagId]
  );
  await client.query(
    "UPDATE flags SET burning_started_at=NULL,burning_until=NULL,burning_reason=NULL WHERE id=$1::uuid",
    [flagId]
  );
  const deleted = await client.query<{ owner_id: string }>(
    `DELETE FROM flags
     WHERE id=$1::uuid AND control_type='personal'
       AND (owner_id<>$2 OR developer_test_target)
       AND anchor_kind IN ('flag','buoy') AND system_controlled=false
       AND city_id IS NULL AND kingdom_id IS NULL
       AND reinforcement_level IN (0,1,2,3)
       AND burning_reason IS NULL AND health=0 AND maximum_health=$3::integer
     RETURNING owner_id`,
    [flagId, bomberPlayerId, expectedHealth]
  );
  if (!deleted.rows[0]) throw new MilitaryIndustryError("MILITARY_FLAG_TARGET_INVALID", "The Flag changed before it could be demolished.");
  return { flagId, affectedFlagIds: [], notificationPlayerIds: [row.owner_id] };
}

async function lockGroupWithMembers(
  client: pg.PoolClient,
  playerId: string | null,
  groupId: string
): Promise<LockedMilitaryGroup | null> {
  if (!isUuid(groupId)) return null;
  const groupResult = await client.query<MilitaryUnitGroupRow>(
    `SELECT group_id::text,owner_player_id,unit_type,location_state,station_city_id::text,
       war_camp_id::text,lat,lon,target_flag_id::text,movement_order,
       movement_target_lat,movement_target_lon,next_fire_at,packing_completes_at,revision::text,created_at,
           target_city_structure_id::text
     FROM military_unit_groups
     WHERE group_id=$1::uuid AND ($2::text IS NULL OR owner_player_id=$2)
     FOR UPDATE`,
    [groupId, playerId]
  );
  const group = groupResult.rows[0];
  if (!group) return null;
  const members = await client.query<MilitaryUnitRow>(
    `SELECT unit_id::text,owner_player_id,unit_type,home_city_id::text,current_hp,max_hp,status,
       location_state,station_city_id::text,war_camp_id::text,lat,lon,group_id::text,
       next_recovery_at,next_fire_at,target_flag_id::text,movement_order,
       movement_target_lat,movement_target_lon,packing_completes_at,
       revision::text,created_at
     FROM military_units WHERE group_id=$1::uuid AND owner_player_id=$2 FOR UPDATE`,
    [groupId, group.owner_player_id]
  );
  return { group, members: members.rows };
}

type SiegeTargetRow = Readonly<{
  id: string;
  owner_id: string;
  control_type: string;
  anchor_kind: string;
  system_controlled: boolean;
  city_id: string | null;
  kingdom_id: string | null;
  reinforcement_level: number;
  tower_level: number | null;
  obelisk_level?: number | null;
  war_structure_kind?: string | null;
  health: number;
  maximum_health: number;
  lat: number;
  lon: number;
  burning_reason: string | null;
  damage_cycle_id: string | null;
  developer_test_target?: boolean;
  developer_test_creator_id?: string | null;
  territory_collapse_id?: string | null;
  name?: string;
}>;

async function lockBomberTarget(
  client: pg.PoolClient,
  flagId: string,
  playerId: string,
  playerPosition?: Readonly<{ lat: number; lon: number }>
): Promise<SiegeTargetRow> {
  const result = await client.query<SiegeTargetRow>(
    `SELECT flags.id::text AS id,owner_id,control_type,anchor_kind,system_controlled,city_id::text,kingdom_id::text,
       reinforcement_level,tower_level,obelisk_level,war_structure_kind,health,maximum_health,lat,lon,burning_reason,damage_cycle_id::text,
       developer_test_target,test.creator_player_id AS developer_test_creator_id,
       territory_collapse_id::text,name
     FROM flags
     LEFT JOIN developer_spawned_test_flags test ON test.flag_id=flags.id
     WHERE flags.id=$1::uuid FOR UPDATE OF flags`,
    [flagId]
  );
  const flag = result.rows[0];
  const organizations = flag && organizationOfFlag(flag) ? await loadPlayerOrganizations(client, playerId) : null;
  if (organizations && flag && isAlliedOrganizationStructure(organizations, flag)) {
    throw new MilitaryIndustryError("MILITARY_FLAG_TARGET_ALLY", "You cannot bomb a structure of your own city or kingdom.");
  }
  if (!flag || !(organizations ? isEligibleOrganizationTarget(flag, organizations) : isEligibleBomberTarget(flag, playerId))) {
    throw new MilitaryIndustryError("MILITARY_FLAG_TARGET_INVALID", "Only another player's Flag or a hostile city or kingdom structure can be targeted.");
  }
  if (flag.burning_reason !== null && !(flag.burning_reason === "flag_burn" && await hasActiveRepair(client, flag.id))) {
    throw new MilitaryIndustryError("MILITARY_FLAG_BURNING", "A Flag cannot be targeted while it is burning.");
  }
  if (playerPosition && distanceMeters(playerPosition, { lat: Number(flag.lat), lon: Number(flag.lon) }) > MILITARY_UNIT_INTERACTION_RADIUS_M) {
    throw new MilitaryIndustryError("MILITARY_FLAG_OUT_OF_RANGE", "The military unit must be within charge range of the target.");
  }
  return flag;
}

/** Locks and validates a hostile, bombable city building within Bomber charge range. */
async function lockBomberCityBuilding(
  client: pg.PoolClient,
  structureId: string,
  playerId: string,
  bomberPosition?: Readonly<{ lat: number; lon: number }>
): Promise<Readonly<{ lat: number; lon: number }>> {
  return asMilitaryError(async () => {
    const target = await requireHostileCityBuildingInTransaction(
      client,
      await lockCityBuildingInTransaction(client, structureId),
      playerId
    );
    requireBombableCityBuilding(target);
    if (
      bomberPosition &&
      distanceMeters(bomberPosition, target.position) >
        MILITARY_UNIT_INTERACTION_RADIUS_M + Number(target.row.footprint_radius_m)
    ) {
      throw new MilitaryIndustryError("MILITARY_FLAG_OUT_OF_RANGE", "The military unit must be within charge range of the target.");
    }
    return target.position;
  });
}

/** City building warfare refusals surface as military errors (cancel the channel, keep the transaction). */
async function asMilitaryError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CityStructureWarfareError) throw new MilitaryIndustryError(error.code, error.message);
    throw error;
  }
}

async function lockSiegeTargetsWithinRange(
  client: pg.PoolClient,
  group: MilitaryUnitGroupRow,
  playerId: string | null,
  selectedFlagId: string
): Promise<Readonly<{
  selectedTarget: SiegeTargetRow | null;
  targets: readonly SiegeTargetRow[];
}>> {
  if (
    group.lat === null || group.lon === null ||
    !Number.isFinite(Number(group.lat)) || !Number.isFinite(Number(group.lon))
  ) {
    throw new MilitaryIndustryError("MILITARY_INVALID_POSITION", "The Siege group has no valid field position.");
  }
  const result = await client.query<SiegeTargetRow>(
    `WITH query_point AS (
       SELECT ST_SetSRID(ST_MakePoint($1,$2),4326)::geography AS geog
     )
     SELECT flags.id::text AS id,owner_id,control_type,anchor_kind,system_controlled,
            city_id::text,kingdom_id::text,reinforcement_level,tower_level,obelisk_level,war_structure_kind,health,maximum_health,
            lat,lon,burning_reason,damage_cycle_id::text,
            developer_test_target,test.creator_player_id AS developer_test_creator_id,
            territory_collapse_id::text,name
     FROM flags
     LEFT JOIN developer_spawned_test_flags test ON test.flag_id=flags.id
     CROSS JOIN query_point
     WHERE ST_DWithin(
       flags.geom::geography,
       query_point.geog,
       $3::double precision
     ) OR flags.id=$4::uuid
     ORDER BY flags.id
     FOR UPDATE OF flags`,
    [
      Number(group.lon),
      Number(group.lat),
      // PostGIS geography uses the WGS84 ellipsoid while the shared gameplay
      // distance helper uses the canonical spherical calculation. Query a
      // small superset, then apply the shared inclusive boundary below.
      SIEGE_ATTACK_RANGE_METERS + 5,
      selectedFlagId
    ]
  );
  const targets = result.rows.filter((flag) => {
    const eligible = isEligibleSiegeTarget(flag, playerId);
    const distance = distanceMeters(
      { lat: Number(group.lat), lon: Number(group.lon) },
      { lat: Number(flag.lat), lon: Number(flag.lon) }
    );
    return eligible && isWithinSiegeAttackRange(distance);
  });
  return {
    selectedTarget: result.rows.find((flag) => flag.id === selectedFlagId) ?? null,
    targets
  };
}

function isEligibleSiegeTarget(flag: SiegeTargetRow, playerId: string | null): boolean {
  // The fixture's raw creator owner is retained for lifecycle cleanup only.
  // Marked test targets use the dedicated hostile presentation identity and
  // are therefore valid targets for any combatant, including their creator.
  const isDeveloperTestTarget = flag.developer_test_target === true;
  return flag.control_type === "personal" &&
    flag.anchor_kind === "flag" &&
    !flag.system_controlled &&
    flag.city_id === null &&
    flag.kingdom_id === null &&
    (playerId === null || flag.owner_id !== playerId || isDeveloperTestTarget) &&
    Number(flag.reinforcement_level) === 3 &&
    flag.health !== null &&
    Number(flag.health) > 0 &&
    flag.maximum_health !== null &&
    Number(flag.maximum_health) === structureWarfareHealthForReinforcementLevel(Number(flag.reinforcement_level), flag.tower_level);
}

/**
 * A hostile city or kingdom structure (never one of the player's own
 * organizations, never system-controlled or collapsing territory).
 */
function isEligibleOrganizationTarget(flag: SiegeTargetRow, organizations: PlayerOrganizations): boolean {
  const profile = warfareProfileForRow(flag);
  return Boolean(profile?.organization) &&
    (flag.territory_collapse_id ?? null) === null &&
    !isAlliedOrganizationStructure(organizations, flag) &&
    flag.health !== null && Number(flag.health) > 0 &&
    Number(flag.maximum_health) === profile!.maximumHealth;
}

function isEligibleBomberTarget(flag: SiegeTargetRow, playerId: string): boolean {
  const isDeveloperTestTarget = flag.developer_test_target === true;
  return flag.control_type === "personal" &&
    (flag.anchor_kind === "flag" || flag.anchor_kind === "buoy") &&
    !flag.system_controlled &&
    flag.city_id === null &&
    flag.kingdom_id === null &&
    (flag.owner_id !== playerId || isDeveloperTestTarget) &&
    [0, 1, 2, 3].includes(Number(flag.reinforcement_level)) &&
    flag.health !== null &&
    flag.maximum_health !== null &&
    Number(flag.maximum_health) === structureWarfareHealthForReinforcementLevel(Number(flag.reinforcement_level), flag.tower_level) &&
    Number(flag.health) > 0 &&
    // Burning is checked by lockBomberTarget (a repair-paused burn is allowed).
    (flag.burning_reason === null || flag.burning_reason === "flag_burn");
}

function requireSiegeAttackRange(
  group: MilitaryUnitGroupRow,
  target: SiegeTargetRow
): void {
  if (
    group.lat === null ||
    group.lon === null ||
    !Number.isFinite(Number(group.lat)) ||
    !Number.isFinite(Number(group.lon))
  ) {
    throw new MilitaryIndustryError("MILITARY_INVALID_POSITION", "The Siege group has no valid field position.");
  }
  if (!isWithinSiegeAttackRange(distanceMeters(
    { lat: Number(group.lat), lon: Number(group.lon) },
    { lat: Number(target.lat), lon: Number(target.lon) }
  ))) {
    throw new MilitaryIndustryError("MILITARY_SIEGE_OUT_OF_RANGE", "Target is out of siege range.");
  }
}

async function recordFlagCycleContributor(
  client: pg.PoolClient,
  playerId: string,
  flagId: string,
  operationKey: string,
  damage: number,
  damageCycleId: string
): Promise<void> {
  await client.query(
    `INSERT INTO flag_attack_operations (flag_id,player_id,request_id,damage,damage_cycle_id)
     VALUES ($1::uuid,$2,$3,$4,$5::uuid)
     ON CONFLICT (player_id,request_id) DO NOTHING`,
    [flagId, playerId, operationKey, damage, damageCycleId]
  );
}

async function requireWarCampClearance(
  client: pg.PoolClient,
  worldId: string,
  regionCode: string,
  position: Readonly<{ lat: number; lon: number }>,
  anchor: Readonly<{ lat: number; lon: number }>,
  moveLeashRadiusM: number,
  excludedCampId?: string
): Promise<void> {
  if (distanceMeters(position, anchor) > moveLeashRadiusM) {
    throw new MilitaryIndustryError("WAR_CAMP_PLACEMENT_RANGE_REQUIRED", "Move closer before placing your War Camp.");
  }
  const result = await client.query<{ lat: number; lon: number }>(
    `SELECT lat,lon FROM player_lodges WHERE world_id=$1 AND region_code=$2 AND removed_at IS NULL
     UNION ALL SELECT lat,lon FROM war_camps WHERE world_id=$1 AND region_code=$2 AND removed_at IS NULL
       AND ($3::uuid IS NULL OR camp_id<>$3::uuid)
     UNION ALL SELECT lat,lon FROM player_furnaces WHERE world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon FROM player_tanneries WHERE world_id=$1 AND region_code=$2 AND removed_at IS NULL
     UNION ALL SELECT lat,lon FROM player_kitchens WHERE world_id=$1 AND region_code=$2 AND removed_at IS NULL
     UNION ALL SELECT lat,lon FROM city_structures WHERE world_id=$1 AND region_code=$2 AND state IN ('constructing','active')`,
    [worldId, regionCode, excludedCampId ?? null]
  );
  if (result.rows.some((row) => distanceMeters(position, { lat: Number(row.lat), lon: Number(row.lon) }) < MILITARY_WAR_CAMP_OUTDOOR_CLEARANCE_M)) {
    throw new MilitaryIndustryError("WAR_CAMP_CLEARANCE_REQUIRED", `Place the War Camp at least ${MILITARY_WAR_CAMP_OUTDOOR_CLEARANCE_M} meters from other structures.`);
  }
}
