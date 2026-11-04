import {
  WORLD_MAP_MAX_ZOOM,
  WORLD_MAP_MIN_ZOOM,
  WORLD_MAP_SINGLE_DESTINATION_ZOOM
} from "@ash-atlas/shared";

import {
  DEFAULT_MAP_ZOOM,
  GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
  MIN_MAP_ZOOM
} from "./mapZoomConfig.js";
import {
  cubicEaseInOut,
  RECENTER_CAMERA_DURATION_MS,
  RECENTER_CAMERA_TIMEOUT_MS
} from "./flagTravelCamera.js";

export type GlobeCameraCenter = Readonly<{ lat: number; lon: number }>;

export type GlobeCameraViewport = Readonly<{
  width: number;
  height: number;
  padding?: Readonly<{
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  }>;
}>;

export type GlobeCameraFrame = Readonly<{
  zoom: number;
  latitude: number;
  viewport: GlobeCameraViewport;
}>;

/**
 * Reads the shared absolute MapLibre globe zoom domain. MapLibre zoom is an
 * absolute camera value, so do not subtract either map's configured floor.
 */
export function worldMapGlobeZoomForGameplayZoom(zoom: number): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : MIN_MAP_ZOOM;
  return clamp(
    safeZoom,
    WORLD_MAP_MIN_ZOOM,
    WORLD_MAP_MAX_ZOOM
  );
}

export function gameplayZoomForWorldMapGlobeZoom(zoom: number): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : WORLD_MAP_MIN_ZOOM;
  return clamp(
    safeZoom,
    MIN_MAP_ZOOM,
    WORLD_MAP_MAX_ZOOM
  );
}

/**
 * Returns the shorter usable viewport edge in CSS pixels. The globe's
 * projected diameter is governed by this edge, after map padding is removed.
 */
export function globeCameraViewportDimension(
  viewport: GlobeCameraViewport
): number {
  const padding = viewport.padding;
  const viewportWidth = Number.isFinite(viewport.width) ? viewport.width : 1;
  const viewportHeight = Number.isFinite(viewport.height) ? viewport.height : 1;
  const width = Math.max(
    1,
    viewportWidth - safePadding(padding?.left) - safePadding(padding?.right)
  );
  const height = Math.max(
    1,
    viewportHeight - safePadding(padding?.top) - safePadding(padding?.bottom)
  );
  return Math.min(width, height);
}

/**
 * Computes the normalized globe framing scalar used to compare map canvases
 * with different usable dimensions or center latitudes.
 */
export function globeCameraFramingScalar(frame: GlobeCameraFrame): number {
  const safeZoom = Number.isFinite(frame.zoom) ? frame.zoom : WORLD_MAP_MIN_ZOOM;
  const latitudeRadians = safeLatitudeRadians(frame.latitude);
  const cosineLatitude = Math.max(0.01, Math.cos(latitudeRadians));
  return 2 ** safeZoom /
    (cosineLatitude * globeCameraViewportDimension(frame.viewport));
}

/**
 * Maps a source globe zoom to the equivalent target viewport/latitude while
 * preserving the normalized framing scalar. MapLibre zoom remains absolute;
 * this only compensates for canvas geometry when the two map shells differ.
 */
export function globeZoomForEquivalentFraming(input: Readonly<{
  source: GlobeCameraFrame;
  targetLatitude: number;
  targetViewport: GlobeCameraViewport;
}>): number {
  const sourceLatitudeRadians = safeLatitudeRadians(input.source.latitude);
  const targetLatitudeRadians = safeLatitudeRadians(input.targetLatitude);
  const sourceCosine = Math.max(0.01, Math.cos(sourceLatitudeRadians));
  const targetCosine = Math.max(0.01, Math.cos(targetLatitudeRadians));
  const sourceDimension = globeCameraViewportDimension(input.source.viewport);
  const targetDimension = globeCameraViewportDimension(input.targetViewport);
  const safeZoom = Number.isFinite(input.source.zoom)
    ? input.source.zoom
    : WORLD_MAP_MIN_ZOOM;
  return safeZoom + Math.log2(
    (targetCosine * targetDimension) / (sourceCosine * sourceDimension)
  );
}

/**
 * The regular map returns to local detail when it is in the globe band. Input and result are GROUND zoom; the
 * caller converts the result to camera zoom for the latitude it flies to.
 */
export function gameplayMapRecenterTargetZoom(currentGroundZoom: number): number | undefined {
  return !Number.isFinite(currentGroundZoom) || currentGroundZoom <= GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM
    ? DEFAULT_MAP_ZOOM
    : undefined;
}

/** The standalone map preserves its established approximate-area framing. */
export function worldMapRecenterTargetZoom(currentZoom: number): number {
  const safeZoom = Number.isFinite(currentZoom)
    ? currentZoom
    : WORLD_MAP_MIN_ZOOM;
  return Math.max(safeZoom, WORLD_MAP_SINGLE_DESTINATION_ZOOM);
}

