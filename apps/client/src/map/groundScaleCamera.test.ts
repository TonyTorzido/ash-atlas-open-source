import { describe, expect, it, vi } from "vitest";
import {
  applyCameraZoomLimits,
  cameraZoomForMove,
  widenCameraZoomLimits,
  cameraZoomForGroundZoom,
  cameraZoomLimits,
  groundZoomForCameraZoom,
  GROUND_ZOOM_DRIFT_EPSILON,
  CAMERA_ZOOM_FLOOR,
  holdGroundZoomCameraZoom,
  idleGroundZoomCorrection
} from "./groundScaleCamera.js";

describe("groundScaleCamera", () => {
  it("is the identity at the equator", () => {
    expect(cameraZoomForGroundZoom(15, 0)).toBe(15);
  });

  it("matches the plan's camera zoom table for ground zoom 15", () => {
    const table: Array<[number, number]> = [[45, 14.5], [60, 14], [70, 13.45], [75, 13.05], [80, 12.47], [85, 11.48]];
    for (const [lat, zoom] of table) {
      expect(cameraZoomForGroundZoom(15, lat)).toBeCloseTo(zoom, 1);
      expect(cameraZoomForGroundZoom(15, -lat)).toBeCloseTo(zoom, 1);
    }
  });

  it("round-trips at every latitude including the poles", () => {
    for (const lat of [0, 45, 60, 70, 80, 85, 90, -90, -45]) {
      expect(groundZoomForCameraZoom(cameraZoomForGroundZoom(15, lat), lat)).toBeCloseTo(15, 10);
    }
  });

  it("clamps latitude to 85 so the poles stay finite", () => {
    expect(cameraZoomForGroundZoom(15, 90)).toBe(cameraZoomForGroundZoom(15, 85));
    expect(cameraZoomForGroundZoom(15, -120)).toBe(cameraZoomForGroundZoom(15, 85));
  });

  it("survives NaN and infinite input", () => {
    expect(cameraZoomForGroundZoom(Number.NaN, 40)).toBeNaN();
    expect(groundZoomForCameraZoom(Number.NaN, 40)).toBeNaN();
    expect(cameraZoomForGroundZoom(15, Number.NaN)).toBe(15);
    expect(cameraZoomForGroundZoom(15, Number.POSITIVE_INFINITY)).toBe(15);
  });

  it("maps ground limits 2 and 18 to camera limits with the floor at -2", () => {
    expect(cameraZoomLimits(0)).toEqual({ minZoom: 2, maxZoom: 18 });
    const polar = cameraZoomLimits(85);
    expect(polar.minZoom).toBe(CAMERA_ZOOM_FLOOR); // the 2 - 3.52 ground mapping is floored: a world smaller than the viewport re-centres on the equator
    expect(polar.maxZoom).toBeCloseTo(18 - 3.52, 1);
    expect(cameraZoomLimits(85, -2, 18).minZoom).toBeGreaterThanOrEqual(CAMERA_ZOOM_FLOOR);
    expect(cameraZoomLimits(85, -1, 18).minZoom).toBe(CAMERA_ZOOM_FLOOR);
    expect(cameraZoomLimits(Number.NaN)).toEqual({ minZoom: 2, maxZoom: 18 });
  });

  it("re-applies limits only when they drifted by more than the epsilon", () => {
    const map = {
      center: 0,
      min: 2,
      max: 18,
      zoom: 15,
      getCenter() { return { lat: this.center }; },
      getZoom() { return this.zoom; },
      getMinZoom() { return this.min; },
      getMaxZoom() { return this.max; },
      setMinZoom: vi.fn(function (this: { min: number }, zoom: number) { this.min = zoom; }),
      setMaxZoom: vi.fn(function (this: { max: number }, zoom: number) { this.max = zoom; })
    };
    expect(applyCameraZoomLimits(map)).toBe(false);
    map.center = 60;
    expect(applyCameraZoomLimits(map)).toBe(true);
    expect(map.min).toBe(CAMERA_ZOOM_FLOOR); // 2 - 1 is floored
    expect(map.max).toBeCloseTo(17, 10);
    map.center = 60 + 0.0001;
    expect(applyCameraZoomLimits(map)).toBe(false);
    expect(GROUND_ZOOM_DRIFT_EPSILON).toBe(0.01);
  });

  it("widens limits for a cross-latitude move and keeps the ground zoom", () => {
    const map = {
      center: 85, min: 0, max: 14.48, zoom: 14.48,
      getCenter() { return { lat: this.center }; },
      getZoom() { return this.zoom; },
      getMinZoom() { return this.min; },
      getMaxZoom() { return this.max; },
      setMinZoom(z: number) { this.min = z; },
      setMaxZoom(z: number) { this.max = z; }
    };
    const camera = cameraZoomForMove(map, 0);
    expect(camera).toBeCloseTo(14.48 + 3.52, 1);
    expect(map.max).toBe(18);
    expect(cameraZoomForMove(map, 0, 12)).toBe(12);
    widenCameraZoomLimits(map, 85);
    expect(map.max).toBe(18);
  });
});

