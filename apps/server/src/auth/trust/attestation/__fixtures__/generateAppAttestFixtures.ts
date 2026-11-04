import { createHash, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildAttestClientData } from "@ash-atlas/shared";

import { buildAssertion, buildAttestation, issueCertificate, loadTestPki, toPem } from "./appAttestFixtureBuilder.js";

// Regenerates appAttestFixtures.json: a SYNTHETIC root + intermediate (test only)
// and one golden key attestation + assertion. Run once from apps/server:
//   npx tsx src/auth/trust/attestation/__fixtures__/generateAppAttestFixtures.ts
// A real-device golden fixture (signed by Apple) is still to be captured (§10.2).

const APP_ID = "ABCDE12345.com.ashatlas.game";
const NOW = new Date("2026-10-02T12:00:00.000Z");
const KEY_CHALLENGE = Buffer.alloc(32, 7).toString("base64url");
const ASSERT_CHALLENGE = Buffer.alloc(32, 9).toString("base64url");

const root = generateKeyPairSync("ec", { namedCurve: "P-256" });
const intermediate = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rootDer = issueCertificate({
  serial: 1,
  subject: "Synthetic App Attest Root",
  issuer: "Synthetic App Attest Root",
  publicKey: root.publicKey,
  signingKey: root.privateKey,
  ca: true,
  notBefore: new Date("2025-01-01T00:00:00.000Z"),
  notAfter: new Date("2049-12-31T00:00:00.000Z")
});
const intermediateDer = issueCertificate({
  serial: 2,
  subject: "Synthetic App Attest Intermediate",
  issuer: "Synthetic App Attest Root",
  publicKey: intermediate.publicKey,
  signingKey: root.privateKey,
  ca: true,
  notBefore: new Date("2025-01-01T00:00:00.000Z"),
  notAfter: new Date("2049-12-31T00:00:00.000Z")
});
const pkiJson = {
  rootPem: toPem(rootDer),
  intermediatePem: toPem(intermediateDer),
  intermediatePrivateKeyPem: intermediate.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
};
const pki = loadTestPki(pkiJson);
const keyClientData = buildAttestClientData("ios_key", KEY_CHALLENGE);
const attestation = buildAttestation(pki, {
  appId: APP_ID,
  clientDataHash: createHash("sha256").update(keyClientData).digest(),
  now: NOW
});
const assertClientData = buildAttestClientData("session", ASSERT_CHALLENGE);
const assertion = buildAssertion({
  privateKey: attestation.privateKey,
  appId: APP_ID,
  clientData: Buffer.from(assertClientData, "utf8"),
  counter: 1
});

const output = {
  note: "SYNTHETIC test PKI and App Attest objects. Not Apple-signed; never trust outside tests.",
  appId: APP_ID,
  now: NOW.toISOString(),
  ...pkiJson,
  golden: {
    keyChallenge: KEY_CHALLENGE,
    keyId: attestation.keyId,
    attestationObject: attestation.attestationObject.toString("base64"),
    assertChallenge: ASSERT_CHALLENGE,
    assertion: assertion.toString("base64"),
    assertionCounter: 1
  }
};
writeFileSync(
  fileURLToPath(new URL("./appAttestFixtures.json", import.meta.url)),
  `${JSON.stringify(output, null, 2)}\n`
);
console.info("Wrote appAttestFixtures.json");
