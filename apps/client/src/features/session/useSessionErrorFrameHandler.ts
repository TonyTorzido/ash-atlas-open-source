import { useCallback } from "react";

import {
  classMutationErrorUiEffect,
  equipmentMutationRequestAfterClassError
} from "../../classMutationErrorUi.js";
import { clampDroppedItemPickupQuantity } from "../../droppedItems/droppedItemModel.js";
import { formatServerWarning } from "../../flags/flagFrameUtilities.js";
import { flagTravelErrorEffect } from "../../flags/flagTravelErrors.js";
import { clearPostArrivalTravelBinding } from "../../movement/localMovementRequests.js";
import { recordMovementTrace } from "../../movement/movementDebugTrace.js";
import { isStaleLocalMoveRejection } from "../../movement/playerMessageHandling.js";
import { perfRecorder } from "../../perf/perfRecorder.js";
import { gameplayLatencyTrace } from "../../diagnostics/gameplayLatencyTrace.js";
import {
  type HarvestTask
} from "../../collectibles/harvest.js";
import { removeCollectiblesFromPresentation } from "../../collectibles/collectibleReconciliation.js";
import type {
  ErrorMessage,
  SessionFrameHandlerOptions
} from "./sessionFrameHandlerContracts.js";
import { handleHarvestCompletionError } from "../harvesting/handleHarvestCompletionError.js";

