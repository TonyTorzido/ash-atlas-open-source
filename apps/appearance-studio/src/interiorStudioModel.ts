import {
  GREENHOUSE_POT_PREFAB_ID,
  GREENHOUSE_WATER_TANK_PREFAB_ID,
  dungeonCatalogFromInterior,
  fromDungeonCatalog,
  greenhouseStudioInputFromInterior,
  interiorCatalogValidationIssues,
  parseGreenhouseStudioCatalog,
  type DungeonCatalog,
  type DungeonDefinition,
  type DungeonRoomDefinition,
  type InteriorAnchor,
  type InteriorCatalog,
  type InteriorLibrary,
  type InteriorPrefab,
  type InteriorRoom,
  type InteriorSpace,
  type InteriorSpaceKind
} from "@ash-atlas/shared";

import { applyModuleEdits } from "./interiorModules.js";
import {
  effectiveRoomAuthoring,
  insetFloorPolygon,
  type AuthoringView,
  type RoomAuthoring
} from "./interiorAuthoring.js";

/**
 * Model behind the InteriorStudio workspace. The editor keeps working on the
 * dungeon-shaped "editing view" (one `DungeonDefinition` per interior space,
 * whatever its kind); this module converts the unified interior catalog into
 * that view and the edited view back into interior spaces. Browser-safe: no
 * node imports.
 */

export const INTERIOR_KINDS: readonly InteriorSpaceKind[] = ["dungeon", "manor", "greenhouse", "salon"];
export const INTERIOR_KIND_GROUP_LABELS: Readonly<Record<InteriorSpaceKind, string>> = {
  dungeon: "Dungeons",
  manor: "Manors",
  greenhouse: "Greenhouse",
  salon: "Salon"
};
export const INTERIOR_KIND_LABELS: Readonly<Record<InteriorSpaceKind, string>> = {
  dungeon: "Dungeon",
  manor: "Manor",
  greenhouse: "Greenhouse",
  salon: "Salon"
};

/** What `GET /api/interior-catalog` returns. */
/** An editing-view prefab: a dungeon prefab that also carries the library footprint and touch area (Greenhouse templates). */
export type ViewPrefab = DungeonCatalog["prefabs"][number] & Partial<Pick<InteriorPrefab, "footprint" | "touchArea">>;

export type InteriorCatalogSnapshot = Readonly<{
  catalogRevision: number;
  library: InteriorLibrary;
  spaces: InteriorSpace[];
  spaceRevisions: Record<string, string>;
}>;

/** Spaces created in the Studio this session and not yet published (their kind-specific skeleton). */
export type InteriorSeedSpaces = Readonly<Record<string, InteriorSpace>>;

export function interiorCatalogOf(snapshot: Pick<InteriorCatalogSnapshot, "library" | "spaces" | "catalogRevision">): InteriorCatalog {
  return { library: { ...snapshot.library, catalogRevision: snapshot.catalogRevision }, spaces: snapshot.spaces };
}

export function interiorSpaceKind(base: InteriorCatalog, seeds: InteriorSeedSpaces, spaceId: string): InteriorSpaceKind {
  return base.spaces.find((space) => space.id === spaceId)?.kind ?? seeds[spaceId]?.kind ?? "dungeon";
}

// ---------------------------------------------------------------------------
// Interior catalog -> editing view
// ---------------------------------------------------------------------------

function placeholderDungeonModules(space: InteriorSpace): NonNullable<InteriorSpace["modules"]> {
  const defaultRoom = space.rooms.find((room) => room.id === space.defaultRoomId) ?? space.rooms[0]!;
  const anchorId = defaultRoom.spawnAnchorId;
  return {
    ...(space.modules ?? {}),
    entrance: {
      roomId: defaultRoom.id,
      arrivalAnchorId: anchorId,
      portalId: space.portals.find((portal) => portal.source.kind === "world")?.id ?? ""
    },
    escape: { portalId: space.portals.find((portal) => portal.destination.kind === "world")?.id ?? "" },
    deathRecovery: { roomId: defaultRoom.id, anchorId },
    reset: {
      policy: "never",
      revision: `${space.id}-v1`,
      despawnAfterSeconds: null,
      resetEnemies: false,
      resetLoot: false,
      resetDoors: false,
      resetBoss: false
    },
    encounters: [],
    triggers: [],
    rewardTableIds: [],
    bossTemplateIds: []
  };
}

