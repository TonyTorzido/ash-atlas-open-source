import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Bridge to the native "StoreUpdate" plugin. JS owns the decision (server-driven
 * minimum store build); native only reports what the store knows and runs the
 * update UI. Android: Play In-App Updates immediate flow. iOS: opens the App
 * Store page (requires the numeric App Store id from server config).
 * Shells without the plugin reject with UNIMPLEMENTED: use `storeUpdateAvailable()`.
 */

export type StoreUpdateInfo =
  | Readonly<{
      platform: "android";
      currentVersionCode?: number;
      updateAvailability: "available" | "notAvailable" | "inProgress" | "unknown";
      availableVersionCode?: number;
      immediateAllowed?: boolean;
      flexibleAllowed?: boolean;
      /** Play InstallStatus integer. */
      installStatus?: number;
      updatePriority?: number;
      clientVersionStalenessDays?: number;
      /** Set when Play could not be queried (sideloaded/dev install, no Play Store). */
      error?: string;
    }>
  | Readonly<{
      platform: "ios";
      /** iOS cannot query the App Store natively; compare against server config. */
      updateAvailability: "unknown";
      currentVersion?: string;
      currentBuild?: string;
    }>;

export type ImmediateUpdateResult = Readonly<{
  /** Android: "updated" is rarely observed because Play restarts the app. iOS: always "openedStore". */
  result: "updated" | "cancelled" | "failed" | "notAvailable" | "openedStore";
}>;

export interface StoreUpdatePlugin {
  getUpdateInfo(): Promise<StoreUpdateInfo>;
  /** Android: blocking Play update UI (resumes an in-progress one). iOS: opens the App Store page. */
  performImmediateUpdate(options?: { appStoreId?: string }): Promise<ImmediateUpdateResult>;
  /** Opens this app's store page. `appStoreId` (numeric) is required on iOS. */
  openStoreListing(options?: { appStoreId?: string }): Promise<void>;
}

export const StoreUpdate = registerPlugin<StoreUpdatePlugin>("StoreUpdate");

export function storeUpdateAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("StoreUpdate");
}

/** The numeric App Store id inside an apps.apple.com listing URL (the server's NATIVE_IOS_STORE_URL). */
export function appStoreIdFromUrl(storeUrl: string | null | undefined): string | undefined {
  return storeUrl?.match(/\/id(\d{1,20})(?:[/?#]|$)/u)?.[1];
}

/**
 * Required-update action: Android runs the Play immediate update, iOS opens the
 * App Store page. Returns false when the native path did not run (plugin
 * missing or failed) so the caller keeps its plain store link.
 */
export async function runRequiredStoreUpdate(storeUrl: string | null | undefined): Promise<boolean> {
  if (!storeUpdateAvailable()) return false;
  const appStoreId = appStoreIdFromUrl(storeUrl);
  try {
    const { result } = await StoreUpdate.performImmediateUpdate(appStoreId ? { appStoreId } : undefined);
    return result === "updated" || result === "openedStore";
  } catch {
    return false;
  }
}
