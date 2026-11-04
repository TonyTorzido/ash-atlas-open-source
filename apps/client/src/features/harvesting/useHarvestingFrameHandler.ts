import {
  type CollectibleNode,
  type CityStructureSnapshot,
  type FieldBuffSnapshot,
  type HarvestingServerMessage,
  isDungeonResourceNodeId,
  type OilWellSnapshot,
  type PlayerSnapshot,
  type RepeatableResourceNode,
  type ResourceVision,
  type ResourceVisionStatus,
  type WaterSourceHighlight
} from "@ash-atlas/shared";
import {
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction
} from "react";

import {
  attachQueuedHarvestSourceSession,
  attachHarvestSession,
  queuedHarvestMatchesCompletion,
  queuedHarvestMatchesRequestSettlement,
  queuedHarvestMatchesSettlement,
  resumeHarvestTask,
  type PendingHarvestCompletion,
  type QueuedHarvestReplacement,
  type HarvestTask
} from "../../collectibles/harvest.js";
import {
  removeCollectiblesFromPresentation
} from "../../collectibles/collectibleReconciliation.js";
import {
  WorldResourcePresentationStore,
  type WorldResourceRemovalReason
} from "../../collectibles/worldResourcePresentationStore.js";
import {
  matchesActiveFlagCircle,
  matchesActiveResourceVision
} from "../../map/flagScopedEntityVisibility.js";
import type { RenderState } from "../../map/mapObjects.js";
import { perfMetrics } from "../../perf/perfMetrics.js";
import { progressionRecorder } from "../../perf/progressionRecorder.js";
import type {
  PopulationZoneProjectionState
} from "../../population/populationZoneProjection.js";
import {
  emptyPopulationZoneProjection
} from "../../population/populationZoneProjection.js";
import type {
  WorldViewConvergenceBarrier
} from "../../worldView/worldViewConvergenceBarrier.js";
import {
  handleInventoryFrame,
  type InventoryFrameHandlerOptions
} from "./inventoryFrameHandler.js";

type RefCell<T> = { current: T };

const HARVESTING_FRAME_TYPES = {
  COLLECTIBLES_SNAPSHOT: true,
  RESOURCE_VISION_LOADING: true,
  RESOURCE_VISION_READY: true,
  HARVEST_STARTED: true,
  HARVEST_COMPLETED: true,
  COLLECTIBLE_UPDATED: true,
  CONSUMABLE_USED: true,
  SIMPLE_FOOD_CONSUMED: true,
  FIELD_CONSUMABLE_USED: true,
  FIELD_CONSUMABLE_CRAFTED: true,
  WATER_SITES: true,
  PEARL_DIVE_RESULT: true,
  FIELD_BUFFS: true,
  HARVEST_CANCELLED: true,
  REPEATABLE_RESOURCE_HARVESTED: true,
  REPEATABLE_RESOURCE_UPDATED: true,
  MINE_CLAIMED: true,
  HARVEST_ACCESS_CHANGED: true,
  RESOURCE_GAINED: true,
  COLLECTIBLE_REMOVED: true,
  COLLECTIBLE_PICKED_UP: true,
  PLAYER_RESOURCES_UPDATED: true,
  WATER_COLLECTED: true,
  ITEM_DROP_RESULT: true,
  EQUIPMENT_DROP_RESULT: true,
  INVENTORY_STACK_UPDATED: true,
  INVENTORY_PROTECTION_SNAPSHOT: true,
  INVENTORY_PROTECTION_UPDATED: true,
  DROPPED_ITEM_PICKUP_RESULT: true,
  DROPPED_EQUIPMENT_PICKUP_RESULT: true,
  DROPPED_BACKPACK_PICKUP_RESULT: true,
  DROPPED_ITEMS_SNAPSHOT: true
} as const satisfies Record<HarvestingServerMessage["type"], true>;

export function isHarvestingServerMessage(
  message: { type: string }
): message is HarvestingServerMessage {
  return Object.hasOwn(HARVESTING_FRAME_TYPES, message.type);
}

