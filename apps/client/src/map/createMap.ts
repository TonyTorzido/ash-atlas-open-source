import maplibregl from "maplibre-gl";
import { isReducedRenderQualityEnabled } from "../perf/renderQualityFlag.js";
import { isPhoneRenderProfile } from "../perf/renderQuality.js";
import type { LatLon } from "@ash-atlas/shared";

import type { ClientConfig } from "../config.js";
import {
  syncGlobeSpaceBackground,
  WORLD_GLOBE_OCEAN
} from "./globeSpace.js";
import {
  DEFAULT_MAP_ZOOM,
  GAMEPLAY_MAP_DETAIL_FULL_ZOOM,
  GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  type MapZoomOptions
} from "./mapZoomConfig.js";
import { cameraZoomForGroundZoom, cameraZoomLimits } from "./groundScaleCamera.js";
import { worldCountries, worldLandOutlines } from "./worldMap.js";
import { isInteriorMapSpace } from "./interiorMapSpace.js";
import { installRasterAlignment } from "./rasterAlignment.js";
import { installMapTilesProtocol } from "./mapTilesProtocol.js";
import { installWorldOverlays } from "./worldOverlays.js";
import {
  WORLD_EDGE_FOG_LAYER,
  WORLD_EDGE_FOG_SOURCE,
  WORLD_EDGE_FOG_SOURCE_ID
} from "./worldEdgeFog.js";

/**
 * OSM tiles are only useful as local detail. Fade them in from the globe
 * transition floor so a partially loaded low-zoom tile cannot read as a hard
 * pale rectangle over the authored vector globe land.
 */
export const GAMEPLAY_OSM_RASTER_PAINT = {
  "raster-opacity": [
    "interpolate",
    ["linear"],
    ["zoom"],
    GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
    0,
    GAMEPLAY_MAP_DETAIL_FULL_ZOOM,
    0.58
  ] as ["interpolate", ["linear"], ["zoom"], number, number, number, number],
  "raster-fade-duration": 0
};

export {
  DEFAULT_MAP_ZOOM,
  GAMEPLAY_MAP_DETAIL_FULL_ZOOM,
  GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  MOBILE_DEFAULT_MAP_ZOOM,
  MOBILE_MAP_ZOOM_OPTIONS,
  MOBILE_MAX_MAP_ZOOM,
  MOBILE_MIN_MAP_ZOOM,
  gameplayMapDetailAlphaForZoom,
  type MapZoomOptions
} from "./mapZoomConfig.js";

export const GAME_MAP_INTERACTION_OPTIONS = {
  dragPan: true,
  dragRotate: false,
  pitchWithRotate: false,
  // MapLibre uses clickTolerance as the movement threshold before native
  // panning starts. Keep it independent from the custom map double-click
  // matcher so a 48px recognition radius cannot make drag feel delayed.
  clickTolerance: 3,
  scrollZoom: true,
  touchZoomRotate: true,
  touchPitch: false
} as const;

/**
 * Globe to Mercator blend by CAMERA zoom. Gameplay framing (ground zoom 15, camera 11.5 to 15) is pure Mercator at
 * every latitude, so the ground-zoom camera offset never lands inside the blend band. The globe stays at camera 4 to 8.
 */
export const GAMEPLAY_MAP_PROJECTION_TYPE = [
  "interpolate",
  ["linear"],
  ["zoom"],
  9,
  "vertical-perspective",
  10,
  "mercator"
] as const;

/**
 * Zoom options are GROUND zoom (equator-equivalent). MapLibre needs camera zoom, so convert at the initial latitude;
 * App re-applies the limits as the player changes latitude.
 */
export function cameraZoomOptionsForGroundZoomOptions(
  options: MapZoomOptions,
  latitudeDegrees: number
): MapZoomOptions {
  const limits = cameraZoomLimits(latitudeDegrees, options.minZoom, options.maxZoom);
  return {
    zoom: Math.min(limits.maxZoom, Math.max(limits.minZoom, cameraZoomForGroundZoom(options.zoom, latitudeDegrees))),
    minZoom: limits.minZoom,
    maxZoom: limits.maxZoom
  };
}

/**
 * High quality (the default) lets MapLibre render at the full device pixel ratio. Only the Low graphics setting caps a
 * phone-class device at 2x. Returns undefined (MapLibre's default, full DPR) otherwise.
 */
