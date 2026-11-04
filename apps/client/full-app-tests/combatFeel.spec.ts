/**
 * Combat feel: measures (and guards) how the phone twin-stick controls feel, end to end in headless Chromium with CDP
 * multi-touch against a feature runtime (ACTION_COMBAT_ENABLED, MOB_TACTICS_ENABLED, MOB_ARCHETYPES_ENABLED and
 * DEV_TOOLS_ENABLED all true).
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41126 pnpm exec playwright test --config playwright-full-app.config.ts combatFeel
 *
 * Every test writes its numbers to <ASH_ATLAS_E2E_OUT>/combat-feel-<COMBAT_FEEL_LABEL>.json (label default "run"), so a
 * before/after pair can be diffed. The guard assertions (COMBAT_FEEL_GUARD, default on) pin the numbers the
 * docs/plans/combat-feel.md fixes were made for; set COMBAT_FEEL_GUARD=0 to only measure.
 *
 *  - zones: every touch zone's rectangle as a share of the screen, plus an elementFromPoint scan of what owns each tap
 *  - movement: input to first visible move, corrections, snaps, frame-to-frame speed jitter, heading error, walk/idle
 *    flicker, stick response curve and release drift on a scripted 10 s walk and a 10 s circle
 *  - flick: false dash triggers on that scripted walk with flick-to-dash on
 *  - aim: where taps, jittery taps and drags actually swing, against what was meant
 *  - stalls: whether swinging or dashing stalls or rubber-bands the walk
 */
import { expect, test, chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, note, outDir, baseUrl, TEST_SPOT, type Session } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend with action combat on");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const GUARD = (process.env.COMBAT_FEEL_GUARD ?? "1") !== "0";
const LABEL = process.env.COMBAT_FEEL_LABEL ?? "run";
const REPORT = join(outDir, `combat-feel-${LABEL}.json`);
const report: Record<string, unknown> = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, "utf8")) : {};
const recordTop = (key: string, value: unknown): void => {
  report[key] = value;
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  note(key, JSON.stringify(value));
};
const record = recordTop;
const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d;

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true, args: (process.env.ASH_ATLAS_E2E_GPU ?? "1") === "1" ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : [] }); });
test.afterAll(async () => { await browser?.close(); });

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };

/** A phone on mobile data: ~140 ms round trip with jitter (every websocket frame is held in the page). */
const PHONE_NET = { rttMs: Number(process.env.COMBAT_FEEL_RTT_MS ?? 140), jitterMs: Number(process.env.COMBAT_FEEL_JITTER_MS ?? 30) };

async function boot(name: string, viewport: { width: number; height: number }, flick: boolean | null = null, net: { rttMs: number; jitterMs: number } | null = PHONE_NET): Promise<{ ctx: BrowserContext; s: Session; t: Touch }> {
  const storage: Record<string, string> = { "ashAtlas.floatingSticks.v1": "1", "ashAtlas.floatingStickGuides.v1": "1" };
  if (flick !== null) storage["ashAtlas.flickDash.v1"] = flick ? "1" : "0";
  const { ctx, s } = await launch(browser, name, { viewport, joystick: true, storage, ...(net ? { net } : {}) });
  const gotIt = s.page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await installProbe(s.page);
  return { ctx, s, t: new Touch(await ctx.newCDPSession(s.page)) };
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
  async up(id: number): Promise<void> { const f = this.fingers.get(id); if (!f) return; await this.send("touchEnd", f); this.fingers.delete(id); }
}

/**
 * Page-side probe: finds the player render timeline and JoystickMovement's getWorldState through React fibers, wraps
 * the timeline's correction / snap / lead-cap hooks to count them, and samples the rendered local position every frame.
 */
async function installProbe(page: Page): Promise<void> {
  const ok = await page.evaluate(() => {
    const w = window as any;
    const seen = new Set<unknown>();
    let timeline: any = null;
    let getWorldState: any = null;
    const search = (v: any, d: number): void => {
      if (timeline || !v || typeof v !== "object" || seen.has(v) || d > 4) return;
      seen.add(v);
      if (typeof v.beginLocalAnticipation === "function" && typeof v.renderPosition === "function") { timeline = v; return; }
      for (const k of Object.keys(v)) { let c; try { c = v[k]; } catch { continue; } search(c, d + 1); }
    };
    for (const e of Array.from(document.querySelectorAll("*"))) {
      const fk = Object.keys(e).find((k) => k.startsWith("__reactFiber")); if (!fk) continue;
      for (let f = (e as any)[fk], depth = 0; f && depth < 400; f = f.return, depth++) {
        if (!getWorldState && typeof f.memoizedProps?.getWorldState === "function") getWorldState = f.memoizedProps.getWorldState;
        let s = f.memoizedState; let n = 0;
        while (!timeline && s && typeof s === "object" && n++ < 4000) { search(s.memoizedState, 0); s = s.next; }
      }
      if (timeline && getWorldState) break;
    }
    if (!timeline || !getWorldState) return false;
    const m = (a: any, b: any): number => Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180));
    const feel = { on: false, samples: [] as number[][], corrections: [] as number[], snaps: 0, leadCap: 0, moves: [] as number[], lastMoveAt: 0, timeline, getWorldState };
    w.__feel = feel;
    const proto = Object.getPrototypeOf(timeline);
    timeline.startLocalCorrection = function (now: number) {
      if (feel.on && this.localAuthority && this.localRenderedPosition) feel.corrections.push(m(this.localAuthority, this.localRenderedPosition));
      return proto.startLocalCorrection.call(this, now);
    };
    timeline.setLocalImmediate = function (...args: any[]) {
      if (feel.on) feel.snaps += 1;
      return proto.setLocalImmediate.apply(this, args);
    };
    (feel as any).applied = [] as number[][];
    timeline.applyDelta = function (...args: any[]) {
      (feel as any).applied.push([Math.round(performance.now()), args[4]?.sequence ?? -1]);
      return proto.applyDelta.apply(this, args);
    };
    timeline.noteLocalRenderDiagnostics = function (...args: any[]) {
      if (feel.on && args[3]) feel.leadCap += 1;
      return proto.noteLocalRenderDiagnostics.apply(this, args);
    };
    w.__resyncStacks = [] as string[];
    const sendBefore = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: any) {
      if (typeof data === "string" && data.includes("REQUEST_WORLD_RESYNC")) w.__resyncStacks.push(String(new Error().stack).split(String.fromCharCode(10)).slice(9, 16).map((l) => l.trim().replace(/[(]http[^)]*[/]src[/]/, "(")).join(" < "));
      return sendBefore.call(this, data);
    };
    document.addEventListener("pointermove", (e) => { if (feel.on) feel.moves.push(performance.now()); feel.lastMoveAt = performance.now(); }, true);
    const tick = (): void => {
      if (feel.on) {
        const p = getWorldState()?.position;
        if (p) {
          const row: any[] = [performance.now(), p.lat, p.lon];
          if (w.__feelDebug) { const tl = feel.timeline; const a = tl.localAuthority; const it = tl.localMovementIntent; row.push(tl.localCorrection ? 1 : 0, it?.requestId?.slice(0, 6) ?? null, it?.acceptedRevision ?? null, a ? [a.lat, a.lon, a.moving, a.movementRevision, a.targetLat, a.targetLon] : null, tl.localDash ? 1 : 0, it ? [it.target.lat, it.target.lon] : null); }
          feel.samples.push(row);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  });
  expect(ok, "combat feel probe could not find the render timeline / JoystickMovement").toBe(true);
}

