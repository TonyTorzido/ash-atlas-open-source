import { randomUUID } from "node:crypto";

import {
  ATLAS_PASS_DAILY_LUMEN,
  ATLAS_PASS_FIRST_LUMEN,
  LUMEN_ITEM_ID,
  type AtlasPassEntitlement,
  type AtlasPassSku,
  type AtlasPassStatus,
  type PremiumProductSku,
  type PurchasePlatform
} from "@ash-atlas/shared";
import type pg from "pg";

import { DEFAULT_INVENTORY_VARIANT, InventoryService } from "../game/inventory.js";
import { PremiumWalletService } from "../game/premiumWallet.js";
import type { PremiumProduct } from "./purchaseCatalog.js";
import { purchaseLimitDenial } from "./purchaseLimits.js";

export const ATLAS_PASS_LUMEN_GRANT_SOURCE = "atlas_pass_lumen_grant";
/** Classified ADMIN by the Economy Observatory (its name contains "admin"). */
export const ATLAS_PASS_LUMEN_CLAWBACK_SOURCE = "atlas_pass_lumen_admin_clawback";

export type PurchaseEnvironment = "production" | "sandbox";

export type PassPeriodFacts = Readonly<{
  /** Apple originalTransactionId, Google purchase token, provider subscription id. */
  originalId: string;
  periodStart: Date;
  periodEnd: Date;
  status: AtlasPassStatus;
  graceUntil: Date | null;
  autoRenew: boolean | null;
}>;

export type StorePurchaseFacts = Readonly<{
  platform: PurchasePlatform;
  transactionId: string;
  originalTransactionId: string | null;
  purchaseToken: string | null;
  product: PremiumProduct;
  environment: PurchaseEnvironment;
  accountId: string;
  appAccountToken: string | null;
  purchasedAt: Date;
  storePriceMilli: bigint | null;
  priceCurrency: string | null;
  subscription?: PassPeriodFacts | undefined;
  /**
   * Google refunds purchases that are never acknowledged, so an over-cap
   * Google purchase is rejected. Apple and web money cannot be returned by
   * us, so those are granted and flagged instead.
   */
  rejectOverLimit: boolean;
  /** Web checkout that this payment settles. */
  checkoutId?: string | null | undefined;
}>;

export type GrantOutcome = Readonly<{
  status: "granted" | "already_granted" | "rejected";
  purchaseId: string | null;
  sku: PremiumProductSku;
  glimmerGranted: bigint;
  acknowledged: boolean;
  rejectionReason: string | null;
}>;

export type RefundOutcome = Readonly<{
  status: "clawed_back" | "in_arrears" | "already_refunded" | "not_granted" | "unknown";
  purchaseId: string | null;
  glimmerClawedBack: bigint;
  lumenOwed: bigint;
  lumenRecovered: bigint;
}>;

export class PurchaseLedgerError extends Error {
  constructor(readonly code: "PURCHASE_ACCOUNT_MISMATCH" | "PURCHASE_INVALID", message: string) {
    super(message);
    this.name = "PurchaseLedgerError";
  }
}

type PurchaseRow = {
  purchase_id: string;
  account_id: string | null;
  platform: PurchasePlatform;
  platform_transaction_id: string;
  sku: PremiumProductSku;
  kind: "glimmer_pack" | "atlas_pass";
  state: string;
  glimmer_amount: string;
  bonus_glimmer: string;
  store_acknowledged_at: Date | null;
  rejection_reason: string | null;
};

type Client = pg.PoolClient;

const GRANTED_STATES = new Set(["granted", "refunded_clawed_back", "refunded_in_arrears"]);

/**
 * The purchase ledger: every grant, refund and Atlas Pass accrual for one
 * account runs in one transaction under that account's advisory lock (taken
 * after the store-transaction lock), so replays and concurrent deliveries of
 * the same store transaction grant exactly once.
 */
