import {
  STANDARD_INDOOR_SPATIAL_PROFILE,
  findIndoorNavigationRoute,
  isIndoorInteractionInRange,
  isIndoorNavigationPointInsideWalkableSurface,
  isIndoorNavigationPointWalkable,
  type IndoorNavigationCollider,
  type IndoorPoint,
  type IndoorRoomNavigation
} from "../indoor.js";
import type { InteriorPortal, InteriorRoom, InteriorSpace } from "./interiorCatalog.js";

/**
 * Pure room helpers shared by every interior runtime. They build on the
 * existing indoor navigation primitives; sessions and business rules stay in
 * each runtime.
 */

type NavigableRoom = Pick<InteriorRoom, "width" | "height" | "colliders" | "floors">;

/**
 * Movement inputs for a room. Active floors are the sole walkable surface
 * (Manor semantics); colliders are the active room colliders plus
 * `extraColliders` (player placements, runtime fixtures).
 */
export function interiorNavigation(
  room: NavigableRoom,
  extraColliders: readonly IndoorNavigationCollider[] = []
): IndoorRoomNavigation {
  return {
    roomWidth: room.width,
    roomHeight: room.height,
    playerRadius: STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius,
    colliders: [
      ...room.colliders.filter((collider) => !collider.retired).map((collider): IndoorNavigationCollider =>
        collider.kind === "polygon"
          ? { id: collider.id, kind: "polygon", points: collider.points }
          : {
            id: collider.id,
            minX: collider.x,
            maxX: collider.x + collider.width,
            minY: collider.y,
            maxY: collider.y + collider.height
          }),
      ...extraColliders
    ],
    walkableSurfaces: room.floors.filter((floor) => !floor.retired).map((floor) => floor.polygon)
  };
}

export type InteriorMoveErrorCode =
  | "INVALID_MOVE"
  | "OUT_OF_BOUNDS"
  | "TOO_FAR"
  | "BLOCKED_TARGET"
  | "NO_ROUTE";

export type InteriorMoveResolution =
  | Readonly<{ ok: true; target: IndoorPoint; route: readonly IndoorPoint[] }>
  | Readonly<{ ok: false; code: InteriorMoveErrorCode; message: string }>;

/**
 * Classify a click-to-move request the way Manor does: non-finite input,
 * outside the room/floor, too far, blocked by a collider, or no
 * collision-free route. On success returns the waypoints (final target
 * included, start excluded).
 */
export function resolveMoveTarget(
  navigation: IndoorRoomNavigation,
  from: IndoorPoint,
  to: IndoorPoint,
  maxTargetDistance: number = STANDARD_INDOOR_SPATIAL_PROFILE.maxTargetDistance
): InteriorMoveResolution {
  if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) {
    return { ok: false, code: "INVALID_MOVE", message: "Coordinates must be finite." };
  }
  const hasAuthoredFloor = Boolean(navigation.walkableSurfaces && navigation.walkableSurfaces.length > 0);
  const min = hasAuthoredFloor ? 0 : navigation.playerRadius;
  if (to.x < min || to.y < min ||
    to.x > navigation.roomWidth - min || to.y > navigation.roomHeight - min) {
    return { ok: false, code: "OUT_OF_BOUNDS", message: "That target is outside the floor." };
  }
  if (Math.hypot(to.x - from.x, to.y - from.y) > maxTargetDistance) {
    return { ok: false, code: "TOO_FAR", message: "That target is too far away." };
  }
  if (hasAuthoredFloor && !isIndoorNavigationPointInsideWalkableSurface(navigation, to)) {
    return { ok: false, code: "OUT_OF_BOUNDS", message: "That target is outside the floor." };
  }
  if (!isIndoorNavigationPointWalkable(navigation, to)) {
    return { ok: false, code: "BLOCKED_TARGET", message: "That target is blocked by a collision." };
  }
  const route = findIndoorNavigationRoute(navigation, from, to);
  if (!route?.[0]) {
    return { ok: false, code: "NO_ROUTE", message: "No collision-free route is available from your current position." };
  }
  return { ok: true, target: { x: to.x, y: to.y }, route };
}

const SPAWN_OFFSETS = [
  [0, 0], [-70, 0], [70, 0], [0, -70], [-70, -70], [70, -70],
  [-140, 0], [140, 0], [-140, -70], [140, -70]
] as const;

