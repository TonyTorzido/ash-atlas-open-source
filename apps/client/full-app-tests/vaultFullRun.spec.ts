/**
 * Tilted Vault full run through the real UI: enter from the world entrance, play each room's puzzle with the
 * tilt-pad input (autopilot), walk to each door by double-tapping the floor, tap the door and take it, then walk
 * back out to the world. Screenshots per room; checks that the puzzle card never covers the room.
 *
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> ASH_ATLAS_E2E_OUT=<dir> [VAULT_VIEWPORT=375x812] \
 *     pnpm exec playwright test --config playwright-full-app.config.ts vaultFullRun
 *
 * In room 1 it also walks with the joystick (phones) and double-taps the side wall, and checks the player always
 * stays on the painted floor. VAULT_AUTOPILOT_MS caps each room's autopilot (default 150 s) before the solve is reported.
 *
 * Puzzle flow (2026-10-21): each room is started by tapping Old Pell (his popup, Start). Room 1 also checks that the
 * unsolved board's walls block the player (and do not after the solve), that the player is locked while the puzzle
 * runs, the Quit / Give up path (board reset, unlocked), the locked and glowing door, and a marble-roll frame sheet.
 * On a phone viewport the autopilot tilts with simulated deviceorientation events (gyro only, no pad).
 *
 * Combat rooms (2026-10-21): r1 > combat_a > r2 > combat_b > r3 > combat_c > r4. Each combat door is barred until the
 * room's encounter is cleared (flag combat_X_cleared) and glows after. In combat_a the player first stands still until
 * the mobs kill them and checks Respawn puts them back at that room's start (VAULT_SKIP_DEATH=1 skips it). Rooms are
 * cleared by raw SWING messages at the nearest mob; run the backend with DEV_PLAYER_DAMAGE_MULTIPLIER (e.g. 60) so a
 * fresh test character can do it (it still takes real damage, so it may die and respawn while clearing).
 * Also: Pell's popup shows his lore with Start / Leave, and his farewell opens after the r4 solve.
 */
import {
  cisternWarrensRoomNavigation, dungeonDefinition, parseServerMessage, DUNGEON_METERS_PER_COORDINATE, interiorLocalToLngLat, isIndoorNavigationPointWalkable
} from "@ash-atlas/shared";
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
/** The latest server position (full snapshots and updates both carry the player). */
const lastPlayer = (s: Session): { x: number; y: number } => {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir === "in" && f.type === "DUNGEON_SNAPSHOT") {
      const p = JSON.parse(f.raw).snapshot?.player;
      if (p) return { x: p.x, y: p.y };
    }
  }
  return { x: NaN, y: NaN };
};
const lastSnapshotField = (s: Session, key: string): any => {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir === "in" && f.type === "DUNGEON_SNAPSHOT") { const snap = JSON.parse(f.raw).snapshot; if (snap && key in snap) return snap[key]; }
  }
  return undefined;
};
const locRevision = (s: Session): number => {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir !== "in" || !f.raw.includes("\"location\"")) continue;
    try { const rev = JSON.parse(f.raw).location?.revision; if (typeof rev === "number") return rev; } catch { /* not json */ }
  }
  return 0;
};

const AUTOPILOT = `(() => {
  const hp = window.__heartPuzzle; const rt = hp.runtime; const hub = hp.hub();
  const passable = (s, kind, cx, cy) => { if (cx<0||cy<0||cx>=s.cols||cy>=s.rows) return false; const c=s.cells[cy*s.cols+cx];
    if (c==='#'||c==='o') return false; if (c==='w') return kind!=='light'; if ((c==='v'||c==='h')&&kind!=='light') return false; return true; };
  const path = (s, m, tx, ty) => { const key=(x,y)=>y*s.cols+x; const start=[Math.floor(m.x),Math.floor(m.y)]; const prev=new Map([[key(...start),null]]); const q=[start];
    while(q.length){const [x,y]=q.shift(); if(x===tx&&y===ty)break; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy; if(prev.has(key(nx,ny))||!passable(s,m.kind,nx,ny))continue; prev.set(key(nx,ny),[x,y]); q.push([nx,ny]);}}
    const out=[]; let cur=[tx,ty]; while(cur){out.unshift(cur); cur=prev.get(key(...cur));} return out; };
  window.__autopilot = { stop: false };
  window.__autopilot.timer = setInterval(() => {
    const s = rt.state; if (!s || window.__autopilot.stop) { hub.setDragOffset(null); return; }
    const m = s.marbles[0]; const goal = s.goal; if (s.status==='won'||!goal||m.falling) { if (s.status==='won') hub.setDragOffset(null); return; }
    const p = path(s, m, Math.floor(goal.x), Math.floor(goal.y)); const aim = p[Math.min(1,p.length-1)];
    const ang = s.angle || 0;
    const ex=(aim[0]+0.5-m.x)*3.2-m.vx*1.3, ey=(aim[1]+0.5-m.y)*3.2-m.vy*1.3;
    const sx = ex*Math.cos(ang) - ey*Math.sin(ang), sy = ex*Math.sin(ang) + ey*Math.cos(ang);
    const mag=Math.hypot(sx,sy)||1; const k=Math.min(1,mag)/mag;
    if (window.__vaultGyro) window.__vaultGyro(sx*k*0.8, sy*k*0.8); else hub.setDragOffset({ x: sx*k*50/0.8, y: sy*k*50/0.8 });
  }, 16);
})()`;

