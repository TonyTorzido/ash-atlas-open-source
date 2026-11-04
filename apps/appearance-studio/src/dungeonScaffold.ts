import {
  DUNGEON_BOSS_DEFINITIONS,
  DUNGEON_SKILL_IDS,
  DUNGEON_TIER_IDS,
  DUNGEON_RESOURCE_TYPES,
  INVENTORY_CATALOG,
  MOB_ARCHETYPE_KEYS,
  dungeonAccessSchema,
  dungeonCatalogValidationIssues,
  dungeonTriggerSchema,
  parseDungeonCatalog,
  type DungeonCatalog,
  type DungeonDefinition,
  type DungeonEncounterDefinition,
  type DungeonRoomDefinition,
  type DungeonTriggerDefinition,
  type IndoorPoint
} from "@ash-atlas/shared";
import { z } from "zod";

import {
  ONE_ROOM_CHEST_REWARD_TABLE_ID,
  createDungeonFromWizard,
  createDungeonObject,
  createDungeonResourceNode,
  createDungeonResourceSpawnZone,
  createDungeonRewardTable,
  createDungeonRoom,
  createLayerPlacement,
  createMobPlacement,
  selectDungeonBossTemplate
} from "./dungeonStudioV2.js";
import {
  buildDungeonTopology,
  connectDungeonRooms,
  findWalkableAnchorPoint,
  isDungeonRoomPointWalkable
} from "./dungeonTopology.js";

/* ------------------------------------------------------------------------------------------ *
 * Spec schema. Everything is keyed by friendly, room-local names; real catalog ids are derived
 * from them (see docs/appearance-studio.md, "Scaffolding dungeons from a spec").
 * ------------------------------------------------------------------------------------------ */

const nameId = z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, "use lowercase letters, digits and single underscores, e.g. crypt_hall");
const num = z.number().finite();
const point = z.object({ x: num, y: num }).strict();
const rect = z.object({ x: num, y: num, width: num.positive(), height: num.positive() }).strict();
const polygon = z.array(point).min(3);
const range = z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).strict()
  .refine((value) => value.max >= value.min, { message: "max must be at least min" });
const zonePurpose = z.enum(["trigger", "encounter_boundary", "leash", "safe", "damage", "restricted", "heal"]);
const endpoint = z.object({ room: nameId, anchor: nameId.optional(), at: point.optional() }).strict()
  .refine((value) => !(value.anchor && value.at), { message: "use either anchor or at, not both" });
const gate = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dungeon_flag"), flagId: nameId, value: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal("item_owned"), itemId: z.string().min(1), quantity: z.number().int().positive().default(1) }).strict(),
  z.object({ type: z.literal("quest_flag"), flagId: nameId, value: z.boolean().default(true) }).strict()
]);
const shapeFields = { rect: rect.optional(), polygon: polygon.optional() };
const oneShape = (value: { rect?: unknown; polygon?: unknown }): boolean => Boolean(value.rect) !== Boolean(value.polygon);
const shapeMessage = { message: "give exactly one of rect ({x,y,width,height}) or polygon ([{x,y}, ...3+ points])" };

const roomSpec = z.object({
  id: nameId,
  name: z.string().min(1),
  width: num.min(320).max(4000).default(1000),
  height: num.min(320).max(4000).default(1000),
  /** Moves the room's spawn anchor (where players arrive by default). */
  spawn: point.optional(),
  anchors: z.record(nameId, z.object({ x: num, y: num, facing: num.optional() }).strict()).default({}),
  zones: z.array(z.object({ id: nameId, purpose: zonePurpose.default("trigger"), ...shapeFields }).strict()
    .refine(oneShape, shapeMessage)).default([]),
  chests: z.array(z.object({
    id: nameId,
    name: z.string().min(1).default("Treasure Chest"),
    anchor: nameId.optional(),
    at: point.optional(),
    reward: z.union([
      z.object({ table: z.string().min(1) }).strict(),
      z.object({
        gold: z.number().int().positive().optional(),
        items: z.array(z.object({ itemId: z.string().min(1), quantity: z.number().int().positive().default(1) }).strict()).default([]),
        /** Rolled independently per claimant (e.g. a 10% Amulet Clasp). */
        chanceItems: z.array(z.object({
          itemId: z.string().min(1),
          minQuantity: z.number().int().positive().default(1),
          maxQuantity: z.number().int().positive().default(1),
          chancePct: z.number().gt(0).max(100)
        }).strict()).default([])
      }).strict()
    ]).optional(),
    /** Hidden chests appear when an encounter's onComplete reveals them. Implied by revealChest. */
    hidden: z.boolean().optional()
  }).strict().refine((value) => !(value.anchor && value.at), { message: "use either anchor or at, not both" })).default([]),
  /** Skill turn-in altars (World Knowledge); hidden ones appear when an encounter's onComplete reveals them. */
  shrines: z.array(z.object({
    id: nameId,
    name: z.string().min(1).default("Altar"),
    at: point.optional(),
    prefab: z.string().min(1).default("fangrock_scale_shrine"),
    skillTurnIn: z.enum(DUNGEON_SKILL_IDS),
    interactionLabel: z.string().min(1).max(60),
    hidden: z.boolean().optional()
  }).strict()).default([]),
  /** Surface prefab id stretched over the whole room as its floor (replaces the shared placeholder). */
  floor: nameId.optional(),
  /**
   * Interactive and decorative objects (switches, citizens, props, rift and gate art). Hidden ones
   * appear when an encounter's onComplete reveals them (revealObject) or a raw set_object_available.
   */
  objects: z.array(z.object({
    id: nameId,
    type: z.enum(["switch", "valve", "door", "npc", "decoration", "destructible", "harvestable", "shrine"]),
    prefab: nameId,
    at: point,
    name: z.string().min(1).optional(),
    initialState: z.enum(["idle", "open", "closed", "on", "off", "pressed", "released", "intact", "destroyed", "looted"]).optional(),
    hidden: z.boolean().optional(),
    interactionLabel: z.string().min(1).max(60).optional(),
    layer: z.enum(["background", "below_player", "actors", "above_player", "ceiling"]).optional(),
    zIndex: z.number().int().optional(),
    interactionRadius: num.positive().optional()
  }).strict()).default([]),
  resourceNodes: z.array(z.object({
    id: nameId,
    type: z.enum(DUNGEON_RESOURCE_TYPES),
    at: point,
    yield: range.default({ min: 1, max: 3 }),
    respawnSeconds: num.nonnegative().nullable().default(null),
    resetOnRun: z.boolean().default(true)
  }).strict()).default([]),
  resourceZones: z.array(z.object({
    id: nameId,
    types: z.array(z.enum(DUNGEON_RESOURCE_TYPES)).min(1),
    ...shapeFields,
    count: range.default({ min: 2, max: 4 }),
    spacing: num.nonnegative().default(60),
    yield: range.default({ min: 1, max: 3 }),
    respawnSeconds: num.nonnegative().nullable().default(null),
    resetOnRun: z.boolean().default(true),
    seed: z.number().int().nonnegative().optional()
  }).strict().refine(oneShape, shapeMessage)).default([])
}).strict();

const doorSpec = z.object({
  /** Friendly door id used by encounters (lockDoors, unlockDoor). Defaults to "<from>_to_<to>". */
  id: nameId.optional(),
  from: endpoint,
  to: endpoint,
  oneWay: z.boolean().default(false),
  label: z.string().min(1).optional(),
  reverseLabel: z.string().min(1).optional(),
  presentation: z.enum(["door", "stairs", "ladder", "hatch", "cave"]).default("door"),
  /** Locked doors need the flag "<door id>_unlocked"; unlock them from an encounter's onComplete. */
  locked: z.boolean().default(false),
  gates: z.array(gate).default([]),
  conditions: z.array(z.enum(["always", "dungeon_active", "unlocked", "boss_defeated"])).min(1).optional()
}).strict();

const singleKey = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict().refine(
  (value) => Object.values(value).filter((entry) => entry !== undefined).length === 1,
  { message: `use exactly one of: ${Object.keys(shape).join(", ")}` });
