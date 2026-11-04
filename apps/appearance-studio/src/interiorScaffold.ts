import {
  MANOR_DOOR,
  MANOR_STATIONS,
  STANDARD_INDOOR_SPATIAL_PROFILE,
  dungeonCatalogFromInterior,
  fromDungeonCatalog,
  interiorCatalogSchema,
  interiorCatalogValidationIssues,
  interiorIdSchema,
  manorPortalRecordId,
  manorTemplateCatalogInputFromInterior,
  mergeInteriorLibrary,
  parseDungeonCatalog,
  pointObject,
  validateManorTemplateCatalog,
  worldExitPortal,
  type InteriorAnchor,
  type InteriorCatalog,
  type InteriorClickArea,
  type InteriorCollider,
  type InteriorLibrary,
  type InteriorObject,
  type InteriorPortal,
  type InteriorRoom,
  type InteriorSpace,
  type InteriorStationKind
} from "@ash-atlas/shared";
import { z } from "zod";

import { DungeonScaffoldError, formatDungeonScaffoldSummary, scaffoldDungeon } from "./dungeonScaffold.js";

/**
 * Interior scaffolder: turns a JSON spec into a new, validated `InteriorSpace` for the unified
 * interior catalog (`packages/shared/src/data/interiors/`). `dungeon` specs are compiled by the
 * dungeon spec compiler (`dungeonScaffold.ts`) and mapped to a space in memory; `manor` specs are
 * built directly. The result is a proposed catalog plus the single new space; the writer publishes
 * it with the same file plan the Studio uses (`planInteriorSpaceWrites`).
 */

export const INTERIOR_SCAFFOLD_KINDS = ["dungeon", "manor"] as const;
export type InteriorScaffoldKind = (typeof INTERIOR_SCAFFOLD_KINDS)[number];

/** Library prefabs under this root belong to the dungeon view; other library prefabs are preserved. */
const DUNGEON_ASSET_PREFIX = "apps/client/public/assets/dungeons/";

export class InteriorScaffoldError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Interior spec is not valid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "InteriorScaffoldError";
  }
}

export type InteriorScaffoldResult = Readonly<{
  kind: InteriorScaffoldKind;
  space: InteriorSpace;
  /** The library to publish (catalogRevision already bumped). */
  library: InteriorLibrary;
  /** The whole catalog as it will be after publishing. */
  proposed: InteriorCatalog;
  summary: string;
}>;

const bySpaceId = (left: InteriorSpace, right: InteriorSpace): number => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

export function scaffoldInterior(current: InteriorCatalog, kind: InteriorScaffoldKind, rawSpec: unknown): InteriorScaffoldResult {
  const catalogRevision = current.library.catalogRevision + 1;
  let space: InteriorSpace;
  let library: InteriorLibrary;
  let summary: string;
  if (kind === "dungeon") {
    const view = parseDungeonCatalog(dungeonCatalogFromInterior(current));
    const scaffolded = scaffoldDungeon(view, rawSpec);
    const transformed = fromDungeonCatalog({ ...scaffolded.catalog, catalogRevision });
    space = transformed.spaces.find((entry) => entry.id === scaffolded.summary.dungeonId)!;
    const preserved = current.library.prefabs.filter((prefab) => !prefab.assetKey.startsWith(DUNGEON_ASSET_PREFIX));
    library = mergeInteriorLibrary([
      transformed.library,
      { ...transformed.library, prefabs: preserved, rewardTables: [], bossTemplates: [], entrances: [], rewardTableIds: [], bossTemplateIds: [] }
    ], catalogRevision);
    summary = formatDungeonScaffoldSummary(scaffolded.summary);
  } else {
    const built = buildManor(current, rawSpec);
    space = built.space;
    library = { ...current.library, catalogRevision };
    summary = built.summary;
  }

  const proposed: InteriorCatalog = {
    library,
    spaces: [...current.spaces.filter((entry) => entry.id !== space.id), space].sort(bySpaceId)
  };
  const parsed = interiorCatalogSchema.safeParse(proposed);
  if (!parsed.success) {
    throw new InteriorScaffoldError(parsed.error.issues.map((issue) => `schema ${issue.path.join(".") || "$"}: ${issue.message}`));
  }
  const issues = interiorCatalogValidationIssues(parsed.data);
  if (issues.length > 0) {
    throw new InteriorScaffoldError(issues.map((issue) => `interior validation ${issue.path}: ${issue.message}`));
  }
  if (kind === "manor") {
    try {
      validateManorTemplateCatalog(manorTemplateCatalogInputFromInterior(parsed.data));
    } catch (error) {
      throw new InteriorScaffoldError([`Manor view: ${error instanceof Error ? error.message : String(error)}`]);
    }
  }
  return { kind, space, library, proposed: parsed.data, summary };
}

