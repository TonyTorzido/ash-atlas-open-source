import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INVENTORY_CATALOG, MOB_DROP_ITEMS, MOB_DROP_ITEM_IDS } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateItemDefinitionCatalog } from "../game/items.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1060_mob_drop_items.sql";

describeDatabase("Mob value pass drop item migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_mob_drops_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const playerId = `mob-drops-${randomUUID()}`;
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-mob-drops-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-mob-drops-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name !== TARGET_MIGRATION) {
        await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
      }
      await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedPlayerInventory();
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("upgrades a populated database, matches the startup catalog, and is empty on a second run", async () => {
    // Before 1060 the startup check refuses the compiled catalog: the new items are missing.
    await expect(validateItemDefinitionCatalog(pool!)).rejects.toThrow();

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    // Existing holdings are untouched.
    await expect(pool!.query<{ quantity: string }>(
      "SELECT quantity::text FROM player_inventory WHERE player_id = $1 AND resource_type = 'leather'",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ quantity: "40" }] });

    // The server refuses to boot on any catalog mismatch; the migrated rows must match exactly.
    await expect(validateItemDefinitionCatalog(pool!)).resolves.toBeUndefined();
    const rows = await pool!.query<{
      item_id: string; rarity: string; max_stack: number; unit_weight_grams: number; market_tradable: boolean;
    }>(
      `SELECT item_id,rarity,max_stack,unit_weight_grams,market_tradable
       FROM item_definitions WHERE item_id = ANY($1::text[])`,
      [[...MOB_DROP_ITEM_IDS]]
    );
    expect(rows.rows.map((row) => row.item_id).sort()).toEqual([...MOB_DROP_ITEM_IDS].sort());
    for (const row of rows.rows) {
      const item = MOB_DROP_ITEMS[row.item_id as keyof typeof MOB_DROP_ITEMS];
      expect(row, row.item_id).toMatchObject({
        rarity: item.rarity,
        max_stack: item.maxStack,
        unit_weight_grams: item.unitWeightGrams,
        market_tradable: true
      });
      expect(INVENTORY_CATALOG[row.item_id]?.inventoryGroup, row.item_id)
        .toBe(item.group === null ? undefined : item.group);
    }

    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }))
      .resolves.toEqual([]);
  }, 120_000);

  async function seedPlayerInventory(): Promise<void> {
    await pool!.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Mob drops fixture','world-test',35,-106,35,-106,
         900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId]
    );
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO inventory_operations (operation_key,player_id,source,metadata)
         VALUES ($1,$2,'mob_drops_migration_fixture','{}'::jsonb)`,
        [`mob-drops-inventory:${playerId}`, playerId]
      );
      await client.query(
        `INSERT INTO player_inventory (player_id,resource_type,variant,quantity,version)
         VALUES ($1,'leather','default',40,1)`,
        [playerId]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,metadata
         ) VALUES ($1,$2,'leather','default',40,40,1,'mob_drops_migration_fixture','{}'::jsonb)`,
        [`mob-drops-inventory:${playerId}`, playerId]
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
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Mob drop item migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
