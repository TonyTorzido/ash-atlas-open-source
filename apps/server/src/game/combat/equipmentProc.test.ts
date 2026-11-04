import { describe, expect, it, vi } from "vitest";

import {
  EQUIPMENT_METAL_DEFINITIONS,
  METAL_PROC_QUALITY_MULTIPLIER_MAX,
  METAL_PROC_QUALITY_MULTIPLIER_MIN,
  metalEquipmentEnhancement,
  mobMetalProcQuality,
  serializeEquipmentEnhancement,
  type EquipmentMetal
} from "@ash-atlas/shared";

import {
  METAL_PROC_BALANCE,
  distinctArmorMetals,
  metalProcChance,
  metalProcHandlers
} from "./metalProcs.js";
import { EquipmentWeaponProcResolver, type EquipmentProcContext } from "./equipmentProc.js";

const BASE_INPUT = {
  combatContext: "pvp_open_world" as const,
  actionSequence: 4,
  attackerEntityId: "player-a",
  targetEntityId: "player-b",
  activeWeaponInstanceId: "weapon-1",
  enchantmentIdentity: null,
  landed: true,
  qualifyingWeaponAttack: true,
  appliedDamage: 12
};

describe("EquipmentWeaponProcResolver", () => {
  it("makes null launch enchantments exact no-ops without consuming randomness", () => {
    const random = vi.fn(() => 0.25);
    const resolver = new EquipmentWeaponProcResolver([], random);

    expect(resolver.resolve(BASE_INPUT)).toEqual({
      statusApplications: [],
      telemetry: {
        rulesetVersion: 1,
        enchantmentIdentity: null,
        evaluated: false,
        triggered: false,
        roll: null,
        reason: "null_enchantment"
      }
    });
    expect(random).not.toHaveBeenCalled();
  });

  it("does not evaluate a swap, miss, or non-weapon action", () => {
    const random = vi.fn(() => 0.25);
    const resolver = new EquipmentWeaponProcResolver([], random);

    expect(resolver.resolve({
      ...BASE_INPUT,
      enchantmentIdentity: "future_material",
      qualifyingWeaponAttack: false
    }).telemetry.reason).toBe("not_weapon_attack");
    expect(resolver.resolve({
      ...BASE_INPUT,
      enchantmentIdentity: "future_material",
      landed: false
    }).telemetry.reason).toBe("not_landed");
    expect(random).not.toHaveBeenCalled();
  });

  it("supports a deterministic future handler without trusting client rolls", () => {
    const resolver = new EquipmentWeaponProcResolver([{
      enchantmentIdentity: "test_only_material",
      resolve: ({ roll, combatContext }) => ({
        triggered: roll < 0.5 && combatContext === "pve",
        statusApplications: [{ statusId: "test_status", applied: roll < 0.5 }]
      })
    }], () => 0.25);

    const result = resolver.resolve({
      ...BASE_INPUT,
      combatContext: "pve",
      enchantmentIdentity: "test_only_material"
    });
    expect(result.telemetry).toMatchObject({
      evaluated: true,
      triggered: true,
      roll: 0.25,
      reason: "resolved"
    });
    expect(result.statusApplications).toEqual([{ statusId: "test_status", applied: true }]);
  });

  const NEUTRAL: EquipmentProcContext = {
    victimHealthFraction: 1, attackerQuality: 0, defenderQuality: 0, killingBlow: false
  };
  const identity = (metal: EquipmentMetal, gem: "ruby" | "opal" | null = "ruby") =>
    serializeEquipmentEnhancement(metalEquipmentEnhancement(gem, metal));

  it.each([
    ["venomsteel", "weapon", 0.22, "poison"],
    ["venomsteel", "armor", 0.13, "poison"],
    ["fire", "weapon", 0.17, "burning"],
    ["fire", "armor", 0.12, "burning"],
    ["ice", "weapon", 0.35, "slow"],
    ["ice", "armor", 0.33, "slow"],
    ["lightning", "weapon", 0.52, "storm"],
    ["lightning", "armor", 0.45, "storm"],
    ["whetted", "weapon", 0.18, "whetted"],
    ["whetted", "armor", 0.08, "whetted"],
    ["mirage", "weapon", 0.35, "blink"],
    ["mirage", "armor", 0.20, "blink"],
    ["gale", "weapon", 0.27, "knockback"],
    ["gale", "armor", 0.24, "knockback"],
    ["fleet", "weapon", 0.34, "steal_speed"],
    ["fleet", "armor", 0.17, "steal_speed"],
    ["vengeance", "weapon", 0.44, "vengeance"],
    ["vengeance", "armor", 0.34, "vengeance"],
    ["skyrise", "weapon", 0.23, "immobilize"],
    ["skyrise", "armor", 0.12, "immobilize"],
    ["vital", "weapon", 0.26, "vitality"],
    ["vital", "armor", 0.18, "vitality"]
  ] as const)("%s %s procs below exactly %s with equal quality", (metal, source, chance, statusId) => {
    expect(metalProcChance(metal, source, NEUTRAL)).toBeCloseTo(chance, 10);
    const make = (roll: number) => new EquipmentWeaponProcResolver(metalProcHandlers(), () => roll);
    const input = {
      ...BASE_INPUT, combatContext: "pve" as const, procSource: source,
      enchantmentIdentity: identity(metal), procContext: NEUTRAL
    };
    expect(make(chance - 1e-9).resolve(input).statusApplications).toEqual([{ statusId, applied: true }]);
    expect(make(chance).resolve(input).statusApplications).toEqual([{ statusId, applied: false }]);
  });

  it("registers gem-less and gemmed identities, but no handler for Dead", () => {
    const resolver = new EquipmentWeaponProcResolver(metalProcHandlers(), () => 0);
    expect(resolver.resolve({ ...BASE_INPUT, enchantmentIdentity: identity("gale", null) }).telemetry.evaluated).toBe(true);
    expect(resolver.resolve({ ...BASE_INPUT, enchantmentIdentity: identity("gale", "opal") }).telemetry.evaluated).toBe(true);
    expect(resolver.resolve({ ...BASE_INPUT, enchantmentIdentity: identity("revenant") }).telemetry.reason).toBe("unsupported");
  });

  it("scales Shade by missing health for weapon and armor alike", () => {
    expect(metalProcChance("gloom", "weapon", { ...NEUTRAL, victimHealthFraction: 1 })).toBeCloseTo(0.22, 10);
    expect(metalProcChance("gloom", "weapon", { ...NEUTRAL, victimHealthFraction: 0.5 })).toBeCloseTo(0.305, 10);
    expect(metalProcChance("gloom", "armor", { ...NEUTRAL, victimHealthFraction: 0 })).toBeCloseTo(0.41, 10);
  });

  it("scales Expel by missing health and always expels on a killing blow", () => {
    expect(metalProcChance("expel", "weapon", { ...NEUTRAL, victimHealthFraction: 1 })).toBe(0);
    expect(metalProcChance("expel", "weapon", { ...NEUTRAL, victimHealthFraction: 0.5 })).toBeCloseTo(0.06, 10);
    expect(metalProcChance("expel", "armor", { ...NEUTRAL, victimHealthFraction: 0.1 })).toBeCloseTo(0.108, 10);
    // Quality never lowers the guaranteed kill expel.
    expect(metalProcChance("expel", "weapon", {
      victimHealthFraction: 0, attackerQuality: 0, defenderQuality: 20, killingBlow: true
    })).toBe(1);
  });

  it("applies the proc quality multiplier (12 + Q1 - Q2) / 12, clamped", () => {
    const base = EQUIPMENT_METAL_DEFINITIONS.venomsteel.weapon.kind === "fixed"
      ? EQUIPMENT_METAL_DEFINITIONS.venomsteel.weapon.chance
      : 0;
    expect(metalProcChance("venomsteel", "weapon", { ...NEUTRAL, attackerQuality: 12, defenderQuality: 10 }))
      .toBeCloseTo(base * (14 / 12), 10);
    expect(metalProcChance("venomsteel", "weapon", { ...NEUTRAL, attackerQuality: 10, defenderQuality: 13 }))
      .toBeCloseTo(base * 0.75, 10);
    expect(metalProcChance("venomsteel", "weapon", { ...NEUTRAL, attackerQuality: 100, defenderQuality: 0 }))
      .toBeCloseTo(base * METAL_PROC_QUALITY_MULTIPLIER_MAX, 10);
    expect(metalProcChance("venomsteel", "weapon", { ...NEUTRAL, attackerQuality: 0, defenderQuality: 100 }))
      .toBeCloseTo(base * METAL_PROC_QUALITY_MULTIPLIER_MIN, 10);
    // The strongest chance (Storm weapon, 52%) tops out at 78% under the 1.5 clamp.
    expect(metalProcChance("lightning", "weapon", { ...NEUTRAL, attackerQuality: 100, defenderQuality: 0 }))
      .toBeCloseTo(0.78, 10);
  });

  it("derives mob quality from level divided by five, rounded", () => {
    expect(mobMetalProcQuality(12)).toBe(2);
    expect(mobMetalProcQuality(13)).toBe(3);
    expect(mobMetalProcQuality(0)).toBe(0);
  });

  it("rolls each distinct armor metal once, using its highest-level piece", () => {
    const pieces = [
      { instanceId: "helm", enchantmentIdentity: identity("venomsteel"), itemLevel: 4 },
      { instanceId: "chest", enchantmentIdentity: identity("venomsteel", null), itemLevel: 9 },
      { instanceId: "shield", enchantmentIdentity: identity("ice"), itemLevel: 2 },
      { instanceId: "boots", enchantmentIdentity: "enh:v1:ruby:prepared", itemLevel: 20 },
      { instanceId: "gloves", enchantmentIdentity: identity("revenant"), itemLevel: 30 }
    ];
    expect(distinctArmorMetals(pieces).map((entry) => [entry.metal, entry.instanceId, entry.itemLevel]))
      .toEqual([["venomsteel", "chest", 9], ["ice", "shield", 2]]);
  });

  it("keeps the tunable numbers in the balance table at their tuned values", () => {
    expect(METAL_PROC_BALANCE.poison).toMatchObject({ damageMin: 3, damageMax: 6, tickMs: 3_200, durationMs: 55_000 });
    expect(METAL_PROC_BALANCE.burning).toMatchObject({ damageMin: 2, damageMax: 5, tickMs: 3_300, durationMs: 27_000 });
    expect(METAL_PROC_BALANCE.storm).toMatchObject({ pulseMs: 4_500, radiusM: 230, durationMs: 27_000 });
    expect(METAL_PROC_BALANCE.frost).toMatchObject({ slowFraction: 0.45, dodgeMultiplier: 0.88 });
  });
});
