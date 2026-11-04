import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../../db/disposableTestPool.js";
import { runMigrations } from "../../db/migrate.js";
import { decayLogodds } from "./trustScore.js";
import { TrustService, type TrustScoreConfig } from "./trustService.js";
import { PostgresTrustStateStore } from "./trustStore.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite = adminUrl ? describe : describe.skip;
const MIGRATION = "0883_account_trust_state.sql";
const DAY_MS = 24 * 60 * 60_000;
const T0 = new Date("2026-10-01T00:00:00.000Z");

const CONFIG: TrustScoreConfig = {
  TRUST_QUARANTINE_MODE: "shadow",
  TRUST_DECAY_TAU_DAYS: 7,
  TRUST_FAMILIAR_REGION_DAYS: 10,
  TRUST_FAMILIAR_REGION_STALE_DAYS: 90,
  TRUST_QUARANTINE_THRESHOLD: 8,
  TRUST_QUARANTINE_THRESHOLD_NEW: 6,
  TRUST_WARNING_THRESHOLD: 15
};

databaseSuite("account trust state migration and scoring", () => {
  const databaseName = `ash_atlas_stability_trust_state_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const accountId = randomUUID();
  const reportId = randomUUID();
  let admin: pg.Pool | undefined;
  let pool: DisposableTestPool | undefined;
  let directory = "";
  let databaseUrl = "";

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname)
      || url.pathname !== "/ash_atlas_stability"
      || !["postgres:", "postgresql:"].includes(url.protocol)
    ) {
      throw new Error("Trust state tests require a local disposable ash_atlas_stability admin");
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-trust-state-"));
    const migrations = path.resolve(process.cwd(), "../../db/migrations");
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql") && file.localeCompare("0883_") < 0) {
        await copyFile(path.join(migrations, file), path.join(directory, file));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 12 });
    await insertAccount(accountId, "new", 30, "scout@school.example");
    // Populated fixture on the pre-0883 schema (the store targets the current schema).
    await pool.query(
      `INSERT INTO account_location_state (account_id, last_seq) VALUES ($1, 1)`,
      [accountId]
    );
    await pool.query(
      `INSERT INTO location_reports (id, account_id, player_id, seq, source, lat, lon, client_platform, received_at, verdict)
       VALUES ($1, $2, 'player-1', 1, 'relocation', 40, -105, 'web', $3, 'accepted')`,
      [reportId, accountId, T0]
    );
    await copyFile(path.join(migrations, MIGRATION), path.join(directory, MIGRATION));
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([MIGRATION]);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function insertAccount(id: string, trustTier: string, ageDays: number, email: string | null) {
    await pool!.query(
      "INSERT INTO accounts (id, status, trust_tier, created_at) VALUES ($1, 'active', $2, $3)",
      [id, trustTier, new Date(T0.getTime() - ageDays * DAY_MS)]
    );
    if (email) {
      await pool!.query(
        `INSERT INTO account_identities (id, account_id, provider, provider_subject, email, email_normalized, email_verified)
         VALUES ($1, $2, 'google', $3, $4, $4, true)`,
        [randomUUID(), id, randomUUID(), email]
      );
    }
  }

  function service(clock: { at: Date }) {
    return new TrustService(new PostgresTrustStateStore(pool!), CONFIG, { now: () => clock.at });
  }

  async function state(id: string) {
    return (await pool!.query(
      `SELECT logodds, peak_logodds, shadow_tier, enforcement_tier, tier_exit_eligible_at
         FROM account_trust_state WHERE account_id = $1`,
      [id]
    )).rows[0];
  }

  it("preserves populated rows and has an empty second run", async () => {
    expect((await pool!.query("SELECT count(*)::int AS count FROM location_reports WHERE id = $1", [reportId])).rows[0].count).toBe(1);
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([]);
  });

  it("decays, dedupes, recomputes equal to the incremental score, and enters a shadow tier", async () => {
    const clock = { at: T0 };
    const trust = service(clock);
    const store = new PostgresTrustStateStore(pool!);

    await trust.recordSignals({ accountId, reportId, signals: [{ rule: "speed_impossible", weight: 4 }] });
    await trust.recordSignals({ accountId, reportId, signals: [{ rule: "speed_impossible", weight: 4 }] });
    expect((await state(accountId)).logodds).toBe(4);
    expect((await pool!.query(
      "SELECT location_report_id, dedupe_key FROM account_trust_events WHERE account_id = $1 AND kind = 'signal'",
      [accountId]
    )).rows).toEqual([{ location_report_id: reportId, dedupe_key: `report:${reportId}:speed_impossible` }]);

    clock.at = new Date(T0.getTime() + 7 * DAY_MS);
    await trust.recordSignals({
      accountId,
      signals: [{ rule: "land_action_during_hold", weight: 0.5, metadata: { dedupeKey: "hold:a:1" } }]
    });
    const afterWeek = await state(accountId);
    expect(afterWeek.logodds).toBeCloseTo(4 / Math.E + 0.5, 12);
    expect(afterWeek.peak_logodds).toBe(4);
    expect(Math.abs(await store.recomputeLogodds(accountId, clock.at, 7) - afterWeek.logodds)).toBeLessThan(1e-9);
    const later = new Date(T0.getTime() + 10 * DAY_MS);
    expect(Math.abs(
      await store.recomputeLogodds(accountId, later, 7)
      - decayLogodds(afterWeek.logodds, clock.at, later, 7)
    )).toBeLessThan(1e-9);

    // Effective = logodds + 0.5 (non-gmail Google prior); new accounts quarantine at 6.
    await trust.recordSignals({ accountId, signals: [{ rule: "relocation_far_repeat", weight: 4 }] });
    const quarantined = await state(accountId);
    expect(quarantined).toMatchObject({ shadow_tier: 3, enforcement_tier: 0 });
    expect((await pool!.query(
      "SELECT metadata FROM account_trust_events WHERE account_id = $1 AND kind = 'shadow_tier_change'",
      [accountId]
    )).rows).toEqual([{ metadata: expect.objectContaining({ from: 0, to: 3 }) }]);

    // Below the threshold the tier holds for 24 h, then a login refresh exits it.
    clock.at = new Date(clock.at.getTime() + 14 * DAY_MS);
    await trust.onLogin(accountId);
    expect(await state(accountId)).toMatchObject({ shadow_tier: 3 });
    expect((await state(accountId)).tier_exit_eligible_at).not.toBeNull();
    clock.at = new Date(clock.at.getTime() + DAY_MS);
    await trust.onLogin(accountId);
    expect(await state(accountId)).toMatchObject({ shadow_tier: 0, enforcement_tier: 0 });
  });

  it("applies concurrent signals without losing updates", async () => {
    const id = randomUUID();
    await insertAccount(id, "standard", 30, "busy@example.com");
    const trust = service({ at: T0 });
    await Promise.all(Array.from({ length: 8 }, (_unused, index) =>
      trust.recordSignals({ accountId: id, signals: [{ rule: "speed_air", weight: 1, metadata: { dedupeKey: `c:${id}:${index}` } }] })
    ));
    expect((await state(id)).logodds).toBe(8);
    expect((await pool!.query(
      "SELECT count(*)::int AS count FROM account_trust_events WHERE account_id = $1 AND kind = 'signal'",
      [id]
    )).rows[0].count).toBe(8);
  });

  it("treats a region as familiar after 10 interaction days until 90 days stale", async () => {
    const id = randomUUID();
    await insertAccount(id, "standard", 200, null);
    const trust = service({ at: T0 });
    const region = async (cell: string, days: number, lastSeenDaysAgo: number) => pool!.query(
      `INSERT INTO account_regions (account_id, region_cell, interaction_days, last_seen_at, last_counted_day)
       VALUES ($1, $2, $3, $4::timestamptz, ($4::timestamptz AT TIME ZONE 'UTC')::date)`,
      [id, cell, days, new Date(T0.getTime() - lastSeenDaysAgo * DAY_MS)]
    );
    await region("80:-210", 9, 1);
    await region("90:-210", 10, 91);
    await region("60:-200", 10, 89);

    // 80:-210 has 9 days; its neighbors have none.
    expect(await trust.isFamiliar({ accountId: id, lat: 40.2, lon: -104.8, now: T0 })).toBe(false);
    await pool!.query(
      "UPDATE account_regions SET interaction_days = 10 WHERE account_id = $1 AND region_cell = '80:-210'",
      [id]
    );
    // A neighboring cell (81:-209) is familiar through the 3x3 block.
    expect(await trust.isFamiliar({ accountId: id, lat: 40.6, lon: -104.4, now: T0 })).toBe(true);
    expect(await trust.isFamiliar({ accountId: id, lat: 45.1, lon: -104.8, now: T0 })).toBe(false);
    expect(await trust.isFamiliar({ accountId: id, lat: 30.1, lon: -99.9, now: T0 })).toBe(true);
  });

  it("promotes a new account at login after 14 days and 5 login days", async () => {
    const ready = randomUUID();
    const early = randomUUID();
    await insertAccount(ready, "new", 20, "ready@example.com");
    await insertAccount(early, "new", 20, "early@example.com");
    for (const [id, days] of [[ready, 5], [early, 4]] as const) {
      for (let day = 0; day < days; day += 1) {
        await pool!.query(
          `INSERT INTO auth_events (id, account_id, event_type, created_at)
           VALUES ($1, $2, $3, $4), ($5, $2, 'google_login_failure', $4)`,
          [
            randomUUID(),
            id,
            day % 2 === 0 ? "google_login_success" : "apple_login_success",
            new Date(T0.getTime() - day * DAY_MS),
            randomUUID()
          ]
        );
      }
    }
    const trust = service({ at: T0 });
    await trust.onLogin(ready);
    await trust.onLogin(early);
    const tiers = (await pool!.query(
      "SELECT id, trust_tier FROM accounts WHERE id = ANY($1::uuid[])",
      [[ready, early]]
    )).rows;
    expect(Object.fromEntries(tiers.map((row) => [row.id, row.trust_tier]))).toEqual({
      [ready]: "standard",
      [early]: "new"
    });
    expect((await pool!.query(
      "SELECT rule FROM account_trust_events WHERE account_id = $1 AND kind = 'note'",
      [ready]
    )).rows).toEqual([{ rule: "trust_tier_promotion" }]);
  });
});
