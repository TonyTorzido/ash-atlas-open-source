import { distanceMeters, isFiniteLatLon } from "./geo.js";
import type { BossAppearanceId } from "./bossAppearance.js";
import type { MobArchetypeKey } from "./mobContracts.js";
import type { LatLon } from "./types.js";
export {
  BOSS_HOST_KINDS,
  BOSS_LIFECYCLE_STATES
} from "./bossContracts.js";
export type {
  BossCastSnapshot,
  BossCircleGeometry,
  BossConeGeometry,
  BossEncounterProjection,
  BossEntityOwnership,
  BossHostKind,
  BossLifecycleState,
  BossLineGeometry,
  BossPoint,
  BossTelegraphGeometry
} from "./bossContracts.js";
import type {
  BossCastSnapshot,
  BossPoint,
  BossTelegraphGeometry
} from "./bossContracts.js";

export type BossRewardPolicy = Readonly<{
  id: string;
  fixedXp?: number;
  fixedGold?: number;
  commonDropTableId?: string;
  guaranteedDropId?: string;
  rareDrop?: Readonly<{ itemId: string; chance: number }>;
  minimumContribution?: number;
}>;

/** Stable definition data shared by all hosts; combat stats stay in mob data. */
export type BossDefinition = Readonly<{
  id: string;
  revision: number;
  archetypeKey: MobArchetypeKey;
  appearanceId?: BossAppearanceId | string;
  controllerId: string;
  rewardPolicy: BossRewardPolicy;
  displayName?: string;
  level?: number;
}>;

/**
 * Server and client both use this function for telegraph presentation and hit
 * resolution.  It intentionally uses the same short-distance approximation
 * already used by gameplay geometry, while distance itself remains WGS84.
 */
export function isPointInsideBossGeometry(
  point: BossPoint,
  geometry: BossTelegraphGeometry,
  edgeInclusive = true
): boolean {
  switch (geometry.kind) {
    case "circle":
      return edgeInclusive
        ? distanceMeters(point, geometry.center) <= geometry.radiusM
        : distanceMeters(point, geometry.center) < geometry.radiusM;
    case "cone": {
      const distance = distanceMeters(point, geometry.origin);
      if (distance > geometry.rangeM || (!edgeInclusive && distance === geometry.rangeM)) {
        return false;
      }
      if (distance === 0) return true;
      const bearing = bearingDegrees(geometry.origin, point);
      const delta = angularDistanceDegrees(bearing, geometry.facingDegrees);
      return edgeInclusive
        ? delta <= geometry.angleDegrees / 2
        : delta < geometry.angleDegrees / 2;
    }
    case "line": {
      const distance = distanceMeters(point, geometry.origin);
      if (distance === 0) return true;
      const bearingDelta = angularDistanceDegrees(
        bearingDegrees(geometry.origin, point),
        geometry.facingDegrees
      );
      const along = distance * Math.cos(toRadians(bearingDelta));
      const across = Math.abs(distance * Math.sin(toRadians(bearingDelta)));
      const halfWidth = geometry.widthM / 2;
      const alongOk = edgeInclusive
        ? along >= 0 && along <= geometry.lengthM
        : along > 0 && along < geometry.lengthM;
      const acrossOk = edgeInclusive ? across <= halfWidth : across < halfWidth;
      return alongOk && acrossOk;
    }
  }
}

export function validateBossGeometry(geometry: BossTelegraphGeometry): BossTelegraphGeometry {
  const coordinate = geometry.kind === "circle" ? geometry.center : geometry.origin;
  if (!isFiniteLatLon(coordinate.lat, coordinate.lon)) {
    throw new TypeError("Boss telegraph origin must be a finite WGS84 coordinate");
  }
  if (geometry.kind === "circle" && (!Number.isFinite(geometry.radiusM) || geometry.radiusM <= 0)) {
    throw new TypeError("Boss circle radius must be positive and finite");
  }
  if (geometry.kind === "cone" && (
    !Number.isFinite(geometry.facingDegrees) ||
    !Number.isFinite(geometry.rangeM) || geometry.rangeM <= 0 ||
    !Number.isFinite(geometry.angleDegrees) || geometry.angleDegrees <= 0 || geometry.angleDegrees > 360
  )) {
    throw new TypeError("Boss cone geometry is invalid");
  }
  if (geometry.kind === "line" && (
    !Number.isFinite(geometry.facingDegrees) ||
    !Number.isFinite(geometry.lengthM) || geometry.lengthM <= 0 ||
    !Number.isFinite(geometry.widthM) || geometry.widthM <= 0
  )) {
    throw new TypeError("Boss line geometry is invalid");
  }
  return geometry;
}

export function bossCastRemainingMs(
  cast: Pick<BossCastSnapshot, "resolveTime">,
  now = Date.now()
): number {
  return Math.max(0, cast.resolveTime - now);
}

export function normalizeBearingDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function angularDistanceDegrees(left: number, right: number): number {
  const delta = Math.abs(normalizeBearingDegrees(left) - normalizeBearingDegrees(right));
  return Math.min(delta, 360 - delta);
}

export function bearingDegrees(from: LatLon, to: LatLon): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const deltaLon = toRadians(to.lon - from.lon);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return normalizeBearingDegrees(toDegrees(Math.atan2(y, x)));
}

function toRadians(value: number): number {
  return value * Math.PI / 180;
}

function toDegrees(value: number): number {
  return value * 180 / Math.PI;
}
