// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  isNativeApp: vi.fn(() => true),
  readNativeAppInfo: vi.fn(async () => ({ platform: "ios" as const, version: "1.2.3", build: 42 }))
}));
const requests = vi.hoisted(() => ({
  boundedFetch: vi.fn((input: RequestInfo | URL, init?: RequestInit, fetcher: typeof fetch = fetch) =>
    fetcher(input, init))
}));
const liveUpdate = vi.hoisted(() => ({
  addListener: vi.fn(),
  deleteBundle: vi.fn(),
  downloadBundle: vi.fn(),
  getBlockedBundles: vi.fn(),
  getCurrentBundle: vi.fn(),
  ready: vi.fn(),
  reload: vi.fn(),
  setNextBundle: vi.fn()
}));
const haptics = vi.hoisted(() => ({
  impact: vi.fn(),
  notification: vi.fn()
}));
const compatibility = vi.hoisted(() => ({
  checkNativeCompatibility: vi.fn()
}));
const diagnostics = vi.hoisted(() => ({
  recordNativeDiagnostic: vi.fn()
}));

vi.mock("./nativeApp.js", () => native);
vi.mock("./nativeRequest.js", () => requests);
vi.mock("./nativeCompatibility.js", () => compatibility);
vi.mock("./nativeDiagnostics.js", () => diagnostics);
vi.mock("@capawesome/capacitor-live-update", () => ({
  LiveUpdate: liveUpdate
}));
vi.mock("@capacitor/haptics", () => ({
  Haptics: haptics,
  ImpactStyle: { Light: "light" },
  NotificationType: { Error: "error", Success: "success" }
}));

import {
  applyPreparedNativeLiveUpdate,
  hasCheckedNativeLiveUpdateThisLaunch,
  markNativeLiveUpdateReady,
  nativeBundleProtocolRangesOverlap,
  nativeLiveUpdateDescriptorEndpoint,
  prepareNativeLiveUpdate,
  readCurrentNativeBundleId,
  readNativeLiveUpdateDescriptor,
  readNativeUpdateDownloadBytes,
  type NativeLiveUpdateProtocolRange
} from "./nativeLiveUpdate.js";
import type { NativeBundleDescriptor } from "@ash-atlas/shared";

const appInfo = { platform: "ios" as const, version: "1.2.3", build: 42 };
const clientSha = "b".repeat(64);
const checksum = "a".repeat(64);
const serverSha = "d".repeat(40);

