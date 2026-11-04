import type {
  MarketCollectionScope,
  MarketMutationResult,
  MarketOrderSide
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import { InventoryService } from "./inventory.js";
import { setMarketControlAuditContext } from "./marketControlAudit.js";
import { MarketReconciliationService } from "./marketReconciliation.js";
import type { MarketActor, MarketFaultInjector, MarketFaultPoint } from "./marketRules.js";
import {
  activateLegacyGlobalMarketForTest,
  createLegacyMarketTestService,
  type LegacyMarketTestService
} from "./legacyMarketTestAdapter.js";
import type { CreateMarketOrderInput } from "./marketService.js";

const databaseUrl = process.env.MARKET_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const { Pool } = pg;
const PROPERTY_SEED = positiveIntegerEnvironment("MARKET_PROPERTY_SEED", 600_001);
const PROPERTY_CASES = positiveIntegerEnvironment("MARKET_PROPERTY_CASES", 20);
const STEPS_PER_CASE = positiveIntegerEnvironment("MARKET_PROPERTY_STEPS", 40);
const ACTOR_COUNT = 8;
const INITIAL_GOLD = 100_000n;
const INITIAL_STONE = 100n;

type ModelOrderStatus = "open" | "partially_filled" | "filled" | "cancelled";
type ModelOrderPolicy = "gtc" | "aon_ioc";

type ModelPlayer = {
  actor: MarketActor;
  inventory: bigint;
  wallet: bigint;
  itemCollection: bigint;
  goldCollection: bigint;
  connected: boolean;
};

type ModelOrder = {
  orderId: string;
  playerIndex: number;
  side: MarketOrderSide;
  policy: ModelOrderPolicy;
  unitPrice: bigint;
  originalQuantity: bigint;
  filledQuantity: bigint;
  remainingQuantity: bigint;
  status: ModelOrderStatus;
  priority: number;
  escrowInitial: bigint;
  escrowRemaining: bigint;
  buyerFeeBps: number;
  sellerFeeBps: number;
};

type ModelTrade = {
  tradeId: string;
  buyOrderId: string;
  sellOrderId: string;
  makerOrderId: string;
  buyerPlayerId: string;
  sellerPlayerId: string;
  quantity: bigint;
  unitPrice: bigint;
  grossValue: bigint;
  buyerFee: bigint;
  sellerFee: bigint;
};

type ExpectedTrade = Omit<ModelTrade, "tradeId">;

type Replayable =
  | {
      kind: "order";
      actorIndex: number;
      input: CreateMarketOrderInput;
      snapshot: unknown;
    }
  | {
      kind: "cancel";
      actorIndex: number;
      requestId: string;
      orderId: string;
      snapshot: unknown;
    }
  | {
      kind: "claim";
      actorIndex: number;
      requestId: string;
      scope: MarketCollectionScope;
      snapshot: unknown;
    }
  | {
      kind: "simple";
      actorIndex: number;
      requestId: string;
      quoteId: string;
      maximumTotal: string;
      snapshot: unknown;
    };

type Coverage = {
  grants: number;
  grantReplays: number;
  creates: number;
  matches: number;
  partialFills: number;
  multiFills: number;
  cancellations: number;
  itemClaims: number;
  goldClaims: number;
  allClaims: number;
  requestReplays: number;
  retryableFailures: number;
  rollbacks: number;
  lostResponses: number;
  disconnects: number;
  reconnects: number;
  freezes: number;
  unfreezes: number;
  frozenRejections: number;
  quotes: number;
  simpleBuys: number;
};

class ReferenceMarketModel {
  readonly players: ModelPlayer[];
  readonly orders = new Map<string, ModelOrder>();
  readonly trades: ModelTrade[] = [];
  readonly requestKeys = new Set<string>();
  totalStoneMinted: bigint;
  totalGoldMinted: bigint;
  feeSink = 0n;
  collectionCount = 0;
  ledgerGroupCount = 0;
  claimCount = 0;
  quoteCount = 0;
  bookExists = false;
  bookFrozen = false;
  private nextPriority = 1;

  constructor(
    actors: MarketActor[],
    readonly buyerFeeBps: number,
    readonly sellerFeeBps: number
  ) {
    this.players = actors.map((actor) => ({
      actor,
      inventory: INITIAL_STONE,
      wallet: INITIAL_GOLD,
      itemCollection: 0n,
      goldCollection: 0n,
      connected: true
    }));
    this.totalStoneMinted = BigInt(actors.length) * INITIAL_STONE;
    this.totalGoldMinted = BigInt(actors.length) * INITIAL_GOLD;
  }

  grant(playerIndex: number, stone: bigint, gold: bigint): void {
    const player = this.players[playerIndex]!;
    player.inventory += stone;
    player.wallet += gold;
    this.totalStoneMinted += stone;
    this.totalGoldMinted += gold;
  }

  quote(playerIndex: number, quantity: bigint): {
    fillable: bigint;
    total: bigint;
    maximumUnitPrice: bigint | null;
  } {
    this.bookExists = true;
    this.quoteCount += 1;
    let fillable = 0n;
    let total = 0n;
    let maximumUnitPrice: bigint | null = null;
    for (const ask of this.liquidity("sell", playerIndex)) {
      if (fillable === quantity) break;
      const fill = min(quantity - fillable, ask.remainingQuantity);
      const gross = fill * ask.unitPrice;
      total += gross + fee(gross, this.buyerFeeBps);
      fillable += fill;
      maximumUnitPrice = ask.unitPrice;
    }
    return { fillable, total, maximumUnitPrice };
  }

  createOrder(input: {
    orderId: string;
    playerIndex: number;
    side: MarketOrderSide;
    policy: ModelOrderPolicy;
    quantity: bigint;
    unitPrice: bigint;
    requestId: string;
    escrowOverride?: bigint;
  }): ExpectedTrade[] {
    const player = this.players[input.playerIndex]!;
    const limitValue = input.quantity * input.unitPrice;
    const escrowInitial = input.side === "sell"
      ? input.quantity
      : input.escrowOverride ?? limitValue + fee(limitValue, this.buyerFeeBps);
    if (input.side === "sell") {
      expect(player.inventory, "reference-model sell precondition").toBeGreaterThanOrEqual(input.quantity);
      player.inventory -= input.quantity;
    } else {
      expect(player.wallet, "reference-model buy precondition").toBeGreaterThanOrEqual(escrowInitial);
      player.wallet -= escrowInitial;
    }
    const order: ModelOrder = {
      orderId: input.orderId,
      playerIndex: input.playerIndex,
      side: input.side,
      policy: input.policy,
      unitPrice: input.unitPrice,
      originalQuantity: input.quantity,
      filledQuantity: 0n,
      remainingQuantity: input.quantity,
      status: "open",
      priority: this.nextPriority,
      escrowInitial,
      escrowRemaining: escrowInitial,
      buyerFeeBps: this.buyerFeeBps,
      sellerFeeBps: this.sellerFeeBps
    };
    this.nextPriority += 1;
    this.orders.set(order.orderId, order);
    this.bookExists = true;
    this.requestKeys.add(requestKey(player.actor, input.requestId));
    this.ledgerGroupCount += 1;

    const expectedTrades: ExpectedTrade[] = [];
    const opposite = input.side === "buy" ? "sell" : "buy";
    for (const resting of this.liquidity(opposite, input.playerIndex, input.unitPrice)) {
      if (order.remainingQuantity === 0n) break;
      const quantity = min(order.remainingQuantity, resting.remainingQuantity);
      expectedTrades.push(this.settle(order, resting, quantity));
    }
    if (input.policy === "aon_ioc") {
      expect(order.remainingQuantity, "reference-model AON fill precondition").toBe(0n);
    }
    return expectedTrades;
  }

  attachTrades(expected: ExpectedTrade[], actual: MarketMutationResult["trades"], label: string): void {
    expect(actual, `${label} trade count`).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      const predicted = expected[index]!;
      const returned = actual[index]!;
      expect(
        {
          quantity: returned.quantity,
          unitPrice: returned.unitPrice,
          total: returned.total
        },
        `${label} trade ${index}`
      ).toEqual({
        quantity: predicted.quantity.toString(),
        unitPrice: predicted.unitPrice.toString(),
        total: predicted.grossValue.toString()
      });
      this.trades.push({ ...predicted, tradeId: returned.tradeId });
    }
  }

  cancel(orderId: string, requestId: string): void {
    const order = this.orders.get(orderId)!;
    const player = this.players[order.playerIndex]!;
    expect(["open", "partially_filled"]).toContain(order.status);
    if (order.side === "sell") {
      player.inventory += order.escrowRemaining;
    } else {
      player.wallet += order.escrowRemaining;
    }
    order.escrowRemaining = 0n;
    order.status = "cancelled";
    this.ledgerGroupCount += 1;
    this.requestKeys.add(requestKey(player.actor, requestId));
  }

  claim(playerIndex: number, requestId: string, scope: MarketCollectionScope): {
    items: bigint;
    gold: bigint;
  } {
    const player = this.players[playerIndex]!;
    const items = scope === "gold" ? 0n : player.itemCollection;
    const gold = scope === "items" ? 0n : player.goldCollection;
    player.itemCollection -= items;
    player.goldCollection -= gold;
    player.inventory += items;
    player.wallet += gold;
    this.requestKeys.add(requestKey(player.actor, requestId));
    this.claimCount += 1;
    if (items > 0n || gold > 0n) this.ledgerGroupCount += 1;
    return { items, gold };
  }

  openOrders(playerIndex?: number): ModelOrder[] {
    return [...this.orders.values()].filter((order) =>
      (order.status === "open" || order.status === "partially_filled") &&
      (playerIndex === undefined || order.playerIndex === playerIndex)
    );
  }

  private liquidity(
    side: MarketOrderSide,
    incomingPlayerIndex: number,
    incomingLimit?: bigint
  ): ModelOrder[] {
    const candidates = this.openOrders().filter((order) => {
      if (order.side !== side || order.playerIndex === incomingPlayerIndex) return false;
      if (incomingLimit === undefined) return true;
      return side === "sell" ? order.unitPrice <= incomingLimit : order.unitPrice >= incomingLimit;
    });
    return candidates.sort((left, right) => {
      if (left.unitPrice !== right.unitPrice) {
        const priceOrder = left.unitPrice < right.unitPrice ? -1 : 1;
        return side === "sell" ? priceOrder : -priceOrder;
      }
      return left.priority - right.priority;
    });
  }

  private settle(incoming: ModelOrder, resting: ModelOrder, quantity: bigint): ExpectedTrade {
    const buy = incoming.side === "buy" ? incoming : resting;
    const sell = incoming.side === "sell" ? incoming : resting;
    const buyer = this.players[buy.playerIndex]!;
    const seller = this.players[sell.playerIndex]!;
    const unitPrice = resting.unitPrice;
    const grossValue = unitPrice * quantity;
    const buyerFee = fee(grossValue, buy.buyerFeeBps);
    const sellerFee = fee(grossValue, sell.sellerFeeBps);
    const buyRemainingBefore = buy.escrowRemaining;

    applyFill(buy, quantity);
    applyFill(sell, quantity);
    sell.escrowRemaining -= quantity;
    const requiredAfter = buy.policy === "aon_ioc"
      ? buyRemainingBefore - grossValue - buyerFee
      : buy.unitPrice * buy.remainingQuantity + fee(buy.unitPrice * buy.remainingQuantity, buy.buyerFeeBps);
    const refund = buyRemainingBefore - requiredAfter - grossValue - buyerFee;
    expect(requiredAfter, "reference-model buy escrow").toBeGreaterThanOrEqual(0n);
    expect(refund, "reference-model price-improvement refund").toBeGreaterThanOrEqual(0n);
    buy.escrowRemaining = requiredAfter;

    buyer.inventory += quantity;
    const proceeds = grossValue - sellerFee;
    if (proceeds > 0n) {
      seller.wallet += proceeds;
    }
    if (refund > 0n) {
      buyer.wallet += refund;
    }
    this.feeSink += buyerFee + sellerFee;
    this.ledgerGroupCount += 1;

    return {
      buyOrderId: buy.orderId,
      sellOrderId: sell.orderId,
      makerOrderId: resting.orderId,
      buyerPlayerId: buyer.actor.playerId,
      sellerPlayerId: seller.actor.playerId,
      quantity,
      unitPrice,
      grossValue,
      buyerFee,
      sellerFee
    };
  }
}

