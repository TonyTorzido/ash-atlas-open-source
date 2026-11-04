// @vitest-environment jsdom

import {
  destinationPoint,
  distanceMeters,
  type KitchenStateSnapshot,
  type KitchenWorldSnapshot,
  type PlayerSnapshot
} from "@ash-atlas/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ManorClient } from "../../client/domains/manorClient.js";
import { isLocalMovementTargetValid } from "../../movement/localMovementValidation.js";
import {
  useKitchenFeature,
  type KitchenMovementState
} from "./useKitchenFeature.js";

describe("useKitchenFeature exterior access", () => {
  it("opens the action prompt on selection without starting movement", () => {
    const target = kitchen();
    const openKitchen = vi.fn(() => "open-1");
    const requestMove = vi.fn(() => movementIntent());
    const hook = renderHook(() => useKitchenFeature({
      connectionStatus: "online",
      localPlayer: playerAt({ lat: 35.01, lon: -106.01 }, targetPosition(), 10_000),
      getCommands: () => ({ openKitchen }) as unknown as ManorClient,
      requestMove,
      getMovement: vi.fn(() => null),
      receiveInventory: vi.fn(),
      receiveDroppedItems: vi.fn(),
      showActionError: vi.fn()
    }));

    act(() => hook.result.current.actions.handleServerMessage({
      type: "KITCHENS_SNAPSHOT",
      kitchens: [target]
    }));
    act(() => hook.result.current.actions.select(target));

    expect(hook.result.current.view.actionOpen).toBe(true);
    expect(requestMove).not.toHaveBeenCalled();
    expect(openKitchen).not.toHaveBeenCalled();
  });

  it("starts one approach on Use and opens only after the matching move is accepted and stopped", () => {
    const target = kitchen();
    const openKitchen = vi.fn(() => "open-1");
    let movement: KitchenMovementState | null = null;
    const requestMove = vi.fn(() => {
      movement = { requestId: "move-1", generation: 1, accepted: false };
      return movementIntent();
    });
    const getMovement = vi.fn(() => movement);
    const hook = renderHook(
      ({ localPlayer }: { localPlayer: PlayerSnapshot }) => useKitchenFeature({
        connectionStatus: "online",
        localPlayer,
        getCommands: () => ({ openKitchen }) as unknown as ManorClient,
        requestMove,
        getMovement,
        receiveInventory: vi.fn(),
        receiveDroppedItems: vi.fn(),
        showActionError: vi.fn()
      }),
      { initialProps: { localPlayer: playerAt({ lat: 35.01, lon: -106.01 }, targetPosition(), 10_000) } }
    );

    act(() => hook.result.current.actions.handleServerMessage({
      type: "KITCHENS_SNAPSHOT",
      kitchens: [target]
    }));
    act(() => hook.result.current.actions.select(target));
    expect(hook.result.current.view.actionOpen).toBe(true);

    act(() => {
      expect(hook.result.current.actions.cook()).toBe(true);
    });
    expect(requestMove).toHaveBeenCalledOnce();
    expect(hook.result.current.view.actionOpen).toBe(false);
    expect(hook.result.current.view.approaching).toBe(true);
    expect(openKitchen).not.toHaveBeenCalled();

    hook.rerender({ localPlayer: { ...player(target.lat, target.lon), moving: true } });
    expect(openKitchen).not.toHaveBeenCalled();

    movement = { requestId: "move-1", generation: 1, accepted: true };
    hook.rerender({ localPlayer: { ...player(target.lat, target.lon), moving: true } });
    expect(openKitchen).not.toHaveBeenCalled();

    hook.rerender({ localPlayer: player(target.lat, target.lon) });
    expect(openKitchen).toHaveBeenCalledOnce();
    expect(openKitchen).toHaveBeenCalledWith(target.kitchenId);
  });

  it("uses a reachable approach at the 649m target and 600m leash boundary", () => {
    const anchor = targetPosition();
    const target = { ...kitchen(), ...destinationPoint(anchor, 649, 60) };
    const initialPlayer = playerAt(anchor, anchor, 600);
    let movement: KitchenMovementState | null = null;
    const requestMove = vi.fn((lat: number, lon: number) => {
      const approach = { lat, lon };
      if (!isLocalMovementTargetValid(initialPlayer, approach)) return null;
      movement = { requestId: "move-edge", generation: 1, accepted: false };
      return movementIntent("move-edge");
    });
    const openKitchen = vi.fn(() => "open-1");
    const getMovement = vi.fn(() => movement);
    const hook = renderHook(
      ({ localPlayer }: { localPlayer: PlayerSnapshot }) => useKitchenFeature({
        connectionStatus: "online",
        localPlayer,
        getCommands: () => ({ openKitchen }) as unknown as ManorClient,
        requestMove,
        getMovement,
        receiveInventory: vi.fn(),
        receiveDroppedItems: vi.fn(),
        showActionError: vi.fn()
      }),
      { initialProps: { localPlayer: initialPlayer } }
    );

    act(() => hook.result.current.actions.handleServerMessage({
      type: "KITCHENS_SNAPSHOT",
      kitchens: [target]
    }));
    act(() => hook.result.current.actions.select(target));
    act(() => {
      expect(hook.result.current.actions.cook()).toBe(true);
    });

    expect(requestMove).toHaveBeenCalledOnce();
    const [approachLat, approachLon] = requestMove.mock.calls[0]!;
    const approach = { lat: approachLat, lon: approachLon };
    expect(isLocalMovementTargetValid(initialPlayer, approach)).toBe(true);
    expect(distanceMeters(approach, target)).toBeLessThanOrEqual(50);
    expect(openKitchen).not.toHaveBeenCalled();

    hook.rerender({ localPlayer: playerAt(approach, anchor, 600) });
    expect(openKitchen).not.toHaveBeenCalled();
    movement = { requestId: "move-edge", generation: 1, accepted: true };
    hook.rerender({ localPlayer: playerAt(approach, anchor, 600) });
    expect(openKitchen).toHaveBeenCalledOnce();
  });

  it("reports an unreachable Kitchen without sending movement or opening it", () => {
    const anchor = targetPosition();
    const target = { ...kitchen(), ...destinationPoint(anchor, 200, 0) };
    const requestMove = vi.fn(() => movementIntent());
    const openKitchen = vi.fn(() => "open-1");
    const showActionError = vi.fn();
    const hook = renderHook(() => useKitchenFeature({
      connectionStatus: "online",
      localPlayer: playerAt(anchor, anchor, 100),
      getCommands: () => ({ openKitchen }) as unknown as ManorClient,
      requestMove,
      getMovement: vi.fn(() => null),
      receiveInventory: vi.fn(),
      receiveDroppedItems: vi.fn(),
      showActionError
    }));

    act(() => hook.result.current.actions.handleServerMessage({
      type: "KITCHENS_SNAPSHOT",
      kitchens: [target]
    }));
    act(() => hook.result.current.actions.select(target));
    act(() => {
      expect(hook.result.current.actions.cook()).toBe(false);
    });

    expect(requestMove).not.toHaveBeenCalled();
    expect(openKitchen).not.toHaveBeenCalled();
    expect(showActionError).toHaveBeenCalledWith("This Kitchen is outside your movement range.");
  });

  it.each([
    ["missing", () => null],
    ["different", () => ({ requestId: "manual-move", generation: 2, accepted: true })]
  ])("cancels a pending approach when the shared movement identity is %s", (_label, nextMovement) => {
    const target = kitchen();
    const openKitchen = vi.fn(() => "open-1");
    let movement: KitchenMovementState | null = null;
    const requestMove = vi.fn(() => {
      movement = { requestId: "move-1", generation: 1, accepted: false };
      return movementIntent();
    });
    const getMovement = vi.fn(() => movement);
    const hook = renderHook(
      ({ localPlayer }: { localPlayer: PlayerSnapshot }) => useKitchenFeature({
        connectionStatus: "online",
        localPlayer,
        getCommands: () => ({ openKitchen }) as unknown as ManorClient,
        requestMove,
        getMovement,
        receiveInventory: vi.fn(),
        receiveDroppedItems: vi.fn(),
        showActionError: vi.fn()
      }),
      { initialProps: { localPlayer: playerAt({ lat: 35.01, lon: -106.01 }, targetPosition(), 10_000) } }
    );

    act(() => hook.result.current.actions.handleServerMessage({
      type: "KITCHENS_SNAPSHOT",
      kitchens: [target]
    }));
    act(() => hook.result.current.actions.select(target));
    void act(() => hook.result.current.actions.cook());
    expect(hook.result.current.view.approaching).toBe(true);

    movement = nextMovement();
    hook.rerender({ localPlayer: player(target.lat, target.lon) });
    expect(hook.result.current.view.approaching).toBe(false);
    expect(openKitchen).not.toHaveBeenCalled();

    movement = { requestId: "move-1", generation: 1, accepted: true };
    hook.rerender({ localPlayer: player(target.lat, target.lon) });
    expect(openKitchen).not.toHaveBeenCalled();
  });

  it("cancels approach on selection replacement, close, and Kitchen errors", () => {
    const target = kitchen();
    const replacement = { ...kitchen(), kitchenId: "00000000-0000-4000-8000-000000000003", lat: 35.002 };
    const openKitchen = vi.fn(() => "open-1");
    let movement: KitchenMovementState | null = null;
    const requestMove = vi.fn(() => {
      movement = { requestId: "move-1", generation: 1, accepted: false };
      return movementIntent();
    });
    const hook = renderHook(
      ({ localPlayer }: { localPlayer: PlayerSnapshot }) => useKitchenFeature({
        connectionStatus: "online",
        localPlayer,
        getCommands: () => ({ openKitchen }) as unknown as ManorClient,
        requestMove,
        getMovement: () => movement,
        receiveInventory: vi.fn(),
        receiveDroppedItems: vi.fn(),
        showActionError: vi.fn()
      }),
      { initialProps: { localPlayer: playerAt({ lat: 35.01, lon: -106.01 }, targetPosition(), 10_000) } }
    );

    act(() => hook.result.current.actions.handleServerMessage({
      type: "KITCHENS_SNAPSHOT",
      kitchens: [target, replacement]
    }));
    act(() => hook.result.current.actions.select(target));
    void act(() => hook.result.current.actions.cook());
    expect(hook.result.current.view.approaching).toBe(true);

    act(() => hook.result.current.actions.select(replacement));
    expect(hook.result.current.view.approaching).toBe(false);
    movement = { requestId: "move-1", generation: 1, accepted: true };
    hook.rerender({ localPlayer: player(target.lat, target.lon) });
    expect(openKitchen).not.toHaveBeenCalled();

    hook.rerender({ localPlayer: playerAt({ lat: 35.01, lon: -106.01 }, targetPosition(), 10_000) });
    act(() => hook.result.current.actions.select(target));
    void act(() => hook.result.current.actions.cook());
    expect(hook.result.current.view.approaching).toBe(true);
    act(() => hook.result.current.actions.close());
    expect(hook.result.current.view.approaching).toBe(false);

    act(() => hook.result.current.actions.select(target));
    void act(() => hook.result.current.actions.cook());
    act(() => hook.result.current.actions.handleServerMessage({
      type: "KITCHEN_ERROR",
      code: "KITCHEN_UNAVAILABLE",
      message: "Kitchen unavailable."
    }));
    expect(hook.result.current.view.approaching).toBe(false);
    movement = { requestId: "move-1", generation: 1, accepted: true };
    hook.rerender({ localPlayer: player(target.lat, target.lon) });
    expect(openKitchen).not.toHaveBeenCalled();
  });

  it("opens immediately when selection is already within interaction range", () => {
    const target = kitchen();
    const openKitchen = vi.fn(() => "open-1");
    const requestMove = vi.fn(() => movementIntent());
    const hook = renderHook(() => useKitchenFeature({
      connectionStatus: "online",
      localPlayer: player(target.lat, target.lon),
      getCommands: () => ({ openKitchen }) as unknown as ManorClient,
      requestMove,
      getMovement: vi.fn(() => null),
      receiveInventory: vi.fn(),
      receiveDroppedItems: vi.fn(),
      showActionError: vi.fn()
    }));

    act(() => hook.result.current.actions.handleServerMessage({
      type: "KITCHENS_SNAPSHOT",
      kitchens: [target]
    }));
    act(() => hook.result.current.actions.select(target));
    expect(openKitchen).toHaveBeenCalledOnce();
    expect(requestMove).not.toHaveBeenCalled();

    act(() => {
      expect(hook.result.current.actions.cook()).toBe(true);
    });
    expect(openKitchen).toHaveBeenCalledOnce();

    act(() => hook.result.current.actions.handleServerMessage({
      type: "KITCHEN_STATE",
      requestId: "open-1",
      state: kitchenState(target)
    }));
    expect(hook.result.current.view.open).toBe(true);
    expect(hook.result.current.view.actionOpen).toBe(false);
  });
});

