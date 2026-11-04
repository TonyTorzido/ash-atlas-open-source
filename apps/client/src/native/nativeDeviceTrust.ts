// App.getInfo directly, not nativeApp.js: that module pulls the renderer in.
import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  isFiniteLatLon,
  parseDeviceEnvironment,
  type DeviceEnvironment,
  type NativeLocationSignals
} from "@ash-atlas/shared";

// =============================================================================
// DeviceTrust Capacitor plugin contract (NATIVE_ANTISPOOF_BUILD_PLAN.md §8.1).
// The native shells implement exactly this; the OTA JS feature-detects it.
//
// Plugin name: "DeviceTrust" (Android DeviceTrustPlugin.java, iOS DeviceTrustPlugin.swift).
// Every method resolves a plain object or rejects with a string `code`:
//   UNIMPLEMENTED       method/plugin missing (Capacitor's own code)
//   UNSUPPORTED         the device/OS cannot do this (simulator, no App Attest, ...)
//   PERMISSION_DENIED   location permission not granted (never prompt; just reject)
//   LOCATION_UNAVAILABLE / TIMEOUT
//   KEY_INVALID         App Attest key unknown to the Secure Enclave (JS regenerates)
//   NOT_PREPARED        requestIntegrityToken before prepareIntegrity succeeded
//   SERVER_UNAVAILABLE  Apple/Google service unreachable (retry later, same key)
//   any other short [A-Za-z0-9_:.-] code (e.g. Play's "INTEGRITY_-12"); JS forwards it as clientError.
//
// getCapabilities(): Promise<{
//   v: 1; platform: "android" | "ios";
//   location: boolean;        // getCurrentFix is usable
//   playIntegrity: boolean;   // Android Standard API present
//   appAttest: boolean;       // DCAppAttestService.isSupported (false on simulator)
//   deviceCheck: boolean;     // DCDevice.isSupported
//   environment?: boolean;    // getEnvironment is usable
//   simulator?: boolean
// }>
// getCurrentFix({ enableHighAccuracy: boolean, maximumAgeMs: number, timeoutMs: number }): Promise<{
//   lat: number; lon: number; accuracy?: number;  // metres
//   timestampMs: number;                          // fix time, epoch ms
//   provider?: string;                            // "fused" | "gps" | "network" | "core_location" ...
//   mock?: boolean;          // Android Location.isMock() / isFromMockProvider()
//   simulated?: boolean;     // iOS sourceInformation.isSimulatedBySoftware
//   accessory?: boolean;     // iOS sourceInformation.isProducedByAccessory
//   devOptions?: boolean;    // Android developer options enabled (logged only)
//   reducedAccuracy?: boolean; // approximate location only
//   networkCountryIso?: string // Android TelephonyManager.getNetworkCountryIso(), "" when none
//   gnssSatellitesUsed?: number;    // Android GnssStatus: satellites used in fix (0-255)
//   gnssSatellitesVisible?: number; // Android GnssStatus: satellites in view (0-255)
//   gnssAvgCn0?: number             // Android mean C/N0 of used satellites, dB-Hz (0-100)
// }>  Never requests permission.
// getEnvironment(): Promise<{
//   v: 1;
//   installId: string;              // 8-128 chars [A-Za-z0-9_-]; random per install (iOS: Keychain, survives reinstall)
//   installIdPersistent?: boolean;  // true when installId survives reinstall
//   installSource?: "store" | "testflight" | "sideload" | "unknown";
//   emulatorHints?: string[];       // <= 16 codes, each 1-48 chars [A-Za-z0-9_.:-]; omitted when empty
//   rootHints?: string[];           // same bounds (root / jailbreak)
//   debuggerAttached?: boolean;
//   devOptions?: boolean; adbEnabled?: boolean; autoTimeEnabled?: boolean;  // Android
//   vpnActive?: boolean;
//   simCountryIso?: string | null; networkCountryIso?: string | null;      // 0-3 letters
//   cellMccs?: string[];            // <= 8 three-digit MCCs of visible cells
//   timeZone?: string;              // IANA, <= 64 chars [A-Za-z0-9_+-/]
//   locale?: string                 // BCP-47-ish, <= 35 chars [A-Za-z0-9_-]
// }>  Only v and installId are required; any out-of-bounds field drops the whole block; unknown
//     keys are stripped. Sent with each attestation request, never per fix. Native side:
//     DeviceTrustPlugin.java / DeviceTrustPlugin.swift (getEnvironment).
// prepareIntegrity({ cloudProjectNumber: string }): Promise<void>
//   Android: StandardIntegrityManager.prepareIntegrityToken (warm-up, keep the provider).
// requestIntegrityToken({ clientData: string }): Promise<{ token: string }>
//   Android: requestHash = base64url-no-padding(SHA-256(UTF-8 clientData)); returns the token.
// generateKey(): Promise<{ keyId: string }>              iOS App Attest, keyId base64 (standard)
// attestKey({ keyId: string, clientData: string }): Promise<{ attestationObject: string }>
//   iOS: clientDataHash = SHA-256(UTF-8 clientData) (raw 32 bytes); result base64 (standard).
// generateAssertion({ keyId: string, clientData: string }): Promise<{ assertion: string }>
//   iOS: same clientDataHash rule; result base64 (standard).
// deviceCheckToken(): Promise<{ token: string }>          iOS DCDevice token, base64 (standard)
//
// JS never hashes: clientData is buildAttestClientData() from @ash-atlas/shared.
// =============================================================================

