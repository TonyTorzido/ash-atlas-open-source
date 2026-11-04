import { describe, expect, it } from "vitest";

import {
  FISHING_ENCOUNTER_ARTWORK,
  fishingEncounterBackgroundUrl,
  fishingWaterbodyLabel
} from "./fishingArtwork.js";

describe("fishing encounter artwork", () => {
  it("maps each authoritative water kind to its independent supplied scene", () => {
    expect(FISHING_ENCOUNTER_ARTWORK.fish).toMatch(/PixelFish/i);
    expect(fishingEncounterBackgroundUrl("river")).toMatch(/RiverBackground/i);
    expect(fishingEncounterBackgroundUrl("lake")).toMatch(/LakeBackground/i);
    expect(fishingEncounterBackgroundUrl("ocean")).toMatch(/OceanBackground/i);
  });

  it("derives the readable source label from the waterbody kind", () => {
    expect(fishingWaterbodyLabel("river")).toBe("River");
    expect(fishingWaterbodyLabel("lake")).toBe("Lake");
  });

  it("keeps the generic scene fallback when an unknown kind reaches rendering", () => {
    expect(fishingEncounterBackgroundUrl("unknown" as never)).toBeNull();
  });
});
