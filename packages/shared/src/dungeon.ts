import type { PlayerAppearanceSnapshot } from "./appearance.js";
import { MELEE_ATTACK_RANGE_M, RANGED_ATTACK_RANGE_M } from "./combat.js";
import type { BossEntityOwnership, BossEncounterProjection, BossCastSnapshot } from "./boss.js";
import type { MobArchetypeKey } from "./combat.js";
import type { DungeonChestRarity, DungeonResourceType } from "./dungeonCatalog.js";
import {
  STANDARD_INDOOR_SPATIAL_PROFILE,
  type IndoorPoint
} from "./indoor.js";
import { DEFAULT_PLAYER_SPEED_MPS } from "./gameplayArea.js";
import type { PlayerSnapshot } from "./playerSnapshotContracts.js";
import type { LatLon } from "./types.js";
import {
  CISTERN_WARRENS_DUNGEON,
  cisternWarrensRoomDefinition,
  dungeonAnchorDefinition,
  type DungeonDefinition,
  type DungeonPrefabDefinition,
  type DungeonRoomDefinition
} from "./dungeonCatalog.js";

export const CISTERN_WARRENS_NAME = "Cistern Warrens";
export const CISTERN_WARRENS_CLOSURE_MESSAGE =
  "Attention: The cistern warrens has been shut down following reports of massive, flesh-eating rats. It will reopen soon to adventurers brave enough to clean it out. Enter at your own risk—you have no insurance.";
export const CISTERN_WARRENS_DESCRIPTION =
  "A reinforced iron hatch descends into oil-fouled drainage tunnels beneath the city.";
export const CISTERN_WARRENS_ENTRY_RADIUS_M = 35;

/** Rollback-compatible encoding retained in cistern_warrens_presence and player location columns. */
export const CISTERN_WARRENS_LEGACY_STORED_FLOOR_SIZE = 160;
export const CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT =
  STANDARD_INDOOR_SPATIAL_PROFILE.roomWidth / CISTERN_WARRENS_LEGACY_STORED_FLOOR_SIZE;

export function cisternWarrensStoredPointToIndoor(point: IndoorPoint): IndoorPoint {
  return {
    x: point.x * CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT,
    y: point.y * CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT
  };
}

export function cisternWarrensIndoorPointToStored(point: IndoorPoint): IndoorPoint {
  return {
    x: point.x / CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT,
    y: point.y / CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT
  };
}

export function cisternWarrensStoredDistanceToIndoor(distance: number): number {
  return distance * CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT;
}

export function cisternWarrensIndoorDistanceToStored(distance: number): number {
  return distance / CISTERN_WARRENS_INDOOR_UNITS_PER_STORED_UNIT;
}

function navigationProjection(room: DungeonRoomDefinition) {
  return Object.freeze({
    spaceId: room.id,
    roomWidth: room.width,
    roomHeight: room.height,
    playerRadius: STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius,
    spawn: Object.freeze((() => {
      const anchor = dungeonAnchorDefinition(room, room.spawnAnchorId);
      return { x: anchor.x, y: anchor.y };
    })()),
    colliders: Object.freeze(room.colliders.filter((collider) => !collider.retired).map((collider) =>
      collider.kind === "polygon"
        ? Object.freeze({
          id: collider.id,
          kind: "polygon" as const,
          points: Object.freeze(collider.points.map((point) => Object.freeze({ ...point })))
        })
        : Object.freeze({
          id: collider.id,
          minX: collider.x,
          maxX: collider.x + collider.width,
          minY: collider.y,
          maxY: collider.y + collider.height
        })
    )),
    // Active floors are the legal feet-anchor area (Manor semantics). Published dungeon floors were full-room
    // rectangles inset by the player radius, so this only changes rooms whose floor follows painted walls.
    walkableSurfaces: Object.freeze((room.floors ?? []).filter((floor) => !floor.retired).map((floor) =>
      Object.freeze(floor.polygon.map((point) => Object.freeze({ x: point.x, y: point.y })))))
  });
}

