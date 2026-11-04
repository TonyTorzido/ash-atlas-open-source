import { describe, expect, it } from "vitest";
import { emptyInventoryTotals, MARKET_MAX_MUTATION_TRADES, marketServerMessageSchema } from "@ash-atlas/shared";

import { isRuntimeMarketServerMessage } from "./marketServerMessageValidation.js";

const requestId = "request-0001";

describe("market server message runtime validation", () => {
  it("accepts a bounded canonical authoritative snapshot", () => {
    expect(isRuntimeMarketServerMessage(openResult())).toBe(true);
  });

  it("accepts an expired order in the player's recent orders", () => {
    const message = openResult();
    message.snapshot.player.recentOrders = [{
      orderId: "order-0001",
      itemId: "tempest_quill",
      itemIdentity: "tempest_quill",
      variant: null,
      displayName: "Tempest Quill",
      side: "sell",
      policy: "gtc",
      unitPrice: "40",
      originalQuantity: "2",
      filledQuantity: "0",
      remainingQuantity: "2",
      status: "expired",
      prioritySequence: "1",
      createdAt: "2026-09-20T23:24:18.000Z",
      cancelledAt: null,
      completedAt: "2026-09-27T23:24:18.000Z"
    }] as never;
    expect(isRuntimeMarketServerMessage(message)).toBe(true);
  });

  it("rejects malformed nested economic integers", () => {
    const message = openResult();
    message.snapshot.player.walletGold = "01";
    expect(isRuntimeMarketServerMessage(message)).toBe(false);
  });

  it("requires mutation envelope and durable result request ids to agree", () => {
    const player = openResult().snapshot.player;
    expect(isRuntimeMarketServerMessage({
      type: "MARKET_MUTATION_RESULT",
      requestId,
      result: {
        action: "claim",
        requestId: "request-another",
        replayed: false,
        order: null,
        trades: [],
        claimedItems: "0",
        claimedGold: "1",
        claimedEquipment: 0,
        equipmentListing: null,
        player
      },
      inventory: inventory()
    })).toBe(false);
  });

  it("accepts exactly the shared mutation fill bound and rejects one more", () => {
    const trade = {
      tradeId: "00000000-0000-4000-8000-000000000007",
      quantity: "1",
      unitPrice: "8",
      total: "8",
      buyerTax: "0",
      sellerProceeds: "8",
      buyerTaxBps: 0,
      specialtyTaxApplied: false,
      qualifyingTaxTag: null,
      createdAt: new Date(0).toISOString()
    };
    const message = {
      type: "MARKET_MUTATION_RESULT",
      requestId,
      result: {
        action: "simple_buy",
        requestId,
        replayed: false,
        order: null,
        trades: Array.from({ length: MARKET_MAX_MUTATION_TRADES }, () => trade),
        claimedItems: "0",
        claimedGold: "0",
        claimedEquipment: 0,
        equipmentListing: null,
        player: openResult().snapshot.player
      },
      inventory: inventory()
    };
    const parsed = marketServerMessageSchema.safeParse(message);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
    expect(isRuntimeMarketServerMessage(message)).toBe(true);
    message.result.trades.push(trade);
    expect(isRuntimeMarketServerMessage(message)).toBe(false);
  });

  it("rejects duplicate, unsorted, zero-order, and oversized book depth", () => {
    const duplicate = bookResult();
    duplicate.book.asks.push({ unitPrice: "8", quantity: "1", orderCount: 1 });
    expect(isRuntimeMarketServerMessage(duplicate)).toBe(false);

    const unsorted = bookResult();
    unsorted.book.asks.push({ unitPrice: "7", quantity: "1", orderCount: 1 });
    expect(isRuntimeMarketServerMessage(unsorted)).toBe(false);

    const zeroOrders = bookResult();
    zeroOrders.book.asks[0]!.orderCount = 0;
    expect(isRuntimeMarketServerMessage(zeroOrders)).toBe(false);

    const oversized = bookResult();
    oversized.book.asks[0]!.quantity = "9223372036854775808";
    expect(isRuntimeMarketServerMessage(oversized)).toBe(false);
  });

  it("rejects counterparty authority fields and unknown quote outcomes", () => {
    expect(isRuntimeMarketServerMessage({ ...openResult(), sellerId: "secret" })).toBe(false);
    const nested = openResult();
    (nested.snapshot.items[0] as Record<string, unknown>).buyerId = "secret";
    expect(isRuntimeMarketServerMessage(nested)).toBe(false);
    expect(isRuntimeMarketServerMessage({
      type: "MARKET_QUOTE_RESULT",
      requestId,
      quote: {
        quoteId: "00000000-0000-4000-8000-000000000099",
        itemId: "ore",
        itemIdentity: "ore:default",
        requestedQuantity: "1",
        requestedMaximumUnitPrice: "8",
        fillableQuantity: "1",
        quotedTotal: "8",
        maximumUnitPrice: "8",
        fullQuantityAvailable: true,
        availability: "mystery",
        bookVersion: "1",
        expiresAt: new Date(0).toISOString()
      }
    })).toBe(false);
  });

  it("never throws while fuzzing malformed market server messages", () => {
    let state = 0xc0ffee12;
    const random = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 0x1_0000_0000;
    };
    const atoms: unknown[] = [
      null, false, -1, 0, 1, 1.5, "", "01", "1e3", "9223372036854775808",
      [], {}, { accountId: "forged" }
    ];
    for (let index = 0; index < 5_000; index += 1) {
      const candidate = random() < 0.15
        ? bookResult()
        : {
            type: random() < 0.7 ? "MARKET_QUOTE_RESULT" : `MARKET_UNKNOWN_${index}`,
            requestId: atoms[Math.floor(random() * atoms.length)],
            quote: atoms[Math.floor(random() * atoms.length)]
          };
      expect(() => isRuntimeMarketServerMessage(candidate)).not.toThrow();
    }
  });
});

