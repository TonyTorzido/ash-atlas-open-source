export type FreshClientNavigation = {
  reason: "update" | "reconnect";
  requiredGameSha?: string;
  restartAttempts?: boolean;
};

export type ExpectedGameRelease = Readonly<{
  gameSha: string;
  attempt: number;
}>;

export type ClientUpdateTarget = Readonly<{
  platform: "web" | "ios" | "android";
  reason: "client-release" | "protocol-incompatible" | "preload-error" | "manual";
  clientSha?: string | null;
  restartAttempts?: boolean;
}>;

export type ApplyClientUpdateResult = "reloading" | "native_noop" | "exhausted";

type ClientUpdateGuard = Readonly<{
  attempts: number;
  targetId: string | null;
  blockedBundles: readonly string[];
}>;

type ClientUpdateLocation = Pick<Location, "origin" | "search" | "replace">;
type ClientUpdateEnvironment = Readonly<{
  location: ClientUpdateLocation;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  caches?: Pick<CacheStorage, "keys" | "delete"> | null;
  serviceWorker?: Pick<ServiceWorkerContainer, "getRegistrations"> | null;
  now: () => number;
  random: () => number;
}>;

type NavigationLocation = Pick<Location, "origin" | "search" | "replace">;
type NormalizableLocation = Pick<Location, "href" | "search">;

export const MAX_FRESH_CLIENT_ATTEMPTS = 3;
export const CLIENT_CONVERGENCE_DIAGNOSTIC_KEY =
  "ash-atlas:client-convergence:last";
export const CLIENT_UPDATE_GUARD_KEY = "ash-atlas:client-update:guard";
export const MAX_CLIENT_UPDATE_ATTEMPTS = 2;

const UPDATE_GUARD_BUNDLE_LIMIT = 12;
let updateNavigationSequence = 0;

const navigatingLocations = new WeakSet<object>();

export function navigateToFreshClient(
  input: FreshClientNavigation,
  locationTarget: NavigationLocation = window.location,
  now: () => number = Date.now
): boolean {
  if (navigatingLocations.has(locationTarget)) return false;
  navigatingLocations.add(locationTarget);

  const url = new URL(isNativeApp() ? "/" : "/play/", locationTarget.origin);
  if (input.requiredGameSha) {
    const current = readExpectedGameRelease(locationTarget);
    const attempt = input.restartAttempts
      ? 1
      : current?.gameSha === input.requiredGameSha
        ? current.attempt + 1
        : 1;
    url.searchParams.set(
      "update",
      `${input.requiredGameSha}.${attempt}.${now()}`
    );
  } else {
    url.searchParams.set(input.reason, String(now()));
  }
  locationTarget.replace(url.toString());
  return true;
}

export async function applyClientUpdate(
  target: ClientUpdateTarget,
  environment: ClientUpdateEnvironment = browserUpdateEnvironment()
): Promise<ApplyClientUpdateResult> {
  if (target.platform !== "web") {
    const { applyNativeLiveUpdate } = await import("./native/nativeLiveUpdate.js");
    const result = await applyNativeLiveUpdate({});
    return result.kind === "reloaded" ? "reloading" : "native_noop";
  }

  const storage = environment.storage;
  const targetId = target.clientSha && /^[a-f0-9]{64}$/u.test(target.clientSha)
    ? target.clientSha
    : target.reason;
  const guard = readClientUpdateGuard(storage, environment.location);
  if (!target.restartAttempts && guard.blockedBundles.includes(targetId)) return "exhausted";

  const attempt = target.restartAttempts
    ? 1
    : guard.targetId === targetId
      ? guard.attempts + 1
      : 1;
  if (attempt > MAX_CLIENT_UPDATE_ATTEMPTS) return "exhausted";

  writeClientUpdateGuard(storage, {
    attempts: attempt,
    targetId,
    blockedBundles: target.restartAttempts ? [] : guard.blockedBundles
  });

  if (attempt === MAX_CLIENT_UPDATE_ATTEMPTS) {
    await clearStaleBrowserCaches(environment);
  }

  const url = new URL("/play/index.html", environment.location.origin);
  for (const [key, value] of new URLSearchParams(environment.location.search)) {
    if (!key.startsWith("aa-client-update")) url.searchParams.append(key, value);
  }
  updateNavigationSequence += 1;
  url.searchParams.set(
    "aa-client-update",
    `${environment.now()}-${attempt}-${updateNavigationSequence}-${Math.floor(environment.random() * 1_000_000)}`
  );
  url.searchParams.set("aa-client-update-attempt", String(attempt));
  url.searchParams.set("aa-client-update-target", targetId);
  environment.location.replace(url.toString());
  return "reloading";
}

export function readClientUpdateGuard(
  storage: Pick<Storage, "getItem"> | null = safeSessionStorage(),
  locationTarget: Pick<Location, "search"> | null = typeof window === "undefined" ? null : window.location
): ClientUpdateGuard {
  if (!storage) return readClientUpdateGuardFromLocation(locationTarget);
  try {
    const raw = storage.getItem(CLIENT_UPDATE_GUARD_KEY);
    if (!raw || raw.length > 2048) return readClientUpdateGuardFromLocation(locationTarget);
    const value = JSON.parse(raw) as Partial<ClientUpdateGuard>;
    const blockedBundles = Array.isArray(value.blockedBundles)
      ? value.blockedBundles.filter((item): item is string => typeof item === "string").slice(-UPDATE_GUARD_BUNDLE_LIMIT)
      : [];
    return {
      attempts: Number.isInteger(value.attempts)
        ? Math.min(MAX_CLIENT_UPDATE_ATTEMPTS, Math.max(0, value.attempts!))
        : 0,
      targetId: typeof value.targetId === "string" ? value.targetId.slice(0, 80) : null,
      blockedBundles
    };
  } catch {
    return readClientUpdateGuardFromLocation(locationTarget);
  }
}

