/**
 * Equator-equivalent ("ground scale") zoom for world-sprite presentation.
 *
 * Web Mercator magnifies ground distances by 1 / cos(latitude), so the same
 * ground framing sits log2(1 / cos(latitude)) zoom levels lower near the poles.
 * World sprites (players, mobs, flags, structures, PNG objects) and their
 * persistent-detail fade thresholds are sized from this value instead of the raw
 * MapLibre zoom so they keep the same pixel size for the same ground framing.
 * The MapLibre camera zoom is offset by the same amount (see groundScaleCamera.ts),
 * so the ground itself keeps one scale at every latitude.
 */
export const GROUND_SCALE_MIN_COSINE = 0.01;

/** Web Mercator cannot show beyond this latitude (MapLibre clamps to 85.051129). The server stops players at 85. */
export const MAP_MAX_LATITUDE = 85;
/** Floor for any 1 / cos(latitude) the client divides by, so a pole never produces an infinite or absurd scale. */
export const SAFE_COSINE_FLOOR = 0.05;
/** Latitude the camera and renderer may use: finite and inside the Mercator limit. */
export function clampMapLatitude(latitudeDegrees: number): number {
  if (!Number.isFinite(latitudeDegrees)) return 0;
  return Math.max(-MAP_MAX_LATITUDE, Math.min(MAP_MAX_LATITUDE, latitudeDegrees));
}

/** cos(latitude), never below SAFE_COSINE_FLOOR: safe to divide by. */
export function safeCosLatitude(latitudeDegrees: number): number {
  return Math.max(SAFE_COSINE_FLOOR, Math.cos((clampMapLatitude(latitudeDegrees) * Math.PI) / 180));
}

export function groundScaleZoomOffset(latitudeDegrees: number): number {
  if (!Number.isFinite(latitudeDegrees)) {
    return 0;
  }
  const cosine = Math.max(
    GROUND_SCALE_MIN_COSINE,
    Math.cos((latitudeDegrees * Math.PI) / 180)
  );
  return Math.log2(1 / cosine);
}

export function groundScaleZoom(zoom: number, latitudeDegrees: number): number {
  if (!Number.isFinite(zoom)) {
    return zoom;
  }
  return zoom + groundScaleZoomOffset(latitudeDegrees);
}

type GroundScaleMap = {
  getZoom(): number;
  getCenter(): { lat: number };
};

/**
 * Ground-scale zoom of the live map. Map-center latitude is used for every
 * sprite: at gameplay zooms the latitude spread across the viewport is tiny
 * (<0.05 zoom levels even at 85 degrees), and one shared value keeps all
 * sprites, hit radii and fades consistent with each other.
 */
export function mapGroundScaleZoom(map: GroundScaleMap): number {
  return groundScaleZoom(map.getZoom(), map.getCenter().lat);
}
