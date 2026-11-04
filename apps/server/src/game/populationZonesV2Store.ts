import { randomUUID } from "node:crypto";

import {
  MAX_EQUIPMENT_LEVEL,
  MOB_CHALLENGE_TIERS,
  MOB_CHALLENGE_TIER_BAND_WIDTH,
  ELDER_FROND_SAP_REFILL_MS,
  isGivingTreeResinCapable,
  isElderFern,
  treeVarietyForStableId,
  FLAX_FIBER_HARVEST_YIELD_QUANTITY,
  POPULATION_DENSITY_REVISION,
  treeWoodYieldForStableId,
  worldTimeAt,
  type MobChallengeTier
} from "@ash-atlas/shared";
import type pg from "pg";

import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import type { AppLogger } from "../logger.js";
import { spawnCellForPoint } from "./collectibles.js";
import {
  POPULATION_ZONE_V2_GEOMETRY_VERSION,
  type PopulationZoneV2Id,
  populationZoneV2Geometry,
  populationZoneV2Halo,
  populationZoneV2IdForPoint
} from "./populationZonesV2Geometry.js";
import {
  type GeneratedPopulationZoneV2Plan,
  generatePopulationZonesV2Plans,
  generatePopulationZoneV2GenerationSlots,
  incompleteSapCrawlerGroupCandidateIds,
  isPermanentMineEntityKind,
  permanentMineArchetype,
  reconcilePopulationZoneV2GenerationSlots,
  populationZoneV2GenerationId,
  populationZoneV3ConservativeHabitat,
  type PopulationZoneV2Habitat,
  type PopulationZoneV2EntityKind,
  type PopulationZoneV2PlanSlot,
  type PopulationZoneV2SuppressionClass,
  populationZoneV2PlanContentHash,
  populationZoneV2PlanningHabitatZoneIds
} from "./populationZonesV2Plan.js";
import {
  materializePopulationV2EncounterTables,
  type PopulationV2EncounterDiagnostics
} from "./populationV2EncounterTables.js";
import {
  populationV2MobDefinitionIsEligibleAtWorldPhase,
  populationV2MobRegistry,
  type PopulationV2MobDefinition,
  type PopulationV2MobRegistry
} from "./populationV2MobRegistry.js";
import type { PopulationV2KindRegistry } from "./populationV2KindRegistry.js";
import { loadPopulationV2OccupiedSlots } from "./populationV2RegisteredMobRolloutStore.js";
import {
  planPopulationV2RegisteredMobOverlay,
  type PopulationV2RegisteredMobOverlayResult,
  type PopulationV2RegisteredMobOverlaySlot
} from "./populationV2RegisteredMobOverlay.js";
import {
  PERMANENT_RESOURCE_REGISTRY
} from "./permanentResourceLifecycle.js";
import {
  deriveOceanSulfurDeposits,
  type OceanSulfurDeposit
} from "./oceanSulfurPlacement.js";
import {
  POPULATION_CANDIDATE_LAYOUT_VERSION,
  POPULATION_PLAN_VERSION,
  POPULATION_SPAWN_RULES_VERSION,
  POPULATION_STONE_PLACEMENT_VERSION,
  type POPULATION_RESPAWN_POLICY_VERSION,
  type PopulationZoneV2PlanIdentity,
  assertSamePopulationZoneV2PlanAuthority,
  permanentMineKindForSlot,
  permanentPopulationStoneIdentity,
  populationZoneV2AdvisoryLockKey,
  populationZoneV2PlanId,
  populationZoneV2PlanIdentity
} from "./populationZonesV2Identity.js";

export type PopulationZoneV2PlanStatus =
  | "pending"
  | "generating"
  | "ready"
  | "retryable-failure"
  | "terminal-failure";

export type PopulationZoneV2PlanRequest = Readonly<{
  identity: PopulationZoneV2PlanIdentity;
  planId: string;
  worldPipelineSha: string;
  regionCode: string;
}>;

export type PopulationZoneV2PlanRecord = PopulationZoneV2PlanRequest &
  Readonly<{
    status: PopulationZoneV2PlanStatus;
    claimGeneration: number;
    attemptCount: number;
    contentHash: string | null;
  }>;

export type ClaimedPopulationZoneV2Plan = Readonly<{
  identity: PopulationZoneV2PlanIdentity;
  planId: string;
  ownerId: string;
  claimGeneration: number;
  attemptCount: number;
}>;

export type PopulationZoneV2ReadyEntity = Readonly<{
  planId: string;
  zoneId: string;
  generationId: string | null;
  cutoverRevision: number;
  slotId: string;
  entityId: string;
  entityKind: PopulationZoneV2EntityKind;
  archetype: string;
  encounterId: string | null;
  packId: string | null;
  packMemberIndex: number | null;
  lat: number;
  lon: number;
  anchorLat: number;
  anchorLon: number;
  environmentSnapshot: Record<string, unknown>;
  suppressionClass: PopulationZoneV2SuppressionClass;
  stateRevision: number;
  durableRuntimeState?: Record<string, unknown>;
  combatLevel?: number;
  combatTier?: MobChallengeTier;
  combatBalanceVersion?: number;
  combatProfileSource?: "zone_player_profile" | "background_fallback";
  resinAvailable?: boolean;
  berryAvailable?: boolean;
  /** Elder Ferns only: when the sap refills after the last tap (null: never tapped). */
  sapReadyAt?: string | null;
}>;

export type PopulationZoneV2MobCombatProfileClaim = Readonly<{
  zoneId: string;
  level: number;
  source: "zone_player_profile";
  knownUnclaimed?: boolean;
}>;

export type PopulationZoneV2EntityState = "ready" | "dead" | "harvested";

export type PopulationZoneV2EntityStateSnapshot = Readonly<{
  entityId: string;
  state: PopulationZoneV2EntityState;
  stateRevision: number;
  stateActorPlayerId: string | null;
  eventAt: Date | null;
  respawnAt: Date | null;
  durableRuntimeState: Record<string, unknown>;
}>;

export type PopulationZoneV2RuntimeLeaseRequest = Readonly<{
  entityId: string;
  runtimeId: string;
  ownerToken: string;
  cutoverRevision: number;
  stateRevision: number;
}>;

export type PopulationZoneV2RuntimeLease =
  PopulationZoneV2RuntimeLeaseRequest & Readonly<{
    fencingGeneration: number;
    leaseExpiresAt: Date;
  }>;

export type PopulationRuntimeLeaseRenewalOutcome = Readonly<{
  entityId: string;
  status:
    | "renewed"
    | "durable-state-no-longer-ready"
    | "actual-cutover"
    | "lease-ownership-lost";
}>;

export const POPULATION_ZONE_V2_GENERATION_DURATION_MS =
  48 * 60 * 60_000;
export const POPULATION_ZONE_V2_GENERATION_CLEANUP_GRACE_MS = 30_000;
const POPULATION_RUNTIME_LEASE_MUTATION_RETRY_LIMIT = 2;
const POPULATION_RUNTIME_LEASE_MUTATION_RETRY_BASE_DELAY_MS = 5;
export const POPULATION_GENERATION_MATERIALIZATION_REVISION =
  "population-generation-materialization-v14-fantasy-mobs";
export const POPULATION_COMMON_SCHEMA_REVISION =
  "population-common-schema-v2-encounter-identity";
export const POPULATION_V2_REGISTERED_MOB_NEIGHBOR_OCCUPANTS_SQL = `
  SELECT slot.slot_id, slot.entity_id, slot.candidate_id,
         slot.entity_kind, slot.archetype, slot.encounter_id,
         slot.pack_id, slot.pack_member_index,
         slot.latitude, slot.longitude,
         slot.anchor_latitude, slot.anchor_longitude,
         slot.environment_snapshot, slot.suppression_class
  FROM population_zones_v2 AS target_plan
  JOIN population_zone_generations_v2 AS owner_generation
    ON owner_generation.zone_id<>target_plan.zone_id
   AND owner_generation.is_current
   AND owner_generation.status='active'
   AND owner_generation.expires_at > statement_timestamp()
  JOIN population_zones_v2 AS owner_plan
    ON owner_plan.plan_id=owner_generation.plan_id
   AND owner_plan.zone_id=owner_generation.zone_id
   AND owner_plan.status='ready'
  JOIN population_zone_cutovers_v2 AS owner_cutover
    ON owner_cutover.zone_id=owner_generation.zone_id
   AND owner_cutover.geometry_version=owner_plan.geometry_version
   AND owner_cutover.selected_plan_id=owner_generation.plan_id
   AND owner_cutover.serving_version='v2'
   AND owner_cutover.status='stable'
  JOIN population_spawn_slots_v2 AS slot
    ON slot.generation_id=owner_generation.generation_id
  WHERE target_plan.plan_id=$1::uuid
    AND target_plan.zone_id=$2
    AND target_plan.status='ready'
    AND ST_DWithin(
      slot.anchor_geom,
      target_plan.zone_geog,
      $3::double precision
    )
  UNION ALL
  SELECT slot.slot_id, slot.entity_id, slot.candidate_id,
         slot.entity_kind, slot.archetype, slot.encounter_id,
         slot.pack_id, slot.pack_member_index,
         slot.latitude, slot.longitude,
         slot.anchor_latitude, slot.anchor_longitude,
         slot.environment_snapshot, slot.suppression_class
  FROM population_zones_v2 AS target_plan
  JOIN population_zones_v2 AS owner_plan
    ON owner_plan.status='ready'
  JOIN population_zone_cutovers_v2 AS owner_cutover
    ON owner_cutover.zone_id=owner_plan.zone_id
   AND owner_cutover.geometry_version=owner_plan.geometry_version
   AND owner_cutover.selected_plan_id=owner_plan.plan_id
   AND owner_cutover.serving_version='v2'
   AND owner_cutover.status='stable'
  JOIN population_plan_spawn_slots_v2 AS slot
    ON slot.plan_id=owner_plan.plan_id
   AND slot.generation_id IS NULL
  WHERE target_plan.plan_id=$1::uuid
    AND target_plan.zone_id=$2
    AND target_plan.status='ready'
    AND ST_DWithin(
      slot.anchor_geom,
      target_plan.zone_geog,
      $3::double precision
    )
  ORDER BY entity_kind, candidate_id,
           pack_member_index NULLS FIRST, entity_id`;
const populationInvariantWarnings = new Set<string>();

export type PopulationZoneV2GenerationStatus =
  | "active"
  | "expired"
  | "refresh-pending";

export type PopulationZoneV2GenerationRecord = Readonly<{
  generationId: string;
  zoneId: string;
  planId: string;
  generationNumber: number;
  generatedAt: Date;
  expiresAt: Date;
  status: PopulationZoneV2GenerationStatus;
  plannedNonStoneCount: number;
  currentReferenceCount: number;
  unreferencedAt: Date | null;
  isCurrent: boolean;
  cleanedAt: Date | null;
  densityRevision?: string;
  planContentHash?: string;
  candidateLayoutVersion?: string;
  materializationRevision?: string;
  commonSchemaRevision?: string;
  cutoverRevision?: number;
}>;

export type PopulationZoneV2GenerationMaterialization = Readonly<{
  generation: PopulationZoneV2GenerationRecord;
  created: boolean;
  entityIds: readonly string[];
  retiredEntityIds?: readonly string[];
  shortfallByKind: Readonly<Record<string, number>>;
  encounterDiagnostics?: PopulationV2EncounterDiagnostics;
}>;

export type PopulationV2MaterializationDiagnostics = Readonly<{
  activeCurrentCountsByRevision: Readonly<Record<string, number>>;
  activeCurrentCountsByCommonSchemaRevision:
    Readonly<Record<string, number>>;
  activeCurrentCountsByKindManifestRevision:
    Readonly<Record<string, number>>;
  guardedActiveGenerations: readonly Readonly<{
    zoneId: string;
    generationId: string;
    materializationRevision: string;
    expiresAt: Date;
    plannedNonStoneCount: number;
    currentReferenceCount: number;
  }>[];
}>;

export type PopulationZoneV2PopulationDiagnostics = Readonly<{
  zoneId: string;
  permanentStoneCount: number;
  v2DurableEntityCount: number;
  generationId: string | null;
  generatedAt: Date | null;
  expiresAt: Date | null;
  generationStatus: PopulationZoneV2GenerationStatus | null;
  plannedNonStoneCount: number;
  activeNonStoneCount: number;
  currentReferenceCount: number;
  sapCrawlerAllocatedCandidates: number;
  sapCrawlerNoEligibleClusterCandidates: number;
  sapCrawlerInsufficientValidSiteCandidates: number;
  sapCrawlerConflictRejectedCandidates: number;
  sapCrawlerPlannedGroupCount: number;
  sapCrawlerPlannedMemberCount: number;
  sapCrawlerInsertedGroupCount: number;
  sapCrawlerReadyMemberCount: number;
  sapCrawlerLeasedActorCount: number;
  sapCrawlerPlacementShortfallGroups: number;
  registeredMobs: readonly PopulationZoneV2RegisteredMobDiagnostic[];
}>;

export type PopulationZoneV2RegisteredMobDiagnostic = Readonly<{
  mobKind: string;
  diagnosticsLabel: string;
  placementRevision: string;
  source: "generation" | "top_up";
  status:
    | "completed"
    | "completed_with_shortfall"
    | "retryable_failure"
    | "terminal_diagnostic";
  targetGroupCount: number;
  targetBodyCount: number;
  insertedGroupCount: number;
  insertedBodyCount: number;
  shortfallGroupCount: number;
  attemptCount: number;
}>;

export type PopulationReconciliationTelemetryRow = Readonly<{
  zoneId: string;
  entityCategory: string;
  plannedCount: number;
  persistedCount: number;
  readyAliveCount: number;
  deadHarvestedCount: number;
  respawnPendingCount: number;
  suppressedCount: number;
}>;

type PlanRow = {
  plan_id: string;
  zone_id: string;
  geometry_version: typeof POPULATION_ZONE_V2_GEOMETRY_VERSION;
  world_environment_identity_key: string;
  world_runtime_sha: string;
  plan_version: typeof POPULATION_PLAN_VERSION;
  spawn_rules_version: typeof POPULATION_SPAWN_RULES_VERSION;
  environment_profile_version: string;
  candidate_layout_version: typeof POPULATION_CANDIDATE_LAYOUT_VERSION;
  respawn_policy_version: typeof POPULATION_RESPAWN_POLICY_VERSION;
  region_code: string;
  status: PopulationZoneV2PlanStatus;
  claim_generation: string | number;
  attempt_count: number;
  content_hash: string | null;
};

type ClaimedPlanRow = PlanRow & {
  band_index: number;
  column_index: number;
  total_area_km2: number | string;
  center_latitude: number | string;
  center_longitude: number | string;
  zone_geometry_matches: boolean;
};

type GenerationRow = {
  generation_id: string;
  zone_id: string;
  plan_id: string;
  generation_number: string | number;
  generated_at: Date;
  expires_at: Date;
  status: PopulationZoneV2GenerationStatus;
  planned_nonstone_count: number;
  current_reference_count: number;
  unreferenced_at: Date | null;
  is_current: boolean;
  cleaned_at: Date | null;
  density_revision?: string;
  plan_content_hash?: string;
  candidate_layout_version?: string;
  materialization_revision?: string;
  common_schema_revision?: string;
  cutover_revision?: string | number;
};

type GenerationTemplateRow = PlanRow & {
  habitat_snapshot: PopulationZoneV2Habitat;
  nonstone_template_slots: PopulationZoneV2PlanSlot[];
};

type GenerationSlotRow = {
  slot_id: string;
  entity_id: string;
  candidate_id: string;
  entity_kind: PopulationZoneV2EntityKind;
  archetype: string;
  encounter_id: string | null;
  pack_id: string | null;
  pack_member_index: number | null;
  latitude: number | string;
  longitude: number | string;
  anchor_latitude: number | string;
  anchor_longitude: number | string;
  environment_snapshot: PopulationZoneV2PlanSlot["environmentSnapshot"];
  suppression_class: PopulationZoneV2SuppressionClass;
};

type NeighborGenerationContextRow = GenerationTemplateRow & {
  current_generation_id: string | null;
  next_generation_number: string | number;
};

type PermanentMineAuthorityRow = {
  authority_plan_id: string;
  authority_candidate_layout_version: string;
  generation_id: string | null;
  entity_id: string;
  slot_id: string;
  candidate_id: string;
  owner_zone_id: string;
  entity_kind: "stone" | "coal" | "iron" | "sulfur";
  archetype: "stone_mine" | "coal_mine" | "iron_mine" | "sulfur_mine";
  stone_placement_version: string;
  yield_item_id: "stone" | "coal" | "iron" | "sulfur";
  yield_quantity: number | string;
  regeneration_interval_ms: number | string;
  timer_profession_id: string;
  timer_visibility_rank: number | string;
  world_environment_identity_key: string;
  latitude: number | string;
  longitude: number | string;
  anchor_latitude: number | string;
  anchor_longitude: number | string;
  environment_snapshot: Record<string, unknown>;
  suppression_class: "none";
  state_revision: number | string | null;
  projection_id: string | null;
  projection_latitude: number | string | null;
  projection_longitude: number | string | null;
  projection_zone_id: string | null;
  projection_plan_id: string | null;
  projection_placement_version: string | null;
};

type StoneConflictRepairCandidateRow = PlanRow & {
  lease_expires_at: Date | null;
  last_error: string | null;
  selected_plan_id: string;
  selected_zone_id: string;
  selected_geometry_version: string;
  selected_spawn_rules_version: string;
  selected_world_environment_identity_key: string;
  selected_plan_version: string;
  selected_environment_profile_version: string;
  selected_candidate_layout_version: string;
  selected_respawn_policy_version: string;
  selected_habitat_snapshot: PopulationZoneV2Habitat;
  existing_repair_id: string | null;
};

const MAXIMUM_PLAN_ATTEMPTS = 8;

export const POPULATION_V2_READY_ENTITIES_SQL = `
  WITH requested_zones(zone_id) AS (
    SELECT unnest($1::text[])
  ),
  selected_cutovers AS (
    SELECT cutover.zone_id, cutover.selected_plan_id,
           cutover.cutover_revision
    FROM requested_zones AS requested
    JOIN population_zone_cutovers_v2 AS cutover
      ON cutover.zone_id=requested.zone_id
    JOIN population_zones_v2 AS plan
      ON plan.plan_id=cutover.selected_plan_id
     AND plan.status='ready'
    WHERE cutover.geometry_version=$2
      AND cutover.serving_version='v2'
      AND cutover.status='stable'
  ),
  selected_slots AS (
    SELECT slot.*, cutover.zone_id AS serving_zone_id,
           cutover.cutover_revision,
           generation.is_current AS generation_is_current,
           generation.status AS generation_status,
           generation.expires_at AS generation_expires_at
    FROM selected_cutovers AS cutover
    JOIN population_plan_spawn_slots_v2 AS slot
      ON slot.plan_id=cutover.selected_plan_id
    LEFT JOIN population_zone_generations_v2 AS generation
      ON generation.generation_id=slot.generation_id
     AND generation.plan_id=slot.plan_id
     AND generation.zone_id=cutover.zone_id
  ),
  requested_generations(generation_id) AS (
    SELECT DISTINCT generation_id
    FROM selected_slots
    WHERE generation_id IS NOT NULL
  ),
  valid_packs AS (
    SELECT pack_member.generation_id, pack_member.pack_id,
           min(pack_member.entity_kind) AS entity_kind,
           min(pack_member.archetype) AS archetype,
           min(pack_member.encounter_id::text)::uuid AS encounter_id
    FROM requested_generations AS requested
    JOIN population_spawn_slots_v2 AS pack_member
      ON pack_member.generation_id=requested.generation_id
    LEFT JOIN population_entity_state_v2 AS pack_state
      ON pack_state.entity_id=pack_member.entity_id
    LEFT JOIN generated_world_mobs AS pack_mob
      ON pack_mob.population_v2_entity_id=pack_member.entity_id
    WHERE pack_member.pack_id IS NOT NULL
    GROUP BY pack_member.generation_id, pack_member.pack_id
    HAVING count(DISTINCT pack_member.entity_kind)=1
      AND count(DISTINCT pack_member.archetype)=1
      AND count(pack_member.encounter_id)=count(*)
      AND count(DISTINCT pack_member.encounter_id)=1
      AND count(pack_state.entity_id)=count(*)
      AND count(pack_mob.population_v2_entity_id)=count(*)
      AND count(*) BETWEEN
        CASE
          WHEN min(pack_member.entity_kind) IN ('deer','frost_deer','jungle_deer','marsh_deer','sand_deer') THEN 1
          WHEN min(pack_member.entity_kind) IN ('wolf','frost_wolf','dune_wolf','jungle_wolf','bog_wolf','griffin') THEN 2
          WHEN min(pack_member.entity_kind) IN ('sap_crawler','vine_lurker') THEN 3
          ELSE 1
        END
        AND CASE
          WHEN min(pack_member.entity_kind) IN ('deer','frost_deer','jungle_deer','marsh_deer','sand_deer') THEN 3
          WHEN min(pack_member.entity_kind) IN ('wolf','frost_wolf','dune_wolf','jungle_wolf','bog_wolf','griffin') THEN 4
          WHEN min(pack_member.entity_kind) IN ('sap_crawler','vine_lurker') THEN 5
          ELSE 1
        END
      AND count(DISTINCT pack_member.pack_member_index)=count(*)
      AND min(pack_member.pack_member_index)=0
      AND max(pack_member.pack_member_index)=count(*)-1
  ),
  requested_entity_ids(entity_id) AS (
    SELECT DISTINCT entity_id FROM selected_slots
  ),
  suppressed_entity_ids(entity_id) AS (
    SELECT suppression.entity_id
    FROM selected_slots AS requested
    JOIN population_river_water_suppressions_v1 AS suppression
      ON suppression.entity_id=requested.entity_id
    WHERE requested.entity_kind NOT IN ('alligator', 'caiman', 'crocodile')
    UNION
    SELECT collectible.population_v2_entity_id
    FROM requested_entity_ids AS requested
    JOIN collectible_nodes AS collectible
      ON collectible.population_v2_entity_id=requested.entity_id
    WHERE collectible.population_cutover_suppressed
    UNION
    SELECT mob.population_v2_entity_id
    FROM requested_entity_ids AS requested
    JOIN generated_world_mobs AS mob
      ON mob.population_v2_entity_id=requested.entity_id
    WHERE mob.population_v2_suppressed
    UNION
    SELECT resource.population_v2_entity_id
    FROM requested_entity_ids AS requested
    JOIN repeatable_resource_nodes AS resource
      ON resource.population_v2_entity_id=requested.entity_id
    WHERE resource.population_cutover_suppressed
  )
  SELECT slot.plan_id, slot.serving_zone_id AS zone_id,
         slot.generation_id, slot.cutover_revision,
         slot.slot_id, slot.entity_id, slot.entity_kind, slot.archetype,
         slot.encounter_id, slot.pack_id, slot.pack_member_index,
         slot.latitude, slot.longitude,
         slot.anchor_latitude, slot.anchor_longitude,
         slot.environment_snapshot, slot.suppression_class,
         state.state_revision, state.durable_runtime_state,
         collectible.resin_harvested_life_revision,
         collectible.sap_harvested_at,
         mob_profile.combat_level,
         mob_profile.combat_tier,
         mob_profile.combat_balance_version,
         mob_profile.combat_profile_source
  FROM selected_slots AS slot
  JOIN population_entity_state_v2 AS state
    ON state.entity_id=slot.entity_id AND state.state='ready'
  LEFT JOIN collectible_nodes AS collectible
    ON collectible.population_v2_entity_id=slot.entity_id
  LEFT JOIN generated_world_mobs AS mob_profile
    ON mob_profile.population_v2_entity_id=slot.entity_id
  LEFT JOIN valid_packs AS valid_pack
    ON valid_pack.generation_id=slot.generation_id
   AND valid_pack.pack_id=slot.pack_id
   AND valid_pack.entity_kind=slot.entity_kind
   AND valid_pack.archetype=slot.archetype
   AND valid_pack.encounter_id=slot.encounter_id
  LEFT JOIN suppressed_entity_ids AS suppressed
    ON suppressed.entity_id=slot.entity_id
  WHERE (
      EXISTS (
        SELECT 1
        FROM population_plan_permanent_resources_v2 AS permanent_resource
        WHERE permanent_resource.plan_id=slot.plan_id
          AND permanent_resource.entity_id=slot.entity_id
      )
      OR (
        slot.generation_is_current
        AND slot.generation_status='active'
        AND slot.generation_expires_at > statement_timestamp()
      )
    )
    AND (
      slot.entity_kind NOT IN ('tree','flax')
      OR (
        collectible.population_v2_entity_id=slot.entity_id
        AND collectible.population_v2_plan_id=slot.plan_id
        AND collectible.physical_population_zone_v2_id=slot.serving_zone_id
        AND collectible.population_cutover_revision=slot.cutover_revision
        AND collectible.population_v2_state_revision=state.state_revision
        AND collectible.state='available'
        AND collectible.harvested_at IS NULL
        AND collectible.harvested_by_player_id IS NULL
        AND NOT collectible.population_v2_suppressed
      )
    )
    AND (
      slot.entity_kind NOT IN (
        'deer', 'frost_deer', 'jungle_deer', 'marsh_deer', 'sand_deer',
        'wolf', 'frost_wolf', 'dune_wolf', 'jungle_wolf', 'bog_wolf', 'griffin',
        'sap_crawler', 'vine_lurker'
      )
      OR valid_pack.pack_id IS NOT NULL
    )
    AND suppressed.entity_id IS NULL
  ORDER BY slot.serving_zone_id, slot.entity_id`;

