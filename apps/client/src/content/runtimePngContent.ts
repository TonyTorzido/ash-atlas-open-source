import {
  RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES,
  RUNTIME_PNG_CONTENT_SCHEMA_VERSION,
  canonicalRuntimePngContentManifest,
  resolveRuntimePngContentTarget,
  runtimePngAssetRegistrationById,
  runtimePngContentManifestSchema,
  type RuntimePngContentAsset,
  type RuntimePngContentManifest
} from "@ash-atlas/shared";

import { clientConfig } from "../config.js";
import { setRuntimePngAssetUrlOverrides } from "../map/runtimePngAssetUrl.js";
import { setRuntimePlayerAppearanceAssetUrlOverrides } from "@ash-atlas/player-renderer/asset-registry";
import {
  IndexedDbRuntimePngContentCache,
  installVerifiedRuntimePngContentPack,
  selectCachedRuntimePngContentPack,
  type RuntimePngContentCache,
  type RuntimePngContentCacheValidation,
  type RuntimePngContentPackRecord
} from "./runtimePngContentCache.js";

export const REMOTE_RUNTIME_PNG_REGISTRATION_ID = "chat-crest-lion";
const MANIFEST_TIMEOUT_MS = 5_000;
const BLOB_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_BYTES = 128 * 1024;

export type RuntimePngContentProgress = Readonly<{
  phase: "checking" | "downloading";
  loadedBytes: number;
  totalBytes: number | null;
}>;

export type RuntimePngContentPreparationResult =
  | { kind: "ready"; packId: string | null }
  | { kind: "failed"; message: string };

export type RuntimePngContentPreparationOptions = Readonly<{
  serverHttpBase?: string;
  cache?: RuntimePngContentCache;
  onProgress?: (progress: RuntimePngContentProgress) => void;
  fetcher?: typeof fetch;
  validation?: RuntimePngContentCacheValidation;
}>;

export async function prepareRuntimePngContent(
  options: RuntimePngContentPreparationOptions = {}
): Promise<RuntimePngContentPreparationResult> {
  const cache = options.cache ?? new IndexedDbRuntimePngContentCache();
  const validation = options.validation;
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const serverHttpBase = options.serverHttpBase ?? clientConfig.serverHttpBase;

  try {
    setRuntimePngAssetUrlOverrides([]);
    setRuntimePlayerAppearanceAssetUrlOverrides([]);
    const cached = await selectCachedRuntimePngContentPack(cache, validation);
    if (cached) setResolverToPack(cached);

    options.onProgress?.({ phase: "checking", loadedBytes: 0, totalBytes: null });
    const manifest = await fetchCompatibleManifest(
      serverHttpBase,
      REMOTE_RUNTIME_PNG_REGISTRATION_ID,
      fetcher
    );
    if (!manifest) return { kind: "ready", packId: cached?.packId ?? null };

    const registration = runtimePngAssetRegistrationById(REMOTE_RUNTIME_PNG_REGISTRATION_ID);
    const includesCompatibleRegistration = registration && manifest.assets.some((asset) =>
      asset.target.kind === "runtime-png" &&
      asset.target.registrationId === registration.id &&
      asset.target.relativeFile === registration.relativeFile
    );
    if (!registration || !includesCompatibleRegistration ||
      manifest.assets.some((asset) => !resolveRuntimePngContentTarget(asset.target))) {
      throw new Error("The artwork update is not compatible with this game version");
    }
    if (cached?.packId === manifest.packId) {
      return { kind: "ready", packId: cached.packId };
    }

    options.onProgress?.({
      phase: "downloading",
      loadedBytes: 0,
      totalBytes: manifest.totalByteLength
    });
    const installed = await installVerifiedRuntimePngContentPack(
      manifest,
      cache,
      (currentAsset) => downloadBlob(
        serverHttpBase,
        manifest.packId,
        currentAsset,
        fetcher,
        (loadedBytes) => options.onProgress?.({
          phase: "downloading",
          loadedBytes,
          totalBytes: manifest.totalByteLength
        })
      ),
      validation
    );
    setResolverToPack(installed);
    return { kind: "ready", packId: installed.packId };
  } catch {
    return {
      kind: "failed",
      message: "Couldn’t finish the update. Try again, or continue with the current version."
    };
  }
}

