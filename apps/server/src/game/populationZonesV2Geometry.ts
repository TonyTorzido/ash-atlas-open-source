export const POPULATION_ZONE_V2_GEOMETRY_VERSION =
  "equal-area-latitude-band-v1";

export const POPULATION_ZONE_V2_EARTH_RADIUS_M = 6_371_008.8;
export const POPULATION_ZONE_V2_TARGET_AREA_M2 = 1_000_000;
export const POPULATION_ZONE_V2_NORTH_SOUTH_SPAN_M = 1_000;

export const POPULATION_ZONE_V2_LATITUDE_BAND_COUNT = Math.round(
  Math.PI * POPULATION_ZONE_V2_EARTH_RADIUS_M
    / POPULATION_ZONE_V2_NORTH_SOUTH_SPAN_M
);

const RADIANS_PER_BAND =
  Math.PI / POPULATION_ZONE_V2_LATITUDE_BAND_COUNT;
const DEGREES_PER_BAND = 180 / POPULATION_ZONE_V2_LATITUDE_BAND_COUNT;
const ID_PREFIX = "ppz2-eag1";
const ID_COMPONENT_WIDTH = 3;
const DISTANCE_EPSILON_M = 1e-6;
const MAX_GEOMETRY_CACHE_ENTRIES = 4_096;

export type PopulationZoneV2Id =
  `${typeof ID_PREFIX}/${string}/${string}`;

export type PopulationZoneV2Point = Readonly<{
  lat: number;
  lon: number;
}>;

export type PopulationZoneV2Address = Readonly<{
  band: number;
  column: number;
}>;

export type PopulationZoneV2Bounds = Readonly<{
  southLat: number;
  northLat: number;
  westLon: number;
  eastLon: number;
}>;

export type PopulationZoneV2Geometry = Readonly<{
  id: PopulationZoneV2Id;
  address: PopulationZoneV2Address;
  bounds: PopulationZoneV2Bounds;
  center: PopulationZoneV2Point;
  areaM2: number;
  areaKm2: number;
  northSouthSpanM: number;
  centerEastWestSpanM: number;
}>;

const geometryById = new Map<PopulationZoneV2Id, PopulationZoneV2Geometry>();

export function populationZoneV2IdForPoint(
  point: PopulationZoneV2Point
): PopulationZoneV2Id {
  assertPoint(point);
  const band = latitudeBandFor(point.lat);
  const columnCount = populationZoneV2ColumnCount(band);
  const column = Math.abs(point.lat) === 90
    ? 0
    : Math.min(
      columnCount - 1,
      Math.floor(
        ((normalizeLongitude(point.lon) + 180) / 360) * columnCount
      )
    );
  return populationZoneV2Id({ band, column });
}

export function populationZoneV2Id(
  address: PopulationZoneV2Address
): PopulationZoneV2Id {
  assertAddress(address);
  return `${ID_PREFIX}/${encodeIdComponent(address.band)}/${encodeIdComponent(address.column)}`;
}

export function parsePopulationZoneV2Id(
  id: string
): PopulationZoneV2Address {
  const parts = id.split("/");
  if (parts.length !== 3 || parts[0] !== ID_PREFIX) {
    throw new Error(`invalid population zone v2 id: ${id}`);
  }
  const band = decodeIdComponent(parts[1]!, id);
  const column = decodeIdComponent(parts[2]!, id);
  const address = { band, column };
  assertAddress(address);
  if (populationZoneV2Id(address) !== id) {
    throw new Error(`non-canonical population zone v2 id: ${id}`);
  }
  return address;
}

