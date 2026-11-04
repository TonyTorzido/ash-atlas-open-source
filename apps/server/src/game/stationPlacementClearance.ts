import { destinationPoint, distanceMeters, type LatLon } from "@ash-atlas/shared";
import type pg from "pg";

export const OUTDOOR_STATION_CLEARANCE_M = 30;
const SUGGESTION_MARGIN_M = 0.5;

type StationPoint = LatLon & { source: string };

export interface OutdoorStationPlacementConstraints {
  manorCenter: LatLon;
  maxManorDistanceM: number;
  movementAnchor: LatLon;
  moveLeashRadiusM: number;
}

export async function requireOutdoorStationClearance(
  client: pg.PoolClient,
  worldId: string,
  regionCode: string,
  requested: LatLon,
  constraints: OutdoorStationPlacementConstraints
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `outdoor-station-clearance:${worldId}:${regionCode}`
  ]);
  const result = await client.query<StationPoint>(
    `SELECT lat,lon,'furnace' AS source FROM player_furnaces
       WHERE removed_at IS NULL AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon,'tannery' FROM player_tanneries
       WHERE removed_at IS NULL AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon,'kitchen' FROM player_kitchens
       WHERE removed_at IS NULL AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon,'fishing-hut' FROM player_fishing_huts
       WHERE removed_at IS NULL AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon,'furnace-build' FROM furnace_build_jobs
       WHERE status='constructing' AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon,'tannery-build' FROM tannery_build_jobs
       WHERE status='constructing' AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon,'kitchen-build' FROM kitchen_build_jobs
       WHERE status='constructing' AND world_id=$1 AND region_code=$2
     UNION ALL SELECT lat,lon,'fishing-hut-build' FROM fishing_hut_build_jobs
       WHERE status='constructing' AND world_id=$1 AND region_code=$2`,
    [worldId, regionCode]
  );
  const evaluation = evaluateOutdoorStationClearance(requested, result.rows, constraints);
  if (evaluation.allowed) return;
  throw new OutdoorStationClearanceError(evaluation.suggestedPosition);
}

export class OutdoorStationClearanceError extends Error {
  readonly code = "OUTDOOR_STATION_CLEARANCE_REQUIRED";
  constructor(readonly suggestedPosition?: LatLon) {
    super("Outdoor stations must be at least 30 meters apart.");
    this.name = "OutdoorStationClearanceError";
  }
}

export function evaluateOutdoorStationClearance(
  requested: LatLon,
  rawPoints: readonly LatLon[],
  constraints?: OutdoorStationPlacementConstraints
): { allowed: true } | { allowed: false; suggestedPosition?: LatLon } {
  const points = rawPoints.map((point) => ({ lat: Number(point.lat), lon: Number(point.lon) }));
  if (!points.some((point) => distanceMeters(point, requested) < OUTDOOR_STATION_CLEARANCE_M)) {
    return { allowed: true };
  }
  let best: { point: LatLon; distanceM: number } | null = null;
  for (const center of points) {
    for (let radiusM = OUTDOOR_STATION_CLEARANCE_M + SUGGESTION_MARGIN_M; radiusM <= 180; radiusM += 3) {
      for (let bearing = 0; bearing < 360; bearing += 2) {
        const point = destinationPoint(center, radiusM, bearing);
        if (points.some((existing) => distanceMeters(existing, point) < OUTDOOR_STATION_CLEARANCE_M)) continue;
        if (constraints && (
          distanceMeters(constraints.manorCenter, point) > constraints.maxManorDistanceM ||
          distanceMeters(constraints.movementAnchor, point) > constraints.moveLeashRadiusM
        )) continue;
        const distance = distanceMeters(requested, point);
        if (!best || distance < best.distanceM) best = { point, distanceM: distance };
      }
    }
  }
  return best
    ? { allowed: false, suggestedPosition: best.point }
    : { allowed: false };
}
