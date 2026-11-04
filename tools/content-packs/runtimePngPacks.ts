import { createHash } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_PNG_CLIENT_ASSET_ROOT,
  runtimePngAssetRegistrationById
} from "../../packages/shared/src/runtimePngAssets.js";
import { GREENHOUSE_STUDIO_CATALOG } from "../../packages/shared/src/greenhouseStudio.js";
import { GREENHOUSE_CROP_CATALOG, type GreenhouseCropDefinition } from "../../apps/server/src/game/greenhouseCrops.js";
import {
  RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES,
  RUNTIME_PNG_CONTENT_MAX_PACK_BYTES,
  RUNTIME_PNG_CONTENT_SCHEMA_VERSION,
  canonicalRuntimePngContentManifest,
  resolveRuntimePngContentTarget,
  runtimePngContentTargetKey,
  runtimePngContentAssetSchema,
  runtimePngContentManifestSchema,
  runtimePngContentAssetTargetSchema,
  type RuntimePngContentAsset,
  type RuntimePngContentManifest,
  type RuntimePngGreenhouseCropPresentation
} from "../../packages/shared/src/runtimePngContent.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contentRoot = resolve(repositoryRoot, "apps/server/content/runtime-png-packs");
const MAX_MANIFEST_BYTES = 128 * 1024;

async function main(args: string[]): Promise<void> {
  const [command, ...options] = args;
  if (command === "build") {
    const registrationId = option(options, "--id");
    const sourcePath = option(options, "--source");
    const skinToneId = option(options, "--skin-tone");
    const skinAssetId = option(options, "--skin-id");
    const skinSourcePath = option(options, "--skin-source");
    if (!registrationId || !sourcePath) throw new Error("Usage: content:packs build --id <registration-id> --source <registered-png> [--skin-tone <tone> --skin-id <new-stable-content-id> --skin-source <authored-png>] [--select]");
    if (Boolean(skinToneId) !== Boolean(skinAssetId) || Boolean(skinAssetId) !== Boolean(skinSourcePath)) {
      throw new Error("--skin-tone, --skin-id, and --skin-source must be used together");
    }
    await buildPack(
      registrationId,
      sourcePath,
      skinToneId && skinAssetId && skinSourcePath
        ? { skinToneId, assetId: skinAssetId, sourcePath: skinSourcePath }
        : null,
      options.includes("--select")
    );
    return;
  }
  if (command === "build-crops") {
    const cropIds = optionValues(options, "--crop");
    if (cropIds.length === 0) throw new Error("Usage: content:packs build-crops --crop <crop-id> [--crop <crop-id> ...] [--select]");
    await buildGreenhouseCropPack(cropIds, options.includes("--select"));
    return;
  }
  if (command === "validate") {
    await validatePacks();
    return;
  }
  throw new Error("Usage: content:packs <build|build-crops|validate>");
}

