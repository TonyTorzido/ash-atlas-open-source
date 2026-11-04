import alpha from "i18n-iso-countries";
import type pg from "pg";

import {
  SHOP_LINK_ALLOWED_STOREFRONTS,
  type AtlasPassEntitlement,
  type PremiumProductSku,
  type PurchaseCapabilitiesQuery,
  type PurchaseCapabilitiesResponse,
  type PurchaseClientPlatform,
  type PurchaseDenialReason,
  type PurchasePlatform,
  type PurchasePreflightRequest,
  type PurchasePreflightResponse,
  type PurchaseVerifyResponse,
  type ShopLinkCapability,
  type WebCheckoutResponse
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import type { PremiumWalletService } from "../game/premiumWallet.js";
import type { AppLogger } from "../logger.js";
import { AppleVerificationError, checkAppleTransaction, type AppleVerifier } from "./appleStore.js";
import {
  GOOGLE_SUBSCRIPTION_REVOKED,
  GooglePlayApiError,
  checkGoogleProductPurchase,
  checkGoogleSubscription,
  parseRtdnPush,
  type GooglePlayApi,
  type PushTokenVerifier
} from "./googlePlay.js";
import { addPassPeriod, productView, type PremiumCatalog, type PremiumProduct } from "./purchaseCatalog.js";
import {
  PurchaseLedgerError,
  type GrantOutcome,
  type PassPeriodFacts,
  type PurchaseEnvironment,
  type PurchaseLedger,
  type StorePurchaseFacts
} from "./purchaseLedger.js";
import { WebProviderError, type WebhookReply, type WebPaymentEvent, type WebPaymentProvider } from "./webPaymentProvider.js";

export type PurchaseConfig = Pick<AppConfig,
  | "PURCHASES_APPLE_ENABLED"
  | "PURCHASES_GOOGLE_ENABLED"
  | "PURCHASES_WEB_ENABLED"
  | "ATLAS_PASS_ENABLED"
  | "SHOP_LINKS_MODE"
  | "SHOP_WEB_URL"
  | "PURCHASES_ACCEPT_SANDBOX"
  | "PURCHASES_APPLE_BUNDLE_ID"
  | "PURCHASES_GOOGLE_PACKAGE_NAME"
  | "PURCHASES_XSOLLA_SANDBOX"
>;

export class PurchaseRequestError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "PurchaseRequestError";
  }
}

const notFound = () => new PurchaseRequestError(404, "NOT_FOUND", "Not found");
const unavailable = () => new PurchaseRequestError(503, "PURCHASE_UNAVAILABLE", "Purchases are temporarily unavailable");
const VOIDED_LOOKBACK_MS = 30 * 86_400_000;
const ACK_RETRY_WINDOW_MS = 3 * 86_400_000;

export type PurchaseServiceDependencies = Readonly<{
  pool: pg.Pool;
  config: PurchaseConfig;
  ledger: PurchaseLedger;
  catalog: PremiumCatalog;
  wallet: Pick<PremiumWalletService, "snapshot">;
  apple: AppleVerifier | null;
  google: GooglePlayApi | null;
  googlePush: PushTokenVerifier | null;
  web: WebPaymentProvider | null;
  logger: Pick<AppLogger, "info" | "warn" | "error">;
  now?: () => Date;
}>;

/** Orchestrates store verification, webhooks and the session capability over the ledger. */
export class PurchaseService {
  private readonly now: () => Date;

