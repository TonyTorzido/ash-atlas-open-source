// @vitest-environment jsdom

import {
  emptyInventoryTotals,
  type FurnaceWorldSnapshot,
  type PlayerSnapshot
} from "@ash-atlas/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ManorClient } from "../../client/domains/manorClient.js";
import { useFurnaceFeature } from "./useFurnaceFeature.js";

type Props = {
  connectionStatus: "offline" | "connecting" | "online";
};

describe("useFurnaceFeature runtime ownership", () => {
  it("keeps selection actions stable across connection status changes", () => {
    const openFurnace = vi.fn(() => "request-1");
    const options = {
      ownPlayerId: "player-1",
      localPlayer: null,
      getCommands: () => ({ openFurnace }) as unknown as ManorClient,
      requestMove: vi.fn(() => true),
      receiveInventory: vi.fn(),
      receiveDroppedItems: vi.fn(),
      showActionError: vi.fn()
    };
    const hook = renderHook(
      ({ connectionStatus }: Props) => useFurnaceFeature({ ...options, connectionStatus }),
      { initialProps: { connectionStatus: "offline" } as Props }
    );
    const initialSelect = hook.result.current.actions.select;
    const initialRefresh = hook.result.current.actions.refresh;

    expect(initialRefresh("furnace-1")).toBe(false);
    hook.rerender({ connectionStatus: "connecting" });
    expect(hook.result.current.actions.select).toBe(initialSelect);
    expect(hook.result.current.actions.refresh).toBe(initialRefresh);
    expect(initialRefresh("furnace-1")).toBe(false);

    hook.rerender({ connectionStatus: "online" });
    expect(hook.result.current.actions.select).toBe(initialSelect);
    expect(hook.result.current.actions.refresh).toBe(initialRefresh);
    expect(initialRefresh("furnace-1")).toBe(true);
    expect(openFurnace).toHaveBeenCalledOnce();
  });

  it("opens actions on selection and approaches only after Smelt is chosen", () => {
    const requestMove = vi.fn(() => true);
    const openFurnace = vi.fn(() => "open-1");
    const target = furnace();
    const hook = renderHook(
      ({ localPlayer }: { localPlayer: PlayerSnapshot }) => useFurnaceFeature({
        connectionStatus: "online",
        ownPlayerId: "player-1",
        localPlayer,
        getCommands: () => ({ openFurnace }) as unknown as ManorClient,
        requestMove,
        receiveInventory: vi.fn(),
        receiveDroppedItems: vi.fn(),
        showActionError: vi.fn()
      }),
      { initialProps: { localPlayer: player(35.01, -106.01) } }
    );
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FURNACES_SNAPSHOT",
      furnaces: [target]
    }));

    act(() => hook.result.current.actions.select(target));
    expect(hook.result.current.view.actionOpen).toBe(true);
    expect(hook.result.current.view.open).toBe(false);
    expect(requestMove).not.toHaveBeenCalled();

    act(() => {
      hook.result.current.actions.smelt();
    });
    expect(requestMove).toHaveBeenCalledOnce();
    expect(hook.result.current.view.actionOpen).toBe(false);
    expect(hook.result.current.view.approaching).toBe(true);
    expect(openFurnace).not.toHaveBeenCalled();

    hook.rerender({ localPlayer: player(target.lat, target.lon) });
    expect(openFurnace).toHaveBeenCalledWith(target.furnaceId);
    expect(hook.result.current.view.open).toBe(false);

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FURNACE_STATE",
      requestId: "open-1",
      state: { furnace: target, jobs: [], queueCapacity: 5, occupiedSlots: 0, serverTime: Date.now() }
    }));
    expect(hook.result.current.view.open).toBe(true);
    expect(hook.result.current.view.actionOpen).toBe(false);
  });

  it("uses a Furnace directly from a multi-target quick action", () => {
    const requestMove = vi.fn(() => true);
    const target = furnace();
    const hook = renderHook(() => useFurnaceFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      localPlayer: player(35.01, -106.01),
      getCommands: () => null,
      requestMove,
      receiveInventory: vi.fn(),
      receiveDroppedItems: vi.fn(),
      showActionError: vi.fn()
    }));

    act(() => {
      expect(hook.result.current.actions.smelt(target)).toBe(true);
    });

    expect(requestMove).toHaveBeenCalledOnce();
    expect(hook.result.current.view.approaching).toBe(true);
    expect(hook.result.current.view.actionOpen).toBe(false);
  });

  it("tracks a timed build and applies movement cancellation refunds", () => {
    const receiveInventory = vi.fn();
    const receiveDroppedItems = vi.fn();
    const showActionError = vi.fn();
    const buildFurnace = vi.fn(() => "build-1");
    const hook = renderHook(() => useFurnaceFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      localPlayer: null,
      getCommands: () => ({ buildFurnace }) as unknown as ManorClient,
      requestMove: vi.fn(() => true),
      receiveInventory,
      receiveDroppedItems,
      showActionError
    }));
    const inventory = {
      playerId: "player-1",
      revision: 2,
      items: [],
      totals: emptyInventoryTotals()
    };
    act(() => {
      hook.result.current.actions.build();
    });
    expect(buildFurnace).toHaveBeenCalledOnce();
    expect(hook.result.current.view.pending.build).toBe("build-1");
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FURNACE_BUILD_STARTED",
      requestId: "build-1",
      build: {
        buildId: "00000000-0000-4000-8000-000000000001",
        position: { lat: 35, lon: -106 },
        startedAt: 1_000,
        completesAt: 31_000,
        durationMs: 30_000
      },
      inventory,
      serverTime: 1_000,
      replayed: false
    }));
    expect(hook.result.current.view.construction?.requestId).toBe("build-1");
    expect(hook.result.current.view.construction?.countdown.durationMs).toBe(30_000);
    expect(receiveInventory).toHaveBeenCalledWith(inventory);

    act(() => hook.result.current.actions.handleServerMessage({
      type: "FURNACE_BUILD_CANCELLED",
      requestId: "build-1",
      buildId: "00000000-0000-4000-8000-000000000001",
      inventory: { ...inventory, revision: 3 },
      droppedItems: [],
      message: "Furnace construction was cancelled by movement."
    }));
    expect(hook.result.current.view.construction).toBeNull();
    expect(receiveDroppedItems).toHaveBeenCalledWith([]);
    expect(showActionError).toHaveBeenCalledWith(
      "Furnace construction was cancelled by movement."
    );
  });

  it("shows canonical feedback when the build request cannot be sent", () => {
    const showActionError = vi.fn();
    const buildFurnace = vi.fn(() => null);
    const hook = renderHook(() => useFurnaceFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      localPlayer: null,
      getCommands: () => ({ buildFurnace }) as unknown as ManorClient,
      requestMove: vi.fn(() => true),
      receiveInventory: vi.fn(),
      receiveDroppedItems: vi.fn(),
      showActionError
    }));

    act(() => {
      hook.result.current.actions.build();
    });

    expect(buildFurnace).toHaveBeenCalledOnce();
    expect(hook.result.current.view.pending.build).toBeNull();
    expect(showActionError).toHaveBeenCalledWith(
      "Could not send the Furnace build request. Check your connection and try again."
    );
  });

  it("sends the selected recipe as one authoritative Furnace start request", () => {
    const startFurnaceSmelt = vi.fn(() => "start-1");
    const hook = renderHook(() => useFurnaceFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      localPlayer: null,
      getCommands: () => ({ startFurnaceSmelt }) as unknown as ManorClient,
      requestMove: vi.fn(() => true),
      receiveInventory: vi.fn(),
      receiveDroppedItems: vi.fn(),
      showActionError: vi.fn()
    }));
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FURNACE_STATE",
      state: { furnace: furnace(), jobs: [], queueCapacity: 5, occupiedSlots: 0, serverTime: Date.now() }
    }));

    act(() => {
      expect(hook.result.current.actions.start("venomsteel_bar", 2)).toBe(true);
    });

    expect(startFurnaceSmelt).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      "venomsteel_bar",
      2,
      {}
    );
    expect(hook.result.current.view.pending.start).toBe("start-1");
  });

  it("reports a successful collection after the queue is cleared", () => {
    const collectFurnaceOutput = vi.fn(() => "collect-1");
    const hook = renderHook(() => useFurnaceFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      localPlayer: null,
      getCommands: () => ({ collectFurnaceOutput }) as unknown as ManorClient,
      requestMove: vi.fn(() => true),
      receiveInventory: vi.fn(),
      receiveDroppedItems: vi.fn(),
      showActionError: vi.fn()
    }));
    const state = {
      furnace: furnace(),
      jobs: [{
        jobId: "00000000-0000-4000-8000-000000000004",
        recipeId: "venomsteel_core",
        outputItemId: "venomsteel_core",
        outputDisplayName: "Venom Core",
        requestedQuantity: 1,
        completedQuantity: 1,
        collectedQuantity: 0,
        readyQuantity: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        nextCompletesAt: null,
        productionFinished: true
      }],
      queueCapacity: 5,
      occupiedSlots: 1,
      serverTime: 1
    } as const;
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FURNACE_STATE",
      state
    }));
    act(() => hook.result.current.actions.collect());
    act(() => hook.result.current.actions.handleServerMessage({
      type: "FURNACE_OUTPUT_COLLECTED",
      requestId: "collect-1",
      state: { ...state, jobs: [], occupiedSlots: 0 },
      inventory: {
        playerId: "player-1",
        revision: 2,
        items: [],
        totals: emptyInventoryTotals()
      },
      collectedQuantity: 1,
      replayed: false
    }));

    expect(hook.result.current.view.feedback).toBe("Collected 1 Furnace item.");
  });
});

function furnace(): FurnaceWorldSnapshot {
  return {
    furnaceId: "00000000-0000-4000-8000-000000000002",
    manorId: "00000000-0000-4000-8000-000000000003",
    ownerPlayerId: "player-1",
    ownerUsername: "Scout",
    regionCode: "world-test",
    lat: 35,
    lon: -106,
    builtAt: "2026-01-01T00:00:00.000Z",
    placementRevision: 1
  };
}

function player(lat: number, lon: number): PlayerSnapshot {
  return {
    playerId: "player-1",
    username: "Scout",
    displayColor: null,
    regionCode: "world-test",
    zoneId: "world-test:zone",
    lat,
    lon,
    anchorLat: lat,
    anchorLon: lon,
    moveLeashRadiusM: 10_000,
    movementRevision: 1,
    relocationRevision: 1,
    targetLat: null,
    targetLon: null,
    moving: false,
    currentFlagId: null,
    online: true,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
