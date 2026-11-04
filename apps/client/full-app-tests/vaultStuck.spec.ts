/**
 * Tilted Vault stuck-run repro (server solves only, no puzzle play):
 *   VAULT_PHASE=complete  enter a fresh vault, server-solve rooms 1-4 (completes the dungeon), stay in room 4.
 *   VAULT_PHASE=leave     (after a backend restart) resume inside the vault and walk out room by room.
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> VAULT_PHASE=complete pnpm exec playwright test --config playwright-full-app.config.ts vaultStuck
 */
import { expect, test, chromium } from "@playwright/test";

import { launch, type Session } from "./e2eSession.js";

const lastDungeon = (s: Session): any | null => {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir === "in" && f.type === "DUNGEON_SNAPSHOT") {
      const m = JSON.parse(f.raw);
      if (m.snapshot?.snapshotKind === "full" || m.snapshot?.objects) return m.snapshot;
    }
  }
  return null;
};
const locRevision = (s: Session): number => {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir !== "in" || !f.raw.includes("\"location\"")) continue;
    try { const rev = JSON.parse(f.raw).location?.revision; if (typeof rev === "number") return rev; } catch { /* not json */ }
  }
  return 0;
};
const errorsSince = (s: Session, mark: number): string[] => s.since(mark, undefined, "in")
  .filter((f) => /ERROR|REFUSED|FAILED/.test(f.type)).map((f) => f.raw.slice(0, 300));

/** Walks to the portal object matching `pattern` in the current room and uses it; returns the new room. */
async function takePortal(s: Session, pattern: RegExp, expectRoom: string | null): Promise<string> {
  const snap = lastDungeon(s);
  const portal = snap.objects.filter((o: any) => o.portalId).find((o: any) => pattern.test(o.portalId));
  console.log("portals in", snap.spaceId, JSON.stringify(snap.objects.filter((o: any) => o.portalId)
    .map((o: any) => ({ portalId: o.portalId, available: o.available, state: o.state }))));
  expect(portal, `portal ${pattern} in ${snap.spaceId}`).toBeTruthy();
  const mark = s.mark();
  await s.sendRaw({ type: "DUNGEON_MOVE_TO", sessionId: snap.sessionId, x: portal.x, y: portal.y });
  await s.page.waitForTimeout(5000);
  await s.sendRaw({ type: "USE_PORTAL", portalId: portal.portalId, expectedLocationRevision: locRevision(s) });
  await s.page.waitForTimeout(6000);
  const errors = errorsSince(s, mark);
  if (errors.length) console.log("ERRORS using", portal.portalId, errors.join("\n"));
  const after = lastDungeon(s);
  console.log("after", portal.portalId, "room", after?.spaceId, "loc", locRevision(s));
  if (expectRoom) expect(after?.spaceId).toBe(expectRoom);
  return after?.spaceId ?? "";
}

test("vault stuck repro", async () => {
  test.setTimeout(400_000);
  const phase = process.env.VAULT_PHASE ?? "complete";
  const browser = await chromium.launch();
  const { s } = await launch(browser, `vault-stuck-${phase}`, { skipTeleport: true });
  try {
    await s.page.waitForTimeout(3000);
    if (phase === "complete") {
      if (!lastDungeon(s)) {
        await s.page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "visible", timeout: 30_000 });
        await s.sendRaw({ type: "DEV_SPAWN_DUNGEON_ENTRANCE", templateId: "dungeon:tilted_vault", lat: s.self.lat + 0.00008, lon: s.self.lon });
        await s.until(() => s.frames.some((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED"), 10_000, "entrance");
        const ent = JSON.parse(s.frames.find((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED")!.raw).entrance;
        await s.sendRaw({ type: "USE_PORTAL", portalId: ent.portalId, expectedPortalRevision: ent.portalRevision, expectedLocationRevision: locRevision(s) });
      }
      await s.until(() => !!lastDungeon(s), 30_000, "inside the vault");
      for (const n of [1, 2, 3, 4]) {
        const room = `vault_r${n}`;
        await s.until(() => lastDungeon(s)?.spaceId === room, 30_000, room);
        await s.page.waitForTimeout(9_000);
        const snap = lastDungeon(s);
        await s.sendRaw({ type: "DUNGEON_PUZZLE_SOLVE", sessionId: snap.sessionId, roomId: room, clientSolveMs: 12_000 });
        await s.page.waitForTimeout(1500);
        const after = lastDungeon(s);
        console.log(room, "solved", JSON.stringify(after.dungeonFlags), "completed", after.completed);
        if (n < 4) await takePortal(s, new RegExp(`vault_r${n}_to_r${n + 1}$`), `vault_r${n + 1}`);
      }
      await s.shot("stuck-complete-r4");
    } else {
      await s.until(() => !!lastDungeon(s), 30_000, "resumed inside the vault");
      const snap = lastDungeon(s);
      console.log("resumed in", snap.spaceId, "completed", snap.completed, "flags", JSON.stringify(snap.dungeonFlags));
      let room = snap.spaceId as string;
      for (let guard = 0; guard < 4 && room !== "vault_r1"; guard++) {
        const n = Number(room.slice(-1));
        room = await takePortal(s, new RegExp(`vault_r${n - 1}_to_r${n}_back$`), `vault_r${n - 1}`);
      }
      const mark = s.mark();
      await takePortal(s, /entrance_to_world$/, null);
      await s.until(() => !lastDungeon(s) || s.since(mark, "PLAYER_LOCATION_SNAPSHOT", "in")
        .some((f) => f.raw.includes("\"kind\":\"world\"")), 15_000, "back in the world");
      console.log("LEFT THE VAULT");
    }
  } finally {
    s.save();
    await browser.close();
  }
});
