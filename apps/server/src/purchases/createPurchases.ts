import type pg from "pg";

import type { AppConfig } from "../config.js";
import type { InventoryService } from "../game/inventory.js";
import type { PremiumWalletService } from "../game/premiumWallet.js";
import type { AppLogger } from "../logger.js";
import { createAppleVerifier, parseAppleRootCertificates } from "./appleStore.js";
import { createGooglePlayApi, createPushTokenVerifier, googlePublisherTokenSource } from "./googlePlay.js";
import { PremiumCatalog } from "./purchaseCatalog.js";
import { PurchaseLedger } from "./purchaseLedger.js";
import { PurchaseService } from "./purchaseService.js";
import { XsollaProvider } from "./webPaymentProvider.js";

/** Builds the purchase service; store clients exist only for enabled paths. */
export function createPurchaseService(
  pool: pg.Pool,
  config: AppConfig,
  logger: AppLogger,
  services: Readonly<{ wallet: PremiumWalletService; inventory: InventoryService }>
): PurchaseService {
  const apple = config.PURCHASES_APPLE_ENABLED
    ? createAppleVerifier({
        rootCertificates: parseAppleRootCertificates(config.PURCHASES_APPLE_ROOT_CERTS_BASE64),
        bundleId: config.PURCHASES_APPLE_BUNDLE_ID,
        appAppleId: config.PURCHASES_APPLE_APP_APPLE_ID ? Number(config.PURCHASES_APPLE_APP_APPLE_ID) : undefined,
        acceptSandbox: config.PURCHASES_ACCEPT_SANDBOX,
        onlineChecks: config.PURCHASES_APPLE_ONLINE_CHECKS
      })
    : null;
  const google = config.PURCHASES_GOOGLE_ENABLED
    ? createGooglePlayApi({
        packageName: config.PURCHASES_GOOGLE_PACKAGE_NAME,
        auth: googlePublisherTokenSource(config.PURCHASES_GOOGLE_CREDENTIALS_JSON_BASE64),
        timeoutMs: config.PURCHASES_STORE_TIMEOUT_MS
      })
    : null;
  const web = config.PURCHASES_WEB_ENABLED
    ? new XsollaProvider({
        merchantId: config.PURCHASES_XSOLLA_MERCHANT_ID,
        projectId: config.PURCHASES_XSOLLA_PROJECT_ID,
        apiKey: config.PURCHASES_XSOLLA_API_KEY,
        webhookSecret: config.PURCHASES_XSOLLA_WEBHOOK_SECRET,
        returnUrl: config.PURCHASES_XSOLLA_RETURN_URL,
        timeoutMs: config.PURCHASES_STORE_TIMEOUT_MS
      })
    : null;
  return new PurchaseService({
    pool,
    config,
    ledger: new PurchaseLedger(pool, services),
    catalog: new PremiumCatalog(pool),
    wallet: services.wallet,
    apple,
    google,
    googlePush: google
      ? createPushTokenVerifier(config.PURCHASES_GOOGLE_RTDN_AUDIENCE, config.PURCHASES_GOOGLE_RTDN_SERVICE_ACCOUNT)
      : null,
    web,
    logger
  });
}

/** Periodic Google voided-purchase sweep and acknowledge retry; a no-op while Google is off. */
export function createGooglePurchaseMaintenance(
  service: PurchaseService,
  intervalMinutes: number,
  logger: AppLogger
): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await service.runGoogleMaintenance();
      if (result.voided > 0 || result.acknowledged > 0) logger.info(result, "google purchase maintenance");
    } catch (error) {
      logger.warn({ err: error }, "google purchase maintenance failed");
    } finally {
      running = false;
    }
  };
  return {
    start() {
      if (timer || !service.enabled("google")) return;
      timer = setInterval(() => void tick(), intervalMinutes * 60_000);
      timer.unref();
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