function descriptor(overrides: Partial<NativeBundleDescriptor> = {}): NativeBundleDescriptor {
  return {
    bundleId: "ota-test-bundle-a",
    platform: "ios",
    url: "https://cdn.example.test/ash-atlas/ios/1/",
    checksum,
    signature: "c2lnbmF0dXJl",
    sizeBytes: 40 * 1024,
    artifactType: "zip",
    clientSha,
    serverSha,
    generation: "test/t1256",
    minShellBuild: 8,
    protocolMin: 3,
    protocolMax: 3,
    ...overrides
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function compatibilityResponse(
  overrides: Partial<{
    wsMin: number;
    wsMax: number;
    updateStatus: "ok" | "bundle_update_required" | "shell_update_required";
    hardMinimum: { version: string; build: number };
  }> = {}
) {
  return {
    wsMin: 3,
    wsMax: 3,
    updateStatus: "ok" as const,
    hardMinimum: { version: "1.0.0", build: 1 },
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.isNativeApp.mockReturnValue(true);
  native.readNativeAppInfo.mockResolvedValue(appInfo);
  liveUpdate.getCurrentBundle.mockResolvedValue({ bundleId: null });
  liveUpdate.getBlockedBundles.mockResolvedValue({ bundleIds: [] });
  liveUpdate.addListener.mockResolvedValue({ remove: vi.fn(async () => undefined) });
  liveUpdate.deleteBundle.mockResolvedValue(undefined);
  liveUpdate.downloadBundle.mockResolvedValue(undefined);
  liveUpdate.ready.mockResolvedValue({ currentBundleId: "ota-current", previousBundleId: "ota-previous", rollback: false });
  liveUpdate.reload.mockResolvedValue(undefined);
  liveUpdate.setNextBundle.mockResolvedValue(undefined);
  haptics.impact.mockResolvedValue(undefined);
  haptics.notification.mockResolvedValue(undefined);
  compatibility.checkNativeCompatibility.mockResolvedValue(compatibilityResponse());
});

describe("native live update ready lifecycle", () => {
  it("calls ready once after startup and records the rolled back bundle id", async () => {
    liveUpdate.ready.mockResolvedValue({
      currentBundleId: null,
      previousBundleId: "ota-failed-bundle",
      rollback: true
    });

    const [first, second] = await Promise.all([
      markNativeLiveUpdateReady(),
      markNativeLiveUpdateReady()
    ]);

    expect(first).toEqual(second);
    expect(liveUpdate.ready).toHaveBeenCalledOnce();
    expect(diagnostics.recordNativeDiagnostic).toHaveBeenCalledWith("ota_rollback", "ota-failed-bundle");
  });
});

describe("native live update descriptor", () => {
  it("requests the platform, shell build, and current bundle from the pointer endpoint", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe("/api/native/bundle");
      expect(url.searchParams.get("platform")).toBe("ios");
      expect(url.searchParams.get("shellBuild")).toBe("42");
      expect(url.searchParams.get("bundle")).toBe("ota-current");
      return response(null, 204);
    });

    await expect(readNativeLiveUpdateDescriptor(
      "https://playashatlas.com",
      appInfo,
      "ota-current",
      fetcher
    )).resolves.toBeNull();
    expect(nativeLiveUpdateDescriptorEndpoint("https://playashatlas.com"))
      .toBe("https://playashatlas.com/api/native/bundle");
  });

  it("sends an empty bundle id while the embedded shell is active", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(input.toString()).searchParams.get("bundle")).toBe("");
      return response(null, 204);
    });

    await readNativeLiveUpdateDescriptor("https://playashatlas.com", appInfo, null, fetcher);
  });

  it("validates the W0 descriptor and enforces the shell build", async () => {
    const invalidDescriptor = { ...descriptor(), extra: true };
    await expect(readNativeLiveUpdateDescriptor(
      "https://playashatlas.com", appInfo, null, vi.fn(async () => response(invalidDescriptor))
    )).rejects.toThrow();

    await expect(readNativeLiveUpdateDescriptor(
      "https://playashatlas.com", appInfo, null,
      vi.fn(async () => response(descriptor({ minShellBuild: 43 })))
    )).rejects.toMatchObject({ requiredBuild: 43 });
  });
});

