// @vitest-environment jsdom

import {
  emptyInventoryTotals,
  type CollectibleNode,
  type ServerMessage
} from "@ash-atlas/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { emptyPopulationZoneProjection } from "../../population/populationZoneProjection.js";
import {
  InventoryStackActionRequestGate
} from "../../inventory/inventoryPanelModel.js";
import {
  routeClientServerMessage,
  type ClientFrameHandlers
} from "../../client/clientFrameRouter.js";
import {
  replayPendingHarvestCompletion,
  type QueuedHarvestReplacement,
  type HarvestTask
} from "../../collectibles/harvest.js";
import {
  isHarvestingServerMessage,
  useHarvestingFrameHandler
} from "./useHarvestingFrameHandler.js";

describe("useHarvestingFrameHandler", () => {
  it("routes every inventory action response through the runtime guard exactly once", () => {
    const receiveInventorySnapshot = vi.fn();
    const gate = new InventoryStackActionRequestGate();
    const inventory = {
      playerId: "player-1",
      revision: 0,
      items: [],
      totals: emptyInventoryTotals(),
      unlockedSlots: 16
    };
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      inventoryStackActionRequestGateRef: { current: gate },
      receiveInventorySnapshot
    } as never));
    const ignored = vi.fn();
    const handlers = {
      session: ignored,
      world: ignored,
      flags: ignored,
      settlements: ignored,
      travel: ignored,
      party: ignored,
      manor: ignored,
      dungeon: ignored,
      backpack: ignored,
      harvesting: (frame) => {
        if (isHarvestingServerMessage(frame)) result.current(frame);
      },
      combatEquipment: ignored,
      social: ignored,
      market: ignored,
      pets: ignored,
      packages: ignored,
      developer: ignored,
      portal: ignored,
      terminal: ignored
    } satisfies ClientFrameHandlers;
    const actions = ["split", "restack", "move", "reorganize"] as const;

    for (const action of actions) {
      const requestId = `request-${action}`;
      gate.begin(requestId, action, performance.now());
      act(() => routeClientServerMessage({
        type: "INVENTORY_STACK_UPDATED",
        requestId,
        action,
        inventory,
        serverTime: Date.now(),
        message: `${action} complete`
      } satisfies ServerMessage, handlers));
      expect(gate.has(requestId)).toBe(false);
    }

    expect(receiveInventorySnapshot).toHaveBeenCalledTimes(actions.length);
    expect(receiveInventorySnapshot).toHaveBeenNthCalledWith(1, inventory);
    expect(ignored).not.toHaveBeenCalled();
  });

  it("updates inventory and enqueues one icon-bearing resin floater only for a fresh use", () => {
    const receiveInventorySnapshot = vi.fn();
    const enqueueFloatingFeedback = vi.fn();
    const inventory = { playerId: "player-1", items: [], totals: {} };
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      overlayRef: { current: { enqueueFloatingFeedback } },
      receiveInventorySnapshot
    } as never));
    const message = {
      type: "CONSUMABLE_USED",
      requestId: "request-1",
      itemId: "giving_berry",
      playerId: "player-1",
      inventory,
      effect: {
        effectId: "effect-1",
        playerId: "player-1",
        startedAt: "2026-07-24T00:00:00.000Z",
        endsAt: "2026-07-24T00:00:10.000Z"
      },
      replayed: false,
      serverTime: 1_000,
      message: "Giving Berry used."
    } as const;

    act(() => result.current(message as never));
    act(() => result.current({ ...message, replayed: true } as never));

    expect(receiveInventorySnapshot).toHaveBeenCalledTimes(2);
    expect(receiveInventorySnapshot).toHaveBeenLastCalledWith(inventory);
    expect(enqueueFloatingFeedback).toHaveBeenCalledOnce();
    expect(enqueueFloatingFeedback).toHaveBeenCalledWith({
      eventId: "resin-spent:effect-1",
      targetEntityId: "player-1",
      kind: "resin_spent",
      amount: 1,
      icon: "giving_berry"
    });
  });

  it("notes the node being harvested before its gain flies, so rewards pop out of the node", () => {
    const noteHarvestTarget = vi.fn();
    const enqueueResourceGain = vi.fn();
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      overlayRef: { current: { noteHarvestTarget, enqueueResourceGain } },
      harvestTaskRef: { current: { nodeId: "tree-7" } }
    } as never));
    act(() => result.current({
      type: "RESOURCE_GAINED", playerId: "player-1", gain: { eventId: "g1", itemId: "wood", quantity: 3 }
    } as never));
    expect(noteHarvestTarget).toHaveBeenCalledWith("tree-7");
    expect(noteHarvestTarget.mock.invocationCallOrder[0]).toBeLessThan(enqueueResourceGain.mock.invocationCallOrder[0]!);
    act(() => result.current({
      type: "RESOURCE_GAINED", playerId: "someone-else", gain: { eventId: "g2", itemId: "wood", quantity: 1 }
    } as never));
    expect(enqueueResourceGain).toHaveBeenCalledOnce();
  });

  it("shows exact authoritative pickup feedback once and never for zero received", () => {
    const receiveInventorySnapshot = vi.fn();
    const enqueueFloatingFeedback = vi.fn();
    const finish = vi.fn();
    const drop = {
      dropId: "11111111-1111-4111-8111-111111111111",
      droppedBy: "player-2",
      regionCode: "NM",
      itemId: "leather",
      variant: null,
      quantity: 58,
      status: "active",
      lat: 35,
      lon: -106,
      createdAt: "2026-07-25T00:00:00.000Z",
      expiresAt: "2026-07-25T00:10:00.000Z",
      pickedUpBy: null,
      pickedUpAt: null
    } as const;
    const inventory = {
      playerId: "player-1",
      revision: 0,
      items: [],
      totals: emptyInventoryTotals(),
      unlockedSlots: 16
    };
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      overlayRef: { current: { enqueueFloatingFeedback } },
      droppedItemPickupRequestGateRef: { current: { finish } },
      receiveInventorySnapshot,
      setDroppedItems: vi.fn(),
      clearDroppedItemInteraction: vi.fn(),
      attemptReadyDroppedItemPickup: vi.fn(),
      setWarning: vi.fn()
    } as never));
    const message = {
      type: "DROPPED_ITEM_PICKUP_RESULT",
      requestId: "pickup-25",
      itemId: "leather",
      requestedQuantity: 25,
      drop,
      pickedUpQuantity: 25,
      remainingQuantity: 58,
      removed: false,
      inventory,
      replayed: false,
      serverTime: 1_000,
      message: "Picked up Leather x25."
    } as const;

    act(() => result.current(message));
    act(() => result.current({ ...message, replayed: true }));
    act(() => result.current({
      ...message,
      requestId: "pickup-zero",
      pickedUpQuantity: 0,
      replayed: false
    }));

    expect(receiveInventorySnapshot).toHaveBeenCalledTimes(3);
    expect(enqueueFloatingFeedback).toHaveBeenCalledOnce();
    expect(enqueueFloatingFeedback).toHaveBeenCalledWith({
      eventId: "ground-pickup:pickup-25",
      targetEntityId: "player-1",
      kind: "resource",
      amount: 25,
      icon: expect.any(String),
      subject: "Leather",
      label: "+25 Leather",
      // The gain flies out of the spot the item lay.
      worldPosition: { lat: drop.lat, lon: drop.lon }
    });
  });

  it("ignores collectible snapshots from old player, relocation, or vision authority", () => {
    const setCollectibles = vi.fn();
    const gameplayViewGenerationRef = { current: 3 };
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      relocationRevisionRef: { current: 7 },
      resourceVisionRevisionRef: { current: 9 },
      gameplayViewGenerationRef,
      localPlayerRef: { current: { currentFlagId: "flag-1" } },
      setCollectibles
    } as never));
    const snapshot = {
      type: "COLLECTIBLES_SNAPSHOT" as const,
      playerId: "player-1",
      relocationRevision: 7,
      resourceVisionRevision: 9,
      authority: {
        snapshotId: "snapshot-1",
        snapshotGeneration: 1,
        gameplayViewGeneration: 3,
        scope: { kind: "flag" as const, id: "flag-1" },
        includedDomains: [
          "resource-vision",
          "repeatable-resource"
        ] as const,
        completeness: "complete" as const,
        ordinaryNodesTruncated: false,
        returnedCount: 0,
        authoritativeTotalCount: 0
      },
      serverTime: 1_000,
      visibleRadiusM: 650,
      activationRadiusM: 650,
      resourceVision: {
        flagId: "flag-1",
        flagName: "Flag",
        center: { lat: 35, lon: -106 },
        movementLeashRadiusM: 600,
        paddingM: 50,
        radiusM: 650
      },
      resourceVisionStatus: null,
      waterHighlights: [],
      nodes: [],
      repeatableNodes: []
    };

    act(() => result.current({ ...snapshot, playerId: "player-old" }));
    act(() => result.current({ ...snapshot, relocationRevision: 6 }));
    act(() => result.current({ ...snapshot, resourceVisionRevision: 8 }));
    gameplayViewGenerationRef.current = 4;
    act(() => result.current(snapshot));

    expect(setCollectibles).not.toHaveBeenCalled();
  });

  it("renders population-owned trees from the first collectible snapshot", () => {
    const tree = collectible({
      presentationOwner: "population",
      treeLifeRevision: 7
    });
    const setCollectibles = vi.fn();
    const renderStateRef = {
      current: {
        collectibles: [],
        selectedCollectibleId: null
      }
    };
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      relocationRevisionRef: { current: 7 },
      resourceVisionRevisionRef: { current: 9 },
      gameplayViewGenerationRef: { current: 3 },
      localPlayerRef: { current: { currentFlagId: "flag-1" } },
      renderStateRef,
      overlayRef: { current: null },
      harvestTaskRef: { current: null },
      selectedCollectibleIdRef: { current: null },
      surveyStartedAtRef: { current: null },
      setCollectibles,
      setSelectedCollectibleId: vi.fn(),
      setResourceVision: vi.fn(),
      setResourceVisionStatus: vi.fn(),
      setWaterHighlights: vi.fn(),
      settleHarvestAfterAuthoritativeRemoval: vi.fn(),
      clearOptimisticResinPresentation: vi.fn()
    } as never));

    act(() => result.current({
      type: "COLLECTIBLES_SNAPSHOT",
      playerId: "player-1",
      relocationRevision: 7,
      resourceVisionRevision: 9,
      authority: {
        snapshotId: "snapshot-first-arrival",
        snapshotGeneration: 1,
        gameplayViewGeneration: 3,
        scope: { kind: "flag", id: "flag-1" },
        includedDomains: ["population", "repeatable-resource"],
        completeness: "complete",
        ordinaryNodesTruncated: false,
        returnedCount: 1,
        authoritativeTotalCount: 1
      },
      serverTime: 1_000,
      visibleRadiusM: 650,
      activationRadiusM: 650,
      resourceVision: {
        flagId: "flag-1",
        flagName: "Flag",
        center: { lat: 35, lon: -106 },
        movementLeashRadiusM: 600,
        paddingM: 50,
        radiusM: 650
      },
      resourceVisionStatus: null,
      waterHighlights: [],
      nodes: [tree],
      repeatableNodes: []
    }));

    expect(renderStateRef.current.collectibles).toEqual([
      expect.objectContaining({
        id: tree.id,
        presentationOwner: "population",
        treeLifeRevision: 7
      })
    ]);
    expect(setCollectibles).toHaveBeenCalledWith(
      renderStateRef.current.collectibles
    );
  });

  it("updates Resource Vision progress without replacing presented trees", () => {
    const setCollectibles = vi.fn();
    const setResourceVision = vi.fn();
    const setResourceVisionStatus = vi.fn();
    const resourceVision = {
      flagId: "flag-1",
      flagName: "Flag",
      center: { lat: 35, lon: -106 },
      movementLeashRadiusM: 600,
      paddingM: 50,
      radiusM: 650
    };
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      localPlayerRef: { current: { currentFlagId: "flag-1" } },
      setCollectibles,
      setResourceVision,
      setResourceVisionStatus
    } as never));

    act(() => result.current({
      type: "RESOURCE_VISION_LOADING",
      serverTime: 1_000,
      resourceVision,
      status: null,
      message: "Preparing nearby world."
    } as never));
    act(() => result.current({
      type: "RESOURCE_VISION_READY",
      serverTime: 1_001,
      resourceVision,
      status: {
        state: "ready",
        message: "Nearby world ready."
      }
    } as never));

    expect(setCollectibles).not.toHaveBeenCalled();
    expect(setResourceVision).toHaveBeenNthCalledWith(1, resourceVision);
    expect(setResourceVision).toHaveBeenNthCalledWith(2, resourceVision);
    expect(setResourceVisionStatus).toHaveBeenCalledTimes(2);
  });

  it("redraws COLLECTIBLE_UPDATED in place when only resin availability changes", () => {
    const tree = collectible({
      resinAvailable: true,
      treeLifeRevision: 9
    });
    const renderStateRef = {
      current: {
        localPlayerId: "player-1",
        players: [],
        flags: [],
        cities: [],
        manors: [],
        collectibles: [tree],
        droppedItems: [],
        resourceVision: null,
        waterHighlights: [],
        selectedFlagId: null,
        selectedCityId: null,
        selectedManorId: null,
        selectedCollectibleId: tree.id,
        selectedDroppedItemId: null,
        selectedCombatEntityId: null
      }
    };
    const update = vi.fn();
    const setCollectibles = vi.fn();
    const clearOptimisticResinPresentation = vi.fn();
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      getCommands: () => ({
        cancelHarvest: vi.fn(),
        requestNearbyCollectibles: vi.fn()
      }),
      localPlayerRef: { current: null },
      renderStateRef,
      populationZoneProjectionRef: {
        current: emptyPopulationZoneProjection()
      },
      harvestTaskRef: { current: null },
      selectedCollectibleIdRef: { current: tree.id },
      surveyStartedAtRef: { current: null },
      harvestRequestSentRef: { current: null },
      pendingHarvestCancelNodeRef: { current: null },
      pendingHarvestCompletionRef: { current: null },
      inventoryDropRequestGateRef: { current: {} },
      droppedItemPickupRequestGateRef: { current: {} },
      overlayRef: { current: { update } },
      setCollectibles,
      setResourceVision: vi.fn(),
      setResourceVisionStatus: vi.fn(),
      setWaterHighlights: vi.fn(),
      setSelectedCollectibleId: vi.fn(),
      setHarvestTask: vi.fn(),
      setHarvestClockMs: vi.fn(),
      setDroppingInventoryItemKey: vi.fn(),
      setDropSelection: vi.fn(),
      setDropAmount: vi.fn(),
      setDroppedItems: vi.fn(),
      setWarning: vi.fn(),
      setHarvestStatusAnnouncement: vi.fn(),
      settleHarvestAfterAuthoritativeRemoval: vi.fn(),
      clearOptimisticResinPresentation,
      restoreOptimisticResinPresentation: vi.fn(),
      receiveInventorySnapshot: vi.fn(),
      clearDroppedItemInteraction: vi.fn(),
      attemptReadyDroppedItemPickup: vi.fn()
    } as never));

    act(() => result.current({
      type: "COLLECTIBLE_UPDATED",
      node: { ...tree, resinAvailable: false },
      playerId: "player-2",
      serverTime: 1_000
    }));

    expect(renderStateRef.current.collectibles).toEqual([{
      ...tree,
      presentationOwner: "population",
      resinAvailable: false
    }]);
    expect(renderStateRef.current.collectibles[0]).toMatchObject({
      id: tree.id,
      lat: tree.lat,
      lon: tree.lon,
      treeLifeRevision: 9
    });
    expect(setCollectibles).toHaveBeenCalledWith(
      renderStateRef.current.collectibles
    );
    expect(update).toHaveBeenCalledWith(renderStateRef.current);
    expect(clearOptimisticResinPresentation).toHaveBeenCalledWith(tree.id);
  });

  it("never upserts or removes dungeon resource nodes in the world store", () => {
    const setCollectibles = vi.fn();
    const update = vi.fn();
    const settle = vi.fn();
    const world = collectible({});
    const renderStateRef = { current: { collectibles: [world] } };
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      getCommands: () => ({ cancelHarvest: vi.fn(), requestNearbyCollectibles: vi.fn() }),
      renderStateRef,
      populationZoneProjectionRef: { current: emptyPopulationZoneProjection() },
      harvestTaskRef: { current: null },
      selectedCollectibleIdRef: { current: null },
      harvestRequestSentRef: { current: null },
      pendingHarvestCancelNodeRef: { current: null },
      pendingHarvestCompletionRef: { current: null },
      overlayRef: { current: { update } },
      setCollectibles,
      setSelectedCollectibleId: vi.fn(),
      setHarvestTask: vi.fn(),
      setHarvestStatusAnnouncement: vi.fn(),
      settleHarvestAfterAuthoritativeRemoval: settle,
      clearOptimisticResinPresentation: vi.fn(),
      receiveInventorySnapshot: vi.fn()
    } as never));
    const dungeonNode = { ...world, id: "dungeon-resource:ore-1" };

    act(() => result.current({
      type: "COLLECTIBLE_UPDATED", node: dungeonNode, playerId: "player-2", serverTime: 1
    } as never));
    act(() => result.current({
      type: "COLLECTIBLE_REMOVED", nodeId: dungeonNode.id, playerId: "player-2", serverTime: 2
    } as never));

    expect(setCollectibles).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(renderStateRef.current.collectibles).toEqual([world]);
  });

  it("atomically clears every presentation and interaction owner on removal", () => {
    const tree = collectible({ treeLifeRevision: 7 });
    const projection = emptyPopulationZoneProjection();
    const populationZoneProjectionRef = {
      current: {
        ...projection,
        entities: new Map([[
          tree.id,
          {
            entityId: tree.id,
            zoneId: "zone-1",
            generationId: "generation-1",
            kind: "tree" as const,
            archetype: "tree-default",
            position: { lat: tree.lat, lon: tree.lon },
            homePosition: { lat: tree.lat, lon: tree.lon },
            stateRevision: 7
          }
        ]])
      }
    };
    const harvestTaskRef: { current: HarvestTask | null } = {
      current: {
        nodeId: tree.id,
        action: "primary" as const,
        phase: "approaching" as const,
        sessionId: null,
        completesAtMs: null,
        startedAtMs: null,
        startRequestedAtMs: null
      }
    };
    const selectedCollectibleIdRef = { current: tree.id as string | null };
    const renderStateRef = {
      current: {
        collectibles: [tree],
        selectedCollectibleId: tree.id
      }
    };
    const update = vi.fn();
    const setCollectibles = vi.fn();
    const setSelectedCollectibleId = vi.fn();
    const clearOptimisticResinPresentation = vi.fn();
    const settleHarvestAfterAuthoritativeRemoval = vi.fn(() => {
      harvestTaskRef.current = null;
    });
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      renderStateRef,
      populationZoneProjectionRef,
      harvestTaskRef,
      selectedCollectibleIdRef,
      overlayRef: { current: { update } },
      setCollectibles,
      setSelectedCollectibleId,
      settleHarvestAfterAuthoritativeRemoval,
      clearOptimisticResinPresentation
    } as never));

    act(() => result.current({
      type: "COLLECTIBLE_REMOVED",
      nodeId: tree.id,
      playerId: "player-2",
      stateRevision: 8,
      serverTime: 1_000
    }));

    expect(settleHarvestAfterAuthoritativeRemoval).toHaveBeenCalledOnce();
    expect(harvestTaskRef.current).toBeNull();
    expect(selectedCollectibleIdRef.current).toBeNull();
    expect(renderStateRef.current).toMatchObject({
      collectibles: [],
      selectedCollectibleId: null
    });
    expect(populationZoneProjectionRef.current.entities.has(tree.id)).toBe(false);
    expect(populationZoneProjectionRef.current.collectibleTombstones.get(tree.id))
      .toBe(8);
    expect(clearOptimisticResinPresentation).toHaveBeenCalledWith(tree.id);
    expect(setSelectedCollectibleId).toHaveBeenCalledWith(null);
    expect(setCollectibles).toHaveBeenCalledWith([]);
    expect(update).toHaveBeenLastCalledWith(renderStateRef.current);
  });

  it("ignores a late start acknowledged after authoritative removal", () => {
    const tree = collectible({ treeLifeRevision: 7 });
    const harvestTaskRef: { current: HarvestTask | null } = {
      current: {
        nodeId: tree.id,
        action: "primary",
        phase: "starting",
        sessionId: null,
        completesAtMs: null,
        startedAtMs: null,
        startRequestedAtMs: 1_000
      }
    };
    const harvestRequestSentRef = {
      current: "start-before-removal" as string | null
    };
    const ignoredHarvestStartsRef = {
      current: new Map<string, string>()
    };
    const cancelHarvest = vi.fn();
    const renderStateRef = {
      current: { collectibles: [tree], selectedCollectibleId: null }
    };
    const settleHarvestAfterAuthoritativeRemoval = (nodeId: string): void => {
      const activeTask = harvestTaskRef.current;
      if (
        activeTask?.nodeId === nodeId &&
        activeTask.phase === "starting" &&
        activeTask.sessionId === null &&
        harvestRequestSentRef.current
      ) {
        ignoredHarvestStartsRef.current.set(
          harvestRequestSentRef.current,
          nodeId
        );
      }
      harvestRequestSentRef.current = null;
      harvestTaskRef.current = null;
    };
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      getCommands: () => ({
        cancelHarvest,
        requestNearbyCollectibles: vi.fn()
      }),
      harvestTaskRef,
      harvestRequestSentRef,
      pendingHarvestCancelNodeRef: { current: null },
      pendingHarvestCompletionRef: { current: null },
      ignoredHarvestStartsRef,
      renderStateRef,
      populationZoneProjectionRef: {
        current: emptyPopulationZoneProjection()
      },
      selectedCollectibleIdRef: { current: null },
      overlayRef: { current: null },
      setCollectibles: vi.fn(),
      setSelectedCollectibleId: vi.fn(),
      setHarvestTask: vi.fn(),
      settleHarvestAfterAuthoritativeRemoval,
      clearOptimisticResinPresentation: vi.fn()
    } as never));

    act(() => {
      result.current({
        type: "COLLECTIBLE_REMOVED",
        nodeId: tree.id,
        playerId: "player-2",
        stateRevision: 8,
        serverTime: 1_000
      });
      result.current({
        type: "HARVEST_STARTED",
        requestId: "start-before-removal",
        session: {
          sessionId: "late-session",
          nodeId: tree.id
        },
        serverTime: 1_001
      } as never);
    });

    expect(harvestTaskRef.current).toBeNull();
    expect(harvestRequestSentRef.current).toBeNull();
    expect(ignoredHarvestStartsRef.current.size).toBe(0);
    expect(cancelHarvest).not.toHaveBeenCalled();
  });

  it("settles completion exactly once in either removal/completion order", () => {
    for (const removalFirst of [true, false]) {
      const tree = collectible({ treeLifeRevision: 2 });
      const harvestTaskRef: { current: HarvestTask | null } = {
        current: {
          nodeId: tree.id,
          action: "primary",
          phase: "completing",
          sessionId: "session-1",
          completesAtMs: 1_000,
          startedAtMs: 0,
          startRequestedAtMs: null
        }
      };
      const harvestRequestSentRef = { current: "complete-1" as string | null };
      const pendingHarvestCompletionRef = {
        current: null as {
          sessionId: string;
          requestId: string;
          nodeId: string;
        } | null
      };
      const cancelHarvest = vi.fn();
      const receiveInventorySnapshot = vi.fn();
      const setHarvestStatusAnnouncement = vi.fn();
      const renderStateRef = {
        current: { collectibles: [tree], selectedCollectibleId: null }
      };
      const settleHarvestAfterAuthoritativeRemoval = vi.fn((nodeId: string) => {
        const task = harvestTaskRef.current;
        if (
          task?.nodeId === nodeId &&
          task.phase === "completing" &&
          task.sessionId &&
          harvestRequestSentRef.current
        ) {
          pendingHarvestCompletionRef.current = {
            sessionId: task.sessionId,
            requestId: harvestRequestSentRef.current,
            nodeId
          };
        }
        harvestTaskRef.current = null;
      });
      const { result } = renderHook(() => useHarvestingFrameHandler({
        ownPlayerId: "player-1",
        getCommands: () => ({
          cancelHarvest,
          requestNearbyCollectibles: vi.fn()
        }),
        harvestRequestSentRef,
        pendingHarvestCancelNodeRef: { current: null },
        pendingHarvestCompletionRef,
        harvestTaskRef,
        renderStateRef,
        populationZoneProjectionRef: {
          current: emptyPopulationZoneProjection()
        },
        selectedCollectibleIdRef: { current: null },
        overlayRef: { current: null },
        setCollectibles: vi.fn(),
        setSelectedCollectibleId: vi.fn(),
        setHarvestTask: vi.fn(),
        setHarvestStatusAnnouncement,
        settleHarvestAfterAuthoritativeRemoval,
        clearOptimisticResinPresentation: vi.fn(),
        receiveInventorySnapshot
      } as never));
      const removal = {
        type: "COLLECTIBLE_REMOVED",
        nodeId: tree.id,
        playerId: "player-1",
        stateRevision: 3,
        serverTime: 999
      } as const;
      const completion = {
        type: "HARVEST_COMPLETED",
        requestId: "complete-1",
        session: { sessionId: "session-1", resourceType: "wood" },
        nodeId: tree.id,
        playerId: "player-1",
        inventory: {
          playerId: "player-1",
          items: [],
          totals: emptyInventoryTotals()
        },
        node: { ...tree, state: "harvested" },
        nodeRemoved: true,
        replayed: false,
        serverTime: 1_000
      } as const;

      act(() => {
        if (removalFirst) {
          result.current(removal as never);
          result.current({
            type: "HARVEST_CANCELLED",
            requestId: "unrelated-cancel",
            session: {
              sessionId: "unrelated-session",
              nodeId: "unrelated-tree",
              resourceType: "wood"
            },
            playerId: "player-1",
            serverTime: 999
          } as never);
          result.current(completion as never);
        } else {
          result.current(completion as never);
          result.current(removal as never);
        }
      });

      expect(harvestTaskRef.current).toBeNull();
      expect(harvestRequestSentRef.current).toBeNull();
      expect(pendingHarvestCompletionRef.current).toBeNull();
      expect(renderStateRef.current.collectibles).toEqual([]);
      expect(receiveInventorySnapshot).toHaveBeenCalledOnce();
      expect(cancelHarvest).not.toHaveBeenCalled();
      expect(setHarvestStatusAnnouncement)
        .not.toHaveBeenCalledWith("Gathering canceled.");
      expect(settleHarvestAfterAuthoritativeRemoval)
        .toHaveBeenCalledTimes(removalFirst ? 1 : 0);
    }
  });

  it("immediately installs the personalized depleted timer from mining completion", () => {
    const readyAt = "2026-07-29T05:50:00.000Z";
    const harvestTaskRef: { current: HarvestTask | null } = {
      current: {
        nodeId: "mine-1",
        action: "primary",
        phase: "completing",
        sessionId: "session-1",
        completesAtMs: 2_000,
        startedAtMs: 1_000,
        startRequestedAtMs: null
      }
    };
    const harvestRequestSentRef = {
      current: "complete-1" as string | null
    };
    const pendingHarvestCompletionRef = {
      current: {
        sessionId: "session-1",
        requestId: "complete-1",
        nodeId: "mine-1",
        lastAttemptAtMs: 2_000
      }
    };
    const renderStateRef = {
      current: {
        collectibles: [],
        selectedCollectibleId: "mine-1"
      }
    };
    const setCollectibles = vi.fn();
    const receiveInventorySnapshot = vi.fn();
    const setHarvestTask = vi.fn();
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      renderStateRef,
      harvestTaskRef,
      harvestRequestSentRef,
      pendingHarvestCompletionRef,
      overlayRef: { current: null },
      setCollectibles,
      receiveInventorySnapshot,
      setHarvestTask,
      setHarvestStatusAnnouncement: vi.fn()
    } as never));

    act(() => result.current({
      type: "REPEATABLE_RESOURCE_HARVESTED",
      requestId: "complete-1",
      playerId: "player-1",
      node: {
        id: "mine-1",
        nodeType: "stone_mine",
        lat: 35,
        lon: -106,
        yieldItemId: "stone",
        yieldQuantity: 1,
        state: "depleted",
        authorityRevision: 4,
        readyAt,
        timerVisibility: "visible"
      },
      inventory: {
        playerId: "player-1",
        revision: 8,
        items: [],
        totals: emptyInventoryTotals()
      },
      replayed: false,
      serverTime: 123
    }));

    expect(renderStateRef.current.collectibles).toContainEqual(
      expect.objectContaining({
        id: "mine-1",
        state: "harvested",
        repeatableState: "depleted",
        repeatableReadyAt: readyAt,
        repeatableTimerVisibility: "visible",
        repeatableRevision: 4
      })
    );
    expect(setCollectibles).toHaveBeenCalledOnce();
    expect(receiveInventorySnapshot).toHaveBeenCalledOnce();
    expect(harvestTaskRef.current).toBeNull();
  });

  it("immediately applies broadcast harvest toll and access changes", () => {
    let collectibles: Array<Record<string, unknown>> = [{
      id: "mine-1",
      repeatableNodeType: "stone_mine",
      repeatableOwnerPlayerId: "owner-1",
      repeatableAccessMode: "private",
      repeatableAccessRevision: 0,
      repeatableTollGold: "0"
    }];
    let structures: Array<Record<string, unknown>> = [{
      structureId: "well-1",
      type: "oil_well",
      ownerPlayerId: "owner-1",
      harvestAccessMode: "private",
      harvestAccessRevision: "0"
    }];
    let well: Record<string, unknown> | null = {
      structureId: "well-1",
      ownerPlayerId: "owner-1",
      accessMode: "private",
      accessRevision: "0",
      tollGold: "0"
    };
    const setCollectibles = vi.fn((update: (current: typeof collectibles) => typeof collectibles) => {
      collectibles = update(collectibles);
    });
    const setCityStructures = vi.fn((update: (current: typeof structures) => typeof structures) => {
      structures = update(structures);
    });
    const setOilWell = vi.fn((update: (current: typeof well) => typeof well) => {
      well = update(well);
    });
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      setCollectibles,
      setCityStructures,
      setOilWell
    } as never));

    act(() => result.current({
      type: "HARVEST_ACCESS_CHANGED",
      ownerPlayerId: "owner-1",
      harvestType: "stone_mine",
      assetId: null,
      accessMode: null,
      accessRevision: null,
      tollGold: "6",
      serverTime: 1
    }));
    expect(collectibles[0]).toMatchObject({ repeatableTollGold: "6" });

    act(() => result.current({
      type: "HARVEST_ACCESS_CHANGED",
      ownerPlayerId: "owner-1",
      harvestType: "oil_well",
      assetId: "well-1",
      accessMode: "public",
      accessRevision: "1",
      tollGold: "9",
      serverTime: 2
    }));
    expect(structures[0]).toMatchObject({
      harvestAccessMode: "public",
      harvestAccessRevision: "1"
    });
    expect(well).toMatchObject({
      accessMode: "public",
      accessRevision: "1",
      tollGold: "9"
    });
  });

  it("does not let an older mining completion clear a newer mining task", () => {
    const harvestTaskRef: { current: HarvestTask | null } = {
      current: {
        nodeId: "mine-new",
        action: "primary",
        phase: "completing",
        sessionId: "session-new",
        completesAtMs: 2_000,
        startedAtMs: 1_000,
        startRequestedAtMs: null
      }
    };
    const harvestRequestSentRef = {
      current: "complete-new" as string | null
    };
    const pendingHarvestCompletionRef = {
      current: {
        sessionId: "session-new",
        requestId: "complete-new",
        nodeId: "mine-new",
        lastAttemptAtMs: 2_000
      }
    };
    const receiveInventorySnapshot = vi.fn();
    const setHarvestTask = vi.fn();
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      harvestTaskRef,
      harvestRequestSentRef,
      pendingHarvestCompletionRef,
      receiveInventorySnapshot,
      setHarvestTask
    } as never));

    act(() => result.current({
      type: "REPEATABLE_RESOURCE_HARVESTED",
      requestId: "complete-old",
      playerId: "player-1",
      node: {
        id: "mine-old",
        nodeType: "stone_mine",
        lat: 35,
        lon: -106,
        yieldItemId: "stone",
        yieldQuantity: 1,
        state: "depleted",
        authorityRevision: 4,
        readyAt: "2026-07-29T01:50:10.000Z",
        timerVisibility: "visible"
      },
      inventory: {
        playerId: "player-1",
        revision: 8,
        items: [],
        totals: emptyInventoryTotals()
      },
      replayed: false,
      serverTime: 2_001
    } as never));

    expect(harvestTaskRef.current?.sessionId).toBe("session-new");
    expect(harvestRequestSentRef.current).toBe("complete-new");
    expect(pendingHarvestCompletionRef.current.sessionId).toBe("session-new");
    expect(setHarvestTask).not.toHaveBeenCalled();
    expect(receiveInventorySnapshot).not.toHaveBeenCalled();
  });

  it("replays removal-before-completion after reconnect without canceling", () => {
    const tree = collectible({ treeLifeRevision: 2 });
    const harvestTaskRef: { current: HarvestTask | null } = {
      current: {
        nodeId: tree.id,
        action: "primary",
        phase: "completing",
        sessionId: "session-1",
        completesAtMs: 1_000,
        startedAtMs: 0,
        startRequestedAtMs: null
      }
    };
    const harvestRequestSentRef = {
      current: "complete-before-disconnect" as string | null
    };
    const pendingHarvestCompletionRef = {
      current: null as {
        sessionId: string;
        requestId: string;
        nodeId: string;
        lastAttemptAtMs: number;
      } | null
    };
    const cancelHarvest = vi.fn();
    const receiveInventorySnapshot = vi.fn();
    const renderStateRef = {
      current: { collectibles: [tree], selectedCollectibleId: null }
    };
    const settleHarvestAfterAuthoritativeRemoval = (nodeId: string): void => {
      const task = harvestTaskRef.current;
      if (
        task?.nodeId === nodeId &&
        task.phase === "completing" &&
        task.sessionId &&
        harvestRequestSentRef.current
      ) {
        pendingHarvestCompletionRef.current = {
          sessionId: task.sessionId,
          requestId: harvestRequestSentRef.current,
          nodeId,
          lastAttemptAtMs: 0
        };
      }
      harvestTaskRef.current = null;
    };
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      getCommands: () => ({
        cancelHarvest,
        requestNearbyCollectibles: vi.fn()
      }),
      harvestTaskRef,
      harvestRequestSentRef,
      pendingHarvestCancelNodeRef: { current: null },
      pendingHarvestCompletionRef,
      ignoredHarvestStartsRef: { current: new Map() },
      renderStateRef,
      populationZoneProjectionRef: {
        current: emptyPopulationZoneProjection()
      },
      selectedCollectibleIdRef: { current: null },
      overlayRef: { current: null },
      setCollectibles: vi.fn(),
      setSelectedCollectibleId: vi.fn(),
      setHarvestTask: vi.fn(),
      setHarvestStatusAnnouncement: vi.fn(),
      settleHarvestAfterAuthoritativeRemoval,
      clearOptimisticResinPresentation: vi.fn(),
      receiveInventorySnapshot
    } as never));

    act(() => result.current({
      type: "COLLECTIBLE_REMOVED",
      nodeId: tree.id,
      playerId: "player-1",
      stateRevision: 3,
      serverTime: 999
    }));
    expect(pendingHarvestCompletionRef.current).toEqual({
      sessionId: "session-1",
      requestId: "complete-before-disconnect",
      nodeId: tree.id,
      lastAttemptAtMs: 0
    });

    expect(replayPendingHarvestCompletion(
      pendingHarvestCompletionRef,
      harvestRequestSentRef,
      () => ({
        requestId: "complete-after-welcome",
        outcome: { status: "sent" }
      }),
      Date.now(),
      true
    )).toBe("sent");

    act(() => {
      result.current({
        type: "HARVEST_STARTED",
        requestId: "resume",
        session: {
          sessionId: "session-1",
          nodeId: tree.id
        },
        serverTime: 1_000
      } as never);
      result.current({
        type: "HARVEST_COMPLETED",
        requestId: "complete-after-welcome",
        session: {
          sessionId: "session-1",
          nodeId: tree.id,
          resourceType: "wood"
        },
        nodeId: tree.id,
        playerId: "player-1",
        inventory: {
          playerId: "player-1",
          items: [],
          totals: emptyInventoryTotals()
        },
        nodeRemoved: true,
        replayed: true,
        serverTime: 1_001
      } as never);
    });

    expect(harvestTaskRef.current).toBeNull();
    expect(harvestRequestSentRef.current).toBeNull();
    expect(pendingHarvestCompletionRef.current).toBeNull();
    expect(receiveInventorySnapshot).toHaveBeenCalledOnce();
    expect(cancelHarvest).not.toHaveBeenCalled();
  });
  it("waits for the exact late-start cancellation before releasing a replacement", () => {
    const source = collectible();
    const harvestTaskRef: { current: HarvestTask | null } = {
      current: {
        nodeId: source.id,
        action: "primary",
        phase: "starting",
        sessionId: null,
        completesAtMs: null,
        startedAtMs: null,
        startRequestedAtMs: 1_000
      }
    };
    const queuedHarvestReplacementRef: { current: QueuedHarvestReplacement | null } = {
      current: {
        sourceNodeId: source.id,
        sourceRequestId: "start-source",
        sourceSessionId: null,
        targetNodeId: "tree-b",
        targetAction: "primary"
      }
    };
    const cancelHarvest = vi.fn();
    const startQueuedHarvestReplacement = vi.fn();
    const setHarvestTask = vi.fn();
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      getCommands: () => ({ cancelHarvest, requestNearbyCollectibles: vi.fn() }),
      harvestTaskRef,
      harvestRequestSentRef: { current: "start-source" },
      pendingHarvestCancelNodeRef: { current: null },
      pendingHarvestCompletionRef: { current: null },
      queuedHarvestReplacementRef,
      startQueuedHarvestReplacement,
      ignoredHarvestStartsRef: { current: new Map() },
      setHarvestTask,
      setHarvestClockMs: vi.fn(),
      setHarvestStatusAnnouncement: vi.fn(),
      restoreOptimisticResinPresentation: vi.fn()
    } as never));

    act(() => result.current({
      type: "HARVEST_STARTED",
      requestId: "start-source",
      session: {
        sessionId: "session-source",
        playerId: "player-1",
        nodeId: source.id,
        resourceType: "wood",
        operationKey: "collect:source:player-1",
        status: "active",
        startedAt: new Date(1_000).toISOString(),
        completesAt: new Date(5_000).toISOString(),
        expiresAt: new Date(305_000).toISOString(),
        completedAt: null,
        cancelledAt: null
      },
      serverTime: 1_001
    } as never));
    expect(cancelHarvest).toHaveBeenCalledWith("session-source");
    expect(startQueuedHarvestReplacement).not.toHaveBeenCalled();

    act(() => result.current({
      type: "HARVEST_CANCELLED",
      requestId: "stale-cancel",
      session: { sessionId: "stale-session", nodeId: source.id, resourceType: "wood" },
      playerId: "player-1",
      serverTime: 1_002
    } as never));
    expect(startQueuedHarvestReplacement).not.toHaveBeenCalled();

    act(() => result.current({
      type: "HARVEST_CANCELLED",
      requestId: "cancel-source",
      session: { sessionId: "session-source", nodeId: source.id, resourceType: "wood" },
      playerId: "player-1",
      serverTime: 1_003
    } as never));
    expect(startQueuedHarvestReplacement).toHaveBeenCalledOnce();
    expect(startQueuedHarvestReplacement).toHaveBeenCalledWith(expect.objectContaining({
      targetNodeId: "tree-b",
      sourceSessionId: "session-source"
    }));
    expect(harvestTaskRef.current).toBeNull();
    expect(queuedHarvestReplacementRef.current).toBeNull();
  });

  it("releases a repeatable replacement only for its captured completion request", () => {
    const queued: QueuedHarvestReplacement = {
      sourceNodeId: "mine-1",
      sourceRequestId: "complete-source",
      sourceSessionId: "session-source",
      targetNodeId: "tree-b",
      targetAction: "primary"
    };
    const queuedHarvestReplacementRef = { current: queued as QueuedHarvestReplacement | null };
    const startQueuedHarvestReplacement = vi.fn();
    const receiveInventorySnapshot = vi.fn();
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      harvestTaskRef: { current: { nodeId: "mine-1", action: "primary", phase: "completing", sessionId: "session-source" } },
      harvestRequestSentRef: { current: "complete-source" },
      pendingHarvestCompletionRef: { current: { sessionId: "session-source", requestId: "complete-source", nodeId: "mine-1", lastAttemptAtMs: 2_000 } },
      queuedHarvestReplacementRef,
      startQueuedHarvestReplacement,
      renderStateRef: { current: { collectibles: [], selectedCollectibleId: null } },
      overlayRef: { current: null },
      setCollectibles: vi.fn(),
      setHarvestTask: vi.fn(),
      setHarvestStatusAnnouncement: vi.fn(),
      receiveInventorySnapshot
    } as never));
    const completion = (requestId: string) => ({
      type: "REPEATABLE_RESOURCE_HARVESTED",
      requestId,
      playerId: "player-1",
      node: {
        id: "mine-1",
        nodeType: "stone_mine",
        lat: 35,
        lon: -106,
        yieldItemId: "stone",
        yieldQuantity: 1,
        state: "depleted",
        authorityRevision: 4,
        readyAt: "2026-07-29T01:50:10.000Z",
        timerVisibility: "visible"
      },
      inventory: { playerId: "player-1", revision: 8, items: [], totals: emptyInventoryTotals() },
      replayed: false,
      serverTime: 2_001
    });

    act(() => result.current(completion("stale-same-node") as never));
    expect(startQueuedHarvestReplacement).not.toHaveBeenCalled();
    expect(queuedHarvestReplacementRef.current).toBe(queued);
    act(() => result.current(completion("complete-source") as never));
    expect(startQueuedHarvestReplacement).toHaveBeenCalledWith(queued);
    expect(receiveInventorySnapshot).toHaveBeenCalledOnce();
  });

  it("releases a replacement only at its exact completion boundary", () => {
    const source = collectible();
    const queued: QueuedHarvestReplacement = {
      sourceNodeId: source.id,
      sourceRequestId: "complete-source",
      sourceSessionId: "session-source",
      targetNodeId: "tree-b",
      targetAction: "resin"
    };
    const queuedHarvestReplacementRef = { current: queued as QueuedHarvestReplacement | null };
    const startQueuedHarvestReplacement = vi.fn();
    const receiveInventorySnapshot = vi.fn();
    const { result } = renderHook(() => useHarvestingFrameHandler({
      ownPlayerId: "player-1",
      harvestTaskRef: { current: { nodeId: source.id, action: "primary", phase: "completing", sessionId: "session-source" } },
      harvestRequestSentRef: { current: "complete-source" },
      pendingHarvestCancelNodeRef: { current: null },
      pendingHarvestCompletionRef: { current: null },
      queuedHarvestReplacementRef,
      startQueuedHarvestReplacement,
      setHarvestTask: vi.fn(),
      setHarvestStatusAnnouncement: vi.fn(),
      clearOptimisticResinPresentation: vi.fn(),
      receiveInventorySnapshot,
      renderStateRef: { current: { collectibles: [source], selectedCollectibleId: null } },
      populationZoneProjectionRef: { current: emptyPopulationZoneProjection() },
      selectedCollectibleIdRef: { current: null },
      overlayRef: { current: null },
      setCollectibles: vi.fn(),
      setSelectedCollectibleId: vi.fn(),
      settleHarvestAfterAuthoritativeRemoval: vi.fn()
    } as never));
    const completion = (requestId: string) => ({
      type: "HARVEST_COMPLETED",
      requestId,
      session: { sessionId: "session-source", resourceType: "wood" },
      nodeId: source.id,
      playerId: "player-1",
      inventory: { playerId: "player-1", items: [], totals: emptyInventoryTotals() },
      nodeRemoved: false,
      replayed: false,
      serverTime: 2_000
    });

    act(() => result.current(completion("stale-completion") as never));
    expect(startQueuedHarvestReplacement).not.toHaveBeenCalled();
    act(() => result.current(completion("complete-source") as never));
    expect(startQueuedHarvestReplacement).toHaveBeenCalledWith(queued);
    expect(receiveInventorySnapshot).toHaveBeenCalledOnce();
  });
});

function collectible(
  overrides: Partial<CollectibleNode> = {}
): CollectibleNode {
  return {
    id: "population-tree-1",
    type: "wood",
    lat: 35,
    lon: -106,
    quantity: 4,
    state: "available",
    createdAt: "",
    harvestedAt: null,
    sourceCellId: "population-v2:zone-1",
    waterKind: null,
    ...overrides
  };
}
