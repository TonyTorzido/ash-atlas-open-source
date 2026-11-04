import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { DevelopmentEconomyService } from "./developmentEconomy.js";
import { PremiumWalletOperationError, PremiumWalletService } from "./premiumWallet.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0885_premium_currencies.sql";

describeDatabase("premium currency wallets", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_premium_currencies_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  let accountId = "";
  const playerId = `premium-player-${suffix}`;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-premium-currencies-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 8 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("upgrades a populated database and reruns empty", async () => {
    accountId = randomUUID();
    await pool.query("INSERT INTO accounts (id) VALUES ($1)", [accountId]);
    await pool.query(
      `INSERT INTO players (
         id, account_id, username, display_color, region_code, lat, lon,
         anchor_lat, anchor_lon, move_leash_radius_m, online, geom
       ) VALUES (
         $1, $2, 'Premium Tester', '#38bdf8', 'NM', 35, -106, 35, -106, 900, false,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326)
       )`,
      [playerId, accountId]
    );
    await pool.query("BEGIN");
    await pool.query(
      "INSERT INTO player_wallets (player_id, account_id, gold_balance, version) VALUES ($1, $2, 250, 1)",
      [playerId, accountId]
    );
    await pool.query(
      `INSERT INTO wallet_events (
         operation_key, player_id, account_id, delta_gold, balance_after, version_after, reason
       ) VALUES ('legacy-gold', $1, $2, 250, 250, 1, 'reward')`,
      [playerId, accountId]
    );
    await pool.query("COMMIT");

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);
    await expect(pool.query(
      "SELECT gold_balance::text FROM player_wallets WHERE player_id = $1",
      [playerId]
    )).resolves.toMatchObject({ rows: [{ gold_balance: "250" }] });
    await expect(pool.query(
      "SELECT currency FROM premium_currencies ORDER BY currency"
    )).resolves.toMatchObject({ rows: [{ currency: "glimmer" }, { currency: "lumen" }] });
    await expect(pool.query("SELECT count(*)::int AS count FROM premium_wallets"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
  }, 180_000);

  it("credits once per operation key through the developer grant and records the observatory", async () => {
    const economy = new DevelopmentEconomyService(pool);
    const requestId = `premium-grant-${suffix}`;
    const first = await economy.grant(playerId, accountId, requestId, {
      premium: { glimmer: 1_000n },
      lumen: 50n
    });
    const replay = await economy.grant(playerId, accountId, requestId, {
      premium: { glimmer: 1_000n },
      lumen: 50n
    });
    expect(first.replayed).toBe(false);
    expect(first.premiumWallet?.balances).toEqual({
      glimmer: { balance: "1000", revision: "1" },
      lumen: { balance: "0", revision: "0" }
    });
    // Lumen is a carried item: the audited grant lands in inventory.
    expect(first.inventory.items.find((item) => item.resourceType === "lumen")?.quantity).toBe(50);
    expect(replay.replayed).toBe(true);
    expect(replay.premiumWallet).toEqual(first.premiumWallet);
    await expect(pool.query(
      `SELECT source, delta_quantity::int AS delta FROM inventory_events
       WHERE player_id = $1 AND item_id = 'lumen'`,
      [playerId]
    )).resolves.toMatchObject({ rows: [{ source: "lumen_admin_grant", delta: 50 }] });
    await expect(economy.grant(playerId, accountId, `${requestId}-material`, {
      materials: [{ itemId: "lumen", quantity: 5n }]
    })).rejects.toThrow(/audited premium grant/);
    await expect(pool.query(
      `SELECT currency, count(*)::int AS count FROM premium_wallet_events
       WHERE account_id = $1 GROUP BY currency ORDER BY currency`,
      [accountId]
    )).resolves.toMatchObject({ rows: [{ currency: "glimmer", count: 1 }] });
    await expect(pool.query(
      `SELECT asset_id, event_kind, leg, quantity::text, player_id
       FROM economy_events WHERE source_system = 'premium_wallet_events' ORDER BY asset_id`
    )).resolves.toMatchObject({ rows: [
      { asset_id: "currency:glimmer", event_kind: "ADMIN", leg: "credit", quantity: "1000", player_id: playerId }
    ] });
  });

  it("rejects non-admin credits and reused keys with different intent", async () => {
    const wallet = new PremiumWalletService(pool);
    const client = await pool.connect();
    try {
      await expect(wallet.creditForOperationInTransaction(client, {
        accountId, currency: "glimmer", amount: 5n, operationKey: "free-glimmer", reason: "spend"
      })).rejects.toMatchObject({ code: "PREMIUM_WALLET_INVALID_OPERATION" });
      await client.query("BEGIN");
      await expect(wallet.creditForOperationInTransaction(client, {
        accountId, currency: "glimmer", amount: 7n,
        operationKey: `dev-grant:premium-grant-${suffix}:glimmer`, reason: "admin",
        actorPlayerId: playerId, refType: "developer_request", refId: `premium-grant-${suffix}`
      })).rejects.toBeInstanceOf(PremiumWalletOperationError);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("serializes concurrent debits without overdrawing", async () => {
    const wallet = new PremiumWalletService(pool);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, async (_, index) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await wallet.debitForOperationInTransaction(client, {
          accountId, currency: "glimmer", amount: 300n,
          operationKey: `concurrent-spend-${index}`, reason: "spend", actorPlayerId: playerId
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }));
    const succeeded = attempts.filter((attempt) => attempt.status === "fulfilled");
    const failed = attempts.filter((attempt) => attempt.status === "rejected");
    expect(succeeded).toHaveLength(3);
    for (const failure of failed) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({
        code: "PREMIUM_WALLET_INSUFFICIENT_FUNDS"
      });
    }
    const snapshot = await wallet.snapshot(accountId);
    expect(snapshot.balances.glimmer).toEqual({ balance: "100", revision: "4" });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM economy_events WHERE asset_id = 'currency:glimmer' AND event_kind = 'SINK'"
    )).resolves.toMatchObject({ rows: [{ count: 3 }] });
  });
});

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      parsed.port === "35432" ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("Premium currency tests require a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
