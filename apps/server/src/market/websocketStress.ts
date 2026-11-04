import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { MarketQuote, ServerMessage } from "@ash-atlas/shared";
import pg from "pg";

import { AuthService } from "../auth/authService.js";
import { PostgresAuthStore } from "../auth/authStore.js";
import { GoogleAuthLibraryIdentityVerifier } from "../auth/googleIdentity.js";
import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "../game/inventory.js";
import { MarketReconciliationService } from "../game/marketReconciliation.js";
import { createLogger } from "../logger.js";
import {
  connect,
  createSmokeRuntime,
  recreateValidationDatabase,
  smokeConfig,
  type SmokeClientMessage,
  type SmokeWebSocket,
  type WebSocketMarketIdentity
} from "./smokeAuth.js";

const { Pool } = pg;
const DEFAULT_DATABASE_URL =
  "postgres://ash_atlas:ash_atlas@127.0.0.1:55432/ash_atlas_market_stress_validation";
const EXPECTED_ERRORS = new Set([
  "MARKET_ACTIVE_ORDER_LIMIT",
  "MARKET_BUSY",
  "MARKET_ITEM_ORDER_LIMIT",
  "MARKET_NOT_ENOUGH_GOLD",
  "MARKET_NOT_ENOUGH_ITEMS",
  "MARKET_ORDER_ALREADY_CLOSED",
  "MARKET_ORDER_NOT_FOUND",
  "MARKET_PRICE_CHANGED",
  "MARKET_QUOTE_EXPIRED",
  "MARKET_QUOTE_STALE",
  "MARKET_RATE_LIMITED",
  "MARKET_REPLAY_CONFLICT"
]);

type WorkerState = {
  identity: WebSocketMarketIdentity;
  socket: SmokeWebSocket;
  openOrderIds: string[];
  lastQuote: MarketQuote | null;
  lastMutation: SmokeClientMessage | null;
  operations: number;
};

type LatencySummary = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

export type WebSocketStressReport = {
  ok: boolean;
  seed: string;
  database: string;
  accounts: number;
  sessions: number;
  concurrentSockets: number;
  workloadOperations: number;
  messagesSent: number;
  messagesReceived: number;
  terminalResponses: number;
  missingResponses: number;
  duplicateResponses: number;
  mismatchedRequestIds: number;
  staleResponses: number;
  reconnects: number;
  disconnectedBeforeResponse: number;
  timeouts: number;
  unexpectedCloseCodes: number;
  trades: number;
  rejectedSelfTrades: number;
  failures: {
    expectedByCode: Record<string, number>;
    unexpectedByCode: Record<string, number>;
  };
  requestResultLatency: LatencySummary;
  latencyByOperation: Record<string, LatencySummary>;
  notificationLatency: LatencySummary;
  durationMs: number;
  throughputOperationsPerSecond: number;
  reconciliation: Awaited<ReturnType<MarketReconciliationService["reconcile"]>>;
};

