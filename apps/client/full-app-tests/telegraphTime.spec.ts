/**
 * Telegraph time (docs/plans/telegraph-time.md): how much of a mob telegraph the phone network eats before the decal
 * shows, against a feature runtime (ACTION_COMBAT_ENABLED, MOB_TACTICS_ENABLED, MOB_ARCHETYPES_ENABLED and
 * DEV_TOOLS_ENABLED; DEV_PLAYERS_INVULNERABLE helps for long runs).
 *
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41264 pnpm exec playwright test --config playwright-full-app.config.ts telegraphTime
 *
 * The runtime runs on this machine, so the server's cast `startTime` / `resolveTime` (Date.now) share the page's clock.
 * For every mob telegraph the page sees, it records when the frame reached the app (after the simulated phone network)
 * and the first animation frame after that (the overlay draws telegraphs every frame from the stored combat state, so
 * the decal is on screen by the second frame). Numbers go to <ASH_ATLAS_E2E_OUT>/telegraph-time.json.
 */
import { expect, test, chromium, type Browser } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, note, outDir, baseUrl } from "./e2eSession.js";

test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at a feature runtime frontend with action combat and tactics on");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const PHONE_NET = { rttMs: Number(process.env.TELEGRAPH_RTT_MS ?? 140), jitterMs: Number(process.env.TELEGRAPH_JITTER_MS ?? 30) };

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => { await browser?.close(); });

type Seen = { abilityId: string; startTime: number; resolveTime: number; durationMs: number; remainingMs: number; rawAt: number; deliveredAt: number; frame2At: number; oneWayMs: number };

