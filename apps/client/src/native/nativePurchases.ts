import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Store-faithful bridge to the native "Purchases" plugin (iOS StoreKit 2,
 * Android Play Billing Library 8). Shapes mirror each store's own objects; the
 * server verifies them and is the only authority that grants anything.
 * Shells older than the store build that added this plugin reject every call
 * with UNIMPLEMENTED, so callers must feature-detect with `purchasesAvailable()`.
 *
 * Lifecycle: purchase -> send to server -> server confirms the grant ->
 * finishTransaction (iOS) / acknowledgePurchase or consumePurchase (Android).
 * Never finish/acknowledge/consume before the server confirmed.
 */

export type StorePlatform = "ios" | "android";

/** Rejection codes set by the native plugin (PluginCall error `code`). */
export type PurchaseErrorCode =
  | "INVALID_ARGUMENT"
  | "PRODUCT_NOT_FOUND"
  | "PURCHASE_IN_PROGRESS"
  | "PURCHASE_UNAVAILABLE"
  | "PURCHASE_INTERRUPTED"
  | "USER_CANCELLED"
  | "ITEM_ALREADY_OWNED"
  | "ITEM_NOT_OWNED"
  | "BILLING_UNAVAILABLE"
  | "FEATURE_NOT_SUPPORTED"
  | "STORE_UNAVAILABLE"
  | "DEVELOPER_ERROR"
  | "BILLING_ERROR"
  | "UNAVAILABLE"
  | "UNIMPLEMENTED";

// ---- iOS (StoreKit 2) ------------------------------------------------------------------------

export type IosSubscriptionPeriod = Readonly<{ unit: "day" | "week" | "month" | "year" | "unknown"; value: number }>;

export type IosSubscriptionOffer = Readonly<{
  id?: string;
  displayPrice: string;
  /** Decimal string, e.g. "9.99". */
  price: string;
  period: IosSubscriptionPeriod;
  periodCount: number;
  paymentMode: "freeTrial" | "payAsYouGo" | "payUpFront" | "unknown";
}>;

export type IosProduct = Readonly<{
  platform: "ios";
  id: string;
  type: "consumable" | "nonConsumable" | "autoRenewable" | "nonRenewable" | "unknown";
  displayName: string;
  description: string;
  displayPrice: string;
  /** Decimal string, e.g. "9.99". */
  price: string;
  currencyCode: string;
  isFamilyShareable: boolean;
  subscription?: Readonly<{
    subscriptionGroupId: string;
    subscriptionPeriod: IosSubscriptionPeriod;
    introductoryOffer?: IosSubscriptionOffer;
  }>;
}>;

export type IosTransaction = Readonly<{
  /** Signed transaction (JWS) for server-side verification. */
  jws: string;
  /** Device-local verification result only; the server must verify `jws`. */
  verified: boolean;
  verificationError?: string;
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  productType: IosProduct["type"];
  /** Lower-case UUID passed to `purchase`. */
  appAccountToken?: string;
  /** Epoch milliseconds. */
  purchaseDate: number;
  originalPurchaseDate: number;
  expirationDate?: number;
  revocationDate?: number;
  revocationReason?: "developerIssue" | "other";
  purchasedQuantity: number;
  isUpgraded: boolean;
  ownershipType: "purchased" | "familyShared";
  subscriptionGroupId?: string;
  webOrderLineItemId?: string;
  /** "Production" | "Sandbox" | "Xcode" (iOS 16+ only). */
  environment?: string;
}>;

// ---- Android (Play Billing 8) ----------------------------------------------------------------

export type AndroidPricingPhase = Readonly<{
  formattedPrice: string;
  /** Integer micros as a decimal string. */
  priceAmountMicros: string;
  priceCurrencyCode: string;
  /** ISO 8601 period, e.g. "P1M". */
  billingPeriod: string;
  billingCycleCount: number;
  /** 1 infinite, 2 finite, 3 non-recurring. */
  recurrenceMode: number;
}>;

