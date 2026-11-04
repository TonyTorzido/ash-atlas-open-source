import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0846_manor_floor_item_drops.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Manor floor item-drop projection migration", () => {
  const databaseName = `ash_atlas_stability_manor_floor_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let pool: pg.Pool;
  let preceding = "";

  beforeAll(async () => {
    assertDedicatedDatabase(adminUrl!);
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-0846-"));
    const source = path.resolve(process.cwd(), "../../db/migrations");
    for (const name of (await readdir(source))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)) {
      await copyFile(path.join(source, name), path.join(preceding, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await admin.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  });

  it("upgrades a retained world drop without changing custody and is repeatable", async () => {
    const playerId = `manor-migration-player-${randomUUID()}`;
    const dropId = randomUUID();
    const seedOperationKey = `manor-migration-seed:${dropId}`;
    const operationKey = `manor-migration-drop:${dropId}`;
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const expiresAt = new Date("2026-01-02T00:00:00.000Z");

    await pool.query("BEGIN");
    try {
      await pool.query(
        `INSERT INTO players (
           id,username,region_code,lat,lon,anchor_lat,anchor_lon,
           move_leash_radius_m,online,geom
         ) VALUES ($1,$2,'NM',35,-106,35,-106,1250,false,
           ST_SetSRID(ST_MakePoint(-106,35),4326))`,
        [playerId, playerId]
      );
      await pool.query(
        `INSERT INTO player_inventory (
           player_id,resource_type,variant,quantity,version
         ) VALUES ($1,'wood','default',0,0)`,
        [playerId]
      );
      await pool.query(
        `INSERT INTO inventory_operations (
           operation_key,player_id,source
         ) VALUES ($1,$2,'manor_migration_seed')`,
        [seedOperationKey, playerId]
      );
      await pool.query(
        `UPDATE player_inventory
         SET quantity=2,version=1
         WHERE player_id=$1 AND resource_type='wood' AND variant='default'`,
        [playerId]
      );
      await pool.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source
         ) VALUES ($1,$2,'wood','default',2,2,1,'manor_migration_seed')`,
        [seedOperationKey, playerId]
      );
      await pool.query(
        `INSERT INTO inventory_operations (
           operation_key,player_id,source,source_entity_type,source_entity_id
         ) VALUES ($1,$2,'drop_item','world_item_drop',$3)`,
        [operationKey, playerId, dropId]
      );
      await pool.query(
        `UPDATE player_inventory
         SET quantity=0,version=2
         WHERE player_id=$1 AND resource_type='wood' AND variant='default'`,
        [playerId]
      );
      await pool.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,source_entity_type,source_entity_id
         ) VALUES ($1,$2,'wood','default',-2,0,2,'drop_item','world_item_drop',$3)`,
        [operationKey, playerId, dropId]
      );
      await pool.query(
        `INSERT INTO world_item_drops (
           id,operation_key,dropped_by,region_code,zone_id,pile_id,pile_order,
           item_id,variant,original_quantity,remaining_quantity,status,lat,lon,geom,
           created_at,expires_at
         ) VALUES ($1,$2,$3,'NM','world:NM',$4,0,'wood','default',2,2,'active',35,-106,
           ST_SetSRID(ST_MakePoint(-106,35),4326),$5,$6)`,
        [dropId, operationKey, playerId, `drop:${dropId}`, createdAt, expiresAt]
      );
      await pool.query(
        `INSERT INTO world_item_drop_requests (
           operation_key,drop_id,player_id,request_hash,original_result,created_at
         ) VALUES (
           $1,$2,$3,
           encode(sha256(convert_to($3 || chr(31) || 'wood' || chr(31)
             || 'default' || chr(31) || '2','UTF8')),'hex'),
           jsonb_build_object(
             'drop', jsonb_build_object(
             'dropId',$2::uuid,'droppedBy',$3::text,'regionCode','NM','itemId','wood',
               'variant',NULL,'quantity',2,'status','active','lat',35,'lon',-106,
               'createdAt',$4::timestamptz,'expiresAt',$5::timestamptz,'pickedUpBy',NULL,'pickedUpAt',NULL
             ),
             'legacyBackfill',true
           ), $4)`,
        [operationKey, dropId, playerId, createdAt, expiresAt]
      );
      await pool.query(
        `INSERT INTO world_item_movements (
           drop_id,movement_kind,operation_key,player_id,item_id,variant,
           quantity,reason,created_at
         ) VALUES ($1,'player_to_world',$2,$3,'wood','default',2,'drop_created',$4)`,
        [dropId, operationKey, playerId, createdAt]
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }

    const before = await retainedDrop(dropId);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([TARGET_MIGRATION]);
    await expect(retainedDrop(dropId)).resolves.toEqual(before);
    await expect(pool.query(
      `SELECT manor_id,space_id,local_x,local_y
       FROM world_item_drops WHERE id=$1`,
      [dropId]
    )).resolves.toMatchObject({ rows: [{ manor_id: null, space_id: null, local_x: null, local_y: null }] });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 120_000);

  async function retainedDrop(dropId: string): Promise<unknown> {
    return (await pool.query(
      `SELECT id,operation_key,dropped_by,region_code,zone_id,pile_id,pile_order,
              item_id,variant,original_quantity,remaining_quantity,status,lat,lon,
              created_at,expires_at
       FROM world_item_drops WHERE id=$1`,
      [dropId]
    )).rows[0];
  }
});

function assertDedicatedDatabase(value: string): void {
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
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
