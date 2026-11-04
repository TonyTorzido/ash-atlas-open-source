import { describe, expect, it } from "vitest";

import {
  clampHungerForOrdinaryWrite,
  HUNGER_BASE_CAPACITY,
  hungerSnapshot
} from "./hunger.js";

describe("hunger foundation", () => {
  it("uses the shared 2,000 base capacity and clamps ordinary writes", () => {
    expect(HUNGER_BASE_CAPACITY).toBe(2_000);
    expect(clampHungerForOrdinaryWrite(-20)).toBe(0);
    expect(clampHungerForOrdinaryWrite(2_001)).toBe(HUNGER_BASE_CAPACITY);
    expect(clampHungerForOrdinaryWrite(Number.NaN)).toBe(HUNGER_BASE_CAPACITY);
  });

  it("preserves an explicit future over-cap projection", () => {
    expect(hungerSnapshot(2_500, 2_000)).toEqual({
      current: 2_500,
      baseCapacity: HUNGER_BASE_CAPACITY
    });
  });
});
