/**
 * Raster smooth (docs/plans/raster-smooth.md), end to end in headless Chromium at an iPhone-like viewport, on a production build:
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41800 pnpm exec playwright test --config playwright-full-app.config.ts rasterSmooth
 *
 * While walking, the position MapLibre really draws an OSM raster tile at (the projection data the raster pass asks for, so the
 * pixel-aligned matrix when alignment is on) is compared with the true projection of that tile's corner. Unaligned, the residual is
 * constant (sub-pixel smooth). Aligned (stock MapLibre), it saws over about a pixel as the camera moves in sub-pixel steps.
 * Also: static overlay redraws stay far below one per frame while following, and a drag and a zoom still move the camera.
 */
import { expect, test, chromium, type Browser } from "@playwright/test";
import { launch, note, baseUrl } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend");
test.describe.configure({ mode: "serial", timeout: 300_000 });

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist"] : [] }); });
test.afterAll(async () => { await browser?.close(); });

const PORTRAIT = { width: 393, height: 852 };

const INSTALL_PROBE = `(() => {
  const m = window.__e2eMap;
  const t = m.painter.transform;
  const rp = window.__rp = { on: false, frames: [], pending: new Map() };
  if (!t.__rpHooked) {
    t.__rpHooked = true;
    const orig = t.getProjectionData.bind(t);
    t.getProjectionData = (params) => {
      const d = orig(params);
      if (rp.on && typeof params.aligned === "boolean" && params.overscaledTileID && d.projectionTransition === 0) {
        const c = params.overscaledTileID.canonical;
        const k = c.z + "/" + c.x + "/" + c.y;
        if (!rp.pending.has(k)) rp.pending.set(k, { z: c.z, x: c.x, y: c.y, aligned: params.aligned, clip: [d.mainMatrix[12], d.mainMatrix[13], d.mainMatrix[15]] });
      }
      return d;
    };
    m.on("render", () => {
      if (!rp.on) { rp.pending.clear(); return; }
      const W = m.getCanvas().clientWidth, H = m.getCanvas().clientHeight;
      for (const [k, e] of rp.pending) {
        const n = 2 ** e.z;
        const lng = e.x / n * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * e.y / n))) * 180 / Math.PI;
        const p = m.project([lng, lat]);
        const rx = (e.clip[0] / e.clip[2] * 0.5 + 0.5) * W;
        const ry = (1 - (e.clip[1] / e.clip[2] * 0.5 + 0.5)) * H;
        rp.frames.push({ k, aligned: e.aligned, dx: rx - p.x, dy: ry - p.y });
      }
      rp.pending.clear();
    });
  }
})()`;

type Residual = { k: string; aligned: boolean; dx: number; dy: number };

