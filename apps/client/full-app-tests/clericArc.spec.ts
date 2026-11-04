/**
 * Cleric holy arc end-to-end check (docs/plans/class-roster-v2.md 5): two real players in headless Chromium.
 * A Cleric (Default Dev) with a scepter fires one holy arc at a training dummy; an injured friend (Dev Player 2)
 * stands on the line in front of it. The arc heals the friend (HEAL event, green floater on the friend's own screen)
 * and then damages the dummy.
 *
 * Run against a disposable feature runtime started with ACTION_COMBAT_ENABLED=true CLERIC_ARC_ENABLED=true:
 *   cd apps/client
 *   ASH_ATLAS_TEST_BASE_URL=http://127.0.0.1:<port> \
 *   ASH_ATLAS_E2E_PSQL="docker exec -i <runtime postgres container> psql -U ash_atlas -d <runtime database>" \
 *   pnpm exec playwright test --config playwright-full-app.config.ts clericArc
 *
 * ASH_ATLAS_E2E_PSQL is used only to stage the disposable runtime's database between sign-ins: the two players become
 * friends and the Cleric is given a Scepter. Never point it at a kept database. The friend is injured in game by a wolf.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";

import { expect, test, chromium, type Browser } from "@playwright/test";

import { launch, note, outDir, type Session } from "./e2eSession.js";

const psql = process.env.ASH_ATLAS_E2E_PSQL;
let browser: Browser;

test.beforeAll(async () => { browser = await chromium.launch(); });
test.afterAll(async () => { await browser.close(); });

function sql(statement: string): string {
  if (!psql || !/ash_atlas_stability_/u.test(psql)) throw new Error("ASH_ATLAS_E2E_PSQL must target a disposable ash_atlas_stability database");
  return execSync(`${psql} -v ON_ERROR_STOP=1 -At`, { input: statement, encoding: "utf8" }).trim();
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function signIn(name: string, devButton: string, newPlayerName: string, dev: boolean, clock = false) {
  return launch(browser, name, { devButton, newPlayerName, skipTeleport: !dev, clock });
}

async function equipScepter(s: Session): Promise<void> {
  await s.until(() => s.equipment() !== null, 20_000, "an EQUIPMENT_SNAPSHOT");
  const scepter = s.equipment().instances.find((i: any) => i.definitionId === "training_scepter");
  if (!scepter) throw new Error("the Cleric has no scepter");
  if (scepter.equippedSlot !== "melee") {
    const n = s.frames.length;
    await s.sendRaw({ type: "EQUIP_ITEM", instanceId: scepter.instanceId, slot: "melee" });
    await s.until(() => s.equipment()?.instances.find((i: any) => i.instanceId === scepter.instanceId)?.equippedSlot === "melee" && s.frames.length > n, 8000, "the scepter to be equipped");
  }
  await s.ensureWeapon("melee");
  await s.page.waitForTimeout(800);
}

test("Cleric holy arc heals an injured friend in front of a mob, then damages the mob", async () => {
  test.skip(!psql, "needs ASH_ATLAS_E2E_PSQL for the disposable runtime database");
  test.setTimeout(240_000);

  // 1. Both accounts exist (a fresh runtime onboards them), then sign out so the database can be staged.
  let cleric = await signIn("cleric-setup", "Default Dev", "Cleric", true);
  let ally = await signIn("ally-setup", "Dev Player 2", "Squire", false);
  const clericId = cleric.s.self.id;
  const allyId = ally.s.self.id;
  note("players", JSON.stringify({ clericId, allyId }));
  await cleric.ctx.close();
  await ally.ctx.close();
  // Let the server flush both players on disconnect before the rows are staged.
  await new Promise((resolve) => setTimeout(resolve, 12_000));

  // 2. Stage: friends (default heal targets include friends) and a Scepter for the Cleric.
  const [low, high] = [clericId, allyId].sort();
  const operation = `e2e-scepter:${clericId}:${Date.now()}`;
  sql(`
    INSERT INTO friendships (player_low_id, player_high_id) VALUES (${quote(low!)}, ${quote(high!)}) ON CONFLICT DO NOTHING;
    INSERT INTO equipment_operations (operation_key, player_id, action, completed_at) VALUES (${quote(operation)}, ${quote(clericId)}, 'package_grant', now());
    INSERT INTO equipment_instances (instance_id, definition_id, owner_player_id, location, item_level, balance_version, created_by_operation_key, metadata)
      SELECT gen_random_uuid(), 'training_scepter', ${quote(clericId)}, 'inventory', 0,
             (SELECT max(balance_version) FROM equipment_instances), ${quote(operation)}, '{"source":"e2e"}'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM equipment_instances WHERE owner_player_id = ${quote(clericId)} AND definition_id = 'training_scepter');
  `);
  note("staged", sql(`SELECT count(*) FROM equipment_instances WHERE owner_player_id = ${quote(clericId)} AND definition_id = 'training_scepter';`));

  // 3. Back in: the Cleric readies the scepter and teleports 60 m west of the friend (only the developer account can
  //    teleport); a dummy 150 m east of the Cleric.
  cleric = await signIn("cleric", "Default Dev", "Cleric", true, true);
  ally = await signIn("ally", "Dev Player 2", "Squire", false, true);
  try {
    expect(JSON.parse(cleric.s.since(0, "WELCOME")[0]!.raw).clericArc).toBe(true);
    await equipScepter(cleric.s);
    const at = ally.s.self;
    const westLon = at.lon - 60 / (111_320 * Math.cos((at.lat * Math.PI) / 180));
    await cleric.s.teleport(at.lat, westLon);
    // A long-distance teleport does not move the camera: centre it on the Cleric so screen aim maps to the world.
    await cleric.s.page.evaluate(({ lat, lon }) => { (window as any).__e2eMap.jumpTo({ center: [lon, lat] }); }, cleric.s.self);
    await cleric.s.page.waitForTimeout(1500);
    note("positions", JSON.stringify({ cleric: cleric.s.self, ally: ally.s.self }));
    await cleric.s.clearMobs();
    await expect.poll(() => cleric.s.ents.get(allyId) !== undefined, { timeout: 8000 }).toBe(true);
    // The friend picks a fight with a wolf beside them and takes a bite or two; then every mob is cleared.
    const wolf = await cleric.s.spawn("wolf", 70, 0);
    await ally.s.sendRaw({ type: "START_ATTACK", targetEntityId: wolf.id });
    await expect.poll(() => cleric.s.ents.get(allyId)?.hp ?? 100, { timeout: 30_000, intervals: [100] }).toBeLessThan(95);
    await cleric.s.clearMobs();
    const dummy = await cleric.s.spawn("training_dummy", 150, 0);
    await cleric.s.page.waitForTimeout(2500); // relation sync (2 s) sees both players online
    const allyHealthBefore = cleric.s.ents.get(allyId)!.hp;
    note("ally-health-before", String(allyHealthBefore));
    expect(allyHealthBefore).toBeLessThan(100);

    // 4. One holy arc at the dummy, through the friend (zoomed in so the bolt, bursts and numbers read in the frames).
    for (const page of [cleric.s.page, ally.s.page]) {
      await page.evaluate(() => { const m = (window as any).__e2eMap; m.jumpTo({ zoom: m.getZoom() + 1.5 }, { originalEvent: new WheelEvent("wheel") }); });
    }
    await cleric.s.page.evaluate(({ lat, lon }) => { (window as any).__e2eMap.jumpTo({ center: [lon, lat] }); }, cleric.s.self);
    await cleric.s.page.waitForTimeout(1500);
    const target = await cleric.s.screenOf(dummy.id);
    const clericMark = cleric.s.mark();
    const allyMark = ally.s.mark();
    // Frozen clocks (as in actionCombat 7d): the press fires on one stepped frame, the server's events arrive in real
    // time, then both screens are stepped in lockstep so every frame shows the same instants of the effects.
    const pauseAt = new Date(Date.now() + 400);
    await Promise.all([cleric.s.page.clock.pauseAt(pauseAt), ally.s.page.clock.pauseAt(pauseAt)]);
    await cleric.s.page.mouse.move(target.x, target.y - 12);
    await cleric.s.page.mouse.down({ button: "right" });
    await cleric.s.page.clock.runFor(20); // one frame: the held button fires the arc
    await cleric.s.page.mouse.up({ button: "right" });
    await ally.s.page.clock.runFor(20);
    const healOnAlly = new RegExp(`"type":"HEAL"[^}]*"targetEntityId":"${allyId}"`);
    await ally.s.until(() => ally.s.grep(allyMark, healOnAlly).length > 0, 4000, "the HEAL on the friend");
    await cleric.s.until(() => cleric.s.since(clericMark, "SWING_RESULT").length > 0, 4000, "the SWING_RESULT");
    await cleric.s.until(() => cleric.s.grep(clericMark, /"DAMAGE"/).some((f) => f.raw.includes(dummy.id)), 4000, "the DAMAGE on the dummy");
    let elapsed = 20;
    for (const atMs of [40, 80, 120, 160, 200, 240, 280, 320, 380, 440, 520, 640]) {
      await cleric.s.page.clock.runFor(atMs - elapsed);
      await ally.s.page.clock.runFor(atMs - elapsed);
      elapsed = atMs;
      await cleric.s.page.screenshot({ path: join(outDir, `cleric-arc-caster-${atMs}ms.png`) });
      await ally.s.page.screenshot({ path: join(outDir, `cleric-arc-ally-${atMs}ms.png`) });
    }
    await cleric.s.page.clock.resume();
    await ally.s.page.clock.resume();

    await expect.poll(() => cleric.s.since(clericMark, "SWING_RESULT").length, { timeout: 4000 }).toBeGreaterThan(0);
    const result = JSON.parse(cleric.s.since(clericMark, "SWING_RESULT")[0]!.raw);
    note("swing-result", JSON.stringify(result).slice(0, 300));
    expect(result.rejected).toBeUndefined();
    expect(JSON.stringify(result.hits)).toContain(dummy.id);

    const healEvent = new RegExp(`"type":"HEAL"[^}]*"sourceEntityId":"${clericId}"[^}]*"targetEntityId":"${allyId}"`);
    await expect.poll(() => cleric.s.grep(clericMark, healEvent).length, { timeout: 4000 }).toBeGreaterThan(0);
    await expect.poll(() => ally.s.grep(allyMark, healEvent).length, { timeout: 4000 }).toBeGreaterThan(0);
    await expect.poll(() => cleric.s.grep(clericMark, /"DAMAGE"/).filter((f) => f.raw.includes(dummy.id)).length, { timeout: 4000 }).toBeGreaterThan(0);
    await expect.poll(() => cleric.s.ents.get(allyId)?.hp ?? 0, { timeout: 4000 }).toBeGreaterThan(allyHealthBefore ?? 0);
    note("ally-health-after", String(cleric.s.ents.get(allyId)?.hp));
  } finally {
    cleric.s.save(); ally.s.save();
    expect(cleric.s.errors).toEqual([]);
    expect(ally.s.errors).toEqual([]);
    await cleric.ctx.close(); await ally.ctx.close();
  }
});
