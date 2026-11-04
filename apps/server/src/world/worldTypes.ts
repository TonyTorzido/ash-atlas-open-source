import type { FlagPlacementWaterDecision } from "@ash-atlas/shared";

export type WorldReleaseIdentity = {
  releaseId: string;
  profileSetFingerprint: string;
  buildContractFingerprint: string;
  boundaryReleaseId: string;
  packageCount: number;
};

export type WorldRuntimeIdentity = {
  sha: string;
  branch: string;
};

export type RequiredRiverAuthority = {
  runtimeSha: string;
  releaseId: string;
  manifestSha256: string;
  policy: string;
  cellSizeM: number;
};

export type RequiredCanonicalSurfaceAuthority = RequiredRiverAuthority;

/** The resolution state emitted by the canonical waterbody identity overlay. */
export type WorldWaterbodyResolutionStatus =
  | "resolved"
  | "unresolved"
  | "ambiguous"
  | "invalid";

/** Canonical waterbody metadata returned alongside final water-cell authority. */
export type WorldWaterbodyIdentity = {
  canonicalWaterbodyId: string | null;
  gameplayWaterType: "ocean" | "lake" | "river" | "inland_water" | null;
  displayName: string | null;
  resolutionStatus: WorldWaterbodyResolutionStatus;
  candidateCount: number | null;
  parentCanonicalWaterbodyId: string | null;
  parentCanonicalWaterbodyName?: string | null;
};

/** Presentation-only nearest-name metadata from the sealed World name index. */
export type WorldWaterNameFallback = {
  name: string;
  waterClass: "river" | "lake" | "ocean";
  distanceM: number | null;
  authority: string;
  referenceId: string | null;
};

/** The immutable identity overlay pinned in the World runtime lock. */
export type RequiredWaterbodyIdentityAuthority = {
  runtimeSha: string;
  releaseId: string;
  manifestSha256: string;
  schema: string;
  schemaVersion: string;
  policy: string;
  policyVersion: string;
};

export type WorldLookupFailureCode =
  | "WORLD_LOOKUP_TIMEOUT"
  | "WORLD_AUTHORITY_UNAVAILABLE"
  | "WORLD_AUTHORITY_OVERLOADED"
  | "WORLD_RELEASE_MISMATCH"
  | "WORLD_RESPONSE_INVALID"
  | "WORLD_COORDINATE_UNCOVERED"
  | "WORLD_LOOKUP_RETRYABLE";

