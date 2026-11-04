import type { ResourceType } from "./collectibles.js";

/**
 * Water travel (docs/design/WATER_GAME_PLAN.md, phase A).
 *
 * Every water surface (ocean, lake, river) needs a raft unless the player is
 * already afloat (own buoy, standing on water). Afloat moves at a fraction of
 * land speed. The server computes speed breakpoints along a straight MOVE_TO
 * path once and sends them with MOVE_ACCEPTED, so client prediction and the
 * server tick use the same numbers.
 */
export const AFLOAT_SPEED_MULTIPLIER = 0.5;

export const RAFT_LAUNCH_COST: readonly Readonly<{ itemId: ResourceType; quantity: number }>[] =
  Object.freeze([
    Object.freeze({ itemId: "wood" as const, quantity: 3 }),
    Object.freeze({ itemId: "crude_oil" as const, quantity: 3 }),
    Object.freeze({ itemId: "leather" as const, quantity: 2 })
  ]);

/** A speed segment starts `startM` metres from the move origin and runs to the next one. */
export type MoveSpeedSegment = Readonly<{
  startM: number;
  multiplier: number;
}>;

export function speedMultiplierAtDistance(
  segments: readonly MoveSpeedSegment[] | null | undefined,
  distanceM: number
): number {
  if (!segments || segments.length === 0 || !Number.isFinite(distanceM)) return 1;
  let multiplier = 1;
  for (const segment of segments) {
    if (segment.startM > distanceM) break;
    multiplier = segment.multiplier;
  }
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
}

/**
 * Walking next to open water. An unrafted walker stops at the shore and slides along it (wall slide).
 * The server probes the real shore and sends this local wall with MOVE_ACCEPTED so the client can
 * predict the same slide: from `at`, water starts `gapM` metres away in direction `normalDeg`
 * (compass bearing, pointing from land into water).
 */
export type WaterShoreHint = Readonly<{
  at: { lat: number; lon: number };
  normalDeg: number;
  gapM: number;
}>;

/** Keep this far inside the wall so rounding never lands a sample on the water side. */
export const SHORE_WALL_MARGIN_M = 0.4;

const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Wall-slide clip of a walk target against a shore hint: the part of the move that heads into the
 * water is removed, the part along the shore is kept. Returns the clipped target and whether it clipped.
 */
export function clipWalkTargetToShore(
  target: { lat: number; lon: number },
  hint: WaterShoreHint
): { target: { lat: number; lon: number }; clipped: boolean } {
  const cosLat = Math.cos((hint.at.lat * Math.PI) / 180);
  const toLocal = (point: { lat: number; lon: number }): { x: number; y: number } => ({
    x: (point.lon - hint.at.lon) * cosLat * METERS_PER_DEGREE_LAT,
    y: (point.lat - hint.at.lat) * METERS_PER_DEGREE_LAT
  });
  const normal = {
    x: Math.sin((hint.normalDeg * Math.PI) / 180),
    y: Math.cos((hint.normalDeg * Math.PI) / 180)
  };
  const limit = Math.max(0, hint.gapM - SHORE_WALL_MARGIN_M);
  const local = toLocal(target);
  const depth = local.x * normal.x + local.y * normal.y;
  if (depth <= limit) return { target, clipped: false };
  const over = depth - limit;
  const clippedLocal = { x: local.x - normal.x * over, y: local.y - normal.y * over };
  return {
    clipped: true,
    target: {
      lat: hint.at.lat + clippedLocal.y / METERS_PER_DEGREE_LAT,
      lon: hint.at.lon + clippedLocal.x / (cosLat * METERS_PER_DEGREE_LAT)
    }
  };
}
