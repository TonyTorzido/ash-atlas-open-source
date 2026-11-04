import {
  HOLLIN_HUT_TARGET_AREA_KM2,
  POPULATION_BALANCE,
  type AnimalMobArchetype,
  type DeerFamilyArchetype,
  type MobArchetypeKey,
  type WorldTimePhase
} from "@ash-atlas/shared";

import { MOB_DEFINITIONS } from "./combat/mobDefinitions.js";
import { hollinHutEligibleAreaKm2, isHollinHutAnchor } from "./populationV2HollinHutHabitat.js";
import {
  createLegacyPopulationV2MobIdentityAdapter,
  registeredPopulationV2MobIdentity,
  type LegacyPopulationV2MobIdentityAdapter,
  type PopulationV2MobSpawnModel,
  type RegisteredPopulationV2MobIdentity
} from "./populationV2MobIdentity.js";
import {
  POPULATION_V2_SPACING_CLASSES,
  type PopulationV2SpacingClass
} from "./populationV2MobSpacing.js";
import {
  deterministicUnit
} from "./populationZonesV2Identity.js";
import {
  POPULATION_V2_RESOURCE_KIND_DEFINITIONS,
  createPopulationV2KindRegistry,
  populationV2KindDefinitionForMob,
  type PopulationV2KindRegistry
} from "./populationV2KindRegistry.js";
import type {
  PopulationZoneV2Habitat,
  PopulationZoneV2HabitatCandidateSite,
  PopulationZoneV2SuppressionClass
} from "./populationV2HabitatTypes.js";
import type { PopulationZoneV2Point } from "./populationZonesV2Geometry.js";
import {
  POPULATION_V2_ENCOUNTER_SURFACES,
  type PopulationV2EncounterSurface
} from "./populationV2SurfaceTypes.js";
import type { EnvironmentSpawnPolicy } from "./environmentSpawnProfiles.js";

export type PopulationV2MobBehaviorCategory =
  | "passive"
  | "hostile"
  | "relentless";

export type PopulationV2MechanicalPhaseEligibility =
  | "ANY"
  | "DAY"
  | "NIGHT";

export type PopulationV2MobDensity =
  | Readonly<{
      model: "common";
      densityPerEligibleKm2: number;
      candidateOversamplingFactor: number;
    }>
  | Readonly<{
      model: "rare";
      targetAreaKm2: number;
      candidateOversamplingFactor: number;
    }>;

export type PopulationV2MobRolloutPolicy =
  | "next_generation_only"
  | "top_up_existing_generations";

export type PopulationV2MobGenerationPlacement =
  | "legacy_frozen"
  | "registered_overlay"
  | "encounter_table_v1";

export type PopulationV2MobCandidateMember = Readonly<{
  mobKind: string;
  memberIndex: number | null;
  position: PopulationZoneV2Point;
}>;

export type PopulationV2MobCandidateBlueprint = Readonly<{
  candidateId: string;
  mobKind: string;
  anchor: PopulationZoneV2Point;
  members: readonly PopulationV2MobCandidateMember[];
}>;

export type PopulationV2MobCandidateBuilder = (
  input: Readonly<{
    candidateId: string;
    anchor: PopulationZoneV2Point;
    memberPositions: readonly PopulationZoneV2Point[];
  }>
) => PopulationV2MobCandidateBlueprint;

export type PopulationV2MobPackFormation = Readonly<{
  allowedMemberCounts: readonly number[];
  memberCountForCandidate(candidateId: string): number;
  minimumRadiusM?: number;
  maximumRadiusM?: number;
  targetMinimumPairwiseSeparationM?: number;
}>;

export type PopulationV2MobDefinition<
  MobKind extends string = string,
  CombatArchetype extends string = string
> = Readonly<{
  mobKind: MobKind;
  combatArchetype: CombatArchetype;
  placementRevision: string;
  compatiblePlacementRevisions?: readonly string[];
  generationPlacement: PopulationV2MobGenerationPlacement;
  spawnModel: PopulationV2MobSpawnModel;
  behaviorCategory: PopulationV2MobBehaviorCategory;
  mechanicalPhaseEligibility: PopulationV2MechanicalPhaseEligibility;
  /** Optional exact world-clock phases for content such as dusk-and-night mobs. */
  worldTimePhaseEligibility?: readonly WorldTimePhase[];
  encounterSurface?: PopulationV2EncounterSurface;
  /**
   * Further surfaces a water mob also spawns on (a lake mob that also lives in rivers,
   * or a marsh frog that also has a land rule). Its spawn rules may use any of its surfaces.
   */
  additionalEncounterSurfaces?: readonly PopulationV2EncounterSurface[];
  /** Optional declarative geography policy for data-driven content seams. */
  habitatPolicy?: EnvironmentSpawnPolicy;
  plannerPriority: number;
  density: PopulationV2MobDensity;
  eligibleAreaKm2(habitat: PopulationZoneV2Habitat): number;
  isEligibleAnchor(site: PopulationZoneV2HabitatCandidateSite): boolean;
  candidateBuilder: PopulationV2MobCandidateBuilder;
  packFormation?: PopulationV2MobPackFormation;
  spacingClass: PopulationV2SpacingClass;
  suppressionClass: PopulationZoneV2SuppressionClass;
  clientPresentational: boolean;
  defaultRolloutPolicy: PopulationV2MobRolloutPolicy;
  existingGenerationRolloutEligible: boolean;
  diagnosticsLabel: string;
  legacyIdentity?: LegacyPopulationV2MobIdentityAdapter;
  allowSharedCombatArchetype?: boolean;
}>;

export type PopulationV2MobRegistryValidationOptions = Readonly<{
  supportedArchetypes?: ReadonlySet<string>;
  supportedSpacingClasses?: ReadonlySet<string>;
  supportedSuppressionClasses?: ReadonlySet<string>;
}>;

/** Every surface an encounter mob spawns on: its surface, then any additional water surfaces. */
export function populationV2MobEncounterSurfaces(
  definition: Pick<PopulationV2MobDefinition, "encounterSurface" | "additionalEncounterSurfaces">
): readonly PopulationV2EncounterSurface[] {
  if (definition.encounterSurface === undefined) return [];
  return definition.additionalEncounterSurfaces === undefined
    ? [definition.encounterSurface]
    : [definition.encounterSurface, ...definition.additionalEncounterSurfaces];
}

/** Returns whether a registered mob may be admitted during the exact world-clock phase. */
export function populationV2MobDefinitionIsEligibleAtWorldPhase(
  definition: Pick<PopulationV2MobDefinition, "worldTimePhaseEligibility">,
  phase: WorldTimePhase
): boolean {
  return definition.worldTimePhaseEligibility === undefined
    || definition.worldTimePhaseEligibility.includes(phase);
}

export class PopulationV2MobRegistry<
  Definition extends PopulationV2MobDefinition = PopulationV2MobDefinition
> {
  readonly definitions: readonly Definition[];
  readonly runtimeMobKinds: readonly Definition["mobKind"][];
  readonly runtimeArchetypes: readonly Definition["combatArchetype"][];
  readonly populationKinds: PopulationV2KindRegistry;
  private readonly byKind: ReadonlyMap<string, Definition>;

  constructor(
    definitions: readonly Definition[],
    options: PopulationV2MobRegistryValidationOptions = {}
  ) {
    validatePopulationV2MobDefinitions(definitions, options);
    this.definitions = Object.freeze([...definitions].sort(
      (left, right) =>
        left.plannerPriority - right.plannerPriority
        || left.mobKind.localeCompare(right.mobKind)
    ));
    this.byKind = new Map(this.definitions.map((definition) => [
      definition.mobKind,
      definition
    ]));
    this.runtimeMobKinds = Object.freeze(this.definitions.map(
      (definition) => definition.mobKind
    ));
    this.runtimeArchetypes = Object.freeze([...new Set(this.definitions.map(
      (definition) => definition.combatArchetype
    ))]);
    this.populationKinds = createPopulationV2KindRegistry([
      ...POPULATION_V2_RESOURCE_KIND_DEFINITIONS,
      ...this.definitions.map(populationV2KindDefinitionForMob)
    ]);
  }

  definitionForKind(kind: string): Definition | undefined {
    return this.byKind.get(kind);
  }

  requireDefinition(kind: string): Definition {
    const definition = this.definitionForKind(kind);
    if (definition === undefined) {
      throw new Error(`unsupported Population V2 mob kind ${kind}`);
    }
    return definition;
  }

  registeredIdentityFor(input: Readonly<{
    generationId: string;
    mobKind: string;
    deterministicCandidateId: string;
    memberIndex?: number | null;
  }>): RegisteredPopulationV2MobIdentity {
    const definition = this.requireDefinition(input.mobKind);
    return registeredPopulationV2MobIdentity({
      ...input,
      mobKind: definition.mobKind,
      placementRevision: definition.placementRevision,
      spawnModel: definition.spawnModel
    });
  }
}