describe("native live update preparation", () => {
  it("treats 204 as no update and keeps the release metadata out of the decision", async () => {
    const fetcher = vi.fn(async () => response(null, 204));

    await expect(prepareNativeLiveUpdate({ appInfo, fetcher })).resolves.toEqual({ kind: "current" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(compatibility.checkNativeCompatibility).not.toHaveBeenCalled();
  });

  it("applies a pointer update with zip checksum and signature verification and shows byte progress", async () => {
    const candidate = descriptor({ clientSha: "f".repeat(64) });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(candidate))
      .mockResolvedValueOnce(response(candidate))
      .mockResolvedValueOnce(response(candidate));
    const progress: Array<{ phase: string; loadedBytes: number; totalBytes: number | null }> = [];
    compatibility.checkNativeCompatibility.mockResolvedValue(
      compatibilityResponse({ updateStatus: "bundle_update_required" })
    );

    await expect(prepareNativeLiveUpdate({
      appInfo,
      fetcher,
      applyOnDownload: true,
      onProgress: (value) => progress.push(value)
    })).resolves.toEqual({ kind: "reloaded", bundleId: candidate.bundleId });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(compatibility.checkNativeCompatibility).toHaveBeenCalledTimes(2);
    expect(liveUpdate.downloadBundle).toHaveBeenCalledWith({
      artifactType: "zip",
      bundleId: candidate.bundleId,
      checksum: candidate.checksum,
      signature: candidate.signature,
      url: candidate.url
    });
    expect(liveUpdate.setNextBundle).toHaveBeenCalledWith({ bundleId: candidate.bundleId });
    expect(liveUpdate.reload).toHaveBeenCalledOnce();
    expect(haptics.notification).toHaveBeenCalledWith({ type: "success" });
    expect(progress[0]).toEqual({ phase: "checking", loadedBytes: 0, totalBytes: null });
    expect(progress[1]).toEqual({ phase: "downloading", loadedBytes: 0, totalBytes: candidate.sizeBytes });
    expect(hasCheckedNativeLiveUpdateThisLaunch()).toBe(true);
  });

  it("uses manifest artifact mode without zip-only whole-artifact checksums", async () => {
    const candidate = descriptor({
      bundleId: "ota-manifest-bundle",
      artifactType: "manifest",
      url: "https://cdn.example.test/ash-atlas/ios/1/"
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(candidate))
      .mockResolvedValueOnce(response(candidate));

    await expect(prepareNativeLiveUpdate({
      appInfo,
      fetcher,
      serverProtocolRange: { min: 3, max: 3 }
    })).resolves.toMatchObject({ kind: "prepared", descriptor: candidate });
    expect(compatibility.checkNativeCompatibility).not.toHaveBeenCalled();
    expect(liveUpdate.downloadBundle).toHaveBeenCalledWith({
      artifactType: "manifest",
      bundleId: candidate.bundleId,
      url: candidate.url
    });
  });

  it("blocks protocol-incompatible and shell-incompatible bundles before download", async () => {
    const candidate = descriptor({ bundleId: "ota-protocol-bundle", protocolMin: 4, protocolMax: 4 });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(candidate));

    await expect(prepareNativeLiveUpdate({ appInfo, fetcher })).resolves.toEqual({
      kind: "protocol_incompatible",
      descriptor: candidate,
      serverProtocolRange: { min: 3, max: 3 }
    });
    expect(liveUpdate.downloadBundle).not.toHaveBeenCalled();

    const shellFetcher = vi.fn(async () => response(descriptor({ bundleId: "ota-shell-bundle" })));
    compatibility.checkNativeCompatibility.mockResolvedValue(
      compatibilityResponse({ updateStatus: "shell_update_required", hardMinimum: { version: "2.0.0", build: 50 } })
    );
    await expect(prepareNativeLiveUpdate({ appInfo, fetcher: shellFetcher })).resolves.toEqual({
      kind: "shell_update_required",
      requiredBuild: 50
    });
    expect(liveUpdate.downloadBundle).not.toHaveBeenCalled();
  });

  it("skips a locally blocked bundle", async () => {
    const candidate = descriptor({ bundleId: "ota-blocked-bundle" });
    liveUpdate.getBlockedBundles.mockResolvedValue({ bundleIds: [candidate.bundleId] });
    const fetcher = vi.fn(async () => response(candidate));

    await expect(prepareNativeLiveUpdate({ appInfo, fetcher })).resolves.toMatchObject({
      kind: "blocked",
      bundleId: candidate.bundleId
    });
    expect(compatibility.checkNativeCompatibility).not.toHaveBeenCalled();
    expect(liveUpdate.downloadBundle).not.toHaveBeenCalled();
  });

  it("revalidates the descriptor pointer before activating a deferred download", async () => {
    const candidate = descriptor({ bundleId: "ota-deferred-bundle" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(candidate))
      .mockResolvedValueOnce(response(candidate))
      .mockResolvedValueOnce(response(candidate));

    await expect(prepareNativeLiveUpdate({
      appInfo,
      fetcher,
      serverProtocolRange: { min: 3, max: 3 }
    })).resolves.toMatchObject({ kind: "prepared", descriptor: candidate });
    expect(liveUpdate.setNextBundle).not.toHaveBeenCalled();
    await expect(applyPreparedNativeLiveUpdate(candidate.bundleId, { min: 3, max: 3 }))
      .resolves.toEqual({ kind: "reloaded", bundleId: candidate.bundleId });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(liveUpdate.setNextBundle).toHaveBeenCalledWith({ bundleId: candidate.bundleId });
    expect(liveUpdate.reload).toHaveBeenCalledOnce();
  });

  it("refuses to activate a downloaded descriptor after the pointer changes", async () => {
    const candidate = descriptor({ bundleId: "ota-revoked-bundle" });
    const replacement = descriptor({ bundleId: "ota-replacement-bundle" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(candidate))
      .mockResolvedValueOnce(response(candidate))
      .mockResolvedValueOnce(response(replacement));

    await prepareNativeLiveUpdate({ appInfo, fetcher, serverProtocolRange: { min: 3, max: 3 } });
    await expect(applyPreparedNativeLiveUpdate(candidate.bundleId, { min: 3, max: 3 })).resolves.toMatchObject({
      kind: "failed",
      message: expect.stringContaining("no longer current")
    });
    expect(liveUpdate.setNextBundle).not.toHaveBeenCalled();
    expect(liveUpdate.deleteBundle).toHaveBeenCalledWith({ bundleId: candidate.bundleId });
  });

  it("returns to the current bundle when the update check exceeds its launch deadline", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));

    await expect(prepareNativeLiveUpdate({ appInfo, fetcher, checkTimeoutMs: 10 }))
      .resolves.toEqual({ kind: "unavailable" });
    expect(liveUpdate.downloadBundle).not.toHaveBeenCalled();
  });

  it("reports the current bundle only on native shells", async () => {
    liveUpdate.getCurrentBundle.mockResolvedValue({ bundleId: "ota-current-bundle" });
    await expect(readCurrentNativeBundleId()).resolves.toBe("ota-current-bundle");
    native.isNativeApp.mockReturnValue(false);
    await expect(readCurrentNativeBundleId()).resolves.toBeNull();
  });
});