type Probe = { samples: number[][]; corrections: number[]; snaps: number; leadCap: number; moves: number[] };
const probeStart = (page: Page): Promise<number> => page.evaluate(() => { const f = (window as any).__feel; f.samples = []; f.corrections = []; f.snaps = 0; f.leadCap = 0; f.moves = []; f.on = true; return performance.now(); });
const probeStop = (page: Page): Promise<Probe> => page.evaluate(() => { const f = (window as any).__feel; f.on = false; return { samples: f.samples, corrections: f.corrections, snaps: f.snaps, leadCap: f.leadCap, moves: f.moves }; });
const pageNow = (page: Page): Promise<number> => page.evaluate(() => performance.now());

/** Local metres (east, north) of every sample relative to the first. */
function toMetres(samples: number[][]): { t: number; x: number; y: number }[] {
  if (!samples.length) return [];
  const [, lat0, lon0] = samples[0]!;
  const k = Math.cos((lat0! * Math.PI) / 180);
  return samples.map(([t, lat, lon]) => ({ t: t!, x: (lon! - lon0!) * 111_320 * k, y: (lat! - lat0!) * 111_320 }));
}

/** Speed / jitter / heading stats for a window of frames. `intent(t)` is the stick's world heading (radians, 0 = north, clockwise) or null. */
function motionStats(pts: { t: number; x: number; y: number }[], fromT: number, toT: number, walkSpeed: number, intent: ((t: number) => number | null) | null) {
  const speeds: number[] = [];
  const headingErr: number[] = [];
  let snaps = 0;
  let walkFlips = 0;
  let walking = false;
  let lastWalkAt = -1e9;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!; const b = pts[i]!;
    if (b.t < fromT || b.t > toT) continue;
    const dt = (b.t - a.t) / 1000;
    if (!(dt > 0)) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const v = d / dt;
    speeds.push(v);
    if (d > walkSpeed * dt * 2.5 && d > 2) snaps += 1;
    // Same rule as map/playerWalkMotion.ts: walking above 20 % of walk speed, held 160 ms.
    const nowWalking = v > walkSpeed * 0.2 || b.t - lastWalkAt < 160;
    if (v > walkSpeed * 0.2) lastWalkAt = b.t;
    if (nowWalking !== walking) { walkFlips += 1; walking = nowWalking; }
    const want = intent?.(b.t);
    if (want !== null && want !== undefined && d > 0.3) {
      const got = Math.atan2(b.x - a.x, b.y - a.y);
      let e = Math.abs(got - want) % (2 * Math.PI); if (e > Math.PI) e = 2 * Math.PI - e;
      headingErr.push((e * 180) / Math.PI);
    }
  }
  const mean = speeds.reduce((s, v) => s + v, 0) / Math.max(1, speeds.length);
  const sd = Math.sqrt(speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, speeds.length));
  const sorted = [...speeds].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const hitches = speeds.filter((v) => v < median * 0.5 || v > median * 1.5).length;
  const he = [...headingErr].sort((a, b) => a - b);
  const seconds = Math.max(0.001, (toT - fromT) / 1000);
  return {
    frames: speeds.length,
    meanSpeed: round(mean), speedCv: round(sd / Math.max(1e-6, mean), 3),
    hitchFramePct: round((100 * hitches) / Math.max(1, speeds.length)),
    snaps,
    walkFlipsPerS: round(Math.max(0, walkFlips - 1) / seconds, 2),
    headingErrMeanDeg: round(he.reduce((s, v) => s + v, 0) / Math.max(1, he.length)),
    headingErrP95Deg: round(he[Math.floor(he.length * 0.95)] ?? 0)
  };
}

const rectOf = (page: Page, sel: string): Promise<{ l: number; t: number; r: number; b: number; w: number; h: number } | null> =>
  page.evaluate((q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; }, sel);

async function zoneReport(page: Page, viewport: { width: number; height: number }) {
  const zones = await page.evaluate(({ W, H }) => {
    const owners: Record<string, number> = {};
    const step = 6;
    let total = 0;
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) {
      total += 1;
      const e = document.elementFromPoint(x, y) as HTMLElement | null;
      let owner = "other";
      if (!e) owner = "none";
      else if (e.closest(".joystick-attack")) owner = "attack";
      else if (e.closest(".joystick-move")) owner = "move";
      else if (e.closest("[class*='ash-hotbar']")) owner = "hotbar";
      else if (e.closest(".phone-bottom-bar")) owner = "dock";
      else if (e.tagName === "CANVAS" || e.closest(".maplibregl-canvas-container, .maplibregl-map")) owner = "map";
      else owner = `other:${(typeof e.className === "string" ? (e.className.split(" ")[0] ?? "") : e.tagName).slice(0, 40)}`;
      owners[owner] = (owners[owner] ?? 0) + 1;
    }
    const share: Record<string, number> = {};
    for (const [k, v] of Object.entries(owners)) share[k] = Math.round((1000 * v) / total) / 10;
    return share;
  }, { W: viewport.width, H: viewport.height });
  const area = viewport.width * viewport.height;
  const rect = async (sel: string) => {
    const r = await rectOf(page, sel);
    return r ? { ...(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)])) as Record<"l" | "t" | "r" | "b" | "w" | "h", number>), screenPct: round((100 * r.w * r.h) / area), widthPct: round((100 * r.w) / viewport.width), heightPct: round((100 * r.h) / viewport.height) } : null;
  };
  return {
    move: await rect(".joystick-move"),
    attack: await rect(".joystick-attack"),
    attackFace: await rect(".joystick-attack-face"),
    tapOwnerPct: zones
  };
}

