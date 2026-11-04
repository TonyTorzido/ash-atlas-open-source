import { MOBILE_MENU_HISTORY_KEYS } from "./mobileGameMenu.js";

export const BROWSER_STATE_SCHEMA_KEY = "ash-atlas:browser-state-schema";
export const BROWSER_STATE_SCHEMA_VERSION = 3;
export const BROWSER_STATE_DIAGNOSTIC_KEY = "ash-atlas:browser-state-migration:last";

const CHAT_HISTORY_KEY = "ashAtlasChatOverlay";
const OWNED_CACHE_NAME = /^(?:ash-atlas|ashatlas)(?:[-_:]|$)/i;
const OWNED_WORKBOX_CACHE_NAME = /^workbox-[^:]*ash[-_]?atlas/i;

export type BrowserStateMigrationResult = Readonly<{
  version: number;
  historyKeysRemoved: number;
  serviceWorkersRemoved: number;
  cachesRemoved: number;
  refreshRequired: boolean;
  failures: readonly string[];
}>;

export async function migrateBrowserStateBeforeGameplay(): Promise<BrowserStateMigrationResult> {
  const historyKeysRemoved = sanitizeAshAtlasHistoryState();
  const failures: string[] = [];
  let serviceWorkersRemoved = 0;
  let cachesRemoved = 0;
  const controlledByIncompatibleWorker = isIncompatibleAshAtlasWorkerUrl(
    navigator.serviceWorker?.controller?.scriptURL
  );

  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    for (const registration of registrations) {
      if (!isIncompatibleAshAtlasRegistration(registration)) continue;
      if (await registration.unregister()) serviceWorkersRemoved += 1;
    }
  } catch {
    failures.push("service-worker-cleanup");
  }

  try {
    for (const name of await globalThis.caches?.keys?.() ?? []) {
      // A controlling retired worker may have used an unknown cache name.
      // Clear origin-wide Cache Storage only for that active stale-client case.
      if (!controlledByIncompatibleWorker && !isAshAtlasOwnedCache(name)) continue;
      if (await globalThis.caches.delete(name)) cachesRemoved += 1;
    }
  } catch {
    failures.push("cache-cleanup");
  }

  const result: BrowserStateMigrationResult = {
    version: BROWSER_STATE_SCHEMA_VERSION,
    historyKeysRemoved,
    serviceWorkersRemoved,
    cachesRemoved,
    refreshRequired: controlledByIncompatibleWorker && serviceWorkersRemoved > 0,
    failures
  };
  recordMigrationResult(result);
  if (failures.length === 0) {
    safeStorageSet(localStorage, BROWSER_STATE_SCHEMA_KEY, String(BROWSER_STATE_SCHEMA_VERSION));
  }
  return result;
}

export function sanitizeAshAtlasHistoryState(): number {
  const current = isRecord(history.state) ? { ...history.state } : {};
  let removed = 0;
  for (const key of [...MOBILE_MENU_HISTORY_KEYS, CHAT_HISTORY_KEY]) {
    if (!(key in current)) continue;
    delete current[key];
    removed += 1;
  }
  if (removed > 0) history.replaceState(current, "", window.location.href);
  return removed;
}

export function isAshAtlasOwnedCache(name: string): boolean {
  return OWNED_CACHE_NAME.test(name) || OWNED_WORKBOX_CACHE_NAME.test(name);
}

function isIncompatibleAshAtlasRegistration(registration: ServiceWorkerRegistration): boolean {
  try {
    const scope = new URL(registration.scope);
    const workerUrl = new URL(
      registration.active?.scriptURL ??
        registration.waiting?.scriptURL ??
        registration.installing?.scriptURL ??
        registration.scope
    );
    return scope.origin === window.location.origin &&
      workerUrl.origin === window.location.origin &&
      scope.pathname.startsWith("/play/") &&
      workerUrl.pathname.startsWith("/play/");
  } catch {
    return false;
  }
}

function isIncompatibleAshAtlasWorkerUrl(scriptUrl: string | undefined): boolean {
  if (!scriptUrl) return false;
  try {
    const workerUrl = new URL(scriptUrl);
    return workerUrl.origin === window.location.origin &&
      workerUrl.pathname.startsWith("/play/");
  } catch {
    return false;
  }
}

function recordMigrationResult(result: BrowserStateMigrationResult): void {
  try {
    const bounded = JSON.stringify(result);
    if (bounded.length <= 1_024) sessionStorage.setItem(BROWSER_STATE_DIAGNOSTIC_KEY, bounded);
  } catch {
    // Structural diagnostics must never block gameplay recovery.
  }
}

function safeStorageSet(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Browser state migration remains useful when storage is unavailable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
