import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0822_military_units_war_camp.sql";

describeDatabase("military units populated corrective migration", () => {
  const databaseName = `ash_atlas_stability_military_units_${randomUUID().replaceAll("-", "")}`;
  const accountId = randomUUID();
  const playerId = `military-migration-${randomUUID()}`;
  const availablePersonnelId = randomUUID();
  const trainingPersonnelId = randomUUID();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: DisposableTestPool;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!parsed.pathname.includes("ash_atlas_stability")) {
      throw new Error("Migration test requires an ash_atlas_stability admin database");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
          CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_writer') THEN
          CREATE ROLE ash_atlas_telemetry_writer NOLOGIN;
        END IF;
      END $$
    `);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-military-units-migration-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    await seedFixture();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("refunds retained Siege Crew value, releases training capacity, and reruns empty", async () => {
    await copyFile(path.join(migrations, TARGET_MIGRATION), path.join(precedingMigrations, TARGET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations }))
      .resolves.toEqual([TARGET_MIGRATION]);

    await expect(pool.query<{ personnel_id: string }>(
      "SELECT personnel_id::text FROM military_personnel WHERE owner_player_id=$1",
      [playerId]
    )).resolves.toMatchObject({ rows: [] });
    await expect(pool.query<{ status: string; count: number }>(
      `SELECT status,count(*)::int AS count
       FROM military_siege_crew_retirements
       WHERE player_id=$1
       GROUP BY status
       ORDER BY status`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ status: "refunded", count: 2 }] });
    await expect(pool.query<{ reserved_capacity: number }>(
      "SELECT reserved_capacity FROM player_lodges WHERE owner_player_id=$1 AND removed_at IS NULL",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ reserved_capacity: 2 }] });
    await expect(pool.query<{ quantity: string; version: string }>(
      `SELECT resource_type,quantity::text,version::text
       FROM player_inventory
       WHERE player_id=$1 AND resource_type IN ('simple_food','cloth','leather')
       ORDER BY resource_type`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [
        { resource_type: "cloth", quantity: "7", version: "3" },
        { resource_type: "leather", quantity: "8", version: "3" },
        { resource_type: "simple_food", quantity: "16", version: "3" }
      ]
    });
    await expect(pool.query<{ gold_balance: string; version: string }>(
      "SELECT gold_balance::text,version::text FROM player_wallets WHERE player_id=$1",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ gold_balance: "700", version: "3" }] });
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM military_units WHERE owner_player_id=$1",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })).resolves.toEqual([]);
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM military_siege_crew_retirements WHERE player_id=$1",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(pool.query<{ quantity: string; version: string }>(
      `SELECT quantity::text,version::text
       FROM player_inventory
       WHERE player_id=$1 AND resource_type='simple_food'`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ quantity: "16", version: "3" }] });
    await expect(pool.query<{ gold_balance: string; version: string }>(
      "SELECT gold_balance::text,version::text FROM player_wallets WHERE player_id=$1",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ gold_balance: "700", version: "3" }] });
  }, 120_000);

  async function seedFixture(): Promise<void> {
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,'military-migration-fixture','military-migration-fixture','#38bdf8','NM',
         35,-106,35,-106,900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId]
    );
    const lodgeId = randomUUID();
    await pool.query(
      `INSERT INTO player_lodges (
         lodge_id,owner_player_id,world_id,region_code,lat,lon,geom,footprint_geom,
         footprint_radius_m,level,reserved_capacity,placement_revision
       ) VALUES ($1,$2,'main','NM',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint(-106,35),4326)::geography,8)::geometry,
         8,1,4,1)`,
      [lodgeId, playerId]
    );
    const assets = await pool.connect();
    try {
      await assets.query("BEGIN");
      await assets.query(
        `INSERT INTO player_inventory (player_id,resource_type,variant,quantity,version)
         VALUES ($1,'simple_food','default',10,1),($1,'cloth','default',3,1),($1,'leather','default',4,1)`,
        [playerId]
      );
      await assets.query(
        `INSERT INTO inventory_operations (operation_key,player_id,source,metadata)
         VALUES ($1,$2,'military_migration_fixture','{}'::jsonb)`,
        [`military-migration-inventory:${playerId}`, playerId]
      );
      await assets.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,metadata
         ) VALUES
           ($1,$2,'simple_food','default',10,10,1,'military_migration_fixture','{}'::jsonb),
           ($1,$2,'cloth','default',3,3,1,'military_migration_fixture','{}'::jsonb),
           ($1,$2,'leather','default',4,4,1,'military_migration_fixture','{}'::jsonb)`,
        [`military-migration-inventory:${playerId}`, playerId]
      );
      await assets.query(
        `INSERT INTO player_wallets (player_id,account_id,gold_balance,version)
         VALUES ($1,$2,500,1)`,
        [playerId, accountId]
      );
      await assets.query(
        `INSERT INTO wallet_events (
           operation_key,player_id,account_id,delta_gold,balance_after,version_after,reason
         ) VALUES ($1,$2,$3,500,500,1,'military_migration_fixture')`,
        [`military-migration-wallet:${playerId}`, playerId, accountId]
      );
      await assets.query("COMMIT");
    } catch (error) {
      await assets.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      assets.release();
    }
    await pool.query(
      `INSERT INTO military_personnel (personnel_id,owner_player_id,personnel_type,capacity_cost,status,training_job_id)
       VALUES ($1,$3,'siege_crew',2,'available',NULL),($2,$3,'siege_crew',2,'training',NULL)`,
      [availablePersonnelId, trainingPersonnelId, playerId]
    );
  }
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