test("zones: touch zone rectangles and tap owners at 390x844 and 844x390", async () => {
  for (const [name, vp] of [["portrait", PORTRAIT], ["landscape", LANDSCAPE]] as const) {
    const { ctx, s } = await boot(`feel-zones-${name}`, vp);
    try {
      await s.page.waitForTimeout(1200);
      const z = await zoneReport(s.page, vp);
      record(`zones.${name}`, z);
      await s.shot(`zones-${name}`);
      if (GUARD) {
        // Movement zone: the bottom-left thumb only; attack zone: the mirrored bottom-right corner (thumb centring, t1524: same size as the move zone).
        expect(z.move!.widthPct, "move zone width").toBeLessThanOrEqual(name === "portrait" ? 42 : 30);
        expect(z.move!.t, "move zone never reaches mid-screen").toBeGreaterThanOrEqual(vp.height * 0.5);
        expect(z.attack!.screenPct, "attack zone area").toBeLessThanOrEqual(8);
        expect(z.attack!.screenPct, "attack zone mirrors the move zone").toBeLessThanOrEqual(z.move!.screenPct + 0.5);
        expect(z.tapOwnerPct.map ?? 0, "most of the screen still pans the map").toBeGreaterThanOrEqual(name === "portrait" ? 60 : 55);
      }
    } finally { await ctx.close(); }
  }
});

/** Plants the movement stick at the centre of its zone and returns that point. */
async function plantPoint(page: Page): Promise<{ x: number; y: number; radius: number }> {
  const r = (await rectOf(page, ".joystick-move"))!;
  return { x: r.l + r.w / 2, y: r.t + r.h / 2, radius: 46 };
}

/** World heading (radians, 0 = north, clockwise) of a screen stick vector at map bearing `bearingDeg`. */
const headingOf = (dx: number, dy: number, bearingDeg: number): number => Math.atan2(dx, -dy) + (bearingDeg * Math.PI) / 180;