export function useSessionErrorFrameHandler(
  options: SessionFrameHandlerOptions
) {
  const {
    ownPlayerId,
    combatStore,
    overlayRef,
    playerRenderTimeline,
    localMovementRequests,
    populationZoneProjectionRef,
    selectedCombatEntityIdRef,
    setPopulationPreparing,
    setAggressiveFallbackUntilMs,
    setSelectedCombatEntity,
    setSelectedCombatEntityId,
    setWarning,
    pendingTravelRequestIdRef,
    onRetryableFlagTravelPrecommit,
    onRetryableFlagTravelCommit,
    postArrivalTravelRequestIdRef,
    postArrivalTravelRequestExpiresAtRef,
    setFlagAccessRevision,
    equipmentMutationRequestRef,
    pendingKitActivationRef,
    setPendingKitActivation,
    setEquipmentBusy,
    flagPlacementValidationGateRef,
    flagBuildIntentRef,
    setFlagBuildQueued,
    setFlagPlacementTerrain,
    showBlockedFlagPlacement,
    handleChatError,
    setFoundingCity,
    setCityActionBusy,
    setJoiningCity,
    setLeavingCity,
    setPendingLeaveCityId,
    requestKingdomState,
    teleportRequestRef,
    setTeleportMode,
    inventoryDropRequestGateRef,
    inventoryStackActionRequestGateRef,
    setDroppingInventoryItemKey,
    classBusy,
    setClassBusy,
    setDevSubclassPending,
    setDevProgressionPendingType,
    setDevProgressionError,
    setDevGrantBusy,
    setDevGrantFeedback,
    droppedItemPickupRequestGateRef,
    setDroppedItems,
    setPickupAmount,
    harvestRequestSentRef,
    pendingHarvestCompletionRef,
    renderStateRef,
    presentationStoreRef,
    selectedCollectibleIdRef,
    setCollectibles,
    setSelectedCollectibleId,
    pendingHarvestCancelNodeRef,
    queuedHarvestReplacementRef,
    harvestTaskRef,
    setHarvestTask,
    setHarvestStatusAnnouncement,
    restoreOptimisticResinPresentation,
    clearOptimisticResinPresentation,
    requestHarvestCancellation,
    settleHarvestAfterAuthoritativeRemoval,
    requestNearbyCollectibles,
    requestWorldResync,
    queuedMapFlagBuild,
    setQueuedMapFlagBuild,
    onQueuedMapBuildMovementRejected,
    droppedItemInteractionRef,
    clearDroppedItemInteraction,
    attemptReadyDroppedItemPickup,
    observeWorldMapTravelError,
    onXoralExitConfirmationRequired,
    handleCityFlagConversionError,
    handleCityConstructionError,
    handleCityWarehouseError,
    onEquipmentMutationError,
    onTorchCraftingError,
    onXoralRingDropPickupError,
    showActionError,  } = options;

  return useCallback((message: ErrorMessage): void => {
    perfRecorder.recordEvent("server_error", { message: message.message });
    if (message.code === "TORCH_CRAFT_REJECTED") {
      onTorchCraftingError?.(message);
    }
    if (onXoralRingDropPickupError?.(message)) {
      showActionError(message.message);
      return;
    }
    observeWorldMapTravelError?.(message);
    if (
      message.code === "XORAL_LEADER_EXIT_CONFIRMATION_REQUIRED" ||
      message.code === "XORAL_FOLLOWER_EXIT_CONFIRMATION_REQUIRED"
    ) {
      onXoralExitConfirmationRequired?.(
        message.code === "XORAL_LEADER_EXIT_CONFIRMATION_REQUIRED" ? "leader" : "follower"
      );
      return;
    }
    if (
      message.code === "BALSAM_RESIN_FULL_HEALTH"
      || message.code === "ABILITY_TARGET_FULL_HEALTH"
    ) {
      overlayRef.current?.enqueueFloatingFeedback({
        eventId: `full-health:${message.requestId ?? Date.now()}`,
        targetEntityId: ownPlayerId,
        kind: "healing",
        amount: 1,
        label: "Full HP"
      });
      return;
    }
    if (message.code === "BALSAM_RESIN_NOT_OWNED") {
      overlayRef.current?.enqueueFloatingFeedback({
        eventId: `resin-not-owned:${message.requestId ?? Date.now()}`,
        targetEntityId: ownPlayerId,
        kind: "resin_spent",
        amount: 1,
        label: "NO Berries",
        icon: "giving_berry"
      });
      return;
    }
    if (message.code === "WORLD_AUTHORITY_PREPARING") {
      const activeHarvestTask = harvestTaskRef?.current;
      const currentMovement = localMovementRequests?.snapshot();
      const rejectedHarvestApproach =
        activeHarvestTask?.phase === "approaching" &&
        message.requestId === currentMovement?.requestId;
      const rejectedHarvestStart =
        activeHarvestTask?.phase === "starting" &&
        message.requestId === harvestRequestSentRef.current;
      if (rejectedHarvestApproach) {
        localMovementRequests.reset();
      }
      if (rejectedHarvestApproach || rejectedHarvestStart) {
        requestHarvestCancellation(false);
      }
      setPopulationPreparing(true);
      setWarning(message.message);
      showActionError(message.message);
      return;
    }
    if (message.code === "COMBAT_TARGET_NO_LONGER_AVAILABLE") {
      const targetEntityId = message.details?.targetEntityId;
      const removedTarget = targetEntityId
        ? combatStore.remove(targetEntityId)
        : false;
      const clearedSelection = Boolean(
        targetEntityId
        && selectedCombatEntityIdRef.current === targetEntityId
      );
      if (clearedSelection) {
        selectedCombatEntityIdRef.current = null;
        setSelectedCombatEntityId(null);
        setSelectedCombatEntity(null);
      }
      if (removedTarget || clearedSelection) {
        requestWorldResync?.("combat-target-no-longer-available");
      }
      setWarning(message.message);
      showActionError(message.message);
      return;
    }
    const currentMovement = localMovementRequests.snapshot();
    if (
      (
        message.requestId === currentMovement?.requestId &&
        currentMovement?.boundTravelRequestId ===
          postArrivalTravelRequestIdRef.current
      ) ||
      (
        postArrivalTravelRequestIdRef.current !== null &&
        postArrivalTravelRequestExpiresAtRef.current <= Date.now()
      )
    ) {
      clearPostArrivalTravelBinding({
        requestId: postArrivalTravelRequestIdRef,
        expiresAt: postArrivalTravelRequestExpiresAtRef
      });
    }
    const travelError = flagTravelErrorEffect(
      message,
      pendingTravelRequestIdRef.current
    );
    if (
      message.requestId
      && (
        message.code === "VISIBLE_FLAG_VIEW_STALE"
        || message.code === "VISIBLE_FLAG_RESOURCE_VISION_STALE"
        || message.code === "VISIBLE_FLAG_SET_STALE"
        || message.code === "VISIBLE_FLAG_CONNECTION_STALE"
        || message.code === "VISIBLE_FLAG_DESTINATION_STALE"
      )
    ) {
      const matchedVisiblePreparation =
        onRetryableFlagTravelPrecommit?.(message.requestId) ?? false;
      if (
        matchedVisiblePreparation
        || message.requestId !== pendingTravelRequestIdRef.current
      ) return;
    }
    if (travelError.requestIdToClear) {
      localMovementRequests.discardBoundTo(travelError.requestIdToClear);
      pendingTravelRequestIdRef.current = null;
      if (
        message.code === "VISIBLE_FLAG_RESOURCE_VISION_STALE"
        && message.retryable === true
        && onRetryableFlagTravelCommit?.(message)
      ) {
        gameplayLatencyTrace.record(
          "networking",
          "flag_visit_retry_started",
          {
            rejectedRequestId: travelError.requestIdToClear,
            resourceVisionRevision:
              message.details?.resourceVisionRevision ?? -1
          },
          { traceId: travelError.requestIdToClear }
        );
        setWarning(null);
        return;
      }
      if (
        message.code === "TRAVEL_POPULATION_PREPARING"
        || message.code === "TRAVEL_PROFILE_PREPARING"
        || message.code === "PLAYER_WORLD_TRANSITION_PENDING"
        || message.code === "VISIBLE_FLAG_VIEW_STALE"
        || message.code === "VISIBLE_FLAG_RESOURCE_VISION_STALE"
        || message.code === "VISIBLE_FLAG_DESTINATION_STALE"
      ) {
        onRetryableFlagTravelPrecommit?.();
      }
      if (travelError.refreshAccess) {
        setFlagAccessRevision((current) => current + 1);
      }
      if (travelError.aggressiveRetryAfterMs > 0) {
        setAggressiveFallbackUntilMs((current) =>
          Math.max(current, Date.now() + travelError.aggressiveRetryAfterMs)
        );
      }
      gameplayLatencyTrace.record(
        "networking",
        "flag_visit_rejected",
        { rejectionCode: message.code },
        { traceId: travelError.requestIdToClear, failure: true }
      );
      setWarning(travelError.feedbackMessage);
      showActionError(travelError.feedbackMessage ?? message.message);
      return;
    }
    if (isStaleLocalMoveRejection(
      localMovementRequests,
      message.code,
      message.requestId
    )) {
      recordMovementTrace({
        messageType: "MOVE_REJECTED",
        requestId: message.requestId ?? null,
        outcome: "ignored",
        reason: "stale-request"
      });
      return;
    }
    const formatted = formatServerWarning(message.message);
    if (handleHarvestCompletionError(message, formatted, {
      harvestTaskRef,
      pendingHarvestCompletionRef,
      harvestRequestSentRef,
      setHarvestTask,
      pendingHarvestCancelNodeRef,
      restoreOptimisticResinPresentation,
      requestNearbyCollectibles,
      setWarning,
      showActionError,
      setHarvestStatusAnnouncement,
      ...(queuedHarvestReplacementRef ? { queuedHarvestReplacementRef } : {})
    })) return;
    const rejectedInventoryAction =
      inventoryStackActionRequestGateRef.current.finish(message.requestId);
    if (rejectedInventoryAction && message.requestId) {
      gameplayLatencyTrace.record("networking", "inventory_stack_request_rejected", {
        action: rejectedInventoryAction.action,
        roundTripMs: performance.now() - rejectedInventoryAction.startedAt,
        rejectionCode: message.code
      }, { traceId: message.requestId, failure: true });
    }
    const equipmentError =
      message.code.startsWith("EQUIPMENT_") ||
      message.code.startsWith("COMBAT_KIT_");
    const matchingEquipmentMutation =
      message.requestId !== undefined &&
      equipmentMutationRequestRef.current === message.requestId;
    if (matchingEquipmentMutation) {
      equipmentMutationRequestRef.current = null;
      setEquipmentBusy(false);
      onEquipmentMutationError?.(message);
    }
    if (equipmentError && message.requestId) {
      const matchingActivation =
        pendingKitActivationRef.current?.requestId === message.requestId;
      if (!matchingEquipmentMutation && !matchingActivation) return;
      if (matchingActivation) {
        pendingKitActivationRef.current = null;
        setPendingKitActivation(null);
      }
      if (matchingActivation) setEquipmentBusy(false);
    }
    const activeFlagValidation =
      flagPlacementValidationGateRef.current?.pending() ?? null;
    const pendingFlagValidation =
      activeFlagValidation?.requestId === message.requestId;
    const flagPlacementError =
      message.code === "FLAG_BUILD_REJECTED" ||
      message.code === "FLAG_PLACEMENT_REJECTED" ||
      message.code.startsWith("FLAG_QUOTE_");
    if (
      flagPlacementError &&
      activeFlagValidation &&
      message.requestId !== activeFlagValidation.requestId
    ) {
      return;
    }
    if (
      pendingFlagValidation ||
      flagPlacementError ||
      message.code.startsWith("WORLD_")
    ) {
      flagPlacementValidationGateRef.current?.complete(message.requestId);
      flagBuildIntentRef.current?.complete();
      setFlagBuildQueued((current) =>
        !message.requestId || current?.requestId === message.requestId
          ? null
          : current
      );
      if (
        formatted === "Cannot place flag on water" ||
        formatted === "Cannot build on river water."
      ) {
        setFlagPlacementTerrain("water");
      }
      setWarning(null);
      showBlockedFlagPlacement(formatted);
      return;
    }
    if (handleChatError(message, formatted)) showActionError(formatted);
    if (handleCityConstructionError?.(message)) {
      showActionError(formatted);
      return;
    }
    if (message.code.startsWith("CITY_")) {
      if (handleCityFlagConversionError?.(message, formatted)) return;
      if (handleCityWarehouseError?.(message)) return;
      setFoundingCity(false);
      setCityActionBusy(false);
      setEquipmentBusy(false);
      setJoiningCity(false);
      setLeavingCity(false);
      setPendingLeaveCityId(null);
      showActionError(formatted);
    }
    if (message.code.startsWith("KINGDOM_")) {
      showActionError(formatted);
      requestKingdomState();
    }
    const classMutationError = classMutationErrorUiEffect(
      message.code,
      classBusy
    );
    const equipmentRequestBeforeClassError =
      equipmentMutationRequestRef.current;
    const equipmentRequestAfterClassError =
      equipmentMutationRequestAfterClassError(
        equipmentRequestBeforeClassError,
        message.requestId,
        message.code
      );
    const classErrorRejectedEquipmentRequest =
      equipmentRequestBeforeClassError !== null &&
      equipmentRequestAfterClassError === null;
    equipmentMutationRequestRef.current = equipmentRequestAfterClassError;
    if (
      message.requestId &&
      message.requestId === teleportRequestRef.current
    ) {
      teleportRequestRef.current = null;
      setTeleportMode("idle");
      showActionError(formatted);
    }
    setWarning(formatted);
    if (
      message.code === "FLAG_CREATE_FAILED" ||
      message.code === "FLAG_REINFORCEMENT_REJECTED"
    ) {
      showActionError(formatted);
    }
    if (shouldShowGeneralActionError(message.code, classMutationError.showActionError)) {
      showActionError(formatted);
    }
    if (message.code.startsWith("DROP_")) {
      inventoryDropRequestGateRef.current.finish();
      setDroppingInventoryItemKey(null);
    }
    if (classErrorRejectedEquipmentRequest) setEquipmentBusy(false);
    if (classMutationError.clearBusy) setClassBusy(false);
    if (message.code.startsWith("SUBCLASS_")) {
      setDevSubclassPending(null);
    }
    if (message.code.startsWith("DEV_PROGRESSION_")) {
      setDevProgressionPendingType(null);
      setDevProgressionError(formatted);
      showActionError(formatted);
    }
    if (message.code.startsWith("DEV_SUBCLASS_")) {
      setDevSubclassPending(null);
      setDevProgressionError(formatted);
      showActionError(formatted);
    }
    if (
      message.code === "DEV_ASSET_GRANT_REJECTED" ||
      message.code.startsWith("DEV_CITY_")
    ) {
      setDevGrantBusy(false);
      setDevGrantFeedback(formatted);
      showActionError(formatted);
    }
    if (message.code.startsWith("DROPPED_ITEM_")) {
      const failedDropId =
        droppedItemPickupRequestGateRef.current.getActiveDropId();
      if (failedDropId) {
        droppedItemPickupRequestGateRef.current.finish(failedDropId);
        const staleQuantity =
          message.code === "DROPPED_ITEM_QUANTITY_UNAVAILABLE"
            ? message.details?.remainingQuantity
            : undefined;
        if (staleQuantity !== undefined && staleQuantity > 0) {
          setDroppedItems((current) => current.map((drop) =>
            drop.dropId === failedDropId
              ? { ...drop, quantity: staleQuantity }
              : drop
          ));
          clearDroppedItemInteraction({
            expectedDropId: failedDropId,
            stopMovement: true,
            clearSelection: false
          });
          setPickupAmount((current) =>
            clampDroppedItemPickupQuantity(current, staleQuantity)
          );
        } else {
          clearDroppedItemInteraction({
            expectedDropId: failedDropId,
            stopMovement: true
          });
        }
      }
      requestNearbyCollectibles();
      attemptReadyDroppedItemPickup();
    }
    if (message.code === "HARVEST_TOO_EARLY") {
      if (
        harvestRequestSentRef.current &&
        message.requestId !== harvestRequestSentRef.current
      ) return;
      harvestRequestSentRef.current = null;
      restoreOptimisticResinPresentation();
      requestNearbyCollectibles();
      const retryTask: HarvestTask | null =
        harvestTaskRef.current?.phase === "completing"
          ? {
              ...harvestTaskRef.current,
              phase: "harvesting",
              completesAtMs: Date.now() +
                Math.max(100, message.details?.retryAfterMs ?? 1_000)
            }
          : harvestTaskRef.current;
      harvestTaskRef.current = retryTask;
      setHarvestTask(retryTask);
    } else if (message.code.startsWith("HARVEST_")) {
      if (
        harvestRequestSentRef.current &&
        message.requestId !== harvestRequestSentRef.current
      ) return;
      harvestRequestSentRef.current = null;
      pendingHarvestCompletionRef.current = null;
      pendingHarvestCancelNodeRef.current = null;
      if (queuedHarvestReplacementRef) queuedHarvestReplacementRef.current = null;
      restoreOptimisticResinPresentation();
      const rejectedNodeId =
        typeof message.details?.nodeId === "string"
          ? message.details.nodeId
          : harvestTaskRef.current?.nodeId;
      if (
        rejectedNodeId &&
        message.details?.reconciliation === "remove-node" &&
        renderStateRef &&
        setCollectibles &&
        selectedCollectibleIdRef &&
        setSelectedCollectibleId
      ) {
        removeCollectiblesFromPresentation({
          removals: [{
            nodeId: rejectedNodeId,
            stateRevision: typeof message.details?.stateRevision === "number"
              ? message.details.stateRevision
              : undefined
          }],
          renderStateRef,
          presentationStoreRef,
          populationZoneProjectionRef,
          harvestTaskRef,
          selectedCollectibleIdRef,
          overlayRef,
          setCollectibles,
          setSelectedCollectibleId,
          settleHarvestAfterAuthoritativeRemoval,
          clearOptimisticResinPresentation
        });
      }
      requestNearbyCollectibles();
      if (
        message.code === "HARVEST_OUTSIDE_RESOURCE_VISION" ||
        message.code === "HARVEST_PLAYER_WORLD_TRANSITION"
      ) {
        requestWorldResync?.("harvest-authority-mismatch");
      }
      if (harvestTaskRef.current) requestHarvestCancellation();
    }
    if (message.code === "MOVE_REJECTED") {
      const rejectedQueuedFlagBuild =
        queuedMapFlagBuild.reject(message.requestId);
      if (rejectedQueuedFlagBuild) {
        setQueuedMapFlagBuild(null);
        onQueuedMapBuildMovementRejected?.();
      }
      const rejectedAtMs = performance.now();
      playerRenderTimeline.rejectLocalAnticipation(
        message.requestId ?? "",
        rejectedAtMs
      );
      localMovementRequests.reset();
      recordMovementTrace({
        clientTimeMs: rejectedAtMs,
        messageType: "MOVE_REJECTED",
        requestId: message.requestId ?? null,
        outcome: "accepted",
        reason: "current-request"
      });
      setHarvestTask((current) =>
        current?.phase === "approaching" ? null : current
      );
      if (droppedItemInteractionRef.current?.phase === "approaching") {
        clearDroppedItemInteraction({ stopMovement: false });
      }
      if (rejectedQueuedFlagBuild) {
        setWarning(null);
        showBlockedFlagPlacement(formatted);
      }
    }
  }, [
    attemptReadyDroppedItemPickup,
    clearOptimisticResinPresentation,
    clearDroppedItemInteraction,
    classBusy,
    combatStore,
    droppedItemInteractionRef,
    droppedItemPickupRequestGateRef,
    equipmentMutationRequestRef,
    flagBuildIntentRef,
    flagPlacementValidationGateRef,
    handleChatError,
    handleCityFlagConversionError,
    handleCityConstructionError,
    harvestRequestSentRef,
    harvestTaskRef,
    inventoryDropRequestGateRef,
    inventoryStackActionRequestGateRef,
    localMovementRequests,
    ownPlayerId,
    observeWorldMapTravelError,
    onQueuedMapBuildMovementRejected,
    onEquipmentMutationError,
    onTorchCraftingError,
    onXoralRingDropPickupError,
    overlayRef,
    pendingHarvestCancelNodeRef,
    pendingHarvestCompletionRef,
    pendingKitActivationRef,
    pendingTravelRequestIdRef,
    onRetryableFlagTravelPrecommit,
    postArrivalTravelRequestExpiresAtRef,
    postArrivalTravelRequestIdRef,
    playerRenderTimeline,
    queuedMapFlagBuild,
    requestHarvestCancellation,
    requestKingdomState,
    requestHarvestCancellation,
    requestNearbyCollectibles,
    requestWorldResync,
    restoreOptimisticResinPresentation,
    selectedCombatEntityIdRef,
    setAggressiveFallbackUntilMs,
    setCityActionBusy,
    setClassBusy,
    setDevGrantBusy,
    setDevGrantFeedback,
    setDevProgressionError,
    setDevProgressionPendingType,
    setDevSubclassPending,
    setDroppedItems,
    setDroppingInventoryItemKey,
    setEquipmentBusy,
    setFlagAccessRevision,
    setFlagBuildQueued,
    setFlagPlacementTerrain,
    showBlockedFlagPlacement,
    setFoundingCity,
    setHarvestTask,
    setHarvestStatusAnnouncement,
    setJoiningCity,
    setLeavingCity,
    setPendingKitActivation,
    setPendingLeaveCityId,
    setPopulationPreparing,
    setPickupAmount,
    setQueuedMapFlagBuild,
    setSelectedCombatEntity,
    setSelectedCombatEntityId,
    setTeleportMode,
    setWarning,
    settleHarvestAfterAuthoritativeRemoval,
    showActionError,
    teleportRequestRef
  ]);
}

