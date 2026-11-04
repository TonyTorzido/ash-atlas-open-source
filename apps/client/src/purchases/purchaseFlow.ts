import {
  ATLAS_PASS_SKUS,
  type AtlasPassEntitlement,
  type PremiumProductSku,
  type PremiumWalletSnapshot,
  type PurchaseDenialReason
} from "@ash-atlas/shared";
import type {
  AndroidPurchase,
  IosTransaction,
  OwnedPurchases,
  PurchaseResult,
  PurchasesPlugin,
  StorePlatform,
  TransactionUpdate
} from "../native/nativePurchases.js";
import type { PurchaseApiPort } from "./purchaseApi.js";

/**
 * Native store purchase state machine. Ordering contract (the server is the
 * only authority): the store transaction is sent to the server first; only
 * after the server answers granted/already_granted with finishTransaction=true
 * does the client finish (iOS) / consume (Android pack) / acknowledge (Android
 * pass). Pending, rejected and failed verifications are never finished, so the
 * store keeps the transaction and `reconcileUnfinished` replays it later.
 */

export type PurchaseFlowDeps = Readonly<{
  platform: StorePlatform;
  plugin: Pick<PurchasesPlugin,
    "purchase" | "finishTransaction" | "acknowledgePurchase" | "consumePurchase" |
    "restorePurchases" | "unfinishedTransactions">;
  api: Pick<PurchaseApiPort, "preflight" | "verifyApple" | "verifyGoogle">;
}>;

export type SettleOutcome =
  | Readonly<{
      kind: "granted";
      sku: PremiumProductSku | null;
      glimmerGranted: number;
      alreadyGranted: boolean;
      wallet: PremiumWalletSnapshot | null;
      atlasPass: AtlasPassEntitlement | null;
    }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "rejected" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type BuyOutcome =
  | SettleOutcome
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "denied"; reason: PurchaseDenialReason }>
  | Readonly<{ kind: "already_owned" }>;

export type RestoreSummary = Readonly<{
  granted: number;
  pending: number;
  failed: number;
  outcomes: readonly SettleOutcome[];
  error?: string;
}>;

export type StoreTransaction = IosTransaction | AndroidPurchase;
export type Settle = (transaction: StoreTransaction) => Promise<SettleOutcome>;

const isIos = (transaction: StoreTransaction): transaction is IosTransaction => "jws" in transaction;