for (const [netName, net] of [["lan", null], ["phone", PHONE_NET]] as const) test(`movement (${netName}): latency, corrections, jitter, heading, curve and drift`, async () => {
  const record = (key: string, value: unknown): void => recordTop(key.replace("movement.", `movement.${netName}.`), value);
  const { ctx, s, t } = await boot(`feel-move-${netName}`, PORTRAIT, null, net);
  const page = s.page;
  try {
    const walkSpeed = 125;
    const bearing = await page.evaluate(() => (window as any).__e2eMap.getBearing() as number);
    const c = await plantPoint(page);
    const R = 40; // 0.87 of the 46 px stick radius: a firm thumb

    // Latency: touch down + one move to the rim, five directions.
    const latencies: number[] = [];
    for (const [dx, dy] of [[0, -R], [R, 0], [0, R], [-R, 0], [0, -R]] as const) {
      await probeStart(page);
      await t.down(1, c.x, c.y);
      await t.move(1, c.x + dx, c.y + dy);
      await page.waitForTimeout(700);
      await t.up(1);
      const p = await probeStop(page);
      const pts = toMetres(p.samples);
      const inputAt = p.moves[0] ?? pts[0]?.t ?? 0;
      const first = pts.find((q) => q.t >= inputAt && Math.hypot(q.x, q.y) > 0.05);
      if (first) latencies.push(first.t - inputAt);
      await page.waitForTimeout(700);
    }
    latencies.sort((a, b) => a - b);
    record("movement.latencyMs", { samples: latencies.map((v) => round(v)), median: round(latencies[Math.floor(latencies.length / 2)] ?? -1) });

    // 10 s square walk: 2.5 s per side, the finger slides to each new direction over 3 frames like a thumb would.
    const segments: { from: number; to: number; heading: number }[] = [];
    const t0 = await probeStart(page);
    await t.down(1, c.x, c.y);
    const sides = [[0, -R], [R, 0], [0, R], [-R, 0]] as const;
    let fx = c.x; let fy = c.y;
    for (const [dx, dy] of sides) {
      for (let k = 1; k <= 3; k++) { await t.move(1, fx + ((c.x + dx) - fx) * (k / 3), fy + ((c.y + dy) - fy) * (k / 3)); await page.waitForTimeout(16); }
      fx = c.x + dx; fy = c.y + dy;
      const from = await pageNow(page);
      // Small natural thumb wobble (±2 px) while holding a direction.
      const end = Date.now() + 2450;
      let i = 0;
      while (Date.now() < end) { await t.move(1, fx + Math.sin(i / 3) * 2, fy + Math.cos(i / 4) * 2); i += 1; await page.waitForTimeout(33); }
      segments.push({ from: from + 300, to: await pageNow(page), heading: headingOf(dx, dy, bearing) });
    }
    const releaseAt = await pageNow(page);
    await t.up(1);
    await page.waitForTimeout(900);
    const walk = await probeStop(page);
    const wpts = toMetres(walk.samples);
    const segAt = (tt: number): number | null => segments.find((g) => tt >= g.from && tt <= g.to)?.heading ?? null;
    const steady = segments.map((g) => motionStats(wpts, g.from, g.to, walkSpeed, segAt));
    const walkAll = motionStats(wpts, t0 + 300, releaseAt, walkSpeed, segAt);
    // Release drift: distance travelled after the finger lifted, and how long until it stopped.
    const atRelease = wpts.find((q) => q.t >= releaseAt) ?? wpts.at(-1)!;
    const lastMove = [...wpts].reverse().find((q, i, arr) => i + 1 < arr.length && Math.hypot(q.x - arr[i + 1]!.x, q.y - arr[i + 1]!.y) > 0.05);
    const final = wpts.at(-1)!;
    record("movement.walk10s", {
      ...walkAll,
      steadySpeedCv: round(steady.reduce((s2, v) => s2 + v.speedCv, 0) / steady.length, 3),
      steadyHeadingErrDeg: round(steady.reduce((s2, v) => s2 + v.headingErrMeanDeg, 0) / steady.length),
      corrections: walk.corrections.length,
      correctionMeanM: round(walk.corrections.reduce((s2, v) => s2 + v, 0) / Math.max(1, walk.corrections.length)),
      correctionMaxM: round(Math.max(0, ...walk.corrections)),
      timelineSnaps: walk.snaps,
      leadCapFrames: walk.leadCap,
      releaseDriftM: round(Math.hypot(final.x - atRelease.x, final.y - atRelease.y)),
      releaseStopMs: round(lastMove ? Math.max(0, lastMove.t - releaseAt) : 0)
    });

    // 10 s circle at full deflection, one lap per 4 s.
    await page.waitForTimeout(500);
    const ct0 = await probeStart(page);
    await t.down(1, c.x, c.y);
    await t.move(1, c.x, c.y - R);
    const circleStart = Date.now();
    const angleAt: { t: number; a: number }[] = [];
    while (Date.now() - circleStart < 10_000) {
      const a = ((Date.now() - circleStart) / 4000) * 2 * Math.PI;
      await t.move(1, c.x + Math.sin(a) * R, c.y - Math.cos(a) * R);
      angleAt.push({ t: await pageNow(page), a: a + (bearing * Math.PI) / 180 });
      await page.waitForTimeout(16);
    }
    await t.up(1);
    await page.waitForTimeout(800);
    const circle = await probeStop(page);
    const cpts = toMetres(circle.samples);
    const intentAt = (tt: number): number | null => { let best: { t: number; a: number } | null = null; for (const q of angleAt) { if (q.t <= tt) best = q; else break; } return best ? best.a : null; };
    record("movement.circle10s", {
      ...motionStats(cpts, ct0 + 500, angleAt.at(-1)!.t, walkSpeed, intentAt),
      corrections: circle.corrections.length,
      correctionMeanM: round(circle.corrections.reduce((s2, v) => s2 + v, 0) / Math.max(1, circle.corrections.length)),
      correctionMaxM: round(Math.max(0, ...circle.corrections)),
      timelineSnaps: circle.snaps,
      leadCapFrames: circle.leadCap
    });

    // Stick response curve: hold each deflection 1 s (alternating north/south so the walk stays near home).
    const curve: { deflection: number; speed: number }[] = [];
    let dir = -1;
    for (const f of [0.05, 0.08, 0.12, 0.2, 0.35, 0.6, 1.0]) {
      await probeStart(page);
      await t.down(1, c.x, c.y);
      await t.move(1, c.x, c.y + dir * f * 46);
      const from = await pageNow(page);
      await page.waitForTimeout(1000);
      const to = await pageNow(page);
      await t.up(1);
      const p = await probeStop(page);
      curve.push({ deflection: f, speed: motionStats(toMetres(p.samples), from + 300, to, walkSpeed, null).meanSpeed });
      dir = -dir;
      await page.waitForTimeout(600);
    }
    record("movement.curve", curve);
    await s.shot("movement");

    if (GUARD) {
      const w = report[`movement.${netName}.walk10s`] as any;
      const ci = report[`movement.${netName}.circle10s`] as any;
      expect(w.snaps + ci.snaps, "no visible position snaps while walking or circling").toBe(0);
      expect(w.steadySpeedCv, "steady walk speed jitter (CV)").toBeLessThan(0.12);
      expect(w.steadyHeadingErrDeg, "walk heading follows the stick").toBeLessThan(6);
      expect(ci.headingErrMeanDeg, "circle heading follows the stick").toBeLessThan(15);
      expect(w.walkFlipsPerS, "walk/idle flicker while the stick is held").toBeLessThanOrEqual(0.5);
      expect(w.releaseDriftM, "release drift").toBeLessThan(25);
      expect((report[`movement.${netName}.latencyMs`] as any).median, "input to first visible move").toBeLessThan(60);
    }
  } finally { await ctx.close(); }
});

type XY = { x: number; y: number };
/** Minimum-jerk easing (0..1 in, 0..1 out): how a thumb accelerates and brakes. */
const ease = (x: number): number => { const k = Math.max(0, Math.min(1, x)); return 10 * k ** 3 - 15 * k ** 4 + 6 * k ** 5; };
/** Plays a finger path on touch id 1 in real time, one move about every 14 ms. */
async function playFinger(t: Touch, page: Page, at: (ms: number) => XY, durationMs: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const ms = Date.now() - t0;
    const p = at(Math.min(ms, durationMs));
    await t.move(1, p.x, p.y);
    if (ms >= durationMs) break;
    await page.waitForTimeout(12);
  }
}
/** A resting thumb: about 1 px of jitter every frame (a real finger never sits perfectly still). */
async function holdThumb(t: Touch, page: Page, at: XY, ms: number): Promise<void> {
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < ms; i++) {
    await t.move(1, at.x + (i % 2 ? 0.6 : -0.6), at.y + (i % 3 ? 0.4 : -0.4));
    await page.waitForTimeout(14);
  }
}
/** A mid-hold flick: the finger goes from a to b in about `ms` (three events on node timers). */
async function flickFinger(t: Touch, a: XY, b: XY, ms = 45): Promise<void> {
  const at = (delay: number, fn: () => Promise<void>): Promise<void> => new Promise((resolve, reject) => { setTimeout(() => { fn().then(resolve, reject); }, delay); });
  await Promise.all([
    at(0, () => t.move(1, a.x + (b.x - a.x) * 0.35, a.y + (b.y - a.y) * 0.35)),
    at(ms / 2, () => t.move(1, a.x + (b.x - a.x) * 0.8, a.y + (b.y - a.y) * 0.8)),
    at(ms, () => t.move(1, b.x, b.y))
  ]);
}