const entranceRoom = cisternWarrensRoomDefinition("hatch_landing");
const entranceNavigation = navigationProjection(entranceRoom);

export const CISTERN_WARRENS_ENTRANCE_ROOM = Object.freeze({
  ...entranceNavigation,
  spaceId: "hatch_landing" as const,
  fixtures: Object.freeze({
    ladder: Object.freeze({
      position: Object.freeze((() => {
        const anchor = dungeonAnchorDefinition(entranceRoom, "world_exit");
        return { x: anchor.x, y: anchor.y };
      })())
    })
  })
});

export type CisternWarrensSpaceId = string;

export const CISTERN_WARRENS_ROOM_DEFINITIONS = Object.freeze({
  hatch_landing: CISTERN_WARRENS_ENTRANCE_ROOM
});

export function cisternWarrensRoomNavigation(
  spaceId: CisternWarrensSpaceId,
  dungeon: DungeonDefinition = CISTERN_WARRENS_DUNGEON
) {
  if (dungeon === CISTERN_WARRENS_DUNGEON && spaceId === "hatch_landing") {
    return CISTERN_WARRENS_ENTRANCE_ROOM;
  }
  return navigationProjection(cisternWarrensRoomDefinition(spaceId, dungeon));
}

export const CISTERN_WARRENS_FLOOR_SIZE = CISTERN_WARRENS_ENTRANCE_ROOM.roomWidth;
// Cistern Warrens keeps the authored room coordinates while presenting its player
// and mobs at half the standard indoor scale and moving at half the local
// indoor speed. The shared actor renderer derives mob size from this player
// height, so the relative mob-to-player presentation remains canonical.
export const CISTERN_WARRENS_MOVEMENT_SCALE = 0.5;
export const CISTERN_WARRENS_PLAYER_VISUAL_HEIGHT_UNITS =
  STANDARD_INDOOR_SPATIAL_PROFILE.playerVisualHeightUnits * CISTERN_WARRENS_MOVEMENT_SCALE;
export const CISTERN_WARRENS_PLAYER_RADIUS = CISTERN_WARRENS_ENTRANCE_ROOM.playerRadius;
export const CISTERN_WARRENS_MOVE_SPEED =
  STANDARD_INDOOR_SPATIAL_PROFILE.movementUnitsPerSecond * CISTERN_WARRENS_MOVEMENT_SCALE;
export const CISTERN_WARRENS_MAX_TARGET_DISTANCE = STANDARD_INDOOR_SPATIAL_PROFILE.maxTargetDistance;
export const CISTERN_WARRENS_SPAWN = CISTERN_WARRENS_ENTRANCE_ROOM.spawn;

export const CISTERN_WARRENS_SPATIAL_PROFILE = Object.freeze({
  // Preserve the authoritative overworld 125 m/s movement pace in combat
  // coordinates while expressing the dungeon's half-speed local movement.
  // Canonical weapon ranges remain unchanged in combat meters.
  combatMetersPerLocalUnit: DEFAULT_PLAYER_SPEED_MPS / CISTERN_WARRENS_MOVE_SPEED,
  playerMovementLocalUnitsPerSecond: CISTERN_WARRENS_MOVE_SPEED,
  playerMeleeRangeLocalUnits: MELEE_ATTACK_RANGE_M /
    (DEFAULT_PLAYER_SPEED_MPS / CISTERN_WARRENS_MOVE_SPEED),
  playerRangedRangeLocalUnits: RANGED_ATTACK_RANGE_M /
    (DEFAULT_PLAYER_SPEED_MPS / CISTERN_WARRENS_MOVE_SPEED),
  playerPursuitStopLocalUnits: (MELEE_ATTACK_RANGE_M - 2) /
    (DEFAULT_PLAYER_SPEED_MPS / CISTERN_WARRENS_MOVE_SPEED)
});

export const DUNGEON_METERS_PER_COORDINATE =
  CISTERN_WARRENS_SPATIAL_PROFILE.combatMetersPerLocalUnit;
