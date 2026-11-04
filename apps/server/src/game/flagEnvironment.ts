import type {
  FlagEnvironmentDetails,
  FlagEnvironmentDiagnostics
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import {
  normalizeGameplayEnvironment,
  normalizeWorldLookup
} from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";

export type PersistedFlagEnvironmentRow = {
  id: string;
  owner_id: string;
  owner_username: string | null;
  owner_color: string | null;
  name: string;
  lat: number;
  lon: number;
  package_id: string | null;
  elevation_m: number | null;
  terrain_class: string | null;
  biome: string | null;
  ecoregion: string | null;
  claim_radius_m: number;
  city_id: string | null;
  gameplay_city_name?: string | null;
  environment_snapshot: unknown;
  created_at: Date;
  updated_at: Date;
};

export function buildFlagEnvironmentDetails(
  row: PersistedFlagEnvironmentRow,
  config: AppConfig
): FlagEnvironmentDetails {
  const snapshotRecord = recordOrNull(row.environment_snapshot);
  const rawLookup = snapshotLookupRecord(snapshotRecord);
  const world = rawLookup
    ? normalizeFlagEnvironmentSnapshot(rawLookup, {
        lat: Number(row.lat),
        lon: Number(row.lon)
      })
    : null;
  const status = snapshotStatus(snapshotRecord, world, config);
  const legacyProfile = Boolean(
    world && status.status === "legacy" && world.environmentSchemaVersion !== "world-profile-v2"
  );
  const legacyNearestWater = legacyProfile && world ? deriveLegacyNearestWater(world) : null;
  const legacyExactEcology = Boolean(
    legacyProfile && (world?.biome || world?.ecoregion)
  );

  return {
    identity: {
      flagId: row.id,
      flagName: row.name,
      ownerId: row.owner_id,
      ownerName: row.owner_username,
      ownerColor: row.owner_color,
      createdAt: row.created_at.toISOString(),
      claimRadiusM: Number(row.claim_radius_m),
      cityId: row.city_id,
      cityName: row.gameplay_city_name ?? null
    },
    coordinates: {
      latitude: Number(row.lat),
      longitude: Number(row.lon),
      packageId: world?.packageId ?? row.package_id
    },
    administrative: {
      countryId: world?.countryId ?? null,
      countryName: world?.countryName ?? null,
      countryCode: world?.countryCode ?? null,
      regionId: world?.regionId ?? null,
      regionName: world?.regionName ?? null,
      regionCode: world?.regionCode ?? null,
      cityId: world?.cityId ?? null,
      cityName: world?.cityName ?? null,
      insideCity: world?.insideCity ?? null,
      cityBoundaryDistanceM: world?.cityBoundaryDistanceM ?? null
    },
    terrain: {
      elevationM: world?.elevationM ?? nullableNumber(row.elevation_m),
      terrainClass: world?.terrainClass ?? row.terrain_class,
      landCoverClass: world?.landCoverClass ?? null,
      sourceLandCoverCode: nullableInteger(world?.sourceLandCoverCode),
      isLand: world?.isLand ?? null,
      isSaltwater: world?.isSaltwater ?? null,
      isCoastal: world?.isCoastal ?? null,
      coastlineDistanceM: world?.coastlineDistanceM ?? null,
      coastlineSearchRadiusM: world?.coastlineSearchRadiusM ?? null,
      coastlineSearchComplete: world?.coastlineSearchComplete ?? null,
      coastalThresholdM: world?.coastalThresholdM ?? null,
      landCoverConflict: world?.landCoverConflict ?? (
        legacyProfile && world ? inferLandCoverConflict(world.isLand, world.landCoverClass) : null
      )
    },
    ecology: {
      biomeId: world?.biomeId ?? null,
      biomeName: world?.biome ?? row.biome,
      ecoregionId: world?.ecoregionId ?? null,
      ecoregionName: world?.ecoregion ?? row.ecoregion,
      resolution: legacyExactEcology ? "exact_legacy" : world?.ecologyResolution ?? null,
      distanceM: legacyExactEcology ? 0 : world?.ecologyDistanceM ?? null,
      sourcePackageId: legacyExactEcology
        ? world?.packageId ?? row.package_id
        : world?.ecologySourcePackageId ?? null,
      fallbackMaxM: world?.ecologyFallbackMaxM ?? null,
      searchComplete: world?.ecologySearchComplete ?? null
    },
    water: {
      nearest: {
        sourceType: world?.nearestWaterSourceType ?? legacyNearestWater?.sourceType ?? null,
        sourceId: world?.nearestWaterSourceId ?? legacyNearestWater?.sourceId ?? null,
        sourceName: world?.nearestWaterSourceName ?? legacyNearestWater?.sourceName ?? null,
        kind: world?.nearestWaterSourceKind ?? legacyNearestWater?.kind ?? null,
        distanceM: world?.nearestWaterSourceDistanceM ?? legacyNearestWater?.distanceM ?? null,
        resolution: world?.nearestWaterResolution ?? (legacyNearestWater ? "derived_legacy_candidates" : null),
        searchRadiusM: world?.nearestWaterSearchRadiusM ?? null,
        searchComplete: world?.nearestWaterSearchComplete ?? null
      },
      namedRiver: {
        id: world?.namedRiverId ?? null,
        name: world?.namedRiverName ?? null,
        riverClass: world?.riverClass ?? null,
        distanceM: world?.riverDistanceM ?? null,
        searchRadiusM: world?.namedRiverSearchRadiusM ?? null,
        searchComplete: world?.namedRiverSearchComplete ?? null
      },
      supportingRiver: {
        id: world?.supportingRiverId ?? null,
        flowOrder: nullableInteger(world?.supportingRiverFlowOrder),
        dischargeCms: world?.supportingRiverDischargeCms ?? null,
        drainageAreaSqKm: world?.supportingRiverDrainageAreaSqKm ?? null,
        distanceM: world?.supportingRiverDistanceM ?? null,
        searchRadiusM: world?.supportingRiverSearchRadiusM ?? null,
        searchComplete: world?.supportingRiverSearchComplete ?? null
      },
      majorLake: {
        id: world?.majorLakeId ?? null,
        name: world?.majorLakeName ?? null,
        inside: world?.insideMajorLake ?? null,
        distanceM: world?.majorLakeDistanceM ?? null,
        searchRadiusM: world?.majorLakeSearchRadiusM ?? null,
        searchComplete: world?.majorLakeSearchComplete ?? null
      },
      oceanDepthClass: world?.oceanDepthClass ?? null
    },
    provenance: {
      worldReleaseId: world?.release?.releaseId ?? world?.worldReleaseId ?? null,
      profileSetFingerprint: world?.release?.profileSetFingerprint ?? null,
      buildContractFingerprint: world?.release?.buildContractFingerprint ?? null,
      boundaryReleaseId: world?.release?.boundaryReleaseId ?? null,
      packageCount: world?.release?.packageCount ?? null,
      environmentSchemaVersion: world?.environmentSchemaVersion ?? (legacyProfile ? "world-profile-v1" : null),
      sourceVersions: world?.sourceVersions ?? {},
      derivedTags: world?.derivedTags ?? [],
      warnings: world?.warnings ?? [],
      snapshotStatus: status.status,
      snapshotStatusReason: status.reason,
      snapshotUpdatedAt: row.updated_at.toISOString()
    },
    rawSnapshot: row.environment_snapshot
  };
}

export function buildFlagEnvironmentComparison(
  stored: FlagEnvironmentDetails,
  live: FlagEnvironmentDetails
): FlagEnvironmentDiagnostics["comparison"] {
  const storedValues = flattenComparable(stored);
  const liveValues = flattenComparable(live);
  const paths = [...new Set([...storedValues.keys(), ...liveValues.keys()])].sort();
  return paths.flatMap((path) => {
    const before = storedValues.get(path);
    const after = liveValues.get(path);
    if (sameComparableValue(before, after)) return [];
    return [{
      path,
      label: readablePath(path),
      kind: before === undefined ? "added" as const : after === undefined ? "removed" as const : "changed" as const,
      stored: before ?? null,
      live: after ?? null
    }];
  });
}

export function flagEnvironmentCacheState(raw: unknown): string | null {
  const timing = recordOrNull(recordOrNull(raw)?.timing);
  return typeof timing?.cache === "string" ? timing.cache : null;
}

function snapshotLookupRecord(
  snapshot: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!snapshot) return null;
  if (snapshot.contract_version === "gameplay-environment-v1") return snapshot;
  if (recordOrNull(snapshot.profile)) return snapshot;
  const nestedRaw = recordOrNull(snapshot.raw);
  return nestedRaw && (
    recordOrNull(nestedRaw.profile) ||
    nestedRaw.contract_version === "gameplay-environment-v1"
  ) ? nestedRaw : null;
}

