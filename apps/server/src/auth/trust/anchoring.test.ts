import { describe, expect, it, vi } from "vitest";

import { ANCHOR_CACHE_TTL_MS, DestinationAnchoring } from "./anchoring.js";
import type { OwnerSettlementRecord } from "./trustStore.js";

const HOME = { lat: 40, lon: -105 };
const CONFIG = { TRUST_HOME_DESTINATION_RADIUS_KM: 50 };
const T0 = new Date("2026-10-02T12:00:00.000Z");
const settled: OwnerSettlementRecord = { settledAt: new Date("2026-09-01T00:00:00.000Z"), provisionalUntil: null, settledHome: HOME };

function harness(record: OwnerSettlementRecord | null) {
  let now = new Date(T0);
  const store = { loadOwnerSettlement: vi.fn(async () => record) };
  const anchoring = new DestinationAnchoring(store, CONFIG, () => now);
  return { anchoring, store, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe("DestinationAnchoring", () => {
  it("anchors destinations within the radius of a Settled home only", async () => {
    const { anchoring } = harness(settled);
    expect(await anchoring.isDestinationAnchored("a", 40.2, -105)).toBe(true);
    expect(await anchoring.isDestinationAnchored("a", 40.6, -105)).toBe(false);
  });

  it("is never anchored without settlement, a Settled home, or after provisional expiry", async () => {
    expect(await harness(null).anchoring.isDestinationAnchored("a", 40, -105)).toBe(false);
    expect(await harness({ ...settled, settledAt: null }).anchoring.isDestinationAnchored("a", 40, -105)).toBe(false);
    expect(await harness({ ...settled, settledHome: null }).anchoring.isDestinationAnchored("a", 40, -105)).toBe(false);
    const expired = { ...settled, provisionalUntil: new Date(T0.getTime() - 1) };
    expect(await harness(expired).anchoring.isDestinationAnchored("a", 40, -105)).toBe(false);
  });

  it("re-evaluates provisional expiry against the clock while cached", async () => {
    const { anchoring, store, advance } = harness({ ...settled, provisionalUntil: new Date(T0.getTime() + 10_000) });
    expect(await anchoring.isDestinationAnchored("a", 40, -105)).toBe(true);
    advance(11_000);
    expect(await anchoring.isDestinationAnchored("a", 40, -105)).toBe(false);
    expect(store.loadOwnerSettlement).toHaveBeenCalledTimes(1);
  });

  it("caches the owner record for 30 seconds and supports invalidation", async () => {
    const { anchoring, store, advance } = harness(settled);
    await anchoring.isDestinationAnchored("a", 40, -105);
    await anchoring.isDestinationAnchored("a", 40.1, -105);
    expect(store.loadOwnerSettlement).toHaveBeenCalledTimes(1);
    advance(ANCHOR_CACHE_TTL_MS + 1);
    await anchoring.isDestinationAnchored("a", 40, -105);
    expect(store.loadOwnerSettlement).toHaveBeenCalledTimes(2);
    anchoring.invalidate("a");
    await anchoring.isDestinationAnchored("a", 40, -105);
    expect(store.loadOwnerSettlement).toHaveBeenCalledTimes(3);
  });
});
