import { createHash, timingSafeEqual } from "node:crypto";

// Web checkout behind a small provider adapter (STORE_LAUNCH_BUILD_PLAN.md §5):
// Xsolla today, Stripe Managed Payments can replace it by implementing the same
// interface. Grants only ever come from verified webhooks, never redirects.

export type WebCheckoutInput = Readonly<{
  checkoutId: string;
  /** Pseudonymous buyer id given to the provider (the account's appAccountToken). */
  buyerId: string;
  webSku: string;
  usdCents: number;
  subscription: boolean;
  description: string;
  sandbox: boolean;
}>;

export type WebPaymentEvent =
  | Readonly<{ type: "user_validation"; buyerId: string }>
  | Readonly<{
      type: "payment";
      notificationId: string;
      transactionId: string;
      checkoutId: string | null;
      buyerId: string;
      amountMilli: bigint | null;
      currency: string | null;
      sandbox: boolean;
      subscriptionId: string | null;
      planSku: string | null;
      paidAt: Date;
    }>
  | Readonly<{ type: "refund"; notificationId: string; transactionId: string; reason: string }>
  /** Money moved in a way the server must not settle on its own (support grants or claws back). */
  | Readonly<{ type: "review"; notificationId: string; transactionId: string; reason: string }>
  | Readonly<{ type: "dispute"; notificationId: string; transactionId: string; action: string }>
  | Readonly<{
      type: "subscription";
      notificationId: string;
      subscriptionId: string;
      buyerId: string;
      planSku: string | null;
      status: "active" | "expired";
      autoRenew: boolean | null;
      periodEnd: Date | null;
    }>
  | Readonly<{ type: "ignored"; notificationType: string }>;

export type WebhookReply = Readonly<{ status: number; body: unknown }>;

export interface WebPaymentProvider {
  readonly name: "xsolla";
  createCheckout(input: WebCheckoutInput): Promise<{ checkoutUrl: string }>;
  /** Verifies the provider signature over the exact raw body. */
  verifySignature(rawBody: Buffer, headers: Readonly<Record<string, string | string[] | undefined>>): boolean;
  parseEvent(body: unknown): WebPaymentEvent | null;
  reply(outcome: "ok" | "invalid_signature" | "invalid_user" | "invalid_request" | "retry"): WebhookReply;
}

export class WebProviderError extends Error {
  constructor(readonly code: "unavailable" | "rejected") {
    super(`Web payment provider ${code}`);
    this.name = "WebProviderError";
  }
}

export type XsollaOptions = Readonly<{
  merchantId: string;
  projectId: string;
  apiKey: string;
  webhookSecret: string;
  returnUrl: string | undefined;
  timeoutMs: number;
  fetch?: typeof fetch;
}>;