/** Phone viewports: a simulated gyroscope. Level (beta 0, gamma 0) until the autopilot leans it; 22 deg = full tilt. */
const GYRO = `(() => {
  window.__gyroTilt = { x: 0, y: 0 };
  window.__vaultGyro = (x, y) => { window.__gyroTilt = { x, y }; };
  setInterval(() => {
    const t = window.__gyroTilt; const deg = 22;
    window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", { alpha: 0, beta: t.y * deg + Math.sign(t.y) * 1.5, gamma: t.x * deg + Math.sign(t.x) * 1.5, absolute: false }));
  }, 30);
})()`;

const viewportEnv = /^(\d+)x(\d+)$/.exec(process.env.VAULT_VIEWPORT ?? "");
const autopilotMs = Number(process.env.VAULT_AUTOPILOT_MS ?? 150_000);
const tag = viewportEnv ? `${viewportEnv[1]}x${viewportEnv[2]}` : "desktop";
/** The 7-room chain: puzzle rooms with a combat room between each pair. Doors are <a>_to_<b> and <a>_to_<b>_back. */
/** VAULT_LAST=3 stops the chain after room 2 (a quick return-trip check without the later fights). */
const CHAIN: readonly string[] = (["vault_r1", "combat_a", "vault_r2", "combat_b", "vault_r3", "combat_c", "vault_r4"] as const)
  .slice(0, Number(process.env.VAULT_LAST ?? 7));
const isCombatRoom = (roomId: string): boolean => roomId.startsWith("combat_");
const nextDoor = (i: number): RegExp => new RegExp(`${CHAIN[i]}_to_${CHAIN[i + 1]}$`);
const backDoor = (i: number): RegExp => new RegExp(`${CHAIN[i - 1]}_to_${CHAIN[i]}_back$`);