function shouldShowGeneralActionError(
  code: string,
  classMutationActionError: boolean
): boolean {
  return (
    code.startsWith("HARVEST_") ||
    code.startsWith("DROP_") ||
    code.startsWith("INVENTORY_") ||
    code.startsWith("DROPPED_ITEM_") ||
    code === "WATER_COLLECT_REJECTED" ||
    code === "COLLECTIBLES_REFRESH_FAILED" ||
    code.startsWith("COMBAT_") ||
    code.startsWith("EQUIPMENT_") ||
    code.startsWith("COMBAT_KIT_") ||
    classMutationActionError ||
    code.startsWith("ABILITY_") ||
    code.startsWith("RAGE_") ||
    code.startsWith("FOCUS_") ||
    code.startsWith("PARTY_") ||
    code === "PLAYER_ALREADY_IN_PARTY" ||
    code.startsWith("ALLY_") ||
    code.startsWith("FLAG_BURN_") ||
    code.startsWith("FLAG_ATTACK_") ||
    // Alt doorway refusals (invites, party travel, flag raids after arriving).
    code.startsWith("TRAVEL_DOORWAY_") ||
    code === "TRAVEL_LINKED_ACCOUNT" ||
    code === "ARRIVAL_RAID_HOLD" ||
    code === "TORCH_CRAFT_REJECTED" ||
    code.startsWith("DEV_MOB_") ||
    code === "DEV_TOOLS_DISABLED"
  );
}
