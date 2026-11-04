/**
 * Combat polish (docs/plans/combat-polish.md): real headless Chromium with CDP touch against a feature runtime started with
 * ACTION_COMBAT_ENABLED, MOB_TACTICS_ENABLED, MOB_ARCHETYPES_ENABLED true (dev tools allowed):
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> COMBAT_POLISH_LABEL=after pnpm exec playwright test --config playwright-full-app.config.ts combatPolish
 *
 * Every test writes its numbers to <ASH_ATLAS_E2E_OUT>/combat-polish-<LABEL>.json so a before/after pair (run the spec once on the
 * base commit with COMBAT_POLISH_LABEL=before, once on the branch with =after) can be diffed. Guard assertions
 * (COMBAT_POLISH_GUARD, default on) pin the new behaviour; set COMBAT_POLISH_GUARD=0 to only measure on the old code.
 */
import { expect, test, chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, note, outDir, baseUrl, sleep, type Session, type Frame } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend with action combat on");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const GUARD = (process.env.COMBAT_POLISH_GUARD ?? "1") !== "0";
const LABEL = process.env.COMBAT_POLISH_LABEL ?? "run";
const REPORT = join(outDir, `combat-polish-${LABEL}.json`);
const report: Record<string, unknown> = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, "utf8")) : {};
const record = (key: string, value: unknown): void => {
  report[key] = value;
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  note(key, JSON.stringify(value));
};
const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : sorted[Math.floor(sorted.length / 2)]!;
};

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : [] }); });
test.afterAll(async () => { await browser?.close(); });

const PORTRAIT = { width: 390, height: 844 };

type Finger = { id: number; x: number; y: number };
class Touch {
  private fingers = new Map<number, Finger>();
  constructor(private cdp: CDPSession) {}
  private async send(type: "touchStart" | "touchMove" | "touchEnd", only?: Finger): Promise<void> {
    const points = only ? [only] : [...this.fingers.values()];
    await this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((f) => ({ x: f.x, y: f.y, id: f.id })) });
  }
  async down(id: number, x: number, y: number): Promise<void> { this.fingers.set(id, { id, x, y }); await this.send("touchStart"); }
  async move(id: number, x: number, y: number): Promise<void> { this.fingers.set(id, { id, x, y }); await this.send("touchMove"); }
  async up(id: number): Promise<void> { const f = this.fingers.get(id); if (!f) return; await this.send("touchEnd", f); this.fingers.delete(id); }
}

