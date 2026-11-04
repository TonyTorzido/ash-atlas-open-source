// @vitest-environment jsdom

import type { PlayerSnapshot, ServerMessage } from "@ash-atlas/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HarvestTask } from "../../collectibles/harvest.js";
import { WorldResourcePresentationStore } from "../../collectibles/worldResourcePresentationStore.js";
import { DroppedItemPickupRequestGate } from "../../droppedItems/droppedItemModel.js";
import { InventoryStackActionRequestGate } from "../../inventory/inventoryPanelModel.js";
import { LocalMovementRequestTracker } from "../../movement/localMovementRequests.js";
import { PlayerRenderTimeline } from "../../movement/playerRenderSmoothing.js";
import { emptyPopulationZoneProjection } from "../../population/populationZoneProjection.js";
import { useSessionFrameHandler } from "./useSessionFrameHandler.js";

describe("useSessionFrameHandler presentation checkpoint", () => {
  it("accepts only the checkpoint matching the active welcomed authority", () => {
    const dispatchStartup = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      ownPlayerId: "player-1",
      dispatchStartup,
      connectionIdRef: { current: "connection-1" },
      connectionGenerationRef: { current: 2 },
      gameplayViewGenerationRef: { current: 3 },
      relocationRevisionRef: { current: 4 },
      resourceVisionRevisionRef: { current: 5 }
    } as never));
    const checkpoint = {
      type: "PRESENTATION_SNAPSHOT_COMPLETE" as const,
      connectionId: "connection-1",
      connectionGeneration: 2,
      gameplayViewGeneration: 3,
      relocationRevision: 4,
      resourceVisionRevision: 5,
      populationPreparationGeneration: 6
    };

    act(() => result.current(checkpoint));
    act(() => result.current({ ...checkpoint, connectionGeneration: 1 }));

    expect(dispatchStartup).toHaveBeenCalledOnce();
    expect(dispatchStartup).toHaveBeenCalledWith({
      type: "presentation_snapshot",
      authority: {
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 2,
        gameplayViewGeneration: 3,
        relocationRevision: 4,
        resourceVisionRevision: 5,
        populationPreparationGeneration: 6
      }
    });
  });
});

describe("useSessionFrameHandler inventory errors", () => {
  it("releases a matching Xoral ring pickup error through its request callback", () => {
    const onXoralRingDropPickupError = vi.fn(() => true);
    const showActionError = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      onXoralRingDropPickupError,
      showActionError
    } as never));
    const message = {
      type: "ERROR" as const,
      requestId: "xoral-pickup-1",
      code: "XORAL_INVENTORY_FULL",
      message: "Make room in your equipment inventory first"
    };

    act(() => result.current(message));

    expect(onXoralRingDropPickupError).toHaveBeenCalledWith(message);
    expect(showActionError).toHaveBeenCalledWith(message.message);
  });

  it("clears the exact pending inventory action and surfaces its error", () => {
    const gate = new InventoryStackActionRequestGate();
    const showActionError = vi.fn();
    const setWarning = vi.fn();
    gate.begin("request-split", "split", performance.now());
    gate.begin("request-move", "move", performance.now());
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      inventoryStackActionRequestGateRef: { current: gate },
      handleChatError: () => false,
      setWarning,
      showActionError
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "request-split",
      code: "INVENTORY_SPLIT_INVALID_QUANTITY",
      message: "Split quantity is no longer available."
    }));

    expect(gate.has("request-split")).toBe(false);
    expect(gate.has("request-move")).toBe(true);
    expect(setWarning).toHaveBeenCalledWith(
      "Split quantity is no longer available."
    );
    expect(showActionError).toHaveBeenCalledWith(
      "Split quantity is no longer available."
    );
  });
});

describe("useSessionFrameHandler dropped-item errors", () => {
  it("requests current nearby loot instead of reconnecting after a stale pickup", () => {
    const gate = new DroppedItemPickupRequestGate();
    gate.begin("drop-1");
    const requestNearbyCollectibles = vi.fn();
    const clearDroppedItemInteraction = vi.fn();
    const attemptReadyDroppedItemPickup = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      droppedItemPickupRequestGateRef: { current: gate },
      droppedItemInteractionRef: { current: null },
      localMovementRequests: new LocalMovementRequestTracker(),
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      queuedMapFlagBuild: { reject: () => false },
      clearDroppedItemInteraction,
      attemptReadyDroppedItemPickup,
      requestNearbyCollectibles,
      requestWorldResync: vi.fn(),
      setDroppedItems: vi.fn(),
      setPickupAmount: vi.fn(),
      inventoryDropRequestGateRef: { current: { finish: vi.fn() } },
      inventoryStackActionRequestGateRef: { current: { finish: vi.fn() } },
      handleChatError: () => false,
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "pickup-1",
      code: "DROPPED_ITEM_OUT_OF_RANGE",
      message: "Dropped item is no longer available here."
    }));

    expect(gate.getActiveDropId()).toBeNull();
    expect(clearDroppedItemInteraction).toHaveBeenCalledWith({
      expectedDropId: "drop-1",
      stopMovement: true
    });
    expect(requestNearbyCollectibles).toHaveBeenCalledOnce();
    expect(attemptReadyDroppedItemPickup).toHaveBeenCalledOnce();
  });
});

describe("useSessionFrameHandler movement errors", () => {
  it("soft-corrects and clears the current rejected movement request", () => {
    const localMovementRequests = new LocalMovementRequestTracker();
    localMovementRequests.record(
      "move-current",
      { lat: 35.085, lon: -106.65 },
      performance.now()
    );
    const rejectLocalAnticipation = vi.fn(() => true);
    const setQueuedMapFlagBuild = vi.fn();
    const onQueuedMapBuildMovementRejected = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests,
      playerRenderTimeline: { rejectLocalAnticipation },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      queuedMapFlagBuild: { reject: () => true },
      setQueuedMapFlagBuild,
      onQueuedMapBuildMovementRejected,
      droppedItemInteractionRef: { current: null },
      handleChatError: () => false,
      setWarning: vi.fn(),
      showBlockedFlagPlacement: vi.fn(),
      showActionError: vi.fn(),
      setHarvestTask: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "move-current",
      code: "MOVE_REJECTED",
      message: "Movement rejected."
    }));

    expect(rejectLocalAnticipation).toHaveBeenCalledOnce();
    expect(rejectLocalAnticipation).toHaveBeenCalledWith(
      "move-current",
      expect.any(Number)
    );
    expect(localMovementRequests.snapshot()).toBeNull();
    expect(setQueuedMapFlagBuild).toHaveBeenCalledWith(null);
    expect(onQueuedMapBuildMovementRejected).toHaveBeenCalledOnce();
  });
});