/** The dungeon-shaped definitions the editor works on, in the order of `spaces`. */
export function editableDefinitions(library: InteriorLibrary, spaces: readonly InteriorSpace[]): DungeonDefinition[] {
  const relabeled = spaces.map((space): InteriorSpace => space.kind === "dungeon"
    ? space
    : { ...space, kind: "dungeon", modules: placeholderDungeonModules(space) });
  return dungeonCatalogFromInterior({ library, spaces: relabeled }).dungeons;
}

/** The whole unified catalog as one `DungeonCatalog` (every space, every library prefab). */
export function interiorEditingView(interior: InteriorCatalog): DungeonCatalog {
  const { library } = interior;
  return {
    schemaVersion: 2,
    catalogRevision: library.catalogRevision,
    spatialProfiles: ["standard_indoor_v1"],
    // Prefabs keep their footprint and touch area: the Greenhouse template editors edit them in place.
    prefabs: library.prefabs.map((prefab) => structuredClone(prefab) as DungeonCatalog["prefabs"][number]),
    entrances: library.entrances,
    rewardTables: library.rewardTables,
    rewardTableIds: library.rewardTableIds,
    bossTemplateIds: library.bossTemplateIds,
    bossTemplates: library.bossTemplates,
    dungeons: editableDefinitions(library, interior.spaces)
  };
}

// ---------------------------------------------------------------------------
// Editing view -> interior catalog
// ---------------------------------------------------------------------------

function portalAnchorKeys(definition: DungeonDefinition): Set<string> {
  const keys = new Set<string>();
  for (const portal of definition.portals) {
    for (const endpoint of [portal.source, portal.destination]) {
      if (endpoint.kind === "room") keys.add(`${endpoint.roomId}:${endpoint.anchorId}`);
    }
  }
  for (const room of definition.rooms) {
    for (const object of room.objects) if (object.type === "portal") keys.add(`${room.id}:${object.anchorId}`);
  }
  return keys;
}

function mergeRoom(
  edited: DungeonRoomDefinition,
  base: InteriorRoom | undefined,
  portalKeys: ReadonlySet<string>,
  revision: string,
  authoring: RoomAuthoring
): InteriorRoom {
  const anchors = edited.anchors.map((anchor): InteriorAnchor => {
    const override = authoring.anchors[anchor.id];
    const role = anchor.id === edited.spawnAnchorId ? "spawn"
      : override ? override.role
        : portalKeys.has(`${edited.id}:${anchor.id}`) ? "portal" : "point";
    return {
      id: anchor.id,
      retired: anchor.retired,
      x: anchor.x,
      y: anchor.y,
      ...(anchor.facing !== undefined ? { facing: anchor.facing } : {}),
      role,
      ...(role === "message" && override?.message ? { message: override.message } : {}),
      ...(anchorName(authoring, base, anchor.id) ? { name: anchorName(authoring, base, anchor.id)! } : {})
    };
  });
  const authored = {
    retired: edited.retired,
    active: edited.active,
    name: edited.name,
    width: edited.width,
    height: edited.height,
    spawnAnchorId: edited.spawnAnchorId,
    camera: edited.camera,
    environment: edited.environment,
    colliders: edited.colliders,
    zones: edited.zones,
    layers: edited.layers,
    anchors,
    floors: authoring.floors,
    walls: authoring.walls,
    clickAreas: authoring.clickAreas,
    objects: edited.objects as InteriorRoom["objects"],
    mobs: edited.mobs,
    ...(edited.resourceSpawnZones ? { resourceSpawnZones: edited.resourceSpawnZones } : {}),
    ...(edited.resourceNodes ? { resourceNodes: edited.resourceNodes } : {})
  };
  if (base) {
    const merged: InteriorRoom = { ...base, ...authored };
    if (!edited.resourceSpawnZones) delete merged.resourceSpawnZones;
    if (!edited.resourceNodes) delete merged.resourceNodes;
    return merged;
  }
  return {
    id: edited.id,
    revision,
    aliases: [],
    ...authored
  };
}

