import { DUNGEON_CATALOG, type DungeonCatalog, type DungeonRoomDefinition } from "../dungeonCatalog.js";
import { GREENHOUSE_PLANTER_INTERACTION_RADIUS, GREENHOUSE_TANK_INTERACTION_RADIUS } from "../greenhouse.js";
import {
  GREENHOUSE_STUDIO_CATALOG,
  type GreenhouseStudioCatalog,
  type GreenhouseStudioTouchArea
} from "../greenhouseStudio.js";
import { STANDARD_INDOOR_SPATIAL_PROFILE, isIndoorNavigationPointWalkable } from "../indoor.js";
import {
  MANOR_BREEDER,
  MANOR_BREEDER_INTERACTION_RADIUS,
  DEFAULT_MANOR_TYPE_ID,
  MANOR_DOOR,
  MANOR_JEWEL,
  MANOR_JEWEL_INTERACTION_RADIUS,
  MANOR_MAIN_ROOM,
  MANOR_SMITH,
  MANOR_SMITH_INTERACTION_RADIUS
} from "../manor.js";
import {
  DEFAULT_MANOR_TEMPLATE_CATALOG,
  type ManorRoomDefinition,
  type ManorTemplateCatalog,
  type ManorTemplateDefinition
} from "../manorTemplateCatalog.js";
import {
  SALON_CHAIR,
  SALON_CHAIR_APPROACH,
  SALON_CHAIR_INTERACTION_RADIUS,
  SALON_DOOR,
  SALON_MAIN_ROOM
} from "../salon.js";
import {
  INTERIOR_CATALOG_SCHEMA_VERSION,
  type InteriorAnchor,
  type InteriorCatalog,
  type InteriorClickArea,
  type InteriorLibrary,
  type InteriorObject,
  type InteriorPlacement,
  type InteriorPortal,
  type InteriorPrefab,
  type InteriorRoom,
  type InteriorSpace,
  type InteriorStationKind
} from "./interiorCatalog.js";
import { interiorNavigation } from "./interiorRoomRuntime.js";

/**
 * One-way transforms from the four legacy catalogs into interior spaces. Ids
 * are preserved exactly; only new records (floors for dungeon/salon rooms,
 * world-exit portals, station/chair objects, prefabs for catalogued art) get
 * new ids. Nothing here changes what a runtime uses yet.
 */

/** What a transform contributes to the shared library besides its spaces. */
export type InteriorLibraryContribution = Readonly<{
  prefabs: readonly InteriorPrefab[];
  rewardTables: InteriorLibrary["rewardTables"];
  rewardTableIds: readonly string[];
  bossTemplates: InteriorLibrary["bossTemplates"];
  bossTemplateIds: readonly string[];
  entrances: InteriorLibrary["entrances"];
}>;

export type InteriorTransformResult = Readonly<{
  spaces: InteriorSpace[];
  library: InteriorLibraryContribution;
}>;

const NO_LIBRARY: InteriorLibraryContribution = Object.freeze({
  prefabs: [], rewardTables: [], rewardTableIds: [], bossTemplates: [], bossTemplateIds: [], entrances: []
});

const WORLD_EXIT_ANCHOR_ID = "world_exit";
const WORLD_EXIT_CLICK_HALF_SIZE = 60;

function emptyLayers(): InteriorRoom["layers"] {
  return { background: [], below_player: [], actors: [], above_player: [], ceiling: [] };
}

function centeredCamera(width: number, height: number): InteriorRoom["camera"] {
  return {
    mode: "fixed_center",
    center: { x: width / 2, y: height / 2 },
    fitPadding: 16,
    defaultZoom: 1,
    minZoom: 0.5,
    maxZoom: 1.6
  };
}

function squareAround(x: number, y: number, half: number): { x: number; y: number }[] {
  return [
    { x: x - half, y: y - half }, { x: x + half, y: y - half },
    { x: x + half, y: y + half }, { x: x - half, y: y + half }
  ];
}

/** A rectangular floor inset by the player radius: the legacy "room bounds" walkable area. */
function insetFloorPolygon(width: number, height: number): { x: number; y: number }[] {
  const inset = STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius;
  return [
    { x: inset, y: inset }, { x: width - inset, y: inset },
    { x: width - inset, y: height - inset }, { x: inset, y: height - inset }
  ];
}

export function worldExitPortal(roomId: string, anchorId: string, portalId: string, label: string): InteriorPortal {
  return {
    id: portalId,
    retired: false,
    source: { kind: "room", roomId, anchorId },
    destination: { kind: "world" },
    sourceApproachAnchorId: anchorId,
    conditions: ["always"],
    interactionLabel: label,
    presentation: "door",
    enabled: true
  };
}