export function gameMapPixelRatio(
  devicePixelRatio: number = globalThis.devicePixelRatio || 1
): number | undefined {
  if (!isReducedRenderQualityEnabled() || !isPhoneRenderProfile()) return undefined;
  return Math.min(2, Math.max(1, devicePixelRatio));
}

export function createMap(
  container: HTMLElement,
  config: ClientConfig,
  zoomOptions: MapZoomOptions = {
    zoom: DEFAULT_MAP_ZOOM,
    minZoom: MIN_MAP_ZOOM,
    maxZoom: MAX_MAP_ZOOM
  },
  initialCenter?: LatLon
): maplibregl.Map {
  const pixelRatio = gameMapPixelRatio();
  const map = new maplibregl.Map({
    container,
    ...(pixelRatio === undefined ? {} : { pixelRatio }),
    ...(initialCenter
      ? { center: [initialCenter.lon, initialCenter.lat] as [number, number] }
      : {}),
    ...cameraZoomOptionsForGroundZoomOptions(zoomOptions, initialCenter?.lat ?? 0),
    ...GAME_MAP_INTERACTION_OPTIONS,
    renderWorldCopies: false,
    attributionControl: false,
    style: {
      version: 8,
      projection: { type: GAMEPLAY_MAP_PROJECTION_TYPE as unknown as NonNullable<maplibregl.ProjectionSpecification["type"]> },
      sources: {
        "game-map-globe-ocean": {
          type: "geojson",
          data: WORLD_GLOBE_OCEAN
        },
        "game-map-globe-countries": {
          type: "geojson",
          data: worldCountries
        },
        "game-map-globe-land-outlines": {
          type: "geojson",
          data: worldLandOutlines
        },
        osm: {
          type: "raster",
          tiles: [config.osmTileUrl],
          tileSize: 256
        },
        [WORLD_EDGE_FOG_SOURCE_ID]: WORLD_EDGE_FOG_SOURCE
      },
      layers: [
        {
          id: "game-map-background",
          type: "background",
          paint: { "background-color": "rgba(0, 0, 0, 0)" }
        },
        {
          id: "game-map-globe-ocean",
          type: "fill",
          source: "game-map-globe-ocean",
          paint: { "fill-color": "#9fc4d1" }
        },
        {
          id: "game-map-globe-land",
          type: "fill",
          source: "game-map-globe-countries",
          paint: { "fill-color": "#d8d0bb" }
        },
        {
          id: "game-map-globe-land-outline",
          type: "line",
          source: "game-map-globe-land-outlines",
          paint: { "line-color": "#817663", "line-width": 1 }
        },
        {
          id: "osm",
          type: "raster",
          source: "osm",
          minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
          paint: GAMEPLAY_OSM_RASTER_PAINT
        },
        // Above the globe land and OSM detail; world overlays insert below it.
        WORLD_EDGE_FOG_LAYER
      ]
    }
  });

  installRasterAlignment(map);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  map.doubleClickZoom.disable();
  map.touchZoomRotate.disableRotation();
  keepTapDragZoomDisabled(map);
  syncGlobeSpaceBackground(map);
  map.on("zoom", () => {
    // Interiors never show globe space; interiorMapSpace re-syncs on exit.
    if (!isInteriorMapSpace(map)) syncGlobeSpaceBackground(map);
  });
  map.on("load", () => {
    installMapTilesProtocol();
    installWorldOverlays(map, config.worldApiBase);
  });
  return map;
}

type TouchZoomRotateWithTapDrag = maplibregl.TwoFingersTouchZoomRotateHandler & {
  _tapDragZoom?: { disable(): void };
};

/**
 * A touch double-tap on the world moves the player, so MapLibre's one-finger
 * "double-tap and drag" zoom must never claim the second tap. It rides along with
 * pinch zoom, so every later `touchZoomRotate.enable()` switches it off again.
 */
export function keepTapDragZoomDisabled(map: maplibregl.Map): void {
  const touchZoomRotate = map.touchZoomRotate as TouchZoomRotateWithTapDrag | undefined;
  if (!touchZoomRotate?.enable) return;
  const enable = touchZoomRotate.enable.bind(touchZoomRotate);
  touchZoomRotate.enable = (options) => {
    enable(options);
    touchZoomRotate._tapDragZoom?.disable();
  };
  touchZoomRotate._tapDragZoom?.disable();
}
