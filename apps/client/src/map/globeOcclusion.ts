import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";

import { isInteriorMapSpace } from "./interiorMapSpace.js";

/** The overlay fades before the geographic horizon so labels do not pop at the limb. */
export const GLOBE_OVERLAY_LIMB_FADE_DEGREES = 10;

export function globeOverlayOpacityForAngularDistance(
  angularDistanceDegrees: number,
  fadeDegrees = GLOBE_OVERLAY_LIMB_FADE_DEGREES
): number {
  if (!Number.isFinite(angularDistanceDegrees)) return 0;
  if (angularDistanceDegrees <= 90 - fadeDegrees) return 1;
  if (angularDistanceDegrees >= 90) return 0;
  return Math.max(0, Math.min(1, (90 - angularDistanceDegrees) / fadeDegrees));
}

export function globeOverlayOpacityForMap(
  map: Pick<MapLibreMap, "getCenter" | "getProjection" | "transform">,
  position: { lat: number; lon: number }
): number {
  // MapLibre has no projection until its style loads; overlays drawn before
  // then (common on slower phones) render as on a flat map.
  if (map.getProjection()?.type !== "globe") return 1;
  // Interiors render around (0, 0) at street zoom; nothing is behind the limb.
  if (isInteriorMapSpace(map)) return 1;
  const center = map.getCenter();
  const angularDistance = sphericalAngularDistanceDegrees(
    center.lat,
    center.lng,
    position.lat,
    position.lon
  );
  // Keep MapLibre's own occlusion decision authoritative at the hard edge,
  // while using the angular distance for a small, stable pre-limb fade.
  const occluded = map.transform.isLocationOccluded(
    new maplibregl.LngLat(position.lon, position.lat)
  );
  if (occluded && angularDistance >= 90) return 0;
  return globeOverlayOpacityForAngularDistance(angularDistance);
}

export function sphericalAngularDistanceDegrees(
  centerLat: number,
  centerLon: number,
  targetLat: number,
  targetLon: number
): number {
  const centerLatRadians = centerLat * Math.PI / 180;
  const targetLatRadians = targetLat * Math.PI / 180;
  const deltaLonRadians = (targetLon - centerLon) * Math.PI / 180;
  const dot = Math.sin(centerLatRadians) * Math.sin(targetLatRadians) +
    Math.cos(centerLatRadians) * Math.cos(targetLatRadians) * Math.cos(deltaLonRadians);
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}