export interface HarvestingFrameHandlerOptions extends InventoryFrameHandlerOptions {
  getCommands(): {
    cancelHarvest(sessionId: string): void;
    requestNearbyCollectibles(): void;
  } | null;
  localPlayerRef: RefCell<PlayerSnapshot | null>;
  relocationRevisionRef: RefCell<number>;
  resourceVisionRevisionRef: RefCell<number>;
  gameplayViewGenerationRef?: RefCell<number>;
  renderStateRef: RefCell<RenderState>;
  presentationStoreRef?: RefCell<WorldResourcePresentationStore>;
  worldViewBarrierRef?: RefCell<WorldViewConvergenceBarrier>;
  populationZoneProjectionRef: RefCell<PopulationZoneProjectionState>;
  harvestTaskRef: RefCell<HarvestTask | null>;
  selectedCollectibleIdRef: RefCell<string | null>;
  surveyStartedAtRef: RefCell<number | null>;
  harvestRequestSentRef: RefCell<string | null>;
  pendingHarvestCancelNodeRef: RefCell<string | null>;
  queuedHarvestReplacementRef?: RefCell<QueuedHarvestReplacement | null>;
  startQueuedHarvestReplacement?(replacement: QueuedHarvestReplacement): void;
  pendingHarvestCompletionRef: RefCell<PendingHarvestCompletion | null>;
  ignoredHarvestStartsRef: RefCell<Map<string, string>>;
  setCollectibles: Dispatch<SetStateAction<CollectibleNode[]>>;
  setCityStructures?: Dispatch<SetStateAction<CityStructureSnapshot[]>>;
  setOilWell?: Dispatch<SetStateAction<OilWellSnapshot | null>>;
  setResourceVision: Dispatch<SetStateAction<ResourceVision | null>>;
  setResourceVisionStatus: Dispatch<SetStateAction<ResourceVisionStatus | null>>;
  setWaterHighlights: Dispatch<SetStateAction<WaterSourceHighlight[]>>;
  setSelectedCollectibleId: Dispatch<SetStateAction<string | null>>;
  setHarvestTask: Dispatch<SetStateAction<HarvestTask | null>>;
  setHarvestClockMs: Dispatch<SetStateAction<number>>;
  setHarvestStatusAnnouncement: Dispatch<SetStateAction<string>>;
  settleHarvestAfterAuthoritativeRemoval(nodeId: string): void;
  clearOptimisticResinPresentation(nodeId?: string): void;
  restoreOptimisticResinPresentation(): void;
  receiveWalletGold?(gold: string, revision?: string): void;
  onLocalPlayerHungerChanged?(hunger: NonNullable<PlayerSnapshot["hunger"]>): void;
  /** Giving Berry heal-over-time started or refreshed (server timestamps, server clock). */
  /** The full list of this player's active field buffs (replaces the previous list). */
  onFieldBuffs?(buffs: readonly FieldBuffSnapshot[], serverTime: number): void;
  /** Pearl Beds, whirlpools and Drowned City sites near the player. */
  onWaterSites?(message: Extract<HarvestingServerMessage, { type: "WATER_SITES" }>): void;
  onPearlDive?(message: Extract<HarvestingServerMessage, { type: "PEARL_DIVE_RESULT" }>): void;
  onGivingBerryEffect?(effect: Readonly<{ effectId: string; startedAt: string; endsAt: string }>, serverTime: number): void;
}

