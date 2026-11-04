import { z } from "zod";

const nullableString = z.string().nullable();
const nullableNumber = z.number().finite().nullable();
const nullableBoolean = z.boolean().nullable();

export const FLAG_ENVIRONMENT_SNAPSHOT_STATUSES = [
  "current",
  "stale",
  "legacy",
  "incomplete",
  "unavailable"
] as const;

export const flagEnvironmentDetailsSchema = z.object({
  identity: z.object({
    flagId: z.string().min(1),
    flagName: z.string().min(1),
    ownerId: z.string().min(1),
    ownerName: nullableString,
    ownerColor: nullableString,
    createdAt: z.string().min(1),
    claimRadiusM: z.number().finite().nonnegative(),
    cityId: nullableString,
    cityName: nullableString.optional()
  }),
  coordinates: z.object({
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    packageId: nullableString
  }),
  administrative: z.object({
    countryId: nullableString,
    countryName: nullableString,
    countryCode: nullableString,
    regionId: nullableString,
    regionName: nullableString,
    regionCode: nullableString,
    cityId: nullableString,
    cityName: nullableString,
    insideCity: nullableBoolean,
    cityBoundaryDistanceM: nullableNumber
  }),
  terrain: z.object({
    elevationM: nullableNumber,
    terrainClass: nullableString,
    landCoverClass: nullableString,
    sourceLandCoverCode: z.number().int().nullable(),
    isLand: nullableBoolean,
    isSaltwater: nullableBoolean,
    isCoastal: nullableBoolean,
    coastlineDistanceM: nullableNumber,
    coastlineSearchRadiusM: nullableNumber.optional(),
    coastlineSearchComplete: nullableBoolean.optional(),
    coastalThresholdM: nullableNumber.optional(),
    landCoverConflict: nullableBoolean
  }),
  ecology: z.object({
    biomeId: nullableString,
    biomeName: nullableString,
    ecoregionId: nullableString,
    ecoregionName: nullableString,
    resolution: z
      .enum(["exact", "exact_legacy", "nearest_land_fallback", "unavailable", "not_applicable"])
      .nullable(),
    distanceM: nullableNumber,
    sourcePackageId: nullableString,
    fallbackMaxM: nullableNumber,
    searchComplete: nullableBoolean.optional()
  }),
  water: z.object({
    nearest: z.object({
      sourceType: nullableString,
      sourceId: nullableString,
      sourceName: nullableString,
      kind: z.enum(["fresh", "salt", "unknown"]).nullable(),
      distanceM: nullableNumber,
      resolution: nullableString,
      searchRadiusM: nullableNumber,
      searchComplete: nullableBoolean
    }),
    namedRiver: z.object({
      id: nullableString,
      name: nullableString,
      riverClass: nullableString,
      distanceM: nullableNumber,
      searchRadiusM: nullableNumber,
      searchComplete: nullableBoolean
    }),
    supportingRiver: z.object({
      id: nullableString,
      flowOrder: z.number().int().nullable(),
      dischargeCms: nullableNumber,
      drainageAreaSqKm: nullableNumber,
      distanceM: nullableNumber,
      searchRadiusM: nullableNumber,
      searchComplete: nullableBoolean
    }),
    majorLake: z.object({
      id: nullableString,
      name: nullableString,
      inside: nullableBoolean,
      distanceM: nullableNumber,
      searchRadiusM: nullableNumber,
      searchComplete: nullableBoolean
    }),
    oceanDepthClass: nullableString
  }),
  provenance: z.object({
    worldReleaseId: nullableString,
    profileSetFingerprint: nullableString,
    buildContractFingerprint: nullableString,
    boundaryReleaseId: nullableString,
    packageCount: z.number().int().nonnegative().nullable().optional(),
    environmentSchemaVersion: nullableString,
    sourceVersions: z.record(z.string(), z.string()),
    derivedTags: z.array(z.string()),
    warnings: z.array(z.string()),
    snapshotStatus: z.enum(FLAG_ENVIRONMENT_SNAPSHOT_STATUSES),
    snapshotStatusReason: z.string().min(1),
    snapshotUpdatedAt: z.string().min(1)
  }),
  rawSnapshot: z.unknown()
});

export type FlagEnvironmentDetails = z.infer<typeof flagEnvironmentDetailsSchema>;
export type FlagEnvironmentSnapshotStatus =
  (typeof FLAG_ENVIRONMENT_SNAPSHOT_STATUSES)[number];

export const flagEnvironmentDiagnosticsSchema = z.object({
  stored: flagEnvironmentDetailsSchema,
  live: z.object({
    details: flagEnvironmentDetailsSchema,
    rawLookup: z.unknown(),
    lookupStartedAt: z.string().min(1),
    durationMs: z.number().finite().nonnegative(),
    packageCacheState: nullableString
  }),
  comparison: z.array(z.object({
    path: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(["added", "removed", "changed"]),
    stored: z.unknown(),
    live: z.unknown()
  })),
  required: z.object({
    environmentSchemaVersion: z.string().min(1),
    worldReleaseId: z.string().min(1),
    profileSetFingerprint: z.string().min(1),
    buildContractFingerprint: z.string().min(1),
    boundaryReleaseId: z.string().min(1)
  }),
  refreshRecommended: z.boolean()
});

export type FlagEnvironmentDiagnostics = z.infer<typeof flagEnvironmentDiagnosticsSchema>;

export function normalizeFlagEnvironmentDetails(value: unknown): FlagEnvironmentDetails {
  return flagEnvironmentDetailsSchema.parse(value);
}

export function normalizeFlagEnvironmentDiagnostics(value: unknown): FlagEnvironmentDiagnostics {
  return flagEnvironmentDiagnosticsSchema.parse(value);
}
