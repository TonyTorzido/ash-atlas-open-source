import {
  attestAppFail,
  attestDeviceFail,
  attestPass,
  attestTamper,
  attestUnavailable,
  type AttestSignalRule,
  type AttestVerdict
} from "./assurance.js";

// Play Integrity Standard API verdict evaluation (NATIVE_ANTISPOOF_BUILD_PLAN.md §8.1, §8.5).
// Pure: no network, no clock.

/** Token older than this (Google timestamp vs server clock) is a replay. */
export const PLAY_INTEGRITY_MAX_TOKEN_AGE_MS = 300_000;
// Google stamps the token; allow small clock skew into the future.
const MAX_FUTURE_SKEW_MS = 60_000;

const HEX_DIGEST = /^[0-9a-f]{64}$/u;

/**
 * Play Console shows the app signing SHA-256 as colon-separated hex; Play
 * Integrity returns certificateSha256Digest as base64url without padding.
 * Accepts hex (colons optional, any case) and returns base64url (no padding).
 */
export function normalizeCertDigest(value: string): string {
  const hex = value.trim().replaceAll(":", "").toLowerCase();
  if (!HEX_DIGEST.test(hex)) throw new Error("certificate digest must be 32 bytes of hex");
  return Buffer.from(hex, "hex").toString("base64url");
}

/** CSV of hex digests ⇒ base64url digests. Throws on any malformed entry. */
export function parseCertDigestList(csv: string): string[] {
  return csv.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0).map(normalizeCertDigest);
}

export type PlayIntegrityExpectation = Readonly<{
  packageName: string;
  // base64url (no padding), already normalized.
  certDigests: readonly string[];
  // base64url (no padding) SHA-256 of the canonical client data.
  requestHash: string;
  nowMs: number;
}>;

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const string = (value: unknown): string | null => (typeof value === "string" ? value : null);

const RISKY_APPS = new Set(["UNKNOWN_CAPTURING", "UNKNOWN_CONTROLLING", "UNKNOWN_OVERLAYS"]);
const RISKY_PLAY_PROTECT = new Set(["HIGH_RISK", "MEDIUM_RISK", "POSSIBLE_RISK"]);

/**
 * Evaluates a decodeIntegrityToken response. Pass = PLAY_RECOGNIZED +
 * MEETS_DEVICE_INTEGRITY + package + certificate allowlist + requestHash +
 * fresh timestamp. Basic-only device integrity fails; UNEVALUATED is unavailable.
 */
export function evaluatePlayIntegrity(response: unknown, expected: PlayIntegrityExpectation): AttestVerdict {
  const payload = object(object(response)?.tokenPayloadExternal);
  if (!payload) return attestUnavailable("verdict_missing");
  const request = object(payload.requestDetails);
  const app = object(payload.appIntegrity);
  const device = object(payload.deviceIntegrity);
  const environment = object(payload.environmentDetails);
  const deviceVerdicts = strings(device?.deviceRecognitionVerdict);
  const appVerdict = string(app?.appRecognitionVerdict);
  const appsDetected = strings(object(environment?.appAccessRiskVerdict)?.appsDetected);
  const playProtect = string(environment?.playProtectVerdict);
  const timestampMs = Number(request?.timestampMillis);
  const summary: Record<string, unknown> = {
    appRecognitionVerdict: appVerdict,
    deviceRecognitionVerdict: deviceVerdicts.slice(0, 8),
    strongIntegrity: deviceVerdicts.includes("MEETS_STRONG_INTEGRITY"),
    appLicensingVerdict: string(object(payload.accountDetails)?.appLicensingVerdict),
    versionCode: string(app?.versionCode) ?? (typeof app?.versionCode === "number" ? String(app.versionCode) : null),
    appsDetected: appsDetected.slice(0, 8),
    playProtectVerdict: playProtect,
    // Optional verdicts (enabled per app in Play Console): device activity and environment details.
    deviceActivityLevel: string(object(device?.recentDeviceActivity)?.deviceActivityLevel),
    environmentDetailsPresent: environment !== null,
    tokenAgeMs: Number.isFinite(timestampMs) ? expected.nowMs - timestampMs : null
  };

  // Request binding first: a token minted for another challenge or fix is tamper.
  if (!request || string(request.requestHash) !== expected.requestHash) {
    return attestTamper("request_hash_mismatch", summary);
  }
  if (!Number.isFinite(timestampMs)
    || expected.nowMs - timestampMs > PLAY_INTEGRITY_MAX_TOKEN_AGE_MS
    || timestampMs - expected.nowMs > MAX_FUTURE_SKEW_MS) {
    return attestTamper("token_stale", summary);
  }
  if (string(request.requestPackageName) !== expected.packageName) {
    return attestAppFail("request_package_mismatch", summary);
  }
  if (appVerdict === "UNEVALUATED" || appVerdict === null) return attestUnavailable("app_unevaluated", summary);
  if (appVerdict !== "PLAY_RECOGNIZED") return attestAppFail("app_unrecognized", summary);
  if (string(app?.packageName) !== expected.packageName) return attestAppFail("package_mismatch", summary);
  const digests = strings(app?.certificateSha256Digest);
  if (!digests.some((digest) => expected.certDigests.includes(digest))) {
    return attestAppFail("certificate_mismatch", summary);
  }
  if (!deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY")) {
    return attestDeviceFail(deviceVerdicts.length === 0 ? "device_integrity_none" : "device_integrity_basic_only", summary);
  }
  const risky: AttestSignalRule[] = appsDetected.some((entry) => RISKY_APPS.has(entry))
    || (playProtect !== null && RISKY_PLAY_PROTECT.has(playProtect))
    ? ["attest_risky_env"]
    : [];
  return attestPass("attested", summary, risky);
}
