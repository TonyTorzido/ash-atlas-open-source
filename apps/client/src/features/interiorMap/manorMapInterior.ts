import {
  interiorNavigation,
  manorDecorationFootprintInRoom,
  manorInteriorRoom,
  manorRoomNavigation,
  type IndoorPoint,
  type IndoorRoomNavigation,
  type LatLon,
  type ManorDecorationSnapshot,
  type ManorDecorationTransform,
  type ManorOccupantPresenceSnapshot,
  type ManorSpaceId,
  type PlayerSnapshot
} from "@ash-atlas/shared";

import type { GameplayViewCircle } from "../../map/gameplayViewCircle.js";
import type { InteriorRenderState, InteriorSpriteItem } from "../../map/mapObjects.js";
import {
  buildRoomInteriorRenderState,
  ROOM_MAP_METERS_PER_UNIT,
  roomLocalToMapLngLat,
  roomMapGameplayCircle,
  roomMapLngLatToLocal,
  type RoomMapPlayer
} from "./roomMapInterior.js";

/**
 * Adapters from the Manor session (timeline, occupants, decorations) to the map
 * renderer's interior render state (docs/architecture/INTERIOR_MAP_RENDERER.md P4).
 * Manor rooms use the standard_indoor profile: 260 local units per second at the
 * overworld 125 m/s.
 */

export const MANOR_MAP_METERS_PER_UNIT = ROOM_MAP_METERS_PER_UNIT;

/** Share of the room width a lobby station covers (the DOM scene's `.manor-smith { width: 9% }`). */
export const MANOR_STATION_WIDTH_SHARE = 0.09;

export function manorMapSpaceKey(manorId: string, spaceId: string): string {
  return `manor:${manorId}:${spaceId}`;
}

export function manorLocalToMapLngLat(point: IndoorPoint): LatLon {
  return roomLocalToMapLngLat(point);
}

export function manorMapLngLatToLocal(position: LatLon): IndoorPoint {
  return roomMapLngLatToLocal(position);
}

/** The room as a movement/view circle: centred on the room, reaching its corners. */
export function manorMapGameplayCircle(room: Readonly<{ width: number; height: number }>): GameplayViewCircle {
  return roomMapGameplayCircle(room);
}

/**
 * The client copy of the server's decoration-aware Manor navigation
 * (`ManorDecorationService.navigationForManor`): the room floors and colliders
 * plus every placed collision decoration's footprint in this room. Falls back to
 * `manorRoomNavigation` like the server does.
 */
export function manorClientNavigation(
  spaceId: ManorSpaceId,
  typeId: string | null | undefined,
  decorations: ManorDecorationSnapshot | null
): IndoorRoomNavigation | null {
  const room = spaceId === "manor_foyer" ? undefined : manorInteriorRoom(spaceId, typeId);
  try {
    if (!room) return manorRoomNavigation(spaceId, typeId);
    const extra = (decorations?.placements ?? []).flatMap((placement) => {
      if (placement.roomId !== room.id) return [];
      const definition = decorations?.definitions.find((entry) => entry.definition.id === placement.definitionId)?.definition;
      if (!definition?.collision) return [];
      return [{
        id: `decoration:${placement.placementId}`,
        kind: "polygon" as const,
        points: manorDecorationFootprintInRoom({ ...definition, transform: placement.transform }, definition.mirrorX === true)
      }];
    });
    return interiorNavigation(room, extra);
  } catch {
    return null;
  }
}

export type ManorMapDecorationPreview = Readonly<{
  definitionId: string;
  placementId: string | null;
  position: IndoorPoint;
  transform: ManorDecorationTransform;
}>;

