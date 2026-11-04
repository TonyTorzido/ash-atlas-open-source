import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.LEVEL_CAP_40_MIGRATION_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const PREVIOUS_MIGRATION = "0878_player_biome_discoveries.sql";
const TARGET_MIGRATION = "0879_level_cap_40.sql";

describeDatabase("level cap 40 populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_level_cap_40_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let migrationDirectory = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  const bankedPlayerId = `level-cap-banked-${suffix}`;
  const cappedPlayerId = `level-cap-capped-${suffix}`;
  const mobEntityId = randomUUID();
  const equipmentId = randomUUID();

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-level-cap-40-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name <= PREVIOUS_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(migrationDirectory, name));
    }
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter')
       THEN CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN; END IF; END $$`
    );
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    for (const [playerId, totalXp] of [[bankedPlayerId, 2_000_000], [cappedPlayerId, 1_000_000]] as const) {
      const accountId = randomUUID();
      await pool.query(
        `INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')`,
        [accountId]
      );
      await pool.query(
        `INSERT INTO players (
           id,account_id,username,username_normalized,display_color,region_code,
           lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
         ) VALUES (
           $1,$2,$1,$1,'#38bdf8','GLOBAL',35,-106,35,-106,650,false,
           ST_SetSRID(ST_MakePoint(-106,35),4326)
         )`,
        [playerId, accountId]
      );
      await pool.query(
        `INSERT INTO player_progression_profiles (player_id,total_xp,level)
         VALUES ($1,$2,25)
         ON CONFLICT (player_id) DO UPDATE SET total_xp=excluded.total_xp, level=25`,
        [playerId, totalXp]
      );
    }
    await pool.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action) VALUES ($1,$2,'starter_loadout')`,
      [`level-cap-equipment:${suffix}`, bankedPlayerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,
         inventory_slot_index,created_by_operation_key,item_level
       ) VALUES ($1,'starter_sword',$2,'equipped','melee',NULL,$3,25)`,
      [equipmentId, bankedPlayerId, `level-cap-equipment:${suffix}`]
    );
    await seedClaimedMob(pool, mobEntityId, suffix);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("widens level ranges, re-tiers claimed mobs, re-derives banked levels, and has an empty second run", async () => {
    await expect(pool.query(
      `UPDATE equipment_instances SET item_level=26 WHERE instance_id=$1`,
      [equipmentId]
    )).rejects.toMatchObject({ code: "23514" });

    await copyFile(
      path.join(migrations, TARGET_MIGRATION),
      path.join(migrationDirectory, TARGET_MIGRATION)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    const progression = await pool.query<{ player_id: string; total_xp: string; level: number }>(
      `SELECT player_id,total_xp::text,level FROM player_progression_profiles
       WHERE player_id = ANY($1::text[]) ORDER BY player_id`,
      [[bankedPlayerId, cappedPlayerId]]
    );
    expect(Object.fromEntries(progression.rows.map((row) => [row.player_id, [row.total_xp, row.level]])))
      .toEqual({
        [bankedPlayerId]: ["2000000", 30],
        [cappedPlayerId]: ["1000000", 25]
      });
    await expect(pool.query(
      `SELECT combat_level,combat_tier FROM generated_world_mobs WHERE entity_id=$1`,
      [mobEntityId]
    )).resolves.toMatchObject({ rows: [{ combat_level: 7, combat_tier: "common" }] });

    await pool.query(`UPDATE equipment_instances SET item_level=40 WHERE instance_id=$1`, [equipmentId]);
    await pool.query(`UPDATE player_progression_profiles SET level=40 WHERE player_id=$1`, [bankedPlayerId]);
    await pool.query(
      `UPDATE generated_world_mobs SET combat_level=40, combat_tier='legendary' WHERE entity_id=$1`,
      [mobEntityId]
    );
    await expect(pool.query(
      `UPDATE equipment_instances SET item_level=41 WHERE instance_id=$1`,
      [equipmentId]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `UPDATE generated_world_mobs SET combat_level=20, combat_tier='epic' WHERE entity_id=$1`,
      [mobEntityId]
    )).rejects.toMatchObject({ code: "23514" });

    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([]);
  });
});

