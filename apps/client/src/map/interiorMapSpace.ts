import {
  INTERIOR_CAMERA_BOUNDS_MARGIN_UNITS,
  INTERIOR_DEFAULT_ZOOM,
  INTERIOR_MAX_ZOOM,
  INTERIOR_MIN_ZOOM,
  interiorLocalToLngLat,
  type IndoorPoint,
  type LatLon
} from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";

import { syncGlobeSpaceBackground, GLOBE_SPACE_BACKGROUND_CLASS } from "./globeSpace.js";

/**
 * Map space mode. Interiors are drawn by the same MapLibre map around
 * lat/lon (0, 0): entering one hides every world style layer by visibility
 * (never setStyle), shows a plain interior background, pauses the globe
 * background sync, and clamps the camera centre to the room. Leaving restores the
 * world layers, zoom range and the saved world camera.
 */

export const INTERIOR_BACKGROUND_LAYER_ID = "interior-space-background";
export const INTERIOR_BACKGROUND_COLOR = "#0b0a09";

export type SavedWorldCamera = Readonly<{
  center: LatLon;
  zoom: number;
  bearing: number;
  pitch: number;
  minZoom: number;
  maxZoom: number;
}>;

export type InteriorRoomFrame = Readonly<{
  roomWidth: number;
  roomHeight: number;
  metersPerUnit: number;
}>;

export type InteriorSpaceOptions = InteriorRoomFrame & Readonly<{
  spaceKey: string;
  /** Local point the camera starts on (normally the player). */
  focus: IndoorPoint;
  background?: string;
}>;

type InteriorMapSpaceMap = Pick<
  maplibregl.Map,
  | "getStyle"
  | "getLayer"
  | "addLayer"
  | "getLayoutProperty"
  | "setLayoutProperty"
  | "setPaintProperty"
  | "on"
  | "off"
  | "getCenter"
  | "getZoom"
  | "getBearing"
  | "getPitch"
  | "getMinZoom"
  | "getMaxZoom"
  | "setMinZoom"
  | "setMaxZoom"
  | "setMaxBounds"
  | "jumpTo"
  | "easeTo"
  | "stop"
  | "getContainer"
>;

type Visibility = "visible" | "none";

type ActiveInteriorSpace = {
  spaceKey: string;
  savedWorldCamera: SavedWorldCamera;
  hiddenLayerVisibility: Map<string, Visibility>;
  hideWorldLayers(): void;
  ensureBackground(): void;
  frame: InteriorRoomFrame & Readonly<{ background?: string }>;
  clampCamera(): void;
  /** Extra room units the camera centre may stray past the room edge (puzzle rooms frame the room off-centre). */
  slackUnits: number;
};

const activeSpaces = new WeakMap<object, ActiveInteriorSpace>();

export function isInteriorMapSpace(map: object): boolean {
  return activeSpaces.has(map);
}

export function interiorMapSpaceKey(map: object): string | null {
  return activeSpaces.get(map)?.spaceKey ?? null;
}

/** Pan clamp for a room: the room plus a small margin, as [[west, south], [east, north]]. */
export function interiorCameraBounds(
  frame: InteriorRoomFrame,
  marginUnits = INTERIOR_CAMERA_BOUNDS_MARGIN_UNITS
): [[number, number], [number, number]] {
  const northWest = interiorLocalToLngLat({ x: -marginUnits, y: -marginUnits }, frame.metersPerUnit);
  const southEast = interiorLocalToLngLat(
    { x: frame.roomWidth + marginUnits, y: frame.roomHeight + marginUnits },
    frame.metersPerUnit
  );
  return [[northWest.lon, southEast.lat], [southEast.lon, northWest.lat]];
}

export type InteriorViewport = Readonly<{ widthPx: number; heightPx: number; zoom: number }>;

/** Screen pixels per degree of longitude (and of latitude near the equator) at a zoom. */
function pixelsPerDegree(zoom: number): number {
  return 512 * 2 ** zoom / 360;
}

/** A camera centre closer than this to its clamped position is left alone. */
export const INTERIOR_CLAMP_TOLERANCE_PX = 1;

/** Fraction of the viewport kept as padding on each side of the room when fitting it. */
export const INTERIOR_FIT_PADDING = 0.1;
/** Fit never zooms in past this, so a dungeon always opens clearly zoomed out. */
export const INTERIOR_FIT_MAX_ZOOM = INTERIOR_DEFAULT_ZOOM - 0.75;
/** Fit never zooms out past this, so sprites stay legible in very large rooms. */
export const INTERIOR_FIT_MIN_ZOOM = Math.max(INTERIOR_MIN_ZOOM, INTERIOR_DEFAULT_ZOOM - 2.5);

/**
 * Zoom that fits the whole room inside the viewport with padding, capped to
 * [INTERIOR_FIT_MIN_ZOOM, INTERIOR_FIT_MAX_ZOOM]. Falls back to the default
 * zoom when the viewport size is unknown.
 */
