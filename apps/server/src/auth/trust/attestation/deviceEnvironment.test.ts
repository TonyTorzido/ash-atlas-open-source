import { describe, expect, it, vi } from "vitest";

import type { TrustSignalSink } from "../trustService.js";
import {
  DeviceEnvironmentService,
  environmentSignal,
  evaluateEnvironmentSignals,
  gnssZeroSatellites,
  installIdHash,
  summarizeEnvironment,
  type DeviceEnvironmentConfig,
  type DeviceEnvironmentStore,
  type EnvironmentReportInsert
} from "./deviceEnvironment.js";
import { TrustAdminOps } from "../trustAdminOps.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const DENVER = { lat: 39.7392, lon: -104.9903 };
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const CONFIG: DeviceEnvironmentConfig = {
  TRUST_ENVIRONMENT_SIGNALS_MODE: "shadow",
  TRUST_ENVIRONMENT_SIGNAL_WEIGHTS: { env_emulator: 2 },
  TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD: 3,
  TRUST_DEVICECHECK_BIT_SET_ENABLED: false,
  TRUST_ATTEST_RETENTION_DAYS: 90
};

const CLEAN = {
  v: 1,
  installId: "install-clean-0001",
  installIdPersistent: true,
  installSource: "store" as const,
  emulatorHints: [],
  rootHints: [],
  debuggerAttached: false,
  vpnActive: false,
  simCountryIso: "us",
  networkCountryIso: "us",
  cellMccs: ["310"],
  timeZone: "America/Denver",
  locale: "en_US"
};

function fakeStore(overrides: Partial<DeviceEnvironmentStore> = {}) {
  const reports: EnvironmentReportInsert[] = [];
  const tokens = new Map<string, string>();
  const store: DeviceEnvironmentStore = {
    lastFix: vi.fn(async () => DENVER),
    insertReport: vi.fn(async (row: EnvironmentReportInsert) => {
      reports.push(row);
    }),
    installAccountCount: vi.fn(async (hash: string) =>
      new Set(reports.filter((row) => row.summary.installIdHash === hash).map((row) => row.accountId)).size),
    saveDeviceCheckToken: vi.fn(async (accountId: string, token: string) => {
      tokens.set(accountId, token);
    }),
    loadDeviceCheckToken: vi.fn(async (accountId: string) => tokens.get(accountId) ?? null),
    cleanup: vi.fn(async () => 0),
    ...overrides
  };
  return { store, reports, tokens };
}

function sink() {
  const calls: Array<{ accountId: string; signals: Array<{ rule: string; weight: number; metadata?: Record<string, unknown> }> }> = [];
  const value: TrustSignalSink = {
    recordSignals: vi.fn(async (input) => {
      calls.push({ accountId: input.accountId, signals: [...input.signals] });
    })
  };
  return { value, calls, rules: () => calls.flatMap((call) => call.signals.map((signal) => signal.rule)) };
}

