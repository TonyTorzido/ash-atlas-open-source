import type { LatLon } from "./types.js";

/** Gameplay water classes backed by the sealed World surface authorities. */
export const GEO_WATER_TYPES = ["river", "lake", "ocean"] as const;
export type GeoWaterType = (typeof GEO_WATER_TYPES)[number];

/** Conservative resolution states; a display name never upgrades one of these. */
export const GEO_WATER_RESOLUTION_STATES = [
  "resolved",
  "unresolved",
  "ambiguous",
  "invalid",
  "not_applicable"
] as const;
export type GeoWaterResolutionState = (typeof GEO_WATER_RESOLUTION_STATES)[number];

export const GEO_ADMIN_RESOLUTION_STATES = ["resolved", "unresolved", "ambiguous"] as const;
export type GeoAdministrativeResolutionState = (typeof GEO_ADMIN_RESOLUTION_STATES)[number];

/** The relation between a player-facing water name and the authoritative geometry. */
export const GEO_PRESENTATION_RELATIONS = ["exact", "near", "unnamed", "open_ocean"] as const;
export type GeoPresentationRelation = (typeof GEO_PRESENTATION_RELATIONS)[number];

/** One authoritative canonical waterbody proximity result.
 *
 * `distanceM` is measured to the World canonical representation (not a label,
 * centroid, tile count, or source-row ordering). A distance of zero means the
 * event point is on that canonical waterbody representation.
 */
export type GeoWaterbodyProximity = Readonly<{
  canonicalWaterbodyId: string;
  waterType: GeoWaterType;
  distanceM: number;
  canonicalDisplayName?: string | null;
  sourceRevision?: string | null;
}>;

export type GeoAdministrativeContext = Readonly<{
  id: string | null;
  name: string | null;
  resolutionState: GeoAdministrativeResolutionState;
}>;

export type GeoWaterContext = Readonly<{
  gameplayWaterType: GeoWaterType | null;
  canonicalWaterbodyId: string | null;
  canonicalDisplayName: string | null;
  resolutionState: GeoWaterResolutionState;
  marineParentId: string | null;
  marineParentName: string | null;
  /** Presentation-only metadata. Never use this as a canonical identity. */
  presentationName: string | null;
  presentationRelation: GeoPresentationRelation | null;
  presentationDistanceM: number | null;
  /** Optional bounded canonical index results used by distance predicates. */
  proximities?: readonly GeoWaterbodyProximity[];
}>;

/** Immutable location facts shared by future quests, events, records, and systems. */
export type GeoContext = Readonly<{
  latitude: number;
  longitude: number;
  country: GeoAdministrativeContext;
  admin1: GeoAdministrativeContext;
  locality: GeoAdministrativeContext | null;
  water: GeoWaterContext;
  /** Flat aliases mirror World/game persistence naming for simple consumers. */
  countryId?: string | null;
  countryName?: string | null;
  admin1Id?: string | null;
  admin1Name?: string | null;
  localityId?: string | null;
  localityName?: string | null;
}>;

/** Event shape intentionally contains no knowledge of quests, combat, fishing, or drops. */
export type GameplayEvent = Readonly<{
  actorId: string;
  eventType: string;
  targetType?: string | null;
  worldPosition: LatLon;
  timestamp: string;
  location?: GeoContext;
}>;

/** Attach a resolved location without teaching the geographic layer about event semantics. */
export function enrichGameplayEvent(
  event: GameplayEvent,
  location: GeoContext
): GameplayEvent {
  return { ...event, location };
}

export type GeoPredicate =
  | Readonly<{ kind: "country_is"; countryId: string }>
  | Readonly<{ kind: "admin1_is"; admin1Id: string }>
  | Readonly<{ kind: "water_type_is"; waterType: GeoWaterType }>
  | Readonly<{ kind: "waterbody_is"; canonicalWaterbodyId: string }>
  | Readonly<{ kind: "marine_parent_is"; canonicalWaterbodyId: string }>
  | Readonly<{
      kind: "within_distance_of_waterbody";
      canonicalWaterbodyId: string;
      meters: number;
    }>
  | Readonly<{
      kind: "nearest_named_waterbody";
      waterType: GeoWaterType;
      maxDistanceM: number;
    }>
  | Readonly<{ kind: "all"; predicates: readonly GeoPredicate[] }>
  | Readonly<{ kind: "any"; predicates: readonly GeoPredicate[] }>
  | Readonly<{ kind: "not"; predicate: GeoPredicate }>;

