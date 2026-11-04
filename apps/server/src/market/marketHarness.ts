import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type {
  MarketCollectionScope,
  MarketMutationResult
} from "@ash-atlas/shared";
import pg from "pg";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { InventoryService } from "../game/inventory.js";
import { setMarketControlAuditContext } from "../game/marketControlAudit.js";
import {
  MarketReconciliationService
} from "../game/marketReconciliation.js";
import {
  type CreateMarketOrderInput,
  type MarketServiceMetrics
} from "../game/marketService.js";
import {
  activateLegacyGlobalMarketForTest,
  createLegacyMarketTestService,
  type LegacyMarketTestService
} from "../game/legacyMarketTestAdapter.js";
import {
  MarketError,
  isRetryablePostgresError,
  type MarketActor
} from "../game/marketRules.js";
import { createLogger } from "../logger.js";

const { Pool } = pg;

const MARKET_ITEMS = ["ore", "wood", "stone", "food"] as const;
type MarketHarnessItem = (typeof MARKET_ITEMS)[number];
type HarnessMode = "stress" | "soak";

const READ_PAGE_LIMIT = 2;
const READ_MAX_PAGES = 2;
const READ_BOOK_MAX_DEPTH = 5;
const READ_OPERATION_SHARE = 0.15;
const CONNECTION_OPERATION_SHARE = 0.05;

export type MarketHarnessOperationKind =
  | "browse_search"
  | "category"
  | "book_depth"
  | "create_sell"
  | "cross_buy"
  | "create_buy"
  | "cross_sell"
  | "cancel"
  | "claim"
  | "simple_buy"
  | "replay"
  | "duplicate_create"
  | "disconnect"
  | "reconnect";

export type MarketHarnessConnectionOperation = "disconnect" | "reconnect";

export type MarketHarnessConnectionTransition = {
  connected: boolean;
  transitioned: boolean;
};

const BASE_PRICES: Record<MarketHarnessItem, number> = {
  ore: 100,
  wood: 40,
  stone: 60,
  food: 30
};

const EXPECTED_FAILURE_CODES = new Set([
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
  "MARKET_RATE_LIMITED"
]);

export type MarketHarnessOptions = {
  databaseUrl: string;
  mode: HarnessMode;
  seed: string;
  playerCount: number;
  concurrency: number;
  operationCount: number | null;
  durationMs: number | null;
  reconcileEvery: number;
  hotItemRatio: number;
  goldPerPlayer: bigint;
  itemUnitsPerPlayer: number;
  latencySampleLimit?: number;
};

export type LatencySummary = {
  count: number;
  sampled: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

type RuntimeSnapshot = {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
};

type HandleSnapshot = {
  count: number;
  byType: Record<string, number>;
  activeRequestCount: number;
};

type PoolSnapshot = {
  total: number;
  idle: number;
  waiting: number;
};

export type MarketHarnessReport = {
  ok: boolean;
  mode: HarnessMode;
  seed: string;
  databaseName: string;
  startedAt: string;
  completedAt: string;
  setupDurationMs: number;
  workloadDurationMs: number;
  requestedOperations: number | null;
  completedOperations: number;
  serviceCalls: number;
  successfulCalls: number;
  replayedResponses: number;
  trades: number;
  throughputOperationsPerSecond: number;
  configuration: {
    players: number;
    concurrency: number;
    durationMs: number | null;
    reconcileEvery: number;
    hotItemRatio: number;
    goldPerPlayer: string;
    itemUnitsPerPlayer: number;
  };
  latency: Record<string, LatencySummary>;
  failures: {
    expectedTotal: number;
    unexpectedTotal: number;
    expectedByCode: Record<string, number>;
    unexpectedByCode: Record<string, number>;
    firstUnexpected: { code: string; message: string } | null;
  };
  reconciliation: {
    intervalRuns: number;
    failedRuns: number;
    finalReport: Awaited<ReturnType<MarketReconciliationService["reconcile"]>>;
  };
  serviceMetrics: {
    start: MarketServiceMetrics;
    final: MarketServiceMetrics;
    delta: MarketServiceMetrics;
  };
  connectionModel: {
    disconnectOperations: number;
    reconnectOperations: number;
    disconnectTransitions: number;
    reconnectTransitions: number;
    skippedWhileDisconnected: number;
    responsesCommittedWhileDisconnected: number;
    reconnectSnapshots: number;
    connectedPlayersFinal: number;
  };
  runtime: {
    memoryStart: RuntimeSnapshot;
    memoryPeak: RuntimeSnapshot;
    memoryFinal: RuntimeSnapshot;
    handlesStart: HandleSnapshot;
    handlesBeforePoolClose: HandleSnapshot;
    handlesAfterPoolClose: HandleSnapshot;
    poolStart: PoolSnapshot;
    poolPeak: PoolSnapshot;
    poolFinal: PoolSnapshot;
  };
  database: {
    orders: number;
    openOrders: number;
    trades: number;
    openCollections: number;
    ledgerGroups: number;
    walletEvents: number;
    inventoryEvents: number;
  };
};

type ReplayIntent =
  | { kind: "create_order"; input: CreateMarketOrderInput }
  | { kind: "cancel_order"; requestId: string; orderId: string }
  | { kind: "claim"; requestId: string; scope: MarketCollectionScope }
  | { kind: "simple_buy"; requestId: string; quoteId: string; maximumTotal: string };

type ActorState = {
  actor: MarketActor;
  connected: boolean;
  openOrderIds: Set<string>;
  replayIntents: ReplayIntent[];
};

type FailureCounters = {
  expected: Map<string, number>;
  unexpected: Map<string, number>;
  firstUnexpected: { code: string; message: string } | null;
};

type CallOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; expected: boolean };

