import cookie from "@fastify/cookie";
import type { ClientRequest, IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import type {
  ClientMessage,
  MarketBookSnapshot,
  MarketMutationResult,
  ServerMessage
} from "@ash-atlas/shared";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import WebSocket, { type RawData } from "ws";

import { installAuthGuard } from "../auth/authGuard.js";
import { AuthService } from "../auth/authService.js";
import { PostgresAuthStore } from "../auth/authStore.js";
import { GoogleAuthLibraryIdentityVerifier } from "../auth/googleIdentity.js";
import { loadConfig, type AppConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { FlagService } from "../game/flags.js";
import { InventoryService } from "../game/inventory.js";
import { MarketAccessPolicy } from "../game/marketAccess.js";
import { setMarketControlAuditContext } from "../game/marketControlAudit.js";
import { MarketReconciliationService } from "../game/marketReconciliation.js";
import { MarketService } from "../game/marketService.js";
import type { MarketActor } from "../game/marketRules.js";
import { PlayerService } from "../game/players.js";
import { GameState } from "../game/state.js";
import { createLogger } from "../logger.js";
import { ConnectionRegistry } from "../realtime/connectionRegistry.js";
import { publishMarketCommit, registerRealtime } from "../realtime/websocket.js";
import { WorldLookupClient } from "../world/worldLookupClient.js";

const { Pool } = pg;
const DEFAULT_DATABASE_URL =
  "postgres://ash_atlas:ash_atlas@127.0.0.1:55432/ash_atlas_markets_smoke_validation";
const EXTERNAL_RUNTIME_DATABASE_NAME = "ash_atlas_markets_dev";
const EXTERNAL_RUNTIME_WS_URL = "ws://127.0.0.1:3011/ws";
const EXTERNAL_RUNTIME_READY_URL = "http://127.0.0.1:3011/ready";
const EXTERNAL_RUNTIME_CLIENT_ORIGIN = "http://127.0.0.1:5184";
const RESPONSE_TIMEOUT_MS = 15_000;
const MARKET_UPDATE_LATENCY_SAMPLE_LIMIT = 64;
export const SMOKE_MARKET_STRUCTURE_ID = "00000000-0000-4000-8000-000000000604";
const SMOKE_MARKET_CITY_ID = "00000000-0000-4000-8000-000000000602";
const SMOKE_MARKET_FLAG_ID = "00000000-0000-4000-8000-000000000605";
const SMOKE_MARKET_VENUE_ID = "00000000-0000-4000-8000-000000000606";

type StripMarketAuthority<T> =
  T extends { type: "MARKET_OPEN" }
    ? Omit<T, "marketStructureId" | "expectedPlacementRevision">
    : T extends {
        type:
          | "MARKET_GET_BOOK"
          | "MARKET_REQUEST_QUOTE"
          | "MARKET_CREATE_ORDER"
          | "MARKET_SIMPLE_BUY"
          | "MARKET_CANCEL_ORDER"
          | "MARKET_CLAIM"
          | "MARKET_CREATE_EQUIPMENT_LISTING"
          | "MARKET_PURCHASE_EQUIPMENT_LISTING"
          | "MARKET_CANCEL_EQUIPMENT_LISTING"
          | "MARKET_SET_SUBSCRIPTIONS";
      }
      ? Omit<T, "marketSessionId">
      : T;
export type SmokeClientMessage = StripMarketAuthority<ClientMessage>;

export type AuthenticatedMarketSmokeMode =
  | {
      boundary: "in-process-fastify-websocket";
      databaseUrl: string;
      databaseName: string;
      keepDatabase: boolean;
      runtimeWsUrl: null;
    }
  | {
      boundary: "launched-network-websocket";
      databaseUrl: string;
      databaseName: typeof EXTERNAL_RUNTIME_DATABASE_NAME;
      keepDatabase: true;
      runtimeWsUrl: typeof EXTERNAL_RUNTIME_WS_URL;
    };

export type WebSocketMarketIdentity = {
  role: string;
  actor: MarketActor;
  rawSessionToken: string;
  deviceToken: string;
  email: string;
};

type SmokeIdentity = WebSocketMarketIdentity & {
  role: "seller" | "buyerOne" | "buyerTwo";
};

type InjectedSocket = {
  on(event: "message", handler: (data: Buffer | string) => void): void;
  send(data: string): void;
  terminate(): void;
};

type SmokeConnectionTarget =
  | { kind: "in_process"; app: FastifyInstance }
  | { kind: "launched_network"; runtimeWsUrl: string };

type PendingMessage = {
  predicate: (message: ServerMessage) => boolean;
  requestId: string | null;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type MarketUpdateLatencyObservation = {
  sendToNotificationMs: number;
  ordering: "notification_before_result" | "result_before_notification" | "same_timestamp";
};

type MarketUpdateLatencySummary = {
  metric: "request_send_to_committed_book_notification";
  observer: "subscribed_non_actor_websocket";
  clock: "performance.now";
  includes: "transaction_commit_publish_and_websocket_delivery";
  sampleLimit: number;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  notificationBeforeResultCount: number;
  resultBeforeNotificationCount: number;
  sameTimestampCount: number;
};

type SmokeReport = {
  ok: true;
  database: string;
  databaseDropped: boolean;
  boundary: AuthenticatedMarketSmokeMode["boundary"];
  identities: Array<{ role: SmokeIdentity["role"]; accountId: string; playerId: string; email: string }>;
  assertions: string[];
  initialFlow: {
    askOrderId: string;
    restingBidOrderId: string;
    makerTradePrice: string;
    partialAskRemainder: string;
    buyerClaimedItems: string;
    buyerClaimedGold: string;
    sellerClaimedGold: string;
    cancelledReturn: string;
  };
  replay: {
    create: boolean;
    claim: boolean;
    cancel: boolean;
  };
  finalUnitRace: {
    winner: SmokeIdentity["role"];
    winnerTradeCount: number;
    loserOrderCancelled: boolean;
  };
  controls: {
    readOnlyRejectionCode: string;
    restoredOrderCreated: boolean;
  };
  reconnect: {
    freshSnapshot: boolean;
    recentFillCount: number;
    activeOrderCount: number;
  };
  notifications: {
    sellerPrivateRefreshes: number;
    buyerPrivateRefreshes: number;
    itemSummaryChanges: number;
    bookChanges: number;
    updateLatency: MarketUpdateLatencySummary;
  };
  reconciliation: Awaited<ReturnType<MarketReconciliationService["reconcile"]>>;
  databaseCounts: {
    accounts: number;
    sessions: number;
    orders: number;
    trades: number;
    claims: number;
    ledgerGroups: number;
    walletEvents: number;
    inventoryEvents: number;
  };
  durationMs: number;
};

export class SmokeWebSocket {
  readonly messages: ServerMessage[] = [];
  private readonly pending = new Set<PendingMessage>();
  private readonly receivedAt = new WeakMap<object, number>();
  private marketSessionId: string | null = null;

  constructor(readonly role: string, private readonly socket: InjectedSocket) {
    socket.on("message", (data) => this.receive(data.toString()));
  }

  async hello(): Promise<void> {
    const response = this.waitFor((message) => message.type === "WELCOME", null);
    this.socket.send(JSON.stringify({ type: "HELLO" } satisfies SmokeClientMessage));
    await response;
  }

  async request<T extends ServerMessage["type"]>(
    message: SmokeClientMessage,
    expectedType: T
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const requestId = "requestId" in message ? message.requestId : null;
    const response = this.waitFor(
      (candidate) =>
        candidate.type === expectedType &&
        (requestId === null ||
          ("requestId" in candidate && candidate.requestId === requestId)),
      requestId
    );
    this.socket.send(JSON.stringify(this.withMarketAuthority(message)));
    const result = await response as Extract<ServerMessage, { type: T }>;
    this.captureMarketSession(result);
    return result;
  }

  async requestTerminal(message: SmokeClientMessage): Promise<ServerMessage> {
    const requestId = "requestId" in message ? message.requestId : null;
    const response = this.waitFor(
      (candidate) => requestId !== null && "requestId" in candidate &&
        candidate.requestId === requestId &&
        (candidate.type.endsWith("_RESULT") || candidate.type === "MARKET_ERROR" ||
          candidate.type === "MARKET_SUBSCRIPTIONS_SET"),
      requestId
    );
    this.socket.send(JSON.stringify(this.withMarketAuthority(message)));
    const result = await response;
    this.captureMarketSession(result);
    return result;
  }

  sendWithoutWaiting(message: SmokeClientMessage): void {
    this.socket.send(JSON.stringify(this.withMarketAuthority(message)));
  }

  async mutationWithBookNotification(
    message: Extract<
      SmokeClientMessage,
      { type: "MARKET_CREATE_ORDER" | "MARKET_CANCEL_ORDER" }
    >,
    observer: SmokeWebSocket,
    itemId: string
  ): Promise<{
    response: Extract<ServerMessage, { type: "MARKET_MUTATION_RESULT" }>;
    observation: MarketUpdateLatencyObservation;
  }> {
    const response = this.waitFor(
      (candidate) => candidate.type === "MARKET_MUTATION_RESULT" &&
        candidate.requestId === message.requestId,
      message.requestId
    );
    const notification = observer.waitFor(
      (candidate) => candidate.type === "MARKET_BOOK_CHANGED" && candidate.itemId === itemId,
      null
    );
    const sentAt = performance.now();
    this.socket.send(JSON.stringify(this.withMarketAuthority(message)));
    const [rawResponse, rawNotification] = await Promise.all([response, notification]);
    const responseAt = this.arrivalTime(rawResponse);
    const notificationAt = observer.arrivalTime(rawNotification);
    return {
      response: rawResponse as Extract<ServerMessage, { type: "MARKET_MUTATION_RESULT" }>,
      observation: {
        sendToNotificationMs: notificationAt - sentAt,
        ordering: notificationAt < responseAt
          ? "notification_before_result"
          : notificationAt > responseAt
            ? "result_before_notification"
            : "same_timestamp"
      }
    };
  }

  terminate(): void {
    this.socket.terminate();
    for (const waiter of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Socket ${this.role} terminated before its response`));
    }
    this.pending.clear();
  }

  count(type: ServerMessage["type"]): number {
    return this.messages.filter((message) => message.type === type).length;
  }

  private captureMarketSession(message: ServerMessage): void {
    if (message.type === "MARKET_OPEN_RESULT") {
      this.marketSessionId = message.snapshot.sessionId;
    }
  }

  private withMarketAuthority(message: SmokeClientMessage): ClientMessage {
    if (message.type === "MARKET_OPEN") {
      return {
        ...message,
        marketStructureId: SMOKE_MARKET_STRUCTURE_ID,
        expectedPlacementRevision: "1"
      };
    }
    if (
      message.type === "MARKET_GET_BOOK" ||
      message.type === "MARKET_REQUEST_QUOTE" ||
      message.type === "MARKET_CREATE_ORDER" ||
      message.type === "MARKET_SIMPLE_BUY" ||
      message.type === "MARKET_CANCEL_ORDER" ||
      message.type === "MARKET_CLAIM" ||
      message.type === "MARKET_CREATE_EQUIPMENT_LISTING" ||
      message.type === "MARKET_PURCHASE_EQUIPMENT_LISTING" ||
      message.type === "MARKET_CANCEL_EQUIPMENT_LISTING" ||
      message.type === "MARKET_SET_SUBSCRIPTIONS"
    ) {
      if (!this.marketSessionId) {
        throw new Error(`Socket ${this.role} has no physical City Market session`);
      }
      return { ...message, marketSessionId: this.marketSessionId } as ClientMessage;
    }
    return message as ClientMessage;
  }

  private waitFor(
    predicate: (message: ServerMessage) => boolean,
    requestId: string | null
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const waiter: PendingMessage = {
        predicate,
        requestId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(waiter);
          reject(new Error(`Timed out waiting for ${this.role} response${requestId ? ` ${requestId}` : ""}`));
        }, RESPONSE_TIMEOUT_MS)
      };
      this.pending.add(waiter);
    });
  }

  private receive(raw: string): void {
    const message = JSON.parse(raw) as ServerMessage;
    this.receivedAt.set(message, performance.now());
    this.messages.push(message);
    for (const waiter of this.pending) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.pending.delete(waiter);
        waiter.resolve(message);
        return;
      }
      if (
        waiter.requestId &&
        ((message.type === "MARKET_ERROR" && message.requestId === waiter.requestId) ||
          (message.type === "ERROR" && message.requestId === waiter.requestId))
      ) {
        clearTimeout(waiter.timer);
        this.pending.delete(waiter);
        waiter.reject(new Error(`${message.type}:${message.code}:${message.message}`));
        return;
      }
    }
  }

  private arrivalTime(message: ServerMessage): number {
    const receivedAt = this.receivedAt.get(message);
    if (receivedAt === undefined) throw new Error(`Missing ${this.role} message arrival timestamp`);
    return receivedAt;
  }
}

class MarketUpdateLatencyRecorder {
  private readonly observations: MarketUpdateLatencyObservation[] = [];

  record(observation: MarketUpdateLatencyObservation): void {
    if (!Number.isFinite(observation.sendToNotificationMs) || observation.sendToNotificationMs < 0) {
      throw new Error("Market update latency observation must be finite and nonnegative");
    }
    if (this.observations.length >= MARKET_UPDATE_LATENCY_SAMPLE_LIMIT) {
      throw new Error(`Market update latency sample limit ${MARKET_UPDATE_LATENCY_SAMPLE_LIMIT} exceeded`);
    }
    this.observations.push(observation);
  }

  summary(): MarketUpdateLatencySummary {
    if (this.observations.length === 0) {
      throw new Error("Authenticated smoke recorded no market update latency samples");
    }
    const sorted = this.observations
      .map((observation) => observation.sendToNotificationMs)
      .sort((left, right) => left - right);
    return {
      metric: "request_send_to_committed_book_notification",
      observer: "subscribed_non_actor_websocket",
      clock: "performance.now",
      includes: "transaction_commit_publish_and_websocket_delivery",
      sampleLimit: MARKET_UPDATE_LATENCY_SAMPLE_LIMIT,
      count: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      maxMs: rounded(sorted.at(-1)!),
      notificationBeforeResultCount: this.countOrdering("notification_before_result"),
      resultBeforeNotificationCount: this.countOrdering("result_before_notification"),
      sameTimestampCount: this.countOrdering("same_timestamp")
    };
  }

  private countOrdering(ordering: MarketUpdateLatencyObservation["ordering"]): number {
    return this.observations.filter((observation) => observation.ordering === ordering).length;
  }
}

export function resolveAuthenticatedMarketSmokeMode(
  env: NodeJS.ProcessEnv
): AuthenticatedMarketSmokeMode {
  const runtimeWsUrl = env.MARKET_SMOKE_RUNTIME_WS_URL?.trim();
  const keepDatabase = env.MARKET_SMOKE_KEEP_DB?.trim().toLowerCase() === "true";
  if (!runtimeWsUrl) {
    const databaseUrl = env.MARKET_SMOKE_DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
    return {
      boundary: "in-process-fastify-websocket",
      databaseUrl,
      databaseName: assertValidationDatabase(databaseUrl),
      keepDatabase,
      runtimeWsUrl: null
    };
  }

  if (!keepDatabase) {
    throw new Error(
      "External authenticated market smoke requires MARKET_SMOKE_KEEP_DB=true"
    );
  }
  const databaseUrl = env.MARKET_SMOKE_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "External authenticated market smoke requires an explicit MARKET_SMOKE_DATABASE_URL"
    );
  }
  const databaseName = assertExternalRuntimeDatabase(databaseUrl);
  return {
    boundary: "launched-network-websocket",
    databaseUrl,
    databaseName,
    keepDatabase: true,
    runtimeWsUrl: assertExternalRuntimeWebSocket(runtimeWsUrl)
  };
}

export async function runAuthenticatedMarketSmoke(
  env: NodeJS.ProcessEnv = process.env
): Promise<SmokeReport> {
  const startedAt = performance.now();
  const mode = resolveAuthenticatedMarketSmokeMode(env);
  const { databaseUrl, databaseName, keepDatabase } = mode;
  const assertions: string[] = [];
  let pool: pg.Pool | null = null;
  let app: FastifyInstance | null = null;
  let runtime: Awaited<ReturnType<typeof createSmokeRuntime>> | null = null;
  let sockets: SmokeWebSocket[] = [];
  let report: SmokeReport | null = null;
  let readOnlyControlEngaged = false;

  if (mode.boundary === "in-process-fastify-websocket") {
    await recreateValidationDatabase(databaseUrl);
  } else {
    await assertLaunchedRuntimeReady();
  }
  try {
    if (mode.boundary === "in-process-fastify-websocket") {
      await runMigrations(databaseUrl);
    }
    pool = new Pool({ connectionString: databaseUrl, max: 32 });
    const runKey = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
    const baseConfig = smokeConfig(
      databaseUrl,
      mode.boundary === "launched-network-websocket"
        ? {
            ...env,
            CLIENT_ORIGIN: EXTERNAL_RUNTIME_CLIENT_ORIGIN,
            APP_PUBLIC_ORIGIN: EXTERNAL_RUNTIME_CLIENT_ORIGIN,
            AUTH_ALLOWED_ORIGINS: EXTERNAL_RUNTIME_CLIENT_ORIGIN
          }
        : env
    );
    const identities = await createSmokeIdentities(pool, baseConfig, runKey);
    assert(identities.length === 3, "three authenticated identities were created", assertions);
    assert(
      new Set(identities.map((identity) => identity.actor.accountId)).size === 3,
      "authenticated accounts are distinct",
      assertions
    );
    assert(
      new Set(identities.map((identity) => identity.rawSessionToken)).size === 3,
      "authenticated sessions are distinct",
      assertions
    );
    await seedAuditedAssets(pool, identities, runKey);
    await seedSmokeCityMarket(pool, identities[0]!, baseConfig);

    let connectionTarget: SmokeConnectionTarget;
    if (mode.boundary === "in-process-fastify-websocket") {
      runtime = await createSmokeRuntime(pool, baseConfig);
      app = runtime.app;
      connectionTarget = { kind: "in_process", app };
    } else {
      connectionTarget = {
        kind: "launched_network",
        runtimeWsUrl: mode.runtimeWsUrl
      };
    }
    const clients = new Map<SmokeIdentity["role"], SmokeWebSocket>();
    for (const identity of identities) {
      const client = await connect(connectionTarget, baseConfig, identity);
      clients.set(identity.role, client);
      sockets.push(client);
    }
    const seller = requireClient(clients, "seller");
    const buyerOne = requireClient(clients, "buyerOne");
    const buyerTwo = requireClient(clients, "buyerTwo");
    const updateLatency = new MarketUpdateLatencyRecorder();
    const sellerOpen = await seller.request({
      type: "MARKET_OPEN",
      requestId: "smoke-open-seller-001",
      search: "ore",
      limit: 10
    }, "MARKET_OPEN_RESULT");
    await buyerTwo.request({
      type: "MARKET_OPEN",
      requestId: "smoke-open-buyer-two-001",
      search: "ore"
    }, "MARKET_OPEN_RESULT");
    await Promise.all([seller, buyerTwo].map((socket) => socket.request({
      type: "MARKET_SET_SUBSCRIPTIONS",
      requestId: `subscribe-${socket.role}-001`,
      visibleItemIds: ["ore"],
      focusedItemId: "ore",
      privateState: true,
      revision: 1
    }, "MARKET_SUBSCRIPTIONS_SET")));
    assert(
      sellerOpen.snapshot.items.some((item) => item.itemId === "ore"),
      "server-side market search returns authoritative ore summary",
      assertions
    );
    const emptyBook = await seller.request({
      type: "MARKET_GET_BOOK",
      requestId: "smoke-book-empty-001",
      itemId: "ore",
      depth: 10
    }, "MARKET_BOOK_RESULT");
    assert(emptyBook.book.asks.length === 0, "initial ore book is empty", assertions);

    const ask = await measuredMutation(seller, buyerTwo, {
      type: "MARKET_CREATE_ORDER",
      requestId: "smoke-sell-simple-001",
      interface: "simple",
      side: "sell",
      itemId: "ore",
      quantity: "10",
      unitPrice: "8"
    }, updateLatency);
    assert(ask.order?.status === "open", "Simple sell creates a normal open exchange order", assertions);
    assert(ask.order?.remainingQuantity === "10", "Simple sell escrows the exact quantity", assertions);

    const buyerOpen = await buyerOne.request({
      type: "MARKET_OPEN",
      requestId: "smoke-open-buyer-001",
      search: "ore"
    }, "MARKET_OPEN_RESULT");
    await buyerOne.request({
      type: "MARKET_SET_SUBSCRIPTIONS",
      requestId: "subscribe-buyerOne-001",
      visibleItemIds: ["ore"],
      focusedItemId: "ore",
      privateState: true,
      revision: 1
    }, "MARKET_SUBSCRIPTIONS_SET");
    assert(
      buyerOpen.snapshot.items.find((item) => item.itemId === "ore")?.bestAsk === "8",
      "Simple order is visible through the same buyer exchange summary",
      assertions
    );
    const sharedBook = await buyerOne.request({
      type: "MARKET_GET_BOOK",
      requestId: "smoke-book-shared-001",
      itemId: "ore",
      depth: 10
    }, "MARKET_BOOK_RESULT");
    assertDepth(sharedBook.book, "sell", "8", "10", assertions);

    const restingBid = await measuredMutation(buyerOne, buyerTwo, {
      type: "MARKET_CREATE_ORDER",
      requestId: "smoke-buy-resting-001",
      interface: "merchant",
      side: "buy",
      itemId: "ore",
      quantity: "2",
      unitPrice: "7"
    }, updateLatency);
    assert(restingBid.trades.length === 0, "below-ask Merchant bid rests without matching", assertions);

    const crossingMessage = {
      type: "MARKET_CREATE_ORDER",
      requestId: "smoke-buy-crossing-001",
      interface: "merchant",
      side: "buy",
      itemId: "ore",
      quantity: "4",
      unitPrice: "10"
    } satisfies SmokeClientMessage;
    const crossing = await measuredMutation(buyerOne, buyerTwo, crossingMessage, updateLatency);
    assert(crossing.trades.length === 1, "crossing Merchant bid records one fill", assertions);
    assert(crossing.trades[0]?.unitPrice === "8", "crossing fill uses resting maker price", assertions);
    assert(crossing.trades[0]?.quantity === "4", "crossing fill settles exact partial quantity", assertions);
    const partialBook = await buyerOne.request({
      type: "MARKET_GET_BOOK",
      requestId: "smoke-book-partial-001",
      itemId: "ore",
      depth: 10
    }, "MARKET_BOOK_RESULT");
    assertDepth(partialBook.book, "sell", "8", "6", assertions);
    assertDepth(partialBook.book, "buy", "7", "2", assertions);

    const buyerClaimMessage = {
      type: "MARKET_CLAIM",
      requestId: "smoke-claim-buyer-001",
      scope: "all"
    } satisfies SmokeClientMessage;
    const buyerClaim = mutation(await buyerOne.request(buyerClaimMessage, "MARKET_MUTATION_RESULT"));
    assert(buyerClaim.claimedItems === "4", "buyer claims four purchased units", assertions);
    assert(buyerClaim.claimedGold === "9", "buyer claims exact price-and-tax reserve refund", assertions);
    const sellerGold = mutation(await seller.request({
      type: "MARKET_CLAIM",
      requestId: "smoke-claim-seller-gold-001",
      scope: "gold"
    }, "MARKET_MUTATION_RESULT"));
    assert(sellerGold.claimedGold === "32", "seller claims maker-priced proceeds", assertions);

    const crossingReplay = mutation(
      await buyerOne.request(crossingMessage, "MARKET_MUTATION_RESULT")
    );
    const buyerClaimReplay = mutation(
      await buyerOne.request(buyerClaimMessage, "MARKET_MUTATION_RESULT")
    );
    assert(crossingReplay.replayed, "duplicate create returns durable replay result", assertions);
    assert(buyerClaimReplay.replayed, "duplicate claim returns durable replay result", assertions);

    const cancelAskMessage = {
      type: "MARKET_CANCEL_ORDER",
      requestId: "smoke-cancel-ask-001",
      orderId: requiredOrderId(ask)
    } satisfies SmokeClientMessage;
    const cancelledAsk = await measuredMutation(seller, buyerTwo, cancelAskMessage, updateLatency);
    const cancelledAskReplay = mutation(
      await seller.request(cancelAskMessage, "MARKET_MUTATION_RESULT")
    );
    assert(cancelledAsk.order?.status === "cancelled", "partially filled ask cancels", assertions);
    assert(cancelledAsk.order?.remainingQuantity === "6", "cancel preserves exact unfilled remainder", assertions);
    assert(cancelledAskReplay.replayed, "duplicate cancellation returns durable replay result", assertions);
    const sellerReturnMessage = {
      type: "MARKET_CLAIM",
      requestId: "smoke-claim-seller-return-001",
      scope: "items"
    } satisfies SmokeClientMessage;
    const sellerReturn = mutation(
      await seller.request(sellerReturnMessage, "MARKET_MUTATION_RESULT")
    );
    const sellerReturnReplay = mutation(
      await seller.request(sellerReturnMessage, "MARKET_MUTATION_RESULT")
    );
    assert(sellerReturn.claimedItems === "6", "seller claims exact cancelled escrow return", assertions);
    assert(sellerReturnReplay.replayed, "duplicate return claim does not duplicate items", assertions);

    const cancelledRestingBid = await measuredMutation(buyerOne, buyerTwo, {
      type: "MARKET_CANCEL_ORDER",
      requestId: "smoke-cancel-resting-bid-001",
      orderId: requiredOrderId(restingBid)
    }, updateLatency);
    assert(cancelledRestingBid.order?.status === "cancelled", "resting bid cancels before final-unit race", assertions);
    await buyerOne.request({
      type: "MARKET_CLAIM",
      requestId: "smoke-claim-resting-refund-001",
      scope: "gold"
    }, "MARKET_MUTATION_RESULT");

    await measuredMutation(seller, buyerTwo, {
      type: "MARKET_CREATE_ORDER",
      requestId: "smoke-race-ask-001",
      interface: "merchant",
      side: "sell",
      itemId: "ore",
      quantity: "1",
      unitPrice: "5"
    }, updateLatency);
    const [raceOneMessage, raceTwoMessage] = [
      {
        type: "MARKET_CREATE_ORDER",
        requestId: "smoke-race-buy-one-001",
        interface: "merchant",
        side: "buy",
        itemId: "ore",
        quantity: "1",
        unitPrice: "5"
      },
      {
        type: "MARKET_CREATE_ORDER",
        requestId: "smoke-race-buy-two-001",
        interface: "merchant",
        side: "buy",
        itemId: "ore",
        quantity: "1",
        unitPrice: "5"
      }
    ] as const satisfies readonly SmokeClientMessage[];
    const [raceOne, raceTwo] = await Promise.all([
      buyerOne.request(raceOneMessage, "MARKET_MUTATION_RESULT").then(mutation),
      buyerTwo.request(raceTwoMessage, "MARKET_MUTATION_RESULT").then(mutation)
    ]);
    const racers = [
      { role: "buyerOne" as const, client: buyerOne, result: raceOne },
      { role: "buyerTwo" as const, client: buyerTwo, result: raceTwo }
    ];
    const winners = racers.filter((racer) => racer.result.trades.length === 1);
    const losers = racers.filter((racer) => racer.result.trades.length === 0);
    assert(winners.length === 1, "exactly one buyer wins the final unit", assertions);
    assert(losers.length === 1, "the losing final-unit buyer receives no fill", assertions);
    const winner = winners[0]!;
    const loser = losers[0]!;
    await winner.client.request({
      type: "MARKET_CLAIM",
      requestId: `smoke-race-claim-${winner.role}-001`,
      scope: "all"
    }, "MARKET_MUTATION_RESULT");
    const loserCancel = mutation(await loser.client.request({
      type: "MARKET_CANCEL_ORDER",
      requestId: `smoke-race-cancel-${loser.role}-001`,
      orderId: requiredOrderId(loser.result)
    }, "MARKET_MUTATION_RESULT"));
    await loser.client.request({
      type: "MARKET_CLAIM",
      requestId: `smoke-race-refund-${loser.role}-001`,
      scope: "gold"
    }, "MARKET_MUTATION_RESULT");
    await seller.request({
      type: "MARKET_CLAIM",
      requestId: "smoke-race-seller-proceeds-001",
      scope: "gold"
    }, "MARKET_MUTATION_RESULT");

    await setSmokeGlobalReadOnly(pool, true, "exercise authenticated smoke read-only rejection");
    readOnlyControlEngaged = true;
    const readOnlyError = await seller.request({
      type: "MARKET_CREATE_ORDER",
      requestId: "smoke-read-only-reject-001",
      interface: "simple",
      side: "sell",
      itemId: "ore",
      quantity: "1",
      unitPrice: "9"
    }, "MARKET_ERROR");
    assert(readOnlyError.code === "MARKET_READ_ONLY", "database read-only control rejects mutation", assertions);
    await setSmokeGlobalReadOnly(pool, false, "restore authenticated smoke mutations");
    readOnlyControlEngaged = false;
    const restored = mutation(await seller.request({
      type: "MARKET_CREATE_ORDER",
      requestId: "smoke-read-only-restored-001",
      interface: "simple",
      side: "sell",
      itemId: "ore",
      quantity: "1",
      unitPrice: "9"
    }, "MARKET_MUTATION_RESULT"));
    assert(restored.order?.status === "open", "market creates orders after read-only restoration", assertions);
    await seller.request({
      type: "MARKET_CANCEL_ORDER",
      requestId: "smoke-read-only-cleanup-cancel-001",
      orderId: requiredOrderId(restored)
    }, "MARKET_MUTATION_RESULT");
    await seller.request({
      type: "MARKET_CLAIM",
      requestId: "smoke-read-only-cleanup-claim-001",
      scope: "items"
    }, "MARKET_MUTATION_RESULT");

    buyerOne.terminate();
    sockets = sockets.filter((socket) => socket !== buyerOne);
    if (runtime) {
      await waitForRegistryRemoval(
        runtime.registry,
        identities.find((identity) => identity.role === "buyerOne")!.actor.accountId
      );
    }
    const buyerOneIdentity = identities.find((identity) => identity.role === "buyerOne")!;
    const reconnectedBuyer = await connect(connectionTarget, baseConfig, buyerOneIdentity);
    sockets.push(reconnectedBuyer);
    clients.set("buyerOne", reconnectedBuyer);
    const reconnectOpen = await reconnectedBuyer.request({
      type: "MARKET_OPEN",
      requestId: "smoke-reconnect-open-001",
      search: "ore"
    }, "MARKET_OPEN_RESULT");
    assert(reconnectOpen.snapshot.player.recentFills.length >= 1, "reconnect loads fresh committed fill history", assertions);
    assert(reconnectOpen.snapshot.player.activeOrders.length === 0, "reconnect loads no stale active orders", assertions);
    const finalBook = await reconnectedBuyer.request({
      type: "MARKET_GET_BOOK",
      requestId: "smoke-final-book-001",
      itemId: "ore",
      depth: 10
    }, "MARKET_BOOK_RESULT");
    assert(finalBook.book.asks.length === 0, "final book has no open asks", assertions);
    assert(finalBook.book.bids.length === 0, "final book has no open bids", assertions);

    const reconciliation = await new MarketReconciliationService(pool).reconcile();
    assert(reconciliation.ok, "final whole-market reconciliation succeeds", assertions);
    assert(reconciliation.issues.length === 0, "final reconciliation reports no issues", assertions);
    const databaseCounts = await loadDatabaseCounts(pool);
    const marketUpdateLatency = updateLatency.summary();
    assert(marketUpdateLatency.count === 6, "six sequential committed book updates have latency samples", assertions);
    assert(
      marketUpdateLatency.notificationBeforeResultCount +
        marketUpdateLatency.resultBeforeNotificationCount +
        marketUpdateLatency.sameTimestampCount === marketUpdateLatency.count,
      "market update latency result/notification ordering accounts for every sample",
      assertions
    );

    report = {
      ok: true,
      database: databaseName,
      databaseDropped:
        mode.boundary === "in-process-fastify-websocket" && !keepDatabase,
      boundary: mode.boundary,
      identities: identities.map(({ role, actor, email }) => ({
        role,
        accountId: actor.accountId,
        playerId: actor.playerId,
        email
      })),
      assertions,
      initialFlow: {
        askOrderId: requiredOrderId(ask),
        restingBidOrderId: requiredOrderId(restingBid),
        makerTradePrice: crossing.trades[0]!.unitPrice,
        partialAskRemainder: "6",
        buyerClaimedItems: buyerClaim.claimedItems,
        buyerClaimedGold: buyerClaim.claimedGold,
        sellerClaimedGold: sellerGold.claimedGold,
        cancelledReturn: sellerReturn.claimedItems
      },
      replay: {
        create: crossingReplay.replayed,
        claim: buyerClaimReplay.replayed && sellerReturnReplay.replayed,
        cancel: cancelledAskReplay.replayed
      },
      finalUnitRace: {
        winner: winner.role,
        winnerTradeCount: winner.result.trades.length,
        loserOrderCancelled: loserCancel.order?.status === "cancelled"
      },
      controls: {
        readOnlyRejectionCode: readOnlyError.code,
        restoredOrderCreated: restored.order?.status === "open"
      },
      reconnect: {
        freshSnapshot: true,
        recentFillCount: reconnectOpen.snapshot.player.recentFills.length,
        activeOrderCount: reconnectOpen.snapshot.player.activeOrders.length
      },
      notifications: {
        sellerPrivateRefreshes: seller.count("MARKET_PLAYER_STATE_CHANGED"),
        buyerPrivateRefreshes:
          buyerOne.count("MARKET_PLAYER_STATE_CHANGED") +
          buyerTwo.count("MARKET_PLAYER_STATE_CHANGED") +
          reconnectedBuyer.count("MARKET_PLAYER_STATE_CHANGED"),
        itemSummaryChanges: sockets.reduce(
          (total, socket) => total + socket.count("MARKET_ITEM_SUMMARY_CHANGED"),
          0
        ),
        bookChanges: sockets.reduce(
          (total, socket) => total + socket.count("MARKET_BOOK_CHANGED"),
          0
        ),
        updateLatency: marketUpdateLatency
      },
      reconciliation,
      databaseCounts,
      durationMs: rounded(performance.now() - startedAt)
    };
    return report;
  } finally {
    if (runtime) {
      await runtime.realtime.shutdownConnections().catch(() => undefined);
    } else {
      for (const socket of sockets) socket.terminate();
    }
    if (app) await app.close().catch(() => undefined);
    if (readOnlyControlEngaged && pool) {
      await setSmokeGlobalReadOnly(
        pool,
        false,
        "restore authenticated smoke control after failure"
      ).catch(() => undefined);
    }
    if (pool) await pool.end().catch(() => undefined);
    if (mode.boundary === "in-process-fastify-websocket" && !keepDatabase) {
      await dropValidationDatabase(databaseUrl).catch((error: unknown) => {
        if (report) report.databaseDropped = false;
        throw error;
      });
    }
  }
}

async function setSmokeGlobalReadOnly(
  pool: pg.Pool,
  readOnly: boolean,
  reason: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMarketControlAuditContext(client, {
      operatorIdentity: "market-authenticated-smoke",
      reason
    });
    await client.query(
      "UPDATE market_global_controls SET read_only = $1 WHERE singleton",
      [readOnly]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createSmokeIdentities(
  pool: pg.Pool,
  baseConfig: AppConfig,
  runKey: string
): Promise<SmokeIdentity[]> {
  const roles: Array<{ role: SmokeIdentity["role"]; name: string }> = [
    { role: "seller", name: "SmokeSeller" },
    { role: "buyerOne", name: "SmokeBuyerOne" },
    { role: "buyerTwo", name: "SmokeBuyerTwo" }
  ];
  const logger = createLogger("test");
  const results: SmokeIdentity[] = [];
  for (let index = 0; index < roles.length; index += 1) {
    const definition = roles[index]!;
    const email = `ash.atlas.smoke.${runKey}.${index}@example.com`;
    const config = loadConfig({
      ...process.env,
      ...configEnvironment(baseConfig),
      AUTH_DEV_ACCOUNT_EMAIL: email,
      AUTH_DEV_PLAYER_NAME: definition.name
    });
    const auth = new AuthService(
      config,
      new PostgresAuthStore(pool, config),
      new GoogleAuthLibraryIdentityVerifier(config.GOOGLE_CLIENT_ID),
      logger
    );
    const login = await auth.loginAsDeveloper("default", {
      ip: `127.0.0.${index + 2}`,
      userAgent: `AshAtlasAuthenticatedSmoke/${definition.role}`,
      deviceToken: null,
      existingSessionToken: null
    });
    const playerId = login.session.player?.id ?? crypto.randomUUID();
    if (!login.session.player) {
      const username = `${definition.name}${runKey.slice(-6)}`;
      await pool.query(
        `INSERT INTO players (
           id, account_id, username, username_normalized,
           display_color, personal_flag_color, onboarding_completed_at,
           region_code, lat, lon, anchor_lat, anchor_lon,
           move_leash_radius_m, online, geom,
           initial_spawn_latitude, initial_spawn_longitude,
           initial_spawn_algorithm_version, initial_spawn_land_mask_version,
           initial_spawn_world_identity, initial_spawn_rejected_candidates,
           initial_spawn_assigned_at, initial_spawn_state_code
         ) VALUES (
           $1, $2, $3, lower($3),
           '#38bdf8', 'blue', now(),
           'NM', $4, $5, $4, $5,
           $6, false, ST_SetSRID(ST_MakePoint($5,$4),4326),
           $4, $5, 'authenticated-smoke-v1', 'authenticated-smoke-v1',
           'main', 0, now(), 'NM'
         )`,
        [
          playerId,
          login.session.account.id,
          username,
          config.DEFAULT_SPAWN_LAT,
          config.DEFAULT_SPAWN_LON,
          config.MOVE_LEASH_RADIUS_M
        ]
      );
    }
    results.push({
      role: definition.role,
      actor: {
        playerId,
        accountId: login.session.account.id
      },
      rawSessionToken: login.session.rawToken,
      deviceToken: login.deviceToken,
      email
    });
  }
  return results;
}

async function seedAuditedAssets(
  pool: pg.Pool,
  identities: SmokeIdentity[],
  runKey: string
): Promise<void> {
  const inventory = new InventoryService(pool);
  for (const identity of identities) {
    await seedWallet(pool, identity, 1_000n, runKey);
    await inventory.grantItemsForOperation({
      operationKey: `market-smoke-inventory:${runKey}:${identity.role}`,
      playerId: identity.actor.playerId,
      source: "market_authenticated_smoke_seed",
      sourceEntityType: "market_smoke_run",
      sourceEntityId: runKey,
      metadata: { runKey, role: identity.role },
      grants: [{
        itemId: identity.role === "seller" ? "ore" : "food",
        variant: null,
        quantity: identity.role === "seller" ? 40 : 1
      }]
    });
  }
}

async function seedSmokeCityMarket(
  pool: pg.Pool,
  founder: SmokeIdentity,
  config: AppConfig
): Promise<void> {
  const lat = config.DEFAULT_SPAWN_LAT;
  const lon = config.DEFAULT_SPAWN_LON;
  await pool.query(
    `INSERT INTO flags (
       id, owner_id, name, lat, lon, claim_radius_m, geom
     ) VALUES (
       $1, $2, 'Authenticated Smoke City Center', $3, $4, 1000,
       ST_SetSRID(ST_MakePoint($4,$3),4326)
     )
     ON CONFLICT (id) DO NOTHING`,
    [SMOKE_MARKET_FLAG_ID, founder.actor.playerId, lat, lon]
  );
  await pool.query(
    `INSERT INTO cities (
       id, world_id, canonical_municipality_id, world_settlement_id,
       world_settlement_source, world_source_settlement_id, name, country_code,
       founder_player_id, founding_request_id, seat_flag_id,
       hall_lat, hall_lon, hall_geom, founding_annex_radius_m
     ) VALUES (
       $1, 'main', 'authenticated-smoke-city', 'authenticated-smoke-city',
       'test', 'authenticated-smoke-city', 'Authenticated Smoke City', 'US',
       $2, 'authenticated-smoke-city-found', $3,
       $4, $5, ST_SetSRID(ST_MakePoint($5,$4),4326), 1000
     )
     ON CONFLICT (id) DO NOTHING`,
    [
      SMOKE_MARKET_CITY_ID,
      founder.actor.playerId,
      SMOKE_MARKET_FLAG_ID,
      lat,
      lon
    ]
  );
  await pool.query(
    `UPDATE flags
     SET control_type = 'city_seat',
         city_id = $2,
         city_affiliated_at = coalesce(city_affiliated_at, now()),
         city_affiliated_by_player_id = coalesce(
           city_affiliated_by_player_id,
           original_owner_player_id,
           owner_id
         ),
         original_owner_player_id = coalesce(original_owner_player_id, owner_id),
         contributed_by_player_id = coalesce(contributed_by_player_id, owner_id),
         original_personal_color = coalesce(original_personal_color, '#38bdf8'),
         access_mode = 'public',
         jump_toll_gold = 0
     WHERE id = $1`,
    [SMOKE_MARKET_FLAG_ID, SMOKE_MARKET_CITY_ID]
  );
  await pool.query(
    `INSERT INTO city_structures (
       structure_id, city_id, structure_type, tier, owner_player_id, world_id,
       lat, lon, geom, footprint_geom, footprint_radius_m, state,
       build_operation_key, built_at
     ) VALUES (
       $1, $2, 'market', 1, NULL, 'main',
       $3, $4, ST_SetSRID(ST_MakePoint($4,$3),4326),
       ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,15)::geometry,
       15, 'active', 'authenticated-smoke-city-market', now()
     )
     ON CONFLICT (structure_id) DO NOTHING`,
    [SMOKE_MARKET_STRUCTURE_ID, SMOKE_MARKET_CITY_ID, lat, lon]
  );
  await pool.query(
    `INSERT INTO market_venues (
       venue_id, venue_key, display_name, scope_type, access_policy_id,
       fee_policy_id, active, city_id, market_structure_id, state
     ) VALUES (
       $1, 'authenticated-smoke-city-market', 'Authenticated Smoke City Market',
       'regional', 'physical-city-market-v1', 2, true, $2, $3, 'active'
     )
     ON CONFLICT (venue_id) DO UPDATE
     SET active = true,
         state = 'active'`,
    [SMOKE_MARKET_VENUE_ID, SMOKE_MARKET_CITY_ID, SMOKE_MARKET_STRUCTURE_ID]
  );
  await pool.query(
    `INSERT INTO market_venue_controls (
       venue_id, frozen, new_orders_enabled, matching_enabled,
       cancellations_enabled, claims_enabled
     ) VALUES ($1, false, true, true, true, true)
     ON CONFLICT (venue_id) DO UPDATE
     SET frozen = false,
         new_orders_enabled = true,
         matching_enabled = true,
         cancellations_enabled = true,
         claims_enabled = true,
         updated_at = clock_timestamp()`,
    [SMOKE_MARKET_VENUE_ID]
  );
}

async function seedWallet(
  pool: pg.Pool,
  identity: SmokeIdentity,
  amount: bigint,
  runKey: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
       VALUES ($1,$2,$3,1)`,
      [identity.actor.playerId, identity.actor.accountId, amount.toString()]
    );
    await client.query(
      `INSERT INTO wallet_events (
         operation_key, player_id, account_id, delta_gold, balance_after,
         version_after, reason, metadata
       ) VALUES ($1,$2,$3,$4,$4,1,'market_authenticated_smoke_seed',$5::jsonb)`,
      [
        `market-smoke-wallet:${runKey}:${identity.role}`,
        identity.actor.playerId,
        identity.actor.accountId,
        amount.toString(),
        JSON.stringify({ runKey, role: identity.role })
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createSmokeRuntime(pool: pg.Pool, config: AppConfig) {
  const logger = createLogger("test");
  const registry = new ConnectionRegistry(
    config.WS_BACKPRESSURE_SOFT_BYTES,
    config.WS_BACKPRESSURE_HARD_BYTES,
    config.WS_BACKPRESSURE_MAX_SKIPS
  );
  const auth = new AuthService(
    config,
    new PostgresAuthStore(pool, config),
    new GoogleAuthLibraryIdentityVerifier(config.GOOGLE_CLIENT_ID),
    logger
  );
  const gameState = new GameState(config, logger);
  const players = new PlayerService(pool, config);
  const inventory = new InventoryService(pool);
  const world = new WorldLookupClient(config.WORLD_API_BASE, logger);
  const flags = new FlagService(pool, world, config, logger);
  const market = new MarketService(pool, config, logger, {
    inventory,
    access: new MarketAccessPolicy(config, gameState),
    onCommitted: (event) => {
      void publishMarketCommit(market, registry, event, logger);
    }
  });
  const app = Fastify({ logger: false });
  await app.register(cookie);
  installAuthGuard(app, config, auth);
  const realtime = await registerRealtime({
      infrastructure: {
          app: app,
          registry: registry,
          logger: logger,
          config: config
      },
      authority: {
          gameState: gameState,
          flagService: flags,
          playerService: players,
          auth: auth,
      },
      capabilities: {
          market: market,
          inventory
      }
  });
  await app.ready();
  return { app, registry, market, realtime };
}

export async function connect(
  target: SmokeConnectionTarget,
  config: AppConfig,
  identity: WebSocketMarketIdentity
): Promise<SmokeWebSocket> {
  const cookieHeader = smokeCookieHeader(identity);
  const raw = target.kind === "in_process"
    ? await target.app.injectWS("/ws", {
        headers: {
          origin: config.CLIENT_ORIGIN,
          cookie: cookieHeader
        }
      }) as InjectedSocket
    : await connectNetworkWebSocket(
        target.runtimeWsUrl,
        config.CLIENT_ORIGIN,
        cookieHeader
      );
  const client = new SmokeWebSocket(identity.role, raw as InjectedSocket);
  await client.hello();
  return client;
}

function smokeCookieHeader(identity: WebSocketMarketIdentity): string {
  return `aa_session_dev=${identity.rawSessionToken}; aa_device_dev=${identity.deviceToken}`;
}

async function assertLaunchedRuntimeReady(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);
  try {
    const response = await fetch(EXTERNAL_RUNTIME_READY_URL, {
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const readiness = await response.json() as {
      checks?: { database?: { ok?: boolean } };
    };
    if (readiness.checks?.database?.ok !== true) {
      throw new Error("database readiness is not healthy");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown readiness failure";
    throw new Error(
      `Launched Markets runtime is not ready at ${EXTERNAL_RUNTIME_READY_URL}: ${reason}`
    );
  } finally {
    clearTimeout(timer);
  }
}

async function connectNetworkWebSocket(
  runtimeWsUrl: string,
  origin: string,
  cookie: string
): Promise<InjectedSocket> {
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const candidate = new WebSocket(runtimeWsUrl, {
      headers: {
        Origin: origin,
        Cookie: cookie
      }
    });
    candidate.on("error", () => undefined);
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`Timed out opening launched market WebSocket ${runtimeWsUrl}`));
    }, RESPONSE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      candidate.removeListener("open", opened);
      candidate.removeListener("error", failed);
      candidate.removeListener("unexpected-response", unexpected);
    };
    const opened = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(candidate);
    };
    const failed = (error: Error) => fail(error);
    const unexpected = (
      _request: ClientRequest,
      response: IncomingMessage
    ) => {
      response.resume();
      fail(new Error(
        `Launched market WebSocket upgrade failed with HTTP ${response.statusCode ?? "unknown"}`
      ));
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      candidate.terminate();
      reject(error);
    };
    candidate.once("open", opened);
    candidate.once("error", failed);
    candidate.once("unexpected-response", unexpected);
  });

  return {
    on(_event, handler) {
      socket.on("message", (data) => handler(rawNetworkData(data)));
    },
    send(data) {
      socket.send(data);
    },
    terminate() {
      socket.terminate();
    }
  };
}

function rawNetworkData(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

export function smokeConfig(databaseUrl: string, env: NodeJS.ProcessEnv): AppConfig {
  return loadConfig({
    ...env,
    NODE_ENV: "development",
    AUTH_RUNTIME_MODE: "local",
    AUTH_MODE: "dev",
    AUTH_DEV_LOGIN_ENABLED: "true",
    DATABASE_URL: databaseUrl,
    MARKET_GLOBAL_ACCESS: "true",
    MARKET_MAX_ACTIVE_ORDERS_PER_PLAYER: "100",
    MARKET_MAX_OPEN_ORDERS_PER_ITEM: "100",
    MARKET_REQUESTS_PER_MINUTE: "10000",
    MARKET_CANCELLATIONS_PER_MINUTE: "10000",
    MARKET_TRANSACTION_RETRY_LIMIT: "5",
    AUTH_LOGIN_IP_MAX: "100",
    AUTH_LOGIN_DEVICE_MAX: "100",
    AUTH_NEW_ACCOUNT_DEVICE_MAX: "100",
    AUTH_NEW_ACCOUNT_NETWORK_MAX: "100"
  });
}

function configEnvironment(config: AppConfig): NodeJS.ProcessEnv {
  return {
    NODE_ENV: config.NODE_ENV,
    AUTH_RUNTIME_MODE: config.AUTH_RUNTIME_MODE,
    AUTH_MODE: config.AUTH_MODE,
    AUTH_DEV_LOGIN_ENABLED: String(config.AUTH_DEV_LOGIN_ENABLED),
    DATABASE_URL: config.DATABASE_URL,
    CLIENT_ORIGIN: config.CLIENT_ORIGIN,
    APP_PUBLIC_ORIGIN: config.APP_PUBLIC_ORIGIN,
    AUTH_ALLOWED_ORIGINS: config.AUTH_ALLOWED_ORIGINS.join(","),
    AUTH_SESSION_TOKEN_HMAC_KEY: config.AUTH_SESSION_TOKEN_HMAC_KEY,
    AUTH_DEVICE_TOKEN_HMAC_KEY: config.AUTH_DEVICE_TOKEN_HMAC_KEY,
    AUTH_NETWORK_HMAC_KEY: config.AUTH_NETWORK_HMAC_KEY,
    AUTH_NETWORK_HMAC_KEY_VERSION: config.AUTH_NETWORK_HMAC_KEY_VERSION,
    MARKET_GLOBAL_ACCESS: String(config.MARKET_GLOBAL_ACCESS),
    MARKET_MAX_ACTIVE_ORDERS_PER_PLAYER: String(config.MARKET_MAX_ACTIVE_ORDERS_PER_PLAYER),
    MARKET_MAX_OPEN_ORDERS_PER_ITEM: String(config.MARKET_MAX_OPEN_ORDERS_PER_ITEM),
    MARKET_REQUESTS_PER_MINUTE: String(config.MARKET_REQUESTS_PER_MINUTE),
    MARKET_CANCELLATIONS_PER_MINUTE: String(config.MARKET_CANCELLATIONS_PER_MINUTE),
    MARKET_TRANSACTION_RETRY_LIMIT: String(config.MARKET_TRANSACTION_RETRY_LIMIT),
    AUTH_LOGIN_IP_MAX: String(config.AUTH_LOGIN_IP_MAX),
    AUTH_LOGIN_DEVICE_MAX: String(config.AUTH_LOGIN_DEVICE_MAX),
    AUTH_NEW_ACCOUNT_DEVICE_MAX: String(config.AUTH_NEW_ACCOUNT_DEVICE_MAX),
    AUTH_NEW_ACCOUNT_NETWORK_MAX: String(config.AUTH_NEW_ACCOUNT_NETWORK_MAX)
  };
}

export async function recreateValidationDatabase(databaseUrl: string): Promise<void> {
  const databaseName = assertValidationDatabase(databaseUrl);
  const admin = new Pool({ connectionString: adminDatabaseUrl(databaseUrl), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await admin.end();
  }
}

export async function dropValidationDatabase(databaseUrl: string): Promise<void> {
  const databaseName = assertValidationDatabase(databaseUrl);
  const admin = new Pool({ connectionString: adminDatabaseUrl(databaseUrl), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

function assertExternalRuntimeDatabase(
  databaseUrl: string
): typeof EXTERNAL_RUNTIME_DATABASE_NAME {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("MARKET_SMOKE_DATABASE_URL must be a valid PostgreSQL URL");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "55432" ||
    databaseName !== EXTERNAL_RUNTIME_DATABASE_NAME ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "External authenticated market smoke requires the local PostgreSQL database " +
        `'${EXTERNAL_RUNTIME_DATABASE_NAME}' on 127.0.0.1:55432 exactly`
    );
  }
  return EXTERNAL_RUNTIME_DATABASE_NAME;
}

function assertExternalRuntimeWebSocket(
  runtimeWsUrl: string
): typeof EXTERNAL_RUNTIME_WS_URL {
  let parsed: URL;
  try {
    parsed = new URL(runtimeWsUrl);
  } catch {
    throw new Error("MARKET_SMOKE_RUNTIME_WS_URL must be a valid WebSocket URL");
  }
  if (
    parsed.protocol !== "ws:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "3011" ||
    parsed.pathname !== "/ws" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `External authenticated market smoke requires MARKET_SMOKE_RUNTIME_WS_URL=${EXTERNAL_RUNTIME_WS_URL}`
    );
  }
  return EXTERNAL_RUNTIME_WS_URL;
}

function assertValidationDatabase(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("MARKET_SMOKE_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("MARKET_SMOKE_DATABASE_URL must use PostgreSQL");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^[a-z0-9_]+_validation$/i.test(databaseName)) {
    throw new Error(
      `Refusing authenticated market smoke against '${databaseName}'; database must end in _validation`
    );
  }
  return databaseName;
}

function adminDatabaseUrl(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = "/postgres";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function mutation(
  response: Extract<ServerMessage, { type: "MARKET_MUTATION_RESULT" }>
): MarketMutationResult {
  return response.result;
}

async function measuredMutation(
  actor: SmokeWebSocket,
  observer: SmokeWebSocket,
  message: Extract<
    SmokeClientMessage,
    { type: "MARKET_CREATE_ORDER" | "MARKET_CANCEL_ORDER" }
  >,
  recorder: MarketUpdateLatencyRecorder
): Promise<MarketMutationResult> {
  const measured = await actor.mutationWithBookNotification(message, observer, "ore");
  recorder.record(measured.observation);
  return mutation(measured.response);
}

function requiredOrderId(result: MarketMutationResult): string {
  if (!result.order?.orderId) throw new Error(`Market result ${result.requestId} has no order`);
  return result.order.orderId;
}

function assertDepth(
  book: MarketBookSnapshot,
  side: "buy" | "sell",
  price: string,
  quantity: string,
  assertions: string[]
): void {
  const levels = side === "sell" ? book.asks : book.bids;
  assert(
    levels.some((level) => level.unitPrice === price && level.quantity === quantity),
    `${side} depth contains ${quantity} units at ${price}`,
    assertions
  );
}

function assert(condition: unknown, description: string, assertions: string[]): asserts condition {
  if (!condition) throw new Error(`Smoke assertion failed: ${description}`);
  assertions.push(description);
}

function requireClient(
  clients: Map<SmokeIdentity["role"], SmokeWebSocket>,
  role: SmokeIdentity["role"]
): SmokeWebSocket {
  const client = clients.get(role);
  if (!client) throw new Error(`Missing smoke client ${role}`);
  return client;
}

async function waitForRegistryRemoval(registry: ConnectionRegistry, accountId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!registry.activeConnectionIdForAccount(accountId)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for account ${accountId} socket cleanup`);
}

async function loadDatabaseCounts(pool: pg.Pool): Promise<SmokeReport["databaseCounts"]> {
  const result = await pool.query<{
    accounts: string;
    sessions: string;
    orders: string;
    trades: string;
    claims: string;
    ledger_groups: string;
    wallet_events: string;
    inventory_events: string;
  }>(
    `SELECT
       (SELECT count(*) FROM accounts)::text AS accounts,
       (SELECT count(*) FROM auth_sessions)::text AS sessions,
       (SELECT count(*) FROM market_orders)::text AS orders,
       (SELECT count(*) FROM market_trades)::text AS trades,
       (SELECT count(*) FROM market_claims)::text AS claims,
       (SELECT count(*) FROM market_ledger_groups)::text AS ledger_groups,
       (SELECT count(*) FROM wallet_events)::text AS wallet_events,
       (SELECT count(*) FROM inventory_events)::text AS inventory_events`
  );
  const row = result.rows[0];
  if (!row) throw new Error("Smoke database counts returned no row");
  return {
    accounts: Number(row.accounts),
    sessions: Number(row.sessions),
    orders: Number(row.orders),
    trades: Number(row.trades),
    claims: Number(row.claims),
    ledgerGroups: Number(row.ledger_groups),
    walletEvents: Number(row.wallet_events),
    inventoryEvents: Number(row.inventory_events)
  };
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) throw new Error("Cannot calculate a percentile without samples");
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return rounded(sorted[index]!);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAuthenticatedMarketSmoke()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown authenticated market smoke failure",
        stack: error instanceof Error ? error.stack : undefined
      }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
