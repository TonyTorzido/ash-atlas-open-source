import { describe, expect, it, vi } from "vitest";

import {
  createSettlementHandler,
  type SettlementHandlerContext
} from "./settlementHandler.js";
import { CityGoldError } from "../../game/cityGold.js";
import { CityWarehouseError } from "../../game/cityWarehouse.js";
import { PlayerAuthorityFence } from "../../game/playerAuthorityFence.js";

describe("Oil Well harvest realtime authority", () => {
  it("reads the final authoritative position after preceding player authority completes", async () => {
    const playerAuthorityFence = new PlayerAuthorityFence();
    let releasePrecedingOperation!: () => void;
    let markPrecedingOperationStarted!: () => void;
    const precedingOperationStarted = new Promise<void>((resolve) => {
      markPrecedingOperationStarted = resolve;
    });
    const precedingOperation = playerAuthorityFence.run(
      "player-1",
      async () => {
        markPrecedingOperationStarted();
        await new Promise<void>((resolve) => {
          releasePrecedingOperation = resolve;
        });
      }
    );
    await precedingOperationStarted;
    const initialPosition = { lat: 35, lon: -106 };
    const finalPosition = { lat: 35.01, lon: -105.99 };
    const player = { position: initialPosition };
    const inventory = { playerId: "player-1", items: [], totals: {} };
    const well = { serverTime: 123 };
    const harvestOilWell = vi.fn().mockResolvedValue({
      well,
      inventory,
      replayed: false
    });
    const safeSendServerMessage = vi.fn();
    const registry = { broadcast: vi.fn(), send: vi.fn() };
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry,
      gameState: { getPlayer: () => player },
      flagService: {},
      cities: { structures: { harvestOilWell } },
      playerAuthorityFence,
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage
    } as unknown as SettlementHandlerContext);

    const handling = handler({
      type: "HARVEST_OIL_WELL",
      requestId: "harvest-oil-1",
      structureId: "well-1"
    });
    player.position = finalPosition;
    expect(harvestOilWell).not.toHaveBeenCalled();

    releasePrecedingOperation();
    await precedingOperation;
    await handling;

    expect(harvestOilWell).toHaveBeenCalledWith(
      "player-1",
      "well-1",
      finalPosition,
      "harvest-oil-1",
      false
    );
    expect(safeSendServerMessage).toHaveBeenCalledWith({}, {
      type: "OIL_WELL_HARVESTED",
      requestId: "harvest-oil-1",
      well,
      inventory,
      replayed: false
    });
    expect(registry.send).toHaveBeenCalledWith("player-1", {
      type: "PLAYER_RESOURCES_UPDATED",
      playerId: "player-1",
      inventory,
      serverTime: 123
    });
  });
});

describe("City construction realtime authority", () => {
  it("returns the stage resources and refreshes visible city snapshots", async () => {
    const city = {
      id: "00000000-0000-4000-8000-0000000000c1",
      constructionPhase: "foundation",
      jumpable: false
    };
    const inventory = { playerId: "player-1", items: [], totals: {} };
    const advanceConstruction = vi.fn().mockResolvedValue({
      action: "build_foundation",
      city,
      replayed: false,
      inventory
    });
    const nearby = [{ ...city }];
    const safeSendServerMessage = vi.fn();
    const sendToConnection = vi.fn();
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry: {
        records: () => [{ playerId: "viewer", connectionId: "connection-1" }],
        sendToConnection,
        send: vi.fn(),
        broadcast: vi.fn()
      },
      gameState: {
        getPlayer: () => ({ anchor: { lat: 35, lon: -106 } })
      },
      flagService: {},
      cities: {
        advanceConstruction,
        listCitiesNear: vi.fn().mockResolvedValue(nearby)
      },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage
    } as unknown as SettlementHandlerContext);

    await handler({
      type: "ADVANCE_CITY_CONSTRUCTION",
      requestId: "foundation-1",
      cityId: city.id,
      action: "build_foundation"
    });

    expect(advanceConstruction).toHaveBeenCalledWith("player-1", {
      requestId: "foundation-1",
      cityId: city.id,
      action: "build_foundation"
    });
    expect(safeSendServerMessage).toHaveBeenCalledWith({}, {
      type: "CITY_CONSTRUCTION_ADVANCED",
      requestId: "foundation-1",
      action: "build_foundation",
      city,
      replayed: false,
      inventory
    });
    expect(sendToConnection).toHaveBeenCalledWith("connection-1", {
      type: "CITIES_SNAPSHOT",
      cities: nearby
    });
  });
});

