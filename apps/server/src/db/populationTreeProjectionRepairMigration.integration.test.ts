import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
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
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION =
  "0701_reconcile_population_tree_projections.sql";

describeDatabase("0701 Population V2 tree projection repair", () => {
  const databaseName =
    `ash_atlas_stability_population_0701_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const planId = randomUUID();
  const generationId = randomUUID();
  const treeId = randomUUID();
  const sapCrawlerId = randomUUID();
  const additionalSapCrawlerIds = Array.from(
    { length: 4 },
    () => randomUUID()
  );
  const sapEncounterId = randomUUID();
  const sapPackId = randomUUID();
  const actorAccountId = randomUUID();
  const actorPlayerId = `population-0701-${randomUUID()}`;
  const harvestedAt = new Date("2026-07-27T12:00:00.000Z");
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
      path.join(tmpdir(), "ash-atlas-population-0701-before-")
    );
    targetMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0701-target-")
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
    await seedMismatchedTreeAndSapCrawler(pool);
  }, 120_000);

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

  it("repairs only the mismatched tree and remains harmless when repeated", async () => {
    expect(await mismatchCount()).toBe(1);
    expect(await availableTreeCount()).toBe(1);
    await expect(pool!.query(
      `SELECT
         (SELECT COUNT(*)::int FROM collectible_nodes
          WHERE population_v2_entity_id=$1::uuid) AS sap_collectibles,
         (SELECT COUNT(*)::int FROM generated_world_mobs
          WHERE population_v2_entity_id=$2::uuid) AS tree_mobs`,
      [sapCrawlerId, treeId]
    )).resolves.toMatchObject({
      rows: [{ sap_collectibles: 0, tree_mobs: 0 }]
    });
    const sapBefore = await sapCrawlerSnapshot();

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([TARGET_MIGRATION]);

    expect(await mismatchCount()).toBe(0);
    expect(await availableTreeCount()).toBe(0);
    expect(await treeProjection()).toEqual({
      state: "harvested",
      harvested_at: harvestedAt,
      harvested_by_player_id: actorPlayerId,
      population_v2_state_revision: "7"
    });
    expect(await sapCrawlerSnapshot()).toEqual(sapBefore);

    const migrationSql = await readFile(
      path.join(repoMigrations, TARGET_MIGRATION),
      "utf8"
    );
    await pool!.query(migrationSql);
    const afterFirstRepeat = await treeProjection();
    await pool!.query(migrationSql);
    expect(await treeProjection()).toEqual(afterFirstRepeat);
    expect(await mismatchCount()).toBe(0);
    expect(await sapCrawlerSnapshot()).toEqual(sapBefore);
    await expect(pool!.query(
      `SELECT
         (SELECT COUNT(*)::int FROM collectible_nodes
          WHERE population_v2_entity_id=$1::uuid) AS sap_collectibles,
         (SELECT COUNT(*)::int FROM generated_world_mobs
          WHERE population_v2_entity_id=$2::uuid) AS tree_mobs`,
      [sapCrawlerId, treeId]
    )).resolves.toMatchObject({
      rows: [{ sap_collectibles: 0, tree_mobs: 0 }]
    });
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([]);

    // Upgrade only after the historical repair and repeatability checks.
    await runMigrations(databaseUrl);
    const ready = await new PostgresPopulationZonesV2Store(pool!)
      .loadReadyEntitiesForZones([zoneId]);
    expect(ready.map((entity) => entity.entityId).sort()).toEqual(
      [sapCrawlerId, ...additionalSapCrawlerIds].sort()
    );

  }, 30_000);

  async function mismatchCount(): Promise<number> {
    const result = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM collectible_nodes AS tree
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=tree.population_v2_entity_id
       WHERE tree.resource_type='wood'
         AND (
           tree.population_v2_state_revision <> state.state_revision
           OR (state.state='ready' AND tree.state<>'available')
           OR (state.state='harvested' AND tree.state<>'harvested')
         )`
    );
    return Number(result.rows[0]!.count);
  }

  async function availableTreeCount(): Promise<number> {
    const result = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM collectible_nodes
       WHERE id=$1 AND state='available'`,
      [treeId]
    );
    return Number(result.rows[0]!.count);
  }

  async function treeProjection() {
    const result = await pool!.query<{
      state: string;
      harvested_at: Date;
      harvested_by_player_id: string;
      population_v2_state_revision: string;
    }>(
      `SELECT state, harvested_at, harvested_by_player_id,
              population_v2_state_revision
       FROM collectible_nodes
       WHERE id=$1`,
      [treeId]
    );
    return result.rows[0];
  }

  async function sapCrawlerSnapshot() {
    const result = await pool!.query<{
      entity_id: string;
      mob_archetype: string;
      population_v2_state_revision: string;
      killed_at: Date | null;
    }>(
      `SELECT entity_id, mob_archetype, population_v2_state_revision,
              killed_at
       FROM generated_world_mobs
       WHERE entity_id=$1`,
      [sapCrawlerId]
    );
    return result.rows[0];
  }

  async function seedMismatchedTreeAndSapCrawler(target: pg.Pool): Promise<void> {
    await target.query(
      `INSERT INTO accounts (id, status, trust_tier)
       VALUES ($1,'active','standard')`,
      [actorAccountId]
    );
    await target.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m,
         online, geom
       ) VALUES (
         $1,$2,$3,$3,'migration-0701',35.0844,-106.6504,
         35.0844,-106.6504,1250,false,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)
       )`,
      [
        actorPlayerId,
        actorAccountId,
        `population-${randomUUID().slice(0, 8)}`
      ]
    );
    await target.query(
      `INSERT INTO spawn_cells (
         id, region_code, cell_x, cell_y, center_lat, center_lon
       ) VALUES (
         'migration-0701-cell','migration-0701',701,701,
         35.0844,-106.6504
       )`
    );
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
         'population-spawn-rules-v2-launch-6',
         'population-compact-gameplay-environment-v1',
         'compact-owner-samples-global-rank-v4',
         'population-generation-48h-v1','migration-0701',
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
    await target.query(
      `INSERT INTO population_zone_generations_v2 (
         generation_id, zone_id, plan_id, generation_number,
         generated_at, expires_at, status, planned_nonstone_count
       ) VALUES (
         $1::uuid,$2,$3::uuid,1,statement_timestamp() - interval '1 hour',
         statement_timestamp() + interval '47 hours','active',6
       )`,
      [generationId, zoneId, planId]
    );
    await target.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id, slot_id, entity_id, candidate_id, entity_kind, archetype,
         encounter_id, pack_id, pack_member_index,
         latitude, longitude, geom,
         anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class, generation_id
       ) VALUES
       ($1::uuid,$2::uuid,$3::uuid,'tree-candidate','tree','tree',
        NULL,NULL,NULL,
        35.0844,-106.6504,
        ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)::geography,
        35.0844,-106.6504,
        ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)::geography,
        '{}','none',$4::uuid),
       ($1::uuid,$5::uuid,$6::uuid,'sap-candidate','sap_crawler',
        'sap_crawler',$7::uuid,$8::uuid,0,35.0845,-106.6505,
        ST_SetSRID(ST_MakePoint(-106.6505,35.0845),4326)::geography,
        35.0845,-106.6505,
        ST_SetSRID(ST_MakePoint(-106.6505,35.0845),4326)::geography,
        '{}','none',$4::uuid)`,
      [
        planId,
        randomUUID(),
        treeId,
        generationId,
        randomUUID(),
        sapCrawlerId,
        sapEncounterId,
        sapPackId
      ]
    );
    await target.query(
      `INSERT INTO population_entity_state_v2 (
         entity_id, state, state_revision, state_actor_player_id,
         killed_or_harvested_at, durable_runtime_state
       ) VALUES
       ($1::uuid,'harvested',7,$2,$3,'{}'),
       ($4::uuid,'ready',5,NULL,NULL,'{}')`,
      [treeId, actorPlayerId, harvestedAt, sapCrawlerId]
    );
    await target.query(
      `UPDATE population_zones_v2
       SET status='ready', next_retry_at=NULL,
           content_hash=$2, ready_at=clock_timestamp(),
           habitat_snapshot='{}', candidate_pool='[]',
           nonstone_template_slots='[]'
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
      `INSERT INTO collectible_nodes (
         id, cell_id, region_code, resource_type, quantity,
         lat, lon, geom, state, env_snapshot, placement_version,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision, population_cutover_suppressed
       ) VALUES (
         $1::text,'migration-0701-cell','migration-0701','wood',4,
         35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326),
         'available','{}','compact-owner-samples-global-rank-v4',
         $1::uuid,$2,$3::uuid,0,9,false
       )`,
      [treeId, zoneId, planId]
    );
    await target.query(
      `INSERT INTO generated_world_mobs (
         entity_id, encounter_id, mob_archetype, pack_id,
         spawn_cell_id, region_code, lat, lon, geom,
         anchor_lat, anchor_lon, placement_version,
         environment_snapshot, population_v2_entity_id,
         physical_population_zone_v2_id, population_v2_plan_id,
         population_v2_state_revision, population_cutover_revision,
         population_cutover_suppressed
       ) VALUES (
         $1::text,$2::text,'sap_crawler',$3::text,
         'migration-0701-cell','migration-0701',
         35.0845,-106.6505,
         ST_SetSRID(ST_MakePoint(-106.6505,35.0845),4326),
         35.0845,-106.6505,'compact-owner-samples-global-rank-v4',
         '{}',$1::uuid,$4,$5::uuid,5,9,false
       )`,
      [sapCrawlerId, sapEncounterId, sapPackId, zoneId, planId]
    );
    for (const [index, entityId] of additionalSapCrawlerIds.entries()) {
      const memberIndex = index + 1;
      const lat = 35.0845 + memberIndex * 0.00001;
      const lon = -106.6505 - memberIndex * 0.00001;
      await target.query(
        `INSERT INTO population_spawn_slots_v2 (
           plan_id, slot_id, entity_id, candidate_id, entity_kind, archetype,
           encounter_id, pack_id, pack_member_index,
           latitude, longitude, geom,
           anchor_latitude, anchor_longitude, anchor_geom,
           environment_snapshot, suppression_class, generation_id
         ) VALUES (
           $1::uuid,$2::uuid,$3::uuid,$4,'sap_crawler','sap_crawler',
           $5::uuid,$6::uuid,$7,$8,$9,
           ST_SetSRID(ST_MakePoint($9,$8),4326)::geography,
           $8,$9,ST_SetSRID(ST_MakePoint($9,$8),4326)::geography,
           '{}','none',$10::uuid
         )`,
        [
          planId,
          randomUUID(),
          entityId,
          `sap-candidate-${memberIndex}`,
          sapEncounterId,
          sapPackId,
          memberIndex,
          lat,
          lon,
          generationId
        ]
      );
      await target.query(
        `INSERT INTO population_entity_state_v2 (
           entity_id, state, state_revision, durable_runtime_state
         ) VALUES ($1::uuid,'ready',5,'{}')`,
        [entityId]
      );
      await target.query(
        `INSERT INTO generated_world_mobs (
           entity_id, encounter_id, mob_archetype, pack_id,
           spawn_cell_id, region_code, lat, lon, geom,
           anchor_lat, anchor_lon, placement_version,
           environment_snapshot, population_v2_entity_id,
           physical_population_zone_v2_id, population_v2_plan_id,
           population_v2_state_revision, population_cutover_revision,
           population_cutover_suppressed
         ) VALUES (
           $1::text,$2::text,'sap_crawler',$3::text,
           'migration-0701-cell','migration-0701',
           $4,$5,ST_SetSRID(ST_MakePoint($5,$4),4326),
           $4,$5,'compact-owner-samples-global-rank-v4',
           '{}',$1::uuid,$6,$7::uuid,5,9,false
         )`,
        [
          entityId,
          sapEncounterId,
          sapPackId,
          lat,
          lon,
          zoneId,
          planId
        ]
      );
    }
  }
});

function assertStabilityLabAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "postgres:"
    && parsed.protocol !== "postgresql:"
  ) {
    throw new Error("Migration integration tests require PostgreSQL");
  }
  if (!parsed.pathname.includes("ash_atlas_stability")) {
    throw new Error(
      "Migration integration tests require an ash_atlas_stability admin database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