const METERS_PER_DEGREE = 2 * Math.PI * 6_371_008.8 / 360;

/**
 * Local rooms are y-down; combat latitude is y-up, so local +y is south
 * (negative latitude). This keeps map-rendered rooms upright and makes combat
 * bearings match the room as drawn. See interiorSpace.ts.
 */
export function dungeonLocalToCombatPosition(x: number, y: number): LatLon {
  return {
    lat: -y * DUNGEON_METERS_PER_COORDINATE / METERS_PER_DEGREE,
    lon: x * DUNGEON_METERS_PER_COORDINATE / METERS_PER_DEGREE
  };
}

export function combatPositionToDungeonLocal(position: LatLon): { x: number; y: number } {
  return {
    x: position.lon * METERS_PER_DEGREE / DUNGEON_METERS_PER_COORDINATE,
    y: -position.lat * METERS_PER_DEGREE / DUNGEON_METERS_PER_COORDINATE
  };
}

export function dungeonLocalDistanceToCombatMeters(localUnits: number): number {
  return localUnits * DUNGEON_METERS_PER_COORDINATE;
}

export function dungeonCombatMetersToLocalDistance(combatMeters: number): number {
  return combatMeters / DUNGEON_METERS_PER_COORDINATE;
}

export type DungeonNotice = { id: number; text: string; tone: "info" | "success" | "warning" };
export type DungeonObjectKind =
  | "portal"
  | "door"
  | "ladder"
  | "chest"
  | "valve"
  | "switch"
  | "shrine"
  | "harvestable"
  | "destructible"
  | "npc"
  | "decoration"
  | "exit_ladder";
