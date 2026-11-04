import { z } from "zod";

// Device trust contract (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md §8.2, §8.4).
// Server-side thresholds never live here: this module is shipped to clients.

/** Assurance of one location fix, strongest first. */
export const LOCATION_FIX_ASSURANCES = [
  "attested",
  "device_checked",
  "unverified",
  "native_legacy",
  "web",
  "flagged"
] as const;
export type LocationFixAssurance = (typeof LOCATION_FIX_ASSURANCES)[number];

export const ATTEST_PURPOSES = ["session", "relocation", "ios_key"] as const;
export type AttestPurpose = (typeof ATTEST_PURPOSES)[number];

export type AttestBoundFix = Readonly<{
  lat: number;
  lon: number;
  accuracy?: number | null | undefined;
  fixTimestampMs: number;
}>;

const ATTEST_CLIENT_DATA_PREFIX = "ashatlas-attest-v1";

/**
 * Canonical attestation client data. Native code SHA-256s this string; JS never
 * hashes it. The server rebuilds it with the same toFixed rules and compares
 * strings, never floats.
 */
export function buildAttestClientData(
  purpose: AttestPurpose,
  challenge: string,
  fix?: AttestBoundFix | null
): string {
  const base = `${ATTEST_CLIENT_DATA_PREFIX}\n${purpose}\n${challenge}`;
  if (!fix) return base;
  const formatted = formatAttestBoundFix(fix);
  return `${base}\n${formatted.lat}\n${formatted.lon}\n${formatted.accuracy}\n${formatted.fixTimestampMs}`;
}

/** A fix-bound attestation's fix as the exact strings that were hashed. */
export type FormattedAttestBoundFix = Readonly<{
  lat: string;
  lon: string;
  accuracy: string;
  fixTimestampMs: string;
}>;

/** The toFixed rules of buildAttestClientData; compare these strings, never floats. */
export function formatAttestBoundFix(fix: AttestBoundFix): FormattedAttestBoundFix {
  return {
    lat: fix.lat.toFixed(6),
    lon: fix.lon.toFixed(6),
    accuracy: typeof fix.accuracy === "number" ? fix.accuracy.toFixed(1) : "",
    fixTimestampMs: String(Math.trunc(fix.fixTimestampMs))
  };
}

/** Native signals larger than this (JSON characters) are ignored and flagged. */
export const NATIVE_LOCATION_SIGNALS_MAX_BYTES = 1024;

const optionalBoolean = z.boolean().optional().catch(undefined);
const optionalFiniteNumber = z.number().finite().optional().catch(undefined);
const optionalShortString = (max: number) => z.string().max(max).optional().catch(undefined);

/**
 * Lenient native location signal block sent beside a fix. Unknown keys are
 * stripped and malformed values dropped one by one: a buggy shell must never
 * turn an honest fix into a protocol error.
 */
export const nativeLocationSignalsSchema = z.object({
  v: z.number().int().positive().max(1000).catch(1),
  shellBuild: z.number().int().nonnegative().optional().catch(undefined),
  plugin: optionalBoolean,
  provider: optionalShortString(32),
  mock: optionalBoolean,
  simulated: optionalBoolean,
  accessory: optionalBoolean,
  devOptions: optionalBoolean,
  reducedAccuracy: optionalBoolean,
  networkCountryIso: z.string().regex(/^[A-Za-z]{0,3}$/u).optional().catch(undefined),
  fixTimestampMs: optionalFiniteNumber,
  fixAgeMs: optionalFiniteNumber,
  // Android GNSS status at fix time (satellites used in the fix / in view, mean C/N0 dB-Hz).
  gnssSatellitesUsed: z.number().int().min(0).max(255).optional().catch(undefined),
  gnssSatellitesVisible: z.number().int().min(0).max(255).optional().catch(undefined),
  gnssAvgCn0: z.number().finite().min(0).max(100).optional().catch(undefined)
}).strip();
export type NativeLocationSignals = z.infer<typeof nativeLocationSignalsSchema>;

export type NativeLocationSignalsParse =
  | Readonly<{ status: "absent"; signals: null }>
  | Readonly<{ status: "ok"; signals: NativeLocationSignals }>
  | Readonly<{ status: "malformed"; signals: null }>;

/** Parses the wire `native` field. Oversized or non-object input is malformed. */
export function parseNativeLocationSignals(value: unknown): NativeLocationSignalsParse {
  if (value === undefined || value === null) return { status: "absent", signals: null };
  if (typeof value !== "object" || Array.isArray(value)) return { status: "malformed", signals: null };
  let size: number;
  try {
    size = JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY;
  } catch {
    return { status: "malformed", signals: null };
  }
  if (size > NATIVE_LOCATION_SIGNALS_MAX_BYTES) return { status: "malformed", signals: null };
  const parsed = nativeLocationSignalsSchema.safeParse(value);
  return parsed.success ? { status: "ok", signals: parsed.data } : { status: "malformed", signals: null };
}