export class PurchaseLedger {
  private readonly wallet: PremiumWalletService;
  private readonly inventory: InventoryService;

  constructor(
    private readonly pool: pg.Pool,
    options: { wallet?: PremiumWalletService; inventory?: InventoryService } = {}
  ) {
    this.wallet = options.wallet ?? new PremiumWalletService(pool);
    this.inventory = options.inventory ?? new InventoryService(pool);
  }

  async ensureAppAccountToken(accountId: string): Promise<string> {
    // The no-op update makes a concurrent first call return the committed row
    // instead of an empty snapshot.
    const result = await this.pool.query<{ app_account_token: string }>(
      `INSERT INTO premium_account_store_tokens (account_id) VALUES ($1)
       ON CONFLICT (account_id) DO UPDATE SET account_id = EXCLUDED.account_id
       RETURNING app_account_token::text`,
      [accountId]
    );
    const token = result.rows[0]?.app_account_token;
    if (!token) throw new PurchaseLedgerError("PURCHASE_INVALID", "Account store token is unavailable");
    return token;
  }

  async accountForAppAccountToken(token: string | null | undefined): Promise<string | null> {
    if (!token || !/^[0-9a-f-]{36}$/iu.test(token)) return null;
    const result = await this.pool.query<{ account_id: string }>(
      `SELECT t.account_id FROM premium_account_store_tokens t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.app_account_token = $1::uuid AND a.status <> 'deleted'`,
      [token.toLowerCase()]
    );
    return result.rows[0]?.account_id ?? null;
  }

  async firstPurchaseBonusAvailable(accountId: string): Promise<boolean> {
    return !(await hasGrantedPack(this.pool, accountId));
  }

  async limitDenial(accountId: string, addCents: number, now: Date) {
    return purchaseLimitDenial(this.pool, accountId, addCents, now);
  }

  /** Records a verified store purchase and grants it once. Idempotent per store transaction. */
  async grant(facts: StorePurchaseFacts, now: Date): Promise<GrantOutcome> {
    if (facts.product.kind === "atlas_pass" && !facts.subscription) {
      throw new PurchaseLedgerError("PURCHASE_INVALID", "Atlas Pass purchases need a subscription period");
    }
    return this.transaction(async (client) => {
      await lockKey(client, `premium-tx:${facts.platform}:${facts.transactionId}`);
      await lockKey(client, `premium-account:${facts.accountId}`);
      const existing = await findPurchase(client, facts.platform, facts.transactionId, null);
      if (existing) return replayOutcome(existing, facts.accountId);

      const denial = await purchaseLimitDenial(client, facts.accountId, facts.product.usdCents, now);
      if (denial && facts.rejectOverLimit) {
        const inserted = await insertPurchase(client, facts, "rejected", 0n, now, { rejectionReason: denial });
        return {
          status: "rejected", purchaseId: inserted, sku: facts.product.sku,
          glimmerGranted: 0n, acknowledged: false, rejectionReason: denial
        };
      }
      const riskFlags = denial ? [denial] : [];

      if (facts.product.kind === "atlas_pass") {
        const purchaseId = await insertPurchase(client, facts, "verified", 0n, now, { riskFlags });
        const subscriptionId = await upsertSubscription(client, facts, facts.subscription!);
        if (!subscriptionId) {
          await client.query(
            "UPDATE premium_purchases SET state = 'rejected', rejection_reason = 'account_mismatch' WHERE purchase_id = $1",
            [purchaseId]
          );
          return {
            status: "rejected", purchaseId, sku: facts.product.sku,
            glimmerGranted: 0n, acknowledged: false, rejectionReason: "account_mismatch"
          };
        }
        await client.query(
          `INSERT INTO premium_subscription_periods (subscription_id, purchase_id, starts_at, ends_at)
           VALUES ($1, $2, $3, $4)`,
          [subscriptionId, purchaseId, facts.subscription!.periodStart, facts.subscription!.periodEnd]
        );
        await client.query(
          "UPDATE premium_purchases SET state = 'granted', granted_at = $2 WHERE purchase_id = $1",
          [purchaseId, now]
        );
        await settleCheckout(client, facts.checkoutId, purchaseId);
        return {
          status: "granted", purchaseId, sku: facts.product.sku,
          glimmerGranted: 0n, acknowledged: false, rejectionReason: null
        };
      }

      const bonus = facts.product.firstPurchaseBonusGlimmer > 0n && !(await hasGrantedPack(client, facts.accountId))
        ? facts.product.firstPurchaseBonusGlimmer
        : 0n;
      const purchaseId = await insertPurchase(client, facts, "verified", bonus, now, { riskFlags });
      const total = facts.product.glimmerAmount + bonus;
      const credit = await this.wallet.creditForPurchaseInTransaction(client, {
        accountId: facts.accountId,
        currency: "glimmer",
        amount: total,
        operationKey: `purchase:${facts.platform}:${facts.transactionId}`,
        reason: "purchase",
        refType: "premium_purchase",
        refId: purchaseId,
        metadata: {
          sku: facts.product.sku,
          platform: facts.platform,
          environment: facts.environment,
          firstPurchaseBonus: bonus.toString(),
          ...(riskFlags.length > 0 ? { riskFlags } : {})
        }
      });
      await client.query(
        `UPDATE premium_purchases SET state = 'granted', granted_at = $2, granted_event_id = $3
         WHERE purchase_id = $1`,
        [purchaseId, now, credit.eventId]
      );
      await settleCheckout(client, facts.checkoutId, purchaseId);
      return {
        status: "granted", purchaseId, sku: facts.product.sku,
        glimmerGranted: total, acknowledged: false, rejectionReason: null
      };
    });
  }