export function populationZoneV2Geometry(
  idOrAddress: PopulationZoneV2Id | PopulationZoneV2Address
): PopulationZoneV2Geometry {
  if (typeof idOrAddress === "string") {
    const cached = geometryById.get(idOrAddress);
    if (cached !== undefined) {
      geometryById.delete(idOrAddress);
      geometryById.set(idOrAddress, cached);
      return cached;
    }
  }
  const address = typeof idOrAddress === "string"
    ? parsePopulationZoneV2Id(idOrAddress)
    : checkedAddress(idOrAddress);
  const id = populationZoneV2Id(address);
  const cached = geometryById.get(id);
  if (cached !== undefined) {
    geometryById.delete(id);
    geometryById.set(id, cached);
    return cached;
  }
  const columnCount = populationZoneV2ColumnCount(address.band);
  const southLat = -90 + address.band * DEGREES_PER_BAND;
  const northLat = address.band === POPULATION_ZONE_V2_LATITUDE_BAND_COUNT - 1
    ? 90
    : southLat + DEGREES_PER_BAND;
  const longitudeSpan = 360 / columnCount;
  const westLon = -180 + address.column * longitudeSpan;
  const eastLon = address.column === columnCount - 1
    ? 180
    : westLon + longitudeSpan;
  const centerLatRadians = Math.asin(
    (Math.sin(toRadians(southLat)) + Math.sin(toRadians(northLat))) / 2
  );
  const centerLat = toDegrees(centerLatRadians);
  const centerLon = normalizeLongitude(westLon + longitudeSpan / 2);
  const areaM2 = populationZoneV2BandAreaM2(address.band) / columnCount;

  const geometry = {
    id,
    address,
    bounds: { southLat, northLat, westLon, eastLon },
    center: { lat: centerLat, lon: centerLon },
    areaM2,
    areaKm2: areaM2 / 1_000_000,
    northSouthSpanM: RADIANS_PER_BAND * POPULATION_ZONE_V2_EARTH_RADIUS_M,
    centerEastWestSpanM:
      toRadians(longitudeSpan)
      * POPULATION_ZONE_V2_EARTH_RADIUS_M
      * Math.cos(centerLatRadians)
  };
  geometryById.set(id, geometry);
  while (geometryById.size > MAX_GEOMETRY_CACHE_ENTRIES) {
    const oldest = geometryById.keys().next().value;
    if (oldest === undefined) break;
    geometryById.delete(oldest);
  }
  return geometry;
}

export function populationZoneV2ColumnCount(band: number): number {
  assertBand(band);
  return Math.max(
    1,
    Math.round(
      populationZoneV2BandAreaM2(band)
      / POPULATION_ZONE_V2_TARGET_AREA_M2
    )
  );
}

export function populationZoneV2BandAreaM2(band: number): number {
  assertBand(band);
  const south = -Math.PI / 2 + band * RADIANS_PER_BAND;
  const north = band === POPULATION_ZONE_V2_LATITUDE_BAND_COUNT - 1
    ? Math.PI / 2
    : south + RADIANS_PER_BAND;
  return 2
    * Math.PI
    * POPULATION_ZONE_V2_EARTH_RADIUS_M ** 2
    * (Math.sin(north) - Math.sin(south));
}

/**
 * Returns every edge-sharing neighbor. Across latitude bands, all cells with
 * a positive longitude-interval overlap are returned. Same-band east/west
 * neighbors wrap across the antimeridian.
 */
export function populationZoneV2Neighbors(
  id: PopulationZoneV2Id
): PopulationZoneV2Id[] {
  const address = parsePopulationZoneV2Id(id);
  const ownColumnCount = populationZoneV2ColumnCount(address.band);
  const neighbors = new Set<PopulationZoneV2Id>();

  if (ownColumnCount > 1) {
    neighbors.add(populationZoneV2Id({
      band: address.band,
      column: modulo(address.column - 1, ownColumnCount)
    }));
    neighbors.add(populationZoneV2Id({
      band: address.band,
      column: modulo(address.column + 1, ownColumnCount)
    }));
  }

  for (const adjacentBand of [address.band - 1, address.band + 1]) {
    if (
      adjacentBand < 0
      || adjacentBand >= POPULATION_ZONE_V2_LATITUDE_BAND_COUNT
    ) {
      continue;
    }
    const adjacentColumnCount = populationZoneV2ColumnCount(adjacentBand);
    const first = Math.floor(
      address.column * adjacentColumnCount / ownColumnCount
    );
    const last = Math.floor(
      (
        (address.column + 1) * adjacentColumnCount - 1
      ) / ownColumnCount
    );
    for (let column = first; column <= last; column += 1) {
      neighbors.add(populationZoneV2Id({
        band: adjacentBand,
        column: Math.min(adjacentColumnCount - 1, column)
      }));
    }
  }

  neighbors.delete(id);
  return [...neighbors].sort();
}

/**
 * Returns the inclusive graph halo out to `rings` exact neighbor steps.
 */
