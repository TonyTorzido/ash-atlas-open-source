import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import {
  activateLegacyGlobalMarketForTest,
  createLegacyMarketTestService,
  LEGACY_TEST_VENUE_ID
} from "../game/legacyMarketTestAdapter.js";
import type { MarketActor } from "../game/marketRules.js";
import { createLogger } from "../logger.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const TARGET_MIGRATION = "0818_species_meat_active_holdings.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Species Meat active holdings migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_species_meat_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const sourceMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const playerId = `species-meat-migration-${suffix}`;
  const accountId = randomUUID();
  const campaignId = randomUUID();
  const packageId = randomUUID();
  const kingdomId = randomUUID();
  const manorId = randomUUID();
  const cityId = randomUUID();
  const worldDropId = randomUUID();
  const actor: MarketActor = { playerId, accountId };
  let databaseUrl = "";
  let migrationsDirectory = "";
  let pool: DisposableTestPool;
  let openOrderId = "";
  let buyOrderId = "";
  let expiredOrderId = "";

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-species-meat-"));
    for (const name of (await readdir(sourceMigrations))
      .filter((entry) => entry.endsWith(".sql") && entry < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(sourceMigrations, name), path.join(migrationsDirectory, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    await seedLiveRawHoldings();
    await seedWorldDrop();
    await activateLegacyGlobalMarketForTest(pool);
    await pool.query(
      `UPDATE item_definitions
       SET market_tradable = true, market_fungible = true, market_identity = 'raw_meat'
       WHERE item_id = 'raw_meat'`
    );
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      MARKET_GLOBAL_ACCESS: "true"
    });
    const service = createLegacyMarketTestService(pool, config, createLogger("test"));
    const open = await service.createOrder(actor, {
      requestId: `species-meat-open-${suffix}`,
      interface: "merchant",
      side: "sell",
      itemIdentity: "raw_meat",
      quantity: "5",
      unitPrice: "2"
    });
    openOrderId = open.order!.orderId;

    await pool.query(
      "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() - interval '1 second')"
    );
    try {
      const expired = await service.createOrder(actor, {
        requestId: `species-meat-expired-${suffix}`,
        interface: "merchant",
        side: "sell",
        itemIdentity: "raw_meat",
        quantity: "3",
        unitPrice: "2"
      });
      expiredOrderId = expired.order!.orderId;
    } finally {
      await pool.query(
        "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days')"
      );
    }
    const buy = await service.createOrder(actor, {
      requestId: `species-meat-buy-${suffix}`,
      interface: "merchant",
      side: "buy",
      itemIdentity: "raw_meat",
      quantity: "2",
      unitPrice: "1"
    });
    buyOrderId = buy.order!.orderId;
    await expect(service.expireDueOrders()).resolves.toMatchObject({ materialOrders: 1 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });

  it("converts populated live holdings and leaves an empty idempotent rerun", async () => {
    await copyFile(
      path.join(sourceMigrations, TARGET_MIGRATION),
      path.join(migrationsDirectory, TARGET_MIGRATION)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    await expect(pool.query(
      `SELECT resource_type, quantity::text, version::text
       FROM player_inventory WHERE player_id = $1 ORDER BY resource_type`,
      [playerId]
    )).resolves.toMatchObject({ rows: [
      { resource_type: "raw_meat", quantity: "0", version: "7" },
      { resource_type: "wild_meat", quantity: "38", version: "3" }
    ] });
    await expect(pool.query(
      `SELECT resource_type, quantity::text
       FROM player_inventory_slots WHERE player_id = $1 ORDER BY resource_type`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ resource_type: "wild_meat", quantity: "38" }] });
    await expect(pool.query(
      `SELECT item_id, delta_quantity::text, quantity_after::text, version_after::text
       FROM inventory_events WHERE player_id = $1 ORDER BY id`,
      [playerId]
    )).resolves.toMatchObject({ rows: [
      { item_id: "raw_meat", delta_quantity: "40", quantity_after: "40", version_after: "1" },
      { item_id: "raw_meat", delta_quantity: "-2", quantity_after: "38", version_after: "2" },
      { item_id: "raw_meat", delta_quantity: "-5", quantity_after: "33", version_after: "3" },
      { item_id: "raw_meat", delta_quantity: "-3", quantity_after: "30", version_after: "4" },
      { item_id: "wild_meat", delta_quantity: "30", quantity_after: "30", version_after: "1" },
      { item_id: "raw_meat", delta_quantity: "-30", quantity_after: "0", version_after: "5" },
      { item_id: "wild_meat", delta_quantity: "5", quantity_after: "35", version_after: "2" },
      { item_id: "raw_meat", delta_quantity: "3", quantity_after: "3", version_after: "6" },
      { item_id: "wild_meat", delta_quantity: "3", quantity_after: "38", version_after: "3" },
      { item_id: "raw_meat", delta_quantity: "-3", quantity_after: "0", version_after: "7" }
    ] });
    await expect(pool.query(
      `SELECT canonical_item_id, original_quantity::text, remaining_quantity::text
       FROM player_package_items WHERE package_id = $1`,
      [packageId]
    )).resolves.toMatchObject({ rows: [{
      canonical_item_id: "wild_meat", original_quantity: "3", remaining_quantity: "3"
    }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM player_package_items
       WHERE canonical_item_id = 'raw_meat' AND remaining_quantity > 0`
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(pool.query(
      `SELECT status, item_id, remaining_quantity::text
       FROM world_item_drops WHERE id = $1`,
      [worldDropId]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled", item_id: "raw_meat", remaining_quantity: "0" }] });
    await expect(pool.query(
      `SELECT d.status, d.item_id, d.remaining_quantity::text, s.reason,
              m.movement_kind, m.quantity::text
       FROM world_item_drops d
       JOIN world_item_system_drop_sources s ON s.drop_id = d.id
       JOIN world_item_movements m ON m.drop_id = d.id AND m.movement_kind = 'system_to_world'
       WHERE d.operation_key = $1`,
      [`migration:0818:raw-meat-drop:${worldDropId}`]
    )).resolves.toMatchObject({ rows: [{
      status: "active", item_id: "wild_meat", remaining_quantity: "2",
      reason: "raw_meat_to_wild_meat_migration", movement_kind: "system_to_world", quantity: "2"
    }] });
    await expect(pool.query(
      `SELECT reason, quantity::text FROM world_item_movements
       WHERE drop_id = $1 AND movement_kind = 'world_to_destruction'`,
      [worldDropId]
    )).resolves.toMatchObject({ rows: [{ reason: "legacy_cancelled_sink", quantity: "2" }] });
    await expect(pool.query(
      `SELECT item_id, quantity::text FROM manor_storage_stacks WHERE manor_id = $1`,
      [manorId]
    )).resolves.toMatchObject({ rows: [{ item_id: "wild_meat", quantity: "4" }] });
    await expect(pool.query(
      `SELECT item_id, quantity::text FROM city_warehouse_stacks WHERE city_id = $1`,
      [cityId]
    )).resolves.toMatchObject({ rows: [{ item_id: "wild_meat", quantity: "3" }] });
    await expect(pool.query(
      `SELECT status, remaining_quantity::text FROM market_orders WHERE order_id = $1`,
      [openOrderId]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled", remaining_quantity: "5" }] });
    await expect(pool.query(
      `SELECT remaining_amount::text FROM market_order_escrows WHERE order_id = $1`,
      [openOrderId]
    )).resolves.toMatchObject({ rows: [{ remaining_amount: "0" }] });
    await expect(pool.query(
      `SELECT status, remaining_quantity::text FROM market_orders WHERE order_id = $1`,
      [buyOrderId]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled", remaining_quantity: "2" }] });
    await expect(pool.query(
      `SELECT remaining_amount::text FROM market_order_escrows WHERE order_id = $1`,
      [buyOrderId]
    )).resolves.toMatchObject({ rows: [{ remaining_amount: "0" }] });
    await expect(pool.query(
      `SELECT gold_balance::text FROM player_wallets WHERE player_id = $1`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ gold_balance: "100" }] });
    await expect(pool.query(
      `SELECT status, remaining_quantity::text FROM market_orders WHERE order_id = $1`,
      [expiredOrderId]
    )).resolves.toMatchObject({ rows: [{ status: "expired", remaining_quantity: "3" }] });
    await expect(pool.query(
      `SELECT item_id, remaining_amount::text, claimed_at IS NOT NULL AS claimed
       FROM market_collections WHERE source_order_id = $1`,
      [expiredOrderId]
    )).resolves.toMatchObject({ rows: [{ item_id: "raw_meat", remaining_amount: "0", claimed: true }] });
    await expect(pool.query(
      `SELECT frozen FROM market_order_books
       WHERE venue_id = $1 AND item_identity = 'raw_meat'`,
      [LEGACY_TEST_VENUE_ID]
    )).resolves.toMatchObject({ rows: [{ frozen: true }] });
    await expect(pool.query(
      `SELECT resource_type, quantity::text FROM kingdom_treasury_balances
       WHERE kingdom_id = $1 ORDER BY resource_type`,
      [kingdomId]
    )).resolves.toMatchObject({ rows: [
      { resource_type: "raw_meat", quantity: "0" },
      { resource_type: "wild_meat", quantity: "7" }
    ] });

    const afterFirstRun = await retainedState();
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    await expect(retainedState()).resolves.toEqual(afterFirstRun);
  }, 120_000);

  async function seedLiveRawHoldings(): Promise<void> {
    const operationKey = `species-meat-seed:${suffix}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')`,
        [accountId]
      );
      await client.query(
        `INSERT INTO players (
           id, account_id, username, username_normalized, region_code, lat, lon,
           anchor_lat, anchor_lon, move_leash_radius_m, online, geom
         ) VALUES ($1,$2,$1,$1,'NM',35,-106,35,-106,900,false,
                   ST_SetSRID(ST_MakePoint(-106,35),4326))`,
        [playerId, accountId]
      );
      await client.query(
        `INSERT INTO kingdoms (
           id, normalized_name, display_name, founder_player_id,
           leader_player_id, founding_request_id
         ) VALUES ($1,$2,'Species Meat Migration Kingdom',$3,$3,$4)`,
        [kingdomId, `species-meat-${suffix}`, playerId, `found-${suffix}`]
      );
      await client.query(
        `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
         VALUES ($1, $2, 0, 0)`,
        [playerId, accountId]
      );
      await client.query(
        `INSERT INTO wallet_events (
           operation_key, player_id, account_id, delta_gold, balance_after,
           version_after, reason, metadata
         ) VALUES ($1, $2, $3, 100, 100, 1, 'species_meat_fixture', '{}'::jsonb)`,
        [`species-meat-wallet-seed:${suffix}`, playerId, accountId]
      );
      await client.query(
        `UPDATE player_wallets SET gold_balance = 100, version = 1 WHERE player_id = $1`,
        [playerId]
      );
      await client.query(
        `INSERT INTO player_manors (id, owner_player_id) VALUES ($1, $2)`,
        [manorId, playerId]
      );
      await client.query(
        `INSERT INTO manor_storage_stacks
           (manor_id, slot_index, item_id, variant, quantity)
         VALUES ($1, 0, 'raw_meat', 'default', 4)`,
        [manorId]
      );
      await client.query(
        `INSERT INTO cities (
           id, canonical_municipality_id, world_settlement_id, world_settlement_source,
           world_source_settlement_id, name, country_code, region_code,
           founder_player_id, founding_request_id, hall_lat, hall_lon,
           hall_geom, founding_annex_radius_m
         ) VALUES (
           $1, $2, $2, 'test', $2, 'Species Meat Migration City', 'US', 'NM',
           $3, $4, 35, -106,
           ST_SetSRID(ST_MakePoint(-106, 35),4326), 1000
         )`,
        [cityId, `species-meat-city-${suffix}`, playerId, `city-found-${suffix}`]
      );
      await client.query(
        `INSERT INTO city_warehouse_stacks
           (city_id, slot_index, item_id, variant, quantity)
         VALUES ($1, 0, 'raw_meat', 'default', 3)`,
        [cityId]
      );
      await client.query(
        `INSERT INTO kingdom_treasury_balances
           (kingdom_id,resource_type,variant,quantity)
         VALUES ($1,'raw_meat','default',7)`,
        [kingdomId]
      );
      await client.query(
        `INSERT INTO inventory_operations (
           operation_key, player_id, source, source_entity_type, source_entity_id, metadata
         ) VALUES ($1,$2,'species_meat_fixture','migration','seed','{}'::jsonb)`,
        [operationKey, playerId]
      );
      await client.query(
        `INSERT INTO player_inventory (
           player_id, resource_type, variant, quantity, version
         ) VALUES ($1,'raw_meat','default',40,1)`,
        [playerId]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,source_entity_type,source_entity_id,metadata
         ) VALUES ($1,$2,'raw_meat','default',40,40,1,'species_meat_fixture',
                   'migration','seed','{}'::jsonb)`,
        [operationKey, playerId]
      );
      await client.query(
        `INSERT INTO player_package_campaigns (
           id, operation_key, request_hash, created_by_subject, created_by_player_id,
           target_mode, title, message, recipient_count
         ) VALUES ($1,$2,$3,$4,$5,'specific','Species Meat Fixture','Legacy holding',1)`,
        [campaignId, randomUUID(), "a".repeat(64), playerId, playerId]
      );
      await client.query(
        `INSERT INTO player_packages (id,campaign_id,recipient_player_id)
         VALUES ($1,$2,$3)`,
        [packageId, campaignId, playerId]
      );
      await client.query(
        `INSERT INTO player_package_items (
           package_id,line_number,item_kind,canonical_item_id,variant,
           original_quantity,remaining_quantity,metadata
         ) VALUES ($1,1,'resource','raw_meat',NULL,3,3,'{}'::jsonb)`,
        [packageId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedWorldDrop(): Promise<void> {
    const operationKey = `species-meat-drop-fixture:${suffix}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO inventory_operations (
           operation_key,player_id,source,source_entity_type,source_entity_id,metadata
         ) VALUES ($1,$2,'drop_item','world_item_drop',$3,'{}'::jsonb)`,
        [operationKey, playerId, worldDropId]
      );
      await client.query(
        `UPDATE player_inventory
         SET quantity = quantity - 2, version = version + 1
         WHERE player_id = $1 AND resource_type = 'raw_meat' AND variant = 'default'`,
        [playerId]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,source_entity_type,source_entity_id,metadata
         ) SELECT $1,$2,'raw_meat','default',-2,quantity,version,'drop_item',
                  'world_item_drop',$3,'{}'::jsonb
           FROM player_inventory
           WHERE player_id = $2 AND resource_type = 'raw_meat' AND variant = 'default'`,
        [operationKey, playerId, worldDropId]
      );
      await client.query(
        `INSERT INTO world_item_drops (
           id,operation_key,dropped_by,region_code,zone_id,pile_id,pile_order,
           item_id,variant,original_quantity,remaining_quantity,status,lat,lon,geom,
           created_at,expires_at
         ) VALUES ($1,$2,$3,'NM','species-meat-zone','species-meat-pile',0,
                   'raw_meat','default',2,2,'active',35,-106,
                   ST_SetSRID(ST_MakePoint(-106,35),4326),
                   clock_timestamp(),clock_timestamp()+interval '1 day')`,
        [worldDropId, operationKey, playerId]
      );
      await client.query(
        `INSERT INTO world_item_drop_requests (
           operation_key,drop_id,player_id,request_hash,original_result,created_at
         )
         SELECT d.operation_key,d.id,d.dropped_by,
           encode(sha256(convert_to(
             d.dropped_by || chr(31) || d.item_id || chr(31) || d.variant || chr(31)
               || d.original_quantity::text,'UTF8')),'hex'),
           jsonb_build_object('drop',jsonb_build_object(
             'dropId',d.id,'droppedBy',d.dropped_by,'regionCode',d.region_code,
             'itemId',d.item_id,'variant',NULL,'quantity',d.original_quantity,
             'status','active','lat',d.lat,'lon',d.lon,'createdAt',d.created_at,
             'expiresAt',d.expires_at,'pickedUpBy',NULL,'pickedUpAt',NULL),
             'legacyBackfill',true),
           d.created_at
         FROM world_item_drops d WHERE d.id = $1`,
        [worldDropId]
      );
      await client.query(
        `INSERT INTO world_item_movements (
           drop_id,movement_kind,operation_key,player_id,item_id,variant,quantity,
           reason,created_at
         ) VALUES ($1,'player_to_world',$2,$3,'raw_meat','default',2,'drop_created',
                   (SELECT created_at FROM world_item_drops WHERE id = $1))`,
        [worldDropId, operationKey, playerId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function retainedState(): Promise<unknown> {
    return {
      inventory: (await pool.query(
        "SELECT * FROM player_inventory ORDER BY player_id,resource_type,variant"
      )).rows,
      slots: (await pool.query(
        "SELECT * FROM player_inventory_slots ORDER BY player_id,slot_index"
      )).rows,
      packageItems: (await pool.query(
        "SELECT * FROM player_package_items ORDER BY package_id,line_number"
      )).rows,
      orders: (await pool.query(
        "SELECT * FROM market_orders ORDER BY order_id"
      )).rows,
      escrows: (await pool.query(
        "SELECT * FROM market_order_escrows ORDER BY order_id"
      )).rows,
      collections: (await pool.query(
        "SELECT * FROM market_collections ORDER BY collection_id"
      )).rows,
      claims: (await pool.query(
        "SELECT * FROM market_claims ORDER BY claim_id"
      )).rows,
      treasury: (await pool.query(
        "SELECT * FROM kingdom_treasury_balances ORDER BY kingdom_id,resource_type,variant"
      )).rows,
      wallets: (await pool.query(
        "SELECT * FROM player_wallets ORDER BY player_id"
      )).rows,
      manorStorage: (await pool.query(
        "SELECT * FROM manor_storage_stacks ORDER BY manor_id,slot_index"
      )).rows,
      cityWarehouse: (await pool.query(
        "SELECT * FROM city_warehouse_stacks ORDER BY city_id,slot_index"
      )).rows,
      drops: (await pool.query(
        "SELECT * FROM world_item_drops ORDER BY id"
      )).rows
    };
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Species Meat migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
