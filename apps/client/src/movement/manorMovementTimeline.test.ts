import { describe, expect, it } from "vitest";

import { ManorMovementTimeline } from "./manorMovementTimeline.js";

const stopped = (x: number, y: number, revision = 0) => ({
  x, y, targetX: null, targetY: null, moving: false, revision
});
const moving = (x: number, y: number, targetX: number, targetY: number, revision = 1) => ({
  x, y, targetX, targetY, moving: true, revision
});

describe("ManorMovementTimeline", () => {
  it("interpolates at render cadence and lands exactly on the final authority", () => {
    const timeline = new ManorMovementTimeline();
    timeline.start("session", stopped(100, 100), 0, 1_000, 0);
    expect(timeline.applySnapshot("session", moving(110, 100, 200, 100), 1, 1_050, 50)).toBe("accepted");
    const frames = Array.from({ length: 12 }, (_, index) => {
      if (index > 0 && index % 3 === 0) {
        timeline.applySnapshot("session", moving(110 + index * 3, 100, 200, 100), 1 + index / 3,
          1_050 + index * 16, 50 + index * 16);
      }
      return timeline.render(50 + index * 16)!.x;
    });
    expect(new Set(frames).size).toBeGreaterThan(10);
    expect(frames.every((value, index) => index === 0 || value >= frames[index - 1]!)).toBe(true);
    timeline.applySnapshot("session", stopped(200, 100, 1), 5, 1_500, 500);
    let rendered = timeline.render(516)!;
    for (let now = 532; now <= 1_000; now += 16) rendered = timeline.render(now)!;
    expect(rendered).toEqual({ x: 200, y: 100, moving: false });
  });

  it("ignores stale sessions and sequences and snaps large corrections", () => {
    const timeline = new ManorMovementTimeline();
    timeline.start("current", stopped(100, 100), 5, 1_000, 0);
    expect(timeline.applySnapshot("old", stopped(120, 100), 6, 1_100, 10)).toBe("ignored");
    expect(timeline.applySnapshot("current", stopped(120, 100), 5, 1_100, 10)).toBe("ignored");
    expect(timeline.applySnapshot("current", stopped(500, 500), 6, 1_100, 10)).toBe("snapped");
    expect(timeline.render(10)).toEqual({ x: 500, y: 500, moving: false });
  });

  it("accepts one thousand snapshots without subscriptions or React state", () => {
    const timeline = new ManorMovementTimeline();
    timeline.start("session", stopped(100, 100), 0, 1_000, 0);
    for (let sequence = 1; sequence <= 1_000; sequence += 1) {
      expect(timeline.applySnapshot("session", moving(100 + sequence / 10, 100, 300, 100), sequence,
        1_000 + sequence * 50, sequence * 50)).not.toBe("ignored");
    }
    expect(timeline.currentSequence()).toBe(1_000);
  });
});