export function marketHarnessDatabaseName(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Market harness DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Market harness DATABASE_URL must use postgres or postgresql");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName) throw new Error("Market harness DATABASE_URL must name a database");
  return databaseName;
}

export function assertSafeMarketHarnessDatabaseUrl(databaseUrl: string): string {
  const databaseName = marketHarnessDatabaseName(databaseUrl);
  const normalized = databaseName.toLowerCase();
  if (!normalized.endsWith("_test") && !normalized.endsWith("_validation")) {
    throw new Error(
      `Refusing destructive market harness work on database '${databaseName}'; ` +
      "the name must end with _test or _validation"
    );
  }
  return databaseName;
}

export async function runMarketHarness(
  options: MarketHarnessOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<MarketHarnessReport> {
  validateOptions(options);
  const databaseName = assertSafeMarketHarnessDatabaseUrl(options.databaseUrl);
  const setupStarted = performance.now();
  await runMigrations(options.databaseUrl);
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: Math.max(10, options.concurrency + 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  let report: MarketHarnessReport | null = null;
  try {
    const config = loadConfig({
      ...env,
      NODE_ENV: "test",
      DATABASE_URL: options.databaseUrl,
      MARKET_GLOBAL_ACCESS: "true",
      MARKET_MAX_ACTIVE_ORDERS_PER_PLAYER:
        env.MARKET_MAX_ACTIVE_ORDERS_PER_PLAYER ?? "500",
      MARKET_MAX_OPEN_ORDERS_PER_ITEM:
        env.MARKET_MAX_OPEN_ORDERS_PER_ITEM ?? "250",
      MARKET_REQUESTS_PER_MINUTE:
        env.MARKET_REQUESTS_PER_MINUTE ?? "1000000",
      MARKET_CANCELLATIONS_PER_MINUTE:
        env.MARKET_CANCELLATIONS_PER_MINUTE ?? "1000000",
      MARKET_TRANSACTION_RETRY_LIMIT:
        env.MARKET_TRANSACTION_RETRY_LIMIT ?? "5"
    });
    await resetHarnessDatabase(pool);
    const actors = createActors(options.playerCount, options.seed);
    await seedActors(pool, actors, options);
    const setupDurationMs = performance.now() - setupStarted;
    await activateLegacyGlobalMarketForTest(pool);
    const service = createLegacyMarketTestService(pool, config, createLogger("test"));
    const reconciliation = new MarketReconciliationService(pool);
    report = await runWorkload({
      pool,
      service,
      reconciliation,
      actors,
      options,
      databaseName,
      setupDurationMs
    });
  } finally {
    await pool.end();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (report) report.runtime.handlesAfterPoolClose = activeHandles();
  }
  return report!;
}

async function runWorkload(input: {
  pool: pg.Pool;
  service: LegacyMarketTestService;
  reconciliation: MarketReconciliationService;
  actors: MarketActor[];
  options: MarketHarnessOptions;
  databaseName: string;
  setupDurationMs: number;
}): Promise<MarketHarnessReport> {
  const { pool, service, reconciliation, options } = input;
  const states = input.actors.map((actor): ActorState => ({
    actor,
    connected: true,
    openOrderIds: new Set(),
    replayIntents: []
  }));
  const latency = new Map<string, LatencyReservoir>();
  const failures: FailureCounters = {
    expected: new Map(),
    unexpected: new Map(),
    firstUnexpected: null
  };
  const telemetry = new RuntimeTelemetry(pool);
  telemetry.sample();
  const serviceMetricsStart = service.metricsSnapshot();
  const startedAt = new Date();
  const workloadStarted = performance.now();
  const deadline = options.durationMs === null
    ? Number.POSITIVE_INFINITY
    : workloadStarted + options.durationMs;
  const operationLimit = options.operationCount ?? Number.MAX_SAFE_INTEGER;
  const runKey = createHash("sha256").update(options.seed).digest("hex").slice(0, 10);
  let nextOperation = 0;
  let completedOperations = 0;
  let serviceCalls = 0;
  let successfulCalls = 0;
  let replayedResponses = 0;
  let trades = 0;
  let disconnectOperations = 0;
  let reconnectOperations = 0;
  let disconnectTransitions = 0;
  let reconnectTransitions = 0;
  let skippedWhileDisconnected = 0;
  let responsesCommittedWhileDisconnected = 0;
  let reconnectSnapshots = 0;
  let intervalRuns = 0;
  let failedReconciliations = 0;
  let nextReconciliation = options.reconcileEvery;
  let reconciliationGate: Promise<void> | null = null;
  let activeOperations = 0;
  const operationDrainWaiters = new Set<() => void>();

  const waitForActiveOperationsToDrain = async (): Promise<void> => {
    if (activeOperations === 0) return;
    await new Promise<void>((resolve) => operationDrainWaiters.add(resolve));
  };

  const markOperationComplete = (): void => {
    activeOperations -= 1;
    if (activeOperations !== 0) return;
    for (const resolve of operationDrainWaiters) resolve();
    operationDrainWaiters.clear();
  };
  let abort = false;

  const tracker = (name: string): LatencyReservoir => {
    let existing = latency.get(name);
    if (!existing) {
      existing = new LatencyReservoir(name, options.latencySampleLimit ?? 50_000);
      latency.set(name, existing);
    }
    return existing;
  };

  // Keep the promised read-path series in the report even for very small runs
  // whose deterministic mix does not happen to select every read operation.
  tracker("browse_search");
  tracker("category");
  tracker("book_depth");

  const call = async <T>(name: string, operation: () => Promise<T>): Promise<CallOutcome<T>> => {
    serviceCalls += 1;
    const started = performance.now();
    try {
      const pending = operation();
      telemetry.samplePool();
      const value = await pending;
      successfulCalls += 1;
      return { ok: true, value };
    } catch (error) {
      const { code, message } = errorIdentity(error);
      const expected = EXPECTED_FAILURE_CODES.has(code);
      const target = expected ? failures.expected : failures.unexpected;
      target.set(code, (target.get(code) ?? 0) + 1);
      if (!expected && !failures.firstUnexpected) failures.firstUnexpected = { code, message };
      if (!expected) abort = true;
      return { ok: false, code, expected };
    } finally {
      tracker(name).record(performance.now() - started);
      telemetry.samplePool();
    }
  };

  const applyResult = (
    state: ActorState,
    intent: ReplayIntent | null,
    result: MarketMutationResult
  ): void => {
    if (!state.connected) responsesCommittedWhileDisconnected += 1;
    replayedResponses += result.replayed ? 1 : 0;
    if (!result.replayed) {
      trades += result.trades.length;
      state.openOrderIds = new Set(result.player.activeOrders.map((order) => order.orderId));
      if (intent) {
        state.replayIntents.push(intent);
        if (state.replayIntents.length > 128) state.replayIntents.shift();
      }
    }
  };

  const runReconciliation = async (): Promise<void> => {
    const started = performance.now();
    try {
      // The gate prevents new operations from being admitted. Drain operations
      // that passed the gate before taking the exclusive reconciliation lock.
      await waitForActiveOperationsToDrain();
      let report: Awaited<ReturnType<MarketReconciliationService["reconcile"]>> | null = null;
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          report = await reconciliation.reconcile();
          break;
        } catch (error) {
          lastError = error;
          if (!isRetryablePostgresError(error) || attempt === 3) throw error;
        }
      }
      if (!report) throw lastError ?? new Error("Market harness reconciliation returned no report");
      intervalRuns += 1;
      if (!report.ok) {
        failedReconciliations += 1;
        const code = "MARKET_RECONCILIATION_FAILED";
        failures.unexpected.set(code, (failures.unexpected.get(code) ?? 0) + 1);
        failures.firstUnexpected ??= {
          code,
          message: JSON.stringify(report.issues.slice(0, 5))
        };
        abort = true;
      }
    } catch (error) {
      failedReconciliations += 1;
      const identity = errorIdentity(error);
      failures.unexpected.set(identity.code, (failures.unexpected.get(identity.code) ?? 0) + 1);
      failures.firstUnexpected ??= identity;
      abort = true;
    } finally {
      tracker("reconcile").record(performance.now() - started);
    }
  };

  const executeDescriptor = async (index: number): Promise<void> => {
    const random = operationRandom(options.seed, index);
    const kind = chooseOperationKind(random());
    const state = states[Math.floor(random() * states.length)]!;
    const item = chooseItem(random, options.hotItemRatio);
    const quantity = String(1 + Math.floor(random() * 5));
    const base = BASE_PRICES[item];
    const requestId = `stress-${runKey}-${index.toString(36).padStart(6, "0")}`;

    if (kind === "disconnect") {
      disconnectOperations += 1;
      const transition = marketHarnessConnectionTransition(state.connected, kind);
      state.connected = transition.connected;
      if (transition.transitioned) disconnectTransitions += 1;
      return;
    }
    if (kind === "reconnect") {
      reconnectOperations += 1;
      const transition = marketHarnessConnectionTransition(state.connected, kind);
      state.connected = transition.connected;
      if (!transition.transitioned) return;
      reconnectTransitions += 1;
      const outcome = await call("reconnect_snapshot", () =>
        service.read.snapshot(state.actor, { limit: 1 })
      );
      if (outcome.ok) {
        reconnectSnapshots += 1;
        state.openOrderIds = new Set(
          outcome.value.player.activeOrders.map((order) => order.orderId)
        );
      }
      return;
    }
    if (!state.connected) {
      skippedWhileDisconnected += 1;
      return;
    }

    if (kind === "browse_search") {
      await browsePages("browse_search", state, { search: item });
    } else if (kind === "category") {
      await browsePages("category", state, { category: "resource" });
    } else if (kind === "book_depth") {
      const depth = 1 + Math.floor(random() * READ_BOOK_MAX_DEPTH);
      await call("book_depth", async () => {
        const book = await service.read.book(state.actor, item, depth);
        if (book.item.itemId !== item || book.asks.length > depth || book.bids.length > depth) {
          throw new Error("Market book read exceeded its requested bounds or returned the wrong item");
        }
        return book;
      });
    } else if (kind === "create_sell") {
      await create("create_sell", state, {
        requestId,
        interface: random() < 0.5 ? "simple" : "merchant",
        side: "sell",
        itemId: item,
        quantity,
        unitPrice: String(base + 5 + Math.floor(random() * 6))
      });
    } else if (kind === "cross_buy") {
      await create("cross_buy", state, {
        requestId,
        interface: "merchant",
        side: "buy",
        itemId: item,
        quantity,
        unitPrice: String(base + 20)
      });
    } else if (kind === "create_buy") {
      await create("create_buy", state, {
        requestId,
        interface: "merchant",
        side: "buy",
        itemId: item,
        quantity,
        unitPrice: String(Math.max(1, base - 5 - Math.floor(random() * 6)))
      });
    } else if (kind === "cross_sell") {
      await create("cross_sell", state, {
        requestId,
        interface: "merchant",
        side: "sell",
        itemId: item,
        quantity,
        unitPrice: String(Math.max(1, base - 20))
      });
    } else if (kind === "cancel") {
      const orderIds = [...state.openOrderIds];
      if (orderIds.length === 0) {
        await claim(state, requestId, "all", "claim_fallback");
      } else {
        const orderId = orderIds[Math.floor(random() * orderIds.length)]!;
        const intent: ReplayIntent = { kind: "cancel_order", requestId, orderId };
        const outcome = await call("cancel", () => service.cancelOrder(state.actor, requestId, orderId));
        if (outcome.ok) applyResult(state, intent, outcome.value);
        else if (outcome.code === "MARKET_ORDER_ALREADY_CLOSED" || outcome.code === "MARKET_ORDER_NOT_FOUND") {
          state.openOrderIds.delete(orderId);
        }
      }
    } else if (kind === "claim") {
      const scopes: MarketCollectionScope[] = ["all", "items", "gold"];
      await claim(state, requestId, scopes[Math.floor(random() * scopes.length)]!, "claim");
    } else if (kind === "simple_buy") {
      await simpleBuy(state, requestId, item, quantity);
    } else if (kind === "replay") {
      const replay = state.replayIntents[Math.floor(random() * state.replayIntents.length)];
      if (replay) await executeReplay(state, replay);
      else await claim(state, requestId, "all", "replay_fallback");
    } else {
      const input: CreateMarketOrderInput = {
        requestId,
        interface: "merchant",
        side: random() < 0.5 ? "sell" : "buy",
        itemId: item,
        quantity,
        unitPrice: String(base + (random() < 0.5 ? -2 : 2))
      };
      const intent: ReplayIntent = { kind: "create_order", input };
      const [first, second] = await Promise.all([
        call("duplicate_create", () => service.createOrder(state.actor, input)),
        call("duplicate_create", () => service.createOrder(state.actor, input))
      ]);
      if (first.ok) applyResult(state, intent, first.value);
      if (second.ok) applyResult(state, null, second.value);
    }

    async function browsePages(
      name: "browse_search" | "category",
      actorState: ActorState,
      filter: { search: string } | { category: string }
    ): Promise<void> {
      let cursor: string | null = null;
      for (let page = 0; page < READ_MAX_PAGES; page += 1) {
        const outcome = await call(name, async () => {
          const snapshot = await service.read.snapshot(actorState.actor, {
            ...filter,
            cursor,
            limit: READ_PAGE_LIMIT
          });
          if (snapshot.items.length > READ_PAGE_LIMIT) {
            throw new Error("Market browse read exceeded its requested page limit");
          }
          if ("category" in filter && snapshot.items.some((entry) => entry.category !== filter.category)) {
            throw new Error("Market category browse returned an item outside the requested category");
          }
          return snapshot;
        });
        if (!outcome.ok || !outcome.value.nextCursor) return;
        cursor = outcome.value.nextCursor;
      }
    }

    async function create(name: string, actorState: ActorState, createInput: CreateMarketOrderInput) {
      const intent: ReplayIntent = { kind: "create_order", input: createInput };
      const outcome = await call(name, () => service.createOrder(actorState.actor, createInput));
      if (outcome.ok) applyResult(actorState, intent, outcome.value);
    }

    async function claim(
      actorState: ActorState,
      id: string,
      scope: MarketCollectionScope,
      name: string
    ) {
      const intent: ReplayIntent = { kind: "claim", requestId: id, scope };
      const outcome = await call(name, () => service.claim(actorState.actor, id, scope));
      if (outcome.ok) applyResult(actorState, intent, outcome.value);
    }

    async function simpleBuy(
      actorState: ActorState,
      id: string,
      selectedItem: MarketHarnessItem,
      selectedQuantity: string
    ) {
      const selectedMaximumUnitPrice = String(BASE_PRICES[selectedItem] + 20);
      const quoteOutcome = await call("quote", async () => {
        const quote = await service.quote(
          actorState.actor,
          `${id}-quote`,
          selectedItem,
          selectedQuantity,
          selectedMaximumUnitPrice
        );
        if (quote.requestedMaximumUnitPrice !== selectedMaximumUnitPrice) {
          throw new Error("Market stress quote lost its selected maximum unit price");
        }
        if (
          quote.maximumUnitPrice !== null &&
          BigInt(quote.maximumUnitPrice) > BigInt(selectedMaximumUnitPrice)
        ) {
          throw new Error("Market stress quote exceeded its selected maximum unit price");
        }
        return quote;
      });
      if (!quoteOutcome.ok) return;
      const quote = quoteOutcome.value;
      const maximumTotal = BigInt(quote.quotedTotal) > 0n ? quote.quotedTotal : "1";
      const intent: ReplayIntent = {
        kind: "simple_buy",
        requestId: id,
        quoteId: quote.quoteId,
        maximumTotal
      };
      const outcome = await call("simple_buy", () =>
        service.simpleBuy(actorState.actor, id, quote.quoteId, maximumTotal)
      );
      if (outcome.ok) applyResult(actorState, intent, outcome.value);
    }

    async function executeReplay(actorState: ActorState, replay: ReplayIntent) {
      let outcome: CallOutcome<MarketMutationResult>;
      switch (replay.kind) {
        case "create_order":
          outcome = await call("replay", () => service.createOrder(actorState.actor, replay.input));
          break;
        case "cancel_order":
          outcome = await call("replay", () =>
            service.cancelOrder(actorState.actor, replay.requestId, replay.orderId)
          );
          break;
        case "claim":
          outcome = await call("replay", () => service.claim(actorState.actor, replay.requestId, replay.scope));
          break;
        case "simple_buy":
          outcome = await call("replay", () =>
            service.simpleBuy(actorState.actor, replay.requestId, replay.quoteId, replay.maximumTotal)
          );
          break;
      }
      if (outcome.ok) applyResult(actorState, null, outcome.value);
    }
  };

  const worker = async (): Promise<void> => {
    while (!abort) {
      if (reconciliationGate) await reconciliationGate;
      const index = nextOperation;
      if (index >= operationLimit || performance.now() >= deadline) return;
      nextOperation += 1;
      activeOperations += 1;
      try {
        await executeDescriptor(index);
      } finally {
        markOperationComplete();
      }
      completedOperations += 1;
      if (completedOperations % 100 === 0) telemetry.sample();
      if (completedOperations >= nextReconciliation) {
        if (!reconciliationGate) {
          while (nextReconciliation <= completedOperations) {
            nextReconciliation += options.reconcileEvery;
          }
          const gate = runReconciliation();
          reconciliationGate = gate;
          void gate.then(() => {
            if (reconciliationGate === gate) reconciliationGate = null;
          }, () => {
            if (reconciliationGate === gate) reconciliationGate = null;
          });
        }
        await reconciliationGate;
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, worker));
  if (reconciliationGate) await reconciliationGate;
  const finalReconciliationStarted = performance.now();
  const finalReport = await reconciliation.reconcile();
  tracker("reconcile_final").record(performance.now() - finalReconciliationStarted);
  if (!finalReport.ok) {
    failedReconciliations += 1;
    const code = "MARKET_FINAL_RECONCILIATION_FAILED";
    failures.unexpected.set(code, (failures.unexpected.get(code) ?? 0) + 1);
    failures.firstUnexpected ??= {
      code,
      message: JSON.stringify(finalReport.issues.slice(0, 5))
    };
  }
  telemetry.sample();
  const workloadDurationMs = performance.now() - workloadStarted;
  const serviceMetricsFinal = service.metricsSnapshot();
  const database = await databaseSummary(pool);
  const completedAt = new Date();
  const expectedTotal = sumMap(failures.expected);
  const unexpectedTotal = sumMap(failures.unexpected);
  const latencyReport = Object.fromEntries(
    [...latency.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, reservoir]) => [name, reservoir.summary()])
  );

  return {
    ok: unexpectedTotal === 0 && failedReconciliations === 0 && finalReport.ok,
    mode: options.mode,
    seed: options.seed,
    databaseName: input.databaseName,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    setupDurationMs: round(input.setupDurationMs),
    workloadDurationMs: round(workloadDurationMs),
    requestedOperations: options.operationCount,
    completedOperations,
    serviceCalls,
    successfulCalls,
    replayedResponses,
    trades,
    throughputOperationsPerSecond: round(completedOperations / Math.max(0.001, workloadDurationMs / 1_000)),
    configuration: {
      players: options.playerCount,
      concurrency: options.concurrency,
      durationMs: options.durationMs,
      reconcileEvery: options.reconcileEvery,
      hotItemRatio: options.hotItemRatio,
      goldPerPlayer: options.goldPerPlayer.toString(),
      itemUnitsPerPlayer: options.itemUnitsPerPlayer
    },
    latency: latencyReport,
    failures: {
      expectedTotal,
      unexpectedTotal,
      expectedByCode: mapRecord(failures.expected),
      unexpectedByCode: mapRecord(failures.unexpected),
      firstUnexpected: failures.firstUnexpected
    },
    reconciliation: {
      intervalRuns,
      failedRuns: failedReconciliations,
      finalReport
    },
    serviceMetrics: {
      start: serviceMetricsStart,
      final: serviceMetricsFinal,
      delta: subtractMetrics(serviceMetricsFinal, serviceMetricsStart)
    },
    connectionModel: {
      disconnectOperations,
      reconnectOperations,
      disconnectTransitions,
      reconnectTransitions,
      skippedWhileDisconnected,
      responsesCommittedWhileDisconnected,
      reconnectSnapshots,
      connectedPlayersFinal: states.filter((state) => state.connected).length
    },
    runtime: {
      memoryStart: telemetry.memoryStart,
      memoryPeak: telemetry.memoryPeak,
      memoryFinal: telemetry.memoryFinal,
      handlesStart: telemetry.handlesStart,
      handlesBeforePoolClose: activeHandles(),
      handlesAfterPoolClose: { count: 0, byType: {}, activeRequestCount: 0 },
      poolStart: telemetry.poolStart,
      poolPeak: telemetry.poolPeak,
      poolFinal: poolSnapshot(pool)
    },
    database
  };
}

