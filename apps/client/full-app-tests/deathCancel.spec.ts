/**
 * Death cancels attacks end-to-end: a mob removed or killed mid-telegraph loses its decal and lifted shot within 100 ms
 * of the removal frame reaching the app, and the player takes no hit from it afterwards. Run against a feature runtime
 * with ACTION_COMBAT_ENABLED=true MOB_TACTICS_ENABLED=true MOB_ARCHETYPES_ENABLED=true DEV_TOOLS_ENABLED=true:
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> pnpm exec playwright test --config playwright-full-app.config.ts deathCancel
 *
 * The removal is DEV_CLEAR_MOBS (the dev tools have no kill command); the server and client treat it like a defeat:
 * both end in MOB_REMOVED for the mob, which is what cancels its telegraphs. The server defeat path itself is covered
 * by combatEngine.mobDeathCancel.test.ts.
 */
import { expect, test, chromium, type Browser } from "@playwright/test";
import { launch, note, sleep, baseUrl, type Session } from "./e2eSession.js";

test.describe.configure({ mode: "serial", timeout: 150_000 });
test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at an action combat dev runtime");

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => { await browser?.close(); });

type Probe = { telegraphDecals?: number; mobShotLive?: boolean };

async function installRemovalClock(s: Session): Promise<void> {
  await s.page.evaluate(() => {
    const w = window as any;
    w.__removedAt = 0;
    w.__decalsGoneAt = 0;
    const socket = (w.__e2eSockets as WebSocket[]).filter((x) => x.readyState === 1).at(-1)!;
    socket.addEventListener("message", (ev: MessageEvent) => {
      if (!w.__removedAt && typeof ev.data === "string" && ev.data.includes('"MOB_REMOVED"')) {
        w.__removedAt = performance.now();
        const poll = (): void => {
          const probe = w.__ashHitGeometryProbe ?? {};
          if ((probe.telegraphDecals ?? 0) === 0 && !probe.mobShotLive) { w.__decalsGoneAt = performance.now(); return; }
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }
    });
  });
}

async function scenario(archetype: string, east: number, north: number, label: string): Promise<void> {
  const { ctx, s } = await launch(browser, label);
  try {
    const gotIt = s.page.getByRole("button", { name: "Got it" });
    if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
    await s.clearMobs();
    // The shared dev player keeps its health between runs: a dead one respawns first.
    const respawn = s.page.getByRole("button", { name: "Respawn" });
    if (await respawn.isVisible().catch(() => false)) { await respawn.click(); await sleep(2_000); }
    note(label, `player hp ${s.ents.get(s.self.id)?.hp}`);
    await s.page.evaluate(({ lat, lon }) => (window as any).__e2eMap.jumpTo({ center: [lon, lat], bearing: 0, pitch: 0 }), { lat: s.self.lat, lon: s.self.lon });
    await installRemovalClock(s);
    const mob = await s.spawn(archetype, east, north);
    // Ranged mobs wait to be provoked: a right-click on the mob, like mobArchetypes.spec.ts.
    const at = await s.screenOf(mob.id);
    await s.page.mouse.move(at.x, at.y);
    await s.page.mouse.down({ button: "right" });
    await sleep(80);
    await s.page.mouse.up({ button: "right" });
    // Wait until the decal is on screen, then remove the mob in the same page turn: the telegraph is still mid-warning.
    await s.page.waitForFunction(() => ((window as any).__ashHitGeometryProbe?.telegraphDecals ?? 0) > 0, undefined, { timeout: 90_000, polling: "raf" });
    const afterMark = s.mark();
    const decalsAtRemoval = await s.page.evaluate(() => {
      const w = window as any;
      const decals = w.__ashHitGeometryProbe?.telegraphDecals ?? 0;
      const sockets = (w.__e2eSockets as WebSocket[]).filter((x) => x.readyState === 1);
      sockets[sockets.length - 1]!.send(JSON.stringify({ type: "DEV_CLEAR_MOBS", requestId: crypto.randomUUID() }));
      return decals;
    });
    note(label, `decals at removal: ${decalsAtRemoval}`);
    expect(decalsAtRemoval).toBeGreaterThan(0);
    await sleep(800);
    const timing = await s.page.evaluate(() => ({ removedAt: (window as any).__removedAt as number, goneAt: (window as any).__decalsGoneAt as number }));
    expect(timing.removedAt, "no MOB_REMOVED frame reached the app").toBeGreaterThan(0);
    expect(timing.goneAt, "decals never disappeared").toBeGreaterThan(0);
    note(label, `decal gone ${Math.round(timing.goneAt - timing.removedAt)} ms after the removal frame`);
    expect(timing.goneAt - timing.removedAt).toBeLessThanOrEqual(100);

    // Nothing from the removed mob lands afterwards.
    await sleep(3_000);
    const hits = s.grep(afterMark, new RegExp(`"type":"DAMAGE"[^}]*"sourceEntityId":"${mob.id}"`));
    expect(hits, "the removed mob still dealt damage").toHaveLength(0);
    expect((await s.page.evaluate(() => ((window as any).__ashHitGeometryProbe ?? {}) as Probe)).telegraphDecals ?? 0).toBe(0);
  } finally {
    await ctx.close();
  }
}

test("a wolf removed mid-windup loses its decal at once and deals no damage", async () => {
  await scenario("wolf", 110, 0, "death-cancel-wolf");
});

test("a ranged mob removed mid-aim loses its lane and shot at once", async () => {
  await scenario("gnoll_bonebow", 0, 110, "death-cancel-ranged");
});