export { DungeonScaffoldError };

/* ------------------------------------------------------------------------------------------ *
 * Manor spec
 * ------------------------------------------------------------------------------------------ */

const nameId = z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, "use lowercase letters, digits and single underscores, e.g. grand_hall");
const num = z.number().finite();
const point = z.object({ x: num, y: num }).strict();
const polygon = z.array(point).min(3);
const rect = z.object({ x: num, y: num, width: num.positive(), height: num.positive() }).strict();
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const MANOR_ROOM_SIZE = 1254;

const manorAnchor = z.object({
  x: num,
  y: num,
  facing: num.optional(),
  /** `portal` anchors must be used by a door (`doors[].from|to.anchor`). */
  type: z.enum(["point", "message", "portal"]).default("point"),
  message: z.string().trim().min(1).max(240).optional()
}).strict();

const manorRoom = z.object({
  id: nameId,
  name: z.string().min(1),
  width: num.min(320).max(4000).default(MANOR_ROOM_SIZE),
  height: num.min(320).max(4000).default(MANOR_ROOM_SIZE),
  /** Where players arrive. Default: horizontal middle, 154 above the bottom edge. */
  spawn: z.object({ x: num, y: num, facing: num.optional() }).strict().optional(),
  /** Walkable polygons. Default: one rectangle inset by the player radius. */
  floors: z.array(z.object({ id: nameId.optional(), polygon }).strict()).min(1).optional(),
  walls: z.array(z.object({
    id: nameId,
    kind: z.enum(["back_wall", "left_wall", "right_wall"]),
    polygon,
    /** One normalized {u,v} per polygon vertex. Default: the polygon's bounding box mapped to 0..1. */
    image: z.array(z.object({ u: num.min(0).max(1), v: num.min(0).max(1) }).strict()).min(3).optional(),
    transform: z.object({ offsetU: num, offsetV: num, scaleU: num, scaleV: num, rotationDeg: num }).partial().strict().optional()
  }).strict()).default([]),
  colliders: z.array(z.object({ id: nameId, rect: rect.optional(), polygon: polygon.optional() }).strict()
    .refine((value) => Boolean(value.rect) !== Boolean(value.polygon), { message: "give exactly one of rect or polygon" })).default([]),
  anchors: z.record(nameId, manorAnchor).default({})
}).strict();

const doorEndpoint = z.object({ room: nameId, anchor: nameId.optional(), at: point.optional() }).strict()
  .refine((value) => Boolean(value.anchor) !== Boolean(value.at), { message: "give exactly one of anchor (a declared portal anchor) or at ({x,y})" });

const manorDoor = z.object({
  /** Defaults to "<from>_to_<to>". Auto-created anchors are named "<id>" (from side) and "<id>_back" (to side). */
  id: nameId.optional(),
  from: doorEndpoint,
  to: doorEndpoint,
  label: z.string().min(1).optional(),
  reverseLabel: z.string().min(1).optional(),
  /** Locks the from-side portal only (the return portal stays open), like the lobby's unfinished floors. */
  locked: z.boolean().default(false)
}).strict();

const stationPoint = z.union([z.literal(false), point]);

export const manorScaffoldSpecSchema = z.object({
  manor: z.object({
    id: nameId,
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    theme: z.object({
      id: nameId.optional(),
      backgroundColor: hex.default("#071116"),
      floorColor: hex.default("#182a2d"),
      wallColor: hex.default("#405052"),
      floorAssetKey: z.string().min(1).default("apps/client/src/assets/structures/manor-floor.png")
    }).strict().default({}),
    /** Players may place decorations in this manor's rooms. */
    playerPlacement: z.boolean().default(true)
  }).strict(),
  /** Room players arrive in from the world (and where stations live). Defaults to the first room. */
  entranceRoom: nameId.optional(),
  /** World exit portal position in the entrance room. Default: the lobby's exit door. */
  exit: point.optional(),
  rooms: z.array(manorRoom).min(1),
  doors: z.array(manorDoor).default([]),
  /** Stations in the entrance room. Omit for the lobby positions; `false` for none; per-kind {x,y} or `false`. */
  stations: z.union([
    z.literal(false),
    z.object({ chest: stationPoint, smith: stationPoint, jewel: stationPoint, breeder: stationPoint }).partial().strict()
  ]).default({})
}).strict();