/**
 * First free, walkable spot around the room's spawn anchor (Manor's offset
 * search). `occupied` are the positions already taken; `navigation` defaults
 * to the room's own and can be passed when the runtime layers extra colliders.
 */
export function spawnPoint(
  room: InteriorRoom,
  occupied: readonly IndoorPoint[] = [],
  navigation: IndoorRoomNavigation = interiorNavigation(room)
): IndoorPoint {
  const anchor = room.anchors.find((candidate) => candidate.id === room.spawnAnchorId);
  if (!anchor) throw new Error(`Room ${room.id} has no spawn anchor ${room.spawnAnchorId}`);
  const spawn = { x: anchor.x, y: anchor.y };
  const taken = new Set(occupied.map((point) => `${point.x}:${point.y}`));
  const available = SPAWN_OFFSETS
    .map(([x, y]) => ({ x: spawn.x + x, y: spawn.y + y }))
    .find((candidate) => !taken.has(`${candidate.x}:${candidate.y}`) &&
      isIndoorNavigationPointWalkable(navigation, candidate));
  if (available) return available;
  const fallback = { x: spawn.x, y: spawn.y - 140 };
  return isIndoorNavigationPointWalkable(navigation, fallback) ? fallback : spawn;
}

export type InteriorInteractionTarget =
  | Readonly<{ anchorId: string }>
  | Readonly<{ objectId: string }>;

/**
 * Whether `position` is close enough to use `target`. Objects use their own
 * `interactionRadius` around their anchor; a bare anchor (a portal door) uses
 * the standard door radius unless `radius` overrides it.
 */
export function interactionInRange(
  room: InteriorRoom,
  target: InteriorInteractionTarget,
  position: IndoorPoint,
  radius?: number
): boolean {
  let anchorId: string;
  let range: number;
  if ("objectId" in target) {
    const object = room.objects.find((candidate) => candidate.id === target.objectId && !candidate.retired);
    if (!object) return false;
    anchorId = object.anchorId;
    range = radius ?? object.interactionRadius;
  } else {
    anchorId = target.anchorId;
    range = radius ?? STANDARD_INDOOR_SPATIAL_PROFILE.doorInteractionRadius;
  }
  const anchor = room.anchors.find((candidate) => candidate.id === anchorId && !candidate.retired);
  return anchor !== undefined && isIndoorInteractionInRange(position, anchor, range);
}

export type InteriorWorldExit = Readonly<{
  portalId: string;
  roomId: string;
  anchorId: string;
  /** The authored door position (the exit portal's source anchor). */
  position: IndoorPoint;
  facing?: number;
  /** Where a player entering from the world appears: the room's spawn point. */
  arrival: IndoorPoint;
  interactionLabel: string;
  presentation: InteriorPortal["presentation"];
  enabled: boolean;
}>;

/**
 * The authored world exit of a space's room (default: the default room): the
 * active portal record leading from a room anchor to the world. Runtime portal
 * registries build both the exit and the world entrance from this.
 */
export function worldExitOf(space: InteriorSpace, roomId: string = space.defaultRoomId): InteriorWorldExit | null {
  const room = space.rooms.find((candidate) => candidate.id === roomId);
  const portal = spacePortals(space).find((candidate) => candidate.destination.kind === "world" &&
    candidate.source.kind === "room" && candidate.source.roomId === roomId);
  if (!room || !portal || portal.source.kind !== "room") return null;
  const anchorId = portal.source.anchorId;
  const anchor = room.anchors.find((candidate) => candidate.id === anchorId && !candidate.retired);
  if (!anchor) return null;
  return {
    portalId: portal.id,
    roomId,
    anchorId,
    position: { x: anchor.x, y: anchor.y },
    ...(anchor.facing !== undefined ? { facing: anchor.facing } : {}),
    arrival: spawnPoint(room),
    interactionLabel: portal.interactionLabel,
    presentation: portal.presentation,
    enabled: portal.enabled
  };
}

/** Active portal records of a space (retired records stay in the data but never route). */
export function spacePortals(space: Pick<InteriorSpace, "portals">): InteriorPortal[] {
  return space.portals.filter((portal) => !portal.retired);
}
