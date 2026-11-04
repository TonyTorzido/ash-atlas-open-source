import type { LatLon } from "./types.js";

const EARTH_RADIUS_M = 6_371_008.8;
const WGS84_SEMI_MAJOR_AXIS_M = 6_378_137;
const WGS84_FLATTENING = 1 / 298.257_223_563;
const WGS84_SEMI_MINOR_AXIS_M = WGS84_SEMI_MAJOR_AXIS_M * (1 - WGS84_FLATTENING);

export const DEFAULT_PLAYER_SPAWN: Readonly<LatLon> = {
  lat: 35.0844,
  lon: -106.6504
};

/**
 * Hard latitude edge of the playable world. Web Mercator map and server spatial
 * systems stop at about 85.0511 degrees; everything beyond this edge is fog.
 * The edge itself is inclusive.
 */
export const WORLD_EDGE_MAX_ABS_LATITUDE = 85;
/** Error code for explicit requests (travel, flag placement) that reach past the world edge. */
export const WORLD_EDGE_ERROR_CODE = "WORLD_EDGE_REACHED";
export const WORLD_EDGE_MESSAGE = "The map ends here — beyond lies only fog.";

export function isWithinWorldEdge(point: Readonly<LatLon>): boolean {
  return isFiniteLatLon(point.lat, point.lon) &&
    Math.abs(point.lat) <= WORLD_EDGE_MAX_ABS_LATITUDE;
}

/**
 * Nearest point on or inside the world edge (same meridian). Returns the input
 * object itself when it is already inside the edge.
 */
export function clampToWorldEdge(point: LatLon): LatLon {
  if (!(Math.abs(point.lat) > WORLD_EDGE_MAX_ABS_LATITUDE)) return point;
  return {
    lat: Math.sign(point.lat) * WORLD_EDGE_MAX_ABS_LATITUDE,
    lon: point.lon
  };
}

