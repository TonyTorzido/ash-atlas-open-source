import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES,
  canonicalRuntimePngContentManifest,
  resolveRuntimePngContentTarget,
  runtimePngContentManifestSchema,
  type RuntimePngContentManifest
} from "@ash-atlas/shared";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_MANIFEST_BYTES = 128 * 1024;

export type LoadedRuntimePngContentPack = Readonly<{
  manifest: RuntimePngContentManifest;
  blobs: ReadonlyMap<string, Buffer>;
}>;

export async function activeRuntimePngContentPack(
  contentDirectory = runtimePngContentDirectory(),
  selectedPackId: () => string | null = defaultSelectedPackId
): Promise<LoadedRuntimePngContentPack | null> {
  const override = selectedPackId();
  if (override) return SHA256_PATTERN.test(override)
    ? loadRuntimePngContentPack(contentDirectory, override)
    : null;
  try {
    const pointer = JSON.parse(await readFile(resolve(contentDirectory, "active.json"), "utf8")) as {
      packId?: unknown;
    };
    return typeof pointer.packId === "string" && SHA256_PATTERN.test(pointer.packId)
      ? loadRuntimePngContentPack(contentDirectory, pointer.packId)
      : null;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function loadRuntimePngContentPack(
  contentDirectory: string,
  packId: string
): Promise<LoadedRuntimePngContentPack> {
  if (!SHA256_PATTERN.test(packId)) throw new Error("Invalid pack ID");
  const manifestBytes = await readFile(resolve(contentDirectory, "manifests", `${packId}.json`));
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("PNG content manifest is too large");
  const manifest = runtimePngContentManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  const identity = createHash("sha256")
    .update(canonicalRuntimePngContentManifest(manifest))
    .digest("hex");
  if (identity !== manifest.packId || manifest.packId !== packId) {
    throw new Error("PNG content manifest identity mismatch");
  }

  const blobs = new Map<string, Buffer>();
  for (const asset of manifest.assets) {
    if (!resolveRuntimePngContentTarget(asset.target)) {
      throw new Error("PNG content pack contains an incompatible target");
    }
    const blob = await readFile(resolve(contentDirectory, "blobs", `${asset.sha256}.png`));
    if (blob.byteLength !== asset.byteLength || blob.byteLength > RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES) {
      throw new Error("PNG content blob size mismatch");
    }
    if (!isPng(blob) || createHash("sha256").update(blob).digest("hex") !== asset.sha256) {
      throw new Error("PNG content blob verification failed");
    }
    blobs.set(asset.sha256, blob);
  }
  return { manifest, blobs };
}

function defaultSelectedPackId(): string | null {
  return process.env.RUNTIME_PNG_CONTENT_PACK?.trim() || null;
}

export function runtimePngContentDirectory(): string {
  const workingDirectory = process.cwd();
  const serverPackageDirectory = resolve(workingDirectory, "content/runtime-png-packs");
  const serverArtifactDirectory = resolve(workingDirectory, "apps/server/dist/content/runtime-png-packs");
  const sourceDirectory = resolve(workingDirectory, "apps/server/content/runtime-png-packs");

  // Development runs from apps/server; release preflight uses the copied server artifact.
  if (existsSync(serverPackageDirectory)) return serverPackageDirectory;
  if (existsSync(serverArtifactDirectory)) return serverArtifactDirectory;
  return sourceDirectory;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
