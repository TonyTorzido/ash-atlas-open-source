import { distanceMeters, type LatLon } from "@ash-atlas/shared";

import type { RenderState } from "./mapObjects.js";

export type StaticOverlayProjection = {
  width: number;
  height: number;
  /** Extra culling margin on every side, so entities do not pop in at the edge while a drawn layer is translated (follow reuse). */
  padPx?: number;
  project(point: LatLon): { x: number; y: number };
  radiusPixels(center: LatLon, radiusM: number): number;
};

const FLAG_MARKER_MARGIN_PX = 22;
const CITY_MARKER_MARGIN_PX = 48;
const CITY_STRUCTURE_MARKER_MARGIN_PX = 30;
const DUNGEON_ENTRANCE_MARKER_MARGIN_PX = 60;
/** The Fallen Prison's smoke column rises far above its entrance: keep it while the column is on screen. */
export const FALLEN_PRISON_SMOKE_COLUMN_PX = 420;
const MANOR_MARKER_MARGIN_PX = 42;
const GREENHOUSE_MARKER_MARGIN_PX = 48;
const FURNACE_MARKER_MARGIN_PX = 42;
const TANNERY_MARKER_MARGIN_PX = 42;
const LOOM_MARKER_MARGIN_PX = 42;
const FISHING_HUT_MARKER_MARGIN_PX = 42;
const COLLECTIBLE_MARKER_MARGIN_PX = 24;
const DROPPED_ITEM_MARKER_MARGIN_PX = 24;
const WATER_MARKER_MARGIN_PX = 24;

export function visibleStaticRenderState(
  state: RenderState,
  projection: StaticOverlayProjection
): RenderState {
  const siegeDeploymentPreviewFlagIds = new Set(
    state.siegeDeploymentPreviewFlagIds ?? []
  );
  const visibleFlags = state.flags.filter((flag) =>
    circleIntersectsViewport(
      projection.project(flag),
      Math.max(projection.radiusPixels(flag, flag.claimRadiusM), FLAG_MARKER_MARGIN_PX),
      projection
    ) || circleIntersectsGameplayView(flag, flag.claimRadiusM, state) ||
    siegeDeploymentPreviewFlagIds.has(flag.id)
  );
  const visibleCities = state.cities.filter((city) =>
    pointIntersectsViewport(projection.project(city), CITY_MARKER_MARGIN_PX, projection) ||
    pointIntersectsGameplayView(city, state)
  );
  const visibleCityStructures = state.cityStructures.filter((structure) =>
    pointIntersectsViewport(
      projection.project(structure),
      CITY_STRUCTURE_MARKER_MARGIN_PX,
      projection
    ) || pointIntersectsGameplayView(structure, state)
  );
  const visibleDungeonEntrances = state.dungeonEntrances.filter((entrance) =>
    pointIntersectsViewport(
      projection.project(entrance),
      entrance.dungeonId === "fallen_prison" ? FALLEN_PRISON_SMOKE_COLUMN_PX : DUNGEON_ENTRANCE_MARKER_MARGIN_PX,
      projection
    ) || pointIntersectsGameplayView(entrance, state)
  );
  const visibleManors = (state.manors ?? []).filter((manor) =>
    pointIntersectsViewport(projection.project(manor), MANOR_MARKER_MARGIN_PX, projection) ||
    pointIntersectsGameplayView(manor, state)
  );
  const visibleGreenhouses = (state.greenhouses ?? []).filter((greenhouse) =>
    pointIntersectsViewport(projection.project(greenhouse), GREENHOUSE_MARKER_MARGIN_PX, projection) ||
    pointIntersectsGameplayView(greenhouse, state)
  );
  const visibleFurnaces = (state.furnaces ?? []).filter((furnace) =>
    pointIntersectsViewport(projection.project(furnace), FURNACE_MARKER_MARGIN_PX, projection) ||
    pointIntersectsGameplayView(furnace, state)
  );
  const visibleTanneries = (state.tanneries ?? []).filter((tannery) =>
    pointIntersectsViewport(projection.project(tannery), TANNERY_MARKER_MARGIN_PX, projection) ||
    pointIntersectsGameplayView(tannery, state)
  );
  const visibleLooms = (state.looms ?? []).filter((loom) =>
    pointIntersectsViewport(projection.project(loom), LOOM_MARKER_MARGIN_PX, projection) ||
    pointIntersectsGameplayView(loom, state)
  );
  const visibleFishingHuts = (state.fishingHuts ?? []).filter((fishingHut) =>
    pointIntersectsViewport(projection.project(fishingHut), FISHING_HUT_MARKER_MARGIN_PX, projection) ||
    pointIntersectsGameplayView(fishingHut, state)
  );
  const visibleCollectibles = state.collectibles.filter((collectible) =>
    pointInsideGameplayView(collectible, state) &&
    (
      pointIntersectsViewport(
        projection.project(collectible),
        COLLECTIBLE_MARKER_MARGIN_PX,
        projection
      ) || pointIntersectsGameplayView(collectible, state)
    )
  );
  const visibleDroppedItems = state.droppedItems.filter((drop) =>
    pointIntersectsViewport(
      projection.project(drop),
      DROPPED_ITEM_MARKER_MARGIN_PX,
      projection
    ) || pointIntersectsGameplayView(drop, state)
  );
  const visibleWaterHighlights = state.waterHighlights.filter((highlight) =>
    pointIntersectsViewport(projection.project(highlight), WATER_MARKER_MARGIN_PX, projection) ||
    pointIntersectsGameplayView(highlight, state)
  );
  const resourceVision =
    state.resourceVision &&
    circleIntersectsViewport(
      projection.project(state.resourceVision.center),
      projection.radiusPixels(state.resourceVision.center, state.resourceVision.radiusM),
      projection
    )
      ? state.resourceVision
      : null;
  const players = localPlayerLeashIntersectsViewport(state, projection)
    ? state.players
    : state.players.filter((player) => player.playerId !== state.localPlayerId);

  return {
    ...state,
    players,
    flags: visibleFlags,
    cities: visibleCities,
    cityStructures: visibleCityStructures,
    dungeonEntrances: visibleDungeonEntrances,
    manors: visibleManors,
    greenhouses: visibleGreenhouses,
    furnaces: visibleFurnaces,
    tanneries: visibleTanneries,
    looms: visibleLooms,
    fishingHuts: visibleFishingHuts,
    collectibles: visibleCollectibles,
    droppedItems: visibleDroppedItems,
    resourceVision,
    waterHighlights: visibleWaterHighlights,
    selectedFlagId: visibleFlags.some((flag) => flag.id === state.selectedFlagId)
      ? state.selectedFlagId
      : null,
    selectedCityId: visibleCities.some((city) => city.id === state.selectedCityId)
      ? state.selectedCityId
      : null,
    selectedDungeonEntranceId: visibleDungeonEntrances.some(
      (entrance) => entrance.entranceId === state.selectedDungeonEntranceId
    ) ? state.selectedDungeonEntranceId : null,
    selectedManorId: visibleManors.some((manor) => manor.manorId === state.selectedManorId)
      ? state.selectedManorId
      : null,
    selectedFurnaceId: visibleFurnaces.some(
      (furnace) => furnace.furnaceId === state.selectedFurnaceId
    ) ? state.selectedFurnaceId : null,
    selectedTanneryId: visibleTanneries.some(
      (tannery) => tannery.tanneryId === state.selectedTanneryId
    ) ? state.selectedTanneryId : null,
    selectedLoomId: visibleLooms.some(
      (loom) => loom.loomId === state.selectedLoomId
    ) ? state.selectedLoomId : null,
    selectedFishingHutId: visibleFishingHuts.some(
      (fishingHut) => fishingHut.fishingHutId === state.selectedFishingHutId
    ) ? state.selectedFishingHutId ?? null : null,
    selectedDroppedItemId: visibleDroppedItems.some(
      (drop) => drop.dropId === state.selectedDroppedItemId
    )
      ? state.selectedDroppedItemId
      : null
  };
}

