import { describe, expect, it } from "vitest";

import {
  GAMEPLAY_RECENTER_CAMERA_MAX_DURATION_MS,
  GAMEPLAY_RECENTER_CAMERA_MIN_DURATION_MS,
  gameplayMapRecenterTargetZoom,
  globeCameraFramingScalar,
  globeCameraViewportDimension,
  globeZoomForEquivalentFraming,
  gameplayZoomForWorldMapGlobeZoom,
  planGameplayMapRecenter,
  planGlobeMapRecenter,
  worldMapGlobeZoomForGameplayZoom,
  worldMapRecenterTargetZoom
} from "./globeCamera.js";
import {
  GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM,
  GAMEPLAY_MAP_DETAIL_FULL_ZOOM,
  MIN_MAP_ZOOM
} from "./mapZoomConfig.js";
import {
  cubicEaseInOut,
  RECENTER_CAMERA_DURATION_MS,
  RECENTER_CAMERA_TIMEOUT_MS
} from "./flagTravelCamera.js";

describe("shared globe camera contract", () => {
  it("keeps equivalent regular and standalone globe zooms in the same range", () => {
    for (const globeZoom of [2, 3, 4, 5]) {
      const gameplayZoom = gameplayZoomForWorldMapGlobeZoom(globeZoom);
      expect(worldMapGlobeZoomForGameplayZoom(gameplayZoom)).toBeCloseTo(globeZoom);
    }
    expect(worldMapGlobeZoomForGameplayZoom(MIN_MAP_ZOOM)).toBe(2);
    expect(worldMapGlobeZoomForGameplayZoom(MIN_MAP_ZOOM + 5)).toBe(5);
    expect(gameplayZoomForWorldMapGlobeZoom(0)).toBe(MIN_MAP_ZOOM);
  });

  it("keeps globe framing equal across viewport and latitude differences", () => {
    const standalone = {
      zoom: 4,
      latitude: 35,
      viewport: {
        width: 900,
        height: 620,
        padding: { top: 24, right: 16, bottom: 20, left: 16 }
      }
    } as const;
    const regularViewport = {
      width: 1_280,
      height: 760,
      padding: { top: 56, right: 24, bottom: 18, left: 24 }
    } as const;
    expect(globeCameraViewportDimension(standalone.viewport)).toBe(576);
    const regularZoom = globeZoomForEquivalentFraming({
      source: standalone,
      targetLatitude: 35,
      targetViewport: regularViewport
    });
    expect(globeCameraFramingScalar({
      zoom: regularZoom,
      latitude: 35,
      viewport: regularViewport
    })).toBeCloseTo(globeCameraFramingScalar(standalone));
    expect(regularZoom).toBeCloseTo(standalone.zoom + Math.log2(686 / 576));
  });

  it("returns to local gameplay detail only from the globe transition band", () => {
    expect(gameplayMapRecenterTargetZoom(GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM)).toBe(15);
    expect(gameplayMapRecenterTargetZoom(GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM + 0.01))
      .toBeUndefined();
    expect(gameplayMapRecenterTargetZoom(GAMEPLAY_MAP_DETAIL_FULL_ZOOM)).toBeUndefined();
    expect(worldMapRecenterTargetZoom(0)).toBe(3);
    expect(worldMapRecenterTargetZoom(4)).toBe(4);
  });

  it("uses one cancellable cubic recenter plan and reduced-motion jump", () => {
    const plan = planGlobeMapRecenter({
      center: { lat: 51.05, lon: -114.07 },
      targetZoom: 15,
      reducedMotion: false
    });
    expect(plan.center).toEqual([-114.07, 51.05]);
    expect(plan.zoom).toBe(15);
    expect(plan.durationMs).toBe(RECENTER_CAMERA_DURATION_MS);
    expect(plan.timeoutMs).toBe(RECENTER_CAMERA_TIMEOUT_MS);
    expect(plan.easing).toBe(cubicEaseInOut);
    expect(plan.easing(0.25)).toBeCloseTo(0.0625);

    expect(planGlobeMapRecenter({
      center: { lat: 0, lon: 0 },
      targetZoom: 3,
      reducedMotion: true
    })).toMatchObject({ durationMs: 0, timeoutMs: 0, zoom: 3 });
  });

  it("scales gameplay recenter by distance and zoom without a late burst", () => {
    const nearby = planGameplayMapRecenter({
      center: { lat: 51.05, lon: -114.07 },
      currentZoom: 15,
      targetZoom: undefined,
      viewportDistance: 0,
      reducedMotion: false
    });
    const distant = planGameplayMapRecenter({
      center: { lat: 51.05, lon: -114.07 },
      currentZoom: 15,
      targetZoom: undefined,
      viewportDistance: 2,
      reducedMotion: false
    });
    const globe = planGameplayMapRecenter({
      center: { lat: 51.05, lon: -114.07 },
      currentZoom: 2,
      targetZoom: 15,
      viewportDistance: 0,
      reducedMotion: false
    });

    expect(nearby.durationMs).toBe(GAMEPLAY_RECENTER_CAMERA_MIN_DURATION_MS);
    expect(distant.durationMs).toBe(GAMEPLAY_RECENTER_CAMERA_MAX_DURATION_MS);
    expect(globe.durationMs).toBe(3_600);
    expect(globe.durationMs).toBeGreaterThan(distant.durationMs * 2);
    expect(globe.timeoutMs).toBeGreaterThan(globe.durationMs);
    expect(globe.easing(0.25)).toBeCloseTo(0.0625);
    expect(globe.easing(0.75)).toBeCloseTo(0.9375);
  });
});
