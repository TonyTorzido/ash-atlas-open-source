import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";
import { ProgressionService } from "../game/progression.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const deathPenaltyMigration = "0790_player_death_xp_penalties.sql";
const levelBasisMigration = "0791_player_death_level_xp_penalty.sql";
const respawnDeadlineMigration = "0792_player_respawn_available_at.sql";
const levelFloorMigration = "0796_player_death_level_floor.sql";
const deathPenaltyRateMigration = "0865_player_death_xp_penalty_rate.sql";

describeDatabase("player death XP penalty migration", () => {
  const databaseName = `ash_atlas_stability_death_penalty_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
      throw new Error("Death penalty migration test requires a local disposable stability database");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-death-penalty-"));
    await writeFile(path.join(migrationsDirectory, "0001_fixture.sql"), fixture, "utf8");
    await runMigrations(databaseUrl, { migrationsDirectory });
    await copyFile(
      fileURLToPath(new URL(`../../../../db/migrations/${deathPenaltyMigration}`, import.meta.url)),
      path.join(migrationsDirectory, deathPenaltyMigration)
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin?.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("preserves and backfills a populated historical ledger before an empty second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([deathPenaltyMigration]);
    await pool.query(
      `INSERT INTO player_death_xp_penalties (
         operation_id, operation_key, player_id, penalty_basis_points,
         previous_xp, resulting_xp, xp_lost, previous_level, resulting_level,
         replay_result, metadata
       ) VALUES ($1, 'player-death:historical', 'historical-player', 1000,
         10000, 9000, 1000, 1, 1, $2::jsonb, '{}'::jsonb)`,
      [randomUUID(), JSON.stringify({
        operationKey: "player-death:historical",
        penaltyBasisPoints: 1000,
        previousXp: 10_000,
        resultingXp: 9_000,
        xpLost: 1_000,
        previousLevel: 1,
        resultingLevel: 1,
        replayed: false,
        progression: {}
      })]
    );
    await copyFile(
      fileURLToPath(new URL(`../../../../db/migrations/${levelBasisMigration}`, import.meta.url)),
      path.join(migrationsDirectory, levelBasisMigration)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([levelBasisMigration]);
    await copyFile(
      fileURLToPath(new URL(`../../../../db/migrations/${respawnDeadlineMigration}`, import.meta.url)),
      path.join(migrationsDirectory, respawnDeadlineMigration)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([respawnDeadlineMigration]);
    await copyFile(
      fileURLToPath(new URL(`../../../../db/migrations/${levelFloorMigration}`, import.meta.url)),
      path.join(migrationsDirectory, levelFloorMigration)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([levelFloorMigration]);
    await copyFile(
      fileURLToPath(new URL(`../../../../db/migrations/${deathPenaltyRateMigration}`, import.meta.url)),
      path.join(migrationsDirectory, deathPenaltyRateMigration)
    );
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([deathPenaltyRateMigration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    await expect(pool.query("SELECT total_xp, level FROM player_progression_profiles WHERE player_id = 'retained-player'"))
      .resolves.toMatchObject({ rows: [{ total_xp: "1750010", level: 25 }] });
    await expect(pool.query(
      `SELECT penalty_basis_points, previous_xp, penalty_basis_xp, level_floor_xp, xp_lost, resulting_xp,
         previous_level, resulting_level, replay_result
       FROM player_death_xp_penalties WHERE operation_key = 'player-death:historical'`
    )).resolves.toMatchObject({
      rows: [{
        penalty_basis_points: 1000,
        previous_xp: "10000",
        penalty_basis_xp: "10000",
        level_floor_xp: "9000",
        xp_lost: "1000",
        resulting_xp: "9000",
        previous_level: 1,
        resulting_level: 1,
        replay_result: expect.objectContaining({ resultingXp: 9_000, resultingLevel: 1 })
      }]
    });
    await expect(pool.query("SELECT total_xp, level FROM player_progression_profiles WHERE player_id = 'historical-player'"))
      .resolves.toMatchObject({ rows: [{ total_xp: "9000", level: 1 }] });
    await expect(new ProgressionService(pool).applyDeathPenalty({
      operationKey: "player-death:historical",
      playerId: "historical-player"
    })).resolves.toMatchObject({ xpLost: 1_000, resultingXp: 9_000, replayed: true, progression: { totalXp: 9_000 } });
    await expect(pool.query(
      `SELECT life_state, death_penalty_operation_key,
         respawn_available_at IS NOT NULL AS respawn_deadline_backfilled
       FROM player_combat_profiles WHERE player_id = 'retained-player'`
    )).resolves.toMatchObject({
      rows: [{
        life_state: "respawning",
        death_penalty_operation_key: "player-death:legacy:retained-player:7",
        respawn_deadline_backfilled: true
      }]
    });
    await expect(pool.query(
      `SELECT respawn_available_at FROM player_combat_profiles
       WHERE player_id = 'historical-player'`
    )).resolves.toMatchObject({ rows: [{ respawn_available_at: null }] });
  }, 30_000);

  it("applies the current rate once and replays the exact ledger result", async () => {
    const progression = new ProgressionService(pool);
    const first = await progression.applyDeathPenalty({
      operationKey: "player-death:mia",
      playerId: "mia-player"
    });
    const replay = await progression.applyDeathPenalty({
      operationKey: "player-death:mia",
      playerId: "mia-player"
    });

    expect(first).toMatchObject({
      operationKey: "player-death:mia",
      penaltyBasisPoints: 300,
      previousXp: 161_467,
      penaltyBasisXp: 25_696,
      levelFloorXp: 150_791,
      xpLost: 770,
      resultingXp: 160_697,
      replayed: false
    });
    expect(replay).toMatchObject({
      operationKey: "player-death:mia",
      penaltyBasisPoints: 300,
      xpLost: 770,
      resultingXp: 160_697,
      replayed: true,
      progression: { totalXp: 160_697 }
    });
    await expect(pool.query(
      `SELECT penalty_basis_points, previous_xp, penalty_basis_xp, level_floor_xp,
         xp_lost, resulting_xp
       FROM player_death_xp_penalties WHERE operation_key = 'player-death:mia'`
    )).resolves.toMatchObject({
      rows: [{
        penalty_basis_points: 300,
        previous_xp: "161467",
        penalty_basis_xp: "25696",
        level_floor_xp: "150791",
        xp_lost: "770",
        resulting_xp: "160697"
      }]
    });
    await expect(pool.query(
      "SELECT count(*)::integer AS count FROM player_death_xp_penalties WHERE operation_key = 'player-death:mia'"
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  }, 30_000);

  it("enforces coherent floor-based penalty rows", async () => {
    const insert = `INSERT INTO player_death_xp_penalties (
      operation_id, operation_key, player_id, penalty_basis_points,
      previous_xp, resulting_xp, xp_lost, penalty_basis_xp, level_floor_xp,
      previous_level, resulting_level, replay_result, metadata
    ) VALUES ($1, $2, 'historical-player', 1000, $3, $4, $5, $6, $7, 1, 1, '{}'::jsonb, '{}'::jsonb)`;

    await expect(pool.query(insert, [randomUUID(), "player-death:valid-floor", 7_200, 7_194, 6, 8_076, 7_194]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(insert, [randomUUID(), "player-death:below-floor", 7_200, 7_193, 7, 8_076, 7_194]))
      .rejects.toThrow(/xp_lost_calculation|check constraint/i);
    await expect(pool.query(insert, [randomUUID(), "player-death:incoherent-floor", 7_200, 7_200, 0, 8_076, 7_201]))
      .rejects.toThrow(/level_floor_xp_not_above_previous|check constraint/i);
  }, 30_000);

  it("serializes concurrent retries of the same death operation", async () => {
    const progression = new ProgressionService(pool);
    const results = await Promise.all([
      progression.applyDeathPenalty({ operationKey: "player-death:concurrent", playerId: "retained-player" }),
      progression.applyDeathPenalty({ operationKey: "player-death:concurrent", playerId: "retained-player" })
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ penaltyBasisPoints: 300, previousXp: 1_750_010, resultingXp: 1_742_510, xpLost: 7_500 })
    ]));
    await expect(pool.query("SELECT total_xp FROM player_progression_profiles WHERE player_id = 'retained-player'"))
      .resolves.toMatchObject({ rows: [{ total_xp: "1742510" }] });
    await expect(pool.query(
      `SELECT penalty_basis_xp, level_floor_xp, xp_lost, previous_level, resulting_level
       FROM player_death_xp_penalties
       WHERE operation_key = 'player-death:concurrent'`
    )).resolves.toMatchObject({
      rows: [{ penalty_basis_xp: "250000", level_floor_xp: "1000000", xp_lost: "7500", previous_level: 25, resulting_level: 25 }]
    });
    await expect(pool.query("SELECT count(*)::integer AS count FROM player_death_xp_penalties"))
      .resolves.toMatchObject({ rows: [{ count: 4 }] });
  }, 30_000);
});

const fixture = `
CREATE TABLE players (id text PRIMARY KEY);
CREATE TABLE player_progression_profiles (
  player_id text PRIMARY KEY REFERENCES players(id),
  total_xp bigint NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  level integer NOT NULL DEFAULT 0,
  curve_version integer NOT NULL DEFAULT 3,
  persistence_version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE player_combat_profiles (
  player_id text PRIMARY KEY REFERENCES players(id),
  max_health integer NOT NULL DEFAULT 100,
  current_health integer NOT NULL DEFAULT 100,
  base_attack_damage integer NOT NULL DEFAULT 10,
  persistence_version bigint NOT NULL DEFAULT 0,
  life_state text NOT NULL DEFAULT 'alive',
  downed_until timestamptz NULL
);
INSERT INTO players (id) VALUES ('retained-player'), ('historical-player'), ('mia-player');
INSERT INTO player_progression_profiles (player_id, total_xp, level, curve_version)
VALUES
  ('retained-player', 1750010, 25, 3),
  ('historical-player', 9000, 1, 3),
  ('mia-player', 161467, 11, 3);
INSERT INTO player_combat_profiles (
  player_id, max_health, current_health, base_attack_damage, persistence_version, life_state
) VALUES
  ('retained-player', 100, 0, 10, 7, 'respawning'),
  ('historical-player', 100, 100, 10, 3, 'alive'),
  ('mia-player', 100, 0, 10, 8, 'respawning');
`;
