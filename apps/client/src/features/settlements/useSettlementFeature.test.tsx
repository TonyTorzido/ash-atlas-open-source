// @vitest-environment jsdom

import {
  emptyInventoryTotals,
  type CityAppSnapshot,
  type CitySnapshot,
  type CityStructureSnapshot,
  type CityWarehouseSnapshot,
  type FlagSnapshot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GameClient } from "../../gameClient.js";
import {
  CITY_CONSTRUCTION_RESULT_TIMEOUT_MS,
  useSettlementFeature
} from "./useSettlementFeature.js";

const cityId = "00000000-0000-4000-8000-000000000100";

afterEach(() => {
  vi.useRealTimers();
});

describe("city territory synchronization", () => {
  it("animates a confirmed observed Bomber completion once, including after the group disappears", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "player-1", getClient: () => null, showActionError: vi.fn(), showActionSuccess: vi.fn(),
      setFlags: vi.fn(), setSelectedFlagId: vi.fn(), setWarning: vi.fn()
    }));
    const channel = { requestId: "bomb-1", groupId: "bomber-1", targetFlagId: "flag-1",
      startedAt: new Date().toISOString(), completesAt: new Date(Date.now() + 5000).toISOString() };
    const cue = { requestId: channel.requestId, groupId: channel.groupId, occurredAt: Date.now(),
      position: { lat: 1, lon: 2 }, targetPosition: { lat: 1.001, lon: 2 } };
    const completed = { type: "MILITARY_INDUSTRY_STATE" as const, requestId: "tick", snapshot: {} as never,
      bomberDetonations: [cue] };
    act(() => {
      result.current.handleServerMessage({ type: "MILITARY_INDUSTRY_STATE", requestId: "plant",
        snapshot: { bomberChannel: channel } as never });
      result.current.handleServerMessage({ type: "MILITARY_INDUSTRY_STATE", requestId: "removed", snapshot: {} as never });
    });
    expect(result.current.view.militaryBomberDetonationCues).toEqual([]);
    act(() => { result.current.handleServerMessage(completed); result.current.handleServerMessage(completed); });
    expect(result.current.view.militaryBomberDetonationCues).toEqual([cue]);
    act(() => { vi.advanceTimersByTime(3000); result.current.handleServerMessage(completed); });
    expect(result.current.view.militaryBomberDetonationCues).toEqual([]);
  });

  it("does not infer Bomber completion from a deadline, cancellation, replay or reconnect baseline", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "player-1", getClient: () => null, showActionError: vi.fn(), showActionSuccess: vi.fn(),
      setFlags: vi.fn(), setSelectedFlagId: vi.fn(), setWarning: vi.fn()
    }));
    const channel = { requestId: "bomb-1", groupId: "bomber-1", targetFlagId: "flag-1",
      startedAt: new Date().toISOString(), completesAt: new Date(Date.now() + 5000).toISOString() };
    act(() => {
      result.current.handleServerMessage({ type: "MILITARY_INDUSTRY_STATE", requestId: "plant",
        snapshot: { bomberChannel: channel } as never });
      vi.advanceTimersByTime(6000);
      result.current.handleServerMessage({ type: "MILITARY_INDUSTRY_STATE", requestId: "cancel", snapshot: {} as never });
    });
    expect(result.current.view.militaryBomberDetonationCues).toEqual([]);
    const cue = { requestId: channel.requestId, groupId: channel.groupId, occurredAt: Date.now(),
      position: { lat: 1, lon: 2 }, targetPosition: { lat: 1.001, lon: 2 } };
    act(() => {
      result.current.handleServerMessage({ type: "MILITARY_INDUSTRY_CHANGED", requestId: "replay", replayed: true,
        snapshot: {} as never, bomberDetonations: [cue] });
    });
    expect(result.current.view.militaryBomberDetonationCues).toEqual([]);
    act(() => {
      result.current.resetKingdomState(); // The existing WELCOME connection reset.
      result.current.handleServerMessage({ type: "MILITARY_INDUSTRY_STATE", requestId: "reconnect",
        snapshot: {} as never, bomberDetonations: [cue] });
    });
    expect(result.current.view.militaryBomberDetonationCues).toEqual([]);
  });

  it("projects authoritative Siege volley cues briefly and clears the presentation state", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "player-1",
      getClient: () => null,
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));

    act(() => {
      result.current.handleServerMessage({
        type: "MILITARY_INDUSTRY_CHANGED",
        requestId: "volley-1",
        snapshot: {} as never,
        replayed: false,
        siegeVolleys: [{ groupId: "siege-1", occurredAt: 1_000 }]
      });
    });

    expect(result.current.view.militarySiegeVolleyCues).toEqual([
      { groupId: "siege-1", occurredAt: 1_000 }
    ]);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.view.militarySiegeVolleyCues).toEqual([]);
  });

  it("removes every stale Goblin city surface after a domain removal frame", () => {
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => null,
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));
    const city = citySnapshot("complete");
    const structure = pendingHouse();
    act(() => {
      result.current.actions.setCities([city]);
      result.current.actions.setSelectedCityId(cityId);
      result.current.actions.setCityInfo({ city } as never);
      result.current.actions.setCityApp({ city, structures: [structure] } as never);
      result.current.actions.setCityStructures([structure]);
      result.current.actions.setGoblinMarket({ cityId } as never);
      result.current.handleServerMessage({
        type: "GOBLIN_VILLAGE_REMOVED",
        cityId,
        structureIds: [structure.structureId]
      });
    });

    expect(result.current.view.cities).toEqual([]);
    expect(result.current.view.selectedCityId).toBeNull();
    expect(result.current.view.cityInfo).toBeNull();
    expect(result.current.view.cityApp).toBeNull();
    expect(result.current.view.cityStructures).toEqual([]);
    expect(result.current.view.goblinMarket).toBeNull();
  });

  it("keeps nearby world structures when the City App loads a remote membership city", () => {
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => null as GameClient | null,
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));
    const nearbyStructure = pendingHouse();
    const managementStructure: CityStructureSnapshot = {
      ...pendingHouse(),
      structureId: "00000000-0000-4000-8000-000000000333",
      cityId: "00000000-0000-4000-8000-000000000999",
      lat: 40,
      lon: -74
    };
    const cityAppSnapshot = {
      structures: [managementStructure],
      activeConstruction: null
    } as unknown as CityAppSnapshot;

    act(() => {
      result.current.handleServerMessage({
        type: "CITY_STRUCTURES_SNAPSHOT",
        structures: [nearbyStructure]
      });
      result.current.handleServerMessage({
        type: "CITY_APP",
        requestId: "city-app-1",
        snapshot: cityAppSnapshot
      });
    });

    expect(result.current.view.cityApp?.structures).toEqual([managementStructure]);
    expect(result.current.view.cityStructures).toEqual([nearbyStructure]);
  });

  it("replaces annexed personal visuals with every authoritative city circle atomically", () => {
    const setFlags = vi.fn();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => null as GameClient | null,
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags,
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));
    const territoryFlags = Array.from({ length: 7 }, (_, index) =>
      flag(index, index === 0 ? "city_seat" : "city")
    );
    const initial = [
      flag(0, "personal", null),
      flag(1, "personal", null)
    ];

    act(() => {
      result.current.handleServerMessage({
        type: "CITY_TERRITORY_SYNC",
        cityId,
        flags: territoryFlags
      });
    });

    expect(setFlags).toHaveBeenCalledTimes(1);
    const apply = setFlags.mock.calls[0]![0] as (flags: FlagSnapshot[]) => FlagSnapshot[];
    const synchronized = apply(initial);
    expect(synchronized).toHaveLength(territoryFlags.length);
    expect(new Set(synchronized.map(({ id }) => id))).toEqual(
      new Set(territoryFlags.map(({ id }) => id))
    );
    expect(synchronized.every(({ cityId: ownerCityId }) => ownerCityId === cityId)).toBe(true);
    expect(synchronized.filter(({ controlType }) => controlType === "city_seat")).toHaveLength(1);
    expect(synchronized.filter(({ controlType }) => controlType === "city"))
      .toHaveLength(territoryFlags.length - 1);
  });

  it("installs a completed house immediately and names the resolved city", () => {
    const requestCityApp = vi.fn();
    const showActionSuccess = vi.fn();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => ({ requestCityApp } as unknown as GameClient),
      showActionError: vi.fn(),
      showActionSuccess,
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));

    act(() => {
      result.current.handleServerMessage({
        type: "CITY_HOUSE_CHANGED",
        requestId: "house-1",
        replayed: false,
        structure: {
          structureId: "00000000-0000-4000-8000-000000000200",
          cityId,
          type: "mayor_house",
          tier: 1,
          districtType: null,
          ownerPlayerId: "founder",
          worldId: "main",
          regionCode: "US-NM",
          lat: 35,
          lon: -106,
          footprintRadiusM: 10,
          placementRevision: "1",
          state: "active",
          constructionStartedAt: "2026-07-26T00:00:00.000Z",
          constructionCompletesAt: "2026-07-26T00:00:00.000Z",
          builtAt: "2026-07-26T00:00:00.000Z",
          upgradedAt: null,
          destroyedAt: null
        },
        membership: {
          cityId,
          cityName: "Alpha",
          role: "mayor",
          joinedAt: "2026-07-26T00:00:00.000Z",
          houseStructureId: "00000000-0000-4000-8000-000000000200",
          expansionFlagCount: 0,
          expansionFlagLimit: 6
        }
      });
    });

    expect(result.current.view.cityMembership?.cityName).toBe("Alpha");
    expect(result.current.view.cityStructures).toHaveLength(1);
    expect(requestCityApp).toHaveBeenCalledOnce();
    expect(showActionSuccess).toHaveBeenCalledWith(
      "Claimed Mayor of Alpha."
    );
  });
});

