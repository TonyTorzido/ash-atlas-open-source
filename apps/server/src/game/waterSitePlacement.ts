import { DROWNED_CITY_WORLD_ENTRANCE_RULE, distanceMeters, type LatLon, type WaterSiteKind } from "@ash-atlas/shared";

import { deterministicUnit } from "./populationZonesV2Identity.js";
import { POPULATION_ZONE_V2_EARTH_RADIUS_M } from "./populationZonesV2Geometry.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";

/**
 * Deterministic water sites (docs/design/WATER_GAME_PLAN.md, phases C-E),
 * placed the way ocean Sulfur is placed (oceanSulfurPlacement.ts): the sphere
 * is cut into equal-area latitude bands and columns of a target area, every
 * domain owns one deterministic slot, and a slot becomes a site only when the
 * authoritative World surface at that point is eligible water. A domain whose
 * slot lands on land has no site, so the density is one site per target area
 * of eligible water. Nothing is stored: the same id always resolves to the same
 * point, and the server re-checks eligibility before any action.
 *
 * - Pearl Beds: one per 15 km² of coastal ocean or lake water (unclaimable).
 * - Whirlpools: fixed pairs. Each 1,600 km² pair domain owns one pair whose
 *   ends are 5-50 km apart (most within 20 km); a short fixed list of long
 *   pairs crosses whole oceans. Both ends must be coastal ocean or a major lake.
 * - Drowned City sites: one per DROWNED_CITY_WORLD_ENTRANCE_RULE.targetAreaKm2 (125 km²) of coastal
 *   ocean (about one per 25 km of coast), ids `drowned3:<band>:<column>`. Phase E puts the dungeon
 *   entrances at these same ids, so this placement is the shared source. The earlier families
 *   (`drowned:` 40,000 km², `drowned2:` 2,500 km²) still resolve by id for runs already inside, but
 *   are no longer listed or entered.
 */

export const WATER_SITE_PLACEMENT_VERSION = "water-sites-v1";
/** Ocean counts as coastal within this distance of the coastline. */
export const WATER_SITE_COAST_DISTANCE_M = 5_000;

type DomainFamily = Readonly<{ key: string; targetAreaKm2: number }>;

export const PEARL_BED_FAMILY: DomainFamily = Object.freeze({ key: "pearl", targetAreaKm2: 15 });
export const WHIRLPOOL_FAMILY: DomainFamily = Object.freeze({ key: "whirl", targetAreaKm2: 1_600 });
export const DROWNED_CITY_FAMILY: DomainFamily = Object.freeze({
  key: "drowned3", targetAreaKm2: DROWNED_CITY_WORLD_ENTRANCE_RULE.targetAreaKm2
});
/** The earlier Drowned City families (40,000 km², then 2,500 km²): resolvable by id only. */
export const LEGACY_DROWNED_CITY_FAMILIES: readonly DomainFamily[] = Object.freeze([
  Object.freeze({ key: "drowned", targetAreaKm2: 40_000 }),
  Object.freeze({ key: "drowned2", targetAreaKm2: 2_500 })
]);

export const WHIRLPOOL_MIN_PAIR_M = 5_000;
export const WHIRLPOOL_MAX_PAIR_M = 50_000;
export const LONG_WHIRLPOOL_PAIR_COUNT = 48;
export const LONG_WHIRLPOOL_MIN_M = 1_000_000;

export type EqualAreaDomain = Readonly<{
  band: number;
  column: number;
  bounds: Readonly<{ southLat: number; northLat: number; westLon: number; eastLon: number }>;
}>;

export type WaterSiteCandidate = Readonly<{
  siteId: string;
  kind: WaterSiteKind;
  position: LatLon;
  /** Whirlpools: the other end of the pair. */
  partner?: Readonly<{ siteId: string; position: LatLon }>;
}>;

/** What a World lookup says about one site point. */
export type WaterSiteSurface = "coastal_ocean" | "major_lake" | "lake" | "other";

