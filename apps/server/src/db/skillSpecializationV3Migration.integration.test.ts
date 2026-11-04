import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";
import { runMigrations } from "./migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const migration = "0779_skill_specialization_v3.sql";

describeDatabase("Skill Tree / Specialization V3 durable migration", () => {
  const databaseName = `ash_atlas_stability_skill_v3_${randomUUID().replaceAll("-", "")}`;
  const sourceMigration = fileURLToPath(
    new URL(`../../../../db/migrations/${migration}`, import.meta.url)
  );
  let migrationsDirectory = "";
  let databaseUrl = "";
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 2 });
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-skill-v3-"));
    await writeFile(
      path.join(migrationsDirectory, "0001_skill_v3_fixture.sql"),
      predecessorFixture,
      "utf8"
    );
    await runMigrations(databaseUrl, { migrationsDirectory });

    const currentRanks = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15];
    for (const rank of currentRanks) {
      const playerId = `current-${rank}`;
      await insertPlayer(pool, playerId, rank === 15 ? 25 : 1, "warrior");
      await pool.query(
        `INSERT INTO player_class_progress
           (player_id,class_id,mastery_xp,mastery_rank,curve_version)
         VALUES ($1,'warrior',$2,$3,3)`,
        [playerId, rank * 1000 + 17, rank]
      );
      await insertLoadout(pool, playerId, "warrior", `legacy-current-${rank}`);
    }

    const historicalRanks = [0, 1, 5, 6, 10, 11, 15, 16, 20, 21, 25];
    for (const rank of historicalRanks) {
      const playerId = `historical-${rank}`;
      await insertPlayer(pool, playerId, 10, "hunter");
      await pool.query(
        `INSERT INTO player_class_progress
           (player_id,class_id,mastery_xp,mastery_rank,curve_version)
         VALUES ($1,'hunter',$2,$3,1)`,
        [playerId, rank * 700 + 11, rank]
      );
      await insertLoadout(pool, playerId, "hunter", `legacy-historical-${rank}`);
    }

    await insertPlayer(pool, "ash-original", 8, "paladin");
    await pool.query(
      `INSERT INTO player_class_progress
         (player_id,class_id,mastery_xp,mastery_rank,curve_version)
       VALUES
         ('ash-original','warrior',0,0,3),
         ('ash-original','paladin',0,0,3),
         ('ash-original','cleric',0,0,3)`
    );
    await pool.query(
      `INSERT INTO player_class_unlocks (player_id,class_id,unlock_operation_key,gold_paid)
       VALUES
         ('ash-original','paladin','fixture:paladin',50000),
         ('ash-original','cleric','fixture:cleric',0)`
    );
    await insertLoadout(pool, "ash-original", "paladin", "paladin_v2_judgment");
    await pool.query(
      `INSERT INTO player_class_runtime (
         player_id,rage_reserved,queued_ability_id,queued_target_entity_id,queued_at_tick,
         cooldown_ends_at,status_effects,counters,last_combat_at
       ) VALUES (
         'ash-original',7,'paladin_v2_judgment','mob-1',12,
         '{"paladin_v2_judgment":999}'::jsonb,
         '[{"id":"old","sourceTechniqueId":"paladin_v2_judgment"},
           {"id":"retained-ward","kind":"healing_shield","sourceTechniqueId":"paladin_guardian_bubble"}]'::jsonb,
         '{"armed":true}'::jsonb,now()
       )`
    );

    await copyFile(sourceMigration, path.join(migrationsDirectory, migration));
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin?.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("maps both durable rank curves, retains XP/loadouts/unlocks, and has an empty second run", async () => {
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([migration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);

    const current = await pool.query<{ source_mastery_rank: number; resulting_rank: number }>(
      `SELECT source_mastery_rank,resulting_rank
       FROM specialization_migration_audit
       WHERE source_class_id='warrior' AND player_id LIKE 'current-%'
       ORDER BY source_mastery_rank`
    );
    expect(current.rows).toEqual([
      [0, 0], [1, 1], [3, 1], [4, 2], [6, 2], [7, 3],
      [9, 3], [10, 4], [12, 4], [13, 5], [15, 5]
    ].map(([source_mastery_rank, resulting_rank]) => ({ source_mastery_rank, resulting_rank })));

    const historical = await pool.query<{ source_mastery_rank: number; resulting_rank: number }>(
      `SELECT source_mastery_rank,resulting_rank
       FROM specialization_migration_audit
       WHERE source_class_id='hunter'
       ORDER BY source_mastery_rank`
    );
    expect(historical.rows).toEqual([
      [0, 0], [1, 1], [5, 1], [6, 2], [10, 2], [11, 3],
      [15, 3], [16, 4], [20, 4], [21, 5], [25, 5]
    ].map(([source_mastery_rank, resulting_rank]) => ({ source_mastery_rank, resulting_rank })));

    await expect(pool.query(
      `SELECT total_earned,total_spent FROM player_skill_point_state
       WHERE player_id IN ('current-0','current-15') ORDER BY player_id`
    )).resolves.toMatchObject({ rows: [
      { total_earned: 2, total_spent: 0 },
      { total_earned: 50, total_spent: 0 }
    ] });
    await expect(pool.query(
      `SELECT specialization_id,rank,points_spent,grandfathered,source_class_id
       FROM player_specialization_ranks WHERE player_id='historical-25'`
    )).resolves.toMatchObject({ rows: [{
      specialization_id: "ranger",
      rank: 5,
      points_spent: 0,
      grandfathered: true,
      source_class_id: "hunter"
    }] });
    await expect(pool.query(
      `SELECT specialization_id,rank,points_spent,grandfathered
       FROM player_specialization_ranks WHERE player_id='ash-original'
       ORDER BY specialization_id`
    )).resolves.toMatchObject({ rows: [
      { specialization_id: "cleric", rank: 0, points_spent: 0, grandfathered: true },
      { specialization_id: "paladin", rank: 0, points_spent: 0, grandfathered: true },
      { specialization_id: "warrior", rank: 0, points_spent: 0, grandfathered: true }
    ] });
    await expect(pool.query(
      `SELECT active_specialization_id FROM player_specialization_state
       WHERE player_id='ash-original'`
    )).resolves.toMatchObject({ rows: [{ active_specialization_id: "paladin" }] });
    await expect(pool.query(
      `SELECT cooldown_ends_at,status_effects,counters,engaged_target,
              combat_generation::int,revision::int
       FROM player_skill_runtime WHERE player_id='ash-original'`
    )).resolves.toMatchObject({ rows: [{
      cooldown_ends_at: {},
      status_effects: [],
      counters: {},
      engaged_target: null,
      combat_generation: 0,
      revision: 0
    }] });

    await expect(pool.query(
      `SELECT mastery_xp,mastery_rank,curve_version FROM player_class_progress
       WHERE player_id='current-15' AND class_id='warrior'`
    )).resolves.toMatchObject({ rows: [{ mastery_xp: 15017, mastery_rank: 15, curve_version: 3 }] });
    await expect(pool.query(
      `SELECT normal_active_ids,v3_execution_status FROM player_class_loadouts
       WHERE player_id='current-15' AND class_id='warrior'`
    )).resolves.toMatchObject({ rows: [{
      normal_active_ids: ["legacy-current-15", null],
      v3_execution_status: "legacy_inert"
    }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM player_class_unlocks
       WHERE player_id='ash-original' AND class_id IN ('paladin','cleric')`
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(pool.query(
      `SELECT metadata->>'legacyLoadoutStatus' AS status,
              metadata->'legacyLoadout'->'normalActiveIds' AS normal_active_ids
       FROM specialization_migration_audit
       WHERE player_id='ash-original' AND source_class_id='paladin'`
    )).resolves.toMatchObject({ rows: [{
      status: "legacy_inert",
      normal_active_ids: ["paladin_v2_judgment", null]
    }] });
  }, 30_000);

  it("fences transient V2 runtime state and enforces ledger/revision storage invariants", async () => {
    await expect(pool.query(
      `SELECT rage_reserved,queued_ability_id,cooldown_ends_at,status_effects,counters,
              combat_generation::int,revision::int,v3_execution_status,v3_fenced_at IS NOT NULL AS fenced
       FROM player_class_runtime WHERE player_id='ash-original'`
    )).resolves.toMatchObject({ rows: [{
      rage_reserved: 0,
      queued_ability_id: null,
      cooldown_ends_at: {},
      status_effects: [{
        id: "retained-ward",
        kind: "healing_shield",
        sourceTechniqueId: "paladin_guardian_bubble"
      }],
      counters: {},
      combat_generation: 1,
      revision: 1,
      v3_execution_status: "legacy_inert",
      fenced: true
    }] });

    await pool.query(
      `INSERT INTO skill_point_operations
         (operation_key,player_id,action,payload,result,completed_at)
       VALUES ('skill-v3:reveal:1','ash-original','reveal_world_skill',
               '{"skillId":"grove_lore"}'::jsonb,'{"revealed":true}'::jsonb,now())`
    );
    await pool.query(
      `INSERT INTO player_skill_world_unlocks (player_id,skill_id,operation_key)
       VALUES ('ash-original','grove_lore','skill-v3:reveal:1')`
    );
    await expect(pool.query(
      `INSERT INTO skill_point_operations (operation_key,player_id,action,payload)
       VALUES ('skill-v3:reveal:1','ash-original','reveal_world_skill','{}'::jsonb)`
    )).rejects.toThrow();
    await expect(pool.query(
      `UPDATE player_skill_point_state SET total_spent=17 WHERE player_id='current-0'`
    )).rejects.toThrow();
    await expect(pool.query(
      `UPDATE player_general_active_loadouts
       SET slot_one_skill_id='cleanse',slot_two_skill_id='cleanse'
       WHERE player_id='ash-original'`
    )).rejects.toThrow();

    await pool.query(
      `INSERT INTO player_class_loadouts (player_id,class_id)
       VALUES ('current-0','ranger')`
    );
    await pool.query(
      `INSERT INTO player_class_runtime (player_id) VALUES ('current-0')`
    );
    await expect(pool.query(
      `SELECT
         (SELECT v3_execution_status FROM player_class_loadouts
          WHERE player_id='current-0' AND class_id='ranger') AS loadout_status,
         (SELECT v3_execution_status FROM player_class_runtime
          WHERE player_id='current-0') AS runtime_status`
    )).resolves.toMatchObject({ rows: [{
      loadout_status: "legacy_inert",
      runtime_status: "legacy_inert"
    }] });

    // Direct replay is also safe: the runner normally prevents this, while the
    // guarded fence ensures a manual replay cannot advance combat generations.
    await pool.query(await readFile(sourceMigration, "utf8"));
    await expect(pool.query(
      `SELECT combat_generation::int,revision::int
       FROM player_class_runtime WHERE player_id='ash-original'`
    )).resolves.toMatchObject({ rows: [{ combat_generation: 1, revision: 1 }] });
  }, 30_000);
});

async function insertPlayer(
  pool: pg.Pool,
  playerId: string,
  level: number,
  activeClassId: string
): Promise<void> {
  await pool.query("INSERT INTO players (id) VALUES ($1)", [playerId]);
  await pool.query(
    "INSERT INTO player_progression_profiles (player_id,level) VALUES ($1,$2)",
    [playerId, level]
  );
  await pool.query(
    "INSERT INTO player_class_profiles (player_id,active_class_id) VALUES ($1,$2)",
    [playerId, activeClassId]
  );
}

async function insertLoadout(
  pool: pg.Pool,
  playerId: string,
  classId: string,
  activeId: string
): Promise<void> {
  await pool.query(
    `INSERT INTO player_class_loadouts (player_id,class_id,normal_active_ids)
     VALUES ($1,$2,ARRAY[$3,NULL]::text[])`,
    [playerId, classId, activeId]
  );
}

function assertDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))
  ) {
    throw new Error("Skill V3 migration test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}

const predecessorFixture = `
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE players (id text PRIMARY KEY);
CREATE TABLE player_progression_profiles (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  level integer NOT NULL CHECK (level BETWEEN 0 AND 25)
);
CREATE TABLE player_class_profiles (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  active_class_id text NOT NULL
);
CREATE TABLE player_class_progress (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  class_id text NOT NULL,
  mastery_xp integer NOT NULL CHECK (mastery_xp >= 0),
  mastery_rank integer NOT NULL CHECK (mastery_rank BETWEEN 0 AND 25),
  curve_version smallint NOT NULL CHECK (curve_version > 0),
  PRIMARY KEY (player_id,class_id)
);
CREATE TABLE player_class_unlocks (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  class_id text NOT NULL,
  unlock_operation_key text NOT NULL UNIQUE,
  gold_paid bigint NOT NULL,
  PRIMARY KEY (player_id,class_id)
);
CREATE TABLE player_class_loadouts (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  class_id text NOT NULL,
  base_active_ids text[] NOT NULL DEFAULT ARRAY[NULL,NULL]::text[],
  base_passive_ids text[] NOT NULL DEFAULT ARRAY[NULL,NULL,NULL]::text[],
  reset_active_ids text[] NOT NULL DEFAULT ARRAY[NULL,NULL]::text[],
  normal_active_ids text[] NOT NULL DEFAULT ARRAY[NULL,NULL]::text[],
  passive_tier_ids text[] NOT NULL DEFAULT ARRAY[NULL,NULL,NULL]::text[],
  ultimate_active_id text NULL,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id,class_id)
);
CREATE TABLE player_class_runtime (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  rage_reserved integer NOT NULL DEFAULT 0,
  queued_ability_id text NULL,
  queued_target_entity_id text NULL,
  queued_at_tick bigint NULL,
  cooldown_ends_at jsonb NOT NULL DEFAULT '{}'::jsonb,
  status_effects jsonb NOT NULL DEFAULT '[]'::jsonb,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  combat_generation bigint NOT NULL DEFAULT 0,
  last_combat_at timestamptz NULL,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