describeDatabase("market generated reference-model state machine", () => {
  let pool: pg.Pool;
  let service: LegacyMarketTestService;
  let reconciliation: MarketReconciliationService;
  let inventory: InventoryService;
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    MARKET_GLOBAL_ACCESS: "true",
    MARKET_REQUESTS_PER_MINUTE: "10000",
    MARKET_CANCELLATIONS_PER_MINUTE: "10000"
  });

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 40 });
    await activateLegacyGlobalMarketForTest(pool);
    service = createLegacyMarketTestService(pool, config, createLogger("test"));
    reconciliation = new MarketReconciliationService(pool);
    inventory = new InventoryService(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it(`runs ${PROPERTY_CASES}x${STEPS_PER_CASE} deterministic live-PostgreSQL steps from seed ${PROPERTY_SEED}`, async () => {
    const random = mulberry32(PROPERTY_SEED);
    const coverage = emptyCoverage();
    for (let caseIndex = 0; caseIndex < PROPERTY_CASES; caseIndex += 1) {
      const seeded = await resetAndSeed(pool, caseIndex, ACTOR_COUNT, INITIAL_GOLD, INITIAL_STONE);
      const model = new ReferenceMarketModel(seeded.actors, seeded.buyerFeeBps, seeded.sellerFeeBps);
      const replayables: Replayable[] = [];
      const grantKey = `property-grant-${caseIndex}-0`;

      for (let step = 0; step < STEPS_PER_CASE; step += 1) {
        const label = `seed=${PROPERTY_SEED} case=${caseIndex} step=${step}`;
        await executeStep({
          pool,
          service,
          inventory,
          config,
          model,
          replayables,
          coverage,
          random,
          caseIndex,
          step,
          grantKey,
          label
        });
        await expectModelMatchesDatabase(pool, model, label);
        const report = await reconciliation.reconcile({ honorAutomaticProtection: false });
        expect(report.issues, `${label} reconciliation`).toEqual([]);
      }
    }

    expect(coverage.grants).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.grantReplays).toBe(PROPERTY_CASES);
    expect(coverage.creates).toBeGreaterThan(PROPERTY_CASES * 7);
    expect(coverage.matches).toBeGreaterThanOrEqual(PROPERTY_CASES * 5);
    expect(coverage.partialFills).toBeGreaterThanOrEqual(PROPERTY_CASES * 2);
    expect(coverage.multiFills).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.cancellations).toBeGreaterThanOrEqual(PROPERTY_CASES * 2);
    expect(coverage.itemClaims).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.goldClaims).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.allClaims).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.requestReplays).toBeGreaterThanOrEqual(PROPERTY_CASES * 3);
    expect(coverage.retryableFailures).toBe(PROPERTY_CASES);
    expect(coverage.rollbacks).toBeGreaterThanOrEqual(PROPERTY_CASES * 2);
    expect(coverage.lostResponses).toBe(PROPERTY_CASES);
    expect(coverage.disconnects).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.reconnects).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.freezes).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.unfreezes).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.frozenRejections).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.quotes).toBeGreaterThanOrEqual(PROPERTY_CASES);
    expect(coverage.simpleBuys).toBeGreaterThanOrEqual(PROPERTY_CASES);
  }, 600_000);
});

