export const DEFAULT_MAP_ZOOM = 15;
export const MIN_MAP_ZOOM = 2;
export const MAX_MAP_ZOOM = 18;
export const MOBILE_DEFAULT_MAP_ZOOM = 15;
export const MOBILE_MIN_MAP_ZOOM = MIN_MAP_ZOOM;
export const MOBILE_MAX_MAP_ZOOM = 18;

// Keep local gameplay detail readable while letting the native globe take over
// at the distant end of the normal map. These are derived from the actual map
// floor so the LOD remains coupled to the reachable world view.
export const GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM = MIN_MAP_ZOOM + 2;
export const GAMEPLAY_MAP_DETAIL_FULL_ZOOM = MIN_MAP_ZOOM + 6;

export function gameplayMapDetailAlphaForZoom(zoom: number): number {
  const progress = Math.max(
    0,
    Math.min(
      1,
      (zoom - GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM) /
        (GAMEPLAY_MAP_DETAIL_FULL_ZOOM - GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM)
    )
  );
  return progress * progress * (3 - 2 * progress);
}

export type MapZoomOptions = {
  zoom: number;
  minZoom: number;
  maxZoom: number;
};

export const MOBILE_MAP_ZOOM_OPTIONS: MapZoomOptions = {
  zoom: MOBILE_DEFAULT_MAP_ZOOM,
  minZoom: MOBILE_MIN_MAP_ZOOM,
  maxZoom: MOBILE_MAX_MAP_ZOOM
};