export type GeoNamedWaterbodyProximity = Readonly<{
  waterType: GeoWaterType;
  distanceM: number;
  canonicalWaterbodyId: string | null;
  canonicalDisplayName: string | null;
  presentationName: string;
  relation: "canonical" | "near";
}>;

function normalizedId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError("geographic IDs must not be empty");
  return normalized;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be finite and non-negative`);
  }
  return value;
}

function canonicalName(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function sameId(left: string | null, right: string): boolean {
  return left !== null && left === right;
}

/** Return the closest named waterbody relationship from authoritative context. */
export function nearestNamedWaterbody(
  context: GeoContext,
  waterType: GeoWaterType,
  maxDistanceM: number
): GeoNamedWaterbodyProximity | null {
  finiteNonNegative(maxDistanceM, "maxDistanceM");
  const candidates: GeoNamedWaterbodyProximity[] = [];
  const water = context.water;

  if (
    water.gameplayWaterType === waterType &&
    water.canonicalWaterbodyId &&
    water.canonicalDisplayName &&
    water.resolutionState === "resolved"
  ) {
    candidates.push({
      waterType,
      distanceM: 0,
      canonicalWaterbodyId: water.canonicalWaterbodyId,
      canonicalDisplayName: water.canonicalDisplayName,
      presentationName: water.canonicalDisplayName,
      relation: "canonical"
    });
  }

  if (
    water.gameplayWaterType === waterType &&
    water.presentationName &&
    water.presentationRelation === "near" &&
    water.presentationDistanceM !== null
  ) {
    candidates.push({
      waterType,
      distanceM: water.presentationDistanceM,
      canonicalWaterbodyId: null,
      canonicalDisplayName: null,
      presentationName: water.presentationName,
      relation: "near"
    });
  }

  for (const proximity of water.proximities ?? []) {
    if (
      proximity.waterType !== waterType ||
      !proximity.canonicalDisplayName ||
      !Number.isFinite(proximity.distanceM) ||
      proximity.distanceM < 0
    ) {
      continue;
    }
    candidates.push({
      waterType,
      distanceM: proximity.distanceM,
      canonicalWaterbodyId: proximity.canonicalWaterbodyId,
      canonicalDisplayName: canonicalName(proximity.canonicalDisplayName),
      presentationName: proximity.canonicalDisplayName,
      relation: "near"
    });
  }

  candidates.sort((left, right) =>
    left.distanceM - right.distanceM ||
    left.presentationName.localeCompare(right.presentationName) ||
    (left.canonicalWaterbodyId ?? "").localeCompare(right.canonicalWaterbodyId ?? "")
  );
  const nearest = candidates[0];
  return nearest && nearest.distanceM <= maxDistanceM ? nearest : null;
}

/** Evaluate a geographic predicate against an already-resolved/cached context. */
export function evaluateGeoPredicate(context: GeoContext, predicate: GeoPredicate): boolean {
  switch (predicate.kind) {
    case "country_is":
      return sameId(context.country.id, normalizedId(predicate.countryId));
    case "admin1_is":
      return sameId(context.admin1.id, normalizedId(predicate.admin1Id));
    case "water_type_is":
      return context.water.gameplayWaterType === predicate.waterType;
    case "waterbody_is":
      return (
        context.water.resolutionState === "resolved" &&
        sameId(context.water.canonicalWaterbodyId, normalizedId(predicate.canonicalWaterbodyId))
      );
    case "marine_parent_is":
      return (
        context.water.gameplayWaterType === "ocean" &&
        context.water.marineParentId === normalizedId(predicate.canonicalWaterbodyId)
      );
    case "within_distance_of_waterbody": {
      const meters = finiteNonNegative(predicate.meters, "meters");
      const canonicalId = normalizedId(predicate.canonicalWaterbodyId);
      if (
        context.water.resolutionState === "resolved" &&
        context.water.canonicalWaterbodyId === canonicalId
      ) {
        return meters >= 0;
      }
      return (context.water.proximities ?? []).some(
        (proximity) =>
          proximity.canonicalWaterbodyId === canonicalId &&
          Number.isFinite(proximity.distanceM) &&
          proximity.distanceM >= 0 &&
          proximity.distanceM <= meters
      );
    }
    case "nearest_named_waterbody":
      return nearestNamedWaterbody(context, predicate.waterType, predicate.maxDistanceM) !== null;
    case "all":
      return predicate.predicates.every((child) => evaluateGeoPredicate(context, child));
    case "any":
      return predicate.predicates.some((child) => evaluateGeoPredicate(context, child));
    case "not":
      return !evaluateGeoPredicate(context, predicate.predicate);
  }
}

/** Evaluate only the location portion of an event; absent context is conservative false. */
export function evaluateGameplayEvent(
  event: GameplayEvent,
  predicate: GeoPredicate
): boolean {
  return event.location ? evaluateGeoPredicate(event.location, predicate) : false;
}

export type GeoWaterbodyDistanceResolver = (
  context: GeoContext,
  canonicalWaterbodyId: string
) => number | null | Promise<number | null>;

/** Async evaluator for callers that want to fetch one bounded canonical index result on demand. */
export async function evaluateGeoPredicateAsync(
  context: GeoContext,
  predicate: GeoPredicate,
  resolveDistance: GeoWaterbodyDistanceResolver
): Promise<boolean> {
  switch (predicate.kind) {
    case "all":
      for (const child of predicate.predicates) {
        if (!await evaluateGeoPredicateAsync(context, child, resolveDistance)) return false;
      }
      return true;
    case "any":
      for (const child of predicate.predicates) {
        if (await evaluateGeoPredicateAsync(context, child, resolveDistance)) return true;
      }
      return false;
    case "not":
      return !(await evaluateGeoPredicateAsync(context, predicate.predicate, resolveDistance));
    case "within_distance_of_waterbody": {
      if (evaluateGeoPredicate(context, predicate)) return true;
      const distanceM = await resolveDistance(context, normalizedId(predicate.canonicalWaterbodyId));
      return distanceM !== null && Number.isFinite(distanceM) && distanceM >= 0 && distanceM <= predicate.meters;
    }
    default:
      return evaluateGeoPredicate(context, predicate);
  }
}

/** Convenience constructors keep content definitions readable while persisting IDs. */
export const countryIs = (countryId: string): GeoPredicate => ({
  kind: "country_is",
  countryId: normalizedId(countryId)
});
export const admin1Is = (admin1Id: string): GeoPredicate => ({
  kind: "admin1_is",
  admin1Id: normalizedId(admin1Id)
});
export const waterTypeIs = (waterType: GeoWaterType): GeoPredicate => ({
  kind: "water_type_is",
  waterType
});
export const waterbodyIs = (canonicalWaterbodyId: string): GeoPredicate => ({
  kind: "waterbody_is",
  canonicalWaterbodyId: normalizedId(canonicalWaterbodyId)
});
export const marineParentIs = (canonicalWaterbodyId: string): GeoPredicate => ({
  kind: "marine_parent_is",
  canonicalWaterbodyId: normalizedId(canonicalWaterbodyId)
});
export const withinDistanceOfWaterbody = (
  canonicalWaterbodyId: string,
  meters: number
): GeoPredicate => ({
  kind: "within_distance_of_waterbody",
  canonicalWaterbodyId: normalizedId(canonicalWaterbodyId),
  meters: finiteNonNegative(meters, "meters")
});
export const nearestNamedWaterbodyIs = (
  waterType: GeoWaterType,
  maxDistanceM: number
): GeoPredicate => ({
  kind: "nearest_named_waterbody",
  waterType,
  maxDistanceM: finiteNonNegative(maxDistanceM, "maxDistanceM")
});
export const allOf = (...predicates: readonly GeoPredicate[]): GeoPredicate => ({
  kind: "all",
  predicates
});
export const anyOf = (...predicates: readonly GeoPredicate[]): GeoPredicate => ({
  kind: "any",
  predicates
});
export const not = (predicate: GeoPredicate): GeoPredicate => ({ kind: "not", predicate });

export type GeoWaterbodyCatalogEntry = Readonly<{
  canonicalId: string;
  waterType: GeoWaterType;
  canonicalName: string;
  aliases?: readonly string[];
  countryIds?: readonly string[];
  admin1Ids?: readonly string[];
}>;

export type GeoWaterbodyAuthoringReference = Readonly<{
  type: GeoWaterType;
  name: string;
  canonicalId?: string;
  countryId?: string;
  admin1Id?: string;
}>;

export type GeoWaterbodyAuthoringResolution = Readonly<{
  canonicalId: string;
  waterType: GeoWaterType;
  canonicalName: string;
}>;

export class GeoAuthoringValidationError extends Error {
  constructor(
    readonly code: "invalid_reference" | "not_found" | "ambiguous" | "canonical_id_mismatch",
    message: string
  ) {
    super(message);
    this.name = "GeoAuthoringValidationError";
  }
}

function authoringName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function hasName(entry: GeoWaterbodyCatalogEntry, name: string): boolean {
  const normalized = authoringName(name);
  return [entry.canonicalName, ...(entry.aliases ?? [])].some(
    (candidate) => authoringName(candidate) === normalized
  );
}

/** Resolve authoring references against a generated catalog, never dynamically at runtime. */
export function resolveGeoWaterbodyReference(
  reference: GeoWaterbodyAuthoringReference,
  catalog: readonly GeoWaterbodyCatalogEntry[]
): GeoWaterbodyAuthoringResolution {
  const name = reference.name.trim();
  if (!name || !reference.type) {
    throw new GeoAuthoringValidationError(
      "invalid_reference",
      "waterbody authoring references require a type and name"
    );
  }

  if (reference.canonicalId?.trim()) {
    const canonicalId = normalizedId(reference.canonicalId);
    const entry = catalog.find((candidate) => candidate.canonicalId === canonicalId);
    if (!entry) {
      throw new GeoAuthoringValidationError(
        "canonical_id_mismatch",
        `canonical waterbody ${canonicalId} is not present in the authoring catalog`
      );
    }
    const countryMatches = !reference.countryId?.trim() || entry.countryIds?.includes(normalizedId(reference.countryId));
    const admin1Matches = !reference.admin1Id?.trim() || entry.admin1Ids?.includes(normalizedId(reference.admin1Id));
    if (entry.waterType !== reference.type || !hasName(entry, name) || !countryMatches || !admin1Matches) {
      throw new GeoAuthoringValidationError(
        "canonical_id_mismatch",
        `canonical waterbody ${canonicalId} does not match ${reference.type}/${name}`
      );
    }
    return {
      canonicalId: entry.canonicalId,
      waterType: entry.waterType,
      canonicalName: entry.canonicalName
    };
  }

  let matches = catalog.filter(
    (entry) => entry.waterType === reference.type && hasName(entry, name)
  );
  if (reference.countryId?.trim()) {
    const countryId = normalizedId(reference.countryId);
    matches = matches.filter((entry) => entry.countryIds?.includes(countryId));
  }
  if (reference.admin1Id?.trim()) {
    const admin1Id = normalizedId(reference.admin1Id);
    matches = matches.filter((entry) => entry.admin1Ids?.includes(admin1Id));
  }
  if (matches.length === 0) {
    throw new GeoAuthoringValidationError(
      "not_found",
      `no canonical ${reference.type} matches the authoring name ${name}`
    );
  }
  if (matches.length !== 1) {
    throw new GeoAuthoringValidationError(
      "ambiguous",
      `authoring name ${name} is ambiguous: it matches ${matches.length} canonical ${reference.type} waterbodies; add a region or canonical_id`
    );
  }
  const [entry] = matches;
  if (!entry) {
    throw new GeoAuthoringValidationError("not_found", `no canonical match for ${name}`);
  }
  return {
    canonicalId: entry.canonicalId,
    waterType: entry.waterType,
    canonicalName: entry.canonicalName
  };
}
