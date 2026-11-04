import {
  STANDARD_INDOOR_SPATIAL_PROFILE,
  type DungeonCatalog,
  type DungeonDefinition,
  type DungeonPrefabDefinition,
  type DungeonRoomDefinition,
  type IndoorPoint,
  type InteriorAnchorRole,
  type InteriorCatalog,
  type InteriorClickArea,
  type InteriorFloor,
  type InteriorSpace,
  type InteriorSpaceKind,
  type InteriorWall
} from "@ash-atlas/shared";

import type { ModuleView } from "./interiorModules.js";
import { connectDungeonRooms, retireDungeonPortalConnection, type DungeonFloorsOf } from "./dungeonTopology.js";
import {
  DEFAULT_WALL_TRANSFORM,
  defaultImagePolygon,
  translatePoints,
  uniqueId,
  type MutablePoint
} from "./interiorCanvasAuthoring.js";

/**
 * Room geometry authoring for every interior kind. The Studio edits a
 * dungeon-shaped view of each space; floors, walls, click areas and typed
 * anchor roles do not exist in that shape, so they ride along in a sidecar on
 * the view (`interiorAuthoring`, keyed by space and room). A room without a
 * sidecar entry is exactly what is stored, so untouched rooms never look
 * edited. Every operation here mutates a draft view. Browser-safe.
 */

export type AuthoringSources = Readonly<{
  base: InteriorCatalog | null;
  /** Spaces created in the Studio and not published yet. */
  seeds: Readonly<Record<string, InteriorSpace>>;
}>;

/** An anchor role the view cannot derive: a portal not paired yet, a message, or a forced plain point. */
export type AnchorRoleOverride = Readonly<{ role: Exclude<InteriorAnchorRole, "spawn">; message?: string }>;

export type RoomAuthoring = {
  /** True while the room's floor is the automatic inset rectangle (it follows the room size). */
  autoFloors: boolean;
  floors: InteriorFloor[];
  walls: InteriorWall[];
  clickAreas: InteriorClickArea[];
  anchors: Record<string, AnchorRoleOverride>;
  /** Studio display names of anchors (shown on the canvas instead of "Point"/"Door point"). */
  anchorNames?: Record<string, string>;
};

export type AuthoringView = DungeonCatalog & { interiorAuthoring?: Record<string, RoomAuthoring> } & ModuleView;

export type AuthoringResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

export type ShapeRef = Readonly<{ kind: "floor" | "wall" | "clickArea" | "collider" | "zone"; id: string }>;
export type DrawShapeKind = "floor" | "back_wall" | "left_wall" | "right_wall" | "collider" | "click_area";

export const DRAW_SHAPE_LABELS: Readonly<Record<DrawShapeKind, string>> = {
  floor: "Floor (walkable)",
  collider: "Collider",
  back_wall: "Back wall",
  left_wall: "Left wall",
  right_wall: "Right wall",
  click_area: "Click area"
};

export const authoringKey = (spaceId: string, roomId: string): string => `${spaceId}/${roomId}`;

/** The legacy "room bounds" walkable area: a rectangle inset by the player radius. */
export function insetFloorPolygon(width: number, height: number): { x: number; y: number }[] {
  const inset = STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius;
  return [
    { x: inset, y: inset }, { x: width - inset, y: inset },
    { x: width - inset, y: height - inset }, { x: inset, y: height - inset }
  ];
}

const autoFloor = (width: number, height: number): InteriorFloor => ({ id: "floor", retired: false, polygon: insetFloorPolygon(width, height) });

function isAutoFloorSet(room: { width: number; height: number; floors: readonly InteriorFloor[] }): boolean {
  if (room.floors.length !== 1) return false;
  const floor = room.floors[0]!;
  const expected = insetFloorPolygon(room.width, room.height);
  return floor.id === "floor" && !floor.retired && floor.polygon.length === expected.length &&
    floor.polygon.every((point, index) => Math.abs(point.x - expected[index]!.x) < 1e-6 && Math.abs(point.y - expected[index]!.y) < 1e-6);
}

function storedSpace(sources: AuthoringSources, spaceId: string): InteriorSpace | undefined {
  return sources.base?.spaces.find((space) => space.id === spaceId) ?? sources.seeds[spaceId];
}
function storedRoom(sources: AuthoringSources, spaceId: string, roomId: string): InteriorSpace["rooms"][number] | undefined {
  return storedSpace(sources, spaceId)?.rooms.find((room) => room.id === roomId);
}

