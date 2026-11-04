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
import { PostgresPopulationZonesV2Store } from "../game/populationZonesV2Store.js";
import { PopulationFlagSuppressionCleanupWorker } from "../game/populationFlagSuppressionCleanup.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION =
  "0693_remove_population_flag_wildlife_suppression.sql";

describeDatabase("0693 Population v2 flag suppression removal", () => {
  const databaseName =
    `ash_atlas_stability_population_0693_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const planId = randomUUID();
  const generationId = randomUUID();
  const zoneId = populationZoneV2IdForPoint({
    lat: 35.0844,
    lon: -106.6504
  });
  const ogreId = randomUUID();
  const deerId = randomUUID();
  const packId = randomUUID();
  const wolfIds = [randomUUID(), randomUUID(), randomUUID()];
  const entityIds = [ogreId, deerId, ...wolfIds];
  let precedingMigrations = "";
  let targetMigrations = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0681-before-")
    );
    targetMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0681-target-")
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
    await seedSuppressedWildlife(pool);
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

  it("enqueues fast cleanup and resumes bounded batches after worker restart", async () => {
    const before = await lifecycleSnapshot();
    expect(before.filter((row) => row.state === "ready")
      .map((row) => row.entity_id).sort()).toEqual([ogreId, ...wolfIds].sort());

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([TARGET_MIGRATION]);

    expect(await lifecycleSnapshot()).toEqual(before);
    await expect(pool!.query(
      `SELECT status, table_index, rows_cleared
       FROM population_flag_suppression_cleanup_jobs`
    )).resolves.toMatchObject({
      rows: [expect.objectContaining({
        status: "pending",
        table_index: 0,
        rows_cleared: "0"
      })]
    });

    await pool!.query(
      `ALTER TABLE collectible_nodes
       RENAME COLUMN population_flag_suppressed
       TO population_flag_suppressed_retry_probe`
    );
    const retryWorker = new PopulationFlagSuppressionCleanupWorker(
      pool!,
      { warn: () => undefined },
      () => false,
      5
    );
    retryWorker.start();
    await viWaitFor(async () => {
      const retry = await pool!.query<{ status: string; last_error: string | null }>(
        `SELECT status, last_error
         FROM population_flag_suppression_cleanup_jobs`
      );
      return retry.rows[0]?.status === "retrying"
        && retry.rows[0]?.last_error?.includes(
          "population_flag_suppressed"
        ) === true;
    });
    await retryWorker.stop();
    await pool!.query(
      `ALTER TABLE collectible_nodes
       RENAME COLUMN population_flag_suppressed_retry_probe
       TO population_flag_suppressed`
    );
    await pool!.query(
      `UPDATE population_flag_suppression_cleanup_jobs
       SET next_retry_at=clock_timestamp()`
    );

    const firstWorker = new PopulationFlagSuppressionCleanupWorker(
      pool!,
      { warn: () => undefined },
      () => false,
      5
    );
    firstWorker.start();
    await viWaitFor(async () => {
      const progress = await pool!.query<{ table_index: number }>(
        "SELECT table_index FROM population_flag_suppression_cleanup_jobs"
      );
      return (progress.rows[0]?.table_index ?? 0) >= 1;
    });
    await firstWorker.stop();

    const replacementWorker = new PopulationFlagSuppressionCleanupWorker(
      pool!,
      { warn: () => undefined },
      () => false,
      5
    );
    replacementWorker.start();
    await viWaitFor(async () =>
      (await replacementWorker.metricsSnapshot()).pendingJobs === 0
    );
    await replacementWorker.stop();

    const after = await lifecycleSnapshot();
    expect(after).toEqual(before.map((row) => ({
      ...row,
      population_flag_suppressed: false
    })));

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([]);
    expect(await lifecycleSnapshot()).toEqual(after);

    await runMigrations(databaseUrl);
    const ready = await new PostgresPopulationZonesV2Store(pool!)
      .loadReadyEntitiesForZones([zoneId]);
    expect(ready.map((entity) => entity.entityId).sort()).toEqual(
      [ogreId, ...wolfIds].sort()
    );
    expect(ready.find((entity) => entity.entityId === ogreId)).toMatchObject({
      entityKind: "ogre",
      generationId,
      stateRevision: 7
    });
    expect(ready.filter((entity) => entity.entityKind === "wolf")
      .map((entity) => entity.packId)).toEqual([packId, packId, packId]);
    expect(ready.some((entity) => entity.entityId === deerId)).toBe(false);


  }, 30_000);

  async function lifecycleSnapshot(): Promise<Array<{
    entity_id: string;
    pack_id: string | null;
    generation_id: string | null;
    state: string;
    state_revision: string;
    killed_or_harvested_at: Date | null;
    respawn_at: Date | null;
    durable_runtime_state: Record<string, unknown>;
    population_flag_suppressed: boolean;
  }>> {
    const result = await pool!.query(
      `SELECT projection.population_v2_entity_id::text AS entity_id,
              slot.pack_id::text, slot.generation_id::text,
              state.state, state.state_revision::text,
              state.killed_or_harvested_at, state.respawn_at,
              state.durable_runtime_state,
              projection.population_flag_suppressed
       FROM generated_world_mobs AS projection
       JOIN population_spawn_slots_v2 AS slot
         ON slot.entity_id=projection.population_v2_entity_id
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=slot.entity_id
       WHERE projection.population_v2_entity_id=ANY($1::uuid[])
       ORDER BY projection.population_v2_entity_id`,
      [entityIds]
    );
    return result.rows;
  }

  async function seedSuppressedWildlife(target: pg.Pool): Promise<void> {
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
         'population-spawn-rules-v2-launch-4',
         'population-compact-gameplay-environment-v1',
         'compact-owner-samples-global-rank-v4',
         'population-generation-48h-v1','migration-0681',
         $6,$7,
         ST_Multi(ST_MakeEnvelope($8,$9,$10,$11,4326))::geography,
         ST_SetSRID(ST_MakePoint($12,$13),4326)::geography,
         $14,'pending',clock_timestamp()
       )`,
      [
        planId,
        zoneId,
        POPULATION_ZONE_V2_GEOMETRY_VERSION,
        "d".repeat(64),
        "e".repeat(40),
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
    const generatedAt = new Date("2099-07-25T00:00:00.000Z");
    await target.query(
      `INSERT INTO population_zone_generations_v2 (
         generation_id, zone_id, plan_id, generation_number,
         generated_at, expires_at, status, planned_nonstone_count
       ) VALUES (
         $1::uuid,$2,$3::uuid,1,$4,$4::timestamptz + interval '48 hours',
         'active',$5
       )`,
      [generationId, zoneId, planId, generatedAt, entityIds.length]
    );
    const rows = entityIds.map((entityId, index) => ({
      slot_id: randomUUID(),
      entity_id: entityId,
      candidate_id: `migration-0681-${index}`,
      entity_kind: entityId === ogreId
        ? "ogre"
        : entityId === deerId
          ? "deer"
          : "wolf",
      archetype: entityId === ogreId
        ? "ogre"
        : entityId === deerId
          ? "deer"
          : "wolf",
      encounter_id: wolfIds.includes(entityId) ? packId : randomUUID(),
      pack_id: wolfIds.includes(entityId) ? packId : null,
      pack_member_index: wolfIds.indexOf(entityId) === -1
        ? null
        : wolfIds.indexOf(entityId),
      latitude: 35.0844 + index * 0.00001,
      longitude: -106.6504 - index * 0.00001
    }));
    await target.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id, slot_id, entity_id, candidate_id, entity_kind, archetype,
         encounter_id, pack_id, pack_member_index,
         latitude, longitude, geom,
         anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class, generation_id
       )
       SELECT $1::uuid, row.slot_id, row.entity_id, row.candidate_id,
              row.entity_kind, row.archetype, row.encounter_id, row.pack_id,
              row.pack_member_index, row.latitude, row.longitude,
              ST_SetSRID(ST_MakePoint(row.longitude,row.latitude),4326)::geography,
              35.0844,-106.6504,
              ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)::geography,
              '{"retained":"environment"}'::jsonb,
              CASE row.entity_kind
                WHEN 'deer' THEN 'deer-safe'
                WHEN 'wolf' THEN 'hostile-pack'
                ELSE 'hostile-ogre'
              END,
              $2::uuid
       FROM jsonb_to_recordset($3::jsonb) AS row(
         slot_id uuid, entity_id uuid, candidate_id text,
         entity_kind text, archetype text, encounter_id uuid, pack_id uuid,
         pack_member_index smallint, latitude double precision,
         longitude double precision
       )`,
      [planId, generationId, JSON.stringify(rows)]
    );
    await target.query(
      `INSERT INTO population_entity_state_v2 (
         entity_id, state, state_revision, killed_or_harvested_at,
         durable_runtime_state
       )
       SELECT entity_id, 'ready', 7, NULL,
              jsonb_build_object('health', 41, 'ai', 'retained')
       FROM unnest($1::uuid[]) AS entity_id`,
      [entityIds]
    );
    await target.query(
      `UPDATE population_entity_state_v2
       SET state='dead', state_revision=4,
           killed_or_harvested_at='2026-07-24T00:00:00Z',
           durable_runtime_state='{"death":"retained"}'::jsonb
       WHERE entity_id=$1::uuid`,
      [deerId]
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
       ) VALUES ($1,$2,'v2',$3::uuid,9,'stable')`,
      [zoneId, POPULATION_ZONE_V2_GEOMETRY_VERSION, planId]
    );
    await target.query(
      `INSERT INTO generated_world_mobs (
         entity_id, encounter_id, mob_archetype, pack_id,
         spawn_cell_id, region_code, lat, lon, geom,
         anchor_lat, anchor_lon, placement_version,
         environment_snapshot,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision, population_cutover_suppressed,
         population_flag_suppressed
       )
       SELECT row.entity_id::text, row.encounter_id::text, row.entity_kind,
              row.pack_id::text, 'migration-0681-cell', 'migration-0681',
              row.latitude, row.longitude,
              ST_SetSRID(ST_MakePoint(row.longitude,row.latitude),4326),
              35.0844,-106.6504,'compact-owner-samples-global-rank-v4',
              '{"retained":"projection"}'::jsonb,
              row.entity_id,$2,$1::uuid,
              CASE WHEN row.entity_id=$3::uuid THEN 4 ELSE 7 END,
              9,false,true
       FROM jsonb_to_recordset($4::jsonb) AS row(
         entity_id uuid, encounter_id uuid, entity_kind text, pack_id uuid,
         latitude double precision, longitude double precision
       )`,
      [planId, zoneId, deerId, JSON.stringify(rows)]
    );
  }
});

async function viWaitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for cleanup worker");
}

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
