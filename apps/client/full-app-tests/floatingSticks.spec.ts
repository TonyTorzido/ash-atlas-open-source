/**
 * Floating twin sticks end-to-end (real headless Chromium, real websocket frames, CDP multi-touch).
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41726 pnpm exec playwright test --config playwright-full-app.config.ts floatingSticks
 *
 *  - touches at several points of the bottom-left region plant the base there (clamped inside the region) and dragging walks
 *  - a drag in the bottom-right region swings in the drag direction, a tap swings once with auto-aim
 *  - the dash button still dashes; rails, dock and MENU keep their own taps; a touch outside the regions still pans the map
 *  - moving and attacking work together; "Floating sticks" OFF restores the fixed corner layout
 * Optional env: ASH_ATLAS_E2E_SHOTS  screenshot folder (float-*.png).
 */
import { expect, test, chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEVICES } from "./iphoneDevices.js";

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

async function boot(opts: { mobile: boolean; width?: number; height?: number; floating?: boolean; guides?: boolean }): Promise<{ ctx: BrowserContext; page: Page }> {
  const size = { width: opts.width ?? (opts.mobile ? 390 : 1280), height: opts.height ?? (opts.mobile ? 844 : 800) };
  const ctx = await browser.newContext(opts.mobile
    ? { viewport: size, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
    : { viewport: size });
  const page = await ctx.newPage();
  await page.addInitScript(({ mobile, floating, guides }) => {
    (window as any).__sent = [] as string[];
    (window as any).__keys = [] as { key: string; prevented: boolean }[];
    const W = window.WebSocket; (window as any).__e2eSockets = [];
    const Wrapped: any = function (this: unknown, ...a: any[]) { const s = new (W as any)(...a); (window as any).__e2eSockets.push(s); return s; };
    Wrapped.prototype = W.prototype; Object.assign(Wrapped, W); (window as any).WebSocket = Wrapped;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: any) { try { (window as any).__sent.push(String(data)); } catch { /* ignore */ } return send.call(this, data); };
    // Records whether the app consumed a number key (hotbar handlers call preventDefault when they act on it).
    window.addEventListener("keydown", (e) => { if (/^[0-9]$/.test(e.key)) setTimeout(() => (window as any).__keys.push({ key: e.key, prevented: e.defaultPrevented }), 0); });
    if (mobile) { try { localStorage.setItem("ashAtlas.joystickMovement.v1", "1"); localStorage.setItem("ashAtlas.floatingSticks.v1", floating ? "1" : "0"); localStorage.setItem("ashAtlas.floatingStickGuides.v1", guides ? "1" : "0"); } catch { /* ignore */ } }
  }, { mobile: opts.mobile, floating: opts.floating !== false, guides: opts.guides !== false });
  await page.goto(baseUrl!, { waitUntil: "domcontentloaded" });
  const dev = page.getByRole("button", { name: "Default Dev" });
  await dev.waitFor({ state: "visible", timeout: 20_000 });
  // The dev-login endpoint rate-limits bursts of sign-ins, and a refused click leaves the sign-in screen up with no
  // message (or "Authentication service unavailable"): back off and click again until the map shows.
  const canvas = page.locator("canvas.maplibregl-canvas").first();
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await dev.isVisible().catch(() => false)) await dev.click();
    await page.locator("main.initial-curtain").or(canvas).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    if (!(await dev.isVisible().catch(() => false))) break;
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

async function setInsets(page: Page, i: { t: number; r: number; b: number; l: number }): Promise<void> {
  await page.evaluate((v) => {
    let el = document.getElementById("e2e-insets");
    if (!el) { el = document.createElement("style"); el.id = "e2e-insets"; document.head.appendChild(el); }
    el.textContent = `:root{--sai-top:${v.t}px;--sai-right:${v.r}px;--sai-bottom:${v.b}px;--sai-left:${v.l}px}`;
  }, i);
  await page.waitForTimeout(800);
}

