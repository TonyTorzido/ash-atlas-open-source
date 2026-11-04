import { describe, expect, it } from "vitest";

import type { FlagSnapshot, PlayerSnapshot, ResourceVision } from "@ash-atlas/shared";

import { resolveGameplayViewCircle } from "./gameplayViewCircle.js";

describe("resolveGameplayViewCircle", () => {
  it("uses the authoritative resource vision when available", () => {
    expect(resolveGameplayViewCircle(player(), [], vision())).toEqual({
      center: { lat: 35.1, lon: -106.6 },
      radiusM: 725
    });
  });

  it("keeps the circle available from player authority before vision arrives", () => {
    expect(resolveGameplayViewCircle(player(), [], null)).toEqual({
      center: { lat: 35, lon: -106.5 },
      radiusM: 650
    });
  });

  it("uses the current flag's persisted vision radius when present", () => {
    expect(resolveGameplayViewCircle(player(), [flag()], null)?.radiusM).toBe(800);
  });
});

function player(): PlayerSnapshot {
  return {
    playerId: "player-1",
    username: "Ash",
    displayColor: null,
    regionCode: "NM",
    zoneId: "world:NM",
    lat: 35,
    lon: -106.5,
    anchorLat: 35,
    anchorLon: -106.5,
    moveLeashRadiusM: 600,
    movementRevision: 1,
    targetLat: null,
    targetLon: null,
    moving: false,
    currentFlagId: "flag-1",
    online: true,
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
}

function vision(): ResourceVision {
  return {
    flagId: "flag-1",
    flagName: "Camp",
    center: { lat: 35.1, lon: -106.6 },
    movementLeashRadiusM: 675,
    paddingM: 50,
    radiusM: 725
  };
}

function flag(): FlagSnapshot {
  return {
    id: "flag-1",
    controlType: "personal",
    ownerId: "player-1",
    name: "Camp",
    lat: 35,
    lon: -106.5,
    packageId: "nm",
    elevationM: 1500,
    terrainClass: "flat",
    biome: "desert",
    ecoregion: "desert",
    claimRadiusM: 500,
    resourceVisionRadiusM: 800,
    cityId: null,
    createdAt: "2026-07-24T00:00:00.000Z"
  };
}