describe("useSessionFrameHandler city conversion errors", () => {
  it("releases the city action and surfaces an authoritative rejection", () => {
    const setCityActionBusy = vi.fn();
    const showActionError = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      handleChatError: () => false,
      handleCityWarehouseError: () => false,
      setFoundingCity: vi.fn(),
      setCityActionBusy,
      setEquipmentBusy: vi.fn(),
      setJoiningCity: vi.fn(),
      setLeavingCity: vi.fn(),
      setPendingLeaveCityId: vi.fn(),
      setWarning: vi.fn(),
      showActionError
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "convert-city-flag-1",
      code: "CITY_EXPANSION_LIMIT_REACHED",
      message: "This city has reached its expansion flag limit."
    }));

    expect(setCityActionBusy).toHaveBeenCalledWith(false);
    expect(showActionError).toHaveBeenCalledWith(
      "This city has reached its expansion flag limit."
    );
  });
});

describe("useSessionFrameHandler city construction errors", () => {
  it("surfaces a matching rejection even when its code is not CITY-prefixed", () => {
    const handleCityConstructionError = vi.fn(() => true);
    const showActionError = vi.fn();
    const message = {
      type: "ERROR" as const,
      requestId: "city-facility-1",
      code: "INVENTORY_INSUFFICIENT_ITEMS",
      message: "The City Warehouse needs 250 Wood."
    };
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      handleChatError: () => false,
      handleCityConstructionError,
      setWarning: vi.fn(),
      showActionError
    } as never));

    act(() => result.current(message));

    expect(handleCityConstructionError).toHaveBeenCalledWith(message);
    expect(showActionError).toHaveBeenCalledWith(message.message);
  });
});

describe("useSessionFrameHandler equipment upgrade errors", () => {
  it.each([
    "CITY_FACILITY_ACCESS_DENIED",
    "WALLET_INSUFFICIENT_FUNDS"
  ])("releases the exact request guard for %s", (code) => {
    const equipmentMutationRequestRef = {
      current: "equipment-upgrade-1" as string | null
    };
    const setEquipmentBusy = vi.fn();
    const onEquipmentMutationError = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef,
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      handleChatError: () => false,
      setEquipmentBusy,
      onEquipmentMutationError,
      setFoundingCity: vi.fn(),
      setCityActionBusy: vi.fn(),
      setJoiningCity: vi.fn(),
      setLeavingCity: vi.fn(),
      setPendingLeaveCityId: vi.fn(),
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "equipment-upgrade-1",
      code,
      message: "Upgrade rejected."
    }));

    expect(equipmentMutationRequestRef.current).toBeNull();
    expect(setEquipmentBusy).toHaveBeenCalledWith(false);
    expect(onEquipmentMutationError).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "equipment-upgrade-1",
      code
    }));
  });

  it("ignores a stale equipment rejection without releasing the current guard", () => {
    const equipmentMutationRequestRef = {
      current: "equipment-upgrade-new" as string | null
    };
    const onEquipmentMutationError = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef,
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      handleChatError: () => false,
      onEquipmentMutationError,
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "equipment-upgrade-old",
      code: "EQUIPMENT_STALE_LEVEL",
      message: "Stale level."
    }));

    expect(equipmentMutationRequestRef.current).toBe("equipment-upgrade-new");
    expect(onEquipmentMutationError).not.toHaveBeenCalled();
  });
});

describe("useSessionFrameHandler Giving Berry errors", () => {
  it("shows full health above the player without opening a toast", () => {
    const enqueueFloatingFeedback = vi.fn();
    const setWarning = vi.fn();
    const showActionError = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      ownPlayerId: "player-1",
      overlayRef: { current: { enqueueFloatingFeedback } },
      setWarning,
      showActionError
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "use-resin-full-health",
      code: "BALSAM_RESIN_FULL_HEALTH",
      message: "You are already at full health."
    }));

    expect(enqueueFloatingFeedback).toHaveBeenCalledWith({
      eventId: "full-health:use-resin-full-health",
      targetEntityId: "player-1",
      kind: "healing",
      amount: 1,
      label: "Full HP"
    });
    expect(setWarning).not.toHaveBeenCalled();
    expect(showActionError).not.toHaveBeenCalled();

    act(() => result.current({
      type: "ERROR",
      requestId: "heal-full-health",
      code: "ABILITY_TARGET_FULL_HEALTH",
      message: "Full HP"
    }));
    expect(enqueueFloatingFeedback).toHaveBeenLastCalledWith({
      eventId: "full-health:heal-full-health",
      targetEntityId: "player-1",
      kind: "healing",
      amount: 1,
      label: "Full HP"
    });
    expect(showActionError).not.toHaveBeenCalled();
  });

  it("shows missing resin above the player without opening a toast", () => {
    const enqueueFloatingFeedback = vi.fn();
    const setWarning = vi.fn();
    const showActionError = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      ownPlayerId: "player-1",
      overlayRef: { current: { enqueueFloatingFeedback } },
      setWarning,
      showActionError
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "use-resin-not-owned",
      code: "BALSAM_RESIN_NOT_OWNED",
      message: "You do not have any Giving Berry."
    }));

    expect(enqueueFloatingFeedback).toHaveBeenCalledWith({
      eventId: "resin-not-owned:use-resin-not-owned",
      targetEntityId: "player-1",
      kind: "resin_spent",
      amount: 1,
      label: "NO Berries",
      icon: "giving_berry"
    });
    expect(setWarning).not.toHaveBeenCalled();
    expect(showActionError).not.toHaveBeenCalled();
  });
});