export const DEVICE_TRUST_PLUGIN_NAME = "DeviceTrust";

export type DeviceTrustCapabilities = Readonly<{
  v: number;
  platform: "android" | "ios";
  location: boolean;
  playIntegrity: boolean;
  appAttest: boolean;
  deviceCheck: boolean;
  environment?: boolean;
  simulator?: boolean;
}>;

export type DeviceTrustFixOptions = Readonly<{
  enableHighAccuracy: boolean;
  maximumAgeMs: number;
  timeoutMs: number;
}>;

export type DeviceTrustFix = Readonly<{
  lat: number;
  lon: number;
  accuracy?: number;
  timestampMs: number;
  provider?: string;
  mock?: boolean;
  simulated?: boolean;
  accessory?: boolean;
  devOptions?: boolean;
  reducedAccuracy?: boolean;
  networkCountryIso?: string;
  gnssSatellitesUsed?: number;
  gnssSatellitesVisible?: number;
  gnssAvgCn0?: number;
}>;

export interface DeviceTrustPlugin {
  getCapabilities(): Promise<DeviceTrustCapabilities>;
  getCurrentFix(options: DeviceTrustFixOptions): Promise<DeviceTrustFix>;
  prepareIntegrity(options: { cloudProjectNumber: string }): Promise<void>;
  requestIntegrityToken(options: { clientData: string }): Promise<{ token: string }>;
  generateKey(): Promise<{ keyId: string }>;
  attestKey(options: { keyId: string; clientData: string }): Promise<{ attestationObject: string }>;
  generateAssertion(options: { keyId: string; clientData: string }): Promise<{ assertion: string }>;
  deviceCheckToken(): Promise<{ token: string }>;
  getEnvironment(): Promise<DeviceEnvironment>;
}

/** A plugin that answered getCapabilities() with a well-formed result. */
export type DeviceTrustBridge = Readonly<{
  plugin: DeviceTrustPlugin;
  capabilities: DeviceTrustCapabilities;
}>;

/** A located fix with the wire `native` block that goes beside it. */
export type NativeTrustFix = Readonly<{
  lat: number;
  lon: number;
  accuracy?: number;
  fixTimestampMs: number;
  native: NativeLocationSignals;
}>;

const CLIENT_ERROR_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/u;
const COUNTRY_PATTERN = /^[A-Za-z]{0,3}$/u;
const SHORT_STRING_MAX = 32;

let plugin: DeviceTrustPlugin | null = null;
let detection: Promise<DeviceTrustBridge | null> | null = null;
let shellBuildPromise: Promise<number | undefined> | null = null;

function devicePlugin(): DeviceTrustPlugin {
  return plugin ??= registerPlugin<DeviceTrustPlugin>(DEVICE_TRUST_PLUGIN_NAME);
}

function parseCapabilities(value: unknown): DeviceTrustCapabilities | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const platform = record.platform;
  if (platform !== "android" && platform !== "ios") return null;
  return {
    v: typeof record.v === "number" && Number.isFinite(record.v) ? record.v : 1,
    platform,
    location: record.location === true,
    playIntegrity: record.playIntegrity === true,
    appAttest: record.appAttest === true,
    deviceCheck: record.deviceCheck === true,
    ...(record.environment === true ? { environment: true } : {}),
    ...(record.simulator === true ? { simulator: true } : {})
  };
}

/**
 * The DeviceTrust plugin when this shell has it, otherwise null (web, or a
 * legacy shell: not registered, UNIMPLEMENTED, any rejection or a malformed
 * answer). Cached for the page lifetime; never throws.
 */
export function detectDeviceTrust(): Promise<DeviceTrustBridge | null> {
  return detection ??= (async () => {
    try {
      if (!Capacitor.isNativePlatform()) return null;
      if (typeof Capacitor.isPluginAvailable !== "function" || !Capacitor.isPluginAvailable(DEVICE_TRUST_PLUGIN_NAME)) {
        return null;
      }
      const target = devicePlugin();
      const capabilities = parseCapabilities(await target.getCapabilities());
      return capabilities ? { plugin: target, capabilities } : null;
    } catch {
      return null;
    }
  })();
}

