import { describe, expect, it } from "vitest";

import {
  angularDistanceDegrees,
  bearingDegrees,
  isPointInsideBossGeometry,
  type BossTelegraphGeometry
} from "./boss.js";

const origin = { lat: 35, lon: -106 };

describe("shared boss telegraph geometry", () => {
  it("uses inclusive circle boundaries", () => {
    const geometry: BossTelegraphGeometry = {
      kind: "circle",
      center: origin,
      radiusM: 100
    };
    expect(isPointInsideBossGeometry(origin, geometry)).toBe(true);
    expect(isPointInsideBossGeometry({ lat: 35.0008, lon: -106 }, geometry)).toBe(true);
    expect(isPointInsideBossGeometry({ lat: 35.002, lon: -106 }, geometry)).toBe(false);
  });

  it("resolves cone facing and its edge boundaries", () => {
    const geometry: BossTelegraphGeometry = {
      kind: "cone",
      origin,
      facingDegrees: 0,
      rangeM: 200,
      angleDegrees: 90
    };
    expect(isPointInsideBossGeometry({ lat: 35.001, lon: -106 }, geometry)).toBe(true);
    expect(isPointInsideBossGeometry({ lat: 35, lon: -105.998 }, geometry)).toBe(false);
    expect(angularDistanceDegrees(359, 1)).toBe(2);
  });

  it("resolves line lane width and length", () => {
    const geometry: BossTelegraphGeometry = {
      kind: "line",
      origin,
      facingDegrees: 0,
      lengthM: 200,
      widthM: 40
    };
    expect(isPointInsideBossGeometry({ lat: 35.001, lon: -106 }, geometry)).toBe(true);
    expect(isPointInsideBossGeometry({ lat: 35.001, lon: -105.999 }, geometry)).toBe(false);
    expect(isPointInsideBossGeometry({ lat: 35.003, lon: -106 }, geometry)).toBe(false);
  });

  it("uses true-north bearing conventions", () => {
    expect(bearingDegrees(origin, { lat: 35.001, lon: -106 })).toBeCloseTo(0, 2);
    expect(bearingDegrees(origin, { lat: 35, lon: -105.999 })).toBeCloseTo(90, 2);
  });
});