async function resetHarnessDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE market_order_books CASCADE");
    await client.query("TRUNCATE accounts CASCADE");
    await client.query("ALTER SEQUENCE market_priority_sequence RESTART WITH 1");
    await setMarketControlAuditContext(client, {
      operatorIdentity: "market-harness",
      reason: "reset dedicated market harness controls"
    });
    await client.query(
      `UPDATE market_global_controls
       SET read_only = false,
           new_orders_enabled = true,
           matching_enabled = true,
           cancellations_enabled = true,
           claims_enabled = true,
           rules_version = 1,
           updated_at = now()
       WHERE singleton`
    );
    await client.query(
      `UPDATE market_venue_controls
       SET frozen = false, sensitive_reason = NULL, updated_at = now()`
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedActors(
  pool: pg.Pool,
  actors: MarketActor[],
  options: MarketHarnessOptions
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let index = 0; index < actors.length; index += 1) {
      const actor = actors[index]!;
      const username = `Stress${index.toString().padStart(4, "0")}`;
      await client.query(
        `INSERT INTO accounts (id, status, trust_tier)
         VALUES ($1, 'active', 'standard')`,
        [actor.accountId]
      );
      await client.query(
        `INSERT INTO account_identities (
           id, account_id, provider, provider_subject, email, email_normalized, email_verified
         ) VALUES ($1,$2,'google',$3,$4,$5,true)`,
        [
          deterministicUuid(`${options.seed}:identity:${index}`),
          actor.accountId,
          `market-harness-${hash32(options.seed).toString(16)}-${index}`,
          `market.harness.${hash32(options.seed).toString(16)}.${index}@example.com`,
          `market.harness.${hash32(options.seed).toString(16)}.${index}@example.com`
        ]
      );
      await client.query(
        `INSERT INTO players (
           id, account_id, username, username_normalized, display_color, region_code,
           lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom
         ) VALUES ($1,$2,$3,$4,NULL,'NM',35,-106,35,-106,900,false,
                   ST_SetSRID(ST_MakePoint(-106,35),4326))`,
        [actor.playerId, actor.accountId, username, username.toLowerCase()]
      );
      const sessionId = deterministicUuid(`${options.seed}:session:${index}`);
      await client.query(
        `INSERT INTO auth_sessions (
           id, account_id, identity_id, token_hash, expires_at, account_session_version
         ) VALUES ($1,$2,$3,$4,now() + interval '1 day',0)`,
        [
          sessionId,
          actor.accountId,
          deterministicUuid(`${options.seed}:identity:${index}`),
          createHash("sha256").update(`${options.seed}:session-token:${index}`).digest("hex")
        ]
      );
      await client.query(
        `INSERT INTO auth_events (id, account_id, event_type, metadata)
         VALUES ($1,$2,'market_harness_seeded_session',$3::jsonb)`,
        [
          deterministicUuid(`${options.seed}:auth-event:${index}`),
          actor.accountId,
          JSON.stringify({ seed: options.seed, playerId: actor.playerId })
        ]
      );
      await client.query(
        `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
         VALUES ($1,$2,$3,1)`,
        [actor.playerId, actor.accountId, options.goldPerPlayer.toString()]
      );
      await client.query(
        `INSERT INTO wallet_events (
           operation_key, player_id, account_id, delta_gold, balance_after,
           version_after, reason, metadata
         ) VALUES ($1,$2,$3,$4,$4,1,'market_harness_seed',$5::jsonb)`,
        [
          `market-harness-wallet:${hash32(options.seed).toString(16)}:${index}`,
          actor.playerId,
          actor.accountId,
          options.goldPerPlayer.toString(),
          JSON.stringify({ seed: options.seed })
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const inventory = new InventoryService(pool);
  await Promise.all(actors.map((actor, index) => inventory.grantItemsForOperation({
    operationKey: `market-harness-inventory:${hash32(options.seed).toString(16)}:${index}`,
    playerId: actor.playerId,
    source: "market_harness_seed",
    sourceEntityType: "market_harness_run",
    sourceEntityId: hash32(options.seed).toString(16),
    metadata: { seed: options.seed },
    grants: MARKET_ITEMS.map((itemId) => ({
      itemId,
      variant: null,
      quantity: options.itemUnitsPerPlayer
    }))
  })));
}

function createActors(count: number, seed: string): MarketActor[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `market-stress-${index.toString().padStart(4, "0")}`,
    accountId: deterministicUuid(`${seed}:account:${index}`)
  }));
}

