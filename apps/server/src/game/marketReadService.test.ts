import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { MarketAccessPolicy } from "./marketAccess.js";
import { LEGACY_TEST_AUTHORITY } from "./legacyMarketTestAdapter.js";
import { MarketReadService } from "./marketReadService.js";

describe("market bounded read queries", () => {
  it("joins only open orders when calculating catalog and item summaries", async () => {
    const query = vi.fn(async (text: string) => {
      if (
        text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK" ||
        text.includes("set_config('statement_timeout'")
      ) return { rows: [], rowCount: null };
      if (text.includes("INSERT INTO market_rate_windows")) {
        return { rows: [{ request_count: 1 }], rowCount: 1 };
      }
      if (text.includes("FROM market_venues")) {
        return {
          rows: [{
            venue_id: "00000000-0000-4000-8000-000000000600",
            venue_key: "global",
            display_name: "Ash Atlas Global Exchange",
            scope_type: "global_test",
            fee_policy_id: 1
          }]
        };
      }
      if (text.includes("FROM item_definitions d")) {
        expect(text).toContain(
          "ON o.book_id = b.book_id AND o.status IN ('open', 'partially_filled')"
        );
        return {
          rows: [{
            item_id: "ore",
            item_identity: "ore",
            display_name: "Ore",
            category: "resource",
            book_version: "12",
            best_ask: "8",
            best_bid: "7",
            sell_quantity: "4",
            buy_quantity: "2",
            last_trade_price: "8"
          }]
        };
      }
      if (text.includes("SELECT book_id FROM market_order_books")) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const release = vi.fn();
    const pool = {
      query,
      connect: vi.fn(async () => ({ query, release }))
    } as unknown as pg.Pool;
    const access = {
      assertAccess: vi.fn(async () => undefined),
      isAccessAllowed: vi.fn(async () => true)
    } as unknown as MarketAccessPolicy;
    const service = new MarketReadService(pool, loadConfig({ NODE_ENV: "test" }), access);

    const book = await service.book(
      { playerId: "reader", accountId: "00000000-0000-4000-8000-000000000601" },
      LEGACY_TEST_AUTHORITY,
      "ore"
    );

    expect(book.item.bestAsk).toBe("8");
    expect(book.asks).toEqual([]);
    expect(book.bids).toEqual([]);
    expect(query).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(query).toHaveBeenCalledWith(
      "SELECT set_config('statement_timeout', $1, true)",
      ["3000ms"]
    );
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps legacy non-catalog orders in the owner snapshot for cancellation", async () => {
    const legacyOrder = {
      order_id: "legacy-food-order",
      item_id: "food",
      item_identity: "food",
      display_name: "Food",
      side: "sell" as const,
      order_policy: "gtc" as const,
      limit_unit_price: "4",
      original_quantity: "3",
      filled_quantity: "0",
      remaining_quantity: "3",
      status: "open" as const,
      priority_sequence: "9",
      created_at: "2026-07-31T00:00:00.000Z",
      cancelled_at: null,
      completed_at: null
    };
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM player_wallets")) {
        return { rows: [{ gold_balance: "100", version: "2" }] };
      }
      if (text.includes("FROM market_orders o JOIN item_definitions d")) {
        return { rows: [legacyOrder] };
      }
      if (text.includes("FROM market_trades t")) return { rows: [] };
      if (text.includes("FROM market_collections c")) return { rows: [] };
      if (text.includes("FROM market_equipment_listings")) return { rows: [] };
      if (text.includes("SELECT (")) return { rows: [{ gold: "0" }] };
      if (text.includes("FROM market_venues venue")) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const service = new MarketReadService(
      {} as pg.Pool,
      loadConfig({ NODE_ENV: "test" })
    );

    const snapshot = await service.playerSnapshot(
      { query } as never,
      { playerId: "owner", accountId: "00000000-0000-4000-8000-000000000601" },
      LEGACY_TEST_AUTHORITY.venueId
    );

    expect(snapshot.activeOrders).toEqual([
      expect.objectContaining({ itemId: "food", orderId: "legacy-food-order" })
    ]);
    expect(snapshot.recentOrders).toEqual([
      expect.objectContaining({ itemId: "food", orderId: "legacy-food-order" })
    ]);
  });
});
