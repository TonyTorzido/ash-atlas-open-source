import { formatAttestBoundFix, parseNativeLocationSignals } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { AttestationResolver, attestationRefHash } from "./attestation/attestationResolver.js";
import type { StoredAttestation } from "./attestation/attestationStore.js";
import {
  LocationReportService,
  type LocationFixInput,
  type SettlementFixSource,
  type TrustSignalSink
} from "./trustService.js";
import type {
  AcceptedFixUpdate,
  AccountLocationState,
  LocationReportRow,
  LocationReportStore
} from "./trustStore.js";

const START = new Date("2026-10-01T12:00:00.000Z");
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const INSTALLATION = "00000000-0000-4000-8000-0000000000bb";
const DENVER = { lat: 39.74, lon: -104.99 };
const REF = "r".repeat(43);
const FIX_TS = 1_790_000_000_123;

class FakeStore implements LocationReportStore {
  recorded: Array<{ row: LocationReportRow; accepted: AcceptedFixUpdate | null }> = [];
  async loadLocationContext() {
    return { state: null as AccountLocationState | null, farRelocationsSince: 0 };
  }
  async recordLocationReport(row: LocationReportRow, accepted: AcceptedFixUpdate | null) {
    this.recorded.push({ row, accepted });
    return { reportId: row.id, seq: this.recorded.length };
  }
  async updateLastFix(): Promise<void> {}
  async deleteLocationReportsBefore() {
    return 0;
  }
}

function stored(overrides: Partial<StoredAttestation> = {}): StoredAttestation {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: ACCOUNT,
    sessionId: SESSION,
    installationId: INSTALLATION,
    platform: "android",
    method: "play_integrity",
    purpose: "session",
    outcome: "pass",
    assurance: "attested",
    boundFix: null,
    expiresAt: new Date(START.getTime() + 60 * 60_000),
    ...overrides
  };
}

function setup(
  modes: { mock?: "off" | "shadow" | "enforce"; attestation?: "off" | "shadow" | "enforce" } = {},
  attestation: StoredAttestation | null = null
) {
  const store = new FakeStore();
  const sink: TrustSignalSink = { recordSignals: vi.fn(async () => undefined) };
  const revoke = vi.fn(async () => undefined);
  const settlement: SettlementFixSource = {
    rules: () => ({ radiusM: 25_000, minGapMs: 170_000, minDistinctPositions: 3, minAccountAgeMs: 0 }),
    rollTargets: () => ({ checks: 22, days: 4 }),
    revoke
  };
  const resolver = new AttestationResolver({
    findByRefHash: async (hash) => (attestation && hash === attestationRefHash(REF) ? attestation : null)
  });
  const service = new LocationReportService(
    store,
    {
      TRUST_LOCATION_REJECT_MODE: "shadow",
      TRUST_LAND_ACTION_MIN_DISPLACEMENT_M: 500,
      TRUST_TRANSIT_HOLD_MINUTES: 10,
      TRUST_SETTLE_ACCURACY_M: 5000,
      TRUST_SETTLE_ASSURANCE_MODE: "shadow",
      TRUST_MISMATCH_MODE: "off",
      TRUST_MOCK_LOCATION_MODE: modes.mock ?? "shadow",
      TRUST_ATTESTATION_MODE: modes.attestation ?? "shadow"
    },
    { sink, settlement, attestations: resolver, now: () => START }
  );
  async function fix(extra: Partial<LocationFixInput> & { nativeWire?: unknown } = {}) {
    const { nativeWire, ...rest } = extra;
    const input: LocationFixInput = {
      accountId: ACCOUNT,
      playerId: "p1",
      source: "passive",
      ...DENVER,
      accuracyM: 20,
      clientPlatform: "android",
      deviceInstallationId: INSTALLATION,
      networkHash: null,
      networkPrefixHash: null,
      sessionId: SESSION,
      native: parseNativeLocationSignals(nativeWire),
      avatarPosition: null,
      ...rest
    };
    const evaluation = await service.evaluate(input);
    await service.record(input, evaluation, "accepted");
    return { evaluation, recorded: store.recorded.at(-1)! };
  }
  const sent = () => (sink.recordSignals as ReturnType<typeof vi.fn>).mock.calls
    .flatMap(([call]) => (call as { signals: Array<{ rule: string; weight: number }> }).signals);
  return { fix, sent, revoke };
}

