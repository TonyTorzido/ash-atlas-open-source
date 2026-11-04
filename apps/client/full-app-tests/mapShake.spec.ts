/**
 * Map shake (docs/plans/map-shake.md), end to end in headless Chromium at an iPhone-like viewport against a feature runtime.
 * Run it on a production build (the dev server is too slow for frame checks):
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41717 pnpm exec playwright test --config playwright-full-app.config.ts mapShake
 *
 * The local player's authoritative position is made jittery on purpose: a simulated phone network (80 ms RTT, +-25 ms jitter)
 * and every second PLAYER_DELTA for the local player pulled back 1.2 m along its walk (a server snap the prediction must
 * absorb). While walking straight the camera must never step backwards; the motion report must reach the server.
 */
import { expect, test, chromium, type Browser } from "@playwright/test";
import { launch, note, baseUrl } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const PORTRAIT = { width: 393, height: 852 };

/** Rewrites PLAYER_DELTA for the local player (id from WELCOME) while window.__snapInject is on. */
const SNAP_INJECTOR = `(() => {
  const desc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
  const cache = new WeakMap();
  let selfId = null; let n = 0;
  window.__snapInjected = 0;
  const back = (lat, lon, tLat, tLon, m) => {
    const dy = (tLat - lat) * 110574, dx = (tLon - lon) * 111320 * Math.cos(lat * Math.PI / 180);
    const d = Math.hypot(dx, dy); if (d < 0.5) return null;
    return { lat: lat - (dy / d) * m / 110574, lon: lon - (dx / d) * m / (111320 * Math.cos(lat * Math.PI / 180)) };
  };
  Object.defineProperty(MessageEvent.prototype, "data", { configurable: true, get() {
    const raw = desc.get.call(this);
    if (typeof raw !== "string") return raw;
    if (cache.has(this)) return cache.get(this);
    let out = raw;
    if (raw.startsWith('{"type":"WELCOME"')) { try { selfId = JSON.parse(raw).playerId; } catch {} }
    else if (window.__snapInject && selfId && raw.startsWith('{"type":"PLAYER_DELTA"')) {
      try {
        const msg = JSON.parse(raw);
        for (const u of msg.upserts) {
          if (u.kind === "full" || u.playerId !== selfId || u.targetLat == null) continue;
          if ((n++ % 2) !== 1) continue;
          const p = back(u.lat, u.lon, u.targetLat, u.targetLon, 1.2);
          if (p) { u.lat = p.lat; u.lon = p.lon; window.__snapInjected++; }
        }
        out = JSON.stringify(msg);
      } catch {}
    }
    cache.set(this, out);
    return out;
  } });
})();`;

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : [] }); });
test.afterAll(async () => { await browser?.close(); });

type Probe = { kind: string; t: number; ax: number; ay: number };

/** Camera steps (map render to map render) while moving, and their direction flips along the overall walk axis. */
function cameraReversals(samples: Probe[]): { steps: number; reversals: number; backSteps: number } {
  const maps = samples.filter((x) => x.kind === "m");
  const steps: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < maps.length; i++) steps.push({ x: maps[i]!.ax - maps[i - 1]!.ax, y: maps[i]!.ay - maps[i - 1]!.ay });
  // Stop where the walk ends (it hit water or a wall): the first run of 5 steps under a quarter of the cruising speed. That
  // also covers the camera easing to a halt, whose small settle step is not a walking reversal (the filter lets go of its
  // movement axis below axisMinPxS).
  const cruise = steps.slice(0, 30).map((s) => Math.hypot(s.x, s.y)).sort((a, b) => a - b)[15] ?? 0;
  const still = Math.max(0.05, cruise * 0.25);
  let end = steps.length;
  for (let i = 0; i + 5 < steps.length; i++) if (steps.slice(i, i + 5).every((s) => Math.hypot(s.x, s.y) < still)) { end = i; break; }
  const moving = steps.slice(0, end);
  const sum = moving.reduce((a, s) => ({ x: a.x + s.x, y: a.y + s.y }), { x: 0, y: 0 });
  const len = Math.hypot(sum.x, sum.y) || 1;
  const axis = { x: sum.x / len, y: sum.y / len };
  let last = 0; let reversals = 0; let backSteps = 0;
  for (const s of moving) {
    const along = s.x * axis.x + s.y * axis.y;
    if (Math.abs(along) < 0.05) continue;
    const sign = Math.sign(along);
    if (sign < 0) backSteps += 1;
    if (last !== 0 && sign !== last) reversals += 1;
    last = sign;
  }
  return { steps: moving.length, reversals, backSteps };
}