type StepContext = {
  pool: pg.Pool;
  service: LegacyMarketTestService;
  inventory: InventoryService;
  config: ReturnType<typeof loadConfig>;
  model: ReferenceMarketModel;
  replayables: Replayable[];
  coverage: Coverage;
  random: () => number;
  caseIndex: number;
  step: number;
  grantKey: string;
  label: string;
};

async function executeStep(context: StepContext): Promise<void> {
  const { caseIndex, step } = context;
  switch (step) {
    case 0:
      await grantAssets(context, 0, context.grantKey, 7n, 113n, true);
      return;
    case 1:
      await createOrder(context, 0, "sell", 5n, 8n, "forced-partial-ask");
      return;
    case 2:
      await createOrder(context, 1, "buy", 2n, 8n, "forced-partial-cross");
      return;
    case 3:
      await createOrder(context, 2, "sell", 2n, 7n, "forced-second-ask");
      return;
    case 4:
      await createOrder(context, 3, "buy", 4n, 8n, "forced-multi-cross");
      return;
    case 5:
      await claim(context, 1, "items", "forced-item-claim");
      return;
    case 6:
      await claim(context, 0, "gold", "forced-gold-claim");
      return;
    case 7:
      await createOrder(context, 4, "buy", 3n, 2n, "forced-cancel-target");
      return;
    case 8: {
      const target = context.model.openOrders(4)[0]!;
      await cancel(context, target, "forced-cancel");
      return;
    }
    case 9:
      await replay(context, context.replayables.at(-1)!);
      return;
    case 10:
      await setConnection(context, 5, false);
      return;
    case 11:
      await setConnection(context, 5, true);
      return;
    case 12:
      await setBookFrozen(context, true);
      return;
    case 13: {
      const input = orderInput(caseIndex, step, "frozen-rejection", "sell", 1n, 9n);
      await expectMarketCode(context.service.createOrder(context.model.players[5]!.actor, input), "MARKET_ITEM_FROZEN");
      context.coverage.frozenRejections += 1;
      return;
    }
    case 14:
      await setBookFrozen(context, false);
      return;
    case 15:
      await createOrder(context, 5, "sell", 4n, 6n, "forced-simple-liquidity");
      return;
    case 16:
      await quoteAndSimpleBuy(context, 6, 3n, "forced-simple-buy");
      return;
    case 17:
      await rollbackOrder(context, 7);
      return;
    case 18:
      await retryableOrder(context, 7);
      return;
    case 19:
      await lostResponseOrder(context, 6);
      return;
    case 20:
      await claim(context, 6, "all", "forced-all-claim");
      return;
    case 21:
      await grantAssets(context, 0, context.grantKey, 7n, 113n, false);
      return;
    case 22: {
      const simple = context.replayables.find((entry) => entry.kind === "simple")!;
      await replay(context, simple);
      return;
    }
    case 23:
      await rollbackClaim(context, 3);
      return;
    case 24: {
      const target = context.model.openOrders(0)[0];
      if (target) await cancel(context, target, "forced-partial-cancel");
      else await claim(context, 0, "all", "forced-cancel-fallback");
      return;
    }
    default:
      await executeRandomStep(context);
  }
}

