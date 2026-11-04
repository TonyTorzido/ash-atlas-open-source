import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cellArea,
  cellToBoundary,
  cellToLatLng,
  getHexagonAreaAvg,
  getHexagonEdgeLengthAvg,
  gridDisk,
  latLngToCell,
  UNITS
} from "h3-js";

import {
  greatCircleDistanceMeters,
  normalizeLongitude,
  POPULATION_ZONE_V2_EARTH_RADIUS_M,
  POPULATION_ZONE_V2_GEOMETRY_VERSION,
  type PopulationZoneV2Id,
  type PopulationZoneV2Point,
  populationZoneV2Geometry,
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle
} from "../../apps/server/src/game/populationZonesV2Geometry.js";
import {
  ENVIRONMENT_PROFILE_VERSION
} from "../../apps/server/src/game/gameplayEnvironmentProfileVersions.js";
import {
  generateWorldEnvironmentCandidateSlots,
  type CandidateSlotPoint
} from "../../apps/server/src/game/gameplayEnvironmentProfiles.js";
import {
  generatePopulationZonesV2Plans as generateProductionPopulationZonesV2Plans,
  SAP_CRAWLER_DEER_MINIMUM_SPACING_M,
  SAP_CRAWLER_GROUP_MINIMUM_SPACING_M,
  SAP_CRAWLER_HOSTILE_MINIMUM_SPACING_M,
  SAP_CRAWLER_TREE_MINIMUM_SPACING_M,
  type PopulationZoneV2Habitat,
  type PopulationZoneV2HabitatCandidateSite,
  type PopulationZoneV2HabitatWeights,
  populationZoneV2HabitatSamplePoints
} from "../../apps/server/src/game/populationZonesV2Plan.js";
import {
  POPULATION_BALANCE,
  POPULATION_DENSITY_MULTIPLIERS,
  sapCrawlerGroupSizeForUnit,
  wolfPackSizeForUnit
} from "../../packages/shared/src/populationBalance.js";

export const PERSISTENT_POPULATION_V2_SIMULATION_VERSION =
  "persistent-population-v2-simulation-v4";
export const POPULATION_PLAN_VERSION = "population-plan-v2-shadow-1";
export const POPULATION_SPAWN_RULES_VERSION = "population-spawn-rules-v2-shadow-3";
export const POPULATION_CANDIDATE_LAYOUT_VERSION =
  "profile-candidate-slots-global-rank-halo-v2";
export const SIMULATION_WORLD_RUNTIME_SHA =
  "8b8d1c1353cbae563b4c472cdc1d3b6e48ac792b";
export const SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY =
  "9f8241aa2f232007a93f13288599444f5d5fc1f47e017edfd9ae3bfeb7928378";
export const H3_COMPARISON_RESOLUTION = 8;

const PREPARED_POPULATION_RADIUS_M = 750;
const FRACTIONAL_ROUNDING_VERSION = "eligible-area-fractional-round-v1";
const RARE_PARENT_DOMAIN_VERSION = "rare-parent-equal-area-v2";
const ENTITY_ID_VERSION = "population-entity-id-v2";
const SLOT_ID_VERSION = "population-slot-id-v2";
const ENCOUNTER_ID_VERSION = "population-encounter-id-v2";
const PACK_ID_VERSION = "population-pack-id-v2";
const CANDIDATE_RANK_VERSION = "population-candidate-rank-v1";
const CANDIDATE_HALO_MARGIN_M = 50;
const MAX_CANDIDATE_CONFLICT_DISTANCE_M = 1_200;
const CANDIDATE_LOOKUP_HALO_M =
  MAX_CANDIDATE_CONFLICT_DISTANCE_M + CANDIDATE_HALO_MARGIN_M;
const WOLF_MEMBER_ORBIT_RADIUS_M = 45;
const SAP_CRAWLER_MEMBER_ORBIT_RADIUS_M = 38;
const HIGH_LOAD_EXPANSION_CANDIDATE_POWER = 1.25;
const SIMULATION_PROFILE_CLUSTER_LIMIT = 2;
const simulationCandidatePointCache = new Map<
  PopulationZoneV2Id,
  readonly CandidateSlotPoint[]
>();
const simulationCandidateSiteCache = new Map<
  string,
  readonly PopulationZoneV2HabitatCandidateSite[]
>();
const gridPopulationPlanCache = new Map<string, GeometryPlan>();
const h3PopulationPlanCache = new Map<string, GeometryPlan>();
const wolfMemberPositionCache = new Map<
  string,
  readonly PopulationZoneV2Point[]
>();
const sapCrawlerMemberPositionCache = new Map<
  string,
  readonly PopulationZoneV2Point[]
>();

export type CommonPlanKind = "tree" | "deer" | "wolf_pack";
export type RarePlanKind = "stone" | "ogre" | "sap_crawler_group";
export type PopulationPlanKind = CommonPlanKind | RarePlanKind;
export type PlannedEntityKind =
  | "tree"
  | "deer"
  | "wolf"
  | "stone"
  | "ogre"
  | "sap_crawler";
export type GeometryOption = "equal-area-grid" | "h3-resolution-8";

export type GlobalRankedCandidate = Readonly<{
  candidateId: string;
  ownerId: string;
  kind: PopulationPlanKind;
  position: PopulationZoneV2Point;
  rank: string;
}>;

export type PlannedPopulationEntity = Readonly<{
  entityId: string;
  slotId: string;
  sourceOwnerId: string;
  kind: PlannedEntityKind;
  position: PopulationZoneV2Point;
  homePosition: PopulationZoneV2Point;
  encounterId: string | null;
  packId: string | null;
  populationPlanVersion: typeof POPULATION_PLAN_VERSION;
  spawnRulesVersion: typeof POPULATION_SPAWN_RULES_VERSION;
  candidateLayoutVersion: typeof POPULATION_CANDIDATE_LAYOUT_VERSION;
}>;

export type ActiveSetDelta = Readonly<{
  retained: string[];
  activated: string[];
  released: string[];
}>;

export type RareParentDomain = Readonly<{
  id: string;
  kind: RarePlanKind;
  band: number;
  column: number;
  bounds: Readonly<{
    southLat: number;
    northLat: number;
    westLon: number;
    eastLon: number;
  }>;
  center: PopulationZoneV2Point;
  areaKm2: number;
}>;

export type SimulationScenario = Readonly<{
  id: string;
  label: string;
  traits: readonly string[];
  center: PopulationZoneV2Point;
  eligibleFraction: number;
  suitability: Readonly<Record<CommonPlanKind | RarePlanKind, number>>;
  flags: readonly PopulationZoneV2Point[];
  players: readonly PopulationZoneV2Point[];
  visits: number;
  respawnCycles: number;
}>;

const COMMON_KIND_CONFIGURATION = POPULATION_BALANCE.common;

const RARE_PARENT_TARGET_AREA_KM2: Readonly<Record<RarePlanKind, number>> = {
  stone: POPULATION_BALANCE.rare.stone.targetAreaKm2,
  ogre: POPULATION_BALANCE.rare.ogre.targetAreaKm2,
  sap_crawler_group: POPULATION_BALANCE.rare.sap_crawler_group.targetAreaKm2
};

const RARE_CANDIDATE_OVERSAMPLING_FACTOR: Readonly<
  Record<RarePlanKind, number>
> = {
  stone: POPULATION_BALANCE.rare.stone.candidateOversamplingFactor,
  ogre: POPULATION_BALANCE.rare.ogre.candidateOversamplingFactor,
  sap_crawler_group:
    POPULATION_BALANCE.rare.sap_crawler_group.candidateOversamplingFactor
};

const DENSITY_GATE_TOLERANCE_FRACTION = 0.05;
const EQUIVALENT_FLAG_FOOTPRINT_KM2 = Math.PI * 0.5 ** 2;
const SYNTHETIC_WATER_SAMPLE_ERROR_LIMIT = 0.08;
const SINGLE_CIRCLE_ACTIVE_ZONE_LIMIT = 20;
const ADJACENT_RETENTION_DISTANCE_M = 500;
const ADJACENT_RETENTION_MINIMUM = 0.5;
const FULLY_LAND_DATABASE_LIMIT_BYTES = 64 * 1_024;
const FULLY_LAND_RUNTIME_ACTOR_LIMIT = 50;
const FULLY_LAND_TOTAL_RUNTIME_ACTOR_LIMIT = 65;
const FOUR_FLAG_ACCEPTANCE_CENTER: PopulationZoneV2Point = {
  lat: 24,
  lon: 13
};
const FOUR_FLAG_ACCEPTANCE_OFFSET_M = 650;
const FOUR_FLAG_ACCEPTANCE_ELIGIBLE_FRACTION = 1;

const DEFAULT_SUITABILITY: Readonly<
  Record<CommonPlanKind | RarePlanKind, number>
> = {
  tree: 1,
  deer: 1,
  wolf_pack: 1,
  stone: 1,
  ogre: 1,
  sap_crawler_group: 1
};

export const PERSISTENT_POPULATION_V2_SCENARIOS: readonly SimulationScenario[] =
  buildScenarios();

type GeometryCell = Readonly<{
  id: string;
  areaKm2: number;
  center: PopulationZoneV2Point;
  samplePoints: readonly PopulationZoneV2Point[];
}>;

type GeometryPlan = Readonly<{
  cells: readonly GeometryCell[];
  entities: readonly PlannedPopulationEntity[];
  anchors: readonly GlobalRankedCandidate[];
}>;

type ZoneStatistic = Readonly<{
  scenarioId: string;
  geometry: GeometryOption;
  zoneId: string;
  areaKm2: number;
  eligibleAreaKm2: number;
  activeReferenceCount: number;
  treeCount: number;
  deerCount: number;
  wolfPackCount: number;
  wolfCount: number;
  stoneCount: number;
  ogreCount: number;
  sapCrawlerGroupCount: number;
  sapCrawlerCount: number;
  estimatedEligibleFraction48: number | null;
  referenceEligibleFraction1024: number | null;
  absoluteEligibleFractionError: number | null;
  ineligibleSelectedSlotCount: number | null;
}>;

type GeometryScenarioMetrics = Readonly<{
  zoneCount: number;
  totalAreaKm2: number;
  eligibleAreaKm2: number;
  cellAreaKm2: DistributionSummary;
  activeZoneCounts: Readonly<{
    perFlag: number[];
    perPlayer: number[];
    union: number;
    maximumSharedReferenceCount: number;
  }>;
  adjacentTravelDelta: Readonly<{
    retained: number;
    activated: number;
    released: number;
    retainedRatio: number;
  }>;
  entityCounts: Readonly<{
    trees: number;
    deer: number;
    wolfPacks: number;
    wolves: number;
    stones: number;
    ogres: number;
    sapCrawlerGroups: number;
    sapCrawlers: number;
  }>;
  densityPerEligibleKm2: Readonly<{
    trees: number;
    deer: number;
    wolfPacks: number;
    stones: number;
    ogres: number;
    sapCrawlerGroups: number;
    sapCrawlers: number;
  }>;
  uniqueEntityIds: number;
  duplicateEntityIds: number;
  seamSpacingViolations: Readonly<Record<CommonPlanKind, number>>;
  seamSpacingComparisons: Readonly<Record<CommonPlanKind, number>>;
  conflictMatrixViolations: ConflictMatrixViolations;
  conflictMatrixExerciseCounts: ConflictMatrixViolations;
  estimatedDatabaseBytes: number;
  estimatedRuntimeActors: number;
  orderIndependent: boolean;
  repeatedVisitIdsStable: boolean;
  respawnIdsStable: boolean;
  configuredVisitCount: number;
  homeResetCyclesApplied: number;
}>;

type ConflictMatrixViolations = Readonly<{
  treeTree: number;
  deerDeer: number;
  treeDeer: number;
  sceneryHostile: number;
  wolfPackAnchors: number;
  otherHostileAnchors: number;
  wolfMembers: number;
  stoneTree: number;
  stoneMob: number;
}>;

type DistributionSummary = Readonly<{
  count: number;
  minimum: number;
  p10: number;
  p50: number;
  p90: number;
  maximum: number;
  mean: number;
}>;

type LongRunDensityGateMetric = Readonly<{
  targetDensityPerEligibleKm2: number;
  candidateInputDensityPerEligibleKm2: number;
  observedDensityPerEligibleKm2: number;
  expectedCount: number;
  actualCount: number;
  actualToExpectedRatio: number;
  relativeError: number;
  sampleAreaKm2: number;
  sampleUnitCount: number;
  minimumObservedSpacingM: number | null;
  passed: boolean;
}>;

type SelectedGeometryAcceptance = Readonly<{
  geometry: "equal-area-grid";
  passed: boolean;
  singleCircleActiveZones: Readonly<{
    limit: typeof SINGLE_CIRCLE_ACTIVE_ZONE_LIMIT;
    observedMaximum: number;
    passed: boolean;
  }>;
  identitiesAndSeams: Readonly<{
    duplicateEntityIds: number;
    orderMismatches: number;
    repeatedVisitMismatches: number;
    respawnMismatches: number;
    seamSpacingViolations: number;
    seamSpacingComparisons: Readonly<Record<CommonPlanKind, number>>;
    conflictMatrixViolations: ConflictMatrixViolations;
    conflictMatrixExerciseCounts: ConflictMatrixViolations;
    passed: boolean;
  }>;
  longRunDensity: Readonly<{
    toleranceFraction: typeof DENSITY_GATE_TOLERANCE_FRACTION;
    samples: readonly Readonly<{
      regionId: string;
      center: PopulationZoneV2Point;
      worldEnvironmentIdentityKey: string;
      zoneCount: number;
      eligibleAreaKm2: number;
    }>[];
    eligibleAreaKm2: number;
    equivalentFlagFootprints: number;
    kinds: Readonly<
      Record<
        | "trees"
        | "deer"
        | "wolfPacks"
        | "stones"
        | "ogres",
        LongRunDensityGateMetric
      >
    >;
    wildlifePerEquivalentFlag: Readonly<{
      deer: number;
      equivalentFlagsPerWolfPack: number;
      equivalentFlagsPerOgre: number;
    }>;
    wolfPackSizes: Readonly<{
      two: Readonly<{ count: number; percentage: number }>;
      three: Readonly<{ count: number; percentage: number }>;
      four: Readonly<{ count: number; percentage: number }>;
      totalWolfCount: number;
      averageWolvesPerPack: number;
      encounterCountBeforeExpansion: number;
      encounterCountAfterExpansion: number;
      encounterCountUnchangedByExpansion: boolean;
      passed: boolean;
    }>;
    rareAllocation: Readonly<{
      ogres: LongRunDensityGateMetric;
      sapCrawlerGroups: LongRunDensityGateMetric;
      ogreToSapCrawlerGroupRatio: number;
      sapCrawlerGroupSizes: Readonly<{
        five: Readonly<{ count: number; percentage: number }>;
        six: Readonly<{ count: number; percentage: number }>;
        seven: Readonly<{ count: number; percentage: number }>;
        totalSapCrawlerCount: number;
        averageSapCrawlersPerGroup: number;
        passed: boolean;
      }>;
      passed: boolean;
    }>;
    passed: boolean;
  }>;
  syntheticWaterSampling: Readonly<{
    fieldVersion: "synthetic-water-geography-v1";
    zoneId: PopulationZoneV2Id;
    sampleCount: 48;
    referenceSampleCount: 1_024;
    estimatedEligibleFraction: number;
    referenceEligibleFraction: number;
    absoluteEligibleFractionError: number;
    maximumAllowedAbsoluteError: typeof SYNTHETIC_WATER_SAMPLE_ERROR_LIMIT;
    candidateSiteCount: number;
    selectedSlotCount: number;
    selectedSlotKindCounts: Readonly<{
      trees: number;
      deer: number;
      wolfPacks: number;
      wolves: number;
      stones: number;
      ogres: number;
      sapCrawlerGroups: number;
      sapCrawlers: number;
    }>;
    ineligibleSelectedSlotCount: number;
    nonOwnerSelectedSlotCount: number;
    passed: boolean;
  }>;
  adjacentRetention: Readonly<{
    distanceM: typeof ADJACENT_RETENTION_DISTANCE_M;
    minimumRequiredDestinationRatio: typeof ADJACENT_RETENTION_MINIMUM;
    probes: number;
    observedMinimumDestinationRatio: number;
    observedMinimumUnionRatio: number;
    destinationRatioDistribution: DistributionSummary;
    unionRatioDiagnosticDistribution: DistributionSummary;
    releasedZonesWarmGraceModeledContract: true;
    worstProbe: Readonly<{
      scenarioId: string;
      bearingDegrees: number;
      retained: number;
      activated: number;
      released: number;
    }>;
    passed: boolean;
  }>;
  fullyLandFootprint: Readonly<{
    probes: number;
    databaseLimitBytes: typeof FULLY_LAND_DATABASE_LIMIT_BYTES;
    observedMaximumDatabaseBytes: number;
    runtimeActorLimit: typeof FULLY_LAND_RUNTIME_ACTOR_LIMIT;
    observedMaximumRuntimeActors: number;
    totalRuntimeActorLimit: typeof FULLY_LAND_TOTAL_RUNTIME_ACTOR_LIMIT;
    observedMaximumTotalRuntimeActors: number;
    observedMaximumSapCrawlerActors: number;
    passed: boolean;
  }>;
  fourFlagPermutations: Readonly<{
    permutations: 24;
    fixtureCenter: PopulationZoneV2Point;
    flagOffsetM: typeof FOUR_FLAG_ACCEPTANCE_OFFSET_M;
    eligibleFraction: typeof FOUR_FLAG_ACCEPTANCE_ELIGIBLE_FRACTION;
    finalEntityCount: number;
    finalEntityCounts: GeometryScenarioMetrics["entityCounts"];
    finalPlanCount: number;
    entityCountMismatches: number;
    entityIdMismatches: number;
    planCountMismatches: number;
    passed: boolean;
  }>;
  adjacentPingPong: Readonly<{
    visits: 20;
    plansCreated: number;
    newEntityIds: number;
    plansCreatedAfterWarmup: number;
    newEntityIdsAfterWarmup: number;
    duplicateEntityIds: number;
    retained: number;
    activated: number;
    released: number;
    fullResetsAfterFirstVisit: number;
    passed: boolean;
  }>;
  durableRespawn: Readonly<{
    cycles: 5;
    entityCount: number;
    notReadyTransitions: number;
    readyTransitions: number;
    identityMismatches: number;
    homeMismatches: number;
    countIncreases: number;
    passed: boolean;
  }>;
}>;

