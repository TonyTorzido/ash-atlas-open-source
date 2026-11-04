import { describe, expect, it } from "vitest";
import {
  BASIC_ATTACK_INTERVAL_MS,
  BASIC_ATTACK_RANGE_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  MOB_ARCHETYPE_KEYS,
  MOB_MATCHUPS,
  UNIVERSAL_FOOD_DROP_PROBABILITY,
  UNIVERSAL_FOOD_DROP_ROLL_ID,
  UNIVERSAL_FOOD_ITEMS,
  UNIVERSAL_FOOD_ITEM_IDS,
  UNIVERSAL_FOOD_BY_MOB,
  MOB_BIOME_VARIANT_FAMILIES,
  MOB_BIOME_VARIANT_FAMILY_BASES,
  MOB_HEALTH_UNIT
} from "@ash-atlas/shared";

import { loadConfig } from "../../config.js";
import { gimmickStrikeFor, roarBuffKind } from "./mobGimmicks.js";
import {
  BASE_XP_PER_HIT_EQUIVALENT,
  COMBAT_ITEM_REWARD_POLICY_VERSION,
  MOB_VALUE_DROP_ROLL_IDS,
  COMBAT_XP_POLICY_VERSION,
  MOB_DEFINITIONS,
  mobDropsLeather,
  MOB_AI_PROFILES,
  MOB_TARGET_BASIC_HIT_COUNTS,
  WORLD_MOB_TEMPLATES,
  combatXpAnchor,
  mobDefinitionFromTemplate,
  mobMovementSpeedMps,
  overworldGoldByRule,
  ownDrop,
  requireMobDefinition,
  resolveMobCombatProfile,
  XORAL_MAX_HEALTH
} from "./mobDefinitions.js";