function prefab(input: {
  id: string;
  revision: string;
  name: string;
  type: InteriorPrefab["type"];
  assetKey: string;
  width: number;
  height: number;
  layer: InteriorPrefab["defaultLayerId"];
  pivotX?: number;
  pivotY?: number;
  footprint?: readonly { x: number; y: number }[];
  touchArea?: InteriorPrefab["touchArea"];
  interactionRadius?: number;
  renderMode?: InteriorPrefab["renderMode"];
}): InteriorPrefab {
  return {
    id: input.id,
    revision: input.revision,
    name: input.name,
    type: input.type,
    retired: false,
    defaultWidth: input.width,
    defaultHeight: input.height,
    defaultLayerId: input.layer,
    assetKey: input.assetKey,
    renderMode: input.renderMode ?? "sprite",
    // The catalogs do not record PNG pixel sizes; the authored render size is the stand-in.
    nativeWidth: Math.max(1, Math.round(input.width)),
    nativeHeight: Math.max(1, Math.round(input.height)),
    pivotX: input.pivotX ?? 0.5,
    pivotY: input.pivotY ?? 0.5,
    defaultOpacity: 1,
    defaultRotationDeg: 0,
    defaultFlipX: false,
    defaultFlipY: false,
    stateAssets: [],
    defaultColliders: [],
    ...(input.interactionRadius !== undefined ? { interactionRadius: input.interactionRadius } : {}),
    ...(input.footprint ? { footprint: input.footprint.map((point) => ({ ...point })) } : {}),
    ...(input.touchArea ? { touchArea: input.touchArea } : {})
  };
}

function placement(input: {
  id: string;
  prefabId: string;
  prefabRevision: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDeg?: number;
  flipX?: boolean;
  zIndex?: number;
}): InteriorPlacement {
  return {
    id: input.id,
    retired: false,
    prefabId: input.prefabId,
    prefabRevision: input.prefabRevision,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    rotationDeg: input.rotationDeg ?? 0,
    opacity: 1,
    flipX: input.flipX ?? false,
    flipY: false,
    zIndex: input.zIndex ?? 0
  };
}

export function pointObject(input: {
  id: string;
  type: InteriorObject["type"];
  name: string;
  anchorId: string;
  interactionRadius: number;
  prefabId?: string;
  prefabRevision?: string;
  approachAnchorId?: string;
  stationKind?: InteriorStationKind;
  interactionLabel?: string;
}): InteriorObject {
  return {
    id: input.id,
    retired: false,
    type: input.type,
    layerId: "actors",
    name: input.name,
    anchorId: input.anchorId,
    available: true,
    initialState: "idle",
    interactionRadius: input.interactionRadius,
    rotationDeg: 0,
    opacity: 1,
    flipX: false,
    flipY: false,
    zIndex: 0,
    ...(input.prefabId !== undefined ? { prefabId: input.prefabId } : {}),
    ...(input.prefabRevision !== undefined ? { prefabRevision: input.prefabRevision } : {}),
    ...(input.approachAnchorId !== undefined ? { approachAnchorId: input.approachAnchorId } : {}),
    ...(input.stationKind !== undefined ? { stationKind: input.stationKind } : {}),
    ...(input.interactionLabel !== undefined ? { interactionLabel: input.interactionLabel } : {})
  };
}

// ---------------------------------------------------------------------------
// Manor
// ---------------------------------------------------------------------------

/** Runtime portal id of an authored Manor portal record: `manor:<manorId>:room:<room>:<anchor>`. */
export function manorRuntimePortalId(manorId: string, portal: InteriorPortal): string {
  if (portal.source.kind !== "room") throw new Error(`Portal ${portal.id} has no source room`);
  return `manor:${manorId}:room:${portal.source.roomId}:${portal.source.anchorId}`;
}

/** Catalog id of the portal record sourced from a Manor room anchor. */
export function manorPortalRecordId(roomId: string, anchorId: string): string {
  return `${roomId}-${anchorId}`;
}

export type RectBounds = Readonly<{ minX: number; maxX: number; minY: number; maxY: number }>;

function rectBounds(collider: object): RectBounds {
  const { minX, maxX, minY, maxY } = collider as RectBounds;
  return { minX, maxX, minY, maxY };
}

export const MANOR_STATIONS: readonly Readonly<{
  kind: InteriorStationKind;
  name: string;
  position: { x: number; y: number };
  radius: number;
  bounds: RectBounds;
}>[] = [
  { kind: "smith", name: "Manor Smith", position: MANOR_SMITH, radius: MANOR_SMITH_INTERACTION_RADIUS, bounds: rectBounds(MANOR_MAIN_ROOM.fixtures.smith.collider) },
  { kind: "jewel", name: "Manor Jeweler", position: MANOR_JEWEL, radius: MANOR_JEWEL_INTERACTION_RADIUS, bounds: rectBounds(MANOR_MAIN_ROOM.fixtures.jewel.collider) },
  { kind: "breeder", name: "Manor Breeder", position: MANOR_BREEDER, radius: MANOR_BREEDER_INTERACTION_RADIUS, bounds: rectBounds(MANOR_MAIN_ROOM.fixtures.breeder.collider) }
];