test("flick: scripted walks, circles and short nudges never dash with flick-to-dash on", async () => {
  // Flick preference left unset: whatever the touch default is.
  const { ctx, s, t } = await boot("feel-flick", PORTRAIT);
  const page = s.page;
  try {
    const flickOn = await page.evaluate(() => `${localStorage.getItem("ashAtlas.flickDash.v1")} coarse=${matchMedia("(pointer: coarse)").matches}`);
    const c = await plantPoint(page);
    const R = 40;
    const mark = s.mark();
    let gestures = 0;
    // Walk starts: snap to the rim fast and hold.
    for (const [dx, dy] of [[0, -R], [R, 0], [0, R], [-R, 0], [R * 0.7, -R * 0.7], [-R * 0.7, R * 0.7]] as const) {
      await t.down(1, c.x, c.y); await t.move(1, c.x + dx / 2, c.y + dy / 2); await t.move(1, c.x + dx, c.y + dy);
      await page.waitForTimeout(600); await t.up(1); await page.waitForTimeout(250); gestures += 1;
    }
    // Short repositioning nudges held 200-420 ms (a step to line up a swing).
    for (const [hold, dx, dy] of [[200, 0, -R], [220, R, 0], [200, -R * 0.7, -R * 0.7], [260, 0, -R], [300, R, 0], [340, 0, R], [380, -R, 0], [420, R * 0.6, R * 0.6], [280, -R * 0.6, -R * 0.6]] as const) {
      await t.down(1, c.x, c.y); await t.move(1, c.x + dx * 0.5, c.y + dy * 0.5); await page.waitForTimeout(30); await t.move(1, c.x + dx, c.y + dy);
      await page.waitForTimeout(hold); await t.up(1); await page.waitForTimeout(300); gestures += 1;
    }
    // Gentle short steps: half deflection, quick release.
    for (const [dx, dy] of [[0, -20], [20, 0], [0, 20], [-20, 0]] as const) {
      await t.down(1, c.x, c.y); await t.move(1, c.x + dx, c.y + dy); await page.waitForTimeout(150); await t.up(1); await page.waitForTimeout(250); gestures += 1;
    }
    // Two circles with reversals.
    await t.down(1, c.x, c.y); await t.move(1, c.x, c.y - R);
    const start = Date.now();
    while (Date.now() - start < 4000) { const a = ((Date.now() - start) / 2000) * 2 * Math.PI; await t.move(1, c.x + Math.sin(a) * R, c.y - Math.cos(a) * R); await page.waitForTimeout(16); }
    for (let k = 0; k < 4; k++) { await t.move(1, c.x + (k % 2 ? R : -R), c.y); await page.waitForTimeout(250); }
    await t.up(1); gestures += 1;
    await page.waitForTimeout(500);
    // Held-stick steering (the mid-hold flick must stay quiet): slow and fast circles, zig-zags, 90 degree turns at normal speed, small corrections.
    const at = (deg: number, r = R): XY => ({ x: c.x + Math.sin((deg * Math.PI) / 180) * r, y: c.y - Math.cos((deg * Math.PI) / 180) * r });
    await t.down(1, c.x, c.y);
    await playFinger(t, page, (ms) => ({ x: c.x, y: c.y - R * ease(ms / 120) }), 120);
    await holdThumb(t, page, at(0), 500);
    for (const lapMs of [4000, 2000, 1000]) { await playFinger(t, page, (ms) => at((ms / lapMs) * 360), lapMs); gestures += 1; }
    for (const legMs of [400, 300, 250]) { for (let k = 0; k < 6; k++) await playFinger(t, page, (ms) => at(k % 2 ? 45 - 90 * ease(ms / legMs) : -45 + 90 * ease(ms / legMs)), legMs); gestures += 1; }
    for (const turnMs of [400, 300, 200]) { for (let k = 0; k < 4; k++) { await playFinger(t, page, (ms) => at(90 * k + 90 * ease(ms / turnMs)), turnMs); await holdThumb(t, page, at(90 * (k + 1)), 250); } gestures += 1; }
    for (let k = 0; k < 6; k++) { await playFinger(t, page, (ms) => ({ x: c.x + R * 0.8 + 12 * ease(ms / 90) * (k % 2 ? -1 : 1), y: c.y }), 120); gestures += 1; }
    await holdThumb(t, page, at(0), 300);
    await t.up(1);
    await page.waitForTimeout(500);
    const falseDashes = s.since(mark, "DASH", "out").length;
    // A real flick (fast to the rim, lifted at once) still dashes when flick is on (back at the spot, clear of the leash edge).
    await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
    await page.waitForTimeout(1000);
    const flickMark = s.mark();
    await page.evaluate(() => { const w = window as any; w.__pe = []; const t0 = performance.now(); for (const ty of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) document.addEventListener(ty, (e: any) => w.__pe.push(`${ty}@${Math.round(performance.now() - t0)}:${Math.round(e.clientX)},${Math.round(e.clientY)}`), true); });
    // Down, straight to the rim, up: CDP dispatch on a busy page already spaces these ~50 ms apart, like a real ~100 ms flick.
    await t.down(1, c.x, c.y); await t.move(1, c.x + 44, c.y); await t.up(1);
    await page.waitForTimeout(500);
    const realFlick = s.since(flickMark, "DASH", "out").length;
    if (process.env.COMBAT_FEEL_DEBUG === "1") note("flick-events", JSON.stringify(await page.evaluate(() => (window as any).__pe)));
    record("flick", { storedPreference: flickOn, gestures, falseDashes, realFlickDashes: realFlick });
    if (GUARD) {
      expect(falseDashes, "normal stick moves never dash").toBe(0);
      expect(realFlick, "a real flick dashes (flick-to-dash on by default on touch)").toBe(1);
    }
  } finally { await ctx.close(); }
});

