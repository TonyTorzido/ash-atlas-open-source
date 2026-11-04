import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalRuntimePngContentManifest,
  resolveRuntimePngContentTarget,
  runtimePngContentManifestSchema,
  type RuntimePngContentAsset
} from "./runtimePngContent.js";

describe("runtime PNG content catalog", () => {
  it("accepts an author-supplied content ID for the existing dark skin-tone target", () => {
    const asset: RuntimePngContentAsset = {
      assetId: "winter-dusk-2030",
      target: { kind: "player-skin-tone", skinToneId: "dark" },
      sha256: "a".repeat(64),
      byteLength: 512
    };
    const manifestData = {
      schemaVersion: 3,
      totalByteLength: 512,
      assets: [asset],
      greenhouseCropPresentations: []
    };
    const packId = createHash("sha256")
      .update(canonicalRuntimePngContentManifest(manifestData))
      .digest("hex");

    const manifest = runtimePngContentManifestSchema.parse({ ...manifestData, packId });
    expect(manifest.assets[0]?.assetId).toBe("winter-dusk-2030");
    expect(resolveRuntimePngContentTarget(asset.target)).toEqual({
      kind: "player-appearance",
      assetKey: "bodies/template7c-clean.png"
    });
  });

  it("keeps manifest identity independent of asset array order", () => {
    const first: RuntimePngContentAsset = {
      assetId: "crest-original",
      target: {
        kind: "runtime-png",
        registrationId: "chat-crest-lion",
        relativeFile: "apps/client/src/assets/chat-crests/lion.png"
      },
      sha256: "a".repeat(64),
      byteLength: 100
    };
    const second: RuntimePngContentAsset = {
      assetId: "winter-dusk-2030",
      target: { kind: "player-skin-tone", skinToneId: "dark" },
      sha256: "b".repeat(64),
      byteLength: 200
    };
    const forward = canonicalRuntimePngContentManifest({
      schemaVersion: 3,
      totalByteLength: 300,
      assets: [first, second],
      greenhouseCropPresentations: []
    });
    const reverse = canonicalRuntimePngContentManifest({
      schemaVersion: 3,
      totalByteLength: 300,
      assets: [second, first],
      greenhouseCropPresentations: []
    });
    expect(forward).toBe(reverse);
  });

  it("requires each crop stage art identity to belong to its crop and pack", () => {
    const assets: RuntimePngContentAsset[] = [1, 2, 3, 4].map((stage) => ({
      assetId: `wheat-stage-${stage}`,
      target: {
        kind: "greenhouse-crop-stage",
        cropId: "wheat",
        stage
      },
      sha256: String(stage).repeat(64),
      byteLength: 100
    }));
    const wheatPresentation = {
      cropId: "wheat",
      displayName: "Wheat",
      seedDisplayName: "Wheat Seed",
      seedItemId: "wheat_seed" as const,
      seedVariant: null,
      stages: [1, 2, 3, 4].map((stage) => ({
        stage,
        artId: `wheat_stage_${stage}`,
        assetId: `wheat-stage-${stage}`,
        pivotX: 0.5,
        pivotY: 0.5,
        offsetX: 0,
        offsetY: 0,
        scale: 0.8
      }))
    };
    const manifestData = {
      schemaVersion: 3,
      totalByteLength: 400,
      assets,
      greenhouseCropPresentations: [wheatPresentation]
    };
    const packId = createHash("sha256")
      .update(canonicalRuntimePngContentManifest(manifestData))
      .digest("hex");

    expect(runtimePngContentManifestSchema.safeParse({ ...manifestData, packId }).success).toBe(true);
    const moonbeanAssets: RuntimePngContentAsset[] = [1, 2, 3, 4].map((stage) => ({
      assetId: `moonbean-stage-${stage}`,
      target: { kind: "greenhouse-crop-stage", cropId: "moonbean", stage },
      sha256: String(stage + 4).repeat(64),
      byteLength: 100
    }));
    const moonbean = {
      cropId: "moonbean",
      displayName: "Moonbean",
      seedDisplayName: "Moonbean Seed",
      seedItemId: "seed" as const,
      seedVariant: "moonbean",
      stages: [1, 2, 3, 4].map((stage) => ({
        stage,
        artId: `moonbean_stage_${stage}`,
        assetId: `moonbean-stage-${stage}`,
        pivotX: 0.5,
        pivotY: 0.5,
        offsetX: 0,
        offsetY: 0,
        scale: 0.8
      }))
    };
    const genericManifestData = {
      schemaVersion: 3,
      totalByteLength: 800,
      assets: [...assets, ...moonbeanAssets],
      greenhouseCropPresentations: [wheatPresentation, moonbean]
    };
    const genericPackId = createHash("sha256")
      .update(canonicalRuntimePngContentManifest(genericManifestData))
      .digest("hex");
    expect(runtimePngContentManifestSchema.safeParse({ ...genericManifestData, packId: genericPackId }).success).toBe(true);
    expect(runtimePngContentManifestSchema.safeParse({
      ...manifestData,
      packId,
      greenhouseCropPresentations: [{
        ...wheatPresentation,
        cropId: "moonbean",
        seedDisplayName: "Moonbean Seed",
        seedItemId: "seed",
        seedVariant: "moonbean",
        stages: wheatPresentation.stages.map((stage) => ({
          ...stage,
          artId: stage.artId.replace("wheat", "moonbean"),
          assetId: stage.assetId.replace("wheat", "moonbean")
        }))
      }]
    }).success).toBe(false);
  });
});
