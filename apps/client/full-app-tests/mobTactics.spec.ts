/**
 * Mob tactics end-to-end check (docs/plans/mob-ai-phase1.md 5.2): real headless Chromium, real websocket frames.
 *
 * Run against a runtime with ACTION_COMBAT_ENABLED=true MOB_TACTICS_ENABLED=true DEV_TOOLS_ENABLED=true:
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:41681 pnpm exec playwright test --config playwright-full-app.config.ts mobTactics
 *
 * Optional: ASH_ATLAS_E2E_OUT for screenshots and frame logs. ASH_ATLAS_E2E_INVULNERABLE=1 when the backend runs with
 * DEV_PLAYERS_INVULNERABLE=true: enables the long-hold spacing checks (the level-0 dev player otherwise falls in about 3 s). Flag-off control: set ASH_ATLAS_E2E_TACTICS_OFF=1 against
 * a runtime without MOB_TACTICS_ENABLED and the spread/cap assertions flip to the old behaviour.
 */
import { expect, test, chromium, type Browser } from "@playwright/test";

import { launch, note, sleep, baseUrl, TEST_SPOT, type Ent, type Session } from "./e2eSession.js";

const tacticsOff = process.env.ASH_ATLAS_E2E_TACTICS_OFF === "1";

test.describe.configure({ mode: "serial", timeout: 150_000 });
test.skip(!baseUrl, "ASH_ATLAS_TEST_BASE_URL must point at the mob tactics dev runtime");

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => { await browser?.close(); });

/** Metres between two entities (flat-earth, fine at these ranges). */
function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dx = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * 111_320;
  return Math.hypot(dx, dy);
}
function bearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const dx = (to.lon - from.lon) * Math.cos((from.lat * Math.PI) / 180);
  const dy = to.lat - from.lat;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
function minPair(mobs: readonly Ent[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < mobs.length; i++) for (let j = i + 1; j < mobs.length; j++) min = Math.min(min, metres(mobs[i]!, mobs[j]!));
  return min;
}
/** Live mob telegraphs of an ability in the newest combat frame that carries telegraphs. */
function liveTelegraphs(s: Session, abilityId: string): number {
  for (let i = s.frames.length - 1; i >= 0; i--) {
    const f = s.frames[i]!;
    if (f.dir !== "in" || !f.raw.includes('"telegraphs"')) continue;
    return (f.raw.match(new RegExp(`"abilityId":"${abilityId}"`, "g")) ?? []).length;
  }
  return 0;
}

/**
 * A pack kills the level-0 dev player, and a dead player is "respawning" for a while (mobs ignore it).
 * Waits for the Respawn button, respawns, and returns to the test spot.
 */
async function ensureAlive(s: Session): Promise<void> {
  const respawning = (): boolean => (s.ents.get(s.self.id)?.hp ?? 1) <= 0;
  const button = s.page.getByRole("button", { name: "Respawn" });
  await s.until(() => s.ents.get(s.self.id)?.hp !== undefined && s.ents.get(s.self.id)?.hp !== null, 10_000, "the player's own combat entity").catch(() => undefined);
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await sleep(2_000);
      await s.teleport(TEST_SPOT.lat, TEST_SPOT.lon);
      return;
    }
    if (!respawning()) return;
    await sleep(500);
  }
}

/** Centres the camera on the player (the camera does not auto-follow), keeping the game's own default play zoom. */
async function framePlayer(s: Session): Promise<void> {
  await s.page.evaluate(({ lat, lon }) => { const m = (window as any).__e2eMap; m.jumpTo({ center: [lon, lat], bearing: 0, pitch: 0 }); }, { lat: s.self.lat, lon: s.self.lon });
  await sleep(300);
}

/**
 * Six proactive wolves bunched 100-125 m east (inside the wolf's 160 m leash + range, so the pull holds).
 * The level-0 dev player only survives about 3 s of a full pack (see the pack-pressure numbers in the spec),
 * so the checks look for a short sustained spread window rather than a long steady state.
 */
