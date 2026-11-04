import { MOB_ARCHETYPE_KEYS } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { MOB_ARCHETYPE_ARTWORK, MOB_ARTWORK_URLS } from "./mobArtwork.js";
import { MOB_SPRITE_PRESENTATION } from "./mobSpritePresentation.js";

// Art is the one per-mob piece that lives in the client; the server-side
// wiring is covered by apps/server/src/game/mobCompleteness.test.ts.
describe("mob art wiring", () => {
  it.each(MOB_ARCHETYPE_KEYS.map((key) => [key]))("%s has art or an explicit art-pending entry", (key) => {
    expect(
      Object.hasOwn(MOB_ARCHETYPE_ARTWORK, key),
      `${key}: add it to MOB_ARCHETYPE_ARTWORK (an artwork key, or null while art is pending)`
    ).toBe(true);
    const artworkKey = MOB_ARCHETYPE_ARTWORK[key];
    if (artworkKey === null) return;
    expect(Object.hasOwn(MOB_ARTWORK_URLS, artworkKey), `${key}: ${artworkKey} is missing from MOB_ARTWORK_URLS`)
      .toBe(true);
    expect(
      Object.hasOwn(MOB_SPRITE_PRESENTATION, artworkKey),
      `${key}: ${artworkKey} is missing from MOB_SPRITE_PRESENTATION`
    ).toBe(true);
  });

  it("bundles every artwork key except optional (globbed) art that has not landed yet", () => {
    const optional = new Set(["slime", "slimeMiniboss"]);
    for (const [artworkKey, url] of Object.entries(MOB_ARTWORK_URLS)) {
      if (optional.has(artworkKey)) continue;
      expect(url, `${artworkKey}: PNG import resolved to nothing`).toMatch(/\.png|^data:image\/png/u);
    }
  });
});
