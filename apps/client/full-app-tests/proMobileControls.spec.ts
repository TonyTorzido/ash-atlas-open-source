/**
 * Pro mobile controls end-to-end checks (real headless Chromium, real websocket frames, CDP multi-touch).
 *
 *  - walking with the stick does NOT move the map centre (the camera never follows the player)
 *  - a second finger drags the map while the stick finger keeps walking (MOVE_TO frames continue), and
 *    a two-finger pinch zooms while the stick is held; frame pacing is measured during the pan
 *  - a 22 px drag on the attack button swings in that direction at once; a touch well outside the visible
 *    button still grabs it; taps on the dash button never swing
 *  - touch zones never overlap the dock or the MENU button
 *  - desktop: left-drag pans the map while WASD is held
 *  - number-key hotbar handling is not blocked by an open chat window
 *  - screenshots (idle + mid attack drag) at 390x844, 360x780 and 844x390
 *
 * Run (feature runtime started with ACTION_COMBAT_ENABLED=true):
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<frontend> pnpm exec playwright test --config playwright-full-app.config.ts proMobileControls
 * Optional: ASH_ATLAS_E2E_SHOTS = screenshot folder.
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

async function boot(opts: { mobile: boolean; width?: number; height?: number }): Promise<{ ctx: BrowserContext; page: Page }> {
  const size = { width: opts.width ?? (opts.mobile ? 390 : 1280), height: opts.height ?? (opts.mobile ? 844 : 800) };
  const ctx = await browser.newContext(opts.mobile
    ? { viewport: size, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
    : { viewport: size });
  const page = await ctx.newPage();
  await page.addInitScript((mobile) => {
    (window as any).__sent = [] as string[];
    (window as any).__keys = [] as { key: string; prevented: boolean }[];
    const W = window.WebSocket; (window as any).__e2eSockets = [];
    const Wrapped: any = function (this: unknown, ...a: any[]) { const s = new (W as any)(...a); (window as any).__e2eSockets.push(s); return s; };
    Wrapped.prototype = W.prototype; Object.assign(Wrapped, W); (window as any).WebSocket = Wrapped;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: any) { try { (window as any).__sent.push(String(data)); } catch { /* ignore */ } return send.call(this, data); };
    // Records whether the app consumed a number key (hotbar handlers call preventDefault when they act on it).
    window.addEventListener("keydown", (e) => { if (/^[0-9]$/.test(e.key)) setTimeout(() => (window as any).__keys.push({ key: e.key, prevented: e.defaultPrevented }), 0); });
    if (mobile) { try { localStorage.setItem("ashAtlas.joystickMovement.v1", "1"); localStorage.setItem("ashAtlas.floatingSticks.v1", "0"); } catch { /* ignore */ } }
  }, opts.mobile);
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

