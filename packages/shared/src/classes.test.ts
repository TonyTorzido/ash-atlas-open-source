import { describe, expect, it } from "vitest";

import {
  ALL_TECHNIQUE_DEFINITIONS,
  CLASS_DEFINITIONS,
  CLASS_IDS,
  HUNTER_BALANCE,
  HUNTER_LEVEL_XP,
  HUNTER_NORMAL_DEFINITIONS,
  HUNTER_PASSIVE_DEFINITIONS,
  HUNTER_RESET_DEFINITIONS,
  SUBCLASS_RESET_DEFINITIONS,
  WARRIOR_BALANCE,
  WARRIOR_GUARANTEED_TRAITS,
  WARRIOR_LEVEL_XP,
  WARRIOR_NORMAL_DEFINITIONS,
  WARRIOR_PASSIVE_DEFINITIONS,
  WARRIOR_PASSIVE_TIERS,
  WARRIOR_RESET_DEFINITIONS,
  applyClassCombatStats,
  automaticTraitRank,
  availableTechniqueIds,
  classEquipmentCompatibility,
  classInitialResource,
  classLevelXp,
  classResourceDisplayName,
  classResourceId,
  classSubclasses,
  hunterWeaponMode,
  unlockedNormalSlots,
  unlockedPassiveTierSlots,
  unlockedResetSlots,
  warriorActiveLoadout,
  withWarriorActiveLoadout,
  warriorLevelForXp,
  type ClassSnapshot
} from "./classes.js";

