import { Geolocation } from "@capacitor/geolocation";
import { Capacitor } from "@capacitor/core";
import { isFiniteLatLon, type NativeLocationSignals } from "@ash-atlas/shared";

import {
  detectDeviceTrust,
  isDeviceTrustPermissionError,
  legacyNativeSignals,
  nativeShellBuild,
  nativeTrustFixFrom,
  type DeviceTrustFixOptions
} from "../native/nativeDeviceTrust.js";

export type DeviceLocation = Readonly<{
  lat: number;
  lon: number;
  accuracy?: number;
  /**
   * Native app only: the wire `native` signal block for this fix. With the
   * DeviceTrust plugin it carries mock flags and `fixTimestampMs`; a legacy
   * shell sends `{v:1, shellBuild, plugin:false}`.
   */
  native?: NativeLocationSignals;
}>;

export type DeviceLocationErrorCode =
  | "LOCATION_PERMISSION_DENIED"
  | "LOCATION_UNAVAILABLE"
  | "LOCATION_TIMEOUT"
  | "LOCATION_MALFORMED";

export class DeviceLocationError extends Error {
  constructor(
    readonly code: DeviceLocationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DeviceLocationError";
  }
}

const LOCATION_TIMEOUT_MS = 15_000;
// Passive reads accept a cached fix at most this old.
export const PASSIVE_LOCATION_MAX_AGE_MS = 30_000;

// Web only: set after this page session obtained a fix through the explicit
// relocation flow, so the passive read can never be the first permission ask.
let browserLocationGrantedThisSession = false;

export function getCurrentDeviceLocation(): Promise<DeviceLocation> {
  if (Capacitor.isNativePlatform()) return getNativeDeviceLocation();
  return getBrowserDeviceLocation().then((location) => {
    browserLocationGrantedThisSession = true;
    return location;
  });
}

/** IANA time zone reported by the device, or undefined when unavailable. */
export function getDeviceTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.length > 0 && zone.length <= 64 ? zone : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a passive read may run without any chance of a permission prompt:
 * native needs precise location already granted; web needs a relocation fix
 * in this page session and, where the Permissions API exists, `granted`.
 * Never requests permission; resolves false on any failure.
 */
export async function hasPassiveLocationPermission(): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      const permissions = await Geolocation.checkPermissions();
      return permissions.location === "granted";
    }
    if (!browserLocationGrantedThisSession) return false;
    if (typeof navigator === "undefined" || typeof navigator.geolocation?.getCurrentPosition !== "function") {
      return false;
    }
    if (typeof navigator.permissions?.query === "function") {
      const status = await navigator.permissions.query({ name: "geolocation" });
      if (status.state !== "granted") return false;
    }
    return true;
  } catch {
    return false;
  }
}

export type PassiveLocationOptions = Readonly<{
  maximumAgeMs?: number;
  timeoutMs?: number;
}>;

/**
 * One best-effort fix for the location trust ledger. Never prompts: it reads
 * only when hasPassiveLocationPermission() holds (checked on every call).
 * Resolves null otherwise and on any failure.
 */
export async function getPassiveDeviceLocation(
  options: PassiveLocationOptions = {}
): Promise<DeviceLocation | null> {
  const maximumAge = Math.min(options.maximumAgeMs ?? PASSIVE_LOCATION_MAX_AGE_MS, PASSIVE_LOCATION_MAX_AGE_MS);
  const timeout = options.timeoutMs ?? LOCATION_TIMEOUT_MS;
  try {
    if (!(await hasPassiveLocationPermission())) return null;
    if (Capacitor.isNativePlatform()) {
      return await readNativeLocation({ enableHighAccuracy: false, maximumAgeMs: maximumAge, timeoutMs: timeout }, "passive");
    }
    return await new Promise<DeviceLocation | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(deviceLocationFromCoords(position?.coords)),
        () => resolve(null),
        { enableHighAccuracy: false, maximumAge, timeout }
      );
    });
  } catch {
    return null;
  }
}

function deviceLocationFromCoords(
  coords: { latitude?: unknown; longitude?: unknown; accuracy?: unknown } | null | undefined
): DeviceLocation | null {
  const lat = coords?.latitude;
  const lon = coords?.longitude;
  if (!isFiniteLatLon(lat, lon)) return null;
  const accuracy = coords?.accuracy;
  return {
    lat,
    lon: lon as number,
    ...(typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {})
  };
}