export function populationZoneV2Halo(
  id: PopulationZoneV2Id,
  rings: number
): PopulationZoneV2Id[] {
  parsePopulationZoneV2Id(id);
  if (!Number.isInteger(rings) || rings < 0) {
    throw new Error("population zone halo rings must be a non-negative integer");
  }
  const visited = new Set<PopulationZoneV2Id>([id]);
  let frontier = [id];
  for (let ring = 0; ring < rings; ring += 1) {
    const next = new Set<PopulationZoneV2Id>();
    for (const zoneId of frontier) {
      for (const neighbor of populationZoneV2Neighbors(zoneId)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.add(neighbor);
        }
      }
    }
    frontier = [...next];
    if (frontier.length === 0) break;
  }
  return [...visited].sort();
}

/**
 * Enumerates exactly those grid cells whose spherical latitude/longitude
 * rectangle has a minimum great-circle distance no greater than `radiusM`.
 */
export function populationZonesV2IntersectingCircle(
  center: PopulationZoneV2Point,
  radiusM: number
): PopulationZoneV2Id[] {
  assertPoint(center);
  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new Error("population zone activation radius must be non-negative");
  }
  const angularRadius = Math.min(
    Math.PI,
    radiusM / POPULATION_ZONE_V2_EARTH_RADIUS_M
  );
  const centerLatRadians = toRadians(center.lat);
  const minimumLatitude = Math.max(
    -90,
    center.lat - toDegrees(angularRadius)
  );
  const maximumLatitude = Math.min(
    90,
    center.lat + toDegrees(angularRadius)
  );
  const minimumBand = Math.max(0, latitudeBandFor(minimumLatitude) - 1);
  const maximumBand = Math.min(
    POPULATION_ZONE_V2_LATITUDE_BAND_COUNT - 1,
    latitudeBandFor(maximumLatitude) + 1
  );
  const touchesPole =
    centerLatRadians + angularRadius >= Math.PI / 2
    || centerLatRadians - angularRadius <= -Math.PI / 2;
  const longitudeHalfSpan = angularRadius >= Math.PI || touchesPole
    ? 180
    : toDegrees(Math.asin(
      Math.min(1, Math.sin(angularRadius) / Math.cos(centerLatRadians))
    ));
  const matches: PopulationZoneV2Id[] = [];

  for (let band = minimumBand; band <= maximumBand; band += 1) {
    const columnCount = populationZoneV2ColumnCount(band);
    const columns = columnsInLongitudeWindow(
      columnCount,
      center.lon,
      longitudeHalfSpan
    );
    for (const column of columns) {
      const id = populationZoneV2Id({ band, column });
      if (
        minimumDistanceToPopulationZoneV2(center, id)
        <= radiusM + DISTANCE_EPSILON_M
      ) {
        matches.push(id);
      }
    }
  }
  return matches.sort();
}

export function minimumDistanceToPopulationZoneV2(
  point: PopulationZoneV2Point,
  id: PopulationZoneV2Id
): number {
  assertPoint(point);
  const { bounds } = populationZoneV2Geometry(id);
  const pointLat = toRadians(point.lat);
  const normalizedLon = normalizeLongitude(point.lon);

  if (
    point.lat >= bounds.southLat
    && point.lat <= bounds.northLat
    && longitudeIsInsideClosedInterval(
      normalizedLon,
      bounds.westLon,
      bounds.eastLon
    )
  ) {
    return 0;
  }

  let maximumCosine = -1;
  for (const edgeLatitude of [bounds.southLat, bounds.northLat]) {
    const edgeLat = toRadians(edgeLatitude);
    const closestLon = closestLongitudeInInterval(
      normalizedLon,
      bounds.westLon,
      bounds.eastLon
    );
    const longitudeDelta = toRadians(
      shortestLongitudeDelta(normalizedLon, closestLon)
    );
    maximumCosine = Math.max(
      maximumCosine,
      Math.sin(pointLat) * Math.sin(edgeLat)
        + Math.cos(pointLat) * Math.cos(edgeLat) * Math.cos(longitudeDelta)
    );
  }

  const southLat = toRadians(bounds.southLat);
  const northLat = toRadians(bounds.northLat);
  for (const edgeLongitude of [bounds.westLon, bounds.eastLon]) {
    const longitudeDelta = toRadians(
      shortestLongitudeDelta(normalizedLon, edgeLongitude)
    );
    const coefficientA = Math.sin(pointLat);
    const coefficientB = Math.cos(pointLat) * Math.cos(longitudeDelta);
    const optimumLatitude = Math.atan2(coefficientA, coefficientB);
    const latitudeCandidates = [southLat, northLat];
    if (
      optimumLatitude >= southLat
      && optimumLatitude <= northLat
    ) {
      latitudeCandidates.push(optimumLatitude);
    }
    for (const edgeLat of latitudeCandidates) {
      maximumCosine = Math.max(
        maximumCosine,
        coefficientA * Math.sin(edgeLat)
          + coefficientB * Math.cos(edgeLat)
      );
    }
  }

  return Math.acos(clamp(maximumCosine, -1, 1))
    * POPULATION_ZONE_V2_EARTH_RADIUS_M;
}

