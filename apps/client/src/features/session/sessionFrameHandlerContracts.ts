import type {
  CombatEntitySnapshot,
  CollectibleNode,
  DeveloperCapability,
  DevProgressionType,
  DroppedItemSnapshot,
  FlagBuildMaterial,
  FlagPlacementTerrain,
  SessionServerMessage,
  SubclassId,
  TravelInboxEntry
} from "@ash-atlas/shared";
import type { Dispatch, SetStateAction } from "react";

import type { CombatStore } from "../../combat/combatStore.js";
import type {
  DroppedItemInteraction,
  DroppedItemPickupRequestGate
} from "../../droppedItems/droppedItemModel.js";
import type { FlagBuildIntent } from "../../flags/flagBuildIntent.js";
import type { FlagPlacementValidationGate } from "../../flags/flagPlacementValidation.js";
import type {
  InventoryDropRequestGate,
  InventoryStackActionRequestGate
} from "../../inventory/inventoryPanelModel.js";
import type { PixiGameOverlay } from "../../map/pixiOverlay.js";
import type { RenderState } from "../../map/mapObjects.js";
import type { LocalMovementRequestTracker } from "../../movement/localMovementRequests.js";
import type { PlayerRenderTimeline } from "../../movement/playerRenderSmoothing.js";
import type {
  QueuedMapFlagBuild,
  QueuedMapFlagBuildController
} from "../../movement/queuedMapFlagBuild.js";
import type { PopulationZoneProjectionState } from "../../population/populationZoneProjection.js";
import type { StartupEvent } from "../../startupState.js";
import type {
  HarvestTask,
  PendingHarvestCompletion,
  QueuedHarvestReplacement
} from "../../collectibles/harvest.js";
import type { WorldResourcePresentationStore } from "../../collectibles/worldResourcePresentationStore.js";
import type { PendingKitActivation } from "../combatEquipment/useCombatEquipmentFrameHandler.js";
import type {
  WorldAuthorityWelcomeClassification,
  WorldAuthorityWelcomeMarker
} from "./worldAuthorityWelcome.js";

export type RefCell<T> = { current: T };
export type ApplicationSessionMessage = Extract<
  SessionServerMessage,
  { type: "WELCOME" | "PRESENTATION_SNAPSHOT_COMPLETE" | "ERROR" | "PONG" }
>;
export type WelcomeMessage = Extract<ApplicationSessionMessage, { type: "WELCOME" }>;
export type ErrorMessage = Extract<ApplicationSessionMessage, { type: "ERROR" }>;

const APPLICATION_SESSION_FRAME_TYPES = new Set<string>([
  "WELCOME",
  "PRESENTATION_SNAPSHOT_COMPLETE",
  "ERROR",
  "PONG"
]);

interface QueuedFlagBuild {
  buildId: string;
  requestId: string;
  queuedAt: number;
}

interface ClearDroppedItemOptions {
  stopMovement?: boolean;
  clearSelection?: boolean;
  releaseRequestGate?: boolean;
  expectedDropId?: string;
}

export function isApplicationSessionMessage(
  message: { type: string }
): message is ApplicationSessionMessage {
  return APPLICATION_SESSION_FRAME_TYPES.has(message.type);
}