export function authoringSpaceKind(sources: AuthoringSources, spaceId: string): InteriorSpaceKind {
  return storedSpace(sources, spaceId)?.kind ?? "dungeon";
}

/** True when this child id is already in a published space (it must be retired, never removed). */
function isPublished(sources: AuthoringSources, spaceId: string, roomId: string, collection: "floors" | "walls" | "clickAreas" | "colliders" | "zones" | "anchors", id: string): boolean {
  const room = sources.base?.spaces.find((space) => space.id === spaceId)?.rooms.find((candidate) => candidate.id === roomId);
  return Boolean(room && (room[collection] as readonly { id: string }[]).some((value) => value.id === id));
}

/** What a room's geometry is right now: its sidecar entry, or what is stored (an automatic inset floor when that is what is stored). */
export function effectiveRoomAuthoring(view: AuthoringView, sources: AuthoringSources, spaceId: string, room: Pick<DungeonRoomDefinition, "id" | "width" | "height">): RoomAuthoring {
  const entry = view.interiorAuthoring?.[authoringKey(spaceId, room.id)];
  if (entry) {
    const copy = structuredClone(entry);
    return { ...copy, floors: copy.autoFloors ? [autoFloor(room.width, room.height)] : copy.floors };
  }
  const stored = storedRoom(sources, spaceId, room.id);
  if (!stored) return { autoFloors: true, floors: [autoFloor(room.width, room.height)], walls: [], clickAreas: [], anchors: {} };
  const autoFloors = isAutoFloorSet(stored);
  return {
    autoFloors,
    floors: autoFloors ? [autoFloor(room.width, room.height)] : structuredClone([...stored.floors]),
    walls: structuredClone([...stored.walls]),
    clickAreas: structuredClone([...stored.clickAreas]),
    anchors: Object.fromEntries(stored.anchors.filter((anchor) => anchor.role === "message")
      .map((anchor) => [anchor.id, { role: "message" as const, ...(anchor.message ? { message: anchor.message } : {}) }])),
    anchorNames: Object.fromEntries(stored.anchors.flatMap((anchor) => anchor.name ? [[anchor.id, anchor.name]] : []))
  };
}

function findRoom(view: AuthoringView, spaceId: string, roomId: string): { dungeon: DungeonDefinition; room: DungeonRoomDefinition } | null {
  const dungeon = view.dungeons.find((candidate) => candidate.id === spaceId);
  const room = dungeon?.rooms.find((candidate) => candidate.id === roomId);
  return dungeon && room ? { dungeon, room } : null;
}

const stableText = (value: unknown): string => JSON.stringify(value);

/** Edits a room's authoring (materializing its sidecar entry on the first real change). */
export function editRoomAuthoring(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, edit: (authoring: RoomAuthoring, room: DungeonRoomDefinition) => void): boolean {
  const found = findRoom(view, spaceId, roomId);
  if (!found) return false;
  const before = effectiveRoomAuthoring(view, sources, spaceId, found.room);
  const draft = structuredClone(before);
  edit(draft, found.room);
  if (stableText(draft) === stableText(before)) return true;
  view.interiorAuthoring = { ...(view.interiorAuthoring ?? {}), [authoringKey(spaceId, roomId)]: draft };
  return true;
}

/** Walkable floor polygons of a room as the topology helpers want them. */
export function floorsResolver(view: AuthoringView, sources: AuthoringSources, spaceId: string): DungeonFloorsOf {
  return (room) => effectiveRoomAuthoring(view, sources, spaceId, room).floors.filter((floor) => !floor.retired).map((floor) => floor.polygon);
}

function surfaceIds(authoring: RoomAuthoring): string[] {
  return [...authoring.floors, ...authoring.walls].map((surface) => surface.id);
}

// ---------------------------------------------------------------------------
// Polygon shapes
// ---------------------------------------------------------------------------

function defaultClickTarget(view: AuthoringView, sources: AuthoringSources, spaceId: string, room: DungeonRoomDefinition, authoring: RoomAuthoring): InteriorClickArea["target"] | null {
  const active = room.anchors.filter((anchor) => !anchor.retired && anchor.id !== room.spawnAnchorId);
  const interactive = active.find((anchor) => {
    const role = authoring.anchors[anchor.id]?.role;
    return role === "portal" || role === "message" || portalAnchorIds(view, spaceId, room.id).has(anchor.id);
  });
  const anchor = interactive ?? active[0];
  if (anchor) return { anchorId: anchor.id };
  const object = room.objects.find((candidate) => !candidate.retired);
  return object ? { objectId: object.id } : null;
}

