import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { LiveUpdate, type DownloadBundleProgressEvent, type ReadyResult } from "@capawesome/capacitor-live-update";
import {
  ASH_ATLAS_MAX_PROTOCOL_VERSION,
  ASH_ATLAS_MIN_PROTOCOL_VERSION,
  validateNativeBundleDescriptor,
  type NativeBundleDescriptor
} from "@ash-atlas/shared";

import { clientConfig } from "../config.js";
import { boundedFetch } from "./nativeRequest.js";
import { recordNativeDiagnostic } from "./nativeDiagnostics.js";
import {
  checkNativeCompatibility,
  type NativeCompatibilityUpdateStatus
} from "./nativeCompatibility.js";
import {
  isNativeApp,
  readNativeAppInfo,
  type NativeAppInfo
} from "./nativeApp.js";

const DESCRIPTOR_PATH = "/api/native/bundle";
const NATIVE_PRE_APPLY_CHECK_TIMEOUT_MS = 4_000;

export type NativeLiveUpdateProgress = Readonly<{
  phase: "checking" | "downloading";
  loadedBytes: number;
  totalBytes: number | null;
}>;

export type NativeLiveUpdateProtocolRange = Readonly<{ min: number; max: number }>;

export type NativeLiveUpdatePreparationResult =
  | { kind: "skipped" | "current" | "unavailable" }
  | { kind: "shell_update_required"; requiredBuild: number }
  | { kind: "protocol_incompatible"; descriptor: NativeBundleDescriptor; serverProtocolRange: NativeLiveUpdateProtocolRange }
  | { kind: "blocked" | "failed"; bundleId: string; message: string }
  | { kind: "prepared"; descriptor: NativeBundleDescriptor; updateStatus?: NativeCompatibilityUpdateStatus }
  | { kind: "reloaded"; bundleId: string };

export type NativeLiveUpdatePreparationOptions = Readonly<{
  serverHttpBase?: string;
  appInfo?: NativeAppInfo;
  fetcher?: typeof fetch;
  checkTimeoutMs?: number;
  serverProtocolRange?: NativeLiveUpdateProtocolRange;
  applyOnDownload?: boolean;
  reloadOnApply?: boolean;
  onProgress?: (progress: NativeLiveUpdateProgress) => void;
  // Awaited after a compatible update is found and before it downloads, so
  // the player can be shown the update's version and size first.
  onUpdateFound?: (descriptor: NativeBundleDescriptor) => Promise<void>;
}>;

export class NativeLiveUpdateUnavailableError extends Error {
  constructor(message = "The Ash Atlas update service is unavailable") {
    super(message);
    this.name = "NativeLiveUpdateUnavailableError";
  }
}

export function nativeLiveUpdateDescriptorEndpoint(serverHttpBase: string): string {
  return new URL(DESCRIPTOR_PATH, serverHttpBase).toString();
}

export async function readNativeLiveUpdateDescriptor(
  serverHttpBase: string,
  appInfo: NativeAppInfo,
  currentBundleId: string | null,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal
): Promise<NativeBundleDescriptor | null> {
  const url = new URL(nativeLiveUpdateDescriptorEndpoint(serverHttpBase));
  url.searchParams.set("platform", appInfo.platform);
  url.searchParams.set("shellBuild", String(appInfo.build));
  url.searchParams.set("bundle", currentBundleId ?? "");

  let response: Response;
  try {
    response = await abortable(boundedFetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      ...(signal ? { signal } : {})
    }, fetcher), signal);
  } catch {
    throw new NativeLiveUpdateUnavailableError();
  }
  if (response.status === 204) return null;
  if (response.status !== 200) throw new NativeLiveUpdateUnavailableError();

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The Ash Atlas update descriptor is invalid");
  }
  const descriptor = validateNativeBundleDescriptor(payload);
  if (descriptor.platform !== appInfo.platform) {
    throw new Error("The Ash Atlas update targets a different platform");
  }
  if (descriptor.minShellBuild > appInfo.build) {
    throw new NativeShellUpdateRequiredError(descriptor.minShellBuild);
  }
  return descriptor;
}

const LIVE_UPDATE_MANIFEST = "capawesome-live-update-manifest.json";

