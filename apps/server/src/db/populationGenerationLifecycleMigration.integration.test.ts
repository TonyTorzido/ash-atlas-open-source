import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdtemp,
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
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0671_population_v2_generation_lifecycle.sql";

describeDatabase("0671 populated Population v2 lifecycle reset", () => {
  const databaseName =
    `ash_atlas_stability_population_0671_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const accountId = randomUUID();
  const playerId = `population-0671-${randomUUID()}`;
  const areaId = `population-v1-${randomUUID()}`;
  const planId = randomUUID();
  const slotId = randomUUID();
  const entityId = randomUUID();
  const stoneSlotId = randomUUID();
  const stoneEntityId = randomUUID();
  const zoneId = populationZoneV2IdForPoint({
    lat: 35.0844,
    lon: -106.6504
  });
  let precedingMigrations = "";
  let targetMigration = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0671-before-")
    );
    targetMigration = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0671-target-")
    );
    for (const name of await readdir(repoMigrations)) {
      if (name.endsWith(".sql") && name < TARGET_MIGRATION) {
        await copyFile(
          path.join(repoMigrations, name),
          path.join(precedingMigrations, name)
        );
        await copyFile(
          path.join(repoMigrations, name),
          path.join(targetMigration, name)
        );
      }
    }
    await copyFile(
      path.join(repoMigrations, TARGET_MIGRATION),
      path.join(targetMigration, TARGET_MIGRATION)
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
    await seedRetainedAndObsoleteRows(pool);
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
    if (targetMigration) {
      await rm(targetMigration, { recursive: true, force: true });
    }
  });

  it("removes obsolete population and incompatible mine discoveries while preserving retained player data", async () => {
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigration
    })).resolves.toEqual([TARGET_MIGRATION]);

    const retained = await pool!.query<{
      account_count: string;
      player_count: string;
      inventory_quantity: string;
      mine_discovery_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM accounts WHERE id=$1::uuid)
           AS account_count,
         (SELECT count(*)::text FROM players WHERE id=$2)
           AS player_count,
         (
           SELECT quantity::text FROM player_inventory
           WHERE player_id=$2 AND resource_type='wood' AND variant='default'
         ) AS inventory_quantity,
         (
           SELECT count(*)::text FROM player_discovered_mines
           WHERE player_id=$2 AND node_id=$3::uuid
         ) AS mine_discovery_count`,
      [accountId, playerId, stoneEntityId]
    );
    expect(retained.rows[0]).toEqual({
      account_count: "1",
      player_count: "1",
      inventory_quantity: "0",
      mine_discovery_count: "0"
    });

    const mineDiscoveryIntegrity = await pool!.query<{
      foreign_key_count: string;
    }>(
      `SELECT count(*)::text AS foreign_key_count
       FROM pg_constraint
       WHERE conrelid='player_discovered_mines'::regclass
         AND contype='f'
         AND confrelid='repeatable_resource_nodes'::regclass`
    );
    expect(mineDiscoveryIntegrity.rows[0]).toEqual({
      foreign_key_count: "1"
    });
    await expect(pool!.query(
      `INSERT INTO player_discovered_mines (player_id, node_id)
       VALUES ($1,$2::uuid)`,
      [playerId, stoneEntityId]
    )).rejects.toMatchObject({
      code: "23503"
    });

    const obsoleteColumns = await pool!.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND (
           (
             table_name = 'collectible_nodes'
             AND column_name IN (
               'source_flag_id',
               'source_population_area_id',
               'source_generation'
             )
           )
           OR
           (
             table_name = 'generated_world_mobs'
             AND column_name IN (
               'source_population_area_id',
               'source_generation'
             )
           )
         )
       ORDER BY table_name, column_name`
    );
    expect(obsoleteColumns.rows).toEqual([]);

    await expect(pool!.query(
      `INSERT INTO collectible_nodes (
         id, cell_id, region_code, resource_type, quantity,
         lat, lon, geom, state, placement_version
       ) VALUES (
         'population-0671-rejected-unowned-tree','population-0671-cell',
         'population-0671','wood',4,35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326),
         'available','population-v2'
       )`
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "collectible_nodes_population_v2_owner_complete"
    });
    await expect(pool!.query(
      `INSERT INTO generated_world_mobs (
         entity_id, encounter_id, mob_archetype, pack_id,
         spawn_cell_id, region_code, lat, lon, geom,
         anchor_lat, anchor_lon, placement_version
       ) VALUES (
         'population-0671-rejected-unowned-deer',
         'population-0671-rejected-unowned-encounter',
         'deer',NULL,'population-0671-cell','population-0671',
         35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326),
         35.0844,-106.6504,'population-v2'
       )`
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "generated_world_mobs_population_owner_complete"
    });
    await expect(pool!.query(
      `INSERT INTO repeatable_resource_nodes (
         id, node_type, region_code, lat, lon, geom,
         yield_item_id, yield_quantity, regeneration_interval,
         authored_source, placement_bucket_key, placement_version
       ) VALUES (
         $1::uuid,'stone_mine','population-0671',35.0846,-106.6506,
         ST_SetSRID(ST_MakePoint(-106.6506,35.0846),4326),
         'stone',1,interval '5 hours 50 minutes','integration-test',
         'population-0671-unowned-mine','population-v2'
       )`,
      [randomUUID()]
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "repeatable_resource_nodes_population_v2_owner_complete"
    });

    const reset = await pool!.query<{
      plan_count: string;
      slot_count: string;
      collectible_count: string;
      mob_count: string;
      mine_count: string;
      generation_table: string | null;
      legacy_area_table: string | null;
      rollout_table: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM population_zones_v2) AS plan_count,
         (SELECT count(*)::text FROM population_spawn_slots_v2) AS slot_count,
         (SELECT count(*)::text FROM collectible_nodes) AS collectible_count,
         (SELECT count(*)::text FROM generated_world_mobs) AS mob_count,
         (SELECT count(*)::text FROM repeatable_resource_nodes) AS mine_count,
         to_regclass('population_zone_generations_v2')::text
           AS generation_table,
         to_regclass('environmental_population_areas')::text
           AS legacy_area_table,
         to_regclass('population_v2_rollout_control')::text
           AS rollout_table`
    );
    expect(reset.rows[0]).toEqual({
      plan_count: "0",
      slot_count: "0",
      collectible_count: "0",
      mob_count: "0",
      mine_count: "0",
      generation_table: "population_zone_generations_v2",
      legacy_area_table: null,
      rollout_table: null
    });

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigration
    })).resolves.toEqual([]);
  }, 30_000);

  async function seedRetainedAndObsoleteRows(target: pg.Pool): Promise<void> {
    await target.query(
      `INSERT INTO accounts (id, status, trust_tier)
       VALUES ($1,'active','standard')`,
      [accountId]
    );
    await target.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m,
         online, geom
       ) VALUES (
         $1,$2,$3,$3,'population-0671',35.0844,-106.6504,
         35.0844,-106.6504,1250,false,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)
       )`,
      [playerId, accountId, `population-${randomUUID().slice(0, 8)}`]
    );
    await target.query(
      `INSERT INTO player_inventory (
         player_id, resource_type, variant, quantity
       ) VALUES ($1,'wood','default',0)`,
      [playerId]
    );
    await target.query(
      `INSERT INTO environmental_population_areas (
         id, region_code, cell_x, cell_y, center_lat, center_lon,
         spawn_generation, next_resource_reset_at
       ) VALUES ($1,'population-0671',8701,8702,35.0844,-106.6504,1,now())`,
      [areaId]
    );
    await target.query(
      `INSERT INTO spawn_cells (
         id, region_code, cell_x, cell_y, center_lat, center_lon
       ) VALUES (
         'population-0671-cell','population-0671',8701,8702,
         35.0844,-106.6504
       )`
    );
    await target.query(
      `INSERT INTO collectible_nodes (
         id, cell_id, region_code, resource_type, quantity,
         lat, lon, geom, state, source_population_area_id,
         source_generation, placement_version
       ) VALUES (
         'population-0671-v1-tree','population-0671-cell',
         'population-0671','wood',4,35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326),
         'available',$1,1,'environment-population-v1'
       )`,
      [areaId]
    );
    await target.query(
      `INSERT INTO collectible_nodes (
         id, cell_id, region_code, resource_type, quantity,
         lat, lon, geom, state
       ) VALUES (
         'population-0671-unowned-legacy-tree','population-0671-cell',
         'population-0671','wood',4,35.0845,-106.6505,
         ST_SetSRID(ST_MakePoint(-106.6505,35.0845),4326),
         'available'
       )`
    );
    await target.query(
      `INSERT INTO harvest_sessions (
         id, player_id, node_id, resource_type, operation_key,
         status, started_at, completes_at, expires_at
       ) VALUES (
         $1::uuid,$2,'population-0671-unowned-legacy-tree','wood',
         'population-0671-unowned-harvest','active',
         clock_timestamp(),clock_timestamp() + interval '1 minute',
         clock_timestamp() + interval '2 minutes'
       )`,
      [randomUUID(), playerId]
    );
    await target.query(
      `INSERT INTO generated_world_mobs (
         entity_id, encounter_id, mob_archetype, pack_id,
         source_population_area_id, source_generation, spawn_cell_id,
         region_code, lat, lon, geom, anchor_lat, anchor_lon,
         placement_version
       ) VALUES (
         'population-0671-v1-deer','population-0671-v1-encounter',
         'deer',NULL,$1,1,'population-0671-cell','population-0671',
         35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326),
         35.0844,-106.6504,'environment-population-v1'
       )`,
      [areaId]
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
         $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,'population-0671',
         $11,$12,
         ST_Multi(ST_MakeEnvelope($13,$14,$15,$16,4326))::geography,
         ST_SetSRID(ST_MakePoint($17,$18),4326)::geography,
         $19,'pending',clock_timestamp()
       )`,
      [
        planId,
        zoneId,
        POPULATION_ZONE_V2_GEOMETRY_VERSION,
        "d".repeat(64),
        "e".repeat(40),
        "migration-plan-v1",
        "migration-spawn-v1",
        "migration-profile-v1",
        "migration-layout-v1",
        "migration-respawn-v1",
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
         plan_id, slot_id, entity_id, candidate_id, entity_kind,
         archetype, latitude, longitude, geom,
         anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,'population-0671-candidate',
         'tree','tree',35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)::geography,
         35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)::geography,
         '{}'::jsonb,'none'
       )`,
      [planId, slotId, entityId]
    );
    await target.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id, slot_id, entity_id, candidate_id, entity_kind,
         archetype, latitude, longitude, geom,
         anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,'population-0671-stone-candidate',
         'stone','stone_mine',35.0846,-106.6506,
         ST_SetSRID(ST_MakePoint(-106.6506,35.0846),4326)::geography,
         35.0846,-106.6506,
         ST_SetSRID(ST_MakePoint(-106.6506,35.0846),4326)::geography,
         '{}'::jsonb,'none'
       )`,
      [planId, stoneSlotId, stoneEntityId]
    );
    await target.query(
      `INSERT INTO population_entity_state_v2 (entity_id, state)
       VALUES ($1::uuid,'ready'),($2::uuid,'ready')`,
      [entityId, stoneEntityId]
    );
    await target.query(
      `UPDATE population_zones_v2
       SET status='ready', next_retry_at=NULL, content_hash=$2,
           ready_at=clock_timestamp()
       WHERE plan_id=$1::uuid`,
      [planId, "f".repeat(64)]
    );
    await target.query(
      `INSERT INTO population_zone_cutovers_v2 (
         zone_id, geometry_version, serving_version, selected_plan_id,
         cutover_revision, status
       ) VALUES ($1,$2,'v2',$3::uuid,1,'stable')`,
      [zoneId, POPULATION_ZONE_V2_GEOMETRY_VERSION, planId]
    );
    await target.query(
      `INSERT INTO collectible_nodes (
         id, cell_id, region_code, resource_type, quantity,
         lat, lon, geom, state, source_flag_id,
         source_population_area_id, source_generation, placement_version,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision, population_cutover_suppressed,
         population_flag_suppressed
       ) VALUES (
         $1,'population-0671-cell','population-0671','wood',4,
         35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326),
         'available',NULL,NULL,NULL,'migration-layout-v1',
         $2::uuid,$3,$4::uuid,0,1,false,false
       )`,
      [entityId, entityId, zoneId, planId]
    );
    await target.query(
      `INSERT INTO repeatable_resource_nodes (
         id, node_type, region_code, lat, lon, geom,
         yield_item_id, yield_quantity, regeneration_interval,
         authored_source, placement_bucket_key, placement_version,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision, population_cutover_suppressed,
         population_flag_suppressed
       ) VALUES (
         $1::uuid,'stone_mine','population-0671',35.0846,-106.6506,
         ST_SetSRID(ST_MakePoint(-106.6506,35.0846),4326),
         'stone',1,interval '48 hours','population-v2',
         'population-v2:' || $1::text,'migration-layout-v1',
         $1::uuid,$2,$3::uuid,0,1,false,false
       )`,
      [stoneEntityId, zoneId, planId]
    );
    await target.query(
      `INSERT INTO player_discovered_mines (player_id, node_id)
       VALUES ($1,$2::uuid)`,
      [playerId, stoneEntityId]
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
  if (!parsed.pathname.replace(/^\/+/u, "").startsWith("ash_atlas_stability")) {
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
