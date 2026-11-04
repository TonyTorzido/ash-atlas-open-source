import type { FlagEnvironmentDetails } from "@ash-atlas/shared";

export type SemanticEmptyKind =
  | "present"
  | "none"
  | "not_applicable"
  | "legacy_not_recorded"
  | "beyond_search_radius"
  | "search_incomplete"
  | "no_source_found"
  | "stale"
  | "refresh_required"
  | "unavailable";

export type DisplayValue = {
  kind: SemanticEmptyKind;
  text: string;
};

const FINAL_MAP_FALLBACK = "Map data could not be determined at this location.";

export function present(text: string): DisplayValue {
  return { kind: "present", text };
}

export function semantic(kind: Exclude<SemanticEmptyKind, "present">, text: string): DisplayValue {
  return { kind, text };
}

export function mapDataFallback(): DisplayValue {
  return semantic("unavailable", FINAL_MAP_FALLBACK);
}

export function formatDistance(distanceM: number | null | undefined): string | null {
  if (distanceM == null) return null;
  if (Math.abs(distanceM) >= 1_000) {
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: distanceM >= 10_000 ? 1 : 2 }).format(distanceM / 1_000)} km`;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: distanceM < 10 ? 2 : 0 }).format(distanceM)} m`;
}

export function elevation(details: FlagEnvironmentDetails): DisplayValue {
  if (details.terrain.elevationM != null) {
    return present(`${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(details.terrain.elevationM)} m`);
  }
  if (details.terrain.isSaltwater === true) {
    return semantic("not_applicable", "Land elevation does not apply over open water");
  }
  if (details.provenance.snapshotStatus === "legacy") {
    return semantic("legacy_not_recorded", "Elevation was not recorded in this older map snapshot");
  }
  return semantic("no_source_found", "Elevation data could not be determined here");
}

