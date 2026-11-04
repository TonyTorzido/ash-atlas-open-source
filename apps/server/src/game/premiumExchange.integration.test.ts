import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import { DevelopmentEconomyService } from "./developmentEconomy.js";
import { EquipmentService } from "./equipment.js";
import { DroppedItemService } from "./droppedItems.js";
import { InventoryService } from "./inventory.js";
import { validateItemDefinitionCatalog } from "./items.js";
import {
  activateLegacyGlobalMarketForTest,
  createLegacyMarketTestService,
  type LegacyMarketTestService
} from "./legacyMarketTestAdapter.js";
import { setMarketControlAuditContext } from "./marketControlAudit.js";
import { MarketReconciliationService } from "./marketReconciliation.js";
import type { MarketActor } from "./marketRules.js";
import { PremiumWalletService } from "./premiumWallet.js";

const databaseUrl = process.env.MARKET_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe.sequential : describe.skip;
const { Pool } = pg;

const seller: MarketActor = {
  playerId: "premium-seller",
  accountId: "00000000-0000-4000-8000-000000000911"
};
const buyer: MarketActor = {
  playerId: "premium-buyer",
  accountId: "00000000-0000-4000-8000-000000000912"
};
const GLIMMER = "currency:glimmer";
const LUMEN = "lumen";

