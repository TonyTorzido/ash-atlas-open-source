import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { fixAssurance, type FixAttestation } from "./assurance.js";
import { createDeviceCheckClient, createDeviceCheckValidator, deviceCheckJwt } from "./deviceCheckClient.js";
import { createPlayIntegrityDecoder } from "./playIntegrityClient.js";
import {
  evaluatePlayIntegrity,
  normalizeCertDigest,
  parseCertDigestList,
  PLAY_INTEGRITY_MAX_TOKEN_AGE_MS
} from "./playIntegrityVerdict.js";

const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const CERT_HEX = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
const CERT_B64URL = Buffer.from(CERT_HEX.replaceAll(":", ""), "hex").toString("base64url");
const REQUEST_HASH = "q83vASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4k";
const expected = { packageName: "com.ashatlas.game", certDigests: [CERT_B64URL], requestHash: REQUEST_HASH, nowMs: NOW_MS };

function verdict(overrides: {
  request?: Record<string, unknown>;
  app?: Record<string, unknown>;
  device?: string[];
  environment?: Record<string, unknown>;
} = {}) {
  return {
    tokenPayloadExternal: {
      requestDetails: {
        requestPackageName: "com.ashatlas.game",
        requestHash: REQUEST_HASH,
        timestampMillis: String(NOW_MS - 5_000),
        ...overrides.request
      },
      appIntegrity: {
        appRecognitionVerdict: "PLAY_RECOGNIZED",
        packageName: "com.ashatlas.game",
        certificateSha256Digest: [CERT_B64URL],
        versionCode: "42",
        ...overrides.app
      },
      deviceIntegrity: { deviceRecognitionVerdict: overrides.device ?? ["MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY"] },
      accountDetails: { appLicensingVerdict: "LICENSED" },
      environmentDetails: overrides.environment ?? {}
    }
  };
}

describe("certificate digest normalisation", () => {
  it("converts hex with or without colons to base64url without padding", () => {
    expect(normalizeCertDigest(CERT_HEX)).toBe(CERT_B64URL);
    expect(normalizeCertDigest(CERT_HEX.replaceAll(":", "").toLowerCase())).toBe(CERT_B64URL);
    expect(CERT_B64URL).not.toContain("=");
    expect(CERT_B64URL).toHaveLength(43);
    expect(parseCertDigestList(` ${CERT_HEX} , ,${"00".repeat(32)}`)).toEqual([CERT_B64URL, Buffer.alloc(32).toString("base64url")]);
    expect(() => normalizeCertDigest("AB:CD")).toThrow();
    expect(() => parseCertDigestList("zz".repeat(32))).toThrow();
  });
});

