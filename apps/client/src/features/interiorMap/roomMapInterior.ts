import {
  INTERIOR_SPATIAL_PROFILES,
  interiorLngLatToLocal,
  interiorLocalToLngLat,
  interiorMetersPerUnit,
  type IndoorPoint,
  type LatLon,
  type PlayerAppearanceSnapshot,
  type PlayerSnapshot
} from "@ash-atlas/shared";

import type { GameplayViewCircle } from "../../map/gameplayViewCircle.js";
import type { InteriorRenderState, InteriorSpriteItem } from "../../map/mapObjects.js";

/**
 * Shared adapters for the timeline-driven rooms (Manor, Salon, Greenhouse) drawn by the map
 * renderer (docs/architecture/INTERIOR_MAP_RENDERER.md P4). All three use the standard_indoor
 * profile: 260 local units per second at the overworld 125 m/s.
 */

export const ROOM_MAP_METERS_PER_UNIT = interiorMetersPerUnit(INTERIOR_SPATIAL_PROFILES.standard_indoor);

export function roomLocalToMapLngLat(point: IndoorPoint): LatLon {
  return interiorLocalToLngLat(point, ROOM_MAP_METERS_PER_UNIT);
}

export function roomMapLngLatToLocal(position: LatLon): IndoorPoint {
  return interiorLngLatToLocal(position, ROOM_MAP_METERS_PER_UNIT);
}

/** The room as a movement/view circle: centred on the room, reaching its corners. */
export function roomMapGameplayCircle(room: Readonly<{ width: number; height: number }>): GameplayViewCircle {
  return {
    center: roomLocalToMapLngLat({ x: room.width / 2, y: room.height / 2 }),
    radiusM: Math.hypot(room.width, room.height) / 2 * ROOM_MAP_METERS_PER_UNIT
  };
}

export type RoomMapPlayer = Readonly<{
  playerId: string;
  name: string;
  displayColor: string | null;
  appearance?: PlayerAppearanceSnapshot | undefined;
  position: IndoorPoint;
}>;

/** A room-local player as a map player snapshot (the template keeps the local player's own fields). */
export function roomPlayerSnapshot(
  player: RoomMapPlayer,
  zone: Readonly<{ regionCode: string; zoneId: string }>,
  template: PlayerSnapshot | null
): PlayerSnapshot {
  const position = roomLocalToMapLngLat(player.position);
  return {
    ...(template ?? {
      moveLeashRadiusM: 0,
      online: true,
      updatedAt: new Date(0).toISOString()
    }),
    playerId: player.playerId,
    username: player.name,
    displayColor: player.displayColor ?? template?.displayColor ?? "#8b7355",
    regionCode: zone.regionCode,
    zoneId: zone.zoneId,
    lat: position.lat,
    lon: position.lon,
    anchorLat: position.lat,
    anchorLon: position.lon,
    movementRevision: template?.movementRevision ?? 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    ...(player.appearance ? { appearance: player.appearance } : {})
  };
}

/** One timeline room's render state: plain sprites plus the local player and any same-room guests. */
export function buildRoomInteriorRenderState(input: Readonly<{
  spaceKey: string;
  regionCode: string;
  zoneId: string;
  room: Readonly<{ width: number; height: number }>;
  sprites: readonly InteriorSpriteItem[];
  localPlayer: PlayerSnapshot | null;
  local: RoomMapPlayer;
  others?: readonly RoomMapPlayer[];
  playerPosition?: (playerId: string) => LatLon | null;
}>): InteriorRenderState {
  const zone = { regionCode: input.regionCode, zoneId: input.zoneId };
  const template = input.localPlayer?.playerId === input.local.playerId ? input.localPlayer : null;
  const players = [
    roomPlayerSnapshot(input.local, zone, template),
    ...(input.others ?? [])
      .filter((other) => other.playerId !== input.local.playerId)
      .map((other) => roomPlayerSnapshot(other, zone, null))
  ];
  return {
    spaceKey: input.spaceKey,
    roomWidth: input.room.width,
    roomHeight: input.room.height,
    metersPerUnit: ROOM_MAP_METERS_PER_UNIT,
    layers: { background: [], below_player: [], actors: [], above_player: [], ceiling: [] },
    prefabs: [],
    objects: [],
    players,
    ...(input.playerPosition ? { playerPosition: input.playerPosition } : {}),
    combatEntities: [],
    selectedObjectId: null,
    sprites: input.sprites
  };
}

/** SVG markup as an image URL for the map renderer's sprite loader. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Ray-cast point-in-polygon in room units. */
export function pointInRoomPolygon(point: IndoorPoint, polygon: readonly IndoorPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if ((a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y || Number.EPSILON) + a.x) inside = !inside;
  }
  return inside;
}
