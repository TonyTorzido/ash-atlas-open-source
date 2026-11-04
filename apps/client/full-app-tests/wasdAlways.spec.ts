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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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

test("WASD, typing guard, Space dash and hidden stick with no stored preference", async () => {
  const page = await boot();
  expect(await page.evaluate(() => localStorage.getItem("ashAtlas.joystickMovement.v1")), "no joystick preference stored").toBeNull();
  await expect(page.locator(".joystick-move")).toHaveCount(0);
  await page.locator("canvas.maplibregl-canvas").first().hover(); // focus stays on the page body, not a control

  const w = await holdKey(page, "w");
  expect(w.targets.length, "W sent MOVE_TO").toBeGreaterThan(0);
  const northest = Math.max(...w.targets.map((t) => t.lat));
  console.log("W", w.start, "farthest north target", northest);
  expect(northest - w.start.lat, "W moves north").toBeGreaterThan(0.0005);

  const d = await holdKey(page, "d");
  expect(d.targets.length, "D sent MOVE_TO").toBeGreaterThan(0);
  const eastest = Math.max(...d.targets.map((t) => t.lon));
  console.log("D", d.start, "farthest east target", eastest);
  expect(eastest - d.start.lon, "D moves east").toBeGreaterThan(0.0005);

  // The chat composer is gated behind the community rules for a fresh character, so focus a text field that is always
  // available (a plain input over the map): the guard under test is "focus is in a text field", not which field.
  await page.evaluate(() => { const i = document.createElement("input"); i.id = "wasd-typing-probe"; i.style.cssText = "position:fixed;left:20px;bottom:20px;z-index:99999"; document.body.appendChild(i); });
  const box = page.locator("#wasd-typing-probe");
  await box.click();
  const mark = await sentCount(page, "MOVE_TO");
  await page.keyboard.type("wasd wasd", { delay: 60 });
  await page.keyboard.down("w"); await page.waitForTimeout(600); await page.keyboard.up("w");
  expect(await sentCount(page, "MOVE_TO"), "typing in a text field sends no movement").toBe(mark);
  await box.fill("");
  await page.evaluate(() => document.getElementById("wasd-typing-probe")?.remove());
  await page.locator("canvas.maplibregl-canvas").first().hover();

  await reanchor(page); // a dash right after the walks above could be clipped by the leash
  const dashMark = await sentCount(page, "DASH");
  await page.keyboard.press("Space");
  await expect.poll(() => sentCount(page, "DASH"), { timeout: 4000 }).toBeGreaterThan(dashMark);

  await expect(page.locator(".joystick-move")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Dash" })).toHaveCount(0);
  await page.context().close();
});
