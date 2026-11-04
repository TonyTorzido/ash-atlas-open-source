import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountDeletionService } from "../auth/accountDeletionService.js";
import { DisposableTestPool } from "../db/disposableTestPool.js";
import { runMigrations } from "../db/migrate.js";
import { DevelopmentEconomyService } from "../game/developmentEconomy.js";
import { PremiumWalletOperationError, PremiumWalletService } from "../game/premiumWallet.js";
import type { GooglePlayApi, GoogleSubscriptionV2 } from "./googlePlay.js";
import { PremiumCatalog, loadPremiumProducts, type PremiumProduct } from "./purchaseCatalog.js";
import { PurchaseLedger, type StorePurchaseFacts } from "./purchaseLedger.js";
import { PurchaseService } from "./purchaseService.js";
import { XsollaProvider } from "./webPaymentProvider.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const FIRST_MIGRATION = "0990_premium_purchases.sql";
const DAY = 86_400_000;

describeDatabase("real-money purchase ledger", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `ash_atlas_stability_purchases_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const migrations = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  let precedingMigrations = "";
  let databaseUrl = "";
  let pool: pg.Pool;
  let ledger: PurchaseLedger;
  let wallet: PremiumWalletService;
  let products: Map<string, PremiumProduct>;

  beforeAll(async () => {
    const parsed = requireDisposableAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    precedingMigrations = await mkdtemp(path.join(tmpdir(), "ash-atlas-purchases-"));
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < FIRST_MIGRATION)) {
      await copyFile(path.join(migrations, name), path.join(precedingMigrations, name));
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ash_atlas_telemetry_exporter') THEN
        CREATE ROLE ash_atlas_telemetry_exporter NOLOGIN;
      END IF; END $$`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl, { migrationsDirectory: precedingMigrations });
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 12 });
    wallet = new PremiumWalletService(pool);
    ledger = new PurchaseLedger(pool, { wallet });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
    if (precedingMigrations) await rm(precedingMigrations, { recursive: true, force: true });
  });

  it("upgrades a populated database, keeps balances and reruns empty", async () => {
    const { accountId, playerId } = await createAccount(pool, 60);
    await new DevelopmentEconomyService(pool).grant(playerId, accountId, "seed", { premium: { glimmer: 100n }, lumen: 25n });

    await expect(runMigrations(databaseUrl)).resolves.toEqual([
      "0990_premium_purchases.sql", "0991_atlas_pass.sql", "0992_store_notification_inbox.sql",
      "0993_purchase_review_and_first_grant_period.sql"
    ]);
    await expect(runMigrations(databaseUrl)).resolves.toEqual([]);

    await expect(wallet.snapshot(accountId)).resolves.toMatchObject({ balances: { glimmer: { balance: "100", revision: "1" } } });
    await expect(lumen(pool, playerId)).resolves.toBe(25n);
    products = new Map((await loadPremiumProducts(pool)).map((product) => [product.sku, product]));
    expect([...products.keys()]).toEqual([
      "glimmer_pinch", "glimmer_handful", "glimmer_pouch", "glimmer_satchel", "glimmer_chest",
      "glimmer_hoard", "atlas_pass_monthly", "atlas_pass_yearly"
    ]);
    expect(products.get("glimmer_pouch")).toMatchObject({
      glimmerAmount: 1150n, firstPurchaseBonusGlimmer: 1150n, usdCents: 999,
      appleProductId: "com.ashatlas.game.glimmer.pouch", googleProductId: "com.ashatlas.game.glimmer.pouch"
    });
  }, 300_000);

  it("grants one store transaction exactly once under concurrent replays", async () => {
    const { accountId } = await createAccount(pool, 60);
    const facts = packFacts(accountId, "glimmer_pinch", "apple-tx-concurrent");
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => ledger.grant(facts, new Date())));
    expect(outcomes.filter((outcome) => outcome.status === "granted")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "already_granted")).toHaveLength(5);
    // First pack up to Pouch doubles once per account.
    expect(new Set(outcomes.map((outcome) => outcome.glimmerGranted))).toEqual(new Set([400n]));
    await expect(wallet.snapshot(accountId)).resolves.toMatchObject({ balances: { glimmer: { balance: "400", revision: "1" } } });
    const second = await ledger.grant(packFacts(accountId, "glimmer_pinch", "apple-tx-second"), new Date());
    expect(second).toMatchObject({ status: "granted", glimmerGranted: 200n });

    const other = await createAccount(pool, 60);
    await expect(ledger.grant({ ...facts, accountId: other.accountId }, new Date()))
      .rejects.toMatchObject({ code: "PURCHASE_ACCOUNT_MISMATCH" });
  });

  it("refuses a purchase credit that no granted purchase backs", async () => {
    const { accountId } = await createAccount(pool, 60);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await wallet.creditForPurchaseInTransaction(client, {
        accountId, currency: "glimmer", amount: 500n, operationKey: "purchase:forged",
        reason: "purchase", refType: "premium_purchase", refId: randomUUID()
      });
      await expect(client.query("COMMIT")).rejects.toThrow(/no purchase of this account/u);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await expect(wallet.snapshot(accountId)).resolves.toMatchObject({ balances: { glimmer: { balance: "0" } } });
  });

  it("claws a refund back into arrears once, blocks spending, and nets later purchases", async () => {
    const { accountId } = await createAccount(pool, 60);
    await ledger.grant(packFacts(accountId, "glimmer_pouch", "google-order-refund", "google"), new Date());
    await spend(pool, wallet, accountId, 2000n, "spend-before-refund");

    const refund = await ledger.refund({
      platform: "google", transactionId: "google-order-refund", reason: "voided", refundedAt: new Date()
    });
    expect(refund).toMatchObject({ status: "in_arrears", glimmerClawedBack: 2300n });
    await expect(wallet.snapshot(accountId)).resolves.toMatchObject({ balances: { glimmer: { balance: "-2000" } } });
    await expect(ledger.refund({
      platform: "google", transactionId: "google-order-refund", reason: "voided", refundedAt: new Date()
    })).resolves.toMatchObject({ status: "already_refunded", glimmerClawedBack: 0n });
    await expect(spend(pool, wallet, accountId, 1n, "spend-in-arrears"))
      .rejects.toBeInstanceOf(PremiumWalletOperationError);

    // The bonus was used by the refunded first pack; the next pack pays down the debt.
    await expect(ledger.grant(packFacts(accountId, "glimmer_satchel", "google-order-after", "google"), new Date()))
      .resolves.toMatchObject({ status: "granted", glimmerGranted: 2400n });
    await expect(wallet.snapshot(accountId)).resolves.toMatchObject({ balances: { glimmer: { balance: "400" } } });
    await expect(pool.query(
      "SELECT state, clawback_glimmer::text FROM premium_purchases WHERE platform_transaction_id = 'google-order-refund'"
    )).resolves.toMatchObject({ rows: [{ state: "refunded_in_arrears", clawback_glimmer: "2300" }] });
  });

  it("applies fraud caps: Google over-cap is rejected, Apple over-cap is granted and flagged", async () => {
    const { accountId } = await createAccount(pool, 0);
    await expect(ledger.limitDenial(accountId, 9999, new Date())).resolves.toBe("new_account_limit");
    await expect(ledger.grant(packFacts(accountId, "glimmer_hoard", "google-cap", "google"), new Date()))
      .resolves.toMatchObject({ status: "rejected", rejectionReason: "new_account_limit", glimmerGranted: 0n });
    await expect(ledger.grant(packFacts(accountId, "glimmer_hoard", "apple-cap"), new Date()))
      .resolves.toMatchObject({ status: "granted" });
    await expect(pool.query("SELECT risk_flags FROM premium_purchases WHERE platform_transaction_id = 'apple-cap'"))
      .resolves.toMatchObject({ rows: [{ risk_flags: ["new_account_limit"] }] });
  });

  it("accrues Atlas Pass Lumen once per paid UTC day and claws it back on refund", async () => {
    const { accountId, playerId } = await createAccount(pool, 60);
    const now = new Date();
    const start = new Date(now.getTime() - 2 * DAY);
    const facts: StorePurchaseFacts = {
      ...packFacts(accountId, "atlas_pass_monthly", "apple-pass-1"),
      originalTransactionId: "apple-pass-original",
      subscription: {
        originalId: "apple-pass-original", periodStart: start, periodEnd: new Date(start.getTime() + 30 * DAY),
        status: "active", graceUntil: null, autoRenew: true
      }
    };
    await expect(ledger.grant(facts, now)).resolves.toMatchObject({ status: "granted", glimmerGranted: 0n });
    await expect(ledger.grant(facts, now)).resolves.toMatchObject({ status: "already_granted" });
    await expect(ledger.entitlement(accountId, now)).resolves.toMatchObject({ active: true, status: "active", sku: "atlas_pass_monthly" });

    const [first, again] = await Promise.all([ledger.accrueAtlasPass(accountId, now), ledger.accrueAtlasPass(accountId, now)]);
    expect(first + again).toBe(156n);
    await expect(lumen(pool, playerId)).resolves.toBe(156n);
    await expect(ledger.accrueAtlasPass(accountId, now)).resolves.toBe(0n);
    await expect(ledger.accrueAtlasPass(accountId, new Date(now.getTime() + DAY))).resolves.toBe(12n);

    await expect(ledger.refund({
      platform: "apple", transactionId: "apple-pass-1", reason: "refund", refundedAt: now
    })).resolves.toMatchObject({ status: "clawed_back", lumenOwed: 168n, lumenRecovered: 168n });
    await expect(lumen(pool, playerId)).resolves.toBe(0n);
    await expect(ledger.accrueAtlasPass(accountId, new Date(now.getTime() + 2 * DAY))).resolves.toBe(0n);
    await expect(ledger.entitlement(accountId, now)).resolves.toMatchObject({ active: false, status: "revoked" });
  });

  it("anonymizes purchase rows on account deletion and keeps them", async () => {
    const { accountId } = await createAccount(pool, 60);
    const token = await ledger.ensureAppAccountToken(accountId);
    await ledger.grant({ ...packFacts(accountId, "glimmer_pinch", "apple-deleted"), appAccountToken: token }, new Date());
    const requestId = randomUUID();
    await pool.query(
      `INSERT INTO account_deletion_requests (
         id, account_id, request_key, email_normalized, request_source, status, requested_at, verified_at, updated_at
       ) VALUES ($1, $2, $3, 'deleted-buyer@example.com', 'authenticated', 'pending_processing', now(), now(), now())`,
      [requestId, accountId, `request-${requestId}`]
    );
    await expect(new AccountDeletionService(pool).processRequest({ requestId, accountId }))
      .resolves.toMatchObject({ status: "completed" });
    await expect(pool.query(
      `SELECT account_id, app_account_token, store_price_milli, anonymized_at IS NOT NULL AS anonymized, state
       FROM premium_purchases WHERE platform_transaction_id = 'apple-deleted'`
    )).resolves.toMatchObject({
      rows: [{ account_id: null, app_account_token: null, store_price_milli: null, anonymized: true, state: "granted" }]
    });
    await expect(ledger.accountForAppAccountToken(token)).resolves.toBeNull();
    await expect(ledger.refund({
      platform: "apple", transactionId: "apple-deleted", reason: "refund", refundedAt: new Date()
    })).resolves.toMatchObject({ status: "clawed_back", glimmerClawedBack: 0n });
  });

  it("returns one store token to concurrent first calls", async () => {
    const { accountId } = await createAccount(pool, 60);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => ledger.ensureAppAccountToken(accountId)));
    expect(tokens.every((token) => /^[0-9a-f-]{36}$/u.test(token))).toBe(true);
    expect(new Set(tokens).size).toBe(1);
  });

  it("pays each paid day once, end exclusive, and keeps the first grant when a later period is refunded", async () => {
    const { accountId, playerId } = await createAccount(pool, 60);
    const start = new Date(Date.UTC(2026, 0, 1, 10));
    const renewal = new Date(Date.UTC(2026, 0, 31, 10));
    const pass = (transactionId: string, from: Date, to: Date): StorePurchaseFacts => ({
      ...packFacts(accountId, "atlas_pass_monthly", transactionId),
      originalTransactionId: "apple-pass-days",
      purchasedAt: from,
      subscription: {
        originalId: "apple-pass-days", periodStart: from, periodEnd: to, status: "active", graceUntil: null, autoRenew: true
      }
    });
    await ledger.grant(pass("apple-pass-days-1", start, renewal), start);
    // 2026-01-01 .. 2026-01-30: 30 days; the renewal day belongs to the next period.
    await expect(ledger.accrueAtlasPass(accountId, new Date(Date.UTC(2026, 1, 15)))).resolves.toBe(120n + 360n);
    await ledger.grant(pass("apple-pass-days-2", renewal, new Date(Date.UTC(2026, 2, 3, 10))), renewal);
    await expect(ledger.accrueAtlasPass(accountId, new Date(Date.UTC(2026, 1, 1, 12)))).resolves.toBe(24n);
    await expect(ledger.refund({
      platform: "apple", transactionId: "apple-pass-days-2", reason: "refund", refundedAt: new Date(Date.UTC(2026, 1, 2))
    })).resolves.toMatchObject({ status: "clawed_back", lumenOwed: 24n, lumenRecovered: 24n });
    await expect(lumen(pool, playerId)).resolves.toBe(480n);
    await expect(ledger.refund({
      platform: "apple", transactionId: "apple-pass-days-1", reason: "refund", refundedAt: new Date(Date.UTC(2026, 1, 3))
    })).resolves.toMatchObject({ lumenOwed: 480n, lumenRecovered: 480n });
  });

  describe("web webhooks and Google renewals through the service", () => {
    const secret = "webhook-secret";
    let subscription: GoogleSubscriptionV2;
    const google = {
      getSubscription: async () => subscription,
      acknowledgeSubscription: async () => undefined
    } as unknown as GooglePlayApi;
    const service = () => new PurchaseService({
      pool,
      config: {
        PURCHASES_APPLE_ENABLED: false, PURCHASES_GOOGLE_ENABLED: true, PURCHASES_WEB_ENABLED: true,
        ATLAS_PASS_ENABLED: true, SHOP_LINKS_MODE: "off", SHOP_WEB_URL: undefined, PURCHASES_ACCEPT_SANDBOX: false,
        PURCHASES_APPLE_BUNDLE_ID: "com.ashatlas.game", PURCHASES_GOOGLE_PACKAGE_NAME: "com.ashatlas.game",
        PURCHASES_XSOLLA_SANDBOX: false
      },
      ledger,
      catalog: new PremiumCatalog(pool),
      wallet,
      apple: null,
      google,
      googlePush: null,
      web: new XsollaProvider({
        merchantId: "1", projectId: "2", apiKey: "k", webhookSecret: secret, returnUrl: undefined, timeoutMs: 1000
      }),
      logger: { info() {}, warn() {}, error() {} }
    });
    const deliver = (body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body));
      const signature = createHash("sha1").update(Buffer.concat([raw, Buffer.from(secret)])).digest("hex");
      return service().handleWebWebhook(raw, { authorization: `Signature ${signature}` });
    };

    it("keeps unmatched payments retryable for review and grants matched ones once", async () => {
      const { accountId } = await createAccount(pool, 60);
      const token = await ledger.ensureAppAccountToken(accountId);
      const unmatched = {
        notification_type: "payment", user: { id: token },
        purchase: { checkout: { amount: 9.99, currency: "USD" } },
        transaction: { id: 5550001, external_id: randomUUID(), dry_run: 0, payment_date: new Date().toISOString() }
      };
      await expect(deliver(unmatched)).resolves.toMatchObject({ status: 500 });
      await expect(deliver(unmatched)).resolves.toMatchObject({ status: 500 });
      await expect(pool.query(
        "SELECT status, error, attempts FROM store_notification_inbox WHERE notification_id = $1", ["payment:5550001"]
      )).resolves.toMatchObject({ rows: [{ status: "needs_review", error: "unknown_checkout", attempts: 2 }] });

      const checkout = await pool.query<{ checkout_id: string }>(
        `INSERT INTO premium_web_checkouts (account_id, provider, sku, sandbox)
         VALUES ($1, 'xsolla', 'glimmer_pouch', false) RETURNING checkout_id`,
        [accountId]
      );
      // The buyer paid in EUR incl. VAT; purchase.checkout still echoes our USD request.
      const paid = {
        notification_type: "payment", user: { id: token },
        purchase: { checkout: { amount: 9.99, currency: "USD" }, total: { amount: 11.42, currency: "EUR" } },
        transaction: {
          id: 5550002, external_id: checkout.rows[0]!.checkout_id, dry_run: 0, payment_date: new Date().toISOString()
        }
      };
      await expect(deliver(paid)).resolves.toMatchObject({ status: 204 });
      await expect(deliver(paid)).resolves.toMatchObject({ status: 204 });
      await expect(wallet.snapshot(accountId)).resolves.toMatchObject({ balances: { glimmer: { balance: "2300", revision: "1" } } });

      await expect(deliver({ notification_type: "dispute", action: "adding", transaction: { id: 5550002 } }))
        .resolves.toMatchObject({ status: 204 });
      await expect(wallet.snapshot(accountId)).resolves.toMatchObject({ balances: { glimmer: { balance: "2300" } } });
      await expect(pool.query("SELECT state, risk_flags FROM premium_purchases WHERE platform_transaction_id = $1", ["5550002"]))
        .resolves.toMatchObject({ rows: [{ state: "granted", risk_flags: ["dispute_open"] }] });

      await expect(deliver({ notification_type: "refund", transaction: { id: 5550002 } })).resolves.toMatchObject({ status: 204 });
      await expect(wallet.snapshot(accountId)).resolves.toMatchObject({ balances: { glimmer: { balance: "0" } } });
    });

    it("rejects an over-cap initial Google subscription but grants and flags an over-cap renewal", async () => {
      const { accountId } = await createAccount(pool, 0);
      const token = await ledger.ensureAppAccountToken(accountId);
      const expiry = new Date(Date.now() + 360 * DAY).toISOString();
      const state = (orderId: string, acknowledged: boolean): GoogleSubscriptionV2 => ({
        subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        startTime: new Date().toISOString(),
        acknowledgementState: acknowledged ? "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" : "ACKNOWLEDGEMENT_STATE_PENDING",
        externalAccountIdentifiers: { obfuscatedExternalAccountId: token },
        lineItems: [{ productId: "com.ashatlas.game.pass.yearly", expiryTime: expiry, latestSuccessfulOrderId: orderId }]
      });
      subscription = state("GPA.cap-initial", false);
      await expect(service().verifyGoogle(accountId, {
        productId: "com.ashatlas.game.pass.yearly", purchaseToken: "google-cap-token-initial"
      })).resolves.toMatchObject({ status: "rejected" });
      subscription = state("GPA.cap-renewal..1", true);
      await expect(service().verifyGoogle(accountId, {
        productId: "com.ashatlas.game.pass.yearly", purchaseToken: "google-cap-token-renewal"
      })).resolves.toMatchObject({ status: "granted" });
      await expect(pool.query(
        "SELECT state, risk_flags FROM premium_purchases WHERE platform_transaction_id = $1", ["GPA.cap-renewal..1"]
      )).resolves.toMatchObject({ rows: [{ state: "granted", risk_flags: ["new_account_limit"] }] });
    });
  });

  function packFacts(
    accountId: string, sku: string, transactionId: string, platform: "apple" | "google" | "web" = "apple"
  ): StorePurchaseFacts {
    return {
      platform,
      transactionId,
      originalTransactionId: transactionId,
      purchaseToken: platform === "google" ? `token-${transactionId}` : null,
      product: products.get(sku)!,
      environment: "production",
      accountId,
      appAccountToken: null,
      purchasedAt: new Date(),
      storePriceMilli: 9990n,
      priceCurrency: "USD",
      rejectOverLimit: platform === "google"
    };
  }
});