async function executeRandomStep(context: StepContext): Promise<void> {
  const choice = randomInt(context.random, 100);
  const connected = context.model.players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => player.connected);
  const playerIndex = connected[randomInt(context.random, connected.length)]!.index;
  if (choice < 40) {
    const side: MarketOrderSide = context.random() < 0.52 ? "sell" : "buy";
    const quantity = BigInt(1 + randomInt(context.random, 6));
    const unitPrice = BigInt(3 + randomInt(context.random, 12));
    if (side === "sell" && context.model.players[playerIndex]!.inventory < quantity) {
      await grantAssets(context, playerIndex, `property-grant-${context.caseIndex}-${context.step}`, 9n, 0n, true);
      return;
    }
    if (context.model.bookFrozen) {
      const input = orderInput(context.caseIndex, context.step, "random-frozen", side, quantity, unitPrice);
      await expectMarketCode(context.service.createOrder(context.model.players[playerIndex]!.actor, input), "MARKET_ITEM_FROZEN");
      context.coverage.frozenRejections += 1;
      return;
    }
    await createOrder(context, playerIndex, side, quantity, unitPrice, "random-order");
    return;
  }
  if (choice < 52) {
    const candidates = context.model.openOrders().filter((order) => context.model.players[order.playerIndex]!.connected);
    if (candidates.length === 0) {
      await claim(context, playerIndex, "all", "random-empty-cancel-claim");
      return;
    }
    const target = candidates[randomInt(context.random, candidates.length)]!;
    if (context.model.bookFrozen) {
      const id = requestId(context, "random-frozen-cancel");
      await expectMarketCode(
        context.service.cancelOrder(context.model.players[target.playerIndex]!.actor, id, target.orderId),
        "MARKET_ITEM_FROZEN"
      );
      context.coverage.frozenRejections += 1;
      return;
    }
    await cancel(context, target, "random-cancel");
    return;
  }
  if (choice < 67) {
    const scopes: MarketCollectionScope[] = ["items", "gold", "all"];
    await claim(context, playerIndex, scopes[randomInt(context.random, scopes.length)]!, "random-claim");
    return;
  }
  if (choice < 76 && context.replayables.length > 0) {
    await replay(context, context.replayables[randomInt(context.random, context.replayables.length)]!);
    return;
  }
  if (choice < 84) {
    await grantAssets(
      context,
      playerIndex,
      `property-grant-${context.caseIndex}-${context.step}`,
      BigInt(1 + randomInt(context.random, 8)),
      BigInt(1 + randomInt(context.random, 30)),
      true
    );
    return;
  }
  if (choice < 90) {
    await setBookFrozen(context, !context.model.bookFrozen);
    return;
  }
  if (choice < 95) {
    const disconnectable = context.model.players
      .map((player, index) => ({ player, index }))
      .filter(({ player }) => player.connected);
    const reconnectable = context.model.players
      .map((player, index) => ({ player, index }))
      .filter(({ player }) => !player.connected);
    if (reconnectable.length > 0 && (disconnectable.length <= 1 || context.random() < 0.5)) {
      await setConnection(context, reconnectable[randomInt(context.random, reconnectable.length)]!.index, true);
    } else if (disconnectable.length > 1) {
      await setConnection(context, disconnectable[randomInt(context.random, disconnectable.length)]!.index, false);
    } else {
      await claim(context, playerIndex, "all", "random-connection-fallback");
    }
    return;
  }
  await quoteAndSimpleBuy(context, playerIndex, BigInt(1 + randomInt(context.random, 4)), "random-simple");
}

async function createOrder(
  context: StepContext,
  playerIndex: number,
  side: MarketOrderSide,
  quantity: bigint,
  unitPrice: bigint,
  suffix: string,
  overrideService = context.service
): Promise<MarketMutationResult> {
  const actor = context.model.players[playerIndex]!.actor;
  const input = orderInput(context.caseIndex, context.step, suffix, side, quantity, unitPrice);
  const result = await overrideService.createOrder(actor, input);
  commitCreatedOrder(context, playerIndex, input, result, "gtc");
  context.replayables.push({ kind: "order", actorIndex: playerIndex, input, snapshot: replaySnapshot(result) });
  return result;
}

function commitCreatedOrder(
  context: StepContext,
  playerIndex: number,
  input: CreateMarketOrderInput,
  result: MarketMutationResult,
  policy: ModelOrderPolicy,
  escrowOverride?: bigint
): void {
  expect(result.order, `${context.label} created order`).not.toBeNull();
  const expectedTrades = context.model.createOrder({
    orderId: result.order!.orderId,
    playerIndex,
    side: input.side,
    policy,
    quantity: BigInt(input.quantity),
    unitPrice: BigInt(input.unitPrice),
    requestId: input.requestId,
    ...(escrowOverride === undefined ? {} : { escrowOverride })
  });
  context.model.attachTrades(expectedTrades, result.trades, context.label);
  const expectedOrder = context.model.orders.get(result.order!.orderId)!;
  expect(
    {
      side: result.order!.side,
      policy: result.order!.policy,
      unitPrice: result.order!.unitPrice,
      originalQuantity: result.order!.originalQuantity,
      filledQuantity: result.order!.filledQuantity,
      remainingQuantity: result.order!.remainingQuantity,
      status: result.order!.status
    },
    `${context.label} origin order snapshot`
  ).toEqual({
    side: expectedOrder.side,
    policy: expectedOrder.policy,
    unitPrice: expectedOrder.unitPrice.toString(),
    originalQuantity: expectedOrder.originalQuantity.toString(),
    filledQuantity: expectedOrder.filledQuantity.toString(),
    remainingQuantity: expectedOrder.remainingQuantity.toString(),
    status: expectedOrder.status
  });
  context.coverage.creates += 1;
  context.coverage.matches += expectedTrades.length;
  if (expectedTrades.length > 1) context.coverage.multiFills += 1;
  if ([...context.model.orders.values()].some((order) => order.status === "partially_filled")) {
    context.coverage.partialFills += 1;
  }
}

async function cancel(context: StepContext, order: ModelOrder, suffix: string): Promise<void> {
  const actor = context.model.players[order.playerIndex]!.actor;
  const id = requestId(context, suffix);
  const result = await context.service.cancelOrder(actor, id, order.orderId);
  context.model.cancel(order.orderId, id);
  expect(result.order?.status, `${context.label} cancelled order snapshot`).toBe("cancelled");
  context.replayables.push({
    kind: "cancel",
    actorIndex: order.playerIndex,
    requestId: id,
    orderId: order.orderId,
    snapshot: replaySnapshot(result)
  });
  context.coverage.cancellations += 1;
}

async function claim(
  context: StepContext,
  playerIndex: number,
  scope: MarketCollectionScope,
  suffix: string
): Promise<void> {
  const actor = context.model.players[playerIndex]!.actor;
  const id = requestId(context, suffix);
  const result = await context.service.claim(actor, id, scope);
  const expected = context.model.claim(playerIndex, id, scope);
  expect(
    { items: result.claimedItems, gold: result.claimedGold },
    `${context.label} claim result`
  ).toEqual({ items: expected.items.toString(), gold: expected.gold.toString() });
  context.replayables.push({
    kind: "claim",
    actorIndex: playerIndex,
    requestId: id,
    scope,
    snapshot: replaySnapshot(result)
  });
  if (scope === "items") context.coverage.itemClaims += 1;
  else if (scope === "gold") context.coverage.goldClaims += 1;
  else context.coverage.allClaims += 1;
}