test("walking straight through injected server snaps: zero camera reversals, and the motion report is posted", async () => {
  const { ctx, s } = await launch(browser, "map-shake", {
    viewport: PORTRAIT, joystick: true, dpr: 3, net: { rttMs: 80, jitterMs: 25 }, initScript: SNAP_INJECTOR,
    storage: { "ashAtlas.floatingSticks.v1": "0" }
  });
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

    const walk = async (key: string, ms: number): Promise<{ steps: number; reversals: number; backSteps: number; injected: number }> => {
      await s.page.keyboard.down(key);
      await s.page.waitForTimeout(800);
      await s.page.evaluate(({ lat, lon }) => {
        const w = window as any;
        const probe = w.__ASH_ATLAS_FRAME_PROBE__;
        probe.samples.length = 0;
        probe.anchor = [lon, lat];
        probe.on = true;
        w.__snapInjected = 0;
        w.__snapInject = true;
      }, { lat: s.self.lat, lon: s.self.lon });
      await s.page.waitForTimeout(ms);
      const data = await s.page.evaluate(() => {
        const w = window as any;
        w.__snapInject = false;
        w.__ASH_ATLAS_FRAME_PROBE__.on = false;
        return { samples: w.__ASH_ATLAS_FRAME_PROBE__.samples as Probe[], injected: w.__snapInjected as number };
      });
      await s.page.keyboard.up(key);
      await s.page.waitForTimeout(600);
      return { ...cameraReversals(data.samples), injected: data.injected };
    };

    // Filtered camera (default), in-overlay driver: the motion report's session sample runs inside this walk (3 s + 5 s).
    const filtered = await walk("d", 9_000);
    note("filtered", JSON.stringify(filtered));
    expect(filtered.injected, "server snaps were injected").toBeGreaterThan(10);
    expect(filtered.steps, "the camera moved").toBeGreaterThan(60);
    expect(filtered.reversals, "no camera direction reversals while walking straight").toBe(0);

    await expect.poll(() => reports.length, { timeout: 5_000 }).toBeGreaterThan(0);
    const first = reports[0]!;
    note("motion report", JSON.stringify(first));
    expect(first.kind).toBe("session");
    for (const key of ["frameP50Ms", "refreshHz", "camReversals", "camStepCv", "playerOffsetP95Px", "movingFramesMap2Plus", "layerMismatchFrames", "corrections", "leadCapFrames", "clockBehindReads", "dpr", "mapCanvasW", "driver", "quality"]) {
      expect(first.report, `report has ${key}`).toHaveProperty(key);
    }
    expect(first.report.driver).toBe("overlay");

    // A/B readout (not asserted: headless Chromium may not shake): the raw target and the standalone loop under the same snaps.
    await s.page.evaluate(() => { (window as any).__ASH_ATLAS_CAMERA_MODES__.filter = "off"; });
    note("unfiltered", JSON.stringify(await walk("a", 4_000)));
    await s.page.evaluate(() => { const m = (window as any).__ASH_ATLAS_CAMERA_MODES__; m.filter = "on"; m.driver = "standalone"; });
    const standalone = await walk("d", 4_000);
    note("standalone filtered", JSON.stringify(standalone));
    expect(standalone.reversals, "the filter keeps the standalone loop steady too").toBe(0);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

/**
 * Speed mismatch (docs/plans/move-smooth.md): WELCOME's base speed is raised by 1/0.9, so the client thinks it is 11%
 * faster than the server walks (like a speed-penalty loadout). With the server's speedMps the prediction matches
 * anyway; with it stripped (an older server), the soft lead limit has to absorb the gap without hard clamps.
 */
const speedSkewInjector = (stripSpeedField: boolean): string => `(() => {
  const desc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
  const cache = new WeakMap();
  Object.defineProperty(MessageEvent.prototype, "data", { configurable: true, get() {
    const raw = desc.get.call(this);
    if (typeof raw !== "string") return raw;
    if (cache.has(this)) return cache.get(this);
    let out = raw;
    try {
      if (raw.startsWith('{"type":"WELCOME"')) {
        // The simulated network re-dispatches frames it has read: skew once.
        const msg = JSON.parse(raw);
        if (!msg.__speedSkewed) { msg.playerSpeedMps = msg.playerSpeedMps / 0.9; msg.__speedSkewed = true; }
        out = JSON.stringify(msg);
      } else if (${stripSpeedField} && (raw.startsWith('{"type":"MOVE_ACCEPTED"') || raw.startsWith('{"type":"PLAYER_DELTA"'))) {
        const msg = JSON.parse(raw);
        delete msg.speedMps;
        for (const u of msg.upserts ?? []) delete u.speedMps;
        out = JSON.stringify(msg);
      }
    } catch {}
    cache.set(this, out);
    return out;
  } });
})();`;

for (const strip of [false, true]) {
  test(`speed mismatch ${strip ? "without" : "with"} the server speed field: no hard lead clamps, the sprite stays centred`, async () => {
    const { ctx, s } = await launch(browser, strip ? "move-smooth-no-speed" : "move-smooth-speed", {
      viewport: PORTRAIT, joystick: true, dpr: 3, net: { rttMs: 80, jitterMs: 25 }, initScript: speedSkewInjector(strip),
      storage: { "ashAtlas.floatingSticks.v1": "0" }
    });
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
      await s.page.keyboard.down("d");
      await expect.poll(() => reports.length, { timeout: 15_000 }).toBeGreaterThan(0);
      await s.page.keyboard.up("d");
      const report = reports[0]!.report;
      note(strip ? "no speed field" : "speed field", JSON.stringify(report));
      expect(Number(report.leadHardClampFrames), "no hard lead clamps").toBeLessThanOrEqual(2);
      expect(Number(report.playerOffsetP95Px), "the sprite stays centred").toBeLessThan(1);
      if (!strip) {
        expect(Number(report.speedVsBase), "the prediction walks at the server's speed").toBeCloseTo(0.9, 2);
        expect(Number(report.leadCapFrames), "the lead limit stays idle").toBeLessThanOrEqual(5);
      }
    } finally {
      s.save();
      // A MapLibre startup race ("reading 'getImage'") also fires on master builds during load; anything else fails.
      expect(s.errors.filter((message) => !message.includes("'getImage'"))).toEqual([]);
      await ctx.close();
    }
  });
}
