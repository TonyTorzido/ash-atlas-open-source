import type {
  PopulationZoneV2Habitat,
  PopulationZoneV2HabitatCandidateSite
} from "./populationV2HabitatTypes.js";

/** Dry land only: the same land test the other land mobs use (never saltwater or a major lake). */
export function isHollinHutLandSite(site: PopulationZoneV2HabitatCandidateSite): boolean {
  return site.surfaceType === "land" || (
    site.surfaceType === undefined
    && !site.isSaltwater
    && !site.insideMajorLake
    && site.weights.eligibleLand > 0
  );
}

/**
 * A hut anchor is any dry land site, in every biome. What a hut sells depends on its biome (see
 * `hollinIngredientPoolForBiome`), not where it may stand.
 */
export function isHollinHutAnchor(site: PopulationZoneV2HabitatCandidateSite): boolean {
  return isHollinHutLandSite(site) && !site.isSaltwater && !site.insideMajorLake;
}

/**
 * The eligible habitat area: the zone's land area, as long as it has at least one land anchor to
 * place on. With ~1 km2 zones and one hut per 15 km2 this is effectively a single yes/no roll per zone.
 */
export function hollinHutEligibleAreaKm2(habitat: PopulationZoneV2Habitat): number {
  const sites = habitat.candidateSites;
  if (sites === undefined || !sites.some(isHollinHutAnchor)) return 0;
  return habitat.surfaceAreaKm2?.land ?? habitat.eligibleLandKm2;
}
