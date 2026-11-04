import { z } from "zod";

import {
  DEFAULT_PLAYER_BODY_VARIANT_ID,
  PLAYER_SKIN_TONE_IDS,
  playerSkinToneAssetKey
} from "./appearance.js";
import { DEFAULT_PLAYER_APPEARANCE_CATALOG } from "./appearanceCatalog.js";
import { GREENHOUSE_CROP_ID_REGEX } from "./greenhouse.js";
import {
  RUNTIME_PNG_CLIENT_ASSET_ROOT,
  runtimePngAssetRegistrationById
} from "./runtimePngAssets.js";

export const RUNTIME_PNG_CONTENT_SCHEMA_VERSION = 3 as const;
export const RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const RUNTIME_PNG_CONTENT_MAX_PACK_BYTES = 5 * 1024 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const contentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/u);
const relativeFileSchema = z.string()
  .max(512)
  .startsWith(RUNTIME_PNG_CLIENT_ASSET_ROOT)
  .refine((value) => !value.includes("..") && !value.includes("\\"), "Expected a canonical client PNG path");

const greenhouseCropStageSchema = z.object({
  stage: z.number().int().min(1).max(4),
  artId: contentIdSchema,
  assetId: contentIdSchema,
  pivotX: z.number().finite().min(0).max(1),
  pivotY: z.number().finite().min(0).max(1),
  offsetX: z.number().finite().min(-512).max(512),
  offsetY: z.number().finite().min(-512).max(512),
  scale: z.number().finite().gt(0).max(2)
}).strict();

export const runtimePngGreenhouseCropPresentationSchema = z.object({
  cropId: z.string().regex(GREENHOUSE_CROP_ID_REGEX),
  displayName: z.string().trim().min(1).max(48),
  seedDisplayName: z.string().trim().min(1).max(48),
  seedItemId: z.enum(["seed", "wheat_seed", "giving_berry"]),
  seedVariant: z.string().regex(GREENHOUSE_CROP_ID_REGEX).nullable(),
  stages: z.array(greenhouseCropStageSchema).length(4)
}).strict();

export const runtimePngContentAssetTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("runtime-png"),
    registrationId: contentIdSchema,
    relativeFile: relativeFileSchema
  }).strict(),
  z.object({
    kind: z.literal("player-skin-tone"),
    skinToneId: z.enum(PLAYER_SKIN_TONE_IDS)
  }).strict(),
  z.object({
    kind: z.literal("greenhouse-crop-stage"),
    cropId: z.string().regex(GREENHOUSE_CROP_ID_REGEX),
    stage: z.number().int().min(1).max(4)
  }).strict()
]);

export const runtimePngContentAssetSchema = z.object({
  /** Stable catalog identity chosen by the content author; it is independent of the source path. */
  assetId: contentIdSchema,
  target: runtimePngContentAssetTargetSchema,
  sha256: sha256Schema,
  byteLength: z.number().int().positive().max(RUNTIME_PNG_CONTENT_MAX_ASSET_BYTES)
}).strict();

export const runtimePngContentManifestSchema = z.object({
  schemaVersion: z.literal(RUNTIME_PNG_CONTENT_SCHEMA_VERSION),
  packId: sha256Schema,
  totalByteLength: z.number().int().positive().max(RUNTIME_PNG_CONTENT_MAX_PACK_BYTES),
  assets: z.array(runtimePngContentAssetSchema).min(1).max(128),
  greenhouseCropPresentations: z.array(runtimePngGreenhouseCropPresentationSchema).max(32)
}).strict().superRefine((manifest, context) => {
  const assetIds = new Set<string>();
  const targetKeys = new Set<string>();
  let totalByteLength = 0;
  for (const [index, asset] of manifest.assets.entries()) {
    if (assetIds.has(asset.assetId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "assetId"], message: "Content IDs must be unique" });
    }
    assetIds.add(asset.assetId);
    const key = runtimePngContentTargetKey(asset.target);
    if (targetKeys.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "target"], message: "A pack cannot replace the same target twice" });
    }
    targetKeys.add(key);
    totalByteLength += asset.byteLength;
  }
  const presentationCropIds = new Set<string>();
  const presentationArtIds = new Set<string>();
  const presentationAssetIds = new Set<string>();
  for (const [cropIndex, crop] of manifest.greenhouseCropPresentations.entries()) {
    if (presentationCropIds.has(crop.cropId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["greenhouseCropPresentations", cropIndex, "cropId"],
        message: "Crop presentation IDs must be unique"
      });
    }
    presentationCropIds.add(crop.cropId);
    if ((crop.seedItemId === "seed" && crop.seedVariant !== crop.cropId) ||
      (crop.seedItemId === "wheat_seed" && (crop.cropId !== "wheat" || crop.seedVariant !== null)) ||
      (crop.seedItemId === "giving_berry" && (crop.cropId !== "giving_berry_tree" || crop.seedVariant !== null))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["greenhouseCropPresentations", cropIndex, "seedVariant"],
        message: "Seed identity must match the crop ID"
      });
    }
    const stages = new Set<number>();
    for (const [stageIndex, stage] of crop.stages.entries()) {
      if (stages.has(stage.stage)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["greenhouseCropPresentations", cropIndex, "stages", stageIndex, "stage"],
          message: "Crop stages must be unique"
        });
      }
      stages.add(stage.stage);
      if (!stage.artId.startsWith(`${crop.cropId}_`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["greenhouseCropPresentations", cropIndex, "stages", stageIndex, "artId"],
          message: "Crop stages must use art registered for that crop"
        });
      }
      if (presentationArtIds.has(stage.artId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["greenhouseCropPresentations", cropIndex, "stages", stageIndex, "artId"],
          message: "Crop art IDs must be unique within the pack"
        });
      }
      presentationArtIds.add(stage.artId);
      if (presentationAssetIds.has(stage.assetId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["greenhouseCropPresentations", cropIndex, "stages", stageIndex, "assetId"],
          message: "Crop stage assets must be unique within the pack"
        });
      }
      presentationAssetIds.add(stage.assetId);
      const asset = manifest.assets.find((candidate) => candidate.assetId === stage.assetId &&
        candidate.target.kind === "greenhouse-crop-stage" &&
        candidate.target.cropId === crop.cropId && candidate.target.stage === stage.stage);
      if (!asset) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["greenhouseCropPresentations", cropIndex, "stages", stageIndex, "assetId"],
          message: "Every crop stage must reference a matching pack asset"
        });
      }
    }
  }
  if (manifest.totalByteLength !== totalByteLength) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["totalByteLength"], message: "Pack size must equal the sum of its assets" });
  }
});

