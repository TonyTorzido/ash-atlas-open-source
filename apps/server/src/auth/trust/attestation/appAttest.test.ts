import { X509Certificate, createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildAttestClientData } from "@ash-atlas/shared";
import { decode as decodeCbor, encode } from "cbor-x";
import { describe, expect, it } from "vitest";

import {
  AAGUID_DEVELOPMENT,
  buildAssertion,
  buildAttestation,
  loadTestPki
} from "./__fixtures__/appAttestFixtureBuilder.js";
import fixtures from "./__fixtures__/appAttestFixtures.json" with { type: "json" };
import { verifyAppAttestAssertion, verifyAppAttestAttestation, type AppAttestConfig } from "./appAttest.js";
import {
  APPLE_APP_ATTESTATION_ROOT_CA_PEM,
  APPLE_APP_ATTESTATION_ROOT_CA_SHA256
} from "./appleAppAttestRoot.js";
import { appAttestNonce, certificateExtension, decodeOid } from "./der.js";

const APP_ID = fixtures.appId;
const NOW = new Date(fixtures.now);
const pki = loadTestPki(fixtures);
const config: AppAttestConfig = { appId: APP_ID, allowDevelopment: false, rootCertificatePem: pki.rootPem };
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest();
const keyClientDataHash = sha256(buildAttestClientData("ios_key", fixtures.golden.keyChallenge));

function attest(variant: Parameters<typeof buildAttestation>[2] = {}, overrides: Partial<AppAttestConfig> = {}, now = NOW) {
  const built = buildAttestation(pki, { appId: APP_ID, clientDataHash: keyClientDataHash, now: NOW }, variant);
  return {
    built,
    result: verifyAppAttestAttestation(
      { keyId: built.keyId, attestationObject: built.attestationObject, clientDataHash: keyClientDataHash, now },
      { ...config, ...overrides }
    )
  };
}

describe("Apple App Attestation Root CA", () => {
  it("is the committed official PEM with the documented fingerprint", () => {
    const committed = readFileSync(fileURLToPath(new URL("./Apple_App_Attestation_Root_CA.pem", import.meta.url)), "utf8");
    expect(committed.replace(/\r/gu, "")).toBe(APPLE_APP_ATTESTATION_ROOT_CA_PEM);
    const root = new X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM);
    expect(root.fingerprint256).toBe(APPLE_APP_ATTESTATION_ROOT_CA_SHA256);
    expect(root.subject).toContain("Apple App Attestation Root CA");
  });

  it("rejects the synthetic chain when the real Apple root is pinned", () => {
    expect(attest({}, { rootCertificatePem: APPLE_APP_ATTESTATION_ROOT_CA_PEM }).result).toEqual({ ok: false, reason: "chain_invalid" });
  });
});

describe("App Attest key attestation", () => {
  it("accepts the committed golden synthetic attestation", () => {
    const result = verifyAppAttestAttestation({
      keyId: fixtures.golden.keyId,
      attestationObject: Buffer.from(fixtures.golden.attestationObject, "base64"),
      clientDataHash: keyClientDataHash,
      now: NOW
    }, config);
    expect(result).toMatchObject({ ok: true, environment: "production" });
    if (result.ok) expect(result.receipt?.toString()).toBe("synthetic-receipt");
  });

  it("accepts a fresh attestation and reads the nonce extension", () => {
    const { built, result } = attest();
    expect(result.ok).toBe(true);
    const leafDer = Buffer.from((leafCertificates(built.attestationObject))[0]!);
    const extension = certificateExtension(leafDer, "1.2.840.113635.100.8.2");
    expect(appAttestNonce(extension!)).toHaveLength(32);
  });

  it("fails each check", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(attest({ fmt: "packed" }).result).toEqual({ ok: false, reason: "format_invalid" });
    expect(attest({ leafSigningKey: other.privateKey }).result).toEqual({ ok: false, reason: "chain_invalid" });
    expect(attest({}, {}, new Date("2031-01-01T00:00:00.000Z")).result).toEqual({ ok: false, reason: "chain_invalid" });
    expect(attest({ nonce: Buffer.alloc(32, 1) }).result).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(attest({ rpId: "TEAM.com.example.other" }).result).toEqual({ ok: false, reason: "rp_id_mismatch" });
    expect(attest({ counter: 1 }).result).toEqual({ ok: false, reason: "counter_nonzero" });
    expect(attest({ aaguid: Buffer.alloc(16, 1) }).result).toEqual({ ok: false, reason: "aaguid_invalid" });
    expect(attest({ aaguid: AAGUID_DEVELOPMENT }).result).toEqual({ ok: false, reason: "development_not_allowed" });
    expect(attest({ aaguid: AAGUID_DEVELOPMENT }, { allowDevelopment: true }).result)
      .toMatchObject({ ok: true, environment: "development" });
    expect(attest({ credentialId: Buffer.alloc(32, 2) }).result).toEqual({ ok: false, reason: "credential_id_mismatch" });
  });

  it("fails a key id that is not the certified key and garbage input", () => {
    const built = buildAttestation(pki, { appId: APP_ID, clientDataHash: keyClientDataHash, now: NOW });
    const input = { attestationObject: built.attestationObject, clientDataHash: keyClientDataHash, now: NOW };
    expect(verifyAppAttestAttestation({ ...input, keyId: Buffer.alloc(32, 3).toString("base64") }, config))
      .toEqual({ ok: false, reason: "key_id_mismatch" });
    expect(verifyAppAttestAttestation({ ...input, keyId: "not-base64" }, config)).toEqual({ ok: false, reason: "key_id_mismatch" });
    expect(verifyAppAttestAttestation({ ...input, keyId: built.keyId, clientDataHash: sha256("other") }, config))
      .toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(verifyAppAttestAttestation({ ...input, keyId: built.keyId, attestationObject: Buffer.from([0xff, 0x00]) }, config))
      .toEqual({ ok: false, reason: "cbor_invalid" });
  });
});