export function createPopulationV2MobRegistry<
  Definition extends PopulationV2MobDefinition
>(
  definitions: readonly Definition[],
  options: PopulationV2MobRegistryValidationOptions = {}
): PopulationV2MobRegistry<Definition> {
  return new PopulationV2MobRegistry(definitions, options);
}

export function validatePopulationV2MobDefinitions(
  definitions: readonly PopulationV2MobDefinition[],
  options: PopulationV2MobRegistryValidationOptions = {}
): void {
  if (definitions.length === 0) {
    throw new Error("Population V2 mob registry cannot be empty");
  }
  const supportedArchetypes = options.supportedArchetypes
    ?? new Set(Object.keys(MOB_DEFINITIONS));
  const supportedSpacingClasses = options.supportedSpacingClasses
    ?? new Set(POPULATION_V2_SPACING_CLASSES);
  const supportedSuppressionClasses = options.supportedSuppressionClasses
    ?? new Set(["none", "deer-safe", "hostile-pack", "hostile-ogre"]);
  const byKind = new Map<string, PopulationV2MobDefinition>();
  const byArchetype = new Map<string, PopulationV2MobDefinition[]>();
  for (const definition of definitions) {
    if (
      definition.mobKind.length > 64
      || !/^[a-z][a-z0-9_]*$/u.test(definition.mobKind)
    ) {
      throw new Error(`invalid Population V2 mob kind ${definition.mobKind}`);
    }
    if (byKind.has(definition.mobKind)) {
      throw new Error(`duplicate Population V2 mob kind ${definition.mobKind}`);
    }
    byKind.set(definition.mobKind, definition);
    if (!supportedArchetypes.has(definition.combatArchetype)) {
      throw new Error(
        `unsupported Population V2 combat archetype ${definition.combatArchetype}`
      );
    }
    const archetypeOwners = byArchetype.get(definition.combatArchetype) ?? [];
    archetypeOwners.push(definition);
    byArchetype.set(definition.combatArchetype, archetypeOwners);
    if (definition.placementRevision.trim().length === 0) {
      throw new Error(
        `Population V2 mob ${definition.mobKind} has no placement revision`
      );
    }
    if (
      definition.generationPlacement !== "legacy_frozen"
      && definition.generationPlacement !== "registered_overlay"
      && definition.generationPlacement !== "encounter_table_v1"
    ) {
      throw new Error(
        `Population V2 mob ${definition.mobKind} generation placement is invalid`
      );
    }
    if (
      definition.mechanicalPhaseEligibility !== "ANY"
      && definition.mechanicalPhaseEligibility !== "DAY"
      && definition.mechanicalPhaseEligibility !== "NIGHT"
    ) {
      throw new Error(
        `Population V2 mob ${definition.mobKind} mechanical phase eligibility is invalid`
      );
    }
    if (definition.worldTimePhaseEligibility?.some((phase) =>
      phase !== "day" && phase !== "dusk" && phase !== "night" && phase !== "dawn"
    )) {
      throw new Error(
        `Population V2 mob ${definition.mobKind} has invalid world-time phase eligibility`
      );
    }
    if (definition.compatiblePlacementRevisions?.some((revision) =>
      revision.trim().length === 0 || revision === definition.placementRevision
    )) {
      throw new Error(
        `Population V2 mob ${definition.mobKind} compatible placement revision is invalid`
      );
    }
    if (
      definition.generationPlacement === "encounter_table_v1"
      && definition.encounterSurface === undefined
    ) {
      throw new Error(
        `Population V2 encounter mob ${definition.mobKind} has no surface`
      );
    }
    const additionalSurfaces = definition.additionalEncounterSurfaces;
    if (additionalSurfaces !== undefined && (
      definition.encounterSurface === undefined
      || definition.encounterSurface === "land"
      || additionalSurfaces.length === 0
      || new Set(additionalSurfaces).size !== additionalSurfaces.length
      || additionalSurfaces.some((surface) =>
        surface === definition.encounterSurface
        || !(POPULATION_V2_ENCOUNTER_SURFACES as readonly string[]).includes(surface))
    )) {
      throw new Error(
        `Population V2 mob ${definition.mobKind} additional surfaces must be other surfaces of a water mob`
      );
    }
    if (
      !Number.isSafeInteger(definition.plannerPriority)
      || definition.plannerPriority < 0
    ) {
      throw new Error(
        `Population V2 mob ${definition.mobKind} planner priority is invalid`
      );
    }
    validateDensity(definition);
    if (!supportedSpacingClasses.has(definition.spacingClass)) {
      throw new Error(
        `unsupported Population V2 spacing class ${definition.spacingClass}`
      );
    }
    if (!supportedSuppressionClasses.has(definition.suppressionClass)) {
      throw new Error(
        `unsupported Population V2 suppression class ${definition.suppressionClass}`
      );
    }
    if (
      definition.diagnosticsLabel.trim().length === 0
      || (
        definition.defaultRolloutPolicy === "top_up_existing_generations"
        && !definition.existingGenerationRolloutEligible
      )
    ) {
      throw new Error(
        `Population V2 mob ${definition.mobKind} rollout metadata is invalid`
      );
    }
    validateLegacyIdentity(definition);
    validateCandidateBuilder(definition);
    const areaKm2 = definition.eligibleAreaKm2(VALIDATION_HABITAT);
    if (!Number.isFinite(areaKm2) || areaKm2 < 0) {
      throw new Error(
        `Population V2 mob ${definition.mobKind} habitat area is invalid`
      );
    }
    if (typeof definition.isEligibleAnchor(VALIDATION_CANDIDATE_SITE)
      !== "boolean") {
      throw new Error(
        `Population V2 mob ${definition.mobKind} anchor eligibility is invalid`
      );
    }
  }
  for (const [archetype, owners] of byArchetype) {
    if (
      owners.length > 1
      && owners.some((owner) => owner.allowSharedCombatArchetype !== true)
    ) {
      throw new Error(
        `duplicate Population V2 combat archetype ownership ${archetype}`
      );
    }
  }
}

export function createSinglePopulationV2MobCandidateBuilder(
  mobKind: string
): PopulationV2MobCandidateBuilder {
  return (input) => ({
    candidateId: input.candidateId,
    mobKind,
    anchor: input.anchor,
    members: [{
      mobKind,
      memberIndex: null,
      position: input.anchor
    }]
  });
}

export function createPackPopulationV2MobCandidateBuilder(
  mobKind: string,
  formation: PopulationV2MobPackFormation
): PopulationV2MobCandidateBuilder {
  return (input) => {
    const memberCount = formation.memberCountForCandidate(input.candidateId);
    if (input.memberPositions.length < memberCount) {
      throw new Error(
        `Population V2 ${mobKind} candidate has insufficient formation sites`
      );
    }
    return {
      candidateId: input.candidateId,
      mobKind,
      anchor: input.anchor,
      members: input.memberPositions
        .slice(0, memberCount)
        .map((position, memberIndex) => ({
          mobKind,
          memberIndex,
          position
        }))
    };
  };
}

const VALIDATION_HABITAT: PopulationZoneV2Habitat = {
  regionCode: "population-v2-registry-validation",
  eligibleLandKm2: 1,
  treeKm2: 1,
  deerKm2: 1,
  wolfKm2: 1,
  stoneKm2: 1,
  ogreKm2: 1,
  habitatSummary: {},
  environmentSnapshot: {}
};

const VALIDATION_CANDIDATE_SITE: PopulationZoneV2HabitatCandidateSite = {
  siteId: "population-v2-registry-validation",
  position: { lat: 0, lon: 0 },
  source: "synthetic-sample-center",
  sourceSampleId: "population-v2-registry-validation",
  sourceCellId: null,
  sourceSlotId: null,
  candidateSlotVersion: null,
  placementTags: [],
  isSaltwater: false,
  insideMajorLake: false,
  elevationBand: null,
  terrainClass: null,
  landCoverClass: null,
  biomeId: null,
  ecoregionId: null,
  spawnProfileKey: "population-v2-registry-validation",
  weights: {
    eligibleLand: 1,
    tree: 1,
    deer: 1,
    wolf: 1,
    stone: 1,
    ogre: 1
  }
};