export function fromManorTemplateCatalog(
  catalog: ManorTemplateCatalog = DEFAULT_MANOR_TEMPLATE_CATALOG
): InteriorTransformResult {
  const prefabs: InteriorPrefab[] = [];
  const spaces = catalog.templates.map((template) => manorSpace(template, prefabs, catalog.catalogRevision));
  return { spaces, library: { ...NO_LIBRARY, prefabs } };
}

function manorSpace(template: ManorTemplateDefinition, prefabs: InteriorPrefab[], catalogRevision: number): InteriorSpace {
  const roomById = new Map(template.rooms.map((room) => [room.id, room]));
  const portals: InteriorPortal[] = [];
  const rooms = template.rooms.map((room) => manorRoom(template, room, roomById, portals, prefabs));
  return {
    id: template.id,
    kind: "manor",
    revision: template.revision,
    publishedRevisionId: template.publishedRevisionId,
    catalogRevision,
    retired: template.retired,
    name: template.name,
    description: template.description,
    spatialProfileId: "standard_indoor",
    instancePolicy: "owner_persistent",
    defaultRoomId: template.defaultRoomId,
    environment: {
      environmentId: template.theme.themeId,
      backgroundColor: template.theme.backgroundColor,
      floorColor: template.theme.floorColor,
      wallColor: template.theme.wallColor,
      floorAssetKey: template.theme.floorAssetKey,
      musicAssetKey: null,
      ambienceAssetKey: null
    },
    doorVisual: template.doorVisual,
    rooms,
    portals,
    modules: {
      ...(template.exterior ? {
        manor: { exteriorAssetKey: template.exterior.assetKey, ...(template.exterior.scale !== 1 ? { exteriorScale: template.exterior.scale } : {}) }
      } : {}),
      decoration: {
        definitions: template.decorations.map((decoration) => ({ ...decoration })),
        playerPlacement: { enabled: true }
      }
    }
  };
}

/** The legacy surface order, recorded only when floors and walls are interleaved. */
function manorSurfaceOrder(room: ManorRoomDefinition): { surfaceOrder?: string[] } {
  const ids = room.placementSurfaces.map((surface) => surface.id);
  const defaultOrder = [
    ...room.placementSurfaces.filter((surface) => surface.kind === "floor"),
    ...room.placementSurfaces.filter((surface) => surface.kind !== "floor")
  ].map((surface) => surface.id);
  return ids.every((id, index) => id === defaultOrder[index]) ? {} : { surfaceOrder: ids };
}

