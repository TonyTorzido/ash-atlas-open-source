/**
 * Quickslots while moving: a real two-finger CDP touch. Finger 1 holds the joystick and keeps walking, finger 2 taps a
 * hotbar slot (the slot reacts: it opens its picker, or uses its item) while the stick keeps steering and the camera follows.
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41201 pnpm exec playwright test --config playwright-full-app.config.ts quickslotsWhileMoving
 */
import { expect, test, chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { launch, note, baseUrl, type Session } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend with action combat on");
test.describe.configure({ mode: "serial", timeout: 240_000 });

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : [] }); });
test.afterAll(async () => { await browser?.close(); });

const SAI = { top: 0, right: 59, bottom: 21, left: 59 };

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
  private send(type: "touchStart" | "touchMove" | "touchEnd", only?: number): Promise<unknown> {
    const points = only === undefined ? [...this.down.entries()] : [[only, this.down.get(only)!] as const];
    return this.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([id, p]) => ({ id, x: p.x, y: p.y })) });
  }
  async start(id: number, x: number, y: number): Promise<void> { this.down.set(id, { x, y }); await this.send("touchStart"); }
  async move(id: number, x: number, y: number): Promise<void> { this.down.set(id, { x, y }); await this.send("touchMove"); }
  async end(id: number): Promise<void> { await this.send("touchEnd", id); this.down.delete(id); }
}

const centreOf = async (page: Page, sel: string): Promise<{ x: number; y: number }> => {
  const b = (await page.locator(sel).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const playerOffset = (page: Page): Promise<number | null> => page.evaluate(() => (window as any).__ASH_ATLAS_PLAYER_CAMERA__?.playerOffsetPx ?? null);

for (const [name, viewport, insets] of [["portrait", { width: 390, height: 844 }, false], ["landscape", { width: 932, height: 430 }, true]] as const) {
  test(`a quickslot tap works while the stick is held and the player walks (${name})`, async () => {
    const { ctx, s } = await boot(`qs-${name}`, viewport, insets);
    try {
      const fingers = new Fingers(await ctx.newCDPSession(s.page));
      const stick = await centreOf(s.page, ".joystick-move-base");
      // An empty, unlocked quickslot on the left rail: tapping it opens its item picker, a reaction we can observe without an item.
      const slots = await s.page.evaluate(() => Array.from(document.querySelectorAll(".ash-hotbar-rail-left .ash-hotbar-slot.unlocked.empty")).map((e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, label: e.getAttribute("data-hotbar-slot") ?? "" }; }));
      expect(slots.length).toBeGreaterThan(0);
      const slot = slots.reduce((low, c) => (c.y > low.y ? c : low));

      // Hold the stick and walk.
      await fingers.start(1, stick.x, stick.y);
      await fingers.move(1, stick.x + 42, stick.y);
      await s.page.waitForTimeout(500);
      const mark = s.mark();
      const walkingFrames = (): number => s.since(mark, undefined, "out").filter((f) => /MOVE/.test(f.type)).length;
      await s.page.waitForTimeout(500);
      const before = walkingFrames();
      expect(before, "the player is walking before the tap").toBeGreaterThan(0);
      expect(await s.page.evaluate(() => (window as any).__ASH_ATLAS_PLAYER_CAMERA__?.phase)).toBe("following");

      // Second finger taps the slot.
      await s.page.evaluate((id) => {
        const w = window as any;
        w.__slotClicks = 0;
        document.addEventListener("click", (e) => { if ((e.target as Element | null)?.closest(`[data-hotbar-slot="${id}"]`)) w.__slotClicks += 1; }, true);
      }, slot.label);
      await fingers.start(2, slot.x, slot.y);
      await s.page.waitForTimeout(80);
      await fingers.end(2);
      await s.page.waitForTimeout(400);
      const clicked = await s.page.evaluate(() => (window as any).__slotClicks as number);
      const picker = await s.page.locator(".ash-hotbar-picker").count();
      note("slot tap", JSON.stringify({ name, slot: slot.label, clicked, pickerOpen: picker }));
      // The browser sends no click for a tap made while another finger is down; the slot must still react (pointerup).
      expect(picker, "the slot reacted to the second-finger tap").toBe(1);

      // Movement was not interrupted: the stick finger still steers and the camera still follows.
      await fingers.move(1, stick.x + 42, stick.y + 30);
      await s.page.waitForTimeout(700);
      expect(walkingFrames() - before, "MOVE frames kept flowing after the tap").toBeGreaterThan(3);
      expect(await s.page.evaluate(() => (window as any).__ASH_ATLAS_PLAYER_CAMERA__?.phase)).toBe("following");
      expect(await playerOffset(s.page)).toBeLessThan(12);
      await fingers.end(1);
    } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
  });
}
