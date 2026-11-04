import { describe, expect, it } from "vitest";

import { resolveTerritoryAtPoint, type TerritoryFlag } from "../game/territory.js";

const EARTH_RADIUS_M = 6_371_008.8;

describe("resolveTerritoryAtPoint", () => {
  it("returns open land outside all flag claims", () => {
    const result = resolveTerritoryAtPoint({
      lat: 35.02,
      lon: -106,
      flags: [flagAt("flag-a", "player-a", 35, -106, 700)]
    });

    expect(result.claimed).toBe(false);
    expect(result.ownerPlayerId).toBeNull();
    expect(result.nearestFlagId).toBe("flag-a");
    expect(result.distanceToNearestClaimEdgeM).toBeGreaterThan(1_000);
  });

  it("returns the owner when inside one claim circle", () => {
    const result = resolveTerritoryAtPoint({
      lat: 35,
      lon: -106,
      flags: [
        flagAt("flag-a", "player-a", 35, -106, 700, {
          ownerUsername: "Ash",
          ownerColor: "#aa0000",
          name: "Mesa"
        })
      ]
    });

    expect(result).toMatchObject({
      claimed: true,
      ownerPlayerId: "player-a",
      ownerUsername: "Ash",
      ownerColor: "#aa0000",
      nearestFlagId: "flag-a",
      nearestFlagName: "Mesa",
      coveringFlagCount: 1
    });
    expect(result.distanceToNearestFlagM).toBeCloseTo(0, 3);
    expect(result.distanceToNearestClaimEdgeM).toBeCloseTo(700, 0);
  });

  it("uses the nearest opposing flag in overlapping territory", () => {
    const result = resolveTerritoryAtPoint({
      lat: 35,
      lon: -106,
      flags: [
        flagAt("flag-a", "player-a", offsetLat(35, -500), -106, 700),
        flagAt("flag-b", "player-b", offsetLat(35, 100), -106, 700, {
          ownerUsername: "Bex"
        })
      ]
    });

    expect(result.claimed).toBe(true);
    expect(result.ownerPlayerId).toBe("player-b");
    expect(result.ownerUsername).toBe("Bex");
    expect(result.nearestFlagId).toBe("flag-b");
    expect(result.coveringFlagCount).toBe(2);
  });

  it("breaks equal-distance ties by flag id", () => {
    const result = resolveTerritoryAtPoint({
      lat: 35,
      lon: -106,
      flags: [
        flagAt("flag-b", "player-b", offsetLat(35, 100), -106, 700),
        flagAt("flag-a", "player-a", offsetLat(35, -100), -106, 700)
      ]
    });

    expect(result.claimed).toBe(true);
    expect(result.nearestFlagId).toBe("flag-a");
    expect(result.ownerPlayerId).toBe("player-a");
  });

  it("treats same-owner overlapping flags as the same owner territory", () => {
    const result = resolveTerritoryAtPoint({
      lat: 35,
      lon: -106,
      flags: [
        flagAt("flag-a", "player-a", offsetLat(35, -400), -106, 700),
        flagAt("flag-b", "player-a", offsetLat(35, 300), -106, 700)
      ]
    });

    expect(result.claimed).toBe(true);
    expect(result.ownerPlayerId).toBe("player-a");
    expect(result.coveringFlagCount).toBe(2);
  });

  it("counts the exact radius edge as claimed", () => {
    const result = resolveTerritoryAtPoint({
      lat: offsetLat(35, 700),
      lon: -106,
      flags: [flagAt("flag-a", "player-a", 35, -106, 700)]
    });

    expect(result.claimed).toBe(true);
    expect(result.ownerPlayerId).toBe("player-a");
    expect(result.distanceToNearestClaimEdgeM).toBeCloseTo(0, 5);
  });
});

function flagAt(
  id: string,
  ownerId: string,
  lat: number,
  lon: number,
  claimRadiusM: number,
  options: {
    ownerUsername?: string;
    ownerColor?: string;
    name?: string;
  } = {}
): TerritoryFlag {
  const flag: TerritoryFlag = {
    id,
    ownerId,
    lat,
    lon,
    claimRadiusM
  };
  if (options.ownerUsername) {
    flag.ownerUsername = options.ownerUsername;
  }
  if (options.ownerColor) {
    flag.ownerColor = options.ownerColor;
  }
  if (options.name) {
    flag.name = options.name;
  }
  return flag;
}

function offsetLat(lat: number, meters: number): number {
  return lat + (meters / EARTH_RADIUS_M) * (180 / Math.PI);
}
