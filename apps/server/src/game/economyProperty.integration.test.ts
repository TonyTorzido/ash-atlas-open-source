import { describe, expect, it, beforeAll, afterAll } from "vitest";
import pg from "pg";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import { setMarketControlAuditContext } from "./marketControlAudit.js";
import { DroppedItemService, DROPPED_ITEM_TTL_MS } from "./droppedItems.js";
import { reconcileDroppedItemCustody } from "./droppedItemReconciliation.js";
import { InventoryService } from "./inventory.js";
import {
  activateLegacyGlobalMarketForTest,
  createLegacyMarketTestService
} from "./legacyMarketTestAdapter.js";
import type { MarketActor } from "./marketRules.js";
import type { PlayerRecord } from "./state.js";
import { WalletService } from "./wallet.js";

const { Pool } = pg;
const databaseUrl = process.env.MARKET_TEST_DATABASE_URL;
const PROPERTY_SEED = Number(process.env.MARKET_PROPERTY_SEED ?? "600001");
const describeLive = databaseUrl ? describe : describe.skip;

type Coverage = {
  nonzeroFeeTrades: number;
  quoteReplays: number;
  quoteReplacements: number;
  failedRemainderRollbacks: number;
  dropCreates: number;
  partialPickups: number;
  fullPickups: number;
  expiries: number;
  dropReplays: number;
  restartReplays: number;
  cleanDroppedReconciliations: number;
};

