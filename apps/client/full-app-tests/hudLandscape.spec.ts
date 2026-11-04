/**
 * Landscape HUD (docs/plans/hud-landscape.md): no dash button, controls fully in the bottom corners, corner touches owned
 * by the controls, compact bottom bar. Real headless Chromium at 932x430 with a simulated iPhone safe area
 * (--sai-* custom properties: 59 px left and right, 21 px bottom).
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41372 pnpm exec playwright test --config playwright-full-app.config.ts hudLandscape
 *
 * Optional env: ASH_ATLAS_E2E_SHOTS  screenshot folder (hud-landscape-*.png).
 */
import { expect, test, chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, note, baseUrl, type Session } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend with action combat on");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const SHOTS = process.env.ASH_ATLAS_E2E_SHOTS ?? "./test-results/e2e-shots";
mkdirSync(SHOTS, { recursive: true });

const VIEWPORT = { width: 932, height: 430 };
const SAI = { top: 0, right: 59, bottom: 21, left: 59 };

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : [] }); });
test.afterAll(async () => { await browser?.close(); });

async function boot(name: string, viewport = VIEWPORT, sai = SAI): Promise<{ ctx: BrowserContext; s: Session }> {
  const { ctx, s } = await launch(browser, name, { viewport, joystick: true, storage: { "ashAtlas.floatingSticks.v1": "1" } });
  await s.page.evaluate((v) => {
    const el = document.createElement("style");
    el.id = "e2e-insets";
    el.textContent = `:root{--sai-top:${v.top}px;--sai-right:${v.right}px;--sai-bottom:${v.bottom}px;--sai-left:${v.left}px}`;
    document.head.appendChild(el);
  }, sai);
  const gotIt = s.page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await s.page.waitForTimeout(800);
  return { ctx, s };
}

interface R { l: number; t: number; r: number; b: number; w: number; h: number }
const rectOf = (page: Page, selector: string): Promise<R | null> => page.evaluate((sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const b = e.getBoundingClientRect();
  return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
}, selector);
const overlaps = (a: R, b: R): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

class Touch {
  constructor(private readonly cdp: CDPSession) {}
  private send(type: "touchStart" | "touchMove" | "touchEnd", points: Array<{ x: number; y: number; id: number }>): Promise<unknown> {
    return this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : points });
  }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.send("touchStart", [{ ...from, id: 1 }]);
    for (let i = 1; i <= 8; i++) await this.send("touchMove", [{ x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8, id: 1 }]);
    await this.send("touchEnd", []);
  }
  async pinch(center: { x: number; y: number }, from: number, to: number): Promise<void> {
    const pts = (d: number) => [{ x: center.x - d, y: center.y, id: 1 }, { x: center.x + d, y: center.y, id: 2 }];
    await this.send("touchStart", pts(from));
    for (let i = 1; i <= 8; i++) await this.send("touchMove", pts(from + ((to - from) * i) / 8));
    await this.send("touchEnd", []);
  }
}

const mapState = (page: Page): Promise<{ lng: number; lat: number; zoom: number }> => page.evaluate(() => {
  const m = (window as any).__e2eMap;
  const c = m.getCenter();
  return { lng: c.lng as number, lat: c.lat as number, zoom: m.getZoom() as number };
});

