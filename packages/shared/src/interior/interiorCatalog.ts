import { z } from "zod";

import {
  dungeonCatalogSchemaParts as D,
  dungeonCatalogValidationIssues,
  dungeonPrefabDefinitionSchema
} from "../dungeonCatalog.js";
import { findIndoorNavigationRoute, isIndoorNavigationPointWalkable } from "../indoor.js";
import {
  manorPolygonGeometryIssues,
  manorTemplateSchemaParts as M
} from "../manorTemplateCatalog.js";
import { dungeonCatalogFromInterior } from "./dungeonView.js";
import { interiorNavigation } from "./interiorRoomRuntime.js";

export const INTERIOR_CATALOG_SCHEMA_VERSION = 1 as const;

/**
 * Interior ids are the union of every legacy id alphabet: Manor and dungeon ids
 * are `snake-case`, Greenhouse ids carry `:` separators
 * (`greenhouse-main-anchor:greenhouse_main_room:0:0`). Ids are preserved
 * exactly, so the schema has to accept all of them.
 */
export const interiorIdSchema = z.string().regex(
  /^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/u,
  "must be a safe lowercase ID"
);
const id = interiorIdSchema;
const finiteNumber = z.number().finite();
const pointSchema = z.object({ x: finiteNumber, y: finiteNumber }).strict();
const polygonPointsSchema = z.array(pointSchema).min(3);
const revisionSchema = z.string().min(1);

export const INTERIOR_SPACE_KINDS = ["manor", "dungeon", "greenhouse", "salon"] as const;
export type InteriorSpaceKind = (typeof INTERIOR_SPACE_KINDS)[number];
export const INTERIOR_SPATIAL_PROFILE_IDS = ["dungeon", "standard_indoor"] as const;
export const INTERIOR_ANCHOR_ROLES = ["spawn", "portal", "message", "point"] as const;
export type InteriorAnchorRole = (typeof INTERIOR_ANCHOR_ROLES)[number];
export const INTERIOR_STATION_KINDS = ["chest", "smith", "jewel", "breeder"] as const;
export type InteriorStationKind = (typeof INTERIOR_STATION_KINDS)[number];

const anchorSchema = z.object({
  id,
  retired: z.boolean(),
  x: finiteNumber,
  y: finiteNumber,
  facing: finiteNumber.optional(),
  role: z.enum(INTERIOR_ANCHOR_ROLES),
  message: z.string().trim().min(1).max(240).optional(),
  /** Studio-only display name ("Left door", "Stairs"); the game ignores it. */
  name: z.string().trim().min(1).max(40).optional()
}).strict();

const floorSchema = z.object({
  id,
  retired: z.boolean(),
  polygon: polygonPointsSchema
}).strict();

const wallSchema = z.object({
  id,
  retired: z.boolean(),
  kind: z.enum(["back_wall", "left_wall", "right_wall"]),
  roomPolygon: polygonPointsSchema,
  imagePolygon: z.array(M.uvPointSchema).min(3),
  transform: M.transformSchema
}).strict();

const rectangleColliderSchema = D.rectangleColliderSchema.extend({ id }).strict();
const polygonColliderSchema = D.polygonColliderSchema.extend({ id }).strict();
const colliderSchema = z.discriminatedUnion("kind", [rectangleColliderSchema, polygonColliderSchema]);
const zoneSchema = z.discriminatedUnion("kind", [
  rectangleColliderSchema.extend({ purpose: D.zonePurposeSchema }).strict(),
  polygonColliderSchema.extend({ purpose: D.zonePurposeSchema }).strict()
]);

const placementSchema = D.layerPlacementSchema.extend({ id, prefabId: id }).strict();
const layersSchema = z.object({
  background: z.array(placementSchema),
  below_player: z.array(placementSchema),
  actors: z.array(placementSchema),
  above_player: z.array(placementSchema),
  ceiling: z.array(placementSchema)
}).strict();

const clickAreaSchema = z.object({
  id,
  retired: z.boolean(),
  polygon: polygonPointsSchema,
  target: z.union([
    z.object({ anchorId: id }).strict(),
    z.object({ objectId: id }).strict()
  ]),
  interactionLabel: z.string().min(1)
}).strict();

const dungeonObjectTypes = D.objectSchema.shape.type.options;
export const INTERIOR_OBJECT_TYPES = [
  ...dungeonObjectTypes, "station", "planter", "water_tank", "salon_chair"
] as const;
/** Object types that are allowed to omit prefab art (their art is not catalogued yet). */
const PREFAB_OPTIONAL_OBJECT_TYPES: ReadonlySet<string> = new Set(["station", "salon_chair"]);
/** Object types that may sit on a `portal` role anchor. */
const PORTAL_ANCHOR_OBJECT_TYPES: ReadonlySet<string> = new Set([
  "portal", "door", "ladder", "exit_ladder"
]);

const objectSchema = D.objectSchema.extend({
  id,
  type: z.enum(INTERIOR_OBJECT_TYPES),
  anchorId: id,
  prefabId: id.optional(),
  prefabRevision: revisionSchema.optional(),
  portalId: id.optional(),
  /** Where the player stands to use the object (Salon chair approach, station approach). */
  approachAnchorId: id.optional(),
  stationKind: z.enum(INTERIOR_STATION_KINDS).optional()
}).strict();