export function greatCircleDistanceMeters(
  first: PopulationZoneV2Point,
  second: PopulationZoneV2Point
): number {
  assertPoint(first);
  assertPoint(second);
  const firstLatitude = toRadians(first.lat);
  const secondLatitude = toRadians(second.lat);
  const latitudeDelta = secondLatitude - firstLatitude;
  const longitudeDelta = toRadians(
    shortestLongitudeDelta(first.lon, second.lon)
  );
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude)
      * Math.cos(secondLatitude)
      * Math.sin(longitudeDelta / 2) ** 2;
  return 2
    * POPULATION_ZONE_V2_EARTH_RADIUS_M
    * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function normalizeLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) {
    throw new Error("longitude must be finite");
  }
  const normalized = modulo(longitude + 180, 360) - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function columnsInLongitudeWindow(
  columnCount: number,
  centerLongitude: number,
  halfSpanDegrees: number
): number[] {
  if (halfSpanDegrees >= 180) {
    return Array.from({ length: columnCount }, (_, column) => column);
  }
  const width = 360 / columnCount;
  const center = normalizeLongitude(centerLongitude) + 180;
  const first = Math.floor((center - halfSpanDegrees) / width) - 1;
  const last = Math.floor((center + halfSpanDegrees) / width) + 1;
  const columns = new Set<number>();
  for (let rawColumn = first; rawColumn <= last; rawColumn += 1) {
    columns.add(modulo(rawColumn, columnCount));
  }
  return [...columns].sort((left, right) => left - right);
}

function latitudeBandFor(latitude: number): number {
  if (latitude === 90) return POPULATION_ZONE_V2_LATITUDE_BAND_COUNT - 1;
  return Math.min(
    POPULATION_ZONE_V2_LATITUDE_BAND_COUNT - 1,
    Math.max(0, Math.floor((latitude + 90) / DEGREES_PER_BAND))
  );
}

function longitudeIsInsideClosedInterval(
  longitude: number,
  west: number,
  east: number
): boolean {
  return [longitude - 360, longitude, longitude + 360]
    .some((candidate) => candidate >= west && candidate <= east);
}

function closestLongitudeInInterval(
  longitude: number,
  west: number,
  east: number
): number {
  let closest = west;
  let shortestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of [longitude - 360, longitude, longitude + 360]) {
    const clamped = clamp(candidate, west, east);
    const distance = Math.abs(candidate - clamped);
    if (distance < shortestDistance) {
      shortestDistance = distance;
      closest = clamped;
    }
  }
  return closest;
}

function shortestLongitudeDelta(from: number, to: number): number {
  return normalizeLongitude(to - from);
}

function checkedAddress(
  address: PopulationZoneV2Address
): PopulationZoneV2Address {
  assertAddress(address);
  return { band: address.band, column: address.column };
}

function assertAddress(address: PopulationZoneV2Address): void {
  assertBand(address.band);
  const columnCount = populationZoneV2ColumnCount(address.band);
  if (
    !Number.isInteger(address.column)
    || address.column < 0
    || address.column >= columnCount
  ) {
    throw new Error(
      `population zone column must be in [0, ${columnCount - 1}]`
    );
  }
}

function assertBand(band: number): void {
  if (
    !Number.isInteger(band)
    || band < 0
    || band >= POPULATION_ZONE_V2_LATITUDE_BAND_COUNT
  ) {
    throw new Error(
      `population zone band must be in [0, ${POPULATION_ZONE_V2_LATITUDE_BAND_COUNT - 1}]`
    );
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

function encodeIdComponent(value: number): string {
  const encoded = value.toString(36).padStart(ID_COMPONENT_WIDTH, "0");
  if (encoded.length !== ID_COMPONENT_WIDTH) {
    throw new Error(`population zone id component exceeds ${ID_COMPONENT_WIDTH} digits`);
  }
  return encoded;
}

function decodeIdComponent(component: string, id: string): number {
  if (!/^[0-9a-z]{3}$/.test(component)) {
    throw new Error(`invalid population zone v2 id: ${id}`);
  }
  return Number.parseInt(component, 36);
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function toDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
