import { describe, expect, it } from "vitest";

import { SalonMovementTimeline } from "./salonMovementTimeline.js";

const stopped = (x: number, y: number, revision = 0) => ({
  x, y, targetX: null, targetY: null, moving: false, revision
});

describe("SalonMovementTimeline", () => {
  it("renders smooth progress and reconciles to authoritative arrival", () => {
    const timeline = new SalonMovementTimeline();
    timeline.start("session", stopped(100, 100), 0, 1_000, 0);
    expect(timeline.applySnapshot("session", {
      x: 110, y: 100, targetX: 220, targetY: 100, moving: true, revision: 1
    }, 1, 1_050, 50)).toBe("accepted");
    const frames = Array.from({ length: 8 }, (_, index) => timeline.render(50 + index * 16)!.x);
    expect(new Set(frames).size).toBeGreaterThan(6);
    expect(frames.every((value, index) => index === 0 || value >= frames[index - 1]!)).toBe(true);

    expect(timeline.applySnapshot("session", stopped(220, 100, 2), 2, 1_200, 200)).toBe("accepted");
    let rendered = timeline.render(216)!;
    for (let now = 232; now <= 800; now += 16) rendered = timeline.render(now)!;
    expect(rendered).toEqual({ x: 220, y: 100, moving: false });
  });

  it("ignores stale identity and snaps large corrections", () => {
    const timeline = new SalonMovementTimeline();
    timeline.start("current", stopped(100, 100), 5, 1_000, 0);
    expect(timeline.applySnapshot("old", stopped(120, 100), 6, 1_100, 10)).toBe("ignored");
    expect(timeline.applySnapshot("current", stopped(120, 100), 5, 1_100, 10)).toBe("ignored");
    expect(timeline.applySnapshot("current", stopped(500, 500), 6, 1_100, 10)).toBe("snapped");
    expect(timeline.render(10)).toEqual({ x: 500, y: 500, moving: false });
  });
});
