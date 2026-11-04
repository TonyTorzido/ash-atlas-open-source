import {
  MOBILE_DEFAULT_MAP_ZOOM,
  MOBILE_MAX_MAP_ZOOM,
  MOBILE_MIN_MAP_ZOOM
} from "./mapZoomConfig.js";

export function readMobileDefaultZoom(playerId: string): number {
  const stored = window.localStorage.getItem(preferenceKey(playerId));
  if (stored === null) return MOBILE_DEFAULT_MAP_ZOOM;
  const parsed = Number(stored);
  return Number.isFinite(parsed) &&
    parsed >= MOBILE_MIN_MAP_ZOOM &&
    parsed <= MOBILE_MAX_MAP_ZOOM
    ? normalizeMobileDefaultZoom(parsed)
    : MOBILE_DEFAULT_MAP_ZOOM;
}

export function persistMobileDefaultZoom(playerId: string, zoom: number): number {
  const normalized = normalizeMobileDefaultZoom(zoom);
  window.localStorage.setItem(preferenceKey(playerId), normalized.toFixed(2));
  return normalized;
}

export function normalizeMobileDefaultZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MOBILE_DEFAULT_MAP_ZOOM;
  return Math.round(
    Math.min(MOBILE_MAX_MAP_ZOOM, Math.max(MOBILE_MIN_MAP_ZOOM, zoom)) * 100
  ) / 100;
}

function preferenceKey(playerId: string): string {
  return `ashAtlas.player.${playerId}.mobileDefaultZoom.v1`;
}