test("1. there is no dash button anywhere in the touch HUD", async () => {
  const { ctx, s } = await boot("hl-nodash");
  try {
    await expect(s.page.locator(".joystick-attack-face")).toHaveCount(1);
    await expect(s.page.locator(".joystick-dash, .joystick-dash-face")).toHaveCount(0);
    await expect(s.page.getByRole("button", { name: "Dash" })).toHaveCount(0);
    // Keyboard dash is kept.
    const mark = s.mark();
    await s.page.keyboard.press("Space");
    await expect.poll(() => s.since(mark, "DASH", "out").length, { timeout: 3000 }).toBeGreaterThan(0);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("2. landscape: stick and attack sit fully in the bottom corners, the original bottom bar clears both controls", async () => {
  const { ctx, s } = await boot("hl-layout");
  try {
    const stick = (await rectOf(s.page, ".joystick-move-base"))!;
    const attack = (await rectOf(s.page, ".joystick-attack-face"))!;
    const bar = (await rectOf(s.page, ".phone-bottom-bar"))!;
    const status = (await rectOf(s.page, ".phone-bottom-status"))!;
    const safeBottom = VIEWPORT.height - SAI.bottom;
    await s.page.screenshot({ path: join(SHOTS, "hud-landscape-layout.png") });

    // Resting at the exact centre of their zone boxes (the dotted guides draw the zones): no shift for the safe-area insets.
    const left = (await rectOf(s.page, '[data-region-guide="left"]'))!;
    const right = (await rectOf(s.page, '[data-region-guide="right"]'))!;
    note("zones", JSON.stringify({ left, right }));
    const cx = (r: R): number => (r.l + r.r) / 2;
    const cy = (r: R): number => (r.t + r.b) / 2;
    expect(Math.abs(cx(stick) - cx(left)), "stick centred horizontally in its zone").toBeLessThanOrEqual(2);
    expect(Math.abs(cy(stick) - cy(left)), "stick centred vertically in its zone").toBeLessThanOrEqual(2);
    expect(Math.abs(cx(attack) - cx(right)), "attack centred horizontally in its zone").toBeLessThanOrEqual(2);
    expect(Math.abs(cy(attack) - cy(right)), "attack centred vertically in its zone").toBeLessThanOrEqual(2);
    expect(left.l).toBeLessThanOrEqual(0.5);
    expect(right.r).toBeGreaterThanOrEqual(VIEWPORT.width - 0.5);
    // Fully inside their zones, and on screen.
    expect(stick.r).toBeLessThanOrEqual(left.r);
    expect(stick.t).toBeGreaterThanOrEqual(left.t);
    expect(attack.l).toBeGreaterThanOrEqual(right.l);
    expect(attack.t).toBeGreaterThanOrEqual(right.t);

    // The bar is back to its pre-hud-landscape size (40 px of content); it must stay clear of both corner controls.
    expect(bar.b).toBeCloseTo(VIEWPORT.height, 0);
    expect(status.b, "readouts end at the safe edge").toBeLessThanOrEqual(safeBottom + 1);
    expect(bar.h - SAI.bottom, "bar content height").toBeLessThanOrEqual(40);
    expect(overlaps(bar, stick)).toBe(false);
    expect(overlaps(bar, attack)).toBe(false);
    expect(await s.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(VIEWPORT.width);
    expect(await s.page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(VIEWPORT.height);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("3. landscape: touches that start in either bottom corner never pan or zoom the map", async () => {
  const { ctx, s } = await boot("hl-corners");
  try {
    const t = new Touch(await ctx.newCDPSession(s.page));
    const before = await mapState(s.page);
    const same = async (what: string): Promise<void> => {
      await s.page.waitForTimeout(400);
      const now = await mapState(s.page);
      expect(Math.abs(now.lng - before.lng) + Math.abs(now.lat - before.lat), `${what}: no pan`).toBeLessThan(1e-7);
      expect(now.zoom, `${what}: no zoom`).toBeCloseTo(before.zoom, 3);
    };
    const W = VIEWPORT.width;
    const H = VIEWPORT.height;
    // Bottom right, away from the attack face: inside the safe area, and in the home-indicator strip beyond it.
    await t.drag({ x: W - 200, y: H - 30 }, { x: W - 230, y: H - 100 });
    await same("bottom-right drag inside the zone");
    await t.drag({ x: W - 20, y: H - 12 }, { x: W - 100, y: H - 90 });
    await same("bottom-right drag from the safe-area strip");
    await t.pinch({ x: W - 100, y: H - 50 }, 20, 60);
    await same("bottom-right two-finger pinch");
    // Bottom left: a touch there plants the walking stick (the follow camera then legitimately moves), so assert ownership
    // of every corner point instead: the stick zone is the topmost element, in the safe area and in the strip beyond it.
    const owner = (x: number, y: number): Promise<string> => s.page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest(".joystick-move, .joystick-attack")?.className.split(" ")[0] ?? "map", { x, y });
    // Zones are the owner boxes: left x 0-210 / y 292-430, right x 698-932 / y 305-430 (just inside the edges here).
    for (const [x, y] of [[2, H - 2], [14, H - 12], [60, H - 6], [90, 300], [150, H - 30], [205, 296]] as const) expect(await owner(x, y), `left zone point ${x},${y}`).toBe("joystick-move");
    for (const [x, y] of [[W - 2, H - 2], [W - 20, H - 12], [W - 60, H - 6], [W - 90, 310], [W - 200, H - 30], [702, 309]] as const) expect(await owner(x, y), `right zone point ${x},${y}`).toBe("joystick-attack");
    // Just outside the boxes the touch belongs to the map again.
    for (const [x, y] of [[215, H - 30], [100, 286], [694, H - 30], [W - 90, 299]] as const) expect(await owner(x, y), `outside point ${x},${y}`).toBe("map");
    // Taps in the corners open no popup.
    await s.page.touchscreen.tap(W - 200, H - 30);
        await s.page.waitForTimeout(400);
    expect(await s.page.locator(".map-popup, [role='dialog']").count(), "no popup from a corner tap").toBe(0);
    await same("corner taps");
    // Control: a drag on the open map still pans it.
    await t.drag({ x: W / 2, y: 150 }, { x: W / 2 - 150, y: 150 });
    await s.page.waitForTimeout(600);
    const after = await mapState(s.page);
    expect(Math.abs(after.lng - before.lng) + Math.abs(after.lat - before.lat), "the open map still pans").toBeGreaterThan(1e-6);
    await s.page.screenshot({ path: join(SHOTS, "hud-landscape-corners.png") });
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("4. portrait 430x932: the zones are mirror images and both controls rest at their centres, clear of the bar and the rails", async () => {
  const portrait = { width: 430, height: 932 };
  const { ctx, s } = await boot("hl-portrait", portrait, { top: 59, right: 0, bottom: 34, left: 0 });
  try {
    const left = (await rectOf(s.page, '[data-region-guide="left"]'))!;
    const right = (await rectOf(s.page, '[data-region-guide="right"]'))!;
    const stick = (await rectOf(s.page, ".joystick-move-base"))!;
    const attack = (await rectOf(s.page, ".joystick-attack-face"))!;
    note("portrait zones", JSON.stringify({ left, right, stick, attack }));
    await s.page.screenshot({ path: join(SHOTS, "hud-portrait-layout.png") });
    expect(Math.abs(right.w - left.w), "same width").toBeLessThanOrEqual(0.5);
    expect(Math.abs(right.h - left.h), "same height").toBeLessThanOrEqual(0.5);
    expect(Math.abs(right.b - left.b), "same bottom").toBeLessThanOrEqual(0.5);
    expect(Math.abs(left.l - (portrait.width - right.r)), "mirrored about the vertical centre line").toBeLessThanOrEqual(0.5);
    const cx = (r: R): number => (r.l + r.r) / 2;
    const cy = (r: R): number => (r.t + r.b) / 2;
    expect(Math.abs(cx(stick) - cx(left))).toBeLessThanOrEqual(2);
    expect(Math.abs(cy(stick) - cy(left))).toBeLessThanOrEqual(2);
    expect(Math.abs(cx(attack) - cx(right))).toBeLessThanOrEqual(2);
    expect(Math.abs(cy(attack) - cy(right))).toBeLessThanOrEqual(2);
    // No overlap with the bottom bar or any hotbar slot.
    const bar = (await rectOf(s.page, ".phone-bottom-bar"))!;
    for (const z of [left, right]) expect(z.b, "zone stops at the bar").toBeLessThanOrEqual(bar.t + 0.5);
    const slots = await s.page.evaluate(() => Array.from(document.querySelectorAll(".ash-hotbar-slot")).map((e) => { const b = e.getBoundingClientRect(); return { b: b.bottom, l: b.left, r: b.right }; }));
    for (const slot of slots) for (const z of [left, right]) if (slot.r > z.l && slot.l < z.r) expect(slot.b, "slot above the zone").toBeLessThanOrEqual(z.t + 0.5);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});