async function seedClaimedMob(pool: pg.Pool, entityId: string, suffix: string): Promise<void> {
  const planId = randomUUID();
  const generationId = randomUUID();
  const zoneId = `level-cap-zone-${suffix}`;
  await pool.query(
    `INSERT INTO population_zones_v2 (
       plan_id, zone_id, geometry_version,
       world_environment_identity_key, world_runtime_sha,
       plan_version, spawn_rules_version, environment_profile_version,
       candidate_layout_version, respawn_policy_version,
       region_code, band_index, column_index, zone_geog, center_geog,
       total_area_km2, status, next_retry_at
     ) VALUES (
       $1, $2, 'level-cap-geometry', repeat('a', 64), repeat('b', 40),
       'level-cap-plan', 'level-cap-rules', 'level-cap-environment',
       'level-cap-candidates', 'level-cap-respawn', 'NM', 879, 1,
       ST_Multi(ST_GeomFromText(
         'POLYGON((-106.66 35.08,-106.64 35.08,-106.64 35.09,-106.66 35.09,-106.66 35.08))',
         4326
       ))::geography,
       ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)::geography,
       1, 'pending', clock_timestamp()
     )`,
    [planId, zoneId]
  );
  await pool.query(
    `INSERT INTO population_zone_generations_v2 (
       generation_id, zone_id, plan_id, generation_number,
       generated_at, expires_at, status, planned_nonstone_count
     ) VALUES ($1, $2, $3, 1, now(), now() + interval '48 hours', 'active', 1)`,
    [generationId, zoneId, planId]
  );
  await pool.query(
    `ALTER TABLE population_spawn_slots_v2 DISABLE TRIGGER USER;
     ALTER TABLE population_entity_state_v2 DISABLE TRIGGER USER;
     ALTER TABLE generated_world_mobs DISABLE TRIGGER USER`
  );
  try {
    await pool.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id, slot_id, entity_id, candidate_id, entity_kind, archetype, encounter_id,
         latitude, longitude, geom, anchor_latitude, anchor_longitude, anchor_geom,
         environment_snapshot, suppression_class, generation_id
       ) VALUES (
         $1, gen_random_uuid(), $2, 'level-cap-candidate', 'deer', 'deer', gen_random_uuid(),
         35.0844, -106.6504, ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)::geography,
         35.0844, -106.6504, ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)::geography,
         '{}'::jsonb, 'deer-safe', $3
       )`,
      [planId, entityId, generationId]
    );
    await pool.query(
      `INSERT INTO population_entity_state_v2 (entity_id, state, state_revision)
       VALUES ($1, 'ready', 0)`,
      [entityId]
    );
    await pool.query(
      `INSERT INTO generated_world_mobs (
         entity_id, encounter_id, mob_archetype, pack_id,
         spawn_cell_id, region_code, lat, lon, geom,
         anchor_lat, anchor_lon, placement_version,
         population_v2_entity_id, physical_population_zone_v2_id,
         population_v2_plan_id, population_v2_state_revision,
         population_cutover_revision,
         combat_level, combat_tier, combat_balance_version,
         combat_profile_claimed_at, combat_profile_source
       ) VALUES (
         $1::text, 'encounter:level-cap', 'deer', NULL,
         'level-cap-cell', 'NM', 35.0844, -106.6504,
         ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326),
         35.0844, -106.6504, 'level-cap',
         $1::uuid, $2, $3, 0, 1,
         7, 'uncommon', 2, now(), 'zone_player_profile'
       )`,
      [entityId, zoneId, planId]
    );
  } finally {
    await pool.query(
      `ALTER TABLE generated_world_mobs ENABLE TRIGGER USER;
       ALTER TABLE population_entity_state_v2 ENABLE TRIGGER USER;
       ALTER TABLE population_spawn_slots_v2 ENABLE TRIGGER USER`
    );
  }
}

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("LEVEL_CAP_40_MIGRATION_TEST_ADMIN_URL must be a PostgreSQL URL");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Level cap migration test requires a loopback admin database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