const rawAction = dungeonTriggerSchema.shape.actions.element;
const onCompleteAction = singleKey({
  unlockDoor: nameId.optional(),
  revealChest: nameId.optional(),
  revealShrine: nameId.optional(),
  revealObject: nameId.optional(),
  setFlag: nameId.optional(),
  completeDungeon: z.literal(true).optional(),
  startEncounter: nameId.optional(),
  playCue: nameId.optional(),
  /** HUD message shown when the encounter is cleared (1-140 chars); replaces the automatic notices. */
  message: z.string().trim().min(1).max(140).optional(),
  raw: rawAction.optional()
});
const startOn = z.union([
  z.enum(["room_enter", "manual"]),
  z.object({ zoneEnter: nameId }).strict(),
  z.object({ after: nameId }).strict()
]);
const mobGroup = z.object({
  archetype: z.enum(MOB_ARCHETYPE_KEYS),
  count: z.number().int().min(1).max(50).optional(),
  /** Fixed spawn points (one mob per point). Omit both at and zone to spawn randomly inside the encounter area. */
  at: z.array(point).min(1).optional(),
  /** Spawn at random walkable points inside this room zone. */
  zone: nameId.optional(),
  visualScale: num.positive().default(1)
}).strict().refine((value) => !(value.at && value.zone), { message: "use either at or zone, not both" });
const encounterSpec = z.object({
  id: nameId,
  name: z.string().min(1).optional(),
  room: nameId,
  startOn: startOn.default("room_enter"),
  waves: z.array(z.object({ delayMs: num.nonnegative().default(0), mobs: z.array(mobGroup).min(1) }).strict()).default([]),
  /** Seeded per-run roll (catalog `encounter.roll` shape: pool, budget, waves, spawn zone ids, elite). Replaces waves. */
  roll: z.custom<NonNullable<DungeonEncounterDefinition["roll"]>>((value) => typeof value === "object" && value !== null).optional(),
  /** Adding a boss to an encounter that has waves splits it into "<id>" (trash) then "<id>_boss". */
  boss: z.object({
    template: z.string().min(1),
    name: z.string().min(1).optional(),
    at: point.optional(),
    zone: nameId.optional(),
    visualScale: num.positive().default(1)
  }).strict().refine((value) => !(value.at && value.zone), { message: "use either at or zone, not both" }).optional(),
  /** Timed rescue: clear the first half of this encounter within the limit to free an ally. */
  rescue: z.object({ timeLimitMs: z.number().int().min(5_000).max(600_000) }).strict().optional(),
  /** true = every door leaving this room (and the world exit); or a list of door ids. */
  lockDoors: z.union([z.boolean(), z.array(nameId).min(1)]).default(false),
  onComplete: z.array(onCompleteAction).default([]),
  boundary: nameId.optional(),
  leash: nameId.optional()
}).strict().refine((value) => value.waves.length > 0 || value.boss || value.roll, { message: "needs at least one wave, a roll or a boss" })
  .refine((value) => !(value.roll && value.waves.length > 0), { message: "a rolled encounter generates its own waves; leave waves empty" })
  .refine((value) => !(value.roll && value.boss), { message: "boss encounters never roll; roll a separate trash encounter" });

const rawTrigger = dungeonTriggerSchema.partial({
  retired: true, enabled: true, scope: true, repetition: true, cooldownMs: true, conditions: true
});

export const dungeonScaffoldSpecSchema = z.object({
  dungeon: z.object({
    id: nameId,
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    instancePolicy: z.enum(["shared_persistent", "party_ephemeral", "solo_ephemeral"]).default("party_ephemeral"),
    resetPolicy: z.enum(["when_empty", "manual", "never"]).default("when_empty"),
    /** Seconds an empty instance is kept before it is torn down (null keeps the runtime default). */
    despawnAfterSeconds: num.nonnegative().optional(),
    /** Entry rules (level, torch cost, lockout, afloat, no re-entry). */
    access: dungeonAccessSchema.optional(),
    /** Declares a procgen tier; the dungeon must then meet its profile (dungeonTierIssues). */
    tier: z.object({ id: z.enum(DUNGEON_TIER_IDS) }).strict().optional(),
    theme: z.object({
      id: nameId.default("dungeon"),
      backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0d1014"),
      floorColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2a2f36"),
      wallColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3b424b"),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#c8a45a")
    }).strict().default({})
  }).strict(),
  /** Room where players arrive from the world. Defaults to the first room. */
  entranceRoom: nameId.optional(),
  rooms: z.array(roomSpec).min(1),
  doors: z.array(doorSpec).default([]),
  encounters: z.array(encounterSpec).default([]),
  /** Raw triggers using the catalog's event/condition/action shapes; refer to real generated ids. */
  triggers: z.array(rawTrigger).default([])
}).strict();

export type DungeonScaffoldSpec = z.input<typeof dungeonScaffoldSpecSchema>;
type Spec = z.output<typeof dungeonScaffoldSpecSchema>;
type EncounterSpec = Spec["encounters"][number];

export class DungeonScaffoldError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Dungeon spec is not valid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "DungeonScaffoldError";
  }
}

export type DungeonScaffoldSummary = Readonly<{
  dungeonId: string;
  name: string;
  entranceRoomId: string;
  rooms: readonly { id: string; name: string; size: string; anchors: number; mobs: number; objects: number }[];
  doors: readonly { id: string; route: string; twoWay: boolean; locked: boolean; label: string }[];
  encounters: readonly { id: string; room: string; start: string; waves: readonly string[]; boss: string | null; locks: readonly string[]; onComplete: readonly string[] }[];
  chests: readonly { id: string; room: string; reward: string; hidden: boolean }[];
  triggerCount: number;
  rewardTablesCreated: readonly string[];
  bossTemplatesCreated: readonly string[];
  readiness: Readonly<{ catalogIssues: number; topologyErrors: number; notes: readonly string[] }>;
  remaining: readonly string[];
}>;

export type DungeonScaffoldResult = Readonly<{ catalog: DungeonCatalog; summary: DungeonScaffoldSummary }>;

/* ------------------------------------------------------------------------------------------ */

function pathOf(path: readonly (string | number)[]): string {
  return path.reduce<string>((text, part) => typeof part === "number" ? `${text}[${part}]` : text ? `${text}.${part}` : String(part), "") || "spec";
}

function zodIssueMessages(issue: z.ZodIssue): string[] {
  if (issue.code === "invalid_union") {
    const best = [...issue.unionErrors].sort((a, b) =>
      Math.max(0, ...b.issues.map((entry) => entry.path.length)) - Math.max(0, ...a.issues.map((entry) => entry.path.length)) || a.issues.length - b.issues.length)[0];
    return best ? best.issues.flatMap(zodIssueMessages) : [`${pathOf(issue.path)}: no accepted form matches`];
  }
  return [`${pathOf(issue.path)}: ${issue.message}`];
}

function friendly(id: string): string {
  return id.replace(/_+/gu, " ").replace(/^./u, (char) => char.toUpperCase());
}

function pointText(value: IndoorPoint): string {
  return `(${Math.round(value.x)}, ${Math.round(value.y)})`;
}

const RESERVED_ANCHORS = new Set(["spawn", "entrance_escape", "death_recovery"]);

/**
 * Builds a complete dungeon skeleton (rooms, doors, zones, encounters, chests, resources, triggers)
 * from a spec and returns a new catalog containing it. The input catalog is not modified and the
 * catalog revision is left for the writer to bump. Throws DungeonScaffoldError with spec-path messages.
 */