describeDatabase("Glimmer exchange and carried Lumen", () => {
  let pool: pg.Pool;
  let service: LegacyMarketTestService;
  let reconcile: MarketReconciliationService;
  const premium = new PremiumWalletService();
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    MARKET_GLOBAL_ACCESS: "true",
    MARKET_TRANSACTION_RETRY_LIMIT: "3"
  });

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 10 });
    service = createLegacyMarketTestService(pool, config, createLogger("test"));
    reconcile = new MarketReconciliationService(pool);
    // Startup contract: the Lumen row must match the compiled item catalog.
    await validateItemDefinitionCatalog(pool);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE market_order_books CASCADE");
    await pool.query("TRUNCATE accounts CASCADE");
    await resetControls(pool);
    await activateLegacyGlobalMarketForTest(pool);
    await pool.query("UPDATE market_venues SET fee_policy_id = 2 WHERE venue_key = 'global'");
    await pool.query("UPDATE market_fee_policies SET active = true WHERE fee_policy_id = 2");
    await seedActor(pool, seller, 0n);
    await seedActor(pool, buyer, 100_000n);
    await grantGlimmer(pool, premium, seller, 1_000n);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("escrows from the premium wallet, charges the seller's rounded-up fee per fill, and returns unused escrow", async () => {
    const listing = await service.createOrder(seller, order("premium-sell-0001", "sell", "100", "10"));
    expect(listing.order).toMatchObject({ itemId: "glimmer", itemIdentity: GLIMMER, remainingQuantity: "100" });
    expect(await balance(pool, seller)).toBe(895n);
    expect(await escrow(pool, listing.order!.orderId)).toBe(105n);
    await expect(pool.query(
      "SELECT 1 FROM player_inventory WHERE resource_type = 'glimmer'"
    )).resolves.toMatchObject({ rowCount: 0 });

    const fill = await service.createOrder(buyer, order("premium-buy-00001", "buy", "40", "10"));
    expect(fill.trades).toHaveLength(1);
    expect(fill.trades[0]).toMatchObject({ quantity: "40", unitPrice: "10" });
    expect(await balance(pool, buyer)).toBe(40n);
    // ceil(40 * 5%) = 2 goes to the fee sink; escrow keeps 60 units + 3 unused reserve.
    expect(await escrow(pool, listing.order!.orderId)).toBe(63n);
    expect(await currencyFeeSink(pool)).toBe(2n);
    expect(await gold(pool, seller)).toBe(400n);

    const replay = await service.createOrder(buyer, order("premium-buy-00001", "buy", "40", "10"));
    expect(replay.replayed).toBe(true);
    expect(await balance(pool, buyer)).toBe(40n);
    expect(await escrow(pool, listing.order!.orderId)).toBe(63n);

    const cancelled = await service.cancelOrder(seller, "premium-cancel-01", listing.order!.orderId);
    expect(cancelled.order?.status).toBe("cancelled");
    expect(await balance(pool, seller)).toBe(958n);
    const cancelReplay = await service.cancelOrder(seller, "premium-cancel-01", listing.order!.orderId);
    expect(cancelReplay.replayed).toBe(true);
    expect(await balance(pool, seller)).toBe(958n);
    // Conservation: nothing minted, the fee left supply.
    expect(await balance(pool, seller) + await balance(pool, buyer) + await currencyFeeSink(pool)).toBe(1_000n);
    expect(await pool.query(
      "SELECT 1 FROM market_collections WHERE item_id = 'glimmer'"
    )).toMatchObject({ rowCount: 0 });
    // Observatory: the currency fee is a sink, everything else a balanced transfer.
    expect(await observedGlimmer(pool)).toEqual({ sink: await currencyFeeSink(pool), source: 0n });

    const report = await reconcile.reconcile({ honorAutomaticProtection: false });
    expect(report.issues).toEqual([]);
  });

  it("fills a resting bid from an incoming sell and pays the fee exactly once over partial fills", async () => {
    await service.createOrder(buyer, order("premium-bid-00001", "buy", "30", "12"));
    const sell = await service.createOrder(seller, order("premium-sell-0002", "sell", "50", "11"));
    expect(sell.trades).toEqual([expect.objectContaining({ quantity: "30", unitPrice: "12" })]);
    // Reserve ceil(50 * 5%) = 3; first fill charged ceil(30 * 5%) = 2.
    expect(await escrow(pool, sell.order!.orderId)).toBe(21n);
    await service.createOrder(buyer, order("premium-buy-00002", "buy", "20", "11"));
    expect(await escrow(pool, sell.order!.orderId)).toBe(0n);
    expect(await currencyFeeSink(pool)).toBe(3n);
    expect(await balance(pool, seller)).toBe(947n);
    expect(await balance(pool, buyer)).toBe(50n);
    const report = await reconcile.reconcile({ honorAutomaticProtection: false });
    expect(report.issues).toEqual([]);
  });

  it("returns expired premium escrow straight to the premium wallet", async () => {
    await pool.query(
      "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() - interval '1 second')"
    );
    let orderId: string;
    try {
      orderId = (await service.createOrder(seller, order("premium-sell-0003", "sell", "10", "10"))).order!.orderId;
    } finally {
      await pool.query(
        "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days')"
      );
    }
    expect(await balance(pool, seller)).toBe(989n);
    await expect(service.expireDueOrders()).resolves.toMatchObject({ materialOrders: 1 });
    expect(await balance(pool, seller)).toBe(1_000n);
    expect((await pool.query("SELECT status FROM market_orders WHERE order_id = $1", [orderId])).rows[0])
      .toEqual({ status: "expired" });
    expect(await pool.query("SELECT 1 FROM market_collections")).toMatchObject({ rowCount: 0 });
    const report = await reconcile.reconcile({ honorAutomaticProtection: false });
    expect(report.issues).toEqual([]);
  });

  it("rejects listings that cannot cover quantity plus fee", async () => {
    await expect(service.createOrder(seller, order("premium-sell-0004", "sell", "960", "10")))
      .rejects.toMatchObject({ code: "MARKET_NOT_ENOUGH_ITEMS" });
    expect(await balance(pool, seller)).toBe(1_000n);
    await service.createOrder(seller, order("premium-sell-0005", "sell", "952", "10"));
    expect(await balance(pool, seller)).toBe(0n);
  });

  it("never lets premium currency reach inventory or be credited without a market fill", async () => {
    const inventory = new InventoryService(pool);
    await expect(inventory.grantItemsForOperation({
      operationKey: "premium-inventory-grant-attempt",
      playerId: buyer.playerId,
      source: "test",
      grants: [{ itemId: "glimmer" as never, variant: null, quantity: 5 }]
    } as never)).rejects.toThrow();
    await expect(pool.query(
      `INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
       VALUES ($1, 'glimmer', 'default', 5, 1)`,
      [buyer.playerId]
    )).rejects.toThrow(/premium currency cannot be held/);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await premium.creditForMarketInTransaction(client, {
        accountId: buyer.accountId,
        actorPlayerId: buyer.playerId,
        currency: "glimmer",
        amount: 500n,
        operationKey: "market-trade-premium:00000000-0000-4000-8000-00000000dead",
        reason: "market",
        refType: "market_trade",
        refId: "00000000-0000-4000-8000-00000000dead"
      });
      await expect(client.query("COMMIT")).rejects.toThrow(/no matching premium fill/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(await balance(pool, buyer)).toBe(0n);
  });

  it("trades Lumen as an ordinary inventory item: inventory escrow, no currency fee, replay-safe", async () => {
    await grantLumen(pool, seller, "lumen-grant-seller", 100n);
    expect(await carried(pool, seller, LUMEN)).toBe(100n);

    const listing = await service.createOrder(seller, lumenOrder("lumen-sell-00001", "sell", "40", "25"));
    expect(listing.order).toMatchObject({ itemId: LUMEN, itemIdentity: LUMEN, remainingQuantity: "40" });
    expect(await carried(pool, seller, LUMEN)).toBe(60n);
    expect(await escrow(pool, listing.order!.orderId)).toBe(40n);
    expect(await pool.query("SELECT 1 FROM market_premium_sell_terms")).toMatchObject({ rowCount: 0 });
    const listingReplay = await service.createOrder(seller, lumenOrder("lumen-sell-00001", "sell", "40", "25"));
    expect(listingReplay.replayed).toBe(true);
    expect(await carried(pool, seller, LUMEN)).toBe(60n);

    const fill = await service.createOrder(buyer, lumenOrder("lumen-buy-000001", "buy", "15", "25"));
    expect(fill.trades).toEqual([expect.objectContaining({ quantity: "15", unitPrice: "25" })]);
    expect(await carried(pool, buyer, LUMEN)).toBe(15n);
    expect(await gold(pool, seller)).toBe(375n);
    const fillReplay = await service.createOrder(buyer, lumenOrder("lumen-buy-000001", "buy", "15", "25"));
    expect(fillReplay.replayed).toBe(true);
    expect(await carried(pool, buyer, LUMEN)).toBe(15n);
    expect(await escrow(pool, listing.order!.orderId)).toBe(25n);

    await service.cancelOrder(seller, "lumen-cancel-0001", listing.order!.orderId);
    const cancelReplay = await service.cancelOrder(seller, "lumen-cancel-0001", listing.order!.orderId);
    expect(cancelReplay.replayed).toBe(true);
    expect(await carried(pool, seller, LUMEN)).toBe(85n);
    // Conservation: nothing minted, no currency fee on an ordinary item.
    expect(await carried(pool, seller, LUMEN) + await carried(pool, buyer, LUMEN)).toBe(100n);
    expect(await pool.query(
      "SELECT 1 FROM market_ledger_entries WHERE item_identity = $1 AND account_location IN ('fee_sink', 'premium_wallet')",
      [LUMEN]
    )).toMatchObject({ rowCount: 0 });
    // Observatory: Gold buyer tax and seller fees on the Gold book are sinks, counted once.
    const goldFees = await pool.query<{ fees: string }>(
      `SELECT coalesce(sum(t.buyer_fee + t.seller_fee), 0)::text AS fees
       FROM market_trades t JOIN market_order_books b ON b.book_id = t.book_id
       WHERE b.price_currency = 'gold'`
    );
    expect(BigInt(goldFees.rows[0]!.fees)).toBeGreaterThan(0n);
    expect(await observedGoldSink(pool, "market_ledger_entries")).toBe(BigInt(goldFees.rows[0]!.fees));
    const report = await reconcile.reconcile({ honorAutomaticProtection: false });
    expect(report.issues).toEqual([]);
  });

  it("drops Lumen on the ground for anyone to pick up, and never mints it", async () => {
    await grantLumen(pool, seller, "lumen-grant-drop", 30n);
    const drops = new DroppedItemService(pool);
    const position = { lat: 35, lon: -106 };
    const dropped = await drops.dropItem(
      { playerId: seller.playerId, regionCode: "NM", position },
      { requestId: "lumen-drop-00001", itemId: LUMEN, variant: null, quantity: 12 }
    );
    expect(await carried(pool, seller, LUMEN)).toBe(18n);
    const replayDrop = await drops.dropItem(
      { playerId: seller.playerId, regionCode: "NM", position },
      { requestId: "lumen-drop-00001", itemId: LUMEN, variant: null, quantity: 12 }
    );
    expect(replayDrop.drop.dropId).toBe(dropped.drop.dropId);
    expect(await carried(pool, seller, LUMEN)).toBe(18n);

    await drops.pickupDroppedItem(
      { playerId: buyer.playerId, regionCode: "NM", position },
      "lumen-pickup-0001",
      dropped.drop.dropId
    );
    await drops.pickupDroppedItem(
      { playerId: buyer.playerId, regionCode: "NM", position },
      "lumen-pickup-0001",
      dropped.drop.dropId
    );
    expect(await carried(pool, buyer, LUMEN)).toBe(12n);

    const inventory = new InventoryService(pool);
    await expect(inventory.grantItemsForOperation({
      operationKey: "lumen-free-grant-attempt",
      playerId: buyer.playerId,
      source: "combat_wolf_reward",
      grants: [{ itemId: LUMEN as never, variant: null, quantity: 5 }]
    } as never)).rejects.toThrow(/Lumen cannot enter inventory/);
    await expect(pool.query(
      `INSERT INTO world_item_drops (
         id, operation_key, dropped_by, region_code, zone_id, pile_id, pile_order, item_id, variant,
         original_quantity, remaining_quantity, status, lat, lon, geom, created_at, expires_at
       ) SELECT gen_random_uuid(), operation_key, player_id, 'NM', 'NM', 'forged', 0, 'lumen', 'default',
                500, 500, 'active', 35, -106, ST_SetSRID(ST_MakePoint(-106, 35), 4326), now(),
                now() + interval '1 hour'
         FROM inventory_operations WHERE operation_key = 'dev-grant:lumen-grant-drop:lumen'`
    )).rejects.toThrow(/no matching inventory debit/);
    await expect(pool.query(
      `INSERT INTO premium_wallets (account_id, currency, balance, version)
       VALUES ($1, 'lumen', 0, 0) ON CONFLICT DO NOTHING`,
      [buyer.accountId]
    ).then(() => pool.query(
      `INSERT INTO premium_wallet_events (
         account_id, currency, operation_key, delta, balance_after, version_after, reason
       ) VALUES ($1, 'lumen', 'lumen-wallet-attempt', 5, 5, 1, 'admin')`,
      [buyer.accountId]
    ))).rejects.toThrow(/Lumen premium wallet is closed/);
    expect(await carried(pool, seller, LUMEN) + await carried(pool, buyer, LUMEN)).toBe(30n);
  });

  it("settles a Glimmer-priced book from the premium wallet, apart from the Gold book, replay-safe", async () => {
    await grantLumen(pool, seller, "lumen-grant-glimmer-book", 100n);
    await grantGlimmer(pool, premium, buyer, 2_000n, "buyer");
    const sellerBefore = await balance(pool, seller);
    const buyerBefore = await balance(pool, buyer);
    const glimmerBefore = sellerBefore + buyerBefore;

    const glimmerAsk = await service.createOrder(seller, priced("glimmer-ask-0001", "sell", "40", "5", "glimmer"));
    expect(glimmerAsk.order).toMatchObject({ itemIdentity: LUMEN, priceCurrency: "glimmer" });
    const goldAsk = await service.createOrder(seller, priced("gold-ask-000001", "sell", "10", "50", "gold"));
    expect(goldAsk.order?.priceCurrency).toBeUndefined();
    // A Gold bid never reaches the Glimmer listing even though it is far cheaper.
    const goldBid = await service.createOrder(buyer, priced("gold-bid-000001", "buy", "5", "40", "gold"));
    expect(goldBid.trades).toEqual([]);
    await service.cancelOrder(buyer, "gold-bid-cancel-1", goldBid.order!.orderId);
    expect(await gold(pool, buyer)).toBe(100_000n);

    const bid = await service.createOrder(buyer, priced("glimmer-bid-0001", "buy", "15", "6", "glimmer"));
    expect(bid.trades).toEqual([expect.objectContaining({ quantity: "15", unitPrice: "5" })]);
    expect(bid.order?.priceCurrency).toBe("glimmer");
    const bidReplay = await service.createOrder(buyer, priced("glimmer-bid-0001", "buy", "15", "6", "glimmer"));
    expect(bidReplay.replayed).toBe(true);
    expect(await carried(pool, buyer, LUMEN)).toBe(15n);
    // Gold never moved for a Glimmer-priced fill.
    expect(await gold(pool, buyer)).toBe(100_000n);
    expect(await gold(pool, seller)).toBe(0n);

    const resting = await service.createOrder(buyer, priced("glimmer-bid-0002", "buy", "10", "3", "glimmer"));
    expect(resting.trades).toEqual([]);
    const beforeCancel = await balance(pool, buyer);
    await service.cancelOrder(buyer, "glimmer-cancel-01", resting.order!.orderId);
    const cancelReplay = await service.cancelOrder(buyer, "glimmer-cancel-01", resting.order!.orderId);
    expect(cancelReplay.replayed).toBe(true);
    expect(await balance(pool, buyer)).toBeGreaterThan(beforeCancel);

    const quote = await service.quote(buyer, "glimmer-quote-001", LUMEN, "5", undefined, "glimmer");
    expect(quote).toMatchObject({ fullQuantityAvailable: true, priceCurrency: "glimmer", maximumUnitPrice: "5" });
    const simple = await service.simpleBuy(buyer, "glimmer-simple-01", quote.quoteId, quote.quotedTotal);
    expect(simple.trades.reduce((sum, trade) => sum + BigInt(trade.quantity), 0n)).toBe(5n);
    const simpleReplay = await service.simpleBuy(buyer, "glimmer-simple-01", quote.quoteId, quote.quotedTotal);
    expect(simpleReplay.replayed).toBe(true);
    expect(await carried(pool, buyer, LUMEN)).toBe(20n);

    const book = await service.read.book(buyer, LUMEN, undefined, "glimmer");
    expect(book.item).toMatchObject({ priceCurrency: "glimmer", availableSellQuantity: "20" });
    expect((await service.read.book(buyer, LUMEN)).item).toMatchObject({ availableSellQuantity: "10" });
    // The catalog row (Gold summary) also carries the Glimmer book.
    const row = (await service.read.snapshot(buyer, { search: "Lumen" })).items
      .find((item) => item.itemIdentity === LUMEN);
    expect(row).toMatchObject({
      bestAsk: "50", availableSellQuantity: "10", glimmerBestAsk: "5", glimmerSellQuantity: "20"
    });

    // Seller proceeds and buyer spend reconcile exactly with the trades in Glimmer.
    const legs = await pool.query<{ paid: string; proceeds: string; fees: string }>(
      `SELECT sum(t.gross_value + t.buyer_fee)::text AS paid,
              sum(t.gross_value - t.seller_fee)::text AS proceeds,
              sum(t.buyer_fee + t.seller_fee)::text AS fees
       FROM market_trades t JOIN market_order_books b ON b.book_id = t.book_id
       WHERE b.price_currency = 'glimmer'`
    );
    expect(await balance(pool, seller)).toBe(sellerBefore + BigInt(legs.rows[0]!.proceeds));
    expect(await balance(pool, buyer)).toBe(buyerBefore - BigInt(legs.rows[0]!.paid));
    expect(await balance(pool, seller) + await balance(pool, buyer) + await glimmerPriceFees(pool))
      .toBe(glimmerBefore);
    expect(await glimmerPriceFees(pool)).toBe(BigInt(legs.rows[0]!.fees));
    // Observatory: buyer tax and seller fee in Glimmer are sinks; nothing is minted.
    expect(await observedGlimmer(pool)).toEqual({ sink: await glimmerPriceFees(pool), source: 0n });

    await expect(service.createOrder(seller, {
      requestId: "glimmer-for-glimmer", interface: "merchant", side: "sell",
      itemIdentity: GLIMMER, quantity: "1", unitPrice: "1", priceCurrency: "glimmer"
    })).rejects.toMatchObject({ code: "MARKET_ITEM_NOT_TRADABLE" });

    const report = await reconcile.reconcile({ honorAutomaticProtection: false });
    expect(report.issues).toEqual([]);
  });

  it("returns expired Glimmer bid escrow to the wallet and rejects unbacked Glimmer credits", async () => {
    await grantGlimmer(pool, premium, buyer, 500n, "buyer-expiry");
    await pool.query(
      "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() - interval '1 second')"
    );
    try {
      await service.createOrder(buyer, priced("glimmer-bid-exp01", "buy", "10", "7", "glimmer"));
    } finally {
      await pool.query(
        "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days')"
      );
    }
    expect(await balance(pool, buyer)).toBeLessThan(500n);
    await expect(service.expireDueOrders()).resolves.toMatchObject({ materialOrders: 1 });
    expect(await balance(pool, buyer)).toBe(500n);
    expect(await pool.query("SELECT 1 FROM market_collections")).toMatchObject({ rowCount: 0 });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await premium.creditForMarketInTransaction(client, {
        accountId: seller.accountId,
        actorPlayerId: seller.playerId,
        currency: "glimmer",
        amount: 50n,
        operationKey: "market-trade-proceeds:00000000-0000-4000-8000-00000000beef",
        reason: "market",
        refType: "market_trade",
        refId: "00000000-0000-4000-8000-00000000beef"
      });
      await expect(client.query("COMMIT")).rejects.toThrow(/no matching premium fill/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const report = await reconcile.reconcile({ honorAutomaticProtection: false });
    expect(report.issues).toEqual([]);
  });

  it("sells exact equipment for Glimmer: list, buy and cancel settle in the premium wallet, replay-safe", async () => {
    const equipmentMarket = createLegacyMarketTestService(pool, config, createLogger("test"), {
      equipment: new EquipmentService(pool)
    });
    await grantGlimmer(pool, premium, buyer, 2_000n, "equipment");
    const [shieldA, shieldB, shieldC] = await grantShields(pool, seller, 3);
    const sellerGlimmer = await balance(pool, seller);
    const buyerGlimmer = await balance(pool, buyer);

    const revision = await equipmentRevision(pool, seller);
    const listed = await equipmentMarket.createEquipmentListing(
      seller, CONNECTION, SESSION, "equip-list-0001", shieldA!, "300", revision, "glimmer"
    );
    const listing = listed.result.equipmentListing!;
    expect(listing).toMatchObject({ priceCurrency: "glimmer", askingPrice: "300" });
    const listReplay = await equipmentMarket.createEquipmentListing(
      seller, CONNECTION, SESSION, "equip-list-0001", shieldA!, "300", revision, "glimmer"
    );
    expect(listReplay.result.replayed).toBe(true);
    // The same request id priced in Gold is a different intent.
    await expect(equipmentMarket.createEquipmentListing(
      seller, CONNECTION, SESSION, "equip-list-0001", shieldA!, "300", revision, "gold"
    )).rejects.toMatchObject({ code: "MARKET_REPLAY_CONFLICT" });

    const taxRevision = (await equipmentMarket.read.snapshot(buyer)).venue.taxRevision;
    // Consent: a buyer who saw a Gold price is never charged Glimmer.
    await expect(equipmentMarket.purchaseEquipmentListing(
      buyer, CONNECTION, SESSION, "equip-buy-gold-1", listing.listingId, listing.version,
      listing.buyerTotal, taxRevision, "gold"
    )).rejects.toMatchObject({ code: "MARKET_EQUIPMENT_LISTING_STALE" });
    expect(await balance(pool, buyer)).toBe(buyerGlimmer);
    expect(await gold(pool, buyer)).toBe(100_000n);
    const bought = await equipmentMarket.purchaseEquipmentListing(
      buyer, CONNECTION, SESSION, "equip-buy-00001", listing.listingId, listing.version,
      listing.buyerTotal, taxRevision, "glimmer"
    );
    expect(bought.result.equipmentListing).toMatchObject({ status: "sold", priceCurrency: "glimmer" });
    const buyReplay = await equipmentMarket.purchaseEquipmentListing(
      buyer, CONNECTION, SESSION, "equip-buy-00001", listing.listingId, listing.version,
      listing.buyerTotal, taxRevision, "glimmer"
    );
    expect(buyReplay.result.replayed).toBe(true);
    expect(await balance(pool, buyer)).toBe(buyerGlimmer - BigInt(listing.buyerTotal));
    expect(await balance(pool, seller)).toBe(sellerGlimmer + 300n);
    expect(await gold(pool, buyer)).toBe(100_000n);
    expect(await gold(pool, seller)).toBe(0n);
    // Observatory: one 300 Glimmer transfer buyer to seller, and the buyer tax as a sink.
    expect(await observedGlimmer(pool)).toEqual({ sink: BigInt(listing.buyerTax), source: 0n });
    await expect(pool.query(
      `SELECT leg, quantity::text, player_id FROM economy_events
       WHERE source_system = 'market_equipment_ledger' AND event_kind = 'TRANSFER'
       ORDER BY leg`
    )).resolves.toMatchObject({ rows: [
      { leg: "credit", quantity: "300", player_id: seller.playerId },
      { leg: "debit", quantity: "300", player_id: buyer.playerId }
    ] });
    await expect(pool.query("SELECT owner_player_id FROM equipment_instances WHERE instance_id = $1", [shieldA]))
      .resolves.toMatchObject({ rows: [{ owner_player_id: buyer.playerId }] });

    const second = await equipmentMarket.createEquipmentListing(
      seller, CONNECTION, SESSION, "equip-list-0002", shieldB!, "500",
      await equipmentRevision(pool, seller), "glimmer"
    );
    const cancel = await equipmentMarket.cancelEquipmentListing(
      seller, CONNECTION, SESSION, "equip-cancel-001", second.result.equipmentListing!.listingId,
      second.result.equipmentListing!.version
    );
    expect(cancel.result.equipmentListing?.status).toBe("cancelled");
    const cancelReplay = await equipmentMarket.cancelEquipmentListing(
      seller, CONNECTION, SESSION, "equip-cancel-001", second.result.equipmentListing!.listingId,
      second.result.equipmentListing!.version
    );
    expect(cancelReplay.result.replayed).toBe(true);
    expect(await balance(pool, seller)).toBe(sellerGlimmer + 300n);

    // A Gold listing still settles in Gold only.
    const goldListing = (await equipmentMarket.createEquipmentListing(
      seller, CONNECTION, SESSION, "equip-list-0003", shieldC!, "40",
      await equipmentRevision(pool, seller), "gold"
    )).result.equipmentListing!;
    expect(goldListing.priceCurrency).toBeUndefined();
    await equipmentMarket.purchaseEquipmentListing(
      buyer, CONNECTION, SESSION, "equip-buy-00003", goldListing.listingId, goldListing.version,
      goldListing.buyerTotal, taxRevision, "gold"
    );
    expect(await gold(pool, seller)).toBe(40n);
    expect(await gold(pool, buyer)).toBe(100_000n - BigInt(goldListing.buyerTotal));
    // Observatory: the Gold buyer tax is a sink; the 40 Gold is a buyer-to-seller transfer.
    expect(await observedGoldSink(pool, "market_equipment_ledger")).toBe(BigInt(goldListing.buyerTax));
    expect(await balance(pool, seller)).toBe(sellerGlimmer + 300n);

    // No free Glimmer: a second seller credit for the sold listing is refused at commit.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await premium.creditForMarketInTransaction(client, {
        accountId: seller.accountId,
        actorPlayerId: seller.playerId,
        currency: "glimmer",
        amount: 300n,
        operationKey: "market-equipment-seller-forged",
        reason: "market",
        refType: "market_equipment_listing",
        refId: listing.listingId
      });
      await expect(client.query("COMMIT")).rejects.toThrow(/equipment/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(await balance(pool, seller)).toBe(sellerGlimmer + 300n);
  });

  it("ignores a thin-market price spike: the breaker needs real volume in both windows", async () => {
    await pool.query("ALTER TABLE market_trades ALTER COLUMN created_at SET DEFAULT (now() - interval '30 hours')");
    try {
      await service.createOrder(seller, order("premium-sell-0006", "sell", "20", "10"));
      await service.createOrder(buyer, order("premium-buy-00006", "buy", "20", "10"));
    } finally {
      await pool.query("ALTER TABLE market_trades ALTER COLUMN created_at SET DEFAULT now()");
    }
    // One tiny trade at 4x the prior price, e.g. two colluding accounts.
    await service.createOrder(seller, order("premium-sell-0008", "sell", "20", "40"));
    const spike = await service.createOrder(buyer, order("premium-buy-00008", "buy", "20", "40"));
    expect(spike.trades.length).toBe(1);
    expect(await bookFrozen(pool)).toBe(false);
  });

  it("freezes on a real 24-hour VWAP move and still lets owners cancel their escrow", async () => {
    await grantGlimmer(pool, premium, seller, 5_000n, "breaker");
    const roundTrips = async (prefix: string, price: string, count: number): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        await service.createOrder(seller, order(`${prefix}-sell-${index}`, "sell", "200", price));
        await service.createOrder(buyer, order(`${prefix}-buy--${index}`, "buy", "200", price));
      }
    };
    await pool.query("ALTER TABLE market_trades ALTER COLUMN created_at SET DEFAULT (now() - interval '30 hours')");
    try {
      await roundTrips("breaker-prior", "10", 5);
    } finally {
      await pool.query("ALTER TABLE market_trades ALTER COLUMN created_at SET DEFAULT now()");
    }
    await roundTrips("breaker-today", "20", 4);
    expect(await bookFrozen(pool)).toBe(false);
    const resting = await service.createOrder(seller, order("breaker-resting-01", "sell", "100", "50"));
    await roundTrips("breaker-final", "20", 1);
    expect(await bookFrozen(pool)).toBe(true);
    await expect(service.createOrder(buyer, order("premium-buy-00009", "buy", "1", "40")))
      .rejects.toMatchObject({ code: "MARKET_ITEM_FROZEN" });
    const beforeCancel = await balance(pool, seller);
    const cancelled = await service.cancelOrder(seller, "breaker-cancel-01", resting.order!.orderId);
    expect(cancelled.order?.status).toBe("cancelled");
    expect(await balance(pool, seller)).toBe(beforeCancel + 105n);
    // The breaker mark cannot outlive its freeze: unfreeze then refreeze by hand
    // (no reason given) and cancels are blocked again.
    const another = await pool.query<{ order_id: string }>(
      "SELECT order_id::text FROM market_orders WHERE status IN ('open', 'partially_filled') AND side = 'sell' LIMIT 1"
    );
    await setBookFrozen(pool, false);
    expect(await bookReason(pool)).toBeNull();
    const resting2 = another.rows[0]?.order_id
      ?? (await service.createOrder(seller, order("breaker-resting-02", "sell", "10", "50"))).order!.orderId;
    await setBookFrozen(pool, true);
    await expect(service.cancelOrder(seller, "breaker-cancel-02", resting2))
      .rejects.toMatchObject({ code: "MARKET_ITEM_FROZEN" });
    const audit = await pool.query<{ operator: string }>(
      `SELECT evidence->>'operatorIdentity' AS operator FROM market_audit_events
       WHERE event_type = 'market_control_changed'
         AND evidence->>'operatorIdentity' = 'system:premium-rate-breaker' LIMIT 1`
    );
    expect(audit.rows[0]?.operator).toBe("system:premium-rate-breaker");
  });
});

