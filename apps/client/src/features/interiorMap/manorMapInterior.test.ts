import { describe, expect, it } from "vitest";

import { DEFAULT_PLAYER_SPEED_MPS, distanceMeters, manorAuthoredRoom } from "@ash-atlas/shared";

import {
  buildManorInteriorRenderState,
  MANOR_MAP_METERS_PER_UNIT,
  manorClientNavigation,
  manorDecorationSprites,
  manorLocalToMapLngLat,
  manorMapLngLatToLocal,
  manorMapSpaceKey
} from "./manorMapInterior.js";

const transform = {
  x: 400, y: 500, width: 120, height: 80, anchorX: 0.5, anchorY: 1, rotationDeg: 0, scaleX: 1, scaleY: 1
};

describe("manor map interior", () => {
  it("walks 260 room units per second at the overworld 125 m/s", () => {
    const from = manorLocalToMapLngLat({ x: 0, y: 0 });
    const to = manorLocalToMapLngLat({ x: 260, y: 0 });
    expect(distanceMeters(from, to)).toBeCloseTo(DEFAULT_PLAYER_SPEED_MPS, 0);
    expect(MANOR_MAP_METERS_PER_UNIT).toBeCloseTo(125 / 260, 6);
    const back = manorMapLngLatToLocal(manorLocalToMapLngLat({ x: 321, y: 654 }));
    expect(back.x).toBeCloseTo(321, 6);
    expect(back.y).toBeCloseTo(654, 6);
  });

  it("draws placed decorations by layer and the placement preview translucent at its drag position", () => {
    const definition = (id: string, layer: "behind" | "in_front" | "rug") => ({
      definition: { id, assetKey: `${id}.png`, layer, zIndex: 2, mirrorX: id === "b", collision: false, transform },
      ownedQuantity: 1,
      availableQuantity: 1
    });
    const decorations = {
      manorId: "m1", roomWidth: 1254, roomHeight: 1254,
      definitions: [definition("a", "rug"), definition("b", "in_front")],
      placements: [
        { placementId: "p1", definitionId: "a", roomId: "room", surfaceId: "floor", transform, itemId: null, itemVariant: null },
        { placementId: "p2", definitionId: "b", roomId: "other", surfaceId: "floor", transform, itemId: null, itemVariant: null }
      ]
    } as never;
    const sprites = manorDecorationSprites({
      decorations,
      roomId: "room",
      preview: { definitionId: "b", placementId: null, position: { x: 10, y: 20 }, transform },
      assetUrl: (key) => `/assets/${key}`
    });
    expect(sprites.map((sprite) => [sprite.key, sprite.layerId, sprite.zIndex])).toEqual([
      ["decoration:p1", "below_player", 102],
      ["decoration-preview", "above_player", 302]
    ]);
    expect(sprites[1]).toMatchObject({ x: 10, y: 20, scaleX: -1, alpha: 0.72 });
  });

  it("adds collision decoration footprints to the client navigation like the server", () => {
    const room = manorAuthoredRoom("manor_main_room")!;
    const base = manorClientNavigation("manor_main_room", null, null)!;
    const blocker = {
      manorId: "m1", roomWidth: room.width, roomHeight: room.height,
      definitions: [{
        definition: {
          id: "crate", assetKey: "crate.png", layer: "in_front", zIndex: 0, collision: true, mirrorX: false,
          footprint: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], transform
        },
        ownedQuantity: 1, availableQuantity: 0
      }],
      placements: [{ placementId: "p1", definitionId: "crate", roomId: room.id, surfaceId: "floor", transform, itemId: null, itemVariant: null }]
    } as never;
    const withDecoration = manorClientNavigation("manor_main_room", null, blocker)!;
    expect(withDecoration.colliders.length).toBe(base.colliders.length + 1);
  });

  it("puts the local player and same-room guests into the render state with the room sprites", () => {
    const state = buildManorInteriorRenderState({
      manorId: "m1",
      spaceId: "manor_main_room",
      room: { id: "room", width: 1254, height: 1254 },
      floorUrl: "/floor.png",
      stations: [{ kind: "smith", x: 300, y: 400, url: "/smith.svg" }],
      decorationSprites: [],
      localPlayer: null,
      local: { playerId: "me", name: "Me", displayColor: null, position: { x: 600, y: 700 } },
      occupants: [
        { playerId: "guest", displayName: "Guest", displayColor: "#fff", accessSource: "PARTY", spaceId: "manor_main_room", position: { x: 100, y: 100 }, movementSequence: 1 },
        { playerId: "away", displayName: "Away", displayColor: "#fff", accessSource: "PARTY", spaceId: "upstairs_hallway", position: { x: 100, y: 100 }, movementSequence: 1 }
      ] as never
    });
    expect(state.spaceKey).toBe(manorMapSpaceKey("m1", "manor_main_room"));
    expect(state.players.map((player) => player.playerId)).toEqual(["me", "guest"]);
    expect(state.sprites?.map((sprite) => sprite.key)).toEqual(["floor", "station:smith"]);
    expect(state.sprites?.[1]).toMatchObject({ width: 1254 * 0.09, height: null, layerId: "actors" });
  });
});
