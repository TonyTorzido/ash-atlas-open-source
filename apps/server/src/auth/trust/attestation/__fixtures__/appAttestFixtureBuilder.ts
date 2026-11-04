import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { encode } from "cbor-x";

// SYNTHETIC App Attest test PKI (tests only). Builds X.509 certificates with
// node:crypto signatures and a tiny DER encoder, so tests can mint leaves whose
// nonce extension matches any authenticator data. Never trusted outside tests:
// the real verifier pins Apple's root (appleAppAttestRoot.ts).

const tlv = (tag: number, content: Buffer): Buffer => {
  const length = content.length;
  let header: Buffer;
  if (length < 0x80) header = Buffer.from([tag, length]);
  else if (length < 0x100) header = Buffer.from([tag, 0x81, length]);
  else header = Buffer.from([tag, 0x82, length >> 8, length & 0xff]);
  return Buffer.concat([header, content]);
};
const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const integer = (value: Buffer): Buffer => tlv(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const octets = (value: Buffer): Buffer => tlv(0x04, value);
const bitString = (value: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const explicit = (tagNumber: number, content: Buffer): Buffer => tlv(0xa0 + tagNumber, content);
const oid = (dotted: string): Buffer => {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    let rest = Math.floor(part / 128);
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const utcTime = (date: Date): Buffer => {
  const iso = date.toISOString();
  return tlv(0x17, Buffer.from(`${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`, "ascii"));
};
const name = (commonName: string): Buffer => sequence(set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName, "utf8")))));
const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

export const APP_ATTEST_NONCE_OID = "1.2.840.113635.100.8.2";

export type CertificateSpec = Readonly<{
  serial: number;
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signingKey: KeyObject;
  ca: boolean;
  notBefore: Date;
  notAfter: Date;
  // Leaf only: the App Attest nonce extension.
  nonce?: Buffer;
  // Empty marker extensions (e.g. Apple's App Store signing-certificate OIDs).
  markerOids?: readonly string[];
}>;

/** DER X.509 v3 certificate signed with ECDSA-SHA256. */
export function issueCertificate(spec: CertificateSpec): Buffer {
  const extensions: Buffer[] = [
    sequence(oid("2.5.29.19"), boolean(true), octets(spec.ca ? sequence(boolean(true)) : sequence()))
  ];
  for (const markerOid of spec.markerOids ?? []) {
    extensions.push(sequence(oid(markerOid), octets(Buffer.from([0x05, 0x00]))));
  }
  if (spec.nonce) {
    extensions.push(sequence(oid(APP_ATTEST_NONCE_OID), octets(sequence(explicit(1, octets(spec.nonce))))));
  }
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(Buffer.from([spec.serial & 0x7f])),
    ECDSA_SHA256,
    name(spec.issuer),
    sequence(utcTime(spec.notBefore), utcTime(spec.notAfter)),
    name(spec.subject),
    Buffer.from(spec.publicKey.export({ type: "spki", format: "der" })),
    explicit(3, sequence(...extensions))
  );
  return sequence(tbs, ECDSA_SHA256, bitString(sign("sha256", tbs, spec.signingKey)));
}

export const toPem = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/gu)!.join("\n")}\n-----END CERTIFICATE-----\n`;

export type TestPki = Readonly<{
  rootPem: string;
  intermediateDer: Buffer;
  intermediateKey: KeyObject;
}>;

export type TestPkiJson = Readonly<{
  rootPem: string;
  intermediatePem: string;
  intermediatePrivateKeyPem: string;
}>;

export function loadTestPki(json: TestPkiJson): TestPki {
  const body = json.intermediatePem.replace(/-----[A-Z ]+-----/gu, "").replace(/\s+/gu, "");
  return {
    rootPem: json.rootPem,
    intermediateDer: Buffer.from(body, "base64"),
    intermediateKey: createPrivateKey(json.intermediatePrivateKeyPem)
  };
}

const sha256 = (...parts: Buffer[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

export const AAGUID_PRODUCTION = Buffer.concat([Buffer.from("appattest", "ascii"), Buffer.alloc(7)]);
export const AAGUID_DEVELOPMENT = Buffer.from("appattestdevelop", "ascii");

export type AttestationVariant = Partial<Readonly<{
  rpId: string;
  counter: number;
  aaguid: Buffer;
  credentialId: Buffer;
  // Certify a different nonce than SHA256(authData ‖ clientDataHash).
  nonce: Buffer;
  fmt: string;
  leafNotAfter: Date;
  // Sign the leaf with this key instead of the intermediate (broken chain).
  leafSigningKey: KeyObject;
}>>;

export type BuiltAttestation = Readonly<{
  keyId: string;
  attestationObject: Buffer;
  privateKey: KeyObject;
}>;

/** A key attestation object for a fresh P-256 key, chained to the test PKI. */
export function buildAttestation(
  pki: TestPki,
  input: Readonly<{ appId: string; clientDataHash: Buffer; now: Date }>,
  variant: AttestationVariant = {}
): BuiltAttestation {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  const keyIdBytes = sha256(point);
  const credentialId = variant.credentialId ?? keyIdBytes;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(variant.counter ?? 0);
  const credentialLength = Buffer.alloc(2);
  credentialLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    sha256(Buffer.from(variant.rpId ?? input.appId, "utf8")),
    Buffer.from([0x40]),
    counter,
    variant.aaguid ?? AAGUID_PRODUCTION,
    credentialLength,
    credentialId,
    // COSE key placeholder; the verifier reads the key from the leaf certificate.
    Buffer.from([0xa0])
  ]);
  const leaf = issueCertificate({
    serial: 3,
    subject: "Synthetic App Attest Leaf",
    issuer: "Synthetic App Attest Intermediate",
    publicKey,
    signingKey: variant.leafSigningKey ?? pki.intermediateKey,
    ca: false,
    notBefore: new Date(input.now.getTime() - 24 * 60 * 60_000),
    notAfter: variant.leafNotAfter ?? new Date(input.now.getTime() + 3 * 24 * 60 * 60_000),
    nonce: variant.nonce ?? sha256(authData, input.clientDataHash)
  });
  const attestationObject = Buffer.from(encode({
    fmt: variant.fmt ?? "apple-appattest",
    attStmt: { x5c: [leaf, pki.intermediateDer], receipt: Buffer.from("synthetic-receipt") },
    authData
  }));
  return { keyId: keyIdBytes.toString("base64"), attestationObject, privateKey };
}

/** An assertion over clientData with `counter`, signed by `privateKey`. */
export function buildAssertion(
  input: Readonly<{ privateKey: KeyObject; appId: string; clientData: Buffer; counter: number; rpId?: string }>
): Buffer {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(input.counter);
  const authenticatorData = Buffer.concat([sha256(Buffer.from(input.rpId ?? input.appId, "utf8")), Buffer.from([0x40]), counter]);
  const signature = sign("sha256", sha256(authenticatorData, sha256(input.clientData)), input.privateKey);
  return Buffer.from(encode({ signature, authenticatorData }));
}
