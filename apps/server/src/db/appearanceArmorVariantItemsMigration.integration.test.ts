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
const migration = "0798_appearance_armor_variant_items.sql";

describeDatabase("appearance armor variant item migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_armor_variants_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const sourceMigrations = fileURLToPath(
    new URL("../../../../db/migrations", import.meta.url)
  );
  const accountId = randomUUID();
  const playerId = `armor-variants-${suffix}`;
  const instanceId = randomUUID();
  const operationKey = `armor-variants:${playerId}`;
  let databaseUrl = "";
  let pool: pg.Pool;
  let precedingMigrations = "";

  beforeAll(async () => {
    const parsed = assertDisposableDatabase(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-pre-0798-armor-variants-")
    );
    for (const name of (await readdir(sourceMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < migration)
      .sort()) {
      await copyFile(
        path.join(sourceMigrations, name),
        path.join(precedingMigrations, name)
      );
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
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

  it("registers armor variants while preserving populated player equipment and reruns empty", async () => {
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,'armorfixture','armorfixture','#38bdf8','NM',35,-106,35,-106,900,false,
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
         inventory_slot_index,item_level,balance_version,created_by_operation_key,metadata
       ) VALUES ($1,'padded_tunic',$2,'equipped','chest',0,4,2,$3,'{"retained":true}'::jsonb)`,
      [instanceId, playerId, operationKey]
    );
    const retainedBefore = await retainedSnapshot();

    await copyFile(path.join(sourceMigrations, migration), path.join(precedingMigrations, migration));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })).resolves.toEqual([migration]);
    await expect(retainedSnapshot()).resolves.toEqual(retainedBefore);
    await expect(pool.query(
      `SELECT item_id,display_name,category,equipment_family_id,equipment_role,rarity,
              stackable,max_stack,droppable,manor_storable,market_tradable,
              market_fungible,market_identity,supported_variants
       FROM item_definitions
       WHERE item_id = ANY($1::text[])
       ORDER BY item_id`,
      [["cloth-armor-grey", "leather-armor-", "breastplate-armor"]]
    )).resolves.toMatchObject({ rows: [
      {
        item_id: "breastplate-armor", display_name: "Breastplate Armor",
        category: "equipment", equipment_family_id: "breastplate",
        equipment_role: "cosmetic", rarity: "common", stackable: false,
        max_stack: 1, droppable: true, manor_storable: true,
        market_tradable: false, market_fungible: false, market_identity: null,
        supported_variants: ["default"]
      },
      {
        item_id: "cloth-armor-grey", display_name: "Cloth Armor Grey",
        category: "equipment", equipment_family_id: "tunic",
        equipment_role: "cosmetic", rarity: "common", stackable: false,
        max_stack: 1, droppable: true, manor_storable: true,
        market_tradable: false, market_fungible: false, market_identity: null,
        supported_variants: ["default"]
      },
      {
        item_id: "leather-armor-", display_name: "Leather Armor",
        category: "equipment", equipment_family_id: "leather",
        equipment_role: "cosmetic", rarity: "common", stackable: false,
        max_stack: 1, droppable: true, manor_storable: true,
        market_tradable: false, market_fungible: false, market_identity: null,
        supported_variants: ["default"]
      }
    ] });
    await runMigrations(databaseUrl);
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 120_000);

  async function retainedSnapshot(): Promise<unknown> {
    const result = await pool.query(
      `SELECT player.id,player.username,player.display_color,
              equipment.instance_id::text,equipment.definition_id,
              equipment.owner_player_id,equipment.location,equipment.equipped_slot,
              equipment.inventory_slot_index,equipment.item_level,
              equipment.balance_version,equipment.metadata
       FROM players player
       JOIN equipment_instances equipment ON equipment.owner_player_id=player.id
       WHERE player.id=$1 AND equipment.instance_id=$2`,
      [playerId, instanceId]
    );
    return result.rows;
  }
});

function assertDisposableDatabase(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname.slice(1) !== "ash_atlas_stability"
  ) {
    throw new Error(
      "armor variant migration verification requires the local ash_atlas_stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