/** Page-side recorder: pointer-downs, SWING / DASH sends and the hit feedback counters, all on one performance.now clock. */
async function installRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__polish) return;
    const polish = { downs: [] as number[], swings: [] as Array<{ at: number; dirX: number; dirY: number }>, dashes: [] as number[], hitstops: [] as number[] };
    w.__polish = polish;
    document.addEventListener("pointerdown", () => polish.downs.push(performance.now()), true);
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: any) {
      if (typeof data === "string") {
        if (data.includes('"type":"SWING"')) { try { const j = JSON.parse(data); polish.swings.push({ at: performance.now(), dirX: j.dirX, dirY: j.dirY }); } catch { /* ignore */ } }
        else if (data.includes('"type":"DASH"')) polish.dashes.push(performance.now());
      }
      return send.call(this, data);
    };
    // Predicted hit effects: the overlay publishes the start of the latest hitstop (performance.now) in the feedback stats.
    let last = Number.NaN;
    const poll = (): void => {
      const stats = w.__ASH_ATLAS_HIT_FEEDBACK__;
      if (stats && stats.lastHitstopStartMs !== last && Number.isFinite(stats.lastHitstopStartMs)) { last = stats.lastHitstopStartMs; polish.hitstops.push(last); }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

async function boot(name: string, viewport = PORTRAIT): Promise<{ ctx: BrowserContext; s: Session; t: Touch }> {
  const storage: Record<string, string> = { "ashAtlas.floatingSticks.v1": "0", "ashAtlas.flickDash.v1": "1" };
  const { ctx, s } = await launch(browser, name, { viewport, joystick: true, storage });
  const gotIt = s.page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await installRecorder(s.page);
  return { ctx, s, t: new Touch(await ctx.newCDPSession(s.page)) };
}

const polishState = (s: Session) => s.page.evaluate(() => {
  const p = (window as any).__polish;
  return { downs: [...p.downs] as number[], swings: [...p.swings] as Array<{ at: number; dirX: number; dirY: number }>, dashes: [...p.dashes] as number[], hitstops: [...p.hitstops] as number[] };
});
const attackCentre = async (s: Session): Promise<{ x: number; y: number }> => {
  const box = (await s.page.locator(".joystick-attack-face").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const dirTo = (s: Session, id: string): { x: number; y: number } => {
  const e = s.ents.get(id)!;
  const dx = (e.lon - s.self.lon) * Math.cos((s.self.lat * Math.PI) / 180);
  const dy = e.lat - s.self.lat;
  const len = Math.hypot(dx, dy);
  return { x: dx / len, y: dy / len };
};
void ({} as Frame);

test("A1/A3: the swing leaves on touch-down and the hit effects land with the blade", async () => {
  const { ctx, s, t } = await boot("polish-touchdown");
  try {
    const dummy = await s.spawn("training_dummy", 40, 0);
    await sleep(900);
    const at = await attackCentre(s);
    const TAP_MS = 110;
    const trials: Array<{ tapToSwingMs: number; tapToEffectMs: number; swingsSent: number; aimDot: number }> = [];
    for (let trial = 0; trial < 6; trial += 1) {
      const before = await polishState(s);
      await t.down(1, at.x, at.y);
      await sleep(TAP_MS);
      await t.up(1);
      // Long enough for a double fire (a repeat at the 700 ms recovery) to show, short of the next trial.
      await sleep(1200);
      const after = await polishState(s);
      const down = after.downs[before.downs.length]!;
      const swings = after.swings.slice(before.swings.length);
      const hitstop = after.hitstops[before.hitstops.length];
      expect(swings.length, `trial ${trial}: a tap swings exactly once`).toBe(1);
      const dir = dirTo(s, dummy.id);
      trials.push({
        tapToSwingMs: round(swings[0]!.at - down),
        tapToEffectMs: hitstop === undefined ? Number.NaN : round(hitstop - down),
        swingsSent: swings.length,
        aimDot: round(swings[0]!.dirX * dir.x + swings[0]!.dirY * dir.y, 3)
      });
    }
    record("A1.tap", { tapMs: TAP_MS, trials, medianTapToSwingMs: median(trials.map((x) => x.tapToSwingMs)), medianTapToEffectMs: median(trials.map((x) => x.tapToEffectMs)) });
    for (const trial of trials) expect(trial.aimDot, "tap auto-aim still aims at the dummy").toBeGreaterThan(0.95);
    if (GUARD) {
      expect(median(trials.map((x) => x.tapToSwingMs)), "the swing is sent within a frame or two of the touch").toBeLessThan(40);
      const effect = median(trials.map((x) => x.tapToEffectMs));
      expect(effect, "the hit effect lands at the contact frame (~105 ms, 119 ms on the finisher), not on the lift").toBeGreaterThan(90);
      expect(effect).toBeLessThan(150);
    }

    // Hold: repeats from the first frame at the recovery cadence (no 400 ms wait).
    const before = await polishState(s);
    await t.down(1, at.x, at.y);
    await sleep(2400);
    await t.up(1);
    const after = await polishState(s);
    const down = after.downs[before.downs.length]!;
    const times = after.swings.slice(before.swings.length).map((x) => round(x.at - down));
    record("A1.hold", { firstSwingMs: times[0], swingTimesMs: times });
    if (GUARD) {
      expect(times[0]!, "a held button swings at once").toBeLessThan(40);
      expect(times.length, "and keeps repeating at the recovery cadence").toBeGreaterThanOrEqual(3);
      for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!, "no double fire inside a recovery").toBeGreaterThan(650);
    }
    await s.shot("touchdown");
  } finally {
    await ctx.close();
  }
});

test("A7/A4: a confirmed hit kicks the screen and fires the combat cues; haptics are a no-op on web", async () => {
  const { ctx, s, t } = await boot("polish-cues");
  try {
    await s.spawn("training_dummy", 40, 0);
    await sleep(900);
    const at = await attackCentre(s);
    const stats = () => s.page.evaluate(() => {
      const w = window as any;
      return { kicks: w.__ASH_ATLAS_HIT_FEEDBACK__.kicks as number, counts: { ...w.__ASH_ATLAS_COMBAT_CUES__.counts } as Record<string, number>, hapticCalls: w.__ASH_ATLAS_COMBAT_CUES__.hapticCalls as number, hapticSkipped: w.__ASH_ATLAS_COMBAT_CUES__.hapticSkipped as number };
    });
    const before = await stats();
    for (let i = 0; i < 3; i += 1) {
      await t.down(1, at.x, at.y);
      await sleep(90);
      await t.up(1);
      await sleep(1100);
    }
    const after = await stats();
    record("A7.cues", { before, after });
    if (GUARD) {
      expect(after.kicks - before.kicks, "every confirmed hit kicks the screen once").toBe(3);
      expect((after.counts.hit ?? 0) - (before.counts.hit ?? 0), "a hit cue per confirmed hit").toBe(3);
      expect((after.counts.swing ?? 0) - (before.counts.swing ?? 0), "a swing cue per swing").toBe(3);
      expect(after.hapticCalls, "no native haptic call on web").toBe(0);
      expect(after.hapticSkipped - before.hapticSkipped, "the web skips were counted").toBeGreaterThanOrEqual(3);
    }
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Phase B: the death beat, mob smoothing
// ---------------------------------------------------------------------------------------------------------------------

type Damage = { targetEntityId?: string; sourceEntityId?: string; amount?: number };
/** DAMAGE events (parsed from COMBAT_DELTA / SWING frames) from `sourceId` onto `targetId` since `mark`. */
function damageEvents(s: Session, mark: number, sourceId: string, targetId: string): Damage[] {
  const out: Damage[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 8) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if (o.type === "DAMAGE" && o.targetEntityId === targetId && o.sourceEntityId === sourceId) out.push(o as Damage);
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  };
  for (const f of s.since(mark, undefined, "in")) {
    if (!f.raw.includes('"DAMAGE"')) continue;
    try { walk(JSON.parse(f.raw), 0); } catch { /* ignore */ }
  }
  return out;
}

test("B1/B2: the killing blow's number survives and the death ghost plays (before vs after legacyDeathBeat)", async () => {
  const { ctx, s, t } = await boot("polish-death");
  try {
    await s.clearMobs();
    await sleep(500);
    const at = await attackCentre(s);
    const KILLS = Number(process.env.COMBAT_POLISH_KILLS ?? 2);
    const runs: Record<string, Array<Record<string, unknown>>> = { "before(legacyDeathBeat)": [], after: [] };
    const ghostSamples: Array<Array<[number, number, number, number, number, number]>> = [];
    for (let round_ = 0; round_ < KILLS; round_ += 1) {
      for (const legacy of [true, false]) {
        const mode = legacy ? "before(legacyDeathBeat)" : "after";
        await s.page.evaluate((v) => { (window as any).__ASH_ATLAS_HIT_FEEDBACK__.legacyDeathBeat = v; }, legacy);
        const dummy = await s.spawn("training_dummy", 40, 0);
        await sleep(700);
        const stats = () => s.page.evaluate(() => { const h = (window as any).__ASH_ATLAS_HIT_FEEDBACK__; return { drawn: h.floatersDrawnTotal as number, orphan: h.orphanFloatersDrawn as number, ghosts: h.deathGhostsStarted as number, hitstops: h.hitstops as number, shakes: h.shakeStarts as number, kills: ((window as any).__ASH_ATLAS_COMBAT_CUES__.counts.kill ?? 0) as number }; });
        const before = await stats();
        const mark = s.mark();
        // Per-frame ghost samples (alpha, scale, flash, position) from the overlay, plus screenshots for the frame strip.
        await s.page.evaluate(() => { const h = (window as any).__ASH_ATLAS_HIT_FEEDBACK__; h.deathGhostFrames.length = 0; h.deathGhostProbe = true; });
        await t.down(1, at.x, at.y);
        const killed = (): boolean => s.since(mark, undefined, "in").some((f) => f.raw.includes("MOB_REMOVED") && f.raw.includes(dummy.id));
        await s.until(killed, 60_000, "the dummy to be defeated");
        await t.up(1);
        const shots: Array<{ t: number; png: string }> = [];
        if (!legacy && round_ === 0) {
          for (let i = 0; i < 40 && shots.length < 16; i += 1) {
            const when = await s.page.evaluate(() => performance.now());
            shots.push({ t: when, png: (await s.page.screenshot({ type: "jpeg", quality: 85 })).toString("base64") });
            if (when - shots[0]!.t > 760) break;
          }
        }
        await sleep(1500);
        const ghostFrames = await s.page.evaluate(() => { const h = (window as any).__ASH_ATLAS_HIT_FEEDBACK__; h.deathGhostProbe = false; return h.deathGhostFrames.splice(0) as Array<[number, number, number, number, number, number]>; });
        if (!legacy) ghostSamples.push(ghostFrames);
        if (!legacy && round_ === 0 && ghostFrames.length > 0) await writeDeathStrip(s.page, shots, ghostFrames);
        const after = await stats();
        const hits = damageEvents(s, mark, s.self.id, dummy.id);
        runs[mode]!.push({ hitsLanded: hits.length, killingBlow: hits[hits.length - 1]?.amount ?? null, floatersDrawn: after.drawn - before.drawn, ghosts: after.ghosts - before.ghosts, extraHitstops: after.hitstops - before.hitstops - hits.length, shakes: after.shakes - before.shakes, killCues: after.kills - before.kills });
        await s.clearMobs();
        await sleep(400);
      }
    }
    await s.page.evaluate(() => { (window as any).__ASH_ATLAS_HIT_FEEDBACK__.legacyDeathBeat = false; });
    record("B1B2.death", runs);
    type Run = { hitsLanded: number; floatersDrawn: number; ghosts: number; extraHitstops: number; killCues: number };
    const lost = (runs["before(legacyDeathBeat)"] as unknown as Run[]).reduce((n, r) => n + (r.hitsLanded - r.floatersDrawn), 0);
    record("B1B2.legacyKillNumbersLost", { lost, of: KILLS });
    if (GUARD) {
      for (const r of runs["after"] as unknown as Run[]) {
        expect(r.floatersDrawn, "every landed hit, the killing blow included, draws its number").toBe(r.hitsLanded);
        expect(r.ghosts, "the death ghost plays once").toBe(1);
        expect(r.extraHitstops, "the kill adds its own hitstop").toBe(1);
        expect(r.killCues, "and the kill cue").toBe(1);
      }
      for (const frames of ghostSamples) {
        const m = ghostMetrics(frames);
        record("B1B2.ghostSmoothness", m);
        expect(m.frames, "the ghost is drawn on many frames").toBeGreaterThan(15);
        expect(m.alphaRises, "alpha never rises").toBe(0);
        expect(m.scaleRises, "scale never rises").toBe(0);
        expect(m.maxAlphaPerMs, "no alpha jump").toBeLessThan(0.0045);
        expect(m.maxScalePerMs, "no scale jump").toBeLessThan(0.0008);
        expect(m.maxMovePx, "the ghost stays where it was last drawn").toBeLessThan(1.5);
        expect(m.flashUnimodal, "the flash rises then falls once").toBe(true);
        expect(m.lastAlpha, "alpha reaches 0 before the ghost is removed").toBeLessThan(0.01);
        expect(m.durationMs).toBeGreaterThan(500);
        expect(m.durationMs).toBeLessThan(700);
      }
      for (const r of runs["before(legacyDeathBeat)"] as unknown as Run[]) {
        expect(r.ghosts, "legacy: the mob just pops").toBe(0);
        expect(r.extraHitstops, "legacy: no kill hitstop").toBe(0);
      }
    }
  } finally {
    await ctx.close();
  }
});

type GhostFrame = [number, number, number, number, number, number];
/** Smoothness of one death ghost from the overlay's per-frame samples [frameNowMs, alpha, scale, flash, x, y]. */
function ghostMetrics(frames: GhostFrame[]) {
  let alphaRises = 0, scaleRises = 0, maxAlphaPerMs = 0, maxScalePerMs = 0, maxMovePx = 0, flashDowns = 0, flashUpAfterDown = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1]!, b = frames[i]!, dt = Math.max(1, b[0] - a[0]);
    if (b[1] > a[1] + 1e-6) alphaRises += 1;
    if (b[2] > a[2] + 1e-6) scaleRises += 1;
    maxAlphaPerMs = Math.max(maxAlphaPerMs, Math.abs(b[1] - a[1]) / dt);
    maxScalePerMs = Math.max(maxScalePerMs, Math.abs(b[2] - a[2]) / dt);
    maxMovePx = Math.max(maxMovePx, Math.hypot(b[4] - a[4], b[5] - a[5]));
    if (b[3] < a[3] - 1e-6) flashDowns += 1;
    if (flashDowns > 0 && b[3] > a[3] + 1e-6) flashUpAfterDown += 1;
  }
  const steps = frames.slice(1).map((f, i) => f[0] - frames[i]![0]);
  return {
    frames: frames.length,
    durationMs: round(frames.length ? frames[frames.length - 1]![0] - frames[0]![0] : 0, 0),
    medianFrameMs: round(median(steps), 1),
    alphaRises, scaleRises,
    maxAlphaPerMs: round(maxAlphaPerMs, 5),
    maxAlphaStepPerFrame: round(Math.max(0, ...frames.slice(1).map((f, i) => Math.abs(f[1] - frames[i]![1]))), 3),
    maxScalePerMs: round(maxScalePerMs, 6),
    maxScaleStepPerFrame: round(Math.max(0, ...frames.slice(1).map((f, i) => Math.abs(f[2] - frames[i]![2]))), 4),
    maxMovePx: round(maxMovePx, 2),
    flashPeak: round(Math.max(0, ...frames.map((f) => f[3])), 2),
    flashUnimodal: flashUpAfterDown === 0,
    firstAlpha: round(frames[0]?.[1] ?? Number.NaN, 3),
    lastAlpha: round(frames[frames.length - 1]?.[1] ?? Number.NaN, 4),
    lastScale: round(frames[frames.length - 1]?.[2] ?? Number.NaN, 3)
  };
}

/** docs/plans/death-fade/death-fade-strip.png: screenshots across the ghost's life, cropped around the mob, labelled with ms since the ghost started. */
async function writeDeathStrip(page: Page, shots: Array<{ t: number; png: string }>, frames: GhostFrame[]): Promise<void> {
  const t0 = frames[0]![0];
  const cx = frames[0]![4], cy = frames[0]![5];
  const html = `<body style="margin:0;background:#222;color:#fff;font:12px sans-serif"><div style="display:flex;flex-wrap:wrap;gap:4px;padding:4px;width:1010px">${shots.map((sh) =>
    `<div style="width:120px"><div style="width:120px;height:120px;overflow:hidden;position:relative"><img width="390" height="844" style="position:absolute;left:${60 - cx}px;top:${60 - (cy - 30)}px" src="data:image/jpeg;base64,${sh.png}"></div>${Math.round(sh.t - t0)} ms</div>`).join("")}</div>`;
  const strip = await page.context().newPage();
  try {
    await strip.setViewportSize({ width: 1020, height: 170 * Math.ceil(shots.length / 8) + 20 });
    await strip.setContent(html);
    const dir = join(process.cwd(), "..", "..", "docs", "plans", "death-fade");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "death-fade-strip.png"), await strip.screenshot({ type: "png" }));
  } finally {
    await strip.close();
  }
}

