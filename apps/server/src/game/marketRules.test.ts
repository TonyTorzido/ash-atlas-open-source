import { describe, expect, it } from "vitest";
import { MARKET_MAX_MUTATION_TRADES } from "@ash-atlas/shared";

import { loadConfig } from "../config.js";
import {
  MarketError,
  calculateFee,
  checkedOrderValue,
  isRetryablePostgresError,
  mapMarketError,
  marketRequestHash,
  requireEconomicInteger,
  requireRequestId,
  stableJson
} from "./marketRules.js";

describe("market economic rules", () => {
  it("normalizes valid request ids and rejects malformed or ambiguous ids", () => {
    expect(requireRequestId("  request-0001  ")).toBe("request-0001");
    expect(requireRequestId("12345678")).toBe("12345678");
    expect(() => requireRequestId("short")).toThrowError(MarketError);
    expect(() => requireRequestId("request id")).toThrowError(MarketError);
    expect(() => requireRequestId("a".repeat(129))).toThrowError(MarketError);
  });

  it("parses only canonical positive bigint strings within their configured bound", () => {
    expect(requireEconomicInteger("9007199254740991", "quantity", 9007199254740991n))
      .toBe(9007199254740991n);
    for (const raw of ["", "0", "-1", "+1", "01", "1.0", "1e3", " 1", "1 "]) {
      expect(() => requireEconomicInteger(raw, "quantity", 100n)).toThrowError(
        expect.objectContaining({ code: "MARKET_INVALID_QUANTITY" })
      );
    }
    expect(() => requireEconomicInteger("101", "quantity", 100n)).toThrowError(
      expect.objectContaining({ code: "MARKET_INVALID_QUANTITY" })
    );
    expect(() => requireEconomicInteger("101", "unit price", 100n)).toThrowError(
      expect.objectContaining({ code: "MARKET_INVALID_PRICE" })
    );
  });

  it("computes exact order values and rejects multiplication beyond the configured maximum", () => {
    expect(checkedOrderValue(8n, 4n, 1_000n)).toBe(32n);
    expect(checkedOrderValue(9n, 6n, 1_000n)).toBe(54n);
    expect(checkedOrderValue(1_000_000_000n, 1_000n, 1_000_000_000_000n))
      .toBe(1_000_000_000_000n);
    expect(() => checkedOrderValue(1_000_000_001n, 1_000n, 1_000_000_000_000n)).toThrowError(
      expect.objectContaining({ code: "MARKET_ORDER_VALUE_LIMIT" })
    );
    expect(() => checkedOrderValue(2n ** 62n, 4n, 2n ** 63n - 1n)).toThrowError(
      expect.objectContaining({ code: "MARKET_ORDER_VALUE_LIMIT" })
    );
    expect(() => checkedOrderValue(0n, 1n, 100n)).toThrowError(MarketError);
    expect(() => checkedOrderValue(1n, 0n, 100n)).toThrowError(MarketError);
  });

  it("keeps configured open-book size within one representable mutation result", () => {
    expect(loadConfig({
      NODE_ENV: "test",
      MARKET_MAX_OPEN_ORDERS_PER_ITEM: String(MARKET_MAX_MUTATION_TRADES)
    }).MARKET_MAX_OPEN_ORDERS_PER_ITEM).toBe(MARKET_MAX_MUTATION_TRADES);
    expect(() => loadConfig({
      NODE_ENV: "test",
      MARKET_MAX_OPEN_ORDERS_PER_ITEM: String(MARKET_MAX_MUTATION_TRADES + 1)
    })).toThrow(/open-order limit cannot exceed the 500-trade mutation-result bound/i);
    expect(loadConfig({ NODE_ENV: "test" }).MARKET_MAX_OPEN_ORDERS_PER_ITEM).toBe(10);
  });

  it("calculates deterministic floor-rounded integer fees including zero-fee mode", () => {
    expect(calculateFee(9_999n, 0)).toBe(0n);
    expect(calculateFee(1n, 1)).toBe(0n);
    expect(calculateFee(99n, 125)).toBe(1n);
    expect(calculateFee(10_001n, 125)).toBe(125n);
    expect(calculateFee(42n, 10_000)).toBe(42n);
    for (const basisPoints of [-1, 10_001, 1.5, Number.NaN]) {
      expect(() => calculateFee(100n, basisPoints)).toThrow("Invalid fee basis points");
    }
  });

  it("hashes canonical object content independently of property insertion order", () => {
    const left = {
      quantity: "10",
      item: { variant: "default", id: "ore" },
      tags: ["simple", "buy"]
    };
    const right = {
      tags: ["simple", "buy"],
      item: { id: "ore", variant: "default" },
      quantity: "10"
    };
    expect(stableJson(left)).toBe(stableJson(right));
    expect(marketRequestHash(left)).toBe(marketRequestHash(right));
    expect(marketRequestHash(left)).toMatch(/^[0-9a-f]{64}$/);
    expect(marketRequestHash(left)).not.toBe(marketRequestHash({ ...right, quantity: "11" }));
    expect(marketRequestHash(["buy", "sell"]))
      .not.toBe(marketRequestHash(["sell", "buy"]));
  });

  it.each(["40P01", "40001", "57014"])("recognizes retryable PostgreSQL error %s", (code) => {
    expect(isRetryablePostgresError({ code })).toBe(true);
    expect(mapMarketError({ code })).toMatchObject({
      code: "MARKET_BUSY",
      retryable: true
    });
  });

  it("does not retry validation, uniqueness, connection, or programming failures", () => {
    for (const code of ["23505", "23514", "23503", "08006", undefined]) {
      expect(isRetryablePostgresError({ code })).toBe(false);
    }
    expect(mapMarketError({ code: "23505", constraint: "market_trades_pkey" })).toMatchObject({
      code: "MARKET_INVARIANT_FAILURE",
      retryable: false
    });
    const original = new Error("programming failure");
    expect(mapMarketError(original)).toBe(original);
    const marketError = new MarketError("MARKET_INVALID_PRICE", "bad price");
    expect(mapMarketError(marketError)).toBe(marketError);
  });

  it("reports a deferred carry-capacity guard as a capacity error", () => {
    expect(mapMarketError({ code: "23514", constraint: "player_inventory_carry_capacity" }))
      .toMatchObject({ code: "MARKET_CARRY_CAPACITY_EXCEEDED", retryable: false });
  });

  it("maps uniqueness by named constraint instead of treating every collision as replay", () => {
    expect(mapMarketError({
      code: "23505",
      constraint: "market_requests_pkey"
    })).toMatchObject({ code: "MARKET_REPLAY_CONFLICT" });
    expect(mapMarketError({
      code: "23505",
      constraint: "market_rate_windows_pkey"
    })).toMatchObject({ code: "MARKET_RATE_LIMITED" });
    for (const constraint of [
      "market_collections_trade_reason_player_idx",
      "market_trades_pkey",
      "market_orders_pkey",
      "market_orders_account_id_client_request_id_key",
      "market_claims_account_id_client_request_id_key",
      "unexpected_future_constraint"
    ]) {
      expect(mapMarketError({ code: "23505", constraint }, { operation: "create order" }))
        .toMatchObject({ code: "MARKET_INVARIANT_FAILURE" });
    }
  });
});