/** Carry the editor's edits of a non-dungeon space onto its stored space (modules are kept; floors, walls, click areas and anchor roles come from the room's authoring). */
export function mergeEditedSpace(edited: DungeonDefinition, base: InteriorSpace, authoringOf: (room: DungeonRoomDefinition) => RoomAuthoring): InteriorSpace {
  const portalKeys = portalAnchorKeys(edited);
  const baseRooms = new Map(base.rooms.map((room) => [room.id, room]));
  return {
    ...base,
    retired: edited.retired,
    name: edited.name,
    description: edited.description,
    environment: edited.environment,
    portals: edited.portals as InteriorSpace["portals"],
    rooms: edited.rooms.map((room) => mergeRoom(room, baseRooms.get(room.id), portalKeys, base.revision, authoringOf(room)))
  };
}

/** An anchor display name: the authored one, else what is stored. */
function anchorName(authoring: RoomAuthoring, base: InteriorRoom | undefined, anchorId: string): string | undefined {
  if (authoring.anchorNames) return authoring.anchorNames[anchorId];
  return base?.anchors.find((anchor) => anchor.id === anchorId)?.name;
}

/** Floors, walls, click areas and explicitly authored anchor roles on top of a room the dungeon transform produced. */
function applyRoomAuthoring(room: InteriorRoom, authoring: RoomAuthoring): InteriorRoom {
  return {
    ...room,
    floors: authoring.floors,
    walls: authoring.walls,
    clickAreas: authoring.clickAreas,
    anchors: room.anchors.map((anchor): InteriorAnchor => {
      const override = authoring.anchors[anchor.id];
      const name = authoring.anchorNames?.[anchor.id];
      const named = (value: InteriorAnchor): InteriorAnchor => {
        const { name: _name, ...rest } = value;
        return name ? { ...rest, name } : rest;
      };
      if (!override || anchor.role === "spawn") return named(anchor);
      const { message: _message, ...plain } = anchor;
      return named({ ...plain, role: override.role, ...(override.role === "message" && override.message ? { message: override.message } : {}) });
    })
  };
}

/**
 * The interior catalog the editing view stands for (revisions untouched).
 * Dungeon spaces go through the same transform the old dungeon path used.
 */
export function interiorFromEditingView(base: InteriorCatalog, seeds: InteriorSeedSpaces, view: AuthoringView): InteriorCatalog {
  const kindOf = (id: string): InteriorSpaceKind => interiorSpaceKind(base, seeds, id);
  const sources = { base, seeds };
  const dungeonOutput = fromDungeonCatalog({ ...view, dungeons: view.dungeons.filter((dungeon) => kindOf(dungeon.id) === "dungeon") });
  const dungeonSpaces = new Map(dungeonOutput.spaces.map((space) => [space.id, space]));
  const spaces = view.dungeons.map((definition): InteriorSpace => {
    if (kindOf(definition.id) === "dungeon") {
      const space = dungeonSpaces.get(definition.id)!;
      return {
        ...space,
        rooms: space.rooms.map((room) => {
          const edited = definition.rooms.find((candidate) => candidate.id === room.id);
          return edited ? applyRoomAuthoring(room, effectiveRoomAuthoring(view, sources, definition.id, edited)) : room;
        })
      };
    }
    const skeleton = base.spaces.find((space) => space.id === definition.id) ?? seeds[definition.id]!;
    return applyModuleEdits(
      mergeEditedSpace(definition, skeleton, (room) => effectiveRoomAuthoring(view, sources, definition.id, room)),
      view.interiorModules?.[definition.id]
    );
  });
  const baseFeatures = new Map(base.library.prefabs.map((prefab) => [prefab.id, prefab]));
  const library: InteriorLibrary = {
    schemaVersion: 1,
    catalogRevision: base.library.catalogRevision,
    prefabs: view.prefabs.map((prefab) => {
      const previous = baseFeatures.get(prefab.id);
      const edited = prefab as ViewPrefab;
      return {
        ...prefab,
        ...(edited.footprint === undefined && previous?.footprint ? { footprint: previous.footprint } : {}),
        ...(edited.touchArea === undefined && previous?.touchArea ? { touchArea: previous.touchArea } : {})
      };
    }),
    rewardTables: view.rewardTables,
    rewardTableIds: view.rewardTableIds,
    bossTemplates: view.bossTemplates,
    bossTemplateIds: view.bossTemplateIds,
    entrances: view.entrances
  };
  return { library, spaces };
}

