import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BITTER_BLOOD_ACHIEVEMENT_ID, BITTER_BLOOD_POISON_DAMAGE_REQUIRED, LEGEND_CATALOG, legendPrestige } from "@ash-atlas/shared";
import { AchievementService } from "./achievements.js";
import { LegendJournalService } from "./legendJournal.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

// A private schema on a disposable database tests real PostgreSQL aggregation,
// unique-conflict behavior, and rollback without touching a gameplay character.
databaseSuite("legend journal durable history", () => {
  const schema = "legend_journal_test_" + randomUUID().replaceAll("-", "");
  let admin: pg.Pool;
  let pool: pg.Pool;
  let service: LegendJournalService;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!url.pathname.slice(1).startsWith("ash_atlas_stability")) {
      throw new Error("Legend journal tests require a disposable ash_atlas_stability database");
    }
    admin = new pg.Pool({ connectionString: databaseUrl! });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, max: 8 });
    await pool.query(FIXTURE_SCHEMA);
    service = new LegendJournalService(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${TABLES.join(",")} CASCADE`);
  });

  it("counts committed personal receipts, deduplicates harvests, and excludes failed or uncollected output", async () => {
    await pool.query(`
      INSERT INTO creature_book_kill_occurrences VALUES
        ('p','combat_settlement','one','deer'),('p','combat_settlement','two','deer'),
        ('p','legendary_bird_event','fire','fire_bird'),('p','xoral_event','boss','xoral'),
        ('other','combat_settlement','three','wolf');
      INSERT INTO creature_book_sightings VALUES ('p','deer'),('p','fire_bird'),('other','wolf');
      INSERT INTO creature_book_drop_occurrences VALUES
        ('p','xoral_event','boss','attack_ring'),('p','xoral_event','boss2','attack_ring'),
        ('p','xoral_event','boss3','mining_ring'),('other','xoral_event','other','chopping_ring');
      INSERT INTO harvest_sessions VALUES
        ('p','wood1','wood','completed'),('p','wood1','wood','completed'),
        ('p','wood2','wood','active'),('other','wood3','wood','completed');
      INSERT INTO repeatable_resource_sessions VALUES ('p','iron1','iron','completed'),('p','iron2','iron','cancelled');
      INSERT INTO repeatable_resource_harvests VALUES ('p','iron1'),('p','iron2');
      INSERT INTO furnace_smelt_jobs VALUES
        ('iron','p','iron_bar',2),('fire','p','fire_bar',3),('core','p','venomsteel_core',2),
        ('recover','p','slag_recovery',1),('other','other','fire_bar',100);
      INSERT INTO furnace_smelt_units VALUES ('iron',1,'success'),('iron',2,'failure'),('iron',3,'success');
      INSERT INTO tannery_jobs VALUES ('p','deer_hide',50),('p','wolf_pelt',0),('other','hog_hide',1000);
      INSERT INTO loom_jobs VALUES ('p',3),('other',100);
      INSERT INTO kitchen_jobs VALUES ('p','deer_meat',2),('p','wolf_meat',0);
      INSERT INTO player_profession_progress VALUES ('p','hunter',8),('p','miner',8),('p','breeder',4),('other','builder',8);
      INSERT INTO player_progression_profiles VALUES ('p',25),('other',25);
      INSERT INTO player_stats VALUES ('p','poison_damage_taken',123);
      INSERT INTO player_biome_discoveries (player_id,biome_id) VALUES ('p','plains'),('p','open_ocean'),('other','frozen_waste');
      INSERT INTO combat_reward_settlements VALUES
        ('warden1','completed','sewer_rat_miniboss','{"bossOwnership":{"hostKind":"dungeon","bossId":"sewer_rat_miniboss","encounterInstanceId":"sewer:one:rat-warden:1:warden"}}'),
        ('warden2','completed','sewer_rat_miniboss','{"bossOwnership":{"hostKind":"dungeon","bossId":"sewer_rat_miniboss","encounterInstanceId":"sewer:two:rat-warden:1:warden"}}'),
        ('pending','pending','sewer_rat_miniboss','{"bossOwnership":{"hostKind":"dungeon","bossId":"sewer_rat_miniboss","encounterInstanceId":"sewer:three:rat-warden:1:warden"}}'),
        ('world','completed','sewer_rat_miniboss','{"bossOwnership":{"hostKind":"world","bossId":"sewer_rat_miniboss","encounterInstanceId":"sewer:four:rat-warden:1:warden"}}'),
        ('other-encounter','completed','sewer_rat_miniboss','{"bossOwnership":{"hostKind":"dungeon","bossId":"sewer_rat_miniboss","encounterInstanceId":"sewer:five:other-boss:1:warden"}}'),
        ('uncredited','completed','sewer_rat_miniboss','{"bossOwnership":{"hostKind":"dungeon","bossId":"sewer_rat_miniboss","encounterInstanceId":"sewer:six:rat-warden:1:warden"}}');
      INSERT INTO combat_reward_participants VALUES
        ('warden1','p',50),('warden2','p',75),('pending','p',20),('world','p',20),
        ('other-encounter','p',20),('uncredited','other',100);
    `);
    const result = await service.snapshot("p");
    expect(result.metrics).toMatchObject({
      kills_deer: 2, kills_total: 4, species_defeated: 3, legendary_bird_species: 1,
      species_seen: 2, drop_types: 2, xoral_ring_types: 2,
      harvests_total: 2, harvest_wood: 1, harvest_iron: 1,
      smelted_bars: 5, smelt_recipe_types: 4, leather_made: 50, tannery_recipe_types: 1,
      cloth_woven: 3, meals_cooked: 2, kitchen_recipe_types: 1,
      profession_masters: 1, level: 25, poison_damage_taken: 123,
      biomes_discovered: 2, biome_open_ocean: 1, biome_plains: 1,
      sewer_wardens_defeated: 2
    });
    expect(result.metrics.kills_wolf).toBeUndefined();
    expect(result.metrics.biome_frozen_waste).toBeUndefined();
    expect(await service.snapshot("empty")).toMatchObject({ completed: {}, newlyCompletedIds: [] });
  });

  it("adds the journal lookup index on populated data and repeats without changing records", async () => {
    await pool.query("INSERT INTO combat_reward_settlements VALUES ('kept','completed','wolf','{}')");
    await pool.query("INSERT INTO combat_reward_participants VALUES ('kept','p',42)");
    const migration = await readFile(new URL("../../../../db/migrations/0829_legend_journal_participant_index.sql", import.meta.url), "utf8");
    const before = (await pool.query("SELECT * FROM combat_reward_participants")).rows;
    await pool.query(migration);
    await pool.query(migration);
    expect((await pool.query("SELECT * FROM combat_reward_participants")).rows).toEqual(before);
    expect((await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='combat_reward_participants_player_idx'", [schema])).rowCount).toBe(1);
  });

  it("reads Bitter Blood from its original gameplay authority and preserves its existing award", async () => {
    await pool.query("INSERT INTO player_stats VALUES ('p','poison_damage_taken',$1)", [BITTER_BLOOD_POISON_DAMAGE_REQUIRED]);
    await pool.query("INSERT INTO player_achievements VALUES ('other',$1,'2026-09-01T00:00:00Z')", [BITTER_BLOOD_ACHIEVEMENT_ID]);
    const gameplay = new AchievementService(pool);
    await gameplay.connectRuntime("p");

    const before = await service.snapshot("p");
    expect(before.metrics.poison_damage_taken).toBe(BITTER_BLOOD_POISON_DAMAGE_REQUIRED);
    expect(before.completed[BITTER_BLOOD_ACHIEVEMENT_ID]).toBeUndefined();
    expect(before.newlyCompletedIds).not.toContain(BITTER_BLOOD_ACHIEVEMENT_ID);
    expect(await gameplay.hasAchievement("p", BITTER_BLOOD_ACHIEVEMENT_ID)).toBe(false);

    // Only the existing service may persist the unlock and update the equipment
    // eligibility cache. Refreshing the journal must never bypass that authority.
    expect(await gameplay.flushPlayer("p")).toBe(true);
    expect(await gameplay.hasAchievement("p", BITTER_BLOOD_ACHIEVEMENT_ID)).toBe(true);
    const original = (await gameplay.snapshot("p")).achievements[0]!;
    const recorded = await service.snapshot("p");
    expect(recorded.completed[BITTER_BLOOD_ACHIEVEMENT_ID]).toBe(original.completedAt);
    expect(recorded.newlyCompletedIds).not.toContain(BITTER_BLOOD_ACHIEVEMENT_ID);
    expect(legendPrestige(LEGEND_CATALOG, recorded.completed).points).toBe(25);

    await pool.query("UPDATE player_stats SET value=0 WHERE player_id='p'");
    const retained = await new LegendJournalService(pool).snapshot("p");
    expect(retained.completed).toEqual(recorded.completed);
    expect(retained.newlyCompletedIds).toEqual([]);
    expect((await pool.query("SELECT achievement_id FROM player_achievements WHERE player_id='p'")).rows)
      .toEqual([{ achievement_id: BITTER_BLOOD_ACHIEVEMENT_ID }]);
  });

  it("awards retroactive chapters once across simultaneous refreshes and server restart", async () => {
    // Enough committed activity for several low and intermediate entries and
    // chapters. Existing receipt primary keys prevent event replay inflation.
    await pool.query(`
      INSERT INTO creature_book_kill_occurrences
        SELECT 'p','combat_settlement','kill-' || n,'deer' FROM generate_series(1,1000) n;
      INSERT INTO harvest_sessions
        SELECT 'p','wood-' || n,'wood','completed' FROM generate_series(1,1000) n;
      INSERT INTO repeatable_resource_sessions
        SELECT 'p','iron-' || n,'iron','completed' FROM generate_series(1,1000) n;
      INSERT INTO repeatable_resource_harvests SELECT 'p','iron-' || n FROM generate_series(1,1000) n;
      INSERT INTO loom_jobs VALUES ('p',1000);
      INSERT INTO repeatable_resource_harvests VALUES ('p','iron1'),('p','iron2');
      INSERT INTO furnace_smelt_jobs VALUES ('bars','p','fire_bar',1000);
      INSERT INTO player_profession_progress VALUES ('p','woodcutter',8),('p','miner',8);
      INSERT INTO player_progression_profiles VALUES ('p',25);
    `);
    const results = await Promise.all(Array.from({ length: 5 }, () => service.snapshot("p")));
    const announced = results.flatMap((result) => result.newlyCompletedIds);
    expect(announced.length).toBeGreaterThan(3);
    expect(new Set(announced).size).toBe(announced.length);
    const rows = await pool.query("SELECT achievement_id,unlocked_at FROM player_achievements WHERE player_id='p'");
    expect(rows.rowCount).toBe(announced.length);
    const afterRestart = await new LegendJournalService(pool).snapshot("p");
    expect(afterRestart.newlyCompletedIds).toEqual([]);
    expect(Object.keys(afterRestart.completed).sort()).toEqual([...announced].sort());
    for (const row of rows.rows) {
      expect(afterRestart.completed[row.achievement_id]).toBe(row.unlocked_at.toISOString());
    }
    const earnedQuests = LEGEND_CATALOG.filter((entry) => entry.kind === "quest" && afterRestart.completed[entry.id]);
    expect(earnedQuests.length).toBeGreaterThan(0);
    for (const entry of earnedQuests) {
      for (const prerequisite of entry.requires ?? []) expect(afterRestart.completed[prerequisite]).toBeDefined();
    }
    // Consuming materials or a later progression reduction must not remove a
    // completed achievement or its original timestamp.
    await pool.query("DELETE FROM loom_jobs; UPDATE player_progression_profiles SET level=0");
    const retained = await service.snapshot("p");
    expect(retained.completed).toEqual(afterRestart.completed);
  });

  it("rolls back failed unlocks and retries without losing the source history", async () => {
    await pool.query(`
      INSERT INTO creature_book_kill_occurrences
        SELECT 'p','combat_settlement','kill-' || n,'deer' FROM generate_series(1,100) n;
      ALTER TABLE player_achievements ADD CONSTRAINT injected_failure CHECK (player_id <> 'p') NOT VALID;
    `);
    await expect(service.snapshot("p")).rejects.toThrow();
    expect((await pool.query("SELECT * FROM player_achievements")).rowCount).toBe(0);
    await pool.query("ALTER TABLE player_achievements DROP CONSTRAINT injected_failure");
    const retried = await service.snapshot("p");
    expect(retried.metrics.kills_deer).toBe(100);
    expect(retried.newlyCompletedIds.length).toBeGreaterThan(0);
  });
});

const TABLES = [
  "creature_book_kill_occurrences", "creature_book_sightings",
  "creature_book_drop_occurrences", "harvest_sessions", "repeatable_resource_sessions",
  "repeatable_resource_harvests", "furnace_smelt_units", "furnace_smelt_jobs", "tannery_jobs", "loom_jobs", "kitchen_jobs",
  "combat_reward_participants", "combat_reward_settlements", "player_profession_progress", "player_progression_profiles",
  "player_stats", "player_achievements", "player_biome_discoveries"
];
const FIXTURE_SCHEMA = `
CREATE TABLE creature_book_kill_occurrences (player_id text,source_kind text,source_id text,mob_archetype text,PRIMARY KEY(player_id,source_kind,source_id));
CREATE TABLE creature_book_sightings (player_id text,mob_archetype text,PRIMARY KEY(player_id,mob_archetype));
CREATE TABLE creature_book_drop_occurrences (player_id text,source_kind text,source_id text,item_id text,PRIMARY KEY(player_id,source_kind,source_id,item_id));
CREATE TABLE harvest_sessions (player_id text,operation_key text,resource_type text,status text);
CREATE TABLE repeatable_resource_sessions (player_id text,operation_key text UNIQUE,resource_type text,status text);
CREATE TABLE repeatable_resource_harvests (player_id text,operation_key text PRIMARY KEY);
CREATE TABLE furnace_smelt_jobs (job_id text PRIMARY KEY,owner_player_id text,recipe_id text,collected_quantity integer);
CREATE TABLE furnace_smelt_units (job_id text REFERENCES furnace_smelt_jobs(job_id),unit_index integer,outcome text,PRIMARY KEY(job_id,unit_index));
CREATE TABLE tannery_jobs (owner_player_id text,recipe_id text,collected_quantity integer);
CREATE TABLE loom_jobs (owner_player_id text,collected_quantity integer);
CREATE TABLE kitchen_jobs (owner_player_id text,recipe_id text,collected_quantity integer);
CREATE TABLE combat_reward_settlements (settlement_key text PRIMARY KEY,status text,mob_archetype text,candidate jsonb);
CREATE TABLE combat_reward_participants (settlement_key text REFERENCES combat_reward_settlements(settlement_key),player_id text,authoritative_damage integer,PRIMARY KEY(settlement_key,player_id));
CREATE TABLE player_profession_progress (player_id text,profession_id text,rank integer,PRIMARY KEY(player_id,profession_id));
CREATE TABLE player_progression_profiles (player_id text PRIMARY KEY,level integer);
CREATE TABLE player_stats (player_id text,stat_key text,value bigint,PRIMARY KEY(player_id,stat_key));
CREATE TABLE player_achievements (player_id text,achievement_id text,unlocked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(player_id,achievement_id));
CREATE TABLE player_biome_discoveries (player_id text,biome_id text,discovered_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(player_id,biome_id));
`;