export type WorldLookupFailure = {
  code: WorldLookupFailureCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

export type WorldLookupResult = {
  ok: boolean;
  failure?: WorldLookupFailure;
  packageId: string | null;
  latitude?: number | null;
  longitude?: number | null;
  countryId?: string | null;
  countryName?: string | null;
  countryCode?: string | null;
  regionId?: string | null;
  regionName?: string | null;
  regionCode?: string | null;
  cityId?: string | null;
  cityName?: string | null;
  insideCity?: boolean | null;
  cityBoundaryDistanceM?: number | null;
  elevationM: number | null;
  terrainClass: string | null;
  landCoverClass?: string | null;
  sourceLandCoverCode?: number | null;
  biome: string | null;
  biomeId?: string | null;
  ecoregion: string | null;
  ecoregionId?: string | null;
  isLand?: boolean | null;
  isSaltwater?: boolean | null;
  isCoastal?: boolean | null;
  isCoastalLand?: boolean | null;
  /** Additive land-side proximity fact; independent from canonical surface membership. */
  isRiverbank?: boolean | null;
  /** Additive land-side proximity fact; independent from canonical surface membership. */
  isLakeshore?: boolean | null;
  coastlineDistanceM?: number | null;
  coastlineSearchRadiusM?: number | null;
  coastlineSearchComplete?: boolean | null;
  coastalThresholdM?: number | null;
  landCoverConflict?: boolean | null;
  ecologyResolution?: "exact" | "exact_legacy" | "nearest_land_fallback" | "unavailable" | "not_applicable" | null;
  ecologyDistanceM?: number | null;
  ecologySourcePackageId?: string | null;
  ecologyFallbackMaxM?: number | null;
  ecologySearchComplete?: boolean | null;
  insideMajorLake?: boolean | null;
  majorLakeId?: string | null;
  majorLakeName?: string | null;
  majorLakeDistanceM?: number | null;
  namedRiverId?: string | null;
  namedRiverName?: string | null;
  riverClass?: string | null;
  riverDistanceM?: number | null;
  namedRiverSearchRadiusM?: number | null;
  namedRiverSearchComplete?: boolean | null;
  supportingRiverId?: string | null;
  supportingRiverFlowOrder?: number | null;
  supportingRiverDischargeCms?: number | null;
  supportingRiverDrainageAreaSqKm?: number | null;
  supportingRiverDistanceM?: number | null;
  supportingRiverSearchRadiusM?: number | null;
  supportingRiverSearchComplete?: boolean | null;
  majorLakeSearchRadiusM?: number | null;
  majorLakeSearchComplete?: boolean | null;
  nearestWaterSourceType?: string | null;
  nearestWaterSourceId?: string | null;
  nearestWaterSourceName?: string | null;
  nearestWaterSourceKind?: "fresh" | "salt" | "unknown" | null;
  nearestWaterSourceDistanceM?: number | null;
  nearestWaterResolution?: string | null;
  nearestWaterSearchRadiusM?: number | null;
  nearestWaterSearchComplete?: boolean | null;
  oceanDepthClass?: string | null;
  flagPlacementWater?: FlagPlacementWaterDecision | null;
  surfaceKind?: "land" | "water" | null;
  waterKind?: "ocean" | "lake" | "river" | "inland_water" | null;
  waterbodyIdentity?: WorldWaterbodyIdentity | null;
  waterNameFallback?: WorldWaterNameFallback | null;
  riverSurface?: {
    surfaceKind: "water" | null;
    waterKind: "river" | null;
    isRiver: boolean;
    cellSizeM: number;
    rowId: number;
    columnId: number;
    sourceReleaseId: string;
    sourceManifestSha256: string;
    canonicalFeatureId?: string | null;
  } | null;
  lakeSurface?: {
    surfaceKind: "water" | null;
    waterKind: "lake" | null;
    isLake: boolean;
    cellSizeM: number;
    rowId: number;
    columnId: number;
    sourceReleaseId: string;
    sourceManifestSha256: string;
    canonicalFeatureId?: string | null;
    canonicalFeatureName?: string | null;
  } | null;
  oceanCoastSurface?: {
    surfaceKind: "water" | null;
    waterKind: "ocean" | null;
    isOceanCoast: boolean;
    cellSizeM: number;
    rowId: number;
    columnId: number;
    sourceReleaseId: string;
    sourceManifestSha256: string;
  } | null;
  derivedTags?: string[];
  release?: WorldReleaseIdentity | null;
  warnings?: string[];
  slope?: number | null;
  worldReleaseId?: string | null;
  worldReleaseVersion?: string | null;
  environmentSchemaVersion?: string | null;
  generatorVersion?: string | null;
  sourceVersions?: Record<string, string>;
  raw: unknown;
  warning?: string;
};

export type WorldGameplayEnvironmentResult = WorldLookupResult & {
  contractVersion: "gameplay-environment-v1";
  runtime: WorldRuntimeIdentity | null;
  latitude: number;
  longitude: number;
  countryId: string | null;
  countryName: string | null;
  countryCode: string | null;
  regionId: string | null;
  regionName: string | null;
  regionCode: string | null;
  isLand: boolean | null;
  isSaltwater: boolean | null;
  isCoastalLand: boolean | null;
  /** Additive proximity fact; never substitutes for riverSurface membership. */
  isRiverbank: boolean | null;
  /** Additive proximity fact; never substitutes for lakeSurface membership. */
  isLakeshore: boolean | null;
  insideMajorLake: boolean | null;
  majorLakeId: string | null;
  majorLakeName: string | null;
  majorLakeDistanceM: number | null;
  elevationBand: string | null;
  biomeName: string | null;
  ecoregionName: string | null;
  settlementId: string | null;
  settlementName: string | null;
  namedRiverId: string | null;
  namedRiverName: string | null;
  riverClass: string | null;
  riverDistanceM: number | null;
  supportingRiverId: string | null;
  supportingRiverFlowOrder: number | null;
  supportingRiverDischargeCms: number | null;
  supportingRiverDrainageAreaSqKm: number | null;
  supportingRiverDistanceM: number | null;
  flagPlacementWater: FlagPlacementWaterDecision | null;
};

export type WorldSettlement = {
  settlementId: string;
  name: string;
  countryCode: string;
  regionCode: string | null;
  jurisdictionName: string | null;
  subtype: string;
  administrativeLevel: string;
  sourceVersion: string;
  source: string;
  sourceSettlementId: string;
  sourceClass: string | null;
  settlementClass: string;
  settlementReleaseId: string;
  settlementReleaseFingerprint: string;
  foundingPolicyId: string;
  foundingPolicyFingerprint: string;
  resolutionPolicyId: string;
  resolutionPolicyFingerprint: string;
  resolution: {
    policyId: string;
    selectedAs: "primary_locality" | "authoritative_primary" | "standalone_locality" | "peer_overlap";
    candidateCount: number;
  };
  foundingEligible: boolean;
  population: number | null;
  minimumFoundingPopulation: number | null;
  foundingIneligibilityReason:
    | "class_ineligible"
    | "population_missing"
    | "population_below_minimum"
    | null;
};

export type SettlementAuthorityIdentity = {
  releaseId: string;
  releaseFingerprint: string;
  foundingPolicyId: string;
  foundingPolicyFingerprint: string;
  resolutionPolicyId: string;
  resolutionPolicyFingerprint: string;
};

export type WorldNearestMunicipality = {
  municipalityId: string;
  name: string;
  countryCode: string;
  regionCode: string | null;
  jurisdictionName: string | null;
  subtype: string;
  distanceM: number;
  bearingDegrees: number;
};

export type SettlementLookupResult =
  | {
      found: false;
      inside: false;
      settlement: null;
      nearest: WorldNearestMunicipality | null;
      authority: SettlementAuthorityIdentity;
    }
  | {
      found: true;
      inside: true;
      settlement: WorldSettlement;
      nearest: null;
      authority: SettlementAuthorityIdentity;
    };