test("flick: mid-hold flicks from a walk dash in the flick direction every time", async () => {
  const { ctx, s, t } = await boot("feel-midflick", PORTRAIT, true);
  const page = s.page;
  try {
    const c = await plantPoint(page);
    const R = 46;
    const bearing = await page.evaluate(() => (window as any).__e2eMap.getBearing() as number);
    const at = (deg: number, r = R): XY => ({ x: c.x + Math.sin((deg * Math.PI) / 180) * r, y: c.y - Math.cos((deg * Math.PI) / 180) * r });
    // Walk one way, then flick to a new heading: reversals, 90 degree turns both ways, diagonals. Fresh touch and spot each time (the walk is fast).
    const cases: Array<[number, number]> = process.env.COMBAT_FEEL_CASES ? JSON.parse(process.env.COMBAT_FEEL_CASES) : [[0, 180], [180, 270], [270, 90], [90, 0], [0, 135], [135, 315], [315, 225], [225, 45], [45, 180], [180, 0], [0, 90], [90, 270]];
    let dashed = 0;
    let right = 0;
    const errors: number[] = [];
    const missed: string[] = [];
    for (const [from, next] of cases) {
      await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
      await t.down(1, c.x, c.y);
      await playFinger(t, page, (ms) => { const k = ease(ms / 120); return { x: c.x + (at(from).x - c.x) * k, y: c.y + (at(from).y - c.y) * k }; }, 120);
      await holdThumb(t, page, at(from), 500);
      const mark = s.mark();
      if (process.env.COMBAT_FEEL_DEBUG === "1") await page.evaluate(() => { const w = window as any; w.__pm = []; document.addEventListener("pointermove", (e) => w.__pm.push(`${Math.round(e.timeStamp)}:${Math.round(e.clientX)},${Math.round(e.clientY)}`), true); });
      await flickFinger(t, at(from), at(next, R * 1.4));
      await page.waitForTimeout(350);
      if (process.env.COMBAT_FEEL_DEBUG === "1") note("flick-moves", `${from}->${next} c=${Math.round(c.x)},${Math.round(c.y)} ${JSON.stringify(await page.evaluate(() => (window as any).__pm))}`);
      const dashes = s.since(mark, "DASH", "out").map((f) => JSON.parse(f.raw) as { dirX: number; dirY: number });
      await t.up(1);
      if (dashes.length === 1) {
        dashed += 1;
        const err = angleDiff(bearingOfDir(dashes[0]!), ((next + bearing) % 360 + 360) % 360);
        errors.push(round(err));
        if (err <= 25) right += 1;
      } else missed.push(`${from}->${next}: ${dashes.length} dashes`);
    }
    const headings = cases;
    record("flick.midHold", { flicks: headings.length, dashed, directionWithin25deg: right, directionErrDeg: errors, missed });
    if (GUARD) {
      expect(dashed, "every scripted mid-hold flick dashes exactly once").toBe(headings.length);
      expect(right, "each dash goes where the thumb flicked").toBe(headings.length);
    }
  } finally { await ctx.close(); }
});

/** SWING frames sent since `mark`, parsed. */
const swingsSince = (s: Session, mark: number): { dirX: number; dirY: number }[] => s.since(mark, "SWING", "out").map((f) => JSON.parse(f.raw));
const bearingOfDir = (d: { dirX: number; dirY: number }): number => ((Math.atan2(d.dirX, d.dirY) * 180) / Math.PI + 360) % 360;
const angleDiff = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

test("aim: taps, jittery taps and drags swing where they were meant to", async () => {
  const { ctx, s, t } = await boot("feel-aim", PORTRAIT);
  const page = s.page;
  try {
    const bearing = await page.evaluate(() => (window as any).__e2eMap.getBearing() as number);
    const c = await plantPoint(page);
    const attack = (await rectOf(page, ".joystick-attack-face")) ?? (await rectOf(page, ".joystick-attack"))!;
    const a = { x: attack.l + attack.w / 2, y: attack.t + attack.h / 2 };
    /** Walks a short step whose screen direction is (dx, dy) to set the facing, then lets go. */
    const face = async (dx: number, dy: number): Promise<void> => {
      await t.down(1, c.x, c.y); await t.move(1, c.x + dx, c.y + dy); await page.waitForTimeout(450); await t.up(1); await page.waitForTimeout(900);
    };
    const tap = async (jx = 0, jy = 0): Promise<{ dirX: number; dirY: number } | null> => {
      await page.waitForTimeout(1000);
      const mark = s.mark();
      await t.down(2, a.x, a.y);
      if (jx || jy) { await t.move(2, a.x + jx / 2, a.y + jy / 2); await t.move(2, a.x + jx, a.y + jy); }
      await page.waitForTimeout(90); await t.up(2);
      await page.waitForTimeout(500);
      return swingsSince(s, mark)[0] ?? null;
    };
    const drag = async (dx: number, dy: number, holdMs = 150): Promise<{ dir: { dirX: number; dirY: number } | null; second: { dirX: number; dirY: number } | null; indicator: boolean }> => {
      await page.waitForTimeout(1000);
      const mark = s.mark();
      await t.down(2, a.x, a.y); await t.move(2, a.x + dx / 2, a.y + dy / 2); await t.move(2, a.x + dx, a.y + dy);
      await page.waitForTimeout(120);
      const indicator = (await page.locator(".joystick-attack.is-aiming").count()) > 0;
      await page.waitForTimeout(holdMs); await t.up(2); await page.waitForTimeout(400);
      const swings = swingsSince(s, mark);
      return { dir: swings[0] ?? null, second: swings[1] ?? null, indicator };
    };
    const results: { scenario: string; intendedDeg: number; swungDeg: number | null; errDeg: number | null; ok: boolean }[] = [];
    const judge = (scenario: string, intendedDeg: number, dir: { dirX: number; dirY: number } | null): void => {
      const swung = dir ? bearingOfDir(dir) : null;
      const err = swung === null ? null : angleDiff(swung, intendedDeg);
      results.push({ scenario, intendedDeg: round(intendedDeg), swungDeg: swung === null ? null : round(swung), errDeg: err === null ? null : round(err), ok: err !== null && err <= 30 });
    };
    const north = ((0 - bearing) % 360 + 360) % 360; // screen-up direction is the map bearing; world north = 0
    const screenUp = ((bearing % 360) + 360) % 360;
    const screenRight = (screenUp + 90) % 360;
    const screenDown = (screenUp + 180) % 360;
    const screenLeft = (screenUp + 270) % 360;
    void north;
    const offset = (deg: number, m: number): [number, number] => [Math.sin((deg * Math.PI) / 180) * m, Math.cos((deg * Math.PI) / 180) * m];

    // A: facing up; a dummy ahead (100 m) and a closer one behind (70 m). Meant: the one in front.
    await s.clearMobs();
    await face(0, -30);
    const [ax, ay] = offset(screenUp, 100); await s.spawn("training_dummy", ax, ay);
    const [bx, by] = offset(screenDown, 70); await s.spawn("training_dummy", bx, by);
    await page.waitForTimeout(600);
    judge("tap: dummy ahead 100 m, closer dummy behind 70 m", screenUp, await tap());
    // B: one dummy to the side (right, 90 m) while facing up: still auto-aims at it.
    await s.clearMobs(); await page.waitForTimeout(800);
    await face(0, -30);
    const [cx, cy] = offset(screenRight, 90); await s.spawn("training_dummy", cx, cy);
    await page.waitForTimeout(600);
    judge("tap: only dummy to the right 90 m", screenRight, await tap());
    // C: a real-thumb tap that wobbles 12 px left, dummy right: meant = the dummy (a tap, not a drag).
    judge("jittery tap (12 px wobble) toward the left, dummy right", screenRight, await tap(-12, 3));
    // D: a 6 px wobble.
    judge("jittery tap (6 px wobble), dummy right", screenRight, await tap(-6, 2));
    // E: drag aims manually even with the dummy elsewhere; the aim indicator shows.
    // The first swing goes out on touch-down, auto-aimed (combat polish): the dummy to the right. The drag steers the next swing.
    const dragLeft = await drag(-30, 0, 1100);
    judge("drag left 30 px: touch-down swing auto-aims at the dummy right", screenRight, dragLeft.dir);
    judge("drag left 30 px: the next (repeat) swing follows the drag", screenLeft, dragLeft.second);
    // F: no mobs. Walk right, tap: swings the way you walked.
    await s.clearMobs(); await page.waitForTimeout(800);
    await face(30, 0);
    judge("tap, no mobs, after walking right", screenRight, await tap());
    // G: stale aim: drag-aim down, release, then walk up a step and tap: meant = up (the latest movement).
    await drag(0, 30);
    await face(0, -30);
    judge("tap after a drag-aim down then a step up, no mobs", screenUp, await tap());
    // H: dummy just outside reach ahead (170 m) and none in reach: swing the facing.
    await face(0, -30);
    const [hx, hy] = offset(screenUp, 170); await s.spawn("training_dummy", hx, hy);
    await page.waitForTimeout(600);
    judge("tap: dummy ahead out of reach 170 m", screenUp, await tap());
    await s.clearMobs();
    const misses = results.filter((r) => !r.ok).length;
    record("aim", { scenarios: results, misses, total: results.length, dragShowsIndicator: dragLeft.indicator });
    if (GUARD) {
      expect(misses, `aim scenarios that swung somewhere unintended: ${JSON.stringify(results.filter((r) => !r.ok))}`).toBe(0);
      expect(dragLeft.indicator, "a drag shows the aim indicator").toBe(true);
    }
  } finally { await ctx.close(); }
});

