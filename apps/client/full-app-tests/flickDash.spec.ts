/**
 * Flick to dash end-to-end (real headless Chromium, real websocket frames, CDP touch with real timing).
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> pnpm exec playwright test --config playwright-full-app.config.ts flickDash
 *
 * Needs a feature runtime with ACTION_COMBAT_ENABLED=true. Covers: flick ON dashes in the flick direction (floating and fixed
 * stick), a drag-and-hold sends MOVE_TO and no DASH, a flick on cooldown adds no second DASH, and flick OFF never dashes.
 */
import { expect, test, chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const baseUrl = process.env.ASH_ATLAS_TEST_BASE_URL;
const SHOTS = process.env.ASH_ATLAS_E2E_SHOTS ?? "./test-results/e2e-shots";
mkdirSync(SHOTS, { recursive: true });
test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at the action-combat feature runtime frontend");
test.describe.configure({ mode: "serial", timeout: 180_000 });

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : [] }); });
test.afterAll(async () => { await browser?.close(); });

type Pos = { lat: number; lon: number };
const note = (type: string, text: string): void => { test.info().annotations.push({ type, description: text }); console.log(`[${type}] ${text}`); };

async function boot(opts: { mobile: boolean; width?: number; height?: number; floating?: boolean; guides?: boolean; flick?: boolean }): Promise<{ ctx: BrowserContext; page: Page }> {
  const size = { width: opts.width ?? (opts.mobile ? 390 : 1280), height: opts.height ?? (opts.mobile ? 844 : 800) };
  const ctx = await browser.newContext(opts.mobile
    ? { viewport: size, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
    : { viewport: size });
  const page = await ctx.newPage();
  await page.addInitScript(({ mobile, floating, guides, flick }) => {
    (window as any).__sent = [] as string[];
    (window as any).__keys = [] as { key: string; prevented: boolean }[];
    const W = window.WebSocket; (window as any).__e2eSockets = [];
    const Wrapped: any = function (this: unknown, ...a: any[]) { const s = new (W as any)(...a); (window as any).__e2eSockets.push(s); return s; };
    Wrapped.prototype = W.prototype; Object.assign(Wrapped, W); (window as any).WebSocket = Wrapped;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: any) { try { (window as any).__sent.push(String(data)); } catch { /* ignore */ } return send.call(this, data); };
    // Records whether the app consumed a number key (hotbar handlers call preventDefault when they act on it).
    window.addEventListener("keydown", (e) => { if (/^[0-9]$/.test(e.key)) setTimeout(() => (window as any).__keys.push({ key: e.key, prevented: e.defaultPrevented }), 0); });
    if (mobile) { try { localStorage.setItem("ashAtlas.joystickMovement.v1", "1"); localStorage.setItem("ashAtlas.floatingSticks.v1", floating ? "1" : "0"); localStorage.setItem("ashAtlas.floatingStickGuides.v1", guides ? "1" : "0"); localStorage.setItem("ashAtlas.flickDash.v1", flick ? "1" : "0"); } catch { /* ignore */ } }
  }, { mobile: opts.mobile, floating: opts.floating !== false, guides: opts.guides !== false, flick: opts.flick === true });
  await page.goto(baseUrl!, { waitUntil: "domcontentloaded" });
  const dev = page.getByRole("button", { name: "Default Dev" });
  await dev.waitFor({ state: "visible", timeout: 20_000 });
  for (let attempt = 0; attempt < 6; attempt++) {
    await dev.click();
    const curtain = page.locator("main.initial-curtain");
    const failed = page.getByText("Authentication service unavailable");
    await curtain.or(failed).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    if (!(await failed.isVisible().catch(() => false))) break;
    await page.waitForTimeout(10_000);
  }
  await page.locator("main.initial-curtain").waitFor({ state: "detached", timeout: 60_000 });
  await page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(3000);
  const respawn = page.getByRole("button", { name: "Respawn" });
  if (await respawn.isVisible()) { await respawn.click(); await page.waitForTimeout(1500); }
  const gotIt = page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await exposeMap(page);
  await reanchor(page);
  return { ctx, page };
}

