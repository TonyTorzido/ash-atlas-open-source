import { describe, expect, it, vi } from "vitest";

import { AccountLinkMonitor, type AccountLinkConfig, type AccountLinkStore } from "./accountLinks.js";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const DEVICE = "11111111-1111-4111-8111-111111111111";
const DENVER = { lat: 39.74, lon: -104.99 };

function monitor(options: {
  linked?: number;
  installs?: number;
  otherFix?: { lat: number; lon: number; minutesAgo: number } | null;
  config?: Partial<AccountLinkConfig>;
} = {}) {
  const store: AccountLinkStore = {
    linkedAccounts: vi.fn(async () => Array.from({ length: options.linked ?? 0 }, (_, index) => ({
      accountId: `other-${index}`,
      via: ["install" as const],
      lastSeenAt: NOW
    }))),
    nativeInstallCount: vi.fn(async () => options.installs ?? 1),
    latestFixFromOtherDevice: vi.fn(async () => options.otherFix
      ? {
          lat: options.otherFix.lat,
          lon: options.otherFix.lon,
          at: new Date(NOW.getTime() - options.otherFix.minutesAgo * 60_000),
          deviceInstallationId: "22222222-2222-4222-8222-222222222222"
        }
      : null)
  };
  const sink = { recordSignals: vi.fn(async () => undefined) };
  const alerts = { fileZoneAlert: vi.fn(async () => ({ created: true })) };
  const instance = new AccountLinkMonitor(store, {
    TRUST_ENVIRONMENT_SIGNALS_MODE: "enforce",
    TRUST_ENVIRONMENT_SIGNAL_WEIGHTS: { install_multi_account: 3 },
    TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD: 2,
    TRUST_ATTEST_RETENTION_DAYS: 90,
    ...options.config
  }, { sink, alerts, now: () => NOW });
  return { instance, store, sink, alerts };
}

const rules = (sink: { recordSignals: ReturnType<typeof vi.fn> }) =>
  sink.recordSignals.mock.calls.flatMap(([input]) => (input as { signals: Array<{ rule: string; weight: number }> }).signals);

describe("multi-accounting (owner decision C)", () => {
  it("flags a second account on the same install with a weighted signal and an alert", async () => {
    const { instance, sink, alerts } = monitor({ linked: 1 });
    await instance.onFix({ accountId: "a", deviceInstallationId: DEVICE, ...DENVER, at: NOW });
    expect(rules(sink)).toContainEqual(expect.objectContaining({ rule: "install_multi_account", weight: 3 }));
    expect(alerts.fileZoneAlert).toHaveBeenCalledWith(expect.objectContaining({
      kind: "multi_account",
      dedupe: "account",
      details: { linkedAccounts: [{ accountId: "other-0", via: ["install"] }] }
    }));
  });

  it("stays quiet for a lone account, and the signal weighs 0 while environment signals are shadow", async () => {
    const lone = monitor({ linked: 0 });
    await lone.instance.onFix({ accountId: "a", deviceInstallationId: DEVICE, ...DENVER, at: NOW });
    expect(rules(lone.sink)).toEqual([]);
    expect(lone.alerts.fileZoneAlert).not.toHaveBeenCalled();
    const shadow = monitor({ linked: 1, config: { TRUST_ENVIRONMENT_SIGNALS_MODE: "shadow" } });
    await shadow.instance.onFix({ accountId: "a", deviceInstallationId: DEVICE, ...DENVER, at: NOW });
    expect(rules(shadow.sink)).toContainEqual(expect.objectContaining({ rule: "install_multi_account", weight: 0 }));
    const off = monitor({ linked: 3, config: { TRUST_ENVIRONMENT_SIGNALS_MODE: "off" } });
    await off.instance.onFix({ accountId: "a", deviceInstallationId: DEVICE, ...DENVER, at: NOW });
    expect(off.store.linkedAccounts).not.toHaveBeenCalled();
  });
});

describe("account sharing (owner decision C)", () => {
  it("flags one account on two native installs, and another device far away at the same time", async () => {
    const devices = monitor({ installs: 2 });
    await devices.instance.onFix({ accountId: "a", deviceInstallationId: DEVICE, ...DENVER, at: NOW });
    expect(rules(devices.sink)).toContainEqual(expect.objectContaining({ rule: "account_shared", weight: 3 }));
    expect(devices.alerts.fileZoneAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: "account_shared" }));

    // Chicago 20 minutes ago from another device: about 4,000 km/h.
    const concurrent = monitor({ otherFix: { lat: 41.88, lon: -87.63, minutesAgo: 20 } });
    await concurrent.instance.onFix({ accountId: "a", deviceInstallationId: DEVICE, ...DENVER, at: NOW });
    expect(rules(concurrent.sink)).toContainEqual(expect.objectContaining({
      rule: "account_shared",
      metadata: expect.objectContaining({ reasons: [expect.objectContaining({ kind: "concurrent" })] })
    }));
  });

  it("does not flag one device, a nearby second device, or a plausible trip", async () => {
    const nearby = monitor({ otherFix: { lat: 39.75, lon: -104.98, minutesAgo: 1 } });
    await nearby.instance.onFix({ accountId: "a", deviceInstallationId: DEVICE, ...DENVER, at: NOW });
    expect(rules(nearby.sink)).toEqual([]);
    // Chicago 6 hours ago: a flight.
    const trip = monitor({ otherFix: { lat: 41.88, lon: -87.63, minutesAgo: 360 } });
    await trip.instance.onFix({ accountId: "a", deviceInstallationId: DEVICE, ...DENVER, at: NOW });
    expect(rules(trip.sink)).toEqual([]);
    expect(trip.alerts.fileZoneAlert).not.toHaveBeenCalled();
  });

  it("checks an account at most once every few minutes in this process", async () => {
    const { instance, store } = monitor();
    await instance.onFix({ accountId: "a", deviceInstallationId: DEVICE, ...DENVER, at: NOW });
    await instance.onFix({ accountId: "a", deviceInstallationId: DEVICE, ...DENVER, at: new Date(NOW.getTime() + 60_000) });
    expect(store.linkedAccounts).toHaveBeenCalledOnce();
    // A switch to another device still runs the sharing check at once.
    await instance.onFix({
      accountId: "a",
      deviceInstallationId: "33333333-3333-4333-8333-333333333333",
      ...DENVER,
      at: new Date(NOW.getTime() + 90_000)
    });
    expect(store.latestFixFromOtherDevice).toHaveBeenCalledTimes(2);
    expect(store.linkedAccounts).toHaveBeenCalledOnce();
  });
});
