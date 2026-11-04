import type { PurchaseVerifyResponse } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import type { AndroidPurchase, IosTransaction } from "../native/nativePurchases.js";
import {
  buyStoreProduct,
  createPurchaseSettler,
  handleTransactionUpdate,
  reconcileUnfinished,
  restoreStorePurchases,
  type PurchaseFlowDeps
} from "./purchaseFlow.js";

const iosTransaction = { jws: "a.b.c", transactionId: "t1", productId: "p" } as unknown as IosTransaction;
const androidPurchase = (over: Partial<AndroidPurchase> = {}): AndroidPurchase => ({
  purchaseToken: "tok-1234567890abcdef", productIds: ["glimmer_pinch"], purchaseState: "purchased",
  isAcknowledged: false, ...over
}) as AndroidPurchase;

function verify(over: Partial<PurchaseVerifyResponse> = {}): PurchaseVerifyResponse {
  return {
    status: "granted", purchaseId: "x", sku: "glimmer_pinch", glimmerGranted: 100, finishTransaction: true,
    wallet: null, atlasPass: null, ...over
  };
}

function setup(platform: "ios" | "android", response: PurchaseVerifyResponse | Error = verify()) {
  const calls: string[] = [];
  const verifyFn = vi.fn(async () => {
    calls.push("verify");
    if (response instanceof Error) throw response;
    return response;
  });
  const deps: PurchaseFlowDeps = {
    platform,
    api: {
      preflight: vi.fn(async () => ({ allowed: true as const, appAccountToken: "uuid" })),
      verifyApple: verifyFn,
      verifyGoogle: verifyFn
    },
    plugin: {
      purchase: vi.fn(),
      finishTransaction: vi.fn(async () => { calls.push("finish"); return { finished: true }; }),
      acknowledgePurchase: vi.fn(async () => { calls.push("acknowledge"); }),
      consumePurchase: vi.fn(async () => { calls.push("consume"); }),
      restorePurchases: vi.fn(),
      unfinishedTransactions: vi.fn()
    } as unknown as PurchaseFlowDeps["plugin"]
  };
  return { deps, calls, settle: createPurchaseSettler(deps) };
}

describe("native purchase flow", () => {
  it("grants on the server before finishing on iOS", async () => {
    const { settle, calls } = setup("ios");
    expect(await settle(iosTransaction)).toMatchObject({ kind: "granted", glimmerGranted: 100 });
    expect(calls).toEqual(["verify", "finish"]);
  });

  it("consumes Android packs and acknowledges the pass only after the server grant", async () => {
    const pack = setup("android");
    await pack.settle(androidPurchase());
    expect(pack.calls).toEqual(["verify", "consume"]);
    const pass = setup("android", verify({ sku: "atlas_pass_monthly", glimmerGranted: 0 }));
    await pass.settle(androidPurchase({ productIds: ["atlas_pass_monthly"] }));
    expect(pass.calls).toEqual(["verify", "acknowledge"]);
  });

  it("never finishes when the server is unreachable, rejects, or reports pending", async () => {
    for (const response of [new Error("offline"), verify({ status: "rejected", finishTransaction: false }),
      verify({ status: "pending", finishTransaction: false })]) {
      const { settle, calls } = setup("ios", response);
      const outcome = await settle(iosTransaction);
      expect(outcome.kind).not.toBe("granted");
      expect(calls).toEqual(["verify"]);
    }
  });

  it("finishes a permanent Apple rejection only because the server said finishTransaction", async () => {
    const { settle, calls } = setup("ios", verify({ status: "rejected", finishTransaction: true, sku: null, glimmerGranted: 0 }));
    expect(await settle(iosTransaction)).toEqual({ kind: "rejected" });
    expect(calls).toEqual(["verify", "finish"]);
    const android = setup("android", verify({ status: "rejected", finishTransaction: true, sku: null, glimmerGranted: 0 }));
    await android.settle(androidPurchase());
    expect(android.calls).toEqual(["verify"]);
  });

  it("does not verify or acknowledge a pending Android purchase", async () => {
    const { settle, calls } = setup("android");
    expect(await settle(androidPurchase({ purchaseState: "pending" }))).toEqual({ kind: "pending" });
    expect(calls).toEqual([]);
  });

  it("treats a replayed transaction as already granted and still finishes it", async () => {
    const { settle, calls } = setup("ios", verify({ status: "already_granted", glimmerGranted: 0 }));
    expect(await settle(iosTransaction)).toMatchObject({ kind: "granted", alreadyGranted: true });
    expect(calls).toEqual(["verify", "finish"]);
  });

  it("verifies one transaction once when the purchase result and the listener race", async () => {
    const { settle, deps } = setup("ios");
    const [a, b] = await Promise.all([settle(iosTransaction), handleTransactionUpdate(settle, { platform: "ios", transaction: iosTransaction })]);
    expect(a).toBe(b);
    expect(deps.api.verifyApple).toHaveBeenCalledTimes(1);
  });

  it("maps purchase results: cancel, Ask to Buy pending, denial and already owned", async () => {
    const { deps, settle, calls } = setup("ios");
    const input = { sku: "glimmer_pinch" as const, productId: "p" };
    const purchase = deps.plugin.purchase as ReturnType<typeof vi.fn>;
    purchase.mockResolvedValueOnce({ platform: "ios", status: "cancelled" });
    expect(await buyStoreProduct(deps, settle, input)).toEqual({ kind: "cancelled" });
    purchase.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "USER_CANCELLED" }));
    expect(await buyStoreProduct(deps, settle, input)).toEqual({ kind: "cancelled" });
    purchase.mockResolvedValueOnce({ platform: "ios", status: "pending" });
    expect(await buyStoreProduct(deps, settle, input)).toEqual({ kind: "pending" });
    purchase.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ITEM_ALREADY_OWNED" }));
    expect(await buyStoreProduct(deps, settle, input)).toEqual({ kind: "already_owned" });
    (deps.api.preflight as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ allowed: false, reason: "daily_limit" });
    expect(await buyStoreProduct(deps, settle, input)).toEqual({ kind: "denied", reason: "daily_limit" });
    expect(calls).toEqual([]);
    purchase.mockResolvedValueOnce({ platform: "ios", status: "purchased", transaction: iosTransaction });
    expect(await buyStoreProduct(deps, settle, input)).toMatchObject({ kind: "granted" });
    expect(purchase).toHaveBeenLastCalledWith({ productId: "p", appAccountToken: "uuid" });
  });

  it("restores and replays unfinished transactions through the server, once each", async () => {
    const { deps, settle, calls } = setup("ios");
    (deps.plugin.restorePurchases as ReturnType<typeof vi.fn>).mockResolvedValue({
      platform: "ios", transactions: [iosTransaction, iosTransaction]
    });
    const restored = await restoreStorePurchases(deps, settle);
    expect(restored.granted).toBe(1);
    expect(calls).toEqual(["verify", "finish"]);
    (deps.plugin.restorePurchases as ReturnType<typeof vi.fn>).mockResolvedValue({ platform: "ios", status: "cancelled", transactions: [] });
    expect((await restoreStorePurchases(deps, settle)).granted).toBe(0);
    (deps.plugin.unfinishedTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
      platform: "ios", transactions: [{ ...iosTransaction, transactionId: "t2" }]
    });
    expect((await reconcileUnfinished(deps, settle)).granted).toBe(1);
  });
});