function manorRoom(
  template: ManorTemplateDefinition,
  room: ManorRoomDefinition,
  roomById: ReadonlyMap<string, ManorRoomDefinition>,
  portals: InteriorPortal[],
  prefabs: InteriorPrefab[]
): InteriorRoom {
  const isEntrance = room.id === template.defaultRoomId;
  const anchors: InteriorAnchor[] = room.anchors.map((anchor) => ({
    id: anchor.id,
    retired: anchor.retired,
    x: anchor.x,
    y: anchor.y,
    ...(anchor.facing !== undefined ? { facing: anchor.facing } : {}),
    role: anchor.type,
    ...(anchor.message !== undefined ? { message: anchor.message } : {})
  }));
  const clickAreas: InteriorClickArea[] = room.portalHotspots.map((hotspot) => ({
    id: hotspot.id,
    retired: hotspot.retired,
    polygon: hotspot.polygon.map((point) => ({ ...point })),
    target: { anchorId: hotspot.anchorId },
    interactionLabel: hotspot.interactionLabel
  }));
  const objects: InteriorObject[] = [];

  for (const anchor of room.anchors) {
    if (anchor.type !== "portal" || !anchor.destinationRoomId || !anchor.destinationAnchorId) continue;
    const destinationRoom = roomById.get(anchor.destinationRoomId);
    const destinationAnchor = destinationRoom?.anchors.find((candidate) => candidate.id === anchor.destinationAnchorId);
    const hotspots = room.portalHotspots.filter((hotspot) => hotspot.anchorId === anchor.id);
    const label = (hotspots.find((hotspot) => !hotspot.retired) ?? hotspots[0])?.interactionLabel ?? anchor.id;
    const reciprocal = destinationAnchor && !destinationAnchor.retired && !anchor.retired &&
      destinationAnchor.destinationRoomId === room.id && destinationAnchor.destinationAnchorId === anchor.id
      ? manorPortalRecordId(destinationRoom!.id, destinationAnchor.id)
      : undefined;
    portals.push({
      id: manorPortalRecordId(room.id, anchor.id),
      retired: anchor.retired,
      source: { kind: "room", roomId: room.id, anchorId: anchor.id },
      destination: { kind: "room", roomId: anchor.destinationRoomId, anchorId: anchor.destinationAnchorId },
      sourceApproachAnchorId: anchor.id,
      destinationArrivalAnchorId: anchor.destinationAnchorId,
      ...(reciprocal ? { reciprocalPortalId: reciprocal } : {}),
      conditions: ["always"],
      interactionLabel: label,
      presentation: "door",
      enabled: anchor.locked !== true
    });
  }

  if (isEntrance) {
    // Stations become lobby objects with click areas over their fixture bounds.
    for (const station of MANOR_STATIONS) {
      const anchorId = `station_${station.kind}`;
      const objectId = `manor_${station.kind}`;
      anchors.push({ id: anchorId, retired: false, x: station.position.x, y: station.position.y, role: "point" });
      objects.push(pointObject({
        id: objectId, type: "station", name: station.name, anchorId,
        interactionRadius: station.radius, stationKind: station.kind
      }));
      clickAreas.push({
        id: `${objectId}_click_area`,
        retired: false,
        polygon: [
          { x: station.bounds.minX, y: station.bounds.minY }, { x: station.bounds.maxX, y: station.bounds.minY },
          { x: station.bounds.maxX, y: station.bounds.maxY }, { x: station.bounds.minX, y: station.bounds.maxY }
        ],
        target: { objectId },
        interactionLabel: station.name
      });
    }
  }
  if (room.worldExit || isEntrance) {
    // The authored world exit (legacy templates: the old self-click door coordinate).
    const exit = room.worldExit ?? {
      anchorId: WORLD_EXIT_ANCHOR_ID, x: MANOR_DOOR.x, y: MANOR_DOOR.y, interactionLabel: "Leave Manor", polygon: null
    };
    anchors.push({ id: exit.anchorId, retired: false, x: exit.x, y: exit.y, role: "portal" });
    clickAreas.push({
      id: `${exit.anchorId}_click_area`,
      retired: false,
      polygon: exit.polygon?.map((point) => ({ ...point })) ?? squareAround(exit.x, exit.y, WORLD_EXIT_CLICK_HALF_SIZE),
      target: { anchorId: exit.anchorId },
      interactionLabel: exit.interactionLabel
    });
    portals.push(worldExitPortal(
      room.id, exit.anchorId, manorPortalRecordId(room.id, exit.anchorId), "Exit Manor"
    ));
  }

  const layers = emptyLayers();
  const floorArt = room.floorAssetKey ?? (isEntrance ? template.theme.floorAssetKey : undefined);
  if (floorArt) {
    const prefabId = room.floorAssetKey ? `${room.id}_floor_art` : `${template.id}_theme_floor`;
    if (!prefabs.some((candidate) => candidate.id === prefabId)) {
      prefabs.push(prefab({
        id: prefabId, revision: template.revision, name: `${room.name} floor`, type: "surface",
        assetKey: floorArt, width: room.width, height: room.height, layer: "background", renderMode: "stretch"
      }));
    }
    layers.background.push(placement({
      id: `${room.id}_floor_art`, prefabId, prefabRevision: template.revision,
      x: 0, y: 0, width: room.width, height: room.height
    }));
  }

  return {
    id: room.id,
    revision: room.revision,
    retired: room.retired,
    active: room.active,
    aliases: isEntrance && template.id === DEFAULT_MANOR_TYPE_ID ? [MANOR_MAIN_ROOM.spaceId] : [],
    name: room.name,
    width: room.width,
    height: room.height,
    spawnAnchorId: room.spawnAnchorId,
    camera: room.camera,
    environment: {
      environmentId: room.themeId,
      musicAssetKey: null,
      ambienceAssetKey: null
    },
    floors: room.placementSurfaces.flatMap((surface) => surface.kind === "floor"
      ? [{ id: surface.id, retired: surface.retired, polygon: surface.polygon.map((point) => ({ ...point })) }]
      : []),
    walls: room.placementSurfaces.flatMap((surface) => surface.kind === "floor" ? [] : [{
      id: surface.id,
      retired: surface.retired,
      kind: surface.kind,
      roomPolygon: surface.roomPolygon.map((point) => ({ ...point })),
      imagePolygon: surface.imagePolygon.map((point) => ({ ...point })),
      transform: { ...surface.transform }
    }]),
    ...manorSurfaceOrder(room),
    colliders: room.colliders.map((collider) => ({
      id: collider.id, retired: collider.retired, kind: "polygon" as const,
      points: collider.points.map((point) => ({ ...point }))
    })),
    zones: [],
    layers,
    anchors,
    clickAreas,
    objects,
    mobs: []
  };
}

// ---------------------------------------------------------------------------
// Dungeon
// ---------------------------------------------------------------------------

