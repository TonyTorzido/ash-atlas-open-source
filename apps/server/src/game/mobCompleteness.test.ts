import {
  CREATURE_BOOK_EXCLUDED_ARCHETYPES,
  CREATURE_BOOK_HABITATS,
  CREATURE_BOOK_ROSTER,
  LEGEND_CATALOG,
  MATCHUP_ARMOR_TYPES,
  MATCHUP_WEAPON_TYPES,
  MOB_ARCHETYPE_KEYS,
  MOB_MATCHUPS,
  MOB_SPAWN_RULES,
  MOB_TIER_DAMAGE_MULTIPLIERS,
  mobChallengeTier,
  mobTemplateOf,
  UNIVERSAL_FOOD_BY_MOB,
  universalFoodForMob,
  type MobArchetypeKey
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  MOB_AI_PROFILES,
  MOB_DEFINITIONS,
  MOB_TARGET_BASIC_HIT_COUNTS,
  resolveMobCombatProfile
} from "./combat/mobDefinitions.js";
import {
  NON_POPULATION_V2_MOB_ARCHETYPES,
  POPULATION_V2_RUNTIME_MOB_ARCHETYPES
} from "./populationV2MobRegistry.js";

/**
 * Non-boss archetypes allowed a damage multiplier other than 1 outside the
 * tier rule (MOB_TIER_DAMAGE_MULTIPLIERS: 1.25 at tier 4, 1.5 at tier 5).
 * Everyone else sets difficulty with level and hit count.
 */
const ELITE_MULTIPLIER_ARCHETYPES: Readonly<Partial<Record<MobArchetypeKey, string>>> = {
  jellyfish: "Miniboss whose Poison and Shade mechanics deal the damage",
  mysterious_traveler: "Elite wanderer"
};

const rosterByKey = new Map<string, (typeof CREATURE_BOOK_ROSTER)[number]>(
  CREATURE_BOOK_ROSTER.map((entry) => [entry.archetypeKey, entry])
);
const populationArchetypes = new Set<string>(POPULATION_V2_RUNTIME_MOB_ARCHETYPES);
const legendIds = new Set(LEGEND_CATALOG.map(({ id }) => id));

// One block per archetype so a failure names the mob and the missing piece.
describe.each(MOB_ARCHETYPE_KEYS.map((key) => [key]))("mob %s is fully wired", (key) => {
  const definition = MOB_DEFINITIONS[key];

  it("has a combat definition, AI profile and rewards", () => {
    expect(definition, `${key}: add it to MOB_DEFINITIONS`).toBeDefined();
    expect(definition.key, `${key}: MOB_DEFINITIONS.${key}.key must be "${key}"`).toBe(key);
    expect(definition.name.trim(), `${key}: needs a display name`).not.toBe("");
    expect(MOB_AI_PROFILES[key], `${key}: add it to MOB_AI_PROFILES`).toBeDefined();
    expect(definition.rewards.gold, `${key}: gold reward must be >= 0`).toBeGreaterThanOrEqual(0);
    expect(definition.rewards.cityCoins, `${key}: city coin reward must be >= 0`).toBeGreaterThanOrEqual(0);
    if (key === "training_dummy") return;
    const food = universalFoodForMob(key);
    expect(Object.hasOwn(UNIVERSAL_FOOD_BY_MOB, key), `${key}: add it to UNIVERSAL_FOOD_BY_MOB`).toBe(true);
    if (food === null) {
      // Only a template mob may go without food (its template's food would be another creature's meat).
      expect(mobTemplateOf(key), `${key}: only a template mob may have no food`).not.toBeNull();
      expect(definition.rewards.chanceItems.some(({ rollId }) => rollId === "universal_food"), `${key}: has no food`).toBe(false);
      return;
    }
    expect(
      definition.rewards.chanceItems.some(({ itemId }) => itemId === food!.itemId),
      `${key}: rewards.chanceItems must include universalFoodReward("${key}")`
    ).toBe(true);
  });

  it("has a universal matchup; multipliers only for bosses, elites and tiers 4-5", () => {
    const matchup = MOB_MATCHUPS[key];
    expect(matchup, `${key}: add it to MOB_MATCHUPS`).toBeDefined();
    expect(MATCHUP_WEAPON_TYPES, `${key}: unknown weapon type ${matchup.weaponType}`).toContain(matchup.weaponType);
    expect(MATCHUP_ARMOR_TYPES, `${key}: unknown armor type ${matchup.armorType}`).toContain(matchup.armorType);
    if (matchup.damageMultiplier !== 1) {
      expect(
        definition.boss === true || key in ELITE_MULTIPLIER_ARCHETYPES
          || matchup.damageMultiplier === MOB_TIER_DAMAGE_MULTIPLIERS[mobChallengeTier(definition.level)],
        `${key}: damage multiplier ${matchup.damageMultiplier} needs boss: true, a reviewed elite entry, or its tier's multiplier (1.25 at tier 4, 1.5 at tier 5); use level and hit count for difficulty`
      ).toBe(true);
    }
  });

  it("has a target hit count that yields positive health", () => {
    const hits = MOB_TARGET_BASIC_HIT_COUNTS[key];
    expect(Number.isInteger(hits) && hits > 0, `${key}: MOB_TARGET_BASIC_HIT_COUNTS needs a positive integer`).toBe(true);
    expect(resolveMobCombatProfile(key, definition.level).maxHealth, `${key}: resolved health must be positive`)
      .toBeGreaterThan(0);
  });

  it("is spawned by Population V2 or says which system spawns it", () => {
    const registered = populationArchetypes.has(key);
    const excluded = Object.hasOwn(NON_POPULATION_V2_MOB_ARCHETYPES, key);
    expect(
      registered !== excluded,
      registered
        ? `${key}: is in both POPULATION_V2_MOB_DEFINITIONS and NON_POPULATION_V2_MOB_ARCHETYPES`
        : `${key}: register it in POPULATION_V2_MOB_DEFINITIONS or list it in NON_POPULATION_V2_MOB_ARCHETYPES`
    ).toBe(true);
  });

  it("is in the Creature Book with habitat (and hunts when named), or explicitly excluded", () => {
    const entry = rosterByKey.get(key);
    const excluded = Object.hasOwn(CREATURE_BOOK_EXCLUDED_ARCHETYPES, key);
    expect(
      Boolean(entry) !== excluded,
      entry
        ? `${key}: is in both CREATURE_BOOK_ROSTER and CREATURE_BOOK_EXCLUDED_ARCHETYPES`
        : `${key}: add it to CREATURE_BOOK_ROSTER or CREATURE_BOOK_EXCLUDED_ARCHETYPES`
    ).toBe(true);
    if (!entry) return;
    // Hunts are optional per species (added on the owner's request); a named species has all three.
    if (legendIds.has(`legend_hunt_${key}_1`)) {
      for (const tier of [2, 3]) {
        expect(legendIds.has(`legend_hunt_${key}_${tier}`), `${key}: needs all three huntNames in legendCatalog.ts`).toBe(true);
      }
    }
    // A mob with no overworld spawn rule has no habitat to show.
    if (entry.habitatThreshold !== null && Object.hasOwn(MOB_SPAWN_RULES, key)) {
      const habitats = (CREATURE_BOOK_HABITATS as Readonly<Record<string, readonly unknown[]>>)[key];
      expect(habitats?.length ?? 0, `${key}: add it to CREATURE_BOOK_HABITATS`).toBeGreaterThan(0);
    }
  });
});
