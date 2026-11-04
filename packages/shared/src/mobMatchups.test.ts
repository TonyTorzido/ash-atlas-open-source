import { describe, expect, it } from "vitest";

import { PVP_RAW_MATRIX_V3 } from "./damageMatrixV3.js";
import { MOB_ARCHETYPE_KEYS, mobTemplateOf } from "./mobContracts.js";
import {
  MATCHUP_ARMOR_TYPE_LABELS,
  MATCHUP_WEAPON_TYPE_LABELS,
  MOB_MATCHUPS,
  MOB_HEALTH_UNIT,
  equalLevelSwordHit,
  equalLevelSwordSwings,
  resolveMatchupDamage
} from "./mobMatchups.js";

describe("universal weapon x armor matchups", () => {
  it("declares a labelled matchup for every archetype on the universal table", () => {
    expect(Object.keys(MOB_MATCHUPS).sort()).toEqual([...MOB_ARCHETYPE_KEYS].sort());
    for (const matchup of Object.values(MOB_MATCHUPS)) {
      expect(PVP_RAW_MATRIX_V3[matchup.weaponType][matchup.armorType]).toBeTypeOf("number");
      expect(MATCHUP_WEAPON_TYPE_LABELS[matchup.weaponType]).toBeTruthy();
      expect(MATCHUP_ARMOR_TYPE_LABELS[matchup.armorType]).toBeTruthy();
      expect(matchup.weaponName.length).toBeGreaterThan(0);
      expect(matchup.armorName.length).toBeGreaterThan(0);
    }
  });

  it("keeps normal mobs at 1.0 and only scales bosses and the Jellyfish sting", () => {
    // Template mobs may take their tier's multiplier (1.25 at tier 4, 1.5 at tier 5).
    const templated = Object.entries(MOB_MATCHUPS).filter(([key]) => mobTemplateOf(key) !== null);
    for (const [key, matchup] of templated) {
      expect([1, 1.25, 1.5], key).toContain(matchup.damageMultiplier);
    }
    const scaled = Object.fromEntries(Object.entries(MOB_MATCHUPS)
      .filter(([key, matchup]) => matchup.damageMultiplier !== 1 && mobTemplateOf(key) === null)
      .map(([key, matchup]) => [key, matchup.damageMultiplier]));
    expect(scaled).toEqual({
      mysterious_traveler: 1.5,
      fire_bird: 1.5,
      lightning_bird: 1.5,
      ice_bird: 1.5,
      xoral: 2,
      jellyfish: 0,
      // Dungeon final bosses (placeholder matchups).
      brood_matriarch: 1.5,
      granite_bull: 1.5,
      corrupted_core: 1.5,
      forgemaster: 1.5,
      raptor_chieftain: 1.5,
      thunderwing: 1.5,
      hollow_elder: 1.5,
      centurion: 1.5,
      brood_matron: 1.5,
      trifang_warden: 1.5,
      elder_dragon: 1.5,
      the_watcher: 1.5,
      tidemaw: 1.5,
      drowned_admiral: 1.5,
      abyssal_one: 1.5,
      grandmaster: 1.5,
      // Tilted Vault elite (tier-4 multiplier).
      vault_warden: 1.25
    });
    expect(MOB_MATCHUPS.wolf).toMatchObject({
      weaponName: "Bite", weaponType: "dagger", armorName: "Fur", armorType: "martial_tunic"
    });
  });

  it("applies the level rule, the shield minimum, and the floor of 1", () => {
    const hit = (attackerLevel: number, defenderLevel: number) => resolveMatchupDamage({
      weaponType: "sword", armorType: "leather", attackerLevel, defenderLevel
    }).finalDamage;
    expect(hit(10, 10)).toBe(9);
    expect(hit(13, 10)).toBe(12);
    expect(hit(10, 14)).toBe(5);
    expect(hit(0, 30)).toBe(1);
    expect(resolveMatchupDamage({
      weaponType: "longbow", armorType: "unarmored", shieldType: "shield",
      attackerLevel: 5, defenderLevel: 0, shieldLevel: 5
    })).toMatchObject({ bodyRawDamage: 11.5, shieldRawDamage: 0.25, finalDamage: 1 });
  });

  it("measures health in neutral hits and swings in sword hits into the armor type", () => {
    expect(MOB_HEALTH_UNIT).toBe(9);
    // A wolf's 27 health (3 neutral hits) takes 4 sword swings through Fur (Tunic, 8).
    expect(equalLevelSwordSwings(27, "martial_tunic")).toBe(4);
    expect(equalLevelSwordHit("unarmored")).toBe(9);
    expect(equalLevelSwordHit("leather")).toBe(9);
    expect(equalLevelSwordHit("breastplate")).toBe(4);
    expect(equalLevelSwordHit("chainmail")).toBe(3);
    expect(equalLevelSwordHit("martial_tunic")).toBe(8);
  });
});
