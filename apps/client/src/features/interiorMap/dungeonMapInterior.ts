import {
  cisternWarrensRoomNavigation,
  dungeonDefinition,
  DUNGEON_METERS_PER_COORDINATE,
  dungeonResourceAsCollectible,
  type CollectibleNode,
  interiorLngLatToLocal,
  interiorLocalToLngLat,
  type CombatEntitySnapshot,
  type DungeonPlayerSnapshot,
  heartPuzzleBoardColliders,
  heartPuzzleForRoom,
  type DungeonSnapshot,
  type IndoorPoint,
  type IndoorRoomNavigation,
  isCisternWarrensSpaceId,
  isIndoorNavigationPointWalkable,
  type LatLon,
  type PlayerSnapshot,
  STANDARD_INDOOR_SPATIAL_PROFILE
} from "@ash-atlas/shared";

import type { GameplayViewCircle } from "../../map/gameplayViewCircle.js";
import { walkableIndoorJoystickTarget } from "../../movement/indoorJoystickTarget.js";
import type { InteriorRenderState } from "../../map/mapObjects.js";
import { dungeonPortalBarricades } from "../../ui/DungeonRoomPresentation.js";
import { dungeonElitesByEntityId, dungeonEnemyVisualScale, withDungeonEliteName } from "./dungeonElitePresentation.js";

/**
 * Adapters from the authoritative dungeon snapshot to the map renderer's
 * interior render state. Dungeon lngLat equals the combat position, so the
 * overlay's world paths (targeting, projectiles, floaters, telegraphs) work
 * unchanged indoors.
 */

export const DUNGEON_MAP_METERS_PER_UNIT = DUNGEON_METERS_PER_COORDINATE;

export function dungeonMapSpaceKey(snapshot: Pick<DungeonSnapshot, "instanceId" | "spaceId">): string {
  return `${snapshot.instanceId}:${snapshot.spaceId}`;
}

export function dungeonLocalToMapLngLat(point: IndoorPoint): LatLon {
  return interiorLocalToLngLat(point, DUNGEON_MAP_METERS_PER_UNIT);
}

/** Map lngLat to a walkable-looking local target clamped inside the room. */
export function dungeonMapTargetToLocal(
  snapshot: Pick<DungeonSnapshot, "roomWidth" | "roomHeight">,
  target: LatLon,
  inset: number = STANDARD_INDOOR_SPATIAL_PROFILE.playerRadius
): IndoorPoint {
  const local = interiorLngLatToLocal(target, DUNGEON_MAP_METERS_PER_UNIT);
  return {
    x: Math.min(snapshot.roomWidth - inset, Math.max(inset, local.x)),
    y: Math.min(snapshot.roomHeight - inset, Math.max(inset, local.y))
  };
}

const puzzleNavigations = new Map<string, IndoorRoomNavigation | null>();

/** The server's navigation for an Ash Heart puzzle room (floors follow the painted walls), or null for any other room. */
export function heartPuzzleRoomNavigation(snapshot: Pick<DungeonSnapshot, "dungeonId" | "spaceId">): IndoorRoomNavigation | null {
  const key = `${snapshot.dungeonId}:${snapshot.spaceId}`;
  const cached = puzzleNavigations.get(key);
  if (cached !== undefined) return cached;
  const dungeon = heartPuzzleForRoom(snapshot.dungeonId, snapshot.spaceId) ? dungeonDefinition(snapshot.dungeonId) : undefined;
  const navigation = dungeon && isCisternWarrensSpaceId(snapshot.spaceId, dungeon) ? cisternWarrensRoomNavigation(snapshot.spaceId, dungeon) : null;
  puzzleNavigations.set(key, navigation);
  return navigation;
}

const lockedPuzzleNavigations = new Map<string, IndoorRoomNavigation>();

/**
 * The player's navigation in a puzzle room: until the seal opens the board's wall cells are solid (the server adds
 * the same colliders), afterwards the plain room floor. Null outside puzzle rooms.
 */