export type AndroidProduct = Readonly<{
  platform: "android";
  id: string;
  type: "inapp" | "subs";
  name: string;
  title: string;
  description: string;
  oneTimePurchaseOffer?: Readonly<{ formattedPrice: string; priceAmountMicros: string; priceCurrencyCode: string }>;
  subscriptionOffers?: readonly Readonly<{
    basePlanId: string;
    offerId?: string | null;
    offerToken: string;
    offerTags: readonly string[];
    pricingPhases: readonly AndroidPricingPhase[];
  }>[];
}>;

export type AndroidPurchase = Readonly<{
  purchaseToken: string;
  /** Absent while the purchase is pending. */
  orderId?: string | null;
  productIds: readonly string[];
  purchaseState: "purchased" | "pending" | "unspecified";
  /** Epoch milliseconds. */
  purchaseTime: number;
  quantity: number;
  isAcknowledged: boolean;
  isAutoRenewing: boolean;
  packageName: string;
  /** Lower-case UUID passed to `purchase` as appAccountToken. */
  obfuscatedAccountId?: string | null;
  originalJson: string;
  signature: string;
}>;

// ---- Plugin contract -------------------------------------------------------------------------

export type StoreProduct = IosProduct | AndroidProduct;

export type PurchaseOptions = Readonly<{
  productId: string;
  /** UUID binding the store purchase to the account (server-issued). */
  appAccountToken: string;
  /** Android only: subscription/one-time offer token from getProducts; defaults to the base plan. */
  offerToken?: string;
}>;

export type PurchaseResult =
  | Readonly<{ platform: "ios"; status: "purchased"; transaction: IosTransaction }>
  | Readonly<{ platform: "ios"; status: "pending" | "cancelled" }>
  | Readonly<{ platform: "android"; status: "purchased" | "pending"; purchase: AndroidPurchase }>
  | Readonly<{ platform: "android"; status: "cancelled" }>;

export type OwnedPurchases =
  | Readonly<{ platform: "ios"; status?: "restored" | "cancelled"; transactions: readonly IosTransaction[] }>
  | Readonly<{ platform: "android"; purchases: readonly AndroidPurchase[] }>;

export type TransactionUpdate =
  | Readonly<{ platform: "ios"; transaction: IosTransaction }>
  | Readonly<{ platform: "android"; purchase: AndroidPurchase }>;

export type Storefront = Readonly<{
  platform: StorePlatform;
  /** iOS: ISO 3166-1 alpha-3 ("USA"). Android: ISO 3166-1 alpha-2 ("US"). */
  countryCode: string;
  /** iOS storefront id. */
  id?: string;
}>;

export interface PurchasesPlugin {
  isAvailable(): Promise<{ available: boolean; subscriptions: boolean }>;
  getProducts(options: { productIds: string[] }): Promise<{ products: StoreProduct[]; invalidProductIds: string[] }>;
  purchase(options: PurchaseOptions): Promise<PurchaseResult>;
  /** iOS only, after the server confirmed the grant. `finished: false` when it was already finished. */
  finishTransaction(options: { transactionId: string }): Promise<{ finished: boolean }>;
  /** Android only (subscriptions and non-consumables), after the server confirmed the grant. */
  acknowledgePurchase(options: { purchaseToken: string }): Promise<void>;
  /** Android only (consumables), after the server confirmed the grant. */
  consumePurchase(options: { purchaseToken: string }): Promise<void>;
  /** iOS: AppStore.sync() (may prompt sign-in; user action only). Android: owned purchases. */
  restorePurchases(): Promise<OwnedPurchases>;
  currentEntitlements(): Promise<OwnedPurchases>;
  /** Paid but not yet finished/acknowledged: replay these to the server on launch/resume. */
  unfinishedTransactions(): Promise<OwnedPurchases>;
  getStorefront(): Promise<Storefront>;
  manageSubscriptions(options?: { productId?: string }): Promise<void>;
  /** Ask to Buy approvals, renewals, refunds, pending -> purchased. Retained until a listener exists. */
  addListener(eventName: "transactionUpdated", listener: (update: TransactionUpdate) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const Purchases = registerPlugin<PurchasesPlugin>("Purchases");

/** True only inside a native shell whose binary contains the Purchases plugin. */
export function purchasesAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Purchases");
}