async function databaseSummary(pool: pg.Pool): Promise<MarketHarnessReport["database"]> {
  const result = await pool.query<{
    orders: string;
    open_orders: string;
    trades: string;
    open_collections: string;
    ledger_groups: string;
    wallet_events: string;
    inventory_events: string;
  }>(
    `SELECT
       (SELECT count(*) FROM market_orders)::text AS orders,
       (SELECT count(*) FROM market_orders WHERE status IN ('open','partially_filled'))::text AS open_orders,
       (SELECT count(*) FROM market_trades)::text AS trades,
       (SELECT count(*) FROM market_collections WHERE remaining_amount > 0)::text AS open_collections,
       (SELECT count(*) FROM market_ledger_groups)::text AS ledger_groups,
       (SELECT count(*) FROM wallet_events)::text AS wallet_events,
       (SELECT count(*) FROM inventory_events)::text AS inventory_events`
  );
  const row = result.rows[0];
  if (!row) throw new Error("Market harness database summary returned no row");
  return {
    orders: Number(row.orders),
    openOrders: Number(row.open_orders),
    trades: Number(row.trades),
    openCollections: Number(row.open_collections),
    ledgerGroups: Number(row.ledger_groups),
    walletEvents: Number(row.wallet_events),
    inventoryEvents: Number(row.inventory_events)
  };
}