describe("authoritative city construction snapshots", () => {
  it("starts only from the matching accepted frame and deduplicates replayed structures", () => {
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => ({ requestCityApp: vi.fn() } as unknown as GameClient),
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));
    const structure = pendingHouse();

    act(() => {
      expect(result.current.trackCityConstructionRequest(
        "house-pending",
        "build_house"
      )).toBe(true);
    });
    expect(result.current.view.activeCityConstruction).toBeNull();

    const accepted = {
      type: "CITY_HOUSE_CHANGED" as const,
      requestId: "house-pending",
      replayed: false,
      structure,
      membership: null
    };
    act(() => result.current.handleServerMessage(accepted));
    act(() => result.current.handleServerMessage({
      ...accepted,
      replayed: true
    }));

    expect(result.current.view.activeCityConstruction).toMatchObject({
      requestId: "house-pending",
      action: "build_house",
      structureId: structure.structureId,
      constructionStartedAt: structure.constructionStartedAt,
      constructionCompletesAt: structure.constructionCompletesAt
    });
    expect(result.current.view.cityStructures).toEqual([structure]);
    expect(result.current.view.cityMembership).toBeNull();
  });

  it("clears physical construction busy state on a matching success and disarms its watchdog", () => {
    vi.useFakeTimers();
    const showActionError = vi.fn();
    const requestCityApp = vi.fn();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => ({ requestCityApp } as unknown as GameClient),
      showActionError,
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));

    act(() => {
      expect(result.current.trackCityConstructionRequest(
        "facility-success",
        "build_facility"
      )).toBe(true);
      result.current.handleServerMessage({
        type: "CITY_FACILITY_CHANGED",
        requestId: "facility-success",
        structure: {
          ...pendingHouse(),
          type: "warehouse"
        }
      });
      vi.advanceTimersByTime(CITY_CONSTRUCTION_RESULT_TIMEOUT_MS);
    });

    expect(result.current.view.cityActionBusy).toBe(false);
    expect(showActionError).not.toHaveBeenCalled();
    expect(requestCityApp).toHaveBeenCalledOnce();
  });

  it("lets a City App snapshot settle the matching physical request", () => {
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => ({ requestCityApp: vi.fn() } as unknown as GameClient),
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));
    const activeConstruction = {
      operationKey: "accepted:facility-app",
      requestId: "facility-app",
      action: "build_facility" as const,
      structureId: pendingHouse().structureId,
      anchor: { lat: 35, lon: -106 },
      constructionStartedAt: "2026-07-30T12:00:00.000Z",
      constructionCompletesAt: "2026-07-30T12:00:30.000Z"
    };

    act(() => {
      expect(result.current.trackCityConstructionRequest(
        "facility-app",
        "build_facility"
      )).toBe(true);
      result.current.handleServerMessage({
        type: "CITY_APP",
        requestId: "city-app-1",
        snapshot: { activeConstruction } as unknown as CityAppSnapshot
      });
    });

    expect(result.current.view.cityActionBusy).toBe(false);
    expect(result.current.view.activeCityConstruction).toEqual(activeConstruction);
  });

  it("does not let a late physical frame clear a newer request", () => {
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => ({ requestCityApp: vi.fn() } as unknown as GameClient),
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));

    act(() => {
      expect(result.current.trackCityConstructionRequest(
        "facility-old",
        "build_facility"
      )).toBe(true);
      expect(result.current.trackCityConstructionRequest(
        "facility-new",
        "upgrade_facility"
      )).toBe(true);
      result.current.handleServerMessage({
        type: "CITY_FACILITY_CHANGED",
        requestId: "facility-old",
        structure: {
          ...pendingHouse(),
          type: "warehouse"
        }
      });
    });

    expect(result.current.view.cityActionBusy).toBe(true);

    act(() => {
      result.current.handleCityConstructionError({
        requestId: "facility-new",
        message: "The City Warehouse needs 250 Wood."
      });
    });
    expect(result.current.view.cityActionBusy).toBe(false);
  });

  it("reports an owner Oil Well cancellation caused by movement", () => {
    const showActionSuccess = vi.fn();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => ({ requestCityApp: vi.fn() } as unknown as GameClient),
      showActionError: vi.fn(),
      showActionSuccess,
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));
    const structure: CityStructureSnapshot = {
      ...pendingHouse(),
      type: "oil_well",
      ownerPlayerId: "founder",
      state: "destroyed",
      destroyedAt: "2026-07-31T00:00:01.000Z"
    };

    act(() => result.current.handleServerMessage({
      type: "CITY_FACILITY_CHANGED",
      requestId: `city-build-cancel:${structure.structureId}`,
      structure
    }));

    expect(showActionSuccess).toHaveBeenCalledWith(
      "Oil Well construction canceled because you moved."
    );
  });
});

