import { describe, expect, it, vi } from "vitest";

import type { PopulationClass } from "./populationGrid.js";
import {
  ORANGE_ZONE_DIFFICULTY,
  RELOCATION_NATIVE_ONLY_MESSAGE,
  RELOCATION_RED_REFUSED_MESSAGE,
  RelocationGate,
  YELLOW_ZONE_DIFFICULTY,
  type RelocationGateConfig
} from "./relocationGate.js";
import { SETTLED_REVIEW_HOLD_MESSAGE } from "./settlement.js";
import { alertCellKey } from "./trustAlerts.js";

const NOW = new Date("2026-10-02T12:00:00Z");

function gate(options: {
  zone?: PopulationClass;
  owners?: string[];
  config?: Partial<RelocationGateConfig>;
  allowance?: { alertId: string; expiresAt: Date } | null;
  redCreated?: boolean;
  lock?: { alertId: string; accountAgeHours: number } | null | "throws";
  kingdoms?: string[];
  settled?: boolean;
} = {}) {
  const alerts = {
    fileRedAlert: vi.fn(async () => options.redCreated === false
      ? { created: false, alertId: null, severity: null }
      : { created: true, alertId: "alert-red", severity: 3 }),
    fileZoneAlert: vi.fn(async () => ({ created: true })),
    consumeRedAllowance: vi.fn(async () => options.allowance ?? null),
    restoreRedAllowance: vi.fn(async () => undefined)
  };
  const settlement = {
    raiseDifficulty: vi.fn(async () => true),
    isSettled: vi.fn(async () => options.settled === true),
    suspendForReview: vi.fn(async () => options.settled === true)
  };
  const sink = { recordSignals: vi.fn(async () => undefined) };
  const yellowOwners = vi.fn(async () => options.owners ?? []);
  const kingdomOwners = vi.fn(async () => options.kingdoms ?? []);
  const closeConnections = vi.fn(async () => undefined);
  const redZoneLock = {
    lockNewAccountForRedZone: vi.fn(async () => {
      if (options.lock === "throws") throw new Error("db down");
      return options.lock ? { ...options.lock, closeConnections } : null;
    })
  };
  const instance = new RelocationGate({
    config: {
      TRUST_ALERT_ZONE_MODE: "enforce",
      TRUST_RELOCATION_NATIVE_ONLY_MODE: "shadow",
      TRUST_KINGDOM_ALERT_RADIUS_KM: 10,
      TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS: 7,
      ...options.config
    },
    classify: () => options.zone ?? "urban",
    yellowOwners,
    kingdomOwners,
    alerts,
    redZoneLock,
    settlement,
    sink,
    now: () => NOW
  });
  return { instance, alerts, settlement, sink, yellowOwners, kingdomOwners, redZoneLock, closeConnections };
}

const TARGET = { accountId: "account-1", lat: -80.5, lon: 20.25 };

describe("phone-only relocation", () => {
  it("refuses web in enforce and lets native through", async () => {
    const { instance, sink } = gate({ config: { TRUST_RELOCATION_NATIVE_ONLY_MODE: "enforce" } });
    await expect(instance.checkPlatform({ accountId: "a", clientPlatform: "web" }))
      .resolves.toBe(RELOCATION_NATIVE_ONLY_MESSAGE);
    await expect(instance.checkPlatform({ accountId: "a", clientPlatform: "android" })).resolves.toBeNull();
    await expect(instance.checkPlatform({ accountId: "a", clientPlatform: "ios" })).resolves.toBeNull();
    expect(sink.recordSignals).not.toHaveBeenCalled();
  });

  it("records a 0-weight signal for web in shadow and allows; off does nothing", async () => {
    const shadow = gate();
    await expect(shadow.instance.checkPlatform({ accountId: "a", clientPlatform: "web" })).resolves.toBeNull();
    expect(shadow.sink.recordSignals).toHaveBeenCalledWith({
      accountId: "a",
      signals: [expect.objectContaining({ rule: "relocation_web", weight: 0 })]
    });
    const off = gate({ config: { TRUST_RELOCATION_NATIVE_ONLY_MODE: "off" } });
    await expect(off.instance.checkPlatform({ accountId: "a", clientPlatform: "web" })).resolves.toBeNull();
    expect(off.sink.recordSignals).not.toHaveBeenCalled();
  });
});

