import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0917_premium_currency_exchange.sql";

// 0917 moves premium-wallet Lumen into inventory: one audited wallet debit and
// one inventory credit per account, nothing lost or duplicated.
describeDatabase("0917 Lumen wallet to inventory", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_premium_0917_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  // Inventory before 0917: "near" is just under carry capacity, "over" is
  // already past it (a legacy overweight player). Lumen weighs nothing, so
  // neither can make the move abort.
  const holders: Array<{
    accountId: string;
    playerId: string | null;
    lumen: bigint;
    stone: "none" | "near" | "over";
  }> = [
    { accountId: randomUUID(), playerId: `lumen-holder-a-${suffix}`, lumen: 250n, stone: "none" },
    { accountId: randomUUID(), playerId: `lumen-near-cap-${suffix}`, lumen: 40n, stone: "near" },
    { accountId: randomUUID(), playerId: `lumen-overweight-${suffix}`, lumen: 60n, stone: "over" },
    { accountId: randomUUID(), playerId: `lumen-whale-${suffix}`, lumen: 500_000n, stone: "none" },
    { accountId: randomUUID(), playerId: `lumen-spent-${suffix}`, lumen: 0n, stone: "none" },
    // An account without a player keeps its balance frozen in the closed wallet.
    { accountId: randomUUID(), playerId: null, lumen: 75n, stone: "none" }
  ];

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-premium-0917-"));
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql") && name < TARGET_MIGRATION)
      .sort()) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 4 });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("upgrades populated Lumen wallets into inventory and reruns empty", async () => {
    for (const holder of holders) {
      await pool.query("INSERT INTO accounts (id) VALUES ($1)", [holder.accountId]);
      if (holder.playerId) {
        await pool.query(
          `INSERT INTO players (
             id, account_id, username, display_color, region_code, lat, lon,
             anchor_lat, anchor_lon, move_leash_radius_m, online, geom
           ) VALUES ($1, $2, $1, '#38bdf8', 'NM', 35, -106, 35, -106, 900, false,
                     ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
          [holder.playerId, holder.accountId]
        );
      }
      if (holder.playerId && holder.stone !== "none") {
        await seedStone(pool, holder.playerId, holder.stone);
      }
      // Pre-0917 history: an admin grant, and for one holder a full spend.
      await pool.query("BEGIN");
      const granted = holder.lumen > 0n ? holder.lumen : 10n;
      await pool.query(
        "INSERT INTO premium_wallets (account_id, currency, balance, version) VALUES ($1, 'lumen', $2, $3)",
        [holder.accountId, holder.lumen.toString(), holder.lumen > 0n ? 1 : 2]
      );
      await pool.query(
        `INSERT INTO premium_wallet_events (
           account_id, currency, operation_key, delta, balance_after, version_after, reason, actor_player_id
         ) VALUES ($1, 'lumen', 'seed-grant', $2, $2, 1, 'admin', $3)`,
        [holder.accountId, granted.toString(), holder.playerId]
      );
      if (holder.lumen === 0n) {
        await pool.query(
          `INSERT INTO premium_wallet_events (
             account_id, currency, operation_key, delta, balance_after, version_after, reason, actor_player_id
           ) VALUES ($1, 'lumen', 'seed-spend', -10, 0, 2, 'spend', $2)`,
          [holder.accountId, holder.playerId]
        );
      }
      await pool.query(
        `INSERT INTO premium_wallets (account_id, currency, balance, version) VALUES ($1, 'glimmer', 7, 1)`,
        [holder.accountId]
      );
      await pool.query(
        `INSERT INTO premium_wallet_events (
           account_id, currency, operation_key, delta, balance_after, version_after, reason, actor_player_id
         ) VALUES ($1, 'glimmer', 'seed-glimmer', 7, 7, 1, 'admin', $2)`,
        [holder.accountId, holder.playerId]
      );
      await pool.query("COMMIT");
    }
    const weightsBefore = await carriedWeights(pool, holders);

    await expect(runMigrations(databaseUrl)).resolves.toContain(TARGET_MIGRATION);

    for (const holder of holders) {
      const wallets = await pool.query<{ currency: string; balance: string; version: string }>(
        "SELECT currency, balance::text, version::text FROM premium_wallets WHERE account_id = $1 ORDER BY currency",
        [holder.accountId]
      );
      if (!holder.playerId) {
        // Left in place, untouched and still auditable; nothing moved.
        expect(wallets.rows).toEqual([
          { currency: "glimmer", balance: "7", version: "1" },
          { currency: "lumen", balance: holder.lumen.toString(), version: "1" }
        ]);
        continue;
      }
      const inventory = await pool.query<{ quantity: string }>(
        "SELECT quantity::text FROM player_inventory WHERE player_id = $1 AND resource_type = 'lumen'",
        [holder.playerId]
      );
      expect(wallets.rows).toEqual([
        { currency: "glimmer", balance: "7", version: "1" },
        { currency: "lumen", balance: "0", version: "2" }
      ]);
      if (holder.lumen === 0n) {
        expect(inventory.rowCount).toBe(0);
        continue;
      }
      expect(inventory.rows).toEqual([{ quantity: holder.lumen.toString() }]);
      const operationKey = `premium-lumen-to-inventory:0917:${holder.accountId}`;
      await expect(pool.query(
        `SELECT delta::text, reason, ref_type FROM premium_wallet_events
         WHERE account_id = $1 AND operation_key = $2`,
        [holder.accountId, operationKey]
      )).resolves.toMatchObject({ rows: [{ delta: (-holder.lumen).toString(), reason: "inventory_migration", ref_type: "inventory_operation" }] });
      await expect(pool.query(
        `SELECT delta_quantity::text AS delta, source FROM inventory_events
         WHERE player_id = $1 AND operation_key = $2`,
        [holder.playerId, operationKey]
      )).resolves.toMatchObject({ rows: [{ delta: holder.lumen.toString(), source: "lumen_wallet_migration" }] });
    }
    // Lumen is weightless: no holder's carried weight changed.
    expect(await carriedWeights(pool, holders)).toEqual(weightsBefore);
    // Total Lumen is conserved: inventory plus the frozen no-player wallet.
    const total = await pool.query<{ total: string }>(
      "SELECT coalesce(sum(quantity), 0)::text AS total FROM player_inventory WHERE resource_type = 'lumen'"
    );
    expect(total.rows[0]!.total).toBe("500350");
    await expect(pool.query(
      "SELECT coalesce(sum(balance), 0)::text AS total FROM premium_wallets WHERE currency = 'lumen'"
    )).resolves.toMatchObject({ rows: [{ total: "75" }] });

    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);
    await expect(pool.query(
      "SELECT coalesce(sum(quantity), 0)::text AS total FROM player_inventory WHERE resource_type = 'lumen'"
    )).resolves.toMatchObject({ rows: [{ total: "500350" }] });
  }, 240_000);
});

async function seedStone(pool: pg.Pool, playerId: string, level: "near" | "over"): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const capacity = await client.query<{ grams: string }>(
      "SELECT lock_player_inventory_carry($1)::text AS grams",
      [playerId]
    );
    const grams = BigInt(capacity.rows[0]!.grams);
    // Stone is 250 g: "near" leaves less than one stone of room, "over" exceeds it.
    const quantity = level === "near" ? grams / 250n : grams / 250n + 20n;
    // A legacy overweight player predates the carry guard; seed it as such.
    if (level === "over") await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO inventory_operations (operation_key, player_id, source)
       VALUES ('seed-stone:' || $1, $1, 'test_seed')`,
      [playerId]
    );
    await client.query(
      `INSERT INTO player_inventory (player_id, resource_type, variant, quantity, version, updated_at)
       VALUES ($1, 'stone', 'default', $2, 1, now())`,
      [playerId, quantity.toString()]
    );
    await client.query(
      `INSERT INTO inventory_events (
         operation_key, player_id, item_id, variant, delta_quantity, quantity_after,
         version_after, source
       ) VALUES ('seed-stone:' || $1, $1, 'stone', 'default', $2, $2, 1, 'test_seed')`,
      [playerId, quantity.toString()]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function carriedWeights(
  pool: pg.Pool,
  holders: ReadonlyArray<{ playerId: string | null }>
): Promise<Record<string, string>> {
  const weights: Record<string, string> = {};
  for (const holder of holders) {
    if (!holder.playerId) continue;
    const result = await pool.query<{ grams: string }>(
      "SELECT player_inventory_weight_grams($1)::text AS grams",
      [holder.playerId]
    );
    weights[holder.playerId] = result.rows[0]!.grams;
  }
  return weights;
}

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
