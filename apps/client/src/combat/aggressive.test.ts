import { describe, expect, it } from "vitest";

import {
  aggressiveDurationMs,
  aggressiveProgressRatio,
  aggressiveRemainingMs,
  flagVisitLockLabel,
  shouldSendFlagVisit
} from "./aggressive.js";

describe("Aggressive countdown", () => {
  it("reaches zero without becoming negative and unlocks flag travel", () => {
    expect(aggressiveRemainingMs(7_000, 6_001)).toBe(999);
    expect(flagVisitLockLabel(999)).toBe("Aggressive · 1.0s");
    expect(aggressiveRemainingMs(7_000, 7_000)).toBe(0);
    expect(aggressiveRemainingMs(7_000, 8_000)).toBe(0);
    expect(shouldSendFlagVisit(7_000, 6_999)).toBe(false);
    expect(shouldSendFlagVisit(7_000, 7_000)).toBe(true);
  });

  it("derives a clamped visual ratio from the authoritative duration", () => {
    expect(aggressiveDurationMs(null)).toBe(10_000);
    expect(aggressiveProgressRatio(8_000, 10_000)).toBe(0.8);
    expect(aggressiveProgressRatio(12_000, 10_000)).toBe(1);
    expect(aggressiveProgressRatio(-1, 10_000)).toBe(0);
    expect(aggressiveProgressRatio(5_000, 0)).toBe(0);
  });

  it("includes the authoritative V3 aggression reductions in the duration", () => {
    const snapshot = {
      activeSpecializationId: "assassin",
      generalSkills: [{ skillId: "calm_mind", rank: 3, pointsSpent: 4 }],
      specializations: [{ specializationId: "assassin", rank: 5, pointsSpent: 20, grandfathered: false, masteryQuestCompleted: true }]
    } as const;
    expect(aggressiveDurationMs(snapshot)).toBe(5_950);
  });
});
