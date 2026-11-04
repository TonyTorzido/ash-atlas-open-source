import { describe, expect, it } from "vitest";

import {
  AIM_RETRY_MS,
  AIM_STICK_THRESHOLD,
  AimAttackRepeater,
  attackButtonRepeats,
  attackKnobOffset,
  cursorAimDirection,
  nextAttackButtonMode,
  stickAimDirection
} from "./twinStick.js";

describe("stickAimDirection", () => {
  it("is null below the threshold and aims north-up with no map rotation above it", () => {
    expect(stickAimDirection(0.2, 0.1, 0)).toBeNull();
    expect(stickAimDirection(0, -(AIM_STICK_THRESHOLD - 0.01), 0)).toBeNull();
    const up = stickAimDirection(0, -0.4, 0)!;
    expect(up.dirX).toBeCloseTo(0);
    expect(up.dirY).toBeCloseTo(1);
    const right = stickAimDirection(0.9, 0, 0)!;
    expect(right.dirX).toBeCloseTo(1);
    expect(right.dirY).toBeCloseTo(0);
  });

  it("follows the map bearing like the left stick", () => {
    // Map rotated 90 degrees: screen-up points east.
    const up = stickAimDirection(0, -1, 90)!;
    expect(up.dirX).toBeCloseTo(1);
    expect(up.dirY).toBeCloseTo(0);
  });
});

describe("cursorAimDirection", () => {
  it("has no aim on top of the player and a unit aim elsewhere", () => {
    expect(cursorAimDirection(3, 4, 0)).toBeNull();
    const down = cursorAimDirection(0, 200, 0)!;
    expect(down.dirX).toBeCloseTo(0);
    expect(down.dirY).toBeCloseTo(-1);
  });
});

describe("AimAttackRepeater", () => {
  it("attacks when the recovery ends and not before", () => {
    const repeater = new AimAttackRepeater();
    expect(repeater.due(1000, 1300)).toBe(false);
    expect(repeater.due(1300, 1300)).toBe(true);
  });

  it("does not retry every frame when an attempt produced no swing", () => {
    const repeater = new AimAttackRepeater();
    expect(repeater.due(1000, 0)).toBe(true);
    expect(repeater.due(1000 + AIM_RETRY_MS - 1, 0)).toBe(false);
    expect(repeater.due(1000 + AIM_RETRY_MS, 0)).toBe(true);
  });

  it("attacks at once after a release", () => {
    const repeater = new AimAttackRepeater();
    expect(repeater.due(1000, 0)).toBe(true);
    repeater.release();
    expect(repeater.due(1001, 0)).toBe(true);
  });
});

describe("attack button modes", () => {
  it("a tap stays pending and a long still hold becomes auto", () => {
    expect(nextAttackButtonMode("pending", "idle", 100, 400)).toBe("pending");
    expect(nextAttackButtonMode("pending", "idle", 400, 400)).toBe("auto");
  });

  it("dragging aims, returning to the dead zone pauses, dragging out resumes, and it never falls back to auto", () => {
    expect(nextAttackButtonMode("pending", "aim", 50, 400)).toBe("aim");
    expect(nextAttackButtonMode("auto", "aim", 900, 400)).toBe("aim");
    expect(nextAttackButtonMode("aim", "cancel", 900, 400)).toBe("paused");
    expect(nextAttackButtonMode("paused", "idle", 5000, 400)).toBe("paused");
    expect(nextAttackButtonMode("paused", "aim", 5000, 400)).toBe("aim");
  });

  it("attacks continuously only in aim and auto", () => {
    expect(attackButtonRepeats("aim")).toBe(true);
    expect(attackButtonRepeats("auto")).toBe(true);
    expect(attackButtonRepeats("paused")).toBe(false);
    expect(attackButtonRepeats("pending")).toBe(false);
  });

  it("clamps the knob to the button", () => {
    expect(attackKnobOffset(3, 4, 14)).toEqual({ x: 3, y: 4 });
    const clamped = attackKnobOffset(60, 80, 10);
    expect(Math.hypot(clamped.x, clamped.y)).toBeCloseTo(10);
    expect(attackKnobOffset(0, 0, 10)).toEqual({ x: 0, y: 0 });
  });
});
