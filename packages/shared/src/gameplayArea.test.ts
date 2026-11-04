import { describe, expect, it } from "vitest";

import {
  DEFAULT_FLAG_RADIUS_CONTRACT,
  GAMEPLAY_AREA_BOUNDARY_EPSILON_M,
  flagRadiusContractIssues,
  isInsideGameplayArea,
  resolveGameplayAreaTarget
} from "./gameplayArea.js";
import {
  WORLD_EDGE_MAX_ABS_LATITUDE,
  destinationPoint,
  distanceMeters,
  isWithinWorldEdge
} from "./geo.js";

describe("ordinary flag radius contract", () => {
  it("keeps claim, leash, vision, and preparation independently ordered", () => {
    expect(DEFAULT_FLAG_RADIUS_CONTRACT).toEqual({
      claimRadiusM: 500,
      movementLeashRadiusM: 600,
      certifiedVisionRadiusM: 650,
      preparationBufferM: 100,
      preparedRadiusM: 750
    });
    expect(flagRadiusContractIssues(DEFAULT_FLAG_RADIUS_CONTRACT)).toEqual([]);
  });

  it("rejects collapsed or inconsistent geometry", () => {
    expect(flagRadiusContractIssues({
      claimRadiusM: 600,
      movementLeashRadiusM: 600,
      certifiedVisionRadiusM: 650,
      preparationBufferM: 100,
      preparedRadiusM: 800
    })).toEqual(expect.arrayContaining([
      "claim radius must be smaller than movement leash radius",
      "prepared radius must equal certified vision radius plus preparation buffer"
    ]));
  });
});

describe("gameplay-area movement geometry", () => {
  const center = { lat: 35.0844, lon: -106.6504 };
  const area = { anchorLat: center.lat, anchorLon: center.lon, moveLeashRadiusM: 600 };

  it.each([
    ["north", 0],
    ["east", 90],
    ["south", 180],
    ["west", 270],
    ["diagonal", 45]
  ])("clamps an outside target %s to the same nearest boundary", (_label, bearing) => {
    const requested = destinationPoint(center, 900, bearing as number);
    const resolved = resolveGameplayAreaTarget(area, requested)!;
    expect(resolved.outside).toBe(true);
    expect(distanceMeters(center, resolved.target)).toBeCloseTo(
      area.moveLeashRadiusM - GAMEPLAY_AREA_BOUNDARY_EPSILON_M,
      5
    );
    expect(distanceMeters(resolved.target, requested)).toBeCloseTo(
      900 - area.moveLeashRadiusM + GAMEPLAY_AREA_BOUNDARY_EPSILON_M,
      4
    );
  });

  it("treats the boundary and just-inside point as reachable, but clamps just outside", () => {
    const boundary = destinationPoint(center, 600, 30);
    const inside = destinationPoint(center, 599.9, 30);
    const outside = destinationPoint(center, 600.1, 30);
    expect(isInsideGameplayArea(area, boundary)).toBe(true);
    expect(isInsideGameplayArea(area, inside)).toBe(true);
    expect(isInsideGameplayArea(area, outside)).toBe(false);
    expect(resolveGameplayAreaTarget(area, boundary)?.outside).toBe(false);
    expect(resolveGameplayAreaTarget(area, outside)?.outside).toBe(true);
  });

  it("remains geodesic at high latitude and follows configured radius changes", () => {
    const polarCenter = { lat: 78.2, lon: 15.6 };
    const requested = destinationPoint(polarCenter, 1_200, 112);
    for (const radius of [275, 825]) {
      const resolved = resolveGameplayAreaTarget({
        anchorLat: polarCenter.lat,
        anchorLon: polarCenter.lon,
        moveLeashRadiusM: radius
      }, requested)!;
      expect(distanceMeters(polarCenter, resolved.target)).toBeCloseTo(
        radius - GAMEPLAY_AREA_BOUNDARY_EPSILON_M,
        5
      );
    }
  });
});

describe("world edge movement resolution", () => {
  for (const hemisphere of [1, -1]) {
    it(`keeps targets inside the edge unchanged (${hemisphere > 0 ? "north" : "south"})`, () => {
      const anchor = { lat: hemisphere * 84.9, lon: 20 };
      const requested = { lat: hemisphere * 84.902, lon: 20 };
      const resolved = resolveGameplayAreaTarget({
        anchorLat: anchor.lat,
        anchorLon: anchor.lon,
        moveLeashRadiusM: 600
      }, requested)!;
      expect(resolved.target).toEqual(requested);
      expect(resolved.worldEdgeClamped).toBeUndefined();
    });

    it(`pulls leash targets beyond the edge back onto it (${hemisphere > 0 ? "north" : "south"})`, () => {
      const anchor = { lat: hemisphere * 84.998, lon: 20 };
      const area = { anchorLat: anchor.lat, anchorLon: anchor.lon, moveLeashRadiusM: 600 };
      for (const requestedLat of [85.1, 89.9]) {
        const resolved = resolveGameplayAreaTarget(area, {
          lat: hemisphere * requestedLat,
          lon: 20.001
        })!;
        expect(resolved.worldEdgeClamped).toBe(true);
        expect(resolved.target.lat).toBe(hemisphere * WORLD_EDGE_MAX_ABS_LATITUDE);
        expect(isWithinWorldEdge(resolved.target)).toBe(true);
        expect(isInsideGameplayArea(area, resolved.target)).toBe(true);
      }
    });
  }
});
