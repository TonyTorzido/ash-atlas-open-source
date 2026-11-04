import {
  RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES,
  canonicalRuntimePngContentManifest,
  runtimePngContentManifestSchema,
  type RuntimePngContentAsset,
  type RuntimePngContentManifest
} from "@ash-atlas/shared";

const DATABASE_NAME = "ash-atlas-runtime-png-content-v1";
const DATABASE_VERSION = 1;
const PACKS_STORE = "packs";
const STATE_STORE = "state";
const POINTERS_KEY = "pointers";

export type RuntimePngContentPointers = Readonly<{
  activePackId: string | null;
  previousPackId: string | null;
  stagedPackId: string | null;
}>;

export type RuntimePngContentPackRecord = Readonly<{
  packId: string;
  status: "staged" | "ready";
  manifest: RuntimePngContentManifest;
  blobs: Readonly<Record<string, Blob>>;
}>;

export interface RuntimePngContentCache {
  readPointers(): Promise<RuntimePngContentPointers>;
  readPack(packId: string): Promise<RuntimePngContentPackRecord | null>;
  beginStage(manifest: RuntimePngContentManifest): Promise<void>;
  saveStagedAsset(packId: string, asset: RuntimePngContentAsset, blob: Blob): Promise<void>;
  activate(packId: string): Promise<void>;
  rollbackTo(packId: string): Promise<void>;
}

type MutablePackRecord = {
  packId: string;
  status: "staged" | "ready";
  manifest: RuntimePngContentManifest;
  blobs: Record<string, Blob>;
};

type StoredPointers = RuntimePngContentPointers & { key: string };

const EMPTY_POINTERS: RuntimePngContentPointers = {
  activePackId: null,
  previousPackId: null,
  stagedPackId: null
};

export class IndexedDbRuntimePngContentCache implements RuntimePngContentCache {
  private database: Promise<IDBDatabase> | null = null;

  async readPointers(): Promise<RuntimePngContentPointers> {
    const database = await this.open();
    const transaction = database.transaction(STATE_STORE, "readonly");
    const stored = await requestValue(transaction.objectStore(STATE_STORE).get(POINTERS_KEY)) as StoredPointers | undefined;
    await transactionDone(transaction);
    return stored ? {
      activePackId: stored.activePackId,
      previousPackId: stored.previousPackId,
      stagedPackId: stored.stagedPackId
    } : EMPTY_POINTERS;
  }

  async readPack(packId: string): Promise<RuntimePngContentPackRecord | null> {
    const database = await this.open();
    const transaction = database.transaction(PACKS_STORE, "readonly");
    const record = await requestValue(transaction.objectStore(PACKS_STORE).get(packId)) as MutablePackRecord | undefined;
    await transactionDone(transaction);
    return record ?? null;
  }

  async beginStage(manifest: RuntimePngContentManifest): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction([PACKS_STORE, STATE_STORE], "readwrite");
    const packs = transaction.objectStore(PACKS_STORE);
    const existing = await requestValue(packs.get(manifest.packId)) as MutablePackRecord | undefined;
    const reusableBlobs = existing?.manifest.packId === manifest.packId ? existing.blobs : {};
    packs.put({
      packId: manifest.packId,
      status: "staged",
      manifest,
      blobs: reusableBlobs
    } satisfies MutablePackRecord);
    const pointers = await readPointersInTransaction(transaction);
    transaction.objectStore(STATE_STORE).put({
      key: POINTERS_KEY,
      ...pointers,
      stagedPackId: manifest.packId
    } satisfies StoredPointers);
    await transactionDone(transaction);
  }

  async saveStagedAsset(packId: string, asset: RuntimePngContentAsset, blob: Blob): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(PACKS_STORE, "readwrite");
    const store = transaction.objectStore(PACKS_STORE);
    const record = await requestValue(store.get(packId)) as MutablePackRecord | undefined;
    if (!record || record.status !== "staged" || !record.manifest.assets.some((entry) => entry.assetId === asset.assetId)) {
      transaction.abort();
      throw new Error("Runtime PNG pack is not staged");
    }
    record.blobs[asset.assetId] = blob;
    store.put(record);
    await transactionDone(transaction);
  }

  async activate(packId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction([PACKS_STORE, STATE_STORE], "readwrite");
    const packs = transaction.objectStore(PACKS_STORE);
    const record = await requestValue(packs.get(packId)) as MutablePackRecord | undefined;
    if (!record || record.manifest.packId !== packId || record.manifest.assets.some((asset) => !record.blobs[asset.assetId])) {
      transaction.abort();
      throw new Error("Runtime PNG pack is incomplete");
    }
    const pointers = await readPointersInTransaction(transaction);
    const previousPackId = pointers.activePackId && pointers.activePackId !== packId
      ? pointers.activePackId
      : pointers.previousPackId === packId ? null : pointers.previousPackId;
    record.status = "ready";
    packs.put(record);
    transaction.objectStore(STATE_STORE).put({
      key: POINTERS_KEY,
      activePackId: packId,
      previousPackId,
      stagedPackId: null
    } satisfies StoredPointers);
    await transactionDone(transaction);
    await this.prune(packId, previousPackId);
  }

  async rollbackTo(packId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction([PACKS_STORE, STATE_STORE], "readwrite");
    const packs = transaction.objectStore(PACKS_STORE);
    const record = await requestValue(packs.get(packId)) as MutablePackRecord | undefined;
    if (!record || record.status !== "ready") {
      transaction.abort();
      throw new Error("Runtime PNG rollback pack is unavailable");
    }
    const pointers = await readPointersInTransaction(transaction);
    const failedPackId = pointers.activePackId;
    transaction.objectStore(STATE_STORE).put({
      key: POINTERS_KEY,
      activePackId: packId,
      previousPackId: failedPackId && failedPackId !== packId ? failedPackId : null,
      stagedPackId: pointers.stagedPackId
    } satisfies StoredPointers);
    await transactionDone(transaction);
  }

  private async prune(activePackId: string, previousPackId: string | null): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction([PACKS_STORE, STATE_STORE], "readwrite");
    const packs = transaction.objectStore(PACKS_STORE);
    const pointers = await readPointersInTransaction(transaction);
    const keep = new Set([activePackId, previousPackId, pointers.stagedPackId].filter((value): value is string => Boolean(value)));
    const records = await requestValue(packs.getAll()) as MutablePackRecord[];
    for (const record of records) {
      if (!keep.has(record.packId)) packs.delete(record.packId);
    }
    await transactionDone(transaction);
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("Persistent artwork storage is unavailable"));
        return;
      }
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(PACKS_STORE)) database.createObjectStore(PACKS_STORE, { keyPath: "packId" });
        if (!database.objectStoreNames.contains(STATE_STORE)) database.createObjectStore(STATE_STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Persistent artwork storage failed to open"));
      request.onblocked = () => reject(new Error("Persistent artwork storage is busy"));
    });
    return this.database;
  }
}

