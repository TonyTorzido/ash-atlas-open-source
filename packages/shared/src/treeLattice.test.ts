import { describe, expect, it } from "vitest";

import { distanceMeters } from "./geo.js";
import { SAPLING_MIN_SPACING_M } from "./givingSaplings.js";
import {
  TREE_LATTICE_MAX_SNAP_M,
  TREE_LATTICE_ROW_SPACING_M,
  nearestTreeLatticePoint,
  treeLatticeKey,
  treeLatticePointsAround
} from "./treeLattice.js";

const SITES = [
  { name: "Albuquerque", lat: 35.0844, lon: -106.6504 },
  { name: "Greenwich", lat: 51.4769, lon: 0.0005 },
  { name: "Fiji", lat: -17.8, lon: 178.2 },
  { name: "Svalbard", lat: 78.2, lon: 15.6 },
  { name: "Equator", lat: 0.0001, lon: 100.4 }
];

describe("tree planting lattice", () => {
  it("is deterministic and idempotent on its own points", () => {
    for (const site of SITES) {
      const first = nearestTreeLatticePoint(site);
      expect(nearestTreeLatticePoint(site)).toEqual(first);
      const again = nearestTreeLatticePoint(first);
      expect(treeLatticeKey(again)).toBe(treeLatticeKey(first));
    }
  });

  it("keeps every neighbour 90 m away, at any longitude", () => {
    expect(SAPLING_MIN_SPACING_M).toBe(90);
    expect(TREE_LATTICE_ROW_SPACING_M).toBeCloseTo(77.94, 2);
    for (const site of SITES) {
      const p = nearestTreeLatticePoint(site);
      const near = treeLatticePointsAround(p, 120).filter((n) => treeLatticeKey(n) !== treeLatticeKey(p))
        .map((n) => distanceMeters(p, n)).sort((a, b) => a - b).slice(0, 6);
      expect(near).toHaveLength(6);
      for (const distance of near) expect(Math.abs(distance - 90)).toBeLessThan(0.3);
    }
  });

  it("snaps any point to a lattice point within 90 / sqrt(3) m", () => {
    for (const site of SITES) {
      for (let i = 0; i < 400; i += 1) {
        const probe = { lat: site.lat + (i % 20) * 0.00004, lon: site.lon + Math.floor(i / 20) * 0.00005 };
        const snapped = nearestTreeLatticePoint(probe);
        expect(distanceMeters(probe, snapped)).toBeLessThanOrEqual(TREE_LATTICE_MAX_SNAP_M + 0.1);
      }
    }
  });

  it("lists a bounded window of points", () => {
    const points = treeLatticePointsAround(SITES[0]!, 360);
    expect(points.length).toBeGreaterThan(40);
    expect(points.length).toBeLessThan(120);
    expect(new Set(points.map(treeLatticeKey)).size).toBe(points.length);
    expect(treeLatticePointsAround(SITES[0]!, 1e9).length).toBeLessThan(6_000);
  });
});
