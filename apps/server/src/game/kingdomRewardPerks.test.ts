import { describe, expect, it } from "vitest";

import { prismHoldingsHit, kingdomRewardPerkRoll } from "./kingdomRewardPerks.js";

describe("kingdom reward perks", () => {
  it("Prism Holdings hits about 1.2% of kills, the same way on every retry", () => {
    const keys = Array.from({ length: 20_000 }, (_, index) => `settlement-${index}:player-1`);
    const hits = keys.filter((key) => prismHoldingsHit(key));
    expect(hits.length).toBeGreaterThan(150);
    expect(hits.length).toBeLessThan(250);
    // Deterministic per settlement and player: a retried settlement rolls the same.
    expect(keys.filter((key) => prismHoldingsHit(key))).toEqual(hits);
    expect(prismHoldingsHit("settlement-1:player-1")).toBe(prismHoldingsHit("settlement-1:player-1"));
    const roll = kingdomRewardPerkRoll("x");
    expect(roll).toBeGreaterThanOrEqual(0);
    expect(roll).toBeLessThan(1);
  });
});
