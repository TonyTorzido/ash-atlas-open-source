export type IndoorPoint = Readonly<{ x: number; y: number }>;

export type IndoorNavigationRectangleCollider = Readonly<{
  id: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>;

export type IndoorNavigationPolygonCollider = Readonly<{
  id: string;
  kind: "polygon";
  points: readonly IndoorPoint[];
}>;

export type IndoorNavigationCollider =
  | IndoorNavigationRectangleCollider
  | IndoorNavigationPolygonCollider;

export type IndoorRoomNavigation = Readonly<{
  roomWidth: number;
  roomHeight: number;
  playerRadius: number;
  colliders: readonly IndoorNavigationCollider[];
  /**
   * Optional walkable polygons. Most legacy indoor callers use the room
   * bounds as their walkable area; authored Manor rooms provide floor
   * surfaces here so the floor polygon is the sole navigation surface.
   */
  walkableSurfaces?: readonly (readonly IndoorPoint[])[];
}>;

export type IndoorPosition = {
  x: number;
  y: number;
  targetX: number | null;
  targetY: number | null;
  moving: boolean;
  revision: number;
};

export const STANDARD_INDOOR_SPATIAL_PROFILE = Object.freeze({
  roomWidth: 1_000,
  roomHeight: 1_000,
  playerVisualHeightUnits: 70,
  playerRadius: 24,
  movementUnitsPerSecond: 260,
  maxTargetDistance: 1_500,
  spawn: Object.freeze({ x: 500, y: 790 }),
  door: Object.freeze({ x: 830, y: 830 }),
  doorInteractionRadius: 95
});

export type IndoorVectorAdvance = Readonly<{
  x: number;
  y: number;
  arrived: boolean;
}>;

export function isIndoorInteractionInRange(
  position: IndoorPoint,
  target: IndoorPoint,
  radius: number
): boolean {
  return Math.hypot(position.x - target.x, position.y - target.y) <= radius;
}

export function indoorInteractionApproachPoint(
  current: IndoorPoint,
  target: IndoorPoint,
  radius: number,
  inset: number
): IndoorPoint {
  const dx = current.x - target.x;
  const dy = current.y - target.y;
  const distance = Math.hypot(dx, dy);
  const approachRadius = radius - inset;
  if (distance === 0) return { x: target.x + approachRadius, y: target.y };
  return {
    x: target.x + dx / distance * approachRadius,
    y: target.y + dy / distance * approachRadius
  };
}

/** Advances along one vector without deciding the caller's tick or settle policy. */
export function advanceIndoorVector(
  from: IndoorPoint,
  target: IndoorPoint,
  maximumDistance: number
): IndoorVectorAdvance {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0 || distance <= maximumDistance) {
    return { x: target.x, y: target.y, arrived: true };
  }
  return {
    x: from.x + dx / distance * maximumDistance,
    y: from.y + dy / distance * maximumDistance,
    arrived: false
  };
}

export function isIndoorNavigationPointWalkable(
  room: IndoorRoomNavigation,
  point: IndoorPoint
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  // Authored floor surfaces describe the legal feet-anchor area. Unlike the
  // legacy rectangular fallback, they are not inset by the visual/collision
  // radius: the anchor may stand on the published floor boundary.
  const roomInset = room.walkableSurfaces && room.walkableSurfaces.length > 0
    ? 0
    : room.playerRadius;
  if (
    point.x < roomInset || point.x > room.roomWidth - roomInset ||
    point.y < roomInset || point.y > room.roomHeight - roomInset
  ) return false;
  if (
    room.walkableSurfaces &&
    room.walkableSurfaces.length > 0 &&
    !room.walkableSurfaces.some((surface) => pointInsideWalkableSurface(point, surface))
  ) return false;
  return room.colliders.every((collider) => isPolygonCollider(collider)
    ? pointClearOfPolygon(point, collider.points, room.playerRadius)
    : !pointInsideOpenRectangle(point, inflateCollider(collider, room.playerRadius)));
}

/**
 * Checks only authored floor containment for endpoint/error classification.
 * Collision polygons are intentionally not considered here; callers can
 * distinguish an outside-floor rejection from a blocked-but-on-floor target.
 */
export function isIndoorNavigationPointInsideWalkableSurface(
  room: IndoorRoomNavigation,
  point: IndoorPoint
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) ||
    !room.walkableSurfaces || room.walkableSurfaces.length === 0) {
    return false;
  }
  return room.walkableSurfaces.some((surface) => pointInsideWalkableSurface(point, surface));
}

