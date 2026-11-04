/**
 * Ground-scale camera: teleport to many latitudes, recenter, and check that the camera zoom equals
 * cameraZoomForGroundZoom(15, lat), that the local player sprite height and the 500 m gameplay circle radius are
 * within 1% of their equator values (desktop and phone), that recenter and zoom-out work at 85 degrees, and that
 * a joystick walk holds the ground zoom.
 *
 * Run: cd apps/client && ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<frontend> pnpm exec playwright test --config playwright-full-app.config.ts groundScaleCamera
 * Optional: ASH_ATLAS_E2E_OUT (screenshots + numbers; default <tmpdir>/ground-scale-camera-e2e)
 */
import { expect, test, chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = process.env.ASH_ATLAS_TEST_BASE_URL;
const outDir = process.env.ASH_ATLAS_E2E_OUT ?? join(tmpdir(), "ground-scale-camera-e2e");
mkdirSync(outDir, { recursive: true });
test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at the feature runtime frontend");
test.describe.configure({ mode: "serial", timeout: 360_000 });

const cameraZoomFor = (ground: number, lat: number): number =>
  ground - Math.log2(1 / Math.max(0.01, Math.cos((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180)));

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => { await browser?.close(); });

/** Finds the live maplibre map and the Pixi overlay through React's fibers (the app keeps no global handle). */
async function findHandles(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const isMap = (v: any): boolean => v && typeof v === "object" && typeof v.project === "function" && typeof v.getBearing === "function";
    const isOverlay = (v: any): boolean => v && typeof v === "object" && typeof v.localPlayerArtworkHeightPx === "function";
    const seen = new Set<unknown>(); const maps = new Set<any>(); let overlay: any = null;
    const search = (v: any, d: number): void => {
      if (!v || typeof v !== "object" || seen.has(v) || d > 5) return;
      seen.add(v);
      if (isMap(v)) { maps.add(v); return; }
      if (isOverlay(v)) { overlay = v; return; }
      for (const k of Object.keys(v)) { let c; try { c = v[k]; } catch { continue; } search(c, d + 1); }
    };
    for (const e of Array.from(document.querySelectorAll("*"))) {
      const fk = Object.keys(e).find((k) => k.startsWith("__reactFiber")); if (!fk) continue;
      let f = (e as any)[fk]; let depth = 0;
      while (f && depth++ < 400) { let s = f.memoizedState; let n = 0; while (s && typeof s === "object" && n++ < 4000) { search(s.memoizedState, 0); s = s.next; } f = f.return; }
    }
    const live = [...maps].filter((m) => { try { const c = m.getCanvas(); return c.isConnected && c.getBoundingClientRect().width > 0; } catch { return false; } });
    if (overlay) (window as any).__e2eOverlay = overlay;
    // Keep the map found first while it is alive: a pre-warmed world-map instance can also be live.
    const held = (window as any).__e2eMap;
    const heldLive = !!held && live.includes(held);
    if (!heldLive && live[0]) (window as any).__e2eMap = live[0];
    return !!live[0] && !!overlay;
  });
}

type Measure = {
  layout: string; lat: number; centerLat: number; zoom: number; expectedZoom: number; groundZoom: number;
  spritePx: number | null; circlePx: number; minZoom: number; maxZoom: number;
};

