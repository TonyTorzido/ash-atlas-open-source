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
const TARGET_MIGRATION = "0708_city_founder_mayor_claim.sql";

type CityCase =
  | "provisional_future"
  | "provisional_expired"
  | "constructing_automatic"
  | "confirmed_automatic"
  | "confirmed_explicit"
  | "relinquished";

describeDatabase("city founder Mayor claim repair migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_city_mayor_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-city-mayor-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    for (const [index, cityCase] of ([
      "provisional_future",
      "provisional_expired",
      "constructing_automatic",
      "confirmed_automatic",
      "confirmed_explicit",
      "relinquished"
    ] as const).entries()) {
      await seedCityCase(pool, `player-${index}`, cityCase);
    }
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
  }, 30_000);

  it("repairs only automatic founder ownership, preserves explicit claims, and reruns empty", async () => {
    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);

    const cities = await pool.query<{
      name: CityCase;
      founder_player_id: string;
      mayor_player_id: string | null;
      confirmed: boolean;
      claim_deadline_live: boolean;
    }>(
      `SELECT name,founder_player_id,mayor_player_id,
              mayor_confirmed_at IS NOT NULL AS confirmed,
              COALESCE(mayor_house_deadline > clock_timestamp(),false)
                AS claim_deadline_live
       FROM cities
       ORDER BY name`
    );
    expect(cities.rows).toEqual([
      {
        name: "confirmed_automatic",
        founder_player_id: "player-3",
        mayor_player_id: null,
        confirmed: false,
        claim_deadline_live: true
      },
      {
        name: "confirmed_explicit",
        founder_player_id: "player-4",
        mayor_player_id: "player-4",
        confirmed: true,
        claim_deadline_live: false
      },
      {
        name: "constructing_automatic",
        founder_player_id: "player-2",
        mayor_player_id: null,
        confirmed: false,
        claim_deadline_live: true
      },
      {
        name: "provisional_expired",
        founder_player_id: "player-1",
        mayor_player_id: null,
        confirmed: false,
        claim_deadline_live: false
      },
      {
        name: "provisional_future",
        founder_player_id: "player-0",
        mayor_player_id: null,
        confirmed: false,
        claim_deadline_live: true
      },
      {
        name: "relinquished",
        founder_player_id: "player-5",
        mayor_player_id: null,
        confirmed: false,
        claim_deadline_live: false
      }
    ]);

    await expect(pool.query(
      `SELECT city.name,structure.structure_type,structure.state,
              membership.role
       FROM city_structures structure
       JOIN cities city ON city.id=structure.city_id
       LEFT JOIN city_memberships membership
         ON membership.house_structure_id=structure.structure_id
        AND membership.left_at IS NULL
       ORDER BY city.name`
    )).resolves.toMatchObject({
      rows: [
        {
          name: "confirmed_automatic",
          structure_type: "city_house",
          state: "active",
          role: "member"
        },
        {
          name: "confirmed_explicit",
          structure_type: "mayor_house",
          state: "active",
          role: "mayor"
        },
        {
          name: "constructing_automatic",
          structure_type: "city_house",
          state: "constructing",
          role: null
        },
        {
          name: "relinquished",
          structure_type: "city_house",
          state: "active",
          role: "member"
        }
      ]
    });
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM city_structure_operations operation
       JOIN cities city ON city.id=operation.city_id
       WHERE city.name='confirmed_explicit' AND operation.action='claim_mayor'`
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  }, 90_000);
});

async function seedCityCase(
  pool: pg.Pool,
  playerId: string,
  cityCase: CityCase
): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id,username,username_normalized,display_color,region_code,
       lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
     ) VALUES (
       $1,$1,$1,'#38bdf8','NM',35,-106,35,-106,1250,false,
       ST_SetSRID(ST_MakePoint(-106,35),4326)
     )`,
    [playerId]
  );
  const cityId = randomUUID();
  const flagId = randomUUID();
  const structureId = randomUUID();
  const settlementId = `settlement-${cityId}`;
  const caseIndex = Number(playerId.slice("player-".length));
  const lat = 30 + caseIndex * 2;
  const lon = -100;
  const confirmed =
    cityCase === "confirmed_automatic" || cityCase === "confirmed_explicit";
  const provisional =
    cityCase === "provisional_future" ||
    cityCase === "provisional_expired" ||
    cityCase === "constructing_automatic";
  await pool.query(
    `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
     VALUES ($1,$2,$3,$4,$5,1000,ST_SetSRID(ST_MakePoint($5,$4),4326))`,
    [flagId, playerId, `${cityCase} Seat`, lat, lon]
  );
  await pool.query(
    `INSERT INTO cities (
       id,world_id,canonical_municipality_id,world_settlement_id,
       world_settlement_source,world_source_settlement_id,name,country_code,
       region_code,founder_player_id,mayor_player_id,founding_request_id,
       seat_flag_id,hall_lat,hall_lon,hall_geom,founding_annex_radius_m,
       created_at,mayor_house_deadline,mayor_confirmed_at
     ) VALUES (
       $1,'main',$2,$2,'test',$2,$3,'US','US-NM',$4,$5,$6,$7,$10,$11,
       ST_SetSRID(ST_MakePoint($11,$10),4326),1000,
       clock_timestamp()-interval '5 minutes',
       CASE
         WHEN $3='provisional_expired' THEN clock_timestamp()-interval '1 minute'
         WHEN $8::boolean THEN clock_timestamp()+interval '10 minutes'
         ELSE NULL
       END,
       CASE WHEN $9::boolean THEN clock_timestamp() ELSE NULL END
     )`,
    [
      cityId,
      settlementId,
      cityCase,
      playerId,
      confirmed || provisional ? playerId : null,
      `found-${cityCase}`,
      flagId,
      provisional,
      confirmed,
      lat,
      lon
    ]
  );
  await pool.query(
    `UPDATE flags
     SET control_type='city_seat',city_id=$2,city_affiliated_at=clock_timestamp(),
         city_affiliated_by_player_id=$3,original_owner_player_id=$3,
         contributed_by_player_id=$3,original_personal_color='#38bdf8'
     WHERE id=$1`,
    [flagId, cityId, playerId]
  );

  if (
    cityCase === "provisional_future" ||
    cityCase === "provisional_expired"
  ) {
    return;
  }
  const constructing = cityCase === "constructing_automatic";
  const structureType = cityCase === "relinquished" ? "city_house" : "mayor_house";
  const buildOperationKey = `city-structure:${playerId}:build`;
  await pool.query(
    `INSERT INTO city_structures (
       structure_id,city_id,structure_type,tier,owner_player_id,world_id,
       region_code,lat,lon,geom,footprint_geom,footprint_radius_m,
       state,build_operation_key,built_at,construction_started_at,
       construction_completes_at
     ) VALUES (
       $1,$2,$3,1,$4,'main','US-NM',$7,$8,
       ST_SetSRID(ST_MakePoint($8,$7),4326),
       ST_Buffer(ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,10)::geometry,
       10,$5,$6,
       CASE WHEN $5='active' THEN clock_timestamp()-interval '1 minute' ELSE NULL END,
       CASE WHEN $5='constructing' THEN clock_timestamp()-interval '10 seconds' ELSE NULL END,
       CASE WHEN $5='constructing' THEN clock_timestamp()+interval '50 seconds' ELSE NULL END
     )`,
    [
      structureId,
      cityId,
      structureType,
      playerId,
      constructing ? "constructing" : "active",
      buildOperationKey,
      lat + 0.004,
      lon
    ]
  );
  await pool.query(
    `INSERT INTO city_structure_operations (
       operation_key,actor_player_id,request_id,action,city_id,structure_id,
       intent,result,completed_at
     ) VALUES (
       $1,$2,'build','build_house',$3,$4,'{}'::jsonb,
       CASE WHEN $5::boolean THEN NULL ELSE '{}'::jsonb END,
       CASE WHEN $5::boolean THEN NULL ELSE clock_timestamp() END
     )`,
    [buildOperationKey, playerId, cityId, structureId, constructing]
  );
  await pool.query(
    `INSERT INTO city_structure_events (
       operation_key,city_id,structure_id,actor_player_id,event_type,details
     ) VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`,
    [buildOperationKey, cityId, structureId, playerId, constructing ? "built" : "activated"]
  );
  if (!constructing) {
    await pool.query(
      `INSERT INTO city_memberships (
         city_id,player_id,world_id,role,house_structure_id,joined_at
       ) VALUES ($1,$2,'main',$3,$4,clock_timestamp()-interval '1 minute')`,
      [
        cityId,
        playerId,
        cityCase === "relinquished" ? "member" : "mayor",
        structureId
      ]
    );
  }
  if (cityCase === "confirmed_explicit") {
    const claimOperationKey = `city-structure:${playerId}:claim`;
    await pool.query(
      `INSERT INTO city_structure_operations (
         operation_key,actor_player_id,request_id,action,city_id,structure_id,
         intent,result,completed_at
       ) VALUES (
         $1,$2,'claim','claim_mayor',$3,$4,'{}'::jsonb,'{}'::jsonb,
         clock_timestamp()
       )`,
      [claimOperationKey, playerId, cityId, structureId]
    );
    await pool.query(
      `INSERT INTO city_structure_events (
         operation_key,city_id,structure_id,actor_player_id,event_type,details
       ) VALUES (
         $1,$2,$3,$4,'promoted_to_mayor_house','{}'::jsonb
       )`,
      [claimOperationKey, cityId, structureId, playerId]
    );
  }
}

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("City Mayor migration tests require a local stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
