import { describe, expect, it, vi } from "vitest";

import type { IpGeoLookup, IpGeoResult } from "./ipGeo.js";
import {
  LocationReportService,
  type LocationFixInput,
  type SettlementFixSource,
  type TrustSignalSink
} from "./trustService.js";
import type {
  AccountLocationState,
  LocationReportRow,
  LocationReportStore,
  UnstoredFix
} from "./trustStore.js";

const START = new Date("2026-10-01T12:00:00.000Z");
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const DENVER = { lat: 39.74, lon: -104.99 };
const LONDON_POINT = { lat: 51.5, lon: -0.12 };

class FakeStore implements LocationReportStore {
  recorded: LocationReportRow[] = [];
  unstored: UnstoredFix[] = [];

  async loadLocationContext() {
    return { state: null as AccountLocationState | null, farRelocationsSince: 0 };
  }

  async recordLocationReport(row: LocationReportRow) {
    this.recorded.push(row);
    return { reportId: row.id, seq: this.recorded.length };
  }

  async updateLastFix(fix: UnstoredFix) {
    this.unstored.push(fix);
  }

  async countHardMismatchFixes(_accountId: string, since: Date) {
    const rows = this.recorded.filter((row) => row.receivedAt >= since);
    return {
      ip: rows.filter((row) => row.features.hardIpMismatch === true).length,
      carrier: rows.filter((row) => row.features.hardCarrierMismatch === true).length
    };
  }

  async deleteLocationReportsBefore() {
    return 0;
  }
}

function ipGeo(result: Partial<IpGeoResult> | null): IpGeoLookup {
  return {
    isAvailable: () => result !== null,
    lookup: () => result === null ? null : { asn: null, organization: null, country: null, point: null, ...result }
  };
}

const FIXED_FAR: Partial<IpGeoResult> = { asn: 7922, country: "GB", point: LONDON_POINT };
const MOBILE_FAR: Partial<IpGeoResult> = { asn: 21928, country: "GB", point: LONDON_POINT };
const VPN: Partial<IpGeoResult> = { asn: 16509, country: "GB", point: LONDON_POINT };

function setup(
  mode: "off" | "shadow" | "enforce",
  geo: Partial<IpGeoResult> | null = null,
  revokeWeight?: number
) {
  const store = new FakeStore();
  const sink: TrustSignalSink = { recordSignals: vi.fn(async () => undefined) };
  const revoke = vi.fn(async () => undefined);
  const settlement: SettlementFixSource = {
    rules: () => ({ radiusM: 25_000, minGapMs: 170_000, minDistinctPositions: 3, minAccountAgeMs: 0 }),
    rollTargets: () => ({ checks: 22, days: 4 }),
    revoke
  };
  let clock = START.getTime();
  const service = new LocationReportService(
    store,
    {
      TRUST_LOCATION_REJECT_MODE: "off",
      TRUST_LAND_ACTION_MIN_DISPLACEMENT_M: 500,
      TRUST_TRANSIT_HOLD_MINUTES: 10,
      TRUST_SETTLE_ACCURACY_M: 5000,
      TRUST_SETTLE_ASSURANCE_MODE: "shadow",
      TRUST_MISMATCH_MODE: mode,
      ...(revokeWeight === undefined ? {} : { TRUST_MISMATCH_REVOKE_WEIGHT: revokeWeight })
    },
    { sink, settlement, ipGeo: ipGeo(geo), now: () => new Date(clock) }
  );
  if (revokeWeight !== undefined) {
    // The ledger: every mismatch-family weight the sink received.
    (store as FakeStore & { mismatchWeightSince?: unknown }).mismatchWeightSince = vi.fn(async (_id: string, rules: readonly string[]) =>
      (sink.recordSignals as ReturnType<typeof vi.fn>).mock.calls
        .flatMap(([call]) => (call as { signals: Array<{ rule: string; weight: number }> }).signals)
        .filter((signal) => rules.includes(signal.rule))
        .reduce((total, signal) => total + signal.weight, 0));
  }
  async function passive(extra: Partial<LocationFixInput> = {}, advanceMs = 3 * 60_000) {
    clock += advanceMs;
    const input: LocationFixInput = {
      accountId: ACCOUNT,
      playerId: "p1",
      source: "passive",
      ...DENVER,
      accuracyM: 20,
      clientPlatform: "android",
      deviceInstallationId: null,
      networkHash: null,
      networkPrefixHash: null,
      clientIp: "203.0.113.9",
      avatarPosition: null,
      ...extra
    };
    const evaluation = await service.evaluate(input);
    await service.record(input, evaluation, "accepted");
    return evaluation;
  }
  const sent = () => (sink.recordSignals as ReturnType<typeof vi.fn>).mock.calls
    .flatMap(([call]) => (call as { signals: Array<{ rule: string }> }).signals.map((signal) => signal.rule));
  return { service, store, sink, revoke, passive, sent };
}

