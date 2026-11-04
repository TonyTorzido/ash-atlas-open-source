import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "1021_level_cap_40_gear_25.sql";

describeDatabase("level cap 40 with gear at 25 populated migration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_level_cap_40_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let migrationDirectory = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  const level30PlayerId = `level-cap-40-a-${suffix}`;
  const level40PlayerId = `level-cap-40-b-${suffix}`;
  const level25PlayerId = `level-cap-40-c-${suffix}`;
  const almost26PlayerId = `level-cap-40-d-${suffix}`;
  const players = [level30PlayerId, level40PlayerId, level25PlayerId, almost26PlayerId];
  const bankedEquipmentId = randomUUID();
  const highMobEntityId = randomUUID();
  const lowMobEntityId = randomUUID();

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-level-cap-40-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
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
    // Everyone was clamped to Level 25 by 0885 with lifetime XP still banked.
    for (const [playerId, totalXp, earned, spent] of [
      [level30PlayerId, 2_000_000, 25, 25],
      [level40PlayerId, 6_500_000, 25, 3],
      [level25PlayerId, 1_000_000, 25, 3],
      [almost26PlayerId, 1_129_901, 25, 0]
    ] as const) {
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
         ON CONFLICT (player_id) DO UPDATE SET total_xp=excluded.total_xp, level=excluded.level`,
        [playerId, totalXp]
      );
      if (spent > 0) {
        await pool.query(
          `INSERT INTO player_skill_ranks (player_id,skill_id,rank,points_spent)
           VALUES ($1,'level_cap_test_skill',1,$2)`,
          [playerId, spent]
        );
      }
      await pool.query(
        `INSERT INTO player_skill_point_state (player_id,total_earned,total_spent)
         VALUES ($1,$2,$3)
         ON CONFLICT (player_id) DO UPDATE SET total_earned=excluded.total_earned, total_spent=excluded.total_spent`,
        [playerId, earned, spent]
      );
    }
    // A Level 30 sword clamped and banked by 0885.
    await pool.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action) VALUES ($1,$2,'starter_loadout')`,
      [`level-cap-40-equipment:${suffix}`, level30PlayerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,
         inventory_slot_index,created_by_operation_key,item_level
       ) VALUES ($1,'starter_sword',$2,'equipped','melee',NULL,$3,25)`,
      [bankedEquipmentId, level30PlayerId, `level-cap-40-equipment:${suffix}`]
    );
    await pool.query(
      `INSERT INTO equipment_level_cap_banked_levels (instance_id,banked_item_level,clamped_to_level)
       VALUES ($1,30,25)`,
      [bankedEquipmentId]
    );
    await pool.query(
      `INSERT INTO player_equipment_state (player_id,current_combat_gear_level,unlocked_combat_gear_level)
       VALUES ($1,25,25)
       ON CONFLICT (player_id) DO UPDATE
       SET current_combat_gear_level=25, unlocked_combat_gear_level=25`,
      [level30PlayerId]
    );
    await seedClaimedMobs(pool, suffix, [
      { entityId: highMobEntityId, level: 25, tier: "legendary" },
      { entityId: lowMobEntityId, level: 7, tier: "uncommon" }
    ]);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
  });

  it("restores character levels and skill points to 40, keeps gear and mobs at 25, and has an empty second run", async () => {
    await copyFile(
      path.join(migrations, TARGET_MIGRATION),
      path.join(migrationDirectory, TARGET_MIGRATION)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([TARGET_MIGRATION]);

    const progression = await pool.query<{ player_id: string; total_xp: string; level: number }>(
      `SELECT player_id,total_xp::text,level FROM player_progression_profiles
       WHERE player_id = ANY($1::text[])`,
      [players]
    );
    expect(Object.fromEntries(progression.rows.map((row) => [row.player_id, [row.total_xp, row.level]])))
      .toEqual({
        [level30PlayerId]: ["2000000", 30],
        [level40PlayerId]: ["6500000", 40],
        [level25PlayerId]: ["1000000", 25],
        [almost26PlayerId]: ["1129901", 25]
      });

    const skillPoints = await pool.query<{ player_id: string; total_earned: number; total_spent: number }>(
      `SELECT player_id,total_earned,total_spent FROM player_skill_point_state
       WHERE player_id = ANY($1::text[])`,
      [players]
    );
    expect(Object.fromEntries(skillPoints.rows.map((row) => [row.player_id, [row.total_earned, row.total_spent]])))
      .toEqual({
        [level30PlayerId]: [30, 25],
        [level40PlayerId]: [40, 3],
        [level25PlayerId]: [25, 3],
        [almost26PlayerId]: [25, 0]
      });

    // Gear stays capped at 25: the banked level is not restored.
    await expect(pool.query(
      `SELECT equipment.item_level,banked.banked_item_level
       FROM equipment_instances AS equipment
       JOIN equipment_level_cap_banked_levels AS banked USING (instance_id)
       WHERE equipment.instance_id=$1`,
      [bankedEquipmentId]
    )).resolves.toMatchObject({ rows: [{ item_level: 25, banked_item_level: 30 }] });
    await expect(pool.query(
      `SELECT current_combat_gear_level,unlocked_combat_gear_level FROM player_equipment_state WHERE player_id=$1`,
      [level30PlayerId]
    )).resolves.toMatchObject({ rows: [{ current_combat_gear_level: 25, unlocked_combat_gear_level: 25 }] });

    // Monsters keep their claimed levels and the 25-cap tier bands.
    const mobs = await pool.query<{ entity_id: string; combat_level: number; combat_tier: string }>(
      `SELECT entity_id,combat_level,combat_tier FROM generated_world_mobs WHERE entity_id = ANY($1::text[])`,
      [[highMobEntityId, lowMobEntityId]]
    );
    expect(Object.fromEntries(mobs.rows.map((row) => [row.entity_id, [row.combat_level, row.combat_tier]])))
      .toEqual({
        [highMobEntityId]: [25, "legendary"],
        [lowMobEntityId]: [7, "uncommon"]
      });
    await expect(pool.query(
      `UPDATE generated_world_mobs SET combat_level=8, combat_tier='common' WHERE entity_id=$1`,
      [lowMobEntityId]
    )).rejects.toMatchObject({ code: "23514" });

    await expect(runMigrations(databaseUrl, { migrationsDirectory: migrationDirectory }))
      .resolves.toEqual([]);
  });
});

async function seedClaimedMobs(
  pool: pg.Pool,
  suffix: string,
  mobs: ReadonlyArray<{ entityId: string; level: number; tier: string }>
): Promise<void> {
  const planId = randomUUID();
  const generationId = randomUUID();
  const zoneId = `level-cap-40-zone-${suffix}`;
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
       'level-cap-candidates', 'level-cap-respawn', 'NM', 1021, 1,
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
     ) VALUES ($1, $2, $3, 1, now(), now() + interval '48 hours', 'active', $4)`,
    [generationId, zoneId, planId, mobs.length]
  );
  await pool.query(
    `ALTER TABLE population_spawn_slots_v2 DISABLE TRIGGER USER;
     ALTER TABLE population_entity_state_v2 DISABLE TRIGGER USER;
     ALTER TABLE generated_world_mobs DISABLE TRIGGER USER`
  );
  try {
    for (const [index, mob] of mobs.entries()) {
      await pool.query(
        `INSERT INTO population_spawn_slots_v2 (
           plan_id, slot_id, entity_id, candidate_id, entity_kind, archetype, encounter_id,
           latitude, longitude, geom, anchor_latitude, anchor_longitude, anchor_geom,
           environment_snapshot, suppression_class, generation_id
         ) VALUES (
           $1, gen_random_uuid(), $2, $4, 'deer', 'deer', gen_random_uuid(),
           35.0844, -106.6504, ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)::geography,
           35.0844, -106.6504, ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326)::geography,
           '{}'::jsonb, 'deer-safe', $3
         )`,
        [planId, mob.entityId, generationId, `level-cap-40-candidate-${index}`]
      );
      await pool.query(
        `INSERT INTO population_entity_state_v2 (entity_id, state, state_revision)
         VALUES ($1, 'ready', 0)`,
        [mob.entityId]
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
           $1::text, $6, 'deer', NULL,
           'level-cap-cell', 'NM', 35.0844, -106.6504,
           ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326),
           35.0844, -106.6504, 'level-cap',
           $1::uuid, $2, $3, 0, 1,
           $4, $5, 2, now(), 'zone_player_profile'
         )`,
        [mob.entityId, zoneId, planId, mob.level, mob.tier, `encounter:level-cap-40-${index}`]
      );
    }
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
    throw new Error("MIGRATION_RUNNER_TEST_ADMIN_URL must be a PostgreSQL URL");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Level cap migration test requires a loopback admin database");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("Level cap migration test requires a disposable ash_atlas_stability admin database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
