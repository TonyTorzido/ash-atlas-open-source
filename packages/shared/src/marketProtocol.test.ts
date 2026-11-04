import { describe, expect, it } from "vitest";

import {
  marketClientMessageSchema,
  marketIntegerSchema,
  marketServerMessageSchema
} from "./marketProtocol.js";

const requestId = "request-0001";
const quoteId = "00000000-0000-4000-8000-000000000001";
const orderId = "00000000-0000-4000-8000-000000000002";
const marketSessionId = "00000000-0000-4000-8000-000000000003";
const marketStructureId = "00000000-0000-4000-8000-000000000004";
const equipmentInstanceId = "00000000-0000-4000-8000-000000000005";
const listingId = "00000000-0000-4000-8000-000000000006";

function createOrder() {
  return {
    type: "MARKET_CREATE_ORDER",
    requestId,
    marketSessionId,
    interface: "merchant",
    side: "buy",
    itemId: "ore",
    quantity: "12",
    unitPrice: "345"
  } as const;
}

describe("market client protocol", () => {
  it("accepts the full database-length market identity but keeps legacy item IDs narrower", () => {
    const itemIdentity = `gem:${"a".repeat(156)}`;
    expect(itemIdentity).toHaveLength(160);
    expect(marketClientMessageSchema.safeParse({
      type: "MARKET_GET_BOOK", requestId, marketSessionId, itemIdentity
    }).success).toBe(true);
    expect(marketClientMessageSchema.safeParse({
      type: "MARKET_GET_BOOK", requestId, marketSessionId,
      itemIdentity: `${itemIdentity}a`
    }).success).toBe(false);
    expect(marketClientMessageSchema.safeParse({
      type: "MARKET_GET_BOOK", requestId, marketSessionId,
      itemId: "enchantment_stone:ruby"
    }).success).toBe(false);
  });

  it("selects variant books by truthful market identity", () => {
    const identity = "enchantment_stone:ruby";
    for (const message of [
      { type: "MARKET_GET_BOOK", requestId, marketSessionId, itemIdentity: identity },
      {
        type: "MARKET_REQUEST_QUOTE", requestId, marketSessionId,
        itemIdentity: identity, quantity: "1", maximumUnitPrice: "10"
      },
      {
        type: "MARKET_CREATE_ORDER", requestId, marketSessionId,
        interface: "merchant", side: "sell", itemIdentity: identity,
        quantity: "1", unitPrice: "10"
      },
      {
        type: "MARKET_SET_SUBSCRIPTIONS", requestId, marketSessionId,
        visibleItemIdentities: [identity], focusedItemIdentity: identity,
        privateState: true, revision: 1
      }
    ]) {
      expect(marketClientMessageSchema.safeParse(message).success).toBe(true);
      expect(message).not.toHaveProperty("itemId");
    }
  });

  it.each([
    {
      type: "MARKET_OPEN",
      requestId,
      marketStructureId,
      expectedPlacementRevision: "1",
      search: "iron ore",
      category: "resource",
      cursor: null,
      limit: 40
    },
    {
      type: "MARKET_GET_BOOK",
      requestId,
      marketSessionId,
      itemId: "ore",
      depth: 25
    },
    {
      type: "MARKET_REQUEST_QUOTE",
      requestId,
      marketSessionId,
      itemId: "ore",
      quantity: "10",
      maximumUnitPrice: "9"
    },
    createOrder(),
    {
      type: "MARKET_SIMPLE_BUY",
      requestId,
      marketSessionId,
      quoteId,
      maximumTotal: "9007199254740991"
    },
    {
      type: "MARKET_CANCEL_ORDER",
      requestId,
      marketSessionId,
      orderId
    },
    {
      type: "MARKET_CLAIM",
      requestId,
      marketSessionId,
      scope: "all"
    },
    {
      type: "MARKET_SET_SUBSCRIPTIONS",
      requestId,
      marketSessionId,
      visibleItemIds: ["wood", "ore"],
      focusedItemId: "ore",
      privateState: true,
      revision: 7
    },
    {
      type: "MARKET_CREATE_EQUIPMENT_LISTING",
      requestId,
      marketSessionId,
      equipmentInstanceId,
      askingPrice: "500",
      expectedEquipmentRevision: "3"
    },
    {
      type: "MARKET_PURCHASE_EQUIPMENT_LISTING",
      requestId,
      marketSessionId,
      listingId,
      expectedListingVersion: "1",
      maximumBuyerTotal: "550",
      expectedTaxRevision: "7",
      expectedPriceCurrency: "gold"
    },
    {
      type: "MARKET_CANCEL_EQUIPMENT_LISTING",
      requestId,
      marketSessionId,
      listingId,
      expectedListingVersion: "1"
    }
  ])("accepts valid $type intent", (message) => {
    expect(marketClientMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each([
    "playerId",
    "accountId",
    "sellerId",
    "buyerId",
    "tradePrice",
    "finalCost",
    "escrowAmount",
    "resultingBalance",
    "filledQuantity",
    "fee",
    "success"
  ])("rejects forged authority field %s", (field) => {
    expect(
      marketClientMessageSchema.safeParse({
        ...createOrder(),
        [field]: field === "success" ? true : "999999999"
      }).success
    ).toBe(false);
  });

  it.each(["", "0", "-1", "+1", "01", "1.0", "1e3", " 1", "1 ", "NaN", "∞"])(
    "rejects malformed positive economic integer %j",
    (quantity) => {
      expect(
        marketClientMessageSchema.safeParse({
          type: "MARKET_REQUEST_QUOTE",
          requestId,
          itemId: "ore",
          quantity,
          maximumUnitPrice: "9"
        }).success
      ).toBe(false);
    }
  );

  it("bounds canonical bigint wire strings without converting them to numbers", () => {
    expect(marketIntegerSchema.safeParse("0").success).toBe(true);
    expect(marketIntegerSchema.safeParse("9223372036854775807").success).toBe(true);
    expect(marketIntegerSchema.safeParse("9223372036854775808").success).toBe(false);
    expect(marketIntegerSchema.safeParse("0001").success).toBe(false);
    expect(marketIntegerSchema.safeParse("10000000000000000000").success).toBe(false);
    expect(marketIntegerSchema.safeParse(1).success).toBe(false);
  });

  it("requires and bounds the selected maximum unit price", () => {
    const base = {
      type: "MARKET_REQUEST_QUOTE",
      requestId,
      itemId: "ore",
      quantity: "1"
    } as const;
    expect(marketClientMessageSchema.safeParse(base).success).toBe(false);
    for (const maximumUnitPrice of [
      "", "0", "-1", "01", "1.0", "1e3", "9223372036854775808"
    ]) {
      expect(marketClientMessageSchema.safeParse({ ...base, maximumUnitPrice }).success).toBe(false);
    }
  });

  it("never throws while fuzzing malformed market client messages", () => {
    let state = 0x5eed1234;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const atoms: unknown[] = [
      null, true, false, -1, 0, 1, 1.5, "", "0", "01", "1e3",
      "9223372036854775808", [], {}, { playerId: "forged" }
    ];
    for (let index = 0; index < 5_000; index += 1) {
      const candidate: Record<string, unknown> = {
        type: random() < 0.8 ? "MARKET_REQUEST_QUOTE" : `MARKET_UNKNOWN_${index}`,
        requestId: random() < 0.5 ? requestId : atoms[Math.floor(random() * atoms.length)],
        itemId: random() < 0.5 ? "ore" : atoms[Math.floor(random() * atoms.length)],
        quantity: atoms[Math.floor(random() * atoms.length)],
        maximumUnitPrice: atoms[Math.floor(random() * atoms.length)]
      };
      if (random() < 0.25) candidate.accountId = `forged-${index}`;
      expect(() => marketClientMessageSchema.safeParse(candidate)).not.toThrow();
    }
  });

  it("rejects oversized search, cursor, result limits, depth, and item identifiers", () => {
    const invalidMessages = [
      { type: "MARKET_OPEN", requestId, search: "s".repeat(81) },
      { type: "MARKET_OPEN", requestId, cursor: "A".repeat(257) },
      { type: "MARKET_OPEN", requestId, limit: 41 },
      { type: "MARKET_GET_BOOK", requestId, itemId: "ore", depth: 26 },
      { type: "MARKET_GET_BOOK", requestId, itemId: "a".repeat(121) }
    ];
    for (const message of invalidMessages) {
      expect(marketClientMessageSchema.safeParse(message).success).toBe(false);
    }
  });

  it("rejects oversized subscription sets and nested subscription authority fields", () => {
    const base = {
      type: "MARKET_SET_SUBSCRIPTIONS",
      requestId,
      focusedItemId: null,
      privateState: true,
      revision: 1
    } as const;
    expect(
      marketClientMessageSchema.safeParse({
        ...base,
        visibleItemIds: Array.from({ length: 41 }, (_, index) => `ore_${index}`)
      }).success
    ).toBe(false);
    expect(
      marketClientMessageSchema.safeParse({
        ...base,
        visibleItemIds: ["ore"],
        playerId: "forged-player"
      }).success
    ).toBe(false);
  });

  it("rejects malformed request ids, UUIDs, enums, and unknown message types", () => {
    const invalidMessages = [
      { ...createOrder(), requestId: "short" },
      { ...createOrder(), requestId: "request id with spaces" },
      { ...createOrder(), side: "auction" },
      { ...createOrder(), interface: "admin" },
      { type: "MARKET_SIMPLE_BUY", requestId, quoteId: "not-a-uuid", maximumTotal: "1" },
      { type: "MARKET_CANCEL_ORDER", requestId, orderId: "not-a-uuid" },
      { type: "MARKET_CLAIM", requestId, scope: "another-player" },
      { type: "MARKET_ADMIN_CREDIT", requestId, amount: "999" }
    ];
    for (const message of invalidMessages) {
      expect(marketClientMessageSchema.safeParse(message).success).toBe(false);
    }
  });
});

describe("market server protocol compatibility", () => {
  it("normalizes omitted legacy response variants and accepts a fill without identity", () => {
    const snapshot = marketServerMessageSchema.parse(legacyOpenResult());
    expect(snapshot.type).toBe("MARKET_OPEN_RESULT");
    if (snapshot.type !== "MARKET_OPEN_RESULT") return;
    expect(snapshot.snapshot.items[0]?.variant).toBeNull();
    expect(snapshot.snapshot.player.activeOrders[0]?.variant).toBeNull();
    expect(snapshot.snapshot.player.recentFills[0]?.variant).toBeNull();
    expect(snapshot.snapshot.player.recentFills[0]?.itemIdentity).toBeUndefined();

    const quote = marketServerMessageSchema.parse({
      type: "MARKET_QUOTE_RESULT",
      requestId,
      quote: legacyQuote()
    });
    expect(quote.type === "MARKET_QUOTE_RESULT" ? quote.quote.variant : "wrong").toBeNull();
  });

  it("requires a canonical or legacy identity on book change notifications", () => {
    expect(marketServerMessageSchema.safeParse({
      type: "MARKET_BOOK_CHANGED",
      bookVersion: "1"
    }).success).toBe(false);
    expect(marketServerMessageSchema.safeParse({
      type: "MARKET_BOOK_CHANGED",
      itemId: "wood",
      bookVersion: "1"
    }).success).toBe(true);
  });

  it("rejects the retired Fashion district in venue and quote payloads", () => {
    const openResult = legacyOpenResult();
    expect(marketServerMessageSchema.safeParse({
      ...openResult,
      snapshot: {
        ...openResult.snapshot,
        venue: { ...openResult.snapshot.venue, activeMonumentTypes: ["fashion"] }
      }
    }).success).toBe(false);
    expect(marketServerMessageSchema.safeParse({
      type: "MARKET_QUOTE_RESULT",
      requestId,
      quote: { ...legacyQuote(), districtType: "fashion" }
    }).success).toBe(false);
  });
});

const timestamp = "2026-08-28T00:00:00.000Z";

function legacySummary() {
  return {
    itemId: "wood",
    itemIdentity: "wood",
    displayName: "Wood",
    iconKey: "wood",
    category: "resource",
    bestAsk: "8",
    bestBid: null,
    availableSellQuantity: "1",
    availableBuyQuantity: "0",
    lastTradePrice: null,
    bookVersion: "1"
  };
}

function legacyOrder() {
  return {
    orderId,
    itemId: "wood",
    itemIdentity: "wood",
    displayName: "Wood",
    side: "sell",
    policy: "gtc",
    unitPrice: "8",
    originalQuantity: "1",
    filledQuantity: "0",
    remainingQuantity: "1",
    status: "open",
    prioritySequence: "1",
    createdAt: timestamp,
    cancelledAt: null,
    completedAt: null
  };
}

function legacyQuote() {
  return {
    quoteId,
    itemId: "wood",
    itemIdentity: "wood",
    requestedQuantity: "1",
    requestedMaximumUnitPrice: "8",
    fillableQuantity: "1",
    quotedTotal: "8",
    grossItemTotal: "8",
    buyerTax: "0",
    buyerTotal: "8",
    appliedBuyerTaxBps: 0,
    taxLabel: "Standard tax",
    districtType: null,
    taxRevision: "1",
    specialtyTaxApplied: false,
    qualifyingTaxTag: null,
    maximumUnitPrice: "8",
    fullQuantityAvailable: true,
    availability: "available",
    bookVersion: "1",
    expiresAt: timestamp
  };
}

function legacyOpenResult() {
  return {
    type: "MARKET_OPEN_RESULT",
    requestId,
    snapshot: {
      venue: {
        venueId: "00000000-0000-4000-8000-000000000600",
        venueKey: "global",
        displayName: "Global Market",
        scopeType: "global_test",
        cityId: null,
        cityName: null,
        marketStructureId: null,
        activeMonumentTypes: [],
        standardBuyerTaxBps: 1_000,
        specialtyBuyerTaxBps: 500,
        taxRevision: "1"
      },
      sessionId: marketSessionId,
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
      items: [legacySummary()],
      equipmentListings: [],
      nextCursor: null,
      player: {
        walletGold: "100",
        walletVersion: "1",
        activeOrders: [legacyOrder()],
        recentOrders: [],
        recentFills: [{
          tradeId: "00000000-0000-4000-8000-000000000007",
          orderId,
          side: "buy",
          itemId: "wood",
          displayName: "Wood",
          quantity: "1",
          unitPrice: "8",
          total: "8",
          createdAt: timestamp
        }],
        collection: { gold: "0", items: [], equipment: [] }
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
