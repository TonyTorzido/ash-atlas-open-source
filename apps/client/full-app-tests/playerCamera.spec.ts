/**
 * Player camera (docs/plans/hud-landscape.md): joystick follow, off-screen player badge and the combat zoom, end to end
 * in headless Chromium at phone size (390x844) against a feature runtime with ACTION_COMBAT_ENABLED, MOB_TACTICS_ENABLED,
 * MOB_ARCHETYPES_ENABLED and DEV_TOOLS_ENABLED all true.
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41372 pnpm exec playwright test --config playwright-full-app.config.ts playerCamera
 *
 * - a player panned off screen gets an edge badge pointing at them; tapping it recenters
 * - joystick walking keeps the player centred; a drag stops the follow; tap-to-move does not follow
 * - fighting zooms the camera in softly (one ease, around the player) and back out after the fight; a pinch is respected
 */
import { expect, test, chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { launch, note, baseUrl, type Session } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend with action combat on");
test.describe.configure({ mode: "serial", timeout: 240_000 });

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : [] }); });
test.afterAll(async () => { await browser?.close(); });


const PORTRAIT = { width: 390, height: 844 };
async function boot(name: string): Promise<{ ctx: BrowserContext; s: Session }> {
  const { ctx, s } = await launch(browser, name, { viewport: PORTRAIT, joystick: true, storage: { "ashAtlas.floatingSticks.v1": "0" } });
  const gotIt = s.page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  return { ctx, s };
}

type CameraView = { phase: string; zoomPhase: string };
const cameraView = (page: Page): Promise<CameraView | null> => page.evaluate(() => {
  const v = (window as any).__ASH_ATLAS_PLAYER_CAMERA__;
  return v ? { phase: v.phase, zoomPhase: v.zoomPhase } : null;
});

/** Canvas size, camera centre and the player's screen point (the player stands still in these specs). */
const geometry = (s: Session): Promise<{ w: number; h: number; cx: number; cy: number; px: number; py: number }> => s.page.evaluate(({ lat, lon }) => {
  const m = (window as any).__e2eMap;
  const canvas = m.getCanvas();
  const c = m.project(m.getCenter());
  const p = m.project([lon, lat]);
  return { w: canvas.clientWidth, h: canvas.clientHeight, cx: c.x, cy: c.y, px: p.x, py: p.y };
}, { lat: s.self.lat, lon: s.self.lon });

async function recenter(s: Session): Promise<void> {
  await s.page.getByRole("button", { name: /Tap to center the map on you/ }).first().tap({ timeout: 8000 });
}

