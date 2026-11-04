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
const TARGET_MIGRATION = "0713_permanent_resource_lifecycle.sql";

describeDatabase("0713 permanent-resource lifecycle repair", () => {
  const databaseName =
    `ash_atlas_stability_population_0713_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const planId = randomUUID();
  const zoneId = populationZoneV2IdForPoint({
    lat: 35.0844,
    lon: -106.6504
  });
  const entityIds = {
    safe: randomUUID(),
    staleDeadline: randomUUID(),
    suppressed: randomUUID(),
    definitionMismatch: randomUUID(),
    planMismatch: randomUUID()
  } as const;
  let precedingMigrations = "";
  let targetMigrations = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0713-before-")
    );
    targetMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0713-target-")
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
    // The retained-state matrix deliberately injects a definition mismatch
    // that normal writes cannot create while this production constraint holds.
    await pool.query(
      `ALTER TABLE repeatable_resource_nodes
       DROP CONSTRAINT repeatable_resource_nodes_stone_mine_yield_check`
    );
    await seedStalePermanentResources(pool);
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

  it("repairs only fully fenced projections and installs generic synchronization", async () => {
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([TARGET_MIGRATION]);

    expect(await projectionState(entityIds.safe)).toEqual({
      ready_at: new Date("2026-07-29T17:50:00.000Z"),
      harvest_revision: "7",
      population_v2_state_revision: "7"
    });
    expect(await canonicalState(entityIds.safe)).toEqual({
      state: "harvested",
      harvested_at: new Date("2026-07-29T12:00:00.000Z"),
      respawn_at: new Date("2026-07-29T17:50:00.000Z"),
      state_revision: "7"
    });
    expect(await canonicalState(entityIds.staleDeadline)).toEqual({
      state: "harvested",
      harvested_at: new Date("2026-07-29T12:00:00.000Z"),
      respawn_at: new Date("2026-07-29T17:50:00.000Z"),
      state_revision: "7"
    });
    expect(await projectionState(entityIds.staleDeadline)).toEqual({
      ready_at: new Date("2026-07-29T17:50:00.000Z"),
      harvest_revision: "7",
      population_v2_state_revision: "7"
    });
    for (const entityId of [
      entityIds.suppressed,
      entityIds.definitionMismatch,
      entityIds.planMismatch
    ]) {
      expect(await projectionState(entityId)).toEqual({
        ready_at: -Infinity,
        harvest_revision: "0",
        population_v2_state_revision: "0"
      });
    }

    await pool!.query(
      `UPDATE population_entity_state_v2
       SET state='ready', state_revision=8,
           state_actor_player_id=NULL,
           killed_or_harvested_at=NULL, respawn_at=NULL
       WHERE entity_id=$1::uuid`,
      [entityIds.safe]
    );
    expect(await projectionState(entityIds.safe)).toEqual({
      ready_at: -Infinity,
      harvest_revision: "8",
      population_v2_state_revision: "8"
    });
    expect(await projectionState(entityIds.definitionMismatch)).toEqual({
      ready_at: -Infinity,
      harvest_revision: "0",
      population_v2_state_revision: "0"
    });

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([]);
  }, 30_000);

  it("rejects retained harvested lives without a trustworthy event timestamp", async () => {
    const malformedDatabaseName =
      `ash_atlas_stability_population_0713_malformed_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 10)}`;
    const parsed = assertStabilityLabAdminUrl(adminUrl!);
    parsed.pathname = `/${malformedDatabaseName}`;
    const malformedUrl = parsed.toString();
    let malformedPool: pg.Pool | undefined;
    try {
      await admin!.query(
        `CREATE DATABASE ${quoteIdentifier(malformedDatabaseName)}`
      );
      await runMigrations(malformedUrl, {
        migrationsDirectory: precedingMigrations
      });
      malformedPool = new DisposableTestPool({
        connectionString: malformedUrl,
        max: 4
      });
      await malformedPool.query(
        `ALTER TABLE repeatable_resource_nodes
         DROP CONSTRAINT repeatable_resource_nodes_stone_mine_yield_check`
      );
      await seedStalePermanentResources(malformedPool);
      await malformedPool.query(
        `ALTER TABLE population_entity_state_v2
         DISABLE TRIGGER USER`
      );
      await malformedPool.query(
        `DO $$
         DECLARE lifecycle_constraint text;
         BEGIN
           FOR lifecycle_constraint IN
             SELECT conname
             FROM pg_constraint
             WHERE conrelid='population_entity_state_v2'::regclass
               AND contype='c'
               AND pg_get_constraintdef(oid) LIKE '%killed_or_harvested_at%'
               AND pg_get_constraintdef(oid) LIKE '%respawn_at%'
           LOOP
             EXECUTE format(
               'ALTER TABLE population_entity_state_v2 DROP CONSTRAINT %I',
               lifecycle_constraint
             );
           END LOOP;
         END $$`
      );
      await malformedPool.query(
        `UPDATE population_entity_state_v2
         SET killed_or_harvested_at=NULL, respawn_at=NULL
         WHERE entity_id=$1::uuid`,
        [entityIds.safe]
      );
      await malformedPool.query(
        `UPDATE population_entity_state_v2
         SET state='dead'
         WHERE entity_id=$1::uuid`,
        [entityIds.suppressed]
      );
      await malformedPool.query(
        `ALTER TABLE population_entity_state_v2
         ENABLE TRIGGER USER`
      );

      let migrationError: unknown;
      try {
        await runMigrations(malformedUrl, {
          migrationsDirectory: targetMigrations
        });
      } catch (error) {
        migrationError = error;
      }
      expect(migrationError).toMatchObject({
        code: "23514",
        constraint:
          "population_entity_state_v2_permanent_resource_retained_lifecycle",
        detail: expect.stringContaining(entityIds.safe)
      });
      const detail = (migrationError as { detail: string }).detail;
      expect(detail).toContain(entityIds.suppressed);
      for (const field of [
        "resource_type",
        "canonical_state",
        "killed_or_harvested_at",
        "respawn_at",
        "canonical_revision",
        "projection_revision",
        "zone_id",
        "selected_plan_id",
        "cutover_revision"
      ]) {
        expect(detail).toContain(field);
      }
      const retained = await malformedPool.query<{
        state: string;
        killed_or_harvested_at: Date | null;
        respawn_at: Date | null;
      }>(
        `SELECT state, killed_or_harvested_at, respawn_at
         FROM population_entity_state_v2
         WHERE entity_id=$1::uuid`,
        [entityIds.safe]
      );
      expect(retained.rows[0]).toEqual({
        state: "harvested",
        killed_or_harvested_at: null,
        respawn_at: null
      });
    } finally {
      await malformedPool?.end();
      await admin!.query(
        `DROP DATABASE IF EXISTS ${
          quoteIdentifier(malformedDatabaseName)
        } WITH (FORCE)`
      );
    }
  }, 120_000);

  it("enforces exact ready and harvested permanent-resource shapes", async () => {
    const entityId = entityIds.safe;
    const constraint =
      "population_entity_state_v2_permanent_resource_regeneration";
    const rejected = [
      {
        state: "harvested",
        harvestedAt: null,
        respawnAt: "2026-07-29T17:50:00.000Z"
      },
      {
        state: "harvested",
        harvestedAt: "2026-07-29T12:00:00.000Z",
        respawnAt: null
      },
      {
        state: "harvested",
        harvestedAt: "2026-07-29T12:00:00.000Z",
        respawnAt: "2026-07-29T17:49:59.999Z"
      },
      {
        state: "ready",
        harvestedAt: null,
        respawnAt: "2026-07-29T17:50:00.000Z"
      },
      {
        state: "ready",
        harvestedAt: "2026-07-29T12:00:00.000Z",
        respawnAt: null
      }
    ] as const;
    for (const row of rejected) {
      await expect(pool!.query(
        `UPDATE population_entity_state_v2
         SET state=$2,
             killed_or_harvested_at=$3::timestamptz,
             respawn_at=$4::timestamptz
         WHERE entity_id=$1::uuid`,
        [entityId, row.state, row.harvestedAt, row.respawnAt]
      )).rejects.toMatchObject({ code: "23514", constraint });
    }

    await expect(pool!.query(
      `UPDATE population_entity_state_v2
       SET state='ready', state_revision=state_revision + 1,
           state_actor_player_id=NULL,
           killed_or_harvested_at=NULL, respawn_at=NULL
       WHERE entity_id=$1::uuid`,
      [entityId]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool!.query(
      `UPDATE population_entity_state_v2
       SET state='harvested', state_revision=state_revision + 1,
           killed_or_harvested_at='2026-07-29T12:00:00.000Z',
           respawn_at='2026-07-29T17:50:00.000Z'
       WHERE entity_id=$1::uuid`,
      [entityId]
    )).resolves.toMatchObject({ rowCount: 1 });
    expect(await canonicalState(entityId)).toMatchObject({
      state: "harvested",
      harvested_at: new Date("2026-07-29T12:00:00.000Z"),
      respawn_at: new Date("2026-07-29T17:50:00.000Z")
    });
    expect(await projectionState(entityId)).toMatchObject({
      ready_at: new Date("2026-07-29T17:50:00.000Z")
    });
  }, 30_000);

  async function projectionState(entityId: string): Promise<{
    ready_at: Date | number;
    harvest_revision: string;
    population_v2_state_revision: string;
  }> {
    const result = await pool!.query<{
      ready_at: Date | number;
      harvest_revision: string;
      population_v2_state_revision: string;
    }>(
      `SELECT ready_at, harvest_revision::text,
              population_v2_state_revision::text
       FROM repeatable_resource_nodes
       WHERE id=$1::uuid`,
      [entityId]
    );
    return result.rows[0]!;
  }

  async function canonicalState(entityId: string): Promise<{
    state: string;
    harvested_at: Date | null;
    respawn_at: Date | null;
    state_revision: string;
  }> {
    const result = await pool!.query<{
      state: string;
      harvested_at: Date | null;
      respawn_at: Date | null;
      state_revision: string;
    }>(
      `SELECT state,
              killed_or_harvested_at AS harvested_at,
              respawn_at,
              state_revision::text
       FROM population_entity_state_v2
       WHERE entity_id=$1::uuid`,
      [entityId]
    );
    return result.rows[0]!;
  }

  async function seedStalePermanentResources(
    target: pg.Pool
  ): Promise<void> {
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
         $1::uuid,$2,$3,$4,$5,'migration-0713-plan',
         'migration-0713-spawn','migration-0713-profile',
         'migration-0713-layout','migration-0713-respawn',
         'migration-0713',$6,$7,
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

    let index = 0;
    for (const [scenario, entityId] of Object.entries(entityIds)) {
      const slotId = randomUUID();
      const longitude = -106.6504 + index * 0.002;
      index += 1;
      await target.query(
        `INSERT INTO population_spawn_slots_v2 (
           plan_id, generation_id, slot_id, entity_id, candidate_id,
           entity_kind, archetype, latitude, longitude, geom,
           anchor_latitude, anchor_longitude, anchor_geom,
           environment_snapshot, suppression_class
         ) VALUES (
           $1::uuid,NULL,$2::uuid,$3::uuid,$4,
           'stone','stone_mine',35.0844,$5,
           ST_SetSRID(ST_MakePoint($5,35.0844),4326)::geography,
           35.0844,$5,
           ST_SetSRID(ST_MakePoint($5,35.0844),4326)::geography,
           '{}'::jsonb,'none'
         )`,
        [planId, slotId, entityId, `migration-0713-${scenario}`, longitude]
      );
      await target.query(
        `INSERT INTO population_entity_state_v2 (entity_id, state)
         VALUES ($1::uuid,'ready')`,
        [entityId]
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
           35.0844,$6,35.0844,$6,'{}'::jsonb,'none'
         )`,
        [
          entityId,
          slotId,
          `migration-0713-${scenario}`,
          zoneId,
          "a".repeat(64),
          longitude
        ]
      );
      if (scenario !== "planMismatch") {
        await target.query(
          `INSERT INTO population_plan_permanent_stones_v2 (
             plan_id, entity_id
           ) VALUES ($1::uuid,$2::uuid)`,
          [planId, entityId]
        );
      }
      await target.query(
        `UPDATE population_entity_state_v2
         SET state='harvested', state_revision=7,
             killed_or_harvested_at='2026-07-29T12:00:00.000Z',
             respawn_at='2026-07-29T17:50:00.000Z'
         WHERE entity_id=$1::uuid`,
        [entityId]
      );
      if (scenario === "staleDeadline") {
        await target.query(
          `ALTER TABLE population_entity_state_v2
           DISABLE TRIGGER population_entity_state_v2_validate_lifecycle`
        );
        await target.query(
          `UPDATE population_entity_state_v2
           SET respawn_at='2026-07-29T18:00:00.000Z'
           WHERE entity_id=$1::uuid`,
          [entityId]
        );
        await target.query(
          `ALTER TABLE population_entity_state_v2
           ENABLE TRIGGER population_entity_state_v2_validate_lifecycle`
        );
      }
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
           $1::uuid,'stone_mine','migration-0713',35.0844,$2,
           ST_SetSRID(ST_MakePoint($2,35.0844),4326),
           'stone',$3,interval '5 hours 50 minutes',
           '-infinity'::timestamptz,0,NULL,'population-v2',
           'migration-0713:' || $1::text,'migration-0713-layout',
           $1::uuid,$4,$5::uuid,0,1,false,$6
         )`,
        [
          entityId,
          longitude,
          scenario === "definitionMismatch" ? 2 : 1,
          zoneId,
          planId,
          scenario === "suppressed"
        ]
      );
    }
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