export function classifyWaterSiteSurface(
  result: Pick<WorldGameplayEnvironmentResult, "ok" | "surfaceKind" | "waterKind" | "insideMajorLake" | "coastlineDistanceM" | "oceanCoastSurface" | "lakeSurface"> | null | undefined
): WaterSiteSurface {
  if (!result || result.ok === false) return "other";
  const lake = result.waterKind === "lake" || result.lakeSurface?.isLake === true;
  if (lake || (result.insideMajorLake === true && result.surfaceKind === "water")) {
    return result.insideMajorLake === true ? "major_lake" : "lake";
  }
  if (result.waterKind !== "ocean") return "other";
  if (result.oceanCoastSurface?.isOceanCoast === true) return "coastal_ocean";
  const coast = result.coastlineDistanceM;
  return typeof coast === "number" && Number.isFinite(coast) && coast <= WATER_SITE_COAST_DISTANCE_M
    ? "coastal_ocean"
    : "other";
}

/** Whether a site of this kind may stand on this surface. */
export function isEligibleWaterSiteSurface(kind: WaterSiteKind, surface: WaterSiteSurface): boolean {
  switch (kind) {
    case "pearl_bed": return surface !== "other";
    case "whirlpool": return surface === "coastal_ocean" || surface === "major_lake";
    case "drowned_city_site": return surface === "coastal_ocean";
  }
}

function bandCount(family: DomainFamily): number {
  return Math.max(1, Math.round(
    Math.PI * POPULATION_ZONE_V2_EARTH_RADIUS_M / Math.sqrt(family.targetAreaKm2 * 1_000_000)
  ));
}

function columnCount(family: DomainFamily, band: number): number {
  const bands = bandCount(family);
  const radiansPerBand = Math.PI / bands;
  const south = -Math.PI / 2 + band * radiansPerBand;
  const north = band === bands - 1 ? Math.PI / 2 : south + radiansPerBand;
  const areaM2 = 2 * Math.PI * POPULATION_ZONE_V2_EARTH_RADIUS_M ** 2 * (Math.sin(north) - Math.sin(south));
  return Math.max(1, Math.round(areaM2 / (family.targetAreaKm2 * 1_000_000)));
}

export function domainAt(family: DomainFamily, band: number, column: number): EqualAreaDomain | null {
  const bands = bandCount(family);
  if (!Number.isInteger(band) || band < 0 || band >= bands) return null;
  const columns = columnCount(family, band);
  if (!Number.isInteger(column) || column < 0 || column >= columns) return null;
  const degreesPerBand = 180 / bands;
  const southLat = -90 + band * degreesPerBand;
  const northLat = band === bands - 1 ? 90 : southLat + degreesPerBand;
  const span = 360 / columns;
  const westLon = -180 + column * span;
  const eastLon = column === columns - 1 ? 180 : westLon + span;
  return { band, column, bounds: { southLat, northLat, westLon, eastLon } };
}

export function domainForPoint(family: DomainFamily, point: LatLon): EqualAreaDomain {
  const bands = bandCount(family);
  const band = Math.max(0, Math.min(bands - 1, Math.floor((point.lat + 90) / (180 / bands))));
  const columns = columnCount(family, band);
  const lon = normalizeLongitude(point.lon);
  const column = Math.max(0, Math.min(columns - 1, Math.floor(((lon + 180) / 360) * columns)));
  return domainAt(family, band, column)!;
}

/** The domains whose area may reach within `radiusM` of `center`. */
export function domainsNear(family: DomainFamily, center: LatLon, radiusM: number): EqualAreaDomain[] {
  const sideM = Math.sqrt(family.targetAreaKm2 * 1_000_000);
  // Half a domain side apart, every domain in reach contains a sample point.
  const stepM = sideM / 2;
  const reachM = radiusM + sideM;
  const steps = Math.ceil(reachM / stepM);
  const found = new Map<string, EqualAreaDomain>();
  for (let north = -steps; north <= steps; north += 1) {
    for (let east = -steps; east <= steps; east += 1) {
      const point = offsetMeters(center, north * stepM, east * stepM);
      const domain = domainForPoint(family, point);
      found.set(`${domain.band}:${domain.column}`, domain);
    }
  }
  return [...found.values()].sort((left, right) => left.band - right.band || left.column - right.column);
}

