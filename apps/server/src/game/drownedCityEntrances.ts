import {
  DROWNED_CITY_ENTRANCE_TEMPLATE_ID,
  drownedCitySiteIdForEntrance,
  portalIds,
  type DungeonCatalog,
  type DungeonEntranceDefinition,
  type DungeonEntranceSnapshot,
  type LatLon
} from "@ash-atlas/shared";

import { boundedPortalRevision } from "./locations/portalRevision.js";
import { packageIdForPosition } from "./spatialZones.js";
import { WATER_SITE_PLACEMENT_VERSION, waterSiteCandidateById } from "./waterSitePlacement.js";

/**
 * Drowned City entrances derived from water site ids (docs/design/DROWNED_CITY_SPEC.md section 2).
 * `position` is the site's deterministic slot; whether the site stands on coastal ocean is the
 * caller's check (WaterSiteService.drownedCitySite, fail closed) because it needs World.
 */
export type DrownedCityEntrance = Readonly<{ entrance: DungeonEntranceDefinition; siteId: string }>;

/** The template entrance placed at the site, or null when the id is not a Drowned City site. */
export function drownedCityEntranceAt(catalog: DungeonCatalog, entranceId: string): DrownedCityEntrance | null {
  const siteId = drownedCitySiteIdForEntrance(entranceId);
  const site = siteId ? waterSiteCandidateById(siteId) : null;
  if (!siteId || !site || site.kind !== "drowned_city_site") return null;
  const template = catalog.entrances.find((candidate) => candidate.id === DROWNED_CITY_ENTRANCE_TEMPLATE_ID);
  const dungeon = template ? catalog.dungeons.find((candidate) => candidate.id === template.dungeonId && !candidate.retired) : undefined;
  if (!template || !dungeon) return null;
  return { siteId, entrance: { ...template, id: entranceId, retired: false, lat: site.position.lat, lon: site.position.lon } };
}

export function drownedCityPortalRevision(catalog: DungeonCatalog, entrance: DungeonEntranceDefinition): string {
  const dungeon = catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId);
  return boundedPortalRevision(`${WATER_SITE_PLACEMENT_VERSION}:${entrance.revision}:${entrance.portalRevision}:${dungeon?.revision ?? ""}`);
}

export function drownedCityEntranceSnapshot(catalog: DungeonCatalog, entrance: DungeonEntranceDefinition): DungeonEntranceSnapshot {
  const dungeon = catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId);
  const position: LatLon = { lat: entrance.lat, lon: entrance.lon };
  return {
    entranceId: entrance.id,
    dungeonId: entrance.dungeonId,
    portalId: portalIds.dungeon(entrance.id, entrance.portalId),
    portalRevision: drownedCityPortalRevision(catalog, entrance),
    interactionLabel: entrance.interactionLabel,
    name: entrance.name,
    description: entrance.description,
    regionCode: packageIdForPosition(position),
    lat: entrance.lat,
    lon: entrance.lon,
    interactionRadiusM: entrance.interactionRadiusM,
    footprintRadiusM: entrance.footprintRadiusM,
    presentation: entrance.presentation,
    assetKey: entrance.assetKey,
    templateId: DROWNED_CITY_ENTRANCE_TEMPLATE_ID,
    ...(dungeon?.access ? { access: structuredClone(dungeon.access) } : {})
  };
}
