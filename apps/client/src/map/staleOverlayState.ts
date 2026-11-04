import type {
  CollectibleNode,
  CitySnapshot,
  CityStructureSnapshot,
  DungeonEntranceSnapshot,
  DroppedItemSnapshot,
  FlagSnapshot,
  FurnaceWorldSnapshot,
  TanneryWorldSnapshot,
  LoomWorldSnapshot,
  FishingHutWorldSnapshot,
  WaterSourceHighlight
} from "@ash-atlas/shared";

import type { RenderState } from "./mapObjects.js";

export function staleWhileInteractingRenderState(
  frozen: RenderState,
  latest: RenderState
): RenderState {
  const latestFlagsById = new Map(latest.flags.map((flag) => [flag.id, flag]));
  const latestCitiesById = new Map(latest.cities.map((city) => [city.id, city]));
  const latestCityStructuresById = new Map(
    latest.cityStructures.map((structure) => [structure.structureId, structure])
  );
  const latestDungeonEntrancesById = new Map(
    latest.dungeonEntrances.map((entrance) => [entrance.entranceId, entrance])
  );
  const latestFurnacesById = new Map(
    latest.furnaces.map((furnace) => [furnace.furnaceId, furnace])
  );
  const latestGreenhousesById = new Map(
    (latest.greenhouses ?? []).map((greenhouse) => [greenhouse.greenhouseId, greenhouse])
  );
  const latestTanneriesById = new Map(
    latest.tanneries.map((tannery) => [tannery.tanneryId, tannery])
  );
  const latestLoomsById = new Map(
    latest.looms.map((loom) => [loom.loomId, loom])
  );
  const latestFishingHutsById = new Map(
    (latest.fishingHuts ?? []).map((fishingHut) => [fishingHut.fishingHutId, fishingHut])
  );
  const latestCollectiblesById = new Map(
    latest.collectibles.map((collectible) => [collectible.id, collectible])
  );
  const latestWaterHighlightsById = new Map(
    latest.waterHighlights.map((highlight) => [highlight.id, highlight])
  );
  const latestDroppedItemsById = new Map(
    latest.droppedItems.map((drop) => [drop.dropId, drop])
  );
  const flags = pruneByLatest(frozen.flags, latestFlagsById);
  const cities = pruneByLatest(frozen.cities, latestCitiesById);
  const cityStructures = pruneCityStructuresByLatest(
    frozen.cityStructures,
    latestCityStructuresById
  );
  const dungeonEntrances = pruneDungeonEntrancesByLatest(
    frozen.dungeonEntrances,
    latestDungeonEntrancesById
  );
  const furnaces = pruneFurnacesByLatest(frozen.furnaces, latestFurnacesById);
  const greenhouses = (frozen.greenhouses ?? []).filter((greenhouse) =>
    latestGreenhousesById.has(greenhouse.greenhouseId)
  );
  const tanneries = pruneTanneriesByLatest(frozen.tanneries, latestTanneriesById);
  const looms = pruneLoomsByLatest(frozen.looms, latestLoomsById);
  const fishingHuts = pruneFishingHutsByLatest(frozen.fishingHuts ?? [], latestFishingHutsById);
  const collectibles = pruneByLatest(frozen.collectibles, latestCollectiblesById);
  const waterHighlights = pruneByLatest(frozen.waterHighlights, latestWaterHighlightsById);
  const droppedItems = pruneDroppedItemsByLatest(frozen.droppedItems, latestDroppedItemsById);
  const resourceVision =
    latest.resourceVision === null
      ? null
      : frozen.resourceVision?.flagId === latest.resourceVision.flagId
        ? frozen.resourceVision
        : frozen.resourceVision;

  return {
    ...latest,
    flags,
    cities,
    cityStructures,
    dungeonEntrances,
    furnaces,
    greenhouses,
    tanneries,
    looms,
    fishingHuts,
    collectibles,
    droppedItems,
    resourceVision,
    waterHighlights,
    selectedFlagId: flags.some((flag) => flag.id === latest.selectedFlagId)
      ? latest.selectedFlagId
      : null,
    selectedCityId: cities.some((city) => city.id === latest.selectedCityId)
      ? latest.selectedCityId
      : null,
    selectedDungeonEntranceId: dungeonEntrances.some(
      (entrance) => entrance.entranceId === latest.selectedDungeonEntranceId
    ) ? latest.selectedDungeonEntranceId : null,
    selectedFurnaceId: furnaces.some(
      (furnace) => furnace.furnaceId === latest.selectedFurnaceId
    ) ? latest.selectedFurnaceId : null,
    selectedTanneryId: tanneries.some(
      (tannery) => tannery.tanneryId === latest.selectedTanneryId
    ) ? latest.selectedTanneryId : null,
    selectedLoomId: looms.some(
      (loom) => loom.loomId === latest.selectedLoomId
    ) ? latest.selectedLoomId : null,
    selectedFishingHutId: fishingHuts.some(
      (fishingHut) => fishingHut.fishingHutId === latest.selectedFishingHutId
    ) ? latest.selectedFishingHutId ?? null : null,
    selectedDroppedItemId: droppedItems.some(
      (drop) => drop.dropId === latest.selectedDroppedItemId
    )
      ? latest.selectedDroppedItemId
      : null
  };
}

