import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import {
  activateLegacyGlobalMarketForTest,
  createLegacyMarketTestService,
  LEGACY_TEST_VENUE_ID
} from "../game/legacyMarketTestAdapter.js";
import { MarketReconciliationService } from "../game/marketReconciliation.js";
import type { MarketActor } from "../game/marketRules.js";
import { createLogger } from "../logger.js";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.MARKET_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const migration = "0807_market_expired_gold_claim_validation.sql";
const owner: MarketActor = { playerId: "expiry-owner", accountId: "98000000-0000-4000-8000-000000000001" };
const stranger: MarketActor = { playerId: "expiry-stranger", accountId: "98000000-0000-4000-8000-000000000002" };

describeDatabase("expired market gold claim forward migration", () => {
  let pool: pg.Pool;
  let priorMigrations = "";

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !url.pathname.startsWith('/ash_atlas_stability')) {
      throw new Error("Market migration test requires a disposable loopback database");
    }
    priorMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-expired-gold-"));
    const directory = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
    for (const name of await readdir(directory)) {
      if (name.endsWith(".sql") && name < migration) {
        await copyFile(path.join(directory, name), path.join(priorMigrations, name));
      }
    }
    await runMigrations(databaseUrl!, { migrationsDirectory: priorMigrations });
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    for (const actor of [owner, stranger]) await seedActor(pool, actor);
    await activateLegacyGlobalMarketForTest(pool);
    await pool.query("UPDATE market_venues SET fee_policy_id=2 WHERE venue_key='global'");
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (priorMigrations && path.dirname(priorMigrations) === path.resolve(tmpdir()) &&
        path.basename(priorMigrations).startsWith("ash-atlas-expired-gold-")) {
      await rm(priorMigrations, { recursive: true, force: true });
    }
  });

  it("preserves a populated expired refund, enables one authorized claim, and keeps source guards", async () => {
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: databaseUrl!, MARKET_GLOBAL_ACCESS: "true" });
    const service = createLegacyMarketTestService(pool, config, createLogger("test"));
    await pool.query("ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() - interval '1 second')");
    let orderId: string;
    try {
      const result = await service.createOrder(owner, {
        requestId: "expired-gold-upgrade-order", interface: "merchant", side: "buy",
        itemId: "stone", quantity: "1", unitPrice: "10"
      });
      orderId = result.order!.orderId;
    } finally {
      await pool.query("ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days')");
    }
    await expect(service.expireDueOrders()).resolves.toEqual({ materialOrders: 1, equipmentListings: 0 });
    const before = await retainedState(pool);
    expect(before.wallets.find((row) => row.player_id === owner.playerId)?.gold_balance).toBe("89");
    expect(before.collections).toEqual([expect.objectContaining({
      source_order_id: orderId, reason: "buy_expired_refund", remaining_amount: "11"
    })]);
    await expect(service.claim(owner, "expired-gold-upgrade-claim", "gold"))
      .rejects.toMatchObject({ code: "MARKET_INVARIANT_FAILURE" });
    expect(await retainedState(pool)).toEqual(before);

    const directory = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
    await copyFile(path.join(directory, migration), path.join(priorMigrations, migration));
    expect(await runMigrations(databaseUrl!, { migrationsDirectory: priorMigrations })).toEqual([migration]);
    expect(await retainedState(pool)).toEqual(before);
    expect(await runMigrations(databaseUrl!, { migrationsDirectory: priorMigrations })).toEqual([]);
    expect(await retainedState(pool)).toEqual(before);
    expect((await new MarketReconciliationService(pool).reconcile({ honorAutomaticProtection: false })).issues).toEqual([]);

    const foreignClaim = await service.claim(stranger, "expired-gold-foreign-claim", "gold");
    expect(foreignClaim.claimedGold).toBe("0");
    expect((await retainedState(pool)).collections).toEqual(before.collections);
    const claim = await service.claim(owner, "expired-gold-upgrade-claim", "gold");
    expect(claim).toMatchObject({ claimedGold: "11", claimedItems: "0", replayed: false });
    const after = await retainedState(pool);
    expect(after.wallets.find((row) => row.player_id === owner.playerId)?.gold_balance).toBe("100");
    expect(after.collections[0]?.remaining_amount).toBe("0");
    expect(await service.claim(owner, "expired-gold-upgrade-claim", "gold"))
      .toEqual({ ...claim, replayed: true });
    expect(await retainedState(pool)).toEqual(after);

    const collectionId = after.collections[0]!.collection_id;
    await expectForgedClaimRejected(pool, owner, collectionId, "player_wallet",
      /invalid source or destination entry/i);
    await expectForgedClaimRejected(pool, stranger, collectionId, "return_collection",
      /source collection does not match its claim/i);
    expect(await retainedState(pool)).toEqual(after);
    expect((await new MarketReconciliationService(pool).reconcile({ honorAutomaticProtection: false })).issues).toEqual([]);
  });
});