export function useHarvestingFrameHandler(
  options: HarvestingFrameHandlerOptions
) {
  const {
    ownPlayerId,
    getCommands,
    localPlayerRef,
    relocationRevisionRef,
    resourceVisionRevisionRef,
    gameplayViewGenerationRef: providedGameplayViewGenerationRef,
    renderStateRef: providedRenderStateRef,
    presentationStoreRef: providedPresentationStoreRef,
    worldViewBarrierRef,
    populationZoneProjectionRef: providedPopulationZoneProjectionRef,
    harvestTaskRef,
    selectedCollectibleIdRef,
    surveyStartedAtRef,
    harvestRequestSentRef,
    pendingHarvestCancelNodeRef,
    queuedHarvestReplacementRef: providedQueuedHarvestReplacementRef,
    startQueuedHarvestReplacement,
    pendingHarvestCompletionRef,
    ignoredHarvestStartsRef,
    inventoryDropRequestGateRef,
    inventoryStackActionRequestGateRef,
    droppedItemPickupRequestGateRef,
    overlayRef,
    setCollectibles,
    setCityStructures,
    setOilWell,
    setResourceVision,
    setResourceVisionStatus,
    setWaterHighlights,
    setSelectedCollectibleId,
    setHarvestTask,
    setHarvestClockMs,
    setDroppingInventoryItemKey,
    setDropSelection,
    setDropAmount,
    setDroppedItems,
    setManorDroppedEquipment,
    setWarning,
    setHarvestStatusAnnouncement,
    setEquipment,
    receiveBackpackSnapshot,
    installInventoryProtectionSnapshot,
    settleHarvestAfterAuthoritativeRemoval,
    clearOptimisticResinPresentation,
    restoreOptimisticResinPresentation,
    receiveInventorySnapshot,
    receiveWalletGold,
    onLocalPlayerHungerChanged,
    onGivingBerryEffect,
    onFieldBuffs,
    onWaterSites,
    onPearlDive,
    clearDroppedItemInteraction,
    attemptReadyDroppedItemPickup
  } = options;

  const fallbackGameplayViewGenerationRef = useRef(0);
  const fallbackQueuedHarvestReplacementRef =
    useRef<QueuedHarvestReplacement | null>(null);
  const queuedHarvestReplacementRef =
    providedQueuedHarvestReplacementRef ?? fallbackQueuedHarvestReplacementRef;
  const gameplayViewGenerationRef =
    providedGameplayViewGenerationRef ?? fallbackGameplayViewGenerationRef;
  const fallbackRenderStateRef = useRef({
    collectibles: [],
    selectedCollectibleId: null
  } as unknown as RenderState);
  const renderStateRef = providedRenderStateRef ?? fallbackRenderStateRef;
  const fallbackPopulationZoneProjectionRef = useRef(
    emptyPopulationZoneProjection()
  );
  const populationZoneProjectionRef =
    providedPopulationZoneProjectionRef ?? fallbackPopulationZoneProjectionRef;
  const fallbackPresentationStoreRef = useRef(
    new WorldResourcePresentationStore(renderStateRef.current.collectibles)
  );
  const presentationStoreRef =
    providedPresentationStoreRef ?? fallbackPresentationStoreRef;

  return useCallback((message: HarvestingServerMessage): void => {
    const removeCollectible = (
      nodeId: string,
      stateRevision?: number,
      domain?: "population" | "repeatable-resource" | "resource-vision",
      reason: WorldResourceRemovalReason = "explicit-server-removal"
    ): void => {
      // Dungeon nodes live in the dungeon snapshot, never in the world store.
      if (isDungeonResourceNodeId(nodeId)) return;
      removeCollectiblesFromPresentation({
        removals: [{
          nodeId,
          stateRevision,
          ...(domain ? { domain } : {}),
          reason
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
    };
    const upsertRenderedCollectible = (
      node: CollectibleNode,
      domain: "population" | "repeatable-resource" | "resource-vision"
    ): void => {
      if (isDungeonResourceNodeId(node.id)) return;
      const nextCollectibles = presentationStoreRef.current.upsert(domain, node);
      renderStateRef.current = {
        ...renderStateRef.current,
        collectibles: nextCollectibles
      };
      setCollectibles(nextCollectibles);
      overlayRef.current?.update(renderStateRef.current);
    };
    switch (message.type) {
      case "COLLECTIBLES_SNAPSHOT": {
        if (
          message.playerId !== ownPlayerId ||
          message.relocationRevision !== relocationRevisionRef.current ||
          message.resourceVisionRevision !== resourceVisionRevisionRef.current ||
          message.authority.gameplayViewGeneration <
            gameplayViewGenerationRef.current ||
          !matchesActiveResourceVision(
            localPlayerRef.current?.currentFlagId,
            message.resourceVision
          )
        ) {
          return;
        }
        gameplayViewGenerationRef.current =
          message.authority.gameplayViewGeneration;
        if (message.worldViewAuthority) {
          worldViewBarrierRef?.current.observeResources(
            message.worldViewAuthority,
            message.authority.snapshotGeneration,
            message.resourceVision === null ||
              message.authority.completeness === "complete"
          );
        }
        const nextCollectibles = presentationStoreRef.current.applySnapshot({
          authority: message.authority,
          nodes: message.nodes,
          repeatableNodes: message.repeatableNodes.map((node) =>
            repeatableNodeAsCollectible(node)
          )
        });
        renderStateRef.current = {
          ...renderStateRef.current,
          collectibles: nextCollectibles
        };
        const nextIds = new Set(nextCollectibles.map((node) => node.id));
        if (
          harvestTaskRef.current &&
          !nextIds.has(harvestTaskRef.current.nodeId)
        ) {
          settleHarvestAfterAuthoritativeRemoval(
            harvestTaskRef.current.nodeId
          );
        }
        if (
          selectedCollectibleIdRef.current &&
          !nextIds.has(selectedCollectibleIdRef.current)
        ) {
          selectedCollectibleIdRef.current = null;
          setSelectedCollectibleId(null);
          renderStateRef.current = {
            ...renderStateRef.current,
            selectedCollectibleId: null
          };
        }
        setCollectibles(nextCollectibles);
        overlayRef.current?.update(renderStateRef.current);
        setResourceVision(message.resourceVision);
        setResourceVisionStatus(message.resourceVisionStatus ?? null);
        setWaterHighlights(message.waterHighlights);
        clearOptimisticResinPresentation();
        if (surveyStartedAtRef.current !== null) {
          perfMetrics.noteSurveyResponse(
            performance.now() - surveyStartedAtRef.current
          );
          surveyStartedAtRef.current = null;
        }
        return;
      }
      case "RESOURCE_VISION_LOADING":
        if (!matchesActiveFlagCircle(
          localPlayerRef.current?.currentFlagId,
          message.resourceVision.flagId
        )) {
          return;
        }
        setResourceVision(message.resourceVision);
        setResourceVisionStatus(message.status);
        return;
      case "RESOURCE_VISION_READY":
        if (!matchesActiveFlagCircle(
          localPlayerRef.current?.currentFlagId,
          message.resourceVision.flagId
        )) {
          return;
        }
        setResourceVision(message.resourceVision);
        setResourceVisionStatus(message.status);
        return;
      case "COLLECTIBLE_PICKED_UP":
        removeCollectible(
          message.nodeId,
          undefined,
          undefined,
          "harvested"
        );
        harvestRequestSentRef.current = null;
        pendingHarvestCompletionRef.current = null;
        if (message.playerId === ownPlayerId) {
          receiveInventorySnapshot(message.inventory);
        }
        return;
      case "COLLECTIBLE_REMOVED":
        removeCollectible(
          message.nodeId,
          message.stateRevision,
          "population",
          "explicit-server-removal"
        );
        return;
      case "COLLECTIBLE_UPDATED":
        clearOptimisticResinPresentation(message.node.id);
        upsertRenderedCollectible(message.node, "population");
        return;
      case "REPEATABLE_RESOURCE_UPDATED":
        upsertRenderedCollectible(
          repeatableNodeAsCollectible(message.node),
          "repeatable-resource"
        );
        return;
      case "MINE_CLAIMED":
        upsertRenderedCollectible(repeatableNodeAsCollectible(message.node), "repeatable-resource");
        receiveInventorySnapshot(message.inventory);
        setWarning(message.message);
        return;
      case "HARVEST_ACCESS_CHANGED":
        setCollectibles((current) => current.map((node) => {
          if (
            node.repeatableOwnerPlayerId !== message.ownerPlayerId
            || node.repeatableNodeType !== message.harvestType
            || (message.assetId !== null && node.id !== message.assetId)
          ) return node;
          return {
            ...node,
            repeatableTollGold: message.tollGold,
            ...(message.accessMode === null
              ? {}
              : {
                  repeatableAccessMode: message.accessMode,
                  repeatableAccessRevision: Number(message.accessRevision ?? 0)
                })
          };
        }));
        if (message.harvestType === "oil_well") {
          setCityStructures?.((current) => current.map((structure) => {
            if (
              structure.type !== "oil_well"
              || structure.ownerPlayerId !== message.ownerPlayerId
              || (message.assetId !== null && structure.structureId !== message.assetId)
              || message.accessMode === null
            ) return structure;
            const accessRevision = message.accessRevision ?? structure.harvestAccessRevision;
            return {
              ...structure,
              harvestAccessMode: message.accessMode,
              ...(accessRevision === undefined ? {} : { harvestAccessRevision: accessRevision })
            };
          }));
          setOilWell?.((current) => {
            if (
              !current
              || current.ownerPlayerId !== message.ownerPlayerId
              || (message.assetId !== null && current.structureId !== message.assetId)
            ) return current;
            const accessRevision = message.accessRevision ?? current.accessRevision;
            return {
              ...current,
              tollGold: message.tollGold,
              ...(message.accessMode === null
                ? {}
                : {
                    accessMode: message.accessMode,
                    ...(accessRevision === undefined ? {} : { accessRevision })
                  })
            };
          });
        }
        return;
      case "REPEATABLE_RESOURCE_HARVESTED": {
        const activeTask = harvestTaskRef.current;
        const pendingCompletion = pendingHarvestCompletionRef.current;
        const queuedReplacement = queuedHarvestReplacementRef.current;
        const matchesCurrentCompletion =
          message.requestId === harvestRequestSentRef.current &&
          (
            (
              activeTask?.nodeId === message.node.id &&
              activeTask.sessionId === pendingCompletion?.sessionId
            ) ||
            (
              pendingCompletion?.nodeId === message.node.id &&
              pendingCompletion.requestId === message.requestId
            )
          );
        const matchesQueuedCompletion = queuedHarvestMatchesRequestSettlement(
          queuedReplacement,
          message.node.id,
          message.requestId
        );
        if (!matchesCurrentCompletion && !matchesQueuedCompletion) return;
        upsertRenderedCollectible(
          repeatableNodeAsCollectible(message.node),
          "repeatable-resource"
        );
        receiveInventorySnapshot(message.inventory);
        if (message.walletGold !== undefined && message.walletGold !== null) {
          receiveWalletGold?.(message.walletGold, message.walletRevision ?? undefined);
        }
        harvestTaskRef.current = null;
        setHarvestTask(null);
        harvestRequestSentRef.current = null;
        pendingHarvestCompletionRef.current = null;
        queuedHarvestReplacementRef.current = null;
        setHarvestStatusAnnouncement("Gathering completed.");
        if (!message.replayed && message.professionResults) {
          const proc = message.professionResults;
          if (proc.bonusYield) overlayRef.current?.enqueueFloatingFeedback({ eventId: `${message.requestId}:careful-extraction`, targetEntityId: ownPlayerId, kind: "harvesting_notice", amount: 1, icon: message.node.yieldItemId, label: `+1 ${message.node.yieldItemId.toUpperCase()} · CAREFUL EXTRACTION` });
          if (proc.instant) overlayRef.current?.enqueueFloatingFeedback({ eventId: `${message.requestId}:clean-break`, targetEntityId: ownPlayerId, kind: "harvesting_notice", amount: 1, label: "CLEAN BREAK" });
          if (proc.unbrokenVein) overlayRef.current?.enqueueFloatingFeedback({ eventId: `${message.requestId}:unbroken-vein`, targetEntityId: ownPlayerId, kind: "harvesting_notice", amount: 1, icon: message.node.yieldItemId, label: "UNBROKEN VEIN · MINE AGAIN" });
        }
        if (matchesQueuedCompletion && queuedReplacement) {
          startQueuedHarvestReplacement?.(queuedReplacement);
        }
        return;
      }
      case "RESOURCE_GAINED":
        if (message.playerId === ownPlayerId) {
          // The harvest in progress is the source; its position places the reward pop-out.
          const task = harvestTaskRef.current;
          if (task) overlayRef.current?.noteHarvestTarget?.(task.nodeId);
          overlayRef.current?.enqueueResourceGain(message.gain);
        }
        return;
      case "HARVEST_STARTED": {
        overlayRef?.current?.noteHarvestTarget?.(message.session.nodeId);
        const currentTask = harvestTaskRef.current;
        const pendingCompletion = pendingHarvestCompletionRef.current;
        const ignoredStartNodeId =
          ignoredHarvestStartsRef.current.get(message.requestId);
        const queuedSource = queuedHarvestReplacementRef.current;
        const queuedWithSession = queuedSource
          ? attachQueuedHarvestSourceSession(
              queuedSource,
              message.requestId,
              message.session.nodeId,
              message.session.sessionId
            )
          : null;
        if (queuedWithSession) {
          queuedHarvestReplacementRef.current = queuedWithSession;
          harvestRequestSentRef.current = null;
          if (currentTask && currentTask.nodeId === message.session.nodeId) {
            const cancellingTask = attachHarvestSession(
              currentTask,
              message.session,
              message.serverTime
            );
            harvestTaskRef.current = cancellingTask;
            setHarvestTask(cancellingTask);
            setHarvestClockMs(Date.now());
          }
          getCommands()?.cancelHarvest(message.session.sessionId);
          return;
        }
        if (
          ignoredStartNodeId === message.session.nodeId
        ) {
          ignoredHarvestStartsRef.current.delete(message.requestId);
          return;
        }
        if (
          message.requestId === "resume" &&
          pendingCompletion?.sessionId === message.session.sessionId
        ) {
          return;
        }
        if (
          pendingHarvestCancelNodeRef.current === message.session.nodeId ||
          (
            message.requestId !== "resume" &&
            (
              message.requestId !== harvestRequestSentRef.current ||
              !currentTask ||
              currentTask.nodeId !== message.session.nodeId
            )
          )
        ) {
          pendingHarvestCancelNodeRef.current = null;
          getCommands()?.cancelHarvest(message.session.sessionId);
          return;
        }
        pendingHarvestCancelNodeRef.current = null;
        harvestRequestSentRef.current = null;
        setHarvestTask(
          message.requestId === "resume"
            ? resumeHarvestTask(message.session, message.serverTime)
            : attachHarvestSession(
                currentTask!,
                message.session,
                message.serverTime
              )
        );
        setHarvestClockMs(Date.now());
        progressionRecorder.recordEvent({
          type: "harvest_started",
          sourceId: message.session.nodeId,
          resourceType: message.session.resourceType
        });
        setHarvestStatusAnnouncement(
          message.session.resourceType === "stone" ||
          message.session.resourceType === "coal" ||
          message.session.resourceType === "iron" ||
          message.session.resourceType === "sulfur"
            ? "Mining started."
            : message.session.resourceType === "wood"
              ? "Chopping started."
              : "Harvesting started."
        );
        return;
      }
      case "HARVEST_COMPLETED": {
        overlayRef?.current?.noteHarvestTarget?.(message.nodeId);
        const activeTask = harvestTaskRef.current;
        const pendingCompletion = pendingHarvestCompletionRef.current;
        const queuedReplacement = queuedHarvestReplacementRef.current;
        const matchesActiveCompletion =
          message.requestId === harvestRequestSentRef.current &&
          activeTask?.phase === "completing" &&
          activeTask.sessionId === message.session.sessionId &&
          activeTask.nodeId === message.nodeId;
        const matchesRemovedCompletion =
          pendingCompletion?.requestId === message.requestId &&
          pendingCompletion.sessionId === message.session.sessionId &&
          pendingCompletion.nodeId === message.nodeId;
        const matchesQueuedCompletion = queuedHarvestMatchesCompletion(
          queuedReplacement,
          message.nodeId,
          message.session.sessionId,
          message.requestId
        );
        if (!matchesActiveCompletion && !matchesRemovedCompletion && !matchesQueuedCompletion) return;
        clearOptimisticResinPresentation(message.nodeId);
        pendingHarvestCompletionRef.current = null;
        harvestTaskRef.current = null;
        setHarvestTask(null);
        if (message.nodeRemoved ?? true) {
          removeCollectible(
            message.nodeId,
            undefined,
            "population",
            "harvested"
          );
        } else {
          if (message.node) {
            upsertRenderedCollectible(message.node, "population");
          }
        }
        receiveInventorySnapshot(message.inventory);
        harvestRequestSentRef.current = null;
        pendingHarvestCancelNodeRef.current = null;
        queuedHarvestReplacementRef.current = null;
        setHarvestStatusAnnouncement("Gathering completed.");
        progressionRecorder.recordEvent({
          type: "harvest_completed",
          sourceId: message.nodeId,
          resourceType: message.session.resourceType
        });
        if (!message.replayed && message.professionResults) {
          if (message.professionResults.bonusYield) overlayRef.current?.enqueueFloatingFeedback({ eventId: `${message.requestId}:clean-cut`, targetEntityId: ownPlayerId, kind: "profession_proc", amount: 1, icon: "wood", label: "+1 CLEAN CUT" });
          if (message.professionResults.instant) overlayRef.current?.enqueueFloatingFeedback({ eventId: `${message.requestId}:perfect-swing`, targetEntityId: ownPlayerId, kind: "profession_proc", amount: 1, label: "PERFECT SWING" });
        }
        if (matchesQueuedCompletion && queuedReplacement) {
          startQueuedHarvestReplacement?.(queuedReplacement);
        }
        return;
      }
      case "CONSUMABLE_USED":
        receiveInventorySnapshot(message.inventory);
        if (message.playerId === ownPlayerId) onGivingBerryEffect?.(message.effect, message.serverTime);
        if (!message.replayed) {
          overlayRef.current?.enqueueFloatingFeedback({
            eventId: `resin-spent:${message.effect.effectId}`,
            targetEntityId: message.playerId,
            kind: "resin_spent",
            amount: 1,
            icon: "giving_berry"
          });
        }
        return;
      case "FIELD_CONSUMABLE_USED":
        receiveInventorySnapshot(message.inventory);
        if (message.playerId === ownPlayerId) onFieldBuffs?.(message.buffs, message.serverTime);
        setHarvestStatusAnnouncement(message.message);
        if (!message.replayed) {
          overlayRef.current?.enqueueFloatingFeedback({
            eventId: `field-consumable:${message.requestId}`,
            targetEntityId: message.playerId,
            kind: "harvesting_notice",
            amount: 1,
            label: message.message.toUpperCase()
          });
        }
        return;
      case "FIELD_CONSUMABLE_CRAFTED":
        receiveInventorySnapshot(message.inventory);
        setHarvestStatusAnnouncement(message.message);
        return;
      case "FIELD_BUFFS":
        onFieldBuffs?.(message.buffs, message.serverTime);
        return;
      case "WATER_SITES":
        onWaterSites?.(message);
        return;
      case "PEARL_DIVE_RESULT":
        receiveInventorySnapshot(message.inventory);
        setHarvestStatusAnnouncement(message.message);
        onPearlDive?.(message);
        return;
      case "SIMPLE_FOOD_CONSUMED":
        receiveInventorySnapshot(message.inventory);
        if (message.playerId === ownPlayerId) {
          const currentPlayer = localPlayerRef.current;
          if (currentPlayer) {
            const updated = { ...currentPlayer, hunger: message.hunger };
            localPlayerRef.current = updated;
            onLocalPlayerHungerChanged?.(message.hunger);
          }
        }
        if (!message.replayed) {
          overlayRef.current?.enqueueFloatingFeedback({
            eventId: `simple-food:${message.requestId}`,
            targetEntityId: message.playerId,
            kind: "harvesting_notice",
            amount: message.restoredQuantity,
            icon: "food",
            label: `+${message.restoredQuantity} HUNGER`
          });
        }
        return;
      case "HARVEST_CANCELLED": {
        const queuedReplacement = queuedHarvestReplacementRef.current;
        const matchesQueuedCancellation = queuedHarvestMatchesSettlement(
          queuedReplacement,
          message.session.nodeId,
          message.session.sessionId
        );
        if (
          !matchesQueuedCancellation &&
          (
            harvestTaskRef.current !== null
            || pendingHarvestCompletionRef.current !== null
          )
          && harvestTaskRef.current?.sessionId !== message.session.sessionId
          && pendingHarvestCompletionRef.current?.sessionId
            !== message.session.sessionId
        ) {
          return;
        }
        restoreOptimisticResinPresentation();
        getCommands()?.requestNearbyCollectibles();
        if (harvestTaskRef.current?.sessionId === message.session.sessionId) {
          harvestTaskRef.current = null;
        }
        setHarvestTask((current) =>
          current?.sessionId === message.session.sessionId ? null : current
        );
        harvestRequestSentRef.current = null;
        pendingHarvestCompletionRef.current = null;
        queuedHarvestReplacementRef.current = null;
        setHarvestStatusAnnouncement("Gathering canceled.");
        progressionRecorder.recordEvent({
          type: "harvest_cancelled",
          sourceId: message.session.nodeId,
          resourceType: message.session.resourceType
        });
        if (matchesQueuedCancellation && queuedReplacement) {
          startQueuedHarvestReplacement?.(queuedReplacement);
        }
        return;
      }
      case "PLAYER_RESOURCES_UPDATED":
      case "WATER_COLLECTED":
      case "ITEM_DROP_RESULT":
      case "EQUIPMENT_DROP_RESULT":
      case "INVENTORY_STACK_UPDATED":
      case "INVENTORY_PROTECTION_SNAPSHOT":
      case "INVENTORY_PROTECTION_UPDATED":
      case "DROPPED_ITEM_PICKUP_RESULT":
      case "DROPPED_EQUIPMENT_PICKUP_RESULT":
      case "DROPPED_BACKPACK_PICKUP_RESULT":
      case "DROPPED_ITEMS_SNAPSHOT":
        return handleInventoryFrame(message, {
          ownPlayerId,
          inventoryDropRequestGateRef,
          inventoryStackActionRequestGateRef,
          droppedItemPickupRequestGateRef,
          overlayRef,
          setDroppingInventoryItemKey,
          setDropSelection,
          setDropAmount,
          setDroppedItems,
          ...(setManorDroppedEquipment ? { setManorDroppedEquipment } : {}),
          setWarning,
          receiveInventorySnapshot,
          ...(receiveWalletGold ? { receiveWalletGold } : {}),
          clearDroppedItemInteraction,
          attemptReadyDroppedItemPickup,
          ...(setEquipment ? { setEquipment } : {}),
          ...(receiveBackpackSnapshot ? { receiveBackpackSnapshot } : {}),
          ...(installInventoryProtectionSnapshot ? { installInventoryProtectionSnapshot } : {})
        });
    }
    message satisfies never;
  }, [
    attemptReadyDroppedItemPickup,
    clearOptimisticResinPresentation,
    clearDroppedItemInteraction,
    droppedItemPickupRequestGateRef,
    getCommands,
    gameplayViewGenerationRef,
    harvestRequestSentRef,
    harvestTaskRef,
    ignoredHarvestStartsRef,
    inventoryDropRequestGateRef,
    inventoryStackActionRequestGateRef,
    localPlayerRef,
    overlayRef,
    ownPlayerId,
    pendingHarvestCancelNodeRef,
    pendingHarvestCompletionRef,
    queuedHarvestReplacementRef,
    populationZoneProjectionRef,
    presentationStoreRef,
    relocationRevisionRef,
    receiveInventorySnapshot,
    renderStateRef,
    restoreOptimisticResinPresentation,
    resourceVisionRevisionRef,
    selectedCollectibleIdRef,
    setCityStructures,
    setCollectibles,
    setDropAmount,
    setDropSelection,
    setDroppedItems,
    setManorDroppedEquipment,
    setDroppingInventoryItemKey,
    setEquipment,
    receiveBackpackSnapshot,
    installInventoryProtectionSnapshot,
    setHarvestClockMs,
    setHarvestStatusAnnouncement,
    onFieldBuffs,
    onWaterSites,
    onPearlDive,
    setHarvestTask,
    setOilWell,
    setResourceVision,
    setResourceVisionStatus,
    setSelectedCollectibleId,
    setWarning,
    settleHarvestAfterAuthoritativeRemoval,
    startQueuedHarvestReplacement,
    setWaterHighlights,
    surveyStartedAtRef
  ]);
}

function repeatableNodeAsCollectible(
  node: RepeatableResourceNode
): CollectibleNode {
  return {
    id: node.id,
    type: node.yieldItemId,
    lat: node.lat,
    lon: node.lon,
    quantity: node.yieldQuantity,
    state: node.state === "ready" ? "available" : "harvested",
    createdAt: "",
    harvestedAt: null,
    sourceCellId: `repeatable:${node.id}`,
    waterKind: null,
    repeatableNodeType: node.nodeType,
    repeatableState: node.state,
    repeatableReadyAt: node.readyAt,
    repeatableTimerVisibility: node.timerVisibility,
    repeatableRevision: node.authorityRevision,
    repeatableOwnerPlayerId: node.ownerPlayerId ?? null,
    repeatableOwnerUsername: node.ownerUsername ?? null,
    repeatableAccessMode: node.accessMode ?? null,
    repeatableAccessRevision: node.accessRevision ?? 0,
    repeatableTollGold: node.tollGold ?? "0",
    repeatableCanManage: node.canManage ?? false,
    repeatableBonusExtractionAvailable: node.bonusExtractionAvailable ?? false,
    presentationOwner: "repeatable-resource"
  };
}