describe("holdGroundZoomCameraZoom", () => {
  it("converts the desired ground zoom at the destination latitude", () => {
    const z = holdGroundZoomCameraZoom({ desiredGroundZoom: 15, latitudeDegrees: 70, currentCameraZoom: 15 });
    expect(z).toBeCloseTo(cameraZoomForGroundZoom(15, 70), 9);
  });
  it("leaves the zoom alone with no desired zoom, NaN input, or within the epsilon", () => {
    expect(holdGroundZoomCameraZoom({ desiredGroundZoom: null, latitudeDegrees: 70, currentCameraZoom: 15 })).toBeUndefined();
    expect(holdGroundZoomCameraZoom({ desiredGroundZoom: Number.NaN, latitudeDegrees: 70, currentCameraZoom: 15 })).toBeUndefined();
    expect(holdGroundZoomCameraZoom({ desiredGroundZoom: 15, latitudeDegrees: Number.NaN, currentCameraZoom: 15 })).toBeUndefined();
    const on = cameraZoomForGroundZoom(15, 45);
    expect(holdGroundZoomCameraZoom({ desiredGroundZoom: 15, latitudeDegrees: 45, currentCameraZoom: on + 0.005 })).toBeUndefined();
  });
  it("is the identity at the equator", () => {
    expect(holdGroundZoomCameraZoom({ desiredGroundZoom: 15, latitudeDegrees: 0, currentCameraZoom: 14 })).toBe(15);
  });
  it("leaves a camera sitting on the polar floor alone when the desired zoom is below it", () => {
    // Ground 3 at 70N is camera ~1.55, below the camera floor of 2; the map can only show 2.
    expect(cameraZoomForGroundZoom(3, 70)).toBeLessThan(CAMERA_ZOOM_FLOOR);
    expect(holdGroundZoomCameraZoom({ desiredGroundZoom: 3, latitudeDegrees: 70, currentCameraZoom: CAMERA_ZOOM_FLOOR })).toBeUndefined();
    expect(idleGroundZoomCorrection({
      desiredGroundZoom: 3, latitudeDegrees: 70, currentCameraZoom: CAMERA_ZOOM_FLOOR,
      nowMs: 5000, lastCorrectionMs: 0, gestureActive: false, programmaticMoveActive: false
    })).toBeUndefined();
    expect(holdGroundZoomCameraZoom({ desiredGroundZoom: 3, latitudeDegrees: 70, currentCameraZoom: 4 })).toBeCloseTo(cameraZoomForGroundZoom(3, 70), 9);
  });
});

describe("idleGroundZoomCorrection", () => {
  const base = { desiredGroundZoom: 15, latitudeDegrees: 70, currentCameraZoom: 15, nowMs: 5000, lastCorrectionMs: 0, gestureActive: false, programmaticMoveActive: false };
  it("corrects drift when idle", () => {
    expect(idleGroundZoomCorrection(base)).toBeCloseTo(cameraZoomForGroundZoom(15, 70), 9);
  });
  it("never runs during a gesture or a programmatic move", () => {
    expect(idleGroundZoomCorrection({ ...base, gestureActive: true })).toBeUndefined();
    expect(idleGroundZoomCorrection({ ...base, programmaticMoveActive: true })).toBeUndefined();
  });
  it("runs at most once per second", () => {
    expect(idleGroundZoomCorrection({ ...base, nowMs: 5000, lastCorrectionMs: 4500 })).toBeUndefined();
    expect(idleGroundZoomCorrection({ ...base, nowMs: 5000, lastCorrectionMs: 4000 })).toBeDefined();
  });
});
