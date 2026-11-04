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
const TARGET_MIGRATION = "0721_city_kingdom_membership_coexistence.sql";

describeDatabase("City and Kingdom membership coexistence migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_membership_coexistence_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-membership-coexistence-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("preserves existing memberships, permits coexistence, and reruns empty", async () => {
    const cityPlayer = randomUUID();
    const kingdomPlayer = randomUUID();
    await createPlayer(pool, cityPlayer, "City Player", 35);
    await createPlayer(pool, kingdomPlayer, "Kingdom Player", 36);
    const cityId = await createCityMembership(pool, cityPlayer);
    const kingdomId = await createKingdomMembership(pool, kingdomPlayer);

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);
    await expect(pool.query(
      "SELECT player_id FROM city_memberships WHERE city_id=$1 AND left_at IS NULL",
      [cityId]
    )).resolves.toMatchObject({ rows: [{ player_id: cityPlayer }] });
    await expect(pool.query(
      "SELECT player_id FROM kingdom_memberships WHERE kingdom_id=$1 AND status='active'",
      [kingdomId]
    )).resolves.toMatchObject({ rows: [{ player_id: kingdomPlayer }] });

    await addKingdomMembership(pool, kingdomId, cityPlayer, "member");
    await addCityMembership(pool, cityId, kingdomPlayer);
    await expect(pool.query(
      `SELECT p.id AS player_id,
              EXISTS (SELECT 1 FROM city_memberships cm WHERE cm.player_id=p.id AND cm.left_at IS NULL) AS in_city,
              EXISTS (SELECT 1 FROM kingdom_memberships km WHERE km.player_id=p.id AND km.status='active') AS in_kingdom
       FROM players p WHERE p.id = ANY($1::text[]) ORDER BY p.id`,
      [[cityPlayer, kingdomPlayer]]
    )).resolves.toMatchObject({ rows: [
      { player_id: cityPlayer, in_city: true, in_kingdom: true },
      { player_id: kingdomPlayer, in_city: true, in_kingdom: true }
    ].sort((left, right) => left.player_id.localeCompare(right.player_id)) });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 90_000);
});

async function createPlayer(pool: pg.Pool, id: string, username: string, lat: number): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id,username,display_color,region_code,lat,lon,anchor_lat,anchor_lon,
       move_leash_radius_m,online,geom
     ) VALUES ($1,$2,'#38bdf8','NM',$3,-106,$3,-106,900,false,
       ST_SetSRID(ST_MakePoint(-106,$3),4326))`,
    [id, username, lat]
  );
}

async function createCityMembership(pool: pg.Pool, playerId: string): Promise<string> {
  const flagId = randomUUID();
  const cityId = randomUUID();
  const structureId = randomUUID();
  await pool.query(
    `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
     SELECT $1,id,'City Center',lat,lon,100,geom FROM players WHERE id=$2`,
    [flagId, playerId]
  );
  await pool.query(
    `INSERT INTO cities (
       id,world_id,canonical_municipality_id,world_settlement_id,world_settlement_source,
       world_source_settlement_id,name,country_code,founder_player_id,founding_request_id,
       seat_flag_id,hall_lat,hall_lon,hall_geom,founding_annex_radius_m
     )
     SELECT $1,'main',$2,$2,'test',$2,'Migration City','US',$3,$4,$5,lat,lon,geom,100
     FROM flags WHERE id=$5`,
    [cityId, `municipality-${cityId}`, playerId, `found-${cityId}`, flagId]
  );
  await pool.query(
    `UPDATE flags SET control_type='city_seat',city_id=$2,city_affiliated_at=now(),
       city_affiliated_by_player_id=$3,original_owner_player_id=owner_id,
       contributed_by_player_id=owner_id,original_personal_color='#38bdf8' WHERE id=$1`,
    [flagId, cityId, playerId]
  );
  await pool.query(
    `INSERT INTO city_structures (
       structure_id,city_id,structure_type,tier,owner_player_id,world_id,region_code,
       lat,lon,geom,footprint_geom,footprint_radius_m,placement_revision,state,
       build_operation_key,built_at
     )
     SELECT $1,$2,'city_house',1,$3,'main','NM',lat,lon,geom,
       ST_Buffer(geom::geography,10)::geometry,10,1,'active',$4,now()
     FROM flags WHERE id=$5`,
    [structureId, cityId, playerId, `house-${structureId}`, flagId]
  );
  await addCityMembership(pool, cityId, playerId, structureId);
  return cityId;
}

async function addCityMembership(
  pool: pg.Pool,
  cityId: string,
  playerId: string,
  existingStructureId?: string
): Promise<void> {
  const structureId = existingStructureId ?? randomUUID();
  if (!existingStructureId) {
    const city = await pool.query<{ hall_lat: number; hall_lon: number }>(
      "SELECT hall_lat,hall_lon FROM cities WHERE id=$1",
      [cityId]
    );
    const { hall_lat: lat, hall_lon: lon } = city.rows[0]!;
    await pool.query(
      `INSERT INTO city_structures (
         structure_id,city_id,structure_type,tier,owner_player_id,world_id,region_code,
         lat,lon,geom,footprint_geom,footprint_radius_m,placement_revision,state,
         build_operation_key,built_at
       ) VALUES ($1,$2,'city_house',1,$3,'main','NM',$4,$5,
         ST_SetSRID(ST_MakePoint($5,$4),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint($5,$4),4326)::geography,10)::geometry,
         10,1,'active',$6,now())`,
      [structureId, cityId, playerId, Number(lat), Number(lon), `house-${structureId}`]
    );
  }
  await pool.query(
    `INSERT INTO city_memberships (
       membership_id,city_id,player_id,role,joined_at,left_at,world_id,house_structure_id
     ) VALUES ($1,$2,$3,'member',now(),NULL,'main',$4)`,
    [randomUUID(), cityId, playerId, structureId]
  );
}

async function createKingdomMembership(pool: pg.Pool, playerId: string): Promise<string> {
  const kingdomId = randomUUID();
  await pool.query(
    `INSERT INTO kingdoms (
       id,normalized_name,display_name,founder_player_id,leader_player_id,founding_request_id
     ) VALUES ($1,$2,'Migration Kingdom',$3,$3,$4)`,
    [kingdomId, `kingdom-${kingdomId.slice(0, 8)}`, playerId, randomUUID()]
  );
  await addKingdomMembership(pool, kingdomId, playerId, "leader");
  return kingdomId;
}

async function addKingdomMembership(
  pool: pg.Pool,
  kingdomId: string,
  playerId: string,
  role: "leader" | "member"
): Promise<void> {
  await pool.query(
    `INSERT INTO kingdom_memberships (
       id,kingdom_id,player_id,role,status,joined_at,perk_qualified_at
     ) VALUES ($1,$2,$3,$4,'active',now(),now())`,
    [randomUUID(), kingdomId, playerId, role]
  );
}

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("Membership coexistence migration tests require a local stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
