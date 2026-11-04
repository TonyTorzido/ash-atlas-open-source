import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import {
  createSystemGroundDropsInTransaction,
  DroppedItemService,
  DROPPED_ITEM_TTL_MS
} from "./droppedItems.js";
import { reconcileDroppedItemCustody } from "./droppedItemReconciliation.js";
import { InventoryService } from "./inventory.js";
import { DEFAULT_PLAYER_BASE_INVENTORY_SLOTS } from "@ash-atlas/shared";
import { setMarketControlAuditContext } from "./marketControlAudit.js";
import { MarketReconciliationService } from "./marketReconciliation.js";
import type { MarketActor } from "./marketRules.js";
import {
  activateLegacyGlobalMarketForTest,
  LEGACY_TEST_VENUE_ID,
  createLegacyMarketTestService,
  type LegacyMarketTestService
} from "./legacyMarketTestAdapter.js";
import type { PlayerRecord } from "./state.js";
import { WalletService } from "./wallet.js";

const { Pool } = pg;
const databaseUrl = process.env.MARKET_TEST_DATABASE_URL;
const describeLive = databaseUrl ? describe : describe.skip;

const seller = actor("hardening-seller", "92000000-0000-4000-8000-000000000001");
const buyer = actor("hardening-buyer", "92000000-0000-4000-8000-000000000002");
const third = actor("hardening-third", "92000000-0000-4000-8000-000000000003");
const dropper = actor("hardening-dropper", "92000000-0000-4000-8000-000000000004");
const picker = actor("hardening-picker", "92000000-0000-4000-8000-000000000005");

