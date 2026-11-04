/**
 * Developer "Reset Vault run" through the real Developer App: enter a dev-entrance Tilted Vault, open room 1's seal
 * (start at Old Pell, server solve), walk into room 2, then press Reset Vault run. The run must come back at room 1's
 * spawn with every seal closed and nothing completed.
 *
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> ASH_ATLAS_E2E_OUT=<dir> \
 *     pnpm exec playwright test --config playwright-full-app.config.ts vaultDevReset
 */
import { DUNGEON_METERS_PER_COORDINATE, interiorLocalToLngLat } from "@ash-atlas/shared";
import { expect, test, chromium } from "@playwright/test";

import { launch } from "./e2eSession.js";

test("developer Reset Vault run from room 2", async () => {
  test.setTimeout(300_000);
  const browser = await chromium.launch();
  const { s } = await launch(browser, "vault-dev-reset", { skipTeleport: true });
  const snapshots = (): any[] => s.frames.filter((f) => f.dir === "in" && f.type === "DUNGEON_SNAPSHOT").map((f) => JSON.parse(f.raw).snapshot);
  const lastFull = (): any => [...snapshots()].reverse().find((snap) => snap?.objects) ?? null;
  const last = (): any => snapshots().at(-1) ?? null;
  const locRevision = (): number => {
    for (let i = s.frames.length - 1; i >= 0; i--) {
      const f = s.frames[i]!;
      if (f.dir !== "in" || !f.raw.includes("\"location\"")) continue;
      try { const rev = JSON.parse(f.raw).location?.revision; if (typeof rev === "number") return rev; } catch { /* not json */ }
    }
    return 0;
  };
  const toScreen = async (x: number, y: number) => {
    const ll = interiorLocalToLngLat({ x, y }, DUNGEON_METERS_PER_COORDINATE);
    return s.page.evaluate(([lon, lat]) => {
      const map = (window as any).__e2eMap; const p = map.project([lon, lat]); const r = map.getContainer().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    }, [ll.lon, ll.lat] as const);
  };
  const shot = (name: string) => s.page.screenshot({ path: `${process.env.ASH_ATLAS_E2E_OUT}/reset-${name}.jpg`, type: "jpeg", quality: 70 });
  try {
    await s.page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "visible", timeout: 30_000 });
    await s.page.waitForTimeout(2000);
    await s.sendRaw({ type: "DEV_SPAWN_DUNGEON_ENTRANCE", templateId: "dungeon:tilted_vault", lat: s.self.lat + 0.00008, lon: s.self.lon });
    await s.until(() => s.frames.some((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED"), 10_000, "entrance");
    const ent = JSON.parse(s.frames.find((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED")!.raw).entrance;
    await s.sendRaw({ type: "USE_PORTAL", portalId: ent.portalId, expectedPortalRevision: ent.portalRevision, expectedLocationRevision: locRevision() });
    await s.until(() => lastFull()?.spaceId === "vault_r1", 30_000, "room 1");
    await s.page.waitForTimeout(3000);
    // Open room 1's seal: stand by Pell, start, wait out the server minimum, report the solve.
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", sessionId: lastFull().sessionId, x: 420, y: 238 });
    await s.until(() => Math.hypot(last().player.x - 420, last().player.y - 238) < 4, 15_000, "beside Pell");
    await s.sendRaw({ type: "DUNGEON_PUZZLE_ACTIVE", sessionId: lastFull().sessionId, roomId: "vault_r1", active: true });
    await s.until(() => last()?.heartPuzzleActiveRoomId === "vault_r1", 5_000, "locked");
    await s.page.waitForTimeout(7_600);
    await s.sendRaw({ type: "DUNGEON_PUZZLE_SOLVE", sessionId: lastFull().sessionId, roomId: "vault_r1", clientSolveMs: 8000 });
    await s.until(() => lastFull()?.dungeonFlags?.vault_r1_solved === true, 15_000, "door unlocked");
    // Through the door into room 2 (walk beside it, tap it, take it).
    const door = lastFull().objects.find((o: any) => o.portalId && /vault_r1_to_combat_a$/.test(o.portalId));
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", sessionId: lastFull().sessionId, x: 950, y: 600 });
    await s.page.waitForTimeout(4000);
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", sessionId: lastFull().sessionId, x: door.x, y: door.y - 30 });
    await s.page.waitForTimeout(4000);
    const p = await toScreen(door.x, door.y + 60);
    await s.page.mouse.click(p.x, p.y);
    await s.page.getByRole("button", { name: new RegExp(`^${door.interactionLabel ?? "Go Through"}$`, "i") }).last().click({ timeout: 5000 });
    await s.until(() => lastFull()?.spaceId === "vault_r2", 30_000, "room 2");
    await s.page.waitForTimeout(2500);
    await shot("1-room2-before");
    // The Developer App button.
    await s.page.locator("button.developer-tools-trigger").evaluate((el: HTMLElement) => el.click());
    await s.page.getByRole("tab", { name: /Spawning/ }).or(s.page.getByRole("button", { name: /Spawning/ })).first().click({ timeout: 10_000 });
    const mark = s.frames.length;
    await s.page.getByRole("button", { name: /^Reset Vault run$/ }).click({ timeout: 10_000 });
    await s.until(() => s.frames.slice(mark).some((f) => f.dir === "in" && f.type === "DUNGEON_SNAPSHOT" &&
      JSON.parse(f.raw).snapshot?.spaceId === "vault_r1" && JSON.parse(f.raw).snapshot?.objects), 20_000, "reset snapshot");
    const out = s.frames.slice(mark).filter((f) => f.dir === "out").map((f) => f.type);
    expect(out).toContain("DEV_RESET_DUNGEON_RUN");
    const after = lastFull();
    console.log("RESET", JSON.stringify({ spaceId: after.spaceId, player: { x: after.player.x, y: after.player.y }, completed: after.completed,
      seal: after.objects.find((o: any) => o.id === "vault_seal_1")?.state, unlocked: after.dungeonFlags?.vault_r1_solved ?? false,
      lock: after.heartPuzzleActiveRoomId ?? null, errors: s.frames.slice(mark).filter((f) => f.type === "ERROR" || f.type === "DUNGEON_ERROR").map((f) => f.raw) }));
    expect(after.spaceId).toBe("vault_r1");
    expect(after.completed).toBe(false);
    expect(after.objects.find((o: any) => o.id === "vault_seal_1")?.state).not.toBe("on");
    expect(after.dungeonFlags?.vault_r1_solved ?? false).toBe(false);
    await s.page.keyboard.press("Escape");
    await s.page.waitForTimeout(3000);
    await shot("2-room1-after-reset");
  } finally {
    s.save();
    await browser.close();
  }
});
