import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WARRIOR_MAX_XP, WARRIOR_XP_THRESHOLDS } from "@ash-atlas/shared";

import { runMigrations } from "../db/migrate.js";
import { ClassService } from "./classes/classService.js";
import { MasteryService } from "./masteries.js";

const databaseUrl = process.env.MASTERY_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("durable profession mastery", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  const service = new MasteryService(pool);
  const classes = new ClassService(pool, service);
  const playerId = `mastery-${randomUUID()}`;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await pool.query(
      `INSERT INTO players (id, username, region_code, lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, online, geom)
       VALUES ($1,$1,'mastery-test',0,0,0,0,1250,false,ST_SetSRID(ST_MakePoint(0,0),4326))`,
      [playerId]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM mastery_progression_operations WHERE player_id = $1", [playerId]);
    await pool.query("DELETE FROM class_progression_operations WHERE player_id = $1", [playerId]);
    await pool.query("DELETE FROM dev_progression_operations WHERE player_id = $1", [playerId]);
    await pool.query("DELETE FROM class_operations WHERE player_id = $1", [playerId]);
    await pool.query("DELETE FROM players WHERE id = $1", [playerId]);
    await pool.end();
  });

  it("keeps tracks independent and replays XP operations without duplication", async () => {
    const initial = await service.getOrCreate(playerId);
    expect(Object.values(initial.professions).map((progress) => progress.rank)).toEqual([0, 0, 0, 0, 0]);

    const first = await service.grantProfessionXp({
      operationKey: `mastery-test:${playerId}:wood`, playerId,
      activity: { kind: "wood-harvest" }, randomResults: { bonusYield: true }
    });
    const replay = await service.grantProfessionXp({
      operationKey: `mastery-test:${playerId}:wood`, playerId,
      activity: { kind: "wood-harvest" }, randomResults: { bonusYield: true }
    });

    expect(first).toMatchObject({ resultingXp: 15, resultingRank: 0, grantedXp: 15, replayed: false });
    expect(replay).toMatchObject({ resultingXp: 15, resultingRank: 0, replayed: true });
    expect(replay.snapshot.professions.miner).toMatchObject({ xp: 0, rank: 0 });
    expect(replay.snapshot.warrior).toMatchObject({ xp: 0, rank: 0 });
    await expect(service.grantProfessionXp({
      operationKey: `mastery-test:${playerId}:wood`, playerId,
      activity: { kind: "stone-mine" }
    })).rejects.toThrow("idempotency key conflicts");
    await pool.query(
      `UPDATE player_profession_progress SET curve_version=3
       WHERE player_id=$1 AND profession_id='woodcutter'`,
      [playerId]
    );
    await expect(service.grantProfessionXp({
      operationKey: `mastery-test:${playerId}:unknown-curve`, playerId,
      activity: { kind: "wood-harvest" }
    })).rejects.toThrow("Unsupported profession curve version");
    await pool.query(
      `UPDATE player_profession_progress SET curve_version=2
       WHERE player_id=$1 AND profession_id='woodcutter'`,
      [playerId]
    );
  });

  it("keeps retired Hunter/Breeder rows stored but hidden, and preserves Metallurgy progress", async () => {
    await pool.query(
      `INSERT INTO player_profession_progress (player_id, profession_id, xp, rank, curve_version, completed_at)
       VALUES ($1,'hunter',100000,8,2,now()), ($1,'breeder',50000,4,2,now())
       ON CONFLICT (player_id, profession_id) DO UPDATE SET xp=EXCLUDED.xp, rank=EXCLUDED.rank, completed_at=EXCLUDED.completed_at`,
      [playerId]
    );
    await pool.query(
      `UPDATE player_profession_progress SET xp=21152, rank=4 WHERE player_id=$1 AND profession_id='metallurgy'`,
      [playerId]
    );
    await pool.query(
      `INSERT INTO player_mastery_achievements (player_id, achievement_id, title, badge_id)
       VALUES ($1,'master_hunter','Master Hunter','master_hunter'), ($1,'master_breeder','Master Breeder','master_breeder')`,
      [playerId]
    );
    await pool.query(`UPDATE player_mastery_state SET equipped_title='Master Hunter' WHERE player_id=$1`, [playerId]);

    const snapshot = await service.getOrCreate(playerId);
    expect(Object.keys(snapshot.professions).sort()).toEqual(["builder", "metallurgy", "miner", "oil_worker", "woodcutter"]);
    expect(snapshot.professions.metallurgy).toMatchObject({ xp: 21_152, rank: 4, maximumRank: 8 });
    expect(snapshot.achievementIds).not.toContain("master_hunter");
    expect(snapshot.achievementIds).not.toContain("master_breeder");
    expect(snapshot.equippedTitle).toBeNull();
    const stored = await pool.query<{ profession_id: string; xp: number }>(
      `SELECT profession_id, xp FROM player_profession_progress
       WHERE player_id=$1 AND profession_id IN ('hunter','breeder') ORDER BY profession_id`,
      [playerId]
    );
    expect(stored.rows).toEqual([{ profession_id: "breeder", xp: 50_000 }, { profession_id: "hunter", xp: 100_000 }]);
  });

  it("caps at 100,000 and records the title, badge, achievement, and completion timestamp", async () => {
    const grant = await service.grantProfessionXp({
      operationKey: `mastery-test:${playerId}:builder`, playerId,
      activity: { kind: "construction", baseDurationSeconds: 60_000 }
    });

    expect(grant).toMatchObject({ resultingXp: 100_000, resultingRank: 8, newlyMastered: true });
    expect(grant.snapshot.professions.builder).toMatchObject({ mastered: true, title: "Master Builder" });
    expect(grant.snapshot.professions.builder.completedAt).not.toBeNull();
    expect(grant.snapshot.achievementIds).toContain("master_builder");
    expect(grant.snapshot.equippedTitle).toBe("Master Builder");
    const row = await pool.query<{ badge_id: string }>(
      "SELECT badge_id FROM player_mastery_achievements WHERE player_id = $1 AND achievement_id = 'master_builder'",
      [playerId]
    );
    expect(row.rows[0]?.badge_id).toBe("master_builder");
  });

  it("lets development controls advance a profession directly to a target rank", async () => {
    const operationId = randomUUID();
    const result = await classes.adjustOwnDevelopmentProgression(
      playerId,
      "woodcutter_level",
      8,
      operationId,
      { restricted: false }
    );
    const replay = await classes.adjustOwnDevelopmentProgression(
      playerId,
      "woodcutter_level",
      8,
      operationId,
      { restricted: false }
    );

    expect(result.masteries?.professions.woodcutter).toMatchObject({
      xp: 100_000,
      rank: 8,
      mastered: true
    });
    expect(replay.replayed).toBe(true);
  });

  it("lets development controls decrease and restore exact profession thresholds and mastery metadata", async () => {
    const decreased = await classes.adjustOwnDevelopmentProgression(
      playerId, "woodcutter_level", 7, randomUUID(), { restricted: false }
    );
    expect(decreased.masteries?.professions.woodcutter).toMatchObject({
      xp: 69_795, rank: 7, mastered: false, completedAt: null
    });
    expect(decreased.masteries?.achievementIds).not.toContain("master_woodcutter");

    const restored = await classes.adjustOwnDevelopmentProgression(
      playerId, "woodcutter_level", 8, randomUUID(), { restricted: false }
    );
    expect(restored.masteries?.professions.woodcutter).toMatchObject({
      xp: 100_000, rank: 8, mastered: true
    });
    expect(restored.masteries?.achievementIds).toContain("master_woodcutter");
  });

  it("grants ordinary Warrior XP across a threshold, caps at Rank 15, and replays exactly once", async () => {
    const firstKey = `warrior-test:${playerId}:ordinary`;
    const first = await classes.grantCombatMastery(playerId, "warrior", WARRIOR_XP_THRESHOLDS[4]! - 1, firstKey);
    expect(first).toMatchObject({ previousLevel: 0, resultingLevel: 3, replayed: false });

    const threshold = await classes.grantCombatMastery(playerId, "warrior", 1, `warrior-test:${playerId}:threshold`);
    expect(threshold).toMatchObject({ previousLevel: 3, resultingLevel: 4, grantedXp: 1 });

    const maximumKey = `warrior-test:${playerId}:maximum`;
    const maximum = await classes.grantCombatMastery(playerId, "warrior", WARRIOR_MAX_XP, maximumKey);
    const replay = await classes.grantCombatMastery(playerId, "warrior", WARRIOR_MAX_XP, maximumKey);
    expect(maximum).toMatchObject({ resultingLevel: 15, replayed: false });
    expect(replay).toMatchObject({ resultingLevel: 15, replayed: true, grantedXp: maximum.grantedXp });
    const masteredProgress = await pool.query<{
      mastery_xp: number; mastery_rank: number; completed_at: Date | string | null;
    }>(
      `SELECT mastery_xp, mastery_rank, completed_at
       FROM player_class_progress WHERE player_id = $1 AND class_id = 'warrior'`,
      [playerId]
    );
    expect(masteredProgress.rows[0]).toMatchObject({
      mastery_xp: WARRIOR_MAX_XP,
      mastery_rank: 15
    });
    expect(masteredProgress.rows[0]?.completed_at).not.toBeNull();
    expect((await pool.query(
      `SELECT COUNT(*)::int AS count FROM class_progression_operations WHERE operation_key = $1`,
      [`${maximumKey}:warrior`]
    )).rows[0]?.count).toBe(1);

    await pool.query(
      `UPDATE player_class_runtime
       SET rage_reserved = 10,
           status_effects = '[{"id":"fortify","expiresAtTick":999}]'::jsonb,
           counters = '{"pendingResetAbilityId":"warrior_punishing_strike"}'::jsonb
       WHERE player_id = $1`,
      [playerId]
    );
    await pool.query(
      `UPDATE player_class_resources
       SET current_value = 20, reserved_value = 10,
           cooldown_ends_at = '{"warrior_fortify":999999}'::jsonb
       WHERE player_id = $1 AND class_id = 'warrior'`,
      [playerId]
    );
    const decreased = await classes.adjustOwnDevelopmentProgression(
      playerId, "warrior_level", 14, randomUUID(), { restricted: false }
    );
    expect(decreased.masteries?.warrior).toMatchObject({
      xp: WARRIOR_XP_THRESHOLDS[14], rank: 14, mastered: false, completedAt: null
    });
    expect(decreased.masteries?.achievementIds).not.toContain("master_warrior");
    const sanitized = await pool.query<{
      rage_reserved: number;
      status_effects: unknown[];
      counters: Record<string, unknown>;
      reserved_value: number;
      cooldown_ends_at: Record<string, number>;
    }>(
      `SELECT runtime.rage_reserved, runtime.status_effects, runtime.counters,
              resource.reserved_value, resource.cooldown_ends_at
       FROM player_class_runtime runtime
       JOIN player_class_resources resource
         ON resource.player_id = runtime.player_id AND resource.class_id = 'warrior'
       WHERE runtime.player_id = $1`,
      [playerId]
    );
    expect(sanitized.rows[0]).toMatchObject({
      rage_reserved: 0,
      status_effects: [],
      counters: {},
      reserved_value: 0,
      cooldown_ends_at: {}
    });

    const restored = await classes.adjustOwnDevelopmentProgression(
      playerId, "warrior_level", 15, randomUUID(), { restricted: false }
    );
    expect(restored.masteries?.achievementIds).toContain("master_warrior");
    const titles = await pool.query<{ equipped_title: string | null; profile_title: string | null }>(
      `SELECT state.equipped_title, profile.title AS profile_title
       FROM player_mastery_state state JOIN player_profiles profile ON profile.player_id = state.player_id
       WHERE state.player_id = $1`,
      [playerId]
    );
    expect(titles.rows[0]?.equipped_title).toBe(titles.rows[0]?.profile_title);
  });

  it("persists custom Warrior slots, rejects forged loadouts, and sanitizes a rank decrease", async () => {
    await classes.adjustOwnDevelopmentProgression(
      playerId, "warrior_level", 15, randomUUID(), { restricted: false }
    );
    const equipment = {
      playerId, instances: [], weapon: null, chest: null,
      totalAttackPowerBonus: 0, totalDefenseBonus: 0
    };
    const custom = {
      resetActives: [null, null],
      normalActives: ["warrior_v2_rallying_roar", "warrior_v2_faultline"],
      passiveTiers: ["warrior_v2_battle_hardened", "warrior_v2_battle_grit", "warrior_v2_juggernaut"],
      ultimateActive: "warrior_v2_worldbreaker"
    };
    await classes.updateLoadout(playerId, custom, randomUUID(), { inCombat: false, equipment });
    expect((await classes.getOrCreate(playerId)).loadout).toEqual(custom);

    await expect(classes.updateLoadout(playerId, {
      ...custom,
      normalActives: ["warrior_v2_rallying_roar", "warrior_v2_rallying_roar"]
    }, randomUUID(), { inCombat: false, equipment })).rejects.toMatchObject({
      code: "LOADOUT_DUPLICATE"
    });
    await expect(classes.updateLoadout(playerId, {
      ...custom,
      passiveTiers: ["warrior_v2_relentless", null, null]
    }, randomUUID(), { inCombat: false, equipment })).rejects.toMatchObject({
      code: "LOADOUT_SLOT_INVALID"
    });

    await pool.query(
      `UPDATE player_class_runtime
       SET rage_reserved = 10, counters = '{"pendingAbilityId":"warrior_v2_rallying_roar"}'::jsonb
       WHERE player_id = $1`,
      [playerId]
    );
    const decreased = await classes.adjustOwnDevelopmentProgression(
      playerId, "warrior_level", 4, randomUUID(), { restricted: false }
    );
    expect(decreased.snapshot.loadout).toEqual({
      resetActives: [null, null],
      normalActives: ["warrior_v2_sundering_arc", "warrior_v2_iron_reversal"],
      passiveTiers: ["warrior_v2_battle_hardened", null, null],
      ultimateActive: null
    });
    expect((await classes.getOrCreate(playerId)).loadout).toEqual(decreased.snapshot.loadout);
    expect((await pool.query<{ rage_reserved: number; counters: Record<string, unknown> }>(
      "SELECT rage_reserved, counters FROM player_class_runtime WHERE player_id = $1", [playerId]
    )).rows[0]).toMatchObject({ rage_reserved: 0, counters: {} });

    const restored = await classes.adjustOwnDevelopmentProgression(
      playerId, "warrior_level", 15, randomUUID(), { restricted: false }
    );
    expect(restored.snapshot.loadout).toEqual({
      resetActives: [null, null],
      normalActives: ["warrior_v2_sundering_arc", "warrior_v2_iron_reversal"],
      passiveTiers: ["warrior_v2_battle_hardened", "warrior_v2_relentless", "warrior_v2_berserker"],
      ultimateActive: "warrior_v2_worldbreaker"
    });
  });
});
