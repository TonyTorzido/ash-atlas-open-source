import { describe, expect, it } from "vitest";

import {
  GENERAL_ACTIVE_SLOT_COUNT,
  ROGUE_HUMANOID_GOLD_PROC_CHANCE,
  rogueHumanoidGoldAmount,
  rogueTheftAmount,
  GENERAL_ACTIVE_SLOT_IDS,
  GENERAL_SKILL_DEFAULT_RANK_COSTS,
  GENERAL_SKILL_DEFINITIONS,
  GENERAL_SKILL_IDS,
  LAUNCH_SPECIALIZATION_IDS,
  VISIBLE_GENERAL_SKILL_IDS,
  MAX_LEVEL_DERIVED_SKILL_POINTS,
  SKILL_SYSTEM_V3_EXECUTION_POLICY,
  SPECIALIZATION_DEFINITIONS,
  SPECIALIZATION_IDS,
  WORLD_KNOWLEDGE_SKILL_DEFINITIONS,
  applySkillSystemV3CombatStats,
  costForNextGeneralSkillRank,
  costForNextSpecializationRank,
  druidReplenishTransferRatio,
  earnedSkillPointsForCharacterLevel,
  gatewaySatisfied,
  STARTER_SPECIALIZATION_IDS,
  isFreeSwitchSpecializationId,
  isLaunchSpecializationId,
  isSpecializationAvailable,
  SPECIALIZATION_RANK_LEVEL_GATES,
  levelGateForNextSpecializationRank,
  requireGeneralSkillDefinition,
  requireSpecializationDefinition,
  resolveSkillSystemV3CombatModifiers,
  type SkillSystemV3Snapshot
} from "./skillSystemV3.js";
import { rareBeastDragonAttackBonus, rareBeastDragonDefenseBonus } from "./dungeonSkills.js";
import { TRADE_SKILL_IDS } from "./tradeSkills.js";

const snapshot = (activeSpecializationId: SkillSystemV3Snapshot["activeSpecializationId"], rank: number, generalSkills: SkillSystemV3Snapshot["generalSkills"] = []): SkillSystemV3Snapshot => ({
  fullBuildRespecAvailable: false,
  fullClassRosterEnabled: false,
  ultimatesEnabled: false,
  playerId: "player-1", characterLevel: 25,
  pointState: { totalEarned: 25, totalSpent: 0, available: 25, revision: 1 },
  generalSkills,
  specializations: activeSpecializationId === null ? [] : [{ specializationId: activeSpecializationId, rank, pointsSpent: rank, grandfathered: false, masteryQuestCompleted: false }],
  committedSpecializationId: activeSpecializationId,
  activeSpecializationId,
  equippedClassTechniqueId: null,
  generalActiveLoadout: [null, null], ultimate: null, cooldownEndsAt: {}, worldKnowledge: [], serverTime: 1, revision: 1
});