type ProbeFrame = [number, string, number, number];
/** Per-frame step speeds (m/s) of one mob inside [from, to] from the overlay's drawn-position probe. */
function stepSpeeds(frames: ProbeFrame[], id: string, from: number, to: number): { speeds: number[]; times: number[] } {
  const mine = frames.filter((f) => f[1] === id && f[0] >= from && f[0] <= to);
  const speeds: number[] = [];
  const times: number[] = [];
  for (let i = 1; i < mine.length; i += 1) {
    const a = mine[i - 1]!;
    const b = mine[i]!;
    const dt = b[0] - a[0];
    if (dt <= 0 || dt > 60) continue;
    const dy = (b[2] - a[2]) * 111_320;
    const dx = (b[3] - a[3]) * 111_320 * Math.cos((a[2] * Math.PI) / 180);
    speeds.push(Math.hypot(dx, dy) / (dt / 1000));
    times.push(b[0]);
  }
  return { speeds, times };
}
/**
 * Smoothness of a mob's drawn motion from (time, speed) frame samples:
 * - stallInMotion: share of frames that stand still (< 5 m/s) while the mob moves (> 20 m/s) within 150 ms on both sides,
 *   the stop-start glide the old smoother produced;
 * - binStep: mean change of the 100 ms average speed between neighbouring moving bins, relative to the mean speed
 *   (0 = a steady glide; the old smoother re-picked its speed from the packet interval on every delta).
 */