export function heartPuzzlePlayerNavigation(
  snapshot: Pick<DungeonSnapshot, "dungeonId" | "spaceId" | "objects">
): IndoorRoomNavigation | null {
  const navigation = heartPuzzleRoomNavigation(snapshot);
  const puzzle = heartPuzzleForRoom(snapshot.dungeonId, snapshot.spaceId);
  if (!navigation || !puzzle) return navigation;
  if (snapshot.objects.some((object) => object.id === puzzle.sealObjectId && object.state === "on")) return navigation;
  const key = `${snapshot.dungeonId}:${snapshot.spaceId}`;
  let locked = lockedPuzzleNavigations.get(key);
  if (!locked) {
    locked = { ...navigation, colliders: [...navigation.colliders, ...heartPuzzleBoardColliders(puzzle)] };
    lockedPuzzleNavigations.set(key, locked);
  }
  return locked;
}

/**
 * Where to stand to talk to the puzzle room's NPC: a walkable spot (board walls count) inside his talk range,
 * nearest the player. Null when none is found (the caller falls back to the plain approach point).
 */
export function heartPuzzleNpcApproachPoint(
  snapshot: Pick<DungeonSnapshot, "dungeonId" | "spaceId" | "objects" | "player">,
  npc: Readonly<{ x: number; y: number; interactionRadius: number }>
): IndoorPoint | null {
  const navigation = heartPuzzlePlayerNavigation(snapshot);
  if (!navigation) return null;
  let best: IndoorPoint | null = null;
  let bestDistance = Infinity;
  for (const reach of [0.55, 0.8, 0.35]) {
    for (let i = 0; i < 16; i += 1) {
      const angle = (i / 16) * Math.PI * 2;
      const point = { x: npc.x + Math.cos(angle) * npc.interactionRadius * reach, y: npc.y + Math.sin(angle) * npc.interactionRadius * reach };
      if (!isIndoorNavigationPointWalkable(navigation, point)) continue;
      const distance = Math.hypot(point.x - snapshot.player.x, point.y - snapshot.player.y);
      if (distance < bestDistance) { best = point; bestDistance = distance; }
    }
    if (best) return best;
  }
  return best;
}

/**
 * A stick or double-tap target in a puzzle room, kept on the painted floor (the server rejects off-floor targets):
 * slides along a wall or stops at the furthest walkable point; null when the player cannot move that way. Rooms
 * without a puzzle return the plain room-clamped target.
 */
export function dungeonMapWalkTarget(
  snapshot: Pick<DungeonSnapshot, "dungeonId" | "spaceId" | "roomWidth" | "roomHeight" | "player" | "objects">,
  target: LatLon,
  from: LatLon | null
): IndoorPoint | null {
  const local = dungeonMapTargetToLocal(snapshot, target);
  const navigation = heartPuzzlePlayerNavigation(snapshot);
  if (!navigation) return local;
  const rendered = from ? interiorLngLatToLocal(from, DUNGEON_MAP_METERS_PER_UNIT) : null;
  const start = rendered && isIndoorNavigationPointWalkable(navigation, rendered)
    ? rendered
    : { x: snapshot.player.x, y: snapshot.player.y };
  return walkableIndoorJoystickTarget(navigation, start, local);
}

/** The room as a movement/view circle: centred on the room, reaching its corners. */
export function dungeonMapGameplayCircle(
  snapshot: Pick<DungeonSnapshot, "roomWidth" | "roomHeight">
): GameplayViewCircle {
  return {
    center: dungeonLocalToMapLngLat({ x: snapshot.roomWidth / 2, y: snapshot.roomHeight / 2 }),
    radiusM: Math.hypot(snapshot.roomWidth, snapshot.roomHeight) / 2 * DUNGEON_MAP_METERS_PER_UNIT
  };
}