async function getNativeDeviceLocation(): Promise<DeviceLocation> {
  try {
    let permissions = await Geolocation.checkPermissions();
    const approximateAllowed = (): boolean => Capacitor.getPlatform() === "android" && permissions.coarseLocation === "granted";
    if (permissions.location === "denied" && !approximateAllowed()) {
      throw new DeviceLocationError(
        "LOCATION_PERMISSION_DENIED",
        "Location permission is required to relocate."
      );
    }
    if (permissions.location !== "granted" && !approximateAllowed()) {
      permissions = await Geolocation.requestPermissions({ permissions: ["location"] });
      if (permissions.location !== "granted" && !approximateAllowed()) {
        throw new DeviceLocationError(
          "LOCATION_PERMISSION_DENIED",
          "Location permission is required to relocate."
        );
      }
    }
    const location = await readNativeLocation({
      enableHighAccuracy: permissions.location === "granted",
      maximumAgeMs: 0,
      timeoutMs: LOCATION_TIMEOUT_MS
    }, "relocation");
    if (!location) {
      throw new DeviceLocationError(
        "LOCATION_MALFORMED",
        "Your device returned an invalid location. Try again."
      );
    }
    return location;
  } catch (error) {
    if (error instanceof DeviceLocationError) throw error;
    const code = String((error as { code?: unknown })?.code ?? "").toLowerCase();
    const message = String((error as { message?: unknown })?.message ?? "");
    if (code.includes("permission") || code.includes("denied") || /permission|denied/i.test(message)) {
      throw new DeviceLocationError(
        "LOCATION_PERMISSION_DENIED",
        "Location permission is required to relocate."
      );
    }
    if (code.includes("timeout") || /timeout/i.test(message)) {
      throw new DeviceLocationError(
        "LOCATION_TIMEOUT",
        "Your device took too long to provide a location. Try again."
      );
    }
    throw new DeviceLocationError(
      "LOCATION_UNAVAILABLE",
      "Ash Atlas could not access your current location."
    );
  }
}

/**
 * One native fix with its `native` block. The DeviceTrust plugin is preferred
 * (mock flags, fix time); a legacy shell, or a relocation whose plugin read
 * failed for any reason but permission, uses @capacitor/geolocation. A passive
 * read never falls back: no plugin fix, no report. Never prompts.
 */
async function readNativeLocation(
  options: DeviceTrustFixOptions,
  purpose: "relocation" | "passive"
): Promise<DeviceLocation | null> {
  const [bridge, shellBuild] = await Promise.all([detectDeviceTrust(), nativeShellBuild()]);
  if (bridge?.capabilities.location) {
    try {
      const fix = nativeTrustFixFrom(await bridge.plugin.getCurrentFix(options), shellBuild, Date.now());
      if (fix) {
        return {
          lat: fix.lat,
          lon: fix.lon,
          ...(fix.accuracy === undefined ? {} : { accuracy: fix.accuracy }),
          native: fix.native
        };
      }
      if (purpose === "passive") return null;
    } catch (error) {
      if (purpose === "passive") return null;
      if (isDeviceTrustPermissionError(error)) {
        throw new DeviceLocationError("LOCATION_PERMISSION_DENIED", "Location permission is required to relocate.");
      }
    }
  }
  const position = await Geolocation.getCurrentPosition({
    enableHighAccuracy: options.enableHighAccuracy,
    maximumAge: options.maximumAgeMs,
    timeout: options.timeoutMs
  });
  const location = deviceLocationFromCoords(position?.coords);
  if (!location) return null;
  const native = legacyNativeSignals(shellBuild, bridge !== null);
  const timestamp = (position as { timestamp?: unknown } | undefined)?.timestamp;
  return {
    ...location,
    native: bridge !== null && typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
      ? { ...native, fixTimestampMs: Math.trunc(timestamp) }
      : native
  };
}

function getBrowserDeviceLocation(): Promise<DeviceLocation> {
  if (
    typeof navigator === "undefined" ||
    !navigator.geolocation ||
    typeof navigator.geolocation.getCurrentPosition !== "function"
  ) {
    return Promise.reject(new DeviceLocationError(
      "LOCATION_UNAVAILABLE",
      "This device cannot provide a current location."
    ));
  }
  return new Promise((resolve, reject) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const lat = position?.coords?.latitude;
          const lon = position?.coords?.longitude;
          if (!isFiniteLatLon(lat, lon)) {
            reject(new DeviceLocationError(
              "LOCATION_MALFORMED",
              "Your device returned an invalid location. Try again."
            ));
            return;
          }
          const accuracy = position.coords.accuracy;
          resolve({
            lat,
            lon,
            ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {})
          });
        },
        (error) => {
          if (error?.code === 1) {
            reject(new DeviceLocationError(
              "LOCATION_PERMISSION_DENIED",
              "Location permission is required to relocate."
            ));
            return;
          }
          if (error?.code === 3) {
            reject(new DeviceLocationError(
              "LOCATION_TIMEOUT",
              "Your device took too long to provide a location. Try again."
            ));
            return;
          }
          reject(new DeviceLocationError(
            "LOCATION_UNAVAILABLE",
            "Ash Atlas could not access your current location."
          ));
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: LOCATION_TIMEOUT_MS
        }
      );
    } catch {
      reject(new DeviceLocationError(
        "LOCATION_UNAVAILABLE",
        "Ash Atlas could not access your current location."
      ));
    }
  });
}
