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
const migration = "0762_item_rarity.sql";

describeDatabase("item rarity migration", () => {
  const sourceMigrations = fileURLToPath(
    new URL("../../../../db/migrations", import.meta.url)
  );
  const databaseName = `ash_atlas_stability_item_rarity_${randomUUID().replaceAll("-", "")}`;
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
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-item-rarity-"));
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

  it("backfills canonical rarities without changing inventory or market ownership", async () => {
    const accountId = randomUUID();
    const playerId = `item-rarity-${randomUUID()}`;
    const stackId = randomUUID();
    const bookId = randomUUID();
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,'rarityfixture','rarityfixture','#38bdf8','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId]
    );
    await pool.query(
      `INSERT INTO player_inventory_slots (
         stack_id,player_id,slot_index,resource_type,variant,quantity,manual_split
       ) VALUES ($1,$2,0,'wood','default',17,true)`,
      [stackId, playerId]
    );
    await pool.query(
      `INSERT INTO market_order_books (book_id,venue_id,item_identity,item_id,variant)
       SELECT $1,venue_id,'wood','wood','default'
       FROM market_venues
       WHERE venue_key='global'`,
      [bookId]
    );
    const inventoryBefore = await inventorySnapshot(stackId);
    const marketBefore = await marketSnapshot(bookId);

    await copyFile(path.join(sourceMigrations, migration), path.join(precedingMigrations, migration));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations })).resolves.toEqual([migration]);
    await expect(inventorySnapshot(stackId)).resolves.toEqual(inventoryBefore);
    await expect(marketSnapshot(bookId)).resolves.toEqual(marketBefore);
    await expect(pool.query(
      `SELECT item_id,rarity
       FROM item_definitions
       WHERE rarity <> 'common'
       ORDER BY item_id`
    )).resolves.toMatchObject({ rows: [
      { item_id: "atlas_shrine_shard", rarity: "rare" },
      { item_id: "balsam_resin", rarity: "uncommon" },
      { item_id: "jellyfish_venom", rarity: "rare" }
    ] });
    await runMigrations(databaseUrl);
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    await expect(
      pool.query("UPDATE item_definitions SET rarity='mythic' WHERE item_id='wood'")
    ).rejects.toMatchObject({ code: "23514" });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 120_000);

  async function inventorySnapshot(stackId: string): Promise<unknown> {
    const result = await pool.query(
      `SELECT stack_id::text,player_id,slot_index,resource_type,variant,quantity::text,manual_split
       FROM player_inventory_slots
       WHERE stack_id=$1`,
      [stackId]
    );
    return result.rows;
  }

  async function marketSnapshot(bookId: string): Promise<unknown> {
    const result = await pool.query(
      `SELECT book_id::text,venue_id::text,item_identity,item_id,variant,book_version::text,frozen,sensitive_reason
       FROM market_order_books
       WHERE book_id=$1`,
      [bookId]
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
    throw new Error("item rarity migration verification requires ash_atlas_stability");
  }
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