async function replay(context: StepContext, operation: Replayable): Promise<void> {
  const actor = context.model.players[operation.actorIndex]!.actor;
  let result: MarketMutationResult;
  if (operation.kind === "order") result = await context.service.createOrder(actor, operation.input);
  else if (operation.kind === "cancel") {
    result = await context.service.cancelOrder(actor, operation.requestId, operation.orderId);
  } else if (operation.kind === "claim") {
    result = await context.service.claim(actor, operation.requestId, operation.scope);
  } else {
    result = await context.service.simpleBuy(actor, operation.requestId, operation.quoteId, operation.maximumTotal);
  }
  expect(result.replayed, `${context.label} replay flag`).toBe(true);
  expect(replaySnapshot(result), `${context.label} replay payload`).toEqual(operation.snapshot);
  context.coverage.requestReplays += 1;
}

async function quoteAndSimpleBuy(
  context: StepContext,
  playerIndex: number,
  quantity: bigint,
  suffix: string
): Promise<void> {
  const actor = context.model.players[playerIndex]!.actor;
  const quoteId = requestId(context, `${suffix}-quote`);
  const expectedQuote = context.model.quote(playerIndex, quantity);
  const quote = await context.service.quote(actor, quoteId, "stone", quantity.toString());
  context.coverage.quotes += 1;
  expect(
    {
      fillableQuantity: quote.fillableQuantity,
      quotedTotal: quote.quotedTotal,
      maximumUnitPrice: quote.maximumUnitPrice,
      fullQuantityAvailable: quote.fullQuantityAvailable
    },
    `${context.label} independent quote`
  ).toEqual({
    fillableQuantity: expectedQuote.fillable.toString(),
    quotedTotal: expectedQuote.total.toString(),
    maximumUnitPrice: expectedQuote.maximumUnitPrice?.toString() ?? null,
    fullQuantityAvailable: expectedQuote.fillable === quantity
  });
  if (expectedQuote.fillable !== quantity || expectedQuote.maximumUnitPrice === null) return;
  const id = requestId(context, suffix);
  if (context.model.bookFrozen) {
    await expectMarketCode(
      context.service.simpleBuy(actor, id, quote.quoteId, expectedQuote.total.toString()),
      "MARKET_ITEM_FROZEN"
    );
    context.coverage.frozenRejections += 1;
    return;
  }
  const result = await context.service.simpleBuy(actor, id, quote.quoteId, expectedQuote.total.toString());
  const input: CreateMarketOrderInput = {
    requestId: id,
    interface: "simple",
    side: "buy",
    itemId: "stone",
    quantity: quantity.toString(),
    unitPrice: expectedQuote.maximumUnitPrice.toString()
  };
  commitCreatedOrder(context, playerIndex, input, result, "aon_ioc", expectedQuote.total);
  context.replayables.push({
    kind: "simple",
    actorIndex: playerIndex,
    requestId: id,
    quoteId: quote.quoteId,
    maximumTotal: expectedQuote.total.toString(),
    snapshot: replaySnapshot(result)
  });
  context.coverage.simpleBuys += 1;
}

async function grantAssets(
  context: StepContext,
  playerIndex: number,
  operationKey: string,
  stone: bigint,
  gold: bigint,
  expectApplied: boolean
): Promise<void> {
  const actor = context.model.players[playerIndex]!.actor;
  const itemResult = stone > 0n
    ? await context.inventory.grantItemsForOperation({
        operationKey: `${operationKey}:stone`,
        playerId: actor.playerId,
        source: "market_property_grant",
        sourceEntityType: "market_property_case",
        sourceEntityId: String(context.caseIndex),
        metadata: { seed: PROPERTY_SEED, caseIndex: context.caseIndex, step: context.step },
        grants: [{ itemId: "stone", variant: null, quantity: Number(stone) }]
      })
    : { applied: false };
  const goldApplied = gold > 0n
    ? await grantWallet(poolFor(context), actor, `${operationKey}:gold`, gold)
    : false;
  if (stone > 0n) expect(itemResult.applied, `${context.label} inventory grant replay`).toBe(expectApplied);
  if (gold > 0n) expect(goldApplied, `${context.label} wallet grant replay`).toBe(expectApplied);
  if (expectApplied) {
    context.model.grant(playerIndex, stone, gold);
    context.coverage.grants += 1;
  } else {
    context.coverage.grantReplays += 1;
  }
}

async function retryableOrder(context: StepContext, playerIndex: number): Promise<void> {
  const retrying = createLegacyMarketTestService(context.pool, context.config, createLogger("test"), {
    faultInjector: retryOnceAt("before_commit")
  });
  await createOrder(context, playerIndex, "sell", 2n, 20n, "forced-retryable", retrying);
  expect(retrying.metricsSnapshot().serializationFailures, `${context.label} serialization retry`).toBe(1);
  expect(retrying.metricsSnapshot().retries, `${context.label} retry count`).toBe(1);
  context.coverage.retryableFailures += 1;
}

async function rollbackOrder(context: StepContext, playerIndex: number): Promise<void> {
  const actor = context.model.players[playerIndex]!.actor;
  const input = orderInput(context.caseIndex, context.step, "forced-rollback", "sell", 2n, 20n);
  const faulted = createLegacyMarketTestService(context.pool, context.config, createLogger("test"), {
    faultInjector: failOnceAt("after_inventory_debit")
  });
  await expect(faulted.createOrder(actor, input)).rejects.toThrow("injected:after_inventory_debit");
  context.coverage.rollbacks += 1;
}

async function rollbackClaim(context: StepContext, playerIndex: number): Promise<void> {
  const actor = context.model.players[playerIndex]!.actor;
  const faulted = createLegacyMarketTestService(context.pool, context.config, createLogger("test"), {
    faultInjector: failOnceAt("during_claim")
  });
  await expect(faulted.claim(actor, requestId(context, "forced-claim-rollback"), "items"))
    .rejects.toThrow("injected:during_claim");
  context.coverage.rollbacks += 1;
}

async function lostResponseOrder(context: StepContext, playerIndex: number): Promise<void> {
  const actor = context.model.players[playerIndex]!.actor;
  const input = orderInput(context.caseIndex, context.step, "forced-lost-response", "buy", 1n, 20n);
  const faulted = createLegacyMarketTestService(context.pool, context.config, createLogger("test"), {
    faultInjector: failOnceAt("after_commit_before_response")
  });
  await expect(faulted.createOrder(actor, input)).rejects.toThrow("injected:after_commit_before_response");
  const replayed = await context.service.createOrder(actor, input);
  expect(replayed.replayed, `${context.label} lost response replay`).toBe(true);
  commitCreatedOrder(context, playerIndex, input, replayed, "gtc");
  context.replayables.push({
    kind: "order",
    actorIndex: playerIndex,
    input,
    snapshot: replaySnapshot(replayed)
  });
  context.coverage.lostResponses += 1;
  context.coverage.requestReplays += 1;
}

