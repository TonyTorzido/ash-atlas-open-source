import { describe, expect, it } from "vitest";

import {
  kingdomBrickDepositSplit,
  kingdomBrickFurnaceLevel,
  kingdomBrickYieldMultiplier,
  kingdomBrickYieldQuantity
} from "./kingdomBricks.js";
import { kingdomStructureBuildCost, structureWarfareProfileForFlag } from "./structureWarfare.js";

describe("kingdom bricks", () => {
  it("taxes deposits 12%, rounded up, and refuses a deposit that would credit nothing", () => {
    expect(kingdomBrickDepositSplit(100)).toEqual({ quantity: 100, tax: 12, credited: 88 });
    expect(kingdomBrickDepositSplit(9)).toEqual({ quantity: 9, tax: 2, credited: 7 });
    expect(kingdomBrickDepositSplit(1)).toBeNull();
    expect(kingdomBrickDepositSplit(0)).toBeNull();
  });

  it("follows the obelisk and Kingdom Tower step-cost ladders", () => {
    expect([1, 2, 3, 4, 5].map((level) => kingdomStructureBuildCost("obelisk", level))).toMatchObject([
      { bricks: 2_200, materialItemId: "crude_oil", materialQuantity: 1_100, maximumHealth: 2_300 },
      { bricks: 6_400, materialQuantity: 3_300, maximumHealth: 4_600 },
      { bricks: 21_000, materialQuantity: 9_500, maximumHealth: 6_900 },
      { bricks: 62_000, materialQuantity: 32_000, maximumHealth: 9_200 },
      { bricks: 190_000, materialQuantity: 95_000, maximumHealth: 11_500 }
    ]);
    expect([1, 2, 3, 4, 5].map((level) => kingdomStructureBuildCost("kingdom_tower", level)?.materialQuantity))
      .toEqual([240, 660, 2_300, 6_500, 18_500]);
    expect(kingdomStructureBuildCost("obelisk", 6)).toBeNull();
    expect(kingdomStructureBuildCost("kingdom_tower", 0)).toBeNull();
    expect(structureWarfareProfileForFlag({ controlType: "kingdom", kingdomId: "k", obeliskLevel: 3 }))
      .toMatchObject({ kind: "kingdom_obelisk", maximumHealth: 6_900, burnThreshold: 3_450, obeliskLevel: 3 });
    // Never both a tower and an obelisk; never on another control type.
    expect(structureWarfareProfileForFlag({ controlType: "kingdom", kingdomId: "k", obeliskLevel: 1, towerLevel: 1 }))
      .toBeNull();
    expect(structureWarfareProfileForFlag({ controlType: "city", cityId: "c", obeliskLevel: 1 })).toBeNull();
  });

  it("multiplies brick yield by the obelisk level, more for members", () => {
    expect(kingdomBrickYieldMultiplier(null, true)).toBe(1);
    expect(kingdomBrickYieldMultiplier(1, false)).toBe(1);
    expect(kingdomBrickYieldMultiplier(1, true)).toBe(2);
    expect(kingdomBrickYieldMultiplier(5, false)).toBe(5);
    expect(kingdomBrickYieldMultiplier(5, true)).toBe(8);
    expect(kingdomBrickYieldQuantity(0.05, 5, true)).toBe(8);
    expect(kingdomBrickYieldQuantity(0.5, 5, true)).toBe(0);
    // Boundary Writ widens the roll to 25% on war land.
    expect(kingdomBrickYieldQuantity(0.15, 5, false)).toBe(0);
    expect(kingdomBrickYieldQuantity(0.15, 5, false, 0.25)).toBe(5);
    expect(kingdomBrickYieldQuantity(0.25, 5, false, 0.25)).toBe(0);
    expect(kingdomBrickFurnaceLevel(3)).toMatchObject({ upgradeGlimmerOil: 3_400, packageBricks: 1_300, packageGlimmerOil: 13 });
    expect(kingdomBrickFurnaceLevel(4)).toBeNull();
  });
});
