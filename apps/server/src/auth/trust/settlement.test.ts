import { describe, expect, it } from "vitest";

import {
  applySettlementFix,
  assuranceCountsAsNative,
  emptySettlementState,
  isSettledNow,
  raiseSettlementDifficulty,
  rollSettlementTargets,
  scaledTargets,
  type SettlementFixUpdate,
  type SettlementRules,
  type SettlementState
} from "./settlement.js";
import { LocationReportService } from "./trustService.js";
import type { LocationReportStore } from "./trustStore.js";

const DAY_MS = 24 * 60 * 60_000;
const T0 = new Date("2026-10-01T10:00:00.000Z");
const OLD_ACCOUNT = new Date(T0.getTime() - 60 * DAY_MS);
const HOME = { lat: 40, lon: -105 };
const RULES: SettlementRules = { radiusM: 25_000, minGapMs: 170_000, minDistinctPositions: 3, minAccountAgeMs: 14 * DAY_MS };
const BASE = { checks: 3, days: 2 };
const CONFIG = {
  TRUST_SETTLE_CHECKS_MIN: 22,
  TRUST_SETTLE_CHECKS_MAX: 30,
  TRUST_SETTLE_DAYS_MIN: 4,
  TRUST_SETTLE_DAYS_MAX: 6
};

function fix(at: Date, overrides: Partial<SettlementFixUpdate> = {}): SettlementFixUpdate {
  return { source: "passive", lat: HOME.lat, lon: HOME.lon, at, countable: true, baseTargets: BASE, rules: RULES, ...overrides };
}

function apply(state: SettlementState, updates: SettlementFixUpdate[], createdAt: Date | null = OLD_ACCOUNT) {
  let current = state;
  const events: unknown[] = [];
  for (const update of updates) {
    const transition = applySettlementFix(current, update, createdAt);
    current = transition.next;
    events.push(transition.event);
  }
  return { state: current, events };
}

const at = (ms: number) => new Date(T0.getTime() + ms);

describe("Settled targets", () => {
  it("rolls uniformly inside the configured ranges", () => {
    const seen = { checks: new Set<number>(), days: new Set<number>() };
    for (let i = 0; i < 2000; i += 1) {
      const targets = rollSettlementTargets(CONFIG);
      seen.checks.add(targets.checks);
      seen.days.add(targets.days);
    }
    expect([...seen.checks].sort((a, b) => a - b)).toEqual([22, 23, 24, 25, 26, 27, 28, 29, 30]);
    expect([...seen.days].sort((a, b) => a - b)).toEqual([4, 5, 6]);
  });

  it("scales by difficulty with ceil and stays inside the database bounds", () => {
    expect(scaledTargets({ checks: 23, days: 5 }, 1.5)).toEqual({ checks: 35, days: 8 });
    expect(scaledTargets({ checks: 400, days: 50 }, 2)).toEqual({ checks: 500, days: 60 });
  });
});

