import { createHash } from "node:crypto";

import { GoogleAuth, OAuth2Client } from "google-auth-library";

import type { AtlasPassStatus } from "@ash-atlas/shared";
import type { PurchaseEnvironment } from "./purchaseLedger.js";

// Google Play Developer API (androidpublisher v3) over REST
// (premium-currency-plan.md §6.4). Never logs tokens or raw responses.

const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API_ROOT = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const MAX_RESPONSE_BYTES = 262_144;

export class GooglePlayApiError extends Error {
  constructor(readonly status: number, readonly code: "invalid" | "unavailable") {
    super(`Google Play API ${code} (${status})`);
    this.name = "GooglePlayApiError";
  }
}

export type GoogleProductPurchase = Readonly<{
  purchaseState?: number;
  consumptionState?: number;
  acknowledgementState?: number;
  orderId?: string;
  purchaseTimeMillis?: string;
  obfuscatedExternalAccountId?: string;
  purchaseType?: number;
  quantity?: number;
  regionCode?: string;
}>;

export type GoogleSubscriptionV2 = Readonly<{
  subscriptionState?: string;
  latestOrderId?: string;
  startTime?: string;
  acknowledgementState?: string;
  testPurchase?: Record<string, unknown>;
  externalAccountIdentifiers?: Readonly<{ obfuscatedExternalAccountId?: string }>;
  lineItems?: ReadonlyArray<Readonly<{
    productId?: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    autoRenewingPlan?: Readonly<{ autoRenewEnabled?: boolean }>;
  }>>;
}>;

export type GoogleVoidedPurchase = Readonly<{
  purchaseToken?: string;
  orderId?: string;
  voidedTimeMillis?: string;
  voidedReason?: number;
  voidedSource?: number;
}>;

export type GooglePlayApi = Readonly<{
  getProductPurchase(productId: string, token: string): Promise<GoogleProductPurchase>;
  consumeProductPurchase(productId: string, token: string): Promise<void>;
  getSubscription(token: string): Promise<GoogleSubscriptionV2>;
  acknowledgeSubscription(productId: string, token: string): Promise<void>;
  listVoidedPurchases(startTimeMs: number, pageToken?: string): Promise<{
    purchases: GoogleVoidedPurchase[]; nextPageToken: string | null;
  }>;
}>;

export type AccessTokenSource = Readonly<{ getAccessToken(): Promise<string | null> }>;

export function googlePublisherTokenSource(credentialsJsonBase64: string): AccessTokenSource {
  const credentials = credentialsJsonBase64.trim()
    ? JSON.parse(Buffer.from(credentialsJsonBase64, "base64").toString("utf8")) as Record<string, unknown>
    : undefined;
  const auth = new GoogleAuth({ scopes: [ANDROID_PUBLISHER_SCOPE], ...(credentials ? { credentials } : {}) });
  return {
    async getAccessToken() {
      const client = await auth.getClient();
      return (await client.getAccessToken()).token ?? null;
    }
  };
}

