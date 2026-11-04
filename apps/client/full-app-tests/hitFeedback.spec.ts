/**
 * Hit feedback (docs/plans/hit-feedback.md), end to end in headless Chromium at phone size (390x844) against a feature
 * runtime with ACTION_COMBAT_ENABLED, MOB_TACTICS_ENABLED, MOB_ARCHETYPES_ENABLED and DEV_TOOLS_ENABLED all true.
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41888 pnpm exec playwright test --config playwright-full-app.config.ts hitFeedback
 *
 * - action combat actually reached the backend (WELCOME) and the attack button is up
 * - a landed swing starts a hitstop on the press, and neither the SWING nor a dash pressed during the hold is delayed
 * - the combo finisher holds longer and shakes the screen; Screen shake "off" removes the shake but keeps the hitstop
 * - (HIT_FEEDBACK_PERF=1, runtime with DEV_PLAYERS_INVULNERABLE=true) per-frame cost on a 6-wolf fight, effects on vs off
 *
 * Every test writes its numbers to <ASH_ATLAS_E2E_OUT>/hit-feedback.json; HIT_FEEDBACK_BURSTS=1 also saves CDP screencast
 * bursts (every painted frame around each effect) under <ASH_ATLAS_E2E_OUT>/hit-feedback-bursts/.
 */
import { expect, test, chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, note, outDir, baseUrl, type Session } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend with action combat on");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const REPORT = join(outDir, "hit-feedback.json");
const report: Record<string, unknown> = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, "utf8")) : {};
const record = (key: string, value: unknown): void => {
  report[key] = value;
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  note(key, JSON.stringify(value));
};
const BURSTS = process.env.HIT_FEEDBACK_BURSTS === "1";
const BURST_DIR = join(outDir, "hit-feedback-bursts");
if (BURSTS) mkdirSync(BURST_DIR, { recursive: true });

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : [] }); });
test.afterAll(async () => { await browser?.close(); });

const PORTRAIT = { width: 390, height: 844 };

type Stats = { disabled: boolean; hitstops: number; lastHitstopStartMs: number; lastHitstopHoldMs: number; incomingHits: number; shakeStarts: number; shakeFrames: number; maxShakePx: number; heldFrames: number; frameWorkMs: number; frames: number; renderMs: number; renders: number };

async function boot(name: string, storage: Record<string, string> = {}, viewport: { width: number; height: number } | null = PORTRAIT): Promise<{ ctx: BrowserContext; s: Session; cdp: CDPSession }> {
  const { ctx, s } = await launch(browser, name, viewport
    ? { viewport, joystick: true, storage: { "ashAtlas.floatingSticks.v1": "0", ...storage } }
    : { storage });
  const gotIt = s.page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await installProbe(s.page);
  return { ctx, s, cdp: await ctx.newCDPSession(s.page) };
}