const WOLF_PACK_FORMATION: PopulationV2MobPackFormation = Object.freeze({
  allowedMemberCounts: Object.freeze([2, 3]),
  minimumRadiusM: 46,
  maximumRadiusM: 50,
  targetMinimumPairwiseSeparationM: 55,
  memberCountForCandidate(candidateId) {
    return populationGroupSize(
      POPULATION_BALANCE.wolfPackSize,
      POPULATION_BALANCE.wolfPackSize.rollNamespace,
      candidateId
    );
  }
});

const DEER_GROUP_FORMATION: PopulationV2MobPackFormation = Object.freeze({
  allowedMemberCounts: Object.freeze([1, 2, 3]),
  minimumRadiusM: 30,
  maximumRadiusM: 45,
  targetMinimumPairwiseSeparationM: 25,
  memberCountForCandidate(candidateId) {
    return populationGroupSize(
      POPULATION_BALANCE.deerGroupSize,
      POPULATION_BALANCE.deerGroupSize.rollNamespace,
      candidateId
    );
  }
});

const SAP_CRAWLER_FORMATION: PopulationV2MobPackFormation = Object.freeze({
  allowedMemberCounts: Object.freeze([3, 4]),
  minimumRadiusM: 18,
  maximumRadiusM: 30,
  targetMinimumPairwiseSeparationM: 15,
  memberCountForCandidate(candidateId) {
    return populationGroupSize(
      POPULATION_BALANCE.sapCrawlerGroupSize,
      POPULATION_BALANCE.sapCrawlerGroupSize.rollNamespace,
      candidateId
    );
  }
});

/**
 * A biome Deer variant, or a new animal on the Deer template: Deer's exact
 * placement shape (group formation, density, spacing, suppression) under its
 * own kind. Which biome rolls which kind is decided by the land encounter table
 * (populationV2EncounterTables.ts), so the anchor gate stays the plain Deer
 * habitat weight.
 */
function deerVariantPopulationDefinition<
  Kind extends Exclude<DeerFamilyArchetype, "deer"> | AnimalMobArchetype
>(mobKind: Kind, diagnosticsLabel: string) {
  return {
    mobKind,
    combatArchetype: mobKind,
    placementRevision: `encounter-v1-${mobKind.replaceAll("_", "-")}-formation-v1`,
    generationPlacement: "encounter_table_v1",
    spawnModel: "pack",
    behaviorCategory: "passive",
    mechanicalPhaseEligibility: "ANY",
    encounterSurface: "land",
    plannerPriority: 10,
    density: {
      model: "common",
      ...POPULATION_BALANCE.common.deer_group
    },
    eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) => habitat.deerKm2,
    isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
      site.weights.deer > 0,
    candidateBuilder: createPackPopulationV2MobCandidateBuilder(
      mobKind,
      DEER_GROUP_FORMATION
    ),
    packFormation: DEER_GROUP_FORMATION,
    spacingClass: "passive_single",
    suppressionClass: "deer-safe",
    clientPresentational: true,
    defaultRolloutPolicy: "next_generation_only",
    existingGenerationRolloutEligible: false,
    diagnosticsLabel
  } as const;
}

/**
 * A biome variant of Wolf, Hog, Bear, Coastal Crab, Frog or Alligator: its
 * base's exact placement shape (surface, formation, density, spacing,
 * suppression) under its own kind. Which biome rolls which variant is decided by
 * the encounter tables (populationV2EncounterTables.ts), so the anchor gate
 * stays the base's.
 */
function biomeVariantPopulationDefinition<
  const Base extends Readonly<{
    mobKind: MobArchetypeKey;
    placementRevision: string;
    packFormation?: PopulationV2MobPackFormation;
  }>,
  const Kind extends MobArchetypeKey
>(base: Base, mobKind: Kind, diagnosticsLabel: string) {
  // Variants have no legacy identity or historical placement revisions.
  const shape: Record<string, unknown> = { ...base };
  delete shape.legacyIdentity;
  delete shape.compatiblePlacementRevisions;
  return {
    ...shape,
    mobKind,
    combatArchetype: mobKind,
    placementRevision: base.placementRevision
      .replace(`-${base.mobKind.replaceAll("_", "-")}-`, `-${mobKind.replaceAll("_", "-")}-`)
      .replace(/-v\d+$/u, "-v1"),
    candidateBuilder: base.packFormation === undefined
      ? createSinglePopulationV2MobCandidateBuilder(mobKind)
      : createPackPopulationV2MobCandidateBuilder(mobKind, base.packFormation),
    diagnosticsLabel
  } as unknown as BiomeVariantPopulationDefinition<Base, Kind>;
}

type BiomeVariantPopulationDefinition<Base, Kind extends MobArchetypeKey> = Omit<
  Base,
  | "mobKind" | "combatArchetype" | "placementRevision" | "candidateBuilder"
  | "diagnosticsLabel" | "legacyIdentity" | "compatiblePlacementRevisions"
> & Readonly<{
  mobKind: Kind;
  combatArchetype: Kind;
  placementRevision: string;
  candidateBuilder: PopulationV2MobCandidateBuilder;
  diagnosticsLabel: string;
}>;

const WOLF_POPULATION_DEFINITION = {
  mobKind: "wolf",
  combatArchetype: "wolf",
  placementRevision: "encounter-v1-wolf-formation-v2",
  compatiblePlacementRevisions: [
    "encounter-v1-wolf-formation-v1",
    "legacy-wolf-pack-placement-v1"
  ],
  generationPlacement: "encounter_table_v1",
  spawnModel: "pack",
  behaviorCategory: "hostile",
  mechanicalPhaseEligibility: "ANY",
  encounterSurface: "land",
  plannerPriority: 20,
  density: {
    model: "common",
    ...POPULATION_BALANCE.common.wolf_pack
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) => habitat.wolfKm2,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.weights.wolf > 0,
  candidateBuilder: createPackPopulationV2MobCandidateBuilder(
    "wolf",
    WOLF_PACK_FORMATION
  ),
  packFormation: WOLF_PACK_FORMATION,
  spacingClass: "hostile_pack",
  suppressionClass: "hostile-pack",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Wolf pack",
  legacyIdentity: createLegacyPopulationV2MobIdentityAdapter({
    planKind: "wolf_pack",
    entityKind: "wolf",
    spawnModel: "pack"
  })
} as const;