export interface SessionFrameHandlerOptions {
  ownPlayerId: string;
  hasCompletedBootstrapRef: RefCell<boolean>;
  worldAuthorityWelcomeMarkerRef: RefCell<WorldAuthorityWelcomeMarker | null>;
  onWorldAuthorityReset?(
    classification: WorldAuthorityWelcomeClassification,
    message: WelcomeMessage
  ): void;
  dispatchStartup(event: StartupEvent): void;
  onMarketReady(): void;
  combatStore: CombatStore;
  overlayRef: RefCell<PixiGameOverlay | null>;
  playerRenderTimeline: PlayerRenderTimeline;
  localMovementRequests: LocalMovementRequestTracker;
  playerDeltaSequenceRef: RefCell<number>;
  relocationRevisionRef: RefCell<number>;
  resourceVisionRevisionRef: RefCell<number>;
  gameplayViewGenerationRef: RefCell<number>;
  connectionIdRef: RefCell<string | null>;
  connectionGenerationRef: RefCell<number>;
  populationZoneProjectionRef: RefCell<PopulationZoneProjectionState>;
  lastWorldResyncRequestAtRef: RefCell<number>;
  pendingWorldResyncReasonRef: RefCell<string | null>;
  combatServerClockOffsetMsRef: RefCell<number>;
  selectedCombatEntityIdRef: RefCell<string | null>;
  setPopulationPreparing: Dispatch<SetStateAction<boolean>>;
  setLocalCombatEntity: Dispatch<SetStateAction<CombatEntitySnapshot | null>>;
  setAggressiveFallbackUntilMs: Dispatch<SetStateAction<number>>;
  setSelectedCombatEntity: Dispatch<SetStateAction<CombatEntitySnapshot | null>>;
  setSelectedCombatEntityId: Dispatch<SetStateAction<string | null>>;
  resetPartyForWelcome(): void;
  setTravelInbox: Dispatch<SetStateAction<TravelInboxEntry[]>>;
  resetPetForWelcome(): void;
  resetCombatFocusForWelcome(): void;
  beginChatBootstrap(): void;
  setFlagClaimRadiusM: Dispatch<SetStateAction<number | null>>;
  setFlagBuildRecipe: Dispatch<SetStateAction<FlagBuildMaterial[]>>;
  setBuoyBuildRecipe: Dispatch<SetStateAction<FlagBuildMaterial[]>>;
  onDirectMessageWelcome(): void;
  setWarning: Dispatch<SetStateAction<string | null>>;
  resetSettlementForWelcome(): void;
  setDeveloperCapabilities: Dispatch<
    SetStateAction<DeveloperCapability[]>
  >;
  beginProgrammaticCameraMove(
    reason: string,
    suppressPointerMs: number
  ): void;
  centerSpawn(message: WelcomeMessage): void;
  pendingTravelRequestIdRef: RefCell<string | null>;
  onRetryableFlagTravelPrecommit?(requestId?: string): boolean;
  onRetryableFlagTravelCommit?(message: ErrorMessage): boolean;
  postArrivalTravelRequestIdRef: RefCell<string | null>;
  postArrivalTravelRequestExpiresAtRef: RefCell<number>;
  setFlagAccessRevision: Dispatch<SetStateAction<number>>;
  equipmentMutationRequestRef: RefCell<string | null>;
  pendingKitActivationRef: RefCell<PendingKitActivation | null>;
  setPendingKitActivation: Dispatch<
    SetStateAction<PendingKitActivation | null>
  >;
  setEquipmentBusy: Dispatch<SetStateAction<boolean>>;
  flagPlacementValidationGateRef: RefCell<FlagPlacementValidationGate | null>;
  flagBuildIntentRef: RefCell<FlagBuildIntent | null>;
  setFlagBuildQueued: Dispatch<SetStateAction<QueuedFlagBuild | null>>;
  setFlagPlacementTerrain: Dispatch<SetStateAction<FlagPlacementTerrain>>;
  showBlockedFlagPlacement(
    reason: string,
    position?: { lat: number; lon: number }
  ): void;
  handleChatError(message: ErrorMessage, formattedMessage: string): boolean;
  setFoundingCity: Dispatch<SetStateAction<boolean>>;
  setCityActionBusy: Dispatch<SetStateAction<boolean>>;
  setJoiningCity: Dispatch<SetStateAction<boolean>>;
  setLeavingCity: Dispatch<SetStateAction<boolean>>;
  setPendingLeaveCityId: Dispatch<SetStateAction<string | null>>;
  requestKingdomState(): void;
  teleportRequestRef: RefCell<string | null>;
  setTeleportMode: Dispatch<
    SetStateAction<"idle" | "targeting" | "pending">
  >;
  inventoryDropRequestGateRef: RefCell<InventoryDropRequestGate>;
  inventoryStackActionRequestGateRef: RefCell<InventoryStackActionRequestGate>;
  setDroppingInventoryItemKey: Dispatch<SetStateAction<string | null>>;
  classBusy: boolean;
  setClassBusy: Dispatch<SetStateAction<boolean>>;
  setDevSubclassPending: Dispatch<SetStateAction<SubclassId | null>>;
  setDevProgressionPendingType: Dispatch<
    SetStateAction<DevProgressionType | null>
  >;
  setDevProgressionError: Dispatch<SetStateAction<string | null>>;
  setDevGrantBusy: Dispatch<SetStateAction<boolean>>;
  setDevGrantFeedback: Dispatch<SetStateAction<string | null>>;
  droppedItemPickupRequestGateRef: RefCell<DroppedItemPickupRequestGate>;
  setDroppedItems: Dispatch<SetStateAction<DroppedItemSnapshot[]>>;
  setPickupAmount: Dispatch<SetStateAction<number>>;
  harvestRequestSentRef: RefCell<string | null>;
  pendingHarvestCompletionRef: RefCell<PendingHarvestCompletion | null>;
  renderStateRef?: RefCell<RenderState>;
  presentationStoreRef: RefCell<WorldResourcePresentationStore>;
  selectedCollectibleIdRef?: RefCell<string | null>;
  setCollectibles?: Dispatch<SetStateAction<CollectibleNode[]>>;
  setSelectedCollectibleId?: Dispatch<SetStateAction<string | null>>;
  pendingHarvestCancelNodeRef: RefCell<string | null>;
  queuedHarvestReplacementRef?: RefCell<QueuedHarvestReplacement | null>;
  harvestTaskRef: RefCell<HarvestTask | null>;
  setHarvestTask: Dispatch<SetStateAction<HarvestTask | null>>;
  setHarvestStatusAnnouncement: Dispatch<SetStateAction<string>>;
  restoreOptimisticResinPresentation(): void;
  clearOptimisticResinPresentation(nodeId?: string): void;
  requestHarvestCancellation(stopMovement?: boolean): void;
  settleHarvestAfterAuthoritativeRemoval(nodeId: string): void;
  replayPendingHarvestCompletion(force?: boolean): void;
  requestNearbyCollectibles(): void;
  requestWorldResync?(reason: string): void;
  queuedMapFlagBuild: QueuedMapFlagBuildController;
  setQueuedMapFlagBuild: Dispatch<SetStateAction<QueuedMapFlagBuild | null>>;
  onQueuedMapBuildMovementRejected?(): void;
  droppedItemInteractionRef: RefCell<DroppedItemInteraction | null>;
  clearDroppedItemInteraction(options?: ClearDroppedItemOptions): boolean;
  attemptReadyDroppedItemPickup(): boolean;
  setRttMs: Dispatch<SetStateAction<number | null>>;
  observeWorldMapTravelError?(message: ErrorMessage): void;
  onXoralExitConfirmationRequired?(role: "leader" | "follower"): void;
  handleCityFlagConversionError?(
    message: ErrorMessage,
    formattedMessage: string
  ): boolean;
  handleCityConstructionError?(message: ErrorMessage): boolean;
  handleCityWarehouseError?(message: ErrorMessage): boolean;
  onEquipmentMutationError?(message: ErrorMessage): void;
  onTorchCraftingError?(message: ErrorMessage): void;
  onXoralRingDropPickupError?(message: ErrorMessage): boolean;
  showActionError(message: string): void;
}