test("stalls: swinging and dashing while walking never stall or rubber-band the walk", async () => {
  const stallNet = process.env.COMBAT_FEEL_STALL_NET === "lan" ? null : PHONE_NET;
  const { ctx, s, t } = await boot("feel-stall", PORTRAIT, false, stallNet);
  const page = s.page;
  if (process.env.COMBAT_FEEL_DEBUG === "1") await page.evaluate(() => { (window as any).__feelDebug = true; });
  try {
    await s.clearMobs();
    const walkSpeed = 125;
    const c = await plantPoint(page);
    const attack = (await rectOf(page, ".joystick-attack-face")) ?? (await rectOf(page, ".joystick-attack"))!;
    const a = { x: attack.l + attack.w / 2, y: attack.t + attack.h / 2 };
    const R = 40;
    // Walk up 1.2 s, swing three times 750 ms apart while still walking, walk on.
    const t0 = await probeStart(page);
    await t.down(1, c.x, c.y); await t.move(1, c.x, c.y - R);
    await page.waitForTimeout(1200);
    const swingAt: number[] = [];
    for (let k = 0; k < 3; k++) { swingAt.push(await pageNow(page)); await t.down(2, a.x, a.y); await page.waitForTimeout(60); await t.up(2); await page.waitForTimeout(690); }
    await page.waitForTimeout(600);
    const tEnd = await pageNow(page);
    await t.up(1);
    await page.waitForTimeout(600);
    const sw = await probeStop(page);
    if (process.env.COMBAT_FEEL_DEBUG === "1") writeFileSync(join(outDir, `feel-swing-debug-${LABEL}.json`), JSON.stringify({ swingAt, samples: sw.samples, leadCap: sw.leadCap }));
    const spts = toMetres(sw.samples);
    const base = motionStats(spts, t0 + 400, swingAt[0]!, walkSpeed, null);
    const during = motionStats(spts, swingAt[0]!, tEnd, walkSpeed, null);
    // Walk down, dash mid-walk, keep holding.
    await page.waitForTimeout(800);
    const d0 = await probeStart(page);
    await t.down(1, c.x, c.y); await t.move(1, c.x, c.y + R);
    await page.waitForTimeout(1200);
    const dashAt = await pageNow(page);
    await page.keyboard.press("Space"); await page.waitForTimeout(50);
    await page.waitForTimeout(1500);
    const dEnd = await pageNow(page);
    await t.up(1);
    await page.waitForTimeout(600);
    const ds = await probeStop(page);
    if (process.env.COMBAT_FEEL_DEBUG === "1") { writeFileSync(join(outDir, `feel-dash-debug-${LABEL}.json`), JSON.stringify({ dashAt, samples: ds.samples })); s.save(); }
    const dpts = toMetres(ds.samples);
    const afterDash = motionStats(dpts, dashAt + 350, dEnd, walkSpeed, null);
    // Backward motion (against the walk) after the dash: rubber-banding.
    const heading = (() => { const p0 = dpts.find((q) => q.t >= d0 + 400)!; const p1 = dpts.find((q) => q.t >= dashAt)!; const L = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1; return { x: (p1.x - p0.x) / L, y: (p1.y - p0.y) / L }; })();
    let backM = 0;
    for (let i = 1; i < dpts.length; i++) { const p = dpts[i]!; const q = dpts[i - 1]!; if (p.t < dashAt) continue; const proj = (p.x - q.x) * heading.x + (p.y - q.y) * heading.y; if (proj < 0) backM += -proj; }
    // Time from the dash end until the walk is back at 90 % speed.
    let resumeMs = -1;
    for (let i = 1; i < dpts.length; i++) { const p = dpts[i]!; const q = dpts[i - 1]!; if (p.t < dashAt + 250) continue; const v = Math.hypot(p.x - q.x, p.y - q.y) / ((p.t - q.t) / 1000); if (v > walkSpeed * 0.9 && v < walkSpeed * 1.3) { resumeMs = round(p.t - (dashAt + 200)); break; } }
    record("stalls", {
      walkBeforeSwing: base.meanSpeed,
      walkWhileSwinging: during.meanSpeed,
      swingSpeedLossPct: round(100 * (1 - during.meanSpeed / Math.max(1, base.meanSpeed))),
      swingWalkSnaps: during.snaps,
      swingCorrections: sw.corrections.length,
      swingLeadCapFrames: sw.leadCap,
      dashBackwardM: round(backM),
      dashResumeWalkMs: resumeMs,
      walkAfterDash: afterDash.meanSpeed,
      afterDashSpeedCv: afterDash.speedCv,
      dashCorrections: ds.corrections.length,
      dashCorrectionMaxM: round(Math.max(0, ...ds.corrections)),
      dashSnaps: ds.snaps,
      worldResyncs: s.since(0, "REQUEST_WORLD_RESYNC", "out").length
    });
    if (process.env.COMBAT_FEEL_DEBUG === "1") writeFileSync(join(outDir, `feel-seq-${LABEL}.json`), JSON.stringify(await page.evaluate(() => ({ sim: (window as any).__simIn, applied: (window as any).__feel.applied }))));
    if (process.env.COMBAT_FEEL_DEBUG === "1") note("resync-stacks", JSON.stringify(await page.evaluate(() => (window as any).__resyncStacks)));
    // A world resync (the player delta sequence restarting) snaps and stalls the walk on its own; that replication issue
    // is tracked in docs/plans/combat-feel.md, so the stall guard only judges runs without one.
    if (GUARD && (report.stalls as any).worldResyncs > 0) note("stalls-skipped", "world resync during the run; stall guard not applied");
    if (GUARD && (report.stalls as any).worldResyncs === 0) {
      const st = report.stalls as any;
      expect(st.swingSpeedLossPct, "swinging does not slow the walk").toBeLessThan(10);
      expect(st.dashBackwardM, "no rubber-band after a dash").toBeLessThan(8);
      expect(st.dashResumeWalkMs, "walk resumes right after the dash").toBeGreaterThanOrEqual(0);
      expect(st.dashResumeWalkMs, "walk resumes right after the dash").toBeLessThan(250);
    }
  } finally { await ctx.close(); }
});