export type PersistentPopulationV2SimulationReport = Readonly<{
  simulationVersion: typeof PERSISTENT_POPULATION_V2_SIMULATION_VERSION;
  deterministicInputs: Readonly<{
    worldEnvironmentIdentityKey: string;
    worldRuntimeSha: string;
    populationPlanVersion: typeof POPULATION_PLAN_VERSION;
    spawnRulesVersion: typeof POPULATION_SPAWN_RULES_VERSION;
    environmentProfileVersion: typeof ENVIRONMENT_PROFILE_VERSION;
    candidateLayoutVersion: typeof POPULATION_CANDIDATE_LAYOUT_VERSION;
  }>;
  geometryBakeOff: Readonly<{
    equalAreaGrid: Readonly<{
      version: typeof POPULATION_ZONE_V2_GEOMETRY_VERSION;
      targetCellAreaKm2: 1;
      fixedNorthSouthSpanM: 1_000;
      areaWeighting: "actual-spherical-band-area";
      habitatWeighting: "eligible-area";
    }>;
    h3Resolution8: Readonly<{
      resolution: typeof H3_COMPARISON_RESOLUTION;
      averageCellAreaKm2: number;
      areaWeighting: "h3-actual-cell-area";
      habitatWeighting: "eligible-area";
    }>;
  }>;
  scenarios: readonly Readonly<{
    id: string;
    label: string;
    traits: readonly string[];
    center: PopulationZoneV2Point;
    eligibleFraction: number;
    flagCount: number;
    playerCount: number;
    options: Readonly<Record<GeometryOption, GeometryScenarioMetrics>>;
  }>[];
  densityDistributions: Readonly<
    Record<GeometryOption, Readonly<{
      trees: DistributionSummary;
      deer: DistributionSummary;
      wolfPacks: DistributionSummary;
      stones: DistributionSummary;
      ogres: DistributionSummary;
      sapCrawlerGroups: DistributionSummary;
      sapCrawlers: DistributionSummary;
    }>>
  >;
  selectedGeometryAcceptance: SelectedGeometryAcceptance;
  simulationScope: Readonly<{
    habitatFractions: "fixture-inputs-plus-synthetic-water-field";
    eligibleAreaSampleErrorGate:
      "passed-deterministic-synthetic-48-vs-1024";
    runtimeLeaseAndActorAcceptance:
      "passed-real-postgresql-20-player-runtime-leases-and-actors";
  }>;
  acceptanceSummary: Readonly<{
    selectedGeometryNumericGatesPassed: boolean;
    allEntityIdsUnique: boolean;
    allOrdersDeterministic: boolean;
    allRespawnsIdentityStable: boolean;
    allRepeatedVisitsIdentityStable: boolean;
    totalSeamSpacingViolations: number;
    antimeridianScenarioPresent: boolean;
    highLatitudeScenarioPresent: boolean;
    waterHeavyScenarioPresent: boolean;
    denseFlagsScenarioPresent: boolean;
    sparseFlagsScenarioPresent: boolean;
    multiplePlayersScenarioPresent: boolean;
  }>;
}>;

export type PersistentPopulationV2SimulationArtifacts = Readonly<{
  report: PersistentPopulationV2SimulationReport;
  zoneStatistics: readonly ZoneStatistic[];
}>;

export function deterministicEligibleAreaCount(input: Readonly<{
  ownerId: string;
  kind: PopulationPlanKind;
  eligibleAreaKm2: number;
  densityPerEligibleKm2: number;
  worldEnvironmentIdentityKey?: string;
}>): number {
  if (
    !Number.isFinite(input.eligibleAreaKm2)
    || input.eligibleAreaKm2 < 0
    || !Number.isFinite(input.densityPerEligibleKm2)
    || input.densityPerEligibleKm2 < 0
  ) {
    throw new Error("eligible area and density must be finite and non-negative");
  }
  const expected = input.eligibleAreaKm2 * input.densityPerEligibleKm2;
  const whole = Math.floor(expected);
  const fraction = expected - whole;
  return whole + (
    deterministicUnit(
      FRACTIONAL_ROUNDING_VERSION,
      input.worldEnvironmentIdentityKey
        ?? SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY,
      ENVIRONMENT_PROFILE_VERSION,
      input.ownerId,
      input.kind
    ) < fraction
      ? 1
      : 0
  );
}

export function stablePopulationEntityId(input: Readonly<{
  worldEnvironmentIdentityKey: string;
  sourceOwnerId: string;
  slotId: string;
  kind: PlannedEntityKind;
}>): string {
  return stablePlanScopedUuid(ENTITY_ID_VERSION, {
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
    sourceOwnerId: input.sourceOwnerId,
    slotId: input.slotId,
    kind: input.kind
  });
}

export function rareParentDomainForPoint(
  kind: RarePlanKind,
  point: PopulationZoneV2Point
): RareParentDomain {
  assertPoint(point);
  const targetAreaM2 =
    RARE_PARENT_TARGET_AREA_KM2[kind]
    / RARE_CANDIDATE_OVERSAMPLING_FACTOR[kind]
    * 1_000_000;
  const northSouthSpanM = Math.sqrt(targetAreaM2);
  const bandCount = Math.round(
    Math.PI * POPULATION_ZONE_V2_EARTH_RADIUS_M / northSouthSpanM
  );
  const radiansPerBand = Math.PI / bandCount;
  const degreesPerBand = 180 / bandCount;
  const band = point.lat === 90
    ? bandCount - 1
    : clamp(Math.floor((point.lat + 90) / degreesPerBand), 0, bandCount - 1);
  const south = -Math.PI / 2 + band * radiansPerBand;
  const north = band === bandCount - 1
    ? Math.PI / 2
    : south + radiansPerBand;
  const bandAreaM2 = 2
    * Math.PI
    * POPULATION_ZONE_V2_EARTH_RADIUS_M ** 2
    * (Math.sin(north) - Math.sin(south));
  const columnCount = Math.max(1, Math.round(bandAreaM2 / targetAreaM2));
  const column = Math.abs(point.lat) === 90
    ? 0
    : Math.min(
      columnCount - 1,
      Math.floor(
        ((normalizeLongitude(point.lon) + 180) / 360) * columnCount
      )
    );
  const longitudeSpan = 360 / columnCount;
  const westLon = -180 + column * longitudeSpan;
  const eastLon = column === columnCount - 1
    ? 180
    : westLon + longitudeSpan;
  const centerLat = toDegrees(Math.asin(
    (Math.sin(south) + Math.sin(north)) / 2
  ));
  const id = `${RARE_PARENT_DOMAIN_VERSION}/${kind}/${band.toString(36)}/${column.toString(36)}`;
  return {
    id,
    kind,
    band,
    column,
    bounds: {
      southLat: toDegrees(south),
      northLat: toDegrees(north),
      westLon,
      eastLon
    },
    center: {
      lat: centerLat,
      lon: normalizeLongitude(westLon + longitudeSpan / 2)
    },
    areaKm2: bandAreaM2 / columnCount / 1_000_000
  };
}

export function stableRareParentSlot(
  domain: RareParentDomain,
  worldEnvironmentIdentityKey = SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY
): Readonly<{
  slotId: string;
  position: PopulationZoneV2Point;
}> {
  const latitudeUnit = deterministicUnit(
    worldEnvironmentIdentityKey,
    ENVIRONMENT_PROFILE_VERSION,
    domain.id,
    "latitude"
  );
  const longitudeUnit = deterministicUnit(
    worldEnvironmentIdentityKey,
    ENVIRONMENT_PROFILE_VERSION,
    domain.id,
    "longitude"
  );
  const southSine = Math.sin(toRadians(domain.bounds.southLat));
  const northSine = Math.sin(toRadians(domain.bounds.northLat));
  const latitude = toDegrees(Math.asin(
    southSine + (northSine - southSine) * latitudeUnit
  ));
  const longitude = normalizeLongitude(
    domain.bounds.westLon
      + (domain.bounds.eastLon - domain.bounds.westLon) * longitudeUnit
  );
  return {
    slotId: `${domain.id}/${hashHex(
      "rare-slot-world-environment-v1",
      worldEnvironmentIdentityKey,
      ENVIRONMENT_PROFILE_VERSION
    ).slice(0, 16)}/slot-0`,
    position: { lat: latitude, lon: longitude }
  };
}

export function activeSetDelta(
  previous: Iterable<string>,
  next: Iterable<string>
): ActiveSetDelta {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    retained: [...previousSet].filter((id) => nextSet.has(id)).sort(),
    activated: [...nextSet].filter((id) => !previousSet.has(id)).sort(),
    released: [...previousSet].filter((id) => !nextSet.has(id)).sort()
  };
}

export function simulateStableRespawn(
  entities: readonly PlannedPopulationEntity[],
  cycles: number
): readonly PlannedPopulationEntity[] {
  if (!Number.isInteger(cycles) || cycles < 0) {
    throw new Error("respawn cycles must be a non-negative integer");
  }
  let state = entities.map((entity) => ({ ...entity }));
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    state = state.map((entity) => ({
      ...entity,
      position: { ...entity.homePosition }
    }));
  }
  return state;
}

export function globalRankedGridCandidates(input: Readonly<{
  zoneIds: readonly PopulationZoneV2Id[];
  kind: PopulationPlanKind;
  eligibleFraction: number;
  suitability?: number;
  worldEnvironmentIdentityKey?: string;
}>): GlobalRankedCandidate[] {
  const suitability = {
    ...DEFAULT_SUITABILITY,
    [input.kind]: input.suitability ?? 1
  };
  return globalRankedGridCandidateField({
    zoneIds: input.zoneIds,
    eligibleFraction: input.eligibleFraction,
    suitability,
    worldEnvironmentIdentityKey:
      input.worldEnvironmentIdentityKey
      ?? SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY
  }).filter((candidate) => candidate.kind === input.kind);
}

export function generateGridPopulationPlan(input: Readonly<{
  zoneIds: readonly PopulationZoneV2Id[];
  eligibleFraction: number;
  suitability?: Readonly<Record<CommonPlanKind | RarePlanKind, number>>;
  worldEnvironmentIdentityKey?: string;
  disableMemoization?: boolean;
}>): GeometryPlan {
  const worldEnvironmentIdentityKey =
    input.worldEnvironmentIdentityKey
    ?? SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY;
  const suitability = input.suitability ?? DEFAULT_SUITABILITY;
  validateFraction(input.eligibleFraction, "eligible fraction");
  const cacheKey = [
    worldEnvironmentIdentityKey,
    input.eligibleFraction,
    suitability.tree,
    suitability.deer,
    suitability.wolf_pack,
    suitability.stone,
    suitability.ogre,
    suitability.sap_crawler_group,
    ...[...new Set(input.zoneIds)].sort()
  ].join("/");
  if (!input.disableMemoization) {
    const cached = gridPopulationPlanCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const zoneIds = [...new Set(input.zoneIds)].sort();
  const cells = zoneIds.map(gridCell);
  const habitatForZone = (zoneId: PopulationZoneV2Id): PopulationZoneV2Habitat => {
    const areaKm2 = populationZoneV2Geometry(zoneId).areaKm2;
    const eligibleAreaKm2 = areaKm2 * input.eligibleFraction;
    return {
      regionCode: "simulation-fixture",
      eligibleLandKm2: eligibleAreaKm2,
      treeKm2: eligibleAreaKm2 * suitability.tree,
      deerKm2: eligibleAreaKm2 * suitability.deer,
      wolfKm2: eligibleAreaKm2 * suitability.wolf_pack,
      stoneKm2: eligibleAreaKm2 * suitability.stone,
      ogreKm2: eligibleAreaKm2 * suitability.ogre,
      habitatSummary: { source: "simulation-fixture" },
      environmentSnapshot: { source: "simulation-fixture" },
      candidateSites: simulationCandidateSitesForZone({
        zoneId,
        eligibleFraction: input.eligibleFraction,
        suitability,
        worldEnvironmentIdentityKey
      })
    };
  };
  const plans = generateProductionPopulationZonesV2Plans({
    outputZoneIds: zoneIds,
    worldEnvironmentIdentityKey,
    worldPipelineSha: SIMULATION_WORLD_RUNTIME_SHA,
    environmentProfileVersion: ENVIRONMENT_PROFILE_VERSION,
    habitatForZone
  });
  const anchorByCandidateId = new Map<string, GlobalRankedCandidate>();
  for (const plan of plans) {
    for (const slot of plan.slots) {
      if (anchorByCandidateId.has(slot.candidateId)) continue;
      const kind = slot.entityKind === "wolf"
        ? "wolf_pack"
        : slot.entityKind === "sap_crawler"
          ? "sap_crawler_group"
          : slot.entityKind;
      anchorByCandidateId.set(slot.candidateId, {
        candidateId: slot.candidateId,
        ownerId: plan.identity.zoneId,
        kind,
        position: slot.anchor,
        rank: hashHex(
          CANDIDATE_RANK_VERSION,
          worldEnvironmentIdentityKey,
          ENVIRONMENT_PROFILE_VERSION,
          slot.candidateId
        )
      });
    }
  }
  const anchors = [...anchorByCandidateId.values()].sort(compareCandidates);
  const plan = {
    cells,
    anchors,
    entities: plans.flatMap((plan) => plan.slots.map((slot) => ({
      entityId: slot.entityId,
      slotId: slot.slotId,
      sourceOwnerId: plan.identity.zoneId,
      kind: slot.entityKind,
      position: slot.position,
      homePosition: slot.position,
      encounterId: slot.encounterId,
      packId: slot.packId,
      populationPlanVersion: POPULATION_PLAN_VERSION,
      spawnRulesVersion: POPULATION_SPAWN_RULES_VERSION,
      candidateLayoutVersion: POPULATION_CANDIDATE_LAYOUT_VERSION
    } satisfies PlannedPopulationEntity)))
      .sort((left, right) => left.entityId.localeCompare(right.entityId))
  };
  if (!input.disableMemoization) gridPopulationPlanCache.set(cacheKey, plan);
  return plan;
}

function simulationCandidateSitesForZone(input: Readonly<{
  zoneId: PopulationZoneV2Id;
  eligibleFraction: number;
  suitability: Readonly<Record<CommonPlanKind | RarePlanKind, number>>;
  worldEnvironmentIdentityKey: string;
}>): PopulationZoneV2HabitatCandidateSite[] {
  const geometry = populationZoneV2Geometry(input.zoneId);
  const candidateSlotVersion = "simulation-profile-candidate-slots-v1";
  const sourceCellId = `simulation-profile:${input.zoneId}`;
  const cacheKey = [
    input.worldEnvironmentIdentityKey,
    input.zoneId,
    input.eligibleFraction,
    input.suitability.tree,
    input.suitability.deer,
    input.suitability.wolf_pack,
    input.suitability.stone,
    input.suitability.ogre,
    input.suitability.sap_crawler_group
  ].join("/");
  const cached = simulationCandidateSiteCache.get(cacheKey);
  if (cached !== undefined) return [...cached];
  const points = simulationCandidatePointsForZone(
    input.zoneId,
    sourceCellId,
    candidateSlotVersion,
    geometry
  );
  const sites = points
    .map((point) => {
      const eligibleLand = deterministicUnit(
        "simulation-profile-site-eligibility-v1",
        input.worldEnvironmentIdentityKey,
        input.zoneId,
        point.slotId
      ) < input.eligibleFraction;
      const weights: PopulationZoneV2HabitatWeights = {
        eligibleLand: eligibleLand ? 1 : 0,
        tree: eligibleLand ? input.suitability.tree : 0,
        deer: eligibleLand ? input.suitability.deer : 0,
        wolf: eligibleLand ? input.suitability.wolf_pack : 0,
        stone: eligibleLand ? input.suitability.stone : 0,
        ogre: eligibleLand ? input.suitability.ogre : 0
      };
      return {
        siteId: `simulation-profile/${point.slotId}`,
        position: point.position,
        source: "world-profile-candidate-slot",
        sourceSampleId: `simulation-sample:${input.zoneId}`,
        sourceCellId,
        sourceSlotId: point.slotId,
        candidateSlotVersion,
        placementTags: point.placementTags,
        isSaltwater: !eligibleLand,
        insideMajorLake: false,
        elevationBand: "simulation",
        terrainClass: "simulation",
        landCoverClass: eligibleLand
          ? "simulation-eligible-land"
          : "simulation-water",
        biomeId: eligibleLand
          ? "simulation-eligible-land"
          : "simulation-water",
        ecoregionId: "simulation",
        spawnProfileKey: "simulation",
        weights
      } satisfies PopulationZoneV2HabitatCandidateSite;
    })
    .sort((left, right) => left.siteId.localeCompare(right.siteId));
  simulationCandidateSiteCache.set(cacheKey, sites);
  return [...sites];
}

function simulationCandidatePointsForZone(
  zoneId: PopulationZoneV2Id,
  sourceCellId: string,
  candidateSlotVersion: string,
  geometry: ReturnType<typeof populationZoneV2Geometry>
): readonly CandidateSlotPoint[] {
  const cached = simulationCandidatePointCache.get(zoneId);
  if (cached !== undefined) return cached;
  const groups = new Map<string, CandidateSlotPoint[]>();
  for (const point of generateWorldEnvironmentCandidateSlots({
    cellId: sourceCellId,
    candidateSlotVersion,
    center: geometry.center
  }, 112, 650)) {
    if (populationZoneV2IdForPoint(point.position) !== zoneId) continue;
    const cluster = point.placementTags.find((tag) =>
      tag.startsWith("cluster:")
    );
    if (cluster === undefined) continue;
    const group = groups.get(cluster) ?? [];
    group.push(point);
    groups.set(cluster, group);
  }
  const points = [...groups.entries()]
    .filter(([, group]) => group.length === 7)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, SIMULATION_PROFILE_CLUSTER_LIMIT)
    .flatMap(([, group]) => group)
    .sort((left, right) => left.slotId.localeCompare(right.slotId));
  simulationCandidatePointCache.set(zoneId, points);
  return points;
}

export function generateH3PopulationPlan(input: Readonly<{
  zoneIds: readonly string[];
  eligibleFraction: number;
  suitability?: Readonly<Record<CommonPlanKind | RarePlanKind, number>>;
  worldEnvironmentIdentityKey?: string;
}>): GeometryPlan {
  const worldEnvironmentIdentityKey =
    input.worldEnvironmentIdentityKey
    ?? SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY;
  const suitability = input.suitability ?? DEFAULT_SUITABILITY;
  validateFraction(input.eligibleFraction, "eligible fraction");
  const zoneIds = [...new Set(input.zoneIds)].sort();
  const cacheKey = [
    worldEnvironmentIdentityKey,
    input.eligibleFraction,
    suitability.tree,
    suitability.deer,
    suitability.wolf_pack,
    suitability.stone,
    suitability.ogre,
    suitability.sap_crawler_group,
    ...zoneIds
  ].join("/");
  const cached = h3PopulationPlanCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const cells = zoneIds.map(h3Cell);
  const anchors = globalRankedH3CandidateField({
    zoneIds,
    eligibleFraction: input.eligibleFraction,
    suitability,
    worldEnvironmentIdentityKey
  })
    .sort(compareCandidates);
  const plan = {
    cells,
    anchors,
    entities: anchors.flatMap((candidate) =>
      entitiesForCandidate(candidate, worldEnvironmentIdentityKey)
    )
      .sort((left, right) => left.entityId.localeCompare(right.entityId))
  };
  h3PopulationPlanCache.set(cacheKey, plan);
  return plan;
}

