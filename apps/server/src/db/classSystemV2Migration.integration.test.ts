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
const migration = "0771_class_system_v2.sql";

describeDatabase("Class System V2 durable migration", () => {
  const databaseName = `ash_atlas_stability_class_v2_${randomUUID().replaceAll("-", "")}`;
  const sourceMigrations = fileURLToPath(new URL("../../../../db/migrations", import.meta.url));
  let preceding = "";
  let databaseUrl = "";
  let admin: pg.Pool;
  let pool: pg.Pool;
  const accountId = randomUUID();
  const playerId = `class-v2-${randomUUID()}`;
  const equipmentId = randomUUID();

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!parsed.pathname.includes("ash_atlas_stability")) throw new Error("Migration test requires an ash_atlas_stability admin database");
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ash_atlas_telemetry_exporter') THEN CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN; END IF; END $$`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    preceding = await mkdtemp(path.join(tmpdir(), "ash-atlas-class-v2-"));
    for (const name of await readdir(sourceMigrations)) {
      if (name.endsWith(".sql") && name.localeCompare(migration) < 0) await copyFile(path.join(sourceMigrations, name), path.join(preceding, name));
    }
    await runMigrations(databaseUrl, { migrationsDirectory: preceding });
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(`INSERT INTO players (id,account_id,username,username_normalized,display_color,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
      VALUES ($1,$2,'classv2fixture','classv2fixture','#38bdf8','NM',35,-106,35,-106,900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`, [playerId, accountId]);
    await pool.query(`INSERT INTO player_class_profiles (player_id,active_class_id) VALUES ($1,'warrior') ON CONFLICT (player_id) DO UPDATE SET active_class_id='warrior'`, [playerId]);
    await pool.query(`INSERT INTO player_class_progress (player_id,class_id,mastery_xp,mastery_rank,curve_version,training_points_earned,training_points_spent) VALUES
      ($1,'warrior',60068,14,3,0,0),($1,'ranger',49946,13,3,0,0),($1,'paladin',72000,15,3,0,0),
      ($1,'ninja',41360,12,3,0,0),($1,'cleric',60068,14,3,0,0)
      ON CONFLICT (player_id,class_id) DO UPDATE SET mastery_xp=EXCLUDED.mastery_xp,mastery_rank=EXCLUDED.mastery_rank,curve_version=3`, [playerId]);
    for (const classId of ["warrior", "ranger", "paladin", "ninja", "cleric"]) {
      await pool.query(`INSERT INTO player_class_loadouts (player_id,class_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [playerId, classId]);
    }
    await pool.query(`UPDATE player_class_loadouts SET normal_active_ids=ARRAY['warrior_empowered_hit','warrior_battle_cry']::text[], passive_tier_ids=ARRAY['warrior_bloodthirst','warrior_relentless','warrior_last_stand']::text[] WHERE player_id=$1 AND class_id='warrior'`, [playerId]);
    await pool.query(`UPDATE player_class_loadouts SET normal_active_ids=ARRAY['ranger_power_shot','ranger_hunters_mark']::text[] WHERE player_id=$1 AND class_id='ranger'`, [playerId]);
    await pool.query(`UPDATE player_class_loadouts SET normal_active_ids=ARRAY['paladin_holy_mend','paladin_holy_guard']::text[] WHERE player_id=$1 AND class_id='paladin'`, [playerId]);
    await pool.query(`UPDATE player_class_loadouts SET normal_active_ids=ARRAY['cleric_holy_bolt','cleric_renew']::text[] WHERE player_id=$1 AND class_id='cleric'`, [playerId]);
    await pool.query(`INSERT INTO player_class_unlocks (player_id,class_id,unlock_operation_key,gold_paid) VALUES ($1,'paladin',$2,0) ON CONFLICT DO NOTHING`, [playerId, `class-v2-unlock:${playerId}`]);
    const retainedAssets = await pool.connect();
    try {
      await retainedAssets.query("BEGIN");
      await retainedAssets.query(
        `INSERT INTO inventory_operations (operation_key,player_id,source,metadata)
         VALUES ($1,$2,'class_v2_migration_fixture','{}'::jsonb)`,
        [`class-v2-inventory:${playerId}`, playerId]
      );
      await retainedAssets.query(
        `INSERT INTO player_inventory (player_id,resource_type,variant,quantity,version)
         VALUES ($1,'wood','default',17,1)`,
        [playerId]
      );
      await retainedAssets.query(
        `INSERT INTO inventory_events (
           operation_key,player_id,item_id,variant,delta_quantity,quantity_after,
           version_after,source,metadata
         ) VALUES ($1,$2,'wood','default',17,17,1,'class_v2_migration_fixture','{}'::jsonb)`,
        [`class-v2-inventory:${playerId}`, playerId]
      );
      await retainedAssets.query(
        `INSERT INTO player_wallets (player_id,account_id,gold_balance,version)
         VALUES ($1,$2,4321,1)`,
        [playerId, accountId]
      );
      await retainedAssets.query(
        `INSERT INTO wallet_events (
           operation_key,player_id,account_id,delta_gold,balance_after,version_after,reason
         ) VALUES ($1,$2,$3,4321,4321,1,'class_v2_migration_fixture')`,
        [`class-v2-wallet:${playerId}`, playerId, accountId]
      );
      await retainedAssets.query("COMMIT");
    } catch (error) {
      await retainedAssets.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      retainedAssets.release();
    }
    await pool.query(`INSERT INTO equipment_operations (operation_key,player_id,action) VALUES ($1,$2,'starter_loadout')`, [`class-v2-equipment:${playerId}`, playerId]);
    await pool.query(`INSERT INTO equipment_instances (
      instance_id,definition_id,owner_player_id,location,equipped_slot,inventory_slot_index,created_by_operation_key
    ) VALUES ($1,'starter_sword',$2,'inventory',NULL,0,$3)`, [equipmentId, playerId, `class-v2-equipment:${playerId}`]);
    await pool.query(`INSERT INTO player_class_runtime (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [playerId]);
    await pool.query(`UPDATE player_class_runtime SET queued_ability_id='warrior_empowered_hit',queued_target_entity_id='mob-1',queued_at_tick=7,cooldown_ends_at='{"warrior_empowered_hit":999}'::jsonb,status_effects='[{"id":"old"}]'::jsonb,counters='{"old":2}'::jsonb WHERE player_id=$1`, [playerId]);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin?.end();
    if (preceding) await rm(preceding, { recursive: true, force: true });
  });

  it("translates populated rows, preserves retained domains, clears runtime, and reruns empty", async () => {
    await copyFile(path.join(sourceMigrations, migration), path.join(preceding, migration));
    expect(await runMigrations(databaseUrl, { migrationsDirectory: preceding })).toEqual([migration]);
    expect(await runMigrations(databaseUrl, { migrationsDirectory: preceding })).toEqual([]);
    const loadouts = await pool.query(`SELECT class_id,normal_active_ids,passive_tier_ids,ultimate_active_id FROM player_class_loadouts WHERE player_id=$1 AND class_id IN ('warrior','ranger','paladin','ninja','cleric') ORDER BY class_id`, [playerId]);
    expect(loadouts.rows).toEqual([
      expect.objectContaining({ class_id: "cleric", normal_active_ids: ["cleric_v2_radiant_bolt", "cleric_v2_renew"], ultimate_active_id: "cleric_v2_divine_sanctuary" }),
      expect.objectContaining({ class_id: "ninja", normal_active_ids: ["ninja_v2_twin_fang", null], ultimate_active_id: null }),
      expect.objectContaining({ class_id: "paladin", normal_active_ids: ["paladin_v2_aegis", "paladin_v2_rebuke"], ultimate_active_id: "paladin_v2_last_bastion" }),
      expect.objectContaining({ class_id: "ranger", normal_active_ids: ["ranger_v2_throughshot", "ranger_v2_marked_quarry"], ultimate_active_id: null }),
      expect.objectContaining({ class_id: "warrior", normal_active_ids: ["warrior_v2_sundering_arc", "warrior_v2_rallying_roar"], passive_tier_ids: ["warrior_v2_battle_hardened", "warrior_v2_relentless", "warrior_v2_juggernaut"], ultimate_active_id: "warrior_v2_worldbreaker" })
    ]);
    await expect(pool.query(`SELECT mastery_rank FROM player_class_progress WHERE player_id=$1 AND class_id='warrior'`, [playerId])).resolves.toMatchObject({ rows: [{ mastery_rank: 14 }] });
    await expect(pool.query(`SELECT count(*)::int AS count FROM player_class_unlocks WHERE player_id=$1 AND class_id='paladin'`, [playerId])).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query(`SELECT quantity::text FROM player_inventory WHERE player_id=$1 AND resource_type='wood'`, [playerId])).resolves.toMatchObject({ rows: [{ quantity: "17" }] });
    await expect(pool.query(`SELECT gold_balance::text FROM player_wallets WHERE player_id=$1`, [playerId])).resolves.toMatchObject({ rows: [{ gold_balance: "4321" }] });
    await expect(pool.query(`SELECT instance_id::text FROM equipment_instances WHERE instance_id=$1`, [equipmentId])).resolves.toMatchObject({ rows: [{ instance_id: equipmentId }] });
    await expect(pool.query(`SELECT queued_ability_id,cooldown_ends_at,status_effects,counters FROM player_class_runtime WHERE player_id=$1`, [playerId])).resolves.toMatchObject({ rows: [{ queued_ability_id: null, cooldown_ends_at: {}, status_effects: [], counters: {} }] });
  }, 120_000);
});
