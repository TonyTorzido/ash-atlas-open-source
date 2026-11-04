import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";
import { WalletService } from "../game/wallet.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const target = "0916_remove_paladin_cleric_classes.sql";
const describeDatabase = adminUrl ? describe : describe.skip;
const REMOVED = ["paladin", "cleric"];
const REMOVED_SUBCLASSES = ["justicar", "vindicator", "hierophant", "exorcist"];

describeDatabase("Paladin and Cleric removal migration", () => {
  const databaseName = `ash_atlas_stability_rpc_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const source = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const paladinBuyer = `rpc-paladin-${randomUUID()}`;
  const freeCleric = `rpc-cleric-${randomUUID()}`;
  const doubleBuyer = `rpc-double-${randomUUID()}`;
  const accounts = new Map([[paladinBuyer, randomUUID()], [freeCleric, randomUUID()], [doubleBuyer, randomUUID()]]);
  const pendingSettlement = `rpc-pending-${randomUUID()}`;
  const completedSettlement = `rpc-completed-${randomUUID()}`;
  let url = "";
  let directory = "";
  let pool: DisposableTestPool;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["localhost", "127.0.0.1"].includes(parsed.hostname) ||
        !parsed.pathname.startsWith("/ash_atlas_stability")) throw new Error("Disposable local database required");
    parsed.pathname = "/" + databaseName;
    url = parsed.toString();
    directory = await mkdtemp(path.join(tmpdir(), "ash-atlas-rpc-"));
    for (const name of (await readdir(source)).filter((name) => name.endsWith(".sql") && name < target)) {
      await copyFile(path.join(source, name), path.join(directory, name));
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(url, { migrationsDirectory: directory });
    pool = new DisposableTestPool({ connectionString: url, max: 2 });
    const wallets = new WalletService();
    for (const [index, [playerId, accountId]] of [...accounts].entries()) {
      await pool.query("INSERT INTO accounts(id,status,trust_tier) VALUES($1,'active','standard')", [accountId]);
      await pool.query(`INSERT INTO players(id,username,region_code,lat,lon,anchor_lat,anchor_lon,
        move_leash_radius_m,online,geom) VALUES($1,$2,'world-test',35,-106,35,-106,
        900,false,ST_SetSRID(ST_MakePoint(-106,35),4326))`, [playerId, `Removal ${index}`]);
      await pool.query("UPDATE players SET account_id=$2 WHERE id=$1", [playerId, accountId]);
      await pool.query(`INSERT INTO player_class_profiles(player_id, active_class_id, selected_subclasses)
        VALUES($1,'warrior','{"warrior":null,"paladin":"justicar","cleric":null}'::jsonb)`, [playerId]);
      await pool.query(`INSERT INTO player_progression_profiles(player_id, total_xp, level) VALUES($1,0,5)
        ON CONFLICT (player_id) DO UPDATE SET level = 5`, [playerId]);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const playerId of [paladinBuyer, doubleBuyer]) {
        const accountId = accounts.get(playerId)!;
        await wallets.creditForOperationInTransaction(client, {
          playerId, accountId, amount: 130_000n, operationKey: `fixture-gold:${playerId}`, reason: "test_fixture"
        });
        await wallets.debitForOperationInTransaction(client, {
          playerId, accountId, amount: 50_000n, operationKey: `class-unlock:${playerId}:paladin:fixture`,
          reason: "class_unlock", metadata: { classId: "paladin" }
        });
      }
      await wallets.debitForOperationInTransaction(client, {
        playerId: doubleBuyer, accountId: accounts.get(doubleBuyer)!, amount: 50_000n,
        operationKey: `class-unlock:${doubleBuyer}:cleric:fixture`, reason: "class_unlock", metadata: { classId: "cleric" }
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await pool.query(`INSERT INTO player_class_unlocks(player_id, class_id, unlock_operation_key, gold_paid) VALUES
      ($1,'paladin','class-unlock:' || $1 || ':paladin:fixture',50000),
      ($2,'cleric','launch-default-cleric:' || $2,0),
      ($3,'paladin','class-unlock:' || $3 || ':paladin:fixture',50000),
      ($3,'cleric','class-unlock:' || $3 || ':cleric:fixture',50000)`, [paladinBuyer, freeCleric, doubleBuyer]);
    await pool.query("UPDATE player_class_profiles SET active_class_id='paladin', active_subclass_id='justicar' WHERE player_id=$1", [paladinBuyer]);
    await pool.query("UPDATE player_class_profiles SET active_class_id='cleric' WHERE player_id=$1", [freeCleric]);
    for (const playerId of accounts.keys()) {
      for (const classId of REMOVED) {
        await pool.query(`INSERT INTO player_class_progress(player_id, class_id, mastery_xp, mastery_rank, curve_version, completed_at)
          VALUES($1,$2,72000,15,3,now() - interval '2 days')`, [playerId, classId]);
        await pool.query("INSERT INTO player_class_loadouts(player_id, class_id) VALUES($1,$2)", [playerId, classId]);
        await pool.query("INSERT INTO player_class_resources(player_id, class_id, resource_id, current_value) VALUES($1,$2,'none',0)", [playerId, classId]);
      }
      await pool.query(`INSERT INTO player_class_technique_unlocks(player_id, technique_id, class_id, subclass_id, operation_key)
        VALUES($1,'justicar_oathbound','paladin','justicar','fixture-technique:' || $1)`, [playerId]);
    }
    await pool.query(`INSERT INTO player_mastery_achievements(player_id, achievement_id, title, badge_id, completed_at) VALUES
      ($1,'master_paladin','Master Paladin','master_paladin',now() - interval '2 days'),
      ($1,'master_knight','Master Knight','master_knight',now() - interval '1 day'),
      ($2,'master_cleric','Master Cleric','master_cleric',now())`, [paladinBuyer, freeCleric]);
    await pool.query(`INSERT INTO player_mastery_state(player_id, equipped_title) VALUES($1,'Master Paladin'),($2,'Master Cleric')`,
      [paladinBuyer, freeCleric]);
    await pool.query(`INSERT INTO player_profiles(player_id, title) VALUES($1,'Master Paladin'),($2,'Master Cleric')
      ON CONFLICT (player_id) DO UPDATE SET title = EXCLUDED.title`, [paladinBuyer, freeCleric]);
    await pool.query(`INSERT INTO player_specialization_ranks(player_id, specialization_id, rank, points_spent) VALUES
      ($1,'paladin',3,3)`, [paladinBuyer]);
    await pool.query(`INSERT INTO player_specialization_state(player_id, active_specialization_id, committed_specialization_id,
      equipped_class_technique_id) VALUES($1,'paladin','paladin','v3_paladin_aegis')
      ON CONFLICT (player_id) DO UPDATE SET active_specialization_id = 'paladin', committed_specialization_id = 'paladin',
      equipped_class_technique_id = 'v3_paladin_aegis'`, [paladinBuyer]);
    await pool.query(`INSERT INTO player_skill_point_state(player_id, total_earned, total_spent) VALUES($1,5,3)
      ON CONFLICT (player_id) DO UPDATE SET total_earned = 5, total_spent = 3`, [paladinBuyer]);
    await pool.query(`INSERT INTO player_skill_runtime(player_id, cooldown_ends_at, status_effects) VALUES($1,
      '{"v3_paladin_aegis":123,"v3:general:cleave":456}'::jsonb,
      '[{"sourceTechniqueId":"paladin_guardian_bubble"},{"sourceTechniqueId":"warrior_second_wind"}]'::jsonb)
      ON CONFLICT (player_id) DO UPDATE SET cooldown_ends_at = EXCLUDED.cooldown_ends_at, status_effects = EXCLUDED.status_effects`,
      [paladinBuyer]);
    for (const [settlementKey, status, mobId] of [
      [pendingSettlement, "pending", randomUUID()], [completedSettlement, "completed", randomUUID()]
    ] as const) {
      await pool.query(`INSERT INTO combat_reward_settlements(settlement_key, defeated_mob_instance_id, mob_life_generation,
        mob_archetype, server_tick, status) VALUES($1,$2,0,'wolf',1,$3)`, [settlementKey, mobId, status]);
      await pool.query(`INSERT INTO combat_reward_participants(settlement_key, player_id, authoritative_damage, player_level,
        level_multiplier, contribution_share, active_class_id, requested_class_xp) VALUES($1,$2,10,5,1,1,'paladin',20)`,
        [settlementKey, paladinBuyer]);
    }
    await pool.query(`INSERT INTO class_progression_operations(operation_key, player_id, class_id, subclass_id, requested_xp,
      granted_xp, previous_rank, resulting_rank, result) VALUES($1,$2,'paladin',NULL,1,1,0,0,'{}'::jsonb)`,
      [`fixture-class-op:${paladinBuyer}`, paladinBuyer]);
    await copyFile(path.join(source, target), path.join(directory, target));
    expect(await runMigrations(url, { migrationsDirectory: directory })).toEqual([target]);
  }, 600_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function refundState() {
    const events = await pool.query<{ player_id: string; operation_key: string; delta_gold: string; reason: string }>(
      `SELECT player_id, operation_key, delta_gold::text, reason FROM wallet_events
       WHERE reason = 'class_unlock_refund' ORDER BY player_id, operation_key`
    );
    const balances = await pool.query<{ player_id: string; gold_balance: string }>(
      `SELECT player_id, gold_balance::text FROM player_wallets ORDER BY player_id`
    );
    return { events: events.rows, balances: Object.fromEntries(balances.rows.map((row) => [row.player_id, row.gold_balance])) };
  }

  it("refunds paid Gold exactly once through the wallet chain and nothing for free unlocks", async () => {
    const state = await refundState();
    expect(state.events).toEqual(expect.arrayContaining([
      { player_id: paladinBuyer, operation_key: `class-removal-refund:paladin:${paladinBuyer}`, delta_gold: "50000", reason: "class_unlock_refund" },
      { player_id: doubleBuyer, operation_key: `class-removal-refund:cleric:${doubleBuyer}`, delta_gold: "50000", reason: "class_unlock_refund" },
      { player_id: doubleBuyer, operation_key: `class-removal-refund:paladin:${doubleBuyer}`, delta_gold: "50000", reason: "class_unlock_refund" }
    ]));
    expect(state.events).toHaveLength(3);
    expect(state.balances[paladinBuyer]).toBe("130000");
    expect(state.balances[doubleBuyer]).toBe("130000");
    expect(state.balances[freeCleric]).toBeUndefined();
  });

  it("switches active classes to Warrior and removes every removed-class row", async () => {
    const profiles = await pool.query<{ player_id: string; active_class_id: string; active_subclass_id: string | null; selected: string[] }>(
      `SELECT player_id, active_class_id, active_subclass_id,
              ARRAY(SELECT jsonb_object_keys(selected_subclasses) ORDER BY 1) AS selected
       FROM player_class_profiles WHERE player_id = ANY($1::text[]) ORDER BY player_id`, [[...accounts.keys()]]
    );
    for (const profile of profiles.rows) {
      expect(profile.selected).toEqual(["warrior"]);
      expect(profile.active_subclass_id).toBeNull();
    }
    expect(profiles.rows.find((row) => row.player_id === paladinBuyer)?.active_class_id).toBe("warrior");
    expect(profiles.rows.find((row) => row.player_id === freeCleric)?.active_class_id).toBe("warrior");
    const remaining = await pool.query<{ count: string }>(`SELECT (
      (SELECT count(*) FROM player_class_unlocks WHERE class_id = ANY($1)) +
      (SELECT count(*) FROM player_class_progress WHERE class_id = ANY($1)) +
      (SELECT count(*) FROM player_class_loadouts WHERE class_id = ANY($1)) +
      (SELECT count(*) FROM player_class_resources WHERE class_id = ANY($1)) +
      (SELECT count(*) FROM player_class_technique_unlocks WHERE class_id = ANY($1) OR subclass_id = ANY($2)) +
      (SELECT count(*) FROM class_progression_operations WHERE class_id = ANY($1)) +
      (SELECT count(*) FROM player_specialization_ranks WHERE specialization_id = ANY($1)) +
      (SELECT count(*) FROM combat_reward_participants WHERE active_class_id = ANY($1)) +
      (SELECT count(*) FROM player_mastery_achievements WHERE achievement_id IN ('master_paladin','master_cleric'))
    )::text AS count`, [REMOVED, REMOVED_SUBCLASSES]);
    expect(remaining.rows[0]?.count).toBe("0");
    const participants = await pool.query<{ settlement_key: string; active_class_id: string | null }>(
      "SELECT settlement_key, active_class_id FROM combat_reward_participants WHERE player_id = $1", [paladinBuyer]
    );
    expect(Object.fromEntries(participants.rows.map((row) => [row.settlement_key, row.active_class_id]))).toEqual({
      [pendingSettlement]: "warrior", [completedSettlement]: null
    });
  });

  it("drops removed titles, specializations, techniques and runtime state", async () => {
    const titles = await pool.query<{ player_id: string; equipped_title: string | null; title: string | null }>(
      `SELECT state.player_id, state.equipped_title, profile.title FROM player_mastery_state AS state
       JOIN player_profiles AS profile USING (player_id) WHERE state.player_id = ANY($1::text[])`, [[paladinBuyer, freeCleric]]
    );
    expect(Object.fromEntries(titles.rows.map((row) => [row.player_id, [row.equipped_title, row.title]]))).toEqual({
      [paladinBuyer]: ["Master Knight", "Master Knight"], [freeCleric]: [null, null]
    });
    const specialization = await pool.query(
      `SELECT active_specialization_id, committed_specialization_id, equipped_class_technique_id
       FROM player_specialization_state WHERE player_id = $1`, [paladinBuyer]
    );
    expect(specialization.rows[0]).toEqual({
      active_specialization_id: null, committed_specialization_id: null, equipped_class_technique_id: null
    });
    const points = await pool.query("SELECT total_earned, total_spent FROM player_skill_point_state WHERE player_id = $1", [paladinBuyer]);
    expect(points.rows[0]).toEqual({ total_earned: 5, total_spent: 0 });
    const runtime = await pool.query("SELECT cooldown_ends_at, status_effects FROM player_skill_runtime WHERE player_id = $1", [paladinBuyer]);
    expect(runtime.rows[0]).toEqual({
      cooldown_ends_at: { "v3:general:cleave": 456 },
      status_effects: [{ sourceTechniqueId: "warrior_second_wind" }]
    });
  });

  it("rejects new Paladin and Cleric rows", async () => {
    const rejected = [
      ["INSERT INTO player_class_progress(player_id, class_id, curve_version) VALUES($1,'paladin',3)", [paladinBuyer]],
      ["UPDATE player_class_profiles SET active_class_id = 'cleric' WHERE player_id = $1", [paladinBuyer]],
      ["INSERT INTO player_class_unlocks(player_id, class_id, unlock_operation_key, gold_paid) VALUES($1,'paladin','x',0)", [freeCleric]],
      ["INSERT INTO player_specialization_ranks(player_id, specialization_id, rank) VALUES($1,'cleric',1)", [freeCleric]],
      ["INSERT INTO player_mastery_achievements(player_id, achievement_id, title, badge_id) VALUES($1,'master_paladin','Master Paladin','master_paladin')", [freeCleric]],
      ["UPDATE player_mastery_state SET equipped_title = 'Master Cleric' WHERE player_id = $1", [freeCleric]]
    ] as const;
    for (const [sql, params] of rejected) {
      await expect(pool.query(sql, [...params])).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("is a no-op when replayed and on a second migration run", async () => {
    const before = await refundState();
    const sql = await readFile(path.join(source, target), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await refundState()).toEqual(before);
    expect(await runMigrations(url, { migrationsDirectory: directory })).toEqual([]);
  });
});
