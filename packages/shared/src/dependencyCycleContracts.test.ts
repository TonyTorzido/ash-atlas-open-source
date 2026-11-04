import { describe, expect, it } from "vitest";

import {
  CLASS_IDS as CONTRACT_CLASS_IDS,
  SUBCLASS_IDS as CONTRACT_SUBCLASS_IDS,
  WEAPON_CATEGORIES as CONTRACT_WEAPON_CATEGORIES
} from "./classContracts.js";
import { CLASS_IDS, SUBCLASS_IDS, WEAPON_CATEGORIES } from "./classes.js";
import {
  BASIC_ATTACK_INTERVAL_MS as CONTRACT_BASIC_ATTACK_INTERVAL_MS,
  MELEE_ATTACK_RANGE_M as CONTRACT_MELEE_ATTACK_RANGE_M,
  RANGED_ATTACK_RANGE_M as CONTRACT_RANGED_ATTACK_RANGE_M
} from "./combatConstants.js";
import {
  BASIC_ATTACK_INTERVAL_MS,
  MELEE_ATTACK_RANGE_M,
  RANGED_ATTACK_RANGE_M
} from "./combat.js";
import { COMBAT_CONTEXTS as CONTRACT_COMBAT_CONTEXTS } from "./equipmentBalanceContracts.js";
import { COMBAT_CONTEXTS } from "./equipmentBalance.js";
import {
  EQUIPMENT_CATEGORIES as CONTRACT_EQUIPMENT_CATEGORIES,
  EQUIPMENT_SLOTS as CONTRACT_EQUIPMENT_SLOTS,
  READIED_WEAPON_SLOTS as CONTRACT_READIED_WEAPON_SLOTS
} from "./equipmentContracts.js";
import {
  EQUIPMENT_BALANCE_VERSION,
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_SLOTS,
  READIED_WEAPON_SLOTS
} from "./equipment.js";

describe("neutral dependency-cycle contracts", () => {
  it("preserves class and combat compatibility exports exactly", () => {
    expect(CLASS_IDS).toBe(CONTRACT_CLASS_IDS);
    expect(SUBCLASS_IDS).toBe(CONTRACT_SUBCLASS_IDS);
    expect(WEAPON_CATEGORIES).toBe(CONTRACT_WEAPON_CATEGORIES);
    expect(CLASS_IDS).toEqual([
      "warrior", "druid", "ranger", "knight", "ninja", "hunter"
    ]);
    expect(SUBCLASS_IDS).toHaveLength(4);
    expect(BASIC_ATTACK_INTERVAL_MS).toBe(CONTRACT_BASIC_ATTACK_INTERVAL_MS);
    expect(MELEE_ATTACK_RANGE_M).toBe(CONTRACT_MELEE_ATTACK_RANGE_M);
    expect(RANGED_ATTACK_RANGE_M).toBe(CONTRACT_RANGED_ATTACK_RANGE_M);
    expect([BASIC_ATTACK_INTERVAL_MS, MELEE_ATTACK_RANGE_M, RANGED_ATTACK_RANGE_M])
      .toEqual([1_400, 100, 300]);
  });

  it("preserves equipment and balance compatibility exports exactly", () => {
    expect(EQUIPMENT_SLOTS).toBe(CONTRACT_EQUIPMENT_SLOTS);
    expect(EQUIPMENT_CATEGORIES).toBe(CONTRACT_EQUIPMENT_CATEGORIES);
    expect(READIED_WEAPON_SLOTS).toBe(CONTRACT_READIED_WEAPON_SLOTS);
    expect(COMBAT_CONTEXTS).toBe(CONTRACT_COMBAT_CONTEXTS);
    expect(EQUIPMENT_BALANCE_VERSION).toBe(2);
    expect(EQUIPMENT_SLOTS).toEqual([
      "head", "chest", "gloves", "boots", "ring", "ring_2", "melee", "secondary", "tool_axe", "tool_pickaxe", "tool_fishing_pole"
    ]);
    expect(READIED_WEAPON_SLOTS).toEqual(["melee", "secondary"]);
    expect(COMBAT_CONTEXTS).toEqual([
      "pve", "pvp_open_world", "pvp_ranked", "pvp_training"
    ]);
  });
});