export function createGooglePlayApi(options: Readonly<{
  packageName: string;
  auth: AccessTokenSource;
  timeoutMs: number;
  fetch?: typeof fetch;
}>): GooglePlayApi {
  const fetchImpl = options.fetch ?? fetch;
  const base = `${API_ROOT}/${encodeURIComponent(options.packageName)}/purchases`;
  const call = async (method: "GET" | "POST", url: string): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const accessToken = await options.auth.getAccessToken();
      if (!accessToken) throw new GooglePlayApiError(0, "unavailable");
      const response = await fetchImpl(url, {
        method,
        signal: controller.signal,
        redirect: "error",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // 400/404/410: the token is not a purchase of this app.
        throw new GooglePlayApiError(response.status, [400, 404, 410].includes(response.status) ? "invalid" : "unavailable");
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new GooglePlayApiError(response.status, "unavailable");
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (error instanceof GooglePlayApiError) throw error;
      throw new GooglePlayApiError(0, "unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
  const segment = encodeURIComponent;
  return {
    async getProductPurchase(productId, token) {
      return await call("GET", `${base}/products/${segment(productId)}/tokens/${segment(token)}`) as GoogleProductPurchase;
    },
    async consumeProductPurchase(productId, token) {
      await call("POST", `${base}/products/${segment(productId)}/tokens/${segment(token)}:consume`);
    },
    async getSubscription(token) {
      return await call("GET", `${base}/subscriptionsv2/tokens/${segment(token)}`) as GoogleSubscriptionV2;
    },
    async acknowledgeSubscription(productId, token) {
      await call("POST", `${base}/subscriptions/${segment(productId)}/tokens/${segment(token)}:acknowledge`);
    },
    async listVoidedPurchases(startTimeMs, pageToken) {
      const query = new URLSearchParams({ startTime: String(startTimeMs), type: "1", maxResults: "1000" });
      if (pageToken) query.set("token", pageToken);
      const body = await call("GET", `${base}/voidedpurchases?${query}`) as {
        voidedPurchases?: GoogleVoidedPurchase[]; tokenPagination?: { nextPageToken?: string };
      };
      return { purchases: body.voidedPurchases ?? [], nextPageToken: body.tokenPagination?.nextPageToken ?? null };
    }
  };
}

export type GoogleProductFacts = Readonly<{
  transactionId: string;
  purchasedAt: Date;
  environment: PurchaseEnvironment;
  obfuscatedAccountId: string | null;
  consumed: boolean;
}>;

export type GoogleCheck<T> =
  | Readonly<{ ok: true; facts: T }>
  | Readonly<{ ok: false; reason: "pending" | string }>;

/** A one-time product purchase: purchased, real or license-test, quantity one. */
export function checkGoogleProductPurchase(raw: GoogleProductPurchase, token: string): GoogleCheck<GoogleProductFacts> {
  if (raw.purchaseState === 2) return { ok: false, reason: "pending" };
  if (raw.purchaseState !== 0) return { ok: false, reason: "not_purchased" };
  // purchaseType: absent = real, 0 = license test, 1 = promo code, 2 = rewarded ad. Promos mint for free.
  if (raw.purchaseType !== undefined && raw.purchaseType !== 0) return { ok: false, reason: "promo_unsupported" };
  if (raw.quantity !== undefined && raw.quantity !== 1) return { ok: false, reason: "quantity_unsupported" };
  const purchasedMs = Number(raw.purchaseTimeMillis);
  if (!Number.isFinite(purchasedMs) || purchasedMs <= 0) return { ok: false, reason: "incomplete_purchase" };
  return {
    ok: true,
    facts: {
      transactionId: googleTransactionId(raw.orderId, token),
      purchasedAt: new Date(purchasedMs),
      environment: raw.purchaseType === 0 ? "sandbox" : "production",
      obfuscatedAccountId: raw.obfuscatedExternalAccountId?.toLowerCase() ?? null,
      consumed: raw.consumptionState === 1
    }
  };
}

export type GoogleSubscriptionFacts = Readonly<{
  /** Order of the latest paid period, or null when nothing is paid (pending). */
  latestOrderId: string | null;
  productId: string;
  status: AtlasPassStatus;
  paid: boolean;
  expiresAt: Date;
  startedAt: Date | null;
  autoRenew: boolean | null;
  environment: PurchaseEnvironment;
  obfuscatedAccountId: string | null;
  acknowledged: boolean;
}>;

const SUBSCRIPTION_STATES: Readonly<Record<string, { status: AtlasPassStatus; paid: boolean }>> = {
  SUBSCRIPTION_STATE_ACTIVE: { status: "active", paid: true },
  // Cancelled but still inside a paid period.
  SUBSCRIPTION_STATE_CANCELED: { status: "active", paid: true },
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: { status: "grace", paid: false },
  SUBSCRIPTION_STATE_ON_HOLD: { status: "on_hold", paid: false },
  SUBSCRIPTION_STATE_PAUSED: { status: "paused", paid: false },
  SUBSCRIPTION_STATE_EXPIRED: { status: "expired", paid: false }
};

export function checkGoogleSubscription(raw: GoogleSubscriptionV2): GoogleCheck<GoogleSubscriptionFacts> {
  const state = SUBSCRIPTION_STATES[raw.subscriptionState ?? ""];
  if (raw.subscriptionState === "SUBSCRIPTION_STATE_PENDING") return { ok: false, reason: "pending" };
  if (!state) return { ok: false, reason: "not_purchased" };
  const item = raw.lineItems?.[0];
  const expiresMs = Date.parse(item?.expiryTime ?? "");
  if (!item?.productId || !Number.isFinite(expiresMs)) return { ok: false, reason: "incomplete_purchase" };
  const startedMs = Date.parse(raw.startTime ?? "");
  const orderId = item.latestSuccessfulOrderId ?? raw.latestOrderId ?? null;
  // A cancelled subscription past its expiry is simply expired.
  const expired = state.paid && expiresMs <= Date.now() && raw.subscriptionState === "SUBSCRIPTION_STATE_CANCELED";
  return {
    ok: true,
    facts: {
      latestOrderId: orderId,
      productId: item.productId,
      status: expired ? "expired" : state.status,
      paid: state.paid && !expired && orderId !== null,
      expiresAt: new Date(expiresMs),
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs) : null,
      autoRenew: item.autoRenewingPlan?.autoRenewEnabled ?? (raw.subscriptionState === "SUBSCRIPTION_STATE_CANCELED" ? false : null),
      environment: raw.testPurchase ? "sandbox" : "production",
      obfuscatedAccountId: raw.externalAccountIdentifiers?.obfuscatedExternalAccountId?.toLowerCase() ?? null,
      acknowledged: raw.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
    }
  };
}

/** Google order id, or a stable token digest when a test purchase has none. */
export function googleTransactionId(orderId: string | undefined, token: string): string {
  if (orderId && orderId.length <= 240) return orderId;
  return `token:${createHash("sha256").update(token).digest("hex")}`;
}

export type RtdnNotification = Readonly<{
  messageId: string;
  packageName: string;
  eventTimeMs: number;
  oneTime: Readonly<{ type: number; purchaseToken: string; sku: string }> | null;
  subscription: Readonly<{ type: number; purchaseToken: string; subscriptionId: string | null }> | null;
  voided: Readonly<{ purchaseToken: string; orderId: string | null; productType: number | null }> | null;
  test: boolean;
}>;

/** Pub/Sub push envelope → RTDN DeveloperNotification. Null when malformed. */
export function parseRtdnPush(body: unknown): RtdnNotification | null {
  if (!body || typeof body !== "object") return null;
  const message = (body as { message?: { data?: unknown; messageId?: unknown; message_id?: unknown } }).message;
  const messageId = typeof message?.messageId === "string" ? message.messageId
    : typeof message?.message_id === "string" ? message.message_id : null;
  if (!messageId || typeof message?.data !== "string" || message.data.length > 65_536) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(Buffer.from(message.data, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || typeof data.packageName !== "string") return null;
  const record = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : null;
  const str = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
  const oneTime = record(data.oneTimeProductNotification);
  const subscription = record(data.subscriptionNotification);
  const voided = record(data.voidedPurchaseNotification);
  return {
    messageId,
    packageName: data.packageName,
    eventTimeMs: Number(data.eventTimeMillis) || 0,
    oneTime: oneTime && str(oneTime.purchaseToken) && str(oneTime.sku)
      ? { type: Number(oneTime.notificationType), purchaseToken: str(oneTime.purchaseToken)!, sku: str(oneTime.sku)! }
      : null,
    subscription: subscription && str(subscription.purchaseToken)
      ? {
          type: Number(subscription.notificationType),
          purchaseToken: str(subscription.purchaseToken)!,
          subscriptionId: str(subscription.subscriptionId)
        }
      : null,
    voided: voided && str(voided.purchaseToken)
      ? {
          purchaseToken: str(voided.purchaseToken)!,
          orderId: str(voided.orderId),
          productType: typeof voided.productType === "number" ? voided.productType : null
        }
      : null,
    test: Boolean(data.testNotification)
  };
}

export type PushTokenVerifier = (authorization: string | undefined) => Promise<boolean>;

/** Pub/Sub push requests carry an OIDC token signed by Google for our push service account. */
export function createPushTokenVerifier(audience: string, serviceAccount: string): PushTokenVerifier {
  const client = new OAuth2Client();
  return async (authorization) => {
    const match = /^Bearer ([A-Za-z0-9._-]+)$/u.exec(authorization ?? "");
    if (!match) return false;
    try {
      const ticket = await client.verifyIdToken({ idToken: match[1]!, audience });
      const payload = ticket.getPayload();
      return payload?.email === serviceAccount && payload.email_verified === true;
    } catch {
      return false;
    }
  };
}

/** RTDN subscriptionNotification.notificationType 12 = SUBSCRIPTION_REVOKED. */
export const GOOGLE_SUBSCRIPTION_REVOKED = 12;
