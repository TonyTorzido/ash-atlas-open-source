export const ENVIRONMENT_SPAWN_RULES_VERSION =
  "environment-spawn-rules-v2-riverbank-lakeshore";

export const ENVIRONMENT_SPAWN_PROFILE_KEYS = [
  "hot_desert_lowland",
  "cold_desert",
  "temperate_forest",
  "tropical_forest",
  "grassland",
  "savanna",
  "wetland",
  "coastal",
  "alpine",
  "tundra",
  "generic_land"
] as const;

export type EnvironmentSpawnProfileKey = (typeof ENVIRONMENT_SPAWN_PROFILE_KEYS)[number];
export type EnvironmentEncounterKind = "deer" | "wolf_pack" | "ogre";

/** Boolean geography facts that a content definition may match declaratively. */
export type EnvironmentSpawnFactKey =
  | "isLand"
  | "isSaltwater"
  | "isCoastalLand"
  | "isRiverbank"
  | "isLakeshore"
  | "insideMajorLake";

export type EnvironmentSpawnFacts = Readonly<{
  isLand?: boolean | null;
  isSaltwater?: boolean | null;
  isCoastalLand?: boolean | null;
  isRiverbank?: boolean | null;
  isLakeshore?: boolean | null;
  biomeId?: string | null;
  biomeName?: string | null;
  ecoregionId?: string | null;
  ecoregionName?: string | null;
  landCoverClass?: string | null;
  elevationBand?: string | null;
  terrainClass?: string | null;
  isCoastal?: boolean | null;
  insideMajorLake?: boolean | null;
  placementTags?: readonly string[];
}>;

/** Declarative, content-neutral habitat constraints for future spawn definitions. */
export type EnvironmentSpawnPolicy = Readonly<{
  requireLand?: boolean;
  rejectSaltwater?: boolean;
  rejectMajorLake?: boolean;
  requiredFacts?: Readonly<Partial<Record<EnvironmentSpawnFactKey, boolean>>>;
  requiredPlacementTags?: readonly string[];
  excludedPlacementTags?: readonly string[];
}>;

export type EnvironmentSpawnProfile = Readonly<{
  key: EnvironmentSpawnProfileKey;
  treeCountRange: readonly [minimum: number, maximum: number];
  encounterCountRange: readonly [minimum: number, maximum: number];
  resourceWeights: Readonly<{
    tree: number;
  }>;
  encounterWeights: Readonly<Record<EnvironmentEncounterKind, number>>;
  slotEligibility: EnvironmentSpawnPolicy & Readonly<{
    requireLand: true;
    rejectSaltwater: true;
    rejectMajorLake: true;
    preferredPlacementTags: readonly string[];
  }>;
}>;

const UNIVERSAL_LAND_ELIGIBILITY = {
  requireLand: true,
  rejectSaltwater: true,
  rejectMajorLake: true
} as const;

export const ENVIRONMENT_SPAWN_PROFILES: Readonly<
  Record<EnvironmentSpawnProfileKey, EnvironmentSpawnProfile>
> = {
  hot_desert_lowland: profile("hot_desert_lowland", [1, 3], [2, 4], 0.35, {
    deer: 0.50, wolf_pack: 0.30, ogre: 0.20
  }, ["dry", "open", "lowland"]),
  cold_desert: profile("cold_desert", [1, 3], [2, 4], 0.30, {
    deer: 0.50, wolf_pack: 0.35, ogre: 0.15
  }, ["dry", "open", "cold"]),
  temperate_forest: profile("temperate_forest", [5, 8], [2, 4], 1, {
    deer: 0.70, wolf_pack: 0.25, ogre: 0.05
  }, ["forest", "wooded"]),
  tropical_forest: profile("tropical_forest", [6, 9], [2, 4], 1, {
    deer: 0.65, wolf_pack: 0.25, ogre: 0.10
  }, ["forest", "tropical"]),
  grassland: profile("grassland", [3, 6], [2, 4], 0.75, {
    deer: 0.65, wolf_pack: 0.30, ogre: 0.05
  }, ["grass", "open"]),
  savanna: profile("savanna", [2, 5], [2, 4], 0.65, {
    deer: 0.60, wolf_pack: 0.30, ogre: 0.10
  }, ["savanna", "open"]),
  wetland: profile("wetland", [4, 7], [2, 4], 0.85, {
    deer: 0.65, wolf_pack: 0.25, ogre: 0.10
  }, ["wetland", "marsh"]),
  coastal: profile("coastal", [3, 6], [2, 4], 0.70, {
    deer: 0.60, wolf_pack: 0.30, ogre: 0.10
  }, ["coastal", "land"]),
  alpine: profile("alpine", [1, 4], [2, 4], 0.40, {
    deer: 0.50, wolf_pack: 0.35, ogre: 0.15
  }, ["alpine", "rock"]),
  tundra: profile("tundra", [1, 3], [2, 4], 0.30, {
    deer: 0.55, wolf_pack: 0.35, ogre: 0.10
  }, ["tundra", "cold"]),
  generic_land: profile("generic_land", [3, 7], [2, 4], 0.70, {
    deer: 0.60, wolf_pack: 0.30, ogre: 0.10
  }, ["land"])
};

