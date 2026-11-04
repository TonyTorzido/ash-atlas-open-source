import { describe, expect, it } from "vitest";

import {
  adjacentZoneIdsForPosition,
  packageIdForPosition,
  zoneIdsIntersectingCircle,
  zoneIdForPosition
} from "./spatialZones.js";

describe("global package spatial zones", () => {
  it("uses the same floor semantics as world-packages-v1", () => {
    expect(packageIdForPosition({ lat: 35.0844, lon: -106.6504 })).toBe(
      "world_v1_lat35_lon-107"
    );
    expect(zoneIdForPosition({ lat: -0.01, lon: -0.01 })).toBe(
      "world:world_v1_lat-1_lon-1"
    );
    expect(packageIdForPosition({ lat: 90, lon: 180 })).toBe("world_v1_lat89_lon179");
  });

  it("subscribes neighboring packages across the date line", () => {
    const east = adjacentZoneIdsForPosition({ lat: 0.5, lon: 179.5 });
    expect(east).toContain("world:world_v1_lat0_lon179");
    expect(east).toContain("world:world_v1_lat0_lon-180");
    expect(east).toHaveLength(9);

    const west = adjacentZoneIdsForPosition({ lat: -17.8, lon: -179.99 });
    expect(west).toContain("world:world_v1_lat-18_lon179");
    expect(west).toContain("world:world_v1_lat-18_lon-180");
    expect(west.some((zone) => zone.includes("lon-181"))).toBe(false);
    expect(west).toHaveLength(9);
  });

  it("enumerates every package touched by a circle at the date line and pole", () => {
    const dateLine = zoneIdsIntersectingCircle({ lat: 0.5, lon: 179.999 }, 650);
    expect(dateLine).toContain("world:world_v1_lat0_lon179");
    expect(dateLine).toContain("world:world_v1_lat0_lon-180");

    const pole = zoneIdsIntersectingCircle({ lat: 89.999, lon: 0 }, 650);
    expect(pole).toContain("world:world_v1_lat89_lon-180");
    expect(pole).toContain("world:world_v1_lat89_lon179");
    expect(pole).toHaveLength(360);
  });
});
