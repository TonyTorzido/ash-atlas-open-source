import { describe, expect, it } from "vitest";

import { BoundedReplayCache } from "./boundedReplayCache.js";

describe("BoundedReplayCache", () => {
  it("evicts the least recently used entry at its fixed bound", () => {
    const cache = new BoundedReplayCache<string, number>(2, 1_000, () => 0);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("expires entries deterministically by TTL", () => {
    let now = 10;
    const cache = new BoundedReplayCache<string, number>(4, 100, () => now);
    cache.set("request", 1);
    now = 109;
    expect(cache.get("request")).toBe(1);
    now = 110;
    expect(cache.get("request")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
