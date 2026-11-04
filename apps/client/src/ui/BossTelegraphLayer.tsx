import {
  combatPositionToDungeonLocal,
  dungeonCombatMetersToLocalDistance,
  type BossCastSnapshot
} from "@ash-atlas/shared";
import { telegraphActive } from "../map/telegraphWindow";

type Props = Readonly<{
  telegraphs: readonly BossCastSnapshot[];
  roomWidth: number;
  roomHeight: number;
  serverNow?: number;
}>;

type Point = Readonly<{ x: number; y: number }>;

function pointAt(origin: Point, distanceM: number, bearingDegrees: number): Point {
  const distance = dungeonCombatMetersToLocalDistance(distanceM);
  const bearing = bearingDegrees * Math.PI / 180;
  return {
    x: origin.x + Math.sin(bearing) * distance,
    y: origin.y - Math.cos(bearing) * distance
  };
}

function pointsForCast(cast: BossCastSnapshot): readonly Point[] {
  const geometry = cast.geometry;
  if (geometry.kind === "circle") {
    const center = combatPositionToDungeonLocal(geometry.center);
    const radius = dungeonCombatMetersToLocalDistance(geometry.radiusM);
    return [{ x: center.x, y: center.y }, { x: center.x + radius, y: center.y }];
  }
  const origin = combatPositionToDungeonLocal(geometry.origin);
  if (geometry.kind === "cone") {
    const points = [origin];
    const start = geometry.facingDegrees - geometry.angleDegrees / 2;
    const steps = 18;
    for (let index = 0; index <= steps; index += 1) {
      points.push(pointAt(origin, geometry.rangeM, start + geometry.angleDegrees * index / steps));
    }
    return points;
  }
  const halfWidth = geometry.widthM / 2;
  const left = pointAt(origin, halfWidth, geometry.facingDegrees - 90);
  const right = pointAt(origin, halfWidth, geometry.facingDegrees + 90);
  const frontLeft = pointAt(left, geometry.lengthM, geometry.facingDegrees);
  const frontRight = pointAt(right, geometry.lengthM, geometry.facingDegrees);
  return [left, right, frontRight, frontLeft];
}

function pathFor(points: readonly Point[], closed = true): string {
  const first = points[0];
  if (!first) return "";
  return `${points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ")}${closed ? " Z" : ""}`;
}

export function BossTelegraphLayer({
  telegraphs,
  roomWidth,
  roomHeight,
  serverNow = Date.now()
}: Props): React.JSX.Element | null {
  const active = telegraphs
    // Mob casts anchor on the local clock; boss casts keep comparing against serverNow.
    .filter((cast) => telegraphActive(cast, cast.remainingMs === undefined ? serverNow : Date.now()))
    .slice(0, 64);
  if (active.length === 0) return null;
  return <svg
    className="boss-telegraph-layer"
    aria-label="Boss attack telegraphs"
    role="img"
    viewBox={`0 0 ${roomWidth} ${roomHeight}`}
    preserveAspectRatio="none"
  >
    {active.map((cast) => {
      const points = pointsForCast(cast);
      const geometry = cast.geometry;
      if (geometry.kind === "circle") {
        const center = points[0];
        const edge = points[1];
        if (!center || !edge) return null;
        return <circle
          key={cast.castInstanceId}
          className="boss-telegraph boss-telegraph-circle"
          data-telegraph-kind="circle"
          data-ability-id={cast.abilityId}
          data-cast-instance-id={cast.castInstanceId}
          cx={center.x}
          cy={center.y}
          r={Math.hypot(edge.x - center.x, edge.y - center.y)}
        />;
      }
      return <path
        key={cast.castInstanceId}
        className={`boss-telegraph boss-telegraph-${geometry.kind}`}
        data-telegraph-kind={geometry.kind}
        data-ability-id={cast.abilityId}
        data-cast-instance-id={cast.castInstanceId}
        d={pathFor(points)}
      />;
    })}
  </svg>;
}
