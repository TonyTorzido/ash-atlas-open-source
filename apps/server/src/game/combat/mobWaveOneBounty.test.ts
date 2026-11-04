import { describe, expect, it } from "vitest";
import { ANIMAL_MOB_ARCHETYPES, FANTASY_MOB_ARCHETYPES, MOB_MATCHUPS } from "@ash-atlas/shared";

import { MOB_DEFINITIONS } from "./mobDefinitions.js";

// The fantasy mobs that existed before wave 1 (they keep their template drops).
const PRE_WAVE_ONE_FANTASY = new Set([
  "frost_wraith", "yeti", "barrow_wight", "moss_golem", "vine_lurker", "lizardfolk_warrior",
  "bog_ghoul", "giant_scorpion", "dust_mummy", "thunderhorn", "griffin", "basilisk",
  "risen_skeleton", "revenant_lich"
]);
// The water wave came after wave 1 with its own levels (sea band 14-25).
const WATER_WAVE = new Set([
  "shellback", "darter", "ink_pool", "drowned_citizen", "tide_wraith", "gate_warden", "drowned_cultist",
  // Drowned City raid roster (dungeon-only, top challenge tier).
  "tide_wraith_dc", "darter_dc", "ink_pool_dc", "drowned_cultist_dc", "shellback_dc", "coral_golem_dc",
  "drowned_deckhand_dc", "phantom_lookout_dc", "merfolk_harpooner_dc", "gate_warden_dc",
  "void_wisp", "deep_crawler", "maw_lily", "chrono_wisp", "abyssal_cultist",
  // Golem Forge raid roster (dungeon-only, top challenge tier).
  "iron_golem_gf", "stone_golem_gf", "geode_golem_gf", "mender_golem_gf", "sentinel_statue_gf", "spark_wisp_gf", "slag_crawler_gf", "golem_smith_gf", "corrupted_husk_gf", "gem_husk_gf", "walking_hammer_gf", "healer_monolith_gf"
]);
// The overworld bestiary additions came after wave 1 with their own levels and hit counts.
const BESTIARY_WAVE = new Set([
  "dire_wolf", "moss_troll", "woolly_mammoth", "ash_drake", "ember_dragon", "snapjaw_flytrap", "cairn_golem", "giant_larva"
]);
const WAVE_ONE = [
  ...ANIMAL_MOB_ARCHETYPES,
  ...FANTASY_MOB_ARCHETYPES.filter((key) => !PRE_WAVE_ONE_FANTASY.has(key) && !WATER_WAVE.has(key) && !BESTIARY_WAVE.has(key))
] as const;

function tierClass(key: (typeof WAVE_ONE)[number]): "base" | "tier4" | "tier5" {
  const multiplier = MOB_MATCHUPS[key].damageMultiplier;
  return multiplier >= 1.5 ? "tier5" : multiplier >= 1.25 ? "tier4" : "base";
}

describe("wave 1 gold and city coins", () => {
  it("covers all 148 wave 1 and biome roster animals", () => {
    expect(WAVE_ONE).toHaveLength(148);
  });

  it("keeps city coins non-decreasing with level within a tier class", () => {
    // Gold follows kill hits and spawn rarity (the value pass), so only coins stay on the level curve.
    for (const cls of ["base", "tier4", "tier5"] as const) {
      const mobs = WAVE_ONE.filter((key) => tierClass(key) === cls)
        .map((key) => MOB_DEFINITIONS[key])
        .sort((a, b) => a.level - b.level);
      for (let i = 1; i < mobs.length; i += 1) {
        expect(mobs[i]!.rewards.cityCoins ?? 0, `${mobs[i]!.key} vs ${mobs[i - 1]!.key}`)
          .toBeGreaterThanOrEqual(mobs[i - 1]!.rewards.cityCoins ?? 0);
      }
    }
  });

  it("pays every tier 5 mob more than any non-boss mob", () => {
    const tier5 = WAVE_ONE.filter((key) => tierClass(key) === "tier5");
    const others = WAVE_ONE.filter((key) => tierClass(key) !== "tier5");
    expect(tier5.length).toBeGreaterThan(0);
    const richestOther = Math.max(...others.map((key) => MOB_DEFINITIONS[key].rewards.gold));
    for (const key of tier5) {
      expect(MOB_DEFINITIONS[key].rewards.gold, key).toBeGreaterThan(richestOther);
    }
  });

  it("keeps existing mob coins and the gold the value pass left alone", () => {
    const expected = {
      deer: [10, 1], hog: [23, 3], wolf: [15, 2], bear: [60, 4], ogre: [100, 5],
      goblin: [1, 0], frost_wraith: [25, 0], yeti: [60, 4], giant_scorpion: [23, 3], squid: [30, 3]
    } as const;
    for (const [key, [gold, coins]] of Object.entries(expected)) {
      const rewards = MOB_DEFINITIONS[key as keyof typeof MOB_DEFINITIONS].rewards;
      expect([rewards.gold, rewards.cityCoins ?? 0], key).toEqual([gold, coins]);
    }
  });
});
