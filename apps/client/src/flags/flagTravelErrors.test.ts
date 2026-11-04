import { describe, expect, it } from "vitest";

import { flagTravelErrorEffect } from "./flagTravelErrors.js";

describe("flagTravelErrorEffect", () => {
  it("matches any authoritative error for the active travel request", () => {
    expect(flagTravelErrorEffect({
      type: "ERROR",
      requestId: "travel-1",
      code: "PLAYER_WORLD_TRANSITION_PENDING",
      message: "A player world transition is already pending"
    }, "travel-1")).toEqual({
      matchesPendingTravel: true,
      requestIdToClear: "travel-1",
      feedbackMessage: "A player world transition is already pending",
      refreshAccess: false,
      aggressiveRetryAfterMs: 0
    });
  });

  it.each([
    "TRAVEL_COMBAT_LOCKED",
    "PLAYER_WORLD_COMMAND_PENDING",
    "FLAG_VISIT_PERSISTENCE_FAILED",
    "TRAVEL_FAILED"
  ])("returns visible authoritative feedback for %s", (code) => {
    expect(flagTravelErrorEffect({
      type: "ERROR",
      requestId: "travel-1",
      code,
      message: `Authoritative ${code} feedback`
    }, "travel-1")).toMatchObject({
      requestIdToClear: "travel-1",
      feedbackMessage: `Authoritative ${code} feedback`
    });
  });

  it("refreshes stale access and preserves the Aggressive retry countdown", () => {
    expect(flagTravelErrorEffect({
      type: "ERROR",
      requestId: "travel-1",
      code: "TOLL_CHANGED",
      message: "The toll changed"
    }, "travel-1").refreshAccess).toBe(true);
    expect(flagTravelErrorEffect({
      type: "ERROR",
      requestId: "travel-1",
      code: "FLAG_VISIT_AGGRESSIVE",
      message: "Travel is locked",
      details: { retryAfterMs: 4200 }
    }, "travel-1").aggressiveRetryAfterMs).toBe(4200);
  });

  it("does not let an old request affect a newer pending travel", () => {
    expect(flagTravelErrorEffect({
      type: "ERROR",
      requestId: "travel-old",
      code: "TRAVEL_FAILED",
      message: "Travel failed"
    }, "travel-new")).toEqual({
      matchesPendingTravel: false,
      requestIdToClear: null,
      feedbackMessage: null,
      refreshAccess: false,
      aggressiveRetryAfterMs: 0
    });
  });
});