export function isIndoorNavigationSegmentWalkable(
  room: IndoorRoomNavigation,
  start: IndoorPoint,
  target: IndoorPoint
): boolean {
  if (!isIndoorNavigationPointWalkable(room, start) || !isIndoorNavigationPointWalkable(room, target)) {
    return false;
  }
  if (
    room.walkableSurfaces &&
    room.walkableSurfaces.length > 0 &&
    !room.walkableSurfaces.some((surface) => segmentInsideWalkableSurface(start, target, surface))
  ) return false;
  return room.colliders.every((collider) => isPolygonCollider(collider)
    ? segmentClearOfPolygon(start, target, collider.points, room.playerRadius)
    : !segmentCrossesOpenRectangle(start, target, inflateCollider(collider, room.playerRadius)));
}

/** Returns logical-unit waypoints excluding the start and including the final target. */
export function findIndoorNavigationRoute(
  room: IndoorRoomNavigation,
  start: IndoorPoint,
  target: IndoorPoint
): IndoorPoint[] | null {
  if (!isIndoorNavigationPointWalkable(room, start) || !isIndoorNavigationPointWalkable(room, target)) {
    return null;
  }
  if (start.x === target.x && start.y === target.y) return [{ x: target.x, y: target.y }];
  if (isIndoorNavigationSegmentWalkable(room, start, target)) return [{ x: target.x, y: target.y }];

  const nodes: IndoorPoint[] = [{ x: start.x, y: start.y }, { x: target.x, y: target.y }];
  const seen = new Set(nodes.map(pointKey));
  for (const collider of room.colliders) {
    if (isPolygonCollider(collider)) {
      for (const corner of polygonClearanceVertices(collider.points, room.playerRadius)) {
        const key = pointKey(corner);
        if (seen.has(key) || !isIndoorNavigationPointWalkable(room, corner)) continue;
        seen.add(key);
        nodes.push(corner);
      }
      continue;
    }
    const inflated = inflateCollider(collider, room.playerRadius);
    for (const corner of [
      { x: inflated.minX, y: inflated.minY },
      { x: inflated.maxX, y: inflated.minY },
      { x: inflated.maxX, y: inflated.maxY },
      { x: inflated.minX, y: inflated.maxY }
    ]) {
      const key = pointKey(corner);
      if (seen.has(key) || !isIndoorNavigationPointWalkable(room, corner)) continue;
      seen.add(key);
      nodes.push(corner);
    }
  }

  const distances = nodes.map(() => Number.POSITIVE_INFINITY);
  const previous = nodes.map(() => -1);
  const visited = nodes.map(() => false);
  distances[0] = 0;
  for (let iteration = 0; iteration < nodes.length; iteration += 1) {
    let current = -1;
    for (let index = 0; index < nodes.length; index += 1) {
      if (visited[index]) continue;
      if (current === -1 || distances[index]! < distances[current]! - 1e-9) current = index;
    }
    if (current === -1 || !Number.isFinite(distances[current])) break;
    if (current === 1) break;
    visited[current] = true;
    for (let next = 1; next < nodes.length; next += 1) {
      if (next === current || visited[next] || !isIndoorNavigationSegmentWalkable(room, nodes[current]!, nodes[next]!)) {
        continue;
      }
      const candidate = distances[current]! + Math.hypot(
        nodes[next]!.x - nodes[current]!.x,
        nodes[next]!.y - nodes[current]!.y
      );
      if (candidate < distances[next]! - 1e-9) {
        distances[next] = candidate;
        previous[next] = current;
      }
    }
  }
  if (!Number.isFinite(distances[1])) return null;
  const route: IndoorPoint[] = [];
  for (let current = 1; current !== 0; current = previous[current]!) {
    if (current < 0) return null;
    route.push({ ...nodes[current]! });
  }
  return route.reverse();
}

type InflatedRectangle = Readonly<{ minX: number; maxX: number; minY: number; maxY: number }>;

function inflateCollider(collider: IndoorNavigationRectangleCollider, radius: number): InflatedRectangle {
  return {
    minX: collider.minX - radius,
    maxX: collider.maxX + radius,
    minY: collider.minY - radius,
    maxY: collider.maxY + radius
  };
}

function isPolygonCollider(
  collider: IndoorNavigationCollider
): collider is IndoorNavigationPolygonCollider {
  return "points" in collider;
}

function pointClearOfPolygon(
  point: IndoorPoint,
  polygon: readonly IndoorPoint[],
  clearance: number
): boolean {
  if (pointInPolygon(point, polygon)) return false;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index]!;
    const end = polygon[(index + 1) % polygon.length]!;
    if (pointSegmentDistance(point, start, end) < clearance - 1e-9) return false;
  }
  return true;
}

function pointInsideWalkableSurface(
  point: IndoorPoint,
  polygon: readonly IndoorPoint[]
): boolean {
  return pointInPolygon(point, polygon);
}

