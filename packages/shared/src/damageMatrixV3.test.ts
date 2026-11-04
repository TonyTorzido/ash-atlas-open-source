import { describe, expect, it } from "vitest";

import {
  ASH_V3_PROVISIONAL_SHIELD_COMBINATION,
  PVP_RAW_MATRIX_V3,
  PVP_RAW_MATRIX_V3_METADATA,
  combineV3BodyAndShieldDamage,
  normalizeV3NormalWeaponDamage,
  resolveDamageMatrixV3,
  resolveV3DefenseProfileForEquipmentFamily,
  resolveV3WeaponProfileForEquipmentFamily
} from "./damageMatrixV3.js";

describe("PvP Raw Matrix V3", () => {
  it("contains every exact matrix cell", () => {
    expect(PVP_RAW_MATRIX_V3).toEqual({
      unarmed: { unarmored: 4.25, shield: 2.25, breastplate: 2.25, martial_tunic: 2.25, leather: 2.25, wyrm_shield: 2.25, chainmail: 2.5 },
      sword: { unarmored: 9.25, shield: 7.25, breastplate: 4.25, martial_tunic: 7.5, leather: 8.5, wyrm_shield: 8.75, chainmail: 3.25 },
      spear: { unarmored: 11, shield: 7.5, breastplate: 6, martial_tunic: 7.25, leather: 6.25, wyrm_shield: 5.25, chainmail: 11.75 },
      dagger: { unarmored: 10, shield: 6, breastplate: 10.5, martial_tunic: 6.5, leather: 4.25, wyrm_shield: 5, chainmail: 5.25 },
      axe: { unarmored: 10.5, shield: 9.25, breastplate: 4.25, martial_tunic: 11, leather: 9, wyrm_shield: 9, chainmail: 4.75 },
      crossbow: { unarmored: 7.25, shield: 1.25, breastplate: 4.75, martial_tunic: 4, leather: 1.25, wyrm_shield: 0.75, chainmail: 4.75 },
      shuriken: { unarmored: 6.5, shield: 1.25, breastplate: 4.5, martial_tunic: 4, leather: 1.25, wyrm_shield: 0.75, chainmail: 4.75 },
      longbow: { unarmored: 6.5, shield: 0.25, breastplate: 4.25, martial_tunic: 4.25, leather: 1.25, wyrm_shield: 1.75, chainmail: 4.25 },
      blowdart: { unarmored: 6.25, shield: 0.25, breastplate: 4.25, martial_tunic: 4.25, leather: 1.25, wyrm_shield: 1.75, chainmail: 4.75 },
      sling: { unarmored: 7.5, shield: 4.25, breastplate: 4.25, martial_tunic: 9.75, leather: 3.5, wyrm_shield: 4.25, chainmail: 4.25 },
      martial_arts: { unarmored: 6.75, shield: 5.5, breastplate: 4.75, martial_tunic: 5.25, leather: 4.75, wyrm_shield: 6, chainmail: 4.75 },
      brass_knuckles: { unarmored: 8.25, shield: 6.25, breastplate: 3.75, martial_tunic: 6.25, leather: 7.25, wyrm_shield: 7, chainmail: 7 },
      staff: { unarmored: 10.25, shield: 5.75, breastplate: 5.75, martial_tunic: 9.25, leather: 6.5, wyrm_shield: 7.25, chainmail: 3.25 },
      wand: { unarmored: 8.75, shield: 5.25, breastplate: 5.75, martial_tunic: 8.5, leather: 5.75, wyrm_shield: 5.5, chainmail: 3.25 }
    });
    expect(PVP_RAW_MATRIX_V3_METADATA).toEqual({
      evidenceStatus: "designed",
      sourceVersion: "ash_pvp_raw_matrix_v2",
      fullMatrixPresent: true,
      roundingBasis: "ash_provisional",
      derivedRows: {}
    });
  });

  it("maps current families explicitly and fences unsupported equipment", () => {
    expect(resolveV3WeaponProfileForEquipmentFamily(null)).toEqual({ pvpDamageProfileMode: "matrix_v3", profile: "unarmed", compatibilityStatus: null });
    expect(resolveV3WeaponProfileForEquipmentFamily("god_sword").profile).toBe("sword");
    expect(resolveV3WeaponProfileForEquipmentFamily("training_axe").profile).toBe("axe");
    expect(resolveV3WeaponProfileForEquipmentFamily("bow").profile).toBe("longbow");
    expect(resolveV3DefenseProfileForEquipmentFamily("tunic").profile).toBe("martial_tunic");
    expect(resolveV3DefenseProfileForEquipmentFamily("breast_plate").profile).toBe("breastplate");
    expect(resolveV3DefenseProfileForEquipmentFamily("melee_shield")).toEqual({ pvpDamageProfileMode: "matrix_v3", profile: "shield", compatibilityStatus: null });
    expect(resolveV3DefenseProfileForEquipmentFamily("training_shield")).toEqual({ pvpDamageProfileMode: "matrix_v3", profile: "shield", compatibilityStatus: null });
    expect(resolveV3DefenseProfileForEquipmentFamily("ranged_shield")).toEqual({ pvpDamageProfileMode: "matrix_v3", profile: "wyrm_shield", compatibilityStatus: null });
    expect(resolveV3WeaponProfileForEquipmentFamily("wand")).toEqual({ pvpDamageProfileMode: "matrix_v3", profile: "wand", compatibilityStatus: null });
    expect(resolveV3WeaponProfileForEquipmentFamily("starter_wand")).toEqual({ pvpDamageProfileMode: "matrix_v3", profile: "wand", compatibilityStatus: null });
    expect(resolveV3WeaponProfileForEquipmentFamily("hammer")).toEqual({ pvpDamageProfileMode: "matrix_v3", profile: "axe", compatibilityStatus: null });
    expect(resolveV3DefenseProfileForEquipmentFamily("chain_mail")).toEqual({ pvpDamageProfileMode: "matrix_v3", profile: "chainmail", compatibilityStatus: null });
    expect(resolveV3DefenseProfileForEquipmentFamily("chain_armor").profile).toBe("chainmail");
    expect(resolveV3DefenseProfileForEquipmentFamily("wyrm_scalemail").pvpDamageProfileMode).toBe("compatibility_v1");
  });

  it("preserves fractions through additive modifiers and rounds once at the end", () => {
    const resolution = resolveDamageMatrixV3({
      weaponProfile: "axe",
      bodyDefenseProfile: "unarmored",
      weaponUpgrade: 0.25,
      flatAttack: 0.25,
      otherAdditiveModifier: 0.15,
      multiplier: 1.5
    });
    expect(resolution.bodyRawDamage).toBeCloseTo(16.725);
    expect(resolution.selectedRawDamage).toBeCloseTo(16.725);
    expect(resolution.finalDamage).toBe(17);
  });

  it("keeps shield combination outside matrix data and chooses minimum raw damage", () => {
    const resolution = resolveDamageMatrixV3({
      weaponProfile: "axe",
      bodyDefenseProfile: "breastplate",
      shieldDefenseProfile: "shield",
      flatDefense: 0.25
    });
    expect(ASH_V3_PROVISIONAL_SHIELD_COMBINATION).toBe("minimum_damage");
    expect(combineV3BodyAndShieldDamage(4, 9)).toBe(4);
    expect(resolution.bodyRawDamage).toBe(4);
    expect(resolution.shieldRawDamage).toBe(9);
    expect(resolution.selectedRawDamage).toBe(4);
    expect(resolution.finalDamage).toBe(4);
  });

  it("applies body and shield specialization defense only to their matching profiles", () => {
    const resolution = resolveDamageMatrixV3({
      weaponProfile: "axe",
      bodyDefenseProfile: "breastplate",
      shieldDefenseProfile: "shield",
      flatBodyDefense: 1,
      flatShieldDefense: 2
    });
    expect(resolution.bodyRawDamage).toBeCloseTo(3.25);
    expect(resolution.shieldRawDamage).toBeCloseTo(7.25);
    expect(resolution.finalDamage).toBe(3);
  });

  it("normalizes only once with a minimum of one", () => {
    expect(normalizeV3NormalWeaponDamage(10.1)).toBe(10);
    expect(normalizeV3NormalWeaponDamage(10.5)).toBe(11);
    expect(normalizeV3NormalWeaponDamage(-20.75)).toBe(1);
  });
});
