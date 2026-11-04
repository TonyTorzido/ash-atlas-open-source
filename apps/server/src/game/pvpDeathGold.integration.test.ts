import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PVP_DEFEAT_SAFETY_MS } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { ProgressionService } from "./progression.js";
import { applyPvpDeathGoldLoss } from "./pvpDeathGold.js";
import { resolvePvpDeath } from "./pvpPendingDeaths.js";
import { PvpTimerService } from "./pvpTimers.js";
import { WalletService } from "./wallet.js";

const adminUrl = process.env.PVP_DEATH_GOLD_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const pvpMigration = "1010_pvp_timers_and_death_gold.sql";
const safetyMigration = "1031_pvp_defeat_safety.sql";
const rogueTheftMigration = "1095_pvp_rogue_theft.sql";
const memberXpMigration = "1151_kingdom_member_xp.sql";
const repoMigrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
// Level 2 starts at 15,270 total XP, level 3 at 24,337, level 4 at 34,517.
// Beginners are level 3 and under; VETERAN_XP is level 4.
const VETERAN_XP = 40_000;
const LEVEL_3_XP = 30_000;
const LEVEL_3_FIRST_XP = 24_337;
const LEVEL_4_FIRST_XP = 34_517;

describeDatabase("PvP death gold loss and timers (PostgreSQL)", () => {
  const databaseName = `ash_atlas_stability_pvp_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let databaseUrl = "";
  let migrationsDirectory = "";
  const wallet = new WalletService();

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !/^ash_atlas_stability(?:_[a-z0-9_]+)?$/u.test(parsed.pathname.slice(1))) {
      throw new Error("PvP death gold test requires a local disposable stability database");
    }
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 6 });
    // Every migration before 1010, so the upgrade runs against populated data.
    migrationsDirectory = await mkdtemp(path.join(tmpdir(), "ash-atlas-pvp-"));
    for (const file of await readdir(repoMigrations)) {
      if (file.endsWith(".sql") && file < pvpMigration) {
        await copyFile(path.join(repoMigrations, file), path.join(migrationsDirectory, file));
      }
    }
    // Granting XP credits Kingdom member XP, so that table (migration 1151) must exist from the start.
    await copyFile(path.join(repoMigrations, memberXpMigration), path.join(migrationsDirectory, memberXpMigration));
    await runMigrations(databaseUrl, { migrationsDirectory });
  }, 600_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin?.end();
    if (migrationsDirectory) await rm(migrationsDirectory, { recursive: true, force: true });
  });

  it("upgrades a populated database, then a second run applies nothing", async () => {
    await createPlayer("veteran", VETERAN_XP, 1_000n);
    await createPlayer("raider", VETERAN_XP, 50n);
    await copyFile(path.join(repoMigrations, pvpMigration), path.join(migrationsDirectory, pvpMigration));
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([pvpMigration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    // Existing wallets and progression are untouched.
    expect(await gold("veteran")).toBe(1_000n);
    await copyFile(path.join(repoMigrations, rogueTheftMigration), path.join(migrationsDirectory, rogueTheftMigration));
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([rogueTheftMigration]);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    await expect(pool.query("SELECT count(*)::int AS n FROM player_pvp_death_gold_losses WHERE rogue_theft <> 0")).resolves.toMatchObject({ rows: [{ n: 0 }] });
    await expect(pool.query("SELECT count(*)::int AS n FROM player_pvp_timers")).resolves.toMatchObject({ rows: [{ n: 0 }] });
  }, 120_000);

  it("moves 12% of carried gold to the killer once per death, even when replayed concurrently", async () => {
    const kill = () => applyPvpDeathGoldLoss(pool, wallet, {
      deathOperationKey: "player-death:d1", victimPlayerId: "veteran", killerPlayerId: "raider"
    });
    const [first, replay] = await Promise.all([kill(), kill()]);
    expect([first!.applied, replay!.applied].sort()).toEqual([false, true]);
    expect(first).toMatchObject({ carriedBefore: 1_000n, goldLost: 120n, rogueTheft: 0n, beginnerProtected: false });
    expect(replay).toMatchObject({ carriedBefore: 1_000n, goldLost: 120n });
    // A later sequential replay is also a no-op.
    expect(await kill()).toMatchObject({ applied: false, goldLost: 120n });
    expect(await gold("veteran")).toBe(880n);
    expect(await gold("raider")).toBe(170n);
    const ledger = await pool.query<{ player_id: string; delta_gold: string; reason: string }>(
      `SELECT player_id, delta_gold::text, reason FROM wallet_events
       WHERE operation_key = 'pvp-death-gold:player-death:d1' ORDER BY player_id`
    );
    expect(ledger.rows).toEqual([
      { player_id: "raider", delta_gold: "120", reason: "pvp_death_gold_taken" },
      { player_id: "veteran", delta_gold: "-120", reason: "pvp_death_gold_lost" }
    ]);
    // Never minted: both legs of the one operation key sum to zero.
    expect(ledger.rows.reduce((sum, row) => sum + BigInt(row.delta_gold), 0n)).toBe(0n);
    // Rounds down: 12% of 8 carried gold is nothing.
    await createPlayer("pauper", VETERAN_XP, 8n);
    expect(await applyPvpDeathGoldLoss(pool, wallet, {
      deathOperationKey: "player-death:d2", victimPlayerId: "pauper", killerPlayerId: "raider"
    })).toMatchObject({ applied: true, goldLost: 0n });
    expect(await gold("pauper")).toBe(8n);
  });

  it("takes nothing from a beginner at level 3 and under: no gold, no XP, no max HP, nothing for the killer", async () => {
    await createPlayer("novice", LEVEL_3_XP, 500n);
    const raiderBefore = await gold("raider");
    expect(await applyPvpDeathGoldLoss(pool, wallet, {
      deathOperationKey: "player-death:d3", victimPlayerId: "novice", killerPlayerId: "raider"
    })).toMatchObject({ applied: true, beginnerProtected: true, victimLevel: 3, goldLost: 0n });
    expect(await gold("novice")).toBe(500n);
    expect(await gold("raider")).toBe(raiderBefore);
    const xp = await new ProgressionService(pool).applyDeathPenalty({
      operationKey: "player-death:d3", playerId: "novice", metadata: { killerPlayerId: "raider" }
    });
    expect(xp).toMatchObject({ xpLost: 0, previousXp: LEVEL_3_XP, resultingXp: LEVEL_3_XP });
    // Beginner protection also skips the -6 max HP, and a replay stays a no-op.
    const maxHealth = () => new ProgressionService(pool).applyPvpMaxHealthLoss({
      operationKey: "player-death:d3", playerId: "novice", killerPlayerId: "raider",
      revenantArmor: false, unpenalizedMaxHealth: 100
    });
    expect(await maxHealth()).toMatchObject({ replayed: false, appliedLoss: 0, penalty: null });
    expect(await maxHealth()).toMatchObject({ replayed: true, appliedLoss: 0, penalty: null });
  });

  it("reads the victim's level inside the transfer: level 3 is protected, the first XP of level 4 is not", async () => {
    await createPlayer("edge3", LEVEL_3_FIRST_XP, 1_000n);
    await createPlayer("edge4", LEVEL_4_FIRST_XP - 1, 1_000n);
    expect(await applyPvpDeathGoldLoss(pool, wallet, {
      deathOperationKey: "player-death:edge3", victimPlayerId: "edge3", killerPlayerId: "raider"
    })).toMatchObject({ victimLevel: 3, beginnerProtected: true, goldLost: 0n });
    // One XP later edge4 reaches level 4; the transfer reads the level it has at death.
    await new ProgressionService(pool).grantXp({
      operationKey: "edge4-level-up", playerId: "edge4", sourceType: "development", requestedXp: 1
    });
    expect(await applyPvpDeathGoldLoss(pool, wallet, {
      deathOperationKey: "player-death:edge4", victimPlayerId: "edge4", killerPlayerId: "raider"
    })).toMatchObject({ victimLevel: 4, beginnerProtected: false, goldLost: 120n });
    // The database refuses a record that calls a level 3 victim unprotected.
    await expect(pool.query(
      `INSERT INTO player_pvp_death_gold_losses
         (operation_key, victim_player_id, killer_player_id, victim_level, beginner_protected, carried_before, gold_lost)
       VALUES ('forged', 'edge3', 'raider', 3, false, 1000, 120)`
    )).rejects.toThrow(/beginner_valid/u);
  });

  it("applies the 12% gold and the -6 max HP once per PvP death; a replay applies neither again", async () => {
    await createPlayer("duelist", VETERAN_XP, 2_000n);
    await createPlayer("hunter", VETERAN_XP, 0n);
    const progression = new ProgressionService(pool);
    const death = async () => ({
      gold: await applyPvpDeathGoldLoss(pool, wallet, {
        deathOperationKey: "player-death:d5", victimPlayerId: "duelist", killerPlayerId: "hunter"
      }),
      maxHealth: await progression.applyPvpMaxHealthLoss({
        operationKey: "player-death:d5", playerId: "duelist", killerPlayerId: "hunter",
        revenantArmor: false, unpenalizedMaxHealth: 100
      })
    });
    const first = await death();
    expect(first.gold).toMatchObject({ applied: true, goldLost: 240n, beginnerProtected: false });
    expect(first.maxHealth).toMatchObject({ replayed: false, appliedLoss: 6, penalty: { penalty: 6 } });
    const replay = await death();
    expect(replay.gold).toMatchObject({ applied: false, goldLost: 240n });
    expect(replay.maxHealth).toMatchObject({ replayed: true, appliedLoss: 6, penalty: { penalty: 6 } });
    expect(await gold("duelist")).toBe(1_760n);
    expect(await gold("hunter")).toBe(240n);
    await expect(pool.query(
      "SELECT penalty FROM player_max_health_penalties WHERE player_id = 'duelist'"
    )).resolves.toMatchObject({ rows: [{ penalty: 6 }] });
    await expect(pool.query(
      "SELECT count(*)::int AS n FROM player_pvp_max_health_losses WHERE operation_key = 'player-death:d5'"
    )).resolves.toMatchObject({ rows: [{ n: 1 }] });
  });

  it("keeps a PvE death to the 3% XP loss with no gold (no killer, no gold call)", async () => {
    // PvE deaths reach persistDeathPenaltyAndRefresh without a killerPlayerId, so only the XP penalty runs.
    const xp = await new ProgressionService(pool).applyDeathPenalty({
      operationKey: "player-death:pve", playerId: "veteran", metadata: {}
    });
    expect(xp).toMatchObject({ xpLost: 342, previousXp: VETERAN_XP });
    expect(await gold("veteran")).toBe(880n);
    expect(await applyPvpDeathGoldLoss(pool, wallet, {
      deathOperationKey: "player-death:self", victimPlayerId: "veteran", killerPlayerId: "veteran"
    })).toBeNull();
  });

  it("never overdraws: a spend racing the death is settled against the locked balance", async () => {
    await createPlayer("spender", VETERAN_XP, 1_000n);
    await createPlayer("taker", VETERAN_XP, 0n);
    const accountId = (await pool.query<{ account_id: string }>(
      "SELECT account_id::text FROM players WHERE id = 'spender'"
    )).rows[0]!.account_id;
    const spend = async (): Promise<boolean> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await wallet.debitForOperationInTransaction(client, {
          playerId: "spender", accountId, amount: 950n, operationKey: "spend:race", reason: "development_grant"
        });
        await client.query("COMMIT");
        return true;
      } catch {
        await client.query("ROLLBACK");
        return false;
      } finally {
        client.release();
      }
    };
    const [spent, death] = await Promise.all([
      spend(),
      applyPvpDeathGoldLoss(pool, wallet, {
        deathOperationKey: "player-death:race", victimPlayerId: "spender", killerPlayerId: "taker"
      })
    ]);
    // The 12% is of whatever the wallet held when the transfer locked it:
    // 1,000 if the death went first, 50 if the spend did.
    expect([120n, 6n]).toContain(death!.goldLost);
    const victim = await gold("spender");
    const killer = await gold("taker");
    expect(victim).toBeGreaterThanOrEqual(0n);
    expect(killer).toBe(death!.goldLost);
    expect(victim + killer + (spent ? 950n : 0n)).toBe(1_000n);
  });

  it("pays the same killer from the same victim at most once per 20 hours; a repeat kill moves nothing", async () => {
    await createPlayer("alt-main", VETERAN_XP, 1_000n);
    await createPlayer("alt-farm", VETERAN_XP, 0n);
    await createPlayer("bystander", VETERAN_XP, 0n);
    const kill = (death: string, killer = "alt-farm") => applyPvpDeathGoldLoss(pool, wallet, {
      deathOperationKey: `player-death:${death}`, victimPlayerId: "alt-main", killerPlayerId: killer
    });
    expect(await kill("farm-1")).toMatchObject({ applied: true, repeatKill: false, goldLost: 120n });
    // Second kill inside 20 hours: no loss for the victim, no gain for the killer.
    expect(await kill("farm-2")).toMatchObject({ applied: true, repeatKill: true, goldLost: 0n });
    expect(await gold("alt-main")).toBe(880n);
    expect(await gold("alt-farm")).toBe(120n);
    // A different killer is a different pair and still takes 12%.
    expect(await kill("farm-3", "bystander")).toMatchObject({ repeatKill: false, goldLost: 105n });
    // Once 20 hours have passed since the paid kill, the pair pays again.
    await pool.query("ALTER TABLE player_pvp_death_gold_losses DISABLE TRIGGER player_pvp_death_gold_losses_append_only");
    await pool.query(
      `UPDATE player_pvp_death_gold_losses SET created_at = now() - interval '20 hours 1 minute'
       WHERE victim_player_id = 'alt-main' AND killer_player_id = 'alt-farm'`
    );
    await pool.query("ALTER TABLE player_pvp_death_gold_losses ENABLE TRIGGER player_pvp_death_gold_losses_append_only");
    expect(await kill("farm-4")).toMatchObject({ repeatKill: false, goldLost: 93n });
  });

  describe("Rogue theft", () => {
    const setRogue = async (playerId: string, rank: number, active = true): Promise<void> => {
      await pool.query(
        `INSERT INTO player_specialization_ranks (player_id, specialization_id, rank, points_spent)
         VALUES ($1, 'rogue', $2, $2)
         ON CONFLICT (player_id, specialization_id) DO UPDATE SET rank = EXCLUDED.rank`,
        [playerId, rank]
      );
      await pool.query(
        `INSERT INTO player_specialization_state (player_id, active_specialization_id, committed_specialization_id)
         VALUES ($1, $2, 'rogue')
         ON CONFLICT (player_id) DO UPDATE SET active_specialization_id = EXCLUDED.active_specialization_id,
           committed_specialization_id = 'rogue'`,
        [playerId, active ? "rogue" : null]
      );
    };
    const kill = (death: string, victim: string, killer: string) => applyPvpDeathGoldLoss(pool, wallet, {
      deathOperationKey: `player-death:${death}`, victimPlayerId: victim, killerPlayerId: killer
    });
    const caps = [0n, 900n, 900n, 2_200n, 4_500n];

    for (const rank of [1, 2, 3, 4, 5]) {
      it(`rank ${rank} steals ${caps[rank - 1]} gold from a very rich victim on top of the 12% loss`, async () => {
        const victim = `rt-victim-${rank}`;
        const killer = `rt-rogue-${rank}`;
        const cap = caps[rank - 1]!;
        await createPlayer(victim, VETERAN_XP, 1_000_000n);
        await createPlayer(killer, VETERAN_XP, 0n);
        await setRogue(killer, rank);
        const result = await kill(`rt-${rank}`, victim, killer);
        expect(result).toMatchObject({ applied: true, goldLost: 120_000n, rogueTheft: cap });
        // Theft comes from what is left after the normal loss; the killer gets both.
        expect(await gold(victim)).toBe(880_000n - cap);
        expect(await gold(killer)).toBe(120_000n + cap);
        const ledger = await pool.query<{ player_id: string; delta_gold: string; reason: string }>(
          `SELECT player_id, delta_gold::text, reason FROM wallet_events
           WHERE operation_key = $1 ORDER BY reason`,
          [`pvp-death-gold:player-death:rt-${rank}:rogue-theft`]
        );
        if (cap === 0n) {
          expect(ledger.rows).toEqual([]);
        } else {
          expect(ledger.rows).toEqual([
            { player_id: victim, delta_gold: (-cap).toString(), reason: "pvp_rogue_theft_lost" },
            { player_id: killer, delta_gold: cap.toString(), reason: "pvp_rogue_theft_taken" }
          ]);
        }
      });
    }

    it("steals 9% of what is left below the cap, and nothing from a victim with too little", async () => {
      await createPlayer("rt-mid-victim", VETERAN_XP, 10_000n);
      await createPlayer("rt-mid-rogue", VETERAN_XP, 0n);
      await setRogue("rt-mid-rogue", 5);
      // 12% of 10,000 is 1,200; 9% of the remaining 8,800 is 792.
      expect(await kill("rt-mid", "rt-mid-victim", "rt-mid-rogue")).toMatchObject({ goldLost: 1_200n, rogueTheft: 792n });
      expect(await gold("rt-mid-victim")).toBe(8_008n);
      expect(await gold("rt-mid-rogue")).toBe(1_992n);
      await createPlayer("rt-poor-victim", VETERAN_XP, 8n);
      expect(await kill("rt-poor", "rt-poor-victim", "rt-mid-rogue")).toMatchObject({ goldLost: 0n, rogueTheft: 0n });
      expect(await gold("rt-poor-victim")).toBe(8n);
    });

    it("steals nothing from a beginner, nothing on a repeat kill, and nothing for an inactive Rogue", async () => {
      await createPlayer("rt-novice", LEVEL_3_XP, 100_000n);
      await createPlayer("rt-rich", VETERAN_XP, 100_000n);
      await createPlayer("rt-farmer", VETERAN_XP, 0n);
      await createPlayer("rt-benched", VETERAN_XP, 0n);
      await setRogue("rt-farmer", 5);
      await setRogue("rt-benched", 5, false);
      expect(await kill("rt-beginner", "rt-novice", "rt-farmer")).toMatchObject({ beginnerProtected: true, goldLost: 0n, rogueTheft: 0n });
      expect(await gold("rt-novice")).toBe(100_000n);
      expect(await kill("rt-first", "rt-rich", "rt-farmer")).toMatchObject({ repeatKill: false, goldLost: 12_000n, rogueTheft: 4_500n });
      const afterFirst = await gold("rt-rich");
      expect(afterFirst).toBe(83_500n);
      expect(await kill("rt-repeat", "rt-rich", "rt-farmer")).toMatchObject({ repeatKill: true, goldLost: 0n, rogueTheft: 0n });
      expect(await gold("rt-rich")).toBe(afterFirst);
      expect(await kill("rt-benched", "rt-rich", "rt-benched")).toMatchObject({ goldLost: 10_020n, rogueTheft: 0n });
    });

    it("pays the theft once per death, even when the death is replayed concurrently", async () => {
      await createPlayer("rt-replay-victim", VETERAN_XP, 1_000_000n);
      await createPlayer("rt-replay-rogue", VETERAN_XP, 0n);
      await setRogue("rt-replay-rogue", 4);
      const [first, second] = await Promise.all([
        kill("rt-replay", "rt-replay-victim", "rt-replay-rogue"),
        kill("rt-replay", "rt-replay-victim", "rt-replay-rogue")
      ]);
      expect([first!.applied, second!.applied].sort()).toEqual([false, true]);
      expect(first).toMatchObject({ goldLost: 120_000n, rogueTheft: 2_200n });
      expect(second).toMatchObject({ goldLost: 120_000n, rogueTheft: 2_200n });
      expect(await kill("rt-replay", "rt-replay-victim", "rt-replay-rogue")).toMatchObject({ applied: false, rogueTheft: 2_200n });
      expect(await gold("rt-replay-victim")).toBe(877_800n);
      expect(await gold("rt-replay-rogue")).toBe(122_200n);
      await expect(pool.query(
        "SELECT count(*)::int AS n FROM wallet_events WHERE operation_key = 'pvp-death-gold:player-death:rt-replay:rogue-theft'"
      )).resolves.toMatchObject({ rows: [{ n: 2 }] });
    });
  });

  it("recovers the killer after a crash so the PvP losses apply exactly once, and never guesses one", async () => {
    await createPlayer("crash-victim", VETERAN_XP, 500n);
    await createPlayer("crash-killer", VETERAN_XP, 0n);
    const progression = new ProgressionService(pool);
    const deathKey = "player-death:crash";
    const settle = async (input: { operationKey: string; playerId: string; metadata: Record<string, unknown> }) => {
      const death = await resolvePvpDeath(pool, input);
      if (!death) return null;
      return {
        death,
        gold: death.goldEligible
          ? await applyPvpDeathGoldLoss(pool, wallet, {
            deathOperationKey: input.operationKey, victimPlayerId: input.playerId, killerPlayerId: death.killerPlayerId
          })
          : null,
        maxHealth: await progression.applyPvpMaxHealthLoss({
          operationKey: input.operationKey, playerId: input.playerId, killerPlayerId: death.killerPlayerId,
          revenantArmor: death.revenantArmor, unpenalizedMaxHealth: 100
        })
      };
    };
    // The live attempt records the killer, then the process dies mid-settlement.
    expect(await resolvePvpDeath(pool, {
      operationKey: deathKey, playerId: "crash-victim",
      metadata: { killerPlayerId: "crash-killer", pvpGoldEligible: true }
    })).toEqual({ killerPlayerId: "crash-killer", goldEligible: true, revenantArmor: false });
    // The recovered retry knows only the death key, and still applies the losses once.
    const recovered = { operationKey: deathKey, playerId: "crash-victim", metadata: { recoveredFromCombatProfile: true } };
    const [first, second] = await Promise.all([settle(recovered), settle(recovered)]);
    expect([first!.gold!.applied, second!.gold!.applied].sort()).toEqual([false, true]);
    expect([first!.maxHealth.replayed, second!.maxHealth.replayed].sort()).toEqual([false, true]);
    expect(await gold("crash-victim")).toBe(440n);
    expect(await gold("crash-killer")).toBe(60n);
    // A death with no recorded killer (PvE, or the record never landed) moves nothing.
    expect(await settle({
      operationKey: "player-death:unknown", playerId: "crash-victim", metadata: { recoveredFromCombatProfile: true }
    })).toBeNull();
    // A kill by a player's units (undead, military) or by the world is never gold-eligible.
    expect(await settle({
      operationKey: "player-death:minion", playerId: "crash-victim",
      metadata: { killerPlayerId: "crash-killer", pvpGoldEligible: false }
    })).toMatchObject({ gold: null });
    expect(await gold("crash-victim")).toBe(440n);
  });

  it("upgrades a populated database to the post-kill safety table (second run applies nothing) and keeps the safety across a restart", async () => {
    const later = (await readdir(repoMigrations)).filter((file) => file.endsWith(".sql") && file > pvpMigration && file <= safetyMigration).sort();
    expect(later.at(-1)).toBe(safetyMigration);
    for (const file of later) await copyFile(path.join(repoMigrations, file), path.join(migrationsDirectory, file));
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual(later);
    await expect(runMigrations(databaseUrl, { migrationsDirectory })).resolves.toEqual([]);
    expect(await gold("veteran")).toBeGreaterThan(0n);

    const now = Date.now();
    const before = new PvpTimerService(pool, { now: () => now });
    before.recordDeath("veteran", "raider");
    await before.flush();
    const after = new PvpTimerService(pool, { now: () => now });
    await after.load();
    expect(after.defeatSafetyMs("veteran")).toBeGreaterThan(PVP_DEFEAT_SAFETY_MS - 2_000);
    expect(after.defeatSafetyMs("raider")).toBeNull();
    await pool.query("DELETE FROM player_pvp_defeat_safety");
  }, 300_000);

  it("persists aggressor marks and strike blocks so a restart keeps them", async () => {
    let now = Date.now();
    const before = new PvpTimerService(pool, { now: () => now });
    before.recordHit("raider", "veteran", now + 10_000);
    await before.flush();
    const after = new PvpTimerService(pool, { now: () => now });
    await after.load();
    // The aggressor is still blocked; the victim may still strike back.
    expect(after.strikeBlockMs("raider", "veteran")).not.toBeNull();
    expect(after.strikeBlockMs("veteran", "raider")).toBeNull();
    expect(after.timersFor("veteran")).toEqual([expect.objectContaining({ kind: "aggressor", playerId: "raider" })]);
    // A fight does not survive the restart, but the victim can start a new one.
    after.recordHit("veteran", "raider", now + 10_000);
    expect(after.isFighting("veteran", "raider")).toBe(true);
    now += 11_000;
    expect(after.strikeBlockMs("raider", "veteran")).not.toBeNull();
    await after.flush();
    const rows = await pool.query("SELECT holder_player_id, other_player_id, kind FROM player_pvp_timers ORDER BY kind");
    expect(rows.rows).toEqual([
      { holder_player_id: "veteran", other_player_id: "raider", kind: "aggressor" },
      { holder_player_id: "veteran", other_player_id: "raider", kind: "strike_block" }
    ]);
  });

  async function createPlayer(id: string, totalXp: number, goldBalance: bigint): Promise<void> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, username_normalized, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1,$2,$1,$1,'#38bdf8','NM',35,-106,35,-106,900,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [id, accountId]
    );
    const progression = new ProgressionService(pool);
    await progression.grantXp({ operationKey: `seed:${id}`, playerId: id, sourceType: "development", requestedXp: totalXp });
    if (goldBalance > 0n) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await wallet.creditForOperationInTransaction(client, {
          playerId: id, accountId, amount: goldBalance, operationKey: `seed-gold:${id}`, reason: "development_grant"
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    }
  }

  async function gold(playerId: string): Promise<bigint> {
    const result = await pool.query<{ gold_balance: string }>(
      "SELECT gold_balance::text FROM player_wallets WHERE player_id = $1", [playerId]
    );
    return BigInt(result.rows[0]?.gold_balance ?? "0");
  }
});