const roomEndpointSchema = z.object({ kind: z.literal("room"), roomId: id, anchorId: id }).strict();
const portalSchema = D.portalSchema.extend({
  id,
  source: z.union([roomEndpointSchema, D.worldEndpointSchema]),
  destination: z.union([roomEndpointSchema, D.worldEndpointSchema]),
  sourceApproachAnchorId: id.optional(),
  sourceThresholdAnchorId: id.optional(),
  destinationArrivalAnchorId: id.optional(),
  reciprocalPortalId: id.optional()
}).strict();

const roomSchema = z.object({
  id,
  revision: revisionSchema,
  retired: z.boolean(),
  active: z.boolean(),
  /** Legacy ids that resolve to this room (`manor_main_room` -> `manor_lobby_room`). */
  aliases: z.array(id),
  name: z.string().min(1),
  width: finiteNumber.positive(),
  height: finiteNumber.positive(),
  spawnAnchorId: id,
  camera: D.cameraSchema,
  environment: D.roomEnvironmentSchema,
  floors: z.array(floorSchema),
  walls: z.array(wallSchema),
  /** Legacy Manor `placementSurfaces` order (floor and wall ids), kept only when it differs from floors-then-walls. */
  surfaceOrder: z.array(id).optional(),
  colliders: z.array(colliderSchema),
  zones: z.array(zoneSchema),
  layers: layersSchema,
  anchors: z.array(anchorSchema),
  clickAreas: z.array(clickAreaSchema),
  objects: z.array(objectSchema),
  mobs: z.array(D.mobPlacementSchema),
  resourceSpawnZones: z.array(D.dungeonResourceSpawnZoneSchema).optional(),
  resourceNodes: z.array(D.dungeonResourceNodeSchema).optional()
}).strict();

const stageArtSchema = z.object({
  cropId: z.string().min(1),
  stage: z.number().int().min(1).max(4),
  artId: z.string().min(1),
  assetKey: M.assetKeySchema,
  pivotX: finiteNumber.min(0).max(1),
  pivotY: finiteNumber.min(0).max(1),
  offsetX: finiteNumber,
  offsetY: finiteNumber,
  scale: finiteNumber.positive()
}).strict();

const dungeonShape = D.dungeonSchema.shape;
const modulesSchema = z.object({
  // Dungeon-only.
  entrance: dungeonShape.entrance.optional(),
  encounters: z.array(D.encounterSchema).optional(),
  triggers: dungeonShape.triggers.optional(),
  reset: dungeonShape.reset.optional(),
  escape: dungeonShape.escape.optional(),
  deathRecovery: dungeonShape.deathRecovery.optional(),
  access: dungeonShape.access,
  tier: dungeonShape.tier,
  runRolls: dungeonShape.runRolls,
  rewardTableIds: z.array(id).optional(),
  bossTemplateIds: z.array(id).optional(),
  // Manor-only: the overworld building art of this Manor type.
  manor: z.object({
    exteriorAssetKey: M.assetKeySchema,
    /** Multiplier on the shared Manor overworld size (1 = the timber Manor size). */
    exteriorScale: finiteNumber.min(0.25).max(4).optional(),
    /** Glimmer price of this type's skin item (default 500). */
    skinPriceGlimmer: z.number().int().min(1).max(1_000_000).optional()
  }).strict().optional(),
  // Manor-only.
  decoration: z.object({
    definitions: z.array(M.decorationSchema),
    playerPlacement: z.object({ enabled: z.boolean() }).strict()
  }).strict().optional(),
  // Greenhouse-only.
  planters: z.object({
    capacity: z.number().int().positive(),
    potPrefabId: id,
    stageArt: z.array(stageArtSchema)
  }).strict().optional(),
  // Salon-only.
  salon: z.object({}).strict().optional()
}).strict();

const spaceEnvironmentSchema = z.object({
  environmentId: id,
  backgroundColor: M.colorSchema.optional(),
  floorColor: M.colorSchema.optional(),
  wallColor: M.colorSchema.optional(),
  accentColor: M.colorSchema.optional(),
  floorAssetKey: M.assetKeySchema.optional(),
  musicAssetKey: z.string().min(1).nullable(),
  ambienceAssetKey: z.string().min(1).nullable()
}).strict();

export const INTERIOR_INSTANCE_POLICIES = [
  "shared_persistent", "party_ephemeral", "solo_ephemeral", "owner_persistent"
] as const;

export const interiorSpaceSchema = z.object({
  id,
  kind: z.enum(INTERIOR_SPACE_KINDS),
  revision: revisionSchema,
  /** Manor templates carry a separate published revision identity. */
  publishedRevisionId: id.optional(),
  /** Manor Studio publish counter (the Manor catalog view's `catalogRevision` is the highest of its spaces). */
  catalogRevision: z.number().int().nonnegative().optional(),
  retired: z.boolean(),
  name: z.string().min(1),
  description: z.string().min(1),
  spatialProfileId: z.enum(INTERIOR_SPATIAL_PROFILE_IDS),
  instancePolicy: z.enum(INTERIOR_INSTANCE_POLICIES),
  defaultRoomId: id,
  environment: spaceEnvironmentSchema,
  doorVisual: M.doorVisualSchema.nullable().optional(),
  rooms: z.array(roomSchema).min(1),
  portals: z.array(portalSchema),
  modules: modulesSchema.optional()
}).strict();

const prefabSchema = dungeonPrefabDefinitionSchema.extend({
  id,
  assetKey: M.assetKeySchema,
  stateAssets: z.array(z.object({
    stateId: D.objectStateSchema,
    assetKey: M.assetKeySchema
  }).strict()),
  /** Local-space physical footprint centered on the prefab pivot. */
  footprint: polygonPointsSchema.optional(),
  /** Local-space click area (the fallback when a room click area is not authored). */
  touchArea: z.union([
    z.object({ kind: z.literal("circle"), radius: finiteNumber.positive() }).strict(),
    z.object({ kind: z.literal("polygon"), points: polygonPointsSchema }).strict()
  ]).optional()
}).strict();

