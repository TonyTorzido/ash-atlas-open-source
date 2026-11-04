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
const TARGET_MIGRATION = "0831_military_siege_pack_up.sql";

describeDatabase("Military Siege Pack Up migration", () => {
  const databaseName = `ash_atlas_stability_military_pack_up_${randomUUID().replaceAll("-", "")}`;
  const accountId = randomUUID();
  const playerId = `military-pack-up-migration-${randomUUID()}`;
  const groupId = randomUUID();
  const unitId = randomUUID();
  const operationKey = `military-pack-up-migration:${randomUUID()}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: DisposableTestPool;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!parsed.pathname.includes("ash_atlas_stability")) {
      throw new Error("Migration test requires an ash_atlas_stability admin database");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-military-pack-up-migration-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    await seedFixture();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("adds the deadline contract without changing populated rows and reruns empty", async () => {
    await copyFile(path.join(migrations, TARGET_MIGRATION), path.join(precedingMigrations, TARGET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations }))
      .resolves.toEqual([TARGET_MIGRATION]);

    await expect(pool.query<{ location_state: string; packing_completes_at: Date | null }>(
      `SELECT location_state,packing_completes_at
       FROM military_unit_groups WHERE group_id=$1::uuid`,
      [groupId]
    )).resolves.toMatchObject({ rows: [{ location_state: "DEPLOYED_FIELD", packing_completes_at: null }] });

    const deadline = await pool.query<{ packing_completes_at: Date }>(
      `UPDATE military_unit_groups
       SET location_state='PACKING_UP',packing_completes_at=clock_timestamp()+interval '30 seconds'
       WHERE group_id=$1::uuid
       RETURNING packing_completes_at`,
      [groupId]
    );
    await pool.query(
      `UPDATE military_units
       SET location_state='PACKING_UP',packing_completes_at=$2
       WHERE unit_id=$1::uuid`,
      [unitId, deadline.rows[0]!.packing_completes_at]
    );
    await pool.query(
      `INSERT INTO military_unit_operations (
         operation_key,player_id,request_id,action,request_hash
       ) VALUES ($1,$2,$3,'pack_up',repeat('a',64))`,
      [operationKey, playerId, "pack-up-migration-request"]
    );
    await expect(pool.query<{ location_state: string; packing_completes_at: Date }>(
      "SELECT location_state,packing_completes_at FROM military_units WHERE unit_id=$1::uuid",
      [unitId]
    )).resolves.toMatchObject({ rows: [{ location_state: "PACKING_UP", packing_completes_at: expect.any(Date) }] });

    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })).resolves.toEqual([]);
  }, 120_000);

  async function seedFixture(): Promise<void> {
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,'military-pack-up-migration','military-pack-up-migration','#38bdf8','NM',
         35,-106,35,-106,900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId]
    );
    await pool.query(
      `INSERT INTO military_unit_groups (
         group_id,owner_player_id,unit_type,location_state,lat,lon,revision
       ) VALUES ($1,$2,'field_ballista','DEPLOYED_FIELD',35,-106,1)`,
      [groupId, playerId]
    );
    await pool.query(
      `INSERT INTO military_units (
         unit_id,owner_player_id,unit_type,current_hp,max_hp,status,
         location_state,lat,lon,group_id,revision
       ) VALUES ($1,$2,'field_ballista',150,150,'available',
         'DEPLOYED_FIELD',35,-106,$3::uuid,1)`,
      [unitId, playerId, groupId]
    );
  }
});

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
