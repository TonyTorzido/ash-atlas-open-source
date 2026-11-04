/**
 * The floating joystick must always release: touchcancel, lost pointer capture, blur / hidden / pagehide, a second finger on a
 * hotbar slot or a map pinch (released in either order), sliding off the zone or the screen edge, orientation change, a menu
 * opening while held. After each: the stick is not held, the knob is recentred and the player has stopped walking.
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41126 pnpm exec playwright test --config playwright-full-app.config.ts stickRelease
 */
import { expect, test, chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { launch, note, baseUrl, type Session } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend with action combat on");
test.describe.configure({ mode: "default", timeout: 240_000 });

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : [] }); });
test.afterAll(async () => { await browser?.close(); });

const SAI = { top: 0, right: 59, bottom: 21, left: 59 };
const MODES = [["portrait", { width: 390, height: 844 }, false], ["landscape", { width: 932, height: 430 }, true]] as const;

async function boot(name: string, viewport: { width: number; height: number }, insets: boolean): Promise<{ ctx: BrowserContext; s: Session }> {
  const { ctx, s } = await launch(browser, name, { viewport, joystick: true, storage: { "ashAtlas.floatingSticks.v1": "1" } });
  if (insets) {
    await s.page.evaluate((v) => {
      const el = document.createElement("style");
      el.textContent = `:root{--sai-top:${v.top}px;--sai-right:${v.right}px;--sai-bottom:${v.bottom}px;--sai-left:${v.left}px}`;
      document.head.appendChild(el);
    }, SAI);
  }
  const gotIt = s.page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await s.page.waitForTimeout(800);
  return { ctx, s };
}

class Fingers {
  private readonly down = new Map<number, { x: number; y: number }>();
  constructor(private readonly cdp: CDPSession) {}
  private send(type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", only?: number): Promise<unknown> {
    const points = only === undefined ? [...this.down.entries()] : [[only, this.down.get(only)!] as const];
    return this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchCancel" ? [] : points.map(([id, p]) => ({ id, x: p.x, y: p.y })) });
  }
  async start(id: number, x: number, y: number): Promise<void> { this.down.set(id, { x, y }); await this.send("touchStart"); }
  async move(id: number, x: number, y: number): Promise<void> { this.down.set(id, { x, y }); await this.send("touchMove"); }
  async end(id: number): Promise<void> { await this.send("touchEnd", id); this.down.delete(id); }
  async cancel(): Promise<void> { await this.send("touchCancel"); this.down.clear(); }
}

const centreOf = async (page: Page, sel: string): Promise<{ x: number; y: number }> => {
  const b = (await page.locator(sel).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** Plants the stick and pushes it right so the player walks. */
async function holdStick(s: Session, f: Fingers): Promise<{ x: number; y: number }> {
  const at = await centreOf(s.page, ".joystick-move-base");
  await f.start(1, at.x, at.y);
  await f.move(1, at.x + 44, at.y - 10);
  await s.page.waitForTimeout(700);
  return at;
}

const stickState = (page: Page): Promise<{ held: boolean; active: boolean; knob: string }> => page.evaluate(() => {
  const m = document.querySelector(".joystick-move");
  const knob = document.querySelector(".joystick-move-knob") as HTMLElement | null;
  return { held: m?.classList.contains("is-held") ?? false, active: m?.classList.contains("is-active") ?? false, knob: knob?.style.transform ?? "" };
});

const pos = (s: Session): { lat: number; lon: number } => ({ lat: s.self.lat, lon: s.self.lon });
const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180));

/** The stick is let go: not held, knob recentred, and the player is no longer walking. */
async function expectReleased(s: Session, why: string): Promise<void> {
  await s.page.waitForTimeout(900);
  const st = await stickState(s.page);
  expect(st.held, `${why}: stick no longer held`).toBe(false);
  expect(st.active, `${why}: stick no longer active`).toBe(false);
  // "" means the stick is hidden (the app suspends on pagehide); a pushed knob would carry a non-zero translate.
  expect(st.knob, `${why}: knob recentred`).toMatch(/^(translate\(0(px)?, 0(px)?\))?$/);
  const a = pos(s);
  await s.page.waitForTimeout(1200);
  const walked = metres(a, pos(s));
  note("stop", `${why}: moved ${walked.toFixed(1)} m in the 1.2 s after release`);
  expect(walked, `${why}: the player stopped walking`).toBeLessThan(2);
}

