import { describe, expect, it } from "vitest";
import { PerfSampleStore, type PerfSample } from "./perfSampleStore.js";
import { RollingStats } from "./rollingStats.js";

const sample = (fps: number): PerfSample => ({
  clientAtMs: 0, fps, frameP50Ms: 16, frameP95Ms: 20, frameP99Ms: 30, framesOver50Ms: 0,
  drawCallsPerFrame: 1, textureCount: 1, textureMb: 1, retainedDisplayObjects: 1, combatEntities: 1,
  gameAppRendersPerSec: 1, eventLoopLagMs: 0, wsMsgsPerSec: 1, wsKbPerSec: 1, dpr: 1,
  legacyRenderQuality: false, userAgent: "t", build: "b"
});

describe("PerfSampleStore", () => {
  it("keeps only the newest samples per user", () => {
    const store = new PerfSampleStore(3, 1000);
    for (let i = 0; i < 5; i += 1) store.add("a", sample(i), i);
    store.add("b", sample(99), 10);
    const read = store.read();
    expect(read.a?.map((s) => s.fps)).toEqual([2, 3, 4]);
    expect(read.b).toHaveLength(1);
    expect(store.read({ playerId: "b", limit: 1 })).toEqual({ b: [expect.objectContaining({ fps: 99 })] });
    expect(store.read({ playerId: "a", sinceMs: 3 }).a?.map((s) => s.fps)).toEqual([3, 4]);
  });

  it("rate limits per user per minute and recovers", () => {
    const store = new PerfSampleStore(10, 2);
    expect(store.add("a", sample(1), 0)).not.toBeNull();
    expect(store.add("a", sample(2), 1)).not.toBeNull();
    expect(store.add("a", sample(3), 2)).toBeNull();
    expect(store.add("b", sample(4), 2)).not.toBeNull();
    expect(store.add("a", sample(5), 61_000)).not.toBeNull();
  });
});

describe("RollingStats", () => {
  it("summarizes a bounded window", () => {
    const stats = new RollingStats(100);
    for (let i = 1; i <= 150; i += 1) stats.push(i);
    const summary = stats.summary();
    expect(summary.count).toBe(100);
    expect(summary.max).toBe(150);
    expect(summary.p50).toBe(101);
    expect(summary.p95).toBe(146);
    expect(new RollingStats(3).summary()).toEqual({ count: 0, p50: 0, p95: 0, max: 0 });
  });
});
