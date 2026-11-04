import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../../db/disposableTestPool.js";
import { runMigrations } from "../../db/migrate.js";
import { LandActionGate } from "./trustService.js";
import { PostgresLandActionStore } from "./trustStore.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite = adminUrl ? describe : describe.skip;
const MIGRATION = "0882_account_regions.sql";

databaseSuite("account regions migration and land-action recording", () => {
  const databaseName = `ash_atlas_stability_land_actions_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const accountId = randomUUID();
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
      throw new Error("Land-action tests require a local disposable ash_atlas_stability admin");
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-land-actions-"));
    const migrations = path.resolve(process.cwd(), "../../db/migrations");
    for (const file of await readdir(migrations)) {
      if (file.endsWith(".sql") && file.localeCompare("0882_") < 0) {
        await copyFile(path.join(migrations, file), path.join(directory, file));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 10 });
    await pool.query("INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')", [accountId]);
    await pool.query(
      `INSERT INTO account_location_state (account_id, last_seq, land_action_hold_until, land_action_hold_reason)
       VALUES ($1, 3, now() + interval '20 minutes', 'transit')`,
      [accountId]
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

  it("preserves populated location state and has an empty second run", async () => {
    expect((await pool!.query(
      "SELECT last_seq::int AS last_seq, land_action_hold_reason FROM account_location_state WHERE account_id = $1",
      [accountId]
    )).rows).toEqual([{ last_seq: 3, land_action_hold_reason: "transit" }]);
    expect(await runMigrations(databaseUrl, { migrationsDirectory: directory })).toEqual([]);
  });

  it("hydrates an enforced hold from the database", async () => {
    const gate = new LandActionGate(new PostgresLandActionStore(pool!), { TRUST_LAND_ACTION_MODE: "enforce" });
    const decision = await gate.check({ accountId, playerId: "p", action: "flag_attack", position: null });
    expect(decision).toMatchObject({ allowed: false, code: "LAND_ACTION_SETTLING" });
    expect(decision.allowed ? 0 : decision.retryAfterMs).toBeGreaterThan(19 * 60_000);
    const other = new LandActionGate(new PostgresLandActionStore(pool!), { TRUST_LAND_ACTION_MODE: "enforce" });
    await expect(other.check({ accountId: randomUUID(), playerId: "q", action: "flag_attack", position: null }))
      .resolves.toEqual({ allowed: true, shadowBlocked: false });
  });

  it("counts one interaction day per cell per UTC day under concurrency and replay", async () => {
    const store = new PostgresLandActionStore(pool!);
    const record = (at: string, lat = 40) => ({
      accountId,
      lat,
      lon: -105,
      at: new Date(at),
      regionCell: `${Math.floor(lat / 0.5)}:-210`,
      day: at.slice(0, 10)
    });
    await Promise.all(Array.from({ length: 6 }, () => store.recordLandAction(record("2026-10-01T10:00:00.000Z"))));
    await store.recordLandAction(record("2026-10-01T23:59:00.000Z"));
    await Promise.all(Array.from({ length: 4 }, () => store.recordLandAction(record("2026-10-02T00:01:00.000Z"))));
    // An older action never moves the last land-action position backwards.
    await store.recordLandAction(record("2026-09-30T12:00:00.000Z", 45));

    const regions = (await pool!.query(
      `SELECT region_cell, interaction_days, last_counted_day::text AS day
         FROM account_regions WHERE account_id = $1 ORDER BY region_cell`,
      [accountId]
    )).rows;
    expect(regions).toEqual([
      { region_cell: "80:-210", interaction_days: 2, day: "2026-10-02" },
      { region_cell: "90:-210", interaction_days: 1, day: "2026-09-30" }
    ]);
    const state = (await pool!.query(
      `SELECT last_land_action_at, last_land_action_lat, last_seq::int AS last_seq
         FROM account_location_state WHERE account_id = $1`,
      [accountId]
    )).rows[0];
    expect(state).toMatchObject({ last_land_action_lat: 40, last_seq: 3 });
    expect((state.last_land_action_at as Date).toISOString()).toBe("2026-10-02T00:01:00.000Z");
  });
});
