import {
  POPULATION_BALANCE,
  POPULATION_DENSITY_MULTIPLIERS,
  POPULATION_DENSITY_REVISION,
  legacySapCrawlerGroupSizeForUnit,
  wolfPackSizeForUnit
} from "@ash-atlas/shared";

import {
  greatCircleDistanceMeters,
  normalizeLongitude,
  POPULATION_ZONE_V2_EARTH_RADIUS_M,
  type PopulationZoneV2Geometry,
  type PopulationZoneV2Id,
  type PopulationZoneV2Point,
  populationZoneV2Geometry,
  populationZoneV2Halo,
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle
} from "./populationZonesV2Geometry.js";
import type {
  PopulationZoneV2Habitat,
  PopulationZoneV2HabitatCandidateSite,
  PopulationZoneV2HabitatWeights,
  PopulationZoneV2SuppressionClass
} from "./populationV2HabitatTypes.js";
import {
  POPULATION_V2_ENCOUNTER_SURFACES,
  populationV2EncounterSurface,
  type PopulationV2EncounterSurface,
  type PopulationV2SurfaceAuthority
} from "./populationV2SurfaceTypes.js";
import type {
  WorldEnvironmentCandidateSlot,
  WorldEnvironmentCellProfile
} from "./gameplayEnvironmentProfiles.js";
import { ENVIRONMENT_PROFILE_VERSION } from "./gameplayEnvironmentProfileVersions.js";
import {
  type CanonicalJsonValue,
  canonicalJson,
  deterministicUnit,
  deterministicUuidV8,
  hashPartsHex,
  POPULATION_CANDIDATE_LAYOUT_VERSION,
  permanentMineKindForSlot,
  permanentPopulationStoneIdentity,
  type PopulationZoneV2PlanIdentity,
  populationZoneV2PlanId,
  populationZoneV2PlanIdentity,
  sha256Hex,
  stablePlanScopedUuid
} from "./populationZonesV2Identity.js";
import { populationV2MobRegistry } from "./populationV2MobRegistry.js";
import {
  populationV2SpacingConflict,
  populationV2SpacingRule,
  type PopulationV2SpacingClass
} from "./populationV2MobSpacing.js";
import {
  oceanSulfurDomainsIntersectingZone,
  stableOceanSulfurDomainSlot
} from "./oceanSulfurPlacement.js";

export {
  POPULATION_CANDIDATE_LAYOUT_VERSION,
  POPULATION_PLAN_VERSION,
  POPULATION_RESPAWN_POLICY_VERSION,
  POPULATION_SPAWN_RULES_VERSION,
  POPULATION_STONE_PLACEMENT_VERSION
} from "./populationZonesV2Identity.js";
export type {
  PopulationZoneV2Habitat,
  PopulationZoneV2HabitatCandidateSite,
  PopulationZoneV2HabitatWeights,
  PopulationZoneV2SuppressionClass
} from "./populationV2HabitatTypes.js";

export type PopulationZoneV2PlanKind =
  | "tree"
  | "flax"
  | "deer"
  | "wolf_pack"
  | "stone"
  | "ogre"
  | "sap_crawler_group";
export type PopulationZoneV2EntityKind = string;

export function isPermanentMineEntityKind(
  kind: string
): kind is "stone" | "coal" | "iron" {
  return kind === "stone" || kind === "coal" || kind === "iron";
}

export function permanentMineArchetype(
  kind: "stone" | "coal" | "iron"
): "stone_mine" | "coal_mine" | "iron_mine" {
  return `${kind}_mine`;
}

export type PopulationZoneV2HabitatFacts = Readonly<{
  isLand: boolean;
  isSaltwater: boolean;
  isCoastalLand: boolean;
  isRiverbank?: boolean;
  isLakeshore?: boolean;
  insideMajorLake: boolean;
  waterKind?: "ocean" | "lake" | "river" | "inland_water" | null;
  surfaceAuthority?: PopulationV2SurfaceAuthority | null;
  isCoastal: boolean | null;
  elevationBand: string | null;
  terrainClass: string | null;
  landCoverClass: string | null;
  biomeId: string | null;
  biomeName: string | null;
  ecoregionId: string | null;
  ecoregionName: string | null;
  spawnProfileKey: string;
  sourceCellId?: string;
  candidateSlotVersion?: string;
  candidateSlots?: readonly WorldEnvironmentCandidateSlot[];
}>;

export type PopulationZoneV2HabitatSample = Readonly<{
  sampleId: string;
  sampleKey?: string;
  position: PopulationZoneV2Point;
  areaWeightKm2: number;
  placementEligible?: boolean;
  placementTags?: readonly string[];
}>;

export type PopulationZoneV2HabitatEstimate = Readonly<{
  status: "ready" | "retryable-missing-facts";
  habitat: PopulationZoneV2Habitat;
  samples: readonly PopulationZoneV2HabitatSample[];
  missingSampleIds: readonly string[];
}>;

export type PopulationZoneV2PlanSlot = Readonly<{
  slotId: string;
  entityId: string;
  candidateId: string;
  entityKind: PopulationZoneV2EntityKind;
  archetype: string;
  encounterId: string | null;
  packId: string | null;
  packMemberIndex: number | null;
  position: PopulationZoneV2Point;
  anchor: PopulationZoneV2Point;
  environmentSnapshot: Readonly<Record<string, CanonicalJsonValue>>;
  suppressionClass: PopulationZoneV2SuppressionClass;
}>;

export type GeneratedPopulationZoneV2Plan = Readonly<{
  identity: PopulationZoneV2PlanIdentity;
  planId: string;
  worldPipelineSha: string;
  geometry: PopulationZoneV2Geometry;
  habitat: PopulationZoneV2Habitat;
  slots: readonly PopulationZoneV2PlanSlot[];
  contentHash: string;
  sapCrawlerDiagnostics?: PopulationZoneV2SapCrawlerPlanningDiagnostics;
}>;

export type PopulationZoneV2SapCrawlerPlanningDiagnostics = Readonly<{
  allocatedCandidates: number;
  noEligibleClusterCandidates: number;
  insufficientValidSiteCandidates: number;
  conflictRejectedCandidates: number;
  finalPlannedGroups: number;
  finalPlannedMembers: number;
  placementShortfallGroups: number;
}>;

export type PopulationZoneV2PlanGenerationTiming = Readonly<{
  candidateProcessingMs: number;
  deterministicSelectionMs: number;
  serializationConstructionMs: number;
  totalMs: number;
}>;

export type PopulationZoneV2PlanGenerationInput = Readonly<{
  outputZoneIds: readonly PopulationZoneV2Id[];
  worldEnvironmentIdentityKey: string;
  worldPipelineSha: string;
  environmentProfileVersion?: string;
  nonStoneGenerationKey?: string | undefined;
  nonStoneGenerationKeyForZone?: (
    zoneId: PopulationZoneV2Id
  ) => string | undefined;
  nonStoneConflictKeysForZone?: (
    zoneId: PopulationZoneV2Id
  ) => readonly string[];
  includeLegacySapCrawler?: boolean;
  habitatForZone: (
    zoneId: PopulationZoneV2Id
  ) => PopulationZoneV2Habitat;
  captureTiming?: (timing: PopulationZoneV2PlanGenerationTiming) => void;
}>;

export type PopulationZoneV2GenerationSlots = Readonly<{
  generationId: string;
  generationNumber: number;
  slots: readonly PopulationZoneV2PlanSlot[];
  plannedNonStoneCount: number;
  shortfallByKind: Readonly<Record<
    "tree" | "flax" | "deer" | "wolf_pack" | "sap_crawler_group",
    number
  >>;
}>;

export type PopulationZoneV2GenerationReconciliation = Readonly<{
  slotsToInsert: readonly PopulationZoneV2PlanSlot[];
  plannedNonStoneCount: number;
  partialSapCrawlerCandidateIds: readonly string[];
  shortfallByKind: Readonly<Record<
    "tree" | "flax" | "deer" | "wolf_pack" | "sap_crawler_group",
    number
  >>;
}>;

export type PopulationZoneV2RankedCandidate = Readonly<{
  candidateId: string;
  ownerId: PopulationZoneV2Id;
  kind: PopulationZoneV2PlanKind;
  position: PopulationZoneV2Point;
  rank: string;
  anchorSite: PopulationZoneV2HabitatCandidateSite;
  sites: readonly PopulationZoneV2HabitatCandidateSite[];
  siteAlternatives?: readonly (
    readonly PopulationZoneV2HabitatCandidateSite[]
  )[];
}>;

export type PopulationZoneV2RareParentDomain = Readonly<{
  id: string;
  kind: "stone" | "ogre" | "sap_crawler_group";
  center: PopulationZoneV2Point;
  areaKm2: number;
  bounds: Readonly<{
    southLat: number;
    northLat: number;
    westLon: number;
    eastLon: number;
  }>;
}>;

const FRACTIONAL_ROUNDING_VERSION = "eligible-area-fractional-round-v1";
const HABITAT_SAMPLE_VERSION = "population-habitat-area-samples-v1";
export const POPULATION_ZONE_V2_HABITAT_SAMPLE_COUNT = 48;
export const POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION =
  "population-zone-compact-samples-v3";
export const POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT = 48;
const RARE_PARENT_DOMAIN_VERSION = "rare-parent-equal-area-v2";
const ENTITY_ID_VERSION = "population-entity-id-v2";
const SLOT_ID_VERSION = "population-slot-id-v2";
const ENCOUNTER_ID_VERSION = "population-encounter-id-v2";
const PACK_ID_VERSION = "population-pack-id-v2";
const CANDIDATE_RANK_VERSION = "population-candidate-rank-v1";
const CANDIDATE_SITE_SELECTION_VERSION =
  "population-profile-candidate-site-selection-v3-riverbank-lakeshore";
const NONSTONE_GENERATION_ID_VERSION =
  "population-nonstone-generation-id-v1";
const SAP_CRAWLER_GENERATION_CANDIDATE_VERSION =
  "population-generation-sap-crawler-template-candidate-v1";
const SAP_CRAWLER_GENERATION_SLOT_VERSION =
  "population-generation-sap-crawler-template-slot-v1";
const SAP_CRAWLER_GENERATION_ENTITY_VERSION =
  "population-generation-sap-crawler-template-entity-v1";
const SAP_CRAWLER_GENERATION_ENCOUNTER_VERSION =
  "population-generation-sap-crawler-template-encounter-v1";
const SAP_CRAWLER_GENERATION_PACK_VERSION =
  "population-generation-sap-crawler-template-pack-v1";
const RARE_ELIGIBLE_AREA_SELECTION_VERSION =
  "population-rare-eligible-area-selection-v1";
const CANDIDATE_LOOKUP_HALO_M = 1_250;
// Dense hard-core layouts need a larger deterministic candidate pool to
// approach their configured target without weakening spacing authority.
const HIGH_LOAD_EXPANSION_CANDIDATE_POWER = 1.25;
const MAX_CANDIDATE_SITES_PER_ZONE = 512;
const MAX_RARE_GEOMETRY_CACHE_ENTRIES = 4_096;
const MAX_CONSERVATIVE_HABITAT_CACHE_ENTRIES = 1_024;
const MAX_SYNTHETIC_CANDIDATE_SITE_CACHE_ENTRIES = 256;
const MAX_INTERSECTING_ZONE_CACHE_ENTRIES = 16_384;
const MAX_WORLD_ENVIRONMENT_NAMESPACE_CACHE_ENTRIES = 32;
const WOLF_MEMBER_MAX_ANCHOR_DISTANCE_M = 100;
const WOLF_MEMBER_MINIMUM_SPACING_M = 55;
const WOLF_PACK_MAX_MEMBER_COUNT = 4;
export const SAP_CRAWLER_TREE_MINIMUM_SPACING_M =
  populationV2SpacingRule(
    "small_hostile_pack",
    "scenery_tree"
  ).minimumDistanceM;
export const SAP_CRAWLER_DEER_MINIMUM_SPACING_M =
  populationV2SpacingRule(
    "small_hostile_pack",
    "passive_single"
  ).minimumDistanceM;
export const SAP_CRAWLER_GROUP_MINIMUM_SPACING_M =
  populationV2SpacingRule(
    "small_hostile_pack",
    "small_hostile_pack"
  ).minimumDistanceM;
export const SAP_CRAWLER_HOSTILE_MINIMUM_SPACING_M =
  populationV2SpacingRule(
    "small_hostile_pack",
    "hostile_pack"
  ).minimumDistanceM;
const rareParentDomainsByZone = new Map<
  string,
  readonly PopulationZoneV2RareParentDomain[]
>();
const conservativeHabitatByAuthority = new Map<
  string,
  PopulationZoneV2Habitat
>();
const syntheticCandidateSitesByAuthority = new Map<
  string,
  readonly PopulationZoneV2HabitatCandidateSite[]
>();
const intersectingZoneIdsByPosition = new Map<
  string,
  readonly PopulationZoneV2Id[]
>();
const worldEnvironmentNamespaceByIdentity = new Map<string, string>();
const rareParentHabitatPiecesByDomain = new Map<
  string,
  readonly Readonly<{
    zoneId: PopulationZoneV2Id;
    overlapAreaKm2: number;
  }>[]
>();

type SapCrawlerDiagnosticCandidate = Readonly<{
  zoneId: PopulationZoneV2Id;
  rejection: "no-eligible-cluster" | "insufficient-valid-sites" | null;
}>;

type SapCrawlerDiagnosticsCollector = Map<
  string,
  SapCrawlerDiagnosticCandidate
>;

type PreparedSapCrawlerCandidate = Readonly<{
  candidateId?: string;
  candidate?: PopulationZoneV2RankedCandidate;
  diagnostic?: SapCrawlerDiagnosticCandidate;
}>;

const COMMON_KIND_CONFIGURATION = POPULATION_BALANCE.common;

const RARE_PARENT_TARGET_AREA_KM2 = {
  stone: POPULATION_BALANCE.rare.stone.targetAreaKm2,
  ogre: POPULATION_BALANCE.rare.ogre.targetAreaKm2,
  sap_crawler_group: POPULATION_BALANCE.rare.sap_crawler_group.targetAreaKm2
} as const;

const RARE_CANDIDATE_OVERSAMPLING_FACTOR = {
  stone: POPULATION_BALANCE.rare.stone.candidateOversamplingFactor,
  ogre: POPULATION_BALANCE.rare.ogre.candidateOversamplingFactor,
  sap_crawler_group:
    POPULATION_BALANCE.rare.sap_crawler_group.candidateOversamplingFactor
} as const;

