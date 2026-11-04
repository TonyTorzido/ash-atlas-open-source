import { distanceMeters } from "./geo.js";
import type { LatLon } from "./types.js";

export const WORLD_MAP_TRAVEL_MIN_MS = 3_000;
export const WORLD_MAP_TRAVEL_MAX_MS = 15_000;
// The longest shortest journey on the globe is between antipodes.
export const WORLD_MAP_DISTANCE_AT_MAX_DURATION_M = distanceMeters(
  { lat: 0, lon: 0 }, { lat: 0, lon: 180 }
);
export const WORLD_MAP_ARRIVAL_MS = 320;

export function worldMapTravelDurationMs(
  origin: LatLon,
  destination: LatLon
): number {
  const normalizedDistance = Math.max(
    0,
    Math.min(
      1,
      distanceMeters(origin, destination) /
        WORLD_MAP_DISTANCE_AT_MAX_DURATION_M
    )
  );
  return Math.max(
    WORLD_MAP_TRAVEL_MIN_MS,
    normalizedDistance * WORLD_MAP_TRAVEL_MAX_MS
  );
}
