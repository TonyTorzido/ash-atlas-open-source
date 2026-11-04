/**
 * Frame capture for the vault polish pass (title card, wall hit, fall + respawn, Pell bubble, solve + door).
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> ASH_ATLAS_E2E_OUT=<dir> pnpm exec playwright test --config playwright-full-app.config.ts vaultPolishEvidence
 */
import { test, chromium } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { launch, outDir } from "./e2eSession.js";

const lastDungeon = (s: any): any | null => {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir === "in" && f.type === "DUNGEON_SNAPSHOT") {
      const m = JSON.parse(f.raw);
      if (m.snapshot?.snapshotKind === "full" || m.snapshot?.objects) return m.snapshot;
    }
  }
  return null;
};
const locRevision = (s: any): number => {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir !== "in" || !f.raw.includes("\"location\"")) continue;
    try { const rev = JSON.parse(f.raw).location?.revision; if (typeof rev === "number") return rev; } catch { /* not json */ }
  }
  return 0;
};

const AUTOPILOT = `(() => {
  const hp = window.__heartPuzzle; const rt = hp.runtime; const hub = hp.hub();
  const passable = (s, kind, cx, cy) => { if (cx<0||cy<0||cx>=s.cols||cy>=s.rows) return false; const c=s.cells[cy*s.cols+cx]; if (c==='#'||c==='o') return false; if (c==='w') return kind!=='light'; if ((c==='v'||c==='h')&&kind!=='light') return false; return true; };
  const path = (s, m, tx, ty) => { const key=(x,y)=>y*s.cols+x; const start=[Math.floor(m.x),Math.floor(m.y)]; const prev=new Map([[key(...start),null]]); const q=[start];
    while(q.length){const [x,y]=q.shift(); if(x===tx&&y===ty)break; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy; if(prev.has(key(nx,ny))||!passable(s,m.kind,nx,ny))continue; prev.set(key(nx,ny),[x,y]); q.push([nx,ny]);}}
    const out=[]; let cur=[tx,ty]; while(cur){out.unshift(cur); cur=prev.get(key(...cur));} return out; };
  window.__autopilot = { stop: false };
  window.__autopilot.timer = setInterval(() => {
    const s = rt.state; if (!s || window.__autopilot.stop) { hub.setDragOffset(null); return; }
    const m = s.marbles[0]; const goal = s.goal; if (s.status==='won'||!goal||m.falling) { if (s.status==='won') hub.setDragOffset(null); return; }
    const p = path(s, m, Math.floor(goal.x), Math.floor(goal.y)); const aim = p[Math.min(1,p.length-1)];
    const ex=(aim[0]+0.5-m.x)*3.2-m.vx*1.3, ey=(aim[1]+0.5-m.y)*3.2-m.vy*1.3; const mag=Math.hypot(ex,ey)||1; const k=Math.min(1,mag)/mag;
    hub.setDragOffset({ x: ex*k*50/0.8, y: ey*k*50/0.8 });
  }, 16);
})()`;

test("vault polish evidence frames", async () => {
  test.setTimeout(400_000);
  const dir = join(outDir, "frames");
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch();
  const { s } = await launch(browser, process.env.VAULT_ACCOUNT ?? "vault-polish-b", { mobile: process.env.VAULT_MOBILE === "1", skipTeleport: true } as any);
  const burst = async (name: string, count: number, gapMs: number): Promise<void> => {
    for (let i = 0; i < count; i++) {
      await s.page.screenshot({ path: join(dir, `${name}-${String(i).padStart(2, "0")}.jpg`), type: "jpeg", quality: 72 });
      await s.page.waitForTimeout(gapMs);
    }
  };
  try {
    await s.page.waitForTimeout(3000);
    if (!lastDungeon(s)) {
      await s.sendRaw({ type: "DEV_SPAWN_DUNGEON_ENTRANCE", templateId: "dungeon:tilted_vault", lat: s.self.lat + 0.00008, lon: s.self.lon });
      await s.until(() => s.frames.some((f: any) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED"), 10_000, "entrance");
      const ent = JSON.parse(s.frames.find((f: any) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED")!.raw).entrance;
      await s.sendRaw({ type: "USE_PORTAL", portalId: ent.portalId, expectedPortalRevision: ent.portalRevision, expectedLocationRevision: locRevision(s) });
    }
    await s.until(() => lastDungeon(s)?.spaceId === "vault_r1", 30_000, "room 1");
    await s.page.waitForFunction(() => !!(window as any).__heartPuzzle?.runtime?.state, undefined, { timeout: 20_000 });
    await s.page.evaluate(() => { (window as any).__heartPuzzle.runtime.devReplay = true; (window as any).__heartPuzzle.runtime.reset(); });
    await s.page.getByRole("button", { name: /got it/i }).click({ timeout: 2000 }).catch(() => undefined);
    await s.page.mouse.move(640, 400);
    for (let i = 0; i < 2; i++) { await s.page.mouse.wheel(0, 400); await s.page.waitForTimeout(150); }
    await s.page.mouse.move(900, 250); await s.page.mouse.down(); await s.page.mouse.move(900, 420, { steps: 12 }); await s.page.mouse.up();
    await s.page.waitForTimeout(500);
    await burst("a-title", 3, 500);
    await s.page.waitForTimeout(2500);
    await burst("b-idle", 1, 0);
    // Pell speaks.
    await s.page.evaluate(() => (window as any).__heartPuzzle.talk("vault_pell_1"));
    await s.page.waitForTimeout(500);
    await burst("c-pell", 2, 400);
    // Wall hit: roll down column 1 into the wall.
    await s.page.evaluate(() => (window as any).__heartPuzzle.hub().setDragOffset({ x: 0, y: 60 }));
    await burst("d-wallhit", 14, 60);
    await s.page.evaluate(() => (window as any).__heartPuzzle.hub().setDragOffset(null));
    await s.page.evaluate(() => (window as any).__heartPuzzle.runtime.reset());
    await s.page.waitForTimeout(600);
    // Fall: roll right along row 1 into the hole.
    await s.page.evaluate(() => (window as any).__heartPuzzle.hub().setDragOffset({ x: 60, y: 0 }));
    await burst("e-fall", 22, 50);
    await s.page.evaluate(() => (window as any).__heartPuzzle.hub().setDragOffset(null));
    await burst("f-respawn", 16, 70);
    // Solve.
    await s.page.evaluate(() => (window as any).__heartPuzzle.runtime.reset());
    await s.page.evaluate(`${AUTOPILOT}`);
    await s.page.waitForFunction(() => (window as any).__heartPuzzle.runtime.state.status === "won", undefined, { timeout: 150_000 });
    await burst("g-solve", 34, 90);
    await s.page.evaluate(() => { (window as any).__autopilot.stop = true; });
  } finally {
    s.save();
    await browser.close();
  }
});
