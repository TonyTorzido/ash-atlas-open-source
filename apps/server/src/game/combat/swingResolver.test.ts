import { describe, expect, it } from "vitest";

import { destinationPoint, SWING_MAX_TARGETS, SWING_RANGE_M, type LatLon } from "@ash-atlas/shared";
import {
  createSwingTargetScratch,
  offerSwingTarget,
  selectSwingTargets,
  type SwingCandidateReader
} from "./swingResolver.js";

const origin = { lat: 35.0844, lon: -106.6504 };

function readerFor(positions: Record<string, LatLon & { radiusM?: number; skip?: boolean }>): SwingCandidateReader {
  return (id, out) => {
    const position = positions[id];
    if (!position || position.skip) return false;
    out.lat = position.lat;
    out.lon = position.lon;
    out.radiusM = position.radiusM ?? 20;
    return true;
  };
}

describe("offerSwingTarget", () => {
  it("keeps the nearest N in order without sorting", () => {
    const scratch = createSwingTargetScratch(4);
    const offers: Array<[string, number]> = [["e", 50], ["a", 10], ["f", 60], ["c", 30], ["b", 20], ["d", 40]];
    for (const [id, distance] of offers) offerSwingTarget(scratch, id, distance);
    expect(scratch.count).toBe(4);
    expect(scratch.ids.slice(0, scratch.count)).toEqual(["a", "b", "c", "d"]);
    expect([...scratch.distancesM]).toEqual([10, 20, 30, 40]);
  });

  it("keeps the earlier offer first on a tie", () => {
    const scratch = createSwingTargetScratch(2);
    offerSwingTarget(scratch, "x", 5);
    offerSwingTarget(scratch, "y", 5);
    offerSwingTarget(scratch, "z", 5);
    expect(scratch.ids).toEqual(["x", "y"]);
  });
});

describe("selectSwingTargets", () => {
  it("hits in the arc, misses behind, hits point blank, and caps at the nearest N (cleave raised to four)", () => {
    const at = (distanceM: number, bearing: number) => destinationPoint(origin, distanceM, bearing);
    const positions = {
      front30: at(30, 90),
      front60: at(60, 95),
      front90: at(90, 80),
      front100: at(100, 90),
      front105: at(105, 90),
      behind: at(60, 270),
      pointBlank: at(15, 270),
      far: at(140, 90),
      skipped: { ...at(20, 90), skip: true }
    };
    const scratch = createSwingTargetScratch(4);
    const count = selectSwingTargets(
      origin.lat, origin.lon, 1, 0, Object.keys(positions), readerFor(positions), scratch
    );
    expect(count).toBe(4);
    expect(scratch.ids.slice(0, count)).toEqual(["pointBlank", "front30", "front60", "front90"]);
  });

  it("hits only the single nearest target by default, point blank included", () => {
    const at = (distanceM: number, bearing: number) => destinationPoint(origin, distanceM, bearing);
    const scratch = createSwingTargetScratch();
    expect(SWING_MAX_TARGETS).toBe(1);
    const ahead = { front30: at(30, 90), front60: at(60, 95), front90: at(90, 80) };
    expect(selectSwingTargets(origin.lat, origin.lon, 1, 0, Object.keys(ahead), readerFor(ahead), scratch)).toBe(1);
    expect(scratch.ids[0]).toBe("front30");
    const withBlank = { ...ahead, pointBlank: at(15, 270) };
    expect(selectSwingTargets(origin.lat, origin.lon, 1, 0, Object.keys(withBlank), readerFor(withBlank), scratch)).toBe(1);
    expect(scratch.ids[0]).toBe("pointBlank");
  });

  it("picks the nearest by edge, so a big boss in reach beats a smaller mob behind its edge", () => {
    const positions = { boss: { ...destinationPoint(origin, 70, 90), radiusM: 40 }, mob: destinationPoint(origin, 60, 90) };
    const scratch = createSwingTargetScratch();
    expect(selectSwingTargets(origin.lat, origin.lon, 1, 0, ["mob", "boss"], readerFor(positions), scratch)).toBe(1);
    expect(scratch.ids[0]).toBe("boss");
  });

  it("reaches a large target whose edge is in range", () => {
    const positions = { boss: { ...destinationPoint(origin, SWING_RANGE_M + 35, 90), radiusM: 40 } };
    const scratch = createSwingTargetScratch();
    expect(selectSwingTargets(origin.lat, origin.lon, 1, 0, ["boss"], readerFor(positions), scratch)).toBe(1);
    const small = { mob: destinationPoint(origin, SWING_RANGE_M + 35, 90) };
    expect(selectSwingTargets(origin.lat, origin.lon, 1, 0, ["mob"], readerFor(small), scratch)).toBe(0);
  });
});