function portalAnchorIds(view: AuthoringView, spaceId: string, roomId: string): Set<string> {
  const dungeon = view.dungeons.find((candidate) => candidate.id === spaceId);
  const ids = new Set<string>();
  for (const portal of dungeon?.portals ?? []) {
    if (portal.retired) continue;
    for (const endpoint of [portal.source, portal.destination]) if (endpoint.kind === "room" && endpoint.roomId === roomId) ids.add(endpoint.anchorId);
  }
  return ids;
}

/** Adds a finished polygon of the given kind. Floors, walls and click areas go to the sidecar, colliders to the room. */
export function addPolygonShape(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, kind: DrawShapeKind, points: readonly IndoorPoint[]): AuthoringResult<{ ref: ShapeRef }> {
  const found = findRoom(view, spaceId, roomId);
  if (!found) return { ok: false, error: "Select a room first." };
  if (points.length < 3) return { ok: false, error: "A shape needs at least three vertices." };
  const polygon: MutablePoint[] = points.map((point) => ({ x: point.x, y: point.y }));
  if (kind === "collider") {
    const id = uniqueId("collider_polygon", found.room.colliders.map((value) => value.id));
    found.room.colliders.push({ id, retired: false, kind: "polygon", points: polygon });
    return { ok: true, ref: { kind: "collider", id } };
  }
  let ref: ShapeRef | null = null;
  let error: string | null = null;
  editRoomAuthoring(view, sources, spaceId, roomId, (authoring, room) => {
    if (kind === "floor") {
      // The first drawn floor replaces the automatic one (kept as a retired record only if it was published).
      if (authoring.autoFloors) {
        authoring.autoFloors = false;
        authoring.floors = isPublished(sources, spaceId, roomId, "floors", "floor")
          ? authoring.floors.map((floor) => ({ ...floor, retired: true }))
          : [];
      }
      const id = uniqueId("floor_surface", surfaceIds(authoring));
      authoring.floors.push({ id, retired: false, polygon });
      ref = { kind: "floor", id };
    } else if (kind === "click_area") {
      const target = defaultClickTarget(view, sources, spaceId, room, authoring);
      if (!target) { error = "Add a portal or message anchor before drawing a click area."; return; }
      const id = uniqueId("click_area", authoring.clickAreas.map((value) => value.id));
      authoring.clickAreas.push({ id, retired: false, polygon, target, interactionLabel: "Interact" });
      ref = { kind: "clickArea", id };
    } else {
      const id = uniqueId(`${kind}_surface`, surfaceIds(authoring));
      authoring.walls.push({ id, retired: false, kind, roomPolygon: polygon, imagePolygon: defaultImagePolygon(polygon), transform: { ...DEFAULT_WALL_TRANSFORM } });
      ref = { kind: "wall", id };
    }
  });
  return error ? { ok: false, error } : ref ? { ok: true, ref } : { ok: false, error: "The shape could not be added." };
}

type ShapeAccess = { points: MutablePoint[]; replace(points: MutablePoint[]): void };

/** Runs `edit` on one polygon shape of a room; false when the shape does not exist or has no vertices (rectangles). */
function withShape(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, ref: ShapeRef, edit: (shape: ShapeAccess, bounds: { width: number; height: number }) => void): boolean {
  const found = findRoom(view, spaceId, roomId);
  if (!found) return false;
  const bounds = { width: found.room.width, height: found.room.height };
  if (ref.kind === "collider" || ref.kind === "zone") {
    const record = (ref.kind === "collider" ? found.room.colliders : found.room.zones).find((value) => value.id === ref.id);
    if (!record || record.kind !== "polygon") return false;
    edit({ points: record.points as MutablePoint[], replace: (points) => { record.points = points; } }, bounds);
    return true;
  }
  let done = false;
  editRoomAuthoring(view, sources, spaceId, roomId, (authoring) => {
    if (ref.kind === "floor") {
      const floor = authoring.floors.find((value) => value.id === ref.id);
      if (!floor) return;
      authoring.autoFloors = false;
      done = true;
      edit({ points: floor.polygon as MutablePoint[], replace: (points) => { floor.polygon = points; } }, bounds);
    } else if (ref.kind === "wall") {
      const wall = authoring.walls.find((value) => value.id === ref.id);
      if (!wall) return;
      done = true;
      edit({
        points: wall.roomPolygon as MutablePoint[],
        replace: (points) => {
          const resized = points.length !== wall.roomPolygon.length;
          wall.roomPolygon = points;
          if (resized) wall.imagePolygon = defaultImagePolygon(points);
        }
      }, bounds);
    } else {
      const area = authoring.clickAreas.find((value) => value.id === ref.id);
      if (!area) return;
      done = true;
      edit({ points: area.polygon as MutablePoint[], replace: (points) => { area.polygon = points; } }, bounds);
    }
  });
  return done;
}