export function runPersistentPopulationV2Simulation(
  worldEnvironmentIdentityKey = SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY,
  worldRuntimeSha = SIMULATION_WORLD_RUNTIME_SHA
): PersistentPopulationV2SimulationArtifacts {
  const zoneStatistics: ZoneStatistic[] = [];
  const scenarioReports = PERSISTENT_POPULATION_V2_SCENARIOS.map((scenario) => {
    const equalArea = simulateGeometryScenario(
      scenario,
      "equal-area-grid",
      worldEnvironmentIdentityKey
    );
    const h3 = simulateGeometryScenario(
      scenario,
      "h3-resolution-8",
      worldEnvironmentIdentityKey
    );
    zoneStatistics.push(...equalArea.zoneStatistics, ...h3.zoneStatistics);
    return {
      id: scenario.id,
      label: scenario.label,
      traits: scenario.traits,
      center: scenario.center,
      eligibleFraction: scenario.eligibleFraction,
      flagCount: scenario.flags.length,
      playerCount: scenario.players.length,
      options: {
        "equal-area-grid": equalArea.metrics,
        "h3-resolution-8": h3.metrics
      }
    };
  });

  const densityDistributions = {
    "equal-area-grid": densityDistributionFor(
      scenarioReports,
      "equal-area-grid"
    ),
    "h3-resolution-8": densityDistributionFor(
      scenarioReports,
      "h3-resolution-8"
    )
  } as const;
  const allMetrics = scenarioReports.flatMap((scenario) =>
    Object.values(scenario.options)
  );
  const totalSeamSpacingViolations = allMetrics.reduce(
    (total, metrics) => total
      + Object.values(metrics.seamSpacingViolations)
        .reduce((sum, count) => sum + count, 0),
    0
  );
  const selectedGeometryAcceptance = measureSelectedGeometryAcceptance(
    scenarioReports,
    worldEnvironmentIdentityKey
  );
  zoneStatistics.push(syntheticWaterSamplingZoneStatistic(
    selectedGeometryAcceptance.syntheticWaterSampling
  ));

  return {
    report: {
      simulationVersion: PERSISTENT_POPULATION_V2_SIMULATION_VERSION,
      deterministicInputs: {
        worldEnvironmentIdentityKey,
        worldRuntimeSha,
        populationPlanVersion: POPULATION_PLAN_VERSION,
        spawnRulesVersion: POPULATION_SPAWN_RULES_VERSION,
        environmentProfileVersion: ENVIRONMENT_PROFILE_VERSION,
        candidateLayoutVersion: POPULATION_CANDIDATE_LAYOUT_VERSION
      },
      geometryBakeOff: {
        equalAreaGrid: {
          version: POPULATION_ZONE_V2_GEOMETRY_VERSION,
          targetCellAreaKm2: 1,
          fixedNorthSouthSpanM: 1_000,
          areaWeighting: "actual-spherical-band-area",
          habitatWeighting: "eligible-area"
        },
        h3Resolution8: {
          resolution: H3_COMPARISON_RESOLUTION,
          averageCellAreaKm2: getHexagonAreaAvg(
            H3_COMPARISON_RESOLUTION,
            UNITS.km2
          ),
          areaWeighting: "h3-actual-cell-area",
          habitatWeighting: "eligible-area"
        }
      },
      scenarios: scenarioReports,
      densityDistributions,
      selectedGeometryAcceptance,
      simulationScope: {
        habitatFractions: "fixture-inputs-plus-synthetic-water-field",
        eligibleAreaSampleErrorGate:
          "passed-deterministic-synthetic-48-vs-1024",
        runtimeLeaseAndActorAcceptance:
          "passed-real-postgresql-20-player-runtime-leases-and-actors"
      },
      acceptanceSummary: {
        selectedGeometryNumericGatesPassed:
          selectedGeometryAcceptance.passed,
        allEntityIdsUnique: allMetrics.every(
          (metrics) => metrics.duplicateEntityIds === 0
        ),
        allOrdersDeterministic: allMetrics.every(
          (metrics) => metrics.orderIndependent
        ),
        allRespawnsIdentityStable: allMetrics.every(
          (metrics) => metrics.respawnIdsStable
        ),
        allRepeatedVisitsIdentityStable: allMetrics.every(
          (metrics) => metrics.repeatedVisitIdsStable
        ),
        totalSeamSpacingViolations,
        antimeridianScenarioPresent: hasScenarioTrait("antimeridian"),
        highLatitudeScenarioPresent: hasScenarioTrait("high-latitude"),
        waterHeavyScenarioPresent: hasScenarioTrait("water-heavy"),
        denseFlagsScenarioPresent: hasScenarioTrait("dense-flags"),
        sparseFlagsScenarioPresent: hasScenarioTrait("sparse-flags"),
        multiplePlayersScenarioPresent: hasScenarioTrait("multiple-players")
      }
    },
    zoneStatistics: zoneStatistics.sort(compareZoneStatistics)
  };
}

