import { portalIds } from "./locations.js";

/**
 * Drowned City raid entrances (docs/design/DROWNED_CITY_SPEC.md section 2). Every Drowned City water
 * site (`drowned3:<band>:<column>`; the earlier families `drowned:`/`drowned2:` still resolve) is an entrance; nothing
 * is stored. Portal ids are `dungeon:<entranceId>:<portalId>` and cannot carry a colon inside the
 * entrance id, so the entrance id is the site id with `_` for `:` (`drowned3_<band>_<column>`).
 * Band and column are base-36.
 */
export const DROWNED_CITY_DUNGEON_ID = "drowned_city";
/** Library entrance used as the template for every site (retired, so never placed by itself). */
export const DROWNED_CITY_ENTRANCE_TEMPLATE_ID = "drowned_city_world_entrance";

const SITE_ID = /^(drowned[23]?):([0-9a-z]+):([0-9a-z]+)$/u;
const ENTRANCE_ID = /^(drowned[23]?)_([0-9a-z]+)_([0-9a-z]+)$/u;

export function drownedCityEntranceIdForSite(siteId: string): string | null {
  const match = SITE_ID.exec(siteId);
  return match ? `${match[1]}_${match[2]}_${match[3]}` : null;
}

export function drownedCitySiteIdForEntrance(entranceId: string): string | null {
  const match = ENTRANCE_ID.exec(entranceId);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
}

/** The dungeon's world-to-entrance portal (every site shares it). */
export const DROWNED_CITY_WORLD_PORTAL_ID = "drowned_city_world_to_entrance";

/** The USE_PORTAL id that enters the Drowned City from this site, or null for another site kind. */
export function drownedCityEntryPortalId(siteId: string): string | null {
  const entranceId = drownedCityEntranceIdForSite(siteId);
  return entranceId ? portalIds.dungeon(entranceId, DROWNED_CITY_WORLD_PORTAL_ID) : null;
}