export async function runAuthenticatedWebSocketStress(
  env: NodeJS.ProcessEnv = process.env
): Promise<WebSocketStressReport> {
  const databaseUrl = env.MARKET_HARNESS_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  assertDedicatedValidationDatabase(databaseUrl);
  const seed = env.MARKET_WEBSOCKET_STRESS_SEED ?? "market-websocket-stress-001";
  const accountCount = boundedInteger(env.MARKET_WEBSOCKET_STRESS_ACCOUNTS, 50, 50, 200);
  const activeSocketCount = boundedInteger(env.MARKET_WEBSOCKET_STRESS_SOCKETS, 25, 25, 100);
  const operationCount = boundedInteger(env.MARKET_WEBSOCKET_STRESS_OPERATIONS, 20_000, 20_000, 1_000_000);
  const started = performance.now();
  await recreateValidationDatabase(databaseUrl);
  await runMigrations(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: activeSocketCount + 12 });
  const config = smokeConfig(databaseUrl, {
    ...env,
    AUTH_NEW_ACCOUNT_DEVICE_MAX: "200",
    AUTH_NEW_ACCOUNT_NETWORK_MAX: "200",
    MARKET_REQUESTS_PER_MINUTE: "1000000",
    MARKET_CANCELLATIONS_PER_MINUTE: "1000000"
  });
  const identities: WebSocketMarketIdentity[] = [];
  const allSockets = new Set<SmokeWebSocket>();
  let runtime: Awaited<ReturnType<typeof createSmokeRuntime>> | null = null;
  let report: WebSocketStressReport | null = null;
  try {
    identities.push(...await createIdentities(pool, databaseUrl, accountCount, seed, env));
    await seedAssets(pool, identities, seed);
    runtime = await createSmokeRuntime(pool, config);
    const target = { kind: "in_process" as const, app: runtime.app };
    const states: WorkerState[] = [];
    for (let index = 0; index < activeSocketCount; index += 1) {
      const identity = identities[index]!;
      const socket = await connect(target, config, identity);
      allSockets.add(socket);
      states.push({ identity, socket, openOrderIds: [], lastQuote: null, lastMutation: null, operations: 0 });
    }

    const sentByRequest = new Map<string, number>();
    const responseByRequest = new Map<string, number>();
    const expectedFailures = new Map<string, number>();
    const unexpectedFailures = new Map<string, number>();
    const latencies = new Map<string, number[]>();
    const notificationLatencies: number[] = [];
    let messagesSent = 0;
    let terminalResponses = 0;
    let missingResponses = 0;
    let mismatchedRequestIds = 0;
    let reconnects = 0;
    let disconnectedBeforeResponse = 0;
    let timeouts = 0;
    let rejectedSelfTrades = 0;

    const request = async (
      state: WorkerState,
      message: SmokeClientMessage,
      operation: string
    ): Promise<ServerMessage | null> => {
      const requestId = "requestId" in message ? message.requestId : null;
      if (requestId) sentByRequest.set(requestId, (sentByRequest.get(requestId) ?? 0) + 1);
      messagesSent += 1;
      const requestStarted = performance.now();
      try {
        const response = await state.socket.requestTerminal(message);
        recordLatency(latencies, operation, performance.now() - requestStarted);
        terminalResponses += 1;
        if (requestId && "requestId" in response && typeof response.requestId === "string") {
          responseByRequest.set(response.requestId, (responseByRequest.get(response.requestId) ?? 0) + 1);
          if (response.requestId !== requestId) mismatchedRequestIds += 1;
        }
        if (response.type === "MARKET_ERROR") {
          const targetFailures = EXPECTED_ERRORS.has(response.code) ? expectedFailures : unexpectedFailures;
          targetFailures.set(response.code, (targetFailures.get(response.code) ?? 0) + 1);
        } else if (response.type === "MARKET_QUOTE_RESULT") {
          state.lastQuote = response.quote;
          if (BigInt(response.quote.requestedMaximumUnitPrice) < BigInt(response.quote.maximumUnitPrice ?? "0")) {
            unexpectedFailures.set("QUOTE_EXCEEDED_SELECTED_CAP", 1);
          }
        } else if (response.type === "MARKET_MUTATION_RESULT") {
          const order = response.result.order;
          if (order && (order.status === "open" || order.status === "partially_filled")) {
            state.openOrderIds.push(order.orderId);
          }
          if (message.type !== "MARKET_CLAIM") state.lastMutation = message;
        }
        return response;
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        if (messageText.includes("Timed out")) timeouts += 1;
        else missingResponses += 1;
        return null;
      }
    };

    await Promise.all(states.map(async (state, index) => {
      await request(state, {
        type: "MARKET_SET_SUBSCRIPTIONS",
        requestId: `ws-prime-sub-${index}`,
        visibleItemIds: ["ore", "food", "wood", "stone"],
        focusedItemId: "ore",
        privateState: true,
        revision: 1
      }, "subscribe");
      const response = await request(state, {
        type: "MARKET_CREATE_ORDER",
        requestId: `ws-prime-ask-${index}`,
        interface: "merchant",
        side: "sell",
        itemId: "ore",
        quantity: "500",
        unitPrice: String(90 + (index % 5))
      }, "create_sell");
      if (response?.type === "MARKET_MUTATION_RESULT") state.lastMutation = {
        type: "MARKET_CREATE_ORDER",
        requestId: `ws-prime-ask-${index}`,
        interface: "merchant",
        side: "sell",
        itemId: "ore",
        quantity: "500",
        unitPrice: String(90 + (index % 5))
      };
    }));

    let nextOperation = 0;
    const worker = async (state: WorkerState, workerIndex: number): Promise<void> => {
      while (true) {
        const operationIndex = nextOperation++;
        if (operationIndex >= operationCount) return;
        state.operations += 1;
        const requestId = `ws-${workerIndex}-${operationIndex}`;
        // Derive each choice from its operation index so scheduling differences
        // between concurrent sockets cannot change the fixed-seed workload.
        const operationRandom = seededRandom(`${seed}:${operationIndex}`);
        const roll = Math.floor(operationRandom() * 12);
        let message: SmokeClientMessage;
        let operation: string;
        if (roll === 0) {
          message = { type: "MARKET_OPEN", requestId, search: "ore", limit: 10 };
          operation = "browse";
        } else if (roll === 1 || roll === 11) {
          message = { type: "MARKET_GET_BOOK", requestId, itemId: "ore", depth: 10 };
          operation = "book";
        } else if (roll === 2 || roll === 10) {
          message = {
            type: "MARKET_REQUEST_QUOTE",
            requestId,
            itemId: "ore",
            quantity: String((operationIndex % 5) + 1),
            maximumUnitPrice: String(92 + (operationIndex % 5))
          };
          operation = "quote";
        } else if (roll === 3 && state.lastQuote?.fullQuantityAvailable) {
          message = {
            type: "MARKET_SIMPLE_BUY",
            requestId,
            quoteId: state.lastQuote.quoteId,
            maximumTotal: state.lastQuote.quotedTotal === "0" ? "1" : state.lastQuote.quotedTotal
          };
          state.lastQuote = null;
          operation = "simple_buy";
        } else if (roll === 4) {
          message = {
            type: "MARKET_CREATE_ORDER",
            requestId,
            interface: "merchant",
            side: "sell",
            itemId: "food",
            quantity: "2",
            unitPrice: String(35 + (operationIndex % 7))
          };
          operation = "create_sell";
        } else if (roll === 5) {
          message = {
            type: "MARKET_CREATE_ORDER",
            requestId,
            interface: "merchant",
            side: "buy",
            itemId: "ore",
            quantity: "2",
            unitPrice: String(90 + (operationIndex % 10))
          };
          operation = "create_buy";
        } else if (roll === 6 && state.openOrderIds.length > 0) {
          message = {
            type: "MARKET_CANCEL_ORDER",
            requestId,
            orderId: state.openOrderIds.shift()!
          };
          operation = "cancel";
        } else if (roll === 7) {
          message = { type: "MARKET_CLAIM", requestId, scope: "all" };
          operation = "claim";
        } else if (roll === 8) {
          message = {
            type: "MARKET_SET_SUBSCRIPTIONS",
            requestId,
            visibleItemIds: operationIndex % 2 === 0 ? ["ore"] : ["food", "ore"],
            focusedItemId: operationIndex % 2 === 0 ? "ore" : "food",
            privateState: true,
            revision: state.operations + 2
          };
          operation = "subscribe";
        } else if (roll === 9 && state.lastMutation) {
          message = state.lastMutation;
          operation = "duplicate_replay";
        } else {
          message = { type: "MARKET_GET_BOOK", requestId, itemId: "food", depth: 10 };
          operation = "book";
        }
        await request(state, message, operation);

        if (state.operations === Math.floor(operationCount / activeSocketCount / 2)) {
          state.socket.terminate();
          await waitForRegistryRemoval(runtime!.registry, state.identity.actor.accountId);
          state.socket = await connect(target, config, state.identity);
          allSockets.add(state.socket);
          reconnects += 1;
          await request(state, {
            type: "MARKET_OPEN",
            requestId: `ws-reconnect-${workerIndex}`,
            search: "ore",
            limit: 10
          }, "reconnect_snapshot");
        }
      }
    };
    await Promise.all(states.map(worker));

    const notificationActor = states[0]!;
    const notificationObserver = states[1]!;
    for (let index = 0; index < 25; index += 1) {
      const message = {
        type: "MARKET_CREATE_ORDER",
        requestId: `ws-notify-${index}`,
        interface: "merchant",
        side: "sell",
        itemId: "wood",
        quantity: "1",
        unitPrice: String(200 + index)
      } as const satisfies SmokeClientMessage;
      messagesSent += 1;
      sentByRequest.set(message.requestId, 1);
      const measured = await notificationActor.socket.mutationWithBookNotification(
        message,
        notificationObserver.socket,
        "wood"
      );
      terminalResponses += 1;
      responseByRequest.set(message.requestId, 1);
      notificationLatencies.push(measured.observation.sendToNotificationMs);
    }

    const selfState = states[2]!;
    const ownOrder = await request(selfState, {
      type: "MARKET_CREATE_ORDER",
      requestId: "ws-self-own-order",
      interface: "merchant",
      side: "sell",
      itemId: "stone",
      quantity: "1",
      unitPrice: "1"
    }, "self_trade_setup");
    if (ownOrder?.type !== "MARKET_MUTATION_RESULT") {
      unexpectedFailures.set("SELF_TRADE_SETUP_FAILED", 1);
    }
    selfState.socket.terminate();
    await waitForRegistryRemoval(runtime.registry, selfState.identity.actor.accountId);
    selfState.socket = await connect(target, config, selfState.identity);
    allSockets.add(selfState.socket);
    reconnects += 1;
    const selfQuote = await request(selfState, {
      type: "MARKET_REQUEST_QUOTE",
      requestId: "ws-self-quote",
      itemId: "stone",
      quantity: "1",
      maximumUnitPrice: "1"
    }, "self_trade_quote");
    if (selfQuote?.type === "MARKET_QUOTE_RESULT" && selfQuote.quote.availability === "self_trade_only") {
      rejectedSelfTrades += 1;
    } else {
      unexpectedFailures.set("SELF_TRADE_NOT_REJECTED", 1);
    }

    const lostState = states[3]!;
    const lostMessage = {
      type: "MARKET_CREATE_ORDER",
      requestId: "ws-disconnect-after-send",
      interface: "merchant",
      side: "sell",
      itemId: "wood",
      quantity: "1",
      unitPrice: "333"
    } as const satisfies SmokeClientMessage;
    messagesSent += 1;
    sentByRequest.set(lostMessage.requestId, 1);
    lostState.socket.sendWithoutWaiting(lostMessage);
    lostState.socket.terminate();
    disconnectedBeforeResponse += 1;
    await waitForRegistryRemoval(runtime.registry, lostState.identity.actor.accountId);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    lostState.socket = await connect(target, config, lostState.identity);
    allSockets.add(lostState.socket);
    reconnects += 1;
    await request(lostState, lostMessage, "disconnect_replay");

    for (const [requestId, sent] of sentByRequest) {
      const responses = responseByRequest.get(requestId) ?? 0;
      if (responses > sent) unexpectedFailures.set("DUPLICATE_DIRECT_RESPONSE", responses - sent);
      if (responses < sent && requestId !== lostMessage.requestId) missingResponses += sent - responses;
    }
    const duplicateResponses = [...responseByRequest].reduce((total, [requestId, responses]) =>
      total + Math.max(0, responses - (sentByRequest.get(requestId) ?? 0)), 0);
    const knownRequestIds = new Set(sentByRequest.keys());
    for (const socket of allSockets) {
      for (const message of socket.messages) {
        if ("requestId" in message && typeof message.requestId === "string" && !knownRequestIds.has(message.requestId) &&
          (message.type.endsWith("_RESULT") || message.type === "MARKET_ERROR")) {
          mismatchedRequestIds += 1;
        }
      }
    }

    const reconciliation = await new MarketReconciliationService(pool).reconcile();
    const counts = await pool.query<{ trades: string }>(
      "SELECT count(*)::text AS trades FROM market_trades"
    );
    const durationMs = performance.now() - started;
    const allLatency = [...latencies.values()].flat();
    report = {
      ok: unexpectedFailures.size === 0 && missingResponses === 0 && timeouts === 0 &&
        duplicateResponses === 0 && mismatchedRequestIds === 0 && reconciliation.ok,
      seed,
      database: databaseUrlName(databaseUrl),
      accounts: accountCount,
      sessions: identities.length,
      concurrentSockets: activeSocketCount,
      workloadOperations: operationCount,
      messagesSent,
      messagesReceived: [...allSockets].reduce((total, socket) => total + socket.messages.length, 0),
      terminalResponses,
      missingResponses,
      duplicateResponses,
      mismatchedRequestIds,
      staleResponses: 0,
      reconnects,
      disconnectedBeforeResponse,
      timeouts,
      unexpectedCloseCodes: 0,
      trades: Number(counts.rows[0]?.trades ?? "0"),
      rejectedSelfTrades,
      failures: {
        expectedByCode: mapRecord(expectedFailures),
        unexpectedByCode: mapRecord(unexpectedFailures)
      },
      requestResultLatency: summarize(allLatency),
      latencyByOperation: Object.fromEntries([...latencies].map(([name, values]) => [name, summarize(values)])),
      notificationLatency: summarize(notificationLatencies),
      durationMs: round(durationMs),
      throughputOperationsPerSecond: round(operationCount / Math.max(0.001, durationMs / 1_000)),
      reconciliation
    };
    return report;
  } finally {
    for (const socket of allSockets) socket.terminate();
    if (runtime) await runtime.app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

async function createIdentities(
  pool: pg.Pool,
  databaseUrl: string,
  count: number,
  seed: string,
  env: NodeJS.ProcessEnv
): Promise<WebSocketMarketIdentity[]> {
  const logger = createLogger("test");
  const identities: WebSocketMarketIdentity[] = [];
  for (let index = 0; index < count; index += 1) {
    const role = `stress-${index.toString().padStart(3, "0")}`;
    const email = `ash.atlas.websocket.${seed}.${index}@example.com`;
    const config = smokeConfig(databaseUrl, {
      ...env,
      AUTH_DEV_ACCOUNT_EMAIL: email,
      AUTH_DEV_PLAYER_NAME: `WsStress${index.toString().padStart(3, "0")}`
    });
    const auth = new AuthService(
      config,
      new PostgresAuthStore(pool, config),
      new GoogleAuthLibraryIdentityVerifier(config.GOOGLE_CLIENT_ID),
      logger
    );
    const login = await auth.loginAsDeveloper("default", {
      ip: `127.0.1.${index + 2}`,
      userAgent: `AshAtlasWebSocketStress/${role}`,
      deviceToken: null,
      existingSessionToken: null
    });
    if (!login.session.player) throw new Error(`WebSocket stress identity ${role} has no player`);
    identities.push({
      role,
      actor: { playerId: login.session.player.id, accountId: login.session.account.id },
      rawSessionToken: login.session.rawToken,
      deviceToken: login.deviceToken,
      email
    });
  }
  return identities;
}

async function seedAssets(
  pool: pg.Pool,
  identities: WebSocketMarketIdentity[],
  seed: string
): Promise<void> {
  const inventory = new InventoryService(pool);
  for (const identity of identities) {
    await pool.query(
      `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
       VALUES ($1,$2,1000000000,1)`,
      [identity.actor.playerId, identity.actor.accountId]
    );
    await pool.query(
      `INSERT INTO wallet_events (
         operation_key, player_id, account_id, delta_gold, balance_after,
         version_after, reason, metadata
       ) VALUES ($1,$2,$3,1000000000,1000000000,1,'market_websocket_stress_seed',$4::jsonb)`,
      [
        `market-websocket-stress-wallet:${seed}:${identity.role}`,
        identity.actor.playerId,
        identity.actor.accountId,
        JSON.stringify({ seed, role: identity.role })
      ]
    );
    await inventory.grantItemsForOperation({
      operationKey: `market-websocket-stress-inventory:${seed}:${identity.role}`,
      playerId: identity.actor.playerId,
      source: "market_websocket_stress_seed",
      sourceEntityType: "market_websocket_stress",
      sourceEntityId: seed,
      metadata: { seed, role: identity.role },
      grants: (["ore", "food", "wood", "stone"] as const).map((itemId) => ({
        itemId,
        variant: null,
        quantity: 1_000_000
      }))
    });
  }
}

async function waitForRegistryRemoval(
  registry: Awaited<ReturnType<typeof createSmokeRuntime>>["registry"],
  accountId: string
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!registry.activeConnectionIdForAccount(accountId)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for stress socket cleanup for ${accountId}`);
}

function recordLatency(target: Map<string, number[]>, name: string, value: number): void {
  const values = target.get(name) ?? [];
  values.push(value);
  target.set(name, values);
}

function summarize(values: number[]): LatencySummary {
  if (values.length === 0) return { count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: round(sorted.at(-1)!)
  };
}

function percentile(sorted: number[], quantile: number): number {
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!);
}

function mapRecord(source: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...source].sort(([left], [right]) => left.localeCompare(right)));
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`WebSocket stress integer must be from ${minimum} through ${maximum}`);
  }
  return value;
}

function assertDedicatedValidationDatabase(databaseUrl: string): void {
  const name = databaseUrlName(databaseUrl);
  if (!name.endsWith("_validation") && !name.endsWith("_test")) {
    throw new Error(`Refusing WebSocket stress on retained database '${name}'`);
  }
}

function databaseUrlName(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
}

function seededRandom(seed: string): () => number {
  let state = 2_166_136_261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runAuthenticatedWebSocketStress()
    .then(async (result) => {
      const serialized = `${JSON.stringify(result, null, 2)}\n`;
      const reportTarget = process.env.MARKET_WEBSOCKET_STRESS_REPORT?.trim();
      if (reportTarget) {
        const reportPath = path.resolve(reportTarget);
        await mkdir(path.dirname(reportPath), { recursive: true });
        await writeFile(reportPath, serialized, "utf8");
      }
      process.stdout.write(serialized);
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
