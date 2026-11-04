import { artificerBulkBonusItems, artificerCraftDurationMs, artificerCraftTimeReductionPercent } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

describe("Artificer crafting", () => {
  it("cuts crafting time 9/18/28 percent at ranks 2/4/5 and never below 1 ms", () => {
    expect([0, 1, 2, 3, 4, 5].map(artificerCraftTimeReductionPercent)).toEqual([0, 0, 9, 9, 18, 28]);
    expect([1, 2, 3, 4, 5].map((rank) => artificerCraftDurationMs(100_000, rank))).toEqual([100_000, 91_000, 91_000, 82_000, 72_000]);
    expect(artificerCraftDurationMs(1, 5)).toBeGreaterThanOrEqual(1);
    expect(artificerCraftDurationMs(0, 5)).toBe(1);
  });

  it("adds +1 bonus item per 6 crafted at ranks 3-4 and per 4 at rank 5, never negative", () => {
    expect([0, 6, 7, 14, 49].map((quantity) => artificerBulkBonusItems(quantity, 3))).toEqual([0, 1, 1, 2, 8]);
    expect([4, 5, 10, 49].map((quantity) => artificerBulkBonusItems(quantity, 5))).toEqual([1, 1, 2, 12]);
    expect(artificerBulkBonusItems(100, 2)).toBe(0);
    expect(artificerBulkBonusItems(100, 0)).toBe(0);
    expect(artificerBulkBonusItems(-5, 5)).toBe(0);
    expect(artificerBulkBonusItems(Number.NaN, 5)).toBe(0);
  });
});
