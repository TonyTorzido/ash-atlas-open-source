import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  KINGDOM_PERK_ACTIVATION_COOLDOWN_MS,
  KINGDOM_PERK_BUFF_DURATION_MS
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { kingdomBrickYieldAt, kingdomBrickYieldRoll } from "./kingdomBrickYield.js";
import {
  NO_KINGDOM_COMBAT_PERK_EFFECTS,
  playersNearCisternWarrensEntrance,
  playersOnOwnKingdomLand,
  syncKingdomCombatPerks,
  type KingdomCombatPerkEffects
} from "./kingdomCombatPerks.js";
import { EquipmentService } from "./equipment.js";
import { InventoryService } from "./inventory.js";
import { kingdomHuntingPerksAt } from "./kingdomPerks.js";
import { payKingdomLegendaryRingPerkInTransaction } from "./kingdomRewardPerks.js";
import { WalletService } from "./wallet.js";
import { KingdomService } from "./kingdoms.js";

const databaseUrl = process.env.KINGDOM_PERKS_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const GRANDFATHER_SQL = (() => {
  const migration = readFileSync(
    fileURLToPath(new URL("../../../../db/migrations/0929_kingdom_perk_tree.sql", import.meta.url)),
    "utf8"
  );
  return migration.slice(migration.indexOf("-- Grandfather"), migration.indexOf("COMMENT ON TABLE kingdom_perk_selections"));
})();