function pruneDungeonEntrancesByLatest(
  frozenItems: DungeonEntranceSnapshot[],
  latestById: Map<string, DungeonEntranceSnapshot>
): DungeonEntranceSnapshot[] {
  return frozenItems.flatMap((item) => {
    const latest = latestById.get(item.entranceId);
    return latest ? [latest] : [];
  });
}

function pruneFurnacesByLatest(
  frozenItems: FurnaceWorldSnapshot[],
  latestById: Map<string, FurnaceWorldSnapshot>
): FurnaceWorldSnapshot[] {
  return frozenItems.flatMap((item) => {
    const latest = latestById.get(item.furnaceId);
    return latest ? [latest] : [];
  });
}

function pruneTanneriesByLatest(
  frozenItems: TanneryWorldSnapshot[],
  latestById: Map<string, TanneryWorldSnapshot>
): TanneryWorldSnapshot[] {
  return frozenItems.flatMap((item) => {
    const latest = latestById.get(item.tanneryId);
    return latest ? [latest] : [];
  });
}

function pruneLoomsByLatest(
  frozenItems: LoomWorldSnapshot[],
  latestById: Map<string, LoomWorldSnapshot>
): LoomWorldSnapshot[] {
  return frozenItems.flatMap((item) => {
    const latest = latestById.get(item.loomId);
    return latest ? [latest] : [];
  });
}

function pruneFishingHutsByLatest(
  frozenItems: FishingHutWorldSnapshot[],
  latestById: Map<string, FishingHutWorldSnapshot>
): FishingHutWorldSnapshot[] {
  return frozenItems.flatMap((item) => {
    const latest = latestById.get(item.fishingHutId);
    return latest ? [latest] : [];
  });
}

function pruneCityStructuresByLatest(
  frozenItems: CityStructureSnapshot[],
  latestById: Map<string, CityStructureSnapshot>
): CityStructureSnapshot[] {
  return frozenItems.flatMap((item) => {
    const latest = latestById.get(item.structureId);
    return latest ? [latest] : [];
  });
}

function pruneByLatest<T extends CitySnapshot | FlagSnapshot | CollectibleNode | WaterSourceHighlight>(
  frozenItems: T[],
  latestById: Map<string, T>
): T[] {
  return frozenItems.flatMap((item) => {
    const latest = latestById.get(item.id);
    return latest ? [latest] : [];
  });
}

function pruneDroppedItemsByLatest(
  frozenItems: DroppedItemSnapshot[],
  latestById: Map<string, DroppedItemSnapshot>
): DroppedItemSnapshot[] {
  return frozenItems.flatMap((item) => {
    const latest = latestById.get(item.dropId);
    return latest ? [latest] : [];
  });
}
