/**
 * Hurt circles end-to-end check (docs/plans/hurt-circles.md): real headless Chromium against a dev runtime with
 * ACTION_COMBAT_ENABLED=true MOB_TACTICS_ENABLED=true MOB_ARCHETYPES_ENABLED=true (dev tools allowed):
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> pnpm exec playwright test --config playwright-full-app.config.ts hurtCircles
 *
 * Reads the dev-build probe window.__ashHitGeometryProbe that pixiOverlay fills (lifted projectile points, circles drawn).
 * Screenshots go to ASH_ATLAS_E2E_OUT (default <tmpdir>/action-combat-e2e).
 */
import { expect, test, chromium, type Browser } from "@playwright/test";

import { PLAYER_HURT_RADIUS_M } from "@ash-atlas/shared";
import { launch, note, sleep, baseUrl, TEST_SPOT, type Session } from "./e2eSession.js";

test.describe.configure({ mode: "serial", timeout: 150_000 });
test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at an action combat dev runtime");

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => { await browser?.close(); });

type Probe = {
  playerShot?: { ground: { x: number; y: number }; body: { x: number; y: number }; liftPx: number; playerHeightPx: number };
  hurtCircles?: number;
  playerCircle?: { x: number; y: number; radiusPx: number };
};
const probe = (s: Session): Promise<Probe> => s.page.evaluate(() => ({ ...((window as any).__ashHitGeometryProbe ?? {}) }));

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dx = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * 111_320;
  return Math.hypot(dx, dy);
}

async function framePlayer(s: Session, zoomInBy = 0): Promise<void> {
  await s.page.evaluate(({ lat, lon, zoomInBy }) => {
    const m = (window as any).__e2eMap;
    m.jumpTo({ center: [lon, lat], bearing: 0, pitch: 0, ...(zoomInBy ? { zoom: m.getZoom() + zoomInBy } : {}) });
  }, { lat: s.self.lat, lon: s.self.lon, zoomInBy });
  await sleep(300);
}

async function setHurtCircles(s: Session, enabled: boolean): Promise<void> {
  // F1 opens the Developer App (owner only); Developer View holds the display toggles.
  await s.page.keyboard.press("F1");
  const toggle = s.page.getByRole("checkbox", { name: /Show hurt circles/ });
  if (!(await toggle.isVisible({ timeout: 1500 }).catch(() => false))) {
    await s.page.getByPlaceholder("Search tools").fill("Developer View");
    await s.page.getByRole("button", { name: /Developer View/ }).first().click({ timeout: 5000 });
  }
  await toggle.waitFor({ timeout: 10_000 });
  if ((await toggle.isChecked()) !== enabled) await toggle.click();
  if (enabled) await s.shot("dev-view-toggle-on");
  await s.page.getByRole("button", { name: "Done" }).click({ timeout: 5000 });
  await sleep(400);
}

