import { describe, expect, it } from "vitest";

import {
  DAMAGE_ARMOR_TYPES,
  DAMAGE_MATRIX_V1,
  DAMAGE_WEAPON_TYPES,
  SHIELD_DAMAGE_MATRIX_V1,
  resolveDamageMatrixV1
} from "./damageMatrix.js";

describe("Damage Matrix V1", () => {
  it("contains the exact authoritative weapon-versus-armor values", () => {
    expect(DAMAGE_MATRIX_V1).toEqual({
      axe: { naked: 11, tunic: 10, leather: 9, chainmail: 8, breastplate: 7 },
      sword: { naked: 10, tunic: 9, leather: 8, chainmail: 7, breastplate: 6 },
      staff: { naked: 9, tunic: 8, leather: 8, chainmail: 8, breastplate: 8 },
      bow: { naked: 8, tunic: 8, leather: 7, chainmail: 6, breastplate: 5 },
      shuriken: { naked: 7, tunic: 7, leather: 6, chainmail: 5, breastplate: 3 },
      wand: { naked: 7, tunic: 7, leather: 7, chainmail: 7, breastplate: 7 }
    });
    expect(SHIELD_DAMAGE_MATRIX_V1).toEqual({
      axe: { melee: 5, ranged: 11 },
      sword: { melee: 4, ranged: 10 },
      staff: { melee: 5, ranged: 9 },
      bow: { melee: 8, ranged: 3 },
      shuriken: { melee: 7, ranged: 2 },
      wand: { melee: 7, ranged: 5 }
    });
  });

  it.each([0, 5, 10, 25])("preserves every baseline at equal +%i upgrades", (upgrade) => {
    for (const weaponType of DAMAGE_WEAPON_TYPES) {
      for (const armorType of DAMAGE_ARMOR_TYPES.filter((type) => type !== "naked")) {
        expect(resolveDamageMatrixV1({
          weaponType,
          weaponUpgrade: upgrade,
          armorType,
          armorUpgrade: upgrade
        }).finalDamage).toBe(DAMAGE_MATRIX_V1[weaponType][armorType]);
      }
      expect(resolveDamageMatrixV1({
        weaponType,
        weaponUpgrade: upgrade,
        armorType: "naked",
        armorUpgrade: upgrade
      }).finalDamage).toBe(DAMAGE_MATRIX_V1[weaponType].naked + upgrade);
    }
  });

  it("applies unequal upgrades and the minimum damage floor", () => {
    expect(resolveDamageMatrixV1({
      weaponType: "sword", weaponUpgrade: 15,
      armorType: "breastplate", armorUpgrade: 10
    }).finalDamage).toBe(11);
    expect(resolveDamageMatrixV1({
      weaponType: "sword", weaponUpgrade: 10,
      armorType: "breastplate", armorUpgrade: 15
    }).finalDamage).toBe(1);
  });

  it.each([
    ["sword", "breastplate", 12, 10, "melee", 5, 8],
    ["sword", "breastplate", 12, 5, "melee", 10, 6],
    ["sword", "breastplate", 0, 0, "ranged", 0, 6],
    ["bow", "chainmail", 0, 0, "ranged", 0, 3],
    ["bow", "chainmail", 0, 0, "melee", 0, 6],
    ["shuriken", "breastplate", 0, 0, "ranged", 0, 2],
    ["axe", "breastplate", 0, 0, "melee", 0, 5],
    ["wand", "leather", 8, 4, "melee", 10, 5],
    ["wand", "leather", 8, 4, "ranged", 10, 3]
  ] as const)(
    "selects the lower independent %s armor and %s shield route",
    (weaponType, armorType, weaponUpgrade, armorUpgrade, shieldType, shieldUpgrade, expected) => {
      expect(resolveDamageMatrixV1({
        weaponType,
        weaponUpgrade,
        armorType,
        armorUpgrade,
        shieldType,
        shieldUpgrade
      }).finalDamage).toBe(expected);
    }
  );

  it("returns whole-number damage", () => {
    const resolution = resolveDamageMatrixV1({
      weaponType: "wand",
      weaponUpgrade: 25,
      armorType: "chainmail",
      armorUpgrade: 17,
      shieldType: "ranged",
      shieldUpgrade: 4
    });
    expect(Number.isInteger(resolution.armorDamage)).toBe(true);
    expect(Number.isInteger(resolution.shieldDamage)).toBe(true);
    expect(Number.isInteger(resolution.finalDamage)).toBe(true);
  });
});