export function fromDungeonCatalog(catalog: DungeonCatalog = DUNGEON_CATALOG): InteriorTransformResult {
  return {
    spaces: catalog.dungeons.map((dungeon): InteriorSpace => ({
      id: dungeon.id,
      kind: "dungeon",
      revision: dungeon.revision,
      retired: dungeon.retired,
      name: dungeon.name,
      description: dungeon.description,
      spatialProfileId: "dungeon",
      instancePolicy: dungeon.instancePolicy,
      defaultRoomId: dungeon.entrance.roomId,
      environment: { ...dungeon.environment },
      rooms: dungeon.rooms.map((room) => dungeonRoom(dungeon.revision, dungeon.portals, room)),
      portals: dungeon.portals.map((portal) => ({ ...portal })),
      modules: {
        entrance: dungeon.entrance,
        encounters: dungeon.encounters,
        triggers: dungeon.triggers,
        reset: dungeon.reset,
        escape: dungeon.escape,
        deathRecovery: dungeon.deathRecovery,
        rewardTableIds: dungeon.rewardTableIds,
        bossTemplateIds: dungeon.bossTemplateIds,
        ...(dungeon.access ? { access: dungeon.access } : {}),
        ...(dungeon.tier ? { tier: dungeon.tier } : {}),
        ...(dungeon.runRolls ? { runRolls: dungeon.runRolls } : {})
      }
    })),
    library: {
      prefabs: catalog.prefabs.map((entry) => ({ ...entry })),
      rewardTables: catalog.rewardTables,
      rewardTableIds: catalog.rewardTableIds,
      bossTemplates: catalog.bossTemplates,
      bossTemplateIds: catalog.bossTemplateIds,
      entrances: catalog.entrances
    }
  };
}

function dungeonRoom(
  revision: string,
  portals: DungeonCatalog["dungeons"][number]["portals"],
  room: DungeonRoomDefinition
): InteriorRoom {
  const portalAnchors = new Set<string>();
  for (const portal of portals) {
    for (const endpoint of [portal.source, portal.destination]) {
      if (endpoint.kind === "room" && endpoint.roomId === room.id) portalAnchors.add(endpoint.anchorId);
    }
  }
  for (const object of room.objects) {
    if (object.type === "portal") portalAnchors.add(object.anchorId);
  }
  return {
    id: room.id,
    revision,
    retired: room.retired,
    active: room.active,
    aliases: [],
    name: room.name,
    width: room.width,
    height: room.height,
    spawnAnchorId: room.spawnAnchorId,
    camera: room.camera,
    environment: room.environment,
    floors: room.floors
      ? room.floors.map((floor) => ({ id: floor.id, retired: floor.retired, polygon: floor.polygon }))
      : [{ id: "floor", retired: false, polygon: insetFloorPolygon(room.width, room.height) }],
    walls: [],
    colliders: room.colliders,
    zones: room.zones,
    layers: room.layers,
    anchors: room.anchors.map((anchor) => ({
      id: anchor.id,
      retired: anchor.retired,
      x: anchor.x,
      y: anchor.y,
      ...(anchor.facing !== undefined ? { facing: anchor.facing } : {}),
      role: anchor.id === room.spawnAnchorId ? "spawn" as const
        : portalAnchors.has(anchor.id) ? "portal" as const : "point" as const
    })),
    clickAreas: [],
    objects: room.objects,
    mobs: room.mobs,
    ...(room.resourceSpawnZones ? { resourceSpawnZones: room.resourceSpawnZones } : {}),
    ...(room.resourceNodes ? { resourceNodes: room.resourceNodes } : {})
  };
}

// ---------------------------------------------------------------------------
// Greenhouse
// ---------------------------------------------------------------------------

function touchRadius(touchArea: GreenhouseStudioTouchArea): number {
  return touchArea.kind === "circle"
    ? touchArea.radius
    : Math.max(...touchArea.points.map((point) => Math.hypot(point.x, point.y)));
}

function touchAreaOf(touchArea: GreenhouseStudioTouchArea): NonNullable<InteriorPrefab["touchArea"]> {
  return touchArea.kind === "circle"
    ? { kind: "circle", radius: touchArea.radius }
    : { kind: "polygon", points: touchArea.points.map((point) => ({ ...point })) };
}

function circlePolygon(x: number, y: number, radius: number, sides = 16): { x: number; y: number }[] {
  return Array.from({ length: sides }, (_, index) => {
    const angle = index / sides * Math.PI * 2;
    return { x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius };
  });
}

/** A prefab touch area (local to its anchor) placed at a room position, as a room-space polygon. */
function touchPolygonAt(touchArea: GreenhouseStudioTouchArea, x: number, y: number): { x: number; y: number }[] {
  return touchArea.kind === "circle"
    ? circlePolygon(x, y, touchArea.radius)
    : touchArea.points.map((point) => ({ x: x + point.x, y: y + point.y }));
}

