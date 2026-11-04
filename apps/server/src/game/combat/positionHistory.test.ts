import { describe, expect, it } from "vitest";

import { POSITION_HISTORY_TICKS } from "@ash-atlas/shared";
import { PositionHistory } from "./positionHistory.js";

const current = { lat: 50, lon: 50 };

describe("PositionHistory", () => {
  it("returns the current position when there is no history", () => {
    const history = new PositionHistory();
    const out = { lat: 0, lon: 0 };
    expect(history.positionAtTick("mob", 10, current, out)).toEqual(current);
    expect(history.size).toBe(0);
  });

  it("creates a ring on the first write and holds a sample until the next write", () => {
    const history = new PositionHistory();
    history.record("mob", 10, 1, 1);
    history.record("mob", 20, 2, 2);
    const out = { lat: 0, lon: 0 };
    expect(history.size).toBe(1);
    // Stood still at (1, 1) from tick 10 until tick 19, then stepped to (2, 2) on tick 20.
    expect(history.positionAtTick("mob", 12, current, out)).toEqual({ lat: 1, lon: 1 });
    expect(history.positionAtTick("mob", 19, current, out)).toEqual({ lat: 1, lon: 1 });
    // At or after the newest sample the current position is authoritative.
    expect(history.positionAtTick("mob", 20, current, out)).toEqual(current);
    expect(history.positionAtTick("mob", 25, current, out)).toEqual(current);
  });

  it("interpolates linearly across the tick that moved", () => {
    const history = new PositionHistory();
    history.record("mob", 1, 0, 0);
    history.record("mob", 2, 10, 20);
    history.record("mob", 3, 20, 40);
    const out = { lat: 0, lon: 0 };
    expect(history.positionAtTick("mob", 1.5, current, out)).toEqual({ lat: 5, lon: 10 });
    expect(history.positionAtTick("mob", 2.25, current, out)).toEqual({ lat: 12.5, lon: 25 });
    expect(history.positionAtTick("mob", 2, current, out)).toEqual({ lat: 10, lon: 20 });
  });

  it("interpolates the short way across the antimeridian", () => {
    const history = new PositionHistory();
    history.record("mob", 1, 0, 179.9);
    history.record("mob", 2, 0, -179.9);
    const out = { lat: 0, lon: 0 };
    history.positionAtTick("mob", 1.5, current, out);
    expect(Math.abs(Math.abs(out.lon) - 180)).toBeLessThan(1e-9);
  });

  it("falls back to the current position when the tick is older than the ring", () => {
    const history = new PositionHistory();
    for (let tick = 1; tick <= POSITION_HISTORY_TICKS + 4; tick += 1) history.record("mob", tick, tick, tick);
    const out = { lat: 0, lon: 0 };
    // Ticks 1..4 were overwritten; tick 5 is the oldest still held.
    expect(history.positionAtTick("mob", 3, current, out)).toEqual(current);
    expect(history.positionAtTick("mob", 5, current, out)).toEqual({ lat: 5, lon: 5 });
    expect(history.sampleCount("mob")).toBe(POSITION_HISTORY_TICKS);
  });

  it("replaces a second write in the same tick", () => {
    const history = new PositionHistory();
    history.record("mob", 1, 0, 0);
    history.record("mob", 2, 1, 1);
    history.record("mob", 2, 3, 3);
    history.record("mob", 3, 4, 4);
    expect(history.sampleCount("mob")).toBe(3);
    expect(history.positionAtTick("mob", 2, current, { lat: 0, lon: 0 })).toEqual({ lat: 3, lon: 3 });
  });

  it("forgets on reset and pools rings on release", () => {
    const history = new PositionHistory();
    history.record("a", 1, 1, 1);
    history.record("a", 2, 2, 2);
    history.reset("a");
    expect(history.sampleCount("a")).toBe(0);
    expect(history.positionAtTick("a", 1, current, { lat: 0, lon: 0 })).toEqual(current);
    history.record("a", 3, 3, 3);
    const ring = (history as unknown as { rings: Map<string, unknown> }).rings.get("a");
    history.release("a");
    expect(history.size).toBe(0);
    history.record("b", 4, 4, 4);
    // The released ring is reused, empty.
    expect((history as unknown as { rings: Map<string, unknown> }).rings.get("b")).toBe(ring);
    expect(history.sampleCount("b")).toBe(1);
  });

  it("starts over if ticks go backwards", () => {
    const history = new PositionHistory();
    history.record("mob", 10, 1, 1);
    history.record("mob", 11, 2, 2);
    history.record("mob", 3, 9, 9);
    expect(history.sampleCount("mob")).toBe(1);
  });
});