test("left region: the base plants under the thumb anywhere in the region, clamped inside it, and dragging walks", async () => {
  const { ctx, page } = await boot({ mobile: true });
  try {
    await clearMobs(page);
    const t = new Touch(await ctx.newCDPSession(page));
    const region = await rectOf(page, ".joystick-move");
    note("region", `move region ${JSON.stringify(region)}`);
    expect(region.l).toBeLessThanOrEqual(1);
    expect(region.w).toBeGreaterThan(140);
    expect(region.h).toBeGreaterThan(140);
    const points = [
      { name: "centre", x: region.l + region.w / 2, y: region.t + region.h / 2 },
      { name: "upper-inner", x: region.r - 70, y: region.t + 70 },
      { name: "bottom-left-corner", x: region.l + 6, y: region.b - 6 }
    ];
    for (const p of points) {
      await t.down(1, p.x, p.y);
      await page.waitForTimeout(250);
      const base = await rectOf(page, ".joystick-move-base");
      const c = centreOfRect(base);
      note("plant", `${p.name}: touch ${p.x.toFixed(0)},${p.y.toFixed(0)} base centre ${c.x.toFixed(0)},${c.y.toFixed(0)}`);
      expect(base.l, `${p.name} base inside region (left)`).toBeGreaterThanOrEqual(region.l - 1);
      expect(base.r, `${p.name} base inside region (right)`).toBeLessThanOrEqual(region.r + 1);
      expect(base.t, `${p.name} base inside region (top)`).toBeGreaterThanOrEqual(region.t - 1);
      expect(base.b, `${p.name} base inside region (bottom)`).toBeLessThanOrEqual(region.b + 1);
      if (p.name !== "bottom-left-corner") {
        expect(Math.hypot(c.x - p.x, c.y - p.y), `${p.name} base centred on the touch`).toBeLessThan(2);
      }
      expect(await page.locator(".joystick-move.is-held").count()).toBe(1);
      await t.up(1);
      await page.waitForTimeout(450);
    }
    // After release the base is back at its faint resting outline.
    const rest = centreOfRect(await rectOf(page, ".joystick-move-base"));
    const mid = centreOfRect(region);
    expect(Math.abs(rest.x - mid.x)).toBeLessThan(2);
    expect(Math.abs(rest.y - mid.y)).toBeLessThan(2);
    expect(Number(await page.locator(".joystick-move-base").evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.6);
    // Dragging walks the player.
    const pos0 = await playerPos(page);
    const start = points[0]!;
    await t.down(1, start.x, start.y);
    for (let i = 1; i <= 10; i++) { await t.move(1, start.x + i * 2, start.y - i * 9); await page.waitForTimeout(30); }
    await page.waitForTimeout(1500);
    const walked = metresBetween(pos0, await playerPos(page));
    note("walk", `floating stick walked ${walked.toFixed(1)} m`);
    expect(walked).toBeGreaterThan(3);
    // Trailing: the base followed the finger past the rim.
    // The base never rises above the region top (the lowest slot line), so a finger dragged past it leaves the base on the line.
    const baseRect = await rectOf(page, ".joystick-move-base");
    const base = centreOfRect(baseRect);
    expect(baseRect.t, "trailing base stays below the region top").toBeGreaterThanOrEqual(region.t - 1);
    const wantY = Math.max(start.y - 90, region.t + baseRect.h / 2);
    expect(Math.hypot(base.x - (start.x + 20), base.y - wantY), "base trails within one radius of the finger").toBeLessThan(60);
    await t.up(1);
  } finally { await ctx.close(); }
});

test("right region: drag swings in the drag direction, tap swings once with auto-aim, dash still dashes", async () => {
  const { ctx, page } = await boot({ mobile: true });
  try {
    await clearMobs(page);
    const t = new Touch(await ctx.newCDPSession(page));
    const region = await rectOf(page, ".joystick-attack");
    note("region", `attack region ${JSON.stringify(region)}`);
    expect(region.r).toBeGreaterThanOrEqual(388);
    const p = { x: region.l + region.w * 0.55, y: region.t + region.h * 0.45 };
    for (const [name, dx, dy, ok] of [
      ["east", 22, 0, (s: any) => s.dirX > 0.9],
      ["west", -22, 0, (s: any) => s.dirX < -0.9],
      ["north", 0, -22, (s: any) => s.dirY > 0.9]
    ] as const) {
      const mark = await sentCount(page, "SWING");
      await t.down(2, p.x, p.y);
      await page.waitForTimeout(80);
      const face = centreOfRect(await rectOf(page, ".joystick-attack-face"));
      expect(Math.hypot(face.x - p.x, face.y - p.y), `${name}: attack base planted under the thumb`).toBeLessThan(2);
      await t.move(2, p.x + dx / 2, p.y + dy / 2); await t.move(2, p.x + dx, p.y + dy);
      await page.waitForTimeout(500);
      const swings = await sentFrom(page, "SWING", mark);
      note("swing", `${name}: ${swings.length} swing(s), dir ${swings[0] ? `${swings[0].dirX.toFixed(2)},${swings[0].dirY.toFixed(2)}` : "none"}`);
      expect(swings.length).toBeGreaterThan(0);
      expect(ok(swings[0])).toBe(true);
      await t.up(2);
      await page.waitForTimeout(1700);
    }
    // Held aim repeats at the recovery cadence.
    const mark = await sentCount(page, "SWING");
    await t.down(2, p.x, p.y); await t.move(2, p.x + 22, p.y);
    await page.waitForTimeout(4200);
    const repeats = (await sentFrom(page, "SWING", mark)).length;
    note("repeat", `${repeats} swings in 4.2 s of held aim`);
    expect(repeats).toBeGreaterThanOrEqual(3);
    await t.up(2);
    await page.waitForTimeout(1700);
    // Give auto-aim a bearing (a short walk), then a tap swings exactly once.
    const region2 = await rectOf(page, ".joystick-move");
    const ls = { x: region2.l + 90, y: region2.t + region2.h / 2 };
    await t.down(1, ls.x, ls.y);
    for (let i = 1; i <= 5; i++) { await t.move(1, ls.x, ls.y - i * 8); await page.waitForTimeout(30); }
    await page.waitForTimeout(500);
    await t.up(1);
    await page.waitForTimeout(800);
    const tapMark = await sentCount(page, "SWING");
    await t.down(2, p.x + 5, p.y + 5); await page.waitForTimeout(90); await t.up(2);
    await page.waitForTimeout(700);
    const tapSwings = await sentFrom(page, "SWING", tapMark);
    note("tap", `${tapSwings.length} swing(s) for a tap`);
    expect(tapSwings.length).toBe(1);
    // There is no dash button; Space still dashes and never starts the attack stick.
    await page.waitForTimeout(1500);
    expect(await page.locator(".joystick-dash-face").count()).toBe(0);
    const swingMark = await sentCount(page, "SWING");
    const dashMark = await sentCount(page, "DASH");
    await page.keyboard.press("Space"); await page.waitForTimeout(60);
    await page.waitForTimeout(500);
    note("dash", `DASH frames ${(await sentCount(page, "DASH")) - dashMark}, swings ${(await sentCount(page, "SWING")) - swingMark}`);
    expect(await sentCount(page, "DASH")).toBeGreaterThan(dashMark);
    expect(await sentCount(page, "SWING")).toBe(swingMark);
  } finally { await ctx.close(); }
});

test("rails, dock and MENU keep their taps; outside the regions the map still pans", async () => {
  const { ctx, page } = await boot({ mobile: true });
  try {
    await clearMobs(page);
    const t = new Touch(await ctx.newCDPSession(page));
    const slots = await page.evaluate(() => Array.from(document.querySelectorAll(".ash-hotbar-slot")).map((e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }));
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(await topElement(page, s.x, s.y), `slot at ${s.x.toFixed(0)},${s.y.toFixed(0)}`).toContain("ash-hotbar-slot");
    const dock = centreOfRect(await rectOf(page, ".phone-bottom-bar"));
    expect(await topElement(page, dock.x, dock.y)).not.toContain("joystick");
    const menu = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((e) => /^\s*menu\s*$/i.test(e.textContent ?? ""));
      if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (menu) expect(await topElement(page, menu.x, menu.y)).not.toContain("joystick");
    const regions = { m: await rectOf(page, ".joystick-move"), a: await rectOf(page, ".joystick-attack") };
    expect(regions.m.b, "regions stop at the dock top").toBeLessThanOrEqual((await rectOf(page, ".phone-bottom-bar")).t + 1);
    // A drag well above the regions pans the map.
    const before = await mapCentre(page);
    const start = { x: 195, y: regions.m.t - 120 };
    expect(start.y).toBeGreaterThan(130);
    await t.down(5, start.x, start.y);
    for (let i = 1; i <= 20; i++) { await t.move(5, start.x + i * 3, start.y + i * 2); await page.waitForTimeout(16); }
    await t.up(5);
    await page.waitForTimeout(300);
    const panned = await pxBetween(page, before, await mapCentre(page));
    note("pan", `touch outside the regions panned the map ${panned.toFixed(0)} px`);
    expect(panned).toBeGreaterThan(30);
  } finally { await ctx.close(); }
});

test("moving and attacking at once, third finger on the open map still pans", async () => {
  const { ctx, page } = await boot({ mobile: true });
  try {
    await clearMobs(page);
    const t = new Touch(await ctx.newCDPSession(page));
    const m = await rectOf(page, ".joystick-move");
    const a = await rectOf(page, ".joystick-attack");
    const ms = { x: m.l + 100, y: m.t + m.h * 0.6 };
    const as = { x: a.l + a.w * 0.55, y: a.t + a.h * 0.45 };
    const pos0 = await playerPos(page);
    const moveMark = await sentCount(page, "MOVE_TO");
    const swingMark = await sentCount(page, "SWING");
    await t.down(1, ms.x, ms.y); await t.down(2, as.x, as.y);
    for (let i = 1; i <= 12; i++) { await t.move(1, ms.x + 2 * i, ms.y - 8 * i); await t.move(2, as.x + 2 * i, as.y - 3 * i); await page.waitForTimeout(30); }
    await page.waitForTimeout(1800);
    const walked = metresBetween(pos0, await playerPos(page));
    const swings = await sentFrom(page, "SWING", swingMark);
    note("both", `walked ${walked.toFixed(1)} m, ${swings.length} swings, ${(await sentCount(page, "MOVE_TO")) - moveMark} MOVE_TO`);
    expect(walked).toBeGreaterThan(3);
    expect(swings.length).toBeGreaterThan(0);
    // Third finger on the open map pans while both sticks are held.
    const before = await mapCentre(page);
    const s3 = { x: 195, y: m.t - 140 };
    await t.down(3, s3.x, s3.y);
    for (let i = 1; i <= 20; i++) { await t.move(3, s3.x + i * 3, s3.y + i * 2); await page.waitForTimeout(16); }
    await t.up(3);
    const panned = await pxBetween(page, before, await mapCentre(page));
    note("pan3", `third finger panned ${panned.toFixed(0)} px`);
    expect(panned).toBeGreaterThan(30);
    // A second touch inside the already-held region is ignored for that stick.
    const baseBefore = centreOfRect(await rectOf(page, ".joystick-move-base"));
    await t.down(4, m.l + 20, m.b - 20); await page.waitForTimeout(100);
    const baseAfter = centreOfRect(await rectOf(page, ".joystick-move-base"));
    expect(Math.hypot(baseAfter.x - baseBefore.x, baseAfter.y - baseBefore.y)).toBeLessThan(40);
    await t.up(4); await t.up(1); await t.up(2);
  } finally { await ctx.close(); }
});

test("Floating sticks OFF keeps the fixed corner layout", async () => {
  const { ctx, page } = await boot({ mobile: true, floating: false });
  try {
    expect(await page.locator(".joystick-move.is-floating").count()).toBe(0);
    expect(await page.locator(".joystick-attack.is-floating").count()).toBe(0);
    expect(await page.locator(".joystick-rest-anchor").count()).toBe(0);
    const stick = await rectOf(page, ".joystick-move-base");
    const face = await rectOf(page, ".joystick-attack-face");
    note("fixed", `stick ${JSON.stringify(stick)} attack ${JSON.stringify(face)}`);
    expect(stick.l).toBeLessThan(30);
    expect(390 - face.r).toBeLessThan(30);
    expect(stick.w).toBeLessThan(106);
    const zone = await rectOf(page, ".joystick-move");
    expect(zone.w).toBeLessThan(160);
  } finally { await ctx.close(); }
});

for (const [name, w, h, ins] of [
  ["portrait", 393, 852, { t: 59, r: 0, b: 34, l: 0 }],
  ["landscape", 852, 393, { t: 0, r: 59, b: 21, l: 59 }]
] as const) {
  test(`screenshots iPhone 15 Pro ${name}: idle and mid-use`, async () => {
    const { ctx, page } = await boot({ mobile: true, width: w, height: h });
    try {
      await clearMobs(page);
      await setInsets(page, ins);
      const t = new Touch(await ctx.newCDPSession(page));
      await page.screenshot({ path: join(SHOTS, `float-15pro-${name}-idle.png`) });
      const m = await rectOf(page, ".joystick-move");
      const a = await rectOf(page, ".joystick-attack");
      note("region", `${name}: move ${JSON.stringify(m)} attack ${JSON.stringify(a)}`);
      // Short landscape owns the corners out to the screen edges (safe-area strips included).
      expect(m.l).toBeGreaterThanOrEqual(w > h ? -1 : ins.l - 1);
      expect(a.r).toBeLessThanOrEqual(w > h ? w + 1 : w - ins.r + 1);
      expect(m.r).toBeLessThanOrEqual(a.l + 1);
      const ms = { x: m.l + m.w * 0.62, y: m.t + m.h * 0.35 };
      const as = { x: a.l + a.w * 0.62, y: a.t + a.h * 0.72 };
      await t.down(1, ms.x, ms.y); await t.down(2, as.x, as.y);
      for (let i = 1; i <= 6; i++) { await t.move(1, ms.x + 5 * i, ms.y - 4 * i); await t.move(2, as.x - 3 * i, as.y - 4 * i); await page.waitForTimeout(40); }
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(SHOTS, `float-15pro-${name}-midhold.png`) });
      await t.up(1); await t.up(2);
    } finally { await ctx.close(); }
  });
}