async function fetchCompatibleManifest(
  serverHttpBase: string,
  registrationId: string,
  fetcher: typeof fetch
): Promise<RuntimePngContentManifest | null> {
  const url = new URL(
    `/api/runtime-png/v2/manifest/${encodeURIComponent(registrationId)}`,
    serverHttpBase
  );
  url.searchParams.set("schemaVersion", String(RUNTIME_PNG_CONTENT_SCHEMA_VERSION));
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      cache: "no-store",
      credentials: "include",
      signal: controller.signal
    });
    if (response.status === 204 || response.status === 404) return null;
    // Art packs are signed-in content; a session without access keeps the art it already has.
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error("Artwork manifest is unavailable");
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_MANIFEST_BYTES) throw new Error("Artwork manifest is too large");
    const bytes = await readBoundedResponse(response, MAX_MANIFEST_BYTES, () => undefined);
    const manifest = runtimePngContentManifestSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    );
    const identity = await sha256(new TextEncoder().encode(canonicalRuntimePngContentManifest(manifest)));
    if (identity !== manifest.packId) throw new Error("Artwork manifest identity mismatch");
    return manifest;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function downloadBlob(
  serverHttpBase: string,
  packId: string,
  asset: RuntimePngContentAsset,
  fetcher: typeof fetch,
  onProgress: (loadedBytes: number) => void
): Promise<Blob> {
  const url = new URL(`/api/runtime-png/v2/blobs/${packId}/${asset.sha256}`, serverHttpBase);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), BLOB_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: "GET",
      cache: "force-cache",
      credentials: "include",
      signal: controller.signal
    });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/png")) {
      throw new Error("Artwork download is unavailable");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > asset.byteLength || declaredLength > RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES) {
      throw new Error("Artwork download exceeds its manifest size");
    }
    const bytes = await readBoundedResponse(response, asset.byteLength, onProgress);
    if (bytes.byteLength !== asset.byteLength) throw new Error("Artwork download ended early");
    if (await sha256(bytes) !== asset.sha256) throw new Error("Artwork download hash mismatch");
    if (!isPng(bytes)) throw new Error("Artwork download is not a PNG");
    const stableBytes = new Uint8Array(bytes.byteLength);
    stableBytes.set(bytes);
    return new Blob([stableBytes.buffer as ArrayBuffer], { type: "image/png" });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function readBoundedResponse(
  response: Response,
  expectedBytes: number,
  onProgress: (loadedBytes: number) => void
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > expectedBytes) throw new Error("Artwork download exceeds its manifest size");
    onProgress(bytes.byteLength);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loadedBytes += value.byteLength;
      if (loadedBytes > expectedBytes || loadedBytes > RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES) {
        await reader.cancel();
        throw new Error("Artwork download exceeds its manifest size");
      }
      chunks.push(value);
      onProgress(loadedBytes);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function setResolverToPack(pack: RuntimePngContentPackRecord): void {
  const runtimePngOverrides: Array<Readonly<{ relativeFile: string; url: string }>> = [];
  const playerAppearanceOverrides: Array<Readonly<{ assetKey: string; url: string }>> = [];
  const greenhouseCropStageOverrides: Array<Readonly<{ cropId: string; stage: number; url: string }>> = [];
  const resolvedAssets = pack.manifest.assets.map((asset) => {
    const target = resolveRuntimePngContentTarget(asset.target);
    const blob = pack.blobs[asset.assetId];
    if (!target || !blob) throw new Error("Cached artwork target is not compatible with this game version");
    return { target, blob };
  });
  for (const { target, blob } of resolvedAssets) {
    const url = URL.createObjectURL(blob);
    if (target.kind === "runtime-png") {
      runtimePngOverrides.push({ relativeFile: target.relativeFile, url });
    } else if (target.kind === "player-appearance") {
      playerAppearanceOverrides.push({ assetKey: target.assetKey, url });
    } else {
      greenhouseCropStageOverrides.push({ cropId: target.cropId, stage: target.stage, url });
    }
  }
  setRuntimePngAssetUrlOverrides(
    runtimePngOverrides,
    pack.packId,
    pack.manifest.greenhouseCropPresentations,
    greenhouseCropStageOverrides
  );
  setRuntimePlayerAppearanceAssetUrlOverrides(playerAppearanceOverrides);
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}