async function boot(layout: { name: string; mobile: boolean }, joystick = false): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext(layout.mobile
    ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
    : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.log("pageerror:", e.message.slice(0, 300)); });
  page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text().slice(0, 300)); });
  await page.addInitScript((useJoystick) => {
    const W = window.WebSocket; (window as any).__e2eSockets = [];
    const Wrapped: any = function (this: unknown, ...a: any[]) { const s = new (W as any)(...a); (window as any).__e2eSockets.push(s); return s; };
    Wrapped.prototype = W.prototype; Object.assign(Wrapped, W); (window as any).WebSocket = Wrapped;
    if (useJoystick) { try { localStorage.setItem("ashAtlas.joystickMovement.v1", "1"); } catch { /* ignore */ } }
  }, joystick);
  await page.goto(baseUrl!, { waitUntil: "domcontentloaded" });
  const dev = page.getByRole("button", { name: "Default Dev" });
  await dev.waitFor({ state: "visible", timeout: 20_000 });
  for (let attempt = 0; attempt < 6; attempt++) {
    await dev.click();
    const failed = page.getByText("Authentication service unavailable");
    await page.locator("main.initial-curtain").or(failed).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    if (!(await failed.isVisible().catch(() => false))) break;
    await page.waitForTimeout(10_000);
  }
  await page.locator("main.initial-curtain").waitFor({ state: "detached", timeout: 60_000 });
  await page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(2500);
  const respawn = page.getByRole("button", { name: "Respawn" });
  if (await respawn.isVisible()) { await respawn.click(); await page.waitForTimeout(1500); }
  for (let i = 0; i < 10 && !(await findHandles(page)); i++) await page.waitForTimeout(1000);
  expect(await page.evaluate(() => !!(window as any).__e2eMap && !!(window as any).__e2eOverlay), "found the map and the overlay").toBe(true);
  return { ctx, page, errors };
}

async function teleport(page: Page, lat: number, lon: number): Promise<void> {
  await page.evaluate(({ lat, lon }) => {
    const sockets = ((window as any).__e2eSockets as WebSocket[]).filter((s) => s.readyState === 1);
    sockets[sockets.length - 1]!.send(JSON.stringify({ type: "DEV_TELEPORT", requestId: crypto.randomUUID(), lat, lon }));
  }, { lat, lon });
  await page.waitForTimeout(2500); // a raw socket teleport does not move the camera; Recenter does
}

async function recenter(page: Page): Promise<void> {
  const ok = await page.evaluate(() => {
    // The same handler the Recenter button / vitals gesture calls (props.onRecenter on any fiber).
    for (const e of Array.from(document.querySelectorAll("*"))) {
      const fk = Object.keys(e).find((k) => k.startsWith("__reactFiber")); if (!fk) continue;
      for (let f = (e as any)[fk], d = 0; f && d < 60; f = f.return, d++) {
        const fn = f.memoizedProps?.onRecenter; if (typeof fn === "function") { fn(); return true; }
      }
    }
    return false;
  });
  expect(ok, "found the app's onRecenter handler").toBe(true);
}

async function measure(page: Page, layout: string, lat: number): Promise<Measure> {
  // The sprite is drawn a frame or two after the camera settles.
  await page.waitForFunction(() => (window as any).__e2eOverlay.localPlayerArtworkHeightPx() !== null, undefined, { timeout: 8000 }).catch(() => undefined);
  const m = await page.evaluate(() => {
    const map = (window as any).__e2eMap; const c = map.getCenter();
    // The 500 m gameplay circle exactly as screenRadiusForMeters draws it: geodesic east edge, projected.
    const R = 6371008.8; const d = 500 / R; const phi = (c.lat * Math.PI) / 180; const lam = (c.lng * Math.PI) / 180; const br = Math.PI / 2;
    const phi2 = Math.asin(Math.sin(phi) * Math.cos(d) + Math.cos(phi) * Math.sin(d) * Math.cos(br));
    const lam2 = lam + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(phi), Math.cos(d) - Math.sin(phi) * Math.sin(phi2));
    const a = map.project([c.lng, c.lat]); const b = map.project([(lam2 * 180) / Math.PI, (phi2 * 180) / Math.PI]);
    const offset = Math.log2(1 / Math.max(0.01, Math.cos((Math.max(-85, Math.min(85, c.lat)) * Math.PI) / 180)));
    return {
      zoom: map.getZoom() as number, centerLat: c.lat as number, groundZoom: (map.getZoom() + offset) as number,
      minZoom: map.getMinZoom() as number, maxZoom: map.getMaxZoom() as number,
      circlePx: Math.hypot(b.x - a.x, b.y - a.y) as number, spritePx: (window as any).__e2eOverlay.localPlayerArtworkHeightPx() as number | null
    };
  });
  return { layout, lat, expectedZoom: cameraZoomFor(15, m.centerLat), ...m };
}

