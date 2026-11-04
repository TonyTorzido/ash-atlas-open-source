import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAP_ZOOM,
  GAMEPLAY_OSM_RASTER_PAINT,
  GAMEPLAY_MAP_DETAIL_FULL_ZOOM,
  GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
  gameMapPixelRatio,
  gameplayMapDetailAlphaForZoom,
  keepTapDragZoomDisabled,
  GAME_MAP_INTERACTION_OPTIONS,
  GAMEPLAY_MAP_PROJECTION_TYPE,
  cameraZoomOptionsForGroundZoomOptions,
  MAX_MAP_ZOOM,
  MOBILE_DEFAULT_MAP_ZOOM,
  MOBILE_MAX_MAP_ZOOM,
  MOBILE_MIN_MAP_ZOOM,
  MIN_MAP_ZOOM
} from "./createMap.js";
import { setReducedRenderQualityEnabled } from "../perf/renderQualityFlag.js";
import { WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX } from "../movement/worldMapClickArbitrator.js";

const source = readFileSync(
  fileURLToPath(new URL("./createMap.ts", import.meta.url)),
  "utf8"
);

describe("map zoom limits", () => {
  it("uses the requested desktop zoom range with native map behavior", () => {
    expect(DEFAULT_MAP_ZOOM).toBe(15);
    expect(MIN_MAP_ZOOM).toBe(2);
    expect(MAX_MAP_ZOOM).toBe(18);
  });

  it("converts ground zoom options to camera zoom at the initial latitude", () => {
    const ground = { zoom: 15, minZoom: 2, maxZoom: 18 };
    expect(cameraZoomOptionsForGroundZoomOptions(ground, 0)).toEqual(ground);
    const abq = cameraZoomOptionsForGroundZoomOptions(ground, 35.08);
    expect(15 - abq.zoom).toBeLessThan(0.3);
    expect(abq.maxZoom).toBeCloseTo(abq.zoom + 3, 10);
    const polar = cameraZoomOptionsForGroundZoomOptions(ground, 85);
    expect(polar.zoom).toBeCloseTo(11.48, 1);
    expect(polar.minZoom).toBeGreaterThanOrEqual(-2);
  });

  it("uses the tuned zoom range for mobile gameplay", () => {
    expect(MOBILE_DEFAULT_MAP_ZOOM).toBe(15);
    expect(MOBILE_MIN_MAP_ZOOM).toBe(MIN_MAP_ZOOM);
    expect(MOBILE_MAX_MAP_ZOOM).toBe(18);
  });

  it("fades gameplay detail into the reachable global view", () => {
    expect(GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM).toBe(MIN_MAP_ZOOM + 2);
    expect(GAMEPLAY_MAP_DETAIL_FULL_ZOOM).toBe(MIN_MAP_ZOOM + 6);
    expect(gameplayMapDetailAlphaForZoom(MIN_MAP_ZOOM)).toBe(0);
    expect(gameplayMapDetailAlphaForZoom(GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM)).toBe(0);
    expect(gameplayMapDetailAlphaForZoom(
      (GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM + GAMEPLAY_MAP_DETAIL_FULL_ZOOM) / 2
    )).toBeCloseTo(0.5);
    expect(gameplayMapDetailAlphaForZoom(GAMEPLAY_MAP_DETAIL_FULL_ZOOM)).toBe(1);
  });

  it("uses native globe projection with a transparent outside-sphere background", () => {
    expect(source).toContain("projection: { type: GAMEPLAY_MAP_PROJECTION_TYPE");
    expect(GAMEPLAY_MAP_PROJECTION_TYPE).toEqual([
      "interpolate", ["linear"], ["zoom"], 9, "vertical-perspective", 10, "mercator"
    ]);
    expect(source).toContain('id: "game-map-background"');
    expect(source).toContain('"background-color": "rgba(0, 0, 0, 0)"');
    expect(source).toContain('id: "game-map-globe-ocean"');
    expect(source).toContain('id: "game-map-globe-land"');
    expect(source).toContain('source: "game-map-globe-countries"');
    expect(source).toContain("WORLD_GLOBE_OCEAN");
    expect(source).toContain("syncGlobeSpaceBackground");
    expect(source).toContain("renderWorldCopies: false");
  });

  it("uses the vector globe base before raster tiles take over", () => {
    expect(source).toContain('source: "game-map-globe-ocean"');
    expect(source).toContain("minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM");
    expect(source).toContain("paint: GAMEPLAY_OSM_RASTER_PAINT");
    expect(GAMEPLAY_OSM_RASTER_PAINT["raster-opacity"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
      0,
      GAMEPLAY_MAP_DETAIL_FULL_ZOOM,
      0.58
    ]);
    expect(GAMEPLAY_OSM_RASTER_PAINT["raster-fade-duration"]).toBe(0);
  });

  it("allows native pan and zoom while keeping 3D rotation disabled", () => {
    expect(GAME_MAP_INTERACTION_OPTIONS).toEqual({
      dragPan: true,
      dragRotate: false,
      pitchWithRotate: false,
      clickTolerance: 3,
      scrollZoom: true,
      touchZoomRotate: true,
      touchPitch: false
    });
    expect(WORLD_MAP_DOUBLE_CLICK_TOLERANCE_PX).toBe(48);
    expect(GAME_MAP_INTERACTION_OPTIONS.clickTolerance).toBe(3);
  });

  it("keeps one-finger double-tap drag zoom off so a double-tap moves the player", () => {
    const tapDragZoom = { disable: vi.fn() };
    const baseEnable = vi.fn();
    const touchZoomRotate = { enable: baseEnable, _tapDragZoom: tapDragZoom };
    keepTapDragZoomDisabled({ touchZoomRotate } as never);
    expect(tapDragZoom.disable).toHaveBeenCalledTimes(1);

    // Restoring pinch zoom after a hold must not bring the drag zoom back.
    touchZoomRotate.enable();
    expect(baseEnable).toHaveBeenCalledTimes(1);
    expect(tapDragZoom.disable).toHaveBeenCalledTimes(2);
  });
});

describe("gameplay map pixel ratio", () => {
  const store = new Map<string, string>();
  const phone = (coarse: boolean): void => {
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: coarse && query.includes("coarse") }),
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
      }
    });
  };
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it("renders at the full device pixel ratio by default, on phones too", () => {
    phone(true);
    expect(gameMapPixelRatio(3)).toBeUndefined();
    expect(gameMapPixelRatio(1.5)).toBeUndefined();
  });

  it("caps phone-class devices at 2x only when Low graphics quality is chosen", () => {
    phone(true);
    setReducedRenderQualityEnabled(true);
    expect(gameMapPixelRatio(3)).toBe(2);
    expect(gameMapPixelRatio(1.5)).toBe(1.5);
  });

  it("leaves desktop at the MapLibre default even on Low", () => {
    phone(false);
    setReducedRenderQualityEnabled(true);
    expect(gameMapPixelRatio(3)).toBeUndefined();
  });
});
