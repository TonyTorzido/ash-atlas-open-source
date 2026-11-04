import { describe, expect, it } from "vitest";

import { isEquipmentBroken } from "./equipmentRepair.js";

describe("isEquipmentBroken", () => {
  it("is true only for chest armour at condition 0", () => {
    expect(isEquipmentBroken({ category: "chest_armor", condition: 0 })).toBe(true);
    expect(isEquipmentBroken({ category: "chest_armor", condition: 1 })).toBe(false);
    expect(isEquipmentBroken({ category: "chest_armor", condition: null })).toBe(false);
    expect(isEquipmentBroken({ category: "melee_weapon", condition: 0 })).toBe(false);
  });
});
