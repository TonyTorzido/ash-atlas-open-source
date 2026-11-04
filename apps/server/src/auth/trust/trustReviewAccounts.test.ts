import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../config.js";
import { RELOCATION_RED_REFUSED_MESSAGE, RelocationGate } from "./relocationGate.js";
import { SettlementService, type PostgresSettlementStore, type SettlementConfig } from "./settlement.js";
import { isTrustReviewAccount } from "./trustReviewAccounts.js";
import { TrustService, type TrustScoreConfig } from "./trustService.js";

// Store-review exemption (TRUST_REVIEW_ACCOUNT_IDS): reviewer accounts are let
// through; every other account keeps the normal enforcement.

const REVIEWER = "00000000-0000-4000-8000-0000000000a1";
const PLAYER = "00000000-0000-4000-8000-0000000000a2";
const NOW = new Date("2026-10-03T12:00:00Z");

describe("TRUST_REVIEW_ACCOUNT_IDS", () => {
  it("defaults to empty and parses a comma list case-insensitively", () => {
    expect(loadConfig({ NODE_ENV: "development" }).TRUST_REVIEW_ACCOUNT_IDS).toEqual([]);
    const config = loadConfig({ NODE_ENV: "development", TRUST_REVIEW_ACCOUNT_IDS: ` ${REVIEWER.toUpperCase()} ,` });
    expect(config.TRUST_REVIEW_ACCOUNT_IDS).toEqual([REVIEWER]);
    expect(isTrustReviewAccount(config, REVIEWER)).toBe(true);
    expect(isTrustReviewAccount(config, PLAYER)).toBe(false);
    expect(isTrustReviewAccount(config, null)).toBe(false);
    expect(() => loadConfig({ NODE_ENV: "development", TRUST_REVIEW_ACCOUNT_IDS: "not-a-uuid" })).toThrow();
  });
});

describe("store-review exemption", () => {
  function redGate() {
    const alerts = {
      fileRedAlert: vi.fn(async () => ({ created: true, alertId: "alert-red", severity: 3 })),
      fileZoneAlert: vi.fn(async () => ({ created: true })),
      consumeRedAllowance: vi.fn(async () => null),
      restoreRedAllowance: vi.fn(async () => undefined)
    };
    const redZoneLock = {
      lockNewAccountForRedZone: vi.fn(async () => ({ alertId: "alert-lock", accountAgeHours: 2, closeConnections: async () => undefined }))
    };
    const gate = new RelocationGate({
      config: {
        TRUST_ALERT_ZONE_MODE: "enforce",
        TRUST_RELOCATION_NATIVE_ONLY_MODE: "shadow",
        TRUST_KINGDOM_ALERT_RADIUS_KM: 10,
        TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS: 7,
        TRUST_REVIEW_ACCOUNT_IDS: [REVIEWER]
      },
      classify: () => "red",
      yellowOwners: async () => [],
      alerts,
      redZoneLock,
      now: () => NOW
    });
    return { gate, alerts, redZoneLock };
  }

  it("lets a reviewer relocate into a red zone (no lock, no refusal) and still locks a brand-new player", async () => {
    const reviewer = redGate();
    const allowed = await reviewer.gate.checkDestination({ accountId: REVIEWER, lat: 1, lon: 2 });
    expect(allowed.allowed).toBe(true);
    expect(reviewer.redZoneLock.lockNewAccountForRedZone).not.toHaveBeenCalled();
    if (allowed.allowed) await allowed.committed();
    // Logged for review like shadow mode.
    expect(reviewer.alerts.fileRedAlert).toHaveBeenCalledTimes(1);

    const player = redGate();
    const refused = await player.gate.checkDestination({ accountId: PLAYER, lat: 1, lon: 2 });
    expect(refused).toMatchObject({ allowed: false, message: RELOCATION_RED_REFUSED_MESSAGE });
    expect(player.redZoneLock.lockNewAccountForRedZone).toHaveBeenCalledTimes(1);
  });

  it("treats a reviewer as Settled and never revokes; a player's revocation still runs", async () => {
    const store = {
      isSettled: vi.fn(async () => false),
      revoke: vi.fn(async () => ({ wasSettled: true, playerIds: [] }))
    };
    const config = {
      TRUST_SETTLE_CHECKS_MIN: 22,
      TRUST_SETTLE_CHECKS_MAX: 30,
      TRUST_SETTLE_DAYS_MIN: 4,
      TRUST_SETTLE_DAYS_MAX: 6,
      TRUST_REVIEW_ACCOUNT_IDS: [REVIEWER]
    } as unknown as SettlementConfig;
    const settlement = new SettlementService(store as unknown as PostgresSettlementStore, config, { now: () => NOW });
    await expect(settlement.isSettled(REVIEWER)).resolves.toBe(true);
    await expect(settlement.isSettled(PLAYER)).resolves.toBe(false);
    await settlement.revoke(REVIEWER, "location_mock");
    expect(store.revoke).not.toHaveBeenCalled();
    await settlement.revoke(PLAYER, "location_mock");
    expect(store.revoke).toHaveBeenCalledWith(PLAYER, "location_mock", NOW, expect.anything());
  });

  it("records a reviewer's mock/attestation signals at weight 0 and a player's at full weight", async () => {
    const applySignals = vi.fn(async () => undefined);
    const config = {
      TRUST_QUARANTINE_MODE: "enforce",
      TRUST_DECAY_TAU_DAYS: 7,
      TRUST_FAMILIAR_REGION_DAYS: 10,
      TRUST_FAMILIAR_REGION_STALE_DAYS: 90,
      TRUST_QUARANTINE_THRESHOLD: 8,
      TRUST_QUARANTINE_THRESHOLD_NEW: 6,
      TRUST_WARNING_THRESHOLD: 15,
      TRUST_REVIEW_ACCOUNT_IDS: [REVIEWER]
    } as unknown as TrustScoreConfig;
    const trust = new TrustService({ applySignals } as never, config, { now: () => NOW });
    const signals = [{ rule: "location_mock", weight: 3 }, { rule: "attest_device_fail", weight: 2 }];
    await trust.recordSignals({ accountId: REVIEWER, signals });
    await trust.recordSignals({ accountId: PLAYER, signals });
    const calls = applySignals.mock.calls as unknown as Array<[{ signals: Array<{ weight: number; metadata: Record<string, unknown> }> }]>;
    expect(calls[0]![0].signals.map((signal) => signal.weight)).toEqual([0, 0]);
    expect(calls[0]![0].signals[0]!.metadata).toMatchObject({ reviewAccount: true, originalWeight: 3 });
    expect(calls[1]![0].signals.map((signal) => signal.weight)).toEqual([3, 2]);
  });
});