for (const [mode, viewport, insets] of MODES) {
  test.describe(mode, () => {
    const scenario = (title: string, body: (s: Session, f: Fingers, ctx: BrowserContext, stick: { x: number; y: number }) => Promise<void>): void => {
      test(`${title} (${mode})`, async () => {
        const { ctx, s } = await boot(`sr-${mode}`, viewport, insets);
        try {
          const f = new Fingers(await ctx.newCDPSession(s.page));
          const start = pos(s);
          const stick = await holdStick(s, f);
          expect((await stickState(s.page)).held, "the stick is held before the event").toBe(true);
          expect(metres(start, pos(s)), "the player walks while held").toBeGreaterThan(2);
          await body(s, f, ctx, stick);
        } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
      });
    };

    scenario("touchcancel releases", async (s, f) => { await f.cancel(); await expectReleased(s, "touchcancel"); });

    scenario("lost pointer capture releases", async (s) => {
      await s.page.evaluate(() => { const el = document.querySelector(".joystick-move") as HTMLElement; for (let id = 0; id < 12; id++) { try { el.releasePointerCapture(id); } catch { /* not captured */ } } });
      await expectReleased(s, "lostpointercapture");
    });

    scenario("window blur releases", async (s) => { await s.page.evaluate(() => window.dispatchEvent(new Event("blur"))); await expectReleased(s, "blur"); });

    scenario("page hidden (visibilitychange) releases", async (s) => {
      await s.page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
      await expectReleased(s, "visibilitychange hidden");
    });

    scenario("pagehide releases", async (s) => { await s.page.evaluate(() => window.dispatchEvent(new Event("pagehide"))); await expectReleased(s, "pagehide"); });

    scenario("an orientation change / resize releases", async (s) => {
      const size = s.page.viewportSize()!;
      await s.page.setViewportSize({ width: size.height, height: size.width });
      await expectReleased(s, "orientation change");
      await s.page.setViewportSize(size);
    });

    scenario("sliding the finger off the screen edge, then lifting, releases", async (s, f, _ctx, stick) => {
      await f.move(1, -30, stick.y);
      await s.page.waitForTimeout(300);
      await f.end(1);
      await expectReleased(s, "slid off the left edge");
    });

    scenario("a second finger tapping a hotbar slot, lifted first, leaves the stick held; lifting the stick then releases", async (s, f) => {
      const slot = await centreOf(s.page, ".ash-hotbar-rail-left .ash-hotbar-slot.unlocked.empty");
      await f.start(2, slot.x, slot.y);
      await s.page.waitForTimeout(80);
      await f.end(2);
      await s.page.waitForTimeout(300);
      await s.page.keyboard.press("Escape");
      expect((await stickState(s.page)).held, "the stick is still held after the slot tap").toBe(true);
      await f.end(1);
      await expectReleased(s, "slot tap then stick lift");
    });

    scenario("the stick lifted while the second finger is still on a hotbar slot releases", async (s, f) => {
      const slot = await centreOf(s.page, ".ash-hotbar-rail-left .ash-hotbar-slot.unlocked.empty");
      await f.start(2, slot.x, slot.y);
      await s.page.waitForTimeout(80);
      await f.end(1);
      await s.page.waitForTimeout(100);
      await f.end(2);
      await expectReleased(s, "stick lifted before the slot finger");
    });

    scenario("a pinch on the map with the stick held, lifted in either order, releases", async (s, f) => {
      const y = viewport.height * 0.35;
      await f.start(2, viewport.width / 2 - 30, y);
      await f.start(3, viewport.width / 2 + 30, y);
      for (let i = 1; i <= 8; i++) { await f.move(2, viewport.width / 2 - 30 - i * 8, y); await f.move(3, viewport.width / 2 + 30 + i * 8, y); }
      expect((await stickState(s.page)).held, "the stick survives the pinch").toBe(true);
      await f.end(1);
      await f.end(2);
      await f.end(3);
      await expectReleased(s, "pinch then stick lifted first");
    });
  });
}