function dungeonPlayerToPlayerSnapshot(
  player: DungeonPlayerSnapshot,
  snapshot: Pick<DungeonSnapshot, "instanceId" | "spaceId">,
  template: PlayerSnapshot | null
): PlayerSnapshot {
  const position = dungeonLocalToMapLngLat(player);
  const target = player.targetX !== null && player.targetY !== null
    ? dungeonLocalToMapLngLat({ x: player.targetX, y: player.targetY })
    : null;
  return {
    ...(template ?? {
      moveLeashRadiusM: 0,
      online: true,
      updatedAt: new Date(0).toISOString()
    }),
    playerId: player.playerId,
    username: player.name,
    displayColor: player.displayColor,
    regionCode: `interior:${snapshot.instanceId}`,
    zoneId: `interior:${snapshot.instanceId}:${snapshot.spaceId}`,
    lat: position.lat,
    lon: position.lon,
    anchorLat: position.lat,
    anchorLon: position.lon,
    movementRevision: player.movementRevision,
    targetLat: target?.lat ?? null,
    targetLon: target?.lon ?? null,
    moving: target !== null,
    ...(player.appearance ? { appearance: player.appearance } : {})
  };
}

/** Tilted Vault combat rooms (between the puzzle rooms): painted room art, cover props and a door that opens on a clear. */
export function vaultCombatRoomId(snapshot: Pick<DungeonSnapshot, "dungeonId" | "spaceId">): string | null {
  return snapshot.dungeonId === "tilted_vault" && /^combat_[a-z]$/.test(snapshot.spaceId) ? snapshot.spaceId : null;
}

/** Cover props per combat room (room units, footprint centre), from the combat-room art manifest; their colliders are in the room data. */
export const VAULT_COMBAT_PROPS: Readonly<Record<string, readonly Readonly<{ key: string; x: number; y: number }>[]>> = {
  combat_a: [{ key: "rubble-0", x: 330, y: 520 }, { key: "pillar-1", x: 760, y: 700 }, { key: "rubble-1", x: 470, y: 860 }],
  combat_b: [{ key: "rubble-0", x: 300, y: 450 }, { key: "pillar-1", x: 720, y: 520 }, { key: "rubble-1", x: 520, y: 780 }, { key: "pillar-0", x: 250, y: 820 }],
  combat_c: [{ key: "rubble-0", x: 280, y: 420 }, { key: "pillar-1", x: 760, y: 430 }, { key: "rubble-1", x: 540, y: 640 },
    { key: "pillar-0", x: 300, y: 800 }, { key: "rubble-0", x: 780, y: 820 }]
};
/** Drawn size (room units) of each cover prop; the art canvases are 196-255 px wide. */
const VAULT_PROP_SIZE: Readonly<Record<string, Readonly<{ w: number; h: number }>>> = {
  "pillar-0": { w: 92, h: 216 }, "pillar-1": { w: 100, h: 181 }, "rubble-0": { w: 120, h: 100 }, "rubble-1": { w: 120, h: 90 }
};

function vaultCombatRenderState(snapshot: DungeonSnapshot): Pick<InteriorRenderState, "vaultCombat" | "sprites"> {
  const roomId = vaultCombatRoomId(snapshot);
  if (!roomId) return {};
  const base = `${import.meta.env.BASE_URL}art/vault/`;
  const sprites: NonNullable<InteriorRenderState["sprites"]> = [
    { key: `vault-room-${roomId}`, url: `${base}room-${roomId}.png`, layerId: "background", x: 0, y: 0,
      width: snapshot.roomWidth, height: snapshot.roomHeight, anchorX: 0, anchorY: 0, zIndex: 1 },
    ...(VAULT_COMBAT_PROPS[roomId] ?? []).map((prop, index) => {
      const size = VAULT_PROP_SIZE[prop.key]!;
      // Feet a little below the footprint centre, so the solid base sits where the collider is.
      return { key: `vault-prop-${roomId}-${index}`, url: `${base}prop-${prop.key}.png`, layerId: "actors" as const,
        x: prop.x, y: prop.y + 16, width: size.w, height: size.h, anchorX: 0.5, anchorY: 1 };
    })
  ];
  return { vaultCombat: { roomId, doorUnlocked: snapshot.dungeonFlags?.[`${roomId}_cleared`] === true }, sprites };
}

