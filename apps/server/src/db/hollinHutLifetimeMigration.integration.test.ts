import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOLLIN_HUT_MAX_LIFETIME_MS, HOLLIN_HUT_MIN_LIFETIME_MS } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresHollinHutStore } from "../game/hollinHuts.js";
import { populationZoneV2IdForPoint } from "../game/populationZonesV2Geometry.js";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1099_hollin_hut_lifetime.sql";
const DAY_MS = 24 * 60 * 60_000;

describeDatabase("Hollin Hut lifetime migration", () => {
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_hollin_life_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let precedingDirectory = "";
  let targetDirectory = "";
  let pool: DisposableTestPool | undefined;
  const legacyPopulationEntity = "00000000-0000-8000-8000-000000000a01";

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-hollin-life-pre-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-hollin-life-target-"));
    for (const name of (await readdir(sourceMigrations)).filter((candidate) => candidate.endsWith(".sql"))) {
      if (name < TARGET_MIGRATION) await copyFile(path.join(sourceMigrations, name), path.join(precedingDirectory, name));
      if (name <= TARGET_MIGRATION) await copyFile(path.join(sourceMigrations, name), path.join(targetDirectory, name));
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 6 });
    // Populated upgrade: a developer hut and a population hut already exist before the migration.
    await pool.query(
      `INSERT INTO hollin_huts (hut_id,creator_player_id,request_id,region_code,zone_id,lat,lon,source,population_entity_id,created_at)
       VALUES ('hollin-hut:00000000-0000-0000-0000-000000000001',NULL,'legacy-dev','us','z',35,-106,'developer',NULL,'2026-10-01T00:00:00Z'),
              ($1,NULL,$2,'us','z',20,-100,'population',$3,'2026-10-01T00:00:00Z')`,
      [`hollin-hut:${legacyPopulationEntity}`, `population:${legacyPopulationEntity}`, legacyPopulationEntity]
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  }, 30_000);

  it("gives existing population huts a 6-8 day lifetime, never expires developer huts, and is empty on a second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([TARGET_MIGRATION]);
    const rows = (await pool!.query<{ source: string; life_ms: number | null }>(
      `SELECT source, (extract(epoch FROM expires_at - created_at) * 1000)::float8 AS life_ms FROM hollin_huts ORDER BY source`
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source: "developer", life_ms: null });
    expect(rows[1]!.source).toBe("population");
    expect(rows[1]!.life_ms).toBeGreaterThanOrEqual(HOLLIN_HUT_MIN_LIFETIME_MS);
    expect(rows[1]!.life_ms).toBeLessThanOrEqual(HOLLIN_HUT_MAX_LIFETIME_MS);
    // A population hut must carry an expiry and a developer hut must not.
    await expect(pool!.query(
      `INSERT INTO hollin_huts (hut_id,creator_player_id,request_id,region_code,zone_id,lat,lon,source,population_entity_id)
       VALUES ('hollin-hut:00000000-0000-8000-8000-000000000a09',NULL,'population:bad','us','z',1,1,'population','00000000-0000-8000-8000-000000000a09')`
    )).rejects.toThrow(/hollin_huts_expiry_source_check/u);
    await expect(runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })).resolves.toEqual([]);
  }, 120_000);

  it("admits one hut per 30 km, atomically under concurrent adoption, with developer huts blocking too", async () => {
    await runMigrations(databaseUrl, { migrationsDirectory: targetDirectory });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * DAY_MS);
    const adopt = (store: PostgresHollinHutStore, entity: string, lat: number, lon: number) =>
      store.adoptPopulationHut({ populationEntityId: entity, regionCode: "us", zoneId: "z", position: { lat, lon }, expiresAt }, now);

    // 0.2 degrees of latitude is ~22 km: inside the developer hut's 30 km.
    await expect(adopt(new PostgresHollinHutStore(pool!), "00000000-0000-8000-8000-000000000b01", 35.2, -106)).resolves.toBeNull();

    // An adoption in flight (lock held, its row inserted but not committed) makes a nearby adoption
    // wait for it and then refuse, instead of reading past the uncommitted row and inserting too.
    const holder = await pool!.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('hollin_hut_adoption', 0))");
      await holder.query(
        `INSERT INTO hollin_huts (hut_id,creator_player_id,request_id,region_code,zone_id,lat,lon,source,population_entity_id,expires_at)
         VALUES ('hollin-hut:00000000-0000-8000-8000-000000000c01',NULL,'population:c01','us','z',-30,140,'population',
                 '00000000-0000-8000-8000-000000000c01',$1)`,
        [expiresAt]
      );
      const waiting = adopt(new PostgresHollinHutStore(pool!), "00000000-0000-8000-8000-000000000c02", -30.1, 140);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await holder.query("COMMIT");
      await expect(waiting).resolves.toBeNull();
    } finally {
      holder.release();
    }

    // Two cells ~11 km apart adopt at the same moment through separate connections: exactly one wins.
    const stores = [new PostgresHollinHutStore(pool!), new PostgresHollinHutStore(pool!)];
    const results = await Promise.all([
      adopt(stores[0]!, "00000000-0000-8000-8000-000000000b02", 50, 10),
      adopt(stores[1]!, "00000000-0000-8000-8000-000000000b03", 50.1, 10)
    ]);
    expect(results.filter((hut) => hut !== null)).toHaveLength(1);
    await expect(pool!.query("SELECT count(*)::int AS n FROM hollin_huts WHERE abs(lat - 50) < 1"))
      .resolves.toMatchObject({ rows: [{ n: 1 }] });
    // Replaying the winner is idempotent even though it now "blocks itself".
    const winner = results.find((hut) => hut !== null)!;
    await expect(adopt(stores[0]!, winner.populationEntityId!, winner.position.lat, winner.position.lon))
      .resolves.toMatchObject({ hutId: winner.hutId, expiresAt });
    // 31+ km from either cell is fine; an expired hut no longer blocks.
    await expect(adopt(stores[0]!, "00000000-0000-8000-8000-000000000b04", 50.4, 10)).resolves.not.toBeNull();
    await pool!.query("UPDATE hollin_huts SET expires_at=$2 WHERE hut_id=$1", [winner.hutId, new Date(now.getTime() - 1)]);
    await expect(adopt(stores[0]!, "00000000-0000-8000-8000-000000000b05", winner.position.lat, winner.position.lon)).resolves.not.toBeNull();
  }, 120_000);

  it("finds Giving Trees from the hut's Population V2 zone tree habitat", async () => {
    await runMigrations(databaseUrl, { migrationsDirectory: targetDirectory });
    const store = new PostgresHollinHutStore(pool!);
    const wooded = { lat: 41.5, lon: -95.5 };
    const bare = { lat: 30.5, lon: -80.5 };
    for (const [position, treeKm2] of [[wooded, 0.4], [bare, 0]] as const) {
      await pool!.query(
        `INSERT INTO population_zones_v2 (
           plan_id,zone_id,geometry_version,world_environment_identity_key,world_runtime_sha,
           plan_version,spawn_rules_version,environment_profile_version,candidate_layout_version,
           respawn_policy_version,region_code,band_index,column_index,zone_geog,center_geog,
           total_area_km2,tree_km2,status,next_retry_at
         ) VALUES (
           $1,$2,'geometry-v1',repeat('a',64),repeat('b',40),
           'plan-v1','rules-v1','profile-v1','layout-v1','respawn-v1','us',0,0,
           ST_Multi(ST_Buffer(ST_SetSRID(ST_MakePoint($4,$3),4326),0.01))::geography,
           ST_SetSRID(ST_MakePoint($4,$3),4326)::geography,1,$5,'pending',now()
         )`,
        [randomUUID(), populationZoneV2IdForPoint(position), position.lat, position.lon, treeKm2]
      );
    }
    await expect(store.hasGivingTrees(wooded)).resolves.toBe(true);
    await expect(store.hasGivingTrees(bare)).resolves.toBe(false);
    await expect(store.hasGivingTrees({ lat: -10, lon: 120 })).resolves.toBe(false); // no zone plan at all
  }, 60_000);
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Hollin Hut migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