describe("useSessionFrameHandler combat authority errors", () => {
  it("keeps a target while authority is preparing", () => {
    const setPopulationPreparing = vi.fn();
    const setSelectedCombatEntity = vi.fn();
    const setSelectedCombatEntityId = vi.fn();
    const requestWorldResync = vi.fn();
    const selectedCombatEntityIdRef = { current: "mob-1" as string | null };
    const { result } = renderHook(() => useSessionFrameHandler({
      selectedCombatEntityIdRef,
      setPopulationPreparing,
      setSelectedCombatEntity,
      setSelectedCombatEntityId,
      requestWorldResync,
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "attack-preparing",
      code: "WORLD_AUTHORITY_PREPARING",
      message: "Combat authority is still preparing this target.",
      retryable: true,
      details: { targetEntityId: "mob-1", gameplayViewGeneration: 5 }
    }));

    expect(setPopulationPreparing).toHaveBeenCalledWith(true);
    expect(selectedCombatEntityIdRef.current).toBe("mob-1");
    expect(setSelectedCombatEntity).not.toHaveBeenCalled();
    expect(requestWorldResync).not.toHaveBeenCalled();
  });

  it("clears only the exact removed target and requests one resync", () => {
    const setSelectedCombatEntity = vi.fn();
    const setSelectedCombatEntityId = vi.fn();
    const requestWorldResync = vi.fn();
    const selectedCombatEntityIdRef = { current: "mob-1" as string | null };
    const combatStore = {
      remove: vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValue(false)
    };
    const { result } = renderHook(() => useSessionFrameHandler({
      combatStore,
      selectedCombatEntityIdRef,
      setSelectedCombatEntity,
      setSelectedCombatEntityId,
      requestWorldResync,
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "attack-gone",
      code: "COMBAT_TARGET_NO_LONGER_AVAILABLE",
      message: "That target is no longer available.",
      details: {
        targetEntityId: "mob-1",
        relocationRevision: 7,
        gameplayViewGeneration: 5
      }
    }));
    act(() => result.current({
      type: "ERROR",
      requestId: "attack-gone-repeat",
      code: "COMBAT_TARGET_NO_LONGER_AVAILABLE",
      message: "That target is no longer available.",
      details: {
        targetEntityId: "mob-1",
        relocationRevision: 7,
        gameplayViewGeneration: 5
      }
    }));

    expect(combatStore.remove).toHaveBeenCalledTimes(2);
    expect(combatStore.remove).toHaveBeenCalledWith("mob-1");
    expect(selectedCombatEntityIdRef.current).toBeNull();
    expect(setSelectedCombatEntityId).toHaveBeenCalledWith(null);
    expect(setSelectedCombatEntity).toHaveBeenCalledWith(null);
    expect(requestWorldResync).toHaveBeenCalledOnce();
  });
});

describe("useSessionFrameHandler post-flag gathering recovery", () => {
  const approachingHarvestTask = (): HarvestTask => ({
    nodeId: "tree-after-flag",
    action: "primary",
    phase: "approaching",
    sessionId: null,
    completesAtMs: null,
    startedAtMs: null,
    startRequestedAtMs: null
  });

  it("releases the matching gathering approach when World rejects its move during arrival", () => {
    const localMovementRequests = new LocalMovementRequestTracker();
    localMovementRequests.record(
      "move-to-tree",
      { lat: 35.101, lon: -106.602 },
      1
    );
    const reset = vi.spyOn(localMovementRequests, "reset");
    const harvestTaskRef = {
      current: approachingHarvestTask() as HarvestTask | null
    };
    const requestHarvestCancellation = vi.fn((stopMovement?: boolean) => {
      expect(stopMovement).toBe(false);
      harvestTaskRef.current = null;
    });
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests,
      harvestTaskRef,
      requestHarvestCancellation,
      setPopulationPreparing: vi.fn(),
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "move-to-tree",
      code: "WORLD_AUTHORITY_PREPARING",
      message: "World authority is still preparing this area.",
      retryable: true
    }));

    expect(reset).toHaveBeenCalledOnce();
    expect(requestHarvestCancellation).toHaveBeenCalledOnce();
    expect(requestHarvestCancellation).toHaveBeenCalledWith(false);
    expect(harvestTaskRef.current).toBeNull();
  });

  it("does not let a stale World rejection cancel a newer gathering approach", () => {
    const localMovementRequests = new LocalMovementRequestTracker();
    localMovementRequests.record(
      "move-to-newer-tree",
      { lat: 35.102, lon: -106.603 },
      2
    );
    const reset = vi.spyOn(localMovementRequests, "reset");
    const newerTask = approachingHarvestTask();
    const harvestTaskRef = { current: newerTask as HarvestTask | null };
    const requestHarvestCancellation = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests,
      harvestTaskRef,
      requestHarvestCancellation,
      setPopulationPreparing: vi.fn(),
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "move-to-older-tree",
      code: "WORLD_AUTHORITY_PREPARING",
      message: "World authority is still preparing this area.",
      retryable: true
    }));

    expect(reset).not.toHaveBeenCalled();
    expect(requestHarvestCancellation).not.toHaveBeenCalled();
    expect(localMovementRequests.snapshot()?.requestId)
      .toBe("move-to-newer-tree");
    expect(harvestTaskRef.current).toBe(newerTask);
  });
});