export function fromGreenhouseStudioCatalog(
  catalog: GreenhouseStudioCatalog = GREENHOUSE_STUDIO_CATALOG
): InteriorTransformResult {
  const { geometry } = catalog;
  const revision = `greenhouse-r${catalog.catalogRevision}`;
  const roomId = catalog.roomId;
  const width = catalog.roomWidth;
  const height = catalog.roomHeight;

  const floors = geometry.surfaces.flatMap((surface) => surface.kind === "floor"
    ? [{ id: surface.surfaceId, retired: false, polygon: surface.points.map((point) => ({ ...point })) }]
    : []);
  const walls = geometry.surfaces.flatMap((surface) => {
    if (surface.kind === "floor") return [];
    // Studio walls carry no UV mapping; use the polygon's own normalized bounds.
    const minX = Math.min(...surface.points.map((point) => point.x));
    const maxX = Math.max(...surface.points.map((point) => point.x));
    const minY = Math.min(...surface.points.map((point) => point.y));
    const maxY = Math.max(...surface.points.map((point) => point.y));
    return [{
      id: surface.surfaceId,
      retired: false,
      kind: surface.kind,
      roomPolygon: surface.points.map((point) => ({ ...point })),
      imagePolygon: surface.points.map((point) => ({
        u: maxX === minX ? 0 : (point.x - minX) / (maxX - minX),
        v: maxY === minY ? 0 : (point.y - minY) / (maxY - minY)
      })),
      transform: { offsetU: 0, offsetV: 0, scaleU: 1, scaleV: 1, rotationDeg: 0 }
    }];
  });
  const colliders = geometry.colliders.map((collider) => ({
    id: collider.colliderId,
    retired: false,
    kind: "polygon" as const,
    points: collider.points.map((point) => ({ ...point }))
  }));

  // Same candidate order the greenhouse runtime uses for its safe spawn.
  const navigation = interiorNavigation({ width, height, colliders, floors });
  const spawn = [
    { x: width / 2, y: height * 0.8 },
    { x: width / 2, y: height / 2 },
    ...(floors[0]?.polygon ?? [])
  ].find((candidate) => isIndoorNavigationPointWalkable(navigation, candidate)) ?? { x: width / 2, y: height / 2 };

  const exit = geometry.exit;
  const anchors: InteriorAnchor[] = [
    { id: "spawn", retired: false, x: spawn.x, y: spawn.y, role: "spawn" },
    { id: exit.anchorId, retired: false, x: exit.x, y: exit.y, role: "portal" },
    { id: catalog.waterStorage.anchorId, retired: false, x: catalog.waterStorage.x, y: catalog.waterStorage.y, role: "point" },
    ...catalog.anchors.map((anchor): InteriorAnchor => ({
      id: anchor.anchorId, retired: false, x: anchor.x, y: anchor.y, role: "point"
    }))
  ];

  const potTemplate = geometry.templates.pot;
  const tankTemplate = geometry.templates.waterTank;
  const prefabs: InteriorPrefab[] = [
    prefab({
      id: "greenhouse_pot", revision, name: "Greenhouse pot", type: "object", assetKey: potTemplate.assetPath,
      width: potTemplate.renderWidth, height: potTemplate.renderHeight, layer: "actors",
      pivotX: potTemplate.pivotX, pivotY: potTemplate.pivotY, footprint: potTemplate.physicalFootprint,
      touchArea: touchAreaOf(potTemplate.touchArea), interactionRadius: touchRadius(potTemplate.touchArea)
    }),
    prefab({
      id: "greenhouse_water_tank", revision, name: "Greenhouse water tank", type: "object", assetKey: tankTemplate.assetPath,
      width: tankTemplate.renderWidth, height: tankTemplate.renderHeight, layer: "actors",
      pivotX: tankTemplate.pivotX, pivotY: tankTemplate.pivotY, footprint: tankTemplate.physicalFootprint,
      touchArea: touchAreaOf(tankTemplate.touchArea), interactionRadius: touchRadius(tankTemplate.touchArea)
    }),
    prefab({
      id: "greenhouse_water_tank_art", revision, name: "Greenhouse water tank art", type: "decoration",
      assetKey: catalog.waterStorageArt.assetPath, width: catalog.waterStorageArt.width,
      height: catalog.waterStorageArt.height, layer: "actors"
    }),
    prefab({
      id: "greenhouse_door", revision, name: "Greenhouse door", type: "decoration", assetKey: exit.assetPath,
      width: exit.renderWidth, height: exit.renderHeight, layer: "below_player", pivotX: exit.pivotX, pivotY: exit.pivotY
    })
  ];

  const layers = emptyLayers();
  layers.below_player.push(placement({
    id: `${exit.anchorId}-art`, prefabId: "greenhouse_door", prefabRevision: revision,
    x: exit.x - exit.pivotX * exit.renderWidth, y: exit.y - exit.pivotY * exit.renderHeight,
    width: exit.renderWidth, height: exit.renderHeight
  }));
  const tankArt = catalog.waterStorageArt;
  layers.actors.push(placement({
    id: tankArt.overlayId, prefabId: "greenhouse_water_tank_art", prefabRevision: revision,
    x: tankArt.x, y: tankArt.y, width: tankArt.width * Math.abs(tankArt.scaleX),
    height: tankArt.height * Math.abs(tankArt.scaleY), rotationDeg: tankArt.rotationDeg,
    flipX: tankArt.scaleX < 0, zIndex: tankArt.zIndex
  }));
  for (const overlay of catalog.overlays) {
    const stem = overlay.assetPath.split("/").at(-1)!.replace(/\.png$/u, "");
    const prefabId = `greenhouse-${stem}`;
    if (!prefabs.some((candidate) => candidate.id === prefabId)) {
      prefabs.push(prefab({
        id: prefabId, revision, name: `Greenhouse ${stem}`, type: "decoration", assetKey: overlay.assetPath,
        width: overlay.width, height: overlay.height, layer: "above_player"
      }));
    }
    layers.above_player.push(placement({
      id: overlay.overlayId, prefabId, prefabRevision: revision, x: overlay.x, y: overlay.y,
      width: overlay.width * Math.abs(overlay.scaleX), height: overlay.height * Math.abs(overlay.scaleY),
      rotationDeg: overlay.rotationDeg, flipX: overlay.scaleX < 0, zIndex: overlay.zIndex
    }));
  }

  const exitPolygon = exit.touchArea.kind === "polygon"
    ? exit.touchArea.points.map((point) => ({ ...point }))
    : circlePolygon(exit.x, exit.y, exit.touchArea.radius);
  const tankObjectId = `greenhouse-water-tank:${roomId}`;

  const room: InteriorRoom = {
    id: roomId,
    revision,
    retired: false,
    active: true,
    aliases: [],
    name: "Greenhouse",
    width,
    height,
    spawnAnchorId: "spawn",
    camera: centeredCamera(width, height),
    environment: { environmentId: "greenhouse", musicAssetKey: null, ambienceAssetKey: null },
    floors,
    walls,
    colliders,
    zones: [],
    layers,
    anchors,
    clickAreas: [{
      id: `greenhouse-exit-touch:${roomId}`,
      retired: false,
      polygon: exitPolygon,
      target: { anchorId: exit.anchorId },
      interactionLabel: "Exit Greenhouse"
    }, {
      id: `greenhouse-water-tank-touch:${roomId}`,
      retired: false,
      polygon: touchPolygonAt(tankTemplate.touchArea, catalog.waterStorage.x, catalog.waterStorage.y),
      target: { objectId: tankObjectId },
      interactionLabel: "Water tank"
    }],
    objects: [
      pointObject({
        id: tankObjectId, type: "water_tank", name: "Water tank", anchorId: catalog.waterStorage.anchorId,
        interactionRadius: GREENHOUSE_TANK_INTERACTION_RADIUS, prefabId: "greenhouse_water_tank", prefabRevision: revision
      }),
      // The authored starting Farm Plots. Player-placed pots use the same pot prefab at runtime coordinates.
      ...catalog.anchors.map((anchor) => pointObject({
        id: `greenhouse-planter:${anchor.anchorId}`, type: "planter", name: "Farm Plot", anchorId: anchor.anchorId,
        interactionRadius: GREENHOUSE_PLANTER_INTERACTION_RADIUS, prefabId: "greenhouse_pot", prefabRevision: revision
      }))
    ],
    mobs: []
  };

  return {
    spaces: [{
      id: "greenhouse",
      kind: "greenhouse",
      revision,
      retired: false,
      name: "Greenhouse",
      description: "The Studio-authored greenhouse room.",
      spatialProfileId: "standard_indoor",
      instancePolicy: "owner_persistent",
      defaultRoomId: roomId,
      environment: { environmentId: "greenhouse", musicAssetKey: null, ambienceAssetKey: null },
      rooms: [room],
      portals: [worldExitPortal(roomId, exit.anchorId, `greenhouse-exit-portal:${roomId}`, "Exit Greenhouse")],
      modules: {
        planters: {
          capacity: catalog.planterCapacity,
          potPrefabId: "greenhouse_pot",
          stageArt: geometry.stageArt.map((art) => ({
            cropId: art.cropId, stage: art.stage, artId: art.artId, assetKey: art.assetPath,
            pivotX: art.pivotX, pivotY: art.pivotY, offsetX: art.offsetX, offsetY: art.offsetY, scale: art.scale
          }))
        }
      }
    }],
    library: { ...NO_LIBRARY, prefabs }
  };
}

