import { describe, expect, it } from "vitest";

import {
  buildMarketReconciliationReport,
  type MarketReconciliationSnapshot
} from "./marketReconciliation.js";

describe("market reconciliation", () => {
  it("accepts a balanced open sell order and its escrow ledger", () => {
    const snapshot = emptySnapshot();
    snapshot.counts.order_count = "1";
    snapshot.counts.ledger_group_count = "1";
    snapshot.orders.push({
      order_id: "10000000-0000-4000-8000-000000000001",
      venue_id: "00000000-0000-4000-8000-000000000600",
      book_id: "20000000-0000-4000-8000-000000000001",
      player_id: "player-a",
      account_id: "30000000-0000-4000-8000-000000000001",
      item_identity: "ore",
      item_id: "ore",
      variant: "default",
      side: "sell",
      order_policy: "gtc",
      limit_unit_price: "8",
      original_quantity: "10",
      filled_quantity: "0",
      remaining_quantity: "10",
      status: "open",
      cancelled_at: null,
      completed_at: null,
      expired_at: null,
      trade_quantity: "0",
      trade_gold_spent: "0",
      buyer_fee_bps: 0,
      escrow_order_id: "10000000-0000-4000-8000-000000000001",
      escrow_player_id: "player-a",
      escrow_asset_kind: "item",
      escrow_item_identity: "ore",
      escrow_item_id: "ore",
      escrow_variant: "default",
      escrow_initial_amount: "10",
      escrow_remaining_amount: "10",
      escrow_ledger_net: "10",
      escrow_group_count: "1",
      cancel_group_count: "0"
    });
    snapshot.ledgerGroups.push({
      ledger_group_id: "40000000-0000-4000-8000-000000000001",
      group_type: "order_escrow",
      request_id: "request-0001",
      order_id: "10000000-0000-4000-8000-000000000001",
      trade_id: null,
      venue_id: "00000000-0000-4000-8000-000000000600",
      book_id: "20000000-0000-4000-8000-000000000001",
      player_id: "player-a",
      asset_kind: "item",
      item_identity: "ore",
      order_fee_policy_id: 1,
      order_fee_policy_version: 1,
      buyer_fee_policy_id: null,
      buyer_fee_policy_version: null,
      seller_fee_policy_id: null,
      seller_fee_policy_version: null,
      fee_provenance_valid: true,
      entry_count: "2",
      balance: "0"
    });

    expect(buildMarketReconciliationReport(snapshot, new Date("2026-07-10T00:00:00Z")))
      .toEqual({
        ok: true,
        checkedAt: "2026-07-10T00:00:00.000Z",
        orderCount: 1,
        tradeCount: 0,
        ledgerGroupCount: 1,
        collectionCount: 0,
        issues: []
      });
  });

  it("reports escrow, ledger, collection, and wallet conservation failures", () => {
    const snapshot = emptySnapshot();
    snapshot.counts.order_count = "1";
    snapshot.counts.ledger_group_count = "1";
    snapshot.counts.collection_count = "1";
    snapshot.orders.push({
      order_id: "10000000-0000-4000-8000-000000000002",
      venue_id: "00000000-0000-4000-8000-000000000600",
      book_id: "20000000-0000-4000-8000-000000000002",
      player_id: "player-b",
      account_id: "30000000-0000-4000-8000-000000000002",
      item_identity: "wood",
      item_id: "wood",
      variant: "default",
      side: "buy",
      order_policy: "gtc",
      limit_unit_price: "9",
      original_quantity: "5",
      filled_quantity: "0",
      remaining_quantity: "5",
      status: "open",
      cancelled_at: null,
      completed_at: null,
      expired_at: null,
      trade_quantity: "1",
      trade_gold_spent: "0",
      buyer_fee_bps: 0,
      escrow_order_id: "10000000-0000-4000-8000-000000000002",
      escrow_player_id: "player-b",
      escrow_asset_kind: "gold",
      escrow_item_identity: null,
      escrow_item_id: null,
      escrow_variant: null,
      escrow_initial_amount: "45",
      escrow_remaining_amount: "44",
      escrow_ledger_net: "44",
      escrow_group_count: "1",
      cancel_group_count: "0"
    });
    snapshot.ledgerGroups.push({
      ledger_group_id: "40000000-0000-4000-8000-000000000002",
      group_type: "order_escrow",
      request_id: "request-0002",
      order_id: "10000000-0000-4000-8000-000000000002",
      trade_id: null,
      venue_id: "00000000-0000-4000-8000-000000000600",
      book_id: "20000000-0000-4000-8000-000000000002",
      player_id: "player-b",
      asset_kind: "gold",
      item_identity: null,
      order_fee_policy_id: 1,
      order_fee_policy_version: 1,
      buyer_fee_policy_id: null,
      buyer_fee_policy_version: null,
      seller_fee_policy_id: null,
      seller_fee_policy_version: null,
      fee_provenance_valid: true,
      entry_count: "2",
      balance: "1"
    });
    snapshot.collections.push({
      collection_id: "1",
      player_id: "player-b",
      asset_kind: "gold",
      item_identity: null,
      item_id: null,
      variant: null,
      original_amount: "5",
      remaining_amount: "5",
      reason: "buy_cancel_refund",
      source_order_id: "10000000-0000-4000-8000-000000000002",
      source_trade_id: null,
      claimed_at: null,
      ledger_net: "0",
      ledger_positive: "0",
      ledger_negative: "0",
      creation_group_matches: false,
      source_order_exists: true,
      source_order_side: "buy",
      source_order_status: "open",
      source_order_player_id: "player-b",
      source_order_book_id: "20000000-0000-4000-8000-000000000002",
      source_order_item_identity: "wood",
      source_order_item_id: "wood",
      source_order_variant: "default",
      source_order_limit_unit_price: "9",
      source_order_remaining_quantity: "5",
      source_trade_exists: false,
      source_trade_book_id: null,
      source_trade_item_identity: null,
      source_trade_item_id: null,
      source_trade_variant: null,
      source_trade_buy_order_id: null,
      source_trade_sell_order_id: null,
      source_trade_buyer_player_id: null,
      source_trade_seller_player_id: null,
      source_trade_quantity: null,
      source_trade_unit_price: null,
      source_trade_gross_value: null,
      source_trade_seller_fee: null
    });
    snapshot.wallets.push({
      player_id: "player-b",
      account_id: "30000000-0000-4000-8000-000000000002",
      player_account_id: "30000000-0000-4000-8000-000000000002",
      gold_balance: "10",
      wallet_version: "1",
      event_total: "9",
      event_count: "1",
      latest_balance_after: "10",
      latest_version_after: "1"
    });

    const report = buildMarketReconciliationReport(snapshot);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "ORDER_TRADE_QUANTITY_MISMATCH",
      "ORDER_ESCROW_REMAINDER_MISMATCH",
      "LEDGER_GROUP_UNBALANCED",
      "COLLECTION_LEDGER_MISMATCH",
      "COLLECTION_SOURCE_MISMATCH",
      "WALLET_EVENT_TOTAL_MISMATCH"
    ]));
  });
});

function emptySnapshot(): MarketReconciliationSnapshot {
  return {
    counts: {
      order_count: "0",
      trade_count: "0",
      ledger_group_count: "0",
      collection_count: "0"
    },
    orders: [],
    trades: [],
    ledgerGroups: [],
    ledgerEntryIssues: [],
    collections: [],
    wallets: [],
    walletChainIssues: [],
    walletOrphans: [],
    orphanEscrows: [],
    negativeStates: []
  };
}
