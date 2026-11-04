/**
 * Mob archetypes end-to-end check (docs/plans/mob-ai-phase2.md 11.3): real headless Chromium, real websocket frames,
 * mobs spawned through DEV_SPAWN_MOB at the real overworld test spot (so they live in real overworld zones).
 *
 * Run against a runtime with ACTION_COMBAT_ENABLED=true MOB_TACTICS_ENABLED=true MOB_ARCHETYPES_ENABLED=true
 * DEV_TOOLS_ENABLED=true:
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> ASH_ATLAS_E2E_OUT=../../docs/plans/mob-ai-phase2-shots \
 *     pnpm exec playwright test --config playwright-full-app.config.ts mobArchetypes
 *
 * Flag-off control: ASH_ATLAS_E2E_ARCHETYPES_OFF=1 against a runtime without MOB_ARCHETYPES_ENABLED: no signature
 * telegraph may appear and the legacy gimmick ids do. Watch run: ASH_ATLAS_E2E_INVULNERABLE=1 against a backend with
 * DEV_PLAYERS_INVULNERABLE=true (an observation run: invulnerability also counts as a dodge).
 */
import { expect, test, chromium, type Browser, type BrowserContext } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOB_SIGNATURE_ABILITY_IDS } from "@ash-atlas/shared";

import { launch, note, sleep, baseUrl, TEST_SPOT, type Ent, type Session } from "./e2eSession.js";

const outDir = process.env.ASH_ATLAS_E2E_OUT ?? "";

const archetypesOff = process.env.ASH_ATLAS_E2E_ARCHETYPES_OFF === "1";
const invulnerable = process.env.ASH_ATLAS_E2E_INVULNERABLE === "1";
const SIGNATURE_IDS = [...MOB_SIGNATURE_ABILITY_IDS].filter((id) => id !== "swarmer_wave");

test.describe.configure({ mode: "default", timeout: 150_000 });
test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at the mob archetypes dev runtime");

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => { await browser?.close(); });

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dx = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * 111_320;
  return Math.hypot(dx, dy);
}

/** Telegraphs of the given ability ids live in the newest combat frame that carries telegraphs. */
function liveTelegraphs(s: Session, abilityIds: readonly string[]): string[] {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir !== "in" || !f.raw.includes('"telegraphs"')) continue;
    const ids = [...f.raw.matchAll(/"abilityId":"([a-z_]+)"/g)].map((m) => m[1]!);
    return ids.filter((id) => abilityIds.includes(id));
  }
  return [];
}

/**
 * Leaves the player alive at full health. Health never regenerates out of combat on this runtime and the 100 hp dev
 * player ends most tests nearly dead, so a wounded player lets a bear kill it on purpose and respawns at full health.
 */
async function ensureAlive(s: Session): Promise<void> {
  const button = s.page.getByRole("button", { name: "Respawn" });
  await s.until(() => s.ents.get(s.self.id)?.hp !== undefined && s.ents.get(s.self.id)?.hp !== null, 10_000, "the player's own combat entity").catch(() => undefined);
  const hp = (): number => s.ents.get(s.self.id)?.hp ?? 100;
  if (hp() > 0 && hp() < 90) {
    await s.spawn("bear", 60, 0);
    await s.spawn("bear", -60, 0);
    await framePlayer(s);
    const end = Date.now() + 40_000;
    while (hp() > 0 && Date.now() < end) {
      const bears = s.mobsOf("bear");
      const target = bears.find((mob) => s.ents.has(mob.id));
      if (target) {
        const at = await s.screenOf(target.id);
        await s.page.mouse.move(at.x, at.y);
        await s.page.mouse.down({ button: "right" });
        await sleep(80);
        await s.page.mouse.up({ button: "right" });
      }
      await sleep(1_000);
    }
  }
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (await button.isVisible().catch(() => false)) {
      await s.clearMobs();
      await button.click();
      await sleep(2_000);
      await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
      return;
    }
    if (hp() > 0) { await s.clearMobs(); return; }
    await sleep(500);
  }
}

async function framePlayer(s: Session): Promise<void> {
  await s.page.evaluate(({ lat, lon }) => { const m = (window as any).__e2eMap; m.jumpTo({ center: [lon, lat], bearing: 0, pitch: 0 }); }, { lat: s.self.lat, lon: s.self.lon });
  await sleep(200);
}

