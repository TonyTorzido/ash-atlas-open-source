import {
  CITY_MARKET_INTERACTION_RADIUS_M,
  OIL_WELL_INTERACTION_RADIUS_M,
  CITY_STRUCTURE_INTERACTION_RADIUS_M,
  distanceMeters,
  type CityStructureSnapshot
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  advanceCityStructureInteraction,
  attachCityStructureMovement,
  beginCityStructureInteraction,
  cityStructureApproachPoint,
  cityStructureInteractionReady,
  cityStructureIntentStillValid,
  oilWellHarvestPromptState
} from "./cityStructureInteraction.js";

const market = {
  structureId: "00000000-0000-4000-8000-000000000001",
  cityId: "00000000-0000-4000-8000-000000000002",
  type: "market",
  state: "active",
  lat: 40,
  lon: -105,
  footprintRadiusM: 20,
  placementRevision: "7"
} as CityStructureSnapshot;

const oilWell = {
  ...market,
  structureId: "00000000-0000-4000-8000-000000000003",
  type: "oil_well",
  footprintRadiusM: 12,
  ownerPlayerId: "owner",
  ownerUsername: "Owner"
} as CityStructureSnapshot;

const kennel = {
  ...market,
  structureId: "00000000-0000-4000-8000-000000000004",
  type: "city_kennel",
  footprintRadiusM: 15
} as CityStructureSnapshot;

