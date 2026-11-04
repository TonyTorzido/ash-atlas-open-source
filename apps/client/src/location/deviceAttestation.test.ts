import { buildAttestClientData, type TrustAttestationSessionConfig } from "@ash-atlas/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native/nativeApp.js", () => ({
  subscribeNativeAppStateChange: () => () => undefined,
  readNativeAppInfo: async () => null
}));

import {
  APP_ATTEST_KEY_REGEN_MIN_MS,
  APP_ATTEST_KEY_STORAGE,
  ATTEST_BACKOFF_BASE_MS,
  ATTEST_RATE_LIMIT_BACKOFF_MS,
  ATTEST_WARMUP_DELAY_MS,
  AttestHttpError,
  AttestationManager,
  RELOCATION_ATTEST_BUDGET_MS,
  attestationPlan,
  type AttestationApi
} from "./deviceAttestation.js";
import type { DeviceTrustBridge, DeviceTrustCapabilities, DeviceTrustPlugin } from "../native/nativeDeviceTrust.js";

const ANDROID_CONFIG: TrustAttestationSessionConfig = {
  mode: "shadow",
  android: { cloudProjectNumber: "123456" },
  refreshSeconds: 1500
};
const IOS_CONFIG: TrustAttestationSessionConfig = {
  mode: "shadow",
  ios: { appAttest: true, deviceCheck: true },
  refreshSeconds: 1500
};
const FIX = { lat: 40.123456789, lon: -105.5, accuracy: 12.34, fixTimestampMs: 1_790_000_000_000 };

function caps(overrides: Partial<DeviceTrustCapabilities>): DeviceTrustCapabilities {
  return { v: 1, platform: "android", location: true, playIntegrity: true, appAttest: false, deviceCheck: false, ...overrides };
}

function result(ref: string, refreshAfterSeconds = 1500) {
  return {
    attestationRef: ref,
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
    refreshAfterSeconds
  };
}

function harness(options: { bridge?: DeviceTrustBridge | null; storage?: Map<string, string> } = {}) {
  const storage = options.storage ?? new Map<string, string>();
  let challengeCount = 0;
  const api = {
    challenge: vi.fn<AttestationApi["challenge"]>(async () => {
      challengeCount += 1;
      return { challengeId: `00000000-0000-4000-8000-00000000000${challengeCount % 10}`, challenge: `chal${challengeCount}`, expiresAt: "" };
    }),
    android: vi.fn<AttestationApi["android"]>(async () => result(`android-ref-${challengeCount}-padding`)),
    iosKey: vi.fn<AttestationApi["iosKey"]>(async () => result("ios-key-ref-0000000000")),
    iosAssert: vi.fn<AttestationApi["iosAssert"]>(async () => result(`ios-assert-ref-${challengeCount}-0000`)),
    iosDeviceCheck: vi.fn<AttestationApi["iosDeviceCheck"]>(async () => result("devicecheck-ref-0000000"))
  };
  let foregroundHandler: ((foreground: boolean) => void) | null = null;
  let foreground = true;
  const manager = new AttestationManager({
    detect: async () => options.bridge ?? null,
    shellBuild: async () => 77,
    storage: {
      get: (key) => storage.get(key) ?? null,
      set: (key, value) => {
        if (value === null) storage.delete(key);
        else storage.set(key, value);
      }
    },
    isForeground: () => foreground,
    subscribeForeground: (handler) => {
      foregroundHandler = handler;
      return () => {
        foregroundHandler = null;
      };
    },
    now: () => Date.now(),
    random: () => 0,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle)
  });
  return {
    api,
    manager,
    storage,
    setForeground(next: boolean) {
      foreground = next;
      foregroundHandler?.(next);
    }
  };
}

function plugin(overrides: Partial<DeviceTrustPlugin> = {}): DeviceTrustPlugin {
  return {
    getCapabilities: vi.fn(),
    getCurrentFix: vi.fn(),
    prepareIntegrity: vi.fn(async () => undefined),
    requestIntegrityToken: vi.fn(async () => ({ token: "integrity.token" })),
    generateKey: vi.fn(async () => ({ keyId: "a2V5SWQ=" })),
    attestKey: vi.fn(async () => ({ attestationObject: "b2JqZWN0" })),
    generateAssertion: vi.fn(async () => ({ assertion: "YXNzZXJ0aW9u" })),
    deviceCheckToken: vi.fn(async () => ({ token: "ZGV2aWNl" })),
    getEnvironment: vi.fn(async () => ({ v: 1, installId: "install-0001" })),
    ...overrides
  };
}

