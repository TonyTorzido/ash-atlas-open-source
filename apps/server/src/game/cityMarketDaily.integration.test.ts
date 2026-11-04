import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { cityMarketDailyPackage } from "@ash-atlas/shared";
import { runMigrations } from "../db/migrate.js";
import { CityMarketDailyService } from "./cityMarketDaily.js";
import { CityTreasuryService } from "./cityTreasury.js";
import { PremiumWalletService } from "./premiumWallet.js";

const databaseUrl = process.env.LAND_BONUS_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("City Market daily package PostgreSQL integration", () => {
  let pool: pg.Pool;
  let clock = new Date("2026-10-02T12:00:00.000Z");
  let service: CityMarketDailyService;
  let cityId = "";
  const accounts = new Map<string, string>();

  beforeAll(async () => {
    const name = new URL(databaseUrl!).pathname.slice(1);
    if (!name.startsWith("ash_atlas_stability")) {
      throw new Error("LAND_BONUS_TEST_DATABASE_URL must target an ash_atlas_stability* database");
    }
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 8 });
    service = new CityMarketDailyService(pool, new CityTreasuryService(pool), () => clock);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE cities, players, accounts CASCADE");
    clock = new Date("2026-10-02T12:00:00.000Z");
    for (const id of ["mayor", "buyer", "stranger", "poor"]) await createPlayer(id);
    cityId = await createCity("mayor");
    await addMember(cityId, "buyer");
    await addMember(cityId, "poor");
    await addMarket(cityId, 1);
    await grantGlimmer("buyer", 20n);
    await grantGlimmer("poor", 2n);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("sells one package a day: allowed once, denied the same day, allowed the next, and replays exactly once", async () => {
    const first = await service.purchase("buyer", cityId, "req-1");
    expect(first).toMatchObject({ replayed: false, treasuryBalance: "110" });
    expect(first.marketDaily).toMatchObject({ tier: 1, cityCoins: 110, glimmer: 4, purchasedToday: true });
    expect(await glimmer("buyer")).toBe("16");

    // Same request again: replayed, nothing moves.
    const replay = await service.purchase("buyer", cityId, "req-1");
    expect(replay.replayed).toBe(true);
    expect(await glimmer("buyer")).toBe("16");
    expect(await treasury()).toBe("110");

    // A fresh request the same UTC day is denied and charges nothing.
    await expect(service.purchase("buyer", cityId, "req-2"))
      .rejects.toMatchObject({ code: "CITY_MARKET_DAILY_ALREADY_PURCHASED" });
    expect(await glimmer("buyer")).toBe("16");
    expect(await treasury()).toBe("110");

    // Concurrent duplicates on the next UTC day apply exactly once.
    clock = new Date("2026-10-03T00:00:01.000Z");
    const settled = await Promise.allSettled([
      service.purchase("buyer", cityId, "req-3"),
      service.purchase("buyer", cityId, "req-3"),
      service.purchase("buyer", cityId, "req-4")
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(await glimmer("buyer")).toBe("12");
    expect(await treasury()).toBe("220");

    expect(await rows("SELECT delta::int AS d, reason FROM premium_wallet_events WHERE reason='spend'"))
      .toEqual([{ d: -4, reason: "spend" }, { d: -4, reason: "spend" }]);
    expect(await rows("SELECT delta::int AS d, entry_type FROM city_coin_ledger ORDER BY entry_id"))
      .toEqual([
        { d: 110, entry_type: "market_daily_package" },
        { d: 110, entry_type: "market_daily_package" }
      ]);
    await expect(pool.query("DELETE FROM city_market_daily_purchases")).rejects.toMatchObject({ code: "P0001" });
  });

  it("prices by Market tier, needs Glimmer and membership, and a refused purchase leaves no trace", async () => {
    // The database only allows tier-1 Markets today; the package table already covers tiers 2 and 3.
    expect([1, 2, 3].map((tier) => cityMarketDailyPackage(tier)))
      .toEqual([
        { tier: 1, cityCoins: 110, glimmer: 4 },
        { tier: 2, cityCoins: 215, glimmer: 7 },
        { tier: 3, cityCoins: 320, glimmer: 9 }
      ]);
    const snapshot = await service.snapshot(cityId, "buyer");
    expect(snapshot).toMatchObject({ tier: 1, cityCoins: 110, glimmer: 4, purchasedToday: false });

    await expect(service.purchase("stranger", cityId, "req-s"))
      .rejects.toMatchObject({ code: "CITY_MARKET_DAILY_DENIED" });
    await expect(service.purchase("poor", cityId, "req-poor"))
      .rejects.toMatchObject({ code: "CITY_MARKET_DAILY_INSUFFICIENT_GLIMMER" });
    expect(await rows("SELECT 1 FROM city_market_daily_purchases")).toHaveLength(0);
    expect(await glimmer("poor")).toBe("2");
    expect(await treasury()).toBe("0");

    const bought = await service.purchase("buyer", cityId, "req-rich");
    expect(bought.marketDaily).toMatchObject({ cityCoins: 110, glimmer: 4 });
    expect(await glimmer("buyer")).toBe("16");
    expect(await treasury()).toBe("110");
  });

  it("prices by the City Market level: 2 sells 215/7, 7 sells 320/9, a Market mid-upgrade sells its previous level", async () => {
    const setMarket = (sql: string) =>
      pool.query(`UPDATE city_structures SET ${sql} WHERE city_id=$1 AND structure_type='market'`, [cityId]);
    await setMarket("tier=2");
    expect(await service.snapshot(cityId, "buyer"))
      .toMatchObject({ marketLevel: 2, tier: 2, cityCoins: 215, glimmer: 7 });
    await setMarket("tier=7");
    expect(await service.snapshot(cityId, "buyer"))
      .toMatchObject({ marketLevel: 7, tier: 3, cityCoins: 320, glimmer: 9 });
    await setMarket(
      "tier=3, state='constructing', construction_started_at=now(), construction_completes_at=now() + interval '30 seconds'"
    );
    const bought = await service.purchase("buyer", cityId, "req-level");
    expect(bought.marketDaily).toMatchObject({ marketLevel: 2, tier: 2, cityCoins: 215, glimmer: 7, purchasedToday: true });
    expect(await treasury()).toBe("215");
  });

  async function rows(sql: string): Promise<Record<string, unknown>[]> {
    return (await pool.query(sql)).rows;
  }
  async function treasury(): Promise<string> {
    return (await pool.query<{ balance: string }>(
      "SELECT balance::text FROM city_treasuries WHERE city_id=$1", [cityId]
    )).rows[0]?.balance ?? "0";
  }
  async function glimmer(playerId: string): Promise<string> {
    return (await pool.query<{ balance: string }>(
      "SELECT balance::text FROM premium_wallets WHERE account_id=$1 AND currency='glimmer'",
      [accounts.get(playerId)]
    )).rows[0]?.balance ?? "0";
  }
  async function grantGlimmer(playerId: string, amount: bigint): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await new PremiumWalletService().creditForOperationInTransaction(client, {
        accountId: accounts.get(playerId)!, currency: "glimmer", amount,
        operationKey: `test-grant:${playerId}`, reason: "admin"
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }
  async function createPlayer(id: string): Promise<void> {
    const accountId = randomUUID();
    accounts.set(id, accountId);
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
                 NULL,42,-105,ST_SetSRID(ST_MakePoint(-105,42),4326),500,$3)`,
      [id, `test:${id}`, mayorId, randomUUID()]
    );
    return id;
  }
  async function addMember(city: string, playerId: string): Promise<void> {
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
      [city, playerId, `daily-house-${city}-${playerId}`]
    );
  }
  async function addMarket(city: string, tier: number): Promise<void> {
    await pool.query(
      `INSERT INTO city_structures (
         structure_id, city_id, structure_type, tier, owner_player_id, world_id,
         lat, lon, geom, footprint_geom, footprint_radius_m, state, build_operation_key, built_at
       ) VALUES (
         gen_random_uuid(), $1, 'market', $2, NULL, 'global', 42.01, -105.01,
         ST_SetSRID(ST_MakePoint(-105.01,42.01),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint(-105.01,42.01),4326)::geography,10)::geometry,
         10, 'active', $3, clock_timestamp()
       )`,
      [city, tier, `daily-market-${city}`]
    );
  }
});
