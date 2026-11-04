import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0700_authoritative_atlas_shrine_slots.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("authoritative Atlas Shrine slot migration", () => {
  const databaseName =
    `ash_atlas_stability_shrine_slots_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let pool: pg.Pool;
  let preceding = "";

  beforeAll(async () => {
    const parsed = disposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-0700-"));
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

  it("backfills stable slots, repairs generated names, and preserves custom names", async () => {
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES (
         'owner','owner','GLOBAL',35,-106,35,-106,1250,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`
    );
    await pool.query(
      `INSERT INTO player_atlas_shrine_progression (player_id,unlocked_slots)
       VALUES ('owner',3)
       ON CONFLICT (player_id) DO UPDATE SET unlocked_slots=3`
    );
    await insertShrine("Flag 49", "2026-01-01T00:00:00.000Z", 35);
    await insertShrine("owner's Atlas Shrine", "2026-01-02T00:00:00.000Z", 36);
    await insertShrine("Home", "2026-01-03T00:00:00.000Z", 37);

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);
    await expect(pool.query(
      `SELECT name,atlas_shrine_slot_number
       FROM flags
       WHERE owner_id='owner'
       ORDER BY atlas_shrine_slot_number`
    )).resolves.toMatchObject({
      rows: [
        { name: "Atlas Shrine 1", atlas_shrine_slot_number: 1 },
        { name: "Atlas Shrine 2", atlas_shrine_slot_number: 2 },
        { name: "Home", atlas_shrine_slot_number: 3 }
      ]
    });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 60_000);

  async function insertShrine(
    name: string,
    reinforcedAt: string,
    lat: number
  ): Promise<void> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO flags (
         id,owner_id,name,lat,lon,claim_radius_m,resource_vision_radius_m,
         reinforcement_level,reinforced_at,geom
       ) VALUES (
         $1,'owner',$2,$4,-106,1000,1250,2,$3,
         ST_SetSRID(ST_MakePoint(-106,$4),4326)
       )`,
      [id, name, reinforcedAt, lat]
    );
  }
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
