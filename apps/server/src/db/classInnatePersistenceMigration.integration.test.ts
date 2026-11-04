import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("class innate populated persistence migration", () => {
  const databaseName = `ash_atlas_stability_class_innates_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  let databaseUrl = "";
  let migrationsDirectory = "";

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-class-innates-"));
    const targetMigration = await readFile(
      path.resolve(process.cwd(), "../../db/migrations/0774_class_innate_persistence.sql"),
      "utf8"
    );
    await Promise.all([
      writeFile(path.join(migrationsDirectory, "0001_populated_fixture.sql"), `
        CREATE TABLE players (id text PRIMARY KEY);
        CREATE TABLE player_combat_profiles (
          player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
          max_health integer NOT NULL DEFAULT 100,
          current_health integer NOT NULL DEFAULT 100,
          base_attack_damage integer NOT NULL DEFAULT 10,
          persistence_version bigint NOT NULL DEFAULT 0
        );
        CREATE TABLE parties (
          party_id text PRIMARY KEY,
          leader_player_id text NOT NULL,
          revision bigint NOT NULL DEFAULT 1
        );
        INSERT INTO players (id) VALUES ('retained-player');
        INSERT INTO player_combat_profiles (
          player_id, max_health, current_health, base_attack_damage, persistence_version
        ) VALUES ('retained-player', 130, 42, 17, 9);
        INSERT INTO parties (party_id, leader_player_id, revision)
        VALUES ('party:retained', 'retained-player', 7);
      `, "utf8"),
      writeFile(path.join(migrationsDirectory, "0002_class_innate_persistence.sql"), targetMigration, "utf8")
    ]);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("preserves populated combat and party rows, accepts durable innate state, and has an empty second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([
      "0001_populated_fixture.sql",
      "0002_class_innate_persistence.sql"
    ]);
    const pool = new DisposableTestPool({ connectionString: databaseUrl, max: 1 });
    try {
      await expect(pool.query(
        `SELECT player_id, max_health, current_health, base_attack_damage,
                persistence_version::int, life_state, downed_until
         FROM player_combat_profiles`
      )).resolves.toMatchObject({ rows: [{
        player_id: "retained-player",
        max_health: 130,
        current_health: 42,
        base_attack_damage: 17,
        persistence_version: 9,
        life_state: "alive",
        downed_until: null
      }] });
      await expect(pool.query(
        `SELECT party_id, leader_player_id, revision::int, saving_grace_cooldown_ends_at
         FROM parties`
      )).resolves.toMatchObject({ rows: [{
        party_id: "party:retained",
        leader_player_id: "retained-player",
        revision: 7,
        saving_grace_cooldown_ends_at: null
      }] });

      await pool.query(
        `UPDATE player_combat_profiles
         SET current_health = 0, life_state = 'downed', downed_until = '2026-08-26T12:00:10Z'
         WHERE player_id = 'retained-player'`
      );
      await pool.query(
        `UPDATE parties
         SET saving_grace_cooldown_ends_at = '2026-08-26T12:10:00Z'
         WHERE party_id = 'party:retained'`
      );
      await expect(pool.query(
        `UPDATE player_combat_profiles SET life_state = 'invalid' WHERE player_id = 'retained-player'`
      )).rejects.toThrow();
      await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
      await expect(pool.query(
        `SELECT current_health, life_state, downed_until,
                (SELECT saving_grace_cooldown_ends_at FROM parties WHERE party_id = 'party:retained')
                   AS saving_grace_cooldown_ends_at
         FROM player_combat_profiles WHERE player_id = 'retained-player'`
      )).resolves.toMatchObject({ rows: [{
        current_health: 0,
        life_state: "downed",
        downed_until: new Date("2026-08-26T12:00:10Z"),
        saving_grace_cooldown_ends_at: new Date("2026-08-26T12:10:00Z")
      }] });
    } finally {
      await pool.end();
    }
  });
});

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Class innate migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
