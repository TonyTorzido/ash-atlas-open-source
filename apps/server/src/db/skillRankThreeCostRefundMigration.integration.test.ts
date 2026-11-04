import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1100_skill_rank_three_cost_refund.sql";

type Rank = readonly [skillId: string, rank: number, pointsSpent: number, grandfathered: boolean];

describeDatabase("skill rank 3 cost refund populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_rank3_refund_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let migrationDirectory = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  const affected = `rank3-refund-a-${suffix}`;
  const grandfatheredAndWorld = `rank3-refund-b-${suffix}`;
  const inflated = `rank3-refund-c-${suffix}`;
  const unaffected = `rank3-refund-d-${suffix}`;
  const players = [affected, grandfatheredAndWorld, inflated, unaffected];

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-rank3-refund-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(migrationDirectory, name));
    }
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter')
       THEN CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN; END IF; END $$`
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });

    const seeds: ReadonlyArray<readonly [string, number, number, readonly Rank[]]> = [
      // Level 25: Taunt rank 3 bought at the old price (1+1+2) next to Cleave, which always cost 1.
      [affected, 25, 25, [["taunt", 3, 4, false], ["cleave", 3, 3, false]]],
      // Grandfathered baseline rank never paid for, plus Tidecraft rank 3 at the old price.
      [grandfatheredAndWorld, 25, 25, [["shield_charge", 3, 0, true], ["tidecraft", 3, 4, false]]],
      // Level 2 with spending above entitlement: total_earned was inflated to total_spent.
      [inflated, 2, 4, [["heroism", 3, 4, false]]],
      // Already at the new price: nothing changes.
      [unaffected, 25, 25, [["cleave", 3, 3, false], ["second_wind", 2, 2, false]]]
    ];
    for (const [playerId, level, earned, ranks] of seeds) {
      const accountId = randomUUID();
      await pool.query(`INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')`, [accountId]);
      await pool.query(
        `INSERT INTO players (
           id,account_id,username,username_normalized,display_color,region_code,
           lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
         ) VALUES (
           $1,$2,$1,$1,'#38bdf8','GLOBAL',35,-106,35,-106,650,false,
           ST_SetSRID(ST_MakePoint(-106,35),4326)
         )`,
        [playerId, accountId]
      );
      await pool.query(
        `INSERT INTO player_progression_profiles (player_id,level) VALUES ($1,$2)
         ON CONFLICT (player_id) DO UPDATE SET level=excluded.level`,
        [playerId, level]
      );
      for (const [skillId, rank, pointsSpent, grandfathered] of ranks) {
        await pool.query(
          `INSERT INTO player_skill_ranks (player_id,skill_id,rank,points_spent,grandfathered,revision)
           VALUES ($1,$2,$3,$4,$5,1)`,
          [playerId, skillId, rank, pointsSpent, grandfathered]
        );
      }
      const spent = ranks.reduce((sum, [, , pointsSpent]) => sum + pointsSpent, 0);
      await pool.query(
        `INSERT INTO player_skill_point_state (player_id,total_earned,total_spent,revision)
         VALUES ($1,$2,$3,1)
         ON CONFLICT (player_id) DO UPDATE
         SET total_earned=excluded.total_earned, total_spent=excluded.total_spent, revision=1`,
        [playerId, earned, spent]
      );
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("refunds the extra rank-3 point once, reconciles balances, and is a no-op when replayed", async () => {
    await copyFile(path.join(migrations, TARGET_MIGRATION), path.join(migrationDirectory, TARGET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    const after = await snapshot();
    expect(after.ranks).toEqual({
      [`${affected}/taunt`]: [3, 3, 2],
      [`${affected}/cleave`]: [3, 3, 1],
      [`${grandfatheredAndWorld}/shield_charge`]: [3, 0, 1],
      [`${grandfatheredAndWorld}/tidecraft`]: [3, 3, 2],
      [`${inflated}/heroism`]: [3, 3, 2],
      [`${unaffected}/cleave`]: [3, 3, 1],
      [`${unaffected}/second_wind`]: [2, 2, 1]
    });
    // [total_earned, total_spent, revision]
    expect(after.state).toEqual({
      [affected]: [25, 6, 2],
      [grandfatheredAndWorld]: [25, 3, 2],
      [inflated]: [3, 3, 2],
      [unaffected]: [25, 5, 1]
    });
    expect(after.operations).toEqual([
      `rank-cost-refund-1100:${affected}:taunt`,
      `rank-cost-refund-1100:${grandfatheredAndWorld}:tidecraft`,
      `rank-cost-refund-1100:${inflated}:heroism`
    ].sort());

    // The runner skips an applied file; replaying the SQL itself must change nothing either.
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([]);
    const sql = await readFile(path.join(migrations, TARGET_MIGRATION), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(await snapshot()).toEqual(after);
  }, 120_000);

  async function snapshot() {
    const ranks = await pool.query<{ player_id: string; skill_id: string; rank: number; points_spent: number; revision: string }>(
      `SELECT player_id,skill_id,rank,points_spent,revision::text FROM player_skill_ranks
       WHERE player_id = ANY($1::text[])`,
      [players]
    );
    const state = await pool.query<{ player_id: string; total_earned: number; total_spent: number; revision: string }>(
      `SELECT player_id,total_earned,total_spent,revision::text FROM player_skill_point_state
       WHERE player_id = ANY($1::text[])`,
      [players]
    );
    const operations = await pool.query<{ operation_key: string }>(
      `SELECT operation_key FROM skill_point_operations
       WHERE player_id = ANY($1::text[]) AND action = 'rank_cost_refund' ORDER BY operation_key`,
      [players]
    );
    return {
      ranks: Object.fromEntries(ranks.rows.map((row) =>
        [`${row.player_id}/${row.skill_id}`, [row.rank, row.points_spent, Number(row.revision)]])),
      state: Object.fromEntries(state.rows.map((row) =>
        [row.player_id, [row.total_earned, row.total_spent, Number(row.revision)]])),
      operations: operations.rows.map((row) => row.operation_key)
    };
  }
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must be a PostgreSQL URL");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Rank 3 refund migration test requires a loopback admin database");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("Rank 3 refund migration test requires a disposable ash_atlas_stability admin database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
