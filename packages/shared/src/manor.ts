import type { PlayerInventorySnapshot, ResourceType } from "./collectibles.js";
import type { EquipmentInstanceV2, EquipmentSnapshotV2 } from "./equipment.js";
import type { PlayerAppearanceSnapshot } from "./appearance.js";
import type { AchievementSnapshot } from "./achievements.js";
import type { EnchantmentStoneVariant } from "./progression.js";
import type { EquipmentMetal } from "./equipmentEnhancements.js";
import { MANOR_STORAGE_CAPACITY_GRAMS } from "./inventoryWeight.js";
import type { ManorWarfareSnapshot } from "./manorWarfare.js";
import type {
  BackpackInstanceSnapshot,
  BackpackSnapshot
} from "./backpacks.js";
import type {
  ManorDecorationDefinition,
  ManorDecorationTransform,
  ManorTemplateDefinition
} from "./manorTemplateCatalog.js";
import {
  DEFAULT_MANOR_TEMPLATE_CATALOG,
  manorTemplateRoomNavigation
} from "./manorTemplateCatalog.js";
import { INTERIOR_DATA } from "./data/interiors/index.js";
import type { InteriorCatalog, InteriorRoom, InteriorSpace } from "./interior/interiorCatalog.js";
import { manorSpacesOf } from "./interior/manorView.js";
import { DEFAULT_MANOR_TYPE_ID, manorSkinPriceGlimmer } from "./manorSkins.js";
import { worldExitOf } from "./interior/interiorRoomRuntime.js";
import {
  STANDARD_INDOOR_SPATIAL_PROFILE,
  type IndoorNavigationCollider,
  type IndoorPoint,
  type IndoorPosition,
  type IndoorRoomNavigation
} from "./indoor.js";

export type ManorSpaceId = string;

export { DEFAULT_MANOR_TYPE_ID };
/** Runtime space id of every Manor type's entrance room (the legacy lobby alias). */
export const MANOR_ENTRANCE_SPACE_ID = "manor_main_room";

const manorTypeSpaces: ReadonlyMap<string, InteriorSpace> = new Map(
  manorSpacesOf(INTERIOR_DATA as unknown as InteriorCatalog).map((space) => [space.id, space])
);
const manorTypeTemplates: ReadonlyMap<string, ManorTemplateDefinition> = new Map(
  DEFAULT_MANOR_TEMPLATE_CATALOG.templates.map((template) => [template.id, template])
);
if (!manorTypeSpaces.has(DEFAULT_MANOR_TYPE_ID) || !manorTypeTemplates.has(DEFAULT_MANOR_TYPE_ID)) {
  throw new Error(`The default Manor type ${DEFAULT_MANOR_TYPE_ID} is missing from the interior catalog`);
}

export type ManorTypeSummary = Readonly<{
  id: string;
  name: string;
  description: string;
  /** Overworld building PNG; null draws the shared Manor sprite. */
  exteriorAssetKey: string | null;
  exteriorScale: number;
  /** Glimmer price of this type's skin item; null for the default type (no skin needed). */
  skinPriceGlimmer: number | null;
}>;

/** Every published Manor type a player Manor may use, the default first. */
export const MANOR_TYPES: readonly ManorTypeSummary[] = Object.freeze(
  [...manorTypeTemplates.values()]
    .filter((template) => !template.retired)
    .sort((left, right) => Number(right.id === DEFAULT_MANOR_TYPE_ID) - Number(left.id === DEFAULT_MANOR_TYPE_ID))
    .map((template) => Object.freeze({
      id: template.id,
      name: template.name,
      description: template.description,
      exteriorAssetKey: template.exterior?.assetKey ?? null,
      exteriorScale: template.exterior?.scale ?? 1,
      skinPriceGlimmer: template.id === DEFAULT_MANOR_TYPE_ID ? null : manorSkinPriceGlimmer(template.id)
    }))
);

/** True for a published, non-retired Manor type id. */
export function isManorTypeId(value: unknown): value is string {
  return typeof value === "string" && MANOR_TYPES.some((type) => type.id === value);
}

/** The Manor type a stored id stands for; unknown ids fall back to the default type. */
export function resolveManorTypeId(typeId: string | null | undefined): string {
  return typeId && manorTypeTemplates.has(typeId) ? typeId : DEFAULT_MANOR_TYPE_ID;
}

