import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import type { PremiumCatalog } from "./purchaseCatalog.js";
import type { PurchaseLedger } from "./purchaseLedger.js";
import { registerPurchaseRoutes } from "./purchaseRoutes.js";
import { PurchaseService, type PurchaseConfig } from "./purchaseService.js";
import { XsollaProvider } from "./webPaymentProvider.js";

const TOKEN = "00000000-0000-4000-8000-0000000000b1";
const OFF: PurchaseConfig = {
  PURCHASES_APPLE_ENABLED: false,
  PURCHASES_GOOGLE_ENABLED: false,
  PURCHASES_WEB_ENABLED: false,
  ATLAS_PASS_ENABLED: false,
  SHOP_LINKS_MODE: "off",
  SHOP_WEB_URL: undefined,
  PURCHASES_ACCEPT_SANDBOX: false,
  PURCHASES_APPLE_BUNDLE_ID: "com.ashatlas.game",
  PURCHASES_GOOGLE_PACKAGE_NAME: "com.ashatlas.game",
  PURCHASES_XSOLLA_SANDBOX: false
};

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(config: PurchaseConfig, signedIn: boolean): Promise<FastifyInstance> {
  const ledger = {
    accountForAppAccountToken: async (token: string | null | undefined) => token === TOKEN ? "account-1" : null,
    ensureAppAccountToken: async () => TOKEN
  } as unknown as PurchaseLedger;
  const service = new PurchaseService({
    pool: {} as pg.Pool,
    config,
    ledger,
    catalog: { all: async () => [] } as unknown as PremiumCatalog,
    wallet: { snapshot: async () => { throw new Error("unused"); } },
    apple: null,
    google: null,
    googlePush: null,
    web: config.PURCHASES_WEB_ENABLED
      ? new XsollaProvider({ merchantId: "1", projectId: "2", apiKey: "k", webhookSecret: "secret", returnUrl: undefined, timeoutMs: 1000 })
      : null,
    logger: { info() {}, warn() {}, error() {} }
  });
  const instance = Fastify();
  instance.decorateRequest("authSession", null);
  instance.addHook("preHandler", async (request) => {
    request.authSession = signedIn ? { account: { id: "account-1" } } as never : null;
  });
  registerPurchaseRoutes(instance, service);
  await instance.ready();
  return instance;
}