const jitterStats = (samples: Array<[number, number]>): { frames: number; meanMovingSpeed: number; stallInMotion: number; binStep: number } => {
  const sorted = [...samples].sort((a, b) => a[0] - b[0]);
  const moving = sorted.filter((x) => x[1] > 20);
  if (moving.length < 20) return { frames: sorted.length, meanMovingSpeed: Number.NaN, stallInMotion: Number.NaN, binStep: Number.NaN };
  const meanMoving = moving.reduce((a, b) => a + b[1], 0) / moving.length;
  let stalls = 0;
  let inWindow = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const [t, v] = sorted[i]!;
    const before = moving.some((m) => m[0] < t && t - m[0] <= 150);
    const after = moving.some((m) => m[0] > t && m[0] - t <= 150);
    if (before && after) { inWindow += 1; if (v < 5) stalls += 1; }
  }
  const bins = new Map<number, number[]>();
  for (const [t, v] of moving) { const key = Math.floor(t / 100); if (!bins.has(key)) bins.set(key, []); bins.get(key)!.push(v); }
  const keys = [...bins.keys()].sort((a, b) => a - b);
  let stepSum = 0;
  let steps = 0;
  for (let k = 1; k < keys.length; k += 1) {
    if (keys[k]! - keys[k - 1]! !== 1) continue;
    const a = bins.get(keys[k - 1]!)!;
    const b = bins.get(keys[k]!)!;
    stepSum += Math.abs(b.reduce((x, y) => x + y, 0) / b.length - a.reduce((x, y) => x + y, 0) / a.length);
    steps += 1;
  }
  return { frames: sorted.length, meanMovingSpeed: round(meanMoving, 1), stallInMotion: round(stalls / Math.max(inWindow, 1), 3), binStep: round(stepSum / Math.max(steps, 1) / meanMoving, 3) };
};