function targetPosition(): { lat: number; lon: number } {
  return { lat: 35, lon: -106 };
}

function movementIntent(requestId = "move-1"): { requestId: string; generation: number } {
  return { requestId, generation: 1 };
}

function kitchenState(target: KitchenWorldSnapshot): KitchenStateSnapshot {
  return {
    kitchen: target,
    jobs: [],
    queueCapacity: 5,
    occupiedSlots: 0,
    serverTime: Date.now()
  };
}

function kitchen(): KitchenWorldSnapshot {
  return {
    kitchenId: "00000000-0000-4000-8000-000000000002",
    manorId: "00000000-0000-4000-8000-000000000003",
    ownerPlayerId: "owner",
    ownerUsername: "Ash",
    regionCode: "world-test",
    lat: 35,
    lon: -106,
    builtAt: "2026-01-01T00:00:00.000Z",
    placementRevision: 1
  };
}

function player(lat: number, lon: number): PlayerSnapshot {
  return playerAt({ lat, lon }, targetPosition(), 10_000);
}

function playerAt(
  position: { lat: number; lon: number },
  anchor: { lat: number; lon: number },
  moveLeashRadiusM: number
): PlayerSnapshot {
  return {
    playerId: "guest",
    username: "Bex",
    displayColor: null,
    regionCode: "world-test",
    zoneId: "world-test:zone",
    lat: position.lat,
    lon: position.lon,
    anchorLat: anchor.lat,
    anchorLon: anchor.lon,
    moveLeashRadiusM,
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
