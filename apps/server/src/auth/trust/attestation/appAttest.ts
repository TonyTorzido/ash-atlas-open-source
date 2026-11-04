import { X509Certificate, createHash, createPublicKey, createVerify } from "node:crypto";

import { decode } from "cbor-x";

import { appAttestNonce, certificateExtension } from "./der.js";

// Apple App Attest verification (NATIVE_ANTISPOOF_BUILD_PLAN.md §8.5, following
// Apple's "Validating apps that connect to your server"). Pure: no network, no DB.

export const APP_ATTEST_NONCE_OID = "1.2.840.113635.100.8.2";
const AAGUID_PRODUCTION = Buffer.concat([Buffer.from("appattest", "ascii"), Buffer.alloc(7)]);
const AAGUID_DEVELOPMENT = Buffer.from("appattestdevelop", "ascii");
// rpIdHash(32) | flags(1) | signCount(4)
const AUTH_DATA_COUNTER_OFFSET = 33;
const AUTH_DATA_MIN_LENGTH = 37;
// ... | aaguid(16) | credentialIdLength(2) | credentialId
const ATTESTED_DATA_OFFSET = 37;

export type AppAttestConfig = Readonly<{
  // "<TEAM_ID>.<bundle id>".
  appId: string;
  // appattestdevelop keys; never in production (config refuses it).
  allowDevelopment: boolean;
  rootCertificatePem: string;
}>;

export type AppAttestKeyFailure =
  | "cbor_invalid"
  | "format_invalid"
  | "chain_invalid"
  | "nonce_mismatch"
  | "key_id_mismatch"
  | "rp_id_mismatch"
  | "counter_nonzero"
  | "aaguid_invalid"
  | "development_not_allowed"
  | "credential_id_mismatch";

export type AppAttestKeyResult =
  | Readonly<{
      ok: true;
      publicKeySpki: Buffer;
      environment: "production" | "development";
      receipt: Buffer | null;
    }>
  | Readonly<{ ok: false; reason: AppAttestKeyFailure }>;

export type AppAttestAssertionFailure = "cbor_invalid" | "signature_invalid" | "rp_id_mismatch" | "counter_regression";

export type AppAttestAssertionResult =
  | Readonly<{ ok: true; signCount: number }>
  | Readonly<{ ok: false; reason: AppAttestAssertionFailure }>;