describe("device trust in the location report path", () => {
  it("legacy shells and a missing block stay native_legacy and neutral", async () => {
    const t = setup();
    const none = await t.fix();
    expect(none.evaluation).toMatchObject({ verdict: "accepted", assurance: "native_legacy", settlementCountable: true });
    const legacy = await t.fix({ nativeWire: { v: 1, shellBuild: 8, plugin: false } });
    expect(legacy.evaluation.assurance).toBe("native_legacy");
    expect(legacy.evaluation.features).toMatchObject({ nativeBlock: "ok", nativeShellBuild: 8 });
    const malformed = await t.fix({ nativeWire: { v: 1, provider: "x".repeat(2000) } });
    expect(malformed.evaluation).toMatchObject({ assurance: "native_legacy", features: { nativeBlock: "malformed" } });
    expect(t.sent()).toEqual([]);
    expect((await t.fix({ clientPlatform: "web" })).evaluation).toMatchObject({ assurance: "web", settlementCountable: false });
  });

  it("GNSS zero satellites on an accurate fix is a weight-0 shadow signal; a real GNSS fix or a coarse one is not", async () => {
    const t = setup();
    await t.fix({ nativeWire: { v: 1, plugin: true, gnssSatellitesUsed: 9, gnssSatellitesVisible: 20 } });
    await t.fix({ accuracyM: 800, nativeWire: { v: 1, plugin: true, gnssSatellitesUsed: 0 } });
    expect(t.sent()).toEqual([]);
    await t.fix({ accuracyM: 6, nativeWire: { v: 1, plugin: true, gnssSatellitesUsed: 0, gnssSatellitesVisible: 0 } });
    expect(t.sent()).toEqual([expect.objectContaining({ rule: "gnss_zero_satellites", weight: 0 })]);
  });

  it("plugin without attestation is unverified", async () => {
    const t = setup();
    expect((await t.fix({ nativeWire: { v: 1, plugin: true } })).evaluation.assurance).toBe("unverified");
  });

  it("mock in shadow is flagged, signalled and applied, but never counted or revoked", async () => {
    const t = setup({ mock: "shadow" });
    const { evaluation, recorded } = await t.fix({ nativeWire: { v: 1, plugin: true, mock: true } });
    expect(evaluation).toMatchObject({ verdict: "shadow_rejected", reason: "mock_location", assurance: "flagged", settlementCountable: false });
    expect(recorded.accepted).not.toBeNull();
    expect(recorded.row.assurance).toBe("flagged");
    expect(t.sent()).toEqual([expect.objectContaining({ rule: "location_mock", weight: 3 })]);
    expect(t.revoke).not.toHaveBeenCalled();
  });

  it("mock in enforce is not applied and revokes Settled; relocation is refused", async () => {
    const t = setup({ mock: "enforce" });
    const passive = await t.fix({ nativeWire: { v: 1, plugin: true, simulated: true } });
    expect(passive.evaluation).toMatchObject({ verdict: "rejected", reason: "mock_location" });
    expect(passive.recorded.accepted).toBeNull();
    expect(t.revoke).toHaveBeenCalledWith(ACCOUNT, "location_mock", expect.anything());
    const relocation = await t.fix({ source: "relocation", nativeWire: { v: 1, plugin: true, mock: true } });
    expect(relocation.evaluation).toMatchObject({ verdict: "rejected", reason: "mock_location" });
    expect(t.sent().map((signal) => signal.rule)).toEqual(["location_mock", "relocation_mock"]);
    expect(t.sent()[1]!.weight).toBe(4);
    expect(t.revoke).toHaveBeenCalledWith(ACCOUNT, "relocation_mock", expect.anything());
  });

  it("mock mode off ignores the mock flag", async () => {
    const t = setup({ mock: "off" });
    expect((await t.fix({ nativeWire: { v: 1, mock: true } })).evaluation).toMatchObject({ verdict: "accepted", assurance: "native_legacy" });
    expect(t.sent()).toEqual([]);
  });

  it("a resolved attestation sets the assurance and attestation_id", async () => {
    const t = setup({}, stored());
    const { evaluation, recorded } = await t.fix({ nativeWire: { v: 1, plugin: true }, attestationRef: REF });
    expect(evaluation.assurance).toBe("attested");
    expect(recorded.row.attestationId).toBe(stored().id);
    const devicecheck = setup({}, stored({ method: "devicecheck", assurance: "device_checked", platform: "ios" }));
    expect((await devicecheck.fix({ clientPlatform: "ios", attestationRef: REF })).evaluation.assurance).toBe("device_checked");
    const off = setup({ attestation: "off" }, stored());
    expect((await off.fix({ attestationRef: REF })).evaluation.assurance).toBe("native_legacy");
  });

  it("resolves only for the same account, session and installation, unexpired", async () => {
    const otherSession = setup({}, stored({ sessionId: "00000000-0000-4000-8000-0000000000cc" }));
    expect((await otherSession.fix({ nativeWire: { v: 1, plugin: true }, attestationRef: REF })).evaluation.assurance).toBe("unverified");
    const otherAccount = setup({}, stored({ accountId: "00000000-0000-4000-8000-000000000002" }));
    expect((await otherAccount.fix({ attestationRef: REF })).evaluation.assurance).toBe("native_legacy");
    const otherInstallation = setup({}, stored({ installationId: null }));
    expect((await otherInstallation.fix({ attestationRef: REF })).evaluation.assurance).toBe("native_legacy");
    const expired = setup({}, stored({ expiresAt: START }));
    expect((await expired.fix({ attestationRef: REF })).evaluation.assurance).toBe("native_legacy");
  });

  it("relocations need a fix-bound attestation; a different fix is attest_tamper", async () => {
    const boundFix = formatAttestBoundFix({ ...DENVER, accuracy: 20, fixTimestampMs: FIX_TS });
    const relocationRow = stored({ purpose: "relocation", boundFix });
    const nativeWire = { v: 1, plugin: true, fixTimestampMs: FIX_TS };

    const matching = setup({}, relocationRow);
    expect((await matching.fix({ source: "relocation", nativeWire, attestationRef: REF })).evaluation.assurance).toBe("attested");
    // Same strings after toFixed rounding.
    expect((await matching.fix({ source: "relocation", nativeWire, attestationRef: REF, lat: 39.7400001 })).evaluation.assurance)
      .toBe("attested");

    const sessionOnly = setup({}, stored());
    expect((await sessionOnly.fix({ source: "relocation", nativeWire, attestationRef: REF })).evaluation.assurance).toBe("unverified");

    const shadow = setup({ attestation: "shadow" }, relocationRow);
    const moved = await shadow.fix({ source: "relocation", nativeWire, attestationRef: REF, lat: 39.75 });
    expect(moved.evaluation).toMatchObject({ assurance: "flagged", attestTamper: true });
    expect(shadow.sent()).toEqual([expect.objectContaining({ rule: "attest_tamper", weight: 4 })]);
    expect(shadow.revoke).not.toHaveBeenCalled();

    const enforce = setup({ attestation: "enforce" }, relocationRow);
    const otherTime = await enforce.fix({ source: "relocation", nativeWire: { ...nativeWire, fixTimestampMs: FIX_TS + 1 }, attestationRef: REF });
    expect(otherTime.evaluation.assurance).toBe("flagged");
    expect(enforce.revoke).toHaveBeenCalledWith(ACCOUNT, "attest_tamper", expect.anything());
  });
});
