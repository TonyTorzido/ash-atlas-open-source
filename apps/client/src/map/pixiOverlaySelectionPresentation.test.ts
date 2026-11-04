import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const overlaySource = readFileSync(new URL("./pixiOverlay.ts", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");

describe("production world-object selection presentation", () => {
  it("keeps authored circle and rectangle geometry on the production hit-test path", () => {
    const tanneryRenderer = sourceBetween(
      overlaySource,
      "function renderTanneryLayer(",
      "function renderLoomLayer("
    );
    const tanneryPicker = sourceBetween(
      overlaySource,
      "pickTanneryAt(point: { x: number; y: number }): TanneryWorldSnapshot | null {",
      "pickLoomAt(point: { x: number; y: number }): LoomWorldSnapshot | null {"
    );

    expect(tanneryRenderer).toContain("worldPngInteractionHitBox");
    expect(tanneryRenderer).not.toContain("Tannery hit geometry must remain circular");
    expect(tanneryPicker).toContain("containsScreenHitBox(point, hit)");
    expect(overlaySource).toContain("type TanneryHitBox = ScreenHitBox &");
  });

  it("does not render transient object hit geometry after selection", () => {
    const selectionRenderer = sourceBetween(
      overlaySource,
      "function renderSelectionLayer(",
      "function flagInteractionHitBox("
    );

    for (const objectSelection of [
      "selectedCity",
      "selectedDungeonEntrance",
      "selectedManor",
      "selectedFurnace",
      "selectedTannery",
      "selectedLoom",
      "selectedKitchen",
      "selectedFishingHut"
    ]) {
      expect(selectionRenderer).not.toContain(objectSelection);
    }
    expect(selectionRenderer).toContain("flagPlacementPreview");
    expect(selectionRenderer).toContain("siegePreviewFlagIds");
    expect(selectionRenderer).toContain("selectedFlag");
  });
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