describe("Settled counting", () => {
  it("counts web never, legacy shells only in shadow assurance", () => {
    expect(assuranceCountsAsNative("web", "shadow")).toBe(false);
    expect(assuranceCountsAsNative("flagged", "shadow")).toBe(false);
    expect(assuranceCountsAsNative(null, "shadow")).toBe(false);
    expect(assuranceCountsAsNative("native_legacy", "shadow")).toBe(true);
    expect(assuranceCountsAsNative("unverified", "shadow")).toBe(true);
    expect(assuranceCountsAsNative("native_legacy", "enforce")).toBe(false);
    expect(assuranceCountsAsNative("attested", "enforce")).toBe(true);
    expect(assuranceCountsAsNative("device_checked", "enforce")).toBe(true);
  });

  it("seeds the home from the first counted native fix and enforces the minimum gap", () => {
    const { state } = apply(emptySettlementState(BASE), [
      fix(at(0)),
      fix(at(169_000), { lat: 40.001 }),
      fix(at(170_000), { lat: 40.002 })
    ]);
    expect(state.home).toEqual(HOME);
    expect(state.countedChecks).toBe(2);
    expect(state.lastCountedAt).toEqual(at(170_000));
  });

  it("ignores fixes outside the radius and fixes that may not count", () => {
    const seeded = { ...emptySettlementState(BASE), home: HOME, homeSetAt: T0 };
    const far = applySettlementFix(seeded, fix(at(0), { lat: 41 }), OLD_ACCOUNT);
    expect(far.changed).toBe(false);
    const web = applySettlementFix(seeded, fix(at(0), { countable: false }), OLD_ACCOUNT);
    expect(web.changed).toBe(false);
  });

  it("needs distinct days, distinct positions and an old enough account", () => {
    const sameSpot = apply(emptySettlementState(BASE), [
      fix(at(0)), fix(at(DAY_MS)), fix(at(2 * DAY_MS))
    ]);
    // Days and checks met, but one position only.
    expect(sameSpot.state).toMatchObject({ countedChecks: 3, countedDays: 3, distinctPositions: 1, settledAt: null });

    const oneDay = apply(emptySettlementState(BASE), [
      fix(at(0)), fix(at(200_000), { lat: 40.01 }), fix(at(400_000), { lat: 40.02 }), fix(at(600_000), { lat: 40.03 })
    ]);
    expect(oneDay.state).toMatchObject({ countedChecks: 4, countedDays: 1, distinctPositions: 4, settledAt: null });

    const updates = [fix(at(0)), fix(at(DAY_MS), { lat: 40.01 }), fix(at(2 * DAY_MS), { lat: 40.02 })];
    const young = apply(emptySettlementState(BASE), updates, new Date(T0.getTime() - 3 * DAY_MS));
    expect(young.state.settledAt).toBeNull();
    const earned = apply(emptySettlementState(BASE), updates);
    expect(earned.events).toEqual([null, null, "settled"]);
    expect(earned.state).toMatchObject({ settledAt: at(2 * DAY_MS), settledHome: HOME, provisionalUntil: null });
  });

  it("turns a provisional grandfathered row into full Settled when earned", () => {
    const provisional: SettlementState = {
      ...emptySettlementState(BASE),
      home: HOME,
      settledHome: HOME,
      settledAt: new Date(T0.getTime() - DAY_MS),
      provisionalUntil: new Date(T0.getTime() + 29 * DAY_MS)
    };
    expect(isSettledNow(provisional, T0)).toBe(true);
    expect(isSettledNow(provisional, new Date(T0.getTime() + 30 * DAY_MS))).toBe(false);
    const { state, events } = apply(provisional, [
      fix(at(0)), fix(at(DAY_MS), { lat: 40.01 }), fix(at(2 * DAY_MS), { lat: 40.02 })
    ]);
    expect(events).toEqual([null, null, null]);
    expect(state).toMatchObject({ provisionalUntil: null, settledAt: provisional.settledAt });
  });
});

describe("Settled home on relocation", () => {
  const settled: SettlementState = {
    ...emptySettlementState(BASE),
    home: HOME,
    homeSetAt: T0,
    settledHome: HOME,
    settledHomeAt: T0,
    settledAt: T0,
    countedChecks: 9
  };
  const relocate = (lat: number, ms: number) => fix(at(ms), { source: "relocation", lat, countable: false });

  it("keeps Settled for a move near home, loses it when moving away, restores it on return", () => {
    expect(applySettlementFix(settled, relocate(40.1, 0), OLD_ACCOUNT).changed).toBe(false);

    const away = applySettlementFix(settled, relocate(42, 1000), OLD_ACCOUNT);
    expect(away.event).toBe("moved_away");
    expect(away.next).toMatchObject({
      settledAt: null,
      unsettleReason: "moved_away",
      settledHome: HOME,
      home: { lat: 42, lon: -105 },
      countedChecks: 0,
      targetChecks: 3
    });

    const back = applySettlementFix(away.next, relocate(40.05, 2000), OLD_ACCOUNT);
    expect(back.event).toBe("returned_home");
    expect(back.next).toMatchObject({ settledAt: at(2000), unsettleReason: null, home: { lat: 40.05, lon: -105 } });
  });

  it("restores nothing after a revocation for cause", () => {
    const revoked: SettlementState = { ...settled, settledAt: null, settledHome: null, unsettleReason: "location_mock" };
    const moved = applySettlementFix(revoked, relocate(40.05, 0), OLD_ACCOUNT);
    expect(moved.next.settledAt).toBeNull();
  });

  it("resets progress only when an unsettled home moves beyond the radius", () => {
    const earning: SettlementState = { ...emptySettlementState(BASE), home: HOME, countedChecks: 5, countedDays: 2 };
    expect(applySettlementFix(earning, relocate(40.1, 0), OLD_ACCOUNT).changed).toBe(false);
    const moved = applySettlementFix(earning, relocate(41, 0), OLD_ACCOUNT);
    expect(moved.next).toMatchObject({ home: { lat: 41, lon: -105 }, countedChecks: 0, countedDays: 0 });
  });
});

