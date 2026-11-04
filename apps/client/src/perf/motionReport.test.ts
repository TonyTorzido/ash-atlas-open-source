import { describe, expect, it } from "vitest";

import { countBackSteps, countReversals, localHeadings, summarizeMotionFrames } from "./motionReport.js";

const frame = (i: number, x: number, extra: Partial<{ m: number; mismatch: number | null; sprite: { x: number; y: number } | null; dt: number }> = {}) => ({
  t: i * (extra.dt ?? 1000 / 120),
  m: extra.m ?? 1,
  o: 1,
  anchor: { x, y: 0 },
  sprite: extra.sprite ?? { x: 200, y: 400 },
  mismatch: extra.mismatch ?? 0,
  walking: true
});

describe("motion report summary", () => {
  it("counts direction flips along an axis and ignores sub-threshold steps", () => {
    expect(countReversals([{ x: 1, y: 0 }, { x: 1, y: 0 }, { x: 0.01, y: 0 }, { x: -1, y: 0 }, { x: 1, y: 0 }], { x: 1, y: 0 })).toBe(2);
    expect(countReversals([{ x: 1, y: 0 }, { x: 0, y: 3 }], { x: 1, y: 0 })).toBe(0);
  });

  it("a steady 120 Hz pan has no reversals, a shaking one does; double map renders and layer mismatch are counted", () => {
    const steady = Array.from({ length: 120 }, (_, i) => frame(i, -2 * i));
    const s = summarizeMotionFrames(steady, { x: 200, y: 400 });
    expect(s.refreshHz).toBe(120);
    expect(s.camReversals).toBe(0);
    expect(s.camStepMeanPx).toBe(2);
    expect(s.framesOver20).toBe(0);
    expect(s.playerOffsetP95Px).toBe(0);
    const shaky = Array.from({ length: 120 }, (_, i) => frame(i, -2 * i + (i % 2 === 0 ? 0 : 3), { m: i % 10 === 0 ? 2 : 1, mismatch: i % 4 === 0 ? 1.5 : 0 }));
    const k = summarizeMotionFrames(shaky, { x: 200, y: 400 });
    expect(Number(k.camReversals)).toBeGreaterThan(50);
    expect(k.movingFramesMap2Plus).toBe(11);
    expect(k.layerMismatchFrames).toBe(29);
    expect(k.layerMismatchMaxPx).toBe(1.5);
  });
  it("measures back steps against the local heading, so a turn is not a reversal", () => {
    // Walk east for 60 frames, then turn north for 60: no step goes back along the local heading.
    const turn = [
      ...Array.from({ length: 60 }, () => ({ x: 2, y: 0 })),
      ...Array.from({ length: 60 }, () => ({ x: 0, y: 2 }))
    ];
    expect(countBackSteps(turn, localHeadings(turn))).toBe(0);
    // The whole-sample axis (north-east) used to count none here either, but a real back step is caught.
    const jolt = [...turn.slice(0, 30), { x: -1, y: 0 }, ...turn.slice(30)];
    expect(countBackSteps(jolt, localHeadings(jolt))).toBe(1);
    const uTurn = [
      ...Array.from({ length: 60 }, () => ({ x: 2, y: 0 })),
      ...Array.from({ length: 30 }, () => ({ x: 0, y: 2 })),
      ...Array.from({ length: 60 }, () => ({ x: -2, y: 0 }))
    ];
    const summary = summarizeMotionFrames(
      uTurn.reduce<Array<ReturnType<typeof frame>>>((frames, step, i) => {
        const last = frames.at(-1)!;
        frames.push({ ...frame(i + 1, 0), anchor: { x: last.anchor.x + step.x, y: last.anchor.y + step.y } });
        return frames;
      }, [frame(0, 0)]),
      { x: 200, y: 400 }
    );
    expect(summary.camBackSteps).toBe(0);
    expect(summary.camReversals).toBe(0);
  });
});