describe("resource-free Warrior Rank 0-15 model", () => {
  it("represents the Warrior active loadout as two unified class skills", () => {
    const legacy = {
      resetActives: ["warrior_guarded_strike", "warrior_punishing_strike"],
      normalActives: ["warrior_empowered_hit", "warrior_anger_explosion"],
      passiveTiers: [null, null, null],
      ultimateActive: null
    };
    expect(warriorActiveLoadout(legacy)).toEqual({
      equippedEmpowerAbilityId: "warrior_empowered_hit",
      equippedTechniqueAbilityId: "warrior_anger_explosion"
    });
    expect(withWarriorActiveLoadout(legacy, {
      equippedEmpowerAbilityId: "warrior_concussive_blow",
      equippedTechniqueAbilityId: "warrior_battle_cry"
    })).toEqual({
      resetActives: [null, null],
      normalActives: ["warrior_concussive_blow", "warrior_battle_cry"],
      passiveTiers: [null, null, null],
      ultimateActive: null
    });
  });

  it("contains the exact deterministic class and subclass technique catalog", () => {
    expect(Array.from(WARRIOR_RESET_DEFINITIONS)).toEqual([]);
    expect(WARRIOR_NORMAL_DEFINITIONS.map((entry) => entry.id)).toEqual([
      "warrior_empowered_hit",
      "warrior_anger_explosion",
      "warrior_concussive_blow",
      "warrior_battle_cry"
    ]);
    expect(WARRIOR_PASSIVE_DEFINITIONS.map((entry) => entry.id)).toEqual([
      "warrior_heavy_handed",
      "warrior_bloodthirst",
      "warrior_relentless",
      "warrior_crowd_fighter",
      "warrior_desperate_fury",
      "warrior_last_stand"
    ]);
    expect(Object.values(SUBCLASS_RESET_DEFINITIONS).map((entry) => entry.id)).toEqual([
      "reaver_bloodletting_strike",
      "warden_guardians_reprisal",
      "sharpshooter_deadeye_shot",
      "stalker_rending_strike"
    ]);
    expect(ALL_TECHNIQUE_DEFINITIONS).toHaveLength(85);
    expect(new Set(ALL_TECHNIQUE_DEFINITIONS.map((entry) => entry.id)).size).toBe(85);
    expect(ALL_TECHNIQUE_DEFINITIONS.filter((entry) => entry.kind === "reset")).toHaveLength(7);
    expect(ALL_TECHNIQUE_DEFINITIONS.filter((entry) => entry.kind === "normal")).toHaveLength(33);
    expect(ALL_TECHNIQUE_DEFINITIONS.filter((entry) => entry.kind === "passive")).toHaveLength(42);
    expect(ALL_TECHNIQUE_DEFINITIONS.filter((entry) => entry.kind === "ultimate")).toHaveLength(3);
    expect(ALL_TECHNIQUE_DEFINITIONS.every((entry) => entry.targetType !== undefined)).toBe(true);

    const serialized = JSON.stringify(ALL_TECHNIQUE_DEFINITIONS);
    for (const obsolete of [
      "warrior_second_wind", "warrior_shield_crush", "warrior_charge", "warrior_hamstring",
      "warrior_bleeding_strike", "warrior_sundering_blow", "warrior_war_cry",
      "warrior_ground_slam", "warrior_whirlwind", "warrior_executioners_blow",
      "reaver_rampage", "warden_intercept"
    ]) expect(serialized).not.toContain(obsolete);
    for (const randomMechanic of [
      "criticalHitChance", "accuracy", "missChance", "dodgeChance", "evasion",
      "parryChance", "blockChance", "procChance", "statusChance"
    ]) expect(serialized).not.toContain(randomMechanic);
  });

  it("uses the exact strictly increasing 16-entry XP curve", () => {
    expect(WARRIOR_LEVEL_XP).toEqual([
      0, 1_193, 2_600, 4_257, 6_212, 8_515, 11_231, 14_432,
      18_205, 22_652, 27_895, 34_075, 41_360, 49_946, 60_068, 72_000
    ]);
    expect(WARRIOR_LEVEL_XP).toHaveLength(16);
    for (let level = 0; level <= 15; level += 1) {
      expect(warriorLevelForXp(WARRIOR_LEVEL_XP[level]!)).toBe(level);
      if (level < 15) expect(warriorLevelForXp(WARRIOR_LEVEL_XP[level + 1]! - 1)).toBe(level);
    }
    expect(warriorLevelForXp(-10)).toBe(0);
    expect(warriorLevelForXp(999_999)).toBe(15);
  });

  it("derives every Rank 0-15 learned ability and slot state", () => {
    for (let level = 0; level <= 15; level += 1) {
      const ids = availableTechniqueIds(snapshot(level));
      const expected = ALL_TECHNIQUE_DEFINITIONS
        .filter((definition) => definition.classId === "warrior" && definition.subclassId === null && definition.unlockLevel <= level)
        .map((definition) => definition.id);
      expect(ids).toEqual([]);
      if (level >= 1) expect(expected.length).toBeGreaterThan(0);
      expect(unlockedResetSlots(level)).toBe(0);
      expect(unlockedNormalSlots(level)).toBe(level >= 4 ? 2 : level >= 1 ? 1 : 0);
      expect(unlockedPassiveTierSlots(level)).toBe(level >= 12 ? 3 : level >= 7 ? 2 : level >= 2 ? 1 : 0);
    }
    expect(availableTechniqueIds(snapshot(1))).toEqual([]);
    expect(availableTechniqueIds(snapshot(11))).toEqual([]);
  });

  it("requires persistent subclass unlock state without a mastery tree", () => {
    const locked = snapshot(25);
    expect(availableTechniqueIds(locked)).not.toContain("reaver_bloodletting_strike");
    locked.subclasses[0] = { subclassId: "reaver", unlocked: true };
    expect(availableTechniqueIds(locked)).not.toContain("reaver_bloodletting_strike");
    expect(availableTechniqueIds(locked)).not.toContain("warden_guardians_reprisal");
    locked.subclasses[1] = { subclassId: "warden", unlocked: true };
    expect(availableTechniqueIds(locked)).not.toContain("warden_guardians_reprisal");
    expect(availableTechniqueIds({ ...locked, warrior: { ...locked.warrior, level: 24 } }))
      .not.toContain("reaver_bloodletting_strike");
  });

  it("defines one passive choice per exact tier", () => {
    expect(WARRIOR_PASSIVE_TIERS[0].map((entry) => entry.id)).toEqual(["warrior_heavy_handed", "warrior_bloodthirst"]);
    expect(WARRIOR_PASSIVE_TIERS[10].map((entry) => entry.id)).toEqual(["warrior_relentless", "warrior_crowd_fighter"]);
    expect(WARRIOR_PASSIVE_TIERS[20].map((entry) => entry.id)).toEqual(["warrior_desperate_fury", "warrior_last_stand"]);
    for (const [tier, definitions] of Object.entries(WARRIOR_PASSIVE_TIERS)) {
      expect(definitions).toHaveLength(2);
      expect(definitions.every((entry) => entry.passiveTier === Number(tier))).toBe(true);
    }
  });

  it("defines only Battle Hardened and exact canonical equipment mastery milestones", () => {
    const expected = {
      warrior_battle_hardened: [1],
      warrior_double_axe_mastery: [5, 9, 13],
      warrior_breast_plate_mastery: [6, 10, 14]
    } as const;
    for (const [id, levels] of Object.entries(expected)) {
      const definition = WARRIOR_GUARANTEED_TRAITS.find((entry) => entry.id === id)!;
      expect(definition.levels).toEqual(levels);
      expect(Math.max(...levels)).toBeLessThanOrEqual(15);
      for (let level = 0; level <= 15; level += 1) {
        expect(automaticTraitRank(level, definition.levels))
          .toBe(levels.filter((unlock) => level >= unlock).length);
      }
    }
  });

  it("centralizes the exact deterministic reset, passive, trait, and subclass values", () => {
    expect(WARRIOR_BALANCE.version).toBe(5);
    expect(WARRIOR_BALANCE.empoweredHitMultiplier).toBe(1.23);
    expect(WARRIOR_BALANCE.angerExplosionMultiplier).toBe(0.3);
    expect(WARRIOR_BALANCE.angerExplosionRadiusM).toBe(140);
    expect(WARRIOR_BALANCE.battleCryDamageMultiplier).toBe(1.09);
    expect(WARRIOR_BALANCE.sharedResetCooldownMs).toBe(0);
    expect(WARRIOR_BALANCE.hardenedBodyMaxHealthPerRank).toBe(0);
    expect(WARRIOR_BALANCE.historicalHardenedBodyMaxHealthPerRank).toBe(0.01);
    expect(WARRIOR_BALANCE.armorConditioningPerRank).toBe(0.01);
    expect(WARRIOR_BALANCE.martialTrainingPerRank).toBe(0.01);
    expect(WARRIOR_BALANCE.queueDisciplineCaps).toEqual([0.025, 0.045, 0.065, 0.085, 0.11]);
    expect(WARRIOR_BALANCE.rageControl.map((rank) => rank.decayPerSecond)).toEqual([5.3, 5, 4.2, 4, 3]);
    expect(WARRIOR_BALANCE.executionDamageMultiplier).toBe(1.6);
    expect(WARRIOR_BALANCE.fortifyMitigation).toBe(0.23);
    expect(WARRIOR_BALANCE.crowdBreakerMaximum).toBe(0.09);
    expect(WARRIOR_BALANCE.guardMitigationMaximum).toBe(0.13);
  });

  it("uses character level for Unrelenting Rage health without retained legacy stacking", () => {
    const level25 = snapshot(25);
    level25.legacyIds = ["warrior_legacy_iron_constitution"];
    const base = { maxHealth: 100, attackPower: 10, defense: 20, attackIntervalMs: 800, attackRangeM: 75 };
    const equipment = {
      totalDefenseBonus: 10,
      weapon: { weaponCategory: "sword" as const },
      chest: { armorCategory: "heavy" as const }
    };
    const first = applyClassCombatStats(base, level25, equipment);
    const second = applyClassCombatStats(base, level25, equipment);
    expect(first).toEqual(second);
    expect(first.maxHealth).toBe(103);
    expect(first.defense).toBe(20);
    expect(first.attackPower).toBe(10);
  });

  it.each([
    [1, 103],
    [5, 115],
    [15, 136],
    [25, 136]
  ])("grants capped Unrelenting Rage health at character level %i", (characterLevel, expectedMaxHealth) => {
    const warrior = snapshot(0);
    warrior.characterLevel = characterLevel;
    const result = applyClassCombatStats(
      { maxHealth: 100, attackPower: 10, defense: 20, attackIntervalMs: 800, attackRangeM: 75 },
      warrior,
      {
        totalDefenseBonus: 10,
        weapon: { weaponCategory: "sword" },
        chest: { armorCategory: "heavy" }
      }
    );
    expect(result.maxHealth).toBe(expectedMaxHealth);
  });

  it("does not grant Unrelenting Rage health while another class is active", () => {
    const ranger = snapshot(25);
    ranger.characterLevel = 15;
    ranger.activeClassId = "ranger";
    const result = applyClassCombatStats(
      { maxHealth: 130, attackPower: 10, defense: 20, attackIntervalMs: 800, attackRangeM: 75 },
      ranger,
      {
        totalDefenseBonus: 10,
        weapon: { weaponCategory: "bow" },
        chest: { armorCategory: "light" }
      }
    );
    expect(result.maxHealth).toBe(100);
  });

  it("does not let retained Warrior legacy health bypass fixed ordinary health", () => {
    const inactiveWarrior = snapshot(25);
    inactiveWarrior.activeClassId = "hunter";
    inactiveWarrior.legacyIds = ["warrior_legacy_iron_constitution"];
    const result = applyClassCombatStats(
      { maxHealth: 100, attackPower: 10, defense: 20, attackIntervalMs: 800, attackRangeM: 75 },
      inactiveWarrior,
      {
        totalDefenseBonus: 10,
        weapon: { weaponCategory: "sword" },
        chest: { armorCategory: "heavy" }
      }
    );
    expect(result.maxHealth).toBe(100);
    expect(result.defense).toBe(20);
  });
});