export type RuntimePngContentAssetTarget = z.infer<typeof runtimePngContentAssetTargetSchema>;
export type RuntimePngContentAsset = z.infer<typeof runtimePngContentAssetSchema>;
export type RuntimePngGreenhouseCropPresentation = z.infer<typeof runtimePngGreenhouseCropPresentationSchema>;
export type RuntimePngContentManifest = z.infer<typeof runtimePngContentManifestSchema>;
export type ResolvedRuntimePngContentTarget =
  | Readonly<{ kind: "runtime-png"; relativeFile: string }>
  | Readonly<{ kind: "player-appearance"; assetKey: string }>
  | Readonly<{ kind: "greenhouse-crop-stage"; cropId: string; stage: number }>;

/** Resolves data targets to existing client mechanics and rejects incompatible catalog slots. */
export function resolveRuntimePngContentTarget(
  target: RuntimePngContentAssetTarget
): ResolvedRuntimePngContentTarget | null {
  if (target.kind === "runtime-png") {
    const registration = runtimePngAssetRegistrationById(target.registrationId);
    return registration?.relativeFile === target.relativeFile
      ? { kind: "runtime-png", relativeFile: registration.relativeFile }
      : null;
  }
  if (target.kind === "greenhouse-crop-stage") {
    return { kind: "greenhouse-crop-stage", cropId: target.cropId, stage: target.stage };
  }
  const assetKey = playerSkinToneAssetKey(
    DEFAULT_PLAYER_APPEARANCE_CATALOG,
    DEFAULT_PLAYER_BODY_VARIANT_ID,
    target.skinToneId
  );
  return assetKey ? { kind: "player-appearance", assetKey } : null;
}

export function runtimePngContentTargetKey(target: RuntimePngContentAssetTarget): string {
  switch (target.kind) {
    case "runtime-png": return `runtime-png:${target.registrationId}`;
    case "player-skin-tone": return `player-skin-tone:${target.skinToneId}`;
    case "greenhouse-crop-stage": return `greenhouse-crop-stage:${target.cropId}:${target.stage}`;
  }
}

/** Stable JSON bytes hashed for the pack identity; the packId field is omitted. */
export function canonicalRuntimePngContentManifest(
  value: Readonly<{
    schemaVersion: number;
    totalByteLength: number;
    assets: readonly RuntimePngContentAsset[];
    greenhouseCropPresentations?: readonly RuntimePngGreenhouseCropPresentation[];
  }>
): string {
  const assets = [...value.assets]
    .sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0)
    .map((asset) => ({
      assetId: asset.assetId,
      target: asset.target.kind === "runtime-png"
        ? {
            kind: asset.target.kind,
            registrationId: asset.target.registrationId,
            relativeFile: asset.target.relativeFile
          }
      : {
            ...(asset.target.kind === "player-skin-tone"
              ? { kind: asset.target.kind, skinToneId: asset.target.skinToneId }
              : { kind: asset.target.kind, cropId: asset.target.cropId, stage: asset.target.stage })
          },
      sha256: asset.sha256,
      byteLength: asset.byteLength
    }));
  const greenhouseCropPresentations = [...(value.greenhouseCropPresentations ?? [])]
    .sort((left, right) => left.cropId < right.cropId ? -1 : left.cropId > right.cropId ? 1 : 0)
    .map((crop) => ({
      cropId: crop.cropId,
      displayName: crop.displayName,
      seedDisplayName: crop.seedDisplayName,
      seedItemId: crop.seedItemId,
      seedVariant: crop.seedVariant,
      stages: [...crop.stages]
        .sort((left, right) => left.stage - right.stage)
        .map((stage) => ({
          stage: stage.stage,
          artId: stage.artId,
          assetId: stage.assetId,
          pivotX: stage.pivotX,
          pivotY: stage.pivotY,
          offsetX: stage.offsetX,
          offsetY: stage.offsetY,
          scale: stage.scale
        }))
    }));
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    totalByteLength: value.totalByteLength,
    assets,
    ...(value.schemaVersion >= RUNTIME_PNG_CONTENT_SCHEMA_VERSION ? { greenhouseCropPresentations } : {})
  });
}
