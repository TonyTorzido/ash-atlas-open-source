import polygonClipping, { type Polygon, type Ring } from "polygon-clipping";

export type Point2D = [number, number];

export type TerritoryClaimShape = {
  id: string;
  ownerId: string;
  ownerColor?: string;
  center: Point2D;
  radius: number;
  ring: Ring;
};

export type TerritoryRenderGroup = {
  ownerId: string;
  ownerColor: string;
  polygons: Polygon[];
  zoneCells: Polygon[];
};

export type PathCommand =
  | {
      type: "moveTo" | "lineTo";
      point: Point2D;
    }
  | {
      type: "closePath";
    };

export const FALLBACK_TERRITORY_COLOR = "#d83a3a";
export const TERRITORY_CIRCLE_SEGMENTS = 192;

const HALF_PLANE_EPSILON = 1e-7;
// Clipping each claim independently can produce numerically distinct copies
// of the same Voronoi/bisector junction. Five hundredths of a screen pixel
// is below the renderer's antialiasing footprint while remaining well below
// the smallest distinct circle-edge segment at gameplay zooms. Canonicalize
// within that bound so incident edges meet without moving real boundaries.
const TERRITORY_JUNCTION_EPSILON = 0.05;

export function mergeOwnerTerritoriesWithBoundaries(
  claims: TerritoryClaimShape[]
): TerritoryRenderGroup[] {
  const groups = new Map<
    string,
    { ownerColor: string; polygons: Polygon[]; claims: TerritoryClaimShape[] }
  >();
  for (const claim of claims) {
    const clippedRing = clipClaimRingAgainstOpponents(claim, claims);
    if (!isValidClosedRing(clippedRing)) {
      continue;
    }
    const group = groups.get(claim.ownerId) ?? {
      ownerColor: ownerColorForClaim(claim),
      polygons: [],
      claims: []
    };
    group.ownerColor = ownerColorForClaim(claim);
    group.polygons.push([clippedRing]);
    group.claims.push(claim);
    groups.set(claim.ownerId, group);
  }

  const renderedGroups = [...groups.entries()].map(([ownerId, group]) => {
    const [firstPolygon, ...restPolygons] = group.polygons;
    return {
      ownerId,
      ownerColor: group.ownerColor,
      zoneCells:
        group.claims.length > 1
          ? group.claims
              .map((claim) => clipClaimRingAgainstOverlaps(claim, claims, true))
              .filter(isValidClosedRing)
              .map((ring) => [ring])
          : [],
      polygons:
        firstPolygon && restPolygons.length > 0
          ? (polygonClipping.union(firstPolygon, ...restPolygons) as Polygon[])
          : firstPolygon
            ? [firstPolygon]
            : []
    };
  });
  return canonicalizeTerritoryJunctions(renderedGroups);
}

function canonicalizeTerritoryJunctions(
  groups: readonly TerritoryRenderGroup[]
): TerritoryRenderGroup[] {
  const buckets = new Map<string, Point2D[]>();
  const bucketFor = (value: number): number => Math.floor(value / TERRITORY_JUNCTION_EPSILON);
  const bucketKey = (x: number, y: number): string => `${x}:${y}`;
  const pointFor = (point: Point2D): Point2D => {
    const bucketX = bucketFor(point[0]);
    const bucketY = bucketFor(point[1]);
    for (let x = bucketX - 1; x <= bucketX + 1; x += 1) {
      for (let y = bucketY - 1; y <= bucketY + 1; y += 1) {
        const candidates = buckets.get(bucketKey(x, y));
        const existing = candidates?.find((candidate) =>
          Math.hypot(candidate[0] - point[0], candidate[1] - point[1]) <= TERRITORY_JUNCTION_EPSILON
        );
        if (existing) return existing;
      }
    }
    const next: Point2D = [point[0], point[1]];
    const key = bucketKey(bucketX, bucketY);
    const candidates = buckets.get(key) ?? [];
    candidates.push(next);
    buckets.set(key, candidates);
    return next;
  };
  const ringFor = (ring: Ring): Ring => ring.map(pointFor);
  const polygonFor = (polygon: Polygon): Polygon => polygon.map(ringFor);
  return groups.map((group) => ({
    ...group,
    polygons: group.polygons.map(polygonFor),
    zoneCells: group.zoneCells.map(polygonFor)
  }));
}

export function clipClaimRingAgainstOpponents(
  claim: TerritoryClaimShape,
  claims: TerritoryClaimShape[]
): Ring {
  return clipClaimRingAgainstOverlaps(claim, claims, false);
}

