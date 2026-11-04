import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0817_rare_hide_tannery_jackpots.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("rare-hide Tannery output migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_rare_hide_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const sourceMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const playerId = `rare-hide-migration-${suffix}`;
  const tanneryId = randomUUID();
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: DisposableTestPool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-rare-hide-"));
    for (const name of (await readdir(sourceMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(sourceMigrations, name), path.join(migrationsDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedPopulatedJob();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("widens the cap without changing populated jobs and is empty on rerun", async () => {
    await copyFile(
      path.join(sourceMigrations, TARGET_MIGRATION),
      path.join(migrationsDirectory, TARGET_MIGRATION)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    await expect(pool.query(
      `SELECT output_quantity::int AS output_quantity
       FROM tannery_jobs WHERE tannery_id=$1`,
      [tanneryId]
    )).resolves.toMatchObject({ rows: [{ output_quantity: 375 }] });
    const constraint = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid='tannery_jobs'::regclass
         AND conname='tannery_jobs_output_quantity_check'`
    );
    expect(constraint.rows[0]?.definition).toMatch(/output_quantity\s*>=\s*1/);
    expect(constraint.rows[0]?.definition).toMatch(/output_quantity\s*<=\s*30000/);

    await expect(pool.query(
      `INSERT INTO tannery_jobs (
         tannery_id,owner_player_id,recipe_id,requested_input_quantity,output_quantity,
         started_at,completes_at
       ) VALUES ($1,$2,'bear_hide',25,30000,now(),now()+interval '5 seconds')`,
      [tanneryId, playerId]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      `INSERT INTO tannery_jobs (
         tannery_id,owner_player_id,recipe_id,requested_input_quantity,output_quantity,
         started_at,completes_at
       ) VALUES ($1,$2,'bear_hide',25,30001,now(),now()+interval '5 seconds')`,
      [tanneryId, playerId]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
  }, 120_000);

  async function seedPopulatedJob(): Promise<void> {
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Rare Hide Tester','world-test',35,-106,35,-106,2000,false,
                 ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId]
    );
    const manor = await pool.query<{ id: string }>(
      "INSERT INTO player_manors (owner_player_id) VALUES ($1) RETURNING id",
      [playerId]
    );
    await pool.query(
      `UPDATE player_manors
       SET world_region_code='world-test',world_lat=35,world_lon=-106,
           built_at=now(),geom=ST_SetSRID(ST_MakePoint(-106,35),4326)
       WHERE id=$1`,
      [manor.rows[0]!.id]
    );
    await pool.query(
      `INSERT INTO player_tanneries (
         tannery_id,manor_id,owner_player_id,world_id,region_code,lat,lon,geom
       ) VALUES ($1,$2,$3,'test-world','world-test',35,-106,
                 ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [tanneryId, manor.rows[0]!.id, playerId]
    );
    await pool.query(
      `INSERT INTO tannery_jobs (
         tannery_id,owner_player_id,recipe_id,requested_input_quantity,output_quantity,
         started_at,completes_at
       ) VALUES ($1,$2,'bear_hide',25,375,now(),now()+interval '5 seconds')`,
      [tanneryId, playerId]
    );
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Rare-hide migration verification requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