describe("Hunter Level 0-25 model", () => {
  it("derives every Hunter unlock independently from Warrior progression", () => {
    for (let level = 0; level <= 25; level += 1) {
      const state = snapshot(25);
      state.activeClassId = "hunter";
      state.hunter = { classId: "hunter", level, xp: HUNTER_LEVEL_XP[level]!, nextLevelXp: level === 25 ? null : HUNTER_LEVEL_XP[level + 1]!, completedAt: null };
      const expected = ALL_TECHNIQUE_DEFINITIONS
        .filter((definition) => definition.classId === "hunter" && definition.subclassId === null && definition.unlockLevel <= level)
        .map((definition) => definition.id);
      expect(availableTechniqueIds(state)).toEqual(expected);
      expect(state.warrior.level).toBe(25);
    }
    expect(HUNTER_RESET_DEFINITIONS.map((entry) => entry.id)).toEqual(["hunter_predators_strike", "hunter_marked_strike", "hunter_cull"]);
    expect(HUNTER_NORMAL_DEFINITIONS.map((entry) => entry.id)).toEqual(["hunter_sweep", "hunter_snare_trap"]);
    expect(HUNTER_PASSIVE_DEFINITIONS).toHaveLength(6);
  });

  it("enforces Hunter weapon, armor, and subclass modes canonically", () => {
    expect(hunterWeaponMode("bow")).toBe("ranged");
    expect(hunterWeaponMode("crossbow")).toBe("ranged");
    for (const weapon of ["sword", "dagger", "spear"] as const) expect(hunterWeaponMode(weapon)).toBe("melee");
    expect(hunterWeaponMode("staff")).toBeNull();
    expect(hunterWeaponMode("axe")).toBeNull();
    expect(classEquipmentCompatibility({ classId: "hunter", subclassId: null, weaponCategory: "bow", armorCategory: "heavy" })).toMatchObject({ compatible: false, code: "CLASS_ARMOR_INCOMPATIBLE" });
    expect(classEquipmentCompatibility({ classId: "hunter", subclassId: "sharpshooter", weaponCategory: "sword", armorCategory: "light" })).toMatchObject({ compatible: false, code: "SUBCLASS_WEAPON_REQUIRED" });
    expect(classEquipmentCompatibility({ classId: "hunter", subclassId: "stalker", weaponCategory: "bow", armorCategory: "medium" })).toMatchObject({ compatible: false, code: "SUBCLASS_WEAPON_REQUIRED" });
    expect(classEquipmentCompatibility({ classId: "hunter", subclassId: "stalker", weaponCategory: "sword", armorCategory: "light" })).toEqual({ compatible: true, weaponMode: "melee" });
  });

  it("keeps future-class health metadata inactive while applying defense and range", () => {
    const state = snapshot(0);
    state.activeClassId = "hunter";
    state.hunter = { classId: "hunter", level: 25, xp: 38_000, nextLevelXp: null, completedAt: null };
    state.loadout.passiveTiers = ["hunter_hardened_leathers", null, null];
    const result = applyClassCombatStats(
      { maxHealth: 100, attackPower: 10, defense: 20, attackIntervalMs: 800, attackRangeM: 75 }, state,
      { totalDefenseBonus: 10, weapon: { weaponCategory: "bow" }, chest: { armorCategory: "light" } }
    );
    expect(result.maxHealth).toBe(100);
    expect(result.defense).toBe(21);
    expect(result.attackRangeM).toBe(HUNTER_BALANCE.rangedRangeM);
  });
});

