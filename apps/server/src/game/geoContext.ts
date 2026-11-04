import {
  GEO_WATER_TYPES,
  type GeoAdministrativeContext,
  type GeoContext,
  type GeoPresentationRelation,
  type GeoWaterContext,
  type GeoWaterType,
  type GeoWaterbodyProximity,
  type LatLon
} from "@ash-atlas/shared";

import type {
  CanonicalWaterbodyLookup,
  WorldLookupClient
} from "../world/worldLookupClient.js";
import type {
  WorldGameplayEnvironmentResult,
  WorldWaterNameFallback
} from "../world/worldTypes.js";

export type GeoContextResolutionOptions = Readonly<{
  /** Optional bounded canonical proximity radius for distance predicates. */
  proximityRadiusM?: number;
  signal?: AbortSignal;
}>;

export type PersistedGeoContextFields = Readonly<{
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  countryId?: string | null;
  countryName?: string | null;
  admin1Id?: string | null;
  admin1Name?: string | null;
  localityId?: string | null;
  localityName?: string | null;
  gameplayWaterType?: GeoWaterType | null;
  canonicalWaterbodyId?: string | null;
  canonicalDisplayName?: string | null;
  waterbodyResolutionState?: GeoWaterContext["resolutionState"] | null;
  marineParentId?: string | null;
  marineParentName?: string | null;
  presentationName?: string | null;
  presentationRelation?: GeoWaterContext["presentationRelation"];
  presentationDistanceM?: number | null;
}>;

function validWaterType(value: unknown): GeoWaterType | null {
  return GEO_WATER_TYPES.includes(value as GeoWaterType)
    ? value as GeoWaterType
    : null;
}

function administrativeContext(
  id: string | null | undefined,
  name: string | null | undefined
): GeoAdministrativeContext {
  const normalizedId = id?.trim() || null;
  const normalizedName = name?.trim() || null;
  return {
    id: normalizedId,
    name: normalizedName,
    resolutionState: normalizedId ? "resolved" : "unresolved"
  };
}

function fallbackRelation(fallback: WorldWaterNameFallback): GeoPresentationRelation {
  const normalized = fallback.name.trim().toLocaleLowerCase();
  if (normalized === "open ocean") return "open_ocean";
  if (normalized === "unnamed river" || normalized === "unnamed lake") return "unnamed";
  return "near";
}

function presentationFor(
  waterType: GeoWaterType | null,
  canonicalName: string | null,
  fallback: WorldWaterNameFallback | null | undefined
): Pick<GeoWaterContext, "presentationName" | "presentationRelation" | "presentationDistanceM"> {
  if (canonicalName) {
    return {
      presentationName: canonicalName,
      presentationRelation: "exact",
      presentationDistanceM: 0
    };
  }
  if (fallback && (!waterType || fallback.waterClass === waterType)) {
    return {
      presentationName: fallback.name,
      presentationRelation: fallbackRelation(fallback),
      presentationDistanceM: fallback.distanceM
    };
  }
  if (waterType) {
    return {
      presentationName: waterType === "river"
        ? "Unnamed River"
        : waterType === "lake" ? "Unnamed Lake" : "Open Ocean",
      presentationRelation: waterType === "ocean" ? "open_ocean" : "unnamed",
      presentationDistanceM: null
    };
  }
  return {
    presentationName: null,
    presentationRelation: null,
    presentationDistanceM: null
  };
}

function proximityFromCanonical(
  candidates: readonly CanonicalWaterbodyLookup[] | undefined
): GeoWaterbodyProximity[] {
  if (!candidates) return [];
  const values: GeoWaterbodyProximity[] = [];
  for (const candidate of candidates) {
    const waterType = validWaterType(candidate.kind);
    const canonicalWaterbodyId = candidate.sourceId?.trim();
    const distanceM = candidate.distanceM;
    if (
      !waterType ||
      !canonicalWaterbodyId ||
      candidate.resolutionStatus !== undefined && candidate.resolutionStatus !== "resolved" ||
      !Number.isFinite(distanceM ?? Number.NaN) ||
      (distanceM as number) < 0
    ) {
      continue;
    }
    values.push({
      canonicalWaterbodyId,
      waterType,
      distanceM: Math.max(0, distanceM as number),
      canonicalDisplayName: candidate.sourceName?.trim() || null,
      sourceRevision: candidate.sourceRevision ?? null
    });
  }
  values.sort((left, right) =>
    left.distanceM - right.distanceM ||
    left.waterType.localeCompare(right.waterType) ||
    left.canonicalWaterbodyId.localeCompare(right.canonicalWaterbodyId)
  );
  const unique = new Map<string, GeoWaterbodyProximity>();
  for (const value of values) {
    const prior = unique.get(value.canonicalWaterbodyId);
    if (!prior || value.distanceM < prior.distanceM) unique.set(value.canonicalWaterbodyId, value);
  }
  return [...unique.values()];
}

