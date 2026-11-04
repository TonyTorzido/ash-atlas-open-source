import {
  CISTERN_WARRENS_MOVE_SPEED,
  CISTERN_WARRENS_PLAYER_VISUAL_HEIGHT_UNITS
} from "./dungeon.js";
import { DEFAULT_PLAYER_SPEED_MPS } from "./gameplayArea.js";
import { STANDARD_INDOOR_SPATIAL_PROFILE, type IndoorPoint } from "./indoor.js";
import type { LatLon } from "./types.js";

/**
 * Interior map space.
 *
 * Every interior is rendered by the overworld map around lat/lon (0, 0); the
 * client shows one interior at a time and the server separates instances by
 * `interior:<instance>` region/zone ids. Local room units are y-down (screen
 * space), so local +y maps to south (negative latitude): a room renders the
 * right way up on the map and combat bearings match what players see.
 *
 * One local unit covers the distance the player walks in
 * 1 / movementUnitsPerSecond seconds at the overworld pace, so every interior
 * moves at the same on-screen pace as the world. Size differences are tuned by
 * art scale, never by speed.
 */

export type InteriorSpatialProfile = Readonly<{
  movementUnitsPerSecond: number;
  playerVisualHeightUnits: number;
}>;

export const INTERIOR_SPATIAL_PROFILES = Object.freeze({
  /** Dungeons and the Cistern Warrens: half-speed local movement, half-height player. */
  dungeon: Object.freeze({
    movementUnitsPerSecond: CISTERN_WARRENS_MOVE_SPEED,
    playerVisualHeightUnits: CISTERN_WARRENS_PLAYER_VISUAL_HEIGHT_UNITS
  }),
  /** Manor rooms, salon and greenhouse. */
  standard_indoor: Object.freeze({
    movementUnitsPerSecond: STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond,
    playerVisualHeightUnits: STANDARD_INDOOR_SPATIAL_PROFILE.playerVisualHeightUnits
  })
}) satisfies Readonly<Record<string, InteriorSpatialProfile>>;

export type InteriorSpatialProfileId = keyof typeof INTERIOR_SPATIAL_PROFILES;

/** Mean-radius degrees, matching the shared haversine `distanceMeters`. */
const METERS_PER_DEGREE = 2 * Math.PI * 6_371_008.8 / 360;

export function interiorMetersPerUnit(profile: InteriorSpatialProfile): number {
  return DEFAULT_PLAYER_SPEED_MPS / profile.movementUnitsPerSecond;
}

export function interiorPlayerHeightMeters(profile: InteriorSpatialProfile): number {
  return profile.playerVisualHeightUnits * interiorMetersPerUnit(profile);
}

export function interiorLocalToLngLat(point: IndoorPoint, metersPerUnit: number): LatLon {
  return {
    lat: -point.y * metersPerUnit / METERS_PER_DEGREE,
    lon: point.x * metersPerUnit / METERS_PER_DEGREE
  };
}

export function interiorLngLatToLocal(position: LatLon, metersPerUnit: number): IndoorPoint {
  return {
    x: position.lon * METERS_PER_DEGREE / metersPerUnit,
    y: -position.lat * METERS_PER_DEGREE / metersPerUnit
  };
}

/**
 * The map zoom at which the overworld player sprite covers the interior
 * player's height (33.65 m for every indoor profile). The derivation from the
 * client's sprite presentation curve lives in the client interior-space test.
 */
export const INTERIOR_DEFAULT_ZOOM = 18.35;
/** Low enough to show a full 1000-unit room on a phone. */
export const INTERIOR_MIN_ZOOM = 14;
/** The world map maximum is 18; interiors start slightly above it. */
export const INTERIOR_MAX_ZOOM = 19;
/** Pan clamp margin around the room, in local units. */
export const INTERIOR_CAMERA_BOUNDS_MARGIN_UNITS = 120;