function segmentInsideWalkableSurface(
  start: IndoorPoint,
  target: IndoorPoint,
  polygon: readonly IndoorPoint[]
): boolean {
  if (!pointInsideWalkableSurface(start, polygon) ||
    !pointInsideWalkableSurface(target, polygon)) return false;

  // Sample each open interval split by a boundary intersection. This keeps
  // boundary-following routes legal while rejecting a segment that leaves a
  // concave authored floor and later re-enters it.
  const parameters = [0, 1];
  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index]!;
    const edgeEnd = polygon[(index + 1) % polygon.length]!;
    parameters.push(...segmentIntersectionParameters(start, target, edgeStart, edgeEnd));
  }
  parameters.sort((left, right) => left - right);
  const unique: number[] = [];
  for (const parameter of parameters) {
    const clamped = Math.max(0, Math.min(1, parameter));
    if (unique.length === 0 || Math.abs(unique[unique.length - 1]! - clamped) > 1e-9) {
      unique.push(clamped);
    }
  }
  for (let index = 1; index < unique.length; index += 1) {
    const first = unique[index - 1]!;
    const last = unique[index]!;
    if (last - first <= 1e-12) continue;
    const midpoint = pointAlongSegment(start, target, (first + last) / 2);
    if (!pointInsideWalkableSurface(midpoint, polygon)) return false;
  }
  return true;
}

function pointAlongSegment(start: IndoorPoint, target: IndoorPoint, parameter: number): IndoorPoint {
  return {
    x: start.x + (target.x - start.x) * parameter,
    y: start.y + (target.y - start.y) * parameter
  };
}

function segmentIntersectionParameters(
  firstStart: IndoorPoint,
  firstEnd: IndoorPoint,
  secondStart: IndoorPoint,
  secondEnd: IndoorPoint
): number[] {
  const firstDirection = {
    x: firstEnd.x - firstStart.x,
    y: firstEnd.y - firstStart.y
  };
  const secondDirection = {
    x: secondEnd.x - secondStart.x,
    y: secondEnd.y - secondStart.y
  };
  const denominator = firstDirection.x * secondDirection.y -
    firstDirection.y * secondDirection.x;
  const offset = {
    x: secondStart.x - firstStart.x,
    y: secondStart.y - firstStart.y
  };
  if (Math.abs(denominator) > 1e-12) {
    const firstParameter = (offset.x * secondDirection.y - offset.y * secondDirection.x) /
      denominator;
    const secondParameter = (offset.x * firstDirection.y - offset.y * firstDirection.x) /
      denominator;
    return firstParameter >= -1e-9 && firstParameter <= 1 + 1e-9 &&
      secondParameter >= -1e-9 && secondParameter <= 1 + 1e-9
      ? [firstParameter]
      : [];
  }
  if (Math.abs(crossProduct(firstStart, firstEnd, secondStart)) > 1e-9) return [];
  const firstLengthSquared = firstDirection.x ** 2 + firstDirection.y ** 2;
  if (firstLengthSquared <= 1e-18) return [];
  const startParameter = ((secondStart.x - firstStart.x) * firstDirection.x +
    (secondStart.y - firstStart.y) * firstDirection.y) / firstLengthSquared;
  const endParameter = ((secondEnd.x - firstStart.x) * firstDirection.x +
    (secondEnd.y - firstStart.y) * firstDirection.y) / firstLengthSquared;
  return [startParameter, endParameter].filter((parameter) =>
    parameter >= -1e-9 && parameter <= 1 + 1e-9);
}

function segmentClearOfPolygon(
  start: IndoorPoint,
  target: IndoorPoint,
  polygon: readonly IndoorPoint[],
  clearance: number
): boolean {
  const midpoint = { x: (start.x + target.x) / 2, y: (start.y + target.y) / 2 };
  if (pointInPolygon(midpoint, polygon)) return false;
  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index]!;
    const edgeEnd = polygon[(index + 1) % polygon.length]!;
    if (segmentDistance(start, target, edgeStart, edgeEnd) < clearance - 1e-9) return false;
  }
  return true;
}

/** Mitered offset vertices produce exact straight-line clearance candidates for visibility routing. */
function polygonClearanceVertices(
  polygon: readonly IndoorPoint[],
  clearance: number
): IndoorPoint[] {
  const orientation = Math.sign(polygonSignedArea(polygon)) || 1;
  const result: IndoorPoint[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length]!;
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    const incoming = normalized(current.x - previous.x, current.y - previous.y);
    const outgoing = normalized(next.x - current.x, next.y - current.y);
    const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
    if (cross * orientation <= 1e-9) continue;
    const incomingNormal = outwardNormal(incoming, orientation);
    const outgoingNormal = outwardNormal(outgoing, orientation);
    const first = {
      x: current.x + incomingNormal.x * (clearance + 1e-7),
      y: current.y + incomingNormal.y * (clearance + 1e-7)
    };
    const second = {
      x: current.x + outgoingNormal.x * (clearance + 1e-7),
      y: current.y + outgoingNormal.y * (clearance + 1e-7)
    };
    const intersection = lineIntersection(first, incoming, second, outgoing);
    if (intersection) result.push(intersection);
  }
  return result;
}