describe("useSessionFrameHandler actionable gameplay errors", () => {
  it("shows the sender when a party invite target already belongs to a party", () => {
    const showActionError = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      inventoryStackActionRequestGateRef: { current: { finish: () => null } },
      handleChatError: () => false,
      setWarning: vi.fn(),
      showActionError
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "invite-player-2",
      code: "PLAYER_ALREADY_IN_PARTY",
      message: "Player already belongs to a party"
    }));

    expect(showActionError).toHaveBeenCalledWith(
      "Player already belongs to a party"
    );
  });

  it("does not surface a passive world-transition collision as an action error", () => {
    const showActionError = vi.fn();
    const setClassBusy = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      classBusy: false,
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      inventoryStackActionRequestGateRef: { current: { finish: () => null } },
      handleChatError: () => false,
      setClassBusy,
      setWarning: vi.fn(),
      showActionError
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "background-refresh",
      code: "PLAYER_WORLD_TRANSITION_PENDING",
      message: "This operation cannot run during a player world transition"
    }));

    expect(showActionError).not.toHaveBeenCalled();
    expect(setClassBusy).not.toHaveBeenCalled();
  });

  it("surfaces a rejected flag placement", () => {
    const showActionError = vi.fn();
    const showBlockedFlagPlacement = vi.fn();
    const setWarning = vi.fn();
    const completeValidation = vi.fn();
    const completeIntent = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: {
        current: { pending: () => null, complete: completeValidation }
      },
      flagBuildIntentRef: { current: { complete: completeIntent } },
      teleportRequestRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      handleChatError: () => false,
      setFlagBuildQueued: vi.fn(),
      setWarning,
      showActionError,
      showBlockedFlagPlacement
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "flag-build-1",
      code: "FLAG_BUILD_REJECTED",
      message: "There are not enough materials to build this flag."
    }));

    expect(completeValidation).toHaveBeenCalledWith("flag-build-1");
    expect(completeIntent).toHaveBeenCalled();
    expect(setWarning).toHaveBeenCalledWith(null);
    expect(showBlockedFlagPlacement).toHaveBeenCalledWith(
      "There are not enough materials to build this flag."
    );
    expect(showActionError).not.toHaveBeenCalled();
  });

  it("marks canonical river rejection as blocked water placement", () => {
    const setFlagPlacementTerrain = vi.fn();
    const showBlockedFlagPlacement = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: { complete: vi.fn() } },
      teleportRequestRef: { current: null },
      inventoryStackActionRequestGateRef: { current: { finish: () => null } },
      handleChatError: () => false,
      setFlagBuildQueued: vi.fn(),
      setFlagPlacementTerrain,
      setWarning: vi.fn(),
      showActionError: vi.fn(),
      showBlockedFlagPlacement
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "flag-build-river",
      code: "FLAG_BUILD_REJECTED",
      message: "Cannot build on river water."
    }));

    expect(setFlagPlacementTerrain).toHaveBeenCalledWith("water");
    expect(showBlockedFlagPlacement).toHaveBeenCalledWith(
      "Cannot build on river water."
    );
  });

  it("shows the compact blocked icon for a territory race rejection", () => {
    const showActionError = vi.fn();
    const showBlockedFlagPlacement = vi.fn();
    const setWarning = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: { complete: vi.fn() } },
      teleportRequestRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      handleChatError: () => false,
      setFlagBuildQueued: vi.fn(),
      setWarning,
      showActionError,
      showBlockedFlagPlacement
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "flag-build-claimed",
      code: "FLAG_PLACEMENT_REJECTED",
      message: "Cannot build here: inside another player's claimed territory"
    }));

    expect(showBlockedFlagPlacement).toHaveBeenCalledOnce();
    expect(showBlockedFlagPlacement).toHaveBeenCalledWith(
      "Cannot build here: inside another player's claimed territory"
    );
    expect(setWarning).toHaveBeenCalledWith(null);
    expect(showActionError).not.toHaveBeenCalled();
  });

  it("surfaces a rejection for the active travel request", () => {
    const showActionError = vi.fn();
    const observeWorldMapTravelError = vi.fn();
    const setWarning = vi.fn();
    const discardBoundTo = vi.fn();
    const pendingTravelRequestIdRef = { current: "travel-1" };
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: {
        snapshot: () => null,
        discardBoundTo
      },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef,
      setFlagAccessRevision: vi.fn(),
      setAggressiveFallbackUntilMs: vi.fn(),
      observeWorldMapTravelError,
      setWarning,
      showActionError
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "travel-1",
      code: "TRAVEL_FAILED",
      message: "Travel failed because the destination changed."
    }));

    expect(discardBoundTo).toHaveBeenCalledWith("travel-1");
    expect(pendingTravelRequestIdRef.current).toBeNull();
    expect(setWarning).toHaveBeenCalledWith(
      "Travel failed because the destination changed."
    );
    expect(showActionError).toHaveBeenCalledWith(
      "Travel failed because the destination changed."
    );
    expect(observeWorldMapTravelError).toHaveBeenCalledWith({
      type: "ERROR",
      requestId: "travel-1",
      code: "TRAVEL_FAILED",
      message: "Travel failed because the destination changed."
    });
  });

  it("re-arms a retryable passive preparation without clearing committed travel", () => {
    const pendingTravelRequestIdRef = { current: "travel-1" as string | null };
    const visiblePreparationRef = {
      current: "preparation-1" as string | null
    };
    let preparationRevision = 0;
    const onRetryableFlagTravelPrecommit = vi.fn((requestId: string) => {
      if (visiblePreparationRef.current !== requestId) return false;
      visiblePreparationRef.current = null;
      preparationRevision += 1;
      return true;
    });
    const discardBoundTo = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: {
        snapshot: () => null,
        discardBoundTo
      },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef,
      onRetryableFlagTravelPrecommit,
      setFlagAccessRevision: vi.fn(),
      setAggressiveFallbackUntilMs: vi.fn(),
      observeWorldMapTravelError: vi.fn(),
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "preparation-1",
      code: "VISIBLE_FLAG_RESOURCE_VISION_STALE",
      message: "The resource view changed."
    }));

    expect(onRetryableFlagTravelPrecommit)
      .toHaveBeenCalledWith("preparation-1");
    expect(visiblePreparationRef.current).toBeNull();
    expect(preparationRevision).toBe(1);
    expect(pendingTravelRequestIdRef.current).toBe("travel-1");
    expect(discardBoundTo).not.toHaveBeenCalled();
  });

  it("silently replaces a committed visit after one retryable resource race", () => {
    const showActionError = vi.fn();
    const setWarning = vi.fn();
    const discardBoundTo = vi.fn();
    const pendingTravelRequestIdRef = { current: "travel-1" as string | null };
    const onRetryableFlagTravelCommit = vi.fn(() => {
      pendingTravelRequestIdRef.current = "travel-2";
      return true;
    });
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: {
        snapshot: () => null,
        discardBoundTo
      },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef,
      onRetryableFlagTravelCommit,
      setFlagAccessRevision: vi.fn(),
      setAggressiveFallbackUntilMs: vi.fn(),
      observeWorldMapTravelError: vi.fn(),
      setWarning,
      showActionError
    } as never));

    const message = {
      type: "ERROR" as const,
      requestId: "travel-1",
      code: "VISIBLE_FLAG_RESOURCE_VISION_STALE",
      message: "The map updated before travel completed.",
      retryable: true,
      details: {
        relocationRevision: 3,
        resourceVisionRevision: 8,
        gameplayViewGeneration: 12
      }
    };
    act(() => result.current(message));

    expect(discardBoundTo).toHaveBeenCalledWith("travel-1");
    expect(onRetryableFlagTravelCommit).toHaveBeenCalledWith(message);
    expect(pendingTravelRequestIdRef.current).toBe("travel-2");
    expect(setWarning).toHaveBeenCalledWith(null);
    expect(showActionError).not.toHaveBeenCalled();
  });

  it("surfaces one concise error when the bounded resource retry is unavailable", () => {
    const showActionError = vi.fn();
    const setWarning = vi.fn();
    const pendingTravelRequestIdRef = { current: "travel-2" as string | null };
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: {
        snapshot: () => null,
        discardBoundTo: vi.fn()
      },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef,
      onRetryableFlagTravelCommit: vi.fn(() => false),
      onRetryableFlagTravelPrecommit: vi.fn(() => false),
      setFlagAccessRevision: vi.fn(),
      setAggressiveFallbackUntilMs: vi.fn(),
      observeWorldMapTravelError: vi.fn(),
      setWarning,
      showActionError
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "travel-2",
      code: "VISIBLE_FLAG_RESOURCE_VISION_STALE",
      message: "The map updated before travel completed.",
      retryable: true,
      details: { resourceVisionRevision: 9 }
    }));

    expect(pendingTravelRequestIdRef.current).toBeNull();
    expect(setWarning).toHaveBeenCalledWith(
      "The map updated before travel completed."
    );
    expect(showActionError).toHaveBeenCalledWith(
      "The map updated before travel completed."
    );
  });

  it("surfaces legacy flag-set staleness without retrying the committed visit", () => {
    const showActionError = vi.fn();
    const setWarning = vi.fn();
    const discardBoundTo = vi.fn();
    const requestWorldResync = vi.fn();
    const onRetryableFlagTravelCommit = vi.fn(() => false);
    const onRetryableFlagTravelPrecommit = vi.fn(() => false);
    const pendingTravelRequestIdRef = { current: "travel-1" as string | null };
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: {
        snapshot: () => null,
        discardBoundTo
      },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef,
      onRetryableFlagTravelCommit,
      onRetryableFlagTravelPrecommit,
      requestWorldResync,
      setFlagAccessRevision: vi.fn(),
      setAggressiveFallbackUntilMs: vi.fn(),
      observeWorldMapTravelError: vi.fn(),
      setWarning,
      showActionError
    } as never));

    const message = {
      type: "ERROR" as const,
      requestId: "travel-1",
      code: "VISIBLE_FLAG_SET_STALE",
      message: "The visible flag set changed. Select the flag again."
    };
    act(() => result.current(message));

    expect(onRetryableFlagTravelPrecommit).toHaveBeenCalledOnce();
    expect(onRetryableFlagTravelPrecommit).toHaveBeenCalledWith("travel-1");
    expect(discardBoundTo).toHaveBeenCalledWith("travel-1");
    expect(pendingTravelRequestIdRef.current).toBeNull();
    expect(requestWorldResync).not.toHaveBeenCalled();
    expect(onRetryableFlagTravelCommit).not.toHaveBeenCalled();
    expect(setWarning).toHaveBeenCalledWith(message.message);
    expect(showActionError).toHaveBeenCalledWith(message.message);
  });

  it("does not let an old passive error clear a newer preparation", () => {
    const visiblePreparationRef = {
      current: "preparation-b" as string | null
    };
    let preparationRevision = 0;
    const onRetryableFlagTravelPrecommit = vi.fn((requestId: string) => {
      if (visiblePreparationRef.current !== requestId) return false;
      visiblePreparationRef.current = null;
      preparationRevision += 1;
      return true;
    });
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: {
        snapshot: () => null,
        discardBoundTo: vi.fn()
      },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      onRetryableFlagTravelPrecommit,
      setFlagAccessRevision: vi.fn(),
      setAggressiveFallbackUntilMs: vi.fn(),
      observeWorldMapTravelError: vi.fn(),
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "preparation-a",
      code: "VISIBLE_FLAG_SET_STALE",
      message: "The visible flag set changed."
    }));

    expect(onRetryableFlagTravelPrecommit)
      .toHaveBeenCalledWith("preparation-a");
    expect(visiblePreparationRef.current).toBe("preparation-b");
    expect(preparationRevision).toBe(0);
  });
});

