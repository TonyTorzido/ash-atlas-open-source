import { type FlagSnapshot, type PlayerSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  formatDistance,
  getBuildableStatus,
  isFlagPlacementTargetClaimed,
  nearestTerritoryEdgeDistanceM,
  personalAnchorKindForTerrain
} from "./buildStatus.js";

describe("buildStatus", () => {
  it("maps authoritative terrain to the compatible personal anchor", () => {
    expect(personalAnchorKindForTerrain("land")).toBe("flag");
    expect(personalAnchorKindForTerrain("water")).toBe("buoy");
    expect(personalAnchorKindForTerrain("unknown")).toBeNull();
  });

  it("marks the player unbuildable inside own claimed territory", () => {
    const status = getBuildableStatus(playerAt(35, -106), [
      flagAt(35, -106, 700, {
        ownerId: "player-1",
        ownerUsername: "Ash",
        ownerColor: "#38bdf8"
      })
    ]);

    expect(status.buildable).toBe(false);
    expect(status.reason).toBe("inside own territory");
    expect(status.territoryLabel).toBe("Yours");
    expect(status.edgeDistanceM).toBeCloseTo(-700, 0);
    expect(status.label).toContain("inside your claimed territory");
    expect(status.guidance).toBe(
      "Inside Flag (your claimed territory) by 700 m. Move outside its boundary to build."
    );
    expect(status.serverMessage).toBe("Cannot build here: inside your claimed territory");
  });

  it("marks the player unbuildable inside another player's territory", () => {
    const status = getBuildableStatus(playerAt(35, -106), [
      flagAt(35, -106, 700, {
        ownerId: "player-2",
        ownerUsername: "Bex",
        ownerColor: "#3366cc"
      })
    ]);

    expect(status.buildable).toBe(false);
    expect(status.reason).toBe("inside other territory");
    expect(status.territoryOwnerName).toBe("Bex");
    expect(status.territoryOwnerColor).toBe("#3366cc");
    expect(status.territoryLabel).toBe("Bex");
    expect(status.label).toContain("inside Bex's claimed territory");
    expect(status.guidance).toBe(
      "Inside Flag (Bex's claimed territory) by 700 m. Move outside its boundary to build."
    );
    expect(status.serverMessage).toBe("Cannot build here: inside Bex's claimed territory");
  });

  it("marks the player buildable outside claimed territory", () => {
    const status = getBuildableStatus(playerAt(35.01, -106), [
      flagAt(35, -106, 700, { ownerId: "player-1" })
    ]);

    expect(status.buildable).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.edgeDistanceM).toBeGreaterThan(0);
    expect(status.territoryLabel).toBe("Open");
    expect(status.label).toContain("nearest territory edge");
    expect(status.guidance).toBe("Open land: ready to build");
  });

  it("detects whether a released placement target is already claimed", () => {
    const flag = flagAt(35, -106, 700, { ownerId: "player-2" });

    expect(isFlagPlacementTargetClaimed({ lat: 35, lon: -106 }, [flag])).toBe(true);
    expect(isFlagPlacementTargetClaimed({ lat: 35.01, lon: -106 }, [flag])).toBe(false);
  });

  it("uses the ordinary center rule for personal, Castle, and Kingdom Flag geometry", () => {
    const candidate = playerAt(35 + 250 / 111_195, -106);
    const ordinary = flagAt(35, -106, 200, { ownerId: "player-2" });
    const seat = flagAt(35, -106, 200, {
      ownerId: "leader",
      controlType: "kingdom_seat",
      kingdomName: "Crips"
    });
    const kingdomFlag = flagAt(35, -106, 200, {
      ownerId: "member",
      controlType: "kingdom",
      kingdomName: "Crips"
    });

    const statuses = [ordinary, seat, kingdomFlag].map((flag) =>
      getBuildableStatus(candidate, [flag], "land")
    );
    expect(statuses).toEqual([
      expect.objectContaining({ buildable: true, reason: null, serverMessage: null }),
      expect.objectContaining({ buildable: true, reason: null, serverMessage: null }),
      expect.objectContaining({ buildable: true, reason: null, serverMessage: null })
    ]);
    expect(statuses.every(({ previewState }) => previewState === "valid")).toBe(true);
  });

  it("marks the current flag preview invalid on authoritative water", () => {
    const status = getBuildableStatus(playerAt(35, -106), [], "water");

    expect(status).toMatchObject({
      buildable: false,
      reason: "water",
      guidance: "Cannot place flag on water",
      serverMessage: "Cannot place flag on water"
    });
  });

  it("keeps buoy as an explicit water-only build choice", () => {
    expect(getBuildableStatus(playerAt(35, -106), [], "water", "buoy")).toMatchObject({
      buildable: true,
      guidance: "Open water: ready to build"
    });
    expect(getBuildableStatus(playerAt(35, -106), [], "land", "buoy")).toMatchObject({
      buildable: false,
      reason: "land",
      serverMessage: "Cannot place buoy on land"
    });
    expect(getBuildableStatus(playerAt(35, -106), [], "unknown", "buoy")).toMatchObject({
      buildable: false,
      reason: "terrain unknown"
    });
  });

  it("does not promise valid terrain while classification is incomplete", () => {
    const status = getBuildableStatus(playerAt(35, -106), [], "unknown");

    expect(status.buildable).toBe(true);
    expect(status.reason).toBe("terrain unknown");
    expect(status.guidance).toContain("server will verify");
  });

  it("uses nearest owner in contested overlapping territory", () => {
    const status = getBuildableStatus(playerAt(35, -106), [
      flagAt(35 - 500 / 111_195, -106, 700, {
        id: "owned-far",
        ownerId: "player-1",
        ownerUsername: "Ash"
      }),
      flagAt(35 + 100 / 111_195, -106, 700, {
        id: "enemy-near",
        ownerId: "player-2",
        ownerUsername: "Bex"
      })
    ]);

    expect(status.buildable).toBe(false);
    expect(status.territoryOwnerId).toBe("player-2");
    expect(status.territoryLabel).toBe("Bex");
    expect(status.serverMessage).toBe("Cannot build here: inside Bex's claimed territory");
  });

  it("computes nearest edge distance", () => {
    const edge = nearestTerritoryEdgeDistanceM(playerAt(35.01, -106), [
      flagAt(35, -106, 700, { ownerId: "player-1" }),
      flagAt(36, -106, 700, { ownerId: "player-1" })
    ]);

    expect(edge).not.toBeNull();
    expect(edge ?? 0).toBeGreaterThan(300);
    expect(edge ?? 0).toBeLessThan(500);
  });

  it("formats meters and miles", () => {
    expect(formatDistance(24.4)).toBe("24 m");
    expect(formatDistance(1_609.344)).toBe("1.00 mi");
  });

  it("reports a missing player and allows open land globally", () => {
    expect(getBuildableStatus(null, []).reason).toBe("no player position");
    expect(getBuildableStatus(playerAt(35.68, 139.69), []).guidance).toBe(
      "Open land: ready to build"
    );
    expect(getBuildableStatus(playerAt(-33.87, 151.21), []).guidance).toBe(
      "Open land: ready to build"
    );
  });
});