test("network delay: server windup start to decal on screen, on the simulated phone network", async () => {
  const { ctx, s } = await launch(browser, "telegraph-time", { viewport: { width: 390, height: 844 }, joystick: true, net: PHONE_NET });
  const gotIt = s.page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  // Listen on the app's side of the simulated network: listeners added through addEventListener only get delayed frames.
  await s.page.evaluate(() => {
    const w = window as any;
    w.__tele = [] as Seen[];
    w.__rtts = [] as number[];
    const known = new Set<string>();
    const rawAt = new Map<string, number>();
    // The client's telegraph compensation (telegraphWindow.ts): half the smoothed PONG round trip, capped at 150 ms.
    let smoothed: number | null = null;
    const oneWay = (): number => (smoothed === null ? 0 : Math.min(150, smoothed / 2));
    const socket = (w.__e2eSockets as WebSocket[]).filter((x) => x.readyState === 1).at(-1)!;
    // Raw arrival (before the simulated phone network holds the frame): server batching + the local socket.
    EventTarget.prototype.addEventListener.call(socket, "message", (ev: Event) => {
      const raw = (ev as MessageEvent).data;
      // The delayed copy of the frame passes this listener too: keep the first (raw) arrival only.
      if (typeof raw === "string" && raw.includes('"telegraphs"') && !rawAt.has(raw)) rawAt.set(raw, Date.now());
    });
    socket.addEventListener("message", (ev: MessageEvent) => {
      const raw = ev.data;
      if (typeof raw === "string" && raw.startsWith('{"type":"PONG"')) {
        try {
          const rtt = performance.now() - JSON.parse(raw).clientTime;
          w.__rtts.push(Math.round(rtt));
          smoothed = smoothed === null ? rtt : smoothed + (rtt - smoothed) * 0.25;
        } catch { /* ignore */ }
        return;
      }
      if (typeof raw !== "string" || !raw.includes('"telegraphs"')) return;
      const deliveredAt = Date.now();
      const arrivedAt = rawAt.get(raw) ?? deliveredAt;
      rawAt.delete(raw);
      let json: any; try { json = JSON.parse(raw); } catch { return; }
      const casts: any[] = [];
      const walk = (v: any, d: number): void => {
        if (!v || typeof v !== "object" || d > 7) return;
        if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
        if (Array.isArray(v.telegraphs)) casts.push(...v.telegraphs);
        for (const k of Object.keys(v)) if (k !== "telegraphs") walk(v[k], d + 1);
      };
      walk(json, 0);
      for (const c of casts) {
        if (!c || typeof c.castInstanceId !== "string" || known.has(c.castInstanceId) || !String(c.encounterId).startsWith("mob:")) continue;
        known.add(c.castInstanceId);
        const row = { abilityId: c.abilityId, startTime: c.startTime, resolveTime: c.resolveTime, durationMs: c.durationMs, remainingMs: c.remainingMs, rawAt: arrivedAt, deliveredAt, frame2At: 0, oneWayMs: oneWay() };
        w.__tele.push(row);
        requestAnimationFrame(() => requestAnimationFrame(() => { row.frame2At = Date.now(); }));
      }
    });
  });
  // A small mixed pack next to the player: melee basics, a swarm, a ranged caster and a charger.
  for (const [kind, east, north] of [["wolf", 160, 0], ["wolf", -160, 0], ["bear", 0, 170], ["hedge_witch", 0, -230], ["hog", 300, 120], ["red_squirrel", 120, -120]] as const) {
    await s.spawn(kind, east, north);
  }
  await s.page.waitForTimeout(Number(process.env.TELEGRAPH_RUN_MS ?? 60_000));
  const rows = (await s.page.evaluate(() => (window as any).__tele)) as Seen[];
  const rtts = (await s.page.evaluate(() => (window as any).__rtts)) as number[];
  await ctx.close();
  expect(rows.length, "no mob telegraphs seen").toBeGreaterThan(5);

  const pct = (xs: number[], p: number): number => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))]!; };
  const stats = (xs: number[]) => ({ n: xs.length, min: Math.round(Math.min(...xs)), median: Math.round(pct(xs, 0.5)), p95: Math.round(pct(xs, 0.95)), max: Math.round(Math.max(...xs)) });
  const byAbility = new Map<string, Seen[]>();
  for (const row of rows) byAbility.set(row.abilityId, [...(byAbility.get(row.abilityId) ?? []), row]);
  const summary = {
    net: PHONE_NET,
    pongRttMs: rtts,
    // Server windup start -> frame reached the page (server tick, delta flush, local socket), before the phone hold.
    startToRawMs: stats(rows.map((r) => r.rawAt - r.startTime)),
    // Server windup start -> frame handed to the app (server batching + one-way network).
    startToDeliveredMs: stats(rows.map((r) => r.deliveredAt - r.startTime)),
    // Server windup start -> second animation frame after delivery (the decal is on screen by then).
    startToVisibleMs: stats(rows.map((r) => r.frame2At - r.startTime)),
    // Time eaten before the server serialized the cast (durationMs - remainingMs).
    serverSideMs: stats(rows.map((r) => r.durationMs - r.remainingMs)),
    // Where the decal would end without compensation (delivery + remainingMs) vs the real server resolve (+ = later).
    uncompensatedEndVsResolveMs: stats(rows.map((r) => r.deliveredAt + r.remainingMs - r.resolveTime)),
    // Where the client's decal ends now (delivery + remainingMs - half the PONG round trip) vs the server resolve.
    decalEndVsResolveMs: stats(rows.map((r) => r.deliveredAt + Math.max(0, r.remainingMs - r.oneWayMs) - r.resolveTime)),
    // Share of the telegraph the player actually sees before the server resolves it.
    visibleShare: stats(rows.map((r) => (100 * (r.resolveTime - r.frame2At)) / r.durationMs)),
    perAbility: Object.fromEntries([...byAbility].map(([id, list]) => [id, {
      durationMs: list[0]!.durationMs,
      startToVisibleMedianMs: Math.round(pct(list.map((r) => r.frame2At - r.startTime), 0.5)),
      visibleMsMedian: Math.round(pct(list.map((r) => r.resolveTime - r.frame2At), 0.5)),
      n: list.length
    }]))
  };
  writeFileSync(join(outDir, "telegraph-time.json"), JSON.stringify({ summary, rows }, null, 2));
  note("telegraph-time", JSON.stringify(summary));
  // The decal must show with most of its time left; the fill is anchored, never restarted (telegraphWindow.ts).
  expect(summary.startToVisibleMs.p95).toBeLessThan(250);
});
