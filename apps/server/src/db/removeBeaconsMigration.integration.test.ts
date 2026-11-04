import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const targetMigration = "0814_remove_beacons.sql";

describeDatabase("beacon retirement migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_remove_beacons_${suffix}`;
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const playerId = randomUUID();
  const databaseUrl = new URL(adminUrl ?? "postgres://localhost");
  let precedingMigrations = "";
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    databaseUrl.pathname = `/${databaseName}`;
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-remove-beacons-"));
    for (const name of (await readdir(migrations))
      .filter((name) =>
        name.endsWith(".sql") &&
        name < targetMigration &&
        name !== "0813_remove_beacons.sql"
      )
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl.toString(), { migrationsDirectory: precedingMigrations });
    pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 2 });
    await seedLegacyBeaconState();
    await copyFile(path.join(migrations, targetMigration), path.join(precedingMigrations, targetMigration));
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin?.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("removes populated beacon state, preserves non-beacon preferences, and is repeatable", async () => {
    await expect(runMigrations(databaseUrl.toString(), { migrationsDirectory: precedingMigrations }))
      .resolves.toEqual([targetMigration]);

    await expect(pool.query<{ world_beacons: string | null; discovered: string | null; assignments: string | null }>(
      `SELECT to_regclass('world_beacons') AS world_beacons,
              to_regclass('player_discovered_beacons') AS discovered,
              to_regclass('beacon_spawn_assignments') AS assignments`
    )).resolves.toMatchObject({ rows: [{ world_beacons: null, discovered: null, assignments: null }] });
    await expect(pool.query(
      `SELECT 1 FROM pg_attribute
       WHERE attrelid = 'players'::regclass AND attname = 'home_beacon_id' AND NOT attisdropped`
    )).resolves.toMatchObject({ rows: [] });
    await expect(pool.query(
      `SELECT destination_kind,destination_id::text,visible
       FROM player_world_map_destination_preferences WHERE player_id=$1
       ORDER BY destination_kind`, [playerId]
    )).resolves.toMatchObject({ rows: [{ destination_kind: "city", destination_id: "00000000-0000-4000-8000-000000000001", visible: true }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM pg_trigger
       WHERE tgname LIKE '%beacon%' AND NOT tgisinternal`
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(runMigrations(databaseUrl.toString(), { migrationsDirectory: precedingMigrations }))
      .resolves.toEqual([]);
  }, 90_000);

  async function seedLegacyBeaconState(): Promise<void> {
    await pool.query(
      `INSERT INTO players (
         id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom, home_beacon_id
       ) VALUES ($1,'BeaconLegacy','#3366cc','NM',35,-106,35,-106,900,false,
                 ST_SetSRID(ST_MakePoint(-106,35),4326),'NA-1')`, [playerId]
    );
    await pool.query(
      `INSERT INTO player_discovered_beacons (player_id, beacon_id)
       VALUES ($1,'NA-1')`, [playerId]
    );
    await pool.query(
      `INSERT INTO beacon_spawn_assignments (
         player_id, beacon_id, slot_index, slot_generation, lat, lon, geom, algorithm_version
       ) VALUES ($1,'NA-1',0,0,35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326),'beacon-spawn:v1')`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO player_world_map_destination_preferences
         (player_id,destination_kind,destination_id,visible)
       VALUES
         ($1,'beacon','NA-1',false),
         ($1,'city','00000000-0000-4000-8000-000000000001',true)`, [playerId]
    );
  }
});

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error(`unsafe disposable database name ${value}`);
  }
  return `"${value}"`;
}