export type PopulationPlanFailureCode =
  | "population-plan-claim-expired"
  | "population-plan-transient-database"
  | "population-plan-immutable-stone-mismatch"
  | "population-plan-entity-identity-collision"
  | "population-plan-deterministic-constraint"
  | "population-plan-corrupt-authority"
  | "population-plan-generation-failure";

type PopulationPlanCompletionFailureDetails = Readonly<{
  code: PopulationPlanFailureCode;
  retryable: boolean;
  postgresCode: string | null;
  constraint: string | null;
  table: string | null;
  zoneId: string;
  planId: string;
  spawnRulesVersion: string;
  slotId: string | null;
  entityId: string | null;
  entityKind: PopulationZoneV2EntityKind | null;
  generationId: string | null;
  claimGeneration: number;
  attemptCount: number;
}>;

export class PopulationPlanCompletionError extends Error {
  readonly details: PopulationPlanCompletionFailureDetails;

  constructor(
    message: string,
    details: PopulationPlanCompletionFailureDetails,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PopulationPlanCompletionError";
    this.details = details;
  }
}

export type PopulationStoneConflictRepairReceipt = Readonly<{
  repairId: string;
  affectedPlans: readonly Readonly<{
    zoneId: string;
    planId: string;
    previousStatus: "generating" | "retryable-failure" | "terminal-failure";
    previousAttemptCount: number;
    compatibleEntityIds: readonly string[];
  }>[];
}>;

export function populationZoneV2PlanRequest(input: Readonly<{
  zoneId: PopulationZoneV2Id;
  worldEnvironmentIdentityKey: string;
  worldPipelineSha: string;
  environmentProfileVersion: string;
  regionCode: string;
}>): PopulationZoneV2PlanRequest {
  const identity = populationZoneV2PlanIdentity(input);
  if (!/^[a-f0-9]{40}$/u.test(input.worldPipelineSha)) {
    throw new Error("World runtime SHA must be a lowercase 40-character Git SHA");
  }
  if (input.regionCode.length === 0) {
    throw new Error("population plan region code is required");
  }
  return {
    identity,
    planId: populationZoneV2PlanId(identity),
    worldPipelineSha: input.worldPipelineSha,
    regionCode: input.regionCode
  };
}

export class PostgresPopulationZonesV2Store {
  constructor(
    private readonly pool: pg.Pool,
    private readonly generationSlotGenerator:
      typeof generatePopulationZoneV2GenerationSlots =
        generatePopulationZoneV2GenerationSlots,
    private readonly mobRegistry:
      PopulationV2MobRegistry<PopulationV2MobDefinition> =
        populationV2MobRegistry,
    private readonly options: Readonly<{
      profileClaimNoopFastPathEnabled?: boolean;
      logger?: Partial<Pick<AppLogger, "info" | "warn">>;
    }> = {}
  ) {}

  async telemetryReconciliationSnapshot(): Promise<
    PopulationReconciliationTelemetryRow[]
  > {
    const result = await this.pool.query<{
      zone_id: string;
      entity_category: string;
      planned_count: string | number;
      persisted_count: string | number;
      ready_alive_count: string | number;
      dead_harvested_count: string | number;
      respawn_pending_count: string | number;
      suppressed_count: string | number;
    }>(
      `WITH projections AS (
         SELECT population_v2_entity_id AS entity_id,
                population_v2_suppressed AS suppressed
         FROM collectible_nodes WHERE population_v2_entity_id IS NOT NULL
         UNION ALL
         SELECT population_v2_entity_id, population_v2_suppressed
         FROM generated_world_mobs WHERE population_v2_entity_id IS NOT NULL
         UNION ALL
         SELECT population_v2_entity_id, population_v2_suppressed
         FROM repeatable_resource_nodes WHERE population_v2_entity_id IS NOT NULL
       ), current_slots AS (
         SELECT cutover.zone_id, slot.plan_id, slot.entity_id,
                slot.entity_kind, slot.archetype,
                slot.pack_id,
                count(*) OVER (PARTITION BY cutover.zone_id, slot.pack_id) AS pack_size,
                state.state, state.respawn_at,
                projection.entity_id AS persisted_entity_id,
                COALESCE(projection.suppressed, false) AS suppressed,
                collectible.resin_harvested_life_revision
         FROM population_zone_cutovers_v2 AS cutover
         JOIN population_zones_v2 AS plan
           ON plan.plan_id=cutover.selected_plan_id AND plan.status='ready'
         JOIN population_plan_spawn_slots_v2 AS slot ON slot.plan_id=plan.plan_id
         LEFT JOIN population_zone_generations_v2 AS generation
           ON generation.generation_id=slot.generation_id
         JOIN population_entity_state_v2 AS state ON state.entity_id=slot.entity_id
         LEFT JOIN projections AS projection ON projection.entity_id=slot.entity_id
         LEFT JOIN collectible_nodes AS collectible
           ON collectible.population_v2_entity_id=slot.entity_id
         WHERE cutover.geometry_version=$1
           AND cutover.serving_version='v2'
           AND cutover.status='stable'
           AND (
             EXISTS (
               SELECT 1
               FROM population_plan_permanent_resources_v2 AS permanent_resource
               WHERE permanent_resource.plan_id=slot.plan_id
                 AND permanent_resource.entity_id=slot.entity_id
             )
             OR generation.is_current
           )
       ), categories AS (
         SELECT zone_id, entity_kind AS entity_category, entity_id,
                persisted_entity_id, state, respawn_at, suppressed
         FROM current_slots
         UNION ALL
         SELECT zone_id, 'archetype:' || archetype, entity_id,
                persisted_entity_id, state, respawn_at, suppressed
         FROM current_slots
         UNION ALL
         SELECT zone_id, entity_kind || '_group', pack_id,
                CASE WHEN bool_or(persisted_entity_id IS NOT NULL) THEN pack_id END,
                CASE WHEN bool_or(state='ready') THEN 'ready' ELSE 'dead' END,
                max(respawn_at), bool_or(suppressed)
         FROM current_slots WHERE pack_id IS NOT NULL
         GROUP BY zone_id, entity_kind, pack_id
         UNION ALL
         SELECT zone_id,
                entity_kind || '_group_' || pack_size::text || '_member',
                pack_id,
                CASE WHEN bool_or(persisted_entity_id IS NOT NULL) THEN pack_id END,
                CASE WHEN bool_or(state='ready') THEN 'ready' ELSE 'dead' END,
                max(respawn_at), bool_or(suppressed)
         FROM current_slots
         WHERE pack_id IS NOT NULL
         GROUP BY zone_id, entity_kind, pack_id, pack_size
         UNION ALL
         SELECT zone_id, 'resin_harvested_tree', entity_id,
                persisted_entity_id, state, respawn_at, suppressed
         FROM current_slots
         WHERE entity_kind='tree'
           AND resin_harvested_life_revision IS NOT NULL
         UNION ALL
         SELECT zone_id, 'resin_available_tree', entity_id,
                persisted_entity_id, state, respawn_at, suppressed
         FROM current_slots
         WHERE entity_kind='tree'
           AND resin_harvested_life_revision IS NULL
         UNION ALL
         SELECT zone_id, 'permanent_mine', entity_id,
                persisted_entity_id, state, respawn_at, suppressed
         FROM current_slots
         WHERE EXISTS (
           SELECT 1
           FROM population_plan_permanent_resources_v2 AS permanent_resource
           WHERE permanent_resource.plan_id=current_slots.plan_id
             AND permanent_resource.entity_id=current_slots.entity_id
         )
       )
       SELECT zone_id, entity_category,
              count(*) AS planned_count,
              count(persisted_entity_id) AS persisted_count,
              count(*) FILTER (WHERE state='ready') AS ready_alive_count,
              count(*) FILTER (WHERE state IN ('dead','harvested')) AS dead_harvested_count,
              count(*) FILTER (
                WHERE state IN ('dead','harvested') AND respawn_at > now()
              ) AS respawn_pending_count,
              count(*) FILTER (WHERE suppressed) AS suppressed_count
       FROM categories
       GROUP BY zone_id, entity_category
       ORDER BY zone_id, entity_category`,
      [POPULATION_ZONE_V2_GEOMETRY_VERSION]
    );
    return result.rows.map((row) => ({
      zoneId: row.zone_id,
      entityCategory: row.entity_category,
      plannedCount: Number(row.planned_count),
      persistedCount: Number(row.persisted_count),
      readyAliveCount: Number(row.ready_alive_count),
      deadHarvestedCount: Number(row.dead_harvested_count),
      respawnPendingCount: Number(row.respawn_pending_count),
      suppressedCount: Number(row.suppressed_count)
    }));
  }

  async ensurePlanForZone(
    request: PopulationZoneV2PlanRequest
  ): Promise<PopulationZoneV2PlanRecord> {
    const records = await this.ensurePlansForZones([request]);
    const record = records[0];
    if (record === undefined) {
      throw new Error(`population plan admission failed for ${request.planId}`);
    }
    return record;
  }

  async ensurePlansForZones(
    requests: readonly PopulationZoneV2PlanRequest[]
  ): Promise<PopulationZoneV2PlanRecord[]> {
    if (requests.length === 0) return [];
    assertUnique(requests.map((request) => request.planId), "population plan");
    const values: string[] = [];
    const parameters: unknown[] = [];
    for (const request of requests) {
      assertRequestIdentity(request);
      const geometry = populationZoneV2Geometry(
        request.identity.zoneId as PopulationZoneV2Id
      );
      const offset = parameters.length;
      parameters.push(
        request.planId,
        request.identity.zoneId,
        request.identity.geometryVersion,
        request.identity.worldEnvironmentIdentityKey,
        request.worldPipelineSha,
        request.identity.populationPlanVersion,
        request.identity.spawnRulesVersion,
        request.identity.environmentProfileVersion,
        request.identity.candidateLayoutVersion,
        request.identity.respawnPolicyVersion,
        request.regionCode,
        geometry.address.band,
        geometry.address.column,
        geometry.bounds.westLon,
        geometry.bounds.southLat,
        geometry.bounds.eastLon,
        geometry.bounds.northLat,
        geometry.center.lon,
        geometry.center.lat,
        geometry.areaKm2
      );
      const p = (index: number) => `$${offset + index}`;
      values.push(`(
        ${p(1)}::uuid,${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},
        ${p(8)},${p(9)},${p(10)},${p(11)},${p(12)}::integer,${p(13)}::integer,
        ST_Multi(ST_MakeEnvelope(
          ${p(14)}::double precision,${p(15)}::double precision,
          ${p(16)}::double precision,${p(17)}::double precision,4326
        ))::geography,
        ST_SetSRID(ST_MakePoint(
          ${p(18)}::double precision,${p(19)}::double precision
        ),4326)::geography,
        ${p(20)}::double precision,'pending',clock_timestamp()
      )`);
    }

    await this.pool.query(
      `INSERT INTO population_zones_v2 (
         plan_id, zone_id, geometry_version,
         world_environment_identity_key, world_runtime_sha,
         plan_version, spawn_rules_version, environment_profile_version,
         candidate_layout_version, respawn_policy_version, region_code,
         band_index, column_index, zone_geog, center_geog, total_area_km2,
         status, next_retry_at
       ) VALUES ${values.join(",")}
       ON CONFLICT (
         zone_id, geometry_version, world_environment_identity_key,
         plan_version, spawn_rules_version, environment_profile_version,
         candidate_layout_version, respawn_policy_version
       ) DO NOTHING`,
      parameters
    );
    const result = await this.pool.query<PlanRow>(
      `SELECT plan_id, zone_id, geometry_version,
              world_environment_identity_key, world_runtime_sha,
              plan_version, spawn_rules_version, environment_profile_version,
              candidate_layout_version, respawn_policy_version, region_code,
              status, claim_generation, attempt_count, content_hash
       FROM population_zones_v2
       WHERE plan_id = ANY($1::uuid[])
       ORDER BY zone_id, plan_id`,
      [requests.map((request) => request.planId)]
    );
    const records = result.rows.map(rowToPlanRecord);
    const recordsById = new Map(records.map((record) => [record.planId, record]));
    for (const request of requests) {
      const stored = recordsById.get(request.planId);
      if (stored === undefined) {
        throw new Error(`population plan identity collision for ${request.planId}`);
      }
      assertStoredRequestMatches(stored, request);
    }
    return requests.map((request) => recordsById.get(request.planId)!);
  }

  async loadPlanRecordsForZones(
    requests: readonly PopulationZoneV2PlanRequest[]
  ): Promise<PopulationZoneV2PlanRecord[]> {
    if (requests.length === 0) return [];
    requests.forEach(assertRequestIdentity);
    const result = await this.pool.query<PlanRow>(
      `SELECT plan_id, zone_id, geometry_version,
              world_environment_identity_key, world_runtime_sha,
              plan_version, spawn_rules_version, environment_profile_version,
              candidate_layout_version, respawn_policy_version, region_code,
              status, claim_generation, attempt_count, content_hash
       FROM population_zones_v2
       WHERE plan_id = ANY($1::uuid[])
       ORDER BY zone_id, plan_id`,
      [requests.map((request) => request.planId)]
    );
    const records = result.rows.map(rowToPlanRecord);
    const requestById = new Map(requests.map((request) => [
      request.planId,
      request
    ]));
    for (const record of records) {
      const request = requestById.get(record.planId);
      if (!request) {
        throw new Error(`unexpected population plan ${record.planId}`);
      }
      assertStoredRequestMatches(record, request);
    }
    return records;
  }

  async supersedeObsoletePlansForZones(
    zoneIds: readonly PopulationZoneV2Id[],
    reason: string
  ): Promise<number> {
    if (zoneIds.length === 0) return 0;
    if (reason.trim().length === 0 || reason.length > 500) {
      throw new Error("population plan supersession reason is invalid");
    }
    const result = await this.pool.query(
      `UPDATE population_zones_v2
       SET status='terminal-failure',
           claim_owner_id=NULL,
           lease_expires_at=NULL,
           next_retry_at=NULL,
           last_error=$4,
           updated_at=clock_timestamp()
       WHERE zone_id = ANY($1::text[])
         AND geometry_version=$2
         AND (
           plan_version <> $3
           OR candidate_layout_version <> $5
         )
         AND status IN ('pending','generating','retryable-failure')`,
      [
        [...new Set(zoneIds)].sort(),
        POPULATION_ZONE_V2_GEOMETRY_VERSION,
        POPULATION_PLAN_VERSION,
        reason,
        POPULATION_CANDIDATE_LAYOUT_VERSION
      ]
    );
    return result.rowCount ?? 0;
  }

  async claimPlan(
    identity: PopulationZoneV2PlanIdentity,
    ownerId: string,
    leaseMs: number
  ): Promise<ClaimedPopulationZoneV2Plan | null> {
    assertPositiveMilliseconds(leaseMs, "population plan lease");
    const planId = populationZoneV2PlanId(identity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        populationZoneV2AdvisoryLockKey(identity).toString()
      ]);
      await client.query(
        `UPDATE population_zones_v2
         SET status = 'terminal-failure', claim_owner_id = NULL,
             lease_expires_at = NULL, next_retry_at = NULL,
             last_error =
               'population plan generation lease expired after maximum attempts',
             updated_at = clock_timestamp()
         WHERE plan_id = $1::uuid
           AND status = 'generating'
           AND lease_expires_at <= clock_timestamp()
           AND attempt_count >= $2`,
        [planId, MAXIMUM_PLAN_ATTEMPTS]
      );
      const result = await client.query<{
        claim_generation: string | number;
        attempt_count: number;
      }>(
        `UPDATE population_zones_v2
         SET status = 'generating', claim_owner_id = $2::uuid,
             claim_generation = claim_generation + 1,
             lease_expires_at = clock_timestamp()
               + ($3::bigint * interval '1 millisecond'),
             attempt_count = attempt_count + 1,
             next_retry_at = NULL, last_error = NULL,
             updated_at = clock_timestamp()
         WHERE plan_id = $1::uuid
           AND attempt_count < $4
           AND (
             (status IN ('pending', 'retryable-failure')
               AND next_retry_at <= clock_timestamp())
             OR
             (status = 'generating' AND lease_expires_at <= clock_timestamp())
           )
         RETURNING claim_generation, attempt_count`,
        [planId, ownerId, leaseMs, MAXIMUM_PLAN_ATTEMPTS]
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
          identity,
          planId,
          ownerId,
          claimGeneration: Number(row.claim_generation),
          attemptCount: Number(row.attempt_count)
        };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeatPlan(
    claim: ClaimedPopulationZoneV2Plan,
    leaseMs: number
  ): Promise<boolean> {
    assertPositiveMilliseconds(leaseMs, "population plan lease");
    const result = await this.pool.query(
      `UPDATE population_zones_v2
       SET lease_expires_at = clock_timestamp()
             + ($4::bigint * interval '1 millisecond'),
           updated_at = clock_timestamp()
       WHERE plan_id = $1::uuid AND status = 'generating'
         AND claim_owner_id = $2::uuid AND claim_generation = $3
         AND lease_expires_at > clock_timestamp()`,
      [claim.planId, claim.ownerId, claim.claimGeneration, leaseMs]
    );
    return result.rowCount === 1;
  }

