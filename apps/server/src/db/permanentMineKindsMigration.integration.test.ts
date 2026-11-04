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
import {
  permanentMineKindForSlot,
  type PermanentMineKind
} from "../game/populationZonesV2Identity.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0735_permanent_mine_resource_kinds.sql";

describeDatabase("0735 permanent mine resource kinds", () => {
  const databaseName = `ash_atlas_stability_mines_0735_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  const zoneId = populationZoneV2IdForPoint({
    lat: 35.0844,
    lon: -106.6504
  });
  const planId = randomUUID();
  const identities = (["stone", "coal", "iron"] as const).map((kind) => {
    let slotId = randomUUID();
    while (permanentMineKindForSlot(slotId) !== kind) slotId = randomUUID();
    return { kind, slotId, entityId: randomUUID() };
  });
  let beforeDirectory = "";
  let targetDirectory = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    beforeDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-0735-before-"));
    targetDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-0735-target-"));
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
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedRetainedMines(pool);
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

  it("reclassifies retained projections without changing physical or lifecycle identity", async () => {
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetDirectory
    })).resolves.toEqual([TARGET_MIGRATION]);
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetDirectory
    })).resolves.toEqual([]);

    const result = await pool!.query<{
      entity_id: string;
      slot_id: string;
      entity_kind: PermanentMineKind;
      node_type: string;
      yield_item_id: PermanentMineKind;
      latitude: number | string;
      state: string;
      state_revision: string | number;
    }>(
      `SELECT authority.entity_id::text, authority.slot_id::text,
              authority.entity_kind, projection.node_type,
              projection.yield_item_id, authority.latitude,
              state.state, state.state_revision
       FROM population_permanent_resource_authority_v2 AS authority
       JOIN repeatable_resource_nodes AS projection
         ON projection.population_v2_entity_id=authority.entity_id
       JOIN population_entity_state_v2 AS state
         ON state.entity_id=authority.entity_id
       ORDER BY authority.entity_kind`
    );
    expect(result.rows).toHaveLength(3);
    for (const identity of identities) {
      expect(result.rows).toContainEqual({
        entity_id: identity.entityId,
        slot_id: identity.slotId,
        entity_kind: identity.kind,
        node_type: `${identity.kind}_mine`,
        yield_item_id: identity.kind,
        latitude: 35.0844,
        state: "ready",
        state_revision: "0"
      });
    }
    const sessions = await pool!.query<{
      operation_key: string;
      resource_type: PermanentMineKind;
    }>(
      `SELECT operation_key, resource_type
       FROM repeatable_resource_sessions
       ORDER BY operation_key`
    );
    expect(sessions.rows).toEqual([
      { operation_key: "active-coal", resource_type: "coal" },
      { operation_key: "active-iron", resource_type: "iron" },
      { operation_key: "active-stone", resource_type: "stone" },
      { operation_key: "completed-history", resource_type: "stone" }
    ]);
  });

  async function seedRetainedMines(target: pg.Pool): Promise<void> {
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
         $1::uuid,$2,$3,$4,$5,'migration-0735-plan',
         'migration-0735-spawn','migration-0735-profile',
         'migration-0735-layout','migration-0735-respawn','migration-0735',
         $6,$7,ST_Multi(ST_MakeEnvelope($8,$9,$10,$11,4326))::geography,
         ST_SetSRID(ST_MakePoint($12,$13),4326)::geography,
         $14,'pending',clock_timestamp()
       )`,
      [
        planId, zoneId, POPULATION_ZONE_V2_GEOMETRY_VERSION,
        "a".repeat(64), "b".repeat(40), geometry.address.band,
        geometry.address.column, geometry.bounds.westLon,
        geometry.bounds.southLat, geometry.bounds.eastLon,
        geometry.bounds.northLat, geometry.center.lon, geometry.center.lat,
        geometry.areaKm2
      ]
    );
    for (const [index, identity] of identities.entries()) {
      const longitude = -106.6504 + index * 0.001;
      const candidateId = `migration-0735-${identity.kind}`;
      await target.query(
        `INSERT INTO population_spawn_slots_v2 (
           plan_id, generation_id, slot_id, entity_id, candidate_id,
           entity_kind, archetype, latitude, longitude, geom,
           anchor_latitude, anchor_longitude, anchor_geom,
           environment_snapshot, suppression_class
         ) VALUES (
           $1::uuid,NULL,$2::uuid,$3::uuid,$4,'stone','stone_mine',
           35.0844,$5,ST_SetSRID(ST_MakePoint($5,35.0844),4326)::geography,
           35.0844,$5,ST_SetSRID(ST_MakePoint($5,35.0844),4326)::geography,
           '{}'::jsonb,'none'
         )`,
        [planId, identity.slotId, identity.entityId, candidateId, longitude]
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
          identity.entityId, identity.slotId, candidateId, zoneId,
          "a".repeat(64), longitude
        ]
      );
      await target.query(
        `INSERT INTO population_plan_permanent_stones_v2 (plan_id, entity_id)
         VALUES ($1::uuid,$2::uuid)`,
        [planId, identity.entityId]
      );
      await target.query(
        `INSERT INTO population_entity_state_v2 (entity_id, state)
         VALUES ($1::uuid,'ready')`,
        [identity.entityId]
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
           $1::uuid,'stone_mine','migration-0735',35.0844,$2,
           ST_SetSRID(ST_MakePoint($2,35.0844),4326),
           'stone',1,interval '5 hours 50 minutes','population-v2',
           'migration-0735:' || $1::text,'migration-0735-layout',
           $1::uuid,$3,$4::uuid,0,1
         )`,
        [identity.entityId, longitude, zoneId, planId]
      );
      const playerId = `migration-0735-player-${identity.kind}`;
      await target.query(
        `INSERT INTO players (
           id, username, lat, lon, anchor_lat, anchor_lon,
           move_leash_radius_m, geom
         ) VALUES (
           $1,$2,35.0844,$3,35.0844,$3,600,
           ST_SetSRID(ST_MakePoint($3,35.0844),4326)
         )`,
        [playerId, playerId, longitude]
      );
      await target.query(
        `INSERT INTO repeatable_resource_sessions (
           id, player_id, node_id, resource_type, operation_key,
           starting_revision, status, effective_duration_ms,
           started_at, completes_at, expires_at
         ) VALUES (
           $1::uuid,$2,$3::uuid,'stone',$4,0,'active',10000,
           '2026-08-08T00:00:00Z','2026-08-08T00:00:10Z',
           '2026-08-08T00:05:10Z'
         )`,
        [randomUUID(), playerId, identity.entityId, `active-${identity.kind}`]
      );
    }
    const completedNode = identities.find((identity) => identity.kind === "iron")!;
    const completedPlayer = "migration-0735-completed-player";
    await target.query(
      `INSERT INTO players (
         id, username, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, geom
       ) VALUES (
         $1,$1,35.0844,-106.6484,35.0844,-106.6484,600,
         ST_SetSRID(ST_MakePoint(-106.6484,35.0844),4326)
       )`,
      [completedPlayer]
    );
    await target.query(
      `INSERT INTO repeatable_resource_sessions (
         id, player_id, node_id, resource_type, operation_key,
         starting_revision, status, effective_duration_ms,
         started_at, completes_at, expires_at, completed_at
       ) VALUES (
         $1::uuid,$2,$3::uuid,'stone','completed-history',0,'completed',10000,
         '2026-08-07T00:00:00Z','2026-08-07T00:00:10Z',
         '2026-08-07T00:05:10Z','2026-08-07T00:00:10Z'
       )`,
      [randomUUID(), completedPlayer, completedNode.entityId]
    );
  }
});

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("unsafe disposable database name");
  }
  return `"${value}"`;
}
