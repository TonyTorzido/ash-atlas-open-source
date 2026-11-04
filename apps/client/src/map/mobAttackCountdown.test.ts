import { describe, expect, it } from "vitest";
import type { CombatEntitySnapshot } from "@ash-atlas/shared";
import { mobAttackCountdownScale, mobAttackCountdownState } from "./mobAttackCountdown.js";

const mob = (patch: Partial<CombatEntitySnapshot>) =>
  ({ targetEntityId: null, ...patch }) as CombatEntitySnapshot;
const acquiring = (targetEntityId: string | null, deadlineAt = 13_000) => ({
  phase: "acquiring", intent: "combat", deadlineAt, durationMs: 4_000, targetEntityId
}) as const;

describe("mobAttackCountdownState", () => {
  it("is hidden when idle, observing, or without a deadline", () => {
    expect(mobAttackCountdownState(mob({}), "me", 0)).toBeNull();
    expect(mobAttackCountdownState(mob({ aiPresentation: { phase: "observing", intent: "observe", deadlineAt: null } }), "me", 0)).toBeNull();
    expect(mobAttackCountdownState(mob({ targetEntityId: "me" }), "me", 0)).toBeNull();
  });

  it("is red only when the target is the local player", () => {
    expect(mobAttackCountdownState(mob({ aiPresentation: acquiring("me") }), "me", 11_000)?.tone).toBe("red");
    expect(mobAttackCountdownState(mob({ aiPresentation: acquiring("other") }), "me", 11_000)?.tone).toBe("amber");
  });

  it("reports whole seconds remaining and a draining sweep", () => {
    const state = mobAttackCountdownState(mob({ aiPresentation: acquiring("me") }), "me", 11_000);
    expect(state).toMatchObject({ seconds: 2, fraction: 0.5, pulse: false });
    expect(mobAttackCountdownState(mob({ aiPresentation: acquiring("me") }), "me", 9_001)?.seconds).toBe(4);
  });

  it("pulses only in the last second of an acquisition, never under reduced motion", () => {
    const last = mobAttackCountdownState(mob({ aiPresentation: acquiring("me") }), "me", 12_500);
    expect(last?.pulse).toBe(true);
    expect(mobAttackCountdownScale(last, 100, true)).toBe(1);
    expect(mobAttackCountdownScale(last, 100, false)).toBeGreaterThan(1);
    const disengage = mobAttackCountdownState(mob({
      aiPresentation: { phase: "disengaging", intent: "combat", deadlineAt: 12_000, durationMs: 4_000, targetEntityId: "me" }
    }), "me", 11_500);
    expect(disengage).toMatchObject({ phase: "disengaging", pulse: false });
  });
});