  constructor(private readonly deps: PurchaseServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  enabled(platform: PurchasePlatform): boolean {
    const { config } = this.deps;
    if (platform === "apple") return config.PURCHASES_APPLE_ENABLED && this.deps.apple !== null;
    if (platform === "google") return config.PURCHASES_GOOGLE_ENABLED && this.deps.google !== null;
    return config.PURCHASES_WEB_ENABLED && this.deps.web !== null;
  }

  get atlasPassEnabled(): boolean {
    return this.deps.config.ATLAS_PASS_ENABLED;
  }

  async capabilities(accountId: string, query: PurchaseCapabilitiesQuery): Promise<PurchaseCapabilitiesResponse> {
    const purchases = { apple: this.enabled("apple"), google: this.enabled("google"), web: this.enabled("web") };
    const path = purchasePathFor(query.platform, purchases);
    const open = path !== null;
    const products = open
      ? (await this.deps.catalog.all())
          .filter((product) => product.active && (product.kind === "glimmer_pack" || this.atlasPassEnabled))
          .map(productView)
      : [];
    return {
      purchases,
      path,
      atlasPass: this.atlasPassEnabled && open,
      shopLinks: shopLinkCapability(this.deps.config, query.platform, query.storefront, purchases.web),
      appAccountToken: open ? await this.deps.ledger.ensureAppAccountToken(accountId) : null,
      firstPurchaseBonusAvailable: open ? await this.deps.ledger.firstPurchaseBonusAvailable(accountId) : false,
      products
    };
  }

  async preflight(accountId: string, request: PurchasePreflightRequest): Promise<PurchasePreflightResponse> {
    if (!this.enabled(request.platform)) return { allowed: false, reason: "platform_disabled" };
    const denial = await this.denialFor(accountId, request.sku);
    if (denial) return { allowed: false, reason: denial };
    return { allowed: true, appAccountToken: await this.deps.ledger.ensureAppAccountToken(accountId) };
  }

  async verifyApple(accountId: string, signedTransaction: string): Promise<PurchaseVerifyResponse> {
    const apple = this.deps.apple;
    if (!this.enabled("apple") || !apple) throw notFound();
    let verified;
    try {
      verified = await apple.verifyTransaction(signedTransaction);
    } catch (error) {
      if (error instanceof AppleVerificationError && error.code === "retryable") throw unavailable();
      throw new PurchaseRequestError(400, "PURCHASE_INVALID", "The purchase could not be verified");
    }
    const check = checkAppleTransaction(verified.payload, this.deps.config.PURCHASES_APPLE_BUNDLE_ID);
    if (!check.ok) return this.rejected(check.reason, null, true);
    const facts = check.facts;
    const product = await this.deps.catalog.byStoreProductId("apple", facts.productId);
    if (!product) return this.rejected("product_unavailable", null);
    if ((product.kind === "atlas_pass") !== (facts.type === "subscription")) return this.rejected("product_mismatch", product.sku, true);
    if (facts.appAccountToken !== await this.deps.ledger.ensureAppAccountToken(accountId)) {
      return this.rejected("account_mismatch", product.sku);
    }
    if (facts.revokedAt) {
      await this.deps.ledger.refund({
        platform: "apple", transactionId: facts.transactionId, reason: "revoked", refundedAt: facts.revokedAt
      });
      return this.rejected("revoked", product.sku, true);
    }
    if (product.kind === "atlas_pass" && !this.atlasPassEnabled) return this.rejected("atlas_pass_disabled", product.sku);
    const outcome = await this.grant({
      platform: "apple",
      transactionId: facts.transactionId,
      originalTransactionId: facts.originalTransactionId,
      purchaseToken: null,
      product,
      environment: verified.environment,
      accountId,
      appAccountToken: facts.appAccountToken,
      purchasedAt: facts.purchasedAt,
      storePriceMilli: facts.storePriceMilli,
      priceCurrency: facts.currency,
      subscription: product.kind === "atlas_pass" && facts.expiresAt
        ? this.passPeriod(facts.originalTransactionId, facts.purchasedAt, facts.expiresAt, null)
        : undefined,
      rejectOverLimit: false
    });
    if (outcome.status === "rejected" && outcome.rejectionReason === "sandbox_rejected") {
      return this.rejected("sandbox_rejected", product.sku, true);
    }
    return this.verifyResponse(accountId, outcome, true);
  }

  async verifyGoogle(accountId: string, input: { productId: string; purchaseToken: string }): Promise<PurchaseVerifyResponse> {
    const google = this.deps.google;
    if (!this.enabled("google") || !google) throw notFound();
    const product = await this.deps.catalog.byStoreProductId("google", input.productId);
    if (!product) return this.rejected("product_unavailable", null);
    if (product.kind === "atlas_pass" && !this.atlasPassEnabled) return this.rejected("atlas_pass_disabled", product.sku);
    const token = await this.deps.ledger.ensureAppAccountToken(accountId);
    try {
      const outcome = product.kind === "glimmer_pack"
        ? await this.grantGoogleProduct(product, input.purchaseToken, { accountId, appAccountToken: token })
        : await this.syncGoogleSubscription(product, input.purchaseToken, { accountId, appAccountToken: token });
      if (typeof outcome === "string") {
        return outcome === "pending"
          ? { ...emptyVerify(product.sku), status: "pending" }
          : this.rejected(outcome, product.sku);
      }
      return this.verifyResponse(accountId, outcome, false);
    } catch (error) {
      if (error instanceof GooglePlayApiError) {
        if (error.code === "invalid") throw new PurchaseRequestError(400, "PURCHASE_INVALID", "The purchase could not be verified");
        throw unavailable();
      }
      throw error;
    }
  }

  async createWebCheckout(accountId: string, sku: PremiumProductSku): Promise<WebCheckoutResponse> {
    const web = this.deps.web;
    if (!this.enabled("web") || !web) throw notFound();
    const denial = await this.denialFor(accountId, sku);
    if (denial) throw new PurchaseRequestError(409, "PURCHASE_DENIED", denial);
    const product = (await this.deps.catalog.bySku(sku))!;
    const sandbox = this.deps.config.PURCHASES_XSOLLA_SANDBOX;
    const buyerId = await this.deps.ledger.ensureAppAccountToken(accountId);
    const created = await this.deps.pool.query<{ checkout_id: string }>(
      `INSERT INTO premium_web_checkouts (account_id, provider, sku, sandbox)
       VALUES ($1, $2, $3, $4) RETURNING checkout_id`,
      [accountId, web.name, sku, sandbox]
    );
    const checkoutId = created.rows[0]!.checkout_id;
    try {
      const { checkoutUrl } = await web.createCheckout({
        checkoutId,
        buyerId,
        webSku: product.webSku,
        usdCents: product.usdCents,
        subscription: product.kind === "atlas_pass",
        description: product.kind === "atlas_pass" ? "Atlas Pass" : `${product.glimmerAmount} Glimmer`,
        sandbox
      });
      return { provider: web.name, checkoutId, checkoutUrl, sandbox };
    } catch (error) {
      if (error instanceof WebProviderError) throw unavailable();
      throw error;
    }
  }

  async atlasPass(accountId: string): Promise<AtlasPassEntitlement> {
    if (!this.atlasPassEnabled) throw notFound();
    const now = this.now();
    const lumenCredited = await this.deps.ledger.accrueAtlasPass(accountId, now);
    return { ...(await this.deps.ledger.entitlement(accountId, now)), lumenCredited: Number(lumenCredited) };
  }

  // -------------------------------------------------------------------------
  // Store notifications
  // -------------------------------------------------------------------------

  /** App Store Server Notifications V2. Returns the HTTP status to answer Apple with. */
  async handleAppleNotification(signedPayload: string): Promise<number> {
    const apple = this.deps.apple;
    if (!this.enabled("apple") || !apple) return 404;
    let notification;
    try {
      notification = await apple.verifyNotification(signedPayload);
    } catch (error) {
      return error instanceof AppleVerificationError && error.code === "retryable" ? 503 : 400;
    }
    const payload = notification.payload;
    const id = payload.notificationUUID;
    const type = String(payload.notificationType ?? "UNKNOWN");
    if (!id) return 400;
    return this.inbox("apple", id, type, { subtype: payload.subtype ?? null }, async () => {
      const signedTransaction = payload.data?.signedTransactionInfo;
      if (!signedTransaction) return "ignored";
      const transaction = await apple.verifyTransaction(signedTransaction);
      const check = checkAppleTransaction(transaction.payload, this.deps.config.PURCHASES_APPLE_BUNDLE_ID);
      if (!check.ok) return "ignored";
      const facts = check.facts;
      switch (type) {
        case "REFUND":
        case "REVOKE":
          await this.deps.ledger.refund({
            platform: "apple", transactionId: facts.transactionId, reason: type.toLowerCase(),
            refundedAt: facts.revokedAt ?? this.now()
          });
          return "processed";
        case "SUBSCRIBED":
        case "DID_RENEW":
        case "OFFER_REDEEMED":
        case "ONE_TIME_CHARGE": {
          const product = await this.deps.catalog.byStoreProductId("apple", facts.productId);
          const accountId = await this.deps.ledger.accountForAppAccountToken(facts.appAccountToken)
            ?? await this.deps.ledger.subscriptionAccount("apple", facts.originalTransactionId);
          if (!product || !accountId || (product.kind === "atlas_pass") !== (facts.type === "subscription")) return "ignored";
          if (product.kind === "atlas_pass" && !facts.expiresAt) return "ignored";
          await this.grant({
            platform: "apple",
            transactionId: facts.transactionId,
            originalTransactionId: facts.originalTransactionId,
            purchaseToken: null,
            product,
            environment: transaction.environment,
            accountId,
            appAccountToken: facts.appAccountToken,
            purchasedAt: facts.purchasedAt,
            storePriceMilli: facts.storePriceMilli,
            priceCurrency: facts.currency,
            subscription: product.kind === "atlas_pass"
              ? this.passPeriod(facts.originalTransactionId, facts.purchasedAt, facts.expiresAt!, null)
              : undefined,
            rejectOverLimit: false
          });
          return "processed";
        }
        case "DID_FAIL_TO_RENEW": {
          const renewal = payload.data?.signedRenewalInfo
            ? await apple.verifyRenewalInfo(payload.data.signedRenewalInfo)
            : null;
          const graceUntil = payload.subtype === "GRACE_PERIOD" && renewal?.gracePeriodExpiresDate
            ? new Date(renewal.gracePeriodExpiresDate)
            : null;
          await this.deps.ledger.updateSubscription({
            platform: "apple", originalId: facts.originalTransactionId,
            status: graceUntil ? "grace" : "on_hold", graceUntil
          });
          return "processed";
        }
        case "GRACE_PERIOD_EXPIRED":
          await this.deps.ledger.updateSubscription({
            platform: "apple", originalId: facts.originalTransactionId, status: "on_hold", graceUntil: null
          });
          return "processed";
        case "EXPIRED":
          await this.deps.ledger.updateSubscription({
            platform: "apple", originalId: facts.originalTransactionId, status: "expired", graceUntil: null, autoRenew: false
          });
          return "processed";
        case "DID_CHANGE_RENEWAL_STATUS":
          await this.deps.ledger.updateSubscription({
            platform: "apple", originalId: facts.originalTransactionId,
            autoRenew: payload.subtype === "AUTO_RENEW_ENABLED"
          });
          return "processed";
        default:
          // REFUND_DECLINED, REFUND_REVERSED, CONSUMPTION_REQUEST, TEST, PRICE_INCREASE, ...
          return "ignored";
      }
    });
  }

  /** Google RTDN via Pub/Sub push. Returns the HTTP status for Pub/Sub. */
  async handleGoogleRtdn(authorization: string | undefined, body: unknown): Promise<number> {
    const google = this.deps.google;
    if (!this.enabled("google") || !google || !this.deps.googlePush) return 404;
    if (!(await this.deps.googlePush(authorization))) return 401;
    const notification = parseRtdnPush(body);
    // Malformed or foreign messages are acknowledged so Pub/Sub stops redelivering them.
    if (!notification || notification.packageName !== this.deps.config.PURCHASES_GOOGLE_PACKAGE_NAME) return 204;
    const type = notification.voided ? "voided"
      : notification.oneTime ? `one_time:${notification.oneTime.type}`
        : notification.subscription ? `subscription:${notification.subscription.type}`
          : notification.test ? "test" : "unknown";
    const status = await this.inbox("google", notification.messageId, type, {}, async () => {
      if (notification.voided) {
        await this.deps.ledger.refund({
          platform: "google",
          transactionId: notification.voided.orderId,
          purchaseToken: notification.voided.purchaseToken,
          reason: "voided",
          refundedAt: new Date(notification.eventTimeMs || this.now().getTime())
        });
        return "processed";
      }
      if (notification.oneTime?.type === 1) {
        const product = await this.deps.catalog.byStoreProductId("google", notification.oneTime.sku);
        if (!product || product.kind !== "glimmer_pack") return "ignored";
        await this.grantGoogleProduct(product, notification.oneTime.purchaseToken, null);
        return "processed";
      }
      if (notification.subscription) {
        const token = notification.subscription.purchaseToken;
        if (notification.subscription.type === GOOGLE_SUBSCRIPTION_REVOKED) {
          await this.deps.ledger.refund({
            platform: "google", transactionId: null, purchaseToken: token, reason: "revoked", refundedAt: this.now()
          });
          await this.deps.ledger.updateSubscription({ platform: "google", originalId: token, status: "revoked", graceUntil: null });
          return "processed";
        }
        const product = notification.subscription.subscriptionId
          ? await this.deps.catalog.byStoreProductId("google", notification.subscription.subscriptionId)
          : null;
        await this.syncGoogleSubscription(product, token, null);
        return "processed";
      }
      return "ignored";
    });
    return status === 200 ? 204 : status;
  }

  /** Xsolla (or a replacement provider) webhook over the exact raw body. */
  async handleWebWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>
  ): Promise<WebhookReply> {
    const web = this.deps.web;
    if (!this.enabled("web") || !web) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found" } } };
    if (!web.verifySignature(rawBody, headers)) return web.reply("invalid_signature");
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return web.reply("invalid_request");
    }
    const event = web.parseEvent(json);
    if (!event) return web.reply("invalid_request");
    if (event.type === "ignored") return web.reply("ok");
    if (event.type === "user_validation") {
      return web.reply(await this.deps.ledger.accountForAppAccountToken(event.buyerId) ? "ok" : "invalid_user");
    }
    if (event.type === "subscription" && !(await this.deps.ledger.accountForAppAccountToken(event.buyerId))) {
      return web.reply("invalid_user");
    }
    const status = await this.inbox("web", event.notificationId, event.type, {}, async () => {
      if (event.type === "refund") {
        await this.deps.ledger.refund({
          platform: "web", transactionId: event.transactionId, reason: event.reason, refundedAt: this.now()
        });
        return "processed";
      }
      if (event.type === "review") {
        return { status: "needs_review", reason: event.reason, transactionId: event.transactionId };
      }
      if (event.type === "dispute") {
        const known = await this.deps.ledger.flagPurchase("web", event.transactionId, "dispute_open");
        this.deps.logger.warn({ transactionId: event.transactionId, action: event.action }, "web payment dispute");
        return known ? "processed" : { status: "needs_review", reason: "dispute_unknown_payment", transactionId: event.transactionId };
      }
      if (event.type === "subscription") {
        const known = await this.deps.ledger.updateSubscription({
          platform: "web",
          originalId: event.subscriptionId,
          status: event.status,
          currentPeriodEnd: event.periodEnd,
          graceUntil: null,
          autoRenew: event.autoRenew
        });
        return known ? "processed" : "ignored";
      }
      // A paid payment that cannot be matched is never dropped: it stays
      // needs_review, answered non-2xx so the provider retries, until support acts.
      const accountId = await this.deps.ledger.accountForAppAccountToken(event.buyerId);
      if (!accountId) return { status: "needs_review", reason: "unknown_buyer", transactionId: event.transactionId };
      const resolved = await this.resolveWebPayment(accountId, event);
      if (typeof resolved === "string") {
        return { status: "needs_review", reason: resolved, transactionId: event.transactionId };
      }
      const outcome = await this.grant({
        platform: "web",
        transactionId: event.transactionId,
        originalTransactionId: event.subscriptionId,
        purchaseToken: resolved.checkoutId,
        product: resolved.product,
        environment: event.sandbox ? "sandbox" : "production",
        accountId,
        appAccountToken: event.buyerId.toLowerCase(),
        purchasedAt: event.paidAt,
        storePriceMilli: event.amountMilli,
        priceCurrency: event.currency,
        subscription: resolved.product.kind === "atlas_pass" && resolved.product.period
          ? this.passPeriod(
              event.subscriptionId ?? resolved.checkoutId ?? event.transactionId,
              event.paidAt,
              addPassPeriod(event.paidAt, resolved.product.period),
              true
            )
          : undefined,
        rejectOverLimit: false,
        checkoutId: resolved.checkoutId
      });
      if (outcome.status === "rejected") {
        // Test money refused by configuration is settled; anything else needs a person.
        return outcome.rejectionReason === "sandbox_rejected"
          ? { status: "ignored", reason: "sandbox_rejected", transactionId: event.transactionId }
          : { status: "needs_review", reason: outcome.rejectionReason ?? "rejected", transactionId: event.transactionId };
      }
      return "processed";
    });
    return web.reply(status === 200 ? "ok" : "retry");
  }

  /** Google voided-purchases sweep (backstop for RTDN) and consume/acknowledge retries. */
  async runGoogleMaintenance(): Promise<{ voided: number; acknowledged: number }> {
    const google = this.deps.google;
    if (!this.enabled("google") || !google) return { voided: 0, acknowledged: 0 };
    const now = this.now();
    let voided = 0;
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await google.listVoidedPurchases(now.getTime() - VOIDED_LOOKBACK_MS, pageToken);
      for (const purchase of result.purchases) {
        if (!purchase.purchaseToken) continue;
        const outcome = await this.deps.ledger.refund({
          platform: "google",
          transactionId: purchase.orderId ?? null,
          purchaseToken: purchase.purchaseToken,
          reason: "voided",
          refundedAt: new Date(Number(purchase.voidedTimeMillis) || now.getTime())
        });
        if (outcome.status === "clawed_back" || outcome.status === "in_arrears") voided += 1;
      }
      if (!result.nextPageToken) break;
      pageToken = result.nextPageToken;
    }
    let acknowledged = 0;
    for (const pending of await this.deps.ledger.unacknowledgedGooglePurchases(new Date(now.getTime() - ACK_RETRY_WINDOW_MS))) {
      try {
        if (pending.productKind === "glimmer_pack") {
          await google.consumeProductPurchase(pending.googleProductId, pending.purchaseToken);
        } else {
          await google.acknowledgeSubscription(pending.googleProductId, pending.purchaseToken);
        }
        await this.deps.ledger.markAcknowledged(pending.purchaseId, this.now());
        acknowledged += 1;
      } catch (error) {
        this.deps.logger.warn({ err: error, purchaseId: pending.purchaseId }, "google acknowledge retry failed");
      }
    }
    return { voided, acknowledged };
  }

  // -------------------------------------------------------------------------

  private async denialFor(accountId: string, sku: PremiumProductSku): Promise<PurchaseDenialReason | null> {
    const product = await this.deps.catalog.bySku(sku);
    if (!product) return "product_unavailable";
    if (product.kind === "atlas_pass") {
      if (!this.atlasPassEnabled) return "atlas_pass_disabled";
      if ((await this.deps.ledger.entitlement(accountId, this.now())).active) return "atlas_pass_active";
    }
    return this.deps.ledger.limitDenial(accountId, product.usdCents, this.now());
  }

  private async grant(facts: StorePurchaseFacts): Promise<GrantOutcome> {
    if (facts.environment === "sandbox" && !this.deps.config.PURCHASES_ACCEPT_SANDBOX) {
      return {
        status: "rejected", purchaseId: null, sku: facts.product.sku, glimmerGranted: 0n,
        acknowledged: false, rejectionReason: "sandbox_rejected"
      };
    }
    try {
      const outcome = await this.deps.ledger.grant(facts, this.now());
      if (outcome.status === "granted") {
        this.deps.logger.info({
          purchaseId: outcome.purchaseId, platform: facts.platform, sku: facts.product.sku, environment: facts.environment
        }, "premium purchase granted");
      }
      return outcome;
    } catch (error) {
      if (error instanceof PurchaseLedgerError && error.code === "PURCHASE_ACCOUNT_MISMATCH") {
        throw new PurchaseRequestError(409, "PURCHASE_ACCOUNT_MISMATCH", "This purchase belongs to another account");
      }
      throw error;
    }
  }

  /** Verifies one Google one-time product and grants it; consumes only after the grant committed. */
  private async grantGoogleProduct(
    product: PremiumProduct,
    purchaseToken: string,
    expected: { accountId: string; appAccountToken: string } | null
  ): Promise<GrantOutcome | string> {
    const google = this.deps.google!;
    const raw = await google.getProductPurchase(product.googleProductId, purchaseToken);
    const check = checkGoogleProductPurchase(raw, purchaseToken);
    if (!check.ok) return check.reason;
    const accountId = expected?.accountId
      ?? await this.deps.ledger.accountForAppAccountToken(check.facts.obfuscatedAccountId);
    if (!accountId) return "account_mismatch";
    if (expected && check.facts.obfuscatedAccountId !== expected.appAccountToken) return "account_mismatch";
    const outcome = await this.grant({
      platform: "google",
      transactionId: check.facts.transactionId,
      originalTransactionId: null,
      purchaseToken,
      product,
      environment: check.facts.environment,
      accountId,
      appAccountToken: check.facts.obfuscatedAccountId,
      purchasedAt: check.facts.purchasedAt,
      storePriceMilli: null,
      priceCurrency: null,
      rejectOverLimit: true
    });
    if ((outcome.status === "granted" || outcome.status === "already_granted") && !outcome.acknowledged && outcome.purchaseId) {
      try {
        if (!check.facts.consumed) await google.consumeProductPurchase(product.googleProductId, purchaseToken);
        await this.deps.ledger.markAcknowledged(outcome.purchaseId, this.now());
      } catch (error) {
        // The grant stands; maintenance retries the consume before Google's 3-day window.
        this.deps.logger.warn({ err: error, purchaseId: outcome.purchaseId }, "google consume failed");
      }
    }
    return outcome;
  }

  /** Reads a Google subscription, grants its latest paid period once and syncs its status. */
  private async syncGoogleSubscription(
    product: PremiumProduct | null,
    purchaseToken: string,
    expected: { accountId: string; appAccountToken: string } | null
  ): Promise<GrantOutcome | string> {
    const google = this.deps.google!;
    const check = checkGoogleSubscription(await google.getSubscription(purchaseToken));
    if (!check.ok) return check.reason;
    const facts = check.facts;
    const resolved = product ?? await this.deps.catalog.byStoreProductId("google", facts.productId);
    if (!resolved || resolved.kind !== "atlas_pass" || resolved.googleProductId !== facts.productId || !resolved.period) {
      return "product_mismatch";
    }
    const accountId = expected?.accountId
      ?? await this.deps.ledger.accountForAppAccountToken(facts.obfuscatedAccountId)
      ?? await this.deps.ledger.subscriptionAccount("google", purchaseToken);
    if (!accountId) return "account_mismatch";
    if (expected && facts.obfuscatedAccountId !== expected.appAccountToken) return "account_mismatch";
    const graceUntil = facts.status === "grace" ? facts.expiresAt : null;
    if (!facts.paid || !facts.latestOrderId) {
      await this.deps.ledger.updateSubscription({
        platform: "google", originalId: purchaseToken, status: facts.status, graceUntil, autoRenew: facts.autoRenew
      });
      return facts.status === "grace" || facts.status === "on_hold" ? "pending" : "not_active";
    }
    const periodStart = latest(facts.startedAt, subtractPassPeriod(facts.expiresAt, resolved.period));
    const outcome = await this.grant({
      platform: "google",
      transactionId: facts.latestOrderId,
      originalTransactionId: purchaseToken,
      purchaseToken,
      product: resolved,
      environment: facts.environment,
      accountId,
      appAccountToken: facts.obfuscatedAccountId,
      purchasedAt: periodStart,
      storePriceMilli: null,
      priceCurrency: null,
      subscription: this.passPeriod(purchaseToken, periodStart, facts.expiresAt, facts.autoRenew, facts.status),
      // Only the unacknowledged initial purchase can still be refunded by Google;
      // renewals keep the money, so they are granted and flagged instead.
      rejectOverLimit: !facts.acknowledged
    });
    if (outcome.status === "already_granted") {
      await this.deps.ledger.updateSubscription({
        platform: "google", originalId: purchaseToken, status: facts.status,
        currentPeriodEnd: facts.expiresAt, graceUntil, autoRenew: facts.autoRenew
      });
    }
    if ((outcome.status === "granted" || outcome.status === "already_granted") && outcome.purchaseId && !outcome.acknowledged) {
      try {
        if (!facts.acknowledged) await google.acknowledgeSubscription(resolved.googleProductId, purchaseToken);
        await this.deps.ledger.markAcknowledged(outcome.purchaseId, this.now());
      } catch (error) {
        this.deps.logger.warn({ err: error, purchaseId: outcome.purchaseId }, "google subscription acknowledge failed");
      }
    }
    return outcome;
  }

  /** Matches a paid web payment to its checkout or subscription; a string is the reason it needs review. */
  private async resolveWebPayment(
    accountId: string,
    event: Extract<WebPaymentEvent, { type: "payment" }>
  ): Promise<{ product: PremiumProduct; checkoutId: string | null } | string> {
    if (event.checkoutId && /^[0-9a-f-]{36}$/iu.test(event.checkoutId)) {
      const checkout = await this.deps.pool.query<{ account_id: string | null; sku: string; sandbox: boolean }>(
        "SELECT account_id, sku, sandbox FROM premium_web_checkouts WHERE checkout_id = $1",
        [event.checkoutId]
      );
      const row = checkout.rows[0];
      if (!row) return "unknown_checkout";
      if (row.account_id !== accountId) return "checkout_account_mismatch";
      if (row.sandbox !== event.sandbox) return "checkout_mode_mismatch";
      const product = await this.deps.catalog.bySku(row.sku);
      if (!product) return "product_unavailable";
      // Our token fixed the USD price server-side. purchase.checkout echoes that
      // request; only a USD echo that disagrees is suspicious. The buyer's local
      // currency and taxes (purchase.total, payment_details) are never compared.
      if (
        product.kind === "glimmer_pack" && event.currency === "USD" && event.amountMilli !== null &&
        event.amountMilli !== BigInt(product.usdCents) * 10n
      ) return "amount_mismatch";
      return { product, checkoutId: event.checkoutId };
    }
    // Subscription renewals carry no checkout: the plan and subscription identify them.
    if (event.subscriptionId && event.planSku) {
      const product = await this.deps.catalog.byStoreProductId("web", event.planSku);
      if (!product || product.kind !== "atlas_pass") return "unknown_plan";
      const owner = await this.deps.ledger.subscriptionAccount("web", event.subscriptionId);
      if (owner && owner !== accountId) return "subscription_account_mismatch";
      return { product, checkoutId: null };
    }
    return "unknown_checkout";
  }

  private passPeriod(
    originalId: string, start: Date, end: Date, autoRenew: boolean | null,
    status?: PassPeriodFacts["status"]
  ): PassPeriodFacts {
    return {
      originalId,
      periodStart: start,
      periodEnd: end,
      status: status ?? (end.getTime() > this.now().getTime() ? "active" : "expired"),
      graceUntil: null,
      autoRenew
    };
  }

  private async inbox(
    platform: PurchasePlatform,
    notificationId: string,
    type: string,
    payload: Record<string, unknown>,
    process: () => Promise<InboxResult>
  ): Promise<number> {
    const { pool } = this.deps;
    await pool.query(
      `INSERT INTO store_notification_inbox (platform, notification_id, notification_type, payload)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (platform, notification_id) DO NOTHING`,
      [platform, notificationId.slice(0, 240), type.slice(0, 80), JSON.stringify(payload)]
    );
    const existing = await pool.query<{ status: string }>(
      "SELECT status FROM store_notification_inbox WHERE platform = $1 AND notification_id = $2",
      [platform, notificationId.slice(0, 240)]
    );
    if (existing.rows[0]?.status === "processed" || existing.rows[0]?.status === "ignored") return 200;
    try {
      const result = await process();
      const outcome = typeof result === "string" ? { status: result, reason: null, transactionId: null } : result;
      await pool.query(
        `UPDATE store_notification_inbox
         SET status = $3, attempts = attempts + 1, error = $4,
             processed_at = CASE WHEN $3 = 'needs_review' THEN NULL ELSE now() END
         WHERE platform = $1 AND notification_id = $2`,
        [platform, notificationId.slice(0, 240), outcome.status, outcome.reason?.slice(0, 240) ?? null]
      );
      if (outcome.status !== "needs_review") return 200;
      // Money arrived that the server will not settle on its own. The row stays
      // open (store_notification_inbox status needs_review) for support, and the
      // provider is answered non-2xx so it keeps retrying.
      this.deps.logger.error({
        alert: "purchase_needs_review", platform, type, notificationId, reason: outcome.reason,
        transactionId: outcome.transactionId
      }, "store payment needs manual review");
      return 500;
    } catch (error) {
      const code = error instanceof Error ? error.name : "error";
      await pool.query(
        `UPDATE store_notification_inbox SET status = 'failed', attempts = attempts + 1, error = $3
         WHERE platform = $1 AND notification_id = $2`,
        [platform, notificationId.slice(0, 240), code.slice(0, 240)]
      ).catch(() => undefined);
      this.deps.logger.error({ err: error, platform, type }, "store notification processing failed");
      return 500;
    }
  }

  /**
   * `finish` tells StoreKit to finish a transaction that can never be granted
   * (wrong app, family shared, unsupported, revoked, refused sandbox) so it
   * stops redelivering it; retryable and account mismatches stay unfinished.
   */
  private rejected(reason: string, sku: PremiumProductSku | null, finish = false): PurchaseVerifyResponse {
    this.deps.logger.warn({ reason, sku }, "store purchase rejected");
    return { ...emptyVerify(sku), status: "rejected", finishTransaction: finish };
  }

  private async verifyResponse(accountId: string, outcome: GrantOutcome, finishable: boolean): Promise<PurchaseVerifyResponse> {
    const granted = outcome.status === "granted" || outcome.status === "already_granted";
    const isPass = (await this.deps.catalog.bySku(outcome.sku))?.kind === "atlas_pass";
    return {
      status: outcome.status,
      purchaseId: outcome.purchaseId,
      sku: outcome.sku,
      glimmerGranted: Number(outcome.glimmerGranted),
      finishTransaction: finishable && granted,
      wallet: granted ? await this.deps.wallet.snapshot(accountId) : null,
      atlasPass: granted && isPass && this.atlasPassEnabled ? await this.atlasPass(accountId) : null
    };
  }
}