describe("native update protocol range", () => {
  it("recognizes overlapping and disjoint server ranges", () => {
    expect(nativeBundleProtocolRangesOverlap(
      { min: 3, max: 4 },
      { min: 4, max: 5 }
    )).toBe(true);
    expect(nativeBundleProtocolRangesOverlap(
      { min: 3, max: 3 },
      { min: 4, max: 4 }
    )).toBe(false);
  });
});

describe("native update download size", () => {
  it("counts only the files that differ from the installed bundle", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://cdn.example.test/ash-atlas/ios/2/capawesome-live-update-manifest.json") {
        return response([
          { href: "index.html", checksum: "a".repeat(64), sizeInBytes: 1_000 },
          { href: "assets/app.js", checksum: "b".repeat(64), sizeInBytes: 5_000_000 },
          { href: "assets/art.png", checksum: "c".repeat(64), sizeInBytes: 90_000_000 }
        ]);
      }
      if (url === "capacitor://localhost/capawesome-live-update-manifest.json") {
        return response([
          { href: "index.html", checksum: "0".repeat(64), sizeInBytes: 900 },
          { href: "assets/art.png", checksum: "c".repeat(64), sizeInBytes: 90_000_000 }
        ]);
      }
      return response(null, 404);
    }) as unknown as typeof fetch;
    const manifest = descriptor({
      artifactType: "manifest",
      url: "https://cdn.example.test/ash-atlas/ios/2/bundle",
      sizeBytes: 43_213
    });

    expect(await readNativeUpdateDownloadBytes(manifest, fetcher, "capacitor://localhost/")).toBe(5_001_000);
    expect(await readNativeUpdateDownloadBytes(descriptor(), fetcher, "capacitor://localhost/")).toBe(40 * 1024);
  });
});