export function manorTypeTemplate(typeId?: string | null): ManorTemplateDefinition {
  return manorTypeTemplates.get(resolveManorTypeId(typeId))!;
}

/** The unified interior space of a Manor type (`data/interiors/<type>.json`). */
export function manorTypeSpace(typeId?: string | null): InteriorSpace {
  return manorTypeSpaces.get(resolveManorTypeId(typeId))!;
}

export function manorTypeSummary(typeId?: string | null): ManorTypeSummary {
  const id = resolveManorTypeId(typeId);
  return MANOR_TYPES.find((type) => type.id === id) ?? MANOR_TYPES[0]!;
}

/** The active authored room a runtime space id names inside a Manor type, if that type has it. */
export function manorAuthoredRoom(spaceId: string, typeId?: string | null) {
  const template = manorTypeTemplate(typeId);
  const roomId = spaceId === MANOR_ENTRANCE_SPACE_ID ? template.defaultRoomId : spaceId;
  return template.rooms.find((room) => !room.retired && room.active && room.id === roomId);
}

/** Every room id of a Manor type (retired ones included): its decorations live in these rooms. */
export function manorTypeRoomIds(typeId?: string | null): readonly string[] {
  return manorTypeSpace(typeId).rooms.map((room) => room.id);
}

/** The unified interior room a runtime space id names inside a Manor type, if active. */
export function manorInteriorRoom(spaceId: string, typeId?: string | null): InteriorRoom | undefined {
  const space = manorTypeSpace(typeId);
  const roomId = spaceId === MANOR_ENTRANCE_SPACE_ID ? space.defaultRoomId : spaceId;
  return space.rooms.find((room) => !room.retired && room.active && room.id === roomId);
}

/** Runtime space id of an authored room: each type's entrance room is `manor_main_room`. */
export function manorAuthoredSpaceId(roomId: string, typeId?: string | null): string {
  return roomId === manorTypeTemplate(typeId).defaultRoomId ? MANOR_ENTRANCE_SPACE_ID : roomId;
}

/**
 * Runtime portal id of a Manor door. A door with several destinations names the
 * destination room; a single-destination door keeps the short legacy id.
 */
export function manorAuthoredPortalId(manorId: string, roomId: string, anchorId: string, destinationRoomId?: string): string {
  return `manor:${manorId}:room:${roomId}:${anchorId}${destinationRoomId ? `:${destinationRoomId}` : ""}`;
}

/** The default Manor type as a unified interior space (packages/shared/src/data/interiors/manor_lobby.json). */
export const MANOR_INTERIOR_SPACE: InteriorSpace = manorTypeSpace(DEFAULT_MANOR_TYPE_ID);
/** The Manor lobby room (`manor_lobby_room`, aliased `manor_main_room`) of {@link MANOR_INTERIOR_SPACE}. */
export const MANOR_LOBBY_INTERIOR_ROOM: InteriorRoom = MANOR_INTERIOR_SPACE.rooms.find((room) =>
  room.id === MANOR_INTERIOR_SPACE.defaultRoomId)!;

export type ManorStationKind = "smith" | "jewel" | "breeder";
export type ManorStationPoint = Readonly<{ x: number; y: number; radius: number }>;

/**
 * Where the lobby stations stand in a Manor type: the authored station objects
 * (and their anchors) of the type's entrance room. A type without a station
 * simply has none.
 */
export function manorLobbyStations(typeId?: string | null): Readonly<Partial<Record<ManorStationKind, ManorStationPoint>>> {
  const space = manorTypeSpace(typeId);
  const lobby = space.rooms.find((room) => room.id === space.defaultRoomId)!;
  const stations: Partial<Record<ManorStationKind, ManorStationPoint>> = {};
  for (const object of lobby.objects) {
    const kind = object.stationKind;
    if (object.retired || object.type !== "station" || (kind !== "smith" && kind !== "jewel" && kind !== "breeder")) continue;
    const anchor = lobby.anchors.find((candidate) => candidate.id === object.anchorId && !candidate.retired);
    if (anchor && !stations[kind]) stations[kind] = Object.freeze({ x: anchor.x, y: anchor.y, radius: object.interactionRadius });
  }
  return Object.freeze(stations);
}