export async function estimatePopulationZoneV2Habitat(input: Readonly<{
  zoneId: PopulationZoneV2Id;
  worldEnvironmentIdentityKey: string;
  regionCode: string;
  sampleCount?: number;
  samples?: readonly PopulationZoneV2HabitatSample[];
  sampleVersion?: string;
  factsForPoint: (
    sample: PopulationZoneV2HabitatSample
  ) => PopulationZoneV2HabitatFacts | null
    | Promise<PopulationZoneV2HabitatFacts | null>;
}>): Promise<PopulationZoneV2HabitatEstimate> {
  const samples = input.samples
    ? [...input.samples]
    : populationZoneV2HabitatSamplePoints({
      zoneId: input.zoneId,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
      sampleCount: input.sampleCount
        ?? POPULATION_ZONE_V2_HABITAT_SAMPLE_COUNT
    });
  const sampleVersion = input.sampleVersion ?? HABITAT_SAMPLE_VERSION;
  const resolved = await Promise.all(samples.map(async (sample) => ({
    sample,
    facts: await input.factsForPoint(sample)
  })));
  const missingSampleIds = resolved
    .filter((entry) => entry.facts === null)
    .map((entry) => entry.sample.sampleId)
    .sort();
  const areas = {
    eligibleLandKm2: 0,
    treeKm2: 0,
    flaxKm2: 0,
    deerKm2: 0,
    wolfKm2: 0,
    stoneKm2: 0,
    ogreKm2: 0
  };
  const biomeCounts = new Map<string, number>();
  const surfaceAreaKm2: Record<PopulationV2EncounterSurface, number> = {
    land: 0,
    lake: 0,
    river: 0,
    ocean: 0
  };
  for (const { sample, facts } of resolved) {
    if (facts === null) continue;
    const weights = habitatWeights(facts);
    areas.eligibleLandKm2 += sample.areaWeightKm2 * weights.eligibleLand;
    areas.treeKm2 += sample.areaWeightKm2 * weights.tree;
    areas.flaxKm2 += sample.areaWeightKm2 * (weights.flax ?? 0);
    areas.deerKm2 += sample.areaWeightKm2 * weights.deer;
    areas.wolfKm2 += sample.areaWeightKm2 * weights.wolf;
    areas.stoneKm2 += sample.areaWeightKm2 * weights.stone;
    areas.ogreKm2 += sample.areaWeightKm2 * weights.ogre;
    const surface = populationV2EncounterSurface(facts);
    if (surface !== null) surfaceAreaKm2[surface] += sample.areaWeightKm2;
    const biome = normalizedEnvironmentText(
      facts.biomeId ?? facts.biomeName ?? facts.spawnProfileKey
    ) || "unknown";
    biomeCounts.set(biome, (biomeCounts.get(biome) ?? 0) + 1);
  }
  const candidateSites = habitatCandidateSitesFromResolvedSamples({
    zoneId: input.zoneId,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
    resolved
  });
  const totalAreaKm2 = populationZoneV2Geometry(input.zoneId).areaKm2;
  for (const key of Object.keys(areas) as Array<keyof typeof areas>) {
    areas[key] = clamp(areas[key], 0, totalAreaKm2);
  }
  for (const surface of POPULATION_V2_ENCOUNTER_SURFACES) {
    surfaceAreaKm2[surface] = clamp(
      surfaceAreaKm2[surface],
      0,
      totalAreaKm2
    );
  }
  const habitatSummary = {
    sampleVersion,
    sampleCount: samples.length,
    missingSampleCount: missingSampleIds.length,
    missingFactsAreZeroAndRetryable: true,
    candidateSiteSelectionVersion: CANDIDATE_SITE_SELECTION_VERSION,
    candidateSiteCount: candidateSites.length,
    worldProfileCandidateSiteCount: candidateSites.filter((site) =>
      site.source === "world-profile-candidate-slot"
    ).length,
    biomeSampleCounts: Object.fromEntries(
      [...biomeCounts.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
    eligibleLandFraction: safeFraction(
      areas.eligibleLandKm2,
      totalAreaKm2
    )
  } satisfies Readonly<Record<string, CanonicalJsonValue>>;
  const habitat: PopulationZoneV2Habitat = {
    regionCode: input.regionCode,
    ...areas,
    surfaceAreaKm2,
    habitatSummary,
    environmentSnapshot: {
      habitatSampleVersion: sampleVersion,
      habitatSampleCount: samples.length,
      candidateSiteSelectionVersion: CANDIDATE_SITE_SELECTION_VERSION,
      candidateSiteCount: candidateSites.length,
      biomeSampleCounts: habitatSummary.biomeSampleCounts,
      eligibleLandFraction: habitatSummary.eligibleLandFraction
    },
    candidateSites
  };
  return {
    status: missingSampleIds.length === 0
      ? "ready"
      : "retryable-missing-facts",
    habitat,
    samples,
    missingSampleIds
  };
}

export function populationZoneV3CompactHabitatSamplePoints(input: Readonly<{
  zoneId: PopulationZoneV2Id;
  worldEnvironmentIdentityKey: string;
}>): PopulationZoneV2HabitatSample[] {
  if (!/^[a-f0-9]{64}$/u.test(input.worldEnvironmentIdentityKey)) {
    throw new Error(
      "World environment identity key must be a lowercase SHA-256 hex string"
    );
  }
  const geometry = populationZoneV2Geometry(input.zoneId);
  const samples = new Map<string, Omit<PopulationZoneV2HabitatSample, "areaWeightKm2">>();
  const add = (
    role: string,
    position: PopulationZoneV2Point,
    placementEligible: boolean,
    placementTags: readonly string[] = []
  ): void => {
    const normalized = {
      lat: canonicalSampleCoordinate(clamp(position.lat, -90, 90)),
      lon: canonicalSampleCoordinate(normalizeLongitude(position.lon))
    };
    const sampleKey = hashPartsHex(
      POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION,
      input.worldEnvironmentIdentityKey,
      normalized.lat.toFixed(9),
      normalized.lon.toFixed(9),
      "population-compact-gameplay-environment-v3-riverbank-lakeshore"
    );
    if (samples.has(sampleKey)) return;
    samples.set(sampleKey, {
      sampleId: `${POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION}/${role}/${sampleKey.slice(0, 24)}`,
      sampleKey,
      position: normalized,
      placementEligible,
      placementTags: [...placementTags]
    });
  };

  for (const kind of ["stone", "ogre"] as const) {
    for (const domain of rareParentDomainsIntersectingZone(kind, input.zoneId)) {
      const slot = stablePopulationZoneV2RareParentSlot(
        domain,
        input.worldEnvironmentIdentityKey,
        POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION
      );
      if (populationZoneV2IdForPoint(slot.position) !== input.zoneId) continue;
      add(
        `rare/${kind}/${domain.id}`,
        slot.position,
        true,
        ["general", `rare:${kind}:${domain.id}`]
      );
    }
  }

  for (const domain of oceanSulfurDomainsIntersectingZone(input.zoneId)) {
    const slot = stableOceanSulfurDomainSlot(
      domain,
      input.worldEnvironmentIdentityKey
    );
    if (populationZoneV2IdForPoint(slot.position) !== input.zoneId) continue;
    add(
      `rare/sulfur/${domain.id}`,
      slot.position,
      true,
      ["general", `rare:sulfur:${domain.id}`]
    );
  }

  for (const [edge, latitudeUnit, longitudeUnit] of [
    ["south-1", 0, 0.25],
    ["south-2", 0, 0.75],
    ["north-1", 1, 0.25],
    ["north-2", 1, 0.75],
    ["west-1", 0.25, 0],
    ["west-2", 0.75, 0],
    ["east-1", 0.25, 1],
    ["east-2", 0.75, 1]
  ] as const) {
    add(
      `edge/${edge}`,
      pointAtZoneUnit(geometry, latitudeUnit, longitudeUnit),
      false,
      ["context-only"]
    );
  }

  for (const [clusterIndex, centerLatitudeUnit, centerLongitudeUnit] of [
    [0, 0.34, 0.34],
    [1, 0.66, 0.66]
  ] as const) {
    const clusterTag = `cluster:${clusterIndex.toString().padStart(2, "0")}`;
    add(
      `cluster/${clusterIndex}/anchor`,
      pointAtZoneUnit(geometry, centerLatitudeUnit, centerLongitudeUnit),
      true,
      ["general", "cluster-anchor", clusterTag]
    );
    for (const [member, latitudeOffset, longitudeOffset] of [
      [0, -0.065, 0],
      [1, 0.065, 0],
      [2, 0, -0.065],
      [3, 0, 0.065]
    ] as const) {
      add(
        `cluster/${clusterIndex}/member/${member}`,
        pointAtZoneUnit(
          geometry,
          centerLatitudeUnit + latitudeOffset,
          centerLongitudeUnit + longitudeOffset
        ),
        true,
        [
          "general",
          "cluster-member",
          "cluster-primary",
          clusterTag
        ]
      );
    }
  }

  let candidateIndex = 0;
  while (samples.size < POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT) {
    const latitudeUnit = 0.06 + 0.88 * deterministicUnit(
      POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION,
      input.worldEnvironmentIdentityKey,
      input.zoneId,
      candidateIndex,
      "latitude"
    );
    const longitudeUnit = 0.06 + 0.88 * deterministicUnit(
      POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION,
      input.worldEnvironmentIdentityKey,
      input.zoneId,
      candidateIndex,
      "longitude"
    );
    add(
      `interior/${candidateIndex.toString(36)}`,
      pointAtZoneUnit(geometry, latitudeUnit, longitudeUnit),
      true,
      ["general"]
    );
    candidateIndex += 1;
    if (candidateIndex > POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT * 4) {
      throw new Error("bounded population sample layout could not be completed");
    }
  }
  if (samples.size > POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT) {
    throw new Error(
      `bounded population sample layout exceeded ${POPULATION_ZONE_V3_COMPACT_SAMPLE_COUNT}`
    );
  }
  const areaSamples = [...samples.values()].filter((sample) =>
    sample.sampleId.includes("/interior/")
  );
  if (areaSamples.length === 0) {
    throw new Error("bounded population sample layout requires area samples");
  }
  const areaWeightKm2 = geometry.areaKm2 / areaSamples.length;
  return [...samples.values()].map((sample) => ({
    ...sample,
    areaWeightKm2: sample.sampleId.includes("/interior/")
      ? areaWeightKm2
      : 0
  })).sort((left, right) => left.sampleId.localeCompare(right.sampleId));
}

export function populationZoneV3ConservativeHabitat(input: Readonly<{
  zoneId: PopulationZoneV2Id;
  worldEnvironmentIdentityKey: string;
  regionCode?: string;
}>): PopulationZoneV2Habitat {
  const regionCode = input.regionCode ?? "bounded-context";
  const cacheKey = [
    input.worldEnvironmentIdentityKey,
    input.zoneId,
    regionCode
  ].join("\u0000");
  const cached = conservativeHabitatByAuthority.get(cacheKey);
  if (cached !== undefined) {
    conservativeHabitatByAuthority.delete(cacheKey);
    conservativeHabitatByAuthority.set(cacheKey, cached);
    return cached;
  }
  const geometry = populationZoneV2Geometry(input.zoneId);
  const samples = populationZoneV3CompactHabitatSamplePoints(input);
  const candidateSites = samples
    .filter((sample) => sample.placementEligible !== false)
    .map((sample) => syntheticSampleCandidateSite(sample, {
      isLand: true,
      isSaltwater: false,
      isCoastalLand: false,
      isRiverbank: false,
      isLakeshore: false,
      insideMajorLake: false,
      isCoastal: false,
      elevationBand: "unknown",
      terrainClass: "unknown",
      landCoverClass: "unknown",
      biomeId: "conservative-land",
      biomeName: "Conservative Land",
      ecoregionId: "conservative-land",
      ecoregionName: "Conservative Land",
      spawnProfileKey: "generic_land"
    }));
  const habitat: PopulationZoneV2Habitat = {
    regionCode,
    eligibleLandKm2: geometry.areaKm2,
    treeKm2: geometry.areaKm2,
    flaxKm2: geometry.areaKm2,
    deerKm2: geometry.areaKm2,
    wolfKm2: geometry.areaKm2,
    stoneKm2: geometry.areaKm2,
    ogreKm2: geometry.areaKm2,
    habitatSummary: {
      sampleVersion: POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION,
      sampleCount: samples.length,
      conservativeSeamContext: true
    },
    environmentSnapshot: {
      habitatSampleVersion: POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION,
      conservativeSeamContext: true
    },
    candidateSites
  };
  conservativeHabitatByAuthority.set(cacheKey, habitat);
  while (
    conservativeHabitatByAuthority.size
      > MAX_CONSERVATIVE_HABITAT_CACHE_ENTRIES
  ) {
    const oldest = conservativeHabitatByAuthority.keys().next().value;
    if (oldest === undefined) break;
    conservativeHabitatByAuthority.delete(oldest);
  }
  return habitat;
}

export function populationZoneV2HabitatSamplePoints(input: Readonly<{
  zoneId: PopulationZoneV2Id;
  worldEnvironmentIdentityKey: string;
  sampleCount?: number;
}>): PopulationZoneV2HabitatSample[] {
  if (!/^[a-f0-9]{64}$/u.test(input.worldEnvironmentIdentityKey)) {
    throw new Error(
      "World environment identity key must be a lowercase SHA-256 hex string"
    );
  }
  const sampleCount = input.sampleCount
    ?? POPULATION_ZONE_V2_HABITAT_SAMPLE_COUNT;
  if (!Number.isInteger(sampleCount) || sampleCount < 1) {
    throw new Error("population habitat sample count must be positive");
  }
  const [latitudeStrata, longitudeStrata] = closestFactorPair(sampleCount);
  const geometry = populationZoneV2Geometry(input.zoneId);
  const southSine = Math.sin(toRadians(geometry.bounds.southLat));
  const northSine = Math.sin(toRadians(geometry.bounds.northLat));
  const longitudeSpan = geometry.bounds.eastLon - geometry.bounds.westLon;
  const areaWeightKm2 = geometry.areaKm2 / sampleCount;
  const samples: PopulationZoneV2HabitatSample[] = [];
  for (let latitudeIndex = 0; latitudeIndex < latitudeStrata; latitudeIndex += 1) {
    for (
      let longitudeIndex = 0;
      longitudeIndex < longitudeStrata;
      longitudeIndex += 1
    ) {
      const index = latitudeIndex * longitudeStrata + longitudeIndex;
      const latitudeUnit = (
        latitudeIndex
        + deterministicUnit(
          HABITAT_SAMPLE_VERSION,
          input.worldEnvironmentIdentityKey,
          input.zoneId,
          index,
          "latitude"
        )
      ) / latitudeStrata;
      const longitudeUnit = (
        longitudeIndex
        + deterministicUnit(
          HABITAT_SAMPLE_VERSION,
          input.worldEnvironmentIdentityKey,
          input.zoneId,
          index,
          "longitude"
        )
      ) / longitudeStrata;
      samples.push({
        sampleId:
          `${HABITAT_SAMPLE_VERSION}/${input.zoneId}/`
          + `${sampleCount}/${index.toString(36)}`,
        position: {
          lat: toDegrees(Math.asin(
            southSine + (northSine - southSine) * latitudeUnit
          )),
          lon: normalizeLongitude(
            geometry.bounds.westLon + longitudeSpan * longitudeUnit
          )
        },
        areaWeightKm2
      });
    }
  }
  return samples;
}

export function populationZoneV2HabitatFactsFromProfile(
  profile: WorldEnvironmentCellProfile
): PopulationZoneV2HabitatFacts {
  const waterKind = profile.environmentProfile.waterKind ?? null;
  return {
    isLand: profile.isLand,
    isSaltwater: profile.isSaltwater,
    isCoastalLand: profile.environmentProfile.isCoastalLand,
    isRiverbank: profile.environmentProfile.isRiverbank,
    isLakeshore: profile.environmentProfile.isLakeshore,
    insideMajorLake: profile.insideMajorLake,
    waterKind,
    surfaceAuthority: waterKind === "river"
      ? profile.environmentProfile.riverSurface ?? null
      : waterKind === "lake"
        ? profile.environmentProfile.lakeSurface ?? null
        : waterKind === "ocean"
          ? profile.environmentProfile.oceanSurface ?? null
          : null,
    isCoastal: profile.isCoastal,
    elevationBand: profile.elevationBand,
    terrainClass: profile.terrainClass,
    landCoverClass: profile.landCoverClass,
    biomeId: profile.biomeId,
    biomeName: profile.biomeName,
    ecoregionId: profile.ecoregionId,
    ecoregionName: profile.ecoregionName,
    spawnProfileKey: profile.spawnProfileKey,
    sourceCellId: profile.cellId,
    candidateSlotVersion: profile.candidateSlotVersion,
    candidateSlots: profile.candidateSlots
  };
}

export function generatePopulationZoneV2Plan(
  input: Omit<PopulationZoneV2PlanGenerationInput, "outputZoneIds"> &
    Readonly<{ zoneId: PopulationZoneV2Id }>
): GeneratedPopulationZoneV2Plan {
  const plans = generatePopulationZonesV2Plans({
    ...input,
    outputZoneIds: [input.zoneId]
  });
  const plan = plans[0];
  if (plan === undefined) {
    throw new Error(`population plan was not generated for ${input.zoneId}`);
  }
  return plan;
}

export function generatePopulationZonesV2Plans(
  input: PopulationZoneV2PlanGenerationInput
): GeneratedPopulationZoneV2Plan[] {
  const generationStarted = performance.now();
  assertGenerationInput(input);
  const outputZoneIds = [...new Set(input.outputZoneIds)].sort();
  const habitatCache = new Map<PopulationZoneV2Id, PopulationZoneV2Habitat>();
  const habitatForZone = (zoneId: PopulationZoneV2Id) => {
    const cached = habitatCache.get(zoneId);
    if (cached !== undefined) return cached;
    const habitat = input.habitatForZone(zoneId);
    assertHabitat(zoneId, habitat);
    habitatCache.set(zoneId, habitat);
    return habitat;
  };
  const sapCrawlerDiagnostics = new Map<
    string,
    SapCrawlerDiagnosticCandidate
  >();
  const candidateProcessingStarted = performance.now();
  const candidates = globalRankedPopulationZoneV2Candidates({
    outputZoneIds,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
    environmentProfileVersion:
      input.environmentProfileVersion ?? ENVIRONMENT_PROFILE_VERSION,
    nonStoneGenerationKey: input.nonStoneGenerationKey,
    ...(input.nonStoneGenerationKeyForZone === undefined
      ? {}
      : {
          nonStoneGenerationKeyForZone:
            input.nonStoneGenerationKeyForZone
        }),
    ...(input.nonStoneConflictKeysForZone === undefined
      ? {}
      : {
          nonStoneConflictKeysForZone:
            input.nonStoneConflictKeysForZone
        }),
    ...(input.includeLegacySapCrawler === undefined
      ? {}
      : {
          includeLegacySapCrawler: input.includeLegacySapCrawler
        }),
    sapCrawlerDiagnostics,
    habitatForZone
  });
  const candidateProcessingMs = performance.now() - candidateProcessingStarted;
  const deterministicSelectionStarted = performance.now();
  for (const candidate of candidates) {
    if (candidate.kind !== "sap_crawler_group") continue;
    sapCrawlerDiagnostics.set(candidate.candidateId, {
      zoneId: candidate.ownerId,
      rejection: null
    });
  }
  const slotsByZone = new Map<PopulationZoneV2Id, PopulationZoneV2PlanSlot[]>();
  for (const candidate of candidates) {
    const identity = populationZoneV2PlanIdentity({
      zoneId: candidate.ownerId,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
      environmentProfileVersion:
        input.environmentProfileVersion ?? ENVIRONMENT_PROFILE_VERSION
    });
    const slots = slotsByZone.get(candidate.ownerId) ?? [];
    slots.push(...slotsForCandidate(
      candidate,
      identity,
      habitatForZone(candidate.ownerId).environmentSnapshot
    ));
    slotsByZone.set(candidate.ownerId, slots);
  }

  const deterministicSelectionMs = performance.now()
    - deterministicSelectionStarted;
  const serializationConstructionStarted = performance.now();
  const plans = outputZoneIds.map((zoneId) => {
    const identity = populationZoneV2PlanIdentity({
      zoneId,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
      environmentProfileVersion:
        input.environmentProfileVersion ?? ENVIRONMENT_PROFILE_VERSION
    });
    const geometry = populationZoneV2Geometry(zoneId);
    const sourceHabitat = habitatForZone(zoneId);
    const slots = (slotsByZone.get(zoneId) ?? [])
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    const planId = populationZoneV2PlanId(identity);
    const finalSapCrawlerCandidateIds = new Set(slots
      .filter((slot) => slot.entityKind === "sap_crawler")
      .map((slot) => slot.candidateId));
    const diagnosticCandidates = [...sapCrawlerDiagnostics.entries()]
      .filter(([, diagnostic]) => diagnostic.zoneId === zoneId);
    const allocatedCandidates = diagnosticCandidates.length;
    const finalPlannedGroups = finalSapCrawlerCandidateIds.size;
    const diagnostics: PopulationZoneV2SapCrawlerPlanningDiagnostics = {
      allocatedCandidates,
      noEligibleClusterCandidates: diagnosticCandidates.filter(
        ([, diagnostic]) =>
          diagnostic.rejection === "no-eligible-cluster"
      ).length,
      insufficientValidSiteCandidates: diagnosticCandidates.filter(
        ([, diagnostic]) =>
          diagnostic.rejection === "insufficient-valid-sites"
      ).length,
      conflictRejectedCandidates: diagnosticCandidates.filter(
        ([candidateId, diagnostic]) =>
          diagnostic.rejection === null
          && !finalSapCrawlerCandidateIds.has(candidateId)
      ).length,
      finalPlannedGroups,
      finalPlannedMembers: slots.filter((slot) =>
        slot.entityKind === "sap_crawler"
      ).length,
      placementShortfallGroups: Math.max(
        0,
        allocatedCandidates - finalPlannedGroups
      )
    };
    const habitat: PopulationZoneV2Habitat = {
      ...sourceHabitat,
      habitatSummary: {
        ...sourceHabitat.habitatSummary,
        sapCrawlerPlanning: diagnostics
      },
      candidateSites: habitatCandidateSitesForGeneration({
        geometry,
        habitat: sourceHabitat,
        worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
      })
    };
    return {
      identity,
      planId,
      worldPipelineSha: input.worldPipelineSha,
      geometry,
      habitat,
      slots,
      sapCrawlerDiagnostics: diagnostics,
      contentHash: populationZoneV2PlanContentHash({
        identity,
        planId,
        geometry,
        habitat,
        slots
      })
    };
  });
  input.captureTiming?.({
    candidateProcessingMs,
    deterministicSelectionMs,
    serializationConstructionMs:
      performance.now() - serializationConstructionStarted,
    totalMs: performance.now() - generationStarted
  });
  return plans;
}

export function populationZoneV2GenerationId(input: Readonly<{
  identity: PopulationZoneV2PlanIdentity;
  generationNumber: number;
}>): string {
  if (!Number.isSafeInteger(input.generationNumber) || input.generationNumber <= 0) {
    throw new Error("population generation number must be a positive safe integer");
  }
  return stablePlanScopedUuid(
    NONSTONE_GENERATION_ID_VERSION,
    input.identity,
    {
      generationNumber: input.generationNumber,
      zoneId: input.identity.zoneId
    }
  );
}

export function generatePopulationZoneV2GenerationSlots(input: Readonly<{
  template: GeneratedPopulationZoneV2Plan;
  generationId: string;
  generationNumber: number;
  neighborGenerationIdsByZone?: Readonly<
    Record<string, readonly string[]>
  >;
  neighborHabitatsByZone?: ReadonlyMap<
    PopulationZoneV2Id,
    PopulationZoneV2Habitat
  >;
  includeLegacySapCrawler?: boolean;
}>): PopulationZoneV2GenerationSlots {
  const expectedGenerationId = populationZoneV2GenerationId({
    identity: input.template.identity,
    generationNumber: input.generationNumber
  });
  if (input.generationId !== expectedGenerationId) {
    throw new Error("population generation ID does not match its authority");
  }
  const materializedSapCrawlerSlots =
    input.includeLegacySapCrawler === false
      ? []
      : materializeSapCrawlerTemplateGroups({
          templateSlots: input.template.slots,
          generationId: input.generationId,
          generationNumber: input.generationNumber
        });
  const generationPlan = generatePopulationZoneV2Plan({
    zoneId: input.template.identity.zoneId as PopulationZoneV2Id,
    worldEnvironmentIdentityKey:
      input.template.identity.worldEnvironmentIdentityKey,
    worldPipelineSha: input.template.worldPipelineSha,
    environmentProfileVersion:
      input.template.identity.environmentProfileVersion,
    nonStoneGenerationKeyForZone: (zoneId) =>
      zoneId === input.template.identity.zoneId
        ? input.generationId
        : input.neighborGenerationIdsByZone?.[zoneId]?.[0],
    nonStoneConflictKeysForZone: (zoneId) =>
      input.neighborGenerationIdsByZone?.[zoneId] ?? [],
    ...(input.includeLegacySapCrawler === undefined
      ? {}
      : { includeLegacySapCrawler: input.includeLegacySapCrawler }),
    habitatForZone: (zoneId) =>
      zoneId === input.template.identity.zoneId
        ? input.template.habitat
        : input.neighborHabitatsByZone?.get(zoneId)
          ?? populationZoneV3ConservativeHabitat({
            zoneId,
            worldEnvironmentIdentityKey:
              input.template.identity.worldEnvironmentIdentityKey
          })
  });
  const templateNonStone = input.template.slots.filter((slot) =>
    !isPermanentMineEntityKind(slot.entityKind)
  );
  const ogreBudget = templateNonStone.filter((slot) =>
    slot.entityKind === "ogre"
  ).length;
  const sapCrawlerGroupBudget = new Set(materializedSapCrawlerSlots
    .filter((slot) => slot.entityKind === "sap_crawler")
    .map((slot) => slot.candidateId)).size;
  const selected: PopulationZoneV2PlanSlot[] = [];
  for (const kind of ["tree", "flax", "deer"] as const) {
    const budget = templateNonStone.filter((slot) =>
      slot.entityKind === kind
    ).length;
    selected.push(...generationPlan.slots
      .filter((slot) => slot.entityKind === kind)
      .slice(0, budget));
  }
  const wolfPackBudget = new Set(templateNonStone
    .filter((slot) => slot.entityKind === "wolf")
    .map((slot) => slot.candidateId)).size;
  const generationWolfPacks = new Map<string, PopulationZoneV2PlanSlot[]>();
  for (const slot of generationPlan.slots) {
    if (slot.entityKind !== "wolf") continue;
    const pack = generationWolfPacks.get(slot.candidateId) ?? [];
    pack.push(slot);
    generationWolfPacks.set(slot.candidateId, pack);
  }
  selected.push(...[...generationWolfPacks.values()]
    .sort((left, right) =>
      left[0]!.candidateId.localeCompare(right[0]!.candidateId)
    )
    .slice(0, wolfPackBudget)
    .flat());
  selected.push(...generationPlan.slots
    .filter((slot) => slot.entityKind === "ogre")
    .slice(0, ogreBudget));
  selected.push(...materializedSapCrawlerSlots);
  const authoritativeSapGroups = populationSlotCandidateGroups(
    materializedSapCrawlerSlots
  );
  const spacingValidSelected = populationSlotCandidateGroups(selected)
    .filter((candidate) =>
      candidate.kind === "sap_crawler_group"
      || candidate.kind === "ogre"
      || !authoritativeSapGroups.some((sapGroup) =>
        populationPlacementCandidatesConflict(candidate, sapGroup)
      )
    )
    .flatMap((candidate) => candidate.slots);
  const selectedSapCrawlerGroupCount = new Set(selected
    .filter((slot) => slot.entityKind === "sap_crawler")
    .map((slot) => slot.candidateId)).size;
  const slots = spacingValidSelected.sort((left, right) =>
    left.entityId.localeCompare(right.entityId)
  );
  return {
    generationId: input.generationId,
    generationNumber: input.generationNumber,
    slots,
    plannedNonStoneCount: slots.length,
    shortfallByKind: {
      tree: 0,
      flax: 0,
      deer: 0,
      wolf_pack: 0,
      sap_crawler_group: Math.max(
        0,
        sapCrawlerGroupBudget - selectedSapCrawlerGroupCount
      )
    }
  };
}

export function materializeSapCrawlerTemplateGroups(input: Readonly<{
  templateSlots: readonly PopulationZoneV2PlanSlot[];
  generationId: string;
  generationNumber: number;
}>): PopulationZoneV2PlanSlot[] {
  if (input.generationId.length === 0) {
    throw new Error("Resin Crawler materialization requires a generation ID");
  }
  if (
    !Number.isSafeInteger(input.generationNumber)
    || input.generationNumber <= 0
  ) {
    throw new Error(
      "Resin Crawler materialization requires a positive generation number"
    );
  }
  const templateGroups = new Map<string, PopulationZoneV2PlanSlot[]>();
  for (const slot of input.templateSlots) {
    if (slot.entityKind !== "sap_crawler") continue;
    const group = templateGroups.get(slot.candidateId) ?? [];
    group.push(slot);
    templateGroups.set(slot.candidateId, group);
  }
  const materialized: PopulationZoneV2PlanSlot[] = [];
  for (const [templateCandidateId, unordered] of [...templateGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const template = [...unordered].sort((left, right) =>
      (left.packMemberIndex ?? -1) - (right.packMemberIndex ?? -1)
      || left.entityId.localeCompare(right.entityId)
    );
    assertCompleteSapCrawlerGroup(templateCandidateId, template);
    const generationCandidateId = `${templateCandidateId}/${hashPartsHex(
      SAP_CRAWLER_GENERATION_CANDIDATE_VERSION,
      input.generationId,
      input.generationNumber,
      templateCandidateId
    ).slice(0, 16)}`;
    const authority = {
      generationCandidateId,
      generationId: input.generationId,
      generationNumber: input.generationNumber,
      templateCandidateId
    };
    const encounterId = deterministicUuidV8(
      SAP_CRAWLER_GENERATION_ENCOUNTER_VERSION,
      authority
    );
    const packId = deterministicUuidV8(
      SAP_CRAWLER_GENERATION_PACK_VERSION,
      authority
    );
    for (const templateSlot of template) {
      const memberIndex = templateSlot.packMemberIndex!;
      const slotId = deterministicUuidV8(
        SAP_CRAWLER_GENERATION_SLOT_VERSION,
        { ...authority, memberIndex }
      );
      materialized.push({
        ...templateSlot,
        candidateId: generationCandidateId,
        encounterId,
        packId,
        slotId,
        entityId: deterministicUuidV8(
          SAP_CRAWLER_GENERATION_ENTITY_VERSION,
          { ...authority, memberIndex, slotId }
        )
      });
    }
  }
  return materialized.sort((left, right) =>
    left.entityId.localeCompare(right.entityId)
  );
}

export function reconcilePopulationZoneV2GenerationSlots(input: Readonly<{
  existingSlots: readonly PopulationZoneV2PlanSlot[];
  desiredSlots: readonly PopulationZoneV2PlanSlot[];
}>): PopulationZoneV2GenerationReconciliation {
  const existing = input.existingSlots.filter((slot) =>
    !isPermanentMineEntityKind(slot.entityKind)
  );
  const occupied = populationSlotCandidateGroups(existing);
  const desired = populationSlotCandidateGroups(input.desiredSlots);
  for (const candidate of desired) {
    if (
      candidate.kind === "sap_crawler_group"
      && !candidate.complete
    ) {
      throw new Error("desired Resin Crawler group is incomplete");
    }
  }
  const partialSapCrawlerCandidateIds = occupied
    .filter((candidate) =>
      candidate.kind === "sap_crawler_group" && !candidate.complete
    )
    .map((candidate) => candidate.candidateId)
    .sort();
  const existingSlotIds = new Set(existing.map((slot) => slot.slotId));
  const existingEntityIds = new Set(existing.map((slot) => slot.entityId));
  const existingEncounterIds = new Set(existing.flatMap((slot) =>
    slot.encounterId === null ? [] : [slot.encounterId]
  ));
  const existingPackIds = new Set(existing.flatMap((slot) =>
    slot.packId === null ? [] : [slot.packId]
  ));
  const occupiedCoordinates = new Set(existing.map((slot) =>
    populationCoordinateKey(slot.position)
  ));
  const targetCounts = {
    tree: countCandidateGroups(desired, "tree"),
    flax: countCandidateGroups(desired, "flax"),
    deer: countCandidateGroups(desired, "deer"),
    wolf_pack: countCandidateGroups(desired, "wolf_pack"),
    sap_crawler_group: countCandidateGroups(
      desired,
      "sap_crawler_group"
    )
  };
  const currentCounts = {
    tree: countCandidateGroups(occupied, "tree"),
    flax: countCandidateGroups(occupied, "flax"),
    deer: countCandidateGroups(occupied, "deer"),
    wolf_pack: countCandidateGroups(occupied, "wolf_pack"),
    sap_crawler_group: countCandidateGroups(
      occupied,
      "sap_crawler_group"
    )
  };
  const slotsToInsert: PopulationZoneV2PlanSlot[] = [];
  for (const candidate of desired) {
    if (
      candidate.kind === "ogre"
      || currentCounts[candidate.kind] >= targetCounts[candidate.kind]
      || candidate.slots.some((slot) =>
        existingSlotIds.has(slot.slotId)
        || existingEntityIds.has(slot.entityId)
        || occupiedCoordinates.has(populationCoordinateKey(slot.position))
        || (
          slot.encounterId !== null
          && existingEncounterIds.has(slot.encounterId)
        )
        || (slot.packId !== null && existingPackIds.has(slot.packId))
      )
      || occupied.some((entry) =>
        populationPlacementCandidatesConflict(entry, candidate)
      )
    ) {
      continue;
    }
    occupied.push(candidate);
    currentCounts[candidate.kind] += 1;
    for (const slot of candidate.slots) {
      existingSlotIds.add(slot.slotId);
      existingEntityIds.add(slot.entityId);
      occupiedCoordinates.add(populationCoordinateKey(slot.position));
      if (slot.encounterId !== null) {
        existingEncounterIds.add(slot.encounterId);
      }
      if (slot.packId !== null) existingPackIds.add(slot.packId);
      slotsToInsert.push(slot);
    }
  }
  return {
    slotsToInsert: slotsToInsert.sort((left, right) =>
      left.entityId.localeCompare(right.entityId)
    ),
    plannedNonStoneCount: existing.length + slotsToInsert.length,
    partialSapCrawlerCandidateIds,
    shortfallByKind: {
      tree: Math.max(0, targetCounts.tree - currentCounts.tree),
      flax: Math.max(0, targetCounts.flax - currentCounts.flax),
      deer: Math.max(0, targetCounts.deer - currentCounts.deer),
      wolf_pack: Math.max(0, targetCounts.wolf_pack - currentCounts.wolf_pack),
      sap_crawler_group: Math.max(
        0,
        targetCounts.sap_crawler_group - currentCounts.sap_crawler_group
      )
    }
  };
}

export function globalRankedPopulationZoneV2Candidates(input: Readonly<{
  outputZoneIds: readonly PopulationZoneV2Id[];
  worldEnvironmentIdentityKey: string;
  environmentProfileVersion?: string;
  baselineCommonDensity?: boolean;
  nonStoneGenerationKey?: string | undefined;
  nonStoneGenerationKeyForZone?: (
    zoneId: PopulationZoneV2Id
  ) => string | undefined;
  nonStoneConflictKeysForZone?: (
    zoneId: PopulationZoneV2Id
  ) => readonly string[];
  sapCrawlerDiagnostics?: SapCrawlerDiagnosticsCollector;
  includeLegacySapCrawler?: boolean;
  habitatForZone: (
    zoneId: PopulationZoneV2Id
  ) => PopulationZoneV2Habitat;
}>): PopulationZoneV2RankedCandidate[] {
  const environmentProfileVersion =
    input.environmentProfileVersion ?? ENVIRONMENT_PROFILE_VERSION;
  const outputZoneIds = [...new Set(input.outputZoneIds)].sort();
  const habitatByZone = new Map<PopulationZoneV2Id, PopulationZoneV2Habitat>();
  const candidateSitesByZone = new Map<
    PopulationZoneV2Id,
    readonly PopulationZoneV2HabitatCandidateSite[]
  >();
  const baselineCommonCandidateIds = new Set<string>();
  const preparedSapCrawlerCandidates = new Map<
    string,
    PreparedSapCrawlerCandidate
  >();
  const intersectingZonesByPosition = new Map<
    string,
    readonly PopulationZoneV2Id[]
  >();
  const intersectingZones = (position: PopulationZoneV2Point) => {
    const key = `${position.lat}\u0000${position.lon}`;
    let zoneIds = intersectingZonesByPosition.get(key);
    if (zoneIds === undefined) {
      zoneIds = intersectingZoneIdsByPosition.get(key);
      if (zoneIds === undefined) {
        zoneIds = populationZonesV2IntersectingCircle(
          position,
          CANDIDATE_LOOKUP_HALO_M
        );
        intersectingZoneIdsByPosition.set(key, zoneIds);
        while (
          intersectingZoneIdsByPosition.size
            > MAX_INTERSECTING_ZONE_CACHE_ENTRIES
        ) {
          const oldest = intersectingZoneIdsByPosition.keys().next().value;
          if (oldest === undefined) break;
          intersectingZoneIdsByPosition.delete(oldest);
        }
      }
      intersectingZonesByPosition.set(key, zoneIds);
    }
    return zoneIds;
  };
  const spacingInputByCandidate = new WeakMap<
    PopulationZoneV2RankedCandidate,
    ReturnType<typeof populationPlacementSpacingInput>
  >();
  const candidateConflicts = (
    left: PopulationZoneV2RankedCandidate,
    right: PopulationZoneV2RankedCandidate
  ) => {
    const spacingInput = (candidate: PopulationZoneV2RankedCandidate) => {
      let cached = spacingInputByCandidate.get(candidate);
      if (cached === undefined) {
        cached = populationPlacementSpacingInput(
          populationPlacementCandidate(candidate)
        );
        spacingInputByCandidate.set(candidate, cached);
      }
      return cached;
    };
    return populationV2SpacingConflict(
      spacingInput(left),
      spacingInput(right)
    );
  };
  const retainEnabledCandidates = (
    candidates: readonly PopulationZoneV2RankedCandidate[]
  ) => input.includeLegacySapCrawler === false
    ? candidates.filter((candidate) =>
        candidate.kind !== "sap_crawler_group"
      )
    : [...candidates];
  const rawDesiredOutput = retainEnabledCandidates(outputZoneIds.flatMap((zoneId) =>
    rawCandidatesForZones({
      zoneIds: [zoneId],
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
      environmentProfileVersion,
      nonStoneGenerationKey:
        input.nonStoneGenerationKeyForZone?.(zoneId)
        ?? input.nonStoneGenerationKey,
      habitatForZone: input.habitatForZone,
      habitatByZone,
      candidateSitesByZone,
      baselineCommonCandidateIds,
      preparedSapCrawlerCandidates,
      ...(input.sapCrawlerDiagnostics === undefined
        ? {}
        : { sapCrawlerDiagnostics: input.sapCrawlerDiagnostics })
    })
  ));
  const universeZoneIds = new Set<PopulationZoneV2Id>(outputZoneIds);
  for (const candidate of rawDesiredOutput) {
    for (const zoneId of intersectingZones(candidate.position)) {
      universeZoneIds.add(zoneId);
    }
  }
  const outputZoneIdSet = new Set(outputZoneIds);
  const haloZoneIds = [...universeZoneIds]
    .filter((zoneId) => !outputZoneIdSet.has(zoneId))
    .sort();
  const haloHabitatByZone = new Map<
    PopulationZoneV2Id,
    PopulationZoneV2Habitat
  >();
  const haloCandidateSitesByZone = new Map<
    PopulationZoneV2Id,
    readonly PopulationZoneV2HabitatCandidateSite[]
  >();
  const rawUniverse = retainEnabledCandidates([
    ...rawDesiredOutput,
    ...haloZoneIds.flatMap((zoneId) => {
      const configuredKeys = input.nonStoneConflictKeysForZone?.(zoneId)
        ?? [];
      const keys = configuredKeys.length > 0
        ? [...new Set(configuredKeys)].sort()
        : [
            input.nonStoneGenerationKeyForZone?.(zoneId)
            ?? input.nonStoneGenerationKey
          ];
      return keys.flatMap((nonStoneGenerationKey) =>
        rawCandidatesForZones({
          zoneIds: [zoneId],
          worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
          environmentProfileVersion,
          nonStoneGenerationKey,
          habitatForZone: input.habitatForZone,
          habitatByZone: haloHabitatByZone,
          candidateSitesByZone: haloCandidateSitesByZone,
          baselineCommonCandidateIds,
          preparedSapCrawlerCandidates
        })
      );
    })
  ]);
  const isBaselineCandidate = (candidate: PopulationZoneV2RankedCandidate) =>
    candidate.kind !== "tree"
    && candidate.kind !== "flax"
    && candidate.kind !== "deer"
    && candidate.kind !== "wolf_pack"
    || baselineCommonCandidateIds.has(candidate.candidateId);
  const rawBaselineDesiredOutput = rawDesiredOutput.filter(isBaselineCandidate);
  const rawBaselineUniverse = rawUniverse.filter(isBaselineCandidate);
  const baselineNonSapWinners = retainLocalRankWinners(
    rawBaselineUniverse.filter((candidate) =>
      candidate.kind !== "sap_crawler_group"
    ),
    rawBaselineUniverse.filter((candidate) =>
      candidate.kind !== "sap_crawler_group"
    ),
    intersectingZones,
    candidateConflicts
  );
  const universe = rawUniverse;
  const desiredOutput = rawDesiredOutput;
  const baselineUniverse = rawBaselineUniverse;
  const baselineDesiredOutput = rawBaselineDesiredOutput;
  const sapSelection = selectSapCrawlerCandidatesWithAlternatives(
    baselineUniverse.filter((candidate) =>
      candidate.kind === "sap_crawler_group"
    ),
    baselineNonSapWinners,
    intersectingZones,
    candidateConflicts
  );
  const baselineSapWinners = sapSelection.sapCandidates;
  const baselineWinners = [
    ...sapSelection.retainedHigherPriority,
    ...baselineSapWinners
  ].sort(compareCandidates);
  if (input.baselineCommonDensity === true) {
    const baselineDesiredIds = new Set(
      baselineDesiredOutput.map((candidate) => candidate.candidateId)
    );
    return baselineWinners.filter((candidate) =>
      baselineDesiredIds.has(candidate.candidateId)
      && outputZoneIdSet.has(candidate.ownerId)
    ).sort(compareCandidates);
  }
  const baselineCandidateIds = new Set(
    baselineUniverse.map((candidate) => candidate.candidateId)
  );
  const accepted = [...baselineWinners];
  const acceptedByOwner = new Map<
    PopulationZoneV2Id,
    PopulationZoneV2RankedCandidate[]
  >();
  for (const candidate of accepted) {
    const entries = acceptedByOwner.get(candidate.ownerId) ?? [];
    entries.push(candidate);
    acceptedByOwner.set(candidate.ownerId, entries);
  }
  const expansion = new Map<string, PopulationZoneV2RankedCandidate>();
  for (const candidate of universe) {
    if (!baselineCandidateIds.has(candidate.candidateId)) {
      expansion.set(candidate.candidateId, candidate);
    }
  }
  for (const candidate of [...expansion.values()].sort(compareCandidates)) {
    const conflicts = intersectingZones(candidate.position).some((ownerId) =>
      (acceptedByOwner.get(ownerId) ?? []).some((other) =>
        candidateConflicts(other, candidate)
      )
    );
    if (conflicts) continue;
    accepted.push(candidate);
    const entries = acceptedByOwner.get(candidate.ownerId) ?? [];
    entries.push(candidate);
    acceptedByOwner.set(candidate.ownerId, entries);
  }
  const desiredCandidateIds = new Set(
    desiredOutput.map((candidate) => candidate.candidateId)
  );
  return accepted.filter((candidate) =>
    desiredCandidateIds.has(candidate.candidateId)
    && outputZoneIdSet.has(candidate.ownerId)
  ).sort(compareCandidates);
}

function retainLocalRankWinners(
  output: readonly PopulationZoneV2RankedCandidate[],
  universe: readonly PopulationZoneV2RankedCandidate[],
  intersectingZones: (
    position: PopulationZoneV2Point
  ) => readonly PopulationZoneV2Id[],
  candidatesConflict: (
    left: PopulationZoneV2RankedCandidate,
    right: PopulationZoneV2RankedCandidate
  ) => boolean
): PopulationZoneV2RankedCandidate[] {
  const universeByOwner = new Map<
    PopulationZoneV2Id,
    PopulationZoneV2RankedCandidate[]
  >();
  for (const candidate of universe) {
    const candidates = universeByOwner.get(candidate.ownerId) ?? [];
    candidates.push(candidate);
    universeByOwner.set(candidate.ownerId, candidates);
  }
  return output.filter((candidate) => {
    for (const ownerId of intersectingZones(candidate.position)) {
      for (const other of universeByOwner.get(ownerId) ?? []) {
        if (
          other.candidateId !== candidate.candidateId
          && compareCandidates(other, candidate) < 0
          && candidatesConflict(other, candidate)
        ) {
          return false;
        }
      }
    }
    return true;
  }).sort(compareCandidates);
}

function selectSapCrawlerCandidatesWithAlternatives(
  candidates: readonly PopulationZoneV2RankedCandidate[],
  higherPriority: readonly PopulationZoneV2RankedCandidate[],
  intersectingZones: (
    position: PopulationZoneV2Point
  ) => readonly PopulationZoneV2Id[],
  candidatesConflict: (
    left: PopulationZoneV2RankedCandidate,
    right: PopulationZoneV2RankedCandidate
  ) => boolean
): Readonly<{
  sapCandidates: PopulationZoneV2RankedCandidate[];
  retainedHigherPriority: PopulationZoneV2RankedCandidate[];
}> {
  const acceptedByOwner = new Map<
    PopulationZoneV2Id,
    PopulationZoneV2RankedCandidate[]
  >();
  for (const candidate of higherPriority) {
    const entries = acceptedByOwner.get(candidate.ownerId) ?? [];
    entries.push(candidate);
    acceptedByOwner.set(candidate.ownerId, entries);
  }
  const accepted: PopulationZoneV2RankedCandidate[] = [];
  const displacedCommonCandidateIds = new Set<string>();
  for (const candidate of [...candidates].sort(compareCandidates)) {
    if (candidate.kind !== "sap_crawler_group") continue;
    const alternatives = candidate.siteAlternatives ?? [candidate.sites];
    let positioned = alternatives
      .map((alternative): PopulationZoneV2RankedCandidate => ({
        ...candidate,
        ownerId: populationZoneV2IdForPoint(alternative[0]!.position),
        position: alternative[0]!.position,
        anchorSite: alternative[0]!,
        sites: alternative
      }))
      .find((alternative) => {
        return !intersectingZones(alternative.position).some((ownerId) =>
          (acceptedByOwner.get(ownerId) ?? []).some((other) =>
            candidatesConflict(other, alternative)
          )
        );
      });
    if (positioned === undefined) {
      positioned = alternatives
        .map((alternative): PopulationZoneV2RankedCandidate => ({
          ...candidate,
          ownerId: populationZoneV2IdForPoint(alternative[0]!.position),
          position: alternative[0]!.position,
          anchorSite: alternative[0]!,
          sites: alternative
        }))
        .find((alternative) => {
          return !intersectingZones(alternative.position).some((ownerId) =>
            (acceptedByOwner.get(ownerId) ?? []).some((other) =>
              (
                other.kind === "stone"
                || other.kind === "ogre"
                || other.kind === "sap_crawler_group"
              )
              && candidatesConflict(other, alternative)
            )
          );
        });
      if (positioned !== undefined) {
        for (const [ownerId, ownerCandidates] of acceptedByOwner) {
          const retained = ownerCandidates.filter((other) => {
            const displaced = (
              other.kind === "tree"
              || other.kind === "flax"
              || other.kind === "deer"
              || other.kind === "wolf_pack"
            ) && candidatesConflict(other, positioned!);
            if (displaced) {
              displacedCommonCandidateIds.add(other.candidateId);
            }
            return !displaced;
          });
          acceptedByOwner.set(ownerId, retained);
        }
      }
    }
    if (positioned === undefined) continue;
    accepted.push(positioned);
    const ownerEntries = acceptedByOwner.get(positioned.ownerId) ?? [];
    ownerEntries.push(positioned);
    acceptedByOwner.set(positioned.ownerId, ownerEntries);
  }
  return {
    sapCandidates: accepted.sort(compareCandidates),
    retainedHigherPriority: higherPriority.filter((candidate) =>
      !displacedCommonCandidateIds.has(candidate.candidateId)
    ).sort(compareCandidates)
  };
}

export function deterministicEligibleAreaCount(input: Readonly<{
  ownerId: string;
  kind: PopulationZoneV2PlanKind;
  eligibleAreaKm2: number;
  densityPerEligibleKm2: number;
  worldEnvironmentIdentityKey: string;
  environmentProfileVersion?: string;
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
  return whole + (
    deterministicUnit(
      FRACTIONAL_ROUNDING_VERSION,
      input.worldEnvironmentIdentityKey,
      input.environmentProfileVersion ?? ENVIRONMENT_PROFILE_VERSION,
      input.ownerId,
      input.kind
    ) < expected - whole
      ? 1
      : 0
  );
}

export function populationZoneV2RareParentDomainForPoint(
  kind: "stone" | "ogre" | "sap_crawler_group",
  point: PopulationZoneV2Point
): PopulationZoneV2RareParentDomain {
  const targetAreaM2 = RARE_PARENT_TARGET_AREA_KM2[kind]
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
      Math.floor(((normalizeLongitude(point.lon) + 180) / 360) * columnCount)
    );
  const longitudeSpan = 360 / columnCount;
  const westLon = -180 + column * longitudeSpan;
  const eastLon = column === columnCount - 1
    ? 180
    : -180 + (column + 1) * longitudeSpan;
  return {
    id: `${RARE_PARENT_DOMAIN_VERSION}/${kind}/${band.toString(36)}/${column.toString(36)}`,
    kind,
    center: {
      lat: toDegrees(Math.asin(
        (Math.sin(south) + Math.sin(north)) / 2
      )),
      lon: normalizeLongitude(westLon + longitudeSpan / 2)
    },
    areaKm2: bandAreaM2 / columnCount / 1_000_000,
    bounds: {
      southLat: toDegrees(south),
      northLat: toDegrees(north),
      westLon,
      eastLon
    }
  };
}

export function stablePopulationZoneV2RareParentSlot(
  domain: PopulationZoneV2RareParentDomain,
  worldEnvironmentIdentityKey: string,
  environmentProfileVersion = ENVIRONMENT_PROFILE_VERSION
): Readonly<{ candidateId: string; position: PopulationZoneV2Point }> {
  const latitudeUnit = deterministicUnit(
    worldEnvironmentIdentityKey,
    environmentProfileVersion,
    domain.id,
    "latitude"
  );
  const longitudeUnit = deterministicUnit(
    worldEnvironmentIdentityKey,
    environmentProfileVersion,
    domain.id,
    "longitude"
  );
  const southSine = Math.sin(toRadians(domain.bounds.southLat));
  const northSine = Math.sin(toRadians(domain.bounds.northLat));
  return {
    candidateId: `${domain.id}/${hashPartsHex(
      "rare-slot-world-environment-v1",
      worldEnvironmentIdentityKey,
      environmentProfileVersion
    ).slice(0, 16)}/slot-0`,
    position: {
      lat: toDegrees(Math.asin(
        southSine + (northSine - southSine) * latitudeUnit
      )),
      lon: normalizeLongitude(
        domain.bounds.westLon
          + (domain.bounds.eastLon - domain.bounds.westLon) * longitudeUnit
      )
    }
  };
}

export function deterministicPopulationZoneV2RareParentAllocation(
  domain: PopulationZoneV2RareParentDomain,
  eligibleAreaKm2: number,
  worldEnvironmentIdentityKey: string,
  environmentProfileVersion = ENVIRONMENT_PROFILE_VERSION
): boolean {
  if (
    !Number.isFinite(eligibleAreaKm2)
    || eligibleAreaKm2 < 0
    || eligibleAreaKm2 > domain.areaKm2 + 1e-9
  ) {
    throw new Error(
      "rare parent eligible area must be within its physical domain area"
    );
  }
  return deterministicUnit(
    RARE_ELIGIBLE_AREA_SELECTION_VERSION,
    worldEnvironmentIdentityKey,
    environmentProfileVersion,
    domain.id
  ) < clamp(eligibleAreaKm2 / domain.areaKm2, 0, 1);
}

export function populationZoneV2PlanningHabitatZoneIds(
  outputZoneIds: readonly PopulationZoneV2Id[],
  commonHaloRings: number
): PopulationZoneV2Id[] {
  const commonZoneIds = new Set<PopulationZoneV2Id>();
  const rareDependencyOriginIds = new Set<PopulationZoneV2Id>();
  for (const zoneId of [...new Set(outputZoneIds)].sort()) {
    for (const haloZoneId of populationZoneV2Halo(zoneId, commonHaloRings)) {
      commonZoneIds.add(haloZoneId);
      rareDependencyOriginIds.add(haloZoneId);
    }
    const geometry = populationZoneV2Geometry(zoneId);
    const maximumCenterToCornerDistanceM = Math.max(
      ...[
        geometry.bounds.southLat,
        geometry.bounds.northLat
      ].flatMap((lat) => [
        geometry.bounds.westLon,
        geometry.bounds.eastLon
      ].map((lon) => greatCircleDistanceMeters(
        geometry.center,
        { lat, lon }
      )))
    );
    for (const conflictZoneId of populationZonesV2IntersectingCircle(
      geometry.center,
      CANDIDATE_LOOKUP_HALO_M + maximumCenterToCornerDistanceM * 2
    )) {
      rareDependencyOriginIds.add(conflictZoneId);
    }
  }
  const dependencies = new Set(commonZoneIds);
  for (const zoneId of [...rareDependencyOriginIds].sort()) {
    for (const kind of ["stone", "ogre", "sap_crawler_group"] as const) {
      for (const domain of rareParentDomainsIntersectingZone(kind, zoneId)) {
        for (const dependency of populationZoneV2RareParentHabitatZoneIds(
          domain
        )) {
          dependencies.add(dependency);
        }
      }
    }
  }
  return [...dependencies].sort();
}

export function populationZoneV2PlanContentHash(input: Readonly<{
  identity: PopulationZoneV2PlanIdentity;
  planId: string;
  geometry: PopulationZoneV2Geometry;
  habitat: PopulationZoneV2Habitat;
  slots: readonly PopulationZoneV2PlanSlot[];
}>): string {
  return sha256Hex({
    habitat: input.habitat,
    identity: input.identity,
    planId: input.planId,
    totalAreaKm2: input.geometry.areaKm2,
    slots: [...input.slots]
      .sort((left, right) => left.entityId.localeCompare(right.entityId))
      .map((slot) => ({
        anchor: slot.anchor,
        archetype: slot.archetype,
        candidateId: slot.candidateId,
        encounterId: slot.encounterId,
        entityId: slot.entityId,
        entityKind: slot.entityKind,
        environmentSnapshot: slot.environmentSnapshot,
        packId: slot.packId,
        packMemberIndex: slot.packMemberIndex,
        position: slot.position,
        slotId: slot.slotId,
        suppressionClass: slot.suppressionClass
      }))
  });
}

function rawCandidatesForZones(input: Readonly<{
  zoneIds: readonly PopulationZoneV2Id[];
  worldEnvironmentIdentityKey: string;
  environmentProfileVersion: string;
  nonStoneGenerationKey?: string | undefined;
  habitatForZone: (zoneId: PopulationZoneV2Id) => PopulationZoneV2Habitat;
  habitatByZone: Map<PopulationZoneV2Id, PopulationZoneV2Habitat>;
  candidateSitesByZone: Map<
    PopulationZoneV2Id,
    readonly PopulationZoneV2HabitatCandidateSite[]
  >;
  baselineCommonCandidateIds: Set<string>;
  preparedSapCrawlerCandidates: Map<string, PreparedSapCrawlerCandidate>;
  sapCrawlerDiagnostics?: SapCrawlerDiagnosticsCollector;
}>): PopulationZoneV2RankedCandidate[] {
  const zoneIds = [...new Set(input.zoneIds)].sort();
  const habitatForZone = (zoneId: PopulationZoneV2Id) => {
    let habitat = input.habitatByZone.get(zoneId);
    if (habitat === undefined) {
      habitat = input.habitatForZone(zoneId);
      input.habitatByZone.set(zoneId, habitat);
    }
    return habitat;
  };
  const candidateSitesForZone = (zoneId: PopulationZoneV2Id) => {
    let sites = input.candidateSitesByZone.get(zoneId);
    if (sites === undefined) {
      sites = habitatCandidateSitesForGeneration({
        geometry: populationZoneV2Geometry(zoneId),
        habitat: habitatForZone(zoneId),
        worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
      });
      input.candidateSitesByZone.set(zoneId, sites);
    }
    return sites;
  };
  const common = zoneIds.flatMap((zoneId) => {
    const geometry = populationZoneV2Geometry(zoneId);
    const habitat = habitatForZone(zoneId);
    return (["tree", "flax", "deer", "wolf_pack"] as const).flatMap(
      (kind) => {
        const count = deterministicEligibleAreaCount({
          ownerId: zoneId,
          kind,
          eligibleAreaKm2: populationZoneV2EligibleAreaForKind(habitat, kind),
          densityPerEligibleKm2: candidateInputDensityFor(
            kind,
            false
          ),
          worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
          environmentProfileVersion: input.environmentProfileVersion
        });
        const baselineCount = deterministicEligibleAreaCount({
          ownerId: zoneId,
          kind,
          eligibleAreaKm2: populationZoneV2EligibleAreaForKind(habitat, kind),
          densityPerEligibleKm2: candidateInputDensityFor(kind, true),
          worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
          environmentProfileVersion: input.environmentProfileVersion
        });
        return commonCandidatesForKind({
          geometry,
          kind,
          count,
          baselineCount,
          candidateSites: candidateSitesForZone(zoneId),
          baselineCommonCandidateIds: input.baselineCommonCandidateIds,
          worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
          environmentProfileVersion: input.environmentProfileVersion,
          nonStoneGenerationKey: input.nonStoneGenerationKey
        });
      }
    );
  });
  const rare = boundedRareCandidatesForZones({
    zoneIds,
    habitatForZone,
    candidateSitesForZone,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
    environmentProfileVersion: input.environmentProfileVersion,
    nonStoneGenerationKey: input.nonStoneGenerationKey,
    preparedSapCrawlerCandidates: input.preparedSapCrawlerCandidates,
    ...(input.sapCrawlerDiagnostics === undefined
      ? {}
      : { sapCrawlerDiagnostics: input.sapCrawlerDiagnostics })
  });
  return [...common, ...rare].sort(compareCandidates);
}

function commonCandidatesForKind(input: Readonly<{
  geometry: PopulationZoneV2Geometry;
  kind: "tree" | "flax" | "deer" | "wolf_pack";
  count: number;
  baselineCount: number;
  candidateSites: readonly PopulationZoneV2HabitatCandidateSite[];
  baselineCommonCandidateIds: Set<string>;
  worldEnvironmentIdentityKey: string;
  environmentProfileVersion: string;
  nonStoneGenerationKey?: string | undefined;
}>): PopulationZoneV2RankedCandidate[] {
  if (input.count === 0) return [];
  const eligibleSites = input.candidateSites
    .filter((site) => habitatSiteWeightForKind(site, input.kind) > 0)
    .filter((site) => input.kind === "wolf_pack"
      || site.source !== "synthetic-sample-center"
      || !site.placementTags.some((tag) =>
        tag === "cluster-anchor"
        || tag === "cluster-member"
        || tag.startsWith("rare:")
      ))
    .filter((site) => input.kind !== "wolf_pack"
      || site.placementTags.includes("cluster-anchor"))
    .map((site) => ({
      site,
      rank: candidateSiteSelectionRank(input, site)
    }))
    .sort((left, right) =>
      left.rank.localeCompare(right.rank)
      || left.site.siteId.localeCompare(right.site.siteId)
    )
    .map(({ site }) => site);
  const output: PopulationZoneV2RankedCandidate[] = [];
  for (const anchorSite of eligibleSites) {
    if (output.length >= input.count) break;
    const densityRevision = output.length >= input.baselineCount
      ? POPULATION_DENSITY_REVISION
      : undefined;
    const candidateId = commonCandidateId(
      { ...input, densityRevision },
      anchorSite
    );
    if (input.kind !== "wolf_pack") {
      const candidate = rankedCandidateForSites({
        ...input,
        candidateId,
        anchorSite,
        sites: [anchorSite]
      });
      output.push(candidate);
      if (densityRevision === undefined) {
        input.baselineCommonCandidateIds.add(candidate.candidateId);
      }
      continue;
    }
    const sites = wolfPackMemberSites({
      anchorSite,
      candidateId,
      candidateSites: input.candidateSites
    });
    if (sites === null) continue;
    const candidate = rankedCandidateForSites({
      ...input,
      candidateId,
      anchorSite,
      sites
    });
    output.push(candidate);
    if (densityRevision === undefined) {
      input.baselineCommonCandidateIds.add(candidate.candidateId);
    }
  }
  return output;
}

function rankedCandidateForSites(input: Readonly<{
  geometry: PopulationZoneV2Geometry;
  kind: "tree" | "flax" | "deer" | "wolf_pack";
  worldEnvironmentIdentityKey: string;
  environmentProfileVersion: string;
  nonStoneGenerationKey?: string | undefined;
  candidateId: string;
  anchorSite: PopulationZoneV2HabitatCandidateSite;
  sites: readonly PopulationZoneV2HabitatCandidateSite[];
}>): PopulationZoneV2RankedCandidate {
  const rank = input.nonStoneGenerationKey === undefined
    ? hashPartsHex(
      CANDIDATE_RANK_VERSION,
      input.worldEnvironmentIdentityKey,
      input.environmentProfileVersion,
      input.candidateId
    )
    : hashPartsHex(
      CANDIDATE_RANK_VERSION,
      input.worldEnvironmentIdentityKey,
      input.environmentProfileVersion,
      input.nonStoneGenerationKey,
      input.candidateId
    );
  return {
    candidateId: input.candidateId,
    ownerId: input.geometry.id,
    kind: input.kind,
    position: input.anchorSite.position,
    rank,
    anchorSite: input.anchorSite,
    sites: input.sites
  };
}

function commonCandidateId(
  input: Readonly<{
    geometry: PopulationZoneV2Geometry;
    kind: "tree" | "flax" | "deer" | "wolf_pack";
    worldEnvironmentIdentityKey: string;
    environmentProfileVersion: string;
    nonStoneGenerationKey?: string | undefined;
    densityRevision?: string | undefined;
  }>,
  site: PopulationZoneV2HabitatCandidateSite
): string {
  const siteHash = input.densityRevision === undefined
    ? (
        input.nonStoneGenerationKey === undefined
          ? hashPartsHex(
              "population-common-candidate-site-id-v1",
              site.siteId
            )
          : hashPartsHex(
              "population-common-candidate-site-id-v1",
              input.nonStoneGenerationKey,
              site.siteId
            )
      )
    : hashPartsHex(
        "population-common-candidate-site-id-v1",
        ...(input.nonStoneGenerationKey === undefined
          ? []
          : [input.nonStoneGenerationKey]),
        input.densityRevision,
        input.kind,
        site.siteId
      );
  return `${POPULATION_CANDIDATE_LAYOUT_VERSION}/`
    + `${worldEnvironmentIdentityNamespace(
      input.worldEnvironmentIdentityKey,
      input.environmentProfileVersion
    )}/${input.kind}/${input.geometry.id}/`
    + siteHash.slice(0, 32);
}

function candidateSiteSelectionRank(
  input: Readonly<{
    geometry: PopulationZoneV2Geometry;
    kind: "tree" | "flax" | "deer" | "wolf_pack";
    worldEnvironmentIdentityKey: string;
    environmentProfileVersion: string;
    nonStoneGenerationKey?: string | undefined;
  }>,
  site: PopulationZoneV2HabitatCandidateSite
): string {
  return input.nonStoneGenerationKey === undefined
    ? hashPartsHex(
      CANDIDATE_SITE_SELECTION_VERSION,
      input.worldEnvironmentIdentityKey,
      input.environmentProfileVersion,
      input.geometry.id,
      input.kind,
      site.siteId
    )
    : hashPartsHex(
      CANDIDATE_SITE_SELECTION_VERSION,
      input.worldEnvironmentIdentityKey,
      input.environmentProfileVersion,
      input.nonStoneGenerationKey,
      input.geometry.id,
      input.kind,
      site.siteId
    );
}

function wolfPackMemberSites(input: Readonly<{
  anchorSite: PopulationZoneV2HabitatCandidateSite;
  candidateId: string;
  candidateSites: readonly PopulationZoneV2HabitatCandidateSite[];
}>): PopulationZoneV2HabitatCandidateSite[] | null {
  const clusterKey = candidateSiteClusterKey(input.anchorSite);
  if (clusterKey === null) return null;
  const candidates = input.candidateSites
    .filter((site) =>
      site.siteId !== input.anchorSite.siteId
      && candidateSiteClusterKey(site) === clusterKey
      && site.placementTags.includes("cluster-member")
      && habitatSiteWeightForKind(site, "wolf_pack") > 0
      && greatCircleDistanceMeters(
        input.anchorSite.position,
        site.position
      ) <= WOLF_MEMBER_MAX_ANCHOR_DISTANCE_M
    )
    .map((site) => ({
      site,
      primary: site.placementTags.includes("cluster-primary"),
      rank: hashPartsHex(
        "population-wolf-member-site-v1",
        input.candidateId,
        site.siteId
      )
    }))
    .sort((left, right) => {
      const primaryOrder = Number(right.primary) - Number(left.primary);
      if (primaryOrder !== 0) return primaryOrder;
      return left.rank.localeCompare(right.rank)
        || left.site.siteId.localeCompare(right.site.siteId);
    })
    .map(({ site }) => site);
  const selected: PopulationZoneV2HabitatCandidateSite[] = [];
  for (const site of candidates) {
    if (selected.length >= WOLF_PACK_MAX_MEMBER_COUNT) break;
    if (selected.every((entry) =>
      greatCircleDistanceMeters(entry.position, site.position)
        >= WOLF_MEMBER_MINIMUM_SPACING_M
    )) selected.push(site);
  }
  return selected.length === WOLF_PACK_MAX_MEMBER_COUNT ? selected : null;
}

function boundedRareCandidatesForZones(input: Readonly<{
  zoneIds: readonly PopulationZoneV2Id[];
  habitatForZone(zoneId: PopulationZoneV2Id): PopulationZoneV2Habitat;
  candidateSitesForZone(
    zoneId: PopulationZoneV2Id
  ): readonly PopulationZoneV2HabitatCandidateSite[];
  worldEnvironmentIdentityKey: string;
  environmentProfileVersion: string;
  nonStoneGenerationKey?: string | undefined;
  preparedSapCrawlerCandidates: Map<string, PreparedSapCrawlerCandidate>;
  sapCrawlerDiagnostics?: SapCrawlerDiagnosticsCollector;
}>): PopulationZoneV2RankedCandidate[] {
  const output: PopulationZoneV2RankedCandidate[] = [];
  const boundedDomains = new Set<string>();
  for (const ownerId of [...new Set(input.zoneIds)].sort()) {
    const geometry = populationZoneV2Geometry(ownerId);
    const habitat = input.habitatForZone(ownerId);
    const sites = input.candidateSitesForZone(ownerId);
    for (const kind of ["stone", "ogre"] as const) {
      for (const domain of rareParentDomainsIntersectingZone(kind, ownerId)) {
        const tag = `rare:${kind}:${domain.id}`;
        const slot = stablePopulationZoneV2RareParentSlot(
          domain,
          input.worldEnvironmentIdentityKey,
          POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION
        );
        const candidateId = rareGenerationCandidateId(
          kind,
          slot.candidateId,
          input.nonStoneGenerationKey
        );
        const site = kind === "ogre" && input.nonStoneGenerationKey
            ? sites
              .filter((candidate) =>
                habitatSiteWeightForKind(candidate, kind) > 0
                && populationZoneV2IdForPoint(candidate.position) === ownerId
              )
              .map((candidate) => ({
                candidate,
                rank: hashPartsHex(
                  "population-generation-rare-site-v1",
                  input.worldEnvironmentIdentityKey,
                  input.nonStoneGenerationKey!,
                  domain.id,
                  candidate.siteId
                )
              }))
              .sort((left, right) =>
                left.rank.localeCompare(right.rank)
                || left.candidate.siteId.localeCompare(right.candidate.siteId)
              )[0]?.candidate
            : sites.find((candidate) =>
                candidate.placementTags.includes(tag)
              );
        if (site) boundedDomains.add(domain.id);
        const eligibleFraction = clamp(
          populationZoneV2EligibleAreaForKind(habitat, kind)
            / geometry.areaKm2,
          0,
          1
        );
        const allocated = deterministicPopulationZoneV2RareParentAllocation(
          domain,
          domain.areaKm2 * eligibleFraction,
          input.worldEnvironmentIdentityKey,
          input.environmentProfileVersion
        );
        if (
          !site
          || habitatSiteWeightForKind(site, kind) <= 0
          || populationZoneV2IdForPoint(site.position) !== ownerId
        ) continue;
        if (!allocated) continue;
        output.push({
          candidateId,
          ownerId,
          kind,
          position: site.position,
          rank: hashPartsHex(
            CANDIDATE_RANK_VERSION,
            input.worldEnvironmentIdentityKey,
            input.environmentProfileVersion,
            candidateId
          ),
          anchorSite: site,
          sites: [site]
        });
      }
    }
  }
  const outputZoneIds = new Set(input.zoneIds);
  const sapCrawlerDomains = new Map<
    string,
    PopulationZoneV2RareParentDomain
  >();
  for (const zoneId of input.zoneIds) {
    for (const domain of rareParentDomainsIntersectingZone(
      "sap_crawler_group",
      zoneId
    )) {
      sapCrawlerDomains.set(domain.id, domain);
    }
  }
  for (const domain of [...sapCrawlerDomains.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    const cacheKey = [
      input.worldEnvironmentIdentityKey,
      input.environmentProfileVersion,
      input.nonStoneGenerationKey ?? "template",
      domain.id
    ].join("/");
    const cached = input.preparedSapCrawlerCandidates.get(cacheKey);
    if (cached !== undefined) {
      if (
        cached.diagnostic !== undefined
        && input.sapCrawlerDiagnostics !== undefined
        && outputZoneIds.has(cached.diagnostic.zoneId)
      ) {
        input.sapCrawlerDiagnostics.set(
          cached.candidateId!,
          cached.diagnostic
        );
      }
      if (
        cached.candidate !== undefined
        && outputZoneIds.has(cached.candidate.ownerId)
      ) {
        output.push(cached.candidate);
      }
      continue;
    }
    let eligibleAreaKm2 = 0;
    const habitatPieces = rareParentHabitatPieces(domain);
    for (const { zoneId, overlapAreaKm2 } of habitatPieces) {
      const geometry = populationZoneV2Geometry(zoneId);
      const habitat = input.habitatForZone(zoneId);
      eligibleAreaKm2 += overlapAreaKm2 * clamp(
        populationZoneV2EligibleAreaForKind(
          habitat,
          "sap_crawler_group"
        ) / geometry.areaKm2,
        0,
        1
      );
    }
    const allocated = deterministicPopulationZoneV2RareParentAllocation(
      domain,
      Math.min(
        eligibleAreaKm2
          / RARE_CANDIDATE_OVERSAMPLING_FACTOR.sap_crawler_group,
        domain.areaKm2
      ),
      input.worldEnvironmentIdentityKey,
      input.environmentProfileVersion
    );
    if (!allocated) {
      input.preparedSapCrawlerCandidates.set(cacheKey, {});
      continue;
    }
    const slot = stablePopulationZoneV2RareParentSlot(
      domain,
      input.worldEnvironmentIdentityKey,
      input.environmentProfileVersion
    );
    const candidateId = rareGenerationCandidateId(
      "sap_crawler_group",
      slot.candidateId,
      input.nonStoneGenerationKey
    );
    const candidateSites = habitatPieces.flatMap(({ zoneId }) =>
      input.candidateSitesForZone(zoneId)
    );
    const selections = habitatPieces
      .map(({ zoneId }) => zoneId)
      .filter((zoneId, index, zoneIds) => zoneIds.indexOf(zoneId) === index)
      .sort()
      .map((ownerId) => ({
        ownerId,
        selection: sapCrawlerGroupSiteSelection({
          candidateId,
          domain,
          ownerId,
          candidateSites
        })
      }));
    const siteAlternatives = selections
      .flatMap(({ selection }) => selection.alternatives)
      .sort((left, right) => {
        const treePreference = (sites:
          readonly PopulationZoneV2HabitatCandidateSite[]
        ) => sites.reduce(
          (total, site) => total + site.weights.tree,
          0
        );
        return treePreference(right) - treePreference(left)
          || hashPartsHex(
            "population-sap-crawler-cluster-rank-v1",
            candidateId,
            left[0]!.siteId
          ).localeCompare(hashPartsHex(
            "population-sap-crawler-cluster-rank-v1",
            candidateId,
            right[0]!.siteId
          ));
      });
    const sites = siteAlternatives[0];
    const diagnostic: SapCrawlerDiagnosticCandidate = {
      zoneId: sites === undefined
        ? populationZoneV2IdForPoint(slot.position)
        : populationZoneV2IdForPoint(sites[0]!.position),
      rejection: selections.every(({ selection }) =>
          selection.eligibleClusterCount === 0
      )
        ? "no-eligible-cluster"
        : siteAlternatives.length === 0
          ? "insufficient-valid-sites"
          : null
    };
    if (
      input.sapCrawlerDiagnostics !== undefined
      && outputZoneIds.has(diagnostic.zoneId)
    ) {
      input.sapCrawlerDiagnostics.set(candidateId, diagnostic);
    }
    if (sites === undefined) {
      input.preparedSapCrawlerCandidates.set(cacheKey, {
        candidateId,
        diagnostic
      });
      continue;
    }
    const ownerId = populationZoneV2IdForPoint(sites[0]!.position);
    const candidate: PopulationZoneV2RankedCandidate = {
      candidateId,
      ownerId,
      kind: "sap_crawler_group",
      position: sites[0]!.position,
      rank: hashPartsHex(
        CANDIDATE_RANK_VERSION,
        input.worldEnvironmentIdentityKey,
        input.environmentProfileVersion,
        candidateId
      ),
      anchorSite: sites[0]!,
      sites,
      siteAlternatives
    };
    input.preparedSapCrawlerCandidates.set(cacheKey, {
      candidateId,
      candidate,
      diagnostic
    });
    if (outputZoneIds.has(ownerId)) output.push(candidate);
  }
  if (input.zoneIds.some((zoneId) =>
    input.habitatForZone(zoneId).habitatSummary.sampleVersion
      === POPULATION_ZONE_V3_COMPACT_SAMPLE_VERSION
  )) {
    return output;
  }
  for (const kind of ["stone", "ogre"] as const) {
    const domains = new Map<string, PopulationZoneV2RareParentDomain>();
    for (const zoneId of input.zoneIds) {
      for (const domain of rareParentDomainsIntersectingZone(kind, zoneId)) {
        if (!boundedDomains.has(domain.id)) domains.set(domain.id, domain);
      }
    }
    for (const domain of [...domains.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    )) {
      let eligibleAreaKm2 = 0;
      const habitatPieces = rareParentHabitatPieces(domain);
      for (const { zoneId, overlapAreaKm2 } of habitatPieces) {
        const geometry = populationZoneV2Geometry(zoneId);
        const habitat = input.habitatForZone(zoneId);
        eligibleAreaKm2 += overlapAreaKm2 * clamp(
          populationZoneV2EligibleAreaForKind(habitat, kind)
            / geometry.areaKm2,
          0,
          1
        );
      }
      if (!deterministicPopulationZoneV2RareParentAllocation(
        domain,
        Math.min(eligibleAreaKm2, domain.areaKm2),
        input.worldEnvironmentIdentityKey,
        input.environmentProfileVersion
      )) continue;
      const slot = stablePopulationZoneV2RareParentSlot(
        domain,
        input.worldEnvironmentIdentityKey,
        input.environmentProfileVersion
      );
      const generationCandidateId = rareGenerationCandidateId(
        kind,
        slot.candidateId,
        input.nonStoneGenerationKey
      );
      const candidateSites = habitatPieces.flatMap(({ zoneId }) =>
        input.candidateSitesForZone(zoneId)
      );
      let site: PopulationZoneV2HabitatCandidateSite | undefined;
      for (const candidateSite of candidateSites) {
        if (
          habitatSiteWeightForKind(candidateSite, kind) <= 0
          || !pointIsInsideRareParentDomain(candidateSite.position, domain)
        ) continue;
        if (!site || candidateSite.siteId < site.siteId) site = candidateSite;
      }
      if (!site) continue;
      const ownerId = populationZoneV2IdForPoint(site.position);
      if (!outputZoneIds.has(ownerId)) continue;
      output.push({
        candidateId: generationCandidateId,
        ownerId,
        kind,
        position: site.position,
        rank: input.nonStoneGenerationKey === undefined
          ? hashPartsHex(
            CANDIDATE_RANK_VERSION,
            input.worldEnvironmentIdentityKey,
            input.environmentProfileVersion,
            slot.candidateId
          )
          : hashPartsHex(
            CANDIDATE_RANK_VERSION,
            input.worldEnvironmentIdentityKey,
            input.environmentProfileVersion,
            generationCandidateId
        ),
        anchorSite: site,
        sites: [site]
      });
    }
  }
  return output;
}

function rareGenerationCandidateId(
  kind: "stone" | "ogre" | "sap_crawler_group",
  baseCandidateId: string,
  nonStoneGenerationKey: string | undefined
): string {
  if (nonStoneGenerationKey === undefined || kind === "stone") {
    return baseCandidateId;
  }
  const namespace = kind === "ogre"
    ? "population-generation-ogre-candidate-v1"
    : "population-generation-sap-crawler-candidate-v1";
  return `${baseCandidateId}/${hashPartsHex(
    namespace,
    nonStoneGenerationKey
  ).slice(0, 16)}`;
}

export type SapCrawlerGroupSiteSelection = Readonly<{
  memberCount: 5 | 6 | 7;
  eligibleClusterCount: number;
  maximumValidSiteCount: number;
  alternatives: readonly (
    readonly PopulationZoneV2HabitatCandidateSite[]
  )[];
}>;

export function sapCrawlerGroupSiteAlternatives(input: Readonly<{
  candidateId: string;
  domain: PopulationZoneV2RareParentDomain;
  ownerId: PopulationZoneV2Id;
  candidateSites: readonly PopulationZoneV2HabitatCandidateSite[];
}>): PopulationZoneV2HabitatCandidateSite[][] {
  return sapCrawlerGroupSiteSelection(input).alternatives.map(
    (sites) => [...sites]
  );
}

export function sapCrawlerGroupSiteSelection(input: Readonly<{
  candidateId: string;
  domain: PopulationZoneV2RareParentDomain;
  ownerId: PopulationZoneV2Id;
  candidateSites: readonly PopulationZoneV2HabitatCandidateSite[];
}>): SapCrawlerGroupSiteSelection {
  const memberCount = legacySapCrawlerGroupSizeForUnit(deterministicUnit(
    "population-sap-crawler-group-size-v1",
    input.candidateId
  ));
  const eligible = (site: PopulationZoneV2HabitatCandidateSite): boolean =>
    site.weights.eligibleLand > 0
    && !site.isSaltwater
    && !site.insideMajorLake
    && populationZoneV2IdForPoint(site.position) === input.ownerId
    && pointIsInsideRareParentDomain(site.position, input.domain);
  const sitesByCluster = new Map<
    string,
    PopulationZoneV2HabitatCandidateSite[]
  >();
  for (const site of input.candidateSites) {
    if (!eligible(site)) continue;
    const clusterKey = candidateSiteClusterKey(site);
    if (clusterKey === null) continue;
    if (
      !site.placementTags.includes("cluster-anchor")
      && !site.placementTags.includes("cluster-member")
    ) continue;
    const sites = sitesByCluster.get(clusterKey) ?? [];
    sites.push(site);
    sitesByCluster.set(clusterKey, sites);
  }
  const alternatives = [...sitesByCluster.entries()]
    .map(([clusterKey, clusterSites]) => {
      const uniqueSites = new Map<
        string,
        PopulationZoneV2HabitatCandidateSite
      >();
      for (const site of clusterSites) {
        const key = candidateSitePositionKey(site.position);
        const existing = uniqueSites.get(key);
        if (existing === undefined || site.siteId < existing.siteId) {
          uniqueSites.set(key, site);
        }
      }
      const sites = [...uniqueSites.values()]
        .sort((left, right) => {
          const anchorOrder =
            Number(right.placementTags.includes("cluster-anchor"))
            - Number(left.placementTags.includes("cluster-anchor"));
          if (anchorOrder !== 0) return anchorOrder;
          return hashPartsHex(
          "population-sap-crawler-member-site-v1",
          input.candidateId,
            left.siteId
          ).localeCompare(hashPartsHex(
            "population-sap-crawler-member-site-v1",
            input.candidateId,
            right.siteId
          )) || left.siteId.localeCompare(right.siteId);
        })
        .slice(0, memberCount);
      return {
        clusterKey,
        sites,
        treePreference: sites.reduce(
          (total, site) => total + site.weights.tree,
          0
        ),
        rank: hashPartsHex(
          "population-sap-crawler-cluster-rank-v1",
          input.candidateId,
          clusterKey
        )
      };
    })
    .filter((entry) => entry.sites.length === memberCount)
    .sort((left, right) =>
      right.treePreference - left.treePreference
      || left.rank.localeCompare(right.rank)
      || left.clusterKey.localeCompare(right.clusterKey)
    )
    .map((entry) => entry.sites);
  return {
    memberCount,
    eligibleClusterCount: sitesByCluster.size,
    maximumValidSiteCount: Math.max(
      0,
      ...[...sitesByCluster.values()].map((sites) =>
        new Set(sites.map((site) =>
          candidateSitePositionKey(site.position)
        )).size
      )
    ),
    alternatives
  };
}

function rareParentDomainsIntersectingZone(
  kind: "stone" | "ogre" | "sap_crawler_group",
  zoneId: PopulationZoneV2Id
): PopulationZoneV2RareParentDomain[] {
  const cacheKey = `${kind}/${zoneId}`;
  const cached = rareParentDomainsByZone.get(cacheKey);
  if (cached !== undefined) return [...cached];
  const geometry = populationZoneV2Geometry(zoneId);
  const epsilon = 1e-9;
  const latitudes = [
    geometry.bounds.southLat + epsilon,
    geometry.center.lat,
    geometry.bounds.northLat - epsilon
  ];
  const longitudes = [
    geometry.bounds.westLon + epsilon,
    geometry.center.lon,
    geometry.bounds.eastLon - epsilon
  ];
  const domains = new Map<string, PopulationZoneV2RareParentDomain>();
  for (const lat of latitudes) {
    for (const lon of longitudes) {
      const domain = populationZoneV2RareParentDomainForPoint(kind, {
        lat: clamp(lat, -90, 90),
        lon: normalizeLongitude(lon)
      });
      domains.set(domain.id, domain);
    }
  }
  const result = [...domains.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  if (rareParentDomainsByZone.size >= MAX_RARE_GEOMETRY_CACHE_ENTRIES) {
    rareParentDomainsByZone.clear();
  }
  rareParentDomainsByZone.set(cacheKey, result);
  return [...result];
}

export function populationZoneV2RareParentHabitatZoneIds(
  domain: PopulationZoneV2RareParentDomain
): PopulationZoneV2Id[] {
  return rareParentHabitatPieces(domain).map((piece) => piece.zoneId);
}

function rareParentHabitatPieces(
  domain: PopulationZoneV2RareParentDomain
): readonly Readonly<{
  zoneId: PopulationZoneV2Id;
  overlapAreaKm2: number;
}>[] {
  const cached = rareParentHabitatPiecesByDomain.get(domain.id);
  if (cached !== undefined) return cached;
  const corners = [
    {
      lat: domain.bounds.southLat,
      lon: domain.bounds.westLon
    },
    {
      lat: domain.bounds.southLat,
      lon: domain.bounds.eastLon
    },
    {
      lat: domain.bounds.northLat,
      lon: domain.bounds.westLon
    },
    {
      lat: domain.bounds.northLat,
      lon: domain.bounds.eastLon
    }
  ];
  const radiusM = Math.max(...corners.map((corner) =>
    greatCircleDistanceMeters(domain.center, corner)
  )) + 1;
  const pieces = populationZonesV2IntersectingCircle(domain.center, radiusM)
    .map((zoneId) => ({
      zoneId,
      overlapAreaKm2: sphericalRectangleOverlapAreaKm2(
        populationZoneV2Geometry(zoneId).bounds,
        domain.bounds
      )
    }))
    .filter((piece) => piece.overlapAreaKm2 > 1e-12);
  if (
    rareParentHabitatPiecesByDomain.size
    >= MAX_RARE_GEOMETRY_CACHE_ENTRIES
  ) {
    rareParentHabitatPiecesByDomain.clear();
  }
  rareParentHabitatPiecesByDomain.set(domain.id, pieces);
  return pieces;
}

function sphericalRectangleOverlapAreaKm2(
  left: PopulationZoneV2Geometry["bounds"],
  right: PopulationZoneV2RareParentDomain["bounds"]
): number {
  const southLat = Math.max(left.southLat, right.southLat);
  const northLat = Math.min(left.northLat, right.northLat);
  const westLon = Math.max(left.westLon, right.westLon);
  const eastLon = Math.min(left.eastLon, right.eastLon);
  if (southLat >= northLat || westLon >= eastLon) return 0;
  return POPULATION_ZONE_V2_EARTH_RADIUS_M ** 2
    * (Math.sin(toRadians(northLat)) - Math.sin(toRadians(southLat)))
    * toRadians(eastLon - westLon)
    / 1_000_000;
}

function pointIsInsideRareParentDomain(
  point: PopulationZoneV2Point,
  domain: PopulationZoneV2RareParentDomain
): boolean {
  const longitude = normalizeLongitude(point.lon);
  return point.lat >= domain.bounds.southLat
    && (
      point.lat < domain.bounds.northLat
      || domain.bounds.northLat === 90
    )
    && longitude >= domain.bounds.westLon
    && (
      longitude < domain.bounds.eastLon
      || domain.bounds.eastLon === 180
    );
}

function slotsForCandidate(
  candidate: PopulationZoneV2RankedCandidate,
  identity: PopulationZoneV2PlanIdentity,
  environmentSnapshot: Readonly<Record<string, CanonicalJsonValue>>
): PopulationZoneV2PlanSlot[] {
  if (
    candidate.kind !== "wolf_pack"
    && candidate.kind !== "sap_crawler_group"
  ) {
    const permanentStone = candidate.kind === "stone"
      ? permanentPopulationStoneIdentity({
          identity,
          candidateId: candidate.candidateId,
          ownerZoneId: candidate.ownerId
        })
      : null;
    const permanentMineKind = permanentStone
      ? permanentMineKindForSlot(permanentStone.slotId)
      : null;
    const slotId = permanentStone?.slotId
      ?? stablePlanScopedUuid(SLOT_ID_VERSION, identity, {
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        memberIndex: null,
        sourceOwnerId: candidate.ownerId
      });
    const encounterId = candidate.kind === "deer" || candidate.kind === "ogre"
      ? stablePlanScopedUuid(ENCOUNTER_ID_VERSION, identity, {
        candidateId: candidate.candidateId,
        encounterKind: candidate.kind,
        sourceOwnerId: candidate.ownerId
      })
      : null;
    return [populationSlot({
      candidate,
      identity,
      slotId,
      entityKind: permanentMineKind ?? candidate.kind,
      position: candidate.position,
      anchor: candidate.position,
      encounterId,
      packId: null,
      packMemberIndex: null,
      candidateSite: candidate.anchorSite,
      environmentSnapshot,
      ...(permanentStone === null
        ? {}
        : { entityId: permanentStone.entityId })
    })];
  }
  const entityKind = candidate.kind === "wolf_pack"
    ? "wolf"
    : "sap_crawler";
  const memberCount = candidate.kind === "wolf_pack"
    ? wolfPackSizeForUnit(deterministicUnit(
        POPULATION_BALANCE.wolfPackSize.rollNamespace,
        candidate.candidateId
      ))
    : legacySapCrawlerGroupSizeForUnit(deterministicUnit(
        "population-sap-crawler-group-size-v1",
        candidate.candidateId
      ));
  return groupedEncounterSlots({
    candidate,
    identity,
    environmentSnapshot,
    entityKind,
    memberCount
  });
}

function groupedEncounterSlots(input: Readonly<{
  candidate: PopulationZoneV2RankedCandidate;
  identity: PopulationZoneV2PlanIdentity;
  environmentSnapshot: Readonly<Record<string, CanonicalJsonValue>>;
  entityKind: "wolf" | "sap_crawler";
  memberCount: number;
}>): PopulationZoneV2PlanSlot[] {
  if (
    !Number.isSafeInteger(input.memberCount)
    || input.memberCount <= 0
    || input.candidate.sites.length < input.memberCount
  ) {
    throw new Error("grouped population candidate has insufficient member sites");
  }
  const packId = stablePlanScopedUuid(PACK_ID_VERSION, input.identity, {
    candidateId: input.candidate.candidateId,
    sourceOwnerId: input.candidate.ownerId
  });
  const encounterId = stablePlanScopedUuid(
    ENCOUNTER_ID_VERSION,
    input.identity,
    {
      candidateId: input.candidate.candidateId,
      encounterKind: input.candidate.kind,
      sourceOwnerId: input.candidate.ownerId
    }
  );
  return input.candidate.sites
    .slice(0, input.memberCount)
    .map((site, memberIndex) => {
      const slotId = stablePlanScopedUuid(SLOT_ID_VERSION, input.identity, {
        candidateId: input.candidate.candidateId,
        kind: input.entityKind,
        memberIndex,
        sourceOwnerId: input.candidate.ownerId
      });
      return populationSlot({
        candidate: input.candidate,
        identity: input.identity,
        slotId,
        entityKind: input.entityKind,
        position: site.position,
        anchor: input.candidate.position,
        encounterId,
        packId,
        packMemberIndex: memberIndex,
        candidateSite: site,
        environmentSnapshot: input.environmentSnapshot
      });
    });
}

function populationSlot(input: Readonly<{
  candidate: PopulationZoneV2RankedCandidate;
  identity: PopulationZoneV2PlanIdentity;
  slotId: string;
  entityKind: PopulationZoneV2EntityKind;
  position: PopulationZoneV2Point;
  anchor: PopulationZoneV2Point;
  encounterId: string | null;
  packId: string | null;
  packMemberIndex: number | null;
  candidateSite: PopulationZoneV2HabitatCandidateSite;
  environmentSnapshot: Readonly<Record<string, CanonicalJsonValue>>;
  entityId?: string;
}>): PopulationZoneV2PlanSlot {
  return {
    slotId: input.slotId,
    entityId: input.entityId
      ?? stablePlanScopedUuid(ENTITY_ID_VERSION, input.identity, {
        kind: input.entityKind,
        slotId: input.slotId,
        sourceOwnerId: input.candidate.ownerId
      }),
    candidateId: input.candidate.candidateId,
    entityKind: input.entityKind,
    archetype: isPermanentMineEntityKind(input.entityKind)
      ? permanentMineArchetype(input.entityKind)
      : input.entityKind,
    encounterId: input.encounterId,
    packId: input.packId,
    packMemberIndex: input.packMemberIndex,
    position: input.position,
    anchor: input.anchor,
    environmentSnapshot: {
      ...input.environmentSnapshot,
      candidateSite: candidateSiteEnvironmentSnapshot(
        input.candidateSite,
        input.candidate.kind !== "stone"
      )
    },
    suppressionClass: suppressionClassFor(input.entityKind)
  };
}

export type PopulationPlacementCandidate = Readonly<{
  kind: PopulationZoneV2PlanKind;
  position: PopulationZoneV2Point;
  homes: readonly PopulationZoneV2Point[];
}>;

type PopulationSlotCandidateGroup = PopulationPlacementCandidate & Readonly<{
  kind: "tree" | "flax" | "deer" | "wolf_pack" | "ogre" | "sap_crawler_group";
  candidateId: string;
  complete: boolean;
  slots: readonly PopulationZoneV2PlanSlot[];
}>;

function populationSlotCandidateGroups(
  slots: readonly PopulationZoneV2PlanSlot[]
): PopulationSlotCandidateGroup[] {
  const grouped = new Map<string, PopulationZoneV2PlanSlot[]>();
  for (const slot of slots) {
    if (isPermanentMineEntityKind(slot.entityKind)) continue;
    const members = grouped.get(slot.candidateId) ?? [];
    members.push(slot);
    grouped.set(slot.candidateId, members);
  }
  return [...grouped.entries()].map((
    [candidateId, members]
  ): PopulationSlotCandidateGroup => {
    const ordered = members.sort((left, right) =>
      (left.packMemberIndex ?? -1) - (right.packMemberIndex ?? -1)
      || left.entityId.localeCompare(right.entityId)
    );
    const first = ordered[0]!;
    if (isPermanentMineEntityKind(first.entityKind)) {
      throw new Error("permanent mines cannot enter generation reconciliation");
    }
    const kind = legacyPlanKindForEntityKind(first.entityKind);
    if (kind === null) {
      throw new Error(
        `registered mob ${first.entityKind} cannot enter legacy reconciliation`
      );
    }
    if (
      (kind === "wolf_pack" || kind === "sap_crawler_group")
      && (
        first.packId === null
        || ordered.some((slot) =>
          slot.entityKind !== first.entityKind
          || slot.packId !== first.packId
        )
      )
    ) {
      throw new Error("grouped population candidate must remain whole");
    }
    if (ordered.some((slot) =>
      legacyPlanKindForEntityKind(slot.entityKind) !== kind
    )) {
      throw new Error("population candidate contains mixed entity kinds");
    }
    const complete = kind !== "sap_crawler_group"
      || isCompleteSapCrawlerGroup(candidateId, ordered);
    return {
      candidateId,
      complete,
      kind,
      position: kind === "wolf_pack" || kind === "sap_crawler_group"
        ? first.anchor
        : first.position,
      homes: kind === "wolf_pack" || kind === "sap_crawler_group"
        ? ordered.map((slot) => slot.position)
        : [first.position],
      slots: ordered
    };
  }).sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId)
  );
}

function legacyPlanKindForEntityKind(
  entityKind: string
): PopulationSlotCandidateGroup["kind"] | null {
  if (entityKind === "tree") return "tree";
  if (entityKind === "flax") return "flax";
  const planKind = populationV2MobRegistry
    .definitionForKind(entityKind)
    ?.legacyIdentity
    ?.planKind;
  return planKind === "deer"
    || planKind === "wolf_pack"
    || planKind === "ogre"
    || planKind === "sap_crawler_group"
    ? planKind
    : null;
}

function countCandidateGroups(
  candidates: readonly PopulationSlotCandidateGroup[],
  kind: "tree" | "flax" | "deer" | "wolf_pack" | "sap_crawler_group"
): number {
  return candidates.filter((candidate) =>
    candidate.kind === kind && candidate.complete
  ).length;
}

export function incompleteSapCrawlerGroupCandidateIds(
  slots: readonly PopulationZoneV2PlanSlot[]
): string[] {
  return populationSlotCandidateGroups(slots)
    .filter((candidate) =>
      candidate.kind === "sap_crawler_group" && !candidate.complete
    )
    .map((candidate) => candidate.candidateId)
    .sort();
}

function isCompleteSapCrawlerGroup(
  candidateId: string,
  slots: readonly PopulationZoneV2PlanSlot[]
): boolean {
  try {
    assertCompleteSapCrawlerGroup(candidateId, slots);
    return true;
  } catch {
    return false;
  }
}

function assertCompleteSapCrawlerGroup(
  candidateId: string,
  slots: readonly PopulationZoneV2PlanSlot[]
): void {
  if (candidateId.length === 0 || ![5, 6, 7].includes(slots.length)) {
    throw new Error("Resin Crawler template group must contain 5, 6, or 7 members");
  }
  const first = slots[0]!;
  const expectedIndexes = slots.map((_, index) => index);
  const indexes = slots.map((slot) => slot.packMemberIndex).sort(
    (left, right) => (left ?? -1) - (right ?? -1)
  );
  if (
    first.entityKind !== "sap_crawler"
    || first.archetype !== "sap_crawler"
    || first.encounterId === null
    || first.packId === null
    || slots.some((slot) =>
      slot.entityKind !== "sap_crawler"
      || slot.archetype !== "sap_crawler"
      || slot.candidateId !== candidateId
      || slot.encounterId !== first.encounterId
      || slot.packId !== first.packId
      || canonicalJson(slot.anchor) !== canonicalJson(first.anchor)
    )
    || canonicalJson(indexes) !== canonicalJson(expectedIndexes)
    || new Set(slots.map((slot) =>
      populationCoordinateKey(slot.position)
    )).size !== slots.length
  ) {
    throw new Error("Resin Crawler template group blueprint is invalid");
  }
}

function populationPlacementCandidate(
  candidate: PopulationZoneV2RankedCandidate
): PopulationPlacementCandidate {
  return {
    kind: candidate.kind,
    position: candidate.position,
    homes: candidate.kind === "wolf_pack"
      || candidate.kind === "sap_crawler_group"
      ? candidate.sites.map((site) => site.position)
      : [candidate.position]
  };
}

export function populationPlacementCandidatesConflict(
  left: PopulationPlacementCandidate,
  right: PopulationPlacementCandidate
): boolean {
  return populationV2SpacingConflict(
    populationPlacementSpacingInput(left),
    populationPlacementSpacingInput(right)
  );
}

function populationPlacementSpacingInput(
  candidate: PopulationPlacementCandidate
) {
  return {
    spacingClass: populationPlacementSpacingClass(candidate.kind),
    anchor: candidate.position,
    bodies: candidate.homes
  };
}

function populationPlacementSpacingClass(
  kind: PopulationZoneV2PlanKind
): PopulationV2SpacingClass {
  if (kind === "tree" || kind === "flax") return "scenery_tree";
  if (kind === "stone") return "permanent_stone";
  const definition = populationV2MobRegistry.definitions.find(
    (candidate) => candidate.legacyIdentity?.planKind === kind
  );
  if (definition === undefined) {
    throw new Error(`Population V2 planner kind ${kind} has no mob definition`);
  }
  return definition.spacingClass;
}

function populationCoordinateKey(point: PopulationZoneV2Point): string {
  return `${point.lat.toFixed(9)}/${normalizeLongitude(point.lon).toFixed(9)}`;
}

function candidateInputDensityFor(
  kind: "tree" | "flax" | "deer" | "wolf_pack",
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

export function populationZoneV2EligibleAreaForKind(
  habitat: PopulationZoneV2Habitat,
  kind: PopulationZoneV2PlanKind
): number {
  switch (kind) {
    case "tree": return habitat.treeKm2;
    case "flax": return habitat.flaxKm2 ?? 0;
    case "deer": return habitat.deerKm2;
    case "wolf_pack": return habitat.wolfKm2;
    case "stone": return habitat.stoneKm2;
    case "ogre": return habitat.ogreKm2;
    case "sap_crawler_group": return habitat.eligibleLandKm2;
  }
}

function habitatCandidateSitesFromResolvedSamples(input: Readonly<{
  zoneId: PopulationZoneV2Id;
  worldEnvironmentIdentityKey: string;
  resolved: readonly Readonly<{
    sample: PopulationZoneV2HabitatSample;
    facts: PopulationZoneV2HabitatFacts | null;
  }>[];
}>): PopulationZoneV2HabitatCandidateSite[] {
  const profileSites = new Map<string, PopulationZoneV2HabitatCandidateSite>();
  for (const { sample, facts } of [...input.resolved].sort((left, right) =>
    left.sample.sampleId.localeCompare(right.sample.sampleId)
  )) {
    if (facts === null || facts.candidateSlots === undefined) continue;
    for (const slot of [...facts.candidateSlots].sort((left, right) =>
      left.slotId.localeCompare(right.slotId)
    )) {
      const position = {
        lat: slot.latitude,
        lon: normalizeLongitude(slot.longitude)
      };
      if (populationZoneV2IdForPoint(position) !== input.zoneId) continue;
      const sourceCellId = boundedEnvironmentText(
        facts.sourceCellId ?? `sample:${sample.sampleId}`,
        160
      );
      const candidateSlotVersion = boundedEnvironmentText(
        facts.candidateSlotVersion ?? "unknown",
        160
      );
      const siteId = `world-profile/`
        + hashPartsHex(
          "population-world-profile-candidate-site-v1",
          sourceCellId,
          candidateSlotVersion,
          slot.slotId
        ).slice(0, 40);
      const site = habitatCandidateSiteFromSlot({
        siteId,
        position,
        sample,
        facts,
        slot,
        sourceCellId,
        candidateSlotVersion
      });
      const existing = profileSites.get(siteId);
      if (
        existing === undefined
        || canonicalJson(site).localeCompare(canonicalJson(existing)) < 0
      ) {
        profileSites.set(siteId, site);
      }
    }
  }
  if (profileSites.size > 0) {
    const byPosition = new Map<string, PopulationZoneV2HabitatCandidateSite>();
    for (const site of [...profileSites.values()].sort((left, right) =>
      left.siteId.localeCompare(right.siteId)
    )) {
      const key = candidateSitePositionKey(site.position);
      if (!byPosition.has(key)) byPosition.set(key, site);
    }
    return boundedHabitatCandidateSites({
      sites: [...byPosition.values()],
      zoneId: input.zoneId,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
    });
  }
  return input.resolved
    .filter(({ sample }) => sample.placementEligible !== false)
    .map(({ sample, facts }) => syntheticSampleCandidateSite(sample, facts));
}

function habitatCandidateSiteFromSlot(input: Readonly<{
  siteId: string;
  position: PopulationZoneV2Point;
  sample: PopulationZoneV2HabitatSample;
  facts: PopulationZoneV2HabitatFacts;
  slot: WorldEnvironmentCandidateSlot;
  sourceCellId: string;
  candidateSlotVersion: string;
}>): PopulationZoneV2HabitatCandidateSite {
  const surfaceType = input.slot.surfaceType
    ?? populationV2EncounterSurface({
      isLand: input.slot.eligibleLand,
      isSaltwater: input.slot.isSaltwater,
      insideMajorLake: input.slot.insideMajorLake
    });
  const slotFacts: PopulationZoneV2HabitatFacts = {
    isLand: surfaceType === "land" || input.slot.eligibleLand,
    isSaltwater: input.slot.isSaltwater,
    isCoastalLand: input.slot.placementTags.includes("coastal-land"),
    isRiverbank: input.slot.isRiverbank,
    isLakeshore: input.slot.isLakeshore,
    insideMajorLake: input.slot.insideMajorLake,
    waterKind: surfaceType === null
      ? null
      : surfaceType === "land"
        ? null
        : surfaceType,
    surfaceAuthority: input.slot.surfaceAuthority ?? null,
    isCoastal: input.facts.isCoastal,
    elevationBand: input.slot.elevationBand,
    terrainClass: input.slot.terrainClass,
    landCoverClass: input.slot.landCoverClass,
    biomeId: input.slot.biomeId,
    biomeName: input.slot.biomeName,
    ecoregionId: input.slot.ecoregionId,
    ecoregionName: input.slot.ecoregionName,
    spawnProfileKey: input.facts.spawnProfileKey
  };
  return {
    siteId: input.siteId,
    position: input.position,
    source: "world-profile-candidate-slot",
    sourceSampleId: input.sample.sampleId,
    sourceCellId: input.sourceCellId,
    sourceSlotId: boundedEnvironmentText(input.slot.slotId, 160),
    candidateSlotVersion: input.candidateSlotVersion,
    placementTags: boundedPlacementTags(input.slot.placementTags),
    isRiverbank: input.slot.isRiverbank,
    isLakeshore: input.slot.isLakeshore,
    isSaltwater: input.slot.isSaltwater,
    insideMajorLake: input.slot.insideMajorLake,
    surfaceType,
    surfaceAuthority: input.slot.surfaceAuthority ?? null,
    elevationBand: boundedNullableEnvironmentText(input.slot.elevationBand),
    terrainClass: boundedNullableEnvironmentText(input.slot.terrainClass),
    landCoverClass: boundedNullableEnvironmentText(input.slot.landCoverClass),
    biomeId: boundedNullableEnvironmentText(input.slot.biomeId),
    ecoregionId: boundedNullableEnvironmentText(input.slot.ecoregionId),
    spawnProfileKey: boundedEnvironmentText(input.facts.spawnProfileKey, 160),
    weights: habitatWeights(slotFacts)
  };
}

function syntheticSampleCandidateSite(
  sample: PopulationZoneV2HabitatSample,
  facts: PopulationZoneV2HabitatFacts | null
): PopulationZoneV2HabitatCandidateSite {
  const weights = facts === null ? zeroHabitatWeights() : habitatWeights(facts);
  return {
    siteId: `synthetic-sample/${hashPartsHex(
      "population-synthetic-habitat-sample-site-v1",
      sample.sampleId
    ).slice(0, 40)}`,
    position: sample.position,
    source: "synthetic-sample-center",
    sourceSampleId: sample.sampleId,
    sourceCellId: null,
    sourceSlotId: null,
    candidateSlotVersion: null,
    placementTags: [...new Set([
      ...(sample.placementTags ?? ["general"]),
      ...(facts?.isCoastalLand ? ["coastal-land"] : []),
      ...(facts?.isRiverbank ? ["riverbank"] : []),
      ...(facts?.isLakeshore ? ["lakeshore"] : [])
    ])].sort(),
    isRiverbank: facts?.isRiverbank ?? false,
    isLakeshore: facts?.isLakeshore ?? false,
    isSaltwater: facts?.isSaltwater ?? false,
    insideMajorLake: facts?.insideMajorLake ?? false,
    surfaceType: facts === null ? null : populationV2EncounterSurface(facts),
    surfaceAuthority: facts?.surfaceAuthority ?? null,
    elevationBand: boundedNullableEnvironmentText(facts?.elevationBand ?? null),
    terrainClass: boundedNullableEnvironmentText(facts?.terrainClass ?? null),
    landCoverClass: boundedNullableEnvironmentText(
      facts?.landCoverClass ?? null
    ),
    biomeId: boundedNullableEnvironmentText(facts?.biomeId ?? null),
    ecoregionId: boundedNullableEnvironmentText(facts?.ecoregionId ?? null),
    spawnProfileKey: boundedEnvironmentText(
      facts?.spawnProfileKey ?? "missing",
      160
    ),
    weights
  };
}

function pointAtZoneUnit(
  geometry: PopulationZoneV2Geometry,
  latitudeUnit: number,
  longitudeUnit: number
): PopulationZoneV2Point {
  const southSine = Math.sin(toRadians(geometry.bounds.southLat));
  const northSine = Math.sin(toRadians(geometry.bounds.northLat));
  return {
    lat: toDegrees(Math.asin(
      southSine
        + (northSine - southSine) * clamp(latitudeUnit, 0, 1)
    )),
    lon: normalizeLongitude(
      geometry.bounds.westLon
        + (geometry.bounds.eastLon - geometry.bounds.westLon)
          * clamp(longitudeUnit, 0, 1)
    )
  };
}

function boundedHabitatCandidateSites(input: Readonly<{
  sites: readonly PopulationZoneV2HabitatCandidateSite[];
  zoneId: PopulationZoneV2Id;
  worldEnvironmentIdentityKey: string;
}>): PopulationZoneV2HabitatCandidateSite[] {
  const groups = new Map<string, PopulationZoneV2HabitatCandidateSite[]>();
  for (const site of input.sites) {
    const key = candidateSiteClusterKey(site) ?? `site:${site.siteId}`;
    const group = groups.get(key) ?? [];
    group.push(site);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.entries()].sort(([left], [right]) =>
    hashPartsHex(
      CANDIDATE_SITE_SELECTION_VERSION,
      input.worldEnvironmentIdentityKey,
      input.zoneId,
      "bounded-group",
      left
    ).localeCompare(hashPartsHex(
      CANDIDATE_SITE_SELECTION_VERSION,
      input.worldEnvironmentIdentityKey,
      input.zoneId,
      "bounded-group",
      right
    )) || left.localeCompare(right)
  );
  const selected: PopulationZoneV2HabitatCandidateSite[] = [];
  for (const [, group] of orderedGroups) {
    if (selected.length + group.length > MAX_CANDIDATE_SITES_PER_ZONE) {
      continue;
    }
    selected.push(...group.sort((left, right) =>
      left.siteId.localeCompare(right.siteId)
    ));
  }
  return selected.sort((left, right) => left.siteId.localeCompare(right.siteId));
}

function habitatCandidateSitesForGeneration(input: Readonly<{
  geometry: PopulationZoneV2Geometry;
  habitat: PopulationZoneV2Habitat;
  worldEnvironmentIdentityKey: string;
}>): readonly PopulationZoneV2HabitatCandidateSite[] {
  if (input.habitat.candidateSites !== undefined) {
    return input.habitat.candidateSites;
  }
  const totalAreaKm2 = input.geometry.areaKm2;
  const areaWeights = {
    eligibleLand: fixtureOnlyFullOrZeroWeight(
      input.habitat.eligibleLandKm2,
      totalAreaKm2
    ),
    tree: fixtureOnlyFullOrZeroWeight(input.habitat.treeKm2, totalAreaKm2),
    flax: fixtureOnlyFullOrZeroWeight(input.habitat.flaxKm2 ?? 0, totalAreaKm2),
    deer: fixtureOnlyFullOrZeroWeight(input.habitat.deerKm2, totalAreaKm2),
    wolf: fixtureOnlyFullOrZeroWeight(input.habitat.wolfKm2, totalAreaKm2),
    stone: fixtureOnlyFullOrZeroWeight(input.habitat.stoneKm2, totalAreaKm2),
    ogre: fixtureOnlyFullOrZeroWeight(input.habitat.ogreKm2, totalAreaKm2)
  } satisfies PopulationZoneV2HabitatWeights;
  const cacheKey = [
    input.worldEnvironmentIdentityKey,
    input.geometry.id,
    areaWeights.eligibleLand,
    areaWeights.tree,
    areaWeights.flax,
    areaWeights.deer,
    areaWeights.wolf,
    areaWeights.stone,
    areaWeights.ogre
  ].join("\u0000");
  const cached = syntheticCandidateSitesByAuthority.get(cacheKey);
  if (cached !== undefined) {
    syntheticCandidateSitesByAuthority.delete(cacheKey);
    syntheticCandidateSitesByAuthority.set(cacheKey, cached);
    return cached;
  }
  const candidateSites = populationZoneV2HabitatSamplePoints({
    zoneId: input.geometry.id,
    worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey
  }).map((sample) => ({
    ...syntheticSampleCandidateSite(sample, null),
    spawnProfileKey: "explicit-full-or-zero-fixture",
    weights: areaWeights
  }));
  syntheticCandidateSitesByAuthority.set(cacheKey, candidateSites);
  while (
    syntheticCandidateSitesByAuthority.size
      > MAX_SYNTHETIC_CANDIDATE_SITE_CACHE_ENTRIES
  ) {
    const oldest = syntheticCandidateSitesByAuthority.keys().next().value;
    if (oldest === undefined) break;
    syntheticCandidateSitesByAuthority.delete(oldest);
  }
  return candidateSites;
}

function fixtureOnlyFullOrZeroWeight(value: number, total: number): 0 | 1 {
  if (Math.abs(value) <= 1e-9) return 0;
  if (Math.abs(value - total) <= 1e-9) return 1;
  throw new Error(
    "partial population habitat requires deterministic candidateSites"
  );
}

function habitatSiteWeightForKind(
  site: PopulationZoneV2HabitatCandidateSite,
  kind: PopulationZoneV2PlanKind
): number {
  switch (kind) {
    case "tree": return site.weights.tree;
    case "flax": return site.weights.flax ?? 0;
    case "deer": return site.weights.deer;
    case "wolf_pack": return site.weights.wolf;
    case "stone": return site.weights.stone;
    case "ogre": return site.weights.ogre;
    case "sap_crawler_group": return site.weights.eligibleLand;
  }
}

function candidateSiteClusterKey(
  site: PopulationZoneV2HabitatCandidateSite
): string | null {
  const cluster = site.placementTags.find((tag) =>
    tag.startsWith("cluster:")
  );
  if (cluster === undefined) return null;
  if (site.source === "synthetic-sample-center") return cluster;
  return `${site.sourceCellId ?? site.sourceSampleId}/${cluster}`;
}

function candidateSitePositionKey(point: PopulationZoneV2Point): string {
  return `${point.lat.toFixed(9)}/${normalizeLongitude(point.lon).toFixed(9)}`;
}

function candidateSiteEnvironmentSnapshot(
  site: PopulationZoneV2HabitatCandidateSite,
  includeEncounterSurface = true
): Readonly<Record<string, CanonicalJsonValue>> {
  const stableSnapshot = {
    candidateSiteSelectionVersion: CANDIDATE_SITE_SELECTION_VERSION,
    siteId: site.siteId,
    source: site.source,
    sourceSampleId: site.sourceSampleId,
    sourceCellId: site.sourceCellId,
    sourceSlotId: site.sourceSlotId,
    candidateSlotVersion: site.candidateSlotVersion,
    placementTags: site.placementTags,
    isRiverbank: site.isRiverbank ?? false,
    isLakeshore: site.isLakeshore ?? false,
    isSaltwater: site.isSaltwater,
    insideMajorLake: site.insideMajorLake,
    elevationBand: site.elevationBand,
    terrainClass: site.terrainClass,
    landCoverClass: site.landCoverClass,
    biomeId: site.biomeId,
    ecoregionId: site.ecoregionId,
    spawnProfileKey: site.spawnProfileKey,
    weights: site.weights
  };
  return includeEncounterSurface
    ? {
        ...stableSnapshot,
        surfaceType: site.surfaceType ?? null,
        surfaceAuthority: site.surfaceAuthority ?? null
      }
    : stableSnapshot;
}

function boundedPlacementTags(values: readonly string[]): string[] {
  return [...new Set(values.map((value) =>
    boundedEnvironmentText(value, 80)
  ))].sort().slice(0, 24);
}

function boundedNullableEnvironmentText(
  value: string | null
): string | null {
  return value === null ? null : boundedEnvironmentText(value, 160);
}

function boundedEnvironmentText(value: string, maximumLength: number): string {
  return value.slice(0, maximumLength);
}

function suppressionClassFor(
  kind: PopulationZoneV2EntityKind
): PopulationZoneV2SuppressionClass {
  if (kind === "tree" || kind === "flax" || isPermanentMineEntityKind(kind)) return "none";
  const definition = populationV2MobRegistry.definitionForKind(kind);
  if (definition === undefined) {
    throw new Error(`Population V2 entity kind ${kind} has no mob definition`);
  }
  return definition.suppressionClass;
}

function compareCandidates(
  left: PopulationZoneV2RankedCandidate,
  right: PopulationZoneV2RankedCandidate
): number {
  return left.rank.localeCompare(right.rank)
    || left.candidateId.localeCompare(right.candidateId);
}

function worldEnvironmentIdentityNamespace(
  worldEnvironmentIdentityKey: string,
  environmentProfileVersion: string
): string {
  const key = `${worldEnvironmentIdentityKey}\u0000${environmentProfileVersion}`;
  const cached = worldEnvironmentNamespaceByIdentity.get(key);
  if (cached !== undefined) return cached;
  const namespace = hashPartsHex(
    "population-world-environment-namespace-v1",
    worldEnvironmentIdentityKey,
    environmentProfileVersion
  ).slice(0, 24);
  worldEnvironmentNamespaceByIdentity.set(key, namespace);
  while (
    worldEnvironmentNamespaceByIdentity.size
      > MAX_WORLD_ENVIRONMENT_NAMESPACE_CACHE_ENTRIES
  ) {
    const oldest = worldEnvironmentNamespaceByIdentity.keys().next().value;
    if (oldest === undefined) break;
    worldEnvironmentNamespaceByIdentity.delete(oldest);
  }
  return namespace;
}

function assertGenerationInput(
  input: PopulationZoneV2PlanGenerationInput
): void {
  if (input.outputZoneIds.length === 0) {
    throw new Error("at least one output population zone is required");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.worldEnvironmentIdentityKey)) {
    throw new Error(
      "World environment identity key must be a lowercase SHA-256 hex string"
    );
  }
  if (!/^[a-f0-9]{40}$/u.test(input.worldPipelineSha)) {
    throw new Error("World runtime SHA must be a lowercase 40-character Git SHA");
  }
  if (
    input.nonStoneGenerationKey !== undefined
    && input.nonStoneGenerationKey.trim().length === 0
  ) {
    throw new Error("population non-stone generation key cannot be empty");
  }
}

function assertHabitat(
  zoneId: PopulationZoneV2Id,
  habitat: PopulationZoneV2Habitat
): void {
  if (habitat.regionCode.length === 0) {
    throw new Error(`population habitat ${zoneId} requires a region code`);
  }
  const totalAreaKm2 = populationZoneV2Geometry(zoneId).areaKm2;
  for (const [name, value] of Object.entries({
    eligibleLandKm2: habitat.eligibleLandKm2,
    treeKm2: habitat.treeKm2,
    flaxKm2: habitat.flaxKm2 ?? 0,
    deerKm2: habitat.deerKm2,
    wolfKm2: habitat.wolfKm2,
    stoneKm2: habitat.stoneKm2,
    ogreKm2: habitat.ogreKm2
  })) {
    if (!Number.isFinite(value) || value < 0 || value > totalAreaKm2 + 1e-9) {
      throw new Error(
        `${name} for ${zoneId} must be within the physical zone area`
      );
    }
  }
  if (habitat.candidateSites !== undefined) {
    if (habitat.candidateSites.length > 4_096) {
      throw new Error(
        `population habitat ${zoneId} has too many candidate sites`
      );
    }
    const siteIds = new Set<string>();
    for (const site of habitat.candidateSites) {
      if (siteIds.has(site.siteId)) {
        throw new Error(
          `population habitat ${zoneId} repeats candidate site ${site.siteId}`
        );
      }
      siteIds.add(site.siteId);
      if (populationZoneV2IdForPoint(site.position) !== zoneId) {
        throw new Error(
          `population habitat candidate site ${site.siteId} is not owner-local`
        );
      }
      for (const [kind, weight] of Object.entries(site.weights)) {
        if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
          throw new Error(
            `population habitat candidate ${site.siteId} ${kind} weight is invalid`
          );
        }
      }
    }
  }
}

function habitatWeights(
  facts: PopulationZoneV2HabitatFacts
): PopulationZoneV2HabitatWeights {
  const eligibleLand = populationV2EncounterSurface(facts) === "land";
  if (!eligibleLand) {
    return {
      eligibleLand: 0,
      tree: 0,
      flax: 0,
      deer: 0,
      wolf: 0,
      stone: 0,
      ogre: 0
    };
  }
  const environment = normalizedEnvironmentText([
    facts.spawnProfileKey,
    facts.biomeId,
    facts.biomeName,
    facts.ecoregionId,
    facts.ecoregionName,
    facts.landCoverClass,
    facts.terrainClass,
    facts.elevationBand
  ].filter((value): value is string => value !== null).join(" "));
  const desert = includesAny(environment, ["desert", "arid", "xeric"]);
  const wetland = includesAny(environment, [
    "wetland",
    "marsh",
    "swamp",
    "mangrove"
  ]);
  const mountain = includesAny(environment, [
    "mountain",
    "alpine",
    "montane",
    "highland"
  ]);
  const coldSparse = includesAny(environment, [
    "tundra",
    "polar",
    "ice",
    "subarctic"
  ]);
  const tree = 1;
  const flax = desert || mountain || coldSparse ? 0 : wetland ? 0.8 : 1;
  const deer = desert
    ? 0.45
    : coldSparse
      ? 0.6
      : wetland || mountain
        ? 0.7
        : 1;
  const wolf = wetland
    ? 0.45
    : desert
      ? 0.75
      : coldSparse
        ? 0.8
        : mountain
          ? 0.9
          : 1;
  const stone = wetland ? 0.5 : 1;
  return { eligibleLand: 1, tree, flax, deer, wolf, stone, ogre: 1 };
}

function zeroHabitatWeights(): PopulationZoneV2HabitatWeights {
  return {
    eligibleLand: 0,
    tree: 0,
    flax: 0,
    deer: 0,
    wolf: 0,
    stone: 0,
    ogre: 0
  };
}

function closestFactorPair(value: number): readonly [number, number] {
  let lower = Math.floor(Math.sqrt(value));
  while (lower > 1 && value % lower !== 0) lower -= 1;
  return [lower, value / lower];
}

function safeFraction(value: number, total: number): number {
  return total === 0 ? 0 : value / total;
}

function normalizedEnvironmentText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-");
}

function includesAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function canonicalSampleCoordinate(value: number): number {
  const canonical = Number(value.toFixed(9));
  return Object.is(canonical, -0) ? 0 : canonical;
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function toDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}
