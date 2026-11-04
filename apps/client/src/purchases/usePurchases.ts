import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import type {
  AtlasPassEntitlement,
  PremiumProductSku,
  PremiumWalletSnapshot,
  PurchaseCapabilitiesResponse,
  PurchaseClientPlatform,
  PurchaseDenialReason
} from "@ash-atlas/shared";

import { isNativeApp, nativePlatform, subscribeNativeAppStateChange } from "../native/nativeApp.js";
import { Purchases, purchasesAvailable, type StoreProduct } from "../native/nativePurchases.js";
import { createPurchaseApi, type PurchaseApiPort } from "./purchaseApi.js";
import {
  buyStoreProduct,
  createPurchaseSettler,
  handleTransactionUpdate,
  reconcileUnfinished,
  restoreStorePurchases,
  type PurchaseFlowDeps,
  type RestoreSummary,
  type SettleOutcome
} from "./purchaseFlow.js";

export type StoreOffer = Readonly<{ price: string; productId: string; offerToken?: string }>;

export type PurchasesController = Readonly<{
  /** Null until the first capabilities answer; every flag off means nothing is shown. */
  capabilities: PurchaseCapabilitiesResponse | null;
  /** "Get Glimmer" entry points render only when this is true. */
  shopEnabled: boolean;
  passEnabled: boolean;
  /** True when this client can run a checkout itself (store plugin present, or web path). */
  canCheckout: boolean;
  native: boolean;
  offers: Readonly<Partial<Record<PremiumProductSku, StoreOffer>>>;
  offersLoading: boolean;
  busySku: PremiumProductSku | null;
  restoring: boolean;
  notice: string | null;
  checkoutUrl: string | null;
  pass: AtlasPassEntitlement | null;
  passLoading: boolean;
  view: "shop" | "pass" | null;
  open(view: "shop" | "pass"): void;
  close(): void;
  buy(sku: PremiumProductSku): Promise<void>;
  restore(): Promise<void>;
  manageSubscription(): Promise<void>;
}>;

const DENIAL_TEXT: Readonly<Record<PurchaseDenialReason, string>> = {
  platform_disabled: "Purchases are not available right now.",
  product_unavailable: "That item is not available right now.",
  atlas_pass_disabled: "Atlas Pass is not available right now.",
  atlas_pass_active: "Atlas Pass is already active on this account.",
  new_account_limit: "New accounts have a purchase limit. Try again later.",
  daily_limit: "Daily purchase limit reached. Try again tomorrow.",
  refund_limit: "Purchases are paused on this account. Contact support."
};

function clientPlatform(): PurchaseClientPlatform {
  return nativePlatform() ?? "web";
}

/** Localized store price, straight from the store (never hardcoded). */
export function storeOfferFor(product: StoreProduct): StoreOffer | null {
  if (product.platform === "ios") return { price: product.displayPrice, productId: product.id };
  if (product.oneTimePurchaseOffer) {
    return { price: product.oneTimePurchaseOffer.formattedPrice, productId: product.id };
  }
  const offers = product.subscriptionOffers ?? [];
  const offer = offers.find((entry) => !entry.offerId) ?? offers[0];
  const phase = offer?.pricingPhases[offer.pricingPhases.length - 1];
  return offer && phase ? { price: phase.formattedPrice, productId: product.id, offerToken: offer.offerToken } : null;
}

function summaryNotice(summary: RestoreSummary): string {
  if (summary.error) return "Could not restore purchases. Try again.";
  if (summary.granted > 0) return "Purchases restored.";
  if (summary.pending > 0) return "A purchase is waiting for approval from the store.";
  if (summary.failed > 0) return "Some purchases could not be verified yet. Try again soon.";
  return "Nothing to restore.";
}

function grantedNotice(outcome: Extract<SettleOutcome, { kind: "granted" }>): string {
  if (outcome.glimmerGranted > 0) return `Added ${outcome.glimmerGranted.toLocaleString()} Glimmer.`;
  return outcome.atlasPass?.active ? "Atlas Pass is active." : "Purchase complete.";
}