export type ManorScaffoldSpec = z.input<typeof manorScaffoldSpecSchema>;

const WORLD_EXIT_ANCHOR_ID = "world_exit";
const RESERVED_ANCHORS = new Set(["spawn", WORLD_EXIT_ANCHOR_ID, ...MANOR_STATIONS.map((station) => `station_${station.kind}`)]);
const CLICK_HALF_SIZE = 60;
const IDENTITY_TRANSFORM = { offsetU: 0, offsetV: 0, scaleU: 1, scaleV: 1, rotationDeg: 0 };

function pathOf(path: readonly (string | number)[]): string {
  return path.reduce<string>((text, part) => typeof part === "number" ? `${text}[${part}]` : text ? `${text}.${part}` : String(part), "") || "spec";
}

function insetRect(width: number, height: number): { x: number; y: number }[] {
  const inset = STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius;
  return [{ x: inset, y: inset }, { x: width - inset, y: inset }, { x: width - inset, y: height - inset }, { x: inset, y: height - inset }];
}

function square(center: { x: number; y: number }, half: number, width: number, height: number): { x: number; y: number }[] {
  const left = Math.max(0, center.x - half);
  const right = Math.min(width, center.x + half);
  const top = Math.max(0, center.y - half);
  const bottom = Math.min(height, center.y + half);
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
}

