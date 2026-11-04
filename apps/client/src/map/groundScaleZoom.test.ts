import { describe, expect, it } from "vitest";
import {
  GROUND_SCALE_MIN_COSINE,
  MAP_MAX_LATITUDE,
  SAFE_COSINE_FLOOR,
  clampMapLatitude,
  safeCosLatitude,
  groundScaleZoom,
  groundScaleZoomOffset,
  mapGroundScaleZoom
} from "./groundScaleZoom.js";
import {
  SPRITE_BASE_ZOOM,
  SPRITE_PRESENTATION,
  spriteHeightForZoom
} from "./spritePresentation.js";

describe("groundScaleZoom", () => {
  it("is the identity at the equator", () => {
    expect(groundScaleZoomOffset(0)).toBe(0);
    expect(groundScaleZoom(15, 0)).toBe(15);
  });

  it("adds one zoom level at 60 degrees and about 3.52 at 85 degrees", () => {
    expect(groundScaleZoomOffset(60)).toBeCloseTo(1, 10);
    expect(groundScaleZoomOffset(-60)).toBeCloseTo(1, 10);
    expect(groundScaleZoomOffset(85)).toBeCloseTo(3.52, 2);
  });

  it("clamps at the poles", () => {
    const max = Math.log2(1 / GROUND_SCALE_MIN_COSINE);
    expect(groundScaleZoomOffset(90)).toBeCloseTo(max, 10);
    expect(groundScaleZoomOffset(-90)).toBeCloseTo(max, 10);
    expect(Number.isFinite(groundScaleZoomOffset(90))).toBe(true);
    expect(groundScaleZoomOffset(Number.NaN)).toBe(0);
  });

  it("gives the same sprite height for the same ground framing at any latitude", () => {
    const presentation = SPRITE_PRESENTATION.player;
    const equator = spriteHeightForZoom(15, SPRITE_BASE_ZOOM, presentation);
    for (const lat of [0, 60, 78, 84, -84]) {
      const cameraZoom = 15 - groundScaleZoomOffset(lat);
      const height = spriteHeightForZoom(
        groundScaleZoom(cameraZoom, lat),
        SPRITE_BASE_ZOOM,
        presentation
      );
      expect(height).toBeCloseTo(equator, 6);
    }
  });

  it("reads zoom and center latitude from a map", () => {
    const map = { getZoom: () => 10, getCenter: () => ({ lat: 60 }) };
    expect(mapGroundScaleZoom(map)).toBeCloseTo(11, 10);
  });
});

describe("polar guards", () => {
  it("clamps latitude to the Mercator limit and survives non-finite input", () => {
    expect(clampMapLatitude(-90)).toBe(-MAP_MAX_LATITUDE);
    expect(clampMapLatitude(95)).toBe(MAP_MAX_LATITUDE);
    expect(clampMapLatitude(Number.NaN)).toBe(0);
    expect(clampMapLatitude(-65)).toBe(-65);
  });

  it("never lets cos(lat) fall below the floor", () => {
    expect(safeCosLatitude(90)).toBeGreaterThanOrEqual(SAFE_COSINE_FLOOR);
    expect(safeCosLatitude(-90)).toBeGreaterThanOrEqual(SAFE_COSINE_FLOOR);
    expect(1 / safeCosLatitude(90)).toBeLessThan(20);
    expect(safeCosLatitude(0)).toBe(1);
  });
});