async function createAccount(pool: pg.Pool, ageDays: number): Promise<{ accountId: string; playerId: string }> {
  const accountId = randomUUID();
  const playerId = `purchase-player-${accountId.slice(0, 8)}`;
  await pool.query("INSERT INTO accounts (id, created_at) VALUES ($1, now() - ($2::integer * interval '1 day'))", [accountId, ageDays]);
  await pool.query(
    `INSERT INTO players (
       id, account_id, username, display_color, region_code, lat, lon,
       anchor_lat, anchor_lon, move_leash_radius_m, online, geom
     ) VALUES ($1, $2, $3, '#38bdf8', 'NM', 35, -106, 35, -106, 900, false,
       ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
    [playerId, accountId, `Buyer ${accountId.slice(0, 6)}`]
  );
  return { accountId, playerId };
}

async function lumen(pool: pg.Pool, playerId: string): Promise<bigint> {
  const result = await pool.query<{ quantity: string }>(
    "SELECT coalesce(sum(quantity), 0)::text AS quantity FROM player_inventory WHERE player_id = $1 AND resource_type = 'lumen'",
    [playerId]
  );
  return BigInt(result.rows[0]!.quantity);
}

async function spend(pool: pg.Pool, wallet: PremiumWalletService, accountId: string, amount: bigint, key: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await wallet.debitForOperationInTransaction(client, {
      accountId, currency: "glimmer", amount, operationKey: key, reason: "spend"
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function requireDisposableAdminUrl(value: string): URL {
  const parsed = new URL(value);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      parsed.port === "35432" ||
      !database.startsWith("ash_atlas_stability")) {
    throw new Error("Purchase ledger tests require a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("Unsafe disposable stability database name");
  }
  return `"${value}"`;
}