async function exposeMap(page: Page): Promise<void> {
  let ok = false;
  for (let attempt = 0; attempt < 10 && !ok; attempt++) {
    if (attempt) await page.waitForTimeout(1000);
    ok = await page.evaluate(() => {
      const isMap = (v: any): boolean => v && typeof v === "object" && typeof v.project === "function" && typeof v.getBearing === "function";
      const seen = new Set<unknown>(); const found = new Set<any>();
      const search = (v: any, d: number): void => {
        if (!v || typeof v !== "object" || seen.has(v) || d > 5) return;
        seen.add(v); if (isMap(v)) { found.add(v); return; }
        for (const k of Object.keys(v)) { let c; try { c = v[k]; } catch { continue; } search(c, d + 1); }
      };
      for (const e of Array.from(document.querySelectorAll("*"))) {
        const fk = Object.keys(e).find((k) => k.startsWith("__reactFiber")); if (!fk) continue;
        let f = (e as any)[fk]; let depth = 0;
        while (f && depth++ < 400) {
          let s = f.memoizedState; let n = 0;
          while (s && typeof s === "object" && n++ < 4000) { search(s.memoizedState, 0); s = s.next; }
          f = f.return;
        }
      }
      const live = [...found].filter((m) => { try { const c = m.getCanvas(); return c.isConnected && c.getBoundingClientRect().width > 0; } catch { return false; } });
      if (live[0]) { (window as any).__e2eMap = live[0]; return true; }
      return false;
    });
  }
  expect(ok, "could not find the map object via React fibers").toBe(true);
}

const sentCount = (page: Page, type: string): Promise<number> =>
  page.evaluate((t) => (window as any).__sent.filter((s: string) => s.includes(`"type":"${t}"`)).length, type);
const sentFrom = (page: Page, type: string, from: number): Promise<any[]> =>
  page.evaluate(({ t, n }) => ((window as any).__sent as string[]).filter((s) => s.includes(`"type":"${t}"`)).slice(n).map((s) => JSON.parse(s)), { t: type, n: from });

/** The local player's predicted position, read through the JoystickMovement props (the app keeps no global handle). */
const playerPos = (page: Page): Promise<Pos> =>
  page.evaluate(() => {
    for (const e of Array.from(document.querySelectorAll("*"))) {
      const fk = Object.keys(e).find((k) => k.startsWith("__reactFiber")); if (!fk) continue;
      for (let f = (e as any)[fk], d = 0; f && d < 60; f = f.return, d++) {
        const fn = f.memoizedProps?.getWorldState; if (typeof fn === "function") return fn().position as Pos;
      }
    }
    throw new Error("JoystickMovement not mounted");
  });

/** Re-anchors the dev character on its own position so every walking direction is open. */
async function reanchor(page: Page): Promise<Pos> {
  const here = await playerPos(page);
  await page.evaluate(({ lat, lon }) => {
    const sockets = ((window as any).__e2eSockets as WebSocket[]).filter((s) => s.readyState === 1);
    sockets[sockets.length - 1]!.send(JSON.stringify({ type: "DEV_TELEPORT", requestId: crypto.randomUUID(), lat, lon }));
  }, here);
  await page.waitForTimeout(4000);
  return playerPos(page);
}

/** Clears mobs (a wolf would kill the shared dev player) and readies the melee weapon through the dev socket. */
async function clearMobs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sockets = ((window as any).__e2eSockets as WebSocket[]).filter((s) => s.readyState === 1);
    sockets[sockets.length - 1]!.send(JSON.stringify({ type: "DEV_CLEAR_MOBS", requestId: crypto.randomUUID() }));
  });
  await page.waitForTimeout(1000);
}

const mapCentre = (page: Page): Promise<{ lat: number; lon: number; zoom: number; x: number; y: number }> =>
  page.evaluate(() => {
    const m = (window as any).__e2eMap; const c = m.getCenter(); const p = m.project([c.lng, c.lat]);
    return { lat: c.lat as number, lon: c.lng as number, zoom: m.getZoom() as number, x: p.x as number, y: p.y as number };
  });
/** Screen distance (px) between two geographic points under the map's current transform. */
const pxBetween = (page: Page, a: Pos, b: Pos): Promise<number> =>
  page.evaluate(({ a, b }) => {
    const m = (window as any).__e2eMap; const pa = m.project([a.lon, a.lat]); const pb = m.project([b.lon, b.lat]);
    return Math.hypot(pa.x - pb.x, pa.y - pb.y) as number;
  }, { a, b });
const metresBetween = (a: Pos, b: Pos): number => Math.hypot((a.lat - b.lat) * 111_000, (a.lon - b.lon) * 97_000);