export function usePurchases({
  serverHttpBase,
  csrfToken,
  onWallet,
  api: injectedApi
}: Readonly<{
  serverHttpBase: string;
  csrfToken: string | undefined;
  onWallet?(snapshot: PremiumWalletSnapshot): void;
  api?: PurchaseApiPort;
}>): PurchasesController {
  const api = useMemo(
    () => injectedApi ?? createPurchaseApi(serverHttpBase, csrfToken),
    [injectedApi, serverHttpBase, csrfToken]
  );
  const [capabilities, setCapabilities] = useState<PurchaseCapabilitiesResponse | null>(null);
  const [offers, setOffers] = useState<Partial<Record<PremiumProductSku, StoreOffer>>>({});
  const [offersLoading, setOffersLoading] = useState(false);
  const [busySku, setBusySku] = useState<PremiumProductSku | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [pass, setPass] = useState<AtlasPassEntitlement | null>(null);
  const [passLoading, setPassLoading] = useState(false);
  const [view, setView] = useState<"shop" | "pass" | null>(null);
  const onWalletRef = useRef(onWallet);
  onWalletRef.current = onWallet;

  const native = isNativeApp();
  const storeAvailable = native && purchasesAvailable();
  const path = capabilities?.path ?? null;
  const storePath = path === "apple" || path === "google";
  const canCheckout = path === "web" || (storePath && storeAvailable);

  const flowDeps = useMemo<PurchaseFlowDeps | null>(() => {
    const platform = nativePlatform();
    return platform && storeAvailable ? { platform, plugin: Purchases, api } : null;
  }, [api, storeAvailable]);
  const settle = useMemo(() => (flowDeps ? createPurchaseSettler(flowDeps) : null), [flowDeps]);

  const applyOutcome = useCallback((outcome: SettleOutcome): string | null => {
    if (outcome.kind === "granted") {
      if (outcome.wallet) onWalletRef.current?.(outcome.wallet);
      if (outcome.atlasPass) setPass(outcome.atlasPass);
      return grantedNotice(outcome);
    }
    if (outcome.kind === "pending") return "Waiting for the store to approve this purchase. It will be added when approved.";
    if (outcome.kind === "rejected") return "The store could not confirm this purchase.";
    return outcome.message;
  }, []);

  // Session start: capabilities (+ storefront on native), then the pass accrual call.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let storefront: string | undefined;
      if (storeAvailable) {
        try { storefront = (await Purchases.getStorefront()).countryCode; } catch { /* storefront is optional */ }
      }
      try {
        const next = await api.capabilities(clientPlatform(), storefront);
        if (cancelled) return;
        setCapabilities(next);
        if (next.atlasPass) {
          const entitlement = await api.atlasPass().catch(() => null);
          if (!cancelled && entitlement) setPass(entitlement);
        }
      } catch {
        // Unreachable or older server: stay hidden.
      }
    })();
    return () => { cancelled = true; };
  }, [api, storeAvailable]);

  // Localized store prices on native shells.
  useEffect(() => {
    if (!capabilities || !storePath || !storeAvailable) return;
    let cancelled = false;
    const ids = capabilities.products.map((product) => path === "apple" ? product.appleProductId : product.googleProductId);
    setOffersLoading(true);
    void Purchases.getProducts({ productIds: ids }).then(({ products }) => {
      if (cancelled) return;
      const next: Partial<Record<PremiumProductSku, StoreOffer>> = {};
      for (const product of capabilities.products) {
        const id = path === "apple" ? product.appleProductId : product.googleProductId;
        const found = products.find((entry) => entry.id === id);
        const offer = found ? storeOfferFor(found) : null;
        if (offer) next[product.sku] = offer;
      }
      setOffers(next);
    }).catch(() => undefined).finally(() => { if (!cancelled) setOffersLoading(false); });
    return () => { cancelled = true; };
  }, [capabilities, path, storePath, storeAvailable]);

  // Startup replay of unfinished transactions plus the long-lived transaction listener.
  useEffect(() => {
    if (!flowDeps || !settle || !storePath) return;
    let cancelled = false;
    let handle: PluginListenerHandle | null = null;
    const report = (outcome: SettleOutcome): void => {
      if (cancelled) return;
      const text = applyOutcome(outcome);
      if (text && outcome.kind === "granted" && !outcome.alreadyGranted) setNotice(text);
    };
    const replay = (): void => {
      void reconcileUnfinished(flowDeps, settle).then((summary) => {
        if (!cancelled) summary.outcomes.forEach((outcome) => { if (outcome.kind === "granted") applyOutcome(outcome); });
      });
    };
    void Purchases.addListener("transactionUpdated", (update) => {
      void handleTransactionUpdate(settle, update).then(report);
    }).then((next) => {
      if (cancelled) void next.remove(); else handle = next;
    }).catch(() => undefined);
    replay();
    const unsubscribe = subscribeNativeAppStateChange((active) => { if (active) replay(); });
    return () => {
      cancelled = true;
      unsubscribe();
      if (handle) void handle.remove();
    };
  }, [flowDeps, settle, storePath, applyOutcome]);

  const refreshPass = useCallback(async (): Promise<void> => {
    setPassLoading(true);
    try {
      const entitlement = await api.atlasPass();
      if (entitlement) setPass(entitlement);
    } catch { /* keep the last known status */ } finally {
      setPassLoading(false);
    }
  }, [api]);

  const open = useCallback((next: "shop" | "pass"): void => {
    setNotice(null);
    setCheckoutUrl(null);
    setView(next);
    if (next === "pass") void refreshPass();
  }, [refreshPass]);

  const buy = useCallback(async (sku: PremiumProductSku): Promise<void> => {
    if (busySku) return;
    setNotice(null);
    setCheckoutUrl(null);
    setBusySku(sku);
    try {
      if (path === "web") {
        const checkout = await api.webCheckout(sku);
        setCheckoutUrl(checkout.checkoutUrl);
        window.open(checkout.checkoutUrl, "_blank", "noopener,noreferrer");
        setNotice(checkout.sandbox ? "Test checkout opened." : "Checkout opened in a new tab. Glimmer arrives when payment completes.");
        return;
      }
      const product = capabilities?.products.find((entry) => entry.sku === sku);
      const offer = offers[sku];
      if (!flowDeps || !settle || !product || !offer) {
        setNotice("The store is not available right now.");
        return;
      }
      const outcome = await buyStoreProduct(flowDeps, settle, {
        sku,
        productId: offer.productId,
        ...(offer.offerToken ? { offerToken: offer.offerToken } : {})
      });
      if (outcome.kind === "cancelled") return;
      if (outcome.kind === "denied") setNotice(DENIAL_TEXT[outcome.reason]);
      else if (outcome.kind === "already_owned") {
        const summary = await reconcileUnfinished(flowDeps, settle);
        summary.outcomes.forEach((entry) => { if (entry.kind === "granted") applyOutcome(entry); });
        setNotice(summary.granted > 0 ? "Purchase restored." : "You already own this. Try Restore purchases.");
      } else setNotice(applyOutcome(outcome));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The purchase could not be completed.");
    } finally {
      setBusySku(null);
    }
  }, [api, applyOutcome, busySku, capabilities, flowDeps, offers, path, settle]);

  const restore = useCallback(async (): Promise<void> => {
    if (!flowDeps || !settle || restoring) return;
    setRestoring(true);
    setNotice(null);
    try {
      const summary = await restoreStorePurchases(flowDeps, settle);
      summary.outcomes.forEach((outcome) => { if (outcome.kind === "granted") applyOutcome(outcome); });
      setNotice(summaryNotice(summary));
      void refreshPass();
    } finally {
      setRestoring(false);
    }
  }, [applyOutcome, flowDeps, refreshPass, restoring, settle]);

  const manageSubscription = useCallback(async (): Promise<void> => {
    if (flowDeps) {
      try { await Purchases.manageSubscriptions(); } catch { setNotice("Could not open subscription settings."); }
      return;
    }
    // Web: the provider's receipt/manage page is reached from the checkout email; point at support.
    setNotice("Manage your subscription from the store account that bought it.");
  }, [flowDeps]);

  const hasPacks = Boolean(capabilities?.products.some((product) => product.kind === "glimmer_pack"));
  const shopLinkAllowed = Boolean(capabilities?.shopLinks.allowed && capabilities.shopLinks.url);
  const shopEnabled = (canCheckout && hasPacks) || shopLinkAllowed;
  const passEnabled = Boolean(capabilities?.atlasPass) &&
    Boolean(capabilities?.products.some((product) => product.kind === "atlas_pass"));

  return {
    capabilities, shopEnabled, passEnabled, canCheckout, native, offers, offersLoading, busySku, restoring,
    notice, checkoutUrl, pass, passLoading, view, open, close: () => setView(null), buy, restore, manageSubscription
  };
}