  async completePlan(
    claim: ClaimedPopulationZoneV2Plan,
    plan: GeneratedPopulationZoneV2Plan
  ): Promise<boolean> {
    assertGeneratedPlanMatchesClaim(plan, claim);
    const canonicalGeometry = populationZoneV2Geometry(
      claim.identity.zoneId as PopulationZoneV2Id
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        populationZoneV2AdvisoryLockKey(claim.identity).toString()
      ]);
      const owned = await client.query<ClaimedPlanRow>(
        `SELECT plan_id, zone_id, geometry_version,
                world_environment_identity_key, world_runtime_sha,
                plan_version, spawn_rules_version, environment_profile_version,
                candidate_layout_version, respawn_policy_version, region_code,
                status, claim_generation, attempt_count, content_hash,
                band_index, column_index, total_area_km2,
                ST_Y(center_geog::geometry) AS center_latitude,
                ST_X(center_geog::geometry) AS center_longitude,
                ST_Equals(
                  zone_geog::geometry,
                  ST_Multi(ST_MakeEnvelope(
                    $4::double precision, $5::double precision,
                    $6::double precision, $7::double precision, 4326
                  ))
                ) AS zone_geometry_matches
         FROM population_zones_v2
         WHERE plan_id = $1::uuid AND status = 'generating'
           AND claim_owner_id = $2::uuid AND claim_generation = $3
           AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [
          claim.planId,
          claim.ownerId,
          claim.claimGeneration,
          canonicalGeometry.bounds.westLon,
          canonicalGeometry.bounds.southLat,
          canonicalGeometry.bounds.eastLon,
          canonicalGeometry.bounds.northLat
        ]
      );
      const admitted = owned.rows[0];
      if (admitted === undefined) {
        await client.query("ROLLBACK");
        return false;
      }
      assertGeneratedPlanMatchesAdmission(plan, claim, admitted);
      const mineSlots = plan.slots.filter((slot) =>
        isPermanentMineEntityKind(slot.entityKind)
      );
      const newMineSlots = await insertOrAdoptPermanentMines(client, {
        claim,
        slots: mineSlots
      });
      const sulfurDeposits = deriveOceanSulfurDeposits({
        zoneId: claim.identity.zoneId,
        worldEnvironmentIdentityKey:
          claim.identity.worldEnvironmentIdentityKey,
        habitat: plan.habitat
      });
      const newSulfurDeposits = await insertOrAdoptOceanSulfurDeposits(
        client,
        { claim, deposits: sulfurDeposits }
      );
      if (newMineSlots.length > 0) {
        await client.query(
          `INSERT INTO population_entity_state_v2 (entity_id, state)
           SELECT entity_id, 'ready'
           FROM unnest($1::uuid[]) AS inserted(entity_id)`,
          [newMineSlots.map((slot) => slot.entityId)]
        );
      }
      if (newSulfurDeposits.length > 0) {
        await client.query(
          `INSERT INTO population_entity_state_v2 (entity_id, state)
           SELECT entity_id, 'ready'
           FROM unnest($1::uuid[]) AS inserted(entity_id)`,
          [newSulfurDeposits.map((deposit) => deposit.entityId)]
        );
      }
      await adoptZonePermanentMinesForPlan(client, {
        zoneId: claim.identity.zoneId,
        planId: claim.planId
      });
      await adoptZoneOceanSulfurForPlan(client, {
        zoneId: claim.identity.zoneId,
        planId: claim.planId
      });
      await retireSupersededPlanGeneration(
        client,
        claim.identity.zoneId,
        claim.planId
      );
      const preservedAuthority = await client.query<{
        cutover_revision: string | number;
      }>(
        `SELECT cutover.cutover_revision
         FROM population_zone_cutovers_v2 AS cutover
         JOIN population_zone_generations_v2 AS generation
           ON generation.zone_id=cutover.zone_id
          AND generation.plan_id=cutover.selected_plan_id
          AND generation.is_current
          AND generation.status='active'
          AND generation.expires_at > statement_timestamp()
         WHERE cutover.zone_id=$1
           AND cutover.geometry_version=$2
           AND cutover.serving_version='v2'
           AND cutover.status='stable'
           AND cutover.selected_plan_id<>$3::uuid
         FOR UPDATE OF cutover, generation`,
        [
          claim.identity.zoneId,
          claim.identity.geometryVersion,
          claim.planId
        ]
      );
      const preservingActiveGeneration =
        preservedAuthority.rows[0] !== undefined;
      const cutoverRevision = preservingActiveGeneration
        ? Number(preservedAuthority.rows[0]!.cutover_revision)
        : Number((await client.query<{
            cutover_revision: string | number;
          }>(
            `INSERT INTO population_zone_cutovers_v2 (
               zone_id, geometry_version, serving_version, selected_plan_id,
               cutover_revision, status, authorized_by_account_id
             ) VALUES ($1,$2,'v2',$3::uuid,1,'stable',NULL)
             ON CONFLICT (zone_id, geometry_version) DO UPDATE SET
               serving_version='v2',
               selected_plan_id=EXCLUDED.selected_plan_id,
               cutover_revision=
                 population_zone_cutovers_v2.cutover_revision + 1,
               status='stable',
               authorized_by_account_id=NULL,
               updated_at=clock_timestamp()
             RETURNING cutover_revision`,
            [
              claim.identity.zoneId,
              claim.identity.geometryVersion,
              claim.planId
            ]
          )).rows[0]!.cutover_revision);
      if (newMineSlots.length > 0) {
        await insertPlanProjections(
           client,
           { ...plan, slots: newMineSlots },
           cutoverRevision,
           this.mobRegistry.runtimeMobKinds
        );
      }
      if (newSulfurDeposits.length > 0) {
        await insertOceanSulfurProjections(
          client,
          newSulfurDeposits,
          plan.habitat.regionCode,
          plan.identity.candidateLayoutVersion,
          plan.identity.zoneId,
          plan.planId,
          cutoverRevision
        );
      }
      if (!preservingActiveGeneration) {
        await client.query(
          `UPDATE repeatable_resource_nodes AS projection
           SET population_cutover_revision=$2
           FROM population_plan_permanent_resources_v2 AS membership
           WHERE membership.plan_id=$1::uuid
             AND projection.population_v2_entity_id=membership.entity_id`,
          [claim.planId, cutoverRevision]
        );
      }
      const finalized = await client.query(
        `UPDATE population_zones_v2
         SET eligible_land_km2 = $4, tree_km2 = $5, deer_km2 = $6,
             wolf_km2 = $7, ogre_km2 = $8, stone_km2 = $9,
             habitat_summary = $10::jsonb, content_hash = $11,
             habitat_snapshot = $12::jsonb,
             candidate_pool = $13::jsonb,
             nonstone_template_slots = $14::jsonb,
             status = 'ready', claim_owner_id = NULL,
             lease_expires_at = NULL, next_retry_at = NULL,
             last_error = NULL, ready_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE plan_id = $1::uuid AND status = 'generating'
           AND claim_owner_id = $2::uuid AND claim_generation = $3`,
        [
          claim.planId,
          claim.ownerId,
          claim.claimGeneration,
          plan.habitat.eligibleLandKm2,
          plan.habitat.treeKm2,
          plan.habitat.deerKm2,
          plan.habitat.wolfKm2,
          plan.habitat.ogreKm2,
          plan.habitat.stoneKm2,
          JSON.stringify(plan.habitat.habitatSummary),
          plan.contentHash,
          JSON.stringify(plan.habitat),
          JSON.stringify(plan.habitat.candidateSites ?? []),
          JSON.stringify(plan.slots.filter((slot) =>
            !isPermanentMineEntityKind(slot.entityKind)
          ))
        ]
      );
      if (finalized.rowCount !== 1) {
        throw new Error("population plan claim changed during finalization");
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await rollbackQuietly(client);
      throw populationPlanCompletionError(error, claim, plan);
    } finally {
      client.release();
    }
  }

  async failPlan(
    claim: ClaimedPopulationZoneV2Plan,
    error: unknown
  ): Promise<Readonly<{
    accepted: boolean;
    status: "retryable-failure" | "terminal-failure";
    errorCode: PopulationPlanFailureCode;
  }>> {
    const classification = classifyPopulationPlanFailure(error);
    const terminal = !classification.retryable
      || claim.attemptCount >= MAXIMUM_PLAN_ATTEMPTS;
    const status = terminal ? "terminal-failure" : "retryable-failure";
    const result = await this.pool.query(
      `UPDATE population_zones_v2
       SET status = $4, claim_owner_id = NULL, lease_expires_at = NULL,
           next_retry_at = CASE WHEN $5::boolean THEN NULL ELSE
             clock_timestamp()
               + (LEAST(60, POWER(2, LEAST(attempt_count, 6)))
                 * interval '1 second')
           END,
           last_error = $6, updated_at = clock_timestamp()
       WHERE plan_id = $1::uuid AND status = 'generating'
         AND claim_owner_id = $2::uuid AND claim_generation = $3`,
      [
        claim.planId,
        claim.ownerId,
        claim.claimGeneration,
        status,
        terminal,
        `[${classification.code}] ${errorSummary(error)}`
      ]
    );
    return {
      accepted: result.rowCount === 1,
      status,
      errorCode: classification.code
    };
  }

  async repairCompatiblePermanentStonePlanFailures(
    input: Readonly<{ apply: boolean; resumeRepairId?: string }>
  ): Promise<PopulationStoneConflictRepairReceipt> {
    const client = await this.pool.connect();
    const repairId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["population-permanent-stone-conflict-repair-v1"]
      );
      const result = await client.query<StoneConflictRepairCandidateRow>(
        `SELECT failed.plan_id, failed.zone_id, failed.geometry_version,
                failed.world_environment_identity_key,
                failed.world_runtime_sha, failed.plan_version,
                failed.spawn_rules_version,
                failed.environment_profile_version,
                failed.candidate_layout_version,
                failed.respawn_policy_version, failed.region_code,
                failed.status, failed.claim_generation,
                failed.attempt_count, failed.content_hash,
                failed.lease_expires_at, failed.last_error,
                selected.plan_id AS selected_plan_id,
                selected.zone_id AS selected_zone_id,
                selected.geometry_version AS selected_geometry_version,
                selected.spawn_rules_version
                  AS selected_spawn_rules_version,
                selected.world_environment_identity_key
                  AS selected_world_environment_identity_key,
                selected.plan_version AS selected_plan_version,
                selected.environment_profile_version
                  AS selected_environment_profile_version,
                selected.candidate_layout_version
                  AS selected_candidate_layout_version,
                selected.respawn_policy_version
                  AS selected_respawn_policy_version,
                selected.habitat_snapshot AS selected_habitat_snapshot,
                receipt.repair_id AS existing_repair_id
         FROM population_zones_v2 AS failed
         JOIN population_zone_cutovers_v2 AS cutover
           ON cutover.zone_id=failed.zone_id
          AND cutover.geometry_version=failed.geometry_version
         JOIN population_zones_v2 AS selected
           ON selected.plan_id=cutover.selected_plan_id
          AND selected.status='ready'
         LEFT JOIN population_stone_conflict_repair_receipts_v2 AS receipt
           ON receipt.plan_id=failed.plan_id
         WHERE failed.spawn_rules_version=$1
           AND failed.plan_version=$2
           AND failed.candidate_layout_version=$3
           AND failed.world_environment_identity_key=
             selected.world_environment_identity_key
           AND failed.environment_profile_version=
             selected.environment_profile_version
           AND failed.candidate_layout_version=
             selected.candidate_layout_version
           AND failed.respawn_policy_version=
             selected.respawn_policy_version
           AND failed.status IN (
             'generating', 'retryable-failure', 'terminal-failure'
           )
           AND (
             failed.status <> 'generating'
             OR failed.lease_expires_at <= clock_timestamp()
           )
           AND (
             (
               $4::uuid IS NULL
               AND receipt.plan_id IS NULL
               AND (
                 failed.last_error LIKE
                   '%population_spawn_slots_v2_entity_id_key%'
                 OR failed.last_error LIKE
                   '[population-plan-immutable-stone-mismatch] %'
               )
             )
             OR (
               $4::uuid IS NOT NULL
               AND receipt.repair_id=$4::uuid
               AND failed.status='terminal-failure'
               AND failed.last_error=
                 '[population-plan-generation-failure] generated population plan does not match its admission'
             )
           )
         ORDER BY failed.zone_id, failed.plan_id
         FOR UPDATE OF failed`,
        [
          POPULATION_SPAWN_RULES_VERSION,
          POPULATION_PLAN_VERSION,
          POPULATION_CANDIDATE_LAYOUT_VERSION,
          input.resumeRepairId ?? null
        ]
      );
      const affectedPlans: PopulationStoneConflictRepairReceipt[
        "affectedPlans"
      ][number][] = [];
      const existingReceipts = new Set<string>();
      for (const row of result.rows) {
        assertRepairCandidateIdentity(row);
        const record = rowToPlanRecord(row);
        const generated = generatePopulationZonesV2Plans({
          outputZoneIds: [
            record.identity.zoneId as PopulationZoneV2Id
          ],
          worldEnvironmentIdentityKey:
            record.identity.worldEnvironmentIdentityKey,
          worldPipelineSha: record.worldPipelineSha,
          environmentProfileVersion:
            record.identity.environmentProfileVersion,
          habitatForZone: (zoneId) =>
            zoneId === record.identity.zoneId
              ? row.selected_habitat_snapshot
              : populationZoneV3ConservativeHabitat({
                  zoneId,
                  worldEnvironmentIdentityKey:
                    record.identity.worldEnvironmentIdentityKey
                })
        }).find((plan) => plan.planId === record.planId);
        if (!generated) {
          throw new Error(
            `population stone repair could not regenerate ${record.planId}`
          );
        }
        const compatibleEntityIds: string[] = [];
        let fullyCompatible = true;
        const repairClaim: ClaimedPopulationZoneV2Plan = {
          identity: record.identity,
          planId: record.planId,
          ownerId: "00000000-0000-0000-0000-000000000000",
          claimGeneration: record.claimGeneration,
          attemptCount: record.attemptCount
        };
        for (const slot of generated.slots.filter((entry) =>
          isPermanentMineEntityKind(entry.entityKind)
        )) {
          const existing = await loadPermanentMineAuthority(
            client,
            slot.entityId
          );
          if (existing === null) continue;
          try {
            assertCompatiblePermanentMine(
              existing,
              slot,
              repairClaim
            );
          } catch (error) {
            if (
              error instanceof PopulationPlanCompletionError &&
              error.details.code ===
                "population-plan-immutable-stone-mismatch"
            ) {
              fullyCompatible = false;
              break;
            }
            throw error;
          }
          compatibleEntityIds.push(slot.entityId);
        }
        if (!fullyCompatible || compatibleEntityIds.length === 0) continue;
        affectedPlans.push({
          zoneId: record.identity.zoneId,
          planId: record.planId,
          previousStatus: row.status as
            | "generating"
            | "retryable-failure"
            | "terminal-failure",
          previousAttemptCount: row.attempt_count,
          compatibleEntityIds: compatibleEntityIds.sort()
        });
        if (row.existing_repair_id !== null) {
          existingReceipts.add(record.planId);
        }
      }
      if (input.apply) {
        for (const plan of affectedPlans) {
          const reset = await client.query(
            `UPDATE population_zones_v2
             SET status='retryable-failure',
                 claim_owner_id=NULL,
                 lease_expires_at=NULL,
                 attempt_count=0,
                 next_retry_at=clock_timestamp(),
                 last_error=NULL,
                 updated_at=clock_timestamp()
             WHERE plan_id=$1::uuid
               AND spawn_rules_version=$2
               AND status=$3`,
            [
              plan.planId,
              POPULATION_SPAWN_RULES_VERSION,
              plan.previousStatus
            ]
          );
          if (reset.rowCount !== 1) {
            throw new Error(
              `population stone repair candidate changed: ${plan.planId}`
            );
          }
          if (!existingReceipts.has(plan.planId)) {
            await client.query(
              `INSERT INTO population_stone_conflict_repair_receipts_v2 (
                 repair_id, plan_id, zone_id, spawn_rules_version,
                 previous_status, previous_attempt_count,
                 compatible_entity_ids
               ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::uuid[])`,
              [
                repairId,
                plan.planId,
                plan.zoneId,
                POPULATION_SPAWN_RULES_VERSION,
                plan.previousStatus,
                plan.previousAttemptCount,
                plan.compatibleEntityIds
              ]
            );
          }
        }
        await client.query("COMMIT");
      } else {
        await client.query("ROLLBACK");
      }
      return {
        repairId: input.resumeRepairId ?? repairId,
        affectedPlans
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async createCurrentGeneration(input: Readonly<{
    zoneId: string;
    planId: string;
    now?: Date;
    currentReferences?: number;
    replaceExpiredReferencedGeneration?: boolean;
  }>): Promise<PopulationZoneV2GenerationMaterialization> {
    return this.materializeCurrentGeneration(input, false);
  }

  async reconcileCurrentGenerationDensity(input: Readonly<{
    zoneId: string;
    planId: string;
    now?: Date;
    currentReferences?: number;
  }>): Promise<PopulationZoneV2GenerationMaterialization> {
    return this.materializeCurrentGeneration(input, true);
  }

  private async materializeCurrentGeneration(
    input: Readonly<{
      zoneId: string;
      planId: string;
      now?: Date;
      currentReferences?: number;
      replaceExpiredReferencedGeneration?: boolean;
    }>,
    reconcileExisting: boolean
  ): Promise<PopulationZoneV2GenerationMaterialization> {
    const materializationStarted = performance.now();
    const connectionStarted = performance.now();
    let connectionMs = 0;
    let transactionBeginMs = 0;
    let spacingLockMs = 0;
    let currentGenerationLoadMs = 0;
    let templateLoadMs = 0;
    let authorityLoadMs = 0;
    let neighboringContextLoadMs = 0;
    let slotMaterializationMs = 0;
    let generationInsertMs = 0;
    let spawnSlotInsertMs = 0;
    let kindManifestInsertMs = 0;
    let entityStateInsertMs = 0;
    let projectionInsertMs = 0;
    let registeredManifestInsertMs = 0;
    let commitMs = 0;
    const currentReferences = input.currentReferences ?? 0;
    if (
      !Number.isSafeInteger(currentReferences)
      || currentReferences < 0
    ) {
      throw new Error(
        "population generation reference count must be a non-negative integer"
      );
    }
    const client = await this.pool.connect();
    connectionMs = performance.now() - connectionStarted;
    try {
      const transactionBeginStarted = performance.now();
      await client.query("BEGIN");
      transactionBeginMs = performance.now() - transactionBeginStarted;
      const spacingLockStarted = performance.now();
      await lockGenerationSpacingNeighborhood(
        client,
        input.zoneId as PopulationZoneV2Id
      );
      spacingLockMs = performance.now() - spacingLockStarted;
      const currentGenerationLoadStarted = performance.now();
      let current = await loadCurrentGenerationForUpdate(
        client,
        input.zoneId
      );
      currentGenerationLoadMs = performance.now() - currentGenerationLoadStarted;
      const compatibilityNow = input.now ?? new Date();
      const replaceExpiredReferencedGeneration =
        input.replaceExpiredReferencedGeneration === true
        && current !== null
        && current.expiresAt.getTime() <= compatibilityNow.getTime();
      let retiredEntityIds: readonly string[] = [];
      let transferredCurrentReferences = currentReferences;
      if (current !== null) {
        if (
          current.planId !== input.planId
          && current.status === "active"
          && current.expiresAt.getTime() > compatibilityNow.getTime()
        ) {
          const entityIds = await loadGenerationEntityIds(
            client,
            current.generationId
          );
          await client.query("COMMIT");
          return {
            generation: current,
            created: false,
            entityIds,
            shortfallByKind: emptyPopulationDensityShortfall()
          };
        }
        if (
          current.planId !== input.planId
          && current.currentReferenceCount > 0
          && !replaceExpiredReferencedGeneration
        ) {
          throw new Error(
            "population generation replacement is waiting for old-plan references"
          );
        }
        if (
          current.planId !== input.planId
          && !replaceExpiredReferencedGeneration
        ) {
          await removeSupersededCurrentGeneration(client, current);
          current = null;
        }
      }
      if (
        current !== null
        && current.status !== "active"
        && !replaceExpiredReferencedGeneration
      ) {
        const entityIds = await loadGenerationEntityIds(
          client,
          current.generationId
        );
        await client.query("COMMIT");
        return {
          generation: current,
          created: false,
          entityIds,
          shortfallByKind: emptyPopulationDensityShortfall()
        };
      }
      if (
        current !== null
        && current.materializationRevision !==
          POPULATION_GENERATION_MATERIALIZATION_REVISION
        && !replaceExpiredReferencedGeneration
      ) {
        const entityIds = await loadGenerationEntityIds(
          client,
          current.generationId
        );
        await client.query("COMMIT");
        return {
          generation: current,
          created: false,
          entityIds,
          shortfallByKind: emptyPopulationDensityShortfall()
        };
      }
      if (
        current !== null
        && !reconcileExisting
        && !replaceExpiredReferencedGeneration
      ) {
        const entityIds = await loadGenerationEntityIds(
          client,
          current.generationId
        );
        await client.query("COMMIT");
        return {
          generation: current,
          created: false,
          entityIds,
          shortfallByKind: emptyPopulationDensityShortfall()
        };
      }

      const templateLoadStarted = performance.now();
      const templateResult = await client.query<GenerationTemplateRow>(
        `SELECT plan_id, zone_id, geometry_version,
                world_environment_identity_key, world_runtime_sha,
                plan_version, spawn_rules_version, environment_profile_version,
                candidate_layout_version, respawn_policy_version, region_code,
                status, claim_generation, attempt_count, content_hash,
                habitat_snapshot, nonstone_template_slots
         FROM population_zones_v2
         WHERE plan_id=$1::uuid AND zone_id=$2 AND status='ready'
         FOR SHARE`,
        [input.planId, input.zoneId]
      );
      templateLoadMs = performance.now() - templateLoadStarted;
      const templateRow = templateResult.rows[0];
      if (
        templateRow === undefined
        || templateRow.content_hash === null
        || templateRow.habitat_snapshot === null
        || templateRow.nonstone_template_slots === null
      ) {
        throw new Error(
          "population generation requires its matching ready template"
        );
      }
      if (current !== null && replaceExpiredReferencedGeneration) {
        retiredEntityIds = await loadGenerationEntityIds(
          client,
          current.generationId
        );
        transferredCurrentReferences = Math.max(
          current.currentReferenceCount,
          currentReferences
        );
        await removeExpiredReferencedCurrentGeneration(
          client,
          current,
          compatibilityNow
        );
        current = null;
      }
      if (current !== null) {
        const existingSlots = await loadGenerationSlots(
          client,
          current.generationId
        );
        const partialSapCrawlerCandidateIds =
          incompleteSapCrawlerGroupCandidateIds(existingSlots);
        if (partialSapCrawlerCandidateIds.length > 0) {
          warnPopulationInvariantOnce(
            `partial-sap-crawler-group:${current.generationId}`,
            "partial Resin Crawler group detected; generation replacement "
              + `required for zone ${input.zoneId}`
          );
          if (current.currentReferenceCount > 0) {
            throw new Error(
              "population generation replacement is waiting for partial "
                + "Resin Crawler group references"
            );
          }
          await removeSupersededCurrentGeneration(client, current);
          current = null;
        }
      }
      if (
        current !== null &&
        current.status === "active" &&
        current.densityRevision === POPULATION_DENSITY_REVISION &&
        current.planContentHash === templateRow.content_hash &&
        current.candidateLayoutVersion ===
          POPULATION_CANDIDATE_LAYOUT_VERSION &&
        current.materializationRevision ===
          POPULATION_GENERATION_MATERIALIZATION_REVISION
      ) {
        const entityIds = await loadGenerationEntityIds(
          client,
          current.generationId
        );
        await client.query("COMMIT");
        return {
          generation: current,
          created: false,
          entityIds,
          shortfallByKind: emptyPopulationDensityShortfall()
        };
      }
      const authorityLoadStarted = performance.now();
      const authority = await client.query<{
        cutover_revision: string | number;
        selected_plan_id: string;
      }>(
        `SELECT cutover_revision, selected_plan_id
         FROM population_zone_cutovers_v2
         WHERE zone_id=$1 AND geometry_version=$2
           AND serving_version='v2' AND status='stable'
         FOR UPDATE`,
        [input.zoneId, templateRow.geometry_version]
      );
      authorityLoadMs = performance.now() - authorityLoadStarted;
      if (authority.rows[0] === undefined) {
        throw new Error(
          "population generation requires current V2 zone authority"
        );
      }
      let cutoverRevision = Number(authority.rows[0].cutover_revision);
      if (authority.rows[0].selected_plan_id !== input.planId) {
        await adoptZonePermanentMinesForPlan(client, {
          zoneId: input.zoneId,
          planId: input.planId
        });
        await adoptZoneOceanSulfurForPlan(client, {
          zoneId: input.zoneId,
          planId: input.planId
        });
        const selected = await client.query<{
          cutover_revision: string | number;
        }>(
          `UPDATE population_zone_cutovers_v2
           SET selected_plan_id=$3::uuid,
               cutover_revision=cutover_revision + 1,
               authorized_by_account_id=NULL,
               updated_at=clock_timestamp()
           WHERE zone_id=$1 AND geometry_version=$2
             AND serving_version='v2' AND status='stable'
           RETURNING cutover_revision`,
          [input.zoneId, templateRow.geometry_version, input.planId]
        );
        cutoverRevision = Number(selected.rows[0]!.cutover_revision);
        await client.query(
          `UPDATE repeatable_resource_nodes AS projection
           SET population_cutover_revision=$2
           FROM population_plan_permanent_resources_v2 AS membership
           WHERE membership.plan_id=$1::uuid
             AND projection.population_v2_entity_id=membership.entity_id`,
          [input.planId, cutoverRevision]
        );
      }
      const generationNumber = current?.generationNumber ?? Number(
        (await client.query<{ generation_number: string | number }>(
          `SELECT COALESCE(max(generation_number),0) + 1 AS generation_number
           FROM population_zone_generations_v2
           WHERE zone_id=$1`,
          [input.zoneId]
        )).rows[0]!.generation_number
      );
      const planRecord = rowToPlanRecord(templateRow);
      const generationId = populationZoneV2GenerationId({
        identity: planRecord.identity,
        generationNumber
      });
      const template: GeneratedPopulationZoneV2Plan = {
        identity: planRecord.identity,
        planId: planRecord.planId,
        worldPipelineSha: planRecord.worldPipelineSha,
        geometry: populationZoneV2Geometry(
          input.zoneId as PopulationZoneV2Id
        ),
        habitat: templateRow.habitat_snapshot,
        slots: templateRow.nonstone_template_slots,
        contentHash: templateRow.content_hash
      };
      const neighboringContextLoadStarted = performance.now();
      const neighboringContexts =
        await loadNeighborGenerationContexts(client, {
          zoneId: input.zoneId as PopulationZoneV2Id
        });
      neighboringContextLoadMs = performance.now() - neighboringContextLoadStarted;
      const neighborGenerationIdsByZone: Record<
        string,
        readonly string[]
      > = {};
      const neighborHabitatsByZone = new Map<
        PopulationZoneV2Id,
        PopulationZoneV2Habitat
      >();
      for (const context of neighboringContexts) {
        const identity = rowToPlanRecord(context).identity;
        const nextGenerationId = populationZoneV2GenerationId({
          identity,
          generationNumber: Number(context.next_generation_number)
        });
        neighborGenerationIdsByZone[context.zone_id] = [
          ...new Set([
            ...(context.current_generation_id === null
              ? []
              : [context.current_generation_id]),
            nextGenerationId
          ])
        ].sort();
        neighborHabitatsByZone.set(
          context.zone_id as PopulationZoneV2Id,
          context.habitat_snapshot
        );
      }
      const slotMaterializationStarted = performance.now();
      const legacyGenerationSlots = this.generationSlotGenerator({
        template,
        generationId,
        generationNumber,
        neighborGenerationIdsByZone,
        neighborHabitatsByZone,
        ...(current === null ? { includeLegacySapCrawler: false } : {})
      });
      let generationSlots = legacyGenerationSlots;
      let registeredMobManifest:
        PopulationV2RegisteredMobOverlayResult<string> | null = null;
      let encounterDiagnostics: PopulationV2EncounterDiagnostics | undefined;
      let registeredMobPlacementRevisionsByEntityId:
        ReadonlyMap<string, string> = new Map();
      if (
        current === null
        || current.materializationRevision ===
          POPULATION_GENERATION_MATERIALIZATION_REVISION
      ) {
        const baselineSlots = legacyGenerationSlots.slots.filter((slot) =>
          slot.entityKind === "tree" || slot.entityKind === "flax"
        );
        const ownedCandidateSites = template.habitat.candidateSites?.filter(
          (site) =>
            populationZoneV2IdForPoint(site.position) === input.zoneId
        );
        const overlayHabitat = ownedCandidateSites === undefined
          ? template.habitat
          : {
              ...template.habitat,
              candidateSites: ownedCandidateSites
            };
        const encounterMaterialization = materializePopulationV2EncounterTables({
          generationId,
          habitat: overlayHabitat,
          registry: this.mobRegistry
        });
        registeredMobManifest = encounterMaterialization;
        encounterDiagnostics = encounterMaterialization.diagnostics;
        // Independently budgeted overlay mobs are planned after the frozen baseline and the encounter
        // table, with both as occupied input: nothing already placed is moved, added to or removed.
        if (this.mobRegistry.definitions.some((definition) =>
          definition.generationPlacement === "registered_overlay"
        )) {
          // Same occupancy as existing-generation top-up: the plan's stones plus neighbouring
          // zones' stones and current-generation slots within the spacing distance.
          const persisted = await loadPopulationV2OccupiedSlots(client, {
            generationId,
            planId: input.planId,
            generationNumber
          });
          const overlay = planPopulationV2RegisteredMobOverlay({
            generationId,
            habitat: overlayHabitat,
            occupiedSlots: [
              ...baselineSlots,
              ...encounterMaterialization.slots,
              ...persisted.occupiedSlots
            ],
            spacingOccupants: persisted.spacingOccupants,
            mode: "next_generation",
            registry: this.mobRegistry
          });
          registeredMobManifest = {
            ...encounterMaterialization,
            status: overlay.status === "terminal_partial_group"
              ? "terminal_partial_group"
              : encounterMaterialization.status,
            slots: [...encounterMaterialization.slots, ...overlay.slots]
              .sort((left, right) => left.entityId.localeCompare(right.entityId)),
            mobs: [...encounterMaterialization.mobs, ...overlay.mobs],
            terminalPartialGroups: overlay.terminalPartialGroups
          };
        }
        if (registeredMobManifest.status === "terminal_partial_group") {
          throw new Error(
            "new Population V2 generation produced a partial registered-mob group"
          );
        }
        const registeredSlots = registeredMobManifest.slots.map(
          populationV2PlanSlotFromRegisteredMob
        );
        registeredMobPlacementRevisionsByEntityId = new Map(
          registeredMobManifest.slots.map((slot) => [
            slot.entityId,
            slot.placementRevision
          ])
        );
        const slots = [...baselineSlots, ...registeredSlots].sort(
          (left, right) => left.entityId.localeCompare(right.entityId)
        );
        const shortfallByKind:
          typeof legacyGenerationSlots.shortfallByKind
          & Record<string, number> = {
          ...legacyGenerationSlots.shortfallByKind
        };
        for (const mob of registeredMobManifest.mobs) {
          const definition = this.mobRegistry.requireDefinition(mob.mobKind);
          shortfallByKind[
            definition.legacyIdentity?.planKind ?? definition.mobKind
          ] = mob.shortfall.groups;
        }
        generationSlots = {
          ...legacyGenerationSlots,
          slots,
          plannedNonStoneCount: slots.length,
          shortfallByKind
        };
      }
      slotMaterializationMs = performance.now() - slotMaterializationStarted;
      if (current !== null) {
        const existingSlots = await loadGenerationSlots(
          client,
          current.generationId
        );
        const reconciliation = reconcilePopulationZoneV2GenerationSlots({
          existingSlots,
          desiredSlots: generationSlots.slots
        });
        if (reconciliation.shortfallByKind.sap_crawler_group > 0) {
          warnPopulationInvariantOnce(
            `sap-crawler-reconciliation:${current.generationId}`,
            "Resin Crawler generation reconciliation left "
              + `${reconciliation.shortfallByKind.sap_crawler_group} `
              + `group(s) short for zone ${input.zoneId}`
          );
        }
        if (reconciliation.slotsToInsert.length > 0) {
          const updated = await client.query<GenerationRow>(
            `UPDATE population_zone_generations_v2
             SET planned_nonstone_count=$2, updated_at=clock_timestamp()
             WHERE generation_id=$1::uuid AND is_current
               AND status='active'
             RETURNING generation_id, zone_id, plan_id, generation_number,
                       generated_at, expires_at, status,
                       planned_nonstone_count, current_reference_count,
                       unreferenced_at, is_current, cleaned_at`,
            [
              current.generationId,
              reconciliation.plannedNonStoneCount
            ]
          );
          if (updated.rows[0] === undefined) {
            throw new Error(
              "current population generation changed during reconciliation"
            );
          }
          await insertSpawnSlots(client, {
            planId: input.planId,
            generationId,
            slots: reconciliation.slotsToInsert
          });
          await client.query(
            `INSERT INTO population_entity_state_v2 (entity_id, state)
             SELECT entity_id, 'ready'
             FROM population_spawn_slots_v2
             WHERE generation_id=$1::uuid
               AND entity_id=ANY($2::uuid[])`,
            [
              generationId,
              reconciliation.slotsToInsert.map((slot) => slot.entityId)
            ]
          );
          await insertPlanProjections(
             client,
             { ...template, slots: reconciliation.slotsToInsert },
             cutoverRevision,
             this.mobRegistry.runtimeMobKinds
          );
          current = rowToGeneration(updated.rows[0]);
        }
        const identityUpdate = await client.query<GenerationRow>(
          `UPDATE population_zone_generations_v2
           SET density_revision=$2,
               plan_content_hash=$3,
               candidate_layout_version=$4,
               materialization_revision=$5,
               updated_at=clock_timestamp()
           WHERE generation_id=$1::uuid AND is_current AND status='active'
           RETURNING generation_id, zone_id, plan_id, generation_number,
                     generated_at, expires_at, status,
                     planned_nonstone_count, current_reference_count,
                     unreferenced_at, is_current, cleaned_at,
                     density_revision, plan_content_hash,
                     candidate_layout_version, materialization_revision,
                     common_schema_revision`,
          [
            current.generationId,
            POPULATION_DENSITY_REVISION,
            templateRow.content_hash,
            POPULATION_CANDIDATE_LAYOUT_VERSION,
            reconciliation.shortfallByKind.sap_crawler_group === 0
              ? POPULATION_GENERATION_MATERIALIZATION_REVISION
              : current.materializationRevision ?? null
          ]
        );
        if (identityUpdate.rows[0]) {
          current = rowToGeneration(identityUpdate.rows[0]);
        }
        const entityIds = await loadGenerationEntityIds(
          client,
          current.generationId
        );
        await client.query("COMMIT");
        return {
          generation: current,
          created: false,
          entityIds,
          shortfallByKind: reconciliation.shortfallByKind
        };
      }
      const generatedAt = input.now ?? (await client.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now"
      )).rows[0]!.now;
      assertValidDate(generatedAt, "population generation timestamp");
      const expiresAt = new Date(
        generatedAt.getTime() + POPULATION_ZONE_V2_GENERATION_DURATION_MS
      );
      const generationInsertStarted = performance.now();
      const inserted = await client.query<GenerationRow>(
        `INSERT INTO population_zone_generations_v2 (
           generation_id, zone_id, plan_id, generation_number,
           generated_at, expires_at, status, planned_nonstone_count,
           current_reference_count, is_current, density_revision,
           plan_content_hash, candidate_layout_version,
           materialization_revision, common_schema_revision
         ) VALUES (
           $1::uuid,$2,$3::uuid,$4,$5,$6,'active',$7,$8,true,$9,$10,$11,$12,$13
         )
         RETURNING generation_id, zone_id, plan_id, generation_number,
                   generated_at, expires_at, status,
                   planned_nonstone_count, current_reference_count,
                   unreferenced_at, is_current, cleaned_at,
                   density_revision, plan_content_hash,
                   candidate_layout_version, materialization_revision,
                   common_schema_revision`,
        [
          generationId,
          input.zoneId,
          input.planId,
          generationNumber,
          generatedAt,
          expiresAt,
          generationSlots.plannedNonStoneCount,
          transferredCurrentReferences,
          POPULATION_DENSITY_REVISION,
          templateRow.content_hash,
          POPULATION_CANDIDATE_LAYOUT_VERSION,
          POPULATION_GENERATION_MATERIALIZATION_REVISION,
          POPULATION_COMMON_SCHEMA_REVISION
        ]
      );
      generationInsertMs = performance.now() - generationInsertStarted;
      const spawnSlotInsertStarted = performance.now();
      await insertSpawnSlots(client, {
        planId: input.planId,
        generationId,
        slots: generationSlots.slots
      });
      spawnSlotInsertMs = performance.now() - spawnSlotInsertStarted;
      const kindManifestInsertStarted = performance.now();
      await insertGenerationKindManifest(client, {
        generationId,
        slots: generationSlots.slots,
        registry: this.mobRegistry.populationKinds,
        recordedAt: generatedAt
      });
      kindManifestInsertMs = performance.now() - kindManifestInsertStarted;
      if (generationSlots.slots.length > 0) {
        const entityStateInsertStarted = performance.now();
        await client.query(
          `INSERT INTO population_entity_state_v2 (entity_id, state)
           SELECT entity_id, 'ready'
           FROM population_spawn_slots_v2
           WHERE generation_id=$1::uuid`,
          [generationId]
        );
        entityStateInsertMs = performance.now() - entityStateInsertStarted;
        const projectionInsertStarted = performance.now();
        await insertPlanProjections(
           client,
           { ...template, slots: generationSlots.slots },
           cutoverRevision,
           this.mobRegistry.runtimeMobKinds,
           registeredMobPlacementRevisionsByEntityId
        );
        projectionInsertMs = performance.now() - projectionInsertStarted;
      }
      if (registeredMobManifest !== null) {
        const registeredManifestInsertStarted = performance.now();
        await insertGenerationRegisteredMobManifest(client, {
          generationId,
          manifest: registeredMobManifest,
          attemptedAt: generatedAt
        });
        registeredManifestInsertMs = performance.now() - registeredManifestInsertStarted;
      }
      const commitStarted = performance.now();
      await client.query("COMMIT");
      commitMs = performance.now() - commitStarted;
      const totalMs = performance.now() - materializationStarted;
      const accountedMs = connectionMs
        + transactionBeginMs
        + spacingLockMs
        + currentGenerationLoadMs
        + templateLoadMs
        + authorityLoadMs
        + neighboringContextLoadMs
        + slotMaterializationMs
        + generationInsertMs
        + spawnSlotInsertMs
        + kindManifestInsertMs
        + entityStateInsertMs
        + projectionInsertMs
        + registeredManifestInsertMs
        + commitMs;
      const timingDetails = {
        zoneId: input.zoneId,
        planId: input.planId,
        status: "created",
        slotCount: generationSlots.slots.length,
        connectionMs,
        transactionBeginMs,
        spacingLockMs,
        currentGenerationLoadMs,
        templateLoadMs,
        authorityLoadMs,
        neighboringContextLoadMs,
        slotMaterializationMs,
        generationInsertMs,
        spawnSlotInsertMs,
        kindManifestInsertMs,
        entityStateInsertMs,
        projectionInsertMs,
        registeredManifestInsertMs,
        commitMs,
        otherMaterializationMs: Math.max(0, totalMs - accountedMs),
        totalMaterializationMs: totalMs
      };
      gameplayLatencyTrace.recordActive({
        traceId: generationId,
        source: "game",
        category: "population",
        name: "population_zone_generation_materialization_breakdown",
        details: timingDetails
      });
      this.options.logger?.info?.(
        timingDetails,
        "population zone generation materialization breakdown"
      );
      return {
        generation: rowToGeneration(inserted.rows[0]!),
        created: true,
        entityIds: generationSlots.slots.map((slot) => slot.entityId),
        ...(retiredEntityIds.length === 0
          ? {}
          : { retiredEntityIds }),
        shortfallByKind: generationSlots.shortfallByKind,
        ...(encounterDiagnostics === undefined
          ? {}
          : { encounterDiagnostics })
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadCurrentGenerations(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2GenerationRecord[]> {
    if (zoneIds.length === 0) return [];
    const result = await this.pool.query<GenerationRow>(
      `SELECT generation_id, zone_id, plan_id, generation_number,
              generated_at, expires_at, status, planned_nonstone_count,
              current_reference_count, unreferenced_at,
              is_current, cleaned_at, density_revision,
              plan_content_hash, candidate_layout_version,
              materialization_revision, common_schema_revision
       FROM population_zone_generations_v2
       WHERE zone_id=ANY($1::text[]) AND is_current
       ORDER BY zone_id`,
      [[...new Set(zoneIds)].sort()]
    );
    return result.rows.map(rowToGeneration);
  }

  async loadCurrentServingPlanGenerations(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2GenerationRecord[]> {
    if (zoneIds.length === 0) return [];
    const result = await this.pool.query<GenerationRow>(
      `SELECT generation.generation_id, generation.zone_id,
              generation.plan_id, generation.generation_number,
              generation.generated_at, generation.expires_at,
              generation.status, generation.planned_nonstone_count,
              generation.current_reference_count,
              generation.unreferenced_at, generation.is_current,
              generation.cleaned_at, generation.density_revision,
              generation.plan_content_hash,
              generation.candidate_layout_version,
              generation.materialization_revision,
              generation.common_schema_revision,
              cutover.cutover_revision
       FROM population_zone_generations_v2 AS generation
       JOIN population_zones_v2 AS plan
         ON plan.plan_id=generation.plan_id
        AND plan.zone_id=generation.zone_id
        AND plan.status='ready'
       JOIN population_zone_cutovers_v2 AS cutover
         ON cutover.zone_id=plan.zone_id
        AND cutover.geometry_version=plan.geometry_version
        AND cutover.selected_plan_id=plan.plan_id
        AND cutover.serving_version='v2'
        AND cutover.status='stable'
       WHERE generation.zone_id=ANY($1::text[])
         AND generation.is_current
       ORDER BY generation.zone_id`,
      [[...new Set(zoneIds)].sort()]
    );
    return result.rows.map(rowToGeneration);
  }

  async loadMaterializationDiagnostics(
    compatibleMaterializationRevisions: readonly string[],
    limit = 128
  ): Promise<PopulationV2MaterializationDiagnostics> {
    const compatible = [...new Set(
      compatibleMaterializationRevisions.map((revision) => revision.trim())
    )].filter(Boolean).sort();
    if (compatible.length === 0) {
      throw new Error(
        "population materialization diagnostics require compatible revisions"
      );
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new Error(
        "population materialization diagnostics limit must be 1 through 1000"
      );
    }
    const [counts, commonSchemaCounts, kindManifestCounts, guarded] =
      await Promise.all([
      this.pool.query<{
        materialization_revision: string;
        generation_count: string | number;
      }>(
        `SELECT COALESCE(
                  materialization_revision,
                  'legacy-unverified'
                ) AS materialization_revision,
                count(*)::text AS generation_count
         FROM population_zone_generations_v2
         WHERE is_current
           AND status='active'
           AND expires_at > statement_timestamp()
         GROUP BY COALESCE(
           materialization_revision,
           'legacy-unverified'
         )
         ORDER BY materialization_revision`
      ),
      this.pool.query<{
        common_schema_revision: string;
        generation_count: string | number;
      }>(
        `SELECT COALESCE(
                  common_schema_revision,
                  CASE
                    WHEN materialization_revision=ANY($1::text[])
                      THEN $2
                    ELSE 'legacy-unverified'
                  END
                ) AS common_schema_revision,
                count(*)::text AS generation_count
         FROM population_zone_generations_v2
         WHERE is_current
           AND status='active'
           AND expires_at > statement_timestamp()
         GROUP BY 1
         ORDER BY 1`,
        [compatible, POPULATION_COMMON_SCHEMA_REVISION]
      ),
      this.pool.query<{
        manifest_revision: string;
        generation_count: string | number;
      }>(
        `SELECT manifest.kind_key || '@'
                  || manifest.placement_revision || '/'
                  || manifest.lifecycle_revision AS manifest_revision,
                count(DISTINCT manifest.generation_id)::text
                  AS generation_count
         FROM population_generation_kind_manifest_v2 AS manifest
         JOIN population_zone_generations_v2 AS generation
           ON generation.generation_id=manifest.generation_id
          AND generation.is_current
          AND generation.status='active'
          AND generation.expires_at > statement_timestamp()
         GROUP BY manifest.kind_key, manifest.placement_revision,
                  manifest.lifecycle_revision
         ORDER BY manifest_revision`
      ),
      this.pool.query<{
        zone_id: string;
        generation_id: string;
        materialization_revision: string;
        expires_at: Date;
        planned_nonstone_count: number;
        current_reference_count: number;
      }>(
        `SELECT generation.zone_id, generation.generation_id,
                COALESCE(
                  generation.materialization_revision,
                  'legacy-unverified'
                ) AS materialization_revision,
                generation.expires_at,
                generation.planned_nonstone_count,
                generation.current_reference_count
         FROM population_zone_generations_v2 AS generation
         JOIN population_zones_v2 AS plan
           ON plan.plan_id=generation.plan_id
          AND plan.zone_id=generation.zone_id
          AND plan.status='ready'
         JOIN population_zone_cutovers_v2 AS cutover
           ON cutover.zone_id=plan.zone_id
          AND cutover.geometry_version=plan.geometry_version
          AND cutover.selected_plan_id=plan.plan_id
          AND cutover.serving_version='v2'
          AND cutover.status='stable'
         WHERE generation.is_current
           AND generation.status='active'
           AND generation.expires_at > statement_timestamp()
           AND NOT (
             COALESCE(
               generation.materialization_revision,
               'legacy-unverified'
             ) = ANY($1::text[])
           )
         ORDER BY generation.zone_id
         LIMIT $2`,
        [compatible, limit]
      )
    ]);
    return {
      activeCurrentCountsByRevision: Object.fromEntries(
        counts.rows.map((row) => [
          row.materialization_revision,
          Number(row.generation_count)
        ])
      ),
      activeCurrentCountsByCommonSchemaRevision: Object.fromEntries(
        commonSchemaCounts.rows.map((row) => [
          row.common_schema_revision,
          Number(row.generation_count)
        ])
      ),
      activeCurrentCountsByKindManifestRevision: Object.fromEntries(
        kindManifestCounts.rows.map((row) => [
          row.manifest_revision,
          Number(row.generation_count)
        ])
      ),
      guardedActiveGenerations: guarded.rows.map((row) => ({
        zoneId: row.zone_id,
        generationId: row.generation_id,
        materializationRevision: row.materialization_revision,
        expiresAt: row.expires_at,
        plannedNonStoneCount: row.planned_nonstone_count,
        currentReferenceCount: row.current_reference_count
      }))
    };
  }

  async loadDueCurrentGenerations(input: Readonly<{
    now?: Date;
    limit?: number;
    after?: Readonly<{
      expiresAt: Date;
      zoneId: string;
    }>;
  }> = {}): Promise<PopulationZoneV2GenerationRecord[]> {
    const now = input.now ?? new Date();
    const limit = input.limit ?? 128;
    assertValidDate(now, "population generation sweep timestamp");
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(
        "population generation sweep limit must be a positive integer"
      );
    }
    if (input.after !== undefined) {
      assertValidDate(
        input.after.expiresAt,
        "population generation sweep cursor"
      );
    }
    const result = await this.pool.query<GenerationRow>(
      `SELECT generation_id, zone_id, plan_id, generation_number,
              generated_at, expires_at, status, planned_nonstone_count,
              current_reference_count, unreferenced_at,
              is_current, cleaned_at, density_revision,
              plan_content_hash, candidate_layout_version,
              materialization_revision, common_schema_revision
       FROM population_zone_generations_v2
       WHERE is_current AND expires_at <= $1
         AND (
           $3::timestamptz IS NULL
           OR (expires_at, zone_id) > ($3::timestamptz, $4::text)
         )
       ORDER BY expires_at, zone_id
       LIMIT $2`,
      [
        now,
        limit,
        input.after?.expiresAt ?? null,
        input.after?.zoneId ?? null
      ]
    );
    return result.rows.map(rowToGeneration);
  }

  async updateCurrentGenerationReferences(input: Readonly<{
    references: readonly Readonly<{
      zoneId: string;
      currentReferences: number;
      unreferencedAt?: Date;
    }>[];
    now?: Date;
  }>): Promise<number> {
    if (input.references.length === 0) return 0;
    const now = input.now ?? new Date();
    assertValidDate(now, "population reference synchronization timestamp");
    const references = new Map<string, Readonly<{
      zoneId: string;
      currentReferences: number;
      unreferencedAt?: Date;
    }>>();
    for (const reference of input.references) {
      if (
        !Number.isSafeInteger(reference.currentReferences)
        || reference.currentReferences < 0
      ) {
        throw new Error(
          "population generation reference count must be a non-negative integer"
        );
      }
      if (reference.unreferencedAt !== undefined) {
        assertValidDate(
          reference.unreferencedAt,
          "population unreferenced timestamp"
        );
        if (reference.unreferencedAt.getTime() > now.getTime()) {
          throw new Error(
            "population unreferenced timestamp cannot be in the future"
          );
        }
      }
      references.set(reference.zoneId, reference);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let updated = 0;
      for (const reference of [...references.values()].sort((left, right) =>
        left.zoneId.localeCompare(right.zoneId)
      )) {
        await lockGenerationLifecycle(client, reference.zoneId);
        const result = await client.query(
          `UPDATE population_zone_generations_v2
           SET current_reference_count=$2,
               status=CASE
                 WHEN expires_at > $4::timestamptz THEN status
                 WHEN $2::integer > 0 THEN 'refresh-pending'
                 ELSE 'expired'
               END,
               unreferenced_at=CASE
                 WHEN $2::integer > 0 THEN NULL
                 ELSE COALESCE(
                   unreferenced_at,
                   $3::timestamptz,
                   $4::timestamptz
                 )
               END,
               updated_at=clock_timestamp()
           WHERE zone_id=$1 AND is_current`,
          [
            reference.zoneId,
            reference.currentReferences,
            reference.unreferencedAt ?? null,
            now
          ]
        );
        updated += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markGenerationExpired(input: Readonly<{
    zoneId: string;
    generationId: string;
    currentReferences: number;
    now?: Date;
    unreferencedAt?: Date;
  }>): Promise<PopulationZoneV2GenerationRecord | null> {
    if (
      !Number.isSafeInteger(input.currentReferences)
      || input.currentReferences < 0
    ) {
      throw new Error(
        "population generation reference count must be a non-negative integer"
      );
    }
    const now = input.now ?? new Date();
    assertValidDate(now, "population expiration timestamp");
    const unreferencedAt = input.currentReferences === 0
      ? (input.unreferencedAt ?? now)
      : null;
    if (unreferencedAt !== null) {
      assertValidDate(
        unreferencedAt,
        "population unreferenced timestamp"
      );
      if (unreferencedAt.getTime() > now.getTime()) {
        throw new Error(
          "population unreferenced timestamp cannot be in the future"
        );
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockGenerationLifecycle(client, input.zoneId);
      const current = await loadCurrentGenerationForUpdate(
        client,
        input.zoneId
      );
      if (
        current === null
        || current.generationId !== input.generationId
      ) {
        await client.query("COMMIT");
        return null;
      }
      if (current.expiresAt.getTime() > now.getTime()) {
        await client.query("COMMIT");
        return current;
      }
      const result = await client.query<GenerationRow>(
        `UPDATE population_zone_generations_v2
         SET status=$3,
             current_reference_count=$4,
             unreferenced_at=CASE
               WHEN $4::integer > 0 THEN NULL
               ELSE COALESCE(unreferenced_at, $5::timestamptz)
             END,
             updated_at=clock_timestamp()
         WHERE zone_id=$1 AND generation_id=$2::uuid AND is_current
         RETURNING generation_id, zone_id, plan_id, generation_number,
                   generated_at, expires_at, status,
                   planned_nonstone_count, current_reference_count,
                   unreferenced_at, is_current, cleaned_at`,
        [
          input.zoneId,
          input.generationId,
          input.currentReferences > 0 ? "refresh-pending" : "expired",
          input.currentReferences,
          unreferencedAt
        ]
      );
      await client.query("COMMIT");
      return result.rows[0] === undefined
        ? null
        : rowToGeneration(result.rows[0]);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupExpiredGeneration(input: Readonly<{
    zoneId: string;
    generationId: string;
    unreferenced: boolean;
    now?: Date;
    graceMs?: number;
  }>): Promise<boolean> {
    if (!input.unreferenced) {
      throw new Error(
        "population generation cleanup requires an unreferenced zone"
      );
    }
    const now = input.now ?? new Date();
    const graceMs = input.graceMs
      ?? POPULATION_ZONE_V2_GENERATION_CLEANUP_GRACE_MS;
    assertValidDate(now, "population cleanup timestamp");
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
      throw new Error(
        "population generation cleanup grace must be non-negative"
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockGenerationLifecycle(client, input.zoneId);
      const current = await loadCurrentGenerationForUpdate(
        client,
        input.zoneId
      );
      if (
        current === null
        || current.generationId !== input.generationId
        || current.status !== "expired"
        || current.currentReferenceCount !== 0
        || current.unreferencedAt === null
        || now.getTime() < Math.max(
          current.expiresAt.getTime(),
          current.unreferencedAt.getTime()
        ) + graceMs
      ) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE population_zone_generations_v2
         SET status='expired', current_reference_count=0,
             updated_at=clock_timestamp()
         WHERE generation_id=$1::uuid`,
        [input.generationId]
      );
      for (const table of [
        "collectible_nodes",
        "generated_world_mobs"
      ] as const) {
        await client.query(
          `DELETE FROM ${table} AS projection
           USING population_spawn_slots_v2 AS slot
           WHERE projection.population_v2_entity_id=slot.entity_id
             AND slot.generation_id=$1::uuid`,
          [input.generationId]
        );
      }
      await client.query(
        `DELETE FROM population_runtime_entity_leases_v2 AS lease
         USING population_spawn_slots_v2 AS slot
         WHERE lease.entity_id=slot.entity_id
           AND slot.generation_id=$1::uuid`,
        [input.generationId]
      );
      await client.query(
        `DELETE FROM population_entity_state_v2 AS state
         USING population_spawn_slots_v2 AS slot
         WHERE state.entity_id=slot.entity_id
           AND slot.generation_id=$1::uuid`,
        [input.generationId]
      );
      await client.query(
        `DELETE FROM population_spawn_slots_v2
         WHERE generation_id=$1::uuid`,
        [input.generationId]
      );
      const cleaned = await client.query(
        `UPDATE population_zone_generations_v2
         SET is_current=false, status='expired',
             current_reference_count=0, cleaned_at=$2,
             updated_at=clock_timestamp()
         WHERE generation_id=$1::uuid AND is_current`,
        [input.generationId, now]
      );
      await client.query("COMMIT");
      return cleaned.rowCount === 1;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadReadyEntitiesForZones(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2ReadyEntity[]> {
    if (zoneIds.length === 0) return [];
    const result = await this.pool.query<{
      plan_id: string;
      zone_id: string;
      generation_id: string | null;
      cutover_revision: string | number;
      slot_id: string;
      entity_id: string;
      entity_kind: PopulationZoneV2EntityKind;
      archetype: string;
      encounter_id: string | null;
      pack_id: string | null;
      pack_member_index: number | null;
      latitude: number | string;
      longitude: number | string;
      anchor_latitude: number | string;
      anchor_longitude: number | string;
      environment_snapshot: Record<string, unknown>;
      suppression_class: PopulationZoneV2SuppressionClass;
      state_revision: string | number;
      durable_runtime_state: Record<string, unknown>;
      resin_harvested_life_revision: string | number | null;
      sap_harvested_at: Date | null;
      combat_level: string | number | null;
      combat_tier: MobChallengeTier | null;
      combat_balance_version: string | number | null;
      combat_profile_source:
        | "zone_player_profile"
        | "background_fallback"
        | null;
    }>(
      POPULATION_V2_READY_ENTITIES_SQL,
      [[...new Set(zoneIds)].sort(), POPULATION_ZONE_V2_GEOMETRY_VERSION]
    );
    return result.rows.map((row) => ({
      planId: row.plan_id,
      zoneId: row.zone_id,
      generationId: row.generation_id,
      cutoverRevision: Number(row.cutover_revision),
      slotId: row.slot_id,
      entityId: row.entity_id,
      entityKind: row.entity_kind,
      archetype: row.archetype,
      encounterId: row.encounter_id,
      packId: row.pack_id,
      packMemberIndex: row.pack_member_index,
      lat: Number(row.latitude),
      lon: Number(row.longitude),
      anchorLat: Number(row.anchor_latitude),
      anchorLon: Number(row.anchor_longitude),
      environmentSnapshot: row.environment_snapshot,
      suppressionClass: row.suppression_class,
      stateRevision: Number(row.state_revision),
      durableRuntimeState: row.durable_runtime_state,
      ...(row.combat_level === null
        ? {}
        : {
            combatLevel: Number(row.combat_level),
            combatTier: row.combat_tier!,
            combatBalanceVersion: Number(row.combat_balance_version),
            combatProfileSource: row.combat_profile_source!
          }),
      ...(row.entity_kind === "tree"
        ? {
            berryAvailable:
              treeVarietyForStableId(row.entity_id) === "giving_tree"
              && isGivingTreeResinCapable(row.entity_id)
              && (row.resin_harvested_life_revision === null
                || Number(row.resin_harvested_life_revision) !== Number(row.state_revision)),
            resinAvailable: false,
            ...(isElderFern(row.entity_id)
              ? {
                  sapReadyAt: row.sap_harvested_at === null
                    ? null
                    : new Date(row.sap_harvested_at.getTime() + ELDER_FROND_SAP_REFILL_MS).toISOString()
                }
              : {})
          }
        : {})
    }));
  }

  async claimMobCombatProfilesForZones(
    claims: readonly PopulationZoneV2MobCombatProfileClaim[]
  ): Promise<number> {
    if (claims.length === 0) return 0;
    const normalized = [...new Map(claims.map((claim) => [
      claim.zoneId,
      {
        ...claim,
        level: Math.max(0, Math.min(MAX_EQUIPMENT_LEVEL, Math.trunc(claim.level)))
      }
    ])).values()].sort((left, right) => left.zoneId.localeCompare(right.zoneId));
    let claimsToProcess = normalized;
    if (this.options.profileClaimNoopFastPathEnabled) {
      const claimsToProbe = normalized.filter((claim) =>
        claim.knownUnclaimed !== true
      );
      const unclaimedZoneIds = new Set(
        normalized
          .filter((claim) => claim.knownUnclaimed === true)
          .map((claim) => claim.zoneId)
      );
      if (claimsToProbe.length > 0) {
        const unclaimed = await this.pool.query<{ zone_id: string }>(
          `SELECT DISTINCT ON (physical_population_zone_v2_id)
                  physical_population_zone_v2_id AS zone_id
           FROM generated_world_mobs
           WHERE physical_population_zone_v2_id=ANY($1::text[])
             AND combat_level IS NULL
             AND killed_at IS NULL
             AND NOT population_v2_suppressed
           ORDER BY physical_population_zone_v2_id,
                    population_v2_plan_id,
                    encounter_id`,
          [claimsToProbe.map((claim) => claim.zoneId)]
        );
        for (const row of unclaimed.rows) unclaimedZoneIds.add(row.zone_id);
      }
      claimsToProcess = normalized.filter((claim) =>
        unclaimedZoneIds.has(claim.zoneId)
      );
      if (claimsToProcess.length === 0) return 0;
    }
    const result = await this.pool.query<{ claimed_count: number | string }>(
      `WITH claims(zone_id, level, source) AS (
         SELECT *
         FROM unnest($1::text[], $2::smallint[], $3::text[])
       ), locked_mobs AS MATERIALIZED (
         SELECT mob.entity_id,
                mob.physical_population_zone_v2_id AS zone_id,
                coalesce(mob.pack_id, mob.encounter_id, mob.entity_id)
                  AS encounter_key,
                mob.combat_level,
                claim.level AS requested_level,
                claim.source
         FROM generated_world_mobs AS mob
         JOIN claims AS claim
           ON claim.zone_id=mob.physical_population_zone_v2_id
         WHERE mob.killed_at IS NULL
           AND NOT mob.population_v2_suppressed
         ORDER BY mob.physical_population_zone_v2_id, mob.entity_id
         FOR UPDATE OF mob
       ), encounter_profiles AS (
         SELECT zone_id, encounter_key, requested_level, source,
                coalesce(max(combat_level), requested_level)::smallint AS level
         FROM locked_mobs
         GROUP BY zone_id, encounter_key, requested_level, source
       ), updated AS (
         UPDATE generated_world_mobs AS mob
         SET combat_level=profile.level,
             -- Mirrors mobChallengeTier: equal bands across the level cap.
             combat_tier=($4::text[])[
               greatest(1, ceil(profile.level::numeric / $5::numeric))::integer
             ],
             combat_balance_version=2,
             combat_profile_claimed_at=clock_timestamp(),
             combat_profile_source=profile.source
         FROM locked_mobs AS locked
         JOIN encounter_profiles AS profile
           ON profile.zone_id=locked.zone_id
          AND profile.encounter_key=locked.encounter_key
         WHERE mob.entity_id=locked.entity_id
           AND mob.combat_level IS NULL
         RETURNING mob.entity_id
       )
       SELECT count(*)::integer AS claimed_count FROM updated`,
      [
        claimsToProcess.map((claim) => claim.zoneId),
        claimsToProcess.map((claim) => claim.level),
        claimsToProcess.map((claim) => claim.source),
        [...MOB_CHALLENGE_TIERS],
        MOB_CHALLENGE_TIER_BAND_WIDTH
      ]
    );
    return Number(result.rows[0]?.claimed_count ?? 0);
  }

  async loadZonePopulationDiagnostics(
    plans: readonly Readonly<{ zoneId: string; planId: string }>[]
  ): Promise<PopulationZoneV2PopulationDiagnostics[]> {
    if (plans.length === 0) return [];
    const result = await this.pool.query<{
      zone_id: string;
      permanent_stone_count: string;
      v2_durable_entity_count: string;
      generation_id: string | null;
      generated_at: Date | null;
      expires_at: Date | null;
      generation_status: PopulationZoneV2GenerationStatus | null;
      planned_nonstone_count: number | null;
      active_nonstone_count: string | null;
      current_reference_count: number | null;
      sap_crawler_allocated_candidates: number;
      sap_crawler_no_eligible_cluster_candidates: number;
      sap_crawler_insufficient_valid_site_candidates: number;
      sap_crawler_conflict_rejected_candidates: number;
      sap_crawler_planned_group_count: string;
      sap_crawler_planned_member_count: string;
      sap_crawler_inserted_group_count: string | null;
      sap_crawler_ready_member_count: string | null;
      sap_crawler_leased_actor_count: string | null;
      sap_crawler_placement_shortfall_groups: number;
    }>(
      `WITH requested(zone_id, plan_id) AS (
         SELECT * FROM unnest($1::text[], $2::uuid[])
       ), zones AS (
         SELECT requested.zone_id, requested.plan_id, plan.zone_geog,
                plan.habitat_summary, plan.nonstone_template_slots
         FROM requested
         JOIN population_zones_v2 AS plan
           ON plan.zone_id = requested.zone_id
          AND plan.plan_id = requested.plan_id
       )
       SELECT zone.zone_id,
              slots.permanent_stone_count,
              slots.total_count AS v2_durable_entity_count,
              generation.generation_id,
              generation.generated_at,
              generation.expires_at,
              generation.status AS generation_status,
              generation.planned_nonstone_count,
              generation.active_nonstone_count,
              generation.current_reference_count,
              COALESCE((
                zone.habitat_summary #>>
                  '{sapCrawlerPlanning,allocatedCandidates}'
              )::int, 0) AS sap_crawler_allocated_candidates,
              COALESCE((
                zone.habitat_summary #>>
                  '{sapCrawlerPlanning,noEligibleClusterCandidates}'
              )::int, 0) AS sap_crawler_no_eligible_cluster_candidates,
              COALESCE((
                zone.habitat_summary #>>
                  '{sapCrawlerPlanning,insufficientValidSiteCandidates}'
              )::int, 0)
                AS sap_crawler_insufficient_valid_site_candidates,
              COALESCE((
                zone.habitat_summary #>>
                  '{sapCrawlerPlanning,conflictRejectedCandidates}'
              )::int, 0) AS sap_crawler_conflict_rejected_candidates,
              template.sap_crawler_group_count
                AS sap_crawler_planned_group_count,
              template.sap_crawler_member_count
                AS sap_crawler_planned_member_count,
              generation.sap_crawler_group_count
                AS sap_crawler_inserted_group_count,
              generation.sap_crawler_ready_count
                AS sap_crawler_ready_member_count,
              generation.sap_crawler_leased_count
                AS sap_crawler_leased_actor_count,
              COALESCE((
                zone.habitat_summary #>>
                  '{sapCrawlerPlanning,placementShortfallGroups}'
              )::int, 0) AS sap_crawler_placement_shortfall_groups
       FROM zones AS zone
       CROSS JOIN LATERAL (
         SELECT count(DISTINCT slot->>'candidateId') FILTER (
                  WHERE slot->>'entityKind'='sap_crawler'
                )::text AS sap_crawler_group_count,
                count(*) FILTER (
                  WHERE slot->>'entityKind'='sap_crawler'
                )::text AS sap_crawler_member_count
         FROM jsonb_array_elements(zone.nonstone_template_slots) AS slot
       ) AS template
       CROSS JOIN LATERAL (
         SELECT count(*)::text AS total_count,
                count(*) FILTER (
                  WHERE entity_kind='stone'
                )::text AS permanent_stone_count
         FROM population_plan_spawn_slots_v2
         WHERE plan_id = zone.plan_id
       ) AS slots
       LEFT JOIN LATERAL (
         SELECT lifecycle.generation_id, lifecycle.generated_at,
                lifecycle.expires_at, lifecycle.status,
                lifecycle.planned_nonstone_count,
                lifecycle.current_reference_count,
                (
                  SELECT count(*)::text
                  FROM population_spawn_slots_v2 AS slot
                  JOIN population_entity_state_v2 AS state
                    ON state.entity_id=slot.entity_id
                  WHERE slot.generation_id=lifecycle.generation_id
                    AND state.state='ready'
                ) AS active_nonstone_count,
                (
                  SELECT count(DISTINCT slot.pack_id)::text
                  FROM population_spawn_slots_v2 AS slot
                  WHERE slot.generation_id=lifecycle.generation_id
                    AND slot.entity_kind='sap_crawler'
                ) AS sap_crawler_group_count,
                (
                  SELECT count(*)::text
                  FROM population_spawn_slots_v2 AS slot
                  JOIN population_entity_state_v2 AS state
                    ON state.entity_id=slot.entity_id
                  WHERE slot.generation_id=lifecycle.generation_id
                    AND slot.entity_kind='sap_crawler'
                    AND state.state='ready'
                ) AS sap_crawler_ready_count,
                (
                  SELECT count(*)::text
                  FROM population_spawn_slots_v2 AS slot
                  JOIN population_runtime_entity_leases_v2 AS lease
                    ON lease.entity_id=slot.entity_id
                  WHERE slot.generation_id=lifecycle.generation_id
                    AND slot.entity_kind='sap_crawler'
                    AND lease.lease_expires_at > clock_timestamp()
                ) AS sap_crawler_leased_count
         FROM population_zone_generations_v2 AS lifecycle
         WHERE lifecycle.zone_id=zone.zone_id AND lifecycle.is_current
       ) AS generation ON true
       ORDER BY zone.zone_id`,
      [
        plans.map((plan) => plan.zoneId),
        plans.map((plan) => plan.planId)
      ]
    );
    const manifestsByGeneration = new Map<
      string,
      PopulationZoneV2RegisteredMobDiagnostic[]
    >();
    const generationIds = result.rows.flatMap((row) =>
      row.generation_id === null ? [] : [row.generation_id]
    );
    if (generationIds.length > 0) {
      const manifests = await this.pool.query<{
        generation_id: string;
        mob_kind: string;
        rollout_revision: string;
        source: "generation" | "top_up";
        status: PopulationZoneV2RegisteredMobDiagnostic["status"];
        target_group_count: number | string;
        target_body_count: number | string;
        inserted_group_count: number | string;
        inserted_body_count: number | string;
        shortfall_group_count: number | string;
        attempt_count: number | string;
      }>(
        `SELECT generation_id, mob_kind, rollout_revision, source, status,
                target_group_count, target_body_count,
                inserted_group_count, inserted_body_count,
                shortfall_group_count, attempt_count
         FROM population_generation_mob_rollouts_v2
         WHERE generation_id=ANY($1::uuid[])
         ORDER BY generation_id, mob_kind, rollout_revision`,
        [[...new Set(generationIds)].sort()]
      );
      for (const manifest of manifests.rows) {
        const diagnostics = manifestsByGeneration.get(
          manifest.generation_id
        ) ?? [];
        diagnostics.push({
          mobKind: manifest.mob_kind,
          diagnosticsLabel:
            this.mobRegistry.definitionForKind(manifest.mob_kind)
              ?.diagnosticsLabel ?? manifest.mob_kind,
          placementRevision: manifest.rollout_revision,
          source: manifest.source,
          status: manifest.status,
          targetGroupCount: Number(manifest.target_group_count),
          targetBodyCount: Number(manifest.target_body_count),
          insertedGroupCount: Number(manifest.inserted_group_count),
          insertedBodyCount: Number(manifest.inserted_body_count),
          shortfallGroupCount: Number(manifest.shortfall_group_count),
          attemptCount: Number(manifest.attempt_count)
        });
        manifestsByGeneration.set(manifest.generation_id, diagnostics);
      }
    }
    return result.rows.map((row) => ({
      zoneId: row.zone_id,
      permanentStoneCount: Number(row.permanent_stone_count),
      v2DurableEntityCount: Number(row.v2_durable_entity_count),
      generationId: row.generation_id,
      generatedAt: row.generated_at,
      expiresAt: row.expires_at,
      generationStatus: row.generation_status,
      plannedNonStoneCount: row.planned_nonstone_count ?? 0,
      activeNonStoneCount: Number(row.active_nonstone_count ?? 0),
      currentReferenceCount: row.current_reference_count ?? 0,
      sapCrawlerAllocatedCandidates: row.sap_crawler_allocated_candidates,
      sapCrawlerNoEligibleClusterCandidates:
        row.sap_crawler_no_eligible_cluster_candidates,
      sapCrawlerInsufficientValidSiteCandidates:
        row.sap_crawler_insufficient_valid_site_candidates,
      sapCrawlerConflictRejectedCandidates:
        row.sap_crawler_conflict_rejected_candidates,
      sapCrawlerPlannedGroupCount:
        Number(row.sap_crawler_planned_group_count),
      sapCrawlerPlannedMemberCount:
        Number(row.sap_crawler_planned_member_count),
      sapCrawlerInsertedGroupCount:
        Number(row.sap_crawler_inserted_group_count ?? 0),
      sapCrawlerReadyMemberCount:
        Number(row.sap_crawler_ready_member_count ?? 0),
      sapCrawlerLeasedActorCount:
        Number(row.sap_crawler_leased_actor_count ?? 0),
      sapCrawlerPlacementShortfallGroups:
        row.sap_crawler_placement_shortfall_groups,
      registeredMobs: row.generation_id === null
        ? []
        : manifestsByGeneration.get(row.generation_id) ?? []
    }));
  }

  async transitionEntityState(input: Readonly<{
    entityId: string;
    expectedStateRevision: number;
    state: PopulationZoneV2EntityState;
    stateActorPlayerId?: string | null;
    eventAt?: Date | null;
    respawnAt?: Date | null;
    durableRuntimeState?: Record<string, unknown>;
  }>): Promise<PopulationZoneV2EntityStateSnapshot | null> {
    const slot = await this.pool.query<{
      entity_kind: PopulationZoneV2EntityKind;
      regeneration_interval_ms: number | string | null;
    }>(
      `SELECT slot.entity_kind,
              EXTRACT(EPOCH FROM authority.regeneration_interval) * 1000
                AS regeneration_interval_ms
       FROM population_plan_spawn_slots_v2 AS slot
       LEFT JOIN population_permanent_resource_authority_v2 AS authority
         ON authority.entity_id=slot.entity_id
       WHERE slot.entity_id=$1::uuid`,
      [input.entityId]
    );
    const entityKind = slot.rows[0]?.entity_kind;
    if (entityKind === undefined) return null;
    const ready = input.state === "ready";
    const regenerationMs = slot.rows[0]?.regeneration_interval_ms == null
      ? null
      : Number(slot.rows[0]!.regeneration_interval_ms);
    const permanentMine = regenerationMs !== null;
    if (!permanentMine && ready) {
      throw new Error(
        "generation entities cannot individually respawn"
      );
    }
    const eventAt = ready ? null : input.eventAt ?? new Date();
    const respawnAt = ready
      ? null
      : permanentMine
        ? input.respawnAt
          ?? new Date(eventAt!.getTime() + regenerationMs)
        : null;
    if (!permanentMine && input.respawnAt != null) {
      throw new Error(
        "non-stone generation entities never receive a respawn timestamp"
      );
    }
    if (
      permanentMine
      && !ready
      && respawnAt!.getTime()
        !== eventAt!.getTime() + regenerationMs
    ) {
      throw new Error(
        "permanent mine regeneration does not match its definition"
      );
    }
    const result = await this.pool.query<{
      entity_id: string;
      state: PopulationZoneV2EntityState;
      state_revision: string | number;
      state_actor_player_id: string | null;
      killed_or_harvested_at: Date | null;
      respawn_at: Date | null;
      durable_runtime_state: Record<string, unknown>;
    }>(
      `UPDATE population_entity_state_v2
       SET state = $3,
           state_revision = state_revision + 1,
           state_actor_player_id = $4,
           killed_or_harvested_at = $5,
           respawn_at = $6,
           durable_runtime_state = $7::jsonb,
           updated_at = clock_timestamp()
       WHERE entity_id = $1::uuid AND state_revision = $2
       RETURNING entity_id, state, state_revision, state_actor_player_id,
                 killed_or_harvested_at, respawn_at, durable_runtime_state`,
      [
        input.entityId,
        input.expectedStateRevision,
        input.state,
        ready ? null : input.stateActorPlayerId ?? null,
        eventAt,
        respawnAt,
        JSON.stringify(input.durableRuntimeState ?? {})
      ]
    );
    return result.rows[0] === undefined
      ? null
      : rowToState(result.rows[0]);
  }

  async respawnDueEntitiesForZones(
    zoneIds: readonly string[]
  ): Promise<PopulationZoneV2EntityStateSnapshot[]> {
    if (zoneIds.length === 0) return [];
    const result = await this.pool.query<{
      entity_id: string;
      state: PopulationZoneV2EntityState;
      state_revision: string | number;
      state_actor_player_id: string | null;
      killed_or_harvested_at: Date | null;
      respawn_at: Date | null;
      durable_runtime_state: Record<string, unknown>;
    }>(
      `WITH boundary AS MATERIALIZED (
         SELECT clock_timestamp() AS occurred_at
       )
       UPDATE population_entity_state_v2 AS state
       SET state = 'ready', state_revision = state.state_revision + 1,
           state_actor_player_id = NULL, killed_or_harvested_at = NULL,
           respawn_at = NULL, durable_runtime_state = '{}'::jsonb,
           updated_at = boundary.occurred_at
       FROM population_permanent_resource_authority_v2 AS authority
       JOIN repeatable_resource_nodes AS projection
         ON projection.population_v2_entity_id=authority.entity_id
        AND projection.physical_population_zone_v2_id=
            authority.owner_zone_id
        AND projection.node_type=authority.node_type
        AND projection.yield_item_id=authority.yield_item_id
        AND projection.yield_quantity=authority.yield_quantity
        AND projection.regeneration_interval=
            authority.regeneration_interval
       JOIN population_zone_cutovers_v2 AS cutover
         ON cutover.zone_id=authority.owner_zone_id
        AND cutover.status='stable'
        AND cutover.serving_version='v2'
        AND cutover.cutover_revision=
            projection.population_cutover_revision
       JOIN population_plan_permanent_resources_v2 AS membership
         ON membership.plan_id=cutover.selected_plan_id
        AND membership.entity_id=authority.entity_id,
       boundary
       WHERE state.entity_id=authority.entity_id
         AND authority.owner_zone_id=ANY($1::text[])
         AND state.state='harvested'
         AND projection.population_v2_state_revision=state.state_revision
         AND projection.harvest_revision=state.state_revision
         AND state.respawn_at IS NOT NULL
         AND state.respawn_at <= boundary.occurred_at
         AND NOT projection.population_v2_suppressed
       RETURNING state.entity_id, state.state, state.state_revision,
                 state.state_actor_player_id, state.killed_or_harvested_at,
                 state.respawn_at, state.durable_runtime_state`,
      [[...new Set(zoneIds)].sort()]
    );
    return result.rows.map(rowToState);
  }

  async acquireRuntimeEntityLeases(
    requests: readonly PopulationZoneV2RuntimeLeaseRequest[],
    leaseMs: number,
    now: Date = new Date()
  ): Promise<PopulationZoneV2RuntimeLease[]> {
    if (requests.length === 0) return [];
    assertPositiveMilliseconds(leaseMs, "population runtime lease");
    assertValidDate(now, "population runtime admission timestamp");
    assertUnique(requests.map((request) => request.entityId), "runtime entity lease");
    assertUnique(requests.map((request) => request.ownerToken), "runtime owner token");
    const worldTime = worldTimeAt(now);
    const mechanicalPhase = worldTime.mechanicalPhase;
    const runtimeMobKinds = this.mobRegistry.runtimeMobKinds;
    const eligibleMobKinds = this.mobRegistry.definitions
      .filter((definition) =>
        definition.mechanicalPhaseEligibility === "ANY"
        || definition.mechanicalPhaseEligibility === mechanicalPhase
      )
      .filter((definition) =>
        populationV2MobDefinitionIsEligibleAtWorldPhase(definition, worldTime.phase)
      )
      .map((definition) => definition.mobKind);
    const serializedRequests = JSON.stringify(
      requests.map(runtimeLeaseRequestForDatabase)
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `WITH requested AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS request(
             entity_id uuid
           )
         ), target_groups AS (
           SELECT slot.generation_id, slot.pack_id
           FROM requested AS request
           JOIN population_plan_spawn_slots_v2 AS slot
             ON slot.entity_id=request.entity_id
           WHERE slot.pack_id IS NOT NULL
         ), lock_targets AS (
           SELECT request.entity_id FROM requested AS request
           UNION
           SELECT sibling.entity_id
           FROM target_groups AS target
           JOIN population_plan_spawn_slots_v2 AS sibling
             ON sibling.generation_id=target.generation_id
            AND sibling.pack_id=target.pack_id
         )
         SELECT state.entity_id
         FROM population_entity_state_v2 AS state
         JOIN lock_targets AS target ON target.entity_id=state.entity_id
         ORDER BY state.entity_id
         FOR UPDATE OF state`,
        [serializedRequests]
      );
      const result = await client.query<{
        entity_id: string;
        runtime_id: string;
        owner_token: string;
        fencing_generation: string | number;
        cutover_revision: string | number;
        state_revision: string | number;
        lease_expires_at: Date;
      }>(
        `WITH boundary AS MATERIALIZED (
           SELECT clock_timestamp() AS admitted_at
         ), requested AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS request(
           entity_id uuid, runtime_id text, owner_token uuid,
           cutover_revision bigint, state_revision bigint
         )
       ), candidates AS MATERIALIZED (
         SELECT request.*, slot.generation_id, slot.pack_id,
                slot.entity_kind, state.first_runtime_admitted_at
         FROM requested AS request
         JOIN population_entity_state_v2 AS state
           ON state.entity_id = request.entity_id
          AND state.state = 'ready'
          AND state.state_revision = request.state_revision
         JOIN population_plan_spawn_slots_v2 AS slot
           ON slot.entity_id = request.entity_id
         JOIN population_zone_cutovers_v2 AS cutover
           ON cutover.selected_plan_id = slot.plan_id
          AND cutover.serving_version = 'v2'
          AND cutover.status = 'stable'
          AND cutover.cutover_revision = request.cutover_revision
       ), eligible AS (
         SELECT candidate.*
         FROM candidates AS candidate
         WHERE candidate.first_runtime_admitted_at IS NOT NULL
            OR candidate.entity_kind <> ALL($3::text[])
            OR (
              candidate.entity_kind = ANY($4::text[])
              AND (
                candidate.pack_id IS NULL
                OR (
                  NOT EXISTS (
                    SELECT 1
                    FROM population_plan_spawn_slots_v2 AS sibling
                    LEFT JOIN candidates AS requested_sibling
                      ON requested_sibling.entity_id=sibling.entity_id
                    WHERE sibling.generation_id=candidate.generation_id
                      AND sibling.pack_id=candidate.pack_id
                      AND requested_sibling.entity_id IS NULL
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM population_plan_spawn_slots_v2 AS sibling
                    JOIN population_entity_state_v2 AS sibling_state
                      ON sibling_state.entity_id=sibling.entity_id
                    WHERE sibling.generation_id=candidate.generation_id
                      AND sibling.pack_id=candidate.pack_id
                      AND sibling_state.first_runtime_admitted_at IS NOT NULL
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM population_plan_spawn_slots_v2 AS sibling
                    JOIN population_runtime_entity_leases_v2 AS sibling_lease
                      ON sibling_lease.entity_id=sibling.entity_id
                    WHERE sibling.generation_id=candidate.generation_id
                      AND sibling.pack_id=candidate.pack_id
                      AND sibling_lease.lease_expires_at
                        > (SELECT admitted_at FROM boundary)
                  )
                )
              )
            )
       ), leased AS (
         INSERT INTO population_runtime_entity_leases_v2 (
           entity_id, runtime_id, owner_token, fencing_generation,
           cutover_revision, state_revision,
           lease_expires_at, heartbeat_at, acquired_at
         )
         SELECT entity_id, runtime_id, owner_token, 1,
                cutover_revision, state_revision,
                boundary.admitted_at
                  + ($2::bigint * interval '1 millisecond'),
                boundary.admitted_at, boundary.admitted_at
         FROM eligible, boundary
         ON CONFLICT (entity_id) DO UPDATE SET
           runtime_id = EXCLUDED.runtime_id,
           owner_token = EXCLUDED.owner_token,
           fencing_generation =
             population_runtime_entity_leases_v2.fencing_generation + 1,
           cutover_revision = EXCLUDED.cutover_revision,
           state_revision = EXCLUDED.state_revision,
           lease_expires_at = EXCLUDED.lease_expires_at,
           heartbeat_at = EXCLUDED.heartbeat_at,
           acquired_at = EXCLUDED.acquired_at
         WHERE population_runtime_entity_leases_v2.lease_expires_at
           <= EXCLUDED.acquired_at
         RETURNING entity_id, runtime_id, owner_token, fencing_generation,
                   cutover_revision, state_revision, lease_expires_at
       ), admitted AS (
         UPDATE population_entity_state_v2 AS state
         SET first_runtime_admitted_at=boundary.admitted_at,
             updated_at=boundary.admitted_at
         FROM leased, boundary,
              population_plan_spawn_slots_v2 AS slot
         WHERE state.entity_id=leased.entity_id
           AND slot.entity_id=state.entity_id
           AND slot.entity_kind=ANY($3::text[])
           AND state.first_runtime_admitted_at IS NULL
         RETURNING state.entity_id
       )
       SELECT leased.entity_id, leased.runtime_id, leased.owner_token,
              leased.fencing_generation, leased.cutover_revision,
              leased.state_revision, leased.lease_expires_at,
              (SELECT count(*) FROM admitted) AS admission_count
       FROM leased
       ORDER BY leased.entity_id`,
        [
          serializedRequests,
          leaseMs,
          runtimeMobKinds,
          eligibleMobKinds
        ]
      );
      await client.query("COMMIT");
      return result.rows.map(rowToLease);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async renewRuntimeEntityLeases(
    leases: readonly PopulationZoneV2RuntimeLease[],
    leaseMs: number
  ): Promise<PopulationRuntimeLeaseRenewalOutcome[]> {
    if (leases.length === 0) return [];
    assertPositiveMilliseconds(leaseMs, "population runtime lease");
    const result = await this.queryRuntimeLeaseMutation<{
      entity_id: string;
      renewal_status: PopulationRuntimeLeaseRenewalOutcome["status"];
    }>(
      "renew",
      `WITH requested AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS request(
           entity_id uuid, owner_token uuid, fencing_generation bigint,
           cutover_revision bigint, state_revision bigint
         )
       ), locked AS MATERIALIZED (
         SELECT lease.entity_id
         FROM population_runtime_entity_leases_v2 AS lease
         JOIN requested AS request
           ON request.entity_id = lease.entity_id
          AND request.owner_token = lease.owner_token
          AND request.fencing_generation = lease.fencing_generation
          AND request.cutover_revision = lease.cutover_revision
          AND request.state_revision = lease.state_revision
         JOIN population_plan_spawn_slots_v2 AS slot
           ON slot.entity_id = lease.entity_id
         JOIN population_entity_state_v2 AS state
           ON state.entity_id = lease.entity_id
          AND state.state = 'ready'
          AND state.state_revision = lease.state_revision
         JOIN population_zone_cutovers_v2 AS cutover
           ON cutover.selected_plan_id = slot.plan_id
          AND cutover.serving_version = 'v2'
          AND cutover.status = 'stable'
          AND cutover.cutover_revision = lease.cutover_revision
         WHERE lease.lease_expires_at > clock_timestamp()
         ORDER BY lease.entity_id
         FOR UPDATE OF lease
       ), renewed AS (
         UPDATE population_runtime_entity_leases_v2 AS lease
         SET lease_expires_at = clock_timestamp()
               + ($2::bigint * interval '1 millisecond'),
             heartbeat_at = clock_timestamp()
         FROM locked
         WHERE lease.entity_id = locked.entity_id
         RETURNING lease.entity_id
       )
       SELECT request.entity_id,
              CASE
                WHEN renewed.entity_id IS NOT NULL THEN 'renewed'
                WHEN state.entity_id IS NULL OR state.state <> 'ready'
                  OR state.state_revision <> request.state_revision
                  THEN 'durable-state-no-longer-ready'
                WHEN cutover.selected_plan_id IS DISTINCT FROM slot.plan_id
                  OR cutover.cutover_revision <> request.cutover_revision
                  OR cutover.status <> 'stable'
                  OR cutover.serving_version <> 'v2'
                  THEN 'actual-cutover'
                ELSE 'lease-ownership-lost'
              END AS renewal_status
       FROM requested AS request
       LEFT JOIN renewed ON renewed.entity_id=request.entity_id
       LEFT JOIN population_runtime_entity_leases_v2 AS lease
         ON lease.entity_id=request.entity_id
       LEFT JOIN population_entity_state_v2 AS state
         ON state.entity_id=request.entity_id
       LEFT JOIN population_plan_spawn_slots_v2 AS slot
         ON slot.entity_id=request.entity_id
       LEFT JOIN population_zones_v2 AS plan
         ON plan.plan_id=slot.plan_id
       LEFT JOIN population_zone_cutovers_v2 AS cutover
         ON cutover.zone_id=plan.zone_id
        AND cutover.geometry_version=plan.geometry_version
        AND cutover.serving_version='v2'
       ORDER BY request.entity_id`,
      [JSON.stringify(leases.map(leaseFenceForDatabase)), leaseMs]
    );
    return result.rows.map((row) => ({
      entityId: row.entity_id,
      status: row.renewal_status
    }));
  }

  async updateReadyRuntimeEntityState(
    lease: PopulationZoneV2RuntimeLease,
    durableRuntimeState: Record<string, unknown>
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE population_entity_state_v2 AS state
       SET durable_runtime_state=$7::jsonb,
           updated_at=clock_timestamp()
       FROM population_runtime_entity_leases_v2 AS lease,
            population_plan_spawn_slots_v2 AS slot,
            population_zone_cutovers_v2 AS cutover
       WHERE state.entity_id=$1::uuid
         AND state.state='ready'
         AND state.state_revision=$6
         AND lease.entity_id=state.entity_id
         AND lease.runtime_id=$2
         AND lease.owner_token=$3::uuid
         AND lease.fencing_generation=$4
         AND lease.cutover_revision=$5
         AND lease.state_revision=$6
         AND lease.lease_expires_at>clock_timestamp()
         AND slot.entity_id=state.entity_id
         AND cutover.selected_plan_id=slot.plan_id
         AND cutover.serving_version='v2'
         AND cutover.status='stable'
         AND cutover.cutover_revision=lease.cutover_revision
       RETURNING state.entity_id`,
      [
        lease.entityId,
        lease.runtimeId,
        lease.ownerToken,
        lease.fencingGeneration,
        lease.cutoverRevision,
        lease.stateRevision,
        JSON.stringify(durableRuntimeState)
      ]
    );
    return result.rowCount === 1;
  }

  async rebindRuntimeEntityLease(
    existing: PopulationZoneV2RuntimeLease,
    request: PopulationZoneV2RuntimeLeaseRequest,
    leaseMs: number
  ): Promise<PopulationZoneV2RuntimeLease | null> {
    assertPositiveMilliseconds(leaseMs, "population runtime lease");
    if (
      existing.entityId !== request.entityId
      || existing.runtimeId !== request.runtimeId
      || existing.stateRevision !== request.stateRevision
    ) {
      throw new Error("population runtime lease rebind changed physical identity");
    }
    const result = await this.pool.query<{
      entity_id: string;
      runtime_id: string;
      owner_token: string;
      fencing_generation: string | number;
      cutover_revision: string | number;
      state_revision: string | number;
      lease_expires_at: Date;
    }>(
      `UPDATE population_runtime_entity_leases_v2 AS lease
       SET owner_token=$6::uuid,
           fencing_generation=lease.fencing_generation + 1,
           cutover_revision=$7::bigint,
           lease_expires_at=clock_timestamp()
             + ($8::bigint * interval '1 millisecond'),
           heartbeat_at=clock_timestamp(),
           acquired_at=clock_timestamp()
       FROM population_entity_state_v2 AS state,
            generated_world_mobs AS projection,
            population_plan_spawn_slots_v2 AS slot,
            population_zone_cutovers_v2 AS cutover
       WHERE lease.entity_id=$1::uuid
         AND lease.runtime_id=$2
         AND lease.owner_token=$3::uuid
         AND lease.fencing_generation=$4::bigint
         AND lease.cutover_revision=$5::bigint
         AND lease.state_revision=$9::bigint
         AND lease.lease_expires_at > clock_timestamp()
         AND state.entity_id=lease.entity_id
         AND state.state='ready'
         AND state.state_revision=lease.state_revision
         AND projection.population_v2_entity_id=lease.entity_id
         AND NOT projection.population_v2_suppressed
         AND slot.entity_id=lease.entity_id
         AND cutover.selected_plan_id=slot.plan_id
         AND cutover.serving_version='v2'
         AND cutover.status='stable'
         AND cutover.cutover_revision=$7::bigint
       RETURNING lease.entity_id, lease.runtime_id, lease.owner_token,
                 lease.fencing_generation, lease.cutover_revision,
                 lease.state_revision, lease.lease_expires_at`,
      [
        existing.entityId,
        existing.runtimeId,
        existing.ownerToken,
        existing.fencingGeneration,
        existing.cutoverRevision,
        request.ownerToken,
        request.cutoverRevision,
        leaseMs,
        request.stateRevision
      ]
    );
    return result.rows[0] ? rowToLease(result.rows[0]) : null;
  }

  async releaseRuntimeEntityLeases(
    leases: readonly PopulationZoneV2RuntimeLease[]
  ): Promise<number> {
    if (leases.length === 0) return 0;
    const result = await this.queryRuntimeLeaseMutation(
      "release",
      `WITH requested AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS request(
           entity_id uuid, owner_token uuid, fencing_generation bigint
         )
       ), locked AS MATERIALIZED (
         SELECT lease.entity_id
         FROM population_runtime_entity_leases_v2 AS lease
         JOIN requested AS request
           ON request.entity_id = lease.entity_id
          AND request.owner_token = lease.owner_token
          AND request.fencing_generation = lease.fencing_generation
         ORDER BY lease.entity_id
         FOR UPDATE OF lease
       )
       DELETE FROM population_runtime_entity_leases_v2 AS lease
       USING locked
       WHERE lease.entity_id = locked.entity_id`,
      [JSON.stringify(leases.map(leaseFenceForDatabase))]
    );
    return result.rowCount ?? 0;
  }

  private async queryRuntimeLeaseMutation<Row extends pg.QueryResultRow>(
    operation: "renew" | "release",
    text: string,
    values: unknown[]
  ): Promise<pg.QueryResult<Row>> {
    for (let retry = 0; ; retry += 1) {
      try {
        return await this.pool.query<Row>(text, values);
      } catch (error) {
        if (
          !isRetryablePopulationRuntimeLeaseMutationError(error)
          || retry >= POPULATION_RUNTIME_LEASE_MUTATION_RETRY_LIMIT
        ) throw error;
        const delayMs =
          POPULATION_RUNTIME_LEASE_MUTATION_RETRY_BASE_DELAY_MS * (retry + 1)
          + Math.floor(
            Math.random() * POPULATION_RUNTIME_LEASE_MUTATION_RETRY_BASE_DELAY_MS
          );
        this.options.logger?.warn?.(
          {
            err: error,
            operation,
            retry: retry + 1,
            delayMs
          },
          "population runtime lease mutation retrying after database conflict"
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

}

function warnPopulationInvariantOnce(key: string, message: string): void {
  if (populationInvariantWarnings.has(key)) return;
  if (populationInvariantWarnings.size >= 512) {
    populationInvariantWarnings.clear();
  }
  populationInvariantWarnings.add(key);
  process.emitWarning(message, {
    code: "ASH_ATLAS_POPULATION_INVARIANT"
  });
}

function rowToPlanRecord(row: PlanRow): PopulationZoneV2PlanRecord {
  const identity: PopulationZoneV2PlanIdentity = {
    zoneId: row.zone_id,
    geometryVersion: row.geometry_version,
    worldEnvironmentIdentityKey: row.world_environment_identity_key,
    populationPlanVersion: row.plan_version,
    spawnRulesVersion: row.spawn_rules_version,
    environmentProfileVersion: row.environment_profile_version,
    candidateLayoutVersion: row.candidate_layout_version,
    respawnPolicyVersion: row.respawn_policy_version
  };
  return {
    identity,
    planId: row.plan_id,
    worldPipelineSha: row.world_runtime_sha,
    regionCode: row.region_code,
    status: row.status,
    claimGeneration: Number(row.claim_generation),
    attemptCount: Number(row.attempt_count),
    contentHash: row.content_hash
  };
}

function rowToGeneration(
  row: GenerationRow
): PopulationZoneV2GenerationRecord {
  return {
    generationId: row.generation_id,
    zoneId: row.zone_id,
    planId: row.plan_id,
    generationNumber: Number(row.generation_number),
    generatedAt: row.generated_at,
    expiresAt: row.expires_at,
    status: row.status,
    plannedNonStoneCount: Number(row.planned_nonstone_count),
    currentReferenceCount: Number(row.current_reference_count),
    unreferencedAt: row.unreferenced_at,
    isCurrent: row.is_current,
    cleanedAt: row.cleaned_at,
    densityRevision: row.density_revision ?? "legacy-unverified",
    planContentHash: row.plan_content_hash ?? "legacy-unverified",
    candidateLayoutVersion:
      row.candidate_layout_version ?? "legacy-unverified",
    materializationRevision:
      row.materialization_revision ?? "legacy-unverified",
    commonSchemaRevision: row.common_schema_revision
      ?? commonSchemaRevisionForMaterialization(
        row.materialization_revision
      ),
    ...(row.cutover_revision === undefined
      ? {}
      : { cutoverRevision: Number(row.cutover_revision) })
  };
}

export function commonSchemaRevisionForGeneration(
  generation: Pick<
    PopulationZoneV2GenerationRecord,
    "commonSchemaRevision" | "materializationRevision"
  >
): string {
  return generation.commonSchemaRevision
    ?? commonSchemaRevisionForMaterialization(
      generation.materializationRevision
    );
}

function commonSchemaRevisionForMaterialization(
  materializationRevision: string | undefined
): string {
  if (materializationRevision === POPULATION_GENERATION_MATERIALIZATION_REVISION) {
    return POPULATION_COMMON_SCHEMA_REVISION;
  }
  if (
    materializationRevision ===
      "population-generation-materialization-v13-animal-biome-variants"
    || materializationRevision ===
      "population-generation-materialization-v12-deer-biome-variants"
    || materializationRevision ===
      "population-generation-materialization-v11-aquatic-balance"
  ) {
    return POPULATION_COMMON_SCHEMA_REVISION;
  }
  if (
    materializationRevision ===
      "population-generation-materialization-v10-flax-plant"
  ) {
    return POPULATION_COMMON_SCHEMA_REVISION;
  }
  if (
    materializationRevision ===
      "population-generation-materialization-v9-coastal-body-density"
  ) {
    return POPULATION_COMMON_SCHEMA_REVISION;
  }
  if (
    materializationRevision ===
      "population-generation-materialization-v8-coastal-crab"
  ) {
    return POPULATION_COMMON_SCHEMA_REVISION;
  }
  if (
    materializationRevision ===
      "population-generation-materialization-v7-jellyfish-water-balance"
  ) {
    return POPULATION_COMMON_SCHEMA_REVISION;
  }
  if (
    materializationRevision ===
      "population-generation-materialization-v6-mysterious-traveler"
  ) {
    return POPULATION_COMMON_SCHEMA_REVISION;
  }
  if (
    materializationRevision ===
      "population-generation-materialization-v4-encounter-tables-v1"
  ) {
    return POPULATION_COMMON_SCHEMA_REVISION;
  }
  if (
    materializationRevision ===
      "population-generation-materialization-v5-land-balance-v2"
  ) {
    return POPULATION_COMMON_SCHEMA_REVISION;
  }
  if (
    materializationRevision === "population-generation-materialization-v1"
    || materializationRevision === "population-generation-materialization-v2"
    || materializationRevision === "population-generation-materialization-v3"
  ) {
    return "population-common-schema-v1";
  }
  return "legacy-unverified";
}

async function lockGenerationLifecycle(
  client: pg.PoolClient,
  zoneId: string
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('population-zone-generation-v2:' || $1, 0)
     )`,
    [zoneId]
  );
}

async function lockGenerationSpacingNeighborhood(
  client: pg.PoolClient,
  zoneId: PopulationZoneV2Id
): Promise<void> {
  for (const lockZoneId of populationZoneV2Halo(zoneId, 1)) {
    await lockGenerationLifecycle(client, lockZoneId);
  }
}

async function loadCurrentGenerationForUpdate(
  client: pg.PoolClient,
  zoneId: string
): Promise<PopulationZoneV2GenerationRecord | null> {
  const result = await client.query<GenerationRow>(
    `SELECT generation_id, zone_id, plan_id, generation_number,
            generated_at, expires_at, status, planned_nonstone_count,
            current_reference_count, unreferenced_at,
            is_current, cleaned_at, density_revision,
            plan_content_hash, candidate_layout_version,
            materialization_revision, common_schema_revision
     FROM population_zone_generations_v2
     WHERE zone_id=$1 AND is_current
     FOR UPDATE`,
    [zoneId]
  );
  return result.rows[0] === undefined
    ? null
    : rowToGeneration(result.rows[0]);
}

async function loadNeighborGenerationContexts(
  client: pg.PoolClient,
  input: Readonly<{ zoneId: PopulationZoneV2Id }>
): Promise<NeighborGenerationContextRow[]> {
  const zoneIds = populationZoneV2PlanningHabitatZoneIds(
    [input.zoneId],
    2
  ).filter((zoneId) => zoneId !== input.zoneId);
  if (zoneIds.length === 0) return [];
  const result = await client.query<NeighborGenerationContextRow>(
    `SELECT plan.plan_id, plan.zone_id, plan.geometry_version,
            plan.world_environment_identity_key, plan.world_runtime_sha,
            plan.plan_version, plan.spawn_rules_version,
            plan.environment_profile_version,
            plan.candidate_layout_version, plan.respawn_policy_version,
            plan.region_code, plan.status, plan.claim_generation,
            plan.attempt_count, plan.content_hash,
            plan.habitat_snapshot, plan.nonstone_template_slots,
            current_generation.generation_id AS current_generation_id,
            generation_history.next_generation_number
     FROM population_zone_cutovers_v2 AS cutover
     JOIN population_zones_v2 AS plan
       ON plan.plan_id=cutover.selected_plan_id
      AND plan.zone_id=cutover.zone_id
      AND plan.status='ready'
     LEFT JOIN LATERAL (
       SELECT generation_id
       FROM population_zone_generations_v2
       WHERE zone_id=cutover.zone_id AND is_current
       LIMIT 1
     ) AS current_generation ON true
     JOIN LATERAL (
       SELECT COALESCE(max(generation_number),0) + 1
         AS next_generation_number
       FROM population_zone_generations_v2
       WHERE zone_id=cutover.zone_id
     ) AS generation_history ON true
     WHERE cutover.zone_id=ANY($1::text[])
       AND cutover.serving_version='v2'
       AND cutover.status='stable'
     ORDER BY plan.zone_id`,
    [zoneIds]
  );
  return result.rows;
}

async function loadGenerationEntityIds(
  client: pg.PoolClient,
  generationId: string
): Promise<string[]> {
  const result = await client.query<{ entity_id: string }>(
    `SELECT entity_id
     FROM population_spawn_slots_v2
     WHERE generation_id=$1::uuid
     ORDER BY entity_id`,
    [generationId]
  );
  return result.rows.map((row) => row.entity_id);
}

async function loadGenerationSlots(
  client: pg.PoolClient,
  generationId: string
): Promise<PopulationZoneV2PlanSlot[]> {
  const result = await client.query<GenerationSlotRow>(
    `SELECT slot_id, entity_id, candidate_id, entity_kind, archetype,
            encounter_id, pack_id, pack_member_index,
            latitude, longitude, anchor_latitude, anchor_longitude,
            environment_snapshot, suppression_class
     FROM population_spawn_slots_v2
     WHERE generation_id=$1::uuid
     ORDER BY entity_id`,
    [generationId]
  );
  return result.rows.map(generationSlotFromRow);
}

function generationSlotFromRow(
  row: GenerationSlotRow
): PopulationZoneV2PlanSlot {
  return {
    slotId: row.slot_id,
    entityId: row.entity_id,
    candidateId: row.candidate_id,
    entityKind: row.entity_kind,
    archetype: row.archetype,
    encounterId: row.encounter_id,
    packId: row.pack_id,
    packMemberIndex: row.pack_member_index,
    position: {
      lat: Number(row.latitude),
      lon: Number(row.longitude)
    },
    anchor: {
      lat: Number(row.anchor_latitude),
      lon: Number(row.anchor_longitude)
    },
    environmentSnapshot: row.environment_snapshot,
    suppressionClass: row.suppression_class
  };
}

function emptyPopulationDensityShortfall(): Readonly<Record<
  "tree" | "deer" | "wolf_pack" | "sap_crawler_group",
  number
>> {
  return { tree: 0, deer: 0, wolf_pack: 0, sap_crawler_group: 0 };
}

async function retireSupersededPlanGeneration(
  client: pg.PoolClient,
  zoneId: string,
  selectedPlanId: string
): Promise<void> {
  const current = await client.query<{ generation_id: string }>(
    `SELECT generation_id
     FROM population_zone_generations_v2
     WHERE zone_id=$1 AND is_current AND plan_id<>$2::uuid
       AND NOT (
         status='active' AND expires_at > statement_timestamp()
       )
     FOR UPDATE`,
    [zoneId, selectedPlanId]
  );
  for (const row of current.rows) {
    await client.query(
      `UPDATE population_zone_generations_v2
       SET status='expired', current_reference_count=0,
           updated_at=clock_timestamp()
       WHERE generation_id=$1::uuid AND is_current`,
      [row.generation_id]
    );
    await deleteGenerationEntities(client, row.generation_id);
    const retired = await client.query(
      `UPDATE population_zone_generations_v2
       SET is_current=false, status='expired',
           current_reference_count=0,
           cleaned_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE generation_id=$1::uuid AND is_current`,
      [row.generation_id]
    );
    if (retired.rowCount !== 1) {
      throw new Error(
        "superseded population plan generation could not be retired"
      );
    }
  }
}

async function removeSupersededCurrentGeneration(
  client: pg.PoolClient,
  generation: PopulationZoneV2GenerationRecord
): Promise<void> {
  await client.query(
    `UPDATE population_zone_generations_v2
     SET status='expired', current_reference_count=0,
         updated_at=clock_timestamp()
     WHERE generation_id=$1::uuid AND is_current
     AND current_reference_count=0`,
    [generation.generationId]
  );
  await deleteGenerationEntities(client, generation.generationId);
  const retired = await client.query(
    `UPDATE population_zone_generations_v2
     SET is_current=false, status='expired', current_reference_count=0,
         cleaned_at=clock_timestamp(), updated_at=clock_timestamp()
     WHERE generation_id=$1::uuid AND is_current
       AND current_reference_count=0`,
    [generation.generationId]
  );
  if (retired.rowCount !== 1) {
    throw new Error(
      "superseded population generation could not be retired atomically"
    );
  }
}

async function removeExpiredReferencedCurrentGeneration(
  client: pg.PoolClient,
  generation: PopulationZoneV2GenerationRecord,
  now: Date
): Promise<void> {
  const fenced = await client.query(
    `UPDATE population_zone_generations_v2
     SET status='expired', current_reference_count=0,
         updated_at=clock_timestamp()
     WHERE generation_id=$1::uuid AND is_current
       AND expires_at <= $2`,
    [generation.generationId, now]
  );
  if (fenced.rowCount !== 1) {
    throw new Error(
      "expired referenced population generation could not be fenced"
    );
  }
  await deleteGenerationEntities(client, generation.generationId);
  const retired = await client.query(
    `UPDATE population_zone_generations_v2
     SET is_current=false, status='expired', current_reference_count=0,
         cleaned_at=clock_timestamp(), updated_at=clock_timestamp()
     WHERE generation_id=$1::uuid AND is_current
       AND current_reference_count=0`,
    [generation.generationId]
  );
  if (retired.rowCount !== 1) {
    throw new Error(
      "expired referenced population generation could not be retired atomically"
    );
  }
}

async function deleteGenerationEntities(
  client: pg.PoolClient,
  generationId: string
): Promise<void> {
  for (const table of [
    "collectible_nodes",
    "generated_world_mobs"
  ] as const) {
    await client.query(
      `DELETE FROM ${table} AS projection
       USING population_spawn_slots_v2 AS slot
       WHERE projection.population_v2_entity_id=slot.entity_id
         AND slot.generation_id=$1::uuid`,
      [generationId]
    );
  }
  await client.query(
    `DELETE FROM population_runtime_entity_leases_v2 AS lease
     USING population_spawn_slots_v2 AS slot
     WHERE lease.entity_id=slot.entity_id
       AND slot.generation_id=$1::uuid`,
    [generationId]
  );
  await client.query(
    `DELETE FROM population_entity_state_v2 AS state
     USING population_spawn_slots_v2 AS slot
     WHERE state.entity_id=slot.entity_id
       AND slot.generation_id=$1::uuid`,
    [generationId]
  );
  await client.query(
    `DELETE FROM population_spawn_slots_v2
     WHERE generation_id=$1::uuid`,
    [generationId]
  );
}

function rowToState(row: Readonly<{
  entity_id: string;
  state: PopulationZoneV2EntityState;
  state_revision: string | number;
  state_actor_player_id: string | null;
  killed_or_harvested_at: Date | null;
  respawn_at: Date | null;
  durable_runtime_state: Record<string, unknown>;
}>): PopulationZoneV2EntityStateSnapshot {
  return {
    entityId: row.entity_id,
    state: row.state,
    stateRevision: Number(row.state_revision),
    stateActorPlayerId: row.state_actor_player_id,
    eventAt: row.killed_or_harvested_at,
    respawnAt: row.respawn_at,
    durableRuntimeState: row.durable_runtime_state
  };
}

function rowToLease(row: Readonly<{
  entity_id: string;
  runtime_id: string;
  owner_token: string;
  fencing_generation: string | number;
  cutover_revision: string | number;
  state_revision: string | number;
  lease_expires_at: Date;
}>): PopulationZoneV2RuntimeLease {
  return {
    entityId: row.entity_id,
    runtimeId: row.runtime_id,
    ownerToken: row.owner_token,
    fencingGeneration: Number(row.fencing_generation),
    cutoverRevision: Number(row.cutover_revision),
    stateRevision: Number(row.state_revision),
    leaseExpiresAt: row.lease_expires_at
  };
}

function slotForDatabase(slot: PopulationZoneV2PlanSlot) {
  return {
    slot_id: slot.slotId,
    entity_id: slot.entityId,
    candidate_id: slot.candidateId,
    entity_kind: slot.entityKind,
    archetype: slot.archetype,
    encounter_id: slot.encounterId,
    pack_id: slot.packId,
    pack_member_index: slot.packMemberIndex,
    latitude: slot.position.lat,
    longitude: slot.position.lon,
    anchor_latitude: slot.anchor.lat,
    anchor_longitude: slot.anchor.lon,
    environment_snapshot: slot.environmentSnapshot,
    suppression_class: slot.suppressionClass
  };
}

function leaseFenceForDatabase(lease: PopulationZoneV2RuntimeLease) {
  return {
    entity_id: lease.entityId,
    owner_token: lease.ownerToken,
    fencing_generation: lease.fencingGeneration,
    cutover_revision: lease.cutoverRevision,
    state_revision: lease.stateRevision
  };
}

function runtimeLeaseRequestForDatabase(
  request: PopulationZoneV2RuntimeLeaseRequest
) {
  return {
    entity_id: request.entityId,
    runtime_id: request.runtimeId,
    owner_token: request.ownerToken,
    cutover_revision: request.cutoverRevision,
    state_revision: request.stateRevision
  };
}

function isRetryablePopulationRuntimeLeaseMutationError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "40P01" || code === "40001";
}

