import { randomUUID } from "node:crypto";

import {
  STRUCTURE_WARFARE_CASTLE_HEALTH,
  STRUCTURE_WARFARE_CITY_FLAG_HEALTH,
  STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS,
  structureWarfareFullRepairMs,
  structureWarfareProfileForFlag
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";
import { endKingdomWithCollapse } from "./kingdoms.js";
import { settleFallenOrganizationStructures } from "./organizationStructureFall.js";
import { applyOrganizationBomberStrikeInTransaction } from "./personalFlagWarfare.js";
import { PERSONAL_FLAG_WARFARE_KIND, StructureWarfareError } from "./structureWarfare.js";
import { TowerVolleyService } from "./towerVolleys.js";
import { applyWarDeathLosses } from "./warDeathLosses.js";
import { OrganizationWarService } from "./warStructures.js";

const databaseUrl = process.env.WAR_STRUCTURES_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const POSITION = { lat: 35, lon: -106 } as const;

describeDatabase("war structures PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let flags: FlagService;
  let cityId = "";
  let cityFlagId = "";
  let kingdomId = "";
  let castleId = "";

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("WAR_STRUCTURES_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    inventory = new InventoryService(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE organization_wars, organization_war_alerts, territory_collapses, players CASCADE");
    for (const id of ["mayor", "citizen", "raider", "squire", "loner"]) await createPlayer(id);
    flags = new FlagService(pool, {} as never, {} as never, { info: vi.fn(), warn: vi.fn() } as never, inventory);
    cityId = await createCity("mayor");
    await addCityMember(cityId, "mayor", "mayor");
    await addCityMember(cityId, "citizen", "member");
    cityFlagId = await insertOrganizationFlag("city", cityId, "mayor", "East Gate", 35, -106);
    kingdomId = await createKingdom("raider");
    await addKingdomMember(kingdomId, "squire", "member");
    castleId = (await pool.query<{ id: string }>(
      "SELECT id::text FROM flags WHERE kingdom_id=$1 AND control_type='kingdom_seat'", [kingdomId]
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE organization_wars, organization_war_alerts, territory_collapses, players CASCADE");
    await pool?.end();
  });

  it("gives city and kingdom structures reference health, and leaves immune structures without health", async () => {
    expect(await health(cityFlagId)).toEqual({ health: 4_500, maximumHealth: 4_500 });
    expect(await health(castleId)).toEqual({ health: 230_000, maximumHealth: 230_000 });
    const center = (await pool.query<{ id: string }>("SELECT seat_flag_id::text AS id FROM cities WHERE id=$1", [cityId])).rows[0]!.id;
    expect(await health(center)).toEqual({ health: 230_000, maximumHealth: 230_000 });
    expect(structureWarfareProfileForFlag({ controlType: "city", cityId, systemControlled: true })).toBeNull();
  });

  it("lets a hostile player attack a city flag but excludes the city's own members (ally exclusion)", async () => {
    await expect(attack("citizen", cityFlagId, "ally-1")).rejects.toMatchObject({ code: "FLAG_ATTACK_ALLY" });
    await expect(attack("mayor", cityFlagId, "ally-2")).rejects.toMatchObject({ code: "FLAG_ATTACK_ALLY" });
    const result = await attack("raider", cityFlagId, "hostile-1");
    expect(result.damage).toBe(25);
    expect(await health(cityFlagId)).toEqual({ health: 4_475, maximumHealth: 4_500 });
    // Kingdom members cannot hit their own Castle either.
    await expect(attack("squire", castleId, "ally-3")).rejects.toMatchObject({ code: "FLAG_ATTACK_ALLY" });
  });

  it("auto-declares exactly one war on the first hostile action, idempotently, and alerts once", async () => {
    await Promise.all([
      attack("raider", cityFlagId, "war-1"),
      attack("squire", cityFlagId, "war-2")
    ]);
    // Replaying a request is a no-op.
    expect((await attack("raider", cityFlagId, "war-1")).replayed).toBe(true);
    const wars = await pool.query("SELECT side_a_kind,side_b_kind,declared_via,status FROM organization_wars");
    expect(wars.rows).toEqual([{ side_a_kind: "city", side_b_kind: "kingdom", declared_via: "attack", status: "active" }]);
    const declared = await pool.query(
      "SELECT player_id FROM player_inbox_entries WHERE event_kind='organization_war_declared' ORDER BY player_id"
    );
    expect(declared.rows.map((row) => row.player_id)).toEqual(["citizen", "mayor", "raider", "squire"]);
    const underAttack = await pool.query(
      "SELECT count(DISTINCT event_id)::int AS alerts FROM player_inbox_entries WHERE event_kind='organization_under_attack'"
    );
    expect(underAttack.rows[0]).toEqual({ alerts: 1 });
    // Declaring from settings while already at war returns the same war.
    const service = new OrganizationWarService(pool);
    await expect(service.declare("raider", {
      as: { kind: "kingdom", id: kingdomId },
      target: { kind: "city", id: cityId }
    })).resolves.toMatchObject({ declared: false });
    await expect(service.declare("squire", {
      as: { kind: "kingdom", id: kingdomId },
      target: { kind: "city", id: cityId }
    })).rejects.toMatchObject({ code: "WAR_PERMISSION_DENIED" });
    // A player in no city or kingdom can attack but creates no war.
    await pool.query("TRUNCATE organization_wars CASCADE");
    await attack("loner", cityFlagId, "loner-1");
    expect((await pool.query("SELECT count(*)::int AS n FROM organization_wars")).rows[0]).toEqual({ n: 0 });
  });

  it("stops bombs at the burn threshold and ignites instead of deleting (must-burn)", async () => {
    const strike = () => withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, cityFlagId, "raider"));
    await expect(strike()).resolves.toMatchObject({ kind: "struck", health: 3_350 });
    await expect(strike()).resolves.toMatchObject({ kind: "struck", health: 2_250 });
    expect(await health(cityFlagId)).toEqual({ health: 2_250, maximumHealth: 4_500 });
    const burn = await pool.query(
      "SELECT burn_duration_ms::bigint AS duration, burn_damage_budget, victim_player_id FROM flag_burn_operations WHERE flag_id=$1 AND status='active'",
      [cityFlagId]
    );
    expect(burn.rows).toEqual([{
      duration: String(STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS),
      burn_damage_budget: 2_250,
      victim_player_id: "mayor"
    }]);
    // A burning structure cannot be bombed; a kingdom flag (220 HP) survives a bomb too.
    await expect(strike()).resolves.toMatchObject({ kind: "invalid" });
    const kingdomFlag = await insertOrganizationFlag("kingdom", kingdomId, "raider", "Watch", 36, -105.99);
    await expect(withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, kingdomFlag, "mayor")))
      .resolves.toMatchObject({ kind: "struck", health: 110 });
    // Hand attacks also floor at the threshold: 2,260 -> 2,250, then refused.
    const gate = await insertOrganizationFlag("city", cityId, "mayor", "North Gate", 35.0003, -106);
    await pool.query("UPDATE flags SET health=2260 WHERE id=$1", [gate]);
    expect((await attack("raider", gate, "floor-1")).damage).toBe(10);
    await pool.query("DELETE FROM flag_attack_cooldowns");
    await expect(attack("raider", gate, "floor-2")).rejects.toMatchObject({ code: "FLAG_ATTACK_THRESHOLD_REACHED" });
  });

  it("repairs for free at 5x the burn rate with the burn paused, takes 3x damage while repairing, and resumes from health", async () => {
    // Burning city flag at its 2,250 threshold.
    await withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, cityFlagId, "raider"));
    await withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, cityFlagId, "raider"));
    await withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, cityFlagId, "raider"));
    await pool.query("UPDATE city_treasuries SET balance=1000,lifetime_earned=1000 WHERE city_id=$1", [cityId]);
    await expect(repair("raider", cityFlagId, "foe-repair")).rejects.toMatchObject({ code: "FLAG_REPAIR_FORBIDDEN" });
    const started = await repair("citizen", cityFlagId, "member-repair");
    const burn = await pool.query("SELECT paused_at FROM flag_burn_operations WHERE flag_id=$1 AND status='active'", [cityFlagId]);
    expect(burn.rows[0]!.paused_at).not.toBeNull();

    // One simulated hour: 5x the burn rate (2,250 HP per 27 h) = 416 HP.
    const fullMs = structureWarfareFullRepairMs(structureWarfareProfileForFlag({ controlType: "city", cityId })!);
    expect(fullMs).toBe(10.8 * 3_600_000);
    await pool.query(
      "UPDATE flag_repair_operations SET started_at=started_at-interval '1 hour' WHERE operation_id=$1",
      [started.operation.operationId]
    );
    const progress = await advance("citizen", cityFlagId, started.operation.operationId);
    expect(progress).toMatchObject({ status: "active", healthRestored: 416 });
    expect(await health(cityFlagId)).toEqual({ health: 2_666, maximumHealth: 4_500 });
    // Repair is free: the repairer holds no materials and the treasury is untouched.
    await advance("citizen", cityFlagId, started.operation.operationId);
    expect((await pool.query("SELECT balance::int AS balance FROM city_treasuries WHERE city_id=$1", [cityId])).rows[0])
      .toEqual({ balance: 1000 });

    // Siege-equivalent damage while repairing: a hand attack on a repairing,
    // non-burning personal Stone Flag deals 3x.
    const stone = await insertPersonalStone("loner", 190);
    const personalRepair = await repair("loner", stone, "personal-repair");
    expect((await attack("raider", stone, "double")).damage).toBe(75);
    await flags.structureWarfare.cancelRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND, operationId: personalRepair.operation.operationId,
      playerId: "loner", structureId: stone, reason: "explicit"
    });

    // Stopping the city repair below the threshold? Health is 2,666 > 2,250,
    // so the burn is extinguished, not resumed.
    await flags.structureWarfare.cancelRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND, operationId: started.operation.operationId,
      playerId: "citizen", structureId: cityFlagId, reason: "explicit"
    });
    const after = await pool.query(
      "SELECT status, cancel_reason FROM flag_burn_operations WHERE flag_id=$1 ORDER BY started_at DESC LIMIT 1", [cityFlagId]
    );
    expect(after.rows[0]).toEqual({ status: "cancelled", cancel_reason: "repaired" });
    expect((await pool.query("SELECT burning_reason FROM flags WHERE id=$1", [cityFlagId])).rows[0]).toEqual({ burning_reason: null });
  });

  it("resumes a paused burn with the time its current health buys", async () => {
    await withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, cityFlagId, "raider"));
    await withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, cityFlagId, "raider"));
    await withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, cityFlagId, "raider"));
    const started = await repair("citizen", cityFlagId, "resume-repair");
    // Damage during the repair (3x) leaves 1,125 HP: the resumed burn owns
    // 1,125 / 2,250 of its 27 h.
    await pool.query("UPDATE flags SET health=1125 WHERE id=$1", [cityFlagId]);
    await flags.structureWarfare.cancelRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND, operationId: started.operation.operationId,
      playerId: "citizen", structureId: cityFlagId, reason: "explicit"
    });
    const burn = await pool.query<{ remaining: string; paused: boolean }>(
      `SELECT remaining_duration_ms::text AS remaining, paused_at IS NOT NULL AS paused
       FROM flag_burn_operations WHERE flag_id=$1 AND status='active'`,
      [cityFlagId]
    );
    expect(burn.rows[0]).toEqual({ remaining: String(STRUCTURE_WARFARE_ORGANIZATION_FLAG_BURN_DURATION_MS / 2), paused: false });
  });

  it("lets a bomb destroy a repairing structure below the threshold while an unattended one stays floored", async () => {
    // Unattended: two bombs floor the City Flag at 2,000 and ignite it.
    const unattended = await insertOrganizationFlag("city", cityId, "mayor", "North Gate", 35.0003, -106);
    const strike = (flagId: string) =>
      withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, flagId, "raider"));
    await strike(unattended);
    await pool.query("UPDATE flags SET health=1500,burning_started_at=NULL,burning_until=NULL,burning_reason=NULL WHERE id=$1", [unattended]);
    await pool.query("UPDATE flag_burn_operations SET status='cancelled',cancel_reason='test',completed_at=now(),paused_at=NULL WHERE flag_id=$1 AND status='active'", [unattended]);
    // 1,500 is already below the threshold: the floor keeps it at 1,500 and it ignites.
    await expect(strike(unattended)).resolves.toMatchObject({ kind: "struck", health: 1_500, destroyed: false });
    expect((await pool.query(
      "SELECT count(*)::int AS burns FROM flag_burn_operations WHERE flag_id=$1 AND status='active'", [unattended]
    )).rows[0]).toEqual({ burns: 1 });

    // Repairing: the same 1,500 HP City Flag, burning with the burn paused by
    // a member's repair, takes 2 x 1,150 and is destroyed, not ignited.
    const repairing = await insertOrganizationFlag("city", cityId, "mayor", "South Gate", 34.9997, -106);
    await strike(repairing);
    await strike(repairing);
    await strike(repairing);
    await pool.query("UPDATE flags SET health=1500 WHERE id=$1", [repairing]);
    const started = await repair("citizen", repairing, "doomed-repair");
    expect((await pool.query(
      "SELECT paused_at IS NOT NULL AS paused FROM flag_burn_operations WHERE flag_id=$1 AND status='active'", [repairing]
    )).rows[0]).toEqual({ paused: true });
    await expect(strike(repairing)).resolves.toMatchObject({ kind: "struck", health: 0, destroyed: true });
    expect(await health(repairing)).toEqual({ health: 0, maximumHealth: 4_500 });
    expect((await pool.query(
      "SELECT status, cancel_reason FROM flag_repair_operations WHERE operation_id=$1", [started.operation.operationId]
    )).rows[0]).toEqual({ status: "cancelled", cancel_reason: "flag-destroyed" });
    expect((await pool.query(
      "SELECT count(*)::int AS burns FROM flag_burn_operations WHERE flag_id=$1 AND status='active'", [repairing]
    )).rows[0]).toEqual({ burns: 0 });
    // The fall sweep breaks the destroyed flag; the city lives on.
    const settled = await settleFallenOrganizationStructures(pool, { begin: vi.fn() });
    expect(settled.brokenFlagIds).toContain(repairing);
    expect((await pool.query("SELECT active FROM cities WHERE id=$1", [cityId])).rows[0]).toEqual({ active: true });
  });

  it("turns the Castle to rubble when it burns out, keeping the kingdom and its territory", async () => {
    await pool.query("UPDATE flags SET health=100000 WHERE id=$1", [castleId]);
    await grant("mayor", "torch", 1);
    const ignition = await flags.structureWarfare.reserveIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND, playerId: "mayor", structureId: castleId,
      requestId: "castle-burn", player: { position: { lat: 36, lon: -106 }, target: null, online: true }
    });
    expect(ignition.operation.durationMs).toBe(90 * 3_600_000);
    await pool.query(
      "UPDATE flag_burn_operations SET started_at=clock_timestamp()-interval '2 seconds',completes_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
      [ignition.operation.operationId]
    );
    const completion = await flags.structureWarfare.completeIgnition({
      kind: PERSONAL_FLAG_WARFARE_KIND, operationId: ignition.operation.operationId,
      playerId: "mayor", structureId: castleId, now: Date.now()
    });
    expect(completion).not.toBeNull();
    expect(await health(castleId)).toEqual({ health: 0, maximumHealth: STRUCTURE_WARFARE_CASTLE_HEALTH });
    const collapser = {
      begin: vi.fn((input: { kind: "city" | "kingdom"; id: string; reason: string }) =>
        endKingdomWithCollapse(pool, input.id, null, input.reason))
    };
    const settled = await settleFallenOrganizationStructures(pool, collapser);
    expect(collapser.begin).not.toHaveBeenCalled();
    expect(settled.collapses).toHaveLength(0);
    expect(settled.ruinedCastles.map((ruin) => ruin.kingdomId)).toEqual([kingdomId]);
    expect((await pool.query(
      "SELECT status, castle_ruined_at IS NOT NULL AS ruined FROM kingdoms WHERE id=$1", [kingdomId]
    )).rows[0]).toEqual({ status: "active", ruined: true });
    expect((await pool.query("SELECT 1 FROM flags WHERE id=$1", [castleId])).rowCount).toBe(1);
    // Idempotent: the rubble is not picked up again.
    await expect(settleFallenOrganizationStructures(pool, collapser))
      .resolves.toEqual({ brokenFlagIds: [], collapses: [], ruinedCastles: [], failures: [] });
  });

  it("keeps sweeping past a fallen structure that cannot settle this tick", async () => {
    await pool.query("UPDATE flags SET health=0 WHERE id = ANY($1::uuid[])", [[castleId, cityFlagId]]);
    // A stray seat of a kingdom that already ended goes to the collapser, which fails this tick.
    await pool.query("UPDATE kingdoms SET status='dissolved', dissolved_at=now() WHERE id=$1", [kingdomId]);
    const stuck = new Error("CITY_FLAG_LIFECYCLE_CHANGED");
    const settled = await settleFallenOrganizationStructures(pool, { begin: vi.fn(async () => { throw stuck; }) });
    expect(settled.failures).toEqual([{ flagId: castleId, error: stuck }]);
    expect(settled.brokenFlagIds).toContain(cityFlagId);
    expect((await pool.query("SELECT 1 FROM flags WHERE id=$1", [cityFlagId])).rowCount).toBe(0);
  });

  it("breaks an ordinary city flag that burned out without ending the city", async () => {
    await pool.query("UPDATE flags SET health=0 WHERE id=$1", [cityFlagId]);
    const collapser = { begin: vi.fn() };
    const settled = await settleFallenOrganizationStructures(pool, collapser);
    expect(collapser.begin).not.toHaveBeenCalled();
    expect(settled.brokenFlagIds).toContain(cityFlagId);
    expect((await pool.query("SELECT 1 FROM flags WHERE id=$1", [cityFlagId])).rowCount).toBe(0);
    expect((await pool.query("SELECT active FROM cities WHERE id=$1", [cityId])).rows[0]).toEqual({ active: true });
  });

  it("builds Guard Tower levels once each, replays a repeated request, and refuses a skipped level", async () => {
    const towerId = await insertPersonalStone("loner", 200);
    await pool.query("UPDATE flags SET reinforcement_level=3, health=2000 WHERE id=$1", [towerId]);
    expect(await health(towerId)).toEqual({ health: 2_000, maximumHealth: 2_700 });
    await grant("loner", "iron", 60);
    await grant("loner", "stone", 60);
    const first = await flags.upgradeGuardTowerLevel("loner", towerId, 2, "level-2");
    expect(first.replayed).toBe(false);
    expect(first.flag.towerLevel).toBe(2);
    // Damage carries over: 700 missing HP stays missing.
    expect(await health(towerId)).toEqual({ health: 2_440, maximumHealth: 3_140 });
    const replay = await flags.upgradeGuardTowerLevel("loner", towerId, 2, "level-2");
    expect(replay.replayed).toBe(true);
    await expect(flags.upgradeGuardTowerLevel("loner", towerId, 2, "level-2-again"))
      .rejects.toMatchObject({ code: "FLAG_TOWER_LEVEL_CHANGED" });
    await expect(flags.upgradeGuardTowerLevel("loner", towerId, 4, "level-4"))
      .rejects.toMatchObject({ code: "FLAG_TOWER_LEVEL_CHANGED" });
    await expect(flags.upgradeGuardTowerLevel("raider", towerId, 3, "not-mine"))
      .rejects.toMatchObject({ code: "FLAG_UPGRADE_FORBIDDEN" });
    expect(await itemQuantity("loner", "iron")).toBe(36);
    expect(await itemQuantity("loner", "stone")).toBe(30);
    // Level 3 needs 36 Iron Ore and 30 stone: exactly what is left.
    await flags.upgradeGuardTowerLevel("loner", towerId, 3, "level-3");
    expect(await health(towerId)).toEqual({ health: 2_880, maximumHealth: 3_580 });
    await expect(flags.upgradeGuardTowerLevel("loner", towerId, 4, "level-4b"))
      .rejects.toMatchObject({ code: "FLAG_TOWER_LEVEL_MATERIALS_REQUIRED" });
  });

  it("lets only the Mayor turn a City Flag into a City Tower, paid once from the treasury", async () => {
    await pool.query("UPDATE cities SET mayor_confirmed_at=now() WHERE id=$1", [cityId]);
    await pool.query("UPDATE city_treasuries SET balance=15000, lifetime_earned=15000 WHERE city_id=$1", [cityId]);
    await grant("mayor", "stone", 600);
    await grant("citizen", "stone", 600);
    await expect(flags.upgradeCityTower("citizen", cityFlagId, "citizen-tower"))
      .rejects.toMatchObject({ code: "CITY_PERMISSION_DENIED" });
    // No City Market, no City Tower slot.
    await expect(flags.assertCityTowerUpgradeAllowed("mayor", cityFlagId))
      .rejects.toMatchObject({ code: "FLAG_CITY_TOWER_SLOTS_FULL" });
    await expect(flags.upgradeCityTower("mayor", cityFlagId, "city-tower-no-market"))
      .rejects.toMatchObject({ code: "FLAG_CITY_TOWER_SLOTS_FULL" });
    const marketId = await insertMarket(1);
    await flags.assertCityTowerUpgradeAllowed("mayor", cityFlagId);
    const result = await flags.upgradeCityTower("mayor", cityFlagId, "city-tower");
    expect(result.flag.towerLevel).toBe(1);
    expect(await health(cityFlagId)).toEqual({ health: 36_500, maximumHealth: 36_500 });
    expect((await flags.upgradeCityTower("mayor", cityFlagId, "city-tower")).replayed).toBe(true);
    await expect(flags.upgradeCityTower("mayor", cityFlagId, "city-tower-2"))
      .rejects.toMatchObject({ code: "FLAG_ALREADY_UPGRADED" });
    const balance = (await pool.query<{ balance: string }>(
      "SELECT balance::text FROM city_treasuries WHERE city_id=$1", [cityId]
    )).rows[0]!.balance;
    expect(balance).toBe("3000");
    expect(await itemQuantity("mayor", "stone")).toBe(0);

    // Market level 1 gives one slot, now used: a second City Flag is refused, nothing charged.
    await pool.query("UPDATE city_treasuries SET balance=15000 WHERE city_id=$1", [cityId]);
    await grant("mayor", "stone", 600);
    const westGate = await insertOrganizationFlag("city", cityId, "mayor", "West Gate", 35, -106.002);
    await expect(flags.assertCityTowerUpgradeAllowed("mayor", westGate))
      .rejects.toMatchObject({ code: "FLAG_CITY_TOWER_SLOTS_FULL" });
    await expect(flags.upgradeCityTower("mayor", westGate, "west-tower"))
      .rejects.toMatchObject({ code: "FLAG_CITY_TOWER_SLOTS_FULL" });
    expect(await itemQuantity("mayor", "stone")).toBe(600);
    // A Market mid-upgrade to level 2 still counts level 1; once active, the second slot opens.
    await pool.query(
      `UPDATE city_structures SET tier=2, state='constructing', construction_started_at=now(),
         construction_completes_at=now() + interval '30 seconds' WHERE structure_id=$1`,
      [marketId]
    );
    await expect(flags.upgradeCityTower("mayor", westGate, "west-tower-2"))
      .rejects.toMatchObject({ code: "FLAG_CITY_TOWER_SLOTS_FULL" });
    await pool.query(
      `UPDATE city_structures SET state='active', construction_started_at=NULL, construction_completes_at=NULL
       WHERE structure_id=$1`,
      [marketId]
    );
    expect((await flags.upgradeCityTower("mayor", westGate, "west-tower-3")).flag.towerLevel).toBe(1);
    // Back at one slot (two towers stand): both stay, only new ones wait.
    await pool.query("UPDATE city_structures SET tier=1 WHERE structure_id=$1", [marketId]);
    const towers = await pool.query("SELECT count(*)::int AS n FROM flags WHERE city_id=$1 AND tower_level IS NOT NULL", [cityId]);
    expect(towers.rows[0]).toEqual({ n: 2 });
  });

  it("fires a personal Guard Tower at the nearest enemy-marked player in range, never at allies or out of range", async () => {
    const towerId = await insertPersonalStone("loner", 200);
    await pool.query("UPDATE flags SET reinforcement_level=3 WHERE id=$1", [towerId]);
    await markEnemies("loner", "raider");
    await markEnemies("loner", "citizen");
    await addCityMember(cityId, "loner", "member");
    const hits: Array<{ flagId: string; targetPlayerId: string; damageMultiplier: number; origin: { lat: number; lon: number } }> = [];
    const volleys = new TowerVolleyService(pool, { hitPlayer: (input) => { hits.push(input); return 19; } });
    // Tower at 34.99,-106. citizen is marked but shares the owner's city (ally);
    // squire is near but not an enemy; raider is the enemy in range.
    await volleys.tick([
      { playerId: "citizen", lat: 34.9905, lon: -106 },
      { playerId: "squire", lat: 34.9902, lon: -106 },
      { playerId: "raider", lat: 34.993, lon: -106 },
      { playerId: "loner", lat: 34.99, lon: -106 }
    ]);
    expect(hits).toMatchObject([{ flagId: towerId, targetPlayerId: "raider", damageMultiplier: 1 }]);
    hits.length = 0;
    // 600 m away: out of range.
    await volleys.tick([{ playerId: "raider", lat: 34.9954, lon: -106 }]);
    expect(hits).toEqual([]);
    // A burning tower still shoots; a destroyed one does not.
    await pool.query(
      `UPDATE flags SET health=1000, burning_reason='flag_burn', burning_started_at=now(),
                        burning_until=now()+interval '1 hour'
       WHERE id=$1`,
      [towerId]
    );
    await volleys.tick([{ playerId: "raider", lat: 34.993, lon: -106 }]);
    expect(hits).toHaveLength(1);
    await pool.query(
      "UPDATE flags SET health=0, burning_reason=NULL, burning_started_at=NULL, burning_until=NULL WHERE id=$1",
      [towerId]
    );
    await volleys.tick([{ playerId: "raider", lat: 34.993, lon: -106 }]);
    expect(hits).toHaveLength(1);
  });

  it("fires a City Tower at members of a kingdom at war with the city and at players who damaged it", async () => {
    await pool.query("UPDATE flags SET tower_level=1 WHERE id=$1", [cityFlagId]);
    const hits: Array<{ flagId: string; targetPlayerId: string; damageMultiplier: number; origin: { lat: number; lon: number } }> = [];
    const volleys = new TowerVolleyService(pool, { hitPlayer: (input) => { hits.push(input); return 19; } });
    const near = [
      { playerId: "citizen", lat: 35.0003, lon: -106 },
      { playerId: "squire", lat: 35.002, lon: -106 },
      { playerId: "loner", lat: 35.001, lon: -106 }
    ];
    await volleys.tick(near);
    expect(hits).toEqual([]);
    await pool.query(
      `INSERT INTO organization_wars (side_a_kind,side_a_id,side_b_kind,side_b_id,aggressor_kind,aggressor_id,declared_via)
       VALUES ('city',$1,'kingdom',$2,'kingdom',$2,'settings')`,
      [cityId, kingdomId]
    );
    await volleys.tick(near);
    expect(hits).toMatchObject([{ flagId: cityFlagId, targetPlayerId: "squire", damageMultiplier: 1 }]);
    hits.length = 0;
    // A lone attacker in the current damage cycle becomes a target too, and is nearer.
    await pool.query("UPDATE flags SET damage_cycle_id=gen_random_uuid() WHERE id=$1", [cityFlagId]);
    await pool.query(
      `INSERT INTO flag_attack_operations (flag_id,player_id,request_id,damage,damage_cycle_id)
       SELECT id,'loner','tower-test',25,damage_cycle_id FROM flags WHERE id=$1`,
      [cityFlagId]
    );
    await volleys.tick(near);
    expect(hits).toMatchObject([{ flagId: cityFlagId, targetPlayerId: "loner", damageMultiplier: 1 }]);
  });

  it("settles a kingdom surrender once: 14% of Bricks to the winner, 12% destroyed, then a 7-day peace", async () => {
    await createPlayer("baron");
    const rivalId = await createKingdom("baron", 36.1);
    const rivalFlag = await insertOrganizationFlag("kingdom", rivalId, "baron", "Rival Watch", 36.102, -106);
    await setBricks(kingdomId, 10_000);
    await setBricks(rivalId, 500);
    const service = new OrganizationWarService(pool);
    const { warId } = await service.declare("raider", {
      as: { kind: "kingdom", id: kingdomId },
      target: { kind: "kingdom", id: rivalId }
    });
    const as = { kind: "kingdom" as const, id: kingdomId };
    // Denied: a plain member cannot surrender for the kingdom.
    await expect(service.surrender("squire", { warId, as })).rejects.toMatchObject({ code: "WAR_PERMISSION_DENIED" });
    // Allowed, twice at once: exactly one settlement, the other is a replay.
    const results = await Promise.all([service.surrender("raider", { warId, as }), service.surrender("raider", { warId, as })]);
    expect(results.map((result) => result.settled).sort()).toEqual([false, true]);
    expect(results[0]).toMatchObject({ currency: "bricks", balanceBefore: 10_000, transferred: 1_400, destroyed: 1_200 });
    expect(results[1]).toMatchObject({ currency: "bricks", balanceBefore: 10_000, transferred: 1_400, destroyed: 1_200 });
    expect(await bricks(kingdomId)).toBe(7_400);
    expect(await bricks(rivalId)).toBe(1_900);
    const ledger = await pool.query(
      `SELECT kingdom_id::text = $1 AS loser, direction, quantity::int, source_type
       FROM kingdom_treasury_ledger WHERE source_id = $2 ORDER BY source_type, direction`,
      [kingdomId, warId]
    );
    expect(ledger.rows).toEqual([
      { loser: true, direction: "debit", quantity: 1_200, source_type: "war_surrender_destroyed" },
      { loser: false, direction: "credit", quantity: 1_400, source_type: "war_surrender_transfer" },
      { loser: true, direction: "debit", quantity: 1_400, source_type: "war_surrender_transfer" }
    ]);
    // The war is over; the winner cannot surrender it afterwards either.
    await expect(service.surrender("baron", { warId, as: { kind: "kingdom", id: rivalId } }))
      .rejects.toMatchObject({ code: "WAR_NOT_ACTIVE" });

    // Forced peace: no hand attack, no auto-declare, no settings declaration, both ways.
    await expect(attack("raider", rivalFlag, "peace-1")).rejects.toMatchObject({ code: "FLAG_ATTACK_FORCED_PEACE" });
    await expect(attack("baron", castleId, "peace-2")).rejects.toMatchObject({ code: "FLAG_ATTACK_FORCED_PEACE" });
    await expect(withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, rivalFlag, "squire")))
      .resolves.toMatchObject({ kind: "invalid" });
    await expect(service.declare("baron", {
      as: { kind: "kingdom", id: rivalId },
      target: { kind: "kingdom", id: kingdomId }
    })).rejects.toMatchObject({ code: "WAR_FORCED_PEACE" });
    expect(await health(rivalFlag)).toEqual({ health: 220, maximumHealth: 220 });
    expect((await pool.query("SELECT count(*)::int AS n FROM organization_wars WHERE status='active'")).rows[0]).toEqual({ n: 0 });
    const state = await service.state("raider");
    expect(state.peaces).toMatchObject([{ warId, endedReason: "surrender", surrendered: "own" }]);

    // Once the peace runs out an attack declares a new war again.
    await pool.query("UPDATE organization_wars SET peace_until = now() - interval '1 second' WHERE war_id = $1", [warId]);
    expect((await attack("raider", rivalFlag, "after-peace")).damage).toBeGreaterThan(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM organization_wars WHERE status='active'")).rows[0]).toEqual({ n: 1 });
  });

  it("destroys the whole 26% when a city surrenders to a kingdom, and makes mutual peace without penalty", async () => {
    await pool.query("UPDATE city_treasuries SET balance=1000, lifetime_earned=1000 WHERE city_id=$1", [cityId]);
    await setBricks(kingdomId, 4_000);
    const service = new OrganizationWarService(pool);
    const { warId } = await service.declare("raider", {
      as: { kind: "kingdom", id: kingdomId },
      target: { kind: "city", id: cityId }
    });
    const result = await service.surrender("mayor", { warId, as: { kind: "city", id: cityId } });
    expect(result).toMatchObject({ settled: true, currency: "city_coins", balanceBefore: 1_000, transferred: 0, destroyed: 260 });
    const treasury = await pool.query("SELECT balance::int, lifetime_spent::int FROM city_treasuries WHERE city_id=$1", [cityId]);
    expect(treasury.rows[0]).toEqual({ balance: 740, lifetime_spent: 260 });
    expect(await bricks(kingdomId)).toBe(4_000);
    const sinks = await pool.query(
      "SELECT event_kind, quantity::int FROM economy_events WHERE source_system='city_coin_ledger' AND reason='war_surrender_destroyed' AND organization_id=$1",
      [cityId]
    );
    expect(sinks.rows).toEqual([{ event_kind: "SINK", quantity: 260 }]);

    // A later war between the pair ends by mutual peace: offer, then accept, nothing moves.
    await pool.query("UPDATE organization_wars SET peace_until = now() - interval '1 second' WHERE war_id = $1", [warId]);
    const second = await service.declare("raider", {
      as: { kind: "kingdom", id: kingdomId },
      target: { kind: "city", id: cityId }
    });
    await expect(service.acceptPeace("raider", { warId: second.warId, as: { kind: "kingdom", id: kingdomId } }))
      .rejects.toMatchObject({ code: "WAR_PEACE_NOT_OFFERED" });
    await expect(service.offerPeace("raider", { warId: second.warId, as: { kind: "kingdom", id: kingdomId } }))
      .resolves.toMatchObject({ ended: false });
    expect((await service.state("mayor")).wars).toMatchObject([{ peaceOffer: "enemy", canAct: true }]);
    await expect(service.acceptPeace("mayor", { warId: second.warId, as: { kind: "city", id: cityId } }))
      .resolves.toMatchObject({ ended: true });
    const ended = await pool.query("SELECT status, ended_reason FROM organization_wars WHERE war_id=$1", [second.warId]);
    expect(ended.rows[0]).toEqual({ status: "ended", ended_reason: "mutual_peace" });
    expect((await pool.query("SELECT balance::int FROM city_treasuries WHERE city_id=$1", [cityId])).rows[0]).toEqual({ balance: 740 });
    expect(await bricks(kingdomId)).toBe(4_000);
    await expect(attack("raider", cityFlagId, "mutual-peace")).rejects.toMatchObject({ code: "FLAG_ATTACK_FORCED_PEACE" });
  });

  it("charges war-death losses once per death: 9% carried, 115 treasury Bricks, 1,150 for the leader", async () => {
    await createPlayer("baron");
    const rivalId = await createKingdom("baron", 36.1);
    await setBricks(kingdomId, 1_265);
    await grant("squire", "bricks", 57);
    await grant("raider", "bricks", 10);
    const kill = (victim: string, killer: string, death: string) =>
      applyWarDeathLosses(pool, inventory, { deathOperationKey: `player-death:${death}`, victimPlayerId: victim, killerPlayerId: killer });
    // No war yet: nothing happens.
    expect(await kill("squire", "baron", "d0")).toBeNull();
    const service = new OrganizationWarService(pool);
    await service.declare("baron", { as: { kind: "kingdom", id: rivalId }, target: { kind: "kingdom", id: kingdomId } });
    // A member: 9% of 57 carried (5) destroyed, the treasury loses 115. The replay changes nothing.
    const [first, replay] = await Promise.all([kill("squire", "baron", "d1"), kill("squire", "baron", "d1")]);
    expect([first!.applied, replay!.applied].sort()).toEqual([false, true]);
    expect(first).toMatchObject({ carriedBefore: 57, carriedLost: 5, treasuryLost: 115 });
    expect(await itemQuantity("squire", "bricks")).toBe(52);
    expect(await bricks(kingdomId)).toBe(1_150);
    // The leader: 1,150 from the treasury, then floored at what is left.
    expect(await kill("raider", "baron", "d2")).toMatchObject({ applied: true, carriedLost: 0, treasuryLost: 1_150 });
    expect(await kill("raider", "baron", "d3")).toMatchObject({ applied: true, carriedLost: 0, treasuryLost: 0 });
    expect(await bricks(kingdomId)).toBe(0);
    const ledger = await pool.query(
      "SELECT count(*)::int AS n, sum(quantity)::int AS total FROM kingdom_treasury_ledger WHERE source_type='war_death_loss'"
    );
    expect(ledger.rows[0]).toEqual({ n: 2, total: 1_265 });
    // Killed by an ally or a player outside any war: no loss.
    expect(await kill("squire", "raider", "d4")).toBeNull();
    expect(await kill("squire", "loner", "d5")).toBeNull();
  });

  it("softens hits on a kingdom's structures with Braced Foundations and Warded Monuments", async () => {
    const towerId = await insertOrganizationFlag("kingdom", kingdomId, "raider", "Keep", 36.001, -106);
    await pool.query("UPDATE flags SET tower_level=1, health=10000, maximum_health=10000 WHERE id=$1", [towerId]);
    expect((await attack("mayor", towerId, "plain-hit")).damage).toBe(25);
    await choosePerk(kingdomId, 3, "braced_foundations");
    // Braced Foundations: a Kingdom Tower takes 8 less per hit.
    expect((await attack("citizen", towerId, "braced-hit")).damage).toBe(17);
    // Warded Monuments: 4 less per level of the strongest own obelisk within 550 m.
    const spire = await insertOrganizationFlag("kingdom", kingdomId, "raider", "Spire", 36.002, -106);
    await pool.query("UPDATE flags SET obelisk_level=2 WHERE id=$1", [spire]);
    const bomb = () => withTransaction((client) => applyOrganizationBomberStrikeInTransaction(client, castleId, "mayor"));
    await expect(bomb()).resolves.toMatchObject({ kind: "struck", health: STRUCTURE_WARFARE_CASTLE_HEALTH - 1_150 });
    await choosePerk(kingdomId, 4, "warded_monuments");
    await expect(bomb()).resolves.toMatchObject({ kind: "struck", health: STRUCTURE_WARFARE_CASTLE_HEALTH - 2_292 });
  });

  it("extends Kingdom Tower range to 550 m with +3 attack (Beacon Wardens) and arms obelisks (Sworn Ramparts)", async () => {
    const towerId = await insertOrganizationFlag("kingdom", kingdomId, "raider", "Keep", 35, -106.02);
    await pool.query("UPDATE flags SET tower_level=1 WHERE id=$1", [towerId]);
    await pool.query(
      `INSERT INTO organization_wars (side_a_kind,side_a_id,side_b_kind,side_b_id,aggressor_kind,aggressor_id,declared_via)
       VALUES ('city',$1,'kingdom',$2,'kingdom',$2,'settings')`,
      [cityId, kingdomId]
    );
    const hits: Array<{ flagId: string; targetPlayerId: string; attackBonus: number }> = [];
    const volleys = new TowerVolleyService(pool, { hitPlayer: (input) => { hits.push(input); return 19; } });
    // ~550 m east of the tower: outside the 450 m base range.
    const citizen = [{ playerId: "citizen", lat: 35, lon: -106.014 }];
    await volleys.tick(citizen);
    expect(hits).toEqual([]);
    await choosePerk(kingdomId, 3, "beacon_wardens");
    await volleys.tick(citizen);
    expect(hits).toMatchObject([{ flagId: towerId, targetPlayerId: "citizen", attackBonus: 3 }]);
    hits.length = 0;
    // An obelisk shoots only with Sworn Ramparts.
    await pool.query("UPDATE flags SET tower_level=NULL WHERE id=$1", [towerId]);
    const spire = await insertOrganizationFlag("kingdom", kingdomId, "raider", "Spire", 35, -106.003);
    await pool.query("UPDATE flags SET obelisk_level=1 WHERE id=$1", [spire]);
    const nearSpire = [{ playerId: "citizen", lat: 35, lon: -106 }];
    await volleys.tick(nearSpire);
    expect(hits).toEqual([]);
    await choosePerk(kingdomId, 4, "sworn_ramparts");
    await volleys.tick(nearSpire);
    expect(hits).toMatchObject([{ flagId: spire, targetPlayerId: "citizen", damageMultiplier: 1 }]);
  });

  async function choosePerk(kingdom: string, level: number, perkId: string): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id) VALUES ($1,$2,$3)
       ON CONFLICT (kingdom_id, perk_level) DO UPDATE SET perk_id=EXCLUDED.perk_id`,
      [kingdom, level, perkId]
    );
  }

  async function setBricks(kingdom: string, quantity: number): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_treasury_balances (kingdom_id, resource_type, variant, quantity)
       VALUES ($1,'bricks','default',$2)
       ON CONFLICT (kingdom_id, resource_type, variant) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [kingdom, quantity]
    );
  }

  async function bricks(kingdom: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM kingdom_treasury_balances WHERE kingdom_id=$1 AND resource_type='bricks'",
      [kingdom]
    );
    return Number(result.rows[0]?.quantity ?? 0);
  }

  async function markEnemies(left: string, right: string): Promise<void> {
    await pool.query(
      `INSERT INTO player_enemy_marks (owner_id,target_id)
       VALUES (LEAST($1::text,$2::text),GREATEST($1::text,$2::text)) ON CONFLICT DO NOTHING`,
      [left, right]
    );
  }

  async function itemQuantity(playerId: string, itemId: string): Promise<number> {
    const snapshot = await inventory.getInventorySnapshot(playerId);
    return snapshot.items
      .filter((item) => item.resourceType === itemId)
      .reduce((sum, item) => sum + Number(item.quantity), 0);
  }

  async function attack(playerId: string, flagId: string, requestId: string) {
    const flag = (await pool.query<{ lat: number; lon: number }>("SELECT lat,lon FROM flags WHERE id=$1", [flagId])).rows[0]!;
    return flags.structureWarfare.attack({
      kind: PERSONAL_FLAG_WARFARE_KIND, playerId, structureId: flagId, requestId,
      player: { position: { lat: Number(flag.lat), lon: Number(flag.lon) }, target: null, online: true }
    }).catch((error: unknown) => {
      if (error instanceof StructureWarfareError) throw error;
      throw error;
    });
  }

  async function repair(playerId: string, flagId: string, requestId: string) {
    const flag = (await pool.query<{ lat: number; lon: number }>("SELECT lat,lon FROM flags WHERE id=$1", [flagId])).rows[0]!;
    return flags.structureWarfare.reserveRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND, playerId, structureId: flagId, requestId,
      player: { position: { lat: Number(flag.lat), lon: Number(flag.lon) }, target: null, online: true }
    });
  }

  async function advance(playerId: string, flagId: string, operationId: string) {
    return flags.structureWarfare.advanceRepair({
      kind: PERSONAL_FLAG_WARFARE_KIND, playerId, structureId: flagId, operationId
    });
  }

  async function grant(playerId: string, itemId: "torch" | "repair_kit" | "stone" | "iron" | "bricks", quantity: number): Promise<void> {
    await inventory.grantItemsForOperation({
      operationKey: `war-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "war_structures_test",
      sourceEntityType: "war_structures_test",
      sourceEntityId: playerId,
      grants: [{ itemId, variant: "default", quantity }]
    });
  }

  async function health(flagId: string): Promise<{ health: number; maximumHealth: number }> {
    const row = (await pool.query<{ health: number; maximum_health: number }>(
      "SELECT health,maximum_health FROM flags WHERE id=$1", [flagId]
    )).rows[0]!;
    return { health: Number(row.health), maximumHealth: Number(row.maximum_health) };
  }

  async function withTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function createPlayer(id: string): Promise<void> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$1,$1,'#38bdf8','NM',35,-106,35,-106,900,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [id, accountId]
    );
  }

  async function createCity(mayorId: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cities (
         id, world_id, canonical_municipality_id, world_settlement_id, world_settlement_source,
         world_source_settlement_id, name, country_code, region_code, founder_player_id,
         founding_request_id, construction_phase, construction_completed_at, jumpable,
         seat_flag_id, hall_lat, hall_lon, hall_geom, founding_annex_radius_m, mayor_player_id
       ) VALUES ($1,'global',$2,$2,'overture',$2,'Ashford','US','US-NM',$3,$4,'complete',now(),true,
                 NULL,35.01,-106,ST_SetSRID(ST_MakePoint(-106,35.01),4326),500,$3)`,
      [id, `test:${id}`, mayorId, randomUUID()]
    );
    await pool.query("INSERT INTO city_treasuries (city_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
    const seat = await insertOrganizationFlag("city_seat", id, mayorId, "Hall", 35.01, -106);
    await pool.query("UPDATE cities SET seat_flag_id=$2 WHERE id=$1", [id, seat]);
    return id;
  }

  async function addCityMember(city: string, playerId: string, role: "mayor" | "member"): Promise<void> {
    await pool.query(
      `WITH house AS (
         INSERT INTO city_structures (
           structure_id, city_id, structure_type, tier, owner_player_id, world_id,
           lat, lon, geom, footprint_geom, footprint_radius_m, state, build_operation_key, built_at
         ) VALUES (
           gen_random_uuid(), $1, 'city_house', 1, $2, 'global', 35.02, -106.01,
           ST_SetSRID(ST_MakePoint(-106.01,35.02),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint(-106.01,35.02),4326)::geography,10)::geometry,
           10, 'active', $3, clock_timestamp()
         ) RETURNING structure_id
       )
       INSERT INTO city_memberships (city_id, player_id, world_id, role, house_structure_id, joined_at)
       SELECT $1, $2, 'global', $4, structure_id, clock_timestamp() FROM house`,
      [city, playerId, `war-house-${city}-${playerId}`, role]
    );
  }

  async function createKingdom(leaderId: string, castleLat = 36): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id)
       VALUES ($1,$2,'Emberreach',$3,$3,$4)`,
      [id, `emberreach-${id.slice(0, 8)}`, leaderId, randomUUID()]
    );
    await addKingdomMember(id, leaderId, "leader");
    await withTransaction(async (client) => {
      const sourceId = randomUUID();
      await client.query(
        `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, kingdom_id,
                            access_mode, kingdom_affiliated_at, original_owner_player_id)
         VALUES ($1,$2,'Castle',$4,-106,100,ST_SetSRID(ST_MakePoint(-106,$4),4326),'kingdom_seat',$3,'private',now(),$2)`,
        [sourceId, leaderId, id, castleLat]
      );
      await client.query(
        `INSERT INTO kingdom_seats (
           id, kingdom_id, lat, lon, geom, territory_radius_m, is_land, is_saltwater, inside_major_lake,
           environment_source_versions, environment_rules_version, environment_modifiers,
           environment_lookup_at, construction_state, completed_under_free_construction, status,
           completed_at, source_flag_id
         ) VALUES (gen_random_uuid(),$1,$3,-106,ST_SetSRID(ST_MakePoint(-106,$3),4326),100,true,false,false,
                   '{}'::jsonb,1,'[]'::jsonb,now(),'complete',true,'active',now(),$2)`,
        [id, sourceId, castleLat]
      );
    });
    return id;
  }

  async function addKingdomMember(kingdom: string, playerId: string, role: "leader" | "member"): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
       VALUES (gen_random_uuid(),$1,$2,$3,'active',now(),now())`,
      [kingdom, playerId, role]
    );
  }

  async function insertMarket(tier: number): Promise<string> {
    const result = await pool.query<{ structure_id: string }>(
      `INSERT INTO city_structures (
         structure_id, city_id, structure_type, tier, world_id, lat, lon, geom, footprint_geom,
         footprint_radius_m, state, build_operation_key, built_at
       ) VALUES (
         gen_random_uuid(), $1, 'market', $2, 'global', 35.015, -106.005,
         ST_SetSRID(ST_MakePoint(-106.005,35.015),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint(-106.005,35.015),4326)::geography,20)::geometry,
         20, 'active', $3, clock_timestamp()
       ) RETURNING structure_id::text`,
      [cityId, tier, `war-market-${cityId}`]
    );
    return result.rows[0]!.structure_id;
  }

  async function insertOrganizationFlag(
    controlType: "city" | "city_seat" | "kingdom",
    organizationId: string,
    ownerId: string,
    name: string,
    lat: number,
    lon: number
  ): Promise<string> {
    const column = controlType === "kingdom" ? "kingdom_id" : "city_id";
    const affiliated = controlType === "kingdom"
      ? "kingdom_affiliated_at, original_owner_player_id, contributed_by_player_id"
      : "city_affiliated_at";
    const result = await pool.query<{ id: string }>(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, ${column},
                          access_mode, ${affiliated})
       VALUES (gen_random_uuid(),$1,$2,$3,$4,20,ST_SetSRID(ST_MakePoint($4,$3),4326),$5,$6,$7,now()${controlType === "kingdom" ? ",$1,$1" : ""})
       RETURNING id::text`,
      [ownerId, name, lat, lon, controlType, organizationId, controlType === "kingdom" ? "private" : "public"]
    );
    return result.rows[0]!.id;
  }

  async function insertPersonalStone(ownerId: string, stoneHealth: number): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, reinforcement_level, access_mode)
       VALUES (gen_random_uuid(),$1,'Keep',34.99,-106,20,ST_SetSRID(ST_MakePoint(-106,34.99),4326),'personal',1,'public')
       RETURNING id::text`,
      [ownerId]
    );
    await pool.query("UPDATE flags SET health=$2 WHERE id=$1", [result.rows[0]!.id, stoneHealth]);
    return result.rows[0]!.id;
  }
});

void STRUCTURE_WARFARE_CITY_FLAG_HEALTH;
