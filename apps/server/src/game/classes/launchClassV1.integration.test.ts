import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classLevelXp } from "@ash-atlas/shared";

import { DisposableTestPool } from "../../db/disposableTestPool.js";
import { runMigrations } from "../../db/migrate.js";
import { ClassService } from "./classService.js";
import { WalletService } from "../wallet.js";

const adminUrl = process.env.LAUNCH_CLASS_V1_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("launch class V1 durable economy and migration", () => {
  const databaseName = `ash_atlas_stability_launch_classes_${randomUUID().replaceAll("-", "")}`;
  const repoMigrations = path.resolve(process.env.MIGRATION_RUNNER_TEST_MIGRATIONS_DIRECTORY ?? "../../db/migrations");
  const playerId = `launch-classes-${randomUUID()}`;
  const accountId = randomUUID();
  let precedingDirectory = "";
  let paidUnlockDirectory = "";
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new DisposableTestPool({ connectionString: parsed.toString() });
    precedingDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-launch-class-v1-"));
    for (const name of await readdir(repoMigrations)) {
      if (name.endsWith(".sql") && name.localeCompare("0734_launch_class_system_v1.sql") < 0) {
        await copyFile(path.join(repoMigrations, name), path.join(precedingDirectory, name));
      }
    }
    await runMigrations(parsed.toString(), { migrationsDirectory: precedingDirectory });
    await pool.query("INSERT INTO accounts (id, status, trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (id, account_id, username, username_normalized, display_color, region_code,
        lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom)
       VALUES ($1,$2,'launchclassfixture','launchclassfixture','#38bdf8','NM',35,-106,35,-106,900,false,
        ST_SetSRID(ST_MakePoint(-106,35),4326))`, [playerId, accountId]
    );
    await pool.query(`INSERT INTO player_class_profiles (player_id, active_class_id) VALUES ($1,'paladin')`, [playerId]);
    await pool.query(
      `INSERT INTO player_class_progress (player_id,class_id,mastery_xp,mastery_rank,curve_version,training_points_earned,training_points_spent)
       VALUES ($1,'warrior',0,0,3,0,0),($1,'hunter',38000,25,1,0,0),
              ($1,'paladin',19000,14,1,0,0),($1,'cleric',0,0,1,0,0)`, [playerId]
    );
    for (const classId of ["warrior", "hunter", "paladin", "cleric"] as const) {
      await pool.query(`INSERT INTO player_class_loadouts (player_id,class_id) VALUES ($1,$2)`, [playerId, classId]);
    }
    await pool.query(
      `INSERT INTO player_class_resources (player_id,class_id,resource_id,current_value)
       VALUES ($1,'warrior','rage',0),($1,'hunter','focus',100),
              ($1,'paladin','conviction',0),($1,'cleric','faith',0)`, [playerId]
    );
    await pool.query(`INSERT INTO player_class_runtime (player_id) VALUES ($1)`, [playerId]);
    const walletClient = await pool.connect();
    try {
      await walletClient.query("BEGIN");
      await new WalletService().creditForOperationInTransaction(walletClient, {
        playerId, accountId, amount: 50_000n, operationKey: `fixture-wallet:${playerId}`, reason: "test_fixture"
      });
      await walletClient.query("COMMIT");
    } catch (error) {
      await walletClient.query("ROLLBACK");
      throw error;
    } finally {
      walletClient.release();
    }
    paidUnlockDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-paid-class-unlocks-"));
    for (const name of await readdir(repoMigrations)) {
      if (name.endsWith(".sql") && name.localeCompare("0757_free_class_unlocks.sql") < 0) {
        await copyFile(path.join(repoMigrations, name), path.join(paidUnlockDirectory, name));
      }
    }
    await runMigrations(parsed.toString(), { migrationsDirectory: paidUnlockDirectory });
    await pool.query(
      `INSERT INTO player_class_unlocks (player_id,class_id,unlock_operation_key,gold_paid)
       VALUES ($1,'paladin',$2,50000)`,
      [playerId, `historical-paladin-unlock:${playerId}`]
    );
    await expect(runMigrations(parsed.toString(), { migrationsDirectory: repoMigrations }))
      .resolves.toContain("0757_free_class_unlocks.sql");
    await expect(runMigrations(parsed.toString(), { migrationsDirectory: repoMigrations }))
      .resolves.toEqual([]);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin?.end();
    if (precedingDirectory) await rm(precedingDirectory, { recursive: true, force: true });
    if (paidUnlockDirectory) await rm(paidUnlockDirectory, { recursive: true, force: true });
  });

  it("maps historical class rows by durable version and locks invalid active classes", async () => {
    const rows = await pool.query<{ class_id: string; mastery_xp: number; mastery_rank: number; curve_version: number }>(
      `SELECT class_id,mastery_xp,mastery_rank,curve_version FROM player_class_progress
       WHERE player_id=$1 AND class_id IN ('ranger','paladin','cleric') ORDER BY class_id`, [playerId]
    );
    // 0916 removed Paladin and Cleric after 0734 mapped them.
    expect(rows.rows).toEqual([
      expect.objectContaining({ class_id: "ranger", mastery_xp: 72_000, mastery_rank: 15, curve_version: 3 })
    ]);
    await expect(pool.query(`SELECT active_class_id FROM player_class_profiles WHERE player_id=$1`, [playerId]))
      .resolves.toMatchObject({ rows: [{ active_class_id: "warrior" }] });
    await expect(pool.query(
      `SELECT class_id,gold_paid::text FROM player_class_unlocks WHERE player_id=$1 ORDER BY class_id`,
      [playerId]
    )).resolves.toMatchObject({ rows: [
      { class_id: "warrior", gold_paid: "0" }
    ] });
  });

  it("unlocks for free, survives retries, and never changes the wallet", async () => {
    const service = new ClassService(pool);
    const requestId = randomUUID();
    const unlocked = await service.unlockClass(playerId, "ninja", requestId);
    expect(unlocked.replayed).toBe(false);
    expect(unlocked.snapshot.ninja).toMatchObject({ level: 0, xp: 0 });
    const replay = await service.unlockClass(playerId, "ninja", requestId);
    expect(replay.replayed).toBe(true);
    await expect(service.unlockClass(playerId, "ranger", randomUUID())).resolves.toMatchObject({ replayed: false });
    await pool.query(
      `UPDATE player_class_progress SET mastery_xp = $3, mastery_rank = 4
       WHERE player_id = $1 AND class_id = $2`,
      [playerId, "ninja", classLevelXp("ninja")[4]]
    );
    const switched = await service.activateClass(playerId, "ninja", randomUUID(), { restricted: false });
    expect(switched.snapshot.activeClassId).toBe("ninja");
    expect(switched.snapshot.loadout.normalActives).toEqual(["ninja_v2_twin_fang", "ninja_v2_smoke_bomb"]);
    await expect(pool.query(
      `SELECT normal_active_ids FROM player_class_loadouts WHERE player_id = $1 AND class_id = 'ninja'`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ normal_active_ids: ["ninja_v2_twin_fang", "ninja_v2_smoke_bomb"] }] });
    await expect(pool.query(`SELECT gold_balance::text FROM player_wallets WHERE player_id=$1`, [playerId]))
      .resolves.toMatchObject({ rows: [{ gold_balance: "100000" }] });
    await expect(pool.query(
      `SELECT class_id,gold_paid::text FROM player_class_unlocks
       WHERE player_id=$1 AND class_id IN ('ninja','ranger') ORDER BY class_id`,
      [playerId]
    )).resolves.toMatchObject({ rows: [
      { class_id: "ninja", gold_paid: "0" },
      { class_id: "ranger", gold_paid: "0" }
    ] });
    await pool.query(
      `UPDATE player_class_progress SET mastery_xp = $3, mastery_rank = 4
       WHERE player_id = $1 AND class_id = $2`,
      [playerId, "ranger", classLevelXp("ranger")[4]]
    );
    await pool.query(
      `UPDATE player_class_loadouts SET normal_active_ids = $2
       WHERE player_id = $1 AND class_id = 'ranger'`,
      [playerId, ["ranger_v2_threefold_volley", "ranger_v2_throughshot"]]
    );
    await expect(service.activateClass(playerId, "ranger", randomUUID(), { restricted: false }))
      .resolves.toMatchObject({ snapshot: {
        activeClassId: "ranger",
        loadout: { normalActives: ["ranger_v2_threefold_volley", "ranger_v2_throughshot"] }
      } });
  });
});