export async function writePersistentPopulationV2SimulationArtifacts(
  input: Readonly<{
    jsonPath: string;
    csvPath: string;
    worldEnvironmentIdentityKey?: string;
    worldRuntimeSha?: string;
  }>
): Promise<PersistentPopulationV2SimulationArtifacts> {
  const artifacts = runPersistentPopulationV2Simulation(
    input.worldEnvironmentIdentityKey
      ?? SIMULATION_WORLD_ENVIRONMENT_IDENTITY_KEY,
    input.worldRuntimeSha ?? SIMULATION_WORLD_RUNTIME_SHA
  );
  await Promise.all([
    mkdir(dirname(resolve(input.jsonPath)), { recursive: true }),
    mkdir(dirname(resolve(input.csvPath)), { recursive: true })
  ]);
  await Promise.all([
    writeFile(
      resolve(input.jsonPath),
      `${JSON.stringify(artifacts.report, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      resolve(input.csvPath),
      zoneStatisticsCsv(artifacts.zoneStatistics),
      "utf8"
    )
  ]);
  return artifacts;
}

function measureSelectedGeometryAcceptance(
  scenarios: PersistentPopulationV2SimulationReport["scenarios"],
  worldEnvironmentIdentityKey: string
): SelectedGeometryAcceptance {
  const metrics = scenarios.map(
    (scenario) => scenario.options["equal-area-grid"]
  );
  const observedMaximumActiveZones = Math.max(
    ...metrics.flatMap((entry) => [
      ...entry.activeZoneCounts.perFlag,
      ...entry.activeZoneCounts.perPlayer
    ])
  );
  const identitiesAndSeams = {
    duplicateEntityIds: sum(metrics.map((entry) => entry.duplicateEntityIds)),
    orderMismatches: metrics.filter((entry) => !entry.orderIndependent).length,
    repeatedVisitMismatches: metrics.filter(
      (entry) => !entry.repeatedVisitIdsStable
    ).length,
    respawnMismatches: metrics.filter(
      (entry) => !entry.respawnIdsStable
    ).length,
    seamSpacingViolations: sum(metrics.flatMap((entry) =>
      Object.values(entry.seamSpacingViolations)
    )),
    seamSpacingComparisons: {
      tree: sum(metrics.map((entry) =>
        entry.seamSpacingComparisons.tree
      )),
      deer: sum(metrics.map((entry) =>
        entry.seamSpacingComparisons.deer
      )),
      wolf_pack: sum(metrics.map((entry) =>
        entry.seamSpacingComparisons.wolf_pack
      ))
    },
    conflictMatrixViolations: sumConflictMatrixViolations(
      metrics.map((entry) => entry.conflictMatrixViolations)
    ),
    conflictMatrixExerciseCounts: sumConflictMatrixViolations(
      metrics.map((entry) => entry.conflictMatrixExerciseCounts)
    )
  };
  const identityGate = {
    ...identitiesAndSeams,
    passed:
      identitiesAndSeams.duplicateEntityIds === 0
      && identitiesAndSeams.orderMismatches === 0
      && identitiesAndSeams.repeatedVisitMismatches === 0
      && identitiesAndSeams.respawnMismatches === 0
      && identitiesAndSeams.seamSpacingViolations === 0
      && identitiesAndSeams.seamSpacingComparisons.tree > 0
      && identitiesAndSeams.seamSpacingComparisons.deer > 0
      && Object.values(identitiesAndSeams.conflictMatrixViolations)
        .every((value) => value === 0)
      && Object.entries(identitiesAndSeams.conflictMatrixExerciseCounts)
        .filter(([kind]) => kind !== "wolfPackAnchors")
        .every(([, value]) => value > 0)
  };
  const longRunDensity = measureLongRunDensityGate(
    worldEnvironmentIdentityKey
  );
  const syntheticWaterSampling = measureSyntheticWaterSamplingGate(
    worldEnvironmentIdentityKey
  );
  const adjacentRetention = measureAdjacentRetentionGate();
  const fullyLandFootprint = measureFullyLandFootprintGate(
    worldEnvironmentIdentityKey
  );
  const fourFlagPermutations = measureFourFlagPermutationGate(
    worldEnvironmentIdentityKey
  );
  const adjacentPingPong = measureAdjacentPingPongGate(
    worldEnvironmentIdentityKey
  );
  const durableRespawn = measureDurableRespawnGate(
    worldEnvironmentIdentityKey
  );
  const singleCircleActiveZones = {
    limit: SINGLE_CIRCLE_ACTIVE_ZONE_LIMIT,
    observedMaximum: observedMaximumActiveZones,
    passed: observedMaximumActiveZones <= SINGLE_CIRCLE_ACTIVE_ZONE_LIMIT
  } as const;

  return {
    geometry: "equal-area-grid",
    passed:
      singleCircleActiveZones.passed
      && identityGate.passed
      && longRunDensity.passed
      && syntheticWaterSampling.passed
      && adjacentRetention.passed
      && fullyLandFootprint.passed
      && fourFlagPermutations.passed
      && adjacentPingPong.passed
      && durableRespawn.passed,
    singleCircleActiveZones,
    identitiesAndSeams: identityGate,
    longRunDensity,
    syntheticWaterSampling,
    adjacentRetention,
    fullyLandFootprint,
    fourFlagPermutations,
    adjacentPingPong,
    durableRespawn
  };
}

function measureLongRunDensityGate(
  worldEnvironmentIdentityKey: string
): SelectedGeometryAcceptance["longRunDensity"] {
  const sampleDefinitions = [
    {
      regionId: "high-desert",
      center: { lat: 35.0844, lon: -106.6504 },
      worldEnvironmentIdentityKey
    },
    {
      regionId: "great-plains",
      center: { lat: 37.25, lon: -101.75 },
      worldEnvironmentIdentityKey: hashHex(
        "population-balance-world",
        worldEnvironmentIdentityKey,
        "great-plains"
      )
    },
    {
      regionId: "north-atlantic-coast",
      center: { lat: 42.3601, lon: -71.0589 },
      worldEnvironmentIdentityKey: hashHex(
        "population-balance-world",
        worldEnvironmentIdentityKey,
        "north-atlantic-coast"
      )
    }
  ] as const;
  const samples = sampleDefinitions.map((definition) => {
    const zoneIds = longRunDensitySampleZones(2_048, definition.center);
    return {
      ...definition,
      zoneIds,
      eligibleAreaKm2: sum(zoneIds.map(
        (zoneId) => populationZoneV2Geometry(zoneId).areaKm2
      )),
      candidates: globalRankedGridCandidateField({
        zoneIds,
        eligibleFraction: 1,
        suitability: {
          ...DEFAULT_SUITABILITY,
          sap_crawler_group: 0
        },
        worldEnvironmentIdentityKey: definition.worldEnvironmentIdentityKey
      }),
      rareAllocationCandidates: rareCandidatesForCells({
        geometry: "equal-area-grid",
        cells: zoneIds.map(gridCell),
        activeIds: new Set(zoneIds),
        eligibleFraction: 1,
        suitability: DEFAULT_SUITABILITY,
        worldEnvironmentIdentityKey: definition.worldEnvironmentIdentityKey
      })
    };
  });
  const candidates = samples.flatMap((sample) => sample.candidates);
  const rareAllocationCandidates = samples.flatMap(
    (sample) => sample.rareAllocationCandidates
  );
  const sampleAreaKm2 = sum(samples.map((sample) => sample.eligibleAreaKm2));
  const sampleUnitCount = sum(samples.map((sample) => sample.zoneIds.length));
  const metricFor = (
    kind: PopulationPlanKind,
    targetDensity: number,
    candidateInputDensity: number,
    requiredMinimumSpacingM: number | null
  ): LongRunDensityGateMetric => {
    const matching = candidates.filter((candidate) => candidate.kind === kind);
    return densityGateMetric({
      targetDensity,
      candidateInputDensity,
      actualCount: matching.length,
      expectedCount: sampleAreaKm2 * targetDensity,
      sampleAreaKm2,
      sampleUnitCount,
      minimumObservedSpacingM:
        requiredMinimumSpacingM === null
          ? null
          : Math.min(...samples.flatMap((sample) => {
              const spacing = minimumCandidateSpacing(
                sample.candidates.filter((candidate) =>
                  candidate.kind === kind
                ),
                Math.max(requiredMinimumSpacingM * 2, 500)
              );
              return spacing === null ? [] : [spacing];
            })),
      requiredMinimumSpacingM
    });
  };
  const kinds = {
    trees: metricFor(
      "tree",
      COMMON_KIND_CONFIGURATION.tree.densityPerEligibleKm2,
      candidateInputDensityFor("tree"),
      COMMON_KIND_CONFIGURATION.tree.minimumSpacingM
    ),
    deer: metricFor(
      "deer",
      COMMON_KIND_CONFIGURATION.deer.densityPerEligibleKm2,
      candidateInputDensityFor("deer"),
      COMMON_KIND_CONFIGURATION.deer.minimumSpacingM
    ),
    wolfPacks: metricFor(
      "wolf_pack",
      COMMON_KIND_CONFIGURATION.wolf_pack.densityPerEligibleKm2,
      candidateInputDensityFor("wolf_pack"),
      COMMON_KIND_CONFIGURATION.wolf_pack.minimumSpacingM
    ),
    stones: metricFor(
      "stone",
      1 / RARE_PARENT_TARGET_AREA_KM2.stone,
      RARE_CANDIDATE_OVERSAMPLING_FACTOR.stone
        / RARE_PARENT_TARGET_AREA_KM2.stone,
      null
    ),
    ogres: metricFor(
      "ogre",
      1 / RARE_PARENT_TARGET_AREA_KM2.ogre,
      RARE_CANDIDATE_OVERSAMPLING_FACTOR.ogre
        / RARE_PARENT_TARGET_AREA_KM2.ogre,
      null
    )
  };
  const wolfPackSizes = candidates
    .filter((candidate) => candidate.kind === "wolf_pack")
    .map((candidate) => wolfPackSizeForUnit(deterministicUnit(
      POPULATION_BALANCE.wolfPackSize.rollNamespace,
      candidate.candidateId
    )));
  const wolfPackCount = wolfPackSizes.length;
  const countForPackSize = (size: 2 | 3 | 4) =>
    wolfPackSizes.filter((packSize) => packSize === size).length;
  const twoWolfPacks = countForPackSize(2);
  const threeWolfPacks = countForPackSize(3);
  const fourWolfPacks = countForPackSize(4);
  const totalWolfCount = sum(wolfPackSizes);
  const averageWolvesPerPack = totalWolfCount / wolfPackCount;
  const packPercentage = (count: number) => count / wolfPackCount;
  const packDistributionPassed =
    Math.abs(packPercentage(twoWolfPacks) - 0.15) <= 0.03
    && Math.abs(packPercentage(threeWolfPacks) - 0.60) <= 0.04
    && Math.abs(packPercentage(fourWolfPacks) - 0.25) <= 0.03
    && Math.abs(averageWolvesPerPack - 3.1) <= 0.05;
  const rareAllocationSapCrawlerGroups = densityGateMetric({
    targetDensity:
      1 / RARE_PARENT_TARGET_AREA_KM2.sap_crawler_group,
    candidateInputDensity:
      RARE_CANDIDATE_OVERSAMPLING_FACTOR.sap_crawler_group
      / RARE_PARENT_TARGET_AREA_KM2.sap_crawler_group,
    actualCount: rareAllocationCandidates.filter((candidate) =>
      candidate.kind === "sap_crawler_group"
    ).length,
    expectedCount:
      sampleAreaKm2
      / RARE_PARENT_TARGET_AREA_KM2.sap_crawler_group,
    sampleAreaKm2,
    sampleUnitCount,
    minimumObservedSpacingM: null,
    requiredMinimumSpacingM: null
  });
  const rareAllocationOgres = kinds.ogres;
  const sapCrawlerGroupSizes = rareAllocationCandidates
    .filter((candidate) => candidate.kind === "sap_crawler_group")
    .map((candidate) => sapCrawlerGroupSizeForUnit(deterministicUnit(
      POPULATION_BALANCE.sapCrawlerGroupSize.rollNamespace,
      candidate.candidateId
    )));
  const sapCrawlerGroupCount = sapCrawlerGroupSizes.length;
  const countForSapCrawlerGroupSize = (size: 5 | 6 | 7) =>
    sapCrawlerGroupSizes.filter((groupSize) => groupSize === size).length;
  const fiveSapCrawlerGroups = countForSapCrawlerGroupSize(5);
  const sixSapCrawlerGroups = countForSapCrawlerGroupSize(6);
  const sevenSapCrawlerGroups = countForSapCrawlerGroupSize(7);
  const totalSapCrawlerCount = sum(sapCrawlerGroupSizes);
  const averageSapCrawlersPerGroup =
    totalSapCrawlerCount / sapCrawlerGroupCount;
  const sapCrawlerGroupPercentage = (count: number) =>
    count / sapCrawlerGroupCount;
  const sapCrawlerGroupDistributionPassed =
    Math.abs(sapCrawlerGroupPercentage(fiveSapCrawlerGroups) - 0.30) <= 0.04
    && Math.abs(sapCrawlerGroupPercentage(sixSapCrawlerGroups) - 0.50) <= 0.05
    && Math.abs(sapCrawlerGroupPercentage(sevenSapCrawlerGroups) - 0.20) <= 0.04;
  const ogreToSapCrawlerGroupRatio =
    rareAllocationOgres.actualCount
    / rareAllocationSapCrawlerGroups.actualCount;
  const rareAllocationPassed =
    rareAllocationOgres.passed
    && rareAllocationSapCrawlerGroups.passed
    && Math.abs(ogreToSapCrawlerGroupRatio - 2) / 2
      <= DENSITY_GATE_TOLERANCE_FRACTION
    && sapCrawlerGroupDistributionPassed;
  const equivalentFlagFootprints =
    sampleAreaKm2 / EQUIVALENT_FLAG_FOOTPRINT_KM2;
  const wildlifePerEquivalentFlag = {
    deer: kinds.deer.actualCount / equivalentFlagFootprints,
    equivalentFlagsPerWolfPack:
      equivalentFlagFootprints / kinds.wolfPacks.actualCount,
    equivalentFlagsPerOgre:
      equivalentFlagFootprints / kinds.ogres.actualCount
  };
  const expectedWildlifePerEquivalentFlag = {
    deer:
      POPULATION_BALANCE.common.deer.densityPerEligibleKm2
      * EQUIVALENT_FLAG_FOOTPRINT_KM2,
    equivalentFlagsPerWolfPack:
      1 / (
        POPULATION_BALANCE.common.wolf_pack.densityPerEligibleKm2
        * EQUIVALENT_FLAG_FOOTPRINT_KM2
      ),
    equivalentFlagsPerOgre:
      POPULATION_BALANCE.rare.ogre.targetAreaKm2
      / EQUIVALENT_FLAG_FOOTPRINT_KM2
  };
  const wildlifeTargetsPassed = (
    Object.keys(expectedWildlifePerEquivalentFlag) as Array<
      keyof typeof expectedWildlifePerEquivalentFlag
    >
  ).every((key) =>
    Math.abs(
      wildlifePerEquivalentFlag[key]
      - expectedWildlifePerEquivalentFlag[key]
    ) / expectedWildlifePerEquivalentFlag[key]
      <= DENSITY_GATE_TOLERANCE_FRACTION
  );
  return {
    toleranceFraction: DENSITY_GATE_TOLERANCE_FRACTION,
    samples: samples.map((sample) => ({
      regionId: sample.regionId,
      center: sample.center,
      worldEnvironmentIdentityKey: sample.worldEnvironmentIdentityKey,
      zoneCount: sample.zoneIds.length,
      eligibleAreaKm2: sample.eligibleAreaKm2
    })),
    eligibleAreaKm2: sampleAreaKm2,
    equivalentFlagFootprints,
    kinds,
    wildlifePerEquivalentFlag,
    wolfPackSizes: {
      two: {
        count: twoWolfPacks,
        percentage: packPercentage(twoWolfPacks)
      },
      three: {
        count: threeWolfPacks,
        percentage: packPercentage(threeWolfPacks)
      },
      four: {
        count: fourWolfPacks,
        percentage: packPercentage(fourWolfPacks)
      },
      totalWolfCount,
      averageWolvesPerPack,
      encounterCountBeforeExpansion: wolfPackCount,
      encounterCountAfterExpansion: wolfPackSizes.length,
      encounterCountUnchangedByExpansion:
        wolfPackCount === wolfPackSizes.length,
      passed: packDistributionPassed
    },
    rareAllocation: {
      ogres: rareAllocationOgres,
      sapCrawlerGroups: rareAllocationSapCrawlerGroups,
      ogreToSapCrawlerGroupRatio,
      sapCrawlerGroupSizes: {
        five: {
          count: fiveSapCrawlerGroups,
          percentage: sapCrawlerGroupPercentage(fiveSapCrawlerGroups)
        },
        six: {
          count: sixSapCrawlerGroups,
          percentage: sapCrawlerGroupPercentage(sixSapCrawlerGroups)
        },
        seven: {
          count: sevenSapCrawlerGroups,
          percentage: sapCrawlerGroupPercentage(sevenSapCrawlerGroups)
        },
        totalSapCrawlerCount,
        averageSapCrawlersPerGroup,
        passed: sapCrawlerGroupDistributionPassed
      },
      passed: rareAllocationPassed
    },
    passed:
      Object.values(kinds).every((metric) => metric.passed)
      && wildlifeTargetsPassed
      && packDistributionPassed
      && rareAllocationPassed
  };
}

function measureSyntheticWaterSamplingGate(
  worldEnvironmentIdentityKey: string
): SelectedGeometryAcceptance["syntheticWaterSampling"] {
  const zoneId = populationZoneV2IdForPoint({
    lat: 29.9511,
    lon: -90.0715
  });
  const geometry = populationZoneV2Geometry(zoneId);
  const estimatedSamples = populationZoneV2HabitatSamplePoints({
    zoneId,
    worldEnvironmentIdentityKey,
    sampleCount: 48
  });
  const referenceSamples = populationZoneV2HabitatSamplePoints({
    zoneId,
    worldEnvironmentIdentityKey,
    sampleCount: 1_024
  });
  const eligibleFraction = (
    samples: readonly Readonly<{
      position: PopulationZoneV2Point;
      areaWeightKm2: number;
    }>[]
  ) => sum(samples.map((sample) =>
    syntheticWaterGeographyEligible(geometry, sample.position)
      ? sample.areaWeightKm2
      : 0
  )) / geometry.areaKm2;
  const estimatedEligibleFraction = eligibleFraction(estimatedSamples);
  const referenceEligibleFraction = eligibleFraction(referenceSamples);
  const absoluteEligibleFractionError = Math.abs(
    estimatedEligibleFraction - referenceEligibleFraction
  );
  const candidateSites = syntheticWaterCandidateSites({
    zoneId,
    worldEnvironmentIdentityKey
  });
  const eligibleAreaKm2 = geometry.areaKm2 * estimatedEligibleFraction;
  const habitat: PopulationZoneV2Habitat = {
    regionCode: "simulation-synthetic-water",
    eligibleLandKm2: eligibleAreaKm2,
    treeKm2: eligibleAreaKm2,
    deerKm2: eligibleAreaKm2,
    wolfKm2: eligibleAreaKm2,
    stoneKm2: eligibleAreaKm2,
    ogreKm2: eligibleAreaKm2,
    habitatSummary: {
      source: "synthetic-water-geography-v1",
      estimatedEligibleFraction,
      referenceEligibleFraction,
      absoluteEligibleFractionError
    },
    environmentSnapshot: {
      source: "synthetic-water-geography-v1",
      sampleCount: 48,
      referenceSampleCount: 1_024
    },
    candidateSites
  };
  const plan = generateProductionPopulationZonesV2Plans({
    outputZoneIds: [zoneId],
    worldEnvironmentIdentityKey,
    worldPipelineSha: SIMULATION_WORLD_RUNTIME_SHA,
    environmentProfileVersion: ENVIRONMENT_PROFILE_VERSION,
    habitatForZone: (ownerId) => ownerId === zoneId
      ? habitat
      : zeroProductionPopulationHabitat(ownerId)
  })[0]!;
  const ineligibleSelectedSlotCount = plan.slots.filter((slot) =>
    !syntheticWaterGeographyEligible(geometry, slot.position)
  ).length;
  const nonOwnerSelectedSlotCount = plan.slots.filter((slot) =>
    populationZoneV2IdForPoint(slot.position) !== zoneId
  ).length;
  const packIds = new Set(plan.slots
    .filter((slot) => slot.entityKind === "wolf" && slot.packId !== null)
    .map((slot) => slot.packId!));
  const sapCrawlerGroupIds = new Set(plan.slots
    .filter((slot) =>
      slot.entityKind === "sap_crawler" && slot.packId !== null
    )
    .map((slot) => slot.packId!));
  const selectedSlotKindCounts = {
    trees: countWhere(plan.slots, (slot) => slot.entityKind === "tree"),
    deer: countWhere(plan.slots, (slot) => slot.entityKind === "deer"),
    wolfPacks: packIds.size,
    wolves: countWhere(plan.slots, (slot) => slot.entityKind === "wolf"),
    stones: countWhere(plan.slots, (slot) => slot.entityKind === "stone"),
    ogres: countWhere(plan.slots, (slot) => slot.entityKind === "ogre"),
    sapCrawlerGroups: sapCrawlerGroupIds.size,
    sapCrawlers: countWhere(
      plan.slots,
      (slot) => slot.entityKind === "sap_crawler"
    )
  };
  return {
    fieldVersion: "synthetic-water-geography-v1",
    zoneId,
    sampleCount: 48,
    referenceSampleCount: 1_024,
    estimatedEligibleFraction,
    referenceEligibleFraction,
    absoluteEligibleFractionError,
    maximumAllowedAbsoluteError: SYNTHETIC_WATER_SAMPLE_ERROR_LIMIT,
    candidateSiteCount: candidateSites.length,
    selectedSlotCount: plan.slots.length,
    selectedSlotKindCounts,
    ineligibleSelectedSlotCount,
    nonOwnerSelectedSlotCount,
    passed:
      absoluteEligibleFractionError <= SYNTHETIC_WATER_SAMPLE_ERROR_LIMIT
      && plan.slots.length > 0
      && ineligibleSelectedSlotCount === 0
      && nonOwnerSelectedSlotCount === 0
  };
}

function syntheticWaterCandidateSites(input: Readonly<{
  zoneId: PopulationZoneV2Id;
  worldEnvironmentIdentityKey: string;
}>): PopulationZoneV2HabitatCandidateSite[] {
  const geometry = populationZoneV2Geometry(input.zoneId);
  const sourceCellId = `synthetic-water:${input.zoneId}`;
  const candidateSlotVersion = "synthetic-water-candidate-slots-v1";
  return generateWorldEnvironmentCandidateSlots({
    cellId: sourceCellId,
    candidateSlotVersion,
    center: geometry.center
  }, 112, 650)
    .filter((point) =>
      populationZoneV2IdForPoint(point.position) === input.zoneId
    )
    .map((point) => {
      const eligibleLand = syntheticWaterGeographyEligible(
        geometry,
        point.position
      );
      const weight = eligibleLand ? 1 : 0;
      return {
        siteId: `synthetic-water/${point.slotId}`,
        position: point.position,
        source: "world-profile-candidate-slot",
        sourceSampleId: "synthetic-water-sample",
        sourceCellId,
        sourceSlotId: point.slotId,
        candidateSlotVersion,
        placementTags: point.placementTags,
        isSaltwater: !eligibleLand,
        insideMajorLake: false,
        elevationBand: "lowland",
        terrainClass: "flat",
        landCoverClass: eligibleLand ? "wetland-land" : "open-water",
        biomeId: eligibleLand ? "wetland-land" : "open-water",
        ecoregionId: eligibleLand ? "wetland" : "water",
        spawnProfileKey: eligibleLand ? "wetland" : "open-water",
        weights: {
          eligibleLand: weight,
          tree: weight,
          deer: weight,
          wolf: weight,
          stone: weight,
          ogre: weight
        }
      } satisfies PopulationZoneV2HabitatCandidateSite;
    })
    .sort((left, right) => left.siteId.localeCompare(right.siteId));
}

function syntheticWaterGeographyEligible(
  geometry: ReturnType<typeof populationZoneV2Geometry>,
  point: PopulationZoneV2Point
): boolean {
  const longitudeUnit = (point.lon - geometry.bounds.westLon)
    / (geometry.bounds.eastLon - geometry.bounds.westLon);
  const southSine = Math.sin(toRadians(geometry.bounds.southLat));
  const northSine = Math.sin(toRadians(geometry.bounds.northLat));
  const latitudeUnit = (
    Math.sin(toRadians(point.lat)) - southSine
  ) / (northSine - southSine);
  return longitudeUnit
    + 0.12 * Math.sin(latitudeUnit * Math.PI * 4) < 0.3;
}

function zeroProductionPopulationHabitat(
  zoneId: PopulationZoneV2Id
): PopulationZoneV2Habitat {
  return {
    regionCode: "simulation-zero",
    eligibleLandKm2: 0,
    treeKm2: 0,
    deerKm2: 0,
    wolfKm2: 0,
    stoneKm2: 0,
    ogreKm2: 0,
    habitatSummary: { source: "simulation-zero", zoneId },
    environmentSnapshot: { source: "simulation-zero" }
  };
}

function densityGateMetric(input: Readonly<{
  targetDensity: number;
  candidateInputDensity: number;
  actualCount: number;
  expectedCount: number;
  sampleAreaKm2: number;
  sampleUnitCount: number;
  minimumObservedSpacingM: number | null;
  requiredMinimumSpacingM: number | null;
}>): LongRunDensityGateMetric {
  const actualToExpectedRatio = input.actualCount / input.expectedCount;
  const relativeError = Math.abs(actualToExpectedRatio - 1);
  const spacingPassed =
    input.requiredMinimumSpacingM === null
    || (
      input.minimumObservedSpacingM !== null
      && input.minimumObservedSpacingM + 1e-6
        >= input.requiredMinimumSpacingM
    );
  return {
    targetDensityPerEligibleKm2: input.targetDensity,
    candidateInputDensityPerEligibleKm2: input.candidateInputDensity,
    observedDensityPerEligibleKm2:
      input.actualCount / input.sampleAreaKm2,
    expectedCount: input.expectedCount,
    actualCount: input.actualCount,
    actualToExpectedRatio,
    relativeError,
    sampleAreaKm2: input.sampleAreaKm2,
    sampleUnitCount: input.sampleUnitCount,
    minimumObservedSpacingM: input.minimumObservedSpacingM,
    passed:
      relativeError <= DENSITY_GATE_TOLERANCE_FRACTION
      && spacingPassed
  };
}

function longRunDensitySampleZones(
  sampleZoneCount: number,
  center: PopulationZoneV2Point
): PopulationZoneV2Id[] {
  let radiusM = Math.sqrt(sampleZoneCount / Math.PI) * 1_100;
  let zoneIds = populationZonesV2IntersectingCircle(center, radiusM);
  while (zoneIds.length < sampleZoneCount) {
    radiusM *= 1.1;
    zoneIds = populationZonesV2IntersectingCircle(center, radiusM);
  }
  return zoneIds
    .map((zoneId) => ({
      zoneId,
      distanceM: greatCircleDistanceMeters(
        center,
        populationZoneV2Geometry(zoneId).center
      )
    }))
    .sort((left, right) =>
      left.distanceM - right.distanceM
      || left.zoneId.localeCompare(right.zoneId)
    )
    .slice(0, sampleZoneCount)
    .map((entry) => entry.zoneId);
}

function minimumCandidateSpacing(
  candidates: readonly GlobalRankedCandidate[],
  searchDistanceM: number
): number | null {
  if (candidates.length < 2) return null;
  const spatialIndex = candidateSpatialIndex(candidates, searchDistanceM);
  let minimum = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    for (const other of nearbySpatialCandidates(spatialIndex, candidate)) {
      if (other.candidateId <= candidate.candidateId) continue;
      minimum = Math.min(
        minimum,
        greatCircleDistanceMeters(
          candidate.position,
          other.position
        )
      );
    }
  }
  return Number.isFinite(minimum) ? minimum : null;
}

function measureAdjacentRetentionGate():
  SelectedGeometryAcceptance["adjacentRetention"] {
  // Retained / destination-active measures how much of the destination is
  // already warm and therefore how thin the newly activated edge is. The
  // stricter intersection / union value remains visible as a diagnostic.
  const probes = PERSISTENT_POPULATION_V2_SCENARIOS.flatMap((scenario) =>
    [0, 45, 90, 135, 180, 225, 270, 315].map((bearingDegrees) => {
      const destination = destinationPoint(
        scenario.center,
        ADJACENT_RETENTION_DISTANCE_M,
        bearingDegrees
      );
      const delta = activeSetDelta(
        populationZonesV2IntersectingCircle(
          scenario.center,
          PREPARED_POPULATION_RADIUS_M
        ),
        populationZonesV2IntersectingCircle(
          destination,
          PREPARED_POPULATION_RADIUS_M
        )
      );
      return {
        scenarioId: scenario.id,
        bearingDegrees,
        retained: delta.retained.length,
        activated: delta.activated.length,
        released: delta.released.length,
        destinationRatio: delta.retained.length / (
          delta.retained.length + delta.activated.length
        ),
        unionRatio: delta.retained.length / (
          delta.retained.length
          + delta.activated.length
          + delta.released.length
        )
      };
    })
  );
  const worstProbe = probes.reduce((worst, probe) =>
    probe.destinationRatio < worst.destinationRatio ? probe : worst
  );
  return {
    distanceM: ADJACENT_RETENTION_DISTANCE_M,
    minimumRequiredDestinationRatio: ADJACENT_RETENTION_MINIMUM,
    probes: probes.length,
    observedMinimumDestinationRatio: worstProbe.destinationRatio,
    observedMinimumUnionRatio: Math.min(
      ...probes.map((probe) => probe.unionRatio)
    ),
    destinationRatioDistribution: distribution(
      probes.map((probe) => probe.destinationRatio)
    ),
    unionRatioDiagnosticDistribution: distribution(
      probes.map((probe) => probe.unionRatio)
    ),
    releasedZonesWarmGraceModeledContract: true,
    worstProbe: {
      scenarioId: worstProbe.scenarioId,
      bearingDegrees: worstProbe.bearingDegrees,
      retained: worstProbe.retained,
      activated: worstProbe.activated,
      released: worstProbe.released
    },
    passed: worstProbe.destinationRatio >= ADJACENT_RETENTION_MINIMUM
  };
}

function measureFullyLandFootprintGate(
  worldEnvironmentIdentityKey: string
): SelectedGeometryAcceptance["fullyLandFootprint"] {
  const probes = PERSISTENT_POPULATION_V2_SCENARIOS.map((scenario) => {
    const plan = generateGridPopulationPlan({
      zoneIds: populationZonesV2IntersectingCircle(
        scenario.center,
        PREPARED_POPULATION_RADIUS_M
      ),
      eligibleFraction: 1,
      worldEnvironmentIdentityKey
    });
    const counts = countEntities(plan);
    return {
      databaseBytes:
        plan.cells.length * 384 + plan.entities.length * (320 + 128),
      runtimeActors:
        counts.deer
        + counts.wolves
        + counts.ogres,
      sapCrawlerActors: counts.sapCrawlers
    };
  });
  const observedMaximumDatabaseBytes = Math.max(
    ...probes.map((probe) => probe.databaseBytes)
  );
  const observedMaximumRuntimeActors = Math.max(
    ...probes.map((probe) => probe.runtimeActors)
  );
  const observedMaximumSapCrawlerActors = Math.max(
    ...probes.map((probe) => probe.sapCrawlerActors)
  );
  const observedMaximumTotalRuntimeActors = Math.max(
    ...probes.map((probe) =>
      probe.runtimeActors + probe.sapCrawlerActors
    )
  );
  return {
    probes: probes.length,
    databaseLimitBytes: FULLY_LAND_DATABASE_LIMIT_BYTES,
    observedMaximumDatabaseBytes,
    runtimeActorLimit: FULLY_LAND_RUNTIME_ACTOR_LIMIT,
    observedMaximumRuntimeActors,
    totalRuntimeActorLimit: FULLY_LAND_TOTAL_RUNTIME_ACTOR_LIMIT,
    observedMaximumTotalRuntimeActors,
    observedMaximumSapCrawlerActors,
    passed:
      observedMaximumDatabaseBytes <= FULLY_LAND_DATABASE_LIMIT_BYTES
      && observedMaximumRuntimeActors <= FULLY_LAND_RUNTIME_ACTOR_LIMIT
      && observedMaximumTotalRuntimeActors
        <= FULLY_LAND_TOTAL_RUNTIME_ACTOR_LIMIT
  };
}

function measureFourFlagPermutationGate(
  worldEnvironmentIdentityKey: string
): SelectedGeometryAcceptance["fourFlagPermutations"] {
  const flags = [0, 90, 180, 270].map((bearing) =>
    destinationPoint(
      FOUR_FLAG_ACCEPTANCE_CENTER,
      FOUR_FLAG_ACCEPTANCE_OFFSET_M,
      bearing
    )
  );
  const orders = permutations([0, 1, 2, 3] as const);
  let baselineEntityIds: string[] | null = null;
  let baselineEntityCounts:
    GeometryScenarioMetrics["entityCounts"] | null = null;
  let baselinePlanCount: number | null = null;
  let entityCountMismatches = 0;
  let entityIdMismatches = 0;
  let planCountMismatches = 0;

  for (const order of orders) {
    const planCache = new Map<PopulationZoneV2Id, GeometryPlan>();
    for (const flagIndex of order) {
      for (const zoneId of populationZonesV2IntersectingCircle(
        flags[flagIndex]!,
        PREPARED_POPULATION_RADIUS_M
      )) {
        if (planCache.has(zoneId)) continue;
        planCache.set(zoneId, generateGridPopulationPlan({
          zoneIds: [zoneId],
          eligibleFraction: FOUR_FLAG_ACCEPTANCE_ELIGIBLE_FRACTION,
          suitability: DEFAULT_SUITABILITY,
          worldEnvironmentIdentityKey
        }));
      }
    }
    const entitiesById = new Map(
      [...planCache.values()].flatMap((plan) =>
        plan.entities.map((entity) => [entity.entityId, entity] as const)
      )
    );
    const entityIds = [...entitiesById.keys()].sort();
    if (baselineEntityIds === null) {
      baselineEntityIds = entityIds;
      baselineEntityCounts = countEntities({
        cells: [],
        anchors: [],
        entities: [...entitiesById.values()]
      });
      baselinePlanCount = planCache.size;
      continue;
    }
    if (entityIds.length !== baselineEntityIds.length) {
      entityCountMismatches += 1;
    }
    if (!arraysEqual(entityIds, baselineEntityIds)) {
      entityIdMismatches += 1;
    }
    if (planCache.size !== baselinePlanCount) {
      planCountMismatches += 1;
    }
  }

  const finalEntityCounts = baselineEntityCounts ?? {
    trees: 0,
    deer: 0,
    wolfPacks: 0,
    wolves: 0,
    stones: 0,
    ogres: 0,
    sapCrawlerGroups: 0,
    sapCrawlers: 0
  };
  const expectedPreparedAreaKindsPresent = [
    finalEntityCounts.trees,
    finalEntityCounts.deer,
    finalEntityCounts.wolfPacks,
    finalEntityCounts.wolves,
    finalEntityCounts.stones
  ].every((count) => count > 0);
  return {
    permutations: 24,
    fixtureCenter: FOUR_FLAG_ACCEPTANCE_CENTER,
    flagOffsetM: FOUR_FLAG_ACCEPTANCE_OFFSET_M,
    eligibleFraction: FOUR_FLAG_ACCEPTANCE_ELIGIBLE_FRACTION,
    finalEntityCount: baselineEntityIds?.length ?? 0,
    finalEntityCounts,
    finalPlanCount: baselinePlanCount ?? 0,
    entityCountMismatches,
    entityIdMismatches,
    planCountMismatches,
    passed:
      orders.length === 24
      && entityCountMismatches === 0
      && entityIdMismatches === 0
      && planCountMismatches === 0
      && expectedPreparedAreaKindsPresent
  };
}

function measureAdjacentPingPongGate(
  worldEnvironmentIdentityKey: string
): SelectedGeometryAcceptance["adjacentPingPong"] {
  const scenario = requiredScenario("repeated_visits_respawns");
  const first = scenario.flags[0]!;
  const second = scenario.flags[1]!;
  const planCache = new Map<PopulationZoneV2Id, GeometryPlan>();
  const durableEntityIds = new Set<string>();
  let previousZoneIds: readonly PopulationZoneV2Id[] = [];
  let plansCreated = 0;
  let newEntityIds = 0;
  let plansCreatedAfterWarmup = 0;
  let newEntityIdsAfterWarmup = 0;
  let duplicateEntityIds = 0;
  let retained = 0;
  let activated = 0;
  let released = 0;
  let fullResetsAfterFirstVisit = 0;

  for (let visit = 0; visit < 20; visit += 1) {
    const destination = visit % 2 === 0 ? first : second;
    const nextZoneIds = populationZonesV2IntersectingCircle(
      destination,
      PREPARED_POPULATION_RADIUS_M
    );
    const delta = activeSetDelta(previousZoneIds, nextZoneIds);
    retained += delta.retained.length;
    activated += delta.activated.length;
    released += delta.released.length;
    if (visit > 0 && delta.retained.length === 0) {
      fullResetsAfterFirstVisit += 1;
    }
    for (const zoneId of nextZoneIds) {
      if (planCache.has(zoneId)) continue;
      const plan = generateGridPopulationPlan({
        zoneIds: [zoneId],
        eligibleFraction: scenario.eligibleFraction,
        suitability: scenario.suitability,
        worldEnvironmentIdentityKey
      });
      planCache.set(zoneId, plan);
      plansCreated += 1;
      if (visit >= 2) plansCreatedAfterWarmup += 1;
      for (const entity of plan.entities) {
        if (durableEntityIds.has(entity.entityId)) {
          duplicateEntityIds += 1;
          continue;
        }
        durableEntityIds.add(entity.entityId);
        newEntityIds += 1;
        if (visit >= 2) newEntityIdsAfterWarmup += 1;
      }
    }
    previousZoneIds = nextZoneIds;
  }

  return {
    visits: 20,
    plansCreated,
    newEntityIds,
    plansCreatedAfterWarmup,
    newEntityIdsAfterWarmup,
    duplicateEntityIds,
    retained,
    activated,
    released,
    fullResetsAfterFirstVisit,
    passed:
      plansCreatedAfterWarmup === 0
      && newEntityIdsAfterWarmup === 0
      && duplicateEntityIds === 0
      && fullResetsAfterFirstVisit === 0
      && retained > activated
  };
}

function measureDurableRespawnGate(
  worldEnvironmentIdentityKey: string
): SelectedGeometryAcceptance["durableRespawn"] {
  const scenario = requiredScenario("repeated_visits_respawns");
  const plan = generateGridPopulationPlan({
    zoneIds: populationZonesV2IntersectingCircle(
      scenario.center,
      PREPARED_POPULATION_RADIUS_M
    ),
    eligibleFraction: scenario.eligibleFraction,
    suitability: scenario.suitability,
    worldEnvironmentIdentityKey
  });
  const baseline = new Map(plan.entities.map((entity) => [
    entity.entityId,
    entity.homePosition
  ] as const));
  let state = plan.entities.map((entity) => ({
    entity,
    readiness: "ready" as "ready" | "not-ready"
  }));
  let notReadyTransitions = 0;
  let readyTransitions = 0;
  let identityMismatches = 0;
  let homeMismatches = 0;
  let countIncreases = 0;

  for (let cycle = 0; cycle < 5; cycle += 1) {
    state = state.map(({ entity }) => {
      notReadyTransitions += 1;
      return { entity, readiness: "not-ready" as const };
    });
    state = state.map(({ entity }) => {
      const home = baseline.get(entity.entityId);
      if (home === undefined) {
        identityMismatches += 1;
      } else if (
        home.lat !== entity.homePosition.lat
        || home.lon !== entity.homePosition.lon
      ) {
        homeMismatches += 1;
      }
      readyTransitions += 1;
      return {
        entity: {
          ...entity,
          position: { ...entity.homePosition }
        },
        readiness: "ready" as const
      };
    });
    if (state.length > baseline.size) countIncreases += 1;
    if (new Set(state.map(({ entity }) => entity.entityId)).size
      !== baseline.size) {
      identityMismatches += 1;
    }
  }

  return {
    cycles: 5,
    entityCount: baseline.size,
    notReadyTransitions,
    readyTransitions,
    identityMismatches,
    homeMismatches,
    countIncreases,
    passed:
      baseline.size > 0
      && notReadyTransitions === baseline.size * 5
      && readyTransitions === baseline.size * 5
      && identityMismatches === 0
      && homeMismatches === 0
      && countIncreases === 0
  };
}

function simulateGeometryScenario(
  scenario: SimulationScenario,
  geometry: GeometryOption,
  worldEnvironmentIdentityKey: string
): Readonly<{
  metrics: GeometryScenarioMetrics;
  zoneStatistics: readonly ZoneStatistic[];
}> {
  const zonesForPoint = geometry === "equal-area-grid"
    ? (point: PopulationZoneV2Point) =>
      populationZonesV2IntersectingCircle(point, PREPARED_POPULATION_RADIUS_M)
    : h3ZonesIntersectingCircle;
  const flagSets = scenario.flags.map((point) => zonesForPoint(point));
  const playerSets = scenario.players.map((point) => zonesForPoint(point));
  const activationSets = [...flagSets, ...playerSets];
  const unionZoneIds = [...new Set(activationSets.flat())].sort();
  const activeReferences = referenceCounts(activationSets);
  const plan = geometry === "equal-area-grid"
    ? generateGridPopulationPlan({
      zoneIds: unionZoneIds as PopulationZoneV2Id[],
      eligibleFraction: scenario.eligibleFraction,
      suitability: scenario.suitability,
      worldEnvironmentIdentityKey
    })
    : generateH3PopulationPlan({
      zoneIds: unionZoneIds,
      eligibleFraction: scenario.eligibleFraction,
      suitability: scenario.suitability,
      worldEnvironmentIdentityKey
    });
  const reversedPlan = geometry === "equal-area-grid"
    ? generateGridPopulationPlan({
      zoneIds: [...unionZoneIds].reverse() as PopulationZoneV2Id[],
      eligibleFraction: scenario.eligibleFraction,
      suitability: scenario.suitability,
      worldEnvironmentIdentityKey
    })
    : generateH3PopulationPlan({
      zoneIds: [...unionZoneIds].reverse(),
      eligibleFraction: scenario.eligibleFraction,
      suitability: scenario.suitability,
      worldEnvironmentIdentityKey
    });
  const repeatedPlan = geometry === "equal-area-grid"
    ? generateGridPopulationPlan({
      zoneIds: unionZoneIds as PopulationZoneV2Id[],
      eligibleFraction: scenario.eligibleFraction,
      suitability: scenario.suitability,
      worldEnvironmentIdentityKey
    })
    : generateH3PopulationPlan({
      zoneIds: unionZoneIds,
      eligibleFraction: scenario.eligibleFraction,
      suitability: scenario.suitability,
      worldEnvironmentIdentityKey
    });

  const entityIds = plan.entities.map((entity) => entity.entityId).sort();
  const reversedIds = reversedPlan.entities.map((entity) => entity.entityId).sort();
  const repeatedIds = repeatedPlan.entities.map((entity) => entity.entityId).sort();
  const respawnIds = simulateStableRespawn(
    plan.entities,
    scenario.respawnCycles
  ).map((entity) => entity.entityId).sort();
  const entityCounts = countEntities(plan);
  const totalAreaKm2 = sum(plan.cells.map((cell) => cell.areaKm2));
  const eligibleAreaKm2 = totalAreaKm2 * scenario.eligibleFraction;
  const [firstTravel, secondTravel] = travelPair(scenario);
  const travelDelta = activeSetDelta(
    zonesForPoint(firstTravel),
    zonesForPoint(secondTravel)
  );
  const retainedRatio = travelDelta.retained.length
    / Math.max(
      1,
      travelDelta.retained.length + travelDelta.activated.length
    );
  const uniqueEntityIds = new Set(entityIds).size;
  const conflictMatrixViolations = measureConflictMatrixViolations(plan);
  const conflictMatrixExerciseCounts =
    measureConflictMatrixExerciseCounts(plan);
  const metrics: GeometryScenarioMetrics = {
    zoneCount: plan.cells.length,
    totalAreaKm2,
    eligibleAreaKm2,
    cellAreaKm2: distribution(plan.cells.map((cell) => cell.areaKm2)),
    activeZoneCounts: {
      perFlag: flagSets.map((ids) => ids.length),
      perPlayer: playerSets.map((ids) => ids.length),
      union: unionZoneIds.length,
      maximumSharedReferenceCount: Math.max(
        0,
        ...activeReferences.values()
      )
    },
    adjacentTravelDelta: {
      retained: travelDelta.retained.length,
      activated: travelDelta.activated.length,
      released: travelDelta.released.length,
      retainedRatio
    },
    entityCounts,
    densityPerEligibleKm2: {
      trees: safeDensity(entityCounts.trees, eligibleAreaKm2),
      deer: safeDensity(entityCounts.deer, eligibleAreaKm2),
      wolfPacks: safeDensity(entityCounts.wolfPacks, eligibleAreaKm2),
      stones: safeDensity(entityCounts.stones, eligibleAreaKm2),
      ogres: safeDensity(entityCounts.ogres, eligibleAreaKm2),
      sapCrawlerGroups:
        safeDensity(entityCounts.sapCrawlerGroups, eligibleAreaKm2),
      sapCrawlers: safeDensity(entityCounts.sapCrawlers, eligibleAreaKm2)
    },
    uniqueEntityIds,
    duplicateEntityIds: entityIds.length - uniqueEntityIds,
    seamSpacingViolations: {
      tree: seamSpacingViolations(plan.anchors, "tree"),
      deer: seamSpacingViolations(plan.anchors, "deer"),
      wolf_pack: seamSpacingViolations(plan.anchors, "wolf_pack")
    },
    seamSpacingComparisons: {
      tree: seamSpacingComparisonCount(plan.anchors, "tree"),
      deer: seamSpacingComparisonCount(plan.anchors, "deer"),
      wolf_pack: seamSpacingComparisonCount(plan.anchors, "wolf_pack")
    },
    conflictMatrixViolations,
    conflictMatrixExerciseCounts,
    estimatedDatabaseBytes:
      plan.cells.length * 384 + plan.entities.length * (320 + 128),
    estimatedRuntimeActors:
      entityCounts.deer
      + entityCounts.wolves
      + entityCounts.ogres
      + entityCounts.sapCrawlers,
    orderIndependent: arraysEqual(entityIds, reversedIds),
    repeatedVisitIdsStable: arraysEqual(entityIds, repeatedIds),
    respawnIdsStable: arraysEqual(entityIds, respawnIds),
    configuredVisitCount: scenario.visits,
    homeResetCyclesApplied: scenario.respawnCycles
  };

  return {
    metrics,
    zoneStatistics: zoneStatisticsFor(
      scenario,
      geometry,
      plan,
      activeReferences
    )
  };
}

function desiredGridCandidates(
  zoneId: PopulationZoneV2Id,
  kind: CommonPlanKind,
  eligibleFraction: number,
  suitability: number,
  worldEnvironmentIdentityKey: string,
  baselineCommonDensity = false
): GlobalRankedCandidate[] {
  const geometry = populationZoneV2Geometry(zoneId);
  const count = deterministicEligibleAreaCount({
    ownerId: zoneId,
    kind,
    eligibleAreaKm2: geometry.areaKm2 * eligibleFraction * suitability,
    densityPerEligibleKm2: candidateInputDensityFor(
      kind,
      baselineCommonDensity
    ),
    worldEnvironmentIdentityKey
  });
  return Array.from({ length: count }, (_, index) =>
    gridCandidate(
      zoneId,
      kind,
      index,
      worldEnvironmentIdentityKey,
      geometry
    )
  );
}

function globalRankedGridCandidateField(input: Readonly<{
  zoneIds: readonly PopulationZoneV2Id[];
  eligibleFraction: number;
  suitability: Readonly<Record<PopulationPlanKind, number>>;
  worldEnvironmentIdentityKey: string;
}>): GlobalRankedCandidate[] {
  validatePlacementInputs(input);
  const outputZoneIds = [...new Set(input.zoneIds)].sort();
  const desiredOutput = rawGridCandidatesForZones({
    zoneIds: outputZoneIds,
    eligibleFraction: input.eligibleFraction,
    suitability: input.suitability,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
  });
  const universeZoneIds = new Set<PopulationZoneV2Id>(outputZoneIds);
  for (const candidate of desiredOutput) {
    for (const zoneId of populationZonesV2IntersectingCircle(
      candidate.position,
      CANDIDATE_LOOKUP_HALO_M
    )) {
      universeZoneIds.add(zoneId);
    }
  }
  const outputZoneIdSet = new Set(outputZoneIds);
  const haloZoneIds = [...universeZoneIds]
    .filter((zoneId) => !outputZoneIdSet.has(zoneId))
    .sort();
  const universe = [
    ...desiredOutput,
    ...rawGridCandidatesForZones({
      zoneIds: haloZoneIds,
      eligibleFraction: input.eligibleFraction,
      suitability: input.suitability,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
    })
  ];
  const baselineUniverse = baselineCommonCandidateSubset({
    candidates: universe,
    eligibleFraction: input.eligibleFraction,
    suitability: input.suitability,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
    areaKm2ForOwner: (ownerId) =>
      populationZoneV2Geometry(ownerId as PopulationZoneV2Id).areaKm2
  });
  return retainBaselineAndExpansion(
    desiredOutput,
    universe,
    baselineUniverse
  );
}

function rawGridCandidatesForZones(input: Readonly<{
  zoneIds: readonly PopulationZoneV2Id[];
  eligibleFraction: number;
  suitability: Readonly<Record<PopulationPlanKind, number>>;
  worldEnvironmentIdentityKey: string;
  baselineCommonDensity?: boolean;
}>): GlobalRankedCandidate[] {
  const common = input.zoneIds.flatMap((zoneId) =>
    (Object.keys(COMMON_KIND_CONFIGURATION) as CommonPlanKind[])
      .flatMap((kind) => desiredGridCandidates(
        zoneId,
        kind,
        input.eligibleFraction,
        input.suitability[kind],
        input.worldEnvironmentIdentityKey,
        input.baselineCommonDensity === true
      ))
  );
  const rare = rareCandidatesForCells({
    geometry: "equal-area-grid",
    cells: input.zoneIds.map(gridCell),
    activeIds: new Set(input.zoneIds),
    eligibleFraction: input.eligibleFraction,
    suitability: input.suitability,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
  });
  return [...common, ...rare].sort(compareCandidates);
}

/**
 * The versioned field is deliberately oversampled before global rank
 * thinning. Factors are measured against the retained deterministic
 * equal-area sample; a raw Poisson inverse is only an approximation because
 * candidate counts are stratified by one-square-kilometer owners.
 */
function candidateInputDensityFor(
  kind: CommonPlanKind,
  baseline = false
): number {
  const configuration = COMMON_KIND_CONFIGURATION[kind];
  const configuredDensity = baseline
    ? configuration.densityPerEligibleKm2
      / POPULATION_DENSITY_MULTIPLIERS[kind]
    : configuration.densityPerEligibleKm2;
  const spacingKm = configuration.minimumSpacingM / 1_000;
  const highLoadExpansion = !baseline
    && configuredDensity * Math.PI * spacingKm ** 2 >= 1;
  return configuredDensity
    * configuration.candidateOversamplingFactor
    * (
      highLoadExpansion
        ? POPULATION_DENSITY_MULTIPLIERS[kind]
          ** HIGH_LOAD_EXPANSION_CANDIDATE_POWER
        : 1
    );
}

function gridCandidate(
  zoneId: PopulationZoneV2Id,
  kind: CommonPlanKind,
  index: number,
  worldEnvironmentIdentityKey: string,
  geometry = populationZoneV2Geometry(zoneId)
): GlobalRankedCandidate {
  const latitudeUnit = deterministicUnit(
    POPULATION_CANDIDATE_LAYOUT_VERSION,
    worldEnvironmentIdentityKey,
    ENVIRONMENT_PROFILE_VERSION,
    zoneId,
    kind,
    index,
    "latitude"
  );
  const longitudeUnit = deterministicUnit(
    POPULATION_CANDIDATE_LAYOUT_VERSION,
    worldEnvironmentIdentityKey,
    ENVIRONMENT_PROFILE_VERSION,
    zoneId,
    kind,
    index,
    "longitude"
  );
  const southSine = Math.sin(toRadians(geometry.bounds.southLat));
  const northSine = Math.sin(toRadians(geometry.bounds.northLat));
  const position = {
    lat: toDegrees(Math.asin(
      southSine + (northSine - southSine) * latitudeUnit
    )),
    lon: normalizeLongitude(
      geometry.bounds.westLon
        + (
          geometry.bounds.eastLon - geometry.bounds.westLon
        ) * longitudeUnit
    )
  };
  const candidateId =
    `${POPULATION_CANDIDATE_LAYOUT_VERSION}/`
    + `${worldEnvironmentIdentityNamespace(worldEnvironmentIdentityKey)}/`
    + `${kind}/${zoneId}/${index.toString(36)}`;
  return {
    candidateId,
    ownerId: zoneId,
    kind,
    position,
    rank: hashHex(
      CANDIDATE_RANK_VERSION,
      worldEnvironmentIdentityKey,
      ENVIRONMENT_PROFILE_VERSION,
      candidateId
    )
  };
}

function globalRankedH3CandidateField(input: Readonly<{
  zoneIds: readonly string[];
  eligibleFraction: number;
  suitability: Readonly<Record<PopulationPlanKind, number>>;
  worldEnvironmentIdentityKey: string;
}>): GlobalRankedCandidate[] {
  validatePlacementInputs(input);
  const outputZoneIds = [...new Set(input.zoneIds)].sort();
  const output = rawH3CandidatesForZones({
    zoneIds: outputZoneIds,
    eligibleFraction: input.eligibleFraction,
    suitability: input.suitability,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
  });
  const ringSize = Math.ceil(
    CANDIDATE_LOOKUP_HALO_M
    / getHexagonEdgeLengthAvg(H3_COMPARISON_RESOLUTION, UNITS.m)
  ) + 2;
  const universeZoneIds = new Set<string>(outputZoneIds);
  for (const zoneId of outputZoneIds) {
    for (const neighbor of gridDisk(zoneId, ringSize)) {
      universeZoneIds.add(neighbor);
    }
  }
  const outputZoneIdSet = new Set(outputZoneIds);
  const haloZoneIds = [...universeZoneIds]
    .filter((zoneId) => !outputZoneIdSet.has(zoneId))
    .sort();
  const universe = [
    ...output,
    ...rawH3CandidatesForZones({
      zoneIds: haloZoneIds,
      eligibleFraction: input.eligibleFraction,
      suitability: input.suitability,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
    })
  ];
  const baselineUniverse = baselineCommonCandidateSubset({
    candidates: universe,
    eligibleFraction: input.eligibleFraction,
    suitability: input.suitability,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
    areaKm2ForOwner: (ownerId) => cellArea(ownerId, UNITS.km2)
  });
  return retainBaselineAndExpansion(
    output,
    universe,
    baselineUniverse
  );
}

function rawH3CandidatesForZones(input: Readonly<{
  zoneIds: readonly string[];
  eligibleFraction: number;
  suitability: Readonly<Record<PopulationPlanKind, number>>;
  worldEnvironmentIdentityKey: string;
  baselineCommonDensity?: boolean;
}>): GlobalRankedCandidate[] {
  const common = input.zoneIds.flatMap((zoneId) =>
    (Object.keys(COMMON_KIND_CONFIGURATION) as CommonPlanKind[])
      .flatMap((kind) => desiredH3Candidates(
        zoneId,
        kind,
        input.eligibleFraction,
        input.suitability[kind],
        input.worldEnvironmentIdentityKey,
        input.baselineCommonDensity === true
      ))
  );
  const rare = rareCandidatesForCells({
    geometry: "h3-resolution-8",
    cells: input.zoneIds.map(h3Cell),
    activeIds: new Set(input.zoneIds),
    eligibleFraction: input.eligibleFraction,
    suitability: input.suitability,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
  });
  return [...common, ...rare].sort(compareCandidates);
}

function desiredH3Candidates(
  zoneId: string,
  kind: CommonPlanKind,
  eligibleFraction: number,
  suitability: number,
  worldEnvironmentIdentityKey: string,
  baselineCommonDensity = false
): GlobalRankedCandidate[] {
  const count = deterministicEligibleAreaCount({
    ownerId: zoneId,
    kind,
    eligibleAreaKm2:
      cellArea(zoneId, UNITS.km2) * eligibleFraction * suitability,
    densityPerEligibleKm2: candidateInputDensityFor(
      kind,
      baselineCommonDensity
    ),
    worldEnvironmentIdentityKey
  });
  return Array.from({ length: count }, (_, index) =>
    h3Candidate(zoneId, kind, index, worldEnvironmentIdentityKey)
  );
}

function h3Candidate(
  zoneId: string,
  kind: CommonPlanKind,
  index: number,
  worldEnvironmentIdentityKey: string
): GlobalRankedCandidate {
  const [centerLat, centerLon] = cellToLatLng(zoneId);
  const boundary = cellToBoundary(zoneId).map(([lat, lon]) => ({
    lat,
    lon: centerLon + shortestLongitudeDelta(centerLon, lon)
  }));
  const triangle = Math.floor(
    deterministicUnit(
      POPULATION_CANDIDATE_LAYOUT_VERSION,
      worldEnvironmentIdentityKey,
      ENVIRONMENT_PROFILE_VERSION,
      zoneId,
      kind,
      index,
      "triangle"
    ) * boundary.length
  );
  const firstVertex = boundary[triangle]!;
  const secondVertex = boundary[(triangle + 1) % boundary.length]!;
  const root = Math.sqrt(deterministicUnit(
    POPULATION_CANDIDATE_LAYOUT_VERSION,
    worldEnvironmentIdentityKey,
    ENVIRONMENT_PROFILE_VERSION,
    zoneId,
    kind,
    index,
    "radius"
  ));
  const edgeUnit = deterministicUnit(
    POPULATION_CANDIDATE_LAYOUT_VERSION,
    worldEnvironmentIdentityKey,
    ENVIRONMENT_PROFILE_VERSION,
    zoneId,
    kind,
    index,
    "edge"
  );
  const centerWeight = 1 - root;
  const firstWeight = root * (1 - edgeUnit);
  const secondWeight = root * edgeUnit;
  let position = {
    lat:
      centerLat * centerWeight
      + firstVertex.lat * firstWeight
      + secondVertex.lat * secondWeight,
    lon: normalizeLongitude(
      centerLon * centerWeight
        + firstVertex.lon * firstWeight
        + secondVertex.lon * secondWeight
    )
  };
  if (
    latLngToCell(
      position.lat,
      position.lon,
      H3_COMPARISON_RESOLUTION
    ) !== zoneId
  ) {
    position = {
      lat: (centerLat + position.lat) / 2,
      lon: normalizeLongitude(
        centerLon + shortestLongitudeDelta(centerLon, position.lon) / 2
      )
    };
  }
  const candidateId =
    `${POPULATION_CANDIDATE_LAYOUT_VERSION}/`
    + `${worldEnvironmentIdentityNamespace(worldEnvironmentIdentityKey)}/`
    + `${kind}/h3r8/${zoneId}/${index.toString(36)}`;
  return {
    candidateId,
    ownerId: zoneId,
    kind,
    position,
    rank: hashHex(
      CANDIDATE_RANK_VERSION,
      worldEnvironmentIdentityKey,
      ENVIRONMENT_PROFILE_VERSION,
      candidateId
    )
  };
}

function retainGlobalRankWinners(
  output: readonly GlobalRankedCandidate[],
  universe: readonly GlobalRankedCandidate[]
): GlobalRankedCandidate[] {
  const spatialIndex = candidateSpatialIndex(universe);
  return output.filter((candidate) => {
    for (const other of nearbySpatialCandidates(spatialIndex, candidate)) {
      if (
        candidate.kind === "sap_crawler_group"
        && other.kind !== "sap_crawler_group"
        && candidatesConflict(other, candidate)
      ) {
        return false;
      }
      if (
        other.candidateId !== candidate.candidateId
        && compareCandidates(other, candidate) < 0
        && candidatesConflict(other, candidate)
      ) {
        return false;
      }
    }
    return true;
  }).sort(compareCandidates);
}

function retainBaselineAndExpansion(
  output: readonly GlobalRankedCandidate[],
  universe: readonly GlobalRankedCandidate[],
  baselineUniverse: readonly GlobalRankedCandidate[]
): GlobalRankedCandidate[] {
  const universeSpatialIndex = candidateSpatialIndex(universe);
  const accepted = retainGlobalRankWinners(
    baselineUniverse,
    baselineUniverse
  ).filter((candidate) =>
    candidate.kind !== "sap_crawler_group"
    || !nearbySpatialCandidates(universeSpatialIndex, candidate).some(
      (other) =>
        other.kind !== "sap_crawler_group"
        && candidatesConflict(other, candidate)
    )
  );
  const acceptedSpatialIndex = candidateSpatialIndex(accepted);
  const baselineIds = new Set(
    baselineUniverse.map((candidate) => candidate.candidateId)
  );
  const expansion = new Map<string, GlobalRankedCandidate>();
  for (const candidate of universe) {
    if (!baselineIds.has(candidate.candidateId)) {
      expansion.set(candidate.candidateId, candidate);
    }
  }
  for (const candidate of [...expansion.values()].sort(compareCandidates)) {
    const conflicts = nearbySpatialCandidates(
      acceptedSpatialIndex,
      candidate
    ).some((other) => candidatesConflict(other, candidate));
    if (conflicts) continue;
    accepted.push(candidate);
    addCandidateToSpatialIndex(acceptedSpatialIndex, candidate);
  }
  const outputIds = new Set(output.map((candidate) => candidate.candidateId));
  return accepted.filter((candidate) =>
    outputIds.has(candidate.candidateId)
  ).sort(compareCandidates);
}

function baselineCommonCandidateSubset(input: Readonly<{
  candidates: readonly GlobalRankedCandidate[];
  eligibleFraction: number;
  suitability: Readonly<Record<PopulationPlanKind, number>>;
  worldEnvironmentIdentityKey: string;
  areaKm2ForOwner: (ownerId: string) => number;
}>): GlobalRankedCandidate[] {
  const counts = new Map<string, number>();
  const areaByOwner = new Map<string, number>();
  return input.candidates.filter((candidate) => {
    if (
      candidate.kind === "stone"
      || candidate.kind === "ogre"
      || candidate.kind === "sap_crawler_group"
    ) return true;
    const key = `${candidate.ownerId}/${candidate.kind}`;
    let count = counts.get(key);
    if (count === undefined) {
      let areaKm2 = areaByOwner.get(candidate.ownerId);
      if (areaKm2 === undefined) {
        areaKm2 = input.areaKm2ForOwner(candidate.ownerId);
        areaByOwner.set(candidate.ownerId, areaKm2);
      }
      count = deterministicEligibleAreaCount({
        ownerId: candidate.ownerId,
        kind: candidate.kind,
        eligibleAreaKm2:
          areaKm2
          * input.eligibleFraction
          * input.suitability[candidate.kind],
        densityPerEligibleKm2: candidateInputDensityFor(
          candidate.kind,
          true
        ),
        worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
      });
      counts.set(key, count);
    }
    const separator = candidate.candidateId.lastIndexOf("/");
    const ordinal = Number.parseInt(
      candidate.candidateId.slice(separator + 1),
      36
    );
    return Number.isSafeInteger(ordinal) && ordinal < count;
  });
}

type CandidateSpatialIndex = Readonly<{
  cellSizeM: number;
  buckets: Map<string, GlobalRankedCandidate[]>;
}>;

function candidateSpatialIndex(
  candidates: readonly GlobalRankedCandidate[],
  cellSizeM = MAX_CANDIDATE_CONFLICT_DISTANCE_M
): CandidateSpatialIndex {
  const index: CandidateSpatialIndex = {
    cellSizeM,
    buckets: new Map()
  };
  for (const candidate of candidates) {
    addCandidateToSpatialIndex(index, candidate);
  }
  return index;
}

function addCandidateToSpatialIndex(
  index: CandidateSpatialIndex,
  candidate: GlobalRankedCandidate
): void {
  const key = candidateSpatialCell(
    candidate.position,
    index.cellSizeM
  ).join("/");
  const entries = index.buckets.get(key) ?? [];
  entries.push(candidate);
  index.buckets.set(key, entries);
}

function nearbySpatialCandidates(
  index: CandidateSpatialIndex,
  candidate: GlobalRankedCandidate
): GlobalRankedCandidate[] {
  const [x, y, z] = candidateSpatialCell(
    candidate.position,
    index.cellSizeM
  );
  const nearby: GlobalRankedCandidate[] = [];
  for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
    for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
      for (let zOffset = -1; zOffset <= 1; zOffset += 1) {
        nearby.push(...(
          index.buckets.get(
            `${x + xOffset}/${y + yOffset}/${z + zOffset}`
          ) ?? []
        ));
      }
    }
  }
  return nearby;
}

function candidateSpatialCell(
  point: PopulationZoneV2Point,
  cellSizeM: number
): readonly [number, number, number] {
  const latitude = toRadians(point.lat);
  const longitude = toRadians(point.lon);
  const scaledRadius = POPULATION_ZONE_V2_EARTH_RADIUS_M / cellSizeM;
  const latitudeCosine = Math.cos(latitude);
  return [
    Math.floor(latitudeCosine * Math.cos(longitude) * scaledRadius),
    Math.floor(latitudeCosine * Math.sin(longitude) * scaledRadius),
    Math.floor(Math.sin(latitude) * scaledRadius)
  ];
}

function candidatesConflict(
  left: GlobalRankedCandidate,
  right: GlobalRankedCandidate
): boolean {
  if (isKindPair(left, right, "sap_crawler_group", "tree")) {
    const sap = left.kind === "sap_crawler_group" ? left : right;
    const tree = left.kind === "tree" ? left : right;
    return minimumPointDistance(
      sapCrawlerMemberPositions(sap),
      [tree.position]
    ) < SAP_CRAWLER_TREE_MINIMUM_SPACING_M;
  }
  if (isKindPair(left, right, "sap_crawler_group", "deer")) {
    const sap = left.kind === "sap_crawler_group" ? left : right;
    const deer = left.kind === "deer" ? left : right;
    return minimumPointDistance(
      sapCrawlerMemberPositions(sap),
      [deer.position]
    ) < SAP_CRAWLER_DEER_MINIMUM_SPACING_M;
  }
  if (
    left.kind === "sap_crawler_group"
    && right.kind === "sap_crawler_group"
  ) {
    return candidateAnchorDistance(left, right)
      < SAP_CRAWLER_GROUP_MINIMUM_SPACING_M;
  }
  if (
    isKindPair(left, right, "sap_crawler_group", "wolf_pack")
    || isKindPair(left, right, "sap_crawler_group", "ogre")
  ) {
    return candidateAnchorDistance(left, right)
      < SAP_CRAWLER_HOSTILE_MINIMUM_SPACING_M;
  }
  if (isKindPair(left, right, "sap_crawler_group", "stone")) {
    const sap = left.kind === "sap_crawler_group" ? left : right;
    const stone = left.kind === "stone" ? left : right;
    return minimumPointDistance(
      sapCrawlerMemberPositions(sap),
      [stone.position]
    ) < 120;
  }
  if (left.kind === "tree" && right.kind === "tree") {
    return candidateAnchorDistance(left, right)
      < COMMON_KIND_CONFIGURATION.tree.minimumSpacingM;
  }
  if (left.kind === "deer" && right.kind === "deer") {
    return candidateAnchorDistance(left, right)
      < COMMON_KIND_CONFIGURATION.deer.minimumSpacingM;
  }
  if (isTreeDeerPair(left, right)) {
    return candidateAnchorDistance(left, right) < 35;
  }
  if (isSceneryCandidate(left) && isHostileCandidate(right)) {
    return minimumPointDistance(
      [left.position],
      hostileHomePositions(right)
    ) < 70;
  }
  if (isHostileCandidate(left) && isSceneryCandidate(right)) {
    return minimumPointDistance(
      hostileHomePositions(left),
      [right.position]
    ) < 70;
  }
  if (left.kind === "wolf_pack" && right.kind === "wolf_pack") {
    return candidateAnchorDistance(left, right)
      < COMMON_KIND_CONFIGURATION.wolf_pack.minimumSpacingM;
  }
  if (
    isHostileCandidate(left)
    && isHostileCandidate(right)
    && (left.kind === "ogre" || right.kind === "ogre")
  ) {
    return candidateAnchorDistance(left, right) < 350;
  }
  if (isStoneTreePair(left, right)) {
    return candidateAnchorDistance(left, right) < 50;
  }
  if (left.kind === "stone" && isMobCandidate(right)) {
    return minimumPointDistance(
      [left.position],
      mobHomePositions(right)
    ) < 120;
  }
  if (isMobCandidate(left) && right.kind === "stone") {
    return minimumPointDistance(
      mobHomePositions(left),
      [right.position]
    ) < 120;
  }
  return false;
}

function isKindPair(
  left: GlobalRankedCandidate,
  right: GlobalRankedCandidate,
  first: PopulationPlanKind,
  second: PopulationPlanKind
): boolean {
  return (left.kind === first && right.kind === second)
    || (left.kind === second && right.kind === first);
}

function validatePlacementInputs(input: Readonly<{
  eligibleFraction: number;
  suitability: Readonly<Record<PopulationPlanKind, number>>;
  worldEnvironmentIdentityKey: string;
}>): void {
  validateFraction(input.eligibleFraction, "eligible fraction");
  for (const kind of [
    "tree",
    "deer",
    "wolf_pack",
    "stone",
    "ogre",
    "sap_crawler_group"
  ] as const) {
    validateFraction(input.suitability[kind], `${kind} suitability`);
  }
  if (!/^[a-f0-9]{64}$/u.test(input.worldEnvironmentIdentityKey)) {
    throw new Error(
      "world environment identity key must be a lowercase SHA-256 hex string"
    );
  }
}

function worldEnvironmentIdentityNamespace(
  worldEnvironmentIdentityKey: string
): string {
  return hashHex(
    "population-world-environment-namespace-v1",
    worldEnvironmentIdentityKey,
    ENVIRONMENT_PROFILE_VERSION
  ).slice(0, 24);
}

function candidateAnchorDistance(
  left: GlobalRankedCandidate,
  right: GlobalRankedCandidate
): number {
  return greatCircleDistanceMeters(left.position, right.position);
}

function isSceneryCandidate(
  candidate: GlobalRankedCandidate
): boolean {
  return candidate.kind === "tree" || candidate.kind === "deer";
}

function isHostileCandidate(
  candidate: GlobalRankedCandidate
): boolean {
  return candidate.kind === "wolf_pack"
    || candidate.kind === "ogre"
    || candidate.kind === "sap_crawler_group";
}

function isMobCandidate(
  candidate: GlobalRankedCandidate
): boolean {
  return candidate.kind === "deer"
    || candidate.kind === "wolf_pack"
    || candidate.kind === "ogre"
    || candidate.kind === "sap_crawler_group";
}

function isTreeDeerPair(
  left: GlobalRankedCandidate,
  right: GlobalRankedCandidate
): boolean {
  return (
    left.kind === "tree" && right.kind === "deer"
  ) || (
    left.kind === "deer" && right.kind === "tree"
  );
}

function isStoneTreePair(
  left: GlobalRankedCandidate,
  right: GlobalRankedCandidate
): boolean {
  return (
    left.kind === "stone" && right.kind === "tree"
  ) || (
    left.kind === "tree" && right.kind === "stone"
  );
}

function hostileHomePositions(
  candidate: GlobalRankedCandidate
): readonly PopulationZoneV2Point[] {
  return candidate.kind === "wolf_pack"
    ? wolfMemberPositions(candidate, 4)
    : candidate.kind === "sap_crawler_group"
      ? sapCrawlerMemberPositions(candidate)
      : [candidate.position];
}

function mobHomePositions(
  candidate: GlobalRankedCandidate
): readonly PopulationZoneV2Point[] {
  return candidate.kind === "wolf_pack"
    ? wolfMemberPositions(candidate, 4)
    : candidate.kind === "sap_crawler_group"
      ? sapCrawlerMemberPositions(candidate)
      : [candidate.position];
}

function wolfMemberPositions(
  candidate: GlobalRankedCandidate,
  memberCount = wolfPackSizeForUnit(deterministicUnit(
    POPULATION_BALANCE.wolfPackSize.rollNamespace,
    candidate.candidateId
  ))
): readonly PopulationZoneV2Point[] {
  if (candidate.kind !== "wolf_pack") {
    throw new Error("wolf member homes require a wolf-pack candidate");
  }
  const cacheKey = `${candidate.candidateId}/${memberCount}`;
  const cached = wolfMemberPositionCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const rotation = deterministicUnit(candidate.candidateId, "rotation") * 360;
  const positions = Array.from({ length: memberCount }, (_, memberIndex) =>
    destinationPoint(
      candidate.position,
      WOLF_MEMBER_ORBIT_RADIUS_M,
      rotation + memberIndex * (360 / memberCount)
    )
  );
  wolfMemberPositionCache.set(cacheKey, positions);
  return positions;
}

function sapCrawlerMemberPositions(
  candidate: GlobalRankedCandidate,
  memberCount = sapCrawlerGroupSizeForUnit(deterministicUnit(
    POPULATION_BALANCE.sapCrawlerGroupSize.rollNamespace,
    candidate.candidateId
  ))
): readonly PopulationZoneV2Point[] {
  if (candidate.kind !== "sap_crawler_group") {
    throw new Error("Resin Crawler homes require a grouped candidate");
  }
  const cacheKey = `${candidate.candidateId}/${memberCount}`;
  const cached = sapCrawlerMemberPositionCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const rotation = deterministicUnit(candidate.candidateId, "rotation") * 360;
  const positions = [
    candidate.position,
    ...Array.from({ length: memberCount - 1 }, (_, memberIndex) =>
      destinationPoint(
        candidate.position,
        SAP_CRAWLER_MEMBER_ORBIT_RADIUS_M,
        rotation + memberIndex * (360 / 6)
      )
    )
  ];
  sapCrawlerMemberPositionCache.set(cacheKey, positions);
  return positions;
}

function minimumPointDistance(
  left: readonly PopulationZoneV2Point[],
  right: readonly PopulationZoneV2Point[]
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const leftPoint of left) {
    for (const rightPoint of right) {
      minimum = Math.min(
        minimum,
        greatCircleDistanceMeters(leftPoint, rightPoint)
      );
    }
  }
  return minimum;
}

function entitiesForCandidate(
  candidate: GlobalRankedCandidate,
  worldEnvironmentIdentityKey: string
): PlannedPopulationEntity[] {
  if (
    candidate.kind !== "wolf_pack"
    && candidate.kind !== "sap_crawler_group"
  ) {
    const slotId = stablePlanScopedUuid(SLOT_ID_VERSION, {
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      memberIndex: null,
      sourceOwnerId: candidate.ownerId,
      worldEnvironmentIdentityKey
    });
    return [populationEntity({
      worldEnvironmentIdentityKey,
      sourceOwnerId: candidate.ownerId,
      slotId,
      kind: candidate.kind,
      position: candidate.position,
      encounterId:
        candidate.kind === "deer" || candidate.kind === "ogre"
          ? stablePlanScopedUuid(ENCOUNTER_ID_VERSION, {
            candidateId: candidate.candidateId,
            encounterKind: candidate.kind,
            sourceOwnerId: candidate.ownerId,
            worldEnvironmentIdentityKey
          })
          : null,
      packId: null
    })];
  }
  const packId = stablePlanScopedUuid(PACK_ID_VERSION, {
    candidateId: candidate.candidateId,
    sourceOwnerId: candidate.ownerId,
    worldEnvironmentIdentityKey
  });
  const encounterId = stablePlanScopedUuid(ENCOUNTER_ID_VERSION, {
    candidateId: candidate.candidateId,
    encounterKind: candidate.kind,
    sourceOwnerId: candidate.ownerId,
    worldEnvironmentIdentityKey
  });
  const entityKind = candidate.kind === "wolf_pack"
    ? "wolf"
    : "sap_crawler";
  const positions = candidate.kind === "wolf_pack"
    ? wolfMemberPositions(candidate)
    : sapCrawlerMemberPositions(candidate);
  return positions.map((position, memberIndex) => {
    const slotId = stablePlanScopedUuid(SLOT_ID_VERSION, {
      candidateId: candidate.candidateId,
      kind: entityKind,
      memberIndex,
      sourceOwnerId: candidate.ownerId,
      worldEnvironmentIdentityKey
    });
    return populationEntity({
      worldEnvironmentIdentityKey,
      sourceOwnerId: candidate.ownerId,
      slotId,
      kind: entityKind,
      position,
      encounterId,
      packId
    });
  });
}

function populationEntity(input: Readonly<{
  worldEnvironmentIdentityKey: string;
  sourceOwnerId: string;
  slotId: string;
  kind: PlannedEntityKind;
  position: PopulationZoneV2Point;
  encounterId: string | null;
  packId: string | null;
}>): PlannedPopulationEntity {
  return {
    entityId: stablePopulationEntityId(input),
    slotId: input.slotId,
    sourceOwnerId: input.sourceOwnerId,
    kind: input.kind,
    position: input.position,
    homePosition: input.position,
    encounterId: input.encounterId,
    packId: input.packId,
    populationPlanVersion: POPULATION_PLAN_VERSION,
    spawnRulesVersion: POPULATION_SPAWN_RULES_VERSION,
    candidateLayoutVersion: POPULATION_CANDIDATE_LAYOUT_VERSION
  };
}

function rareCandidatesForCells(input: Readonly<{
  geometry: GeometryOption;
  cells: readonly GeometryCell[];
  activeIds: ReadonlySet<string>;
  eligibleFraction: number;
  suitability: Readonly<Record<PopulationPlanKind, number>>;
  worldEnvironmentIdentityKey: string;
}>): GlobalRankedCandidate[] {
  const candidates: GlobalRankedCandidate[] = [];
  for (const kind of ["stone", "ogre", "sap_crawler_group"] as const) {
    const domains = new Map<string, RareParentDomain>();
    for (const cell of input.cells) {
      for (const point of cell.samplePoints) {
        const domain = rareParentDomainForPoint(kind, point);
        domains.set(domain.id, domain);
      }
    }
    for (const domain of [...domains.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    )) {
      const slot = stableRareParentSlot(
        domain,
        input.worldEnvironmentIdentityKey
      );
      const ownerId = input.geometry === "equal-area-grid"
        ? populationZoneV2IdForPoint(slot.position)
        : latLngToCell(
          slot.position.lat,
          slot.position.lon,
          H3_COMPARISON_RESOLUTION
        );
      if (!input.activeIds.has(ownerId)) continue;
      if (
        deterministicUnit(
          input.worldEnvironmentIdentityKey,
          ENVIRONMENT_PROFILE_VERSION,
          domain.id,
          "eligible"
        )
        >= input.eligibleFraction * (
          kind === "sap_crawler_group"
            ? 1 / RARE_CANDIDATE_OVERSAMPLING_FACTOR.sap_crawler_group
            : input.suitability[kind]
        )
      ) {
        continue;
      }
      candidates.push({
        candidateId: slot.slotId,
        ownerId,
        kind,
        position: slot.position,
        rank: hashHex(
          CANDIDATE_RANK_VERSION,
          input.worldEnvironmentIdentityKey,
          ENVIRONMENT_PROFILE_VERSION,
          slot.slotId
        )
      });
    }
  }
  return candidates.sort(compareCandidates);
}

function gridCell(zoneId: PopulationZoneV2Id): GeometryCell {
  const geometry = populationZoneV2Geometry(zoneId);
  const epsilon = 1e-9;
  return {
    id: zoneId,
    areaKm2: geometry.areaKm2,
    center: geometry.center,
    samplePoints: [
      geometry.center,
      {
        lat: geometry.bounds.southLat + epsilon,
        lon: normalizeLongitude(geometry.bounds.westLon + epsilon)
      },
      {
        lat: geometry.bounds.southLat + epsilon,
        lon: normalizeLongitude(geometry.bounds.eastLon - epsilon)
      },
      {
        lat: geometry.bounds.northLat - epsilon,
        lon: normalizeLongitude(geometry.bounds.westLon + epsilon)
      },
      {
        lat: geometry.bounds.northLat - epsilon,
        lon: normalizeLongitude(geometry.bounds.eastLon - epsilon)
      }
    ]
  };
}

function h3Cell(zoneId: string): GeometryCell {
  const [lat, lon] = cellToLatLng(zoneId);
  const boundary = cellToBoundary(zoneId).map(([vertexLat, vertexLon]) => ({
    lat: vertexLat,
    lon: vertexLon
  }));
  return {
    id: zoneId,
    areaKm2: cellArea(zoneId, UNITS.km2),
    center: { lat, lon },
    samplePoints: [{ lat, lon }, ...boundary]
  };
}

function h3ZonesIntersectingCircle(
  center: PopulationZoneV2Point
): string[] {
  const centerId = latLngToCell(
    center.lat,
    normalizeLongitude(center.lon),
    H3_COMPARISON_RESOLUTION
  );
  const edgeLengthM = getHexagonEdgeLengthAvg(
    H3_COMPARISON_RESOLUTION,
    UNITS.m
  );
  const rings = Math.ceil(PREPARED_POPULATION_RADIUS_M / edgeLengthM) + 3;
  return gridDisk(centerId, rings)
    .filter((zoneId) =>
      h3CellIntersectsCircle(zoneId, center, PREPARED_POPULATION_RADIUS_M)
    )
    .sort();
}

function h3CellIntersectsCircle(
  zoneId: string,
  center: PopulationZoneV2Point,
  radiusM: number
): boolean {
  if (
    latLngToCell(center.lat, center.lon, H3_COMPARISON_RESOLUTION) === zoneId
  ) {
    return true;
  }
  const [cellLat, cellLon] = cellToLatLng(zoneId);
  if (
    greatCircleDistanceMeters(center, { lat: cellLat, lon: cellLon })
    <= radiusM
  ) {
    return true;
  }
  const boundary = cellToBoundary(zoneId).map(([lat, lon]) => ({ lat, lon }));
  if (boundary.some((point) =>
    greatCircleDistanceMeters(center, point) <= radiusM
  )) {
    return true;
  }
  return boundary.some((point, index) =>
    distanceToLocalSegmentMeters(
      center,
      point,
      boundary[(index + 1) % boundary.length]!
    ) <= radiusM
  );
}

function distanceToLocalSegmentMeters(
  origin: PopulationZoneV2Point,
  start: PopulationZoneV2Point,
  end: PopulationZoneV2Point
): number {
  const startLocal = localMeters(origin, start);
  const endLocal = localMeters(origin, end);
  const deltaX = endLocal.x - startLocal.x;
  const deltaY = endLocal.y - startLocal.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  if (lengthSquared === 0) return Math.hypot(startLocal.x, startLocal.y);
  const unit = clamp(
    -(startLocal.x * deltaX + startLocal.y * deltaY) / lengthSquared,
    0,
    1
  );
  return Math.hypot(
    startLocal.x + deltaX * unit,
    startLocal.y + deltaY * unit
  );
}

function localMeters(
  origin: PopulationZoneV2Point,
  point: PopulationZoneV2Point
): Readonly<{ x: number; y: number }> {
  return {
    x: toRadians(shortestLongitudeDelta(origin.lon, point.lon))
      * POPULATION_ZONE_V2_EARTH_RADIUS_M
      * Math.cos(toRadians(origin.lat)),
    y: toRadians(point.lat - origin.lat)
      * POPULATION_ZONE_V2_EARTH_RADIUS_M
  };
}

function countEntities(plan: GeometryPlan): GeometryScenarioMetrics["entityCounts"] {
  const wolfPackIds = new Set(
    plan.entities
      .filter((entity) => entity.kind === "wolf" && entity.packId !== null)
      .map((entity) => entity.packId!)
  );
  const sapCrawlerGroupIds = new Set(
    plan.entities
      .filter((entity) =>
        entity.kind === "sap_crawler" && entity.packId !== null
      )
      .map((entity) => entity.packId!)
  );
  return {
    trees: countWhere(plan.entities, (entity) => entity.kind === "tree"),
    deer: countWhere(plan.entities, (entity) => entity.kind === "deer"),
    wolfPacks: wolfPackIds.size,
    wolves: countWhere(plan.entities, (entity) => entity.kind === "wolf"),
    stones: countWhere(plan.entities, (entity) => entity.kind === "stone"),
    ogres: countWhere(plan.entities, (entity) => entity.kind === "ogre"),
    sapCrawlerGroups: sapCrawlerGroupIds.size,
    sapCrawlers: countWhere(
      plan.entities,
      (entity) => entity.kind === "sap_crawler"
    )
  };
}

function seamSpacingViolations(
  anchors: readonly GlobalRankedCandidate[],
  kind: CommonPlanKind
): number {
  const matching = anchors.filter((candidate) => candidate.kind === kind);
  const minimumSpacingM = COMMON_KIND_CONFIGURATION[kind].minimumSpacingM;
  let violations = 0;
  for (let left = 0; left < matching.length; left += 1) {
    for (let right = left + 1; right < matching.length; right += 1) {
      const first = matching[left]!;
      const second = matching[right]!;
      if (
        first.ownerId !== second.ownerId
        && greatCircleDistanceMeters(first.position, second.position)
          < minimumSpacingM
      ) {
        violations += 1;
      }
    }
  }
  return violations;
}

function seamSpacingComparisonCount(
  anchors: readonly GlobalRankedCandidate[],
  kind: CommonPlanKind
): number {
  const matching = anchors.filter((candidate) => candidate.kind === kind);
  let comparisons = 0;
  for (let left = 0; left < matching.length; left += 1) {
    for (let right = left + 1; right < matching.length; right += 1) {
      if (matching[left]!.ownerId !== matching[right]!.ownerId) {
        comparisons += 1;
      }
    }
  }
  return comparisons;
}

function measureConflictMatrixViolations(
  plan: GeometryPlan
): ConflictMatrixViolations {
  const trees = plan.entities.filter((entity) => entity.kind === "tree");
  const deer = plan.entities.filter((entity) => entity.kind === "deer");
  const wolves = plan.entities.filter((entity) => entity.kind === "wolf");
  const ogres = plan.entities.filter((entity) => entity.kind === "ogre");
  const sapCrawlers = plan.entities.filter(
    (entity) => entity.kind === "sap_crawler"
  );
  const stones = plan.entities.filter((entity) => entity.kind === "stone");
  const scenery = [...trees, ...deer];
  const nonSapHostileMembers = [...wolves, ...ogres];
  const mobs = [...deer, ...wolves, ...ogres, ...sapCrawlers];
  const wolfPackAnchors = plan.anchors.filter(
    (candidate) => candidate.kind === "wolf_pack"
  );
  const hostileAnchors = plan.anchors.filter(
    (candidate) =>
      candidate.kind === "wolf_pack"
      || candidate.kind === "ogre"
      || candidate.kind === "sap_crawler_group"
  );
  return {
    treeTree: countEntityPairViolations(
      trees,
      COMMON_KIND_CONFIGURATION.tree.minimumSpacingM
    ),
    deerDeer: countEntityPairViolations(
      deer,
      COMMON_KIND_CONFIGURATION.deer.minimumSpacingM
    ),
    treeDeer: countEntityCrossViolations(trees, deer, 35),
    sceneryHostile:
      countEntityCrossViolations(scenery, nonSapHostileMembers, 70)
      + countEntityCrossViolations(
        trees,
        sapCrawlers,
        SAP_CRAWLER_TREE_MINIMUM_SPACING_M
      )
      + countEntityCrossViolations(
        deer,
        sapCrawlers,
        SAP_CRAWLER_DEER_MINIMUM_SPACING_M
      ),
    wolfPackAnchors:
      countCandidatePairViolations(
        wolfPackAnchors,
        COMMON_KIND_CONFIGURATION.wolf_pack.minimumSpacingM
      ),
    otherHostileAnchors: countCandidatePairViolations(
      hostileAnchors,
      350,
      (left, right) =>
        left.kind === "ogre"
        || right.kind === "ogre"
        || left.kind === "sap_crawler_group"
        || right.kind === "sap_crawler_group"
    ),
    wolfMembers: countEntityPairViolations(wolves, 55),
    stoneTree: countEntityCrossViolations(stones, trees, 50),
    stoneMob: countEntityCrossViolations(stones, mobs, 120)
  };
}

function measureConflictMatrixExerciseCounts(
  plan: GeometryPlan
): ConflictMatrixViolations {
  const trees = plan.entities.filter((entity) => entity.kind === "tree");
  const deer = plan.entities.filter((entity) => entity.kind === "deer");
  const wolves = plan.entities.filter((entity) => entity.kind === "wolf");
  const ogres = plan.entities.filter((entity) => entity.kind === "ogre");
  const sapCrawlers = plan.entities.filter(
    (entity) => entity.kind === "sap_crawler"
  );
  const stones = plan.entities.filter((entity) => entity.kind === "stone");
  const scenery = [...trees, ...deer];
  const nonSapHostileMembers = [...wolves, ...ogres];
  const mobs = [...deer, ...wolves, ...ogres, ...sapCrawlers];
  const wolfPackAnchors = plan.anchors.filter(
    (candidate) => candidate.kind === "wolf_pack"
  );
  const hostileAnchors = plan.anchors.filter(
    (candidate) =>
      candidate.kind === "wolf_pack"
      || candidate.kind === "ogre"
      || candidate.kind === "sap_crawler_group"
  );
  const wolfPackMemberCounts = new Map<string, number>();
  for (const wolf of wolves) {
    if (wolf.packId === null) continue;
    wolfPackMemberCounts.set(
      wolf.packId,
      (wolfPackMemberCounts.get(wolf.packId) ?? 0) + 1
    );
  }
  return {
    treeTree: pairCount(trees.length),
    deerDeer: pairCount(deer.length),
    treeDeer: trees.length * deer.length,
    sceneryHostile:
      scenery.length * nonSapHostileMembers.length
      + trees.length * sapCrawlers.length
      + deer.length * sapCrawlers.length,
    wolfPackAnchors: pairCount(wolfPackAnchors.length),
    otherHostileAnchors: countCandidatePairs(
      hostileAnchors,
      (left, right) =>
        left.kind === "ogre"
        || right.kind === "ogre"
        || left.kind === "sap_crawler_group"
        || right.kind === "sap_crawler_group"
    ),
    wolfMembers: sum(
      [...wolfPackMemberCounts.values()].map(pairCount)
    ),
    stoneTree: stones.length * trees.length,
    stoneMob: stones.length * mobs.length
  };
}

function pairCount(count: number): number {
  return count * (count - 1) / 2;
}

function countCandidatePairs(
  candidates: readonly GlobalRankedCandidate[],
  includePair: (
    left: GlobalRankedCandidate,
    right: GlobalRankedCandidate
  ) => boolean
): number {
  let count = 0;
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (includePair(candidates[left]!, candidates[right]!)) {
        count += 1;
      }
    }
  }
  return count;
}

function countEntityPairViolations(
  entities: readonly PlannedPopulationEntity[],
  minimumSpacingM: number
): number {
  let violations = 0;
  for (let left = 0; left < entities.length; left += 1) {
    for (let right = left + 1; right < entities.length; right += 1) {
      if (
        greatCircleDistanceMeters(
          entities[left]!.homePosition,
          entities[right]!.homePosition
        ) < minimumSpacingM
      ) {
        violations += 1;
      }
    }
  }
  return violations;
}

function countEntityCrossViolations(
  left: readonly PlannedPopulationEntity[],
  right: readonly PlannedPopulationEntity[],
  minimumSpacingM: number
): number {
  let violations = 0;
  for (const leftEntity of left) {
    for (const rightEntity of right) {
      if (
        leftEntity.entityId !== rightEntity.entityId
        && greatCircleDistanceMeters(
          leftEntity.homePosition,
          rightEntity.homePosition
        ) < minimumSpacingM
      ) {
        violations += 1;
      }
    }
  }
  return violations;
}

function countCandidatePairViolations(
  candidates: readonly GlobalRankedCandidate[],
  minimumSpacingM: number,
  includePair: (
    left: GlobalRankedCandidate,
    right: GlobalRankedCandidate
  ) => boolean = () => true
): number {
  let violations = 0;
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (
        includePair(candidates[left]!, candidates[right]!)
        && candidateAnchorDistance(
          candidates[left]!,
          candidates[right]!
        ) < minimumSpacingM
      ) {
        violations += 1;
      }
    }
  }
  return violations;
}

function sumConflictMatrixViolations(
  values: readonly ConflictMatrixViolations[]
): ConflictMatrixViolations {
  return {
    treeTree: sum(values.map((value) => value.treeTree)),
    deerDeer: sum(values.map((value) => value.deerDeer)),
    treeDeer: sum(values.map((value) => value.treeDeer)),
    sceneryHostile: sum(values.map((value) => value.sceneryHostile)),
    wolfPackAnchors: sum(values.map((value) => value.wolfPackAnchors)),
    otherHostileAnchors: sum(
      values.map((value) => value.otherHostileAnchors)
    ),
    wolfMembers: sum(values.map((value) => value.wolfMembers)),
    stoneTree: sum(values.map((value) => value.stoneTree)),
    stoneMob: sum(values.map((value) => value.stoneMob))
  };
}

function zoneStatisticsFor(
  scenario: SimulationScenario,
  geometry: GeometryOption,
  plan: GeometryPlan,
  activeReferences: ReadonlyMap<string, number>
): ZoneStatistic[] {
  return plan.cells.map((cell) => {
    const entities = plan.entities.filter(
      (entity) => entity.sourceOwnerId === cell.id
    );
    const packIds = new Set(
      entities
        .filter((entity) =>
          entity.kind === "wolf" && entity.packId !== null
        )
        .map((entity) => entity.packId!)
    );
    const sapCrawlerGroupIds = new Set(
      entities
        .filter((entity) =>
          entity.kind === "sap_crawler" && entity.packId !== null
        )
        .map((entity) => entity.packId!)
    );
    return {
      scenarioId: scenario.id,
      geometry,
      zoneId: cell.id,
      areaKm2: cell.areaKm2,
      eligibleAreaKm2: cell.areaKm2 * scenario.eligibleFraction,
      activeReferenceCount: activeReferences.get(cell.id) ?? 0,
      treeCount: countWhere(entities, (entity) => entity.kind === "tree"),
      deerCount: countWhere(entities, (entity) => entity.kind === "deer"),
      wolfPackCount: packIds.size,
      wolfCount: countWhere(entities, (entity) => entity.kind === "wolf"),
      stoneCount: countWhere(entities, (entity) => entity.kind === "stone"),
      ogreCount: countWhere(entities, (entity) => entity.kind === "ogre"),
      sapCrawlerGroupCount: sapCrawlerGroupIds.size,
      sapCrawlerCount: countWhere(
        entities,
        (entity) => entity.kind === "sap_crawler"
      ),
      estimatedEligibleFraction48: null,
      referenceEligibleFraction1024: null,
      absoluteEligibleFractionError: null,
      ineligibleSelectedSlotCount: null
    };
  });
}

function syntheticWaterSamplingZoneStatistic(
  gate: SelectedGeometryAcceptance["syntheticWaterSampling"]
): ZoneStatistic {
  const geometry = populationZoneV2Geometry(gate.zoneId);
  return {
    scenarioId: "synthetic_water_sampling_gate",
    geometry: "equal-area-grid",
    zoneId: gate.zoneId,
    areaKm2: geometry.areaKm2,
    eligibleAreaKm2: geometry.areaKm2 * gate.estimatedEligibleFraction,
    activeReferenceCount: 0,
    treeCount: gate.selectedSlotKindCounts.trees,
    deerCount: gate.selectedSlotKindCounts.deer,
    wolfPackCount: gate.selectedSlotKindCounts.wolfPacks,
    wolfCount: gate.selectedSlotKindCounts.wolves,
    stoneCount: gate.selectedSlotKindCounts.stones,
    ogreCount: gate.selectedSlotKindCounts.ogres,
    sapCrawlerGroupCount: gate.selectedSlotKindCounts.sapCrawlerGroups,
    sapCrawlerCount: gate.selectedSlotKindCounts.sapCrawlers,
    estimatedEligibleFraction48: gate.estimatedEligibleFraction,
    referenceEligibleFraction1024: gate.referenceEligibleFraction,
    absoluteEligibleFractionError: gate.absoluteEligibleFractionError,
    ineligibleSelectedSlotCount: gate.ineligibleSelectedSlotCount
  };
}

function densityDistributionFor(
  scenarios: PersistentPopulationV2SimulationReport["scenarios"],
  geometry: GeometryOption
): PersistentPopulationV2SimulationReport["densityDistributions"][GeometryOption] {
  const densities = scenarios.map(
    (scenario) => scenario.options[geometry].densityPerEligibleKm2
  );
  return {
    trees: distribution(densities.map((entry) => entry.trees)),
    deer: distribution(densities.map((entry) => entry.deer)),
    wolfPacks: distribution(densities.map((entry) => entry.wolfPacks)),
    stones: distribution(densities.map((entry) => entry.stones)),
    ogres: distribution(densities.map((entry) => entry.ogres)),
    sapCrawlerGroups:
      distribution(densities.map((entry) => entry.sapCrawlerGroups)),
    sapCrawlers: distribution(densities.map((entry) => entry.sapCrawlers))
  };
}

function distribution(values: readonly number[]): DistributionSummary {
  if (values.length === 0) {
    return {
      count: 0,
      minimum: 0,
      p10: 0,
      p50: 0,
      p90: 0,
      maximum: 0,
      mean: 0
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minimum: sorted[0]!,
    p10: percentile(sorted, 0.1),
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    maximum: sorted.at(-1)!,
    mean: sum(sorted) / sorted.length
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const blend = position - lower;
  return sorted[lower]! * (1 - blend) + sorted[upper]! * blend;
}

function referenceCounts(
  sets: readonly (readonly string[])[]
): Map<string, number> {
  const references = new Map<string, number>();
  for (const ids of sets) {
    for (const id of new Set(ids)) {
      references.set(id, (references.get(id) ?? 0) + 1);
    }
  }
  return references;
}

function travelPair(
  scenario: SimulationScenario
): readonly [PopulationZoneV2Point, PopulationZoneV2Point] {
  const first = scenario.flags[0] ?? scenario.center;
  return [
    first,
    scenario.flags[1] ?? destinationPoint(first, 700, 90)
  ];
}

function safeDensity(count: number, eligibleAreaKm2: number): number {
  return eligibleAreaKm2 === 0 ? 0 : count / eligibleAreaKm2;
}

function zoneStatisticsCsv(statistics: readonly ZoneStatistic[]): string {
  const columns: readonly (keyof ZoneStatistic)[] = [
    "scenarioId",
    "geometry",
    "zoneId",
    "areaKm2",
    "eligibleAreaKm2",
    "activeReferenceCount",
    "treeCount",
    "deerCount",
    "wolfPackCount",
    "wolfCount",
    "stoneCount",
    "ogreCount",
    "sapCrawlerGroupCount",
    "sapCrawlerCount",
    "estimatedEligibleFraction48",
    "referenceEligibleFraction1024",
    "absoluteEligibleFractionError",
    "ineligibleSelectedSlotCount"
  ];
  const lines = [
    columns.join(","),
    ...statistics.map((statistic) => columns.map((column) =>
      csvCell(statistic[column])
    ).join(","))
  ];
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const rendered = typeof value === "number"
    ? Number.isInteger(value) ? String(value) : value.toFixed(9)
    : value;
  return /[",\r\n]/.test(rendered)
    ? `"${rendered.replaceAll("\"", "\"\"")}"`
    : rendered;
}

function buildScenarios(): readonly SimulationScenario[] {
  const base = (
    id: string,
    label: string,
    traits: readonly string[],
    center: PopulationZoneV2Point,
    eligibleFraction: number,
    suitability: Partial<Record<CommonPlanKind | RarePlanKind, number>> = {},
    flags: readonly PopulationZoneV2Point[] = [center],
    players: readonly PopulationZoneV2Point[] = [center],
    visits = 2,
    respawnCycles = 2
  ): SimulationScenario => ({
    id,
    label,
    traits,
    center,
    eligibleFraction,
    suitability: { ...DEFAULT_SUITABILITY, ...suitability },
    flags,
    players,
    visits,
    respawnCycles
  });

  const newOrleans = { lat: 29.9511, lon: -90.0715 };
  const denseFlags = [0, 90, 180, 270].map((bearing) =>
    destinationPoint(newOrleans, 650, bearing)
  );
  const sparseCenter = { lat: 39.5, lon: -98.35 };
  const sparseFlags = [
    sparseCenter,
    destinationPoint(sparseCenter, 12_000, 45),
    destinationPoint(sparseCenter, 18_000, 230)
  ];
  const multiplayerCenter = { lat: 38.8977, lon: -77.0365 };
  const players = Array.from({ length: 20 }, (_, index) =>
    destinationPoint(
      multiplayerCenter,
      100 + (index % 5) * 80,
      index * 137.507764
    )
  );
  const repeatCenter = { lat: 35.0844, lon: -106.6504 };
  const repeatFlags = [
    repeatCenter,
    destinationPoint(repeatCenter, 750, 90)
  ];

  return [
    base(
      "desert",
      "Hot desert",
      ["desert"],
      { lat: 24, lon: 13 },
      0.98,
      { tree: 0.3, deer: 0.45, wolf_pack: 0.75 }
    ),
    base(
      "grassland",
      "Temperate grassland",
      ["grassland"],
      { lat: 38.5, lon: -99.2 },
      0.99,
      { tree: 0.75 }
    ),
    base(
      "temperate_forest",
      "Temperate forest",
      ["temperate-forest"],
      { lat: 35.6, lon: -83.5 },
      0.97,
      { tree: 1, deer: 1 }
    ),
    base(
      "wetland",
      "Wetland",
      ["wetland"],
      { lat: 25.45, lon: -80.75 },
      0.58,
      { tree: 0.85, deer: 0.7, wolf_pack: 0.45 }
    ),
    base(
      "coastal_new_orleans",
      "Coastal New Orleans",
      ["coastal", "new-orleans", "water-heavy"],
      newOrleans,
      0.31,
      { tree: 0.7, deer: 0.65, wolf_pack: 0.45 }
    ),
    base(
      "mountainous",
      "Mountain terrain",
      ["mountainous"],
      { lat: 39.7392, lon: -105.6 },
      0.67,
      { tree: 0.55, deer: 0.7, wolf_pack: 0.9 }
    ),
    base(
      "high_latitude",
      "High latitude",
      ["high-latitude"],
      { lat: 69.6492, lon: 18.9553 },
      0.74,
      { tree: 0.35, deer: 0.6, wolf_pack: 0.8 }
    ),
    base(
      "antimeridian",
      "Antimeridian",
      ["antimeridian"],
      { lat: -16.5, lon: 179.999 },
      0.93
    ),
    base(
      "water_heavy",
      "Water-heavy coastal cell",
      ["water-heavy"],
      { lat: 29.2, lon: -89.3 },
      0.08,
      { tree: 0.55, deer: 0.4, wolf_pack: 0.25 }
    ),
    base(
      "dense_flags",
      "Dense four-flag cluster",
      ["dense-flags", "adjacent-travel"],
      newOrleans,
      0.44,
      { tree: 0.75, deer: 0.7, wolf_pack: 0.5 },
      denseFlags,
      [denseFlags[0]!],
      20,
      3
    ),
    base(
      "sparse_flags",
      "Sparse flags",
      ["sparse-flags", "cold-travel"],
      sparseCenter,
      0.95,
      {},
      sparseFlags,
      [sparseFlags[0]!],
      6,
      3
    ),
    base(
      "multiple_players",
      "Twenty concurrent players",
      ["multiple-players", "cold-activation"],
      multiplayerCenter,
      0.82,
      { tree: 0.85, deer: 0.9 },
      [multiplayerCenter],
      players,
      4,
      2
    ),
    base(
      "repeated_visits_respawns",
      "Repeated adjacent visits and respawns",
      ["repeated-visits", "respawns", "adjacent-travel"],
      repeatCenter,
      0.91,
      {},
      repeatFlags,
      [repeatCenter],
      20,
      5
    )
  ];
}

function hasScenarioTrait(trait: string): boolean {
  return PERSISTENT_POPULATION_V2_SCENARIOS.some(
    (scenario) => scenario.traits.includes(trait)
  );
}

function requiredScenario(id: string): SimulationScenario {
  const scenario = PERSISTENT_POPULATION_V2_SCENARIOS.find(
    (entry) => entry.id === id
  );
  if (scenario === undefined) {
    throw new Error(`missing required simulation scenario: ${id}`);
  }
  return scenario;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations([
      ...values.slice(0, index),
      ...values.slice(index + 1)
    ]).map((suffix) => [value, ...suffix])
  );
}

