import { describe, expect, it } from "vitest";
import { RUNTIME_PNG_PRESENTATION_CATALOG } from "@ash-atlas/shared";

import type { RuntimeAsset } from "./bridgeTypes.js";
import { runtimeAssetUsages } from "./runtimeAssetCatalog.js";
import {
  defaultRuntimeAssetUsage,
  dimensionsMatchAspectRatio,
  fixedDimensionPatch,
  previewSize,
  spriteDimensionPatch,
  spriteEditorDimensions
} from "./AssetStudio.js";

describe("Asset Studio production sizing", () => {
  it("selects the first visual editor instead of a preceding read-only usage", () => {
    const asset = {
      usages: runtimeAssetUsages("apps/client/src/assets/dogs/DogAdult1.png")
    } as RuntimeAsset;

    expect(asset.usages[0]?.editor.kind).toBe("readonly");
    expect(defaultRuntimeAssetUsage(asset)?.editor).toEqual({ kind: "sprite", key: "dog" });
  });

  it("detects and repairs distorted dimensions while preserving height", () => {
    expect(dimensionsMatchAspectRatio(120, 80, 100, 100)).toBe(false);
    expect(fixedDimensionPatch("height", 80, 100, 100, true))
      .toEqual({ width: 80, height: 80 });
  });

  it("couples locked width and height edits to intrinsic proportions", () => {
    expect(fixedDimensionPatch("width", 200, 200, 100, true))
      .toEqual({ width: 200, height: 100 });
    expect(spriteDimensionPatch(
      "width",
      200,
      { width: 100, height: 50 },
      200,
      100,
      true
    )).toEqual({ baseHeightPx: 100, horizontalScale: 1 });
  });

  it("supports unlocked sprite stretching and preserves width during height edits", () => {
    const stretched = spriteDimensionPatch(
      "width",
      150,
      { width: 100, height: 50 },
      100,
      100,
      false
    );
    expect(stretched).toEqual({ horizontalScale: 3 });

    const heightPatch = spriteDimensionPatch(
      "height",
      100,
      { width: 150, height: 50 },
      100,
      100,
      false
    );
    expect(heightPatch).toEqual({ baseHeightPx: 100, horizontalScale: 1.5 });
    expect(spriteEditorDimensions({
      baseHeightPx: 100,
      horizontalScale: 1.5,
      minHeightPx: 25,
      maxHeightPx: null,
      zoomStrength: 0.70389327891398,
      anchorX: 0.5,
      anchorY: 1,
      hitGeometry: { shape: "rectangle", centerX: 0.5, centerY: 0.5, width: 1, height: 1 }
    }, 100, 100)).toEqual({ width: 150, height: 100 });
  });

  it("applies master scale to eligible previews but not excluded usages", () => {
    const presentation = structuredClone(RUNTIME_PNG_PRESENTATION_CATALOG);
    presentation.masterScale = 2;
    const asset = { width: 100, height: 100 } as RuntimeAsset;
    const eligible = previewSize(
      asset,
      { editor: { kind: "sprite", key: "deer" } } as RuntimeAsset["usages"][number],
      presentation
    );
    const player = previewSize(
      asset,
      { editor: { kind: "sprite", key: "player" } } as RuntimeAsset["usages"][number],
      presentation
    );
    const flag = previewSize(
      asset,
      { editor: { kind: "sprite", key: "flag" } } as RuntimeAsset["usages"][number],
      presentation
    );
    const buoy = previewSize(
      asset,
      { editor: { kind: "sprite", key: "buoy" } } as RuntimeAsset["usages"][number],
      presentation
    );
    const shrine = previewSize(
      asset,
      { editor: { kind: "fixed", key: "worldMapAtlasShrine" } } as RuntimeAsset["usages"][number],
      presentation
    );

    expect(eligible.height).toBe(presentation.sprites.deer!.baseHeightPx * 2);
    expect(player.height).toBe(presentation.sprites.player!.baseHeightPx);
    expect(flag.height).toBe(presentation.sprites.flag!.baseHeightPx);
    expect(buoy.height).toBe(presentation.sprites.buoy!.baseHeightPx);
    expect(shrine.height).toBe(presentation.fixed.worldMapAtlasShrine!.height * 2);
  });
});
