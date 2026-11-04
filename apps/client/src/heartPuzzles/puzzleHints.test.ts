import { describe, expect, it } from "vitest";

import { secondsToNextHint, unlockedHintTier } from "./puzzleHints.js";

describe("hint tiers", () => {
  it("starts locked", () => {
    expect(unlockedHintTier(0, 0)).toBe(0);
  });
  it("unlocks by time or by failures, whichever is first", () => {
    expect(unlockedHintTier(41, 0)).toBe(1);
    expect(unlockedHintTier(5, 2)).toBe(1);
    expect(unlockedHintTier(5, 5)).toBe(2);
    expect(unlockedHintTier(111, 0)).toBe(2);
    expect(unlockedHintTier(0, 9)).toBe(3);
    expect(unlockedHintTier(999, 0)).toBe(3);
  });
  it("reports the wait for the next tier", () => {
    expect(secondsToNextHint(10, 0)).toBe(30);
    expect(secondsToNextHint(500, 3)).toBeNull();
  });
});
