export const WATER_VISUAL_TILES_RELEASE_ID = "water-visual-tiles-v1";
export const WATER_VISUAL_TILES_POLICY = "precedence-resolved-canonical-water-visual-v1";
export const WATER_VISUAL_TILES_OCEAN_SURFACE_LAYER = "water_ocean_surface";
export const WATER_VISUAL_TILES_OCEAN_COASTLINE_LAYER = "water_ocean_coastline";
export const WATER_VISUAL_TILES_LAKE_SURFACE_LAYER = "water_lake_surface";
export const WATER_VISUAL_TILES_LAKE_PERIMETER_LAYER = "water_lake_perimeter";
export const WATER_VISUAL_TILES_RIVER_SURFACE_LAYER = "water_river_surface";
export const WATER_VISUAL_TILES_RIVER_PERIMETER_LAYER = "water_river_perimeter";
export const WATER_VISUAL_TILES_MIN_ZOOM = 12;
export const WATER_VISUAL_TILES_MAX_ZOOM = 14;
export const WATER_VISUAL_TILES_MANIFEST_SHA256 =
  "6eece70668d929850944b44ccd134a426972080aeed18865f7c360618daeb229";
export const WATER_VISUAL_TILES_ARTIFACT_SHA256 =
  "7e4a0ddc7821bfb554d34896bb83d2e35a3304a3e7d75ace73c57f73adfa974a";
export const WATER_VISUAL_TILES_ARTIFACT_FILE =
  `water-visual-${WATER_VISUAL_TILES_ARTIFACT_SHA256}.pmtiles`;
export const WATER_VISUAL_TILES_ARTIFACT_SIZE = 1_639_576_487;
export const WATER_VISUAL_TILES_HTTP_PATH =
  `/world-data/${WATER_VISUAL_TILES_RELEASE_ID}/${WATER_VISUAL_TILES_ARTIFACT_FILE}`;

export function waterVisualTilesSourceUrl(origin = globalThis.location.origin): string {
  return `pmtiles://${new URL(WATER_VISUAL_TILES_HTTP_PATH, origin).toString()}`;
}