describe("purchase routes", () => {
  it("answer 404 for every purchase path while flags are off, but still report capabilities", async () => {
    app = await build(OFF, true);
    for (const [method, url, payload] of [
      ["POST", "/api/purchases/preflight", { platform: "apple", sku: "glimmer_pouch" }],
      ["POST", "/api/purchases/apple", { signedTransaction: "aaaaaaaa.bbbbbbbb.cccccccc" }],
      ["POST", "/api/purchases/google", { productId: "com.ashatlas.game.glimmer.pouch", purchaseToken: "token-token-token-1" }],
      ["POST", "/api/purchases/web/checkout", { sku: "glimmer_pouch" }],
      ["GET", "/api/purchases/atlas-pass", undefined],
      ["POST", "/api/purchases/apple/notifications", { signedPayload: "aaaaaaaa.bbbbbbbb.cccccccc" }],
      ["POST", "/api/purchases/google/rtdn", { message: {} }],
      ["POST", "/api/purchases/web/webhook", { notification_type: "user_validation" }]
    ] as const) {
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(response.statusCode, url).toBe(404);
    }
    const capabilities = await app.inject({ method: "GET", url: "/api/purchases/capabilities?platform=ios&storefront=USA" });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toEqual({
      purchases: { apple: false, google: false, web: false },
      path: null,
      atlasPass: false,
      shopLinks: { allowed: false, url: null, reason: "disabled" },
      appAccountToken: null,
      firstPurchaseBonusAvailable: false,
      products: []
    });
  });

  it("requires a session for player routes", async () => {
    app = await build(OFF, false);
    const response = await app.inject({ method: "GET", url: "/api/purchases/capabilities?platform=web" });
    expect(response.statusCode).toBe(401);
  });

  it("accepts a correctly signed Xsolla webhook and denies a forged one", async () => {
    app = await build({ ...OFF, PURCHASES_WEB_ENABLED: true }, false);
    const raw = JSON.stringify({ notification_type: "user_validation", user: { id: TOKEN } });
    const signature = createHash("sha1").update(raw + "secret").digest("hex");
    const allowed = await app.inject({
      method: "POST", url: "/api/purchases/web/webhook", payload: raw,
      headers: { "content-type": "application/json", authorization: `Signature ${signature}` }
    });
    expect(allowed.statusCode).toBe(204);
    const denied = await app.inject({
      method: "POST", url: "/api/purchases/web/webhook", payload: raw,
      headers: { "content-type": "application/json", authorization: `Signature ${"0".repeat(40)}` }
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json()).toMatchObject({ error: { code: "INVALID_SIGNATURE" } });
    const unknownUser = JSON.stringify({ notification_type: "user_validation", user: { id: "someone-else" } });
    const rejected = await app.inject({
      method: "POST", url: "/api/purchases/web/webhook", payload: unknownUser,
      headers: {
        "content-type": "application/json",
        authorization: `Signature ${createHash("sha1").update(unknownUser + "secret").digest("hex")}`
      }
    });
    expect(rejected.json()).toMatchObject({ error: { code: "INVALID_USER" } });
  });
});

describe("Apple verification replies", () => {
  const pouch = {
    sku: "glimmer_pouch", kind: "glimmer_pack", glimmerAmount: 1150n, firstPurchaseBonusGlimmer: 1150n, usdCents: 999,
    period: null, appleProductId: "com.ashatlas.game.glimmer.pouch", googleProductId: "com.ashatlas.game.glimmer.pouch",
    webSku: "glimmer_pouch", active: true
  };
  const service = (payload: Record<string, unknown>) => new PurchaseService({
    pool: {} as pg.Pool,
    config: { ...OFF, PURCHASES_APPLE_ENABLED: true },
    ledger: { ensureAppAccountToken: async () => TOKEN } as unknown as PurchaseLedger,
    catalog: { byStoreProductId: async () => pouch } as unknown as PremiumCatalog,
    wallet: { snapshot: async () => { throw new Error("unused"); } },
    apple: {
      verifyTransaction: async () => ({ payload, environment: "production" as const }),
      verifyNotification: async () => { throw new Error("unused"); },
      verifyRenewalInfo: async () => { throw new Error("unused"); }
    },
    google: null,
    googlePush: null,
    web: null,
    logger: { info() {}, warn() {}, error() {} }
  });
  const transaction = {
    transactionId: "1", originalTransactionId: "1", bundleId: "com.ashatlas.game",
    productId: "com.ashatlas.game.glimmer.pouch", purchaseDate: Date.now(), type: "Consumable",
    appAccountToken: TOKEN, inAppOwnershipType: "PURCHASED"
  };

  it("finishes transactions that can never be granted and keeps account mismatches open", async () => {
    await expect(service({ ...transaction, inAppOwnershipType: "FAMILY_SHARED" }).verifyApple("account-1", "x"))
      .resolves.toMatchObject({ status: "rejected", finishTransaction: true });
    await expect(service({ ...transaction, type: "Non-Consumable" }).verifyApple("account-1", "x"))
      .resolves.toMatchObject({ status: "rejected", finishTransaction: true });
    await expect(service({ ...transaction, type: "Auto-Renewable Subscription", expiresDate: Date.now() + 1 })
      .verifyApple("account-1", "x")).resolves.toMatchObject({ status: "rejected", finishTransaction: true });
    await expect(service({ ...transaction, appAccountToken: "00000000-0000-4000-8000-000000000000" })
      .verifyApple("account-1", "x")).resolves.toMatchObject({ status: "rejected", finishTransaction: false });
  });
});
