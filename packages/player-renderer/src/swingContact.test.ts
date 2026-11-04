import { describe, expect, it } from "vitest";

import { SWING_CONTACT_MS, SWING_PROGRAMS, createGatherPose, sampleSwing } from "./gatherAnimation.js";

describe("swing contact frame", () => {
  it("the blade crosses at SWING_CONTACT_MS: a keyframe sits there, the windup peaks first and the weapon is across by then", () => {
    for (const variant of ["swing", "finisher"] as const) {
      const program = SWING_PROGRAMS[variant];
      const contactT = SWING_CONTACT_MS[variant] / program.cycleMs;
      expect(program.tool.some((key) => Math.abs(key[0] - contactT) < 0.012)).toBe(true);
      expect(program.tool[1]![0] * program.cycleMs).toBeLessThanOrEqual(80);
      expect(SWING_CONTACT_MS[variant]).toBeLessThanOrEqual(125);
      const windup = sampleSwing(variant, program.tool[1]![0] * program.cycleMs, createGatherPose()).tool;
      const atContact = sampleSwing(variant, SWING_CONTACT_MS[variant], createGatherPose()).tool;
      expect(atContact).toBeLessThan(windup - 50);
    }
  });
});