/** One deterministic, area-uniform point inside a domain. */
export function domainSlot(family: DomainFamily, domain: EqualAreaDomain, salt: string): LatLon {
  const latitudeUnit = deterministicUnit(WATER_SITE_PLACEMENT_VERSION, family.key, domain.band, domain.column, salt, "lat");
  const longitudeUnit = deterministicUnit(WATER_SITE_PLACEMENT_VERSION, family.key, domain.band, domain.column, salt, "lon");
  const southSine = Math.sin(toRadians(domain.bounds.southLat));
  const northSine = Math.sin(toRadians(domain.bounds.northLat));
  return {
    lat: toDegrees(Math.asin(southSine + (northSine - southSine) * latitudeUnit)),
    lon: normalizeLongitude(domain.bounds.westLon + (domain.bounds.eastLon - domain.bounds.westLon) * longitudeUnit)
  };
}

const b36 = (value: number): string => value.toString(36);

function pearlBed(domain: EqualAreaDomain): WaterSiteCandidate {
  return {
    siteId: `pearl:${b36(domain.band)}:${b36(domain.column)}`,
    kind: "pearl_bed",
    position: domainSlot(PEARL_BED_FAMILY, domain, "bed")
  };
}

function drownedCitySite(domain: EqualAreaDomain, family: DomainFamily = DROWNED_CITY_FAMILY): WaterSiteCandidate {
  return {
    siteId: `${family.key}:${b36(domain.band)}:${b36(domain.column)}`,
    kind: "drowned_city_site",
    position: domainSlot(family, domain, "site")
  };
}

/** Whether a Drowned City site id belongs to a retired family (resolvable, never listed or entered). */
export function isLegacyDrownedCitySiteId(siteId: string): boolean {
  return LEGACY_DROWNED_CITY_FAMILIES.some((family) => siteId.startsWith(`${family.key}:`));
}

/** Both ends of the near pair a whirlpool domain owns. */
function whirlpoolPair(domain: EqualAreaDomain): [WaterSiteCandidate, WaterSiteCandidate] {
  const a = domainSlot(WHIRLPOOL_FAMILY, domain, "a");
  const bearing = 360 * deterministicUnit(WATER_SITE_PLACEMENT_VERSION, "whirl", domain.band, domain.column, "bearing");
  // Squared unit: most pairs land in the shorter half of the 5-50 km range.
  const unit = deterministicUnit(WATER_SITE_PLACEMENT_VERSION, "whirl", domain.band, domain.column, "distance");
  const distanceM = WHIRLPOOL_MIN_PAIR_M + (WHIRLPOOL_MAX_PAIR_M - WHIRLPOOL_MIN_PAIR_M) * unit * unit;
  const b = destinationPoint(a, bearing, distanceM);
  const base = `whirl:${b36(domain.band)}:${b36(domain.column)}`;
  return endpoints(base, a, b);
}

function endpoints(base: string, a: LatLon, b: LatLon): [WaterSiteCandidate, WaterSiteCandidate] {
  return [
    { siteId: `${base}:a`, kind: "whirlpool", position: a, partner: { siteId: `${base}:b`, position: b } },
    { siteId: `${base}:b`, kind: "whirlpool", position: b, partner: { siteId: `${base}:a`, position: a } }
  ];
}

let longPairs: readonly [WaterSiteCandidate, WaterSiteCandidate][] | null = null;

/** The fixed cross-ocean pairs (long enough to cross an ocean). */
export function longWhirlpoolPairs(): readonly [WaterSiteCandidate, WaterSiteCandidate][] {
  if (longPairs) return longPairs;
  const pairs: [WaterSiteCandidate, WaterSiteCandidate][] = [];
  for (let index = 0; index < LONG_WHIRLPOOL_PAIR_COUNT; index += 1) {
    const a = spherePoint(`long-${index}`, "a");
    const b = spherePoint(`long-${index}`, "b");
    if (distanceMeters(a, b) < LONG_WHIRLPOOL_MIN_M) continue;
    pairs.push(endpoints(`whirl-long:${b36(index)}`, a, b));
  }
  longPairs = pairs;
  return pairs;
}

function spherePoint(key: string, end: string): LatLon {
  const latitudeUnit = deterministicUnit(WATER_SITE_PLACEMENT_VERSION, key, end, "lat");
  const longitudeUnit = deterministicUnit(WATER_SITE_PLACEMENT_VERSION, key, end, "lon");
  return { lat: toDegrees(Math.asin(2 * latitudeUnit - 1)), lon: -180 + 360 * longitudeUnit };
}