export function readable(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function gameplayCity(details: FlagEnvironmentDetails): DisplayValue {
  return details.identity.cityId
    ? present(details.identity.cityName ?? "Associated with a player-founded city")
    : semantic("not_applicable", "Not associated with a player city");
}

export function geographicCity(details: FlagEnvironmentDetails): DisplayValue {
  if (details.administrative.insideCity === true && details.administrative.cityName) {
    return present(details.administrative.cityName);
  }
  if (details.administrative.insideCity === false) {
    return semantic("none", "Outside mapped city boundaries");
  }
  return semantic("no_source_found", "City boundary data could not be determined here");
}

export function insideMappedCity(details: FlagEnvironmentDetails): DisplayValue {
  if (details.administrative.insideCity === true) return present("Inside a mapped city boundary");
  if (details.administrative.insideCity === false) return semantic("none", "Outside mapped city boundaries");
  return semantic("no_source_found", "City boundary data could not be determined here");
}

export function crossSourceConflict(details: FlagEnvironmentDetails): DisplayValue {
  if (details.terrain.landCoverConflict === true) {
    return semantic("stale", "Map sources disagree about the surface at this location");
  }
  if (details.terrain.landCoverConflict === false) return present("Map sources agree");
  return details.provenance.snapshotStatus === "legacy"
    ? semantic("legacy_not_recorded", "Source agreement was not recorded in this older snapshot")
    : semantic("no_source_found", "Source agreement could not be determined at this location");
}

export function coastlineDistance(details: FlagEnvironmentDetails): DisplayValue {
  const distanceM = details.terrain.coastlineDistanceM;
  const distance = formatDistance(distanceM);
  const radius = formatDistance(details.terrain.coastlineSearchRadiusM);
  if (distanceM != null && distance) {
    if (distanceM <= 1) return present("On the coast");
    if (details.terrain.isSaltwater === true) return present(`Open saltwater — ${distance} from the coast`);
    if (details.terrain.coastalThresholdM != null && distanceM <= details.terrain.coastalThresholdM) {
      return present(`Near the coast — ${distance} away`);
    }
    return present(`${distance} from the coast`);
  }
  if (details.terrain.isSaltwater === true) {
    if (details.terrain.coastlineSearchComplete === true && radius) {
      return semantic("beyond_search_radius", `Open saltwater — no coast within ${radius}`);
    }
    if (details.terrain.coastlineSearchComplete === false) {
      return semantic("search_incomplete", "Open saltwater — coastline search was limited in this location");
    }
    return semantic("not_applicable", "Open saltwater");
  }
  if (details.terrain.coastlineSearchComplete === true && radius) {
    return semantic("beyond_search_radius", `Far inland — no coast within ${radius}`);
  }
  if (details.terrain.coastlineSearchComplete === false) {
    return semantic("search_incomplete", "Coastline search was limited in this location");
  }
  if (details.provenance.snapshotStatus === "legacy") {
    return semantic("legacy_not_recorded", "Coastline distance was not recorded in this older map snapshot");
  }
  return mapDataFallback();
}

export function ecologyStatus(details: FlagEnvironmentDetails): DisplayValue {
  switch (details.ecology.resolution) {
    case "exact_legacy": return present("Exact ecology from older map snapshot");
    case "exact": return present("Exact mapped ecology");
    case "nearest_land_fallback": return present("Ecology estimated from nearby land");
    case "not_applicable": return semantic("not_applicable", "Terrestrial ecology does not apply here");
    case "unavailable": {
      const radius = formatDistance(details.ecology.fallbackMaxM);
      if (details.ecology.searchComplete === true && radius) {
        return semantic("beyond_search_radius", `No mapped terrestrial ecology within ${radius}`);
      }
      if (details.ecology.searchComplete === false) {
        return semantic("search_incomplete", "Ecology search was limited in this location");
      }
      return semantic("no_source_found", "Terrestrial ecology could not be determined here");
    }
    default:
      if (details.terrain.isSaltwater === true || details.water.majorLake.inside === true) {
        return semantic("not_applicable", "Terrestrial ecology does not apply here");
      }
      if (details.provenance.snapshotStatus === "legacy") {
        return semantic("legacy_not_recorded", "Ecology detail was not recorded in this older map snapshot");
      }
      return mapDataFallback();
  }
}

export function ecologyFallback(details: FlagEnvironmentDetails): DisplayValue {
  if (details.ecology.resolution === "exact_legacy") {
    return semantic("not_applicable", "Not applicable — exact legacy result");
  }
  if (details.ecology.resolution === "exact") {
    return semantic("not_applicable", "Not applicable — exact match");
  }
  const distance = formatDistance(details.ecology.fallbackMaxM);
  return distance ? present(distance) : mapDataFallback();
}

export function searchComplete(
  value: boolean | null | undefined,
  legacy: boolean
): DisplayValue {
  if (value === true) return present("Yes — configured search area completed");
  if (value === false) return semantic("search_incomplete", "No — bounded search was limited");
  return legacy
    ? semantic("legacy_not_recorded", "Not recorded in older map snapshot")
    : semantic("no_source_found", "Search completion state was not returned");
}

export function nearestWaterSummary(details: FlagEnvironmentDetails): DisplayValue {
  const water = details.water.nearest;
  if (water.distanceM != null && (water.sourceName || water.sourceType)) {
    const parts = [
      water.sourceName ?? readable(water.sourceType),
      water.sourceName ? readable(water.sourceType) : null,
      readable(water.kind),
      formatDistance(water.distanceM)
    ].filter((value): value is string => Boolean(value));
    return present(parts.join(" · "));
  }
  const radius = formatDistance(water.searchRadiusM);
  if (water.searchComplete === true && radius) {
    return semantic("beyond_search_radius", `No mapped water source within ${radius}`);
  }
  if (water.searchComplete === false) {
    return semantic("search_incomplete", "Nearby-water search was limited here");
  }
  if (details.provenance.snapshotStatus === "legacy") {
    return semantic("legacy_not_recorded", "This older snapshot did not record a combined nearest-water result");
  }
  return mapDataFallback();
}

export function namedRiverSummary(details: FlagEnvironmentDetails): DisplayValue {
  const river = details.water.namedRiver;
  if (river.name) return present(namedFeature(river.name, river.distanceM));
  if (river.searchComplete === true) return semantic("none", "No major named river nearby");
  if (river.searchComplete === false) return semantic("search_incomplete", "Named-river search was limited here");
  if (details.provenance.snapshotStatus === "legacy") {
    return semantic("legacy_not_recorded", "Detailed river search was not recorded in this older snapshot");
  }
  return mapDataFallback();
}

export function majorLakeSummary(details: FlagEnvironmentDetails): DisplayValue {
  const lake = details.water.majorLake;
  if (lake.inside === true && lake.name) return present(`Inside ${lake.name}`);
  if (lake.inside === true && lake.id) return present("Inside a mapped major lake");
  if (lake.name) return present(namedFeature(lake.name, lake.distanceM));
  if (lake.id || lake.distanceM != null) return present(namedFeature("Mapped major lake", lake.distanceM));
  if (lake.searchComplete === true) return semantic("none", "No major lake nearby");
  if (lake.searchComplete === false) return semantic("search_incomplete", "Major-lake search was limited here");
  if (details.provenance.snapshotStatus === "legacy") {
    return semantic("legacy_not_recorded", "Detailed lake search was not recorded in this older snapshot");
  }
  return mapDataFallback();
}

export function oceanDepth(details: FlagEnvironmentDetails): DisplayValue {
  const depth = details.water.oceanDepthClass;
  if (details.terrain.isSaltwater !== true) {
    return semantic("not_applicable", "Ocean depth does not apply inland");
  }
  if (depth && depth !== "unknown" && depth !== "not_applicable") return present(readable(depth)!);
  return semantic("no_source_found", "Ocean depth could not be classified here");
}

export function surfaceClassification(details: FlagEnvironmentDetails): DisplayValue {
  if (details.terrain.isSaltwater === true) return present("Open saltwater");
  if (details.water.majorLake.inside === true) return present("Major-lake water");
  if (details.terrain.isLand === true) return present("Land");
  if (details.terrain.isLand === false) return present("Mapped inland water");
  return mapDataFallback();
}

export function textOrMapFallback(value: string | null | undefined): DisplayValue {
  return sourceText(value, FINAL_MAP_FALLBACK);
}

export function sourceText(
  value: string | null | undefined,
  missingMessage: string
): DisplayValue {
  if (!value || isGenericMissingText(value)) return semantic("no_source_found", missingMessage);
  return present(value);
}

export function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function formatBoolean(value: boolean | null | undefined): string | null {
  return value == null ? null : value ? "Yes" : "No";
}

function namedFeature(name: string, distanceM: number | null): string {
  const distance = formatDistance(distanceM);
  return distance ? `${name} · ${distance}` : name;
}

function isGenericMissingText(value: string): boolean {
  return /^(?:unavailable|n\/?a|unknown|[\u2014\u2013-])$/i.test(value.trim());
}
