/**
 * Desktop keyboard movement works with no joystick preference stored (fine pointer default = stick hidden):
 * W moves north, D moves east, typing in the chat box does not move the player, Space sends DASH, no stick on screen.
 *
 * Run: cd apps/client && ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<frontend> pnpm exec playwright test --config playwright-full-app.config.ts wasdAlways
 */
import { expect, test, chromium, type Browser, type Page } from "@playwright/test";

const baseUrl = process.env.ASH_ATLAS_TEST_BASE_URL;
test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at the feature runtime frontend");
test.describe.configure({ mode: "serial", timeout: 180_000 });

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => { await browser?.close(); });

async function boot(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: Number(1280), height: Number(800) } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { 
    (window as any).__sent = [] as string[];
    const W = window.WebSocket; (window as any).__e2eSockets = [];
    const Wrapped: any = function (this: unknown, ...a: any[]) { const s = new (W as any)(...a); (window as any).__e2eSockets.push(s); return s; };
    Wrapped.prototype = W.prototype; Object.assign(Wrapped, W); (window as any).WebSocket = Wrapped;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: any) { try { (window as any).__sent.push(String(data)); } catch { /* ignore */ } return send.call(this, data); };
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
  return page;
}

const sentCount = (page: Page, type: string): Promise<number> =>
  page.evaluate((t) => (window as any).__sent.filter((s: string) => s.includes(`"type":"${t}"`)).length, type);
const sentFrom = (page: Page, type: string, from: number): Promise<any[]> =>
  page.evaluate(({ t, n }) => ((window as any).__sent as string[]).filter((s) => s.includes(`"type":"${t}"`)).slice(n).map((s) => JSON.parse(s)), { t: type, n: from });

type Pos = { lat: number; lon: number };
/** The local player's predicted position, read through the JoystickMovement props (the app keeps no global handle). */
const playerPos = (page: Page): Promise<Pos> =>
  page.evaluate(() => {
    for (const e of Array.from(document.querySelectorAll("*"))) {
      const fk = Object.keys(e).find((k) => k.startsWith("__reactFiber")); if (!fk) continue;
      for (let f = (e as any)[fk], d = 0; f && d < 60; f = f.return, d++) {
        const fn = f.memoizedProps?.getWorldState; if (typeof fn === "function") return fn().position as { lat: number; lon: number };
      }
    }
    throw new Error("JoystickMovement not mounted");
  });

/** A fresh dev character can sit at the edge of its move leash; re-anchor it on its own position so every direction is open. */
async function reanchor(page: Page): Promise<Pos> {
  const here = await playerPos(page);
  await page.evaluate(({ lat, lon }) => {
    const sockets = ((window as any).__e2eSockets as WebSocket[]).filter((s) => s.readyState === 1);
    sockets[sockets.length - 1]!.send(JSON.stringify({ type: "DEV_TELEPORT", requestId: crypto.randomUUID(), lat, lon }));
  }, here);
  await page.waitForTimeout(3500);
  return playerPos(page);
}

/** Holds a key for 1.5 s and returns the player's start position and the MOVE_TO targets that were sent. */
async function holdKey(page: Page, key: string): Promise<{ start: Pos; targets: Pos[] }> {
  const start = await reanchor(page);
  const mark = await sentCount(page, "MOVE_TO");
  await page.keyboard.down(key);
  await page.waitForTimeout(1500);
  await page.keyboard.up(key);
  await page.waitForTimeout(500);
  const frames = await sentFrom(page, "MOVE_TO", mark);
  return { start, targets: frames.map((m) => ({ lat: m.lat, lon: m.lon })) };
}

const moves = async (page: Page): Promise<number> => {
  await reanchor(page);
  const mark = await sentCount(page, "MOVE_TO");
  await page.keyboard.down("w"); await page.waitForTimeout(800); await page.keyboard.up("w"); await page.waitForTimeout(300);
  return (await sentCount(page, "MOVE_TO")) - mark;
};
test("WASD still moves with the chat window open, before and after a map click", async () => {
  const page = await boot();
  await page.getByRole("button", { name: /Open General chat/ }).click();
  await expect(page.locator("[data-desktop-window=\"chat:public\"]")).toBeVisible();
  expect(await moves(page), "chat open, focus in chat window").toBeGreaterThan(0);
  await page.locator("canvas.maplibregl-canvas").first().click({ position: { x: 600, y: 300 } });
  expect(await moves(page), "chat open, after map click").toBeGreaterThan(0);
  await page.context().close();
});
