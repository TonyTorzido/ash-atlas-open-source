import { describe, expect, it } from "vitest";

import { DungeonStuckDetector, STUCK_AFTER_MS, STUCK_REPORT_COOLDOWN_MS } from "./dungeonStuckTelemetry.js";

const at = { x: 100, y: 100 };

describe("DungeonStuckDetector", () => {
  it("reports no-move after 2 s of continuous input without the position changing, once", () => {
    const d = new DungeonStuckDetector();
    let reason = null;
    for (let t = 0; t <= STUCK_AFTER_MS + 200 && !reason; t += 100) {
      d.input(t, at, null);
      reason = d.tick(t, at);
    }
    expect(reason).toBe("no-move");
    // Throttled: continued pushing does not report again inside the cooldown.
    for (let t = 3000; t < 10_000; t += 100) { d.input(t, at, null); expect(d.tick(t, at)).toBeNull(); }
  });

  it("stays quiet while the player moves, and restarts the clock after a stop", () => {
    const d = new DungeonStuckDetector();
    for (let t = 0; t < 5000; t += 100) { const p = { x: 100 + t / 10, y: 100 }; d.input(t, p, null); expect(d.tick(t, p)).toBeNull(); }
  });

  it("an idle player (no input) is never stuck", () => {
    const d = new DungeonStuckDetector();
    for (let t = 0; t < 20_000; t += 500) expect(d.tick(t, at)).toBeNull();
  });

  it("reports ignored input at once, then waits out the cooldown", () => {
    const d = new DungeonStuckDetector();
    expect(d.input(0, at, "puzzle-lock")).toBe("ignored:puzzle-lock");
    expect(d.input(500, at, "puzzle-lock")).toBeNull();
    expect(d.input(STUCK_REPORT_COOLDOWN_MS + 1, at, "portal-transition")).toBe("ignored:portal-transition");
  });
});