async function insertOrAdoptPermanentMines(
  client: pg.PoolClient,
  input: Readonly<{
    claim: ClaimedPopulationZoneV2Plan;
    slots: readonly PopulationZoneV2PlanSlot[];
  }>
): Promise<PopulationZoneV2PlanSlot[]> {
  assertUnique(
    input.slots.map((slot) => slot.slotId),
    "permanent population mine slot"
  );
  assertUnique(
    input.slots.map((slot) => slot.entityId),
    "permanent population mine entity"
  );
  const inserted: PopulationZoneV2PlanSlot[] = [];
  for (const slot of [...input.slots].sort((left, right) =>
    left.entityId.localeCompare(right.entityId)
  )) {
    const expectedIdentity = permanentPopulationStoneIdentity({
      identity: input.claim.identity,
      candidateId: slot.candidateId,
      ownerZoneId: input.claim.identity.zoneId
    });
    const expectedKind = permanentMineKindForSlot(expectedIdentity.slotId);
    const definition = PERMANENT_RESOURCE_REGISTRY.requireDefinition(
      permanentMineArchetype(expectedKind)
    );
    if (
      !isPermanentMineEntityKind(slot.entityKind)
      || slot.entityKind !== expectedKind
      || slot.archetype !== definition.populationArchetype
      || slot.slotId !== expectedIdentity.slotId
      || slot.entityId !== expectedIdentity.entityId
    ) {
      throw permanentMineMismatch(
        "generated permanent mine identity is not canonical",
        input.claim,
        slot
      );
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`population-permanent-mine:${slot.entityId}`]
    );
    const existing = await loadPermanentMineAuthority(
      client,
      slot.entityId,
      slot.slotId
    );
    if (existing === null) {
      await insertSpawnSlots(client, {
        planId: input.claim.planId,
        generationId: null,
        slots: [slot]
      });
      await client.query(
        `INSERT INTO population_permanent_stone_authority_v2 (
           entity_id, slot_id, candidate_id, owner_zone_id,
           entity_kind, archetype, stone_placement_version,
           yield_item_id, yield_quantity, regeneration_interval,
           timer_profession_id, timer_visibility_rank,
           world_environment_identity_key,
           latitude, longitude, anchor_latitude, anchor_longitude,
           environment_snapshot, suppression_class
         ) VALUES (
           $1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,
           $11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19
         )`,
        [
          slot.entityId,
          slot.slotId,
          slot.candidateId,
          input.claim.identity.zoneId,
          definition.populationEntityKind,
          definition.populationArchetype,
          POPULATION_STONE_PLACEMENT_VERSION,
          definition.yieldedItem,
          definition.yieldQuantity,
          `${definition.regenerationMs} milliseconds`,
          definition.timerProfessionId,
          definition.timerVisibilityRank,
          input.claim.identity.worldEnvironmentIdentityKey,
          slot.position.lat,
          slot.position.lon,
          slot.anchor.lat,
          slot.anchor.lon,
          JSON.stringify(slot.environmentSnapshot),
          slot.suppressionClass
        ]
      );
      inserted.push(slot);
    } else {
      assertCompatiblePermanentMine(existing, slot, input.claim);
    }
    await client.query(
      `INSERT INTO population_plan_permanent_stones_v2 (
         plan_id, entity_id
       ) VALUES ($1::uuid,$2::uuid)
       ON CONFLICT (plan_id, entity_id) DO NOTHING`,
      [input.claim.planId, slot.entityId]
    );
    const membership = await client.query(
      `SELECT 1
       FROM population_plan_permanent_resources_v2
       WHERE plan_id=$1::uuid AND entity_id=$2::uuid`,
      [input.claim.planId, slot.entityId]
    );
    if (membership.rowCount !== 1) {
      throw permanentMineMismatch(
        "permanent mine plan membership was not established",
        input.claim,
        slot
      );
    }
  }
  return inserted;
}

