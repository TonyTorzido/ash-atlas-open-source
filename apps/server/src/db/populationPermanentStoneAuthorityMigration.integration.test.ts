import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import {
  POPULATION_ZONE_V2_GEOMETRY_VERSION,
  populationZoneV2Geometry,
  populationZoneV2IdForPoint
} from "../game/populationZonesV2Geometry.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION =
  "0678_population_permanent_stone_authority.sql";

describeDatabase("0678 populated permanent stone authority upgrade", () => {
  const databaseName =
    `ash_atlas_stability_population_0678_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const planId = randomUUID();
  const slotId = randomUUID();
  const entityId = randomUUID();
  const zoneId = populationZoneV2IdForPoint({
    lat: 35.0844,
    lon: -106.6504
  });
  let precedingMigrations = "";
  let targetMigrations = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0678-before-")
    );
    targetMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0678-target-")
    );
    for (const name of await readdir(repoMigrations)) {
      if (!name.endsWith(".sql") || name >= TARGET_MIGRATION) continue;
      await copyFile(
        path.join(repoMigrations, name),
        path.join(precedingMigrations, name)
      );
      await copyFile(
        path.join(repoMigrations, name),
        path.join(targetMigrations, name)
      );
    }
    await copyFile(
      path.join(repoMigrations, TARGET_MIGRATION),
      path.join(targetMigrations, TARGET_MIGRATION)
    );
    const parsed = assertStabilityLabAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, {
      migrationsDirectory: precedingMigrations
    });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
    await seedPermanentStone(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`
    );
    await admin?.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
    if (targetMigrations) {
      await rm(targetMigrations, { recursive: true, force: true });
    }
  });

  it("backfills authority and membership without changing durable state", async () => {
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([TARGET_MIGRATION]);

    const result = await pool!.query<{
      authority_count: string;
      membership_count: string;
      physical_count: string;
      state: string;
      state_revision: string | number;
      durable_runtime_state: Record<string, unknown>;
      harvest_revision: string | number;
      ready_at: Date;
      plan_id: string;
      latitude: number | string;
      longitude: number | string;
    }>(
      `SELECT
         (
           SELECT count(*)::text
           FROM population_permanent_stone_authority_v2
           WHERE entity_id=$1::uuid
         ) AS authority_count,
         (
           SELECT count(*)::text
           FROM population_plan_permanent_stones_v2
           WHERE plan_id=$2::uuid AND entity_id=$1::uuid
         ) AS membership_count,
         (
           SELECT count(*)::text FROM population_spawn_slots_v2
           WHERE entity_id=$1::uuid
         ) AS physical_count,
         state.state, state.state_revision, state.durable_runtime_state,
         projection.harvest_revision, projection.ready_at,
         projection.population_v2_plan_id AS plan_id,
         authority.latitude, authority.longitude
       FROM population_entity_state_v2 AS state
       JOIN population_permanent_stone_authority_v2 AS authority
         ON authority.entity_id=state.entity_id
       JOIN repeatable_resource_nodes AS projection
         ON projection.population_v2_entity_id=state.entity_id
       WHERE state.entity_id=$1::uuid`,
      [entityId, planId]
    );
    expect(result.rows[0]).toMatchObject({
      authority_count: "1",
      membership_count: "1",
      physical_count: "1",
      state: "harvested",
      durable_runtime_state: { retained: "stone-history" },
      harvest_revision: "5",
      plan_id: planId
    });
    expect(Number(result.rows[0]!.state_revision)).toBe(5);
    expect(Number(result.rows[0]!.latitude)).toBe(35.0846);
    expect(Number(result.rows[0]!.longitude)).toBe(-106.6506);
    expect(result.rows[0]!.ready_at)
      .toEqual(new Date("2026-01-01T06:50:00.000Z"));

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([]);
  }, 30_000);

  async function seedPermanentStone(target: pg.Pool): Promise<void> {
    const geometry = populationZoneV2Geometry(zoneId);
    await target.query(
      `INSERT INTO population_zones_v2 (
         plan_id, zone_id, geometry_version,
         world_environment_identity_key, world_runtime_sha,
         plan_version, spawn_rules_version, environment_profile_version,
         candidate_layout_version, respawn_policy_version, region_code,
         band_index, column_index, zone_geog, center_geog, total_area_km2,
         status, next_retry_at
       ) VALUES (
         $1::uuid,$2,$3,$4,$5,'population-zone-plan-compiler-v3',
         'population-spawn-rules-v2-launch-3',
         'population-compact-gameplay-environment-v1',
         'compact-owner-samples-global-rank-v4',
         'population-generation-48h-v1','migration-0678',
         $6,$7,
         ST_Multi(ST_MakeEnvelope($8,$9,$10,$11,4326))::geography,
         ST_SetSRID(ST_MakePoint($12,$13),4326)::geography,
         $14,'pending',clock_timestamp()
       )`,
      [
        planId,
        zoneId,
        POPULATION_ZONE_V2_GEOMETRY_VERSION,
        "a".repeat(64),
        "b".repeat(40),
        geometry.address.band,
        geometry.address.column,
        geometry.bounds.westLon,
        geometry.bounds.southLat,
        geometry.bounds.eastLon,
        geometry.bounds.northLat,
        geometry.center.lon,
        geometry.center.lat,
        geometry.areaKm2
      ]
    );
    await target.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id, generation_id, slot_id, entity_id,
         candidate_id, entity_kind, archetype,
         latitude, longitude, geom,
         anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class
       ) VALUES (
         $1::uuid,NULL,$2::uuid,$3::uuid,'migration-0678-stone',
         'stone','stone_mine',35.0846,-106.6506,
         ST_SetSRID(ST_MakePoint(-106.6506,35.0846),4326)::geography,
         35.0846,-106.6506,
         ST_SetSRID(ST_MakePoint(-106.6506,35.0846),4326)::geography,
         '{"provenance":"retained"}'::jsonb,'none'
       )`,
      [planId, slotId, entityId]
    );
    await target.query(
      `INSERT INTO population_entity_state_v2 (entity_id, state)
       VALUES ($1::uuid,'ready')`,
      [entityId]
    );
    await target.query(
      `INSERT INTO repeatable_resource_nodes (
         id, node_type, region_code, lat, lon, geom,
         yield_item_id, yield_quantity, regeneration_interval,
         ready_at, harvest_revision, last_harvested_by,
         authored_source, placement_bucket_key, placement_version,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision, population_cutover_suppressed,
         population_flag_suppressed
       ) VALUES (
         $1::uuid,'stone_mine','migration-0678',35.0846,-106.6506,
         ST_SetSRID(ST_MakePoint(-106.6506,35.0846),4326),
         'stone',1,interval '5 hours 50 minutes',
         '-infinity'::timestamptz,0,NULL,'population-v2',
         'population-v2:' || $1::text,
         'compact-owner-samples-global-rank-v4',
         $1::uuid,$2,$3::uuid,0,1,false,false
       )`,
      [entityId, zoneId, planId]
    );
    await target.query(
      `UPDATE population_entity_state_v2
       SET state='harvested', state_revision=5,
           killed_or_harvested_at='2026-01-01T01:00:00.000Z',
           respawn_at='2026-01-01T06:50:00.000Z',
           durable_runtime_state='{"retained":"stone-history"}'::jsonb
       WHERE entity_id=$1::uuid`,
      [entityId]
    );
    await target.query(
      `UPDATE population_zones_v2
       SET status='ready', next_retry_at=NULL,
           content_hash=$2, ready_at=clock_timestamp(),
           habitat_snapshot='{}'::jsonb,
           candidate_pool='[]'::jsonb,
           nonstone_template_slots='[]'::jsonb
       WHERE plan_id=$1::uuid`,
      [planId, "c".repeat(64)]
    );
    await target.query(
      `INSERT INTO population_zone_cutovers_v2 (
         zone_id, geometry_version, serving_version, selected_plan_id,
         cutover_revision, status
       ) VALUES ($1,$2,'v2',$3::uuid,1,'stable')`,
      [zoneId, POPULATION_ZONE_V2_GEOMETRY_VERSION, planId]
    );
  }
});

function assertStabilityLabAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "postgres:"
    && parsed.protocol !== "postgresql:"
  ) {
    throw new Error("stability admin URL must use PostgreSQL");
  }
  if (!parsed.pathname.replace(/^\/+/u, "").startsWith(
    "ash_atlas_stability"
  )) {
    throw new Error(
      "stability admin URL must target an ash_atlas_stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(identifier: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(identifier)) {
    throw new Error("unsafe test database identifier");
  }
  return `"${identifier}"`;
}