export function scaffoldDungeon(catalog: DungeonCatalog, rawSpec: unknown): DungeonScaffoldResult {
  const parsed = dungeonScaffoldSpecSchema.safeParse(rawSpec);
  if (!parsed.success) throw new DungeonScaffoldError(parsed.error.issues.flatMap(zodIssueMessages));
  const spec = parsed.data;
  const issues: string[] = [];
  const fail = (path: string, message: string): void => { issues.push(`${path}: ${message}`); };
  const checkpoint = (): void => { if (issues.length > 0) throw new DungeonScaffoldError(issues); };

  let next = structuredClone(catalog) as DungeonCatalog;
  const dungeonId = spec.dungeon.id;
  if (next.dungeons.some((dungeon) => dungeon.id === dungeonId)) {
    fail("dungeon.id", `a dungeon with id "${dungeonId}" already exists; choose a new id (published ids are permanent)`);
  }
  const portalPrefab = next.prefabs.find((prefab) => !prefab.retired && prefab.type === "portal");
  const floorPrefab = next.prefabs.find((prefab) => !prefab.retired && prefab.type === "surface");
  if (!portalPrefab || !floorPrefab) fail("catalog", "needs an active portal prefab and an active surface prefab");
  checkpoint();

  /* ---- structural reference checks that do not need built rooms ---- */
  const roomSpecs = new Map(spec.rooms.map((room) => [room.id, room]));
  if (roomSpecs.size !== spec.rooms.length) fail("rooms", "room ids must be unique");
  const entranceRoomId = spec.entranceRoom ?? spec.rooms[0]!.id;
  if (!roomSpecs.has(entranceRoomId)) fail("entranceRoom", `"${entranceRoomId}" is not one of rooms[].id`);
  const chestRoom = new Map<string, string>();
  const shrineRoom = new Map<string, string>();
  const objectRoom = new Map<string, string>();
  spec.rooms.forEach((room, roomIndex) => {
    for (const anchorName of Object.keys(room.anchors)) {
      if (RESERVED_ANCHORS.has(anchorName)) fail(`rooms[${roomIndex}].anchors.${anchorName}`, "this anchor name is reserved (spawn, entrance_escape, death_recovery are built in)");
    }
    room.chests.forEach((chest, index) => {
      if (chestRoom.has(chest.id)) fail(`rooms[${roomIndex}].chests[${index}].id`, `chest id "${chest.id}" is used twice (chest ids are unique across the dungeon)`);
      chestRoom.set(chest.id, room.id);
    });
    room.shrines.forEach((shrine, index) => {
      if (shrineRoom.has(shrine.id) || chestRoom.has(shrine.id)) fail(`rooms[${roomIndex}].shrines[${index}].id`, `shrine id "${shrine.id}" is used twice (object ids are unique across the dungeon)`);
      shrineRoom.set(shrine.id, room.id);
    });
    room.objects.forEach((object, index) => {
      if (objectRoom.has(object.id) || shrineRoom.has(object.id) || chestRoom.has(object.id)) fail(`rooms[${roomIndex}].objects[${index}].id`, `object id "${object.id}" is used twice (object ids are unique across the dungeon)`);
      objectRoom.set(object.id, room.id);
    });
    const zoneIds = room.zones.map((zone) => zone.id);
    if (new Set(zoneIds).size !== zoneIds.length) fail(`rooms[${roomIndex}].zones`, "zone ids must be unique within a room");
  });
  const doorIds = new Set<string>();
  const doorMeta = spec.doors.map((door, index) => {
    const id = door.id ?? `${door.from.room}_to_${door.to.room}`;
    if (doorIds.has(id)) fail(`doors[${index}].id`, `door id "${id}" is used twice; give the doors distinct id values`);
    doorIds.add(id);
    for (const side of ["from", "to"] as const) {
      const room = roomSpecs.get(door[side].room);
      if (!room) fail(`doors[${index}].${side}.room`, `unknown room "${door[side].room}"`);
      else if (door[side].anchor && !room.anchors[door[side].anchor!] && !RESERVED_ANCHORS.has(door[side].anchor!)) {
        fail(`doors[${index}].${side}.anchor`, `room "${room.id}" has no anchor "${door[side].anchor}" (declare it in rooms[].anchors)`);
      }
    }
    if (door.from.room === door.to.room) fail(`doors[${index}]`, "a door must connect two different rooms");
    return { id, reverseId: `${id}_back`, door, index };
  });
  const encounterIds = new Set<string>();
  const bossSplit = new Set<string>();
  spec.encounters.forEach((encounter, index) => {
    if (encounterIds.has(encounter.id)) fail(`encounters[${index}].id`, `encounter id "${encounter.id}" is used twice`);
    encounterIds.add(encounter.id);
    if (encounter.waves.length > 0 && encounter.boss) bossSplit.add(encounter.id);
    if (!roomSpecs.has(encounter.room)) fail(`encounters[${index}].room`, `unknown room "${encounter.room}"`);
  });
  /** The catalog encounter whose completion means "this spec encounter is done". */
  const completionOf = (id: string): string => bossSplit.has(id) ? `${id}_boss` : id;
  for (const id of bossSplit) if (encounterIds.has(`${id}_boss`)) fail("encounters", `"${id}_boss" is reserved for the boss half of "${id}"; rename that encounter`);
  const revealedShrineIds = new Set(spec.encounters.flatMap((encounter) => encounter.onComplete.flatMap((action) => action.revealShrine ? [action.revealShrine] : [])));
  const revealedObjectIds = new Set(spec.encounters.flatMap((encounter) => encounter.onComplete.flatMap((action) => action.revealObject ? [action.revealObject] : [])));
  const revealedChestIds = new Set(spec.encounters.flatMap((encounter) => encounter.onComplete.flatMap((action) => action.revealChest ? [action.revealChest] : [])));
  spec.encounters.forEach((encounter, index) => {
    const at = `encounters[${index}]`;
    if (typeof encounter.startOn === "object" && "after" in encounter.startOn && !encounterIds.has(encounter.startOn.after)) fail(`${at}.startOn.after`, `unknown encounter "${encounter.startOn.after}"`);
    if (typeof encounter.startOn === "object" && "after" in encounter.startOn && encounter.startOn.after === encounter.id) fail(`${at}.startOn.after`, "an encounter cannot start after itself");
    if (typeof encounter.startOn === "object" && "zoneEnter" in encounter.startOn && !roomSpecs.get(encounter.room)?.zones.some((zone) => zone.id === (encounter.startOn as { zoneEnter: string }).zoneEnter)) {
      fail(`${at}.startOn.zoneEnter`, `room "${encounter.room}" has no zone "${(encounter.startOn as { zoneEnter: string }).zoneEnter}"`);
    }
    if (Array.isArray(encounter.lockDoors)) encounter.lockDoors.forEach((doorId, doorIndex) => { if (!doorIds.has(doorId)) fail(`${at}.lockDoors[${doorIndex}]`, `unknown door "${doorId}"`); });
    encounter.onComplete.forEach((action, actionIndex) => {
      const actionAt = `${at}.onComplete[${actionIndex}]`;
      if (action.unlockDoor) {
        const meta = doorMeta.find((entry) => entry.id === action.unlockDoor);
        if (!meta) fail(`${actionAt}.unlockDoor`, `unknown door "${action.unlockDoor}"`);
        else if (!meta.door.locked) fail(`${actionAt}.unlockDoor`, `door "${action.unlockDoor}" is not locked; set "locked": true on it`);
      }
      if (action.revealChest && !chestRoom.has(action.revealChest)) fail(`${actionAt}.revealChest`, `unknown chest "${action.revealChest}"`);
      if (action.revealShrine && !shrineRoom.has(action.revealShrine)) fail(`${actionAt}.revealShrine`, `unknown shrine "${action.revealShrine}"`);
      if (action.revealObject && !objectRoom.has(action.revealObject)) fail(`${actionAt}.revealObject`, `unknown object "${action.revealObject}"`);
      if (action.startEncounter && !encounterIds.has(action.startEncounter)) fail(`${actionAt}.startEncounter`, `unknown encounter "${action.startEncounter}"`);
    });
  });
  checkDoorConnectivity(spec, entranceRoomId, fail);
  checkpoint();

  /* ---- dungeon shell from the Studio wizard so entrance/exit/escape/recovery match ---- */
  const entranceSpec = roomSpecs.get(entranceRoomId)!;
  const dungeon = createDungeonFromWizard(next, {
    name: dungeonId, themeId: spec.dungeon.theme.id, backgroundColor: spec.dungeon.theme.backgroundColor,
    floorColor: spec.dungeon.theme.floorColor, wallColor: spec.dungeon.theme.wallColor, accentColor: spec.dungeon.theme.accentColor,
    instancePolicy: spec.dungeon.instancePolicy, resetPolicy: spec.dungeon.resetPolicy,
    width: entranceSpec.width, height: entranceSpec.height
  });
  if (dungeon.id !== dungeonId) throw new DungeonScaffoldError([`dungeon.id: could not use "${dungeonId}" as the dungeon id`]);
  dungeon.name = spec.dungeon.name;
  if (spec.dungeon.description) dungeon.description = spec.dungeon.description;
  if (spec.dungeon.access) dungeon.access = structuredClone(spec.dungeon.access);
  if (spec.dungeon.tier) dungeon.tier = { ...spec.dungeon.tier };
  if (spec.dungeon.despawnAfterSeconds !== undefined) dungeon.reset.despawnAfterSeconds = spec.dungeon.despawnAfterSeconds;
  renameRoom(dungeon, dungeon.entrance.roomId, entranceRoomId);
  const rooms = new Map<string, DungeonRoomDefinition>();
  rooms.set(entranceRoomId, dungeon.rooms[0]!);
  for (const roomSpec of spec.rooms) {
    if (roomSpec.id === entranceRoomId) continue;
    const room = createDungeonRoom(dungeon, { id: roomSpec.id, name: roomSpec.name, width: roomSpec.width, height: roomSpec.height, active: true });
    room.layers[floorPrefab!.defaultLayerId].push(createLayerPlacement(floorPrefab!, `${room.id}_initial_floor`, { x: room.width / 2, y: room.height / 2 }, room));
    dungeon.rooms.push(room);
    rooms.set(room.id, room);
  }
  rooms.get(entranceRoomId)!.name = entranceSpec.name;
  const specRoomIndex = new Map(spec.rooms.map((room, index) => [room.id, index]));

  /* ---- rooms: spawn, anchors, zones ---- */
  for (const roomSpec of spec.rooms) {
    const room = rooms.get(roomSpec.id)!;
    const at = `rooms[${specRoomIndex.get(roomSpec.id)}]`;
    if (roomSpec.floor) {
      const floor = next.prefabs.find((prefab) => !prefab.retired && prefab.type === "surface" && prefab.id === roomSpec.floor);
      if (!floor) fail(`${at}.floor`, `the catalog has no surface prefab "${roomSpec.floor}"`);
      else {
        for (const layer of Object.values(room.layers)) layer.splice(0, layer.length, ...layer.filter((placement) => placement.prefabId !== floorPrefab!.id));
        room.layers.background.push({
          id: "floor", retired: false, prefabId: floor.id, prefabRevision: floor.revision, x: 0, y: 0,
          width: room.width, height: room.height, rotationDeg: 0, opacity: 1, flipX: false, flipY: false, zIndex: 0
        });
      }
    }
    if (roomSpec.spawn) {
      const spawn = room.anchors.find((anchor) => anchor.id === room.spawnAnchorId)!;
      if (isDungeonRoomPointWalkable(room, roomSpec.spawn)) { spawn.x = roomSpec.spawn.x; spawn.y = roomSpec.spawn.y; }
      else fail(`${at}.spawn`, `${pointText(roomSpec.spawn)} is not inside walkable floor (room is ${room.width}x${room.height}, keep 24+ units from edges)`);
    }
    for (const [anchorName, position] of Object.entries(roomSpec.anchors)) {
      if (!isDungeonRoomPointWalkable(room, position)) fail(`${at}.anchors.${anchorName}`, `${pointText(position)} is not inside walkable floor (room is ${room.width}x${room.height}, keep 24+ units from edges)`);
      room.anchors.push({ id: anchorName, retired: false, x: position.x, y: position.y, ...(position.facing === undefined ? {} : { facing: position.facing }) });
    }
    roomSpec.zones.forEach((zone, index) => {
      const shape = zone.rect ? { x: zone.rect.x, y: zone.rect.y, width: zone.rect.width, height: zone.rect.height } : null;
      const points = zone.polygon ?? null;
      const inside = shape
        ? shape.x >= 0 && shape.y >= 0 && shape.x + shape.width <= room.width && shape.y + shape.height <= room.height
        : points!.every((corner) => corner.x >= 0 && corner.x <= room.width && corner.y >= 0 && corner.y <= room.height);
      if (!inside) { fail(`${at}.zones[${index}]`, `zone "${zone.id}" extends outside the ${room.width}x${room.height} room`); return; }
      room.zones.push(shape
        ? { id: zone.id, retired: false, kind: "rectangle", purpose: zone.purpose, ...shape }
        : { id: zone.id, retired: false, kind: "polygon", purpose: zone.purpose, points: points!.map((corner) => ({ x: corner.x, y: corner.y })) });
    });
  }
  checkpoint();

  /* ---- doors ---- */
  const portalOfDoor = new Map<string, { forward: string; reverse: string | null; from: string; to: string }>();
  const doorPoint = (side: z.infer<typeof endpoint>): { roomId: string; anchorId?: string; point?: IndoorPoint } => {
    const room = rooms.get(side.room)!;
    if (side.anchor) return { roomId: room.id, anchorId: side.anchor };
    return { roomId: room.id, point: side.at ?? pickOpenPoint(room) };
  };
  for (const meta of doorMeta) {
    const at = `doors[${meta.index}]`;
    const { door } = meta;
    const gates = [
      ...door.gates,
      ...(door.locked ? [{ type: "dungeon_flag" as const, flagId: `${meta.id}_unlocked`, value: true }] : [])
    ];
    try {
      const connection = connectDungeonRooms(dungeon, doorPoint(door.from), doorPoint(door.to), portalPrefab!, !door.oneWay, {
        requireActive: true,
        ...(door.label ? { label: door.label } : {}),
        ...(door.reverseLabel ? { reverseLabel: door.reverseLabel } : {}),
        presentation: door.presentation,
        ...(door.conditions ? { conditions: door.conditions } : {}),
        ...(gates.length > 0 ? { gates } : {}),
        portalIds: { forward: meta.id, ...(door.oneWay ? {} : { reverse: meta.reverseId }) }
      });
      portalOfDoor.set(meta.id, { forward: connection.portalId, reverse: connection.reciprocalPortalId, from: door.from.room, to: door.to.room });
    } catch (error) {
      fail(at, error instanceof Error ? error.message : "the door could not be created");
    }
  }
  checkpoint();

  /* ---- chests (with rewards), resources ---- */
  const rewardTablesCreated: string[] = [];
  const chestSummaries: { id: string; room: string; reward: string; hidden: boolean }[] = [];
  const generatedTriggerIds = new Set<string>();
  const addTrigger = (trigger: Omit<DungeonTriggerDefinition, "retired" | "enabled" | "cooldownMs" | "conditions">, at: string): void => {
    if (generatedTriggerIds.has(trigger.id) || dungeon.triggers.some((existing) => existing.id === trigger.id)) {
      fail(at, `trigger id "${trigger.id}" collides with another generated or raw trigger; rename the spec entity or your raw trigger`);
      return;
    }
    generatedTriggerIds.add(trigger.id);
    dungeon.triggers.push({ retired: false, enabled: true, cooldownMs: 0, conditions: { mode: "all", items: [] }, ...trigger });
  };
  const chestPrefab = next.prefabs.find((prefab) => !prefab.retired && prefab.type === "object" && prefab.id === "dungeon_chest")
    ?? next.prefabs.find((prefab) => !prefab.retired && prefab.type === "object" && /chest/iu.test(`${prefab.id} ${prefab.name}`));
  for (const roomSpec of spec.rooms) {
    const room = rooms.get(roomSpec.id)!;
    const at = `rooms[${specRoomIndex.get(roomSpec.id)}]`;
    roomSpec.chests.forEach((chest, index) => {
      const chestAt = `${at}.chests[${index}]`;
      if (!chestPrefab) { fail(chestAt, "the catalog has no chest object prefab"); return; }
      let anchorId = chest.anchor;
      if (anchorId) {
        if (!room.anchors.some((anchor) => anchor.id === anchorId)) { fail(`${chestAt}.anchor`, `room "${room.id}" has no anchor "${anchorId}"`); return; }
      } else {
        const position = chest.at ?? pickOpenPoint(room);
        if (!isDungeonRoomPointWalkable(room, position)) { fail(`${chestAt}.at`, `${pointText(position)} is not inside walkable floor`); return; }
        anchorId = `${chest.id}_anchor`;
        room.anchors.push({ id: anchorId, retired: false, x: position.x, y: position.y });
      }
      let tableId = ONE_ROOM_CHEST_REWARD_TABLE_ID;
      let rewardText = `table ${tableId} (default)`;
      if (chest.reward && "table" in chest.reward) {
        tableId = chest.reward.table;
        rewardText = `table ${tableId}`;
        if (!next.rewardTableIds.includes(tableId) || !next.rewardTables.some((table) => table.id === tableId && !table.retired)) { fail(`${chestAt}.reward.table`, `reward table "${tableId}" does not exist in the catalog`); return; }
      } else if (chest.reward && (chest.reward.gold || chest.reward.items.length > 0 || chest.reward.chanceItems.length > 0)) {
        const badItem = chest.reward.items.findIndex((item) => !INVENTORY_CATALOG[item.itemId]?.packageGrantable);
        if (badItem >= 0) { fail(`${chestAt}.reward.items[${badItem}].itemId`, `"${chest.reward.items[badItem]!.itemId}" is not a grantable inventory item id`); return; }
        const badChance = chest.reward.chanceItems.findIndex((item) => !INVENTORY_CATALOG[item.itemId]?.packageGrantable);
        if (badChance >= 0) { fail(`${chestAt}.reward.chanceItems[${badChance}].itemId`, `"${chest.reward.chanceItems[badChance]!.itemId}" is not a grantable inventory item id`); return; }
        tableId = `${dungeonId}_${chest.id}_reward`;
        next = createDungeonRewardTable(next, { id: tableId, ...(chest.reward.gold ? { gold: chest.reward.gold } : {}), items: chest.reward.items });
        if (chest.reward.chanceItems.length > 0) {
          next.rewardTables.find((table) => table.id === tableId)!.chanceItems = chest.reward.chanceItems.map((entry) => ({ ...entry, maxQuantity: Math.max(entry.minQuantity, entry.maxQuantity) }));
        }
        rewardTablesCreated.push(tableId);
        rewardText = `new table ${tableId}`;
      }
      if (!dungeon.rewardTableIds.includes(tableId)) dungeon.rewardTableIds.push(tableId);
      const object = createDungeonObject(chestPrefab, chest.id, anchorId, chest.name);
      object.rewardTableId = tableId;
      object.spawnChance = 100;
      const hidden = chest.hidden ?? revealedChestIds.has(chest.id);
      if (hidden) object.available = false;
      room.objects.push(object);
      chestSummaries.push({ id: chest.id, room: room.id, reward: rewardText, hidden });
      addTrigger({
        id: `${chest.id}_reward`, scope: "player", repetition: "once",
        event: { type: "object_interact", roomId: room.id, objectId: chest.id },
        actions: [{ type: "grant_reward", rewardTableId: tableId }]
      }, chestAt);
    });
    roomSpec.shrines.forEach((shrine, index) => {
      const shrineAt = `${at}.shrines[${index}]`;
      const prefab = next.prefabs.find((candidate) => !candidate.retired && candidate.type === "object" && candidate.id === shrine.prefab);
      if (!prefab) { fail(`${shrineAt}.prefab`, `the catalog has no object prefab "${shrine.prefab}"`); return; }
      const position = shrine.at ?? pickOpenPoint(room);
      if (!isDungeonRoomPointWalkable(room, position)) { fail(`${shrineAt}.at`, `${pointText(position)} is not inside walkable floor`); return; }
      const anchorId = `${shrine.id}_anchor`;
      room.anchors.push({ id: anchorId, retired: false, x: position.x, y: position.y });
      const object = createDungeonObject(prefab, shrine.id, anchorId, shrine.name);
      object.skillTurnIn = shrine.skillTurnIn;
      object.interactionLabel = shrine.interactionLabel;
      object.zIndex = 10;
      if (shrine.hidden ?? revealedShrineIds.has(shrine.id)) object.available = false;
      room.objects.push(object);
    });
    roomSpec.objects.forEach((entry, index) => {
      const objectAt = `${at}.objects[${index}]`;
      const prefab = next.prefabs.find((candidate) => !candidate.retired &&
        candidate.type === "object" && candidate.id === entry.prefab);
      if (!prefab) { fail(`${objectAt}.prefab`, `the catalog has no object prefab "${entry.prefab}"`); return; }
      if (!isDungeonRoomPointWalkable(room, entry.at)) { fail(`${objectAt}.at`, `${pointText(entry.at)} is not inside walkable floor`); return; }
      const anchorId = `${entry.id}_anchor`;
      room.anchors.push({ id: anchorId, retired: false, x: entry.at.x, y: entry.at.y });
      const object = createDungeonObject(prefab, entry.id, anchorId, entry.name ?? prefab.name);
      object.type = entry.type;
      object.initialState = entry.initialState ?? (entry.type === "switch" ? "off" : entry.type === "door" ? "closed" : "idle");
      object.layerId = entry.layer ?? prefab.defaultLayerId;
      object.zIndex = entry.zIndex ?? 10;
      if (entry.interactionLabel) object.interactionLabel = entry.interactionLabel;
      if (entry.interactionRadius) object.interactionRadius = entry.interactionRadius;
      if (entry.hidden ?? revealedObjectIds.has(entry.id)) object.available = false;
      room.objects.push(object);
    });
    roomSpec.resourceNodes.forEach((node, index) => {
      const nodeAt = `${at}.resourceNodes[${index}]`;
      if (!isDungeonRoomPointWalkable(room, node.at)) { fail(`${nodeAt}.at`, `${pointText(node.at)} is not inside walkable floor`); return; }
      const anchorId = `${node.id}_anchor`;
      room.anchors.push({ id: anchorId, retired: false, x: node.at.x, y: node.at.y });
      (room.resourceNodes ??= []).push(createDungeonResourceNode({
        id: node.id, anchorId, resourceType: node.type, minYield: node.yield.min, maxYield: node.yield.max,
        respawnSeconds: node.respawnSeconds, resetOnRun: node.resetOnRun, interactionRadius: 82
      }));
    });
    roomSpec.resourceZones.forEach((zone, index) => {
      const zoneAt = `${at}.resourceZones[${index}]`;
      const shape = zone.rect
        ? { id: `${zone.id}_shape`, retired: false, kind: "rectangle" as const, ...zone.rect }
        : { id: `${zone.id}_shape`, retired: false, kind: "polygon" as const, points: zone.polygon!.map((corner) => ({ ...corner })) };
      const inside = zone.rect
        ? zone.rect.x >= 0 && zone.rect.y >= 0 && zone.rect.x + zone.rect.width <= room.width && zone.rect.y + zone.rect.height <= room.height
        : zone.polygon!.every((corner) => corner.x >= 0 && corner.x <= room.width && corner.y >= 0 && corner.y <= room.height);
      if (!inside) { fail(zoneAt, `resource zone "${zone.id}" extends outside the ${room.width}x${room.height} room`); return; }
      (room.resourceSpawnZones ??= []).push(createDungeonResourceSpawnZone({
        id: zone.id, shape, resourceTypes: zone.types, minCount: zone.count.min, maxCount: zone.count.max,
        minimumSpacing: zone.spacing, seed: zone.seed ?? hashSeed(`${dungeonId}:${zone.id}`), respawnSeconds: zone.respawnSeconds,
        resetOnRun: zone.resetOnRun, interactionRadius: 82, minYield: zone.yield.min, maxYield: zone.yield.max
      }));
    });
  }
  checkpoint();

  /* ---- encounters ---- */
  const bossTemplatesCreated: string[] = [];
  const usedMobIds = new Set<string>();
  const encounterSummaries: DungeonScaffoldSummary["encounters"][number][] = [];
  const startSummary = (encounter: EncounterSpec): string => typeof encounter.startOn === "string"
    ? encounter.startOn
    : "zoneEnter" in encounter.startOn ? `zone_enter ${encounter.startOn.zoneEnter}` : `after ${encounter.startOn.after}`;
  const areaZone = (room: DungeonRoomDefinition, purpose: "encounter_boundary" | "leash", requested: string | undefined, at: string): string | null => {
    if (requested) {
      const found = room.zones.find((zone) => zone.id === requested);
      if (!found || found.purpose !== purpose) { fail(at, `room "${room.id}" has no zone "${requested}" with purpose "${purpose}"`); return null; }
      return requested;
    }
    const existing = room.zones.find((zone) => zone.purpose === purpose);
    if (existing) return existing.id;
    let id: string = purpose === "leash" ? "encounter_leash" : "encounter_boundary";
    while (room.zones.some((zone) => zone.id === id)) id += "_2";
    const inset = purpose === "leash" ? 40 : 20;
    room.zones.push({ id, retired: false, kind: "rectangle", purpose, x: inset, y: inset, width: room.width - inset * 2, height: room.height - inset * 2 });
    return id;
  };
  const lockedPortalsFor = (encounter: EncounterSpec): string[] => {
    if (encounter.lockDoors === false) return [];
    const wanted = Array.isArray(encounter.lockDoors) ? new Set(encounter.lockDoors) : null;
    const ids: string[] = [];
    for (const [doorId, portals] of portalOfDoor) {
      if (wanted && !wanted.has(doorId)) continue;
      if (portals.from === encounter.room) ids.push(portals.forward);
      if (portals.reverse && portals.to === encounter.room) ids.push(portals.reverse);
    }
    if (encounter.lockDoors === true && encounter.room === entranceRoomId) ids.push(dungeon.escape.portalId);
    return [...new Set(ids)];
  };
  const placeMob = (room: DungeonRoomDefinition, archetype: (typeof MOB_ARCHETYPE_KEYS)[number], encounterId: string, mobId: string, waveIndex: number,
    groupId: string, spot: { at?: IndoorPoint | undefined; zone?: string | undefined }, boundaryId: string, leashId: string, visualScale: number, at: string): boolean => {
    let position: IndoorPoint;
    if (spot.at) {
      if (!isDungeonRoomPointWalkable(room, spot.at)) { fail(at, `${pointText(spot.at)} is not inside walkable floor of room "${room.id}"`); return false; }
      position = spot.at;
    } else {
      const zoneId = spot.zone ?? boundaryId;
      const zone = room.zones.find((candidate) => candidate.id === zoneId);
      if (!zone) { fail(at, `room "${room.id}" has no zone "${zoneId}"`); return false; }
      if (!zoneHasWalkableSpot(room, zone)) { fail(at, `zone "${zoneId}" has no walkable spot to spawn on`); return false; }
      const spawn = room.anchors.find((anchor) => anchor.id === room.spawnAnchorId)!;
      position = { x: spawn.x, y: spawn.y };
      spot = { zone: zoneId };
    }
    const anchorId = `${mobId}_anchor`;
    room.anchors.push({ id: anchorId, retired: false, x: position.x, y: position.y });
    room.mobs.push({
      ...createMobPlacement(archetype, mobId, anchorId, encounterId, leashId), waveIndex, spawnGroupId: groupId, visualScale,
      ...(spot.zone ? { randomSpawnZoneId: spot.zone } : {})
    });
    return true;
  };
  const uniqueMobId = (base: string): string => {
    let id = base; let index = 2;
    while (usedMobIds.has(id)) id = `${base}_${index++}`;
    usedMobIds.add(id);
    return id;
  };

  spec.encounters.forEach((encounterSpec, encounterIndex) => {
    const at = `encounters[${encounterIndex}]`;
    const room = rooms.get(encounterSpec.room);
    if (!room) return;
    const boundaryId = areaZone(room, "encounter_boundary", encounterSpec.boundary, `${at}.boundary`);
    const leashId = areaZone(room, "leash", encounterSpec.leash, `${at}.leash`);
    if (!boundaryId || !leashId) return;
    const name = encounterSpec.name ?? friendly(encounterSpec.id);
    const locks = lockedPortalsFor(encounterSpec);
    const makeEncounter = (id: string, encounterName: string, resetDelayMs: number): DungeonEncounterDefinition => ({
      id, retired: false, name: encounterName, roomId: room.id, boundaryZoneId: boundaryId, leashZoneId: leashId,
      waves: [], completion: "all_spawned_mobs_defeated", reset: { onPartyWipe: true, delayMs: resetDelayMs },
      retry: { allowed: true, maxAttempts: null }, lockPortalIds: [...locks]
    });
    let trash: DungeonEncounterDefinition | null = null;
    if (encounterSpec.waves.length > 0) {
      trash = makeEncounter(encounterSpec.id, name, 1500);
      encounterSpec.waves.forEach((wave, waveIndex) => {
        const mobIds: string[] = [];
        wave.mobs.forEach((group, groupIndex) => {
          const groupAt = `${at}.waves[${waveIndex}].mobs[${groupIndex}]`;
          const count = group.at ? group.at.length : group.count ?? 1;
          if (group.at && group.count !== undefined && group.count !== group.at.length) { fail(`${groupAt}.count`, `count ${group.count} does not match ${group.at.length} fixed points in "at"`); return; }
          const groupId = `${trash!.id}_wave${waveIndex + 1}_${group.archetype}_${groupIndex + 1}`;
          for (let index = 0; index < count; index += 1) {
            const mobId = uniqueMobId(`${trash!.id}_${group.archetype}_w${waveIndex + 1}`);
            if (placeMob(room, group.archetype, trash!.id, mobId, waveIndex + 1, groupId, { at: group.at?.[index], zone: group.zone }, boundaryId, leashId, group.visualScale, group.at ? `${groupAt}.at[${index}]` : `${groupAt}.zone`)) mobIds.push(mobId);
          }
        });
        if (mobIds.length > 0) trash!.waves.push({ id: `wave_${waveIndex + 1}`, mobSpawnIds: mobIds, delayMs: wave.delayMs });
      });
      dungeon.encounters.push(trash);
    }
    if (encounterSpec.roll) {
      trash = makeEncounter(encounterSpec.id, name, 1500);
      trash.roll = structuredClone(encounterSpec.roll);
      dungeon.encounters.push(trash);
    }
    let last = trash;
    if (encounterSpec.boss) {
      const bossAt = `${at}.boss`;
      const templateId = resolveBossTemplate(encounterSpec.boss.template, bossAt);
      if (templateId) {
        const definition = DUNGEON_BOSS_DEFINITIONS.find((entry) => entry.id === (next.bossTemplates.find((template) => template.id === templateId)?.bossDefinitionId ?? templateId));
        const bossEncounterId = trash ? `${encounterSpec.id}_boss` : encounterSpec.id;
        const boss = makeEncounter(bossEncounterId, trash ? `${name} - Boss` : name, 3000);
        boss.bossTemplateId = templateId;
        if (!dungeon.bossTemplateIds.includes(templateId)) dungeon.bossTemplateIds.push(templateId);
        const mobId = uniqueMobId(`${bossEncounterId}_boss`);
        const archetype = definition?.archetypeKey ?? "sewer_rat_miniboss";
        const fallback = encounterSpec.boss.at ?? (encounterSpec.boss.zone ? undefined : pickOpenPoint(room, { x: room.width / 2, y: room.height * 0.3 }));
        if (placeMob(room, archetype, bossEncounterId, mobId, 1, `${bossEncounterId}_group`, { at: fallback, zone: encounterSpec.boss.zone }, boundaryId, leashId, encounterSpec.boss.visualScale, bossAt)) {
          boss.waves.push({ id: "wave_1", mobSpawnIds: [mobId], delayMs: 0 });
        }
        dungeon.encounters.push(boss);
        if (trash) {
          addTrigger({
            id: `${trash.id}_starts_${boss.id}`, scope: "instance", repetition: "once",
            event: { type: "encounter_state", encounterId: trash.id, state: "completed" },
            actions: [{ type: "start_encounter", encounterId: boss.id }]
          }, bossAt);
        }
        last = boss;
      }
    }
    const first = trash ?? last;
    if (!first || !last) return;
    if (encounterSpec.rescue) first.rescue = encounterSpec.rescue;
    const startAt = `${at}.startOn`;
    if (encounterSpec.startOn === "room_enter") {
      addTrigger({ id: `start_${first.id}`, scope: "instance", repetition: "once", event: { type: "room_enter", roomId: room.id }, actions: [{ type: "start_encounter", encounterId: first.id }] }, startAt);
    } else if (typeof encounterSpec.startOn === "object" && "zoneEnter" in encounterSpec.startOn) {
      addTrigger({ id: `start_${first.id}`, scope: "instance", repetition: "once", event: { type: "zone_enter", roomId: room.id, zoneId: encounterSpec.startOn.zoneEnter }, actions: [{ type: "start_encounter", encounterId: first.id }] }, startAt);
    } else if (typeof encounterSpec.startOn === "object") {
      addTrigger({ id: `start_${first.id}`, scope: "instance", repetition: "once", event: { type: "encounter_state", encounterId: completionOf(encounterSpec.startOn.after), state: "completed" }, actions: [{ type: "start_encounter", encounterId: first.id }] }, startAt);
    }
    const actions: DungeonTriggerDefinition["actions"] = [];
    const described: string[] = [];
    encounterSpec.onComplete.forEach((action) => {
      if (action.unlockDoor) { actions.push({ type: "set_dungeon_flag", flagId: `${action.unlockDoor}_unlocked`, value: true }); described.push(`unlock door ${action.unlockDoor}`); }
      else if (action.revealChest) { actions.push({ type: "set_object_available", roomId: chestRoom.get(action.revealChest)!, objectId: action.revealChest, available: true }); described.push(`reveal chest ${action.revealChest}`); }
      else if (action.revealShrine) { actions.push({ type: "set_object_available", roomId: shrineRoom.get(action.revealShrine)!, objectId: action.revealShrine, available: true }); described.push(`reveal shrine ${action.revealShrine}`); }
      else if (action.revealObject) { actions.push({ type: "set_object_available", roomId: objectRoom.get(action.revealObject)!, objectId: action.revealObject, available: true }); described.push(`reveal object ${action.revealObject}`); }
      else if (action.setFlag) { actions.push({ type: "set_dungeon_flag", flagId: action.setFlag, value: true }); described.push(`set flag ${action.setFlag}`); }
      else if (action.completeDungeon) { actions.push({ type: "complete_dungeon" }); described.push("complete dungeon"); }
      else if (action.startEncounter) { actions.push({ type: "start_encounter", encounterId: action.startEncounter }); described.push(`start encounter ${action.startEncounter}`); }
      else if (action.playCue) { actions.push({ type: "play_cue", cueId: action.playCue }); described.push(`cue ${action.playCue}`); }
      else if (action.message) { actions.push({ type: "show_message", text: action.message, tone: "success" }); described.push(`message "${action.message}"`); }
      else if (action.raw) { actions.push(action.raw); described.push(`raw ${action.raw.type}`); }
    });
    if (actions.length > 0) {
      addTrigger({ id: `${last.id}_complete`, scope: "instance", repetition: "once", event: { type: "encounter_state", encounterId: last.id, state: "completed" }, actions }, `${at}.onComplete`);
    }
    for (const entry of [trash, last === trash ? null : last]) {
      if (!entry) continue;
      encounterSummaries.push({
        id: entry.id, room: room.id, start: entry === trash || !trash ? startSummary(encounterSpec) : `after ${trash.id} completes`,
        waves: entry.waves.map((wave, index) => `wave ${index + 1}: ${wave.mobSpawnIds.map((mobId) => room.mobs.find((mob) => mob.id === mobId)?.archetype ?? mobId).join(", ")}`),
        boss: entry.bossTemplateId ?? null, locks: entry.lockPortalIds, onComplete: entry === last ? described : []
      });
    }
  });
  function resolveBossTemplate(reference: string, at: string): string | null {
    const existing = next.bossTemplates.find((template) => !template.retired && (template.id === reference || template.bossDefinitionId === reference));
    if (existing) return existing.id;
    const definition = DUNGEON_BOSS_DEFINITIONS.find((entry) => entry.id === reference);
    if (!definition) {
      fail(`${at}.template`, `"${reference}" is not a registered dungeon boss. Use one of: ${DUNGEON_BOSS_DEFINITIONS.map((entry) => entry.id).join(", ")}${next.bossTemplates.length ? `, or an existing template id (${next.bossTemplates.filter((template) => !template.retired).map((template) => template.id).join(", ")})` : ""}`);
      return null;
    }
    if (next.bossTemplates.some((template) => template.id === definition.id)) { fail(`${at}.template`, `boss template id "${definition.id}" is retired or taken`); return null; }
    next = selectDungeonBossTemplate(next, { id: definition.id, definition });
    bossTemplatesCreated.push(definition.id);
    return definition.id;
  }
  checkpoint();

  /* ---- raw triggers ---- */
  spec.triggers.forEach((trigger, index) => {
    if (generatedTriggerIds.has(trigger.id) || dungeon.triggers.some((existing) => existing.id === trigger.id)) {
      fail(`triggers[${index}].id`, `trigger id "${trigger.id}" collides with a generated or another raw trigger; pick a different id`);
      return;
    }
    dungeon.triggers.push({
      id: trigger.id, retired: trigger.retired ?? false, enabled: trigger.enabled ?? true, scope: trigger.scope ?? "instance",
      repetition: trigger.repetition ?? "once", cooldownMs: trigger.cooldownMs ?? 0, event: trigger.event,
      conditions: trigger.conditions ?? { mode: "all", items: [] }, actions: trigger.actions
    });
  });
  checkpoint();

  /* ---- assemble + validate with the same rules the Studio and bridge use ---- */
  next.dungeons.push(dungeon);
  next.catalogRevision = catalog.catalogRevision;
  const catalogIssues = dungeonCatalogValidationIssues(next);
  if (catalogIssues.length > 0) {
    throw new DungeonScaffoldError(catalogIssues.map((issue) => `catalog validation ${translateCatalogPath(issue.path, next, dungeonId)}: ${issue.message}`));
  }
  const output = parseDungeonCatalog(next);
  const built = output.dungeons.find((entry) => entry.id === dungeonId)!;
  const topology = buildDungeonTopology(built);
  const topologyErrors = topology.issues.filter((issue) => issue.severity === "error");
  if (topologyErrors.length > 0) throw new DungeonScaffoldError(topologyErrors.map((issue) => `Studio topology check (${issue.code}): ${issue.message}`));
  const notes = topology.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message);

  const remaining = [
    "Art: every room uses the shared placeholder floor, doors/chests use placeholder prefabs. Import PNGs in the Interiors workspace (room floors, decorations, door/chest art) and paint colliders/walls.",
    "World binding: the world entrance portal is disabled. Bind it in Developer App → Spawning → Dungeon entrances to make the dungeon enterable.",
    "Playtest: open the Interiors workspace -> Play Test, walk every room, then Save to Worktree."
  ];
  if (!built.triggers.some((trigger) => trigger.actions.some((action) => action.type === "complete_dungeon"))) {
    remaining.push('No "completeDungeon" action: add one to a final encounter\'s onComplete or the dungeon never completes.');
  }
  if (built.encounters.some((entry) => entry.bossTemplateId)) remaining.push("Boss art: generic bosses use their normal mob art until a boss appearance is added.");
  const summary: DungeonScaffoldSummary = {
    dungeonId, name: built.name, entranceRoomId,
    rooms: built.rooms.map((room) => ({ id: room.id, name: room.name, size: `${room.width}x${room.height}`, anchors: room.anchors.length, mobs: room.mobs.length, objects: room.objects.length })),
    doors: spec.doors.map((door) => ({
      id: door.id ?? `${door.from.room}_to_${door.to.room}`,
      route: `${door.from.room} ${door.oneWay ? "->" : "<->"} ${door.to.room}`, twoWay: !door.oneWay, locked: door.locked,
      label: door.label ?? `Go to ${rooms.get(door.to.room)!.name}`
    })),
    encounters: encounterSummaries,
    chests: chestSummaries,
    triggerCount: built.triggers.length,
    rewardTablesCreated, bossTemplatesCreated,
    readiness: { catalogIssues: 0, topologyErrors: 0, notes },
    remaining
  };
  return { catalog: output, summary };
}

