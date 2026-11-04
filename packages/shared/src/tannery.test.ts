import { describe, expect, it } from "vitest";

import { INVENTORY_CATALOG } from "./inventoryCatalog.js";
import {
  TANNERY_BUILD_COST,
  TANNERY_BUILD_DURATION_MS,
  TANNERY_MAX_BATCH_SIZE,
  TANNERY_MAX_OUTPUT_QUANTITY,
  TANNERY_PROCESS_DURATION_MS,
  TANNERY_QUEUE_CAPACITY,
  TANNERY_RARE_HIDE_IDS,
  TANNERY_RECIPES,
  tanneryOutputQuantity
} from "./tannery.js";

describe("Tannery economy contract", () => {
  it("uses species-scaled rare-hide Leather jackpots", () => {
    expect(Object.fromEntries(Object.entries(TANNERY_RECIPES).filter(([id]) => (TANNERY_RARE_HIDE_IDS as readonly string[]).includes(id)).map(([id, recipe]) =>
      [id, recipe.outputPerInput]
    ))).toEqual({
      deer_hide: 250,
      hog_hide: 400,
      wolf_pelt: 800,
      bear_hide: 1_200,
      alligator_hide: 1_000
    });
  });

  it("keeps every rare hide collectible and player-market tradable", () => {
    for (const recipe of TANNERY_RARE_HIDE_IDS.map((id) => TANNERY_RECIPES[id]!)) {
      expect(INVENTORY_CATALOG[recipe.inputItemId]).toMatchObject({
        marketTradable: true,
        marketFungible: true,
        marketIdentity: recipe.inputItemId
      });
    }
  });

  it("uses one short whole-batch duration and bounded batches", () => {
    expect(TANNERY_PROCESS_DURATION_MS).toBe(5_000);
    expect(TANNERY_BUILD_DURATION_MS).toBe(30_000);
    expect(TANNERY_MAX_BATCH_SIZE).toBe(25);
    expect(TANNERY_QUEUE_CAPACITY).toBe(5);
    expect(TANNERY_MAX_OUTPUT_QUANTITY).toBe(30_000);
    expect(tanneryOutputQuantity("bear_hide", 25)).toBe(TANNERY_MAX_OUTPUT_QUANTITY);
    expect(tanneryOutputQuantity("deer_hide", 1)).toBe(250);
    expect(() => tanneryOutputQuantity("bear_hide", 26)).toThrow();
  });

  it("uses the modest early-game Wood and Stone build cost", () => {
    expect(TANNERY_BUILD_COST).toEqual({ wood: 25, stone: 10 });
  });
});