/** Every candidate site (before the water check) within `radiusM` of `center`. */
export function waterSiteCandidatesNear(center: LatLon, radiusM: number): WaterSiteCandidate[] {
  const sites: WaterSiteCandidate[] = [];
  const within = (site: WaterSiteCandidate) => distanceMeters(center, site.position) <= radiusM;
  for (const domain of domainsNear(PEARL_BED_FAMILY, center, radiusM)) {
    const site = pearlBed(domain);
    if (within(site)) sites.push(site);
  }
  for (const domain of domainsNear(DROWNED_CITY_FAMILY, center, radiusM)) {
    const site = drownedCitySite(domain);
    if (within(site)) sites.push(site);
  }
  for (const domain of domainsNear(WHIRLPOOL_FAMILY, center, radiusM + WHIRLPOOL_MAX_PAIR_M)) {
    for (const site of whirlpoolPair(domain)) if (within(site)) sites.push(site);
  }
  for (const pair of longWhirlpoolPairs()) {
    for (const site of pair) if (within(site)) sites.push(site);
  }
  return sites.sort((left, right) => left.siteId.localeCompare(right.siteId));
}

/** Resolves a site id back to its point (and partner). Null for an id this placement never makes. */
export function waterSiteCandidateById(siteId: string): WaterSiteCandidate | null {
  const parts = siteId.split(":");
  const parse = (value: string | undefined): number | null => {
    if (value === undefined || !/^[0-9a-z]{1,8}$/u.test(value)) return null;
    const parsed = Number.parseInt(value, 36);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const [kind, first, second, end] = parts;
  if (kind === "whirl-long" && parts.length === 3) {
    const index = parse(first);
    const pair = longWhirlpoolPairs().find(([a]) => a.siteId === `whirl-long:${first}:a`);
    if (index === null || !pair) return null;
    return second === "a" ? pair[0] : second === "b" ? pair[1] : null;
  }
  const band = parse(first);
  const column = parse(second);
  if (band === null || column === null) return null;
  if (kind === "pearl" && parts.length === 3) {
    const domain = domainAt(PEARL_BED_FAMILY, band, column);
    return domain && pearlBed(domain).siteId === siteId ? pearlBed(domain) : null;
  }
  const drownedFamily = [DROWNED_CITY_FAMILY, ...LEGACY_DROWNED_CITY_FAMILIES].find((family) => family.key === kind);
  if (drownedFamily && parts.length === 3) {
    const family = drownedFamily;
    const domain = domainAt(family, band, column);
    return domain && drownedCitySite(domain, family).siteId === siteId ? drownedCitySite(domain, family) : null;
  }
  if (kind === "whirl" && parts.length === 4 && (end === "a" || end === "b")) {
    const domain = domainAt(WHIRLPOOL_FAMILY, band, column);
    if (!domain) return null;
    const pair = whirlpoolPair(domain);
    const site = end === "a" ? pair[0] : pair[1];
    return site.siteId === siteId ? site : null;
  }
  return null;
}

function offsetMeters(origin: LatLon, northM: number, eastM: number): LatLon {
  const lat = Math.max(-89.999, Math.min(89.999, origin.lat + toDegrees(northM / POPULATION_ZONE_V2_EARTH_RADIUS_M)));
  const lon = origin.lon + toDegrees(eastM / (POPULATION_ZONE_V2_EARTH_RADIUS_M * Math.max(1e-6, Math.cos(toRadians(lat)))));
  return { lat, lon: normalizeLongitude(lon) };
}

export function destinationPoint(origin: LatLon, bearingDegrees: number, distanceM: number): LatLon {
  const angular = distanceM / POPULATION_ZONE_V2_EARTH_RADIUS_M;
  const bearing = toRadians(bearingDegrees);
  const lat1 = toRadians(origin.lat);
  const lon1 = toRadians(origin.lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
    Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: toDegrees(lat2), lon: normalizeLongitude(toDegrees(lon2)) };
}

function normalizeLongitude(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 && value > 0 ? 180 : normalized;
}

function toRadians(value: number): number {
  return value * Math.PI / 180;
}

function toDegrees(value: number): number {
  return value * 180 / Math.PI;
}
