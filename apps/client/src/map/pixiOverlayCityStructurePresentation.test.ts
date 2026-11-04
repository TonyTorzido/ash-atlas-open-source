import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const overlaySource = readFileSync(new URL("./pixiOverlay.ts", import.meta.url), "utf8").replaceAll("\r\n", "\n");

describe("Pixi city structure presentation", () => {
  it("uses the authored presentation for both rendering and hitboxes at every tier", () => {
    const cityStructureRenderer = sourceBetween(
      overlaySource,
      "function renderCityStructureLayer(",
      "function renderManorLayer("
    );

    expect(cityStructureRenderer).toContain("WORLD_PNG_PRESENTATION.cityStructures[presentationKey]");
    expect(cityStructureRenderer).toContain(
      "WORLD_PNG_PRESENTATION.cityStructures.goblin_market"
    );
    expect(cityStructureRenderer).not.toContain("structure.tier");
    expect(cityStructureRenderer).not.toContain("scaledSpritePresentation");
    expect(cityStructureRenderer).not.toMatch(/worldPngInteractionHitBox\(\{[\s\S]*?scale:/);
  });

  it("positions passive labels from the exact base hitbox instead of a fixed offset", () => {
    const cityRenderer = sourceBetween(
      overlaySource,
      "function renderCityLayer(",
      "function renderCityStructureLayer("
    );
    const cityStructureRenderer = sourceBetween(
      overlaySource,
      "function renderCityStructureLayer(",
      "function renderManorLayer("
    );

    for (const renderer of [cityRenderer, cityStructureRenderer]) {
      expect(renderer).toContain("worldLabelPositionBelowHitBox(hitBox)");
      expect(renderer).toContain("...hitBox");
      expect(renderer).toContain('eventMode = "none"');
      expect(renderer).not.toMatch(/position\.set\([^)]*,\s*-(?:58|84)/);
    }
  });

  it("selects the independent goblin hall presentation in the city renderer", () => {
    const cityRenderer = sourceBetween(
      overlaySource,
      "function renderCityLayer(",
      "function renderCityStructureLayer("
    );

    expect(cityRenderer).toContain("SPRITE_PRESENTATION.goblinHall");
    expect(cityRenderer).toContain("WORLD_SPRITE_PRESENTATION.city");
  });

  it("fades one isolated city-structure label layer without rebuilding structures", () => {
    const layerSetup = sourceBetween(
      overlaySource,
      "  const cityLayer = new Container();",
      "  gameplayWorldLayer.addChild("
    );
    expect(layerSetup).toContain("const cityStructureArtworkLayer = new Container();");
    expect(layerSetup).toContain("const cityStructureLabelLayer = new Container();");
    expect(layerSetup).toContain(
      "cityStructureLayer.addChild(\n    cityStructureArtworkLayer,\n    cityStructureLabelLayer"
    );
    expect(layerSetup).toContain("cityLayer,");

    const cityStructureRenderer = sourceBetween(
      overlaySource,
      "function renderCityStructureLayer(",
      "function renderManorLayer("
    );
    expect(cityStructureRenderer).toContain("artworkLayer: Container");
    expect(cityStructureRenderer).toContain("labelLayer: Container");
    expect(cityStructureRenderer).toContain("artworkLayer.addChild(marker);");
    expect(cityStructureRenderer).toContain("labelLayer.addChild(labelMarker);");
    expect(cityStructureRenderer).not.toContain("persistentWorldDetailAlphaForZoom");
    expect(cityStructureRenderer).not.toMatch(/primaryLabel\.(?:alpha|visible)\s*=/);
    expect(cityStructureRenderer).not.toMatch(/secondaryLabel\.(?:alpha|visible)\s*=/);

    const cityRenderer = sourceBetween(
      overlaySource,
      "function renderCityLayer(",
      "function renderCityStructureLayer("
    );
    expect(cityRenderer).not.toContain("cityStructureLabelLayer");
    expect(cityRenderer).not.toContain("persistentWorldDetailAlphaForZoom");

    const renderOverlay = sourceBetween(
      overlaySource,
      "  const renderOverlay = (onlyIfDirty: boolean = false): void => {",
      "  const takeFrameTiming ="
    );
    expect(renderOverlay).toContain(
      "persistentWorldDetailAlphaForZoom(mapGroundScaleZoom(map))"
    );
    expect(renderOverlay).toContain(
      "cityStructureLabelLayer.alpha = cityStructureLabelAlpha;"
    );
    expect(renderOverlay).toContain(
      "cityStructureLabelLayer.visible = cityStructureLabelAlpha > 0;"
    );
    expect(overlaySource.match(/cityStructureLabelLayer\.alpha\s*=/g)).toHaveLength(1);
  });
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