export type DungeonObjectSnapshot = {
  id: string;
  kind: DungeonObjectKind;
  name: string;
  x: number;
  y: number;
  available: boolean;
  state: "idle" | "open" | "closed" | "on" | "off" | "pressed" | "released" |
    "intact" | "destroyed" | "looted";
  prefabId: string;
  prefabRevision: string;
  layerId: DungeonRoomDefinition["objects"][number]["layerId"];
  interactionRadius: number;
  rotationDeg: number;
  opacity: number;
  flipX: boolean;
  flipY: boolean;
  zIndex: number;
  /** The stable rarity rolled for an available reward chest in this run. */
  rarity?: DungeonChestRarity;
  /** Selected rarity artwork; older snapshots omit this and use the prefab art. */
  assetKey?: string;
  portalId?: string;
  interactionLabel?: string;
};
export type DungeonResourceSnapshot = {
  id: string;
  roomId: string;
  resourceType: DungeonResourceType;
  x: number;
  y: number;
  quantity: number;
  state: "available" | "depleted";
  availableAt: number | null;
  interactionRadius: number;
  prefabId?: string;
  prefabRevision?: string;
  source: "authored" | "spawn_zone";
};
export type DungeonEnemySnapshot = {
  entityId: string;
  spawnId: string;
  encounterId: string;
  archetype: MobArchetypeKey;
  name: string;
  x: number;
  y: number;
  currentHealth: number;
  maxHealth: number;
  lifeState: "alive" | "downed" | "defeated" | "respawning";
  targetEntityId: string | null;
  visualScale: number;
  boss?: boolean;
  bossOwnership?: BossEntityOwnership;
  bossEncounter?: BossEncounterProjection;
  /** Rolled elite: its modifier ids and, for shielded, whether the shield is up right now. */
  elite?: { modifiers: string[]; shieldActive?: boolean };
};
export type DungeonEncounterSnapshot = {
  id: string;
  state: "idle" | "active" | "completed" | "failed" | "resetting";
  currentWaveId: string | null;
  attempts: number;
};
export type DungeonTriggerSnapshot = {
  id: string;
  enabled: boolean;
  firedCount: number;
  cooldownUntil: number | null;
};
export type DungeonPlayerSnapshot = {
  playerId: string;
  name: string;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot;
  x: number;
  y: number;
  targetX: number | null;
  targetY: number | null;
  targetEntityId: string | null;
  movementSpeed: number;
  movementRevision: number;
  currentHealth: number;
  maxHealth: number;
};
export function dungeonSceneRevision(
  catalogRevision: number,
  dungeonRevision: string,
  spaceId: string
): string {
  return JSON.stringify([catalogRevision, dungeonRevision, spaceId]);
}
export type DungeonSnapshot = {
  snapshotKind: "full";
  catalogRevision: number;
  sceneRevision: string;
  dungeonId: string;
  dungeonRevision: string;
  instancePolicy: DungeonDefinition["instancePolicy"];
  entranceId: string;
  name: string;
  description: string;
  portalId: string;
  presentation: "door" | "stairs" | "ladder" | "hatch" | "cave";
  assetKey: string | null;
  sewerId?: string;
  cityId?: string;
  cityName?: string;
  sessionId: string;
  instanceId: string;
  spaceId: CisternWarrensSpaceId;
  roomWidth: number;
  roomHeight: number;
  playerVisualHeight: number;
  camera: DungeonRoomDefinition["camera"];
  environment: DungeonRoomDefinition["environment"] & typeof CISTERN_WARRENS_DUNGEON.environment;
  player: DungeonPlayerSnapshot;
  occupants: DungeonPlayerSnapshot[];
  room: DungeonRoomDefinition;
  prefabs: DungeonPrefabDefinition[];
  enemies: DungeonEnemySnapshot[];
  objects: DungeonObjectSnapshot[];
  resources?: DungeonResourceSnapshot[];
  telegraphs: BossCastSnapshot[];
  encounters: DungeonEncounterSnapshot[];
  triggers: DungeonTriggerSnapshot[];
  dungeonFlags: Record<string, boolean>;
  portalLocks: Record<string, boolean>;
  completed: boolean;
  cues: string[];
  /** Short-lived HUD notices (capped history). Ids rise monotonically per run; absent on older servers. */
  notices?: DungeonNotice[];
  resetDeadline: number | null;
  /** Run start (server ms) for the HUD run timer; null until known. Absent on older servers. */
  runStartedAt?: number | null;
  /** Deaths of party members inside this run, for the HUD death counter. Absent on older servers. */
  partyDeaths?: number;
  /** The Ash Heart puzzle room this player is playing (locked in place), or null. Absent on older servers. */
  heartPuzzleActiveRoomId?: string | null;
  status: string;
  serverTime: number;
};
export type DungeonSnapshotUpdate = Omit<
  DungeonSnapshot,
  "snapshotKind" | "room" | "prefabs"
> & {
  snapshotKind: "update";
};
export type DungeonEntranceSnapshot = {
  entranceId: string;
  dungeonId: string;
  instanceId?: string;
  sewerId?: string;
  structureId?: string;
  portalId: string;
  portalRevision: string;
  interactionLabel: string;
  cityId?: string;
  cityName?: string;
  name: string;
  description: string;
  regionCode: string;
  lat: number;
  lon: number;
  interactionRadiusM: number;
  footprintRadiusM: number;
  presentation: "door" | "stairs" | "ladder" | "hatch" | "cave";
  assetKey: string | null;
  developerSpawned?: boolean;
  /** Client-only: marks a Wandering Merchant pin drawn on the entrance layer (never sent by the server). */
  wanderingMerchant?: { merchantId: string; expiresAt: string };
  templateId?: string;
  placementRevision?: number;
  createdAt?: string;
  dungeonRevision?: string;
  /** Entry requirements for the prompt; the server enforces them. */
  access?: {
    minimumLevel?: number | undefined;
    entryCost?: { itemId: string; quantity: number }[] | undefined;
    lockoutDays?: number | undefined;
    lockoutHours?: number | undefined;
    requiresAfloat?: boolean | undefined;
    noReentry?: boolean | undefined;
  };
};
export type DungeonExitedResult = { player: PlayerSnapshot };