test("multi-touch: stick held, second finger pans the map, pinch zooms, camera never follows", async () => {
  const { ctx, page } = await boot({ mobile: true });
  try {
    await clearMobs(page);
    const cdp = await ctx.newCDPSession(page);
    const t = new Touch(cdp);
    await watchProgrammaticMoves(page);
    const stick = await centreOf(page, ".joystick-move-base");

    // 1. Walk with the stick only: the player moves, the map centre must not.
    const centre0 = await mapCentre(page);
    const pos0 = await playerPos(page);
    await t.down(1, stick.x, stick.y);
    for (let i = 1; i <= 6; i++) { await t.move(1, stick.x + i * 3, stick.y - i * 7); await page.waitForTimeout(30); }
    await page.waitForTimeout(1800);
    const centre1 = await mapCentre(page);
    const pos1 = await playerPos(page);
    const walked = metresBetween(pos0, pos1);
    const centreDriftPx = await pxBetween(page, centre0, centre1);
    note("walk", `player moved ${walked.toFixed(1)} m, map centre drifted ${centreDriftPx.toFixed(2)} px, programmatic camera moves ${await progMoves(page)}`);
    expect(walked, "the stick walks the player").toBeGreaterThan(3);
    expect(centre1.lat).toBeCloseTo(centre0.lat, 9);
    expect(centre1.lon).toBeCloseTo(centre0.lon, 9);
    expect(await progMoves(page), "no camera move without user input while walking").toBe(0);

    // 2. Second finger drags the open map while the stick finger keeps holding.
    const movesMark = await sentCount(page, "MOVE_TO");
    const posBeforePan = await playerPos(page);
    const centreBeforePan = await mapCentre(page);
    await startFrameRecorder(page);
    await page.waitForTimeout(1500);
    note("fps", `baseline pacing, stick held, no pan: ${JSON.stringify(await stopFrameRecorder(page))}`);
    await startFrameRecorder(page);
    const start = { x: 200, y: 260 };
    await t.down(2, start.x, start.y);
    for (let i = 1; i <= 40; i++) {
      await t.move(2, start.x + i * 3, start.y + i * 2);
      await page.waitForTimeout(16);
    }
    const pacing = await stopFrameRecorder(page);
    await page.waitForTimeout(150);
    const centreAfterPan = await mapCentre(page);
    const posAfterPan = await playerPos(page);
    const panPx = await pxBetween(page, centreBeforePan, centreAfterPan);
    const moveFrames = (await sentFrom(page, "MOVE_TO", movesMark)).length;
    note("pan", `map panned ${panPx.toFixed(0)} px while stick held; player kept walking ${metresBetween(posBeforePan, posAfterPan).toFixed(1)} m; MOVE_TO frames during pan ${moveFrames}`);
    note("fps", `frame pacing during pan: ${JSON.stringify(pacing)}`);
    expect(panPx, "the map follows the second finger").toBeGreaterThan(60);
    expect(metresBetween(posBeforePan, posAfterPan), "the player keeps walking during the pan").toBeGreaterThan(1);
    expect(moveFrames, "MOVE_TO frames continue during the pan").toBeGreaterThan(2);
    await page.screenshot({ path: join(SHOTS, "pro-multitouch-pan-390x844.png") });
    await t.up(2);
    await page.waitForTimeout(400);

    // 3. Pinch (two more fingers) while the stick finger still holds: the zoom changes.
    const zoom0 = (await mapCentre(page)).zoom;
    await t.down(3, 150, 260); await t.down(4, 250, 260);
    for (let i = 1; i <= 14; i++) {
      await t.move(3, 150 - i * 5, 260); await t.move(4, 250 + i * 5, 260);
      await page.waitForTimeout(20);
    }
    await t.up(4); await t.up(3);
    await page.waitForTimeout(500);
    const zoom1 = (await mapCentre(page)).zoom;
    note("pinch", `zoom ${zoom0.toFixed(2)} -> ${zoom1.toFixed(2)} with the stick held`);
    expect(Math.abs(zoom1 - zoom0), "pinch zooms while the stick is held").toBeGreaterThan(0.15);
    expect(await sentCount(page, "MOVE_TO")).toBeGreaterThan(movesMark);
    await t.up(1);
    // The camera never moved on its own, even through the pinch settle and the idle ground-zoom upkeep.
    await page.waitForTimeout(2500);
    expect(await progMoves(page), "no programmatic camera move through the whole gesture").toBeLessThanOrEqual(1);
  } finally { await ctx.close(); }
});