/** Context for the Ash Heart puzzle on this room floor, when the room has one. */
function heartPuzzleRenderState(snapshot: DungeonSnapshot): Pick<InteriorRenderState, "heartPuzzle"> {
  const puzzle = heartPuzzleForRoom(snapshot.dungeonId, snapshot.spaceId);
  if (!puzzle) return {};
  return {
    heartPuzzle: {
      dungeonId: snapshot.dungeonId,
      roomId: snapshot.spaceId,
      sessionId: snapshot.sessionId,
      solved: snapshot.objects.some((object) => object.id === puzzle.sealObjectId && object.state === "on"),
      active: snapshot.heartPuzzleActiveRoomId === snapshot.spaceId
    }
  };
}

/** Old Pell's own sprite (same 1254 canvas and placement as the grove hermit prefab he borrows). */
export const HEART_PUZZLE_PELL_ASSET_KEY = "apps/client/public/art/vault/npc-old-pell.png";
/** Pell's prefab in puzzle rooms: overworld NPC scale, a little taller than the player (content 869 of the 1254 canvas). */
export const HEART_PUZZLE_PELL_PREFAB_ID = "heart_puzzle_old_pell";
export const HEART_PUZZLE_PELL_SIZE = 150;
/** Pell's feet below his anchor at that size (content bottom at y 1184 of 1254). */
export const HEART_PUZZLE_PELL_FEET_OFFSET = (1184 / 1254 - 0.5) * HEART_PUZZLE_PELL_SIZE;

/** The prefabs of a puzzle room plus Pell's own (cloned from the prefab his object borrows). */
export function heartPuzzleRoomPrefabs(snapshot: Pick<DungeonSnapshot, "dungeonId" | "spaceId" | "objects" | "prefabs">): DungeonSnapshot["prefabs"] {
  const puzzle = heartPuzzleForRoom(snapshot.dungeonId, snapshot.spaceId);
  const pell = puzzle ? snapshot.objects.find((object) => object.id === puzzle.npcObjectId) : undefined;
  const base = pell ? snapshot.prefabs.find((prefab) => prefab.id === pell.prefabId) : undefined;
  if (!base) return snapshot.prefabs;
  return [...snapshot.prefabs, {
    ...base, id: HEART_PUZZLE_PELL_PREFAB_ID, assetKey: HEART_PUZZLE_PELL_ASSET_KEY,
    defaultWidth: HEART_PUZZLE_PELL_SIZE, defaultHeight: HEART_PUZZLE_PELL_SIZE
  }];
}

/**
 * In an Ash Heart puzzle room the painted room art already shows the doors and
 * the puzzle layer draws the seal, so their object sprites go invisible (their
 * tap frames stay) and the NPC wears Pell's sprite.
 */
export function heartPuzzleRoomObjects(snapshot: Pick<DungeonSnapshot, "dungeonId" | "spaceId" | "objects">): DungeonSnapshot["objects"] {
  const puzzle = heartPuzzleForRoom(snapshot.dungeonId, snapshot.spaceId);
  if (!puzzle && vaultCombatRoomId(snapshot)) return snapshot.objects.map((object) => object.kind === "portal" ? { ...object, opacity: 0 } : object);
  if (!puzzle) return snapshot.objects;
  return snapshot.objects.map((object) => {
    if (object.id === puzzle.npcObjectId) return { ...object, prefabId: HEART_PUZZLE_PELL_PREFAB_ID, assetKey: HEART_PUZZLE_PELL_ASSET_KEY, opacity: 1 };
    if (object.id === puzzle.sealObjectId || object.kind === "portal") return { ...object, opacity: 0 };
    return object;
  });
}

type HitFrame = Readonly<{ left: number; top: number; right: number; bottom: number }>;

/**
 * Tap frames over the painted doors of a puzzle room: a door on the bottom wall is painted below its (floor) anchor
 * down to the room edge, a door in the back facade above it.
 */
