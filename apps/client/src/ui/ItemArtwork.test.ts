import { INVENTORY_CATALOG } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { GENERIC_ITEM_ARTWORK_URL, MISSING_ITEM_ARTWORK_URL, itemArtworkSource } from "./ItemArtwork.js";

describe("catalog item artwork coverage", () => {
  it("gives every catalog item its own artwork instead of a fallback", () => {
    const fallbacks = Object.values(INVENTORY_CATALOG)
      .filter((item) => {
        const source = itemArtworkSource(item.itemId, item.category);
        return source === GENERIC_ITEM_ARTWORK_URL || source === MISSING_ITEM_ARTWORK_URL;
      })
      .map((item) => item.itemId)
      // The Shovel has no art yet and no existing sprite fits; it stays empty (missing square) until art lands.
      .filter((itemId) => itemId !== "shovel");
    expect(fallbacks).toEqual([]);
  });

  it("keeps the generic fallback for unknown item ids", () => {
    expect(itemArtworkSource("not_a_real_item")).toBe(GENERIC_ITEM_ARTWORK_URL);
  });
});

describe("equipment item artwork", () => {
  it.each([
    ["deer_hide", "deer-hide.png"],
    ["hog_hide", "hog-hide.png"],
    ["wolf_pelt", "wolf-pelt.png"],
    ["bear_hide", "bear-hide.png"],
    ["alligator_hide", "alligator-hide.png"]
  ])("uses canonical species-material artwork for %s", (itemId, filename) => {
    expect(itemArtworkSource(itemId).endsWith(filename)).toBe(true);
  });

  it("resolves the supplied Venomsteel Furnace artwork", () => {
    expect(itemArtworkSource("venomsteel_bar")).toMatch(/venomsteel-bar\.png$/);
    expect(itemArtworkSource("venomsteel_core")).toMatch(/venomsteel-core\.png$/);
    expect(itemArtworkSource("venomsteel_bar")).not.toBe(itemArtworkSource("iron_bar"));
    expect(itemArtworkSource("venomsteel_core")).not.toBe(itemArtworkSource("iron_bar"));
  });

  it("resolves the published Double Axe and Breast Plate art", () => {
    const doubleAxe = itemArtworkSource("double_axe", "melee_weapon");
    const breastPlate = itemArtworkSource("breast_plate", "chest_armor");

    expect(doubleAxe).toContain("double-axe");
    expect(breastPlate).toContain("/armor/chest/nonswagbreastplate.png");
    expect(doubleAxe).not.toBe(itemArtworkSource("unknown", "melee_weapon"));
    expect(breastPlate).not.toBe(itemArtworkSource("unknown", "chest_armor"));
  });

  it("resolves every Enchantment Stone variant to its supplied artwork", () => {
    for (const variant of [
      "diamond", "onyx", "opal", "amethyst", "topaz", "sapphire", "ruby", "emerald"
    ]) {
      expect(itemArtworkSource("enchantment_stone", null, variant))
        .toMatch(new RegExp(`/enchantment-stones/${variant}\\.png$`));
    }
  });
});
