import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0804_creature_book_ashen_sightings.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;

(adminUrl ? describe : describe.skip)("Creature Book Ashen sightings migration", () => {
  const migrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_ashen_book_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: pg.Pool;
  const playerId = `ashen-book-${randomUUID()}`;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-ashen-book-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-ashen-book-"));
    for (const name of await readdir(migrations)) {
      if (!name.endsWith(".sql")) continue;
      if (name.localeCompare(TARGET_MIGRATION) < 0) {
        await copyFile(path.join(migrations, name), path.join(precedingDirectory, name));
        await copyFile(path.join(migrations, name), path.join(targetDirectory, name));
      } else if (name === TARGET_MIGRATION) {
        await copyFile(path.join(migrations, name), path.join(targetDirectory, name));
      }
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    const accountId = randomUUID();
    const username = `ashenbook${randomUUID().slice(0, 8)}`;
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$3,$3,'#38bdf8','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId, username]
    );
    await pool.query(
      `INSERT INTO creature_book_sightings (player_id,mob_archetype,first_source_entity_id)
       VALUES ($1,'deer','existing-normal-deer')`,
      [playerId]
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  });

  it("upgrades populated data, enforces the roster, and reruns empty", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);
    await expect(pool.query(
      "SELECT first_source_entity_id FROM creature_book_sightings WHERE player_id=$1 AND mob_archetype='deer'",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ first_source_entity_id: "existing-normal-deer" }] });
    await pool.query(
      `INSERT INTO creature_book_ashen_sightings (player_id,mob_archetype,first_source_entity_id)
       VALUES ($1,'deer','ashen-deer-1') ON CONFLICT DO NOTHING`,
      [playerId]
    );
    await expect(pool.query(
      `INSERT INTO creature_book_ashen_sightings (player_id,mob_archetype,first_source_entity_id)
       VALUES ($1,'goblin','invalid')`,
      [playerId]
    )).rejects.toThrow();
    await expect(pool.query(
      "SELECT mob_archetype,first_source_entity_id FROM creature_book_ashen_sightings WHERE player_id=$1",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ mob_archetype: "deer", first_source_entity_id: "ashen-deer-1" }] });
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([]);
  }, 120_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || parsed.port === "35432"
    || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) throw new Error("Ashen Creature Book migration verification requires a disposable local database");
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) throw new Error("Unsafe disposable database name");
  return `"${value}"`;
}