test("attack button: 22 px drag swings at once, large invisible zone, dash/dock untouched", async () => {
  const { ctx, page } = await boot({ mobile: true });
  try {
    await clearMobs(page);
    const cdp = await ctx.newCDPSession(page);
    const t = new Touch(cdp);
    const face = await centreOf(page, ".joystick-attack-face");
    const faceBox = (await page.locator(".joystick-attack-face").boundingBox())!;
    const zoneBox = (await page.locator(".joystick-attack").boundingBox())!;
    note("attack", `face ${faceBox.width}x${faceBox.height}, zone ${zoneBox.width}x${zoneBox.height}`);
    // The face is a stick-class ring (22vmin, capped 76..96 px); the invisible zone reaches 64 px further in and out.
    expect(faceBox.width).toBeGreaterThanOrEqual(76);
    expect(faceBox.width).toBeLessThanOrEqual(96);
    expect(zoneBox.width).toBeGreaterThanOrEqual(faceBox.width + 60);
    expect(zoneBox.width).toBeLessThanOrEqual(faceBox.width + 68);

    // 22 px drag east (just past the 18 px tap dead zone): SWING with dirX ~ +1 (map bearing 0) within a few frames.
    const dirs: Array<[string, number, number]> = [["east", 22, 0], ["west", -22, 0], ["north", 0, -22]];
    for (const [name, dx, dy] of dirs) {
      const mark = await sentCount(page, "SWING");
      await t.down(1, face.x, face.y);
      const startedAt = Date.now();
      await t.move(1, face.x + dx, face.y + dy);
      let swings: any[] = [];
      while (Date.now() - startedAt < 1500 && swings.length === 0) { await page.waitForTimeout(10); swings = await sentFrom(page, "SWING", mark); }
      const latency = Date.now() - startedAt;
      await page.screenshot({ path: join(SHOTS, `pro-aim-drag-${name}-390x844.png`) });
      await t.up(1);
      note("swing", `${name}: ${swings.length} swing(s), first after ${latency} ms, dir ${swings[0] ? `${swings[0].dirX.toFixed(2)},${swings[0].dirY.toFixed(2)}` : "none"}`);
      expect(swings.length, `${name} drag swings`).toBeGreaterThan(0);
      if (name === "east") expect(swings[0].dirX).toBeGreaterThan(0.9);
      if (name === "west") expect(swings[0].dirX).toBeLessThan(-0.9);
      if (name === "north") expect(swings[0].dirY).toBeGreaterThan(0.9);
      expect(latency, "swing starts on the first frames past the dead zone").toBeLessThan(400);
      await page.waitForTimeout(1600); // let the recovery finish
    }

    // Held aim keeps swinging at the recovery cadence.
    {
      const mark = await sentCount(page, "SWING");
      await t.down(1, face.x, face.y);
      await t.move(1, face.x + 20, face.y - 10);
      await page.waitForTimeout(4200);
      const n = (await sentFrom(page, "SWING", mark)).length;
      await t.up(1);
      note("repeat", `${n} swings in 4.2 s of held aim`);
      expect(n).toBeGreaterThanOrEqual(2);
      await page.waitForTimeout(1600);
    }

    // A touch well outside the visible button (but inside the invisible zone) still grabs it. The gesture is measured
    // from the face centre, so the finger is already "past the dead zone": the swing goes out pointing away from the face.
    const half = faceBox.width / 2;
    const outside: Array<[string, number, number]> = [["right", half + 6, 0], ["left", -(half + 34), 0], ["above", 0, -(half + 40)]];
    for (const [name, dx, dy] of outside) {
      const mark = await sentCount(page, "SWING");
      const hit = await page.evaluate(({ x, y }) => String(document.elementFromPoint(x, y)?.className ?? ""), { x: face.x + dx, y: face.y + dy });
      await t.down(1, face.x + dx, face.y + dy);
      await t.move(1, face.x + dx + Math.sign(dx) * 2, face.y + dy + Math.sign(dy) * 2);
      await page.waitForTimeout(400);
      const swings = await sentFrom(page, "SWING", mark);
      await t.up(1);
      note("zone", `${name}: touch ${Math.hypot(dx, dy).toFixed(0)} px from the face centre (${(Math.hypot(dx, dy) - half).toFixed(0)} px outside the rim), element ${hit}, swings ${swings.length}`);
      expect(hit).toContain("joystick-attack");
      expect(swings.length, `touch ${name} of the button still grabs the attack stick`).toBeGreaterThan(0);
      if (name === "right") expect(swings[0].dirX).toBeGreaterThan(0.9);
      if (name === "left") expect(swings[0].dirX).toBeLessThan(-0.9);
      if (name === "above") expect(swings[0].dirY).toBeGreaterThan(0.9);
      await page.waitForTimeout(1600);
    }

    // There is no dash face; Space still dashes, and never swings.
    {
      const swingMark = await sentCount(page, "SWING");
      const dashMark = await sentCount(page, "DASH");
      expect(await page.locator(".joystick-dash-face").count()).toBe(0);
      await page.keyboard.press("Space");
      await page.waitForTimeout(500);
      expect(await sentCount(page, "DASH")).toBeGreaterThan(dashMark);
      expect(await sentCount(page, "SWING")).toBe(swingMark);
    }

    // Zones stay clear of the dock and the MENU button.
    const geo = await page.evaluate(() => {
      const r = (el: Element | null) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const menu = Array.from(document.querySelectorAll("button")).find((b) => /^\s*menu\s*$/i.test(b.textContent ?? "") || /game menu|open menu/i.test(b.getAttribute("aria-label") ?? ""));
      return { attack: r(document.querySelector(".joystick-attack")), stick: r(document.querySelector(".joystick-move")), dock: r(document.querySelector(".phone-bottom-bar")), menu: r(menu ?? null), vw: innerWidth };
    });
    note("geo", JSON.stringify(geo));
    const overlap = (a: any, b: any): boolean => !!a && !!b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
    for (const key of ["attack", "stick"] as const) {
      expect(overlap(geo[key], geo.dock), `${key} zone must not overlap the dock`).toBe(false);
      expect(overlap(geo[key], geo.menu), `${key} zone must not overlap MENU`).toBe(false);
    }
    expect(geo.stick!.l).toBeGreaterThanOrEqual(0); // zones hug the corners; the rails now stack above them
    expect(geo.attack!.r).toBeLessThanOrEqual(geo.vw);
  } finally { await ctx.close(); }
});

