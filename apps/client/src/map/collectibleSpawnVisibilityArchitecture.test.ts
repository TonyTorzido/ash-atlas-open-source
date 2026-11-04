import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(import.meta.dirname, "pixiOverlay.ts"),
  "utf8"
);

describe("collectible first-appearance overlay integration", () => {
  it("tracks the full authoritative id set rather than retained markers", () => {
    const updateStart = source.indexOf("    update(state: RenderState): void {");
    const update = source.slice(
      updateStart,
      source.indexOf("    paintCurrentFrame(): boolean {", updateStart)
    );
    expect(update).toContain(
      "collectibleFirstAppearances.observeAuthoritativeIds("
    );
    expect(update).toContain(
      "state.collectibles.map((collectible) => collectible.id)"
    );
  });

  it("composes spawn and travel alpha while keeping static redraw active", () => {
    const drawStart = source.indexOf("if (needsCollectibleRedraw) {");
    const draw = source.slice(
      drawStart,
      source.indexOf("if (needsDroppedItemRedraw) {", drawStart)
    );
    expect(draw).toContain("collectibleRemainsAcrossFlagTravel(id)");
    expect(draw).toContain("visibility.alpha * firstAppearanceAlpha");
    expect(draw).toContain("alpha >= COLLECTIBLE_SPAWN_INTERACTION_ALPHA");
    expect(draw).toContain("collectibleFirstAppearances.hasActiveFade(");
  });
});