describeLive("seeded economy hardening state machine", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!Number.isSafeInteger(PROPERTY_SEED) || PROPERTY_SEED <= 0) {
      throw new Error(`MARKET_PROPERTY_SEED is invalid: ${process.env.MARKET_PROPERTY_SEED}`);
    }
    assertDedicatedDatabase(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl, max: 20 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it(`covers required cross-domain states for seed ${PROPERTY_SEED}`, async () => {
    await resetEconomy(pool);
    await activateLegacyGlobalMarketForTest(pool);
    await installNonzeroFeePolicy(pool);

    const inventory = new InventoryService(pool);
    const wallet = new WalletService();
    const coverage = emptyCoverage();
    const suffix = String(PROPERTY_SEED);
    let stepIndex = 0;
    const runStep = async (label: string, operation: () => Promise<void>): Promise<void> => {
      const current = stepIndex;
      stepIndex += 1;
      try {
        await operation();
      } catch (error) {
        throw new Error(
          `economy property seed=${PROPERTY_SEED} step=${current} (${label}) failed`,
          { cause: error }
        );
      }
    };

    const feeSeller = actor("economy-fee-seller", "91000000-0000-4000-8000-000000000001");
    const feeBuyer = actor("economy-fee-buyer", "91000000-0000-4000-8000-000000000002");
    const capSeller = actor("economy-cap-seller", "91000000-0000-4000-8000-000000000003");
    const capBuyer = actor("economy-cap-buyer", "91000000-0000-4000-8000-000000000004");
    const dropper = actor("economy-dropper", "91000000-0000-4000-8000-000000000005");
    const picker = actor("economy-picker", "91000000-0000-4000-8000-000000000006");

    try {
      await runStep("seed authoritative actors and assets", async () => {
        for (const current of [feeSeller, feeBuyer, capSeller, capBuyer, dropper, picker]) {
          await seedPlayer(pool, current);
        }
        await inventory.grantItemsForOperation({
          operationKey: `economy-property-items:${suffix}:fee-seller`,
          playerId: feeSeller.playerId,
          source: "economy_property_seed",
          grants: [{ itemId: "stone", variant: null, quantity: 5 }]
        });
        await inventory.grantItemsForOperation({
          operationKey: `economy-property-items:${suffix}:cap-seller`,
          playerId: capSeller.playerId,
          source: "economy_property_seed",
          grants: [{ itemId: "stone", variant: null, quantity: 5 }]
        });
        await inventory.grantItemsForOperation({
          operationKey: `economy-property-items:${suffix}:dropper`,
          playerId: dropper.playerId,
          source: "economy_property_seed",
          grants: [{ itemId: "food", variant: null, quantity: 20 }]
        });
        await creditWallet(pool, wallet, feeBuyer, 10_000n, suffix);
        await creditWallet(pool, wallet, capBuyer, 1_000n, suffix);
      });

      const config = loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl!,
        MARKET_GLOBAL_ACCESS: "true",
        MARKET_MAX_ACTIVE_ORDERS_PER_PLAYER: "20",
        MARKET_MAX_OPEN_ORDERS_PER_ITEM: "20",
        MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK: "10",
        MARKET_QUOTE_REQUESTS_PER_MINUTE: "100"
      });
      const service = createLegacyMarketTestService(pool, config, createLogger("test"));
      const askPrice = 100n + BigInt(PROPERTY_SEED % 17);
      const buyerLimit = askPrice + 10n;
      let askOrderId = "";

      await runStep("create priced liquidity", async () => {
        const ask = await service.createOrder(feeSeller, {
          requestId: `economy-fee-ask-${suffix}`,
          interface: "merchant",
          side: "sell",
          itemId: "stone",
          quantity: "2",
          unitPrice: askPrice.toString()
        });
        askOrderId = ask.order!.orderId;
      });

      await runStep("replace and replay durable quotes", async () => {
        const firstRequest = `economy-quote-a-${suffix}`;
        const secondRequest = `economy-quote-b-${suffix}`;
        const first = await service.quote(feeBuyer, firstRequest, "stone", "1");
        const firstReplay = await service.quote(feeBuyer, firstRequest, "stone", "1");
        expect(firstReplay).toEqual(first);
        coverage.quoteReplays += 1;

        const second = await service.quote(feeBuyer, secondRequest, "stone", "1");
        expect(second.quoteId).not.toBe(first.quoteId);
        expect(await service.quote(feeBuyer, firstRequest, "stone", "1")).toEqual(first);
        const state = await pool.query<{
          first_replaced: boolean;
          active_count: string;
          request_count: string;
        }>(
          `SELECT
             bool_or(quote_id = $2 AND replaced_at IS NOT NULL) AS first_replaced,
             count(*) FILTER (
               WHERE consumed_at IS NULL AND replaced_at IS NULL
             )::text AS active_count,
             (SELECT count(*)::text FROM market_quote_requests WHERE account_id=$1)
               AS request_count
           FROM market_quotes WHERE account_id=$1`,
          [feeBuyer.accountId, first.quoteId]
        );
        expect(state.rows[0]).toEqual({
          first_replaced: true,
          active_count: "1",
          request_count: "2"
        });
        coverage.quoteReplacements += 1;
      });

      await runStep("settle nonzero buyer and seller fees", async () => {
        const fill = await service.createOrder(feeBuyer, {
          requestId: `economy-fee-bid-${suffix}`,
          interface: "merchant",
          side: "buy",
          itemId: "stone",
          quantity: "1",
          unitPrice: buyerLimit.toString()
        });
        expect(fill.trades).toHaveLength(1);
        expect(fill.trades[0]).toMatchObject({
          quantity: "1",
          unitPrice: askPrice.toString(),
          total: askPrice.toString()
        });
        const expectedBuyerFee = fee(askPrice, 900);
        const expectedSellerFee = fee(askPrice, 300);
        const expectedRefund = buyerLimit + fee(buyerLimit, 900) -
          askPrice - expectedBuyerFee;
        const settlement = await pool.query<{
          buyer_fee: string;
          seller_fee: string;
          fee_sink: string;
          refund: string;
          seller_proceeds: string;
        }>(
          `SELECT t.buyer_fee::text, t.seller_fee::text,
                  (SELECT coalesce(sum(amount),0)::text FROM market_ledger_entries
                   WHERE trade_id=t.trade_id AND account_location='fee_sink') AS fee_sink,
                  (SELECT coalesce(sum(delta_gold),0)::text FROM wallet_events
                   WHERE operation_key='market-trade-refund:' || t.trade_id::text) AS refund,
                  (SELECT coalesce(sum(delta_gold),0)::text FROM wallet_events
                   WHERE operation_key='market-trade-seller:' || t.trade_id::text) AS seller_proceeds
           FROM market_trades t WHERE t.trade_id=$1`,
          [fill.trades[0]!.tradeId]
        );
        expect(settlement.rows[0]).toEqual({
          buyer_fee: expectedBuyerFee.toString(),
          seller_fee: expectedSellerFee.toString(),
          fee_sink: (expectedBuyerFee + expectedSellerFee).toString(),
          refund: expectedRefund.toString(),
          seller_proceeds: (askPrice - expectedSellerFee).toString()
        });
        expect(expectedBuyerFee).toBeGreaterThan(0n);
        expect(expectedSellerFee).toBeGreaterThan(0n);
        coverage.nonzeroFeeTrades += 1;
      });

      await runStep("rollback a partially filled illegal remainder at the actor cap", async () => {
        const limitedConfig = loadConfig({
          NODE_ENV: "test",
          DATABASE_URL: databaseUrl!,
          MARKET_GLOBAL_ACCESS: "true",
          MARKET_MAX_ACTIVE_ORDERS_PER_PLAYER: "1",
          MARKET_MAX_OPEN_ORDERS_PER_ITEM: "20",
          MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK: "10"
        });
        const limited = createLegacyMarketTestService(pool, limitedConfig, createLogger("test"));
        const lowBid = await limited.createOrder(capBuyer, {
          requestId: `economy-cap-low-bid-${suffix}`,
          interface: "merchant",
          side: "buy",
          itemId: "stone",
          quantity: "1",
          unitPrice: "1"
        });
        const crossingAsk = await limited.createOrder(capSeller, {
          requestId: `economy-cap-crossing-ask-${suffix}`,
          interface: "merchant",
          side: "sell",
          itemId: "stone",
          quantity: "1",
          unitPrice: "10"
        });
        const before = await rollbackState(
          pool,
          capBuyer,
          lowBid.order!.orderId,
          crossingAsk.order!.orderId
        );
        await expect(limited.createOrder(capBuyer, {
          requestId: `economy-cap-illegal-remainder-${suffix}`,
          interface: "merchant",
          side: "buy",
          itemId: "stone",
          quantity: String(2 + (PROPERTY_SEED % 2)),
          unitPrice: "10"
        })).rejects.toMatchObject({ code: "MARKET_ACTIVE_ORDER_LIMIT" });
        expect(await rollbackState(
          pool,
          capBuyer,
          lowBid.order!.orderId,
          crossingAsk.order!.orderId
        )).toEqual(before);
        coverage.failedRemainderRollbacks += 1;
      });

      let nowMs = Date.UTC(2035, 0, 1) + PROPERTY_SEED * 1_000;
      const now = () => new Date(nowMs);
      const dropped = new DroppedItemService(pool, undefined, now);
      const dropperRecord = playerRecord(dropper);
      const pickerRecord = playerRecord(picker);
      const originalQuantity = 6 + (PROPERTY_SEED % 3);
      const partialQuantity = 2 + (PROPERTY_SEED % 2);
      let firstDropId = "";
      let originalDropResult: Awaited<ReturnType<DroppedItemService["dropItem"]>>;

      await runStep("create and partially pick up a world drop", async () => {
        originalDropResult = await dropped.dropItem(dropperRecord, {
          requestId: `economy-drop-main-${suffix}`,
          itemId: "food",
          variant: null,
          quantity: originalQuantity
        });
        firstDropId = originalDropResult.drop.dropId;
        coverage.dropCreates += 1;
        const partial = await dropped.pickupDroppedItem(
          pickerRecord,
          `economy-pick-partial-${suffix}`,
          firstDropId,
          { mode: "quantity", quantity: partialQuantity }
        );
        expect(partial).toMatchObject({
          pickedUpQuantity: partialQuantity,
          remainingQuantity: originalQuantity - partialQuantity,
          removed: false
        });
        coverage.partialPickups += 1;
        await expectDroppedClean(pool, coverage);
      });

      await runStep("replay original drop after partial pickup", async () => {
        const replay = await dropped.dropItem(dropperRecord, {
          requestId: `economy-drop-main-${suffix}`,
          itemId: "food",
          variant: null,
          quantity: originalQuantity
        });
        expect(replay.replayed).toBe(true);
        expect(replay.drop).toEqual(originalDropResult.drop);
        expect(replay.inventory).toEqual(originalDropResult.inventory);
        expect((await pool.query<{ remaining: string; debits: string }>(
          `SELECT d.remaining_quantity::text AS remaining,
                  (SELECT count(*)::text FROM inventory_events
                   WHERE operation_key=d.operation_key AND delta_quantity < 0) AS debits
           FROM world_item_drops d WHERE d.id=$1`,
          [firstDropId]
        )).rows[0]).toEqual({
          remaining: String(originalQuantity - partialQuantity),
          debits: "1"
        });
        coverage.dropReplays += 1;
      });

      await runStep("fully pick up and restart-replay the original drop", async () => {
        const full = await dropped.pickupDroppedItem(
          pickerRecord,
          `economy-pick-full-${suffix}`,
          firstDropId,
          { mode: "all" }
        );
        expect(full).toMatchObject({
          pickedUpQuantity: originalQuantity - partialQuantity,
          remainingQuantity: 0,
          removed: true
        });
        coverage.fullPickups += 1;
        const restarted = new DroppedItemService(pool, undefined, now);
        const replay = await restarted.dropItem(dropperRecord, {
          requestId: `economy-drop-main-${suffix}`,
          itemId: "food",
          variant: null,
          quantity: originalQuantity
        });
        expect(replay.replayed).toBe(true);
        expect(replay.drop).toEqual(originalDropResult.drop);
        coverage.restartReplays += 1;
        await expectDroppedClean(pool, coverage);
      });

      await runStep("expire once and retain replay truth", async () => {
        const expiryQuantity = 2 + (PROPERTY_SEED % 3);
        const expiring = await dropped.dropItem(dropperRecord, {
          requestId: `economy-drop-expiry-${suffix}`,
          itemId: "food",
          variant: null,
          quantity: expiryQuantity
        });
        coverage.dropCreates += 1;
        nowMs += DROPPED_ITEM_TTL_MS + 1;
        expect(await dropped.expireDue(now())).toBe(1);
        expect(await dropped.expireDue(now())).toBe(0);
        expect(await dropped.listActive("NM")).toEqual([]);
        const expiry = await pool.query<{ status: string; destruction_count: string; destroyed: string }>(
          `SELECT d.status,
                  count(m.movement_id)::text AS destruction_count,
                  coalesce(sum(m.quantity),0)::text AS destroyed
           FROM world_item_drops d
           LEFT JOIN world_item_movements m
             ON m.drop_id=d.id AND m.movement_kind='world_to_destruction'
           WHERE d.id=$1 GROUP BY d.id`,
          [expiring.drop.dropId]
        );
        expect(expiry.rows[0]).toEqual({
          status: "expired",
          destruction_count: "1",
          destroyed: String(expiryQuantity)
        });
        coverage.expiries += 1;
        const replay = await new DroppedItemService(pool, undefined, now).dropItem(
          dropperRecord,
          {
            requestId: `economy-drop-expiry-${suffix}`,
            itemId: "food",
            variant: null,
            quantity: expiryQuantity
          }
        );
        expect(replay.replayed).toBe(true);
        expect(replay.drop).toEqual(expiring.drop);
        coverage.dropReplays += 1;
        await expectDroppedClean(pool, coverage);
      });

      expect(coverage, `economy property seed=${PROPERTY_SEED} coverage`).toEqual({
        nonzeroFeeTrades: 1,
        quoteReplays: 1,
        quoteReplacements: 1,
        failedRemainderRollbacks: 1,
        dropCreates: 2,
        partialPickups: 1,
        fullPickups: 1,
        expiries: 1,
        dropReplays: 2,
        restartReplays: 1,
        cleanDroppedReconciliations: 3
      });

      expect(askOrderId).not.toBe("");
    } finally {
      await pool.query("UPDATE market_venues SET fee_policy_id=2 WHERE venue_key='global'");
    }
  }, 120_000);
});