describe("alert zones on relocation", () => {
  it("refuses red in enforce for an account that is not brand-new, with a pending alert", async () => {
    const { instance, alerts, sink, redZoneLock } = gate({ zone: "red" });
    const decision = await instance.checkDestination(TARGET);
    expect(decision).toEqual({ allowed: false, message: RELOCATION_RED_REFUSED_MESSAGE });
    expect(RELOCATION_RED_REFUSED_MESSAGE).toBe("You can't relocate here.");
    expect(redZoneLock.lockNewAccountForRedZone).toHaveBeenCalledWith({
      accountId: "account-1", lat: -80.5, lon: 20.25, now: NOW, maxAgeDays: 7,
      details: { mode: "enforce", populationClass: "red" }
    });
    expect(alerts.consumeRedAllowance).toHaveBeenCalledWith("account-1", alertCellKey(-80.5, 20.25), NOW);
    expect(alerts.fileRedAlert).toHaveBeenCalledWith(expect.objectContaining({ accountId: "account-1", lat: -80.5, lon: 20.25 }));
    expect(sink.recordSignals).toHaveBeenCalledWith({
      accountId: "account-1",
      signals: [expect.objectContaining({ rule: "relocation_red_zone", weight: 3 })]
    });
  });

  it("locks a brand-new account on red: no pending alert, relocation_red_zone +3, connections closed after", async () => {
    const { instance, alerts, sink, closeConnections } = gate({
      zone: "red", lock: { alertId: "alert-locked", accountAgeHours: 30 }
    });
    const decision = await instance.checkDestination(TARGET);
    if (decision.allowed) throw new Error("expected refusal");
    expect(decision.message).toBe(RELOCATION_RED_REFUSED_MESSAGE);
    expect(alerts.fileRedAlert).not.toHaveBeenCalled();
    expect(sink.recordSignals).toHaveBeenCalledWith({
      accountId: "account-1",
      signals: [expect.objectContaining({
        rule: "relocation_red_zone",
        weight: 3,
        metadata: expect.objectContaining({ dedupeKey: "relocation_red_zone:alert-locked", autoLocked: true })
      })]
    });
    expect(closeConnections).not.toHaveBeenCalled();
    await decision.afterRefusal?.();
    expect(closeConnections).toHaveBeenCalledOnce();
  });

  it("falls back to the pending-alert refusal when the lock fails or is disabled", async () => {
    const failing = gate({ zone: "red", lock: "throws" });
    await expect(failing.instance.checkDestination(TARGET))
      .resolves.toEqual({ allowed: false, message: RELOCATION_RED_REFUSED_MESSAGE });
    expect(failing.alerts.fileRedAlert).toHaveBeenCalledOnce();

    const disabled = gate({
      zone: "red",
      lock: { alertId: "x", accountAgeHours: 1 },
      config: { TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS: 0 }
    });
    await expect(disabled.instance.checkDestination(TARGET))
      .resolves.toEqual({ allowed: false, message: RELOCATION_RED_REFUSED_MESSAGE });
    expect(disabled.redZoneLock.lockNewAccountForRedZone).not.toHaveBeenCalled();
  });

  it("never locks in shadow or on an admin allowance", async () => {
    const shadow = gate({ zone: "red", lock: { alertId: "x", accountAgeHours: 1 }, config: { TRUST_ALERT_ZONE_MODE: "shadow" } });
    const shadowDecision = await shadow.instance.checkDestination(TARGET);
    expect(shadowDecision.allowed).toBe(true);
    const allowance = { alertId: "alert-approved", expiresAt: new Date(NOW.getTime() + 60_000) };
    const allowed = gate({ zone: "red", lock: { alertId: "x", accountAgeHours: 1 }, allowance });
    expect((await allowed.instance.checkDestination(TARGET)).allowed).toBe(true);
    expect(shadow.redZoneLock.lockNewAccountForRedZone).not.toHaveBeenCalled();
    expect(allowed.redZoneLock.lockNewAccountForRedZone).not.toHaveBeenCalled();
  });

  it("refuses a repeat red without a new alert and signals relocation_red_repeat", async () => {
    const { instance, sink } = gate({ zone: "red", redCreated: false });
    const decision = await instance.checkDestination(TARGET);
    expect(decision.allowed).toBe(false);
    expect(sink.recordSignals).toHaveBeenCalledWith({
      accountId: "account-1",
      signals: [expect.objectContaining({
        rule: "relocation_red_repeat",
        weight: 1,
        metadata: expect.objectContaining({ dedupeKey: "relocation_red_repeat:account-1:2026-10-02" })
      })]
    });
  });

  it("lets red through in shadow, filing the alert and relocation_red_zone after commit", async () => {
    const { instance, alerts, sink } = gate({ zone: "red", config: { TRUST_ALERT_ZONE_MODE: "shadow" } });
    const decision = await instance.checkDestination(TARGET);
    expect(decision.allowed).toBe(true);
    expect(alerts.fileRedAlert).not.toHaveBeenCalled();
    if (!decision.allowed) throw new Error("expected allowed");
    await decision.committed();
    expect(alerts.fileRedAlert).toHaveBeenCalledOnce();
    expect(sink.recordSignals).toHaveBeenCalledWith({
      accountId: "account-1",
      signals: [expect.objectContaining({ rule: "relocation_red_zone", weight: 3 })]
    });
  });

  it("passes red once on an admin allowance and gives it back when travel fails", async () => {
    const allowance = { alertId: "alert-approved", expiresAt: new Date(NOW.getTime() + 60_000) };
    const { instance, alerts } = gate({ zone: "red", allowance });
    const decision = await instance.checkDestination(TARGET);
    expect(decision.allowed).toBe(true);
    expect(alerts.fileRedAlert).not.toHaveBeenCalled();
    if (!decision.allowed) throw new Error("expected allowed");
    await decision.release();
    expect(alerts.restoreRedAllowance).toHaveBeenCalledWith(allowance);
  });

  it("orange alerts and raises difficulty to 2.0; yellow owners add an alert", async () => {
    const { instance, alerts, settlement } = gate({ zone: "orange", owners: ["owner-1", "owner-2"] });
    const decision = await instance.checkDestination(TARGET);
    if (!decision.allowed) throw new Error("expected allowed");
    await decision.committed();
    expect(alerts.fileZoneAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: "zone_orange" }));
    expect(alerts.fileZoneAlert).toHaveBeenCalledWith(expect.objectContaining({
      kind: "zone_yellow",
      details: expect.objectContaining({ owners: ["owner-1", "owner-2"] })
    }));
    expect(settlement.raiseDifficulty).toHaveBeenCalledWith("account-1", ORANGE_ZONE_DIFFICULTY);
  });

  it("yellow alerts in every cell class; difficulty 1.5 only outside urban cells (owner decision B)", async () => {
    const rural = gate({ zone: "rural", owners: ["owner-1"] });
    const ruralDecision = await rural.instance.checkDestination(TARGET);
    if (!ruralDecision.allowed) throw new Error("expected allowed");
    await ruralDecision.committed();
    expect(rural.yellowOwners).toHaveBeenCalledWith(-80.5, 20.25, 10, "account-1", 25);
    expect(rural.alerts.fileZoneAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: "zone_yellow" }));
    expect(rural.settlement.raiseDifficulty).toHaveBeenCalledWith("account-1", YELLOW_ZONE_DIFFICULTY);

    const urban = gate({ zone: "urban", owners: ["owner-1"] });
    const urbanDecision = await urban.instance.checkDestination(TARGET);
    if (!urbanDecision.allowed) throw new Error("expected allowed");
    await urbanDecision.committed();
    expect(urban.yellowOwners).toHaveBeenCalledOnce();
    expect(urban.alerts.fileZoneAlert).toHaveBeenCalledWith(expect.objectContaining({
      kind: "zone_yellow",
      details: expect.objectContaining({ populationClass: "urban", owners: ["owner-1"] })
    }));
    expect(urban.sink.recordSignals).toHaveBeenCalledWith({
      accountId: "account-1",
      signals: [expect.objectContaining({ rule: "territory_proximity", weight: 1 })]
    });
    expect(urban.settlement.raiseDifficulty).not.toHaveBeenCalled();
  });

  it("rural without nearby owners and mode off change nothing", async () => {
    const rural = gate({ zone: "rural" });
    const decision = await rural.instance.checkDestination(TARGET);
    if (!decision.allowed) throw new Error("expected allowed");
    await decision.committed();
    expect(rural.alerts.fileZoneAlert).not.toHaveBeenCalled();
    expect(rural.settlement.raiseDifficulty).not.toHaveBeenCalled();

    const off = gate({ zone: "red", config: { TRUST_ALERT_ZONE_MODE: "off" } });
    await expect(off.instance.checkDestination(TARGET)).resolves.toMatchObject({ allowed: true });
    expect(off.alerts.consumeRedAllowance).not.toHaveBeenCalled();
  });

  it("swallows after-commit failures", async () => {
    const { instance, alerts, settlement } = gate({ zone: "orange" });
    alerts.fileZoneAlert.mockRejectedValue(new Error("db down"));
    const decision = await instance.checkDestination(TARGET);
    if (!decision.allowed) throw new Error("expected allowed");
    await expect(decision.committed()).resolves.toBeUndefined();
    expect(settlement.raiseDifficulty).toHaveBeenCalledWith("account-1", ORANGE_ZONE_DIFFICULTY);
  });
});

