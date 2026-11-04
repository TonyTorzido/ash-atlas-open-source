import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { PostgresRevenantMetalLichStore } from "./revenantMetalLichStore.js";
import { ProgressionService } from "./progression.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const REVENANT_METAL_MIGRATION = "0960_revenant_metal_lich_and_pvp_max_health.sql";
const HOUR = 60 * 60 * 1_000;

describeDatabase("Revenant Metal persistence", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_revenant_metal_${suffix}`;
  const victimId = `dead-victim-${suffix}`;
  const killerId = `dead-killer-${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-revenant-metal-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < REVENANT_METAL_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 8 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("upgrades a populated database and reruns empty", async () => {
    for (const playerId of [victimId, killerId]) await createPlayer(playerId);
    // Level 4 (34,517+ XP): beginners at level 3 and under are spared the PvP max-HP loss.
    await pool.query("INSERT INTO player_progression_profiles (player_id, level, total_xp) VALUES ($1, 4, 40000)", [victimId]);

    // Later migrations (e.g. weapon-family items) may also be pending; 0960 must be the first.
    await expect(runMigrations(databaseUrl)).resolves.toEqual(
      expect.arrayContaining([REVENANT_METAL_MIGRATION])
    );
    await expect(pool.query("SELECT count(*)::int AS count FROM player_progression_profiles WHERE player_id = $1", [victimId]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 180_000);

  it("takes 6 max HP per PvP death (4 with Revenant armor) once per death operation", async () => {
    const progression = new ProgressionService(pool);
    const now = Date.UTC(2026, 9, 3, 12);
    const first = await progression.applyPvpMaxHealthLoss({
      operationKey: "player-death:one", playerId: victimId, killerPlayerId: killerId,
      revenantArmor: false, unpenalizedMaxHealth: 100, nowMs: now
    });
    expect(first).toMatchObject({ replayed: false, appliedLoss: 6, penalty: { penalty: 6, recoveryAnchorMs: now } });
    const replay = await progression.applyPvpMaxHealthLoss({
      operationKey: "player-death:one", playerId: victimId, killerPlayerId: killerId,
      revenantArmor: false, unpenalizedMaxHealth: 100, nowMs: now + HOUR
    });
    expect(replay).toMatchObject({ replayed: true, appliedLoss: 6, penalty: { penalty: 6 } });

    const second = await progression.applyPvpMaxHealthLoss({
      operationKey: "player-death:two", playerId: victimId, killerPlayerId: killerId,
      revenantArmor: true, unpenalizedMaxHealth: 100, nowMs: now + 1.5 * HOUR
    });
    // One hour recovered (6 -> 5), +4 with Revenant armor; the half hour of progress is kept.
    expect(second).toMatchObject({ appliedLoss: 4, penalty: { penalty: 9, recoveryAnchorMs: now + HOUR } });
    await expect(progression.maxHealthPenalty(victimId)).resolves.toEqual({ penalty: 9, recoveryAnchorMs: now + HOUR });
    await expect(pool.query(
      "SELECT requested_loss, applied_loss FROM player_pvp_max_health_losses WHERE player_id = $1 ORDER BY created_at",
      [victimId]
    )).resolves.toMatchObject({ rows: [{ requested_loss: 6, applied_loss: 6 }, { requested_loss: 4, applied_loss: 4 }] });
  });

  it("keeps one Lich per owner with its HP, replaced by a newer death", async () => {
    const store = new PostgresRevenantMetalLichStore(pool);
    const snapshot = {
      name: "Victim's Lich", level: 10, maxHealth: 120, attack: 16, defense: 3,
      weaponProfile: "sword", weaponLevel: 5, bodyProfile: "chainmail", bodyLevel: 4,
      shieldProfile: "shield", shieldLevel: 2
    } as const;
    const expiresAt = Date.now() + 24 * HOUR;
    await store.replace({ ownerPlayerId: victimId, deathOperationKey: "player-death:a", snapshot, currentHealth: 120, expiresAt });
    await store.updateHealth(victimId, "player-death:a", 77);
    await expect(store.load(victimId)).resolves.toMatchObject({ deathOperationKey: "player-death:a", currentHealth: 77, snapshot });

    await store.replace({ ownerPlayerId: victimId, deathOperationKey: "player-death:b", snapshot, currentHealth: 120, expiresAt });
    // A late write from the replaced Lich is ignored.
    await store.updateHealth(victimId, "player-death:a", 10);
    await store.remove(victimId, "player-death:a");
    await expect(store.load(victimId)).resolves.toMatchObject({ deathOperationKey: "player-death:b", currentHealth: 120 });
    await store.remove(victimId, "player-death:b");
    await expect(store.load(victimId)).resolves.toBeNull();
  });

  async function createPlayer(playerId: string): Promise<void> {
    const accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id) VALUES ($1)", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES (
         $1, $2, $3, '#38bdf8', 'NM', 35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326)
       )`,
      [playerId, accountId, `Dead ${playerId.slice(0, 20)}`]
    );
  }
});