type ManorFixtureDefinition = Readonly<{
  position: IndoorPoint;
  collider: IndoorNavigationCollider;
}>;

const manorLobbyTemplate = manorTypeTemplate(DEFAULT_MANOR_TYPE_ID);
const manorLobbyRoom = manorLobbyTemplate.rooms.find((room) =>
  room.id === manorLobbyTemplate.defaultRoomId && !room.retired && room.active
)!;
const manorLobbyNavigation = manorTemplateRoomNavigation(manorLobbyRoom);
const manorRoomScaleX = manorLobbyRoom.width / STANDARD_INDOOR_SPATIAL_PROFILE.roomWidth;
const manorRoomScaleY = manorLobbyRoom.height / STANDARD_INDOOR_SPATIAL_PROFILE.roomHeight;
const manorLobbySpawn = Object.freeze({
  x: manorLobbyRoom.anchors.find((anchor) => anchor.id === manorLobbyRoom.spawnAnchorId)!.x,
  y: manorLobbyRoom.anchors.find((anchor) => anchor.id === manorLobbyRoom.spawnAnchorId)!.y
});
const defaultManorStations = manorLobbyStations(DEFAULT_MANOR_TYPE_ID);

const roundUnits = (value: number): number => Math.round(value * 1e6) / 1e6;

/** A fixture at an authored point with a collision box measured in standard-room units around it. */
function manorFixture(
  id: string,
  position: IndoorPoint,
  box: Readonly<{ left: number; right: number; top: number; bottom: number }>
): ManorFixtureDefinition {
  return Object.freeze({
    position: Object.freeze({ x: position.x, y: position.y }),
    collider: Object.freeze({
      id,
      minX: roundUnits(position.x - box.left * manorRoomScaleX),
      maxX: roundUnits(position.x + box.right * manorRoomScaleX),
      minY: roundUnits(position.y - box.top * manorRoomScaleY),
      maxY: roundUnits(position.y + box.bottom * manorRoomScaleY)
    })
  });
}

function requireDefaultStation(kind: ManorStationKind): ManorStationPoint {
  const station = defaultManorStations[kind];
  if (!station) throw new Error(`The default Manor lobby has no ${kind} station`);
  return station;
}

// The chest has no authored station object; it keeps its legacy lobby point.
const manorChestFixture = manorFixture("manor_chest",
  { x: 700 * manorRoomScaleX, y: 245 * manorRoomScaleY }, { left: 45, right: 45, top: 40, bottom: 40 });
const manorSmithFixture = manorFixture("manor_smith", requireDefaultStation("smith"), { left: 50, right: 50, top: 50, bottom: 50 });
const manorJewelFixture = manorFixture("manor_jewel", requireDefaultStation("jewel"), { left: 45, right: 45, top: 50, bottom: 50 });
const manorBreederFixture = manorFixture("manor_breeder", requireDefaultStation("breeder"), { left: 55, right: 55, top: 45, bottom: 40 });

export const MANOR_MAIN_ROOM = Object.freeze({
  spaceId: "manor_main_room" as const,
  roomWidth: manorLobbyRoom.width,
  roomHeight: manorLobbyRoom.height,
  playerRadius: manorLobbyNavigation.playerRadius,
  spawn: manorLobbySpawn,
  fixtures: Object.freeze({
    chest: manorChestFixture,
    smith: manorSmithFixture,
    jewel: manorJewelFixture,
    breeder: manorBreederFixture
  }),
  colliders: Object.freeze([
    ...manorLobbyNavigation.colliders
  ]),
  ...(manorLobbyNavigation.walkableSurfaces ? {
    walkableSurfaces: manorLobbyNavigation.walkableSurfaces
  } : {})
});

export const MANOR_FOYER_ROOM = Object.freeze({
  spaceId: "manor_foyer" as const,
  roomWidth: STANDARD_INDOOR_SPATIAL_PROFILE.roomWidth,
  roomHeight: STANDARD_INDOOR_SPATIAL_PROFILE.roomHeight,
  playerRadius: STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius,
  spawn: STANDARD_INDOOR_SPATIAL_PROFILE.spawn,
  fixtures: Object.freeze({}),
  colliders: Object.freeze([] as IndoorNavigationCollider[])
});

