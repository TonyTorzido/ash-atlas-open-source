import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POPULATION_V2_READY_ENTITIES_SQL } from "../game/populationZonesV2Store.js";
import {
  POPULATION_ZONE_V2_GEOMETRY_VERSION,
  populationZoneV2Geometry,
  populationZoneV2IdForPoint
} from "../game/populationZonesV2Geometry.js";
import {
  permanentMineKindForSlot,
  type PermanentMineKind
} from "../game/populationZonesV2Identity.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0819_ocean_sulfur_deposits.sql";

describeDatabase("0819 ocean sulfur deposits", () => {
  const databaseName = `ash_atlas_stability_sulfur_0819_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const zoneId = populationZoneV2IdForPoint({
    lat: 35.0844,
    lon: -106.6504
  });
  const planId = randomUUID();
  let slotId = randomUUID();
  while (permanentMineKindForSlot(slotId) !== "stone") slotId = randomUUID();
  const entityId = randomUUID();
  const candidateId = "migration-0819-retained-stone";
  const worldEnvironmentIdentityKey = "a".repeat(64);
  let beforeDirectory = "";
  let targetDirectory = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    beforeDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-0819-before-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-0819-target-"));
    for (const name of await readdir(repoMigrations)) {
      if (!name.endsWith(".sql") || name > TARGET_MIGRATION) continue;
      await copyFile(
        path.join(repoMigrations, name),
        path.join(targetDirectory, name)
      );
      if (name < TARGET_MIGRATION) {
        await copyFile(
          path.join(repoMigrations, name),
          path.join(beforeDirectory, name)
        );
      }
    }
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: beforeDirectory });
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    await seedRetainedStone(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin?.end();
    if (beforeDirectory) await rm(beforeDirectory, { recursive: true, force: true });
    if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true });
  });

  it("preserves retained mine identity and is empty on the second run", async () => {
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetDirectory
    })).resolves.toEqual([TARGET_MIGRATION]);
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetDirectory
    })).resolves.toEqual([]);

    const retained = await pool!.query<{
      entity_id: string;
      slot_id: string;
      entity_kind: PermanentMineKind;
      archetype: string;
      node_type: string;
      yield_item_id: PermanentMineKind;
      state: string;
      classifier_kind: PermanentMineKind;
    }>(
      `SELECT authority.entity_id::text, authority.slot_id::text,
              authority.entity_kind, authority.archetype,
              projection.node_type, projection.yield_item_id,
              state.state,
              population_permanent_mine_kind_v1(authority.slot_id)
                AS classifier_kind
       FROM population_permanent_resource_authority_v2 AS authority
       JOIN repeatable_resource_nodes AS projection
         ON projection.population_v2_entity_id=authority.entity_id
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=authority.entity_id
       WHERE authority.entity_id=$1::uuid`,
      [entityId]
    );
    expect(retained.rows).toEqual([{
      entity_id: entityId,
      slot_id: slotId,
      entity_kind: "stone",
      archetype: "stone_mine",
      node_type: "stone_mine",
      yield_item_id: "stone",
      state: "ready",
      classifier_kind: "stone"
    }]);

    const sulfur = await pool!.query<{
      item_id: string;
      max_stack: number;
      authority_count: string;
      membership_count: string;
    }>(
      `SELECT item.item_id, item.max_stack,
              (SELECT count(*)::text
               FROM population_ocean_sulfur_authority_v1) AS authority_count,
              (SELECT count(*)::text
               FROM population_plan_ocean_sulfur_v1) AS membership_count
       FROM item_definitions AS item
       WHERE item.item_id='sulfur'`
    );
    expect(sulfur.rows).toEqual([{
      item_id: "sulfur",
      max_stack: 250,
      authority_count: "0",
      membership_count: "0"
    }]);
  });

  it("admits an adopted Sulfur projection through generic Population V2 streaming", async () => {
    const sulfurSlotId = randomUUID();
    const sulfurEntityId = randomUUID();
    const sulfurCandidateId = "migration-0819-ocean-sulfur";
    const snapshot = {
      placementVersion: "ocean-sulfur-placement-v1",
      eligibilityRule: "ocean-saltwater-outside-major-lake-with-surface-authority",
      surfaceType: "ocean",
      isSaltwater: true,
      insideMajorLake: false,
      surfaceAuthority: { releaseId: "migration-0819" }
    };
    await pool!.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id, generation_id, slot_id, entity_id, candidate_id,
         entity_kind, archetype, latitude, longitude, geom,
         anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class
       ) VALUES (
         $1::uuid,NULL,$2::uuid,$3::uuid,$4,'sulfur','sulfur_mine',
         35.0845,-106.6505,
         ST_SetSRID(ST_MakePoint(-106.6505,35.0845),4326)::geography,
         35.0845,-106.6505,
         ST_SetSRID(ST_MakePoint(-106.6505,35.0845),4326)::geography,
         $5::jsonb,'none'
       )`,
      [planId, sulfurSlotId, sulfurEntityId, sulfurCandidateId, JSON.stringify(snapshot)]
    );
    await pool!.query(
      `INSERT INTO population_ocean_sulfur_authority_v1 (
         entity_id, slot_id, candidate_id, owner_zone_id,
         entity_kind, archetype, placement_version,
         yield_item_id, yield_quantity, regeneration_interval,
         timer_profession_id, timer_visibility_rank,
         world_environment_identity_key,
         latitude, longitude, anchor_latitude, anchor_longitude,
         environment_snapshot, suppression_class
       ) VALUES (
         $1::uuid,$2::uuid,$3,$4,'sulfur','sulfur_mine',
         'ocean-sulfur-placement-v1','sulfur',1,
         interval '5 hours 50 minutes','miner',2,$5,
         35.0845,-106.6505,35.0845,-106.6505,$6::jsonb,'none'
       )`,
      [
        sulfurEntityId, sulfurSlotId, sulfurCandidateId, zoneId,
        worldEnvironmentIdentityKey, JSON.stringify(snapshot)
      ]
    );
    await pool!.query(
      `INSERT INTO population_plan_ocean_sulfur_v1 (plan_id, entity_id)
       VALUES ($1::uuid,$2::uuid)`,
      [planId, sulfurEntityId]
    );
    await pool!.query(
      `INSERT INTO population_entity_state_v2 (entity_id, state)
       VALUES ($1::uuid,'ready')`,
      [sulfurEntityId]
    );
    await pool!.query(
      `INSERT INTO repeatable_resource_nodes (
         id, node_type, region_code, lat, lon, geom,
         yield_item_id, yield_quantity, regeneration_interval,
         authored_source, placement_bucket_key, placement_version,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision
       ) VALUES (
         $1::uuid,'sulfur_mine','migration-0819',35.0845,-106.6505,
         ST_SetSRID(ST_MakePoint(-106.6505,35.0845),4326),
         'sulfur',1,interval '5 hours 50 minutes','population-v2',
         'migration-0819:' || $1::text,'migration-0819-layout',
         $1::uuid,$2,$3::uuid,0,1
       )`,
      [sulfurEntityId, zoneId, planId]
    );
    await pool!.query(
      `UPDATE population_zones_v2
       SET status='ready', next_retry_at=NULL,
           habitat_snapshot='{}'::jsonb, candidate_pool='[]'::jsonb,
           nonstone_template_slots='[]'::jsonb,
           content_hash=repeat('c',64), ready_at=clock_timestamp(),
           updated_at=clock_timestamp()
       WHERE plan_id=$1::uuid`,
      [planId]
    );
    await pool!.query(
      `INSERT INTO population_zone_cutovers_v2 (
         zone_id, geometry_version, serving_version, selected_plan_id,
         cutover_revision, status
       ) VALUES ($1,$2,'v2',$3::uuid,1,'stable')`,
      [zoneId, POPULATION_ZONE_V2_GEOMETRY_VERSION, planId]
    );

    const ready = await pool!.query<{
      entity_id: string;
      entity_kind: string;
      archetype: string;
      generation_id: string | null;
    }>(POPULATION_V2_READY_ENTITIES_SQL, [
      [zoneId],
      POPULATION_ZONE_V2_GEOMETRY_VERSION
    ]);
    expect(ready.rows).toContainEqual(expect.objectContaining({
      entity_id: sulfurEntityId,
      entity_kind: "sulfur",
      archetype: "sulfur_mine",
      generation_id: null
    }));
  });

  async function seedRetainedStone(target: pg.Pool): Promise<void> {
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
         $1::uuid,$2,$3,$4,$5,'migration-0819-plan',
         'migration-0819-spawn','migration-0819-profile',
         'migration-0819-layout','migration-0819-respawn','migration-0819',
         $6,$7,ST_Multi(ST_MakeEnvelope($8,$9,$10,$11,4326))::geography,
         ST_SetSRID(ST_MakePoint($12,$13),4326)::geography,
         $14,'pending',clock_timestamp()
       )`,
      [
        planId, zoneId, POPULATION_ZONE_V2_GEOMETRY_VERSION,
        worldEnvironmentIdentityKey, "b".repeat(40), geometry.address.band,
        geometry.address.column, geometry.bounds.westLon,
        geometry.bounds.southLat, geometry.bounds.eastLon,
        geometry.bounds.northLat, geometry.center.lon, geometry.center.lat,
        geometry.areaKm2
      ]
    );
    await target.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id, generation_id, slot_id, entity_id, candidate_id,
         entity_kind, archetype, latitude, longitude, geom,
         anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class
       ) VALUES (
         $1::uuid,NULL,$2::uuid,$3::uuid,$4,'stone','stone_mine',
         35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)::geography,
         35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)::geography,
         '{}'::jsonb,'none'
       )`,
      [planId, slotId, entityId, candidateId]
    );
    await target.query(
      `INSERT INTO population_permanent_stone_authority_v2 (
         entity_id, slot_id, candidate_id, owner_zone_id,
         entity_kind, archetype, stone_placement_version,
         world_environment_identity_key, latitude, longitude,
         anchor_latitude, anchor_longitude, environment_snapshot,
         suppression_class
       ) VALUES (
         $1::uuid,$2::uuid,$3,$4,'stone','stone_mine',
         'population-permanent-stone-placement-v1',$5,
         35.0844,-106.6504,35.0844,-106.6504,'{}'::jsonb,'none'
       )`,
      [entityId, slotId, candidateId, zoneId, worldEnvironmentIdentityKey]
    );
    await target.query(
      `INSERT INTO population_plan_permanent_stones_v2 (plan_id, entity_id)
       VALUES ($1::uuid,$2::uuid)`,
      [planId, entityId]
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
         authored_source, placement_bucket_key, placement_version,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision
       ) VALUES (
         $1::uuid,'stone_mine','migration-0819',35.0844,-106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326),
         'stone',1,interval '5 hours 50 minutes','population-v2',
         'migration-0819:' || $1::text,'migration-0819-layout',
         $1::uuid,$2,$3::uuid,0,1
       )`,
      [entityId, zoneId, planId]
    );
  }
});

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("unsafe disposable database name");
  }
  return `"${value}"`;
}