/** Region cap: every region starts at or below the lowest slot of its rail, the guides draw the exact region rect, and
 *  a touch just above the line pans the map while one just below plants the stick. */
for (const dev of DEVICES) {
  for (const orient of ["portrait", "landscape"] as const) {
    test(`region cap ${dev.name} ${orient}`, async () => {
      const land = orient === "landscape";
      const [w, h] = land ? [dev.h, dev.w] : [dev.w, dev.h];
      const ins = land ? dev.landscape : dev.portrait;
      const { ctx, page } = await boot({ mobile: true, width: w, height: h });
      try {
        await clearMobs(page);
        await setInsets(page, ins);
        const m = await rectOf(page, ".joystick-move");
        const a = await rectOf(page, ".joystick-attack");
        const gm = await rectOf(page, '[data-region-guide="left"]');
        const ga = await rectOf(page, '[data-region-guide="right"]');
        const lowest = await page.evaluate(() => {
          const bottom = (side: string): number => Math.max(...Array.from(document.querySelectorAll(`.ash-hotbar-rail-${side} .ash-hotbar-slot`)).map((e) => e.getBoundingClientRect().bottom));
          return { left: bottom("left"), right: bottom("right") };
        });
        note("cap", `${dev.name} ${orient}: left region h ${m.h.toFixed(0)} top ${m.t.toFixed(0)} (slot bottom ${lowest.left.toFixed(0)}), right h ${a.h.toFixed(0)} top ${a.t.toFixed(0)} (slot bottom ${lowest.right.toFixed(0)})`);
        expect(Number.isFinite(lowest.left) && Number.isFinite(lowest.right)).toBe(true);
        expect(m.t, "left region top at or below the lowest left slot").toBeGreaterThanOrEqual(lowest.left - 0.5);
        expect(a.t, "right region top at or below the lowest right slot").toBeGreaterThanOrEqual(lowest.right - 0.5);
        for (const [guide, region] of [[gm, m], [ga, a]] as const) {
          for (const k of ["l", "t", "r", "b"] as const) expect(Math.abs(guide[k] - region[k]), `guide ${k}`).toBeLessThanOrEqual(1);
        }
        // The resting movement stick sits at the centre of its region.
        const restC = centreOfRect(await rectOf(page, ".joystick-move-base"));
        const regC = centreOfRect(m);
        note("rest", `${dev.name} ${orient}: rest ${restC.x.toFixed(1)},${restC.y.toFixed(1)} region centre ${regC.x.toFixed(1)},${regC.y.toFixed(1)}`);
        expect(Math.abs(restC.x - regC.x), "resting stick centre x equals region centre").toBeLessThanOrEqual(2);
        expect(Math.abs(restC.y - regC.y), "resting stick centre y equals region centre").toBeLessThanOrEqual(2);
        const t = new Touch(await ctx.newCDPSession(page));
        // Just above the line: the map pans and no stick plants.
        for (const [region, name] of [[m, "left"], [a, "right"]] as const) {
          // A letterboxed tablet puts the corner regions partly outside the app stage (no map there): pick a point on the stage.
          const stage = await rectOf(page, ".mobile-app-stage");
          const x = Math.min(Math.max(region.l + region.w * (name === "left" ? 0.6 : 0.4), stage.l + 10), stage.r - 10);
          const y = region.t - 6;
          const above = await topElement(page, x, y);
          note("above-line", `${dev.name} ${orient} ${name} (${x.toFixed(0)},${y.toFixed(0)}): ${above}`);
          expect(above, `${name} point above the line`).not.toContain("joystick");
          const before = await mapCentre(page);
          await t.down(7, x, y);
          for (let i = 1; i <= 16; i++) { await t.move(7, x + i * 3, y - i); await page.waitForTimeout(16); }
          expect(await page.locator(".joystick-move.is-held").count(), `${name} stick planted above the line`).toBe(0);
          await t.up(7);
          await page.waitForTimeout(250);
          expect(await pxBetween(page, before, await mapCentre(page)), `${name} pan above the line`).toBeGreaterThan(20);
        }
        // Just below the line: the left stick plants.
        const px = m.l + m.w * 0.6, py = m.t + 8;
        await t.down(8, px, py);
        await page.waitForTimeout(150);
        expect(await page.locator(".joystick-move.is-held").count(), "stick plants just under the line").toBe(1);
        await t.up(8);
        if (dev.name.startsWith("15pro-")) {
          await page.screenshot({ path: join(SHOTS, `floatcap-15pro-${orient}-guides.png`) });
          await page.screenshot({ path: join(SHOTS, `floatcenter-15pro-${orient}.png`) });
          await page.evaluate(() => {
            for (const [sel, color] of [[".joystick-move", "#ff3b30"], [".joystick-attack", "#0a84ff"]] as const) {
              const e = document.querySelector(sel); if (!e) continue;
              const r = e.getBoundingClientRect(); const d = document.createElement("div"); d.className = "e2e-region-outline";
              d.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid ${color};background:${color}22;z-index:2147483647;pointer-events:none`;
              document.body.appendChild(d);
            }
            for (const side of ["left", "right"]) {
              const slots = Array.from(document.querySelectorAll(`.ash-hotbar-rail-${side} .ash-hotbar-slot`));
              const bottom = Math.max(...slots.map((e) => e.getBoundingClientRect().bottom));
              const d = document.createElement("div"); d.className = "e2e-region-outline";
              d.style.cssText = `position:fixed;left:0;right:0;top:${bottom}px;height:0;border-top:1px solid #ffd60a;z-index:2147483647;pointer-events:none`;
              document.body.appendChild(d);
            }
          });
          await page.screenshot({ path: join(SHOTS, `floatcap-15pro-${orient}-outlined.png`) });
        }
      } finally { await ctx.close(); }
    });
  }
}

test("Show stick areas OFF hides the guides but keeps the regions", async () => {
  const { ctx, page } = await boot({ mobile: true, guides: false });
  try {
    expect(await page.locator(".joystick-move.is-floating").count()).toBe(1);
    expect(await page.locator("[data-region-guide]").count()).toBe(0);
  } finally { await ctx.close(); }
});
