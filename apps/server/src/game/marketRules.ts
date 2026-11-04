import { createHash } from "node:crypto";

import type { MarketOrderSide } from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import { isInventoryCapacityError } from "./inventory.js";

export const MARKET_RULES_VERSION = 1;
export const MARKET_DEFAULT_VARIANT = "default";
export const MARKET_GLOBAL_VENUE_KEY = "global";

export type MarketActor = {
  playerId: string;
  accountId: string;
};

export type MarketLimits = {
  maxActiveOrdersPerPlayer: bigint;
  maxOpenOrdersPerItem: bigint;
  maxRestingOrdersPerAccountBook: bigint;
  maxQuantityPerOrder: bigint;
  maxUnitPrice: bigint;
  maxTotalOrderValue: bigint;
  requestsPerMinute: number;
  cancellationsPerMinute: number;
  browseRequestsPerMinute: number;
  bookRequestsPerMinute: number;
  quoteRequestsPerMinute: number;
  subscriptionRequestsPerMinute: number;
  maxOutstandingQuotesPerAccountBook: number;
  maxClaimsPerRequest: number;
  maxSimpleBuyQuantity: bigint;
  maxDepthLevels: number;
  maxSearchResults: number;
  quoteTtlSeconds: number;
  transactionRetryLimit: number;
};

export function marketLimits(config: AppConfig): MarketLimits {
  return {
    maxActiveOrdersPerPlayer: BigInt(config.MARKET_MAX_ACTIVE_ORDERS_PER_PLAYER),
    maxOpenOrdersPerItem: BigInt(config.MARKET_MAX_OPEN_ORDERS_PER_ITEM),
    maxRestingOrdersPerAccountBook: BigInt(config.MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK),
    maxQuantityPerOrder: BigInt(config.MARKET_MAX_QUANTITY_PER_ORDER),
    maxUnitPrice: BigInt(config.MARKET_MAX_UNIT_PRICE),
    maxTotalOrderValue: BigInt(config.MARKET_MAX_TOTAL_ORDER_VALUE),
    requestsPerMinute: config.MARKET_REQUESTS_PER_MINUTE,
    cancellationsPerMinute: config.MARKET_CANCELLATIONS_PER_MINUTE,
    browseRequestsPerMinute: config.MARKET_BROWSE_REQUESTS_PER_MINUTE,
    bookRequestsPerMinute: config.MARKET_BOOK_REQUESTS_PER_MINUTE,
    quoteRequestsPerMinute: config.MARKET_QUOTE_REQUESTS_PER_MINUTE,
    subscriptionRequestsPerMinute: config.MARKET_SUBSCRIPTION_REQUESTS_PER_MINUTE,
    maxOutstandingQuotesPerAccountBook:
      config.MARKET_MAX_OUTSTANDING_QUOTES_PER_ACCOUNT_BOOK,
    maxClaimsPerRequest: config.MARKET_MAX_CLAIMS_PER_REQUEST,
    maxSimpleBuyQuantity: BigInt(config.MARKET_MAX_SIMPLE_BUY_QUANTITY),
    maxDepthLevels: config.MARKET_MAX_DEPTH_LEVELS,
    maxSearchResults: config.MARKET_MAX_SEARCH_RESULTS,
    quoteTtlSeconds: config.MARKET_QUOTE_TTL_SECONDS,
    transactionRetryLimit: config.MARKET_TRANSACTION_RETRY_LIMIT
  };
}

export type MarketErrorCode =
  | "MARKET_ACCESS_DENIED"
  | "MARKET_READ_ONLY"
  | "MARKET_NEW_ORDERS_DISABLED"
  | "MARKET_MATCHING_DISABLED"
  | "MARKET_CANCELLATIONS_DISABLED"
  | "MARKET_CLAIMS_DISABLED"
  | "MARKET_VENUE_FROZEN"
  | "MARKET_ITEM_FROZEN"
  | "MARKET_PLAYER_FROZEN"
  | "MARKET_UNKNOWN_ITEM"
  | "MARKET_ITEM_NOT_TRADABLE"
  | "MARKET_INVALID_REQUEST_ID"
  | "MARKET_INVALID_QUANTITY"
  | "MARKET_INVALID_PRICE"
  | "MARKET_ORDER_VALUE_LIMIT"
  | "MARKET_ACTIVE_ORDER_LIMIT"
  | "MARKET_ITEM_ORDER_LIMIT"
  | "MARKET_CARRY_CAPACITY_EXCEEDED"
  | "MARKET_NOT_ENOUGH_ITEMS"
  | "MARKET_NOT_ENOUGH_GOLD"
  | "MARKET_ORDER_NOT_FOUND"
  | "MARKET_ORDER_NOT_OWNED"
  | "MARKET_ORDER_ALREADY_CLOSED"
  | "MARKET_QUOTE_NOT_FOUND"
  | "MARKET_QUOTE_EXPIRED"
  | "MARKET_QUOTE_STALE"
  | "MARKET_PRICE_CHANGED"
  | "MARKET_SELF_TRADE"
  | "MARKET_EQUIPMENT_NOT_FOUND"
  | "MARKET_EQUIPMENT_NOT_ELIGIBLE"
  | "MARKET_EQUIPMENT_NOT_TRADABLE"
  | "MARKET_EQUIPMENT_STALE"
  | "MARKET_EQUIPMENT_LISTING_NOT_FOUND"
  | "MARKET_EQUIPMENT_LISTING_STALE"
  | "MARKET_FEE_POLICY_UNSUPPORTED"
  | "MARKET_REPLAY_CONFLICT"
  | "MARKET_RATE_LIMITED"
  | "MARKET_BUSY"
  | "MARKET_INVARIANT_FAILURE";

