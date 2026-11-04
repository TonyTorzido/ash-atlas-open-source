export type DungeonZoomLimits = Readonly<{
  minZoom: number;
  defaultZoom: number;
  maxZoom: number;
}>;

// Indoor scenes share the same camera math. Dungeon keeps the historical
// names for compatibility while Manor and future interiors use these neutral
// aliases.
export type IndoorZoomLimits = DungeonZoomLimits;

const DUNGEON_ZOOM_PREFERENCE_KEY = "ashAtlas.dungeonZoom.v1";

export function clampDungeonZoom(zoom: number, limits: DungeonZoomLimits): number {
  const fallback = Number.isFinite(limits.defaultZoom) ? limits.defaultZoom : 1;
  const value = Number.isFinite(zoom) ? zoom : fallback;
  return Math.round(Math.min(limits.maxZoom, Math.max(limits.minZoom, value)) * 1_000) / 1_000;
}

export function initialDungeonZoom(limits: DungeonZoomLimits): number {
  const preferred = readDungeonZoomPreference();
  return clampDungeonZoom(preferred ?? limits.defaultZoom, limits);
}

export function readDungeonZoomPreference(): number | null {
  try {
    const stored = window.localStorage.getItem(DUNGEON_ZOOM_PREFERENCE_KEY);
    if (stored === null) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function persistDungeonZoomPreference(zoom: number): void {
  try {
    window.localStorage.setItem(DUNGEON_ZOOM_PREFERENCE_KEY, zoom.toFixed(3));
  } catch {
    // Storage can be unavailable in privacy modes. Dungeon zoom remains usable in memory.
  }
}

export function dungeonWheelZoom(
  zoom: number,
  deltaY: number,
  limits: DungeonZoomLimits
): number {
  return clampDungeonZoom(zoom * Math.exp(-deltaY * 0.0015), limits);
}

export function dungeonPinchZoom(
  startingZoom: number,
  startingDistance: number,
  currentDistance: number,
  limits: DungeonZoomLimits
): number {
  if (startingDistance <= 0 || currentDistance <= 0) return clampDungeonZoom(startingZoom, limits);
  return clampDungeonZoom(startingZoom * currentDistance / startingDistance, limits);
}

export const clampIndoorZoom = clampDungeonZoom;
export const indoorWheelZoom = dungeonWheelZoom;
export const indoorPinchZoom = dungeonPinchZoom;