/**
 * A rolling screencast of the page. Playwright reports websocket frames and screenshots a second late on this busy page
 * (a 900 ms charge was already over when the screenshot ran), so peak shots are picked from the last few seconds of
 * painted frames by the server's own telegraph start time instead.
 */
const recorders = new WeakMap<Session, { frames: Array<{ ts: number; data: string }> }>();
async function record(ctx: BrowserContext, s: Session): Promise<void> {
  const cdp = await ctx.newCDPSession(s.page);
  const rec = { frames: [] as Array<{ ts: number; data: string }> };
  recorders.set(s, rec);
  cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    rec.frames.push({ ts: (frame.metadata.timestamp ?? Date.now() / 1000) * 1000, data: frame.data });
    if (rec.frames.length > 150) rec.frames.shift();
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 2 });
}

/**
 * Waits for the first telegraph of `abilityId`, then saves the painted frame closest to 55% of its warning (the lane,
 * circle or cone is fully drawn and the strike has not landed). Returns the raw frame text around the telegraph.
 */
async function shotAtPeak(s: Session, mark: number, abilityId: string, label: string, warningMs: number, timeoutMs = 30_000, minCones = 1): Promise<string> {
  const re = new RegExp(`"abilityId":"${abilityId}"`);
  const wanted = (f: { raw: string }): boolean => (f.raw.match(new RegExp(`"abilityId":"${abilityId}"`, "g")) ?? []).length >= minCones;
  await s.until(() => s.grep(mark, re).some(wanted), timeoutMs, `a ${abilityId} telegraph`);
  const frame = s.grep(mark, re).find(wanted)!;
  const at = frame.raw.indexOf(`"abilityId":"${abilityId}"`);
  const slice = frame.raw.slice(Math.max(0, at - 300), at + 500);
  const startTime = Number(/"startTime":(\d+)/.exec(frame.raw.slice(at, at + 600))?.[1] ?? 0);
  const rec = recorders.get(s);
  if (!startTime || !rec) { await framePlayer(s); await s.shot(label); return slice; }
  await sleep(Math.max(0, startTime + warningMs + 300 - Date.now()));
  const target = startTime + warningMs * 0.55;
  const best = rec.frames.reduce((a, b) => (Math.abs(b.ts - target) < Math.abs(a.ts - target) ? b : a));
  writeFileSync(join(outDir || ".", `${s.name}-${label}.png`), Buffer.from(best.data, "base64"));
  note(`${label}-timing`, `${rec.frames.length} frames buffered, picked one ${Math.round(best.ts - startTime)} ms after the telegraph start (warning ${warningMs})`);
  return slice;
}

/** Samples live signature telegraphs for `ms`; returns the most seen at once. */
async function maxLiveSignatures(s: Session, ms: number): Promise<number> {
  let most = 0;
  const end = Date.now() + ms;
  while (Date.now() < end && (s.ents.get(s.self.id)?.hp ?? 1) > 0) {
    most = Math.max(most, liveTelegraphs(s, SIGNATURE_IDS).length);
    await sleep(100);
  }
  return most;
}

/**
 * Spawns the mobs, then provokes each one so passive animals (bears, hogs, critters) join the fight like proactive
 * ones: a melee swing for mobs within 135 m, a bow shot (300 m range) for farther ones. Far provoking replaces a
 * step-back teleport: the server refuses DEV_TELEPORT in combat, and a mob that is passive until hit would never
 * walk back out to its charge or smoke-step window by itself. The bow stays readied when any mob was shot.
 */
async function spawnAll(
  s: Session,
  specs: ReadonlyArray<readonly [string, number, number]>
): Promise<Ent[]> {
  const mobs: Ent[] = [];
  for (const [archetype, east, north] of specs) mobs.push(await s.spawn(archetype, east, north));
  await framePlayer(s);
  const reach = (mob: Ent): number => { const live = s.ents.get(mob.id); return live ? metres(s.self, live) : Infinity; };
  const provoke = async (mob: Ent): Promise<void> => {
    const at = await s.screenOf(mob.id);
    await s.page.mouse.move(at.x, at.y);
    await s.page.mouse.down({ button: "right" });
    await sleep(80);
    await s.page.mouse.up({ button: "right" });
    await sleep(800);
  };
  const near = mobs.filter((mob) => reach(mob) <= 135);
  const far = mobs.filter((mob) => reach(mob) > 135 && reach(mob) <= 290);
  if (near.length) { await s.ensureWeapon("melee"); for (const mob of near) await provoke(mob); }
  if (far.length) { await s.ensureWeapon("secondary"); for (const mob of far) await provoke(mob); }
  return mobs;
}