export class MarketError extends Error {
  constructor(
    readonly code: MarketErrorCode,
    message: string,
    readonly retryable = false,
    readonly diagnostics?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "MarketError";
  }
}

export function requireRequestId(requestId: string): string {
  const normalized = requestId.trim();
  if (normalized.length < 8 || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new MarketError(
      "MARKET_INVALID_REQUEST_ID",
      "Market request id must be 8-128 URL-safe characters"
    );
  }
  return normalized;
}

export function requireEconomicInteger(
  raw: string,
  field: string,
  maximum: bigint
): bigint {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new MarketError(
      field === "quantity" ? "MARKET_INVALID_QUANTITY" : "MARKET_INVALID_PRICE",
      `${field} must be a positive whole number`
    );
  }
  const value = BigInt(raw);
  if (value > maximum) {
    throw new MarketError(
      field === "quantity" ? "MARKET_INVALID_QUANTITY" : "MARKET_INVALID_PRICE",
      `${field} exceeds the configured market limit`
    );
  }
  return value;
}

export function checkedOrderValue(unitPrice: bigint, quantity: bigint, maximum: bigint): bigint {
  if (unitPrice <= 0n || quantity <= 0n || unitPrice > maximum / quantity) {
    throw new MarketError("MARKET_ORDER_VALUE_LIMIT", "Order total exceeds the configured limit");
  }
  const value = unitPrice * quantity;
  if (value > maximum) {
    throw new MarketError("MARKET_ORDER_VALUE_LIMIT", "Order total exceeds the configured limit");
  }
  return value;
}

export function calculateFee(value: bigint, basisPoints: number): bigint {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new Error("Invalid fee basis points");
  }
  // Deliberate floor rounding in favor of the player; zero-fee mode follows this same path.
  const fee = (value * BigInt(basisPoints)) / 10_000n;
  if (fee > value) throw new Error("Fee exceeds related transaction value");
  return fee;
}

export function marketRequestHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)])
    );
  }
  return value;
}

export type MarketFaultPoint =
  | "before_inventory_debit"
  | "after_inventory_debit"
  | "after_escrow_creation"
  | "after_order_creation"
  | "midway_multi_fill"
  | "after_trade_insert"
  | "after_ledger_insert"
  | "before_commit"
  | "after_commit_before_response"
  | "during_cancellation"
  | "during_claim";

export type MarketFaultInjector = (point: MarketFaultPoint) => void | Promise<void>;

export const noMarketFaults: MarketFaultInjector = () => undefined;

export function orderAction(side: MarketOrderSide): "create_buy" | "create_sell" {
  return side === "buy" ? "create_buy" : "create_sell";
}

export function isRetryablePostgresError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  // A server-configured statement timeout aborts the current PostgreSQL
  // transaction before commit. It is therefore safe to expose as the same
  // bounded retryable busy outcome as deadlocks and serialization failures.
  return code === "40P01" || code === "40001" || code === "57014";
}

export function mapMarketError(
  error: unknown,
  context: { operation?: string } = {}
): Error {
  if (error instanceof MarketError) return error;
  if (isInventoryCapacityError(error)) return new MarketError("MARKET_CARRY_CAPACITY_EXCEEDED", "This would exceed your carrying capacity");
  if (isRetryablePostgresError(error)) {
    return new MarketError("MARKET_BUSY", "The market is busy; retry with the same request id", true);
  }
  const postgres = error as { code?: unknown; constraint?: unknown } | null;
  if (postgres?.code === "23505") {
    const constraint = typeof postgres.constraint === "string" ? postgres.constraint : "";
    if (
      constraint === "market_requests_account_id_request_id_key" ||
      constraint === "market_requests_pkey" ||
      constraint === "market_quote_requests_pkey"
    ) {
      return new MarketError(
        "MARKET_REPLAY_CONFLICT",
        "Market request conflicts with committed state"
      );
    }
    if (constraint === "market_rate_windows_pkey") {
      return new MarketError("MARKET_RATE_LIMITED", "Market request rate limit reached");
    }
    return new MarketError(
      "MARKET_INVARIANT_FAILURE",
      `Market invariant rejected ${context.operation ?? "operation"}`
    );
  }
  if (
    typeof postgres?.code === "string" &&
    (postgres.code.startsWith("23") || postgres.code === "P0001")
  ) {
    return new MarketError(
      "MARKET_INVARIANT_FAILURE",
      `Market invariant rejected ${context.operation ?? "operation"}`
    );
  }
  return error instanceof Error ? error : new Error("Unknown market operation failure");
}
