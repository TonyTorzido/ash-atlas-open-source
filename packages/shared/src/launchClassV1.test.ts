import { describe, expect, it } from "vitest";

import {
  CLASS_CURVE_VERSION,
  CLASS_DEFINITIONS,
  CLASS_IDS,
  CLASS_MAX_RANK,
  CLASS_MAX_XP,
  CLASS_SWITCH_REQUIRES_SCROLL,
  CLASS_XP_PER_TARGET_BASIC_HIT,
  CLASS_XP_THRESHOLDS,
  LAUNCH_CLASS_IDS,
  classLevelForXp,
  equipmentDefinitionFromItemVariant,
  requireEquipmentDefinition
} from "./index.js";

describe("launch class system v1 contracts", () => {
  it("publishes the five-class roster while retaining historical class compatibility", () => {
    expect(LAUNCH_CLASS_IDS).toEqual(["warrior", "ranger", "ninja", "knight", "druid"]);
    expect(CLASS_IDS).toContain("hunter");
    expect(CLASS_IDS).toEqual(["warrior", "druid", "ranger", "knight", "ninja", "hunter"]);
    expect(LAUNCH_CLASS_IDS).not.toContain("hunter");
  });

  it("uses the exact shared rank 0-15 curve", () => {
    expect(CLASS_CURVE_VERSION).toBe(3);
    expect(CLASS_MAX_RANK).toBe(15);
    expect(CLASS_MAX_XP).toBe(72_000);
    expect(CLASS_XP_PER_TARGET_BASIC_HIT).toBe(2);
    expect(CLASS_XP_THRESHOLDS).toEqual([
      0, 1_193, 2_600, 4_257, 6_212, 8_515, 11_231, 14_432,
      18_205, 22_652, 27_895, 34_075, 41_360, 49_946, 60_068, 72_000
    ]);
    CLASS_XP_THRESHOLDS.forEach((xp, rank) => expect(classLevelForXp(xp, "ranger")).toBe(rank));
    expect(classLevelForXp(99_999, "knight")).toBe(15);
  });

  it("gives every non-Warrior launch class its intended skills without a resource", () => {
    for (const classId of LAUNCH_CLASS_IDS.filter((id) => id !== "warrior")) {
      const definition = CLASS_DEFINITIONS[classId];
      expect(definition.normals).toHaveLength(4);
      expect(Object.values(definition.passiveTiers).flat()).toHaveLength(6);
      expect(definition.resourceId).toBe("none");
      expect(definition.subclasses).toEqual([]);
    }
    expect(CLASS_DEFINITIONS.ninja.normals.map(({ id }) => id)).toEqual([
      "ninja_v2_twin_fang",
      "ninja_v2_smoke_bomb",
      "ninja_v2_shadowstep",
      "ninja_v2_shuriken_fan"
    ]);
    expect(CLASS_DEFINITIONS.ninja.ultimates.map(({ id }) => id)).toEqual([
      "ninja_v2_thousand_shadows"
    ]);
    expect(CLASS_DEFINITIONS.ninja.guaranteedTraits).toEqual([
      expect.objectContaining({ id: "ninja_close_quarters_shuriken", levels: [1] }),
      expect.objectContaining({ id: "ninja_weapon_mastery", levels: [5, 9, 13] })
    ]);
    expect(Object.values(CLASS_DEFINITIONS.ninja.passiveTiers).flat()).toHaveLength(6);
    expect(CLASS_SWITCH_REQUIRES_SCROLL).toBe(false);
  });

  it("retains Knight Heavy Slash as melee without an exact weapon-category restriction", () => {
    const heavySlash = CLASS_DEFINITIONS.knight.normals.find(({ id }) => id === "knight_heavy_slash");
    expect(heavySlash?.weaponRequirement).toBe("melee");
    expect(heavySlash).not.toHaveProperty("allowedWeaponCategories");
  });

  it("uses stable gameplay families inherited by cosmetic variants", () => {
    expect(requireEquipmentDefinition("double_axe").gameplayFamilyId).toBe("axe");
    expect(requireEquipmentDefinition("breast_plate").gameplayFamilyId).toBe("breastplate");
    expect(requireEquipmentDefinition("hammer")).toMatchObject({ displayName: "Hammer", gameplayFamilyId: "hammer", equipmentRole: "stock", marketTradable: true });
    expect(requireEquipmentDefinition("leather_armor")).toMatchObject({ displayName: "Leather Armor", gameplayFamilyId: "leather", marketTradable: true });
    expect(requireEquipmentDefinition("padded_tunic").gameplayFamilyId).toBe("tunic");
    expect(equipmentDefinitionFromItemVariant({
      definitionId: "cosmetic_knight_sword" as never,
      displayName: "Cosmetic Knight Sword",
      familyId: "sword",
      role: "cosmetic",
      appearanceId: "cosmetic_knight_sword"
    }).gameplayFamilyId).toBe("sword");
  });
});