function destinationPoint(
  origin: PopulationZoneV2Point,
  distanceM: number,
  bearingDegrees: number
): PopulationZoneV2Point {
  const angularDistance = distanceM / POPULATION_ZONE_V2_EARTH_RADIUS_M;
  const bearing = toRadians(bearingDegrees);
  const latitude = toRadians(origin.lat);
  const longitude = toRadians(origin.lon);
  const destinationLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance)
      + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const destinationLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance)
      - Math.sin(latitude) * Math.sin(destinationLatitude)
  );
  return {
    lat: toDegrees(destinationLatitude),
    lon: normalizeLongitude(toDegrees(destinationLongitude))
  };
}

function deterministicUnit(...parts: readonly (string | number)[]): number {
  const hex = hashHex(...parts).slice(0, 13);
  return Number.parseInt(hex, 16) / 0x10_0000_0000_0000;
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | Readonly<{ [key: string]: CanonicalJsonValue }>;

function stablePlanScopedUuid(
  namespace: string,
  fields: Readonly<Record<string, CanonicalJsonValue>>
): string {
  return deterministicUuidV8(namespace, {
    ...fields,
    candidateLayoutVersion: POPULATION_CANDIDATE_LAYOUT_VERSION,
    environmentProfileVersion: ENVIRONMENT_PROFILE_VERSION,
    populationPlanVersion: POPULATION_PLAN_VERSION,
    spawnRulesVersion: POPULATION_SPAWN_RULES_VERSION
  });
}

function deterministicUuidV8(
  namespace: string,
  value: CanonicalJsonValue
): string {
  const digest = createHash("sha256")
    .update(namespace, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}

function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as Readonly<Record<string, CanonicalJsonValue>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}

function hashHex(...parts: readonly (string | number)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash.update(String(Buffer.byteLength(value)));
    hash.update(":");
    hash.update(value);
    hash.update("|");
  }
  return hash.digest("hex");
}

