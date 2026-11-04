import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const FIRST_MIGRATION = "0935_land_owner_hunting_bonus.sql";
const SECOND_MIGRATION = "0936_city_market_daily_package.sql";

describeDatabase("land owner bonus and City Market daily migrations", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_land_bonus_migration_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let preceding = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability") && !/^\/postgres$/u.test(parsed.pathname)) {
      throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must be a disposable server's admin database");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-land-bonus-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < FIRST_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(preceding, name));
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  });

  it("upgrades a populated database, keeps its rows, then reruns empty", async () => {
    const accountId = randomUUID();
    const cityId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ('mayor',$1,'mayor','mayor','#38bdf8','NM',35,-106,35,-106,900,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [accountId]
    );
    await pool.query(
      `INSERT INTO cities (
         id, world_id, canonical_municipality_id, world_settlement_id, world_settlement_source,
         world_source_settlement_id, name, country_code, region_code, founder_player_id,
         founding_request_id, construction_phase, construction_completed_at, jumpable,
         seat_flag_id, hall_lat, hall_lon, hall_geom, founding_annex_radius_m, mayor_player_id
       ) VALUES ($1,'global',$2,$2,'overture',$2,'Ashford','US','US-NM','mayor',$3,'complete',now(),true,
                 NULL,42,-105,ST_SetSRID(ST_MakePoint(-105,42),4326),500,'mayor')`,
      [cityId, `test:${cityId}`, randomUUID()]
    );
    await pool.query(
      `INSERT INTO city_gold_reserves (city_id, balance, lifetime_donated, lifetime_spent)
       VALUES ($1, 700, 1000, 300)
       ON CONFLICT (city_id) DO UPDATE SET balance=700, lifetime_donated=1000, lifetime_spent=300`,
      [cityId]
    );
    await pool.query("INSERT INTO city_treasuries (city_id, balance, lifetime_earned) VALUES ($1,50,50) ON CONFLICT DO NOTHING", [cityId]);
    await pool.query(
      `INSERT INTO city_coin_ledger (operation_key, city_id, player_id, entry_type, delta, balance_after, source_type, source_id)
       VALUES ('old-coin',$1,'mayor','combat_contribution',50,50,'combat_settlement','old')`,
      [cityId]
    );

    const applied = await runMigrations(databaseUrl);
    expect(applied).toEqual(expect.arrayContaining([FIRST_MIGRATION, SECOND_MIGRATION]));
    expect((await pool.query("SELECT balance::int AS b, lifetime_donated::int AS d, lifetime_land_bonus::int AS m FROM city_gold_reserves WHERE city_id=$1", [cityId])).rows)
      .toEqual([{ b: 700, d: 1000, m: 0 }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM city_coin_ledger")).rows).toEqual([{ n: 1 }]);
    for (const table of ["kingdom_gold_reserves", "kingdom_gold_ledger", "land_owner_bonus_payouts", "city_market_daily_purchases"]) {
      await expect(pool.query(`SELECT count(*) FROM ${table}`)).resolves.toBeDefined();
    }
    // The widened constraints accept the new entry types and still reject unknown ones.
    await pool.query(
      `INSERT INTO city_coin_ledger (operation_key, city_id, player_id, entry_type, delta, balance_after, source_type, source_id)
       VALUES ('daily-coin',$1,'mayor','market_daily_package',100,150,'market_daily_package','market')`,
      [cityId]
    );
    await expect(pool.query(
      `INSERT INTO city_coin_ledger (operation_key, city_id, player_id, entry_type, delta, balance_after, source_type, source_id)
       VALUES ('bad-coin',$1,'mayor','mystery',1,1,'x','x')`,
      [cityId]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 240_000);
});
