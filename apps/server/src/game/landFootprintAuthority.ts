import { classifyFlagPlacementTerrain, type LatLon } from "@ash-atlas/shared";

import { WORLD_RUNTIME_CONTRACT } from "../runtime/authorityIdentity.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";

const WEB_MERCATOR_RADIUS_M = 6_378_137;
const WEB_MERCATOR_HALF_WORLD_M = Math.PI * WEB_MERCATOR_RADIUS_M;

export type LandFootprintWater = "land" | "river" | "other-water";

export async function classifyLandFootprint(
  worldLookup: {
    lookupGameplayEnvironments(
      points: readonly LatLon[],
      options?: { caller?: "city" | "other" }
    ): Promise<WorldGameplayEnvironmentResult[]>;
  },
  center: LatLon,
  radiusM: number
): Promise<LandFootprintWater> {
  const probes = canonicalCellsIntersectingFootprint(center, radiusM);
  const environments = await worldLookup.lookupGameplayEnvironments(probes, {
    caller: "city"
  });
  let otherWater = false;
  for (const environment of environments) {
    if (!environment.ok) throw new Error("World footprint authority is unavailable");
    if (environment.waterKind === "river") return "river";
    if (classifyFlagPlacementTerrain(environment) === "water") otherWater = true;
  }
  return otherWater ? "other-water" : "land";
}

export function canonicalCellsIntersectingFootprint(
  center: LatLon,
  radiusM: number
): LatLon[] {
  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new Error("land footprint radius must be a nonnegative finite number");
  }
  const cellSizeM = WORLD_RUNTIME_CONTRACT.surfaceCellSizeM;
  const [centerX, centerY] = project(center);
  const projectedRadius = radiusM / Math.max(Math.cos(center.lat * Math.PI / 180), 1e-6);
  const columnMin = cellColumn(centerX - projectedRadius, cellSizeM);
  const columnMax = cellColumn(centerX + projectedRadius, cellSizeM);
  const rowMin = cellRow(centerY + projectedRadius, cellSizeM);
  const rowMax = cellRow(centerY - projectedRadius, cellSizeM);
  const probes: LatLon[] = [];
  for (let row = rowMin; row <= rowMax; row += 1) {
    for (let column = columnMin; column <= columnMax; column += 1) {
      const west = -WEB_MERCATOR_HALF_WORLD_M + column * cellSizeM;
      const east = west + cellSizeM;
      const north = WEB_MERCATOR_HALF_WORLD_M - row * cellSizeM;
      const south = north - cellSizeM;
      const nearestX = Math.max(west, Math.min(east, centerX));
      const nearestY = Math.max(south, Math.min(north, centerY));
      if (Math.hypot(nearestX - centerX, nearestY - centerY) > projectedRadius) continue;
      probes.push(unproject(
        west + cellSizeM / 2,
        south + cellSizeM / 2
      ));
    }
  }
  if (probes.length > 512) throw new Error("land footprint exceeds bounded World admission");
  return probes;
}

function project(point: LatLon): [number, number] {
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
  return [
    WEB_MERCATOR_RADIUS_M * point.lon * Math.PI / 180,
    WEB_MERCATOR_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360))
  ];
}

function unproject(x: number, y: number): LatLon {
  return {
    lon: x / WEB_MERCATOR_RADIUS_M * 180 / Math.PI,
    lat: (2 * Math.atan(Math.exp(y / WEB_MERCATOR_RADIUS_M)) - Math.PI / 2) * 180 / Math.PI
  };
}

function cellColumn(x: number, cellSizeM: number): number {
  return Math.floor((x + WEB_MERCATOR_HALF_WORLD_M) / cellSizeM);
}

function cellRow(y: number, cellSizeM: number): number {
  return Math.floor((WEB_MERCATOR_HALF_WORLD_M - y) / cellSizeM);
}