// ---------------------------------------------------------------------------
// Salon
// ---------------------------------------------------------------------------

/** Author the Salon (1000x1000 standard profile) from the `shared/salon.ts` constants. */
export function salonSpace(): InteriorSpace {
  const room = SALON_MAIN_ROOM;
  const roomId = room.spaceId;
  const revision = "salon-v1";
  const chairBounds = rectBounds(room.fixtures.chair.collider);
  return {
    id: "salon",
    kind: "salon",
    revision,
    retired: false,
    name: "Salon",
    description: "The hair and beard salon.",
    spatialProfileId: "standard_indoor",
    instancePolicy: "shared_persistent",
    defaultRoomId: roomId,
    environment: { environmentId: "salon", musicAssetKey: null, ambienceAssetKey: null },
    rooms: [{
      id: roomId,
      revision,
      retired: false,
      active: true,
      aliases: [],
      name: "Salon",
      width: room.roomWidth,
      height: room.roomHeight,
      spawnAnchorId: "spawn",
      camera: centeredCamera(room.roomWidth, room.roomHeight),
      environment: { environmentId: "salon", musicAssetKey: null, ambienceAssetKey: null },
      floors: [{ id: "floor", retired: false, polygon: insetFloorPolygon(room.roomWidth, room.roomHeight) }],
      walls: [],
      colliders: room.colliders.map((collider) => {
        const box = rectBounds(collider);
        return {
          id: collider.id, retired: false, kind: "rectangle" as const,
          x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY
        };
      }),
      zones: [],
      layers: emptyLayers(),
      anchors: [
        { id: "spawn", retired: false, x: room.spawn.x, y: room.spawn.y, role: "spawn" },
        { id: "chair", retired: false, x: SALON_CHAIR.x, y: SALON_CHAIR.y, role: "point" },
        { id: "chair_approach", retired: false, x: SALON_CHAIR_APPROACH.x, y: SALON_CHAIR_APPROACH.y, role: "point" },
        { id: WORLD_EXIT_ANCHOR_ID, retired: false, x: SALON_DOOR.x, y: SALON_DOOR.y, role: "portal" }
      ],
      clickAreas: [
        {
          id: "salon_chair_click_area",
          retired: false,
          polygon: [
            { x: chairBounds.minX, y: chairBounds.minY }, { x: chairBounds.maxX, y: chairBounds.minY },
            { x: chairBounds.maxX, y: chairBounds.maxY }, { x: chairBounds.minX, y: chairBounds.maxY }
          ],
          target: { objectId: "salon_chair" },
          interactionLabel: "Salon chair"
        },
        {
          id: `${WORLD_EXIT_ANCHOR_ID}_click_area`,
          retired: false,
          polygon: squareAround(SALON_DOOR.x, SALON_DOOR.y, WORLD_EXIT_CLICK_HALF_SIZE),
          target: { anchorId: WORLD_EXIT_ANCHOR_ID },
          interactionLabel: "Leave Salon"
        }
      ],
      objects: [pointObject({
        id: "salon_chair", type: "salon_chair", name: "Salon chair", anchorId: "chair",
        interactionRadius: SALON_CHAIR_INTERACTION_RADIUS, approachAnchorId: "chair_approach"
      })],
      mobs: []
    }],
    portals: [worldExitPortal(roomId, WORLD_EXIT_ANCHOR_ID, `${roomId}-${WORLD_EXIT_ANCHOR_ID}`, "Exit Salon")],
    modules: { salon: {} }
  };
}

