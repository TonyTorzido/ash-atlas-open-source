import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("city house authority reset migration", () => {
  const databaseName = `ash_atlas_stability_city_reset_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = path.resolve(process.cwd(), "../../db/migrations");
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-city-reset-"));
    for (const name of (await readdir(migrations)).filter((name) =>
      name.endsWith(".sql") && name < "0696_city_houses_facilities.sql"
    )) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedLegacyCities(pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("ends every active founder, mayor, and ordinary membership without erasing history", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrations }))
      .resolves.toContain("0696_city_houses_facilities.sql");
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrations }))
      .resolves.toEqual([]);

    const cities = await pool.query<{
      name: string;
      founder_player_id: string;
      mayor_player_id: string | null;
      mayor_house_deadline: Date | null;
    }>(
      `SELECT name,founder_player_id,mayor_player_id,mayor_house_deadline
       FROM cities ORDER BY name`
    );
    expect(cities.rows).toEqual([
      {
        name: "Legacy Alpha",
        founder_player_id: "legacy-founder-a",
        mayor_player_id: null,
        mayor_house_deadline: null
      },
      {
        name: "Legacy Beta",
        founder_player_id: "legacy-founder-b",
        mayor_player_id: null,
        mayor_house_deadline: null
      }
    ]);

    const memberships = await pool.query<{
      player_id: string;
      role: string;
      left_at: Date | null;
      ended_reason: string | null;
    }>(
      `SELECT player_id,role,left_at,ended_reason
       FROM city_memberships ORDER BY player_id`
    );
    expect(memberships.rows).toEqual([
      {
        player_id: "legacy-founder-a",
        role: "founder",
        left_at: expect.any(Date),
        ended_reason: "city_house_authority_reset"
      },
      {
        player_id: "legacy-founder-b",
        role: "founder",
        left_at: expect.any(Date),
        ended_reason: "city_house_authority_reset"
      },
      {
        player_id: "legacy-left",
        role: "member",
        left_at: new Date("2026-01-01T00:00:00.000Z"),
        ended_reason: null
      },
      {
        player_id: "legacy-mayor",
        role: "member",
        left_at: expect.any(Date),
        ended_reason: "city_house_authority_reset"
      },
      {
        player_id: "legacy-member",
        role: "member",
        left_at: expect.any(Date),
        ended_reason: "city_house_authority_reset"
      }
    ]);
  });
});

async function seedLegacyCities(pool: pg.Pool): Promise<void> {
  const accountIds = Array.from({ length: 5 }, () => randomUUID());
  const players = [
    "legacy-founder-a",
    "legacy-member",
    "legacy-mayor",
    "legacy-founder-b",
    "legacy-left"
  ];
  for (const [index, playerId] of players.entries()) {
    await pool.query(
      `INSERT INTO accounts (id,status,trust_tier)
       VALUES ($1,'active','standard')`,
      [accountIds[index]]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES (
         $1,$2,$1,$1,'#38bdf8','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326)
       )`,
      [playerId, accountIds[index]]
    );
  }

  const alpha = randomUUID();
  const beta = randomUUID();
  const alphaFlag = randomUUID();
  const betaFlag = randomUUID();
  await pool.query(
    `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
     VALUES
       ($1,'legacy-founder-a','Alpha Seat',35,-106,1000,
        ST_SetSRID(ST_MakePoint(-106,35),4326)),
       ($2,'legacy-founder-b','Beta Seat',36,-107,1000,
        ST_SetSRID(ST_MakePoint(-107,36),4326))`,
    [alphaFlag, betaFlag]
  );
  await pool.query(
    `INSERT INTO cities (
       id,world_id,canonical_municipality_id,
       world_settlement_id,world_settlement_source,world_source_settlement_id,
       name,country_code,founder_player_id,mayor_player_id,founding_request_id,
       seat_flag_id,hall_lat,hall_lon,hall_geom,founding_annex_radius_m
     ) VALUES
       ($1,'main',$3,$3,'test',$3,'Legacy Alpha','US','legacy-founder-a','legacy-mayor',
        'found-alpha',$5,35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326),750),
       ($2,'main',$4,$4,'test',$4,'Legacy Beta','US','legacy-founder-b','legacy-founder-b',
        'found-beta',$6,36,-107,ST_SetSRID(ST_MakePoint(-107,36),4326),750)`,
    [alpha, beta, `settlement-${alpha}`, `settlement-${beta}`, alphaFlag, betaFlag]
  );
  await pool.query(
    `UPDATE flags
     SET control_type='city_seat',city_id=city.id,city_affiliated_at=now(),
         city_affiliated_by_player_id=owner_id,original_owner_player_id=owner_id,
         contributed_by_player_id=owner_id,original_personal_color='#38bdf8'
     FROM cities city
     WHERE flags.id=city.seat_flag_id`,
  );
  await pool.query(
    `INSERT INTO city_memberships (city_id,player_id,role,joined_at,left_at,world_id)
     VALUES
       ($1,'legacy-founder-a','founder','2025-01-01',NULL,'main'),
       ($1,'legacy-member','member','2025-02-01',NULL,'main'),
       ($1,'legacy-mayor','member','2025-03-01',NULL,'main'),
       ($2,'legacy-founder-b','founder','2025-04-01',NULL,'main'),
       ($2,'legacy-left','member','2025-05-01','2026-01-01','main')`,
    [alpha, beta]
  );
}

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      database !== "ash_atlas_stability") {
    throw new Error("City reset tests require the local ash_atlas_stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