const CONNECTION = "legacy-market-test-connection";
const SESSION = "00000000-0000-4000-8000-000000000601";

async function grantShields(pool: pg.Pool, actor: MarketActor, count: number): Promise<string[]> {
  const equipment = new EquipmentService(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await equipment.grantPackageInstancesInTransaction(client, {
      operationKey: `test-shields:${actor.playerId}`,
      playerId: actor.playerId,
      grants: [{ definitionId: "training_shield", quantity: count }]
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const result = await pool.query<{ instance_id: string }>(
    `SELECT instance_id::text FROM equipment_instances
     WHERE owner_player_id = $1 AND definition_id = 'training_shield' AND location = 'inventory'
     ORDER BY instance_id`,
    [actor.playerId]
  );
  return result.rows.map((row) => row.instance_id);
}

async function equipmentRevision(pool: pg.Pool, actor: MarketActor): Promise<string> {
  const result = await pool.query<{ revision: string }>(
    "SELECT inventory_revision::text AS revision FROM player_equipment_state WHERE player_id = $1",
    [actor.playerId]
  );
  return result.rows[0]?.revision ?? "0";
}

function order(requestId: string, side: "buy" | "sell", quantity: string, unitPrice: string) {
  return { requestId, interface: "merchant" as const, side, itemIdentity: GLIMMER, quantity, unitPrice };
}

function priced(
  requestId: string,
  side: "buy" | "sell",
  quantity: string,
  unitPrice: string,
  priceCurrency: "gold" | "glimmer"
) {
  return { requestId, interface: "merchant" as const, side, itemIdentity: LUMEN, quantity, unitPrice, priceCurrency };
}

async function observedGoldSink(pool: pg.Pool, sourceSystem: string): Promise<bigint> {
  const result = await pool.query<{ sink: string }>(
    `SELECT coalesce(sum(quantity), 0)::text AS sink FROM economy_events
     WHERE asset_id = 'gold' AND event_kind = 'SINK' AND source_system = $1`,
    [sourceSystem]
  );
  return BigInt(result.rows[0]!.sink);
}

/** Glimmer leaving or entering supply in the Economy Observatory (excluding admin grants). */
async function observedGlimmer(pool: pg.Pool): Promise<{ sink: bigint; source: bigint }> {
  const result = await pool.query<{ sink: string; source: string }>(
    `SELECT coalesce(sum(quantity) FILTER (WHERE event_kind = 'SINK'), 0)::text AS sink,
            coalesce(sum(quantity) FILTER (WHERE event_kind = 'SOURCE'), 0)::text AS source
     FROM economy_events WHERE asset_id = 'currency:glimmer'`
  );
  return { sink: BigInt(result.rows[0]!.sink), source: BigInt(result.rows[0]!.source) };
}

async function setBookFrozen(pool: pg.Pool, frozen: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMarketControlAuditContext(client, {
      operatorIdentity: "test:premium-exchange",
      reason: frozen ? "manual refreeze" : "manual unfreeze"
    });
    await client.query("UPDATE market_order_books SET frozen = $2 WHERE item_identity = $1", [GLIMMER, frozen]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

async function bookReason(pool: pg.Pool): Promise<string | null> {
  const result = await pool.query<{ reason: string | null }>(
    "SELECT sensitive_reason AS reason FROM market_order_books WHERE item_identity = $1",
    [GLIMMER]
  );
  return result.rows[0]?.reason ?? null;
}

async function glimmerPriceFees(pool: pg.Pool): Promise<bigint> {
  const result = await pool.query<{ total: string }>(
    `SELECT coalesce(sum(amount), 0)::text AS total FROM market_ledger_entries
     WHERE account_location = 'fee_sink' AND asset_kind = 'glimmer'`
  );
  return BigInt(result.rows[0]!.total);
}

function lumenOrder(requestId: string, side: "buy" | "sell", quantity: string, unitPrice: string) {
  return { requestId, interface: "merchant" as const, side, itemIdentity: LUMEN, quantity, unitPrice };
}

async function grantLumen(pool: pg.Pool, actor: MarketActor, requestId: string, amount: bigint): Promise<void> {
  await new DevelopmentEconomyService(pool).grant(actor.playerId, actor.accountId, requestId, { lumen: amount });
}

async function carried(pool: pg.Pool, actor: MarketActor, itemId: string): Promise<bigint> {
  const result = await pool.query<{ quantity: string }>(
    "SELECT coalesce(sum(quantity), 0)::text AS quantity FROM player_inventory WHERE player_id = $1 AND resource_type = $2",
    [actor.playerId, itemId]
  );
  return BigInt(result.rows[0]!.quantity);
}

async function balance(pool: pg.Pool, actor: MarketActor): Promise<bigint> {
  const result = await pool.query<{ balance: string }>(
    "SELECT balance::text FROM premium_wallets WHERE account_id = $1 AND currency = 'glimmer'",
    [actor.accountId]
  );
  return BigInt(result.rows[0]?.balance ?? "0");
}

async function gold(pool: pg.Pool, actor: MarketActor): Promise<bigint> {
  const result = await pool.query<{ gold: string }>(
    "SELECT gold_balance::text AS gold FROM player_wallets WHERE player_id = $1",
    [actor.playerId]
  );
  return BigInt(result.rows[0]?.gold ?? "0");
}

async function escrow(pool: pg.Pool, orderId: string): Promise<bigint> {
  const result = await pool.query<{ amount: string }>(
    "SELECT remaining_amount::text AS amount FROM market_order_escrows WHERE order_id = $1",
    [orderId]
  );
  return BigInt(result.rows[0]!.amount);
}

async function currencyFeeSink(pool: pg.Pool): Promise<bigint> {
  const result = await pool.query<{ total: string }>(
    `SELECT coalesce(sum(amount), 0)::text AS total FROM market_ledger_entries
     WHERE account_location = 'fee_sink' AND item_identity = $1`,
    [GLIMMER]
  );
  return BigInt(result.rows[0]!.total);
}

async function bookFrozen(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query<{ frozen: boolean }>(
    "SELECT frozen FROM market_order_books WHERE item_identity = $1",
    [GLIMMER]
  );
  return result.rows[0]?.frozen ?? false;
}

async function grantGlimmer(
  pool: pg.Pool,
  premium: PremiumWalletService,
  actor: MarketActor,
  amount: bigint,
  key = "seed"
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await premium.creditForOperationInTransaction(client, {
      accountId: actor.accountId,
      currency: "glimmer",
      amount,
      operationKey: `test-premium-grant:${key}:${actor.accountId}`,
      reason: "admin",
      metadata: { test: true }
    });
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

async function seedActor(pool: pg.Pool, actor: MarketActor, goldAmount: bigint): Promise<void> {
  await pool.query(
    "INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')",
    [actor.accountId]
  );
  await pool.query(
    `INSERT INTO players (
       id, account_id, username, username_normalized, display_color, region_code,
       lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
     ) VALUES ($1,$2,$3,$4,NULL,'NM',35,-106,35,-106,900,false,
               ST_SetSRID(ST_MakePoint(-106,35),4326))`,
    [actor.playerId, actor.accountId, actor.playerId, actor.playerId]
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
       VALUES ($1,$2,$3,$4)`,
      [actor.playerId, actor.accountId, goldAmount.toString(), goldAmount > 0n ? "1" : "0"]
    );
    if (goldAmount > 0n) {
      await client.query(
        `INSERT INTO wallet_events (
           operation_key, player_id, account_id, delta_gold, balance_after, version_after, reason
         ) VALUES ($1,$2,$3,$4,$4,1,'market_test_seed')`,
        [`test-seed-wallet:${actor.playerId}`, actor.playerId, actor.accountId, goldAmount.toString()]
      );
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

async function resetControls(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMarketControlAuditContext(client, {
      operatorIdentity: "test:premium-exchange",
      reason: "reset isolated integration-test controls"
    });
    await client.query(
      `UPDATE market_global_controls
       SET read_only = false, new_orders_enabled = true, matching_enabled = true,
           cancellations_enabled = true, claims_enabled = true, rules_version = 1`
    );
    await client.query("UPDATE market_venue_controls SET frozen = false, sensitive_reason = NULL");
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}
