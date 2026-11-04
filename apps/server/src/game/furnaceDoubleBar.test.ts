import { metallurgyDoubleBarChance } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { furnaceBarYield } from "./furnaces.js";

describe("Metallurgy double-bar chance", () => {
  it("steps 0 / 16 / 34 / 52 percent at ranks 2, 5 and 8", () => {
    expect([0, 1, 2, 4, 5, 7, 8].map(metallurgyDoubleBarChance)).toEqual([0, 0, 0.16, 0.16, 0.34, 0.34, 0.52]);
  });

  it("never doubles below rank 2 and is stable for the same unit", () => {
    for (let unit = 1; unit <= 200; unit += 1) expect(furnaceBarYield(1, "job-a", unit)).toBe(1);
    expect(furnaceBarYield(8, "job-a", 3)).toBe(furnaceBarYield(8, "job-a", 3));
  });

  it("doubles about the configured share of units", () => {
    for (const [rank, chance] of [[2, 0.16], [5, 0.34], [8, 0.52]] as const) {
      let doubled = 0;
      for (let unit = 1; unit <= 4_000; unit += 1) if (furnaceBarYield(rank, "job-b", unit) === 2) doubled += 1;
      expect(doubled / 4_000).toBeGreaterThan(chance - 0.04);
      expect(doubled / 4_000).toBeLessThan(chance + 0.04);
    }
  });
});