async function adoptZonePermanentMinesForPlan(
  client: pg.PoolClient,
  input: Readonly<{ zoneId: string; planId: string }>
): Promise<void> {
  await client.query(
    `INSERT INTO population_plan_permanent_stones_v2 (plan_id, entity_id)
     SELECT $2::uuid, authority.entity_id
     FROM population_permanent_stone_authority_v2 AS authority
     JOIN population_zones_v2 AS plan
       ON plan.plan_id=$2::uuid
      AND plan.zone_id=$1
     WHERE authority.owner_zone_id=$1
     ON CONFLICT (plan_id, entity_id) DO NOTHING`,
    [input.zoneId, input.planId]
  );
}

async function adoptZoneOceanSulfurForPlan(
  client: pg.PoolClient,
  input: Readonly<{ zoneId: string; planId: string }>
): Promise<void> {
  await client.query(
    `INSERT INTO population_plan_ocean_sulfur_v1 (plan_id, entity_id)
     SELECT $2::uuid, authority.entity_id
     FROM population_ocean_sulfur_authority_v1 AS authority
     JOIN population_zones_v2 AS plan
       ON plan.plan_id=$2::uuid
      AND plan.zone_id=$1
     WHERE authority.owner_zone_id=$1
     ON CONFLICT (plan_id, entity_id) DO NOTHING`,
    [input.zoneId, input.planId]
  );
}