class LatencyReservoir {
  private readonly values: number[] = [];
  private count = 0;
  private total = 0;
  private maximum = 0;
  private readonly keyHash: number;

  constructor(name: string, private readonly limit: number) {
    this.keyHash = hash32(name);
  }

  record(value: number): void {
    const normalized = Math.max(0, value);
    this.count += 1;
    this.total += normalized;
    this.maximum = Math.max(this.maximum, normalized);
    if (this.values.length < this.limit) {
      this.values.push(normalized);
      return;
    }
    const candidate = mix32(this.keyHash ^ this.count) % this.count;
    if (candidate < this.limit) this.values[candidate] = normalized;
  }

  summary(): LatencySummary {
    if (this.count === 0) return emptyLatency();
    const sorted = [...this.values].sort((left, right) => left - right);
    return {
      count: this.count,
      sampled: sorted.length,
      meanMs: round(this.total / this.count),
      p50Ms: round(percentile(sorted, 0.5)),
      p95Ms: round(percentile(sorted, 0.95)),
      p99Ms: round(percentile(sorted, 0.99)),
      maxMs: round(this.maximum)
    };
  }
}

export function summarizeLatencies(values: number[]): LatencySummary {
  const reservoir = new LatencyReservoir("test", Math.max(1, values.length));
  for (const value of values) reservoir.record(value);
  return reservoir.summary();
}

