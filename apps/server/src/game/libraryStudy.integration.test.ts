import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { libraryFoliosForStudy } from "@ash-atlas/shared";
import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { LibraryStudyService } from "./libraryStudy.js";
import { WalletService } from "./wallet.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "1017_library_study.sql";
const HERE = { lat: 35, lon: -106 };
const FAR = { lat: 35.01, lon: -106 };

describeDatabase("Library study PostgreSQL integration", () => {
  const databaseName = `ash_atlas_stability_library_${randomUUID().replaceAll("-", "")}`;
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  let preceding = "";
  let databaseUrl = "";
  let admin: pg.Pool;
  let pool: pg.Pool;
  let clock = new Date("2026-10-03T12:00:00.000Z");
  let service: LibraryStudyService;
  const wallet = new WalletService();
  const accounts = new Map<string, string>();
  let cityId = "";
  const libraries = new Map<string, string>();
  let run = 0;
  let S = "";
  let O = "";
  let O2 = "";
  let PO = "";

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!parsed.pathname.includes("ash_atlas_stability")) throw new Error("Requires an ash_atlas_stability admin database");
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN; END IF; END $$`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 8 });
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-library-"));
    for (const name of await readdir(sourceMigrations)) {
      if (name.endsWith(".sql") && name.localeCompare(migration) < 0) await copyFile(path.join(sourceMigrations, name), path.join(preceding, name));
    }
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    // Populated upgrade: a city with an Oil Well and Quartz Hut, plus a weekly leaderboard row, exist before 1017.
    for (const id of ["owner", "owner2"]) await createPlayer(id);
    cityId = await createCity("owner");
    await addStructure("oil_well", "owner");
    await addStructure("quartz_hut", "owner2");
    await pool.query(
      `INSERT INTO weekly_leaderboard_events (source_type,source_id,player_id,category,value,occurred_at,week_start)
       VALUES ('flag_build','pre-1','owner','flags_built',1,now(),weekly_leaderboard_week_start(now()))`
    );
    await runMigrations(databaseUrl);
    service = new LibraryStudyService(pool, wallet, () => clock);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin?.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clock = new Date("2026-10-03T12:00:00.000Z");
    run += 1;
    S = `student${run}`; O = `libowner${run}`; O2 = `libowner2${run}`; PO = `poor${run}`;
    for (const id of [S, O, O2, PO]) await createPlayer(id);
    libraries.clear();
    libraries.set(O, await addStructure("library", O));
    libraries.set(O2, await addStructure("library", O2));
    await grant(S, 1000n);
    await grant(O, 1000n);
    await grant(PO, 10n);
  });

  it("migration keeps populated data, enforces library constraints, and a second run is a no-op", async () => {
    expect((await pool.query("SELECT count(*)::int AS n FROM city_structures WHERE structure_type IN ('oil_well','quartz_hut')")).rows[0].n).toBe(2);
    await expect(pool.query(
      `UPDATE city_structures SET owner_player_id=NULL WHERE structure_id=$1`, [libraries.get(O)]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(addStructure("library", O)).rejects.toMatchObject({ code: "23505" });
    const before = (await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n;
    await runMigrations(databaseUrl);
    expect((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(before);
  });

  it("studies: charges the fee, pays the owner cut, grants Folios, and replays exactly once", async () => {
    const first = await service.study(S, libraries.get(O)!, HERE, "req-1");
    expect(first.result).toMatchObject({ foliosGained: libraryFoliosForStudy(0), feeGold: "100", replayed: false });
    expect(first.library).toMatchObject({ canStudy: false, unavailableReason: "studied_here", studyCount: 1 });
    expect(await gold(S)).toBe("900");
    expect(await gold(O)).toBe("1050");
    expect(await folios(S)).toBe(libraryFoliosForStudy(0));

    const replay = await service.study(S, libraries.get(O)!, HERE, "req-1");
    expect(replay.result.replayed).toBe(true);
    expect(await gold(S)).toBe("900");
    expect(await gold(O)).toBe("1050");
    expect(await folios(S)).toBe(libraryFoliosForStudy(0));
    expect((await pool.query("SELECT count(*)::int AS n FROM library_studies WHERE player_id=$1", [S])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT category,value::int AS value FROM weekly_leaderboard_events WHERE source_type='library_study' AND player_id=$1", [S])).rows)
      .toEqual([{ category: "folios_studied", value: libraryFoliosForStudy(0) }]);
    expect((await pool.query(
      "SELECT player_id,delta_gold::int AS d,reason FROM wallet_events WHERE reason LIKE 'library_study%' AND (player_id=$1 OR player_id=$2) ORDER BY player_id",
      [S, O]
    )).rows).toEqual([
      { player_id: O, d: 50, reason: "library_study_owner_cut" },
      { player_id: S, d: -100, reason: "library_study_fee" }
    ]);
  });

  it("denies a second study at the same library even on a later day", async () => {
    await service.study(S, libraries.get(O)!, HERE, "req-1");
    clock = new Date("2026-10-04T12:00:00.000Z");
    await expect(service.study(S, libraries.get(O)!, HERE, "req-2"))
      .rejects.toMatchObject({ code: "LIBRARY_ALREADY_STUDIED" });
    expect(await gold(S)).toBe("900");
  });

  it("denies a second study the same day at another library, allows it the next day with higher yield", async () => {
    await service.study(S, libraries.get(O)!, HERE, "req-1");
    await expect(service.study(S, libraries.get(O2)!, HERE, "req-2"))
      .rejects.toMatchObject({ code: "LIBRARY_STUDIED_TODAY" });
    expect(await gold(S)).toBe("900");
    clock = new Date("2026-10-04T00:00:01.000Z");
    const next = await service.study(S, libraries.get(O2)!, HERE, "req-3");
    expect(next.result.foliosGained).toBe(libraryFoliosForStudy(1));
    expect(await folios(S)).toBe(libraryFoliosForStudy(0) + libraryFoliosForStudy(1));
  });

  it("pays the owner nothing at their own library but still charges and grants Folios", async () => {
    const own = await service.study(O, libraries.get(O)!, HERE, "req-own");
    expect(own.library.ownerCutGold).toBe("0");
    expect(await gold(O)).toBe("900");
    expect(await folios(O)).toBe(libraryFoliosForStudy(0));
  });

  it("denies insufficient gold, far away players and leaves no trace", async () => {
    await expect(service.study(PO, libraries.get(O)!, HERE, "req-poor"))
      .rejects.toMatchObject({ code: "INSUFFICIENT_GOLD" });
    await expect(service.study(S, libraries.get(O)!, FAR, "req-far"))
      .rejects.toMatchObject({ code: "LIBRARY_PROXIMITY_REQUIRED" });
    expect(await gold(PO)).toBe("10");
    expect(await gold(S)).toBe("1000");
    expect(await gold(O)).toBe("1000");
    expect((await pool.query("SELECT count(*)::int AS n FROM library_studies WHERE player_id=ANY($1)", [[PO, S]])).rows[0].n).toBe(0);
    expect(await folios(PO)).toBe(0);
    const snapshot = await service.open(PO, libraries.get(O)!, HERE);
    expect(snapshot).toMatchObject({ canStudy: false, unavailableReason: "insufficient_gold" });
  });

  it("concurrent duplicate requests apply once", async () => {
    const settled = await Promise.allSettled([
      service.study(S, libraries.get(O)!, HERE, "dup"),
      service.study(S, libraries.get(O)!, HERE, "dup"),
      service.study(S, libraries.get(O2)!, HERE, "other")
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM library_studies WHERE player_id='${S}'`)).rows[0].n).toBe(1);
    expect(await gold(S)).toBe("900");
  });

  async function gold(playerId: string): Promise<string> {
    return (await pool.query<{ g: string }>("SELECT gold_balance::text AS g FROM player_wallets WHERE player_id=$1", [playerId])).rows[0]?.g ?? "0";
  }
  async function folios(playerId: string): Promise<number> {
    return Number((await pool.query<{ p: string }>("SELECT folios::text AS p FROM player_library_folios WHERE player_id=$1", [playerId])).rows[0]?.p ?? 0);
  }
  async function grant(playerId: string, amount: bigint): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await wallet.creditForOperationInTransaction(client, {
        playerId, accountId: accounts.get(playerId)!, amount,
        operationKey: `grant:${playerId}:${randomUUID()}`, reason: "admin"
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
  async function addStructure(type: string, ownerId: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO city_structures (
         structure_id, city_id, structure_type, tier, owner_player_id, world_id,
         lat, lon, geom, footprint_geom, footprint_radius_m, state, build_operation_key, built_at
       ) VALUES (
         $1, $2, $3, 1, $4, 'global', 35, -106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint(-106,35),4326)::geography,10)::geometry,
         10, 'active', $5, clock_timestamp()
       )`,
      [id, cityId, type, ownerId, `lib-test-${id}`]
    );
    return id;
  }
});
