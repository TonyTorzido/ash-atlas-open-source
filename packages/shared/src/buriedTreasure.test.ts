import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { RESOURCE_TYPES } from "./collectibles.js";
import {
  SHOVEL_RECIPE,
  TREASURE_REWARD_TABLES,
  TREASURE_RING_IDS,
  TREASURE_TIERS,
  TREASURE_TIER_REQUIRED_CARTOGRAPHY_RANK,
  rollTreasureRewards,
  treasureTierVisible
} from "./buriedTreasure.js";
import { EQUIPMENT_DEFINITIONS } from "./equipment.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest();

describe("buried treasure visibility gating", () => {
  it("shows bronze to everyone and gates silver and gold by Cartography rank", () => {
    expect(treasureTierVisible("bronze", 0)).toBe(true);
    expect(treasureTierVisible("silver", 1)).toBe(false);
    expect(treasureTierVisible("silver", 2)).toBe(true);
    expect(treasureTierVisible("gold", 2)).toBe(false);
    expect(treasureTierVisible("gold", 3)).toBe(true);
    expect(treasureTierVisible("gold", Number.NaN)).toBe(false);
    expect(TREASURE_TIER_REQUIRED_CARTOGRAPHY_RANK).toEqual({ bronze: 0, silver: 2, gold: 3 });
  });
});

describe("buried treasure rewards", () => {
  it("rolls the same rewards for the same cache and only from existing items", () => {
    const resources = new Set<string>(RESOURCE_TYPES);
    for (const tier of TREASURE_TIERS) {
      for (const entry of TREASURE_REWARD_TABLES[tier]) expect(resources.has(entry.itemId)).toBe(true);
      for (let index = 0; index < 50; index += 1) {
        const seed = `cache-${tier}-${index}`;
        const first = rollTreasureRewards(tier, seed, sha256);
        expect(rollTreasureRewards(tier, seed, sha256)).toEqual(first);
        expect(first.items.length).toBeGreaterThan(0);
        for (const item of first.items) {
          const entry = TREASURE_REWARD_TABLES[tier].find((candidate) => candidate.itemId === item.itemId);
          expect(entry).toBeDefined();
          expect(item.quantity).toBeGreaterThanOrEqual(entry!.min);
        }
      }
    }
    for (const ring of TREASURE_RING_IDS) expect(EQUIPMENT_DEFINITIONS[ring]).toBeDefined();
    for (const entry of SHOVEL_RECIPE) expect(resources.has(entry.itemId)).toBe(true);
  });
});
