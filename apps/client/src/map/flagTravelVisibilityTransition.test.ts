import { describe, expect, it } from "vitest";

import {
  flagTravelVisibilityCleanupAt,
  flagTravelVisibilityDecision,
  type FlagTravelVisibilityTiming
} from "./flagTravelVisibilityTransition.js";

const timing: FlagTravelVisibilityTiming = { startedAtMs: 1_000, durationMs: 1_000 };

describe("flag travel visibility transition", () => {
  it("holds origin identities opaque and destination-only identities hidden before start", () => {
    expect(flagTravelVisibilityDecision(null, {
      inOrigin: true,
      inDestination: true,
      relocating: true
    }, 50_000)).toMatchObject({
      alpha: 1,
      useDestination: false,
      interactive: true
    });
    expect(flagTravelVisibilityDecision(null, {
      inOrigin: false,
      inDestination: true
    }, 50_000)).toMatchObject({
      alpha: 0,
      useDestination: false,
      interactive: false
    });
  });

  it("fades origin-only identity out", () => {
    expect(flagTravelVisibilityDecision(timing, { inOrigin: true, inDestination: false }, 1_500).alpha)
      .toBeCloseTo(0.5);
    expect(flagTravelVisibilityDecision(timing, { inOrigin: true, inDestination: false }, 2_000).alpha)
      .toBe(0);
  });

  it("fades destination-only identity in from midpoint", () => {
    expect(flagTravelVisibilityDecision(timing, { inOrigin: false, inDestination: true }, 1_499).alpha)
      .toBe(0);
    expect(flagTravelVisibilityDecision(timing, { inOrigin: false, inDestination: true }, 1_750).alpha)
      .toBeCloseTo(0.5);
  });

  it("keeps shared identity fully visible", () => {
    expect(flagTravelVisibilityDecision(timing, { inOrigin: true, inDestination: true }, 1_500))
      .toMatchObject({ alpha: 1, useDestination: true });
  });

  it("switches the relocating player at invisible midpoint", () => {
    expect(flagTravelVisibilityDecision(timing, {
      inOrigin: true,
      inDestination: true,
      relocating: true
    }, 1_499)).toMatchObject({ useDestination: false });
    expect(flagTravelVisibilityDecision(timing, {
      inOrigin: true,
      inDestination: true,
      relocating: true
    }, 1_500)).toMatchObject({ alpha: 0, useDestination: true });
  });

  it("is atomic for zero duration", () => {
    expect(flagTravelVisibilityDecision({ ...timing, durationMs: 0 }, {
      inOrigin: true,
      inDestination: true,
      relocating: true
    }, 1_000)).toMatchObject({ alpha: 1, useDestination: true });
  });

  it("starts a late destination identity at zero alpha when first observed", () => {
    const at = flagTravelVisibilityDecision(timing, {
      inOrigin: false,
      inDestination: true,
      firstSeenAtMs: 1_900
    }, 1_900);
    const later = flagTravelVisibilityDecision(timing, {
      inOrigin: false,
      inDestination: true,
      firstSeenAtMs: 1_900
    }, 2_150);
    expect(at.alpha).toBe(0);
    expect(later.alpha).toBeCloseTo(0.5);
    expect(flagTravelVisibilityCleanupAt(timing)).toBe(3_000);
  });
});
