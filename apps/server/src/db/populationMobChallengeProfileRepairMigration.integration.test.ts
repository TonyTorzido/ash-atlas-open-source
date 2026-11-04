import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0714_repair_background_mob_profiles.sql";

describeDatabase("0714 background mob-profile repair", () => {
  const databaseName =
    `ash_atlas_stability_population_0714_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const repoMigrations = path.resolve(process.cwd(), "../../db/migrations");
  let precedingMigrations = "";
  let targetMigrations = "";
  let databaseUrl = "";
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    precedingMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0714-before-")
    );
    targetMigrations = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-population-0714-target-")
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
    await seedMobProfiles(pool);
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

  it("clears only living unsuppressed level-zero background claims", async () => {
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([TARGET_MIGRATION]);

    const result = await pool!.query<{
      entity_id: string;
      combat_level: number | null;
      combat_tier: string | null;
      combat_balance_version: number | null;
      combat_profile_claimed_at: Date | null;
      combat_profile_source: string | null;
      killed_at: Date | null;
      population_v2_suppressed: boolean;
      population_v2_plan_id: string;
      population_v2_entity_id: string;
      population_v2_state_revision: string;
      population_cutover_revision: string;
      encounter_id: string;
      spawn_cell_id: string;
      lat: number;
      lon: number;
    }>(
      `SELECT entity_id, combat_level, combat_tier,
              combat_balance_version, combat_profile_claimed_at,
              combat_profile_source, killed_at,
              population_v2_suppressed,
              population_v2_plan_id::text,
              population_v2_entity_id::text,
              population_v2_state_revision::text,
              population_cutover_revision::text,
              encounter_id, spawn_cell_id, lat, lon
       FROM generated_world_mobs
       WHERE spawn_cell_id LIKE 'migration-0714-%'
       ORDER BY spawn_cell_id`
    );

    expect(profileState(result.rows, "migration-0714-background-living"))
      .toEqual({
        combat_level: null,
        combat_tier: null,
        combat_balance_version: null,
        combat_profile_claimed_at: null,
        combat_profile_source: null
      });
    expect(profileState(result.rows, "migration-0714-player-zero"))
      .toMatchObject({
        combat_level: 0,
        combat_tier: "common",
        combat_balance_version: 2,
        combat_profile_source: "zone_player_profile"
      });
    expect(profileState(result.rows, "migration-0714-player-nine"))
      .toMatchObject({
        combat_level: 9,
        combat_tier: "uncommon",
        combat_balance_version: 2,
        combat_profile_source: "zone_player_profile"
      });
    expect(profileState(result.rows, "migration-0714-background-killed"))
      .toMatchObject({
        combat_level: 0,
        combat_profile_source: "background_fallback"
      });
    expect(profileState(result.rows, "migration-0714-background-suppressed"))
      .toMatchObject({
        combat_level: 0,
        combat_profile_source: "background_fallback"
      });
    expect(profileState(result.rows, "migration-0714-background-one"))
      .toMatchObject({
        combat_level: 1,
        combat_profile_source: "background_fallback"
      });
    expect(result.rows.every((row) =>
      row.population_v2_plan_id === "00000000-0000-4000-8000-000000000714"
      && row.population_v2_entity_id === row.entity_id
      && row.population_v2_state_revision === "0"
      && row.population_cutover_revision === "1"
      && row.encounter_id === `encounter:${row.spawn_cell_id}`
      && row.lat === 35.0844
      && row.lon === -106.6504
    )).toBe(true);

    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: targetMigrations
    })).resolves.toEqual([]);
  }, 30_000);
});

async function seedMobProfiles(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id, username, lat, lon, anchor_lat, anchor_lon,
       move_leash_radius_m, geom
     ) VALUES (
       'migration-0714-player', 'migration-0714-player',
       35.0844, -106.6504, 35.0844, -106.6504, 1000,
       ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)
     );
     INSERT INTO population_zones_v2 (
       plan_id, zone_id, geometry_version,
       world_environment_identity_key, world_runtime_sha,
       plan_version, spawn_rules_version, environment_profile_version,
       candidate_layout_version, respawn_policy_version,
       region_code, band_index, column_index, zone_geog, center_geog,
       total_area_km2, status, next_retry_at
     ) VALUES (
       '00000000-0000-4000-8000-000000000714',
       'migration-0714-zone', 'migration-0714-geometry',
       repeat('a', 64), repeat('b', 40),
       'migration-0714-plan', 'migration-0714-rules',
       'migration-0714-environment', 'migration-0714-candidates',
       'migration-0714-respawn', 'NM', 714, 1,
       ST_Multi(ST_GeomFromText(
         'POLYGON((-106.66 35.08,-106.64 35.08,-106.64 35.09,-106.66 35.09,-106.66 35.08))',
         4326
       ))::geography,
       ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)::geography,
       1, 'pending', clock_timestamp()
     );
     INSERT INTO population_zone_generations_v2 (
       generation_id, zone_id, plan_id, generation_number,
       generated_at, expires_at, status, planned_nonstone_count
     ) VALUES (
       '00000000-0000-4000-8000-000000000715',
       'migration-0714-zone',
       '00000000-0000-4000-8000-000000000714',
       1, '2026-07-29T12:00:00Z'::timestamptz,
       '2026-07-31T12:00:00Z'::timestamptz, 'active', 6
     );
     ALTER TABLE population_spawn_slots_v2 DISABLE TRIGGER USER;
     ALTER TABLE population_entity_state_v2 DISABLE TRIGGER USER;
     ALTER TABLE generated_world_mobs DISABLE TRIGGER USER`
  );
  try {
    await pool.query(
      `CREATE TEMP TABLE migration_0714_fixtures (
         fixture_id text PRIMARY KEY,
         entity_id uuid NOT NULL,
         combat_level smallint NOT NULL,
         combat_tier text NOT NULL,
         combat_profile_source text NOT NULL,
         killed_at timestamptz NULL,
         killed_by_player_id text NULL,
         suppressed boolean NOT NULL
       ) ON COMMIT DROP;
       INSERT INTO migration_0714_fixtures VALUES
         ('migration-0714-background-living', '00000000-0000-4000-8000-000000000701', 0, 'common', 'background_fallback', NULL, NULL, false),
         ('migration-0714-player-zero', '00000000-0000-4000-8000-000000000702', 0, 'common', 'zone_player_profile', NULL, NULL, false),
         ('migration-0714-player-nine', '00000000-0000-4000-8000-000000000703', 9, 'uncommon', 'zone_player_profile', NULL, NULL, false),
         ('migration-0714-background-killed', '00000000-0000-4000-8000-000000000704', 0, 'common', 'background_fallback', '2026-07-29T13:00:00Z', 'migration-0714-player', false),
         ('migration-0714-background-suppressed', '00000000-0000-4000-8000-000000000705', 0, 'common', 'background_fallback', NULL, NULL, true),
         ('migration-0714-background-one', '00000000-0000-4000-8000-000000000706', 1, 'common', 'background_fallback', NULL, NULL, false);
       INSERT INTO population_spawn_slots_v2 (
         plan_id, slot_id, entity_id, candidate_id,
         entity_kind, archetype, encounter_id,
         latitude, longitude, geom, anchor_latitude, anchor_longitude,
         anchor_geom, environment_snapshot, suppression_class,
         generation_id
       )
       SELECT
         '00000000-0000-4000-8000-000000000714',
         gen_random_uuid(),
         fixture.entity_id,
         fixture.fixture_id,
         'deer',
         'deer',
         gen_random_uuid(),
         35.0844,
         -106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)::geography,
         35.0844,
         -106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)::geography,
         '{}'::jsonb,
         'deer-safe',
         '00000000-0000-4000-8000-000000000715'
       FROM migration_0714_fixtures AS fixture;
       INSERT INTO population_entity_state_v2 (
         entity_id, state, state_revision, state_actor_player_id,
         killed_or_harvested_at, respawn_at
       )
       SELECT
         fixture.entity_id,
         CASE WHEN fixture.killed_at IS NULL THEN 'ready' ELSE 'dead' END,
         0,
         fixture.killed_by_player_id,
         fixture.killed_at,
         NULL
       FROM migration_0714_fixtures AS fixture;
       INSERT INTO generated_world_mobs (
         entity_id, encounter_id, mob_archetype, pack_id,
         spawn_cell_id, region_code, lat, lon, geom,
         anchor_lat, anchor_lon, placement_version,
         killed_at, killed_by_player_id, population_flag_suppressed,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision,
         combat_level, combat_tier, combat_balance_version,
         combat_profile_claimed_at, combat_profile_source
       )
       SELECT
         fixture.entity_id::text,
         'encounter:' || fixture.fixture_id,
         'deer',
         NULL,
         fixture.fixture_id,
         'NM',
         35.0844,
         -106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326),
         35.0844,
         -106.6504,
         'migration-0714',
         fixture.killed_at,
         fixture.killed_by_player_id,
         fixture.suppressed,
         fixture.entity_id,
         'migration-0714-zone',
         '00000000-0000-4000-8000-000000000714',
         0,
         1,
         fixture.combat_level,
         fixture.combat_tier,
         2,
         '2026-07-29T12:00:00Z'::timestamptz,
         fixture.combat_profile_source
       FROM migration_0714_fixtures AS fixture`
    );
  } finally {
    await pool.query(
      `ALTER TABLE generated_world_mobs ENABLE TRIGGER USER;
       ALTER TABLE population_entity_state_v2 ENABLE TRIGGER USER;
       ALTER TABLE population_spawn_slots_v2 ENABLE TRIGGER USER`
    );
  }
}

function profileState(
  rows: readonly Readonly<{
    entity_id: string;
    combat_level: number | null;
    combat_tier: string | null;
    combat_balance_version: number | null;
    combat_profile_claimed_at: Date | null;
    combat_profile_source: string | null;
    spawn_cell_id: string;
  }>[],
  fixtureId: string
) {
  const row = rows.find((candidate) =>
    candidate.spawn_cell_id === fixtureId
  );
  expect(row).toBeDefined();
  return {
    combat_level: row!.combat_level,
    combat_tier: row!.combat_tier,
    combat_balance_version: row!.combat_balance_version,
    combat_profile_claimed_at: row!.combat_profile_claimed_at,
    combat_profile_source: row!.combat_profile_source
  };
}

function assertStabilityLabAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = parsed.pathname.replace(/^\//u, "");
  if (!database.startsWith("ash_atlas_stability")) {
    throw new Error(
      "MIGRATION_RUNNER_TEST_ADMIN_URL must target an ash_atlas_stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
