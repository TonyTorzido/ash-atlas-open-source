import { WORLD_EDGE_MAX_ABS_LATITUDE } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { WORLD_EDGE_FOG } from "./worldEdgeFog.js";

function bands(sign: 1 | -1) {
  return WORLD_EDGE_FOG.features
    .map((feature) => {
      const lats = feature.geometry.coordinates[0]!.map((position) => position[1]!);
      return {
        from: Math.min(...lats.map(Math.abs)),
        to: Math.max(...lats.map(Math.abs)),
        south: lats.every((lat) => lat < 0),
        opacity: feature.properties?.opacity as number
      };
    })
    .filter((band) => band.south === (sign < 0))
    .sort((left, right) => left.from - right.from);
}

describe.each([1, -1] as const)("world edge fog (hemisphere %i)", (sign) => {
  it("fades in before the edge and fully fogs everything past it", () => {
    const hemisphere = bands(sign);
    expect(hemisphere.length).toBeGreaterThan(2);
    for (let index = 1; index < hemisphere.length; index += 1) {
      expect(hemisphere[index]!.from).toBeCloseTo(hemisphere[index - 1]!.to, 9);
      expect(hemisphere[index]!.opacity).toBeGreaterThan(hemisphere[index - 1]!.opacity);
    }
    const cap = hemisphere.at(-1)!;
    expect(cap).toMatchObject({ from: WORLD_EDGE_MAX_ABS_LATITUDE, to: 90, opacity: 1 });
    expect(hemisphere[0]!.from).toBeLessThan(WORLD_EDGE_MAX_ABS_LATITUDE);
  });
});
