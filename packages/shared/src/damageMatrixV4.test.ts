import { describe, expect, it } from "vitest";

import {
  DAMAGE_MATRIX_V4,
  damageV4LevelFactor,
  resolveDamageMatrixV4,
  resolveV4DefenseForEquipmentFamily,
  resolveV4WeaponProfileForEquipmentFamily,
  WEAPON_PROFILES_V4
} from "./damageMatrixV4.js";

describe("damage matrix v4", () => {
  it("holds the spec table (class-roster-v2.md 6.2)", () => {
    expect(DAMAGE_MATRIX_V4.slash).toEqual({ unarmoured: 1.5, cloth: 1.3, leather: 1.15, mail: 0.7, plate: 0.6, bone: 0.75, spirit: 0.6, ooze: 0.75, bark: 1.25 });
    expect(DAMAGE_MATRIX_V4.pierce).toEqual({ unarmoured: 1.4, cloth: 1.2, leather: 1.15, mail: 1, plate: 0.8, bone: 0.5, spirit: 0.6, ooze: 0.75, bark: 0.5 });
    expect(DAMAGE_MATRIX_V4.blunt).toEqual({ unarmoured: 1.25, cloth: 1.1, leather: 1, mail: 1.1, plate: 1.15, bone: 1.5, spirit: 0.6, ooze: 0.5, bark: 0.75 });
    expect(DAMAGE_MATRIX_V4.radiant).toEqual({ unarmoured: 1.25, cloth: 1, leather: 1, mail: 1, plate: 1, bone: 1.4, spirit: 1.5, ooze: 1, bark: 1 });
    expect(DAMAGE_MATRIX_V4.arcane).toEqual({ unarmoured: 1.25, cloth: 1, leather: 1, mail: 1.05, plate: 1.05, bone: 1, spirit: 1.15, ooze: 1.25, bark: 1.25 });
  });

  it("uses +-5% per level, capped at +-50%", () => {
    expect(damageV4LevelFactor(5, 5)).toBe(1);
    expect(damageV4LevelFactor(8, 5)).toBeCloseTo(1.15);
    expect(damageV4LevelFactor(2, 5)).toBeCloseTo(0.85);
    expect(damageV4LevelFactor(25, 0)).toBe(1.5);
    expect(damageV4LevelFactor(0, 25)).toBe(0.5);
  });

  it("maps weapon families to damage types and spec bases", () => {
    const stats = (family: string | null) => WEAPON_PROFILES_V4[resolveV4WeaponProfileForEquipmentFamily(family)!];
    expect(stats("sword")).toEqual({ damageType: "slash", baseDamage: 8 });
    expect(stats("axe")).toEqual({ damageType: "slash", baseDamage: 10 });
    expect(stats("hammer")).toEqual({ damageType: "blunt", baseDamage: 9 });
    expect(stats("bow")).toEqual({ damageType: "pierce", baseDamage: 7 });
    expect(stats("scepter")).toEqual({ damageType: "radiant", baseDamage: 6 });
    expect(stats("staff")).toEqual({ damageType: "arcane", baseDamage: 7 });
    expect(stats("wand").damageType).toBe("arcane");
    for (const family of ["spear", "dagger", "crossbow", "shuriken", "blowdart"]) expect(stats(family).damageType).toBe("pierce");
    for (const family of ["sling", "brass_knuckles"]) expect(stats(family).damageType).toBe("blunt");
    expect(stats(null).damageType).toBe("blunt");
    expect(resolveV4WeaponProfileForEquipmentFamily("not_a_weapon")).toBeNull();
  });

  it("maps player body armour and shields", () => {
    expect(resolveV4DefenseForEquipmentFamily(null)).toEqual({ kind: "body", armourType: "unarmoured" });
    expect(resolveV4DefenseForEquipmentFamily("tunic")).toEqual({ kind: "body", armourType: "cloth" });
    expect(resolveV4DefenseForEquipmentFamily("leather")).toEqual({ kind: "body", armourType: "leather" });
    expect(resolveV4DefenseForEquipmentFamily("chain_mail")).toEqual({ kind: "body", armourType: "mail" });
    expect(resolveV4DefenseForEquipmentFamily("breastplate")).toEqual({ kind: "body", armourType: "plate" });
    expect(resolveV4DefenseForEquipmentFamily("melee_shield")).toEqual({ kind: "shield" });
    expect(resolveV4DefenseForEquipmentFamily("ranged_shield")).toEqual({ kind: "shield" });
    expect(resolveV4DefenseForEquipmentFamily("wyrm_scalemail")).toBeNull();
  });

  it("resolves base x multiplier x level x swing factor, floored at 1", () => {
    // Sword finisher into leather, equal level: 8 x 1.15 x 1 x 0.75 = 6.9 -> 7.
    expect(resolveDamageMatrixV4({ damageType: "slash", baseDamage: 8, armourType: "leather", attackerLevel: 3, defenderLevel: 3, multiplier: 0.75 }).finalDamage).toBe(7);
    // Two levels above: x1.1.
    expect(resolveDamageMatrixV4({ damageType: "blunt", baseDamage: 9, armourType: "bone", attackerLevel: 5, defenderLevel: 3 }).selectedRawDamage).toBeCloseTo(9 * 1.5 * 1.1);
    // Flat attack adds to the base before the multipliers.
    expect(resolveDamageMatrixV4({ damageType: "slash", baseDamage: 8, flatAttack: 2, armourType: "unarmoured", attackerLevel: 0, defenderLevel: 0 }).finalDamage).toBe(15);
    expect(resolveDamageMatrixV4({ damageType: "slash", baseDamage: 8, armourType: "plate", attackerLevel: 0, defenderLevel: 0, multiplier: 0 }).finalDamage).toBe(1);
  });

  it("keeps the provisional shield rule: the lower of body and shield (plate column)", () => {
    const cloth = resolveDamageMatrixV4({ damageType: "slash", baseDamage: 8, armourType: "cloth", shielded: true, attackerLevel: 4, defenderLevel: 4, shieldLevel: 4 });
    expect(cloth.bodyRawDamage).toBeCloseTo(8 * 1.3);
    expect(cloth.shieldRawDamage).toBeCloseTo(8 * 0.6);
    expect(cloth.finalDamage).toBe(5);
    const blunt = resolveDamageMatrixV4({ damageType: "blunt", baseDamage: 9, armourType: "leather", shielded: true, attackerLevel: 0, defenderLevel: 0 });
    expect(blunt.selectedRawDamage).toBe(blunt.bodyRawDamage);
  });
});