describe("App Attest assertion", () => {
  const golden = verifyAppAttestAttestation({
    keyId: fixtures.golden.keyId,
    attestationObject: Buffer.from(fixtures.golden.attestationObject, "base64"),
    clientDataHash: keyClientDataHash,
    now: NOW
  }, config);
  const spki = golden.ok ? golden.publicKeySpki : Buffer.alloc(0);
  const clientData = Buffer.from(buildAttestClientData("session", fixtures.golden.assertChallenge), "utf8");

  it("verifies the golden assertion and requires a rising counter", () => {
    const assertion = Buffer.from(fixtures.golden.assertion, "base64");
    expect(verifyAppAttestAssertion({ assertion, clientData, publicKeySpki: spki, previousSignCount: 0 }, config))
      .toEqual({ ok: true, signCount: 1 });
    expect(verifyAppAttestAssertion({ assertion, clientData, publicKeySpki: spki, previousSignCount: 1 }, config))
      .toEqual({ ok: false, reason: "counter_regression" });
  });

  it("fails signature, rpId and malformed branches", () => {
    const { built } = attest();
    const key = verifyAppAttestAttestation({
      keyId: built.keyId,
      attestationObject: built.attestationObject,
      clientDataHash: keyClientDataHash,
      now: NOW
    }, config);
    expect(key.ok).toBe(true);
    const publicKeySpki = key.ok ? key.publicKeySpki : Buffer.alloc(0);
    const good = buildAssertion({ privateKey: built.privateKey, appId: APP_ID, clientData, counter: 5 });
    expect(verifyAppAttestAssertion({ assertion: good, clientData, publicKeySpki, previousSignCount: 4 }, config))
      .toEqual({ ok: true, signCount: 5 });
    expect(verifyAppAttestAssertion({ assertion: good, clientData: Buffer.from("other"), publicKeySpki, previousSignCount: 4 }, config))
      .toEqual({ ok: false, reason: "signature_invalid" });
    expect(verifyAppAttestAssertion({ assertion: good, clientData, publicKeySpki: spki, previousSignCount: 4 }, config))
      .toEqual({ ok: false, reason: "signature_invalid" });
    const wrongRp = buildAssertion({ privateKey: built.privateKey, appId: APP_ID, clientData, counter: 6, rpId: "X.other" });
    expect(verifyAppAttestAssertion({ assertion: wrongRp, clientData, publicKeySpki, previousSignCount: 4 }, config))
      .toEqual({ ok: false, reason: "rp_id_mismatch" });
    expect(verifyAppAttestAssertion({ assertion: Buffer.from(encode({ signature: 1 })), clientData, publicKeySpki, previousSignCount: 0 }, config))
      .toEqual({ ok: false, reason: "cbor_invalid" });
  });
});

describe("DER reader", () => {
  it("decodes OIDs and tolerates truncated input", () => {
    expect(decodeOid(Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]))).toBe("1.2.840.113635.100.8.2");
    expect(certificateExtension(Buffer.from([0x30, 0x05, 0x30]), "1.2.3")).toBeNull();
    expect(appAttestNonce(Buffer.from([0x30, 0x02, 0xa1]))).toBeNull();
  });
});

function leafCertificates(attestationObject: Buffer): Uint8Array[] {
  return (decodeCbor(attestationObject) as { attStmt: { x5c: Uint8Array[] } }).attStmt.x5c;
}