describe("City Warehouse sessions", () => {
  it("keeps stable identity and updates both authoritative panes on the matching request", () => {
    const openCityWarehouse = vi.fn(() => "open-1");
    const donateCityWarehouse = vi.fn(() => "donate-1");
    const requestCityApp = vi.fn();
    const receiveInventorySnapshot = vi.fn();
    const showActionSuccess = vi.fn();
    const warehouse = warehouseSnapshot(1);
    const client = {
      openCityWarehouse,
      donateCityWarehouse,
      requestCityApp
    } as unknown as GameClient;
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "player-1",
      getClient: () => client,
      receiveInventorySnapshot,
      showActionError: vi.fn(),
      showActionSuccess,
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));

    act(() => {
      expect(result.current.openCityWarehouse(warehouse.structureId)).toBe(true);
    });
    expect(result.current.view.activeWarehouseStructureId).toBe(warehouse.structureId);
    expect(result.current.view.cityWarehousePending?.requestId).toBe("open-1");

    act(() => {
      result.current.handleServerMessage({
        type: "CITY_WAREHOUSE_OPENED",
        requestId: "open-1",
        warehouse
      });
    });
    act(() => {
      expect(result.current.donateCityWarehouse({
        warehouseStructureId: warehouse.structureId,
        stackId: "00000000-0000-4000-8000-000000000901",
        itemId: "wood",
        displayName: "Wood",
        variant: null,
        quantity: 7
      })).toBe(true);
    });
    expect(donateCityWarehouse).toHaveBeenCalledWith(
      warehouse.structureId,
      "00000000-0000-4000-8000-000000000901",
      7
    );

    const inventory = inventorySnapshot(23);
    const updated = {
      ...warehouse,
      usedSlots: 1,
      stacks: [{
        stackId: "00000000-0000-4000-8000-000000000902",
        slotIndex: 0,
        itemId: "wood" as const,
        variant: null,
        quantity: 7,
        version: "1"
      }]
    };
    act(() => {
      result.current.handleServerMessage({
        type: "CITY_WAREHOUSE_UPDATED",
        requestId: "donate-1",
        warehouse: updated,
        inventory,
        replayed: false,
        donatedQuantity: 7
      });
    });

    expect(result.current.view.cityWarehouse).toEqual(updated);
    expect(result.current.view.cityWarehousePending).toBeNull();
    expect(result.current.view.cityWarehouseFeedback).toBe(
      "Donated 7 Wood to the City Warehouse."
    );
    expect(receiveInventorySnapshot).toHaveBeenCalledWith(inventory);
    expect(requestCityApp).toHaveBeenCalledOnce();
  });

  it("ignores stale responses from a previously opened Warehouse", () => {
    const openCityWarehouse = vi.fn()
      .mockReturnValueOnce("open-1")
      .mockReturnValueOnce("open-2");
    const receiveInventorySnapshot = vi.fn();
    const client = { openCityWarehouse } as unknown as GameClient;
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "player-1",
      getClient: () => client,
      receiveInventorySnapshot,
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));
    const first = warehouseSnapshot(1);
    const second = warehouseSnapshot(2);

    act(() => {
      result.current.openCityWarehouse(first.structureId);
      result.current.openCityWarehouse(second.structureId);
      result.current.handleServerMessage({
        type: "CITY_WAREHOUSE_OPENED",
        requestId: "open-1",
        warehouse: first
      });
      result.current.handleServerMessage({
        type: "CITY_WAREHOUSE_UPDATED",
        requestId: "open-1",
        warehouse: first,
        inventory: inventorySnapshot(1),
        replayed: false,
        donatedQuantity: 1
      });
    });
    expect(result.current.view.cityWarehouse).toBeNull();
    expect(result.current.view.cityWarehousePending?.requestId).toBe("open-2");
    expect(receiveInventorySnapshot).not.toHaveBeenCalled();

    act(() => {
      result.current.handleServerMessage({
        type: "CITY_WAREHOUSE_OPENED",
        requestId: "open-2",
        warehouse: second
      });
    });
    expect(result.current.view.cityWarehouse?.structureId).toBe(second.structureId);
  });

  it("clears pending state on errors and clears the full session on close", () => {
    const showActionError = vi.fn();
    const client = {
      openCityWarehouse: vi.fn(() => "open-1")
    } as unknown as GameClient;
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "player-1",
      getClient: () => client,
      showActionError,
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));

    act(() => {
      result.current.openCityWarehouse(warehouseSnapshot(1).structureId);
      expect(result.current.handleCityWarehouseError({
        type: "ERROR",
        requestId: "open-1",
        code: "CITY_WAREHOUSE_ACCESS_DENIED",
        message: "Too far from the City Warehouse."
      })).toBe(true);
    });
    expect(result.current.view.cityWarehousePending).toBeNull();
    expect(result.current.view.activeWarehouseStructureId).toBeNull();
    expect(result.current.view.cityWarehouseError).toBe(
      "Too far from the City Warehouse."
    );
    expect(showActionError).toHaveBeenCalledWith("Too far from the City Warehouse.");

    act(() => {
      result.current.closeCityWarehouse();
    });
    expect(result.current.view).toMatchObject({
      activeWarehouseStructureId: null,
      cityWarehouse: null,
      cityWarehousePending: null,
      cityWarehouseFeedback: null,
      cityWarehouseError: null
    });
  });

  it("shows a visible stale-session error instead of silently returning", () => {
    const showActionError = vi.fn();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "player-1",
      getClient: () => null,
      showActionError,
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));

    act(() => {
      expect(result.current.donateAllCityWarehouse()).toBe(false);
    });
    expect(result.current.view.cityWarehouseError).toContain("session is stale");
    expect(showActionError).toHaveBeenCalledOnce();
  });
});