/** Adapt one already-validated World compact result without doing runtime GIS. */
export function geoContextFromWorldEnvironment(
  world: WorldGameplayEnvironmentResult,
  options: Readonly<{ proximities?: readonly CanonicalWaterbodyLookup[] }> = {}
): GeoContext {
  const identity = world.waterbodyIdentity;
  const identityType = validWaterType(identity?.gameplayWaterType);
  const worldType = validWaterType(world.waterKind);
  const identityTypeMismatch = Boolean(
    identity && identity.gameplayWaterType !== null &&
    (!identityType || (worldType !== null && identityType !== worldType))
  );
  const expectedWaterType = identityType ?? worldType;
  const directCandidate = options.proximities?.find((candidate) => {
    const candidateType = validWaterType(candidate.kind);
    return candidate.distanceM === 0 &&
      candidate.sourceId?.trim() &&
      (!expectedWaterType || candidateType === expectedWaterType) &&
      (candidate.resolutionStatus === undefined || candidate.resolutionStatus === "resolved");
  });
  const candidateType = validWaterType(directCandidate?.kind);
  const waterType = identityTypeMismatch ? worldType : identityType ?? worldType ?? candidateType;
  const hasWaterSurface = world.surfaceKind === "water" || waterType !== null;
  const resolutionState = identityTypeMismatch
    ? "invalid"
    : waterType === null
    ? hasWaterSurface
      ? identity?.resolutionStatus ?? "unresolved"
      : "not_applicable"
    : identity?.resolutionStatus
      ?? (directCandidate &&
        (directCandidate.resolutionStatus === undefined || directCandidate.resolutionStatus === "resolved")
        ? "resolved"
        : "unresolved");
  const canonicalWaterbodyId = resolutionState === "resolved"
    ? identity?.canonicalWaterbodyId?.trim() || directCandidate?.sourceId?.trim() || null
    : null;
  const canonicalDisplayName = resolutionState === "resolved"
    ? identity?.displayName?.trim() || directCandidate?.sourceName?.trim() || null
    : null;
  const marineParentId = waterType === "ocean"
    ? identity?.parentCanonicalWaterbodyId?.trim() || null
    : null;
  const marineParentName = waterType === "ocean" && marineParentId
    ? identity?.parentCanonicalWaterbodyName?.trim() || null
    : null;
  const presentation = presentationFor(waterType, canonicalDisplayName, world.waterNameFallback);
  const proximities = proximityFromCanonical(options.proximities);
  if (
    canonicalWaterbodyId &&
    waterType &&
    !proximities.some((candidate) => candidate.canonicalWaterbodyId === canonicalWaterbodyId)
  ) {
    proximities.unshift({
      canonicalWaterbodyId,
      waterType,
      distanceM: 0,
      canonicalDisplayName,
      sourceRevision: world.worldReleaseId ?? world.release?.releaseId ?? null
    });
  }
  const water: GeoWaterContext = {
    gameplayWaterType: waterType,
    canonicalWaterbodyId,
    canonicalDisplayName,
    resolutionState,
    marineParentId,
    marineParentName,
    ...presentation,
    ...(proximities.length > 0 ? { proximities } : {})
  };
  return {
    latitude: world.latitude,
    longitude: world.longitude,
    country: administrativeContext(world.countryId, world.countryName),
    admin1: administrativeContext(world.regionId, world.regionName),
    locality: world.settlementId || world.settlementName
      ? administrativeContext(world.settlementId, world.settlementName)
      : null,
    water,
    countryId: world.countryId?.trim() || null,
    countryName: world.countryName?.trim() || null,
    admin1Id: world.regionId?.trim() || null,
    admin1Name: world.regionName?.trim() || null,
    localityId: world.settlementId?.trim() || null,
    localityName: world.settlementName?.trim() || null
  };
}