describeLive("economy commit-boundary hardening", () => {
  let pool: pg.Pool;
  let market: LegacyMarketTestService;

  beforeAll(async () => {
    assertDedicatedDatabase(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 20 });
  }, 120_000);

  beforeEach(async () => {
    await resetEconomy(pool);
    for (const current of [seller, buyer, third, dropper, picker]) {
      await seedPlayer(pool, current);
    }
    const inventory = new InventoryService(pool);
    await inventory.grantItemsForOperation({
      operationKey: "hardening-seed-seller-stone",
      playerId: seller.playerId,
      source: "hardening_test_seed",
      grants: [{ itemId: "stone", variant: null, quantity: 50 }]
    });
    await inventory.grantItemsForOperation({
      operationKey: "hardening-seed-dropper-food",
      playerId: dropper.playerId,
      source: "hardening_test_seed",
      grants: [{ itemId: "food", variant: null, quantity: 30 }]
    });
    await inventory.grantItemsForOperation({
      operationKey: "hardening-seed-dropper-wood",
      playerId: dropper.playerId,
      source: "hardening_test_seed",
      grants: [{ itemId: "wood", variant: null, quantity: 2 }]
    });
    await creditWallet(pool, buyer, 10_000n, "buyer");
    await creditWallet(pool, third, 10_000n, "third");
    await activateLegacyGlobalMarketForTest(pool);
    market = createLegacyMarketTestService(pool, marketConfig(), createLogger("test"));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("migrates retained 0600 opening assets through 0601 without loss and reconciles clean", async () => {
    const report = await verifyRetainedMigration(databaseUrl!);
    expect(report).toEqual({
      walletBalance: "990",
      walletVersion: "2",
      walletEvents: "2",
      walletGenesis: "1",
      inventoryQuantity: "8",
      inventoryVersion: "2",
      inventoryEvents: "2",
      inventoryGenesis: "1",
      retainedDropRemaining: "2",
      retainedDropRequests: "1",
      retainedDropCreations: "1",
      retainedPartialOriginal: "10",
      retainedPartialRemaining: "3",
      retainedPartialPickups: "2",
      reconciliationIssues: "0"
    });
  }, 120_000);

  it("allows valid service-created escrow, fill, cancellation, and claim histories", async () => {
    const ask = await market.createOrder(seller, {
      requestId: "hardening-valid-ask", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "5", unitPrice: "10"
    });
    const fill = await market.createOrder(buyer, {
      requestId: "hardening-valid-bid", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "3", unitPrice: "12"
    });
    expect(fill.trades).toHaveLength(1);
    await market.cancelOrder(seller, "hardening-valid-cancel", ask.order!.orderId);
    await market.claim(seller, "hardening-valid-claim-seller", "all");
    await market.claim(buyer, "hardening-valid-claim-buyer", "all");
    expect((await new MarketReconciliationService(pool).reconcile({
      honorAutomaticProtection: false
    })).issues).toEqual([]);
  });

  it("rejects a direct wallet balance mutation at COMMIT", async () => {
    await expectCommitRejected(pool, async (client) => {
      await client.query(
        "UPDATE player_wallets SET gold_balance=gold_balance+1 WHERE player_id=$1",
        [buyer.playerId]
      );
    }, /wallet.*event|event chain|version/i);
  });

  it("rejects a direct inventory quantity mutation at COMMIT", async () => {
    await expectCommitRejected(pool, async (client) => {
      await client.query(
        `UPDATE player_inventory SET quantity=quantity+1
         WHERE player_id=$1 AND resource_type='stone' AND variant='default'`,
        [seller.playerId]
      );
    }, /inventory.*event|event chain|version/i);
  });

  it("rejects incorrect wallet balance-after and version-after transitions at COMMIT", async () => {
    await expectCommitRejected(pool, async (client) => {
      const wallet = await client.query<{ gold_balance: string; version: string }>(
        `UPDATE player_wallets
         SET gold_balance=gold_balance+5, version=version+1
         WHERE player_id=$1
         RETURNING gold_balance::text,version::text`,
        [buyer.playerId]
      );
      await client.query(
        `INSERT INTO wallet_events (
           operation_key,player_id,account_id,delta_gold,balance_after,
           version_after,reason
         ) VALUES ('hardening-wrong-balance',$1,$2,5,$3::bigint+1,$4,'hardening_test')`,
        [buyer.playerId, buyer.accountId,
          wallet.rows[0]!.gold_balance, wallet.rows[0]!.version]
      );
    }, /wallet balance|invalid transition/i);

    await expectCommitRejected(pool, async (client) => {
      const wallet = await client.query<{ gold_balance: string; version: string }>(
        `UPDATE player_wallets
         SET gold_balance=gold_balance+1, version=version+2
         WHERE player_id=$1
         RETURNING gold_balance::text,version::text`,
        [buyer.playerId]
      );
      await client.query(
        `INSERT INTO wallet_events (
           operation_key,player_id,account_id,delta_gold,balance_after,
           version_after,reason
         ) VALUES ('hardening-version-gap',$1,$2,1,$3,$4,'hardening_test')`,
        [buyer.playerId, buyer.accountId,
          wallet.rows[0]!.gold_balance, wallet.rows[0]!.version]
      );
    }, /version|exactly one event/i);
  });

  it("rejects incorrect inventory quantity-after and duplicate version transitions", async () => {
    await expectCommitRejected(pool, async (client) => {
      await client.query(
        `INSERT INTO inventory_operations (operation_key,player_id,source)
         VALUES ('hardening-wrong-quantity',$1,'hardening_test')`,
        [seller.playerId]
      );
      const stack = await client.query<{ quantity: string; version: string }>(
        `UPDATE player_inventory
         SET quantity=quantity+1, version=version+1
         WHERE player_id=$1 AND resource_type='stone' AND variant='default'
         RETURNING quantity::text,version::text`,
        [seller.playerId]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source
         ) VALUES ('hardening-wrong-quantity',$1,'stone','default',1,$2::bigint+1,$3,
                   'hardening_test')`,
        [seller.playerId, stack.rows[0]!.quantity, stack.rows[0]!.version]
      );
    }, /inventory quantity|invalid transition/i);

    await expectStatementAndCommitRejected(pool, async (client) => {
      await client.query(
        `INSERT INTO inventory_operations (operation_key,player_id,source)
         VALUES ('hardening-duplicate-version',$1,'hardening_test')`,
        [seller.playerId]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source
         ) SELECT 'hardening-duplicate-version',$1,'stone','default',1,quantity+1,version,
                  'hardening_test'
           FROM player_inventory
          WHERE player_id=$1 AND resource_type='stone' AND variant='default'`,
        [seller.playerId]
      );
    }, /version_unique|duplicate key/i);
  });

  it("atomically rejects a grant beyond finite physical inventory capacity", async () => {
    const inventory = new InventoryService(pool);
    const snapshot = async () => Promise.all([
      inventory.getInventorySnapshot(picker.playerId),
      pool.query("SELECT * FROM inventory_events WHERE player_id=$1 ORDER BY operation_key", [picker.playerId]),
      pool.query("SELECT * FROM player_wallets WHERE player_id=$1", [picker.playerId])
    ]);
    const before = await snapshot();
    await expect(inventory.grantItemsForOperation({
      operationKey: "hardening-water-capacity-overflow",
      playerId: picker.playerId,
      source: "hardening_boundary_test",
      grants: [{ itemId: "water", variant: "fresh", quantity: 9_007_199_254_740_991n }]
    })).rejects.toThrow(/Inventory does not have enough free slots/i);
    expect(await snapshot()).toEqual(before);
    expect((await pool.query(
      "SELECT * FROM inventory_operations WHERE operation_key='hardening-water-capacity-overflow'"
    )).rows).toEqual([]);
  });
  it("rejects authoritative wallet and inventory deletion", async () => {
    await expect(pool.query("DELETE FROM player_wallets WHERE player_id=$1", [buyer.playerId]))
      .rejects.toThrow(/cannot be deleted|authoritative asset/i);
    await expect(pool.query(
      `DELETE FROM player_inventory
       WHERE player_id=$1 AND resource_type='stone' AND variant='default'`,
      [seller.playerId]
    )).rejects.toThrow(/cannot be deleted|authoritative asset/i);
  });

  it("rejects buy escrow rows inconsistent with their cumulative journal net at COMMIT", async () => {
    const order = await createRestingBuy(market, "raw-buy-row", 5, 8);
    await expectCommitRejected(pool, async (client) => {
      await client.query(
        "UPDATE market_order_escrows SET remaining_amount=remaining_amount-1 WHERE order_id=$1",
        [order]
      );
    }, /escrow|journal|open quantity/i);
  });

  it("rejects sell escrow rows inconsistent with their cumulative journal net at COMMIT", async () => {
    const order = await createRestingSell(market, "raw-sell-row", 5, 20);
    await expectCommitRejected(pool, async (client) => {
      await client.query(
        "UPDATE market_order_escrows SET remaining_amount=remaining_amount-1 WHERE order_id=$1",
        [order]
      );
    }, /escrow|journal|open quantity/i);
  });

  it("rejects a raw trade above the buyer limit at COMMIT", async () => {
    const pair = await createNoncrossingPair(market, "above-limit");
    await expectCommitRejected(pool, (client) =>
      insertRawTrade(client, pair.buyOrderId, pair.sellOrderId, 10),
    /market trade price or priority is inconsistent/i);
  });

  it("rejects a raw trade below the seller limit at COMMIT", async () => {
    const pair = await createNoncrossingPair(market, "below-limit");
    await expectCommitRejected(pool, (client) =>
      insertRawTrade(client, pair.buyOrderId, pair.sellOrderId, 8),
    /market trade price or priority is inconsistent/i);
  });

  it("rejects an incorrect price-improvement refund at COMMIT", async () => {
    await market.createOrder(seller, {
      requestId: "refund-ask", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "1", unitPrice: "10"
    });
    const fill = await market.createOrder(buyer, {
      requestId: "refund-bid", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "1", unitPrice: "20"
    });
    const tradeId = fill.trades[0]!.tradeId;
    const buyOrderId = fill.order!.orderId;
    await expectCommitRejected(pool, async (client) => {
      await client.query(
        `INSERT INTO market_collections (
           player_id, asset_kind, original_amount, remaining_amount, reason,
           source_order_id, source_trade_id, venue_id
         ) VALUES ($1,'gold',1,1,'price_improvement_refund',$2,$3,$4)`,
        [third.playerId, buyOrderId, tradeId, LEGACY_TEST_VENUE_ID]
      );
    }, /price-improvement collection provenance is inconsistent/i);
  });

  it("rejects an extra escrow credit at COMMIT", async () => {
    const orderId = await createRestingSell(market, "extra-credit", 5, 20);
    await expectStatementAndCommitRejected(pool, (client) =>
      insertBalancedEscrowDistortion(client, orderId, 1), /committed.*cannot accept/i);
  });

  it("rejects a composition with a missing effective escrow debit at COMMIT", async () => {
    await market.createOrder(seller, {
      requestId: "missing-debit-ask", interface: "merchant", side: "sell",
      itemId: "stone", quantity: "2", unitPrice: "10"
    });
    const fill = await market.createOrder(buyer, {
      requestId: "missing-debit-bid", interface: "merchant", side: "buy",
      itemId: "stone", quantity: "2", unitPrice: "10"
    });
    const sellOrderId = (await pool.query<{ sell_order_id: string }>(
      "SELECT sell_order_id FROM market_trades WHERE trade_id=$1",
      [fill.trades[0]!.tradeId]
    )).rows[0]!.sell_order_id;
    await expectStatementAndCommitRejected(pool, (client) =>
      insertBalancedEscrowDistortion(client, sellOrderId, 1), /committed.*cannot accept/i);
  });

  it("rejects an incorrect cancellation movement amount at COMMIT", async () => {
    const orderId = await createRestingSell(market, "bad-cancel", 5, 20);
    await market.cancelOrder(seller, "bad-cancel-request", orderId);
    await expectStatementAndCommitRejected(pool, (client) =>
      insertBalancedEscrowDistortion(client, orderId, -1), /committed.*cannot accept/i);
  });

  it("rejects an unexpected settlement collection at COMMIT", async () => {
    const orderId = await createRestingSell(market, "unexpected-collection", 5, 20);
    await expectCommitRejected(pool, async (client) => {
      await client.query(
        `INSERT INTO market_collections (
           player_id, asset_kind, item_identity, item_id, variant,
           original_amount, remaining_amount, reason, source_order_id, venue_id
         ) VALUES ($1,'item','stone','stone','default',1,1,'sell_cancel_return',$2,$3)`,
        [seller.playerId, orderId, LEGACY_TEST_VENUE_ID]
      );
    }, /non-cancelled|collection|settlement/i);
  });

  it("rejects a closed order retaining journal escrow at COMMIT", async () => {
    const orderId = await createRestingSell(market, "closed-escrow", 5, 20);
    await market.cancelOrder(seller, "closed-escrow-cancel", orderId);
    await expectStatementAndCommitRejected(pool, (client) =>
      insertBalancedEscrowDistortion(client, orderId, 1), /committed.*cannot accept/i);
  });

  it("preserves original drop replay across partial/full pickup, restart, and expiry", async () => {
    let nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    const now = (): Date => new Date(nowMs);
    const dropped = new DroppedItemService(pool, undefined, now);
    const original = await dropped.dropItem(playerRecord(dropper), {
      requestId: "hardening-drop-original", itemId: "food", variant: null, quantity: 10
    });
    await dropped.pickupDroppedItem(
      playerRecord(picker), "hardening-pick-partial", original.drop.dropId,
      { mode: "quantity", quantity: 3 }
    );
    const partialReplay = await new DroppedItemService(pool, undefined, now).dropItem(
      playerRecord(dropper),
      { requestId: "hardening-drop-original", itemId: "food", variant: null, quantity: 10 }
    );
    expect(partialReplay).toMatchObject({ replayed: true });
    expect(partialReplay.drop).toEqual(original.drop);
    expect(partialReplay.inventory).toEqual(original.inventory);
    await dropped.pickupDroppedItem(
      playerRecord(picker), "hardening-pick-full", original.drop.dropId, { mode: "all" }
    );
    expect((await reconcileDroppedItemCustody(pool))).toEqual([]);

    const expiring = await dropped.dropItem(playerRecord(dropper), {
      requestId: "hardening-drop-expiry", itemId: "food", variant: null, quantity: 4
    });
    nowMs += DROPPED_ITEM_TTL_MS + 1;
    expect(await dropped.expireDue(now())).toBe(1);
    expect(await dropped.expireDue(now())).toBe(0);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM world_item_movements
       WHERE drop_id=$1 AND movement_kind='world_to_destruction'`,
      [expiring.drop.dropId]
    )).rows[0]?.count).toBe("1");
    const expiryReplay = await new DroppedItemService(pool, undefined, now).dropItem(
      playerRecord(dropper),
      { requestId: "hardening-drop-expiry", itemId: "food", variant: null, quantity: 4 }
    );
    expect(expiryReplay.drop).toEqual(expiring.drop);
    expect(await reconcileDroppedItemCustody(pool)).toEqual([]);
  });

  it("commits and replays a drop from a selected inventory stack", async () => {
    const inventory = new InventoryService(pool);
    const stack = (await inventory.getInventorySnapshot(dropper.playerId)).items.find(
      (item) => item.resourceType === "wood"
    )!;
    const dropped = new DroppedItemService(pool);
    const input = {
      requestId: "hardening-selected-stack-drop",
      itemId: "wood",
      variant: null,
      quantity: 1,
      stackId: stack.stackId!
    };
    const original = await dropped.dropItem(playerRecord(dropper), input);
    const replay = await dropped.dropItem(playerRecord(dropper), input);
    expect(original).toMatchObject({
      replayed: false,
      drop: { itemId: "wood", quantity: 1 }
    });
    expect(replay).toMatchObject({
      replayed: true,
      drop: { dropId: original.drop.dropId }
    });
    expect((await inventory.getInventorySnapshot(dropper.playerId)).totals.wood).toBe(1);
  });

  it("serializes concurrent matching drops into one nearby pile and replays safely", async () => {
    const inventory = new InventoryService(pool);
    await inventory.grantItemsForOperation({
      operationKey: "hardening-nearby-pile-third-seed",
      playerId: third.playerId,
      source: "hardening_test_seed",
      grants: [{ itemId: "wood", variant: null, quantity: 1 }]
    });
    const firstInput = {
      requestId: "hardening-nearby-pile-first",
      itemId: "wood",
      variant: null,
      quantity: 1
    } as const;
    const secondInput = {
      requestId: "hardening-nearby-pile-second",
      itemId: "wood",
      variant: null,
      quantity: 1
    } as const;
    const firstActor = playerRecord(dropper);
    const secondActor = {
      ...playerRecord(third),
      position: { lat: 35.0005, lon: -106 }
    };
    const [first, second] = await Promise.all([
      new DroppedItemService(pool).dropItem(firstActor, firstInput),
      new DroppedItemService(pool).dropItem(secondActor, secondInput)
    ]);

    expect(second.drop.pileId).toBe(first.drop.pileId);
    expect([first.drop.pileOrder, second.drop.pileOrder].sort()).toEqual([0, 1]);
    expect(new Set([
      `${first.drop.lat}:${first.drop.lon}`,
      `${second.drop.lat}:${second.drop.lon}`
    ]).size).toBe(1);

    const [firstReplay, secondReplay] = await Promise.all([
      new DroppedItemService(pool).dropItem(firstActor, firstInput),
      new DroppedItemService(pool).dropItem(secondActor, secondInput)
    ]);
    expect(firstReplay).toMatchObject({ replayed: true, drop: { dropId: first.drop.dropId } });
    expect(secondReplay).toMatchObject({ replayed: true, drop: { dropId: second.drop.dropId } });
    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM world_item_drops WHERE pile_id = $1",
      [first.drop.pileId]
    )).rows[0]?.count).toBe("2");
    expect(await reconcileDroppedItemCustody(pool)).toEqual([]);
  });

  it("merges nearby system loot while preserving every custody source", async () => {
    const client = await pool.connect();
    let dropId = "";
    try {
      await client.query("BEGIN");
      const [created] = await createSystemGroundDropsInTransaction(client, {
        operationKey: "hardening-system-ground-drop",
        droppedByPlayerId: dropper.playerId,
        regionCode: "NM",
        zoneId: "world:NM",
        pileId: "hardening-system-ground-pile",
        sourceEntityType: "combat_settlement",
        sourceEntityId: "hardening-system-ground-drop",
        position: playerRecord(dropper).position,
        reason: "combat_deer_loot",
        lines: [{ itemId: "leather", variant: null, quantity: 3 }]
      });
      dropId = created!.dropId;
      const secondInput = {
        operationKey: "hardening-system-ground-drop-nearby",
        droppedByPlayerId: dropper.playerId,
        regionCode: "NM",
        zoneId: "world:NM",
        pileId: "hardening-system-ground-pile-nearby",
        sourceEntityType: "combat_settlement",
        sourceEntityId: "hardening-system-ground-drop-nearby",
        position: { lat: 35.001, lon: -106 },
        reason: "combat_deer_loot",
        lines: [{ itemId: "leather", variant: null, quantity: 3 }]
      } as const;
      const [merged] = await createSystemGroundDropsInTransaction(client, secondInput);
      const [replayed] = await createSystemGroundDropsInTransaction(client, secondInput);
      expect(merged).toMatchObject({ dropId, quantity: 6 });
      expect(replayed).toMatchObject({ dropId, quantity: 6 });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    expect((await pool.query<{
      drops: string;
      sources: string;
      creations: string;
      quantity: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM world_item_drops WHERE id=$1) AS drops,
         (SELECT count(*)::text FROM world_item_system_drop_sources WHERE drop_id=$1) AS sources,
         (SELECT count(*)::text FROM world_item_movements
          WHERE drop_id=$1 AND movement_kind='system_to_world') AS creations,
         (SELECT remaining_quantity::text FROM world_item_drops WHERE id=$1) AS quantity`,
      [dropId]
    )).rows[0]).toEqual({ drops: "1", sources: "2", creations: "2", quantity: "6" });
    expect(await reconcileDroppedItemCustody(pool)).toEqual([]);
    await new DroppedItemService(pool).pickupDroppedItem(
      playerRecord(picker),
      "hardening-system-ground-pickup",
      dropId,
      { mode: "all" }
    );
    expect(await reconcileDroppedItemCustody(pool)).toEqual([]);
  });

  it("keeps the authoritative remainder when pickup capacity is limited", async () => {
    const inventory = new InventoryService(pool);
    await inventory.grantItemsForOperation({
      operationKey: "hardening-capacity-picker-seed",
      playerId: picker.playerId,
      source: "hardening_test_seed",
      grants: [
        { itemId: "balsam_resin", variant: null, quantity: 96 },
        { itemId: "wood", variant: null, quantity: 250 }
      ]
    });
    // Fill the current physical slots while leaving exactly four units of resin headroom.
    const occupiedSlots = (await inventory.getInventorySnapshot(picker.playerId)).items.length;
    for (let index = 0; index < DEFAULT_PLAYER_BASE_INVENTORY_SLOTS - occupiedSlots; index += 1) {
      const snapshot = await inventory.getInventorySnapshot(picker.playerId);
      const stack = snapshot.items.find(
        (item) => item.resourceType === "wood" && !item.manualSplit
      )!;
      await inventory.splitStack(
        picker.playerId,
        `hardening-capacity-split-${index}`,
        stack.stackId!,
        1
      );
    }
    await inventory.grantItemsForOperation({
      operationKey: "hardening-capacity-dropper-seed",
      playerId: dropper.playerId,
      source: "hardening_test_seed",
      grants: [{ itemId: "balsam_resin", variant: null, quantity: 10 }]
    });
    const dropped = new DroppedItemService(pool);
    const created = await dropped.dropItem(playerRecord(dropper), {
      requestId: "hardening-capacity-drop",
      itemId: "balsam_resin",
      variant: null,
      quantity: 10
    });
    const picked = await dropped.pickupDroppedItem(
      playerRecord(picker),
      "hardening-capacity-pickup",
      created.drop.dropId,
      { mode: "all" }
    );
    expect(picked).toMatchObject({
      pickedUpQuantity: 4,
      remainingQuantity: 6,
      removed: false,
      drop: { quantity: 6, status: "active" },
      inventory: { totals: { balsam_resin: 100 } }
    });
  });

  it("serializes pickup versus expiry to one custody outcome", async () => {
    const createdAt = new Date("2026-07-10T15:00:00.000Z");
    const dropped = new DroppedItemService(pool, undefined, () => createdAt);
    const created = await dropped.dropItem(playerRecord(dropper), {
      requestId: "hardening-drop-race", itemId: "food", variant: null, quantity: 5
    });
    const beforeExpiry = new DroppedItemService(
      pool, undefined, () => new Date(createdAt.getTime() + DROPPED_ITEM_TTL_MS - 1)
    );
    const afterExpiry = new DroppedItemService(
      pool, undefined, () => new Date(createdAt.getTime() + DROPPED_ITEM_TTL_MS + 1)
    );
    await Promise.allSettled([
      beforeExpiry.pickupDroppedItem(
        playerRecord(picker), "hardening-race-pick", created.drop.dropId, { mode: "all" }
      ),
      afterExpiry.expireDue(new Date(createdAt.getTime() + DROPPED_ITEM_TTL_MS + 1))
    ]);
    const terminal = await pool.query<{ status: string; picked: string; destroyed: string }>(
      `SELECT d.status,
              coalesce(sum(m.quantity) FILTER (WHERE m.movement_kind='world_to_player'),0)::text AS picked,
              coalesce(sum(m.quantity) FILTER (WHERE m.movement_kind='world_to_destruction'),0)::text AS destroyed
       FROM world_item_drops d LEFT JOIN world_item_movements m ON m.drop_id=d.id
       WHERE d.id=$1 GROUP BY d.id`,
      [created.drop.dropId]
    );
    expect(["picked_up", "expired"]).toContain(terminal.rows[0]!.status);
    expect(BigInt(terminal.rows[0]!.picked) + BigInt(terminal.rows[0]!.destroyed)).toBe(5n);
    expect(await reconcileDroppedItemCustody(pool)).toEqual([]);
  });

  it("serializes concurrent partial pickups without exceeding world custody", async () => {
    const droppedA = new DroppedItemService(pool);
    const droppedB = new DroppedItemService(pool);
    const created = await droppedA.dropItem(playerRecord(dropper), {
      requestId: "hardening-partial-race-drop", itemId: "food", variant: null, quantity: 5
    });
    const results = await Promise.allSettled([
      droppedA.pickupDroppedItem(
        playerRecord(picker), "hardening-partial-race-one", created.drop.dropId,
        { mode: "quantity", quantity: 4 }
      ),
      droppedB.pickupDroppedItem(
        playerRecord(third), "hardening-partial-race-two", created.drop.dropId,
        { mode: "quantity", quantity: 4 }
      )
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const custody = await pool.query<{ remaining: string; picked: string }>(
      `SELECT d.remaining_quantity::text AS remaining,
              coalesce(sum(m.quantity) FILTER (WHERE m.movement_kind='world_to_player'),0)::text
                AS picked
       FROM world_item_drops d LEFT JOIN world_item_movements m ON m.drop_id=d.id
       WHERE d.id=$1 GROUP BY d.id`,
      [created.drop.dropId]
    );
    expect(custody.rows[0]).toEqual({ remaining: "1", picked: "4" });
    expect(await reconcileDroppedItemCustody(pool)).toEqual([]);
  });

  it("rejects an appended incompatible event under a drop operation at COMMIT", async () => {
    const dropped = new DroppedItemService(pool);
    const created = await dropped.dropItem(playerRecord(dropper), {
      requestId: "hardening-drop-malformed", itemId: "food", variant: null, quantity: 2
    });
    const operationKey = (await pool.query<{ operation_key: string }>(
      "SELECT operation_key FROM world_item_drops WHERE id=$1", [created.drop.dropId]
    )).rows[0]!.operation_key;
    await expectCommitRejected(pool, async (client) => {
      const stack = await client.query<{ quantity: string; version: string }>(
        `UPDATE player_inventory
         SET quantity=quantity+1, version=version+1
         WHERE player_id=$1 AND resource_type='wood' AND variant='default'
         RETURNING quantity::text, version::text`,
        [dropper.playerId]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
           version_after, source, source_entity_type, source_entity_id
         ) VALUES ($1,$2,'wood','default',1,$3,$4,'drop_item','world_item_drop',$5)`,
        [operationKey, dropper.playerId, stack.rows[0]!.quantity,
          stack.rows[0]!.version, created.drop.dropId]
      );
    }, /world item operation|inventory transition|custody/i);
  });

  it("rejects a raw drop whose immutable replay result omits required truth at COMMIT", async () => {
    const dropId = randomUUID();
    const operationKey = `hardening-raw-drop:${dropId}`;
    const createdAt = new Date("2026-07-10T18:00:00.000Z");
    const expiresAt = new Date(createdAt.getTime() + DROPPED_ITEM_TTL_MS);
    await expectCommitRejected(pool, async (client) => {
      await client.query(
        `INSERT INTO inventory_operations (
           operation_key,player_id,source,source_entity_type,source_entity_id
         ) VALUES ($1,$2,'drop_item','world_item_drop',$3)`,
        [operationKey, dropper.playerId, dropId]
      );
      const stack = await client.query<{ quantity: string; version: string }>(
        `UPDATE player_inventory
         SET quantity=quantity-2,version=version+1
         WHERE player_id=$1 AND resource_type='food' AND variant='default'
         RETURNING quantity::text,version::text`,
        [dropper.playerId]
      );
      await client.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,source_entity_type,source_entity_id
         ) VALUES ($1,$2,'food','default',-2,$3,$4,
                   'drop_item','world_item_drop',$5)`,
        [operationKey, dropper.playerId, stack.rows[0]!.quantity,
          stack.rows[0]!.version, dropId]
      );
      await client.query(
        `INSERT INTO world_item_drops (
           id,operation_key,dropped_by,region_code,zone_id,pile_id,pile_order,item_id,variant,
           original_quantity,remaining_quantity,status,lat,lon,geom,
           created_at,expires_at
         ) VALUES ($1,$2,$3,'NM','world:NM',$6,0,'food','default',2,2,'active',35,-106,
                   ST_SetSRID(ST_MakePoint(-106,35),4326),$4,$5)`,
        [dropId, operationKey, dropper.playerId, createdAt, expiresAt, `drop:${dropId}`]
      );
      await client.query(
        `INSERT INTO world_item_drop_requests (
           operation_key,drop_id,player_id,request_hash,original_result,created_at
         ) VALUES (
           $1,$2,$3,
           encode(sha256(convert_to($3 || chr(31) || 'food' || chr(31)
             || 'default' || chr(31) || '2','UTF8')),'hex'),
           $4::jsonb,$5
         )`,
        [operationKey, dropId, dropper.playerId, JSON.stringify({
          drop: {
            dropId,
            droppedBy: dropper.playerId,
            itemId: "food",
            variant: null,
            quantity: 2,
            status: "active",
            lat: 35,
            lon: -106,
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            pickedUpBy: null,
            pickedUpAt: null
          },
          inventory: {}
        }), createdAt]
      );
      await client.query(
        `INSERT INTO world_item_movements (
           drop_id,movement_kind,operation_key,player_id,item_id,variant,
           quantity,reason,created_at
         ) VALUES ($1,'player_to_world',$2,$3,'food','default',2,'drop_created',$4)`,
        [dropId, operationKey, dropper.playerId, createdAt]
      );
    }, /replay intent or original result/i);
  });

  it("charges failed quote attempts while durable completed replay remains free", async () => {
    const highLimit = createLegacyMarketTestService(pool, marketConfig({
      MARKET_QUOTE_REQUESTS_PER_MINUTE: "100"
    }), createLogger("test"));
    const completed = await highLimit.quote(buyer, "hardening-quote-complete", "stone", "1");
    await pool.query(
      "DELETE FROM market_rate_windows WHERE player_id=$1 AND action_bucket='quote'",
      [buyer.playerId]
    );
    const lowLimit = createLegacyMarketTestService(pool, marketConfig({
      MARKET_QUOTE_REQUESTS_PER_MINUTE: "2"
    }), createLogger("test"));
    await expect(lowLimit.quote(buyer, "hardening-quote-invalid-1", "missing-one", "1"))
      .rejects.toMatchObject({ code: "MARKET_UNKNOWN_ITEM" });
    await expect(lowLimit.quote(buyer, "hardening-quote-invalid-2", "water", "1"))
      .rejects.toMatchObject({ code: "MARKET_ITEM_NOT_TRADABLE" });
    await expect(lowLimit.quote(buyer, "hardening-quote-invalid-3", "missing-three", "1"))
      .rejects.toMatchObject({ code: "MARKET_RATE_LIMITED" });
    await expect(lowLimit.quote(buyer, "hardening-quote-complete", "stone", "1"))
      .resolves.toEqual(completed);
  });

  it("atomically audits bounded control evidence and keeps audit/control rows immutable", async () => {
    await market.quote(buyer, "hardening-book-delete-quote", "stone", "1");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await setMarketControlAuditContext(client, {
        operatorIdentity: "test:hardening-operator",
        reason: "verify immutable control evidence",
        incidentId: "INC-HARDENING-1"
      });
      await client.query("UPDATE market_global_controls SET read_only=true WHERE singleton");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const audit = await pool.query<{ evidence: Record<string, unknown> }>(
      `SELECT evidence FROM market_audit_events
       WHERE event_type='market_control_changed'
       ORDER BY audit_event_id DESC LIMIT 1`
    );
    expect(audit.rows[0]?.evidence).toMatchObject({
      operatorIdentity: "test:hardening-operator",
      reason: "verify immutable control evidence",
      incidentId: "INC-HARDENING-1",
      targetScope: { type: "global", id: "global" },
      priorState: { readOnly: false },
      resultingState: { readOnly: true }
    });
    await expect(pool.query(
      "DELETE FROM market_audit_events WHERE event_type='market_control_changed'"
    )).rejects.toThrow(/immutable|cannot be deleted/i);

    await expect(pool.query("DELETE FROM market_order_books"))
      .rejects.toThrow(/control rows cannot be deleted/i);
  });

  it("rejects missing, oversized, or control-character administrative evidence", async () => {
    const attempts = [
      { operator: null, reason: null, error: /requires operator identity|requires a reason/i },
      { operator: "x".repeat(161), reason: "bounded", error: /operator identity.*too long/i },
      { operator: "test:operator", reason: "bad\nreason", error: /reason is invalid/i },
      { operator: "test:operator", reason: "x".repeat(241), error: /reason.*too long/i }
    ];
    for (const attempt of attempts) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (attempt.operator !== null) {
          await client.query(
            "SELECT set_config('ash_atlas.market_control_operator',$1,true)",
            [attempt.operator]
          );
        }
        if (attempt.reason !== null) {
          await client.query(
            "SELECT set_config('ash_atlas.market_control_reason',$1,true)",
            [attempt.reason]
          );
        }
        await expect(client.query(
          "UPDATE market_global_controls SET matching_enabled=NOT matching_enabled WHERE singleton"
        )).rejects.toThrow(attempt.error);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  });
});

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

function marketConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl!,
    MARKET_GLOBAL_ACCESS: "true",
    MARKET_TRANSACTION_RETRY_LIMIT: "3",
    MARKET_QUOTE_REQUESTS_PER_MINUTE: "100",
    ...overrides
  });
}

async function resetEconomy(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE market_order_books CASCADE");
  await pool.query("TRUNCATE accounts CASCADE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMarketControlAuditContext(client, {
      operatorIdentity: "test:economy-hardening",
      reason: "reset isolated hardening integration database"
    });
    await client.query(
      `UPDATE market_global_controls
       SET read_only=false, new_orders_enabled=true, matching_enabled=true,
           cancellations_enabled=true, claims_enabled=true,
           auto_pause_on_invariant_failure=true, rules_version=1`
    );
    await client.query("UPDATE market_venue_controls SET frozen=false, sensitive_reason=NULL");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await pool.query("UPDATE market_venues SET fee_policy_id=2 WHERE venue_key='global'");
  await pool.query("UPDATE market_fee_policies SET active=true WHERE fee_policy_id=2");
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
  current: MarketActor,
  amount: bigint,
  suffix: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await new WalletService().creditForOperationInTransaction(client, {
      playerId: current.playerId,
      accountId: current.accountId,
      amount,
      operationKey: `hardening-wallet-seed:${suffix}`,
      reason: "hardening_test_seed"
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createRestingSell(
  service: LegacyMarketTestService,
  requestId: string,
  quantity: number,
  unitPrice: number
): Promise<string> {
  const result = await service.createOrder(seller, {
    requestId, interface: "merchant", side: "sell", itemId: "stone",
    quantity: String(quantity), unitPrice: String(unitPrice)
  });
  return result.order!.orderId;
}

async function createRestingBuy(
  service: LegacyMarketTestService,
  requestId: string,
  quantity: number,
  unitPrice: number
): Promise<string> {
  const result = await service.createOrder(buyer, {
    requestId, interface: "merchant", side: "buy", itemId: "stone",
    quantity: String(quantity), unitPrice: String(unitPrice)
  });
  return result.order!.orderId;
}

async function createNoncrossingPair(
  service: LegacyMarketTestService,
  suffix: string
): Promise<{ buyOrderId: string; sellOrderId: string }> {
  const sellOrderId = await createRestingSell(service, `${suffix}-sell`, 5, 10);
  const buyOrderId = await createRestingBuy(service, `${suffix}-buy`, 5, 9);
  return { buyOrderId, sellOrderId };
}

async function insertRawTrade(
  client: pg.PoolClient,
  buyOrderId: string,
  sellOrderId: string,
  unitPrice: number
): Promise<void> {
  await client.query(
    `INSERT INTO market_trades (
       trade_id, venue_id, book_id, item_identity, item_id, variant,
       buy_order_id, sell_order_id, buyer_player_id, seller_player_id,
       maker_order_id, quantity, unit_price, gross_value, buyer_fee, seller_fee,
       book_version, buyer_fee_policy_id, buyer_fee_policy_version,
       seller_fee_policy_id, seller_fee_policy_version, rules_version
     )
     SELECT $3, buy.venue_id, buy.book_id, buy.item_identity, buy.item_id, buy.variant,
            buy.order_id, sell.order_id, buy.player_id, sell.player_id,
            sell.order_id, 1, $4::bigint, $4::bigint, 0, 0,
            coalesce((SELECT max(book_version)+1 FROM market_trades
                      WHERE book_id=buy.book_id), 1),
            buy.fee_policy_id, buy.fee_policy_version,
            sell.fee_policy_id, sell.fee_policy_version, buy.rules_version
     FROM market_orders buy, market_orders sell
     WHERE buy.order_id=$1 AND sell.order_id=$2`,
    [buyOrderId, sellOrderId, randomUUID(), unitPrice]
  );
}

async function insertBalancedEscrowDistortion(
  client: pg.PoolClient,
  orderId: string,
  escrowDelta: number
): Promise<void> {
  await client.query(
    `INSERT INTO market_ledger_entries (
       ledger_group_id, asset_kind, item_identity, amount, account_location,
       player_id, order_id, reason
     )
     SELECT group_row.ledger_group_id, escrow.asset_kind, escrow.item_identity,
            $2::bigint,
            CASE WHEN escrow.asset_kind='item' THEN 'sell_escrow' ELSE 'buy_escrow' END,
            order_row.player_id, order_row.order_id, 'hardening_distortion_escrow'
     FROM market_orders order_row
     JOIN market_order_escrows escrow ON escrow.order_id=order_row.order_id
     JOIN LATERAL (
       SELECT ledger_group_id FROM market_ledger_groups
       WHERE order_id=order_row.order_id
       ORDER BY CASE WHEN group_type='cancel' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1
     ) group_row ON true
     WHERE order_row.order_id=$1
     UNION ALL
     SELECT group_row.ledger_group_id, escrow.asset_kind, escrow.item_identity,
            -$2::bigint,
            CASE WHEN escrow.asset_kind='item' THEN 'player_inventory' ELSE 'player_wallet' END,
            order_row.player_id, order_row.order_id, 'hardening_distortion_offset'
     FROM market_orders order_row
     JOIN market_order_escrows escrow ON escrow.order_id=order_row.order_id
     JOIN LATERAL (
       SELECT ledger_group_id FROM market_ledger_groups
       WHERE order_id=order_row.order_id
       ORDER BY CASE WHEN group_type='cancel' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1
     ) group_row ON true
     WHERE order_row.order_id=$1`,
    [orderId, escrowDelta]
  );
}

async function expectCommitRejected(
  pool: pg.Pool,
  body: (client: pg.PoolClient) => Promise<void>,
  message: RegExp
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await body(client);
      await expect(client.query("COMMIT")).rejects.toThrow(message);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

async function expectStatementAndCommitRejected(
  pool: pg.Pool,
  body: (client: pg.PoolClient) => Promise<void>,
  statementMessage: RegExp
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await expect(body(client)).rejects.toThrow(statementMessage);
    const commit = await client.query("COMMIT");
    expect(commit.command).toBe("ROLLBACK");
  } finally {
    client.release();
  }
}

function assertDedicatedDatabase(url: string): void {
  const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!database.endsWith("_test") && !database.endsWith("_validation")) {
    throw new Error(
      `Economy hardening tests require a dedicated *_test or *_validation database; received ${database}`
    );
  }
}

type RetainedMigrationReport = {
  walletBalance: string;
  walletVersion: string;
  walletEvents: string;
  walletGenesis: string;
  inventoryQuantity: string;
  inventoryVersion: string;
  inventoryEvents: string;
  inventoryGenesis: string;
  retainedDropRemaining: string;
  retainedDropRequests: string;
  retainedDropCreations: string;
  retainedPartialOriginal: string;
  retainedPartialRemaining: string;
  retainedPartialPickups: string;
  reconciliationIssues: string;
};

async function verifyRetainedMigration(url: string): Promise<RetainedMigrationReport> {
  const sourceUrl = new URL(url);
  const databaseName = `ash_atlas_stability_retained_${process.pid}_validation`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const retainedUrl = new URL(sourceUrl);
  retainedUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  let retained: pg.Pool | undefined;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    retained = new DisposableTestPool({ connectionString: retainedUrl.toString(), max: 1 });

    const migrationDirectory = fileURLToPath(
      new URL("../../../../db/migrations/", import.meta.url)
    );
    const migrations = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith(".sql") && name < "0601_market_economy_hardening.sql")
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(`${migrationDirectory}/${migration}`, "utf8");
      const client = await retained.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`retained migration setup failed at ${migration}`, { cause: error });
      } finally {
        client.release();
      }
    }

    const retainedAccount = "93000000-0000-4000-8000-000000000001";
    const retainedPlayer = "retained-hardening-player";
    await retained.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [retainedAccount]
    );
    await retained.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$1,$1,'NM',35,-106,35,-106,900,true,
                 ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [retainedPlayer, retainedAccount]
    );
    await retained.query(
      `INSERT INTO player_wallets (player_id,account_id,gold_balance,version)
       VALUES ($1,$2,990,1)`,
      [retainedPlayer, retainedAccount]
    );
    await retained.query(
      `INSERT INTO wallet_events (
         operation_key,player_id,account_id,delta_gold,balance_after,reason,created_at
       ) VALUES ('retained-wallet-spend',$1,$2,-10,990,'retained_test',
                 '2026-01-01T00:00:01Z')`,
      [retainedPlayer, retainedAccount]
    );
    await retained.query(
      `INSERT INTO player_inventory (player_id,resource_type,variant,quantity)
       VALUES ($1,'stone','default',8)`,
      [retainedPlayer]
    );
    await retained.query(
      `INSERT INTO inventory_operations (
         operation_key,player_id,source,source_entity_type,source_entity_id,created_at
       ) VALUES ('retained-inventory-spend',$1,'retained_test','test','retained',
                 '2026-01-01T00:00:01Z')`,
      [retainedPlayer]
    );
    await retained.query(
      `INSERT INTO inventory_events (
         operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
         source,source_entity_type,source_entity_id,created_at
       ) VALUES ('retained-inventory-spend',$1,'stone','default',-2,8,
                 'retained_test','test','retained','2026-01-01T00:00:01Z')`,
      [retainedPlayer]
    );
    await retained.query(
      `INSERT INTO player_inventory (player_id,resource_type,variant,quantity)
       VALUES ($1,'food','default',15)`,
      [retainedPlayer]
    );
    await retained.query(
      `INSERT INTO inventory_operations (
         operation_key,player_id,source,source_entity_type,source_entity_id,created_at
       ) VALUES ('retained-drop-operation',$1,'drop_item','world_item_drop',NULL,
                 '2026-01-01T00:00:02Z')`,
      [retainedPlayer]
    );
    await retained.query(
      `INSERT INTO inventory_events (
         operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
         source,source_entity_type,source_entity_id,created_at
       ) VALUES ('retained-drop-operation',$1,'food','default',-2,18,
                 'drop_item','world_item_drop',NULL,'2026-01-01T00:00:02Z')`,
      [retainedPlayer]
    );
    await retained.query(
      `INSERT INTO inventory_operations (
         operation_key,player_id,source,source_entity_type,source_entity_id,created_at
       ) VALUES
         ('retained-partial-drop',$1,'drop_item','world_item_drop',NULL,
          '2026-01-01T00:00:03Z'),
         ('retained-partial-pick-one',$1,'pickup_dropped_item','world_item_drop',
          '93000000-0000-4000-8000-000000000003','2026-01-01T00:00:04Z'),
         ('retained-partial-pick-two',$1,'pickup_dropped_item','world_item_drop',
          '93000000-0000-4000-8000-000000000003','2026-01-01T00:00:04Z')`,
      [retainedPlayer]
    );
    await retained.query(
      `INSERT INTO inventory_events (
         operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
         source,source_entity_type,source_entity_id,created_at
       ) VALUES
         ('retained-partial-drop',$1,'food','default',-10,8,
          'drop_item','world_item_drop',NULL,'2026-01-01T00:00:03Z'),
         ('retained-partial-pick-one',$1,'food','default',4,12,
          'pickup_dropped_item','world_item_drop',
          '93000000-0000-4000-8000-000000000003','2026-01-01T00:00:04Z'),
         ('retained-partial-pick-two',$1,'food','default',3,15,
          'pickup_dropped_item','world_item_drop',
          '93000000-0000-4000-8000-000000000003','2026-01-01T00:00:04Z')`,
      [retainedPlayer]
    );
    await retained.query(
      `INSERT INTO world_item_drops (
         id,operation_key,dropped_by,region_code,item_id,variant,quantity,status,
         lat,lon,geom,created_at,expires_at
       ) VALUES (
         '93000000-0000-4000-8000-000000000003','retained-partial-drop',$1,
         'NM','food','default',3,'active',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),
         '2026-01-01T00:00:03Z','2027-01-01T00:00:03Z'
       )`,
      [retainedPlayer]
    );
    await retained.query(
      `INSERT INTO world_item_pickups (
         operation_key,drop_id,player_id,pickup_mode,requested_quantity,
         granted_quantity,remaining_quantity,resulting_status,created_at
       ) VALUES
         ('retained-partial-pick-one','93000000-0000-4000-8000-000000000003',$1,
          'quantity',4,4,6,'active','2026-01-01T00:00:04Z'),
         ('retained-partial-pick-two','93000000-0000-4000-8000-000000000003',$1,
          'quantity',3,3,3,'active','2026-01-01T00:00:04Z')`,
      [retainedPlayer]
    );
    await retained.query(
      `INSERT INTO world_item_drops (
         id,operation_key,dropped_by,region_code,item_id,variant,quantity,status,
         lat,lon,geom,created_at,expires_at
       ) VALUES (
         '93000000-0000-4000-8000-000000000002','retained-drop-operation',$1,
         'NM','food','default',2,'active',35,-106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),
         '2026-01-01T00:00:02Z','2027-01-01T00:00:02Z'
       )`,
      [retainedPlayer]
    );

    const hardeningSql = await readFile(
      `${migrationDirectory}/0601_market_economy_hardening.sql`,
      "utf8"
    );
    const migrationClient = await retained.connect();
    try {
      await migrationClient.query("BEGIN");
      await migrationClient.query(hardeningSql);
      await migrationClient.query("COMMIT");
    } catch (error) {
      await migrationClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      migrationClient.release();
    }

    const state = await retained.query<RetainedMigrationReport>(
      `SELECT
         wallet.gold_balance::text AS "walletBalance",
         wallet.version::text AS "walletVersion",
         (SELECT count(*)::text FROM wallet_events
          WHERE player_id=$1 AND account_id=$2) AS "walletEvents",
         (SELECT count(*)::text FROM wallet_events
          WHERE player_id=$1 AND account_id=$2
            AND reason='economy_hardening_genesis') AS "walletGenesis",
         inventory.quantity::text AS "inventoryQuantity",
         inventory.version::text AS "inventoryVersion",
         (SELECT count(*)::text FROM inventory_events
          WHERE player_id=$1 AND item_id='stone' AND variant='default') AS "inventoryEvents",
         (SELECT count(*)::text FROM inventory_events
          WHERE player_id=$1 AND item_id='stone' AND variant='default'
            AND source='economy_hardening_genesis') AS "inventoryGenesis",
         (SELECT remaining_quantity::text FROM world_item_drops
          WHERE id='93000000-0000-4000-8000-000000000002') AS "retainedDropRemaining",
         (SELECT count(*)::text FROM world_item_drop_requests
          WHERE drop_id='93000000-0000-4000-8000-000000000002') AS "retainedDropRequests",
         (SELECT count(*)::text FROM world_item_movements
          WHERE drop_id='93000000-0000-4000-8000-000000000002'
            AND movement_kind='player_to_world') AS "retainedDropCreations",
         (SELECT original_quantity::text FROM world_item_drops
          WHERE id='93000000-0000-4000-8000-000000000003') AS "retainedPartialOriginal",
         (SELECT remaining_quantity::text FROM world_item_drops
          WHERE id='93000000-0000-4000-8000-000000000003') AS "retainedPartialRemaining",
         (SELECT count(*)::text FROM world_item_movements
          WHERE drop_id='93000000-0000-4000-8000-000000000003'
            AND movement_kind='world_to_player') AS "retainedPartialPickups",
         '0'::text AS "reconciliationIssues"
       FROM player_wallets wallet
       JOIN player_inventory inventory
         ON inventory.player_id=wallet.player_id
        AND inventory.resource_type='stone' AND inventory.variant='default'
       WHERE wallet.player_id=$1 AND wallet.account_id=$2`,
      [retainedPlayer, retainedAccount]
    );
    // Preserve the exact 0601 assertions above, then reconcile with today's schema.
    const laterMigrations = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith(".sql") && name > "0601_market_economy_hardening.sql")
      .sort();
    for (const migration of laterMigrations) {
      const client = await retained.connect();
      try {
        await client.query("BEGIN");
        await client.query(await readFile(`${migrationDirectory}/${migration}`, "utf8"));
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    const reconciliation = await new MarketReconciliationService(retained).reconcile({
      honorAutomaticProtection: false
    });
    return {
      ...state.rows[0]!,
      reconciliationIssues: String(reconciliation.issues.length)
    };
  } finally {
    if (retained) await endSingleClientPool(retained);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`)
      .catch(() => undefined);
    await admin.end();
  }
}

async function endSingleClientPool(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  const ended = new Promise<void>((resolve) => client.once("end", resolve));
  client.release(new Error("Closing retained migration test connection before database teardown"));
  await ended;
  await pool.end();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}
