import { describe, expect, it, vi } from "vitest";

import type { RenderState } from "./mapObjects.js";
import { visibleStaticRenderState, type StaticOverlayProjection } from "./staticOverlayVisibility.js";

describe("visibleStaticRenderState", () => {
  it("keeps only static objects that intersect the current viewport", () => {
    const visible = visibleStaticRenderState(
      renderState({
        flags: [
          ["visible-flag", 50, 50, 10],
          ["offscreen-flag", 400, 50, 10],
          ["edge-territory", 250, 50, 60]
        ],
        collectibles: [
          ["visible-node", 50, 50],
          ["offscreen-node", 400, 50]
        ],
        droppedItems: [
          ["visible-drop", 70, 70],
          ["offscreen-drop", 470, 70]
        ],
        waterHighlights: [
          ["visible-water", 60, 60],
          ["offscreen-water", 450, 60]
        ],
        resourceVision: [50, 50, 20],
        selectedFlagId: "offscreen-flag"
      }),
      projection()
    );

    expect(visible.flags.map((flag) => flag.id)).toEqual(["visible-flag", "edge-territory"]);
    expect(visible.collectibles.map((collectible) => collectible.id)).toEqual(["visible-node"]);
    expect(visible.droppedItems.map((drop) => drop.dropId)).toEqual(["visible-drop"]);
    expect(visible.waterHighlights.map((highlight) => highlight.id)).toEqual(["visible-water"]);
    expect(visible.resourceVision?.flagId).toBe("vision-flag");
    expect(visible.selectedFlagId).toBeNull();
  });

  it("removes the local player from static state when the movement leash is offscreen", () => {
    const visible = visibleStaticRenderState(
      renderState({
        localPlayerScreen: [500, 500],
        flags: [],
        collectibles: [],
        droppedItems: [],
        waterHighlights: []
      }),
      projection()
    );

    expect(visible.players.some((player) => player.playerId === "player-1")).toBe(false);
  });

  it("retains resource vision if its circle intersects the viewport edge", () => {
    const visible = visibleStaticRenderState(
      renderState({
        flags: [],
        collectibles: [],
        droppedItems: [],
        waterHighlights: [],
        resourceVision: [250, 50, 80]
      }),
      projection()
    );

    expect(visible.resourceVision?.flagId).toBe("vision-flag");
  });

  it("retains static objects inside the gameplay view circle before they enter the viewport", () => {
    const state = renderState({
      flags: [["circle-flag", 0.003, 0, 10]],
      collectibles: [["circle-node", 0.003, 0]],
      droppedItems: [["circle-drop", 0.003, 0]],
      waterHighlights: [["circle-water", 0.003, 0]]
    });
    state.gameplayViewCircle = {
      center: { lat: 0, lon: 0 },
      radiusM: 400
    };

    const visible = visibleStaticRenderState(state, {
      ...projection(),
      project: (point) => ({
        x: point.lon * 100_000,
        y: point.lat * 100_000
      })
    });

    expect(visible.flags.map((flag) => flag.id)).toEqual(["circle-flag"]);
    expect(visible.collectibles.map((collectible) => collectible.id)).toEqual(["circle-node"]);
    expect(visible.droppedItems.map((drop) => drop.dropId)).toEqual(["circle-drop"]);
    expect(visible.waterHighlights.map((highlight) => highlight.id)).toEqual(["circle-water"]);
  });

  it("keeps Siege preview targets visible even when their marker is offscreen", () => {
    const visible = visibleStaticRenderState(
      renderState({
        flags: [["preview-flag", 400, 50, 10]],
        collectibles: [],
        droppedItems: [],
        waterHighlights: [],
        siegeDeploymentPreviewFlagIds: ["preview-flag"]
      }),
      projection()
    );

    expect(visible.flags.map((flag) => flag.id)).toEqual(["preview-flag"]);
    expect(visible.siegeDeploymentPreviewFlagIds).toEqual(["preview-flag"]);
  });

  it("never exposes an in-viewport collectible outside the exact gameplay circle", () => {
    const state = renderState({
      flags: [],
      collectibles: [
        ["inside-node", 0, 0],
        ["outside-node", 0.01, 0]
      ],
      droppedItems: [],
      waterHighlights: []
    });
    state.gameplayViewCircle = {
      center: { lat: 0, lon: 0 },
      radiusM: 650
    };

    const visible = visibleStaticRenderState(state, projection());

    expect(visible.collectibles.map((node) => node.id)).toEqual(["inside-node"]);
  });

  it("consumes authoritative flag, leash, and vision radii from render state", () => {
    const state = renderState({
      flags: [["flag", 50, 50, 1_000]],
      collectibles: [],
      droppedItems: [],
      waterHighlights: [],
      resourceVision: [50, 50, 1_500]
    });
    const localPlayer = state.players[0];
    if (!localPlayer) throw new Error("expected local player");
    localPlayer.moveLeashRadiusM = 1_250;
    const radiusPixels = vi.fn((_center, radiusM: number) => radiusM);

    visibleStaticRenderState(state, { ...projection(), radiusPixels });

    expect(radiusPixels.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([1_000, 1_250, 1_500])
    );
  });
});