const HOG_POPULATION_DEFINITION = {
  mobKind: "hog",
  combatArchetype: "hog",
  placementRevision: "encounter-v1-hog-single-v1",
  generationPlacement: "encounter_table_v1",
  spawnModel: "single",
  behaviorCategory: "hostile",
  mechanicalPhaseEligibility: "ANY",
  encounterSurface: "land",
  plannerPriority: 40,
  density: {
    model: "common",
    densityPerEligibleKm2: 1,
    candidateOversamplingFactor: 1
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.land ?? habitat.eligibleLandKm2,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "land" || (
      site.surfaceType === undefined
      && !site.isSaltwater
      && !site.insideMajorLake
      && site.weights.eligibleLand > 0
    ),
  candidateBuilder: createSinglePopulationV2MobCandidateBuilder("hog"),
  spacingClass: "large_hostile",
  suppressionClass: "hostile-ogre",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Hog"
} as const;

const BEAR_POPULATION_DEFINITION = {
  mobKind: "bear",
  combatArchetype: "bear",
  placementRevision: "encounter-v1-bear-single-v1",
  generationPlacement: "encounter_table_v1",
  spawnModel: "single",
  behaviorCategory: "hostile",
  mechanicalPhaseEligibility: "ANY",
  encounterSurface: "land",
  plannerPriority: 35,
  density: {
    model: "common",
    densityPerEligibleKm2: 1,
    candidateOversamplingFactor: 1
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.land ?? habitat.eligibleLandKm2,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "land" || (
      site.surfaceType === undefined
      && !site.isSaltwater
      && !site.insideMajorLake
      && site.weights.eligibleLand > 0
    ),
  candidateBuilder: createSinglePopulationV2MobCandidateBuilder("bear"),
  spacingClass: "large_hostile",
  suppressionClass: "hostile-ogre",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Bear"
} as const;

const COASTAL_CRAB_POPULATION_DEFINITION = {
  mobKind: "coastal_crab",
  combatArchetype: "coastal_crab",
  placementRevision: "encounter-v1-coastal-crab-single-v1",
  generationPlacement: "encounter_table_v1",
  spawnModel: "single",
  behaviorCategory: "hostile",
  mechanicalPhaseEligibility: "ANY",
  encounterSurface: "land",
  plannerPriority: 42,
  density: {
    model: "common",
    densityPerEligibleKm2: 1,
    candidateOversamplingFactor: 1
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.land ?? habitat.eligibleLandKm2,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "land" && site.placementTags.includes("coastal-land"),
  candidateBuilder: createSinglePopulationV2MobCandidateBuilder("coastal_crab"),
  spacingClass: "passive_single",
  suppressionClass: "none",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Coastal Crab"
} as const;

const FROG_POPULATION_DEFINITION = {
  mobKind: "frog",
  combatArchetype: "frog",
  placementRevision: "encounter-v1-frog-lake-single-v1",
  generationPlacement: "encounter_table_v1",
  spawnModel: "single",
  behaviorCategory: "hostile",
  mechanicalPhaseEligibility: "ANY",
  encounterSurface: "lake",
  plannerPriority: 50,
  density: {
    model: "common",
    densityPerEligibleKm2: 1,
    candidateOversamplingFactor: 1
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.lake ?? 0,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "lake" || site.insideMajorLake,
  candidateBuilder: createSinglePopulationV2MobCandidateBuilder("frog"),
  spacingClass: "passive_single",
  suppressionClass: "none",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Frog"
} as const;

const ALLIGATOR_POPULATION_DEFINITION = {
  mobKind: "alligator",
  combatArchetype: "alligator",
  placementRevision: "encounter-v1-alligator-river-single-v1",
  generationPlacement: "encounter_table_v1",
  spawnModel: "single",
  behaviorCategory: "relentless",
  mechanicalPhaseEligibility: "ANY",
  encounterSurface: "river",
  plannerPriority: 60,
  density: {
    model: "common",
    densityPerEligibleKm2: 1,
    candidateOversamplingFactor: 1
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.river ?? 0,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "river" && site.surfaceAuthority != null,
  candidateBuilder:
    createSinglePopulationV2MobCandidateBuilder("alligator"),
  spacingClass: "large_hostile",
  suppressionClass: "none",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Alligator"
} as const;

const OGRE_POPULATION_DEFINITION = {
  mobKind: "ogre",
  combatArchetype: "ogre",
  placementRevision: "encounter-v1-ogre-single-v1",
  compatiblePlacementRevisions: ["legacy-ogre-placement-v1"],
  generationPlacement: "encounter_table_v1",
  spawnModel: "single",
  behaviorCategory: "relentless",
  mechanicalPhaseEligibility: "ANY",
  encounterSurface: "land",
  plannerPriority: 30,
  density: {
    model: "rare",
    ...POPULATION_BALANCE.rare.ogre
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) => habitat.ogreKm2,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.weights.ogre > 0,
  candidateBuilder: createSinglePopulationV2MobCandidateBuilder("ogre"),
  spacingClass: "large_hostile",
  suppressionClass: "hostile-ogre",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Ogre",
  legacyIdentity: createLegacyPopulationV2MobIdentityAdapter({
    planKind: "ogre",
    entityKind: "ogre",
    spawnModel: "single"
  })
} as const;

/**
 * Hollin Hut: an independently budgeted overlay on any dry land, planned after the frozen baseline so it
 * never takes from mob or node budgets. The hut body is the Population V2 entity; HollinHutService
 * owns everything else (shop, guards, orchard, respawn) keyed by the hut id derived from its identity.
 */
const HOLLIN_HUT_POPULATION_DEFINITION = {
  mobKind: "hollin_hut",
  combatArchetype: "hollin_hut",
  // v2: huts may stand on any dry land, not only farmland biomes. v1 slots stay servable.
  placementRevision: "overlay-v1-hollin-hut-single-v2",
  compatiblePlacementRevisions: ["overlay-v1-hollin-hut-single-v1"],
  generationPlacement: "registered_overlay",
  spawnModel: "single",
  behaviorCategory: "passive",
  mechanicalPhaseEligibility: "ANY",
  plannerPriority: 90,
  density: {
    model: "rare",
    targetAreaKm2: HOLLIN_HUT_TARGET_AREA_KM2,
    candidateOversamplingFactor: 3
  },
  eligibleAreaKm2: hollinHutEligibleAreaKm2,
  isEligibleAnchor: isHollinHutAnchor,
  candidateBuilder: createSinglePopulationV2MobCandidateBuilder("hollin_hut"),
  spacingClass: "settlement_hut",
  suppressionClass: "none",
  clientPresentational: true,
  defaultRolloutPolicy: "top_up_existing_generations",
  existingGenerationRolloutEligible: true,
  diagnosticsLabel: "Hollin Hut"
} as const;

const SAP_CRAWLER_POPULATION_DEFINITION = {
  mobKind: "sap_crawler",
  combatArchetype: "sap_crawler",
  placementRevision: "encounter-v1-sap-crawler-formation-v2",
  compatiblePlacementRevisions: [
    "encounter-v1-sap-crawler-formation-v1",
    "sap-crawler-group-formation-v2",
    "sap-crawler-flat-anchor-v1"
  ],
  generationPlacement: "encounter_table_v1",
  spawnModel: "pack",
  behaviorCategory: "hostile",
  mechanicalPhaseEligibility: "ANY",
  encounterSurface: "land",
  plannerPriority: 100,
  density: {
    model: "rare",
    ...POPULATION_BALANCE.rare.sap_crawler_group
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.eligibleLandKm2,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.weights.eligibleLand > 0,
  candidateBuilder: createPackPopulationV2MobCandidateBuilder(
    "sap_crawler",
    SAP_CRAWLER_FORMATION
  ),
  packFormation: SAP_CRAWLER_FORMATION,
  spacingClass: "small_hostile_pack",
  suppressionClass: "hostile-pack",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Resin Crawler group",
  legacyIdentity: createLegacyPopulationV2MobIdentityAdapter({
    planKind: "sap_crawler_group",
    entityKind: "sap_crawler",
    spawnModel: "pack",
    sapGenerationMaterialization: true
  })
} as const;

const SKELETON_POPULATION_DEFINITION = {
  mobKind: "skeleton",
  combatArchetype: "skeleton",
  placementRevision: "encounter-v1-skeleton-single-v1",
  generationPlacement: "encounter_table_v1",
  spawnModel: "single",
  behaviorCategory: "hostile",
  mechanicalPhaseEligibility: "ANY",
  worldTimePhaseEligibility: ["dusk", "night"],
  encounterSurface: "land",
  plannerPriority: 45,
  density: {
    model: "common",
    densityPerEligibleKm2: 1,
    candidateOversamplingFactor: 1
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.land ?? habitat.eligibleLandKm2,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "land" || (
      site.surfaceType === undefined
      && !site.isSaltwater
      && !site.insideMajorLake
      && site.weights.eligibleLand > 0
    ),
  candidateBuilder: createSinglePopulationV2MobCandidateBuilder("skeleton"),
  spacingClass: "large_hostile",
  suppressionClass: "hostile-ogre",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Skeleton"
} as const;

const SQUID_POPULATION_DEFINITION = {
  mobKind: "squid",
  combatArchetype: "squid",
  placementRevision: "encounter-v1-squid-ocean-single-v1",
  generationPlacement: "encounter_table_v1",
  spawnModel: "single",
  behaviorCategory: "relentless",
  mechanicalPhaseEligibility: "ANY",
  encounterSurface: "ocean",
  plannerPriority: 70,
  density: {
    model: "common",
    densityPerEligibleKm2: 1,
    candidateOversamplingFactor: 1
  },
  eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
    habitat.surfaceAreaKm2?.ocean ?? 0,
  isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
    site.surfaceType === "ocean" || site.isSaltwater,
  candidateBuilder: createSinglePopulationV2MobCandidateBuilder("squid"),
  spacingClass: "large_hostile",
  suppressionClass: "none",
  clientPresentational: true,
  defaultRolloutPolicy: "next_generation_only",
  existingGenerationRolloutEligible: false,
  diagnosticsLabel: "Squid"
} as const;

/** Water game phase B: a Shellback herd is always three (docs/design/WATER_GAME_PLAN.md). */
const SHELLBACK_HERD_FORMATION: PopulationV2MobPackFormation = Object.freeze({
  allowedMemberCounts: Object.freeze([3]),
  minimumRadiusM: 30,
  maximumRadiusM: 45,
  targetMinimumPairwiseSeparationM: 25,
  memberCountForCandidate: () => 3
});

/** Darters roam in spaced packs of two or three. */
const DARTER_PACK_FORMATION: PopulationV2MobPackFormation = Object.freeze({
  allowedMemberCounts: Object.freeze([2, 3]),
  minimumRadiusM: 46,
  maximumRadiusM: 50,
  targetMinimumPairwiseSeparationM: 55,
  memberCountForCandidate: (candidateId: string) =>
    deterministicUnit("population-v2-darter-pack-size-v1", candidateId) < 0.5 ? 2 : 3
});

/** An ocean pack: the Squid's sea placement with a group formation. */
function oceanPackPopulationDefinition<const Kind extends "shellback" | "darter">(
  mobKind: Kind,
  diagnosticsLabel: string,
  formation: PopulationV2MobPackFormation
) {
  return {
    ...biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, mobKind, diagnosticsLabel),
    placementRevision: `encounter-v1-${mobKind}-ocean-formation-v1`,
    spawnModel: "pack",
    behaviorCategory: "passive",
    candidateBuilder: createPackPopulationV2MobCandidateBuilder(mobKind, formation),
    packFormation: formation
  } as const;
}

/** The Skeleton's placement shape without its dusk-and-night admission. */
const SKELETON_SHAPE_ANY_TIME = (() => {
  const shape: Record<string, unknown> = { ...SKELETON_POPULATION_DEFINITION };
  delete shape.worldTimePhaseEligibility;
  return shape as unknown as Omit<typeof SKELETON_POPULATION_DEFINITION, "worldTimePhaseEligibility">;
})();

export const POPULATION_V2_MOB_DEFINITIONS = [
  {
    mobKind: "deer",
    combatArchetype: "deer",
    placementRevision: "encounter-v1-deer-formation-v2",
    compatiblePlacementRevisions: [
      "encounter-v1-deer-formation-v1",
      "deer-group-formation-v2"
    ],
    generationPlacement: "encounter_table_v1",
    spawnModel: "pack",
    behaviorCategory: "passive",
    mechanicalPhaseEligibility: "ANY",
    encounterSurface: "land",
    plannerPriority: 10,
    density: {
      model: "common",
      ...POPULATION_BALANCE.common.deer_group
    },
    eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) => habitat.deerKm2,
    isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
      site.weights.deer > 0,
    candidateBuilder: createPackPopulationV2MobCandidateBuilder(
      "deer",
      DEER_GROUP_FORMATION
    ),
    packFormation: DEER_GROUP_FORMATION,
    spacingClass: "passive_single",
    suppressionClass: "deer-safe",
    clientPresentational: true,
    defaultRolloutPolicy: "next_generation_only",
    existingGenerationRolloutEligible: false,
    diagnosticsLabel: "Deer",
    legacyIdentity: createLegacyPopulationV2MobIdentityAdapter({
      planKind: "deer",
      entityKind: "deer",
      spawnModel: "single"
    })
  },
  deerVariantPopulationDefinition("frost_deer", "Frost Deer"),
  deerVariantPopulationDefinition("jungle_deer", "Jungle Deer"),
  deerVariantPopulationDefinition("marsh_deer", "Marsh Deer"),
  deerVariantPopulationDefinition("sand_deer", "Sand Deer"),
  WOLF_POPULATION_DEFINITION,
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "frost_wolf", "Frost Wolf pack"),
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "dune_wolf", "Dune Wolf pack"),
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "jungle_wolf", "Jungle Wolf pack"),
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "bog_wolf", "Bog Wolf pack"),
  OGRE_POPULATION_DEFINITION,
  BEAR_POPULATION_DEFINITION,
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "snow_bear", "Snow Bear"),
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "black_bear", "Black Bear"),
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "sun_bear", "Sun Bear"),
  {
    mobKind: "mysterious_traveler",
    combatArchetype: "mysterious_traveler",
    placementRevision: "encounter-v1-mysterious-traveler-single-v1",
    generationPlacement: "encounter_table_v1",
    spawnModel: "single",
    behaviorCategory: "hostile",
    mechanicalPhaseEligibility: "NIGHT",
    encounterSurface: "land",
    plannerPriority: 37,
    density: {
      model: "common",
      densityPerEligibleKm2: 1,
      candidateOversamplingFactor: 1
    },
    eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
      habitat.surfaceAreaKm2?.land ?? habitat.eligibleLandKm2,
    isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
      site.surfaceType === "land" || (
        site.surfaceType === undefined
        && !site.isSaltwater
        && !site.insideMajorLake
        && site.weights.eligibleLand > 0
      ),
    candidateBuilder:
      createSinglePopulationV2MobCandidateBuilder("mysterious_traveler"),
    spacingClass: "large_hostile",
    suppressionClass: "hostile-ogre",
    clientPresentational: true,
    defaultRolloutPolicy: "next_generation_only",
    existingGenerationRolloutEligible: false,
    diagnosticsLabel: "Mysterious Traveler"
  },
  SAP_CRAWLER_POPULATION_DEFINITION,
  HOG_POPULATION_DEFINITION,
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "woolly_hog", "Woolly Hog"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "warthog", "Warthog"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "jungle_hog", "Jungle Hog"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "mud_hog", "Mud Hog"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "javelina", "Javelina"),
  SKELETON_POPULATION_DEFINITION,
  COASTAL_CRAB_POPULATION_DEFINITION,
  biomeVariantPopulationDefinition(COASTAL_CRAB_POPULATION_DEFINITION, "ice_crab", "Ice Crab"),
  biomeVariantPopulationDefinition(COASTAL_CRAB_POPULATION_DEFINITION, "sand_crab", "Sand Crab"),
  biomeVariantPopulationDefinition(COASTAL_CRAB_POPULATION_DEFINITION, "mangrove_crab", "Mangrove Crab"),
  { ...FROG_POPULATION_DEFINITION, additionalEncounterSurfaces: ["land"] },
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "frost_frog", "Frost Frog"),
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "poison_frog", "Poison Frog"),
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "desert_toad", "Desert Toad"),
  { ...ALLIGATOR_POPULATION_DEFINITION, additionalEncounterSurfaces: ["land"] },
  biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "caiman", "Caiman"),
  biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "crocodile", "Crocodile"),
  SQUID_POPULATION_DEFINITION,
  {
    mobKind: "jellyfish",
    combatArchetype: "jellyfish",
    placementRevision: "encounter-v1-jellyfish-ocean-single-v1",
    generationPlacement: "encounter_table_v1",
    spawnModel: "single",
    behaviorCategory: "relentless",
    mechanicalPhaseEligibility: "ANY",
    encounterSurface: "ocean",
    plannerPriority: 75,
    density: {
      model: "common",
      densityPerEligibleKm2: 1,
      candidateOversamplingFactor: 1
    },
    eligibleAreaKm2: (habitat: PopulationZoneV2Habitat) =>
      habitat.surfaceAreaKm2?.ocean ?? 0,
    isEligibleAnchor: (site: PopulationZoneV2HabitatCandidateSite) =>
      site.surfaceType === "ocean" || site.isSaltwater,
    candidateBuilder:
      createSinglePopulationV2MobCandidateBuilder("jellyfish"),
    spacingClass: "large_hostile",
    suppressionClass: "none",
    clientPresentational: true,
    defaultRolloutPolicy: "next_generation_only",
    existingGenerationRolloutEligible: false,
    diagnosticsLabel: "Jellyfish"
  },
  HOLLIN_HUT_POPULATION_DEFINITION,
  // World fantasy mobs (FANTASY_MOB_TEMPLATES) take their template's exact
  // placement shape under their own kind, like biome variants; the land
  // encounter table adds them in their biomes on top of the usual mobs. Undead
  // keep the Skeleton's dusk-and-night admission; Lizardfolk are not undead.
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "frost_wraith", "Frost Wraith"),
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "yeti", "Yeti"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "barrow_wight", "Barrow Wight"),
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "moss_golem", "Moss Golem"),
  biomeVariantPopulationDefinition(SAP_CRAWLER_POPULATION_DEFINITION, "vine_lurker", "Vine Lurker group"),
  biomeVariantPopulationDefinition(
    SKELETON_SHAPE_ANY_TIME, "lizardfolk_warrior", "Lizardfolk Warrior"
  ),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "bog_ghoul", "Bog Ghoul"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "giant_scorpion", "Giant Scorpion"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "dust_mummy", "Dust Mummy"),
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "thunderhorn", "Thunderhorn"),
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "griffin", "Griffin pack"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "basilisk", "Basilisk"),
  // Bandit and Orc Brute keep their own combat definitions and spawn as
  // single hostile land mobs with the Hog's placement shape.
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "bandit", "Bandit"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "orc_brute", "Orc Brute"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "jungle_tapir", "Jungle Tapir"),
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "jaguar", "Jaguar"),
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "mandrill", "Mandrill pack"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "canopy_goblin", "Canopy Goblin"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "poisonfrog_raider", "Poisonfrog Raider"),
  { ...biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "pantherfolk_stalker", "Pantherfolk Stalker"), worldTimePhaseEligibility: ["dusk", "night"] },
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "vine_wrapped_corpse", "Vine-Wrapped Corpse"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "serpent_priestess", "Serpent Priestess"),
  deerVariantPopulationDefinition("capercaillie", "Capercaillie"),
  { ...biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "bugbear_chieftain", "Bugbear Chieftain"), worldTimePhaseEligibility: ["dusk", "night"] },
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "pinewarden", "Pinewarden"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "gallows_ghost", "Gallows Ghost"),
  { ...biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "alder_king", "Alder King"), worldTimePhaseEligibility: ["dusk", "night"] },
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "elk", "Elk"),
  deerVariantPopulationDefinition("red_squirrel", "Red Squirrel"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "pine_dryad", "Pine Dryad"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "badger", "Badger"),
  deerVariantPopulationDefinition("grey_squirrel", "Grey Squirrel"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "stag_beetle", "Stag Beetle"),
  biomeVariantPopulationDefinition(SAP_CRAWLER_POPULATION_DEFINITION, "mossjaw_sneak", "Mossjaw Sneak group"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "mossjaw_spearman", "Mossjaw Spearman"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "mossjaw_hexer", "Mossjaw Hexer"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "mossjaw_warboss", "Mossjaw Warboss"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "hedge_witch", "Hedge Witch"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "restless_gravedigger", "Restless Gravedigger"),
  { ...biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "coven_matron", "Coven Matron"), worldTimePhaseEligibility: ["dusk", "night"] },
  { ...biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "great_grey_owl", "Great Grey Owl"), worldTimePhaseEligibility: ["dusk", "night"] },
  { ...deerVariantPopulationDefinition("flying_squirrel", "Flying Squirrel"), worldTimePhaseEligibility: ["dusk", "night"] },
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "stagfolk_warden", "Stagfolk Warden"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "rime_witch", "Rime Witch"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "draugr_berserker", "Draugr Berserker"),
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "snow_talonbear", "Snow Talonbear"),
  biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "frostwater_troll", "Frostwater Troll"),
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "underice_lurker", "Underice Lurker"),
  deerVariantPopulationDefinition("plains_bison", "Plains Bison"),
  deerVariantPopulationDefinition("prairie_dog", "Prairie Dog"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "burrowing_owl", "Burrowing Owl"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "centaur_outrider", "Centaur Outrider"),
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "volt_elemental", "Volt Elemental"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "possessed_scythe", "Possessed Scythe"),
  { ...biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "strawman_lord", "Strawman Lord"), worldTimePhaseEligibility: ["dusk", "night"] },
  deerVariantPopulationDefinition("giraffe", "Giraffe"),
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "lioness", "Lioness pack"),
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "spotted_hyena", "Spotted Hyena pack"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "gnoll_bonebow", "Gnoll Bonebow"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "gnoll_packseer", "Gnoll Packseer"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "gnoll_packlord", "Gnoll Packlord"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "carrion_ghoul", "Carrion Ghoul"),
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "sun_griffin", "Sun Griffin pack"),
  deerVariantPopulationDefinition("sitatunga", "Sitatunga"),
  biomeVariantPopulationDefinition(SAP_CRAWLER_POPULATION_DEFINITION, "emperor_dragonfly", "Emperor Dragonfly group"),
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "frogfolk_tadpole", "Frogfolk Tadpole"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "frogfolk_blowgunner", "Frogfolk Blowgunner"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "frogfolk_shaman", "Frogfolk Shaman"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "frogfolk_chief", "Frogfolk Chief"),
  biomeVariantPopulationDefinition(SAP_CRAWLER_POPULATION_DEFINITION, "bloat_leech", "Bloat Leech group"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "bog_hag", "Bog Hag"),
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "leech_mother", "Leech Mother"),
  deerVariantPopulationDefinition("mountain_ibex", "Mountain Ibex"),
  deerVariantPopulationDefinition("wild_yak", "Wild Yak"),
  deerVariantPopulationDefinition("alpine_marmot", "Alpine Marmot"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "yakfolk_stonehorn", "Yakfolk Stonehorn"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "highland_reaver", "Highland Reaver"),
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "storm_harpy", "Storm Harpy pack"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "cairn_wight", "Cairn Wight"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "stormwing_chick", "Stormwing Chick"),
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "stormwing", "Stormwing"),
  deerVariantPopulationDefinition("wild_scrub_goat", "Wild Scrub Goat"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "crested_porcupine", "Crested Porcupine"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "spur_thighed_tortoise", "Spur-thighed Tortoise"),
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "cyclops_shepherd", "Cyclops Shepherd"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "skeleton_hoplite", "Skeleton Hoplite"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "tar_elemental", "Tar Elemental"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "olive_dryad", "Olive Dryad"),
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "chimera", "Chimera"),
  deerVariantPopulationDefinition("dromedary", "Dromedary"),
  { ...deerVariantPopulationDefinition("fennec_fox", "Fennec Fox"), worldTimePhaseEligibility: ["dusk", "night"] },
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "sidewinder", "Sidewinder"),
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "desert_lion", "Desert Lion pack"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "jackalfolk_skirmisher", "Jackalfolk Skirmisher"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "dune_goblin", "Dune Goblin"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "desert_marauder", "Desert Marauder"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "scorch_troll", "Scorch Troll"),
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "ember_giant", "Ember Giant"),
  deerVariantPopulationDefinition("saiga", "Saiga"),
  deerVariantPopulationDefinition("wild_horse", "Steppe Wild Horse"),
  deerVariantPopulationDefinition("steppe_marmot", "Steppe Marmot"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "steppe_raider", "Steppe Raider"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "steppe_horse_archer", "Steppe Horse Archer"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "salt_husk", "Salt Husk"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "kurgan_wight", "Kurgan Wight"),
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "centaur_khan", "Centaur Khan"),
  deerVariantPopulationDefinition("lemming", "Lemming"),
  deerVariantPopulationDefinition("snow_goose", "Snow Goose"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "frostborn_runecaster", "Frostborn Runecaster"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "frostborn_jarl", "Frostborn Jarl"),
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "permafrost_elemental", "Permafrost Elemental"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "draugr", "Draugr"),
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "mammoth_patriarch", "Mammoth Patriarch"),
  deerVariantPopulationDefinition("emperor_penguin", "Emperor Penguin"),
  deerVariantPopulationDefinition("peary_caribou", "Peary Caribou"),
  biomeVariantPopulationDefinition(SAP_CRAWLER_POPULATION_DEFINITION, "ice_worm", "Ice Worm group"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "rime_troll", "Rime Troll"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "aurora_shade", "Aurora Shade"),
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "blizzard_lord", "Blizzard Lord"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "sea_otter", "Sea Otter"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "herring_gull", "Herring Gull"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "spiny_lobster", "Spiny Lobster"),
  biomeVariantPopulationDefinition(COASTAL_CRAB_POPULATION_DEFINITION, "gillfolk_scout", "Gillfolk Scout"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "gillfolk_netter", "Gillfolk Netter"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "coral_golem", "Coral Golem"),
  biomeVariantPopulationDefinition(SKELETON_POPULATION_DEFINITION, "drowned_deckhand", "Drowned Deckhand"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "reef_kraken", "Reef Kraken"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "hammerhead_shark", "Hammerhead Shark"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "manta_ray", "Manta Ray"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "humpback_whale", "Humpback Whale"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "merfolk_harpooner", "Merfolk Harpooner"),
  { ...biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "phantom_lookout", "Phantom Lookout"), worldTimePhaseEligibility: ["dusk", "night"] },
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "maelstrom_spirit", "Maelstrom Spirit"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "sea_serpent", "Sea Serpent"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "kraken", "Kraken"),
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "muskellunge", "Muskellunge"),
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "mute_swan", "Mute Swan"),
  { ...biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "drowned_bride", "Drowned Bride"), worldTimePhaseEligibility: ["dusk", "night"] },
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "lake_maiden", "Lake Maiden"),
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "elder_mere_serpent", "Elder Mere Serpent"),
  { ...biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "northern_pike", "Northern Pike"), additionalEncounterSurfaces: ["river"] },
  biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "snapping_turtle", "Snapping Turtle"),
  { ...biomeVariantPopulationDefinition(FROG_POPULATION_DEFINITION, "drowned_thrall", "Drowned Thrall"), worldTimePhaseEligibility: ["dusk", "night"] },
  { ...biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "beaver", "Beaver"), additionalEncounterSurfaces: ["lake"] },
  { ...biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "river_otter", "River Otter"), additionalEncounterSurfaces: ["lake", "land"] },
  { ...biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "river_salmon", "River Salmon"), additionalEncounterSurfaces: ["lake"] },
  biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "kappa", "Kappa"),
  biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "kappa_brawler", "Kappa Brawler"),
  biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "bridge_troll", "Bridge Troll"),
  biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "nixie", "Nixie"),
  biomeVariantPopulationDefinition(ALLIGATOR_POPULATION_DEFINITION, "rapids_elemental", "Rapids Elemental"),
  // Water game phase B (docs/design/WATER_GAME_PLAN.md).
  {
    ...oceanPackPopulationDefinition("shellback", "Shellback herd", SHELLBACK_HERD_FORMATION),
    additionalEncounterSurfaces: ["lake"]
  },
  oceanPackPopulationDefinition("darter", "Darter pack", DARTER_PACK_FORMATION),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "ink_pool", "Ink Pool"),
  { ...biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "drowned_citizen", "Drowned Citizen"), behaviorCategory: "passive" },
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "tide_wraith", "Tide Wraith"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "gate_warden", "Gate Warden"),
  biomeVariantPopulationDefinition(SQUID_POPULATION_DEFINITION, "drowned_cultist", "Drowned Cultist"),
  // Overworld bestiary additions: land mobs on the closest existing shape.
  biomeVariantPopulationDefinition(WOLF_POPULATION_DEFINITION, "dire_wolf", "Dire Wolf pack"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "moss_troll", "Moss Troll"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "woolly_mammoth", "Woolly Mammoth"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "ash_drake", "Ash Drake"),
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "ember_dragon", "Ember Dragon"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "snapjaw_flytrap", "Snapjaw Flytrap"),
  biomeVariantPopulationDefinition(OGRE_POPULATION_DEFINITION, "cairn_golem", "Cairn Golem"),
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "giant_larva", "Giant Larva"),
  // Biome roster phase C animals.
  deerVariantPopulationDefinition("field_hare", "Field Hare"),
  deerVariantPopulationDefinition("arctic_hare", "Arctic Hare"),
  deerVariantPopulationDefinition("capybara", "Capybara"),
  deerVariantPopulationDefinition("armadillo", "Armadillo"),
  deerVariantPopulationDefinition("red_fox", "Red Fox"),
  biomeVariantPopulationDefinition(BEAR_POPULATION_DEFINITION, "wolverine", "Wolverine"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "ostrich", "Ostrich"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "golden_eagle", "Golden Eagle"),
  biomeVariantPopulationDefinition(HOG_POPULATION_DEFINITION, "musk_ox", "Musk Ox"),
  deerVariantPopulationDefinition("seal", "Seal")
] as const satisfies readonly PopulationV2MobDefinition<
  string,
  MobArchetypeKey
