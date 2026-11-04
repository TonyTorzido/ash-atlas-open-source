import type { FeatureCollection, Polygon } from "geojson";

import { GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM } from "./mapZoomConfig.js";

/**
 * The native globe leaves the area outside its projected sphere to the map
 * container. Keep the chrome decision shared by the gameplay and standalone
 * maps so their distant presentation enters globe-space at the same point.
 */
export const GLOBE_SPACE_BACKGROUND_MAX_ZOOM = GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM;
export const GLOBE_SPACE_BACKGROUND_CLASS = "aa-map-globe-space";

export const WORLD_GLOBE_OCEAN: FeatureCollection<Polygon> = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-180, -85.05112878],
        [180, -85.05112878],
        [180, 85.05112878],
        [-180, 85.05112878],
        [-180, -85.05112878]
      ]]
    }
  }]
};

export function globeSpaceBackgroundVisibleAtZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom <= GLOBE_SPACE_BACKGROUND_MAX_ZOOM;
}

export function syncGlobeSpaceBackground(
  map: Readonly<{
    getContainer(): HTMLElement;
    getZoom(): number;
  }>
): void {
  map.getContainer().classList.toggle(
    GLOBE_SPACE_BACKGROUND_CLASS,
    globeSpaceBackgroundVisibleAtZoom(map.getZoom())
  );
}