/** Counts camera moves with no user input behind them (jumpTo / easeTo from app code) from now on. */
async function watchProgrammaticMoves(page: Page): Promise<void> {
  await page.evaluate(() => {
    const m = (window as any).__e2eMap;
    (window as any).__progMoves = 0;
    m.on("movestart", (e: any) => { if (!e.originalEvent) (window as any).__progMoves++; });
  });
}
const progMoves = (page: Page): Promise<number> => page.evaluate(() => (window as any).__progMoves as number);

/** requestAnimationFrame pacing recorder. */
async function startFrameRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const times: number[] = []; (window as any).__frames = times; (window as any).__frameOn = true;
    const tick = (t: number): void => { if (!(window as any).__frameOn) return; times.push(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}
async function stopFrameRecorder(page: Page): Promise<{ fps: number; p50: number; p95: number; max: number; slow: number; frames: number }> {
  const times: number[] = await page.evaluate(() => { (window as any).__frameOn = false; return (window as any).__frames as number[]; });
  const deltas = times.slice(1).map((t, i) => t - times[i]!).sort((a, b) => a - b);
  const q = (p: number): number => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))] ?? 0;
  const span = (times.at(-1) ?? 0) - (times[0] ?? 0);
  return { fps: span > 0 ? Math.round(((times.length - 1) / span) * 10_000) / 10 : 0, p50: Math.round(q(0.5) * 10) / 10, p95: Math.round(q(0.95) * 10) / 10, max: Math.round((deltas.at(-1) ?? 0) * 10) / 10, slow: deltas.filter((d) => d > 25).length, frames: times.length };
}

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
  /** Lifts one finger; the others stay down. */
  async up(id: number): Promise<void> { const f = this.fingers.get(id); if (!f) return; await this.send("touchEnd", f); this.fingers.delete(id); }
}