describe("city flag contribution lifecycle", () => {
  it("closes flag UI immediately after one successful send and rejects duplicate pending work", () => {
    const convertCityFlag = vi.fn(() => "request-1");
    const closeFlagInteraction = vi.fn();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => ({ convertCityFlag } as unknown as GameClient),
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      closeFlagInteraction,
      setWarning: vi.fn()
    }));

    act(() => {
      expect(result.current.convertCityFlag("flag-1")).toBe(true);
      expect(result.current.convertCityFlag("flag-1")).toBe(false);
    });

    expect(convertCityFlag).toHaveBeenCalledOnce();
    expect(closeFlagInteraction).toHaveBeenCalledOnce();
    expect(result.current.view.pendingCityFlagConversion).toEqual({
      requestId: "request-1",
      flagId: "flag-1"
    });
    expect(result.current.view.cityActionBusy).toBe(true);
  });

  it("keeps management open and clears busy state when the command cannot be sent", () => {
    const closeFlagInteraction = vi.fn();
    const showActionError = vi.fn();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => ({
        convertCityFlag: vi.fn(() => null)
      } as unknown as GameClient),
      showActionError,
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      closeFlagInteraction,
      setWarning: vi.fn()
    }));

    act(() => {
      expect(result.current.convertCityFlag("flag-1")).toBe(false);
    });

    expect(closeFlagInteraction).not.toHaveBeenCalled();
    expect(result.current.view.pendingCityFlagConversion).toBeNull();
    expect(result.current.view.cityActionBusy).toBe(false);
    expect(showActionError).toHaveBeenCalledWith(
      "Cannot contribute a flag while disconnected."
    );
  });

  it("uses authoritative countdown timestamps and clears the marker on completion or error", () => {
    const setFlags = vi.fn();
    const closeFlagInteraction = vi.fn();
    const showActionError = vi.fn();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "founder",
      getClient: () => ({
        convertCityFlag: vi.fn(() => "request-1")
      } as unknown as GameClient),
      showActionError,
      showActionSuccess: vi.fn(),
      setFlags,
      setSelectedFlagId: vi.fn(),
      closeFlagInteraction,
      setWarning: vi.fn()
    }));
    act(() => {
      result.current.convertCityFlag("flag-1");
      result.current.handleServerMessage({
        type: "CITY_FLAG_CONVERSION_STARTED",
        conversionId: "conversion-1",
        requestId: "request-1",
        flagId: "flag-1",
        flagName: "North Gate",
        cityId,
        cityName: "Albuquerque",
        position: { lat: 35.1, lon: -106.6 },
        startedAt: 1_000,
        completesAt: 11_000,
        durationMs: 10_000,
        serverTime: 3_000
      });
    });

    expect(result.current.view.activeCityFlagConversion).toMatchObject({
      conversionId: "conversion-1",
      flagName: "North Gate",
      cityName: "Albuquerque",
      position: { lat: 35.1, lon: -106.6 },
      countdown: { durationMs: 10_000 }
    });

    act(() => {
      result.current.handleServerMessage({
        type: "CITY_FLAG_CONVERTED",
        conversionId: "conversion-1",
        requestId: "request-1",
        flag: flag(20, "city"),
        expansionFlagCount: 6,
        expansionFlagLimit: 11,
        replayed: false
      });
    });
    expect(result.current.view.activeCityFlagConversion).toBeNull();
    expect(result.current.view.pendingCityFlagConversion).toBeNull();
    expect(result.current.view.cityActionBusy).toBe(false);
    expect(setFlags).toHaveBeenCalledOnce();

    act(() => {
      result.current.convertCityFlag("flag-2");
      expect(result.current.handleCityFlagConversionError({
        type: "ERROR",
        requestId: "request-1",
        code: "CITY_FLAG_LIFECYCLE_CHANGED",
        message: "Flag control changed during confirmation"
      })).toBe(true);
    });
    expect(result.current.view.activeCityFlagConversion).toBeNull();
    expect(result.current.view.pendingCityFlagConversion).toBeNull();
    expect(result.current.view.cityActionBusy).toBe(false);
    expect(showActionError).toHaveBeenCalledWith(
      "Flag control changed during confirmation"
    );
  });
});