export function interiorFitZoom(
  frame: InteriorRoomFrame,
  viewport: Readonly<{ widthPx: number; heightPx: number }> | null
): number {
  if (!viewport || !(viewport.widthPx > 0) || !(viewport.heightPx > 0)) return INTERIOR_DEFAULT_ZOOM;
  const southEast = interiorLocalToLngLat({ x: frame.roomWidth, y: frame.roomHeight }, frame.metersPerUnit);
  const lonSpan = Math.abs(southEast.lon);
  const latSpan = Math.abs(southEast.lat);
  const usable = 1 - 2 * INTERIOR_FIT_PADDING;
  const fits: number[] = [];
  if (lonSpan > 0) fits.push(Math.log2(viewport.widthPx * usable / (lonSpan * pixelsPerDegree(0))));
  if (latSpan > 0) fits.push(Math.log2(viewport.heightPx * usable / (latSpan * pixelsPerDegree(0))));
  if (fits.length === 0) return INTERIOR_DEFAULT_ZOOM;
  return Math.min(INTERIOR_FIT_MAX_ZOOM, Math.max(INTERIOR_FIT_MIN_ZOOM, Math.min(...fits)));
}

/**
 * Clamps a camera centre to the room. Unlike MapLibre maxBounds, this never
 * limits the zoom-out range or the zoom anchor.
 *
 * Free pan, like the overworld: the centre may sit anywhere over the room, so a
 * player can pan to a side and stay there. Only a centre dragged past a room
 * edge is pulled back, to that edge (never to the middle). Re-centring a room
 * smaller than the view fought every cursor-anchored wheel/pinch step and
 * snapped side pans back to the middle.
 *
 * The viewport argument is accepted for callers that pass it; the clamp is the
 * room itself. A number is a margin in room units around the room.
 */
export function clampInteriorCameraCenter(
  frame: InteriorRoomFrame,
  center: LatLon,
  viewportOrMargin: InteriorViewport | number | null = INTERIOR_CAMERA_BOUNDS_MARGIN_UNITS
): LatLon {
  const marginUnits = typeof viewportOrMargin === "number" ? viewportOrMargin : viewportOrMargin === null ? INTERIOR_CAMERA_BOUNDS_MARGIN_UNITS : 0;
  const [[west, south], [east, north]] = interiorCameraBounds(frame, marginUnits);
  return {
    lat: Math.min(north, Math.max(south, center.lat)),
    lon: Math.min(east, Math.max(west, center.lon))
  };
}

function containerSize(map: InteriorMapSpaceMap): { widthPx: number; heightPx: number } {
  const container = map.getContainer() as { clientWidth?: number; clientHeight?: number };
  return { widthPx: container.clientWidth ?? 0, heightPx: container.clientHeight ?? 0 };
}

function mapViewport(map: InteriorMapSpaceMap): InteriorViewport | null {
  const size = containerSize(map);
  if (!(size.widthPx > 0) || !(size.heightPx > 0)) return null;
  return { ...size, zoom: map.getZoom() };
}

function styleLayerIds(map: InteriorMapSpaceMap): string[] {
  try {
    return (map.getStyle()?.layers ?? []).map((layer) => layer.id);
  } catch {
    return [];
  }
}

function layerVisibility(map: InteriorMapSpaceMap, layerId: string): Visibility {
  return map.getLayoutProperty(layerId, "visibility") === "none" ? "none" : "visible";
}

/**
 * Enters (or re-targets) interior space. Returns the saved world camera. A
 * repeated call for the same space only keeps the camera clamp current; a new
 * space key re-centres the camera at the interior default zoom.
 */
