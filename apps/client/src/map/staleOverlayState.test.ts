import { describe, expect, it } from "vitest";

import type { RenderState } from "./mapObjects.js";
import { staleWhileInteractingRenderState } from "./staleOverlayState.js";

describe("staleWhileInteractingRenderState", () => {
  it("does not add newly visible static overlay objects while interacting", () => {
    const frozen = renderState({
      flags: ["old-flag"],
      collectibles: ["old-node"],
      droppedItems: ["old-drop"],
      waterHighlights: ["old-water"]
    });
    const latest = renderState({
      flags: ["old-flag", "new-flag"],
      collectibles: ["old-node", "new-node"],
      droppedItems: ["old-drop", "new-drop"],
      waterHighlights: ["old-water", "new-water"]
    });

    const result = staleWhileInteractingRenderState(frozen, latest);

    expect(result.flags.map((flag) => flag.id)).toEqual(["old-flag"]);
    expect(result.collectibles.map((node) => node.id)).toEqual(["old-node"]);
    expect(result.droppedItems.map((drop) => drop.dropId)).toEqual(["old-drop"]);
    expect(result.waterHighlights.map((highlight) => highlight.id)).toEqual(["old-water"]);
  });

  it("removes deleted or harvested objects while preserving latest player movement", () => {
    const frozen = renderState({
      flags: ["keep-flag", "deleted-flag"],
      collectibles: ["keep-node", "harvested-node"],
      droppedItems: ["keep-drop", "picked-drop"],
      waterHighlights: ["keep-water", "removed-water"],
      playerLat: 35.0
    });
    const latest = renderState({
      flags: ["keep-flag"],
      collectibles: ["keep-node"],
      droppedItems: ["keep-drop"],
      waterHighlights: ["keep-water"],
      playerLat: 35.1
    });

    const result = staleWhileInteractingRenderState(frozen, latest);

    expect(result.flags.map((flag) => flag.id)).toEqual(["keep-flag"]);
    expect(result.collectibles.map((node) => node.id)).toEqual(["keep-node"]);
    expect(result.droppedItems.map((drop) => drop.dropId)).toEqual(["keep-drop"]);
    expect(result.waterHighlights.map((highlight) => highlight.id)).toEqual(["keep-water"]);
    expect(result.players[0]?.lat).toBe(35.1);
  });

  it("removes a retired dungeon entrance and clears its stale selection", () => {
    const frozen = renderState({ flags: [], collectibles: [], waterHighlights: [] });
    frozen.dungeonEntrances = [{ entranceId: "orc-cave" } as RenderState["dungeonEntrances"][number]];
    frozen.selectedDungeonEntranceId = "orc-cave";
    const latest = {
      ...frozen,
      dungeonEntrances: [],
      selectedDungeonEntranceId: "orc-cave"
    };

    const result = staleWhileInteractingRenderState(frozen, latest);

    expect(result.dungeonEntrances).toEqual([]);
    expect(result.selectedDungeonEntranceId).toBeNull();
  });
});

function renderState(input: {
  flags: string[];
  collectibles: string[];
  droppedItems?: string[];
  waterHighlights: string[];
  playerLat?: number;
}): RenderState {
  return {
    localPlayerId: "player-1",
    players: [
      {
        playerId: "player-1",
        username: "Ash",
        displayColor: "#38bdf8",
        regionCode: "NM",
        zoneId: "world:NM",
        lat: input.playerLat ?? 35,
        lon: -106.65,
        anchorLat: 35,
        anchorLon: -106.65,
        moveLeashRadiusM: 900,
        movementRevision: 0,
        targetLat: null,
        targetLon: null,
        moving: false,
        online: true,
        updatedAt: "2026-07-09T00:00:00.000Z"
      }
    ],
    flags: input.flags.map((id) => ({
      id,
      controlType: "personal" as const,
      ownerId: "player-1",
      ownerUsername: "Ash",
      ownerColor: "#38bdf8",
      name: id,
      lat: 35,
      lon: -106.65,
      packageId: "nm",
      elevationM: 1500,
      terrainClass: "flat",
      biome: "desert",
      ecoregion: "desert",
      claimRadiusM: 700,
      cityId: null,
      createdAt: "2026-07-09T00:00:00.000Z"
    })),
    cities: [],
    cityStructures: [],
    dungeonEntrances: [],
    manors: [],
    furnaces: [],
    tanneries: [],
    looms: [],
    collectibles: input.collectibles.map((id) => ({
      id,
      type: "wood",
      lat: 35,
      lon: -106.65,
      quantity: 1,
      state: "available",
      createdAt: "2026-07-09T00:00:00.000Z",
      harvestedAt: null,
      sourceCellId: "cell-1",
      waterKind: null
    })),
    droppedItems: (input.droppedItems ?? []).map((dropId) => ({
      dropId,
      droppedBy: "player-1",
      regionCode: "NM",
      itemId: "wood",
      variant: null,
      quantity: 1,
      status: "active",
      lat: 35,
      lon: -106.65,
      createdAt: "2026-07-09T00:00:00.000Z",
      expiresAt: "2026-07-09T00:10:00.000Z",
      pickedUpBy: null,
      pickedUpAt: null
    })),
    resourceVision: {
      flagId: "keep-flag",
      flagName: "keep-flag",
      center: {
        lat: 35,
        lon: -106.65
      },
      movementLeashRadiusM: 900,
      paddingM: 50,
      radiusM: 950
    },
    waterHighlights: input.waterHighlights.map((id) => ({
      id,
      name: id,
      sourceDataset: "test",
      waterSourceType: "medium_river",
      waterKind: "freshwater",
      collectible: true,
      lat: 35,
      lon: -106.65
    })),
    selectedFlagId: "keep-flag",
    selectedCityId: null,
    selectedDungeonEntranceId: null,
    selectedManorId: null,
    selectedFurnaceId: null,
    selectedTanneryId: null,
    selectedLoomId: null,
    selectedCollectibleId: null,
    selectedDroppedItemId: "keep-drop",
    selectedCombatEntityId: null
  };
}