export function translateShape(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, ref: ShapeRef, delta: IndoorPoint): boolean {
  return withShape(view, sources, spaceId, roomId, ref, (shape, bounds) => translatePoints(shape.points, delta, bounds));
}

export function setShapeVertices(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, ref: ShapeRef, points: readonly IndoorPoint[]): boolean {
  if (points.length < 3) return false;
  return withShape(view, sources, spaceId, roomId, ref, (shape) => shape.replace(points.map((point) => ({ x: point.x, y: point.y }))));
}

export function moveShapeVertex(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, ref: ShapeRef, index: number, point: IndoorPoint): boolean {
  return withShape(view, sources, spaceId, roomId, ref, (shape, bounds) => {
    const vertex = shape.points[index];
    if (!vertex) return;
    vertex.x = Math.min(bounds.width, Math.max(0, point.x));
    vertex.y = Math.min(bounds.height, Math.max(0, point.y));
  });
}

/** The vertices of a shape as currently authored, or null when it has none (a rectangle) or is missing. */
export function shapeVertices(room: DungeonRoomDefinition, authoring: RoomAuthoring, ref: ShapeRef): readonly IndoorPoint[] | null {
  if (ref.kind === "collider" || ref.kind === "zone") {
    const record = (ref.kind === "collider" ? room.colliders : room.zones).find((value) => value.id === ref.id);
    return record && record.kind === "polygon" ? record.points : null;
  }
  if (ref.kind === "floor") return authoring.floors.find((value) => value.id === ref.id)?.polygon ?? null;
  if (ref.kind === "wall") return authoring.walls.find((value) => value.id === ref.id)?.roomPolygon ?? null;
  return authoring.clickAreas.find((value) => value.id === ref.id)?.polygon ?? null;
}

export function updateWall(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, wallId: string, edit: (wall: InteriorWall) => void): boolean {
  return editRoomAuthoring(view, sources, spaceId, roomId, (authoring) => {
    const wall = authoring.walls.find((value) => value.id === wallId);
    if (wall) edit(wall);
  });
}

export function updateClickArea(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, areaId: string, edit: (area: InteriorClickArea) => void): boolean {
  return editRoomAuthoring(view, sources, spaceId, roomId, (authoring) => {
    const area = authoring.clickAreas.find((value) => value.id === areaId);
    if (area) edit(area);
  });
}

/** Retire a shape; a shape that was never published is removed outright. */
export function retireShape(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, ref: ShapeRef): boolean {
  const found = findRoom(view, spaceId, roomId);
  if (!found) return false;
  if (ref.kind === "collider" || ref.kind === "zone") {
    const list = ref.kind === "collider" ? found.room.colliders : found.room.zones;
    const index = list.findIndex((value) => value.id === ref.id);
    if (index < 0) return false;
    if (isPublished(sources, spaceId, roomId, ref.kind === "collider" ? "colliders" : "zones", ref.id)) list[index]!.retired = true;
    else list.splice(index, 1);
    return true;
  }
  const collection = ref.kind === "floor" ? "floors" : ref.kind === "wall" ? "walls" : "clickAreas";
  let done = false;
  editRoomAuthoring(view, sources, spaceId, roomId, (authoring) => {
    const list = authoring[collection] as { id: string; retired: boolean }[];
    const index = list.findIndex((value) => value.id === ref.id);
    if (index < 0) return;
    done = true;
    if (ref.kind === "floor") authoring.autoFloors = false;
    if (isPublished(sources, spaceId, roomId, collection, ref.id)) list[index]!.retired = true;
    else list.splice(index, 1);
  });
  return done;
}

// ---------------------------------------------------------------------------
// Typed anchors
// ---------------------------------------------------------------------------

export type AnchorRoleChoice = InteriorAnchorRole;
export const ANCHOR_ROLE_LABELS: Readonly<Record<InteriorAnchorRole, string>> = {
  spawn: "Spawn", portal: "Portal", message: "Message", point: "Point"
};

export type AnchorPortalLink = Readonly<{ portalId: string; destinationRoomId: string; destinationAnchorId: string }>;

