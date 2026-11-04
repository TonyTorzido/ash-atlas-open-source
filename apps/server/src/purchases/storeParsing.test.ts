import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { checkGoogleProductPurchase, checkGoogleSubscription, parseRtdnPush } from "./googlePlay.js";
import { shopLinkCapability } from "./purchaseService.js";
import { XsollaProvider } from "./webPaymentProvider.js";

const TOKEN = "00000000-0000-4000-8000-0000000000b1";

describe("Google Play purchase fixtures", () => {
  const product = {
    purchaseState: 0, consumptionState: 0, acknowledgementState: 0,
    orderId: "GPA.3345-1234-5678-90123", purchaseTimeMillis: "1790000000000",
    obfuscatedExternalAccountId: TOKEN, regionCode: "US"
  };

  it("accepts a real purchase and marks license tests as sandbox", () => {
    expect(checkGoogleProductPurchase(product, "tok")).toEqual({
      ok: true,
      facts: {
        transactionId: "GPA.3345-1234-5678-90123", purchasedAt: new Date(1790000000000),
        environment: "production", obfuscatedAccountId: TOKEN, consumed: false
      }
    });
    const withoutOrder: Omit<typeof product, "orderId"> & { orderId?: string } = { ...product };
    delete withoutOrder.orderId;
    expect(checkGoogleProductPurchase({ ...withoutOrder, purchaseType: 0 }, "tok")).toMatchObject({
      ok: true,
      facts: { environment: "sandbox", transactionId: `token:${createHash("sha256").update("tok").digest("hex")}` }
    });
  });

  it("never grants pending, cancelled, promo or multi-quantity purchases", () => {
    expect(checkGoogleProductPurchase({ ...product, purchaseState: 2 }, "tok")).toEqual({ ok: false, reason: "pending" });
    expect(checkGoogleProductPurchase({ ...product, purchaseState: 1 }, "tok")).toEqual({ ok: false, reason: "not_purchased" });
    expect(checkGoogleProductPurchase({ ...product, purchaseType: 1 }, "tok")).toEqual({ ok: false, reason: "promo_unsupported" });
    expect(checkGoogleProductPurchase({ ...product, quantity: 3 }, "tok")).toEqual({ ok: false, reason: "quantity_unsupported" });
  });

  it("maps subscriptionsv2 states to pass status and paid periods", () => {
    const expiry = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const base = {
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      startTime: "2026-09-01T00:00:00Z",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      externalAccountIdentifiers: { obfuscatedExternalAccountId: TOKEN },
      lineItems: [{
        productId: "com.ashatlas.game.pass.monthly", expiryTime: expiry,
        latestSuccessfulOrderId: "GPA.1111-2222-3333-44444..1", autoRenewingPlan: { autoRenewEnabled: true }
      }]
    };
    expect(checkGoogleSubscription(base)).toMatchObject({
      ok: true,
      facts: { status: "active", paid: true, latestOrderId: "GPA.1111-2222-3333-44444..1", autoRenew: true, acknowledged: false }
    });
    expect(checkGoogleSubscription({ ...base, subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" }))
      .toMatchObject({ ok: true, facts: { status: "grace", paid: false } });
    expect(checkGoogleSubscription({ ...base, subscriptionState: "SUBSCRIPTION_STATE_PENDING" }))
      .toEqual({ ok: false, reason: "pending" });
    expect(checkGoogleSubscription({ ...base, testPurchase: {} })).toMatchObject({ ok: true, facts: { environment: "sandbox" } });
  });

  it("parses RTDN push envelopes and drops malformed ones", () => {
    const envelope = (data: unknown) => ({
      message: { data: Buffer.from(JSON.stringify(data)).toString("base64"), messageId: "m-1" },
      subscription: "projects/p/subscriptions/s"
    });
    expect(parseRtdnPush(envelope({
      version: "1.0", packageName: "com.ashatlas.game", eventTimeMillis: "1790000000000",
      voidedPurchaseNotification: { purchaseToken: "tok", orderId: "GPA.1", productType: 2, refundType: 1 }
    }))).toMatchObject({
      messageId: "m-1", packageName: "com.ashatlas.game",
      voided: { purchaseToken: "tok", orderId: "GPA.1", productType: 2 }, oneTime: null
    });
    expect(parseRtdnPush(envelope({
      packageName: "com.ashatlas.game",
      subscriptionNotification: { notificationType: 2, purchaseToken: "tok", subscriptionId: "com.ashatlas.game.pass.monthly" }
    }))).toMatchObject({ subscription: { type: 2, purchaseToken: "tok" } });
    expect(parseRtdnPush({ message: { data: "not-json", messageId: "m" } })).toBeNull();
    expect(parseRtdnPush(null)).toBeNull();
  });
});

describe("Xsolla webhook adapter", () => {
  const provider = new XsollaProvider({
    merchantId: "1", projectId: "2", apiKey: "k", webhookSecret: "secret-key", returnUrl: undefined, timeoutMs: 1000
  });
  const signed = (body: unknown) => {
    const raw = Buffer.from(JSON.stringify(body));
    const signature = createHash("sha1").update(Buffer.concat([raw, Buffer.from("secret-key")])).digest("hex");
    return { raw, headers: { authorization: `Signature ${signature}` } };
  };

  it("accepts only the exact signed body", () => {
    const { raw, headers } = signed({ notification_type: "user_validation", user: { id: TOKEN } });
    expect(provider.verifySignature(raw, headers)).toBe(true);
    expect(provider.verifySignature(Buffer.concat([raw, Buffer.from(" ")]), headers)).toBe(false);
    expect(provider.verifySignature(raw, { authorization: "Signature 0000000000000000000000000000000000000000" })).toBe(false);
    expect(provider.verifySignature(raw, {})).toBe(false);
  });

  it("normalizes payment, refund, dispute and subscription notifications", () => {
    expect(provider.parseEvent({
      notification_type: "payment",
      user: { id: TOKEN },
      purchase: { checkout: { amount: 9.99, currency: "USD" } },
      transaction: { id: 87654321, external_id: "00000000-0000-4000-8000-000000900012", dry_run: 1, payment_date: "2026-10-03T10:00:00+00:00" }
    })).toEqual({
      type: "payment", notificationId: "payment:87654321", transactionId: "87654321",
      checkoutId: "00000000-0000-4000-8000-000000900012", buyerId: TOKEN, amountMilli: 9990n, currency: "USD",
      sandbox: true, subscriptionId: null, planSku: null, paidAt: new Date("2026-10-03T10:00:00Z")
    });
    expect(provider.parseEvent({ notification_type: "refund", transaction: { id: 87654321 } }))
      .toEqual({ type: "refund", notificationId: "refund:87654321", transactionId: "87654321", reason: "provider_refund" });
    // A partial refund goes to support; an opened dispute only flags, never claws back.
    expect(provider.parseEvent({ notification_type: "partial_refund", transaction: { id: 5 } }))
      .toMatchObject({ type: "review", reason: "partial_refund" });
    expect(provider.parseEvent({ notification_type: "dispute", action: "adding", transaction: { id: 5 } }))
      .toMatchObject({ type: "dispute", transactionId: "5", action: "adding" });
    expect(provider.parseEvent({ notification_type: "chargeback", transaction: { id: 5 } }))
      .toMatchObject({ type: "ignored" });
    // Only purchase.checkout (our requested price) is read, never the buyer-currency total.
    expect(provider.parseEvent({
      notification_type: "payment", user: { id: TOKEN }, transaction: { id: 9 },
      purchase: { total: { amount: 9.18, currency: "EUR" } }
    })).toMatchObject({ amountMilli: null, currency: null });
    expect(provider.parseEvent({
      notification_type: "non_renewal_subscription", user: { id: TOKEN },
      subscription: { subscription_id: 77, plan_id: "atlas_pass_monthly", date_next_charge: "2026-11-03T00:00:00+00:00" }
    })).toMatchObject({ type: "subscription", subscriptionId: "77", autoRenew: false, status: "active" });
    expect(provider.parseEvent({ notification_type: "payment", user: { id: TOKEN } })).toBeNull();
    expect(provider.parseEvent({ notification_type: "order_paid" })).toEqual({ type: "ignored", notificationType: "order_paid" });
  });
});

describe("shop link capability (plan §7.3)", () => {
  const config = { SHOP_LINKS_MODE: "storefront" as const, SHOP_WEB_URL: "https://playashatlas.com/shop" };
  it("links only from allowed storefronts and never while off", () => {
    expect(shopLinkCapability(config, "ios", "USA", true)).toMatchObject({ allowed: true, reason: "storefront_allowed" });
    expect(shopLinkCapability(config, "android", "US", true)).toMatchObject({ allowed: true });
    expect(shopLinkCapability(config, "ios", "DEU", true)).toMatchObject({ allowed: false, reason: "storefront_denied" });
    expect(shopLinkCapability(config, "android", undefined, true)).toMatchObject({ allowed: false, reason: "storefront_unknown" });
    expect(shopLinkCapability({ ...config, SHOP_LINKS_MODE: "off" }, "web", undefined, true)).toMatchObject({ allowed: false });
    expect(shopLinkCapability(config, "ios", "USA", false)).toMatchObject({ allowed: false, reason: "disabled" });
  });
});