describe("staged city construction", () => {
  it("keeps the city selected and applies the authoritative stage payload", () => {
    const client = {
      advanceCityConstruction: vi.fn().mockReturnValue("city-stage-1")
    } as unknown as GameClient;
    const receiveInventorySnapshot = vi.fn();
    const receiveWalletGold = vi.fn();
    const showActionSuccess = vi.fn();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "builder-2",
      getClient: () => client,
      receiveInventorySnapshot,
      receiveWalletGold,
      showActionError: vi.fn(),
      showActionSuccess,
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));
    const blueprint = citySnapshot("blueprint");
    const foundation = citySnapshot("foundation");
    const inventory = inventorySnapshot(0);

    act(() => {
      result.current.actions.setCities([blueprint]);
      result.current.actions.setSelectedCityId(cityId);
      result.current.advanceCityConstruction(cityId, "build_foundation");
    });
    expect(result.current.view.cityActionBusy).toBe(true);
    expect(result.current.view.cityConstructionBusy).toBe(true);

    act(() => result.current.handleServerMessage({
      type: "CITY_CONSTRUCTION_ADVANCED",
      requestId: "city-stage-1",
      action: "build_foundation",
      city: foundation,
      replayed: false,
      inventory,
      walletGold: "9000",
      walletVersion: "2"
    }));

    expect(result.current.view.selectedCityId).toBe(cityId);
    expect(result.current.view.cities).toEqual([foundation]);
    expect(result.current.view.cityActionBusy).toBe(false);
    expect(result.current.view.cityConstructionBusy).toBe(false);
    expect(receiveInventorySnapshot).toHaveBeenCalledWith(inventory);
    expect(receiveWalletGold).toHaveBeenCalledWith("9000", "2");
    expect(showActionSuccess).toHaveBeenCalledWith("Foundation built.");
  });

  it("clears busy and exposes a matching construction error once", () => {
    const client = {
      advanceCityConstruction: vi.fn().mockReturnValue("city-stage-2")
    } as unknown as GameClient;
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "builder-2",
      getClient: () => client,
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));

    act(() => { result.current.advanceCityConstruction(cityId, "build_frames"); });
    let handled = false;
    act(() => {
      handled = result.current.handleCityConstructionError({
        requestId: "city-stage-2",
        message: "A different player must complete this stage."
      });
    });

    expect(handled).toBe(true);
    expect(result.current.view.cityActionBusy).toBe(false);
    expect(result.current.view.cityConstructionBusy).toBe(false);
    expect(result.current.view.cityConstructionError)
      .toBe("A different player must complete this stage.");
    expect(result.current.handleCityConstructionError({
      requestId: "city-stage-2",
      message: "duplicate"
    })).toBe(false);
  });

  it("clears a matching physical construction rejection", () => {
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "builder-2",
      getClient: () => null,
      showActionError: vi.fn(),
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));

    act(() => {
      expect(result.current.trackCityConstructionRequest(
        "city-facility-1",
        "build_facility"
      )).toBe(true);
    });
    expect(result.current.view.cityActionBusy).toBe(true);

    let handled = false;
    act(() => {
      handled = result.current.handleCityConstructionError({
        requestId: "city-facility-1",
        message: "The City Warehouse needs 250 Wood."
      });
    });

    expect(handled).toBe(true);
    expect(result.current.view.cityActionBusy).toBe(false);
    expect(result.current.handleCityConstructionError({
      requestId: "city-facility-1",
      message: "duplicate"
    })).toBe(false);
  });

  it("clears and reports a pending physical request when disconnected", () => {
    const showActionError = vi.fn();
    const { result, rerender } = renderHook(
      ({ online }: { online: boolean }) => useSettlementFeature({
        ownPlayerId: "builder-2",
        getClient: () => null,
        online,
        showActionError,
        showActionSuccess: vi.fn(),
        setFlags: vi.fn(),
        setSelectedFlagId: vi.fn(),
        setWarning: vi.fn()
      }),
      { initialProps: { online: true } }
    );

    act(() => {
      expect(result.current.trackCityConstructionRequest(
        "city-facility-disconnect",
        "build_facility"
      )).toBe(true);
    });
    rerender({ online: false });

    expect(result.current.view.cityActionBusy).toBe(false);
    expect(showActionError).toHaveBeenCalledWith(
      "City construction was interrupted. Reconnect and try again."
    );
  });

  it("clears a timed-out physical request, refreshes City records, and exposes a retry error", () => {
    vi.useFakeTimers();
    const showActionError = vi.fn();
    const requestCityApp = vi.fn();
    const { result } = renderHook(() => useSettlementFeature({
      ownPlayerId: "builder-2",
      getClient: () => ({ requestCityApp } as unknown as GameClient),
      showActionError,
      showActionSuccess: vi.fn(),
      setFlags: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setWarning: vi.fn()
    }));

    act(() => {
      expect(result.current.trackCityConstructionRequest(
        "city-facility-timeout",
        "build_facility"
      )).toBe(true);
      vi.advanceTimersByTime(CITY_CONSTRUCTION_RESULT_TIMEOUT_MS);
    });

    expect(result.current.view.cityActionBusy).toBe(false);
    expect(requestCityApp).toHaveBeenCalledOnce();
    expect(showActionError).toHaveBeenCalledWith(
      "City construction result was not confirmed. Refresh City records and retry."
    );
  });
});

