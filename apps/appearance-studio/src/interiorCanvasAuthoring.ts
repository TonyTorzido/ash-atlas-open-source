import type { IndoorPoint } from "@ash-atlas/shared";

/**
 * Polygon-authoring helpers shared by the Manor canvas and the Interior Studio
 * canvas (connected vertices, close-shape, vertex edits, wall image mapping).
 * Pure and browser-safe.
 */

/** Grid step used when "snap to grid" is on (fine, so dragging still follows the cursor). */
export const CANVAS_GRID_SIZE = 5;
/** How close a click must land to the first vertex to close a polygon. */
export const POLYGON_CLOSE_HIT_RADIUS = 24;
export const MIN_POLYGON_VERTICES = 3;

export type MutablePoint = { x: number; y: number };
export type UvPoint = { u: number; v: number };
export type WallImageTransform = { offsetU: number; offsetV: number; scaleU: number; scaleV: number; rotationDeg: number };

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function distance(first: IndoorPoint, second: IndoorPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

/** `prefix` when unused, otherwise `prefix_2`, `prefix_3`, ... */
export function uniqueId(prefix: string, ids: readonly string[]): string {
  if (!ids.includes(prefix)) return prefix;
  let index = 2;
  while (ids.includes(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

export function snapPoint(point: IndoorPoint, enabled: boolean, grid = CANVAS_GRID_SIZE): IndoorPoint {
  return enabled ? { x: Math.round(point.x / grid) * grid, y: Math.round(point.y / grid) * grid } : { x: point.x, y: point.y };
}

/** True when the pointer is close enough to the highlighted first dot to close a polygon. */
export function shouldClosePolygon(
  points: readonly IndoorPoint[],
  point: IndoorPoint,
  hitRadius = POLYGON_CLOSE_HIT_RADIUS
): boolean {
  return points.length >= MIN_POLYGON_VERTICES && distance(point, points[0]!) <= hitRadius;
}

export function translatePoints(points: MutablePoint[], delta: IndoorPoint, bounds: { width: number; height: number }): void {
  for (const point of points) {
    point.x = clamp(point.x + delta.x, 0, bounds.width);
    point.y = clamp(point.y + delta.y, 0, bounds.height);
  }
}

/** New vertex at the midpoint between vertex `index` and the next one (wrapping). Returns the new vertex index. */
export function insertVertexAfter(points: MutablePoint[], index: number): number {
  const from = points[index];
  const to = points[(index + 1) % points.length];
  if (!from || !to) return index;
  points.splice(index + 1, 0, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
  return index + 1;
}

/** Removes a vertex; refuses to leave fewer than three. */
export function removeVertexAt(points: MutablePoint[], index: number): boolean {
  if (points.length <= MIN_POLYGON_VERTICES || index < 0 || index >= points.length) return false;
  points.splice(index, 1);
  return true;
}

export function defaultImagePolygon(points: readonly IndoorPoint[]): UvPoint[] {
  const bounds = {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  };
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  return points.map((point) => ({
    u: clamp((point.x - bounds.minX) / width, 0, 1),
    v: clamp((point.y - bounds.minY) / height, 0, 1)
  }));
}

export const DEFAULT_WALL_TRANSFORM: Readonly<WallImageTransform> = { offsetU: 0, offsetV: 0, scaleU: 1, scaleV: 1, rotationDeg: 0 };

export function parseFootprint(value: string): IndoorPoint[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const points = parsed.filter((point): point is { x: number; y: number } => Boolean(point) && typeof point === "object" && typeof (point as { x?: unknown }).x === "number" && typeof (point as { y?: unknown }).y === "number");
    return points.length === parsed.length ? points : null;
  } catch { return null; }
}

export function parseUvPolygon(value: string): UvPoint[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 3) return null;
    const points = parsed.filter((point): point is UvPoint => Boolean(point) &&
      typeof point === "object" &&
      typeof (point as { u?: unknown }).u === "number" &&
      Number.isFinite((point as { u: number }).u) &&
      typeof (point as { v?: unknown }).v === "number" &&
      Number.isFinite((point as { v: number }).v) &&
      (point as { u: number }).u >= 0 && (point as { u: number }).u <= 1 &&
      (point as { v: number }).v >= 0 && (point as { v: number }).v <= 1);
    return points.length === parsed.length ? points : null;
  } catch { return null; }
}
