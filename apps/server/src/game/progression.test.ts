import { describe, expect, it } from "vitest";

import { calculateXpTransition } from "./progression.js";

describe("XP transitions", () => {
  it("handles a single grant and a multi-level grant deterministically", () => {
    expect(calculateXpTransition(0, 100)).toMatchObject({
      grantedXp: 100,
      discardedXp: 0,
      resultingXp: 100,
      resultingLevel: 0,
      levelsGained: []
    });
    expect(calculateXpTransition(1_600, 8_500)).toMatchObject({
      resultingXp: 10_100,
      resultingLevel: 1,
      levelsGained: [1]
    });
  });

  it("retains post-cap XP without advancing beyond level 25", () => {
    expect(calculateXpTransition(999_990, 50)).toMatchObject({
      resultingXp: 1_000_040,
      grantedXp: 50,
      discardedXp: 0,
      resultingLevel: 25,
      levelsGained: [25]
    });
    expect(calculateXpTransition(1_000_000, 1_000)).toMatchObject({
      resultingXp: 1_001_000,
      grantedXp: 1_000,
      discardedXp: 0,
      resultingLevel: 25,
      levelsGained: []
    });
  });

  it("rejects negative, malformed, or unsafe integer values", () => {
    expect(() => calculateXpTransition(0, -1)).toThrow(/nonnegative/i);
    expect(() => calculateXpTransition(0, 1.5)).toThrow(/safe integer/i);
    expect(() => calculateXpTransition(Number.MAX_SAFE_INTEGER + 1, 0)).toThrow(/outside/i);
    expect(() => calculateXpTransition(Number.MAX_SAFE_INTEGER, 1)).toThrow(/supported range/i);
  });
});