function decorationSprite(
  key: string,
  url: string,
  layer: "behind" | "in_front" | "rug",
  zIndex: number,
  transform: ManorDecorationTransform,
  mirrorX: boolean,
  alpha: number
): InteriorSpriteItem {
  // Same order as the DOM scene: behind < rug < players < in_front.
  const layerBase = layer === "behind" ? 0 : layer === "rug" ? 1 : 3;
  return {
    key,
    url,
    layerId: layer === "in_front" ? "above_player" : "below_player",
    x: transform.x,
    y: transform.y,
    width: transform.width,
    height: transform.height,
    anchorX: transform.anchorX,
    anchorY: transform.anchorY,
    rotationDeg: transform.rotationDeg,
    scaleX: mirrorX ? -transform.scaleX : transform.scaleX,
    scaleY: transform.scaleY,
    alpha,
    zIndex: layerBase * 100 + zIndex
  };
}

/** Placed decorations of one room plus the live placement preview, as map sprites. */
export function manorDecorationSprites(input: Readonly<{
  decorations: ManorDecorationSnapshot | null;
  roomId: string;
  preview: ManorMapDecorationPreview | null;
  assetUrl(assetKey: string): string | null;
}>): InteriorSpriteItem[] {
  const snapshot = input.decorations;
  if (!snapshot) return [];
  const sprites: InteriorSpriteItem[] = [];
  const definitionOf = (id: string) => snapshot.definitions.find((entry) => entry.definition.id === id)?.definition;
  for (const placement of snapshot.placements) {
    if (placement.roomId !== input.roomId || placement.placementId === input.preview?.placementId) continue;
    const definition = definitionOf(placement.definitionId);
    const url = definition ? input.assetUrl(definition.assetKey) : null;
    if (!definition || !url) continue;
    sprites.push(decorationSprite(`decoration:${placement.placementId}`, url, definition.layer, definition.zIndex,
      placement.transform, definition.mirrorX === true, 1));
  }
  const preview = input.preview;
  const previewDefinition = preview ? definitionOf(preview.definitionId) : undefined;
  const previewUrl = previewDefinition ? input.assetUrl(previewDefinition.assetKey) : null;
  if (preview && previewDefinition && previewUrl) {
    sprites.push(decorationSprite("decoration-preview", previewUrl, previewDefinition.layer, previewDefinition.zIndex,
      { ...preview.transform, ...preview.position }, previewDefinition.mirrorX === true, 0.72));
  }
  return sprites;
}

export function buildManorInteriorRenderState(input: Readonly<{
  manorId: string;
  spaceId: string;
  room: Readonly<{ id: string; width: number; height: number }>;
  floorUrl: string | null;
  stations: readonly Readonly<{ kind: string; x: number; y: number; url: string }>[];
  decorationSprites: readonly InteriorSpriteItem[];
  localPlayer: PlayerSnapshot | null;
  local: RoomMapPlayer;
  occupants: readonly ManorOccupantPresenceSnapshot[];
  playerPosition?: (playerId: string) => LatLon | null;
}>): InteriorRenderState {
  const { room } = input;
  const sprites: InteriorSpriteItem[] = [];
  if (input.floorUrl) {
    sprites.push({
      key: "floor", url: input.floorUrl, layerId: "background",
      x: 0, y: 0, width: room.width, height: room.height, anchorX: 0, anchorY: 0, zIndex: -1
    });
  }
  for (const station of input.stations) {
    sprites.push({
      key: `station:${station.kind}`, url: station.url, layerId: "actors",
      x: station.x, y: station.y, width: room.width * MANOR_STATION_WIDTH_SHARE, height: null,
      anchorX: 0.5, anchorY: 0.5
    });
  }
  sprites.push(...input.decorationSprites);
  return buildRoomInteriorRenderState({
    spaceKey: manorMapSpaceKey(input.manorId, input.spaceId),
    regionCode: `interior:manor:${input.manorId}`,
    zoneId: `interior:manor:${input.manorId}:${input.spaceId}`,
    room,
    sprites,
    localPlayer: input.localPlayer,
    local: input.local,
    others: input.occupants
      .filter((occupant) => occupant.spaceId === input.spaceId)
      .map((occupant) => ({
        playerId: occupant.playerId,
        name: occupant.displayName,
        displayColor: occupant.displayColor,
        appearance: occupant.appearance,
        position: occupant.position
      })),
    ...(input.playerPosition ? { playerPosition: input.playerPosition } : {})
  });
}