// ---------------------------------------------------------------------------
// Permanence: revisions
// ---------------------------------------------------------------------------

/** `x-v3` -> `x-v4`, `x-r6` -> `x-r7`; anything else gets `-v2`. */
export function nextRevision(revision: string): string {
  const match = /^(.*?)(\d+)$/u.exec(revision);
  return match ? `${match[1]}${Number(match[2]) + 1}` : `${revision}-v2`;
}

function stableText(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, sort(entry)]));
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

function withoutKeys<T extends object>(value: T, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of keys) delete copy[key];
  return copy;
}

const SPACE_IDENTITY_KEYS = ["revision", "publishedRevisionId", "catalogRevision"] as const;

/** True when the stored space differs from `next` in anything but its revision identity. */
export function interiorSpaceChanged(base: InteriorSpace | undefined, next: InteriorSpace): boolean {
  if (!base) return true;
  // Rooms carry their own revision; comparing whole spaces (revisions of the rooms included) is right for "did it change".
  return stableText(withoutKeys(base, SPACE_IDENTITY_KEYS)) !== stableText(withoutKeys(next, SPACE_IDENTITY_KEYS));
}

/**
 * Changed rooms and spaces of already-published spaces get a new revision
 * (dungeon rooms always share the dungeon's revision, as the dungeon transform
 * writes them). Nothing changes for untouched spaces or spaces new to the catalog.
 */
export function bumpInteriorRevisions(base: InteriorCatalog, proposed: InteriorCatalog): InteriorCatalog {
  const spaces = proposed.spaces.map((space): InteriorSpace => {
    const previous = base.spaces.find((candidate) => candidate.id === space.id);
    if (!previous) return space;
    if (!interiorSpaceChanged(previous, space) && !greenhouseTemplatesChanged(base, proposed, space)) return previous;
    const revision = space.revision === previous.revision ? nextRevision(previous.revision) : space.revision;
    const publishedRevisionId = previous.publishedRevisionId !== undefined && space.publishedRevisionId === previous.publishedRevisionId
      ? nextRevision(previous.publishedRevisionId)
      : space.publishedRevisionId;
    const rooms = space.rooms.map((room): InteriorRoom => {
      if (space.kind === "dungeon") return { ...room, revision };
      const before = previous.rooms.find((candidate) => candidate.id === room.id);
      if (!before) return room;
      const roomChanged = stableText(withoutKeys(before, ["revision"])) !== stableText(withoutKeys(room, ["revision"]));
      return roomChanged && room.revision === before.revision ? { ...room, revision: nextRevision(before.revision) } : room;
    });
    return { ...space, revision, ...(publishedRevisionId !== undefined ? { publishedRevisionId } : {}), rooms };
  });
  return { library: proposed.library, spaces };
}

/**
 * A greenhouse's placement templates are library prefabs (the Farm Plot and the
 * water tank), yet they are part of what the runtime reads as the greenhouse:
 * editing one changes the greenhouse, so it needs a new space revision.
 */
function greenhouseTemplatesChanged(base: InteriorCatalog, proposed: InteriorCatalog, space: InteriorSpace): boolean {
  if (space.kind !== "greenhouse") return false;
  const ids = [space.modules?.planters?.potPrefabId, GREENHOUSE_WATER_TANK_PREFAB_ID];
  return ids.some((id) => id !== undefined &&
    stableText(base.library.prefabs.find((prefab) => prefab.id === id)) !== stableText(proposed.library.prefabs.find((prefab) => prefab.id === id)));
}

