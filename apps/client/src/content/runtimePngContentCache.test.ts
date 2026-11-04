import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  canonicalRuntimePngContentManifest,
  type RuntimePngContentAsset,
  type RuntimePngContentManifest
} from "@ash-atlas/shared";

import {
  installVerifiedRuntimePngContentPack,
  selectCachedRuntimePngContentPack,
  type RuntimePngContentCache,
  type RuntimePngContentPackRecord,
  type RuntimePngContentPointers,
  type RuntimePngContentCacheValidation
} from "./runtimePngContentCache.js";

const validation: RuntimePngContentCacheValidation = {
  hashBlob: async (blob) => createHash("sha256").update(await blob.text()).digest("hex"),
  decodePng: async () => undefined
};

describe("runtime PNG content cache", () => {
  it("activates A, then B, then the cached A without downloading it again", async () => {
    const cache = new MemoryContentCache();
    const packA = testPack("artwork-A");
    const packB = testPack("artwork-B");
    const downloaded: string[] = [];

    await installVerifiedRuntimePngContentPack(packA.manifest, cache, async () => {
      downloaded.push("A");
      return packA.blob;
    }, validation);
    await installVerifiedRuntimePngContentPack(packB.manifest, cache, async () => {
      downloaded.push("B");
      return packB.blob;
    }, validation);
    const restored = await installVerifiedRuntimePngContentPack(packA.manifest, cache, async () => {
      downloaded.push("unexpected");
      throw new Error("A should still be cached as the previous pack");
    }, validation);

    expect(downloaded).toEqual(["A", "B"]);
    expect(restored.packId).toBe(packA.manifest.packId);
    expect(await cache.readPointers()).toEqual({
      activePackId: packA.manifest.packId,
      previousPackId: packB.manifest.packId,
      stagedPackId: null
    });
  });

  it("keeps the active pack when a staged replacement fails verification", async () => {
    const cache = new MemoryContentCache();
    const packA = testPack("installed artwork");
    const packB = testPack("replacement artwork");
    await installVerifiedRuntimePngContentPack(packA.manifest, cache, async () => packA.blob, validation);

    await expect(installVerifiedRuntimePngContentPack(
      packB.manifest,
      cache,
      async () => new Blob(["corrupt replacement"]),
      validation
    )).rejects.toThrow("did not match");

    expect(await cache.readPointers()).toEqual({
      activePackId: packA.manifest.packId,
      previousPackId: null,
      stagedPackId: packB.manifest.packId
    });
    expect(cache.packs.get(packB.manifest.packId)?.status).toBe("staged");
  });

  it("rolls back to the previous verified pack when active cached bytes are damaged", async () => {
    const cache = new MemoryContentCache();
    const packA = testPack("good previous artwork");
    const packB = testPack("damaged active artwork");
    await installVerifiedRuntimePngContentPack(packA.manifest, cache, async () => packA.blob, validation);
    await installVerifiedRuntimePngContentPack(packB.manifest, cache, async () => packB.blob, validation);
    cache.packs.get(packB.manifest.packId)!.blobs[packB.asset.assetId] = new Blob(["damaged"]);

    const selected = await selectCachedRuntimePngContentPack(cache, validation);

    expect(selected?.packId).toBe(packA.manifest.packId);
    expect(await cache.readPointers()).toEqual({
      activePackId: packA.manifest.packId,
      previousPackId: packB.manifest.packId,
      stagedPackId: null
    });
  });
});

function testPack(value: string): { manifest: RuntimePngContentManifest; asset: RuntimePngContentAsset; blob: Blob } {
  const blob = new Blob([value], { type: "image/png" });
  const bytes = Buffer.from(value);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const asset: RuntimePngContentAsset = {
    assetId: "winter-dusk-2030",
    target: { kind: "player-skin-tone", skinToneId: "dark" },
    sha256,
    byteLength: bytes.byteLength
  };
  return {
    blob,
    asset,
    manifest: {
      schemaVersion: 3,
      packId: createHash("sha256").update(canonicalRuntimePngContentManifest({
        schemaVersion: 3,
        totalByteLength: bytes.byteLength,
        assets: [asset],
        greenhouseCropPresentations: []
      })).digest("hex"),
      totalByteLength: bytes.byteLength,
      assets: [asset],
      greenhouseCropPresentations: []
    }
  };
}

class MemoryContentCache implements RuntimePngContentCache {
  readonly packs = new Map<string, {
    packId: string;
    status: "staged" | "ready";
    manifest: RuntimePngContentManifest;
    blobs: Record<string, Blob>;
  }>();
  private pointers: {
    activePackId: string | null;
    previousPackId: string | null;
    stagedPackId: string | null;
  } = {
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
      blobs: existing?.manifest.packId === manifest.packId ? existing.blobs : {}
    });
    this.pointers.stagedPackId = manifest.packId;
  }
  async saveStagedAsset(packId: string, asset: RuntimePngContentAsset, blob: Blob): Promise<void> {
    const record = this.packs.get(packId);
    if (!record || record.status !== "staged") throw new Error("Pack is not staged");
    record.blobs[asset.assetId] = blob;
  }
  async activate(packId: string): Promise<void> {
    const record = this.packs.get(packId);
    if (!record || record.manifest.assets.some((asset) => !record.blobs[asset.assetId])) throw new Error("Pack is incomplete");
    const previousPackId = this.pointers.activePackId && this.pointers.activePackId !== packId
      ? this.pointers.activePackId
      : this.pointers.previousPackId === packId ? null : this.pointers.previousPackId;
    record.status = "ready";
    this.pointers = { activePackId: packId, previousPackId, stagedPackId: null };
    for (const id of this.packs.keys()) {
      if (id !== packId && id !== previousPackId) this.packs.delete(id);
    }
  }
  async rollbackTo(packId: string): Promise<void> {
    const record = this.packs.get(packId);
    if (!record || record.status !== "ready") throw new Error("Rollback pack is unavailable");
    const failedPackId = this.pointers.activePackId;
    this.pointers = {
      activePackId: packId,
      previousPackId: failedPackId && failedPackId !== packId ? failedPackId : null,
      stagedPackId: this.pointers.stagedPackId
    };
  }
}