test("vault full run through the UI", async () => {
  test.setTimeout(900_000);
  const browser = await chromium.launch();
  const { s } = await launch(browser, `vault-run-${tag}`, viewportEnv
    ? { viewport: { width: Number(viewportEnv[1]), height: Number(viewportEnv[2]) }, skipTeleport: true }
    : { skipTeleport: true });
  const notes: string[] = [];
  const note = (text: string): void => { notes.push(text); console.log(text); };
  const consoleProblems: string[] = [];
  s.page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    consoleProblems.push(`${Math.round(performance.now())} ${m.type()}: ${m.text().slice(0, 400)}`);
    if (consoleProblems.length > 40) consoleProblems.shift();
  });
  /** Room point to page px (through the live map projection). */
  const toScreen = async (x: number, y: number): Promise<{ x: number; y: number }> => {
    const ll = interiorLocalToLngLat({ x, y }, DUNGEON_METERS_PER_COORDINATE);
    return s.page.evaluate(([lon, lat]) => {
      const map = (window as any).__e2eMap; const p = map.project([lon, lat]); const r = map.getContainer().getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    }, [ll.lon, ll.lat] as const);
  };
  const shot = async (name: string): Promise<void> => {
    await s.page.screenshot({ path: `${process.env.ASH_ATLAS_E2E_OUT}/${tag}-${name}.jpg`, type: "jpeg", quality: 70 });
  };
  const dismissPopups = async (): Promise<void> => {
    for (const name of [/got it/i, /^close$/i, /^ok$/i]) {
      // Visible ones only: a hidden match earlier in the DOM must not swallow the click (the phone dock tip).
      await s.page.getByRole("button", { name }).filter({ visible: true }).first().click({ timeout: 1200 }).catch(() => undefined);
    }
  };
  /** The card and the room's on-screen rect must not overlap; the tilt pad and joystick neither. */
  const checkLayout = async (room: any): Promise<void> => {
    const a = await toScreen(0, 0); const b = await toScreen(room.roomWidth, room.roomHeight);
    const rects = await s.page.evaluate(() => Object.fromEntries(
      [".heart-puzzle-hud__card", ".heart-puzzle-hud__pad", ".joystick-move-base", ".version-watermark__copy"].map((sel) => {
        const e = document.querySelector(sel); const r = e?.getBoundingClientRect();
        return [sel, r && r.width > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null];
      })));
    const roomRect = { left: a.x, top: a.y, right: b.x, bottom: b.y };
    console.log("frame readout", JSON.stringify(await s.page.evaluate(() => {
      const map = (window as any).__e2eMap; const r = map.getContainer().getBoundingClientRect();
      return { frame: (window as any).__heartPuzzleFrame, container: [r.left, r.top, r.width, r.height], center: map.getCenter(), zoom: map.getZoom(), now: Date.now() };
    })));
    const over = (r: any, q: any) => r && q && r.left < q.right - 1 && q.left < r.right - 1 && r.top < q.bottom - 1 && q.top < r.bottom - 1;
    const viewport = s.page.viewportSize()!;
    const inView = roomRect.left >= -1 && roomRect.top >= -1 && roomRect.right <= viewport.width + 1 && roomRect.bottom <= viewport.height + 1;
    note(`${room.spaceId} room on screen ${JSON.stringify(roomRect, (_k, v) => typeof v === "number" ? Math.round(v) : v)} inView=${inView} ` +
      `card-over-room=${over(rects[".heart-puzzle-hud__card"], roomRect)} pad-over-room=${over(rects[".heart-puzzle-hud__pad"], roomRect)} ` +
      `card-over-pad=${over(rects[".heart-puzzle-hud__card"], rects[".heart-puzzle-hud__pad"])} pad-over-joystick=${over(rects[".heart-puzzle-hud__pad"], rects[".joystick-move-base"])}`);
    expect(over(rects[".heart-puzzle-hud__card"], roomRect), "puzzle card over the room").toBeFalsy();
    expect(over(rects[".heart-puzzle-hud__pad"], roomRect), "tilt pad over the room").toBeFalsy();
    expect(over(rects[".version-watermark__copy"], roomRect), "version watermark over the room").toBeFalsy();
    expect(inView, "whole room in view").toBe(true);
  };
  const errorsSince = (mark: number, code: string): number =>
    s.since(mark, "DUNGEON_ERROR", "in").filter((f) => f.raw.includes(`"${code}"`)).length;
  /** Crop around a room point into the evidence folder. */
  const crop = async (name: string, x: number, y: number, half = 150): Promise<void> => {
    const c = await toScreen(x, y); const vp = s.page.viewportSize()!;
    const scale = Math.abs((await toScreen(x + 100, y)).x - c.x) / 100 || 1;
    const hw = Math.max(60, half * scale);
    const clip = { x: Math.max(0, c.x - hw), y: Math.max(0, c.y - hw), width: 0, height: 0 };
    clip.width = Math.min(vp.width - clip.x, hw * 2); clip.height = Math.min(vp.height - clip.y, hw * 2);
    await s.page.screenshot({ path: `${process.env.ASH_ATLAS_E2E_OUT}/${tag}-${name}.png`, clip });
  };
  /** Tap Old Pell (walking there when far): his popup opens. */
  const talkToPell = async (roomId: string): Promise<void> => {
    const snap = lastDungeon(s);
    const pell = snap.objects.find((o: any) => /^vault_pell_/.test(o.id));
    expect(pell, `Old Pell in ${roomId}`).toBeTruthy();
    for (let attempt = 0; attempt < 4; attempt++) {
      await dismissPopups();
      const p = await toScreen(pell.x, pell.y);
      await s.page.mouse.click(p.x, p.y);
      const opened = await s.page.getByTestId("pell-text").waitFor({ state: "visible", timeout: 9000 }).then(() => true).catch(() => false);
      if (opened) return;
    }
    await shot(`fail-${roomId}-pell`);
    throw new Error(`Old Pell's popup did not open in ${roomId}`);
  };
  const pressPell = async (label: RegExp): Promise<void> => {
    await s.page.locator(".heart-puzzle-pell").getByRole("button", { name: label }).click({ timeout: 5000 });
  };
  const startPuzzle = async (roomId: string): Promise<void> => {
    await talkToPell(roomId);
    await pressPell(/^start$/i);
    await s.until(() => lastSnapshotField(s, "heartPuzzleActiveRoomId") === roomId, 10_000, `${roomId} active on the server`);
    await s.page.waitForFunction(() => (window as any).__heartPuzzle.runtime.status()?.active === true, undefined, { timeout: 10_000 });
  };
  /** Room 1: walls solid, lock, quit, the door states and the roll sheet. */
  const flowChecks = async (roomId: string): Promise<void> => {
    const snap = lastDungeon(s);
    const door = snap.objects.find((o: any) => o.portalId && /vault_r1_to_combat_a$/.test(o.portalId));
    await crop("r1-door-locked", door.x - 30, door.y + 60);
    // The unsolved board's wall cell (0,0) is solid for the player; the server says so.
    let mark = s.mark();
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", requestId: "e2e-wall-1", sessionId: snap.sessionId, x: 220, y: 350 });
    await s.page.waitForTimeout(1200);
    note(`walls before the solve: BLOCKED_TARGET x${errorsSince(mark, "BLOCKED_TARGET")}`);
    expect(errorsSince(mark, "BLOCKED_TARGET"), "board wall solid before the solve").toBeGreaterThan(0);
    // Talk to Pell: popup with scrolling text, no native scrollbar.
    await talkToPell(roomId);
    const text = await s.page.getByTestId("pell-text").evaluate((e) => {
      const before = e.scrollTop; e.scrollTop = 40; const moved = e.scrollTop; e.scrollTop = before;
      return { scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, moved, scrollbar: getComputedStyle(e).scrollbarWidth, overflow: getComputedStyle(e).overflowY,
        buttons: Array.from(document.querySelectorAll(".heart-puzzle-pell button")).filter((b) => (b as HTMLElement).offsetParent).map((b) => (b.textContent ?? "").trim()).filter(Boolean) };
    });
    note(`pell popup: ${JSON.stringify(text)}`);
    expect(text.scrollbar, "no native scrollbar").toBe("none");
    expect(text.overflow, "Pell text scrolls").toBe("auto");
    expect(text.buttons).toEqual(["Start", "Leave"]);
    const lore = (await s.page.getByTestId("pell-text").innerText()).trim();
    note(`pell lore: ${lore.length} chars "${lore.slice(0, 90)}"`);
    expect(lore.length, "Pell's popup carries his story").toBeGreaterThan(80);
    await shot("r1-pell-popup");
    await pressPell(/^start$/i);
    await s.until(() => lastSnapshotField(s, "heartPuzzleActiveRoomId") === roomId, 10_000, "active");
    const lockedAt = lastPlayer(s);
    // Locked: double-tap and a raw move do nothing; the server rejects the move.
    const away = await toScreen(lockedAt.x - 150, lockedAt.y + 10);
    await s.page.mouse.dblclick(away.x, away.y);
    mark = s.mark();
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", requestId: "e2e-locked-1", sessionId: snap.sessionId, x: lockedAt.x - 100, y: lockedAt.y });
    await s.page.waitForTimeout(2500);
    const still = lastPlayer(s);
    note(`locked: moved ${Math.round(Math.hypot(still.x - lockedAt.x, still.y - lockedAt.y))} units, PUZZLE_LOCKED x${errorsSince(mark, "PUZZLE_LOCKED")}`);
    expect(errorsSince(mark, "PUZZLE_LOCKED"), "server rejects moves while locked").toBeGreaterThan(0);
    expect(Math.hypot(still.x - lockedAt.x, still.y - lockedAt.y), "player stays put while locked").toBeLessThan(8);
    expect(await s.page.locator(".heart-puzzle-hud__pad").count(), "no tilt pad on phones").toBe(viewportEnv ? 0 : 1);
    // Quit path: chip Quit -> Pell popup -> Give up -> board reset, unlocked.
    await s.page.evaluate(`${AUTOPILOT}`);
    await s.page.waitForTimeout(1500);
    await s.page.evaluate(() => { (window as any).__autopilot.stop = true; clearInterval((window as any).__autopilot.timer); });
    const rolled = await s.page.evaluate(() => { const m = (window as any).__heartPuzzle.runtime.state.marbles[0]; return Math.hypot(m.x - m.startX, m.y - m.startY); });
    await s.page.getByTestId("heart-puzzle-quit").click();
    await s.page.getByTestId("pell-text").waitFor({ state: "visible", timeout: 5000 });
    await shot("r1-quit-popup");
    await pressPell(/^give up$/i);
    await s.until(() => (lastSnapshotField(s, "heartPuzzleActiveRoomId") ?? null) === null, 10_000, "unlocked after give up");
    await s.page.waitForTimeout(600);
    const reset = await s.page.evaluate(() => { const rt = (window as any).__heartPuzzle.runtime; const m = rt.state.marbles[0]; return { d: Math.hypot(m.x - m.startX, m.y - m.startY), active: rt.status().active }; });
    note(`quit: marble had rolled ${rolled.toFixed(2)} cells; after Give up ${reset.d.toFixed(2)} cells from start, active=${reset.active}`);
    expect(reset.d, "Give up resets the board").toBeLessThan(0.01);
    expect(reset.active).toBe(false);
    mark = s.mark();
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", requestId: "e2e-unlocked-1", sessionId: snap.sessionId, x: lockedAt.x, y: lockedAt.y + 4 });
    await s.page.waitForTimeout(1200);
    expect(errorsSince(mark, "PUZZLE_LOCKED"), "unlocked after Give up").toBe(0);
  };
  /** Marble-roll frames: crops of the light marble while it rolls. */
  const rollSheet = async (): Promise<void> => {
    const frames: string[] = [];
    for (let i = 0; i < 10; i++) {
      const m = await s.page.evaluate(() => { const st = (window as any).__heartPuzzle.runtime.state; const m = st.marbles[0]; return { x: m.x, y: m.y }; });
      const origin = { x: 180, y: 310 };
      const name = `r1-roll-${String(i).padStart(2, "0")}`;
      await crop(name, origin.x + m.x * 80, origin.y + m.y * 80, 45);
      frames.push(name);
      await s.page.waitForTimeout(90);
    }
    note(`roll frames: ${frames.join(", ")}`);
  };
  /** The player's feet must stay on the room's painted floor. */
  const onFloor = (snap: any): boolean => {
    const dungeon = dungeonDefinition(snap.dungeonId)!;
    return isIndoorNavigationPointWalkable(cisternWarrensRoomNavigation(snap.spaceId, dungeon), { x: snap.player.x, y: snap.player.y });
  };
  /** Joystick walk toward the left wall (where the stick exists) and a double-tap on the back wall: the player moves but never leaves the floor. */
  const walkChecks = async (): Promise<void> => {
    await dismissPopups();
    const before = lastDungeon(s).player;
    const sticks = s.page.locator(".joystick-move-base");
    const stick = await sticks.count() > 0 ? await sticks.first().boundingBox({ timeout: 2000 }).catch(() => null) : null;
    if (stick) {
      const cx = stick.x + stick.width / 2; const cy = stick.y + stick.height / 2;
      await s.page.mouse.move(cx, cy);
      await s.page.mouse.down();
      await s.page.mouse.move(cx - stick.width * 0.45, cy - stick.height * 0.1, { steps: 6 });
      await s.page.waitForTimeout(3500);
      await s.page.mouse.up();
      await s.page.waitForTimeout(800);
      const after = lastDungeon(s);
      const moved = Math.hypot(after.player.x - before.x, after.player.y - before.y);
      note(`joystick: moved ${Math.round(moved)} units to (${Math.round(after.player.x)}, ${Math.round(after.player.y)}) onFloor=${onFloor(after)}`);
      expect(moved, "joystick moves the player").toBeGreaterThan(40);
      expect(onFloor(after), "joystick keeps the player on the floor").toBe(true);
    } else note("joystick: no stick on this layout");
    await dismissPopups();
    // Back to the top corridor first (the unsolved maze walls are solid; an earlier run may have left the player
    // in a maze corridor), then double-tap the right side wall level with it.
    await s.sendRaw({ type: "DUNGEON_MOVE_TO", requestId: "e2e-home", sessionId: lastDungeon(s).sessionId, x: 150, y: 255 });
    await s.until(() => Math.hypot(lastPlayer(s).x - 150, lastPlayer(s).y - 255) < 12, 30_000, "back in the top corridor").catch(() => undefined);
    const start = lastPlayer(s);
    const wall = await toScreen(lastDungeon(s).roomWidth - 20, 255);
    await s.page.mouse.dblclick(wall.x, wall.y);
    await s.page.waitForTimeout(4500);
    const after = { ...lastDungeon(s), player: lastPlayer(s) };
    note(`double-tap on the side wall: player at (${Math.round(after.player.x)}, ${Math.round(after.player.y)}) onFloor=${onFloor(after)}`);
    expect(onFloor(after), "double-tap keeps the player on the floor").toBe(true);
    expect(Math.hypot(after.player.x - start.x, after.player.y - start.y), "double-tap toward the wall still walks").toBeGreaterThan(40);
  };
  /** Double-tap the floor next to a door until the player stands close, then tap the door and take it. */
  const walkThrough = async (pattern: RegExp, nextRoom: string | null): Promise<void> => {
    const snap = lastDungeon(s);
    const door = snap.objects.find((o: any) => o.portalId && pattern.test(o.portalId));
    expect(door, `door ${pattern} in ${snap.spaceId}`).toBeTruthy();
    await dismissPopups();
    for (let attempt = 0; attempt < 4; attempt++) {
      const me = lastPlayer(s);
      if (Math.hypot(me.x - door.x, me.y - door.y) < 90) break;
      const p = await toScreen(door.x, door.y + (door.y > snap.roomHeight / 2 ? -40 : 40));
      await s.page.mouse.dblclick(p.x, p.y);
      await s.page.waitForTimeout(4500);
    }
    await dismissPopups();
    const me = lastPlayer(s);
    note(`${snap.spaceId}: player ${Math.round(Math.hypot(me.x - door.x, me.y - door.y))} units from ${door.id} before the tap`);
    // On the painted door (below a bottom-wall anchor, above a back-wall one): the tap frame covers the door art.
    const p = await toScreen(door.x, door.y + (door.y > snap.roomHeight / 2 ? 60 : -50));
    await s.page.mouse.click(p.x, p.y);
    const label = door.interactionLabel ?? door.label ?? "Go Through";
    const button = s.page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).last();
    const clicked = await button.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!clicked) {
      const top = await s.page.evaluate(([x, y]) => {
        const e = document.elementFromPoint(x, y); const chain: string[] = [];
        for (let n: Element | null = e; n && chain.length < 5; n = n.parentElement) chain.push(`${n.tagName.toLowerCase()}.${String(n.className).split(" ").join(".")}`);
        return chain.join(" < ");
      }, [p.x, p.y] as const);
      note(`element at the door tap (${Math.round(p.x)}, ${Math.round(p.y)}): ${top}`);
      const buttons = await s.page.getByRole("button").allInnerTexts();
      note(`no "${label}" after the door tap; buttons: ${JSON.stringify(buttons.filter((t) => t.trim()).slice(0, 40))}`);
      await shot(`fail-${snap.spaceId}-door`);
      if (!process.env.VAULT_FORCE_PORTAL) throw new Error(`door prompt "${label}" did not open`);
      note("VAULT_FORCE_PORTAL: using USE_PORTAL instead of the door prompt");
      await s.sendRaw({ type: "USE_PORTAL", portalId: door.portalId, expectedLocationRevision: locRevision(s) });
    }
    if (nextRoom) await s.until(() => lastDungeon(s)?.spaceId === nextRoom, 30_000, `arrive in ${nextRoom}`);
  };
  /** Run flags from the latest snapshot that carries them (updates included). */
  const flags = (): Record<string, boolean> => lastSnapshotField(s, "dungeonFlags") ?? lastDungeon(s)?.dungeonFlags ?? {};
  const aliveEnemies = (): any[] => ((lastSnapshotField(s, "enemies") ?? []) as any[]).filter((e) => e.lifeState === "alive");
  const respawnButton = () => s.page.getByRole("button", { name: /^respawn$/i }).filter({ visible: true }).first();
  /** Dead: press Respawn (it enables after the death countdown) and wait for the room snapshot. True when it respawned. */
  const respawnIfDead = async (): Promise<boolean> => {
    if (!(await respawnButton().isVisible().catch(() => false))) return false;
    await respawnButton().click({ timeout: 30_000 });
    await s.page.waitForTimeout(2500);
    return true;
  };
  /** Mid-fight evidence: a shot whenever a telegraph is live (and the Warden's ring when the dev probe sees it). */
  const fightShots = { taken: 0, ring: false, last: 0 };
  const fightShot = async (roomId: string): Promise<void> => {
    const now = Date.now();
    const live = await s.page.evaluate(() => {
      const probe = (window as any).__ashHitGeometryProbe;
      const ring = probe?.mobRing && Date.now() - probe.mobRing.atMs < 200 ? probe.mobRing.frontPx : null;
      return { ring, telegraphs: document.querySelectorAll("canvas").length > 0 };
    }).catch(() => ({ ring: null, telegraphs: false }));
    if (roomId === "combat_c" && !fightShots.ring && live.ring !== null) {
      fightShots.ring = true;
      await shot(`${roomId}-heartbeat-ring`);
      note(`${roomId}: heartbeat ring on screen, front ${Math.round(live.ring)} px`);
      return;
    }
    if (fightShots.taken < 3 && now - fightShots.last > 3500) {
      fightShots.taken += 1;
      fightShots.last = now;
      await shot(`${roomId}-fight-${fightShots.taken}`);
    }
  };
  /** The door to the next room: tapping it before the clear does not take the player through. */
  const doorBarred = async (roomId: string, pattern: RegExp): Promise<void> => {
    const snap = lastDungeon(s);
    const door = snap.objects.find((o: any) => o.portalId && pattern.test(o.portalId));
    expect(door, `door ${pattern} in ${roomId}`).toBeTruthy();
    await crop(`${roomId}-door-barred`, door.x - 40, door.y + 40);
    const mark = s.mark();
    const p = await toScreen(door.x, door.y + (door.y > snap.roomHeight / 2 ? 60 : -50));
    await s.page.mouse.click(p.x, p.y);
    const label = door.interactionLabel ?? "Go Through";
    const offered = await s.page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).last().click({ timeout: 2500 }).then(() => true).catch(() => false);
    note(`${roomId}: door prompt before the clear offered "${label}": ${offered}`);
    await shot(`${roomId}-door-prompt-barred`);
    await s.page.getByRole("button", { name: /^cancel$/i }).filter({ visible: true }).first().click({ timeout: 1500 }).catch(() => undefined);
    await s.page.waitForTimeout(2500);
    const rejected = s.since(mark, undefined, "in").filter((f) => /ERROR/.test(f.type ?? "")).map((f) => f.type);
    note(`${roomId}: door before the clear: available=${door.available} state=${door.state} still in ${lastDungeon(s)?.spaceId}, replies ${JSON.stringify(rejected)}`);
    expect(lastDungeon(s)?.spaceId, `${roomId} door barred until the clear`).toBe(roomId);
  };
  /** Swing at the nearest living mob until the room's clear flag lands (a death respawns and carries on). */
  const clearRoom = async (roomId: string): Promise<void> => {
    const flag = `${roomId}_cleared`;
    const reachUnits = 90 / DUNGEON_METERS_PER_COORDINATE;
    const started = Date.now();
    let seq = Math.floor(Math.random() * 1e6);
    let deaths = 0;
    while (flags()[flag] !== true) {
      if (Date.now() - started > 300_000) { await shot(`fail-${roomId}-clear`); throw new Error(`${roomId} not cleared in 300 s`); }
      if (await respawnIfDead()) { deaths += 1; continue; }
      const enemies = aliveEnemies();
      if (enemies.length === 0) { await s.page.waitForTimeout(600); continue; }
      const me = lastPlayer(s);
      const target = enemies.reduce((a, b) => Math.hypot(a.x - me.x, a.y - me.y) <= Math.hypot(b.x - me.x, b.y - me.y) ? a : b);
      const d = Math.hypot(target.x - me.x, target.y - me.y);
      if (d > reachUnits) {
        const k = Math.max(0, (d - reachUnits * 0.6) / d);
        await s.sendRaw({ type: "DUNGEON_MOVE_TO", sessionId: lastDungeon(s).sessionId, x: me.x + (target.x - me.x) * k, y: me.y + (target.y - me.y) * k });
        await s.page.waitForTimeout(450);
      }
      const now = lastPlayer(s);
      const len = Math.hypot(target.x - now.x, target.y - now.y) || 1;
      await s.sendRaw({ type: "SWING", seq: seq++, dirX: (target.x - now.x) / len, dirY: -(target.y - now.y) / len, lagMs: 0 });
      await fightShot(roomId);
      await s.page.waitForTimeout(720);
    }
    note(`${roomId}: cleared in ${Math.round((Date.now() - started) / 1000)} s with ${deaths} death(s)`);
  };
  /** Stand still among the mobs until they kill the player: Respawn puts them back at this room's start. */
  const deathCheck = async (roomId: string): Promise<void> => {
    const started = Date.now();
    while (!(await respawnButton().isVisible().catch(() => false))) {
      if (Date.now() - started > 150_000) { await shot(`fail-${roomId}-no-death`); throw new Error(`${roomId}: the player never died`); }
      await fightShot(roomId);
      await s.page.waitForTimeout(500);
    }
    await shot(`${roomId}-dead`);
    const snap = lastDungeon(s);
    const spawn = cisternWarrensRoomNavigation(roomId, dungeonDefinition(snap.dungeonId)!).spawn;
    const mark = s.mark();
    await respawnButton().click({ timeout: 30_000 });
    await s.until(() => s.since(mark, "DUNGEON_SNAPSHOT", "in").length > 0, 20_000, "room snapshot after the respawn");
    await s.page.waitForTimeout(2000);
    const at = lastPlayer(s);
    const off = Math.hypot(at.x - spawn.x, at.y - spawn.y);
    note(`${roomId}: died and respawned in ${lastDungeon(s)?.spaceId} at (${Math.round(at.x)}, ${Math.round(at.y)}), ${Math.round(off)} units from the room start`);
    await shot(`${roomId}-respawned`);
    expect(lastDungeon(s)?.spaceId, "respawn stays in the combat room").toBe(roomId);
    expect(off, "respawn at the room's start").toBeLessThan(40);
  };
  /** A combat room: barred door, (combat_a) one death and respawn, the clear, then the glowing door. */
  const combatRoom = async (roomId: string, next: string): Promise<void> => {
    const pattern = new RegExp(`${roomId}_to_${next}$`);
    fightShots.taken = 0;
    fightShots.ring = false;
    if (flags()[`${roomId}_cleared`] !== true) {
      await doorBarred(roomId, pattern);
      // The fight wakes on arrival and may kill the player while the barred door is checked: a wipe resets the fight,
      // which waits for the respawn (back at the room start, a fresh entry that wakes it again).
      // The encounter wakes when the player enters the room's trigger zone (it covers the arrival); walk into the fight.
      await s.sendRaw({ type: "DUNGEON_MOVE_TO", sessionId: lastDungeon(s).sessionId, x: lastDungeon(s).roomWidth / 2, y: lastDungeon(s).roomHeight * 0.55 });
      const wakeDeadline = Date.now() + 45_000;
      while (aliveEnemies().length === 0) {
        if (await respawnIfDead()) { note(`${roomId}: killed before the fight was watched (a wipe); respawned`); continue; }
        if (Date.now() > wakeDeadline) {
          const snap = lastDungeon(s);
          note(`${roomId}: no mobs awake. encounters ${JSON.stringify(lastSnapshotField(s, "encounters"))} enemies ${JSON.stringify(lastSnapshotField(s, "enemies"))} player (${Math.round(lastPlayer(s).x)}, ${Math.round(lastPlayer(s).y)}) room ${snap?.spaceId}`);
          note(`page errors ${JSON.stringify(s.errors.slice(-10))}`);
          await shot(`fail-${roomId}-asleep`);
          throw new Error(`${roomId} mobs never woke`);
        }
        await s.page.waitForTimeout(500);
      }
      note(`${roomId}: ${aliveEnemies().length} mobs awake: ${[...new Set(aliveEnemies().map((e) => e.archetype))].join(", ")}`);
      if (roomId === "combat_a" && process.env.VAULT_SKIP_DEATH !== "1") await deathCheck(roomId);
      fightShots.taken = Math.min(fightShots.taken, 1);
      await clearRoom(roomId);
    } else note(`${roomId}: already cleared (resumed run)`);
    const door = lastDungeon(s).objects.find((o: any) => o.portalId && pattern.test(o.portalId));
    await s.page.waitForTimeout(1500);
    await crop(`${roomId}-door-open-a`, door.x - 40, door.y + 40);
    await s.page.waitForTimeout(450);
    await crop(`${roomId}-door-open-b`, door.x - 40, door.y + 40);
    await shot(`${roomId}-cleared`);
  };
  try {
    await s.page.waitForTimeout(3000);
    await dismissPopups();
    if (!lastDungeon(s)) {
      await s.page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "visible", timeout: 30_000 });
      await s.sendRaw({ type: "DEV_SPAWN_DUNGEON_ENTRANCE", templateId: "dungeon:tilted_vault", lat: s.self.lat + 0.00008, lon: s.self.lon });
      await s.until(() => s.frames.some((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED"), 10_000, "entrance");
      const ent = JSON.parse(s.frames.find((f) => f.type === "DEV_DUNGEON_ENTRANCE_SPAWNED")!.raw).entrance;
      await s.page.waitForTimeout(1500);
      const p = await s.page.evaluate(([lon, lat]) => {
        const map = (window as any).__e2eMap; const q = map.project([lon, lat]); const r = map.getContainer().getBoundingClientRect();
        return { x: r.left + q.x, y: r.top + q.y };
      }, [ent.lon ?? ent.position?.lon, ent.lat ?? ent.position?.lat] as const);
      await s.page.mouse.click(p.x, p.y);
      const enter = s.page.getByRole("button", { name: /enter|go through|tilted vault/i }).last();
      const tapped = await enter.click({ timeout: 4000 }).then(() => true).catch(() => false);
      const arrived = tapped && await s.until(() => !!lastDungeon(s), 12_000, "entry").then(() => true).catch(() => false);
      if (arrived) note("entered by tapping the world entrance");
      else {
        note("world entrance prompt not found by tap; entered with USE_PORTAL");
        await s.sendRaw({ type: "USE_PORTAL", portalId: ent.portalId, expectedPortalRevision: ent.portalRevision, expectedLocationRevision: locRevision(s) });
      }
    }
    // A run left by an earlier (failed) run starts clean with the dev Reset Vault run, which sends the player to room 1.
    // (Walking back is no good: in a woken combat room a desktop click swings at the mobs instead of opening the door.)
    if (lastDungeon(s) && (lastDungeon(s).spaceId !== CHAIN[0] || Object.values(flags()).some((value) => value === true))) {
      await s.page.waitForTimeout(3000);
      // A character left in a woken combat room may have been killed there meanwhile
      // (the death card can take a few seconds to come up after a reconnect).
      for (let t = 0; t < 10; t++) {
        if (await respawnIfDead()) { note(`resume: respawned in ${lastDungeon(s)?.spaceId} before the reset`); break; }
        await s.page.waitForTimeout(1000);
      }
      const from = lastDungeon(s)?.spaceId;
      await s.sendRaw({ type: "DEV_RESET_DUNGEON_RUN", requestId: `vault-reset-${Date.now()}` });
      await s.until(() => lastDungeon(s)?.spaceId === CHAIN[0] && !Object.values(flags()).some((value) => value === true), 20_000, "reset run");
      note(`resume: reset the Vault run from ${from}`);
      await s.page.waitForTimeout(2000);
    }
    await s.until(() => lastDungeon(s)?.spaceId === "vault_r1", 40_000, "room 1");
    for (let i = 0; i < CHAIN.length; i++) {
      const roomId = CHAIN[i]!;
      const next = CHAIN[i + 1] ?? null;
      await s.until(() => lastDungeon(s)?.spaceId === roomId, 30_000, roomId);
      if (isCombatRoom(roomId)) {
        await s.page.waitForTimeout(2500);
        await dismissPopups();
        await s.page.mouse.move(2, 2);
        await shot(`${roomId}-start`);
        await combatRoom(roomId, next!);
        await walkThrough(nextDoor(i), next);
        continue;
      }
      const n = Number(roomId.slice("vault_r".length));
      await s.page.waitForFunction((id) => (window as any).__heartPuzzle?.runtime?.context?.roomId === id, roomId, { timeout: 20_000 });
      await s.page.waitForTimeout(3600);
      await dismissPopups();
      await s.page.mouse.move(2, 2);
      await shot(`r${n}-start`);
      await checkLayout(lastDungeon(s));
      if (n === 1) await walkChecks();
      const flag = `${roomId}_solved`;
      const already = n < 4 ? flags()[flag] === true : lastDungeon(s).completed === true;
      if (!already) {
        if (n === 1) await flowChecks(roomId);
        // Once, in the first room still to solve (a resumed run may start past room 1).
        if (viewportEnv && !(await s.page.evaluate(() => !!(window as any).__vaultGyro))) await s.page.evaluate(`${GYRO}`);
        await startPuzzle(roomId);
        if (viewportEnv) {
          const gyro = await s.page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve({
            live: (window as any).__heartPuzzle.hub().read().sensorsLive.tilt, source: (window as any).__heartPuzzle.hub().read().tiltSource,
            notice: !!document.querySelector("[data-testid=heart-puzzle-gyro-notice]"), pad: !!document.querySelector(".heart-puzzle-hud__pad")
          }), 1400)));
          note(`${roomId}: gyro ${JSON.stringify(gyro)}`);
          expect((gyro as any).live, "simulated gyro drives the tilt").toBe(true);
          expect((gyro as any).pad, "no drag pad on phones").toBe(false);
        }
        await s.page.evaluate(`${AUTOPILOT}`);
        if (n === 1) { await s.page.waitForTimeout(700); await rollSheet(); }
        const won = await s.page.waitForFunction(() => (window as any).__heartPuzzle.runtime.state?.status === "won", undefined, { timeout: autopilotMs })
          .then(() => true).catch(() => false);
        await s.page.evaluate(() => { (window as any).__autopilot.stop = true; });
        if (won) note(`${roomId}: solved by tilt-pad autopilot`);
        else {
          note(`${roomId}: autopilot did not finish in ${autopilotMs / 1000} s; reported the solve with DUNGEON_PUZZLE_SOLVE`);
          await s.sendRaw({ type: "DUNGEON_PUZZLE_SOLVE", sessionId: lastDungeon(s).sessionId, roomId, clientSolveMs: 60_000 });
        }
        if (n < 4) await s.until(() => flags()[flag] === true, 20_000, `${flag} from the server`);
        else await s.until(() => lastDungeon(s)?.completed === true, 20_000, "dungeon completed");
        if (n === 4) {
          // Pell's farewell opens by itself once the celebration ends and the server confirms the seal.
          const farewell = await s.page.getByTestId("pell-text").waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
          await shot("r4-farewell");
          const text = farewell ? (await s.page.getByTestId("pell-text").innerText()).trim() : "";
          note(`r4 farewell popup: visible=${farewell} chars=${text.length} "${text.slice(0, 90)}"`);
          expect(farewell, "Pell's farewell popup after the r4 solve").toBe(true);
          expect(text.length, "farewell has story text").toBeGreaterThan(40);
          await s.page.locator(".heart-puzzle-pell button").filter({ visible: true }).last().click({ timeout: 5000 }).catch(() => undefined);
        } else await s.page.waitForTimeout(1200);
        await shot(`r${n}-solved`);
        expect(lastSnapshotField(s, "heartPuzzleActiveRoomId") ?? null, "unlocked after the solve").toBeNull();
        if (next) {
          const door = lastDungeon(s).objects.find((o: any) => o.portalId && nextDoor(i).test(o.portalId));
          await s.page.waitForTimeout(1500);
          await crop(`r${n}-door-glow-a`, door.x - 40, door.y + 40);
          await s.page.waitForTimeout(450);
          await crop(`r${n}-door-glow-b`, door.x - 40, door.y + 40);
        }
        if (n === 1) {
          // The solved board is open floor: the same wall cell is now a legal target.
          const mark = s.mark();
          await s.sendRaw({ type: "DUNGEON_MOVE_TO", requestId: "e2e-wall-2", sessionId: lastDungeon(s).sessionId, x: 220, y: 350 });
          await s.page.waitForTimeout(1200);
          note(`walls after the solve: BLOCKED_TARGET x${errorsSince(mark, "BLOCKED_TARGET")}`);
          expect(errorsSince(mark, "BLOCKED_TARGET"), "board walkable after the solve").toBe(0);
        }
      }
      if (next) await walkThrough(nextDoor(i), next);
    }
    note("completed: " + String(lastDungeon(s).completed));
    for (let i = CHAIN.length - 1; i > 0; i--) await walkThrough(backDoor(i), CHAIN[i - 1]!);
    await s.page.waitForTimeout(1500);
    await shot("r1-back-arrival");
    note(`r1 back arrival player ${JSON.stringify(lastPlayer(s))} active=${String(lastSnapshotField(s, "heartPuzzleActiveRoomId"))}`);
    const mark = s.mark();
    await walkThrough(/entrance_to_world$/, null);
    await s.until(() => s.since(mark, undefined, "in").some((f) => f.raw.includes("\"kind\":\"world\"")), 30_000, "back in the world");
    await s.page.waitForTimeout(2500);
    await shot("world");
    note("left the vault to the world");
  } finally {
    // Server frames the client would reject (three on one connection make it drop and reconnect).
    const rejected = new Map<string, string>();
    for (const f of s.frames) {
      if (f.dir !== "in" || f.type === "connected") continue;
      try { parseServerMessage(f.raw); } catch (error) {
        if (!rejected.has(String(f.type))) rejected.set(String(f.type), String(error instanceof Error ? error.message : error).slice(0, 800));
      }
    }
    note(`rejected server frames: ${rejected.size === 0 ? "none" : JSON.stringify([...rejected])}`);
    if (consoleProblems.length > 0) note(`console problems: ${consoleProblems.join(" | ")}`);
    console.log("NOTES\n" + notes.join("\n"));
    s.save();
    await browser.close();
  }
});
