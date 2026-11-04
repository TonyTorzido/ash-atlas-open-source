import type { MarketMutationResult } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import { InventoryService } from "./inventory.js";
import { validateItemDefinitionCatalog } from "./items.js";
import { setMarketControlAuditContext } from "./marketControlAudit.js";
import { acquireMarketMutationSafetyLock } from "./marketSafetyLock.js";
import { MarketReconciliationService } from "./marketReconciliation.js";
import { MarketReadService } from "./marketReadService.js";
import {
  activateLegacyGlobalMarketForTest,
  createLegacyMarketTestService,
  LEGACY_TEST_AUTHORITY,
  LEGACY_TEST_VENUE_ID,
  type LegacyMarketTestService
} from "./legacyMarketTestAdapter.js";
import {
  marketRequestHash,
  type MarketActor,
  type MarketFaultPoint
} from "./marketRules.js";

const databaseUrl = process.env.MARKET_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe.sequential : describe.skip;
const { Pool } = pg;

const seller: MarketActor = {
  playerId: "market-seller",
  accountId: "00000000-0000-4000-8000-000000000611"
};
const buyer: MarketActor = {
  playerId: "market-buyer",
  accountId: "00000000-0000-4000-8000-000000000612"
};
const buyerTwo: MarketActor = {
  playerId: "market-buyer-two",
  accountId: "00000000-0000-4000-8000-000000000613"
};