/** Opaque reference returned by the attestation endpoints; never trusted beyond its format. */
export const ATTESTATION_REF_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

export function attestationRefFromWire(value: unknown): string | undefined {
  return typeof value === "string" && ATTESTATION_REF_PATTERN.test(value) ? value : undefined;
}

export type TrustAttestationSessionConfig = Readonly<{
  mode: "off" | "shadow" | "enforce";
  android?: Readonly<{ cloudProjectNumber: string }>;
  ios?: Readonly<{ appAttest: boolean; deviceCheck: boolean }>;
  refreshSeconds: number;
}>;

/** POST /api/trust/attest/challenge response. */
export type TrustAttestChallengeResponse = Readonly<{
  challengeId: string;
  // base64url (no padding) of 32 random bytes.
  challenge: string;
  expiresAt: string;
}>;

/** Every attestation endpoint returns this body, identical for pass and fail. */
export type TrustAttestResultResponse = Readonly<{
  attestationRef: string;
  expiresAt: string;
  refreshAfterSeconds: number;
}>;

// -----------------------------------------------------------------------------
// Device environment block (sent with each attestation request, never per fix).
// Strict bounds: any out-of-bounds field rejects the whole block. Every field
// except v and installId is optional so older or partial plugins still validate;
// unknown keys (e.g. a dropped hookingHints) are stripped. Mirrors the native
// contract in apps/client/src/native/nativeDeviceTrust.ts.

export const DEVICE_ENVIRONMENT_MAX_BYTES = 4096;
export const DEVICE_ENVIRONMENT_MAX_HINTS = 16;
export const DEVICE_ENVIRONMENT_MAX_MCCS = 8;
export const DEVICE_INSTALL_SOURCES = ["store", "testflight", "sideload", "unknown"] as const;
export type DeviceInstallSource = (typeof DEVICE_INSTALL_SOURCES)[number];

const environmentCode = z.string().min(1).max(48).regex(/^[A-Za-z0-9_.:-]+$/u);
const environmentHints = z.array(environmentCode).max(DEVICE_ENVIRONMENT_MAX_HINTS);
const countryIso = z.string().max(3).regex(/^[A-Za-z]{0,3}$/u).nullable();

export const deviceEnvironmentSchema = z.object({
  v: z.number().int().positive().max(1000),
  installId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  installIdPersistent: z.boolean().optional(),
  installSource: z.enum(DEVICE_INSTALL_SOURCES).optional(),
  emulatorHints: environmentHints.optional(),
  rootHints: environmentHints.optional(),
  debuggerAttached: z.boolean().optional(),
  devOptions: z.boolean().optional(),
  adbEnabled: z.boolean().optional(),
  autoTimeEnabled: z.boolean().optional(),
  vpnActive: z.boolean().optional(),
  simCountryIso: countryIso.optional(),
  networkCountryIso: countryIso.optional(),
  cellMccs: z.array(z.string().regex(/^\d{3}$/u)).max(DEVICE_ENVIRONMENT_MAX_MCCS).optional(),
  timeZone: z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/u).optional(),
  locale: z.string().min(1).max(35).regex(/^[A-Za-z0-9_-]+$/u).optional()
}).strip();
export type DeviceEnvironment = z.infer<typeof deviceEnvironmentSchema>;

export type DeviceEnvironmentParse =
  | Readonly<{ status: "absent"; environment: null }>
  | Readonly<{ status: "ok"; environment: DeviceEnvironment }>
  | Readonly<{ status: "malformed"; environment: null }>;

/** Parses the attestation request's `environment` field. Oversized or out-of-bounds input is malformed. */
export function parseDeviceEnvironment(value: unknown): DeviceEnvironmentParse {
  if (value === undefined || value === null) return { status: "absent", environment: null };
  if (typeof value !== "object" || Array.isArray(value)) return { status: "malformed", environment: null };
  let size: number;
  try {
    size = JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY;
  } catch {
    return { status: "malformed", environment: null };
  }
  if (size > DEVICE_ENVIRONMENT_MAX_BYTES) return { status: "malformed", environment: null };
  const parsed = deviceEnvironmentSchema.safeParse(value);
  return parsed.success ? { status: "ok", environment: parsed.data } : { status: "malformed", environment: null };
}