function normalizeFlagEnvironmentSnapshot(
  snapshot: Record<string, unknown>,
  position: { lat: number; lon: number }
): WorldLookupResult {
  return snapshot.contract_version === "gameplay-environment-v1"
    ? normalizeGameplayEnvironment(snapshot, { point: position })
    : normalizeWorldLookup(snapshot, {
        latitude: position.lat,
        longitude: position.lon
      });
}

function snapshotStatus(
  snapshot: Record<string, unknown> | null,
  world: WorldLookupResult | null,
  config: AppConfig
): {
  status: FlagEnvironmentDetails["provenance"]["snapshotStatus"];
  reason: string;
} {
  if (!snapshot || Object.keys(snapshot).length === 0) {
    return {
      status: "unavailable",
      reason: "No stored world snapshot is available for this flag."
    };
  }
  if (!world) {
    return {
      status: "legacy",
      reason: "The stored snapshot uses an older unstructured format."
    };
  }
  if (releaseIsStale(world, config)) {
    return {
      status: "stale",
      reason: "The snapshot was produced by a different world release."
    };
  }
  if (world.environmentSchemaVersion === "gameplay-environment-v1") {
    return {
      status: world.ok ? "current" : "incomplete",
      reason: world.ok
        ? "The snapshot contains the current compact gameplay environment contract."
        : "The stored compact gameplay environment snapshot is incomplete."
    };
  }
  if (world.environmentSchemaVersion !== "world-profile-v2") {
    return {
      status: "legacy",
      reason: "The snapshot predates the comprehensive world-profile-v2 contract."
    };
  }
  if (!world.ok || world.ecologyResolution == null || world.nearestWaterResolution == null) {
    return {
      status: "incomplete",
      reason: "The stored v2 snapshot is missing required layer metadata."
    };
  }
  return {
    status: "current",
    reason: "The snapshot matches the required world release and schema."
  };
}