export const MANOR_ROOM_DEFINITIONS = Object.freeze({
  manor_main_room: MANOR_MAIN_ROOM,
  manor_foyer: MANOR_FOYER_ROOM
});

export function manorRoomNavigation(spaceId: ManorSpaceId, typeId?: string | null): IndoorRoomNavigation {
  if (spaceId === "manor_foyer") return MANOR_FOYER_ROOM;
  const room = manorAuthoredRoom(spaceId, typeId);
  if (!room) throw new Error(`Unknown Manor space: ${spaceId}`);
  return manorTemplateRoomNavigation(room);
}

export const MANOR_FLOOR_SIZE = MANOR_MAIN_ROOM.roomWidth;
export const MANOR_PLAYER_VISUAL_HEIGHT_UNITS =
  STANDARD_INDOOR_SPATIAL_PROFILE.playerVisualHeightUnits;
export const MANOR_PLAYER_RADIUS = MANOR_MAIN_ROOM.playerRadius;
export const MANOR_MOVE_SPEED = STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond;
export const MANOR_MAX_TARGET_DISTANCE = STANDARD_INDOOR_SPATIAL_PROFILE.maxTargetDistance;
export const MANOR_SPAWN = MANOR_MAIN_ROOM.spawn;
export const MANOR_CHEST = MANOR_MAIN_ROOM.fixtures.chest.position;
/** Shared local anchor for the retired storage recovery pile. */
export const MANOR_STORAGE_RECOVERY_PILE = Object.freeze({
  x: MANOR_CHEST.x,
  y: MANOR_CHEST.y
});
export const MANOR_CHEST_INTERACTION_RADIUS = 120;
export const MANOR_SMITH = MANOR_MAIN_ROOM.fixtures.smith.position;
// The reduced top-right station art is a compact interaction target. Keep the
// shared action radius large enough for the canonical approach point to be
// comfortably reachable while leaving the station visuals non-blocking.
export const MANOR_SMITH_INTERACTION_RADIUS = 130;
export const MANOR_JEWEL = MANOR_MAIN_ROOM.fixtures.jewel.position;
export const MANOR_JEWEL_INTERACTION_RADIUS = 130;
export const MANOR_BREEDER = MANOR_MAIN_ROOM.fixtures.breeder.position;
export const MANOR_BREEDER_INTERACTION_RADIUS = 110;
/** The default Manor type world-exit door (its authored `world_exit` anchor in the lobby). */
export const MANOR_DOOR: IndoorPoint = Object.freeze({ ...worldExitOf(MANOR_INTERIOR_SPACE)!.position });
export const MANOR_DOOR_INTERACTION_RADIUS = STANDARD_INDOOR_SPATIAL_PROFILE.doorInteractionRadius;
export const MANOR_INTERACTION_APPROACH_INSET = 25;
export const MANOR_DOOR_APPROACH_RADIUS =
  MANOR_DOOR_INTERACTION_RADIUS - MANOR_INTERACTION_APPROACH_INSET;
export const MANOR_ENTER_DISTANCE_METERS = 20;
export const MANOR_KICK_REENTRY_LOCK_MS = 60_000;
export const MANOR_STORAGE_UNLOCKED_SLOTS = 60;
export const MANOR_BUILD_DURATION_MS = 30_000;
export const MANOR_BUILD_WOOD_COST = 100;

/**
 * Manor storage is weight based. Keep the level and recipe table in shared
 * code so the server, client and protocol all present the same progression.
 * Costs are deliberately integer material quantities and whole gold pieces.
 */
export const MANOR_STORAGE_UPGRADE_MAX_LEVEL = 3;
export const MANOR_STORAGE_BASE_CAPACITY_GRAMS = MANOR_STORAGE_CAPACITY_GRAMS;

export type ManorStorageUpgradeMaterialCost = Readonly<{
  itemId: Extract<ResourceType, "wood" | "stone">;
  quantity: number;
}>;

export type ManorStorageUpgradeDefinition = Readonly<{
  level: 1 | 2 | 3;
  capacityBonusGrams: number;
  capacityGrams: number;
  materials: readonly ManorStorageUpgradeMaterialCost[];
  gold: number;
}>;

