import { describe, expect, it } from "vitest";

import { GreenhouseMovementTimeline } from "./greenhouseMovementTimeline.js";

const stopped = (x: number, y: number, revision = 0) => ({
  x, y, targetX: null, targetY: null, moving: false, revision
});

describe("GreenhouseMovementTimeline", () => {
  it("reuses indoor interpolation and rejects stale movement snapshots", () => {
    const timeline = new GreenhouseMovementTimeline();
    timeline.start("session", stopped(100, 100), 0, 1_000, 0);
    expect(timeline.applySnapshot("old-session", stopped(120, 100), 1, 1_050, 50)).toBe("ignored");
    expect(timeline.applySnapshot("session", {
      x: 100,
      y: 100,
      targetX: 300,
      targetY: 100,
      moving: true,
      revision: 1
    }, 1, 1_050, 50)).toBe("accepted");
    expect(timeline.render(100)!.x).toBeGreaterThan(100);
  });
});