describe("evaluatePlayIntegrity", () => {
  it("passes a recognized app on a device that meets device integrity", () => {
    expect(evaluatePlayIntegrity(verdict(), expected)).toMatchObject({
      outcome: "pass",
      assurance: "attested",
      signals: ["attest_pass"],
      summary: { strongIntegrity: false }
    });
    expect(evaluatePlayIntegrity(verdict({ device: ["MEETS_DEVICE_INTEGRITY", "MEETS_STRONG_INTEGRITY"] }), expected).summary)
      .toMatchObject({ strongIntegrity: true });
  });

  it("keeps the optional verdicts (device activity, app access risk, Play Protect) in the summary", () => {
    const payload = verdict({ environment: { appAccessRiskVerdict: { appsDetected: ["KNOWN_INSTALLED"] }, playProtectVerdict: "NO_ISSUES" } });
    (payload.tokenPayloadExternal.deviceIntegrity as Record<string, unknown>).recentDeviceActivity = { deviceActivityLevel: "LEVEL_3" };
    expect(evaluatePlayIntegrity(payload, expected).summary).toMatchObject({
      deviceActivityLevel: "LEVEL_3",
      appsDetected: ["KNOWN_INSTALLED"],
      playProtectVerdict: "NO_ISSUES",
      environmentDetailsPresent: true
    });
    expect(evaluatePlayIntegrity(verdict(), expected).summary).toMatchObject({ deviceActivityLevel: null });
  });

  it("fails basic-only and emulator devices without flagging them", () => {
    expect(evaluatePlayIntegrity(verdict({ device: ["MEETS_BASIC_INTEGRITY"] }), expected)).toMatchObject({
      outcome: "fail", assurance: "unverified", reason: "device_integrity_basic_only", signals: ["attest_device_fail"]
    });
    expect(evaluatePlayIntegrity(verdict({ device: ["MEETS_VIRTUAL_INTEGRITY"] }), expected).reason).toBe("device_integrity_basic_only");
    expect(evaluatePlayIntegrity(verdict({ device: [] }), expected).reason).toBe("device_integrity_none");
  });

  it("treats UNEVALUATED and missing payloads as unavailable", () => {
    expect(evaluatePlayIntegrity(verdict({ app: { appRecognitionVerdict: "UNEVALUATED" } }), expected))
      .toMatchObject({ outcome: "unavailable", assurance: "unverified", signals: [] });
    expect(evaluatePlayIntegrity({}, expected)).toMatchObject({ outcome: "unavailable", reason: "verdict_missing" });
  });

  it("fails app identity checks as app failures", () => {
    const appFail = { outcome: "fail", assurance: "flagged", signals: ["attest_app_fail"] };
    expect(evaluatePlayIntegrity(verdict({ app: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" } }), expected))
      .toMatchObject({ ...appFail, reason: "app_unrecognized" });
    expect(evaluatePlayIntegrity(verdict({ app: { packageName: "com.evil" } }), expected))
      .toMatchObject({ ...appFail, reason: "package_mismatch" });
    expect(evaluatePlayIntegrity(verdict({ request: { requestPackageName: "com.evil" } }), expected))
      .toMatchObject({ ...appFail, reason: "request_package_mismatch" });
    expect(evaluatePlayIntegrity(verdict({ app: { certificateSha256Digest: [Buffer.alloc(32).toString("base64url")] } }), expected))
      .toMatchObject({ ...appFail, reason: "certificate_mismatch" });
  });

  it("flags request binding and stale tokens as tamper", () => {
    const tamper = { outcome: "fail", assurance: "flagged", signals: ["attest_tamper"] };
    expect(evaluatePlayIntegrity(verdict({ request: { requestHash: "other" } }), expected))
      .toMatchObject({ ...tamper, reason: "request_hash_mismatch" });
    expect(evaluatePlayIntegrity(verdict({ request: { timestampMillis: String(NOW_MS - PLAY_INTEGRITY_MAX_TOKEN_AGE_MS - 1) } }), expected))
      .toMatchObject({ ...tamper, reason: "token_stale" });
    expect(evaluatePlayIntegrity(verdict({ request: { timestampMillis: String(NOW_MS + 120_000) } }), expected).reason).toBe("token_stale");
  });

  it("adds a risky-environment signal to a pass", () => {
    expect(evaluatePlayIntegrity(verdict({ environment: { appAccessRiskVerdict: { appsDetected: ["KNOWN_INSTALLED", "UNKNOWN_CAPTURING"] } } }), expected).signals)
      .toEqual(["attest_pass", "attest_risky_env"]);
    expect(evaluatePlayIntegrity(verdict({ environment: { playProtectVerdict: "HIGH_RISK" } }), expected).signals)
      .toEqual(["attest_pass", "attest_risky_env"]);
  });
});

describe("Play Integrity client", () => {
  const auth = { getAccessToken: async () => "access" };
  const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("posts the token and classifies responses", async () => {
    const fetch = vi.fn(async () => response(200, verdict()));
    const decode = createPlayIntegrityDecoder({ packageName: "com.ashatlas.game", timeoutMs: 4000, auth, fetch });
    expect(await decode("token")).toMatchObject({ status: "ok" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://playintegrity.googleapis.com/v1/com.ashatlas.game:decodeIntegrityToken");
    expect(JSON.parse(init.body as string)).toEqual({ integrity_token: "token" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access");
    const status = async (code: number) =>
      createPlayIntegrityDecoder({ packageName: "p", timeoutMs: 4000, auth, fetch: async () => response(code, {}) })("t");
    expect(await status(400)).toEqual({ status: "invalid", code: "http_400" });
    expect(await status(429)).toEqual({ status: "unavailable", code: "http_429" });
    expect(await status(503)).toEqual({ status: "unavailable", code: "http_503" });
    expect(await createPlayIntegrityDecoder({ packageName: "p", timeoutMs: 4000, auth: { getAccessToken: async () => null } })("t"))
      .toEqual({ status: "unavailable", code: "auth_unavailable" });
  });

  it("returns unavailable when the call outlives the timeout", async () => {
    vi.useFakeTimers();
    try {
      const decode = createPlayIntegrityDecoder({
        packageName: "p",
        timeoutMs: 4000,
        auth: { getAccessToken: () => new Promise<string>(() => undefined) }
      });
      const pending = decode("t");
      await vi.advanceTimersByTimeAsync(4000);
      expect(await pending).toEqual({ status: "unavailable", code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DeviceCheck client", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const p8 = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");

  it("signs an ES256 JWT that verifies with the key", () => {
    const token = deviceCheckJwt(privateKey, "KEY123", "ABCDE12345", NOW_MS);
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ iss: "ABCDE12345", iat: NOW_MS / 1000 });
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("maps 200 to valid, 400 to invalid and everything else to unavailable", async () => {
    const validator = (status: number | "throw", environment: "production" | "development" = "production") => {
      const fetch = vi.fn(async () => {
        if (status === "throw") throw new Error("network");
        return new Response("", { status });
      });
      return { fetch, validate: createDeviceCheckValidator({ teamId: "T", keyId: "K", privateKeyP8Base64: p8, environment, timeoutMs: 4000, fetch }) };
    };
    const ok = validator(200, "development");
    expect(await ok.validate("device-token")).toBe("valid");
    expect((ok.fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://api.development.devicecheck.apple.com/v1/validate_device_token");
    expect(await validator(400).validate("x")).toBe("invalid");
    expect(await validator(500).validate("x")).toBe("unavailable");
    expect(await validator("throw").validate("x")).toBe("unavailable");
  });

  it("queries and updates the two DeviceCheck bits", async () => {
    const replies: Response[] = [
      new Response(JSON.stringify({ bit0: true, bit1: false, last_update_time: "2026-09" }), { status: 200 }),
      new Response("Failed to find bit state", { status: 200 }),
      new Response("", { status: 400 }),
      new Response("", { status: 200 })
    ];
    const fetch = vi.fn(async () => replies.shift()!);
    const client = createDeviceCheckClient({ teamId: "T", keyId: "K", privateKeyP8Base64: p8, environment: "production", timeoutMs: 4000, fetch });
    expect(await client.queryBits("tok")).toEqual({ bit0: true, bit1: false, lastUpdateTime: "2026-09" });
    expect(await client.queryBits("tok")).toBe("unset");
    expect(await client.queryBits("tok")).toBe("invalid");
    expect(await client.updateBits("tok", { bit0: true, bit1: false })).toBe("ok");
    const [url, init] = fetch.mock.calls[3] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.devicecheck.apple.com/v1/update_two_bits");
    expect(JSON.parse(String(init.body))).toMatchObject({ device_token: "tok", bit0: true, bit1: false });
  });
});

describe("fixAssurance", () => {
  const attestation = (overrides: Partial<FixAttestation> = {}): FixAttestation => ({
    id: "a", method: "play_integrity", outcome: "pass", assurance: "attested", tamper: false, ...overrides
  });
  const base = { clientPlatform: "android" as const, native: null, attestation: null, mockMode: "shadow" as const, attestationMode: "shadow" as const };

  it("orders web, mock, attestation, plugin and legacy", () => {
    expect(fixAssurance({ ...base, clientPlatform: "web" }).assurance).toBe("web");
    expect(fixAssurance({ ...base, clientPlatform: undefined }).assurance).toBeNull();
    expect(fixAssurance(base)).toEqual({ assurance: "native_legacy", mock: false });
    expect(fixAssurance({ ...base, native: { v: 1, plugin: false } }).assurance).toBe("native_legacy");
    expect(fixAssurance({ ...base, native: { v: 1, plugin: true } }).assurance).toBe("unverified");
    expect(fixAssurance({ ...base, native: { v: 1, plugin: true }, attestation: attestation() }).assurance).toBe("attested");
    expect(fixAssurance({ ...base, attestation: attestation({ method: "devicecheck", assurance: "device_checked" }) }).assurance)
      .toBe("device_checked");
    expect(fixAssurance({ ...base, attestation: attestation({ tamper: true }) }).assurance).toBe("flagged");
    expect(fixAssurance({ ...base, native: { v: 1, plugin: true, mock: true }, attestation: attestation() }))
      .toEqual({ assurance: "flagged", mock: true });
    expect(fixAssurance({ ...base, native: { v: 1, simulated: true } }).mock).toBe(true);
  });

  it("ignores families that are off", () => {
    expect(fixAssurance({ ...base, mockMode: "off", native: { v: 1, mock: true } })).toEqual({ assurance: "native_legacy", mock: false });
    expect(fixAssurance({ ...base, attestationMode: "off", attestation: attestation() }).assurance).toBe("native_legacy");
  });
});