/** The active portal leaving this anchor, if it is a room-to-room link. */
export function anchorPortalLink(dungeon: DungeonDefinition, roomId: string, anchorId: string): AnchorPortalLink | null {
  const portal = dungeon.portals.find((candidate) => !candidate.retired && candidate.source.kind === "room" &&
    candidate.source.roomId === roomId && candidate.source.anchorId === anchorId && candidate.destination.kind === "room");
  return portal && portal.destination.kind === "room"
    ? { portalId: portal.id, destinationRoomId: portal.destination.roomId, destinationAnchorId: portal.destinationArrivalAnchorId ?? portal.destination.anchorId }
    : null;
}

/** True when an active portal touches the anchor on either end. */
export function anchorHasActivePortal(dungeon: DungeonDefinition, roomId: string, anchorId: string): boolean {
  return dungeon.portals.some((portal) => !portal.retired && [portal.source, portal.destination].some((endpoint) =>
    endpoint.kind === "room" && endpoint.roomId === roomId && endpoint.anchorId === anchorId));
}

/** Effective role of an anchor as the published space will carry it. */
export function anchorRoleOf(view: AuthoringView, sources: AuthoringSources, spaceId: string, room: DungeonRoomDefinition, anchorId: string): InteriorAnchorRole {
  if (anchorId === room.spawnAnchorId) return "spawn";
  const override = effectiveRoomAuthoring(view, sources, spaceId, room).anchors[anchorId];
  if (override) return override.role;
  const dungeon = view.dungeons.find((candidate) => candidate.id === spaceId);
  return dungeon && (anchorHasActivePortal(dungeon, room.id, anchorId) || room.objects.some((object) => !object.retired && object.type === "portal" && object.anchorId === anchorId)) ? "portal" : "point";
}

/** Retires every portal record touching the anchor (both directions) and turns the far anchors left unpaired into plain points. */
function unlinkAnchor(view: AuthoringView, sources: AuthoringSources, dungeon: DungeonDefinition, roomId: string, anchorId: string): void {
  const touching = dungeon.portals.filter((portal) => !portal.retired && [portal.source, portal.destination].some((endpoint) =>
    endpoint.kind === "room" && endpoint.roomId === roomId && endpoint.anchorId === anchorId));
  const farEnds: { roomId: string; anchorId: string }[] = [];
  for (const portal of touching) {
    for (const endpoint of [portal.source, portal.destination]) {
      if (endpoint.kind === "room" && !(endpoint.roomId === roomId && endpoint.anchorId === anchorId)) farEnds.push({ roomId: endpoint.roomId, anchorId: endpoint.anchorId });
    }
    retireDungeonPortalConnection(dungeon, portal.id);
  }
  for (const far of farEnds) {
    if (anchorHasActivePortal(dungeon, far.roomId, far.anchorId)) continue;
    editRoomAuthoring(view, sources, dungeon.id, far.roomId, (authoring) => { authoring.anchors[far.anchorId] = { role: "point" }; });
  }
}

/** Change an anchor's role. Leaving Portal retires its portal records (both ends); Spawn moves the room spawn. */
export function setAnchorRole(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, anchorId: string, role: InteriorAnchorRole): AuthoringResult {
  const found = findRoom(view, spaceId, roomId);
  const anchor = found?.room.anchors.find((value) => value.id === anchorId && !value.retired);
  if (!found || !anchor) return { ok: false, error: "That anchor does not exist." };
  const current = anchorRoleOf(view, sources, spaceId, found.room, anchorId);
  if (current === role) return { ok: true };
  if (current === "spawn") return { ok: false, error: "Choose another anchor as the room spawn first." };
  if (role === "spawn" && found.room.objects.some((object) => !object.retired && object.anchorId === anchorId)) {
    return { ok: false, error: "An anchor with an object on it cannot be the spawn." };
  }
  if (role !== "portal") unlinkAnchor(view, sources, found.dungeon, roomId, anchorId);
  if (role === "spawn") {
    found.room.spawnAnchorId = anchorId;
    editRoomAuthoring(view, sources, spaceId, roomId, (authoring) => { delete authoring.anchors[anchorId]; });
    return { ok: true };
  }
  editRoomAuthoring(view, sources, spaceId, roomId, (authoring) => {
    authoring.anchors[anchorId] = role === "message" ? { role: "message", message: authoring.anchors[anchorId]?.message ?? "" } : { role };
  });
  return { ok: true };
}

