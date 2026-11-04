import type { CitySnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import type { RenderState } from "../map/mapObjects.js";
import { restoreSuppressedStaticOverlay } from "../map/staticOverlayRestoration.js";
import { visibleStaticRenderState } from "../map/staticOverlayVisibility.js";
import { reconcileCitySnapshot } from "./cityReplication.js";

describe("city travel visibility", () => {
  it("restores Albuquerque after ABQ -> Santa Fe -> ABQ scopes and a membership change", () => {
    const albuquerque = city(
      "00000000-0000-4000-8000-0000000000c2",
      "Albuquerque",
      35.0844,
      -106.6504
    );
    const santaFe = city(
      "00000000-0000-4000-8000-0000000000d4",
      "Santa Fe",
      35.6844,
      -105.9504
    );

    let reactCities = reconcileCitySnapshot([], [albuquerque]);
    reactCities = reconcileCitySnapshot(reactCities, [santaFe]);
    reactCities = reconcileCitySnapshot(reactCities, [santaFe]);
    reactCities = reconcileCitySnapshot(reactCities, [albuquerque]);

    expect(reactCities.map(({ id }) => id)).toEqual([albuquerque.id, santaFe.id]);

    const renderState = state(reactCities);
    expect(renderState.cities.map(({ id }) => id)).toContain(albuquerque.id);

    const visibleAtAlbuquerque = visibleStaticRenderState(
      renderState,
      projectionAt(albuquerque)
    );
    expect(visibleAtAlbuquerque.cities.map(({ id }) => id)).toEqual([albuquerque.id]);

    let renderedCityIds: string[] = [];
    restoreSuppressedStaticOverlay({
      resetTransform: () => undefined,
      redraw: () => {
        renderedCityIds = visibleAtAlbuquerque.cities.map(({ id }) => id);
      },
      reveal: () => undefined
    });

    expect(renderedCityIds).toEqual([albuquerque.id]);
  });
});

function state(cities: CitySnapshot[]): RenderState {
  return {
    localPlayerId: "player-1",
    players: [],
    flags: [],
    cities,
    cityStructures: [],
    dungeonEntrances: [],
  manors: [],
  furnaces: [],
  tanneries: [],
  looms: [],
    collectibles: [],
    droppedItems: [],
    resourceVision: null,
    waterHighlights: [],
    selectedFlagId: null,
    selectedCityId: null,
    selectedDungeonEntranceId: null,
  selectedManorId: null,
  selectedFurnaceId: null,
  selectedTanneryId: null,
  selectedLoomId: null,
    selectedCollectibleId: null,
    selectedDroppedItemId: null,
    selectedCombatEntityId: null
  };
}

function projectionAt(center: CitySnapshot) {
  return {
    width: 800,
    height: 600,
    project(point: { lat: number; lon: number }) {
      return {
        x: 400 + (point.lon - center.lon) * 10_000,
        y: 300 - (point.lat - center.lat) * 10_000
      };
    },
    radiusPixels: () => 0
  };
}

function city(
  id: string,
  name: string,
  lat: number,
  lon: number
): CitySnapshot {
  return {
    id,
    worldId: "main",
    worldSettlementId: `settlement-${id}`,
    worldSettlementSource: "test",
    worldSourceSettlementId: `source-${id}`,
    settlementClass: "city",
    settlementReleaseId: "world-settlements-v1",
    settlementReleaseFingerprint: "f".repeat(64),
    name,
    countryCode: "US",
    regionCode: "US-NM",
    founderPlayerId: "founder",
    mayorPlayerId: "mayor",
    mayorConfirmed: true,
    founderMayorClaimDeadline: null,
    seatFlagId: "00000000-0000-4000-8000-000000000001",
    lat,
    lon,
    active: true,
    jumpable: true,
    constructionPhase: "complete",
    constructionCompletedAt: "2026-07-10T00:00:00.000Z",
    constructionContributions: [],
    spatialRevision: "1",
    foundingAnnexRadiusM: 1_000,
    createdAt: "2026-07-18T00:00:00.000Z"
  };
}
