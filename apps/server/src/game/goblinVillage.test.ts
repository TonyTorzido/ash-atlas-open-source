import { describe, expect, it, vi } from "vitest";
import { distanceMeters } from "@ash-atlas/shared";

import { CityService } from "./cities.js";
import {
  GoblinVillageService,
  goblinMarketPlacement,
  goblinVillageHexPositions
} from "./goblinVillage.js";

describe("Goblin Village authored footprint", () => {
  it("creates the connected center + 6 + 12 tower hex topology", () => {
    const center = { lat: 35.0844, lon: -106.6504 };
    const spacingM = 101;
    const positions = goblinVillageHexPositions(center, spacingM);

    expect(positions).toHaveLength(19);
    expect(positions[0]).toEqual(center);
    expect(new Set(positions.map((position) =>
      `${position.lat.toFixed(7)}:${position.lon.toFixed(7)}`
    )).size).toBe(19);
    for (const position of positions.slice(1, 7)) {
      expect(distanceMeters(center, position)).toBeCloseTo(spacingM * Math.sqrt(3), 0);
    }
    for (const position of positions.slice(7)) {
      expect(distanceMeters(center, position)).toBeGreaterThan(spacingM * 2.9);
      expect(distanceMeters(center, position)).toBeLessThan(spacingM * 3.6);
    }
  });

  it("rejects crafted NPC city joins without changing retained player-city behavior", async () => {
    const service = {
      getCity: async (cityId: string) => ({
        id: cityId,
        controllerKind: cityId === "npc-city" ? "npc" : "player"
      })
    } as unknown as CityService;
    const join = CityService.prototype.joinCity.bind(service);
    await expect(join("player", { requestId: "npc-join", cityId: "npc-city" }))
      .rejects.toMatchObject({ code: "CITY_PERMISSION_DENIED" });
    await expect(join("player", { requestId: "player-join", cityId: "player-city" }))
      .rejects.toMatchObject({ code: "CITY_HOUSE_REQUIRED" });
  });

  it("derives a stable market position within the authored 300-450m band", () => {
    const center = { lat: 35.0844, lon: -106.6504 };
    const first = goblinMarketPlacement(center, "player:request");
    const replay = goblinMarketPlacement(center, "player:request");
    expect(replay).toEqual(first);
    expect(first.distanceM).toBeGreaterThanOrEqual(300);
    expect(first.distanceM).toBeLessThanOrEqual(450);
    expect(distanceMeters(center, first.position)).toBeCloseTo(first.distanceM, 2);
  });

  it("replays before proximity checks and conflicts on changed-coordinate reuse", async () => {
    const center = { lat: 35.0844, lon: -106.6504 };
    const cityId = "00000000-0000-4000-8000-000000000001";
    const market = {
      structureId: "00000000-0000-4000-8000-000000000002",
      cityId,
      type: "market"
    };
    const flagIds = Array.from({ length: 19 }, (_, index) =>
      `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`
    );
    const pool = {
      query: vi.fn(async (sql: string) => sql.includes("goblin_village_spawns")
        ? { rows: [{ city_id: cityId, center_lat: center.lat, center_lon: center.lon }], rowCount: 1 }
        : { rows: flagIds.map((id) => ({ id })), rowCount: flagIds.length })
    };
    const worldLookup = { lookupGameplayEnvironments: vi.fn() };
    const service = new GoblinVillageService(
      pool as never,
      { FLAG_CLAIM_RADIUS_M: 100, FLAG_RESOURCE_VISION_RADIUS_M: 100, WORLD_ID: "main" } as never,
      worldLookup as never,
      {
        getCity: vi.fn(async () => ({ id: cityId, name: "Goblin Village" })),
        structures: { listForCity: vi.fn(async () => [market]) }
      } as never,
      { getMapFlag: vi.fn(async (id: string) => ({ id })) } as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      { notifyZoneReady: vi.fn() } as never
    );
    const movedPlayer = { playerId: "player", position: { lat: 40, lon: -110 } } as never;

    await expect(service.spawn(movedPlayer, "stable-request", center))
      .resolves.toMatchObject({ replayed: true, city: { id: cityId } });
    expect(worldLookup.lookupGameplayEnvironments).not.toHaveBeenCalled();
    await expect(service.spawn(movedPlayer, "stable-request", { ...center, lat: center.lat + 0.001 }))
      .rejects.toMatchObject({ code: "GOBLIN_VILLAGE_REQUEST_CONFLICT" });
  });
});
