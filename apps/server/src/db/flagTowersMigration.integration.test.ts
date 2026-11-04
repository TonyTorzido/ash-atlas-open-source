import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0793_flag_towers.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("flag tower migration", () => {
  const databaseName = `ash_atlas_stability_flag_towers_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let pool: pg.Pool;
  let preceding = "";
  const flagId = randomUUID();

  beforeAll(async () => {
    const parsed = disposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-0793-"));
    const source = path.resolve(process.cwd(), "../../db/migrations");
    for (const name of (await readdir(source))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)) {
      await copyFile(path.join(source, name), path.join(preceding, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 3 });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await admin.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  });

  it("preserves populated stone durability, admits valid towers, and reruns empty", async () => {
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES (
         'tower-owner','tower-owner','GLOBAL',35,-106,35,-106,1250,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`
    );
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
         reinforcement_level,health,maximum_health,access_mode,geom
       ) VALUES (
         $1,'tower-owner','North Tower',35,-106,1000,1250,1,137,200,'private',
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [flagId]
    );

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);
    await expect(pool.query(
      `UPDATE flags SET reinforcement_level=3 WHERE id=$1 RETURNING health,maximum_health`,
      [flagId]
    )).resolves.toMatchObject({ rows: [{ health: 137, maximum_health: 200 }] });
    await expect(pool.query(
      `INSERT INTO flag_material_spend (
         flag_id,stage,item_id,variant,quantity,paid_by_player_id
       ) VALUES ($1,'tower','stone','default',25,'tower-owner')`,
      [flagId]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      `UPDATE flags SET anchor_kind='buoy' WHERE id=$1`,
      [flagId]
    )).rejects.toThrow();
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 60_000);
});

function disposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.hostname !== "127.0.0.1" ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.pathname.includes("ash_atlas_stability")
  ) {
    throw new Error(
      "MIGRATION_RUNNER_TEST_ADMIN_URL must target the local stability lab ash_atlas_stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
