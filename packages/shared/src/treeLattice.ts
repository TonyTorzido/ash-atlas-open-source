/**
 * Giving Tree planting lattice: a world-anchored triangular (hex-packed) grid whose neighbour distance
 * is SAPLING_MIN_SPACING_M, the densest legal tree packing. Client (planner overlay, snapped planting)
 * and server (re-snap and range check) share this one definition so everyone's forests line up.
 * docs/giving-trees.md.
 *
 * Anchoring: rows of constant latitude at multiples of ROW_SPACING_M (90 * sqrt(3) / 2), points every
 * SAPLING_MIN_SPACING_M along a row, odd rows shifted half a step. The longitude step is NOT taken from
 * each row's own cos(latitude): adjacent rows would then differ in step by a few parts per million and,
 * counted from longitude 0, drift apart by kilometres at the Americas or Asia, ruining the packing.
 * Rows are grouped into bands of TREE_LATTICE_BAND_ROWS and every row of a band shares the band's
 * centre-latitude step, so the lattice is exactly regular inside a band (neighbours 90 m apart to
 * within centimetres) and only the one row boundary between bands (every ~13 km north-south) is a seam.
 */

import { distanceMeters } from "./geo.js";
import { SAPLING_MIN_SPACING_M } from "./givingSaplings.js";
import type { LatLon } from "./types.js";

/** Same radius as distanceMeters, so lattice distances agree with the shared metric. */
const EARTH_RADIUS_M = 6_371_008.8;
const METERS_PER_DEGREE_LAT = EARTH_RADIUS_M * Math.PI / 180;

export const TREE_LATTICE_SPACING_M = SAPLING_MIN_SPACING_M;
export const TREE_LATTICE_ROW_SPACING_M = TREE_LATTICE_SPACING_M * Math.sqrt(3) / 2;
/** Farthest any point is from its nearest lattice point inside a band: the triangle circumradius. */
export const TREE_LATTICE_MAX_SNAP_M = TREE_LATTICE_SPACING_M / Math.sqrt(3);
export const TREE_LATTICE_BAND_ROWS = 170;

const ROW_STEP_DEG = TREE_LATTICE_ROW_SPACING_M / METERS_PER_DEGREE_LAT;

export type TreeLatticePoint = Readonly<{ row: number; col: number; lat: number; lon: number }>;

export function treeLatticeRowLat(row: number): number {
  return row * ROW_STEP_DEG;
}

function bandStepDeg(row: number): number {
  const centreRow = Math.floor(row / TREE_LATTICE_BAND_ROWS) * TREE_LATTICE_BAND_ROWS + TREE_LATTICE_BAND_ROWS / 2;
  const cos = Math.max(0.01, Math.cos(treeLatticeRowLat(centreRow) * Math.PI / 180));
  return TREE_LATTICE_SPACING_M / (METERS_PER_DEGREE_LAT * cos);
}

function rowOffset(row: number): number {
  return Math.abs(row % 2) === 1 ? 0.5 : 0;
}

export function treeLatticePoint(row: number, col: number): TreeLatticePoint {
  return { row, col, lat: treeLatticeRowLat(row), lon: (col + rowOffset(row)) * bandStepDeg(row) };
}

export function treeLatticeKey(point: Readonly<{ row: number; col: number }>): string {
  return `${point.row}:${point.col}`;
}

/** The lattice point nearest to `position` (deterministic: ties go to the lower row, then column). */
export function nearestTreeLatticePoint(position: LatLon): TreeLatticePoint {
  const centreRow = Math.round(position.lat / ROW_STEP_DEG);
  let best: TreeLatticePoint | null = null;
  let bestDistance = Infinity;
  for (let row = centreRow - 1; row <= centreRow + 1; row += 1) {
    const step = bandStepDeg(row);
    const baseCol = Math.round(position.lon / step - rowOffset(row));
    for (let col = baseCol - 1; col <= baseCol + 1; col += 1) {
      const candidate = treeLatticePoint(row, col);
      const distance = distanceMeters(position, candidate);
      if (distance < bestDistance - 1e-9) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best!;
}

/**
 * Lattice points within `radiusM` of `center` (a square window, cheap and bounded: about
 * (2r)^2 / 779 points). Rows run south to north, columns west to east.
 */
export function treeLatticePointsAround(center: LatLon, radiusM: number): TreeLatticePoint[] {
  const radius = Math.min(Math.max(radiusM, 0), 1_000);
  const latSpan = radius / METERS_PER_DEGREE_LAT;
  const minRow = Math.ceil((center.lat - latSpan) / ROW_STEP_DEG);
  const maxRow = Math.floor((center.lat + latSpan) / ROW_STEP_DEG);
  const points: TreeLatticePoint[] = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    const step = bandStepDeg(row);
    const lonSpan = radius / (METERS_PER_DEGREE_LAT * Math.max(0.01, Math.cos(treeLatticeRowLat(row) * Math.PI / 180)));
    const minCol = Math.ceil((center.lon - lonSpan) / step - rowOffset(row));
    const maxCol = Math.floor((center.lon + lonSpan) / step - rowOffset(row));
    for (let col = minCol; col <= maxCol; col += 1) {
      const point = treeLatticePoint(row, col);
      if (Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180) points.push(point);
    }
  }
  return points;
}