function playerAt(lat: number, lon: number): PlayerSnapshot {
  return {
    playerId: "player-1",
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "NM",
    zoneId: "world:NM",
    lat,
    lon,
    anchorLat: lat,
    anchorLon: lon,
    moveLeashRadiusM: 700,
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-07-08T09:00:00.000Z"
  };
}

function flagAt(
  lat: number,
  lon: number,
  claimRadiusM: number,
  options: {
    id?: string;
    ownerId: string;
    ownerUsername?: string;
    ownerColor?: string;
    controlType?: FlagSnapshot["controlType"];
    kingdomName?: string;
  }
): FlagSnapshot {
  const flag: FlagSnapshot = {
    id: options.id ?? `${lat}-${lon}`,
    controlType: options.controlType ?? "personal",
    ownerId: options.ownerId,
    name: "Flag",
    lat,
    lon,
    packageId: null,
    elevationM: null,
    terrainClass: null,
    biome: null,
    ecoregion: null,
    claimRadiusM,
    cityId: null,
    createdAt: "2026-07-08T09:00:00.000Z"
  };
  if (options.ownerUsername) {
    flag.ownerUsername = options.ownerUsername;
  }
  if (options.ownerColor) {
    flag.ownerColor = options.ownerColor;
  }
  if (options.kingdomName) {
    flag.kingdomName = options.kingdomName;
    flag.kingdomId = "kingdom-1";
    flag.kingdomColor = "#7c3aed";
  }
  return flag;
}
