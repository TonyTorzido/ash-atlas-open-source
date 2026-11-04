import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import { ClassService } from "./classes/classService.js";
import type { CombatDefeatSettlementCandidate } from "./combat/combatEngine.js";
import { MOB_DEFINITIONS } from "./combat/mobDefinitions.js";
import { CombatRewardSettlementService } from "./combat/rewardSettlement.js";
import { InventoryService } from "./inventory.js";
import { landOwnerBonusGold } from "./landOwnerBonus.js";
import { MasteryService } from "./masteries.js";
import { ProgressionService } from "./progression.js";
import { WalletService } from "./wallet.js";

const databaseUrl = process.env.LAND_BONUS_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

type Site = { lat: number; lon: number };
const PERSONAL: Site = { lat: 41, lon: -105 };
const OWN_LAND: Site = { lat: 41.5, lon: -105 };
const CITY: Site = { lat: 42, lon: -105 };
const KINGDOM: Site = { lat: 43, lon: -105 };

describeDatabase("land owner hunting bonus PostgreSQL integration", () => {
  let pool: pg.Pool;
  let progression: ProgressionService;
  let originalGold: number;
  let counter = 0;

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("LAND_BONUS_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    progression = new ProgressionService(pool);
    originalGold = MOB_DEFINITIONS.wolf.rewards.gold;
    MOB_DEFINITIONS.wolf.rewards.gold = 400;
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE kingdoms, cities, players, accounts CASCADE");
    for (const id of ["hunter", "land-owner", "mayor", "ruler", "city-member"]) await createPlayer(id);
  });

  afterAll(async () => {
    MOB_DEFINITIONS.wolf.rewards.gold = originalGold;
    await pool?.end();
  });

  it("pays a personal flag's owner 4% of the kill, leaves the hunter's reward unchanged, and never pays twice", async () => {
    await insertPersonalFlag("land-owner", PERSONAL);
    const settlement = candidate(PERSONAL);
    const settlements = service();
    await settlements.accept(settlement);
    await settlements.flush();

    const hunterGold = BigInt((await walletGold("hunter")) ?? "0");
    expect(hunterGold).toBeGreaterThan(0n);
    // The hunter holds exactly the kill's gold: the bonus came from nowhere else.
    const result = await pool.query<{ result: { mobReward?: { gold: number } } }>(
      "SELECT result FROM combat_reward_settlements WHERE settlement_key=$1",
      [settlement.settlementKey]
    );
    expect(BigInt(result.rows[0]!.result.mobReward!.gold)).toBe(hunterGold);
    const bonus = landOwnerBonusGold(Number(hunterGold), settlement.settlementKey);
    expect(bonus).toBeGreaterThan(0);
    expect(bonus).toBeGreaterThanOrEqual(Math.floor(Number(hunterGold) * 0.04));
    expect(bonus).toBeLessThanOrEqual(Math.ceil(Number(hunterGold) * 0.04));
    expect(await walletGold("land-owner")).toBe(String(bonus));
    expect(await rows("SELECT delta_gold::text AS d, reason FROM wallet_events WHERE player_id='land-owner'")).toEqual([
      { d: String(bonus), reason: "land_owner_hunting_bonus_reward" }
    ]);
    expect(await rows("SELECT payee_kind, paid_gold::int AS paid FROM land_owner_bonus_payouts")).toEqual([
      { payee_kind: "player", paid: bonus }
    ]);

    // Replay: the settlement is re-run from scratch; nothing is paid again.
    await pool.query(
      `UPDATE combat_reward_settlements
       SET status='failed', result=NULL, completed_at=NULL, next_retry_at=now()
       WHERE settlement_key=$1`,
      [settlement.settlementKey]
    );
    await expect(service().recoverIncomplete()).resolves.toBe(1);
    expect(await walletGold("land-owner")).toBe(String(bonus));
    expect(await walletGold("hunter")).toBe(hunterGold.toString());
    expect(await rows("SELECT 1 FROM wallet_events WHERE player_id='land-owner'")).toHaveLength(1);
    expect(await rows("SELECT 1 FROM land_owner_bonus_payouts")).toHaveLength(1);
  });

  it("pays nothing for a hunter's own land, and nothing for settlements queued before the policy existed", async () => {
    await insertPersonalFlag("hunter", OWN_LAND);
    const own = candidate(OWN_LAND);
    const settlements = service();
    await settlements.accept(own);
    await settlements.flush();
    expect(Number(await walletGold("hunter"))).toBeGreaterThan(0);
    expect(await rows("SELECT 1 FROM land_owner_bonus_payouts")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM wallet_events WHERE reason='land_owner_hunting_bonus_reward'")).toHaveLength(0);

    await insertPersonalFlag("land-owner", PERSONAL);
    const queued = candidate(PERSONAL);
    await settlements.accept(queued);
    await pool.query(
      `UPDATE combat_reward_settlements
       SET candidate = candidate - 'landBonusPolicyVersion'
       WHERE settlement_key=$1`,
      [queued.settlementKey]
    );
    await settlements.flush();
    expect(await rows("SELECT 1 FROM land_owner_bonus_payouts")).toHaveLength(0);
    expect(await walletGold("land-owner")).toBeNull();
  });

  it("pays a city's Gold Reserve for an outsider's kill, but not for a city member's", async () => {
    const cityId = await createCity("mayor");
    await insertOrganizationFlag("city", cityId, "mayor", CITY);
    await addCityMember(cityId, "city-member");
    const settlements = service();

    const memberKill = candidate(CITY, "city-member");
    await settlements.accept(memberKill);
    await settlements.flush();
    expect(await rows("SELECT 1 FROM city_gold_ledger")).toHaveLength(0);

    const kill = candidate(CITY);
    await settlements.accept(kill);
    await settlements.flush();
    const hunterGold = Number(await walletGold("hunter"));
    const bonus = landOwnerBonusGold(hunterGold, kill.settlementKey);
    expect(await rows(
      "SELECT entry_type, delta::int AS delta, balance_after::int AS balance FROM city_gold_ledger"
    )).toEqual([{ entry_type: "land_bonus", delta: bonus, balance: bonus }]);
    expect(await rows(
      "SELECT balance::int AS balance, lifetime_land_bonus::int AS minted FROM city_gold_reserves WHERE city_id=$1",
      [cityId]
    )).toEqual([{ balance: bonus, minted: bonus }]);
    // Economy observatory sees a minted gold SOURCE for the reserve.
    expect(await rows(
      "SELECT event_kind, quantity::int AS q FROM economy_events WHERE source_system='city_gold_ledger'"
    )).toEqual([{ event_kind: "SOURCE", q: bonus }]);
    // The mayor's wallet is untouched: the reserve is the payee.
    expect(await walletGold("mayor")).toBeNull();

    await pool.query(
      `UPDATE combat_reward_settlements
       SET status='failed', result=NULL, completed_at=NULL, next_retry_at=now()
       WHERE settlement_key=$1`,
      [kill.settlementKey]
    );
    await service().recoverIncomplete();
    expect(await rows("SELECT 1 FROM city_gold_ledger")).toHaveLength(1);
    expect(await rows("SELECT balance::int AS balance FROM city_gold_reserves WHERE city_id=$1", [cityId]))
      .toEqual([{ balance: bonus }]);
  });

  it("pays a kingdom's Gold Reserve for an outsider's kill, but not for a member's", async () => {
    const kingdomId = await createKingdom("ruler");
    await insertKingdomFlag(kingdomId, "ruler", KINGDOM);
    const settlements = service();

    const kill = candidate(KINGDOM);
    await settlements.accept(kill);
    await settlements.flush();
    const bonus = landOwnerBonusGold(Number(await walletGold("hunter")), kill.settlementKey);
    expect(await rows(
      "SELECT entry_type, delta::int AS delta FROM kingdom_gold_ledger WHERE kingdom_id=$1",
      [kingdomId]
    )).toEqual([{ entry_type: "land_bonus", delta: bonus }]);
    expect(await rows(
      "SELECT balance::int AS balance, lifetime_earned::int AS earned FROM kingdom_gold_reserves WHERE kingdom_id=$1",
      [kingdomId]
    )).toEqual([{ balance: bonus, earned: bonus }]);
    await expect(pool.query("DELETE FROM kingdom_gold_ledger")).rejects.toMatchObject({ code: "P0001" });

    await pool.query(
      `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
       VALUES (gen_random_uuid(),$1,'hunter','member','active',now(),now())`,
      [kingdomId]
    );
    const memberKill = candidate(KINGDOM);
    await settlements.accept(memberKill);
    await settlements.flush();
    expect(await rows("SELECT 1 FROM kingdom_gold_ledger")).toHaveLength(1);
  });

  function service(): CombatRewardSettlementService {
    const masteries = new MasteryService(pool);
    return new CombatRewardSettlementService(
      pool,
      progression,
      createLogger("test"),
      undefined,
      new ClassService(pool, masteries),
      new InventoryService(pool),
      masteries,
      new WalletService()
    );
  }

  function candidate(site: Site, hunter = "hunter"): CombatDefeatSettlementCandidate {
    const index = ++counter;
    const key = `land-bonus-${randomUUID()}:mob:${index}`;
    return {
      settlementKey: `${key}:defeat:1`,
      defeatedEntityId: key,
      defeatGeneration: 1,
      eligibleParticipantIds: [hunter],
      contributions: [{ entityId: hunter, damage: 100 }],
      defeatingPlayerId: hunter,
      serverTick: index + 1,
      mobArchetype: "wolf",
      itemRewardPolicyVersion: 2,
      lootLocation: {
        regionCode: "test-land-bonus",
        zoneId: "test-zone",
        position: { lat: site.lat + 0.0005, lon: site.lon + 0.0005 }
      }
    };
  }

  async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return (await pool.query(sql, params)).rows;
  }

  async function walletGold(playerId: string): Promise<string | null> {
    const result = await pool.query<{ gold: string }>(
      "SELECT gold_balance::text AS gold FROM player_wallets WHERE player_id=$1",
      [playerId]
    );
    return result.rows[0]?.gold ?? null;
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

  async function insertPersonalFlag(ownerId: string, site: Site): Promise<void> {
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, access_mode)
       VALUES (gen_random_uuid(),$1,'Homestead',$2,$3,500,ST_SetSRID(ST_MakePoint($3,$2),4326),'personal','public')`,
      [ownerId, site.lat, site.lon]
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
                 NULL,42,-105,ST_SetSRID(ST_MakePoint(-105,42),4326),500,$3)`,
      [id, `test:${id}`, mayorId, randomUUID()]
    );
    return id;
  }

  async function addCityMember(city: string, playerId: string): Promise<void> {
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
       SELECT $1, $2, 'global', 'member', structure_id, clock_timestamp() FROM house`,
      [city, playerId, `land-house-${city}-${playerId}`]
    );
  }

  async function insertOrganizationFlag(
    _type: "city",
    cityId: string,
    ownerId: string,
    site: Site
  ): Promise<void> {
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, city_id,
                          access_mode, city_affiliated_at)
       VALUES (gen_random_uuid(),$1,'City flag',$2,$3,500,ST_SetSRID(ST_MakePoint($3,$2),4326),'city',$4,
               'public',now())`,
      [ownerId, site.lat, site.lon, cityId]
    );
  }

  async function createKingdom(leaderId: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id)
       VALUES ($1,$2,'Emberreach',$3,$3,$4)`,
      [id, `emberreach-${id.slice(0, 8)}`, leaderId, randomUUID()]
    );
    await pool.query(
      `INSERT INTO kingdom_memberships (id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at)
       VALUES (gen_random_uuid(),$1,$2,'leader','active',now(),now())`,
      [id, leaderId]
    );
    return id;
  }

  async function insertKingdomFlag(kingdomId: string, ownerId: string, site: Site): Promise<void> {
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, control_type, kingdom_id,
                          access_mode, kingdom_affiliated_at, original_owner_player_id, contributed_by_player_id)
       VALUES (gen_random_uuid(),$1,'Kingdom flag',$2,$3,500,ST_SetSRID(ST_MakePoint($3,$2),4326),'kingdom',$4,
               'private',now(),$1,$1)`,
      [ownerId, site.lat, site.lon, kingdomId]
    );
  }
});
