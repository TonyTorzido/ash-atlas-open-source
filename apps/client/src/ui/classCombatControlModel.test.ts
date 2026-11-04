import { describe, expect, it } from "vitest";

import type { ClassSnapshot } from "@ash-atlas/shared";

import { buildClassCombatControlModel, classResourceProgress } from "./classCombatControlModel.js";

describe("classResourceProgress", () => {
  it.each([
    [0, 20, 0],
    [5, 20, 0.25],
    [15, 20, 0.75],
    [20, 20, 1],
    [40, 20, 1],
    [15, 30, 0.5]
  ])("normalizes %s of %s to %s", (amount, cost, expected) => {
    expect(classResourceProgress(amount, cost)).toBe(expected);
  });

  it("does not create a perimeter value for zero-cost abilities", () => {
    expect(classResourceProgress(100, 0)).toBeNull();
  });

  it("keeps selected single-target support ready outside combat", () => {
    const model = buildClassCombatControlModel({
      snapshot: druidSnapshot(),
      combat: {
        activeClassId: "druid",
        rage: 0,
        maximumRage: 0,
        reservedRage: 0,
        guard: 0,
        bloodlust: 0,
        queuedAbility: null,
        cooldownEndsAt: {}
      },
      equipmentAvailable: true,
      pveCombat: null,
      disabled: false,
      targetSelection: {
        mode: "friendly",
        targetEntityId: "ally",
        friendlyTargetEntityId: "ally"
      },
      friendlyTargets: [{ entityId: "ally", label: "Ally", available: true }],
      serverNow: 1
    });

    expect(model.normalSlots[0]).toMatchObject({
      id: "druid_regrowth",
      disabled: false,
      singleTargetSupport: true,
      selfTargetAvailable: true,
      target: { mode: "friendly", targetEntityId: "ally" }
    });
  });

  it("models the dedicated Ultimate, activation lockout, Armed waiting state, and readable statuses", () => {
    const snapshot = druidSnapshot();
    snapshot.activeClassId = "warrior";
    snapshot.classes = [{ classId: "warrior", level: 15, xp: 0, nextLevelXp: null, completedAt: null }];
    snapshot.loadout = {
      resetActives: [null, null],
      normalActives: ["warrior_v2_sundering_arc", "warrior_v2_iron_reversal"],
      passiveTiers: [null, null, null],
      ultimateActive: "warrior_v2_worldbreaker"
    };
    const model = buildClassCombatControlModel({
      snapshot,
      combat: {
        activeClassId: "warrior", rage: 0, maximumRage: 0, reservedRage: 0, guard: 0, bloodlust: 0,
        queuedAbility: { abilityId: "warrior_v2_sundering_arc", targetEntityId: "mob", queuedAtTick: 1 },
        cooldownEndsAt: {},
        statusIndicators: [{ id: "flow", label: "Flow", stacks: 2, endsAt: 2_500 }]
      },
      equipmentAvailable: true,
      weaponCategory: "axe",
      pveCombat: {} as never,
      disabled: false,
      serverNow: 1_000,
      activationLockoutEndsAt: 1_600
    });

    expect(model.normalSlots[0]).toMatchObject({ activation: "armed", pending: true });
    expect("ultimateSlot" in model).toBe(false);
    expect(model.activationLockoutMs).toBe(600);
    expect(model.statusIndicators).toEqual([{ id: "flow", text: "Flow ×2", remainingMs: 1_500 }]);
  });

  it("accepts instant and drag hostile PvP actions without PvE while preserving no-target guards", () => {
    const snapshot = ninjaSnapshot();
    const common = {
      snapshot,
      combat: {
        activeClassId: "ninja" as const,
        rage: 0,
        maximumRage: 0,
        reservedRage: 0,
        guard: 0,
        bloodlust: 0,
        queuedAbility: null,
        cooldownEndsAt: {}
      },
      equipmentAvailable: true,
      weaponCategory: "shuriken" as const,
      pveCombat: null,
      disabled: false,
      serverNow: 1
    };
    const pvpModel = buildClassCombatControlModel({
      ...common,
      targetSelection: { mode: "hostile", targetEntityId: "player:rival" }
    });

    expect(pvpModel.normalSlots[0]).toMatchObject({
      id: "ninja_v2_twin_fang",
      disabled: false,
      activation: "instant",
      target: { mode: "hostile", targetEntityId: "player:rival" }
    });
    expect(pvpModel.normalSlots[1]).toMatchObject({
      id: "ninja_v2_shadowstep",
      disabled: false,
      activation: "drag"
    });

    const noTargetModel = buildClassCombatControlModel(common);
    expect(noTargetModel.normalSlots[0]).toMatchObject({
      disabled: true,
      unavailableText: "Target unavailable"
    });
  });
});

function druidSnapshot(): ClassSnapshot {
  const progress = { classId: "druid" as const, level: 11, xp: 0, nextLevelXp: 1, completedAt: null };
  return {
    playerId: "self",
    characterLevel: 25,
    activeClassId: "druid",
    activeSubclassId: null,
    warrior: { ...progress, classId: "warrior" },
    classes: [progress],
    subclasses: [],
    loadout: {
      resetActives: [null, null],
      normalActives: ["druid_regrowth", null],
      passiveTiers: [null, null, null],
      ultimateActive: null
    },
    legacyIds: [],
    rage: 0,
    maximumRage: 0,
    queuedAbility: null,
    cooldownEndsAt: {},
    serverTime: 1,
    revision: 1
  } as unknown as ClassSnapshot;
}

function ninjaSnapshot(): ClassSnapshot {
  return {
    ...druidSnapshot(),
    activeClassId: "ninja",
    classes: [{ classId: "ninja", level: 15, xp: 0, nextLevelXp: null, completedAt: null }],
    loadout: {
      resetActives: [null, null],
      normalActives: ["ninja_v2_twin_fang", "ninja_v2_shadowstep"],
      passiveTiers: [null, null, null],
      ultimateActive: "ninja_v2_thousand_shadows"
    }
  } as unknown as ClassSnapshot;
}