async function setConnection(context: StepContext, playerIndex: number, connected: boolean): Promise<void> {
  const player = context.model.players[playerIndex]!;
  await context.pool.query("UPDATE players SET online=$2 WHERE id=$1", [player.actor.playerId, connected]);
  player.connected = connected;
  if (connected) {
    const reconnected = createLegacyMarketTestService(context.pool, context.config, createLogger("test"));
    const snapshot = await reconnected.read.snapshot(player.actor);
    expect(snapshot.player.walletGold, `${context.label} reconnect snapshot`).toBe(player.wallet.toString());
    context.coverage.reconnects += 1;
  } else {
    context.coverage.disconnects += 1;
  }
}

async function setBookFrozen(context: StepContext, frozen: boolean): Promise<void> {
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");
    await setMarketControlAuditContext(client, {
      operatorIdentity: "market-property-test",
      reason: frozen ? "exercise property book freeze" : "restore property book after freeze"
    });
    const result = await client.query(
      "UPDATE market_order_books SET frozen=$1 WHERE item_id='stone'",
      [frozen]
    );
    expect(result.rowCount, `${context.label} freeze book exists`).toBe(1);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  context.model.bookFrozen = frozen;
  if (frozen) context.coverage.freezes += 1;
  else context.coverage.unfreezes += 1;
}

