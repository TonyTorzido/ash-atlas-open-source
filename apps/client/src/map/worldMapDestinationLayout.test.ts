import type { WorldMapDestination } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { clusterWorldMapDestinations } from "./worldMapDestinationLayout.js";

describe("World Map destination clustering", () => {
  it("collapses a dense city without transitive chain grouping", () => {
    const dense = destinations(20, (index) => ({ x: index * 3, y: 0 }));
    const clusters = clusterWorldMapDestinations(dense.values, dense.project, 12);
    expect(clusters.map((cluster) => cluster.destinations.length)).toEqual([5, 5, 5, 5]);
  });

  it("keeps distinct nearby regions separate and splits progressively with zoom", () => {
    const values = destinations(12, (index) => ({
      x: index < 6 ? index : 100 + index,
      y: index < 6 ? 0 : 100
    }));
    expect(clusterWorldMapDestinations(values.values, values.project, 20)).toHaveLength(2);
    expect(clusterWorldMapDestinations(values.values, (destination) => {
      const point = values.project(destination);
      return { x: point.x * 24, y: point.y * 24 };
    }, 20)).toHaveLength(12);
  });

  it("keeps exact-coordinate destinations together for immediate selection", () => {
    const exact = destinations(8, () => ({ x: 12, y: 18 }));
    const [cluster] = clusterWorldMapDestinations(exact.values, exact.project);
    expect(cluster?.destinations).toHaveLength(8);
    expect(cluster?.screenCenter).toEqual({ x: 12, y: 18 });
  });
});

function destinations(
  count: number,
  pointFor: (index: number) => { x: number; y: number }
) {
  const values: WorldMapDestination[] = Array.from({ length: count }, (_, index) => ({
    kind: "city",
    id: `city-${String(index).padStart(2, "0")}`,
    name: `City ${index}`,
    lat: index,
    lon: index
  }));
  const points = new Map(values.map((destination, index) => [destination.id, pointFor(index)]));
  return {
    values,
    project: (destination: WorldMapDestination) => points.get(destination.id)!
  };
}

describe("pinned destinations", () => {
  it("never absorbs a pinned hub into a cluster", () => {
    const at = (id: string, extra: object = {}) =>
      ({ kind: "city", id, name: id, lat: 0, lon: 0, ...extra }) as never;
    const hub = at("hub", { featured: "capital" });
    const clusters = clusterWorldMapDestinations(
      [hub, at("a"), at("b")],
      () => ({ x: 10, y: 10 }),
      undefined,
      (destination) => Boolean((destination as { featured?: string }).featured)
    );
    expect(clusters.map((cluster) => cluster.destinations.length).sort()).toEqual([1, 2]);
    expect(clusters.find((cluster) => cluster.destinations.length === 1)!.destinations[0]).toBe(hub);
  });
});
