import type {
  AtlasPassEntitlement,
  PurchaseCapabilitiesResponse,
  PurchaseClientPlatform,
  PurchasePlatform,
  PurchasePreflightResponse,
  PurchaseVerifyResponse,
  PremiumProductSku,
  WebCheckoutResponse
} from "@ash-atlas/shared";

export class PurchaseApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "PurchaseApiError";
  }
}

/** The slice of the purchase API the flow and the hook depend on (mockable). */
export type PurchaseApiPort = Readonly<{
  capabilities(platform: PurchaseClientPlatform, storefront?: string): Promise<PurchaseCapabilitiesResponse>;
  preflight(platform: PurchasePlatform, sku: PremiumProductSku): Promise<PurchasePreflightResponse>;
  verifyApple(signedTransaction: string): Promise<PurchaseVerifyResponse>;
  verifyGoogle(productId: string, purchaseToken: string): Promise<PurchaseVerifyResponse>;
  webCheckout(sku: PremiumProductSku): Promise<WebCheckoutResponse>;
  /** Also credits accrued daily Lumen. Resolves null when Atlas Pass is off (404). */
  atlasPass(): Promise<AtlasPassEntitlement | null>;
}>;

export function createPurchaseApi(
  serverHttpBase: string,
  csrfToken: string | undefined,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
): PurchaseApiPort {
  async function call<T>(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
    allowNotFound = false
  ): Promise<T | null> {
    let response: Response;
    try {
      response = await fetcher(new URL(path, serverHttpBase), {
        method: init.method,
        credentials: "include",
        cache: "no-store",
        headers: {
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.method === "POST" && csrfToken ? { "x-csrf-token": csrfToken } : {})
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
      });
    } catch {
      throw new PurchaseApiError("Could not reach the server", 0, null);
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      let code: string | null = null;
      let message = "The purchase service is unavailable";
      try {
        const payload = await response.json() as { error?: { code?: unknown; message?: unknown } };
        if (typeof payload.error?.code === "string") code = payload.error.code;
        if (typeof payload.error?.message === "string") message = payload.error.message;
      } catch { /* keep the generic message */ }
      throw new PurchaseApiError(message, response.status, code);
    }
    return await response.json() as T;
  }
  const required = async <T>(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<T> =>
    (await call<T>(path, init)) as T;
  return {
    capabilities: (platform, storefront) => required<PurchaseCapabilitiesResponse>(
      `/api/purchases/capabilities?${new URLSearchParams({ platform, ...(storefront ? { storefront } : {}) })}`,
      { method: "GET" }),
    preflight: (platform, sku) =>
      required<PurchasePreflightResponse>("/api/purchases/preflight", { method: "POST", body: { platform, sku } }),
    verifyApple: (signedTransaction) =>
      required<PurchaseVerifyResponse>("/api/purchases/apple", { method: "POST", body: { signedTransaction } }),
    verifyGoogle: (productId, purchaseToken) =>
      required<PurchaseVerifyResponse>("/api/purchases/google", { method: "POST", body: { productId, purchaseToken } }),
    webCheckout: (sku) =>
      required<WebCheckoutResponse>("/api/purchases/web/checkout", { method: "POST", body: { sku } }),
    atlasPass: () => call<AtlasPassEntitlement>("/api/purchases/atlas-pass", { method: "GET" }, true)
  };
}
