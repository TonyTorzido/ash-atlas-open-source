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
const TARGET_MIGRATION = "1152_kingdom_perks_levels_seven_eight.sql";

describeDatabase("kingdom perk levels 7-8 populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_kingdom_perks78_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let migrationDirectory = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  const leader = `kp78-${suffix}`;
  const kingdomId = randomUUID();

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-kingdom-perks78-"));
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION).sort()) {
      await copyFile(path.join(migrations, name), path.join(migrationDirectory, name));
    }
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter')
       THEN CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN; END IF; END $$`
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });

    const accountId = randomUUID();
    await pool.query(`INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')`, [accountId]);
    await pool.query(
      `INSERT INTO players (id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
       VALUES ($1,$2,$1,$1,'#38bdf8','GLOBAL',35,-106,35,-106,650,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [leader, accountId]
    );
    await pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id,
         founding_request_id, level, current_xp, lifetime_xp)
       VALUES ($1,$2,$2,$3,$3,$4,8,900000,900000)`,
      [kingdomId, `kp78 ${suffix}`, leader, `found-${kingdomId}`]
    );
    // Existing state the migration must keep: a level 2 and a level 6 choice and a perk ledger row.
    await pool.query(
      `INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id)
       VALUES ($1,2,'boundary_writ'), ($1,6,'breach_company')`,
      [kingdomId]
    );
    await pool.query(
      `INSERT INTO kingdom_treasury_ledger (id, kingdom_id, actor_player_id, resource_type, direction, quantity,
         balance_before, balance_after, source_type, operation_key)
       VALUES ($1,$2,$3,'bricks','debit',20000,20000,0,'kingdom_perk_choose','pre-1152')`,
      [randomUUID(), kingdomId, leader]
    );
    // Before 1152 a level 7 perk is refused.
    await expect(pool.query(
      "INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id) VALUES ($1,7,'arcane_reavers')",
      [kingdomId]
    )).rejects.toMatchObject({ code: "23514" });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  }, 60_000);

  it("accepts level 7-8 perks and perk payouts, keeps existing rows, and is a no-op when replayed", async () => {
    await copyFile(path.join(migrations, TARGET_MIGRATION), path.join(migrationDirectory, TARGET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory })).resolves.toEqual([TARGET_MIGRATION]);
    const before = await snapshot();
    expect(before).toEqual({
      selections: [[2, "boundary_writ"], [6, "breach_company"]],
      ledger: [["kingdom_perk_choose", "pre-1152"]]
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id)
         VALUES ($1,7,'arcane_reavers'), ($1,8,'prism_holdings')`,
        [kingdomId]
      );
      await client.query(
        `INSERT INTO kingdom_treasury_ledger (id, kingdom_id, actor_player_id, resource_type, direction, quantity,
           balance_before, balance_after, source_type, operation_key)
         VALUES ($1,$2,$3,'crystal','credit',1500,0,1500,'kingdom_perk_payout','probe')`,
        [randomUUID(), kingdomId, leader]
      );
      // Still refused: a perk on the wrong level, and anything on level 9.
      for (const [level, perkId] of [[8, "arcane_reavers"], [9, "treacherous_ground"]] as const) {
        await client.query("SAVEPOINT probe");
        await expect(client.query(
          "INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id) VALUES ($1,$2,$3)",
          [kingdomId, level, perkId]
        )).rejects.toMatchObject({ code: "23514" });
        await client.query("ROLLBACK TO SAVEPOINT probe");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    // Empty second run, and replaying the SQL changes nothing.
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory })).resolves.toEqual([]);
    await pool.query(await readFile(path.join(migrations, TARGET_MIGRATION), "utf8"));
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  async function snapshot() {
    const selections = await pool.query<{ perk_level: number; perk_id: string }>(
      "SELECT perk_level, perk_id FROM kingdom_perk_selections WHERE kingdom_id = $1 ORDER BY perk_level",
      [kingdomId]
    );
    const ledger = await pool.query<{ source_type: string; operation_key: string }>(
      "SELECT source_type, operation_key FROM kingdom_treasury_ledger WHERE kingdom_id = $1 ORDER BY operation_key",
      [kingdomId]
    );
    return {
      selections: selections.rows.map((row) => [row.perk_level, row.perk_id]),
      ledger: ledger.rows.map((row) => [row.source_type, row.operation_key])
    };
  }
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must be a PostgreSQL URL");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Kingdom perk levels 7-8 migration test requires a loopback admin database");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("Kingdom perk levels 7-8 migration test requires a disposable ash_atlas_stability admin database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