describe("useSessionFrameHandler harvest reconnect recovery", () => {
  it("requests pending completion replay after every welcomed reconnect", () => {
    const replayPendingHarvestCompletion = vi.fn();
    const dispatchStartup = vi.fn();
    const configureLocalPlayer = vi.fn();
    const setFlagBuildRecipe = vi.fn();
    const setBuoyBuildRecipe = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      hasCompletedBootstrapRef: { current: true },
      worldAuthorityWelcomeMarkerRef: { current: null },
      dispatchStartup,
      onMarketReady: vi.fn(),
      playerRenderTimeline: { configureLocalPlayer },
      relocationRevisionRef: { current: 0 },
      resourceVisionRevisionRef: { current: 0 },
      lastWorldResyncRequestAtRef: { current: 5 },
      pendingWorldResyncReasonRef: { current: "reconnect" },
      setFlagClaimRadiusM: vi.fn(),
      setFlagBuildRecipe,
      setBuoyBuildRecipe,
      onDirectMessageWelcome: vi.fn(),
      setWarning: vi.fn(),
      setDeveloperCapabilities: vi.fn(),
      replayPendingHarvestCompletion
    } as never));

    act(() => result.current({
      type: "WELCOME",
      playerId: "player-1",
      username: "Ash",
      spawn: { lat: 35.0844, lon: -106.6504 },
      anchor: { lat: 35.0844, lon: -106.6504 },
      moveLeashRadiusM: 900,
      flagClaimRadiusM: 150,
      flagBuildRecipe: [
        { itemId: "wood", quantity: 3 },
        { itemId: "leather", quantity: 2 }
      ],
      playerSpeedMps: 3,
      serverTickHz: 20,
      regionCode: "NM",
      zoneId: "zone-1",
      developerCapabilities: [],
      serverTime: 1
    } as never));

    expect(dispatchStartup).toHaveBeenCalledWith({ type: "welcome" });
    expect(configureLocalPlayer).toHaveBeenCalledWith("player-1", {
      speedMps: 3,
      serverTickHz: 20
    });
    expect(setFlagBuildRecipe).toHaveBeenCalledWith([
      { itemId: "wood", quantity: 3 },
      { itemId: "leather", quantity: 2 }
    ]);
    expect(setBuoyBuildRecipe).toHaveBeenCalledWith([]);
    expect(replayPendingHarvestCompletion).toHaveBeenCalledOnce();
  });
});