const LATS: Array<[number, number]> = [
  [0, 10], [35.0844, -106.6504], [45, 10], [64.1466, -21.9], [70, 20], [78, 15.6], [80, 10], [-80, 10], [84, 10], [85, 10]
];

for (const layout of [{ name: "desktop", mobile: false }, { name: "phone", mobile: true }]) {
  test(`${layout.name}: sprite, 500 m circle and zoom hold at every latitude`, async () => {
    const { ctx, page, errors } = await boot(layout);
    page.on("websocket", (ws) => ws.on("framereceived", (f) => { const raw = String(f.payload); if (raw.includes("TELEPORT")) console.log("tp-frame:", raw.slice(0, 220)); }));
    const rows: Measure[] = [];
    for (const [lat, lon] of LATS) {
      let arrived = false;
      for (let attempt = 0; attempt < 3 && !arrived; attempt++) {
        await teleport(page, lat, lon);
        await recenter(page);
        arrived = await page.waitForFunction(({ lat }) => Math.abs((window as any).__e2eMap.getCenter().lat - lat) < 0.5, { lat }, { timeout: 12_000 }).then(() => true, () => false);
        if (!arrived) console.log(`retry teleport to ${lat} (attempt ${attempt + 1})`);
      }
      await page.waitForTimeout(2500);
      expect(arrived, `camera followed the teleport to ${lat}`).toBe(true);
      const row = await measure(page, layout.name, lat);
      await page.screenshot({ path: join(outDir, `${layout.name}-lat${lat}.png`) });
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    writeFileSync(join(outDir, `${layout.name}-numbers.json`), JSON.stringify(rows, null, 2));
    const base = rows.find((r) => r.lat === 0)!;
    expect(base.spritePx, "sprite drawn at the equator").not.toBeNull();
    for (const r of rows) {
      expect(Math.abs(r.zoom - r.expectedZoom), `getZoom at ${r.lat}`).toBeLessThan(0.01);
      expect(r.spritePx, `sprite drawn at ${r.lat}`).not.toBeNull();
      expect(Math.abs(r.spritePx! / base.spritePx! - 1), `sprite height at ${r.lat}`).toBeLessThan(0.01);
      expect(Math.abs(r.circlePx / base.circlePx - 1), `500 m circle radius at ${r.lat}`).toBeLessThan(0.01);
    }
    // Zoom-out and recenter must still work at the 85 degree edge (the player is at 85 now).
    await page.evaluate(() => { const m = (window as any).__e2eMap; (window as any).__e2eGameMap = m; m.zoomTo(m.getMinZoom(), { duration: 0 }, { originalEvent: new WheelEvent("wheel") }); });
    console.log("immediately", JSON.stringify(await page.evaluate(() => { const m = (window as any).__e2eGameMap; const c = m.getCenter(); return { z: m.getZoom(), lat: c.lat, min: m.getMinZoom(), same: m === (window as any).__e2eMap }; })));
    await page.waitForTimeout(800);
    const out = await page.evaluate(() => {
      const m = (window as any).__e2eGameMap; const c = m.getCenter(); const p = m.project([c.lng, c.lat]); const r = m.getContainer().getBoundingClientRect();
      return { zoom: m.getZoom() as number, minZoom: m.getMinZoom() as number, lat: c.lat as number, connected: m.getCanvas().isConnected as boolean, x: p.x as number, y: p.y as number, w: r.width as number, h: r.height as number };
    });
    console.log("zoomed-out at 85", JSON.stringify(out));
    await page.screenshot({ path: join(outDir, `${layout.name}-lat85-zoomed-out.png`) });
    expect(out.zoom).toBeLessThanOrEqual(out.minZoom + 0.05);
    expect(out.x).toBeGreaterThan(0); expect(out.x).toBeLessThan(out.w);
    expect(out.y).toBeGreaterThan(0); expect(out.y).toBeLessThan(out.h);
    await recenter(page);
    await page.waitForTimeout(2500);
    const back = await measure(page, layout.name, 85);
    console.log("recentered after zoom-out at 85", JSON.stringify(back));
    await page.screenshot({ path: join(outDir, `${layout.name}-lat85-recentered.png`) });
    expect(back.zoom, "recenter at 85 pulls the zoom back in").toBeGreaterThan(out.zoom + 1);
    expect(back.zoom, "recenter at 85 stays at a readable framing").toBeLessThan(cameraZoomFor(15, 85) + 1.5);
    expect(errors).toEqual([]);
    await ctx.close();
  });
}

// The camera no longer follows the player (the old followCamera walk test is gone); proMobileControls.spec.ts asserts the map centre never moves while walking.
test("phone: a real joystick drag walks on land and holds the ground zoom", async () => {
  const { ctx, page, errors } = await boot({ name: "phone", mobile: true }, true);
  const results: unknown[] = [];
  // The first-run mobile tip card sits on top of the stick; dismiss it so the drag reaches the joystick.
  const gotIt = page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) { await gotIt.click(); await page.waitForTimeout(500); }
  for (const place of [{ name: "abq", lat: 35.0844, lon: -106.6504 }, { name: "reykjavik", lat: 64.1466, lon: -21.9426 }]) {
    // A teleport sent right after a walk can land late; retry until the camera is really at the place.
    let before = await measure(page, "phone", place.lat);
    for (let attempt = 0; attempt < 5; attempt++) {
      await teleport(page, place.lat, place.lon);
      await recenter(page);
      await page.waitForTimeout(3000);
      before = await measure(page, "phone", place.lat);
      if (Math.abs(before.centerLat - place.lat) < 0.01) break;
    }
    expect(Math.abs(before.centerLat - place.lat), `teleported to ${place.name}`).toBeLessThan(0.01);
    const stick = page.getByRole("application", { name: "Movement joystick" });
    await stick.waitFor({ state: "visible", timeout: 10_000 });
    const box = (await stick.boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    // Drag the on-screen stick up (north) and hold it for ~2 s, sampling the ground zoom while walking.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - box.height * 0.45, { steps: 5 });
    const walkGround: number[] = [];
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(250);
      walkGround.push(await page.evaluate(() => {
        const m = (window as any).__e2eMap; const c = m.getCenter();
        return m.getZoom() + Math.log2(1 / Math.cos((c.lat * Math.PI) / 180));
      }));
    }
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const after = await measure(page, "phone", place.lat);
    const movedM = (after.centerLat - before.centerLat) * 111_320;
    const result = { place: place.name, beforeLat: before.centerLat, afterLat: after.centerLat, movedM, groundBefore: before.groundZoom, groundAfter: after.groundZoom, walkGround };
    console.log(JSON.stringify(result));
    results.push(result);
    await page.screenshot({ path: join(outDir, `phone-joystick-${place.name}.png`) });
    expect(movedM, `the joystick walked the player north at ${place.name}`).toBeGreaterThan(5);
    expect(Math.abs(after.groundZoom - 15), `ground zoom held after the walk at ${place.name}`).toBeLessThan(0.02);
    for (const g of walkGround) expect(Math.abs(g - 15), `ground zoom held while walking at ${place.name}`).toBeLessThan(0.02);
  }
  writeFileSync(join(outDir, "phone-joystick-land.json"), JSON.stringify(results, null, 2));
  expect(errors).toEqual([]);
  await ctx.close();
});