function emptyCoverage(): Coverage {
  return {
    nonzeroFeeTrades: 0,
    quoteReplays: 0,
    quoteReplacements: 0,
    failedRemainderRollbacks: 0,
    dropCreates: 0,
    partialPickups: 0,
    fullPickups: 0,
    expiries: 0,
    dropReplays: 0,
    restartReplays: 0,
    cleanDroppedReconciliations: 0
  };
}

function actor(playerId: string, accountId: string): MarketActor {
  return { playerId, accountId };
}

function playerRecord(current: MarketActor): PlayerRecord {
  return {
    playerId: current.playerId,
    username: current.playerId,
    displayColor: null,
    regionCode: "NM",
    position: { lat: 35, lon: -106 },
    anchor: { lat: 35, lon: -106 },
    moveLeashRadiusM: 900,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date()
  };
}

async function resetEconomy(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE market_order_books CASCADE");
  await pool.query("TRUNCATE accounts CASCADE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMarketControlAuditContext(client, {
      operatorIdentity: "test:economy-property",
      reason: `reset isolated economy property seed ${PROPERTY_SEED}`
    });
    await client.query(
      `UPDATE market_global_controls
       SET read_only=false, new_orders_enabled=true, matching_enabled=true,
           cancellations_enabled=true, claims_enabled=true,
           auto_pause_on_invariant_failure=true, rules_version=1`
    );
    await client.query(
      "UPDATE market_venue_controls SET frozen=false, sensitive_reason=NULL"
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function installNonzeroFeePolicy(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO market_fee_policies (
       fee_policy_id, version, listing_fee, buyer_fee_bps, seller_fee_bps,
       cancellation_fee, active
     ) VALUES (31,3101,0,900,300,0,true)
     ON CONFLICT (fee_policy_id) DO NOTHING`
  );
  const policy = await pool.query<{
    version: number;
    buyer_fee_bps: number;
    seller_fee_bps: number;
  }>(
    `SELECT version, buyer_fee_bps, seller_fee_bps
     FROM market_fee_policies WHERE fee_policy_id=31`
  );
  expect(policy.rows[0]).toEqual({
    version: 3101,
    buyer_fee_bps: 900,
    seller_fee_bps: 300
  });
  await pool.query("UPDATE market_venues SET fee_policy_id=31 WHERE venue_key='global'");
}

async function seedPlayer(pool: pg.Pool, current: MarketActor): Promise<void> {
  await pool.query(
    "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
    [current.accountId]
  );
  await pool.query(
    `INSERT INTO players (
       id, account_id, username, username_normalized, region_code, lat, lon,
       anchor_lat, anchor_lon, move_leash_radius_m, online, geom
     ) VALUES ($1,$2,$1,$1,'NM',35,-106,35,-106,900,true,
               ST_SetSRID(ST_MakePoint(-106,35),4326))`,
    [current.playerId, current.accountId]
  );
}

async function creditWallet(
  pool: pg.Pool,
  wallet: WalletService,
  current: MarketActor,
  amount: bigint,
  suffix: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await wallet.creditForOperationInTransaction(client, {
      playerId: current.playerId,
      accountId: current.accountId,
      amount,
      operationKey: `economy-property-wallet:${suffix}:${current.playerId}`,
      reason: "economy_property_seed"
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function rollbackState(
  pool: pg.Pool,
  current: MarketActor,
  lowBidOrderId: string,
  askOrderId: string
): Promise<Record<string, unknown>> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT
       (SELECT gold_balance::text FROM player_wallets WHERE account_id=$1) AS wallet,
       (SELECT version::text FROM player_wallets WHERE account_id=$1) AS wallet_version,
       (SELECT count(*)::text FROM wallet_events WHERE account_id=$1) AS wallet_events,
       (SELECT count(*)::text FROM market_requests) AS requests,
       (SELECT count(*)::text FROM market_orders) AS orders,
       (SELECT count(*)::text FROM market_trades) AS trades,
       (SELECT count(*)::text FROM market_collections) AS collections,
       (SELECT count(*)::text FROM market_ledger_groups) AS ledger_groups,
       (SELECT count(*)::text FROM market_ledger_entries) AS ledger_entries,
       (SELECT remaining_quantity::text FROM market_orders WHERE order_id=$2) AS low_bid_remaining,
       (SELECT remaining_quantity::text FROM market_orders WHERE order_id=$3) AS ask_remaining,
       (SELECT remaining_amount::text FROM market_order_escrows WHERE order_id=$3) AS ask_escrow`,
    [current.accountId, lowBidOrderId, askOrderId]
  );
  return result.rows[0] ?? {};
}

async function expectDroppedClean(pool: pg.Pool, coverage: Coverage): Promise<void> {
  const issues = await reconcileDroppedItemCustody(pool);
  expect(issues, `economy property seed=${PROPERTY_SEED} dropped reconciliation`).toEqual([]);
  coverage.cleanDroppedReconciliations += 1;
}

function fee(value: bigint, basisPoints: number): bigint {
  return value * BigInt(basisPoints) / 10_000n;
}

function assertDedicatedDatabase(url: string): void {
  const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!database.endsWith("_test") && !database.endsWith("_validation")) {
    throw new Error(
      `Economy property tests require a dedicated *_test or *_validation database; received ${database}`
    );
  }
}
