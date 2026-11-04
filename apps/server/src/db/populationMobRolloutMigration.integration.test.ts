import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { PopulationV2GenerationServer } from "../game/populationV2GenerationServices.js";
import {
  POPULATION_ZONE_V2_GEOMETRY_VERSION,
  populationZoneV2Geometry,
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id
} from "../game/populationZonesV2Geometry.js";
import {
  POPULATION_GENERATION_MATERIALIZATION_REVISION,
  PostgresPopulationZonesV2Store
} from "../game/populationZonesV2Store.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION =
  "0704_population_generation_mob_rollouts.sql";
const REGION_CODE = "migration-0702";
const GENERATED_AT = new Date("2099-06-01T00:00:00.000Z");

type RetainedFixture = Readonly<{
  zoneId: PopulationZoneV2Id;
  planId: string;
  generationId: string;
  entityId: string;
  slotId: string;
  encounterId: string;
  materializationRevision: string;
  identityDigit: string;
}>;

describeDatabase("0702 registered-mob manifest populated upgrade", () => {
  const databaseName =
    `ash_atlas_stability_population_0702_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const repoMigrations = fileURLToPath(
    new URL("../../../../db/migrations/", import.meta.url)
  );
  const accountId = randomUUID();
  const playerId = `population-0702-${randomUUID()}`;
  const fixtures: readonly RetainedFixture[] = [
    retainedFixture(
      { lat: 35.0844, lon: -106.6504 },
      POPULATION_GENERATION_MATERIALIZATION_REVISION,
      "a"
    ),
    retainedFixture(
      { lat: 35.1144, lon: -106.6504 },
      "population-generation-materialization-v3",
      "b"
    )
  ];
  let precedingMigrations = "";
  let targetMigrations = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0702-before-")
    );
    targetMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0702-target-")
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
    await seedRetainedPopulation(pool);
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

  it("preserves players and mixed v2/v3 generations while adding no receipts", async () => {
    const before = await retainedSnapshot(pool!, playerId);

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([TARGET_MIGRATION]);

    await expect(retainedSnapshot(pool!, playerId)).resolves.toEqual(before);
    await expect(pool!.query(
      "SELECT count(*)::integer AS count FROM population_generation_mob_rollouts_v2"
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([]);

    // Historical migration assertions precede current runtime compatibility.
    await runMigrations(databaseUrl);
    const server = new PopulationV2GenerationServer(
      new PostgresPopulationZonesV2Store(pool!)
    );
    const generations = await server.loadCurrentGenerations(
      fixtures.map((fixture) => fixture.zoneId)
    );
    expect([...generations.keys()].sort()).toEqual(
      fixtures.map((fixture) => fixture.zoneId).sort()
    );
    expect(fixtures.map((fixture) => {
      const generation = generations.get(fixture.zoneId)!;
      return {
        generationId: generation.generationId,
        assessment: server.assess(
          generation,
          new Date("2099-06-02T00:00:00.000Z")
        )
      };
    })).toEqual([
      {
        generationId: fixtures[0]!.generationId,
        assessment: {
          status: "servable",
          materializationStatus: "materialization-current",
          materializationRevision:
            POPULATION_GENERATION_MATERIALIZATION_REVISION
        }
      },
      {
        generationId: fixtures[1]!.generationId,
        assessment: {
          status: "servable",
          materializationStatus: "materialization-stale-but-servable",
          materializationRevision:
            "population-generation-materialization-v3"
        }
      }
    ]);
    // Legacy solo deer remain retained; current serving requires complete groups.
    await expect(server.loadReadyEntitiesForZones(
      fixtures.map((fixture) => fixture.zoneId)
    )).resolves.toEqual([]);
    await expect(retainedSnapshot(pool!, playerId)).resolves.toEqual(before);


  }, 30_000);

  async function seedRetainedPopulation(target: pg.Pool): Promise<void> {
    await target.query(
      `INSERT INTO accounts (id, status, trust_tier)
       VALUES ($1::uuid,'active','standard')`,
      [accountId]
    );
    await target.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m,
         online, geom
       ) VALUES (
         $1,$2::uuid,$3,$3,$4,35.0844,-106.6504,
         35.0844,-106.6504,1250,false,
         ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326)
       )`,
      [
        playerId,
        accountId,
        `population-${randomUUID().slice(0, 8)}`,
        REGION_CODE
      ]
    );
    await target.query(
      `INSERT INTO spawn_cells (
         id, region_code, cell_x, cell_y, center_lat, center_lon
       ) VALUES ('migration-0702-cell',$1,702,702,35.0844,-106.6504)`,
      [REGION_CODE]
    );
    for (const fixture of fixtures) {
      await insertRetainedFixture(target, fixture);
    }
  }
});

function retainedFixture(
  position: Readonly<{ lat: number; lon: number }>,
  materializationRevision: string,
  identityDigit: string
): RetainedFixture {
  return {
    zoneId: populationZoneV2IdForPoint(position),
    planId: randomUUID(),
    generationId: randomUUID(),
    entityId: randomUUID(),
    slotId: randomUUID(),
    encounterId: randomUUID(),
    materializationRevision,
    identityDigit
  };
}