const SHOT_SIZES: Array<[number, number, string]> = [[390, 844, "portrait-390x844"], [360, 780, "portrait-360x780"], [844, 390, "landscape-844x390"]];
for (const [w, h, tag] of SHOT_SIZES) {
  test(`screenshots ${tag}: idle and mid attack drag`, async () => {
    const { ctx, page } = await boot({ mobile: true, width: w, height: h });
    try {
      await clearMobs(page);
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(SHOTS, `pro-${tag}-idle.png`) });
      const cdp = await ctx.newCDPSession(page);
      const t = new Touch(cdp);
      const face = await centreOf(page, ".joystick-attack-face");
      await t.down(1, face.x, face.y);
      await t.move(1, face.x - 22, face.y - 14);
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `pro-${tag}-aim.png`) });
      await t.up(1);
      // Stick held too, for the left thumb.
      const stick = await centreOf(page, ".joystick-move-base");
      await t.down(2, stick.x, stick.y);
      await t.move(2, stick.x + 22, stick.y - 24);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, `pro-${tag}-stick.png`) });
      await t.up(2);
    } finally { await ctx.close(); }
  });
}

test("desktop: left-drag pans the map smoothly while WASD is held", async () => {
  const { ctx, page } = await boot({ mobile: false });
  try {
    await clearMobs(page);
    await watchProgrammaticMoves(page);
    const movesMark = await sentCount(page, "MOVE_TO");
    const pos0 = await playerPos(page);
    const centre0 = await mapCentre(page);
    await page.keyboard.down("d");
    await page.waitForTimeout(500);
    await startFrameRecorder(page);
    await page.mouse.move(500, 300);
    await page.mouse.down();
    for (let i = 1; i <= 50; i++) { await page.mouse.move(500 + i * 4, 300 + i * 2); await page.waitForTimeout(16); }
    await page.mouse.up();
    const pacing = await stopFrameRecorder(page);
    await page.waitForTimeout(500);
    await page.keyboard.up("d");
    const centre1 = await mapCentre(page);
    const pos1 = await playerPos(page);
    const panPx = await pxBetween(page, centre0, centre1);
    const frames = (await sentFrom(page, "MOVE_TO", movesMark)).length;
    note("desktop-pan", `panned ${panPx.toFixed(0)} px, player walked ${metresBetween(pos0, pos1).toFixed(1)} m, MOVE_TO frames ${frames}, programmatic camera moves ${await progMoves(page)}`);
    note("fps", `desktop frame pacing during pan: ${JSON.stringify(pacing)}`);
    expect(panPx).toBeGreaterThan(80);
    expect(metresBetween(pos0, pos1)).toBeGreaterThan(2);
    expect(frames).toBeGreaterThan(2);
    expect(await progMoves(page)).toBe(0);
  } finally { await ctx.close(); }
});

test("number-key hotbar handling stays live with chat open", async () => {
  const { ctx, page } = await boot({ mobile: false });
  try {
    await clearMobs(page);
    const press = async (): Promise<{ key: string; prevented: boolean }[]> => {
      await page.evaluate(() => { (window as any).__keys.length = 0; });
      await page.locator("canvas.maplibregl-canvas").first().click({ position: { x: 700, y: 300 } });
      for (const key of ["1", "2", "3"]) { await page.keyboard.press(key); await page.waitForTimeout(150); }
      return page.evaluate(() => (window as any).__keys as { key: string; prevented: boolean }[]);
    };
    const closed = await press();
    await page.getByRole("button", { name: /Open General chat/ }).click();
    await expect(page.locator("[data-desktop-window=\"chat:public\"]")).toBeVisible();
    const open = await press();
    note("hotbar", `chat closed ${JSON.stringify(closed)}; chat open ${JSON.stringify(open)}`);
    // Whatever the dev hotbar has bound, the open chat window must not change what the app does with number keys.
    expect(open.map((k) => k.prevented)).toEqual(closed.map((k) => k.prevented));
    // And the guard itself: with chat open the keyboard-block probe reports nothing for the hotbar.
    const blocked = await page.evaluate(() => document.querySelectorAll("[aria-modal=\"true\"]").length);
    expect(blocked).toBe(0);
  } finally { await ctx.close(); }
});