describe("LocationReportService settlement eligibility", () => {
  const store: LocationReportStore = {
    loadLocationContext: async () => ({ state: null, farRelocationsSince: 0 }),
    recordLocationReport: async () => ({ reportId: "r", seq: 1 }),
    updateLastFix: async () => undefined,
    deleteLocationReportsBefore: async () => 0
  };
  const service = (mode: "shadow" | "enforce") => new LocationReportService(store, {
    TRUST_LOCATION_REJECT_MODE: "shadow",
    TRUST_LAND_ACTION_MIN_DISPLACEMENT_M: 500,
    TRUST_TRANSIT_HOLD_MINUTES: 10,
    TRUST_SETTLE_ACCURACY_M: 5000,
    TRUST_SETTLE_ASSURANCE_MODE: mode
  }, { now: () => T0 });
  const passive = (clientPlatform: "web" | "ios" | "android" | undefined, accuracyM: number | null = 20) => ({
    accountId: "a", playerId: "p", source: "passive" as const, lat: 40, lon: -105,
    ...(accuracyM === null ? {} : { accuracyM }),
    ...(clientPlatform === undefined ? {} : { clientPlatform }),
    deviceInstallationId: null, networkHash: null, networkPrefixHash: null, avatarPosition: null
  });

  it("marks native accurate passive fixes countable and web fixes never", async () => {
    expect(await service("shadow").evaluate(passive("android"))).toMatchObject({ assurance: "native_legacy", settlementCountable: true });
    expect(await service("shadow").evaluate(passive("web"))).toMatchObject({ assurance: "web", settlementCountable: false });
    expect(await service("shadow").evaluate(passive(undefined))).toMatchObject({ assurance: null, settlementCountable: false });
    expect((await service("shadow").evaluate(passive("ios", 6000))).settlementCountable).toBe(false);
    expect((await service("shadow").evaluate(passive("ios", null))).settlementCountable).toBe(false);
    expect((await service("enforce").evaluate(passive("ios"))).settlementCountable).toBe(false);
  });
});

describe("alert-zone difficulty", () => {
  it("rescales current targets by new/old difficulty (ceil) and never lowers", () => {
    const base = { ...emptySettlementState({ checks: 22, days: 5 }), countedChecks: 7 };
    const yellow = raiseSettlementDifficulty(base, 1.5);
    expect(yellow).toMatchObject({ difficulty: 1.5, targetChecks: 33, targetDays: 8, countedChecks: 7 });
    const orange = raiseSettlementDifficulty(yellow!, 2);
    // 33 * 2 / 1.5 = 44; 8 * 2 / 1.5 = 10.67 -> 11.
    expect(orange).toMatchObject({ difficulty: 2, targetChecks: 44, targetDays: 11 });
    expect(raiseSettlementDifficulty(orange!, 1.5)).toBeNull();
    expect(raiseSettlementDifficulty(orange!, 2)).toBeNull();
  });

  it("caps rescaled targets at the schema limits", () => {
    const high = { ...emptySettlementState({ checks: 400, days: 50 }) };
    expect(raiseSettlementDifficulty(high, 2)).toMatchObject({ targetChecks: 500, targetDays: 60 });
  });
});
