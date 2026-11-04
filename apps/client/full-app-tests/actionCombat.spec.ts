/**
 * Action combat end-to-end regression check (real headless Chromium, real websocket frames).
 *
 * Run (frontend dev Vite + backend with ACTION_COMBAT_ENABLED=true; add SWING_DEBUG_LOG=true for per-swing logs):
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41768 pnpm exec playwright test --config playwright-full-app.config.ts actionCombat
 *
 * Optional env:
 *   ASH_ATLAS_E2E_OUT      screenshot + frame-log folder (default: <tmpdir>/action-combat-e2e)
 *   ASH_ATLAS_BACKEND_LOG  backend stdout log, used for the perf-server / perf-sample report
 *
 * Signs in with the "Default Dev" button, so the backend must allow the developer account (DEV_SPAWN_MOB).
 * Every websocket frame in both directions is saved to <out>/<test>.frames.jsonl.
 */
import { expect, test, chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = process.env.ASH_ATLAS_TEST_BASE_URL;
const outDir = process.env.ASH_ATLAS_E2E_OUT ?? join(tmpdir(), "action-combat-e2e");
mkdirSync(outDir, { recursive: true });

interface Frame { t: number; dir: "in" | "out"; type: string; raw: string }
interface Ent { id: string; kind: string; archetype: string | null; lat: number; lon: number; hp: number | null }

class Session {
  frames: Frame[] = [];
  ents = new Map<string, Ent>();
  self = { lat: 0, lon: 0, id: "" };
  t0 = Date.now();
  constructor(readonly page: Page, readonly name: string) {
    page.on("websocket", (ws) => {
      ws.on("framesent", (f) => this.push("out", String(f.payload)));
      ws.on("framereceived", (f) => this.push("in", String(f.payload)));
    });
    page.on("pageerror", (e) => this.errors.push(e.message));
  }
  errors: string[] = [];
  private push(dir: "in" | "out", raw: string): void {
    const type = /"type":"(\w+)"/.exec(raw)?.[1] ?? "?";
    this.frames.push({ t: Date.now() - this.t0, dir, type, raw });
    if (dir !== "in") return;
    if (type === "WELCOME") { try { const w = JSON.parse(raw); this.self.id = w.playerId; this.self.lat = w.spawn.lat; this.self.lon = w.spawn.lon; } catch { /* ignore */ } }
    if (type === "COMBAT_SNAPSHOT" || type === "COMBAT_DELTA" || type === "PLAYER_DELTA") this.ingest(raw);
  }
  private ingest(raw: string): void {
    let json: unknown; try { json = JSON.parse(raw); } catch { return; }
    const walk = (v: unknown, depth: number): void => {
      if (!v || typeof v !== "object" || depth > 6) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      const o = v as Record<string, unknown>;
      if (typeof o.entityId === "string" && typeof o.lat === "number" && typeof o.lon === "number" && typeof o.kind === "string") {
        this.ents.set(o.entityId, { id: o.entityId, kind: o.kind, archetype: (o.archetypeKey as string | null) ?? null, lat: o.lat, lon: o.lon, hp: typeof o.currentHealth === "number" ? o.currentHealth : null });
        if (o.entityId === this.self.id) { this.self.lat = o.lat; this.self.lon = o.lon; }
      } else if (o.kind === "movement" && o.playerId === this.self.id && typeof o.lat === "number" && typeof o.lon === "number") {
        this.self.lat = o.lat; this.self.lon = o.lon;
      }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    };
    walk(json, 0);
  }
  /** Tight 10 ms poll (expect.poll backs off to 1 s, far too slow to react inside a 450 ms telegraph). */
  async until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(10);
    }
  }
  mark(): number { return this.frames.length; }
  since(mark: number, type?: string, dir?: "in" | "out"): Frame[] {
    return this.frames.slice(mark).filter((f) => (!type || f.type === type) && (!dir || f.dir === dir));
  }
  grep(mark: number, re: RegExp, dir: "in" | "out" = "in"): Frame[] {
    return this.frames.slice(mark).filter((f) => f.dir === dir && re.test(f.raw));
  }
  async shot(label: string): Promise<string> {
    const path = join(outDir, `${this.name}-${label}.png`);
    await this.page.screenshot({ path });
    return path;
  }
  save(): void {
    writeFileSync(join(outDir, `${this.name}.frames.jsonl`),
      this.frames.map((f) => JSON.stringify({ t: f.t, dir: f.dir, type: f.type, raw: f.raw.length > 1500 ? `${f.raw.slice(0, 1500)}...` : f.raw })).join("\n"));
  }
  /** Fresh mobs of an archetype that appeared since `before`. */
  mobsOf(archetype: string): Ent[] { return [...this.ents.values()].filter((e) => e.archetype === archetype); }

  async spawn(archetype: string, eastM: number, northM: number, atCenter = false): Promise<Ent> {
    let { lat, lon } = this.self;
    if (atCenter) {
      const c = await this.page.evaluate(() => { const m = (window as any).__e2eMap; const c = m.getCenter(); return { lat: c.lat, lon: c.lng }; });
      lat = c.lat; lon = c.lon;
    }
    lat += northM / 111_320; lon += eastM / (111_320 * Math.cos((lat * Math.PI) / 180));
    // Up to 3 attempts (a spawn can be lost right after a teleport or reconnect); each is confirmed by a new entity in the combat frames.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = new Set(this.ents.keys());
      await this.page.evaluate(({ archetype, lat, lon }) => {
        const sockets = ((window as any).__e2eSockets as WebSocket[]).filter((s) => s.readyState === 1);
        sockets[sockets.length - 1]!.send(JSON.stringify({ type: "DEV_SPAWN_MOB", requestId: crypto.randomUUID(), archetype, lat, lon }));
      }, { archetype, lat, lon });
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const found = [...this.ents.values()].find((e) => !before.has(e.id) && e.archetype === archetype);
        if (found) return found;
        await this.page.waitForTimeout(100);
      }
    }
    throw new Error(`spawn of ${archetype} never appeared in combat frames`);
  }
  /** Screen position (CSS px) of an entity, from the page's own map projection. */
  async screenOf(id: string): Promise<{ x: number; y: number }> {
    const e = this.ents.get(id)!;
    return this.page.evaluate(({ lat, lon }) => { const p = (window as any).__e2eMap.project([lon, lat]); return { x: p.x as number, y: p.y as number }; }, { lat: e.lat, lon: e.lon });
  }
  async clickEntity(id: string, yOffset = -12): Promise<void> {
    const p = await this.screenOf(id);
    await this.page.mouse.click(p.x, p.y + yOffset);
  }
  async teleport(lat: number, lon: number): Promise<void> {
    await this.page.evaluate(({ lat, lon }) => {
      const sockets = ((window as any).__e2eSockets as WebSocket[]).filter((s) => s.readyState === 1);
      sockets[sockets.length - 1]!.send(JSON.stringify({ type: "DEV_TELEPORT", requestId: crypto.randomUUID(), lat, lon }));
    }, { lat, lon });
    await expect.poll(() => Math.hypot(this.self.lat - lat, this.self.lon - lon), { timeout: 5000 }).toBeLessThan(0.00005);
    await this.page.waitForTimeout(Number(process.env.E2E_TELEPORT_SETTLE_MS ?? 6000));
  }
  sendRaw(message: Record<string, unknown>): Promise<void> {
    return this.page.evaluate((m) => {
      const sockets = ((window as any).__e2eSockets as WebSocket[]).filter((s) => s.readyState === 1);
      sockets[sockets.length - 1]!.send(JSON.stringify({ ...m, requestId: crypto.randomUUID() }));
    }, message);
  }
  /** The newest full EQUIPMENT_SNAPSHOT (the v2 one with instances), parsed. */
  equipment(): any | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.dir === "in" && (f.type === "EQUIPMENT_SNAPSHOT" || f.type === "EQUIPMENT_UPDATED" || f.type === "COMBAT_KIT_SNAPSHOT") && f.raw.includes('"instances"')) return JSON.parse(f.raw).equipment;
    }
    return null;
  }
  /** Equips the starter bow if needed and readies the given weapon slot ("secondary" = bow, "melee" = the melee weapon). */
  async ensureWeapon(slot: "melee" | "secondary"): Promise<void> {
    await this.until(() => this.equipment() !== null, 20_000, "an EQUIPMENT_SNAPSHOT");
    const readied = (): string | null => {
      const eq = this.equipment();
      const kit = eq?.kits?.find((k: any) => k.kitIndex === eq?.activeKitIndex) ?? null;
      return eq?.readiedWeaponSlot ?? kit?.readiedWeaponSlot ?? null;
    };
    if (slot === "secondary") {
      const eq = this.equipment();
      const bow = eq.instances.find((i: any) => i.definitionId === "starter_bow");
      if (!bow) throw new Error("the dev account has no starter_bow");
      if (bow.equippedSlot !== "secondary") {
        const n = this.frames.length;
        await this.sendRaw({ type: "EQUIP_ITEM", instanceId: bow.instanceId, slot: "secondary" });
        await this.until(() => this.equipment()?.instances.find((i: any) => i.instanceId === bow.instanceId)?.equippedSlot === "secondary" && this.frames.length > n, 8000, "the bow to be equipped");
      }
    }
    if (readied() === slot) return;
    const n = this.frames.length;
    await this.sendRaw({ type: "TOGGLE_READIED_WEAPON", readiedWeaponSlot: slot, expectedInventoryRevision: this.equipment().inventoryRevision ?? 0 });
    await this.until(() => this.frames.length > n && readied() === slot, 8000, `the ${slot} weapon to be readied (now ${readied()})`);
    await this.page.waitForTimeout(500);
  }
  /** DEV_CLEAR_MOBS: removes every mob so wolves from an earlier test cannot kill the shared dev player. */
  async clearMobs(): Promise<void> {
    await this.page.evaluate(() => {
      const sockets = ((window as any).__e2eSockets as WebSocket[]).filter((s) => s.readyState === 1);
      sockets[sockets.length - 1]!.send(JSON.stringify({ type: "DEV_CLEAR_MOBS", requestId: crypto.randomUUID() }));
    });
    await this.page.waitForTimeout(1200);
    for (const [id, e] of this.ents) if (e.kind !== "player") this.ents.delete(id);
  }
}