class RuntimeTelemetry {
  readonly memoryStart: RuntimeSnapshot;
  memoryPeak: RuntimeSnapshot;
  memoryFinal: RuntimeSnapshot;
  readonly handlesStart: HandleSnapshot;
  readonly poolStart: PoolSnapshot;
  poolPeak: PoolSnapshot;

  constructor(private readonly pool: pg.Pool) {
    this.memoryStart = memorySnapshot();
    this.memoryPeak = { ...this.memoryStart };
    this.memoryFinal = { ...this.memoryStart };
    this.handlesStart = activeHandles();
    this.poolStart = poolSnapshot(pool);
    this.poolPeak = { ...this.poolStart };
  }

  sample(): void {
    this.memoryFinal = memorySnapshot();
    this.memoryPeak = {
      rssBytes: Math.max(this.memoryPeak.rssBytes, this.memoryFinal.rssBytes),
      heapUsedBytes: Math.max(this.memoryPeak.heapUsedBytes, this.memoryFinal.heapUsedBytes),
      heapTotalBytes: Math.max(this.memoryPeak.heapTotalBytes, this.memoryFinal.heapTotalBytes),
      externalBytes: Math.max(this.memoryPeak.externalBytes, this.memoryFinal.externalBytes),
      arrayBuffersBytes: Math.max(this.memoryPeak.arrayBuffersBytes, this.memoryFinal.arrayBuffersBytes)
    };
    this.samplePool();
  }