/** Xsolla Pay Station token (Merchant API v2) and webhooks (`Authorization: Signature sha1(body + secret)`). */
export class XsollaProvider implements WebPaymentProvider {
  readonly name = "xsolla" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: XsollaOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createCheckout(input: WebCheckoutInput): Promise<{ checkoutUrl: string }> {
    const amount = (input.usdCents / 100).toFixed(2);
    const body = {
      user: { id: { value: input.buyerId } },
      settings: {
        project_id: Number(this.options.projectId),
        external_id: input.checkoutId,
        currency: "USD",
        ...(input.sandbox ? { mode: "sandbox" } : {}),
        ...(this.options.returnUrl ? { return_url: this.options.returnUrl } : {})
      },
      purchase: input.subscription
        ? { subscription: { plan_id: input.webSku } }
        : { checkout: { amount: Number(amount), currency: "USD" }, description: { value: input.description } },
      custom_parameters: { sku: input.webSku, checkout_id: input.checkoutId }
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `https://api.xsolla.com/merchant/v2/merchants/${encodeURIComponent(this.options.merchantId)}/token`,
        {
          method: "POST",
          signal: controller.signal,
          redirect: "error",
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.options.merchantId}:${this.options.apiKey}`).toString("base64")}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        }
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new WebProviderError(response.status >= 500 ? "unavailable" : "rejected");
      }
      const json = await response.json() as { token?: unknown };
      if (typeof json.token !== "string" || !/^[A-Za-z0-9_-]{8,512}$/u.test(json.token)) {
        throw new WebProviderError("unavailable");
      }
      const host = input.sandbox ? "https://sandbox-secure.xsolla.com" : "https://secure.xsolla.com";
      return { checkoutUrl: `${host}/paystation4/?token=${encodeURIComponent(json.token)}` };
    } catch (error) {
      if (error instanceof WebProviderError) throw error;
      throw new WebProviderError("unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  verifySignature(rawBody: Buffer, headers: Readonly<Record<string, string | string[] | undefined>>): boolean {
    const header = headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = /^Signature ([0-9a-f]{40})$/iu.exec(value ?? "");
    if (!match || !this.options.webhookSecret) return false;
    const expected = createHash("sha1")
      .update(Buffer.concat([rawBody, Buffer.from(this.options.webhookSecret, "utf8")]))
      .digest();
    const given = Buffer.from(match[1]!.toLowerCase(), "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  parseEvent(body: unknown): WebPaymentEvent | null {
    if (!body || typeof body !== "object") return null;
    const root = body as Record<string, unknown>;
    const type = typeof root.notification_type === "string" ? root.notification_type : null;
    if (!type) return null;
    const object = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};
    const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 240 ? value
      : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
    const user = object(root.user);
    const buyerId = text(user.id);
    const transaction = object(root.transaction);
    const purchase = object(root.purchase);
    const subscription = object(root.subscription);
    const purchaseSubscription = object(purchase.subscription);
    switch (type) {
      case "user_validation":
        return buyerId ? { type, buyerId } : null;
      case "payment": {
        const transactionId = text(transaction.id);
        if (!transactionId || !buyerId) return null;
        // purchase.checkout is the amount and currency our token requested.
        // purchase.total and payment_details.payment are what the buyer was
        // charged (local currency, taxes), so they are never compared.
        const priced = object(purchase.checkout);
        const amount = typeof priced.amount === "number" && Number.isFinite(priced.amount) && priced.amount >= 0
          ? BigInt(Math.round(priced.amount * 1000))
          : null;
        const paidAt = Date.parse(typeof transaction.payment_date === "string" ? transaction.payment_date : "");
        return {
          type,
          notificationId: `payment:${transactionId}`,
          transactionId,
          checkoutId: text(transaction.external_id),
          buyerId,
          amountMilli: amount,
          currency: typeof priced.currency === "string" && /^[A-Z]{3}$/u.test(priced.currency) ? priced.currency : null,
          sandbox: transaction.dry_run === 1 || transaction.dry_run === true,
          subscriptionId: text(purchaseSubscription.subscription_id),
          planSku: text(purchaseSubscription.plan_id),
          paidAt: Number.isFinite(paidAt) ? new Date(paidAt) : new Date()
        };
      }
      // `refund` is Xsolla's payment cancellation (refunds and lost chargebacks):
      // the whole grant is clawed back. A partial refund is left to support.
      case "refund":
      case "partial_refund": {
        const transactionId = text(transaction.id);
        if (!transactionId) return null;
        return type === "refund"
          ? { type: "refund", notificationId: `refund:${transactionId}`, transactionId, reason: "provider_refund" }
          : { type: "review", notificationId: `partial_refund:${transactionId}`, transactionId, reason: "partial_refund" };
      }
      // An opened or updated dispute only flags the purchase; money moves on `refund`.
      case "dispute": {
        const transactionId = text(transaction.id);
        if (!transactionId) return null;
        const dispute = object(root.dispute);
        const action = text(root.action) ?? "adding";
        const state = text(dispute.status) ?? "";
        return {
          type: "dispute",
          notificationId: `dispute:${transactionId}:${action}:${state}`.slice(0, 240),
          transactionId,
          action
        };
      }
      case "create_subscription":
      case "update_subscription":
      case "cancel_subscription":
      case "non_renewal_subscription": {
        const subscriptionId = text(subscription.subscription_id);
        if (!subscriptionId || !buyerId) return null;
        const next = Date.parse(typeof subscription.date_next_charge === "string" ? subscription.date_next_charge : "");
        return {
          type: "subscription",
          notificationId: `${type}:${subscriptionId}:${text(subscription.date_next_charge) ?? ""}`,
          subscriptionId,
          buyerId,
          planSku: text(subscription.plan_id),
          status: type === "cancel_subscription" ? "expired" : "active",
          autoRenew: type === "non_renewal_subscription" || type === "cancel_subscription" ? false : true,
          periodEnd: Number.isFinite(next) ? new Date(next) : null
        };
      }
      default:
        return { type: "ignored", notificationType: type.slice(0, 80) };
    }
  }

  reply(outcome: "ok" | "invalid_signature" | "invalid_user" | "invalid_request" | "retry"): WebhookReply {
    switch (outcome) {
      case "ok":
        return { status: 204, body: null };
      case "invalid_signature":
        return { status: 400, body: { error: { code: "INVALID_SIGNATURE", message: "Invalid signature" } } };
      case "invalid_user":
        return { status: 400, body: { error: { code: "INVALID_USER", message: "Invalid user" } } };
      case "invalid_request":
        return { status: 400, body: { error: { code: "INVALID_PARAMETER", message: "Invalid request" } } };
      case "retry":
        return { status: 500, body: { error: { code: "SERVER_ERROR", message: "Try again later" } } };
    }
  }
}
