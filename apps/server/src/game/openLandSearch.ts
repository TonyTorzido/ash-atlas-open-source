import { destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";
import type pg from "pg";

import { MAX_FLAG_CLAIM_RADIUS_M } from "../config.js";

/** The flag-placement legality check (FlagService.findOpenLandCandidates). */
export type OpenLandValidator = Readonly<{
  findOpenLandCandidates(
    playerId: string,
    candidates: readonly Readonly<{ lat: number; lon: number }>[]
  ): Promise<Array<{ lat: number; lon: number; packageId: string }>>;
}>;

/** Fallback search radius for the nearest legal open spot. */
export const OPEN_LAND_SEARCH_MAX_M = 3_000;
/** Find Open Land prefers fresh land at least this far from every territory edge. */
export const OPEN_LAND_PREFERRED_CLEARANCE_M = 5_000;
/** How far out the coarse grid looks for fresh land. */
export const OPEN_LAND_FRESH_SEARCH_MAX_M = 20_000;
const FRESH_RING_STEP_M = 1_000;
const FRESH_ARC_SPACING_M = 1_500;
const FRESH_VALIDATE_BATCH = 12;
const FRESH_VALIDATE_MAX = 48;
const FALLBACK_RADIAL_STEP_M = 300;
const FALLBACK_ARC_SPACING_M = 300;

export type OpenLandResult = LatLon & { distanceM: number; fresh: boolean; searchMs: number };

export function openLandCandidateRing(origin: LatLon, radiusM: number, arcSpacingM = FALLBACK_ARC_SPACING_M): LatLon[] {
  if (radiusM <= 0) return [{ lat: origin.lat, lon: origin.lon }];
  const count = Math.max(8, Math.ceil((2 * Math.PI * radiusM) / arcSpacingM));
  return Array.from({ length: count }, (_unused, index) => destinationPoint(origin, radiusM, (index * 360) / count));
}

/** Nearest legal open spot within `maxRadiusM`, ring by ring (coarse, capped). */
export async function findNearestOpenLand(
  validator: OpenLandValidator,
  playerId: string,
  origin: LatLon,
  maxRadiusM = OPEN_LAND_SEARCH_MAX_M
): Promise<(LatLon & { distanceM: number }) | null> {
  for (let radiusM = 0; radiusM <= maxRadiusM; radiusM += FALLBACK_RADIAL_STEP_M) {
    const valid = await validator.findOpenLandCandidates(playerId, openLandCandidateRing(origin, radiusM));
    if (valid.length) {
      return valid
        .map((candidate) => ({ lat: candidate.lat, lon: candidate.lon, distanceM: distanceMeters(origin, candidate) }))
        .sort((left, right) => left.distanceM - right.distanceM || left.lat - right.lat || left.lon - right.lon)[0]!;
    }
  }
  return null;
}

/**
 * Find Open Land: one SQL pass over a coarse grid (1 km rings to 20 km) keeps the points at least
 * 5 km from every territory edge; the nearest few are then checked with the flag-placement rules
 * (land, not water, etc.). If none qualifies it falls back to the nearest legal open spot within 3 km.
 */
export async function findOpenLandForTravel(
  pool: Pick<pg.Pool, "query">,
  validator: OpenLandValidator,
  playerId: string,
  origin: LatLon
): Promise<OpenLandResult | null> {
  const startedAt = Date.now();
  const grid: LatLon[] = [];
  for (let radiusM = FRESH_RING_STEP_M; radiusM <= OPEN_LAND_FRESH_SEARCH_MAX_M; radiusM += FRESH_RING_STEP_M) {
    grid.push(...openLandCandidateRing(origin, radiusM, FRESH_ARC_SPACING_M));
  }
  const clear = await pool.query<{ idx: string }>(
    `WITH candidate AS (
       SELECT idx, ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography AS geog
       FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS t(lat, lon, idx)
     )
     SELECT candidate.idx::text AS idx FROM candidate
     WHERE NOT EXISTS (
       SELECT 1 FROM flags f
       WHERE ST_DWithin(f.geom::geography, candidate.geog, $3)
         AND ST_Distance(f.geom::geography, candidate.geog) - f.claim_radius_m < $4
     )
     AND NOT EXISTS (
       SELECT 1 FROM kingdom_seats seat
       WHERE seat.status = 'active'
         AND ST_Distance(ST_SetSRID(ST_MakePoint(seat.lon, seat.lat), 4326)::geography, candidate.geog)
             - seat.territory_radius_m < $4
     )`,
    [grid.map((point) => point.lat), grid.map((point) => point.lon),
      OPEN_LAND_PREFERRED_CLEARANCE_M + MAX_FLAG_CLAIM_RADIUS_M, OPEN_LAND_PREFERRED_CLEARANCE_M]
  );
  const clearPoints = clear.rows
    .map((row) => grid[Number(row.idx) - 1]!)
    .map((point) => ({ ...point, distanceM: distanceMeters(origin, point) }))
    .sort((left, right) => left.distanceM - right.distanceM)
    .slice(0, FRESH_VALIDATE_MAX);
  for (let index = 0; index < clearPoints.length; index += FRESH_VALIDATE_BATCH) {
    const batch = clearPoints.slice(index, index + FRESH_VALIDATE_BATCH);
    const valid = await validator.findOpenLandCandidates(playerId, batch);
    if (valid.length) {
      const best = valid
        .map((candidate) => ({ lat: candidate.lat, lon: candidate.lon, distanceM: distanceMeters(origin, candidate) }))
        .sort((left, right) => left.distanceM - right.distanceM)[0]!;
      return { ...best, fresh: true, searchMs: Date.now() - startedAt };
    }
  }
  const nearest = await findNearestOpenLand(validator, playerId, origin);
  return nearest ? { ...nearest, fresh: false, searchMs: Date.now() - startedAt } : null;
}