export function formatDungeonScaffoldSummary(summary: DungeonScaffoldSummary): string {
  const lines: string[] = [`Dungeon "${summary.name}" (${summary.dungeonId}) - entrance room: ${summary.entranceRoomId}`, "", `Rooms (${summary.rooms.length})`];
  for (const room of summary.rooms) lines.push(`  ${room.id}  "${room.name}"  ${room.size}  anchors ${room.anchors}, mobs ${room.mobs}, objects ${room.objects}`);
  lines.push("", `Doors (${summary.doors.length})`);
  for (const door of summary.doors) lines.push(`  ${door.id}  ${door.route}${door.locked ? "  [locked]" : ""}  "${door.label}"`);
  lines.push("", `Encounters (${summary.encounters.length})`);
  for (const encounter of summary.encounters) {
    lines.push(`  ${encounter.id}  in ${encounter.room}  starts: ${encounter.start}${encounter.boss ? `  BOSS ${encounter.boss}` : ""}`);
    for (const wave of encounter.waves) lines.push(`      ${wave}`);
    if (encounter.locks.length > 0) lines.push(`      locks while active: ${encounter.locks.join(", ")}`);
    if (encounter.onComplete.length > 0) lines.push(`      on complete: ${encounter.onComplete.join("; ")}`);
  }
  if (summary.chests.length > 0) {
    lines.push("", `Chests (${summary.chests.length})`);
    for (const chest of summary.chests) lines.push(`  ${chest.id} in ${chest.room}  ${chest.reward}${chest.hidden ? "  [hidden until revealed]" : ""}`);
  }
  lines.push("", `Triggers: ${summary.triggerCount}`);
  if (summary.rewardTablesCreated.length > 0) lines.push(`New reward tables: ${summary.rewardTablesCreated.join(", ")}`);
  if (summary.bossTemplatesCreated.length > 0) lines.push(`New boss templates: ${summary.bossTemplatesCreated.join(", ")}`);
  lines.push("", `Readiness: catalog validation OK, Studio topology OK (entrance reaches every room, recovery path to world)${summary.readiness.notes.length > 0 ? `, ${summary.readiness.notes.length} note(s):` : ""}`);
  for (const note of summary.readiness.notes) lines.push(`  note: ${note}`);
  lines.push("", "Left for you");
  for (const item of summary.remaining) lines.push(`  - ${item}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------------------------------ */

function renameRoom(dungeon: DungeonDefinition, from: string, to: string): void {
  if (from === to) return;
  const room = dungeon.rooms.find((candidate) => candidate.id === from)!;
  room.id = to;
  dungeon.entrance.roomId = to;
  dungeon.deathRecovery.roomId = to;
  for (const portal of dungeon.portals) {
    if (portal.source.kind === "room" && portal.source.roomId === from) portal.source.roomId = to;
    if (portal.destination.kind === "room" && portal.destination.roomId === from) portal.destination.roomId = to;
  }
}

/** Preferred door/chest slots around the room edge, skipping spots near existing anchors. */
function pickOpenPoint(room: DungeonRoomDefinition, preferred?: IndoorPoint): IndoorPoint {
  const margin = 110;
  const slots: IndoorPoint[] = [
    ...(preferred ? [preferred] : []),
    { x: room.width / 2, y: margin }, { x: room.width - margin, y: room.height / 2 }, { x: margin, y: room.height / 2 },
    { x: room.width / 2, y: room.height - margin }, { x: margin, y: margin }, { x: room.width - margin, y: margin },
    { x: margin, y: room.height - margin }, { x: room.width - margin, y: room.height - margin }
  ];
  const clear = (candidate: IndoorPoint): boolean => room.anchors.every((anchor) => anchor.retired || Math.hypot(anchor.x - candidate.x, anchor.y - candidate.y) >= 130);
  for (const slot of slots) {
    const found = findWalkableAnchorPoint(room, slot);
    if (found && Math.hypot(found.x - slot.x, found.y - slot.y) < 1 && clear(found)) return found;
  }
  return findWalkableAnchorPoint(room) ?? { x: room.width / 2, y: room.height / 2 };
}

function zoneHasWalkableSpot(room: DungeonRoomDefinition, zone: DungeonRoomDefinition["zones"][number]): boolean {
  const xs = zone.kind === "rectangle" ? [zone.x, zone.x + zone.width] : zone.points.map((corner) => corner.x);
  const ys = zone.kind === "rectangle" ? [zone.y, zone.y + zone.height] : zone.points.map((corner) => corner.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let row = 0; row <= 8; row += 1) {
    for (let column = 0; column <= 8; column += 1) {
      const candidate = { x: minX + (maxX - minX) * column / 8, y: minY + (maxY - minY) * row / 8 };
      if (isDungeonRoomPointWalkable(room, candidate) && insideZone(zone, candidate)) return true;
    }
  }
  return false;
}

function insideZone(zone: DungeonRoomDefinition["zones"][number], candidate: IndoorPoint): boolean {
  if (zone.kind === "rectangle") return candidate.x >= zone.x && candidate.x <= zone.x + zone.width && candidate.y >= zone.y && candidate.y <= zone.y + zone.height;
  let inside = false;
  for (let index = 0, previous = zone.points.length - 1; index < zone.points.length; previous = index++) {
    const a = zone.points[index]!; const b = zone.points[previous]!;
    if ((a.y > candidate.y) !== (b.y > candidate.y) && candidate.x < (b.x - a.x) * (candidate.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

/** Every room must be reachable from the entrance and able to get back out, using the spec's doors. */
function checkDoorConnectivity(spec: Spec, entranceRoomId: string, fail: (path: string, message: string) => void): void {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const room of spec.rooms) { forward.set(room.id, []); backward.set(room.id, []); }
  for (const door of spec.doors) {
    if (!forward.has(door.from.room) || !forward.has(door.to.room)) continue;
    forward.get(door.from.room)!.push(door.to.room);
    backward.get(door.to.room)!.push(door.from.room);
    if (!door.oneWay) { forward.get(door.to.room)!.push(door.from.room); backward.get(door.from.room)!.push(door.to.room); }
  }
  const walk = (graph: Map<string, string[]>): Set<string> => {
    const seen = new Set([entranceRoomId]);
    const pending = [entranceRoomId];
    for (let index = 0; index < pending.length; index += 1) for (const nextRoom of graph.get(pending[index]!) ?? []) if (!seen.has(nextRoom)) { seen.add(nextRoom); pending.push(nextRoom); }
    return seen;
  };
  const reachable = walk(forward);
  const canReturn = walk(backward);
  spec.rooms.forEach((room, index) => {
    if (!reachable.has(room.id)) fail(`rooms[${index}]`, `room "${room.id}" cannot be reached from the entrance room "${entranceRoomId}"; add a door (doors[]) that leads to it`);
    else if (!canReturn.has(room.id)) fail(`rooms[${index}]`, `room "${room.id}" has no way back to the entrance/exit (all its doors are one-way inward); make a door two-way or add a return door`);
  });
}

function translateCatalogPath(path: string, catalog: DungeonCatalog, dungeonId: string): string {
  const match = /^dungeons\.(\d+)\.(.*)$/u.exec(path);
  if (!match) return path;
  return catalog.dungeons[Number(match[1])]?.id === dungeonId ? match[2]! : path;
}