export function isFiniteLatLon(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

export function distanceMeters(a: LatLon, b: LatLon): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = Math.min(1, Math.max(0,
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon));
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Matches PostGIS geography distance for the short WGS84 paths used by territory checks. */
export function wgs84DistanceMeters(a: LatLon, b: LatLon): number {
  const phi1 = toRadians(a.lat);
  const phi2 = toRadians(b.lat);
  const reducedLat1 = Math.atan((1 - WGS84_FLATTENING) * Math.tan(phi1));
  const reducedLat2 = Math.atan((1 - WGS84_FLATTENING) * Math.tan(phi2));
  const sinU1 = Math.sin(reducedLat1);
  const cosU1 = Math.cos(reducedLat1);
  const sinU2 = Math.sin(reducedLat2);
  const cosU2 = Math.cos(reducedLat2);
  const longitudeDelta = toRadians(b.lon - a.lon);
  let lambda = longitudeDelta;
  let sigma = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    const x = cosU2 * sinLambda;
    const y = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
    sinSigma = Math.sqrt(x * x + y * y);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha === 0
      ? 0
      : cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha;
    const coefficient = WGS84_FLATTENING / 16 * cosSqAlpha
      * (4 + WGS84_FLATTENING * (4 - 3 * cosSqAlpha));
    const previousLambda = lambda;
    lambda = longitudeDelta + (1 - coefficient) * WGS84_FLATTENING * sinAlpha
      * (sigma + coefficient * sinSigma
        * (cos2SigmaM + coefficient * cosSigma
          * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - previousLambda) <= 1e-12) {
      const uSq = cosSqAlpha
        * (WGS84_SEMI_MAJOR_AXIS_M ** 2 - WGS84_SEMI_MINOR_AXIS_M ** 2)
        / WGS84_SEMI_MINOR_AXIS_M ** 2;
      const seriesA = 1 + uSq / 16_384
        * (4_096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
      const seriesB = uSq / 1_024
        * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
      const deltaSigma = seriesB * sinSigma
        * (cos2SigmaM + seriesB / 4
          * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
            - seriesB / 6 * cos2SigmaM
              * (-3 + 4 * sinSigma * sinSigma)
              * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
      return WGS84_SEMI_MINOR_AXIS_M * seriesA * (sigma - deltaSigma);
    }
  }

  return distanceMeters(a, b);
}

/** Matches PostGIS ST_Project for the short WGS84 paths used to render territory circles. */
export function wgs84DestinationPoint(
  center: LatLon,
  distanceM: number,
  bearingDegrees: number
): LatLon {
  if (!isFiniteLatLon(center.lat, center.lon)) throw new TypeError("center must be a finite WGS84 coordinate");
  if (!Number.isFinite(distanceM) || distanceM < 0) throw new TypeError("distance must be finite and non-negative");
  if (!Number.isFinite(bearingDegrees)) throw new TypeError("bearing must be finite");
  if (distanceM === 0) return { ...center };

  const alpha1 = toRadians(bearingDegrees);
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);
  const tanU1 = (1 - WGS84_FLATTENING) * Math.tan(toRadians(center.lat));
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq = cosSqAlpha
    * (WGS84_SEMI_MAJOR_AXIS_M ** 2 - WGS84_SEMI_MINOR_AXIS_M ** 2)
    / WGS84_SEMI_MINOR_AXIS_M ** 2;
  const seriesA = 1 + uSq / 16_384
    * (4_096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const seriesB = uSq / 1_024
    * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  let sigma = distanceM / (WGS84_SEMI_MINOR_AXIS_M * seriesA);
  let previousSigma = Number.POSITIVE_INFINITY;
  let cos2SigmaM = 0;
  let sinSigma = 0;
  let cosSigma = 0;

  while (Math.abs(sigma - previousSigma) > 1e-12) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const deltaSigma = seriesB * sinSigma
      * (cos2SigmaM + seriesB / 4
        * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
          - seriesB / 6 * cos2SigmaM
            * (-3 + 4 * sinSigma * sinSigma)
            * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    previousSigma = sigma;
    sigma = distanceM / (WGS84_SEMI_MINOR_AXIS_M * seriesA) + deltaSigma;
  }

  const temporary = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const lat2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - WGS84_FLATTENING) * Math.sqrt(sinAlpha * sinAlpha + temporary * temporary)
  );
  const lambda = Math.atan2(
    sinSigma * sinAlpha1,
    cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1
  );
  const coefficient = WGS84_FLATTENING / 16 * cosSqAlpha
    * (4 + WGS84_FLATTENING * (4 - 3 * cosSqAlpha));
  const longitudeCorrection = lambda - (1 - coefficient) * WGS84_FLATTENING * sinAlpha
    * (sigma + coefficient * sinSigma
      * (cos2SigmaM + coefficient * cosSigma
        * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  return {
    lat: toDegrees(lat2),
    lon: ((center.lon + toDegrees(longitudeCorrection) + 540) % 360) - 180
  };
}

export function destinationPoint(
  center: LatLon,
  distanceM: number,
  bearingDegrees: number
): LatLon {
  if (!isFiniteLatLon(center.lat, center.lon)) throw new TypeError("center must be a finite WGS84 coordinate");
  if (!Number.isFinite(distanceM) || distanceM < 0) throw new TypeError("distance must be finite and non-negative");
  if (!Number.isFinite(bearingDegrees)) throw new TypeError("bearing must be finite");
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const bearing = toRadians(bearingDegrees);
  const lat1 = toRadians(center.lat);
  const lon1 = toRadians(center.lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
    Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );
  return {
    lat: toDegrees(lat2),
    lon: ((toDegrees(lon2) + 540) % 360) - 180
  };
}

/** Wraps a finite longitude into [-180, 180), keeping an exact 180 as 180. */
export function normalizeLongitude(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/** Signed shortest east-positive longitude change from `from` to `to`, across ±180°. */
export function longitudeDeltaDegrees(from: number, to: number): number {
  const raw = to - from;
  if (raw >= -180 && raw < 180) return raw;
  const delta = ((((raw + 180) % 360) + 360) % 360) - 180;
  return Object.is(delta, -0) ? 0 : delta;
}

/** Straight-line lat/lon interpolation that takes the short way across the antimeridian. */
export function interpolateLatLon(from: LatLon, to: LatLon, fraction: number): LatLon {
  return {
    lat: from.lat + (to.lat - from.lat) * fraction,
    lon: normalizeLongitude(from.lon + longitudeDeltaDegrees(from.lon, to.lon) * fraction)
  };
}

export function moveToward(
  current: LatLon,
  target: LatLon,
  maxDistanceMeters: number
): LatLon {
  const distance = distanceMeters(current, target);
  if (distance <= maxDistanceMeters || distance === 0) {
    return { ...target };
  }
  return interpolateLatLon(current, target, maxDistanceMeters / distance);
}

export function isInsideBroadNewMexicoBounds(point: LatLon): boolean {
  return point.lat >= 31 && point.lat <= 38 && point.lon >= -110 && point.lon <= -103;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