async function expectModelMatchesDatabase(
  pool: pg.Pool,
  model: ReferenceMarketModel,
  label: string
): Promise<void> {
  const playerIds = model.players.map((player) => player.actor.playerId);
  const [players, orders, trades, summary, books] = await Promise.all([
    pool.query<{
      player_id: string;
      online: boolean;
      inventory: string;
      wallet: string;
      item_collection: string;
      gold_collection: string;
    }>(
      `SELECT p.id AS player_id, p.online,
              coalesce((SELECT quantity FROM player_inventory i
                        WHERE i.player_id=p.id AND i.resource_type='stone' AND i.variant='default'),0)::text AS inventory,
              coalesce((SELECT gold_balance FROM player_wallets w WHERE w.player_id=p.id),0)::text AS wallet,
              coalesce((SELECT sum(remaining_amount) FROM market_collections c
                        WHERE c.player_id=p.id AND c.asset_kind='item'),0)::text AS item_collection,
              coalesce((SELECT sum(remaining_amount) FROM market_collections c
                        WHERE c.player_id=p.id AND c.asset_kind='gold'),0)::text AS gold_collection
       FROM players p WHERE p.id=ANY($1::text[]) ORDER BY p.id`,
      [playerIds]
    ),
    pool.query<{
      order_id: string;
      player_id: string;
      side: MarketOrderSide;
      order_policy: ModelOrderPolicy;
      limit_unit_price: string;
      original_quantity: string;
      filled_quantity: string;
      remaining_quantity: string;
      status: ModelOrderStatus;
      initial_amount: string;
      escrow_remaining: string;
    }>(
      `SELECT o.order_id, o.player_id, o.side, o.order_policy,
              o.limit_unit_price::text, o.original_quantity::text,
              o.filled_quantity::text, o.remaining_quantity::text, o.status,
              e.initial_amount::text, e.remaining_amount::text AS escrow_remaining
       FROM market_orders o JOIN market_order_escrows e USING (order_id)
       ORDER BY o.order_id`
    ),
    pool.query<{
      trade_id: string;
      buy_order_id: string;
      sell_order_id: string;
      maker_order_id: string;
      buyer_player_id: string;
      seller_player_id: string;
      quantity: string;
      unit_price: string;
      gross_value: string;
      buyer_fee: string;
      seller_fee: string;
    }>(
      `SELECT trade_id, buy_order_id, sell_order_id, maker_order_id,
              buyer_player_id, seller_player_id, quantity::text, unit_price::text,
              gross_value::text, buyer_fee::text, seller_fee::text
       FROM market_trades ORDER BY trade_id`
    ),
    pool.query<{
      items: string;
      gold: string;
      fee_sink: string;
      request_count: string;
      claim_count: string;
      quote_count: string;
      collection_count: string;
      ledger_group_count: string;
      invalid_orders: string;
      unbalanced_groups: string;
    }>(
      `SELECT
         ((SELECT coalesce(sum(quantity),0)::numeric FROM player_inventory WHERE resource_type='stone') +
          (SELECT coalesce(sum(e.remaining_amount),0)::numeric FROM market_order_escrows e
           JOIN market_orders o USING(order_id) WHERE e.asset_kind='item' AND o.item_id='stone') +
          (SELECT coalesce(sum(remaining_amount),0)::numeric FROM market_collections
           WHERE asset_kind='item' AND item_id='stone'))::text AS items,
         ((SELECT coalesce(sum(gold_balance),0)::numeric FROM player_wallets) +
          (SELECT coalesce(sum(remaining_amount),0)::numeric FROM market_order_escrows WHERE asset_kind='gold') +
          (SELECT coalesce(sum(remaining_amount),0)::numeric FROM market_collections WHERE asset_kind='gold') +
          (SELECT coalesce(sum(amount),0)::numeric FROM market_ledger_entries WHERE account_location='fee_sink'))::text AS gold,
         (SELECT coalesce(sum(amount),0)::text FROM market_ledger_entries WHERE account_location='fee_sink') AS fee_sink,
         (SELECT count(*)::text FROM market_requests) AS request_count,
         (SELECT count(*)::text FROM market_claims) AS claim_count,
         (SELECT count(*)::text FROM market_quotes) AS quote_count,
         (SELECT count(*)::text FROM market_collections) AS collection_count,
         (SELECT count(*)::text FROM market_ledger_groups) AS ledger_group_count,
         (SELECT count(*)::text FROM market_orders
          WHERE filled_quantity<0 OR remaining_quantity<0
             OR filled_quantity+remaining_quantity<>original_quantity) AS invalid_orders,
         (SELECT count(*)::text FROM (
            SELECT ledger_group_id, asset_kind, item_identity
            FROM market_ledger_entries GROUP BY ledger_group_id, asset_kind, item_identity
            HAVING sum(amount)<>0
          ) bad) AS unbalanced_groups`
    ),
    pool.query<{ frozen: boolean }>("SELECT frozen FROM market_order_books WHERE item_id='stone'")
  ]);

  const playerRows = new Map(players.rows.map((row) => [row.player_id, row]));
  for (const expected of model.players) {
    const actual = playerRows.get(expected.actor.playerId);
    expect(actual, `${label} player ${expected.actor.playerId}`).toBeDefined();
    expect(
      {
        online: actual!.online,
        inventory: actual!.inventory,
        wallet: actual!.wallet,
        itemCollection: actual!.item_collection,
        goldCollection: actual!.gold_collection
      },
      `${label} player ${expected.actor.playerId}`
    ).toEqual({
      online: expected.connected,
      inventory: expected.inventory.toString(),
      wallet: expected.wallet.toString(),
      itemCollection: expected.itemCollection.toString(),
      goldCollection: expected.goldCollection.toString()
    });
  }

  expect(orders.rows, `${label} order count`).toHaveLength(model.orders.size);
  const orderRows = new Map(orders.rows.map((row) => [row.order_id, row]));
  for (const expected of model.orders.values()) {
    const actual = orderRows.get(expected.orderId);
    expect(actual, `${label} order ${expected.orderId}`).toBeDefined();
    expect(
      {
        playerId: actual!.player_id,
        side: actual!.side,
        policy: actual!.order_policy,
        unitPrice: actual!.limit_unit_price,
        original: actual!.original_quantity,
        filled: actual!.filled_quantity,
        remaining: actual!.remaining_quantity,
        status: actual!.status,
        escrowInitial: actual!.initial_amount,
        escrowRemaining: actual!.escrow_remaining
      },
      `${label} order ${expected.orderId}`
    ).toEqual({
      playerId: model.players[expected.playerIndex]!.actor.playerId,
      side: expected.side,
      policy: expected.policy,
      unitPrice: expected.unitPrice.toString(),
      original: expected.originalQuantity.toString(),
      filled: expected.filledQuantity.toString(),
      remaining: expected.remainingQuantity.toString(),
      status: expected.status,
      escrowInitial: expected.escrowInitial.toString(),
      escrowRemaining: expected.escrowRemaining.toString()
    });
  }

  expect(trades.rows, `${label} trade count`).toHaveLength(model.trades.length);
  const tradeRows = new Map(trades.rows.map((row) => [row.trade_id, row]));
  for (const expected of model.trades) {
    const actual = tradeRows.get(expected.tradeId);
    expect(actual, `${label} trade ${expected.tradeId}`).toBeDefined();
    expect(
      {
        buyOrderId: actual!.buy_order_id,
        sellOrderId: actual!.sell_order_id,
        makerOrderId: actual!.maker_order_id,
        buyerPlayerId: actual!.buyer_player_id,
        sellerPlayerId: actual!.seller_player_id,
        quantity: actual!.quantity,
        unitPrice: actual!.unit_price,
        grossValue: actual!.gross_value,
        buyerFee: actual!.buyer_fee,
        sellerFee: actual!.seller_fee
      },
      `${label} trade ${expected.tradeId}`
    ).toEqual({
      buyOrderId: expected.buyOrderId,
      sellOrderId: expected.sellOrderId,
      makerOrderId: expected.makerOrderId,
      buyerPlayerId: expected.buyerPlayerId,
      sellerPlayerId: expected.sellerPlayerId,
      quantity: expected.quantity.toString(),
      unitPrice: expected.unitPrice.toString(),
      grossValue: expected.grossValue.toString(),
      buyerFee: expected.buyerFee.toString(),
      sellerFee: expected.sellerFee.toString()
    });
  }

  const aggregate = summary.rows[0]!;
  expect(BigInt(aggregate.items), `${label} database item conservation`).toBe(model.totalStoneMinted);
  expect(BigInt(aggregate.gold), `${label} database gold conservation`).toBe(model.totalGoldMinted);
  expect(BigInt(aggregate.fee_sink), `${label} fee sink`).toBe(model.feeSink);
  expect(Number(aggregate.request_count), `${label} request count`).toBe(model.requestKeys.size);
  expect(Number(aggregate.claim_count), `${label} claim count`).toBe(model.claimCount);
  expect(Number(aggregate.quote_count), `${label} quote count`).toBe(model.quoteCount);
  expect(Number(aggregate.collection_count), `${label} collection count`).toBe(model.collectionCount);
  expect(Number(aggregate.ledger_group_count), `${label} ledger group count`).toBe(model.ledgerGroupCount);
  expect(aggregate.invalid_orders, `${label} invalid order state`).toBe("0");
  expect(aggregate.unbalanced_groups, `${label} unbalanced journal groups`).toBe("0");
  expect(books.rows, `${label} book cardinality`).toHaveLength(model.bookExists ? 1 : 0);
  if (model.bookExists) expect(books.rows[0]!.frozen, `${label} book freeze`).toBe(model.bookFrozen);

  const modelItems = model.players.reduce(
    (sum, player) => sum + player.inventory + player.itemCollection,
    [...model.orders.values()].reduce((sum, order) => sum + (order.side === "sell" ? order.escrowRemaining : 0n), 0n)
  );
  const modelGold = model.players.reduce(
    (sum, player) => sum + player.wallet + player.goldCollection,
    model.feeSink + [...model.orders.values()].reduce(
      (sum, order) => sum + (order.side === "buy" ? order.escrowRemaining : 0n),
      0n
    )
  );
  expect(modelItems, `${label} reference item conservation`).toBe(model.totalStoneMinted);
  expect(modelGold, `${label} reference gold conservation`).toBe(model.totalGoldMinted);
}

