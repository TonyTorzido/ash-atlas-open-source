/**
 * Interior parity evidence: overworld vs Tilted Vault (map-rendered dungeon) screenshots, plus joystick presence.
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> ASH_ATLAS_E2E_OUT=<dir> pnpm exec playwright test --config playwright-full-app.config.ts interiorParity
 */
import { expect, test, chromium } from "@playwright/test";

import { launch, TEST_SPOT, type Session } from "./e2eSession.js";

/** A previous run may have left the dev player inside the vault: walk out through its exit portal, then go to the test spot. */
async function leaveInteriorAndTeleport(s: Session): Promise<void> {
  await s.page.waitForTimeout(4000);
  // A previous run may have left the dev player inside the vault: walk out through its exit portal first.
  const dungeon = [...s.frames].reverse().find((f) => f.dir === "in" && f.type === "DUNGEON_SNAPSHOT");
  if (dungeon) {
    const snap = JSON.parse(dungeon.raw).snapshot;
    const exit = snap.objects.find((o: any) => o.portalId && /exit|world/i.test(o.portalId)) ?? snap.objects.find((o: any) => o.portalId);
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", sessionId: snap.sessionId, x: exit.x, y: exit.y });
    await s.page.waitForTimeout(6000);
    await s.sendRaw({ type: "USE_PORTAL", portalId: exit.portalId, expectedLocationRevision: locRevision(s.frames) });
    await s.page.waitForTimeout(6000);
  }
  await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
}

const locRevision = (frames: { dir: string; raw: string }[]): number => {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (f.dir !== "in" || !f.raw.includes("\"location\"")) continue;
    try {
      const rev = JSON.parse(f.raw).location?.revision;
      if (typeof rev === "number") return rev;
    } catch { /* not json */ }
  }
  return 0;
};