  samplePool(): void {
    const pool = poolSnapshot(this.pool);
    this.poolPeak = {
      total: Math.max(this.poolPeak.total, pool.total),
      idle: Math.max(this.poolPeak.idle, pool.idle),
      waiting: Math.max(this.poolPeak.waiting, pool.waiting)
    };
  }
}

function chooseItem(random: () => number, hotRatio: number): MarketHarnessItem {
  if (random() < hotRatio) return "ore";
  const others: MarketHarnessItem[] = ["wood", "stone", "food"];
  return others[Math.floor(random() * others.length)]!;
}

export function marketHarnessOperationKind(
  seed: string,
  operationIndex: number
): MarketHarnessOperationKind {
  return chooseOperationKind(operationRandom(seed, operationIndex)());
}

export function marketHarnessConnectionTransition(
  connected: boolean,
  operation: MarketHarnessConnectionOperation
): MarketHarnessConnectionTransition {
  const nextConnected = operation === "reconnect";
  return {
    connected: nextConnected,
    transitioned: nextConnected !== connected
  };
}

function chooseOperationKind(roll: number): MarketHarnessOperationKind {
  const readShare = READ_OPERATION_SHARE / 3;
  if (roll < readShare) return "browse_search";
  if (roll < readShare * 2) return "category";
  if (roll < READ_OPERATION_SHARE) return "book_depth";

  const connectionShare = CONNECTION_OPERATION_SHARE / 2;
  if (roll < READ_OPERATION_SHARE + connectionShare) return "disconnect";
  if (roll < READ_OPERATION_SHARE + CONNECTION_OPERATION_SHARE) return "reconnect";

  // Preserve the original relative mutation mix within the remaining workload.
  const mutationStart = READ_OPERATION_SHARE + CONNECTION_OPERATION_SHARE;
  const mutationRoll = (roll - mutationStart) / (1 - mutationStart);
  if (mutationRoll < 0.23) return "create_sell";
  if (mutationRoll < 0.43) return "cross_buy";
  if (mutationRoll < 0.55) return "create_buy";
  if (mutationRoll < 0.67) return "cross_sell";
  if (mutationRoll < 0.77) return "cancel";
  if (mutationRoll < 0.87) return "claim";
  if (mutationRoll < 0.92) return "simple_buy";
  if (mutationRoll < 0.97) return "replay";
  return "duplicate_create";
}