export function heartPuzzleDoorHitFrames(
  snapshot: Pick<DungeonSnapshot, "dungeonId" | "spaceId" | "objects" | "roomHeight">
): ReadonlyMap<string, HitFrame> | undefined {
  if (!heartPuzzleForRoom(snapshot.dungeonId, snapshot.spaceId) && !vaultCombatRoomId(snapshot)) return undefined;
  const frames = new Map<string, HitFrame>();
  for (const object of snapshot.objects) {
    if (object.kind !== "portal") continue;
    const bottomWall = object.y > snapshot.roomHeight / 2;
    frames.set(object.id, bottomWall
      ? { left: object.x - 48, top: object.y - 40, right: object.x + 48, bottom: snapshot.roomHeight }
      : { left: object.x - 48, top: Math.max(0, object.y - 130), right: object.x + 48, bottom: object.y + 40 });
  }
  return frames;
}

export function buildDungeonInteriorRenderState(input: Readonly<{
  snapshot: DungeonSnapshot;
  localPlayer: PlayerSnapshot | null;
  combatEntities: readonly CombatEntitySnapshot[];
  playerPosition?: (playerId: string) => LatLon | null;
  selectedObjectId: string | null;
}>): InteriorRenderState {
  const { snapshot } = input;
  const mobElites = dungeonElitesByEntityId(snapshot.enemies);
  const doorFrames = heartPuzzleDoorHitFrames(snapshot);
  const localTemplate = input.localPlayer?.playerId === snapshot.player.playerId
    ? input.localPlayer
    : null;
  const players = [
    dungeonPlayerToPlayerSnapshot(snapshot.player, snapshot, localTemplate),
    ...snapshot.occupants
      .filter((occupant) => occupant.playerId !== snapshot.player.playerId)
      .map((occupant) => dungeonPlayerToPlayerSnapshot(occupant, snapshot, null))
  ];
  return {
    spaceKey: dungeonMapSpaceKey(snapshot),
    roomWidth: snapshot.roomWidth,
    roomHeight: snapshot.roomHeight,
    metersPerUnit: DUNGEON_MAP_METERS_PER_UNIT,
    layers: snapshot.room.layers,
    prefabs: heartPuzzleRoomPrefabs(snapshot),
    objects: heartPuzzleRoomObjects(snapshot),
    barricades: dungeonPortalBarricades(snapshot),
    players,
    ...(input.playerPosition ? { playerPosition: input.playerPosition } : {}),
    // The overlay's entities feed its hit-test picks (Choose Target, target card): elites carry "Elite <name>".
    combatEntities: mobElites.size === 0
      ? input.combatEntities
      : input.combatEntities.map((entity) => withDungeonEliteName(entity, mobElites)),
    mobVisualScales: new Map(snapshot.enemies.map((enemy) => [enemy.entityId, dungeonEnemyVisualScale(enemy)])),
    mobElites,
    selectedObjectId: input.selectedObjectId,
    ...heartPuzzleRenderState(snapshot),
    ...vaultCombatRenderState(snapshot),
    ...(doorFrames ? { objectHitFrames: doorFrames } : {})
  };
}

/**
 * Dungeon resource nodes as overworld collectibles. A node keeps the same
 * object while its authoritative state is unchanged, so selection, harvest
 * tasks and the renderer see a stable identity across snapshots.
 */
export function createDungeonInteriorCollectibles(): (
  snapshot: Pick<DungeonSnapshot, "resources"> | null
) => CollectibleNode[] {
  const nodes = new Map<string, Readonly<{ key: string; node: CollectibleNode }>>();
  let previous: CollectibleNode[] = [];
  return (snapshot) => {
    const next: CollectibleNode[] = [];
    const seen = new Set<string>();
    for (const resource of snapshot?.resources ?? []) {
      const node = dungeonResourceAsCollectible(resource);
      if (!node) continue;
      seen.add(node.id);
      const key = JSON.stringify([
        node.type, node.lat, node.lon, node.quantity, node.state,
        node.repeatableState ?? null, node.repeatableReadyAt ?? null, node.repeatableTimerVisibility ?? null
      ]);
      const cached = nodes.get(node.id);
      if (cached && cached.key === key) {
        next.push(cached.node);
      } else {
        nodes.set(node.id, { key, node });
        next.push(node);
      }
    }
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);
    const unchanged = next.length === previous.length && next.every((node, index) => node === previous[index]);
    if (!unchanged) previous = next;
    return previous;
  };
}
