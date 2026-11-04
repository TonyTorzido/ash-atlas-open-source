import { describe, expect, it, vi } from "vitest";

import {
  LocationReportService,
  type LocationFixInput,
  type LocationTrustConfig,
  type TrustSignalSink
} from "./trustService.js";
import type {
  AcceptedFixUpdate,
  AccountLocationState,
  LocationReportRow,
  LocationReportStore,
  UnstoredFix
} from "./trustStore.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const HOUR_MS = 60 * 60_000;

class FakeLocationReportStore implements LocationReportStore {
  state: AccountLocationState | null = null;
  farRelocationsSince = 0;
  recorded: Array<{ row: LocationReportRow; accepted: AcceptedFixUpdate | null }> = [];
  unstored: UnstoredFix[] = [];

  async loadLocationContext() {
    return { state: this.state, farRelocationsSince: this.farRelocationsSince };
  }

  async recordLocationReport(row: LocationReportRow, accepted: AcceptedFixUpdate | null) {
    this.recorded.push({ row, accepted });
    return { reportId: row.id, seq: this.recorded.length };
  }

  async updateLastFix(fix: UnstoredFix) {
    this.unstored.push(fix);
  }

  async deleteLocationReportsBefore() {
    return 0;
  }
}

function config(overrides: Partial<LocationTrustConfig> = {}): LocationTrustConfig {
  return {
    TRUST_LOCATION_REJECT_MODE: "shadow",
    TRUST_LAND_ACTION_MIN_DISPLACEMENT_M: 500,
    TRUST_TRANSIT_HOLD_MINUTES: 10,
    TRUST_SETTLE_ACCURACY_M: 5000,
    ...overrides
  };
}

function fix(overrides: Partial<LocationFixInput> = {}): LocationFixInput {
  return {
    accountId: "00000000-0000-4000-8000-000000000001",
    playerId: "player-1",
    source: "relocation",
    requestId: "gps-1",
    lat: 40,
    lon: -105,
    deviceInstallationId: null,
    networkHash: null,
    networkPrefixHash: null,
    avatarPosition: null,
    now: NOW,
    ...overrides
  };
}

function stateWithFix(
  lastFix: { lat: number; lon: number; accuracyM?: number | null; ageMs: number },
  extra: Partial<AccountLocationState> = {}
): AccountLocationState {
  return {
    accountId: "00000000-0000-4000-8000-000000000001",
    lastSeq: 1,
    lastAcceptedReportId: "00000000-0000-4000-8000-0000000000aa",
    lastFix: {
      lat: lastFix.lat,
      lon: lastFix.lon,
      accuracyM: lastFix.accuracyM ?? null,
      at: new Date(NOW.getTime() - lastFix.ageMs)
    },
    lastLandAction: null,
    landActionHoldUntil: null,
    landActionHoldReason: null,
    relocations7dFar: 0,
    ...extra
  };
}

function minutesAfterNow(date: Date | null): number | null {
  return date === null ? null : (date.getTime() - NOW.getTime()) / 60_000;
}

