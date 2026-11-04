import { describe, expect, it, vi } from "vitest";
import type { CollectibleNode, WorldZoneLookup } from "@ash-atlas/shared";

import {
  BIOME_TREE_ART_BIOMES,
  biomeTreeArtName,
  biomeTreeArtOtherStateName,
  biomeTreeArtUrl,
  createLazyTextureCache,
  treeArtBiomeAt
} from "./biomeTreeArt.js";
import { SPRITE_ARTWORK_URLS } from "./pixiOverlay.js";
import { collectibleDisplayName, collectibleProduceAvailable } from "../collectibles/harvest.js";

// "node-wood-1" is a Giving Tree, "node-wood" a Elder Fern, "tree-200" a willow.
const tree = (id: string, extra: Partial<CollectibleNode> = {}) => ({
  id,
  type: "wood" as const,
  ...extra
});
const NOW = Date.parse("2026-10-06T12:00:00.000Z");

describe("per-biome tree art", () => {
  it("names Giving Tree and Elder Fern art by biome and state", () => {
    expect(biomeTreeArtName(tree("node-wood-1"), "jungle", NOW)).toBe("giving-tree-jungle");
    expect(biomeTreeArtName(tree("node-wood-1", { berryAvailable: true }), "jungle", NOW))
      .toBe("giving-tree-jungle-fruiting");
    expect(biomeTreeArtName(tree("node-wood", { sapReadyAt: null }), "tundra", NOW))
      .toBe("elder-fern-tundra");
    expect(biomeTreeArtName(tree("node-wood", { sapReadyAt: "2026-10-06T13:00:00.000Z" }), "tundra", NOW))
      .toBe("elder-fern-tundra-tapped");
    expect(biomeTreeArtName(tree("tree-200"), "jungle", NOW)).toBeNull();
    expect(biomeTreeArtName({ id: "node-stone", type: "stone" }, "jungle", NOW)).toBeNull();
  });

  it("names the other produce state's art, to load it before the produce is taken", () => {
    expect(biomeTreeArtOtherStateName(tree("node-wood-1", { berryAvailable: true }), "jungle", NOW))
      .toBe("giving-tree-jungle");
    expect(biomeTreeArtOtherStateName(tree("node-wood", { sapReadyAt: null }), "tundra", NOW))
      .toBe("elder-fern-tundra-tapped");
    expect(biomeTreeArtOtherStateName(tree("tree-200"), "jungle", NOW)).toBeNull();
  });

  it("draws the same sap state the tree's name and menu show", () => {
    for (const sapReadyAt of [null, "2026-10-06T11:59:59.000Z", "2026-10-06T13:00:00.000Z"]) {
      const fern = { ...tree("node-wood", { sapReadyAt }), lat: 35, lon: -106 } as CollectibleNode;
      const artTapped = biomeTreeArtName(fern, "greenwood", NOW)!.endsWith("-tapped");
      expect(collectibleDisplayName(fern, NOW).endsWith("(Tapped)")).toBe(artTapped);
      expect(collectibleProduceAvailable(fern, NOW)).toBe(!artTapped);
    }
  });

  it("bundles every biome file and maps greenwood Giving Trees to the original art", () => {
    expect(biomeTreeArtUrl("giving-tree-greenwood")).toBe(SPRITE_ARTWORK_URLS.tree);
    expect(biomeTreeArtUrl("giving-tree-greenwood-fruiting")).toMatch(/ResinTree1\.png$/u);
    for (const biome of BIOME_TREE_ART_BIOMES) {
      for (const name of [
        `giving-tree-${biome}`,
        `giving-tree-${biome}-fruiting`,
        `elder-fern-${biome}`,
        `elder-fern-${biome}-tapped`
      ]) {
        expect(biomeTreeArtUrl(name), name).toBeTruthy();
      }
    }
  });

  it("reads the biome at the tree and falls back to greenwood", () => {
    const lookupWith = (code: number): WorldZoneLookup => ({
      codeAt: () => code,
      nearestCodeAt: () => null
    });
    expect(treeArtBiomeAt(null, 35, -106)).toBe("greenwood");
    expect(treeArtBiomeAt(lookupWith(0), 35, -106)).toBe("greenwood");
    const biomes = new Set<string>();
    // Deserts read as Steppe away from the warm belt, so sample two latitudes.
    for (const latitude of [10, 50]) {
      for (let code = 0; code < 256; code += 1) biomes.add(treeArtBiomeAt(lookupWith(code), latitude, -106));
    }
    expect([...biomes].sort()).toEqual([...BIOME_TREE_ART_BIOMES].sort());
  });

  it("loads a texture once, on first use", async () => {
    const load = vi.fn(async (url: string) => `texture:${url}`);
    const onLoaded = vi.fn();
    const cache = createLazyTextureCache(load, onLoaded);
    expect(cache.get("a.png")).toBeNull();
    expect(cache.get("a.png")).toBeNull();
    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    expect(cache.get("a.png")).toBe("texture:a.png");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