describe("attestationPlan", () => {
  it("is null for web/legacy shells and picks the platform method from config + capabilities", () => {
    expect(attestationPlan(ANDROID_CONFIG, null)).toBeNull();
    expect(attestationPlan(ANDROID_CONFIG, { plugin: plugin(), capabilities: caps({}) }))
      .toEqual({ kind: "play_integrity", cloudProjectNumber: "123456" });
    expect(attestationPlan(ANDROID_CONFIG, { plugin: plugin(), capabilities: caps({ playIntegrity: false }) })).toBeNull();
    expect(attestationPlan(IOS_CONFIG, { plugin: plugin(), capabilities: caps({ platform: "ios", appAttest: true, deviceCheck: true }) }))
      .toEqual({ kind: "app_attest", deviceCheckFallback: true });
    expect(attestationPlan(IOS_CONFIG, { plugin: plugin(), capabilities: caps({ platform: "ios", appAttest: false, deviceCheck: true }) }))
      .toEqual({ kind: "device_check" });
  });
});

describe("AttestationManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays idle on a legacy shell (no plugin): no requests, no reference, relocation resolves undefined", async () => {
    const { api, manager } = harness({ bridge: null });
    manager.start(ANDROID_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.challenge).not.toHaveBeenCalled();
    expect(manager.currentRef()).toBeUndefined();
    await expect(manager.attestRelocation(FIX)).resolves.toBeUndefined();
    expect(manager.state().plan).toBeNull();
  });

  it("warms up Play Integrity, attests the session, and refreshes on the server's schedule while foreground", async () => {
    const native = plugin();
    const { api, manager, setForeground } = harness({ bridge: { plugin: native, capabilities: caps({}) } });
    manager.start(ANDROID_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    expect(native.prepareIntegrity).toHaveBeenCalledWith({ cloudProjectNumber: "123456" });
    expect(native.requestIntegrityToken).toHaveBeenCalledWith({ clientData: buildAttestClientData("session", "chal1") });
    expect(api.android).toHaveBeenCalledWith(expect.objectContaining({ purpose: "session", shellBuild: 77, token: "integrity.token" }));
    expect(api.android.mock.calls[0]![0]).not.toHaveProperty("fix");
    expect(manager.currentRef()).toBe("android-ref-1-padding");

    // Hidden: the refresh does not run in the background.
    setForeground(false);
    await vi.advanceTimersByTimeAsync(1500_000);
    expect(api.android).toHaveBeenCalledTimes(1);
    // Back in the foreground past the refresh time: refresh at once.
    setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.android).toHaveBeenCalledTimes(2);
    expect(native.prepareIntegrity).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("backs off exponentially on failures, at least 10 min on 429, and stops on 404", async () => {
    const { api, manager } = harness({ bridge: { plugin: plugin(), capabilities: caps({}) } });
    api.challenge.mockRejectedValue(new AttestHttpError(503, "ATTEST_UNAVAILABLE"));
    manager.start(ANDROID_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    expect(manager.state().failures).toBe(1);
    expect(manager.state().nextAttemptAtMs - Date.now()).toBe(ATTEST_BACKOFF_BASE_MS);
    await vi.advanceTimersByTimeAsync(ATTEST_BACKOFF_BASE_MS);
    expect(manager.state().failures).toBe(2);
    expect(manager.state().nextAttemptAtMs - Date.now()).toBe(ATTEST_BACKOFF_BASE_MS * 2);
    api.challenge.mockRejectedValueOnce(new AttestHttpError(429, "ATTEST_RATE_LIMITED"));
    await vi.advanceTimersByTimeAsync(ATTEST_BACKOFF_BASE_MS * 2);
    expect(manager.state().failures).toBe(3);
    expect(manager.state().nextAttemptAtMs - Date.now()).toBe(ATTEST_RATE_LIMIT_BACKOFF_MS);
    api.challenge.mockRejectedValueOnce(new AttestHttpError(404, "NOT_FOUND"));
    await vi.advanceTimersByTimeAsync(ATTEST_RATE_LIMIT_BACKOFF_MS);
    expect(manager.state().disabled).toBe(true);
    const calls = api.challenge.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(api.challenge).toHaveBeenCalledTimes(calls);
    await expect(manager.attestRelocation(FIX)).resolves.toBeUndefined();
    // A new start (reconnect) tries again.
    api.challenge.mockResolvedValue({ challengeId: "00000000-0000-4000-8000-000000000001", challenge: "c", expiresAt: "" });
    manager.start(ANDROID_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_RATE_LIMIT_BACKOFF_MS);
    expect(manager.state().disabled).toBe(false);
    expect(manager.currentRef()).toBeDefined();
    manager.stop();
  });

  it("sends the environment block with each attestation request when the shell has it, never otherwise", async () => {
    const environment = { v: 1 as const, installId: "8a1f0c2e-1111-4222-8333-444455556666", installSource: "store" as const, vpnActive: false };
    const native = plugin({ getEnvironment: vi.fn(async () => environment) });
    const { api, manager } = harness({ bridge: { plugin: native, capabilities: caps({ environment: true }) } });
    manager.start(ANDROID_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    expect(api.android).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: "session", environment }));
    await manager.attestRelocation(FIX);
    expect(api.android).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: "relocation", environment }));
    expect(native.getEnvironment).toHaveBeenCalledTimes(2);
    manager.stop();

    // Out-of-bounds answers are dropped, and shells without the capability are never asked.
    const bad = plugin({ getEnvironment: vi.fn(async () => ({ v: 1, installId: "x" }) as never) });
    const second = harness({ bridge: { plugin: bad, capabilities: caps({ environment: true }) } });
    second.manager.start(ANDROID_CONFIG, second.api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    expect(second.api.android.mock.calls[0]![0]).not.toHaveProperty("environment");
    second.manager.stop();
    const legacy = plugin();
    const third = harness({ bridge: { plugin: legacy, capabilities: caps({}) } });
    third.manager.start(ANDROID_CONFIG, third.api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    expect(legacy.getEnvironment).not.toHaveBeenCalled();
    expect(third.api.android.mock.calls[0]![0]).not.toHaveProperty("environment");
    third.manager.stop();
  });

  it("forwards a native token failure as clientError and backs off", async () => {
    const native = plugin({
      requestIntegrityToken: vi.fn(async () => {
        throw Object.assign(new Error("play"), { code: "INTEGRITY_-12" });
      })
    });
    const { api, manager } = harness({ bridge: { plugin: native, capabilities: caps({}) } });
    manager.start(ANDROID_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    expect(api.android).toHaveBeenCalledWith(expect.objectContaining({ clientError: "INTEGRITY_-12" }));
    expect(api.android.mock.calls[0]![0]).not.toHaveProperty("token");
    expect(manager.state().failures).toBe(1);
    manager.stop();
  });

  it("binds the relocation fix and gives up after the 6 s budget", async () => {
    const native = plugin();
    const { api, manager } = harness({ bridge: { plugin: native, capabilities: caps({}) } });
    manager.start(ANDROID_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    const ref = await manager.attestRelocation(FIX);
    expect(ref).toBe("android-ref-2-padding");
    expect(native.requestIntegrityToken).toHaveBeenLastCalledWith({ clientData: buildAttestClientData("relocation", "chal2", FIX) });
    expect(api.android).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: "relocation", fix: FIX }));
    // A relocation reference is fix-bound: the session reference is unchanged.
    expect(manager.currentRef()).toBe("android-ref-1-padding");

    api.android.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = manager.attestRelocation(FIX);
    await vi.advanceTimersByTimeAsync(RELOCATION_ATTEST_BUDGET_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeUndefined();
    manager.stop();
  });

  it("iOS: generates and registers an App Attest key once, then asserts; a key the server lost is regenerated at most once a day", async () => {
    const native = plugin();
    const bridge = { plugin: native, capabilities: caps({ platform: "ios", playIntegrity: false, appAttest: true, deviceCheck: true }) };
    const { api, manager, storage } = harness({ bridge });
    manager.start(IOS_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    expect(native.generateKey).toHaveBeenCalledTimes(1);
    expect(api.challenge).toHaveBeenCalledWith({ platform: "ios", purpose: "ios_key" });
    expect(native.attestKey).toHaveBeenCalledWith({ keyId: "a2V5SWQ=", clientData: buildAttestClientData("ios_key", "chal1") });
    // DeviceCheck is enabled too: the key request carries a token for the two-bit check.
    expect(api.iosKey).toHaveBeenCalledWith({
      challengeId: expect.any(String), keyId: "a2V5SWQ=", attestationObject: "b2JqZWN0", deviceCheckToken: "ZGV2aWNl"
    });
    expect(manager.currentRef()).toBe("ios-key-ref-0000000000");
    expect(JSON.parse(storage.get(APP_ATTEST_KEY_STORAGE)!)).toMatchObject({ keyId: "a2V5SWQ=", registered: true });

    // Relocation asserts with the registered key and the bound fix.
    await expect(manager.attestRelocation(FIX)).resolves.toBe("ios-assert-ref-2-0000");
    expect(native.generateAssertion).toHaveBeenCalledWith({ keyId: "a2V5SWQ=", clientData: buildAttestClientData("relocation", "chal2", FIX) });
    expect(api.iosAssert).toHaveBeenCalledWith(expect.objectContaining({ purpose: "relocation", fix: FIX, shellBuild: 77 }));

    // The server no longer knows the key: forget it; no regeneration inside 24 h.
    api.iosAssert.mockRejectedValueOnce(new AttestHttpError(409, "ATTEST_KEY_UNKNOWN"));
    await expect(manager.attestRelocation(FIX)).resolves.toBeUndefined();
    expect(JSON.parse(storage.get(APP_ATTEST_KEY_STORAGE)!)).not.toHaveProperty("keyId");
    await expect(manager.attestRelocation(FIX)).resolves.toBeUndefined();
    expect(native.generateKey).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + APP_ATTEST_KEY_REGEN_MIN_MS);
    await expect(manager.attestRelocation(FIX)).resolves.toBe("ios-assert-ref-5-0000");
    expect(native.generateKey).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("iOS: a registered key survives restarts; ATTEST_KEY_EXISTS counts as registered", async () => {
    const storage = new Map([[APP_ATTEST_KEY_STORAGE, JSON.stringify({ keyId: "b2xk", registered: false, generatedAtMs: 1 })]]);
    const native = plugin();
    const bridge = { plugin: native, capabilities: caps({ platform: "ios", playIntegrity: false, appAttest: true }) };
    const { api, manager } = harness({ bridge, storage });
    api.iosKey.mockRejectedValueOnce(new AttestHttpError(409, "ATTEST_KEY_EXISTS"));
    manager.start(IOS_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    expect(native.generateKey).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get(APP_ATTEST_KEY_STORAGE)!)).toMatchObject({ keyId: "b2xk", registered: true });
    expect(manager.state().failures).toBe(0);
    expect(api.iosAssert).toHaveBeenCalledWith(expect.objectContaining({ keyId: "b2xk", purpose: "session" }));
    expect(manager.currentRef()).toBeDefined();
    manager.stop();
  });

  it("iOS: App Attest unsupported on the device falls back to DeviceCheck", async () => {
    const native = plugin({
      generateKey: vi.fn(async () => {
        throw Object.assign(new Error("no"), { code: "UNSUPPORTED" });
      })
    });
    const bridge = { plugin: native, capabilities: caps({ platform: "ios", playIntegrity: false, appAttest: true, deviceCheck: true }) };
    const { api, manager } = harness({ bridge });
    manager.start(IOS_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    expect(api.iosDeviceCheck).toHaveBeenCalledWith(expect.objectContaining({ purpose: "session", deviceToken: "ZGV2aWNl" }));
    expect(manager.state().plan).toEqual({ kind: "device_check" });
    // DeviceCheck cannot bind a fix: relocation reuses the session reference.
    await expect(manager.attestRelocation(FIX)).resolves.toBe("devicecheck-ref-0000000");
    expect(api.iosDeviceCheck).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("drops the cached reference when the session changes", async () => {
    const { api, manager } = harness({ bridge: { plugin: plugin(), capabilities: caps({}) } });
    manager.start(ANDROID_CONFIG, api, "s1");
    await vi.advanceTimersByTimeAsync(ATTEST_WARMUP_DELAY_MS);
    expect(manager.currentRef()).toBeDefined();
    manager.stop();
    manager.start(ANDROID_CONFIG, api, "s1");
    expect(manager.currentRef()).toBeDefined();
    manager.start(ANDROID_CONFIG, api, "s2");
    expect(manager.currentRef()).toBeUndefined();
    manager.stop();
  });
});