export const GAMEPLAY_RECENTER_CAMERA_MIN_DURATION_MS = 220;
export const GAMEPLAY_RECENTER_CAMERA_MAX_DURATION_MS = 1_200;
export const GAMEPLAY_RECENTER_CAMERA_MAX_VIEWPORT_DISTANCE = 1.5;
export const GAMEPLAY_RECENTER_CAMERA_ZOOM_DURATION_MS_PER_LEVEL = 80;
export const GAMEPLAY_RECENTER_CAMERA_TIMEOUT_PADDING_MS = 220;
export const GAMEPLAY_GLOBE_RECENTER_MAX_DURATION_MS = 3_600;

/**
 * Plans the regular gameplay map's native camera move. The zoom component
 * keeps globe-to-local moves readable even when the player is already nearby,
 * while the viewport component keeps distant local moves from feeling abrupt.
 */
export function planGameplayMapRecenter(input: Readonly<{
  center: GlobeCameraCenter;
  currentZoom: number;
  targetZoom: number | undefined;
  viewportDistance: number;
  reducedMotion: boolean;
}>): GlobeMapRecenterPlan {
  if (input.reducedMotion) {
    return {
      center: [input.center.lon, input.center.lat],
      zoom: input.targetZoom,
      durationMs: 0,
      timeoutMs: 0,
      easing: cubicEaseInOut
    };
  }

  const currentZoom = Number.isFinite(input.currentZoom)
    ? input.currentZoom
    : MIN_MAP_ZOOM;
  const targetZoom = input.targetZoom !== undefined &&
      Number.isFinite(input.targetZoom)
    ? input.targetZoom
    : currentZoom;
  const zoomDistance = Math.abs(targetZoom - currentZoom);
  const viewportDistance = Number.isFinite(input.viewportDistance)
    ? Math.max(0, input.viewportDistance)
    : GAMEPLAY_RECENTER_CAMERA_MAX_VIEWPORT_DISTANCE;
  const distanceProgress = Math.min(
    1,
    viewportDistance / GAMEPLAY_RECENTER_CAMERA_MAX_VIEWPORT_DISTANCE
  );
  const distanceDuration = Math.round(
    (GAMEPLAY_RECENTER_CAMERA_MAX_DURATION_MS -
      GAMEPLAY_RECENTER_CAMERA_MIN_DURATION_MS) * distanceProgress
  );
  const zoomDuration = Math.round(
    zoomDistance * GAMEPLAY_RECENTER_CAMERA_ZOOM_DURATION_MS_PER_LEVEL
  );
  const localDurationMs = Math.min(
    GAMEPLAY_RECENTER_CAMERA_MAX_DURATION_MS,
    GAMEPLAY_RECENTER_CAMERA_MIN_DURATION_MS +
      Math.max(distanceDuration, zoomDuration)
  );
  // Preserve nearby recenter timing; spend more time traversing many zoom
  // levels so global-to-local detail does not arrive in one abrupt burst.
  const durationMs = zoomDistance > 3
    ? Math.min(GAMEPLAY_GLOBE_RECENTER_MAX_DURATION_MS,
        Math.max(localDurationMs, 900 + Math.round(zoomDistance * 220)))
    : localDurationMs;
  return {
    center: [input.center.lon, input.center.lat],
    zoom: input.targetZoom,
    durationMs,
    timeoutMs: durationMs + GAMEPLAY_RECENTER_CAMERA_TIMEOUT_PADDING_MS,
    easing: cubicEaseInOut
  };
}

export type GlobeMapRecenterPlan = Readonly<{
  center: [number, number];
  zoom: number | undefined;
  durationMs: number;
  timeoutMs: number;
  easing: (progress: number) => number;
}>;

/**
 * Plans the same cancellable, cubic camera transition for both globe paths.
 * MapLibre keeps the native globe projection active throughout this move, so
 * the zoom and center evolve continuously instead of crossing a projection
 * state boundary in separate jumps.
 */
export function planGlobeMapRecenter(input: Readonly<{
  center: GlobeCameraCenter;
  targetZoom: number | undefined;
  currentZoom?: number;
  reducedMotion: boolean;
}>): GlobeMapRecenterPlan {
  if (input.currentZoom !== undefined && input.targetZoom !== undefined &&
      Math.abs(input.targetZoom - input.currentZoom) > 3) {
    return planGameplayMapRecenter({ ...input, currentZoom: input.currentZoom, viewportDistance: 0 });
  }
  return {
    center: [input.center.lon, input.center.lat],
    zoom: input.targetZoom,
    durationMs: input.reducedMotion ? 0 : RECENTER_CAMERA_DURATION_MS,
    timeoutMs: input.reducedMotion ? 0 : RECENTER_CAMERA_TIMEOUT_MS,
    easing: cubicEaseInOut
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function safeLatitudeRadians(latitude: number): number {
  return (Number.isFinite(latitude) ? clamp(latitude, -90, 90) : 0) * Math.PI / 180;
}

function safePadding(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0;
}
