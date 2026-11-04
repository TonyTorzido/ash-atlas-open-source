import { distanceMeters, longitudeDeltaDegrees, normalizeLongitude, type LatLon } from "@ash-atlas/shared";

/**
 * The water lookup grid (docs/plans/water-shore.md): surfaces are looked up and cached per 1e-4 degree
 * cell (~11 m), keyed by the snapped cell centre. A cell is all land or all water.
 */
export const SAMPLE_GRID_DEGREES = 1e-4;
/** Shore stop: an unrafted walker halts this far before the first water cell edge. */
export const SHORE_STOP_M = 0.3;

export function snapToSampleGrid(point: LatLon): LatLon {
  return {
    lat: Number((Math.round(point.lat / SAMPLE_GRID_DEGREES) * SAMPLE_GRID_DEGREES).toFixed(4)),
    lon: Number((Math.round(point.lon / SAMPLE_GRID_DEGREES) * SAMPLE_GRID_DEGREES).toFixed(4))
  };
}

export function cellKey(cell: LatLon): string {
  return `${cell.lat},${cell.lon}`;
}

/** One grid cell a straight move passes through, with the distance from the origin at which it is entered. */
export type PathCell = Readonly<{ point: LatLon; key: string; entryM: number }>;

/** Two boundary crossings closer than this (in path fraction) are one corner crossing. */
const CORNER_EPSILON = 1e-9;

/**
 * Every grid cell the straight move from `origin` to `target` touches, in order, with exact entry distances.
 * Movement interpolates linearly in lat/lon (`moveToward`), so the path is a straight line in grid units and
 * this walks it boundary by boundary (no sampling gaps: a corner clipped by a few centimetres is still found).
 * A crossing exactly through a cell corner also lists both side cells. `cells[0]` is the origin's own cell.
 * Stops early (complete: false) after `maxCells` cells.
 */
export function pathCells(
  origin: LatLon,
  target: LatLon,
  maxCells: number = Number.POSITIVE_INFINITY
): { cells: PathCell[]; complete: boolean } {
  const totalM = distanceMeters(origin, target);
  const u0 = origin.lat / SAMPLE_GRID_DEGREES;
  const v0 = origin.lon / SAMPLE_GRID_DEGREES;
  const du = (target.lat - origin.lat) / SAMPLE_GRID_DEGREES;
  const dv = longitudeDeltaDegrees(origin.lon, target.lon) / SAMPLE_GRID_DEGREES;
  const si = Math.sign(du);
  const sj = Math.sign(dv);
  let i = Math.round(u0);
  let j = Math.round(v0);
  const cells: PathCell[] = [];
  const seen = new Set<string>();
  const push = (ci: number, cj: number, t: number): void => {
    const point = {
      lat: Number((ci * SAMPLE_GRID_DEGREES).toFixed(4)),
      lon: Number(normalizeLongitude(cj * SAMPLE_GRID_DEGREES).toFixed(4))
    };
    const key = cellKey(point);
    if (seen.has(key)) return;
    seen.add(key);
    cells.push({ point, key, entryM: Math.max(0, Math.min(1, t)) * totalM });
  };
  const nextCrossing = (index: number, start: number, delta: number, sign: number): number =>
    sign === 0 ? Number.POSITIVE_INFINITY : (index + sign * 0.5 - start) / delta;
  push(i, j, 0);
  let tU = nextCrossing(i, u0, du, si);
  let tV = nextCrossing(j, v0, dv, sj);
  while (cells.length < maxCells) {
    const t = Math.min(tU, tV);
    if (!(t <= 1)) return { cells, complete: true };
    if (Math.abs(tU - tV) <= CORNER_EPSILON) {
      push(i + si, j, t);
      push(i, j + sj, t);
      i += si;
      j += sj;
      push(i, j, t);
      tU = nextCrossing(i, u0, du, si);
      tV = nextCrossing(j, v0, dv, sj);
    } else if (tU < tV) {
      i += si;
      push(i, j, tU);
      tU = nextCrossing(i, u0, du, si);
    } else {
      j += sj;
      push(i, j, tV);
      tV = nextCrossing(j, v0, dv, sj);
    }
  }
  return { cells, complete: false };
}