describe("Skill System V3 shared catalog", () => {
  it("uses one SP per level through the 40-point level cap", () => {
    expect(earnedSkillPointsForCharacterLevel(1)).toBe(1);
    expect(earnedSkillPointsForCharacterLevel(5)).toBe(5);
    expect(earnedSkillPointsForCharacterLevel(30)).toBe(30);
    expect(MAX_LEVEL_DERIVED_SKILL_POINTS).toBe(40);
    expect(earnedSkillPointsForCharacterLevel(45)).toBe(MAX_LEVEL_DERIVED_SKILL_POINTS);
    expect(() => earnedSkillPointsForCharacterLevel(0)).toThrow();
  });

  it("centralizes the current two General Active slot policy", () => {
    expect(GENERAL_ACTIVE_SLOT_IDS).toEqual([1, 2]);
    expect(GENERAL_ACTIVE_SLOT_COUNT).toBe(GENERAL_ACTIVE_SLOT_IDS.length);
  });

  it("keeps all general skills in a separate three-rank 1/1/1 registry", () => {
    expect(GENERAL_SKILL_DEFAULT_RANK_COSTS).toEqual([1, 1, 1]);
    expect(Object.keys(GENERAL_SKILL_DEFINITIONS)).toEqual([...GENERAL_SKILL_IDS]);
    for (const definition of Object.values(GENERAL_SKILL_DEFINITIONS)) {
      expect(definition.rankDefinitions.map(({ rank, cost }) => ({ rank, cost }))).toEqual([
        { rank: 1, cost: 1 }, { rank: 2, cost: 1 }, { rank: 3, cost: 1 }
      ]);
    }
    expect(requireGeneralSkillDefinition("concentration")).toMatchObject({ displayName: "Concentration" });
    expect(costForNextGeneralSkillRank("cleave", 0)).toBe(1);
    expect(costForNextGeneralSkillRank("cleave", 2)).toBe(1);
    expect(costForNextGeneralSkillRank("cleave", 3)).toBeNull();
  });

  it("retains only launch-hidden general skills outside the player-visible catalog", () => {
    const dependencyHidden = GENERAL_SKILL_IDS.filter((id) => GENERAL_SKILL_DEFINITIONS[id].catalogVisibility === "hidden_until_dependency");
    const launchHidden = GENERAL_SKILL_IDS.filter((id) => GENERAL_SKILL_DEFINITIONS[id].catalogVisibility === "hidden_for_launch");
    expect(dependencyHidden).toEqual([]);
    expect(launchHidden).toEqual([]);
    expect(VISIBLE_GENERAL_SKILL_IDS).toEqual([
      "cleave", "archery", "martial_arts", "tactics", "shield_charge", "cleanse",
      "taunt", "war_standard", "ricochet", "heroism", "quarry_sense", "huntsmans_edge",
      "perfect_strike", "pierce_armor", "blight_strike", "provoke", "pursuit", "scavenge", "calm_mind",
      "second_wind", "deathburst", "concentration", "companion_bond", "delvers_lore",
      "alchemy", "blacksmithing", "leatherworking", "cartography", "tradecraft"
    ]);
    expect(GENERAL_SKILL_DEFINITIONS.cleave.catalogVisibility).toBe("visible");
    for (const id of [...dependencyHidden, ...launchHidden]) expect(requireGeneralSkillDefinition(id)).toBe(GENERAL_SKILL_DEFINITIONS[id]);
  });

  it("publishes the exact dependency prerequisites", () => {
    expect(Object.fromEntries(VISIBLE_GENERAL_SKILL_IDS.map((id) => [id, GENERAL_SKILL_DEFINITIONS[id].prerequisites]))).toMatchObject({
      second_wind: [{ skillId: "cleave", rank: 1 }],
      pierce_armor: [{ skillId: "cleave", rank: 1 }],
      ricochet: [{ skillId: "archery", rank: 1 }],
      taunt: [{ skillId: "tactics", rank: 1 }],
      calm_mind: [{ skillId: "tactics", rank: 1 }],
      scavenge: [{ skillId: "tactics", rank: 1 }],
      shield_charge: [{ skillId: "cleave", rank: 2 }],
      quarry_sense: [{ skillId: "ricochet", rank: 1 }, { skillId: "archery", rank: 2 }],
      cleanse: [{ skillId: "tactics", rank: 2 }],
      companion_bond: [{ skillId: "tactics", rank: 2 }],
      delvers_lore: [{ skillId: "tactics", rank: 2 }],
      pursuit: [{ skillId: "shield_charge", rank: 1 }, { skillId: "cleave", rank: 3 }],
      huntsmans_edge: [{ skillId: "quarry_sense", rank: 1 }, { skillId: "archery", rank: 3 }],
      war_standard: [{ skillId: "taunt", rank: 1 }, { skillId: "tactics", rank: 3 }],
      blight_strike: [{ skillId: "pierce_armor", rank: 3 }, { skillId: "cleave", rank: 3 }],
      deathburst: [{ skillId: "second_wind", rank: 3 }, { skillId: "cleave", rank: 3 }],
      concentration: [{ skillId: "huntsmans_edge", rank: 1 }],
      heroism: [{ skillId: "war_standard", rank: 1 }]
    });
    expect(GENERAL_SKILL_DEFINITIONS.provoke.prerequisites).toEqual([{ skillId: "cleave", rank: 2 }]);
    expect(GENERAL_SKILL_DEFINITIONS.perfect_strike.prerequisites).toEqual([{ skillId: "martial_arts", rank: 3 }]);
    expect(GENERAL_SKILL_DEFINITIONS.second_wind.prerequisites).toEqual([{ skillId: "cleave", rank: 1 }]);
    expect(GENERAL_SKILL_DEFINITIONS.pierce_armor.useEquipmentRequirement).toEqual(
      GENERAL_SKILL_DEFINITIONS.cleave.useEquipmentRequirement
    );
    expect(GENERAL_SKILL_DEFINITIONS.concentration.rankDefinitions.flatMap((rank) => rank.effects)
      .every((effect) => !effect.description.includes("bias"))).toBe(true);
  });

  it("marks dependency perks and every Delver effect implemented", () => {
    expect(GENERAL_SKILL_DEFINITIONS.scavenge.status).toBe("implemented");
    expect(GENERAL_SKILL_DEFINITIONS.companion_bond.rankDefinitions.flatMap((rank) => rank.effects)
      .every((effect) => (effect.status ?? "implemented") === "implemented")).toBe(true);
    expect(GENERAL_SKILL_DEFINITIONS.delvers_lore.status).toBe("implemented");
    expect(GENERAL_SKILL_DEFINITIONS.delvers_lore.rankDefinitions.flatMap((rank) => rank.effects)
      .every((effect) => (effect.status ?? "implemented") === "implemented")).toBe(true);
  });

  it("publishes all 14 rank-5 specializations with exact independent costs and no Ultimates", () => {
    expect(Object.keys(SPECIALIZATION_DEFINITIONS)).toEqual([...SPECIALIZATION_IDS]);
    const unusual = new Set(["mercenary", "sentinel"]);
    // Ronin is the rankless free-switch test class.
    expect(SPECIALIZATION_DEFINITIONS.ronin).toMatchObject({ displayName: "Ronin", gatewaySkillId: null, availability: "launch", ranks: [] });
    for (const definition of Object.values(SPECIALIZATION_DEFINITIONS).filter(({ id }) => id !== "ronin")) {
      expect(definition.ranks.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5]);
      expect(definition.ranks.map((entry) => entry.cost)).toEqual(definition.id === "mercenary" ? [1, 1, 2, 3, 3] : unusual.has(definition.id) ? [1, 1, 2, 2, 3] : [1, 1, 1, 1, 1]);
      expect("ultimate" in definition).toBe(false);
    }
    expect(requireSpecializationDefinition("legionnaire")).toMatchObject({ displayName: "Legionnaire" });
    expect(requireSpecializationDefinition("monk")).toMatchObject({ displayName: "Monk" });
    expect(requireSpecializationDefinition("rogue")).toMatchObject({ displayName: "Rogue", status: "implemented" });
    expect(SPECIALIZATION_DEFINITIONS.rogue.ranks.flatMap(({ effects }) => effects)).toEqual(expect.arrayContaining([
      expect.objectContaining({ effectId: "rogue_pvp_gold_theft" }),
      expect.objectContaining({ effectId: "rogue_humanoid_gold" })
    ]));
    expect(SPECIALIZATION_DEFINITIONS.mercenary.ranks.flatMap(({ effects }) => effects)
      .filter((effect) => effect.effectId === "mercenary_folio_reward")).not.toHaveLength(0);
    expect(SPECIALIZATION_DEFINITIONS.mercenary.ranks.flatMap(({ effects }) => effects)
      .every((effect) => (effect.status ?? "implemented") === "implemented")).toBe(true);
    expect(SPECIALIZATION_DEFINITIONS.mercenary.signature).toMatchObject({
      id: "momentum",
      displayName: "Sustained PvP Spear Attack bonus",
      description: expect.stringContaining("capped by Mercenary rank (+2/+3/+4/+6)")
    });
    expect(SPECIALIZATION_DEFINITIONS.mercenary.ranks.map(({ description }) => description).join(" ")).not.toMatch(/Momentum/u);
    for (const [specializationId, dormantEffectIds] of Object.entries({
      merchant: ["merchant_bazaar_stall"],
      artificer: ["artificer_constructs"],
      voyager: ["voyager_travel"]
    } as const)) {
      const effects = requireSpecializationDefinition(specializationId).ranks.flatMap(({ effects: rankEffects }) => rankEffects);
      for (const effectId of dormantEffectIds) {
        expect(effects).toEqual(expect.arrayContaining([
          expect.objectContaining({ effectId, status: expect.stringMatching(/^pending_/u) })
        ]));
      }
    }
    expect(SPECIALIZATION_DEFINITIONS.monk.ranks.flatMap(({ effects }) => effects)
      .every((effect) => (effect.status ?? "implemented") === "implemented")).toBe(true);
    expect(costForNextSpecializationRank("mercenary", 4)).toBe(3);
    expect(costForNextSpecializationRank("warrior", 5)).toBeNull();
    // Owner, 2026-10-21: only Ronin and Warrior are selectable; every other class is hidden (kept defined).
    expect(LAUNCH_SPECIALIZATION_IDS).toEqual(["ronin", "warrior"]);
    expect(STARTER_SPECIALIZATION_IDS).toEqual(["warrior", "ranger"]);
    expect(SPECIALIZATION_IDS.filter(isLaunchSpecializationId)).toEqual(["warrior", "ronin"]);
    expect(SPECIALIZATION_IDS.filter(isFreeSwitchSpecializationId)).toEqual(["warrior", "ronin"]);
    expect(SPECIALIZATION_IDS.filter((id) => isSpecializationAvailable(id))).toEqual(["warrior", "ronin"]);
    expect(SPECIALIZATION_IDS.filter((id) => isSpecializationAvailable(id, {
      fullClassRosterEnabled: true,
      ultimatesEnabled: false
    }))).toEqual([...SPECIALIZATION_IDS]);
    expect(SPECIALIZATION_RANK_LEVEL_GATES).toEqual([9, 14, 21, 27, 33]);
    expect([0, 1, 2, 3, 4, 5].map((rank) => levelGateForNextSpecializationRank(rank))).toEqual([9, 14, 21, 27, 33, null]);
    expect(requireSpecializationDefinition("sentinel")).toMatchObject({ displayName: "Militia" });
    expect(requireSpecializationDefinition("merchant").availability).toBe("full_roster");
    expect(requireSpecializationDefinition("artificer").availability).toBe("full_roster");
    expect(Object.values(SPECIALIZATION_DEFINITIONS).filter(({ availability }) => availability === "launch").map(({ id }) => id)).toEqual([
      "warrior", "ronin"
    ]);
  });

  it("enforces exact gateway ranks, the level gate, grandfathering, and Ash gateways", () => {
    expect(gatewaySatisfied("warrior", 10, { cleave: 3 })).toBe(true);
    expect(gatewaySatisfied("sentinel", 10, { archery: 3 })).toBe(true);
    expect(gatewaySatisfied("ninja", 10, { martial_arts: 3 })).toBe(true);
    expect(gatewaySatisfied("voyager", 10, { tactics: 3 })).toBe(true);
    expect(gatewaySatisfied("warrior", 9, { cleave: 3 })).toBe(true);
    expect(gatewaySatisfied("warrior", 10, { cleave: 2 })).toBe(true);
    expect(gatewaySatisfied("warrior", 1, {})).toBe(true);
    expect(gatewaySatisfied("ranger", 1, {})).toBe(true);
    for (const [id, skill] of [["knight", "cleave"], ["sentinel", "archery"], ["mercenary", "archery"], ["monk", "martial_arts"], ["ninja", "martial_arts"], ["druid", "tactics"]] as const) {
      // Hidden classes keep the level-9 minimum.
      expect(gatewaySatisfied(id, 10, {})).toBe(false);
      expect(gatewaySatisfied(id, 10, { [skill]: 2 })).toBe(false);
      expect(gatewaySatisfied(id, 10, { [skill]: 3 })).toBe(true);
      expect(gatewaySatisfied(id, 8, { [skill]: 3 })).toBe(false);
    }
    expect(gatewaySatisfied("legionnaire", 25, {})).toBe(false);
    expect(gatewaySatisfied("legionnaire", 25, { cleave: 3 })).toBe(true);
    expect(gatewaySatisfied("legionnaire", 1, {}, true)).toBe(true);
    const launchUnlockCopy = (id: "cleave" | "archery" | "martial_arts" | "tactics") => {
      const description = GENERAL_SKILL_DEFINITIONS[id].rankDefinitions
        .find((rank) => rank.rank === 3)?.effects.at(0)?.description;
      expect(description).toBeTypeOf("string");
      return description?.match(/unlocks (.+)\.$/)?.[1];
    };
    expect(Object.fromEntries((["cleave", "archery", "martial_arts", "tactics"] as const).map((id) => [
      id,
      launchUnlockCopy(id)
    ]))).toEqual({
      cleave: "eligible Cleave specializations",
      archery: "eligible Archery specializations",
      martial_arts: "eligible Martial Arts specializations",
      tactics: "eligible Tactics specializations"
    });
  });

  it("publishes corrected general-skill ranks, cooldowns, and purchase requirements", () => {
    expect(GENERAL_SKILL_DEFINITIONS.archery.rankDefinitions.map(({ effects }) => effects[0]?.description)).toEqual([
      "+1 flat Attack with Longbow and Crossbow profiles; enables relevant weapon permissions.",
      "Total +3 flat Attack with Longbow and Crossbow; +22m range.",
      "Total +4 flat Attack with Longbow and Crossbow; +45m range; unlocks eligible Archery specializations."
    ]);
    expect(GENERAL_SKILL_DEFINITIONS.martial_arts.rankDefinitions.map(({ effects }) => effects[0]?.description)).toEqual(expect.arrayContaining([
      expect.stringContaining("14 Dodge percentage points"),
      expect.stringContaining("28 Dodge percentage points")
    ]));
    expect(GENERAL_SKILL_DEFINITIONS.shield_charge).not.toHaveProperty("equipmentRequirement");
    expect(GENERAL_SKILL_DEFINITIONS.shield_charge.rankDefinitions.every(({ effects }) => effects[0]?.description.includes("Shield and compatible melee stance"))).toBe(true);
    expect(GENERAL_SKILL_DEFINITIONS.ricochet).not.toHaveProperty("equipmentRequirement");
    expect(GENERAL_SKILL_DEFINITIONS.ricochet.useEquipmentRequirement).toEqual([
      "sling", "longbow", "crossbow", "blowdart", "shuriken"
    ]);
    expect(GENERAL_SKILL_DEFINITIONS.cleave.useEquipmentRequirement).toEqual([
      "sword", "axe", "hammer", "dagger", "brass_knuckles", "spear", "staff"
    ]);
    expect(VISIBLE_GENERAL_SKILL_IDS
      .filter((skillId) => GENERAL_SKILL_DEFINITIONS[skillId].kind === "active")
      .every((skillId) => GENERAL_SKILL_DEFINITIONS[skillId].rankDefinitions
        .every(({ cooldownMs }) => cooldownMs !== undefined && cooldownMs > 0))).toBe(true);
    expect(GENERAL_SKILL_DEFINITIONS.taunt.rankDefinitions.map(({ cooldownMs }) => cooldownMs)).toEqual([270_000, 210_000, 160_000]);
    expect(GENERAL_SKILL_DEFINITIONS.taunt.rankDefinitions.every(({ effects }) => effects[0]?.description.includes("36 seconds"))).toBe(true);
    expect(GENERAL_SKILL_DEFINITIONS.calm_mind.rankDefinitions.map(({ effects }) => effects[0]?.description)).toEqual([
      "Reduce aggression duration by 12%.",
      "Reduce aggression duration by 27%.",
      "Reduce aggression duration by 42%; a mob kill ends aggression immediately when no other enemies remain."
    ]);
    expect(GENERAL_SKILL_DEFINITIONS.second_wind.rankDefinitions.every(({ effects }) => effects[0]?.description.includes("cooldown"))).toBe(false);
  });

  it("makes the five trade skills ordinary 3-rank, 1-point General Skills with no prerequisites", () => {
    for (const id of TRADE_SKILL_IDS) {
      const definition = GENERAL_SKILL_DEFINITIONS[id];
      expect(definition.category).toBe("trade");
      expect(definition.catalogVisibility).toBe("visible");
      expect(definition.prerequisites).toEqual([]);
      expect(definition.rankDefinitions.map(({ rank, cost }) => ({ rank, cost }))).toEqual([{ rank: 1, cost: 1 }, { rank: 2, cost: 1 }, { rank: 3, cost: 1 }]);
    }
    expect(GENERAL_SKILL_DEFINITIONS.tradecraft.rankDefinitions.map(({ effects }) => effects[0]?.description).join(" ")).toMatch(/18%.*27%.*37%/);
    // Metallurgy lives only as the Metallurgy XP profession.
    expect(GENERAL_SKILL_IDS).not.toContain("metallurgy");
    expect(SPECIALIZATION_DEFINITIONS.artificer.ranks.map((entry) => entry.description).join(" ")).toMatch(/crafting XP.*Tactics.*bulk/is);
    expect(SPECIALIZATION_DEFINITIONS.artificer.ranks.map((entry) => entry.description).join(" ")).not.toMatch(/crafting speed|yield/i);
    expect(SPECIALIZATION_DEFINITIONS.voyager.ranks.map((entry) => entry.description).join(" ")).toMatch(/waypoints.*Tactics.*recenter/is);
    expect(SPECIALIZATION_DEFINITIONS.voyager.ranks.map((entry) => entry.description).join(" ")).not.toMatch(/map craft|record efficiency/i);

    for (const knowledge of Object.values(WORLD_KNOWLEDGE_SKILL_DEFINITIONS)) {
      expect(knowledge.hiddenUntilDiscovered).toBe(true);
      expect(knowledge.progressionCurrency).toBe("general_skill_points_after_discovery");
      const discovered = ["deepstone_lore", "wildkin_lore", "grove_lore", "edict_stride", "rare_beast_mastery", "field_engineering"].includes(knowledge.id);
      expect(knowledge.ranks.map(({ rank, cost }) => ({ rank, cost }))).toEqual([{ rank: 1, cost: 1 }, { rank: 2, cost: 1 }, { rank: 3, cost: 1 }]);
      expect(knowledge.status).toBe(discovered || knowledge.id === "tidecraft" ? "implemented" : "future_content");
    }
  });

  it("classifies V3 execution separately from preserved legacy definitions", () => {
    expect(SKILL_SYSTEM_V3_EXECUTION_POLICY).toEqual({
      generalSkills: "LIVE_V3", v2NormalClassActives: "LEGACY_INERT",
      v2PassiveTierSelections: "LEGACY_INERT", explicitCompatibilityAllowlist: "LEGACY_EXECUTABLE",
      unclassifiedHistoricalTechniqueDefinitions: "LEGACY_INERT", migrationAliases: "MIGRATION_ONLY"
    });
  });

  it("gives Rare Beast Mastery +6 / +11 / +18 max health and +1 Defense / Attack against dragons", () => {
    const equipment = { weaponProfile: "axe", bodyDefenseProfile: "breastplate", shieldEquipped: false, martialArtsDodgeEligible: false } as const;
    const withRank = (rank: number) => resolveSkillSystemV3CombatModifiers({
      ...snapshot(null, 0),
      worldKnowledge: [{ skillId: "rare_beast_mastery", revealed: true, rank, pointsSpent: rank }]
    }, equipment).flatMaxHp;
    expect([0, 1, 2, 3].map(withRank)).toEqual([0, 6, 11, 18]);
    expect([0, 1, 2, 3].map((rank) => rareBeastDragonDefenseBonus(rank, "elder_dragon"))).toEqual([0, 1, 1, 2]);
    expect([0, 1, 2, 3].map((rank) => rareBeastDragonAttackBonus(rank, "drakeling"))).toEqual([0, 0, 1, 2]);
    expect(rareBeastDragonAttackBonus(3, "ember_dragon")).toBe(2);
    expect(rareBeastDragonDefenseBonus(2, "ash_drake")).toBe(1);
    expect(rareBeastDragonAttackBonus(3, "wolf")).toBe(0);
    expect(rareBeastDragonDefenseBonus(3, "magma_salamander")).toBe(0);
  });

  it("applies snapshot/equipment-resolvable passives and reports runtime-only conditions", () => {
    const warrior = resolveSkillSystemV3CombatModifiers(snapshot("warrior", 5), {
      weaponProfile: "axe", bodyDefenseProfile: "breastplate", shieldEquipped: false, martialArtsDodgeEligible: false
    });
    expect(warrior).toMatchObject({ flatMaxHp: 45, flatAttack: 4 });
    expect(warrior.runtimeModifiers.map((entry) => entry.modifierId)).toContain("warrior_low_health_melee");

    const ninja = applySkillSystemV3CombatStats(
      { maxHp: 100, attack: 5, defense: 5, movementSpeed: 100, attackRangeM: 100, dodgeProbability: 0, directHealingMultiplier: 1, healingOverTimeMultiplier: 1 },
      snapshot("ninja", 5, [{ skillId: "martial_arts", rank: 3, pointsSpent: 4 }]),
      { weaponProfile: "shuriken", bodyDefenseProfile: "martial_tunic", shieldEquipped: false, martialArtsDodgeEligible: true }
    );
    expect(ninja).toMatchObject({ attack: 5, movementSpeed: 127, dodgeProbability: 0.39 });

    const legionnaire = resolveSkillSystemV3CombatModifiers(snapshot("legionnaire", 4), {
      weaponProfile: "spear", bodyDefenseProfile: "leather", shieldEquipped: true, martialArtsDodgeEligible: false
    });
    expect(legionnaire).toMatchObject({ flatAttack: 2, flatDefense: 2 });
    expect(legionnaire.runtimeModifiers.find((entry) => entry.modifierId === "legionnaire_formation")?.value).toBe(0.65);

    const unarmed = resolveSkillSystemV3CombatModifiers(
      snapshot(null, 0, [{ skillId: "martial_arts", rank: 1, pointsSpent: 1 }]),
      { weaponProfile: "unarmed", bodyDefenseProfile: "unarmored", shieldEquipped: false, martialArtsDodgeEligible: true }
    );
    expect(unarmed).toMatchObject({ flatAttack: 25, flatDefense: 25 });
    // Unarmed scaling follows the Level 25 gear cap, not the Level 40 character cap.
    expect(resolveSkillSystemV3CombatModifiers(
      { ...snapshot(null, 0, [{ skillId: "martial_arts", rank: 1, pointsSpent: 1 }]), characterLevel: 40 },
      { weaponProfile: "unarmed", bodyDefenseProfile: "unarmored", shieldEquipped: false, martialArtsDodgeEligible: true }
    )).toMatchObject({ flatAttack: 25, flatDefense: 25 });
    expect(resolveSkillSystemV3CombatModifiers(
      snapshot(null, 0, [{ skillId: "martial_arts", rank: 1, pointsSpent: 1 }]),
      { weaponProfile: "unarmed", bodyDefenseProfile: "breastplate", shieldEquipped: false, martialArtsDodgeEligible: false }
    )).toMatchObject({ flatAttack: 0, flatDefense: 0 });
    expect(resolveSkillSystemV3CombatModifiers(
      snapshot(null, 0, [{ skillId: "martial_arts", rank: 3, pointsSpent: 4 }]),
      { weaponProfile: "longbow", bodyDefenseProfile: "unarmored", shieldEquipped: false, martialArtsDodgeEligible: true }
    ).dodgeProbabilityPoints).toBe(0);
    expect(resolveSkillSystemV3CombatModifiers(
      snapshot("assassin", 1, [{ skillId: "martial_arts", rank: 3, pointsSpent: 4 }]),
      { weaponProfile: "dagger", bodyDefenseProfile: "martial_tunic", shieldEquipped: false, martialArtsDodgeEligible: true }
    ).dodgeProbabilityPoints).toBe(0.28);
    expect(resolveSkillSystemV3CombatModifiers(
      snapshot("rogue", 1, [{ skillId: "martial_arts", rank: 3, pointsSpent: 4 }]),
      { weaponProfile: "dagger", bodyDefenseProfile: "leather", shieldEquipped: false, martialArtsDodgeEligible: true }
    ).dodgeProbabilityPoints).toBe(0.28);

    expect(resolveSkillSystemV3CombatModifiers(
      snapshot(null, 0, [{ skillId: "archery", rank: 2, pointsSpent: 2 }]),
      { weaponProfile: "longbow", bodyDefenseProfile: "leather", shieldEquipped: false, martialArtsDodgeEligible: false }
    )).toMatchObject({ flatAttack: 3, flatAttackRangeM: 22 });
    expect(resolveSkillSystemV3CombatModifiers(
      snapshot(null, 0, [{ skillId: "archery", rank: 3, pointsSpent: 4 }]),
      { weaponProfile: "crossbow", bodyDefenseProfile: "breastplate", shieldEquipped: false, martialArtsDodgeEligible: false }
    )).toMatchObject({ flatAttack: 4, flatAttackRangeM: 45 });
    for (const [rank, expected] of [[1, 0], [2, 0.14], [3, 0.28]] as const) {
      expect(resolveSkillSystemV3CombatModifiers(
        snapshot(null, 0, [{ skillId: "martial_arts", rank, pointsSpent: rank }]),
        { weaponProfile: "shuriken", bodyDefenseProfile: "martial_tunic", shieldEquipped: false, martialArtsDodgeEligible: true }
      ).dodgeProbabilityPoints).toBe(expected);
    }
    expect(resolveSkillSystemV3CombatModifiers(
      snapshot(null, 0, [{ skillId: "martial_arts", rank: 3, pointsSpent: 4 }]),
      { weaponProfile: "shuriken", bodyDefenseProfile: "martial_tunic", shieldEquipped: true, martialArtsDodgeEligible: true }
    ).dodgeProbabilityPoints).toBe(0);
    const militia = resolveSkillSystemV3CombatModifiers(snapshot("sentinel", 5), {
      weaponProfile: "crossbow", bodyDefenseProfile: "breastplate", shieldEquipped: false, martialArtsDodgeEligible: false
    });
    expect(militia.runtimeModifiers.find(({ modifierId }) => modifierId === "sentinel_heavy_speed_penalty")).toMatchObject({ value: 6, unit: "percentage_points" });
    const monk = resolveSkillSystemV3CombatModifiers(snapshot("monk", 5), {
      weaponProfile: "staff", bodyDefenseProfile: "martial_tunic", shieldEquipped: false, martialArtsDodgeEligible: true
    });
    expect(monk.directHealingMultiplier).toBe(1);
    expect(monk.runtimeModifiers.find(({ modifierId }) => modifierId === "monk_balsam_resin_recovery")).toMatchObject({ value: 1.25, unit: "multiplier" });
    expect(monk.runtimeModifiers.find(({ modifierId }) => modifierId === "monk_enemy_speed_aura")).toMatchObject({ value: 0.87, condition: "hostile entity within 180m" });
    const rankOneMonk = resolveSkillSystemV3CombatModifiers(snapshot("monk", 1), {
      weaponProfile: "staff", bodyDefenseProfile: "martial_tunic", shieldEquipped: false, martialArtsDodgeEligible: true
    });
    expect(rankOneMonk.runtimeModifiers.find(({ modifierId }) => modifierId === "monk_balsam_resin_recovery")).toMatchObject({ value: 1.25, unit: "multiplier" });
  });

  it("resolves Knight heavy armor and Druid dodge and Replenish ranks", () => {
    const equipment = { weaponProfile: "sword" as const, bodyDefenseProfile: "unarmored" as const,
      bodyArmorFamilyId: "wyrm_scalemail", shieldEquipped: false, martialArtsDodgeEligible: false };
    expect(resolveSkillSystemV3CombatModifiers(snapshot("knight", 2), equipment).flatDefense).toBe(1);
    expect(resolveSkillSystemV3CombatModifiers(snapshot("knight", 4), equipment).flatDefense).toBe(2);
    expect(resolveSkillSystemV3CombatModifiers(snapshot("druid", 5), equipment).dodgeProbabilityPoints).toBe(0);
    expect(resolveSkillSystemV3CombatModifiers(snapshot("druid", 3), { ...equipment, bodyArmorFamilyId: null }).dodgeProbabilityPoints).toBe(0.13);
    expect(resolveSkillSystemV3CombatModifiers(snapshot("druid", 5), { ...equipment, bodyArmorFamilyId: null }).dodgeProbabilityPoints).toBe(0.27);
    expect([1, 2, 3, 4, 5].map((rank) => druidReplenishTransferRatio(rank, false))).toEqual([0.65, 0.65, 0.95, 0.95, 1.25]);
    expect([1, 3, 5].map((rank) => druidReplenishTransferRatio(rank, true))).toEqual([0.25, 0.25, 0.25]);
  });

  describe("Rogue ranks", () => {
    const leather = { weaponProfile: "dagger" as const, bodyDefenseProfile: "leather" as const, shieldEquipped: false, martialArtsDodgeEligible: true };
    const martial = [{ skillId: "martial_arts" as const, rank: 3, pointsSpent: 4 }];
    const dagger = [1, 1, 2, 2, 4];
    const humanoidGold = [450, 450, 900, 900, 1_350];
    const theftCap = [0n, 900n, 900n, 2_200n, 4_500n];
    for (const rank of [1, 2, 3, 4, 5]) {
      it(`rank ${rank}: speed, weapon, leather dodge, humanoid gold and theft cap`, () => {
        const modifiers = resolveSkillSystemV3CombatModifiers(snapshot("rogue", rank, martial), leather);
        expect(modifiers).toMatchObject({ flatMovementSpeed: rank * 7, flatAttack: dagger[rank - 1], dodgeProbabilityPoints: 0.28 });
        expect(resolveSkillSystemV3CombatModifiers(snapshot("rogue", rank, martial), { ...leather, weaponProfile: "brass_knuckles" }).flatAttack).toBe(dagger[rank - 1]);
        expect(resolveSkillSystemV3CombatModifiers(snapshot("rogue", rank, martial), { ...leather, shieldEquipped: true }).dodgeProbabilityPoints).toBe(0);
        expect(SPECIALIZATION_DEFINITIONS.rogue.ranks[rank - 1]!.effects.every((effect) => (effect.status ?? "implemented") === "implemented")).toBe(true);
        expect(ROGUE_HUMANOID_GOLD_PROC_CHANCE).toBe(0.025);
        expect(rogueHumanoidGoldAmount(rank)).toBe(humanoidGold[rank - 1]);
        // Rich victim: the cap decides; rank 1 never steals.
        expect(rogueTheftAmount(rank, 1_000_000_000n)).toBe(theftCap[rank - 1]);
      });
    }
    it("steals 9% of what is left, rounded down, below the cap", () => {
      expect(rogueTheftAmount(2, 5_000n)).toBe(450n);
      expect(rogueTheftAmount(2, 19n)).toBe(1n);
      expect(rogueTheftAmount(2, 9n)).toBe(0n);
      expect(rogueTheftAmount(5, 0n)).toBe(0n);
      expect(rogueTheftAmount(0, 100_000n)).toBe(0n);
    });
  });
});