/** Stamps every pointerdown and websocket send (performance.now), and samples the hold and shake every frame. */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__presses = [] as Array<[number, string]>;
    w.__sent = [] as Array<[number, string]>;
    w.__seen = { maxHoldMs: 0, holds: [] as number[], transforms: 0, maxTransformPx: 0, heldAtPress: [] as Array<[string, boolean]> };
    document.addEventListener("pointerdown", (e) => {
      const stats = w.__ASH_ATLAS_HIT_FEEDBACK__;
      const now = performance.now();
      const cls = String((e.target as Element)?.className ?? "");
      w.__presses.push([now, cls]);
      w.__seen.heldAtPress.push([cls, stats ? now - stats.lastHitstopStartMs < stats.lastHitstopHoldMs : false]);
    }, true);
    // The dash has no on-screen button any more: Space is the dash press (stamped as a "dash" press).
    document.addEventListener("keydown", (e) => {
      if (e.code !== "Space" || e.repeat) return;
      const stats = w.__ASH_ATLAS_HIT_FEEDBACK__;
      const now = performance.now();
      w.__presses.push([now, "dash-key"]);
      w.__seen.heldAtPress.push(["dash-key", stats ? now - stats.lastHitstopStartMs < stats.lastHitstopHoldMs : false]);
    }, true);
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: any) {
      if (typeof data === "string") w.__sent.push([performance.now(), /"type":"(\w+)"/.exec(data)?.[1] ?? "?"]);
      return send.call(this, data);
    };
    let lastStart = Number.NaN;
    const tick = (): void => {
      const stats = w.__ASH_ATLAS_HIT_FEEDBACK__;
      if (stats && stats.lastHitstopStartMs !== lastStart && Number.isFinite(stats.lastHitstopStartMs)) {
        lastStart = stats.lastHitstopStartMs;
        w.__seen.holds.push(stats.lastHitstopHoldMs);
        w.__seen.maxHoldMs = Math.max(w.__seen.maxHoldMs, stats.lastHitstopHoldMs);
      }
      const root = document.querySelector<HTMLElement>(".map-root");
      const m = root?.style.transform ? /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(root.style.transform) : null;
      if (m) { w.__seen.transforms += 1; w.__seen.maxTransformPx = Math.max(w.__seen.maxTransformPx, Math.hypot(Number(m[1]), Number(m[2]))); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const stats = (page: Page): Promise<Stats> => page.evaluate(() => ({ ...(window as any).__ASH_ATLAS_HIT_FEEDBACK__ }));
const seen = (page: Page): Promise<{ maxHoldMs: number; holds: number[]; transforms: number; maxTransformPx: number; heldAtPress: Array<[string, boolean]> }> => page.evaluate(() => (window as any).__seen);

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tap(cdp: CDPSession, at: { x: number; y: number }, id = 1): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y, id }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Records every painted frame (CDP screencast) while `action` runs and for `keepMs` after; saves them by offset. */
async function burst(cdp: CDPSession, label: string, keepMs: number, action: () => Promise<void>): Promise<void> {
  if (!BURSTS) { await action(); await new Promise((r) => setTimeout(r, keepMs)); return; }
  const frames: Array<{ wallMs: number; data: string }> = [];
  const onFrame = (ev: any): void => {
    frames.push({ wallMs: ev.metadata.timestamp * 1000, data: ev.data });
    void cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => undefined);
  };
  cdp.on("Page.screencastFrame", onFrame);
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 2000, maxHeight: 2000 });
  await new Promise((r) => setTimeout(r, 150));
  const anchor = Date.now();
  await action();
  await new Promise((r) => setTimeout(r, keepMs));
  await cdp.send("Page.stopScreencast");
  cdp.off("Page.screencastFrame", onFrame);
  for (const frame of frames) {
    const offset = Math.round(frame.wallMs - anchor);
    if (offset < -60) continue;
    writeFileSync(join(BURST_DIR, `${label}_${offset >= 0 ? "+" : ""}${String(offset).padStart(4, "0")}ms.png`), Buffer.from(frame.data, "base64"));
  }
  note(`burst-${label}`, `${frames.length} frames`);
}

function welcome(s: Session): any {
  const frame = s.frames.find((f) => f.dir === "in" && f.type === "WELCOME");
  return frame ? JSON.parse(frame.raw) : null;
}