function clipClaimRingAgainstOverlaps(
  claim: TerritoryClaimShape,
  claims: TerritoryClaimShape[],
  includeSameOwner: boolean
): Ring {
  let clipped = openRing(claim.ring);
  for (const opponent of claims) {
    if (opponent.id === claim.id || (!includeSameOwner && opponent.ownerId === claim.ownerId)) {
      continue;
    }
    if (!claimShapesOverlap(claim, opponent)) {
      continue;
    }
    const direction = {
      x: opponent.center[0] - claim.center[0],
      y: opponent.center[1] - claim.center[1]
    };
    if (direction.x === 0 && direction.y === 0) {
      continue;
    }
    const midpoint = {
      x: (claim.center[0] + opponent.center[0]) / 2,
      y: (claim.center[1] + opponent.center[1]) / 2
    };
    clipped = clipOpenRingToHalfPlane(clipped, (point) => {
      const side =
        (point[0] - midpoint.x) * direction.x + (point[1] - midpoint.y) * direction.y;
      return side <= HALF_PLANE_EPSILON;
    }, midpoint, direction);
    if (clipped.length < 3) {
      return [];
    }
  }
  return closeRing(removeNearDuplicatePoints(clipped));
}

export function createCircleRing(
  center: Point2D,
  radius: number,
  segments = TERRITORY_CIRCLE_SEGMENTS
): Ring {
  const ring = Array.from({ length: segments }, (_, index): Point2D => {
    const theta = (index / segments) * Math.PI * 2;
    return [center[0] + Math.cos(theta) * radius, center[1] + Math.sin(theta) * radius];
  });
  return closeRing(ring);
}

export function polygonToPathCommands(polygon: Polygon): PathCommand[] {
  const commands: PathCommand[] = [];
  for (const ring of polygon) {
    if (!isValidClosedRing(ring)) {
      continue;
    }
    const [first, ...rest] = ring;
    if (!first) {
      continue;
    }
    commands.push({ type: "moveTo", point: first });
    for (const point of rest.slice(0, -1)) {
      commands.push({ type: "lineTo", point });
    }
    commands.push({ type: "closePath" });
  }
  return commands;
}

export function ownerColorForClaim(claim: Pick<TerritoryClaimShape, "ownerColor">): string {
  return isHexColor(claim.ownerColor) ? claim.ownerColor.toLowerCase() : FALLBACK_TERRITORY_COLOR;
}

export function claimShapesOverlap(left: TerritoryClaimShape, right: TerritoryClaimShape): boolean {
  return distance(left.center, right.center) < left.radius + right.radius;
}

export function isValidClosedRing(ring: Ring): boolean {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return Boolean(
    ring.length >= 4 &&
      first &&
      last &&
      Math.abs(first[0] - last[0]) <= HALF_PLANE_EPSILON &&
      Math.abs(first[1] - last[1]) <= HALF_PLANE_EPSILON
  );
}

function clipOpenRingToHalfPlane(
  points: Ring,
  keep: (point: Point2D) => boolean,
  midpoint: { x: number; y: number },
  direction: { x: number; y: number }
): Ring {
  const output: Ring = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[(index + points.length - 1) % points.length];
    if (!current || !previous) {
      continue;
    }
    const currentInside = keep(current);
    const previousInside = keep(previous);
    if (currentInside !== previousInside) {
      output.push(intersectionWithBisector(previous, current, midpoint, direction));
    }
    if (currentInside) {
      output.push(current);
    }
  }
  return output;
}

function intersectionWithBisector(
  start: Point2D,
  end: Point2D,
  midpoint: { x: number; y: number },
  direction: { x: number; y: number }
): Point2D {
  const startSide = (start[0] - midpoint.x) * direction.x + (start[1] - midpoint.y) * direction.y;
  const endSide = (end[0] - midpoint.x) * direction.x + (end[1] - midpoint.y) * direction.y;
  const denominator = startSide - endSide;
  if (Math.abs(denominator) < HALF_PLANE_EPSILON) {
    return start;
  }
  const t = startSide / denominator;
  return [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
}

function openRing(ring: Ring): Ring {
  if (ring.length < 2) {
    return [...ring];
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) {
    return ring.slice(0, -1);
  }
  return [...ring];
}

function closeRing(ring: Ring): Ring {
  const cleaned = removeNearDuplicatePoints(ring);
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (!first) {
    return [];
  }
  if (
    last &&
    Math.abs(first[0] - last[0]) <= HALF_PLANE_EPSILON &&
    Math.abs(first[1] - last[1]) <= HALF_PLANE_EPSILON
  ) {
    return cleaned;
  }
  return [...cleaned, first];
}

function removeNearDuplicatePoints(ring: Ring): Ring {
  const output: Ring = [];
  for (const point of ring) {
    const previous = output[output.length - 1];
    if (
      previous &&
      Math.abs(previous[0] - point[0]) <= HALF_PLANE_EPSILON &&
      Math.abs(previous[1] - point[1]) <= HALF_PLANE_EPSILON
    ) {
      continue;
    }
    output.push(point);
  }
  return output;
}

function distance(left: Point2D, right: Point2D): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1]);
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}