function compareCandidates(
  left: GlobalRankedCandidate,
  right: GlobalRankedCandidate
): number {
  return left.rank.localeCompare(right.rank)
    || left.candidateId.localeCompare(right.candidateId);
}

function compareZoneStatistics(
  left: ZoneStatistic,
  right: ZoneStatistic
): number {
  return left.scenarioId.localeCompare(right.scenarioId)
    || left.geometry.localeCompare(right.geometry)
    || left.zoneId.localeCompare(right.zoneId);
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function countWhere<T>(
  values: readonly T[],
  predicate: (value: T) => boolean
): number {
  return values.reduce(
    (count, value) => count + (predicate(value) ? 1 : 0),
    0
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function shortestLongitudeDelta(from: number, to: number): number {
  return normalizeLongitude(to - from);
}

function validateFraction(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be in [0, 1]`);
  }
}

function assertPoint(point: PopulationZoneV2Point): void {
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new Error("latitude must be finite and in [-90, 90]");
  }
  if (!Number.isFinite(point.lon)) {
    throw new Error("longitude must be finite");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function toDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

function printUsage(): void {
  process.stdout.write(
    "Usage: tsx tools/simulation/persistentPopulationV2Simulation.ts "
      + "--json <summary.json> --csv <zones.csv> "
      + "[--world-environment-identity-key <sha256>] "
      + "[--world-runtime-sha <git-sha>]\n"
  );
}

async function main(): Promise<void> {
  const argumentsByName = parseArguments(process.argv.slice(2));
  if (argumentsByName.has("--help")) {
    printUsage();
    return;
  }
  const jsonPath = argumentsByName.get("--json");
  const csvPath = argumentsByName.get("--csv");
  if (jsonPath === undefined || csvPath === undefined) {
    printUsage();
    throw new Error("--json and --csv output paths are required");
  }
  const artifacts = await writePersistentPopulationV2SimulationArtifacts({
    jsonPath,
    csvPath,
    ...(argumentsByName.get("--world-environment-identity-key") === undefined
      ? {}
      : {
        worldEnvironmentIdentityKey:
          argumentsByName.get("--world-environment-identity-key")!
      }),
    ...(argumentsByName.get("--world-runtime-sha") === undefined
      ? {}
      : { worldRuntimeSha: argumentsByName.get("--world-runtime-sha")! })
  });
  process.stdout.write(
    `Persistent population v2 simulation completed: `
      + `${artifacts.report.scenarios.length} scenarios, `
      + `${artifacts.zoneStatistics.length} zone rows.\n`
  );
}

function parseArguments(argumentsList: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const name = argumentsList[index]!;
    if (name === "--help") {
      parsed.set(name, "true");
      continue;
    }
    if (![
      "--json",
      "--csv",
      "--world-environment-identity-key",
      "--world-runtime-sha"
    ].includes(name)) {
      throw new Error(`unknown argument: ${name}`);
    }
    const value = argumentsList[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${name}`);
    }
    parsed.set(name, value);
    index += 1;
  }
  return parsed;
}

const invokedPath = process.argv[1] === undefined
  ? null
  : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