export const interiorLibrarySchema = z.object({
  schemaVersion: z.literal(INTERIOR_CATALOG_SCHEMA_VERSION),
  catalogRevision: z.number().int().nonnegative(),
  prefabs: z.array(prefabSchema),
  rewardTables: z.array(D.dungeonRewardTableSchema),
  rewardTableIds: z.array(id),
  bossTemplates: z.array(D.dungeonBossTemplateSchema),
  bossTemplateIds: z.array(id),
  entrances: z.array(D.dungeonEntranceSchema)
}).strict();

export const interiorCatalogSchema = z.object({
  library: interiorLibrarySchema,
  spaces: z.array(interiorSpaceSchema).min(1)
}).strict();

export type InteriorLibrary = z.infer<typeof interiorLibrarySchema>;
export type InteriorPrefab = InteriorLibrary["prefabs"][number];
export type InteriorSpace = z.infer<typeof interiorSpaceSchema>;
export type InteriorRoom = InteriorSpace["rooms"][number];
export type InteriorAnchor = InteriorRoom["anchors"][number];
export type InteriorFloor = InteriorRoom["floors"][number];
export type InteriorWall = InteriorRoom["walls"][number];
export type InteriorCollider = InteriorRoom["colliders"][number];
export type InteriorZone = InteriorRoom["zones"][number];
export type InteriorClickArea = InteriorRoom["clickAreas"][number];
export type InteriorObject = InteriorRoom["objects"][number];
export type InteriorPlacement = InteriorRoom["layers"]["background"][number];
export type InteriorPortal = InteriorSpace["portals"][number];
export type InteriorModules = NonNullable<InteriorSpace["modules"]>;
export type InteriorCatalog = z.infer<typeof interiorCatalogSchema>;
export type InteriorCatalogValidationIssue = Readonly<{ path: string; message: string }>;

export function parseInteriorCatalog(value: unknown): InteriorCatalog {
  return validateInteriorCatalog(value);
}

export function validateInteriorCatalog(value: unknown): InteriorCatalog {
  const parsed = interiorCatalogSchema.safeParse(value);
  if (!parsed.success) throw new Error(formatIssues(zodIssues(parsed.error)));
  const issues = semanticIssues(parsed.data);
  if (issues.length > 0) throw new Error(formatIssues(issues));
  return parsed.data;
}

export function interiorCatalogValidationIssues(value: unknown): InteriorCatalogValidationIssue[] {
  const parsed = interiorCatalogSchema.safeParse(value);
  return parsed.success ? semanticIssues(parsed.data) : zodIssues(parsed.error);
}

function zodIssues(error: z.ZodError): InteriorCatalogValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "$",
    message: issue.message
  }));
}

function formatIssues(issues: readonly InteriorCatalogValidationIssue[]): string {
  return `Invalid interior catalog: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`;
}

const DUNGEON_ONLY_MODULES = [
  "entrance", "encounters", "triggers", "reset", "escape", "deathRecovery",
  "rewardTableIds", "bossTemplateIds", "access", "tier", "runRolls"
] as const;
const KIND_MODULES: Readonly<Record<string, InteriorSpaceKind>> = {
  decoration: "manor",
  manor: "manor",
  planters: "greenhouse",
  salon: "salon"
};

function semanticIssues(catalog: InteriorCatalog): InteriorCatalogValidationIssue[] {
  const issues: InteriorCatalogValidationIssue[] = [];
  const { library } = catalog;
  duplicateIssues(library.prefabs, "library.prefabs", (value) => value.id, issues);
  duplicateIssues(library.rewardTables, "library.rewardTables", (value) => value.id, issues);
  duplicateIssues(library.bossTemplates, "library.bossTemplates", (value) => value.id, issues);
  duplicateIssues(library.entrances, "library.entrances", (value) => value.id, issues);
  const prefabs = new Map(library.prefabs.map((prefab) => [prefab.id, prefab]));
  library.prefabs.forEach((prefab, index) => {
    duplicateIssues(prefab.stateAssets, `library.prefabs.${index}.stateAssets`, (state) => state.stateId, issues);
    if (prefab.footprint) polygonIssues(prefab.footprint, `library.prefabs.${index}.footprint`, issues);
  });

  duplicateIssues(catalog.spaces, "spaces", (space) => space.id, issues);
  // Room ids double as runtime `location_space_id` values, so they are unique catalog-wide.
  const roomOwners = new Map<string, string>();
  for (const space of catalog.spaces) {
    for (const room of space.rooms) {
      for (const roomKey of [room.id, ...room.aliases]) {
        const owner = roomOwners.get(roomKey);
        if (owner !== undefined) {
          issues.push({ path: `spaces.${space.id}.rooms.${room.id}`, message: `room id or alias ${roomKey} is already used by ${owner}` });
        }
        roomOwners.set(roomKey, space.id);
      }
    }
  }

  catalog.spaces.forEach((space, spaceIndex) => {
    spaceIssues(space, `spaces.${spaceIndex}`, prefabs, library, issues);
  });

  const dungeonSpaces = catalog.spaces.filter((space) => space.kind === "dungeon");
  if (dungeonSpaces.length > 0) {
    // Encounter, trigger, reward and portal-graph rules are owned by the
    // dungeon validator; run it over the projection so they stay in one place.
    const projected = dungeonCatalogFromInterior(catalog);
    for (const issue of dungeonCatalogValidationIssues(projected)) {
      issues.push({ path: `dungeonView.${issue.path}`, message: issue.message });
    }
  }
  return issues;
}

