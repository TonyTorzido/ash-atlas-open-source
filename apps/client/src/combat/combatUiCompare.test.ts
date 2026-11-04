import { describe, expect, it } from "vitest";
import type { CombatEntitySnapshot } from "@ash-atlas/shared";
import { deepEqualJson, sameLocalCombatUi, sameSelectedCombatUi } from "./combatUiCompare.js";

function mob(overrides: Partial<CombatEntitySnapshot> = {}): CombatEntitySnapshot {
  return {
    entityId: "mob-1", kind: "mob", archetypeKey: null, name: "Wolf", level: 3, regionCode: "r", zoneId: "z",
    lat: 1, lon: 2, maxHealth: 100, currentHealth: 100, lifeState: "alive", activityState: "idle",
    targetEntityId: null, revision: 1, ...overrides
  } as CombatEntitySnapshot;
}

describe("combat UI compares", () => {
  it("ignores position and revision on the selected target", () => {
    expect(sameSelectedCombatUi(mob(), mob({ lat: 1.5, lon: 2.5, revision: 9 }))).toBe(true);
  });

  it("sees every displayed change on the selected target", () => {
    expect(sameSelectedCombatUi(mob(), mob({ currentHealth: 90 }))).toBe(false);
    expect(sameSelectedCombatUi(mob(), mob({ targetEntityId: "p" }))).toBe(false);
    expect(sameSelectedCombatUi(mob(), mob({ ward: 5 }))).toBe(false);
    const shell = (endsAt: number) => mob({ mobBuffs: [{ kind: "shell", endsAt }] });
    expect(sameSelectedCombatUi(shell(1), shell(2))).toBe(false);
    expect(sameSelectedCombatUi(shell(1), shell(1))).toBe(true);
    expect(sameSelectedCombatUi(mob(), null)).toBe(false);
    expect(sameSelectedCombatUi(null, null)).toBe(true);
  });

  it("treats undefined fields as absent", () => {
    expect(sameSelectedCombatUi(mob({ ward: undefined } as never), mob())).toBe(true);
    expect(deepEqualJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqualJson({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
  });

  it("compares the local HUD state structurally", () => {
    const withClass = (rage: number) =>
      mob({ classCombat: { resource: { current: rage, max: 100 }, cooldownEndsAt: { a: 1 } } as never });
    expect(sameLocalCombatUi(withClass(10), withClass(10))).toBe(true);
    expect(sameLocalCombatUi(withClass(10), withClass(11))).toBe(false);
    expect(sameLocalCombatUi(mob(), mob({ lat: 5, revision: 4 }))).toBe(true);
  });
});
