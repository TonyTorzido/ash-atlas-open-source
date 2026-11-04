import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { issueCertificate } from "../auth/trust/attestation/__fixtures__/appAttestFixtureBuilder.js";
import { AppleVerificationError, checkAppleTransaction, createAppleVerifier } from "./appleStore.js";

// SYNTHETIC App Store signing PKI (tests only): root -> intermediate (Apple
// WWDR marker OID) -> leaf (App Store receipt-signing marker OID), so the real
// App Store Server Library verifies these fixtures end to end offline.
const LEAF_OID = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";
const NOW = Date.parse("2026-10-03T12:00:00Z");
const BUNDLE = "com.ashatlas.game";
const TOKEN = "00000000-0000-4000-8000-0000000000b1";

type Pki = { root: Buffer; intermediate: Buffer; leaf: Buffer; leafKey: KeyObject };

function buildPki(): Pki {
  const root = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const intermediate = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const leaf = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const notBefore = new Date(NOW - 30 * 86_400_000);
  const notAfter = new Date(NOW + 365 * 86_400_000);
  return {
    root: issueCertificate({
      serial: 1, subject: "Synthetic Store Root", issuer: "Synthetic Store Root",
      publicKey: root.publicKey, signingKey: root.privateKey, ca: true, notBefore, notAfter
    }),
    intermediate: issueCertificate({
      serial: 2, subject: "Synthetic Store Intermediate", issuer: "Synthetic Store Root",
      publicKey: intermediate.publicKey, signingKey: root.privateKey, ca: true, notBefore, notAfter,
      markerOids: [INTERMEDIATE_OID]
    }),
    leaf: issueCertificate({
      serial: 3, subject: "Synthetic Store Leaf", issuer: "Synthetic Store Intermediate",
      publicKey: leaf.publicKey, signingKey: intermediate.privateKey, ca: false, notBefore, notAfter,
      markerOids: [LEAF_OID]
    }),
    leafKey: leaf.privateKey
  };
}

function jws(pki: Pki, payload: Record<string, unknown>): string {
  const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");
  const header = b64(JSON.stringify({
    alg: "ES256",
    x5c: [pki.leaf, pki.intermediate, pki.root].map((cert) => cert.toString("base64"))
  }));
  const body = b64(JSON.stringify(payload));
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key: pki.leafKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${b64(signature)}`;
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: "2000000123456789",
    originalTransactionId: "2000000123456789",
    bundleId: BUNDLE,
    productId: "com.ashatlas.game.glimmer.pouch",
    purchaseDate: NOW - 60_000,
    originalPurchaseDate: NOW - 60_000,
    quantity: 1,
    type: "Consumable",
    appAccountToken: TOKEN,
    inAppOwnershipType: "PURCHASED",
    signedDate: NOW,
    environment: "Production",
    transactionReason: "PURCHASE",
    storefront: "USA",
    storefrontId: "143441",
    price: 9990,
    currency: "USD",
    ...overrides
  };
}

const pki = buildPki();
const verifier = (acceptSandbox: boolean, roots = [pki.root]) => createAppleVerifier({
  rootCertificates: roots, bundleId: BUNDLE, appAppleId: 1234567890, acceptSandbox, onlineChecks: false
});

describe("Apple StoreKit 2 transaction verification", () => {
  it("verifies a production consumable chained to the configured root", async () => {
    const verified = await verifier(false).verifyTransaction(jws(pki, transaction()));
    expect(verified.environment).toBe("production");
    const check = checkAppleTransaction(verified.payload, BUNDLE);
    expect(check).toEqual({
      ok: true,
      facts: expect.objectContaining({
        transactionId: "2000000123456789",
        productId: "com.ashatlas.game.glimmer.pouch",
        appAccountToken: TOKEN,
        type: "consumable",
        storePriceMilli: 9990n,
        currency: "USD",
        revokedAt: null
      })
    });
  });

  it("rejects a chain to an untrusted root, a foreign bundle and a tampered payload", async () => {
    const other = buildPki();
    await expect(verifier(false, [other.root]).verifyTransaction(jws(pki, transaction())))
      .rejects.toBeInstanceOf(AppleVerificationError);
    await expect(verifier(false).verifyTransaction(jws(pki, transaction({ bundleId: "com.other.app" }))))
      .rejects.toMatchObject({ code: "invalid" });
    const [header, , signature] = jws(pki, transaction()).split(".");
    const forged = Buffer.from(JSON.stringify(transaction({ productId: "com.ashatlas.game.glimmer.hoard" }))).toString("base64url");
    await expect(verifier(false).verifyTransaction(`${header}.${forged}.${signature}`))
      .rejects.toMatchObject({ code: "invalid" });
  });

  it("accepts sandbox only when sandbox purchases are allowed", async () => {
    const sandbox = jws(pki, transaction({ environment: "Sandbox" }));
    await expect(verifier(false).verifyTransaction(sandbox)).rejects.toMatchObject({ code: "invalid" });
    await expect(verifier(true).verifyTransaction(sandbox)).resolves.toMatchObject({ environment: "sandbox" });
  });

  it("refuses family-shared, multi-quantity and non-consumable transactions", async () => {
    const decode = async (overrides: Record<string, unknown>) =>
      checkAppleTransaction((await verifier(false).verifyTransaction(jws(pki, transaction(overrides)))).payload, BUNDLE);
    await expect(decode({ inAppOwnershipType: "FAMILY_SHARED" })).resolves.toEqual({ ok: false, reason: "family_shared" });
    await expect(decode({ quantity: 2 })).resolves.toEqual({ ok: false, reason: "quantity_unsupported" });
    await expect(decode({ type: "Non-Consumable" })).resolves.toEqual({ ok: false, reason: "unsupported_type" });
    await expect(decode({
      type: "Auto-Renewable Subscription", productId: "com.ashatlas.game.pass.monthly",
      expiresDate: NOW + 30 * 86_400_000, revocationDate: NOW
    })).resolves.toMatchObject({ ok: true, facts: { type: "subscription", revokedAt: new Date(NOW) } });
  });
});
