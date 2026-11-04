import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateItemDefinitionCatalog } from "../game/items.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1213_biome_roster_meat_cuts.sql";

describeDatabase("biome roster meat cut migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_biome_roster_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-biome-roster-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-biome-roster-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name < TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
      } else if (name === TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
      }
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    // Populate the pre-upgrade database with a player holding an existing resource.
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,lat,lon,
         anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ('br-player',$1,'br-player','br-player','GLOBAL',40,-105,40,-105,100,true,ST_SetSRID(ST_MakePoint(-105,40),4326))`,
      [accountId]
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades a populated database, matches the startup catalog, and is empty on a second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([TARGET_MIGRATION]);
    await expect(pool!.query("SELECT item_id FROM item_definitions WHERE item_id = ANY($1::text[]) AND stackable AND max_stack = 250 AND market_tradable AND unit_weight_grams = 250 AND rarity = 'common' ORDER BY item_id", [["field_hare_cut","arctic_hare_cut","capybara_cut","armadillo_cut","red_fox_cut","wolverine_cut","ostrich_cut","golden_eagle_cut","musk_ox_cut","seal_cut"]]))
      .resolves.toMatchObject({ rowCount: 10 });
    await expect(pool!.query("SELECT count(*)::int AS count FROM players WHERE id='br-player'"))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([]);
    // The startup catalog also holds items from later migrations; apply the rest before comparing.
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql") && candidate > TARGET_MIGRATION)) {
      await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
    }
    await runMigrations(databaseUrl, { migrationsDirectory: targetDirectory });
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();
  }, 300_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Biome roster migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