test("B3/B4: mob drawn-position jitter and the post-hitstop jump (snapshot buffer vs legacy glide)", async () => {
  const { ctx, s, t } = await boot("polish-jitter");
  try {
    await s.clearMobs();
    await sleep(500);
    // A chasing mob moves toward the player every tick, so its approach is a clean moving-mob sample. It is cleared on arrival.
    const archetype = process.env.COMBAT_POLISH_MOVER ?? "deer";
    await s.page.evaluate(() => { (window as any).__ASH_ATLAS_MOB_PROBE__.enabled = true; (window as any).__ASH_ATLAS_MOB_PROBE__.frames.length = 0; });
    const at = await attackCentre(s);
    const now = () => s.page.evaluate(() => performance.now());
    const setMode = (legacy: boolean) => s.page.evaluate((v) => { (window as any).__ASH_ATLAS_HIT_FEEDBACK__.legacyMobSmoothing = v; }, legacy);
    const distTo = (id: string): number => {
      const e = s.ents.get(id);
      if (!e) return Number.POSITIVE_INFINITY;
      return Math.hypot((e.lon - s.self.lon) * 111_320 * Math.cos((s.self.lat * Math.PI) / 180), (e.lat - s.self.lat) * 111_320);
    };
    type Run = { legacy: boolean; swing: boolean; id: string; from: number; to: number; holds: Array<[number, number]> };
    const runs: Run[] = [];
    const approach = async (legacy: boolean, swing: boolean): Promise<void> => {
      await setMode(legacy);
      await s.clearMobs();
      const mob = await s.spawn(archetype, 40, 0);
      const from = await now();
      const holds: Array<[number, number]> = [];
      const end = Date.now() + (swing ? 4500 : 3500);
      // One tap provokes the mob (it stays put until hit); a pure-motion run then stops swinging and watches it come.
      let provoked = false;
      while (Date.now() < end) {
        if (swing || !provoked) {
          provoked = true;
          await t.down(1, at.x, at.y); await sleep(70); await t.up(1); await sleep(100);
          const last = await s.page.evaluate(() => { const h = (window as any).__ASH_ATLAS_HIT_FEEDBACK__; return [h.lastHitstopStartMs, h.lastHitstopHoldMs] as [number, number]; });
          if (Number.isFinite(last[0]) && last[0] >= from && !holds.some((x) => x[0] === last[0])) holds.push(last);
        }
        await sleep(swing ? 600 : 50);
      }
      await sleep(250);
      const lastHold = await s.page.evaluate(() => { const h = (window as any).__ASH_ATLAS_HIT_FEEDBACK__; return [h.lastHitstopStartMs, h.lastHitstopHoldMs] as [number, number]; });
      if (swing && Number.isFinite(lastHold[0]) && lastHold[0] >= from && !holds.some((x) => x[0] === lastHold[0])) holds.push(lastHold);
      note("approach", JSON.stringify({ legacy, swing, hp: s.ents.get(s.self.id)?.hp ?? null, dist: Math.round(distTo(mob.id)), holds: holds.length, ms: Math.round((await now()) - from) }));
      runs.push({ legacy, swing, id: mob.id, from, to: await now(), holds });
      await s.clearMobs();
      await sleep(300);
    };
    for (let round_ = 0; round_ < 2; round_ += 1) {
      for (const legacy of [false, true]) await approach(legacy, false);
    }
    for (let round_ = 0; round_ < 3; round_ += 1) {
      for (const legacy of [false, true]) await approach(legacy, true);
    }
    await setMode(false);
    const frames = await s.page.evaluate(() => (window as any).__ASH_ATLAS_MOB_PROBE__.frames as ProbeFrame[]);
    writeFileSync(join(outDir, `mob-probe-${LABEL}.json`), JSON.stringify({ runs, frames }));
    const byMode: Record<string, Array<[number, number]>> = { new: [], legacy: [] };
    const jumps: Record<string, number[]> = { new: [], legacy: [] };
    const diag: Array<Record<string, unknown>> = [];
    for (const run of runs) {
      const { speeds, times } = stepSpeeds(frames, run.id, run.from, run.to);
      // Only the stretch where the mob is travelling (from its first to its last moving frame).
      const first = speeds.findIndex((v) => v > 2);
      let last = speeds.length - 1;
      while (last > 0 && !(speeds[last]! > 2)) last -= 1;
      const travelling = first >= 0 && last > first ? speeds.slice(first, last + 1) : [];
      if (!run.swing) { byMode[run.legacy ? "legacy" : "new"]!.push(...travelling.map((v, k) => [times[first + k]!, v] as [number, number])); continue; }
      const med = median(travelling.filter((v) => v > 0.5));
      diag.push({ legacy: run.legacy, holds: run.holds.length, travellingFrames: travelling.length, medianMoving: round(med, 2) });
      if (!(med > 0.5)) continue;
      for (const [start, hold] of run.holds) {
        const i = times.findIndex((time) => time >= start + hold + 8);
        if (i < 0) continue;
        jumps[run.legacy ? "legacy" : "new"]!.push(round(Math.max(speeds[i]!, speeds[i + 1] ?? 0) / med, 2));
      }
    }
    const result = { mob: archetype, approaches: runs.length, swingRuns: diag, new: jitterStats(byMode.new!), legacy: jitterStats(byMode.legacy!), postHitstopSpeedRatio: { new: jumps.new, legacy: jumps.legacy } };
    record("B3B4.jitter", result);
    if (GUARD && Number.isFinite(result.new.binStep) && Number.isFinite(result.legacy.binStep)) {
      expect(result.new.binStep, "the snapshot buffer changes speed less than the old glide").toBeLessThan(result.legacy.binStep);
      expect(result.new.stallInMotion, "and does not stall mid-motion").toBeLessThanOrEqual(result.legacy.stallInMotion);
      for (const ratio of jumps.new!) expect(ratio, "no forward jump after a hitstop").toBeLessThan(2.5);
    }
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Phase C: input windows (buffer + re-aim, too-early feedback, dash queue, mid-dash swing prediction)
// ---------------------------------------------------------------------------------------------------------------------

const stickCentre = async (s: Session): Promise<{ x: number; y: number }> => {
  const box = (await s.page.locator(".joystick-move-base").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const perfNow = (s: Session): Promise<number> => s.page.evaluate(() => performance.now());
/** Waits (page clock) until `target` performance.now ms. */
async function waitUntilPage(s: Session, target: number): Promise<void> {
  for (;;) {
    const left = target - (await perfNow(s));
    if (left <= 0) return;
    await sleep(Math.min(left, 15));
  }
}

test("C1/C2: a buffered tap is re-aimed when it sends, a too-early press is ignored with feedback, the ready cue fires", async () => {
  const { ctx, s, t } = await boot("polish-buffer");
  try {
    await s.clearMobs();
    await sleep(500);
    const east = await s.spawn("training_dummy", 25, 0);
    const west = await s.spawn("training_dummy", -45, 0);
    await sleep(900);
    void east; void west;
    const at = await attackCentre(s);
    const stick = await stickCentre(s);
    const cues = () => s.page.evaluate(() => ({ ...(window as any).__ASH_ATLAS_COMBAT_CUES__.counts }) as Record<string, number>);
    const tap = async (): Promise<void> => { await t.down(1, at.x, at.y); await sleep(50); await t.up(1); };

    // C2 first (no walking): tap 1; a press 200 ms in is far too early (500 ms left of 700) and is ignored; a press 500 ms in is buffered.
    const before = await polishState(s);
    const cuesBefore = await cues();
    const t0 = await perfNow(s);
    await tap();
    await waitUntilPage(s, t0 + 200);
    await tap();
    const early = await s.page.waitForSelector(".joystick-attack.is-too-early", { timeout: 500 }).then(() => true, () => false);
    await waitUntilPage(s, t0 + 500);
    await tap();
    await sleep(900);
    const afterC2 = await polishState(s);
    const swingsC2 = afterC2.swings.slice(before.swings.length);
    const gap = swingsC2.length >= 2 ? swingsC2[1]!.at - swingsC2[0]!.at : Number.NaN;
    const cuesAfter = await cues();
    record("C2.tooEarly", { swingsSent: swingsC2.length, tooEarlyClassSeen: early, bufferedSwingGapMs: round(gap), readyCues: (cuesAfter.ready ?? 0) - (cuesBefore.ready ?? 0) });
    if (GUARD) {
      expect(swingsC2.length, "the 200 ms press is ignored, the 500 ms press is buffered: two swings, not three").toBe(2);
      expect(early, "the too-early press blinks the attack ring").toBe(true);
      expect(gap, "the buffered press goes out at the end of the 700 ms recovery").toBeGreaterThan(680);
      expect(gap).toBeLessThan(780);
      expect((cuesAfter.ready ?? 0) - (cuesBefore.ready ?? 0), "a ready cue at the end of each recovery").toBeGreaterThanOrEqual(1);
    }
    await sleep(1200);

    // C1: swing 1 hits the east dummy (nearest). Walk west, tap while the east one is still nearest; by the time the buffered
    // press sends, the west dummy is nearest and the swing must be re-aimed at it.
    const b1 = await polishState(s);
    const u0 = await perfNow(s);
    await tap();
    await waitUntilPage(s, u0 + 440);
    await t.down(2, stick.x, stick.y);
    await t.move(2, stick.x - 70, stick.y);
    await waitUntilPage(s, u0 + 500);
    await tap();
    await sleep(900);
    await t.up(2);
    const a1 = await polishState(s);
    const swingsC1 = a1.swings.slice(b1.swings.length);
    record("C1.reaim", { swings: swingsC1.map((x) => ({ atMs: round(x.at - u0), dirX: round(x.dirX, 2), dirY: round(x.dirY, 2) })) });
    if (GUARD) {
      expect(swingsC1.length).toBeGreaterThanOrEqual(2);
      expect(swingsC1[0]!.dirX, "swing 1 aims at the east dummy").toBeGreaterThan(0.9);
      expect(swingsC1[1]!.dirX, "the buffered swing is re-aimed at the west dummy that became nearest while it waited").toBeLessThan(-0.5);
    }
  } finally {
    await ctx.close();
  }
});

test("C3: a dash pressed in the last 150 ms of the cooldown is queued and fires when it ends; an earlier press is dropped", async () => {
  const { ctx, s } = await boot("polish-dashqueue");
  try {
    await s.clearMobs();
    await sleep(800);
    const mark = s.mark();
    const before = await polishState(s);
    await s.page.keyboard.press("Space");
    await expect.poll(async () => (await polishState(s)).dashes.length - before.dashes.length, { timeout: 2000 }).toBe(1);
    const t1 = (await polishState(s)).dashes[before.dashes.length]!;
    await waitUntilPage(s, t1 + 2700); // 300 ms left: outside the 150 ms window
    await s.page.keyboard.press("Space");
    await waitUntilPage(s, t1 + 2860); // ~140 ms left: queued
    await s.page.keyboard.press("Space");
    await sleep(700);
    const after = await polishState(s);
    const dashes = after.dashes.slice(before.dashes.length).map((x) => round(x - t1));
    const accepted = s.since(mark, "DASH_ACCEPTED").length;
    const rejected = s.grep(mark, /DASH_REJECTED/).length;
    record("C3.dashQueue", { dashSendTimesMs: dashes, accepted, rejected });
    if (GUARD) {
      expect(dashes.length, "the 300 ms-early press is dropped, the 140 ms-early press is queued: two dashes").toBe(2);
      expect(dashes[1]!, "the queued dash fires as the 3 s cooldown ends").toBeGreaterThan(2990);
      expect(dashes[1]!).toBeLessThan(3150);
      expect(accepted, "the server accepts the queued dash").toBe(2);
      expect(rejected).toBe(0);
    }
  } finally {
    await ctx.close();
  }
});

test("C4: a swing pressed mid-dash is predicted from the landing point and lands after the dash, as the server resolves it", async () => {
  const { ctx, s, t } = await boot("polish-middash");
  try {
    await s.clearMobs();
    await sleep(500);
    const dummy = await s.spawn("training_dummy", 215, 0);
    await sleep(900);
    const at = await attackCentre(s);
    const stick = await stickCentre(s);
    // Walk east so the dash goes east, then dash and tap the attack button 40 ms into it.
    await t.down(2, stick.x, stick.y);
    await t.move(2, stick.x + 70, stick.y);
    await sleep(250);
    const before = await polishState(s);
    const mark = s.mark();
    const space = await perfNow(s);
    await s.page.keyboard.press("Space");
    await waitUntilPage(s, space + 40);
    await t.down(1, at.x, at.y);
    await sleep(50);
    await t.up(1);
    await sleep(900);
    await t.up(2);
    const after = await polishState(s);
    const dashAt = after.dashes[before.dashes.length]!;
    const swing = after.swings[before.swings.length];
    const hitstop = after.hitstops[before.hitstops.length];
    const results = s.since(mark, "SWING_RESULT").map((f) => JSON.parse(f.raw));
    const serverHits = results.flatMap((r) => (r.hits ?? []) as Array<{ entityId: string }>).filter((h) => h.entityId === dummy.id).length;
    record("C4.midDash", {
      swingSentAfterDashMs: swing ? round(swing.at - dashAt) : null,
      predictedHitEffectAfterDashMs: hitstop === undefined ? null : round(hitstop - dashAt),
      serverConfirmedHits: serverHits,
      rejected: results.map((r) => r.rejected ?? null)
    });
    if (GUARD) {
      expect(swing, "the swing was sent during the dash").toBeTruthy();
      expect(swing!.at - dashAt).toBeLessThan(120);
      expect(hitstop, "a hit was predicted from the landing point (the dummy was out of reach of the mid-dash position)").toBeDefined();
      expect(hitstop! - dashAt, "and it lands after the 150 ms dash plus the blade's contact frame, not on the press").toBeGreaterThan(220);
      expect(serverHits, "the server hit it from the landing point too").toBeGreaterThanOrEqual(1);
    }
  } finally {
    await ctx.close();
  }
});