describe("rejected fixes still run the red zone (owner decision A)", () => {
  it("locks a brand-new account and returns the red copy in enforce", async () => {
    const { instance, alerts, redZoneLock, closeConnections } = gate({
      zone: "red", lock: { alertId: "alert-locked", accountAgeHours: 3 }
    });
    const result = await instance.checkRefusedDestination(TARGET);
    expect(result.message).toBe(RELOCATION_RED_REFUSED_MESSAGE);
    expect(redZoneLock.lockNewAccountForRedZone).toHaveBeenCalledWith(expect.objectContaining({
      details: { mode: "enforce", populationClass: "red", refusedFix: true }
    }));
    expect(alerts.consumeRedAllowance).not.toHaveBeenCalled();
    await result.afterRefusal?.();
    expect(closeConnections).toHaveBeenCalledOnce();
  });

  it("files the red alert + relocation_red_zone for an older account (enforce and shadow)", async () => {
    for (const mode of ["enforce", "shadow"] as const) {
      const { instance, alerts, sink } = gate({ zone: "red", config: { TRUST_ALERT_ZONE_MODE: mode } });
      const result = await instance.checkRefusedDestination(TARGET);
      expect(result.message).toBe(mode === "enforce" ? RELOCATION_RED_REFUSED_MESSAGE : null);
      expect(result.afterRefusal).toBeUndefined();
      expect(alerts.fileRedAlert).toHaveBeenCalledWith(expect.objectContaining({
        details: { mode, populationClass: "red", refusedFix: true }
      }));
      expect(sink.recordSignals).toHaveBeenCalledWith({
        accountId: "account-1",
        signals: [expect.objectContaining({ rule: "relocation_red_zone", weight: 3 })]
      });
    }
  });

  it("does nothing outside red zones or with alert zones off", async () => {
    const urban = gate({ zone: "urban", lock: { alertId: "x", accountAgeHours: 1 } });
    await expect(urban.instance.checkRefusedDestination(TARGET)).resolves.toEqual({ message: null });
    expect(urban.alerts.fileRedAlert).not.toHaveBeenCalled();
    expect(urban.redZoneLock.lockNewAccountForRedZone).not.toHaveBeenCalled();
    const off = gate({ zone: "red", config: { TRUST_ALERT_ZONE_MODE: "off" } });
    await expect(off.instance.checkRefusedDestination(TARGET)).resolves.toEqual({ message: null });
    expect(off.alerts.fileRedAlert).not.toHaveBeenCalled();
  });
});

