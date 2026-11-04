import type {
  PremiumWalletSnapshot,
  ManorWorldSnapshot,
  ManorServerMessage,
  PlayerInventorySnapshot,
  PlayerSnapshot,
  TravelServerMessage
} from "@ash-atlas/shared";
import { useCallback } from "react";

import type { ManorClient } from "../../client/domains/manorClient.js";
import { manorInteractionInRange } from "./manorInteraction.js";
import { emptyPendingRequests } from "./manorFeatureContracts.js";
import { useManorFeatureResult } from "./manorFeatureResult.js";
import { useManorFeatureState } from "./useManorFeatureState.js";
import { useManorInteractionActions } from "./useManorInteractionActions.js";

export {
  isManorServerMessage,
  type LocationMode,
  type ManorClientSession
} from "./manorFeatureContracts.js";

export interface ManorFeatureOptions {
  connectionStatus: "offline" | "connecting" | "online";
  ownPlayerId: string;
  getCommands(): ManorClient | null;
  observeWorldMapTravelError?(
    message: Extract<ManorServerMessage, { type: "MANOR_ERROR" }>
  ): void;
  showActionError(message: string): void;
  onEntered(): void;
  onExited(player: PlayerSnapshot, resourceVisionRevision?: number): void;
  onInventorySnapshot?(snapshot: PlayerInventorySnapshot): void;
  onWalletUpdate?(gold: string, revision: string): void;
  onPremiumWalletSnapshot?(snapshot: PremiumWalletSnapshot): void;
  onBeforeEnter(): void;
}