async function seedActor(pool: pg.Pool, actor: MarketActor): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [actor.accountId]);
    await client.query(`INSERT INTO players (
      id,account_id,username,username_normalized,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
    ) VALUES ($1,$2,$1,$1,'NM',35,-106,35,-106,900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
    [actor.playerId, actor.accountId]);
    await client.query("INSERT INTO player_wallets (player_id,account_id,gold_balance,version) VALUES ($1,$2,100,1)",
      [actor.playerId, actor.accountId]);
    await client.query(`INSERT INTO wallet_events (
      operation_key,player_id,account_id,delta_gold,balance_after,version_after,reason
    ) VALUES ($1,$2,$3,100,100,1,'market_migration_seed')`,
    [`expiry-seed:${actor.playerId}`, actor.playerId, actor.accountId]);
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function retainedState(pool: pg.Pool) {
  return {
    wallets: (await pool.query("SELECT * FROM player_wallets ORDER BY player_id")).rows,
    walletEvents: (await pool.query("SELECT * FROM wallet_events ORDER BY event_id")).rows,
    inventory: (await pool.query("SELECT * FROM player_inventory ORDER BY player_id,resource_type,variant")).rows,
    orders: (await pool.query("SELECT * FROM market_orders ORDER BY order_id")).rows,
    escrows: (await pool.query("SELECT * FROM market_order_escrows ORDER BY order_id")).rows,
    collections: (await pool.query("SELECT collection_id::text,source_order_id,reason,remaining_amount::text FROM market_collections ORDER BY collection_id")).rows,
    ledger: (await pool.query("SELECT * FROM market_ledger_entries ORDER BY ledger_entry_id")).rows
  };
}

async function expectForgedClaimRejected(
  pool: pg.Pool, actor: MarketActor, collectionId: string, source: string, expected: RegExp
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimId = randomUUID();
    const groupId = randomUUID();
    const requestId = `forged-expiry-${claimId}`;
    await client.query(`INSERT INTO market_claims (
      claim_id,player_id,account_id,client_request_id,asset_scope,item_units_claimed,gold_claimed,result,venue_id
    ) VALUES ($1,$2,$3,$4,'gold',0,11,'{"itemUnitsClaimed":"0","goldClaimed":"11"}'::jsonb,$5)`,
    [claimId, actor.playerId, actor.accountId, requestId, LEGACY_TEST_VENUE_ID]);
    await client.query(`INSERT INTO market_ledger_groups (ledger_group_id,group_type,request_id,claim_id,rules_version)
      VALUES ($1,'claim',$2,$3,1)`, [groupId, requestId, claimId]);
    await client.query(`INSERT INTO market_ledger_entries (
      ledger_group_id,asset_kind,amount,account_location,player_id,collection_id,reason
    ) VALUES ($1,'gold',-11,$2,$3,$4,'claim_gold_debit'),
             ($1,'gold',11,'player_wallet',$3,NULL,'claim_gold_credit')`,
    [groupId, source, actor.playerId, collectionId]);
    await expect(client.query("SELECT validate_market_claim_commit($1)", [claimId])).rejects.toThrow(expected);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