const sha256 = (...parts: Buffer[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const asBuffer = (value: unknown): Buffer | null =>
  value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : null;

function decodeMap(input: Buffer): Record<string, unknown> | null {
  try {
    const decoded: unknown = decode(input);
    return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) && !(decoded instanceof Uint8Array)
      ? decoded as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** App Attest key identifier: base64 of SHA-256(uncompressed EC public key). */
export function decodeKeyId(keyId: string): Buffer | null {
  const bytes = Buffer.from(keyId, "base64");
  return bytes.length === 32 && bytes.toString("base64") === keyId ? bytes : null;
}

function uncompressedPoint(certificate: X509Certificate): Buffer | null {
  const jwk = certificate.publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) return null;
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
}

function withinValidity(certificate: X509Certificate, now: Date): boolean {
  const from = new Date(certificate.validFrom).getTime();
  const to = new Date(certificate.validTo).getTime();
  return Number.isFinite(from) && Number.isFinite(to) && now.getTime() >= from && now.getTime() <= to;
}

function chainIsValid(leaf: X509Certificate, intermediate: X509Certificate, root: X509Certificate, now: Date): boolean {
  try {
    return intermediate.ca
      && leaf.checkIssued(intermediate)
      && leaf.verify(intermediate.publicKey)
      && intermediate.checkIssued(root)
      && intermediate.verify(root.publicKey)
      && withinValidity(leaf, now)
      && withinValidity(intermediate, now)
      && withinValidity(root, now);
  } catch {
    return false;
  }
}

/**
 * Verifies a key attestation object. Checks, in Apple's order: the x5c chain
 * to the pinned root; the leaf nonce extension equals SHA256(authData ‖
 * clientDataHash); keyId equals SHA256(public key); rpIdHash equals SHA256(appId);
 * signCount is 0; aaguid is appattest (appattestdevelop only when allowed);
 * credentialId equals keyId.
 */
export function verifyAppAttestAttestation(
  input: Readonly<{ keyId: string; attestationObject: Buffer; clientDataHash: Buffer; now: Date }>,
  config: AppAttestConfig
): AppAttestKeyResult {
  const object = decodeMap(input.attestationObject);
  if (!object) return { ok: false, reason: "cbor_invalid" };
  const statement = object.attStmt as Record<string, unknown> | undefined;
  const authData = asBuffer(object.authData);
  const x5c = Array.isArray(statement?.x5c) ? statement.x5c.map(asBuffer) : [];
  if (object.fmt !== "apple-appattest" || !authData || x5c.length < 2 || x5c.some((entry) => entry === null)) {
    return { ok: false, reason: "format_invalid" };
  }
  const keyIdBytes = decodeKeyId(input.keyId);
  if (!keyIdBytes) return { ok: false, reason: "key_id_mismatch" };

  // 1. Certificate chain to the pinned Apple App Attestation Root CA.
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  let root: X509Certificate;
  try {
    leaf = new X509Certificate(x5c[0]!);
    intermediate = new X509Certificate(x5c[1]!);
    root = new X509Certificate(config.rootCertificatePem);
  } catch {
    return { ok: false, reason: "chain_invalid" };
  }
  if (!chainIsValid(leaf, intermediate, root, input.now)) return { ok: false, reason: "chain_invalid" };

  // 2-3. Nonce extension.
  const nonce = sha256(authData, input.clientDataHash);
  const extension = certificateExtension(leaf.raw, APP_ATTEST_NONCE_OID);
  const certifiedNonce = extension ? appAttestNonce(extension) : null;
  if (!certifiedNonce || !certifiedNonce.equals(nonce)) return { ok: false, reason: "nonce_mismatch" };

  // 4. Key identifier.
  const point = uncompressedPoint(leaf);
  if (!point || !sha256(point).equals(keyIdBytes)) return { ok: false, reason: "key_id_mismatch" };

  // 5-8. Authenticator data.
  if (authData.length < ATTESTED_DATA_OFFSET + 18) return { ok: false, reason: "format_invalid" };
  if (!authData.subarray(0, 32).equals(sha256(Buffer.from(config.appId, "utf8")))) {
    return { ok: false, reason: "rp_id_mismatch" };
  }
  if (authData.readUInt32BE(AUTH_DATA_COUNTER_OFFSET) !== 0) return { ok: false, reason: "counter_nonzero" };
  const aaguid = authData.subarray(ATTESTED_DATA_OFFSET, ATTESTED_DATA_OFFSET + 16);
  let environment: "production" | "development";
  if (aaguid.equals(AAGUID_PRODUCTION)) environment = "production";
  else if (aaguid.equals(AAGUID_DEVELOPMENT)) environment = "development";
  else return { ok: false, reason: "aaguid_invalid" };
  if (environment === "development" && !config.allowDevelopment) return { ok: false, reason: "development_not_allowed" };
  const credentialIdLength = authData.readUInt16BE(ATTESTED_DATA_OFFSET + 16);
  const credentialStart = ATTESTED_DATA_OFFSET + 18;
  const credentialId = authData.subarray(credentialStart, credentialStart + credentialIdLength);
  if (credentialId.length !== credentialIdLength || !credentialId.equals(keyIdBytes)) {
    return { ok: false, reason: "credential_id_mismatch" };
  }

  return {
    ok: true,
    publicKeySpki: Buffer.from(leaf.publicKey.export({ type: "spki", format: "der" })),
    environment,
    receipt: asBuffer(statement?.receipt)
  };
}

/**
 * Verifies an assertion: ECDSA over SHA256(authenticatorData ‖ SHA256(clientData))
 * with the registered key, rpIdHash, and a counter above the stored one. The
 * caller persists the new counter atomically (a lost race is a regression).
 */
export function verifyAppAttestAssertion(
  input: Readonly<{ assertion: Buffer; clientData: Buffer; publicKeySpki: Buffer; previousSignCount: number }>,
  config: Pick<AppAttestConfig, "appId">
): AppAttestAssertionResult {
  const object = decodeMap(input.assertion);
  const signature = asBuffer(object?.signature);
  const authenticatorData = asBuffer(object?.authenticatorData);
  if (!signature || !authenticatorData || authenticatorData.length < AUTH_DATA_MIN_LENGTH) {
    return { ok: false, reason: "cbor_invalid" };
  }
  const nonce = sha256(authenticatorData, sha256(input.clientData));
  let valid = false;
  try {
    const key = createPublicKey({ key: input.publicKeySpki, format: "der", type: "spki" });
    valid = createVerify("sha256").update(nonce).verify(key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature_invalid" };
  if (!authenticatorData.subarray(0, 32).equals(sha256(Buffer.from(config.appId, "utf8")))) {
    return { ok: false, reason: "rp_id_mismatch" };
  }
  const signCount = authenticatorData.readUInt32BE(AUTH_DATA_COUNTER_OFFSET);
  if (signCount <= input.previousSignCount) return { ok: false, reason: "counter_regression" };
  return { ok: true, signCount };
}
