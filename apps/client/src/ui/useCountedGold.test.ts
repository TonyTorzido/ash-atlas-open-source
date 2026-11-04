import { describe, expect, it } from "vitest";

import { interpolateGold, visibleGold } from "./useCountedGold.js";

describe("counted gold", () => {
  it("hides coins still in the air and never goes below zero", () => {
    expect(visibleGold("1000", 22)).toBe(978n);
    expect(visibleGold("10", 22)).toBe(0n);
    expect(visibleGold(null, 5)).toBeNull();
  });

  it("counts up monotonically to the target", () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map((p) => interpolateGold(100n, 122n, p));
    expect(steps[0]).toBe(100n);
    expect(steps.at(-1)).toBe(122n);
    expect(steps).toEqual([...steps].sort((a, b) => Number(a - b)));
  });
});
