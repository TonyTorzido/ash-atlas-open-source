import { beforeEach, describe, expect, it } from "vitest";
import { GONE_MOB_TELEGRAPH_TTL_MS, isCastOfGoneMob, noteMobTelegraphsGone, noteTelegraphRtt, resetTelegraphAnchors, telegraphActive, telegraphOneWayMs, telegraphWindow, TELEGRAPH_MAX_ONE_WAY_MS } from "./telegraphWindow";

const cast = (extra: Record<string, number> = {}) => ({ castInstanceId: "mob:1:charge:5", startTime: 1_000, resolveTime: 2_500, ...extra });

describe("telegraphWindow", () => {
  beforeEach(() => resetTelegraphAnchors());

  it("anchors on first sight and ignores skewed server clocks", () => {
    // Client clock is 10 s ahead of the server's.
    const first = telegraphWindow(cast({ remainingMs: 1_400, durationMs: 1_500 }), 11_100);
    expect(first).toEqual({ localStart: 11_000, localEnd: 12_500 });
    expect(telegraphActive(cast({ remainingMs: 1_400, durationMs: 1_500 }), 11_100)).toBe(true);
  });

  it("keeps the anchor stable across later deltas", () => {
    telegraphWindow(cast({ remainingMs: 1_400, durationMs: 1_500 }), 11_100);
    const later = telegraphWindow(cast({ remainingMs: 1_000, durationMs: 1_500 }), 11_500);
    expect(later.localEnd).toBe(12_500);
    expect(telegraphActive(cast({ remainingMs: 1_000, durationMs: 1_500 }), 12_499)).toBe(true);
    expect(telegraphActive(cast({ remainingMs: 1_000, durationMs: 1_500 }), 12_500)).toBe(false);
  });

  it("falls back to server times for casts without remainingMs", () => {
    expect(telegraphWindow(cast(), 5)).toEqual({ localStart: 1_000, localEnd: 2_500 });
    expect(telegraphActive(cast(), 1_200)).toBe(true);
    expect(telegraphActive(cast(), 2_500)).toBe(false);
  });

  it("takes half the measured round trip off the anchor, so the decal ends when the server resolves", () => {
    noteTelegraphRtt(140);
    expect(telegraphOneWayMs()).toBe(70);
    // Seen 70 ms after the server serialized it with 1100 ms left: 1030 ms really left, the fill already 70 ms in.
    expect(telegraphWindow(cast({ remainingMs: 1_100, durationMs: 1_100 }), 10_000)).toEqual({ localStart: 9_930, localEnd: 11_030 });
  });

  it("caps the compensation and never anchors in the past", () => {
    noteTelegraphRtt(2_000);
    expect(telegraphOneWayMs()).toBe(TELEGRAPH_MAX_ONE_WAY_MS);
    expect(telegraphWindow(cast({ remainingMs: 100, durationMs: 1_100 }), 10_000).localEnd).toBe(10_000);
  });
});

describe("gone mob telegraphs", () => {
  beforeEach(() => resetTelegraphAnchors());

  it("drops every cast of a defeated mob at once, and only that mob's", () => {
    expect(isCastOfGoneMob("wolf:brute_charge:40", 1_000)).toBe(false);
    noteMobTelegraphsGone("wolf", 1_000);
    // Same frame the DEFEATED event arrives: well inside the 100 ms budget.
    expect(isCastOfGoneMob("wolf:brute_charge:40", 1_000)).toBe(true);
    expect(isCastOfGoneMob("wolf:mob_ranged_aim:41", 1_050)).toBe(true);
    expect(isCastOfGoneMob("wolf2:brute_charge:40", 1_050)).toBe(false);
    expect(isCastOfGoneMob("bear:maul:40", 1_050)).toBe(false);
  });

  it("forgets the mob after the hold, and on reset", () => {
    noteMobTelegraphsGone("wolf", 1_000);
    expect(isCastOfGoneMob("wolf:x:1", 1_000 + GONE_MOB_TELEGRAPH_TTL_MS + 1)).toBe(false);
    noteMobTelegraphsGone("bear", 5_000);
    resetTelegraphAnchors();
    expect(isCastOfGoneMob("bear:x:1", 5_001)).toBe(false);
  });
});
