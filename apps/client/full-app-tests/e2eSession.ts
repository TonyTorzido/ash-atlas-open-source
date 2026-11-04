/**
 * Shared full-app e2e session helpers (copied from actionCombat.spec.ts so new specs need not import a spec file).
 * Session records every websocket frame and tracks combat entities; launch() signs in as "Default Dev" and teleports to TEST_SPOT.
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
      const known = typeof o.entityId === "string" ? this.ents.get(o.entityId) : undefined;
      if (typeof o.entityId === "string" && typeof o.lat === "number" && typeof o.lon === "number" && (typeof o.kind === "string" || known)) {
        // Combat deltas carry only changed fields (no kind): update a known entity in place instead of dropping the move.
        this.ents.set(o.entityId, {
          id: o.entityId,
          kind: typeof o.kind === "string" ? o.kind : known!.kind,
          archetype: (o.archetypeKey as string | null | undefined) ?? known?.archetype ?? null,
          lat: o.lat,
          lon: o.lon,
          hp: typeof o.currentHealth === "number" ? o.currentHealth : known?.hp ?? null
        });
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

interface LaunchOptions { /** Explicit CSS viewport (phone checks), overrides the mobile/desktop default. */ viewport?: { width: number; height: number }; /** Install page.clock before the page loads (it keeps running in real time until paused), so performance.now never restarts mid-session. */ clock?: boolean; mobile?: boolean; gamepad?: boolean; joystick?: boolean; /** Extra localStorage entries set before the app loads (per-device preferences). */ storage?: Record<string, string>; /** Simulated phone network: every websocket frame each way is held rttMs/2 plus up to +-jitterMs (order kept). */ net?: { rttMs: number; jitterMs: number }; /** Device pixel ratio for the viewport/mobile contexts (default 2; iPhones are 3). */ dpr?: number; /** Script source run in every page before the app code (debug hooks). */ initScript?: string; /** Leave the player where the session resumed (a spec that cleans up an interior itself). */ skipTeleport?: boolean; /** Dev sign-in button (default "Default Dev"); a new account is onboarded with this display name. */ devButton?: string; newPlayerName?: string }

