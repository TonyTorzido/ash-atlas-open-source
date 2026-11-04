import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEVEL_UP_GLIMMER_FEE, totalXpForLevel } from "@ash-atlas/shared";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { PremiumWalletService } from "./premiumWallet.js";
import { ProgressionService } from "./progression.js";
import { SkillService } from "./skills/skillService.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Glimmer progression costs", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_glimmer_costs_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  let pool: pg.Pool;
  let wallet: PremiumWalletService;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(parsed.toString());
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 8 });
    wallet = new PremiumWalletService(pool);
  }, 600_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
  });

  async function createPlayer(glimmer = 0, atlasPass = false): Promise<{ playerId: string; accountId: string }> {
    const accountId = randomUUID();
    const playerId = `glimmer-${randomUUID().slice(0, 8)}`;
    await pool.query("INSERT INTO accounts (id) VALUES ($1)", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES ($1, $2, $3, '#38bdf8', 'NM', 35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
      [playerId, accountId, `G${playerId.slice(-8)}`]
    );
    await pool.query("INSERT INTO player_progression_profiles (player_id) VALUES ($1)", [playerId]);
    if (glimmer > 0) await credit(accountId, glimmer);
    if (atlasPass) {
      await pool.query(
        `INSERT INTO premium_subscriptions (account_id, platform, original_transaction_id, sku, environment, status, current_period_end)
         VALUES ($1, 'web', $2, 'atlas_pass_monthly', 'sandbox', 'active', now() + interval '20 days')`,
        [accountId, `sub-${accountId}`]
      );
    }
    return { playerId, accountId };
  }

  async function credit(accountId: string, amount: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await wallet.creditForOperationInTransaction(client, {
        accountId, currency: "glimmer", amount: BigInt(amount), operationKey: `seed:${randomUUID()}`, reason: "admin"
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  async function glimmer(accountId: string): Promise<number> {
    return Number((await wallet.snapshot(accountId)).balances.glimmer.balance);
  }

  async function events(accountId: string, operationKey: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM premium_wallet_events WHERE account_id = $1 AND operation_key = $2",
      [accountId, operationKey]
    );
    return result.rows[0]!.count;
  }

  const grant = (playerId: string, xp: number) => ({
    operationKey: `xp:${randomUUID()}`, playerId, sourceType: "development" as const, requestedXp: xp
  });

  it("flag off: levels still apply automatically from XP", async () => {
    const { playerId } = await createPlayer();
    const off = new ProgressionService(pool);
    expect(off.levelUpGlimmerFee).toBeNull();
    const result = await off.grantXp(grant(playerId, totalXpForLevel(5)));
    expect(result.levelsGained).toEqual([1, 2, 3, 4, 5]);
    expect(result.progression.level).toBe(5);
    await expect(pool.query("SELECT level FROM player_progression_profiles WHERE player_id = $1", [playerId]))
      .resolves.toMatchObject({ rows: [{ level: 5 }] });
  });

  it("flag on: XP banks into a ready level, pays once per level, and never charges twice", async () => {
    const { playerId, accountId } = await createPlayer();
    const off = new ProgressionService(pool);
    await off.grantXp(grant(playerId, totalXpForLevel(4)));
    const on = new ProgressionService(pool, undefined, { levelUpFee: { glimmer: LEVEL_UP_GLIMMER_FEE, premiumWallet: wallet } });
    // Grandfathered: turning the fee on keeps the earned level.
    expect((await on.getOrCreate(playerId)).level).toBe(4);

    const banked = await on.grantXp(grant(playerId, totalXpForLevel(6) - totalXpForLevel(4)));
    expect(banked.levelsGained).toEqual([]);
    expect(banked.progression.level).toBe(4);
    expect(banked.progression.atCap).toBe(false);
    expect(banked.progression.nextLevelTotalXp).toBe(totalXpForLevel(5));
    expect(banked.progression.totalXp).toBeGreaterThanOrEqual(banked.progression.nextLevelTotalXp!);

    await expect(on.confirmLevelUp({ playerId, targetLevel: 5, expectedGlimmerCost: 70 }))
      .rejects.toMatchObject({ code: "LEVEL_UP_INSUFFICIENT_GLIMMER" });
    expect((await on.getOrCreate(playerId)).level).toBe(4);
    expect(await events(accountId, `character-level-up:${playerId}:5`)).toBe(0);

    await credit(accountId, 100);
    await expect(on.confirmLevelUp({ playerId, targetLevel: 6, expectedGlimmerCost: 70 }))
      .rejects.toMatchObject({ code: "LEVEL_UP_STALE" });
    await expect(on.confirmLevelUp({ playerId, targetLevel: 5, expectedGlimmerCost: 50 }))
      .rejects.toMatchObject({ code: "LEVEL_UP_PRICE_CHANGED" });
    const paid = await on.confirmLevelUp({ playerId, targetLevel: 5, expectedGlimmerCost: 70 });
    expect(paid).toMatchObject({ replayed: false, level: 5, glimmerCharged: 70 });
    expect(paid.progression.level).toBe(5);
    expect(await glimmer(accountId)).toBe(30);

    const replay = await on.confirmLevelUp({ playerId, targetLevel: 5, expectedGlimmerCost: 70 });
    expect(replay).toMatchObject({ replayed: true, level: 5, glimmerCharged: 0 });
    expect(await glimmer(accountId)).toBe(30);
    expect(await events(accountId, `character-level-up:${playerId}:5`)).toBe(1);

    // Level 6 is ready too, but 30 Glimmer is not enough.
    await expect(on.confirmLevelUp({ playerId, targetLevel: 6, expectedGlimmerCost: 70 }))
      .rejects.toMatchObject({ code: "LEVEL_UP_INSUFFICIENT_GLIMMER" });
    await expect(on.confirmLevelUp({ playerId, targetLevel: 7, expectedGlimmerCost: 70 }))
      .rejects.toMatchObject({ code: "LEVEL_UP_STALE" });

    // Flag flipped off again: the pending level applies automatically on the next read.
    expect((await off.getOrCreate(playerId)).level).toBe(6);
    await expect(pool.query("SELECT level FROM player_progression_profiles WHERE player_id = $1", [playerId]))
      .resolves.toMatchObject({ rows: [{ level: 6 }] });
    expect(await glimmer(accountId)).toBe(30);
  });

  it("charges a full skill reset 560 Glimmer, 336 with an Atlas Pass, once per request", async () => {
    const skills = new SkillService(pool, { fullBuildRespecAvailable: true, skillResetFee: { premiumWallet: wallet } });
    const free = new SkillService(pool, { fullBuildRespecAvailable: true });

    const plain = await createPlayer(600);
    expect(await skills.fullBuildRespecGlimmerCost(plain.playerId)).toBe(560);
    const revision = (await skills.getOrCreate(plain.playerId)).revision;
    await expect(skills.fullBuildRespec(plain.playerId, "respec-a", revision, {}, 336))
      .rejects.toMatchObject({ code: "SKILL_RESPEC_PRICE_CHANGED" });
    await expect(skills.fullBuildRespec(plain.playerId, "respec-a", revision))
      .rejects.toMatchObject({ code: "SKILL_RESPEC_PRICE_CHANGED" });
    const paid = await skills.fullBuildRespec(plain.playerId, "respec-a", revision, {}, 560);
    expect(paid).toMatchObject({ replayed: false, glimmerCharged: 560 });
    expect(await glimmer(plain.accountId)).toBe(40);
    const replay = await skills.fullBuildRespec(plain.playerId, "respec-a", revision, {}, 560);
    expect(replay.replayed).toBe(true);
    expect(await glimmer(plain.accountId)).toBe(40);
    const next = (await skills.getOrCreate(plain.playerId)).revision;
    await expect(skills.fullBuildRespec(plain.playerId, "respec-b", next, {}, 560))
      .rejects.toMatchObject({ code: "SKILL_RESPEC_INSUFFICIENT_GLIMMER" });
    expect(await glimmer(plain.accountId)).toBe(40);

    const member = await createPlayer(400, true);
    expect(await skills.fullBuildRespecGlimmerCost(member.playerId)).toBe(336);
    const memberRevision = (await skills.getOrCreate(member.playerId)).revision;
    await skills.fullBuildRespec(member.playerId, "respec-m", memberRevision, {}, 336);
    expect(await glimmer(member.accountId)).toBe(64);

    // Flag off: free, no price needed (today's behaviour).
    expect(await free.fullBuildRespecGlimmerCost(member.playerId)).toBeNull();
    const freeRevision = (await free.getOrCreate(member.playerId)).revision;
    const freeResult = await free.fullBuildRespec(member.playerId, "respec-free", freeRevision);
    expect(freeResult.glimmerCharged).toBeUndefined();
    expect(await glimmer(member.accountId)).toBe(64);
  });
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      parsed.port === "35432" ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("Glimmer cost tests require a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
