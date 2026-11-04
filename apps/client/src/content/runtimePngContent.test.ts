import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimePngContentAsset,
  RuntimePngContentManifest
} from "@ash-atlas/shared";
import { canonicalRuntimePngContentManifest } from "@ash-atlas/shared";

const runtimePngOverrides = vi.hoisted(() => ({
  setRuntimePngAssetUrlOverrides: vi.fn(),
  setRuntimePlayerAppearanceAssetUrlOverrides: vi.fn()
}));

vi.mock("../map/runtimePngAssetUrl.js", () => ({
  setRuntimePngAssetUrlOverrides: runtimePngOverrides.setRuntimePngAssetUrlOverrides
}));
vi.mock("@ash-atlas/player-renderer/asset-registry", () => ({
  setRuntimePlayerAppearanceAssetUrlOverrides: runtimePngOverrides.setRuntimePlayerAppearanceAssetUrlOverrides
}));

import { prepareRuntimePngContent } from "./runtimePngContent.js";
import {
  type RuntimePngContentCache,
  type RuntimePngContentCacheValidation,
  type RuntimePngContentPackRecord,
  type RuntimePngContentPointers
} from "./runtimePngContentCache.js";

const originalCreateObjectURL = URL.createObjectURL;
beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  runtimePngOverrides.setRuntimePngAssetUrlOverrides.mockClear();
  runtimePngOverrides.setRuntimePlayerAppearanceAssetUrlOverrides.mockClear();
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: originalCreateObjectURL });
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
});

describe("runtime PNG content preparation", () => {
  it("loads an author-added skin asset ID from pack B without changing the client code", async () => {
    let objectUrlIndex = 0;
    const createdBlobSizes: number[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: (blob: Blob) => {
        createdBlobSizes.push(blob.size);
        objectUrlIndex += 1;
        return `blob:runtime-content-${objectUrlIndex}`;
      }
    });

    const pngA = pngWithMarker("pack-a-crest");
    const pngB = pngWithMarker("pack-b-crest");
    const newSkinPng = pngWithMarker("new-dark-skin-art");
    const packA = createPack([runtimePngAsset("chat-crest-lion", {
      kind: "runtime-png",
      registrationId: "chat-crest-lion",
      relativeFile: "apps/client/src/assets/chat-crests/lion.png"
    }, pngA)]);
    const packB = createPack([
      runtimePngAsset("chat-crest-lion", {
        kind: "runtime-png",
        registrationId: "chat-crest-lion",
        relativeFile: "apps/client/src/assets/chat-crests/lion.png"
      }, pngB),
      runtimePngAsset("dusk-body-artwork-2026", {
        kind: "player-skin-tone",
        skinToneId: "dark"
      }, newSkinPng)
    ]);
    const cache = new MemoryContentCache();
    const allBlobs = new Map([
      [hash(pngA), pngA],
      [hash(pngB), pngB],
      [hash(newSkinPng), newSkinPng]
    ]);
    let selectedManifest = packA.manifest;
    const requestedBlobs: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/manifest/")) {
        const body = JSON.stringify(selectedManifest);
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(body).byteLength) }
        });
      }
      const sha256 = url.pathname.split("/").at(-1)!;
      const bytes = allBlobs.get(sha256);
      if (!bytes) return new Response(null, { status: 404 });
      requestedBlobs.push(sha256);
      return new Response(bytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) }
      });
    };
    const validation: RuntimePngContentCacheValidation = {
      hashBlob: async (blob) => hash(new Uint8Array(await blob.arrayBuffer())),
      decodePng: async () => undefined
    };

    const first = await prepareRuntimePngContent({
      serverHttpBase: "http://content.test",
      cache,
      fetcher,
      validation
    });
    expect(first).toEqual({ kind: "ready", packId: packA.manifest.packId });

    selectedManifest = packB.manifest;
    const second = await prepareRuntimePngContent({
      serverHttpBase: "http://content.test",
      cache,
      fetcher,
      validation
    });

    expect(second).toEqual({ kind: "ready", packId: packB.manifest.packId });
    expect((await cache.readPack(packB.manifest.packId))?.manifest.assets.map(({ assetId }) => assetId))
      .toContain("dusk-body-artwork-2026");
    expect(requestedBlobs).toContain(hash(newSkinPng));
    expect(createdBlobSizes).toContain(newSkinPng.byteLength);
    expect(runtimePngOverrides.setRuntimePlayerAppearanceAssetUrlOverrides).toHaveBeenLastCalledWith([
      expect.objectContaining({
        assetKey: "bodies/template7c-clean.png",
        url: expect.stringMatching(/^blob:runtime-content-/u)
      })
    ]);
    expect(await cache.readPointers()).toMatchObject({
      activePackId: packB.manifest.packId,
      previousPackId: packA.manifest.packId
    });
  });

  it.each([401, 403])("keeps current art without a failure screen when the manifest answers %i", async (status) => {
    const requested: string[] = [];
    const result = await prepareRuntimePngContent({
      serverHttpBase: "http://content.test",
      cache: new MemoryContentCache(),
      fetcher: async (input) => {
        requested.push(new URL(String(input)).pathname);
        return new Response(JSON.stringify({ error: { code: "AUTHENTICATION_REQUIRED" } }), { status });
      }
    });
    expect(result).toEqual({ kind: "ready", packId: null });
    expect(requested).toEqual(["/api/runtime-png/v2/manifest/chat-crest-lion"]);
  });
});