/** Rebuild a catch/encounter context from flattened durable provenance columns. */
export function geoContextFromPersisted(
  fields: PersistedGeoContextFields
): GeoContext | null {
  if (
    typeof fields.latitude !== "number" ||
    !Number.isFinite(fields.latitude) ||
    typeof fields.longitude !== "number" ||
    !Number.isFinite(fields.longitude)
  ) {
    return null;
  }
  const gameplayWaterType = validWaterType(fields.gameplayWaterType);
  const canonicalWaterbodyId = fields.canonicalWaterbodyId?.trim() || null;
  const canonicalDisplayName = fields.canonicalDisplayName?.trim() || null;
  const requestedResolutionState = fields.waterbodyResolutionState
    ?? (canonicalWaterbodyId ? "resolved" : gameplayWaterType ? "unresolved" : "not_applicable");
  // A retained display value must not upgrade an unresolved/ambiguous identity.
  // Only a resolved canonical ID may supply the exact presentation fallback.
  const resolutionState = requestedResolutionState === "resolved" && !canonicalWaterbodyId
    ? "invalid"
    : requestedResolutionState;
  const resolvedCanonicalId = resolutionState === "resolved" ? canonicalWaterbodyId : null;
  const resolvedCanonicalName = resolvedCanonicalId ? canonicalDisplayName : null;
  const presentationName = resolvedCanonicalName || fields.presentationName?.trim() || null;
  const presentationRelation = resolvedCanonicalName
    ? "exact"
    : fields.presentationRelation
      ?? (gameplayWaterType === "ocean" ? "open_ocean" : gameplayWaterType ? "unnamed" : null);
  const retainedPresentationDistanceM = fields.presentationDistanceM == null
    ? null
    : Number(fields.presentationDistanceM);
  const presentationDistanceM = resolvedCanonicalName
    ? 0
    : retainedPresentationDistanceM !== null && Number.isFinite(retainedPresentationDistanceM) && retainedPresentationDistanceM >= 0
      ? retainedPresentationDistanceM
      : null;
  return {
    latitude: fields.latitude,
    longitude: fields.longitude,
    country: administrativeContext(fields.countryId, fields.countryName),
    admin1: administrativeContext(fields.admin1Id, fields.admin1Name),
    locality: fields.localityId || fields.localityName
      ? administrativeContext(fields.localityId, fields.localityName)
      : null,
    water: {
      gameplayWaterType,
      canonicalWaterbodyId: resolvedCanonicalId,
      canonicalDisplayName: resolvedCanonicalName,
      resolutionState,
      marineParentId: gameplayWaterType === "ocean" ? fields.marineParentId?.trim() || null : null,
      marineParentName: gameplayWaterType === "ocean" ? fields.marineParentName?.trim() || null : null,
      presentationName,
      presentationRelation,
      presentationDistanceM
    },
    countryId: fields.countryId?.trim() || null,
    countryName: fields.countryName?.trim() || null,
    admin1Id: fields.admin1Id?.trim() || null,
    admin1Name: fields.admin1Name?.trim() || null,
    localityId: fields.localityId?.trim() || null,
    localityName: fields.localityName?.trim() || null
  };
}

/** Resolve a context via the existing indexed/cached World client. */
export async function resolveGeoContextAt(
  worldClient: Pick<WorldLookupClient, "lookupGameplayEnvironment" | "lookupCanonicalWaterbodiesNear">,
  point: LatLon,
  options: GeoContextResolutionOptions = {}
): Promise<GeoContext> {
  const world = await worldClient.lookupGameplayEnvironment(point.lat, point.lon, {
    ...(options.signal ? { signal: options.signal } : {})
  });
  const radius = options.proximityRadiusM;
  if (radius === undefined || !Number.isFinite(radius) || radius < 0 || !world.ok) {
    return geoContextFromWorldEnvironment(world);
  }
  try {
    const candidates = await worldClient.lookupCanonicalWaterbodiesNear(point, world, radius);
    return geoContextFromWorldEnvironment(world, { proximities: candidates });
  } catch {
    // Context remains useful for country/type/canonical checks when the optional
    // bounded proximity query is temporarily unavailable.
    return geoContextFromWorldEnvironment(world);
  }
}

/** Batch counterpart for event streams and future achievement processing. */
export async function resolveGeoContextsAt(
  worldClient: Pick<WorldLookupClient, "lookupGameplayEnvironments" | "lookupCanonicalWaterbodiesNear">,
  points: readonly LatLon[],
  options: GeoContextResolutionOptions = {}
): Promise<GeoContext[]> {
  const worlds = await worldClient.lookupGameplayEnvironments(points, {
    ...(options.signal ? { signal: options.signal } : {})
  });
  const radius = options.proximityRadiusM;
  if (radius === undefined || !Number.isFinite(radius) || radius < 0) {
    return worlds.map((world) => geoContextFromWorldEnvironment(world));
  }
  return Promise.all(worlds.map(async (world, index) => {
    const point = points[index];
    if (!point || !world.ok) return geoContextFromWorldEnvironment(world);
    try {
      const candidates = await worldClient.lookupCanonicalWaterbodiesNear(point, world, radius);
      return geoContextFromWorldEnvironment(world, { proximities: candidates });
    } catch {
      return geoContextFromWorldEnvironment(world);
    }
  }));
}