describe("environment signals (pure)", () => {
  const summaryOf = (environment: Record<string, unknown>) =>
    summarizeEnvironment({ ...CLEAN, ...environment } as typeof CLEAN);
  const evaluate = (environment: Record<string, unknown>, extra: Partial<Parameters<typeof evaluateEnvironmentSignals>[0]> = {}) =>
    evaluateEnvironmentSignals({
      summary: summaryOf(environment),
      gpsCountries: new Set(["US"]),
      playIntegrity: null,
      deviceCheckBit0: null,
      installAccounts: 1,
      installThreshold: 3,
      ...extra
    }).map((signal) => signal.rule);

  it("stores only the install id hash and derived countries", () => {
    const summary = summaryOf({ timeZone: "Europe/Berlin", locale: "de-DE", cellMccs: ["262", "999"] });
    expect(summary.installIdHash).toBe(installIdHash(CLEAN.installId));
    expect(summary.installIdHash).not.toContain("install-clean");
    expect(summary.timeZoneCountries).toContain("DE");
    expect(summary.localeCountry).toBe("DE");
    expect(summary.cellCountries).toEqual(["DE"]);
    expect(JSON.stringify(summary)).not.toContain("Europe/Berlin");
  });

  it("raises nothing for a clean device in its GPS country", () => {
    expect(evaluate({})).toEqual([]);
  });

  it("raises each environment signal when its condition holds", () => {
    expect(evaluate({
      emulatorHints: ["goldfish"],
      rootHints: ["su"],
      debuggerAttached: true,
      installSource: "sideload",
      vpnActive: true,
      simCountryIso: "ru",
      networkCountryIso: "ru",
      cellMccs: ["250"],
      timeZone: "Europe/Moscow"
    }, { installAccounts: 3 })).toEqual([
      "env_emulator",
      "env_root",
      "env_debugger",
      "env_sideload",
      "env_vpn_active",
      "env_sim_country_mismatch",
      "env_network_country_mismatch",
      "env_cell_country_mismatch",
      "env_timezone_country_mismatch",
      "install_multi_account"
    ]);
  });

  it("skips country comparisons without a GPS country and below the install threshold", () => {
    expect(evaluate({ simCountryIso: "ru", timeZone: "Europe/Moscow" }, { gpsCountries: new Set(), installAccounts: 2 })).toEqual([]);
  });

  it("reads DeviceCheck bit0 and Play Integrity optional verdicts", () => {
    const rules = evaluateEnvironmentSignals({
      summary: null,
      gpsCountries: new Set(["US"]),
      playIntegrity: { deviceActivityLevel: "LEVEL_4", appsDetected: ["KNOWN_INSTALLED", "UNKNOWN_CAPTURING"] },
      deviceCheckBit0: true,
      installAccounts: 0,
      installThreshold: 3
    }).map((signal) => signal.rule);
    expect(rules).toEqual(["devicecheck_spoof_bit", "pi_high_device_activity", "pi_risky_app_access"]);
    expect(evaluateEnvironmentSignals({
      summary: null,
      gpsCountries: new Set(),
      playIntegrity: { deviceActivityLevel: "LEVEL_1", appsDetected: ["KNOWN_INSTALLED"], playProtectVerdict: "NO_ISSUES" },
      deviceCheckBit0: false,
      installAccounts: 0,
      installThreshold: 3
    })).toEqual([]);
  });

  it("weighs 0 in shadow, the configured weight in enforce, nothing when off", () => {
    expect(environmentSignal("env_emulator", CONFIG, ACCOUNT, NOW)).toMatchObject({
      weight: 0,
      metadata: { mode: "shadow", configuredWeight: 2, dedupeKey: `env_emulator:${ACCOUNT}:2026-10-04` }
    });
    expect(environmentSignal("env_emulator", { ...CONFIG, TRUST_ENVIRONMENT_SIGNALS_MODE: "enforce" }, ACCOUNT, NOW)?.weight).toBe(2);
    expect(environmentSignal("env_root", { ...CONFIG, TRUST_ENVIRONMENT_SIGNALS_MODE: "enforce" }, ACCOUNT, NOW)?.weight).toBe(0);
    expect(environmentSignal("env_emulator", { ...CONFIG, TRUST_ENVIRONMENT_SIGNALS_MODE: "off" }, ACCOUNT, NOW)).toBeNull();
  });

  it("flags GNSS zero satellites only on a fix that claims good accuracy", () => {
    expect(gnssZeroSatellites({ v: 1, gnssSatellitesUsed: 0 }, 8, 50)).toBe(true);
    expect(gnssZeroSatellites({ v: 1, gnssSatellitesUsed: 0 }, 900, 50)).toBe(false);
    expect(gnssZeroSatellites({ v: 1, gnssSatellitesUsed: 6 }, 8, 50)).toBe(false);
    expect(gnssZeroSatellites({ v: 1 }, 8, 50)).toBe(false);
    expect(gnssZeroSatellites(null, 8, 50)).toBe(false);
  });
});