export function deriveEnvironmentSpawnProfileKey(
  facts: EnvironmentSpawnFacts
): EnvironmentSpawnProfileKey {
  const classification = [
    facts.biomeId,
    facts.biomeName,
    facts.ecoregionId,
    facts.ecoregionName,
    facts.landCoverClass,
    facts.elevationBand,
    facts.terrainClass
  ].filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (containsAny(classification, ["wetland", "marsh", "swamp", "mangrove", "bog", "fen"])) {
    return "wetland";
  }
  if (containsAny(classification, ["tundra", "polar", "ice cap", "permafrost"])) {
    return "tundra";
  }
  if (containsAny(classification, ["alpine", "montane", "mountain", "high elevation", "high-elevation"])) {
    return "alpine";
  }
  if (
    classification.includes("rainforest") ||
    (
      classification.includes("tropical") &&
      containsAny(classification, ["forest", "broadleaf", "conifer"])
    )
  ) {
    return "tropical_forest";
  }
  if (containsAny(classification, ["cold desert", "temperate desert"])) {
    return "cold_desert";
  }
  if (containsAny(classification, ["hot desert", "subtropical desert"])) {
    return "hot_desert_lowland";
  }
  if (classification.includes("desert")) {
    return containsAny(classification, ["cold", "temperate", "high"])
      ? "cold_desert"
      : "hot_desert_lowland";
  }
  if (containsAny(classification, ["savanna", "savannah"])) {
    return "savanna";
  }
  if (containsAny(classification, ["forest", "woodland", "taiga"])) {
    return "temperate_forest";
  }
  if (containsAny(classification, ["grassland", "steppe", "prairie", "grass"])) {
    return "grassland";
  }
  if (facts.isCoastal === true || classification.includes("coastal")) {
    return "coastal";
  }
  return "generic_land";
}

export function environmentSpawnProfileFor(
  facts: EnvironmentSpawnFacts
): EnvironmentSpawnProfile {
  return ENVIRONMENT_SPAWN_PROFILES[deriveEnvironmentSpawnProfileKey(facts)];
}

/**
 * Evaluates only declarative geography/tag constraints. It fails closed when a
 * required fact is absent or unknown, so content cannot accidentally spawn on
 * an unverified surface.
 */
export function environmentSpawnPolicyMatches(
  facts: EnvironmentSpawnFacts,
  policy: EnvironmentSpawnPolicy
): boolean {
  if (policy.requireLand && facts.isLand !== true) return false;
  if (policy.rejectSaltwater && facts.isSaltwater !== false) return false;
  if (policy.rejectMajorLake && facts.insideMajorLake !== false) return false;

  for (const [key, expected] of Object.entries(policy.requiredFacts ?? {})) {
    if (facts[key as EnvironmentSpawnFactKey] !== expected) return false;
  }

  const tags = new Set(facts.placementTags ?? []);
  if ((policy.requiredPlacementTags ?? []).some((tag) => !tags.has(tag))) {
    return false;
  }
  if ((policy.excludedPlacementTags ?? []).some((tag) => tags.has(tag))) {
    return false;
  }
  return true;
}

/** Applies a profile's universal slot rules plus its declarative tag/fact policy. */
export function environmentSpawnSlotEligible(
  profile: Pick<EnvironmentSpawnProfile, "slotEligibility">,
  facts: EnvironmentSpawnFacts
): boolean {
  return environmentSpawnPolicyMatches(facts, profile.slotEligibility);
}

export function selectEnvironmentEncounter(
  profile: EnvironmentSpawnProfile,
  unit: number
): EnvironmentEncounterKind {
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) {
    throw new Error("encounter roll must be in [0, 1)");
  }
  const deerBoundary = profile.encounterWeights.deer;
  const wolfBoundary = deerBoundary + profile.encounterWeights.wolf_pack;
  if (unit < deerBoundary) return "deer";
  if (unit < wolfBoundary) return "wolf_pack";
  return "ogre";
}

export function countFromEnvironmentRange(
  range: readonly [minimum: number, maximum: number],
  unit: number
): number {
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) {
    throw new Error("count roll must be in [0, 1)");
  }
  return range[0] + Math.floor(unit * (range[1] - range[0] + 1));
}

function profile(
  key: EnvironmentSpawnProfileKey,
  treeCountRange: readonly [number, number],
  encounterCountRange: readonly [number, number],
  treeWeight: number,
  encounterWeights: Readonly<Record<EnvironmentEncounterKind, number>>,
  preferredPlacementTags: readonly string[]
): EnvironmentSpawnProfile {
  if (!Number.isFinite(treeWeight) || treeWeight <= 0 || treeWeight > 1) {
    throw new Error(`environment tree weight must be in (0, 1] for ${key}`);
  }
  const weightTotal = Object.values(encounterWeights).reduce((total, weight) => total + weight, 0);
  if (Math.abs(weightTotal - 1) > Number.EPSILON * 10) {
    throw new Error(`environment encounter weights must total 1 for ${key}`);
  }
  return {
    key,
    treeCountRange,
    encounterCountRange,
    resourceWeights: { tree: treeWeight },
    encounterWeights,
    slotEligibility: { ...UNIVERSAL_LAND_ELIGIBILITY, preferredPlacementTags }
  };
}

function containsAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}
