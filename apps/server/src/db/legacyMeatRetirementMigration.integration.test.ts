import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";
import { InventoryService } from "../game/inventory.js";
import { validateItemDefinitionCatalog } from "../game/items.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { activateLegacyGlobalMarketForTest, createLegacyMarketTestService } from "../game/legacyMarketTestAdapter.js";
import { MarketReconciliationService } from "../game/marketReconciliation.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const target = "0862_retire_legacy_meat.sql";
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("legacy meat retirement", () => {
  const databaseName = `ash_atlas_stability_meat_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const player = `meat-${randomUUID()}`;
  const account = randomUUID();
  const manor = randomUUID();
  const kitchen = randomUUID();
  const job = randomUUID();
  const packageId = randomUUID();
  let url = "";
  let directory = "";
  let pool: DisposableTestPool;
  const source = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let jobsBefore: unknown[];
  let eventsBefore: unknown[];

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["localhost", "127.0.0.1"].includes(parsed.hostname) ||
        !parsed.pathname.startsWith("/ash_atlas_stability")) throw new Error("Disposable local database required");
    parsed.pathname = "/" + databaseName;
    url = parsed.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-meat-"));
    for (const name of (await readdir(source)).filter((name) => name.endsWith(".sql") && name < target)) {
      await copyFile(path.join(source, name), path.join(directory, name));
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(url, { migrationsDirectory: directory });
    pool = new DisposableTestPool({ connectionString: url, max: 2 });
    await pool.query("INSERT INTO accounts(id,status,trust_tier) VALUES($1,'active','standard')", [account]);
    await pool.query(`INSERT INTO players(id,username,region_code,lat,lon,anchor_lat,anchor_lon,
      move_leash_radius_m,online,geom) VALUES($1,'Meat fixture','world-test',35,-106,35,-106,
      900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`, [player]);
    await pool.query("UPDATE players SET account_id=$2 WHERE id=$1", [player, account]);
    await new InventoryService(pool).grantItemsForOperation({
      operationKey: "meat-fixture", playerId: player, source: "test_fixture",
      grants: [
        { itemId: "deer_meat", variant: null, quantity: 7 }, { itemId: "deer_cut", variant: null, quantity: 3 },
        { itemId: "wolf_meat", variant: null, quantity: 2 }, { itemId: "hog_meat", variant: null, quantity: 3 },
        { itemId: "bear_meat", variant: null, quantity: 4 }, { itemId: "alligator_meat", variant: null, quantity: 5 },
        { itemId: "squid_meat", variant: null, quantity: 2 }, { itemId: "squid_flesh", variant: null, quantity: 3 },
        { itemId: "wild_meat", variant: null, quantity: 4 }, { itemId: "raw_meat", variant: null, quantity: 5 },
        { itemId: "crab_meat", variant: null, quantity: 9 }, { itemId: "scorching_bird_meat", variant: null, quantity: 2 },
        { itemId: "simple_food", variant: null, quantity: 11 }, { itemId: "wood", variant: null, quantity: 17 }
      ]
    });
    await pool.query(`INSERT INTO player_manors(id,owner_player_id,world_region_code,world_lat,world_lon,built_at,geom)
      VALUES($1,$2,'world-test',35,-106,now(),ST_SetSRID(ST_MakePoint(-106,35),4326))`, [manor, player]);
    await pool.query(`INSERT INTO player_kitchens(kitchen_id,manor_id,owner_player_id,world_id,region_code,lat,lon,geom)
      VALUES($1,$2,$3,'test-world','world-test',35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326))`, [kitchen, manor, player]);
    await pool.query(`INSERT INTO kitchen_jobs(job_id,kitchen_id,owner_player_id,recipe_id,
      requested_input_quantity,output_quantity,started_at,completes_at)
      VALUES($1,$2,$3,'deer_meat',20,2,now(),now()+interval '5 seconds')`, [job, kitchen, player]);
    const campaign = randomUUID();
    await pool.query(`INSERT INTO player_package_campaigns(id,operation_key,request_hash,created_by_subject,
      target_mode,title,message,recipient_count) VALUES($1,$2,$3,'fixture','specific','Ingredients','',1)`,
      [campaign, randomUUID(), "a".repeat(64)]);
    await pool.query("INSERT INTO player_packages(id,campaign_id,recipient_player_id) VALUES($1,$2,$3)",
      [packageId,campaign,player]);
    await pool.query(`INSERT INTO player_package_items(package_id,line_number,item_kind,canonical_item_id,variant,
      original_quantity,remaining_quantity) VALUES
      ($1,1,'resource','deer_meat','default',4,4),
      ($1,2,'resource','deer_cut','default',2,2),
      ($1,3,'resource','wild_meat','default',3,3)`, [packageId]);
    await seedDrop("wolf_meat", 6, false);
    await seedDrop("bear_meat", 8, true);
    await seedDrop("wild_meat", 3, false);
    await seedMarket();
    jobsBefore = (await pool.query("SELECT * FROM kitchen_jobs WHERE job_id=$1", [job])).rows;
    eventsBefore = (await pool.query("SELECT * FROM inventory_events WHERE operation_key='meat-fixture' ORDER BY item_id")).rows;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it("converts live custody, preserves history and current foods, and has an empty second run", async () => {
    await copyFile(path.join(source, target), path.join(directory, target));
    expect(await runMigrations(url, { migrationsDirectory: directory })).toEqual([target]);
    const balances = Object.fromEntries((await pool.query(
      "SELECT resource_type,quantity::int FROM player_inventory WHERE player_id=$1", [player]
    )).rows.map((row) => [row.resource_type, row.quantity]));
    expect(balances).toMatchObject({
      deer_meat: 0, deer_cut: 10, wolf_cut: 2, hog_cut: 3, bear_cut: 4,
      alligator_tail: 5, squid_cut: 5, squid_meat: 0, squid_flesh: 0,
      wild_meat: 0, raw_meat: 0, crab_meat: 9, scorching_bird_meat: 2, simple_food: 11, wood: 17
    });
    expect((await pool.query("SELECT * FROM kitchen_jobs WHERE job_id=$1", [job])).rows).toEqual(jobsBefore);
    expect((await pool.query("SELECT * FROM inventory_events WHERE operation_key='meat-fixture' ORDER BY item_id")).rows).toEqual(eventsBefore);
    expect((await pool.query(`SELECT canonical_item_id,remaining_quantity::int FROM player_package_items
      WHERE package_id=$1 ORDER BY line_number`, [packageId])).rows).toEqual([
      { canonical_item_id: "deer_meat", remaining_quantity: 0 },
      { canonical_item_id: "deer_cut", remaining_quantity: 6 },
      { canonical_item_id: "wild_meat", remaining_quantity: 0 }
    ]);
    const drops = (await pool.query(`SELECT item_id,remaining_quantity::int,manor_id::text,space_id,local_x,local_y
      FROM world_item_drops WHERE status='active' ORDER BY item_id`)).rows;
    expect(drops).toEqual([
      { item_id: "bear_cut", remaining_quantity: 8, manor_id: manor, space_id: "manor_main_room", local_x: 4, local_y: 5 },
      { item_id: "wolf_cut", remaining_quantity: 6, manor_id: null, space_id: null, local_x: null, local_y: null }
    ]);
    await validateItemDefinitionCatalog(pool);
    expect((await pool.query("SELECT gold_balance::int FROM player_wallets WHERE player_id=$1", [player])).rows[0]).toEqual({ gold_balance: 1000 });
    expect((await pool.query("SELECT * FROM market_orders WHERE status IN ('open','partially_filled')")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM market_collections WHERE remaining_amount>0")).rows).toEqual([]);
    expect((await new MarketReconciliationService(pool).reconcile({ honorAutomaticProtection: false })).issues).toEqual([]);
    const after = (await pool.query("SELECT * FROM player_inventory ORDER BY resource_type")).rows;
    expect(await runMigrations(url, { migrationsDirectory: directory })).toEqual([]);
    expect((await pool.query("SELECT * FROM player_inventory ORDER BY resource_type")).rows).toEqual(after);
    expect((await pool.query(`SELECT i.resource_type FROM player_inventory i
      LEFT JOIN inventory_events e ON e.player_id=i.player_id AND e.item_id=i.resource_type AND e.variant=i.variant
      WHERE i.player_id=$1 GROUP BY i.resource_type,i.quantity HAVING i.quantity <> COALESCE(sum(e.delta_quantity),0)`, [player])).rows).toEqual([]);
  }, 120_000);

  async function seedDrop(item: string, quantity: number, indoors: boolean): Promise<void> {
    const id = randomUUID();
    const key = "meat-drop:" + id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO inventory_operations(operation_key,player_id,source,source_entity_type,source_entity_id)
        VALUES($1,$2,'world_system_drop','world_item_drop',$3)`, [key,player,id]);
      await client.query(`INSERT INTO world_item_drops(id,operation_key,dropped_by,region_code,zone_id,pile_id,pile_order,
        item_id,variant,original_quantity,remaining_quantity,status,lat,lon,geom,created_at,expires_at,
        manor_id,space_id,local_x,local_y)
        VALUES($1::uuid,$2,$3,'world-test','test-zone',$1::text,0,$4,'default',$5,$5,'active',35,-106,
        ST_SetSRID(ST_MakePoint(-106,35),4326),now(),now()+interval '1 day',$6,$7,$8,$9)`,
        [id,key,player,item,quantity,indoors ? manor : null,indoors ? "manor_main_room" : null,indoors ? 4 : null,indoors ? 5 : null]);
      await client.query(`INSERT INTO world_item_system_drop_sources(drop_id,operation_key,source_entity_type,source_entity_id,reason)
        VALUES($1::uuid,$2,'fixture',$1::text,'fixture')`, [id,key]);
      await client.query(`INSERT INTO world_item_movements(drop_id,movement_kind,operation_key,player_id,item_id,variant,quantity,reason)
        VALUES($1,'system_to_world',$2,$3,$4,'default',$5,'fixture')`, [id,key,player,item,quantity]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async function seedMarket(): Promise<void> {
    await activateLegacyGlobalMarketForTest(pool);
    await pool.query("UPDATE market_venues SET fee_policy_id=2 WHERE venue_key='global'");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO player_wallets(player_id,account_id,gold_balance,version) VALUES($1,$2,1000,1)", [player,account]);
      await client.query(`INSERT INTO wallet_events(operation_key,player_id,account_id,delta_gold,balance_after,version_after,reason)
        VALUES('meat-fixture-wallet',$1,$2,1000,1000,1,'market_test_seed')`, [player,account]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    const service = createLegacyMarketTestService(pool,
      loadConfig({ NODE_ENV: "test", DATABASE_URL: url, MARKET_GLOBAL_ACCESS: "true" }), createLogger("test"));
    const actor = { playerId: player, accountId: account };
    await service.createOrder(actor, { requestId: "meat-open-sell", interface: "merchant", side: "sell", itemId: "deer_meat", quantity: "5", unitPrice: "10" });
    await service.createOrder(actor, { requestId: "meat-open-buy", interface: "merchant", side: "buy", itemId: "wolf_meat", quantity: "2", unitPrice: "10" });
    await service.createOrder(actor, { requestId: "meat-wild-sell", interface: "merchant", side: "sell", itemId: "wild_meat", quantity: "2", unitPrice: "10" });
    await pool.query("ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() - interval '1 second')");
    try {
      await service.createOrder(actor, { requestId: "meat-expired-sell", interface: "merchant", side: "sell", itemId: "deer_meat", quantity: "2", unitPrice: "10" });
    } finally {
      await pool.query("ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days')");
    }
    await service.expireDueOrders();
  }
});