async function insertRetainedFixture(
  target: pg.Pool,
  fixture: RetainedFixture
): Promise<void> {
  const geometry = populationZoneV2Geometry(fixture.zoneId);
  await target.query(
    `INSERT INTO population_zones_v2 (
       plan_id, zone_id, geometry_version,
       world_environment_identity_key, world_runtime_sha,
       plan_version, spawn_rules_version, environment_profile_version,
       candidate_layout_version, respawn_policy_version, region_code,
       band_index, column_index, zone_geog, center_geog, total_area_km2,
       status, next_retry_at, content_hash, ready_at,
       habitat_snapshot, candidate_pool, nonstone_template_slots
     ) VALUES (
       $1::uuid,$2,$3,$4,$5,'population-zone-plan-compiler-v3',
       'population-spawn-rules-v2-migration-0702',
       'population-compact-gameplay-environment-v1',
       'compact-owner-samples-global-rank-v4',
       'population-generation-48h-v1',$6,$7,$8,
       ST_Multi(ST_MakeEnvelope($9,$10,$11,$12,4326))::geography,
       ST_SetSRID(ST_MakePoint($13,$14),4326)::geography,
       $15,'ready',NULL,$16,statement_timestamp(),
       '{}'::jsonb,'[]'::jsonb,'[]'::jsonb
     )`,
    [
      fixture.planId,
      fixture.zoneId,
      POPULATION_ZONE_V2_GEOMETRY_VERSION,
      fixture.identityDigit.repeat(64),
      fixture.identityDigit.repeat(40),
      REGION_CODE,
      geometry.address.band,
      geometry.address.column,
      geometry.bounds.westLon,
      geometry.bounds.southLat,
      geometry.bounds.eastLon,
      geometry.bounds.northLat,
      geometry.center.lon,
      geometry.center.lat,
      geometry.areaKm2,
      fixture.identityDigit.repeat(64)
    ]
  );
  await target.query(
    `INSERT INTO population_zone_cutovers_v2 (
       zone_id, geometry_version, serving_version, selected_plan_id,
       cutover_revision, status
     ) VALUES ($1,$2,'v2',$3::uuid,1,'stable')`,
    [
      fixture.zoneId,
      POPULATION_ZONE_V2_GEOMETRY_VERSION,
      fixture.planId
    ]
  );
  await target.query(
    `INSERT INTO population_zone_generations_v2 (
       generation_id, zone_id, plan_id, generation_number,
       generated_at, expires_at, status, planned_nonstone_count,
       current_reference_count, is_current, density_revision,
       plan_content_hash, candidate_layout_version,
       materialization_revision
     ) VALUES (
       $1::uuid,$2,$3::uuid,1,$4,$5,'active',1,1,true,
       'population-density-v2',$6,
       'compact-owner-samples-global-rank-v4',$7
     )`,
    [
      fixture.generationId,
      fixture.zoneId,
      fixture.planId,
      GENERATED_AT,
      new Date(GENERATED_AT.getTime() + 48 * 60 * 60_000),
      fixture.identityDigit.repeat(64),
      fixture.materializationRevision
    ]
  );
  await target.query(
    `INSERT INTO population_spawn_slots_v2 (
       plan_id, generation_id, slot_id, entity_id, candidate_id,
       entity_kind, archetype, encounter_id, pack_id, pack_member_index,
       latitude, longitude, geom, anchor_latitude, anchor_longitude,
       anchor_geom, environment_snapshot, suppression_class
     ) VALUES (
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,
       'deer','deer',$6::uuid,NULL,NULL,
       $7,$8,ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,
       $7,$8,ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,
       '{}'::jsonb,'deer-safe'
     )`,
    [
      fixture.planId,
      fixture.generationId,
      fixture.slotId,
      fixture.entityId,
      `migration-0702-${fixture.entityId}`,
      fixture.encounterId,
      geometry.center.lat,
      geometry.center.lon
    ]
  );
  await target.query(
    `INSERT INTO population_entity_state_v2 (entity_id, state)
     VALUES ($1::uuid,'ready')`,
    [fixture.entityId]
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
       $1::text,$2::text,'deer',NULL,'migration-0702-cell',$3,$4,$5,
       ST_SetSRID(ST_MakePoint($5,$4),4326),
       $4,$5,'migration-0702-retained','{}'::jsonb,
       $1::uuid,$6,$7::uuid,0,1,false
     )`,
    [
      fixture.entityId,
      fixture.encounterId,
      REGION_CODE,
      geometry.center.lat,
      geometry.center.lon,
      fixture.zoneId,
      fixture.planId
    ]
  );
}

async function retainedSnapshot(
  target: pg.Pool,
  playerId: string
): Promise<Readonly<{
  players: readonly unknown[];
  generations: readonly unknown[];
  entities: readonly unknown[];
}>> {
  const [players, generations, entities] = await Promise.all([
    target.query(
      `SELECT id, account_id::text, username, region_code, lat, lon
       FROM players WHERE id=$1`,
      [playerId]
    ),
    target.query(
      `SELECT generation_id::text, zone_id, plan_id::text,
              generation_number, generated_at, expires_at, status,
              planned_nonstone_count, current_reference_count, is_current,
              density_revision, plan_content_hash,
              candidate_layout_version, materialization_revision
       FROM population_zone_generations_v2
       ORDER BY zone_id`
    ),
    target.query(
      `SELECT slot.entity_id::text, slot.slot_id::text,
              slot.generation_id::text, slot.entity_kind, slot.archetype,
              slot.encounter_id::text, slot.pack_id::text,
              slot.pack_member_index, state.state,
              state.state_revision, projection.entity_id,
              projection.mob_archetype, projection.pack_id,
              projection.population_v2_state_revision,
              projection.population_cutover_suppressed
       FROM population_spawn_slots_v2 AS slot
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=slot.entity_id
       JOIN generated_world_mobs AS projection
         ON projection.population_v2_entity_id=slot.entity_id
       ORDER BY slot.entity_id`
    )
  ]);
  return {
    players: players.rows,
    generations: generations.rows,
    entities: entities.rows
  };
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
      "0702 migration tests require the local disposable stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}