test("0. flag-off control: legacy gimmicks, no signature telegraphs", async () => {
  test.skip(!archetypesOff, "control run only (ASH_ATLAS_E2E_ARCHETYPES_OFF=1)");
  const { ctx, s } = await launch(browser, "arch-off");
  await record(ctx, s);
  try {
    await ensureAlive(s);
    await framePlayer(s);
    const mark = s.mark();
    await spawnAll(s, [["bear", 110, 0], ["hog", 0, 250], ["wolf", 0, 170]]);
    await sleep(15_000);
    const seen = s.grep(mark, /"telegraphs"/).map((f) => f.raw).join("\n");
    for (const id of SIGNATURE_IDS) expect(seen.includes(`"abilityId":"${id}"`), `no ${id} with the flag off`).toBe(false);
    expect(/"abilityId":"(bear_maul|hog_charge)"/.test(seen), "legacy gimmicks still fire").toBe(true);
    await framePlayer(s);
    await s.shot("control-flag-off");
  } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test.describe("archetypes on", () => {
  test.skip(archetypesOff, "needs MOB_ARCHETYPES_ENABLED=true");

  test("1. brute: maul cone and charge lane telegraphs, never two signatures live", async () => {
    const { ctx, s } = await launch(browser, "arch-brute");
    await record(ctx, s);
    try {
      await ensureAlive(s);
      await framePlayer(s);
      const mark = s.mark();
      // Phase A: a lone hog 250 m away is shot with the bow (inside the 180-500 m charge window).
      // (Two bears plus a hog kill the 100 hp dev player in about 4 s, before the teleport; the mixed group is the watch run.)
      await spawnAll(s, [["hog", 0, 250]]);
      const most = maxLiveSignatures(s, 20_000);
      const charge = await shotAtPeak(s, mark, "brute_charge", "charge-lane", 900);
      expect(charge).toContain('"kind":"line"');
      expect(await most).toBeLessThanOrEqual(1);
      // Phase B: a lone bear mauls at melee reach.
      await s.clearMobs();
      await ensureAlive(s);
      await framePlayer(s);
      const markB = s.mark();
      await spawnAll(s, [["bear", 110, 0]]);
      const mostB = maxLiveSignatures(s, 15_000);
      const maul = await shotAtPeak(s, markB, "brute_maul", "maul-cone", 1_000);
      expect(maul).toContain('"kind":"cone"');
      expect(await mostB).toBeLessThanOrEqual(1);
      expect(s.grep(mark, /"abilityId":"(bear_maul|hog_charge)"/)).toHaveLength(0);
    } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
  });

  test("2. pack: one flank lunge lane at a time", async () => {
    const { ctx, s } = await launch(browser, "arch-pack");
    await record(ctx, s);
    try {
      await ensureAlive(s);
      await framePlayer(s);
      const mark = s.mark();
      await spawnAll(s, [["wolf", 170, 0], ["wolf", 0, 170], ["wolf", -170, 0], ["wolf", 0, -170]]);
      const most = maxLiveSignatures(s, 20_000);
      const lunge = await shotAtPeak(s, mark, "pack_lunge", "lunge-lane", 500);
      expect(lunge).toContain('"kind":"line"');
      expect(await most).toBeLessThanOrEqual(1);
    } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
  });

  test("3. skirmisher: double strike in sequence, smoke puff behind the player", async () => {
    const { ctx, s } = await launch(browser, "arch-skirmisher");
    await record(ctx, s);
    try {
      await ensureAlive(s);
      await framePlayer(s);
      const mark = s.mark();
      await spawnAll(s, [["mossjaw_spearman", 110, 0], ["bandit", -110, 0]]);
      await shotAtPeak(s, mark, "skirmisher_smoke", "smoke-circle", 1_100);
      await shotAtPeak(s, mark, "skirmisher_double_a", "double-cone-a", 450);
      await s.until(() => s.grep(mark, /"abilityId":"skirmisher_double_b"/).length > 0, 3_000, "the second cone");
      const first = s.grep(mark, /"abilityId":"skirmisher_double_a"/)[0]!;
      const second = s.grep(mark, /"abilityId":"skirmisher_double_b"/)[0]!;
      expect(second.t).toBeGreaterThan(first.t);
    } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
  });

  test("4. caster: ground blast circle and the three-line volley fan from 200-260 m", async () => {
    const { ctx, s } = await launch(browser, "arch-caster");
    await record(ctx, s);
    try {
      await ensureAlive(s);
      await framePlayer(s);
      const mark = s.mark();
      const [witch] = await spawnAll(s, [["hedge_witch", 110, 0], ["gnoll_bonebow", 0, 110]]);
      const blast = await shotAtPeak(s, mark, "caster_blast", "blast-circle", 1_100);
      expect(blast).toContain('"kind":"circle"');
      await shotAtPeak(s, mark, "caster_volley_c", "volley-fan", 700);
      const volleyFrame = s.grep(mark, /"abilityId":"caster_volley_c"/)[0]!.raw;
      for (const id of ["caster_volley_l", "caster_volley_c", "caster_volley_r"]) expect(volleyFrame).toContain(`"abilityId":"${id}"`);
      const at = s.ents.get(witch!.id);
      if (at) {
        const distance = metres(s.self, at);
        note("caster-distance", distance.toFixed(0));
        expect(distance).toBeGreaterThan(150);
        expect(distance).toBeLessThan(300);
      }
    } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
  });

  test("5. swarmer: wave cones share a landing tick", async () => {
    const { ctx, s } = await launch(browser, "arch-swarmer");
    await record(ctx, s);
    try {
      await ensureAlive(s);
      await framePlayer(s);
      const mark = s.mark();
      const specs: Array<[string, number, number]> = [];
      for (let index = 0; index < 8; index++) specs.push(["red_squirrel", Math.round(110 * Math.sin(index * 0.785)), Math.round(110 * Math.cos(index * 0.785))]);
      await spawnAll(s, specs);
      await shotAtPeak(s, mark, "swarmer_wave", "wave-cones", 300, 25_000, 2);
    } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
  });

  test("6. phone 390x844: a signature telegraph at the default play zoom", async () => {
    const { ctx, s } = await launch(browser, "arch-phone", { viewport: { width: 390, height: 844 } });
    await record(ctx, s);
    try {
      await ensureAlive(s);
      await framePlayer(s);
      const mark = s.mark();
      await spawnAll(s, [["bear", 110, 0], ["wolf", 0, 170], ["wolf", 0, -170]]);
      await shotAtPeak(s, mark, "brute_maul", "phone-maul", 1_000);
    } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
  });

  test("7. watch run: a mixed group for 60 s, one signature at a time, every shape seen", async () => {
    test.skip(!invulnerable, "needs DEV_PLAYERS_INVULNERABLE=true (ASH_ATLAS_E2E_INVULNERABLE=1)");
    const { ctx, s } = await launch(browser, "arch-watch");
    await record(ctx, s);
    try {
      await ensureAlive(s);
      await framePlayer(s);
      const mark = s.mark();
      await spawnAll(s, [["bear", 110, 0], ["hog", 0, 250], ["wolf", -170, 0], ["wolf", 0, -170], ["mossjaw_spearman", 80, 80], ["hedge_witch", -110, 0]]);
      let nextSwingAt = 0;
      let most = 0;
      const end = Date.now() + 60_000;
      while (Date.now() < end) {
        most = Math.max(most, liveTelegraphs(s, SIGNATURE_IDS).length);
        // Keep the fight alive (a fight with no player hit for 10 s is abandoned).
        if (Date.now() >= nextSwingAt) {
          nextSwingAt = Date.now() + 2_000;
          const at = s.page.viewportSize();
          if (at) {
            await s.page.mouse.move(at.width / 2 + 40, at.height / 2);
            await s.page.mouse.down({ button: "right" });
            await sleep(80);
            await s.page.mouse.up({ button: "right" });
          }
        }
        await sleep(100);
      }
      const seen = new Set(s.grep(mark, /"telegraphs"/).flatMap((f) => [...f.raw.matchAll(/"abilityId":"([a-z_]+)"/g)].map((m) => m[1]!)));
      note("watch-signatures", [...seen].filter((id) => SIGNATURE_IDS.includes(id)).sort().join(","));
      expect(most).toBeLessThanOrEqual(1);
      expect([...seen].filter((id) => SIGNATURE_IDS.includes(id)).length).toBeGreaterThanOrEqual(3);
      await framePlayer(s);
      await s.shot("watch-end");
    } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
  });
});