function spaceIssues(
  space: InteriorSpace,
  path: string,
  prefabs: ReadonlyMap<string, InteriorPrefab>,
  library: InteriorLibrary,
  issues: InteriorCatalogValidationIssue[]
): void {
  const expectedProfile = space.kind === "dungeon" ? "dungeon" : "standard_indoor";
  if (space.spatialProfileId !== expectedProfile) {
    issues.push({ path: `${path}.spatialProfileId`, message: `${space.kind} spaces use the ${expectedProfile} profile` });
  }
  duplicateIssues(space.rooms, `${path}.rooms`, (room) => room.id, issues);
  duplicateIssues(space.portals, `${path}.portals`, (portal) => portal.id, issues);
  const rooms = new Map(space.rooms.map((room) => [room.id, room]));
  const portals = new Map(space.portals.map((portal) => [portal.id, portal]));
  const defaultRoom = rooms.get(space.defaultRoomId);
  if (!defaultRoom || defaultRoom.retired || !defaultRoom.active) {
    issues.push({ path: `${path}.defaultRoomId`, message: "references an active room" });
  }

  const modules = space.modules ?? {};
  if (space.kind !== "dungeon") {
    for (const key of DUNGEON_ONLY_MODULES) {
      if (modules[key] !== undefined) {
        issues.push({ path: `${path}.modules.${key}`, message: `is only supported on dungeon spaces` });
      }
    }
  }
  for (const [key, kind] of Object.entries(KIND_MODULES)) {
    if ((modules as Record<string, unknown>)[key] !== undefined && space.kind !== kind) {
      issues.push({ path: `${path}.modules.${key}`, message: `is only supported on ${kind} spaces` });
    }
  }
  if (space.kind === "dungeon") {
    for (const key of ["entrance", "escape", "deathRecovery", "reset"] as const) {
      if (modules[key] === undefined) issues.push({ path: `${path}.modules.${key}`, message: "is required on dungeon spaces" });
    }
  }
  if (space.kind === "salon" && modules.salon === undefined) {
    issues.push({ path: `${path}.modules.salon`, message: "is required on salon spaces" });
  }
  if (space.kind === "greenhouse" && modules.planters) {
    const pot = prefabs.get(modules.planters.potPrefabId);
    if (!pot || pot.retired || pot.type !== "object") {
      issues.push({ path: `${path}.modules.planters.potPrefabId`, message: "references a missing object prefab" });
    }
  }

  space.rooms.forEach((room, roomIndex) => {
    roomIssues(space, room, `${path}.rooms.${roomIndex}`, prefabs, portals, issues);
  });

  space.portals.forEach((portal, portalIndex) => {
    const portalPath = `${path}.portals.${portalIndex}`;
    if (new Set(portal.conditions).size !== portal.conditions.length) {
      issues.push({ path: `${portalPath}.conditions`, message: "conditions must be unique" });
    }
    if (portal.retired) return;
    if (space.kind !== "dungeon") {
      if (portal.conditions.some((condition) => condition !== "always") || (portal.gates ?? []).length > 0) {
        issues.push({ path: portalPath, message: "conditions and gates are only supported on dungeon portals" });
      }
    }
    for (const [label, endpoint] of [["source", portal.source], ["destination", portal.destination]] as const) {
      if (endpoint.kind !== "room") continue;
      const room = rooms.get(endpoint.roomId);
      const anchor = room?.anchors.find((candidate) => candidate.id === endpoint.anchorId);
      if (!room || room.retired || !room.active) {
        issues.push({ path: `${portalPath}.${label}.roomId`, message: "references an active room in this space" });
      } else if (!anchor || anchor.retired || anchor.role !== "portal") {
        issues.push({ path: `${portalPath}.${label}.anchorId`, message: "must reference an active portal anchor" });
      }
    }
    if (portal.source.kind === "world" && portal.destination.kind === "world") {
      issues.push({ path: portalPath, message: "cannot connect world to world" });
    }
    const roomAnchor = (roomId: string | undefined, anchorId: string | undefined, label: string) => {
      if (!roomId || !anchorId) return;
      const anchor = rooms.get(roomId)?.anchors.find((candidate) => candidate.id === anchorId && !candidate.retired);
      if (!anchor) issues.push({ path: `${portalPath}.${label}`, message: "references a missing anchor" });
    };
    if (portal.source.kind === "room") {
      roomAnchor(portal.source.roomId, portal.sourceApproachAnchorId, "sourceApproachAnchorId");
      roomAnchor(portal.source.roomId, portal.sourceThresholdAnchorId, "sourceThresholdAnchorId");
    }
    if (portal.destination.kind === "room") {
      roomAnchor(portal.destination.roomId, portal.destinationArrivalAnchorId, "destinationArrivalAnchorId");
    }
    if (portal.enabled) {
      const reach = (roomId: string, anchorId: string | undefined, label: string) => {
        const room = rooms.get(roomId);
        if (!room || room.retired || !room.active || !anchorId) return;
        const spawn = room.anchors.find((anchor) => anchor.id === room.spawnAnchorId && !anchor.retired);
        const anchor = room.anchors.find((candidate) => candidate.id === anchorId && !candidate.retired);
        if (!spawn || !anchor) return;
        if (!findIndoorNavigationRoute(interiorNavigation(room), spawn, anchor)) {
          issues.push({ path: `${portalPath}.${label}`, message: "anchor is not reachable from the room spawn" });
        }
      };
      if (portal.source.kind === "room") reach(portal.source.roomId, portal.sourceApproachAnchorId, "sourceApproachAnchorId");
      if (portal.destination.kind === "room") reach(portal.destination.roomId, portal.destinationArrivalAnchorId, "destinationArrivalAnchorId");
    }
    if (portal.reciprocalPortalId) {
      const reciprocal = portals.get(portal.reciprocalPortalId);
      if (!reciprocal || reciprocal.retired) {
        issues.push({ path: `${portalPath}.reciprocalPortalId`, message: "references a missing portal" });
      } else if (reciprocal.reciprocalPortalId !== portal.id ||
        !sameEndpoint(portal.source, reciprocal.destination) ||
        !sameEndpoint(portal.destination, reciprocal.source)) {
        issues.push({ path: `${portalPath}.reciprocalPortalId`, message: "does not define a reciprocal edge" });
      }
    }
  });

  // Every active portal anchor is an endpoint of some portal record.
  for (const room of space.rooms) {
    if (room.retired) continue;
    room.anchors.forEach((anchor, anchorIndex) => {
      if (anchor.retired || anchor.role !== "portal") return;
      const referenced = space.portals.some((portal) =>
        (portal.source.kind === "room" && portal.source.roomId === room.id && portal.source.anchorId === anchor.id) ||
        (portal.destination.kind === "room" && portal.destination.roomId === room.id && portal.destination.anchorId === anchor.id));
      if (!referenced) {
        issues.push({ path: `${path}.rooms.${room.id}.anchors.${anchorIndex}`, message: "portal anchor is not used by any portal record" });
      }
    });
  }

  // Decorations bind to a floor/wall of an active room.
  for (const [index, decoration] of (modules.decoration?.definitions ?? []).entries()) {
    if (decoration.retired) continue;
    const decorationPath = `${path}.modules.decoration.definitions.${index}`;
    const room = rooms.get(decoration.roomId);
    if (!room || room.retired || !room.active) {
      issues.push({ path: `${decorationPath}.roomId`, message: "references an active room in this space" });
      continue;
    }
    const floor = room.floors.find((candidate) => candidate.id === decoration.surfaceId && !candidate.retired);
    const wall = room.walls.find((candidate) => candidate.id === decoration.surfaceId && !candidate.retired);
    if (!floor && !wall) {
      issues.push({ path: `${decorationPath}.surfaceId`, message: "references an active floor or wall in its room" });
    }
  }
  duplicateIssues(modules.decoration?.definitions ?? [], `${path}.modules.decoration.definitions`, (value) => value.id, issues);

  if (space.kind === "dungeon") {
    const entrance = modules.entrance;
    if (entrance) {
      const portal = portals.get(entrance.portalId);
      if (!portal || portal.retired || portal.source.kind !== "world") {
        issues.push({ path: `${path}.modules.entrance.portalId`, message: "must reference an active world entrance portal" });
      }
    }
    if (modules.escape && !portals.has(modules.escape.portalId)) {
      issues.push({ path: `${path}.modules.escape.portalId`, message: "references a missing portal" });
    }
    for (const [index, rewardId] of (modules.rewardTableIds ?? []).entries()) {
      if (!library.rewardTableIds.includes(rewardId)) {
        issues.push({ path: `${path}.modules.rewardTableIds.${index}`, message: "references an unavailable reward table" });
      }
    }
    for (const [index, bossId] of (modules.bossTemplateIds ?? []).entries()) {
      if (!library.bossTemplateIds.includes(bossId)) {
        issues.push({ path: `${path}.modules.bossTemplateIds.${index}`, message: "references an unavailable boss template" });
      }
    }
  }
}

