import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { validateItemDefinitionCatalog } from "../game/items.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "1015_giving_tree_saplings.sql";
const forestMigration = "1018_giving_tree_sapling_forest.sql";
const PLAYER_ID = "20000000-0000-4000-8000-000000000976";

describeDatabase("Giving Tree sapling migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const databases: string[] = [];
  let precedingMigrations = "";

  beforeAll(async () => {
    assertDisposableDatabase(adminUrl!);
    await admin.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN; END IF; END $$"
    );
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-giving-saplings-"));
    for (const name of await readdir(sourceMigrations)) {
      if (!name.endsWith(".sql") || name >= migration) continue;
      await copyFile(path.join(sourceMigrations, name), path.join(precedingMigrations, name));
    }
  }, 60_000);

  afterAll(async () => {
    for (const database of databases.reverse()) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
    }
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("upgrades a populated database, keeps unrelated rows, and reruns empty", async () => {
    const url = await createDatabase("populated");
    await runMigrations(url, { migrationsDirectory: precedingMigrations });
    const pool = new DisposableTestPool({ connectionString: url, max: 2 });
    try {
      await pool.query(
        `INSERT INTO players (
           id, username, region_code, lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
         ) VALUES ($1, 'SaplingKeeper', 'GLOBAL', 35, -106, 35, -106, 100, false, ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
        [PLAYER_ID]
      );
      await pool.query(
        "INSERT INTO player_inventory (player_id, resource_type, variant, quantity) VALUES ($1, 'giving_berry', 'default', 0)",
        [PLAYER_ID]
      );
      const unrelatedBefore = await unrelatedItemDefinitions(pool);
      await expect(pool.query("SELECT to_regclass('public.player_saplings')::text AS name")).resolves.toMatchObject({
        rows: [{ name: null }]
      });

      await copyFile(path.join(sourceMigrations, migration), path.join(precedingMigrations, migration));
      await expect(runMigrations(url, { migrationsDirectory: precedingMigrations })).resolves.toEqual([migration]);

      await expect(itemDefinition(pool)).resolves.toEqual({
        item_id: "giving_tree_sapling",
        display_name: "Giving Tree Sapling",
        max_stack: 25,
        market_tradable: true
      });
      await expect(unrelatedItemDefinitions(pool)).resolves.toEqual(unrelatedBefore);
      await expect(pool.query(
        "SELECT resource_type, quantity::integer AS quantity FROM player_inventory WHERE player_id = $1",
        [PLAYER_ID]
      )).resolves.toMatchObject({ rows: [{ resource_type: "giving_berry", quantity: 0 }] });

      // The table accepts a live sapling and refuses states the lifecycle cannot reach.
      await pool.query(
        `INSERT INTO player_saplings (owner_player_id, request_id, region_code, lat, lon, death_at, mature_at)
         VALUES ($1, 'r1', 'GLOBAL', 35, -106, now() + interval '2 days', now() + interval '5 days')`,
        [PLAYER_ID]
      );
      await expect(pool.query(
        `INSERT INTO player_saplings (owner_player_id, request_id, region_code, lat, lon, status, death_at, mature_at)
         VALUES ($1, 'r2', 'GLOBAL', 35, -106, 'grown', now(), now())`,
        [PLAYER_ID]
      )).rejects.toThrow();
      await expect(pool.query(
        `INSERT INTO player_saplings (owner_player_id, request_id, region_code, lat, lon, death_at, mature_at)
         VALUES ($1, 'r1', 'GLOBAL', 35, -106, now(), now())`,
        [PLAYER_ID]
      )).rejects.toThrow();

      // 1018 upgrades the populated table: due_at backfills, the revision starts at 0, chopped is allowed.
      await pool.query(
        `INSERT INTO player_saplings (owner_player_id, request_id, region_code, lat, lon, planted_at, last_tended_at, death_at, mature_at)
         VALUES ($1, 'r3', 'GLOBAL', 35.1, -106, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z', '2026-10-06T00:00:00Z')`,
        [PLAYER_ID]
      );
      await copyFile(path.join(sourceMigrations, forestMigration), path.join(precedingMigrations, forestMigration));
      await expect(runMigrations(url, { migrationsDirectory: precedingMigrations })).resolves.toEqual([forestMigration]);
      const backfilled = await pool.query<{ request_id: string; due_at: Date; state_revision: string }>(
        "SELECT request_id, due_at, state_revision::text FROM player_saplings WHERE request_id = 'r3'"
      );
      expect(backfilled.rows[0]!.due_at.toISOString()).toBe("2026-10-02T00:00:00.000Z");
      expect(backfilled.rows[0]!.state_revision).toBe("0");
      await pool.query("UPDATE player_saplings SET status = 'chopped', chopped_at = now() WHERE request_id = 'r3'");
      await expect(pool.query("UPDATE player_saplings SET status = 'chopped', chopped_at = NULL WHERE request_id = 'r1'")).rejects.toThrow();
      await expect(pool.query("UPDATE player_saplings SET status = 'felled' WHERE request_id = 'r1'")).rejects.toThrow();

      // Other features' later migrations (e.g. 1016) may still be pending; apply them
      // before checking the full code catalog, then a second run must be empty.
      await runMigrations(url);
      await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
      await expect(runMigrations(url)).resolves.toEqual([]);
    } finally {
      await pool.end();
    }
  }, 180_000);

  it("creates the table and item on a fresh database and reruns empty", async () => {
    const url = await createDatabase("fresh");
    await expect(runMigrations(url)).resolves.toEqual(expect.arrayContaining([migration, forestMigration]));
    const pool = new DisposableTestPool({ connectionString: url, max: 1 });
    try {
      await expect(itemDefinition(pool)).resolves.toMatchObject({ item_id: "giving_tree_sapling" });
      await expect(pool.query("SELECT to_regclass('public.player_saplings')::text AS name")).resolves.toMatchObject({
        rows: [{ name: "player_saplings" }]
      });
      await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
      await expect(runMigrations(url)).resolves.toEqual([]);
    } finally {
      await pool.end();
    }
  }, 180_000);

  async function createDatabase(suffix: string): Promise<string> {
    const parsed = new URL(adminUrl!);
    const database = `ash_atlas_stability_giving_saplings_${suffix}`;
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    databases.push(database);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  }
});

async function itemDefinition(pool: pg.Pool): Promise<unknown> {
  const result = await pool.query(
    "SELECT item_id, display_name, max_stack, market_tradable FROM item_definitions WHERE item_id = 'giving_tree_sapling'"
  );
  return result.rows[0];
}

async function unrelatedItemDefinitions(pool: pg.Pool): Promise<unknown[]> {
  const result = await pool.query(
    "SELECT * FROM item_definitions WHERE item_id <> 'giving_tree_sapling' ORDER BY item_id"
  );
  return result.rows;
}

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !["postgres:", "postgresql:"].includes(parsed.protocol)
    || parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error("Giving Tree sapling migration verification requires the local ash_atlas_stability database");
  }
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
