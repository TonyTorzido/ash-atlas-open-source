import { emptyInventoryTotals, type ClientMessage, type ServerMessage } from "@ash-atlas/shared";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import { loadConfig } from "../config.js";
import { CombatEngine } from "../game/combat/combatEngine.js";
import { worldBootstrapLocationFixtures } from "../realtime/worldBootstrapTestFixtures.js";
import type { FlagService } from "../game/flags.js";
import { MarketError } from "../game/marketRules.js";
import type { MarketService } from "../game/marketService.js";
import type { PlayerService } from "../game/players.js";
import { GameState, type PlayerRecord } from "../game/state.js";
import { createLogger, type AppLogger } from "../logger.js";
import { ConnectionRegistry, type SocketLike } from "../realtime/connectionRegistry.js";
import { publishMarketCommit, registerRealtime } from "../realtime/websocket.js";

const quoteId = "00000000-0000-4000-8000-000000000001";
const orderId = "00000000-0000-4000-8000-000000000002";
const marketStructureId = "00000000-0000-4000-8000-000000000003";
const marketSessionId = "00000000-0000-4000-8000-000000000004";
const venueId = "00000000-0000-4000-8000-000000000005";

describe("market realtime boundary", () => {
  it("accepts payloads immediately below and exactly at the configured byte limit", async () => {
    const harness = await createHarness({ WS_MAX_PAYLOAD_BYTES: "128" });
    const client = await connect(harness, "one");
    try {
      client.socket.send(paddedJson({ type: "PING", clientTime: 1 }, 127));
      client.socket.send(paddedJson({ type: "PING", clientTime: 2 }, 128));
      await vi.waitFor(() => {
        expect(client.messages.filter((message) => message.type === "PONG")).toHaveLength(2);
      });
    } finally {
      client.socket.terminate();
      await harness.app.close();
    }
  });

  it.each([
    ["valid JSON", paddedJson({ type: "PING", clientTime: 1 }, 129)],
    ["malformed JSON", `{${"x".repeat(128)}`]
  ])("closes an oversized %s payload deterministically", async (_label, payload) => {
    const harness = await createHarness({ WS_MAX_PAYLOAD_BYTES: "128" });
    const client = await connect(harness, "one");
    try {
      const closed = new Promise<number>((resolve) => {
        client.socket.once("close", (code) => resolve(code));
      });
      client.socket.send(payload);
      await expect(closed).resolves.toBe(1009);
    } finally {
      client.socket.terminate();
      await harness.app.close();
    }
  });

  it("throttles market floods at the connection edge before service calls", async () => {
    const harness = await createHarness({
      WS_MARKET_REQUESTS_PER_10_SECONDS: "2",
      WS_MARKET_IP_REQUESTS_PER_10_SECONDS: "20"
    });
    const client = await connect(harness, "one");
    try {
      for (let index = 0; index < 3; index += 1) {
        client.socket.send(JSON.stringify({
          type: "MARKET_OPEN",
          marketStructureId,
          expectedPlacementRevision: "1",
          requestId: `market-flood-${index}`
        } satisfies ClientMessage));
      }
      await vi.waitFor(() => {
        expect(client.messages.some(
          (message) => message.type === "MARKET_ERROR" &&
            message.code === "MARKET_RATE_LIMITED"
        )).toBe(true);
      });
      expect(harness.methods.snapshot).toHaveBeenCalledTimes(2);
    } finally {
      client.socket.terminate();
      await harness.app.close();
    }
  });

  it("requires HELLO before any market service call", async () => {
    const harness = await createHarness();
    const socket = await harness.app.injectWS("/ws", {
      headers: {
        origin: harness.config.CLIENT_ORIGIN,
        cookie: "aa_session_dev=session-one"
      }
    });
    const messages: ServerMessage[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    try {
      socket.send(JSON.stringify({
        type: "MARKET_OPEN",
        marketStructureId,
        expectedPlacementRevision: "1",
        requestId: "market-open-before-hello"
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(messages.some((message) => message.type === "MARKET_ERROR")).toBe(true);
      });
      expect(messages.find((message) => message.type === "MARKET_ERROR")).toMatchObject({
        code: "MARKET_HELLO_REQUIRED",
        retryable: false
      });
      expect(harness.methods.snapshot).not.toHaveBeenCalled();
    } finally {
      socket.terminate();
      await harness.app.close();
    }
  });

  it("bootstraps only on explicit MARKET_OPEN and replies only to the originating socket", async () => {
    const harness = await createHarness();
    const first = await connect(harness, "one");
    const second = await connect(harness, "two");
    try {
      expect(harness.methods.snapshot).not.toHaveBeenCalled();
      first.socket.send(JSON.stringify({
        type: "MARKET_OPEN",
        marketStructureId,
        expectedPlacementRevision: "1",
        requestId: "market-open-0001",
        search: "ore",
        limit: 12
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(first.messages.some((message) => message.type === "MARKET_OPEN_RESULT")).toBe(true);
      });
      expect(second.messages.some((message) => message.type === "MARKET_OPEN_RESULT")).toBe(false);
      expect(harness.methods.snapshot).toHaveBeenCalledWith(
        { playerId: "player-one", accountId: "account-one" },
        expect.objectContaining({ venueId, sessionId: marketSessionId }),
        { search: "ore", limit: 12 }
      );
    } finally {
      first.socket.terminate();
      second.socket.terminate();
      await harness.app.close();
    }
  });

  it("routes every market intent through the authenticated actor and acknowledges subscriptions", async () => {
    const harness = await createHarness();
    const client = await connect(harness, "one");
    const actor = { playerId: "player-one", accountId: "account-one" };
    try {
      for (const message of [
        { type: "MARKET_GET_BOOK",
          marketSessionId, requestId: "get-book-0001", itemId: "ore", depth: 10 },
        { type: "MARKET_REQUEST_QUOTE",
          marketSessionId, requestId: "get-quote-0001", itemId: "ore", quantity: "2", maximumUnitPrice: "9" },
        {
          type: "MARKET_CREATE_ORDER",
          marketSessionId,
          requestId: "create-order-0001",
          interface: "merchant",
          side: "buy",
          itemId: "ore",
          quantity: "2",
          unitPrice: "8"
        },
        { type: "MARKET_SIMPLE_BUY",
          marketSessionId, requestId: "simple-buy-0001", quoteId, maximumTotal: "16" },
        { type: "MARKET_CANCEL_ORDER",
          marketSessionId, requestId: "cancel-order-0001", orderId },
        { type: "MARKET_CLAIM",
          marketSessionId, requestId: "claim-all-0001", scope: "all" },
        {
          type: "MARKET_SET_SUBSCRIPTIONS",
          marketSessionId,
          requestId: "subscriptions-0001",
          visibleItemIds: ["ore", "wood"],
          focusedItemId: "ore",
          privateState: true,
          revision: 4
        }
      ] satisfies ClientMessage[]) {
        client.socket.send(JSON.stringify(message));
      }
      await vi.waitFor(() => {
        expect(harness.methods.book).toHaveBeenCalledOnce();
        expect(harness.methods.quote).toHaveBeenCalledOnce();
        expect(harness.methods.createOrder).toHaveBeenCalledOnce();
        expect(harness.methods.simpleBuy).toHaveBeenCalledOnce();
        expect(harness.methods.cancelOrder).toHaveBeenCalledOnce();
        expect(harness.methods.claim).toHaveBeenCalledOnce();
        expect(client.messages.some((message) => message.type === "MARKET_SUBSCRIPTIONS_SET"))
          .toBe(true);
      });
      expect(harness.methods.book).toHaveBeenCalledWith(
        actor,
        expect.objectContaining({ venueId, sessionId: marketSessionId }),
        "ore",
        10,
        undefined
      );
      expect(harness.methods.quote).toHaveBeenCalledWith(
        actor,
        expect.any(String),
        marketSessionId,
        "get-quote-0001",
        "ore",
        "2",
        "9",
        undefined
      );
      expect(harness.methods.createOrder.mock.calls[0]?.[0]).toEqual(actor);
      expect(harness.methods.simpleBuy.mock.calls[0]?.[0]).toEqual(actor);
      expect(harness.methods.cancelOrder.mock.calls[0]?.[0]).toEqual(actor);
      expect(harness.methods.claim).toHaveBeenCalledWith(
        actor,
        expect.any(String),
        marketSessionId,
        "claim-all-0001",
        "all"
      );
      expect(harness.methods.assertSubscriptionAccess).toHaveBeenCalledWith(
        actor,
        expect.any(String),
        marketSessionId
      );
      const mutationResults = client.messages.filter(
        (message) => message.type === "MARKET_MUTATION_RESULT"
      );
      expect(mutationResults).toHaveLength(4);
      expect(mutationResults.every(
        (message) =>
          message.inventory.playerId === "player-one" &&
          message.inventory.unlockedSlots === 16
      )).toBe(true);
      expect(client.messages.find((message) => message.type === "MARKET_SUBSCRIPTIONS_SET"))
        .toMatchObject({ requestId: "subscriptions-0001", revision: 4 });

      const connectionId = harness.registry.activeConnectionIdForAccount("account-one");
      expect(connectionId).not.toBeNull();
      expect(harness.registry.marketSubscriptionForConnection(connectionId!)).toMatchObject({
        visibleItemIds: ["ore", "wood"],
        focusedItemId: "ore",
        privateState: true,
        revision: 4
      });
      client.socket.terminate();
      await vi.waitFor(() => {
        expect(harness.registry.marketSubscriptionForConnection(connectionId!)).toBeNull();
      });
    } finally {
      client.socket.terminate();
      await harness.app.close();
    }
  });

  it("rejects forged identity fields before the service and maps MarketError safely", async () => {
    const harness = await createHarness();
    const client = await connect(harness, "one");
    try {
      client.socket.send(JSON.stringify({
        type: "MARKET_CREATE_ORDER",
          marketSessionId,
        requestId: "forged-order-0001",
        interface: "simple",
        side: "sell",
        itemId: "ore",
        quantity: "1",
        unitPrice: "8",
        playerId: "player-two",
        accountId: "account-two",
        resultingBalance: "999999"
      }));
      await vi.waitFor(() => {
        expect(client.messages.some(
          (message) => message.type === "ERROR" &&
            message.code === "WEBSOCKET_ERROR" &&
            message.requestId === "forged-order-0001"
        )).toBe(true);
      });
      expect(harness.methods.createOrder).not.toHaveBeenCalled();

      harness.methods.cancelOrder.mockRejectedValueOnce(
        new MarketError("MARKET_ORDER_NOT_OWNED", "Only the owner can cancel", false)
      );
      client.socket.send(JSON.stringify({
        type: "MARKET_CANCEL_ORDER",
          marketSessionId,
        requestId: "cancel-forbidden-0001",
        orderId
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(client.messages.some(
          (message) => message.type === "MARKET_ERROR" &&
            message.requestId === "cancel-forbidden-0001"
        )).toBe(true);
      });
      expect(client.messages.find(
        (message) => message.type === "MARKET_ERROR" &&
          message.requestId === "cancel-forbidden-0001"
      )).toMatchObject({
        code: "MARKET_ORDER_NOT_OWNED",
        message: "Only the owner can cancel",
        retryable: false
      });
      expect(harness.methods.cancelOrder.mock.calls[0]?.[0]).toEqual({
        playerId: "player-one",
        accountId: "account-one"
      });
    } finally {
      client.socket.terminate();
      await harness.app.close();
    }
  });

  it("returns quote failures only to the initiating connection", async () => {
    const harness = await createHarness();
    const first = await connect(harness, "one");
    const second = await connect(harness, "two");
    try {
      harness.methods.quote.mockRejectedValueOnce(
        new MarketError("MARKET_VENUE_FROZEN", "Market is temporarily frozen", true)
      );
      first.socket.send(JSON.stringify({
        type: "MARKET_REQUEST_QUOTE",
          marketSessionId,
        requestId: "quote-frozen-0001",
        itemId: "ore",
        quantity: "1",
        maximumUnitPrice: "8"
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(first.messages.some((message) =>
          message.type === "MARKET_ERROR" && message.requestId === "quote-frozen-0001"
        )).toBe(true);
      });
      expect(first.messages.find((message) =>
        message.type === "MARKET_ERROR" && message.requestId === "quote-frozen-0001"
      )).toMatchObject({ code: "MARKET_VENUE_FROZEN", retryable: true });
      expect(second.messages.some((message) => message.type === "MARKET_ERROR")).toBe(false);
    } finally {
      first.socket.terminate();
      second.socket.terminate();
      await harness.app.close();
    }
  });

  it("turns unexpected quote failures into terminal responses", async () => {
    const harness = await createHarness();
    const client = await connect(harness, "one");
    try {
      harness.methods.quote.mockRejectedValueOnce(new Error("database detail must not leak"));
      client.socket.send(JSON.stringify({
        type: "MARKET_REQUEST_QUOTE",
          marketSessionId,
        requestId: "quote-failed-0001",
        itemId: "ore",
        quantity: "1",
        maximumUnitPrice: "8"
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(client.messages.some((message) =>
          message.type === "MARKET_ERROR" && message.requestId === "quote-failed-0001"
        )).toBe(true);
      });
      expect(client.messages.find((message) =>
        message.type === "MARKET_ERROR" && message.requestId === "quote-failed-0001"
      )).toMatchObject({
        code: "MARKET_REQUEST_FAILED",
        message: "Market request could not be completed",
        retryable: false
      });
    } finally {
      client.socket.terminate();
      await harness.app.close();
    }
  });

  it.each([
    ["snapshot", { type: "MARKET_OPEN",
          marketStructureId, expectedPlacementRevision: "1", requestId: "terminal-open" }],
    ["book", { type: "MARKET_GET_BOOK",
          marketSessionId, requestId: "terminal-book", itemId: "ore", depth: 10 }],
    ["quote", {
      type: "MARKET_REQUEST_QUOTE",
          marketSessionId, requestId: "terminal-quote", itemId: "ore",
      quantity: "1", maximumUnitPrice: "8"
    }],
    ["createOrder", {
      type: "MARKET_CREATE_ORDER",
          marketSessionId, requestId: "terminal-create", interface: "merchant",
      side: "buy", itemId: "ore", quantity: "1", unitPrice: "8"
    }],
    ["simpleBuy", {
      type: "MARKET_SIMPLE_BUY",
          marketSessionId, requestId: "terminal-buy", quoteId, maximumTotal: "8"
    }],
    ["cancelOrder", { type: "MARKET_CANCEL_ORDER",
          marketSessionId, requestId: "terminal-cancel", orderId }],
    ["claim", { type: "MARKET_CLAIM",
          marketSessionId, requestId: "terminal-claim", scope: "all" }]
  ] as const)("sends one correlated terminal error when %s rejects", async (method, message) => {
    const harness = await createHarness();
    const client = await connect(harness, "one");
    try {
      harness.methods[method].mockRejectedValueOnce(
        new MarketError("MARKET_BUSY", "Market is busy; retry", true)
      );
      client.socket.send(JSON.stringify(message satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(client.messages.filter((candidate) =>
          candidate.type === "MARKET_ERROR" && candidate.requestId === message.requestId
        )).toHaveLength(1);
      });
      expect(client.messages.find((candidate) =>
        candidate.type === "MARKET_ERROR" && candidate.requestId === message.requestId
      )).toMatchObject({ code: "MARKET_BUSY", retryable: true });
    } finally {
      client.socket.terminate();
      await harness.app.close();
    }
  });

  it("checks the centralized access policy before installing market subscriptions", async () => {
    const harness = await createHarness();
    const client = await connect(harness, "one");
    harness.methods.assertSubscriptionAccess.mockRejectedValueOnce(
      new MarketError("MARKET_ACCESS_DENIED", "Market access is not available here", false)
    );
    try {
      client.socket.send(JSON.stringify({
        type: "MARKET_SET_SUBSCRIPTIONS",
          marketSessionId,
        requestId: "subscriptions-denied-0001",
        visibleItemIds: ["ore"],
        focusedItemId: "ore",
        privateState: true,
        revision: 1
      } satisfies ClientMessage));
      await vi.waitFor(() => {
        expect(client.messages.some(
          (message) => message.type === "MARKET_ERROR" && message.code === "MARKET_ACCESS_DENIED"
        )).toBe(true);
      });
      const connectionId = harness.registry.activeConnectionIdForAccount("account-one");
      expect(connectionId).not.toBeNull();
      expect(harness.registry.marketSubscriptionForConnection(connectionId!)).toBeNull();
    } finally {
      client.socket.terminate();
      await harness.app.close();
    }
  });

  it("publishes only bounded item, book, and affected-player notifications", async () => {
    const registry = new ConnectionRegistry();
    const summarySocket = fakeSocket();
    const bookSocket = fakeSocket();
    const unrelatedSocket = fakeSocket();
    const summary = registry.addWithReplacement(connection("one", summarySocket));
    const book = registry.addWithReplacement(connection("two", bookSocket));
    const unrelated = registry.addWithReplacement(connection("three", unrelatedSocket));
    registry.setMarketSubscriptions(summary.connectionId, {
      venueId, marketSessionId,
      visibleItemIds: ["ore"], focusedItemId: null, privateState: true, revision: 1
    });
    registry.setMarketSubscriptions(book.connectionId, {
      venueId, marketSessionId,
      visibleItemIds: [], focusedItemId: "ore", privateState: true, revision: 1
    });
    registry.setMarketSubscriptions(unrelated.connectionId, {
      venueId, marketSessionId,
      visibleItemIds: ["wood"], focusedItemId: "wood", privateState: false, revision: 1
    });
    const methods = marketMethods();
    const logger = { warn: vi.fn() } as unknown as AppLogger;

    await publishMarketCommit(
      methods.market,
      registry,
      { venueId, itemId: "ore", playerIds: ["player-one", "player-two", "player-two"] },
      logger
    );

    expect(messageTypes(summarySocket)).toEqual([
      "MARKET_ASSETS_CHANGED",
      "MARKET_PLAYER_STATE_CHANGED",
      "MARKET_ITEM_SUMMARY_CHANGED"
    ]);
    expect(messageTypes(bookSocket)).toEqual([
      "MARKET_ASSETS_CHANGED",
      "MARKET_PLAYER_STATE_CHANGED",
      "MARKET_BOOK_CHANGED"
    ]);
    expect(messageTypes(unrelatedSocket)).toEqual([]);
    expect(methods.book).toHaveBeenCalledOnce();
    expect(methods.book).toHaveBeenCalledWith(
      { playerId: "player-one", accountId: "account-one" },
      venueId,
      "ore"
    );
    expect(methods.requireSession).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("rechecks each subscriber policy before publishing committed market data", async () => {
    const registry = new ConnectionRegistry();
    const allowedSocket = fakeSocket();
    const deniedSocket = fakeSocket();
    const allowed = registry.addWithReplacement(connection("one", allowedSocket));
    const denied = registry.addWithReplacement(connection("two", deniedSocket));
    registry.setMarketSubscriptions(allowed.connectionId, {
      venueId, marketSessionId,
      visibleItemIds: ["ore"], focusedItemId: null, privateState: false, revision: 1
    });
    registry.setMarketSubscriptions(denied.connectionId, {
      venueId, marketSessionId,
      visibleItemIds: ["ore"], focusedItemId: "ore", privateState: true, revision: 1
    });
    const methods = marketMethods();
    methods.requireSession.mockImplementation(async (actor: unknown) => {
      if ((actor as { accountId: string }).accountId === "account-two") {
        throw new MarketError("MARKET_ACCESS_DENIED", "Market access is not available here", false);
      }
      return {
        sessionId: marketSessionId,
        venueId,
        venueKey: "test-city",
        displayName: "Test City Market",
        cityId: "00000000-0000-4000-8000-000000000006",
        cityName: "Test City",
        marketStructureId,
        activeMonumentTypes: [],
        taxRevision: "1",
        relocationRevision: 0
      };
    });
    const logger = { warn: vi.fn() } as unknown as AppLogger;

    await publishMarketCommit(
      methods.market,
      registry,
      { venueId, itemId: "ore", playerIds: ["player-two"] },
      logger
    );

    expect(messageTypes(allowedSocket)).toEqual(["MARKET_ITEM_SUMMARY_CHANGED"]);
    expect(messageTypes(deniedSocket)).toEqual(["MARKET_ASSETS_CHANGED"]);
    expect(methods.book).toHaveBeenCalledWith(
      { playerId: "player-one", accountId: "account-one" },
      venueId,
      "ore"
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

async function createHarness(overrides: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ NODE_ENV: "test", ...overrides });
  const logger = createLogger("test");
  const registry = new ConnectionRegistry();
  const gameState = new GameState(config, logger);
  const methods = marketMethods();
  const auth = {
    sessionCookieName: "aa_session_dev",
    assertOrigin: vi.fn(),
    authenticateSession: vi.fn(async (token: string | null) => {
      const suffix = token === "session-two" ? "two" : "one";
      return session(suffix);
    }),
    developerCapabilities: vi.fn(() => []),
    requireGameplayReady: vi.fn(),
    recordConnectionEvent: vi.fn(async () => undefined)
  } as unknown as AuthService;
  const players = {
    loadPlayer: vi.fn(async (playerId: string) => playerRecord(playerId.replace("player-", ""))),
    markOnline: vi.fn(async () => undefined),
    persistPlayerSnapshot: vi.fn(async () => undefined),
    markOffline: vi.fn(async () => undefined)
  } as unknown as PlayerService;
  const app = Fastify();
  await app.register(cookie);
  installAuthGuard(app, config, auth);
  await registerRealtime({
      infrastructure: {
          app: app,
          registry: registry,
          logger: logger,
          config: config
      },
      authority: {
          gameState: gameState,
          flagService: { listFlags: vi.fn(async () => []) } as unknown as FlagService,
          playerService: players,
          auth: auth,
      },
      capabilities: {
          ...worldBootstrapLocationFixtures(),
          combat: new CombatEngine({ tickRateHz: config.SERVER_TICK_HZ }),
          market: methods.market,
          inventory: {
            getInventorySnapshot: vi.fn(async (playerId: string) => ({
              playerId,
              items: [],
              totals: emptyInventoryTotals(),
              unlockedSlots: 16
            }))
          } as never
      }
  });
  await app.ready();
  return { app, config, registry, methods };
}

function marketMethods() {
  const authority = {
    sessionId: marketSessionId,
    venueId,
    venueKey: "test-city",
    displayName: "Test City Market",
    cityId: "00000000-0000-4000-8000-000000000006",
    cityName: "Test City",
    marketStructureId,
    activeMonumentTypes: [],
    taxRevision: "1",
    relocationRevision: 0
  } as const;
  const assertAccess = vi.fn(async (...args: [unknown]) => {
    void args;
  });
  const openSession = vi.fn(async () => authority);
  const requireSession = vi.fn(
    async (...args: [unknown, string, string]) => {
      void args;
      return authority;
    }
  );
  const assertSubscriptionAccess = vi.fn(async () => authority);
  const snapshot = vi.fn(async () => ({
    venue: {
      venueId,
      venueKey: "test-city",
      displayName: "Test City Market",
      scopeType: "regional",
      cityId: authority.cityId,
      cityName: authority.cityName,
      marketStructureId,
      activeMonumentTypes: [],
      standardBuyerTaxBps: 900,
      specialtyBuyerTaxBps: 450,
      taxRevision: "1"
    },
    sessionId: marketSessionId,
    controls: {},
    categories: [],
    items: [],
    equipmentListings: [],
    nextCursor: null,
    player: {},
    feePolicy: {}
  } as never));
  const book = vi.fn(async () => ({
    item: {
      itemId: "ore",
      itemIdentity: "ore",
      displayName: "Ore",
      iconKey: "ore",
      category: "resource",
      bestAsk: "8",
      bestBid: "7",
      availableSellQuantity: "4",
      availableBuyQuantity: "2",
      lastTradePrice: "8",
      bookVersion: "12"
    },
    asks: [],
    bids: [],
    recentTrades: []
  } as never));
  const quote = vi.fn(async () => ({ quoteId, itemId: "ore" } as never));
  const mutation = () => ({
    action: "create_order",
    requestId: "request",
    replayed: false,
    order: null,
    trades: [],
    claimedItems: "0",
    claimedGold: "0",
    player: {}
  } as never);
  const createOrder = vi.fn(async (...args: [unknown, unknown]) => {
    void args;
    return mutation();
  });
  const simpleBuy = vi.fn(async (...args: [unknown, string, string, string]) => {
    void args;
    return mutation();
  });
  const cancelOrder = vi.fn(async (...args: [unknown, string, string]) => {
    void args;
    return mutation();
  });
  const claim = vi.fn(async (...args: [unknown, string, unknown]) => {
    void args;
    return mutation();
  });
  const assetsSnapshot = vi.fn(async () => ({
    wallet: { playerId: "player-one", gold: "0", revision: "0" },
    inventory: {
      playerId: "player-one",
      revision: 0,
      items: [],
      totals: {},
      unlockedSlots: 0
    }
  } as never));
  const market = {
    openSession,
    requireSession,
    assetsSnapshot,
    read: {
      assertAccess,
      assertSubscriptionAccess,
      snapshot,
      book,
      bookForRealtime: book
    },
    quote,
    createOrder,
    simpleBuy,
    cancelOrder,
    claim
  } as unknown as MarketService;
  return {
    market,
    openSession,
    requireSession,
    assertSubscriptionAccess,
    assertAccess,
    snapshot,
    book,
    quote,
    createOrder,
    simpleBuy,
    cancelOrder,
    claim
  };
}

async function connect(harness: Awaited<ReturnType<typeof createHarness>>, suffix: "one" | "two") {
  const socket = await harness.app.injectWS("/ws", {
    headers: {
      origin: harness.config.CLIENT_ORIGIN,
      cookie: `aa_session_dev=session-${suffix}`
    }
  });
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  socket.send(JSON.stringify({ type: "HELLO" } satisfies ClientMessage));
  await vi.waitFor(() => {
    expect(messages.some((message) => message.type === "WELCOME")).toBe(true);
  });
  return { socket, messages };
}

function session(suffix: string) {
  return {
    sessionId: `session-${suffix}`,
    account: {
      id: `account-${suffix}`,
      status: "active" as const,
      trustTier: "new" as const,
      riskScore: 0,
      createdAt: new Date(),
      lastLoginAt: null
    },
    player: {
      id: `player-${suffix}`,
      accountId: `account-${suffix}`,
      displayName: suffix
    },
    deviceInstallationId: `device-${suffix}`,
    csrfToken: "csrf"
  };
}

function playerRecord(suffix: string): PlayerRecord {
  return {
    playerId: `player-${suffix}`,
    username: suffix,
    displayColor: "#38bdf8",
    regionCode: "NM",
    position: { lat: 35.0844, lon: -106.6504 },
    anchor: { lat: 35.0844, lon: -106.6504 },
    moveLeashRadiusM: 900,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date()
  };
}

function connection(suffix: string, socket: SocketLike) {
  return {
    accountId: `account-${suffix}`,
    playerId: `player-${suffix}`,
    username: suffix,
    regionCode: "NM",
    zoneId: "world:NM",
    socket
  };
}

function fakeSocket(): SocketLike {
  return { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
}

function messageTypes(socket: SocketLike): string[] {
  return (socket.send as ReturnType<typeof vi.fn>).mock.calls.map(([raw]) =>
    (JSON.parse(String(raw)) as ServerMessage).type
  );
}

function paddedJson(value: unknown, byteLength: number): string {
  const raw = JSON.stringify(value);
  const padding = byteLength - Buffer.byteLength(raw, "utf8");
  if (padding < 0) throw new Error("test payload exceeds requested length");
  return raw + " ".repeat(padding);
}