>[];

/**
 * Archetypes that Population V2 never places, with the system that spawns
 * them instead. With POPULATION_V2_MOB_DEFINITIONS this covers every
 * MobArchetypeKey, so a new mob that is neither registered nor listed here
 * fails to compile.
 */
export const NON_POPULATION_V2_MOB_ARCHETYPES = Object.freeze({
  training_dummy: "Practice target; developer spawn tools only",
  goblin: "Goblin Village garrison (goblinVillage.ts)",
  fire_bird: "Legendary bird event (legendaryBirdEvents.ts)",
  lightning_bird: "Legendary bird event (legendaryBirdEvents.ts)",
  ice_bird: "Legendary bird event (legendaryBirdEvents.ts)",
  xoral: "Overworld boss event (xoralEvents.ts)",
  sewer_rat: "Dungeon roster",
  sick_sewer_rat: "Dungeon roster",
  sewer_rat_miniboss: "Dungeon boss",
  slime: "Dungeon roster",
  slime_miniboss: "Dungeon boss",
  shellback_turtle: "Dungeon roster (Cistern Warrens)",
  sewer_spider: "Dungeon roster (Cistern Warrens)",
  dune_tick: "Dungeon roster (Cistern Warrens)",
  spiderling: "Dungeon roster (Cistern Warrens)",
  brood_matriarch: "Dungeon boss (Cistern Warrens)",
  cave_raptor: "Dungeon roster (Fangrock Cavern)",
  raptor_runt: "Dungeon roster (Fangrock Cavern)",
  raptor_spitter: "Dungeon roster (Fangrock Cavern)",
  cave_bat: "Dungeon roster (Fangrock Cavern)",
  raptor_chieftain: "Dungeon boss (Fangrock Cavern)",
  nest_mouse: "Dungeon roster (The Eyrie)",
  carrion_chick: "Dungeon roster (The Eyrie)",
  cliff_hawk: "Dungeon roster (The Eyrie)",
  thunderwing: "Dungeon boss (The Eyrie)",
  rot_wolf: "Dungeon roster (Blightwood Grove)",
  blighted_stag: "Dungeon roster (Blightwood Grove)",
  thornfern: "Dungeon roster (Blightwood Grove)",
  blight_treant: "Dungeon roster (Blightwood Grove)",
  blight_sprite: "Dungeon roster (Blightwood Grove)",
  hollow_elder: "Dungeon boss (Blightwood Grove)",
  drakeling: "Dungeon roster (Wyrm Hollow)",
  magma_salamander: "Dungeon roster (Wyrm Hollow)",
  lava_slime: "Dungeon roster (Wyrm Hollow)",
  ash_wyvern: "Dungeon roster (Wyrm Hollow)",
  drake_broodguard: "Dungeon roster (Wyrm Hollow)",
  elder_dragon: "Dungeon boss (Wyrm Hollow)",
  initiate_monk: "Dungeon roster (Monastery of the Still Hand)",
  staff_adept: "Dungeon roster (Monastery of the Still Hand)",
  shadow_acrobat: "Dungeon roster (Monastery of the Still Hand)",
  iron_statue: "Dungeon roster (Monastery of the Still Hand)",
  bell_spirit: "Dungeon roster (Monastery of the Still Hand)",
  ember_shade: "Dungeon roster (The Tilted Vault)",
  ashbound_revenant: "Dungeon roster (The Tilted Vault)",
  vault_warden: "Dungeon roster (The Tilted Vault)",
  grandmaster: "Dungeon boss (Monastery of the Still Hand)",
  grandmaster_clone: "Dungeon boss add (Monastery of the Still Hand)",
  hollin_guard: "Hollin Huts settlement (hollinHuts.ts)",
  hollin_brute: "Hollin Huts raid defender (hollinHuts.ts)",
  hollin_elder: "Hollin Huts raid defender (hollinHuts.ts)",
  hollin_farmer: "Hollin Huts settlement (hollinHuts.ts)",
  hollin_helper: "Hollin Lore rank 3 helper (hollinHuts.ts)",
  sky_scout: "Fallen Prison crash site event",
  cloud_sentry: "Fallen Prison crash site event",
  cloud_arbiter: "Fallen Prison crash site event",
  warden_scout: "Dungeon roster (Fallen Prison)",
  zealot: "Dungeon roster (Fallen Prison)",
  serpent_jailer: "Dungeon roster (Fallen Prison)",
  caged_valkyrie: "Fallen Prison rescue ally (companion)",
  coil_hatchling: "Dungeon roster (Fallen Prison)",
  legion_soldier: "Dungeon roster (Fallen Prison)",
  mimic: "Dungeon roster (Fallen Prison)",
  centurion: "Dungeon boss (Fallen Prison)",
  brood_matron: "Dungeon boss (Fallen Prison)",
  trifang_warden: "Dungeon boss (Fallen Prison)",
  risen_skeleton: "Revenant Metal summon (revenantMetalUndead.ts)",
  revenant_lich: "Revenant Metal summon (revenantMetalUndead.ts)",
  tide_wraith_dc: "Dungeon roster (Drowned City)",
  darter_dc: "Dungeon roster (Drowned City)",
  ink_pool_dc: "Dungeon roster (Drowned City)",
  drowned_cultist_dc: "Dungeon roster (Drowned City)",
  shellback_dc: "Dungeon roster (Drowned City)",
  coral_golem_dc: "Dungeon roster (Drowned City)",
  drowned_deckhand_dc: "Dungeon roster (Drowned City)",
  phantom_lookout_dc: "Dungeon roster (Drowned City)",
  merfolk_harpooner_dc: "Dungeon roster (Drowned City)",
  gate_warden_dc: "Dungeon roster (Drowned City)",
  void_wisp: "Dungeon roster (Drowned City)",
  deep_crawler: "Dungeon roster (Drowned City)",
  maw_lily: "Dungeon roster (Drowned City)",
  chrono_wisp: "Dungeon roster (Drowned City)",
  the_watcher: "Dungeon boss (Drowned City)",
  drowned_admiral: "Dungeon boss (Drowned City)",
  tidemaw: "Dungeon boss (Drowned City)",
  abyssal_one: "Dungeon boss (Drowned City)",
  tidemaw_tentacle: "Dungeon boss part (Drowned City)",
  tidemaw_tentacle_marked: "Dungeon boss part (Drowned City)",
  abyssal_cultist: "Dungeon boss add (Drowned City)",
  iron_golem_gf: "Dungeon roster (Golem Forge)",
  stone_golem_gf: "Dungeon roster (Golem Forge)",
  geode_golem_gf: "Dungeon roster (Golem Forge)",
  mender_golem_gf: "Dungeon roster (Golem Forge)",
  sentinel_statue_gf: "Dungeon roster (Golem Forge)",
  spark_wisp_gf: "Dungeon roster (Golem Forge)",
  slag_crawler_gf: "Dungeon roster (Golem Forge)",
  golem_smith_gf: "Dungeon roster (Golem Forge)",
  corrupted_husk_gf: "Dungeon boss part (Golem Forge)",
  gem_husk_gf: "Dungeon boss part (Golem Forge)",
  walking_hammer_gf: "Dungeon boss part (Golem Forge)",
  healer_monolith_gf: "Dungeon boss part (Golem Forge)",
  granite_bull: "Dungeon boss (Golem Forge)",
  corrupted_core: "Dungeon boss (Golem Forge)",
  forgemaster: "Dungeon boss (Golem Forge)"
} as const satisfies Readonly<Partial<Record<MobArchetypeKey, string>>>);

