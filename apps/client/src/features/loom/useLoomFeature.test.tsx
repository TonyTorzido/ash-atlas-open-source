// @vitest-environment jsdom

import {
  destinationPoint,
  distanceMeters,
  emptyInventoryTotals,
  type LoomStateSnapshot,
  type LoomWorldSnapshot,
  type PlayerInventorySnapshot,
  type PlayerSnapshot
} from "@ash-atlas/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ManorClient } from "../../client/domains/manorClient.js";
import { isLocalMovementTargetValid } from "../../movement/localMovementValidation.js";
import { useLoomFeature, type LoomMovementState } from "./useLoomFeature.js";

describe("useLoomFeature exterior access", () => {
  it("opens a nearby non-owner Loom without an ownership gate", () => {
    const openLoom = vi.fn(() => "open-1");
    const target = loom();
    const hook = renderHook(() => useLoomFeature({
      connectionStatus: "online",
      localPlayer: player(target.lat, target.lon),
      getCommands: () => ({ openLoom }) as unknown as ManorClient,
      requestMove: vi.fn(() => movementIntent()),
      getMovement: vi.fn(() => null),
      receiveInventory: vi.fn(),
      receiveDroppedItems: vi.fn(),
      showActionError: vi.fn()
    }));

    act(() => hook.result.current.actions.handleServerMessage({ type: "LOOMS_SNAPSHOT", looms: [target] }));
    act(() => hook.result.current.actions.select(target));

    expect(openLoom).toHaveBeenCalledOnce();
    expect(openLoom).toHaveBeenCalledWith(target.loomId);
    expect(hook.result.current.view.actionOpen).toBe(true);
  });

  it("opens actions on selection and approaches only after Use is chosen", () => {
    let movement: LoomMovementState | null = null;
    const requestMove = vi.fn(() => {
      movement = { requestId: "move-1", generation: 1, accepted: false };
      return movementIntent();
    });
    const openLoom = vi.fn(() => "open-1");
    const target = loom();
    const hook = renderHook(
      ({ localPlayer }: { localPlayer: PlayerSnapshot }) => useLoomFeature({
        connectionStatus: "online",
        localPlayer,
        getCommands: () => ({ openLoom }) as unknown as ManorClient,
        requestMove,
        getMovement: vi.fn(() => movement),
        receiveInventory: vi.fn(),
        receiveDroppedItems: vi.fn(),
        showActionError: vi.fn()
      }),
      { initialProps: { localPlayer: player(35.01, -106.01) } }
    );

    act(() => hook.result.current.actions.handleServerMessage({
      type: "LOOMS_SNAPSHOT",
      looms: [target]
    }));
    act(() => hook.result.current.actions.select(target));

    expect(hook.result.current.view.actionOpen).toBe(true);
    expect(requestMove).not.toHaveBeenCalled();

    act(() => {
      expect(hook.result.current.actions.weave()).toBe(true);
    });
    expect(requestMove).toHaveBeenCalledOnce();
    expect(hook.result.current.view.actionOpen).toBe(false);
    expect(hook.result.current.view.approaching).toBe(true);
    expect(openLoom).not.toHaveBeenCalled();

    hook.rerender({ localPlayer: player(target.lat, target.lon) });
    expect(openLoom).not.toHaveBeenCalled();

    movement = { requestId: "move-1", generation: 1, accepted: true };
    hook.rerender({ localPlayer: player(target.lat, target.lon) });
    expect(openLoom).toHaveBeenCalledWith(target.loomId);
  });

  it("uses the movement-leash boundary as a valid Loom approach point", () => {
    const anchor = targetPosition();
    const targetPositionAtLeashEdge = destinationPoint(anchor, 649, 60);
    const target = { ...loom(), ...targetPositionAtLeashEdge };
    const initialPlayer = playerAt(anchor, anchor, 600);
    let movement: LoomMovementState | null = null;
    const requestMove = vi.fn((lat: number, lon: number) => {
      if (!isLocalMovementTargetValid(initialPlayer, { lat, lon })) return null;
      movement = { requestId: "move-edge", generation: 1, accepted: false };
      return movementIntent("move-edge");
    });
    const openLoom = vi.fn(() => "open-1");
    const hook = renderHook(
      ({ localPlayer }: { localPlayer: PlayerSnapshot }) => useLoomFeature({
        connectionStatus: "online",
        localPlayer,
        getCommands: () => ({ openLoom }) as unknown as ManorClient,
        requestMove,
        getMovement: vi.fn(() => movement),
        receiveInventory: vi.fn(),
        receiveDroppedItems: vi.fn(),
        showActionError: vi.fn()
      }),
      { initialProps: { localPlayer: initialPlayer } }
    );

    act(() => hook.result.current.actions.handleServerMessage({
      type: "LOOMS_SNAPSHOT",
      looms: [target]
    }));
    act(() => hook.result.current.actions.select(target));

    act(() => {
      expect(hook.result.current.actions.weave()).toBe(true);
    });
    expect(requestMove).toHaveBeenCalledOnce();
    const [approachLat, approachLon] = requestMove.mock.calls[0]!;
    const approach = { lat: approachLat, lon: approachLon };
    expect(isLocalMovementTargetValid(initialPlayer, approach)).toBe(true);
    expect(distanceMeters(approach, target)).toBeLessThanOrEqual(50);
    expect(hook.result.current.view.approaching).toBe(true);

    hook.rerender({ localPlayer: playerAt(approach, anchor, 600) });
    expect(openLoom).not.toHaveBeenCalled();

    movement = { requestId: "move-edge", generation: 1, accepted: true };
    hook.rerender({ localPlayer: playerAt(approach, anchor, 600) });
    expect(openLoom).toHaveBeenCalledWith(target.loomId);
  });

  it("uses the Loom immediately when already within interaction range", () => {
    const openLoom = vi.fn(() => "open-1");
    const target = loom();
    const requestMove = vi.fn(() => movementIntent());
    const hook = renderHook(() => useLoomFeature({
      connectionStatus: "online",
      localPlayer: player(target.lat, target.lon),
      getCommands: () => ({ openLoom }) as unknown as ManorClient,
      requestMove,
      getMovement: vi.fn(() => null),
      receiveInventory: vi.fn(),
      receiveDroppedItems: vi.fn(),
      showActionError: vi.fn()
    }));

    act(() => hook.result.current.actions.handleServerMessage({
      type: "LOOMS_SNAPSHOT",
      looms: [target]
    }));
    act(() => hook.result.current.actions.select(target));
    expect(openLoom).toHaveBeenCalledOnce();

    act(() => {
      expect(hook.result.current.actions.weave()).toBe(true);
    });
    expect(requestMove).not.toHaveBeenCalled();

    act(() => hook.result.current.actions.handleServerMessage({
      type: "LOOM_STATE",
      requestId: "open-1",
      state: loomState(target)
    }));
    expect(hook.result.current.view.open).toBe(true);
    expect(hook.result.current.view.actionOpen).toBe(false);
  });

  it("clears a stale construction marker when the Loom snapshot confirms completion", () => {
    const buildLoom = vi.fn(() => "build-1");
    const receiveInventory = vi.fn();
    const hook = renderHook(() => useLoomFeature({
      connectionStatus: "online",
      localPlayer: null,
      getCommands: () => ({ buildLoom }) as unknown as ManorClient,
      requestMove: vi.fn(() => movementIntent()),
      getMovement: vi.fn(() => null),
      receiveInventory,
      receiveDroppedItems: vi.fn(),
      showActionError: vi.fn()
    }));
    const inventory: PlayerInventorySnapshot = {
      playerId: "guest",
      revision: 2,
      items: [],
      totals: emptyInventoryTotals()
    };

    act(() => {
      hook.result.current.actions.build();
    });
    act(() => hook.result.current.actions.handleServerMessage({
      type: "LOOM_BUILD_STARTED",
      requestId: "build-1",
      build: {
        buildId: "00000000-0000-4000-8000-000000000001",
        position: { lat: targetPosition().lat, lon: targetPosition().lon },
        startedAt: 1_000,
        completesAt: 31_000,
        durationMs: 30_000
      },
      inventory,
      serverTime: 1_000,
      replayed: false
    }));
    expect(hook.result.current.view.construction).not.toBeNull();

    act(() => hook.result.current.actions.handleServerMessage({
      type: "LOOMS_SNAPSHOT",
      looms: [loom()]
    }));
    expect(hook.result.current.view.construction).toBeNull();
    expect(hook.result.current.view.pending.build).toBeNull();

    act(() => hook.result.current.actions.handleServerMessage({
      type: "LOOM_BUILD_RESULT",
      requestId: "build-1",
      loom: loom(),
      inventory: { ...inventory, revision: 3 },
      replayed: false
    }));
    expect(receiveInventory).toHaveBeenCalledTimes(2);
    expect(hook.result.current.view.looms).toEqual([loom()]);
  });
});

function targetPosition(): { lat: number; lon: number } {
  return { lat: 35, lon: -106 };
}

function movementIntent(requestId = "move-1"): { requestId: string; generation: number } {
  return { requestId, generation: 1 };
}

function loomState(target: LoomWorldSnapshot): LoomStateSnapshot {
  return {
    loom: target,
    jobs: [],
    queueCapacity: 5,
    occupiedSlots: 0,
    serverTime: Date.now()
  };
}

function loom(): LoomWorldSnapshot {
  return {
    loomId: "00000000-0000-4000-8000-000000000002",
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
  return playerAt({ lat, lon }, { lat, lon }, 10_000);
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