describe("useSessionFrameHandler world authority epochs", () => {
  it("clears revision 11 so a new epoch can accept revision 1", () => {
    const playerRenderTimeline = new PlayerRenderTimeline();
    playerRenderTimeline.configureLocalPlayer("player-1", {
      speedMps: 3,
      serverTickHz: 20
    });
    playerRenderTimeline.applySnapshot([renderPlayer(11, 35, -106)], 11_000, 11_000);
    expect(playerRenderTimeline.snapPlayer(
      renderPlayer(1, 35.01, -106.01),
      12_000,
      12_000
    )).toBe(false);

    const localMovementRequests = new LocalMovementRequestTracker();
    const resetMovement = vi.spyOn(localMovementRequests, "reset");
    const onWorldAuthorityReset = vi.fn();
    const playerDeltaSequenceRef = { current: 28 };
    const { result } = renderHook(() => useSessionFrameHandler({
      ownPlayerId: "player-1",
      hasCompletedBootstrapRef: { current: true },
      worldAuthorityWelcomeMarkerRef: { current: {
        playerId: "player-1",
        epoch: "epoch-old",
        relocationRevision: 11,
        resourceVisionRevision: 7,
        gameplayViewGeneration: 5
      } },
      onWorldAuthorityReset,
      dispatchStartup: vi.fn(),
      onMarketReady: vi.fn(),
      combatStore: { clear: vi.fn() },
      overlayRef: { current: null },
      playerRenderTimeline,
      localMovementRequests,
      playerDeltaSequenceRef,
      relocationRevisionRef: { current: 11 },
      resourceVisionRevisionRef: { current: 7 },
      gameplayViewGenerationRef: { current: 5 },
      populationZoneProjectionRef: { current: emptyPopulationZoneProjection() },
      lastWorldResyncRequestAtRef: { current: 5 },
      pendingWorldResyncReasonRef: { current: "reconnect" },
      setPopulationPreparing: vi.fn(),
      setFlagClaimRadiusM: vi.fn(),
      setFlagBuildRecipe: vi.fn(),
      setBuoyBuildRecipe: vi.fn(),
      onDirectMessageWelcome: vi.fn(),
      setWarning: vi.fn(),
      setDeveloperCapabilities: vi.fn(),
      replayPendingHarvestCompletion: vi.fn()
    } as never));

    act(() => result.current(worldAuthorityWelcome("epoch-new", 0)));

    expect(playerDeltaSequenceRef.current).toBe(0);
    expect(resetMovement).toHaveBeenCalledOnce();
    expect(onWorldAuthorityReset).toHaveBeenCalledWith(
      "epoch-changed",
      expect.objectContaining({ worldAuthorityEpoch: "epoch-new" })
    );
    expect(playerRenderTimeline.snapPlayer(
      renderPlayer(1, 35.01, -106.01),
      12_000,
      12_000
    )).toBe(true);
  });

  it("preserves the render timeline on a same-epoch reconnect", () => {
    const clear = vi.fn();
    const onWorldAuthorityReset = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      hasCompletedBootstrapRef: { current: true },
      worldAuthorityWelcomeMarkerRef: { current: {
        playerId: "player-1",
        epoch: "epoch-a",
        relocationRevision: 11,
        resourceVisionRevision: 7,
        gameplayViewGeneration: 5
      } },
      onWorldAuthorityReset,
      dispatchStartup: vi.fn(),
      onMarketReady: vi.fn(),
      playerRenderTimeline: { clear, configureLocalPlayer: vi.fn() },
      relocationRevisionRef: { current: 11 },
      resourceVisionRevisionRef: { current: 7 },
      gameplayViewGenerationRef: { current: 5 },
      lastWorldResyncRequestAtRef: { current: 5 },
      pendingWorldResyncReasonRef: { current: "reconnect" },
      setFlagClaimRadiusM: vi.fn(),
      setFlagBuildRecipe: vi.fn(),
      setBuoyBuildRecipe: vi.fn(),
      onDirectMessageWelcome: vi.fn(),
      setWarning: vi.fn(),
      setDeveloperCapabilities: vi.fn(),
      replayPendingHarvestCompletion: vi.fn()
    } as never));

    act(() => result.current(worldAuthorityWelcome("epoch-a", 11, 7, 5)));

    expect(clear).not.toHaveBeenCalled();
    expect(onWorldAuthorityReset).not.toHaveBeenCalled();
  });
});