test("overworld vs dungeon: same rig and HUD", async () => {
  test.setTimeout(180_000);
  const browser = await chromium.launch();
  const { s } = await launch(browser, "interior-parity", { joystick: true, skipTeleport: true });
  try {
    await leaveInteriorAndTeleport(s);
    const rigs = (): Promise<string> => s.page.evaluate(() => JSON.stringify([...((window as any).__jacketRigs ?? [])].map((r: any) => ({ ready: r.ready, shown: r.root?.visible }))));
    await s.page.waitForTimeout(8000);
    const indicator = s.page.locator("button[class*='offscreen' i]").first();
    if (await indicator.isVisible().catch(() => false)) { await indicator.click(); await s.page.waitForTimeout(2500); }
    console.log("RIGS overworld", await rigs());
    await s.shot("1-overworld");
    const hud = (): Promise<Record<string, number>> => s.page.evaluate(() => ({
      joystick: document.querySelectorAll("[class*='joystick' i]").length,
      offscreen: document.querySelectorAll("[class*='offscreen' i]").length,
      actionBar: document.querySelectorAll("[class*='hotbar' i], [class*='quick-slot' i], [class*='action-bar' i]").length
    }));
    console.log("HUD overworld", JSON.stringify(await hud()));
    await s.sendRaw({ type: "DEV_SPAWN_DUNGEON_ENTRANCE", templateId: "dungeon:tilted_vault", lat: s.self.lat + 0.00008, lon: s.self.lon });
    await s.until(() => s.frames.some((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED"), 10_000, "entrance spawned");
    const ent = JSON.parse(s.frames.find((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED")!.raw).entrance;
    await s.sendRaw({ type: "USE_PORTAL", portalId: ent.portalId, expectedPortalRevision: ent.portalRevision, expectedLocationRevision: locRevision(s.frames) });
    await s.until(() => s.frames.some((f) => f.type === "DUNGEON_SNAPSHOT"), 30_000, "dungeon snapshot");
    await s.page.waitForTimeout(5000);
    console.log("RIGS dungeon", await rigs());
    await s.shot("2-dungeon-idle");
    console.log("HUD dungeon", JSON.stringify(await hud()));
    // Walk with the keyboard (joystick keys) and capture mid-walk.
    await s.page.keyboard.down("d");
    await s.page.waitForTimeout(700);
    await s.shot("3-dungeon-walking");
    await s.page.keyboard.up("d");
    expect(s.errors).toEqual([]);
  } finally {
    s.save();
    await browser.close();
  }
});

/**
 * Manors, the salon and the greenhouse still draw through IndoorPlayerLayer (a separate Pixi canvas). The dev-only
 * "Use legacy indoor dungeon scene" switch mounts the same layer for a dungeon, which the dev account can reach
 * (it owns no manor territory), so this proves that layer now draws the Jacket B rig.
 */
test("legacy indoor layer draws the Jacket B rig", async () => {
  test.setTimeout(180_000);
  const browser = await chromium.launch();
  const { s } = await launch(browser, "interior-parity-legacy", { joystick: true, skipTeleport: true });
  try {
    await leaveInteriorAndTeleport(s);
    await s.sendRaw({ type: "DEV_SPAWN_DUNGEON_ENTRANCE", templateId: "dungeon:tilted_vault", lat: s.self.lat + 0.00008, lon: s.self.lon });
    await s.until(() => s.frames.some((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED"), 10_000, "entrance spawned");
    const ent = JSON.parse(s.frames.find((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED")!.raw).entrance;
    await s.sendRaw({ type: "USE_PORTAL", portalId: ent.portalId, expectedPortalRevision: ent.portalRevision, expectedLocationRevision: locRevision(s.frames) });
    await s.until(() => s.frames.some((f) => f.type === "DUNGEON_SNAPSHOT"), 30_000, "dungeon snapshot");
    await s.page.waitForTimeout(3000);
    await s.page.locator("button.developer-tools-trigger").evaluate((el: HTMLElement) => el.click());
    await s.page.getByRole("tab", { name: /Developer View/ }).or(s.page.getByRole("button", { name: /Developer View/ })).first().click({ timeout: 10_000 });
    await s.page.getByLabel(/Use legacy indoor dungeon scene/).check({ timeout: 10_000 });
    await s.page.keyboard.press("Escape");
    await s.page.waitForTimeout(6000);
    const rigs = await s.page.evaluate(() => JSON.stringify([...((window as any).__jacketRigs ?? [])].map((r: any) => ({ ready: r.ready }))));
    console.log("RIGS legacy indoor layer", rigs, "indoor canvases", await s.page.locator("canvas:not(.maplibregl-canvas)").count());
    await s.shot("6-legacy-indoor-layer");
  } finally {
    s.save();
    await browser.close();
  }
});

/** Swing and dash inside a combat dungeon: mob HP drops in the combat frames and the dash moves the room player. */
test("dungeon combat: swing hits a mob and dash moves the player", async () => {
  test.setTimeout(240_000);
  const browser = await chromium.launch();
  const { s } = await launch(browser, "interior-parity-combat", { joystick: true, skipTeleport: true });
  try {
    await leaveInteriorAndTeleport(s);
    await s.sendRaw({ type: "DEV_SPAWN_DUNGEON_ENTRANCE", templateId: process.env.E2E_DUNGEON_TEMPLATE ?? "dungeon:drowned_city", lat: s.self.lat + 0.00008, lon: s.self.lon });
    await s.until(() => s.frames.some((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED"), 10_000, "entrance spawned");
    const ent = JSON.parse(s.frames.find((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED")!.raw).entrance;
    await s.sendRaw({ type: "USE_PORTAL", portalId: ent.portalId, expectedPortalRevision: ent.portalRevision, expectedLocationRevision: locRevision(s.frames) });
    await s.until(() => s.frames.some((f) => f.type === "DUNGEON_SNAPSHOT"), 30_000, "dungeon snapshot");
    await s.page.waitForTimeout(6000);
    const snapshot = (): any => JSON.parse([...s.frames].reverse().find((f) => f.dir === "in" && f.type === "DUNGEON_SNAPSHOT")!.raw).snapshot;
    console.log("room", snapshot().spaceId, "enemies", snapshot().enemies?.length);
    await s.shot("7-combat-dungeon-enter");
    // Dash with the real keyboard path (Space), east.
    const before = snapshot().player;
    const dashMark = s.mark();
    await s.page.keyboard.down("d");
    await s.page.keyboard.press("Space");
    await s.page.waitForTimeout(400);
    await s.shot("9-combat-dungeon-dash");
    await s.page.keyboard.up("d");
    await s.page.waitForTimeout(1000);
    const accepted = s.since(dashMark, "DASH_ACCEPTED", "in");
    const after = snapshot().player;
    console.log("DASH_ACCEPTED", accepted.length, "moved", Math.round(Math.hypot(after.x - before.x, after.y - before.y)));
    await s.until(() => (snapshot().enemies?.length ?? 0) > 0, 30_000, "a dungeon enemy in the snapshot");
    const snap = snapshot();
    const enemy = snap.enemies[0];
    console.log("enemy", enemy.entityId, enemy.archetypeKey ?? enemy.archetype, Math.round(enemy.x), Math.round(enemy.y), "player", Math.round(snap.player.x), Math.round(snap.player.y));
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", sessionId: snap.sessionId, x: enemy.x - 45, y: enemy.y });
    await s.page.waitForTimeout(5000);
    const me = snapshot().player;
    const live = snapshot().enemies.find((e: any) => e.entityId === enemy.entityId) ?? enemy;
    const hpOf = (): number | null => { const e = snapshot().enemies.find((x: any) => x.entityId === enemy.entityId); return e ? (e.currentHealth ?? e.health ?? null) : null; };
    const hpBefore = hpOf();
    const len = Math.hypot(live.x - me.x, live.y - me.y) || 1;
    const aim = { dirX: (live.x - me.x) / len, dirY: -(live.y - me.y) / len };
    const mark = s.mark();
    for (let i = 0; i < 3; i++) {
      await s.sendRaw({ type: "SWING", seq: 100 + i, ...aim, lagMs: 0 });
      await s.page.waitForTimeout(900);
      if (i === 1) await s.shot("8-combat-dungeon-swing");
    }
    const results = s.since(mark, "SWING_RESULT", "in").map((f) => JSON.parse(f.raw));
    console.log("SWING_RESULT hits", JSON.stringify(results.map((r) => ({ rejected: r.rejected, hits: r.hits?.length }))));
    console.log("enemy hp", hpBefore, "->", hpOf());
    expect(results.some((r) => (r.hits?.length ?? 0) > 0)).toBe(true);
  } finally {
    s.save();
    await browser.close();
  }
});
