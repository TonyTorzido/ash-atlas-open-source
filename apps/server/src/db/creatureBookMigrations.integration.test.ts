import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const FIRST_TARGET_MIGRATION = "0772_population_mob_first_runtime_admission.sql";
const TARGET_MIGRATIONS = [
  FIRST_TARGET_MIGRATION,
  "0773_creature_book.sql",
  "0774_class_innate_persistence.sql"
];
const RESET_MIGRATION = "0774_creature_book_clean_slate.sql";
const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Population admission and Creature Book populated migrations", () => {
  const migrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  const databaseName = `ash_atlas_stability_creature_book_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let precedingMigrations = "";
  let creatureBookMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  const playerId = `creature-book-migration-${randomUUID()}`;
  const planId = randomUUID();
  const generationId = randomUUID();
  const mobEntityId = randomUUID();
  const resourceEntityId = randomUUID();
  const encounterId = randomUUID();
  const eventId = randomUUID();
  const settlementKey = `creature-book-settlement-${randomUUID()}`;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-pre-creature-book-"));
    creatureBookMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-creature-book-"));
    for (const name of await readdir(migrations)) {
      if (name.endsWith(".sql") && name.localeCompare(FIRST_TARGET_MIGRATION) < 0) {
        await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
      }
      if (name.endsWith(".sql") && name.localeCompare(RESET_MIGRATION) < 0) {
        await copyFile(path.join(migrations, name), path.join(creatureBookMigrations, name));
      }
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    await seedPreMigrationRows();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) {
      await rm(precedingMigrations, { recursive: true, force: true });
    }
    if (creatureBookMigrations) {
      await rm(creatureBookMigrations, { recursive: true, force: true });
    }
  });

  it("backfills Creature Book history, resets it without touching sources, and reruns empty", async () => {
    await expect(runMigrations(databaseUrl, {
      migrationsDirectory: creatureBookMigrations
    })).resolves.toEqual(TARGET_MIGRATIONS);

    await expect(pool.query(
      `SELECT slot.entity_kind,state.first_runtime_admitted_at IS NOT NULL AS admitted
       FROM population_entity_state_v2 AS state
       JOIN population_spawn_slots_v2 AS slot ON slot.entity_id=state.entity_id
       WHERE state.entity_id IN ($1,$2)
       ORDER BY slot.entity_kind`,
      [mobEntityId, resourceEntityId]
    )).resolves.toMatchObject({
      rows: [
        { entity_kind: "deer", admitted: true },
        { entity_kind: "stone", admitted: false }
      ]
    });

    await expect(pool.query(
      `SELECT mob_archetype,source_kind,source_id
       FROM creature_book_kill_occurrences
       WHERE player_id=$1 ORDER BY mob_archetype`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [
        { mob_archetype: "deer", source_kind: "combat_settlement", source_id: settlementKey },
        { mob_archetype: "xoral", source_kind: "xoral_event", source_id: eventId }
      ]
    });
    await expect(pool.query(
      `SELECT mob_archetype FROM creature_book_sightings
       WHERE player_id=$1 ORDER BY mob_archetype`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ mob_archetype: "deer" }, { mob_archetype: "xoral" }] });
    await expect(pool.query(
      `SELECT source_kind,item_id FROM creature_book_drop_occurrences
       WHERE player_id=$1 ORDER BY source_kind,item_id`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [
        { source_kind: "combat_settlement", item_id: "deer_hide" },
        { source_kind: "combat_settlement", item_id: "leather" },
        { source_kind: "xoral_event", item_id: "attack_ring" }
      ]
    });

    await expect(pool.query(
      `SELECT
         (SELECT count(*)::integer FROM population_entity_state_v2
          WHERE entity_id IN ($1,$2)) AS population_states,
         (SELECT count(*)::integer FROM combat_reward_settlements
          WHERE settlement_key=$3 AND status='completed' AND reward_player_id=$5) AS settlements,
         (SELECT count(*)::integer FROM xoral_event_rewards
          WHERE event_id=$4 AND player_id=$5 AND authoritative_damage=125) AS xoral_rewards`,
      [mobEntityId, resourceEntityId, settlementKey, eventId, playerId]
    )).resolves.toMatchObject({
      rows: [{ population_states: 2, settlements: 1, xoral_rewards: 1 }]
    });

    await copyFile(path.join(migrations, RESET_MIGRATION), path.join(creatureBookMigrations, RESET_MIGRATION));
    await expect(runMigrations(databaseUrl, { migrationsDirectory: creatureBookMigrations })).resolves.toEqual([RESET_MIGRATION]);
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::integer FROM creature_book_sightings) AS sightings,
         (SELECT count(*)::integer FROM creature_book_kill_occurrences) AS kills,
         (SELECT count(*)::integer FROM creature_book_drop_occurrences) AS drops,
         (SELECT count(*)::integer FROM combat_reward_settlements
          WHERE settlement_key=$1 AND status='completed' AND reward_player_id=$3) AS settlements,
         (SELECT count(*)::integer FROM xoral_event_rewards
          WHERE event_id=$2 AND player_id=$3 AND authoritative_damage=125) AS xoral_rewards`,
      [settlementKey, eventId, playerId]
    )).resolves.toMatchObject({
      rows: [{ sightings: 0, kills: 0, drops: 0, settlements: 1, xoral_rewards: 1 }]
    });

    const newSourceId = `post-reset-${randomUUID()}`;
    await pool.query(
      `INSERT INTO creature_book_kill_occurrences (
         player_id,source_kind,source_id,mob_archetype
       ) VALUES ($1,'combat_settlement',$2,'deer')`,
      [playerId, newSourceId]
    );
    await pool.query(
      `INSERT INTO creature_book_drop_occurrences (
         player_id,source_kind,source_id,item_id
       ) VALUES ($1,'combat_settlement',$2,'deer_hide')`,
      [playerId, newSourceId]
    );
    await pool.query(
      `INSERT INTO creature_book_sightings (
         player_id,mob_archetype,first_source_entity_id
       ) VALUES ($1,'deer',$2)`,
      [playerId, newSourceId]
    );
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::integer FROM creature_book_sightings WHERE player_id=$1) AS sightings,
         (SELECT count(*)::integer FROM creature_book_kill_occurrences WHERE player_id=$1) AS kills,
         (SELECT count(*)::integer FROM creature_book_drop_occurrences WHERE player_id=$1) AS drops`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ sightings: 1, kills: 1, drops: 1 }] });

    await expect(runMigrations(databaseUrl, { migrationsDirectory: creatureBookMigrations })).resolves.toEqual([]);
  }, 120_000);

  async function seedPreMigrationRows(): Promise<void> {
    const accountId = randomUUID();
    const username = `bookmigration${randomUUID().slice(0, 8)}`;
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query(
      `INSERT INTO players (
         id,account_id,username,username_normalized,display_color,region_code,
         lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom
       ) VALUES ($1,$2,$3,$3,'#38bdf8','NM',35,-106,35,-106,900,false,
         ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId, username]
    );
    await pool.query(
      `INSERT INTO population_zones_v2 (
         plan_id,zone_id,geometry_version,world_environment_identity_key,world_runtime_sha,
         plan_version,spawn_rules_version,environment_profile_version,candidate_layout_version,
         respawn_policy_version,region_code,band_index,column_index,zone_geog,center_geog,
         total_area_km2,status,next_retry_at
       ) VALUES (
         $1,'migration-zone','geometry-v1',repeat('a',64),repeat('b',40),
         'plan-v1','rules-v1','profile-v1','layout-v1','respawn-v1','NM',0,0,
         ST_Multi(ST_Buffer(ST_SetSRID(ST_MakePoint(-106,35),4326),0.01))::geography,
         ST_SetSRID(ST_MakePoint(-106,35),4326)::geography,1,'pending',now()
       )`,
      [planId]
    );
    await pool.query(
      `INSERT INTO population_zone_generations_v2 (
         generation_id,zone_id,plan_id,generation_number,generated_at,expires_at,status,
         planned_nonstone_count
       ) VALUES ($1,'migration-zone',$2,1,now(),now()+interval '48 hours','active',1)`,
      [generationId, planId]
    );
    await pool.query(
      `INSERT INTO population_spawn_slots_v2 (
         plan_id,slot_id,entity_id,candidate_id,entity_kind,archetype,encounter_id,generation_id,
         latitude,longitude,geom,anchor_latitude,anchor_longitude,anchor_geom,
         environment_snapshot,suppression_class
       ) VALUES
         ($1,$2,$3,'mob-candidate','deer','deer',$4,$5,35,-106,
          ST_SetSRID(ST_MakePoint(-106,35),4326)::geography,35,-106,
          ST_SetSRID(ST_MakePoint(-106,35),4326)::geography,'{}','deer-safe'),
         ($1,$6,$7,'resource-candidate','stone','stone_mine',NULL,NULL,35.001,-106.001,
          ST_SetSRID(ST_MakePoint(-106.001,35.001),4326)::geography,35.001,-106.001,
          ST_SetSRID(ST_MakePoint(-106.001,35.001),4326)::geography,'{}','none')`,
      [planId, randomUUID(), mobEntityId, encounterId, generationId, randomUUID(), resourceEntityId]
    );
    await pool.query(
      `INSERT INTO population_entity_state_v2 (entity_id,state)
       VALUES ($1,'ready'),($2,'ready')`,
      [mobEntityId, resourceEntityId]
    );
    await pool.query(
      `INSERT INTO combat_reward_settlements (
         settlement_key,defeated_mob_instance_id,mob_life_generation,mob_archetype,
         server_tick,status,reward_player_id,result,completed_at
       ) VALUES ($1,'migration-deer',0,'deer',1,'completed',$2,$3::jsonb,now())`,
      [
        settlementKey,
        playerId,
        JSON.stringify({
          mobReward: {
            items: [{ itemId: "leather", quantity: 2 }, { itemId: "leather", quantity: 1 }],
            drops: [{ itemId: "deer_hide", quantity: 1 }]
          }
        })
      ]
    );
    await pool.query(
      `INSERT INTO xoral_events (
         event_id,source_tree_entity_id,population_zone_id,population_generation_id,
         owner_player_id,combat_entity_id,region_code,zone_id,lat,lon,status,settled_at
       ) VALUES ($1,'migration-tree','migration-zone',$2,$3,'migration-xoral','NM',
         'migration-zone',35,-106,'defeated',now())`,
      [eventId, generationId, playerId]
    );
    await pool.query(
      `INSERT INTO xoral_event_rewards (
         event_id,player_id,authoritative_damage,ring_definition_id,ring_delivery,
         xp_amount,class_xp_amount
       ) VALUES ($1,$2,125,'attack_ring','inventory',100,25)`,
      [eventId, playerId]
    );
  }
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || parsed.port === "35432"
    || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error(
      "Creature Book migration verification requires a local disposable ash_atlas_stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