function pointIntersectsGameplayView(point: LatLon, state: RenderState): boolean {
  return circleIntersectsGameplayView(point, 0, state);
}

export function pointInsideGameplayView(point: LatLon, state: Pick<RenderState, "gameplayViewCircle">): boolean {
  const circle = state.gameplayViewCircle;
  return Boolean(
    circle && distanceMeters(circle.center, point) <= circle.radiusM
  );
}

function circleIntersectsGameplayView(
  center: LatLon,
  radiusM: number,
  state: RenderState
): boolean {
  const circle = state.gameplayViewCircle;
  return Boolean(
    circle &&
    distanceMeters(circle.center, center) <= circle.radiusM + Math.max(radiusM, 0)
  );
}

function localPlayerLeashIntersectsViewport(
  state: RenderState,
  projection: StaticOverlayProjection
): boolean {
  const localPlayer = state.players.find((player) => player.playerId === state.localPlayerId);
  if (!localPlayer) {
    return false;
  }
  const anchor = {
    lat: localPlayer.anchorLat,
    lon: localPlayer.anchorLon
  };
  return circleIntersectsViewport(
    projection.project(anchor),
    projection.radiusPixels(anchor, localPlayer.moveLeashRadiusM),
    projection
  );
}

function pointIntersectsViewport(
  point: { x: number; y: number },
  marginPx: number,
  projection: Pick<StaticOverlayProjection, "width" | "height" | "padPx">
): boolean {
  const margin = marginPx + (projection.padPx ?? 0);
  return (
    point.x >= -margin &&
    point.x <= projection.width + margin &&
    point.y >= -margin &&
    point.y <= projection.height + margin
  );
}

function circleIntersectsViewport(
  point: { x: number; y: number },
  radiusPx: number,
  projection: Pick<StaticOverlayProjection, "width" | "height" | "padPx">
): boolean {
  return pointIntersectsViewport(point, Math.max(radiusPx, 0), projection);
}