function releaseIsStale(world: WorldLookupResult, config: AppConfig): boolean {
  const release = world.release;
  return Boolean(
    release &&
      (release.releaseId !== config.WORLD_REQUIRED_RELEASE_ID ||
        release.profileSetFingerprint !== config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT ||
        release.buildContractFingerprint !== config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT ||
        release.boundaryReleaseId !== config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID)
  );
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableNumber(value: unknown): number | null {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

function nullableInteger(value: unknown): number | null {
  const number = nullableNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function deriveLegacyNearestWater(world: WorldLookupResult): {
  sourceType: string;
  sourceId: string | null;
  sourceName: string | null;
  kind: "fresh" | "salt" | "unknown";
  distanceM: number;
} | null {
  const candidates = [
    candidate("river", world.namedRiverId, world.namedRiverName, "fresh", world.riverDistanceM),
    candidate("lake", world.majorLakeId, world.majorLakeName, "fresh", world.insideMajorLake ? 0 : world.majorLakeDistanceM),
    candidate("coast", null, "Coastline", "salt", world.coastlineDistanceM),
    candidate("supporting_waterway", world.supportingRiverId, null, "fresh", world.supportingRiverDistanceM)
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return candidates.sort((left, right) => left.distanceM - right.distanceM)[0] ?? null;
}

function candidate(
  sourceType: string,
  sourceId: string | null | undefined,
  sourceName: string | null | undefined,
  kind: "fresh" | "salt" | "unknown",
  distanceM: number | null | undefined
) {
  return typeof distanceM === "number" && Number.isFinite(distanceM)
    ? { sourceType, sourceId: sourceId ?? null, sourceName: sourceName ?? null, kind, distanceM }
    : null;
}

function inferLandCoverConflict(
  isLand: boolean | null | undefined,
  landCoverClass: string | null | undefined
): boolean | null {
  if (isLand == null || !landCoverClass) return null;
  const waterClasses = new Set(["inland_water", "open_water", "water", "marine", "ocean"]);
  const classifiedAsWater = waterClasses.has(landCoverClass.toLowerCase());
  return isLand === classifiedAsWater;
}

function flattenComparable(value: unknown): Map<string, unknown> {
  const values = new Map<string, unknown>();
  const visit = (entry: unknown, path: string): void => {
    if (path === "rawSnapshot") return;
    if (Array.isArray(entry)) {
      values.set(path, entry);
      return;
    }
    const record = recordOrNull(entry);
    if (record) {
      for (const [key, nested] of Object.entries(record)) {
        visit(nested, path ? `${path}.${key}` : key);
      }
      return;
    }
    values.set(path, entry);
  };
  visit(value, "");
  values.delete("");
  return values;
}

function sameComparableValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalComparable(left)) === JSON.stringify(canonicalComparable(right));
}

function canonicalComparable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalComparable).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  }
  const record = recordOrNull(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalComparable(nested)])
  );
}

function readablePath(path: string): string {
  return path
    .split(".")
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
    .join(" / ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
