import { describe, expect, it } from "vitest";

import { classifyFlagPlacementTerrain } from "./flagPlacementTerrain.js";

describe("flag placement terrain classification", () => {
  it("uses the normalized authoritative decision for river corridors", () => {
    const shared = {
      sourceId: "river-1",
      sourceName: null,
      distanceM: 10,
      corridorRadiusM: 16,
      reason: "inside authoritative supporting-river corridor",
      resolution: "water-placement-surface-v1",
      releaseId: "world-packages-v1"
    };
    expect(classifyFlagPlacementTerrain({
      isLand: true,
      flagPlacementWater: { ...shared, blocked: true, kind: "river" }
    })).toBe("water");
    expect(classifyFlagPlacementTerrain({
      isLand: true,
      flagPlacementWater: {
        ...shared,
        blocked: false,
        kind: "land",
        distanceM: null,
        corridorRadiusM: null
      }
    })).toBe("land");
  });

  it("rejects ocean, major-lake, and authoritative inland-water locations", () => {
    expect(classifyFlagPlacementTerrain({ isLand: false })).toBe("water");
    expect(classifyFlagPlacementTerrain({ isLand: true, isSaltwater: true })).toBe("water");
    expect(classifyFlagPlacementTerrain({
      isLand: true,
      isSaltwater: false,
      insideMajorLake: true
    })).toBe("water");
    expect(classifyFlagPlacementTerrain({
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      landCoverClass: "inland_water"
    })).toBe("water");
  });

  it("recognizes complete non-water land classifications", () => {
    expect(classifyFlagPlacementTerrain({
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      landCoverClass: "urban"
    })).toBe("land");
  });

  it("keeps incomplete classifications uncertain", () => {
    expect(classifyFlagPlacementTerrain({ isLand: true, isSaltwater: false })).toBe("unknown");
    expect(classifyFlagPlacementTerrain({})).toBe("unknown");
  });
});
