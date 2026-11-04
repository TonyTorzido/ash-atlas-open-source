import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "./inventory.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Furnace PostgreSQL migrations", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
    inventory = new InventoryService(pool);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES (
         'owner','Ash','world-test',35,-106,35,-106,
         2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`
    );
    const manor = await pool.query<{ id: string }>(
      "INSERT INTO player_manors (owner_player_id) VALUES ('owner') RETURNING id"
    );
    await pool.query(
      `UPDATE player_manors
       SET world_region_code='world-test',world_lat=35,world_lon=-106,
           built_at=now(),geom=ST_SetSRID(ST_MakePoint(-106,35),4326)
       WHERE id=$1`,
      [manor.rows[0]!.id]
    );
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE players CASCADE");
    await pool?.end();
  });

  it("upgrades a populated database, preserves representative records, and is empty on repeat", async () => {
    await inventory.grantItemsForOperation({
      operationKey: `furnace-migration-test:${randomUUID()}`,
      playerId: "owner",
      source: "furnace_test",
      grants: [{ itemId: "wood", variant: null, quantity: 7 }]
    });
    const manorBefore = await pool.query<{ id: string }>(
      "SELECT id FROM player_manors WHERE owner_player_id='owner'"
    );
    await pool.query(
      "DROP TABLE furnace_smelt_units, furnace_build_jobs, furnace_operations, furnace_smelt_jobs, player_furnaces"
    );
    await pool.query("DELETE FROM item_definitions WHERE item_id='iron_bar'");
    const removed = await pool.query(
      `DELETE FROM schema_migrations
       WHERE version LIKE '0738_furnace_smelting%'
          OR version LIKE '0739_furnace_construction%'
          OR version LIKE '0753_venomsteel_imbuement%'
          OR version LIKE '0759_single_player_furnace%'
          OR version LIKE '0761_furnace_mixed_queue%'
          OR version LIKE '0768_legendary_elemental_birds%'
          OR version LIKE '0826_metallurgy_iron_slag%'`
    );
    expect(removed.rowCount).toBe(7);

    await runMigrations(databaseUrl!);
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
    await expect(pool.query("SELECT 1 FROM player_furnaces LIMIT 1")).resolves.toBeDefined();
    await expect(pool.query("SELECT 1 FROM furnace_smelt_jobs LIMIT 1")).resolves.toBeDefined();
    await expect(pool.query("SELECT 1 FROM furnace_operations LIMIT 1")).resolves.toBeDefined();
    await expect(pool.query("SELECT 1 FROM furnace_build_jobs LIMIT 1")).resolves.toBeDefined();
    expect((await pool.query("SELECT id FROM players WHERE id='owner'")).rowCount).toBe(1);
    expect((await pool.query(
      "SELECT id FROM player_manors WHERE owner_player_id='owner'"
    )).rows[0]?.id).toBe(manorBefore.rows[0]?.id);
    expect((await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM player_inventory WHERE player_id='owner' AND resource_type='wood'"
    )).rows[0]?.quantity).toBe("7");
  });

  it("keeps the oldest Furnace when upgrading owners with duplicates", async () => {
    const manor = await pool.query<{ id: string }>(
      "SELECT id FROM player_manors WHERE owner_player_id='owner'"
    );
    await pool.query("DROP INDEX player_furnaces_active_owner_unique");
    await pool.query("ALTER TABLE player_furnaces DROP COLUMN removal_reason, DROP COLUMN removed_at");
    await pool.query("DELETE FROM schema_migrations WHERE version='0759_single_player_furnace.sql'");
    const furnaces = await pool.query<{ furnace_id: string }>(
      `INSERT INTO player_furnaces (
         manor_id,owner_player_id,world_id,region_code,lat,lon,geom,built_at,created_at
       ) VALUES
         ($1,'owner','test-world','world-test',35,-106,
          ST_SetSRID(ST_MakePoint(-106,35),4326),'2026-01-01','2026-01-01'),
         ($1,'owner','test-world','world-test',35,-106,
          ST_SetSRID(ST_MakePoint(-106,35),4326),'2026-01-02','2026-01-02')
       RETURNING furnace_id`,
      [manor.rows[0]!.id]
    );
    await pool.query(
      `INSERT INTO furnace_build_jobs (
         owner_player_id,request_id,request_hash,manor_id,world_id,region_code,
         lat,lon,geom,status,started_at,completes_at,furnace_id
       ) VALUES (
         'owner','duplicate-build',repeat('a',64),$1,'test-world','world-test',
         35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326),'completed',
         '2026-01-01 23:59:30+00','2026-01-02 00:00:00+00',$2
       )`,
      [manor.rows[0]!.id, furnaces.rows[1]!.furnace_id]
    );

    await expect(runMigrations(databaseUrl!)).resolves.toEqual(["0759_single_player_furnace.sql"]);
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
    const retained = await pool.query<{
      furnace_id: string;
      removed_at: Date | null;
      removal_reason: string | null;
    }>(
      `SELECT furnace_id,removed_at,removal_reason
       FROM player_furnaces
       ORDER BY built_at,furnace_id`
    );
    expect(retained.rows).toEqual([
      expect.objectContaining({ furnace_id: furnaces.rows[0]!.furnace_id, removed_at: null }),
      expect.objectContaining({
        furnace_id: furnaces.rows[1]!.furnace_id,
        removed_at: expect.any(Date) as Date,
        removal_reason: "owner_limit_reconciliation"
      })
    ]);
    await expect(pool.query(
      `INSERT INTO player_furnaces (
         manor_id,owner_player_id,world_id,region_code,lat,lon,geom
       ) VALUES ($1,'owner','test-world','world-test',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [manor.rows[0]!.id]
    )).rejects.toMatchObject({ code: "23505" });
    expect((await pool.query(
      "SELECT status,furnace_id,cancel_reason FROM furnace_build_jobs WHERE request_id='duplicate-build'"
    )).rows[0]).toEqual({
      status: "cancelled",
      furnace_id: null,
      cancel_reason: "owner_limit_reconciliation"
    });
  });
});