export type RuntimePngContentCacheValidation = Readonly<{
  hashBlob(blob: Blob): Promise<string>;
  decodePng(blob: Blob): Promise<void>;
}>;

export async function selectCachedRuntimePngContentPack(
  cache: RuntimePngContentCache,
  validation: RuntimePngContentCacheValidation = defaultValidation
): Promise<RuntimePngContentPackRecord | null> {
  const pointers = await cache.readPointers();
  for (const [index, packId] of [pointers.activePackId, pointers.previousPackId].entries()) {
    if (!packId) continue;
    const record = await cache.readPack(packId);
    if (!record || record.status !== "ready" || record.packId !== record.manifest.packId) continue;
    if (await isCompleteAndValid(record, validation)) {
      if (index === 1) await cache.rollbackTo(packId);
      return record;
    }
  }
  return null;
}

export async function installVerifiedRuntimePngContentPack(
  manifest: RuntimePngContentManifest,
  cache: RuntimePngContentCache,
  downloadAsset: (asset: RuntimePngContentAsset) => Promise<Blob>,
  validation: RuntimePngContentCacheValidation = defaultValidation,
  onAssetReady?: (asset: RuntimePngContentAsset) => void
): Promise<RuntimePngContentPackRecord> {
  let record = await cache.readPack(manifest.packId);
  if (record && record.manifest.packId === manifest.packId && await isCompleteAndValid(record, validation)) {
    await cache.activate(manifest.packId);
    return { ...record, status: "ready" };
  }

  await cache.beginStage(manifest);
  record = await cache.readPack(manifest.packId);
  const verifiedBlobs: Record<string, Blob> = {};
  for (const asset of manifest.assets) {
    const staged = record?.blobs[asset.assetId];
    let blob = staged && await isValidAssetBlob(asset, staged, validation) ? staged : null;
    if (!blob) blob = await downloadAsset(asset);
    if (!await isValidAssetBlob(asset, blob, validation)) {
      throw new Error("Downloaded artwork did not match its verified manifest");
    }
    await validation.decodePng(blob);
    await cache.saveStagedAsset(manifest.packId, asset, blob);
    verifiedBlobs[asset.assetId] = blob;
    onAssetReady?.(asset);
  }
  await cache.activate(manifest.packId);
  return { packId: manifest.packId, status: "ready", manifest, blobs: verifiedBlobs };
}

async function isCompleteAndValid(
  record: RuntimePngContentPackRecord,
  validation: RuntimePngContentCacheValidation
): Promise<boolean> {
  const parsedManifest = runtimePngContentManifestSchema.safeParse(record.manifest);
  if (!parsedManifest.success || parsedManifest.data.packId !== record.packId ||
    await validation.hashBlob(new Blob([
      new TextEncoder().encode(canonicalRuntimePngContentManifest(parsedManifest.data))
    ])) !== record.packId) return false;
  for (const asset of parsedManifest.data.assets) {
    const blob = record.blobs[asset.assetId];
    if (!blob || !await isValidAssetBlob(asset, blob, validation)) return false;
    try { await validation.decodePng(blob); } catch { return false; }
  }
  return true;
}

async function isValidAssetBlob(
  asset: RuntimePngContentAsset,
  blob: Blob,
  validation: RuntimePngContentCacheValidation
): Promise<boolean> {
  return blob.size === asset.byteLength &&
    blob.size <= RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES &&
    await validation.hashBlob(blob) === asset.sha256;
}

async function readPointersInTransaction(transaction: IDBTransaction): Promise<RuntimePngContentPointers> {
  const stored = await requestValue(transaction.objectStore(STATE_STORE).get(POINTERS_KEY)) as StoredPointers | undefined;
  return stored ? {
    activePackId: stored.activePackId,
    previousPackId: stored.previousPackId,
    stagedPackId: stored.stagedPackId
  } : EMPTY_POINTERS;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Persistent artwork storage request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Persistent artwork storage transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Persistent artwork storage transaction failed"));
  });
}

async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function decodePng(blob: Blob): Promise<void> {
  if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") return;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Downloaded artwork could not be decoded");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

const defaultValidation: RuntimePngContentCacheValidation = {
  hashBlob,
  decodePng
};