type LiveUpdateManifestEntry = Readonly<{ href: string; checksum: string; sizeInBytes: number }>;

// The bytes the player will actually download. A manifest bundle fetches only
// files that differ from the installed bundle, so the two signed file lists are
// compared; a zip bundle downloads whole. Null when the size can't be known.
export async function readNativeUpdateDownloadBytes(
  descriptor: NativeBundleDescriptor,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  installedBase: string = document.baseURI
): Promise<number | null> {
  if (descriptor.artifactType === "zip") return descriptor.sizeBytes;
  try {
    const [next, installed] = await Promise.all([
      readLiveUpdateManifest(new URL(LIVE_UPDATE_MANIFEST, descriptor.url), fetcher),
      readLiveUpdateManifest(new URL(LIVE_UPDATE_MANIFEST, installedBase), fetcher).catch(() => [])
    ]);
    const present = new Set(installed.map((entry) => `${entry.href}
${entry.checksum}`));
    const bytes = next.reduce((total, entry) =>
      present.has(`${entry.href}
${entry.checksum}`) ? total : total + entry.sizeInBytes, 0);
    return bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

async function readLiveUpdateManifest(
  url: URL,
  fetcher: typeof fetch
): Promise<readonly LiveUpdateManifestEntry[]> {
  const response = await boundedFetch(url, { method: "GET", cache: "no-store" }, fetcher);
  if (!response.ok) throw new Error("The update file list is unavailable");
  const entries: unknown = await response.json();
  if (!Array.isArray(entries) || !entries.every((entry: unknown) =>
    entry !== null && typeof entry === "object" &&
    typeof (entry as LiveUpdateManifestEntry).href === "string" &&
    typeof (entry as LiveUpdateManifestEntry).checksum === "string" &&
    Number.isSafeInteger((entry as LiveUpdateManifestEntry).sizeInBytes) &&
    (entry as LiveUpdateManifestEntry).sizeInBytes >= 0
  )) throw new Error("The update file list is invalid");
  return entries as LiveUpdateManifestEntry[];
}

export async function markNativeLiveUpdateReady(): Promise<ReadyResult | null> {
  if (!isNativeApp()) return null;
  return nativeReadyPromise ??= LiveUpdate.ready().then((result) => {
    if (result.rollback) {
      recordNativeDiagnostic("ota_rollback", result.previousBundleId ?? "default");
    }
    return result;
  }).catch(() => {
    // A browser build or an older shell without the optional live-update
    // plugin must keep the existing startup path usable.
    return null;
  });
}

// A store update makes Capacitor boot the built-in seed again: Bridge.isNewBinary
// (Android) and CAPBridgeViewController.isNewBinary (iOS) clear the saved bundle
// path whenever the binary's version changes, and Capawesome 8.4.3 has no option
// to keep it. ready() would then delete the downloaded full bundle
// (autoDeleteBundles keeps only the current and next bundles). The seed calls this
// instead of ready(): it marks a kept, unblocked bundle as next so ready() keeps
// it, then reloads into it. That bundle's own launch check brings it current
// before play. If it fails to start, the plugin rolls back to the seed and blocks
// it, so the next launch falls through to the normal first-run download.
// Resolves true when the app is reloading into the kept bundle.
export async function restoreKeptNativeBundle(): Promise<boolean> {
  if (!isNativeApp()) return false;
  let keptBundleId: string | undefined;
  try {
    if ((await LiveUpdate.getCurrentBundle()).bundleId) return false;
    const [{ bundleIds }, { bundleIds: blocked }] = await Promise.all([
      LiveUpdate.getDownloadedBundles(),
      LiveUpdate.getBlockedBundles()
    ]);
    keptBundleId = bundleIds.filter((bundleId) => !blocked.includes(bundleId)).sort().at(-1);
    if (keptBundleId) await LiveUpdate.setNextBundle({ bundleId: keptBundleId });
  } catch {
    keptBundleId = undefined;
  }
  await markNativeLiveUpdateReady();
  if (!keptBundleId) return false;
  try {
    // ready() blocks a bundle that just rolled back to the seed.
    if ((await LiveUpdate.getBlockedBundles()).bundleIds.includes(keptBundleId)) {
      await LiveUpdate.reset();
      return false;
    }
    await LiveUpdate.reload();
    return true;
  } catch {
    await LiveUpdate.reset().catch(() => undefined);
    return false;
  }
}

export async function readCurrentNativeBundleId(): Promise<string | null> {
  if (!isNativeApp()) return null;
  try {
    return (await LiveUpdate.getCurrentBundle()).bundleId ?? null;
  } catch {
    return null;
  }
}

let nativeReadyPromise: Promise<ReadyResult | null> | undefined;
const preparedBundles = new Map<string, Readonly<{
  descriptor: NativeBundleDescriptor;
  appInfo: NativeAppInfo;
  currentBundleId: string | null;
  serverProtocolRange: NativeLiveUpdateProtocolRange;
  serverHttpBase: string;
  fetcher: typeof fetch;
}>>();
let nativeBundleCheckedThisLaunch = false;

export function hasCheckedNativeLiveUpdateThisLaunch(): boolean {
  return nativeBundleCheckedThisLaunch;
}

export async function prepareNativeLiveUpdate(
  options: NativeLiveUpdatePreparationOptions = {}
): Promise<NativeLiveUpdatePreparationResult> {
  if (!isNativeApp()) return { kind: "skipped" };
  const appInfo = options.appInfo ?? await readNativeAppInfo().catch(() => null);
  if (!appInfo) return { kind: "unavailable" };

  let currentBundleId: string | null;
  let blockedBundleIds: readonly string[];
  try {
    currentBundleId = (await LiveUpdate.getCurrentBundle()).bundleId ?? null;
    blockedBundleIds = (await LiveUpdate.getBlockedBundles()).bundleIds;
  } catch {
    return { kind: "unavailable" };
  }

  const serverHttpBase = options.serverHttpBase ?? clientConfig.serverHttpBase;
  const fetcher = options.fetcher;
  const checkController = options.checkTimeoutMs === undefined
    ? null
    : new AbortController();
  const checkTimeout = checkController
    ? globalThis.setTimeout(() => checkController.abort(), options.checkTimeoutMs)
    : null;
  options.onProgress?.({ phase: "checking", loadedBytes: 0, totalBytes: null });

  let descriptor: NativeBundleDescriptor | null;
  let updateStatus: NativeCompatibilityUpdateStatus | undefined;
  let serverProtocolRange = options.serverProtocolRange;
  try {
    descriptor = await readNativeLiveUpdateDescriptor(
      serverHttpBase,
      appInfo,
      currentBundleId,
      fetcher,
      checkController?.signal
    );
    if (descriptor && !blockedBundleIds.includes(descriptor.bundleId) && !serverProtocolRange) {
      const compatibility = await abortable(checkNativeCompatibility(serverHttpBase, {
        platform: appInfo.platform,
        version: appInfo.version,
        build: appInfo.build,
        wsMin: ASH_ATLAS_MIN_PROTOCOL_VERSION,
        wsMax: ASH_ATLAS_MAX_PROTOCOL_VERSION
      }, fetcher ?? globalThis.fetch.bind(globalThis), checkController?.signal), checkController?.signal);
      updateStatus = compatibility.updateStatus;
      if (updateStatus === "shell_update_required") {
        return {
          kind: "shell_update_required",
          requiredBuild: Math.max(descriptor.minShellBuild, compatibility.hardMinimum.build)
        };
      }
      serverProtocolRange = { min: compatibility.wsMin, max: compatibility.wsMax };
    }
  } catch (error) {
    if (error instanceof NativeShellUpdateRequiredError) {
      return { kind: "shell_update_required", requiredBuild: error.requiredBuild };
    }
    if (error instanceof NativeLiveUpdateUnavailableError) return { kind: "unavailable" };
    return {
      kind: "failed",
      bundleId: "unknown",
      message: error instanceof Error ? error.message : "The Ash Atlas update descriptor is invalid"
    };
  } finally {
    nativeBundleCheckedThisLaunch = true;
    if (checkTimeout !== null) globalThis.clearTimeout(checkTimeout);
  }
  if (!descriptor) return { kind: "current" };
  if (blockedBundleIds.includes(descriptor.bundleId)) {
    return {
      kind: "blocked",
      bundleId: descriptor.bundleId,
      message: "This update was blocked after a failed startup. Continue with the installed version."
    };
  }
  if (serverProtocolRange && !nativeBundleProtocolRangesOverlap(
    { min: descriptor.protocolMin, max: descriptor.protocolMax },
    serverProtocolRange
  )) {
    return { kind: "protocol_incompatible", descriptor, serverProtocolRange };
  }
  await options.onUpdateFound?.(descriptor);
  options.onProgress?.({
    phase: "downloading",
    loadedBytes: 0,
    totalBytes: descriptor.sizeBytes
  });
  let progressListener: { remove(): Promise<void> } | null = null;
  try {
    progressListener = await LiveUpdate.addListener(
      "downloadBundleProgress",
      (event: DownloadBundleProgressEvent) => {
        if (event.bundleId !== descriptor.bundleId) return;
        const totalBytes = Number.isSafeInteger(event.totalBytes) && event.totalBytes > 0
          ? event.totalBytes
          : descriptor.sizeBytes;
        const loadedBytes = Number.isSafeInteger(event.downloadedBytes) && event.downloadedBytes >= 0
          ? event.downloadedBytes
          : 0;
        options.onProgress?.({
          phase: "downloading",
          loadedBytes: totalBytes === null ? loadedBytes : Math.min(loadedBytes, totalBytes),
          totalBytes
        });
      }
    );
  } catch {
    // The native download remains safe without progress events.
  }

  let bundleDownloaded = false;
  try {
    await LiveUpdate.downloadBundle({
      artifactType: descriptor.artifactType,
      bundleId: descriptor.bundleId,
      ...(descriptor.artifactType === "zip"
        ? { checksum: descriptor.checksum, signature: descriptor.signature }
        : {}),
      url: descriptor.url
    });
    bundleDownloaded = true;
    const activeDescriptor = await readNativeLiveUpdateDescriptor(
      serverHttpBase,
      appInfo,
      currentBundleId,
      fetcher
    );
    if (!activeDescriptor || !sameNativeLiveUpdateDescriptor(activeDescriptor, descriptor)) {
      throw new Error("The Ash Atlas update changed while it was downloading");
    }
    preparedBundles.set(descriptor.bundleId, {
      descriptor,
      appInfo,
      currentBundleId,
      serverProtocolRange: serverProtocolRange ?? {
        min: ASH_ATLAS_MIN_PROTOCOL_VERSION,
        max: ASH_ATLAS_MAX_PROTOCOL_VERSION
      },
      serverHttpBase,
      fetcher: fetcher ?? globalThis.fetch.bind(globalThis)
    });
    if (!options.applyOnDownload) return { kind: "prepared", descriptor, ...(updateStatus ? { updateStatus } : {}) };
    if (options.reloadOnApply === false) {
      await (nativeReadyPromise ?? markNativeLiveUpdateReady());
      await LiveUpdate.setNextBundle({ bundleId: descriptor.bundleId });
      return { kind: "prepared", descriptor, ...(updateStatus ? { updateStatus } : {}) };
    }
    return await applyPreparedNativeLiveUpdate(descriptor.bundleId);
  } catch (error) {
    if (bundleDownloaded && !preparedBundles.has(descriptor.bundleId)) {
      await LiveUpdate.deleteBundle({ bundleId: descriptor.bundleId }).catch(() => undefined);
    }
    await triggerNativeHaptic("failure");
    return {
      kind: "failed",
      bundleId: descriptor.bundleId,
      message: error instanceof Error
        ? error.message
        : "Ash Atlas could not verify the update. Continue with the installed version or try again later."
    };
  } finally {
    await progressListener?.remove().catch(() => undefined);
  }
}

export async function applyPreparedNativeLiveUpdate(
  bundleId: string,
  currentServerProtocolRange?: NativeLiveUpdateProtocolRange
): Promise<{ kind: "reloaded"; bundleId: string } | { kind: "failed"; bundleId: string; message: string }> {
  const prepared = preparedBundles.get(bundleId);
  if (!isNativeApp() || !prepared) {
    return {
      kind: "failed",
      bundleId,
      message: "The Ash Atlas update has not been downloaded."
    };
  }
  try {
    const pointerTimeout = createTimeoutSignal(NATIVE_PRE_APPLY_CHECK_TIMEOUT_MS);
    let latestDescriptor: NativeBundleDescriptor | null;
    try {
      latestDescriptor = await readNativeLiveUpdateDescriptor(
        prepared.serverHttpBase,
        prepared.appInfo,
        prepared.currentBundleId,
        prepared.fetcher,
        pointerTimeout.signal
      );
    } finally {
      pointerTimeout.clear();
    }
    if (!latestDescriptor || !sameNativeLiveUpdateDescriptor(latestDescriptor, prepared.descriptor)) {
      preparedBundles.delete(bundleId);
      await LiveUpdate.deleteBundle({ bundleId }).catch(() => undefined);
      return {
        kind: "failed",
        bundleId,
        message: "This update is no longer current. Ash Atlas will keep using the installed version."
      };
    }
    let serverProtocolRange = currentServerProtocolRange;
    if (!serverProtocolRange) {
      const protocolTimeout = createTimeoutSignal(NATIVE_PRE_APPLY_CHECK_TIMEOUT_MS);
      try {
        serverProtocolRange = await readCurrentServerProtocolRange(
          prepared.serverHttpBase,
          prepared.appInfo,
          prepared.fetcher,
          protocolTimeout.signal
        );
      } finally {
        protocolTimeout.clear();
      }
    }
    if (!serverProtocolRange) throw new NativeLiveUpdateUnavailableError();
    if (!nativeBundleProtocolRangesOverlap(
      { min: prepared.descriptor.protocolMin, max: prepared.descriptor.protocolMax },
      serverProtocolRange
    )) {
      return {
        kind: "failed",
        bundleId,
        message: "This update is not compatible with the current server protocol."
      };
    }
    await (nativeReadyPromise ?? markNativeLiveUpdateReady());
    await LiveUpdate.setNextBundle({ bundleId });
    await triggerNativeHaptic("success");
    await LiveUpdate.reload();
    return { kind: "reloaded", bundleId };
  } catch {
    await triggerNativeHaptic("failure");
    return {
      kind: "failed",
      bundleId,
      message: "Ash Atlas could not apply the update. Continue with the installed version or try again later."
    };
  }
}

export async function applyNativeLiveUpdate(
  options: Omit<NativeLiveUpdatePreparationOptions, "applyOnDownload" | "reloadOnApply">
    = {}
): Promise<NativeLiveUpdatePreparationResult> {
  return prepareNativeLiveUpdate({ ...options, applyOnDownload: true, reloadOnApply: true });
}

export function nativeBundleProtocolRangesOverlap(
  bundle: NativeLiveUpdateProtocolRange,
  server: NativeLiveUpdateProtocolRange
): boolean {
  return bundle.min <= server.max && server.min <= bundle.max;
}

async function readCurrentServerProtocolRange(
  serverHttpBase: string,
  appInfo: NativeAppInfo,
  fetcher: typeof fetch,
  signal: AbortSignal
): Promise<NativeLiveUpdateProtocolRange> {
  const compatibility = await abortable(checkNativeCompatibility(serverHttpBase, {
    platform: appInfo.platform,
    version: appInfo.version,
    build: appInfo.build,
    wsMin: ASH_ATLAS_MIN_PROTOCOL_VERSION,
    wsMax: ASH_ATLAS_MAX_PROTOCOL_VERSION
  }, fetcher, signal), signal);
  return { min: compatibility.wsMin, max: compatibility.wsMax };
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => globalThis.clearTimeout(timer) };
}

export async function triggerNativeHaptic(
  kind: "success" | "failure" | "warning"
): Promise<void> {
  if (!isNativeApp()) return;
  try {
    if (kind === "success") {
      await Haptics.notification({ type: NotificationType.Success });
    } else if (kind === "failure") {
      await Haptics.notification({ type: NotificationType.Error });
    } else {
      await Haptics.impact({ style: ImpactStyle.Light });
    }
  } catch {
    // Haptics are feedback only and never gate startup or recovery.
  }
}

function sameNativeLiveUpdateDescriptor(
  left: NativeBundleDescriptor,
  right: NativeBundleDescriptor
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error("The operation was canceled"));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("The operation was canceled"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

class NativeShellUpdateRequiredError extends Error {
  constructor(readonly requiredBuild: number) {
    super("This app needs a newer shell to apply the available update.");
  }
}