async function buildPack(
  registrationId: string,
  sourcePath: string,
  skinEntry: Readonly<{ skinToneId: string; assetId: string; sourcePath: string }> | null,
  select: boolean
): Promise<void> {
  const active = await readActivePack();
  const registration = runtimePngAssetRegistrationById(registrationId);
  if (!registration) throw new Error(`Unknown runtime PNG registration: ${registrationId}`);
  const inputs: Array<Readonly<{
    assetId: string;
    target: RuntimePngContentAsset["target"];
    sourcePath: string;
  }>> = [{
    assetId: registration.id,
    target: {
      kind: "runtime-png",
      registrationId: registration.id,
      relativeFile: registration.relativeFile
    },
    sourcePath
  }];
  if (skinEntry) {
    const target = runtimePngContentAssetTargetSchema.parse({
      kind: "player-skin-tone",
      skinToneId: skinEntry.skinToneId
    });
    if (!resolveRuntimePngContentTarget(target)) {
      throw new Error(`The ${skinEntry.skinToneId} skin tone has no separate artwork slot`);
    }
    inputs.push({ assetId: skinEntry.assetId, target, sourcePath: skinEntry.sourcePath });
  }

  let assets = [...active.assets];
  const blobs = new Map<string, Buffer>();
  for (const input of inputs) {
    const bytes = await readFile(resolve(repositoryRoot, input.sourcePath));
    if (bytes.byteLength > RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES || !isPng(bytes)) {
      throw new Error(`Source for ${input.assetId} must be a PNG within the content pack size limit`);
    }
    const sha256 = hash(bytes);
    const asset = runtimePngContentAssetSchema.parse({
      assetId: input.assetId,
      target: input.target,
      sha256,
      byteLength: bytes.byteLength
    });
    assets = assets.filter((candidate) => runtimePngContentTargetKey(candidate.target) !== runtimePngContentTargetKey(asset.target));
    assets.push(asset);
    blobs.set(sha256, bytes);
  }
  const totalByteLength = assets.reduce((total, asset) => total + asset.byteLength, 0);
  if (totalByteLength > RUNTIME_PNG_CONTENT_MAX_PACK_BYTES) {
    throw new Error("Runtime PNG pack exceeds the total size limit");
  }
  const manifestData = {
    schemaVersion: RUNTIME_PNG_CONTENT_SCHEMA_VERSION,
    totalByteLength,
    assets,
    greenhouseCropPresentations: active.greenhouseCropPresentations
  } as const;
  const packId = hash(Buffer.from(canonicalRuntimePngContentManifest(manifestData), "utf8"));
  const manifest: RuntimePngContentManifest = runtimePngContentManifestSchema.parse({
    ...manifestData,
    packId
  });

  await mkdir(resolve(contentRoot, "blobs"), { recursive: true });
  await mkdir(resolve(contentRoot, "manifests"), { recursive: true });
  for (const asset of manifest.assets) {
    const bytes = blobs.get(asset.sha256) ?? active.blobs.get(asset.sha256);
    if (!bytes || bytes.byteLength !== asset.byteLength || hash(bytes) !== asset.sha256) {
      throw new Error(`Verified source bytes are unavailable for ${asset.assetId}`);
    }
    await writeImmutableBlob(asset.sha256, bytes);
  }
  await writeImmutableManifest(packId, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  if (select) {
    await updateActivePack(packId);
  }
  process.stdout.write(`${JSON.stringify({ packId, assetIds: assets.map((asset) => asset.assetId), totalByteLength, selected: select })}\n`);
}

async function buildGreenhouseCropPack(cropIds: readonly string[], select: boolean): Promise<void> {
  const active = await readActivePack();
  let assets = [...active.assets];
  let greenhouseCropPresentations = [...active.greenhouseCropPresentations];
  const newBlobs = new Map<string, Buffer>();

  for (const cropId of [...new Set(cropIds)]) {
    const crop = GREENHOUSE_CROP_CATALOG[cropId];
    if (!crop || crop.cropId !== cropId) throw new Error(`Unknown server greenhouse crop: ${cropId}`);
    const stageArt: RuntimePngGreenhouseCropPresentation["stages"][number][] = [];
    const cropAssets: RuntimePngContentAsset[] = [];
    for (const stage of [1, 2, 3, 4] as const) {
      const artId = crop.stageArtIds[stage];
      const studioArt = GREENHOUSE_STUDIO_CATALOG.geometry.stageArt.find((entry) =>
        entry.stage === stage && entry.artId === artId
      );
      const sourcePath = studioArt?.assetPath ?? `tools/content-packs/greenhouse-crops/${cropId}/stage-${stage}.png`;
      const bytes = await readFile(resolve(repositoryRoot, sourcePath));
      if (bytes.byteLength > RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES || !isPng(bytes)) {
        throw new Error(`Greenhouse stage art ${artId} is not a valid PNG within the asset limit`);
      }
      const sha256 = hash(bytes);
      const assetId = `${cropId}-stage-${stage}`;
      cropAssets.push(runtimePngContentAssetSchema.parse({
        assetId,
        target: {
          kind: "greenhouse-crop-stage",
          cropId,
          stage
        },
        sha256,
        byteLength: bytes.byteLength
      }));
      newBlobs.set(sha256, bytes);
      stageArt.push({
        stage,
        artId,
        assetId,
        pivotX: studioArt?.pivotX ?? 0.5,
        pivotY: studioArt?.pivotY ?? 0.5,
        offsetX: studioArt?.offsetX ?? 0,
        offsetY: studioArt?.offsetY ?? 0,
        scale: studioArt?.scale ?? 0.68
      });
    }

    const cropPresentation = {
      cropId: crop.cropId,
      displayName: crop.displayName,
      seedDisplayName: crop.seedDisplayName,
      seedItemId: crop.seed.itemId,
      seedVariant: crop.seed.variant,
      stages: stageArt
    };
    assets = assets.filter((asset) =>
      asset.target.kind !== "greenhouse-crop-stage" || asset.target.cropId !== cropId
    );
    assets.push(...cropAssets);
    greenhouseCropPresentations = greenhouseCropPresentations.filter((entry) => entry.cropId !== crop.cropId);
    greenhouseCropPresentations.push(cropPresentation);
  }

  const totalByteLength = assets.reduce((total, asset) => total + asset.byteLength, 0);
  if (totalByteLength > RUNTIME_PNG_CONTENT_MAX_PACK_BYTES) {
    throw new Error("Runtime PNG pack exceeds the total size limit");
  }
  const manifestData = {
    schemaVersion: RUNTIME_PNG_CONTENT_SCHEMA_VERSION,
    totalByteLength,
    assets,
    greenhouseCropPresentations
  } as const;
  const packId = hash(Buffer.from(canonicalRuntimePngContentManifest(manifestData), "utf8"));
  const manifest = runtimePngContentManifestSchema.parse({ ...manifestData, packId });

  await mkdir(resolve(contentRoot, "blobs"), { recursive: true });
  await mkdir(resolve(contentRoot, "manifests"), { recursive: true });
  for (const asset of manifest.assets) {
    const bytes = newBlobs.get(asset.sha256) ?? active.blobs.get(asset.sha256);
    if (!bytes || bytes.byteLength !== asset.byteLength || hash(bytes) !== asset.sha256) {
      throw new Error(`Verified source bytes are unavailable for ${asset.assetId}`);
    }
    await writeImmutableBlob(asset.sha256, bytes);
  }
  await writeImmutableManifest(packId, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  if (select) await updateActivePack(packId);
  process.stdout.write(`${JSON.stringify({
    packId,
    assetIds: manifest.assets.map((asset) => asset.assetId),
    greenhouseCropIds: manifest.greenhouseCropPresentations.map((crop) => crop.cropId),
    totalByteLength,
    selected: select
  })}\n`);
}

async function readActivePack(): Promise<{
  assets: RuntimePngContentAsset[];
  greenhouseCropPresentations: RuntimePngContentManifest["greenhouseCropPresentations"];
  blobs: Map<string, Buffer>;
}> {
  const pointer = JSON.parse(await readFile(resolve(contentRoot, "active.json"), "utf8")) as { packId?: unknown };
  if (typeof pointer.packId !== "string" || !/^[a-f0-9]{64}$/u.test(pointer.packId)) {
    throw new Error("The active runtime PNG pack pointer is invalid");
  }
  const manifestBytes = await readFile(resolve(contentRoot, "manifests", `${pointer.packId}.json`));
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("The active runtime PNG manifest is too large");
  const raw = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  let assets: RuntimePngContentAsset[];
  let greenhouseCropPresentations: RuntimePngContentManifest["greenhouseCropPresentations"];
  if (isRecord(raw) && raw.schemaVersion === RUNTIME_PNG_CONTENT_SCHEMA_VERSION) {
    const manifest = runtimePngContentManifestSchema.parse(raw);
    if (manifest.packId !== pointer.packId || hash(Buffer.from(canonicalRuntimePngContentManifest(manifest), "utf8")) !== pointer.packId) {
      throw new Error("The active runtime PNG manifest identity is invalid");
    }
    assets = [...manifest.assets];
    greenhouseCropPresentations = [...manifest.greenhouseCropPresentations];
  } else if (isRecord(raw) && raw.schemaVersion === 2) {
    const manifest = parseV2Manifest(raw);
    if (manifest.packId !== pointer.packId || hash(Buffer.from(canonicalRuntimePngContentManifest(manifest), "utf8")) !== pointer.packId) {
      throw new Error("The active runtime PNG manifest identity is invalid");
    }
    assets = [...manifest.assets];
    greenhouseCropPresentations = [];
  } else {
    throw new Error("The active runtime PNG pack cannot be extended by this tool");
  }
  const blobs = new Map<string, Buffer>();
  for (const asset of assets) {
    if (!resolveRuntimePngContentTarget(asset.target)) throw new Error(`The active pack has an incompatible target: ${asset.assetId}`);
    const bytes = await readFile(resolve(contentRoot, "blobs", `${asset.sha256}.png`));
    if (bytes.byteLength !== asset.byteLength || hash(bytes) !== asset.sha256 || !isPng(bytes)) {
      throw new Error(`The active pack blob is invalid: ${asset.sha256}`);
    }
    blobs.set(asset.sha256, bytes);
  }
  return { assets, greenhouseCropPresentations, blobs };
}

async function writeImmutableBlob(sha256: string, bytes: Buffer): Promise<void> {
  const blobPath = resolve(contentRoot, "blobs", `${sha256}.png`);
  try {
    const existing = await readFile(blobPath);
    if (hash(existing) !== sha256) throw new Error("An existing content blob does not match its name");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await writeFile(blobPath, bytes, { flag: "wx" });
  }
}

async function writeImmutableManifest(packId: string, bytes: Buffer): Promise<void> {
  const manifestPath = resolve(contentRoot, "manifests", `${packId}.json`);
  try {
    const existing = await readFile(manifestPath);
    if (!existing.equals(bytes)) throw new Error("An existing content manifest does not match its identity");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await writeFile(manifestPath, bytes, { flag: "wx" });
  }
}

async function validatePacks(): Promise<void> {
  const manifestDirectory = resolve(contentRoot, "manifests");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(manifestDirectory)).filter((file) => /^[a-f0-9]{64}\.json$/u.test(file)).sort();
  if (!files.length) throw new Error("No runtime PNG content manifests found");
  for (const file of files) {
    const packId = file.slice(0, -5);
    const manifestBytes = await readFile(resolve(manifestDirectory, file));
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error(`Manifest is too large: ${file}`);
    const rawManifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    if (isRecord(rawManifest) && rawManifest.schemaVersion === 1) {
      await validateLegacyPack(packId, rawManifest);
      continue;
    }
    if (isRecord(rawManifest) && rawManifest.schemaVersion === 2) {
      await validateV2Pack(packId, rawManifest);
      continue;
    }
    const manifest = runtimePngContentManifestSchema.parse(rawManifest);
    if (hash(Buffer.from(canonicalRuntimePngContentManifest(manifest), "utf8")) !== packId || manifest.packId !== packId) {
      throw new Error(`Manifest identity mismatch: ${file}`);
    }
    for (const asset of manifest.assets) {
      if (!resolveRuntimePngContentTarget(asset.target)) {
        throw new Error(`Content target mismatch in ${file}: ${asset.assetId}`);
      }
      const blob = await readFile(resolve(contentRoot, "blobs", `${asset.sha256}.png`));
      if (blob.byteLength !== asset.byteLength || hash(blob) !== asset.sha256 || !isPng(blob)) {
        throw new Error(`Blob verification failed in ${file}: ${asset.sha256}`);
      }
    }
  }
  const pointer = JSON.parse(await readFile(resolve(contentRoot, "active.json"), "utf8")) as { packId?: unknown };
  if (typeof pointer.packId !== "string" || !files.includes(`${pointer.packId}.json`)) {
    throw new Error("The active pointer must name a validated manifest");
  }
  process.stdout.write(`${JSON.stringify({ valid: true, manifests: files.length, activePackId: pointer.packId })}\n`);
}

async function validateV2Pack(packId: string, value: unknown): Promise<void> {
  const manifest = parseV2Manifest(value);
  if (manifest.packId !== packId || hash(Buffer.from(canonicalRuntimePngContentManifest(manifest), "utf8")) !== packId) {
    throw new Error(`Version 2 manifest identity mismatch: ${packId}`);
  }
  for (const asset of manifest.assets) {
    if (!resolveRuntimePngContentTarget(asset.target)) {
      throw new Error(`Version 2 content target mismatch in ${packId}: ${asset.assetId}`);
    }
    const blob = await readFile(resolve(contentRoot, "blobs", `${asset.sha256}.png`));
    if (blob.byteLength !== asset.byteLength || hash(blob) !== asset.sha256 || !isPng(blob)) {
      throw new Error(`Version 2 blob verification failed in ${packId}: ${asset.sha256}`);
    }
  }
}

function parseV2Manifest(value: unknown): {
  schemaVersion: 2;
  packId: string;
  totalByteLength: number;
  assets: RuntimePngContentAsset[];
} {
  if (!isRecord(value) || value.schemaVersion !== 2 ||
    Object.keys(value).some((key) => !["schemaVersion", "packId", "totalByteLength", "assets"].includes(key)) ||
    typeof value.packId !== "string" || !/^[a-f0-9]{64}$/u.test(value.packId) ||
    !Number.isSafeInteger(value.totalByteLength) || Number(value.totalByteLength) <= 0 ||
    Number(value.totalByteLength) > RUNTIME_PNG_CONTENT_MAX_PACK_BYTES ||
    !Array.isArray(value.assets) || value.assets.length < 1 || value.assets.length > 2) {
    throw new Error("Invalid version 2 runtime PNG content manifest");
  }
  const assets = value.assets.map((asset) => runtimePngContentAssetSchema.parse(asset));
  if (assets.reduce((total, asset) => total + asset.byteLength, 0) !== value.totalByteLength) {
    throw new Error("Invalid version 2 runtime PNG content pack size");
  }
  return {
    schemaVersion: 2,
    packId: value.packId,
    totalByteLength: value.totalByteLength as number,
    assets
  };
}

async function validateLegacyPack(packId: string, value: unknown): Promise<void> {
  const manifest = parseLegacyManifest(value);
  const canonical = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    totalByteLength: manifest.totalByteLength,
    assets: manifest.assets.map((asset) => ({
      registrationId: asset.registrationId,
      relativeFile: asset.relativeFile,
      sha256: asset.sha256,
      byteLength: asset.byteLength
    }))
  });
  if (manifest.packId !== packId || hash(Buffer.from(canonical, "utf8")) !== packId) {
    throw new Error(`Legacy manifest identity mismatch: ${packId}`);
  }
  const asset = manifest.assets[0]!;
  const registration = runtimePngAssetRegistrationById(asset.registrationId);
  if (registration?.relativeFile !== asset.relativeFile) {
    throw new Error(`Legacy content target mismatch: ${asset.registrationId}`);
  }
  const blob = await readFile(resolve(contentRoot, "blobs", `${asset.sha256}.png`));
  if (blob.byteLength !== asset.byteLength || hash(blob) !== asset.sha256 || !isPng(blob)) {
    throw new Error(`Legacy blob verification failed: ${asset.sha256}`);
  }
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]!);
  }
  return values;
}

