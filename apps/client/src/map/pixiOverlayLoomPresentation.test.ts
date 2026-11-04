import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const overlaySource = readFileSync(new URL("./pixiOverlay.ts", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");

describe("Pixi Loom PNG presentation", () => {
  it("uses the registered Loom asset with its own zoom-scaled presentation", () => {
    const loomRenderer = sourceBetween(
      overlaySource,
      "function renderLoomLayer(",
      "function renderKitchenLayer("
    );

    expect(overlaySource).toContain('loadOptionalRegisteredTexture("loom", tanneryTexture)');
    expect(overlaySource).toContain("visibleState.looms");
    expect(overlaySource).toContain("loomTexture");
    expect(loomRenderer).toContain("WORLD_PNG_PRESENTATION.loom");
    expect(loomRenderer).toContain("applyZoomScaledPresentation");
    expect(loomRenderer).toContain("worldPngInteractionHitBox");
    expect(loomRenderer).not.toContain("Loom hit geometry must remain circular");
    expect(loomRenderer).not.toContain("WORLD_PNG_PRESENTATION.tannery");
    expect(loomRenderer).not.toContain("fixedWorldPngDimensions");
  });
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