function transactionKey(transaction: StoreTransaction): string {
  return isIos(transaction) ? `ios:${transaction.transactionId}` : `android:${transaction.purchaseToken}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The purchase could not be completed";
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** One settle at a time per store transaction (the purchase result and the listener can race). */
export function createPurchaseSettler(deps: PurchaseFlowDeps): Settle {
  const inFlight = new Map<string, Promise<SettleOutcome>>();
  return (transaction) => {
    const key = transactionKey(transaction);
    const running = inFlight.get(key);
    if (running) return running;
    const next = settleStoreTransaction(deps, transaction).finally(() => inFlight.delete(key));
    inFlight.set(key, next);
    return next;
  };
}

export async function settleStoreTransaction(
  deps: PurchaseFlowDeps,
  transaction: StoreTransaction
): Promise<SettleOutcome> {
  if (!isIos(transaction) && transaction.purchaseState !== "purchased") {
    // Pending (slow payment method) or unspecified: nothing to verify or acknowledge yet.
    return { kind: "pending" };
  }
  let response;
  try {
    response = isIos(transaction)
      ? await deps.api.verifyApple(transaction.jws)
      : await deps.api.verifyGoogle(transaction.productIds[0] ?? "", transaction.purchaseToken);
  } catch (error) {
    return { kind: "failed", message: errorMessage(error) };
  }
  // Honour finishTransaction exactly as the server returned it, for every status
  // (Apple permanent rejections come back rejected + finish=true so they stop replaying).
  // Android only acts on a recorded grant: a rejected buy stays unacknowledged so Google refunds it.
  const granted = response.status === "granted" || response.status === "already_granted";
  if (response.finishTransaction && (isIos(transaction) || granted)) {
    try {
      if (isIos(transaction)) {
        await deps.plugin.finishTransaction({ transactionId: transaction.transactionId });
      } else if (ATLAS_PASS_SKUS.some((sku) => sku === response.sku)) {
        if (!transaction.isAcknowledged) await deps.plugin.acknowledgePurchase({ purchaseToken: transaction.purchaseToken });
      } else {
        await deps.plugin.consumePurchase({ purchaseToken: transaction.purchaseToken });
      }
    } catch {
      // The server decision is recorded; the store keeps it unfinished and a replay is idempotent.
    }
  }
  if (response.status === "pending") return { kind: "pending" };
  if (response.status === "rejected") return { kind: "rejected" };
  return {
    kind: "granted",
    sku: response.sku,
    glimmerGranted: response.glimmerGranted,
    alreadyGranted: response.status === "already_granted",
    wallet: response.wallet,
    atlasPass: response.atlasPass
  };
}

export async function buyStoreProduct(
  deps: PurchaseFlowDeps,
  settle: Settle,
  input: Readonly<{ sku: PremiumProductSku; productId: string; offerToken?: string }>
): Promise<BuyOutcome> {
  let appAccountToken: string;
  try {
    const preflight = await deps.api.preflight(deps.platform === "ios" ? "apple" : "google", input.sku);
    if (!preflight.allowed) return { kind: "denied", reason: preflight.reason };
    appAccountToken = preflight.appAccountToken;
  } catch (error) {
    return { kind: "failed", message: errorMessage(error) };
  }
  let result: PurchaseResult;
  try {
    result = await deps.plugin.purchase({
      productId: input.productId,
      appAccountToken,
      ...(input.offerToken ? { offerToken: input.offerToken } : {})
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === "USER_CANCELLED") return { kind: "cancelled" };
    if (code === "ITEM_ALREADY_OWNED") return { kind: "already_owned" };
    return { kind: "failed", message: errorMessage(error) };
  }
  if (result.status === "cancelled") return { kind: "cancelled" };
  if (result.platform === "ios") {
    if (result.status !== "purchased") return { kind: "pending" }; // Ask to Buy: completes via the listener
    return settle(result.transaction);
  }
  return settle(result.purchase);
}

function ownedTransactions(owned: OwnedPurchases): readonly StoreTransaction[] {
  return owned.platform === "ios" ? owned.transactions : owned.purchases;
}

async function settleAll(settle: Settle, transactions: readonly StoreTransaction[]): Promise<RestoreSummary> {
  const seen = new Set<string>();
  const outcomes: SettleOutcome[] = [];
  for (const transaction of transactions) {
    const key = transactionKey(transaction);
    if (seen.has(key)) continue;
    seen.add(key);
    outcomes.push(await settle(transaction));
  }
  return {
    granted: outcomes.filter((outcome) => outcome.kind === "granted" && !outcome.alreadyGranted).length,
    pending: outcomes.filter((outcome) => outcome.kind === "pending").length,
    failed: outcomes.filter((outcome) => outcome.kind === "failed" || outcome.kind === "rejected").length,
    outcomes
  };
}

const EMPTY_SUMMARY: RestoreSummary = { granted: 0, pending: 0, failed: 0, outcomes: [] };

/** Replays paid-but-unfinished store transactions (launch / resume). */
export async function reconcileUnfinished(deps: PurchaseFlowDeps, settle: Settle): Promise<RestoreSummary> {
  try {
    return await settleAll(settle, ownedTransactions(await deps.plugin.unfinishedTransactions()));
  } catch {
    return EMPTY_SUMMARY;
  }
}

/** User-initiated restore (iOS may prompt for sign-in); the server verifies every owned transaction. */
export async function restoreStorePurchases(deps: PurchaseFlowDeps, settle: Settle): Promise<RestoreSummary> {
  let owned: OwnedPurchases;
  try {
    owned = await deps.plugin.restorePurchases();
  } catch (error) {
    if (errorCode(error) === "USER_CANCELLED") return EMPTY_SUMMARY;
    return { ...EMPTY_SUMMARY, error: errorMessage(error) };
  }
  if (owned.platform === "ios" && owned.status === "cancelled") return EMPTY_SUMMARY;
  return settleAll(settle, ownedTransactions(owned));
}

/** Transaction listener body: Ask to Buy approvals, renewals, refunds, pending -> purchased. */
export function handleTransactionUpdate(settle: Settle, update: TransactionUpdate): Promise<SettleOutcome> {
  return settle(update.platform === "ios" ? update.transaction : update.purchase);
}