async function updateActivePack(packId: string): Promise<void> {
  const activePath = resolve(contentRoot, "active.json");
  const temporaryPath = resolve(contentRoot, `active.${process.pid}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify({ packId }, null, 2)}\n`, "utf8");
  await rename(temporaryPath, activePath);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLegacyManifest(value: unknown): {
  schemaVersion: 1;
  packId: string;
  totalByteLength: number;
  assets: [{ registrationId: string; relativeFile: string; sha256: string; byteLength: number }];
} {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    typeof value.packId !== "string" || !/^[a-f0-9]{64}$/u.test(value.packId) ||
    !Number.isSafeInteger(value.totalByteLength) || Number(value.totalByteLength) <= 0 ||
    Number(value.totalByteLength) > RUNTIME_PNG_CONTENT_MAX_PACK_BYTES ||
    !Array.isArray(value.assets) || value.assets.length !== 1 || !isRecord(value.assets[0])) {
    throw new Error("Invalid legacy runtime PNG content manifest");
  }
  const asset = value.assets[0];
  if (typeof asset.registrationId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(asset.registrationId) ||
    typeof asset.relativeFile !== "string" || asset.relativeFile.length > 512 ||
    !asset.relativeFile.startsWith(RUNTIME_PNG_CLIENT_ASSET_ROOT) ||
    asset.relativeFile.includes("..") || asset.relativeFile.includes("\\") ||
    typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
    !Number.isSafeInteger(asset.byteLength) || Number(asset.byteLength) <= 0 ||
    Number(asset.byteLength) > RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES ||
    value.totalByteLength !== asset.byteLength) {
    throw new Error("Invalid legacy runtime PNG content asset");
  }
  return {
    schemaVersion: 1,
    packId: value.packId,
    totalByteLength: value.totalByteLength as number,
    assets: [{
      registrationId: asset.registrationId,
      relativeFile: asset.relativeFile,
      sha256: asset.sha256,
      byteLength: asset.byteLength as number
    }]
  };
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
