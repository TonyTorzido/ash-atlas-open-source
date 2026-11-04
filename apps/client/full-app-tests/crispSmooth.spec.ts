/**
 * Crisp rendering and smooth walking (docs/plans/crisp-smooth.md), end to end in headless Chromium at an iPhone-like
 * viewport against a feature runtime (ACTION_COMBAT_ENABLED, MOB_TACTICS_ENABLED, MOB_ARCHETYPES_ENABLED true).
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41717 pnpm exec playwright test --config playwright-full-app.config.ts crispSmooth
 *
 * Env: E2E_DPR (default 3), E2E_CPU_THROTTLE (CDP CPU slowdown, default 4 = a mid phone), E2E_WALK_MS (default 4000).
 * - every canvas (MapLibre and the Pixi overlay) has a backing store of CSS size x DPR
 * - walking: frame-time distribution, long frames, camera step variance, sprite vs ground mismatch and sprite jitter
 */
import { expect, test, chromium, type Browser } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, note, baseUrl, outDir } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const DPR = Number(process.env.E2E_DPR ?? 3);
const THROTTLE = Number(process.env.E2E_CPU_THROTTLE ?? 4);
const WALK_MS = Number(process.env.E2E_WALK_MS ?? 4000);
const PORTRAIT = { width: 393, height: 852 };

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : [] }); });
test.afterAll(async () => { await browser?.close(); });

const stats = (xs: number[]): { mean: number; sd: number; p50: number; p95: number; p99: number; max: number } => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length));
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return { mean, sd, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0 };
};
const r2 = (n: number): number => Math.round(n * 100) / 100;