export const MANOR_STORAGE_UPGRADES: readonly ManorStorageUpgradeDefinition[] = Object.freeze([
  Object.freeze({
    level: 1 as const,
    capacityBonusGrams: 5_000_000,
    capacityGrams: 15_000_000,
    materials: Object.freeze([
      Object.freeze({ itemId: "wood" as const, quantity: 500 }),
      Object.freeze({ itemId: "stone" as const, quantity: 250 })
    ]),
    gold: 5_000
  }),
  Object.freeze({
    level: 2 as const,
    capacityBonusGrams: 10_000_000,
    capacityGrams: 25_000_000,
    materials: Object.freeze([
      Object.freeze({ itemId: "wood" as const, quantity: 1_000 }),
      Object.freeze({ itemId: "stone" as const, quantity: 500 })
    ]),
    gold: 15_000
  }),
  Object.freeze({
    level: 3 as const,
    capacityBonusGrams: 15_000_000,
    capacityGrams: 40_000_000,
    materials: Object.freeze([
      Object.freeze({ itemId: "wood" as const, quantity: 2_000 }),
      Object.freeze({ itemId: "stone" as const, quantity: 1_000 })
    ]),
    gold: 35_000
  })
]);

export function manorStorageCapacityForLevel(level: number): number {
  if (level <= 0) return MANOR_STORAGE_BASE_CAPACITY_GRAMS;
  const upgrade = MANOR_STORAGE_UPGRADES[level - 1];
  if (!upgrade) return MANOR_STORAGE_UPGRADES.at(-1)!.capacityGrams;
  return upgrade.capacityGrams;
}

export function manorStorageUpgradeForLevel(level: number): ManorStorageUpgradeDefinition | null {
  return MANOR_STORAGE_UPGRADES.find((upgrade) => upgrade.level === level) ?? null;
}

export type ManorOccupantAccessSource = "OWNER" | "PARTY" | "TRAVEL_INVITE";

export type ManorOccupantSnapshot = {
  playerId: string;
  displayName: string;
  displayColor: string | null;
  accessSource: Exclude<ManorOccupantAccessSource, "OWNER">;
};

export type ManorOccupantPresenceSnapshot = Omit<ManorOccupantSnapshot, "accessSource"> & {
  accessSource: ManorOccupantAccessSource;
  appearance?: PlayerAppearanceSnapshot;
  spaceId: ManorSpaceId;
  position: ManorPosition;
  movementSequence: number;
};

export type ManorBannedPlayerSnapshot = {
  playerId: string;
  displayName: string;
  displayColor: string | null;
  createdAt: string;
};

export type ManorGuestManagementSnapshot = {
  manorId: string;
  guests: ManorOccupantSnapshot[];
  bannedPlayers: ManorBannedPlayerSnapshot[];
};

export type ManorPosition = IndoorPosition;

/** A Studio-published decoration definition plus the owner's current availability. */
export type ManorDecorationCatalogEntry = {
  definition: ManorDecorationDefinition;
  ownedQuantity: number;
  availableQuantity: number;
};

/** One durable Manor placement and its exact authored transform. */
export type ManorDecorationPlacement = {
  placementId: string;
  definitionId: string;
  /** Null for universal decorations or authored template defaults. */
  itemId: string | null;
  itemVariant: string | null;
  roomId: string;
  surfaceId: string;
  transform: ManorDecorationTransform;
  /** True when this placement comes directly from the published template catalog. */
  authoredDefault?: boolean;
};

export type ManorDecorationSnapshot = {
  manorId: string;
  roomWidth: number;
  roomHeight: number;
  definitions: ManorDecorationCatalogEntry[];
  placements: ManorDecorationPlacement[];
};

export type ManorDecorationMutationResult = {
  requestId: string;
  action: "place" | "move" | "remove";
  snapshot: ManorDecorationSnapshot;
  inventory: PlayerInventorySnapshot;
  placement: ManorDecorationPlacement | null;
  replayed: boolean;
  message: string;
};

export type ManorStorageStack = {
  stackId: string;
  slotIndex: number;
  itemId: ResourceType;
  variant: string | null;
  quantity: number;
  /** Authoritative runtime limit supplied by the server item catalog. */
  maxStack?: number;
  manualSplit: boolean;
  version: number;
};

