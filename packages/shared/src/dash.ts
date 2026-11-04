import { destinationPoint } from "./geo.js";
import type { LatLon } from "./types.js";

/**
 * Overworld dash: the one place every dash constant lives (server, client and tests read these).
 *
 * Direction on the wire is a WORLD-space unit vector: dirX = east, dirY = north. The client
 * converts its screen-space input through the map bearing before sending.
 */
/** How long the dash movement lasts (scaled with the distance, so the dash speed and snap stay the same). */
export const DASH_DURATION_MS = 150;
/** Distance covered: 1.2 s of walking at the default speed (about 75 px at zoom 15). An emergency dodge, not travel. */
export const DASH_DISTANCE_M = 150;
/** Dash speed implied by the distance and duration. */
export const DASH_SPEED_MPS = DASH_DISTANCE_M / (DASH_DURATION_MS / 1_000);
/** Time from one accepted dash until the next one may start. Long on purpose: walk out of telegraphs, dash in emergencies. */
export const DASH_COOLDOWN_MS = 3_000;
/** Mob (and PvP) damage is skipped for this long from the dash start. */
export const DASH_IFRAME_MS = 200;
/** A direction vector must be this close to unit length (|v| in [1 - t, 1 + t]). */
export const DASH_DIRECTION_UNIT_TOLERANCE = 0.02;
/** Shorter than this after the leash/edge clamp and the dash is rejected as pointless. */
export const DASH_MIN_DISTANCE_M = 2;

/** Compass bearing (0 = north, 90 = east) for a world-space unit vector. */
export function dashBearingDeg(dirX: number, dirY: number): number {
  const deg = (Math.atan2(dirX, dirY) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** World-space unit vector for a compass bearing. */
export function dashDirectionForBearing(bearingDeg: number): { dirX: number; dirY: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  return { dirX: Math.sin(rad), dirY: Math.cos(rad) };
}

export function isDashDirectionUnit(dirX: number, dirY: number): boolean {
  if (!Number.isFinite(dirX) || !Number.isFinite(dirY)) return false;
  return Math.abs(Math.hypot(dirX, dirY) - 1) <= DASH_DIRECTION_UNIT_TOLERANCE;
}

/** Unclamped end point of a full-length dash. */
export function dashEndPoint(origin: LatLon, dirX: number, dirY: number, distanceM = DASH_DISTANCE_M): LatLon {
  return destinationPoint(origin, distanceM, dashBearingDeg(dirX, dirY));
}
