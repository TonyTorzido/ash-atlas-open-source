import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migrationName = "0874_greenhouse_crop_id_and_generic_commodities.sql";
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../db/migrations",
  migrationName
);

describeDatabase("greenhouse crop ID migration", () => {
  const databaseName = `ash_atlas_stability_greenhouse_crop_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let migrationDirectory = "";
  let databaseUrl = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertStabilityLabAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-greenhouse-crop-migration-"));
    await copyFile(migrationPath, path.join(migrationDirectory, migrationName));
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await pool.query(`
      CREATE TABLE greenhouse_plants (
        greenhouse_id uuid NOT NULL,
        anchor_id text NOT NULL,
        stage integer NOT NULL,
        planted_at timestamptz NOT NULL,
        dry boolean NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (greenhouse_id, anchor_id)
      )
    `);
    await pool.query(`
      CREATE TABLE item_definitions (
        item_id text PRIMARY KEY,
        display_name text NOT NULL,
        category text NOT NULL,
        rarity text NOT NULL,
        stackable boolean NOT NULL,
        max_stack integer NOT NULL,
        droppable boolean NOT NULL,
        manor_storable boolean NOT NULL,
        market_tradable boolean NOT NULL,
        market_fungible boolean NOT NULL,
        market_identity text,
        supported_variants text[] NOT NULL,
        unit_weight_grams integer NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("backfills existing plants and returns no work on the second migration run", async () => {
    const greenhouseId = randomUUID();
    const plantedAt = "2026-01-02T03:04:05.000Z";
    await pool!.query(
      `INSERT INTO greenhouse_plants (greenhouse_id,anchor_id,stage,planted_at,dry)
       VALUES ($1,'greenhouse-main-anchor:greenhouse_main_room:0:0',3,$2,true)`,
      [greenhouseId, plantedAt]
    );

    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([migrationName]);
    await expect(pool!.query(
      `SELECT crop_id,stage,planted_at,dry
       FROM greenhouse_plants
       WHERE greenhouse_id=$1`,
      [greenhouseId]
    )).resolves.toMatchObject({
      rows: [{ crop_id: "wheat", stage: 3, planted_at: new Date(plantedAt), dry: true }]
    });
    await expect(pool!.query(
      `SELECT item_id,supported_variants,unit_weight_grams
       FROM item_definitions
       ORDER BY item_id`
    )).resolves.toMatchObject({
      rows: [
        { item_id: "produce", supported_variants: ["default"], unit_weight_grams: 250 },
        { item_id: "seed", supported_variants: ["default"], unit_weight_grams: 1 }
      ]
    });
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([]);
  });
});

function assertStabilityLabAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!(["127.0.0.1", "localhost"].includes(parsed.hostname)) ||
    !(["postgres:", "postgresql:"].includes(parsed.protocol)) ||
    !database.startsWith("ash_atlas_stability")) {
    throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must target a local ash_atlas_stability disposable database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