describe("Siege volley realtime reconciliation", () => {
  it("broadcasts every authoritative area-damaged Flag snapshot", async () => {
    const snapshot = { groups: [], units: [] };
    const flags = [
      { id: "flag-a", health: 190, maximumHealth: 200 },
      { id: "flag-b", health: 190, maximumHealth: 200 }
    ];
    const getMapFlag = vi.fn(async (flagId: string) => flags.find((flag) => flag.id === flagId) ?? null);
    const fireBallistaVolley = vi.fn().mockResolvedValue({
      snapshot,
      damage: 10,
      affectedFlagIds: ["flag-a", "flag-b"],
      siegeVolleys: [{ groupId: "group-1", occurredAt: 1_767_225_600_000 }],
      replayed: false
    });
    const safeSendServerMessage = vi.fn();
    const registry = { broadcast: vi.fn(), send: vi.fn() };
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry,
      gameState: {
        getPlayer: () => ({ position: { lat: 35, lon: -106 } })
      },
      flagService: { getMapFlag },
      cities: { militaryIndustry: { fireBallistaVolley } },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage
    } as unknown as SettlementHandlerContext);

    await handler({
      type: "FIRE_BALLISTA_VOLLEY",
      requestId: "siege-area-1",
      groupId: "group-1",
      targetFlagId: "flag-a"
    });

    expect(safeSendServerMessage).toHaveBeenCalledWith({}, {
      type: "MILITARY_INDUSTRY_CHANGED",
      requestId: "siege-area-1",
      snapshot,
      damage: 10,
      siegeVolleys: [{ groupId: "group-1", occurredAt: 1_767_225_600_000 }],
      replayed: false
    });
    expect(getMapFlag).toHaveBeenCalledWith("flag-a");
    expect(getMapFlag).toHaveBeenCalledWith("flag-b");
    expect(registry.broadcast).toHaveBeenCalledTimes(2);
    expect(registry.broadcast).toHaveBeenCalledWith({ type: "FLAG_UPDATED", flag: flags[0] });
    expect(registry.broadcast).toHaveBeenCalledWith({ type: "FLAG_UPDATED", flag: flags[1] });
  });

  it("broadcasts an authoritative damaged Flag after Bomber demolition", async () => {
    const snapshot = { groups: [], units: [] };
    const flag = { id: "flag-bomber", health: 1_350, maximumHealth: 2_700 };
    const getMapFlag = vi.fn(async (flagId: string) => flagId === flag.id ? flag : null);
    const demolishFlag = vi.fn().mockResolvedValue({
      snapshot,
      damage: 1_000,
      affectedFlagIds: [flag.id],
      replayed: false
    });
    const safeSendServerMessage = vi.fn();
    const registry = { broadcast: vi.fn(), send: vi.fn() };
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry,
      gameState: {
        getPlayer: () => ({ position: { lat: 35, lon: -106 } })
      },
      flagService: { getMapFlag },
      cities: { militaryIndustry: { demolishFlag } },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage
    } as unknown as SettlementHandlerContext);

    await handler({
      type: "DEMOLISH_FLAG",
      requestId: "bomber-1",
      groupId: "group-1",
      targetFlagId: flag.id
    });

    expect(getMapFlag).toHaveBeenCalledWith(flag.id);
    expect(registry.broadcast).toHaveBeenCalledWith({ type: "FLAG_UPDATED", flag });
  });

  it("publishes removal when a lethal military mutation has no remaining Flag snapshot", async () => {
    const snapshot = { groups: [], units: [] };
    const flagId = "flag-lethal";
    const getMapFlag = vi.fn().mockResolvedValue(null);
    const fireBallistaVolley = vi.fn().mockResolvedValue({
      snapshot,
      damage: 6,
      affectedFlagIds: [flagId],
      replayed: false
    });
    const safeSendServerMessage = vi.fn();
    const registry = { broadcast: vi.fn(), send: vi.fn() };
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry,
      gameState: {
        getPlayer: () => ({ position: { lat: 35, lon: -106 } })
      },
      flagService: { getMapFlag },
      cities: { militaryIndustry: { fireBallistaVolley } },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage
    } as unknown as SettlementHandlerContext);

    await handler({
      type: "FIRE_BALLISTA_VOLLEY",
      requestId: "siege-lethal-1",
      groupId: "group-1",
      targetFlagId: flagId
    });

    expect(registry.broadcast).toHaveBeenCalledWith({
      type: "FLAG_DELETED",
      flagId,
      reason: "destroyed"
    });
  });
});

