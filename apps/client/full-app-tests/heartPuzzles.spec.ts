/**
 * Tilted Vault end to end: spawn the dev entrance, enter, autopilot the room-1 puzzle through the real
 * sensor hub (drag fallback), and confirm via DUNGEON_SNAPSHOT that the door unlocks and room 2 loads.
 *
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<frontend port> pnpm exec playwright test --config playwright-full-app.config.ts heartPuzzles
 */
import { expect, test, chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { baseUrl, launch, outDir, sleep, type Session } from "./e2eSession.js";

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

/** In-page autopilot: BFS path for the first marble, proportional-derivative tilt through the drag-pad input. */
const AUTOPILOT = `(() => {
  const hp = window.__heartPuzzle;
  const rt = hp.runtime; const hub = hp.hub();
  const passable = (s, kind, cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= s.cols || cy >= s.rows) return false;
    const c = s.cells[cy * s.cols + cx];
    if (c === '#' || c === 'o') return false;
    if (c === 'w') return kind !== 'light';
    if ((c === 'v' || c === 'h') && kind !== 'light') return false;
    return true;
  };
  const path = (s, m, tx, ty) => {
    const key = (x, y) => y * s.cols + x;
    const start = [Math.floor(m.x), Math.floor(m.y)];
    const prev = new Map([[key(...start), null]]);
    const q = [start];
    while (q.length) {
      const [x, y] = q.shift();
      if (x === tx && y === ty) break;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (prev.has(key(nx, ny)) || !passable(s, m.kind, nx, ny)) continue;
        prev.set(key(nx, ny), [x, y]); q.push([nx, ny]);
      }
    }
    const out = []; let cur = [tx, ty];
    while (cur) { out.unshift(cur); cur = prev.get(key(...cur)); }
    return out;
  };
  window.__autopilot = { stop: false, log: [] };
  const tick = () => {
    const s = rt.state; if (!s || window.__autopilot.stop) { hub.setDragOffset(null); return; }
    const m = s.marbles[0]; const goal = s.goal;
    if (s.status === 'won' || !goal) { hub.setDragOffset(null); return; }
    const p = path(s, m, Math.floor(goal.x), Math.floor(goal.y));
    // look-ahead: aim at the farthest cell in a straight run so corners are taken cleanly
    let aim = p[Math.min(1, p.length - 1)];
    const tx = aim[0] + 0.5, ty = aim[1] + 0.5;
    const ang = s.angle || 0;
    let ex = (tx - m.x) * 3.2 - m.vx * 1.3, ey = (ty - m.y) * 3.2 - m.vy * 1.3;
    // room-space force -> screen-space tilt (inverse of roomGravity)
    const sx = ex * Math.cos(ang) - ey * Math.sin(ang), sy = ex * Math.sin(ang) + ey * Math.cos(ang);
    const mag = Math.hypot(sx, sy) || 1; const k = Math.min(1, mag) / mag;
    hub.setDragOffset({ x: sx * k * 50 / 0.8, y: sy * k * 50 / 0.8 });
  };
  window.__autopilot.timer = setInterval(tick, 16);
})()`;

const locRevision = (s: Session): number => {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir !== "in" || !f.raw.includes("\"location\"")) continue;
    try {
      const rev = JSON.parse(f.raw).location?.revision;
      if (typeof rev === "number") return rev;
    } catch { /* not json */ }
  }
  return 0;
};
const waitRoom = async (s: Session, room: string, ms = 30_000): Promise<any> => {
  await s.until(() => lastDungeon(s)?.spaceId === room, ms, "dungeon snapshot for " + room);
  return lastDungeon(s);
};

test("Tilted Vault room 1: solve with tilt input, door unlocks, walk to room 2", async () => {
  test.setTimeout(300_000);
  const browser = await chromium.launch();
  const { s } = await launch(browser, "heart-puzzles");
  try {
    await s.sendRaw({ type: "DEV_SPAWN_DUNGEON_ENTRANCE", templateId: "dungeon:tilted_vault", lat: s.self.lat + 0.00008, lon: s.self.lon });
    await s.until(() => s.frames.some((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED"), 10_000, "entrance spawned");
    const ent = JSON.parse(s.frames.find((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED")!.raw).entrance;
    await s.sendRaw({ type: "USE_PORTAL", portalId: ent.portalId, expectedPortalRevision: ent.portalRevision, expectedLocationRevision: locRevision(s) });
    const room1 = await waitRoom(s, "vault_r1");
    console.log("entered", room1.dungeonId, room1.spaceId, "flags", JSON.stringify(room1.dungeonFlags));
    await s.page.waitForFunction(() => !!(window as any).__heartPuzzle?.runtime?.state, undefined, { timeout: 20_000 });
    await s.shot("room1-start");
    // Autopilot through the real sensor hub (drag-pad fallback input).
    await s.page.evaluate(`${AUTOPILOT}`);
    const mark = s.mark();
    await s.until(() => s.since(mark, "DUNGEON_PUZZLE_SOLVE", "out").length > 0, 120_000, "client to report the solve");
    await s.shot("room1-solved");
    await s.until(() => lastDungeon(s)?.dungeonFlags?.vault_r1_solved === true, 15_000, "server to unlock the door (dungeonFlags)");
    const snap = lastDungeon(s);
    console.log("seal state", snap.objects.find((o: any) => o.id === "vault_seal_1")?.state, "flags", JSON.stringify(snap.dungeonFlags));
    await s.page.evaluate(() => { (window as any).__autopilot.stop = true; });
    // Walk to the door and go through.
    const door = snap.objects.find((o: any) => o.kind === "door" || o.kind === "portal" || o.portalId);
    console.log("door object", JSON.stringify(snap.objects.filter((o: any) => o.portalId).map((o: any) => ({ id: o.id, portalId: o.portalId, x: o.x, y: o.y, available: o.available }))));
    expect(door, "door object present").toBeTruthy();
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", sessionId: snap.sessionId, x: door.x, y: door.y });
    await s.page.waitForTimeout(6000);
    const toR2 = snap.objects.filter((o: any) => o.portalId).find((o: any) => /r1_to_r2/.test(o.portalId) && !/_back/.test(o.portalId)) ?? door;
    await s.sendRaw({ type: "USE_PORTAL", portalId: toR2.portalId, expectedLocationRevision: locRevision(s), approach: "immediate" });
    const room2 = await waitRoom(s, "vault_r2");
    console.log("ARRIVED", room2.spaceId);
    await s.page.waitForFunction(() => (window as any).__heartPuzzle?.runtime?.context?.roomId === "vault_r2", undefined, { timeout: 15_000 });
    await s.shot("room2-start");
    expect(room2.spaceId).toBe("vault_r2");
  } finally {
    s.save();
    await browser.close();
  }
});
