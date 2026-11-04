import { RUNTIME_PNG_PRESENTATION_CATALOG } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { groundItemGeometryForArtwork } from "./groundItemGeometry.js";

describe("ground item geometry", () => {
  it("uses one player-relative visual and locked hit frame for legacy items", () => {
    const geometry = groundItemGeometryForArtwork("iron_bar", null, 70);

    expect(geometry.artworkKey).toBe("iron_bar");
    expect(geometry.visualHeightUnits).toBe(70);
    expect(geometry.visualWidthUnits).toBe(70);
    expect(geometry.hitWidthUnits).toBe(70);
    expect(geometry.hitHeightUnits).toBe(70);
    expect(geometry.geometry).toEqual(RUNTIME_PNG_PRESENTATION_CATALOG.sprites.iron_bar?.hitGeometry);
  });

  it("keeps aliases and enchantment variants on the shared presentation key", () => {
    expect(groundItemGeometryForArtwork("simple_food", null, 70).artworkKey).toBe("food");
    expect(groundItemGeometryForArtwork("enchantment_stone", "ruby", 70).artworkKey)
      .toBe("enchantment_stone:ruby");
  });
});

