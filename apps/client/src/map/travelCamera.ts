import { distanceMeters, type LatLon } from "@ash-atlas/shared";

const DEG = Math.PI / 180;
const EQUATOR_M = 40_075_016;

export const WORLD_MAP_TRAVEL_INTRO_MS = 1_100;
export const WORLD_MAP_TRAVEL_INTRO_REDUCED_MS = 250;
/** Arrival nudges in from the route frame, never past this. */
export const WORLD_MAP_TRAVEL_ARRIVAL_ZOOM = 5;
/** Closest route frame: short hops still show the surrounding region. */
export const WORLD_MAP_TRAVEL_MAX_FRAME_ZOOM = 4.5;
/** Routes longer than this are framed at globe level. */
export const WORLD_MAP_TRAVEL_GLOBE_ROUTE_M = 6_000_000;

/** The intro never eats more than 40% of the (server-timed) trip. */
export function worldMapTravelIntroMs(durationMs: number, reducedMotion: boolean): number {
  if (durationMs <= 0) return 0;
  const base = reducedMotion ? WORLD_MAP_TRAVEL_INTRO_REDUCED_MS : WORLD_MAP_TRAVEL_INTRO_MS;
  return Math.min(base, Math.round(durationMs * 0.4));
}

/** Great-circle midpoint, safe across the antimeridian and over the poles. */
export function greatCircleMidpoint(a: LatLon, b: LatLon): LatLon {
  const vec = (p: LatLon): [number, number, number] => [
    Math.cos(p.lat * DEG) * Math.cos(p.lon * DEG),
    Math.cos(p.lat * DEG) * Math.sin(p.lon * DEG),
    Math.sin(p.lat * DEG)
  ];
  const va = vec(a);
  const vb = vec(b);
  const sum = [va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]] as const;
  const len = Math.hypot(sum[0], sum[1], sum[2]);
  if (len < 1e-9) return a;
  return {
    lat: Math.asin(sum[2] / len) / DEG,
    lon: Math.atan2(sum[1], sum[0]) / DEG
  };
}

/**
 * Camera that frames both route ends: centred on their midpoint at a zoom that fits the
 * span inside the viewport's shorter side, clamped between globe level (long trips) and a
 * regional frame (short hops keep their surroundings in view).
 */
export function worldMapTravelIntroCamera(
  origin: LatLon,
  destination: LatLon,
  viewportWidthPx: number,
  viewportHeightPx = viewportWidthPx
): Readonly<{ center: LatLon; zoom: number }> {
  const center = greatCircleMidpoint(origin, destination);
  const meters = distanceMeters(origin, destination);
  if (meters >= WORLD_MAP_TRAVEL_GLOBE_ROUTE_M) return { center, zoom: 1 };
  const fitPx = 0.55 * Math.max(Math.min(viewportWidthPx, viewportHeightPx), 200);
  const fit = Math.log2(
    (fitPx * EQUATOR_M * Math.max(Math.cos(center.lat * DEG), 0.05)) /
      (512 * Math.max(meters, 1))
  );
  return { center, zoom: Math.max(1, Math.min(WORLD_MAP_TRAVEL_MAX_FRAME_ZOOM, fit)) };
}

/** Arrival settles on the destination with a gentle push-in from the route frame. */
export function worldMapTravelArrivalZoom(frameZoom: number): number {
  return Math.min(Math.max(frameZoom, 1) + 0.75, WORLD_MAP_TRAVEL_ARRIVAL_ZOOM);
}