function roomIssues(
  space: InteriorSpace,
  room: InteriorRoom,
  path: string,
  prefabs: ReadonlyMap<string, InteriorPrefab>,
  portals: ReadonlyMap<string, InteriorPortal>,
  issues: InteriorCatalogValidationIssue[]
): void {
  duplicateIssues(room.floors, `${path}.floors`, (value) => value.id, issues);
  duplicateIssues(room.walls, `${path}.walls`, (value) => value.id, issues);
  duplicateIssues(room.colliders, `${path}.colliders`, (value) => value.id, issues);
  duplicateIssues(room.zones, `${path}.zones`, (value) => value.id, issues);
  duplicateIssues(room.anchors, `${path}.anchors`, (value) => value.id, issues);
  duplicateIssues(room.clickAreas, `${path}.clickAreas`, (value) => value.id, issues);
  duplicateIssues(room.objects, `${path}.objects`, (value) => value.id, issues);
  duplicateIssues(room.mobs, `${path}.mobs`, (value) => value.id, issues);
  duplicateIssues(room.resourceNodes ?? [], `${path}.resourceNodes`, (value) => value.id, issues);
  duplicateIssues(room.resourceSpawnZones ?? [], `${path}.resourceSpawnZones`, (value) => value.id, issues);
  const placements = Object.values(room.layers).flat();
  duplicateIssues(placements, `${path}.layers`, (value) => value.id, issues);
  // Walls, floors and colliders are separate namespaces, but a surface id must
  // not repeat between a floor and a wall (decorations bind by surface id).
  duplicateIssues([...room.floors, ...room.walls], `${path}.surfaces`, (value) => value.id, issues);
  if (room.retired) return;

  const anchors = new Map(room.anchors.map((anchor) => [anchor.id, anchor]));
  const activeAnchor = (anchorId: string) => {
    const anchor = anchors.get(anchorId);
    return anchor && !anchor.retired ? anchor : undefined;
  };
  const inRoom = (point: { x: number; y: number }) =>
    point.x >= 0 && point.x <= room.width && point.y >= 0 && point.y <= room.height;
  const spawn = activeAnchor(room.spawnAnchorId);
  if (!spawn || spawn.role !== "spawn") {
    issues.push({ path: `${path}.spawnAnchorId`, message: "references an active spawn anchor" });
  }
  if (!(room.camera.minZoom <= room.camera.defaultZoom && room.camera.defaultZoom <= room.camera.maxZoom)) {
    issues.push({ path: `${path}.camera`, message: "zoom must satisfy minZoom <= defaultZoom <= maxZoom" });
  }
  if (!inRoom(room.camera.center)) {
    issues.push({ path: `${path}.camera.center`, message: "is outside room bounds" });
  }
  if (space.kind === "dungeon" && (room.camera.center.x !== room.width / 2 || room.camera.center.y !== room.height / 2)) {
    issues.push({ path: `${path}.camera.center`, message: "must equal the exact room midpoint" });
  }
  room.anchors.forEach((anchor, index) => {
    if (anchor.retired) return;
    const anchorPath = `${path}.anchors.${index}`;
    if (!inRoom(anchor)) issues.push({ path: anchorPath, message: "is outside room bounds" });
    if (anchor.role === "message" && !anchor.message) {
      issues.push({ path: `${anchorPath}.message`, message: "message anchor requires message text" });
    }
    if (anchor.role !== "message" && anchor.message !== undefined) {
      issues.push({ path: `${anchorPath}.message`, message: "only message anchors carry text" });
    }
  });
  if (room.active && room.floors.filter((floor) => !floor.retired).length === 0) {
    issues.push({ path: `${path}.floors`, message: "must include an active floor" });
  }
  room.floors.forEach((floor, index) => {
    if (floor.retired) return;
    polygonIssues(floor.polygon, `${path}.floors.${index}.polygon`, issues);
    if (!floor.polygon.every(inRoom)) {
      issues.push({ path: `${path}.floors.${index}`, message: "geometry is outside room bounds" });
    }
  });
  room.walls.forEach((wall, index) => {
    if (wall.retired) return;
    const wallPath = `${path}.walls.${index}`;
    polygonIssues(wall.roomPolygon, `${wallPath}.roomPolygon`, issues);
    if (!wall.roomPolygon.every(inRoom)) issues.push({ path: wallPath, message: "geometry is outside room bounds" });
    if (wall.imagePolygon.length !== wall.roomPolygon.length) {
      issues.push({ path: `${wallPath}.imagePolygon`, message: "must have one normalized point for each room polygon vertex" });
    }
    wall.imagePolygon.forEach((point, pointIndex) => {
      if (point.u < 0 || point.u > 1 || point.v < 0 || point.v > 1) {
        issues.push({ path: `${wallPath}.imagePolygon.${pointIndex}`, message: "u/v must be normalized between 0 and 1" });
      }
    });
    if (Math.abs(wall.transform.scaleU) <= 1e-12 || Math.abs(wall.transform.scaleV) <= 1e-12) {
      issues.push({ path: `${wallPath}.transform`, message: "scaleU and scaleV must be nonzero" });
    }
  });
  for (const [collection, shapes] of [["colliders", room.colliders], ["zones", room.zones]] as const) {
    shapes.forEach((shape, index) => {
      if (shape.retired) return;
      const shapePath = `${path}.${collection}.${index}`;
      if (shape.kind === "polygon") {
        polygonIssues(shape.points, `${shapePath}.points`, issues);
        if (!shape.points.every(inRoom)) issues.push({ path: shapePath, message: "geometry is outside room bounds" });
      } else if (shape.x < 0 || shape.y < 0 || shape.x + shape.width > room.width || shape.y + shape.height > room.height) {
        issues.push({ path: shapePath, message: "geometry is outside room bounds" });
      }
    });
  }
  placements.forEach((placement) => {
    if (placement.retired) return;
    const prefab = prefabs.get(placement.prefabId);
    const placementPath = `${path}.layers.${placement.id}`;
    if (!prefab || prefab.retired) {
      issues.push({ path: `${placementPath}.prefabId`, message: "references a missing prefab" });
    } else if (placement.prefabRevision !== prefab.revision) {
      issues.push({ path: `${placementPath}.prefabRevision`, message: "does not match the current prefab revision" });
    } else if (prefab.type !== "surface" && prefab.type !== "decoration") {
      issues.push({ path: `${placementPath}.prefabId`, message: "layer placements require a surface or decoration prefab" });
    }
  });

  const objects = new Map(room.objects.map((object) => [object.id, object]));
  room.clickAreas.forEach((area, index) => {
    if (area.retired) return;
    const areaPath = `${path}.clickAreas.${index}`;
    polygonIssues(area.polygon, `${areaPath}.polygon`, issues);
    if (!area.polygon.every(inRoom)) issues.push({ path: `${areaPath}.polygon`, message: "geometry is outside room bounds" });
    if ("anchorId" in area.target) {
      const anchor = activeAnchor(area.target.anchorId);
      if (!anchor || anchor.role === "spawn") {
        issues.push({ path: `${areaPath}.target`, message: "must bind to an active interaction anchor" });
      }
    } else {
      const object = objects.get(area.target.objectId);
      if (!object || object.retired) {
        issues.push({ path: `${areaPath}.target`, message: "must bind to an active object" });
      }
    }
  });

  room.objects.forEach((object, index) => {
    if (object.retired) return;
    const objectPath = `${path}.objects.${index}`;
    const anchor = activeAnchor(object.anchorId);
    if (!anchor) {
      issues.push({ path: `${objectPath}.anchorId`, message: "references a missing anchor" });
    } else if (anchor.role !== "point" && !(anchor.role === "portal" && PORTAL_ANCHOR_OBJECT_TYPES.has(object.type))) {
      issues.push({ path: `${objectPath}.anchorId`, message: "objects reference point anchors" });
    }
    if (object.approachAnchorId && !activeAnchor(object.approachAnchorId)) {
      issues.push({ path: `${objectPath}.approachAnchorId`, message: "references a missing anchor" });
    }
    if ((object.prefabId === undefined) !== (object.prefabRevision === undefined)) {
      issues.push({ path: `${objectPath}.prefabId`, message: "prefabId and prefabRevision go together" });
    } else if (object.prefabId === undefined) {
      if (!PREFAB_OPTIONAL_OBJECT_TYPES.has(object.type)) {
        issues.push({ path: `${objectPath}.prefabId`, message: `${object.type} objects require a prefab` });
      }
    } else {
      const prefab = prefabs.get(object.prefabId);
      if (!prefab || prefab.retired) {
        issues.push({ path: `${objectPath}.prefabId`, message: "references a missing prefab" });
      } else if (object.prefabRevision !== prefab.revision) {
        issues.push({ path: `${objectPath}.prefabRevision`, message: "does not match the current prefab revision" });
      } else if (object.type === "portal" && prefab.type !== "portal") {
        issues.push({ path: `${objectPath}.prefabId`, message: "portal objects require a portal prefab" });
      } else if (object.type !== "portal" && prefab.type !== "object") {
        issues.push({ path: `${objectPath}.prefabId`, message: "non-portal objects require an object prefab" });
      }
    }
    if (object.type === "station" ? object.stationKind === undefined : object.stationKind !== undefined) {
      issues.push({ path: `${objectPath}.stationKind`, message: "is required for, and only allowed on, station objects" });
    }
    if (object.type === "portal") {
      const portal = object.portalId ? portals.get(object.portalId) : undefined;
      if (!portal || portal.retired) {
        issues.push({ path: `${objectPath}.portalId`, message: "references a missing portal" });
      } else if (portal.source.kind !== "room" || portal.source.roomId !== room.id || portal.source.anchorId !== object.anchorId) {
        issues.push({ path: `${objectPath}.portalId`, message: "must reference a portal sourced from the same room and anchor" });
      }
    } else if (object.portalId) {
      issues.push({ path: `${objectPath}.portalId`, message: "is only allowed for portal objects" });
    }
  });

  if (space.kind !== "dungeon" && room.mobs.some((mob) => !mob.retired)) {
    issues.push({ path: `${path}.mobs`, message: "mobs are only supported in dungeon spaces" });
  }
  room.mobs.forEach((mob, index) => {
    if (mob.retired) return;
    const anchor = activeAnchor(mob.anchorId);
    if (!anchor || anchor.role !== "point") {
      issues.push({ path: `${path}.mobs.${index}.anchorId`, message: "mobs reference active point anchors" });
    }
  });
  (room.resourceNodes ?? []).forEach((node, index) => {
    if (node.retired) return;
    const anchor = activeAnchor(node.anchorId);
    if (!anchor || anchor.role !== "point") {
      issues.push({ path: `${path}.resourceNodes.${index}.anchorId`, message: "resources reference active point anchors" });
    }
  });

  if (room.active) {
    const navigation = interiorNavigation(room);
    if (spawn && !isIndoorNavigationPointWalkable(navigation, spawn)) {
      issues.push({ path: `${path}.spawnAnchorId`, message: "spawn must be inside a walkable floor" });
    }
    room.mobs.filter((mob) => !mob.retired).forEach((mob, index) => {
      const anchor = activeAnchor(mob.anchorId);
      if (anchor && !isIndoorNavigationPointWalkable(navigation, anchor)) {
        issues.push({ path: `${path}.mobs.${index}.anchorId`, message: "mob anchor is not walkable" });
      }
    });
  }
}