  /** Adds a risk flag (e.g. an open dispute) to a recorded purchase; false when unknown. */
  async flagPurchase(platform: PurchasePlatform, transactionId: string, flag: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE premium_purchases
       SET risk_flags = CASE WHEN $3 = ANY(risk_flags) THEN risk_flags ELSE array_append(risk_flags, $3) END
       WHERE platform = $1 AND platform_transaction_id = $2`,
      [platform, transactionId, flag.slice(0, 80)]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markAcknowledged(purchaseId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE premium_purchases SET store_acknowledged_at = $2
       WHERE purchase_id = $1 AND store_acknowledged_at IS NULL`,
      [purchaseId, now]
    );
  }

  /** Granted Google purchases whose consume/acknowledge has not been confirmed yet. */
  async unacknowledgedGooglePurchases(since: Date): Promise<Array<{
    purchaseId: string; productKind: "glimmer_pack" | "atlas_pass"; googleProductId: string; purchaseToken: string;
  }>> {
    const result = await this.pool.query<{
      purchase_id: string; kind: "glimmer_pack" | "atlas_pass"; google_product_id: string; purchase_token: string;
    }>(
      `SELECT p.purchase_id, product.kind, product.google_product_id, p.purchase_token
       FROM premium_purchases p JOIN premium_products product USING (sku)
       WHERE p.platform = 'google' AND p.state = 'granted' AND p.store_acknowledged_at IS NULL
         AND p.purchase_token IS NOT NULL AND p.created_at >= $1
       ORDER BY p.created_at LIMIT 200`,
      [since]
    );
    return result.rows.map((row) => ({
      purchaseId: row.purchase_id,
      productKind: row.kind,
      googleProductId: row.google_product_id,
      purchaseToken: row.purchase_token
    }));
  }

  /**
   * Refund, revoke, void or chargeback: claws back the full granted Glimmer
   * (into arrears if already spent) or, for the pass, revokes the period and
   * claws back the Lumen it paid for. Idempotent per store transaction.
   */
  async refund(input: Readonly<{
    platform: PurchasePlatform;
    transactionId: string | null;
    purchaseToken?: string | null;
    reason: string;
    refundedAt: Date;
  }>): Promise<RefundOutcome> {
    return this.transaction(async (client) => {
      const located = await findPurchase(client, input.platform, input.transactionId, input.purchaseToken ?? null, false);
      const none = (status: RefundOutcome["status"], purchaseId: string | null): RefundOutcome => ({
        status, purchaseId, glimmerClawedBack: 0n, lumenOwed: 0n, lumenRecovered: 0n
      });
      if (!located) return none("unknown", null);
      await lockKey(client, `premium-tx:${input.platform}:${located.platform_transaction_id}`);
      const purchase = (await findPurchase(client, input.platform, located.platform_transaction_id, null))!;
      if (purchase.state === "refunded_clawed_back" || purchase.state === "refunded_in_arrears") {
        return none("already_refunded", purchase.purchase_id);
      }
      if (purchase.state !== "granted") return none("not_granted", purchase.purchase_id);
      const reason = input.reason.slice(0, 80) || "refund";
      if (!purchase.account_id) {
        // Anonymized after account deletion: record the refund, nothing left to claw back.
        await client.query(
          `UPDATE premium_purchases SET state = 'refunded_clawed_back', refunded_at = $2,
             refund_reason = $3, clawback_glimmer = 0
           WHERE purchase_id = $1`,
          [purchase.purchase_id, input.refundedAt, reason]
        );
        return none("clawed_back", purchase.purchase_id);
      }
      await lockKey(client, `premium-account:${purchase.account_id}`);

      if (purchase.kind === "atlas_pass") {
        const lumen = await this.revokePassPeriod(client, purchase, input.refundedAt);
        const inArrears = lumen.recovered < lumen.owed;
        await client.query(
          `UPDATE premium_purchases SET state = $2, refunded_at = $3, refund_reason = $4,
             clawback_glimmer = 0, lumen_clawback_owed = $5, lumen_clawback_recovered = $6
           WHERE purchase_id = $1`,
          [
            purchase.purchase_id, inArrears ? "refunded_in_arrears" : "refunded_clawed_back",
            input.refundedAt, reason, lumen.owed.toString(), lumen.recovered.toString()
          ]
        );
        return {
          status: inArrears ? "in_arrears" : "clawed_back",
          purchaseId: purchase.purchase_id,
          glimmerClawedBack: 0n,
          lumenOwed: lumen.owed,
          lumenRecovered: lumen.recovered
        };
      }

      const amount = BigInt(purchase.glimmer_amount) + BigInt(purchase.bonus_glimmer);
      const clawback = await this.wallet.clawbackForRefundInTransaction(client, {
        accountId: purchase.account_id,
        currency: "glimmer",
        amount,
        operationKey: `refund-clawback:${purchase.platform}:${purchase.platform_transaction_id}`,
        reason: "refund_clawback",
        refType: "premium_purchase",
        refId: purchase.purchase_id,
        metadata: { sku: purchase.sku, platform: purchase.platform, refundReason: reason }
      });
      const inArrears = clawback.balance < 0n;
      await client.query(
        `UPDATE premium_purchases SET state = $2, refunded_at = $3, refund_reason = $4,
           clawback_event_id = $5, clawback_glimmer = $6
         WHERE purchase_id = $1`,
        [
          purchase.purchase_id, inArrears ? "refunded_in_arrears" : "refunded_clawed_back",
          input.refundedAt, reason, clawback.eventId, amount.toString()
        ]
      );
      return {
        status: inArrears ? "in_arrears" : "clawed_back",
        purchaseId: purchase.purchase_id,
        glimmerClawedBack: amount,
        lumenOwed: 0n,
        lumenRecovered: 0n
      };
    });
  }

  /** Store-reported status change without a new paid period. Returns false for unknown subscriptions. */
  async updateSubscription(input: Readonly<{
    platform: PurchasePlatform;
    originalId: string;
    status?: AtlasPassStatus | null;
    currentPeriodEnd?: Date | null;
    graceUntil?: Date | null;
    autoRenew?: boolean | null;
  }>): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE premium_subscriptions
       SET status = coalesce($3, status),
           current_period_end = GREATEST(current_period_end, coalesce($4, current_period_end)),
           grace_until = CASE WHEN $3::text IS NULL THEN grace_until ELSE $5 END,
           auto_renew = coalesce($6, auto_renew)
       WHERE platform = $1 AND original_transaction_id = $2`,
      [
        input.platform, input.originalId, input.status ?? null,
        input.currentPeriodEnd ?? null, input.graceUntil ?? null, input.autoRenew ?? null
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async subscriptionAccount(platform: PurchasePlatform, originalId: string): Promise<string | null> {
    const result = await this.pool.query<{ account_id: string | null }>(
      "SELECT account_id FROM premium_subscriptions WHERE platform = $1 AND original_transaction_id = $2",
      [platform, originalId]
    );
    return result.rows[0]?.account_id ?? null;
  }

  async entitlement(accountId: string, now: Date): Promise<Omit<AtlasPassEntitlement, "lumenCredited">> {
    const result = await this.pool.query<{
      platform: PurchasePlatform; sku: AtlasPassSku; status: AtlasPassStatus;
      current_period_end: Date; grace_until: Date | null; auto_renew: boolean | null;
    }>(
      `SELECT platform, sku, status, current_period_end, grace_until, auto_renew
       FROM premium_subscriptions
       WHERE account_id = $1
       ORDER BY (status IN ('active', 'grace')) DESC,
                GREATEST(current_period_end, coalesce(grace_until, current_period_end)) DESC
       LIMIT 1`,
      [accountId]
    );
    const row = result.rows[0];
    if (!row) {
      return { active: false, status: "none", platform: null, sku: null, activeUntil: null, autoRenew: null };
    }
    const until = row.status === "grace" && row.grace_until && row.grace_until > row.current_period_end
      ? row.grace_until
      : row.current_period_end;
    const active = (row.status === "active" || row.status === "grace") && until.getTime() > now.getTime();
    return {
      active,
      status: active ? row.status : (row.status === "active" || row.status === "grace" ? "expired" : row.status),
      platform: row.platform,
      sku: row.sku,
      activeUntil: until.toISOString(),
      autoRenew: row.auto_renew
    };
  }

  /**
   * Credits Atlas Pass Lumen into the account's player inventory: the first
   * grant once per account ever, then 10 per UTC day touched by a paid,
   * unrevoked period up to today. Days are recorded before the inventory
   * credit, so a day can never be paid twice.
   */
  async accrueAtlasPass(accountId: string, now: Date): Promise<bigint> {
    return this.transaction(async (client) => {
      await lockKey(client, `premium-account:${accountId}`);
      const player = await client.query<{ id: string }>(
        "SELECT id FROM players WHERE account_id = $1", [accountId]
      );
      const playerId = player.rows[0]?.id;
      if (!playerId) return 0n;
      let credited = 0n;

      const first = await client.query<{ subscription_id: string; period_id: string }>(
        `SELECT s.subscription_id, p.period_id::text
         FROM premium_subscription_periods p JOIN premium_subscriptions s USING (subscription_id)
         WHERE s.account_id = $1 AND p.revoked_at IS NULL AND p.starts_at <= $2
           AND NOT EXISTS (SELECT 1 FROM premium_pass_first_grants g WHERE g.account_id = $1)
         ORDER BY p.starts_at LIMIT 1`,
        [accountId, now]
      );
      if (first.rows[0]) {
        const operationKey = `atlas-pass-first:${accountId}`;
        await client.query(
          `INSERT INTO premium_pass_first_grants (
             account_id, subscription_id, period_id, player_id, lumen, inventory_operation_key, granted_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [accountId, first.rows[0].subscription_id, first.rows[0].period_id, playerId, ATLAS_PASS_FIRST_LUMEN, operationKey, now]
        );
        await this.grantLumen(client, playerId, accountId, operationKey, BigInt(ATLAS_PASS_FIRST_LUMEN));
        credited += BigInt(ATLAS_PASS_FIRST_LUMEN);
      }

      const operationKey = `atlas-pass-daily:${accountId}:${randomUUID()}`;
      const days = await client.query<{ day: string }>(
        `WITH covered AS (
           SELECT DISTINCT ON (d.day) d.day, p.period_id
           FROM premium_subscription_periods p
           JOIN premium_subscriptions s USING (subscription_id)
           CROSS JOIN LATERAL (
             SELECT generate_series(
               (p.starts_at AT TIME ZONE 'UTC')::date,
               LEAST(
                 GREATEST((p.ends_at AT TIME ZONE 'UTC')::date - 1, (p.starts_at AT TIME ZONE 'UTC')::date),
                 ($2::timestamptz AT TIME ZONE 'UTC')::date
               ),
               interval '1 day'
             )::date AS day
           ) d
           WHERE s.account_id = $1 AND p.revoked_at IS NULL AND p.starts_at <= $2
           ORDER BY d.day, p.period_id
         )
         INSERT INTO premium_pass_accruals (
           account_id, day, period_id, player_id, lumen, inventory_operation_key, created_at
         )
         SELECT $1, covered.day, covered.period_id, $3, $4, $5, $2 FROM covered
         ON CONFLICT (account_id, day) DO NOTHING
         RETURNING day::text`,
        [accountId, now, playerId, ATLAS_PASS_DAILY_LUMEN, operationKey]
      );
      const daily = BigInt(days.rowCount ?? 0) * BigInt(ATLAS_PASS_DAILY_LUMEN);
      if (daily > 0n) {
        await this.grantLumen(client, playerId, accountId, operationKey, daily);
        credited += daily;
      }
      return credited;
    });
  }

  private async grantLumen(
    client: Client, playerId: string, accountId: string, operationKey: string, quantity: bigint
  ): Promise<void> {
    await this.inventory.grantItemsForOperationInTransaction(client, {
      operationKey,
      playerId,
      source: ATLAS_PASS_LUMEN_GRANT_SOURCE,
      sourceEntityType: "premium_account",
      sourceEntityId: accountId,
      metadata: { accountId },
      grants: [{ itemId: LUMEN_ITEM_ID, variant: null, quantity }]
    });
  }

  /** Revokes the refunded period and claws back Lumen no longer backed by a paid day. */
  private async revokePassPeriod(
    client: Client, purchase: PurchaseRow, revokedAt: Date
  ): Promise<{ owed: bigint; recovered: bigint }> {
    const accountId = purchase.account_id!;
    const period = await client.query<{ subscription_id: string; period_id: string }>(
      `UPDATE premium_subscription_periods SET revoked_at = coalesce(revoked_at, $2)
       WHERE purchase_id = $1 RETURNING subscription_id, period_id::text`,
      [purchase.purchase_id, revokedAt]
    );
    if (period.rows[0]) {
      // A refunded older period does not end a subscription that has a later paid one.
      await client.query(
        `UPDATE premium_subscriptions s SET status = 'revoked', grace_until = NULL
         WHERE s.subscription_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM premium_subscription_periods p
             WHERE p.subscription_id = s.subscription_id AND p.revoked_at IS NULL AND p.ends_at > $2
           )`,
        [period.rows[0].subscription_id, revokedAt]
      );
    }
    const days = await client.query<{ lumen: string }>(
      `UPDATE premium_pass_accruals a SET clawed_back_at = $2
       WHERE a.account_id = $1 AND a.clawed_back_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM premium_subscription_periods p
           JOIN premium_subscriptions s USING (subscription_id)
           WHERE s.account_id = $1 AND p.revoked_at IS NULL
             AND a.day BETWEEN (p.starts_at AT TIME ZONE 'UTC')::date
                 AND GREATEST((p.ends_at AT TIME ZONE 'UTC')::date - 1, (p.starts_at AT TIME ZONE 'UTC')::date)
         )
       RETURNING a.lumen::text`,
      [accountId, revokedAt]
    );
    // The one-time grant goes back only with the period that earned it, or when
    // no paid period is left at all.
    const first = await client.query<{ lumen: string }>(
      `UPDATE premium_pass_first_grants g SET clawed_back_at = $2
       WHERE g.account_id = $1 AND g.clawed_back_at IS NULL
         AND (
           g.period_id = $3::bigint
           OR NOT EXISTS (
             SELECT 1 FROM premium_subscription_periods p
             JOIN premium_subscriptions s USING (subscription_id)
             WHERE s.account_id = $1 AND p.revoked_at IS NULL
           )
         )
       RETURNING g.lumen::text`,
      [accountId, revokedAt, period.rows[0]?.period_id ?? null]
    );
    const owed = [...days.rows, ...first.rows].reduce((sum, row) => sum + BigInt(row.lumen), 0n);
    if (owed === 0n) return { owed, recovered: 0n };
    const player = await client.query<{ id: string }>("SELECT id FROM players WHERE account_id = $1", [accountId]);
    const playerId = player.rows[0]?.id;
    if (!playerId) return { owed, recovered: 0n };
    await this.inventory.lockPlayerInventoryForOperationInTransaction(client, playerId);
    const held = await client.query<{ quantity: string }>(
      `SELECT quantity::text FROM player_inventory
       WHERE player_id = $1 AND resource_type = $2 AND variant = $3`,
      [playerId, LUMEN_ITEM_ID, DEFAULT_INVENTORY_VARIANT]
    );
    const available = BigInt(held.rows[0]?.quantity ?? "0");
    const recovered = available < owed ? available : owed;
    if (recovered > 0n) {
      await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `atlas-pass-clawback:${purchase.purchase_id}`,
        playerId,
        source: ATLAS_PASS_LUMEN_CLAWBACK_SOURCE,
        sourceEntityType: "premium_purchase",
        sourceEntityId: purchase.purchase_id,
        metadata: { accountId, owed: owed.toString() },
        debits: [{ itemId: LUMEN_ITEM_ID, variant: null, quantity: recovered }]
      });
    }
    return { owed, recovered };
  }

  private async transaction<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function lockKey(client: Client, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

async function findPurchase(
  client: Client,
  platform: PurchasePlatform,
  transactionId: string | null,
  purchaseToken: string | null,
  lock = true
): Promise<PurchaseRow | null> {
  if (!transactionId && !purchaseToken) return null;
  const result = await client.query<PurchaseRow>(
    `SELECT p.purchase_id, p.account_id, p.platform, p.platform_transaction_id, p.sku, product.kind,
            p.state, p.glimmer_amount::text, p.bonus_glimmer::text, p.store_acknowledged_at,
            p.rejection_reason
     FROM premium_purchases p JOIN premium_products product USING (sku)
     WHERE p.platform = $1
       AND (p.platform_transaction_id = $2 OR ($2::text IS NULL AND p.purchase_token = $3))
     ORDER BY p.purchased_at DESC
     LIMIT 1
     ${lock ? "FOR UPDATE OF p" : ""}`,
    [platform, transactionId, purchaseToken]
  );
  return result.rows[0] ?? null;
}

function replayOutcome(existing: PurchaseRow, accountId: string): GrantOutcome {
  if (existing.account_id !== accountId) {
    throw new PurchaseLedgerError(
      "PURCHASE_ACCOUNT_MISMATCH",
      "This store transaction belongs to another account"
    );
  }
  if (GRANTED_STATES.has(existing.state)) {
    return {
      status: "already_granted",
      purchaseId: existing.purchase_id,
      sku: existing.sku,
      glimmerGranted: BigInt(existing.glimmer_amount) + BigInt(existing.bonus_glimmer),
      acknowledged: existing.store_acknowledged_at !== null,
      rejectionReason: null
    };
  }
  return {
    status: "rejected",
    purchaseId: existing.purchase_id,
    sku: existing.sku,
    glimmerGranted: 0n,
    acknowledged: existing.store_acknowledged_at !== null,
    rejectionReason: existing.rejection_reason ?? existing.state
  };
}

async function hasGrantedPack(queryable: Pick<pg.Pool, "query">, accountId: string): Promise<boolean> {
  const result = await queryable.query(
    `SELECT 1 FROM premium_purchases p JOIN premium_products product USING (sku)
     WHERE p.account_id = $1 AND product.kind = 'glimmer_pack'
       AND p.state IN ('granted', 'refunded_clawed_back', 'refunded_in_arrears')
     LIMIT 1`,
    [accountId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function insertPurchase(
  client: Client,
  facts: StorePurchaseFacts,
  state: "verified" | "rejected",
  bonus: bigint,
  now: Date,
  extra: { rejectionReason?: string; riskFlags?: string[] }
): Promise<string> {
  const result = await client.query<{ purchase_id: string }>(
    `INSERT INTO premium_purchases (
       account_id, platform, platform_transaction_id, original_transaction_id, purchase_token,
       sku, environment, state, glimmer_amount, bonus_glimmer, first_purchase_bonus, usd_cents,
       store_price_milli, price_currency, app_account_token, purchased_at, rejection_reason,
       risk_flags, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::uuid,$16,$17,$18::text[],$19)
     RETURNING purchase_id`,
    [
      facts.accountId, facts.platform, facts.transactionId, facts.originalTransactionId,
      facts.purchaseToken, facts.product.sku, facts.environment, state,
      facts.product.glimmerAmount.toString(), bonus.toString(), bonus > 0n, facts.product.usdCents,
      facts.storePriceMilli?.toString() ?? null, facts.priceCurrency, facts.appAccountToken,
      facts.purchasedAt, extra.rejectionReason ?? null, extra.riskFlags ?? [], now
    ]
  );
  return result.rows[0]!.purchase_id;
}

async function upsertSubscription(
  client: Client,
  facts: StorePurchaseFacts,
  period: PassPeriodFacts
): Promise<string | null> {
  const result = await client.query<{ subscription_id: string }>(
    `INSERT INTO premium_subscriptions (
       account_id, platform, original_transaction_id, sku, environment, status,
       current_period_end, grace_until, auto_renew, latest_transaction_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (platform, original_transaction_id) DO UPDATE SET
       sku = EXCLUDED.sku,
       status = EXCLUDED.status,
       current_period_end = GREATEST(premium_subscriptions.current_period_end, EXCLUDED.current_period_end),
       grace_until = EXCLUDED.grace_until,
       auto_renew = coalesce(EXCLUDED.auto_renew, premium_subscriptions.auto_renew),
       latest_transaction_id = EXCLUDED.latest_transaction_id
     WHERE premium_subscriptions.account_id = EXCLUDED.account_id
     RETURNING subscription_id`,
    [
      facts.accountId, facts.platform, period.originalId, facts.product.sku, facts.environment,
      period.status, period.periodEnd, period.graceUntil, period.autoRenew, facts.transactionId
    ]
  );
  return result.rows[0]?.subscription_id ?? null;
}

async function settleCheckout(client: Client, checkoutId: string | null | undefined, purchaseId: string): Promise<void> {
  if (!checkoutId) return;
  await client.query(
    `UPDATE premium_web_checkouts SET status = 'paid', purchase_id = $2
     WHERE checkout_id = $1 AND purchase_id IS NULL`,
    [checkoutId, purchaseId]
  );
}
