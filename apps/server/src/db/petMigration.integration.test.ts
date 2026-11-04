import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.PET_MIGRATION_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const PET_MIGRATION = "0647_menu_pet_raising.sql";
const PET_MIGRATIONS = [
  PET_MIGRATION,
  "0648_resonance_chamber_echoes.sql",
  "0649_echo_expeditions.sql",
  "0650_pet_expedition_hardening.sql",
  "0674_account_bound_dogs.sql"
];

describeDatabase("pet raising populated migration", () => {
  const databaseName = `ash_atlas_stability_pet_migration_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const playerId = `pet-migration-${randomUUID()}`;
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-pet-migrations-"));
    for (const name of (await readdir(repoMigrations))
      .filter((name) => name.endsWith(".sql") && name < PET_MIGRATION)
      .sort()) {
      await copyFile(path.join(repoMigrations, name), path.join(precedingMigrations, name));
    }

    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await pool.query(
      `INSERT INTO players (
         id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES (
         $1, $2, 'GLOBAL', 35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326)
       )`,
      [playerId, `pet-migration-${randomUUID().slice(0, 8)}`]
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("preserves populated player data, adds replacement dog constraints, and has an empty second run", async () => {
    const applied = await runMigrations(databaseUrl);
    expect(applied[0]).toBe(PET_MIGRATION);
    expect(applied).toEqual(expect.arrayContaining(PET_MIGRATIONS));

    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int FROM players WHERE id = $1) AS players,
         to_regclass('public.player_pets')::text AS player_pets,
         to_regclass('public.pet_daily_care')::text AS pet_daily_care,
         to_regclass('public.pet_milestones')::text AS pet_milestones,
         to_regclass('public.account_dogs')::text AS account_dogs,
         to_regclass('public.dog_daily_care')::text AS dog_daily_care,
         to_regclass('public.dog_explore_destinations')::text AS dog_explore_destinations`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [{
        players: 1,
        player_pets: "player_pets",
        pet_daily_care: "pet_daily_care",
        pet_milestones: "pet_milestones",
        account_dogs: "account_dogs",
        dog_daily_care: "dog_daily_care",
        dog_explore_destinations: "dog_explore_destinations"
      }]
    });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 60_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !database.startsWith("ash_atlas_stability")
  ) {
    throw new Error("PET_MIGRATION_TEST_ADMIN_URL must target a local disposable ash_atlas_stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