describe("World Map destination visibility realtime authority", () => {
  it("returns the refreshed authorized snapshot for the exact request", async () => {
    const snapshot = { destinations: [], serverTime: 123 };
    const setDestinationVisibility = vi.fn().mockResolvedValue(snapshot);
    const registry = { broadcast: vi.fn(), send: vi.fn() };
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry,
      gameState: {},
      flagService: {},
      worldMap: { setDestinationVisibility },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage: vi.fn()
    } as unknown as SettlementHandlerContext);

    await handler({
      type: "SET_WORLD_MAP_DESTINATION_VISIBILITY",
      requestId: "visibility-1",
      destinationKind: "city",
      destinationId: "00000000-0000-4000-8000-000000900013",
      visible: false
    });

    expect(setDestinationVisibility).toHaveBeenCalledWith("player-1", {
      kind: "city",
      id: "00000000-0000-4000-8000-000000900013"
    }, false);
    expect(registry.send).toHaveBeenCalledWith("player-1", {
      type: "WORLD_MAP_DESTINATIONS",
      requestId: "visibility-1",
      snapshot
    });
  });
});

describe("City House realtime authority", () => {
  it("uses the player's final authoritative position without a client city or coordinates", async () => {
    const positionAtMenuOpen = { lat: 35, lon: -106 };
    const finalPosition = { lat: 35.0015, lon: -105.9985 };
    const player = { position: positionAtMenuOpen };
    const setMovementBlocked = vi.fn();
    const buildHouse = vi.fn().mockResolvedValue({
      structure: {
        structureId: "structure-1",
        cityId: "city-a",
        type: "city_house",
        ownerPlayerId: "player-1",
        state: "constructing"
      },
      membership: { cityId: "city-a", cityName: "Alpha" },
      replayed: false
    });
    const registry = {
      broadcast: vi.fn(),
      send: vi.fn()
    };
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry,
      gameState: {
        getPlayer: () => player,
        isWorldPresent: () => true,
        setMovementBlocked
      },
      flagService: {},
      cities: {
        structures: { buildHouse },
        getMembership: vi.fn().mockResolvedValue({
          cityId: "city-a",
          cityName: "Alpha"
        })
      },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage: vi.fn()
    } as unknown as SettlementHandlerContext);

    player.position = finalPosition;
    await handler({ type: "BUILD_CITY_HOUSE", requestId: "house-request" });

    expect(buildHouse).toHaveBeenCalledWith(
      "player-1",
      finalPosition,
      "house-request"
    );
    expect(registry.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "CITY_HOUSE_CHANGED",
      requestId: "house-request"
    }));
    expect(setMovementBlocked).toHaveBeenCalledWith(
      "player-1",
      true,
      "city-construction"
    );
  });

  it("rejects construction while the authoritative player is moving", async () => {
    const buildHouse = vi.fn();
    const safeSendServerMessage = vi.fn();
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry: { broadcast: vi.fn(), send: vi.fn() },
      gameState: {
        isWorldPresent: () => true,
        getPlayer: () => ({
          position: { lat: 35, lon: -106 },
          target: { lat: 35.01, lon: -106 }
        })
      },
      flagService: {},
      cities: { structures: { buildHouse } },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage
    } as unknown as SettlementHandlerContext);

    await handler({ type: "BUILD_CITY_HOUSE", requestId: "moving-house" });

    expect(buildHouse).not.toHaveBeenCalled();
    expect(safeSendServerMessage).toHaveBeenCalledWith({}, {
      type: "ERROR",
      requestId: "moving-house",
      code: "CITY_CONSTRUCTION_STATIONARY_REQUIRED",
      message: "Stop moving before beginning city construction."
    });
  });

  it("claims vacant mayor control without requiring a City Hall position", async () => {
    const claimMayor = vi.fn().mockResolvedValue({
      city: {
        id: "city-a",
        mayorPlayerId: "player-1"
      },
      structure: null,
      membership: null,
      replayed: false
    });
    const registry = {
      broadcast: vi.fn(),
      send: vi.fn()
    };
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry,
      gameState: { getPlayer: vi.fn(() => undefined) },
      flagService: {},
      cities: {
        claimMayor,
        getMembership: vi.fn().mockResolvedValue({
          cityId: "city-a",
          cityName: "Alpha",
          role: "mayor"
        })
      },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage: vi.fn()
    } as unknown as SettlementHandlerContext);

    await handler({
      type: "CLAIM_CITY_MAYOR",
      requestId: "claim-request",
      cityId: "city-a"
    });

    expect(claimMayor).toHaveBeenCalledWith("player-1", {
      requestId: "claim-request",
      cityId: "city-a"
    });
    expect(registry.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "CITY_MAYOR_UPDATED",
      action: "claimed"
    }));
  });
});