describe("launch class roster", () => {
  it("registers the launch classes plus the historical Hunter", () => {
    expect(CLASS_IDS).toEqual(["warrior", "druid", "ranger", "knight", "ninja", "hunter"]);
    expect(Object.keys(CLASS_DEFINITIONS)).toEqual(CLASS_IDS);
    expect(CLASS_IDS.map((classId) => [
      classId,
      classResourceId(classId),
      classResourceDisplayName(classId),
      classInitialResource(classId),
      classSubclasses(classId)
    ])).toEqual([
      ["warrior", "none", "None", 0, []],
      ["druid", "none", "None", 0, []],
      ["ranger", "none", "None", 0, []],
      ["knight", "none", "None", 0, []],
      ["ninja", "none", "None", 0, []],
      ["hunter", "focus", "Focus", 100, ["sharpshooter", "stalker"]]
    ]);
    expect(JSON.stringify([CLASS_DEFINITIONS, ALL_TECHNIQUE_DEFINITIONS])).not.toMatch(/paladin|cleric|justicar|vindicator|hierophant|exorcist/iu);
  });

  it("uses the shared Rank 0-15 curve for launch classes and retains Hunter compatibility", () => {
    expect(classLevelXp("warrior")).toBe(WARRIOR_LEVEL_XP);
    for (const classId of ["ranger", "ninja", "knight", "druid"] as const) {
      expect(classLevelXp(classId)).toBe(WARRIOR_LEVEL_XP);
    }
    expect(classLevelXp("hunter")).toBe(HUNTER_LEVEL_XP);
    expect(HUNTER_LEVEL_XP).not.toBe(WARRIOR_LEVEL_XP);
  });
});