function runtimePngAsset(
  assetId: string,
  target: RuntimePngContentAsset["target"],
  bytes: Uint8Array
): RuntimePngContentAsset {
  return {
    assetId,
    target,
    sha256: hash(bytes),
    byteLength: bytes.byteLength
  };
}

function createPack(assets: RuntimePngContentAsset[]): { manifest: RuntimePngContentManifest } {
  const manifestData = {
    schemaVersion: 3 as const,
    totalByteLength: assets.reduce((total, asset) => total + asset.byteLength, 0),
    assets,
    greenhouseCropPresentations: []
  };
  const packId = hash(new TextEncoder().encode(canonicalRuntimePngContentManifest(manifestData)));
  return { manifest: { ...manifestData, packId } };
}

function pngWithMarker(marker: string): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set(new TextEncoder().encode(marker), 8);
  return bytes;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class MemoryContentCache implements RuntimePngContentCache {
  private readonly packs = new Map<string, {
    packId: string;
    status: "staged" | "ready";
    manifest: RuntimePngContentManifest;
    blobs: Record<string, Blob>;
  }>();
  private pointers: RuntimePngContentPointers = {
    activePackId: null,
    previousPackId: null,
    stagedPackId: null
  };

  async readPointers(): Promise<RuntimePngContentPointers> { return { ...this.pointers }; }
  async readPack(packId: string): Promise<RuntimePngContentPackRecord | null> {
    const record = this.packs.get(packId);
    return record ? { ...record, blobs: { ...record.blobs } } : null;
  }
  async beginStage(manifest: RuntimePngContentManifest): Promise<void> {
    const existing = this.packs.get(manifest.packId);
    this.packs.set(manifest.packId, {
      packId: manifest.packId,
      status: "staged",
      manifest,
      blobs: existing?.blobs ?? {}
    });
    this.pointers = { ...this.pointers, stagedPackId: manifest.packId };
  }
  async saveStagedAsset(packId: string, asset: RuntimePngContentAsset, blob: Blob): Promise<void> {
    const record = this.packs.get(packId);
    if (!record || record.status !== "staged") throw new Error("Pack is not staged");
    record.blobs[asset.assetId] = blob;
  }
  async activate(packId: string): Promise<void> {
    const record = this.packs.get(packId);
    if (!record || record.manifest.assets.some((asset) => !record.blobs[asset.assetId])) {
      throw new Error("Pack is incomplete");
    }
    record.status = "ready";
    const previousPackId = this.pointers.activePackId && this.pointers.activePackId !== packId
      ? this.pointers.activePackId
      : this.pointers.previousPackId;
    this.pointers = { activePackId: packId, previousPackId, stagedPackId: null };
    for (const cachedPackId of this.packs.keys()) {
      if (cachedPackId !== packId && cachedPackId !== previousPackId) this.packs.delete(cachedPackId);
    }
  }
  async rollbackTo(packId: string): Promise<void> {
    const record = this.packs.get(packId);
    if (!record || record.status !== "ready") throw new Error("Rollback pack is unavailable");
    this.pointers = {
      activePackId: packId,
      previousPackId: this.pointers.activePackId,
      stagedPackId: this.pointers.stagedPackId
    };
  }
}
