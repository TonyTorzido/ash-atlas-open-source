import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const MIGRATION = "0709_backpack_inventory_capacity.sql";

describeDatabase("backpack inventory capacity migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_backpack_migration_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const repositoryMigrations = fileURLToPath(
    new URL("../../../../db/migrations/", import.meta.url)
  );
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  let applied: string[] = [];

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-backpack-migrations-")
    );
    for (const name of (await readdir(repositoryMigrations))
      .filter((name) => name.endsWith(".sql") && name < MIGRATION)
      .sort()) {
      await copyFile(
        path.join(repositoryMigrations, name),
        path.join(precedingMigrations, name)
      );
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    await seedPlayer("backpack-legacy-16", 16);
    await seedPlayer("backpack-legacy-24", 24);
    await seedPlayer("backpack-retained-72", 72);
    await seedRetainedInventory();
    await pool.query(
      `UPDATE player_inventory_capacities
       SET inventory_revision=7
       WHERE player_id='backpack-legacy-16'`
    );
    await copyFile(path.join(repositoryMigrations,MIGRATION),path.join(precedingMigrations,MIGRATION));
    applied = await runMigrations(databaseUrl,{migrationsDirectory:precedingMigrations});
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  });

  it("upgrades legacy capacities, preserves a higher grant, and reruns empty", async () => {
    expect(applied).toContain(MIGRATION);
    await expect(pool.query(
      `SELECT player_id,base_slots,backpack_bonus_slots,unlocked_slots
       FROM player_inventory_capacities
       WHERE player_id LIKE 'backpack-%'
       ORDER BY player_id`
    )).resolves.toMatchObject({
      rows: [
        {
          player_id: "backpack-legacy-16",
          base_slots: 40,
          backpack_bonus_slots: 0,
          unlocked_slots: 40
        },
        {
          player_id: "backpack-legacy-24",
          base_slots: 40,
          backpack_bonus_slots: 0,
          unlocked_slots: 40
        },
        {
          player_id: "backpack-retained-72",
          base_slots: 72,
          backpack_bonus_slots: 0,
          unlocked_slots: 72
        }
      ]
    });
    await expect(runMigrations(databaseUrl,{migrationsDirectory:precedingMigrations})).resolves.toEqual([]);
    await expect(pool.query(
      `SELECT capacity.inventory_revision::integer AS inventory_revision,
              inventory.quantity::text,inventory.version::text,
              slot.stack_id::text,slot.slot_index,slot.quantity::text,slot.manual_split,
              equipment.instance_id::text AS equipment_instance_id,
              equipment.inventory_slot_index
       FROM player_inventory_capacities capacity
       JOIN player_inventory inventory
         ON inventory.player_id=capacity.player_id
        AND inventory.resource_type='leather'
        AND inventory.variant='default'
       JOIN player_inventory_slots slot
         ON slot.player_id=capacity.player_id
        AND slot.resource_type='leather'
        AND slot.variant='default'
       JOIN equipment_instances equipment
         ON equipment.owner_player_id=capacity.player_id
        AND equipment.location='inventory'
       WHERE capacity.player_id='backpack-legacy-16'`
    )).resolves.toMatchObject({
      rows: [{
        inventory_revision: 8,
        quantity: "13",
        version: "1",
        stack_id: "00000000-0000-4000-8000-000000000709",
        slot_index: 15,
        manual_split: true,
        equipment_instance_id: "00000000-0000-4000-8000-000000000710",
        inventory_slot_index: 14
      }]
    });
  }, 90_000);

  it("defaults newly created capacity rows to 40 without changing Manor capacity", async () => {
    await seedPlayer("backpack-new-default", null);
    await expect(pool.query(
      `SELECT base_slots,backpack_bonus_slots,unlocked_slots
       FROM player_inventory_capacities
       WHERE player_id='backpack-new-default'`
    )).resolves.toMatchObject({
      rows: [{
        base_slots: 40,
        backpack_bonus_slots: 0,
        unlocked_slots: 40
      }]
    });
    await expect(pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid='manor_storage_stacks'::regclass
         AND contype='c'`
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ definition: expect.stringMatching(/59/) })
      ])
    });
  });

  async function seedPlayer(playerId: string, capacity: number | null): Promise<void> {
    const accountId = randomUUID();
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,region_code,lat,lon,
         anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$1,$1,'GLOBAL',0,0,0,0,1250,false,
                 ST_SetSRID(ST_MakePoint(0,0),4326))`,
      [playerId, accountId]
    );
    if (capacity === null) {
      await pool.query(
        "INSERT INTO player_inventory_capacities (player_id) VALUES ($1)",
        [playerId]
      );
      return;
    }
    await pool.query(
      `INSERT INTO player_inventory_capacities (player_id,unlocked_slots)
       VALUES ($1,$2)`,
      [playerId, capacity]
    );
  }

  async function seedRetainedInventory(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO inventory_operations (
           operation_key,player_id,source,source_entity_type,source_entity_id,metadata
         ) VALUES (
           'backpack-migration-retained-inventory','backpack-legacy-16',
           'migration_test','test','backpack-legacy-16','{}'::jsonb
         )`
      );
      await client.query(
        `INSERT INTO player_inventory (
           player_id,resource_type,variant,quantity,version
         ) VALUES ('backpack-legacy-16','leather','default',13,1)`
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,source_entity_type,source_entity_id,metadata
         ) VALUES (
           'backpack-migration-retained-inventory','backpack-legacy-16',
           'leather','default',13,13,1,'migration_test','test',
           'backpack-legacy-16','{}'::jsonb
         )`
      );
      await client.query(
        `UPDATE player_inventory_slots
         SET stack_id='00000000-0000-4000-8000-000000000709'::uuid,
             slot_index=15,manual_split=true
         WHERE player_id='backpack-legacy-16'
           AND resource_type='leather'
           AND variant='default'`
      );
      await client.query(
        `INSERT INTO equipment_operations (
           operation_key,player_id,action,completed_at
         ) VALUES (
           'backpack-migration-retained-equipment','backpack-legacy-16',
           'starter_loadout',now()
         )`
      );
      await client.query(
        `INSERT INTO equipment_instances (
           instance_id,definition_id,owner_player_id,location,
           inventory_slot_index,created_by_operation_key
         ) VALUES (
           '00000000-0000-4000-8000-000000000710','starter_bow',
           'backpack-legacy-16','inventory',14,
           'backpack-migration-retained-equipment'
         )`
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !database.startsWith("ash_atlas_stability")
  ) {
    throw new Error(
      "Backpack migration tests require a local disposable ash_atlas_stability admin database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable backpack migration database name");
  }
  return `"${value}"`;
}