async function launch(browser: Browser, name: string, options: LaunchOptions = {}): Promise<{ ctx: BrowserContext; s: Session }> {
  const ctx = await browser.newContext(options.viewport
    ? { viewport: options.viewport, deviceScaleFactor: options.dpr ?? 2, hasTouch: true, isMobile: true }
    : options.mobile
    ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: options.dpr ?? 2, hasTouch: true, isMobile: true }
    : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  if (options.initScript) await page.addInitScript(options.initScript);
  await page.addInitScript((opts) => {
    const W = window.WebSocket; (window as any).__e2eSockets = [];
    const net = opts.net;
    const delayed = new WeakSet<Event>();
    // In-order delivery like TCP: one FIFO per direction, drained by a single timer (separate setTimeouts can swap
    // two frames a millisecond apart, which a real socket never does).
    const fifo = () => {
      const queue: { at: number; run: () => void }[] = [];
      let last = 0; let timer = 0;
      const drain = (): void => {
        timer = 0;
        const now = performance.now();
        while (queue.length && queue[0]!.at <= now + 0.5) queue.shift()!.run();
        if (queue.length) timer = window.setTimeout(drain, Math.max(0, queue[0]!.at - performance.now()));
      };
      return (run: () => void): void => {
        last = Math.max(performance.now() + net!.rttMs / 2 + (Math.random() * 2 - 1) * net!.jitterMs, last + 0.1);
        queue.push({ at: last, run });
        if (!timer) timer = window.setTimeout(drain, Math.max(0, queue[0]!.at - performance.now()));
      };
    };
    const outQueue = net ? fifo() : null;
    const inQueue = net ? fifo() : null;
    if (net) {
      const P = W.prototype as any;
      const origSend = P.send; const origAdd = P.addEventListener; const origRemove = P.removeEventListener;
      P.send = function (this: WebSocket, data: any) {
        const ws = this;
        outQueue!(() => { if (ws.readyState === 1) origSend.call(ws, data); });
      };
      const wrappers = new WeakMap<Function, EventListener>();
      P.addEventListener = function (this: WebSocket, type: string, fn: any, o?: any) {
        if (type !== "message" || typeof fn !== "function") return origAdd.call(this, type, fn, o);
        let w = wrappers.get(fn); if (!w) { w = function (this: unknown, ev: Event) { if (delayed.has(ev)) fn.call(this, ev); }; wrappers.set(fn, w); }
        return origAdd.call(this, type, w, o);
      };
      P.removeEventListener = function (this: WebSocket, type: string, fn: any, o?: any) {
        return origRemove.call(this, type, (type === "message" && wrappers.get(fn)) || fn, o);
      };
    }
    const Wrapped: any = function (this: unknown, ...a: any[]) {
      const s = new (W as any)(...a); (window as any).__e2eSockets.push(s);
      if (net) {
        let handler: ((ev: MessageEvent) => void) | null = null;
        Object.defineProperty(s, "onmessage", { configurable: true, get: () => handler, set: (h) => { handler = h; } });
        EventTarget.prototype.addEventListener.call(s, "message", (ev: Event) => {
          if (delayed.has(ev)) return;
          const data = (ev as MessageEvent).data;
          inQueue!(() => {
            if (typeof data === "string" && data.startsWith('{"type":"PLAYER_')) ((window as any).__simIn ??= []).push(`${performance.now().toFixed(0)} ${/"type":"(\w+)"/.exec(data)?.[1]} ${/"sequence":(\d+)/.exec(data)?.[1]}`);
            const e2 = new MessageEvent("message", { data }); delayed.add(e2); s.dispatchEvent(e2); handler?.call(s, e2);
          });
        });
      }
      return s;
    };
    Wrapped.prototype = W.prototype; Object.assign(Wrapped, W); (window as any).WebSocket = Wrapped;
    if (opts.joystick) { try { localStorage.setItem("ashAtlas.joystickMovement.v1", "1"); } catch { /* ignore */ } }
    for (const [k, v] of Object.entries(opts.storage ?? {})) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
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
  const dev = page.getByRole("button", { name: options.devButton ?? "Default Dev" });
  await dev.waitFor({ state: "visible", timeout: 20_000 });
  // The dev-login endpoint rate-limits bursts of sign-ins ("Authentication service unavailable"): back off and retry.
  for (let attempt = 0; attempt < 6; attempt++) {
    await dev.click();
    const curtain = page.locator("main.initial-curtain");
    const failed = page.getByText("Authentication service unavailable");
    await curtain.or(failed).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    if (!(await failed.isVisible().catch(() => false))) break;
    await page.waitForTimeout(10_000);
  }
  // A fresh account (a new disposable runtime) is asked to create its player first.
  const createPlayer = page.getByRole("heading", { name: "Create your player" });
  await createPlayer.or(page.locator("canvas.maplibregl-canvas").first()).first().waitFor({ timeout: 60_000 }).catch(() => undefined);
  if (await createPlayer.isVisible().catch(() => false)) {
    await page.getByRole("textbox", { name: "Display name" }).fill(options.newPlayerName ?? `E2E${Date.now() % 100000}`);
    await page.getByRole("radio", { name: "Gold" }).check();
    await page.getByRole("button", { name: "Create Player" }).click();
  }
  await page.locator("main.initial-curtain").waitFor({ state: "detached", timeout: 60_000 });
  await page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "attached", timeout: 30_000 });
  await page.waitForTimeout(2500);
  const respawn = page.getByRole("button", { name: "Respawn" });
  if (await respawn.isVisible()) { await respawn.click(); await page.waitForTimeout(1500); }
  await exposeMap(page);
  await expect.poll(() => s.self.id, { timeout: 10_000 }).not.toBe("");
  // A session that resumed inside a DOM interior (manor, salon, greenhouse) keeps the map hidden: the spec leaves it itself.
  if (options.skipTeleport) return { ctx, s };
  await s.page.locator("canvas.maplibregl-canvas").first().waitFor({ state: "visible", timeout: 30_000 });
  await s.ensureWeapon("melee");
  await s.clearMobs();
  // A respawn lands at the home anchor; fight at the dev account's usual spot instead (mobs ignore the anchor area).
  await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
  return { ctx, s };
}

function note(type: string, description: string): void { test.info().annotations.push({ type, description }); console.log(`[${type}] ${description}`); }
const TEST_SPOT = { lat: 29.760155504298524, lon: -82.34756038216241 };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export { Session, launch, note, sleep, TEST_SPOT, outDir, baseUrl, type Frame, type Ent };