function inventory() {
  return {
    playerId: "player-1",
    revision: 0,
    items: [],
    totals: emptyInventoryTotals(),
    unlockedSlots: 16
  };
}

function bookResult() {
  return {
    type: "MARKET_BOOK_RESULT",
    requestId,
    book: {
      item: { ...openResult().snapshot.items[0] },
      asks: [{ unitPrice: "8", quantity: "3", orderCount: 1 }],
      bids: [{ unitPrice: "7", quantity: "2", orderCount: 1 }],
      recentTrades: []
    }
  };
}

function openResult() {
  return {
    type: "MARKET_OPEN_RESULT",
    requestId,
    snapshot: {
      venue: {
        venueId: "00000000-0000-4000-8000-000000000001",
        venueKey: "city-test",
        displayName: "Test City Market",
        scopeType: "regional",
        cityId: "00000000-0000-4000-8000-000000000003",
        cityName: "Test City",
        marketStructureId: "00000000-0000-4000-8000-000000000004",
        activeMonumentTypes: [],
        standardBuyerTaxBps: 1_000,
        specialtyBuyerTaxBps: 500,
        taxRevision: "1"
      },
      sessionId: "00000000-0000-4000-8000-000000000005",
      controls: {
        accessAllowed: true,
        readOnly: false,
        newOrdersEnabled: true,
        matchingEnabled: true,
        cancellationsEnabled: true,
        claimsEnabled: true,
        venueFrozen: false,
        playerFrozen: false,
        message: null
      },
      categories: ["resource"],
      items: [{
        itemId: "ore",
        itemIdentity: "ore",
        displayName: "Ore",
        iconKey: "ore",
        category: "resource",
        bestAsk: "8",
        bestBid: "7",
        availableSellQuantity: "10",
        availableBuyQuantity: "4",
        lastTradePrice: "8",
        bookVersion: "1"
      }],
      equipmentListings: [],
      nextCursor: null,
      player: {
        walletGold: "100",
        walletVersion: "0",
        activeOrders: [],
        recentOrders: [],
        recentFills: [],
        collection: { items: [], equipment: [], gold: "0" }
      },
      feePolicy: {
        version: 1,
        listingFee: "0",
        buyerFeeBps: 0,
        sellerFeeBps: 0,
        cancellationFee: "0"
      }
    }
  };
}