/** Finds the live maplibre map through React's fibers (the app keeps no global handle) and exposes it as window.__e2eMap. */
async function exposeMap(page: Page): Promise<void> {
  let ok = false;
  for (let attempt = 0; attempt < 10 && !ok; attempt++) {
    if (attempt) await page.waitForTimeout(1000);
    ok = await findMap(page);
  }
  if (!ok) await page.screenshot({ path: join(outDir, "map-not-found.png") });
  expect(ok, "could not find the map object via React fibers").toBe(true);
}

async function findMap(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const isMap = (v: any): boolean => v && typeof v === "object" && typeof v.project === "function" && typeof v.getBearing === "function";
    const seen = new Set<unknown>();
    const found = new Set<any>();
    const search = (v: any, d: number): void => {
      if (!v || typeof v !== "object" || seen.has(v) || d > 5) return;
      seen.add(v); if (isMap(v)) { found.add(v); return; }
      for (const k of Object.keys(v)) { let c; try { c = v[k]; } catch { continue; } search(c, d + 1); }
    };
    for (const e of Array.from(document.querySelectorAll("*"))) {
      const fk = Object.keys(e).find((k) => k.startsWith("__reactFiber")); if (!fk) continue;
      let f = (e as any)[fk]; let depth = 0;
      while (f && depth++ < 400) {
        let s = f.memoizedState; let n = 0;
        while (s && typeof s === "object" && n++ < 4000) { search(s.memoizedState, 0); s = s.next; }
        f = f.return;
      }
    }
    // The app may have rebuilt its map (phone layout): keep the one whose canvas is live on screen, largest first.
    const live = [...found].filter((m) => { try { const c = m.getCanvas(); return c.isConnected && c.getBoundingClientRect().width > 0; } catch { return false; } })
      .sort((a, b) => b.getCanvas().getBoundingClientRect().width * b.getCanvas().getBoundingClientRect().height - a.getCanvas().getBoundingClientRect().width * a.getCanvas().getBoundingClientRect().height);
    if (live[0]) { (window as any).__e2eMap = live[0]; return true; }
    return false;
  });
}

interface LaunchOptions { /** Install page.clock before the page loads (it keeps running in real time until paused), so performance.now never restarts mid-session. */ clock?: boolean; mobile?: boolean; gamepad?: boolean; joystick?: boolean }

