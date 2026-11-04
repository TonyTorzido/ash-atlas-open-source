import { describe, expect, it } from "vitest";

import {
  assertSafeMarketHarnessDatabaseUrl,
  marketHarnessConnectionTransition,
  marketHarnessOperationKind,
  marketHarnessDatabaseName,
  summarizeLatencies
} from "./marketHarness.js";

describe("market stress harness", () => {
  it("accepts only explicitly disposable test or validation database names", () => {
    expect(assertSafeMarketHarnessDatabaseUrl(
      "postgres://ash_atlas:secret@127.0.0.1:55432/ash_atlas_market_test"
    )).toBe("ash_atlas_market_test");
    expect(assertSafeMarketHarnessDatabaseUrl(
      "postgresql://ash_atlas:secret@127.0.0.1:55432/ash_atlas_market_validation"
    )).toBe("ash_atlas_market_validation");
    for (const unsafe of [
      "postgres://ash_atlas:secret@127.0.0.1:55432/ash_atlas_game",
      "postgres://ash_atlas:secret@127.0.0.1:55432/postgres",
      "postgres://ash_atlas:secret@127.0.0.1:55432/ash_atlas_markets_dev"
    ]) {
      expect(() => assertSafeMarketHarnessDatabaseUrl(unsafe)).toThrow(/refusing destructive/i);
    }
  });

  it("parses encoded database names without exposing credentials", () => {
    expect(marketHarnessDatabaseName(
      "postgres://user:password@localhost:5432/market%5Fvalidation"
    )).toBe("market_validation");
    expect(() => marketHarnessDatabaseName("not a url")).toThrow(/valid URL/i);
  });

  it("reports nearest-rank p50, p95, p99, maximum, and mean", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(summarizeLatencies(values)).toEqual({
      count: 100,
      sampled: 100,
      meanMs: 50.5,
      p50Ms: 50,
      p95Ms: 95,
      p99Ms: 99,
      maxMs: 100
    });
  });

  it("selects a deterministic, bounded read mix alongside mutations", () => {
    const first = Array.from(
      { length: 2_000 },
      (_, index) => marketHarnessOperationKind("read-mix-v1", index)
    );
    const second = Array.from(
      { length: 2_000 },
      (_, index) => marketHarnessOperationKind("read-mix-v1", index)
    );
    expect(second).toEqual(first);

    for (const kind of ["browse_search", "category", "book_depth"] as const) {
      const count = first.filter((entry) => entry === kind).length;
      expect(count).toBeGreaterThanOrEqual(70);
      expect(count).toBeLessThanOrEqual(130);
    }
    expect(first.some((entry) => entry === "create_sell")).toBe(true);
    expect(first.some((entry) => entry === "duplicate_create")).toBe(true);
    for (const kind of ["disconnect", "reconnect"] as const) {
      const count = first.filter((entry) => entry === kind).length;
      expect(count).toBeGreaterThanOrEqual(25);
      expect(count).toBeLessThanOrEqual(75);
    }
  });

  it("models idempotent disconnect and reconnect transitions", () => {
    expect(marketHarnessConnectionTransition(true, "disconnect")).toEqual({
      connected: false,
      transitioned: true
    });
    expect(marketHarnessConnectionTransition(false, "disconnect")).toEqual({
      connected: false,
      transitioned: false
    });
    expect(marketHarnessConnectionTransition(false, "reconnect")).toEqual({
      connected: true,
      transitioned: true
    });
    expect(marketHarnessConnectionTransition(true, "reconnect")).toEqual({
      connected: true,
      transitioned: false
    });
  });
});
