/**
 * Camera framing for Ash Heart puzzle rooms: the whole room (board, doors, seal) is fitted into the part of
 * the screen the HUD leaves free (puzzle card, tilt pad, joystick, bottom bar), on desktop and on phones in
 * either orientation. Pure: the caller measures the HUD and applies the camera.
 */
import { interiorLocalToLngLat, type LatLon } from "@ash-atlas/shared";

/** Puzzle rooms may zoom out this far (other interiors stop at INTERIOR_MIN_ZOOM) so a tall room fits a short screen. */
export const PUZZLE_MIN_ZOOM = 13;

export type ScreenRect = Readonly<{ left: number; top: number; right: number; bottom: number }>;

const width = (rect: ScreenRect): number => Math.max(0, rect.right - rect.left);
const height = (rect: ScreenRect): number => Math.max(0, rect.bottom - rect.top);
const overlaps = (a: ScreenRect, b: ScreenRect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Room scale (screen px per room height unit, up to a constant) a rect allows for a room of this width/height aspect. */
const fitScale = (rect: ScreenRect, aspect: number): number => Math.min(width(rect) / aspect, height(rect));

/**
 * Largest screen rect free of every obstacle, built greedily: each obstacle that overlaps the free rect is cut
 * away from the side that leaves the room the most room (largest fitted scale for its aspect).
 */
export function puzzleSafeRect(
  viewport: Readonly<{ width: number; height: number }>,
  obstacles: readonly ScreenRect[],
  roomAspect: number,
  marginPx = 12
): ScreenRect {
  const start: ScreenRect = { left: marginPx, top: marginPx, right: viewport.width - marginPx, bottom: viewport.height - marginPx };
  const aspect = roomAspect > 0 && Number.isFinite(roomAspect) ? roomAspect : 1;
  const padded = obstacles
    .filter((raw) => width(raw) > 0 && height(raw) > 0)
    .slice(0, 14)
    .map((raw): ScreenRect => ({ left: raw.left - marginPx, top: raw.top - marginPx, right: raw.right + marginPx, bottom: raw.bottom + marginPx }));
  // Exhaustive over the side each overlapping obstacle is cut from (pruned by scale; a HUD has a handful).
  // Ties on the room's scale (it is often height-bound) go to the larger free area, so the room sits in the
  // middle of the open screen rather than in whichever corner the search met first.
  let best = start;
  let bestScale = -1;
  let bestArea = -1;
  const search = (safe: ScreenRect, index: number): void => {
    if (fitScale(safe, aspect) < bestScale - 0.5) return;
    const o = padded[index];
    if (!o) {
      const scale = fitScale(safe, aspect);
      const area = width(safe) * height(safe);
      if (scale > bestScale + 0.5 || area > bestArea) {
        bestScale = Math.max(bestScale, scale);
        bestArea = area;
        best = safe;
      }
      return;
    }
    if (!overlaps(safe, o)) { search(safe, index + 1); return; }
    search({ ...safe, bottom: Math.min(safe.bottom, o.top) }, index + 1);
    search({ ...safe, top: Math.max(safe.top, o.bottom) }, index + 1);
    search({ ...safe, right: Math.min(safe.right, o.left) }, index + 1);
    search({ ...safe, left: Math.max(safe.left, o.right) }, index + 1);
  };
  search(start, 0);
  return best;
}

/**
 * Like puzzleSafeRect, but the free rect stays centred on the screen's vertical midline, so the room sits in the
 * middle of the screen: an obstacle across the midline (chat bar, puzzle chip, bottom bar) is cut from the top or
 * the bottom; one off to a side (portrait card, hotbar column, stick, tilt pad) is cut from the top or the bottom,
 * or from both sides at once by its intrusion, whichever leaves the room the most scale.
 */
export function puzzleCenteredSafeRect(
  viewport: Readonly<{ width: number; height: number }>,
  obstacles: readonly ScreenRect[],
  roomAspect: number,
  marginPx = 12
): ScreenRect {
  const mid = viewport.width / 2;
  const start: ScreenRect = { left: marginPx, top: marginPx, right: viewport.width - marginPx, bottom: viewport.height - marginPx };
  const aspect = roomAspect > 0 && Number.isFinite(roomAspect) ? roomAspect : 1;
  const padded = obstacles
    .filter((raw) => width(raw) > 0 && height(raw) > 0)
    .slice(0, 14)
    .map((raw): ScreenRect => ({ left: raw.left - marginPx, top: raw.top - marginPx, right: raw.right + marginPx, bottom: raw.bottom + marginPx }));
  let best = start;
  let bestScale = -1;
  let bestArea = -1;
  const search = (safe: ScreenRect, index: number): void => {
    if (fitScale(safe, aspect) < bestScale - 0.5) return;
    const o = padded[index];
    if (!o) {
      const scale = fitScale(safe, aspect);
      const area = width(safe) * height(safe);
      if (scale > bestScale + 0.5 || (scale > bestScale - 0.5 && area > bestArea)) {
        bestScale = Math.max(bestScale, scale);
        bestArea = area;
        best = safe;
      }
      return;
    }
    if (!overlaps(safe, o)) { search(safe, index + 1); return; }
    search({ ...safe, bottom: Math.min(safe.bottom, o.top) }, index + 1);
    search({ ...safe, top: Math.max(safe.top, o.bottom) }, index + 1);
    if (o.right <= mid || o.left >= mid) {
      const half = o.right <= mid ? mid - o.right : o.left - mid;
      const keep = Math.min(half, mid - safe.left);
      search({ ...safe, left: mid - keep, right: mid + keep }, index + 1);
    }
  };
  search(start, 0);
  return best;
}

/**
 * The room's safe rect: centred on screen when that costs the room little (at least `keep` of the scale the best
 * free rect allows), else the best free rect (a short landscape phone, where a centred room would be tiny).
 */
export function puzzleFramingRect(
  viewport: Readonly<{ width: number; height: number }>,
  obstacles: readonly ScreenRect[],
  roomAspect: number,
  keep = 0.85
): ScreenRect {
  const aspect = roomAspect > 0 && Number.isFinite(roomAspect) ? roomAspect : 1;
  const centred = puzzleCenteredSafeRect(viewport, obstacles, aspect);
  const free = puzzleSafeRect(viewport, obstacles, aspect);
  return fitScale(centred, aspect) >= keep * fitScale(free, aspect) ? centred : free;
}

/** Screen pixels per degree at a zoom (Web Mercator, near the equator where interiors live). */
const pixelsPerDegree = (zoom: number): number => 512 * 2 ** zoom / 360;

/**
 * Camera (centre, zoom) that shows the whole room inside `safe`, the room's centre on the safe rect's centre.
 * The zoom is clamped to [minZoom, maxZoom].
 */
export function puzzleRoomCamera(
  room: Readonly<{ roomWidth: number; roomHeight: number; metersPerUnit: number }>,
  viewport: Readonly<{ width: number; height: number }>,
  safe: ScreenRect,
  zoomLimits: Readonly<{ minZoom: number; maxZoom: number }>
): { center: LatLon; zoom: number } {
  const origin = interiorLocalToLngLat({ x: 0, y: 0 }, room.metersPerUnit);
  const far = interiorLocalToLngLat({ x: room.roomWidth, y: room.roomHeight }, room.metersPerUnit);
  const middle = interiorLocalToLngLat({ x: room.roomWidth / 2, y: room.roomHeight / 2 }, room.metersPerUnit);
  const lonSpan = Math.abs(far.lon - origin.lon) || 1e-9;
  const latSpan = Math.abs(far.lat - origin.lat) || 1e-9;
  const fit = Math.min(
    Math.max(1, width(safe)) / (lonSpan * pixelsPerDegree(0)),
    Math.max(1, height(safe)) / (latSpan * pixelsPerDegree(0))
  );
  const zoom = Math.min(zoomLimits.maxZoom, Math.max(zoomLimits.minZoom, Math.log2(fit)));
  const perDegree = pixelsPerDegree(zoom);
  // Put the room centre on the safe rect centre: shift the camera by the safe centre's offset from the screen centre.
  const dx = (safe.left + safe.right) / 2 - viewport.width / 2;
  const dy = (safe.top + safe.bottom) / 2 - viewport.height / 2;
  return { center: { lat: middle.lat + dy / perDegree, lon: middle.lon - dx / perDegree }, zoom };
}