const centreOf = async (page: Page, sel: string): Promise<{ x: number; y: number }> => {
  const b = (await page.locator(sel).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
void centreOf;
const rectOf = (page: Page, sel: string): Promise<{ l: number; t: number; r: number; b: number; w: number; h: number }> =>
  page.evaluate((s) => { const b = document.querySelector(s)!.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; }, sel);
const centreOfRect = (r: { l: number; t: number; w: number; h: number }): { x: number; y: number } => ({ x: r.l + r.w / 2, y: r.t + r.h / 2 });
const topElement = (page: Page, x: number, y: number): Promise<string> =>
  page.evaluate(({ x, y }) => {
    const names: string[] = [];
    for (let e = document.elementFromPoint(x, y); e && names.length < 6; e = e.parentElement) names.push(`${e.tagName.toLowerCase()}.${(typeof e.className === "string" ? e.className : "").split(" ").join(".")}`);
    return names.join(" > ") || "none";
  }, { x, y });

/** World-space unit vector a screen direction maps to (same rule as walking: screen up is the map bearing). */
const worldDir = async (page: Page, screenDx: number, screenDy: number): Promise<{ dirX: number; dirY: number }> => {
  const bearing = await page.evaluate(() => (window as any).__e2eMap.getBearing() as number);
  const compass = ((bearing + (Math.atan2(screenDx, -screenDy) * 180) / Math.PI) % 360 + 360) % 360;
  const rad = (compass * Math.PI) / 180;
  return { dirX: Math.sin(rad), dirY: Math.cos(rad) };
};

/** Where a stick touch lands: the middle of the move region (floating) or the fixed base. */
async function stickPoint(page: Page, floating: boolean): Promise<{ x: number; y: number }> {
  return centreOfRect(await rectOf(page, floating ? ".joystick-move" : ".joystick-move-base"));
}

/** A quick flick at about the original speed (rim by ~75 ms, lift by ~100 ms): down, out to the rim, up. Returns the real elapsed ms from touch-down to touch-up. */
async function flick(t: Touch, page: Page, p: { x: number; y: number }, dx: number, dy: number): Promise<number> {
  const t0 = Date.now();
  // Scheduled on node timers without waiting for each CDP ack (the round trips alone can eat 50 ms each).
  const at = (ms: number, fn: () => Promise<void>): Promise<void> => new Promise((resolve, reject) => { setTimeout(() => { fn().then(resolve, reject); }, ms); });
  await Promise.all([
    at(0, () => t.down(1, p.x, p.y)),
    at(40, () => t.move(1, p.x + dx * 0.5, p.y + dy * 0.5)),
    at(75, () => t.move(1, p.x + dx, p.y + dy)),
    at(100, () => t.up(1))
  ]);
  const elapsed = Date.now() - t0;
  await page.waitForTimeout(250);
  return elapsed;
}

for (const floating of [true, false]) {
  const mode = floating ? "floating" : "fixed";

  test(`flick ON (${mode} stick): a quick flick dashes in the flick direction; drag-and-hold only walks`, async () => {
    const { ctx, page } = await boot({ mobile: true, floating, flick: true });
    try {
      await clearMobs(page);
      const t = new Touch(await ctx.newCDPSession(page));
      const p = await stickPoint(page, floating);
      // Flick up.
      let dashMark = await sentCount(page, "DASH");
      let moveMark = await sentCount(page, "MOVE_TO");
      const upMs = await flick(t, page, p, 0, -60);
      let dashes = await sentFrom(page, "DASH", dashMark);
      note("flick-up", `${mode}: ${upMs} ms, DASH ${dashes.length}, MOVE_TO ${(await sentCount(page, "MOVE_TO")) - moveMark}, ${JSON.stringify(dashes[0]?.payload ?? dashes[0])}`);
      expect(dashes.length).toBe(1);
      const dash = dashes[0].payload ?? dashes[0];
      const want = await worldDir(page, 0, -1);
      expect(dash.dirX).toBeCloseTo(want.dirX, 1);
      expect(dash.dirY).toBeCloseTo(want.dirY, 1);
      // Wait out the 3 s cooldown, then flick right.
      await page.waitForTimeout(3300);
      dashMark = await sentCount(page, "DASH");
      await flick(t, page, p, 60, 0);
      dashes = await sentFrom(page, "DASH", dashMark);
      expect(dashes.length).toBe(1);
      const right = dashes[0].payload ?? dashes[0];
      const wantRight = await worldDir(page, 1, 0);
      note("flick-right", `${mode}: got ${right.dirX.toFixed(2)},${right.dirY.toFixed(2)} want ${wantRight.dirX.toFixed(2)},${wantRight.dirY.toFixed(2)}`);
      expect(right.dirX).toBeCloseTo(wantRight.dirX, 1);
      expect(right.dirY).toBeCloseTo(wantRight.dirY, 1);
      // Cooldown: an immediate second flick adds no DASH.
      await page.waitForTimeout(3300);
      dashMark = await sentCount(page, "DASH");
      await flick(t, page, p, 0, -60);
      await flick(t, page, p, 0, -60);
      expect(await sentCount(page, "DASH") - dashMark, "second flick inside the cooldown does not dash").toBe(1);
      await page.waitForTimeout(3300);
      // Drag and hold: MOVE_TO, never a DASH.
      dashMark = await sentCount(page, "DASH");
      moveMark = await sentCount(page, "MOVE_TO");
      await t.down(1, p.x, p.y);
      for (let i = 1; i <= 8; i++) { await t.move(1, p.x, p.y - i * 8); await page.waitForTimeout(90); }
      await page.waitForTimeout(600);
      await t.up(1);
      await page.waitForTimeout(400);
      note("hold", `${mode}: MOVE_TO ${(await sentCount(page, "MOVE_TO")) - moveMark}, DASH ${(await sentCount(page, "DASH")) - dashMark}`);
      expect(await sentCount(page, "MOVE_TO")).toBeGreaterThan(moveMark);
      expect(await sentCount(page, "DASH")).toBe(dashMark);
      // Slow push to the rim and quick release: still walking.
      await t.down(1, p.x, p.y);
      for (let i = 1; i <= 4; i++) { await t.move(1, p.x, p.y - i * 12); await page.waitForTimeout(60); }
      await t.up(1);
      await page.waitForTimeout(400);
      expect(await sentCount(page, "DASH"), "slow push does not dash").toBe(dashMark);
    } finally { await ctx.close(); }
  });
}

test("flick OFF: a flick never dashes (floating and fixed)", async () => {
  for (const floating of [true, false]) {
    const { ctx, page } = await boot({ mobile: true, floating, flick: false });
    try {
      await clearMobs(page);
      const t = new Touch(await ctx.newCDPSession(page));
      const p = await stickPoint(page, floating);
      const dashMark = await sentCount(page, "DASH");
      const moveMark = await sentCount(page, "MOVE_TO");
      await flick(t, page, p, 0, -60);
      await flick(t, page, p, 60, 0);
      note("flick-off", `${floating ? "floating" : "fixed"}: DASH ${(await sentCount(page, "DASH")) - dashMark}, MOVE_TO ${(await sentCount(page, "MOVE_TO")) - moveMark}`);
      expect(await sentCount(page, "DASH")).toBe(dashMark);
    } finally { await ctx.close(); }
  }
});

/** Scripted finger path: `at(tMs)` is where the finger is, sampled every ~16 ms of real time while the touch is down. */
async function playFinger(t: Touch, page: Page, at: (ms: number) => { x: number; y: number }, durationMs: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const ms = Date.now() - t0;
    const p = at(Math.min(ms, durationMs));
    await t.move(1, p.x, p.y);
    if (ms >= durationMs) break;
    await page.waitForTimeout(12);
  }
}

/** A thumb resting on the stick: real fingers never sit perfectly still, so it sends ~1 px of jitter every frame. */
async function holdThumb(t: Touch, page: Page, at: { x: number; y: number }, ms: number): Promise<void> {
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < ms; i++) {
    await t.move(1, at.x + (i % 2 ? 0.6 : -0.6), at.y + (i % 3 ? 0.4 : -0.4));
    await page.waitForTimeout(14);
  }
}