async function insertOrAdoptOceanSulfurDeposits(
  client: pg.PoolClient,
  input: Readonly<{
    claim: ClaimedPopulationZoneV2Plan;
    deposits: readonly OceanSulfurDeposit[];
  }>
): Promise<OceanSulfurDeposit[]> {
  assertUnique(
    input.deposits.map((deposit) => deposit.slotId),
    "ocean sulfur deposit slot"
  );
  assertUnique(
    input.deposits.map((deposit) => deposit.entityId),
    "ocean sulfur deposit entity"
  );
  const inserted: OceanSulfurDeposit[] = [];
  for (const deposit of [...input.deposits].sort((left, right) =>
    left.entityId.localeCompare(right.entityId)
  )) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`ocean-sulfur-deposit:${deposit.entityId}`]
    );
    const existing = await loadOceanSulfurAuthority(
      client,
      deposit.entityId,
      deposit.slotId
    );
    const slot = populationSlotForOceanSulfurDeposit(deposit);
    if (existing === null) {
      await insertSpawnSlots(client, {
        planId: input.claim.planId,
        generationId: null,
        slots: [slot]
      });
      await client.query(
        `INSERT INTO population_ocean_sulfur_authority_v1 (
           entity_id, slot_id, candidate_id, owner_zone_id,
           entity_kind, archetype, placement_version,
           yield_item_id, yield_quantity, regeneration_interval,
           timer_profession_id, timer_visibility_rank,
           world_environment_identity_key,
           latitude, longitude, anchor_latitude, anchor_longitude,
           environment_snapshot, suppression_class
         ) VALUES (
           $1::uuid,$2::uuid,$3,$4,'sulfur','sulfur_mine',
           'ocean-sulfur-placement-v1','sulfur',1,
           interval '5 hours 50 minutes','miner',2,$5,
           $6,$7,$8,$9,$10::jsonb,'none'
         )`,
        [
          deposit.entityId,
          deposit.slotId,
          deposit.candidateId,
          input.claim.identity.zoneId,
          input.claim.identity.worldEnvironmentIdentityKey,
          deposit.position.lat,
          deposit.position.lon,
          deposit.anchor.lat,
          deposit.anchor.lon,
          JSON.stringify(deposit.environmentSnapshot)
        ]
      );
      inserted.push(deposit);
    } else {
      assertCompatibleOceanSulfur(existing, deposit, input.claim);
    }
    await client.query(
      `INSERT INTO population_plan_ocean_sulfur_v1 (
         plan_id, entity_id
       ) VALUES ($1::uuid,$2::uuid)
       ON CONFLICT (plan_id, entity_id) DO NOTHING`,
      [input.claim.planId, deposit.entityId]
    );
    const membership = await client.query(
      `SELECT 1
       FROM population_plan_permanent_resources_v2
       WHERE plan_id=$1::uuid AND entity_id=$2::uuid`,
      [input.claim.planId, deposit.entityId]
    );
    if (membership.rowCount !== 1) {
      throw permanentMineMismatch(
        "ocean sulfur plan membership was not established",
        input.claim,
        slot
      );
    }
  }
  return inserted;
}

