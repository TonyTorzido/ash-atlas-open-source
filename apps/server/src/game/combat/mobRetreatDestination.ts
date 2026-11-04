import { createHash } from "node:crypto";

import { destinationPoint, type LatLon } from "@ash-atlas/shared";

const RETREAT_BEARING_ATTEMPTS = 16;
const RETREAT_ROUTE_SAMPLE_M = 50;

export type RetreatSurfaceSample = Readonly<{
  ok: boolean;
  isLand: boolean | null;
  isSaltwater: boolean | null;
  surfaceKind?: "land" | "water" | null;
}>;

export async function findValidOceanRetreatDestination(input: Readonly<{
  entityId: string;
  anchor: LatLon;
  distanceM: number;
  retreatIndex: 1 | 2;
  lookup(points: readonly LatLon[]): Promise<readonly RetreatSurfaceSample[]>;
}>): Promise<LatLon | null> {
  const sampleCount = Math.max(1, Math.ceil(input.distanceM / RETREAT_ROUTE_SAMPLE_M));
  const initialBearing = deterministicBearing(`${input.entityId}:retreat:${input.retreatIndex}`);
  const routes = Array.from({ length: RETREAT_BEARING_ATTEMPTS }, (_, attempt) => {
    const bearing = (initialBearing + attempt * 360 / RETREAT_BEARING_ATTEMPTS) % 360;
    return Array.from({ length: sampleCount }, (_unused, index) =>
      destinationPoint(
        input.anchor,
        Math.min(input.distanceM, (index + 1) * input.distanceM / sampleCount),
        bearing
      )
    );
  });
  const points = routes.flat();
  const surfaces = await input.lookup(points);
  if (surfaces.length !== points.length) return null;
  for (let attempt = 0; attempt < routes.length; attempt += 1) {
    const start = attempt * sampleCount;
    const routeIsOcean = surfaces
      .slice(start, start + sampleCount)
      .every((surface) =>
        surface.ok && surface.surfaceKind === "water" &&
        surface.isLand === false && surface.isSaltwater === true
      );
    if (routeIsOcean) return routes[attempt]!.at(-1) ?? null;
  }
  return null;
}

export function deterministicBearing(entityId: string): number {
  return createHash("sha256").update(entityId).digest().readUInt32BE(0) / 0x1_0000_0000 * 360;
}
