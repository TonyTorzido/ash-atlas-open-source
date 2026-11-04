import { describe, expect, it } from "vitest";

import {
  KITCHEN_BUILD_COST,
  KITCHEN_BUILD_DURATION_MS,
  KITCHEN_MAX_BATCH_SIZE,
  KITCHEN_MIN_BATCH_SIZE,
  KITCHEN_PROCESS_DURATION_MS,
  KITCHEN_QUEUE_CAPACITY,
  KITCHEN_RECIPES,
  KITCHEN_RECIPE_IDS,
  kitchenOutputQuantity
} from "./kitchen.js";
import { UNIVERSAL_FOOD_ITEMS, UNIVERSAL_FOOD_ITEM_IDS } from "./universalFood.js";

describe("Kitchen simple-food economy contract", () => {
  it("uses a bounded shared outdoor station", () => {
    expect(KITCHEN_BUILD_COST).toEqual({ wood: 25, stone: 10 });
    expect(KITCHEN_BUILD_DURATION_MS).toBe(30_000);
    expect(KITCHEN_PROCESS_DURATION_MS).toBe(5_000);
    expect(KITCHEN_MIN_BATCH_SIZE).toBe(10);
    expect(KITCHEN_MAX_BATCH_SIZE).toBe(50);
    expect(KITCHEN_QUEUE_CAPACITY).toBe(5);
  });

  it("offers only current ingredients and preserves the freshwater batch contract", () => {
    expect(KITCHEN_RECIPE_IDS).not.toContain("deer_meat");
    expect(KITCHEN_RECIPE_IDS).not.toContain("wild_meat");
    for (const recipe of [KITCHEN_RECIPES.freshwater_fish]) {
      expect(recipe.inputPerOutput).toBe(10);
      expect(recipe.outputPerBatch).toBe(1);
      expect(recipe.outputItemId).toBe("simple_food");
      expect(kitchenOutputQuantity(recipe.recipeId, 10)).toBe(1);
      expect(kitchenOutputQuantity(recipe.recipeId, 50)).toBe(5);
    }
    for (const itemId of UNIVERSAL_FOOD_ITEM_IDS) {
      const recipe = KITCHEN_RECIPES[itemId];
      expect(recipe).toMatchObject({
        inputItemId: itemId,
        inputPerOutput: 1,
        outputPerBatch: UNIVERSAL_FOOD_ITEMS[itemId].kitchenYield,
        minimumQuantity: 1,
        maximumQuantity: 50,
        outputItemId: "simple_food"
      });
      expect(kitchenOutputQuantity(itemId, 1)).toBe(UNIVERSAL_FOOD_ITEMS[itemId].kitchenYield);
    }
    expect(KITCHEN_RECIPES.small_catch).toMatchObject({
      inputItemId: "small_catch",
      outputPerBatch: 2
    });
    expect(KITCHEN_RECIPES.elemental_ration).toMatchObject({
      inputItemId: "elemental_ration",
      outputPerBatch: 20
    });
  });

  it("rejects quantities outside the exact batch contract", () => {
    expect(() => kitchenOutputQuantity("freshwater_fish", 9)).toThrow();
    expect(() => kitchenOutputQuantity("freshwater_fish", 11)).toThrow(/multiple of 10/iu);
    expect(() => kitchenOutputQuantity("freshwater_fish", 51)).toThrow();
    expect(() => kitchenOutputQuantity("freshwater_fish", Number.NaN)).toThrow();
    expect(kitchenOutputQuantity("frog_legs", 50)).toBe(50);
  });
});