test("1. action combat reached the backend and the attack button is up", async () => {
  const { ctx, s } = await boot("hf-welcome");
  try {
    const w = welcome(s);
    record("welcome", { actionCombat: w?.actionCombat ?? null });
    expect(w?.actionCombat, "WELCOME must say action combat is on (ACTION_COMBAT_ENABLED reached the backend)").toBe(true);
    await expect(s.page.getByRole("button", { name: "Attack" })).toBeVisible();
    await s.shot("hf-welcome");
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("2. a landed swing hitstops on the press without delaying the swing or a dash pressed during the hold", async () => {
  const { ctx, s, cdp } = await boot("hf-hitstop");
  try {
    await s.spawn("training_dummy", 0, 80);
    await s.page.waitForTimeout(1200);
    const attack = await centre(s.page, ".joystick-attack-face");
    const before = await stats(s.page);
    await burst(cdp, "phone-swing", 700, async () => { await tap(cdp, attack); });
    const after = await stats(s.page);
    const timing = await s.page.evaluate(() => {
      const w = window as any;
      const press = w.__presses.filter(([, c]: [number, string]) => c.includes("attack")).at(-1)?.[0] ?? Number.NaN;
      const swing = w.__sent.find(([t, type]: [number, string]) => type === "SWING" && t >= press - 1)?.[0] ?? Number.NaN;
      return { press, swing, hitstopStart: w.__ASH_ATLAS_HIT_FEEDBACK__.lastHitstopStartMs };
    });
    const swingDelayMs = timing.swing - timing.press;
    const hitstopFromPressMs = timing.hitstopStart - timing.press;
    record("hitstop-swing", { hitstops: after.hitstops - before.hitstops, holdMs: after.lastHitstopHoldMs, swingSendAfterPressMs: Math.round(swingDelayMs * 10) / 10, hitstopStartAfterPressMs: Math.round(hitstopFromPressMs * 10) / 10, heldFrames: after.heldFrames - before.heldFrames });
    expect(after.hitstops - before.hitstops, "the predicted hit on the dummy starts a hitstop").toBeGreaterThanOrEqual(1);
    expect(after.lastHitstopHoldMs).toBeGreaterThanOrEqual(45);
    expect(after.lastHitstopHoldMs).toBeLessThanOrEqual(90);
    // The SWING leaves in the same handler that starts the hitstop: the hold never sits between press and send.
    // Combat polish: the hit effects (hitstop included) land on the blade's contact frame (~105 ms), not on the press.
    expect(timing.hitstopStart - timing.swing, "the hitstop starts at the contact frame after the SWING, never before it").toBeGreaterThan(90);
    expect(timing.hitstopStart - timing.swing).toBeLessThan(150);
    expect(swingDelayMs, "press to SWING stays at the controls' own tap latency").toBeLessThan(60);
    expect(after.heldFrames - before.heldFrames, "the hold was rendered for at least a frame").toBeGreaterThanOrEqual(1);

    // A dash pressed while the hold is running goes out as fast as a dash with no hitstop.
    const dashDelay = (): Promise<{ delayMs: number; heldAtPress: boolean | null }> => s.page.evaluate(() => {
      const w = window as any;
      const press = w.__presses.filter(([, c]: [number, string]) => c.includes("dash")).at(-1)?.[0] ?? Number.NaN;
      const sent = w.__sent.find(([t, type]: [number, string]) => type === "DASH" && t >= press - 1)?.[0] ?? Number.NaN;
      const held = w.__seen.heldAtPress.filter(([c]: [string, boolean]) => c.includes("dash")).at(-1)?.[1] ?? null;
      return { delayMs: sent - press, heldAtPress: held };
    });
    await s.page.waitForTimeout(3200);
    let mark = s.mark();
    await s.page.keyboard.press("Space");
    await expect.poll(() => s.since(mark, "DASH", "out").length, { timeout: 3000 }).toBeGreaterThan(0);
    const baseline = await dashDelay();
    await s.page.waitForTimeout(3200);
    mark = s.mark();
    const startBefore = (await stats(s.page)).lastHitstopStartMs;
    await tap(cdp, attack);
    // The tap swings a few frames after the press; dash as soon as that swing's hold has started.
    await s.page.waitForFunction((before) => (window as any).__ASH_ATLAS_HIT_FEEDBACK__.lastHitstopStartMs !== before, startBefore, { polling: "raf", timeout: 3000 });
    await s.page.keyboard.press("Space");
    await expect.poll(() => s.since(mark, "DASH", "out").length, { timeout: 3000 }).toBeGreaterThan(0);
    const dashTiming = await dashDelay();
    record("hitstop-dash", { baselineDashSendAfterPressMs: Math.round(baseline.delayMs * 10) / 10, duringHoldDashSendAfterPressMs: Math.round(dashTiming.delayMs * 10) / 10, pressedDuringHold: dashTiming.heldAtPress });
    expect(dashTiming.heldAtPress, "the dash was pressed during the hitstop hold").toBe(true);
    expect(dashTiming.delayMs, "a dash during the hold is not slower than one without").toBeLessThan(baseline.delayMs + 10);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

async function comboOnDummy(s: Session, cdp: CDPSession, label: string): Promise<void> {
  await s.spawn("training_dummy", 0, 80);
  await s.page.waitForTimeout(1200);
  const attack = await centre(s.page, ".joystick-attack-face");
  // Three presses: the later ones buffer through the recovery, so the third swing is the combo finisher.
  await tap(cdp, attack);
  await s.page.waitForTimeout(750);
  await tap(cdp, attack);
  await s.page.waitForTimeout(750);
  await burst(cdp, label, 900, async () => { await tap(cdp, attack); });
  await s.page.waitForTimeout(400);
}

test("3. the finisher holds longer and shakes; Screen shake off removes the shake but keeps the hitstop", async () => {
  for (const setting of ["full", "off"] as const) {
    const { ctx, s, cdp } = await boot(`hf-shake-${setting}`, { "ashAtlas.screenShake.v1": setting });
    try {
      const mark = s.mark();
      await comboOnDummy(s, cdp, `phone-finisher-shake-${setting}`);
      const st = await stats(s.page);
      const sn = await seen(s.page);
      const combos = s.since(mark, "SWING_RESULT").map((f) => JSON.parse(f.raw).comboIndex);
      record(`shake-${setting}`, { combos, holds: sn.holds, shakeStarts: st.shakeStarts, shakeFrames: st.shakeFrames, maxShakePx: st.maxShakePx, transformFrames: sn.transforms, maxTransformPx: sn.maxTransformPx });
      expect(combos.slice(0, 3)).toEqual([0, 1, 2]);
      expect(sn.maxHoldMs, "the finisher's hitstop is the longest").toBe(90);
      expect(Math.min(...sn.holds)).toBeLessThan(90);
      if (setting === "full") {
        expect(st.shakeStarts, "the finisher shakes the screen").toBeGreaterThanOrEqual(1);
        expect(sn.transforms, "the map host was offset while shaking").toBeGreaterThan(0);
        expect(sn.maxTransformPx).toBeLessThanOrEqual(6);
      } else {
        expect(st.shakeStarts, "Screen shake off: no shake").toBe(0);
        expect(st.shakeFrames).toBe(0);
        expect(sn.transforms).toBe(0);
      }
    } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
  }
});

test("4. incoming hit, DODGE and the dash i-frame shimmer (screenshots)", async () => {
  test.skip(!BURSTS, "screenshot bursts only (HIT_FEEDBACK_BURSTS=1)");
  const { ctx, s, cdp } = await boot("hf-incoming");
  try {
    // Dodge: dash as soon as the wolf's wind-up telegraph shows (the strike lands 450 ms later).
    let mark = s.mark();
    await s.spawn("wolf", 30, 0);
    await s.until(() => s.grep(mark, /melee_windup/).length > 0, 15_000, "a melee_windup telegraph");
    await burst(cdp, "phone-dodge-iframes", 1100, async () => { await s.page.keyboard.press("Space"); });
    const dodges = s.grep(mark, /"DODGE"/).length;
    // Take the next hit.
    await s.page.waitForTimeout(1500);
    mark = s.mark();
    await s.spawn("wolf", 12, 0);
    const hitsBefore = (await stats(s.page)).incomingHits;
    const hitAt = async (): Promise<void> => {
      await expect.poll(async () => (await stats(s.page)).incomingHits, { timeout: 40_000, intervals: [20] }).toBeGreaterThan(hitsBefore);
    };
    await burst(cdp, "phone-incoming-hit", 700, hitAt);
    const st = await stats(s.page);
    record("incoming", { dodgeEvents: dodges, incomingHits: st.incomingHits, shakeStarts: st.shakeStarts });
    expect(st.incomingHits).toBeGreaterThanOrEqual(1);
    await s.clearMobs();
  } finally { s.save(); await ctx.close(); }
});

test("5. desktop: the same swing and finisher at the desktop default zoom (screenshots)", async () => {
  test.skip(!BURSTS, "screenshot bursts only (HIT_FEEDBACK_BURSTS=1)");
  const { ctx, s, cdp } = await boot("hf-desktop", {}, null);
  try {
    await s.spawn("training_dummy", 0, 80);
    await s.page.waitForTimeout(1200);
    const dummy = [...s.ents.values()].find((e) => e.archetype === "training_dummy")!;
    const p = await s.screenOf(dummy.id);
    const press = async (): Promise<void> => {
      await s.page.mouse.move(p.x, p.y - 12);
      await s.page.mouse.down({ button: "right" });
      await s.page.waitForTimeout(60);
      await s.page.mouse.up({ button: "right" });
    };
    await burst(cdp, "desktop-swing", 600, press);
    await s.page.waitForTimeout(600);
    await press();
    await s.page.waitForTimeout(800);
    await burst(cdp, "desktop-finisher", 800, press);
  } finally { s.save(); await ctx.close(); }
});

test("6. perf: 6-wolf fight, hit feedback on vs off (HIT_FEEDBACK_PERF=1)", async () => {
  test.skip(process.env.HIT_FEEDBACK_PERF !== "1", "needs HIT_FEEDBACK_PERF=1 and a runtime with DEV_PLAYERS_INVULNERABLE=true");
  test.setTimeout(300_000);
  const { ctx, s, cdp } = await boot("hf-perf");
  try {
    const attack = await centre(s.page, ".joystick-attack-face");
    const wolves = (): number => [...s.ents.values()].filter((e) => e.archetype === "wolf" && (e.hp ?? 1) > 0).length;
    const topUp = async (): Promise<void> => {
      const offsets = [[25, 10], [-25, 10], [0, 30], [20, -20], [-20, -20], [0, -30]] as const;
      for (let i = wolves(); i < 6; i++) await s.spawn("wolf", offsets[i % 6]![0], offsets[i % 6]![1]);
    };
    const windows: Array<{ disabled: boolean; frames: number; dynamicMsPerFrame: number; renderMsPerFrame: number; rafMeanMs: number; rafP95Ms: number; hitstops: number; incoming: number }> = [];
    for (let round = 0; round < 6; round++) {
      const disabled = round % 2 === 0;
      await topUp();
      await s.page.evaluate((d) => { (window as any).__ASH_ATLAS_HIT_FEEDBACK__.disabled = d; }, disabled);
      await s.page.waitForTimeout(500);
      const a = await stats(s.page);
      await s.page.evaluate(() => {
        const w = window as any; w.__raf = [] as number[]; let last = performance.now(); w.__rafOn = true;
        const tick = (): void => { const now = performance.now(); w.__raf.push(now - last); last = now; if (w.__rafOn) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      const end = Date.now() + 5000;
      while (Date.now() < end) { await tap(cdp, attack); await s.page.waitForTimeout(350); }
      const raf: number[] = await s.page.evaluate(() => { const w = window as any; w.__rafOn = false; return w.__raf.slice(1); });
      const b = await stats(s.page);
      const frames = b.frames - a.frames;
      raf.sort((x, y) => x - y);
      windows.push({
        disabled,
        frames,
        dynamicMsPerFrame: Math.round(((b.frameWorkMs - a.frameWorkMs) / Math.max(1, frames)) * 1000) / 1000,
        renderMsPerFrame: Math.round(((b.renderMs - a.renderMs) / Math.max(1, b.renders - a.renders)) * 1000) / 1000,
        rafMeanMs: Math.round((raf.reduce((x, y) => x + y, 0) / Math.max(1, raf.length)) * 100) / 100,
        rafP95Ms: Math.round((raf[Math.floor(raf.length * 0.95)] ?? 0) * 100) / 100,
        hitstops: b.hitstops - a.hitstops,
        incoming: b.incomingHits - a.incomingHits
      });
      note(`perf-window-${round}`, JSON.stringify(windows.at(-1)));
    }
    await s.page.evaluate(() => { (window as any).__ASH_ATLAS_HIT_FEEDBACK__.disabled = false; });
    const mean = (on: boolean, key: "dynamicMsPerFrame" | "renderMsPerFrame"): number => {
      const list = windows.filter((w) => w.disabled !== on).map((w) => w[key]);
      return list.reduce((x, y) => x + y, 0) / list.length;
    };
    const extra = mean(true, "dynamicMsPerFrame") + mean(true, "renderMsPerFrame") - mean(false, "dynamicMsPerFrame") - mean(false, "renderMsPerFrame");
    record("perf-6-wolves", { windows, extraMsPerFrame: Math.round(extra * 1000) / 1000 });
    expect(windows.filter((w) => !w.disabled).reduce((n, w) => n + w.hitstops, 0), "effects actually ran in the on windows").toBeGreaterThan(0);
    expect(extra, "hit feedback adds under ~1 ms per frame").toBeLessThan(1);
    await s.clearMobs();
  } finally { s.save(); await ctx.close(); }
});