type PopulationV2RegisteredArchetype =
  (typeof POPULATION_V2_MOB_DEFINITIONS)[number]["combatArchetype"];
type PopulationV2SpawnCoverageGap = Exclude<
  MobArchetypeKey,
  PopulationV2RegisteredArchetype | keyof typeof NON_POPULATION_V2_MOB_ARCHETYPES
>;
type PopulationV2SpawnCoverageOverlap = Extract<
  PopulationV2RegisteredArchetype,
  keyof typeof NON_POPULATION_V2_MOB_ARCHETYPES
>;
// A compile error here names the archetype: register it in
// POPULATION_V2_MOB_DEFINITIONS or list it in NON_POPULATION_V2_MOB_ARCHETYPES.
const populationV2SpawnCoverage: Readonly<{
  missing: [PopulationV2SpawnCoverageGap] extends [never] ? true : PopulationV2SpawnCoverageGap;
  duplicated: [PopulationV2SpawnCoverageOverlap] extends [never] ? true : PopulationV2SpawnCoverageOverlap;
}> = { missing: true, duplicated: true };
void populationV2SpawnCoverage;

export type PopulationV2RuntimeMobKind =
  (typeof POPULATION_V2_MOB_DEFINITIONS)[number]["mobKind"];

export const populationV2MobRegistry = createPopulationV2MobRegistry(
  POPULATION_V2_MOB_DEFINITIONS
) as PopulationV2MobRegistry<PopulationV2MobDefinition<
  PopulationV2RuntimeMobKind,
  MobArchetypeKey