async function launch(browser: Browser, name: string, options: LaunchOptions = {}): Promise<{ ctx: BrowserContext; s: Session }> {
  const ctx = await browser.newContext(options.mobile
    ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }
    : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript((opts) => {
    const W = window.WebSocket; (window as any).__e2eSockets = [];
    const Wrapped: any = function (this: unknown, ...a: any[]) { const s = new (W as any)(...a); (window as any).__e2eSockets.push(s); return s; };
    Wrapped.prototype = W.prototype; Object.assign(Wrapped, W); (window as any).WebSocket = Wrapped;
    if (opts.joystick) { try { localStorage.setItem("ashAtlas.joystickMovement.v1", "1"); localStorage.setItem("ashAtlas.floatingSticks.v1", "0"); } catch { /* ignore */ } }
    if (opts.gamepad) {
      const pad: any = { id: "Xbox 360 Controller (STANDARD GAMEPAD)", index: 0, connected: true, mapping: "standard", timestamp: 0,
        axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
      (window as any).__pad = pad;
      navigator.getGamepads = () => [pad, null, null, null] as any;
      window.addEventListener("load", () => setTimeout(() => {
        const ev: any = new Event("gamepadconnected"); ev.gamepad = pad; window.dispatchEvent(ev);
      }, 500));
    }
  }, options);
  const s = new Session(page, name);
  if (options.clock) await page.clock.install();
  await page.goto(baseUrl!, { waitUntil: "domcontentloaded" });
  const dev = page.getByRole("button", { name: "Default Dev" });
  await dev.waitFor({ state: "visible", timeout: 20_000 });
  // The dev-login endpoint rate-limits bursts of sign-ins, and a refused click leaves the sign-in screen up with no
  // message (or "Authentication service unavailable"): back off and click again until the map shows.
  const mapCanvas = page.locator("canvas.maplibregl-canvas").first();
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await dev.isVisible().catch(() => false)) await dev.click();
    await page.locator("main.initial-curtain").or(mapCanvas).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    if (!(await dev.isVisible().catch(() => false))) break;
    await page.waitForTimeout(10_000);
  }
  await page.locator("main.initial-curtain").waitFor({ state: "detached", timeout: 60_000 });
  await page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "attached", timeout: 30_000 });
  await page.waitForTimeout(2500);
  const respawn = page.getByRole("button", { name: "Respawn" });
  if (await respawn.isVisible()) { await respawn.click(); await page.waitForTimeout(1500); }
  await exposeMap(page);
  await expect.poll(() => s.self.id, { timeout: 10_000 }).not.toBe("");
  await s.page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "visible", timeout: 30_000 });
  await s.ensureWeapon("melee");
  await s.clearMobs();
  // A respawn lands at the home anchor; fight at the dev account's usual spot instead (mobs ignore the anchor area).
  await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
  // The camera does not always follow a long dev teleport (a run after another spec left the player far away): centre it.
  await s.page.evaluate(({ lat, lon }) => (window as any).__e2eMap.jumpTo({ center: [lon, lat] }), { lat: s.self.lat, lon: s.self.lon });
  await s.page.waitForTimeout(600);
  return { ctx, s };
}

function note(type: string, description: string): void { test.info().annotations.push({ type, description }); console.log(`[${type}] ${description}`); }
const TEST_SPOT = { lat: 29.760155504298524, lon: -82.34756038216241 };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const swingsSent = (s: Session, mark: number): Frame[] => s.since(mark, "SWING", "out");

/** Hold the right mouse button at a screen point for `ms`, then release (aim plus attack). */
async function rightHold(s: Session, x: number, y: number, ms: number): Promise<void> {
  await s.page.mouse.move(x, y);
  await s.page.mouse.down({ button: "right" });
  await s.page.waitForTimeout(ms);
  await s.page.mouse.up({ button: "right" });
}
/** Unit world direction from the player to an entity (east, north), flat-earth. */
function dirTo(s: Session, id: string): { x: number; y: number } {
  const e = s.ents.get(id)!;
  const dx = (e.lon - s.self.lon) * Math.cos((s.self.lat * Math.PI) / 180);
  const dy = e.lat - s.self.lat;
  const len = Math.hypot(dx, dy);
  return { x: dx / len, y: dy / len };
}
const swingDir = (f: Frame): { x: number; y: number } => { const j = JSON.parse(f.raw); return { x: j.dirX as number, y: j.dirY as number }; };
const dot = (a: { x: number; y: number }, b: { x: number; y: number }): number => a.x * b.x + a.y * b.y;
/** Screen position of the player and the unit screen vector toward an entity (for stick and drag aiming). */
async function screenAim(s: Session, id: string): Promise<{ me: { x: number; y: number }; unit: { x: number; y: number } }> {
  const me = await s.page.evaluate(({ lat, lon }) => { const p = (window as any).__e2eMap.project([lon, lat]); return { x: p.x as number, y: p.y as number }; }, { lat: s.self.lat, lon: s.self.lon });
  const t = await s.screenOf(id);
  const len = Math.hypot(t.x - me.x, t.y - me.y);
  return { me, unit: { x: (t.x - me.x) / len, y: (t.y - me.y) / len } };
}
const setStick = (s: Session, x: number, y: number): Promise<unknown> => s.page.evaluate(({ x, y }) => { const p = (window as any).__pad; p.axes[2] = x; p.axes[3] = y; }, { x, y });
const setPadButton = (s: Session, index: number, pressed: boolean): Promise<unknown> => s.page.evaluate(({ index, pressed }) => { const b = (window as any).__pad.buttons[index]; b.pressed = pressed; b.value = pressed ? 1 : 0; }, { index, pressed });
const mapCentre = (s: Session): Promise<{ lat: number; lon: number }> => s.page.evaluate(() => { const c = (window as any).__e2eMap.getCenter(); return { lat: c.lat, lon: c.lng }; });

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at the action-combat dev runtime");

let browser: Browser;
const pressToResult: number[] = [];
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => {
  await browser?.close();
  writeFileSync(join(outDir, "press-to-result-ms.json"), JSON.stringify(pressToResult));
});

function collectLatency(s: Session): void {
  const sent = new Map<string, number>();
  for (const f of s.frames) {
    if (f.type === "SWING" && f.dir === "out") sent.set(/"requestId":"([^"]+)"/.exec(f.raw)![1]!, f.t);
    if (f.type === "SWING_RESULT") { const t = sent.get(/"requestId":"([^"]+)"/.exec(f.raw)![1]!); if (t !== undefined) pressToResult.push(f.t - t); }
  }
}