function polygonIssues(
  points: readonly { x: number; y: number }[],
  path: string,
  issues: InteriorCatalogValidationIssue[]
): void {
  for (const message of manorPolygonGeometryIssues(points)) issues.push({ path, message });
}

function sameEndpoint(left: InteriorPortal["source"], right: InteriorPortal["source"]): boolean {
  return left.kind === right.kind && (left.kind === "world" ||
    (right.kind === "room" && left.roomId === right.roomId && left.anchorId === right.anchorId));
}

function duplicateIssues<T>(
  values: readonly T[],
  path: string,
  key: (value: T) => string,
  issues: InteriorCatalogValidationIssue[]
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const valueId = key(value);
    if (seen.has(valueId)) issues.push({ path: `${path}.${index}.id`, message: `duplicate ID ${valueId}` });
    seen.add(valueId);
  });
}

// ---------------------------------------------------------------------------
// Permanence: published ids are only retired, changed rooms/spaces need a new
// revision. Modeled on the Manor Studio checks (assertPublishedManorIdsPreserved
// and assertPublishedManorRevisionIdentities).
// ---------------------------------------------------------------------------

type IdCollection = Readonly<{ label: string; ids: readonly string[] }>;

function roomIdCollections(room: InteriorRoom): IdCollection[] {
  return [
    { label: "floor", ids: room.floors.map((value) => value.id) },
    { label: "wall", ids: room.walls.map((value) => value.id) },
    { label: "collider", ids: room.colliders.map((value) => value.id) },
    { label: "zone", ids: room.zones.map((value) => value.id) },
    { label: "anchor", ids: room.anchors.map((value) => value.id) },
    { label: "click area", ids: room.clickAreas.map((value) => value.id) },
    { label: "object", ids: room.objects.map((value) => value.id) },
    { label: "mob", ids: room.mobs.map((value) => value.id) },
    { label: "resource node", ids: (room.resourceNodes ?? []).map((value) => value.id) },
    { label: "resource spawn zone", ids: (room.resourceSpawnZones ?? []).map((value) => value.id) },
    { label: "placement", ids: Object.values(room.layers).flat().map((value) => value.id) }
  ];
}

