import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload
} from "@apple/app-store-server-library";

import type { PurchaseEnvironment } from "./purchaseLedger.js";

// StoreKit 2 verification with Apple's App Store Server Library
// (premium-currency-plan.md §6.4). The library verifies the JWS signature and
// x5c chain to the configured Apple roots, the bundle id and environment; the
// checks below add product, ownership and account binding.

export type AppleVerifier = Readonly<{
  verifyTransaction(signed: string): Promise<{ payload: JWSTransactionDecodedPayload; environment: PurchaseEnvironment }>;
  verifyRenewalInfo(signed: string): Promise<JWSRenewalInfoDecodedPayload>;
  verifyNotification(signed: string): Promise<{ payload: ResponseBodyV2DecodedPayload; environment: PurchaseEnvironment }>;
}>;

export class AppleVerificationError extends Error {
  constructor(readonly code: "invalid" | "retryable", message: string) {
    super(message);
    this.name = "AppleVerificationError";
  }
}

export function createAppleVerifier(options: Readonly<{
  rootCertificates: readonly Buffer[];
  bundleId: string;
  appAppleId: number | undefined;
  acceptSandbox: boolean;
  onlineChecks: boolean;
}>): AppleVerifier {
  if (options.rootCertificates.length === 0) throw new Error("Apple root certificates are required");
  const verifiers: Array<{ environment: PurchaseEnvironment; verifier: SignedDataVerifier }> = [{
    environment: "production",
    verifier: new SignedDataVerifier(
      [...options.rootCertificates], options.onlineChecks, Environment.PRODUCTION, options.bundleId, options.appAppleId
    )
  }];
  if (options.acceptSandbox) {
    verifiers.push({
      environment: "sandbox",
      verifier: new SignedDataVerifier(
        [...options.rootCertificates], options.onlineChecks, Environment.SANDBOX, options.bundleId
      )
    });
  }
  // Production first; only a wrong-environment failure falls through to sandbox.
  const run = async <T>(call: (verifier: SignedDataVerifier) => Promise<T>) => {
    let lastError: unknown = null;
    for (const { environment, verifier } of verifiers) {
      try {
        return { payload: await call(verifier), environment };
      } catch (error) {
        lastError = error;
        if (!(error instanceof VerificationException) || error.status !== VerificationStatus.INVALID_ENVIRONMENT) break;
      }
    }
    if (lastError instanceof VerificationException && lastError.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
      throw new AppleVerificationError("retryable", "Apple verification is temporarily unavailable");
    }
    throw new AppleVerificationError("invalid", "Apple signed data failed verification");
  };
  return {
    verifyTransaction: (signed) => run((verifier) => verifier.verifyAndDecodeTransaction(signed)),
    verifyNotification: (signed) => run((verifier) => verifier.verifyAndDecodeNotification(signed)),
    async verifyRenewalInfo(signed) {
      return (await run((verifier) => verifier.verifyAndDecodeRenewalInfo(signed))).payload;
    }
  };
}

export type AppleTransactionFacts = Readonly<{
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  appAccountToken: string | null;
  purchasedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  type: "consumable" | "subscription";
  storePriceMilli: bigint | null;
  currency: string | null;
}>;

export type AppleTransactionCheck =
  | Readonly<{ ok: true; facts: AppleTransactionFacts }>
  | Readonly<{ ok: false; reason: string }>;

/** Shape and policy checks on a library-verified transaction payload. */
export function checkAppleTransaction(payload: JWSTransactionDecodedPayload, bundleId: string): AppleTransactionCheck {
  if (payload.bundleId !== bundleId) return { ok: false, reason: "bundle_mismatch" };
  if (!payload.transactionId || !payload.originalTransactionId || !payload.productId || !payload.purchaseDate) {
    return { ok: false, reason: "incomplete_transaction" };
  }
  // Family Sharing stays off: a shared purchase would mint value for another account.
  if (payload.inAppOwnershipType && payload.inAppOwnershipType !== "PURCHASED") {
    return { ok: false, reason: "family_shared" };
  }
  const type = payload.type === "Consumable" ? "consumable"
    : payload.type === "Auto-Renewable Subscription" ? "subscription"
      : null;
  if (!type) return { ok: false, reason: "unsupported_type" };
  if (type === "consumable" && payload.quantity !== undefined && payload.quantity !== 1) {
    return { ok: false, reason: "quantity_unsupported" };
  }
  if (type === "subscription" && !payload.expiresDate) return { ok: false, reason: "incomplete_transaction" };
  return {
    ok: true,
    facts: {
      transactionId: payload.transactionId,
      originalTransactionId: payload.originalTransactionId,
      productId: payload.productId,
      appAccountToken: payload.appAccountToken?.toLowerCase() ?? null,
      purchasedAt: new Date(payload.purchaseDate),
      expiresAt: payload.expiresDate ? new Date(payload.expiresDate) : null,
      revokedAt: payload.revocationDate ? new Date(payload.revocationDate) : null,
      type,
      storePriceMilli: typeof payload.price === "number" && Number.isSafeInteger(payload.price) && payload.price >= 0
        ? BigInt(payload.price)
        : null,
      currency: typeof payload.currency === "string" && /^[A-Z]{3}$/u.test(payload.currency) ? payload.currency : null
    }
  };
}

/** Decodes base64 DER certificates from config. */
export function parseAppleRootCertificates(csv: string): Buffer[] {
  return csv.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => Buffer.from(entry, "base64"));
}