export function useManorFeature(options: ManorFeatureOptions) {
  const {
    connectionStatus,
    ownPlayerId,
    getCommands,
    observeWorldMapTravelError,
    showActionError,
    onEntered,
    onExited,
    onInventorySnapshot,
    onWalletUpdate,
    onPremiumWalletSnapshot,
    onBeforeEnter
  } = options;
  const {
    manors,
    setManors,
    ownManor,
    setOwnManor,
    selectedManorId,
    setSelectedManorId,
    panelOpen,
    setPanelOpen,
    buildPanelOpen,
    setBuildPanelOpen,
    session,
    setSession,
    smithOpen,
    setSmithOpen,
    jewelOpen,
    setJewelOpen,
    breederOpen,
    setBreederOpen,
    interactionIntent,
    setInteractionIntent,
    guests,
    setGuests,
    occupants,
    setOccupants,
    guestPanelOpen,
    setGuestPanelOpen,
    feedback,
    setFeedback,
    decorations,
    setDecorations,
    manorEquipmentDrops,
    setManorEquipmentDrops,
    locationMode,
    setLocationMode,
    movementTimelineRef,
    pendingRef,
    sessionRef,
    locationModeRef,
    pendingWorldRestoreRef,
    displayColorRef,
    interactionIntentRef,
    interactionTokenRef
  } = useManorFeatureState();

  const {
    replaceInteractionIntent,
    sendInteractionRequest,
    moveForInteraction,
    requestInteraction,
    cancelInteraction
  } = useManorInteractionActions({
    connectionStatus,
    getCommands,
    movementTimelineRef,
    pendingRef,
    sessionRef,
    interactionIntentRef,
    interactionTokenRef,
    setInteractionIntent,
    setFeedback,
    setSmithOpen,
    setJewelOpen,
    setBreederOpen
  });

  const handleServerMessage = useCallback((message: ManorServerMessage): void => {
    const pending = pendingRef.current;
    switch (message.type) {
      case "MANOR_STATUS":
        setOwnManor(message.manor);
        if (message.manor) {
          const updated = message.manor;
          setManors((current) => current.map((manor) => manor.manorId === updated.manorId ? updated : manor));
        }
        return;
      case "MANORS_SNAPSHOT":
        setManors(message.manors);
        return;
      case "MANOR_WORLD_UPDATED": {
        const updated = message.manor;
        setManors((current) => current.map((manor) => manor.manorId === updated.manorId ? updated : manor));
        setOwnManor((current) => current?.manorId === updated.manorId ? updated : current);
        return;
      }
      case "MANOR_WARFARE_CHANGED":
        if (message.action === "attack") {
          setFeedback(message.replayed ? "That attack was already counted." : `Hit the Manor for ${message.damage ?? 0}.`);
        } else if (message.action === "repair_started") {
          setFeedback("Repairing. Stay beside the Manor.");
        } else {
          setFeedback(null);
        }
        return;
      case "MANOR_BUILD_RESULT":
        if (message.requestId !== pending.build) return;
        pending.build = null;
        if (message.inventory) onInventorySnapshot?.(message.inventory);
        setOwnManor(message.manor);
        setManors((current) => upsertManor(current, message.manor));
        setSelectedManorId(message.manor.manorId);
        setBuildPanelOpen(false);
        setFeedback(null);
        return;
      case "MANOR_SKIN_RESULT":
        if (message.requestId === pending.skin) pending.skin = null;
        onInventorySnapshot?.(message.inventory);
        if (message.premiumWallet) onPremiumWalletSnapshot?.(message.premiumWallet);
        if (message.manor) {
          const updated = message.manor;
          setOwnManor(updated);
          setManors((current) => current.map((manor) => manor.manorId === updated.manorId ? updated : manor));
        }
        setFeedback(message.message);
        return;
      case "MANOR_DESTROY_RESULT":
        if (message.requestId !== pending.destroy) return;
        pending.destroy = null;
        setOwnManor(null);
        setManors((current) => current.filter((manor) => manor.manorId !== message.manorId));
        setSelectedManorId(null);
        setPanelOpen(false);
        setDecorations(null);
        setManorEquipmentDrops([]);
        replaceInteractionIntent(null);
        setSmithOpen(false);
        setFeedback(null);
        return;
      case "MANOR_ENTRY_PENDING":
        if (message.requestId !== pending.entry) return;
        setFeedback(message.message);
        return;
      case "MANOR_GUESTS":
        setGuests(message.snapshot);
        return;
      case "MANOR_OCCUPANTS":
        if (message.manorId === sessionRef.current?.manorId) {
          setOccupants(message.occupants);
        }
        return;
      case "MANOR_DECORATIONS_SNAPSHOT":
        if (message.requestId !== "broadcast" && message.requestId !== pending.decorations) return;
        if (message.requestId === pending.decorations) pending.decorations = null;
        if (message.requestId === pending.skin) pending.skin = null;
        setDecorations(message.snapshot);
        return;
      case "MANOR_DECORATION_UPDATED":
        if (message.requestId !== pending.decorations) return;
        pending.decorations = null;
        setDecorations(message.snapshot);
        onInventorySnapshot?.(message.inventory);
        setFeedback(`${message.message}${message.replayed ? " (already applied)" : ""}`);
        return;
      case "MANOR_EQUIPMENT_DROPS_UPDATED":
        if (message.manorId !== sessionRef.current?.manorId) return;
        setManorEquipmentDrops(message.drops.filter((drop) => drop.manorId === message.manorId));
        return;
      case "MANOR_ENTERED":
        if (message.requestId && message.requestId !== pending.entry) return;
        pending.entry = null;
        pending.exit = null;
        pending.move = null;
        replaceInteractionIntent(null);
        displayColorRef.current = message.displayColor;
        movementTimelineRef.current.start(
          message.manorSessionId,
          message.position,
          message.movementSequence,
          message.serverTime,
          performance.now()
        );
        setSession({
          manorId: message.manorId,
          spaceId: message.spaceId ?? "manor_main_room",
          ...(message.manorTypeId ? { manorTypeId: message.manorTypeId } : {}),
          sessionId: message.manorSessionId,
          accessSource: message.accessSource,
          ...(message.appearance ? { appearance: message.appearance } : {})
        });
        setDecorations(message.decorations ?? null);
        setManorEquipmentDrops((message.droppedItems ?? []).filter((drop) => drop.manorId === message.manorId));
        setOccupants([]);
        setLocationMode("manor");
        setPanelOpen(false);
        setSelectedManorId(null);
        setSmithOpen(false);
        setFeedback(null);
        onEntered();
        return;
      case "MANOR_POSITION":
        {
        setSession((current) => current?.sessionId === message.manorSessionId
          ? { ...current, spaceId: message.spaceId ?? current.spaceId ?? "manor_main_room" }
          : current);
        const previousMovementSequence = movementTimelineRef.current.currentSequence();
        if (movementTimelineRef.current.applySnapshot(
          message.manorSessionId,
          message.position,
          message.movementSequence,
          message.serverTime,
          performance.now()
        ) === "ignored") return;
        if (
          pending.move &&
          message.movementSequence > previousMovementSequence
        ) {
          pending.move = null;
        }
        {
          const intent = interactionIntentRef.current;
          if (
            intent?.phase === "moving" &&
            message.movementSequence >= intent.minimumMovementSequence &&
            !message.position.moving &&
            manorInteractionInRange(intent.kind, message.position, sessionRef.current?.manorTypeId)
          ) {
            sendInteractionRequest(intent.kind, intent.token, intent.retryCount);
          }
        }
        return;
        }
      case "MANOR_EXITED":
        if (pending.exit && message.requestId && message.requestId !== pending.exit) return;
        pending.exit = null;
        pending.move = null;
        replaceInteractionIntent(null);
        movementTimelineRef.current.clear();
        setSession(null);
        setDecorations(null);
        setManorEquipmentDrops([]);
        setSmithOpen(false);
        setFeedback(null);
        pendingWorldRestoreRef.current = message.player;
        setLocationMode("world");
        setGuestPanelOpen(false);
        setGuests(null);
        setOccupants([]);
        onExited(message.player, message.resourceVisionRevision);
        return;
      case "MANOR_ERROR": {
        observeWorldMapTravelError?.(message);
        const matches = !message.requestId || Object.values(pending).includes(message.requestId);
        if (!matches) return;
        const intent = interactionIntentRef.current;
        const matchingRangeFailure =
          intent?.phase === "requesting" &&
          intent.retryCount === 0 &&
          (
            intent.kind === "door" &&
            message.requestId === pending.exit &&
            message.code === "DOOR_OUT_OF_RANGE"
          );
        if (matchingRangeFailure && intent) {
          pending.exit = null;
          moveForInteraction(intent.kind, intent.token, 1, true);
          return;
        }
        if (message.requestId === pending.build) pending.build = null;
        if (message.requestId === pending.destroy) pending.destroy = null;
        if (message.requestId === pending.jump) pending.jump = null;
        if (message.requestId === pending.entry) {
          pending.entry = null;
          setLocationMode("world");
        }
        if (message.requestId === pending.exit) {
          pending.exit = null;
          setLocationMode("manor");
        }
        if (message.requestId === pending.decorations) pending.decorations = null;
        if (message.requestId === pending.skin) pending.skin = null;
        const movementFailure = message.requestId === pending.move;
        if (movementFailure) {
          pending.move = null;
          if (intent?.phase === "moving") replaceInteractionIntent(null);
        }
        if (
          message.requestId === pending.exit ||
          movementFailure ||
          intent?.phase === "requesting"
        ) {
          replaceInteractionIntent(null);
        }
        setFeedback(message.message);
        showActionError(message.message);
      }
    }
  }, [
    moveForInteraction,
    observeWorldMapTravelError,
    onEntered,
    onExited,
    onInventorySnapshot,
    onPremiumWalletSnapshot,
    replaceInteractionIntent,
    sendInteractionRequest,
    showActionError
  ]);

  const requestBuild = useCallback((): void => {
    if (connectionStatus !== "online" || ownManor || pendingRef.current.build) return;
    const requestId = getCommands()?.buildManor();
    if (!requestId) {
      showActionError("Cannot build the manor while disconnected.");
      return;
    }
    pendingRef.current.build = requestId;
    setFeedback(null);
  }, [connectionStatus, getCommands, ownManor, showActionError]);

  const selectedManor = manors.find((manor) => manor.manorId === selectedManorId) ?? null;
  const requestDestroy = useCallback((): void => {
    if (connectionStatus !== "online" || !ownManor || pendingRef.current.destroy) return;
    if (selectedManor?.manorId !== ownManor.manorId || selectedManor.ownerPlayerId !== ownPlayerId) {
      showActionError("Select your manor before destroying it.");
      return;
    }
    const requestId = getCommands()?.destroyManor();
    if (!requestId) {
      showActionError("Cannot destroy the manor while disconnected.");
      return;
    }
    pendingRef.current.destroy = requestId;
    setFeedback(null);
  }, [connectionStatus, getCommands, ownManor, ownPlayerId, selectedManor, showActionError]);

  /** Equip a skin from the inventory (the default type unequips); the item stays in the inventory. */
  const requestEquipSkin = useCallback((manorTypeId: string, copyId?: string): boolean => {
    if (connectionStatus !== "online" || !ownManor || pendingRef.current.skin) return false;
    const requestId = getCommands()?.installManorSkin(manorTypeId, copyId);
    if (!requestId) {
      showActionError("Cannot change the manor skin while disconnected.");
      return false;
    }
    pendingRef.current.skin = requestId;
    setFeedback(null);
    return true;
  }, [connectionStatus, getCommands, ownManor, showActionError]);

  const requestJump = useCallback((
    manorId = selectedManor?.manorId ?? ownManor?.manorId,
    travelRequestId?: string
  ): string | null => {
    if (!manorId || connectionStatus !== "online" || pendingRef.current.jump) return null;
    const requestId = getCommands()?.jumpToManor(manorId, travelRequestId);
    if (!requestId) {
      showActionError("Cannot travel to the manor while disconnected.");
      return null;
    }
    pendingRef.current.jump = requestId;
    setPanelOpen(false);
    setSelectedManorId(null);
    setFeedback("Traveling to manor…");
    return requestId;
  }, [connectionStatus, getCommands, ownManor?.manorId, selectedManor?.manorId, showActionError]);

  const requestEnter = useCallback((manorId = selectedManor?.manorId): boolean => {
    if (connectionStatus !== "online" || pendingRef.current.entry) return false;
    if (!manorId) {
      showActionError("Select a manor before entering.");
      return false;
    }
    const requestId = getCommands()?.enterManor(manorId);
    if (!requestId) {
      showActionError("Cannot enter the manor while disconnected.");
      return false;
    }
    onBeforeEnter();
    pendingRef.current.entry = requestId;
    setFeedback("Entering manor…");
    return true;
  }, [connectionStatus, getCommands, onBeforeEnter, selectedManor?.manorId, showActionError]);

  const requestGuests = useCallback((manorId = selectedManor?.manorId ?? session?.manorId): void => {
    if (!manorId || !getCommands()?.requestManorGuests(manorId)) return;
    setGuestPanelOpen(true);
  }, [getCommands, selectedManor?.manorId, session?.manorId]);

  const requestExit = useCallback((): void => {
    if (!requestInteraction("door") && connectionStatus !== "online") {
      showActionError("Cannot exit while disconnected.");
    }
  }, [connectionStatus, requestInteraction, showActionError]);

  const requestMove = useCallback((x: number, y: number): string | null => {
    const current = sessionRef.current;
    if (!current || locationModeRef.current !== "manor") return null;
    if (
      interactionIntentRef.current?.kind === "door" &&
      interactionIntentRef.current.phase === "requesting"
    ) return null;
    setSmithOpen(false);
    setJewelOpen(false);
    setBreederOpen(false);
    cancelInteraction();
    const requestId = getCommands()?.manorMoveTo(current.sessionId, x, y) ?? null;
    if (requestId) pendingRef.current.move = requestId;
    return requestId;
  }, [cancelInteraction, getCommands]);

  const requestOpenSmith = useCallback((): void => {
    requestInteraction("smith");
  }, [requestInteraction]);

  const requestOpenJewel = useCallback((): void => {
    requestInteraction("jewel");
  }, [requestInteraction]);

  const requestOpenBreeder = useCallback((): void => {
    requestInteraction("breeder");
  }, [requestInteraction]);

  const requestManorDecorations = useCallback((): boolean => {
    const current = sessionRef.current;
    if (!current || connectionStatus !== "online" || pendingRef.current.decorations) return false;
    const requestId = getCommands()?.requestManorDecorations(current.sessionId);
    if (!requestId) return false;
    pendingRef.current.decorations = requestId;
    return true;
  }, [connectionStatus, getCommands]);

  const placeManorDecoration = useCallback((definitionId: string, x?: number, y?: number): boolean => {
    const current = sessionRef.current;
    if (!current || current.accessSource !== "OWNER" || connectionStatus !== "online" || pendingRef.current.decorations) return false;
    const requestId = getCommands()?.placeManorDecoration(current.sessionId, definitionId, x, y);
    if (!requestId) return false;
    pendingRef.current.decorations = requestId;
    setFeedback("Placing Manor decoration…");
    return true;
  }, [connectionStatus, getCommands]);

  const moveManorDecoration = useCallback((placementId: string, x: number, y: number): boolean => {
    const current = sessionRef.current;
    if (!current || current.accessSource !== "OWNER" || connectionStatus !== "online" || pendingRef.current.decorations) return false;
    const requestId = getCommands()?.moveManorDecoration(current.sessionId, placementId, x, y);
    if (!requestId) return false;
    pendingRef.current.decorations = requestId;
    setFeedback("Saving Manor decoration placement…");
    return true;
  }, [connectionStatus, getCommands]);

  const removeManorDecoration = useCallback((placementId: string): boolean => {
    const current = sessionRef.current;
    if (!current || current.accessSource !== "OWNER" || connectionStatus !== "online" || pendingRef.current.decorations) return false;
    const requestId = getCommands()?.removeManorDecoration(current.sessionId, placementId);
    if (!requestId) return false;
    pendingRef.current.decorations = requestId;
    setFeedback("Returning Manor decoration to inventory…");
    return true;
  }, [connectionStatus, getCommands]);

  const cancelEntry = useCallback((): void => {
    if (!pendingRef.current.entry) return;
    getCommands()?.cancelManorEntry();
    pendingRef.current.entry = null;
    setLocationMode("world");
  }, [getCommands]);

  const onDisconnected = useCallback((): void => {
    pendingRef.current = emptyPendingRequests();
    setDecorations(null);
    setManorEquipmentDrops([]);
    setSmithOpen(false);
    setJewelOpen(false);
    setBreederOpen(false);
    replaceInteractionIntent(null);
    setFeedback(null);
  }, [replaceInteractionIntent]);

  const handleTravelResult = useCallback((
    message: Extract<TravelServerMessage, { type: "TRAVEL_RESULT" }>
  ): void => {
    if (message.kind !== "manor_jump" || message.requestId !== pendingRef.current.jump) return;
    pendingRef.current.jump = null;
    if (message.success) {
      setFeedback(null);
    }
  }, []);

  const pending = pendingRef.current;
  return useManorFeatureResult({
    manors,
    ownManor,
    selectedManor,
    selectedManorId,
    panelOpen,
    buildPanelOpen,
    session,
    smithOpen,
    jewelOpen,
    breederOpen,
    interactionIntent,
    guests,
    occupants,
    guestPanelOpen,
    feedback,
    decorations,
    manorEquipmentDrops,
    locationMode,
    pending,
    movementTimelineRef,
    pendingWorldRestoreRef,
    displayColorRef,
    locationModeRef,
    sessionRef,
    setSelectedManorId,
    setPanelOpen,
    setBuildPanelOpen,
    setSmithOpen,
    setJewelOpen,
    setGuestPanelOpen,
    setFeedback,
    requestBuild,
    requestDestroy,
    requestEquipSkin,
    requestJump,
    requestEnter,
    requestGuests,
    requestExit,
    requestMove,
    requestOpenSmith,
    requestOpenJewel,
    requestOpenBreeder,
    requestManorDecorations,
    placeManorDecoration,
    moveManorDecoration,
    removeManorDecoration,
    setManorEquipmentDrops,
    requestInteraction,
    cancelInteraction,
    cancelEntry,
    getCommands,
    handleServerMessage,
    handleTravelResult,
    onDisconnected
  });
}

function upsertManor(
  manors: ManorWorldSnapshot[],
  next: ManorWorldSnapshot
): ManorWorldSnapshot[] {
  return manors.some((manor) => manor.manorId === next.manorId)
    ? manors.map((manor) => manor.manorId === next.manorId ? next : manor)
    : [...manors, next];
}