export type ManorStorageEquipment = {
  equipmentInstanceId: string;
  slotIndex: number;
  equipment: EquipmentInstanceV2;
};

export type ManorStorageBackpack = {
  backpackInstanceId: string;
  slotIndex: number;
  backpack: BackpackInstanceSnapshot;
};

export type ManorStorageSlot =
  | ({ kind: "stack" } & ManorStorageStack)
  | ({ kind: "equipment" } & ManorStorageEquipment)
  | ({ kind: "backpack" } & ManorStorageBackpack);

export type ManorStorageOverflowStack = {
  stackId: string;
  sourceOrder: number;
  itemId: ResourceType;
  variant: string | null;
  quantity: number;
};

export type ManorStorageSnapshot = {
  manorId: string;
  /** Decimal integer grams; storage capacity is weight authority. */
  currentWeightGrams?: string;
  maximumWeightGrams?: string;
  stacks: ManorStorageStack[];
  equipment: ManorStorageEquipment[];
  backpacks: ManorStorageBackpack[];
  slots: ManorStorageSlot[];
  overflowStacks: ManorStorageOverflowStack[];
  /** Historical compatibility projection; never gates storage. */
  unlockedSlots: 60;
};

export type ManorWorldSnapshot = {
  manorId: string;
  ownerPlayerId: string;
  ownerUsername: string;
  regionCode: string;
  lat: number;
  lon: number;
  builtAt: string;
  placementRevision: number;
  /** Manor type (interior space id) the Manor uses; absent means {@link DEFAULT_MANOR_TYPE_ID}. */
  manorTypeId?: string;
  /** War health checkpoint (Manor House); absent means full health. */
  warfare?: ManorWarfareSnapshot;
};

export type ManorTransferDirection = "deposit" | "withdrawal";

export type ManorStorageAction =
  | "move"
  | "split"
  | "restack"
  | "reorganize"
  | "transfer"
  | "bulk_store"
  | "bulk_take";

export type ManorTransferSummary = {
  direction: ManorTransferDirection;
  stacksRequested: number;
  quantityRequested: number;
  stacksMoved: number;
  quantityMoved: number;
  stacksRemaining: number;
  quantityRemaining: number;
  partial: boolean;
  capacityReason: string | null;
  skipped: Array<{
    sourceId: string;
    kind: "stack" | "equipment" | "backpack";
    reason: string;
    quantity: number;
  }>;
};

export type ManorStorageResult = {
  requestId: string;
  action: ManorStorageAction;
  inventory: PlayerInventorySnapshot;
  equipment?: EquipmentSnapshotV2;
  backpacks?: BackpackSnapshot;
  storage: ManorStorageSnapshot;
  transfer: ManorTransferSummary | null;
  replayed: boolean;
  message: string;
};

export type ManorStorageUpgradeSnapshot = Readonly<{
  manorId: string;
  level: number;
  maximumLevel: typeof MANOR_STORAGE_UPGRADE_MAX_LEVEL;
  capacityGrams: string;
  upgrades: readonly ManorStorageUpgradeDefinition[];
  inventory: PlayerInventorySnapshot;
  walletGold: string;
  walletVersion: string;
}>;

export type ManorStorageUpgradeResult = Readonly<{
  requestId: string;
  targetLevel: number;
  snapshot: ManorStorageUpgradeSnapshot;
  replayed: boolean;
  message: string;
}>;

export type JewelStationState = Readonly<{
  equipment: EquipmentSnapshotV2;
  inventory: PlayerInventorySnapshot;
  achievements: AchievementSnapshot;
}>;

export type JewelStationMutationResult = Readonly<{
  requestId: string;
  action: "prepare" | "imbue" | "reforge";
  instanceId: string;
  /** Null for gem-less metal infusions. */
  gemstone: EnchantmentStoneVariant | null;
  /** The metal applied (imbue) or stripped (reforge). */
  metal?: EquipmentMetal;
  /** Reforge only: what the request changed. */
  metalChanged?: boolean;
  gemstoneChanged?: boolean;
  replayed: boolean;
  state: JewelStationState;
}>;