/** Ids of the spaces that differ from `base` (new spaces included). */
export function changedInteriorSpaceIds(base: InteriorCatalog, proposed: InteriorCatalog): string[] {
  return proposed.spaces
    .filter((space) => interiorSpaceChanged(base.spaces.find((candidate) => candidate.id === space.id), space) ||
      (base.spaces.some((candidate) => candidate.id === space.id) && greenhouseTemplatesChanged(base, proposed, space)))
    .map((space) => space.id);
}

export function interiorLibraryChanged(base: InteriorLibrary, proposed: InteriorLibrary): boolean {
  return stableText({ ...base, catalogRevision: 0 }) !== stableText({ ...proposed, catalogRevision: 0 });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type InteriorViewIssue = Readonly<{ path: string; message: string }>;

/**
 * Validation of the editing view: the unified catalog validator over the
 * catalog it stands for, with paths rewritten to the editing view's
 * `dungeons.<id>` shape so the Studio can open the offending room.
 */
export function interiorViewIssues(base: InteriorCatalog, seeds: InteriorSeedSpaces, view: AuthoringView): InteriorViewIssue[] {
  let proposed: InteriorCatalog;
  try {
    proposed = interiorFromEditingView(base, seeds, view);
  } catch (error) {
    return [{ path: "$", message: error instanceof Error ? error.message : "The interior catalog could not be assembled" }];
  }
  const dungeonIds = proposed.spaces.filter((space) => space.kind === "dungeon").map((space) => space.id);
  const issues: InteriorViewIssue[] = [];
  for (const issue of interiorCatalogValidationIssues(proposed)) {
    let path = issue.path;
    if (path.startsWith("dungeonView.")) {
      path = path.slice("dungeonView.".length).replace(/^dungeons\.(\d+)/u, (_match, index: string) => `dungeons.${dungeonIds[Number(index)] ?? index}`);
    } else {
      path = path.replace(/^spaces\.(\d+)/u, (_match, index: string) => `dungeons.${proposed.spaces[Number(index)]?.id ?? index}`);
    }
    // Room paths written with room ids by the validator stay as they are.
    issues.push({ path, message: issue.message });
  }
  // The greenhouse the runtime reads (the first one) must still satisfy the rules it is read under: template geometry, stage art.
  const runtimeGreenhouse = proposed.spaces.find((space) => space.kind === "greenhouse");
  if (runtimeGreenhouse && !runtimeGreenhouse.retired && base.spaces.some((stored) => stored.id === runtimeGreenhouse.id)) {
    try {
      parseGreenhouseStudioCatalog(greenhouseStudioInputFromInterior(runtimeGreenhouse, proposed.library.prefabs));
    } catch (error) {
      issues.push({ path: `dungeons.${runtimeGreenhouse.id}`, message: `Greenhouse rules: ${error instanceof Error ? error.message : "the greenhouse could not be read"}` });
    }
  }
  // Dungeon rules are reported by both the dungeon view and the space rules; show each message once.
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\0${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// New interiors
// ---------------------------------------------------------------------------

const NEW_ROOM_SIZE = 1000;
const WORLD_EXIT_ANCHOR_ID = "world_exit";
/** Manor templates carry a theme (colors and floor art) the Manor catalog view requires. */
const MANOR_THEME = {
  backgroundColor: "#071116",
  floorColor: "#182a2d",
  wallColor: "#405052",
  floorAssetKey: "apps/client/src/assets/structures/manor-floor.png"
} as const;

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  for (let index = 2; taken.has(candidate); index += 1) candidate = `${base}_${index}`;
  return candidate;
}

/**
 * A minimal, valid non-dungeon space: one room with a spawn, an authored
 * world-exit portal (anchor, portal record and click area), and the modules
 * its kind requires. Throws when the library lacks what the kind needs.
 */
export function createInteriorSpace(
  kind: Exclude<InteriorSpaceKind, "dungeon">,
  name: string,
  library: InteriorLibrary,
  takenIds: ReadonlySet<string>
): InteriorSpace {
  const displayName = name.trim();
  if (!displayName) throw new Error("Name the new interior.");
  const id = uniqueId(slug(displayName) || kind, takenIds);
  const roomId = uniqueId(`${id}_main_room`, takenIds);
  const revision = `${id}-v1`;
  const size = NEW_ROOM_SIZE;
  const exit = { x: 830, y: 830 };
  const modules: NonNullable<InteriorSpace["modules"]> = kind === "manor"
    ? { decoration: { definitions: [], playerPlacement: { enabled: false } } }
    : kind === "salon" ? { salon: {} } : (() => {
      const pot = library.prefabs.find((prefab) => prefab.id === GREENHOUSE_POT_PREFAB_ID && !prefab.retired && prefab.type === "object")
        ?? library.prefabs.find((prefab) => !prefab.retired && prefab.type === "object" && prefab.id.startsWith("greenhouse"));
      if (!pot) throw new Error("A greenhouse needs a pot prefab in the library before it can be created.");
      return { planters: { capacity: 1, potPrefabId: pot.id, stageArt: [] } };
    })();
  return {
    id,
    kind,
    revision,
    ...(kind === "manor" ? { publishedRevisionId: `${id}-r1` } : {}),
    retired: false,
    name: displayName,
    description: `${displayName} (${INTERIOR_KIND_LABELS[kind].toLowerCase()} interior).`,
    spatialProfileId: "standard_indoor",
    instancePolicy: kind === "salon" ? "shared_persistent" : "owner_persistent",
    defaultRoomId: roomId,
    environment: {
      environmentId: id,
      ...(kind === "manor" ? MANOR_THEME : {}),
      musicAssetKey: null,
      ambienceAssetKey: null
    },
    rooms: [{
      id: roomId,
      revision,
      retired: false,
      active: true,
      aliases: [],
      name: displayName,
      width: size,
      height: size,
      spawnAnchorId: "spawn",
      camera: { mode: "fixed_center", center: { x: size / 2, y: size / 2 }, fitPadding: 16, defaultZoom: 1, minZoom: 0.5, maxZoom: 1.6 },
      environment: { environmentId: id, visualTreatmentId: null, musicAssetKey: null, ambienceAssetKey: null },
      floors: [{ id: "floor", retired: false, polygon: insetFloorPolygon(size, size) }],
      walls: [],
      colliders: [],
      zones: [],
      layers: { background: [], below_player: [], actors: [], above_player: [], ceiling: [] },
      anchors: [
        { id: "spawn", retired: false, x: size / 2, y: 780, role: "spawn" },
        { id: WORLD_EXIT_ANCHOR_ID, retired: false, x: exit.x, y: exit.y, role: "portal" }
      ],
      clickAreas: [{
        id: `${WORLD_EXIT_ANCHOR_ID}_click_area`,
        retired: false,
        polygon: [
          { x: exit.x - 60, y: exit.y - 60 }, { x: exit.x + 60, y: exit.y - 60 },
          { x: exit.x + 60, y: exit.y + 60 }, { x: exit.x - 60, y: exit.y + 60 }
        ],
        target: { anchorId: WORLD_EXIT_ANCHOR_ID },
        interactionLabel: `Leave ${displayName}`
      }],
      objects: [],
      mobs: []
    }],
    portals: [{
      id: `${roomId}-${WORLD_EXIT_ANCHOR_ID}`,
      retired: false,
      source: { kind: "room", roomId, anchorId: WORLD_EXIT_ANCHOR_ID },
      destination: { kind: "world" },
      sourceApproachAnchorId: WORLD_EXIT_ANCHOR_ID,
      conditions: ["always"],
      interactionLabel: `Leave ${displayName}`,
      presentation: "door",
      enabled: true
    }],
    modules
  };
}

/** Ids a new space's id, room ids and aliases must not collide with. */
export function takenInteriorIds(interior: InteriorCatalog, view: DungeonCatalog): Set<string> {
  const taken = new Set<string>();
  for (const space of interior.spaces) {
    taken.add(space.id);
    for (const room of space.rooms) { taken.add(room.id); for (const alias of room.aliases) taken.add(alias); }
  }
  for (const dungeon of view.dungeons) {
    taken.add(dungeon.id);
    for (const room of dungeon.rooms) taken.add(room.id);
  }
  return taken;
}
