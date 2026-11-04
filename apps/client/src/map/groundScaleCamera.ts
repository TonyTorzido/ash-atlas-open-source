import { MAX_MAP_ZOOM, MIN_MAP_ZOOM } from "./mapZoomConfig.js";
import {
  clampMapLatitude,
  groundScaleZoomOffset
} from "./groundScaleZoom.js";

/**
 * Ground-zoom camera. Every zoom the game reasons about (defaults, preferences, limits, thresholds, indicator)
 * is a GROUND zoom: the equator-equivalent zoom at which a metre has the same pixel size at every latitude.
 * The MapLibre camera zoom is `groundZoom - log2(1 / cos(lat))`, so a 500 m circle, a player and a mob look the
 * same size anywhere. Only values handed to or read from MapLibre are camera zooms; convert at that boundary.
 */

/** MapLibre's lowest legal zoom. */
export const MAPLIBRE_MIN_ZOOM = -2;
/**
 * Lowest camera zoom the gameplay map allows at any latitude. Below ~0.6 a 512 px world is smaller than the viewport
 * and MapLibre re-centres it on the equator, throwing a polar player off screen; 2 is also the camera floor the
 * game had before the ground-zoom camera.
 */
export const CAMERA_ZOOM_FLOOR = 2;
/** Camera zoom drift smaller than this is not worth correcting. */
export const GROUND_ZOOM_DRIFT_EPSILON = 0.01;

/** Zoom levels the Mercator camera sits below the ground zoom at this latitude (0 at the equator). Latitude clamped to +-85. */
export function cameraZoomOffsetForLatitude(latitudeDegrees: number): number {
  return groundScaleZoomOffset(clampMapLatitude(latitudeDegrees));
}

/** Camera zoom that shows `groundZoom` at this latitude. NaN passes through. */
export function cameraZoomForGroundZoom(groundZoom: number, latitudeDegrees: number): number {
  if (!Number.isFinite(groundZoom)) return groundZoom;
  return groundZoom - cameraZoomOffsetForLatitude(latitudeDegrees);
}

/** Inverse of {@link cameraZoomForGroundZoom}. NaN passes through. */
export function groundZoomForCameraZoom(cameraZoom: number, latitudeDegrees: number): number {
  if (!Number.isFinite(cameraZoom)) return cameraZoom;
  return cameraZoom + cameraZoomOffsetForLatitude(latitudeDegrees);
}

export type CameraZoomLimits = Readonly<{ minZoom: number; maxZoom: number }>;

/** Camera min/max zoom that enforce the ground limits at this latitude. */
export function cameraZoomLimits(
  latitudeDegrees: number,
  groundMin: number = MIN_MAP_ZOOM,
  groundMax: number = MAX_MAP_ZOOM
): CameraZoomLimits {
  const minZoom = Math.max(CAMERA_ZOOM_FLOOR, cameraZoomForGroundZoom(groundMin, latitudeDegrees));
  const maxZoom = Math.max(minZoom, cameraZoomForGroundZoom(groundMax, latitudeDegrees));
  return { minZoom, maxZoom };
}

type ZoomLimitMap = {
  getCenter(): { lat: number };
  getZoom(): number;
  getMinZoom(): number;
  getMaxZoom(): number;
  setMinZoom(zoom: number): unknown;
  setMaxZoom(zoom: number): unknown;
};

/**
 * Re-applies the ground limits for a latitude (default: the map's current centre) when they drifted by more than
 * the epsilon. Returns true when it changed anything.
 */
export function applyCameraZoomLimits(
  map: ZoomLimitMap,
  latitudeDegrees: number = map.getCenter().lat,
  groundMin: number = MIN_MAP_ZOOM,
  groundMax: number = MAX_MAP_ZOOM
): boolean {
  const limits = cameraZoomLimits(latitudeDegrees, groundMin, groundMax);
  let changed = false;
  if (Math.abs(map.getMinZoom() - limits.minZoom) > GROUND_ZOOM_DRIFT_EPSILON) {
    map.setMinZoom(limits.minZoom);
    changed = true;
  }
  if (Math.abs(map.getMaxZoom() - limits.maxZoom) > GROUND_ZOOM_DRIFT_EPSILON) {
    map.setMaxZoom(limits.maxZoom);
    changed = true;
  }
  return changed;
}

