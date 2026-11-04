import { z } from "zod";

import type { PremiumWalletSnapshot } from "./premiumCurrency.js";

// Real-money purchase contract (premium-currency-plan.md §5–§7). The server is
// authoritative: it verifies every store transaction, grants exactly once per
// store transaction id, and tells the client which purchase paths exist.
// Every path is off until the first official store release.

export const PURCHASE_PLATFORMS = ["apple", "google", "web"] as const;
export type PurchasePlatform = (typeof PURCHASE_PLATFORMS)[number];

/** Where the client runs; the server maps it to the purchase path it may use. */
export const PURCHASE_CLIENT_PLATFORMS = ["ios", "android", "web"] as const;
export type PurchaseClientPlatform = (typeof PURCHASE_CLIENT_PLATFORMS)[number];

export const GLIMMER_PACK_SKUS = [
  "glimmer_pinch",
  "glimmer_handful",
  "glimmer_pouch",
  "glimmer_satchel",
  "glimmer_chest",
  "glimmer_hoard"
] as const;
export const ATLAS_PASS_SKUS = ["atlas_pass_monthly", "atlas_pass_yearly"] as const;
export const PREMIUM_PRODUCT_SKUS = [...GLIMMER_PACK_SKUS, ...ATLAS_PASS_SKUS] as const;
export type GlimmerPackSku = (typeof GLIMMER_PACK_SKUS)[number];
export type AtlasPassSku = (typeof ATLAS_PASS_SKUS)[number];
export type PremiumProductSku = (typeof PREMIUM_PRODUCT_SKUS)[number];

export type PremiumProductKind = "glimmer_pack" | "atlas_pass";

/** Atlas Pass Lumen: once per account ever, then per subscribed UTC day. */
export const ATLAS_PASS_FIRST_LUMEN = 120;
export const ATLAS_PASS_DAILY_LUMEN = 12;

export type PremiumProductView = Readonly<{
  sku: PremiumProductSku;
  kind: PremiumProductKind;
  /** Glimmer credited by a pack (0 for the pass). */
  glimmer: number;
  /** Extra Glimmer the first eligible pack on this account would add. */
  firstPurchaseBonusGlimmer: number;
  usdCents: number;
  /** Subscription period for the pass, null for packs. */
  period: "month" | "year" | null;
  appleProductId: string;
  googleProductId: string;
  webSku: string;
}>;

/**
 * In-app links to the web shop (plan §7.3). Only storefronts where a plain link
 * is allowed without a store program are listed; everything else is denied.
 */
export const SHOP_LINK_ALLOWED_STOREFRONTS: Readonly<Record<"ios" | "android", readonly string[]>> = {
  ios: ["US"],
  android: ["US"]
};

export type ShopLinkCapability = Readonly<{
  allowed: boolean;
  url: string | null;
  /** Why links are on or off; diagnostic only, never shown verbatim. */
  reason: "disabled" | "no_url" | "web_client" | "storefront_allowed" | "storefront_denied" | "storefront_unknown";
}>;

export type PurchaseCapabilitiesResponse = Readonly<{
  purchases: Readonly<Record<PurchasePlatform, boolean>>;
  /** The purchase path this client should use, or null when none is open. */
  path: PurchasePlatform | null;
  atlasPass: boolean;
  shopLinks: ShopLinkCapability;
  /**
   * UUID bound to the account. iOS passes it as StoreKit appAccountToken and
   * Android as the obfuscated account id; the server rejects any other value.
   * Null while no store path is open.
   */
  appAccountToken: string | null;
  firstPurchaseBonusAvailable: boolean;
  products: readonly PremiumProductView[];
}>;

const storefrontSchema = z.string().trim().regex(/^[A-Za-z]{2,3}$/u);

export const purchaseCapabilitiesQuerySchema = z.object({
  platform: z.enum(PURCHASE_CLIENT_PLATFORMS),
  /** Store storefront country (Apple alpha-3, Google alpha-2). */
  storefront: storefrontSchema.optional()
}).strict();
export type PurchaseCapabilitiesQuery = z.infer<typeof purchaseCapabilitiesQuerySchema>;

export const purchasePreflightRequestSchema = z.object({
  platform: z.enum(PURCHASE_PLATFORMS),
  sku: z.enum(PREMIUM_PRODUCT_SKUS)
}).strict();
export type PurchasePreflightRequest = z.infer<typeof purchasePreflightRequestSchema>;

export const PURCHASE_DENIAL_REASONS = [
  "platform_disabled",
  "product_unavailable",
  "atlas_pass_disabled",
  "atlas_pass_active",
  "new_account_limit",
  "daily_limit",
  "refund_limit"
] as const;
export type PurchaseDenialReason = (typeof PURCHASE_DENIAL_REASONS)[number];

export type PurchasePreflightResponse = Readonly<
  | { allowed: true; appAccountToken: string }
  | { allowed: false; reason: PurchaseDenialReason }
>;

export const appleVerifyRequestSchema = z.object({
  /** StoreKit 2 `Transaction.jwsRepresentation`. */
  signedTransaction: z.string().min(16).max(32_768).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
}).strict();
export type AppleVerifyRequest = z.infer<typeof appleVerifyRequestSchema>;

export const googleVerifyRequestSchema = z.object({
  productId: z.string().min(1).max(150).regex(/^[a-z0-9._]+$/u),
  purchaseToken: z.string().min(16).max(4096).regex(/^[A-Za-z0-9._:-]+$/u)
}).strict();
export type GoogleVerifyRequest = z.infer<typeof googleVerifyRequestSchema>;

export const webCheckoutRequestSchema = z.object({
  sku: z.enum(PREMIUM_PRODUCT_SKUS)
}).strict();
export type WebCheckoutRequest = z.infer<typeof webCheckoutRequestSchema>;

export type WebCheckoutResponse = Readonly<{
  provider: "xsolla";
  checkoutId: string;
  /** Hosted checkout to open; grants arrive only through the provider webhook. */
  checkoutUrl: string;
  sandbox: boolean;
}>;

export type AtlasPassStatus = "active" | "grace" | "on_hold" | "paused" | "expired" | "revoked";

export type AtlasPassEntitlement = Readonly<{
  active: boolean;
  status: AtlasPassStatus | "none";
  platform: PurchasePlatform | null;
  sku: AtlasPassSku | null;
  /** ISO timestamp; perks last until this instant (grace included). */
  activeUntil: string | null;
  autoRenew: boolean | null;
  /** Lumen credited to inventory by this request (accrued days). */
  lumenCredited: number;
}>;

/**
 * Outcome of a store verification. `granted` and `already_granted` mean the
 * client must now finish (Apple) the transaction; `pending` means wait for the
 * store; `rejected` means never grant (Google refunds unacknowledged buys).
 */
export type PurchaseVerifyStatus = "granted" | "already_granted" | "pending" | "rejected";

export type PurchaseVerifyResponse = Readonly<{
  status: PurchaseVerifyStatus;
  purchaseId: string | null;
  sku: PremiumProductSku | null;
  glimmerGranted: number;
  finishTransaction: boolean;
  wallet: PremiumWalletSnapshot | null;
  atlasPass: AtlasPassEntitlement | null;
}>;
