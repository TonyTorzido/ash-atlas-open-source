import { describe, expect, it } from "vitest";

import {
  ButtonEdgeTracker,
  NAV_REPEAT_MS,
  NavRepeater,
  PAD_A,
  PAD_B,
  PAD_X,
  PAD_Y,
  chooseFocus,
  dpadPanVector,
  chordSlotIndex,
  resolveChord,
  stickToDirection
} from "./gamepadLogic.js";

describe("gamepad logic", () => {
  it("reports a button once per press, not while held", () => {
    const tracker = new ButtonEdgeTracker();
    expect(tracker.update([true, false])).toEqual([0]);
    expect(tracker.update([true, false])).toEqual([]);
    expect(tracker.update([false, true])).toEqual([1]);
    expect(tracker.update([true, true])).toEqual([0]);
  });

  it("maps bumper chords to hotbar slots", () => {
    expect(resolveChord(false, false)).toBeNull();
    expect(resolveChord(true, false)).toBe("left");
    expect(resolveChord(false, true)).toBe("right");
    expect(resolveChord(true, true)).toBe("left");
    expect(chordSlotIndex(null, PAD_A)).toBeNull();
    expect([PAD_A, PAD_X, PAD_B, PAD_Y].map((b) => chordSlotIndex("left", b))).toEqual([0, 1, 2, 3]);
    expect([PAD_A, PAD_X, PAD_B, PAD_Y].map((b) => chordSlotIndex("right", b))).toEqual([4, 5, 6, 7]);
    expect(chordSlotIndex("left", 10)).toBeNull();
  });

  it("turns a stick into a dominant-axis direction", () => {
    expect(stickToDirection(0.2, 0.2)).toBeNull();
    expect(stickToDirection(0.9, 0.3)).toBe("right");
    expect(stickToDirection(-0.1, -0.8)).toBe("up");
    expect(stickToDirection(0, 0.8)).toBe("down");
  });

  it("repeats navigation about every 180 ms while held", () => {
    const repeater = new NavRepeater();
    expect(repeater.step("down", 0)).toBe("down");
    expect(repeater.step("down", NAV_REPEAT_MS - 10)).toBeNull();
    expect(repeater.step("down", NAV_REPEAT_MS)).toBe("down");
    expect(repeater.step("up", NAV_REPEAT_MS + 1)).toBe("up");
    expect(repeater.step(null, 400)).toBeNull();
    expect(repeater.step("up", 401)).toBe("up");
  });

  it("chooses the nearest item in the pressed direction", () => {
    const rects = [
      { left: 0, top: 0, width: 100, height: 40 },
      { left: 0, top: 50, width: 100, height: 40 },
      { left: 0, top: 100, width: 100, height: 40 },
      { left: 120, top: 0, width: 100, height: 40 }
    ];
    expect(chooseFocus(rects, null, "down")).toBe(0);
    expect(chooseFocus(rects, 0, "down")).toBe(1);
    expect(chooseFocus(rects, 1, "down")).toBe(2);
    expect(chooseFocus(rects, 2, "down")).toBe(2);
    expect(chooseFocus(rects, 0, "right")).toBe(3);
    expect(chooseFocus(rects, 3, "left")).toBe(0);
    expect(chooseFocus(rects, 1, "up")).toBe(0);
    expect(chooseFocus([], null, "up")).toBeNull();
  });
});

describe("dpadPanVector", () => {
  it("is idle with nothing or opposite directions held", () => {
    expect(dpadPanVector(false, false, false, false)).toEqual({ x: 0, y: 0 });
    expect(dpadPanVector(true, true, true, true)).toEqual({ x: 0, y: 0 });
  });

  it("points along the held direction and normalises diagonals", () => {
    expect(dpadPanVector(false, false, false, true)).toEqual({ x: 1, y: 0 });
    expect(dpadPanVector(true, false, false, false)).toEqual({ x: 0, y: -1 });
    const diagonal = dpadPanVector(false, true, true, false);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
    expect(diagonal.x).toBeLessThan(0);
    expect(diagonal.y).toBeGreaterThan(0);
  });
});