describe("fixed-strength mob definitions", () => {
  it("defines positive hit counts and character XP anchors for every non-dummy archetype", () => {
    for (const archetype of MOB_ARCHETYPE_KEYS.filter((key) => key !== "training_dummy")) {
      expect(MOB_TARGET_BASIC_HIT_COUNTS[archetype]).toBeGreaterThan(0);
      expect(combatXpAnchor(archetype).baseXpPool).toBeGreaterThan(0);
    }
  });

  it.each([
    ["stormwing", 60, 25], ["ember_giant", 50, 25], ["centaur_khan", 45, 25], ["mammoth_patriarch", 55, 25],
    ["blizzard_lord", 50, 25], ["elder_mere_serpent", 50, 25], ["kraken", 20, 20],
    ["alder_king", 20, 20], ["bridge_troll", 20, 20], ["chimera", 20, 20], ["coven_matron", 20, 20],
    ["frogfolk_chief", 20, 20], ["frostborn_jarl", 20, 20], ["gnoll_packlord", 20, 20],
    ["leech_mother", 20, 20], ["mossjaw_warboss", 20, 20], ["serpent_priestess", 20, 20],
    ["strawman_lord", 20, 20]
  ] as const)("gives %s the health of its %i-hit role, not its template's", (key, hits, level) => {
    expect(MOB_TARGET_BASIC_HIT_COUNTS[key]).toBe(hits);
    expect(MOB_DEFINITIONS[key].level).toBe(level);
    expect(MOB_DEFINITIONS[key].maxHealth).toBe(MOB_HEALTH_UNIT * hits);
    const profile = resolveMobCombatProfile(key, level);
    expect(profile.targetBasicHitCount).toBe(hits);
    expect(MOB_DEFINITIONS[key].maxHealth).toBe(profile.maxHealth);
  });

  it("gives elites and world bosses attack and defense of a same-level mob, not a low-level template's", () => {
    for (const key of ["kraken", "chimera", "bridge_troll", "leech_mother"] as const) {
      expect(MOB_DEFINITIONS[key]).toMatchObject({
        attackPower: MOB_DEFINITIONS.orc_brute.attackPower, defense: MOB_DEFINITIONS.orc_brute.defense
      });
    }
    for (const key of ["centaur_khan", "mammoth_patriarch", "elder_mere_serpent"] as const) {
      expect(MOB_DEFINITIONS[key]).toMatchObject({
        attackPower: MOB_DEFINITIONS.ogre.attackPower, defense: MOB_DEFINITIONS.ogre.defense
      });
    }
  });

  it("pays overworld gold by the 5-per-hit rule where it differs from the old value by over 25%", () => {
    // Mobs with no overworld spawn rule (the retired land mobs) keep their template gold.
    const expected = {
      kraken: 120, jellyfish: 263, frost_wraith: 25, kappa: 50, humpback_whale: 53, coral_golem: 100, bear: 60
    } as const;
    for (const [key, gold] of Object.entries(expected)) {
      expect(MOB_DEFINITIONS[key as keyof typeof expected].rewards.gold, key).toBe(gold);
    }
    expect(overworldGoldByRule("mammoth_patriarch")).toBeNull();
    expect(overworldGoldByRule("coral_golem")).toBe(120);
    expect(overworldGoldByRule("hollin_hut")).toBeNull();
  });

  it("publishes the Leatherworking double-leather policy under version 13", () => {
    expect(COMBAT_ITEM_REWARD_POLICY_VERSION).toBe(13);
  });

  it("derives leather-dropping monsters from their drop tables", () => {
    expect(mobDropsLeather("elk")).toBe(true);
    expect(mobDropsLeather("badger")).toBe(true);
    expect(mobDropsLeather("slime_miniboss")).toBe(false);
    expect(mobDropsLeather("not_a_mob")).toBe(false);
    expect(mobDropsLeather(null)).toBe(false);
  });

  it("gives fantasy mobs their own metal material drops instead of the template's", () => {
    const rolls = (key: keyof typeof MOB_DEFINITIONS, itemId: string) =>
      MOB_DEFINITIONS[key].rewards.chanceItems.filter((reward) => reward.itemId === itemId);
    expect(rolls("frost_wraith", "umbral_essence")).toHaveLength(1);
    expect(rolls("lizardfolk_warrior", "umbral_essence")).toHaveLength(0);
    expect(rolls("lizardfolk_warrior", "dusk_heart")[0]?.probability).toBe(0.02);
    expect(rolls("skeleton", "umbral_essence")[0]?.probability).toBe(0.08);
    const gust = rolls("griffin", "gale_splinter");
    expect(gust.map((reward) => reward.quantity)).toEqual([2, 3, 4, 5]);
    expect(gust.reduce((total, reward) => total + reward.probability, 0)).toBeCloseTo(0.4);
    expect(rolls("griffin", "griffin_plume")[0]?.probability).toBe(0.1);
    expect(rolls("cliff_hawk", "gale_splinter")).toHaveLength(4);
  });

  describe("template mobs with their own drops", () => {
    const numbersOf = ({ key: _key, name: _name, spriteKey: _sprite, rewards: _rewards, ...numbers }:
      (typeof MOB_DEFINITIONS)[keyof typeof MOB_DEFINITIONS]) => numbers;
    const foodRoll = (key: keyof typeof UNIVERSAL_FOOD_BY_MOB, probability: number = UNIVERSAL_FOOD_DROP_PROBABILITY) => ({
      itemId: UNIVERSAL_FOOD_BY_MOB[key]!.itemId,
      quantity: 1,
      probability,
      rollId: UNIVERSAL_FOOD_DROP_ROLL_ID
    });

    it("builds an animal on a template: template numbers, own name, own meat and own drops", () => {
      // jungle_deer stands in for a new animal key on the Hog template.
      const animal = mobDefinitionFromTemplate({
        key: "jungle_deer",
        name: "Test Tapir",
        template: MOB_DEFINITIONS.hog,
        drops: { chanceItems: [ownDrop("leather", 0.6)], gold: 3 }
      });
      expect(numbersOf(animal)).toEqual(numbersOf(MOB_DEFINITIONS.hog));
      expect(animal).toMatchObject({ key: "jungle_deer", name: "Test Tapir", spriteKey: "jungle_deer" });
      expect(animal.rewards).toEqual({
        items: [],
        chanceItems: [
          { itemId: "leather", quantity: 1, probability: 0.6, rollId: "drop:leather" },
          // jungle_deer has no overworld spawn rule, so its meat stays at the ration chance.
          foodRoll("jungle_deer")
        ],
        gold: 3,
        cityCoins: 0
      });
      expect(animal.rewards.chanceItems.some(({ itemId }) => itemId === "hog_cut")).toBe(false);
    });

    it("builds on a world template's copied numbers without the source mob's drops", () => {
      const hawk = mobDefinitionFromTemplate({
        key: "jungle_deer",
        name: "Test Kestrel",
        template: WORLD_MOB_TEMPLATES.world_cliff_hawk.numbers,
        level: 7,
        drops: { chanceItems: [], gold: 2 }
      });
      expect(hawk).toMatchObject({ ...WORLD_MOB_TEMPLATES.world_cliff_hawk.numbers, level: 7 });
      expect(hawk.rewards.chanceItems).toEqual([foodRoll("jungle_deer")]);
      // A copy, not a reference: the world template is its own object.
      expect(WORLD_MOB_TEMPLATES.world_cliff_hawk.numbers).not.toBe(MOB_DEFINITIONS.cliff_hawk);
    });

    it("gives a fantasy mob an explicit drop list instead of its template's", () => {
      const fantasy = mobDefinitionFromTemplate({
        key: "griffin",
        name: "Test Griffin",
        template: MOB_DEFINITIONS.wolf,
        drops: {
          items: [{ itemId: "bone", quantity: 1 }],
          chanceItems: [ownDrop("wood", 0.3, 2)],
          gold: 5,
          cityCoins: 1
        }
      });
      expect(numbersOf(fantasy)).toEqual(numbersOf(MOB_DEFINITIONS.wolf));
      expect(fantasy.rewards).toEqual({
        items: [{ itemId: "bone", quantity: 1 }],
        chanceItems: [
          { itemId: "wood", quantity: 2, probability: 0.3, rollId: "drop:wood" },
          foodRoll("griffin")
        ],
        gold: 5,
        cityCoins: 1
      });
      expect(() => mobDefinitionFromTemplate({
        key: "griffin",
        name: "Test Griffin",
        template: MOB_DEFINITIONS.wolf,
        drops: { chanceItems: [foodRoll("griffin")], gold: 0 }
      })).toThrow("universal food roll is added for it");
    });
  });

  it("gives every real mob exactly one independent Kitchen ingredient roll at 5% unless its meat chance is set", () => {
    const MEAT_CHANCES = [0.1, 0.25, 0.5];
    for (const archetype of MOB_ARCHETYPE_KEYS) {
      const universal = MOB_DEFINITIONS[archetype].rewards.chanceItems
        .filter((reward) => reward.rollId === UNIVERSAL_FOOD_DROP_ROLL_ID);
      if (archetype === "training_dummy" || UNIVERSAL_FOOD_BY_MOB[archetype] === null) {
        expect(universal).toEqual([]);
        continue;
      }
      for (const reward of universal) {
        expect(reward.itemId).toBe(UNIVERSAL_FOOD_BY_MOB[archetype]!.itemId);
        expect(UNIVERSAL_FOOD_ITEM_IDS).toContain(reward.itemId);
      }
      if (universal.length > 1) {
        // A world boss's meat is a weighted 1-3 quantity roll that always drops.
        expect(universal.map(({ quantity }) => quantity)).toEqual([1, 2, 3]);
        expect(universal.reduce((total, { probability }) => total + probability, 0)).toBeCloseTo(1, 12);
        continue;
      }
      expect(universal).toHaveLength(1);
      expect(universal[0]).toMatchObject({ quantity: 1 });
      expect([UNIVERSAL_FOOD_DROP_PROBABILITY, ...MEAT_CHANCES]).toContain(universal[0]!.probability);
    }
  });

  it("sets each overworld animal's meat chance by importance", () => {
    const chance = (key: keyof typeof MOB_DEFINITIONS) => MOB_DEFINITIONS[key].rewards.chanceItems
      .filter((reward) => reward.rollId === UNIVERSAL_FOOD_DROP_ROLL_ID)
      .map(({ quantity, probability }) => [quantity, probability]);
    // Retired land mobs have no spawn rarity, so they keep the ration chance.
    expect(chance("deer")).toEqual([[1, UNIVERSAL_FOOD_DROP_PROBABILITY]]);
    expect(chance("frog")).toEqual([[1, 0.25]]);
    expect(chance("wolf")).toEqual([[1, 0.1]]);
    expect(chance("hog")).toEqual([[1, 0.1]]);
    expect(chance("bear")).toEqual([[1, 0.25]]);
    expect(chance("jaguar")).toEqual([[1, 0.25]]);
    expect(chance("humpback_whale")).toEqual([[1, 0.25]]);
    expect(chance("plains_bison")).toEqual([[1, 0.1]]);
    expect(chance("mammoth_patriarch")).toEqual([[1, UNIVERSAL_FOOD_DROP_PROBABILITY]]);
    expect(chance("goblin")).toEqual([[1, UNIVERSAL_FOOD_DROP_PROBABILITY]]);
    expect(chance("alder_king")).toEqual([[1, UNIVERSAL_FOOD_DROP_PROBABILITY]]);
  });

  it.each([
    ["coastal_crab", "crab_meat", "Crab Meat", 2],
    ["jellyfish", "jellyfish_jelly", "Jellyfish Jelly", 2],
    ["sap_crawler", "crawler_flesh", "Crawler Flesh", 2],
    ["fire_bird", "scorching_bird_meat", "Scorching Bird Meat", 20],
    ["lightning_bird", "zappy_bird_meat", "Zappy Bird Meat", 20],
    ["ice_bird", "freezing_bird_meat", "Freezing Bird Meat", 20]
  ] as const)("uses the species-specific %s food identity and yield", (
    archetype,
    itemId,
    displayName,
    kitchenYield
  ) => {
    expect(UNIVERSAL_FOOD_BY_MOB[archetype]).toMatchObject({
      itemId,
      displayName,
      kitchenYield
    });
    expect(MOB_DEFINITIONS[archetype].rewards.chanceItems).toContainEqual({
      itemId,
      quantity: 1,
      probability: archetype === "jellyfish" ? 0.25 : UNIVERSAL_FOOD_DROP_PROBABILITY,
      rollId: UNIVERSAL_FOOD_DROP_ROLL_ID
    });
  });

  it("retains generic food items without assigning them to a new mob drop", () => {
    expect(UNIVERSAL_FOOD_ITEMS.small_catch).toMatchObject({
      itemId: "small_catch", displayName: "Small Catch", kitchenYield: 2
    });
    expect(UNIVERSAL_FOOD_ITEMS.elemental_ration).toMatchObject({
      itemId: "elemental_ration", displayName: "Elemental Ration", kitchenYield: 20
    });
    expect(Object.values(UNIVERSAL_FOOD_BY_MOB)
      .filter((food) => food?.itemId === "small_catch" || food?.itemId === "elemental_ration")).toEqual([]);
  });

  it.each([
    ["deer", 2, 25, 1, 0, BASIC_ATTACK_INTERVAL_MS, 30],
    ["wolf", 5, 90, 4, 2, BASIC_ATTACK_INTERVAL_MS, 75],
    ["goblin", 10, 180, 5, 5, BASIC_ATTACK_INTERVAL_MS, 140],
    ["bandit", 15, 300, 7, 9, BASIC_ATTACK_INTERVAL_MS, 225],
    ["orc_brute", 20, 450, 9, 14, BASIC_ATTACK_INTERVAL_MS, 350],
    ["ogre", 25, 650, 12, 20, BASIC_ATTACK_INTERVAL_MS, 550],
    ["bear", 15, 250, 25, 0, BASIC_ATTACK_INTERVAL_MS, 120],
    ["sap_crawler", 1, 10, 1, 0, BASIC_ATTACK_INTERVAL_MS, 15],
    ["hog", 8, 135, 4, 3, BASIC_ATTACK_INTERVAL_MS, 120],
    ["coastal_crab", 1, 10, 1, 0, BASIC_ATTACK_INTERVAL_MS, 12],
    ["frog", 0, 7, 1, 0, BASIC_ATTACK_INTERVAL_MS, 10],
    ["alligator", 15, 250, 6, 7, BASIC_ATTACK_INTERVAL_MS, 210],
    ["squid", 12, 180, 5, 5, BASIC_ATTACK_INTERVAL_MS, 150],
    ["jellyfish", 12, 900, 1, 5, BASIC_ATTACK_INTERVAL_MS, 150],
    ["mysterious_traveler", 25, 600, 45, 0, BASIC_ATTACK_INTERVAL_MS, 300],
    ["sewer_rat", 4, 56, 14, 1, BASIC_ATTACK_INTERVAL_MS, 48],
    ["sick_sewer_rat", 6, 96, 16, 2, BASIC_ATTACK_INTERVAL_MS, 72],
    ["sewer_rat_miniboss", 12, 660, 22, 8, BASIC_ATTACK_INTERVAL_MS, 360]
  ] as const)("defines %s exactly", (key, level, hp, attack, defense, interval, xp) => {
    expect(MOB_DEFINITIONS[key]).toMatchObject({
      key,
      level,
      maxHealth: hp,
      attackPower: attack,
      defense,
      attackIntervalMs: interval,
      legacyV2BaseXpPool: xp,
      balanceVersion: 2
    });
  });

  it("keeps the training dummy reward-free", () => {
    expect(MOB_DEFINITIONS.training_dummy).toMatchObject({ level: 0, legacyV2BaseXpPool: 0 });
    expect(combatXpAnchor("training_dummy")).toEqual({
      xpPolicyVersion: COMBAT_XP_POLICY_VERSION,
      targetBasicHitCount: 10,
      baseXpPool: 0
    });
  });

  it("defines the Coastal Crab as a low-level attacked-only salvage source", () => {
    expect(MOB_DEFINITIONS.coastal_crab).toMatchObject({
      name: "Coastal Crab",
      level: 1,
      maxHealth: 10,
      attackPower: 1,
      defense: 0,
      retaliates: true,
      habitat: "land",
      rewards: {
        items: [{ itemId: "crab_carapace", quantity: 1 }],
        chanceItems: [
          { itemId: "crude_oil", quantity: 1, probability: 0.05, rollId: "crude_oil" },
          { itemId: "crab_meat", quantity: 1, probability: 0.05, rollId: "universal_food" }
        ],
        gold: 5,
        cityCoins: 0
      }
    });
    expect(combatXpAnchor("coastal_crab")).toEqual({
      xpPolicyVersion: 3,
      targetBasicHitCount: 1,
      baseXpPool: 12
    });
  });

  it("defines Skeleton as a dusk/night Bone source with a 50% four-Bone roll", () => {
    expect(MOB_DEFINITIONS.skeleton).toMatchObject({
      name: "Skeleton",
      level: 6,
      maxHealth: 100,
      attackPower: 5,
      defense: 3,
      habitat: "land",
      rewards: {
        items: [],
        chanceItems: expect.arrayContaining([{
          itemId: "bone",
          quantity: 4,
          probability: 0.5,
          rollId: "bone_quantity"
        }]),
        gold: 25,
        cityCoins: 0
      }
    });
  });

  it("uses the character basic-attack interval for every mob archetype", () => {
    expect(new Set(Object.values(MOB_DEFINITIONS).map((definition) => definition.attackIntervalMs)))
      .toEqual(new Set([BASIC_ATTACK_INTERVAL_MS]));
  });

  it("uses the shared melee baseline for ordinary basic-attack mobs", () => {
    expect(BASIC_ATTACK_RANGE_M).toBe(100);
    expect(MOB_DEFINITIONS.wolf.attackRangeM).toBe(BASIC_ATTACK_RANGE_M);
    expect(MOB_DEFINITIONS.ogre.attackRangeM).toBe(BASIC_ATTACK_RANGE_M);
  });

  it("defines exactly the active shared mob archetypes", () => {
    expect(Object.keys(MOB_DEFINITIONS).sort()).toEqual([...MOB_ARCHETYPE_KEYS].sort());
  });

  it("derives The Xoral as a level-25 axe/chainmail boss with a fixed 5,000 health pool", () => {
    const ogre = resolveMobCombatProfile("ogre", 25);
    const xoral = resolveMobCombatProfile("xoral", 25);
    expect(xoral).toMatchObject({
      matchup: { weaponType: "axe", armorType: "chainmail", damageMultiplier: 2 },
      referenceAttack: 9,
      maxHealth: XORAL_MAX_HEALTH,
      attackPower: ogre.attackPower
    });
    expect(XORAL_MAX_HEALTH).toBe(5_000);
    expect(resolveMobCombatProfile("xoral", 0).maxHealth).toBe(5_000);
    // Other bosses follow the rule: target hits x the neutral hit (9).
    expect(resolveMobCombatProfile("fire_bird", 25).maxHealth).toBe(120 * 9);
    expect(resolveMobCombatProfile("ice_bird", 25).maxHealth).toBe(100 * 9);
    expect(resolveMobCombatProfile("mysterious_traveler", 25).maxHealth).toBe(25 * 9);
    expect(MOB_DEFINITIONS.xoral).toMatchObject({
      boss: true,
      level: 25,
      attackRangeM: 250,
      movementSpeedMultiplier: 0.75,
      leashRadiusM: 650
    });
  });

  it.each(["fire_bird", "lightning_bird", "ice_bird"] as const)(
    "keeps the %s attacked-only inside the canonical gameplay-view boundary",
    (archetype) => {
      expect(MOB_AI_PROFILES[archetype]).toMatchObject({
        proactive: null,
        onAttacked: { group: "self" },
        disengagement: {
          kind: "outside_radius",
          radiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
          graceMs: 0
        }
      });
      expect(MOB_DEFINITIONS[archetype].leashRadiusM)
        .toBe(DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M);
    }
  );

  it("derives every reward-eligible V3 XP anchor from canonical hit counts", () => {
    for (const [archetype, healthHitCount] of Object.entries(MOB_TARGET_BASIC_HIT_COUNTS)) {
      if (archetype === "training_dummy") continue;
      // Only the Ogre decouples XP (20 hits) from its health hit count (8).
      const targetBasicHitCount = archetype === "ogre" || archetype === "hollin_hut" ? 20 : healthHitCount;
      expect(combatXpAnchor(archetype as keyof typeof MOB_TARGET_BASIC_HIT_COUNTS)).toEqual({
        xpPolicyVersion: 3,
        targetBasicHitCount,
        baseXpPool: BASE_XP_PER_HIT_EQUIVALENT * targetBasicHitCount
      });
    }
  });

  it("derives existing mob multipliers from the halved player base speed", () => {
    const playerSpeed = loadConfig({ NODE_ENV: "test" }).PLAYER_SPEED_MPS;
    expect(playerSpeed).toBe(125);
    expect(mobMovementSpeedMps("wolf", playerSpeed)).toBe(93.75);
    expect(mobMovementSpeedMps("deer", playerSpeed)).toBe(75);
    expect(mobMovementSpeedMps("ogre", playerSpeed)).toBe(112.5);
    expect(mobMovementSpeedMps("bear", playerSpeed)).toBe(81.25);
    expect(mobMovementSpeedMps("mysterious_traveler", playerSpeed)).toBe(100);
    expect(MOB_DEFINITIONS.wolf.attackIntervalMs).toBe(BASIC_ATTACK_INTERVAL_MS);
    expect(MOB_DEFINITIONS.ogre.attackIntervalMs).toBe(BASIC_ATTACK_INTERVAL_MS);
  });

  it.each([
    ["goblin", [], "field_ration", 1, 0],
    ["bandit", [], "field_ration", 48, 0],
    ["orc_brute", [], "hearty_ration", 72, 0],
    ["ogre", [{ itemId: "stone", quantity: 1 }], "hearty_ration", 100, 5],
    ["mysterious_traveler", [{ itemId: "balsam_resin", quantity: 25 }], "field_ration", 250, 0]
  ] as const)("defines exact %s item, food, Gold, and City Coin rewards", (key, items, foodItem, gold, cityCoins) => {
    expect(MOB_DEFINITIONS[key].rewards).toMatchObject({ items, gold, cityCoins });
    expect(MOB_DEFINITIONS[key].rewards.chanceItems).toContainEqual({
      itemId: foodItem, quantity: 1, probability: 0.05, rollId: "universal_food"
    });
  });

  it("defines Deer Leather quantities plus an independent 5% food roll", () => {
    expect(MOB_DEFINITIONS.deer.rewards).toEqual({
      items: [],
      chanceItems: [
        { itemId: "leather", quantity: 1, probability: 0.5, rollId: "leather_quantity" },
        { itemId: "leather", quantity: 2, probability: 0.3, rollId: "leather_quantity" },
        { itemId: "leather", quantity: 3, probability: 0.2, rollId: "leather_quantity" },
        { itemId: "deer_hide", quantity: 1, probability: 0.00001, rollId: "rare_hide" },
        { itemId: "deer_cut", quantity: 1, probability: 0.05, rollId: "universal_food" },
        { itemId: "antler", quantity: 1, probability: 0.25, rollId: "drop:antler" }
      ],
      gold: 10,
      cityCoins: 1
    });
  });

  it.each([
    ["wolf", 2, "wolf_pelt", "wolf_cut", 0.1, 15, 2, [["fang", 0.12]]],
    ["hog", 8, "hog_hide", "hog_cut", 0.1, 23, 3, [["animal_fat", 0.25]]],
    ["bear", 15, "bear_hide", "bear_cut", 0.25, 60, 4, [["fur_pelt", 0.12], ["claw", 0.12]]],
    ["alligator", 8, "alligator_hide", "alligator_tail", 0.25, 40, 4, [["reptile_scale", 0.12]]]
  ] as const)(
    "defines %s Leather plus an independent food roll and its value pass drops",
    (key, leather, hide, foodItem, foodChance, gold, cityCoins, valueDrops) => {
      expect(MOB_DEFINITIONS[key].rewards).toEqual({
        items: [{ itemId: "leather", quantity: leather }],
        chanceItems: [
          { itemId: hide, quantity: 1, probability: 0.00001, rollId: "rare_hide" },
          { itemId: foodItem, quantity: 1, probability: foodChance, rollId: "universal_food" },
          ...valueDrops.map(([itemId, probability]) => ({ itemId, quantity: 1, probability, rollId: `drop:${itemId}` }))
        ],
        gold,
        cityCoins
      });
    }
  );

  it("defines independent Resin Crawler item rolls with its Gold and City Coin rewards", () => {
    expect(MOB_DEFINITIONS.sap_crawler.rewards).toEqual({
      items: [],
      chanceItems: [
        { itemId: "balsam_resin", quantity: 1, probability: 0.5, rollId: "resin" },
        { itemId: "wood", quantity: 1, probability: 0.1, rollId: "wood" },
        { itemId: "crawler_flesh", quantity: 1, probability: 0.05, rollId: "universal_food" }
      ],
      gold: 5,
      cityCoins: 1
    });
  });

  it.each([
    ["fire_bird", "fire_feather"],
    ["lightning_bird", "tempest_quill"],
    ["ice_bird", "ice_feather"]
  ] as const)("defines the canonical ground-delivered %s feather", (archetype, feather) => {
    expect(MOB_DEFINITIONS[archetype].rewards).toEqual({
      itemDelivery: "ground",
      items: [{ itemId: feather, quantity: 1 }],
      chanceItems: [{
        itemId: archetype === "fire_bird"
          ? "scorching_bird_meat"
          : archetype === "lightning_bird"
            ? "zappy_bird_meat"
            : "freezing_bird_meat",
        quantity: 1,
        probability: 0.05,
        rollId: "universal_food"
      }],
      gold: 0,
      cityCoins: 0
    });
  });

  it("routes the Mysterious Traveler through the level-cap tier bands and V3 XP scaling", () => {
    expect(MOB_DEFINITIONS.mysterious_traveler).toMatchObject({
      level: 25,
      maxHealth: 600,
      attackPower: 45,
      attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
      attackRangeM: 100,
      movementSpeedMultiplier: 0.8,
      leashRadiusM: 220,
      retaliates: true
    });
    expect(resolveMobCombatProfile("mysterious_traveler", 20).tier).toBe("epic");
    expect(resolveMobCombatProfile("mysterious_traveler", 25).tier).toBe("legendary");
    expect(() => resolveMobCombatProfile("mysterious_traveler", 26)).toThrow(/0 through 25/);
    expect(combatXpAnchor("mysterious_traveler")).toEqual({
      xpPolicyVersion: 3,
      targetBasicHitCount: 25,
      baseXpPool: 300
    });
  });

  it("resolves the habitat mobs with their exact current loot", () => {
    expect(requireMobDefinition("hog")).toMatchObject({
      name: "Hog",
      spriteKey: "hog",
      habitat: "land",
      rewards: { items: [{ itemId: "leather", quantity: 8 }], gold: 23 }
    });
    expect(requireMobDefinition("frog")).toMatchObject({
      name: "Frog",
      spriteKey: "frog",
      habitat: "lake",
      rewards: { items: [], chanceItems: [
        { itemId: "frog_legs", quantity: 1, probability: 0.25, rollId: "universal_food" },
        { itemId: "slime_gel", quantity: 1, probability: 0.25, rollId: "drop:slime_gel" }
      ], gold: 2 }
    });
    expect(requireMobDefinition("alligator")).toMatchObject({
      name: "Alligator",
      spriteKey: "alligator",
      habitat: "river",
      rewards: { items: [{ itemId: "leather", quantity: 8 }], gold: 40 }
    });
    expect(requireMobDefinition("squid")).toMatchObject({
      name: "Squid",
      spriteKey: "squid",
      habitat: "ocean",
      rewards: {
        items: [],
        chanceItems: [
          { itemId: "crude_oil", quantity: 1, probability: 0.05, rollId: "crude_oil" },
          { itemId: "squid_cut", quantity: 1, probability: 0.1, rollId: "universal_food" },
          { itemId: "kraken_ink", quantity: 1, probability: 0.06, rollId: "drop:kraken_ink" }
        ],
        gold: 30
      }
    });
    expect(requireMobDefinition("jellyfish")).toMatchObject({
      name: "Jellyfish",
      spriteKey: "jellyfish",
      habitat: "ocean",
      rewards: {
        items: [{ itemId: "jellyfish_venom", quantity: 1 }],
        chanceItems: [
          { itemId: "crude_oil", quantity: 1, probability: 0.05, rollId: "crude_oil" },
          { itemId: "pearl", quantity: 1, probability: 0.5, rollId: "pearl" },
          { itemId: "jellyfish_jelly", quantity: 1, probability: 0.25, rollId: "universal_food" }
        ],
        gold: 263
      }
    });
  });

  it.each([0, 5, 6, 10, 11, 15, 16, 20, 21, 25])(
    "measures level %i health in neutral hits at the tier boundaries, whatever the armor",
    (level) => {
      // Health is hits x the neutral hit (equal-level sword into unarmored, 9);
      // the armor type only changes how many swings it takes.
      const swordHit = 9;
      for (const [archetype, targetBasicHitCount] of [
        ["sap_crawler", 1],
        ["deer", 2],
        ["wolf", 3],
        ["skeleton", 5],
        ["goblin", 5],
        ["hog", 5],
        ["bear", 10],
        ["ogre", 4],
        ["frog", 1],
        ["squid", 7]
      ] as const) {
        const profile = resolveMobCombatProfile(archetype, level);
        expect(profile).toMatchObject({
          level,
          balanceVersion: 2,
          referenceAttack: swordHit,
          attackPower: archetype === "wolf" ? Math.ceil((10 + level) / 2) : 10 + level,
          defense: 0,
          maxHealth: swordHit * targetBasicHitCount,
          targetBasicHitCount
        });
        expect(profile.matchup).toBe(MOB_MATCHUPS[archetype]);
      }
    }
  );

  it("keeps only the intentional training target at zero Gold", () => {
    const zeroGoldMobs = Object.values(MOB_DEFINITIONS)
      .filter(({ boss, rewards }) => !boss && rewards.gold === 0)
      .map(({ key }) => key);
    expect(zeroGoldMobs).toEqual(["training_dummy"]);
    expect(MOB_DEFINITIONS.training_dummy.rewards)
      .toEqual({ items: [], chanceItems: [], gold: 0, cityCoins: 0 });
    expect(MOB_DEFINITIONS.xoral.rewards)
      .toEqual({
        items: [],
        chanceItems: [{ itemId: "xoral_essence", quantity: 1, probability: 0.05, rollId: "universal_food" }],
        gold: 0,
        cityCoins: 0
      });
  });

  it("gives every biome variant its base's numbers, AI, matchup and drops except the food cut", () => {
    for (const base of MOB_BIOME_VARIANT_FAMILY_BASES) {
      const baseDefinition = MOB_DEFINITIONS[base];
      for (const variant of MOB_BIOME_VARIANT_FAMILIES[base]) {
        if (variant === base) continue;
        const definition = MOB_DEFINITIONS[variant];
        const { key, name, spriteKey, rewards, ...numbers } = definition;
        const baseRewards = baseDefinition.rewards;
        const baseNumbers: Record<string, unknown> = { ...baseDefinition };
        for (const field of ["key", "name", "spriteKey", "rewards"]) delete baseNumbers[field];
        expect(key).toBe(variant);
        expect(spriteKey).toBe(variant);
        expect(name).not.toBe(baseDefinition.name);
        expect(numbers, variant).toEqual(baseNumbers);
        expect(MOB_AI_PROFILES[variant], variant).toEqual(MOB_AI_PROFILES[base]);
        expect(MOB_MATCHUPS[variant], variant).toEqual(MOB_MATCHUPS[base]);
        expect(gimmickStrikeFor(variant), variant).toEqual(gimmickStrikeFor(base));
        const food = UNIVERSAL_FOOD_BY_MOB[variant]!;
        expect(food.itemId).not.toBe(UNIVERSAL_FOOD_BY_MOB[base]!.itemId);
        expect(food.kitchenYield, variant).toBe(UNIVERSAL_FOOD_BY_MOB[base]!.kitchenYield);
        // Mob value pass drops are listed per mob (a Poison Frog's gland is not a Frog's gel).
        const shared = (list: typeof rewards.chanceItems) => list
          .filter((reward) => !MOB_VALUE_DROP_ROLL_IDS.has(reward.rollId))
          .map((reward) => reward.rollId === UNIVERSAL_FOOD_DROP_ROLL_ID ? { ...reward, itemId: "food", probability: 0 } : reward);
        expect({ ...rewards, chanceItems: shared(rewards.chanceItems) })
          .toEqual({ ...baseRewards, chanceItems: shared(baseRewards.chanceItems) });
        expect(rewards.chanceItems.some((reward) => reward.itemId === food.itemId)).toBe(true);
      }
    }
    expect(roarBuffKind("frost_wolf")).toBe("howl");
  });
});
