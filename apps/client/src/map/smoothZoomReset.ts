import type maplibregl from "maplibre-gl";

export const MOBILE_ZOOM_RESET_DURATION_MS = 600;

export function smoothlyResetMapZoom(
  map: Pick<maplibregl.Map, "easeTo" | "stop">,
  zoom: number,
  player: { lat: number; lon: number } | null,
  onNativeGestureStopped: () => void
): void {
  map.stop();
  onNativeGestureStopped();
  map.easeTo({
    zoom,
    ...(player ? { center: [player.lon, player.lat] as [number, number] } : {}),
    duration: MOBILE_ZOOM_RESET_DURATION_MS,
    easing: smoothStep
  });
}

function smoothStep(progress: number): number {
  return progress * progress * (3 - 2 * progress);
}