/** Largest residual range (max - min, per axis) of any one tile over the window, and how many frames were drawn aligned. */
function residualRange(frames: Residual[]): { range: number; tiles: number; alignedFrames: number; frames: number } {
  const byTile = new Map<string, Residual[]>();
  for (const f of frames) { const l = byTile.get(f.k) ?? []; l.push(f); byTile.set(f.k, l); }
  let range = 0; let tiles = 0;
  for (const list of byTile.values()) {
    if (list.length < 30) continue;
    tiles += 1;
    const xs = list.map((f) => f.dx); const ys = list.map((f) => f.dy);
    range = Math.max(range, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  }
  return { range, tiles, alignedFrames: frames.filter((f) => f.aligned).length, frames: frames.length };
}

test("raster tiles are drawn sub-pixel smooth while walking; stock alignment saws; redraws stay low; drag and zoom work", async () => {
  const { ctx, s } = await launch(browser, "raster-smooth", { viewport: PORTRAIT, joystick: true, dpr: 3, storage: { "ashAtlas.floatingSticks.v1": "0" } });
  const reports: Array<{ kind: string; report: Record<string, unknown> }> = [];
  await s.page.route("**/api/diagnostics/motion", async (route) => {
    try { reports.push(JSON.parse(route.request().postData() ?? "{}")); } catch { /* ignore */ }
    await route.fulfill({ status: 204 });
  });
  try {
    const gotIt = s.page.getByRole("button", { name: "Got it" });
    if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
    await s.page.getByRole("button", { name: /Tap to center the map on you/ }).first().tap({ timeout: 8000 }).catch(() => undefined);
    await s.page.waitForTimeout(1500);
    await s.page.evaluate(INSTALL_PROBE);

    const walk = async (key: string, ms: number) => {
      await s.page.keyboard.down(key);
      await s.page.waitForTimeout(800);
      await s.page.evaluate(() => { const rp = (window as any).__rp; rp.frames.length = 0; rp.on = true; });
      await s.page.waitForTimeout(ms);
      const frames = await s.page.evaluate(() => { const rp = (window as any).__rp; rp.on = false; return rp.frames as Residual[]; });
      await s.page.keyboard.up(key);
      await s.page.waitForTimeout(600);
      return residualRange(frames);
    };

    // Default (auto): unaligned, smooth. The first walk also carries the motion report's session sample.
    const auto = await walk("d", 9_000);
    note("auto", JSON.stringify(auto));
    expect(auto.tiles, "raster tiles were sampled").toBeGreaterThan(0);
    expect(auto.alignedFrames, "no aligned raster frames while following").toBe(0);
    expect(auto.range, "raster residual stays constant (px)").toBeLessThan(0.05);

    await expect.poll(() => reports.length, { timeout: 5_000 }).toBeGreaterThan(0);
    const rep = reports[0]!.report;
    note("motion report", JSON.stringify(rep));
    for (const key of ["maplibreVersion", "rasterAlignMode", "rasterAlignedRenders", "rasterUnalignedRenders", "rasterLastRenderMoving", "rasterLastRenderAligned", "cameraMinZoom", "cameraMaxZoom", "staticFollow", "cameraSnap", "overlayWalk", "staticOverlayRedrawsPerSec", "maxStaticOverlayDrawMs", "dynamicOverlayUpdateMsPerFrame", "pixiRenderCallMsPerFrame", "gameAppRendersPerSec", "eventLoopLagMs"]) {
      expect(rep, `report has ${key}`).toHaveProperty(key);
    }
    expect(rep.maplibreVersion).toBe("5.24.0");
    expect(rep.rasterAlignMode).toBe("auto");
    expect(rep.staticFollow).toBe("freeze");
    expect(Number(rep.staticOverlayRedrawsPerSec), "static redraws while following are far below the frame rate").toBeLessThan(15);

    // Stock MapLibre ("on"): the raster saws with the pixel alignment (reproduces the bug; proves the probe sees it).
    await s.page.evaluate(() => { (window as any).__ASH_ATLAS_RASTER_ALIGNMENT__.mode = "on"; });
    const stock = await walk("a", 4_000);
    note("stock", JSON.stringify(stock));
    expect(stock.alignedFrames, "stock MapLibre aligns during the follow").toBeGreaterThan(0);
    expect(stock.range, "aligned raster residual saws over a fraction of a pixel or more").toBeGreaterThan(0.2);
    await s.page.evaluate(() => { (window as any).__ASH_ATLAS_RASTER_ALIGNMENT__.mode = "auto"; });

    // The other switches walk without errors (A/B readout only).
    await s.page.evaluate(() => { const f = (window as any).__ASH_ATLAS_FOLLOW_SWITCHES__; f.cameraSnap = "device"; f.staticFollow = "off"; });
    note("snap+rebuild", JSON.stringify(await walk("d", 3_000)));
    await s.page.evaluate(() => { const f = (window as any).__ASH_ATLAS_FOLLOW_SWITCHES__; f.cameraSnap = "off"; f.staticFollow = "freeze"; f.overlayWalk = "hidden"; });
    note("overlay hidden", JSON.stringify(await walk("a", 3_000)));
    await s.page.evaluate(() => { (window as any).__ASH_ATLAS_FOLLOW_SWITCHES__.overlayWalk = "off"; });
    await s.page.waitForTimeout(500);
    expect(await s.page.evaluate(() => (document.querySelector("canvas.game-pixi-overlay") as HTMLCanvasElement).style.visibility), "overlay canvas is visible again").toBe("");

    // Drag and zoom still move the camera.
    const before = await s.page.evaluate(() => { const m = (window as any).__e2eMap; const c = m.getCenter(); return { lng: c.lng, lat: c.lat, zoom: m.getZoom() }; });
    await s.page.mouse.move(200, 400); await s.page.mouse.down(); await s.page.mouse.move(120, 330, { steps: 8 }); await s.page.mouse.up();
    await s.page.waitForTimeout(400);
    const dragged = await s.page.evaluate(() => { const c = (window as any).__e2eMap.getCenter(); return { lng: c.lng, lat: c.lat }; });
    expect(Math.hypot(dragged.lng - before.lng, dragged.lat - before.lat), "a drag pans the map").toBeGreaterThan(1e-6);
    await s.page.mouse.move(196, 426);
    await s.page.mouse.wheel(0, 400);
    await s.page.waitForTimeout(400);
    const zoomed = await s.page.evaluate(() => (window as any).__e2eMap.getZoom());
    expect(Math.abs(zoomed - before.zoom), "a wheel zoom changes the zoom").toBeGreaterThan(0.05);
  } finally { s.save(); await ctx.close(); }
});
