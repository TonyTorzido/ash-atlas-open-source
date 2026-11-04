import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const TARGET_MIGRATION = "0707_population_kind_manifest.sql";

describeDatabase("0707 Population V2 kind manifest populated upgrade", () => {
  const databaseName =
    `ash_atlas_stability_population_0707_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const repoMigrations = fileURLToPath(
    new URL("../../../../db/migrations/", import.meta.url)
  );
  const zoneId = populationZoneV2IdForPoint({
    lat: 35.0844,
    lon: -106.6504
  });
  const planId = randomUUID();
  const generationId = randomUUID();
  let precedingMigrations = "";
  let targetMigrations = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0707-before-")
    );
    targetMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0707-target-")
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

    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, {
      migrationsDirectory: precedingMigrations
    });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 3 });
    await seedGeneration(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin?.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
    if (targetMigrations) {
      await rm(targetMigrations, { recursive: true, force: true });
    }
  });

  it("preserves an active generation and is empty-repeatable", async () => {
    const before = await generationSnapshot(pool!);

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([TARGET_MIGRATION]);
    await expect(generationSnapshot(pool!)).resolves.toEqual(before);
    await expect(pool!.query(
      `SELECT common_schema_revision
       FROM population_zone_generations_v2
       WHERE generation_id=$1::uuid`,
      [generationId]
    )).resolves.toMatchObject({
      rows: [{ common_schema_revision: null }]
    });
    await expect(pool!.query(
      `SELECT count(*)::integer AS count
       FROM population_generation_kind_manifest_v2`
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([]);
  }, 30_000);

  async function seedGeneration(target: pg.Pool): Promise<void> {
    const geometry = populationZoneV2Geometry(zoneId);
    await target.query(
      `INSERT INTO population_zones_v2 (
         plan_id, zone_id, geometry_version,
         world_environment_identity_key, world_runtime_sha,
         plan_version, spawn_rules_version, environment_profile_version,
         candidate_layout_version, respawn_policy_version, region_code,
         band_index, column_index, zone_geog, center_geog, total_area_km2,
         status, content_hash, ready_at,
         habitat_snapshot, candidate_pool, nonstone_template_slots
       ) VALUES (
         $1::uuid,$2,$3,$4,$5,'population-zone-plan-compiler-v3',
         'population-spawn-rules-v2-migration-0707',
         'population-compact-gameplay-environment-v1',
         'compact-owner-samples-global-rank-v4',
         'population-generation-48h-v1','migration-0707',$6,$7,
         ST_Multi(ST_MakeEnvelope($8,$9,$10,$11,4326))::geography,
         ST_SetSRID(ST_MakePoint($12,$13),4326)::geography,
         $14,'ready',$15,statement_timestamp(),
         '{}'::jsonb,'[]'::jsonb,'[]'::jsonb
       )`,
      [
        planId,
        zoneId,
        POPULATION_ZONE_V2_GEOMETRY_VERSION,
        "7".repeat(64),
        "7".repeat(40),
        geometry.address.band,
        geometry.address.column,
        geometry.bounds.westLon,
        geometry.bounds.southLat,
        geometry.bounds.eastLon,
        geometry.bounds.northLat,
        geometry.center.lon,
        geometry.center.lat,
        geometry.areaKm2,
        "7".repeat(64)
      ]
    );
    await target.query(
      `INSERT INTO population_zone_cutovers_v2 (
         zone_id, geometry_version, serving_version, selected_plan_id,
         cutover_revision, status
       ) VALUES ($1,$2,'v2',$3::uuid,1,'stable')`,
      [zoneId, POPULATION_ZONE_V2_GEOMETRY_VERSION, planId]
    );
    await target.query(
      `INSERT INTO population_zone_generations_v2 (
         generation_id, zone_id, plan_id, generation_number,
         generated_at, expires_at, status, planned_nonstone_count,
         current_reference_count, is_current, density_revision,
         plan_content_hash, candidate_layout_version,
         materialization_revision
       ) VALUES (
         $1::uuid,$2,$3::uuid,1,statement_timestamp(),
         statement_timestamp() + interval '48 hours',
         'active',0,1,true,'population-density-v2',$4,
         'compact-owner-samples-global-rank-v4',
         'population-generation-materialization-v2'
       )`,
      [generationId, zoneId, planId, "7".repeat(64)]
    );
  }

  async function generationSnapshot(target: pg.Pool): Promise<unknown[]> {
    return (await target.query(
      `SELECT generation_id::text, zone_id, plan_id::text,
              generation_number, status, planned_nonstone_count,
              current_reference_count, is_current, density_revision,
              plan_content_hash, candidate_layout_version,
              materialization_revision
       FROM population_zone_generations_v2
       WHERE generation_id=$1::uuid`,
      [generationId]
    )).rows;
  }
});

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = parsed.pathname.replace(/^\/+/u, "");
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !database.startsWith("ash_atlas_stability")
    || parsed.port === "35432"
  ) {
    throw new Error(
      "0707 migration tests require a local disposable stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}
