import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { RELOCATION_RED_REFUSED_MESSAGE, RelocationGate } from "./relocationGate.js";
import { PostgresSettlementStore, SettlementService, type SettlementConfig } from "./settlement.js";
import { alertCellKey, PostgresTrustAlertStore } from "./trustAlerts.js";
import {
  PostgresTrustAdminOpsStore,
  SUSPENSION_REASON_RED_ZONE_NEW_ACCOUNT,
  TrustAdminOps
} from "./trustAdminOps.js";
import { PostgresTrustAdminStore } from "./trustStore.js";

const databaseUrl = testDatabaseUrl(process.env.DEVELOPER_AUTH_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60_000;
const NOW = new Date("2026-10-02T12:00:00.000Z");
const CONFIG: SettlementConfig = {
  TRUST_SETTLE_ASSURANCE_MODE: "shadow",
  TRUST_SETTLE_CHECKS_MIN: 22,
  TRUST_SETTLE_CHECKS_MAX: 22,
  TRUST_SETTLE_DAYS_MIN: 5,
  TRUST_SETTLE_DAYS_MAX: 5,
  TRUST_SETTLE_RADIUS_KM: 25,
  TRUST_SETTLE_MIN_GAP_SECONDS: 170,
  TRUST_SETTLE_MIN_DISTINCT_POSITIONS: 3,
  TRUST_SETTLE_ACCURACY_M: 5000,
  TRUST_DOORWAY_MIN_ACCOUNT_AGE_DAYS: 14
};
const RED = { lat: -80.534, lon: 20.274 };

describeDatabase("trust admin ops (PostgreSQL)", () => {
  let pool: pg.Pool;
  let store: PostgresTrustAdminOpsStore;
  let alertWriter: PostgresTrustAlertStore;
  let admin: string;
  const invites = { invalidateForInviter: vi.fn(async () => ["guest-invite"]) };
  const closeConnections = vi.fn(async () => undefined);
  const unanchored = { unanchoredRoutesReport: vi.fn(async () => []) };

  const account = async (status: "active" | "suspended" = "active") => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, status, trust_tier, created_at, suspended_at, suspension_reason)
       VALUES ($1, $2, 'standard', now() - interval '60 days',
               CASE WHEN $2 = 'suspended' THEN now() ELSE NULL END,
               CASE WHEN $2 = 'suspended' THEN 'test' ELSE NULL END)`,
      [id, status]
    );
    return id;
  };
  const player = async (accountId: string) => {
    const id = `p-${randomUUID()}`;
    await pool.query(
      `INSERT INTO players (id, account_id, username, username_normalized, display_color, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, geom)
       VALUES ($1, $2, $3, lower($3), '#3366cc', 'CO', 40, -105, 40, -105, 600, ST_SetSRID(ST_MakePoint(-105, 40), 4326))`,
      [id, accountId, `R${randomUUID().slice(0, 10)}`]
    );
    return id;
  };
  const session = async (accountId: string) => {
    const identityId = randomUUID();
    await pool.query(
      `INSERT INTO account_identities (id, account_id, provider, provider_subject, email, email_normalized, email_verified)
       VALUES ($1, $2, 'google', $3, $4, $4, true)`,
      [identityId, accountId, randomUUID(), `${randomUUID()}@example.test`]
    );
    await pool.query(
      `INSERT INTO auth_sessions (id, account_id, identity_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
      [randomUUID(), accountId, identityId, randomUUID()]
    );
  };
  const accountRow = async (accountId: string) => (await pool.query<{ status: string; suspension_reason: string | null }>(
    "SELECT status, suspension_reason FROM accounts WHERE id = $1", [accountId]
  )).rows[0]!;
  const activeSessions = async (accountId: string) => Number((await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM auth_sessions WHERE account_id = $1 AND revoked_at IS NULL", [accountId]
  )).rows[0]!.n);
  const notes = async (accountId: string) => (await pool.query<{ rule: string; metadata: Record<string, unknown> }>(
    "SELECT rule, metadata FROM account_trust_events WHERE account_id = $1 AND kind = 'note' ORDER BY created_at, id", [accountId]
  )).rows;
  const arrival = (host: string, guest: string, at: Date) => pool.query(
    `INSERT INTO trust_arrivals (id, host_account_id, guest_account_id, kind, lat_rounded, lon_rounded, created_at)
     VALUES ($1, $2, $3, 'invite', 12.34, 56.78, $4)`,
    [randomUUID(), host, guest, at]
  );
  const redAlert = async (accountId: string, at = NOW) => {
    const result = await alertWriter.fileRedAlert({ accountId, ...RED, now: at, details: {} });
    return result.alertId!;
  };
  const makeOps = (settlementService?: SettlementService) => new TrustAdminOps({
    store,
    settlement: settlementService ?? new SettlementService(new PostgresSettlementStore(pool), CONFIG, { now: () => NOW }),
    anchors: unanchored,
    closeConnections,
    now: () => NOW
  });

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 6 });
    store = new PostgresTrustAdminOpsStore(pool);
    alertWriter = new PostgresTrustAlertStore(pool);
    admin = await account();
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("approve opens a 7 day one-shot allowance for the alert cell, usable exactly once", async () => {
    const ops = makeOps();
    const accountId = await account();
    const alertId = await redAlert(accountId);
    const result = await ops.decideAlert(alertId, "approve", admin);
    expect(result).toMatchObject({ outcome: "ok", alert: { status: "approved", kind: "zone_red", lat: -80.53, lon: 20.27 } });
    const row = (await pool.query<{ cell_key: string; allowance_expires_at: Date; decided_by: string }>(
      "SELECT cell_key, allowance_expires_at, decided_by FROM trust_alerts WHERE id = $1", [alertId]
    )).rows[0]!;
    expect(row.cell_key).toBe(alertCellKey(RED.lat, RED.lon));
    expect(row.allowance_expires_at.getTime()).toBe(NOW.getTime() + 7 * DAY_MS);
    expect(row.decided_by).toBe(admin);
    expect((await notes(accountId)).map((note) => note.rule)).toEqual(["admin_alert_approve"]);

    // The relocation reaches the same cell: allowed once, then consumed.
    expect(await alertWriter.consumeRedAllowance(accountId, row.cell_key, NOW)).not.toBeNull();
    expect(await alertWriter.consumeRedAllowance(accountId, row.cell_key, NOW)).toBeNull();
    // An approval does not authorise a different cell, nor a later week.
    const other = await redAlert(await account());
    await ops.decideAlert(other, "approve", admin);
    expect(await alertWriter.consumeRedAllowance(accountId, alertCellKey(0, 0), NOW)).toBeNull();
  });

  it("an expired allowance cannot be consumed", async () => {
    const ops = makeOps();
    const accountId = await account();
    const alertId = await redAlert(accountId);
    await ops.decideAlert(alertId, "approve", admin);
    expect(await alertWriter.consumeRedAllowance(
      accountId, alertCellKey(RED.lat, RED.lon), new Date(NOW.getTime() + 7 * DAY_MS + 1)
    )).toBeNull();
  });

  it("approve on a non-red alert records the decision without an allowance", async () => {
    const ops = makeOps();
    const accountId = await account();
    await alertWriter.fileZoneAlert({ accountId, kind: "zone_orange", lat: 60.012, lon: -150.01, now: NOW, details: {} });
    const orange = (await pool.query<{ id: string }>("SELECT id FROM trust_alerts WHERE account_id = $1", [accountId])).rows[0]!.id;
    const result = await ops.decideAlert(orange, "approve", admin);
    expect(result).toMatchObject({ outcome: "ok", alert: { status: "approved", allowanceExpiresAt: null } });
  });

  it("lock suspends the account, revokes sessions, closes connections and clears the allowance", async () => {
    closeConnections.mockClear();
    const ops = makeOps();
    const accountId = await account();
    await session(accountId);
    const alertId = await redAlert(accountId);
    await ops.decideAlert(alertId, "approve", admin);

    const result = await ops.decideAlert(alertId, "lock", admin);
    expect(result).toMatchObject({ outcome: "ok", alert: { status: "locked", allowanceExpiresAt: null } });
    expect(await accountRow(accountId)).toEqual({ status: "suspended", suspension_reason: "trust_alert_locked" });
    expect(await activeSessions(accountId)).toBe(0);
    expect(closeConnections).toHaveBeenCalledWith(accountId, "trust_alert_locked");
    expect((await notes(accountId)).map((note) => note.rule).sort()).toEqual(["admin_alert_approve", "admin_alert_lock"]);
    expect(await alertWriter.consumeRedAllowance(accountId, alertCellKey(RED.lat, RED.lon), NOW)).toBeNull();
  });

  it("dismiss closes a pending alert; decided alerts refuse a second decision", async () => {
    const ops = makeOps();
    const accountId = await account();
    const alertId = await redAlert(accountId);
    expect(await ops.decideAlert(alertId, "dismiss", admin)).toMatchObject({ outcome: "ok", alert: { status: "dismissed" } });
    expect(await ops.decideAlert(alertId, "approve", admin)).toEqual({ outcome: "invalid_state", status: "dismissed" });
    expect(await ops.decideAlert(alertId, "lock", admin)).toEqual({ outcome: "invalid_state", status: "dismissed" });
    expect(await accountRow(accountId)).toMatchObject({ status: "active" });
    expect(await ops.decideAlert(randomUUID(), "dismiss", admin)).toEqual({ outcome: "not_found" });
    // A pending slot freed by dismissal lets the account file a new red alert.
    expect((await alertWriter.fileRedAlert({ accountId, ...RED, now: NOW, details: {} })).created).toBe(true);
  });

  it("lists pending alerts first, severity descending, with status and kind filters and paging", async () => {
    const ops = makeOps();
    const accountId = await account();
    const dismissedHigh = await redAlert(accountId, new Date(NOW.getTime() - 5000));
    await ops.decideAlert(dismissedHigh, "dismiss", admin);
    await alertWriter.fileZoneAlert({ accountId, kind: "zone_yellow", lat: 1.01, lon: 2.02, now: new Date(NOW.getTime() - 4000), details: {} });
    await alertWriter.fileZoneAlert({ accountId, kind: "zone_orange", lat: 3.01, lon: 4.02, now: new Date(NOW.getTime() - 3000), details: {} });
    await redAlert(accountId, new Date(NOW.getTime() - 2000));

    const all = await store.listAlerts({ limit: 100, offset: 0 });
    const mine = all.alerts.filter((alert) => alert.accountId === accountId);
    expect(mine.map((alert) => [alert.kind, alert.status])).toEqual([
      ["zone_red", "pending"],
      ["zone_orange", "pending"],
      ["zone_yellow", "pending"],
      ["zone_red", "dismissed"]
    ]);
    const firstPendingIndex = all.alerts.findIndex((alert) => alert.status !== "pending");
    expect(all.alerts.slice(firstPendingIndex).every((alert) => alert.status !== "pending")).toBe(true);
    expect(all.total).toBeGreaterThanOrEqual(4);

    const oranges = await store.listAlerts({ status: "pending", kind: "zone_orange", limit: 100, offset: 0 });
    expect(oranges.alerts.every((alert) => alert.kind === "zone_orange" && alert.status === "pending")).toBe(true);
    expect(oranges.alerts.find((alert) => alert.accountId === accountId)).toMatchObject({ lat: 3.01, lon: 4.02, count: 1 });
    const page = await store.listAlerts({ limit: 1, offset: 1 });
    expect(page.alerts).toHaveLength(1);
    expect(page.alerts[0]!.id).toBe(all.alerts[1]!.id);
    expect(page.total).toBe(all.total);
  });

  it("admin unsettle revokes Settled, resets progress, signals once and invalidates invites; settle restores it", async () => {
    invites.invalidateForInviter.mockClear();
    const sink = { recordSignals: vi.fn(async () => undefined) };
    const onInvitesInvalidated = vi.fn(async () => undefined);
    const service = new SettlementService(new PostgresSettlementStore(pool), CONFIG, {
      sink, invites, onInvitesInvalidated, now: () => NOW
    });
    const ops = makeOps(service);
    const accountId = await account();
    const playerId = await player(accountId);
    await pool.query(
      `INSERT INTO account_settlement (account_id, home_lat, home_lon, settled_home_lat, settled_home_lon,
         settled_at, settled_home_at, target_checks, target_days, counted_checks, counted_days)
       VALUES ($1, 40.0123, -105.0456, 40.0123, -105.0456, $2, $2, 22, 5, 22, 5)`,
      [accountId, new Date(NOW.getTime() - DAY_MS)]
    );
    expect(await service.isSettled(accountId)).toBe(true);

    expect(await ops.unsettle(accountId, admin)).toBe("ok");
    expect(await service.isSettled(accountId)).toBe(false);
    const view = await ops.settlementView(accountId);
    expect(view).toMatchObject({
      settled: false, settledHome: null, unsettleReason: "admin", countedChecks: 0, countedDays: 0, home: { lat: 40.01, lon: -105.05 }
    });
    expect(invites.invalidateForInviter).toHaveBeenCalledWith(playerId, "Travel invitation is unavailable.");
    expect(onInvitesInvalidated).toHaveBeenCalledWith(["guest-invite"]);
    expect(sink.recordSignals).toHaveBeenCalledWith(expect.objectContaining({
      accountId,
      signals: [expect.objectContaining({ rule: "settled_revoked", metadata: expect.objectContaining({ reason: "admin", wasSettled: true }) })]
    }));
    expect((await notes(accountId)).map((note) => note.rule)).toContain("admin_unsettled");

    const listener = vi.fn();
    service.addStatusListener(listener);
    expect(await ops.settle(accountId, admin)).toBe("ok");
    expect(await service.isSettled(accountId)).toBe(true);
    expect(await ops.settlementView(accountId)).toMatchObject({
      settled: true, unsettleReason: null, settledHome: { lat: 40.01, lon: -105.05 }, provisionalUntil: null
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(accountId, { revoked: false }));
    expect(await ops.settle(await account(), admin)).toBe("no_home");
    expect(await ops.settle(randomUUID(), admin)).toBe("not_found");
    expect(await ops.unsettle(randomUUID(), admin)).toBe("not_found");
  });

  it("quarantine dry-run count equals the confirmed count, suspends only active guests since T", async () => {
    closeConnections.mockClear();
    const ops = makeOps();
    const host = await account();
    const since = new Date(NOW.getTime() - 2 * DAY_MS);
    const guests = [await account(), await account(), await account()];
    const alreadySuspended = await account("suspended");
    const before = await account();
    await session(guests[0]!);
    await arrival(host, guests[0]!, new Date(NOW.getTime() - DAY_MS));
    await arrival(host, guests[0]!, new Date(NOW.getTime() - 3600_000));
    await arrival(host, guests[1]!, new Date(NOW.getTime() - DAY_MS));
    await arrival(host, guests[2]!, since);
    await arrival(host, alreadySuspended, new Date(NOW.getTime() - DAY_MS));
    await arrival(host, before, new Date(since.getTime() - 1));

    const dry = await ops.quarantineArrivals({ hostAccountId: host, since, confirm: false, adminAccountId: admin });
    expect(dry).toEqual({ outcome: "ok", dryRun: true, guestCount: 3, suspendedCount: 0 });
    expect(await accountRow(guests[0]!)).toMatchObject({ status: "active" });

    expect(await ops.quarantineArrivals({
      hostAccountId: host, since, confirm: true, expectedCount: 2, adminAccountId: admin
    })).toEqual({ outcome: "count_mismatch", actual: 3 });
    expect(await accountRow(guests[0]!)).toMatchObject({ status: "active" });

    const confirmed = await ops.quarantineArrivals({
      hostAccountId: host, since, confirm: true, expectedCount: dry.outcome === "ok" ? dry.guestCount : 0, adminAccountId: admin
    });
    expect(confirmed).toEqual({ outcome: "ok", dryRun: false, guestCount: 3, suspendedCount: 3 });
    for (const guest of guests) {
      expect(await accountRow(guest)).toEqual({ status: "suspended", suspension_reason: "trust_arrival_quarantine" });
    }
    expect(await accountRow(host)).toMatchObject({ status: "active" });
    expect(await accountRow(before)).toMatchObject({ status: "active" });
    expect(await activeSessions(guests[0]!)).toBe(0);
    expect(closeConnections).toHaveBeenCalledTimes(3);
    expect((await notes(host)).map((note) => note.rule)).toEqual(["admin_quarantine_arrivals"]);
    expect((await notes(guests[1]!)).map((note) => note.rule)).toEqual(["admin_quarantine_guest"]);

    // Everything is suspended now: a second dry run finds nobody.
    expect(await ops.quarantineArrivals({ hostAccountId: host, since, confirm: false, adminAccountId: admin }))
      .toMatchObject({ guestCount: 0 });
    expect(await ops.quarantineArrivals({ hostAccountId: randomUUID(), since, confirm: false, adminAccountId: admin }))
      .toEqual({ outcome: "not_found" });
  });

  it("account detail shows Settled status, attestations, last-fix assurance and arrivals", async () => {
    const detailStore = new PostgresTrustAdminStore(pool);
    const accountId = await account();
    await player(accountId);
    const host = await account();
    const hostPlayerName = `H${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO players (id, account_id, username, username_normalized, display_color, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, geom)
       VALUES ($1, $2, $3, lower($3), '#3366cc', 'CO', 40, -105, 40, -105, 600, ST_SetSRID(ST_MakePoint(-105, 40), 4326))`,
      [`p-${randomUUID()}`, host, hostPlayerName]
    );
    const guest = await account();
    await pool.query(
      `INSERT INTO account_settlement (account_id, home_lat, home_lon, settled_home_lat, settled_home_lon,
         settled_at, settled_home_at, provisional_until, difficulty, target_checks, target_days,
         counted_checks, counted_days, distinct_positions)
       VALUES ($1, 40.1234, -105.5678, 40.1234, -105.5678, $2, $2, $3, 1.5, 33, 8, 10, 3, 2)`,
      [accountId, new Date(NOW.getTime() - DAY_MS), new Date(NOW.getTime() + DAY_MS)]
    );
    await pool.query(
      `INSERT INTO account_location_state (account_id, last_fix_assurance) VALUES ($1, 'device_checked')
       ON CONFLICT (account_id) DO UPDATE SET last_fix_assurance = 'device_checked'`,
      [accountId]
    );
    for (let index = 0; index < 22; index += 1) {
      await pool.query(
        `INSERT INTO device_attestations (id, account_id, platform, method, purpose, outcome, assurance, reason,
           ref_hash, created_at, expires_at)
         VALUES ($1, $2, 'android', 'play_integrity', 'session', $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(), accountId, index === 0 ? "fail" : "pass", index === 0 ? "flagged" : "attested",
          index === 0 ? "device_integrity" : null, randomUUID(), new Date(NOW.getTime() - index * 60_000),
          new Date(NOW.getTime() + DAY_MS)
        ]
      );
    }
    await arrival(host, accountId, new Date(NOW.getTime() - DAY_MS));
    await arrival(accountId, guest, new Date(NOW.getTime() - 2 * DAY_MS));

    const detail = (await detailStore.accountDetail(accountId, NOW, 7))!;
    expect(detail.settlement).toMatchObject({
      settled: true, home: { lat: 40.12, lon: -105.57 }, settledHome: { lat: 40.12, lon: -105.57 },
      difficulty: 1.5, targetChecks: 33, targetDays: 8, countedChecks: 10, countedDays: 3, distinctPositions: 2,
      provisionalUntil: new Date(NOW.getTime() + DAY_MS).toISOString()
    });
    expect(detail.lastFixAssurance).toBe("device_checked");
    expect(detail.attestations).toHaveLength(20);
    expect(detail.attestations[0]).toMatchObject({
      method: "play_integrity", outcome: "fail", assurance: "flagged", reason: "device_integrity"
    });
    expect(detail.broughtBy).toEqual([expect.objectContaining({
      otherAccountId: host, otherPlayerName: hostPlayerName, kind: "invite", lat: 12.34, lon: 56.78
    })]);
    expect(detail.broughtIn).toEqual([expect.objectContaining({ otherAccountId: guest })]);

    // Provisional window over: no longer Settled right now.
    const later = (await detailStore.accountDetail(accountId, new Date(NOW.getTime() + 2 * DAY_MS), 7))!;
    expect(later.settlement?.settled).toBe(false);
    const bare = (await detailStore.accountDetail(await account(), NOW, 7))!;
    expect(bare).toMatchObject({ settlement: null, attestations: [], lastFixAssurance: null, broughtBy: [], broughtIn: [] });
  });

  it("maps the unanchored-routes report to ISO timestamps over the requested window", async () => {
    unanchored.unanchoredRoutesReport.mockResolvedValueOnce([{
      destinationKind: "flag", destinationId: "f1", ownerAccountId: null, attempts: 4, travellers: 2,
      lastAttemptAt: NOW
    }] as never);
    const report = await makeOps().unanchoredRoutes(3, 10);
    expect(unanchored.unanchoredRoutesReport).toHaveBeenLastCalledWith(new Date(NOW.getTime() - 3 * DAY_MS), 10);
    expect(report.routes).toEqual([expect.objectContaining({ destinationId: "f1", lastAttemptAt: NOW.toISOString() })]);
  });

  describe("red-zone relocation (enforce)", () => {
    const sink = { recordSignals: vi.fn(async () => undefined) };
    const agedAccount = async (ageDays: number) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO accounts (id, status, trust_tier, created_at)
         VALUES ($1, 'active', 'standard', $2::timestamptz - ($3::double precision * interval '1 day'))`,
        [id, NOW, ageDays]
      );
      return id;
    };
    const suspension = async (accountId: string) => (await pool.query<{
      status: string; suspended_at: Date | null; suspension_reason: string | null;
    }>("SELECT status, suspended_at, suspension_reason FROM accounts WHERE id = $1", [accountId])).rows[0]!;
    const alertRows = async (accountId: string) => (await pool.query<{
      id: string; status: string; severity: number; details: Record<string, unknown>;
    }>(
      "SELECT id::text AS id, status, severity, details FROM trust_alerts WHERE account_id = $1 ORDER BY created_at, id",
      [accountId]
    )).rows;
    const makeGate = (mode: "shadow" | "enforce" = "enforce") => new RelocationGate({
      config: {
        TRUST_ALERT_ZONE_MODE: mode,
        TRUST_RELOCATION_NATIVE_ONLY_MODE: "off",
        TRUST_KINGDOM_ALERT_RADIUS_KM: 10,
        TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS: 7
      },
      classify: () => "red",
      yellowOwners: async () => [],
      alerts: alertWriter,
      redZoneLock: makeOps(),
      sink,
      now: () => NOW
    });
    const relocate = (gate: RelocationGate, accountId: string) => gate.checkDestination({ accountId, ...RED });

    it("locks a brand-new unsettled account: suspended, sessions revoked, connections closed, locked sev 4 alert", async () => {
      closeConnections.mockClear();
      sink.recordSignals.mockClear();
      const accountId = await agedAccount(2);
      await session(accountId);
      const decision = await relocate(makeGate(), accountId);
      if (decision.allowed) throw new Error("expected refusal");
      expect(decision.message).toBe(RELOCATION_RED_REFUSED_MESSAGE);
      expect(closeConnections).not.toHaveBeenCalled();
      await decision.afterRefusal?.();
      expect(closeConnections).toHaveBeenCalledWith(accountId, SUSPENSION_REASON_RED_ZONE_NEW_ACCOUNT);

      const row = await suspension(accountId);
      expect(row).toMatchObject({ status: "suspended", suspension_reason: "trust_red_zone_new_account" });
      expect(row.suspended_at?.getTime()).toBe(NOW.getTime());
      expect(await activeSessions(accountId)).toBe(0);
      const alerts = await alertRows(accountId);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        status: "locked",
        severity: 4,
        details: { autoLocked: true, accountAgeHours: 48, mode: "enforce", populationClass: "red", count: 1 }
      });
      expect(sink.recordSignals).toHaveBeenCalledWith({
        accountId,
        signals: [expect.objectContaining({
          rule: "relocation_red_zone",
          weight: 3,
          metadata: expect.objectContaining({ dedupeKey: `relocation_red_zone:${alerts[0]!.id}` })
        })]
      });
      expect((await notes(accountId)).map((note) => note.rule)).toEqual(["auto_red_zone_lock"]);

      // Admin Unlock lifts the suspension and closes the alert; sessions stay revoked.
      const unlocked = await makeOps().decideAlert(alerts[0]!.id, "unlock", admin);
      expect(unlocked).toMatchObject({
        outcome: "ok",
        alert: { status: "dismissed", details: { autoLocked: true, accountReactivated: true, unlockedBy: admin } }
      });
      expect(await suspension(accountId)).toEqual({ status: "active", suspended_at: null, suspension_reason: null });
      expect(await activeSessions(accountId)).toBe(0);
      expect(await makeOps().decideAlert(alerts[0]!.id, "unlock", admin))
        .toEqual({ outcome: "invalid_state", status: "dismissed" });
      expect((await notes(accountId)).map((note) => note.rule).sort()).toEqual(["admin_alert_unlock", "auto_red_zone_lock"]);
    });

    it("refuses an aged unsettled account with the new copy and a pending alert, account stays active", async () => {
      const accountId = await agedAccount(7.01);
      const decision = await relocate(makeGate(), accountId);
      expect(decision).toEqual({ allowed: false, message: "You can't relocate here." });
      expect(await suspension(accountId)).toMatchObject({ status: "active", suspension_reason: null });
      expect(await alertRows(accountId)).toEqual([expect.objectContaining({ status: "pending", severity: 3 })]);
      // A repeat is refused without a second alert.
      expect(await relocate(makeGate(), accountId)).toEqual({ allowed: false, message: "You can't relocate here." });
      expect(await alertRows(accountId)).toHaveLength(1);
    });

    it("treats a Settled young account as aged: refused, not locked", async () => {
      const accountId = await agedAccount(2);
      await pool.query(
        `INSERT INTO account_settlement (account_id, home_lat, home_lon, settled_home_lat, settled_home_lon,
           settled_at, settled_home_at, target_checks, target_days, counted_checks, counted_days)
         VALUES ($1, 40, -105, 40, -105, $2, $2, 22, 5, 22, 5)`,
        [accountId, new Date(NOW.getTime() - DAY_MS)]
      );
      const decision = await relocate(makeGate(), accountId);
      expect(decision).toEqual({ allowed: false, message: "You can't relocate here." });
      expect(await suspension(accountId)).toMatchObject({ status: "active" });
      expect(await alertRows(accountId)).toEqual([expect.objectContaining({ status: "pending" })]);
    });

    it("holds a Settled account's red attempt for review; Approve restores Settled (owner decision E)", async () => {
      const accountId = await agedAccount(60);
      await pool.query(
        `INSERT INTO account_settlement (account_id, home_lat, home_lon, settled_home_lat, settled_home_lon,
           settled_at, settled_home_at, target_checks, target_days, counted_checks, counted_days)
         VALUES ($1, 40, -105, 40, -105, $2, $2, 22, 5, 22, 5)`,
        [accountId, new Date(NOW.getTime() - 30 * DAY_MS)]
      );
      const settlement = new SettlementService(new PostgresSettlementStore(pool), CONFIG, { now: () => NOW });
      const gate = new RelocationGate({
        config: {
          TRUST_ALERT_ZONE_MODE: "enforce",
          TRUST_RELOCATION_NATIVE_ONLY_MODE: "off",
          TRUST_KINGDOM_ALERT_RADIUS_KM: 10,
          TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS: 7
        },
        classify: () => "red",
        yellowOwners: async () => [],
        alerts: alertWriter,
        redZoneLock: makeOps(),
        settlement,
        sink,
        now: () => NOW
      });
      expect(await relocate(gate, accountId)).toEqual({
        allowed: false,
        message: "This location needs review. Your Settled status is paused until it's checked."
      });
      expect(await suspension(accountId)).toMatchObject({ status: "active" });
      const [alert] = await alertRows(accountId);
      expect(alert).toMatchObject({ status: "pending", severity: 4, details: expect.objectContaining({ settledHold: true }) });
      expect(await settlement.isSettled(accountId)).toBe(false);
      const decided = await makeOps(settlement).decideAlert(alert!.id, "approve", admin);
      expect(decided.outcome).toBe("ok");
      expect(await settlement.isSettled(accountId)).toBe(true);
    });

    it("an admin allowance still passes exactly once, also for a brand-new account", async () => {
      const ops = makeOps();
      const aged = await agedAccount(30);
      await relocate(makeGate(), aged);
      await ops.decideAlert((await alertRows(aged))[0]!.id, "approve", admin);
      expect((await relocate(makeGate(), aged)).allowed).toBe(true);
      expect(await relocate(makeGate(), aged)).toEqual({ allowed: false, message: "You can't relocate here." });

      // New account with an allowance from before (shadow-era alert): passes once, then locks.
      const young = await agedAccount(1);
      await ops.decideAlert(await redAlert(young), "approve", admin);
      expect((await relocate(makeGate(), young)).allowed).toBe(true);
      expect(await suspension(young)).toMatchObject({ status: "active" });
      const second = await relocate(makeGate(), young);
      expect(second).toMatchObject({ allowed: false, message: "You can't relocate here." });
      expect(await suspension(young)).toMatchObject({ status: "suspended", suspension_reason: "trust_red_zone_new_account" });
    });

    it("shadow is unchanged: a brand-new account relocates and gets a pending alert after commit", async () => {
      const accountId = await agedAccount(1);
      const decision = await relocate(makeGate("shadow"), accountId);
      if (!decision.allowed) throw new Error("expected allowed");
      await decision.committed();
      expect(await suspension(accountId)).toMatchObject({ status: "active" });
      expect(await alertRows(accountId)).toEqual([expect.objectContaining({ status: "pending", severity: 3 })]);
    });

    it("unlock leaves a suspension that is not a trust lock in place", async () => {
      const accountId = await account("suspended");
      const alertId = randomUUID();
      await pool.query(
        `INSERT INTO trust_alerts (id, account_id, kind, severity, status, details, created_at)
         VALUES ($1, $2, 'zone_red', 3, 'locked', '{}'::jsonb, $3)`,
        [alertId, accountId, NOW]
      );
      expect(await makeOps().decideAlert(alertId, "unlock", admin)).toMatchObject({
        outcome: "ok", alert: { status: "dismissed", details: { accountReactivated: false } }
      });
      expect(await accountRow(accountId)).toEqual({ status: "suspended", suspension_reason: "test" });
    });
  });
});

function testDatabaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must use local PostgreSQL");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must target an ash_atlas_stability* database");
  }
  return value;
}
