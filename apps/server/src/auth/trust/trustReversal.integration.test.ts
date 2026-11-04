import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../../db/disposableTestPool.js";
import { runMigrations } from "../../db/migrate.js";
import { reverseTrustSignals, type TrustReversalOptions } from "./trustReversal.js";
import { TrustService, type TrustScoreConfig } from "./trustService.js";
import { PostgresTrustStateStore } from "./trustStore.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite = adminUrl ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60_000;
const T0 = new Date("2026-10-01T00:00:00.000Z");
const THRESHOLDS = { quarantine: 8, quarantineNew: 6, warning: 15 } as const;

const CONFIG: TrustScoreConfig = {
  TRUST_QUARANTINE_MODE: "shadow",
  TRUST_DECAY_TAU_DAYS: 7,
  TRUST_FAMILIAR_REGION_DAYS: 10,
  TRUST_FAMILIAR_REGION_STALE_DAYS: 90,
  TRUST_QUARANTINE_THRESHOLD: 8,
  TRUST_QUARANTINE_THRESHOLD_NEW: 6,
  TRUST_WARNING_THRESHOLD: 15
};

databaseSuite("trust bulk reversal", () => {
  const databaseName = `ash_atlas_stability_trust_reversal_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const accountA = randomUUID();
  const accountB = randomUUID();
  let admin: pg.Pool | undefined;
  let pool: DisposableTestPool | undefined;
  let directory = "";

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname)
      || url.pathname !== "/ash_atlas_stability"
      || !["postgres:", "postgresql:"].includes(url.protocol)
    ) {
      throw new Error("Trust reversal tests require a local disposable ash_atlas_stability admin");
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-trust-reversal-"));
    const migrations = path.resolve(process.cwd(), "../../db/migrations");
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql")) await copyFile(path.join(migrations, file), path.join(directory, file));
    }
    await runMigrations(url.toString(), { migrationsDirectory: directory });
    pool = new DisposableTestPool({ connectionString: url.toString(), max: 12 });
    for (const id of [accountA, accountB]) {
      await pool.query(
        "INSERT INTO accounts (id, status, trust_tier, created_at) VALUES ($1, 'active', 'new', $2)",
        [id, new Date(T0.getTime() - 30 * DAY_MS)]
      );
      await pool.query(
        `INSERT INTO account_identities (id, account_id, provider, provider_subject, email, email_normalized, email_verified)
         VALUES ($1, $2, 'google', $3, $4, $4, true)`,
        [randomUUID(), id, randomUUID(), `${id}@example.com`]
      );
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const options = (overrides: Partial<TrustReversalOptions>): TrustReversalOptions => ({
    rules: ["rule_a"],
    allRules: false,
    since: null,
    until: null,
    reason: "calibration",
    apply: false,
    now: T0,
    tauDays: 7,
    thresholds: THRESHOLDS,
    ...overrides
  });

  async function state(id: string) {
    return (await pool!.query(
      "SELECT logodds, shadow_tier FROM account_trust_state WHERE account_id = $1",
      [id]
    )).rows[0];
  }

  it("dry-runs without writing, applies once, and is idempotent", async () => {
    const trust = new TrustService(new PostgresTrustStateStore(pool!), CONFIG, { now: () => T0 });
    await trust.recordSignals({
      accountId: accountA,
      signals: [
        { rule: "rule_a", weight: 4, metadata: { dedupeKey: "a1" } },
        { rule: "rule_b", weight: 3, metadata: { dedupeKey: "a2" } }
      ]
    });
    await trust.recordSignals({
      accountId: accountB,
      signals: [{ rule: "rule_a", weight: 1, metadata: { dedupeKey: "b1" } }]
    });
    expect(await state(accountA)).toMatchObject({ logodds: 7, shadow_tier: 3 });

    const dry = await reverseTrustSignals(pool!, options({}));
    expect(dry.mode).toBe("dry-run");
    expect(dry.eventsReversed).toBe(2);
    expect(await state(accountA)).toMatchObject({ logodds: 7, shadow_tier: 3 });
    expect((await pool!.query("SELECT count(*)::int AS n FROM account_trust_events WHERE reversed_at IS NOT NULL")).rows[0].n).toBe(0);

    const applied = await reverseTrustSignals(pool!, options({ apply: true }));
    expect(applied.mode).toBe("apply");
    expect(applied.eventsReversed).toBe(2);
    expect(applied.accounts.find((entry) => entry.accountId === accountA)).toMatchObject({
      events: 1,
      logoddsBefore: 7,
      logoddsAfter: 3,
      shadowTierBefore: 3,
      shadowTierAfter: 0
    });
    expect(await state(accountA)).toMatchObject({ logodds: 3, shadow_tier: 0 });
    expect(await state(accountB)).toMatchObject({ logodds: 0, shadow_tier: 0 });
    expect((await pool!.query("SELECT count(*)::int AS n FROM account_trust_events WHERE kind = 'reversal'")).rows[0].n).toBe(2);

    const eventCount = async () =>
      (await pool!.query("SELECT count(*)::int AS n FROM account_trust_events")).rows[0].n;
    const before = await eventCount();
    const again = await reverseTrustSignals(pool!, options({ apply: true }));
    expect(again.eventsReversed).toBe(0);
    expect(again.accounts).toEqual([]);
    expect(await eventCount()).toBe(before);
    expect(await state(accountA)).toMatchObject({ logodds: 3, shadow_tier: 0 });
  });
});