type InboxResult =
  | "processed"
  | "ignored"
  | Readonly<{ status: "ignored" | "needs_review"; reason: string; transactionId: string | null }>;

function emptyVerify(sku: PremiumProductSku | null): PurchaseVerifyResponse {
  return {
    status: "rejected", purchaseId: null, sku, glimmerGranted: 0, finishTransaction: false, wallet: null, atlasPass: null
  };
}

function purchasePathFor(
  platform: PurchaseClientPlatform,
  enabled: Readonly<Record<PurchasePlatform, boolean>>
): PurchasePlatform | null {
  if (platform === "ios") return enabled.apple ? "apple" : null;
  if (platform === "android") return enabled.google ? "google" : null;
  return enabled.web ? "web" : null;
}

/** Plan §7.3: link to the web shop only where a plain link is allowed. */
export function shopLinkCapability(
  config: Pick<PurchaseConfig, "SHOP_LINKS_MODE" | "SHOP_WEB_URL">,
  platform: PurchaseClientPlatform,
  storefront: string | undefined,
  webEnabled: boolean
): ShopLinkCapability {
  if (config.SHOP_LINKS_MODE === "off" || !webEnabled) return { allowed: false, url: null, reason: "disabled" };
  if (!config.SHOP_WEB_URL) return { allowed: false, url: null, reason: "no_url" };
  if (platform === "web") return { allowed: true, url: config.SHOP_WEB_URL, reason: "web_client" };
  const code = normalizeStorefront(storefront);
  if (!code) return { allowed: false, url: null, reason: "storefront_unknown" };
  return SHOP_LINK_ALLOWED_STOREFRONTS[platform].includes(code)
    ? { allowed: true, url: config.SHOP_WEB_URL, reason: "storefront_allowed" }
    : { allowed: false, url: null, reason: "storefront_denied" };
}

function normalizeStorefront(storefront: string | undefined): string | null {
  if (!storefront) return null;
  const upper = storefront.toUpperCase();
  if (upper.length === 2) return alpha.isValid(upper) ? upper : null;
  return alpha.alpha3ToAlpha2(upper) ?? null;
}

function subtractPassPeriod(end: Date, period: "month" | "year"): Date {
  const start = new Date(end.getTime());
  if (period === "year") start.setUTCFullYear(start.getUTCFullYear() - 1);
  else start.setUTCMonth(start.getUTCMonth() - 1);
  return start;
}

function latest(a: Date | null, b: Date): Date {
  return a && a.getTime() > b.getTime() ? a : b;
}

export type { PurchaseEnvironment };
