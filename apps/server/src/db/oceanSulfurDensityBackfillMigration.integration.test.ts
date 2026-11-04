import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deriveOceanSulfurDeposits,
  oceanSulfurDomainForPoint,
  stableOceanSulfurDomainSlot
} from "../game/oceanSulfurPlacement.js";
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
const TARGET_MIGRATION = "0820_ocean_sulfur_density_backfill.sql";
const WORLD_ENVIRONMENT_IDENTITY_KEY = "a".repeat(64);

describeDatabase("0820 ocean Sulfur density backfill", () => {
  const databaseName = `ash_atlas_stability_sulfur_density_0820_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const domain = oceanSulfurDomainForPoint({ lat: 10, lon: -70 });
  const domainSlot = stableOceanSulfurDomainSlot(
    domain,
    WORLD_ENVIRONMENT_IDENTITY_KEY
  );
  const zoneId = populationZoneV2IdForPoint(domainSlot.position);
  const geometry = populationZoneV2Geometry(zoneId);
  const selectedPlanId = randomUUID();
  const retainedPlanId = randomUUID();
  const retainedStone = randomStoneIdentity();
  let beforeDirectory = "";
  let targetDirectory = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    beforeDirectory = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-0820-before-")
    );
    targetDirectory = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-0820-target-")
    );
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
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    await seedPlansAndRetainedStone(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin?.end();
    if (beforeDirectory) {
      await rm(beforeDirectory, { recursive: true, force: true });
    }
    if (targetDirectory) {
      await rm(targetDirectory, { recursive: true, force: true });
    }
  });

  it("backfills populated ready plans once, preserves retained rows, and replays safely", async () => {
    const concurrentResults = await Promise.all([
      runMigrations(databaseUrl, { migrationsDirectory: targetDirectory }),
      runMigrations(databaseUrl, { migrationsDirectory: targetDirectory })
    ]);
    expect(concurrentResults.flat()).toEqual([TARGET_MIGRATION]);
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetDirectory
    })).resolves.toEqual([]);

    const expected = deriveOceanSulfurDeposits({
      zoneId,
      worldEnvironmentIdentityKey: WORLD_ENVIRONMENT_IDENTITY_KEY,
      habitat: {
        candidateSites: [candidateSite()],
        surfaceAreaKm2: { land: 0, lake: 0, river: 0, ocean: 1 }
      }
    })[0]!;
    const sulfur = await pool!.query<{
      authority_count: string;
      membership_count: string;
      projection_count: string;
      candidate_id: string;
      entity_id: string;
      state: string;
    }>(
      `SELECT
         (SELECT count(*)::text
          FROM population_ocean_sulfur_authority_v1) AS authority_count,
         (SELECT count(*)::text
          FROM population_plan_ocean_sulfur_v1) AS membership_count,
         (SELECT count(*)::text
          FROM repeatable_resource_nodes
          WHERE population_v2_entity_id IS NOT NULL
            AND node_type='sulfur_mine') AS projection_count,
         authority.candidate_id, authority.entity_id::text,
         state.state
       FROM population_ocean_sulfur_authority_v1 AS authority
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=authority.entity_id`
    );
    expect(sulfur.rows).toEqual([{
      authority_count: "1",
      membership_count: "2",
      projection_count: "1",
      candidate_id: expected.candidateId,
      entity_id: expected.entityId,
      state: "ready"
    }]);

    const retained = await pool!.query<{
      entity_id: string;
      slot_id: string;
      entity_kind: PermanentMineKind;
      archetype: string;
    }>(
      `SELECT entity_id::text, slot_id::text, entity_kind, archetype
       FROM population_permanent_stone_authority_v2
       WHERE entity_id=$1::uuid`,
      [retainedStone.entityId]
    );
    expect(retained.rows).toEqual([{
      entity_id: retainedStone.entityId,
      slot_id: retainedStone.slotId,
      entity_kind: "stone",
      archetype: "stone_mine"
    }]);
  });

  function candidateSite() {
    return {
      siteId: "migration-0820-ocean-site",
      position: domainSlot.position,
      source: "world-profile-candidate-slot" as const,
      sourceSampleId: "migration-0820-sample",
      sourceCellId: "migration-0820-cell",
      sourceSlotId: "migration-0820-slot",
      candidateSlotVersion: "candidate-slot-v1",
      placementTags: ["ocean", "saltwater"],
      isSaltwater: true,
      insideMajorLake: false,
      surfaceType: "ocean" as const,
      surfaceAuthority: {
        releaseId: "migration-0820-world",
        manifestSha256: "b".repeat(64),
        cellSizeM: 512,
        rowId: 1,
        columnId: 2
      },
      elevationBand: "sea-level",
      terrainClass: "open-water",
      landCoverClass: "open-water",
      biomeId: "ocean",
      ecoregionId: "ocean",
      spawnProfileKey: "ocean-default",
      weights: {
        eligibleLand: 0,
        tree: 0,
        deer: 0,
        wolf: 0,
        stone: 0,
        ogre: 0
      }
    };
  }

  async function seedPlansAndRetainedStone(target: pg.Pool): Promise<void> {
    const snapshot = {
      regionCode: "migration-0820",
      candidateSites: [candidateSite()]
    };
    await insertPendingPlan(target, selectedPlanId, "migration-0820-plan-1", snapshot);
    await insertPendingPlan(target, retainedPlanId, "migration-0820-plan-2", snapshot);

    await target.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id, generation_id, slot_id, entity_id, candidate_id,
         entity_kind, archetype, latitude, longitude, geom,
         anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class
       ) VALUES (
         $1::uuid,NULL,$2::uuid,$3::uuid,$4,'stone','stone_mine',
         10,-70,ST_SetSRID(ST_MakePoint(-70,10),4326)::geography,
         10,-70,ST_SetSRID(ST_MakePoint(-70,10),4326)::geography,
         '{}'::jsonb,'none'
       )`,
      [
        selectedPlanId,
        retainedStone.slotId,
        retainedStone.entityId,
        "migration-0820-retained-stone"
      ]
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
         10,-70,10,-70,'{}'::jsonb,'none'
       )`,
      [
        retainedStone.entityId,
        retainedStone.slotId,
        "migration-0820-retained-stone",
        zoneId,
        WORLD_ENVIRONMENT_IDENTITY_KEY
      ]
    );
    await target.query(
      `INSERT INTO population_plan_permanent_stones_v2 (plan_id, entity_id)
       VALUES ($1::uuid,$2::uuid)`,
      [selectedPlanId, retainedStone.entityId]
    );
    await target.query(
      `INSERT INTO population_entity_state_v2 (entity_id, state)
       VALUES ($1::uuid,'ready')`,
      [retainedStone.entityId]
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
         $1::uuid,'stone_mine','migration-0820',10,-70,
         ST_SetSRID(ST_MakePoint(-70,10),4326),
         'stone',1,interval '5 hours 50 minutes','population-v2',
         'migration-0820:' || $1::text,'migration-0820-layout',
         $1::uuid,$2,$3::uuid,0,1
       )`,
      [retainedStone.entityId, zoneId, selectedPlanId]
    );
    await target.query(
      `UPDATE population_zones_v2
       SET status='ready', next_retry_at=NULL,
           habitat_snapshot=$2::jsonb, candidate_pool='[]'::jsonb,
           nonstone_template_slots='[]'::jsonb,
           content_hash=repeat('c',64), ready_at=clock_timestamp(),
           updated_at=clock_timestamp()
       WHERE plan_id=$1::uuid`,
      [selectedPlanId, JSON.stringify(snapshot)]
    );
    await target.query(
      `UPDATE population_zones_v2
       SET status='ready', next_retry_at=NULL,
           habitat_snapshot=$2::jsonb, candidate_pool='[]'::jsonb,
           nonstone_template_slots='[]'::jsonb,
           content_hash=repeat('d',64), ready_at=clock_timestamp(),
           updated_at=clock_timestamp()
       WHERE plan_id=$1::uuid`,
      [retainedPlanId, JSON.stringify(snapshot)]
    );
    await target.query(
      `INSERT INTO population_zone_cutovers_v2 (
         zone_id, geometry_version, serving_version, selected_plan_id,
         cutover_revision, status
       ) VALUES ($1,$2,'v2',$3::uuid,1,'stable')`,
      [zoneId, POPULATION_ZONE_V2_GEOMETRY_VERSION, selectedPlanId]
    );
  }

  async function insertPendingPlan(
    target: pg.Pool,
    planId: string,
    planVersion: string,
    snapshot: object
  ): Promise<void> {
    await target.query(
      `INSERT INTO population_zones_v2 (
         plan_id, zone_id, geometry_version,
         world_environment_identity_key, world_runtime_sha,
         plan_version, spawn_rules_version, environment_profile_version,
         candidate_layout_version, respawn_policy_version, region_code,
         band_index, column_index, zone_geog, center_geog, total_area_km2,
         status, next_retry_at, habitat_snapshot, candidate_pool,
         nonstone_template_slots
       ) VALUES (
         $1::uuid,$2,$3,$4,$5,$6,
         'migration-0820-spawn','migration-0820-profile',
         'migration-0820-layout','migration-0820-respawn','migration-0820',
         $7,$8,ST_Multi(ST_MakeEnvelope($9,$10,$11,$12,4326))::geography,
         ST_SetSRID(ST_MakePoint($13,$14),4326)::geography,$15,
         'pending',clock_timestamp(),$16::jsonb,'[]'::jsonb,'[]'::jsonb
       )`,
      [
        planId,
        zoneId,
        POPULATION_ZONE_V2_GEOMETRY_VERSION,
        WORLD_ENVIRONMENT_IDENTITY_KEY,
        "b".repeat(40),
        planVersion,
        geometry.address.band,
        geometry.address.column,
        geometry.bounds.westLon,
        geometry.bounds.southLat,
        geometry.bounds.eastLon,
        geometry.bounds.northLat,
        geometry.center.lon,
        geometry.center.lat,
        geometry.areaKm2,
        JSON.stringify(snapshot)
      ]
    );
  }
});

function randomStoneIdentity(): { slotId: string; entityId: string } {
  let slotId = randomUUID();
  while (permanentMineKindForSlot(slotId) !== "stone") slotId = randomUUID();
  return { slotId, entityId: randomUUID() };
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("unsafe disposable database name");
  }
  return `"${value}"`;
}
