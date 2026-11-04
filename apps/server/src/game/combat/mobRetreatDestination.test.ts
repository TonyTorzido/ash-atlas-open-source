import { describe, expect, it, vi } from "vitest";

import { distanceMeters } from "@ash-atlas/shared";
import {
  deterministicBearing,
  findValidOceanRetreatDestination
} from "./mobRetreatDestination.js";

const anchor = { lat: 35.0844, lon: -106.6504 };

describe("ocean mob retreat destinations", () => {
  it("selects a deterministic fully ocean route near the requested radius", async () => {
    const lookup = vi.fn(async (points: readonly unknown[]) => points.map(() => ({
      ok: true,
      surfaceKind: "water" as const,
      isLand: false,
      isSaltwater: true
    })));
    const first = await findValidOceanRetreatDestination({
      entityId: "jellyfish:one",
      anchor,
      distanceM: 650,
      retreatIndex: 1,
      lookup
    });
    const second = await findValidOceanRetreatDestination({
      entityId: "jellyfish:one",
      anchor,
      distanceM: 650,
      retreatIndex: 1,
      lookup
    });
    const finalStage = await findValidOceanRetreatDestination({
      entityId: "jellyfish:one",
      anchor,
      distanceM: 650,
      retreatIndex: 2,
      lookup
    });

    expect(first).toEqual(second);
    expect(finalStage).not.toEqual(first);
    expect(distanceMeters(anchor, first!)).toBeCloseTo(650, 0);
    expect(distanceMeters(anchor, finalStage!)).toBeCloseTo(650, 0);
    expect(lookup.mock.calls[0]![0]).toHaveLength(208);
    expect(deterministicBearing("jellyfish:one")).toBeGreaterThanOrEqual(0);
    expect(deterministicBearing("jellyfish:one")).toBeLessThan(360);
  });

  it("rejects bounded candidates instead of placing an aquatic mob on land", async () => {
    const result = await findValidOceanRetreatDestination({
      entityId: "jellyfish:landlocked",
      anchor,
      distanceM: 650,
      retreatIndex: 1,
      lookup: async (points) => points.map(() => ({
        ok: true,
        surfaceKind: "land" as const,
        isLand: true,
        isSaltwater: false
      }))
    });

    expect(result).toBeNull();
  });
});
