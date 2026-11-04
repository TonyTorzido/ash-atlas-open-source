import { Capacitor, registerPlugin } from "@capacitor/core";
import { FirebaseCrashlytics } from "@capacitor-firebase/crashlytics";

/**
 * Crash reporting (Firebase Crashlytics) ships disabled: the native manifest /
 * Info.plist turn automatic collection off, and the Firebase config is bundled
 * only when the store build input provides it. Never call FirebaseCrashlytics
 * directly: on iOS the SDK asserts when Firebase is not configured, so every
 * call must go through `crashReportingConfigured()` first.
 */

const nativeRuntime = registerPlugin<{
  getShellCapabilities(): Promise<{ firebaseConfigured: boolean }>;
}>("NativeRuntime");

let configured: Promise<boolean> | undefined;

export function crashReportingConfigured(): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("FirebaseCrashlytics")) return Promise.resolve(false);
  // Older shells reject getShellCapabilities with UNIMPLEMENTED.
  return configured ??= nativeRuntime.getShellCapabilities()
    .then((capabilities) => capabilities.firebaseConfigured === true)
    .catch(() => false);
}

/** Turns collection on/off (server-driven). Returns false when this shell cannot report crashes. */
export async function setCrashReportingEnabled(enabled: boolean): Promise<boolean> {
  if (!(await crashReportingConfigured())) return false;
  await FirebaseCrashlytics.setEnabled({ enabled });
  return true;
}

async function accountIdHash(accountId: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ash-atlas-crashlytics:${accountId}`));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/**
 * Starts collection for a signed-in account. Only runs when the shell reports
 * firebaseConfigured; the user id is a one-way hash of the account id (never an
 * email or display name). Returns false when this shell cannot report crashes.
 */
export async function startCrashReporting(accountId: string): Promise<boolean> {
  if (!(await crashReportingConfigured())) return false;
  const userId = await accountIdHash(accountId);
  if (userId) await FirebaseCrashlytics.setUserId({ userId });
  await FirebaseCrashlytics.setEnabled({ enabled: true });
  return true;
}