/**
 * Widens the camera limits to also admit the limits at `targetLatitude`, so a move between latitudes is never
 * clamped by the departure latitude's limits. The next moveend applies the exact limits again.
 */
export function widenCameraZoomLimits(
  map: ZoomLimitMap,
  targetLatitudeDegrees: number,
  groundMin: number = MIN_MAP_ZOOM,
  groundMax: number = MAX_MAP_ZOOM
): void {
  const target = cameraZoomLimits(targetLatitudeDegrees, groundMin, groundMax);
  if (target.minZoom < map.getMinZoom() - GROUND_ZOOM_DRIFT_EPSILON) map.setMinZoom(target.minZoom);
  if (target.maxZoom > map.getMaxZoom() + GROUND_ZOOM_DRIFT_EPSILON) map.setMaxZoom(target.maxZoom);
}

/**
 * Camera zoom for a programmatic move to `targetLatitudeDegrees` that shows `groundZoom` there (default: the ground
 * zoom the map shows now). Widens the limits first; hand the result to jumpTo/easeTo/flyTo.
 */
export function cameraZoomForMove(
  map: ZoomLimitMap,
  targetLatitudeDegrees: number,
  groundZoom?: number
): number {
  widenCameraZoomLimits(map, targetLatitudeDegrees);
  const ground = groundZoom !== undefined && Number.isFinite(groundZoom)
    ? groundZoom
    : groundZoomForCameraZoom(map.getZoom(), map.getCenter().lat);
  return cameraZoomForGroundZoom(ground, targetLatitudeDegrees);
}

/** Idle drift correction runs at most this often. */
export const GROUND_ZOOM_CORRECTION_INTERVAL_MS = 1000;

/**
 * Camera zoom that keeps the user's desired GROUND zoom at `latitudeDegrees`, or undefined when there is no desired
 * zoom or the camera is already within the epsilon of it, or of the limit it clamps to (so a programmatic move leaves
 * the zoom untouched).
 */
export function holdGroundZoomCameraZoom(args: Readonly<{
  desiredGroundZoom: number | null;
  latitudeDegrees: number;
  currentCameraZoom: number;
}>): number | undefined {
  const { desiredGroundZoom, latitudeDegrees, currentCameraZoom } = args;
  if (desiredGroundZoom === null || !Number.isFinite(desiredGroundZoom) || !Number.isFinite(latitudeDegrees)) return undefined;
  const target = cameraZoomForGroundZoom(desiredGroundZoom, latitudeDegrees);
  // Compare against the zoom MapLibre can actually reach here: a desired zoom below the polar camera floor would
  // otherwise "correct" to the same clamped zoom every second forever.
  const limits = cameraZoomLimits(latitudeDegrees);
  const reachable = Math.min(limits.maxZoom, Math.max(limits.minZoom, target));
  if (Number.isFinite(currentCameraZoom) && Math.abs(reachable - currentCameraZoom) <= GROUND_ZOOM_DRIFT_EPSILON) return undefined;
  return target;
}

/**
 * Idle drift correction: the camera zoom to jump to, or undefined when a correction must not run now. Never runs
 * while a user gesture or a programmatic camera move owns the camera, and at most once per interval.
 */
export function idleGroundZoomCorrection(args: Readonly<{
  desiredGroundZoom: number | null;
  latitudeDegrees: number;
  currentCameraZoom: number;
  nowMs: number;
  lastCorrectionMs: number;
  gestureActive: boolean;
  programmaticMoveActive: boolean;
}>): number | undefined {
  if (args.gestureActive || args.programmaticMoveActive) return undefined;
  if (args.nowMs - args.lastCorrectionMs < GROUND_ZOOM_CORRECTION_INTERVAL_MS) return undefined;
  return holdGroundZoomCameraZoom(args);
}
