import { randomUUID } from "node:crypto";
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
const migrations = [
  "0965_edict_seal_item_definition.sql",
  "0966_fallen_prison_crash_event.sql"
];

describeDatabase("Fallen Prison migrations 0965-0966", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_fallen_prison_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseUrl = "";
  let directory = "";

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      parsed.pathname.slice(1) !== "ash_atlas_stability") {
      throw new Error("Fallen Prison migration verification requires ash_atlas_stability");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-fallen-prison-"));
    for (const name of await readdir(sourceMigrations)) {
      if (name.endsWith(".sql") && name < migrations[0]!) {
        await copyFile(path.join(sourceMigrations, name), path.join(directory, name));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: directory });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("upgrades populated data, is a no-op on the second run, and keeps the item catalog valid", async () => {
    await pool.query(
      `INSERT INTO developer_spawned_dungeon_entrances (
         entrance_id, request_id, template_id, template_revision, template_portal_revision,
         dungeon_revision, catalog_revision, region_code, spawn_lat, spawn_lon
       ) VALUES ('entrance-before', 'req-1', 'tpl', 'r1', 'r1', 'r1', 1, 'NM', 35, -106)`
    );
    for (const name of migrations) {
      await copyFile(path.join(sourceMigrations, name), path.join(directory, name));
    }
    await expect(runMigrations(databaseUrl, { migrationsDirectory: directory })).resolves.toEqual(migrations);
    await expect(pool.query(
      "SELECT expires_at, event_kind FROM developer_spawned_dungeon_entrances WHERE entrance_id='entrance-before'"
    )).resolves.toMatchObject({ rows: [{ expires_at: null, event_kind: null }] });
    await expect(pool.query(
      "SELECT item_id FROM item_definitions WHERE item_id IN ('edict_seal','prison_key_fragment') ORDER BY item_id"
    )).resolves.toMatchObject({ rows: [{ item_id: "prison_key_fragment" }, { item_id: "edict_seal" }] });
    await expect(pool.query("SELECT count(*)::int AS n FROM fallen_prison_trail_claims"))
      .resolves.toMatchObject({ rows: [{ n: 0 }] });
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    await expect(runMigrations(databaseUrl, { migrationsDirectory: directory })).resolves.toEqual([]);
  }, 120_000);
});