function buildManor(current: InteriorCatalog, rawSpec: unknown): { space: InteriorSpace; summary: string } {
  const parsed = manorScaffoldSpecSchema.safeParse(rawSpec);
  if (!parsed.success) {
    throw new InteriorScaffoldError(parsed.error.issues.map((issue) => `${pathOf(issue.path)}: ${issue.message}`));
  }
  const spec = parsed.data;
  const issues: string[] = [];
  const fail = (path: string, message: string): void => { issues.push(`${path}: ${message}`); };

  const spaceId = spec.manor.id;
  const taken = new Set<string>();
  for (const space of current.spaces) {
    taken.add(space.id);
    for (const room of space.rooms) { taken.add(room.id); for (const alias of room.aliases) taken.add(alias); }
  }
  if (!interiorIdSchema.safeParse(spaceId).success || current.spaces.some((space) => space.id === spaceId)) {
    fail("manor.id", `a space with id "${spaceId}" already exists; choose a new id (published ids are permanent)`);
  }
  const roomIds = new Set<string>();
  spec.rooms.forEach((room, index) => {
    if (roomIds.has(room.id)) fail(`rooms[${index}].id`, `room id "${room.id}" is used twice`);
    roomIds.add(room.id);
    if (taken.has(room.id)) fail(`rooms[${index}].id`, `room id "${room.id}" is already used by another interior (room ids are unique catalog-wide; choose a different id)`);
  });
  const entranceRoomId = spec.entranceRoom ?? spec.rooms[0]!.id;
  if (!roomIds.has(entranceRoomId)) fail("entranceRoom", `"${entranceRoomId}" is not one of rooms[].id`);
  const roomSpecs = new Map(spec.rooms.map((room) => [room.id, room]));

  /* ---- anchors and portals from doors ---- */
  const extraAnchors = new Map<string, Map<string, InteriorAnchor>>(spec.rooms.map((room) => [room.id, new Map()]));
  const usedPortalAnchors = new Set<string>();
  const portals: InteriorPortal[] = [];
  const clickAreas = new Map<string, InteriorClickArea[]>(spec.rooms.map((room) => [room.id, []]));
  const doorIds = new Set<string>();
  const doorSummaries: string[] = [];

  spec.rooms.forEach((room, roomIndex) => {
    for (const name of Object.keys(room.anchors)) {
      if (RESERVED_ANCHORS.has(name)) fail(`rooms[${roomIndex}].anchors.${name}`, "this anchor name is reserved (spawn, world_exit and station_* are built in)");
    }
  });

  spec.doors.forEach((door, index) => {
    const id = door.id ?? `${door.from.room}_to_${door.to.room}`;
    if (doorIds.has(id)) fail(`doors[${index}].id`, `door id "${id}" is used twice; give the doors distinct id values`);
    doorIds.add(id);
    if (door.from.room === door.to.room && door.from.anchor === door.to.anchor && door.from.anchor) {
      fail(`doors[${index}]`, "a portal anchor cannot pair with itself");
    }
    const resolve = (side: "from" | "to", defaultAnchor: string): { room: z.output<typeof manorRoom>; anchorId: string } | null => {
      const endpoint = door[side];
      const room = roomSpecs.get(endpoint.room);
      if (!room) { fail(`doors[${index}].${side}.room`, `unknown room "${endpoint.room}"`); return null; }
      const anchors = extraAnchors.get(room.id)!;
      if (endpoint.anchor) {
        const declared = room.anchors[endpoint.anchor];
        if (!declared || declared.type !== "portal") {
          fail(`doors[${index}].${side}.anchor`, `room "${room.id}" has no portal anchor "${endpoint.anchor}" (declare it in rooms[].anchors with "type": "portal")`);
          return null;
        }
        if (usedPortalAnchors.has(`${room.id}/${endpoint.anchor}`)) {
          fail(`doors[${index}].${side}.anchor`, `portal anchor "${endpoint.anchor}" in "${room.id}" is already used by another door (one anchor, one door)`);
          return null;
        }
        usedPortalAnchors.add(`${room.id}/${endpoint.anchor}`);
        return { room, anchorId: endpoint.anchor };
      }
      if (anchors.has(defaultAnchor) || room.anchors[defaultAnchor] || RESERVED_ANCHORS.has(defaultAnchor)) {
        fail(`doors[${index}].${side}`, `anchor name "${defaultAnchor}" is already used in room "${room.id}"; give the door a distinct id`);
        return null;
      }
      anchors.set(defaultAnchor, { id: defaultAnchor, retired: false, x: endpoint.at!.x, y: endpoint.at!.y, role: "portal" });
      return { room, anchorId: defaultAnchor };
    };
    const from = resolve("from", id);
    const to = resolve("to", `${id}_back`);
    if (!from || !to) return;
    const fromLabel = door.label ?? `Go to ${to.room.name}`;
    const toLabel = door.reverseLabel ?? `Go to ${from.room.name}`;
    const fromRecord = manorPortalRecordId(from.room.id, from.anchorId);
    const toRecord = manorPortalRecordId(to.room.id, to.anchorId);
    const portal = (source: typeof from, dest: typeof to, self: string, other: string, label: string, enabled: boolean): InteriorPortal => ({
      id: self,
      retired: false,
      source: { kind: "room", roomId: source.room.id, anchorId: source.anchorId },
      destination: { kind: "room", roomId: dest.room.id, anchorId: dest.anchorId },
      sourceApproachAnchorId: source.anchorId,
      destinationArrivalAnchorId: dest.anchorId,
      reciprocalPortalId: other,
      conditions: ["always"],
      interactionLabel: label,
      presentation: "door",
      enabled
    });
    portals.push(portal(from, to, fromRecord, toRecord, fromLabel, !door.locked), portal(to, from, toRecord, fromRecord, toLabel, true));
    for (const [side, label] of [[from, fromLabel], [to, toLabel]] as const) {
      const anchor = extraAnchors.get(side.room.id)!.get(side.anchorId) ?? side.room.anchors[side.anchorId]!;
      clickAreas.get(side.room.id)!.push({
        id: `${side.anchorId}_click_area`,
        retired: false,
        polygon: square(anchor, CLICK_HALF_SIZE, side.room.width, side.room.height),
        target: { anchorId: side.anchorId },
        interactionLabel: label
      });
    }
    doorSummaries.push(`${id}  ${from.room.id}:${from.anchorId} <-> ${to.room.id}:${to.anchorId}${door.locked ? "  [locked from side A]" : ""}`);
  });
  spec.rooms.forEach((room, roomIndex) => {
    for (const [name, anchor] of Object.entries(room.anchors)) {
      if (anchor.type === "portal" && !usedPortalAnchors.has(`${room.id}/${name}`)) {
        fail(`rooms[${roomIndex}].anchors.${name}`, "portal anchor is not used by any door (reference it from doors[].from|to.anchor)");
      }
      if (anchor.type === "message" && !anchor.message) fail(`rooms[${roomIndex}].anchors.${name}.message`, "message anchors need message text");
      if (anchor.type !== "message" && anchor.message !== undefined) fail(`rooms[${roomIndex}].anchors.${name}.message`, "only message anchors carry text");
    }
  });

  /* ---- world exit and stations (entrance room) ---- */
  const exit = spec.exit ?? { x: MANOR_DOOR.x, y: MANOR_DOOR.y };
  const stationOverrides = spec.stations === false ? null : spec.stations;
  const stationEntries = !stationOverrides ? [] : MANOR_STATIONS.flatMap((station) => {
    const override = stationOverrides[station.kind];
    if (override === false) return [];
    const position = override ?? station.position;
    const dx = position.x - station.position.x;
    const dy = position.y - station.position.y;
    return [{ station, position, dx, dy }];
  });

  const rooms: InteriorRoom[] = spec.rooms.map((room) => {
    const isEntrance = room.id === entranceRoomId;
    const spawn = room.spawn ?? { x: room.width / 2, y: room.height - 154 };
    const anchors: InteriorAnchor[] = [
      { id: "spawn", retired: false, x: spawn.x, y: spawn.y, ...(spawn.facing !== undefined ? { facing: spawn.facing } : {}), role: "spawn" }
    ];
    for (const [name, anchor] of Object.entries(room.anchors)) {
      anchors.push({
        id: name, retired: false, x: anchor.x, y: anchor.y,
        ...(anchor.facing !== undefined ? { facing: anchor.facing } : {}),
        role: anchor.type,
        ...(anchor.message !== undefined ? { message: anchor.message } : {})
      });
    }
    anchors.push(...extraAnchors.get(room.id)!.values());
    const objects: InteriorObject[] = [];
    const rooms_clickAreas = [...clickAreas.get(room.id)!];
    if (isEntrance) {
      for (const { station, position, dx, dy } of stationEntries) {
        const anchorId = `station_${station.kind}`;
        const objectId = `manor_${station.kind}`;
        anchors.push({ id: anchorId, retired: false, x: position.x, y: position.y, role: "point" });
        objects.push(pointObject({ id: objectId, type: "station", name: station.name, anchorId, interactionRadius: station.radius, stationKind: station.kind }));
        rooms_clickAreas.push({
          id: `${objectId}_click_area`, retired: false,
          polygon: [
            { x: station.bounds.minX + dx, y: station.bounds.minY + dy }, { x: station.bounds.maxX + dx, y: station.bounds.minY + dy },
            { x: station.bounds.maxX + dx, y: station.bounds.maxY + dy }, { x: station.bounds.minX + dx, y: station.bounds.maxY + dy }
          ],
          target: { objectId }, interactionLabel: station.name
        });
      }
      anchors.push({ id: WORLD_EXIT_ANCHOR_ID, retired: false, x: exit.x, y: exit.y, role: "portal" });
      rooms_clickAreas.push({
        id: `${WORLD_EXIT_ANCHOR_ID}_click_area`, retired: false,
        polygon: square(exit, CLICK_HALF_SIZE, room.width, room.height),
        target: { anchorId: WORLD_EXIT_ANCHOR_ID }, interactionLabel: `Leave ${spec.manor.name}`
      });
      portals.push(worldExitPortal(room.id, WORLD_EXIT_ANCHOR_ID, manorPortalRecordId(room.id, WORLD_EXIT_ANCHOR_ID), `Exit ${spec.manor.name}`));
    }
    const floors = (room.floors ?? [{ polygon: insetRect(room.width, room.height) }]).map((floor, index) => ({
      id: floor.id ?? (index === 0 ? "floor" : `floor_${index + 1}`), retired: false, polygon: floor.polygon.map((p) => ({ ...p }))
    }));
    const themeId = spec.manor.theme.id ?? spaceId;
    return {
      id: room.id,
      revision: `${room.id}-v1`,
      retired: false,
      active: true,
      aliases: [],
      name: room.name,
      width: room.width,
      height: room.height,
      spawnAnchorId: "spawn",
      camera: { mode: "fixed_center", center: { x: room.width / 2, y: room.height / 2 }, fitPadding: 16, defaultZoom: 1, minZoom: 0.5, maxZoom: 1.6 },
      environment: { environmentId: themeId, musicAssetKey: null, ambienceAssetKey: null },
      floors,
      walls: room.walls.map((wall) => {
        const xs = wall.polygon.map((p) => p.x);
        const ys = wall.polygon.map((p) => p.y);
        const minX = Math.min(...xs); const minY = Math.min(...ys);
        const spanX = Math.max(...xs) - minX || 1; const spanY = Math.max(...ys) - minY || 1;
        return {
          id: wall.id, retired: false, kind: wall.kind,
          roomPolygon: wall.polygon.map((p) => ({ ...p })),
          imagePolygon: wall.image ?? wall.polygon.map((p) => ({ u: (p.x - minX) / spanX, v: (p.y - minY) / spanY })),
          transform: {
            offsetU: wall.transform?.offsetU ?? IDENTITY_TRANSFORM.offsetU,
            offsetV: wall.transform?.offsetV ?? IDENTITY_TRANSFORM.offsetV,
            scaleU: wall.transform?.scaleU ?? IDENTITY_TRANSFORM.scaleU,
            scaleV: wall.transform?.scaleV ?? IDENTITY_TRANSFORM.scaleV,
            rotationDeg: wall.transform?.rotationDeg ?? IDENTITY_TRANSFORM.rotationDeg
          }
        };
      }),
      colliders: room.colliders.map((collider): InteriorCollider => ({
        id: collider.id, retired: false, kind: "polygon",
        points: (collider.polygon ?? [
          { x: collider.rect!.x, y: collider.rect!.y }, { x: collider.rect!.x + collider.rect!.width, y: collider.rect!.y },
          { x: collider.rect!.x + collider.rect!.width, y: collider.rect!.y + collider.rect!.height }, { x: collider.rect!.x, y: collider.rect!.y + collider.rect!.height }
        ]).map((p) => ({ ...p }))
      })),
      zones: [],
      layers: { background: [], below_player: [], actors: [], above_player: [], ceiling: [] },
      anchors,
      clickAreas: rooms_clickAreas,
      objects,
      mobs: []
    };
  });

  if (issues.length > 0) throw new InteriorScaffoldError(issues);

  const theme = spec.manor.theme;
  const space: InteriorSpace = {
    id: spaceId,
    kind: "manor",
    revision: `${spaceId}-v1`,
    publishedRevisionId: `${spaceId}-r1`,
    retired: false,
    name: spec.manor.name,
    description: spec.manor.description ?? `${spec.manor.name} (manor interior).`,
    spatialProfileId: "standard_indoor",
    instancePolicy: "owner_persistent",
    defaultRoomId: entranceRoomId,
    environment: {
      environmentId: theme.id ?? spaceId,
      backgroundColor: theme.backgroundColor,
      floorColor: theme.floorColor,
      wallColor: theme.wallColor,
      floorAssetKey: theme.floorAssetKey,
      musicAssetKey: null,
      ambienceAssetKey: null
    },
    doorVisual: null,
    rooms,
    portals,
    modules: { decoration: { definitions: [], playerPlacement: { enabled: spec.manor.playerPlacement } } }
  };

  const stationKinds = stationEntries.map((entry) => entry.station.kind as InteriorStationKind);
  const lines = [
    `Manor "${space.name}" (${space.id}) - entrance room: ${entranceRoomId}`, "",
    `Rooms (${rooms.length})`,
    ...rooms.map((room) => `  ${room.id}  "${room.name}"  ${room.width}x${room.height}  floors ${room.floors.length}, walls ${room.walls.length}, colliders ${room.colliders.length}, anchors ${room.anchors.length}`),
    "", `Doors (${doorSummaries.length})`, ...doorSummaries.map((line) => `  ${line}`),
    "", `World exit: ${entranceRoomId}:${WORLD_EXIT_ANCHOR_ID} at (${Math.round(exit.x)}, ${Math.round(exit.y)}); arrival from the world uses that room's spawn`,
    `Stations in ${entranceRoomId}: ${stationKinds.length > 0 ? stationKinds.join(", ") : "none"}`,
    "", "Readiness: interior validation OK, Manor view parse OK",
    "", "Left for you",
    "  - Art: no floor art or wall PNGs are placed. Load them in the Interiors workspace (floor/wall surfaces, decorations).",
    "  - Decorations: none are defined; add decoration definitions and items in the Interiors workspace.",
    "  - Playtest: open Interiors -> Walk Test on each room, then Save to Worktree."
  ];
  return { space, summary: lines.join("\n") };
}
