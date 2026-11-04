import { destinationPoint, SIEGE_ATTACK_RANGE_METERS, type FlagSnapshot, type MilitaryUnitGroupSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { siegeTargetFlagIds, siegeFacingTarget } from "./militaryTargetPresentation.js";

const origin = { lat: 35.0844, lon: -106.6504 };

describe("military target presentation", () => {
  it("faces the nearest attacked Tower even when a farther Tower anchors the area volley", () => {
    const near = makeFlag("near", destinationPoint(origin, 100, 270),
      { upgradeTier: "tower", reinforcementLevel: 3, health: 2700, maximumHealth: 2700 });
    const far = makeFlag("far", destinationPoint(origin, 300, 90),
      { upgradeTier: "tower", reinforcementLevel: 3, health: 2700, maximumHealth: 2700 });
    const closerFriendly = { ...near, id: "friendly", ownerId: "player-1", ...destinationPoint(origin, 20, 90) };
    const group = makeSiege({ targetFlagId: far.id });
    expect(siegeFacingTarget(group, [far, closerFriendly, near], [])?.id).toBe("near");
    expect(siegeFacingTarget(group, [far, { ...near, health: 0 }], [])?.id).toBe("far");
    expect(siegeFacingTarget(group, [near, { ...near, id: "a-tie" }], [])?.id).toBe("a-tie");
  });

  it("faces only the attacked city building or organization structure in single-target warfare", () => {
    const personal = makeFlag("near-personal", destinationPoint(origin, 100, 270),
      { upgradeTier: "tower", reinforcementLevel: 3, health: 2700, maximumHealth: 2700 });
    const building = { structureId: "building", ...destinationPoint(origin, 300, 90) };
    const otherBuilding = { structureId: "unattacked-building", ...destinationPoint(origin, 50, 270) };
    expect(siegeFacingTarget(makeSiege({ targetCityStructureId: building.structureId }),
      [personal], [otherBuilding, building])).toEqual({ id: building.structureId, lat: building.lat, lon: building.lon });
    expect(siegeFacingTarget(makeSiege({ targetCityStructureId: "missing" }), [personal], [otherBuilding])).toBeNull();
    const cityFlag = { ...personal, id: "city-flag", controlType: "city" as const, cityId: "city-1",
      ...destinationPoint(origin, 300, 90) };
    expect(siegeFacingTarget(makeSiege({ targetFlagId: cityFlag.id }), [personal, cityFlag], [])?.id).toBe(cityFlag.id);
    expect(siegeFacingTarget(makeSiege({ locationState: "PACKED_FIELD" }), [personal], [])).toBeNull();
  });

  it("recomputes every eligible Siege target from the latest group and flag snapshots", () => {
    const group = makeSiege();
    const inRange = makeFlag("in-range", destinationPoint(origin, 300, 0), { upgradeTier: "tower", reinforcementLevel: 3, health: 2_700, maximumHealth: 2_700 });
    const edge = makeFlag("edge", destinationPoint(origin, SIEGE_ATTACK_RANGE_METERS, 90), { upgradeTier: "tower", reinforcementLevel: 3, health: 2_700, maximumHealth: 2_700 });
    const outOfRange = makeFlag("out-of-range", destinationPoint(origin, SIEGE_ATTACK_RANGE_METERS + 1, 180), { upgradeTier: "tower", reinforcementLevel: 3, health: 2_700, maximumHealth: 2_700 });

    expect(siegeTargetFlagIds(group, [inRange, edge, outOfRange])).toEqual([
      "edge",
      "in-range"
    ]);
    expect(siegeTargetFlagIds(group, [
      { ...inRange, lat: outOfRange.lat, lon: outOfRange.lon },
      edge
    ])).toEqual(["edge"]);
    expect(siegeTargetFlagIds(group, [
      { ...inRange, health: 1_350, maximumHealth: 2_700 },
      edge
    ])).toEqual(["edge", "in-range"]);
    expect(siegeTargetFlagIds(group, [
      { ...inRange, health: 375, maximumHealth: 2_700, burning: true },
      edge
    ])).toEqual(["edge", "in-range"]);
    expect(siegeTargetFlagIds(group, [
      { ...inRange, health: 2_699, maximumHealth: 2_700 },
      edge
    ])).toEqual(["edge", "in-range"]);
    expect(siegeTargetFlagIds(group, [
      makeFlag("soft", destinationPoint(origin, 100, 45)),
      makeFlag("stone", destinationPoint(origin, 100, 135), { upgradeTier: "stone", reinforcementLevel: 1 }),
      makeFlag("burning-base", destinationPoint(origin, 100, 225), { burning: true, upgradeTier: "base", reinforcementLevel: 0, health: 50, maximumHealth: 100 }),
      makeFlag("burning-stone", destinationPoint(origin, 100, 315), { burning: true, upgradeTier: "stone", reinforcementLevel: 1, health: 50, maximumHealth: 220 }),
      edge
    ])).toEqual(["edge"]);
  });

  it("does not present targets for a Siege that is not deployed or has no field position", () => {
    const target = makeFlag("target", destinationPoint(origin, 100, 0));
    expect(siegeTargetFlagIds(makeSiege({ locationState: "PACKED_FIELD" }), [target])).toEqual([]);
    expect(siegeTargetFlagIds(makeSiege({ lat: null, lon: null }), [target])).toEqual([]);
  });
});

function makeSiege(
  overrides: Partial<MilitaryUnitGroupSnapshot> = {}
): MilitaryUnitGroupSnapshot {
  return {
    groupId: "siege-1",
    ownerPlayerId: "player-1",
    unitType: "field_ballista",
    memberUnitIds: ["unit-1"],
    memberCount: 1,
    currentHp: 150,
    maxHp: 150,
    locationState: "DEPLOYED_FIELD",
    stationCityId: null,
    warCampId: null,
    lat: origin.lat,
    lon: origin.lon,
    targetFlagId: null,
    nextFireAt: null,
    packingCompletesAt: null,
    revision: "1",
    ...overrides
  };
}

function makeFlag(
  id: string,
  position: { lat: number; lon: number },
  overrides: Partial<FlagSnapshot> = {}
): FlagSnapshot {
  return {
    id,
    controlType: "personal",
    ownerId: "enemy-player",
    ownerUsername: "Enemy",
    name: `Enemy ${id}`,
    anchorKind: "flag",
    systemControlled: false,
    lat: position.lat,
    lon: position.lon,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    claimRadiusM: 100,
    cityId: null,
    kingdomId: null,
    reinforcementLevel: 1,
    upgradeTier: "stone",
    health: 220,
    maximumHealth: 220,
    burning: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