function populationSlotForOceanSulfurDeposit(
  deposit: OceanSulfurDeposit
): PopulationZoneV2PlanSlot {
  return {
    slotId: deposit.slotId,
    entityId: deposit.entityId,
    candidateId: deposit.candidateId,
    entityKind: deposit.entityKind,
    archetype: deposit.archetype,
    encounterId: null,
    packId: null,
    packMemberIndex: null,
    position: deposit.position,
    anchor: deposit.anchor,
    environmentSnapshot: deposit.environmentSnapshot,
    suppressionClass: deposit.suppressionClass
  };
}

async function loadOceanSulfurAuthority(
  client: pg.PoolClient,
  entityId: string,
  slotId?: string
): Promise<PermanentMineAuthorityRow | null> {
  const result = await client.query<PermanentMineAuthorityRow>(
    `SELECT slot.plan_id AS authority_plan_id,
            authority_plan.candidate_layout_version
              AS authority_candidate_layout_version,
            slot.generation_id,
            authority.entity_id, authority.slot_id,
            authority.candidate_id, authority.owner_zone_id,
            authority.entity_kind, authority.archetype,
            authority.placement_version AS stone_placement_version,
            authority.yield_item_id, authority.yield_quantity,
            EXTRACT(EPOCH FROM authority.regeneration_interval) * 1000
              AS regeneration_interval_ms,
            authority.timer_profession_id,
            authority.timer_visibility_rank,
            authority.world_environment_identity_key,
            authority.latitude, authority.longitude,
            authority.anchor_latitude, authority.anchor_longitude,
            authority.environment_snapshot, authority.suppression_class,
            state.state_revision,
            projection.id AS projection_id,
            projection.lat AS projection_latitude,
            projection.lon AS projection_longitude,
            projection.physical_population_zone_v2_id
              AS projection_zone_id,
            projection.population_v2_plan_id AS projection_plan_id,
            projection.placement_version AS projection_placement_version
     FROM population_ocean_sulfur_authority_v1 AS authority
     JOIN population_spawn_slots_v2 AS slot
       ON slot.entity_id=authority.entity_id
     JOIN population_zones_v2 AS authority_plan
       ON authority_plan.plan_id=slot.plan_id
     LEFT JOIN population_entity_state_v2 AS state
       ON state.entity_id=authority.entity_id
     LEFT JOIN repeatable_resource_nodes AS projection
       ON projection.population_v2_entity_id=authority.entity_id
     WHERE authority.entity_id=$1::uuid
        OR ($2::uuid IS NOT NULL AND authority.slot_id=$2::uuid)
     FOR UPDATE OF authority`,
    [entityId, slotId ?? null]
  );
  if (result.rows.length > 1) {
    throw new Error("multiple ocean sulfur authorities matched one identity");
  }
  return result.rows[0] ?? null;
}

function assertCompatibleOceanSulfur(
  existing: PermanentMineAuthorityRow,
  incoming: OceanSulfurDeposit,
  claim: ClaimedPopulationZoneV2Plan
): void {
  const definition = PERMANENT_RESOURCE_REGISTRY.requireDefinition("sulfur_mine");
  const compatible = existing.entity_id === incoming.entityId
    && existing.slot_id === incoming.slotId
    && existing.candidate_id === incoming.candidateId
    && existing.owner_zone_id === claim.identity.zoneId
    && existing.entity_kind === "sulfur"
    && existing.archetype === "sulfur_mine"
    && existing.stone_placement_version === "ocean-sulfur-placement-v1"
    && existing.yield_item_id === definition.yieldedItem
    && Number(existing.yield_quantity) === definition.yieldQuantity
    && Number(existing.regeneration_interval_ms) === definition.regenerationMs
    && existing.timer_profession_id === definition.timerProfessionId
    && Number(existing.timer_visibility_rank) === definition.timerVisibilityRank
    && existing.world_environment_identity_key
      === claim.identity.worldEnvironmentIdentityKey
    && existing.suppression_class === "none"
    && existing.generation_id === null;
  if (!compatible) {
    throw permanentMineMismatch(
      "immutable ocean sulfur authority does not match the incoming plan",
      claim,
      populationSlotForOceanSulfurDeposit(incoming)
    );
  }
  if (
    existing.state_revision === null
    || existing.projection_id !== incoming.entityId
    || Number(existing.projection_latitude) !== Number(existing.latitude)
    || Number(existing.projection_longitude) !== Number(existing.longitude)
    || existing.projection_zone_id !== existing.owner_zone_id
    || existing.projection_plan_id !== existing.authority_plan_id
    || existing.projection_placement_version
      !== existing.authority_candidate_layout_version
  ) {
    throw new PopulationPlanCompletionError(
      "existing ocean sulfur authority is missing durable state or its canonical projection",
      completionFailureDetails({
        code: "population-plan-corrupt-authority",
        retryable: false,
        claim,
        slot: populationSlotForOceanSulfurDeposit(incoming)
      })
    );
  }
}

async function loadPermanentMineAuthority(
  client: pg.PoolClient,
  entityId: string,
  slotId?: string
): Promise<PermanentMineAuthorityRow | null> {
  const result = await client.query<PermanentMineAuthorityRow>(
    `SELECT slot.plan_id AS authority_plan_id,
            authority_plan.candidate_layout_version
              AS authority_candidate_layout_version,
            slot.generation_id,
            authority.entity_id, authority.slot_id,
            authority.candidate_id, authority.owner_zone_id,
            authority.entity_kind, authority.archetype,
            authority.stone_placement_version,
            authority.yield_item_id, authority.yield_quantity,
            EXTRACT(EPOCH FROM authority.regeneration_interval) * 1000
              AS regeneration_interval_ms,
            authority.timer_profession_id,
            authority.timer_visibility_rank,
            authority.world_environment_identity_key,
            authority.latitude, authority.longitude,
            authority.anchor_latitude, authority.anchor_longitude,
            authority.environment_snapshot, authority.suppression_class,
            state.state_revision,
            projection.id AS projection_id,
            projection.lat AS projection_latitude,
            projection.lon AS projection_longitude,
            projection.physical_population_zone_v2_id
              AS projection_zone_id,
            projection.population_v2_plan_id AS projection_plan_id,
            projection.placement_version AS projection_placement_version
     FROM population_permanent_resource_authority_v2 AS authority
     JOIN population_spawn_slots_v2 AS slot
       ON slot.entity_id=authority.entity_id
     JOIN population_zones_v2 AS authority_plan
       ON authority_plan.plan_id=slot.plan_id
     LEFT JOIN population_entity_state_v2 AS state
       ON state.entity_id=authority.entity_id
     LEFT JOIN repeatable_resource_nodes AS projection
       ON projection.population_v2_entity_id=authority.entity_id
     WHERE authority.entity_id=$1::uuid
        OR ($2::uuid IS NOT NULL AND authority.slot_id=$2::uuid)
     FOR UPDATE OF authority`,
    [entityId, slotId ?? null]
  );
  if (result.rows.length > 1) {
    throw new Error("multiple permanent mine authorities matched one identity");
  }
  return result.rows[0] ?? null;
}

function assertCompatiblePermanentMine(
  existing: PermanentMineAuthorityRow,
  incoming: PopulationZoneV2PlanSlot,
  claim: ClaimedPopulationZoneV2Plan
): void {
  const definition = PERMANENT_RESOURCE_REGISTRY.requireDefinition(
    incoming.archetype
  );
  const compatible = existing.entity_id === incoming.entityId
    && existing.slot_id === incoming.slotId
    && existing.candidate_id === incoming.candidateId
    && existing.owner_zone_id === claim.identity.zoneId
    && existing.entity_kind === incoming.entityKind
    && existing.archetype === incoming.archetype
    && existing.stone_placement_version
      === POPULATION_STONE_PLACEMENT_VERSION
    && existing.yield_item_id === definition.yieldedItem
    && Number(existing.yield_quantity) === definition.yieldQuantity
    && Number(existing.regeneration_interval_ms)
      === definition.regenerationMs
    && existing.timer_profession_id === definition.timerProfessionId
    && Number(existing.timer_visibility_rank)
      === definition.timerVisibilityRank
    && existing.world_environment_identity_key
      === claim.identity.worldEnvironmentIdentityKey
    && existing.suppression_class === incoming.suppressionClass
    && existing.generation_id === null;
  if (!compatible) {
    throw permanentMineMismatch(
      "immutable permanent mine authority does not match the incoming plan",
      claim,
      incoming
    );
  }
  if (
    existing.state_revision === null
    || existing.projection_id !== incoming.entityId
    || Number(existing.projection_latitude) !== Number(existing.latitude)
    || Number(existing.projection_longitude) !== Number(existing.longitude)
    || existing.projection_zone_id !== existing.owner_zone_id
    || existing.projection_plan_id !== existing.authority_plan_id
    || existing.projection_placement_version
      !== existing.authority_candidate_layout_version
  ) {
    throw new PopulationPlanCompletionError(
      "existing permanent mine authority is missing durable state or its canonical projection",
      completionFailureDetails({
        code: "population-plan-corrupt-authority",
        retryable: false,
        claim,
        slot: incoming
      })
    );
  }
}

function permanentMineMismatch(
  message: string,
  claim: ClaimedPopulationZoneV2Plan,
  slot: PopulationZoneV2PlanSlot
): PopulationPlanCompletionError {
  return new PopulationPlanCompletionError(
    message,
    completionFailureDetails({
      code: "population-plan-immutable-stone-mismatch",
      retryable: false,
      claim,
      slot
    })
  );
}

