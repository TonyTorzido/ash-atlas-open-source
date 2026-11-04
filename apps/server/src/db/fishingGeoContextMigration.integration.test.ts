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
const TARGET_MIGRATION = "0845_fishing_geo_context.sql";
const PRESENTATION_BACKFILL_MIGRATION = "0846_fishing_geo_presentation_backfill.sql";

describeDatabase("fishing geographic provenance migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_fishing_geo_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const playerId = `fishing-geo-migration-${randomUUID()}`;
  const hutId = randomUUID();
  const encounterId = randomUUID();
  const catchId = randomUUID();
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: DisposableTestPool | undefined;
  let databaseCreated = false;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-fishing-geo-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedRetainedFishingRows();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  }, 30_000);

  it("backfills retained context, preserves the catch point, and reruns empty", async () => {
    const applied = await runMigrations(databaseUrl);
    expect(applied).toEqual(expect.arrayContaining([TARGET_MIGRATION, PRESENTATION_BACKFILL_MIGRATION]));
    const first = await pool!.query(`
      SELECT e.canonical_waterbody_id AS encounter_waterbody,
             e.gameplay_water_type AS encounter_type,
             e.admin1_name AS encounter_admin1,
             c.canonical_waterbody_id AS catch_waterbody,
             c.catch_lat,
             c.catch_lon,
             c.caught_at,
             c.presentation_relation
      FROM fishing_encounters e
      JOIN fishing_catch_records c ON c.encounter_id = e.encounter_id
      WHERE e.encounter_id = $1`, [encounterId]);
    expect(first.rows).toMatchObject([{
      encounter_waterbody: "migration-rio-grande",
      encounter_type: "river",
      encounter_admin1: "New Mexico",
      catch_waterbody: "migration-rio-grande",
      catch_lat: 35,
      catch_lon: -106,
      presentation_relation: "exact"
    }]);
    expect(first.rows[0]?.caught_at).not.toBeNull();
    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='fishing_catch_records'
         AND column_name = ANY($1::text[]) ORDER BY column_name`,
      [["canonical_waterbody_id", "gameplay_water_type", "admin1_id", "country_id", "catch_lat", "catch_lon", "caught_at"]]
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "admin1_id", "canonical_waterbody_id", "catch_lat", "catch_lon", "caught_at", "country_id", "gameplay_water_type"
    ]);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
    await expect(pool!.query(
      `SELECT canonical_waterbody_id, catch_lat, catch_lon, caught_at
       FROM fishing_catch_records WHERE catch_id=$1`, [catchId]
    )).resolves.toMatchObject({ rows: [{ canonical_waterbody_id: "migration-rio-grande", catch_lat: 35, catch_lon: -106 }] });
  }, 120_000);

  async function seedRetainedFishingRows(): Promise<void> {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO players (
           id, username, username_normalized, display_color, region_code,
           lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
         ) VALUES ($1, 'Fishing geo fixture', 'fishing geo fixture', '#38bdf8',
                   'NM', 35, -106, 35, -106, 900, false,
                   ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
        [playerId]
      );
      await client.query(
        `INSERT INTO player_fishing_huts (
           fishing_hut_id, owner_player_id, world_id, region_code, lat, lon, geom,
           waterbody_kind, waterbody_source_id, waterbody_name, waterbody_distance_m,
           world_source_revision, built_at
         ) VALUES ($1, $2, 'migration-world', 'NM', 35, -106,
                   ST_SetSRID(ST_MakePoint(-106, 35), 4326), 'river',
                   'migration-rio-grande', 'Rio Grande', 0, 'migration-r1', clock_timestamp())`,
        [hutId, playerId]
      );
      await client.query(
        `INSERT INTO fishing_encounters (
           encounter_id, player_id, fishing_hut_id, waterbody_kind, waterbody_source_id,
           waterbody_name, phase, behavior_profile, seed, difficulty, bite_at,
           reconnect_deadline_at, region_name, country_name, cast_lat, cast_lon
         ) VALUES ($1, $2, $3, 'river', 'migration-rio-grande', 'Rio Grande', 'landed',
                   'runner', 17, .35, clock_timestamp(), clock_timestamp() + interval '1 hour',
                   'New Mexico', 'United States', 35, -106)`,
        [encounterId, playerId, hutId]
      );
      await client.query(
        `INSERT INTO fishing_catch_records (
           catch_id, encounter_id, player_id, fishing_hut_id, waterbody_kind,
           waterbody_source_id, waterbody_name, fish_item_id, ashen, behavior_profile,
           difficulty, length_in, weight_lb, score, perfect, duration_ms, week_start,
           region_name, country_name, cast_lat, cast_lon, created_at
         ) VALUES ($1, $2, $3, $4, 'river', 'migration-rio-grande', 'Rio Grande',
                   'freshwater_fish', false, 'runner', .35, 20, 4, 100, false, 1000,
                   CURRENT_DATE, 'New Mexico', 'United States', 35, -106,
                   '2026-09-14T12:00:00Z')`,
        [catchId, encounterId, playerId, hutId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !database.startsWith("ash_atlas_stability")
  ) throw new Error("Fishing geo migration test requires a local stability database");
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) throw new Error("Unsafe stability database name");
  return `"${value}"`;
}