/** Installed shell build number (App.getInfo().build), undefined when unknown. */
export function nativeShellBuild(): Promise<number | undefined> {
  return shellBuildPromise ??= (async () => {
    try {
      if (!Capacitor.isNativePlatform()) return undefined;
      const build = Number.parseInt(String((await App.getInfo()).build), 10);
      return Number.isSafeInteger(build) && build >= 0 ? build : undefined;
    } catch {
      return undefined;
    }
  })();
}

/** The block an OTA bundle sends from a shell without the plugin (⇒ native_legacy). */
export function legacyNativeSignals(shellBuild: number | undefined, pluginPresent = false): NativeLocationSignals {
  return { v: 1, ...(shellBuild === undefined ? {} : { shellBuild }), plugin: pluginPresent };
}

function optionalFlag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Validates a plugin fix and builds its wire `native` block. Null when the fix is unusable. */
export function nativeTrustFixFrom(
  value: unknown,
  shellBuild: number | undefined,
  nowMs: number
): NativeTrustFix | null {
  if (!value || typeof value !== "object") return null;
  const fix = value as Record<string, unknown>;
  const lat = fix.lat;
  const lon = fix.lon;
  if (!isFiniteLatLon(lat, lon)) return null;
  const accuracy = typeof fix.accuracy === "number" && Number.isFinite(fix.accuracy) && fix.accuracy >= 0
    ? fix.accuracy
    : undefined;
  const reported = typeof fix.timestampMs === "number" && Number.isFinite(fix.timestampMs) && fix.timestampMs > 0
    ? Math.trunc(fix.timestampMs)
    : null;
  const fixTimestampMs = reported ?? Math.trunc(nowMs);
  const provider = typeof fix.provider === "string" && fix.provider.length <= SHORT_STRING_MAX ? fix.provider : undefined;
  const country = typeof fix.networkCountryIso === "string" && COUNTRY_PATTERN.test(fix.networkCountryIso)
    ? fix.networkCountryIso
    : undefined;
  const flags: Record<string, boolean> = {};
  for (const key of ["mock", "simulated", "accessory", "devOptions", "reducedAccuracy"] as const) {
    const flag = optionalFlag(fix[key]);
    if (flag !== undefined) flags[key] = flag;
  }
  const native: NativeLocationSignals = {
    v: 1,
    ...(shellBuild === undefined ? {} : { shellBuild }),
    plugin: true,
    ...(provider === undefined ? {} : { provider }),
    ...flags,
    ...(country === undefined ? {} : { networkCountryIso: country }),
    ...gnssFields(fix),
    fixTimestampMs,
    ...(reported === null ? {} : { fixAgeMs: Math.max(0, Math.trunc(nowMs) - reported) })
  };
  return {
    lat,
    lon: lon as number,
    ...(accuracy === undefined ? {} : { accuracy }),
    fixTimestampMs,
    native
  };
}

function gnssFields(fix: Record<string, unknown>): Partial<NativeLocationSignals> {
  const out: Record<string, number> = {};
  for (const key of ["gnssSatellitesUsed", "gnssSatellitesVisible"] as const) {
    const value = fix[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255) out[key] = value;
  }
  const cn0 = fix.gnssAvgCn0;
  if (typeof cn0 === "number" && Number.isFinite(cn0) && cn0 >= 0 && cn0 <= 100) out.gnssAvgCn0 = Math.round(cn0 * 10) / 10;
  return out;
}

/**
 * The device environment block for an attestation request, or undefined when
 * the plugin has none or the answer is out of bounds. Never throws.
 */
export async function readDeviceEnvironment(bridge: DeviceTrustBridge | null): Promise<DeviceEnvironment | undefined> {
  if (!bridge?.capabilities.environment) return undefined;
  try {
    const parsed = parseDeviceEnvironment(await bridge.plugin.getEnvironment());
    return parsed.status === "ok" ? parsed.environment : undefined;
  } catch {
    return undefined;
  }
}

/** The rejection code of a plugin call (Capacitor puts it on `code`). */
export function deviceTrustErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && /not implemented|unimplemented/iu.test(message)) return "UNIMPLEMENTED";
  return "UNKNOWN";
}

/** A code safe for the server's `clientError` field. */
export function deviceTrustClientError(error: unknown): string {
  const code = deviceTrustErrorCode(error);
  return CLIENT_ERROR_PATTERN.test(code) ? code : "UNKNOWN";
}

export function isDeviceTrustPermissionError(error: unknown): boolean {
  const code = deviceTrustErrorCode(error).toLowerCase();
  return code.includes("permission") || code.includes("denied");
}

/** Test seam: forget cached detection and shell build. */
export function resetDeviceTrustForTests(override?: DeviceTrustPlugin | null): void {
  plugin = override ?? null;
  detection = null;
  shellBuildPromise = null;
}
