import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import type { ManorClient } from "../../client/domains/manorClient.js";
import type { ManorMovementTimeline } from "../../movement/manorMovementTimeline.js";
import type { ManorClientSession, ManorPendingRequests } from "./manorFeatureContracts.js";
import {
  manorInteractionApproachPoint,
  manorInteractionInRange,
  type ManorInteractionIntent,
  type ManorInteractionKind
} from "./manorInteraction.js";

interface ManorInteractionActionOptions {
  connectionStatus: "offline" | "connecting" | "online";
  getCommands(): ManorClient | null;
  movementTimelineRef: MutableRefObject<ManorMovementTimeline>;
  pendingRef: MutableRefObject<ManorPendingRequests>;
  sessionRef: MutableRefObject<ManorClientSession | null>;
  interactionIntentRef: MutableRefObject<ManorInteractionIntent>;
  interactionTokenRef: MutableRefObject<number>;
  setInteractionIntent: Dispatch<SetStateAction<ManorInteractionIntent>>;
  setFeedback: Dispatch<SetStateAction<string | null>>;
  setSmithOpen: Dispatch<SetStateAction<boolean>>;
  setJewelOpen: Dispatch<SetStateAction<boolean>>;
  setBreederOpen: Dispatch<SetStateAction<boolean>>;
}

export function useManorInteractionActions({
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
}: ManorInteractionActionOptions) {
  const replaceInteractionIntent = useCallback((intent: ManorInteractionIntent): void => {
    interactionIntentRef.current = intent;
    setInteractionIntent(intent);
  }, [setInteractionIntent]);

  const sendInteractionRequest = useCallback((
    kind: ManorInteractionKind,
    token: number,
    retryCount: number
  ): boolean => {
    const current = sessionRef.current;
    const commands = getCommands();
    if (!current || !commands || connectionStatus !== "online") return false;
    if (token !== interactionTokenRef.current) return false;
    if (kind === "door") {
      if (pendingRef.current.exit) return false;
      const requestId = commands.exitManor(current.sessionId);
      if (!requestId) return false;
      pendingRef.current.exit = requestId;
      setFeedback("Leaving manor...");
      setSmithOpen(false);
      setJewelOpen(false);
      setBreederOpen(false);
    } else if (kind === "smith") {
      const position = movementTimelineRef.current.latestAuthorityPosition();
      if (!position || position.moving || !manorInteractionInRange("smith", position, sessionRef.current?.manorTypeId)) return false;
      setSmithOpen(true);
      replaceInteractionIntent(null);
      setFeedback(null);
      return true;
    } else if (kind === "jewel") {
      const position = movementTimelineRef.current.latestAuthorityPosition();
      if (!position || position.moving || !manorInteractionInRange("jewel", position, sessionRef.current?.manorTypeId)) return false;
      setJewelOpen(true);
      replaceInteractionIntent(null);
      setFeedback(null);
      return true;
    } else {
      const position = movementTimelineRef.current.latestAuthorityPosition();
      if (!position || position.moving || !manorInteractionInRange("breeder", position, sessionRef.current?.manorTypeId)) return false;
      setBreederOpen(true);
      replaceInteractionIntent(null);
      setFeedback(null);
      return true;
    }
    replaceInteractionIntent({
      kind,
      phase: "requesting",
      token,
      retryCount,
      minimumMovementSequence: movementTimelineRef.current.currentSequence()
    });
    return true;
  }, [
    connectionStatus,
    getCommands,
    movementTimelineRef,
    replaceInteractionIntent,
    setBreederOpen,
    setFeedback,
    setJewelOpen,
    setSmithOpen
  ]);

  const moveForInteraction = useCallback((
    kind: ManorInteractionKind,
    token: number,
    retryCount: number,
    forceApproach = false
  ): boolean => {
    const current = sessionRef.current;
    const commands = getCommands();
    const position = movementTimelineRef.current.latestAuthorityPosition();
    if (!current || !commands || connectionStatus !== "online" || !position) return false;
    if (!forceApproach && !position.moving && manorInteractionInRange(kind, position, current.manorTypeId)) {
      return sendInteractionRequest(kind, token, retryCount);
    }
    const [x, y] = manorInteractionApproachPoint(kind, position, current.manorTypeId);
    const minimumMovementSequence = movementTimelineRef.current.currentSequence() + 1;
    const requestId = commands.manorMoveTo(current.sessionId, x, y);
    if (!requestId) return false;
    pendingRef.current.move = requestId;
    replaceInteractionIntent({
      kind,
      phase: "moving",
      token,
      retryCount,
      minimumMovementSequence
    });
    setFeedback(
      kind === "smith"
        ? "Approaching the Smithing Station..."
        : kind === "jewel"
          ? "Approaching the Jewel Station..."
          : kind === "breeder"
            ? "Approaching the Breeder's Kennel..."
            : "Approaching the door..."
    );
    return true;
  }, [
    connectionStatus,
    getCommands,
    movementTimelineRef,
    replaceInteractionIntent,
    sendInteractionRequest,
    setFeedback
  ]);

  const requestInteraction = useCallback((kind: ManorInteractionKind): boolean => {
    const active = interactionIntentRef.current;
    if (active?.kind === kind) return false;
    if (active?.phase === "requesting" && active.kind === "door") return false;
    const token = ++interactionTokenRef.current;
    replaceInteractionIntent(null);
    return moveForInteraction(kind, token, 0);
  }, [moveForInteraction, replaceInteractionIntent]);

  const cancelInteraction = useCallback((): void => {
    const active = interactionIntentRef.current;
    if (active?.phase === "requesting" && active.kind === "door") return;
    interactionTokenRef.current += 1;
    replaceInteractionIntent(null);
    setFeedback(null);
  }, [replaceInteractionIntent, setFeedback]);

  return {
    replaceInteractionIntent,
    sendInteractionRequest,
    moveForInteraction,
    requestInteraction,
    cancelInteraction
  };
}