function snapshot(level: number): ClassSnapshot {
  return {
    playerId: "p1",
    characterLevel: 1,
    activeClassId: "warrior",
    activeSubclassId: null,
    warrior: {
      classId: "warrior",
      level,
      xp: WARRIOR_LEVEL_XP[level]!,
      nextLevelXp: level === 25 ? null : WARRIOR_LEVEL_XP[level + 1]!,
      completedAt: null
    },
    hunter: { classId: "hunter", level: 0, xp: 0, nextLevelXp: 100, completedAt: null },
    classes: [],
    subclasses: [
      { classId: "warrior", subclassId: "reaver", unlocked: false },
      { classId: "warrior", subclassId: "warden", unlocked: false },
      { classId: "hunter", subclassId: "sharpshooter", unlocked: false },
      { classId: "hunter", subclassId: "stalker", unlocked: false }
    ],
    selectedSubclasses: { warrior: null, hunter: null },
    loadout: { resetActives: [null, null], normalActives: [null, null], passiveTiers: [null, null, null], ultimateActive: null },
    resource: { classId: "warrior", resourceId: "rage", displayName: "Rage", current: 0, maximum: 100, reserved: 0, updatedAt: new Date(0).toISOString() },
    resources: [],
    weaponMode: null,
    legacyIds: [],
    rage: 0,
    maximumRage: WARRIOR_BALANCE.rage.maximum,
    queuedAbility: null,
    cooldownEndsAt: {},
    serverTime: 0,
    revision: 1
  };
}