describe("kingdom proximity (owner decision B)", () => {
  it("files a severity-4 kingdom_proximity alert + signal near another kingdom, never refusing", async () => {
    const { instance, alerts, sink, kingdomOwners } = gate({ zone: "urban", kingdoms: ["king-1"] });
    const decision = await instance.checkDestination(TARGET);
    if (!decision.allowed) throw new Error("expected allowed");
    await decision.committed();
    expect(kingdomOwners).toHaveBeenCalledWith(-80.5, 20.25, 3, "account-1", 25);
    expect(alerts.fileZoneAlert).toHaveBeenCalledWith(expect.objectContaining({
      kind: "kingdom_proximity",
      details: expect.objectContaining({ owners: ["king-1"], radiusKm: 3 })
    }));
    expect(sink.recordSignals).toHaveBeenCalledWith({
      accountId: "account-1",
      signals: [expect.objectContaining({ rule: "kingdom_proximity", weight: 3 })]
    });
  });

  it("stays quiet with no kingdom nearby or the radius at 0", async () => {
    const none = gate({ zone: "urban" });
    const decision = await none.instance.checkDestination(TARGET);
    if (!decision.allowed) throw new Error("expected allowed");
    await decision.committed();
    expect(none.alerts.fileZoneAlert).not.toHaveBeenCalled();
    const disabled = gate({ zone: "urban", kingdoms: ["king-1"], config: { TRUST_KINGDOM_PROXIMITY_RED_KM: 0 } });
    const second = await disabled.instance.checkDestination(TARGET);
    if (!second.allowed) throw new Error("expected allowed");
    await second.committed();
    expect(disabled.kingdomOwners).not.toHaveBeenCalled();
    expect(disabled.alerts.fileZoneAlert).not.toHaveBeenCalled();
  });
});

