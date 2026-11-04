import type { ClassCombatState, ClassSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { withLiveClassCombatState } from "./combatEquipmentRealtimeOperations.js";

const rage = {
  classId: "druid", resourceId: "rage", displayName: "Rage",
  current: 100, maximum: 100, reserved: 0, updatedAt: new Date(0).toISOString()
} as const;
const focus = { ...rage, classId: "hunter", resourceId: "focus", displayName: "Focus" } as const;
const snapshot: ClassSnapshot = {
  playerId: "player-1", characterLevel: 0, activeSubclassId: null,
  warrior: { classId: "warrior", level: 0, xp: 0, nextLevelXp: 100, completedAt: null },
  subclasses: [], legacyIds: [], revision: 1,
  loadout: { resetActives: [], normalActives: [], passiveTiers: [], ultimateActive: null },
  activeClassId: "druid", resource: rage, resources: [rage, focus],
  cooldownEndsAt: {}, queuedAbility: null, rage: 100, maximumRage: 100, serverTime: 0
};
const live: ClassCombatState = {
  activeClassId: "druid", rage: 0, maximumRage: 0, reservedRage: 0,
  guard: 0, bloodlust: 0,
  queuedAbility: { abilityId: "druid_rejuvenation", targetEntityId: null, queuedAtTick: 12 },
  cooldownEndsAt: { druid_rejuvenation: 8_000 }
};

describe("live class snapshot projection", () => {
  it("projects resource-free cooldowns and queues while removing only obsolete active resources", () => {
    const result = withLiveClassCombatState(snapshot, live);
    expect(result).toMatchObject({
      cooldownEndsAt: live.cooldownEndsAt, rage: 0, maximumRage: 0,
      queuedAbility: { ...live.queuedAbility, reservedRage: 0, reservedResource: 0 },
      resources: [focus]
    });
    expect(result).not.toHaveProperty("resource");
    expect(result.serverTime).toBeGreaterThan(0);
    expect(snapshot.resource).toBe(rage);
    expect(snapshot.cooldownEndsAt).toEqual({});
  });

  it("preserves live resource projection for resource-based classes", () => {
    const result = withLiveClassCombatState({ ...snapshot, activeClassId: "hunter", resource: focus }, {
      ...live, activeClassId: "hunter", rage: 40, maximumRage: 100, reservedRage: 5,
      resource: { resourceId: "focus", displayName: "Focus", current: 40, maximum: 100, reserved: 5 }
    });
    expect(result.resource).toMatchObject({ classId: "hunter", current: 40, reserved: 5 });
    expect(result.resources).toEqual([rage, result.resource]);
    expect(result.queuedAbility).toMatchObject({ reservedRage: 5, reservedResource: 5 });
    expect(result.cooldownEndsAt).toEqual(live.cooldownEndsAt);
  });

  it("leaves a different active class snapshot unchanged", () => {
    expect(withLiveClassCombatState(snapshot, { ...live, activeClassId: "hunter" })).toBe(snapshot);
  });
});