describe("LocationReportService.evaluate", () => {
  it("measures a first relocation from the avatar position with no speed", async () => {
    const store = new FakeLocationReportStore();
    const service = new LocationReportService(store, config());

    const evaluation = await service.evaluate(fix({ avatarPosition: { lat: 31, lon: -105 } }));

    expect(evaluation).toMatchObject({
      verdict: "accepted",
      reason: null,
      distanceM: null,
      bucket: null,
      holdReason: "relocation_cooldown",
      prevReportId: null,
      farRelocations7d: 0
    });
    // ~1000 km displacement -> 90 minutes.
    expect(minutesAfterNow(evaluation.holdUntil)).toBeCloseTo(90, 0);
    expect(evaluation.features).toMatchObject({ displacementReference: "avatar", regionCell: "80:-210" });
  });

  it("sets no hold below the minimum displacement from the last land action", async () => {
    const store = new FakeLocationReportStore();
    store.state = {
      ...stateWithFix({ lat: 40.001, lon: -105, ageMs: 48 * HOUR_MS }),
      lastLandAction: { lat: 40.002, lon: -105, at: new Date(NOW.getTime() - HOUR_MS) }
    };
    const service = new LocationReportService(store, config());

    const evaluation = await service.evaluate(fix());

    expect(evaluation.features).toMatchObject({ displacementReference: "land_action" });
    expect(evaluation.holdUntil).toBeNull();
    expect(evaluation.holdReason).toBeNull();
  });

  it("holds at least the transit minimum after a car-speed fix", async () => {
    const store = new FakeLocationReportStore();
    // ~3.3 km in 2 minutes is ~100 km/h.
    store.state = stateWithFix({ lat: 40.03, lon: -105, ageMs: 2 * 60_000 });
    const service = new LocationReportService(store, config());

    const evaluation = await service.evaluate(fix());

    expect(evaluation.bucket).toBe("car");
    expect(evaluation.holdReason).toBe("transit");
    expect(minutesAfterNow(evaluation.holdUntil)).toBe(10);
  });

  it("clamps reported accuracy at the settle limit before discounting", async () => {
    const store = new FakeLocationReportStore();
    store.state = stateWithFix({ lat: 41, lon: -105, accuracyM: 1_000_000, ageMs: 24 * HOUR_MS });
    const service = new LocationReportService(store, config());

    const evaluation = await service.evaluate(fix({ accuracyM: 1_000_000 }));

    expect(evaluation.features).toMatchObject({
      accuracyUsedM: 5000,
      accuracyAboveSettle: true,
      accuracyConstant: true
    });
    expect(evaluation.features.speedDistanceM as number).toBeCloseTo(evaluation.distanceM! - 10_000, 6);
    expect(evaluation.holdReason).toBe("relocation_cooldown");
  });

  it("scores far relocations beyond the third in seven days", async () => {
    const store = new FakeLocationReportStore();
    store.state = stateWithFix({ lat: 38, lon: -105, ageMs: 25 * HOUR_MS });
    store.farRelocationsSince = 3;
    const service = new LocationReportService(store, config());

    const evaluation = await service.evaluate(fix());

    expect(evaluation.signals.map((signal) => signal.rule)).toEqual(["relocation_far_repeat"]);
    expect(evaluation.score).toBe(2);
    expect(evaluation.farRelocations7d).toBe(4);
  });

  it.each([
    ["off", "accepted", null],
    ["shadow", "shadow_rejected", "speed_impossible"],
    ["enforce", "rejected", "speed_impossible"]
  ] as const)("marks an impossible-speed fix per %s mode", async (mode, verdict, reason) => {
    const store = new FakeLocationReportStore();
    store.state = stateWithFix({ lat: 0, lon: 0, ageMs: HOUR_MS });
    const service = new LocationReportService(store, config({ TRUST_LOCATION_REJECT_MODE: mode }));

    const evaluation = await service.evaluate(fix());

    expect(evaluation.bucket).toBe("impossible");
    expect(evaluation.verdict).toBe(verdict);
    expect(evaluation.reason).toBe(reason);
    expect(evaluation.score).toBe(4);
  });

  it("feeds region familiarity into the score and tolerates lookup failure", async () => {
    const store = new FakeLocationReportStore();
    const familiar = new LocationReportService(store, config(), { familiarity: async () => true });
    const unfamiliar = new LocationReportService(store, config(), { familiarity: async () => false });
    const logger = { warn: vi.fn() };
    const failing = new LocationReportService(store, config(), {
      logger,
      familiarity: async () => {
        throw new Error("regions unavailable");
      }
    });

    expect((await familiar.evaluate(fix())).signals).toEqual([{ rule: "region_familiar", weight: -1 }]);
    expect((await unfamiliar.evaluate(fix())).signals).toEqual([{ rule: "relocation_unfamiliar", weight: 0.5 }]);
    const fallback = await failing.evaluate(fix());
    expect(fallback.signals).toEqual([]);
    expect(fallback.features).toMatchObject({ regionFamiliar: null });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("never sets a relocation cooldown from a passive fix", async () => {
    const store = new FakeLocationReportStore();
    // Walking pace from the last fix, but 1000 km from the last land action.
    store.state = {
      ...stateWithFix({ lat: 40.01, lon: -105, ageMs: 10 * 60_000 }),
      lastLandAction: { lat: 31, lon: -105, at: new Date(NOW.getTime() - HOUR_MS) }
    };
    const service = new LocationReportService(store, config());

    const evaluation = await service.evaluate(fix({ source: "passive", avatarPosition: { lat: 31, lon: -105 } }));

    expect(evaluation.bucket).toBe("walk");
    expect(evaluation.holdUntil).toBeNull();
    expect(evaluation.holdReason).toBeNull();
    expect(evaluation.farRelocations7d).toBe(0);
  });

  it("sets a transit hold from a car-speed passive pair, sized by the distance travelled", async () => {
    const store = new FakeLocationReportStore();
    // ~33 km in 15 minutes is ~133 km/h (car); cooldown(33 km) is ~13 minutes.
    store.state = {
      ...stateWithFix({ lat: 40.3, lon: -105, ageMs: 15 * 60_000 }, { lastFixPassive: true }),
      lastLandAction: { lat: 31, lon: -105, at: new Date(NOW.getTime() - HOUR_MS) }
    };
    const holdListener = { noteHold: vi.fn() };
    const service = new LocationReportService(store, config(), { holdListener });
    const input = fix({ source: "passive", fixReason: "periodic" });

    const evaluation = await service.evaluate(input);

    expect(evaluation.bucket).toBe("car");
    expect(evaluation.holdReason).toBe("transit");
    expect(minutesAfterNow(evaluation.holdUntil)).toBeGreaterThan(10);
    expect(minutesAfterNow(evaluation.holdUntil)).toBeLessThan(17);
    expect(evaluation.skipStore).toBe(false);
    expect(evaluation.features).toMatchObject({ fixReason: "periodic", previousFixPassive: true });

    await service.record(input, evaluation, "accepted");
    expect(store.recorded[0]!.accepted).toMatchObject({ holdReason: "transit" });
    expect(holdListener.noteHold).toHaveBeenCalledWith(input.accountId, evaluation.holdUntil, "transit");
  });

  it("scores an impossible passive pair and a passive air pair", async () => {
    const store = new FakeLocationReportStore();
    store.state = stateWithFix({ lat: 30, lon: -105, ageMs: 10 * 60_000 });
    const service = new LocationReportService(store, config());
    const impossible = await service.evaluate(fix({ source: "passive" }));
    expect(impossible.bucket).toBe("impossible");
    expect(impossible.signals).toEqual([{ rule: "speed_impossible", weight: 4 }]);
    expect(impossible.holdUntil).toBeNull();

    // ~111 km in 15 minutes is ~445 km/h (air).
    store.state = stateWithFix({ lat: 41, lon: -105, ageMs: 15 * 60_000 });
    const air = await service.evaluate(fix({ source: "passive" }));
    expect(air.bucket).toBe("air");
    expect(air.signals).toEqual([{ rule: "speed_air", weight: 1 }]);
    expect(air.holdReason).toBe("transit");
  });

  it("only logs fast speeds as features when a passive pair is under 20 s apart", async () => {
    const store = new FakeLocationReportStore();
    // ~3.3 km in 10 s would be impossible.
    store.state = stateWithFix({ lat: 40.03, lon: -105, ageMs: 10_000 });
    const service = new LocationReportService(store, config({ TRUST_LOCATION_REJECT_MODE: "enforce" }));

    const passive = await service.evaluate(fix({ source: "passive" }));
    expect(passive).toMatchObject({ verdict: "accepted", bucket: null, holdUntil: null, score: 0 });
    expect(passive.impliedKmh!).toBeGreaterThan(900);
    expect(passive.features).toMatchObject({ speedNoiseGuarded: "impossible" });

    // A relocation right after a passive fix is guarded too.
    store.state = stateWithFix({ lat: 40.03, lon: -105, ageMs: 10_000 }, { lastFixPassive: true });
    const relocation = await service.evaluate(fix());
    expect(relocation.verdict).toBe("accepted");
    expect(relocation.bucket).toBeNull();

    // Two relocation fixes are never guarded; 20 s or more is never guarded.
    store.state = stateWithFix({ lat: 40.03, lon: -105, ageMs: 10_000 });
    expect((await service.evaluate(fix())).bucket).toBe("impossible");
    store.state = stateWithFix({ lat: 40.03, lon: -105, ageMs: 20_000 }, { lastFixPassive: true });
    expect((await service.evaluate(fix({ source: "passive" }))).bucket).toBe("air");
  });

  it("skips storing a redundant passive fix but still advances the last fix", async () => {
    const store = new FakeLocationReportStore();
    const lastStoredFix = { lat: 40.0004, lon: -105, accuracyM: 10, at: new Date(NOW.getTime() - 5 * 60_000) };
    store.state = stateWithFix(
      { lat: 40.0004, lon: -105, accuracyM: 10, ageMs: 3 * 60_000 },
      { lastFixPassive: true, lastStoredFix }
    );
    const service = new LocationReportService(store, config(), { familiarity: async () => true });
    // ~44 m raw, minus 20 m accuracy: within 50 m.
    const input = fix({ source: "passive", accuracyM: 10 });

    const evaluation = await service.evaluate(input);
    expect(evaluation.skipStore).toBe(true);
    const result = await service.record(input, evaluation, "accepted");

    expect(result).toEqual({ reportId: null, seq: null });
    expect(store.recorded).toEqual([]);
    expect(store.unstored).toEqual([{
      accountId: input.accountId, lat: 40, lon: -105, accuracyM: 10, at: NOW, presenceDay: "2026-10-01", confirmedDaysTarget: 3,
      assurance: null, settlement: null
    }]);

    // Too old, too far, or a relocation: stored.
    store.state = stateWithFix(
      { lat: 40.0004, lon: -105, accuracyM: 10, ageMs: 3 * 60_000 },
      { lastStoredFix: { ...lastStoredFix, at: new Date(NOW.getTime() - 15 * 60_000) } }
    );
    expect((await service.evaluate(input)).skipStore).toBe(false);
    store.state = stateWithFix(
      { lat: 40.0004, lon: -105, accuracyM: 10, ageMs: 3 * 60_000 },
      { lastStoredFix: { ...lastStoredFix, lat: 40.001 } }
    );
    expect((await service.evaluate(input)).skipStore).toBe(false);
    store.state = stateWithFix({ lat: 40.0004, lon: -105, ageMs: 3 * 60_000 }, { lastStoredFix });
    expect((await service.evaluate(fix({ accuracyM: 10 }))).skipStore).toBe(false);
    // No previously stored fix: stored.
    store.state = stateWithFix({ lat: 40.0004, lon: -105, ageMs: 3 * 60_000 });
    expect((await service.evaluate(input)).skipStore).toBe(false);
  });

  it("stores a passive fix that carries a signal even when it is close by", async () => {
    const store = new FakeLocationReportStore();
    // Same spot, but the previous fix was 5 minutes ago 120 km away.
    store.state = stateWithFix(
      { lat: 41.1, lon: -105, ageMs: 5 * 60_000 },
      { lastStoredFix: { lat: 40, lon: -105, accuracyM: null, at: new Date(NOW.getTime() - 10 * 60_000) } }
    );
    const service = new LocationReportService(store, config());
    const evaluation = await service.evaluate(fix({ source: "passive" }));
    expect(evaluation.signals.length).toBeGreaterThan(0);
    expect(evaluation.skipStore).toBe(false);
  });
});

describe("LocationReportService.record", () => {
  it("records an accepted fix with its hold and sends nonzero signals", async () => {
    const store = new FakeLocationReportStore();
    store.state = stateWithFix({ lat: 0, lon: 0, ageMs: HOUR_MS });
    const sink: TrustSignalSink = { recordSignals: vi.fn(async () => undefined) };
    const holdListener = { noteHold: vi.fn() };
    const service = new LocationReportService(store, config(), { sink, holdListener });
    const input = fix({ accuracyM: 12, clientPlatform: "android", networkHash: "v1:abc" });
    const evaluation = await service.evaluate(input);

    const result = await service.record(input, evaluation, "accepted");

    expect(result.seq).toBe(1);
    const [entry] = store.recorded;
    expect(entry!.row).toMatchObject({
      verdict: "shadow_rejected",
      verdictReason: "speed_impossible",
      speedBucket: "impossible",
      prevReportId: "00000000-0000-4000-8000-0000000000aa",
      accuracyM: 12,
      clientPlatform: "android",
      networkHash: "v1:abc",
      receivedAt: NOW,
      score: 4
    });
    expect(entry!.accepted).toEqual({
      holdUntil: evaluation.holdUntil,
      holdReason: "relocation_cooldown",
      relocations7dFar: 1,
      presenceDay: null,
      confirmedDaysTarget: 3
    });
    expect(sink.recordSignals).toHaveBeenCalledWith({
      accountId: input.accountId,
      reportId: result.reportId,
      signals: [{ rule: "speed_impossible", weight: 4 }]
    });
    expect(holdListener.noteHold).toHaveBeenCalledWith(input.accountId, evaluation.holdUntil, "relocation_cooldown");
  });

  it("records an enforce rejection without touching fix state", async () => {
    const store = new FakeLocationReportStore();
    store.state = stateWithFix({ lat: 0, lon: 0, ageMs: HOUR_MS });
    const holdListener = { noteHold: vi.fn() };
    const service = new LocationReportService(store, config({ TRUST_LOCATION_REJECT_MODE: "enforce" }), { holdListener });
    const evaluation = await service.evaluate(fix());

    await service.record(fix(), evaluation, "travel_failed");
    expect(holdListener.noteHold).not.toHaveBeenCalled();

    expect(store.recorded[0]!.row.verdict).toBe("rejected");
    expect(store.recorded[0]!.accepted).toBeNull();
  });

  it("records a failed travel as travel_failed without updating fix state", async () => {
    const store = new FakeLocationReportStore();
    const service = new LocationReportService(store, config());
    const evaluation = await service.evaluate(fix({ avatarPosition: { lat: 31, lon: -105 } }));

    await service.record(fix(), evaluation, "travel_failed");

    expect(store.recorded[0]!.row.verdict).toBe("travel_failed");
    expect(store.recorded[0]!.row.features).toMatchObject({ evaluatedVerdict: "accepted" });
    expect(store.recorded[0]!.accepted).toBeNull();
  });

  it("keeps the report when the signal sink fails and skips the sink in off mode", async () => {
    const store = new FakeLocationReportStore();
    store.state = stateWithFix({ lat: 0, lon: 0, ageMs: HOUR_MS });
    const logger = { warn: vi.fn() };
    const failingSink: TrustSignalSink = {
      recordSignals: vi.fn(async () => {
        throw new Error("sink down");
      })
    };
    const shadow = new LocationReportService(store, config(), { sink: failingSink, logger });
    await expect(shadow.record(fix(), await shadow.evaluate(fix()), "accepted")).resolves.toMatchObject({ seq: 1 });
    expect(logger.warn).toHaveBeenCalledOnce();

    const offSink: TrustSignalSink = { recordSignals: vi.fn(async () => undefined) };
    const off = new LocationReportService(store, config({ TRUST_LOCATION_REJECT_MODE: "off" }), { sink: offSink });
    await off.record(fix(), await off.evaluate(fix()), "accepted");
    expect(offSink.recordSignals).not.toHaveBeenCalled();
    expect(store.recorded[1]!.row.verdict).toBe("accepted");
  });
});