describe("Settled review hold (owner decision E)", () => {
  it("refuses a Settled account's red relocation, pauses Settled and files a severity-4 alert", async () => {
    const { instance, alerts, settlement, sink } = gate({ zone: "red", settled: true });
    const decision = await instance.checkDestination(TARGET);
    expect(decision).toEqual({ allowed: false, message: SETTLED_REVIEW_HOLD_MESSAGE });
    expect(SETTLED_REVIEW_HOLD_MESSAGE).toBe("This location needs review. Your Settled status is paused until it's checked.");
    expect(alerts.fileRedAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 4,
      details: expect.objectContaining({ settledHold: true })
    }));
    expect(settlement.suspendForReview).toHaveBeenCalledWith("account-1", "alert-red");
    expect(sink.recordSignals).toHaveBeenCalledWith({
      accountId: "account-1",
      signals: [expect.objectContaining({ rule: "relocation_red_zone", weight: 3 })]
    });
    // Same hold when a rejected fix reaches the red zone.
    const rejected = gate({ zone: "red", settled: true });
    await expect(rejected.instance.checkRefusedDestination(TARGET)).resolves.toEqual({ message: SETTLED_REVIEW_HOLD_MESSAGE });
  });

  it("does not hold an unsettled account, a shadow-mode relocation or a non-red zone", async () => {
    const unsettled = gate({ zone: "red", settled: false });
    await expect(unsettled.instance.checkDestination(TARGET))
      .resolves.toEqual({ allowed: false, message: RELOCATION_RED_REFUSED_MESSAGE });
    expect(unsettled.settlement.suspendForReview).not.toHaveBeenCalled();
    const shadow = gate({ zone: "red", settled: true, config: { TRUST_ALERT_ZONE_MODE: "shadow" } });
    expect((await shadow.instance.checkDestination(TARGET)).allowed).toBe(true);
    expect(shadow.settlement.suspendForReview).not.toHaveBeenCalled();
    const orange = gate({ zone: "orange", settled: true });
    expect((await orange.instance.checkDestination(TARGET)).allowed).toBe(true);
    expect(orange.settlement.isSettled).not.toHaveBeenCalled();
  });
});
