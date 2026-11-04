import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0811_equipment_repair_economy.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("equipment repair economy populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_equipment_repair_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const sourceMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const playerId = `repair-migration-${suffix}`;
  const manorId = randomUUID();
  const instanceId = randomUUID();
  const operationKey = `repair-migration:${suffix}`;
  const shellInventoryOperationKey = `repair-migration-shell:${suffix}`;
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: DisposableTestPool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-equipment-repair-"));
    for (const name of (await readdir(sourceMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(sourceMigrations, name), path.join(migrationsDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("preserves populated custody, converts live Shell once, and reruns empty", async () => {
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'repair-migration','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO player_manors (id,owner_player_id) VALUES ($1,$2)`,
      [manorId, playerId]
    );
    await pool.query(
      `INSERT INTO manor_storage_stacks (manor_id,slot_index,item_id,variant,quantity)
       VALUES ($1,0,'shell','default',6)`,
      [manorId]
    );
    await pool.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action,completed_at)
       VALUES ($1,$2,'starter_loadout',now())`,
      [operationKey, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,
         inventory_slot_index,item_level,balance_version,created_by_operation_key,metadata
       ) VALUES ($1,'padded_tunic',$2,'equipped','chest',0,4,2,$3,'{"retained":true}'::jsonb)`,
      [instanceId, playerId, operationKey]
    );
    const retainedInventory = await pool.connect();
    try {
      await retainedInventory.query("BEGIN");
      await retainedInventory.query(
        `INSERT INTO inventory_operations (
           operation_key,player_id,source,source_entity_type,source_entity_id,metadata
         ) VALUES ($1,$2,'repair_migration_fixture','migration','0811','{}'::jsonb)`,
        [shellInventoryOperationKey, playerId]
      );
      await retainedInventory.query(
        `INSERT INTO player_inventory (player_id,resource_type,variant,quantity,version)
         VALUES ($1,'shell','default',4,1)`,
        [playerId]
      );
      await retainedInventory.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,source_entity_type,source_entity_id,metadata
         ) VALUES ($1,$2,'shell','default',4,4,1,'repair_migration_fixture',
                   'migration','0811','{}'::jsonb)`,
        [shellInventoryOperationKey, playerId]
      );
      await retainedInventory.query("COMMIT");
    } catch (error) {
      await retainedInventory.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      retainedInventory.release();
    }

    await copyFile(
      path.join(sourceMigrations, TARGET_MIGRATION),
      path.join(migrationsDirectory, TARGET_MIGRATION)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    await expect(pool.query(
      `SELECT definition_id,location,equipped_slot,item_level,balance_version,metadata,
              condition
       FROM equipment_instances WHERE instance_id=$1`,
      [instanceId]
    )).resolves.toMatchObject({ rows: [{
      definition_id: "padded_tunic",
      location: "equipped",
      equipped_slot: "chest",
      item_level: 4,
      balance_version: 2,
      metadata: { retained: true },
      condition: 100
    }] });
    await expect(pool.query(
      `SELECT resource_type,variant,quantity::int,version::int
       FROM player_inventory WHERE player_id=$1 ORDER BY resource_type,variant NULLS FIRST`,
      [playerId]
    )).resolves.toMatchObject({ rows: [
      { resource_type: "chitin", variant: "default", quantity: 4, version: 1 },
      { resource_type: "shell", variant: "default", quantity: 0, version: 2 }
    ] });
    await expect(pool.query(
      `SELECT item_id,quantity FROM manor_storage_stacks WHERE manor_id=$1`,
      [manorId]
    )).resolves.toMatchObject({ rows: [{ item_id: "chitin", quantity: "6" }] });
    await expect(pool.query(
      `SELECT item_id,droppable,market_tradable,market_fungible,market_identity
       FROM item_definitions WHERE item_id = ANY($1::text[]) ORDER BY item_id`,
      [["chitin", "repair_kit", "shell"]]
    )).resolves.toMatchObject({ rows: [
      { item_id: "chitin", droppable: true, market_tradable: true, market_fungible: true, market_identity: "chitin" },
      { item_id: "repair_kit", droppable: true, market_tradable: true, market_fungible: true, market_identity: "repair_kit" },
      { item_id: "shell", droppable: false, market_tradable: false, market_fungible: false, market_identity: null }
    ] });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM inventory_events
       WHERE operation_key=$1`,
      [`migration:0811:shell-to-chitin:${playerId}:default`]
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
  }, 120_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Equipment repair migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