describe("useSessionFrameHandler harvest reconciliation", () => {
  it("atomically removes an authoritative ghost node for the exact rejected request", () => {
    const node = { id: "tree:gone" };
    const presentationStore = new WorldResourcePresentationStore([
      {
        ...node,
        type: "wood",
        lat: 35,
        lon: -106,
        quantity: 4,
        state: "available",
        createdAt: "",
        harvestedAt: null,
        sourceCellId: "population-v2:zone-a",
        waterKind: null,
        presentationOwner: "population",
        treeLifeRevision: 4
      }
    ]);
    const renderStateRef = {
      current: { collectibles: [node] }
    };
    const projection = emptyPopulationZoneProjection();
    const populationZoneProjectionRef = { current: projection };
    const harvestRequestSentRef = { current: "harvest-request-1" as string | null };
    const harvestTaskRef: {
      current: { nodeId: string; phase: string } | null;
    } = {
      current: { nodeId: "tree:gone", phase: "harvesting" }
    };
    const selectedCollectibleIdRef = { current: "tree:gone" as string | null };
    const setCollectibles = vi.fn();
    const setSelectedCollectibleId = vi.fn();
    const setHarvestTask = vi.fn();
    const update = vi.fn();
    const requestNearbyCollectibles = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      handleChatError: () => false,
      harvestRequestSentRef,
      pendingHarvestCancelNodeRef: { current: null },
      pendingHarvestCompletionRef: { current: null },
      harvestTaskRef,
      selectedCollectibleIdRef,
      renderStateRef,
      presentationStoreRef: { current: presentationStore },
      populationZoneProjectionRef,
      overlayRef: { current: { update } },
      setCollectibles,
      setSelectedCollectibleId,
      setHarvestTask,
      restoreOptimisticResinPresentation: vi.fn(),
      clearOptimisticResinPresentation: vi.fn(),
      requestHarvestCancellation: () => {
        harvestTaskRef.current = null;
      },
      settleHarvestAfterAuthoritativeRemoval: () => {
        harvestTaskRef.current = null;
      },
      requestNearbyCollectibles,
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "harvest-request-1",
      code: "HARVEST_NODE_ALREADY_HARVESTED",
      message: "This resource has already been harvested.",
      details: {
        nodeId: "tree:gone",
        stateRevision: 4,
        reconciliation: "remove-node"
      }
    }));

    expect(renderStateRef.current.collectibles).toEqual([]);
    expect(setCollectibles).toHaveBeenCalledWith([]);
    expect(selectedCollectibleIdRef.current).toBeNull();
    expect(setSelectedCollectibleId).toHaveBeenCalledWith(null);
    expect(populationZoneProjectionRef.current.collectibleTombstones.get("tree:gone"))
      .toBe(4);
    expect(update).toHaveBeenCalledOnce();
    expect(requestNearbyCollectibles).toHaveBeenCalledOnce();
    expect(harvestRequestSentRef.current).toBeNull();
    expect(harvestTaskRef.current).toBeNull();
  });

  it("keeps a too-far node while releasing the exact request for movement and retry", () => {
    const node = { id: "tree:far" };
    const renderStateRef = { current: { collectibles: [node] } };
    const harvestRequestSentRef = { current: "harvest-request-far" as string | null };
    const harvestTaskRef: {
      current: { nodeId: string; phase: string } | null;
    } = {
      current: { nodeId: "tree:far", phase: "harvesting" }
    };
    const setCollectibles = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      handleChatError: () => false,
      harvestRequestSentRef,
      pendingHarvestCancelNodeRef: { current: null },
      pendingHarvestCompletionRef: { current: null },
      harvestTaskRef,
      renderStateRef,
      populationZoneProjectionRef: {
        current: emptyPopulationZoneProjection()
      },
      setCollectibles,
      setHarvestTask: vi.fn(),
      restoreOptimisticResinPresentation: vi.fn(),
      clearOptimisticResinPresentation: vi.fn(),
      requestHarvestCancellation: () => {
        harvestTaskRef.current = null;
      },
      settleHarvestAfterAuthoritativeRemoval: () => undefined,
      requestNearbyCollectibles: vi.fn(),
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "harvest-request-far",
      code: "HARVEST_TOO_FAR",
      message: "Move closer to this resource (80m away).",
      details: {
        nodeId: "tree:far",
        authoritativeDistanceM: 80,
        maximumDistanceM: 50,
        reconciliation: "refresh-node"
      }
    }));

    expect(renderStateRef.current.collectibles).toEqual([node]);
    expect(setCollectibles).not.toHaveBeenCalled();
    expect(harvestRequestSentRef.current).toBeNull();
    expect(harvestTaskRef.current).toBeNull();
  });

  it("clears only the matching terminal completion and preserves a newer harvest task", () => {
    const newerTask = {
      nodeId: "mine-new",
      action: "primary" as const,
      phase: "harvesting" as const,
      sessionId: "session-new",
      startedAtMs: 1,
      completesAtMs: 10_000
    };
    const harvestTaskRef = { current: newerTask };
    const pendingHarvestCompletionRef = {
      current: {
        requestId: "complete-old",
        sessionId: "session-old",
        nodeId: "mine-old"
      }
    };
    const harvestRequestSentRef = {
      current: "start-new" as string | null
    };
    const setHarvestTask = vi.fn();
    const requestNearbyCollectibles = vi.fn();
    const showActionError = vi.fn();
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      handleChatError: () => false,
      harvestRequestSentRef,
      pendingHarvestCancelNodeRef: { current: null },
      pendingHarvestCompletionRef,
      harvestTaskRef,
      restoreOptimisticResinPresentation: vi.fn(),
      requestNearbyCollectibles,
      setHarvestTask,
      setWarning: vi.fn(),
      showActionError
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "complete-old",
      code: "HARVEST_NODE_CHANGED",
      message: "The stone mine changed before mining completed.",
      details: {
        nodeId: "mine-old",
        sessionId: "session-old",
        sessionStatusBeforeCleanup: "active",
        sessionStatusAfterCleanup: "cancelled",
        terminalCleanupOutcome: "cancelled",
        reconciliation: "refresh-node"
      }
    }));

    expect(pendingHarvestCompletionRef.current).toBeNull();
    expect(harvestTaskRef.current).toBe(newerTask);
    expect(harvestRequestSentRef.current).toBe("start-new");
    expect(setHarvestTask).not.toHaveBeenCalled();
    expect(requestNearbyCollectibles).toHaveBeenCalledOnce();
    expect(showActionError).toHaveBeenCalledWith(
      "The stone mine changed before mining completed."
    );
  });

  it("restores too-early completion to one authoritative delayed retry", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
      const completingTask = {
        nodeId: "mine-early",
        action: "primary" as const,
        phase: "completing" as const,
        sessionId: "session-early",
        startedAtMs: Date.now() - 10_000,
        completesAtMs: Date.now()
      };
      const harvestTaskRef = { current: completingTask };
      const harvestRequestSentRef = {
        current: "complete-early" as string | null
      };
      const setHarvestTask = vi.fn();
      const { result } = renderHook(() => useSessionFrameHandler({
        localMovementRequests: { snapshot: () => null },
        postArrivalTravelRequestIdRef: { current: null },
        postArrivalTravelRequestExpiresAtRef: { current: 0 },
        pendingTravelRequestIdRef: { current: null },
        inventoryStackActionRequestGateRef: {
          current: { finish: () => null }
        },
        equipmentMutationRequestRef: { current: null },
        pendingKitActivationRef: { current: null },
        flagPlacementValidationGateRef: { current: null },
        flagBuildIntentRef: { current: null },
        teleportRequestRef: { current: null },
        handleChatError: () => false,
        harvestRequestSentRef,
        pendingHarvestCancelNodeRef: { current: null },
        pendingHarvestCompletionRef: { current: null },
        harvestTaskRef,
        restoreOptimisticResinPresentation: vi.fn(),
        requestNearbyCollectibles: vi.fn(),
        setHarvestTask,
        setWarning: vi.fn(),
        showActionError: vi.fn()
      } as never));

      act(() => result.current({
        type: "ERROR",
        requestId: "complete-early",
        code: "HARVEST_TOO_EARLY",
        message: "Mining is not complete yet",
        details: {
          sessionId: "session-early",
          retryAfterMs: 750
        }
      }));

      expect(harvestTaskRef.current).toMatchObject({
        phase: "harvesting",
        sessionId: "session-early",
        completesAtMs: Date.now() + 750
      });
      expect(harvestRequestSentRef.current).toBeNull();
      expect(setHarvestTask).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an internal mining failure for one bounded retry", () => {
    const completingTask = {
      nodeId: "mine-internal",
      action: "primary" as const,
      phase: "completing" as const,
      sessionId: "session-internal",
      startedAtMs: 1,
      completesAtMs: 10
    };
    const harvestTaskRef = { current: completingTask };
    const harvestRequestSentRef = {
      current: "complete-internal" as string | null
    };
    const setHarvestTask = vi.fn();
    const requestHarvestCancellation = vi.fn();
    const pendingHarvestCompletionRef = {
      current: {
        sessionId: "session-internal",
        requestId: "complete-internal" as string | null,
        nodeId: "mine-internal",
        lastAttemptAtMs: 1
      }
    };
    const { result } = renderHook(() => useSessionFrameHandler({
      localMovementRequests: { snapshot: () => null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      pendingTravelRequestIdRef: { current: null },
      inventoryStackActionRequestGateRef: {
        current: { finish: () => null }
      },
      equipmentMutationRequestRef: { current: null },
      pendingKitActivationRef: { current: null },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      teleportRequestRef: { current: null },
      handleChatError: () => false,
      harvestRequestSentRef,
      pendingHarvestCancelNodeRef: { current: null },
      pendingHarvestCompletionRef,
      harvestTaskRef,
      restoreOptimisticResinPresentation: vi.fn(),
      requestNearbyCollectibles: vi.fn(),
      requestHarvestCancellation,
      setHarvestTask,
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "ERROR",
      requestId: "complete-internal",
      code: "HARVEST_INTERNAL_FAILURE",
      message: "Mining could not be completed.",
      details: {
        sessionId: "session-internal"
      }
    }));

    expect(harvestTaskRef.current).toMatchObject({
      phase: "harvesting",
      sessionId: "session-internal",
      completesAtMs: expect.any(Number)
    });
    expect(harvestRequestSentRef.current).toBeNull();
    expect(pendingHarvestCompletionRef.current.requestId).toBeNull();
    expect(setHarvestTask).toHaveBeenCalledOnce();
    expect(requestHarvestCancellation).not.toHaveBeenCalled();
  });
});

function worldAuthorityWelcome(
  epoch: string,
  relocationRevision: number,
  resourceVisionRevision = 0,
  gameplayViewGeneration = 0
): Extract<ServerMessage, { type: "WELCOME" }> {
  return {
    type: "WELCOME",
    playerId: "player-1",
    username: "Ash",
    spawn: { lat: 35.0844, lon: -106.6504 },
    anchor: { lat: 35.0844, lon: -106.6504 },
    moveLeashRadiusM: 900,
    flagClaimRadiusM: 150,
    playerSpeedMps: 3,
    serverTickHz: 20,
    regionCode: "NM",
    zoneId: "zone-1",
    worldAuthorityEpoch: epoch,
    relocationRevision,
    resourceVisionRevision,
    gameplayViewGeneration,
    developerCapabilities: [],
    serverTime: 1
  };
}

function renderPlayer(
  relocationRevision: number,
  lat: number,
  lon: number
): PlayerSnapshot {
  return {
    playerId: "player-1",
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "NM",
    zoneId: "zone-1",
    lat,
    lon,
    anchorLat: lat,
    anchorLon: lon,
    moveLeashRadiusM: 900,
    movementRevision: relocationRevision,
    relocationRevision,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-08-13T00:00:00.000Z"
  };
}
