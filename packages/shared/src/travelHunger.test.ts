import { describe, expect, it } from "vitest";

import {
  TRAVEL_HUNGER_MAX_COST,
  TRAVEL_HUNGER_MAX_RANGE_M,
  TRAVEL_HUNGER_MIN_COST,
  travelHungerCost
} from "./travelHunger.js";

describe("travel Hunger cost", () => {
  it("rounds up fractional distance shares and clamps the minimum", () => {
    expect(travelHungerCost(0)).toBe(TRAVEL_HUNGER_MIN_COST);
    expect(travelHungerCost(TRAVEL_HUNGER_MAX_RANGE_M / 4)).toBe(25);
    expect(travelHungerCost(TRAVEL_HUNGER_MAX_RANGE_M / 2)).toBe(50);
    expect(travelHungerCost(TRAVEL_HUNGER_MAX_RANGE_M / 3)).toBe(34);
  });

  it("clamps the maximum and never exceeds it for valid distances", () => {
    expect(travelHungerCost(TRAVEL_HUNGER_MAX_RANGE_M)).toBe(TRAVEL_HUNGER_MAX_COST);
    expect(travelHungerCost(TRAVEL_HUNGER_MAX_RANGE_M * 2)).toBe(TRAVEL_HUNGER_MAX_COST);
    for (const distanceM of [0, 1, 123, TRAVEL_HUNGER_MAX_RANGE_M, TRAVEL_HUNGER_MAX_RANGE_M * 4]) {
      expect(travelHungerCost(distanceM)).toBeGreaterThanOrEqual(TRAVEL_HUNGER_MIN_COST);
      expect(travelHungerCost(distanceM)).toBeLessThanOrEqual(TRAVEL_HUNGER_MAX_COST);
    }
  });
});