function citySnapshot(phase: CitySnapshot["constructionPhase"]): CitySnapshot {
  return {
    id: cityId,
    worldId: "main",
    worldSettlementId: "settlement-1",
    worldSettlementSource: "global-boundaries",
    worldSourceSettlementId: "source-1",
    settlementClass: "city",
    settlementReleaseId: "world-settlements-v1",
    settlementReleaseFingerprint: "f".repeat(64),
    name: "Albuquerque",
    countryCode: "US",
    regionCode: "US-NM",
    founderPlayerId: "founder",
    mayorPlayerId: null,
    mayorConfirmed: false,
    founderMayorClaimDeadline: null,
    seatFlagId: "00000000-0000-4000-8000-000000000001",
    lat: 35,
    lon: -106,
    active: true,
    jumpable: phase === "complete",
    constructionPhase: phase,
    constructionCompletedAt: phase === "complete" ? "2026-08-30T00:00:00.000Z" : null,
    constructionContributions: [],
    spatialRevision: phase === "blueprint" ? "1" : "2",
    foundingAnnexRadiusM: 750,
    createdAt: "2026-08-30T00:00:00.000Z"
  };
}

function pendingHouse(): CityStructureSnapshot {
  return {
    structureId: "00000000-0000-4000-8000-000000000222",
    cityId,
    type: "city_house",
    tier: 1,
    districtType: null,
    ownerPlayerId: "founder",
    worldId: "main",
    regionCode: "US-NM",
    lat: 35,
    lon: -106,
    footprintRadiusM: 10,
    placementRevision: "1",
    state: "constructing",
    constructionStartedAt: "2026-07-30T12:00:00.000Z",
    constructionCompletesAt: "2026-07-30T12:00:30.000Z",
    builtAt: null,
    upgradedAt: null,
    destroyedAt: null
  };
}