function projection(): StaticOverlayProjection {
  return {
    width: 200,
    height: 100,
    project: (point) => ({
      x: point.lon,
      y: point.lat
    }),
    radiusPixels: (_center, radiusM) => radiusM
  };
}

function renderState(input: {
  flags: Array<[string, number, number, number]>;
  collectibles: Array<[string, number, number]>;
  droppedItems?: Array<[string, number, number]>;
  waterHighlights: Array<[string, number, number]>;
  resourceVision?: [number, number, number];
  selectedFlagId?: string | null;
  localPlayerScreen?: [number, number];
  siegeDeploymentPreviewFlagIds?: string[];
}): RenderState {
  const localPlayerScreen = input.localPlayerScreen ?? [50, 50];
  const resourceVision = input.resourceVision
    ? {
        flagId: "vision-flag",
        flagName: "Vision Flag",
        center: {
          lon: input.resourceVision[0],
          lat: input.resourceVision[1]
        },
        movementLeashRadiusM: 20,
        paddingM: 0,
        radiusM: input.resourceVision[2]
      }
    : null;
  return {
    localPlayerId: "player-1",
    players: [
      {
        playerId: "player-1",
        username: "Ash",
        displayColor: "#38bdf8",
        regionCode: "NM",
        zoneId: "world:NM",
        lat: localPlayerScreen[1],
        lon: localPlayerScreen[0],
        anchorLat: localPlayerScreen[1],
        anchorLon: localPlayerScreen[0],
        moveLeashRadiusM: 20,
        movementRevision: 0,
        targetLat: null,
        targetLon: null,
        moving: false,
        online: true,
        updatedAt: "2026-07-09T00:00:00.000Z"
      }
    ],
    flags: input.flags.map(([id, x, y, radius]) => ({
      id,
      controlType: "personal" as const,
      ownerId: "player-1",
      ownerUsername: "Ash",
      ownerColor: "#38bdf8",
      name: id,
      lat: y,
      lon: x,
      packageId: "nm",
      elevationM: 1500,
      terrainClass: "flat",
      biome: "desert",
      ecoregion: "desert",
      claimRadiusM: radius,
      cityId: null,
      createdAt: "2026-07-09T00:00:00.000Z"
    })),
    ...(input.siegeDeploymentPreviewFlagIds
      ? { siegeDeploymentPreviewFlagIds: input.siegeDeploymentPreviewFlagIds }
      : {}),
    cities: [],
    cityStructures: [],
    dungeonEntrances: [],
    manors: [],
    furnaces: [],
    tanneries: [],
    looms: [],
    collectibles: input.collectibles.map(([id, x, y]) => ({
      id,
      type: "wood",
      lat: y,
      lon: x,
      quantity: 1,
      state: "available",
      createdAt: "2026-07-09T00:00:00.000Z",
      harvestedAt: null,
      sourceCellId: "cell-1",
      waterKind: null
    })),
    droppedItems: (input.droppedItems ?? []).map(([dropId, x, y]) => ({
      dropId,
      droppedBy: "player-1",
      regionCode: "NM",
      itemId: "wood",
      variant: null,
      quantity: 1,
      status: "active",
      lat: y,
      lon: x,
      createdAt: "2026-07-09T00:00:00.000Z",
      expiresAt: "2026-07-09T00:10:00.000Z",
      pickedUpBy: null,
      pickedUpAt: null
    })),
    resourceVision,
    gameplayViewCircle: resourceVision
      ? { center: resourceVision.center, radiusM: resourceVision.radiusM }
      : {
          center: {
            lat: localPlayerScreen[1],
            lon: localPlayerScreen[0]
          },
          radiusM: 20
        },
    waterHighlights: input.waterHighlights.map(([id, x, y]) => ({
      id,
      name: id,
      sourceDataset: "test",
      waterSourceType: "medium_river",
      waterKind: "freshwater",
      collectible: true,
      lat: y,
      lon: x
    })),
    selectedFlagId: input.selectedFlagId ?? null,
    selectedCityId: null,
    selectedDungeonEntranceId: null,
    selectedManorId: null,
    selectedFurnaceId: null,
    selectedTanneryId: null,
    selectedLoomId: null,
    selectedCollectibleId: null,
    selectedDroppedItemId: "offscreen-drop",
    selectedCombatEntityId: null
  };
}