>>;

export const POPULATION_V2_RUNTIME_MOB_KINDS =
  populationV2MobRegistry.runtimeMobKinds;

export const POPULATION_V2_RUNTIME_MOB_ARCHETYPES =
  populationV2MobRegistry.runtimeArchetypes;

const populationV2RuntimeMobKindSet = new Set<string>(
  POPULATION_V2_RUNTIME_MOB_KINDS
);

export function isPopulationV2RuntimeMobKind(
  value: string
): value is PopulationV2RuntimeMobKind {
  return populationV2RuntimeMobKindSet.has(value);
}

function validateDensity(definition: PopulationV2MobDefinition): void {
  const density = definition.density;
  const configured = density.model === "common"
    ? density.densityPerEligibleKm2
    : density.targetAreaKm2;
  if (
    !Number.isFinite(configured)
    || configured <= 0
    || !Number.isFinite(density.candidateOversamplingFactor)
    || density.candidateOversamplingFactor < 1
  ) {
    throw new Error(
      `Population V2 mob ${definition.mobKind} density is invalid`
    );
  }
}

function validateLegacyIdentity(definition: PopulationV2MobDefinition): void {
  const legacy = definition.legacyIdentity;
  if (legacy === undefined) return;
  if (
    legacy.entityKind !== definition.mobKind
    || (
      legacy.spawnModel !== definition.spawnModel
      && !(
        definition.mobKind === "deer"
        && legacy.spawnModel === "single"
        && definition.spawnModel === "pack"
      )
    )
  ) {
    throw new Error(
      `Population V2 mob ${definition.mobKind} legacy identity is mismatched`
    );
  }
}