export function blockClientUpdateBundle(
  bundleId: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeSessionStorage()
): void {
  const normalized = bundleId.slice(0, 80);
  if (!normalized) return;
  const guard = readClientUpdateGuard(storage);
  const blockedBundles = [...new Set([...guard.blockedBundles, normalized])].slice(-UPDATE_GUARD_BUNDLE_LIMIT);
  writeClientUpdateGuard(storage, {
    attempts: guard.attempts,
    targetId: guard.targetId,
    blockedBundles
  });
}

export function clearClientUpdateGuard(
  storage: Pick<Storage, "removeItem"> | null = safeSessionStorage()
): void {
  try {
    storage?.removeItem(CLIENT_UPDATE_GUARD_KEY);
  } catch {
    // Recovery state is best-effort when browser storage is unavailable.
  }
}

export function clientUpdateHelpRequired(
  storage: Pick<Storage, "getItem"> | null = safeSessionStorage(),
  locationTarget: Pick<Location, "search"> | null = typeof window === "undefined" ? null : window.location
): boolean {
  return readClientUpdateGuard(storage, locationTarget).attempts >= MAX_CLIENT_UPDATE_ATTEMPTS;
}

function readClientUpdateGuardFromLocation(
  locationTarget: Pick<Location, "search"> | null
): ClientUpdateGuard {
  if (!locationTarget) return { attempts: 0, targetId: null, blockedBundles: [] };
  const params = new URLSearchParams(locationTarget.search);
  const parsedAttempt = Number(params.get("aa-client-update-attempt"));
  const targetId = params.get("aa-client-update-target");
  return {
    attempts: Number.isInteger(parsedAttempt)
      ? Math.min(MAX_CLIENT_UPDATE_ATTEMPTS, Math.max(0, parsedAttempt))
      : 0,
    targetId: targetId ? targetId.slice(0, 80) : null,
    blockedBundles: []
  };
}

function browserUpdateEnvironment(): ClientUpdateEnvironment {
  const browserWindow = window;
  return {
    location: browserWindow.location,
    storage: safeSessionStorage(),
    caches: typeof globalThis.caches === "undefined" ? null : globalThis.caches,
    serviceWorker: "serviceWorker" in navigator ? navigator.serviceWorker : null,
    now: Date.now,
    random: Math.random
  };
}

function safeSessionStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function writeClientUpdateGuard(
  storage: Pick<Storage, "setItem"> | null,
  guard: ClientUpdateGuard
): void {
  try {
    storage?.setItem(CLIENT_UPDATE_GUARD_KEY, JSON.stringify(guard));
  } catch {
    // Keep the update request moving even if storage is full or restricted.
  }
}

async function clearStaleBrowserCaches(environment: ClientUpdateEnvironment): Promise<void> {
  const clearCacheStorage = async (): Promise<void> => {
    const cacheStorage = environment.caches;
    if (cacheStorage) {
      const cacheNames = await cacheStorage.keys();
      await Promise.all(cacheNames.map((name) => cacheStorage.delete(name)));
    }
  };
  const unregisterWorkers = async (): Promise<void> => {
    const registrations = await environment.serviceWorker?.getRegistrations() ?? [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
  };
  await Promise.allSettled([clearCacheStorage(), unregisterWorkers()]);
}

export function readExpectedGameRelease(
  locationTarget: Pick<Location, "search"> = window.location
): ExpectedGameRelease | null {
  const marker = new URLSearchParams(locationTarget.search).get("update");
  if (!marker) return null;
  const parts = marker.split(".");
  const gameSha = parts[0];
  if (!gameSha || !/^[a-f0-9]{40}$/.test(gameSha)) return null;
  const parsedAttempt = parts.length >= 3 ? Number(parts[1]) : 1;
  return {
    gameSha,
    attempt: Number.isInteger(parsedAttempt) && parsedAttempt > 0
      ? Math.min(parsedAttempt, MAX_FRESH_CLIENT_ATTEMPTS + 1)
      : 1
  };
}

export function normalizeExpectedGameReleaseMarker(
  activeGameSha: string,
  locationTarget: NormalizableLocation = window.location,
  historyTarget: Pick<History, "replaceState" | "state"> = window.history
): boolean {
  const expected = readExpectedGameRelease(locationTarget);
  if (expected?.gameSha !== activeGameSha) return false;
  const url = new URL(locationTarget.href);
  url.searchParams.delete("update");
  historyTarget.replaceState(
    historyTarget.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
  return true;
}

export function hasAttemptedRequiredUpdate(
  requiredGameSha: string,
  locationTarget: Pick<Location, "search"> = window.location
): boolean {
  return readExpectedGameRelease(locationTarget)?.gameSha === requiredGameSha;
}

export function recordClientConvergenceDiagnostic(
  currentClientSha: string | null,
  expected: ExpectedGameRelease,
  reason: string
): void {
  try {
    const value = JSON.stringify({
      currentClientSha,
      expectedGameSha: expected.gameSha,
      attempt: expected.attempt,
      reason
    });
    if (value.length <= 512) sessionStorage.setItem(CLIENT_CONVERGENCE_DIAGNOSTIC_KEY, value);
  } catch {
    // Diagnostics must never interfere with client recovery.
  }
}
import { isNativeApp } from "./native/nativeApp.js";
