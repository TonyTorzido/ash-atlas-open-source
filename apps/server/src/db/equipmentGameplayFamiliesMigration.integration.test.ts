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
const migration = "0757_equipment_gameplay_families.sql";

describeDatabase("equipment gameplay family migration", () => {
  const sourceMigrations = fileURLToPath(
    new URL("../../../../db/migrations", import.meta.url)
  );
  const databaseName = `ash_atlas_stability_equipment_families_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseUrl = "";
  let precedingMigrations = "";

  beforeAll(async () => {
    assertDisposableDatabase(adminUrl!);
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-equipment-families-"));
    for (const name of await readdir(sourceMigrations)) {
      if (name.endsWith(".sql") && name < migration) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingMigrations, name));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin?.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("backfills family identities and names without changing owned equipment", async () => {
    const accountId = randomUUID();
    const playerId = `equipment-family-${randomUUID()}`;
    const instanceId = randomUUID();
    const operationKey = `equipment-family:${playerId}`;
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,'familyfixture','familyfixture','#38bdf8','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId]
    );
    await pool.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action,completed_at)
       VALUES ($1,$2,'starter_loadout',now())`,
      [operationKey, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,
         inventory_slot_index,item_level,balance_version,created_by_operation_key
       ) VALUES ($1,'starter_sword',$2,'equipped','melee',0,7,2,$3)`,
      [instanceId, playerId, operationKey]
    );
    const before = await equipmentSnapshot(instanceId);

    await copyFile(path.join(sourceMigrations, migration), path.join(precedingMigrations, migration));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })).resolves.toEqual([migration]);
    await expect(equipmentSnapshot(instanceId)).resolves.toEqual(before);
    await expect(pool.query(
      `SELECT item_id,display_name,equipment_family_id,equipment_role
       FROM item_definitions
       WHERE item_id IN ('starter_sword','double_axe','hammer','leather_armor','breast_plate')
       ORDER BY item_id`
    )).resolves.toMatchObject({ rows: [
      { item_id: "breast_plate", display_name: "Breastplate", equipment_family_id: "breastplate", equipment_role: "stock" },
      { item_id: "double_axe", display_name: "Double Axe", equipment_family_id: "axe", equipment_role: "cosmetic" },
      { item_id: "hammer", display_name: "Hammer", equipment_family_id: "staff", equipment_role: "cosmetic" },
      { item_id: "leather_armor", display_name: "Leather Armor", equipment_family_id: "leather", equipment_role: "stock" },
      { item_id: "starter_sword", display_name: "Sword", equipment_family_id: "sword", equipment_role: "stock" }
    ] });
    await runMigrations(databaseUrl);
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 120_000);

  async function equipmentSnapshot(instanceId: string): Promise<unknown> {
    const result = await pool.query(
      `SELECT instance_id::text,definition_id,owner_player_id,location,equipped_slot,
              inventory_slot_index,item_level,balance_version,created_by_operation_key
       FROM equipment_instances WHERE instance_id=$1`,
      [instanceId]
    );
    return result.rows;
  }
});

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error("equipment family migration verification requires ash_atlas_stability");
  }
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
