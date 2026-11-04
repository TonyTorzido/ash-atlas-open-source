import { describe, expect, it } from "vitest";

import {
  WORLD_EDGE_MAX_ABS_LATITUDE,
  clampToWorldEdge,
  destinationPoint,
  distanceMeters,
  interpolateLatLon,
  isWithinWorldEdge,
  longitudeDeltaDegrees,
  moveToward,
  normalizeLongitude,
  wgs84DestinationPoint,
  wgs84DistanceMeters
} from "./geo.js";
import { resolveGameplayAreaTarget } from "./gameplayArea.js";

describe("WGS84 territory geometry", () => {
  it("projects a WGS84 geodesic destination and measures its distance back", () => {
    const center = { lat: 35.2106, lon: -106.4497 };
    const projected = wgs84DestinationPoint(center, 2_000, 237.46732673444146);

    expect(projected.lat).toBeCloseTo(35.200903985272134, 9);
    expect(projected.lon).toBeCloseTo(-106.46821621802917, 9);
    expect(wgs84DistanceMeters(center, projected)).toBeCloseTo(2_000, 6);
  });
});

describe("antimeridian geo math", () => {
  const fijiEast = { lat: -17.8, lon: 179.99 };
  const fijiWest = { lat: -17.8, lon: -179.99 };

  it("measures and projects the short way across 180 degrees", () => {
    expect(distanceMeters(fijiEast, fijiWest)).toBeCloseTo(2_117, -1);
    expect(wgs84DistanceMeters(fijiEast, fijiWest)).toBeCloseTo(2_121, -1);
    const east = destinationPoint({ lat: 51.9, lon: 179.9 }, 20_000, 90);
    expect(east.lon).toBeLessThan(-179.6);
    expect(east.lon).toBeGreaterThanOrEqual(-180);
  });

  it("wraps longitude deltas and interpolation across the seam", () => {
    expect(normalizeLongitude(180.25)).toBeCloseTo(-179.75, 9);
    expect(normalizeLongitude(-180.25)).toBeCloseTo(179.75, 9);
    expect(normalizeLongitude(180)).toBe(180);
    expect(longitudeDeltaDegrees(179.99, -179.99)).toBeCloseTo(0.02, 9);
    expect(longitudeDeltaDegrees(-179.99, 179.99)).toBeCloseTo(-0.02, 9);
    expect(longitudeDeltaDegrees(-176.5, -176.4)).toBeCloseTo(0.1, 9);
    const midpoint = interpolateLatLon(fijiEast, fijiWest, 0.75);
    expect(midpoint.lon).toBeCloseTo(-179.995, 9);
  });

  it("moves a player a short step across the seam instead of around the world", () => {
    const step = moveToward(fijiEast, fijiWest, 1_500);
    expect(distanceMeters(fijiEast, step)).toBeCloseTo(1_500, 0);
    expect(distanceMeters(step, fijiWest)).toBeLessThan(700);
    expect(step.lon).toBeGreaterThanOrEqual(-180);
    expect(step.lon).toBeLessThan(-179.99);
    const back = moveToward({ lat: 51.9, lon: -179.95 }, { lat: 51.9, lon: 179.9 }, 5_000);
    expect(back.lon).toBeGreaterThan(179.9);
    expect(distanceMeters({ lat: 51.9, lon: -179.95 }, back)).toBeCloseTo(5_000, 0);
  });

  it("resolves a leash clamp across the seam from a Chatham-side anchor", () => {
    const area = { anchorLat: -17.8, anchorLon: -179.999, moveLeashRadiusM: 600 };
    const resolved = resolveGameplayAreaTarget(area, { lat: -17.8, lon: 179.98 })!;
    expect(resolved.outside).toBe(true);
    expect(resolved.target.lon).toBeGreaterThan(179.99);
    expect(distanceMeters({ lat: -17.8, lon: -179.999 }, resolved.target)).toBeCloseTo(599.75, 1);
  });
});

describe("world edge", () => {
  it("allows the edge and inside it in both hemispheres", () => {
    for (const lat of [84.9, -84.9, 85, -85, 0]) {
      expect(isWithinWorldEdge({ lat, lon: 10 })).toBe(true);
      expect(clampToWorldEdge({ lat, lon: 10 })).toEqual({ lat, lon: 10 });
    }
  });

  it("rejects and clamps beyond the edge in both hemispheres", () => {
    for (const lat of [85.1, 89.9, 90, -85.1, -89.9, -90]) {
      expect(isWithinWorldEdge({ lat, lon: -120 })).toBe(false);
      expect(clampToWorldEdge({ lat, lon: -120 })).toEqual({
        lat: Math.sign(lat) * WORLD_EDGE_MAX_ABS_LATITUDE,
        lon: -120
      });
    }
  });

  it("treats non-coordinates as outside the world", () => {
    expect(isWithinWorldEdge({ lat: Number.NaN, lon: 0 })).toBe(false);
    expect(isWithinWorldEdge({ lat: 10, lon: 181 })).toBe(false);
  });
});
