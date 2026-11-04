import { describe, expect, it, vi } from "vitest";

import { LandActionGate, type TrustSignalSink } from "./trustService.js";
import type { LandActionHold, LandActionRecord, LandActionStore } from "./trustStore.js";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const START = Date.parse("2026-10-01T12:00:00.000Z");

class FakeLandActionStore implements LandActionStore {
  hold: LandActionHold = { holdUntil: null, holdReason: null };
  loads = 0;
  records: LandActionRecord[] = [];
  failLoad = false;
  pendingLoad: Promise<void> | null = null;

  async loadLandActionHold(): Promise<LandActionHold> {
    this.loads += 1;
    if (this.pendingLoad) await this.pendingLoad;
    if (this.failLoad) throw new Error("database unavailable");
    return this.hold;
  }

  async recordLandAction(record: LandActionRecord): Promise<void> {
    this.records.push(record);
  }
}

function harness(mode: "off" | "shadow" | "enforce") {
  const clock = { ms: START };
  const store = new FakeLandActionStore();
  const sink: TrustSignalSink = { recordSignals: vi.fn(async () => undefined) };
  const logger = { warn: vi.fn() };
  const gate = new LandActionGate(store, { TRUST_LAND_ACTION_MODE: mode }, {
    sink,
    logger,
    now: () => new Date(clock.ms)
  });
  return { clock, store, sink, logger, gate };
}

const input = {
  accountId: ACCOUNT,
  playerId: "player-1",
  action: "flag_place" as const,
  position: { lat: 40, lon: -105 }
};

describe("LandActionGate.check", () => {
  it("never reads holds in off mode", async () => {
    const { gate, store } = harness("off");
    store.hold = { holdUntil: new Date(START + 60_000), holdReason: "transit" };

    await expect(gate.check(input)).resolves.toEqual({ allowed: true, shadowBlocked: false });
    expect(store.loads).toBe(0);
  });

  it("refuses during an enforced hold with the remaining time, then allows after expiry", async () => {
    const { gate, store, clock } = harness("enforce");
    store.hold = { holdUntil: new Date(START + 90_000), holdReason: "relocation_cooldown" };

    await expect(gate.check(input)).resolves.toEqual({
      allowed: false,
      code: "LAND_ACTION_SETTLING",
      message: "Try again later.",
      retryAfterMs: 90_000
    });
    clock.ms += 30_000;
    await expect(gate.check(input)).resolves.toMatchObject({ allowed: false, retryAfterMs: 60_000 });
    clock.ms = START + 90_000;
    await expect(gate.check(input)).resolves.toEqual({ allowed: true, shadowBlocked: false });
  });

  it("allows in shadow mode and signals once per hold with a dedupe key", async () => {
    const { gate, store, sink } = harness("shadow");
    store.hold = { holdUntil: new Date(START + 60_000), holdReason: "transit" };

    await expect(gate.check(input)).resolves.toEqual({ allowed: true, shadowBlocked: true });
    await expect(gate.check({ ...input, action: "pvp_engage" })).resolves.toEqual({ allowed: true, shadowBlocked: true });

    expect(sink.recordSignals).toHaveBeenCalledOnce();
    expect(sink.recordSignals).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      signals: [expect.objectContaining({
        rule: "land_action_during_hold",
        weight: 0.5,
        metadata: expect.objectContaining({
          dedupeKey: `hold:${ACCOUNT}:${START + 60_000}`,
          action: "flag_place",
          holdReason: "transit"
        })
      })]
    });
  });

  it("hydrates once per TTL, shares concurrent loads, and re-reads after the TTL", async () => {
    const { gate, store, clock } = harness("enforce");
    let release!: () => void;
    store.pendingLoad = new Promise((resolve) => { release = resolve; });

    const concurrent = Promise.all([gate.check(input), gate.check(input)]);
    release();
    await concurrent;
    store.pendingLoad = null;
    expect(store.loads).toBe(1);

    await gate.check(input);
    expect(store.loads).toBe(1);

    // Another process wrote a hold; this process sees it after the cache TTL.
    store.hold = { holdUntil: new Date(START + 10 * 60_000), holdReason: "relocation_cooldown" };
    clock.ms += 31_000;
    await expect(gate.check(input)).resolves.toMatchObject({ allowed: false });
    expect(store.loads).toBe(2);
  });

  it("applies a hold noted by this process immediately and keeps it over an older read", async () => {
    const { gate, store, clock } = harness("enforce");
    await gate.check(input);
    expect(store.loads).toBe(1);

    gate.noteHold(ACCOUNT, new Date(START + 5 * 60_000), "transit");
    await expect(gate.check(input)).resolves.toMatchObject({ allowed: false, retryAfterMs: 5 * 60_000 });

    // A stale replica read (no hold) never erases the longer noted hold.
    clock.ms += 31_000;
    await expect(gate.check(input)).resolves.toMatchObject({ allowed: false });
    // A shorter noted hold never shortens the cached one.
    gate.noteHold(ACCOUNT, new Date(START + 60_000), "relocation_cooldown");
    expect(await gate.availableAt(ACCOUNT)).toBe(START + 5 * 60_000);
  });

  it("fails open when the hold cannot be loaded", async () => {
    const { gate, store, logger } = harness("enforce");
    store.failLoad = true;

    await expect(gate.check(input)).resolves.toEqual({ allowed: true, shadowBlocked: false });
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe("LandActionGate.recordLandAction", () => {
  it("records position, UTC day and region cell, throttled per cell", async () => {
    const { gate, store, clock } = harness("shadow");

    await gate.recordLandAction(input);
    await gate.recordLandAction(input);
    expect(store.records).toEqual([{
      accountId: ACCOUNT,
      lat: 40,
      lon: -105,
      at: new Date(START),
      regionCell: "80:-210",
      day: "2026-10-01"
    }]);

    await gate.recordLandAction({ ...input, position: { lat: 41, lon: -105 } });
    clock.ms += 61_000;
    await gate.recordLandAction({ ...input, position: { lat: 41, lon: -105 } });
    expect(store.records.map((record) => record.regionCell)).toEqual(["80:-210", "82:-210", "82:-210"]);
  });

  it("does nothing in off mode or without a position", async () => {
    const off = harness("off");
    await off.gate.recordLandAction(input);
    const shadow = harness("shadow");
    await shadow.gate.recordLandAction({ ...input, position: null });
    expect(off.store.records).toEqual([]);
    expect(shadow.store.records).toEqual([]);
  });
});