async function centred(s: Session): Promise<void> {
  await expect.poll(async () => {
    const g = await geometry(s);
    return Math.hypot(g.px - g.cx, g.py - g.cy);
  }, { timeout: 6000 }).toBeLessThan(40);
}
test("4. an off-screen player gets an edge badge pointing at them; tapping it recenters", async () => {
  const { ctx, s } = await boot("cl-indicator");
  try {
    const badge = s.page.locator(".player-offscreen-indicator");
    await expect(badge).toHaveAttribute("data-visible", "false");
    const angle = (): Promise<number> => badge.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--offscreen-angle")));

    // Pan the map so the player is left of the screen: the badge sits at the left edge and points left.
    await s.page.evaluate(() => (window as any).__e2eMap.panBy([700, 0], { duration: 0 }));
    await expect(badge).toHaveAttribute("data-visible", "true", { timeout: 3000 });
    const left = (await badge.boundingBox())!;
    expect(left.x, "the badge hugs the left edge, clear of the slot rail").toBeLessThan(70);
    expect(Math.abs(await angle()), "pointing left").toBeGreaterThan(165);

    // Then so the player is below the screen: the badge moves to the bottom edge and points down.
    await s.page.evaluate(() => (window as any).__e2eMap.panBy([-700, -1400], { duration: 0 }));
    await expect.poll(async () => Math.abs((await angle()) - 90), { timeout: 3000 }).toBeLessThan(25);
    const bottom = (await badge.boundingBox())!;
    expect(bottom.y + bottom.height, "the badge stays above the touch controls").toBeLessThan(PORTRAIT.height - 150);
    await s.shot("cl-indicator-bottom");

    // Tapping it recenters.
    await badge.tap();
    await centred(s);
    await expect(badge).toHaveAttribute("data-visible", "false", { timeout: 3000 });
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

/** Per-frame samples of the rendered player's offset from the screen centre and the map origin's screen point (camera motion). */
async function startFollowSampling(s: Session): Promise<void> {
  await s.page.evaluate(() => {
    const w = window as any;
    w.__followSamples = [] as number[][];
    w.__followOn = true;
    const tick = (): void => {
      if (!w.__followOn) return;
      const v = w.__ASH_ATLAS_PLAYER_CAMERA__;
      const o = v.cameraDelta;
      w.__followSamples.push([performance.now(), v.playerOffsetPx ?? -1, o?.x ?? 0, o?.y ?? 0]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const stopFollowSampling = (s: Session): Promise<number[][]> => s.page.evaluate(() => { const w = window as any; w.__followOn = false; return w.__followSamples as number[][]; });
const phaseOf = async (s: Session): Promise<string> => (await cameraView(s.page))!.phase;

test("8. joystick-walking keeps the player centred with no per-frame snap; stopping settles to idle", async () => {
  const { ctx, s } = await boot("cl-follow");
  try {
    await recenter(s);
    await centred(s);
    await s.page.keyboard.down("d");
    await expect.poll(() => phaseOf(s), { timeout: 3000 }).toBe("following");
    await s.page.waitForTimeout(800);
    await startFollowSampling(s);
    await s.page.waitForTimeout(3000);
    const samples = await stopFollowSampling(s);
    await s.page.keyboard.up("d");
    const offsets = samples.map((r) => r[1]!).filter((v) => v >= 0);
    const paced = samples.filter((r, i) => i > 0 && r[0]! - samples[i - 1]![0]! >= 8 && r[0]! - samples[i - 1]![0]! <= 30);
    let maxStep = 0;
    for (let i = 1; i < samples.length; i++) {
      const dt = samples[i]![0]! - samples[i - 1]![0]!;
      if (dt < 8 || dt > 30) continue;
      maxStep = Math.max(maxStep, Math.hypot(samples[i]![2]! - samples[i - 1]![2]!, samples[i]![3]! - samples[i - 1]![3]!));
    }
    const p95 = [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length * 0.95)]!;
    note("follow walking", JSON.stringify({ frames: samples.length, paced: paced.length, offsetMaxPx: Math.round(Math.max(...offsets) * 10) / 10, offsetP95Px: Math.round(p95 * 10) / 10, maxCameraStepPx: Math.round(maxStep * 10) / 10 }));
    expect(p95, "the player stays centred within a few px").toBeLessThan(6);
    expect(maxStep, "no per-frame snap").toBeLessThan(14);
    await expect.poll(() => phaseOf(s), { timeout: 4000 }).toBe("idle");
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("9. a map drag stops the follow until the joystick is used again", async () => {
  const { ctx, s } = await boot("cl-follow-drag");
  try {
    await recenter(s);
    await centred(s);
    await s.page.keyboard.down("d");
    await expect.poll(() => phaseOf(s), { timeout: 3000 }).toBe("following");
    await s.page.waitForTimeout(600);
    await s.page.mouse.move(195, 300);
    await s.page.mouse.down();
    await s.page.mouse.move(195, 360, { steps: 6 });
    await s.page.mouse.up();
    await expect.poll(() => phaseOf(s), { timeout: 2000 }).toBe("idle");
    await s.page.waitForTimeout(1500); // the drag inertia runs out
    const parked = await s.page.evaluate(() => (window as any).__ASH_ATLAS_PLAYER_CAMERA__.cameraDelta);
    await s.page.waitForTimeout(1200);
    const later = await s.page.evaluate(() => (window as any).__ASH_ATLAS_PLAYER_CAMERA__.cameraDelta);
    expect(Math.hypot(later.x - parked.x, later.y - parked.y), "the camera stays where it was put").toBeLessThan(1);
    await s.page.keyboard.up("d");
    await s.page.keyboard.down("a");
    await expect.poll(() => phaseOf(s), { timeout: 3000 }).toBe("following");
    await s.page.waitForTimeout(2500);
    expect(await s.page.evaluate(() => (window as any).__ASH_ATLAS_PLAYER_CAMERA__.playerOffsetPx), "resumed: glides back to centre").toBeLessThan(8);
    await s.page.keyboard.up("a");
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("9b. a real touch drag on the map stops the follow; the joystick finger alone never does", async () => {
  const { ctx, s } = await boot("cl-follow-touch");
  try {
    await recenter(s);
    await centred(s);
    const cdp = await ctx.newCDPSession(s.page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", id: number, x: number, y: number): Promise<unknown> =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id }] });
    const pad = await s.page.evaluate(() => { const b = document.querySelector(".joystick-move-base")!.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    // The joystick finger walks: the follow starts and keeps going for as long as the finger is down and drags inside the pad.
    await touch("touchStart", 1, pad.x, pad.y);
    for (let i = 1; i <= 8; i++) { await touch("touchMove", 1, pad.x + i * 5, pad.y); await s.page.waitForTimeout(40); }
    await expect.poll(() => phaseOf(s), { timeout: 3000 }).toBe("following");
    for (let i = 0; i < 20; i++) { await touch("touchMove", 1, pad.x + 40 + (i % 2), pad.y); await s.page.waitForTimeout(60); }
    expect(await phaseOf(s), "the joystick finger alone never stops the follow").toBe("following");
    // Lift and press again: a fresh press resumes walking and the follow.
    await touch("touchEnd", 1, 0, 0);
    await touch("touchStart", 1, pad.x, pad.y);
    await touch("touchMove", 1, pad.x + 40, pad.y);
    await expect.poll(() => phaseOf(s), { timeout: 3000 }).toBe("following");
    await touch("touchEnd", 1, 0, 0);
    // Keyboard held (movement input) + one finger dragging the map: the follow stops.
    await s.page.keyboard.down("d");
    await expect.poll(() => phaseOf(s), { timeout: 3000 }).toBe("following");
    await s.page.waitForTimeout(400);
    await touch("touchStart", 2, 195, 300);
    for (let i = 1; i <= 6; i++) { await touch("touchMove", 2, 195, 300 + i * 12); await s.page.waitForTimeout(30); }
    await touch("touchEnd", 2, 0, 0);
    await expect.poll(() => phaseOf(s), { timeout: 2000 }).toBe("idle");
    await s.page.keyboard.up("d");
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("10. tap-to-move does not make the camera follow", async () => {
  const { ctx, s } = await boot("cl-follow-tap");
  try {
    await recenter(s);
    await centred(s);
    const before = await s.page.evaluate(() => (window as any).__ASH_ATLAS_PLAYER_CAMERA__.cameraDelta);
    const mark = s.mark();
    await s.page.mouse.dblclick(300, 330);
    await s.page.waitForTimeout(2500);
    const moves = s.since(mark, undefined, "out").filter((f) => /MOVE/.test(f.type)).length;
    expect(await phaseOf(s)).toBe("idle");
    const after = await s.page.evaluate(() => (window as any).__ASH_ATLAS_PLAYER_CAMERA__.cameraDelta);
    note("tap-move", JSON.stringify({ moveFrames: moves, cameraMovedPx: Math.round(Math.hypot(after.x - before.x, after.y - before.y)) }));
    expect(Math.hypot(after.x - before.x, after.y - before.y), "the camera stays put").toBeLessThan(1);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

const attackFace = async (s: Session): Promise<{ x: number; y: number }> => {
  const box = (await s.page.locator(".joystick-attack-face").first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const tapAttack = async (s: Session): Promise<void> => { const at = await attackFace(s); await s.page.touchscreen.tap(at.x, at.y); };
const mapZoom = (s: Session): Promise<number> => s.page.evaluate(() => (window as any).__e2eMap.getZoom() as number);

/** Per-frame camera samples: time, zoom, camera centre (lng, lat) and the player's screen point. */
async function startZoomSampling(s: Session): Promise<void> {
  await s.page.evaluate(({ lat, lon }) => {
    const w = window as any;
    w.__zoomSamples = [] as number[][];
    w.__zoomOn = true;
    const tick = (): void => {
      if (!w.__zoomOn) return;
      const m = w.__e2eMap;
      const c = m.getCenter();
      const p = m.project([lon, lat]);
      w.__zoomSamples.push([performance.now(), m.getZoom(), c.lng, c.lat, p.x, p.y]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { lat: s.self.lat, lon: s.self.lon });
}
const stopZoomSampling = (s: Session): Promise<number[][]> => s.page.evaluate(() => { const w = window as any; w.__zoomOn = false; return w.__zoomSamples as number[][]; });

/** Smoothness of the zoom window (frames where the zoom is moving): per-frame zoom delta, jerk, monotonicity, player drift, frame gaps. */
function zoomStats(samples: number[][], canvas: { w: number; h: number }): { frames: number; totalZoom: number; maxStep: number; maxJerk: number; backwards: number; maxDriftPx: number; maxFrameGapMs: number; durationMs: number } {
  const moving = samples.map((r, i) => (i > 0 && Math.abs(r[1]! - samples[i - 1]![1]!) > 1e-5 ? i : -1)).filter((i) => i > 0);
  const first = Math.max(0, (moving[0] ?? 1) - 1);
  const last = moving[moving.length - 1] ?? first;
  const win = samples.slice(first, last + 1);
  const dz = win.slice(1).map((r, i) => r[1]! - win[i]![1]!);
  const jerk = dz.slice(1).map((d, i) => Math.abs(d - dz[i]!));
  const drift = win.map((r) => Math.hypot(r[4]! - canvas.w / 2, r[5]! - canvas.h / 2));
  const gaps = win.slice(1).map((r, i) => r[0]! - win[i]![0]!);
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    frames: win.length,
    totalZoom: r3((win[win.length - 1]?.[1] ?? 0) - (win[0]?.[1] ?? 0)),
    maxStep: r3(Math.max(0, ...dz.map(Math.abs))),
    maxJerk: r3(Math.max(0, ...jerk)),
    backwards: dz.filter((d) => d < -1e-4).length,
    maxDriftPx: Math.round(Math.max(0, ...drift) * 10) / 10,
    maxFrameGapMs: Math.round(Math.max(0, ...gaps)),
    durationMs: Math.round((win[win.length - 1]?.[0] ?? 0) - (win[0]?.[0] ?? 0))
  };
}

test("11. fighting zooms the camera in smoothly and never zooms back out", async () => {
  const { ctx, s } = await boot("cz-fight");
  try {
    await recenter(s);
    await centred(s);
    await s.spawn("training_dummy", 0, 60);
    await s.page.waitForTimeout(1000);
    const before = await mapZoom(s);
    expect((await cameraView(s.page))!.zoomPhase).toBe("off");

    await startZoomSampling(s);
    await tapAttack(s);
    await expect.poll(async () => (await cameraView(s.page))?.zoomPhase, { timeout: 5000 }).toMatch(/^(in|held)$/);
    await s.page.waitForTimeout(2500);
    const samples = await stopZoomSampling(s);
    const zoomed = await mapZoom(s);
    const st = zoomStats(samples, { w: PORTRAIT.width, h: PORTRAIT.height });
    note("combat zoom in", JSON.stringify({ before, zoomed, ...st }));
    expect(zoomed - before, "a moderate step in").toBeGreaterThan(0.2);
    expect(zoomed - before).toBeLessThan(0.8);
    expect(st.backwards, "monotonic").toBe(0);
    expect(st.maxStep, "per-frame zoom step (old easeTo: 0.067)").toBeLessThan(0.035);
    expect(st.maxJerk, "per-frame zoom jerk (old easeTo: 0.060)").toBeLessThan(0.02);
    expect(st.maxDriftPx, "the player stays at the centre through the zoom").toBeLessThan(4);
    expect(st.durationMs, "about a second").toBeGreaterThan(700);
    await s.shot("cz-zoomed");

    // The fight ends: the zoom stays. No zoom back out, ever.
    await s.page.waitForTimeout(9_000);
    expect(await mapZoom(s), "no zoom back out after combat").toBeGreaterThanOrEqual(zoomed - 0.01);
    await s.clearMobs();
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("12. a pinch during the combat zoom cancels the ease and the player's zoom stays", async () => {
  const { ctx, s } = await boot("cz-pinch");
  try {
    await recenter(s);
    await centred(s);
    await s.spawn("training_dummy", 0, 60);
    await s.page.waitForTimeout(1000);
    const before = await mapZoom(s);
    const cdp = await s.page.context().newCDPSession(s.page);
    await tapAttack(s);
    await expect.poll(async () => (await cameraView(s.page))?.zoomPhase, { timeout: 5000, intervals: [20] }).toBe("in");
    await pinch(s, { x: 195, y: 250 }, 110, 30, cdp); // a pinch in (zoom out) while the ease runs
    await expect.poll(async () => (await cameraView(s.page))?.zoomPhase, { timeout: 4000 }).toBe("pinched");
    await s.page.waitForTimeout(800);
    const mine = await mapZoom(s);
    expect(mine, "the ease did not carry on to its target").toBeLessThan(before + 0.5);
    await expect.poll(async () => (await cameraView(s.page))?.zoomPhase, { timeout: 25_000 }).toBe("off");
    expect(Math.abs((await mapZoom(s)) - mine), "nothing moves the player's zoom afterwards").toBeLessThan(0.02);
    await s.clearMobs();
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

/** A real two-finger spread through CDP touch events. */
async function pinch(s: Session, center: { x: number; y: number }, from: number, to: number, session?: CDPSession): Promise<void> {
  const cdp = session ?? await s.page.context().newCDPSession(s.page);
  const pts = (d: number) => [{ x: center.x - d, y: center.y, id: 1 }, { x: center.x + d, y: center.y, id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(from) });
  for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(from + ((to - from) * i) / 10) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const centredOffset = async (s: Session): Promise<number> => (await s.page.evaluate(() => (window as any).__ASH_ATLAS_PLAYER_CAMERA__.playerOffsetPx)) ?? 9999;


test("13. repeated fights do not ratchet the zoom", async () => {
  const { ctx, s } = await boot("cz-ratchet");
  try {
    await recenter(s);
    await centred(s);
    await s.spawn("training_dummy", 0, 60);
    await s.page.waitForTimeout(1000);
    const before = await mapZoom(s);
    await tapAttack(s);
    await expect.poll(async () => (await cameraView(s.page))?.zoomPhase, { timeout: 5000 }).toBe("held");
    const first = await mapZoom(s);
    await expect.poll(async () => (await cameraView(s.page))?.zoomPhase, { timeout: 25_000 }).toBe("off");
    for (let i = 0; i < 2; i++) {
      await tapAttack(s);
      await s.page.waitForTimeout(2500);
      await expect.poll(async () => (await cameraView(s.page))?.zoomPhase, { timeout: 25_000 }).toBe("off");
    }
    const last = await mapZoom(s);
    note("ratchet", JSON.stringify({ before, first, last }));
    expect(first - before).toBeGreaterThan(0.2);
    expect(Math.abs(last - first), "later fights add nothing").toBeLessThan(0.01);
    await s.clearMobs();
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("14. at a rotated map the zoom still keeps the player at the centre", async () => {
  const { ctx, s } = await boot("cz-bearing");
  try {
    await recenter(s);
    await centred(s);
    await s.page.evaluate(() => (window as any).__e2eMap.setBearing(40));
    await s.page.waitForTimeout(500);
    await centred(s);
    await s.spawn("training_dummy", 0, 60);
    await s.page.waitForTimeout(1000);
    await startZoomSampling(s);
    await tapAttack(s);
    await expect.poll(async () => (await cameraView(s.page))?.zoomPhase, { timeout: 5000 }).toBe("held");
    await s.page.waitForTimeout(800);
    const st = zoomStats(await stopZoomSampling(s), { w: PORTRAIT.width, h: PORTRAIT.height });
    note("bearing 40 zoom", JSON.stringify(st));
    expect(st.totalZoom).toBeGreaterThan(0.2);
    expect(st.maxDriftPx, "player stays centred at bearing 40").toBeLessThan(4);
    await s.clearMobs();
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});