function normalized(x: number, y: number): IndoorPoint {
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
}

function outwardNormal(edge: IndoorPoint, orientation: number): IndoorPoint {
  return orientation > 0 ? { x: edge.y, y: -edge.x } : { x: -edge.y, y: edge.x };
}

function lineIntersection(
  first: IndoorPoint,
  firstDirection: IndoorPoint,
  second: IndoorPoint,
  secondDirection: IndoorPoint
): IndoorPoint | null {
  const denominator = firstDirection.x * secondDirection.y - firstDirection.y * secondDirection.x;
  if (Math.abs(denominator) < 1e-12) return null;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = (dx * secondDirection.y - dy * secondDirection.x) / denominator;
  return {
    x: first.x + firstDirection.x * distance,
    y: first.y + firstDirection.y * distance
  };
}

function polygonSignedArea(polygon: readonly IndoorPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

function pointInPolygon(point: IndoorPoint, polygon: readonly IndoorPoint[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    if (pointSegmentDistance(point, a, b) <= 1e-9) return true;
    if ((a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentDistance(
  firstStart: IndoorPoint,
  firstEnd: IndoorPoint,
  secondStart: IndoorPoint,
  secondEnd: IndoorPoint
): number {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return 0;
  return Math.min(
    pointSegmentDistance(firstStart, secondStart, secondEnd),
    pointSegmentDistance(firstEnd, secondStart, secondEnd),
    pointSegmentDistance(secondStart, firstStart, firstEnd),
    pointSegmentDistance(secondEnd, firstStart, firstEnd)
  );
}

function pointSegmentDistance(point: IndoorPoint, start: IndoorPoint, end: IndoorPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const scalar = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
  ));
  return Math.hypot(point.x - (start.x + scalar * dx), point.y - (start.y + scalar * dy));
}

function segmentsIntersect(
  a: IndoorPoint,
  b: IndoorPoint,
  c: IndoorPoint,
  d: IndoorPoint
): boolean {
  const abC = crossProduct(a, b, c);
  const abD = crossProduct(a, b, d);
  const cdA = crossProduct(c, d, a);
  const cdB = crossProduct(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
    ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  return Math.abs(abC) <= 1e-9 && pointOnSegment(c, a, b) ||
    Math.abs(abD) <= 1e-9 && pointOnSegment(d, a, b) ||
    Math.abs(cdA) <= 1e-9 && pointOnSegment(a, c, d) ||
    Math.abs(cdB) <= 1e-9 && pointOnSegment(b, c, d);
}

function crossProduct(a: IndoorPoint, b: IndoorPoint, c: IndoorPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: IndoorPoint, start: IndoorPoint, end: IndoorPoint): boolean {
  return point.x >= Math.min(start.x, end.x) - 1e-9 &&
    point.x <= Math.max(start.x, end.x) + 1e-9 &&
    point.y >= Math.min(start.y, end.y) - 1e-9 &&
    point.y <= Math.max(start.y, end.y) + 1e-9;
}

function pointInsideOpenRectangle(point: IndoorPoint, rectangle: InflatedRectangle): boolean {
  return point.x > rectangle.minX && point.x < rectangle.maxX &&
    point.y > rectangle.minY && point.y < rectangle.maxY;
}

function segmentCrossesOpenRectangle(
  start: IndoorPoint,
  target: IndoorPoint,
  rectangle: InflatedRectangle
): boolean {
  const xInterval = openSlabInterval(start.x, target.x - start.x, rectangle.minX, rectangle.maxX);
  if (!xInterval) return false;
  const yInterval = openSlabInterval(start.y, target.y - start.y, rectangle.minY, rectangle.maxY);
  if (!yInterval) return false;
  return Math.max(0, xInterval[0], yInterval[0]) < Math.min(1, xInterval[1], yInterval[1]);
}

function openSlabInterval(value: number, delta: number, minimum: number, maximum: number): [number, number] | null {
  if (delta === 0) return value > minimum && value < maximum
    ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
    : null;
  const first = (minimum - value) / delta;
  const second = (maximum - value) / delta;
  return first < second ? [first, second] : [second, first];
}

function pointKey(point: IndoorPoint): string {
  return `${point.x}:${point.y}`;
}
