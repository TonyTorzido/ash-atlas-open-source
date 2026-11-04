import { describe, expect, it } from "vitest";

import { fishingCastCuePulse } from "./mapObjects.js";

describe("fishing cast point cues", () => {
  it("keeps every bite cue visible and honors reduced motion", () => {
    expect(fishingCastCuePulse("nibble", 120, false)).toBeGreaterThan(0);
    expect(fishingCastCuePulse("fake_nibble", 120, false)).toBeGreaterThan(0);
    expect(fishingCastCuePulse("true_strike", 120, false)).toBeGreaterThan(0);
    expect(fishingCastCuePulse("true_strike", 120, true)).toBe(0.5);
    expect(fishingCastCuePulse(null, 120, false)).toBe(0);
  });
});