function populationV2PlanSlotFromRegisteredMob(
  slot: PopulationV2RegisteredMobOverlaySlot
): PopulationZoneV2PlanSlot {
  return {
    slotId: slot.slotId,
    entityId: slot.entityId,
    candidateId: slot.candidateId,
    entityKind: slot.entityKind,
    archetype: slot.archetype,
    encounterId: slot.encounterId,
    packId: slot.packId,
    packMemberIndex: slot.packMemberIndex,
    position: slot.position,
    anchor: slot.anchor,
    environmentSnapshot: slot.environmentSnapshot,
    suppressionClass: slot.suppressionClass
  };
}

async function insertGenerationRegisteredMobManifest(
  client: pg.PoolClient,
  input: Readonly<{
    generationId: string;
    manifest: PopulationV2RegisteredMobOverlayResult<string>;
    attemptedAt: Date;
  }>
): Promise<void> {
  if (input.manifest.mobs.length === 0) return;
  if (input.manifest.mobs.some((mob) =>
    mob.status === "terminal_partial_group"
  )) {
    throw new Error(
      "new Population V2 generation cannot persist a partial mob manifest"
    );
  }
  const result = await client.query(
    `INSERT INTO population_generation_mob_rollouts_v2 (
       generation_id, mob_kind, rollout_revision, source, status,
       target_group_count, target_body_count,
       inserted_group_count, inserted_body_count,
       shortfall_group_count, attempt_count, next_retry_at,
       last_error, attempted_at, completed_at
     )
     SELECT $1::uuid, manifest.mob_kind, manifest.rollout_revision,
            'generation', manifest.status,
            manifest.target_group_count, manifest.target_body_count,
            manifest.inserted_group_count, manifest.inserted_body_count,
            manifest.shortfall_group_count, 1, NULL, NULL, $3, $3
     FROM jsonb_to_recordset($2::jsonb) AS manifest(
       mob_kind text, rollout_revision text, status text,
       target_group_count integer, target_body_count integer,
       inserted_group_count integer, inserted_body_count integer,
       shortfall_group_count integer
     )`,
    [
      input.generationId,
      JSON.stringify(input.manifest.mobs.map((mob) => ({
        mob_kind: mob.mobKind,
        rollout_revision: mob.placementRevision,
        status: mob.status,
        target_group_count: mob.target.groups,
        target_body_count: mob.target.bodies,
        inserted_group_count: mob.inserted.groups,
        inserted_body_count: mob.inserted.bodies,
        shortfall_group_count: mob.shortfall.groups
      }))),
      input.attemptedAt
    ]
  );
  if (result.rowCount !== input.manifest.mobs.length) {
    throw new Error(
      "Population V2 generation did not persist every registered-mob manifest"
    );
  }
}

async function insertGenerationKindManifest(
  client: pg.PoolClient,
  input: Readonly<{
    generationId: string;
    slots: readonly PopulationZoneV2PlanSlot[];
    registry: Pick<PopulationV2KindRegistry, "requireDefinition">;
    recordedAt: Date;
  }>
): Promise<void> {
  const definitions = [...new Set(input.slots.map((slot) => slot.entityKind))]
    .sort()
    .map((kindKey) => input.registry.requireDefinition(kindKey))
    .filter((definition) =>
      definition.lifecyclePolicy !== "PERMANENT_REPEATABLE"
      && definition.lifecyclePolicy !== "STATIC_DECORATION"
    );
  if (definitions.length === 0) return;
  const result = await client.query(
    `INSERT INTO population_generation_kind_manifest_v2 (
       generation_id, kind_key, placement_revision, lifecycle_revision,
       source, group_atomic, recorded_at
     )
     SELECT $1::uuid, manifest.kind_key, manifest.placement_revision,
            manifest.lifecycle_revision, 'generation',
            manifest.group_atomic, $3
     FROM jsonb_to_recordset($2::jsonb) AS manifest(
       kind_key text, placement_revision text,
       lifecycle_revision text, group_atomic boolean
     )`,
    [
      input.generationId,
      JSON.stringify(definitions.map((definition) => ({
        kind_key: definition.kindKey,
        placement_revision: definition.placementRevision,
        lifecycle_revision: definition.lifecycleRevision,
        group_atomic: definition.groupPolicy.atomic
      }))),
      input.recordedAt
    ]
  );
  if (result.rowCount !== definitions.length) {
    throw new Error(
      "Population V2 generation did not persist every kind manifest"
    );
  }
}

async function insertSpawnSlots(
  client: pg.PoolClient,
  input: Readonly<{
    planId: string;
    generationId: string | null;
    slots: readonly PopulationZoneV2PlanSlot[];
  }>
): Promise<void> {
  if (input.slots.length === 0) return;
  await client.query(
    `INSERT INTO population_spawn_slots_v2 (
       plan_id, generation_id, slot_id, entity_id, candidate_id, entity_kind,
       archetype, encounter_id, pack_id, pack_member_index,
       latitude, longitude, geom, anchor_latitude, anchor_longitude,
       anchor_geom, environment_snapshot, suppression_class
     )
     SELECT $1::uuid, $2::uuid, slot.slot_id, slot.entity_id,
            slot.candidate_id, slot.entity_kind, slot.archetype,
            slot.encounter_id, slot.pack_id, slot.pack_member_index,
            slot.latitude, slot.longitude,
            ST_SetSRID(ST_MakePoint(slot.longitude, slot.latitude),4326)::geography,
            slot.anchor_latitude, slot.anchor_longitude,
            ST_SetSRID(ST_MakePoint(
              slot.anchor_longitude, slot.anchor_latitude
            ),4326)::geography,
            slot.environment_snapshot, slot.suppression_class
     FROM jsonb_to_recordset($3::jsonb) AS slot(
       slot_id uuid, entity_id uuid, candidate_id text,
       entity_kind text, archetype text, encounter_id uuid,
       pack_id uuid, pack_member_index smallint,
       latitude double precision, longitude double precision,
       anchor_latitude double precision, anchor_longitude double precision,
       environment_snapshot jsonb, suppression_class text
     )`,
    [
      input.planId,
      input.generationId,
      JSON.stringify(input.slots.map(slotForDatabase))
    ]
  );
}

async function insertPlanProjections(
  client: pg.PoolClient,
  plan: GeneratedPopulationZoneV2Plan,
  cutoverRevision: number,
  runtimeMobKinds: readonly string[],
  registeredMobPlacementRevisionsByEntityId:
    ReadonlyMap<string, string> = new Map()
): Promise<void> {
  const projectionRows = plan.slots.map((slot) =>
    populationV2ProjectionRowForSlot({
      slot,
      regionCode: plan.habitat.regionCode,
      defaultPlacementVersion: plan.identity.candidateLayoutVersion,
      ...(registeredMobPlacementRevisionsByEntityId.get(slot.entityId) ===
          undefined
        ? {}
        : {
            registeredPlacementRevision:
              registeredMobPlacementRevisionsByEntityId.get(slot.entityId)!
          })
    })
  );
  const spawnCells = new Map<
    string,
    (typeof projectionRows)[number]
  >();
  for (const row of projectionRows) spawnCells.set(row.spawn_cell_id, row);
  await client.query(
    `INSERT INTO spawn_cells (
       id, region_code, cell_x, cell_y, center_lat, center_lon
     )
     SELECT cell.spawn_cell_id, cell.spawn_cell_region_code,
            cell.spawn_cell_x, cell.spawn_cell_y,
            cell.spawn_cell_center_lat, cell.spawn_cell_center_lon
     FROM jsonb_to_recordset($1::jsonb) AS cell(
       spawn_cell_id text, spawn_cell_region_code text,
       spawn_cell_x integer, spawn_cell_y integer,
       spawn_cell_center_lat double precision,
       spawn_cell_center_lon double precision
     )
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify([...spawnCells.values()])]
  );

  await client.query(
    `INSERT INTO collectible_nodes (
       id, cell_id, region_code, resource_type, quantity,
       lat, lon, geom, state, harvested_at, harvested_by_player_id,
       env_snapshot,
       placement_version, population_v2_entity_id,
       physical_population_zone_v2_id, population_v2_plan_id,
       population_v2_state_revision, population_cutover_revision,
       population_cutover_suppressed
     )
     SELECT collectible.entity_id::text, collectible.spawn_cell_id, $2,
            collectible.resource_type,
            collectible.collectible_yield_quantity,
            collectible.latitude, collectible.longitude,
            ST_SetSRID(ST_MakePoint(collectible.longitude, collectible.latitude),4326),
            CASE WHEN canonical.state='ready' THEN 'available' ELSE 'harvested' END,
            CASE WHEN canonical.state='ready'
              THEN NULL ELSE canonical.killed_or_harvested_at END,
            CASE WHEN canonical.state='ready'
              THEN NULL ELSE canonical.state_actor_player_id END,
            collectible.environment_snapshot,
            $3, collectible.entity_id, $4, $1::uuid,
            canonical.state_revision, $5, false
     FROM jsonb_to_recordset($6::jsonb) AS collectible(
       entity_id uuid, entity_kind text, spawn_cell_id text,
       resource_type text, collectible_yield_quantity integer,
       latitude double precision, longitude double precision,
       environment_snapshot jsonb
     )
     JOIN population_entity_state_v2 AS canonical
       ON canonical.entity_id=collectible.entity_id
     WHERE collectible.entity_kind IN ('tree','flax')
       AND collectible.resource_type IS NOT NULL
       AND collectible.collectible_yield_quantity IS NOT NULL`,
    [
      plan.planId,
      plan.habitat.regionCode,
      plan.identity.candidateLayoutVersion,
      plan.identity.zoneId,
      cutoverRevision,
      JSON.stringify(projectionRows)
    ]
  );

  await client.query(
    `INSERT INTO generated_world_mobs (
       entity_id, encounter_id, mob_archetype, pack_id,
       spawn_cell_id, region_code, lat, lon, geom,
       anchor_lat, anchor_lon, placement_version,
       environment_world_identity_key, environment_profile_version,
       environment_candidate_slot_version, environment_cell_id,
       environment_slot_id, environment_snapshot,
       population_v2_entity_id, physical_population_zone_v2_id,
       population_v2_plan_id, population_v2_state_revision,
       population_cutover_revision, population_cutover_suppressed
     )
     SELECT mob.entity_id::text, mob.encounter_id::text, mob.archetype,
            mob.pack_id::text, mob.spawn_cell_id, $2,
            mob.latitude, mob.longitude,
            ST_SetSRID(ST_MakePoint(mob.longitude, mob.latitude),4326),
            mob.anchor_latitude, mob.anchor_longitude,
            COALESCE(mob.placement_version, $3),
            NULL, NULL, NULL, NULL, NULL, mob.environment_snapshot,
            mob.entity_id, $4, $1::uuid, 0, $5, false
     FROM jsonb_to_recordset($6::jsonb) AS mob(
       entity_id uuid, entity_kind text, archetype text,
       encounter_id uuid, pack_id uuid, placement_version text,
       spawn_cell_id text, latitude double precision,
       longitude double precision, anchor_latitude double precision,
       anchor_longitude double precision, environment_snapshot jsonb
     )
     WHERE mob.entity_kind=ANY($7::text[])`,
    [
      plan.planId,
      plan.habitat.regionCode,
      plan.identity.candidateLayoutVersion,
      plan.identity.zoneId,
      cutoverRevision,
      JSON.stringify(projectionRows),
      [...runtimeMobKinds]
    ]
  );

  await client.query(
    `INSERT INTO repeatable_resource_nodes (
       id, node_type, region_code, lat, lon, geom,
       yield_item_id, yield_quantity, regeneration_interval,
       ready_at, harvest_revision, last_harvested_by,
       authored_source, placement_bucket_key, placement_version,
       population_v2_entity_id, physical_population_zone_v2_id,
       population_v2_plan_id, population_v2_state_revision,
       population_cutover_revision, population_cutover_suppressed
     )
     SELECT authority.entity_id, authority.node_type, $2,
            authority.latitude, authority.longitude,
            ST_SetSRID(
              ST_MakePoint(authority.longitude, authority.latitude),4326
            ),
            authority.yield_item_id, authority.yield_quantity,
            authority.regeneration_interval,
            '-infinity'::timestamptz,
            0, NULL, 'population-v2',
            'population-v2:' || authority.entity_id::text, $3,
            authority.entity_id, $4, $1::uuid, 0, $5, false
     FROM population_permanent_resource_authority_v2 AS authority
     WHERE authority.entity_id=ANY($6::uuid[])`,
    [
      plan.planId,
      plan.habitat.regionCode,
      plan.identity.candidateLayoutVersion,
      plan.identity.zoneId,
      cutoverRevision,
      plan.slots
        .filter((slot) => isPermanentMineEntityKind(slot.entityKind))
        .map((slot) => slot.entityId)
    ]
  );
}

async function insertOceanSulfurProjections(
  client: pg.PoolClient,
  deposits: readonly OceanSulfurDeposit[],
  regionCode: string,
  placementVersion: string,
  zoneId: string,
  planId: string,
  cutoverRevision: number
): Promise<void> {
  if (deposits.length === 0) return;
  await client.query(
    `INSERT INTO repeatable_resource_nodes (
       id, node_type, region_code, lat, lon, geom,
       yield_item_id, yield_quantity, regeneration_interval,
       ready_at, harvest_revision, last_harvested_by,
       authored_source, placement_bucket_key, placement_version,
       population_v2_entity_id, physical_population_zone_v2_id,
       population_v2_plan_id, population_v2_state_revision,
       population_cutover_revision, population_cutover_suppressed
     )
     SELECT authority.entity_id, authority.archetype, $2,
            authority.latitude, authority.longitude,
            ST_SetSRID(
              ST_MakePoint(authority.longitude, authority.latitude),4326
            ),
            authority.yield_item_id, authority.yield_quantity,
            authority.regeneration_interval,
            '-infinity'::timestamptz,
            0, NULL, 'population-v2',
            'population-v2:' || authority.entity_id::text, $3,
            authority.entity_id, $4, $1::uuid, 0, $5, false
     FROM population_ocean_sulfur_authority_v1 AS authority
     WHERE authority.entity_id=ANY($6::uuid[])
     ON CONFLICT (id) DO NOTHING`,
    [
      planId,
      regionCode,
      placementVersion,
      zoneId,
      cutoverRevision,
      deposits.map((deposit) => deposit.entityId)
    ]
  );
}

export function populationV2ProjectionRowForSlot(input: Readonly<{
  slot: PopulationZoneV2PlanSlot;
  regionCode: string;
  defaultPlacementVersion: string;
  registeredPlacementRevision?: string;
}>) {
  const cell = spawnCellForPoint(input.slot.position, input.regionCode);
  return {
    ...slotForDatabase(input.slot),
    resource_type: input.slot.entityKind === "tree"
      ? "wood"
      : input.slot.entityKind === "flax"
        ? "flax_fiber"
        : null,
    collectible_yield_quantity: input.slot.entityKind === "tree"
      ? treeWoodYieldForStableId(input.slot.entityId)
      : input.slot.entityKind === "flax"
        ? FLAX_FIBER_HARVEST_YIELD_QUANTITY
        : null,
    tree_yield_quantity: input.slot.entityKind === "tree"
      ? treeWoodYieldForStableId(input.slot.entityId)
      : null,
    placement_version:
      input.registeredPlacementRevision ?? input.defaultPlacementVersion,
    spawn_cell_id: cell.id,
    spawn_cell_region_code: cell.regionCode,
    spawn_cell_x: cell.cellX,
    spawn_cell_y: cell.cellY,
    spawn_cell_center_lat: cell.center.lat,
    spawn_cell_center_lon: cell.center.lon
  };
}

function assertGeneratedPlanMatchesClaim(
  plan: GeneratedPopulationZoneV2Plan,
  claim: ClaimedPopulationZoneV2Plan
): void {
  if (plan.planId !== claim.planId) {
    throw new Error("claimed and generated population plan IDs differ");
  }
  assertIdentityEquals(plan.identity, claim.identity);
  const canonicalGeometry = populationZoneV2Geometry(
    claim.identity.zoneId as PopulationZoneV2Id
  );
  if (!populationZoneV2GeometryEquals(plan.geometry, canonicalGeometry)) {
    throw new Error("generated population plan geometry is not canonical");
  }
  for (const [label, areaKm2] of [
    ["eligible land", plan.habitat.eligibleLandKm2],
    ["tree", plan.habitat.treeKm2],
    ["flax", plan.habitat.flaxKm2 ?? 0],
    ["deer", plan.habitat.deerKm2],
    ["wolf", plan.habitat.wolfKm2],
    ["ogre", plan.habitat.ogreKm2],
    ["stone", plan.habitat.stoneKm2]
  ] as const) {
    if (
      !Number.isFinite(areaKm2)
      || areaKm2 < 0
      || areaKm2 > canonicalGeometry.areaKm2
    ) {
      throw new Error(`generated population plan ${label} area is invalid`);
    }
  }
  if (plan.habitat.regionCode.length === 0) {
    throw new Error("generated population plan habitat region is required");
  }
  const computedContentHash = populationZoneV2PlanContentHash(plan);
  if (plan.contentHash !== computedContentHash) {
    throw new Error("generated population plan content hash does not match its content");
  }
}

function assertGeneratedPlanMatchesAdmission(
  plan: GeneratedPopulationZoneV2Plan,
  claim: ClaimedPopulationZoneV2Plan,
  admitted: ClaimedPlanRow
): void {
  const stored = rowToPlanRecord(admitted);
  assertIdentityEquals(stored.identity, claim.identity);
  // World runtime SHA records the compiler that admitted the immutable plan.
  // A later runtime may complete it when the stable World-data identity above
  // and all canonical plan authority still match.
  if (
    stored.planId !== claim.planId
    || stored.regionCode !== plan.habitat.regionCode
  ) {
    throw new Error("generated population plan does not match its admission");
  }
  const geometry = plan.geometry;
  if (
    admitted.band_index !== geometry.address.band
    || admitted.column_index !== geometry.address.column
    || Number(admitted.total_area_km2) !== geometry.areaKm2
    || Number(admitted.center_latitude) !== geometry.center.lat
    || Number(admitted.center_longitude) !== geometry.center.lon
    || !admitted.zone_geometry_matches
  ) {
    throw new Error("admitted population plan geometry is not canonical");
  }
}

function populationZoneV2GeometryEquals(
  left: GeneratedPopulationZoneV2Plan["geometry"],
  right: GeneratedPopulationZoneV2Plan["geometry"]
): boolean {
  return left.id === right.id
    && left.address.band === right.address.band
    && left.address.column === right.address.column
    && left.bounds.southLat === right.bounds.southLat
    && left.bounds.northLat === right.bounds.northLat
    && left.bounds.westLon === right.bounds.westLon
    && left.bounds.eastLon === right.bounds.eastLon
    && left.center.lat === right.center.lat
    && left.center.lon === right.center.lon
    && left.areaM2 === right.areaM2
    && left.areaKm2 === right.areaKm2
    && left.northSouthSpanM === right.northSouthSpanM
    && left.centerEastWestSpanM === right.centerEastWestSpanM;
}

function assertRequestIdentity(request: PopulationZoneV2PlanRequest): void {
  if (request.planId !== populationZoneV2PlanId(request.identity)) {
    throw new Error("population plan request ID does not match its identity");
  }
}

function assertStoredRequestMatches(
  stored: PopulationZoneV2PlanRecord,
  requested: PopulationZoneV2PlanRequest
): void {
  assertIdentityEquals(stored.identity, requested.identity);
  // World runtime SHA is provenance for the compiler that first materialized
  // the immutable plan. The stable World-data identity above is authoritative,
  // so a later compiler runtime must be able to reuse the same ready plan.
  if (
    stored.planId !== requested.planId
    || stored.regionCode !== requested.regionCode
  ) {
    throw new Error(`stored population plan ${stored.planId} does not match request`);
  }
}

function assertIdentityEquals(
  left: PopulationZoneV2PlanIdentity,
  right: PopulationZoneV2PlanIdentity
): void {
  assertSamePopulationZoneV2PlanAuthority(left, right);
}

export function populationPlanCompletionFailureDetails(
  error: unknown
): PopulationPlanCompletionFailureDetails | null {
  return error instanceof PopulationPlanCompletionError
    ? error.details
    : null;
}

function populationPlanCompletionError(
  error: unknown,
  claim: ClaimedPopulationZoneV2Plan,
  plan: GeneratedPopulationZoneV2Plan
): PopulationPlanCompletionError {
  if (error instanceof PopulationPlanCompletionError) return error;
  const database = databaseErrorFields(error);
  const entityId = entityIdFromDatabaseDetail(database.detail);
  const slot = entityId === null
    ? null
    : plan.slots.find((entry) => entry.entityId === entityId) ?? null;
  const classification = classifyPopulationPlanFailure(error);
  return new PopulationPlanCompletionError(
    errorSummary(error),
    completionFailureDetails({
      code: classification.code,
      retryable: classification.retryable,
      claim,
      slot,
      postgresCode: database.code,
      constraint: database.constraint,
      table: database.table
    }),
    error instanceof Error ? { cause: error } : undefined
  );
}

function completionFailureDetails(input: Readonly<{
  code: PopulationPlanFailureCode;
  retryable: boolean;
  claim: ClaimedPopulationZoneV2Plan;
  slot: PopulationZoneV2PlanSlot | null;
  postgresCode?: string | null;
  constraint?: string | null;
  table?: string | null;
}>): PopulationPlanCompletionFailureDetails {
  return {
    code: input.code,
    retryable: input.retryable,
    postgresCode: input.postgresCode ?? null,
    constraint: input.constraint ?? null,
    table: input.table ?? null,
    zoneId: input.claim.identity.zoneId,
    planId: input.claim.planId,
    spawnRulesVersion: input.claim.identity.spawnRulesVersion,
    slotId: input.slot?.slotId ?? null,
    entityId: input.slot?.entityId ?? null,
    entityKind: input.slot?.entityKind ?? null,
    generationId: null,
    claimGeneration: input.claim.claimGeneration,
    attemptCount: input.claim.attemptCount
  };
}

function classifyPopulationPlanFailure(error: unknown): Readonly<{
  code: PopulationPlanFailureCode;
  retryable: boolean;
}> {
  if (error instanceof PopulationPlanCompletionError) {
    return {
      code: error.details.code,
      retryable: error.details.retryable
    };
  }
  const database = databaseErrorFields(error);
  if (
    database.code === "40001"
    || database.code === "40P01"
    || database.code?.startsWith("08")
    || ["57P01", "57P02", "57P03"].includes(database.code ?? "")
  ) {
    return {
      code: "population-plan-transient-database",
      retryable: true
    };
  }
  if (
    database.code === "23505"
    && database.constraint === "population_spawn_slots_v2_entity_id_key"
  ) {
    return {
      code: "population-plan-entity-identity-collision",
      retryable: false
    };
  }
  if (database.code?.startsWith("23")) {
    return {
      code: "population-plan-deterministic-constraint",
      retryable: false
    };
  }
  return {
    code: "population-plan-generation-failure",
    retryable: true
  };
}

function databaseErrorFields(error: unknown): Readonly<{
  code: string | null;
  constraint: string | null;
  table: string | null;
  detail: string | null;
}> {
  if (typeof error !== "object" || error === null) {
    return { code: null, constraint: null, table: null, detail: null };
  }
  const record = error as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : null,
    constraint:
      typeof record.constraint === "string" ? record.constraint : null,
    table: typeof record.table === "string" ? record.table : null,
    detail: typeof record.detail === "string" ? record.detail : null
  };
}

function entityIdFromDatabaseDetail(detail: string | null): string | null {
  if (detail === null) return null;
  return detail.match(
    /Key \(entity_id\)=\(([0-9a-f-]{36})\)/u
  )?.[1] ?? null;
}

function assertRepairCandidateIdentity(
  row: StoneConflictRepairCandidateRow
): void {
  if (
    row.zone_id !== row.selected_zone_id
    || row.geometry_version !== row.selected_geometry_version
    || row.world_environment_identity_key
      !== row.selected_world_environment_identity_key
    || row.plan_version !== POPULATION_PLAN_VERSION
    || row.spawn_rules_version !== POPULATION_SPAWN_RULES_VERSION
    || row.candidate_layout_version !== POPULATION_CANDIDATE_LAYOUT_VERSION
    || row.environment_profile_version
      !== row.selected_environment_profile_version
    || row.candidate_layout_version
      !== row.selected_candidate_layout_version
    || row.respawn_policy_version
      !== row.selected_respawn_policy_version
  ) {
    throw new Error(
      `population stone repair authority mismatch for ${row.plan_id}`
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} inputs must be unique`);
  }
}

function assertPositiveMilliseconds(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer number of milliseconds`);
  }
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
}

function errorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

async function rollbackQuietly(client: pg.PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
}
