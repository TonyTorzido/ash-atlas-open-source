import { describe, expect, it } from "vitest";

import { destinationPoint, moveToward } from "@ash-atlas/shared";
import { SpatialHashGrid } from "./spatialGrid.js";

const origin = { lat: 35.0844, lon: -106.6504 };

describe("SpatialHashGrid", () => {
  it.each([origin, { lat: 80, lon: 15 }, { lat: 0, lon: 179.999 }])(
    "returns identical sparse/dense candidates and exact boundaries at %j",
    (center) => {
      const sparse = new SpatialHashGrid(128);
      const dense = new SpatialHashGrid(128);
      for (const grid of [sparse, dense]) {
        grid.insert("inside", destinationPoint(center, 649, 90));
        grid.insert("boundary", destinationPoint(center, 650 - 1e-6, 90));
        grid.insert("outside", destinationPoint(center, 651, 90));
      }
      // Enough remote occupied cells to select the regular cell-window scan even at latitude 80.
      for (let index = 0; index < 12_000; index += 1) {
        dense.insert(`remote-${index}`, { lat: -60 + index * 0.005, lon: 0 });
      }
      expect(sparse.candidatesForPosition(center, 650)).toEqual(dense.candidatesForPosition(center, 650));
      expect(sparse.query(center, 650)).toEqual(["boundary", "inside"]);
      expect(dense.query(center, 650)).toEqual(["boundary", "inside"]);
    }
  );

  it("inserts, updates, removes, and distance-filters entities", () => {
    const grid = new SpatialHashGrid(128);
    grid.insert("near", moveToward(origin, { ...origin, lon: origin.lon + 0.02 }, 60));
    grid.insert("far", moveToward(origin, { ...origin, lon: origin.lon + 0.02 }, 300));

    expect(grid.query(origin, 100)).toEqual(["near"]);
    grid.update("far", moveToward(origin, { ...origin, lat: origin.lat + 0.02 }, 80));
    expect(grid.query(origin, 100)).toEqual(["far", "near"]);
    grid.remove("near");
    expect(grid.query(origin, 100)).toEqual(["far"]);
    expect(grid.consumeQueryCount()).toBe(3);
  });

  it("keeps near-edge geographic candidates at non-equatorial latitudes", () => {
    const grid = new SpatialHashGrid(250);
    grid.insert("inside", destinationPoint(origin, 950, 90));
    grid.insert("outside", destinationPoint(origin, 1_050, 90));

    expect(grid.query(origin, 1_000)).toEqual(["inside"]);
  });

  it("keeps authoritative-view candidates complete at high latitude", () => {
    const highLatitude = { lat: 80, lon: 15 };
    const grid = new SpatialHashGrid(100);
    grid.insert("inside", destinationPoint(highLatitude, 649, 90));
    grid.insert("outside", destinationPoint(highLatitude, 651, 90));

    const candidates = grid.candidatesForPosition(highLatitude, 650);
    expect(candidates).toEqual(["inside", "outside"]);
    expect(grid.filterCandidates(highLatitude, 650, candidates)).toEqual(["inside"]);
  });

  it("wraps authoritative-view candidates across the antimeridian", () => {
    const grid = new SpatialHashGrid(100);
    const center = { lat: 0, lon: 179.999 };
    grid.insert("wrapped", { lat: 0, lon: -179.999 });

    const candidates = grid.candidatesForPosition(center, 650);

    expect(candidates).toContain("wrapped");
    expect(grid.filterCandidates(center, 650, candidates)).toEqual(["wrapped"]);
  });

  it("keeps polar circles complete without an unbounded empty-cell scan", () => {
    const grid = new SpatialHashGrid(100);
    const center = { lat: 89.999, lon: 0 };
    grid.insert("polar-near", { lat: 89.999, lon: 180 });
    grid.insert("polar-far", { lat: 89.98, lon: 0 });

    const candidates = grid.candidatesForPosition(center, 650);

    expect(candidates).toEqual(["polar-far", "polar-near"]);
    expect(grid.filterCandidates(center, 650, candidates)).toEqual(["polar-near"]);
  });
});