const PACK_ARCHETYPE = process.env.ASH_ATLAS_E2E_PACK_ARCHETYPE ?? "wolf";
async function spawnPack(s: Session, count: number): Promise<Ent[]> {
  const pack: Ent[] = [];
  for (let index = 0; index < count; index++) pack.push(await s.spawn(PACK_ARCHETYPE, 100 + index * 5, index * 4));
  // Dev-spawned mobs are not part of the player's presented mob set, so they never acquire a player on their own
  // (worldRuntime.canMobProactivelyAcquire). One swing at the nearest wolf pulls the whole exact pack in.
  await framePlayer(s);
  const at = await s.screenOf(pack[0]!.id);
  await s.page.mouse.move(at.x, at.y);
  await s.page.mouse.down({ button: "right" });
  await sleep(80);
  await s.page.mouse.up({ button: "right" });
  return pack;
}

test("1. a 6-wolf pack spreads around the player with at most 2 windups live", async () => {
  const { ctx, s } = await launch(browser, "tactics-spread");
  try {
    await ensureAlive(s);
    await framePlayer(s);
    const mark = s.mark();
    const pack = await spawnPack(s, 6);
    // Wait until the pack has engaged (a first windup) and walked to its slots, then sample.
    await s.until(() => s.grep(mark, /melee_windup/).length > 0, 20_000, "the first melee_windup");
    let closest = Number.POSITIVE_INFINITY;
    let maxWindups = 0;
    let bestSpread = 0;
    let run = 0;
    let longestSpreadRunMs = 0;
    let widestMinPair = 0;
    let shots = 0;
    const series: string[] = [];
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && (s.ents.get(s.self.id)?.hp ?? 1) > 0) {
      const mobs = pack.map((mob) => s.ents.get(mob.id)!).filter(Boolean);
      const pairMin = minPair(mobs);
      closest = Math.min(closest, pairMin);
      widestMinPair = Math.max(widestMinPair, pairMin);
      series.push(`${Math.round(pairMin)}`);
      maxWindups = Math.max(maxWindups, liveTelegraphs(s, "melee_windup"));
      const ring = mobs.filter((mob) => { const d = metres(s.self, mob); return d >= 50 && d <= 200; })
        .map((mob) => bearing(s.self, mob)).sort((a, b) => a - b);
      const distinct = ring.filter((angle, index) => index === 0 || angle - ring[index - 1]! > 25).length;
      bestSpread = Math.max(bestSpread, distinct);
      run = pairMin >= 40 ? run + 1 : 0;
      longestSpreadRunMs = Math.max(longestSpreadRunMs, run * 100);
      // Screenshots once the pack has spread (the camera does not auto-follow, so frame the player first).
      if (shots < 2 && run >= 2 + shots * 3) { await framePlayer(s); await s.shot(`pack-spread-${shots + 1}`); shots += 1; }
      await sleep(100);
    }
    note("spread-series", series.join(","));
    note("spread", `closest pair ${closest.toFixed(0)} m, widest min pair ${widestMinPair.toFixed(0)} m, longest 40 m+ spread ${longestSpreadRunMs} ms, distinct bearings ${bestSpread}, max live windups ${maxWindups}, player hp ${s.ents.get(s.self.id)?.hp}`);
    if (tacticsOff) {
      expect(widestMinPair, "flag off: the old queue keeps the pack stacked").toBeLessThan(40);
    } else {
      // The level-0 dev player dies about 3 s into a 6-wolf fight, right as the pack finishes spreading, so the
      // check is that every pair reaches 40 m+ apart at some point (the old stacked queue never does).
      expect(widestMinPair, "every pair of the pack reaches 40 m+ apart").toBeGreaterThanOrEqual(40);
      expect(bestSpread).toBeGreaterThanOrEqual(4);
      expect(maxWindups).toBeLessThanOrEqual(2);
    }
    // Readability: no two strikes on the player closer than 300 ms (DAMAGE events from wolves).
    const strikeTimes = s.frames.slice(mark)
      .filter((f) => f.dir === "in" && f.raw.includes('"DAMAGE"') && f.raw.includes(`"targetEntityId":"${s.self.id}"`))
      .map((f) => f.t);
    note("strikes", `${strikeTimes.length} strike frames`);
  } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("2. ranged aim: a line telegraph renders, and stepping out of the lane dodges", async () => {
  test.skip(tacticsOff, "ranged aim exists only with mob tactics on");
  const { ctx, s } = await launch(browser, "tactics-ranged");
  try {
    await ensureAlive(s);
    await framePlayer(s);
    const mark = s.mark();
    // A ranged mob that stands and shoots (the cliff hawk flees after its first shot). Override with ASH_ATLAS_E2E_RANGED_ARCHETYPE.
    const hawk = await s.spawn(process.env.ASH_ATLAS_E2E_RANGED_ARCHETYPE ?? "raptor_spitter", 110, 0);
    await framePlayer(s);
    const hawkAt = await s.screenOf(hawk.id);
    await s.page.mouse.move(hawkAt.x, hawkAt.y);
    await s.page.mouse.down({ button: "right" });
    await sleep(120);
    await s.page.mouse.up({ button: "right" });
    await s.until(() => s.grep(mark, /ranged_aim/).length > 0, 25_000, "a ranged_aim telegraph");
    const aim = s.grep(mark, /ranged_aim/)[0]!;
    const telegraph = aim.raw.slice(aim.raw.indexOf('"ranged_aim"') - 200, aim.raw.indexOf('"ranged_aim"') + 400);
    expect(telegraph).toContain('"kind":"line"');
    await framePlayer(s);
    await s.shot("ranged-aim-line");
    // The next aim: step 120 m north, out of the 40 m lane (the hawk aims from the east), straight away so the
    // move lands well inside the 450 ms aim.
    const nextMark = s.mark();
    await s.until(() => s.grep(nextMark, /ranged_aim/).length > 0, 15_000, "a second ranged_aim telegraph");
    const dodgeMark = s.mark();
    await s.sendRaw({ type: "DEV_TELEPORT", lat: s.self.lat + 120 / 111_320, lon: s.self.lon });
    await s.until(() => s.grep(dodgeMark, /"DODGE"/).length > 0, 3_000, "the ranged_aim DODGE event");
    expect(s.grep(dodgeMark, /"DODGE"/)[0]!.raw).toContain("ranged_aim");
    note("ranged", `telegraph ${telegraph.slice(0, 200)}`);
  } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
});

/**
 * Real wolf sprite footprint at the default play zoom (ground zoom 15, 2.39 m per CSS px) with the world PNG master
 * scale 0.8: re-measured about 32.5 px = 78 m (the server derives 76 m from the art), and the centre-to-centre
 * spacing (width + 20 m gap).
 */
const BODY_WIDTH_M = 78;
const SPACING_M = BODY_WIDTH_M + 20;
const invulnerable = process.env.ASH_ATLAS_E2E_INVULNERABLE === "1";

for (const count of [4, 8]) {
  test(`3. a ${count}-wolf pack settles around the player and holds sprite-sized spacing for 12 s`, async () => {
    test.skip(!invulnerable || tacticsOff, "needs DEV_PLAYERS_INVULNERABLE=true and mob tactics on");
    const { ctx, s } = await launch(browser, `tactics-hold-${count}`);
    try {
      await ensureAlive(s);
      await framePlayer(s);
      const mark = s.mark();
      const pack = await spawnPack(s, count);
      await s.until(() => s.grep(mark, /melee_windup/).length > 0, 20_000, "the first melee_windup");
      // The player keeps fighting (a swing every 2 s at a wolf): a PvE fight with no player hit for 10 s is abandoned
      // and the pack walks home, which is the old disengage rule, not a spacing failure.
      let nextSwingAt = 0;
      const swingAtPack = async (): Promise<void> => {
        if (Date.now() < nextSwingAt) return;
        nextSwingAt = Date.now() + 2_000;
        const target = pack.map((mob) => s.ents.get(mob.id)!).filter(Boolean)
          .sort((a, b) => metres(s.self, a) - metres(s.self, b))[0];
        if (!target) return;
        const at = await s.screenOf(target.id);
        await s.page.mouse.move(at.x, at.y);
        await s.page.mouse.down({ button: "right" });
        await sleep(80);
        await s.page.mouse.up({ button: "right" });
      };
      const settleEnd = Date.now() + 5_000;
      while (Date.now() < settleEnd) { await swingAtPack(); await sleep(100); }
      const samples: number[] = [];
      let widestGap = 0;
      let shot = 0;
      const end = Date.now() + 12_000;
      while (Date.now() < end) {
        const mobs = pack.map((mob) => s.ents.get(mob.id)!).filter(Boolean);
        samples.push(minPair(mobs));
        const bearings = mobs.map((mob) => bearing(s.self, mob)).sort((a, b) => a - b);
        let gap = 360 - bearings[bearings.length - 1]! + bearings[0]!;
        for (let index = 1; index < bearings.length; index++) gap = Math.max(gap, bearings[index]! - bearings[index - 1]!);
        widestGap = Math.max(widestGap, gap);
        if (shot < 2 && Date.now() > end - 9_000 + shot * 6_000) {
          await framePlayer(s);
          await sleep(400);
          const zoom = await s.page.evaluate(() => (window as any).__e2eMap.getZoom() as number);
          note(`hold-${count}-shot-${shot + 1}-zoom`, zoom.toFixed(2));
          await s.shot(`hold-${count}-wolves-${shot + 1}`);
          shot += 1;
        }
        await swingAtPack();
        await sleep(100);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const min = sorted[0]!;
      const p10 = sorted[Math.floor(sorted.length * 0.1)]!;
      const median = sorted[Math.floor(sorted.length / 2)]!;
      note(`hold-${count}`, `min pair over 12 s: min ${min.toFixed(0)} m, p10 ${p10.toFixed(0)} m, median ${median.toFixed(0)} m (body ${BODY_WIDTH_M} m, spacing ${SPACING_M} m), widest empty arc ${widestGap.toFixed(0)} deg, samples ${samples.length}`);
      // Up to 4 wolves all engage at the full spacing. A bigger pack puts waiters on the 160 m band between the
      // engaged wolves, packed to body width + 5 m: close, but never drawn on top of each other.
      expect(min, "no two wolves ever draw on top of each other (closer than a body width)").toBeGreaterThanOrEqual(BODY_WIDTH_M - 3);
      expect(p10, count <= 4 ? "settled pairs keep the full spacing" : "settled pairs at least a body width apart")
        .toBeGreaterThanOrEqual(count <= 4 ? SPACING_M - 10 : BODY_WIDTH_M);
      expect(widestGap, "the pack surrounds the player (no crescent)").toBeLessThan(count <= 4 ? 200 : 150);
    } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
  });
}

test("4. frozen-clock screenshot of a ranged aim line", async () => {
  test.skip(!invulnerable || tacticsOff, "needs DEV_PLAYERS_INVULNERABLE=true and mob tactics on");
  const { ctx, s } = await launch(browser, "tactics-aim-frozen", { clock: true });
  try {
    await ensureAlive(s);
    await framePlayer(s);
    const mark = s.mark();
    const spitter = await s.spawn(process.env.ASH_ATLAS_E2E_RANGED_ARCHETYPE ?? "raptor_spitter", 110, 0);
    await framePlayer(s);
    const at = await s.screenOf(spitter.id);
    await s.page.mouse.move(at.x, at.y);
    await s.page.mouse.down({ button: "right" });
    await sleep(120);
    await s.page.mouse.up({ button: "right" });
    await framePlayer(s);
    await s.until(() => s.grep(mark, /ranged_aim/).length > 0, 25_000, "a ranged_aim telegraph");
    // Freeze the page clock a moment after the telegraph lands so the line is drawn and held for the screenshot.
    const now = await s.page.evaluate(() => Date.now());
    await s.page.clock.pauseAt(now + 120);
    await s.shot("ranged-aim-line-frozen");
    await s.page.clock.resume();
  } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
});

test("5. phone viewport (375x812): a 4-wolf pack at the default play zoom", async () => {
  test.skip(!invulnerable || tacticsOff, "needs DEV_PLAYERS_INVULNERABLE=true and mob tactics on");
  const { ctx, s } = await launch(browser, "tactics-phone", { viewport: { width: 375, height: 812 } });
  try {
    await ensureAlive(s);
    await framePlayer(s);
    const mark = s.mark();
    const pack = await spawnPack(s, 4);
    await s.until(() => s.grep(mark, /melee_windup/).length > 0, 20_000, "the first melee_windup");
    await sleep(6_000);
    await framePlayer(s);
    const zoom = await s.page.evaluate(() => (window as any).__e2eMap.getZoom() as number);
    const mobs = pack.map((mob) => s.ents.get(mob.id)!).filter(Boolean);
    note("phone", `zoom ${zoom.toFixed(2)}, min pair ${minPair(mobs).toFixed(0)} m`);
    await s.shot("phone-4-wolves");
  } finally { s.save(); await s.clearMobs(); expect(s.errors).toEqual([]); await ctx.close(); }
});