export function enterInteriorSpace(
  map: InteriorMapSpaceMap,
  options: InteriorSpaceOptions
): SavedWorldCamera {
  let active = activeSpaces.get(map);
  const spaceChanged = active?.spaceKey !== options.spaceKey;
  // Room to room keeps the current zoom; every fresh entry from the world
  // fits the room in view (never the last indoor zoom).
  const enteringFromWorld = active === undefined;
  if (!active) {
    const center = map.getCenter();
    const hiddenLayerVisibility = new Map<string, Visibility>();
    // The style may still be loading (a reconnect that lands indoors), so the
    // layer is retried on every styledata until it exists.
    const ensureBackground = (): void => {
      const background = activeSpaces.get(map)?.frame.background ?? INTERIOR_BACKGROUND_COLOR;
      if (map.getLayer(INTERIOR_BACKGROUND_LAYER_ID)) {
        map.setLayoutProperty(INTERIOR_BACKGROUND_LAYER_ID, "visibility", "visible");
        map.setPaintProperty(INTERIOR_BACKGROUND_LAYER_ID, "background-color", background);
        return;
      }
      try {
        map.addLayer({
          id: INTERIOR_BACKGROUND_LAYER_ID,
          type: "background",
          paint: { "background-color": background }
        });
      } catch {
        // The style is not loaded yet; the next styledata retries.
      }
    };
    const hideWorldLayers = (): void => {
      ensureBackground();
      for (const layerId of styleLayerIds(map)) {
        if (layerId === INTERIOR_BACKGROUND_LAYER_ID) continue;
        const visibility = layerVisibility(map, layerId);
        // A layer made visible by world code while indoors records that as
        // its world visibility, then stays hidden until the world returns.
        if (visibility === "none" && hiddenLayerVisibility.has(layerId)) continue;
        hiddenLayerVisibility.set(layerId, visibility);
        if (visibility !== "none") map.setLayoutProperty(layerId, "visibility", "none");
      }
    };
    // Rubber-band the centre back into the room after a gesture or ease ends.
    // Applied on moveend only, so nothing fights the gesture in progress.
    const clampCamera = (): void => {
      const current = activeSpaces.get(map);
      if (!current) return;
      const here = map.getCenter();
      const clamped = current.slackUnits > 0
        ? clampInteriorCameraCenter(current.frame, { lat: here.lat, lon: here.lng }, INTERIOR_CAMERA_BOUNDS_MARGIN_UNITS + current.slackUnits)
        : clampInteriorCameraCenter(current.frame, { lat: here.lat, lon: here.lng }, mapViewport(map));
      // Compare in screen pixels: MapLibre's centre carries float noise far above any degree-sized
      // tolerance, and an ease that never "arrives" re-fires moveend, cancelling every wheel and pinch
      // step (zoomed fully out, where the whole room is centred, that froze zoom in both directions).
      const perDegree = pixelsPerDegree(map.getZoom());
      const offPx = Math.max(Math.abs(clamped.lat - here.lat), Math.abs(clamped.lon - here.lng)) * perDegree;
      if (offPx < INTERIOR_CLAMP_TOLERANCE_PX) return;
      map.easeTo({ center: [clamped.lon, clamped.lat], duration: 220 });
    };
    active = {
      frame: options,
      clampCamera,
      slackUnits: 0,
      spaceKey: options.spaceKey,
      savedWorldCamera: {
        center: { lat: center.lat, lon: center.lng },
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
        minZoom: map.getMinZoom(),
        maxZoom: map.getMaxZoom()
      },
      hiddenLayerVisibility,
      hideWorldLayers,
      ensureBackground
    };
    activeSpaces.set(map, active);
    map.on("styledata", hideWorldLayers);
    map.on("moveend", clampCamera);
    map.getContainer().classList.remove(GLOBE_SPACE_BACKGROUND_CLASS);
  }
  active.spaceKey = options.spaceKey;
  active.frame = options;
  active.hideWorldLayers();
  active.ensureBackground();
  if (spaceChanged) {
    active.slackUnits = 0;
    map.stop();
    map.setMaxBounds(null);
    map.setMinZoom(INTERIOR_MIN_ZOOM);
    map.setMaxZoom(INTERIOR_MAX_ZOOM);
    const focus = interiorLocalToLngLat(options.focus, options.metersPerUnit);
    const size = containerSize(map);
    const zoom = enteringFromWorld ? interiorFitZoom(options, size) : map.getZoom();
    const start = clampInteriorCameraCenter(
      options,
      { lat: focus.lat, lon: focus.lon },
      size.widthPx > 0 && size.heightPx > 0 ? { ...size, zoom } : null
    );
    map.jumpTo({ center: [start.lon, start.lat], zoom, bearing: 0, pitch: 0 });
  }
  if (!spaceChanged) active.clampCamera();
  return active.savedWorldCamera;
}

/**
 * Lets the camera centre stray `units` past the room edge in the current interior space (0 restores the normal
 * clamp). A puzzle room sets it while it frames the whole room beside the HUD; a new space resets it.
 */
export function setInteriorCameraSlack(map: object, units: number): void {
  const active = activeSpaces.get(map);
  if (active) active.slackUnits = Math.max(0, Number.isFinite(units) ? units : 0);
}

/** Leaves interior space and restores the saved world camera. */
export function enterWorldSpace(map: InteriorMapSpaceMap): SavedWorldCamera | null {
  const active = activeSpaces.get(map);
  if (!active) return null;
  activeSpaces.delete(map);
  map.off("styledata", active.hideWorldLayers);
  map.off("moveend", active.clampCamera);
  map.stop();
  map.setMaxBounds(null);
  const saved = active.savedWorldCamera;
  map.setMinZoom(saved.minZoom);
  map.setMaxZoom(saved.maxZoom);
  map.jumpTo({
    center: [saved.center.lon, saved.center.lat],
    zoom: saved.zoom,
    bearing: saved.bearing,
    pitch: saved.pitch
  });
  if (map.getLayer(INTERIOR_BACKGROUND_LAYER_ID)) {
    map.setLayoutProperty(INTERIOR_BACKGROUND_LAYER_ID, "visibility", "none");
  }
  const currentLayers = new Set(styleLayerIds(map));
  for (const [layerId, visibility] of active.hiddenLayerVisibility) {
    if (currentLayers.has(layerId) && visibility !== "none") {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
  }
  syncGlobeSpaceBackground(map);
  return saved;
}
