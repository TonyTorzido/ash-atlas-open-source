import { describe, expect, it } from "vitest";

import { simpleFoodHungerResult, SimpleFoodService } from "./simpleFood.js";

describe("Simple Food hunger restoration", () => {
  it("restores 100 hunger for an ordinary write", () => {
    expect(simpleFoodHungerResult(0)).toEqual({
      hungerBefore: 0,
      hungerAfter: SimpleFoodService.RESTORATION_QUANTITY,
      restoredQuantity: SimpleFoodService.RESTORATION_QUANTITY
    });
    expect(simpleFoodHungerResult(1_000)).toMatchObject({
      hungerBefore: 1_000,
      hungerAfter: 1_100,
      restoredQuantity: 100
    });
  });

  it("caps a partial restoration at the ordinary 2,000 capacity", () => {
    expect(simpleFoodHungerResult(1_950)).toEqual({
      hungerBefore: 1_950,
      hungerAfter: 2_000,
      restoredQuantity: 50
    });
  });

  it("reports no restoration at a full or over-cap persisted value", () => {
    expect(simpleFoodHungerResult(2_000).restoredQuantity).toBe(0);
    expect(simpleFoodHungerResult(2_500).restoredQuantity).toBe(0);
    expect(simpleFoodHungerResult(Number.NaN).restoredQuantity).toBe(0);
  });
});
