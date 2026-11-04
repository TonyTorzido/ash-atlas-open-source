import { describe, expect, it } from "vitest";

import { CameraTargetFilter } from "./cameraTargetFilter.js";

/** A straight walk at 240 px/s along x with server corrections: every 50 ms the point is pulled back 3 px, plus per-frame noise. */
function jitteryRaw(tMs: number, seed: number): { x: number; y: number } {
  const snapBack = Math.floor(tMs / 50) % 2 === 1 ? -3 : 0;
  const noise = Math.sin(seed * 12.9898 + tMs * 0.731) * 1.2;
  return { x: (240 * tMs) / 1_000 + snapBack + noise, y: Math.cos(seed * 4.1 + tMs) * 0.8 };
}

function run(frameTimes: number[], raw: (t: number) => { x: number; y: number }): Array<{ t: number; x: number; y: number }> {
  const filter = new CameraTargetFilter();
  const out: Array<{ t: number; x: number; y: number }> = [];
  let last = frameTimes[0]!;
  for (const t of frameTimes) {
    const f = filter.update(raw(t), t - last);
    out.push({ t, x: f.x, y: f.y });
    last = t;
  }
  return out;
}

const frames = (hz: number, ms: number, drop?: (i: number) => boolean): number[] => {
  const out: number[] = [];
  const step = 1_000 / hz;
  for (let i = 0; i * step <= ms; i += 1) if (!drop?.(i)) out.push(i * step);
  return out;
};

describe("camera target filter", () => {
  it("turns a jittery walk (snap-backs and noise) into a camera target that never steps back along the walk", () => {
    for (const hz of [60, 90, 120]) {
      let seed = 0;
      const out = run(frames(hz, 4_000), (t) => jitteryRaw(t, ++seed));
      const steps = out.slice(1).map((p, i) => p.x - out[i]!.x);
      // Once it is moving (the axis exists), not one backwards step.
      const moving = steps.slice(Math.round(hz * 0.3));
      expect(Math.min(...moving), `${hz} Hz`).toBeGreaterThanOrEqual(-1e-9);
      // And the speed is steady: the per-frame step varies far less than the raw input's.
      const mean = moving.reduce((a, b) => a + b, 0) / moving.length;
      const sd = Math.sqrt(moving.reduce((a, b) => a + (b - mean) ** 2, 0) / moving.length);
      expect(sd / mean, `${hz} Hz speed CV`).toBeLessThan(0.25);
    }
  });

  it("trails a steady walk by under a pixel once settled", () => {
    const out = run(frames(60, 1_500), (t) => ({ x: (240 * t) / 1_000, y: 0 }));
    const last = out[out.length - 1]!;
    expect(Math.abs(last.x - (240 * last.t) / 1_000)).toBeLessThan(1);
  });

  it("gives the same curve at 60 Hz, 120 Hz and 60 Hz with dropped frames", () => {
    // Walk, a 6 px correction back at 600 ms, then a turn to +y at 1200 ms.
    const raw = (t: number): { x: number; y: number } => ({
      x: (240 * Math.min(t, 1_200)) / 1_000 - (t >= 600 ? 6 : 0),
      y: t > 1_200 ? (240 * (t - 1_200)) / 1_000 : 0
    });
    const a = run(frames(60, 2_000), raw);
    const b = run(frames(120, 2_000), raw);
    const c = run(frames(60, 2_000, (i) => i % 7 === 3 || i % 11 === 5), raw);
    const at = (series: typeof a, t: number) => series.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best));
    for (let t = 200; t <= 2_000; t += 100) {
      const pa = at(a, t);
      for (const other of [b, c]) {
        const po = at(other, pa.t);
        if (Math.abs(po.t - pa.t) > 0.5) continue; // compare only frames that exist in both
        expect(Math.hypot(po.x - pa.x, po.y - pa.y), `t=${t}`).toBeLessThan(0.75);
      }
    }
  });

  it("restarts at a teleport instead of sliding across the map", () => {
    const filter = new CameraTargetFilter();
    filter.update({ x: 0, y: 0 }, 16);
    filter.update({ x: 4, y: 0 }, 16);
    expect(filter.update({ x: 5_000, y: 0 }, 16)).toEqual({ x: 5_000, y: 0 });
  });
});
