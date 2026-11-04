import { describe, expect, it } from "vitest";

import {
  CITY_TOWER_UPGRADE_COST,
  KINGDOM_TOWER_LADDER,
  personalGuardTowerHealth,
  personalGuardTowerUpgradeCost,
  structureWarfareHealthForReinforcementLevel,
  structureWarfareProfileForFlag,
  towerAttackDamageAgainstPlayer,
  towerAttackDamageMultiplier
} from "./structureWarfare.js";

describe("tower ladders", () => {
  it("climbs the personal Guard Tower from 2,700 HP at level 1 to 13,260 HP at level 25", () => {
    expect(personalGuardTowerHealth(1)).toBe(2_700);
    expect(personalGuardTowerHealth(2)).toBe(3_140);
    expect(personalGuardTowerHealth(25)).toBe(13_260);
    expect(structureWarfareHealthForReinforcementLevel(3)).toBe(2_700);
    expect(structureWarfareHealthForReinforcementLevel(3, 10)).toBe(6_660);
    expect(structureWarfareHealthForReinforcementLevel(3, 26)).toBeNull();
    const tower = structureWarfareProfileForFlag({ controlType: "personal", reinforcementLevel: 3, towerLevel: 25 });
    expect(tower).toMatchObject({ kind: "tower", maximumHealth: 13_260, burnThreshold: 6_630, towerLevel: 25 });
  });

  it("charges 12 x target level Iron Ore plus 30 stone per Guard Tower level", () => {
    expect(personalGuardTowerUpgradeCost(1)).toBeNull();
    expect(personalGuardTowerUpgradeCost(2)).toMatchObject({ iron: 24, stone: 30 });
    expect(personalGuardTowerUpgradeCost(25)).toMatchObject({ iron: 300, stone: 30 });
    expect(personalGuardTowerUpgradeCost(26)).toBeNull();
  });

  it("gives the City Tower 36,500 HP and Kingdom Towers 11.5k..57.5k with 27 h burns", () => {
    expect(CITY_TOWER_UPGRADE_COST).toEqual({ cityCoins: 12_000, stone: 600 });
    const cityTower = structureWarfareProfileForFlag({ controlType: "city", cityId: "c", towerLevel: 1 });
    expect(cityTower).toMatchObject({ kind: "city_tower", maximumHealth: 36_500, burnDurationMs: 97_200_000, mustBurn: true });
    expect(structureWarfareProfileForFlag({ controlType: "city", cityId: "c", towerLevel: 2 })).toBeNull();
    expect(KINGDOM_TOWER_LADDER.map((rung) => rung.maximumHealth)).toEqual([11_500, 23_000, 34_500, 46_000, 57_500]);
    for (const rung of KINGDOM_TOWER_LADDER) {
      expect(structureWarfareProfileForFlag({ controlType: "kingdom", kingdomId: "k", towerLevel: rung.level }))
        .toMatchObject({ kind: "kingdom_tower", maximumHealth: rung.maximumHealth, burnDurationMs: 97_200_000 });
    }
  });

  it("uses the Guard Tower matrix row and the organization level multiplier", () => {
    expect(towerAttackDamageAgainstPlayer("unarmored", null, 1)).toBe(22);
    expect(towerAttackDamageAgainstPlayer("chainmail", null, 1)).toBe(16);
    expect(towerAttackDamageAgainstPlayer("unarmored", "shield", 1)).toBe(13);
    expect(towerAttackDamageMultiplier({ kind: "tower", towerLevel: 25 })).toBe(1);
    expect(towerAttackDamageMultiplier({ kind: "city_tower", towerLevel: 1 })).toBe(1);
    expect(towerAttackDamageMultiplier({ kind: "kingdom_tower", towerLevel: 5 })).toBeCloseTo(1.8);
    expect(towerAttackDamageAgainstPlayer("martial_tunic", null, 2)).toBe(28);
  });
});