describeDatabase("market exchange live PostgreSQL integration", () => {
  let pool: pg.Pool;
  let service: LegacyMarketTestService;
  let reconcile: MarketReconciliationService;
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    MARKET_GLOBAL_ACCESS: "true",
    MARKET_TRANSACTION_RETRY_LIMIT: "3"
  });

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 40 });
    service = createLegacyMarketTestService(pool, config, createLogger("test"));
    reconcile = new MarketReconciliationService(pool);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE market_order_books CASCADE");
    await pool.query("TRUNCATE accounts CASCADE");
    await resetMarketControlsForTest(pool);
    await activateLegacyGlobalMarketForTest(pool);
    await pool.query("UPDATE market_venues SET fee_policy_id = 2 WHERE venue_key = 'global'");
    await pool.query("UPDATE market_fee_policies SET active = true WHERE fee_policy_id = 2");
    await seedActor(pool, seller, { gold: 1_000n, stone: 30 });
    await seedActor(pool, buyer, { gold: 1_000n, stone: 0 });
    await seedActor(pool, buyerTwo, { gold: 1_000n, stone: 0 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("installs the complete live schema, indexes, constraints, controls, and one global venue", async () => {
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname='public' AND (tablename LIKE 'market_%' OR tablename IN ('player_wallets','wallet_events'))`
    );
    for (const table of [
      "player_wallets", "wallet_events", "market_venues", "market_order_books",
      "market_requests", "market_orders", "market_order_escrows", "market_trades",
      "market_collections", "market_claims", "market_ledger_groups",
      "market_ledger_entries", "market_global_controls", "market_audit_events"
    ]) expect(tables.rows.some((row) => row.tablename === table), table).toBe(true);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[])`,
      [[
         "item_definitions_market_search_idx", "market_orders_sell_match_idx",
         "market_orders_buy_match_idx", "market_orders_account_open_idx",
         "market_orders_book_open_idx",
         "market_trades_book_recent_idx", "market_collections_player_open_idx",
        "market_ledger_entries_group_idx", "market_audit_events_severity_created_idx"
      ]]
    );
    expect(indexes.rowCount).toBe(9);
    const constraints = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
       WHERE connamespace='public'::regnamespace
         AND conrelid = ANY($1::regclass[])`,
      [["market_orders", "market_order_escrows", "market_trades", "market_collections", "market_claims"]]
    );
    expect(Number(constraints.rows[0]?.count)).toBeGreaterThanOrEqual(35);
    expect(Number((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM market_venues WHERE venue_key='global' AND active"
    )).rows[0]?.count)).toBe(1);
    const classMigrations = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version ~ '^03[0-9]{2}_' ORDER BY version`
    );
    expect(classMigrations.rows.map(({ version }) => version)).toEqual([
      "0300_class_progression_foundation.sql",
      "0301_dev_progression_operations.sql",
      "0302_simplified_warrior_and_queue_combat.sql",
      "0303_combat_balance_telemetry.sql",
      "0304_hunter_and_multiclass_foundation.sql",
      "0305_paladin_cleric_foundation.sql",
      "0306_cleric_starter_staff.sql",
      "0307_durable_party_authority.sql",
      "0308_party_consent_replay_and_lease.sql"
    ]);
  });

  it("keeps non-market resources intact while excluding them from every market path", async () => {
    const water = await pool.query<{
      market_tradable: boolean;
      market_fungible: boolean;
      market_identity: string | null;
      supported_variants: string[];
    }>(
      `SELECT market_tradable, market_fungible, market_identity, supported_variants
       FROM item_definitions WHERE item_id = 'water'`
    );
    expect(water.rows[0]).toEqual({
      market_tradable: false,
      market_fungible: false,
      market_identity: null,
      supported_variants: ["default", "fresh", "salt"]
    });
    const snapshot = await service.read.snapshot(buyer);
    for (const itemId of ["water", "food", "ore"] as const) {
      expect(snapshot.items.some((item) => item.itemId === itemId)).toBe(false);
      await expect(service.quote(buyer, `${itemId}-quote-rejected`, itemId, "1"))
        .rejects.toMatchObject({ code: "MARKET_ITEM_NOT_TRADABLE" });
      await expect(service.read.book(buyer, itemId, 5))
        .rejects.toMatchObject({ code: "MARKET_ITEM_NOT_TRADABLE" });
      for (const [side, actor] of [["sell", seller], ["buy", buyer]] as const) {
        await expect(service.createOrder(actor, {
          requestId: `${itemId}-${side}-rejected`, interface: "merchant", side,
          itemId, quantity: "1", unitPrice: "1"
        })).rejects.toMatchObject({ code: "MARKET_ITEM_NOT_TRADABLE" });
      }
    }
  });

  it("matches the fully migrated PostgreSQL item catalog to the compiled server catalog", async () => {
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
  });

  it("isolates Enchantment Stone variants across books, escrow, settlement, and inventory", async () => {
    await pool.query(
      "UPDATE market_venues SET fee_policy_id = 2 WHERE venue_key = 'global'"
    );
    const gemService = createLegacyMarketTestService(pool, config, createLogger("test"), {
      districtBenefits: {
        async resolveMarketTax() {
          return {
            cityId: LEGACY_TEST_AUTHORITY.cityId,
            districtType: null,
            monumentTier: null,
            taxRevision: "1",
            buyerTaxBps: 900,
            specialtyApplied: false,
            qualifyingTaxTag: null
          };
        }
      }
    });
    await seedInventoryVariant(pool, seller, "enchantment_stone", "ruby", 2);
    await seedInventoryVariant(pool, seller, "enchantment_stone", "emerald", 2);

    const snapshot = await gemService.read.snapshot(buyer, { search: "Enchantment Stone", limit: 40 });
    const gems = snapshot.items.filter((item) => item.itemId === "enchantment_stone");
    expect(gems).toHaveLength(8);
    expect(gems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemIdentity: "enchantment_stone:ruby",
        variant: "ruby",
        displayName: "Ruby Enchantment Stone"
      }),
      expect.objectContaining({
        itemIdentity: "enchantment_stone:emerald",
        variant: "emerald",
        displayName: "Emerald Enchantment Stone"
      })
    ]));

    const rubyAsk = await gemService.createOrder(seller, {
      requestId: "gem-ruby-sell-001", interface: "merchant", side: "sell",
      itemIdentity: "enchantment_stone:ruby", quantity: "1", unitPrice: "8"
    });
    const rubyOrderHash = await pool.query<{ request_hash: string }>(
      `SELECT request_hash FROM market_requests
       WHERE account_id = $1 AND request_id = 'gem-ruby-sell-001'`,
      [seller.accountId]
    );
    expect(rubyOrderHash.rows[0]?.request_hash).toBe(marketRequestHash({
      action: "create_sell",
      venueId: LEGACY_TEST_AUTHORITY.venueId,
      itemId: "enchantment_stone:ruby",
      requestBody: {
        interface: "merchant",
        side: "sell",
        itemId: "enchantment_stone:ruby",
        quantity: "1",
        unitPrice: "8"
      }
    }));
    await pool.query(
      "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() - interval '1 second')"
    );
    const emeraldAsk = await (async () => {
      try {
        return await gemService.createOrder(seller, {
          requestId: "gem-emerald-sell-001", interface: "merchant", side: "sell",
          itemIdentity: "enchantment_stone:emerald", quantity: "1", unitPrice: "9"
        });
      } finally {
        await pool.query(
          "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days')"
        );
      }
    })();
    expect(rubyAsk.order).toMatchObject({
      itemId: "enchantment_stone",
      itemIdentity: "enchantment_stone:ruby",
      variant: "ruby"
    });
    expect(emeraldAsk.order).toMatchObject({
      itemId: "enchantment_stone",
      itemIdentity: "enchantment_stone:emerald",
      variant: "emerald"
    });

    const rubyBook = await gemService.read.book(buyer, "enchantment_stone:ruby", 5);
    const emeraldBook = await gemService.read.book(buyer, "enchantment_stone:emerald", 5);
    expect(rubyBook.item.itemIdentity).not.toBe(emeraldBook.item.itemIdentity);
    expect(rubyBook.asks).toEqual([expect.objectContaining({ unitPrice: "8", quantity: "1" })]);
    expect(emeraldBook.asks).toEqual([expect.objectContaining({ unitPrice: "9", quantity: "1" })]);

    const rubyQuote = await gemService.quote(
      buyer,
      "gem-ruby-quote-001",
      "enchantment_stone:ruby",
      "1",
      "8"
    );
    expect(rubyQuote).toMatchObject({
      itemId: "enchantment_stone",
      itemIdentity: "enchantment_stone:ruby",
      variant: "ruby",
      fillableQuantity: "1"
    });
    const rubyQuoteHash = await pool.query<{ request_hash: string }>(
      `SELECT request_hash FROM market_quote_requests
       WHERE account_id = $1 AND request_id = 'gem-ruby-quote-001'`,
      [buyer.accountId]
    );
    expect(rubyQuoteHash.rows[0]?.request_hash).toBe(marketRequestHash({
      action: "quote",
      venueId: LEGACY_TEST_AUTHORITY.venueId,
      itemId: "enchantment_stone:ruby",
      quantity: "1",
      maximumUnitPrice: "8"
    }));
    const purchase = await gemService.simpleBuy(
      buyer,
      "gem-ruby-buy-001",
      rubyQuote.quoteId,
      rubyQuote.buyerTotal
    );
    expect(purchase.trades).toHaveLength(1);
    const custody = await pool.query<{
      item_identity: string;
      item_id: string;
      variant: string;
    }>(
      `SELECT item_identity, item_id, variant FROM market_trades WHERE trade_id = $1
       UNION ALL
       SELECT item_identity, item_id, variant FROM market_order_escrows
       WHERE order_id = ANY($2::uuid[])
       ORDER BY item_identity, variant`,
      [purchase.trades[0]!.tradeId, [rubyAsk.order!.orderId, emeraldAsk.order!.orderId]]
    );
    expect(custody.rows).toEqual(expect.arrayContaining([
      { itemIdentity: "enchantment_stone:ruby", itemId: "enchantment_stone", variant: "ruby" },
      { itemIdentity: "enchantment_stone:emerald", itemId: "enchantment_stone", variant: "emerald" }
    ].map((row) => ({
      item_identity: row.itemIdentity,
      item_id: row.itemId,
      variant: row.variant
    }))));

    const inventory = await pool.query<{ player_id: string; variant: string; quantity: string }>(
      `SELECT player_id, variant, quantity::text FROM player_inventory
       WHERE resource_type = 'enchantment_stone' AND player_id = ANY($1::text[])
       ORDER BY player_id, variant`,
      [[seller.playerId, buyer.playerId]]
    );
    expect(inventory.rows).toEqual(expect.arrayContaining([
      { player_id: buyer.playerId, variant: "ruby", quantity: "1" },
      { player_id: seller.playerId, variant: "emerald", quantity: "1" },
      { player_id: seller.playerId, variant: "ruby", quantity: "1" }
    ]));
    await expect(gemService.expireDueOrders()).resolves.toEqual({
      materialOrders: 1,
      equipmentListings: 0
    });
    const recovery = await pool.query<{
      item_identity: string;
      item_id: string;
      variant: string;
      remaining_amount: string;
    }>(
      `SELECT item_identity, item_id, variant, remaining_amount::text
       FROM market_collections WHERE source_order_id = $1`,
      [emeraldAsk.order!.orderId]
    );
    expect(recovery.rows).toEqual([{
      item_identity: "enchantment_stone:emerald",
      item_id: "enchantment_stone",
      variant: "emerald",
      remaining_amount: "1"
    }]);
    await expect(gemService.claim(seller, "gem-emerald-claim-001", "items"))
      .resolves.toMatchObject({ claimedItems: "1" });
    await expect(pool.query<{ quantity: string }>(
      `SELECT quantity::text FROM player_inventory
       WHERE player_id = $1 AND resource_type = 'enchantment_stone' AND variant = 'emerald'`,
      [seller.playerId]
    )).resolves.toMatchObject({ rows: [{ quantity: "2" }] });
    await expect(gemService.createOrder(seller, {
      requestId: "gem-unsupported-001", interface: "merchant", side: "sell",
      itemIdentity: "enchantment_stone:garnet", quantity: "1", unitPrice: "8"
    })).rejects.toMatchObject({ code: "MARKET_ITEM_NOT_TRADABLE" });
    await expect(gemService.createOrder(seller, {
      requestId: "gem-forged-identity-001", interface: "merchant", side: "sell",
      itemIdentity: "forged_gem", quantity: "1", unitPrice: "8"
    })).rejects.toMatchObject({ code: "MARKET_UNKNOWN_ITEM" });
    await expectReconciled(reconcile);
  });

  it.each(["balsam_resin", "atlas_shrine_shard", "simple_food"] as const)(
    "lists, purchases, stacks, transfers, and persists %s through the fungible market",
    async (itemId) => {
      await pool.query(
        "UPDATE market_venues SET fee_policy_id = 2 WHERE venue_key = 'global'"
      );
      const fungibleService = createLegacyMarketTestService(
        pool,
        config,
        createLogger("test"),
        {
          districtBenefits: {
            async resolveMarketTax() {
              return {
                cityId: LEGACY_TEST_AUTHORITY.cityId,
                districtType: null,
                monumentTier: null,
                taxRevision: "1",
                buyerTaxBps: 900,
                specialtyApplied: false,
                qualifyingTaxTag: null
              };
            }
          }
        }
      );
      await seedInventoryItem(pool, seller, itemId, 8);
      await seedInventoryItem(pool, buyer, itemId, 1);

      const databaseDefinition = await pool.query<{
        stackable: boolean;
        market_tradable: boolean;
        market_fungible: boolean;
        market_identity: string | null;
      }>(
        `SELECT stackable, market_tradable, market_fungible, market_identity
         FROM item_definitions
         WHERE item_id = $1`,
        [itemId]
      );
      expect(databaseDefinition.rows[0]).toEqual({
        stackable: true,
        market_tradable: true,
        market_fungible: true,
        market_identity: itemId
      });

      const listing = await fungibleService.createOrder(seller, {
        requestId: `${itemId}-sell`,
        interface: "merchant",
        side: "sell",
        itemId,
        quantity: "6",
        unitPrice: "8"
      });
      expect(listing.order).toMatchObject({
        itemId,
        itemIdentity: itemId,
        side: "sell",
        remainingQuantity: "6",
        status: "open"
      });

      const purchase = await fungibleService.createOrder(buyer, {
        requestId: `${itemId}-buy`,
        interface: "merchant",
        side: "buy",
        itemId,
        quantity: "4",
        unitPrice: "8"
      });
      expect(purchase.trades).toHaveLength(1);
      expect(purchase.trades[0]).toMatchObject({
        quantity: "4",
        unitPrice: "8"
      });
      const tradedBook = await pool.query<{
        item_id: string;
        item_identity: string;
      }>(
        `SELECT book.item_id, book.item_identity
         FROM market_trades AS trade
         JOIN market_order_books AS book ON book.book_id = trade.book_id
         WHERE trade.trade_id = $1`,
        [purchase.trades[0]!.tradeId]
      );
      expect(tradedBook.rows[0]).toEqual({
        item_id: itemId,
        item_identity: itemId
      });

      await expect(fungibleService.claim(buyer, `${itemId}-claim-items`, "items"))
        .resolves.toMatchObject({ claimedItems: "0" });
      await expect(fungibleService.claim(seller, `${itemId}-claim-gold`, "gold"))
        .resolves.toMatchObject({ claimedGold: "0" });
      await fungibleService.cancelOrder(
        seller,
        `${itemId}-cancel`,
        listing.order!.orderId
      );
      await expect(fungibleService.claim(seller, `${itemId}-claim-return`, "items"))
        .resolves.toMatchObject({ claimedItems: "0" });

      const persisted = await pool.query<{
        player_id: string;
        quantity: string;
      }>(
        `SELECT player_id, quantity::text
         FROM player_inventory
         WHERE player_id = ANY($1::text[])
           AND resource_type = $2
           AND variant = 'default'
         ORDER BY player_id`,
        [[buyer.playerId, seller.playerId], itemId]
      );
      expect(persisted.rows).toEqual([
        { player_id: buyer.playerId, quantity: "5" },
        { player_id: seller.playerId, quantity: "4" }
      ]);
      const wallets = await pool.query<{ player_id: string; gold_balance: string }>(
        `SELECT player_id, gold_balance::text
         FROM player_wallets
         WHERE player_id = ANY($1::text[])
         ORDER BY player_id`,
        [[buyer.playerId, seller.playerId]]
      );
      expect(wallets.rows).toEqual([
        { player_id: buyer.playerId, gold_balance: "966" },
        { player_id: seller.playerId, gold_balance: "1032" }
      ]);
      const deferred = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM market_collections
         WHERE source_order_id IN ($1, $2)`,
        [listing.order!.orderId, purchase.order!.orderId]
      );
      expect(deferred.rows[0]?.count).toBe("0");

      const freshPool = new Pool({ connectionString: databaseUrl!, max: 2 });
      try {
        const freshService = createLegacyMarketTestService(
          freshPool,
          config,
          createLogger("test")
        );
        const snapshot = await freshService.read.snapshot(buyer);
        expect(snapshot.player.collection.items).toEqual([]);
        const persistedBuyer = await freshPool.query<{ quantity: string }>(
          `SELECT quantity::text AS quantity
           FROM player_inventory
           WHERE player_id = $1 AND resource_type = $2 AND variant = 'default'`,
          [buyer.playerId, itemId]
        );
        expect(persistedBuyer.rows[0]?.quantity).toBe("5");
      } finally {
        await freshPool.end();
      }
      await expectReconciled(reconcile);
    }
  );

  it("trades a non-stackable fungible Venomsteel Core as one-unit inventory stacks", async () => {
    await pool.query(
      "UPDATE market_venues SET fee_policy_id = 2 WHERE venue_key = 'global'"
    );
    const coreService = createLegacyMarketTestService(
      pool,
      config,
      createLogger("test"),
      {
        districtBenefits: {
          async resolveMarketTax() {
            return {
              cityId: LEGACY_TEST_AUTHORITY.cityId,
              districtType: null,
              monumentTier: null,
              taxRevision: "1",
              buyerTaxBps: 900,
              specialtyApplied: false,
              qualifyingTaxTag: null
            };
          }
        }
      }
    );
    await seedInventoryItem(pool, seller, "venomsteel_core", 1);

    const definition = await pool.query<{
      stackable: boolean;
      max_stack: number;
      market_tradable: boolean;
      market_fungible: boolean;
    }>(
      `SELECT stackable,max_stack,market_tradable,market_fungible
       FROM item_definitions WHERE item_id='venomsteel_core'`
    );
    expect(definition.rows[0]).toEqual({
      stackable: false,
      max_stack: 1,
      market_tradable: true,
      market_fungible: true
    });

    const listing = await coreService.createOrder(seller, {
      requestId: "venomsteel-core-sell",
      interface: "merchant",
      side: "sell",
      itemId: "venomsteel_core",
      quantity: "1",
      unitPrice: "8"
    });
    const purchase = await coreService.createOrder(buyer, {
      requestId: "venomsteel-core-buy",
      interface: "merchant",
      side: "buy",
      itemId: "venomsteel_core",
      quantity: "1",
      unitPrice: "8"
    });

    expect(listing.order).toMatchObject({ itemId: "venomsteel_core", status: "open" });
    expect(purchase.trades).toHaveLength(1);
    const buyerCore = await pool.query<{ quantity: string }>(
      `SELECT quantity::text
       FROM player_inventory_slots
       WHERE player_id=$1 AND resource_type='venomsteel_core'`,
      [buyer.playerId]
    );
    expect(buyerCore.rows).toEqual([{ quantity: "1" }]);
  });

  it("trades one exact Fishing Rod instance while preserving uses and ownership linkage", async () => {
    const rodId = "00000000-0000-4000-8000-000000000841";
    const itemIdentity = `fishing_rod:${rodId}`;
    await pool.query(
      `INSERT INTO fishing_rods (rod_id, player_id, uses_remaining)
       VALUES ($1::uuid, $2, 73)`,
      [rodId, seller.playerId]
    );
    await seedInventoryVariant(pool, seller, "fishing_rod", rodId, 1);

    const rodService = createLegacyMarketTestService(pool, config, createLogger("test"));
    const owned = await rodService.read.snapshot(seller, { category: "resource", limit: 40 });
    expect(owned.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemId: "fishing_rod",
        itemIdentity,
        variant: rodId,
        displayName: "Fishing Rod"
      })
    ]));

    const listing = await rodService.createOrder(seller, {
      requestId: "fishing-rod-sell-001",
      interface: "merchant",
      side: "sell",
      itemIdentity,
      quantity: "1",
      unitPrice: "8"
    });
    expect(listing.order).toMatchObject({
      itemId: "fishing_rod",
      itemIdentity,
      variant: rodId,
      remainingQuantity: "1"
    });
    const listedBook = await rodService.read.book(buyer, itemIdentity, 5);
    expect(listedBook.item).toMatchObject({ itemId: "fishing_rod", itemIdentity, variant: rodId });

    const purchase = await rodService.createOrder(buyer, {
      requestId: "fishing-rod-buy-001",
      interface: "merchant",
      side: "buy",
      itemIdentity,
      quantity: "1",
      unitPrice: "8"
    });
    expect(purchase.trades).toHaveLength(1);

    const rod = await pool.query<{ player_id: string; uses_remaining: number }>(
      `SELECT player_id, uses_remaining FROM fishing_rods WHERE rod_id = $1::uuid`,
      [rodId]
    );
    expect(rod.rows).toEqual([{ player_id: buyer.playerId, uses_remaining: 73 }]);
    const inventory = await pool.query<{ player_id: string; quantity: string }>(
      `SELECT player_id, quantity::text FROM player_inventory
       WHERE resource_type = 'fishing_rod' AND variant = $1 AND quantity > 0
       ORDER BY player_id`,
      [rodId]
    );
    expect(inventory.rows).toEqual([{ player_id: buyer.playerId, quantity: "1" }]);

    const buyerSnapshot = await rodService.read.snapshot(buyer, { category: "resource", limit: 40 });
    expect(buyerSnapshot.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "fishing_rod", itemIdentity, variant: rodId })
    ]));
  });

  it("trades one exact tagged mask copy with its tag and original buyer unchanged", async () => {
    const copyId = "00000000-0000-4000-8000-000000001202";
    const itemIdentity = `face_mask:${copyId}`;
    await pool.query(
      `INSERT INTO shop_item_copies (copy_id, item_id, look, tag, original_buyer_player_id, original_buyer_name, display_name)
       VALUES ($1,'face_mask','hockey-mask','7KQ3-M9XD',$2,'First Owner','Hockey Mask')
       ON CONFLICT (copy_id) DO NOTHING`,
      [copyId, seller.playerId]
    );
    await seedInventoryVariant(pool, seller, "face_mask", copyId, 1);
    const copyService = createLegacyMarketTestService(pool, config, createLogger("test"));
    await expect(copyService.createOrder(seller, {
      requestId: "mask-copy-sell-two", interface: "merchant", side: "sell", itemIdentity, quantity: "2", unitPrice: "8"
    })).rejects.toMatchObject({ code: "MARKET_ITEM_NOT_TRADABLE" });
    await copyService.createOrder(seller, {
      requestId: "mask-copy-sell-001", interface: "merchant", side: "sell", itemIdentity, quantity: "1", unitPrice: "8"
    });
    const listed = await copyService.read.book(buyer, itemIdentity, 5);
    expect(listed.item).toMatchObject({
      itemId: "face_mask", itemIdentity, variant: copyId, displayName: "Hockey Mask",
      provenance: { tag: "7KQ3-M9XD", originalBuyerName: "First Owner" }
    });
    const purchase = await copyService.createOrder(buyer, {
      requestId: "mask-copy-buy-001", interface: "merchant", side: "buy", itemIdentity, quantity: "1", unitPrice: "8"
    });
    expect(purchase.trades).toHaveLength(1);
    const holders = await pool.query<{ player_id: string; quantity: string }>(
      `SELECT player_id, quantity::text FROM player_inventory
       WHERE resource_type = 'face_mask' AND variant = $1 AND quantity > 0`,
      [copyId]
    );
    expect(holders.rows).toEqual([{ player_id: buyer.playerId, quantity: "1" }]);
    const copy = await pool.query("SELECT tag, original_buyer_name FROM shop_item_copies WHERE copy_id = $1", [copyId]);
    expect(copy.rows).toEqual([{ tag: "7KQ3-M9XD", original_buyer_name: "First Owner" }]);
  });

  it("browses only listed items when asked, so later pages are not hidden behind empty rows", async () => {
    await service.createOrder(seller, {
      requestId: "listed-only-sell-001", interface: "simple", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "9"
    });
    const everything = await service.read.snapshot(buyer, { limit: 40 });
    expect(everything.items.length).toBeGreaterThan(1);
    const listed = await service.read.snapshot(buyer, { limit: 40, listedOnly: true });
    expect(listed.items.map((item) => item.itemId)).toEqual(["stone"]);
    expect(listed.nextCursor).toBeNull();
  });

  it("sends the seller exactly one Messages notice per fill and none on replay", async () => {
    await service.createOrder(seller, {
      requestId: "notice-sell-001", interface: "simple", side: "sell",
      itemId: "stone", quantity: "5", unitPrice: "8"
    });
    const cross = { requestId: "notice-buy-001", interface: "merchant" as const, side: "buy" as const, itemId: "stone", quantity: "3", unitPrice: "8" };
    const first = await service.createOrder(buyer, cross);
    expect(first.trades).toHaveLength(1);
    const notices = (playerId: string) => pool.query<{ message: string; event_id: string }>(
      "SELECT message,event_id::text FROM player_inbox_entries WHERE player_id=$1 AND entry_kind='game_notice' AND event_kind='market_sale'",
      [playerId]
    );
    const sold = await notices(seller.playerId);
    expect(sold.rows).toHaveLength(1);
    expect(sold.rows[0]!.event_id).toBe(first.trades[0]!.tradeId);
    expect(sold.rows[0]!.message).toMatch(/^Sold 3 Stone for \d+ gold at .+\. Collect it at the Market\.$/);
    expect((await notices(buyer.playerId)).rows).toHaveLength(0);

    await service.createOrder(buyer, cross);
    expect((await notices(seller.playerId)).rows).toHaveLength(1);

    const second = await service.createOrder(buyer, { ...cross, requestId: "notice-buy-002", quantity: "2" });
    expect(second.trades).toHaveLength(1);
    expect((await notices(seller.playerId)).rows).toHaveLength(2);
  });

  it("creates recovery custody only when an order expires", async () => {
    await pool.query(
      "UPDATE market_venues SET fee_policy_id = 2 WHERE venue_key = 'global'"
    );
    const expiringService = createLegacyMarketTestService(
      pool,
      config,
      createLogger("test"),
      {
        districtBenefits: {
          async resolveMarketTax() {
            return {
              cityId: LEGACY_TEST_AUTHORITY.cityId,
              districtType: null,
              monumentTier: null,
              taxRevision: "1",
              buyerTaxBps: 900,
              specialtyApplied: false,
              qualifyingTaxTag: null
            };
          }
        }
      }
    );
    await pool.query(
      "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() - interval '1 second')"
    );
    const listing = await expiringService.createOrder(seller, {
      requestId: "expire-sell-order-001",
      interface: "merchant",
      side: "sell",
      itemId: "stone",
      quantity: "3",
      unitPrice: "8"
    });
    await pool.query(
      "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days')"
    );

    await expect(expiringService.expireDueOrders()).resolves.toEqual({
      materialOrders: 1,
      equipmentListings: 0
    });
    const recovery = await pool.query<{
      status: string;
      remaining_amount: string;
      reason: string;
    }>(
      `SELECT orders.status, collections.remaining_amount::text, collections.reason
       FROM market_orders orders
       JOIN market_collections collections
         ON collections.source_order_id = orders.order_id
       WHERE orders.order_id = $1`,
      [listing.order!.orderId]
    );
    expect(recovery.rows).toEqual([{
      status: "expired",
      remaining_amount: "3",
      reason: "sell_expired_return"
    }]);
    await expect(expiringService.expireDueOrders()).resolves.toEqual({
      materialOrders: 0,
      equipmentListings: 0
    });
    await expect(expiringService.claim(seller, "expire-claim-return-001", "items"))
      .resolves.toMatchObject({ claimedItems: "3" });
    await expectReconciled(reconcile);
  });

  it("keeps a Loadout Scroll's memory through an expired listing and its claim", async () => {
    await new InventoryService(pool).grantItemsForOperation({
      operationKey: `scroll-seed:${seller.playerId}`, playerId: seller.playerId, source: "test",
      grants: [{ itemId: "loadout_scroll", variant: null, quantity: 2 }]
    });
    const instanceId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO equipment_operations (operation_key,player_id,action,completed_at) VALUES ($1,$2,'package_grant',now())",
      [`scroll-gear:${instanceId}`, seller.playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (instance_id,definition_id,owner_player_id,location,created_by_operation_key,item_level)
       VALUES ($1,'training_axe',$2,'inventory',$3,0)`,
      [instanceId, seller.playerId, `scroll-gear:${instanceId}`]
    );
    await pool.query(
      `INSERT INTO player_gear_scroll_memory (player_id,scroll_position,equipment_slot,instance_id)
       VALUES ($1,1,'melee',$2),($1,2,'melee',$2)`,
      [seller.playerId, instanceId]
    );
    const positions = async () => (await pool.query<{ scroll_position: number }>(
      "SELECT scroll_position FROM player_gear_scroll_memory WHERE player_id=$1 ORDER BY 1", [seller.playerId]
    )).rows.map((row) => row.scroll_position);

    await pool.query(
      "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() - interval '1 second')"
    );
    try {
      await service.createOrder(seller, {
        requestId: "scroll-sell-order-001",
        interface: "merchant",
        side: "sell",
        itemId: "loadout_scroll",
        quantity: "1",
        unitPrice: "8"
      });
    } finally {
      await pool.query(
        "ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days')"
      );
    }
    expect(await positions()).toEqual([1, 2]);
    await service.expireDueOrders();
    expect(await positions()).toEqual([1, 2]);
    await expect(service.claim(seller, "scroll-claim-return-001", "items"))
      .resolves.toMatchObject({ claimedItems: "1" });
    expect(await positions()).toEqual([1, 2]);
  });

  it("uses one maker-priced book for Merchant and Simple orders, then claims and cancels exactly", async () => {
    const ask = await service.createOrder(seller, {
      requestId: "sell-order-001",
      interface: "simple",
      side: "sell",
      itemId: "stone",
      quantity: "10",
      unitPrice: "8"
    });
    expect(ask.order).toMatchObject({ side: "sell", status: "open", remainingQuantity: "10" });

    const restingBid = await service.createOrder(buyer, {
      requestId: "buy-order-low-001",
      interface: "merchant",
      side: "buy",
      itemId: "stone",
      quantity: "2",
      unitPrice: "7"
    });
    expect(restingBid.trades).toEqual([]);

    const crossing = await service.createOrder(buyer, {
      requestId: "buy-order-cross-001",
      interface: "merchant",
      side: "buy",
      itemId: "stone",
      quantity: "4",
      unitPrice: "10"
    });
    expect(crossing.trades).toHaveLength(1);
    expect(crossing.trades[0]).toMatchObject({ quantity: "4", unitPrice: "8", total: "32" });
    expect(crossing.order).toMatchObject({ status: "filled", remainingQuantity: "0" });

    const book = await service.read.book(buyer, "stone", 10);
    expect(book.asks[0]).toMatchObject({ unitPrice: "8", quantity: "6" });
    expect(book.bids[0]).toMatchObject({ unitPrice: "7", quantity: "2" });

    expect((await service.read.snapshot(buyer)).player.walletGold).toBe("951");
    expect((await service.read.snapshot(seller)).player.walletGold).toBe("1032");
    expect((await pool.query<{ quantity: string }>(
      "SELECT quantity FROM player_inventory WHERE player_id=$1 AND resource_type='stone'",
      [buyer.playerId]
    )).rows[0]?.quantity).toBe("4");
    const buyerClaim = await service.claim(buyer, "claim-buyer-all-001", "all");
    expect(buyerClaim.claimedItems).toBe("0");
    expect(buyerClaim.claimedGold).toBe("0");
    const sellerClaim = await service.claim(seller, "claim-seller-gold-001", "gold");
    expect(sellerClaim.claimedGold).toBe("0");

    const cancelled = await service.cancelOrder(seller, "cancel-seller-ask-001", ask.order!.orderId);
    expect(cancelled.order).toMatchObject({ status: "cancelled", remainingQuantity: "6" });
    const returned = await service.claim(seller, "claim-seller-return-001", "items");
    expect(returned.claimedItems).toBe("0");

    const sellerInventory = await pool.query<{ quantity: number }>(
      "SELECT quantity FROM player_inventory WHERE player_id = $1 AND resource_type = 'stone' AND variant = 'default'",
      [seller.playerId]
    );
    expect(Number(sellerInventory.rows[0]?.quantity)).toBe(26);
    await expectReconciled(reconcile);
  });

  it("keeps both expired source orders stable while recovery collections are claimed", async () => {
    const first = await expireTestOrder(pool, service, seller, "claim-lock-first", "sell", "1", "8");
    const second = await expireTestOrder(pool, service, seller, "claim-lock-second", "sell", "1", "8");
    const sourceOrderIds = [first.order!.orderId, second.order!.orderId];
    let announceLocks!: () => void;
    let releaseClaim!: () => void;
    const locksHeld = new Promise<void>((resolve) => { announceLocks = resolve; });
    const claimMayCommit = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const claiming = createLegacyMarketTestService(pool, config, createLogger("test"), {
      faultInjector: async (point) => {
        if (point !== "during_claim") return;
        announceLocks();
        await claimMayCommit;
      }
    });
    const claim = claiming.claim(seller, "claim-lock-items-001", "items");
    await locksHeld;

    const observer = await pool.connect();
    try {
      for (const orderId of sourceOrderIds) {
        await observer.query("BEGIN");
        await expect(observer.query(
          "SELECT order_id FROM market_orders WHERE order_id = $1 FOR UPDATE NOWAIT",
          [orderId]
        )).rejects.toMatchObject({ code: "55P03" });
        await observer.query("ROLLBACK");
      }
    } finally {
      await observer.query("ROLLBACK").catch(() => undefined);
      observer.release();
      releaseClaim();
    }
    await expect(claim).resolves.toMatchObject({ claimedItems: "2" });
    await expectReconciled(reconcile);
  });

  it("keeps resting buy escrow funded at 9% while a specialty fill applies 4.5%", async () => {
    await pool.query(
      "UPDATE market_venues SET fee_policy_id = 2 WHERE venue_key = 'global'"
    );
    const specialtyService = createLegacyMarketTestService(
      pool,
      config,
      createLogger("test"),
      {
        districtBenefits: {
          async resolveMarketTax() {
            return {
              cityId: LEGACY_TEST_AUTHORITY.cityId,
              districtType: "mining",
              monumentTier: 1,
              taxRevision: "7",
              buyerTaxBps: 450,
              specialtyApplied: true,
              qualifyingTaxTag: "mining"
            };
          }
        }
      }
    );
    const bid = await specialtyService.createOrder(buyer, {
      requestId: "specialty-resting-buy-001",
      interface: "merchant",
      side: "buy",
      itemId: "stone",
      quantity: "8",
      unitPrice: "100"
    });
    const fill = await specialtyService.createOrder(seller, {
      requestId: "specialty-crossing-sell-001",
      interface: "merchant",
      side: "sell",
      itemId: "stone",
      quantity: "4",
      unitPrice: "80"
    });
    expect(bid.order).toMatchObject({
      status: "open",
      remainingQuantity: "8"
    });
    expect(fill.trades[0]).toMatchObject({
      quantity: "4",
      unitPrice: "100",
      buyerTax: "18",
      buyerTaxBps: 450,
      specialtyTaxApplied: true,
      qualifyingTaxTag: "mining"
    });
    const escrow = await pool.query<{
      initial_amount: string;
      remaining_amount: string;
    }>(
      `SELECT initial_amount::text, remaining_amount::text
       FROM market_order_escrows
       WHERE order_id = $1`,
      [bid.order!.orderId]
    );
    expect(escrow.rows[0]).toEqual({
      initial_amount: "872",
      remaining_amount: "436"
    });
    const refund = await pool.query<{ original_amount: string }>(
      `SELECT delta_gold::text AS original_amount
       FROM wallet_events WHERE operation_key = $1`,
      [`market-trade-refund:${fill.trades[0]!.tradeId}`]
    );
    expect(refund.rows[0]?.original_amount).toBe("18");
    await expectReconciled(reconcile);
  });

  it("charges an active rank-5 Merchant exactly the quoted reduced tax and everyone else the full tax", async () => {
    await pool.query(
      `INSERT INTO player_specialization_ranks (player_id,specialization_id,rank,points_spent) VALUES ($1,'merchant',5,5)`,
      [buyer.playerId]
    );
    await pool.query(
      `INSERT INTO player_specialization_state (player_id,active_specialization_id) VALUES ($1,'merchant')
       ON CONFLICT (player_id) DO UPDATE SET active_specialization_id='merchant'`,
      [buyer.playerId]
    );
    await service.createOrder(seller, {
      requestId: "merchant-ask-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "20", unitPrice: "8"
    });
    const quote = await service.quote(buyer, "merchant-quote-001", "stone", "10");
    expect(quote).toMatchObject({ buyerTax: "4", buyerTotal: "84", appliedBuyerTaxBps: 540 });
    const purchase = await service.simpleBuy(buyer, "merchant-buy-001", quote.quoteId, quote.buyerTotal);
    const fee = await pool.query<{ buyer_fee: string }>(
      "SELECT buyer_fee::text FROM market_trades WHERE trade_id = $1", [purchase.trades[0]!.tradeId]
    );
    expect(fee.rows[0]?.buyer_fee).toBe(quote.buyerTax);
    const gold = await pool.query<{ gold_balance: string }>(
      "SELECT gold_balance::text FROM player_wallets WHERE player_id = $1", [buyer.playerId]
    );
    expect(BigInt(gold.rows[0]!.gold_balance)).toBe(1_000n - BigInt(quote.buyerTotal));

    const plainQuote = await service.quote(buyerTwo, "merchant-quote-plain-001", "stone", "10");
    expect(plainQuote).toMatchObject({ buyerTax: "7", buyerTotal: "87", appliedBuyerTaxBps: 900 });
    await expectReconciled(reconcile);
  });

  it("provides stale-safe all-or-nothing Simple quotes across multiple sellers", async () => {
    await service.createOrder(seller, {
      requestId: "simple-ask-one-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "4", unitPrice: "8"
    });
    await seedActor(pool, { playerId: "seller-two", accountId: "00000000-0000-4000-8000-000000000614" }, { gold: 0n, stone: 10 });
    const sellerTwo = { playerId: "seller-two", accountId: "00000000-0000-4000-8000-000000000614" };
    await service.createOrder(sellerTwo, {
      requestId: "simple-ask-two-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "6", unitPrice: "9"
    });
    const quote = await service.quote(buyer, "quote-simple-001", "stone", "10");
    expect(quote).toMatchObject({ fillableQuantity: "10", quotedTotal: "92", maximumUnitPrice: "9", fullQuantityAvailable: true });
    const purchase = await service.simpleBuy(buyer, "simple-buy-001", quote.quoteId, "94");
    expect(purchase.trades.map((trade) => [trade.quantity, trade.unitPrice])).toEqual([["4", "8"], ["6", "9"]]);
    expect(purchase.order?.status).toBe("filled");

    const staleQuote = await service.quote(buyerTwo, "quote-stale-001", "stone", "1");
    expect(staleQuote.fullQuantityAvailable).toBe(false);
    await expect(service.simpleBuy(buyerTwo, "simple-buy-stale-001", staleQuote.quoteId, "100"))
      .rejects.toMatchObject({ code: "MARKET_PRICE_CHANGED" });
    await expectReconciled(reconcile);
  });

  it("bounds quotes by the clicked price cap and returns explicit self-trade terminal states", async () => {
    await service.createOrder(seller, {
      requestId: "quote-cap-ask-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "4", unitPrice: "8"
    });
    await seedActor(pool, {
      playerId: "seller-cap-two",
      accountId: "00000000-0000-4000-8000-000000000618"
    }, { gold: 0n, stone: 4 });
    const sellerTwo = {
      playerId: "seller-cap-two",
      accountId: "00000000-0000-4000-8000-000000000618"
    };
    await service.createOrder(sellerTwo, {
      requestId: "quote-cap-ask-002", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "4", unitPrice: "9"
    });

    const capped = await service.quote(buyer, "quote-cap-buyer-001", "stone", "5", "8");
    expect(capped).toMatchObject({
      requestedMaximumUnitPrice: "8",
      fillableQuantity: "4",
      quotedTotal: "34",
      maximumUnitPrice: "8",
      fullQuantityAvailable: false,
      availability: "quantity_unavailable"
    });
    const valid = await service.quote(buyer, "quote-cap-buyer-002", "stone", "5", "9");
    expect(valid).toMatchObject({
      requestedMaximumUnitPrice: "9",
      fillableQuantity: "5",
      quotedTotal: "43",
      maximumUnitPrice: "9",
      fullQuantityAvailable: true,
      availability: "available"
    });
    const ownOnly = await service.quote(seller, "quote-cap-self-001", "stone", "1", "8");
    expect(ownOnly).toMatchObject({
      fillableQuantity: "0",
      quotedTotal: "0",
      maximumUnitPrice: null,
      fullQuantityAvailable: false,
      availability: "self_trade_only"
    });
    const noLiquidity = await service.quote(buyer, "quote-cap-none-001", "stone", "1", "7");
    expect(noLiquidity.availability).toBe("no_eligible_liquidity");
    const trades = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM market_trades");
    expect(trades.rows[0]?.count).toBe("0");
    await expectReconciled(reconcile);
  });

  it("durably replays quotes, conflicts changed intent, replaces latest, and shares DB quotas", async () => {
    await service.createOrder(seller, {
      requestId: "quote-hardening-ask", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "5", unitPrice: "8"
    });
    const original = await service.quote(buyer, "quote-replay-hardening", "stone", "2");
    const replay = await service.quote(buyer, "quote-replay-hardening", "stone", "2");
    expect(replay).toEqual(original);
    await expect(service.quote(buyer, "quote-replay-hardening", "stone", "3"))
      .rejects.toMatchObject({ code: "MARKET_REPLAY_CONFLICT" });

    const latest = await service.quote(buyer, "quote-latest-hardening", "stone", "1");
    expect(latest.quoteId).not.toBe(original.quoteId);
    expect(await service.quote(buyer, "quote-replay-hardening", "stone", "2"))
      .toEqual(original);
    const quoteState = await pool.query<{
      active_count: string;
      request_count: string;
      original_replaced: boolean;
    }>(
      `SELECT
         count(*) FILTER (WHERE consumed_at IS NULL AND replaced_at IS NULL)::text AS active_count,
         (SELECT count(*)::text FROM market_quote_requests WHERE account_id = $1) AS request_count,
         bool_or(quote_id = $2 AND replaced_at IS NOT NULL) AS original_replaced
       FROM market_quotes WHERE account_id = $1`,
      [buyer.accountId, original.quoteId]
    );
    expect(quoteState.rows[0]).toEqual({
      active_count: "1",
      request_count: "2",
      original_replaced: true
    });

    await pool.query("DELETE FROM market_rate_windows WHERE player_id = $1", [buyer.playerId]);
    const limitedConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      MARKET_GLOBAL_ACCESS: "true",
      MARKET_QUOTE_REQUESTS_PER_MINUTE: "1",
      MARKET_BROWSE_REQUESTS_PER_MINUTE: "1",
      MARKET_BOOK_REQUESTS_PER_MINUTE: "1",
      MARKET_SUBSCRIPTION_REQUESTS_PER_MINUTE: "1"
    });
    const firstSession = createLegacyMarketTestService(pool, limitedConfig, createLogger("test"));
    const secondSession = createLegacyMarketTestService(pool, limitedConfig, createLogger("test"));
    const limitedQuote = await firstSession.quote(buyer, "quote-rate-first", "stone", "1");
    expect(await secondSession.quote(buyer, "quote-rate-first", "stone", "1"))
      .toEqual(limitedQuote);
    await expect(secondSession.quote(buyer, "quote-rate-second", "stone", "1"))
      .rejects.toMatchObject({ code: "MARKET_RATE_LIMITED" });

    await firstSession.read.snapshot(buyer, { search: "stone" });
    await expect(secondSession.read.snapshot(buyer, { category: "resource" }))
      .rejects.toMatchObject({ code: "MARKET_RATE_LIMITED" });
    await firstSession.read.book(buyer, "stone", 5);
    await expect(secondSession.read.book(buyer, "stone", 5))
      .rejects.toMatchObject({ code: "MARKET_RATE_LIMITED" });
    await firstSession.read.assertSubscriptionAccess(buyer);
    await expect(secondSession.read.assertSubscriptionAccess(buyer))
      .rejects.toMatchObject({ code: "MARKET_RATE_LIMITED" });
  });

  it("returns one repeatable-read book snapshot while another transaction fills the book", async () => {
    await service.createOrder(seller, {
      requestId: "snapshot-consistency-ask", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    let releaseSummary!: () => void;
    let continueSnapshot!: () => void;
    const summaryRead = new Promise<void>((resolve) => { releaseSummary = resolve; });
    const resume = new Promise<void>((resolve) => { continueSnapshot = resolve; });
    const wrappedPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: unknown[]) => {
            const result = await client.query(text, values);
            if (text.includes("FROM item_definitions d") && text.includes("WHERE asset.item_identity")) {
              releaseSummary();
              await resume;
            }
            return result;
          },
          release: (error?: Error) => client.release(error)
        };
      }
    } as unknown as pg.Pool;
    const reads = new MarketReadService(wrappedPool, config);
    const pendingSnapshot = reads.book(buyer, LEGACY_TEST_AUTHORITY, "stone", 5);
    await summaryRead;
    const fill = await service.createOrder(buyer, {
      requestId: "snapshot-consistency-fill", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    expect(fill.order?.status).toBe("filled");
    continueSnapshot();
    const book = await pendingSnapshot;
    expect(book.item.bestAsk).toBe("8");
    expect(book.asks).toEqual([{ unitPrice: "8", quantity: "1", orderCount: 1 }]);
    expect((await service.read.book(buyerTwo, "stone", 5)).asks).toEqual([]);
  });

  it("does not mix browse summary and private player state across commits", async () => {
    await service.createOrder(seller, {
      requestId: "snapshot-player-ask", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    let browseRead!: () => void;
    let continueSnapshot!: () => void;
    const browseReady = new Promise<void>((resolve) => { browseRead = resolve; });
    const resume = new Promise<void>((resolve) => { continueSnapshot = resolve; });
    const wrappedPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: unknown[]) => {
            const result = await client.query(text, values);
            if (text.includes("ORDER BY lower(asset.display_name) ASC")) {
              browseRead();
              await resume;
            }
            return result;
          },
          release: (error?: Error) => client.release(error)
        };
      }
    } as unknown as pg.Pool;
    const reads = new MarketReadService(wrappedPool, config);
    const pendingSnapshot = reads.snapshot(
      buyer,
      LEGACY_TEST_AUTHORITY,
      { search: "stone" }
    );
    await browseReady;
    await service.createOrder(buyer, {
      requestId: "snapshot-player-fill", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    continueSnapshot();

    const snapshot = await pendingSnapshot;
    expect(snapshot.items.find((item) => item.itemId === "stone")?.bestAsk).toBe("8");
    expect(snapshot.player).toMatchObject({
      walletGold: "1000",
      activeOrders: [],
      recentFills: [],
      collection: { items: [], gold: "0" }
    });
    const current = await service.read.snapshot(buyer, { search: "stone" });
    expect(current.items.find((item) => item.itemId === "stone")?.bestAsk).toBeNull();
    expect(current.player.walletGold).toBe("992");
    expect(current.player.collection.items).toEqual([]);
  });

  it("quotes and matches deterministic batches while enforcing the global open-book limit", async () => {
    const boundedConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      MARKET_GLOBAL_ACCESS: "true",
      MARKET_MAX_OPEN_ORDERS_PER_ITEM: "3",
      MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK: "3"
    });
    const batched = createLegacyMarketTestService(pool, boundedConfig, createLogger("test"), { matchingBatchSize: 2 });
    const sellers: MarketActor[] = [
      { playerId: "batch-seller-a", accountId: "00000000-0000-4000-8000-000000000621" },
      { playerId: "batch-seller-b", accountId: "00000000-0000-4000-8000-000000000622" },
      { playerId: "batch-seller-c", accountId: "00000000-0000-4000-8000-000000000623" },
      { playerId: "batch-seller-d", accountId: "00000000-0000-4000-8000-000000000624" }
    ];
    for (const actor of sellers) await seedActor(pool, actor, { gold: 0n, stone: 1 });
    for (let index = 0; index < 3; index += 1) {
      await batched.createOrder(sellers[index]!, {
        requestId: `batch-sell-${index + 1}-001`, interface: "merchant", side: "sell",
        itemId: "stone", quantity: "1", unitPrice: String(8 + index)
      });
    }
    await expect(batched.createOrder(sellers[3]!, {
      requestId: "batch-sell-limit-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "11"
    })).rejects.toMatchObject({ code: "MARKET_ITEM_ORDER_LIMIT" });

    const quote = await batched.quote(buyer, "batch-quote-001", "stone", "3");
    expect(quote).toMatchObject({
      fillableQuantity: "3",
      quotedTotal: "27",
      maximumUnitPrice: "10",
      fullQuantityAvailable: true
    });
    const purchase = await batched.simpleBuy(buyer, "batch-simple-buy-001", quote.quoteId, "28");
    expect(purchase.trades.map((trade) => trade.unitPrice)).toEqual(["8", "9", "10"]);
    expect(purchase.order).toMatchObject({ status: "filled", remainingQuantity: "0" });
    await expectReconciled(reconcile);
  });

  it("allows fully crossing Merchant takers through a saturated ask and bid book", async () => {
    const cappedConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      MARKET_GLOBAL_ACCESS: "true",
      MARKET_MAX_OPEN_ORDERS_PER_ITEM: "2",
      MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK: "1"
    });
    const capped = createLegacyMarketTestService(pool, cappedConfig, createLogger("test"));
    const sellerTwo: MarketActor = {
      playerId: "saturated-seller-two",
      accountId: "00000000-0000-4000-8000-000000000681"
    };
    await seedActor(pool, sellerTwo, { gold: 0n, stone: 2 });
    const firstAsk = await capped.createOrder(seller, {
      requestId: "saturated-ask-one", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    const secondAsk = await capped.createOrder(sellerTwo, {
      requestId: "saturated-ask-two", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    const buy = await capped.createOrder(buyer, {
      requestId: "saturated-cross-buy", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "2", unitPrice: "10"
    });
    expect(buy.order).toMatchObject({ status: "filled", remainingQuantity: "0" });
    expect(buy.trades.map((trade) => trade.unitPrice)).toEqual(["8", "8"]);
    const makerOrder = await pool.query<{ maker_order_id: string }>(
      `SELECT maker_order_id FROM market_trades
       WHERE trade_id = ANY($1::uuid[])
       ORDER BY book_version`,
      [buy.trades.map((trade) => trade.tradeId)]
    );
    expect(makerOrder.rows.map((row) => row.maker_order_id)).toEqual([
      firstAsk.order!.orderId,
      secondAsk.order!.orderId
    ]);

    await capped.createOrder(buyer, {
      requestId: "saturated-bid-one", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "7"
    });
    await capped.createOrder(buyerTwo, {
      requestId: "saturated-bid-two", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "6"
    });
    const sell = await capped.createOrder(seller, {
      requestId: "saturated-cross-sell", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "5"
    });
    expect(sell.order).toMatchObject({ status: "filled", remainingQuantity: "0" });
    expect(sell.trades.map((trade) => trade.unitPrice)).toEqual(["7", "6"]);
    await expectReconciled(reconcile);
  });

  it("allows a fully crossing order at the actor cap but atomically rejects an illegal remainder", async () => {
    const cappedConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      MARKET_GLOBAL_ACCESS: "true",
      MARKET_MAX_ACTIVE_ORDERS_PER_PLAYER: "1",
      MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK: "1"
    });
    const capped = createLegacyMarketTestService(pool, cappedConfig, createLogger("test"));
    await capped.createOrder(buyer, {
      requestId: "actor-cap-resting-bid", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "1"
    });
    const ask = await capped.createOrder(seller, {
      requestId: "actor-cap-crossing-ask", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    const full = await capped.createOrder(buyer, {
      requestId: "actor-cap-full-cross", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    expect(full.order).toMatchObject({ status: "filled", remainingQuantity: "0" });

    const secondAsk = await capped.createOrder(seller, {
      requestId: "actor-cap-rollback-ask", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    const beforeRollback = await marketRollbackState(
      pool,
      buyer,
      secondAsk.order!.orderId,
      "actor-cap-partial-rollback"
    );
    await expect(capped.createOrder(buyer, {
      requestId: "actor-cap-partial-rollback", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "2", unitPrice: "8"
    })).rejects.toMatchObject({ code: "MARKET_ACTIVE_ORDER_LIMIT" });
    expect(await marketRollbackState(
      pool,
      buyer,
      secondAsk.order!.orderId,
      "actor-cap-partial-rollback"
    )).toEqual(beforeRollback);
    expect((await capped.read.order(pool as never, secondAsk.order!.orderId))).toMatchObject({
      status: "open",
      remainingQuantity: "1"
    });
    expect(ask.order?.orderId).not.toBe(secondAsk.order?.orderId);
    await expectReconciled(reconcile);
  });

  it("keeps immutable per-side fee snapshots fillable across policy rotation", async () => {
    await pool.query(
      `INSERT INTO market_fee_policies (
         fee_policy_id, version, listing_fee, buyer_fee_bps, seller_fee_bps, cancellation_fee, active
       ) VALUES
         (31, 3101, 0, 900, 1000, 0, true),
         (32, 3201, 0, 900, 2000, 0, true),
         (33, 3301, 1, 0, 0, 0, true),
         (34, 3401, 0, 0, 0, 1, true)
       ON CONFLICT (fee_policy_id) DO NOTHING`
    );
    const sellerTwo: MarketActor = {
      playerId: "fee-seller-two",
      accountId: "00000000-0000-4000-8000-000000000625"
    };
    await seedActor(pool, sellerTwo, { gold: 0n, stone: 5 });
    await pool.query("UPDATE market_venues SET fee_policy_id = 31 WHERE venue_key = 'global'");

    await service.createOrder(seller, {
      requestId: "fee-ask-eight-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    await service.createOrder(sellerTwo, {
      requestId: "fee-ask-nine-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "9"
    });
    const improved = await service.createOrder(buyer, {
      requestId: "fee-buy-partial-001", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "3", unitPrice: "10"
    });
    expect(improved.trades.map((trade) => [trade.unitPrice, trade.quantity])).toEqual([
      ["8", "1"],
      ["9", "1"]
    ]);
    expect(improved.order).toMatchObject({ status: "partially_filled", remainingQuantity: "1" });
    const improvementRefund = await pool.query<{ amount: string }>(
      `SELECT coalesce(sum(delta_gold), 0)::text AS amount
       FROM wallet_events
       WHERE player_id = $1 AND operation_key LIKE 'market-trade-refund:%'`,
      [buyer.playerId]
    );
    expect(improvementRefund.rows[0]?.amount).toBe("5");
    await service.cancelOrder(buyer, "fee-buy-partial-cancel-001", improved.order!.orderId);
    const cancellationRefund = await pool.query<{ amount: string }>(
      `SELECT delta_gold::text AS amount FROM wallet_events
       WHERE operation_key = $1`,
      [`market-cancel-gold:${improved.order!.orderId}`]
    );
    expect(cancellationRefund.rows[0]?.amount).toBe("10");

    const restingBuy = await service.createOrder(buyer, {
      requestId: "fee-resting-buy-001", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "2", unitPrice: "12"
    });
    await pool.query("UPDATE market_venues SET fee_policy_id = 32 WHERE venue_key = 'global'");
    await pool.query("UPDATE market_fee_policies SET active = false WHERE fee_policy_id = 31");
    const rotatedFill = await service.createOrder(seller, {
      requestId: "fee-rotated-sell-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "12"
    });
    expect(rotatedFill.trades).toHaveLength(1);
    const snapshot = await pool.query<{
      buyer_fee: string;
      seller_fee: string;
      buyer_fee_policy_id: number;
      buyer_fee_policy_version: number;
      seller_fee_policy_id: number;
      seller_fee_policy_version: number;
    }>(
      `SELECT buyer_fee::text, seller_fee::text,
              buyer_fee_policy_id, buyer_fee_policy_version,
              seller_fee_policy_id, seller_fee_policy_version
       FROM market_trades WHERE trade_id = $1`,
      [rotatedFill.trades[0]!.tradeId]
    );
    expect(snapshot.rows[0]).toMatchObject({
      buyer_fee: "1",
      seller_fee: "2",
      buyer_fee_policy_id: 2,
      buyer_fee_policy_version: 2,
      seller_fee_policy_id: 32,
      seller_fee_policy_version: 3201
    });
    await service.cancelOrder(buyer, "fee-resting-buy-cancel-001", restingBuy.order!.orderId);
    await expect(pool.query(
      "UPDATE market_fee_policies SET buyer_fee_bps = 1 WHERE fee_policy_id = 31"
    )).rejects.toThrow(/economic terms are immutable/i);
    await pool.query("UPDATE market_fee_policies SET active = true WHERE fee_policy_id = 31");

    for (const feePolicyId of [33, 34]) {
      await pool.query("UPDATE market_venues SET fee_policy_id = $1 WHERE venue_key = 'global'", [feePolicyId]);
      await expect(service.createOrder(sellerTwo, {
        requestId: `unsupported-fee-${feePolicyId}-001`, interface: "merchant", side: "sell",
        itemId: "stone", quantity: "1", unitPrice: "20"
      })).rejects.toMatchObject({ code: "MARKET_FEE_POLICY_UNSUPPORTED" });
    }
    await pool.query("UPDATE market_venues SET fee_policy_id = 31 WHERE venue_key = 'global'");
    await expectReconciled(reconcile);
  });

  it("durably deduplicates concurrent creates and prevents double escrow from inventory or wallet", async () => {
    const input = {
      requestId: "duplicate-sell-001", interface: "simple" as const, side: "sell" as const,
      itemId: "stone", quantity: "10", unitPrice: "9"
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => service.createOrder(seller, input)));
    expect(new Set(results.map((result) => result.order?.orderId)).size).toBe(1);
    expect(results.filter((result) => result.replayed).length).toBe(19);
    const orders = await pool.query("SELECT order_id FROM market_orders WHERE account_id = $1", [seller.accountId]);
    expect(orders.rowCount).toBe(1);
    const inventory = await pool.query<{ quantity: number }>(
      "SELECT quantity FROM player_inventory WHERE player_id = $1 AND resource_type = 'stone' AND variant = 'default'",
      [seller.playerId]
    );
    expect(Number(inventory.rows[0]?.quantity)).toBe(20);

    const races = await Promise.allSettled([
      service.createOrder(seller, { ...input, requestId: "inventory-race-one", quantity: "15" }),
      service.createOrder(seller, { ...input, requestId: "inventory-race-two", quantity: "15" })
    ]);
    expect(races.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expectReconciled(reconcile);
  }, 30_000);

  it("serializes concurrent first mutations by the same authenticated actor", async () => {
    const results = await Promise.all([
      service.createOrder(seller, {
        requestId: "first-actor-race-one", interface: "merchant", side: "sell",
        itemId: "stone", quantity: "1", unitPrice: "8"
      }),
      service.createOrder(seller, {
        requestId: "first-actor-race-two", interface: "merchant", side: "sell",
        itemId: "stone", quantity: "1", unitPrice: "9"
      })
    ]);
    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.order?.orderId)).size).toBe(2);
    expect((await pool.query(
      "SELECT 1 FROM market_player_controls WHERE account_id=$1 AND player_id=$2",
      [seller.accountId, seller.playerId]
    )).rowCount).toBe(1);
    await expectReconciled(reconcile);
  });

  it("allows only one of two concurrent buy escrows against the same exact wallet balance", async () => {
    const walletActor: MarketActor = {
      playerId: "wallet-race-buyer",
      accountId: "22000000-0000-4000-8000-000000000001"
    };
    await seedActor(pool, walletActor, { gold: 11n, stone: 0 });

    const attempts = await Promise.allSettled([
      service.createOrder(walletActor, {
        requestId: "wallet-race-buy-one-001", interface: "merchant", side: "buy",
        itemId: "stone", quantity: "1", unitPrice: "10"
      }),
      service.createOrder(walletActor, {
        requestId: "wallet-race-buy-two-001", interface: "merchant", side: "buy",
        itemId: "stone", quantity: "1", unitPrice: "10"
      })
    ]);
    const fulfilled = attempts.filter(
      (result): result is PromiseFulfilledResult<MarketMutationResult> => result.status === "fulfilled"
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "MARKET_NOT_ENOUGH_GOLD" });
    expect(fulfilled[0]?.value.order).toMatchObject({ side: "buy", status: "open" });

    const exact = await pool.query<{
      wallet: string;
      escrow: string;
      open_orders: string;
      debit_events: string;
    }>(
      `SELECT
         (SELECT gold_balance::text FROM player_wallets WHERE account_id=$1) AS wallet,
         (SELECT coalesce(sum(e.remaining_amount),0)::text
          FROM market_order_escrows e JOIN market_orders o ON o.order_id=e.order_id
          WHERE o.account_id=$1 AND e.asset_kind='gold') AS escrow,
         (SELECT count(*)::text FROM market_orders
          WHERE account_id=$1 AND status IN ('open','partially_filled')) AS open_orders,
         (SELECT count(*)::text FROM wallet_events
          WHERE account_id=$1 AND reason='market_buy_escrow') AS debit_events`,
      [walletActor.accountId]
    );
    expect(exact.rows[0]).toEqual({
      wallet: "1",
      escrow: "10",
      open_orders: "1",
      debit_events: "1"
    });
    await expectReconciled(reconcile);
  }, 30_000);

  it("never exceeds a small same-book limit under concurrent resting creates", async () => {
    const limit = 3;
    const contenders = Array.from({ length: 12 }, (_, index): MarketActor => ({
      playerId: `limit-seller-${String(index + 1).padStart(2, "0")}`,
      accountId: `23000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    }));
    await seedActorsBulk(pool, contenders, { gold: 0n, stone: 1 });
    const limitedConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      MARKET_GLOBAL_ACCESS: "true",
      MARKET_MAX_OPEN_ORDERS_PER_ITEM: String(limit),
      MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK: String(limit),
      MARKET_TRANSACTION_RETRY_LIMIT: "3"
    });
    const limited = createLegacyMarketTestService(pool, limitedConfig, createLogger("test"));

    const attempts = await Promise.allSettled(contenders.map((actor, index) =>
      limited.createOrder(actor, {
        requestId: `concurrent-book-limit-${String(index + 1).padStart(2, "0")}`,
        interface: "merchant",
        side: "sell",
        itemId: "stone",
        quantity: "1",
        unitPrice: "50"
      })
    ));
    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(fulfilled).toHaveLength(limit);
    expect(rejected).toHaveLength(contenders.length - limit);
    expect(rejected.every((result) => result.reason?.code === "MARKET_ITEM_ORDER_LIMIT")).toBe(true);

    const playerIds = contenders.map((actor) => actor.playerId);
    const exact = await pool.query<{ open_orders: string; escrow: string; inventory: string }>(
      `SELECT
         (SELECT count(*)::text FROM market_orders
          WHERE side='sell' AND status IN ('open','partially_filled')) AS open_orders,
         (SELECT coalesce(sum(remaining_amount),0)::text FROM market_order_escrows
          WHERE asset_kind='item') AS escrow,
         (SELECT coalesce(sum(quantity),0)::text FROM player_inventory
          WHERE player_id=ANY($1::text[]) AND resource_type='stone' AND variant='default') AS inventory`,
      [playerIds]
    );
    expect(exact.rows[0]).toEqual({ open_orders: "3", escrow: "3", inventory: "9" });
    await expectReconciled(reconcile);
  }, 30_000);

  it("serializes two hundred distinct buyers racing for one final unit", async () => {
    const racers = Array.from({ length: 200 }, (_, index): MarketActor => ({
      playerId: `scarce-buyer-${String(index + 1).padStart(3, "0")}`,
      accountId: `24000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    }));
    await seedActorsBulk(pool, racers, { gold: 20n, stone: 0 });
    const raceConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      MARKET_GLOBAL_ACCESS: "true",
      MARKET_MAX_OPEN_ORDERS_PER_ITEM: "500",
      MARKET_REQUESTS_PER_MINUTE: "1000",
      MARKET_TRANSACTION_RETRY_LIMIT: "5"
    });
    const raceService = createLegacyMarketTestService(pool, raceConfig, createLogger("test"));
    const ask = await raceService.createOrder(seller, {
      requestId: "two-hundred-race-ask-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });

    const results = await Promise.all(racers.map((actor, index) =>
      raceService.createOrder(actor, {
        requestId: `two-hundred-race-buy-${String(index + 1).padStart(3, "0")}`,
        interface: "merchant",
        side: "buy",
        itemId: "stone",
        quantity: "1",
        unitPrice: "8"
      })
    ));
    expect(results.flatMap((result) => result.trades)).toHaveLength(1);
    expect(results.filter((result) => result.order?.status === "filled")).toHaveLength(1);
    expect(results.filter((result) => result.order?.status === "open")).toHaveLength(199);
    expect(new Set(results.map((result) => result.order?.orderId)).size).toBe(200);
    expect((await raceService.read.order(pool, ask.order!.orderId))?.status).toBe("filled");

    const exact = await pool.query<{ trades: string; open_buys: string; buy_escrow: string }>(
      `SELECT
         (SELECT count(*)::text FROM market_trades) AS trades,
         (SELECT count(*)::text FROM market_orders
          WHERE side='buy' AND status IN ('open','partially_filled')) AS open_buys,
         (SELECT coalesce(sum(e.remaining_amount),0)::text
          FROM market_order_escrows e JOIN market_orders o ON o.order_id=e.order_id
          WHERE e.asset_kind='gold' AND o.side='buy') AS buy_escrow`
    );
    expect(exact.rows[0]).toEqual({ trades: "1", open_buys: "199", buy_escrow: "1592" });
    await expectReconciled(reconcile);
  }, 120_000);

  it("fills many same-price buyers in authoritative time-priority order", async () => {
    const buyerCount = 10;
    const fillCount = 6;
    const samePriceBuyers = Array.from({ length: buyerCount }, (_, index): MarketActor => ({
      playerId: `priority-buyer-${String(index + 1).padStart(2, "0")}`,
      accountId: `25000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    }));
    await seedActorsBulk(pool, samePriceBuyers, { gold: 20n, stone: 0 });
    const priorityConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      MARKET_GLOBAL_ACCESS: "true",
      MARKET_MAX_OPEN_ORDERS_PER_ITEM: "20",
      MARKET_TRANSACTION_RETRY_LIMIT: "3"
    });
    const priorityService = createLegacyMarketTestService(pool, priorityConfig, createLogger("test"));

    const bids = await Promise.all(samePriceBuyers.map((actor, index) =>
      priorityService.createOrder(actor, {
        requestId: `priority-buy-${String(index + 1).padStart(2, "0")}`,
        interface: "merchant",
        side: "buy",
        itemId: "stone",
        quantity: "1",
        unitPrice: "10"
      })
    ));
    expect(bids.every((result) => result.order?.status === "open" && result.trades.length === 0))
      .toBe(true);

    const ordered = await pool.query<{ order_id: string; priority_sequence: string }>(
      `SELECT order_id, priority_sequence::text
       FROM market_orders
       WHERE side='buy' AND limit_unit_price=10
         AND status IN ('open','partially_filled')
       ORDER BY priority_sequence ASC`
    );
    expect(ordered.rowCount).toBe(buyerCount);
    const expectedFilledOrderIds = ordered.rows.slice(0, fillCount).map((row) => row.order_id);

    const largeSell = await priorityService.createOrder(seller, {
      requestId: "priority-large-sell-001",
      interface: "merchant",
      side: "sell",
      itemId: "stone",
      quantity: String(fillCount),
      unitPrice: "8"
    });
    expect(largeSell.order).toMatchObject({ status: "filled", remainingQuantity: "0" });
    expect(largeSell.trades).toHaveLength(fillCount);
    expect(largeSell.trades.every((trade) => trade.quantity === "1" && trade.unitPrice === "10"))
      .toBe(true);

    const settled = await pool.query<{
      buy_order_id: string;
      unit_price: string;
      priority_sequence: string;
    }>(
      `SELECT t.buy_order_id, t.unit_price::text, o.priority_sequence::text
       FROM market_trades t
       JOIN market_orders o ON o.order_id=t.buy_order_id
       ORDER BY o.priority_sequence ASC`
    );
    expect(settled.rows.map((row) => row.buy_order_id)).toEqual(expectedFilledOrderIds);
    expect(settled.rows.map((row) => row.priority_sequence))
      .toEqual(ordered.rows.slice(0, fillCount).map((row) => row.priority_sequence));
    expect(settled.rows.every((row) => row.unit_price === "10")).toBe(true);
    expect(Number((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM market_orders
       WHERE side='buy' AND status='open'`
    )).rows[0]?.count)).toBe(buyerCount - fillCount);
    await expectReconciled(reconcile);
  }, 30_000);

  it("serializes order placement against an authoritative player freeze", async () => {
    await pool.query(
      `INSERT INTO market_player_controls (account_id, player_id, mutations_frozen)
       VALUES ($1,$2,false)`,
      [seller.accountId, seller.playerId]
    );
    const [creation, freeze] = await Promise.allSettled([
      service.createOrder(seller, {
        requestId: "player-freeze-race-order-001", interface: "merchant", side: "sell",
        itemId: "stone", quantity: "1", unitPrice: "40"
      }),
      auditedControlUpdate(
        pool,
        `UPDATE market_player_controls
         SET mutations_frozen=true, updated_at=now() WHERE account_id=$1`,
        "freeze player during serialization test",
        [seller.accountId]
      )
    ]);
    expect(freeze.status).toBe("fulfilled");
    if (creation.status === "fulfilled") {
      expect(creation.value.order).toMatchObject({ status: "open", remainingQuantity: "1" });
    } else {
      expect(creation.reason).toMatchObject({ code: "MARKET_PLAYER_FROZEN" });
    }
    const exact = await pool.query<{
      frozen: boolean;
      orders: string;
      inventory: string;
      escrow: string;
    }>(
      `SELECT
         (SELECT mutations_frozen FROM market_player_controls WHERE account_id=$1) AS frozen,
         (SELECT count(*)::text FROM market_orders WHERE account_id=$1) AS orders,
         (SELECT quantity::text FROM player_inventory
          WHERE player_id=$2 AND resource_type='stone' AND variant='default') AS inventory,
         (SELECT coalesce(sum(e.remaining_amount),0)::text
          FROM market_order_escrows e JOIN market_orders o ON o.order_id=e.order_id
          WHERE o.account_id=$1 AND e.asset_kind='item') AS escrow`,
      [seller.accountId, seller.playerId]
    );
    expect(exact.rows[0]?.frozen).toBe(true);
    if (creation.status === "fulfilled") {
      expect(exact.rows[0]).toMatchObject({ orders: "1", inventory: "29", escrow: "1" });
    } else {
      expect(exact.rows[0]).toMatchObject({ orders: "0", inventory: "30", escrow: "0" });
    }
    await auditedControlUpdate(
      pool,
      `UPDATE market_player_controls SET mutations_frozen=false, updated_at=now() WHERE account_id=$1`,
      "unfreeze player after serialization test",
      [seller.accountId]
    );
    await expectReconciled(reconcile);
  }, 30_000);

  it("collapses one thousand duplicate requests into one economic result", async () => {
    const input = {
      requestId: "thousand-replays-001", interface: "merchant" as const, side: "sell" as const,
      itemId: "stone", quantity: "1", unitPrice: "11"
    };
    const results = await Promise.all(
      Array.from({ length: 1_000 }, () => service.createOrder(seller, input))
    );
    expect(new Set(results.map((result) => result.order?.orderId)).size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(999);
    expect((await pool.query("SELECT 1 FROM market_orders WHERE account_id=$1", [seller.accountId])).rowCount).toBe(1);
    expect(Number((await pool.query<{ quantity: number }>(
      "SELECT quantity FROM player_inventory WHERE player_id=$1 AND resource_type='stone' AND variant='default'",
      [seller.playerId]
    )).rows[0]?.quantity)).toBe(29);
    await expectReconciled(reconcile);
  }, 120_000);

  it("serializes scarce supply, fill/cancel, and self-trade attempts", async () => {
    const ask = await service.createOrder(seller, {
      requestId: "scarce-sell-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "5"
    });
    const buyers = await Promise.all([
      service.createOrder(buyer, {
        requestId: "scarce-buy-one", interface: "merchant", side: "buy",
        itemId: "stone", quantity: "1", unitPrice: "5"
      }),
      service.createOrder(buyerTwo, {
        requestId: "scarce-buy-two", interface: "merchant", side: "buy",
        itemId: "stone", quantity: "1", unitPrice: "5"
      })
    ]);
    expect(buyers.flatMap((result) => result.trades)).toHaveLength(1);

    await service.createOrder(seller, {
      requestId: "self-buy-skip-001", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "50"
    });
    const selfTrades = await pool.query(
      "SELECT 1 FROM market_trades WHERE buyer_player_id = seller_player_id"
    );
    expect(selfTrades.rowCount).toBe(0);
    expect(ask.order?.orderId).toBeTruthy();
    await expectReconciled(reconcile);
  });

  it("resolves fill-versus-cancel and duplicate-cancel races under the same durable book lock", async () => {
    const ask = await service.createOrder(seller, {
      requestId: "fill-cancel-ask-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "5", unitPrice: "8"
    });
    const raced = await Promise.allSettled([
      service.createOrder(buyer, {
        requestId: "fill-cancel-buy-001", interface: "merchant", side: "buy",
        itemId: "stone", quantity: "5", unitPrice: "8"
      }),
      service.cancelOrder(seller, "fill-cancel-cancel-001", ask.order!.orderId)
    ]);
    expect(raced.some((result) => result.status === "fulfilled")).toBe(true);
    const settledAsk = await service.read.order(pool, ask.order!.orderId);
    expect(["filled", "cancelled"]).toContain(settledAsk?.status);

    const secondAsk = await service.createOrder(seller, {
      requestId: "double-cancel-ask-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "20"
    });
    const cancellations = await Promise.allSettled([
      service.cancelOrder(seller, "double-cancel-one-001", secondAsk.order!.orderId),
      service.cancelOrder(seller, "double-cancel-two-001", secondAsk.order!.orderId)
    ]);
    expect(cancellations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await service.read.order(pool, secondAsk.order!.orderId))?.status).toBe("cancelled");
    await expectReconciled(reconcile);
  });

  it("serializes claim-versus-claim so assets move once", async () => {
    await expireTestOrder(pool, service, seller, "claim-race-ask-001", "sell", "3", "8");
    const claims = await Promise.all([
      service.claim(seller, "claim-race-one-001", "all"),
      service.claim(seller, "claim-race-two-001", "all")
    ]);
    expect(claims.reduce((sum, claim) => sum + BigInt(claim.claimedItems), 0n)).toBe(3n);
    expect((await service.read.snapshot(seller)).player.collection.items).toEqual([]);
    expect((await pool.query<{ quantity: string }>(
      "SELECT quantity FROM player_inventory WHERE player_id=$1 AND resource_type='stone'",
      [seller.playerId]
    )).rows[0]?.quantity).toBe("30");
    expect(await service.claim(seller, "claim-race-one-001", "all"))
      .toMatchObject({ ...claims[0], replayed: true });
    await expectReconciled(reconcile);
  });

  it("serializes matching against an item freeze without partial settlement", async () => {
    const ask = await service.createOrder(seller, {
      requestId: "freeze-race-ask-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "8"
    });
    const bookId = (await pool.query<{ book_id: string }>(
      "SELECT book_id FROM market_orders WHERE order_id=$1",
      [ask.order!.orderId]
    )).rows[0]!.book_id;
    await Promise.allSettled([
      service.createOrder(buyer, {
        requestId: "freeze-race-buy-001", interface: "merchant", side: "buy",
        itemId: "stone", quantity: "2", unitPrice: "8"
      }),
      auditedControlUpdate(
        pool,
        "UPDATE market_order_books SET frozen=true WHERE book_id=$1",
        "freeze book during serialization test",
        [bookId]
      )
    ]);
    await auditedControlUpdate(
      pool,
      "UPDATE market_order_books SET frozen=false WHERE book_id=$1",
      "unfreeze book after serialization test",
      [bookId]
    );
    await expectReconciled(reconcile);
  });

  it("rolls back injected pre-commit faults and replays committed lost responses", async () => {
    const failing = createLegacyMarketTestService(pool, config, createLogger("test"), {
      faultInjector: failOnceAt("after_inventory_debit")
    });
    await expect(failing.createOrder(seller, {
      requestId: "fault-rollback-001", interface: "simple", side: "sell",
      itemId: "stone", quantity: "4", unitPrice: "8"
    })).rejects.toThrow("injected:after_inventory_debit");
    expect((await pool.query("SELECT 1 FROM market_orders")).rowCount).toBe(0);
    expect(Number((await pool.query<{ quantity: number }>(
      "SELECT quantity FROM player_inventory WHERE player_id = $1 AND resource_type = 'stone' AND variant = 'default'",
      [seller.playerId]
    )).rows[0]?.quantity)).toBe(30);

    const lostResponse = createLegacyMarketTestService(pool, config, createLogger("test"), {
      faultInjector: failOnceAt("after_commit_before_response")
    });
    const request = {
      requestId: "fault-lost-response-001", interface: "simple" as const, side: "sell" as const,
      itemId: "stone", quantity: "4", unitPrice: "8"
    };
    await expect(lostResponse.createOrder(seller, request)).rejects.toThrow("injected:after_commit_before_response");
    const replay = await service.createOrder(seller, request);
    expect(replay.replayed).toBe(true);
    expect((await pool.query("SELECT 1 FROM market_orders")).rowCount).toBe(1);
    await expectReconciled(reconcile);
  });

  it("recovers exact committed trade truth after a fresh service and connection-pool restart", async () => {
    const sellInput = {
      requestId: "restart-recovery-sell-001",
      interface: "merchant" as const,
      side: "sell" as const,
      itemId: "stone",
      quantity: "4",
      unitPrice: "8"
    };
    const buyInput = {
      requestId: "restart-recovery-buy-001",
      interface: "merchant" as const,
      side: "buy" as const,
      itemId: "stone",
      quantity: "4",
      unitPrice: "10"
    };
    let committedSell!: MarketMutationResult;
    let committedBuy!: MarketMutationResult;

    const preRestartPool = new Pool({ connectionString: databaseUrl!, max: 4 });
    try {
      const preRestartService = createLegacyMarketTestService(preRestartPool, config, createLogger("test"));
      committedSell = await preRestartService.createOrder(seller, sellInput);
      committedBuy = await preRestartService.createOrder(buyer, buyInput);
      expect(committedBuy.trades).toHaveLength(1);
      expect(committedBuy.trades[0]).toMatchObject({ quantity: "4", unitPrice: "8", total: "32" });
    } finally {
      await preRestartPool.end();
    }

    const postTradeRestartPool = new Pool({ connectionString: databaseUrl!, max: 4 });
    try {
      const restartedService = createLegacyMarketTestService(postTradeRestartPool, config, createLogger("test"));
      const restartedReconciliation = new MarketReconciliationService(postTradeRestartPool);

      const replayedSell = await restartedService.createOrder(seller, sellInput);
      const replayedBuy = await restartedService.createOrder(buyer, buyInput);
      expect(replayedSell.replayed).toBe(true);
      expect(replayedBuy.replayed).toBe(true);
      expect({ ...replayedSell, replayed: false }).toEqual(committedSell);
      expect({ ...replayedBuy, replayed: false }).toEqual(committedBuy);

      const book = await restartedService.read.book(buyer, "stone", 10);
      expect(book.asks).toEqual([]);
      expect(book.bids).toEqual([]);
      expect(book.recentTrades).toHaveLength(1);
      expect(book.recentTrades[0]).toMatchObject({
        tradeId: committedBuy.trades[0]!.tradeId,
        quantity: "4",
        unitPrice: "8",
        total: "32"
      });

      const buyerSnapshot = await restartedService.read.snapshot(buyer);
      const sellerSnapshot = await restartedService.read.snapshot(seller);
      expect(buyerSnapshot.player).toMatchObject({
        walletGold: "966",
        activeOrders: [],
        collection: {
          items: [],
          gold: "0"
        }
      });
      expect(buyerSnapshot.player.recentFills).toHaveLength(1);
      expect(buyerSnapshot.player.recentFills[0]).toMatchObject({
        tradeId: committedBuy.trades[0]!.tradeId,
        side: "buy",
        quantity: "4",
        unitPrice: "8",
        total: "32"
      });
      expect(sellerSnapshot.player).toMatchObject({
        walletGold: "1032",
        activeOrders: [],
        collection: { items: [], gold: "0" }
      });
      expect((await postTradeRestartPool.query("SELECT 1 FROM market_trades")).rowCount).toBe(1);
      await expectReconciled(restartedReconciliation);

      const buyerClaim = await restartedService.claim(buyer, "restart-recovery-buyer-claim-001", "all");
      const sellerClaim = await restartedService.claim(seller, "restart-recovery-seller-claim-001", "gold");
      expect(buyerClaim).toMatchObject({ replayed: false, claimedItems: "0", claimedGold: "0" });
      expect(sellerClaim).toMatchObject({ replayed: false, claimedItems: "0", claimedGold: "0" });
      await expectReconciled(restartedReconciliation);
    } finally {
      await postTradeRestartPool.end();
    }

    const postClaimRestartPool = new Pool({ connectionString: databaseUrl!, max: 4 });
    try {
      const recoveredService = createLegacyMarketTestService(postClaimRestartPool, config, createLogger("test"));
      const recoveredReconciliation = new MarketReconciliationService(postClaimRestartPool);
      const replayedBuyerClaim = await recoveredService.claim(
        buyer,
        "restart-recovery-buyer-claim-001",
        "all"
      );
      const replayedSellerClaim = await recoveredService.claim(
        seller,
        "restart-recovery-seller-claim-001",
        "gold"
      );
      expect(replayedBuyerClaim).toMatchObject({ replayed: true, claimedItems: "0", claimedGold: "0" });
      expect(replayedSellerClaim).toMatchObject({ replayed: true, claimedItems: "0", claimedGold: "0" });

      const recoveredBuyer = await recoveredService.read.snapshot(buyer);
      const recoveredSeller = await recoveredService.read.snapshot(seller);
      expect(recoveredBuyer.player).toMatchObject({
        walletGold: "966",
        activeOrders: [],
        collection: { items: [], gold: "0" }
      });
      expect(recoveredSeller.player).toMatchObject({
        walletGold: "1032",
        activeOrders: [],
        collection: { items: [], gold: "0" }
      });
      expect(Number((await postClaimRestartPool.query<{ quantity: number }>(
        `SELECT quantity FROM player_inventory
         WHERE player_id=$1 AND resource_type='stone' AND variant='default'`,
        [buyer.playerId]
      )).rows[0]?.quantity)).toBe(4);
      expect((await postClaimRestartPool.query("SELECT 1 FROM market_trades")).rowCount).toBe(1);
      expect((await postClaimRestartPool.query(
        `SELECT 1 FROM market_claims
         WHERE client_request_id IN ('restart-recovery-buyer-claim-001','restart-recovery-seller-claim-001')`
      )).rowCount).toBe(2);
      await expectReconciled(recoveredReconciliation);
    } finally {
      await postClaimRestartPool.end();
    }
  }, 30_000);

  it.each([
    "before_inventory_debit",
    "after_inventory_debit",
    "after_escrow_creation",
    "after_order_creation",
    "after_ledger_insert",
    "before_commit"
  ] as MarketFaultPoint[])("rolls back a sell order fault at %s", async (point) => {
    const faulted = createLegacyMarketTestService(pool, config, createLogger("test"), {
      faultInjector: failOnceAt(point)
    });
    await expect(faulted.createOrder(seller, {
      requestId: `fault-${point.replaceAll("_", "-")}-001`,
      interface: "simple",
      side: "sell",
      itemId: "stone",
      quantity: "4",
      unitPrice: "8"
    })).rejects.toThrow(`injected:${point}`);
    expect((await pool.query("SELECT 1 FROM market_orders")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM market_order_escrows")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM market_ledger_groups")).rowCount).toBe(0);
    expect(Number((await pool.query<{ quantity: number }>(
      "SELECT quantity FROM player_inventory WHERE player_id=$1 AND resource_type='stone' AND variant='default'",
      [seller.playerId]
    )).rows[0]?.quantity)).toBe(30);
    await expectReconciled(reconcile);
  });

  it.each([
    ["after_trade_insert", 1],
    ["after_ledger_insert", 2],
    ["midway_multi_fill", 1]
  ] as const)("rolls back multi-fill settlement at %s", async (point, occurrence) => {
    await service.createOrder(seller, {
      requestId: `fault-setup-ask-one-${point}`, interface: "merchant", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "7"
    });
    const sellerTwo = {
      playerId: `fault-seller-${point}`,
      accountId: point === "after_trade_insert"
        ? "00000000-0000-4000-8000-000000000621"
        : point === "after_ledger_insert"
          ? "00000000-0000-4000-8000-000000000622"
          : "00000000-0000-4000-8000-000000000623"
    };
    await seedActor(pool, sellerTwo, { gold: 0n, stone: 10 });
    await service.createOrder(sellerTwo, {
      requestId: `fault-setup-ask-two-${point}`, interface: "merchant", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "8"
    });
    const faulted = createLegacyMarketTestService(pool, config, createLogger("test"), {
      faultInjector: failOccurrenceAt(point, occurrence)
    });
    await expect(faulted.createOrder(buyer, {
      requestId: `fault-cross-${point}-001`, interface: "merchant", side: "buy",
      itemId: "stone", quantity: "4", unitPrice: "8"
    })).rejects.toThrow(`injected:${point}`);
    expect((await pool.query("SELECT 1 FROM market_trades")).rowCount).toBe(0);
    expect((await pool.query(
      "SELECT 1 FROM market_orders WHERE player_id=$1 AND side='buy'",
      [buyer.playerId]
    )).rowCount).toBe(0);
    await expectReconciled(reconcile);
  });

  it("rolls back faults during cancellation and claim", async () => {
    const ask = await service.createOrder(seller, {
      requestId: "fault-cancel-setup-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "4", unitPrice: "8"
    });
    const cancellationFault = createLegacyMarketTestService(pool, config, createLogger("test"), {
      faultInjector: failOnceAt("during_cancellation")
    });
    await expect(cancellationFault.cancelOrder(seller, "fault-cancel-001", ask.order!.orderId))
      .rejects.toThrow("injected:during_cancellation");
    expect((await service.read.snapshot(seller)).player.activeOrders).toHaveLength(1);

    await service.createOrder(buyer, {
      requestId: "fault-claim-cross-001", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    const before = (await service.read.snapshot(buyer)).player.collection;
    const claimFault = createLegacyMarketTestService(pool, config, createLogger("test"), {
      faultInjector: failOnceAt("during_claim")
    });
    await expect(claimFault.claim(buyer, "fault-claim-001", "all"))
      .rejects.toThrow("injected:during_claim");
    expect((await service.read.snapshot(buyer)).player.collection).toEqual(before);
    await expectReconciled(reconcile);
  });

  it("enforces database-backed read-only controls without discarding committed truth", async () => {
    await auditedGlobalControlUpdate(
      pool,
      "UPDATE market_global_controls SET read_only = true WHERE singleton",
      "enable read-only integration test"
    );
    await expect(service.createOrder(seller, {
      requestId: "read-only-sell-001", interface: "simple", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    })).rejects.toMatchObject({ code: "MARKET_READ_ONLY" });
    expect((await pool.query("SELECT 1 FROM market_orders")).rowCount).toBe(0);
    await auditedGlobalControlUpdate(
      pool,
      "UPDATE market_global_controls SET read_only = false WHERE singleton",
      "disable read-only integration test"
    );
    const result = await service.createOrder(seller, {
      requestId: "restored-sell-001", interface: "simple", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    expect(result.order?.status).toBe("open");
    await expectReconciled(reconcile);
  });

  it("gives matching_enabled independent authoritative-book semantics", async () => {
    await service.createOrder(seller, {
      requestId: "matching-control-ask", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "8"
    });
    const quote = await service.quote(buyerTwo, "matching-control-quote", "stone", "1");
    await auditedGlobalControlUpdate(
      pool,
      "UPDATE market_global_controls SET matching_enabled=false WHERE singleton",
      "pause matching for integration test"
    );

    const resting = await service.createOrder(buyer, {
      requestId: "matching-control-rest", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "7"
    });
    expect(resting.order).toMatchObject({ status: "open", remainingQuantity: "1" });
    await expect(service.createOrder(buyerTwo, {
      requestId: "matching-control-cross", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "8"
    })).rejects.toMatchObject({ code: "MARKET_MATCHING_DISABLED" });
    await expect(service.simpleBuy(buyerTwo, "matching-control-simple", quote.quoteId, "8"))
      .rejects.toMatchObject({ code: "MARKET_MATCHING_DISABLED" });
    await expect(service.cancelOrder(buyer, "matching-control-cancel", resting.order!.orderId))
      .resolves.toMatchObject({ order: { status: "cancelled" } });

    await auditedGlobalControlUpdate(
      pool,
      "UPDATE market_global_controls SET matching_enabled=true WHERE singleton",
      "resume matching for settlement"
    );
    await service.createOrder(buyer, {
      requestId: "matching-control-fill", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    await auditedGlobalControlUpdate(
      pool,
      "UPDATE market_global_controls SET matching_enabled=false WHERE singleton",
      "pause matching while claims remain enabled"
    );
    await expect(service.claim(buyer, "matching-control-item-claim", "items"))
      .resolves.toMatchObject({ claimedItems: "0" });
    await expect(service.claim(seller, "matching-control-gold-claim", "gold"))
      .resolves.toMatchObject({ claimedGold: "0" });
    await expectReconciled(reconcile);
  });

  it("serializes a crossing order behind a concurrent matching disable", async () => {
    await service.createOrder(seller, {
      requestId: "matching-race-ask", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    const control = await pool.connect();
    try {
      await control.query("BEGIN");
      await acquireMarketMutationSafetyLock(control);
      await setMarketControlAuditContext(control, {
        operatorIdentity: "test:market-integration",
        reason: "pause matching during control race"
      });
      await control.query(
        "SELECT singleton FROM market_global_controls WHERE singleton FOR UPDATE"
      );
      let orderSettled = false;
      const crossing = service.createOrder(buyer, {
        requestId: "matching-race-cross", interface: "merchant", side: "buy",
        itemId: "stone", quantity: "1", unitPrice: "8"
      }).then(
        (value) => { orderSettled = true; return { status: "fulfilled" as const, value }; },
        (reason: unknown) => { orderSettled = true; return { status: "rejected" as const, reason }; }
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(orderSettled).toBe(false);
      await control.query(
        "UPDATE market_global_controls SET matching_enabled=false WHERE singleton"
      );
      await control.query("COMMIT");
      const result = await crossing;
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "MARKET_MATCHING_DISABLED" }
      });
      expect((await pool.query("SELECT 1 FROM market_trades")).rowCount).toBe(0);
      await expectReconciled(reconcile);
    } catch (error) {
      await control.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      control.release();
    }
  }, 30_000);

  it("blocks a racing mutation from the failed snapshot through committed protection", async () => {
    await service.createOrder(seller, {
      requestId: "reconcile-race-corruption-source", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "8"
    });
    const corruptedEntry = (await pool.query<{ ledger_entry_id: string; amount: string }>(
      `SELECT ledger_entry_id::text, amount::text
       FROM market_ledger_entries
       WHERE amount > 0
       ORDER BY ledger_entry_id LIMIT 1`
    )).rows[0]!;
    await mutateImmutableLedgerEntryForTest(
      pool,
      corruptedEntry.ledger_entry_id,
      (BigInt(corruptedEntry.amount) + 1n).toString()
    );

    let snapshotOpened!: () => void;
    let continueDetection!: () => void;
    const opened = new Promise<void>((resolve) => { snapshotOpened = resolve; });
    const resume = new Promise<void>((resolve) => { continueDetection = resolve; });
    const reconciliationPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: unknown[]) => {
            const result = await client.query(text, values);
            if (text.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ")) {
              snapshotOpened();
              await resume;
            }
            return result;
          },
          release: (error?: Error) => client.release(error)
        };
      }
    } as unknown as pg.Pool;
    const racingReconciliation = new MarketReconciliationService(reconciliationPool);
    const reconciliationRun = racingReconciliation.reconcileRun();
    await opened;

    let mutationSettled = false;
    const mutation = service.createOrder(buyer, {
      requestId: "reconcile-race-blocked-order", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "1"
    }).then(
      (value) => { mutationSettled = true; return { status: "fulfilled" as const, value }; },
      (reason: unknown) => { mutationSettled = true; return { status: "rejected" as const, reason }; }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mutationSettled).toBe(false);
    continueDetection();

    const run = await reconciliationRun;
    expect(run.report.ok).toBe(false);
    expect(run.protection).toMatchObject({
      protectionApplied: true,
      globalReadOnly: false,
      frozenBookIds: [expect.any(String)]
    });
    const mutationResult = await mutation;
    expect(mutationResult).toMatchObject({
      status: "rejected",
      reason: { code: "MARKET_ITEM_FROZEN" }
    });
    expect((await pool.query(
      "SELECT 1 FROM market_orders WHERE client_request_id='reconcile-race-blocked-order'"
    )).rowCount).toBe(0);

    await mutateImmutableLedgerEntryForTest(
      pool,
      corruptedEntry.ledger_entry_id,
      corruptedEntry.amount
    );
    await auditedGlobalControlUpdate(
      pool,
      `UPDATE market_global_controls
       SET read_only=false, new_orders_enabled=true, matching_enabled=true
       WHERE singleton`,
      "repair after reconciliation race test"
    );
    await auditedControlUpdate(
      pool,
      `UPDATE market_order_books
       SET frozen=false, sensitive_reason=NULL
       WHERE book_id = ANY($1::uuid[])`,
      "unfreeze repaired reconciliation race book",
      [run.protection.frozenBookIds]
    );
    await expectReconciled(reconcile);
  }, 30_000);

  it("rejects malformed, oversized, nontradable, unauthorized, and conflicting economic intent", async () => {
    for (const quantity of ["0", "-1", "1.5", "100000000000000000000"]) {
      await expect(service.createOrder(seller, {
        requestId: `bad-quantity-${quantity.replaceAll(/[^0-9]/g, "x")}-001`,
        interface: "merchant", side: "sell", itemId: "stone", quantity, unitPrice: "8"
      })).rejects.toMatchObject({ code: "MARKET_INVALID_QUANTITY" });
    }
    for (const unitPrice of ["0", "-2", "1e3", "100000000000000000000"]) {
      await expect(service.createOrder(seller, {
        requestId: `bad-price-${unitPrice.replaceAll(/[^0-9]/g, "x")}-001`,
        interface: "merchant", side: "sell", itemId: "stone", quantity: "1", unitPrice
      })).rejects.toMatchObject({ code: "MARKET_INVALID_PRICE" });
    }
    await expect(service.createOrder(seller, {
      requestId: "unknown-item-order-001", interface: "merchant", side: "sell",
      itemId: "forged_item", quantity: "1", unitPrice: "8"
    })).rejects.toMatchObject({ code: "MARKET_UNKNOWN_ITEM" });
    await expect(service.createOrder(seller, {
      requestId: "equipment-order-001", interface: "merchant", side: "sell",
      itemId: "starter_sword", quantity: "1", unitPrice: "8"
    })).rejects.toMatchObject({ code: "MARKET_ITEM_NOT_TRADABLE" });

    const owned = await service.createOrder(seller, {
      requestId: "owned-order-for-attack-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "8"
    });
    await expect(service.cancelOrder(buyer, "unauthorized-cancel-001", owned.order!.orderId))
      .rejects.toMatchObject({ code: "MARKET_ORDER_NOT_OWNED" });
    await service.createOrder(buyer, {
      requestId: "replay-conflict-order-001", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "7"
    });
    await expect(service.createOrder(buyer, {
      requestId: "replay-conflict-order-001", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "2", unitPrice: "7"
    })).rejects.toMatchObject({ code: "MARKET_REPLAY_CONFLICT" });
    await expectReconciled(reconcile);
  });

  it("rejects an unbalanced journal group at the database commit boundary", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO market_ledger_groups (
           ledger_group_id, group_type, request_id, rules_version
         ) VALUES ($1,'administrative','constraint-test',1)`,
        [crypto.randomUUID()]
      );
      await expect(client.query("COMMIT")).rejects.toThrow(/must contain entries/i);
      await client.query("ROLLBACK").catch(() => undefined);
    } finally {
      client.release();
    }
    await expectReconciled(reconcile);
  });

  it("rejects placeholder-only replay rows at the deferred commit boundary", async () => {
    await expectCommitRejected(
      pool,
      async (client) => {
        await client.query(
          `INSERT INTO market_requests (
             player_id, account_id, request_id, action, request_hash, result, venue_id
           ) VALUES ($1,$2,'placeholder-request-001','create_sell',$3,'{}'::jsonb,$4)`,
          [seller.playerId, seller.accountId, "0".repeat(64), LEGACY_TEST_VENUE_ID]
        );
      },
      /cannot commit without a nonempty result/i
    );
    expect(Number((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM market_requests WHERE request_id='placeholder-request-001'"
    )).rows[0]?.count)).toBe(0);
  });

  it("keeps closed orders, escrow, collections, and authoritative inventory history monotonic", async () => {
    const partialAsk = await service.createOrder(seller, {
      requestId: "guard-partial-ask-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "3", unitPrice: "9"
    });
    await service.createOrder(buyer, {
      requestId: "guard-partial-buy-001", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "9"
    });
    await expect(pool.query(
      "UPDATE market_order_escrows SET remaining_amount = remaining_amount + 1 WHERE order_id = $1",
      [partialAsk.order!.orderId]
    )).rejects.toThrow(/cannot increase/i);
    await expect(pool.query(
      "DELETE FROM market_order_escrows WHERE order_id = $1",
      [partialAsk.order!.orderId]
    )).rejects.toThrow(/immutable/i);

    const cancelledAsk = await service.createOrder(seller, {
      requestId: "guard-cancel-ask-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "99"
    });
    await service.cancelOrder(seller, "guard-cancel-request-001", cancelledAsk.order!.orderId);
    await expect(pool.query(
      `UPDATE market_orders
       SET filled_quantity = filled_quantity + 1, remaining_quantity = remaining_quantity - 1
       WHERE order_id = $1`,
      [cancelledAsk.order!.orderId]
    )).rejects.toThrow(/closed market order is immutable/i);
    await expect(pool.query(
      "DELETE FROM market_orders WHERE order_id = $1",
      [cancelledAsk.order!.orderId]
    )).rejects.toThrow(/immutable/i);

    const itemReturn = await expireTestOrder(pool, service, seller, "guard-collection-ask-001", "sell", "1", "99");
    const goldReturn = await expireTestOrder(pool, service, buyerTwo, "guard-collection-buy-001", "buy", "1", "1");
    const purchaseCollection = await pool.query<{ collection_id: string }>(
      "SELECT collection_id::text FROM market_collections WHERE source_order_id=$1 AND reason='sell_expired_return'",
      [itemReturn.order!.orderId]
    );
    const proceedsCollection = await pool.query<{ collection_id: string }>(
      "SELECT collection_id::text FROM market_collections WHERE source_order_id=$1 AND reason='buy_expired_refund'",
      [goldReturn.order!.orderId]
    );
    await service.claim(seller, "guard-collection-claim-001", "items");
    await expect(pool.query(
      `UPDATE market_collections
       SET remaining_amount = original_amount, claimed_at = NULL
       WHERE collection_id = $1`,
      [purchaseCollection.rows[0]!.collection_id]
    )).rejects.toThrow(/closed market collection is immutable/i);
    await expect(pool.query(
      "UPDATE market_collections SET source_order_id = $2 WHERE collection_id = $1",
      [proceedsCollection.rows[0]!.collection_id, itemReturn.order!.orderId]
    )).rejects.toThrow(/immutable market collection provenance/i);

    const inventoryEvent = await pool.query<{ id: string }>(
      "SELECT id::text FROM inventory_events WHERE player_id=$1 ORDER BY id LIMIT 1",
      [seller.playerId]
    );
    await expect(pool.query(
      "UPDATE inventory_events SET metadata = '{\"tampered\":true}'::jsonb WHERE id=$1",
      [inventoryEvent.rows[0]!.id]
    )).rejects.toThrow(/financial history is immutable/i);
    await expect(pool.query(
      "DELETE FROM inventory_events WHERE id=$1",
      [inventoryEvent.rows[0]!.id]
    )).rejects.toThrow(/financial history is immutable/i);
    await expectReconciled(reconcile);
  });

  it("rejects malformed collection provenance and trade party relationships at commit", async () => {
    const ask = await service.createOrder(seller, {
      requestId: "guard-malformed-ask-001", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "30"
    });
    const bid = await service.createOrder(buyer, {
      requestId: "guard-malformed-bid-001", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "2", unitPrice: "3"
    });
    const askRow = (await pool.query<{
      venue_id: string; book_id: string; item_identity: string; item_id: string;
      variant: string; fee_policy_id: number; fee_policy_version: number;
    }>(
      `SELECT venue_id, book_id, item_identity, item_id, variant,
              fee_policy_id, fee_policy_version
       FROM market_orders WHERE order_id=$1`,
      [ask.order!.orderId]
    )).rows[0]!;

    await expectCommitRejected(
      pool,
      async (client) => {
        const invalidTradeId = crypto.randomUUID();
        await client.query(
          `INSERT INTO market_trades (
             trade_id, venue_id, book_id, item_identity, item_id, variant,
             buy_order_id, sell_order_id, buyer_player_id, seller_player_id,
             maker_order_id, quantity, unit_price, gross_value, buyer_fee, seller_fee,
             book_version, buyer_fee_policy_id, buyer_fee_policy_version,
             seller_fee_policy_id, seller_fee_policy_version, rules_version
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$7,1,30,30,0,0,900001,$11,$12,$11,$12,1)`,
          [
            invalidTradeId, askRow.venue_id, askRow.book_id, askRow.item_identity,
            askRow.item_id, askRow.variant, ask.order!.orderId, bid.order!.orderId,
            seller.playerId, buyer.playerId, askRow.fee_policy_id, askRow.fee_policy_version
          ]
        );
        // The earlier deferred refund guard also rejects this row. Exercise the
        // relationship validator directly, then retain the independent COMMIT rejection.
        await client.query("SAVEPOINT check_trade_relationship");
        await expect(client.query("SELECT validate_market_trade_commit($1)", [invalidTradeId]))
          .rejects.toThrow(/trade buy\/sell relationships are inconsistent/i);
        await client.query("ROLLBACK TO SAVEPOINT check_trade_relationship");
      },
      /market price-improvement wallet transition is not independently correct/i
    );

    const settled = await service.createOrder(buyerTwo, {
      requestId: "guard-provenance-buy-001", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "30"
    });
    await expectCommitRejected(
      pool,
      async (client) => {
        await client.query(
          `INSERT INTO market_collections (
             player_id, asset_kind, item_identity, item_id, variant,
             original_amount, remaining_amount, reason, source_order_id, source_trade_id, venue_id
           ) VALUES ($1,'item','stone','stone','default',1,1,'purchase',$2,$3,$4)`,
          [seller.playerId, ask.order!.orderId, settled.trades[0]!.tradeId, LEGACY_TEST_VENUE_ID]
        );
      },
      /purchase collection provenance is inconsistent/i
    );
    await expectReconciled(reconcile);
  });

  it("links positive claims to one exact ledger group and rejects orphan or mismatched claim journals", async () => {
    const zeroClaim = await service.claim(buyer, "claim-link-zero-001", "all");
    expect(zeroClaim).toMatchObject({ claimedItems: "0", claimedGold: "0" });
    expect(Number((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM market_ledger_groups group_row
       JOIN market_claims claim ON claim.claim_id = group_row.claim_id
       WHERE claim.account_id=$1 AND claim.client_request_id='claim-link-zero-001'`,
      [buyer.accountId]
    )).rows[0]?.count)).toBe(0);

    await expectCommitRejected(
      pool,
      async (client) => {
        const claimId = crypto.randomUUID();
        const groupId = crypto.randomUUID();
        await client.query(
          `INSERT INTO market_ledger_groups (
             ledger_group_id, group_type, request_id, claim_id,
             order_id, trade_id, rules_version
           ) VALUES ($1,'claim','claim-link-orphan-001',$2,NULL,NULL,1)`,
          [groupId, claimId]
        );
        await client.query(
          `INSERT INTO market_ledger_entries (
             ledger_group_id, asset_kind, item_identity, amount, account_location,
             player_id, order_id, trade_id, collection_id, reason
           ) VALUES
             ($1,'gold',NULL,-1,'refund_balance',$2,NULL,NULL,NULL,'orphan_claim_debit'),
             ($1,'gold',NULL, 1,'player_wallet',$2,NULL,NULL,NULL,'orphan_claim_credit')`,
          [groupId, seller.playerId]
        );
      },
      /missing claim|claim_id_fkey|foreign key/i
    );

    await expectCommitRejected(
      pool,
      async (client) => {
        await client.query(
          `INSERT INTO market_claims (
             claim_id, player_id, account_id, client_request_id, asset_scope,
             item_units_claimed, gold_claimed, result, venue_id
           ) VALUES ($1,$2,$3,'claim-link-positive-no-group-001','items',1,0,$4::jsonb,$5)`,
          [
            crypto.randomUUID(), buyer.playerId, buyer.accountId,
            JSON.stringify({ itemUnitsClaimed: "1", goldClaimed: "0" }), LEGACY_TEST_VENUE_ID
          ]
        );
      },
      /positive market claim must have exactly one settlement ledger group/i
    );

    await expectCommitRejected(
      pool,
      async (client) => {
        const claimId = crypto.randomUUID();
        const groupId = crypto.randomUUID();
        await client.query(
          `INSERT INTO market_ledger_groups (
             ledger_group_id, group_type, request_id, claim_id,
             order_id, trade_id, rules_version
           ) VALUES ($1,'claim','claim-link-mismatch-001',$2,NULL,NULL,1)`,
          [groupId, claimId]
        );
        await client.query(
          `INSERT INTO market_ledger_entries (
             ledger_group_id, asset_kind, item_identity, amount, account_location,
             player_id, order_id, trade_id, collection_id, reason
           ) VALUES
             ($1,'item','stone',-1,'buyer_collection',$2,NULL,NULL,NULL,'mismatch_claim_debit'),
             ($1,'item','stone', 1,'player_inventory',$2,NULL,NULL,NULL,'mismatch_claim_credit')`,
          [groupId, buyer.playerId]
        );
        await client.query(
          `INSERT INTO market_claims (
             claim_id, player_id, account_id, client_request_id, asset_scope,
             item_units_claimed, gold_claimed, result, venue_id
           ) VALUES ($1,$2,$3,'claim-link-mismatch-001','items',2,0,$4::jsonb,$5)`,
          [
            claimId, buyer.playerId, buyer.accountId,
            JSON.stringify({ itemUnitsClaimed: "2", goldClaimed: "0" }), LEGACY_TEST_VENUE_ID
          ]
        );
      },
      /destination totals do not match/i
    );

    const sourceOrder = await expireTestOrder(pool, service, seller, "claim-link-source-sell-001", "sell", "1", "17");
    await service.claim(seller, "claim-link-source-claim-001", "items");
    const exhaustedCollection = (await pool.query<{
      collection_id: string;
      original_amount: string;
      item_identity: string;
    }>(
      `SELECT collection_id::text, original_amount::text, item_identity
       FROM market_collections
       WHERE source_order_id = $1 AND reason = 'sell_expired_return' AND remaining_amount = 0`,
      [sourceOrder.order!.orderId]
    )).rows[0]!;

    await expectCommitRejected(
      pool,
      async (client) => {
        const claimId = crypto.randomUUID();
        const groupId = crypto.randomUUID();
        await client.query(
          `INSERT INTO market_ledger_groups (
             ledger_group_id, group_type, request_id, claim_id,
             order_id, trade_id, rules_version
           ) VALUES ($1,'claim','claim-link-duplicate-001',$2,NULL,NULL,1)`,
          [groupId, claimId]
        );
        await client.query(
          `INSERT INTO market_ledger_entries (
             ledger_group_id, asset_kind, item_identity, amount, account_location,
             player_id, order_id, trade_id, collection_id, reason
           ) VALUES
             ($1,'item',$2,-$3::bigint,'return_collection',$4,NULL,NULL,$5,'duplicate_claim_debit'),
             ($1,'item',$2, $3::bigint,'player_inventory',$4,NULL,NULL,NULL,'duplicate_claim_credit')`,
          [
            groupId,
            exhaustedCollection.item_identity,
            exhaustedCollection.original_amount,
            seller.playerId,
            exhaustedCollection.collection_id
          ]
        );
        await client.query(
          `INSERT INTO market_claims (
             claim_id, player_id, account_id, client_request_id, asset_scope,
             item_units_claimed, gold_claimed, result, venue_id
           ) VALUES ($1,$2,$3,'claim-link-duplicate-001','items',$4,0,$5::jsonb,$6)`,
          [
            claimId,
            seller.playerId,
            seller.accountId,
            exhaustedCollection.original_amount,
            JSON.stringify({
              itemUnitsClaimed: exhaustedCollection.original_amount,
              goldClaimed: "0"
            }), LEGACY_TEST_VENUE_ID
          ]
        );
      },
      /collection claim state does not match|unexpected ledger reference/i
    );
    await expectReconciled(reconcile);
  });

  it("reconciles authoritative inventory and wallet boundaries and auto-protects corruption", async () => {
    await expireTestOrder(pool, service, seller, "boundary-ask-001", "sell", "1", "12");
    await expireTestOrder(pool, service, buyer, "boundary-buy-001", "buy", "1", "12");
    await service.claim(seller, "boundary-item-claim-001", "items");
    await service.claim(buyer, "boundary-gold-claim-001", "gold");
    await expectReconciled(reconcile);

    const inventoryEventId = (await pool.query<{ id: string }>(
      `SELECT id::text FROM inventory_events
       WHERE operation_key = $1`,
      [`market-claim-items:${seller.accountId}:boundary-item-claim-001`]
    )).rows[0]!.id;
    const walletEventId = (await pool.query<{ event_id: string }>(
      `SELECT event_id::text FROM wallet_events
       WHERE operation_key = $1 AND player_id = $2`,
      [`market-claim-gold:${buyer.accountId}:boundary-gold-claim-001`, buyer.playerId]
    )).rows[0]!.event_id;

    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("ALTER TABLE inventory_events DISABLE TRIGGER inventory_events_immutable");
      await client.query("ALTER TABLE wallet_events DISABLE TRIGGER wallet_events_immutable");
      await client.query("UPDATE inventory_events SET delta_quantity = delta_quantity + 1 WHERE id = $1", [inventoryEventId]);
      await client.query("UPDATE wallet_events SET delta_gold = delta_gold + 1 WHERE event_id = $1", [walletEventId]);
      const report = await reconcile.reconcileWithQueryable(client);
      expect(report.ok).toBe(false);
      expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
        "MARKET_CLAIM_DOMAIN_BOUNDARY_MISMATCH",
        "MARKET_CLAIM_ITEM_IDENTITY_MISMATCH",
        "WALLET_EVENT_CHAIN_MISMATCH"
      ]));
      await client.query("ROLLBACK");
      transactionOpen = false;
    } finally {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await expectReconciled(reconcile);

    await adjustImmutableWalletEventForTest(pool, walletEventId, 1);

    const protectedReport = await reconcile.reconcile();
    expect(protectedReport.ok).toBe(false);
    expect(protectedReport.issues.map((issue) => issue.code))
      .toContain("MARKET_CLAIM_DOMAIN_BOUNDARY_MISMATCH");
    const protectedControls = await pool.query<{
      read_only: boolean;
      new_orders_enabled: boolean;
      matching_enabled: boolean;
    }>(
      `SELECT read_only, new_orders_enabled, matching_enabled
       FROM market_global_controls WHERE singleton`
    );
    expect(protectedControls.rows[0]).toEqual({
      read_only: true,
      new_orders_enabled: false,
      matching_enabled: false
    });
    expect(Number((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM market_audit_events
       WHERE event_type = 'market_reconciliation_failed' AND severity = 'critical'`
    )).rows[0]?.count)).toBe(1);

    await adjustImmutableWalletEventForTest(pool, walletEventId, -1);
    await auditedGlobalControlUpdate(
      pool,
      `UPDATE market_global_controls
       SET read_only=false, new_orders_enabled=true, matching_enabled=true`,
      "repair controls after intentional reconciliation corruption"
    );
    const repaired = await reconcile.reconcile({ honorAutomaticProtection: false });
    expect(repaired.issues, JSON.stringify(repaired.issues, null, 2)).toEqual([]);
    expect(repaired.ok).toBe(true);
  });
});

async function expireTestOrder(
  pool: pg.Pool,
  service: LegacyMarketTestService,
  actor: MarketActor,
  requestId: string,
  side: "buy" | "sell",
  quantity: string,
  unitPrice: string
): Promise<MarketMutationResult> {
  // Give newly inserted orders a due expiry without mutating immutable order history.
  await pool.query("ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() - interval '1 second')");
  let result: MarketMutationResult;
  try {
    result = await service.createOrder(actor, {
      requestId, interface: "merchant", side, itemId: "stone", quantity, unitPrice
    });
  } finally {
    await pool.query("ALTER TABLE market_orders ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '7 days')");
  }
  expect(result.order?.status).toBe("open");
  await expect(service.expireDueOrders()).resolves.toEqual({ materialOrders: 1, equipmentListings: 0 });
  return result;
}

function failOnceAt(target: MarketFaultPoint): (point: MarketFaultPoint) => void {
  let failed = false;
  return (point) => {
    if (!failed && point === target) {
      failed = true;
      throw new Error(`injected:${point}`);
    }
  };
}

function failOccurrenceAt(
  target: MarketFaultPoint,
  targetOccurrence: number
): (point: MarketFaultPoint) => void {
  let occurrence = 0;
  return (point) => {
    if (point === target) {
      occurrence += 1;
      if (occurrence === targetOccurrence) throw new Error(`injected:${point}`);
    }
  };
}

async function expectCommitRejected(
  pool: pg.Pool,
  body: (client: pg.PoolClient) => Promise<void>,
  message: RegExp
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await body(client);
    await expect(client.query("COMMIT")).rejects.toThrow(message);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function adjustImmutableWalletEventForTest(
  pool: pg.Pool,
  eventId: string,
  delta: 1 | -1
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE wallet_events DISABLE TRIGGER wallet_events_immutable");
    await client.query(
      "UPDATE wallet_events SET delta_gold = delta_gold + $2 WHERE event_id = $1",
      [eventId, delta]
    );
    await client.query("ALTER TABLE wallet_events ENABLE TRIGGER wallet_events_immutable");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function mutateImmutableLedgerEntryForTest(
  pool: pg.Pool,
  ledgerEntryId: string,
  amount: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE market_ledger_entries DISABLE TRIGGER market_ledger_entries_immutable"
    );
    await client.query(
      "UPDATE market_ledger_entries SET amount=$2 WHERE ledger_entry_id=$1",
      [ledgerEntryId, amount]
    );
    await client.query(
      "ALTER TABLE market_ledger_entries ENABLE TRIGGER market_ledger_entries_immutable"
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedActor(
  pool: pg.Pool,
  actor: MarketActor,
  assets: { gold: bigint; stone: number }
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
    `INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')`,
    [actor.accountId]
    );
    await client.query(
    `INSERT INTO players (
       id, account_id, username, username_normalized, display_color, region_code,
       lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
     ) VALUES ($1,$2,$3,$4,NULL,'NM',35,-106,35,-106,900,false,
               ST_SetSRID(ST_MakePoint(-106,35),4326))`,
    [actor.playerId, actor.accountId, actor.playerId, actor.playerId]
    );
    if (assets.stone > 0) {
      const operationKey = `test-seed-inventory:${actor.playerId}`;
      await client.query(
      `INSERT INTO inventory_operations (operation_key, player_id, source, metadata)
       VALUES ($1,$2,'market_test_seed','{}'::jsonb)`,
      [operationKey, actor.playerId]
      );
      await client.query(
      `INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
       VALUES ($1,'stone','default',$2,1)`,
      [actor.playerId, assets.stone]
      );
      await client.query(
      `INSERT INTO inventory_events (
         operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
         version_after, source, metadata
       ) VALUES ($1,$2,'stone','default',$3,$3,1,'market_test_seed','{}'::jsonb)`,
      [operationKey, actor.playerId, assets.stone]
      );
    }
    await client.query(
    `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
     VALUES ($1,$2,$3,$4)`,
    [actor.playerId, actor.accountId, assets.gold.toString(), assets.gold > 0n ? "1" : "0"]
    );
    if (assets.gold > 0n) {
      await client.query(
      `INSERT INTO wallet_events (
         operation_key, player_id, account_id, delta_gold, balance_after,
         version_after, reason
       ) VALUES ($1,$2,$3,$4,$4,1,'market_test_seed')`,
      [`test-seed-wallet:${actor.playerId}`, actor.playerId, actor.accountId, assets.gold.toString()]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedInventoryItem(
  pool: pg.Pool,
  actor: MarketActor,
  itemId: "balsam_resin" | "atlas_shrine_shard" | "venomsteel_core" | "simple_food",
  quantity: number
): Promise<void> {
  const operationKey = `test-seed-inventory:${actor.playerId}:${itemId}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO inventory_operations (operation_key, player_id, source, metadata)
       VALUES ($1,$2,'market_test_seed','{}'::jsonb)`,
      [operationKey, actor.playerId]
    );
    await client.query(
      `INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
       VALUES ($1,$2,'default',$3,1)`,
      [actor.playerId, itemId, quantity]
    );
    await client.query(
      `INSERT INTO inventory_events (
         operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
         version_after, source, metadata
       ) VALUES ($1,$2,$3,'default',$4,$4,1,'market_test_seed','{}'::jsonb)`,
      [operationKey, actor.playerId, itemId, quantity]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedInventoryVariant(
  pool: pg.Pool,
  actor: MarketActor,
  itemId: "enchantment_stone" | "fishing_rod" | "face_mask",
  variant: string,
  quantity: number
): Promise<void> {
  const operationKey = `test-seed-inventory:${actor.playerId}:${itemId}:${variant}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO inventory_operations (operation_key, player_id, source, metadata)
       VALUES ($1,$2,'market_test_seed','{}'::jsonb)`,
      [operationKey, actor.playerId]
    );
    await client.query(
      `INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version)
       VALUES ($1,$2,$3,$4,1)`,
      [actor.playerId, itemId, variant, quantity]
    );
    await client.query(
      `INSERT INTO inventory_events (
         operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
         version_after, source, metadata
       ) VALUES ($1,$2,$3,$4,$5,$5,1,'market_test_seed','{}'::jsonb)`,
      [operationKey, actor.playerId, itemId, variant, quantity]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedActorsBulk(
  pool: pg.Pool,
  actors: MarketActor[],
  assets: { gold: bigint; stone: number }
): Promise<void> {
  if (actors.length === 0) return;
  const accountIds = actors.map((actor) => actor.accountId);
  const playerIds = actors.map((actor) => actor.playerId);
  const gold = actors.map(() => assets.gold.toString());
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO accounts (id, status, trust_tier)
       SELECT account_id, 'active', 'standard'
       FROM unnest($1::uuid[]) AS seeded(account_id)`,
      [accountIds]
    );
    await client.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       )
       SELECT player_id, account_id, player_id, lower(player_id), NULL, 'NM',
              35, -106, 35, -106, 900, false,
              ST_SetSRID(ST_MakePoint(-106,35),4326)
       FROM unnest($1::text[], $2::uuid[]) AS seeded(player_id, account_id)`,
      [playerIds, accountIds]
    );
    await client.query(
      `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
       SELECT player_id, account_id, gold_balance,
              CASE WHEN gold_balance > 0 THEN 1 ELSE 0 END
       FROM unnest($1::text[], $2::uuid[], $3::bigint[])
         AS seeded(player_id, account_id, gold_balance)`,
      [playerIds, accountIds, gold]
    );
    if (assets.gold > 0n) {
      await client.query(
        `INSERT INTO wallet_events (
           operation_key, player_id, account_id, delta_gold, balance_after,
           version_after, reason
         )
         SELECT 'test-seed-wallet:' || player_id, player_id, account_id,
                gold_balance, gold_balance, 1, 'market_test_seed'
         FROM unnest($1::text[], $2::uuid[], $3::bigint[])
           AS seeded(player_id, account_id, gold_balance)`,
        [playerIds, accountIds, gold]
      );
    }
    if (assets.stone > 0) {
      await client.query(
        `INSERT INTO inventory_operations (operation_key, player_id, source, metadata)
         SELECT 'test-seed-inventory:' || player_id, player_id,
                'market_test_seed', '{}'::jsonb
         FROM unnest($1::text[]) AS seeded(player_id)`,
        [playerIds]
      );
      await client.query(
        `INSERT INTO player_inventory (
           player_id, resource_type, variant, quantity, version
         )
         SELECT player_id, 'stone', 'default', $2, 1
         FROM unnest($1::text[]) AS seeded(player_id)`,
        [playerIds, assets.stone]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key, player_id, item_id, variant, delta_quantity,
           quantity_after, version_after, source, metadata
         )
         SELECT 'test-seed-inventory:' || player_id, player_id, 'stone', 'default',
                $2, $2, 1, 'market_test_seed', '{}'::jsonb
         FROM unnest($1::text[]) AS seeded(player_id)`,
        [playerIds, assets.stone]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function expectReconciled(service: MarketReconciliationService): Promise<void> {
  const report = await service.reconcile();
  expect(report.issues, JSON.stringify(report.issues, null, 2)).toEqual([]);
  expect(report.ok).toBe(true);
}

async function auditedGlobalControlUpdate(
  pool: pg.Pool,
  sql: string,
  reason: string
): Promise<void> {
  await auditedControlUpdate(pool, sql, reason);
}

async function auditedControlUpdate(
  pool: pg.Pool,
  sql: string,
  reason: string,
  values: unknown[] = []
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMarketControlAuditContext(client, {
      operatorIdentity: "test:market-integration",
      reason
    });
    await client.query(sql, values);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function resetMarketControlsForTest(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMarketControlAuditContext(client, {
      operatorIdentity: "test:market-integration",
      reason: "reset isolated integration-test controls"
    });
    await client.query(
      `UPDATE market_global_controls
       SET read_only = false, new_orders_enabled = true, matching_enabled = true,
           cancellations_enabled = true, claims_enabled = true, rules_version = 1`
    );
    await client.query(
      "UPDATE market_venue_controls SET frozen = false, sensitive_reason = NULL"
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function marketRollbackState(
  pool: pg.Pool,
  actor: MarketActor,
  makerOrderId: string,
  incomingRequestId: string
): Promise<Record<string, unknown>> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT
       (SELECT gold_balance::text FROM player_wallets WHERE player_id=$1) AS wallet_balance,
       (SELECT version::text FROM player_wallets WHERE player_id=$1) AS wallet_version,
       (SELECT count(*)::text FROM wallet_events WHERE player_id=$1) AS wallet_event_count,
       (SELECT count(*)::text FROM market_requests) AS request_count,
       (SELECT count(*)::text FROM market_orders) AS order_count,
       (SELECT count(*)::text FROM market_order_escrows) AS escrow_count,
       (SELECT count(*)::text FROM market_trades) AS trade_count,
       (SELECT count(*)::text FROM market_collections) AS collection_count,
       (SELECT count(*)::text FROM market_ledger_groups) AS ledger_group_count,
       (SELECT count(*)::text FROM market_ledger_entries) AS ledger_entry_count,
       (SELECT count(*)::text FROM market_orders
        WHERE account_id=$2 AND client_request_id=$4) AS incoming_order_count,
       (SELECT count(*)::text FROM market_requests
        WHERE account_id=$2 AND request_id=$4) AS incoming_request_count,
       (SELECT remaining_quantity::text FROM market_orders WHERE order_id=$3) AS maker_remaining,
       (SELECT status FROM market_orders WHERE order_id=$3) AS maker_status,
       (SELECT remaining_amount::text FROM market_order_escrows WHERE order_id=$3) AS maker_escrow
    `,
    [actor.playerId, actor.accountId, makerOrderId, incomingRequestId]
  );
  return result.rows[0] ?? {};
}