function spaceIdCollections(space: InteriorSpace): IdCollection[] {
  const modules = space.modules;
  return [
    { label: "portal", ids: space.portals.map((value) => value.id) },
    { label: "encounter", ids: (modules?.encounters ?? []).map((value) => value.id) },
    { label: "trigger", ids: (modules?.triggers ?? []).map((value) => value.id) },
    { label: "decoration", ids: (modules?.decoration?.definitions ?? []).map((value) => value.id) }
  ];
}

/** Every id present in `current` must still exist in `proposed` (retire, never delete). */
export function interiorIdPreservationIssues(
  current: InteriorCatalog,
  proposed: InteriorCatalog
): string[] {
  const issues: string[] = [];
  const missing = (label: string, before: readonly string[], after: readonly string[]) => {
    const next = new Set(after);
    for (const value of before) {
      if (!next.has(value)) issues.push(`${label} ${value} was removed; retire it instead`);
    }
  };
  missing("interior space", current.spaces.map((space) => space.id), proposed.spaces.map((space) => space.id));
  missing("library prefab", current.library.prefabs.map((value) => value.id), proposed.library.prefabs.map((value) => value.id));
  missing("library reward table", current.library.rewardTables.map((value) => value.id), proposed.library.rewardTables.map((value) => value.id));
  missing("library boss template", current.library.bossTemplates.map((value) => value.id), proposed.library.bossTemplates.map((value) => value.id));
  missing("library entrance", current.library.entrances.map((value) => value.id), proposed.library.entrances.map((value) => value.id));
  for (const space of current.spaces) {
    const next = proposed.spaces.find((candidate) => candidate.id === space.id);
    if (!next) continue;
    missing(`room in ${space.id}`, space.rooms.map((room) => room.id), next.rooms.map((room) => room.id));
    const nextCollections = spaceIdCollections(next);
    spaceIdCollections(space).forEach((collection, index) => {
      missing(`${collection.label} in ${space.id}`, collection.ids, nextCollections[index]!.ids);
    });
    for (const room of space.rooms) {
      const nextRoom = next.rooms.find((candidate) => candidate.id === room.id);
      if (!nextRoom) continue;
      const nextRoomCollections = roomIdCollections(nextRoom);
      missing(`alias in ${space.id}/${room.id}`, room.aliases, nextRoom.aliases);
      roomIdCollections(room).forEach((collection, index) => {
        missing(`${collection.label} in ${space.id}/${room.id}`, collection.ids, nextRoomCollections[index]!.ids);
      });
    }
  }
  return issues;
}