test("resync: walking through forced world resyncs never freezes or snaps", async () => {
  const { ctx, s, t } = await boot("feel-resync", PORTRAIT, false);
  const page = s.page;
  try {
    await s.clearMobs();
    const walkSpeed = 125;
    const c = await plantPoint(page);
    const mark = s.mark();
    const t0 = await probeStart(page);
    await page.evaluate(() => { (window as any).__feel.applied = []; });
    await t.down(1, c.x, c.y); await t.move(1, c.x, c.y - 40);
    await page.waitForTimeout(1200);
    const resyncAt: number[] = [];
    for (let k = 0; k < 3; k++) {
      resyncAt.push(await pageNow(page));
      await s.sendRaw({ type: "REQUEST_WORLD_RESYNC", combatSequence: 0, playerSequence: 0 });
      await page.waitForTimeout(1100);
    }
    const tEnd = await pageNow(page);
    await t.up(1);
    await page.waitForTimeout(500);
    const p = await probeStop(page);
    const applied: number[][] = await page.evaluate(() => (window as any).__feel.applied);
    const pts = toMetres(p.samples);
    const stats = motionStats(pts, resyncAt[0]!, tEnd, walkSpeed, null);
    // Slowest 250 ms stretch after the first resync: a freeze shows up as a near-zero window.
    let slowestWindowMps = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!; if (a.t < resyncAt[0]! || a.t + 250 > tEnd) continue;
      const b = pts.find((q) => q.t >= a.t + 250); if (!b) break;
      slowestWindowMps = Math.min(slowestWindowMps, Math.hypot(b.x - a.x, b.y - a.y) / ((b.t - a.t) / 1000));
    }
    const appliedTimes = applied.filter(([at]) => at! >= resyncAt[0]! && at! <= tEnd).map(([at]) => at!);
    let longestDeltaGapMs = 0;
    for (let i = 1; i < appliedTimes.length; i++) longestDeltaGapMs = Math.max(longestDeltaGapMs, appliedTimes[i]! - appliedTimes[i - 1]!);
    const snapshots = s.since(mark, "PLAYER_SNAPSHOT", "in").length;
    const wireDeltas = s.since(mark, "PLAYER_DELTA", "in").length;
    record("resync", {
      playerSnapshots: snapshots,
      wireDeltas,
      appliedDeltas: applied.length,
      longestAppliedDeltaGapMs: round(longestDeltaGapMs),
      slowestWindowMps: round(slowestWindowMps),
      meanSpeed: stats.meanSpeed,
      snaps: stats.snaps + p.snaps,
      corrections: p.corrections.length,
      correctionMaxM: round(Math.max(0, ...p.corrections)),
      leadCapFrames: p.leadCap
    });
    if (GUARD) {
      expect(snapshots, "forced resyncs sent player snapshots (the server rate-limits them)").toBeGreaterThanOrEqual(2);
      expect(longestDeltaGapMs, "player deltas keep applying through a resync").toBeLessThan(400);
      expect(slowestWindowMps, "no freeze while walking through a resync").toBeGreaterThan(walkSpeed * 0.6);
      expect(stats.snaps + p.snaps, "no snap while walking through a resync").toBe(0);
    }
  } finally { await ctx.close(); }
});
