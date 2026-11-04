import { describe, expect, it } from "vitest";

import {
  combatEquipmentServerMessageSchemas
} from "./protocol/combatEquipmentServerMessageSchemas.js";

const schema = combatEquipmentServerMessageSchemas.COMBAT_REWARD_GRANTED;
const classMasterySchema = combatEquipmentServerMessageSchemas.CLASS_MASTERY_GRANTED;

describe("combat reward wallet protocol", () => {
  it("accepts item-only rewards without a wallet update", () => {
    expect(schema.safeParse(reward()).success).toBe(true);
  });

  it("accepts paired authoritative wallet balance and version for positive Gold", () => {
    expect(schema.safeParse(reward({
      gold: 5,
      walletGold: "52",
      walletVersion: "2"
    })).success).toBe(true);
  });

  it.each([
    { walletGold: "0", walletVersion: "0" },
    { walletGold: "47", walletVersion: "1" },
    { gold: 5 },
    { gold: 5, walletGold: "52" },
    { gold: 5, walletVersion: "2" },
    { gold: 5, walletGold: "0", walletVersion: "2" },
    { gold: 5, walletGold: "52", walletVersion: "0" },
    { gold: 5, walletGold: "invalid", walletVersion: "2" }
  ])("rejects a non-authoritative wallet shape: %o", (override) => {
    expect(schema.safeParse(reward(override)).success).toBe(false);
  });
});

describe("class mastery reward protocol", () => {
  it("requires the authoritative awarded class", () => {
    const message = {
      type: "CLASS_MASTERY_GRANTED",
      eventId: "class-xp:mob:wolf:1:defeat:1:player-1",
      classId: "ranger",
      subclassId: null,
      requestedXp: 12,
      grantedXp: 12,
      replayed: false,
      previousRank: 0,
      resultingRank: 0,
      snapshot: {}
    };
    expect(classMasterySchema.safeParse(message).success).toBe(true);
    expect(classMasterySchema.safeParse({ ...message, classId: "bard" }).success).toBe(false);
    expect(classMasterySchema.safeParse({ ...message, classId: undefined }).success).toBe(false);
  });
});

function reward(overrides: Record<string, unknown> = {}) {
  return {
    type: "COMBAT_REWARD_GRANTED",
    settlementKey: "mob:wolf:1:defeat:1",
    playerId: "player-1",
    items: [{ itemId: "leather", quantity: 1 }],
    drops: [],
    gold: 0,
    inventory: {
      playerId: "player-1",
      revision: 2,
      items: [],
      totals: {
        wood: 0,
        stone: 0,
        coal: 0,
        iron: 0,
        sulfur: 0,
        food: 0,
        ore: 0,
        water: 0,
        leather: 1,
        giving_berry: 0,
        balsam_resin: 0,
        crystal: 0, pearl: 0, atlas_shrine_shard: 0,
        enchantment_stone: 0
      }
    },
    cityCoins: 1,
    cityId: "city-1",
    cityTreasuryBalance: "10",
    cityContribution: "1",
    ...overrides
  };
}