/** Name an anchor for Studio (empty clears it). */
export function setAnchorName(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, anchorId: string, name: string): boolean {
  return editRoomAuthoring(view, sources, spaceId, roomId, (authoring) => {
    const names = { ...(authoring.anchorNames ?? {}) };
    const trimmed = name.trim().slice(0, 40);
    if (trimmed) names[anchorId] = trimmed; else delete names[anchorId];
    authoring.anchorNames = names;
  });
}

export function setAnchorMessage(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, anchorId: string, message: string): boolean {
  return editRoomAuthoring(view, sources, spaceId, roomId, (authoring) => {
    if (authoring.anchors[anchorId]?.role === "message") authoring.anchors[anchorId] = { role: "message", message };
  });
}

/** Retire an anchor (removed outright when it was never published). Its portals are retired, its click areas retired. */
export function retireAnchor(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string, anchorId: string): AuthoringResult {
  const found = findRoom(view, spaceId, roomId);
  const index = found?.room.anchors.findIndex((value) => value.id === anchorId) ?? -1;
  if (!found || index < 0) return { ok: false, error: "That anchor does not exist." };
  if (anchorId === found.room.spawnAnchorId) return { ok: false, error: "The room spawn cannot be retired. Choose another spawn first." };
  const user = found.room.objects.find((object) => !object.retired && object.anchorId === anchorId)?.name
    ?? found.room.mobs.find((mob) => !mob.retired && mob.anchorId === anchorId)?.archetype;
  if (user) return { ok: false, error: `${user} uses this anchor. Retire it first.` };
  unlinkAnchor(view, sources, found.dungeon, roomId, anchorId);
  for (const area of effectiveRoomAuthoring(view, sources, spaceId, found.room).clickAreas) {
    if ("anchorId" in area.target && area.target.anchorId === anchorId && !area.retired) retireShape(view, sources, spaceId, roomId, { kind: "clickArea", id: area.id });
  }
  editRoomAuthoring(view, sources, spaceId, roomId, (authoring) => { delete authoring.anchors[anchorId]; });
  if (isPublished(sources, spaceId, roomId, "anchors", anchorId)) found.room.anchors[index]!.retired = true;
  else found.room.anchors.splice(index, 1);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Portal pairing
// ---------------------------------------------------------------------------

export type PortalDestination = Readonly<{ roomId: string; /** Absent: create a new anchor in that room. */ anchorId?: string }>;

export type PortalDestinationOption = Readonly<{ roomId: string; roomName: string; anchors: readonly { id: string; role: InteriorAnchorRole }[] }>;

/** Rooms (other than this one) and their pairable anchors (everything but the room spawn). */
export function portalDestinationOptions(view: AuthoringView, sources: AuthoringSources, spaceId: string, roomId: string): PortalDestinationOption[] {
  const dungeon = view.dungeons.find((candidate) => candidate.id === spaceId);
  return (dungeon?.rooms ?? []).filter((room) => !room.retired && room.id !== roomId).map((room) => ({
    roomId: room.id,
    roomName: room.name,
    anchors: room.anchors.filter((anchor) => !anchor.retired && anchor.id !== room.spawnAnchorId)
      .map((anchor) => ({ id: anchor.id, role: anchorRoleOf(view, sources, spaceId, room, anchor.id) }))
  }));
}

/** First available door art, needed only by dungeons (their doors are objects). */
export function firstPortalPrefab(view: AuthoringView): DungeonPrefabDefinition | null {
  return view.prefabs.find((prefab) => !prefab.retired && prefab.type === "portal") ?? null;
}

/**
 * Pair a Portal anchor with another room: creates the destination anchor when
 * none is chosen, marks both anchors Portal, and creates both portal records
 * (a reciprocal pair). Reachability uses the rooms' floors. Existing links on
 * either anchor are retired first. Nothing changes when it fails.
 */
export function pairPortalAnchors(view: AuthoringView, sources: AuthoringSources, spaceId: string, sourceRoomId: string, sourceAnchorId: string, destination: PortalDestination): AuthoringResult<{ portalId: string; reciprocalPortalId: string | null; destinationAnchorId: string }> {
  const dungeon = view.dungeons.find((candidate) => candidate.id === spaceId);
  if (!dungeon) return { ok: false, error: "Select an interior first." };
  const sourceRoom = dungeon.rooms.find((room) => room.id === sourceRoomId);
  const destinationRoom = dungeon.rooms.find((room) => room.id === destination.roomId);
  if (!sourceRoom || !destinationRoom || sourceRoom.id === destinationRoom.id) return { ok: false, error: "Choose a destination in another room." };
  if (sourceAnchorId === sourceRoom.spawnAnchorId) return { ok: false, error: "The room spawn cannot be a portal." };
  if (destination.anchorId !== undefined && destination.anchorId === destinationRoom.spawnAnchorId) return { ok: false, error: `${destinationRoom.name}: the room spawn cannot be a portal. Choose another anchor.` };
  const kind = authoringSpaceKind(sources, spaceId);
  const prefab = kind === "dungeon" ? firstPortalPrefab(view) : null;
  if (kind === "dungeon" && !prefab) return { ok: false, error: "A portal door prefab is required in the library." };

  const scratchView = structuredClone(view);
  const scratch = scratchView.dungeons.find((candidate) => candidate.id === spaceId)!;
  unlinkAnchor(scratchView, sources, scratch, sourceRoomId, sourceAnchorId);
  if (destination.anchorId !== undefined) unlinkAnchor(scratchView, sources, scratch, destination.roomId, destination.anchorId);
  let connection;
  try {
    connection = connectDungeonRooms(scratch,
      { roomId: sourceRoomId, anchorId: sourceAnchorId },
      { roomId: destination.roomId, ...(destination.anchorId !== undefined ? { anchorId: destination.anchorId } : {}) },
      prefab, true, { requireActive: false, floorsOf: floorsResolver(scratchView, sources, spaceId) });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The portal pair could not be created." };
  }
  for (const [roomId, anchorId] of [[sourceRoomId, connection.sourceAnchorId], [destination.roomId, connection.destinationAnchorId]] as const) {
    editRoomAuthoring(scratchView, sources, spaceId, roomId, (authoring) => { authoring.anchors[anchorId] = { role: "portal" }; });
  }
  // Adopt the scratch result in place so callers holding the draft's room objects keep valid references.
  for (const room of scratch.rooms) {
    const existing = dungeon.rooms.find((candidate) => candidate.id === room.id);
    if (existing) Object.assign(existing, room);
  }
  dungeon.portals.splice(0, dungeon.portals.length, ...scratch.portals);
  if (scratchView.interiorAuthoring) view.interiorAuthoring = scratchView.interiorAuthoring;
  else delete view.interiorAuthoring;
  return { ok: true, portalId: connection.portalId, reciprocalPortalId: connection.reciprocalPortalId, destinationAnchorId: connection.destinationAnchorId };
}

// ---------------------------------------------------------------------------
// Doors with several destinations
// ---------------------------------------------------------------------------

/** One destination of a door: another room (an anchor there, or a new one) or, for the lobby, outside. */
export type DoorDestination = Readonly<{
  /** A room id of this interior, or `world` (leave the interior; the entrance room only). */
  roomId: string;
  /** Absent: reuse that room's door back to this one, else create a new anchor there. */
  anchorId?: string;
  /** The button text players see in the door prompt (default: the room name, or "Leave Manor"). */
  label: string;
}>;

export const WORLD_DESTINATION = "world";

/** The door's current destinations (active portal records leaving the anchor), in record order. */
export function doorDestinations(dungeon: DungeonDefinition, roomId: string, anchorId: string): DoorDestination[] {
  return dungeon.portals.flatMap((portal) => !portal.retired && portal.source.kind === "room" &&
    portal.source.roomId === roomId && portal.source.anchorId === anchorId
    ? [portal.destination.kind === "room"
      ? { roomId: portal.destination.roomId, anchorId: portal.destinationArrivalAnchorId ?? portal.destination.anchorId, label: portal.interactionLabel }
      : { roomId: WORLD_DESTINATION, label: portal.interactionLabel }]
    : []);
}

/** The entrance room of a stored space (the only room whose door may lead outside). */
export function entranceRoomId(sources: AuthoringSources, spaceId: string): string | null {
  return storedSpace(sources, spaceId)?.defaultRoomId ?? null;
}

/**
 * Make a door lead to exactly `destinations`: each gets its own portal record
 * with the typed label and (for rooms) a return portal from the door in that
 * room back to this door. Earlier links of this door are retired first; the
 * door on the other side is reused when it already led back here. "Outside"
 * makes this the interior's only front door. Nothing changes when it fails.
 */
export function setDoorDestinations(
  view: AuthoringView,
  sources: AuthoringSources,
  spaceId: string,
  roomId: string,
  anchorId: string,
  destinations: readonly DoorDestination[]
): AuthoringResult<{ createdAnchors: { roomId: string; anchorId: string }[] }> {
  const dungeon = view.dungeons.find((candidate) => candidate.id === spaceId);
  const room = dungeon?.rooms.find((candidate) => candidate.id === roomId);
  if (!dungeon || !room) return { ok: false, error: "Select an interior room first." };
  if (anchorId === room.spawnAnchorId) return { ok: false, error: "The room spawn cannot be a door." };
  if (destinations.length === 0) return { ok: false, error: "Add at least one destination." };
  const outside = destinations.filter((destination) => destination.roomId === WORLD_DESTINATION);
  if (outside.length > 0 && destinations.length > 1) return { ok: false, error: "A door that leads outside cannot lead anywhere else." };
  if (outside.length > 0 && roomId !== entranceRoomId(sources, spaceId)) return { ok: false, error: "Only a door in the entrance room can lead outside." };
  const seen = new Set<string>();
  for (const destination of destinations) {
    if (destination.roomId === roomId) return { ok: false, error: "A destination must be another room." };
    if (seen.has(destination.roomId)) return { ok: false, error: "Each room can be a destination of this door only once." };
    seen.add(destination.roomId);
  }
  const kind = authoringSpaceKind(sources, spaceId);
  const prefab = kind === "dungeon" ? firstPortalPrefab(view) : null;
  if (kind === "dungeon" && !prefab) return { ok: false, error: "A portal door prefab is required in the library." };

  // The doors on the other side that already lead back here are reused.
  const previous = new Map(doorDestinations(dungeon, roomId, anchorId).flatMap((destination) =>
    destination.roomId !== WORLD_DESTINATION && destination.anchorId ? [[destination.roomId, destination.anchorId] as const] : []));
  const scratchView = structuredClone(view);
  const scratch = scratchView.dungeons.find((candidate) => candidate.id === spaceId)!;
  unlinkAnchor(scratchView, sources, scratch, roomId, anchorId);
  const createdAnchors: { roomId: string; anchorId: string }[] = [];
  try {
    for (const destination of destinations) {
      const label = destination.label.trim();
      if (destination.roomId === WORLD_DESTINATION) {
        // One front door: other ways outside are retired.
        for (const portal of scratch.portals) {
          if (!portal.retired && portal.destination.kind === "world" && portal.source.kind === "room") retireDungeonPortalConnection(scratch, portal.id);
        }
        const taken = new Set(scratch.portals.map((portal) => portal.id));
        let id = `${roomId}-${anchorId}`;
        for (let index = 2; taken.has(id); index += 1) id = `${roomId}-${anchorId}-${index}`;
        scratch.portals.push({
          id, retired: false, source: { kind: "room", roomId, anchorId }, destination: { kind: "world" },
          sourceApproachAnchorId: anchorId, conditions: ["always"], interactionLabel: label || "Leave Manor",
          presentation: "door", enabled: true
        } as DungeonDefinition["portals"][number]);
        continue;
      }
      const target = scratch.rooms.find((candidate) => candidate.id === destination.roomId && !candidate.retired);
      if (!target) throw new Error("Choose an available destination room.");
      const reuse = destination.anchorId ?? previous.get(target.id);
      const backAnchor = reuse && target.anchors.some((anchor) => anchor.id === reuse && !anchor.retired) ? reuse : undefined;
      if (backAnchor !== undefined && backAnchor === target.spawnAnchorId) throw new Error(`${target.name}: the room spawn cannot be a door. Choose another anchor.`);
      const connection = connectDungeonRooms(scratch, { roomId, anchorId },
        { roomId: target.id, ...(backAnchor !== undefined ? { anchorId: backAnchor } : {}) }, prefab, true,
        { requireActive: false, floorsOf: floorsResolver(scratchView, sources, spaceId), label: label || target.name, reverseLabel: room.name });
      if (backAnchor === undefined) createdAnchors.push({ roomId: target.id, anchorId: connection.destinationAnchorId });
      editRoomAuthoring(scratchView, sources, spaceId, target.id, (authoring) => { authoring.anchors[connection.destinationAnchorId] = { role: "portal" }; });
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The door could not be saved." };
  }
  editRoomAuthoring(scratchView, sources, spaceId, roomId, (authoring) => { authoring.anchors[anchorId] = { role: "portal" }; });
  for (const scratchRoom of scratch.rooms) {
    const existing = dungeon.rooms.find((candidate) => candidate.id === scratchRoom.id);
    if (existing) Object.assign(existing, scratchRoom);
  }
  dungeon.portals.splice(0, dungeon.portals.length, ...scratch.portals);
  if (scratchView.interiorAuthoring) view.interiorAuthoring = scratchView.interiorAuthoring;
  else delete view.interiorAuthoring;
  return { ok: true, createdAnchors };
}
