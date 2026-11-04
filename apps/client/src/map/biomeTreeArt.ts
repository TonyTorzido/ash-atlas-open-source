import {
  isWorldZoneLandCode,
  treeProduceAvailable,
  treeVarietyForStableId,
  worldZoneFromCode,
  type CollectibleNode,
  type WorldZoneLookup
} from "@ash-atlas/shared";

import treeSpriteUrl from "../assets/tree.png";
import resinTreeSpriteUrl from "../assets/ResinTree1.png";

/**
 * Giving Trees and Elder Ferns are drawn per biome from assets/trees/ (512x512 canvases framed like
 * tree.png, so they share SPRITE_PRESENTATION.tree). Willows and pistaches keep one look.
 * Greenwood Giving Trees are tree.png / ResinTree1.png themselves.
 */
export const BIOME_TREE_ART_BIOMES = [
  "jungle",
  "pinewild",
  "greenwood",
  "frostwood",
  "plains",
  "savanna",
  "marsh",
  "highmeadow",
  "scrubland",
  "badlands",
  "steppe",
  "tundra",
  "frozen_waste",
  "coast"
] as const;
export type BiomeTreeArtBiome = (typeof BIOME_TREE_ART_BIOMES)[number];
export const DEFAULT_BIOME_TREE_ART_BIOME: BiomeTreeArtBiome = "greenwood";

const BIOME_SET: ReadonlySet<string> = new Set(BIOME_TREE_ART_BIOMES);

const biomeTreeModules = import.meta.glob<string>("../assets/trees/*.png", {
  eager: true,
  import: "default",
  query: "?url"
});

const BIOME_TREE_URLS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(biomeTreeModules).map(([path, url]) => [
    path.slice(path.lastIndexOf("/") + 1, -".png".length),
    url
  ])
);

/**
 * The tree art name for a collectible, e.g. "elder-fern-jungle-tapped", or null for anything
 * that is not a Giving Tree or Elder Fern.
 */
export function biomeTreeArtName(
  collectible: Pick<CollectibleNode, "id" | "type" | "repeatableNodeType" | "berryAvailable" | "sapReadyAt">,
  biome: BiomeTreeArtBiome,
  nowMs: number
): string | null {
  if (collectible.type !== "wood" || collectible.repeatableNodeType) return null;
  return treeArtNameFor(collectible.id, biome, treeProduceAvailable(collectible, nowMs));
}

/**
 * The same tree's art in its other produce state (fruiting / plain, sap /
 * tapped). Loaded alongside the shown art so taking the produce swaps
 * straight to it; otherwise the first harvest of a session showed the stock
 * fallback tree for a few frames while that file loaded.
 */
export function biomeTreeArtOtherStateName(
  collectible: Pick<CollectibleNode, "id" | "type" | "repeatableNodeType" | "berryAvailable" | "sapReadyAt">,
  biome: BiomeTreeArtBiome,
  nowMs: number
): string | null {
  if (collectible.type !== "wood" || collectible.repeatableNodeType) return null;
  return treeArtNameFor(collectible.id, biome, !treeProduceAvailable(collectible, nowMs));
}

function treeArtNameFor(id: string, biome: BiomeTreeArtBiome, produce: boolean): string | null {
  switch (treeVarietyForStableId(id)) {
    case "giving_tree": return `giving-tree-${biome}${produce ? "-fruiting" : ""}`;
    case "elder_fern": return `elder-fern-${biome}${produce ? "" : "-tapped"}`;
    default: return null;
  }
}

/** The bundled URL for a tree art name, or null when that file is not bundled. */
export function biomeTreeArtUrl(name: string): string | null {
  if (name === "giving-tree-greenwood") return treeSpriteUrl;
  if (name === "giving-tree-greenwood-fruiting") return resinTreeSpriteUrl;
  return BIOME_TREE_URLS[name] ?? null;
}

/** Biome whose tree art shows at a point; greenwood without the lookup or off the land biomes. */
export function treeArtBiomeAt(
  lookup: WorldZoneLookup | null,
  lat: number,
  lon: number
): BiomeTreeArtBiome {
  if (!lookup) return DEFAULT_BIOME_TREE_ART_BIOME;
  const code = lookup.codeAt(lat, lon);
  // Coast is an ocean code: trees there sit on a shore pixel.
  const biome = worldZoneFromCode(code, lat).biome;
  if (!isWorldZoneLandCode(code) && biome !== "coast") return DEFAULT_BIOME_TREE_ART_BIOME;
  return BIOME_SET.has(biome) ? biome as BiomeTreeArtBiome : DEFAULT_BIOME_TREE_ART_BIOME;
}

/**
 * Loads tree textures on first use only, so a phone downloads just the biomes on screen.
 * `get` returns null until the texture is ready and calls `onLoaded` once it is.
 */
export function createLazyTextureCache<TextureType>(
  load: (url: string) => Promise<TextureType>,
  onLoaded: () => void
): Readonly<{ get(url: string): TextureType | null }> {
  const loaded = new Map<string, TextureType>();
  const pending = new Set<string>();
  return {
    get(url) {
      const texture = loaded.get(url);
      if (texture !== undefined) return texture;
      if (!pending.has(url)) {
        pending.add(url);
        void load(url).then((ready) => {
          loaded.set(url, ready);
          onLoaded();
        }, () => {
          pending.delete(url);
        });
      }
      return null;
    }
  };
}