describe("city structure interaction", () => {
  it("opens immediately only when authoritative position is already in range", () => {
    expect(CITY_MARKET_INTERACTION_RADIUS_M).toBe(CITY_STRUCTURE_INTERACTION_RADIUS_M);
    const decision = beginCityStructureInteraction({
      kind: "market",
      structure: market,
      player: { lat: market.lat + 24 / 111_195, lon: market.lon },
      connectionGeneration: 3,
      source: "world"
    });
    expect(decision.kind).toBe("open_now");
  });

  it("approaches a Market from roughly 128 meters to its canonical inside-range point", () => {
    const player = { lat: market.lat + 128 / 111_195, lon: market.lon };
    const first = cityStructureApproachPoint(
      player,
      market,
      CITY_MARKET_INTERACTION_RADIUS_M
    );
    const second = cityStructureApproachPoint(
      player,
      market,
      CITY_MARKET_INTERACTION_RADIUS_M
    );
    expect(first).toEqual(second);
    const distance = distanceMeters(first, market);
    expect(distance).toBeGreaterThan(market.footprintRadiusM);
    expect(distance).toBeLessThan(CITY_MARKET_INTERACTION_RADIUS_M);
    expect(distance).toBeCloseTo(CITY_MARKET_INTERACTION_RADIUS_M - 2, 0);
  });

  it("waits for an authoritative stopped movement frame before opening", () => {
    const decision = beginCityStructureInteraction({
      kind: "market",
      structure: market,
      player: { lat: 40.01, lon: -105.01 },
      connectionGeneration: 3,
      source: "city"
    });
    if (decision.kind !== "approach") throw new Error("Expected approach");
    expect(cityStructureInteractionReady({
      intent: decision.intent,
      structure: market,
      player: { ...decision.target, moving: true },
      connectionGeneration: 3
    })).toBe(false);
    expect(cityStructureInteractionReady({
      intent: decision.intent,
      structure: market,
      player: { ...decision.target, moving: false },
      connectionGeneration: 3
    })).toBe(true);
  });

  it("advances only the current accepted movement to ready", () => {
    const decision = beginCityStructureInteraction({
      kind: "market",
      structure: market,
      player: { lat: 40.01, lon: -105.01 },
      connectionGeneration: 3,
      source: "world"
    });
    if (decision.kind !== "approach") throw new Error("Expected approach");
    const intent = attachCityStructureMovement(decision.intent, "move-market");
    const currentMovement = { requestId: "move-market", accepted: true };

    expect(advanceCityStructureInteraction({
      intent,
      structure: market,
      player: { ...decision.target, moving: false },
      movement: currentMovement,
      connectionGeneration: 3
    })).toBe("ready");
    expect(advanceCityStructureInteraction({
      intent,
      structure: market,
      player: { ...decision.target, moving: false },
      movement: { ...currentMovement, accepted: false },
      connectionGeneration: 3
    })).toBe("waiting");
    expect(advanceCityStructureInteraction({
      intent,
      structure: market,
      player: { ...decision.target, moving: true },
      movement: currentMovement,
      connectionGeneration: 3
    })).toBe("waiting");
  });

  it("cancels stale movement and invalid structure authority", () => {
    const decision = beginCityStructureInteraction({
      kind: "market",
      structure: market,
      player: { lat: 40.01, lon: -105.01 },
      connectionGeneration: 3,
      source: "world"
    });
    if (decision.kind !== "approach") throw new Error("Expected approach");
    const intent = attachCityStructureMovement(decision.intent, "move-market");

    expect(advanceCityStructureInteraction({
      intent,
      structure: market,
      player: { ...decision.target, moving: false },
      movement: { requestId: "move-newer", accepted: true },
      connectionGeneration: 3
    })).toBe("cancel");
    expect(advanceCityStructureInteraction({
      intent,
      structure: { ...market, placementRevision: "8" },
      player: { ...decision.target, moving: false },
      movement: { requestId: "move-market", accepted: true },
      connectionGeneration: 3
    })).toBe("cancel");
  });

  it("marks an accepted stopped movement outside interaction range unreachable", () => {
    const decision = beginCityStructureInteraction({
      kind: "market",
      structure: market,
      player: { lat: 40.01, lon: -105.01 },
      connectionGeneration: 3,
      source: "world"
    });
    if (decision.kind !== "approach") throw new Error("Expected approach");
    const intent = attachCityStructureMovement(decision.intent, "move-market");

    expect(advanceCityStructureInteraction({
      intent,
      structure: market,
      player: {
        lat: market.lat + (CITY_MARKET_INTERACTION_RADIUS_M + 15) / 111_195,
        lon: market.lon,
        moving: false
      },
      movement: { requestId: "move-market", accepted: true },
      connectionGeneration: 3
    })).toBe("unreachable");
  });

  it("invalidates intent across placement and connection generations", () => {
    const decision = beginCityStructureInteraction({
      kind: "market",
      structure: market,
      player: { lat: 40.01, lon: -105.01 },
      connectionGeneration: 3,
      source: "city"
    });
    expect(cityStructureIntentStillValid({
      intent: decision.intent,
      structure: market,
      connectionGeneration: 4
    })).toBe(false);
    expect(cityStructureIntentStillValid({
      intent: decision.intent,
      structure: { ...market, placementRevision: "8" },
      connectionGeneration: 3
    })).toBe(false);
  });

  it("uses the owner Oil Well's 50 meter interaction radius", () => {
    const decision = beginCityStructureInteraction({
      kind: "oil_well",
      structure: oilWell,
      player: { lat: oilWell.lat, lon: oilWell.lon + 0.001 },
      connectionGeneration: 3,
      source: "world"
    });
    expect(decision.kind).toBe("approach");
    if (decision.kind !== "approach") return;
    expect(distanceMeters(decision.target, oilWell)).toBeLessThan(
      OIL_WELL_INTERACTION_RADIUS_M
    );
  });

  it("approaches a City Kennel using the shared 50 meter interaction radius", () => {
    const inRange = beginCityStructureInteraction({
      kind: "city_kennel",
      structure: kennel,
      player: { lat: kennel.lat + 0.0002, lon: kennel.lon },
      connectionGeneration: 3,
      source: "world"
    });
    expect(distanceMeters({ lat: kennel.lat + 0.0002, lon: kennel.lon }, kennel))
      .toBeLessThan(CITY_STRUCTURE_INTERACTION_RADIUS_M);
    expect(inRange.kind).toBe("open_now");

    const decision = beginCityStructureInteraction({
      kind: "city_kennel",
      structure: kennel,
      player: { lat: kennel.lat + 70 / 111_195, lon: kennel.lon },
      connectionGeneration: 3,
      source: "world"
    });
    expect(decision.kind).toBe("approach");
    if (decision.kind !== "approach") return;
    expect(distanceMeters(decision.target, kennel)).toBeLessThan(
      CITY_STRUCTURE_INTERACTION_RADIUS_M
    );
    expect(cityStructureInteractionReady({
      intent: decision.intent,
      structure: kennel,
      player: { ...decision.target, moving: true },
      connectionGeneration: 3
    })).toBe(false);
    expect(cityStructureInteractionReady({
      intent: decision.intent,
      structure: kennel,
      player: { ...decision.target, moving: false },
      connectionGeneration: 3
    })).toBe(true);
  });

  it("approaches a City Salon before entering through the portal", () => {
    const salon = {
      ...market,
      structureId: "00000000-0000-0000-0000-000000000005",
      type: "salon"
    } as CityStructureSnapshot;
    const decision = beginCityStructureInteraction({
      kind: "salon",
      structure: salon,
      player: { lat: salon.lat + 70 / 111_195, lon: salon.lon },
      connectionGeneration: 3,
      source: "world"
    });
    expect(decision.kind).toBe("approach");
    if (decision.kind !== "approach") return;
    expect(distanceMeters(decision.target, salon)).toBeLessThan(
      CITY_STRUCTURE_INTERACTION_RADIUS_M
    );
    expect(cityStructureInteractionReady({
      intent: decision.intent,
      structure: salon,
      player: { ...decision.target, moving: false },
      connectionGeneration: 3
    })).toBe(true);
  });

  it("offers an approach action before an out-of-range Oil Well can be inspected", () => {
    expect(oilWellHarvestPromptState({
      owner: true,
      active: true,
      online: true,
      busy: false,
      inactiveReason: null,
      well: null
    })).toEqual({
      label: "Approach to Harvest",
      enabled: true,
      disabledReason: null
    });
  });

  it("uses the authoritative Oil Well capacity after inspection", () => {
    expect(oilWellHarvestPromptState({
      owner: true,
      active: true,
      online: true,
      busy: false,
      inactiveReason: null,
      well: {
        structureId: oilWell.structureId,
        ownerPlayerId: "owner",
        ownerUsername: "Owner",
        storedCrudeOil: 124,
        capacity: 136,
        productionPerHour: 10,
        serverTime: 1,
        nextUnitAt: null,
        canHarvest: true,
        canDestroy: true
      }
    }).label).toBe("Harvest 124/136");
  });
});