function validateCandidateBuilder(
  definition: PopulationV2MobDefinition
): void {
  const candidateId = `population-v2-registry-validation/${definition.mobKind}`;
  const maximumMemberCount = definition.packFormation === undefined
    ? 1
    : Math.max(...definition.packFormation.allowedMemberCounts);
  if (
    definition.spawnModel === "pack"
    && (
      definition.packFormation === undefined
      || definition.packFormation.allowedMemberCounts.length === 0
      || definition.packFormation.allowedMemberCounts.some((count) =>
        !Number.isSafeInteger(count) || count < 1
      )
    )
  ) {
    throw new Error(
      `Population V2 pack mob ${definition.mobKind} has no valid formation`
    );
  }
  if (
    definition.spawnModel === "single"
    && definition.packFormation !== undefined
  ) {
    throw new Error(
      `Population V2 single mob ${definition.mobKind} cannot have a pack formation`
    );
  }
  const anchor = { lat: 0, lon: 0 };
  const memberPositions = Array.from(
    { length: Math.max(1, maximumMemberCount) },
    (_, index) => ({ lat: 0, lon: index / 10_000 })
  );
  const candidate = definition.candidateBuilder({
    candidateId,
    anchor,
    memberPositions
  });
  const expectedCount = definition.spawnModel === "pack"
    ? definition.packFormation!.memberCountForCandidate(candidateId)
    : 1;
  const allowedCounts = definition.packFormation?.allowedMemberCounts ?? [1];
  const indexes = candidate.members.map((member) => member.memberIndex);
  const expectedIndexes = definition.spawnModel === "pack"
    ? Array.from({ length: expectedCount }, (_, index) => index)
    : [null];
  if (
    !allowedCounts.includes(expectedCount)
    || candidate.candidateId !== candidateId
    || candidate.mobKind !== definition.mobKind
    || candidate.members.length !== expectedCount
    || candidate.members.some((member) =>
      member.mobKind !== definition.mobKind
    )
    || JSON.stringify(indexes) !== JSON.stringify(expectedIndexes)
    || new Set(candidate.members.map((member) =>
      `${member.position.lat}/${member.position.lon}`
    )).size !== candidate.members.length
  ) {
    throw new Error(
      `Population V2 mob ${definition.mobKind} generates a mixed or partial group`
    );
  }
}

function populationGroupSize(
  specification: Readonly<{
    outcomes: readonly Readonly<{
      memberCount: number;
      probability: number;
    }>[];
  }>,
  namespace: string,
  candidateId: string
): number {
  const unit = deterministicUnit(namespace, candidateId);
  let upperExclusive = 0;
  for (const outcome of specification.outcomes) {
    upperExclusive += outcome.probability;
    if (unit < upperExclusive) return outcome.memberCount;
  }
  throw new Error("Population V2 pack formation did not select a size");
}