describe("City Warehouse realtime authority", () => {
  it("returns both authoritative snapshots for the exact donation request", async () => {
    const inventory = { playerId: "player-1", items: [], totals: {} };
    const warehouse = {
      cityId: "city-a",
      structureId: "warehouse-1",
      cityName: "Alpha",
      stacks: []
    };
    const donate = vi.fn().mockResolvedValue({
      warehouse,
      inventory,
      replayed: false,
      donatedQuantity: 12
    });
    const safeSendServerMessage = vi.fn();
    const registry = { broadcast: vi.fn(), send: vi.fn() };
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry,
      gameState: {
        getPlayer: () => ({ position: { lat: 35, lon: -106 } })
      },
      flagService: {},
      cities: { structures: { warehouse: { donate } } },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage
    } as unknown as SettlementHandlerContext);

    await handler({
      type: "DONATE_CITY_WAREHOUSE",
      requestId: "donate-1",
      structureId: "warehouse-1",
      stackId: "stack-1",
      quantity: 12
    });

    expect(donate).toHaveBeenCalledWith(
      "player-1",
      "warehouse-1",
      { lat: 35, lon: -106 },
      "donate-1",
      "stack-1",
      12
    );
    expect(safeSendServerMessage).toHaveBeenCalledWith({}, {
      type: "CITY_WAREHOUSE_UPDATED",
      requestId: "donate-1",
      warehouse,
      inventory,
      replayed: false,
      donatedQuantity: 12
    });
    expect(registry.send).toHaveBeenCalledWith("player-1", expect.objectContaining({
      type: "PLAYER_RESOURCES_UPDATED",
      inventory
    }));
  });

  it("preserves the typed Warehouse error code", async () => {
    const safeSendServerMessage = vi.fn();
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry: { broadcast: vi.fn(), send: vi.fn() },
      gameState: {
        getPlayer: () => ({ position: { lat: 35, lon: -106 } })
      },
      flagService: {},
      cities: {
        structures: {
          warehouse: {
            donate: vi.fn().mockRejectedValue(new CityWarehouseError(
              "CITY_WAREHOUSE_FULL",
              "The City Warehouse is full"
            ))
          }
        }
      },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage
    } as unknown as SettlementHandlerContext);

    await handler({
      type: "DONATE_CITY_WAREHOUSE",
      requestId: "donate-full",
      structureId: "warehouse-1",
      stackId: "stack-1",
      quantity: 1
    });

    expect(safeSendServerMessage).toHaveBeenCalledWith({}, {
      type: "ERROR",
      requestId: "donate-full",
      code: "CITY_WAREHOUSE_FULL",
      message: "The City Warehouse is full"
    });
  });
});

describe("City construction realtime errors", () => {
  it("preserves the authoritative City Gold rejection code", async () => {
    const safeSendServerMessage = vi.fn();
    const buildMarket = vi.fn().mockRejectedValue(new CityGoldError(
      "CITY_GOLD_INSUFFICIENT",
      "The City Gold Reserve does not contain enough Gold"
    ));
    const handler = createSettlementHandler({
      state: { playerId: "player-1" },
      socket: {},
      registry: { broadcast: vi.fn(), send: vi.fn() },
      gameState: {
        getPlayer: () => ({
          position: { lat: 35, lon: -106 },
          target: null
        }),
        isWorldPresent: () => true
      },
      flagService: {},
      cities: { structures: { buildMarket } },
      refreshAuthoritativePlayerStats: vi.fn(),
      safeSendServerMessage
    } as unknown as SettlementHandlerContext);

    await handler({
      type: "BUILD_CITY_MARKET",
      requestId: "market-gold-1",
      cityId: "city-a",
      expectedCityRevision: "4"
    });

    expect(safeSendServerMessage).toHaveBeenCalledWith({}, {
      type: "ERROR",
      requestId: "market-gold-1",
      code: "CITY_GOLD_INSUFFICIENT",
      message: "The City Gold Reserve does not contain enough Gold"
    });
  });
});
