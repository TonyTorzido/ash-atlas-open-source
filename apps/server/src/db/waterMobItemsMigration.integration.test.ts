import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INVENTORY_CATALOG } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateItemDefinitionCatalog } from "../game/items.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1052_water_mob_items.sql";
const NEW_ITEMS = ["shellback_plate", "abyssal_orb"] as const;

describeDatabase("Water mob item migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_water_mobs_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const playerId = `water-mobs-${randomUUID()}`;
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-water-mobs-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-water-mobs-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name !== TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
      }
      await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    // A populated database: an existing player and the full live item catalog.
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Water mobs fixture','world-test',35,-106,35,-106,
         900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId]
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades a populated database, matches the startup catalog, and is empty on a second run", async () => {
    await expect(validateItemDefinitionCatalog(pool!)).rejects.toThrow();
    const countBefore = await itemCount();
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    // The server refuses to boot on any catalog mismatch; the migrated rows must match exactly.
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();
    const rows = await pool!.query<{ item_id: string; market_tradable: boolean }>(
      `SELECT item_id,market_tradable FROM item_definitions WHERE item_id = ANY($1::text[])`,
      [[...NEW_ITEMS]]
    );
    expect(rows.rows.map((row) => row.item_id).sort()).toEqual([...NEW_ITEMS].sort());
    for (const row of rows.rows) expect(row.market_tradable, row.item_id).toBe(true);
    expect(INVENTORY_CATALOG.shellback_plate?.inventoryGroup).toBe("scales");
    expect(INVENTORY_CATALOG.abyssal_orb?.inventoryGroup).toBe("essences");

    // Only the two rows were added; existing rows and players are untouched.
    expect(await itemCount()).toBe(countBefore + NEW_ITEMS.length);
    await expect(pool!.query(`SELECT 1 FROM players WHERE id = $1`, [playerId]))
      .resolves.toMatchObject({ rowCount: 1 });

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([]);
    expect(await itemCount()).toBe(countBefore + NEW_ITEMS.length);
  }, 120_000);

  async function itemCount(): Promise<number> {
    const result = await pool!.query<{ count: string }>(`SELECT count(*)::text AS count FROM item_definitions`);
    return Number(result.rows[0]!.count);
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Water mob item migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
