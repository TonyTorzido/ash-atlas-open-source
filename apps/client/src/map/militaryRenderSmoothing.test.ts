import { describe, expect, it } from "vitest";

import { destinationPoint, distanceMeters } from "@ash-atlas/shared";

import {
  MILITARY_RENDER_SNAP_DISTANCE_M,
  nextMilitaryRenderPosition,
  shouldSnapMilitaryRenderPosition,
  type MilitaryRenderSample
} from "./militaryRenderSmoothing.js";

const origin = { lat: 35, lon: -106 };

function sample(overrides: Partial<MilitaryRenderSample> = {}): MilitaryRenderSample {
  return {
    authoritative: origin,
    rendered: origin,
    locationState: "FOLLOWING_PLAYER",
    revision: "1",
    ...overrides
  };
}

describe("military render smoothing", () => {
  it("interpolates a normal authoritative movement sample", () => {
    const target = destinationPoint(origin, 100, 90);
    const next = nextMilitaryRenderPosition(origin, target, 1 / 60, false);
    expect(distanceMeters(origin, next)).toBeGreaterThan(0);
    expect(distanceMeters(next, target)).toBeGreaterThan(0);
    expect(distanceMeters(origin, next)).toBeLessThan(100);
  });

  it("snaps large corrections and reduced-motion updates", () => {
    const target = destinationPoint(origin, MILITARY_RENDER_SNAP_DISTANCE_M + 1, 90);
    expect(shouldSnapMilitaryRenderPosition(sample(), {
      authoritative: target,
      locationState: "FOLLOWING_PLAYER"
    }, false)).toBe(true);
    expect(shouldSnapMilitaryRenderPosition(sample(), {
      authoritative: origin,
      locationState: "FOLLOWING_PLAYER"
    }, true)).toBe(true);
    expect(nextMilitaryRenderPosition(origin, target, 1 / 60, true)).toEqual(target);
  });

  it("snaps station and recovery lifecycle changes", () => {
    expect(shouldSnapMilitaryRenderPosition(sample(), {
      authoritative: origin,
      locationState: "STATIONED_CITY"
    }, false)).toBe(true);
    expect(shouldSnapMilitaryRenderPosition(sample(), {
      authoritative: origin,
      locationState: "DEPLOYED_FIELD"
    }, false)).toBe(false);
  });
});
