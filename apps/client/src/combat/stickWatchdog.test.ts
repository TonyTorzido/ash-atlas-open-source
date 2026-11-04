import { describe, expect, it } from "vitest";
import { captureLost, orientationFlipped, stickTouchGone } from "./stickWatchdog.js";

describe("stickTouchGone", () => {
  it("is false while the stick's own touch is still active, even with other fingers around", () => {
    expect(stickTouchGone([{ identifier: 4 }, { identifier: 9 }], 4)).toBe(false);
  });
  it("is true once the stick's touch is missing from the active list (the other fingers do not count)", () => {
    expect(stickTouchGone([{ identifier: 9 }], 4)).toBe(true);
    expect(stickTouchGone([], 4)).toBe(true);
  });
  it("cannot judge a stick whose touch was never identified", () => {
    expect(stickTouchGone([{ identifier: 9 }], null)).toBe(false);
  });
});

describe("orientationFlipped", () => {
  it("is true only when portrait and landscape swap", () => {
    expect(orientationFlipped({ width: 390, height: 844 }, { width: 844, height: 390 })).toBe(true);
    expect(orientationFlipped({ width: 390, height: 844 }, { width: 390, height: 760 })).toBe(false);
    expect(orientationFlipped({ width: 932, height: 430 }, { width: 932, height: 400 })).toBe(false);
  });
});

describe("captureLost", () => {
  it("is false when nothing is held or the capture is still there", () => {
    expect(captureLost(null, () => false)).toBe(false);
    expect(captureLost(3, (id) => id === 3)).toBe(false);
  });
  it("is true when a held pointer no longer has capture", () => {
    expect(captureLost(3, () => false)).toBe(true);
  });
});
