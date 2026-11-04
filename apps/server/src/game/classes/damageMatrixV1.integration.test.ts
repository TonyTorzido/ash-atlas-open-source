import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../../db/disposableTestPool.js";
import { runMigrations } from "../../db/migrate.js";
import { validateItemDefinitionCatalog } from "../items.js";
import { ClassService } from "./classService.js";

const adminUrl = process.env.DAMAGE_MATRIX_V1_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Damage Matrix V1 and Ninja migration", () => {
  const databaseName = `ash_atlas_stability_damage_matrix_${randomUUID().replaceAll("-", "")}`;
  const repoMigrations = path.resolve(
    process.env.MIGRATION_RUNNER_TEST_MIGRATIONS_DIRECTORY ?? "../../db/migrations"
  );
  const accountId = randomUUID();
  const playerId = `damage-matrix-${randomUUID()}`;
  const staffInstanceId = randomUUID();
  let precedingDirectory = "";
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseUrl = "";

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF;
    END $$`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new DisposableTestPool({ connectionString: databaseUrl });
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-damage-matrix-v1-"));
    for (const name of await readdir(repoMigrations)) {
      if (name.endsWith(".sql") && name.localeCompare("0756_damage_matrix_v1_and_ninja.sql") < 0) {
        await copyFile(path.join(repoMigrations, name), path.join(precedingDirectory, name));
      }
    }
    await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory });

    await pool.query("INSERT INTO accounts (id, status, trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (id, account_id, username, username_normalized, display_color, region_code,
        lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom)
       VALUES ($1,$2,'matrixfixture','matrixfixture','#38bdf8','NM',35,-106,35,-106,900,false,
        ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [playerId, accountId]
    );
    await pool.query(
      `INSERT INTO player_class_profiles (player_id, active_class_id, selected_subclasses)
       VALUES ($1,'knight','{"knight":null}'::jsonb)`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO player_class_progress (
         player_id,class_id,mastery_xp,mastery_rank,curve_version,
         training_points_earned,training_points_spent
       ) VALUES ($1,'knight',6212,4,3,0,0)`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO player_class_loadouts (player_id,class_id,normal_active_ids)
       VALUES ($1,'knight',ARRAY['knight_heavy_slash',NULL]::text[])`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO player_class_resources (player_id,class_id,resource_id,current_value)
       VALUES ($1,'knight','none',0)`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO player_class_unlocks (player_id,class_id,unlock_operation_key,gold_paid)
       VALUES ($1,'knight',$2,50000)`,
      [playerId, `fixture-knight-unlock:${playerId}`]
    );
    await pool.query(
      `INSERT INTO player_class_runtime (
         player_id,rage_reserved,queued_ability_id,queued_target_entity_id,queued_at_tick,
         status_effects,counters
       ) VALUES ($1,5,'knight_heavy_slash','target',10,'[{"id":"old"}]'::jsonb,'{"old":true}'::jsonb)`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO equipment_operations (operation_key,player_id,action,completed_at)
       VALUES ($1,$2,'starter_loadout',now())`,
      [`damage-matrix-staff:${playerId}`, playerId]
    );
    await pool.query(
      `INSERT INTO equipment_instances (
         instance_id,definition_id,owner_player_id,location,equipped_slot,
         inventory_slot_index,item_level,balance_version,created_by_operation_key
       ) VALUES ($1,'starter_staff',$2,'equipped','secondary',0,9,2,$3)`,
      [staffInstanceId, playerId, `damage-matrix-staff:${playerId}`]
    );
    await pool.query(
      `INSERT INTO player_equipment_state (player_id,readied_weapon_slot,active_kit_index)
       VALUES ($1,'secondary',1)`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO combat_kits (player_id,kit_index,name,readied_weapon_slot)
       VALUES ($1,1,'Staff Kit','secondary')`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO combat_kit_items (player_id,kit_index,equipment_slot,instance_id)
       VALUES ($1,1,'secondary',$2)`,
      [playerId, staffInstanceId]
    );

    // Isolate the two historical migrations from later class/equipment changes.
    for (const name of ["0756_damage_matrix_v1_and_ninja.sql", "0757_equipment_gameplay_families.sql"]) {
      await copyFile(path.join(repoMigrations, name), path.join(precedingDirectory, name));
    }
    expect(await runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory }))
      .toEqual([
        "0756_damage_matrix_v1_and_ninja.sql",
        "0757_equipment_gameplay_families.sql"
      ]);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin?.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
  });

  it("falls removed active classes back to Warrior without deleting their durable state", async () => {
    const result = await pool.query<{
      active_class_id: string;
      selected_ninja: string | null;
      queued_ability_id: string | null;
      rage_reserved: number;
      status_effects: unknown[];
      counters: Record<string, unknown>;
    }>(
      `SELECT profile.active_class_id, profile.selected_subclasses->>'ninja' AS selected_ninja,
              runtime.queued_ability_id, runtime.rage_reserved,
              runtime.status_effects, runtime.counters
       FROM player_class_profiles profile
       JOIN player_class_runtime runtime ON runtime.player_id = profile.player_id
       WHERE profile.player_id = $1`,
      [playerId]
    );
    expect(result.rows[0]).toMatchObject({
      active_class_id: "warrior",
      selected_ninja: null,
      queued_ability_id: null,
      rage_reserved: 0,
      status_effects: [],
      counters: {}
    });
    await expect(pool.query(
      `SELECT mastery_xp,mastery_rank FROM player_class_progress
       WHERE player_id=$1 AND class_id='knight'`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ mastery_xp: 6212, mastery_rank: 4 }] });
    await expect(pool.query(
      `SELECT gold_paid::text FROM player_class_unlocks WHERE player_id=$1 AND class_id='knight'`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ gold_paid: "50000" }] });
  });

  it("backfills empty Ninja state and registers the new item definitions", async () => {
    await expect(pool.query(
      `SELECT progress.mastery_xp,progress.mastery_rank,progress.curve_version,resource.resource_id
       FROM player_class_progress progress
       JOIN player_class_loadouts loadout USING (player_id,class_id)
       JOIN player_class_resources resource USING (player_id,class_id)
       WHERE progress.player_id=$1 AND progress.class_id='ninja'`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [{ mastery_xp: 0, mastery_rank: 0, curve_version: 3, resource_id: "none" }]
    });
    const items = await pool.query<{ item_id: string }>(
      `SELECT item_id FROM item_definitions
       WHERE item_id IN ('starter_shuriken','starter_wand','chain_armor','ranged_shield')
       ORDER BY item_id`
    );
    expect(items.rows.map(({ item_id }) => item_id)).toEqual([
      "chain_armor", "ranged_shield", "starter_shuriken", "starter_wand"
    ]);
  });

  it("preserves an equipped Staff while moving its active and saved-kit slots to melee", async () => {
    await expect(pool.query(
      `SELECT equipment.location,equipment.equipped_slot,equipment.item_level,
              state.readied_weapon_slot,kit.readied_weapon_slot AS kit_readied_weapon_slot,
              kit_item.equipment_slot AS kit_equipment_slot,
              state.inventory_revision::text,state.active_revision::text,
              state.checkpoint_revision::text,state.active_kit_index
       FROM equipment_instances equipment
       JOIN player_equipment_state state ON state.player_id=equipment.owner_player_id
       JOIN combat_kits kit ON kit.player_id=equipment.owner_player_id AND kit.kit_index=1
       JOIN combat_kit_items kit_item ON kit_item.instance_id=equipment.instance_id
       WHERE equipment.instance_id=$1`,
      [staffInstanceId]
    )).resolves.toMatchObject({
      rows: [{
        location: "equipped",
        equipped_slot: "melee",
        item_level: 9,
        readied_weapon_slot: "melee",
        kit_readied_weapon_slot: "melee",
        kit_equipment_slot: "melee",
        inventory_revision: "1",
        active_revision: "1",
        checkpoint_revision: "1",
        active_kit_index: null
      }]
    });
  });

  it("is an empty no-op on the second migration run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory: precedingDirectory }))
      .resolves.toEqual([]);
  });
  it("bootstraps missing historical class rows with the schema-compatible curve", async () => {
    await runMigrations(databaseUrl);
    await expect(validateItemDefinitionCatalog(pool)).resolves.toBeUndefined();
    await expect(new ClassService(pool).getOrCreate(playerId)).resolves.toBeDefined();
    await expect(pool.query(
      `SELECT class_id,curve_version FROM player_class_progress
       WHERE player_id=$1 AND class_id IN ('druid','knight','ninja') ORDER BY class_id`,
      [playerId]
    )).resolves.toMatchObject({
      rows: [
        { class_id: "druid", curve_version: 3 },
        { class_id: "knight", curve_version: 3 },
        { class_id: "ninja", curve_version: 3 }
      ]
    });
  });


});
