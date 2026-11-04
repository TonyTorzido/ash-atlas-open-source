/**
 * Walking next to water, end to end (real headless Chromium, real websocket frames, real World API water lookups).
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> pnpm exec playwright test --config playwright-full-app.config.ts waterShore
 *
 * Needs a feature runtime with a World API (water lookups). Spot: the straight west shore of Lake Okeechobee, Florida
 * (land west of lon -80.95285, open water east of it, shore running north-south for ~700 m).
 * Covers: walking (keyboard) into the water stops at the shore with no raft prompt and no RAFT_REQUIRED frame; holding a
 * diagonal slides along the shore with bounded, forward-only per-frame steps; tapping the water itself shows the raft prompt.
 * Throughout, no frame ever reports the player afloat (an unrafted walk never gets a free raft).
 */
import { expect, test, chromium, type Browser, type Page } from "@playwright/test";

const baseUrl = process.env.ASH_ATLAS_TEST_BASE_URL;
test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at the feature runtime frontend");
test.describe.configure({ mode: "serial", timeout: 180_000 });

/** Cell edge between the last land cell and the first water cell (cells snap to 1e-4 degrees). */
const SHORE_LON = -80.95285;
const SPOT = { lat: 26.8408, lon: -80.9531 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((SPOT.lat * Math.PI) / 180);

type Pos = { lat: number; lon: number };
type Sample = Pos & { t: number };
type Local = { east: number; north: number; t: number };

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => { await browser?.close(); });

async function boot(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (window as any).__recv = [] as string[];
    const W = window.WebSocket; (window as any).__e2eSockets = [];
    const Wrapped: any = function (this: unknown, ...a: any[]) {
      const s = new (W as any)(...a);
      (window as any).__e2eSockets.push(s);
      s.addEventListener("message", (e: MessageEvent) => { try { (window as any).__recv.push(String(e.data)); } catch { /* ignore */ } });
      return s;
    };
    Wrapped.prototype = W.prototype; Object.assign(Wrapped, W); (window as any).WebSocket = Wrapped;
  });
  await page.goto(baseUrl!, { waitUntil: "domcontentloaded" });
  const dev = page.getByRole("button", { name: "Default Dev" });
  await dev.waitFor({ state: "visible", timeout: 20_000 });
  await dev.click();
  await page.locator("main.initial-curtain").waitFor({ state: "detached", timeout: 60_000 });
  await page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(3000);
  const respawn = page.getByRole("button", { name: "Respawn" });
  if (await respawn.isVisible()) { await respawn.click(); await page.waitForTimeout(1500); }
  const gotIt = page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  return page;
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

/** The local player's predicted (rendered) position, read through the JoystickMovement props. */
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

async function teleport(page: Page, to: Pos): Promise<void> {
  await page.evaluate(({ lat, lon }) => {
    const sockets = ((window as any).__e2eSockets as WebSocket[]).filter((s) => s.readyState === 1);
    sockets[sockets.length - 1]!.send(JSON.stringify({ type: "DEV_TELEPORT", requestId: crypto.randomUUID(), lat, lon }));
  }, to);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: (process.env.ASH_ATLAS_E2E_OUT ?? ".") + "/water-after-teleport.png" });
  await expect.poll(async () => { try { const p = await playerPos(page); return Math.hypot(p.lat - to.lat, p.lon - to.lon); } catch { return 1; } }, { timeout: 30_000 }).toBeLessThan(0.00005);
  await page.waitForTimeout(3500);
}

/** Records the rendered position on every animation frame for `ms` while `during` runs. */
async function recordWhile(page: Page, ms: number, during: () => Promise<void>): Promise<Local[]> {
  const recording = page.evaluate((duration) => new Promise<Sample[]>((resolve) => {
    const find = (): (() => { position: Pos }) => {
      for (const e of Array.from(document.querySelectorAll("*"))) {
        const fk = Object.keys(e).find((k) => k.startsWith("__reactFiber")); if (!fk) continue;
        for (let f = (e as any)[fk], d = 0; f && d < 60; f = f.return, d++) {
          const fn = f.memoizedProps?.getWorldState; if (typeof fn === "function") return fn;
        }
      }
      throw new Error("JoystickMovement not mounted");
    };
    const world = find();
    const out: Sample[] = []; const start = performance.now();
    const tick = (): void => {
      const now = performance.now();
      const p = world().position; out.push({ lat: p.lat, lon: p.lon, t: now - start });
      if (now - start < duration) requestAnimationFrame(tick); else resolve(out);
    };
    requestAnimationFrame(tick);
  }), ms);
  await during();
  return (await recording).map((s) => ({
    east: (s.lon - SPOT.lon) * M_PER_DEG_LON, north: (s.lat - SPOT.lat) * M_PER_DEG_LAT, t: s.t
  }));
}

const SHORE_EAST_M = (SHORE_LON - SPOT.lon) * M_PER_DEG_LON;

const received = (page: Page, source: string): Promise<number> =>
  page.evaluate((src) => ((window as any).__recv as string[]).filter((m) => new RegExp(src).test(m)).length, source);

function stepStats(points: Local[]): { maxStepM: number; maxBackM: number; maxStepDtMs: number } {
  let maxStepM = 0; let maxBackM = 0; let maxStepDtMs = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.east - points[i - 1]!.east; const dy = points[i]!.north - points[i - 1]!.north;
    const step = Math.hypot(dx, dy);
    if (step > maxStepM) { maxStepM = step; maxStepDtMs = points[i]!.t - points[i - 1]!.t; }
    maxBackM = Math.max(maxBackM, -dx);
  }
  return { maxStepM, maxBackM, maxStepDtMs };
}

