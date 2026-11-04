import { LEGEND_CATALOG } from "./legendCatalog.js";
import type { WorldZoneDiscoverableBiome } from "./worldZones.js";

export type BiomeDiscoveryCelebrationAchievement = Readonly<{
  id: string;
  title: string;
  points: number;
  honor?: string;
}>;

/** What a first region discovery unlocked; the region's own entry comes first. */
export type BiomeDiscoveryCelebration = Readonly<{
  biome: WorldZoneDiscoverableBiome;
  achievements: readonly BiomeDiscoveryCelebrationAchievement[];
}>;

export const biomeLegendId = (biome: WorldZoneDiscoverableBiome): string => `legend_region_${biome}`;

/** Builds the celebration from newly completed Legend ids, region entry first, catalog order after. */
export function biomeDiscoveryCelebration(
  biome: WorldZoneDiscoverableBiome,
  newlyCompletedIds: readonly string[]
): BiomeDiscoveryCelebration {
  const fresh = new Set(newlyCompletedIds);
  const regionId = biomeLegendId(biome);
  const ordered = LEGEND_CATALOG.filter((entry) => fresh.has(entry.id))
    .sort((a, b) => Number(b.id === regionId) - Number(a.id === regionId));
  return {
    biome,
    achievements: ordered.map((entry) => ({
      id: entry.id, title: entry.title, points: entry.points, ...(entry.honor ? { honor: entry.honor } : {})
    }))
  };
}
