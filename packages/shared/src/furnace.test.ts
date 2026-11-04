import { describe, expect, it } from "vitest";

import {
  FURNACE_BAR_DURATION_MS,
  FURNACE_BUILD_COST,
  completedFurnaceBars,
  furnaceRecipe,
  furnaceRecipeInputs,
  requireFurnaceRecipe,
  slagRecoveryCostForMetallurgyRank
} from "./furnace.js";

describe("furnace smelting rules", () => {
  it("defines the Furnace construction cost", () => {
    expect(FURNACE_BUILD_COST).toEqual({ stone: 22, wood: 90, coal: 12 });
  });

  it("scales cost and duration for batches of one through five", () => {
    expect(furnaceRecipe(1)).toEqual({
      ironOre: 6,
      wood: 90,
      durationMs: FURNACE_BAR_DURATION_MS
    });
    expect(furnaceRecipe(5)).toEqual({
      ironOre: 30,
      wood: 450,
      durationMs: 5 * FURNACE_BAR_DURATION_MS
    });
  });

  it("completes bars sequentially at inclusive twenty-seven-minute boundaries", () => {
    const startedAt = 1_000;
    expect(completedFurnaceBars(startedAt, 3, startedAt + FURNACE_BAR_DURATION_MS - 1)).toBe(0);
    expect(completedFurnaceBars(startedAt, 3, startedAt + FURNACE_BAR_DURATION_MS)).toBe(1);
    expect(completedFurnaceBars(startedAt, 3, startedAt + 2 * FURNACE_BAR_DURATION_MS)).toBe(2);
    expect(completedFurnaceBars(startedAt, 3, startedAt + 8 * FURNACE_BAR_DURATION_MS)).toBe(3);
  });

  it("defines the per-bar metal recipes", () => {
    expect(furnaceRecipeInputs("fire_bar", 1)).toEqual([
      { itemId: "fire_feather", displayName: "Ember Feather", quantity: 1 },
      { itemId: "pearl", displayName: "Pearl", quantity: 3 },
      { itemId: "coal", displayName: "Coal", quantity: 24 },
      { itemId: "iron_bar", displayName: "Iron Bar", quantity: 9 }
    ]);
    expect(furnaceRecipeInputs("lightning_bar", 2)).toEqual([
      { itemId: "tempest_quill", displayName: "Tempest Quill", quantity: 2 },
      { itemId: "forge_spark", displayName: "Forge Spark", quantity: 270 },
      { itemId: "iron_bar", displayName: "Iron Bar", quantity: 18 }
    ]);
    expect(requireFurnaceRecipe("ice_bar").minimumMetallurgyRank).toBe(5);
    expect(requireFurnaceRecipe("ice_bar").completionMode).toBe("sequential");
  });

  it("uses rank-aware Slag recovery costs", () => {
    expect(slagRecoveryCostForMetallurgyRank(0)).toBeNull();
    expect(slagRecoveryCostForMetallurgyRank(2)).toBe(5);
    expect(slagRecoveryCostForMetallurgyRank(5)).toBe(4);
    expect(slagRecoveryCostForMetallurgyRank(8)).toBe(3);
    expect(furnaceRecipeInputs("slag_recovery", 1)).toEqual([
      { itemId: "slag", displayName: "Slag", quantity: 5 }
    ]);
    expect(furnaceRecipeInputs("slag_recovery", 1, { metallurgyRank: 2 })).toEqual([
      { itemId: "slag", displayName: "Slag", quantity: 5 }
    ]);
  });
});