describe("mismatch signals in the location report path", () => {
  it("VPN/hosting records +1 once per day and the fix does not count toward Settled", async () => {
    const t = setup("shadow", VPN);
    const first = await t.passive();
    expect(first.settlementCountable).toBe(false);
    expect(first.features).toMatchObject({ ipAsnClass: "hosting_vpn" });
    await t.passive();
    await t.passive();
    expect(t.sent().filter((rule) => rule === "ip_hosting_or_vpn")).toHaveLength(1);
    // VPN suppresses the distance rule.
    expect(t.sent()).not.toContain("ip_location_mismatch");
  });

  it("a clean fix still counts toward Settled", async () => {
    const t = setup("shadow", { asn: 7922, country: "US", point: DENVER });
    expect((await t.passive()).settlementCountable).toBe(true);
  });

  it("enforce revokes with hard_mismatch only on the third fixed-line mismatch in 24 h", async () => {
    const t = setup("enforce", FIXED_FAR);
    await t.passive();
    await t.passive();
    expect(t.revoke).not.toHaveBeenCalled();
    const third = await t.passive();
    expect(third.hardMismatch).toMatchObject({ kind: "ip_location_mismatch", fixes: 3 });
    expect(t.revoke).toHaveBeenCalledTimes(1);
    expect(t.revoke).toHaveBeenCalledWith(ACCOUNT, "hard_mismatch", { kind: "ip_location_mismatch", fixes: 3 });
    // Not re-revoked on every following fix.
    await t.passive();
    expect(t.revoke).toHaveBeenCalledTimes(1);
    expect(t.sent().filter((rule) => rule === "ip_location_mismatch")).toHaveLength(1);
  });

  it("does not count mismatches older than 24 h", async () => {
    const t = setup("enforce", FIXED_FAR);
    await t.passive();
    await t.passive({}, 13 * 3_600_000);
    await t.passive({}, 13 * 3_600_000);
    expect(t.revoke).not.toHaveBeenCalled();
  });

  it("shadow records signals and the hard flag but never revokes", async () => {
    const t = setup("shadow", FIXED_FAR);
    for (let index = 0; index < 4; index += 1) await t.passive();
    expect(t.revoke).not.toHaveBeenCalled();
    expect(t.sent()).toContain("ip_location_mismatch");
    expect(t.store.recorded[0]!.features).toMatchObject({ hardIpMismatch: true, mismatchMode: "shadow" });
  });

  it("mobile country mismatch is a signal but never hard", async () => {
    const t = setup("enforce", MOBILE_FAR);
    for (let index = 0; index < 5; index += 1) await t.passive();
    expect(t.sent()).toContain("ip_location_mismatch");
    expect(t.revoke).not.toHaveBeenCalled();
    expect(t.store.recorded[0]!.features.hardIpMismatch).toBe(false);
  });

  it("carrier country mismatch is hard after 3 fixes in 24 h (enforce)", async () => {
    const t = setup("enforce");
    await t.passive({ networkCountryIso: "gb" });
    await t.passive({ networkCountryIso: "gb" });
    expect(t.revoke).not.toHaveBeenCalled();
    await t.passive({ networkCountryIso: "gb" });
    expect(t.revoke).toHaveBeenCalledWith(ACCOUNT, "hard_mismatch", { kind: "carrier_country_mismatch", fixes: 3 });
    expect(t.sent()).toContain("carrier_country_mismatch");
  });

  it("timezone mismatch is +1 and never hard", async () => {
    const t = setup("enforce");
    for (let index = 0; index < 5; index += 1) await t.passive({ deviceTimeZone: "Asia/Tokyo" });
    expect(t.sent().filter((rule) => rule === "timezone_mismatch")).toHaveLength(1);
    expect(t.revoke).not.toHaveBeenCalled();
  });

  it("gps_static fires after 10 identical native fixes and is never hard", async () => {
    const t = setup("enforce");
    const evaluations = [];
    for (let index = 0; index < 12; index += 1) {
      evaluations.push(await t.passive({ lat: 40.123456, lon: -105.123456 }));
    }
    expect(evaluations[8]!.mismatchSignals).toEqual([]);
    expect(evaluations[9]!.mismatchSignals?.map((signal) => signal.rule)).toEqual(["gps_static"]);
    expect(t.sent()).toEqual(["gps_static"]);
    expect(t.revoke).not.toHaveBeenCalled();
    // A web fix is not native evidence and resets the run.
    await t.passive({ lat: 40.123456, lon: -105.123456, clientPlatform: "web" });
    const next = await t.passive({ lat: 40.123456, lon: -105.123456 });
    expect(next.features.staticRun).toBe(1);
  });

  it("satellite is neutral: no signal, still counts", async () => {
    const t = setup("enforce", { asn: 14593, country: "GB", point: LONDON_POINT });
    const evaluation = await t.passive();
    expect(t.sent()).toEqual([]);
    expect(evaluation.settlementCountable).toBe(true);
    expect(evaluation.features).toMatchObject({ ipSatellite: true });
  });

  it("skips IP signals when the database is missing but keeps the others", async () => {
    const t = setup("enforce", null);
    const evaluation = await t.passive({ deviceTimeZone: "Asia/Tokyo" });
    expect(evaluation.features.ipAsnClass).toBeUndefined();
    expect(t.sent()).toEqual(["timezone_mismatch"]);
  });

  it("off records nothing and does not gate on TRUST_LOCATION_REJECT_MODE", async () => {
    const off = setup("off", FIXED_FAR);
    await off.passive({ deviceTimeZone: "Asia/Tokyo", networkCountryIso: "gb" });
    expect(off.sent()).toEqual([]);
    expect(off.store.recorded[0]?.features.ipAsnClass).toBeUndefined();
    // Reject mode is "off" in setup and the signals above still flow when mismatch is on.
    const on = setup("shadow");
    await on.passive({ deviceTimeZone: "Asia/Tokyo" });
    expect(on.sent()).toEqual(["timezone_mismatch"]);
  });

  it("never stores the raw client IP", async () => {
    const t = setup("shadow", FIXED_FAR);
    await t.passive();
    expect(JSON.stringify(t.store.recorded)).not.toContain("203.0.113.9");
  });

  it("enforce revokes when soft mismatches add up to TRUST_MISMATCH_REVOKE_WEIGHT in 24 h (owner decision F)", async () => {
    const t = setup("enforce", MOBILE_FAR, 5);
    await t.passive({ deviceTimeZone: "Asia/Tokyo" }); // ip country +2, timezone +1
    expect(t.revoke).not.toHaveBeenCalled();
    await t.passive({ networkCountryIso: "gb" }); // carrier +2 (one fix: not hard yet)
    expect(t.revoke).toHaveBeenCalledWith(ACCOUNT, "hard_mismatch", { kind: "accumulated", weight: 5 });
  });

  it("never revokes on accumulated weight below the threshold, in shadow, or with the threshold at 0", async () => {
    const below = setup("enforce", MOBILE_FAR, 5);
    for (let index = 0; index < 4; index += 1) await below.passive({ deviceTimeZone: "Asia/Tokyo" });
    expect(below.revoke).not.toHaveBeenCalled();
    const shadow = setup("shadow", MOBILE_FAR, 5);
    await shadow.passive({ deviceTimeZone: "Asia/Tokyo" });
    await shadow.passive({ networkCountryIso: "gb" });
    expect(shadow.revoke).not.toHaveBeenCalled();
    const disabled = setup("enforce", MOBILE_FAR, 0);
    await disabled.passive({ deviceTimeZone: "Asia/Tokyo" });
    await disabled.passive({ networkCountryIso: "gb" });
    expect(disabled.revoke).not.toHaveBeenCalled();
  });
});