describeDatabase("kingdom perk tree PostgreSQL integration", () => {
  let pool: pg.Pool;
  let kingdoms: KingdomService;
  let now: Date;
  let kingdomId = "";

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("KINGDOM_PERKS_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE kingdoms, players CASCADE");
    now = new Date("2026-10-02T12:00:00.000Z");
    for (const id of ["ruler", "squire", "outsider"]) await createPlayer(id);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as AppLogger;
    kingdoms = new KingdomService(
      pool,
      { lookupGameplayEnvironment: vi.fn(), lookupGameplayEnvironments: vi.fn() } as unknown as WorldLookupClient,
      loadConfig({ NODE_ENV: "test" }),
      logger,
      () => new Date(now)
    );
    kingdomId = await createKingdom("ruler", 6);
    await addKingdomMember(kingdomId, "squire", "member");
  });

  afterAll(async () => {
    await pool?.query("TRUNCATE kingdoms, players CASCADE");
    await pool?.end();
  });

  it("charges 23.5k Bricks + 1,150 Glimmer Oil to choose and 34k + 1,700 to change, leader only, once per request", async () => {
    await setTreasury("bricks", 60_000);
    await setTreasury("refined_oil", 3_000);
    // Denied: an ordinary member.
    await expect(kingdoms.chooseKingdomPerk("squire", {
      requestId: "squire-choose", perkId: "unyielding_assault", expectedCurrentPerkId: null
    })).rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    expect(await treasury("bricks")).toBe(60_000);

    // Allowed: the leader chooses an empty level.
    const first = await kingdoms.chooseKingdomPerk("ruler", {
      requestId: "choose-5", perkId: "unyielding_assault", expectedCurrentPerkId: null
    });
    expect(first.replayed).toBe(false);
    expect(await treasury("bricks")).toBe(36_500);
    expect(await treasury("refined_oil")).toBe(1_850);
    // Replay of the same request charges nothing.
    const replay = await kingdoms.chooseKingdomPerk("ruler", {
      requestId: "choose-5", perkId: "unyielding_assault", expectedCurrentPerkId: null
    });
    expect(replay.replayed).toBe(true);
    expect(await treasury("bricks")).toBe(36_500);
    // Concurrent duplicates of a new change request move the treasury once.
    await Promise.allSettled([
      kingdoms.chooseKingdomPerk("ruler", { requestId: "change-5", perkId: "picked_legion", expectedCurrentPerkId: "unyielding_assault" }),
      kingdoms.chooseKingdomPerk("ruler", { requestId: "change-5", perkId: "picked_legion", expectedCurrentPerkId: "unyielding_assault" })
    ]);
    expect(await treasury("bricks")).toBe(2_500);
    expect(await treasury("refined_oil")).toBe(150);
    // A stale view of the level is refused instead of charged the other price.
    await expect(kingdoms.chooseKingdomPerk("ruler", {
      requestId: "stale", perkId: "hearth_ground", expectedCurrentPerkId: null
    })).rejects.toMatchObject({ code: "KINGDOM_PERK_STATE_CHANGED" });
    await expect(kingdoms.chooseKingdomPerk("ruler", {
      requestId: "broke", perkId: "labor_corps", expectedCurrentPerkId: "picked_legion"
    })).rejects.toMatchObject({ code: "KINGDOM_PERK_INSUFFICIENT_TREASURY" });

    const operations = await pool.query(
      "SELECT action, perk_id, previous_perk_id, bricks_quantity, glimmer_oil_quantity FROM kingdom_perk_operations ORDER BY created_at"
    );
    expect(operations.rows).toEqual([
      { action: "choose", perk_id: "unyielding_assault", previous_perk_id: null, bricks_quantity: 23_500, glimmer_oil_quantity: 1_150 },
      { action: "change", perk_id: "picked_legion", previous_perk_id: "unyielding_assault", bricks_quantity: 34_000, glimmer_oil_quantity: 1_700 }
    ]);
    const ledger = await pool.query<{ source_type: string; resource_type: string; total: string }>(
      `SELECT source_type, resource_type, sum(quantity)::text AS total FROM kingdom_treasury_ledger
       GROUP BY source_type, resource_type ORDER BY source_type, resource_type`
    );
    expect(ledger.rows).toEqual([
      { source_type: "kingdom_perk_change", resource_type: "bricks", total: "34000" },
      { source_type: "kingdom_perk_change", resource_type: "refined_oil", total: "1700" },
      { source_type: "kingdom_perk_choose", resource_type: "bricks", total: "23500" },
      { source_type: "kingdom_perk_choose", resource_type: "refined_oil", total: "1150" }
    ]);
    const state = await kingdoms.getState("ruler");
    expect(state.progression?.perkSelections).toMatchObject([{ level: 5, perkId: "picked_legion" }]);
    expect(state.progression?.perks.find((perk) => perk.id === "picked_legion")).toMatchObject({ selected: true, active: true });
  });

  it("refuses a perk above the kingdom level", async () => {
    await pool.query("UPDATE kingdoms SET level=2 WHERE id=$1", [kingdomId]);
    await setTreasury("bricks", 30_000);
    await setTreasury("refined_oil", 1_500);
    await expect(kingdoms.chooseKingdomPerk("ruler", {
      requestId: "too-early", perkId: "beacon_wardens", expectedCurrentPerkId: null
    })).rejects.toMatchObject({ code: "KINGDOM_PERK_LOCKED" });
    expect(await treasury("bricks")).toBe(30_000);
  });

  it("activates a level 6 buff for every member for 24 h, once per 24 h, and drops it from stats when it ends", async () => {
    await setTreasury("bricks", 30_000);
    await setTreasury("refined_oil", 1_500);
    await kingdoms.chooseKingdomPerk("ruler", { requestId: "pick-6", perkId: "the_spearhead", expectedCurrentPerkId: null });
    // Chosen but not activated: no buff yet.
    expect(await kingdoms.statModifiers("squire")).toMatchObject({ attackBonus: 0, defenseBonus: 0 });
    await expect(kingdoms.activateKingdomPerk("squire", { requestId: "squire-go", perkId: "the_spearhead" }))
      .rejects.toMatchObject({ code: "KINGDOM_PERMISSION_DENIED" });
    await kingdoms.activateKingdomPerk("ruler", { requestId: "go-1", perkId: "the_spearhead" });
    expect(await kingdoms.statModifiers("squire")).toMatchObject({ attackBonus: 2, defenseBonus: 0 });
    now = new Date(now.getTime() + KINGDOM_PERK_BUFF_DURATION_MS - 1_000);
    await expect(kingdoms.activateKingdomPerk("ruler", { requestId: "go-2", perkId: "the_spearhead" }))
      .rejects.toMatchObject({ code: "KINGDOM_PERK_ACTIVATION_COOLDOWN" });
    now = new Date(now.getTime() + 2_000);
    expect(await kingdoms.statModifiers("squire")).toMatchObject({ attackBonus: 0 });
    expect(KINGDOM_PERK_ACTIVATION_COOLDOWN_MS).toBe(KINGDOM_PERK_BUFF_DURATION_MS);
    await kingdoms.activateKingdomPerk("ruler", { requestId: "go-3", perkId: "the_spearhead" });
    expect(await kingdoms.statModifiers("ruler")).toMatchObject({ attackBonus: 2 });
  });

  it("grandfathers Boundary Writ at level 2 for kingdoms at level 2+ once, free, and keeps a chosen level 2 perk", async () => {
    await pool.query("TRUNCATE kingdoms, players CASCADE");
    for (const id of ["ruler", "squire", "outsider", "dissolver", "chooser", "chooser-squire"]) await createPlayer(id);
    const byLevel = await createKingdom("ruler", 4);
    const byXp = await createKingdom("squire", 1, 300);
    const young = await createKingdom("outsider", 1, 100);
    const dissolved = await createKingdom("dissolver", 3);
    await pool.query("UPDATE kingdoms SET status='dissolved', dissolved_at=now() WHERE id=$1", [dissolved]);
    const chosen = await createKingdom("chooser", 2);
    await addKingdomMember(chosen, "chooser-squire", "member");
    await pool.query(
      "INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id) VALUES ($1, 2, 'reserved_game')",
      [chosen]
    );
    await pool.query(GRANDFATHER_SQL);
    await pool.query(GRANDFATHER_SQL);
    const rows = await pool.query<{ kingdom_id: string; perk_id: string }>(
      "SELECT kingdom_id::text, perk_id FROM kingdom_perk_selections WHERE perk_level = 2 ORDER BY perk_id"
    );
    expect(new Map(rows.rows.map((row) => [row.kingdom_id, row.perk_id]))).toEqual(new Map([
      [byLevel, "boundary_writ"],
      [byXp, "boundary_writ"],
      [chosen, "reserved_game"]
    ]));
    expect(rows.rows.some((row) => row.kingdom_id === young || row.kingdom_id === dissolved)).toBe(false);
    const operations = await pool.query("SELECT kingdom_id::text, bricks_quantity, glimmer_oil_quantity FROM kingdom_perk_operations");
    expect(operations.rows).toHaveLength(2);
    expect(operations.rows.every((row) => row.bricks_quantity === 0 && row.glimmer_oil_quantity === 0)).toBe(true);
    // The grandfathered perk keeps the Boundary Writ +2 attack / +2 defense.
    expect(await kingdoms.statModifiers("ruler")).toMatchObject({ attackBonus: 2, defenseBonus: 2, qualified: true });
    expect(await kingdoms.statModifiers("chooser-squire")).toMatchObject({ attackBonus: 0, defenseBonus: 0 });
  });

  it("pays Reserved Game on the kingdom's own land, Gilded Trim near an obelisk, and Caravan Guild while its buff runs", async () => {
    const castle = { lat: 36, lon: -106 };
    const far = { lat: 36.5, lon: -106 };
    await insertKingdomFlag("Home", castle, 300);
    expect(await kingdomHuntingPerksAt(pool, "squire", castle, now)).toEqual({ goldMultiplier: 1, dropChanceMultiplier: 1 });
    await select(2, "reserved_game");
    expect(await kingdomHuntingPerksAt(pool, "squire", castle, now)).toEqual({ goldMultiplier: 1.06, dropChanceMultiplier: 1 });
    expect(await kingdomHuntingPerksAt(pool, "squire", far, now)).toEqual({ goldMultiplier: 1, dropChanceMultiplier: 1 });
    // Not for outsiders, and not before the membership qualifies.
    expect(await kingdomHuntingPerksAt(pool, "outsider", castle, now)).toEqual({ goldMultiplier: 1, dropChanceMultiplier: 1 });
    await pool.query("UPDATE kingdom_memberships SET perk_qualified_at=$2 WHERE player_id=$1", ["squire", new Date(now.getTime() + 60_000)]);
    expect(await kingdomHuntingPerksAt(pool, "squire", castle, now)).toEqual({ goldMultiplier: 1, dropChanceMultiplier: 1 });
    await pool.query("UPDATE kingdom_memberships SET perk_qualified_at=$2 WHERE player_id=$1", ["squire", now]);

    const obelisk = await insertKingdomFlag("Spire", { lat: 36.003, lon: -106 }, 20);
    await pool.query("UPDATE flags SET obelisk_level=4 WHERE id=$1", [obelisk]);
    await select(4, "gilded_trim");
    const near = await kingdomHuntingPerksAt(pool, "squire", castle, now);
    expect(near.goldMultiplier).toBeCloseTo(1.084, 10);

    await select(6, "caravan_guild");
    expect((await kingdomHuntingPerksAt(pool, "squire", far, now)).dropChanceMultiplier).toBe(1);
    await pool.query(
      "UPDATE kingdom_perk_selections SET activated_at=$2, active_until=$3 WHERE kingdom_id=$1 AND perk_level=6",
      [kingdomId, now, new Date(now.getTime() + KINGDOM_PERK_BUFF_DURATION_MS)]
    );
    expect((await kingdomHuntingPerksAt(pool, "squire", far, now)).dropChanceMultiplier).toBe(1.2);
  });

  it("runs the position-aware perk SQL on own land, on at-war enemy land and off land", async () => {
    await pool.query("TRUNCATE organization_wars CASCADE");
    const home = { lat: 36, lon: -106 };
    const enemyLand = { lat: 36.2, lon: -106 };
    const off = { lat: 36.5, lon: -106 };
    // Home kingdom: Boundary Writ (level 2) and Breach Company (level 6).
    await insertKingdomFlag("Home", home, 300);
    await select(2, "boundary_writ");
    await select(6, "breach_company");
    // Rival kingdom at war with it: Verdant Surge and a running Spearhead buff.
    await createPlayer("rival");
    const rival = await createKingdom("rival", 6);
    await insertKingdomFlag("Rival", enemyLand, 300, rival, "rival");
    await pool.query(
      `INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id, activated_at, active_until)
       VALUES ($1,2,'verdant_surge',NULL,NULL), ($1,6,'the_spearhead',$2,$3)`,
      [rival, now, new Date(now.getTime() + KINGDOM_PERK_BUFF_DURATION_MS)]
    );
    const [sideA, sideB] = [kingdomId, rival].sort();
    await pool.query(
      `INSERT INTO organization_wars (side_a_kind, side_a_id, side_b_kind, side_b_id, aggressor_kind, aggressor_id, declared_via)
       VALUES ('kingdom',$1,'kingdom',$2,'kingdom',$3,'settings')`,
      [sideA, sideB, rival]
    );

    const sync = async (rivalAt: { lat: number; lon: number }) => {
      const applied = new Map<string, KingdomCombatPerkEffects>();
      await syncKingdomCombatPerks(pool, [
        { playerId: "ruler", ...home, regionCode: "NM" },
        { playerId: "squire", lat: 36.001, lon: -106, regionCode: "NM" },
        { playerId: "rival", ...rivalAt, regionCode: "NM" },
        { playerId: "outsider", ...home, regionCode: "NM" }
      ], (playerId, effects) => applied.set(playerId, effects), now);
      return applied;
    };
    const onLand = await sync(enemyLand);
    // Breach Company: ruler and squire stand ~110 m apart.
    expect(onLand.get("ruler")).toEqual({ attackBonus: 1, healingBonus: 0, speedBonus: 0 });
    expect(onLand.get("squire")).toEqual({ attackBonus: 1, healingBonus: 0, speedBonus: 0 });
    // Verdant Surge on its own land, plus the running Spearhead buff.
    expect(onLand.get("rival")).toEqual({ attackBonus: 0, healingBonus: 4, speedBonus: 25 });
    expect(onLand.get("outsider")).toEqual(NO_KINGDOM_COMBAT_PERK_EFFECTS);
    expect((await sync(off)).get("rival")).toEqual({ attackBonus: 0, healingBonus: 0, speedBonus: 25 });
    expect(await playersOnOwnKingdomLand(pool, [
      { playerId: "ruler", kingdomId, ...home },
      { playerId: "squire", kingdomId, ...enemyLand },
      { playerId: "rival", kingdomId: rival, ...off }
    ])).toEqual(new Set(["ruler"]));

    // Boundary Writ: a roll in [10%, 25%) yields only on at-war enemy land.
    const keyFor = (hit: (roll: number) => boolean) => {
      for (let index = 0; ; index += 1) if (hit(kingdomBrickYieldRoll(`tr-${index}`))) return `tr-${index}`;
    };
    const warOnlyKey = keyFor((roll) => roll >= 0.1 && roll < 0.25);
    const baseKey = keyFor((roll) => roll < 0.1);
    const brick = (position: { lat: number; lon: number }, rollKey: string) =>
      kingdomBrickYieldAt(pool, { playerId: "squire", position, rollKey });
    expect(await brick(enemyLand, warOnlyKey)).toMatchObject({ kingdomId: rival, member: false });
    expect(await brick(home, warOnlyKey)).toBeNull();
    expect(await brick(home, baseKey)).toMatchObject({ kingdomId, member: true });
    expect(await brick(off, baseKey)).toBeNull();
    await pool.query("UPDATE organization_wars SET status='ended', ended_at=now(), ended_reason='mutual_peace', peace_until=now() + interval '7 days'");
    expect(await brick(enemyLand, warOnlyKey)).toBeNull();
    expect(await brick(enemyLand, baseKey)).toMatchObject({ kingdomId: rival, member: false });
  });

  it("Treacherous Ground: +3 attack near a dungeon entrance; Far Renown: +12% Bricks", async () => {
    const gate = { lat: 36, lon: -106 };
    await select(8, "treacherous_ground");
    const applied = new Map<string, KingdomCombatPerkEffects>();
    await syncKingdomCombatPerks(pool, [
      { playerId: "ruler", ...gate, regionCode: "NM" },
      { playerId: "squire", lat: 36.1, lon: -106, regionCode: "NM" }
    ], (playerId, effects) => applied.set(playerId, effects), now,
    (position, radiusM) => radiusM === 550 && Math.abs(position.lat - gate.lat) < 0.001);
    expect(applied.get("ruler")?.attackBonus).toBe(3);
    expect(applied.get("squire")?.attackBonus).toBe(0);
    // The cistern warrens lookup runs (no sewers here).
    expect(await playersNearCisternWarrensEntrance(pool, [{ playerId: "squire", lat: 36.1, lon: -106 }], 600)).toEqual(new Set());

    await insertKingdomFlag("Home", gate, 300);
    const key = (() => {
      for (let index = 0; ; index += 1) if (kingdomBrickYieldRoll(`dg-${index}`) < 0.1) return `dg-${index}`;
    })();
    const plain = await kingdomBrickYieldAt(pool, { playerId: "squire", position: gate, rollKey: key });
    await select(8, "far_renown");
    const glory = await kingdomBrickYieldAt(pool, { playerId: "squire", position: gate, rollKey: key });
    expect(plain?.perkMultiplier).toBe(1);
    expect(glory?.perkMultiplier).toBeCloseTo(1.12, 10);
  });

  it("pays the chosen level 7 perk once per legendary ring receipt", async () => {
    // The grandfather test replays 0929, which restores its older ledger source list.
    await pool.query(readFileSync(
      fileURLToPath(new URL("../../../../db/migrations/1152_kingdom_perks_levels_seven_eight.sql", import.meta.url)),
      "utf8"
    ));
    const equipment = new EquipmentService(pool, { inventory: new InventoryService(pool) });
    const wallet = new WalletService();
    const accountId = (await pool.query<{ account_id: string }>(
      "SELECT account_id FROM players WHERE id='squire'"
    )).rows[0]!.account_id;
    const pay = async (ringOperationKey: string) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const payout = await payKingdomLegendaryRingPerkInTransaction(
          client,
          { equipment, wallet },
          { playerId: "squire", accountId, ringOperationKey, ground: null, now }
        );
        await client.query("COMMIT");
        return payout;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const grandRings = async () => Number((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM equipment_instances WHERE owner_player_id='squire' AND definition_id='ring_peerless'"
    )).rows[0]!.count);
    const gold = async () => Number((await pool.query<{ gold: string }>(
      "SELECT COALESCE((SELECT gold_balance::text FROM player_wallets WHERE player_id='squire'), '0') AS gold"
    )).rows[0]!.gold);

    // No level 7 perk: nothing pays.
    expect(await pay("ring-0")).toBeNull();

    await select(7, "arcane_reavers");
    expect((await pay("ring-1"))?.ring).toMatchObject({ definitionId: "ring_peerless", delivered: "inventory" });
    expect((await pay("ring-1"))?.ring).toMatchObject({ delivered: "replayed" });
    expect(await grandRings()).toBe(1);

    await select(7, "mortar_guard");
    await pay("ring-2");
    await pay("ring-2");
    expect(await treasury("bricks")).toBe(1_250);

    await select(7, "prism_knights");
    await pay("ring-3");
    await pay("ring-3");
    expect(await treasury("crystal")).toBe(1_800);

    await select(7, "cache_hunters");
    await pay("ring-4");
    await pay("ring-4");
    expect(await gold()).toBe(18_000);
    // A second legendary ring is its own receipt.
    await pay("ring-5");
    expect(await gold()).toBe(36_000);

    // Not before the membership qualifies.
    await pool.query("UPDATE kingdom_memberships SET perk_qualified_at=$2 WHERE player_id=$1", ["squire", new Date(now.getTime() + 60_000)]);
    expect(await pay("ring-6")).toBeNull();
    expect(await gold()).toBe(36_000);
    const ledger = await pool.query<{ resource_type: string; count: string }>(
      `SELECT resource_type, count(*)::text AS count FROM kingdom_treasury_ledger
       WHERE source_type='kingdom_perk_payout' GROUP BY resource_type ORDER BY resource_type`
    );
    expect(ledger.rows).toEqual([{ resource_type: "bricks", count: "1" }, { resource_type: "crystal", count: "1" }]);
  });

  async function select(level: number, perkId: string): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_perk_selections (kingdom_id, perk_level, perk_id) VALUES ($1,$2,$3)
       ON CONFLICT (kingdom_id, perk_level) DO UPDATE SET perk_id=EXCLUDED.perk_id`,
      [kingdomId, level, perkId]
    );
  }

  async function treasury(resourceType: string): Promise<number> {
    const result = await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM kingdom_treasury_balances WHERE kingdom_id=$1 AND resource_type=$2 AND variant='default'",
      [kingdomId, resourceType]
    );
    return Number(result.rows[0]?.quantity ?? 0);
  }

  async function setTreasury(resourceType: string, quantity: number): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_treasury_balances (kingdom_id, resource_type, variant, quantity)
       VALUES ($1,$2,'default',$3)
       ON CONFLICT (kingdom_id, resource_type, variant) DO UPDATE SET quantity=EXCLUDED.quantity`,
      [kingdomId, resourceType, quantity]
    );
  }

  async function createPlayer(id: string): Promise<void> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$1,$1,'#38bdf8','NM',36,-106,36,-106,900,true,ST_SetSRID(ST_MakePoint(-106,36),4326))`,
      [id, accountId]
    );
  }

  async function createKingdom(leaderId: string, level: number, lifetimeXp = 0): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id,
                             level, lifetime_xp)
       VALUES ($1,$2,'Emberreach',$3,$3,$4,$5,$6)`,
      [id, `emberreach-${id.slice(0, 8)}`, leaderId, randomUUID(), level, lifetimeXp]
    );
    await addKingdomMember(id, leaderId, "leader");
    return id;
  }

  async function addKingdomMember(kingdom: string, playerId: string, role: "leader" | "member"): Promise<void> {
    await pool.query(
      `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
       VALUES (gen_random_uuid(),$1,$2,$3,'active',$4,$4)`,
      [kingdom, playerId, role, now]
    );
  }

  async function insertKingdomFlag(
    name: string,
    at: { lat: number; lon: number },
    claimRadiusM: number,
    kingdom = kingdomId,
    ownerId = "ruler"
  ): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, kingdom_id,
                          access_mode, kingdom_affiliated_at, original_owner_player_id, contributed_by_player_id)
       VALUES (gen_random_uuid(),$6,$1,$2,$3,$4,ST_SetSRID(ST_MakePoint($3,$2),4326),'kingdom',$5,
               'private',now(),$6,$6)
       RETURNING id::text`,
      [name, at.lat, at.lon, claimRadiusM, kingdom, ownerId]
    );
    return result.rows[0]!.id;
  }
});
