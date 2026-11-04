import { MOB_SPAWN_RULES, type MobSpawnRule } from "@ash-atlas/shared";
import { MOB_ARCHETYPE_ARTWORK, MOB_ARTWORK_URLS, type MobArtworkKey } from "./mobArtwork.js";

let byBiome: Map<string, MobArtworkKey[]> | null = null;

function build(): Map<string, MobArtworkKey[]> {
  const table = new Map<string, MobArtworkKey[]>();
  const artworkByKind = MOB_ARCHETYPE_ARTWORK as unknown as Readonly<Record<string, MobArtworkKey | undefined>>;
  for (const [kind, rules] of Object.entries(MOB_SPAWN_RULES) as [string, readonly MobSpawnRule[]][]) {
    const artworkKey = artworkByKind[kind];
    if (!artworkKey || !MOB_ARTWORK_URLS[artworkKey]) continue;
    for (const rule of rules) {
      for (const biome of rule.biomes) {
        const keys = table.get(biome) ?? [];
        if (!keys.includes(artworkKey)) keys.push(artworkKey);
        table.set(biome, keys);
      }
    }
  }
  return table;
}

/** Artwork keys of the overworld mobs that can spawn in a biome (land, lake, river and ocean rules). */
export function mobArtworkKeysForBiome(biome: string): readonly MobArtworkKey[] {
  byBiome ??= build();
  return byBiome.get(biome) ?? [];
}