function flag(
  index: number,
  controlType: FlagSnapshot["controlType"],
  ownerCityId: string | null = cityId
): FlagSnapshot {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    controlType,
    ownerId: index === 1 ? "neighbor" : "founder",
    name: `Flag ${index + 1}`,
    lat: 35 + index * 0.001,
    lon: -106,
    packageId: null,
    elevationM: null,
    terrainClass: "land",
    biome: null,
    ecoregion: null,
    claimRadiusM: 500,
    cityId: ownerCityId,
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}

function warehouseSnapshot(id: number): CityWarehouseSnapshot {
  return {
    cityId,
    structureId: `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
    cityName: `City ${id}`,
    tier: 1,
    usedSlots: 0,
    totalSlots: 60,
    revision: "0",
    canReorganize: false,
    gold: {
      balance: "0", capacity: "30000", remainingCapacity: "30000",
      lifetimeDonated: "0", lifetimeSpent: "0", revision: "0",
      canDonate: true, recentDonations: []
    },
    stacks: []
  };
}

function inventorySnapshot(wood: number): PlayerInventorySnapshot {
  return {
    playerId: "player-1",
    revision: 0,
    items: wood > 0 ? [{
      playerId: "player-1",
      resourceType: "wood",
      variant: null,
      quantity: wood,
      stackId: "00000000-0000-4000-8000-000000000901",
      slotIndex: 0,
      manualSplit: false
    }] : [],
    unlockedSlots: 16,
    totals: { ...emptyInventoryTotals(), wood }
  };
}