describe("DeviceEnvironmentService", () => {
  it("links accounts sharing one install id and raises install_multi_account at the threshold", async () => {
    const { store, reports } = fakeStore();
    const signals = sink();
    const service = new DeviceEnvironmentService(store, CONFIG, { sink: signals.value, now: () => NOW });
    const accounts = ["a", "b", "c"].map((suffix) => `${suffix.repeat(8)}-1111-4111-8111-111111111111`);
    for (const accountId of accounts) {
      await service.record({ accountId, attestationId: null, platform: "android", environment: CLEAN });
    }
    expect(reports).toHaveLength(3);
    expect(new Set(reports.map((row) => row.summary.installIdHash)).size).toBe(1);
    expect(signals.calls.map((call) => call.accountId)).toEqual([accounts[2]]);
    expect(signals.calls[0]!.signals[0]).toMatchObject({ rule: "install_multi_account", weight: 0, metadata: { accounts: 3 } });
    // Another install does not count.
    await service.record({ accountId: accounts[0]!, attestationId: null, platform: "android", environment: { ...CLEAN, installId: "other-install-02" } });
    expect(signals.calls).toHaveLength(1);
  });

  it("ignores an out-of-bounds block, still scores Play Integrity, and does nothing when off", async () => {
    const { store, reports } = fakeStore();
    const signals = sink();
    const service = new DeviceEnvironmentService(store, CONFIG, { sink: signals.value, now: () => NOW });
    await service.record({
      accountId: ACCOUNT,
      attestationId: null,
      platform: "android",
      environment: { ...CLEAN, emulatorHints: ["bad hint!"] },
      playIntegrity: { deviceActivityLevel: "LEVEL_3" }
    });
    expect(reports).toHaveLength(0);
    expect(signals.rules()).toEqual(["pi_high_device_activity"]);

    const off = fakeStore();
    const offSink = sink();
    await new DeviceEnvironmentService(off.store, { ...CONFIG, TRUST_ENVIRONMENT_SIGNALS_MODE: "off" }, { sink: offSink.value })
      .record({ accountId: ACCOUNT, attestationId: null, platform: "android", environment: { ...CLEAN, emulatorHints: ["x"] } });
    expect(off.reports).toHaveLength(0);
    expect(offSink.calls).toHaveLength(0);
  });

  it("queries DeviceCheck bit0 on iOS: set raises devicecheck_spoof_bit, unset does not", async () => {
    const queryBits = vi.fn()
      .mockResolvedValueOnce({ bit0: true, bit1: false, lastUpdateTime: "2026-09" })
      .mockResolvedValueOnce("unset");
    const deviceCheck = { queryBits, updateBits: vi.fn() };
    const { store, reports, tokens } = fakeStore();
    const signals = sink();
    const service = new DeviceEnvironmentService(store, CONFIG, { sink: signals.value, deviceCheck, now: () => NOW });
    await service.record({ accountId: ACCOUNT, attestationId: null, platform: "ios", environment: CLEAN, deviceCheckToken: "dG9rZW4=" });
    expect(queryBits).toHaveBeenCalledWith("dG9rZW4=");
    expect(signals.rules()).toEqual(["devicecheck_spoof_bit"]);
    expect(reports[0]!.deviceCheckBit0).toBe(true);
    // Bit setting is off: the token is not kept.
    expect(tokens.size).toBe(0);
    await service.record({ accountId: ACCOUNT, attestationId: null, platform: "ios", environment: CLEAN, deviceCheckToken: "dG9rZW4=" });
    expect(signals.rules()).toEqual(["devicecheck_spoof_bit"]);
    expect(reports[1]!.deviceCheckBit0).toBe(false);
  });

  it("sets bit0 on a spoofing lock only when enabled and a recent token exists, keeping bit1", async () => {
    const updateBits = vi.fn(async () => "ok" as const);
    const queryBits = vi.fn(async () => ({ bit0: false, bit1: true, lastUpdateTime: null }));
    const deviceCheck = { queryBits, updateBits };
    const disabled = new DeviceEnvironmentService(fakeStore().store, CONFIG, { deviceCheck, now: () => NOW });
    await expect(disabled.markSpoofingLock(ACCOUNT)).resolves.toBe("skipped");

    const { store } = fakeStore();
    const enabled = new DeviceEnvironmentService(store, { ...CONFIG, TRUST_DEVICECHECK_BIT_SET_ENABLED: true }, { deviceCheck, now: () => NOW });
    await expect(enabled.markSpoofingLock(ACCOUNT)).resolves.toBe("skipped");
    await enabled.record({ accountId: ACCOUNT, attestationId: null, platform: "ios", environment: CLEAN, deviceCheckToken: "dG9rZW4=" });
    await expect(enabled.markSpoofingLock(ACCOUNT)).resolves.toBe("set");
    expect(updateBits).toHaveBeenCalledWith("dG9rZW4=", { bit0: true, bit1: true });
    expect(updateBits).toHaveBeenCalledTimes(1);
  });

  it("admin Lock and red-zone auto-lock notify the spoofing-lock hook; other decisions do not", async () => {
    const onSpoofingLock = vi.fn(async () => undefined);
    const store = {
      decideAlert: vi.fn(async (_id: string, action: string) => ({
        outcome: "ok" as const,
        alert: {} as never,
        suspendedAccountIds: action === "lock" ? [ACCOUNT] : []
      })),
      lockNewAccountForRedZone: vi.fn(async () => ({ alertId: "alert-1", accountAgeHours: 2 }))
    };
    const ops = new TrustAdminOps({ store: store as never, settlement: {} as never, anchors: {} as never, onSpoofingLock, now: () => NOW });
    await ops.decideAlert("alert-1", "dismiss", "admin");
    expect(onSpoofingLock).not.toHaveBeenCalled();
    await ops.decideAlert("alert-1", "lock", "admin");
    expect(onSpoofingLock).toHaveBeenCalledWith(ACCOUNT);
    await ops.lockNewAccountForRedZone({ accountId: "acct-2", lat: 1, lon: 2, now: NOW, maxAgeDays: 7, details: {} });
    expect(onSpoofingLock).toHaveBeenLastCalledWith("acct-2");
  });
});

describe("Play Integrity virtual integrity (Google emulator)", () => {
  it("flags MEETS_VIRTUAL_INTEGRITY without device integrity as pi_virtual_integrity", async () => {
    const { evaluateEnvironmentSignals } = await import("./deviceEnvironment.js");
    const base = { summary: null, gpsCountries: new Set<string>(), deviceCheckBit0: null, installAccounts: 0, installThreshold: 2 };
    expect(evaluateEnvironmentSignals({ ...base, playIntegrity: { deviceRecognitionVerdict: ["MEETS_VIRTUAL_INTEGRITY"] } })
      .map((signal) => signal.rule)).toEqual(["pi_virtual_integrity"]);
    expect(evaluateEnvironmentSignals({
      ...base,
      playIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY", "MEETS_VIRTUAL_INTEGRITY"] }
    })).toEqual([]);
  });
});