export function assertPublishedInteriorIdsPreserved(
  current: InteriorCatalog,
  proposed: InteriorCatalog
): void {
  const issues = interiorIdPreservationIssues(current, proposed);
  if (issues.length > 0) throw new Error(`Interior ids must be preserved: ${issues.join("; ")}`);
}

/** A changed room or space must carry a new `revision`. */
export function interiorRevisionIdentityIssues(
  current: InteriorCatalog,
  proposed: InteriorCatalog
): string[] {
  const issues: string[] = [];
  for (const space of current.spaces) {
    const next = proposed.spaces.find((candidate) => candidate.id === space.id);
    if (!next) continue;
    for (const room of space.rooms) {
      const nextRoom = next.rooms.find((candidate) => candidate.id === room.id);
      if (!nextRoom) continue;
      if (stableStringify(withoutRevision(room)) !== stableStringify(withoutRevision(nextRoom)) &&
        room.revision === nextRoom.revision) {
        issues.push(`room ${space.id}/${room.id} changed without a new revision`);
      }
    }
    const strip = (value: InteriorSpace) => {
      const copy: Record<string, unknown> = { ...value };
      delete copy.revision;
      delete copy.publishedRevisionId;
      delete copy.catalogRevision;
      return copy;
    };
    if (stableStringify(strip(space)) !== stableStringify(strip(next)) && space.revision === next.revision) {
      issues.push(`space ${space.id} changed without a new revision`);
    }
  }
  return issues;
}

export function assertPublishedInteriorRevisionIdentities(
  current: InteriorCatalog,
  proposed: InteriorCatalog
): void {
  const issues = interiorRevisionIdentityIssues(current, proposed);
  if (issues.length > 0) throw new Error(`Interior revision identity required: ${issues.join("; ")}`);
}

function withoutRevision<T extends { revision: string }>(value: T): Omit<T, "revision"> {
  const copy: Record<string, unknown> = { ...value };
  delete copy.revision;
  return copy as Omit<T, "revision">;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, sortKeys(entry)]));
  }
  return value;
}
