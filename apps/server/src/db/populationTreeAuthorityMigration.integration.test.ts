import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { loadConfig } from "../config.js";
import {
  CollectibleService,
  resourceVisionForFlag,
  type CollectiblePlayer
} from "../game/collectibles.js";
import {
  POPULATION_ZONE_V2_GEOMETRY_VERSION,
  populationZoneV2Geometry,
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id
} from "../game/populationZonesV2Geometry.js";
import { PostgresPopulationZonesV2Store } from "../game/populationZonesV2Store.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION =
  "0705_suppress_non_authoritative_population_trees.sql";
const REGION_CODE = "migration-0703";
const CUTOVER_REVISION = 703;
const BASE_POSITION = {
  lat: 35.0844,
  lon: -106.6504
} as const;

type PlanFixture = Readonly<{
  planId: string;
  zoneId: PopulationZoneV2Id;
  identityDigit: string;
  contentDigit: string;
}>;

type TreeFixture = Readonly<{
  entityId: string;
  generationId: string;
  plan: PlanFixture;
  position: Readonly<{ lat: number; lon: number }>;
  generationZoneId?: PopulationZoneV2Id;
  canonicalState?: "ready" | "harvested";
  canonicalRevision?: number;
  projectionRevision?: number;
}>;

describeDatabase("0703 Population V2 tree generation authority", () => {
  const databaseName =
    `ash_atlas_stability_population_0703_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const repoMigrations = fileURLToPath(
    new URL("../../../../db/migrations/", import.meta.url)
  );
  const sharedCoordinateZone = populationZoneV2IdForPoint(BASE_POSITION);
  const mismatchZone = populationZoneV2IdForPoint({
    lat: BASE_POSITION.lat + 0.02,
    lon: BASE_POSITION.lon
  });
  const nonSelectedZone = populationZoneV2IdForPoint({
    lat: BASE_POSITION.lat + 0.04,
    lon: BASE_POSITION.lon
  });
  const wrongGenerationZone = populationZoneV2IdForPoint({
    lat: BASE_POSITION.lat + 0.06,
    lon: BASE_POSITION.lon
  });
  const sharedPlan: PlanFixture = {
    planId: randomUUID(),
    zoneId: sharedCoordinateZone,
    identityDigit: "1",
    contentDigit: "a"
  };
  const mismatchPlan: PlanFixture = {
    planId: randomUUID(),
    zoneId: mismatchZone,
    identityDigit: "2",
    contentDigit: "b"
  };
  const selectedEmptyPlan: PlanFixture = {
    planId: randomUUID(),
    zoneId: nonSelectedZone,
    identityDigit: "3",
    contentDigit: "c"
  };
  const nonSelectedPlan: PlanFixture = {
    planId: randomUUID(),
    zoneId: nonSelectedZone,
    identityDigit: "4",
    contentDigit: "d"
  };
  const obsoleteTree: TreeFixture = {
    entityId: randomUUID(),
    generationId: randomUUID(),
    plan: sharedPlan,
    position: BASE_POSITION
  };
  const currentTree: TreeFixture = {
    entityId: randomUUID(),
    generationId: randomUUID(),
    plan: sharedPlan,
    position: BASE_POSITION
  };
  const mismatchedTree: TreeFixture = {
    entityId: randomUUID(),
    generationId: randomUUID(),
    plan: mismatchPlan,
    position: {
      lat: BASE_POSITION.lat + 0.02,
      lon: BASE_POSITION.lon
    },
    canonicalState: "harvested",
    canonicalRevision: 4,
    projectionRevision: 3
  };
  const nonSelectedTree: TreeFixture = {
    entityId: randomUUID(),
    generationId: randomUUID(),
    plan: nonSelectedPlan,
    position: {
      lat: BASE_POSITION.lat + 0.04,
      lon: BASE_POSITION.lon
    }
  };
  const wrongZoneTree: TreeFixture = {
    entityId: randomUUID(),
    generationId: randomUUID(),
    plan: sharedPlan,
    generationZoneId: wrongGenerationZone,
    position: {
      lat: BASE_POSITION.lat + 0.001,
      lon: BASE_POSITION.lon
    }
  };
  const allTrees = [
    obsoleteTree,
    currentTree,
    mismatchedTree,
    nonSelectedTree,
    wrongZoneTree
  ];
  let precedingMigrations = "";
  let targetMigrations = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0703-before-")
    );
    targetMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0703-target-")
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
    await seedAuthorityCases(pool);
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

  it("quarantines only non-authoritative lives and fences reads and harvests", async () => {
    const before = await projectionSnapshots();
    expect(before).toEqual([
      projectionSnapshot(obsoleteTree, {
        generationStatus: "expired",
        generationCurrent: false,
        selectedPlanId: sharedPlan.planId
      }),
      projectionSnapshot(currentTree, {
        generationStatus: "active",
        generationCurrent: true,
        selectedPlanId: sharedPlan.planId
      }),
      projectionSnapshot(mismatchedTree, {
        generationStatus: "active",
        generationCurrent: true,
        selectedPlanId: mismatchPlan.planId
      }),
      projectionSnapshot(nonSelectedTree, {
        generationStatus: "active",
        generationCurrent: true,
        selectedPlanId: selectedEmptyPlan.planId
      }),
      projectionSnapshot(wrongZoneTree, {
        generationStatus: "active",
        generationCurrent: true,
        selectedPlanId: sharedPlan.planId
      })
    ].sort(compareSnapshots));
    expect(before.every((row) => !row.suppressed)).toBe(true);
    expect(before.find((row) => row.entityId === obsoleteTree.entityId))
      .toMatchObject({
        latitude: before.find(
          (row) => row.entityId === currentTree.entityId
        )!.latitude,
        longitude: before.find(
          (row) => row.entityId === currentTree.entityId
        )!.longitude
      });

    const service = new CollectibleService(
      pool!,
      {} as WorldLookupClient,
      loadConfig({ NODE_ENV: "test" }),
      {
        info: () => undefined,
        warn: () => undefined
      }
    );
    const vision = resourceVisionForFlag({
      flagId: randomUUID(),
      flagName: "Migration 0703",
      flagCenter: BASE_POSITION,
      movementLeashRadiusM: 600,
      visionRadiusM: 10_000
    });
    const player: CollectiblePlayer = {
      playerId: `migration-0703-${randomUUID()}`,
      regionCode: REGION_CODE,
      position: BASE_POSITION
    };
    const preMigrationCollectibles = await service.listAvailableInVision(
      REGION_CODE,
      vision
    );
    expect(preMigrationCollectibles.map((node) => node.id)).toEqual([
      currentTree.entityId
    ]);
    // Historical authority is checked against its actual schema; the current
    // population reader is exercised after upgrading the complete schema below.
    const preMigrationPopulation = await pool!.query<{ entity_id: string }>(
      `SELECT tree.population_v2_entity_id::text AS entity_id
       FROM collectible_nodes AS tree
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=tree.population_v2_entity_id AND state.state='ready'
       JOIN population_spawn_slots_v2 AS slot ON slot.entity_id=state.entity_id
       JOIN population_zone_generations_v2 AS generation
         ON generation.generation_id=slot.generation_id
        AND generation.plan_id=slot.plan_id
        AND generation.zone_id=tree.physical_population_zone_v2_id
       JOIN population_zone_cutovers_v2 AS cutover
         ON cutover.zone_id=generation.zone_id
        AND cutover.selected_plan_id=slot.plan_id
       WHERE generation.is_current AND generation.status='active'
         AND generation.expires_at>statement_timestamp()
         AND tree.population_v2_plan_id=slot.plan_id
         AND tree.population_v2_state_revision=state.state_revision
         AND tree.population_cutover_revision=cutover.cutover_revision
         AND tree.state='available' AND NOT tree.population_v2_suppressed
       ORDER BY tree.population_v2_entity_id`
    );
    expect(preMigrationPopulation.rows.map((row) => row.entity_id)).toEqual([
      currentTree.entityId
    ]);
    for (const obsolete of [obsoleteTree, wrongZoneTree]) {
      await expect(service.validateHarvestStartInTransaction(
        pool!,
        player,
        obsolete.entityId,
        vision,
        0
      )).rejects.toMatchObject({
        code: "HARVEST_NODE_NOT_FOUND",
        details: {
          nodeId: obsolete.entityId,
          stateRevision: 0,
          nodePosition: obsolete.position,
          reconciliation: "remove-node"
        }
      });
    }
    await expect(service.validateHarvestStartInTransaction(
      pool!,
      player,
      currentTree.entityId,
      vision,
      0
    )).resolves.toMatchObject({
      id: currentTree.entityId,
      stateRevision: 0
    });

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([TARGET_MIGRATION]);

    const after = await projectionSnapshots();
    expect(after.map((row) => ({
      entityId: row.entityId,
      suppressed: row.suppressed
    }))).toEqual([
      { entityId: obsoleteTree.entityId, suppressed: true },
      { entityId: currentTree.entityId, suppressed: false },
      { entityId: mismatchedTree.entityId, suppressed: true },
      { entityId: nonSelectedTree.entityId, suppressed: true },
      { entityId: wrongZoneTree.entityId, suppressed: true }
    ].sort((left, right) => left.entityId.localeCompare(right.entityId)));
    expect(after.map(stableProjectionSnapshot)).toEqual(
      before.map(stableProjectionSnapshot)
    );

    const currentGeneration = after.find(
      (row) => row.entityId === currentTree.entityId
    )!;
    expect(currentGeneration.generationDurationHours).toBe(48);
    expect(currentGeneration.expiresInHours).toBeGreaterThan(47);

    const visibleCollectibles = await service.listAvailableInVision(
      REGION_CODE,
      vision
    );
    expect(visibleCollectibles.map((node) => node.id)).toEqual([
      currentTree.entityId
    ]);

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([]);

    await runMigrations(databaseUrl);
    const visiblePopulation = await new PostgresPopulationZonesV2Store(pool!)
      .loadReadyEntitiesForZones([
        sharedCoordinateZone,
        mismatchZone,
        nonSelectedZone
      ]);
    expect(visiblePopulation.map((entity) => entity.entityId)).toEqual([
      currentTree.entityId
    ]);

    await expect(service.validateHarvestStartInTransaction(
      pool!,
      player,
      obsoleteTree.entityId,
      vision,
      0
    )).rejects.toMatchObject({
      code: "HARVEST_NODE_SUPPRESSED",
      details: {
        nodeId: obsoleteTree.entityId,
        stateRevision: 0,
        nodePosition: BASE_POSITION,
        reconciliation: "remove-node"
      }
    });
    await expect(service.validateHarvestStartInTransaction(
      pool!,
      player,
      currentTree.entityId,
      vision,
      0
    )).resolves.toMatchObject({
      id: currentTree.entityId,
      stateRevision: 0
    });


  }, 30_000);

  async function seedAuthorityCases(target: pg.Pool): Promise<void> {
    await target.query(
      `INSERT INTO spawn_cells (
         id, region_code, cell_x, cell_y, center_lat, center_lon
       ) VALUES (
         'migration-0703-cell',$1,703,703,$2,$3
       )`,
      [REGION_CODE, BASE_POSITION.lat, BASE_POSITION.lon]
    );
    for (const plan of [
      sharedPlan,
      mismatchPlan,
      selectedEmptyPlan,
      nonSelectedPlan
    ]) {
      await insertPlan(target, plan);
    }

    await insertGenerationTree(target, obsoleteTree, {
      generatedAt: "statement_timestamp() - interval '50 hours'"
    });
    await target.query(
      `UPDATE population_zone_generations_v2
       SET status='expired', is_current=false, current_reference_count=0,
           cleaned_at=statement_timestamp(), updated_at=statement_timestamp()
       WHERE generation_id=$1::uuid`,
      [obsoleteTree.generationId]
    );
    await insertGenerationTree(target, currentTree);
    await insertGenerationTree(target, mismatchedTree);
    await insertGenerationTree(target, nonSelectedTree);
    await insertGenerationTree(target, wrongZoneTree);

    for (const plan of [
      sharedPlan,
      mismatchPlan,
      selectedEmptyPlan,
      nonSelectedPlan
    ]) {
      await markPlanReady(target, plan);
    }
    await insertCutover(target, sharedPlan.zoneId, sharedPlan.planId);
    await insertCutover(target, mismatchPlan.zoneId, mismatchPlan.planId);
    await insertCutover(
      target,
      selectedEmptyPlan.zoneId,
      selectedEmptyPlan.planId
    );
  }

  async function projectionSnapshots(): Promise<Array<{
    entityId: string;
    planId: string;
    selectedPlanId: string;
    generationId: string;
    generationStatus: string;
    generationCurrent: boolean;
    canonicalState: string;
    canonicalRevision: number;
    projectionState: string;
    projectionRevision: number;
    latitude: number;
    longitude: number;
    suppressed: boolean;
    generationDurationHours: number;
    expiresInHours: number;
  }>> {
    const result = await pool!.query<{
      entity_id: string;
      plan_id: string;
      selected_plan_id: string;
      generation_id: string;
      generation_status: string;
      generation_current: boolean;
      canonical_state: string;
      canonical_revision: string | number;
      projection_state: string;
      projection_revision: string | number;
      latitude: string | number;
      longitude: string | number;
      suppressed: boolean;
      generation_duration_hours: string | number;
      expires_in_hours: string | number;
    }>(
      `SELECT tree.population_v2_entity_id::text AS entity_id,
              tree.population_v2_plan_id::text AS plan_id,
              cutover.selected_plan_id::text AS selected_plan_id,
              slot.generation_id::text AS generation_id,
              generation.status AS generation_status,
              generation.is_current AS generation_current,
              state.state AS canonical_state,
              state.state_revision AS canonical_revision,
              tree.state AS projection_state,
              tree.population_v2_state_revision AS projection_revision,
              tree.lat AS latitude,
              tree.lon AS longitude,
              tree.population_cutover_suppressed AS suppressed,
              EXTRACT(
                epoch FROM generation.expires_at-generation.generated_at
              ) / 3600 AS generation_duration_hours,
              EXTRACT(
                epoch FROM generation.expires_at-statement_timestamp()
              ) / 3600 AS expires_in_hours
       FROM collectible_nodes AS tree
       JOIN population_spawn_slots_v2 AS slot
         ON slot.entity_id=tree.population_v2_entity_id
       JOIN population_zone_generations_v2 AS generation
         ON generation.generation_id=slot.generation_id
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=slot.entity_id
       JOIN population_zones_v2 AS plan
         ON plan.plan_id=slot.plan_id
       JOIN population_zone_cutovers_v2 AS cutover
         ON cutover.zone_id=plan.zone_id
        AND cutover.geometry_version=plan.geometry_version
       WHERE tree.population_v2_entity_id=ANY($1::uuid[])
       ORDER BY tree.population_v2_entity_id`,
      [allTrees.map((tree) => tree.entityId)]
    );
    return result.rows.map((row) => ({
      entityId: row.entity_id,
      planId: row.plan_id,
      selectedPlanId: row.selected_plan_id,
      generationId: row.generation_id,
      generationStatus: row.generation_status,
      generationCurrent: row.generation_current,
      canonicalState: row.canonical_state,
      canonicalRevision: Number(row.canonical_revision),
      projectionState: row.projection_state,
      projectionRevision: Number(row.projection_revision),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      suppressed: row.suppressed,
      generationDurationHours: Number(row.generation_duration_hours),
      expiresInHours: Number(row.expires_in_hours)
    }));
  }
});

function projectionSnapshot(
  tree: TreeFixture,
  authority: Readonly<{
    generationStatus: string;
    generationCurrent: boolean;
    selectedPlanId: string;
  }>
) {
  return {
    entityId: tree.entityId,
    planId: tree.plan.planId,
    selectedPlanId: authority.selectedPlanId,
    generationId: tree.generationId,
    generationStatus: authority.generationStatus,
    generationCurrent: authority.generationCurrent,
    canonicalState: tree.canonicalState ?? "ready",
    canonicalRevision: tree.canonicalRevision ?? 0,
    projectionState: "available",
    projectionRevision: tree.projectionRevision ?? 0,
    latitude: tree.position.lat,
    longitude: tree.position.lon,
    suppressed: false,
    generationDurationHours: 48,
    expiresInHours: expect.any(Number)
  };
}

function compareSnapshots(
  left: Readonly<{ entityId: string }>,
  right: Readonly<{ entityId: string }>
): number {
  return left.entityId.localeCompare(right.entityId);
}

function stableProjectionSnapshot<
  T extends { suppressed: boolean; expiresInHours: number }
>(
  snapshot: T
): Omit<T, "suppressed" | "expiresInHours"> {
  const { suppressed, expiresInHours, ...preserved } = snapshot;
  void suppressed;
  void expiresInHours;
  return preserved;
}

async function insertPlan(
  target: pg.Pool,
  fixture: PlanFixture
): Promise<void> {
  const geometry = populationZoneV2Geometry(fixture.zoneId);
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
       'population-spawn-rules-v2-authority-test',
       'population-compact-gameplay-environment-v1',
       'compact-owner-samples-global-rank-v4',
       'population-generation-48h-v1',$6,$7,$8,
       ST_Multi(ST_MakeEnvelope($9,$10,$11,$12,4326))::geography,
       ST_SetSRID(ST_MakePoint($13,$14),4326)::geography,
       $15,'pending',statement_timestamp()
     )`,
    [
      fixture.planId,
      fixture.zoneId,
      POPULATION_ZONE_V2_GEOMETRY_VERSION,
      fixture.identityDigit.repeat(64),
      "e".repeat(40),
      REGION_CODE,
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
}

async function insertGenerationTree(
  target: pg.Pool,
  fixture: TreeFixture,
  options: Readonly<{ generatedAt?: string }> = {}
): Promise<void> {
  const generatedAt = options.generatedAt ?? "statement_timestamp()";
  await target.query(
    `INSERT INTO population_zone_generations_v2 (
       generation_id, zone_id, plan_id, generation_number,
       generated_at, expires_at, status, planned_nonstone_count
     ) VALUES (
       $1::uuid,$2,$3::uuid,
       (
         SELECT COALESCE(MAX(generation_number),0)+1
         FROM population_zone_generations_v2
         WHERE zone_id=$2
       ),
       ${generatedAt},(${generatedAt})+interval '48 hours','active',1
     )`,
    [
      fixture.generationId,
      fixture.generationZoneId ?? fixture.plan.zoneId,
      fixture.plan.planId
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
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'tree','tree',
       $6,$7,ST_SetSRID(ST_MakePoint($7,$6),4326)::geography,
       $6,$7,ST_SetSRID(ST_MakePoint($7,$6),4326)::geography,
       '{}'::jsonb,'none'
     )`,
    [
      fixture.plan.planId,
      fixture.generationId,
      randomUUID(),
      fixture.entityId,
      `authority-tree-${fixture.entityId}`,
      fixture.position.lat,
      fixture.position.lon
    ]
  );
  const canonicalState = fixture.canonicalState ?? "ready";
  const canonicalRevision = fixture.canonicalRevision ?? 0;
  await target.query(
    `INSERT INTO population_entity_state_v2 (
       entity_id, state, state_revision, killed_or_harvested_at,
       durable_runtime_state
     ) VALUES (
       $1::uuid,$2,$3,
       CASE WHEN $2='harvested'
         THEN statement_timestamp()-interval '1 hour'
         ELSE NULL
       END,
       '{}'::jsonb
     )`,
    [fixture.entityId, canonicalState, canonicalRevision]
  );
  await target.query(
    `INSERT INTO collectible_nodes (
       id, cell_id, region_code, resource_type, quantity,
       lat, lon, geom, state, env_snapshot, placement_version,
       population_v2_entity_id, physical_population_zone_v2_id,
       population_v2_plan_id, population_v2_state_revision,
       population_cutover_revision, population_cutover_suppressed
     ) VALUES (
       $1::text,'migration-0703-cell',$2,'wood',4,$3,$4,
       ST_SetSRID(ST_MakePoint($4,$3),4326),
       'available','{}'::jsonb,'compact-owner-samples-global-rank-v4',
       $1::uuid,$5,$6::uuid,$7,$8,false
     )`,
    [
      fixture.entityId,
      REGION_CODE,
      fixture.position.lat,
      fixture.position.lon,
      fixture.plan.zoneId,
      fixture.plan.planId,
      fixture.projectionRevision ?? 0,
      CUTOVER_REVISION
    ]
  );
}

async function markPlanReady(
  target: pg.Pool,
  fixture: PlanFixture
): Promise<void> {
  await target.query(
    `UPDATE population_zones_v2
     SET status='ready', next_retry_at=NULL,
         content_hash=$2, ready_at=statement_timestamp(),
         habitat_snapshot='{}'::jsonb,
         candidate_pool='[]'::jsonb,
         nonstone_template_slots='[]'::jsonb
     WHERE plan_id=$1::uuid`,
    [fixture.planId, fixture.contentDigit.repeat(64)]
  );
}

async function insertCutover(
  target: pg.Pool,
  zoneId: PopulationZoneV2Id,
  selectedPlanId: string
): Promise<void> {
  await target.query(
    `INSERT INTO population_zone_cutovers_v2 (
       zone_id, geometry_version, serving_version, selected_plan_id,
       cutover_revision, status
     ) VALUES ($1,$2,'v2',$3::uuid,$4,'stable')`,
    [
      zoneId,
      POPULATION_ZONE_V2_GEOMETRY_VERSION,
      selectedPlanId,
      CUTOVER_REVISION
    ]
  );
}

function assertStabilityLabAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = parsed.pathname.replace(/^\/+/u, "");
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !database.startsWith("ash_atlas_stability")
    || parsed.port === "35432"
  ) {
    throw new Error(
      "tree authority tests require the local disposable stability database"
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
