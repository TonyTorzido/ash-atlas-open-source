import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldLookupResult } from "../world/worldTypes.js";
import { FlagAccessService } from "./flagAccess.js";
import { FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";
import { forwardSappersWarTowerBonus } from "./kingdomPerks.js";
import { KingdomService } from "./kingdoms.js";
import { settleFallenOrganizationStructures } from "./organizationStructureFall.js";
import { TowerVolleyService } from "./towerVolleys.js";
import { WalletService } from "./wallet.js";
import { WarCampWarfareService } from "./warCampWarfare.js";
import { OrganizationWarService } from "./warStructures.js";

const databaseUrl = process.env.KINGDOM_COMMAND_BOARD_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

/** ~555 m north of the enemy City Flag at (35, -106): outside every claim, inside the 2 km rule. */
const FORWARD = { lat: 35.005, lon: -106 } as const;

describeDatabase("Command Board, War Towers and War Outposts PostgreSQL integration", () => {
  let pool: pg.Pool;
  let inventory: InventoryService;
  let flags: FlagService;
  let kingdoms: KingdomService;
  let cityId = "";
  let kingdomId = "";
  let warId = "";

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("KINGDOM_COMMAND_BOARD_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    inventory = new InventoryService(pool);
  }, 180_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE organization_wars, organization_war_alerts, territory_collapses, kingdoms, players CASCADE");
    for (const id of ["raider", "squire", "mayor", "citizen", "outsider"]) await createPlayer(id);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger;
    const world = { lookupGameplayEnvironment: vi.fn(async () => worldAt()), lookupGameplayEnvironments: vi.fn() };
    const config = loadConfig({ NODE_ENV: "test" });
    flags = new FlagService(pool, world as unknown as WorldLookupClient, config, logger as never, inventory);
    kingdoms = new KingdomService(pool, world as unknown as WorldLookupClient, config, logger, () => new Date());
    cityId = await createCity("mayor");
    await addCityMember(cityId, "mayor", "mayor");
    await addCityMember(cityId, "citizen", "member");
    await insertCityFlag(cityId, "mayor", "East Gate", 35, -106);
    kingdomId = await createKingdom("raider");
    await addKingdomMember(kingdomId, "squire", "member");
    warId = (await pool.query<{ war_id: string }>(
      `INSERT INTO organization_wars (side_a_kind,side_a_id,side_b_kind,side_b_id,aggressor_kind,aggressor_id,declared_via)
       VALUES ('city',$1,'kingdom',$2,'kingdom',$2,'settings') RETURNING war_id::text`,
      [cityId, kingdomId]
    )).rows[0]!.war_id;
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE organization_wars, territory_collapses, kingdoms, players CASCADE");
    await pool?.end();
  });

  it("builds the Command Board ladder for the leader only, treasury first then the builder, once per request", async () => {
    await setTreasury("bricks", 150_000);
    await setTreasury("refined_oil", 540);
    await grant("raider", "pearl", 330);
    // Denied: an ordinary member.
    await expect(kingdoms.upgradeCommandBoard("squire", { requestId: "table-1", targetLevel: 1 }))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    // Allowed: the leader. Bricks and Glimmer Oil from the treasury, Pearl from the pack.
    const first = await kingdoms.upgradeCommandBoard("raider", { requestId: "table-1", targetLevel: 1 });
    expect(first.replayed).toBe(false);
    expect(first.state?.commandBoard).toMatchObject({ level: 1, warTowers: { used: 0, cap: 9 }, warOutposts: { used: 0, cap: 1 } });
    expect(await treasury("bricks")).toBe(42_000);
    expect(await treasury("refined_oil")).toBe(0);
    expect(await itemQuantity("raider", "pearl")).toBe(0);
    // Replay charges nothing.
    const replay = await kingdoms.upgradeCommandBoard("raider", { requestId: "table-1", targetLevel: 1 });
    expect(replay.replayed).toBe(true);
    expect(await treasury("bricks")).toBe(42_000);
    // A second request for the built level and a skipped level are refused.
    await expect(kingdoms.upgradeCommandBoard("raider", { requestId: "table-1-again", targetLevel: 1 }))
      .rejects.toMatchObject({ code: "KINGDOM_COMMAND_BOARD_LEVEL_CHANGED" });
    await expect(kingdoms.upgradeCommandBoard("raider", { requestId: "table-3", targetLevel: 3 }))
      .rejects.toMatchObject({ code: "KINGDOM_COMMAND_BOARD_LEVEL_CHANGED" });
    // Level 2 without the materials anywhere: refused, nothing moves.
    await expect(kingdoms.upgradeCommandBoard("raider", { requestId: "table-2", targetLevel: 2 }))
      .rejects.toMatchObject({ code: "KINGDOM_WAR_MATERIAL_REQUIRED" });
    expect(await treasury("bricks")).toBe(42_000);
    const ledger = await pool.query<{ total: string }>(
      "SELECT sum(quantity)::text AS total FROM kingdom_treasury_ledger WHERE source_type='command_board_upgrade'"
    );
    expect(ledger.rows[0]!.total).toBe("108540");
    await expect(pool.query("DELETE FROM kingdom_command_board_operations")).rejects.toMatchObject({ code: "55000" });
  });

  it("places War Towers within the Command Board cap near a warring enemy, and refuses out of range or over the cap", async () => {
    await pool.query("INSERT INTO kingdom_command_boards (kingdom_id, level) VALUES ($1, 1)", [kingdomId]);
    // Denied: a member with an empty pack, even with a full treasury (members never spend the treasury).
    await setTreasury("bricks", 8_000);
    await setTreasury("crystal", 2_000);
    await giveGold("squire", 20_000);
    await expect(flags.placeKingdomWarStructure({ playerId: "squire", ...FORWARD }, { requestId: "empty-pack", kind: "war_tower" }))
      .rejects.toMatchObject({ code: "KINGDOM_WAR_MATERIAL_REQUIRED" });
    expect(await treasury("bricks")).toBe(8_000);
    expect(await treasury("crystal")).toBe(2_000);
    expect(await gold("squire")).toBe(20_000n);
    await setTreasury("crystal", 0);
    await grant("raider", "crystal", 230);
    await giveGold("raider", 11_000);
    await grant("squire", "bricks", 4_500);
    await grant("squire", "crystal", 1_400);
    await grant("squire", "refined_oil", 560);
    await grant("squire", "iron", 240);
    // Denied: too far from any warring enemy, and an outsider.
    await expect(flags.placeKingdomWarStructure({ playerId: "squire", lat: 35.05, lon: -106 }, { requestId: "far", kind: "war_tower" }))
      .rejects.toMatchObject({ code: "KINGDOM_WAR_STRUCTURE_NO_ENEMY_NEAR" });
    await expect(flags.placeKingdomWarStructure({ playerId: "outsider", ...FORWARD }, { requestId: "x", kind: "war_tower" }))
      .rejects.toMatchObject({ code: "KINGDOM_WAR_STRUCTURE_PERMISSION_DENIED" });
    // Allowed: a member, next to the enemy city, paying from their own pack. Spacing does not apply.
    const tower = await flags.placeKingdomWarStructure({ playerId: "squire", ...FORWARD }, { requestId: "tower-1", kind: "war_tower" });
    expect(tower.replayed).toBe(false);
    expect(tower.flag).toMatchObject({ controlType: "kingdom", kingdomId, warStructureKind: "war_tower", warId, towerLevel: 1 });
    expect(await health(tower.flag.id)).toEqual({ health: 11_500, maximumHealth: 11_500 });
    expect(await treasury("bricks")).toBe(8_000);
    expect(await itemQuantity("squire", "bricks")).toBe(0);
    expect(await itemQuantity("squire", "crystal")).toBe(1_170);
    expect(await gold("squire")).toBe(9_000n);
    // Denied: a leader deposed into anarchy (role gone, kingdoms.leader_player_id not yet handed over)
    // pays like a member and cannot draw on the treasury.
    await pool.query("UPDATE kingdom_memberships SET role='member' WHERE player_id='raider'");
    await expect(flags.placeKingdomWarStructure({ playerId: "raider", lat: 35.0045, lon: -106.006 }, { requestId: "deposed", kind: "war_tower" }))
      .rejects.toMatchObject({ code: "KINGDOM_WAR_MATERIAL_REQUIRED" });
    expect(await treasury("bricks")).toBe(8_000);
    expect(await gold("raider")).toBe(11_000n);
    await pool.query("UPDATE kingdom_memberships SET role='leader' WHERE player_id='raider'");
    // The leader: Bricks from the treasury (it holds enough), Crystal from the pack (it does not).
    await flags.placeKingdomWarStructure({ playerId: "raider", lat: 35.0045, lon: -106.006 }, { requestId: "lead-tower", kind: "war_tower" });
    expect(await treasury("bricks")).toBe(3_500);
    expect(await itemQuantity("raider", "crystal")).toBe(0);
    // Replay charges nothing.
    const replay = await flags.placeKingdomWarStructure({ playerId: "squire", ...FORWARD }, { requestId: "tower-1", kind: "war_tower" });
    expect(replay).toMatchObject({ replayed: true, flag: { id: tower.flag.id } });
    expect(await gold("squire")).toBe(9_000n);
    // The War Outpost cap at level 1 is one.
    const outpost = await flags.placeKingdomWarStructure(
      { playerId: "squire", lat: 35.004, lon: -106.003 }, { requestId: "outpost-1", kind: "war_outpost" });
    expect(outpost.flag).toMatchObject({ warStructureKind: "war_outpost", maximumHealth: 2_200 });
    await grant("squire", "crystal", 1_150);
    await grant("squire", "refined_oil", 560);
    await grant("squire", "iron", 240);
    await expect(flags.placeKingdomWarStructure(
      { playerId: "squire", lat: 35.003, lon: -106.006 }, { requestId: "outpost-2", kind: "war_outpost" }))
      .rejects.toMatchObject({ code: "KINGDOM_WAR_STRUCTURE_CAPACITY" });
    // Outposts are a members-only travel point; a War Tower is no destination.
    const access = new FlagAccessService(pool);
    expect((await access.authorize(outpost.flag.id, "raider")).decision.allowed).toBe(true);
    expect((await access.authorize(outpost.flag.id, "citizen")).decision.allowed).toBe(false);
    expect((await access.authorize(tower.flag.id, "raider")).decision.allowed).toBe(false);
    // War structures are outside the 40-per-member structure capacity.
    const state = await kingdoms.getState("raider");
    expect(state.structureCapacity?.used).toBe(0);
    expect(state.commandBoard).toMatchObject({ warTowers: { used: 2, cap: 9 }, warOutposts: { used: 1, cap: 1 } });
  });

  it("fires a War Tower at members of the warring city with the Forward Sappers bonus, and breaks it when the war ends", async () => {
    const towerId = await insertWarTower(FORWARD.lat, FORWARD.lon);
    const keepId = await insertKingdomFlag("Keep", 36.001, -106);
    const hits: Array<{ flagId: string; targetPlayerId: string; flatDamageBonus?: number }> = [];
    // The realtime wiring: Forward Sappers adds +4, a kingdom without it gets nothing.
    expect(await forwardSappersWarTowerBonus(pool, [kingdomId])).toEqual(new Map([[kingdomId, 0]]));
    await pool.query(
      "INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id) VALUES ($1, 3, 'forward_sappers')",
      [kingdomId]
    );
    const volleys = new TowerVolleyService(pool, {
      hitPlayer: (input) => { hits.push(input); return 19; },
      warTowerAttackBonus: (ids) => forwardSappersWarTowerBonus(pool, ids)
    });
    await volleys.tick([
      { playerId: "citizen", lat: FORWARD.lat + 0.001, lon: -106 },
      { playerId: "squire", lat: FORWARD.lat + 0.0005, lon: -106 },
      { playerId: "outsider", lat: FORWARD.lat + 0.0008, lon: -106 }
    ]);
    expect(hits).toMatchObject([{ flagId: towerId, targetPlayerId: "citizen", flatDamageBonus: 4 }]);
    // The city surrenders: the war ends, the tower falls silent and breaks; the kingdom's own flags stay.
    await new OrganizationWarService(pool).surrender("mayor", { warId, as: { kind: "city", id: cityId } });
    hits.length = 0;
    await volleys.tick([{ playerId: "citizen", lat: FORWARD.lat + 0.001, lon: -106 }]);
    expect(hits).toEqual([]);
    const fallen = await settleFallenOrganizationStructures(pool, { begin: vi.fn(async () => null) });
    expect(fallen.brokenFlagIds).toEqual([towerId]);
    expect((await pool.query("SELECT 1 FROM flags WHERE id=$1", [towerId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM flags WHERE id=$1", [keepId])).rowCount).toBe(1);
    expect((await settleFallenOrganizationStructures(pool, { begin: vi.fn(async () => null) })).brokenFlagIds).toEqual([]);
  });

  it("refuses a War Camp attack while a forced peace holds between the two sides", async () => {
    const campId = (await pool.query<{ camp_id: string }>(
      `INSERT INTO war_camps (owner_player_id, world_id, region_code, lat, lon, geom, footprint_geom, footprint_radius_m)
       VALUES ('citizen','global','NM',35.02,-106,ST_SetSRID(ST_MakePoint(-106,35.02),4326),
               ST_Buffer(ST_SetSRID(ST_MakePoint(-106,35.02),4326)::geography,15)::geometry,15)
       RETURNING camp_id::text`
    )).rows[0]!.camp_id;
    await new OrganizationWarService(pool).surrender("mayor", { warId, as: { kind: "city", id: cityId } });
    await expect(new WarCampWarfareService(pool).attack({
      playerId: "raider", position: { lat: 35.0201, lon: -106 }, campId, requestId: "peace-hand", mode: "hand"
    })).rejects.toMatchObject({ code: "WAR_CAMP_FORCED_PEACE" });
    expect((await pool.query("SELECT health FROM war_camps WHERE camp_id=$1", [campId])).rows[0]).toEqual({ health: 2_200 });
  });

  it("damages an enemy War Camp by hand and by Bomber down to its burn threshold, then burns it out", async () => {
    const camp = (await pool.query<{ camp_id: string; health: number; maximum_health: number }>(
      `INSERT INTO war_camps (owner_player_id, world_id, region_code, lat, lon, geom, footprint_geom, footprint_radius_m)
       VALUES ('citizen','global','NM',35.02,-106,ST_SetSRID(ST_MakePoint(-106,35.02),4326),
               ST_Buffer(ST_SetSRID(ST_MakePoint(-106,35.02),4326)::geography,15)::geometry,15)
       RETURNING camp_id::text, health, maximum_health`
    )).rows[0]!;
    expect(camp).toMatchObject({ health: 2_200, maximum_health: 2_200 });
    const warCamps = new WarCampWarfareService(pool);
    const at = { lat: 35.0201, lon: -106 };
    // Denied: the owner's own city member.
    await expect(warCamps.attack({ playerId: "mayor", position: at, campId: camp.camp_id, requestId: "ally", mode: "hand" }))
      .rejects.toMatchObject({ code: "WAR_CAMP_ATTACK_ALLY" });
    // Allowed: an enemy by hand, 25 once; a replay is free; a second hand attack waits 24 h.
    const hand = await warCamps.attack({ playerId: "raider", position: at, campId: camp.camp_id, requestId: "hand-1", mode: "hand" });
    expect(hand).toMatchObject({ damage: 25, health: 2_175, ignited: false, replayed: false });
    expect(await warCamps.attack({ playerId: "raider", position: at, campId: camp.camp_id, requestId: "hand-1", mode: "hand" }))
      .toMatchObject({ damage: 25, health: 2_175, replayed: true });
    await expect(warCamps.attack({ playerId: "raider", position: at, campId: camp.camp_id, requestId: "hand-2", mode: "hand" }))
      .rejects.toMatchObject({ code: "WAR_CAMP_ATTACK_COOLDOWN" });
    await pool.query("UPDATE war_camps SET health=2075 WHERE camp_id=$1", [camp.camp_id]);
    // A Bomber strike spends one Bomber and stops at the 1,100 threshold, igniting the 1 h burn.
    const groupId = (await pool.query<{ group_id: string }>(
      `INSERT INTO military_unit_groups (owner_player_id, unit_type, location_state, lat, lon)
       VALUES ('raider','bomber','DEPLOYED_FIELD',35.0201,-106) RETURNING group_id::text`
    )).rows[0]!.group_id;
    for (let index = 0; index < 2; index += 1) {
      await pool.query(
        `INSERT INTO military_units (owner_player_id, unit_type, current_hp, max_hp, status, location_state, lat, lon, group_id)
         VALUES ('raider','bomber',60,60,'available','DEPLOYED_FIELD',35.0201,-106,$1)`,
        [groupId]
      );
    }
    const bomb = await warCamps.attack({ playerId: "raider", position: at, campId: camp.camp_id, requestId: "bomb-1", mode: "bomber", groupId });
    expect(bomb).toMatchObject({ damage: 975, health: 1_100, ignited: true });
    expect((await pool.query("SELECT 1 FROM military_units WHERE group_id=$1 AND status='available'", [groupId])).rowCount).toBe(1);
    await expect(warCamps.attack({ playerId: "raider", position: at, campId: camp.camp_id, requestId: "bomb-2", mode: "bomber", groupId }))
      .rejects.toMatchObject({ code: "WAR_CAMP_BURNING" });
    // The burn ends: the camp is removed once.
    await pool.query("UPDATE war_camps SET burning_until = now() - interval '1 second' WHERE camp_id=$1", [camp.camp_id]);
    expect(await warCamps.reconcileBurnedOutWarCamps()).toEqual(["citizen"]);
    expect(await warCamps.reconcileBurnedOutWarCamps()).toEqual([]);
    expect((await pool.query("SELECT removed_reason FROM war_camps WHERE camp_id=$1", [camp.camp_id])).rows[0])
      .toEqual({ removed_reason: "burned" });
  });

  async function insertWarTower(lat: number, lon: number): Promise<string> {
    const id = await insertKingdomFlag("War Tower", lat, lon);
    await pool.query("UPDATE flags SET war_structure_kind='war_tower', war_id=$2 WHERE id=$1", [id, warId]);
    return id;
  }

  async function insertKingdomFlag(name: string, lat: number, lon: number): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, kingdom_id,
                          access_mode, kingdom_affiliated_at, original_owner_player_id, contributed_by_player_id)
       VALUES (gen_random_uuid(),'raider',$1,$2,$3,20,ST_SetSRID(ST_MakePoint($3,$2),4326),'kingdom',$4,
               'private',now(),'raider','raider')
       RETURNING id::text`,
      [name, lat, lon, kingdomId]
    );
    return result.rows[0]!.id;
  }

  async function treasury(resourceType: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM kingdom_treasury_balances WHERE kingdom_id=$1 AND resource_type=$2",
      [kingdomId, resourceType]
    );
    return Number(result.rows[0]?.quantity ?? 0);
  }

  async function setTreasury(resourceType: string, quantity: number): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_treasury_balances (kingdom_id, resource_type, variant, quantity)
       VALUES ($1,$2,'default',$3)
       ON CONFLICT (kingdom_id, resource_type, variant) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [kingdomId, resourceType, quantity]
    );
  }

  async function itemQuantity(playerId: string, itemId: string): Promise<number> {
    const snapshot = await inventory.getInventorySnapshot(playerId);
    return snapshot.items
      .filter((item) => item.resourceType === itemId)
      .reduce((sum, item) => sum + Number(item.quantity), 0);
  }

  async function grant(playerId: string, itemId: "pearl" | "crystal" | "refined_oil" | "iron" | "bricks", quantity: number) {
    await inventory.grantItemsForOperation({
      operationKey: `command-board-test:${playerId}:${randomUUID()}`,
      playerId,
      source: "kingdom_command_board_test",
      sourceEntityType: "kingdom_command_board_test",
      sourceEntityId: playerId,
      grants: [{ itemId, variant: "default", quantity }]
    });
  }

  async function giveGold(playerId: string, amount: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ account_id: string }>("SELECT account_id::text FROM players WHERE id=$1", [playerId]);
      await new WalletService().creditForOperationInTransaction(client, {
        playerId,
        accountId: account.rows[0]!.account_id,
        amount: BigInt(amount),
        operationKey: `command-board-test-gold:${randomUUID()}`,
        reason: "test_grant"
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  async function gold(playerId: string): Promise<bigint> {
    const result = await pool.query<{ gold_balance: string }>("SELECT gold_balance::text FROM player_wallets WHERE player_id=$1", [playerId]);
    return BigInt(result.rows[0]?.gold_balance ?? "0");
  }

  async function health(flagId: string): Promise<{ health: number; maximumHealth: number }> {
    const row = (await pool.query<{ health: number; maximum_health: number }>(
      "SELECT health,maximum_health FROM flags WHERE id=$1", [flagId]
    )).rows[0]!;
    return { health: Number(row.health), maximumHealth: Number(row.maximum_health) };
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
                 NULL,34.99,-106,ST_SetSRID(ST_MakePoint(-106,34.99),4326),500,$3)`,
      [id, `test:${id}`, mayorId, randomUUID()]
    );
    await pool.query("INSERT INTO city_treasuries (city_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
    const seat = await insertCityFlag(id, mayorId, "Hall", 34.99, -106, "city_seat");
    await pool.query("UPDATE cities SET seat_flag_id=$2 WHERE id=$1", [id, seat]);
    return id;
  }

  async function insertCityFlag(
    city: string, ownerId: string, name: string, lat: number, lon: number, controlType: "city" | "city_seat" = "city"
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, city_id,
                          access_mode, city_affiliated_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,20,ST_SetSRID(ST_MakePoint($4,$3),4326),$5,$6,'public',now())
       RETURNING id::text`,
      [ownerId, name, lat, lon, controlType, city]
    );
    return result.rows[0]!.id;
  }

  async function addCityMember(city: string, playerId: string, role: "mayor" | "member"): Promise<void> {
    await pool.query(
      `WITH house AS (
         INSERT INTO city_structures (
           structure_id, city_id, structure_type, tier, owner_player_id, world_id,
           lat, lon, geom, footprint_geom, footprint_radius_m, state, build_operation_key, built_at
         ) VALUES (
           gen_random_uuid(), $1, 'city_house', 1, $2, 'global', 34.98, -106.01,
           ST_SetSRID(ST_MakePoint(-106.01,34.98),4326),
           ST_Buffer(ST_SetSRID(ST_MakePoint(-106.01,34.98),4326)::geography,10)::geometry,
           10, 'active', $3, clock_timestamp()
         ) RETURNING structure_id
       )
       INSERT INTO city_memberships (city_id, player_id, world_id, role, house_structure_id, joined_at)
       SELECT $1, $2, 'global', $4, structure_id, clock_timestamp() FROM house`,
      [city, playerId, `war-b2-house-${city}-${playerId}`, role]
    );
  }

  async function createKingdom(leaderId: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id)
       VALUES ($1,$2,'Emberreach',$3,$3,$4)`,
      [id, `emberreach-${id.slice(0, 8)}`, leaderId, randomUUID()]
    );
    await addKingdomMember(id, leaderId, "leader");
    const sourceId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, kingdom_id,
                            access_mode, kingdom_affiliated_at, original_owner_player_id)
         VALUES ($1,$2,'Castle',36,-106,100,ST_SetSRID(ST_MakePoint(-106,36),4326),'kingdom_seat',$3,'private',now(),$2)`,
        [sourceId, leaderId, id]
      );
      await client.query(
        `INSERT INTO kingdom_seats (
           id, kingdom_id, lat, lon, geom, territory_radius_m, is_land, is_saltwater, inside_major_lake,
           environment_source_versions, environment_rules_version, environment_modifiers,
           environment_lookup_at, construction_state, completed_under_free_construction, status,
           completed_at, source_flag_id
         ) VALUES (gen_random_uuid(),$1,36,-106,ST_SetSRID(ST_MakePoint(-106,36),4326),100,true,false,false,
                   '{}'::jsonb,1,'[]'::jsonb,now(),'complete',true,'active',now(),$2)`,
        [id, sourceId]
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    return id;
  }

  async function addKingdomMember(kingdom: string, playerId: string, role: "leader" | "member"): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
       VALUES (gen_random_uuid(),$1,$2,$3,'active',now(),now())`,
      [kingdom, playerId, role]
    );
  }
});

function worldAt(): WorldLookupResult {
  const raw = {
    ok: true,
    covered: true,
    release: { release_id: "world-packages-v1", profile_set_fingerprint: "a".repeat(64), build_contract_fingerprint: "b".repeat(64), boundary_release_id: "world-boundaries-v1", package_count: 64800 },
    selected_package: { package_id: "world_v1_lat35_lon-106" },
    profile: { environment_schema_version: "world-profile-v2", latitude: 35, longitude: -106, administrative: {}, environment: { ecology_resolution: "nearest_land_fallback" }, water: { nearest_water_resolution: "within_search_radius" }, derived_tags: [], source_versions: {}, warnings: [] }
  };
  return {
    ok: true,
    packageId: "world_v1_lat35_lon-106",
    elevationM: 1600,
    terrainClass: "flat",
    biome: "Deserts & Xeric Shrublands",
    ecoregion: "Chihuahuan desert",
    raw
  } as WorldLookupResult;
}