/** Minimum-jerk easing (0..1 in, 0..1 out). */
const ease = (x: number): number => { const k = Math.max(0, Math.min(1, x)); return 10 * k ** 3 - 15 * k ** 4 + 6 * k ** 5; };

/** A mid-hold flick: the finger (already down) goes from a to b in about `ms`, three events scheduled on node timers. */
async function midFlick(t: Touch, a: { x: number; y: number }, b: { x: number; y: number }, ms = 40): Promise<void> {
  const at = (delay: number, fn: () => Promise<void>): Promise<void> => new Promise((resolve, reject) => { setTimeout(() => { fn().then(resolve, reject); }, delay); });
  await Promise.all([
    at(0, () => t.move(1, a.x + (b.x - a.x) * 0.35, a.y + (b.y - a.y) * 0.35)),
    at(ms / 2, () => t.move(1, a.x + (b.x - a.x) * 0.8, a.y + (b.y - a.y) * 0.8)),
    at(ms, () => t.move(1, b.x, b.y))
  ]);
}

for (const floating of [true, false]) {
  const mode = floating ? "floating" : "fixed";

  test(`mid-hold flick (${mode} stick): dashes while walking, walking carries on, cooldown pulses, no false dash`, async () => {
    const { ctx, page } = await boot({ mobile: true, floating, flick: true });
    try {
      await clearMobs(page);
      const t = new Touch(await ctx.newCDPSession(page));
      const p = await stickPoint(page, floating);
      const R = 46;
      const rim = (dx: number, dy: number): { x: number; y: number } => ({ x: p.x + dx * R, y: p.y + dy * R });
      const dashes = (): Promise<number> => sentCount(page, "DASH");
      const moves = (): Promise<number> => sentCount(page, "MOVE_TO");

      // Walk up (rim), then reverse: finger rim-up to past rim-down in one quick flick.
      await t.down(1, p.x, p.y);
      await playFinger(t, page, (ms) => ({ x: p.x, y: p.y - R * ease(ms / 100) }), 100);
      await holdThumb(t, page, rim(0, -1), 700);
      expect(await moves(), "walking sends MOVE_TO").toBeGreaterThan(0);
      let dashMark = await dashes();
      await midFlick(t, rim(0, -1), rim(0, 1.4));
      await page.waitForTimeout(250);
      const sent = await sentFrom(page, "DASH", dashMark);
      note("mid-reverse", `${mode}: DASH ${sent.length} ${JSON.stringify(sent[0]?.payload ?? sent[0])}`);
      expect(sent.length, "reversal flick dashes once").toBe(1);
      const down = await worldDir(page, 0, 1);
      const d0 = sent[0].payload ?? sent[0];
      expect(d0.dirX).toBeCloseTo(down.dirX, 1);
      expect(d0.dirY).toBeCloseTo(down.dirY, 1);
      // Cooldown: an immediate second flick (back up) adds no DASH, and the cooldown pip pulses.
      await holdThumb(t, page, rim(0, 1.4), 700);
      dashMark = await dashes();
      await midFlick(t, rim(0, 1.4), rim(0, -1.4));
      const pulsed = await page.waitForFunction(() => document.querySelector(".joystick-dash-pip")?.classList.contains("is-denied") ?? false, undefined, { timeout: 800 }).then(() => true, () => false);
      await page.waitForTimeout(300);
      note("mid-cooldown", `${mode}: DASH +${(await dashes()) - dashMark}, cooldown pip pulsed ${pulsed}`);
      expect(await dashes() - dashMark, "flick on cooldown adds no DASH").toBe(0);
      expect(pulsed, "flick on cooldown pulses the dash cooldown pip").toBe(true);
      // Wait out the cooldown; the thumb is on the up side, walking up. Walking must carry on after the next dash.
      await holdThumb(t, page, rim(0, -1.4), 3000);
      const before = await playerPos(page);
      const movesBefore = await moves();
      dashMark = await dashes();
      await midFlick(t, rim(0, -1.4), rim(1.3, 0.1));
      await page.waitForTimeout(500);
      expect(await dashes() - dashMark, "turn flick dashes").toBe(1);
      const afterDash = await playerPos(page);
      await page.waitForTimeout(900);
      const later = await playerPos(page);
      const right = await worldDir(page, 1, 0);
      const advance = (later.lon - afterDash.lon) * 97_000 * right.dirX + (later.lat - afterDash.lat) * 111_000 * right.dirY;
      note("mid-carry-on", `${mode}: dash moved ${metresBetween(before, afterDash).toFixed(0)} m, then walked ${advance.toFixed(1)} m along the stick, MOVE_TO +${(await moves()) - movesBefore}`);
      expect(advance, "walking carries on in the stick direction after the dash").toBeGreaterThan(5);
      expect(await moves() - movesBefore, "MOVE_TO resumes after the dash").toBeGreaterThan(0);
      await t.up(1);
      await page.waitForTimeout(500);

      // No false dash: steering a held stick through a circle, zig-zag, 90 degree turns and nudges.
      await page.waitForTimeout(3000);
      dashMark = await dashes();
      await t.down(1, p.x, p.y);
      await playFinger(t, page, (ms) => ({ x: p.x, y: p.y - R * ease(ms / 120) }), 120);
      await page.waitForTimeout(500);
      const at = (deg: number, r = R): { x: number; y: number } => ({ x: p.x + Math.sin((deg * Math.PI) / 180) * r, y: p.y - Math.cos((deg * Math.PI) / 180) * r });
      for (const lapMs of [3000, 1200]) await playFinger(t, page, (ms) => at((ms / lapMs) * 360), lapMs);
      for (let k = 0; k < 4; k++) await playFinger(t, page, (ms) => at(k % 2 ? 45 - 90 * ease(ms / 300) : -45 + 90 * ease(ms / 300)), 320);
      for (let k = 0; k < 4; k++) { await playFinger(t, page, (ms) => at(90 * k + 90 * ease(ms / 300)), 300); await page.waitForTimeout(300); }
      for (let k = 0; k < 4; k++) await playFinger(t, page, (ms) => ({ x: p.x + R * 0.8 + 10 * ease(ms / 90) * (k % 2 ? -1 : 1), y: p.y }), 120);
      await page.waitForTimeout(500);
      await t.up(1);
      const falseDashes = (await dashes()) - dashMark;
      note("mid-false", `${mode}: false DASH ${falseDashes}`);
      expect(falseDashes, "steering never dashes").toBe(0);
    } finally { await ctx.close(); }
  });
}

test("mid-hold flick: flick preference OFF never dashes from a walk", async () => {
  const { ctx, page } = await boot({ mobile: true, floating: true, flick: false });
  try {
    await clearMobs(page);
    const t = new Touch(await ctx.newCDPSession(page));
    const p = await stickPoint(page, true);
    const R = 46;
    await t.down(1, p.x, p.y);
    await playFinger(t, page, (ms) => ({ x: p.x, y: p.y - R * ease(ms / 100) }), 100);
    await holdThumb(t, page, { x: p.x, y: p.y - R }, 700);
    const dashMark = await sentCount(page, "DASH");
    await midFlick(t, { x: p.x, y: p.y - R }, { x: p.x, y: p.y + 1.4 * R });
    await page.waitForTimeout(400);
    await t.up(1);
    expect(await sentCount(page, "DASH")).toBe(dashMark);
  } finally { await ctx.close(); }
});