async function resetAndSeed(
  pool: pg.Pool,
  caseIndex: number,
  count: number,
  gold: bigint,
  stone: bigint
): Promise<{ actors: MarketActor[]; buyerFeeBps: number; sellerFeeBps: number }> {
  await pool.query("TRUNCATE market_order_books CASCADE");
  await pool.query("TRUNCATE accounts CASCADE");
  await activateLegacyGlobalMarketForTest(pool);
  const controlClient = await pool.connect();
  try {
    await controlClient.query("BEGIN");
    await setMarketControlAuditContext(controlClient, {
      operatorIdentity: "market-property-test",
      reason: "reset dedicated property-test controls"
    });
    await controlClient.query(
      `UPDATE market_global_controls SET read_only=false, new_orders_enabled=true,
        matching_enabled=true, cancellations_enabled=true, claims_enabled=true`
    );
    await controlClient.query("COMMIT");
  } catch (error) {
    await controlClient.query("ROLLBACK");
    throw error;
  } finally {
    controlClient.release();
  }
  const actors: MarketActor[] = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(caseIndex * 100 + index + 1).padStart(12, "0");
    const actor = {
      playerId: `property-${caseIndex}-${index}`,
      accountId: `10000000-0000-4000-8000-${suffix}`
    };
    actors.push(actor);
    await pool.query("INSERT INTO accounts (id, status, trust_tier) VALUES ($1,'active','standard')", [actor.accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$3,$3,'NM',35,-106,35,-106,900,true,
                 ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [actor.playerId, actor.accountId, actor.playerId]
    );
    const inventoryKey = `property-seed-items:${actor.playerId}`;
    const seedClient = await pool.connect();
    try {
      await seedClient.query("BEGIN");
      await seedClient.query(
        `INSERT INTO inventory_operations (operation_key, player_id, source)
         VALUES ($1,$2,'market_property_seed')`,
        [inventoryKey, actor.playerId]
      );
      await seedClient.query(
        `INSERT INTO player_inventory (
           player_id, resource_type, variant, quantity, version
         ) VALUES ($1,'stone','default',$2,1)`,
        [actor.playerId, stone.toString()]
      );
      await seedClient.query(
        `INSERT INTO inventory_events (
           operation_key, player_id, item_id, variant, delta_quantity,
           quantity_after, version_after, source
         ) VALUES ($1,$2,'stone','default',$3,$3,1,'market_property_seed')`,
        [inventoryKey, actor.playerId, stone.toString()]
      );
      await seedClient.query(
        `INSERT INTO player_wallets (player_id, account_id, gold_balance, version)
         VALUES ($1,$2,$3,1)`,
        [actor.playerId, actor.accountId, gold.toString()]
      );
      await seedClient.query(
        `INSERT INTO wallet_events (
           operation_key, player_id, account_id, delta_gold, balance_after,
           version_after, reason
         ) VALUES ($1,$2,$3,$4,$4,1,'market_property_seed')`,
        [`property-seed-gold:${actor.playerId}`, actor.playerId, actor.accountId, gold.toString()]
      );
      await seedClient.query("COMMIT");
    } catch (error) {
      await seedClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      seedClient.release();
    }
  }
  const feePolicy = await pool.query<{ buyer_fee_bps: number; seller_fee_bps: number; listing_fee: string; cancellation_fee: string }>(
    `SELECT fp.buyer_fee_bps, fp.seller_fee_bps,
            fp.listing_fee::text, fp.cancellation_fee::text
     FROM market_venues v JOIN market_fee_policies fp ON fp.fee_policy_id=v.fee_policy_id
     WHERE v.venue_key='global'`
  );
  expect(feePolicy.rows[0]?.listing_fee).toBe("0");
  expect(feePolicy.rows[0]?.cancellation_fee).toBe("0");
  return {
    actors,
    buyerFeeBps: feePolicy.rows[0]!.buyer_fee_bps,
    sellerFeeBps: feePolicy.rows[0]!.seller_fee_bps
  };
}

async function grantWallet(
  pool: pg.Pool,
  actor: MarketActor,
  operationKey: string,
  amount: bigint
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replay = await client.query<{ delta_gold: string }>(
      `SELECT delta_gold::text FROM wallet_events
       WHERE operation_key=$1 AND player_id=$2 FOR UPDATE`,
      [operationKey, actor.playerId]
    );
    if (replay.rows[0]) {
      expect(replay.rows[0].delta_gold).toBe(amount.toString());
      await client.query("COMMIT");
      return false;
    }
    const updated = await client.query<{ gold_balance: string; version: string }>(
      `UPDATE player_wallets SET gold_balance=gold_balance+$3, version=version+1
       WHERE player_id=$1 AND account_id=$2
       RETURNING gold_balance::text, version::text`,
      [actor.playerId, actor.accountId, amount.toString()]
    );
    expect(updated.rows[0]).toBeDefined();
    await client.query(
      `INSERT INTO wallet_events (
         operation_key, player_id, account_id, delta_gold, balance_after,
         version_after, reason, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,'market_property_grant',$7::jsonb)`,
      [
        operationKey,
        actor.playerId,
        actor.accountId,
        amount.toString(),
        updated.rows[0]!.gold_balance,
        updated.rows[0]!.version,
        JSON.stringify({ seed: PROPERTY_SEED })
      ]
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function orderInput(
  caseIndex: number,
  step: number,
  suffix: string,
  side: MarketOrderSide,
  quantity: bigint,
  unitPrice: bigint
): CreateMarketOrderInput {
  return {
    requestId: `property-${caseIndex}-${step}-${suffix}`,
    interface: suffix.includes("simple") ? "simple" : "merchant",
    side,
    itemId: "stone",
    quantity: quantity.toString(),
    unitPrice: unitPrice.toString()
  };
}

function requestId(context: Pick<StepContext, "caseIndex" | "step">, suffix: string): string {
  return `property-${context.caseIndex}-${context.step}-${suffix}`;
}

function requestKey(actor: MarketActor, id: string): string {
  return `${actor.accountId}:${id}`;
}

function applyFill(order: ModelOrder, quantity: bigint): void {
  order.remainingQuantity -= quantity;
  order.filledQuantity += quantity;
  order.status = order.remainingQuantity === 0n ? "filled" : "partially_filled";
}

function fee(value: bigint, basisPoints: number): bigint {
  return (value * BigInt(basisPoints)) / 10_000n;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function replaySnapshot(result: MarketMutationResult): unknown {
  const clone = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  delete clone.replayed;
  return clone;
}

function failOnceAt(target: MarketFaultPoint): MarketFaultInjector {
  let fired = false;
  return (point) => {
    if (!fired && point === target) {
      fired = true;
      throw new Error(`injected:${point}`);
    }
  };
}

function retryOnceAt(target: MarketFaultPoint): MarketFaultInjector {
  let fired = false;
  return (point) => {
    if (!fired && point === target) {
      fired = true;
      throw Object.assign(new Error(`retryable:${point}`), { code: "40001" });
    }
  };
}

async function expectMarketCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected market error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function emptyCoverage(): Coverage {
  return {
    grants: 0,
    grantReplays: 0,
    creates: 0,
    matches: 0,
    partialFills: 0,
    multiFills: 0,
    cancellations: 0,
    itemClaims: 0,
    goldClaims: 0,
    allClaims: 0,
    requestReplays: 0,
    retryableFailures: 0,
    rollbacks: 0,
    lostResponses: 0,
    disconnects: 0,
    reconnects: 0,
    freezes: 0,
    unfreezes: 0,
    frozenRejections: 0,
    quotes: 0,
    simpleBuys: 0
  };
}

function poolFor(context: StepContext): pg.Pool {
  return context.pool;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function randomInt(random: () => number, maximum: number): number {
  return Math.floor(random() * maximum);
}