test("1. every canvas has a backing store of CSS size x DPR", async () => {
  const { ctx, s } = await launch(browser, "cs-resolution", { viewport: PORTRAIT, joystick: true, dpr: DPR });
  try {
    const canvases = await s.page.evaluate(() => Array.from(document.querySelectorAll("canvas")).map((c) => {
      const box = c.getBoundingClientRect();
      return { cls: c.className, cssW: box.width, cssH: box.height, w: c.width, h: c.height };
    }).filter((c) => c.cssW >= 100 && c.cssH >= 100));
    note("canvases", JSON.stringify({ dpr: DPR, canvases }));
    expect(canvases.length, "the map and the overlay canvases exist").toBeGreaterThanOrEqual(2);
    for (const c of canvases) {
      expect(Math.abs(c.w - c.cssW * DPR), `${c.cls} width ${c.w} vs ${c.cssW} x ${DPR}`).toBeLessThanOrEqual(DPR + 1);
      expect(Math.abs(c.h - c.cssH * DPR), `${c.cls} height ${c.h} vs ${c.cssH} x ${DPR}`).toBeLessThanOrEqual(DPR + 1);
    }
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("2. walking: frames, camera and sprite stay in lockstep", async () => {
  const { ctx, s } = await launch(browser, "cs-walk", { viewport: PORTRAIT, joystick: true, dpr: DPR, storage: { "ashAtlas.floatingSticks.v1": "0", "ash-atlas:perf-probe": "1" } });
  try {
    const gotIt = s.page.getByRole("button", { name: "Got it" });
    if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
    await s.page.getByRole("button", { name: /Tap to center the map on you/ }).first().tap({ timeout: 8000 }).catch(() => undefined);
    await s.page.waitForTimeout(1500);
    if (THROTTLE > 1) {
      const cdp = await ctx.newCDPSession(s.page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
    }
    await s.page.keyboard.down("d");
    await s.page.waitForTimeout(1200);
    await s.page.evaluate(({ lat, lon }) => {
      const w = window as any;
      const probe = w.__ASH_ATLAS_FRAME_PROBE__;
      probe.samples.length = 0;
      probe.anchor = [lon, lat];
      probe.on = true;
      w.__react0 = probe.reactRenders();
      w.__raf = [] as number[];
      w.__rafOn = true;
      const tick = (t: number): void => { if (!w.__rafOn) return; w.__raf.push(t); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }, { lat: s.self.lat, lon: s.self.lon });
    const profiler = process.env.E2E_PROFILE ? await ctx.newCDPSession(s.page) : null;
    if (profiler) { await profiler.send("Profiler.enable"); await profiler.send("Profiler.setSamplingInterval", { interval: 200 }); await profiler.send("Profiler.start"); }
    await s.page.waitForTimeout(WALK_MS);
    if (profiler) {
      const { profile } = await profiler.send("Profiler.stop");
      writeFileSync(join(outDir, "walk.cpuprofile"), JSON.stringify(profile));
    }
    const data = await s.page.evaluate(() => {
      const w = window as any;
      w.__rafOn = false;
      w.__ASH_ATLAS_FRAME_PROBE__.on = false;
      const r1 = w.__ASH_ATLAS_FRAME_PROBE__.reactRenders();
      const prior = new Map<string, number>(w.__react0.reasons);
      const reasons = r1.reasons.map(([k, v]: [string, number]) => [k, v - (prior.get(k) ?? 0)]).filter((x: [string, number]) => x[1] > 0);
      return { reactRenders: r1.renders - w.__react0.renders, reasons, raf: w.__raf as number[], samples: w.__ASH_ATLAS_FRAME_PROBE__.samples as { kind: string; t: number; ax: number; ay: number; px: number; py: number }[] };
    });
    await s.page.keyboard.up("d");

    const dts = data.raf.slice(1).map((t, i) => t - data.raf[i]!);
    const frame = stats(dts);
    const long = dts.filter((d) => d > 20).length;
    const veryLong = dts.filter((d) => d > 33.4).length;

    const maps = data.samples.filter((x) => x.kind === "m");
    const overlays = data.samples.filter((x) => x.kind === "o");
    // Speeds are measured against the display cadence (the spec's own rAF timestamps), because that is what the eye sees: a
    // sample is assigned to the display frame it was drawn in, and its step is divided by the time that frame lasted.
    // (performance.now() inside the callbacks jitters by a millisecond or two, which would read as uneven motion.)
    const frameOf = (t: number): number => {
      let lo = 0; let hi = data.raf.length - 1; let at = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (data.raf[mid]! <= t) { at = mid; lo = mid + 1; } else hi = mid - 1; }
      return at;
    };
    const perFrame = (xs: typeof maps): { f: number; x: (typeof maps)[number] }[] => {
      const out: { f: number; x: (typeof maps)[number] }[] = [];
      for (const x of xs) { const f = frameOf(x.t); if (f < 1) continue; if (out.length && out[out.length - 1]!.f === f) out[out.length - 1] = { f, x }; else out.push({ f, x }); }
      return out;
    };
    // The walk may end early (the player reaches water or a wall): keep only the frames before the motion stops.
    const whileWalking = (speeds: number[]): number[] => {
      const p90 = [...speeds].sort((a, b) => a - b)[Math.floor(speeds.length * 0.9)] ?? 0;
      for (let i = 0; i + 2 < speeds.length; i++) if (speeds[i]! < 0.3 * p90 && speeds[i + 1]! < 0.3 * p90 && speeds[i + 2]! < 0.3 * p90) return speeds.slice(0, i);
      return speeds;
    };
    const frameDt = (a: number, b: number): number => data.raf[b]! - data.raf[a]!;
    // Camera: ground speed (px/ms) between consecutive display frames. Smooth = low coefficient of variation.
    const camSpeedsAll: number[] = [];
    const mf = perFrame(maps);
    for (let i = 1; i < mf.length; i++) {
      if (mf[i]!.f !== mf[i - 1]!.f + 1) continue;
      const dt = frameDt(mf[i - 1]!.f, mf[i]!.f);
      if (dt < 4 || dt > 60) continue;
      camSpeedsAll.push(Math.hypot(mf[i]!.x.ax - mf[i - 1]!.x.ax, mf[i]!.x.ay - mf[i - 1]!.x.ay) / dt);
    }
    const camSpeeds = whileWalking(camSpeedsAll);
    const cam = stats(camSpeeds);
    if (process.env.E2E_DUMP) note("cam outliers (index:speed)", camSpeeds.map((v, i) => [i, v] as const).filter(([, v]) => Math.abs(v - cam.p50) > 0.25 * cam.p50).map(([i, v]) => `${i}:${r2(v)}`).join(" ") + ` median ${r2(cam.p50)} n ${camSpeeds.length}`);
    if (process.env.E2E_DUMP) note("cam frame dt:step", mf.slice(1, 80).map((m, i) => `${m.f - mf[i]!.f}:${r2(frameDt(mf[i]!.f, m.f))}:${r2(Math.hypot(m.x.ax - mf[i]!.x.ax, m.x.ay - mf[i]!.x.ay))}`).join(" "));
    // Layer mismatch: the anchor as the overlay saw it vs the map render of the same display frame (or the last one before it).
    const mismatch: number[] = [];
    let mi = 0;
    for (const o of overlays) {
      while (mi + 1 < maps.length && maps[mi + 1]!.t <= o.t) mi++;
      const m = maps[mi];
      if (m && m.t <= o.t) mismatch.push(Math.hypot(o.ax - m.ax, o.ay - m.ay));
    }
    // Sprite: speed over the ground (sprite minus anchor, so the camera cancels) and its screen position jitter.
    const spriteSpeedsAll: number[] = [];
    const screenStep: number[] = [];
    const of = perFrame(overlays);
    for (let i = 1; i < of.length; i++) {
      if (of[i]!.f !== of[i - 1]!.f + 1) continue;
      const a = of[i - 1]!.x; const b = of[i]!.x;
      const dt = frameDt(of[i - 1]!.f, of[i]!.f);
      if (dt < 4 || dt > 60) continue;
      spriteSpeedsAll.push(Math.hypot((b.px - b.ax) - (a.px - a.ax), (b.py - b.ay) - (a.py - a.ay)) / dt);
      screenStep.push(Math.hypot(b.px - a.px, b.py - a.py));
    }
    const sprite = stats(whileWalking(spriteSpeedsAll));
    const screen = stats(screenStep);
    const mm = stats(mismatch);
    const result = {
      dpr: DPR, cpuThrottle: THROTTLE, frames: dts.length, fps: r2(1000 / frame.mean),
      frameMs: { mean: r2(frame.mean), p50: r2(frame.p50), p95: r2(frame.p95), p99: r2(frame.p99), max: r2(frame.max) },
      reactRendersPerSec: r2(data.reactRenders / (WALK_MS / 1000)), reactReasons: data.reasons, longFramesOver20ms: long, framesOver33ms: veryLong,
      mapRenders: maps.length, overlayRenders: overlays.length,
      cameraSpeedCV: r2(cam.sd / Math.max(cam.mean, 1e-6)),
      spriteGroundSpeedCV: r2(sprite.sd / Math.max(sprite.mean, 1e-6)),
      layerMismatchPx: { mean: r2(mm.mean), p95: r2(mm.p95), max: r2(mm.max) },
      spriteScreenStepPx: { mean: r2(screen.mean), p95: r2(screen.p95), max: r2(screen.max) }
    };
    note("walk", JSON.stringify(result));
    if (process.env.E2E_DUMP) {
      const rows = maps.slice(1, 61).map((m, i) => `${r2(m.t - maps[i]!.t)}:${r2(Math.hypot(m.ax - maps[i]!.ax, m.ay - maps[i]!.ay))}`);
      note("camera dt:step", rows.join(" "));
      const orows = overlays.slice(1, 61).map((o, i) => `${r2(o.t - overlays[i]!.t)}:${r2(o.px - overlays[i]!.px)}`);
      note("sprite dt:dx", orows.join(" "));
    }
    expect(frame.mean, "walking keeps a playable frame rate").toBeLessThan(40);
    expect(mm.p95, "the sprites and the ground are drawn with the same camera").toBeLessThan(1.5);
    expect(cam.sd / Math.max(cam.mean, 1e-6), "the camera advances evenly").toBeLessThan(0.4);
    expect(sprite.sd / Math.max(sprite.mean, 1e-6), "the player walks at an even speed over the ground").toBeLessThan(0.4);
    expect(long / Math.max(1, dts.length), "few frames run long").toBeLessThan(0.15);
    expect(screen.p95, "the sprite does not jump around the screen").toBeLessThan(6);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});