test("1. left click on a dummy and a wolf opens the popup with no SWING; right-click hold swings at the cursor", async () => {
  const { ctx, s } = await launch(browser, "mouse");
  try {
    const dummy = await s.spawn("training_dummy", -30, 50);
    await s.page.waitForTimeout(400);
    let mark = s.mark();
    const p = await s.screenOf(dummy.id);
    await s.page.mouse.click(p.x, p.y - 12);
    await s.page.waitForTimeout(900);
    await s.shot("dummy-left-click-popup");
    expect(swingsSent(s, mark), "a left click must never swing in the twin-stick scheme").toHaveLength(0);
    expect(s.since(mark, "START_ATTACK", "out")).toHaveLength(0);
    // Right mouse hold toward a dummy: repeated swings aimed at the cursor, and release stops them.
    const dummy2 = await s.spawn("training_dummy", -30, 50);
    await s.page.waitForTimeout(600);
    const at = await s.screenOf(dummy2.id);
    mark = s.mark();
    await rightHold(s, at.x, at.y, 1600);
    const sent = swingsSent(s, mark);
    note("right-hold", `swings=${sent.length}`);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const want = dirTo(s, dummy2.id);
    for (const f of sent) expect(dot(swingDir(f), want)).toBeGreaterThan(0.95);
    await expect.poll(() => s.since(mark, "SWING_RESULT").length, { timeout: 3000 }).toBeGreaterThan(0);
    await s.page.waitForTimeout(800);
    const afterRelease = swingsSent(s, mark).length;
    await s.page.waitForTimeout(700);
    expect(swingsSent(s, mark).length, "release stops the attacks").toBe(afterRelease);
    collectLatency(s);
    // Wolf last (it hits hard): a left click is selection, never a swing.
    await s.clearMobs();
    const wolf = await s.spawn("wolf", -45, 35);
    mark = s.mark();
    await s.page.waitForTimeout(150);
    await s.clickEntity(wolf.id);
    await s.page.waitForTimeout(400);
    expect(swingsSent(s, mark), "a left click on a wolf must not swing").toHaveLength(0);
    await s.clearMobs();
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("2. right-click hold repeats at the recovery cadence: combo 0,1,2 and no over-send", async () => {
  const { ctx, s } = await launch(browser, "combo");
  try {
    const dummy = await s.spawn("training_dummy", -30, 50);
    await s.page.waitForTimeout(600);
    const p = await s.screenOf(dummy.id);
    const mark = s.mark();
    await rightHold(s, p.x, p.y - 12, 3200);
    await s.page.waitForTimeout(600);
    const sent = swingsSent(s, mark).length;
    const results = s.since(mark, "SWING_RESULT").map((f) => JSON.parse(f.raw));
    const combos = results.map((r) => r.comboIndex);
    note("combo", `sent=${sent} combos=${JSON.stringify(combos)} rejected=${JSON.stringify(results.map((r) => r.rejected ?? null))}`);
    await s.shot("combo-end");
    const times = swingsSent(s, mark).map((f) => f.t);
    const gaps = times.slice(1).map((v, i) => v - times[i]!);
    note("combo-gaps", JSON.stringify(gaps));
    // 3.2 s of holding against 700/700/900 ms recoveries: about four or five swings, never faster than the recovery.
    expect(sent).toBeGreaterThanOrEqual(3);
    expect(sent).toBeLessThanOrEqual(6);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(600);
    expect(combos.slice(0, 3)).toEqual([0, 1, 2]);
    expect(results.every((r) => !r.rejected)).toBe(true);
    collectLatency(s);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("3. mob windup: telegraph, landed strike, and a Space dodge", async () => {
  const { ctx, s } = await launch(browser, "windup");
  try {
    // (b) first: Space right after the telegraph shows up must dodge (the dev player has 100 HP and a wolf hits for ~90).
    let mark = s.mark();
    const wolf = await s.spawn("wolf", 30, 0);
    await s.until(() => s.grep(mark, /melee_windup/).length > 0, 15_000, "first melee_windup telegraph");
    const dashMark = s.mark();
    await s.page.keyboard.press("Space"); // straight away: the strike lands 450 ms after the telegraph
    const t1 = s.grep(mark, /melee_windup/)[0]!;
    note("telegraph-frame", t1.raw.slice(t1.raw.indexOf('"telegraphs"'), t1.raw.indexOf('"telegraphs"') + 420));
    const hpBefore = s.ents.get(s.self.id)?.hp ?? null;
    await s.page.waitForTimeout(1500);
    const dodges = s.grep(dashMark, /"DODGE"/);
    const hpAfter = s.ents.get(s.self.id)?.hp ?? null;
    note("dodge", `dash sent=${s.since(dashMark, "DASH", "out").length} DODGE events=${dodges.length} hp ${hpBefore} -> ${hpAfter}${dodges[0] ? " " + dodges[0].raw.slice(dodges[0].raw.indexOf('"events"'), dodges[0].raw.indexOf('"events"') + 260) : ""}`);
    expect(s.since(dashMark, "DASH_ACCEPTED").length).toBe(1);
    expect(hpAfter, "the dashed-through strike must not hurt").toBe(hpBefore);
    // The strike resolves on its due tick even though the 200 m dash left the session view radius.
    expect(dodges.length, "the dashed-through strike must resolve as a DODGE event").toBeGreaterThan(0);
    expect(dodges[0]!.raw).toContain("melee_windup");
    await s.shot("windup-dodged");

    // (a) then stand still: the next strike must land as DAMAGE on the player.
    mark = s.mark();
    await s.until(() => s.grep(mark, /melee_windup/).length > 0, 10_000, "second melee_windup telegraph");
    const t2 = s.grep(mark, /melee_windup/)[0]!;
    await s.shot("windup-cone"); // within the telegraph window; a wolf that repositions can aim a windup away, so any later strike counts
    await expect.poll(() => s.frames.slice(mark).some((f) => f.t > t2.t && f.dir === "in" && f.raw.includes('"DAMAGE"') && f.raw.includes(`"targetEntityId":"${s.self.id}"`)), { timeout: 15_000, message: "a later windup strike lands on the player" }).toBe(true);
    const hit = s.frames.slice(mark).find((f) => f.t > t2.t && f.raw.includes('"DAMAGE"') && f.raw.includes(`"targetEntityId":"${s.self.id}"`))!;
    note("strike-landed", `${hit.t - t2.t} ms after telegraph: ${hit.raw.slice(hit.raw.indexOf('"events"'), hit.raw.indexOf('"events"') + 260)}`);
    void wolf;
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("4. gamepad: right stick aims and attacks, X is only the quick action, D-pad pans", async () => {
  const { ctx, s } = await launch(browser, "gamepad", { gamepad: true });
  try {
    const dummy = await s.spawn("training_dummy", -30, 50);
    await s.page.waitForTimeout(800);
    const { unit } = await screenAim(s, dummy.id);
    const want = dirTo(s, dummy.id);

    // Right stick held toward the dummy: repeated SWINGs at the cadence, aimed at it; the camera does not pan.
    let mark = s.mark();
    const centreBefore = await mapCentre(s);
    await setStick(s, unit.x, unit.y);
    await s.page.waitForTimeout(1300);
    await s.shot("pad-stick-aim");
    await setStick(s, 0, 0);
    const sent = swingsSent(s, mark);
    note("pad-stick", `swings=${sent.length}`);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const f of sent) expect(dot(swingDir(f), want)).toBeGreaterThan(0.95);
    const times = sent.map((f) => f.t);
    for (const gap of times.slice(1).map((v, i) => v - times[i]!)) expect(gap).toBeGreaterThanOrEqual(600);
    const centreAfter = await mapCentre(s);
    expect(Math.hypot(centreAfter.lat - centreBefore.lat, centreAfter.lon - centreBefore.lon), "the right stick must not pan the camera").toBeLessThan(0.000005);
    // Release stops.
    await s.page.waitForTimeout(700);
    const afterRelease = swingsSent(s, mark).length;
    await s.page.waitForTimeout(700);
    expect(swingsSent(s, mark).length).toBe(afterRelease);
    // Below the 0.35 threshold nothing attacks.
    mark = s.mark();
    await setStick(s, unit.x * 0.3, unit.y * 0.3);
    await s.page.waitForTimeout(700);
    await setStick(s, 0, 0);
    expect(swingsSent(s, mark), "a light deflection under the threshold is not an attack").toHaveLength(0);

    // X never swings, even with a hostile in range.
    mark = s.mark();
    await setPadButton(s, 2, true);
    await s.page.waitForTimeout(300);
    await setPadButton(s, 2, false);
    await s.page.waitForTimeout(500);
    expect(swingsSent(s, mark), "X must not swing").toHaveLength(0);
    // And with a harvest node close, X harvests.
    await s.sendRaw({ type: "DEV_SPAWN_PLANT", plantKey: "flax", lat: s.self.lat + 12 / 111_320, lon: s.self.lon });
    await s.page.waitForTimeout(2500);
    const quick = await s.page.locator(".gamepad-quick-label").first().textContent({ timeout: 4000 }).catch(() => null);
    note("pad-quick-label", String(quick));
    await s.shot("pad-x-quick");
    mark = s.mark();
    await setPadButton(s, 2, true);
    await s.page.waitForTimeout(120);
    await setPadButton(s, 2, false);
    await s.page.waitForTimeout(900);
    const out = s.frames.slice(mark).filter((f) => f.dir === "out").map((f) => f.type);
    note("pad-x-out", JSON.stringify(out));
    expect(out).not.toContain("SWING");
    expect(quick, "X shows a quick action when a node is near").not.toBeNull();
    expect(out.some((type) => /HARVEST|PICKUP/.test(type)), `X sends the quick action (${out.join(",")})`).toBe(true);

    // RT with a dummy at the screen centre opens the popup without a swing.
    await s.page.waitForTimeout(800);
    const centre = await s.spawn("training_dummy", 0, 0, true);
    await s.page.waitForTimeout(800);
    mark = s.mark();
    await setPadButton(s, 7, true);
    await s.page.waitForTimeout(200);
    await setPadButton(s, 7, false);
    await s.page.waitForTimeout(800);
    await s.shot("pad-rt-popup");
    expect(swingsSent(s, mark).length, "RT tap must not swing").toBe(0);
    note("pad-RT", `swings=0 centre dummy=${centre.id}`);

    // With the popup from RT still open, the D-pad navigates it and does not pan.
    const cPopup = await mapCentre(s);
    await setPadButton(s, 15, true);
    await s.page.waitForTimeout(400);
    await setPadButton(s, 15, false);
    const cPopupAfter = await mapCentre(s);
    expect(cPopupAfter.lon - cPopup.lon, "D-pad menu navigation wins while a popup is open").toBe(0);
    await s.page.keyboard.press("Escape");
    await s.page.waitForTimeout(600);
    // D-pad right pans the camera (no menu open).
    const c0 = await mapCentre(s);
    await setPadButton(s, 15, true);
    await s.page.waitForTimeout(500);
    await setPadButton(s, 15, false);
    const c1 = await mapCentre(s);
    note("pad-dpad-pan", `dLon=${(c1.lon - c0.lon).toFixed(6)}`);
    expect(c1.lon - c0.lon, "D-pad right pans the camera east").toBeGreaterThan(0.00001);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("5. mobile: attack button tap auto-aims, drag aims and attacks continuously, dead zone pauses", async () => {
  const { ctx, s } = await launch(browser, "mobile", { mobile: true, joystick: true });
  try {
    const dummy = await s.spawn("training_dummy", -30, 50);
    await s.page.waitForTimeout(800);
    const button = s.page.getByRole("button", { name: "Attack" });
    await expect(button).toBeVisible();
    let mark = s.mark();
    await button.tap();
    await expect.poll(() => swingsSent(s, mark).length, { timeout: 3000 }).toBeGreaterThan(0);
    const tapDir = swingDir(swingsSent(s, mark)[0]!);
    expect(dot(tapDir, dirTo(s, dummy.id)), "a tap auto-aims at the nearest hostile").toBeGreaterThan(0.95);
    await s.shot("mobile-tap");

    // Drag the attack stick east and a little south: aims there, not at the mob.
    await s.page.waitForTimeout(900);
    mark = s.mark();
    const box = (await s.page.locator(".joystick-attack-face").boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const cdp = await ctx.newCDPSession(s.page);
    const touch = async (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number): Promise<void> => {
      await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
    };
    await touch("touchStart", cx, cy);
    await touch("touchMove", cx + 56, cy + 16); // straight out before the 400 ms still-hold repeat could start
    await s.page.waitForTimeout(2400);
    await s.shot("twin-mobile-drag");
    const knobCount = await s.page.locator(".joystick-attack-knob").count();
    const during = swingsSent(s, mark);
    note("mobile-drag", `knob=${knobCount} swings while held=${during.length}`);
    expect(knobCount, "the button shows a knob while dragging").toBe(1);
    expect(during.length, "holding the drag attacks repeatedly").toBeGreaterThanOrEqual(3);
    const bearing = await s.page.evaluate(() => (window as any).__e2eMap.getBearing() as number);
    expect(Math.abs(bearing)).toBeLessThan(1);
    // Screen drag (56 px east, 16 px south) with map bearing 0 is world east and a little south.
    const len = Math.hypot(56, 16);
    for (const f of during) expect(dot(swingDir(f), { x: 56 / len, y: -16 / len })).toBeGreaterThan(0.95);

    // Dragging back into the centre dead zone pauses attacking.
    await touch("touchMove", cx + 3, cy + 1);
    await s.page.waitForTimeout(1000);
    const paused = swingsSent(s, mark).length;
    await s.page.waitForTimeout(800);
    expect(swingsSent(s, mark).length, "the dead zone pauses attacking").toBe(paused);
    // Dragging out again resumes.
    await touch("touchMove", cx - 50, cy);
    await s.page.waitForTimeout(1300);
    expect(swingsSent(s, mark).length, "dragging out again resumes").toBeGreaterThan(paused);
    // Release stops.
    await touch("touchEnd", 0, 0);
    await s.page.waitForTimeout(1000);
    const afterRelease = swingsSent(s, mark).length;
    await s.page.waitForTimeout(800);
    expect(swingsSent(s, mark).length, "release stops").toBe(afterRelease);
    expect(await s.page.locator(".joystick-attack-knob").count()).toBe(0);

    // Holding without dragging keeps auto-aim swinging (fresh dummy: the old one may have been worn out by the aimed swings).
    await s.clearMobs();
    const fresh = await s.spawn("training_dummy", -30, 50);
    await s.page.waitForTimeout(800);
    mark = s.mark();
    await touch("touchStart", cx, cy);
    await s.page.waitForTimeout(2800);
    await touch("touchEnd", 0, 0);
    expect(swingsSent(s, mark).length, "a still hold repeats auto-aim swings").toBeGreaterThanOrEqual(3);
    for (const f of swingsSent(s, mark)) expect(dot(swingDir(f), dirTo(s, fresh.id))).toBeGreaterThan(0.95);
    collectLatency(s);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("6. empty ground: left click does not swing, right-click hold swings toward the cursor, no context menu", async () => {
  const { ctx, s } = await launch(browser, "empty-click");
  try {
    await s.page.evaluate(() => { (window as any).__ctx = []; window.addEventListener("contextmenu", (e) => (window as any).__ctx.push(e.defaultPrevented)); });
    const me = await s.page.evaluate(({ lat, lon }) => { const p = (window as any).__e2eMap.project([lon, lat]); return { x: p.x as number, y: p.y as number }; }, { lat: s.self.lat, lon: s.self.lon });
    let mark = s.mark();
    await s.page.mouse.click(me.x + 170, me.y - 90);
    await s.page.waitForTimeout(800);
    expect(swingsSent(s, mark), "a left click on empty ground must not swing").toHaveLength(0);
    mark = s.mark();
    await s.page.mouse.move(me.x + 170, me.y - 90);
    await s.page.mouse.down({ button: "right" });
    await s.page.waitForTimeout(500);
    await s.shot("twin-pc-rightclick-hold");
    await s.page.mouse.move(me.x + 170, me.y + 90, { steps: 5 });
    await s.page.waitForTimeout(900);
    await s.page.mouse.up({ button: "right" });
    const sent = swingsSent(s, mark);
    note("empty-right", `swings=${sent.length} first=${sent[0]?.raw.slice(0, 140)}`);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    const first = swingDir(sent[0]!);
    expect(first.x).toBeGreaterThan(0.3); // cursor east of the player
    expect(first.y).toBeGreaterThan(0.1); // and north of it
    const last = swingDir(sent.at(-1)!);
    expect(last.y, "the aim follows the cursor to the south side").toBeLessThan(-0.1);
    await expect.poll(() => s.since(mark, "SWING_RESULT").length, { timeout: 3000 }).toBeGreaterThan(0);
    const prevented = await s.page.evaluate(() => (window as any).__ctx as boolean[]);
    note("contextmenu", JSON.stringify(prevented));
    expect(prevented.length === 0 || prevented.every(Boolean), "the browser context menu is suppressed").toBe(true);
    // A right click no longer walks anywhere.
    expect(s.since(mark, "MOVE_TO", "out")).toHaveLength(0);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("7. ranged shot: bow fires a hitscan arrow, no combo, 1000 ms recovery", async () => {
  const { ctx, s } = await launch(browser, "shot");
  try {
    await s.ensureWeapon("secondary");
    const dummy = await s.spawn("training_dummy", -30, 50);
    await s.page.waitForTimeout(800);
    const p = await s.screenOf(dummy.id);
    let mark = s.mark();
    await rightHold(s, p.x, p.y - 12, 120);
    await s.shot("shot-after-press");
    await expect.poll(() => s.since(mark, "SWING_RESULT").length, { timeout: 3000 }).toBeGreaterThan(0);
    const result = JSON.parse(s.since(mark, "SWING_RESULT")[0]!.raw);
    note("shot-result", JSON.stringify(result).slice(0, 300));
    expect(result.rejected).toBeUndefined();
    expect(result.comboIndex).toBe(0);
    expect(JSON.stringify(result.hits)).toContain(dummy.id);
    await expect.poll(() => s.grep(mark, /"abilityId":"shot"/).length, { timeout: 3000 }).toBeGreaterThan(0);
    await expect.poll(() => s.grep(mark, /"DAMAGE"/).length, { timeout: 3000 }).toBeGreaterThan(0);

    // Mid-flight capture: a screencast records every painted frame around the press (the arrow flies for only ~150 ms), then the frames are saved for review.
    await s.page.waitForTimeout(900);
    const far = await s.spawn("training_dummy", -60, 110);
    await s.page.waitForTimeout(800);
    const farAt = await s.screenOf(far.id);
    const cdp = await ctx.newCDPSession(s.page);
    const frames: Array<{ data: string; at: number }> = [];
    cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
      frames.push({ data: frame.data, at: Date.now() });
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    const pressedAt = Date.now();
    await rightHold(s, farAt.x, farAt.y - 12, 120);
    await s.page.waitForTimeout(400);
    await cdp.send("Page.stopScreencast");
    const flight = frames.filter((frame) => frame.at >= pressedAt);
    flight.slice(0, 12).forEach((frame, index) => writeFileSync(join(outDir, `shot-flight-${String(index).padStart(2, "0")}.png`), Buffer.from(frame.data, "base64")));
    note("shot-screenshot", `${flight.length} screencast frames saved as shot-flight-NN.png in ${outDir}`);
    await s.page.waitForTimeout(600);

    // Holding the right button fires a shot every 1000 ms (shot recovery), never faster; every shot is combo 0.
    await s.page.waitForTimeout(900);
    mark = s.mark();
    await rightHold(s, p.x, p.y - 12, 3200);
    await s.page.waitForTimeout(600);
    const times = swingsSent(s, mark).map((f) => f.t);
    const combos = s.since(mark, "SWING_RESULT").map((f) => JSON.parse(f.raw).comboIndex);
    note("shot-gating", `sent=${times.length} gaps=${JSON.stringify(times.slice(1).map((v, i) => v - times[i]!))} combos=${JSON.stringify(combos)}`);
    expect(times.length).toBeGreaterThanOrEqual(3);
    expect(times.length).toBeLessThanOrEqual(5);
    for (const gap of times.slice(1).map((v, i) => v - times[i]!)) expect(gap).toBeGreaterThanOrEqual(950);
    expect(combos.every((c) => c === 0)).toBe(true);
    collectLatency(s);
  } finally {
    try { await s.ensureWeapon("melee"); } catch (error) { console.log("restore melee failed", error); }
    s.save(); expect(s.errors).toEqual([]); await ctx.close();
  }
});

test("7a. bow with the right stick: shots go out in the stick direction, not at the nearest mob", async () => {
  const { ctx, s } = await launch(browser, "shot-stick", { gamepad: true });
  try {
    await s.ensureWeapon("secondary");
    const dummy = await s.spawn("training_dummy", -30, 50);
    await s.page.waitForTimeout(800);
    const { unit } = await screenAim(s, dummy.id);
    // Aim straight east on screen (map bearing 0), away from the dummy.
    let mark = s.mark();
    await setStick(s, 1, 0);
    await s.page.waitForTimeout(2300);
    await setStick(s, 0, 0);
    const east = swingsSent(s, mark);
    note("bow-stick-east", `shots=${east.length}`);
    expect(east.length).toBeGreaterThanOrEqual(2);
    for (const f of east) expect(swingDir(f).x).toBeGreaterThan(0.99);
    for (let i = 1; i < east.length; i++) expect(east[i]!.t - east[i - 1]!.t).toBeGreaterThanOrEqual(950);
    await s.page.waitForTimeout(1200);
    // Toward the dummy: shots land.
    mark = s.mark();
    await setStick(s, unit.x, unit.y);
    await s.page.waitForTimeout(2300);
    await s.shot("bow-stick-aim");
    await setStick(s, 0, 0);
    const toward = swingsSent(s, mark);
    expect(toward.length).toBeGreaterThanOrEqual(2);
    for (const f of toward) expect(dot(swingDir(f), dirTo(s, dummy.id))).toBeGreaterThan(0.95);
    await expect.poll(() => s.grep(mark, /"abilityId":"shot"/).length, { timeout: 3000 }).toBeGreaterThan(0);
    collectLatency(s);
  } finally {
    try { await s.ensureWeapon("melee"); } catch (error) { console.log("restore melee failed", error); }
    s.save(); expect(s.errors).toEqual([]); await ctx.close();
  }
});

test("7b. shot arrow frames at 40, 80 and 120 ms, dummies up-left and right (page.clock frozen)", async () => {
  const { ctx, s } = await launch(browser, "shot-arrow", { clock: true });
  try {
    await s.ensureWeapon("secondary");
    const cases = [
      { name: "upleft", east: -110, north: 100 },
      { name: "right", east: 130, north: 20 },
    ];
    const dummies = [] as Ent[];
    for (const c of cases) dummies.push(await s.spawn("training_dummy", c.east, c.north));
    await s.page.evaluate(() => { const m = (window as any).__e2eMap; m.jumpTo({ zoom: m.getZoom() + 1.5 }, { originalEvent: new WheelEvent("wheel") }); });
    await s.page.waitForTimeout(1500);
    const me = await s.page.evaluate(() => { const m = (window as any).__e2eMap; const c = m.getCenter(); const p = m.project([c.lng, c.lat]); return { x: p.x as number, y: p.y as number }; });
    await s.page.screenshot({ path: join(outDir, "shot-arrow-both-dummies-full.png") });
    for (let k = 0; k < cases.length; k++) {
      const tag = cases[k]!.name;
      const target = await s.screenOf(dummies[k]!.id);
      const clip = {
        x: Math.max(0, Math.min(me.x, target.x) - 90), y: Math.max(0, Math.min(me.y, target.y) - 110),
        width: Math.min(1280, Math.abs(me.x - target.x) + 180), height: Math.min(800, Math.abs(me.y - target.y) + 200),
      };
      note("arrow-geometry", JSON.stringify({ tag, me, target, clip }));
      await s.page.clock.pauseAt(new Date(Date.now() + 60));
      const mark = s.mark();
      await s.page.mouse.move(target.x, target.y - 12);
      await s.page.mouse.down({ button: "right" });
      await s.page.clock.runFor(20); // one frame: the held button fires the shot
      await s.page.mouse.up({ button: "right" });
      let elapsed = 20;
      for (const at of [40, 80, 120, 160]) {
        await s.page.clock.runFor(at - elapsed);
        elapsed = at;
        await s.page.screenshot({ path: join(outDir, `shot-arrow-${tag}-${at}ms.png`), clip });
      }
      expect(swingsSent(s, mark)).toHaveLength(1);
      await s.page.clock.resume();
      await s.page.waitForTimeout(1300); // past the 1000 ms shot recovery before the next case
    }
  } finally { s.save(); await ctx.close(); }
});

/** Equips a staff in the melee slot and readies it; returns the melee instance it replaced (null when none). */
async function equipStaff(s: Session): Promise<string | null> {
  const eq = s.equipment();
  const previous = eq.instances.find((i: any) => i.equippedSlot === "melee") ?? null;
  const staff = eq.instances.find((i: any) => i.definitionId === "starter_staff" || /_staff$/.test(i.definitionId));
  if (!staff) throw new Error("the dev account has no staff");
  if (staff.equippedSlot !== "melee") {
    const n = s.frames.length;
    await s.sendRaw({ type: "EQUIP_ITEM", instanceId: staff.instanceId, slot: "melee" });
    await s.until(() => s.equipment()?.instances.find((i: any) => i.instanceId === staff.instanceId)?.equippedSlot === "melee" && s.frames.length > n, 8000, "the staff to be equipped");
  }
  await s.ensureWeapon("melee");
  await s.page.waitForTimeout(800);
  return previous && previous.instanceId !== staff.instanceId ? previous.instanceId : null;
}
let staffReplacedMelee: string | null = null;

test("7d. staff arcane blast: a shot past melee reach hits the dummy, bolt + burst frames (page.clock frozen)", async () => {
  const { ctx, s } = await launch(browser, "staff-blast", { clock: true });
  try {
    staffReplacedMelee = await equipStaff(s);
    // 170 m east: past the 110 m melee arc, inside the 280 m arcane blast.
    const dummy = await s.spawn("training_dummy", 170, 0);
    // Zoom in so the cast pose and the bolt read in the frames.
    await s.page.evaluate(() => { const m = (window as any).__e2eMap; m.jumpTo({ zoom: m.getZoom() + 1.5 }, { originalEvent: new WheelEvent("wheel") }); });
    await s.page.waitForTimeout(1500);
    const me = await s.page.evaluate(({ lat, lon }) => { const p = (window as any).__e2eMap.project([lon, lat]); return { x: p.x as number, y: p.y as number }; }, { lat: s.self.lat, lon: s.self.lon });
    const target = await s.screenOf(dummy.id);
    note("staff-geometry", JSON.stringify({ me, target }));
    const clip = {
      x: Math.max(0, Math.min(me.x, target.x) - 90), y: Math.max(0, Math.min(me.y, target.y) - 140),
      width: Math.min(1280, Math.abs(me.x - target.x) + 180), height: Math.min(800, Math.abs(me.y - target.y) + 220),
    };
    await s.page.clock.pauseAt(new Date(Date.now() + 60));
    let mark = s.mark();
    await s.page.mouse.move(target.x, target.y - 12);
    await s.page.mouse.down({ button: "right" });
    await s.page.clock.runFor(20); // one frame: the held button fires the blast
    await s.page.mouse.up({ button: "right" });
    let elapsed = 20;
    for (const at of [40, 80, 120, 160, 200, 240, 280, 320, 400, 520]) {
      await s.page.clock.runFor(at - elapsed);
      elapsed = at;
      await s.page.screenshot({ path: join(outDir, `staff-blast-${at}ms.png`), clip });
    }
    await s.page.clock.resume();
    await expect.poll(() => s.since(mark, "SWING_RESULT").length, { timeout: 3000 }).toBeGreaterThan(0);
    const result = JSON.parse(s.since(mark, "SWING_RESULT")[0]!.raw);
    note("staff-result", JSON.stringify(result).slice(0, 300));
    expect(result.rejected).toBeUndefined();
    expect(result.buffered).toBeUndefined();
    expect(result.comboIndex).toBe(0);
    expect(JSON.stringify(result.hits)).toContain(dummy.id);
    await expect.poll(() => s.grep(mark, /"abilityId":"shot"/).length, { timeout: 3000 }).toBeGreaterThan(0);
    await expect.poll(() => s.grep(mark, /"DAMAGE"/).filter((f) => f.raw.includes(dummy.id)).length, { timeout: 3000 }).toBeGreaterThan(0);
  } finally { s.save(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("7e. staff arcane blast: holding casts every 1100 ms, never combos", async () => {
  const { ctx, s } = await launch(browser, "staff-gating");
  try {
    const replaced = await equipStaff(s);
    staffReplacedMelee ??= replaced;
    const dummy = await s.spawn("training_dummy", 170, 0);
    await s.page.waitForTimeout(800);
    const target = await s.screenOf(dummy.id);
    // Holding the right button casts every 1100 ms (the arcane blast recovery), never faster; every cast is combo 0.
    const mark = s.mark();
    await rightHold(s, target.x, target.y - 12, 3500);
    await s.page.waitForTimeout(600);
    const times = swingsSent(s, mark).map((f) => f.t);
    const combos = s.since(mark, "SWING_RESULT").map((f) => JSON.parse(f.raw).comboIndex);
    const gaps = times.slice(1).map((v, i) => v - times[i]!);
    note("staff-gating", `sent=${times.length} gaps=${JSON.stringify(gaps)} combos=${JSON.stringify(combos)}`);
    expect(times.length).toBeGreaterThanOrEqual(3);
    expect(times.length).toBeLessThanOrEqual(4);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1050);
    expect(combos.every((c) => c === 0)).toBe(true);
    collectLatency(s);
  } finally {
    try {
      if (staffReplacedMelee) await s.sendRaw({ type: "EQUIP_ITEM", instanceId: staffReplacedMelee, slot: "melee" });
      await s.page.waitForTimeout(800);
    } catch (error) { console.log("restore melee failed", error); }
    s.save(); expect(s.errors).toEqual([]); await ctx.close();
  }
});

test("7c. latency sample: 30 paced swings on a dummy", async () => {
  test.setTimeout(120_000);
  const { ctx, s } = await launch(browser, "latency");
  try {
    const dummy = await s.spawn("training_dummy", -30, 50);
    await s.page.waitForTimeout(800);
    const p = await s.screenOf(dummy.id);
    const mark = s.mark();
    for (let i = 0; i < 30; i++) {
      await rightHold(s, p.x, p.y - 12, 60);
      await s.page.waitForTimeout(950); // past the 900 ms finisher recovery, so every press sends
    }
    await s.page.waitForTimeout(500);
    expect(swingsSent(s, mark).length).toBeGreaterThanOrEqual(28);
    collectLatency(s);
  } finally { s.save(); await ctx.close(); }
});

test("8. perf report", async () => {
  const sorted = [...pressToResult].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]! : null;
  const lines: string[] = [`press-to-result (websocket frame pairs, localhost): n=${sorted.length} p95=${p95} ms max=${sorted.at(-1) ?? null} ms`];
  const logPath = process.env.ASH_ATLAS_BACKEND_LOG;
  if (logPath && existsSync(logPath)) {
    await sleep(11_000); // one client perf upload interval (developer sessions) so a perf-sample can land
    const log = readFileSync(logPath, "utf8").split("\n");
    const pick = (needle: string): string | undefined => log.filter((l) => l.includes(needle)).at(-1);
    lines.push(`perf-server: ${pick('"msg":"perf-server"')?.slice(0, 900)}`);
    const sample = pick("perf-sample");
    lines.push(`perf-sample: ${sample ? sample.slice(0, 1500) : "none yet"}`);
  }
  writeFileSync(join(outDir, "perf-report.txt"), lines.join("\n"));
  note("perf", lines.join(" | "));
  console.log(lines.join("\n"));
  expect(p95 === null || p95 < 250).toBe(true);
});

async function cameraProbe(s: Session): Promise<Record<string, unknown>> {
  await findMap(s.page);
  return s.page.evaluate(({ lat, lon }) => {
    const m = (window as any).__e2eMap;
    const p = m.project([lon, lat]);
    const c = m.getCenter();
    const r = m.getContainer().getBoundingClientRect();
    return { zoom: m.getZoom(), minZoom: m.getMinZoom(), maxZoom: m.getMaxZoom(), center: [c.lat, c.lng], bearing: m.getBearing(), pitch: m.getPitch(), screen: [Math.round(p.x), Math.round(p.y)], viewport: [r.width, r.height] };
  }, { lat: s.self.lat, lon: s.self.lon });
}

test("8. high latitude: player visible, recenter and zoom out work", async () => {
  const { ctx, s } = await launch(browser, "polar", { mobile: true });
  try {
    const spots: Array<[number, number]> = (process.env.E2E_POLAR_SPOTS ?? "-80,0;-88,0").split(";").map((p) => p.split(",").map(Number) as [number, number]);
    for (const [lat, lon] of spots) {
      await s.teleport(lat, lon).catch(() => note("teleport-note", `${lat},${lon}: server stopped at ${s.self.lat}`));
      // The app's dev teleport jumps the camera onto the new position at the current zoom (centerDeveloperMap).
      await s.page.evaluate(({ lat, lon }) => (window as any).__e2eMap.jumpTo({ center: [lon, lat], zoom: 15 }), { lat: s.self.lat, lon: s.self.lon });
      await s.page.waitForTimeout(1200);
      note(`polar ${lat} before`, JSON.stringify(await cameraProbe(s)));
      await s.shot(`lat${lat}-before-recenter`);
      // Recenter must always work: on the phone layout a tap on the vitals centres the map on the player.
      await s.page.getByRole("button", { name: /Tap to center the map on you/ }).first().tap({ timeout: 8000 });
      await s.page.waitForTimeout(2500);
      const after = await cameraProbe(s) as any;
      note(`polar ${lat} after-recenter`, JSON.stringify(after));
      await s.shot(`lat${lat}-after-recenter`);
      expect(Math.abs(after.screen[0] - after.viewport[0] / 2)).toBeLessThan(40);
      expect(Math.abs(after.screen[1] - after.viewport[1] / 2)).toBeLessThan(40);
      // Ground-zoom camera: recenter shows ground zoom 15, i.e. camera zoom 15 - log2(1 / cos(lat)) (latitude clamped to 85).
      const expectedCamera = 15 - Math.log2(1 / Math.cos((Math.min(85, Math.abs(after.center[0] as number)) * Math.PI) / 180));
      expect(Math.abs(after.zoom - expectedCamera), "recenter frames the polar camera at ground zoom 15").toBeLessThan(0.05);
      // Zoom out must always work, and the player stays on screen.
      await s.page.waitForTimeout(2000);
      await findMap(s.page);
      await s.page.evaluate(() => { const m = (window as any).__e2eMap; m.zoomTo(m.getMinZoom(), { duration: 0 }, { originalEvent: new WheelEvent("wheel") }); });
      await s.page.waitForTimeout(800);
      const out = await cameraProbe(s) as any;
      note(`polar ${lat} zoomed-out`, JSON.stringify(out));
      expect(out.zoom).toBeLessThanOrEqual(out.minZoom + 0.05);
      expect(out.screen[0]).toBeGreaterThan(0); expect(out.screen[0]).toBeLessThan(out.viewport[0]);
      expect(out.screen[1]).toBeGreaterThan(0); expect(out.screen[1]).toBeLessThan(out.viewport[1]);
    }
    expect(s.errors).toEqual([]);
  } finally { s.save(); await ctx.close(); }
});