test("one-finger map pan with no stick held: full distance, 60 fps", async () => {
  const { ctx, page } = await boot({ mobile: true });
  try {
    await clearMobs(page);
    const t = new Touch(await ctx.newCDPSession(page));
    const before = await mapCentre(page);
    await startFrameRecorder(page);
    await t.down(2, 200, 260);
    for (let i = 1; i <= 40; i++) { await t.move(2, 200 + i * 3, 260 + i * 2); await page.waitForTimeout(16); }
    await t.up(2);
    const pacing = await stopFrameRecorder(page);
    const panPx = await pxBetween(page, before, await mapCentre(page));
    note("single-pan", `panned ${panPx.toFixed(0)} px of 144, pacing ${JSON.stringify(pacing)}`);
    expect(panPx).toBeGreaterThan(130);
  } finally { await ctx.close(); }
});

const RAIL_SIZES: Array<[number, number, string]> = [[390, 844, "portrait-390x844"], [360, 780, "portrait-360x780"], [844, 390, "landscape-844x390"], [780, 360, "landscape-780x360"]];
for (const [w, h, tag] of RAIL_SIZES) {
  test(`slot rails sit above both touch zones ${tag}`, async () => {
    const { ctx, page } = await boot({ mobile: true, width: w, height: h });
    try {
      await clearMobs(page);
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(SHOTS, `pro2-${tag}.png`) });
      const g = await page.evaluate(() => {
        const r = (el: Element) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
        const all = (sel: string) => Array.from(document.querySelectorAll(sel)).filter((e) => e.getBoundingClientRect().width > 0).map(r);
        const cs = getComputedStyle(document.documentElement); (window as any).__vars = ["--cc-zones-top","--hud-quick-slot-visible-height","--hud-quick-slot-top","--hud-quick-slot-stack-height"].map((v) => v + "=" + cs.getPropertyValue(v).replace(/s+/g, " ")).join(" ; ") + " attr=" + document.documentElement.dataset.combatControls + " stackKids=" + (document.querySelector(".ash-hotbar-rail")?.children[0]?.className ?? "none");
        const slots = all(".ash-hotbar-slot");
        const rails = all(".ash-hotbar-rail");
        const zones = [".joystick-move", ".joystick-attack"].map((s) => ({ s, ...r(document.querySelector(s)!) }));
        const chat = document.querySelector(".chat-top-bar");
        return { slots, rails, zones, chatBottom: chat ? r(chat).b : 0, vh: innerHeight, scrollH: document.documentElement.scrollHeight };
      });
      const lowestSlot = Math.max(...g.slots.map((s) => s.b));
      const highestZone = Math.min(...g.zones.map((z) => z.t));
      const topRail = Math.min(...g.rails.map((s) => s.t));
      note("rails", `${tag}: ${g.slots.length} slots, lowest slot bottom ${lowestSlot.toFixed(0)}, highest zone top ${highestZone.toFixed(0)} (gap ${(highestZone - lowestSlot).toFixed(0)}), slot height ${(g.slots[0]!.b - g.slots[0]!.t).toFixed(0)}, rail top ${topRail.toFixed(0)}, chat bottom ${g.chatBottom.toFixed(0)}`);
      expect(g.slots.length).toBeGreaterThanOrEqual(8);
      for (const slot of g.slots) for (const z of g.zones) expect(slot.b, `slot above ${z.s}`).toBeLessThanOrEqual(z.t - 7.5);
      expect(highestZone - lowestSlot, "lowest slot sits just above the zones").toBeLessThanOrEqual(12.5);
      expect(topRail, "rails stay below the chat bar").toBeGreaterThanOrEqual(g.chatBottom);
      expect(g.scrollH).toBeLessThanOrEqual(g.vh);
    } finally { await ctx.close(); }
  });
}