// ---------------------------------------------------------------------------
// Whole catalog
// ---------------------------------------------------------------------------

/** Merge library contributions, rejecting two different records that share an id. */
export function mergeInteriorLibrary(
  contributions: readonly InteriorLibraryContribution[],
  catalogRevision = 1
): InteriorLibrary {
  const merge = <T extends { id: string }>(pick: (part: InteriorLibraryContribution) => readonly T[]): T[] => {
    const byId = new Map<string, T>();
    for (const part of contributions) {
      for (const entry of pick(part)) {
        const existing = byId.get(entry.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
          throw new Error(`Interior library id ${entry.id} is defined twice with different content`);
        }
        byId.set(entry.id, entry);
      }
    }
    return [...byId.values()];
  };
  const ids = (pick: (part: InteriorLibraryContribution) => readonly string[]): string[] =>
    [...new Set(contributions.flatMap((part) => pick(part)))];
  return {
    schemaVersion: INTERIOR_CATALOG_SCHEMA_VERSION,
    catalogRevision,
    prefabs: merge((part) => part.prefabs),
    rewardTables: merge((part) => part.rewardTables),
    rewardTableIds: ids((part) => part.rewardTableIds),
    bossTemplates: merge((part) => part.bossTemplates),
    bossTemplateIds: ids((part) => part.bossTemplateIds),
    entrances: merge((part) => part.entrances)
  };
}

/** All four legacy catalogs as one interior catalog (Manor, dungeons, Greenhouse, Salon). */
export function interiorCatalogFromLegacy(): InteriorCatalog {
  const parts = [
    fromManorTemplateCatalog(),
    fromDungeonCatalog(),
    fromGreenhouseStudioCatalog(),
    { spaces: [salonSpace()], library: NO_LIBRARY }
  ];
  return {
    library: mergeInteriorLibrary(parts.map((part) => part.library)),
    spaces: parts.flatMap((part) => part.spaces)
  };
}
