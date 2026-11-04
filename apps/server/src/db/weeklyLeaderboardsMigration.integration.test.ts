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
const TARGET_MIGRATION = "0707_weekly_leaderboards.sql";

describeDatabase("weekly leaderboard migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_weekly_leaderboards_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-weekly-leaderboards-")
    );
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("preserves populated gameplay data, starts without backfill, and reruns empty", async () => {
    await createPlayer(pool, "legacy-player");
    const legacyFlag = await createFlag(pool, "legacy-player", 35);
    await pool.query(
      `INSERT INTO flag_build_operations (
         operation_key,player_id,request_id,flag_id,created_at
       ) VALUES ('legacy-build','legacy-player','legacy-request',$1,'2026-07-14T12:00:00Z')`,
      [legacyFlag]
    );

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);
    await expect(pool.query(
      "SELECT operation_key FROM flag_build_operations WHERE operation_key='legacy-build'"
    )).resolves.toMatchObject({ rows: [{ operation_key: "legacy-build" }] });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM weekly_leaderboard_events"
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);

    const newFlag = await createFlag(pool, "legacy-player", 36);
    await pool.query(
      `INSERT INTO flag_build_operations (
         operation_key,player_id,request_id,flag_id,created_at
       ) VALUES ('new-build','legacy-player','new-request',$1,'2026-07-14T12:01:00Z')`,
      [newFlag]
    );
    await expect(pool.query(
      `SELECT player_id,category,value
       FROM weekly_leaderboard_events
       ORDER BY event_id`
    )).resolves.toMatchObject({
      rows: [{ player_id: "legacy-player", category: "flags_built", value: "1" }]
    });
  }, 90_000);
});

async function createPlayer(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id,username,display_color,region_code,lat,lon,anchor_lat,anchor_lon,
       move_leash_radius_m,online,geom
     ) VALUES (
       $1,'Legacy Player','#38bdf8','NM',35,-106,35,-106,900,false,
       ST_SetSRID(ST_MakePoint(-106,35),4326)
     )`,
    [id]
  );
}

async function createFlag(pool: pg.Pool, ownerId: string, lat: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO flags (
       id,owner_id,name,lat,lon,claim_radius_m,
       resource_vision_radius_m,environment_snapshot,geom
     ) VALUES (
       $1,$2,'Legacy Flag',$3,-106,10000,1000,'{}'::jsonb,
       ST_SetSRID(ST_MakePoint(-106,$3),4326)
     )`,
    [id, ownerId, lat]
  );
  return id;
}

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("Weekly leaderboard migration tests require a local stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