test("1. the dev hurt circle overlay is off by default and toggles from Developer View", async () => {
  const { ctx, s } = await launch(browser, "hurt-circles-toggle");
  try {
    await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
    await s.clearMobs();
    await s.spawn("wolf", 160, 0);
    await framePlayer(s);
    await sleep(600);
    expect((await probe(s)).hurtCircles ?? 0, "off by default").toBe(0);
    await setHurtCircles(s, true);
    // Zoomed in so the circles read in the screenshot.
    await framePlayer(s, 1.5);
    await expect.poll(async () => (await probe(s)).hurtCircles ?? 0, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    const circle = (await probe(s)).playerCircle!;
    note("player-circle", JSON.stringify(circle));
    expect(circle.radiusPx).toBeGreaterThan(2);
    await s.shot("debug-circles");
    await setHurtCircles(s, false);
    await expect.poll(async () => (await probe(s)).hurtCircles ?? 0, { timeout: 5000 }).toBe(0);
  } finally {
    await ctx.close();
  }
});

test("2. an arrow flies at chest height with its shadow on the ground path", async () => {
  const { ctx, s } = await launch(browser, "hurt-circles-shot");
  try {
    await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
    await s.clearMobs();
    await s.ensureWeapon("secondary");
    const dummy = await s.spawn("training_dummy", 60, 150);
    await framePlayer(s, 1.5);
    await sleep(800);
    const at = await s.screenOf(dummy.id);
    const cdp = await ctx.newCDPSession(s.page);
    const frames: string[] = [];
    cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
      frames.push(frame.data);
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await s.page.mouse.move(at.x, at.y - 12);
    await s.page.mouse.down({ button: "right" });
    await sleep(120);
    await s.page.mouse.up({ button: "right" });
    await expect.poll(async () => (await probe(s)).playerShot !== undefined, { timeout: 3000 }).toBe(true);
    await sleep(300);
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    const shot = (await probe(s)).playerShot!;
    note("player-shot", JSON.stringify(shot));
    // Same ground point, art lifted by half the player's drawn height; the shadow is the ground point.
    expect(shot.body.x).toBeCloseTo(shot.ground.x, 3);
    expect(shot.ground.y - shot.body.y).toBeCloseTo(shot.liftPx, 3);
    expect(shot.liftPx / shot.playerHeightPx).toBeGreaterThanOrEqual(0.45);
    expect(shot.liftPx / shot.playerHeightPx).toBeLessThanOrEqual(0.55);
    if (frames.length > 0) {
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const out = process.env.ASH_ATLAS_E2E_OUT ?? join((await import("node:os")).tmpdir(), "action-combat-e2e");
      // Every painted frame around the press (the arrow flies for 150 ms), for picking a mid-flight one.
      frames.forEach((data, index) => writeFileSync(join(out, `hurt-circles-shot-${String(index).padStart(2, "0")}.png`), Buffer.from(data, "base64")));
      note("screencast-frames", String(frames.length));
    }
  } finally {
    await ctx.close();
  }
});

test("3. a managed wolf strike draws its cone short of the reach and lands on the hurt circle", async () => {
  const { ctx, s } = await launch(browser, "hurt-circles-melee");
  try {
    await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
    await s.clearMobs();
    const wolf = await s.spawn("wolf", 120, 0);
    await framePlayer(s);
    // Pull it with one swing (dev-spawned mobs do not acquire on their own).
    await s.clickEntity(wolf.id);
    const mark = s.mark();
    await s.until(() => s.grep(mark, /"abilityId":"melee_windup"/).length > 0, 20_000, "a melee_windup telegraph");
    const frame = s.grep(mark, /"abilityId":"melee_windup"/)[0]!;
    const rangeM = Number(/"abilityId":"melee_windup"[\s\S]{0,600}?"rangeM":([0-9.]+)/.exec(frame.raw)?.[1] ?? Number.NaN);
    const distanceAtWindup = metres(s.self, s.ents.get(wolf.id)!);
    note("melee-windup", `drawn cone ${rangeM.toFixed(1)} m, wolf at ${distanceAtWindup.toFixed(1)} m, hurt radius ${PLAYER_HURT_RADIUS_M.toFixed(1)} m`);
    expect(rangeM).toBeCloseTo(150 - PLAYER_HURT_RADIUS_M, 0);
    // The strike connects (the wolf stands on its engage ring, inside the drawn cone plus the hurt radius).
    await s.until(
      () => s.grep(mark, new RegExp(`"type":"DAMAGE"[^}]*"sourceEntityId":"${wolf.id}"[^}]*"amount":[1-9]`)).length > 0
        || s.grep(mark, new RegExp(`"sourceEntityId":"${wolf.id}"[^}]*"type":"DAMAGE"[^}]*"amount":[1-9]`)).length > 0
        || s.grep(mark, new RegExp(`"amount":[1-9][0-9]*[^}]*"sourceEntityId":"${wolf.id}"`)).length > 0,
      15_000,
      "a landed wolf strike"
    );
    expect(distanceAtWindup).toBeLessThanOrEqual(150 + 1);
    await s.shot("melee-hit");
  } finally {
    await ctx.close();
  }
});
