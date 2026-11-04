import { describe, expect, it, vi } from "vitest";

import { LocationHistoryMonitor, summarizeLocationHistory, type HistoryFix } from "./stateHopping.js";

const RULES = { regionKm: 300, maxKmh: 900, minHops: 2 };
const NOW = new Date("2026-10-04T12:00:00.000Z");
const PHOENIX = { lat: 33.45, lon: -112.07 };
const DENVER = { lat: 39.74, lon: -104.99 };
const PARIS = { lat: 48.86, lon: 2.35 };

const fix = (at: { lat: number; lon: number }, hoursAgo: number, source: HistoryFix["source"] = "passive"): HistoryFix => ({
  ...at,
  at: new Date(NOW.getTime() - hoursAgo * 3_600_000),
  source
});

describe("location history summary (owner decision D)", () => {
  it("flags A -> B -> A jumps faster than any real travel", () => {
    const summary = summarizeLocationHistory([
      fix(PHOENIX, 30), fix(PHOENIX, 2), fix(PARIS, 1.9, "relocation"), fix(PARIS, 1.5), fix(PHOENIX, 1)
    ], RULES);
    expect(summary).toMatchObject({ visits: 3, implausibleHops: 2, returnedToEarlierRegion: true, stateHopping: true });
    expect(summary.passiveImpossible).toBe(true);
  });

  it("does not flag a real trip and back, a move, or local wandering", () => {
    // Phoenix -> Denver by plane (2 days later) and back after a week.
    expect(summarizeLocationHistory([fix(PHOENIX, 200), fix(DENVER, 150), fix(DENVER, 120), fix(PHOENIX, 10)], RULES))
      .toMatchObject({ visits: 3, implausibleHops: 0, stateHopping: false, passiveImpossible: false });
    // One relocation after a flight, then staying.
    expect(summarizeLocationHistory([fix(PHOENIX, 30), fix(PARIS, 5, "relocation"), fix(PARIS, 1)], RULES))
      .toMatchObject({ visits: 2, implausibleHops: 0, stateHopping: false });
    expect(summarizeLocationHistory([fix(DENVER, 3), fix({ lat: 39.9, lon: -105.2 }, 2), fix(DENVER, 1)], RULES))
      .toMatchObject({ visits: 1, hops: [] });
  });

  it("needs a return to count as hopping: one impossible jump away stays a speed signal", () => {
    const summary = summarizeLocationHistory([fix(PHOENIX, 2), fix(PARIS, 1.9)], RULES);
    expect(summary).toMatchObject({ implausibleHops: 1, stateHopping: false, passiveImpossible: true });
  });
});

describe("location history monitor", () => {
  function monitor(history: HistoryFix[], mode: "off" | "shadow" | "enforce" = "shadow") {
    const store = { recentFixes: vi.fn(async () => history) };
    const sink = { recordSignals: vi.fn(async () => undefined) };
    const alerts = { fileZoneAlert: vi.fn(async () => ({ created: true })) };
    const instance = new LocationHistoryMonitor(store, { TRUST_MISMATCH_MODE: mode }, { sink, alerts, now: () => NOW });
    return { instance, store, sink, alerts };
  }

  it("records state_hopping (+4) and a state_hopping alert for the pattern", async () => {
    const { instance, sink, alerts } = monitor([fix(PHOENIX, 3), fix(PARIS, 2.9, "relocation"), fix(PHOENIX, 1)]);
    await instance.onFix({ accountId: "a", ...PHOENIX, at: NOW });
    expect(sink.recordSignals).toHaveBeenCalledWith({
      accountId: "a",
      signals: [expect.objectContaining({ rule: "state_hopping", weight: 4 })]
    });
    expect(alerts.fileZoneAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: "state_hopping", dedupe: "account" }));
  });

  it("judges the current fix even when it was not stored as a row (redundant passive fix)", async () => {
    const { instance, sink } = monitor([fix(PHOENIX, 3), fix(PARIS, 2.9, "relocation"), fix(PARIS, 2.8)]);
    await instance.onFix({ accountId: "a", ...PARIS, at: NOW });
    await instance.onFix({ accountId: "a", ...PHOENIX, at: NOW, source: "passive" });
    expect(sink.recordSignals).toHaveBeenCalledWith(expect.objectContaining({
      signals: [expect.objectContaining({ rule: "state_hopping" })]
    }));
  });

  it("stays quiet for an honest history, within the same region, or with mismatch signals off", async () => {
    const honest = monitor([fix(PHOENIX, 200), fix(DENVER, 150)]);
    await honest.instance.onFix({ accountId: "a", ...DENVER, at: NOW });
    expect(honest.sink.recordSignals).not.toHaveBeenCalled();
    expect(honest.alerts.fileZoneAlert).not.toHaveBeenCalled();
    await honest.instance.onFix({ accountId: "a", lat: 39.8, lon: -105.1, at: NOW });
    expect(honest.store.recentFixes).toHaveBeenCalledOnce();
    const off = monitor([fix(PHOENIX, 3), fix(PARIS, 2.9), fix(PHOENIX, 1)], "off");
    await off.instance.onFix({ accountId: "a", ...PHOENIX, at: NOW });
    expect(off.store.recentFixes).not.toHaveBeenCalled();
  });
});