function operationRandom(seed: string, operationIndex: number): () => number {
  let state = hash32(`${seed}:${operationIndex}`) || 0x9e3779b9;
  return () => {
    state = mix32(state + 0x6d2b79f5);
    return state / 0x1_0000_0000;
  };
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function percentile(sorted: number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

function emptyLatency(): LatencySummary {
  return { count: 0, sampled: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
}

function errorIdentity(error: unknown): { code: string; message: string } {
  if (error instanceof MarketError) return { code: error.code, message: error.message };
  const record = error as { code?: unknown; message?: unknown; name?: unknown } | null;
  const code = typeof record?.code === "string"
    ? `PG_${record.code}`
    : typeof record?.name === "string"
      ? record.name
      : "UNKNOWN_ERROR";
  return {
    code,
    message: typeof record?.message === "string" ? record.message : String(error)
  };
}

function memorySnapshot(): RuntimeSnapshot {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers
  };
}

function activeHandles(): HandleSnapshot {
  const runtime = process as unknown as {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  const handles = runtime._getActiveHandles?.() ?? [];
  const byType: Record<string, number> = {};
  for (const handle of handles) {
    const type = (handle as { constructor?: { name?: string } } | null)?.constructor?.name ?? "Unknown";
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return {
    count: handles.length,
    byType: Object.fromEntries(Object.entries(byType).sort(([left], [right]) => left.localeCompare(right))),
    activeRequestCount: runtime._getActiveRequests?.().length ?? 0
  };
}

function poolSnapshot(pool: pg.Pool): PoolSnapshot {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

function subtractMetrics(final: MarketServiceMetrics, start: MarketServiceMetrics): MarketServiceMetrics {
  return {
    transactions: final.transactions - start.transactions,
    retries: final.retries - start.retries,
    deadlocks: final.deadlocks - start.deadlocks,
    serializationFailures: final.serializationFailures - start.serializationFailures,
    fills: final.fills - start.fills,
    rateLimitRejections: final.rateLimitRejections - start.rateLimitRejections,
    invariantFailures: final.invariantFailures - start.invariantFailures,
    quotesCreated: final.quotesCreated - start.quotesCreated,
    quotesReplaced: final.quotesReplaced - start.quotesReplaced
  };
}

function mapRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function sumMap(map: Map<string, number>): number {
  return [...map.values()].reduce((sum, value) => sum + value, 0);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function validateOptions(options: MarketHarnessOptions): void {
  if (!options.seed.trim()) throw new Error("Market harness seed must not be empty");
  if (!Number.isInteger(options.playerCount) || options.playerCount < 2 || options.playerCount > 500) {
    throw new Error("Market harness players must be an integer from 2 through 500");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 256) {
    throw new Error("Market harness concurrency must be an integer from 1 through 256");
  }
  if (options.operationCount !== null && (
    !Number.isInteger(options.operationCount) || options.operationCount < 1 || options.operationCount > 10_000_000
  )) {
    throw new Error("Market harness operations must be an integer from 1 through 10000000");
  }
  if (options.durationMs !== null && (
    !Number.isFinite(options.durationMs) || options.durationMs < 100 || options.durationMs > 7 * 24 * 60 * 60_000
  )) {
    throw new Error("Market harness duration must be between 100ms and seven days");
  }
  if (options.operationCount === null && options.durationMs === null) {
    throw new Error("Market harness requires an operation count or duration");
  }
  if (!Number.isInteger(options.reconcileEvery) || options.reconcileEvery < 1) {
    throw new Error("Market harness reconcile interval must be a positive integer");
  }
  if (!Number.isFinite(options.hotItemRatio) || options.hotItemRatio < 0 || options.hotItemRatio > 1) {
    throw new Error("Market harness hot-item ratio must be between 0 and 1");
  }
  if (options.goldPerPlayer <= 0n) throw new Error("Market harness seed gold must be positive");
  if (!Number.isSafeInteger(options.itemUnitsPerPlayer) || options.itemUnitsPerPlayer <= 0) {
    throw new Error("Market harness seed item units must be a positive safe integer");
  }
}
