import {
  BACKPACK_DEFINITIONS,
  EQUIPMENT_DEFINITIONS,
  MAX_EQUIPMENT_LEVEL,
  RETIRED_RESOURCE_TYPES,
  RESOURCE_TYPES,
  TANNERY_RECIPES
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  GOBLIN_MARKET_RESOURCE_UNIT_PRICES,
  goblinMarketBackpackOfferGold,
  goblinMarketEquipmentOfferGold,
  goblinMarketResourceOfferGold
} from "./goblinMarketPricing.js";

/** Resources with no Goblin Market price row; the market refuses them as "not sold". */
const UNPRICED_RESOURCES: readonly string[] = ["bone", "bricks", "crystal", "fertilizer", "flux_plant", "giving_berry", "pearl", "survey_stake_kit", "compass", "ring_shard", "forge_spark", "shard_grit", "amulet_clasp"];

describe("Goblin Market pricing", () => {
  it("returns exact resource stack offers and rejects invalid quantities", () => {
    for (const resourceType of [
      "fire_feather",
      "tempest_quill",
      "ice_feather",
      "fire_bar",
      "fire_core",
      "lightning_bar",
      "lightning_core",
      "ice_bar",
      "ice_core"
    ] as const) {
      expect(goblinMarketResourceOfferGold(resourceType, 1)).toBe("1000");
    }
    expect(goblinMarketResourceOfferGold("wood", 7)).toBe("7");
    expect(goblinMarketResourceOfferGold("chitin", 1)).toBe("2");
    expect(goblinMarketResourceOfferGold("flax_fiber", 2)).toBe("2");
    expect(goblinMarketResourceOfferGold("cloth", 1)).toBe("2");
    expect(Number(goblinMarketResourceOfferGold("cloth", 1)))
      .toBeLessThanOrEqual(Number(goblinMarketResourceOfferGold("flax_fiber", 2)));
    expect(() => goblinMarketResourceOfferGold("shell", 1)).toThrow(/legacy shell/i);
    expect(() => goblinMarketResourceOfferGold("repair_kit", 1)).toThrow(/not sold/i);
    expect(() => goblinMarketResourceOfferGold("wood", 0)).toThrow();
    expect(() => goblinMarketResourceOfferGold("wood", 1.5)).toThrow();
    expect(() => goblinMarketResourceOfferGold(
      "fire_feather",
      Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1
    )).toThrow();
  });

  it("prices every canonical resource at a positive safe integer", () => {
    for (const resourceType of RESOURCE_TYPES.filter((itemId) =>
      itemId !== "torch" && itemId !== "shovel" && itemId !== "raw_meat" && itemId !== "simple_food" && itemId !== "slag" &&
      itemId !== "freshwater_fish" &&
      itemId !== "ashen_fish" &&
      itemId !== "refined_oil" &&
      itemId !== "lumen" &&
      !UNPRICED_RESOURCES.includes(itemId) &&
      !itemId.endsWith("_carcass")
      && !RETIRED_RESOURCE_TYPES.includes(itemId as typeof RETIRED_RESOURCE_TYPES[number])
    )) {
      const price = GOBLIN_MARKET_RESOURCE_UNIT_PRICES[resourceType];
      expect(Number.isSafeInteger(price)).toBe(true);
      expect(price).toBeGreaterThan(0);
    }
    expect(() => goblinMarketResourceOfferGold("torch", 1)).toThrow(/not sold/i);
    for (const itemId of UNPRICED_RESOURCES) {
      expect(() => goblinMarketResourceOfferGold(itemId as never, 1)).toThrow(/not sold/i);
    }
    expect(() => goblinMarketResourceOfferGold("raw_meat", 1)).toThrow(/legacy raw meat/i);
    expect(() => goblinMarketResourceOfferGold("simple_food", 1)).toThrow(/simple food/i);
    expect(() => goblinMarketResourceOfferGold("slag", 1)).toThrow(/slag/i);
    expect(() => goblinMarketResourceOfferGold("deer_carcass", 1)).toThrow(/not sold/i);
    expect(() => goblinMarketResourceOfferGold("freshwater_fish", 1)).toThrow(/freshwater fish/i);
    expect(() => goblinMarketResourceOfferGold("ashen_fish", 1)).toThrow(/freshwater fish/i);
    // Glimmer Oil costs real-money Glimmer; an NPC price would mint gold from it.
    expect(GOBLIN_MARKET_RESOURCE_UNIT_PRICES.refined_oil).toBeUndefined();
    expect(() => goblinMarketResourceOfferGold("refined_oil", 1)).toThrow(/glimmer oil is not sold/i);
    // Lumen is premium currency; the Goblin Market never turns it into gold.
    expect(() => goblinMarketResourceOfferGold("lumen", 1)).toThrow(/not sold/i);
    expect(goblinMarketResourceOfferGold("squid_flesh", 1)).toBe("5");
    expect(goblinMarketResourceOfferGold("squid_meat", 2)).toBe("20");
    expect(goblinMarketResourceOfferGold("deer_meat", 4)).toBe("16");
    expect(GOBLIN_MARKET_RESOURCE_UNIT_PRICES.wheat_seed).toBe(10);
    expect(goblinMarketResourceOfferGold("wheat_seed", 3)).toBe("30");
  });

  it("keeps rare-hide Goblin floors equal to optional Leather conversion value", () => {
    for (const recipe of Object.values(TANNERY_RECIPES)) {
      expect(GOBLIN_MARKET_RESOURCE_UNIT_PRICES[recipe.inputItemId]).toBe(
        recipe.outputPerInput * GOBLIN_MARKET_RESOURCE_UNIT_PRICES.leather!
      );
      expect(goblinMarketResourceOfferGold(recipe.inputItemId, 1)).toBe(
        String(recipe.outputPerInput * GOBLIN_MARKET_RESOURCE_UNIT_PRICES.leather!)
      );
    }
  });

  it("prices every equipment definition at levels 0 and 25 with upgrade recovery", () => {
    for (const definition of Object.values(EQUIPMENT_DEFINITIONS)) {
      const levelZero = Number(goblinMarketEquipmentOfferGold({
        definitionId: definition.definitionId,
        itemLevel: 0,
        enchantmentIdentity: null
      }));
      const levelTwentyFive = Number(goblinMarketEquipmentOfferGold({
        definitionId: definition.definitionId,
        itemLevel: 25,
        enchantmentIdentity: null
      }));
      expect(Number.isSafeInteger(levelZero)).toBe(true);
      expect(levelZero).toBeGreaterThan(0);
      expect(levelTwentyFive).toBeGreaterThan(levelZero);
    }
  });

  it("prices every backpack below its canonical Gold cost", () => {
    for (const definition of Object.values(BACKPACK_DEFINITIONS)) {
      const offer = Number(goblinMarketBackpackOfferGold(definition));
      expect(Number.isSafeInteger(offer)).toBe(true);
      expect(offer).toBeGreaterThan(0);
      expect(offer).toBeLessThan(definition.cost.gold);
    }
  });

  it("recovers ten percent of paid upgrades and adds enchantment value", () => {
    expect(goblinMarketEquipmentOfferGold({
      definitionId: "starter_sword",
      itemLevel: 2,
      enchantmentIdentity: null
    })).toBe("32");
    expect(goblinMarketEquipmentOfferGold({
      definitionId: "starter_sword",
      itemLevel: 2,
      enchantmentIdentity: "enh:v1:ruby:fire"
    })).toBe("282");
  });

  it("rejects equipment levels outside the authoritative range", () => {
    expect(() => goblinMarketEquipmentOfferGold({
      definitionId: "starter_sword",
      itemLevel: -1,
      enchantmentIdentity: null
    })).toThrow();
    expect(() => goblinMarketEquipmentOfferGold({
      definitionId: "starter_sword",
      itemLevel: MAX_EQUIPMENT_LEVEL + 1,
      enchantmentIdentity: null
    })).toThrow();
  });
});
