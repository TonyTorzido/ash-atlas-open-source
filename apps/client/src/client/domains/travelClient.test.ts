import type { FlagSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { destinationAuthorityForVisibleFlag } from "./travelClient.js";

describe("visible flag destination authority", () => {
  it("captures travel fields and personal access identity from the selected flag", () => {
    const personalFlag = flagSnapshot("personal");

    expect(destinationAuthorityForVisibleFlag(personalFlag)).toEqual({
      lat: personalFlag.lat,
      lon: personalFlag.lon,
      claimRadiusM: personalFlag.claimRadiusM,
      resourceVisionRadiusM: personalFlag.resourceVisionRadiusM,
      personalFlagId: personalFlag.id
    });

    expect(destinationAuthorityForVisibleFlag(flagSnapshot("kingdom_seat")))
      .not.toHaveProperty("personalFlagId");
  });
});

function flagSnapshot(
  controlType: FlagSnapshot["controlType"]
): FlagSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    controlType,
    ownerId: "player-1",
    name: "North Shrine",
    lat: 39.7392,
    lon: -104.9903,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    claimRadiusM: 700,
    resourceVisionRadiusM: 1_000,
    cityId: null,
    createdAt: "2026-08-10T00:00:00.000Z"
  };
}