test("walking into water stops at the shore with no prompt, a diagonal slides along it, a water tap asks for a raft", async () => {
  const page = await boot();
  await exposeMap(page);
  await teleport(page, SPOT);
  await page.locator("canvas.maplibregl-canvas").first().hover();
  // The raft prompt (its Launch action is hidden when the pack lacks the materials, so match the prompt itself).
  const prompt = page.locator('[aria-label="Launch a raft onto open water"]');

  const afloatBefore = await received(page, '"afloat":true');
  // 1. Hold east into the lake.
  const into = await recordWhile(page, 7000, async () => {
    await page.keyboard.down("d"); await page.waitForTimeout(6500); await page.keyboard.up("d");
  });
  const end = into[into.length - 1]!;
  const intoStats = stepStats(into);
  console.log("[water] east: start", into[0], "end", end, "shore east m", SHORE_EAST_M.toFixed(1), intoStats);
  expect(end.east, "never enters the water").toBeLessThan(SHORE_EAST_M);
  expect(SHORE_EAST_M - end.east, "reaches the shore").toBeLessThan(3);
  expect(Math.max(...into.map((p) => p.east)), "never predicted into the water either").toBeLessThan(SHORE_EAST_M);
  expect(intoStats.maxBackM, "no bounce back from the shore").toBeLessThan(0.6);
  // Never afloat without paying: an unrafted walk must not float the player for a single frame.
  expect((await received(page, '"afloat":true')) - afloatBefore, "never afloat from a walk").toBe(0);
  expect(await received(page, 'RAFT_REQUIRED'), "no RAFT_REQUIRED frame").toBe(0);
  await expect(prompt).toHaveCount(0);

  // 2. Hold north-east: slides north along the shore.
  const slide = await recordWhile(page, 5000, async () => {
    await page.keyboard.down("d"); await page.keyboard.down("w");
    await page.waitForTimeout(4500);
    await page.keyboard.up("w"); await page.keyboard.up("d");
  });
  const slideEnd = slide[slide.length - 1]!;
  const slideStats = stepStats(slide);
  console.log("[water] slide: end", slideEnd, slideStats);
  (await import("node:fs")).writeFileSync((process.env.ASH_ATLAS_E2E_OUT ?? ".") + "/water-slide.json", JSON.stringify({ spot: SPOT, slide, into }));
  console.log("[water] slide path", JSON.stringify(slide.filter((_, i) => i % 6 === 0).map((p) => [Math.round(p.t), +p.east.toFixed(1), +p.north.toFixed(1)])));
  expect(slideEnd.north - slide[0]!.north, "slides along the shore").toBeGreaterThan(8);
  // Dev characters walk at 125 m/s, so one 100 ms round trip of client prediction is ~12 m; the bounds scale with that.
  // Real speeds (~5 m/s) overshoot by well under a metre. What must hold at any speed: the server never floats the
  // player, the stick never reverses, and the slide ends pinned on land.
  expect((await received(page, '"afloat":true')) - afloatBefore, "never afloat from a slide").toBe(0);
  expect(slideStats.maxStepM, "no per-frame jump beyond a few hundred ms of travel").toBeLessThan(125 * 0.6);
  let reversals = 0;
  for (let i = 2; i < slide.length; i++) {
    const a = slide[i - 1]!.north - slide[i - 2]!.north; const b = slide[i]!.north - slide[i - 1]!.north;
    if (a > 0.02 && b < -0.02) reversals++;
  }
  expect(reversals, "northward progress never reverses").toBeLessThanOrEqual(8);
  expect(await received(page, 'RAFT_REQUIRED')).toBe(0);
  await expect(prompt).toHaveCount(0);

  // 3. Tap open water ~150 m east of the shore: the raft prompt shows (no raft is bought).
  await teleport(page, SPOT);
  const here = SPOT;
  const water = { lat: here.lat, lon: SHORE_LON + 150 / M_PER_DEG_LON };
  // The tap is a plain MOVE_TO (no walk flag) at open water, sent exactly as the map tap handler sends it.
  await page.evaluate(({ lat, lon }) => {
    const sockets = ((window as any).__e2eSockets as WebSocket[]).filter((s) => s.readyState === 1);
    sockets[sockets.length - 1]!.send(JSON.stringify({ type: "MOVE_TO", requestId: crypto.randomUUID(), lat, lon }));
  }, water);
  await page.waitForTimeout(2500);
  console.log("[water] tap answers", await page.evaluate(() => ((window as any).__recv as string[])
    .filter((m) => /RAFT_REQUIRED|"ERROR"|MOVE_ACCEPTED/.test(m)).slice(-3).map((m) => m.slice(0, 300))));
  await page.screenshot({ path: (process.env.ASH_ATLAS_E2E_OUT ?? ".") + "/water-after-tap.png" });
  await expect(prompt).toBeVisible({ timeout: 6000 });
  // The prompt is only offered: still not afloat.
  expect((await received(page, '"afloat":true')) - afloatBefore, "a raft prompt is not a raft").toBe(0);
  await page.screenshot({ path: process.env.ASH_ATLAS_E2E_OUT ? `${process.env.ASH_ATLAS_E2E_OUT}/water-shore-raft-prompt.png` : "water-shore-raft-prompt.png" });
  await page.context().close();
});
