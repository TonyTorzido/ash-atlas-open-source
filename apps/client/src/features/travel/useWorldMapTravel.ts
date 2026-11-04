import type {
  LatLon,
  ServerMessage,
  TravelServerMessage,
  WorldMapDestination
} from "@ash-atlas/shared";
import { useCallback, useReducer, useRef } from "react";

import {
  isWorldMapTravelActive,
  worldMapTravelDurationMs,
  worldMapTravelFrameOutcome,
  worldMapTravelReducer,
  type WorldMapTravelState
} from "./worldMapTravelModel.js";

type WorldMapTravelError = Extract<ServerMessage, { type: "ERROR" }>;
type WorldMapManorError = Extract<ServerMessage, { type: "MANOR_ERROR" }>;

export function useWorldMapTravel() {
  const [state, dispatch] = useReducer(worldMapTravelReducer, { phase: "idle" });
  const stateRef = useRef<WorldMapTravelState>(state);
  const requestGateRef = useRef<string | null>(null);
  const commitRequestRef = useRef<{
    requestId: string;
    commit: (requestId: string) => string | null;
    cancel: (requestId: string) => void;
  } | null>(null);
  stateRef.current = state;

  const begin = useCallback((
    origin: LatLon,
    destination: WorldMapDestination,
    sendPrepareRequest: () => string | null,
    sendCommitRequest: (requestId: string) => string | null,
    sendCancelRequest: (requestId: string) => void = () => undefined
  ): string | null => {
    if (requestGateRef.current || isWorldMapTravelActive(stateRef.current)) {
      return null;
    }
    requestGateRef.current = "sending";
    const startedAtMs = performance.now();
    const requestId = sendPrepareRequest();
    if (!requestId) {
      requestGateRef.current = null;
      return null;
    }
    requestGateRef.current = requestId;
    commitRequestRef.current = {
      requestId,
      commit: sendCommitRequest,
      cancel: sendCancelRequest
    };
    const action = {
      type: "started",
      requestId,
      origin,
      destination,
      startedAtMs,
      durationMs: worldMapTravelDurationMs(origin, destination)
    } as const;
    stateRef.current = worldMapTravelReducer(stateRef.current, action);
    dispatch(action);
    return requestId;
  }, []);

  const observeFrame = useCallback((
    message: TravelServerMessage | WorldMapTravelError | WorldMapManorError
  ): void => {
    const outcome = worldMapTravelFrameOutcome(stateRef.current, message);
    if (!outcome) return;
    if (outcome.type === "success") {
      commitRequestRef.current = null;
      const action = {
        type: "authoritative_success",
        requestId: outcome.requestId
      } as const;
      stateRef.current = worldMapTravelReducer(stateRef.current, action);
      dispatch(action);
      return;
    }
    requestGateRef.current = null;
    commitRequestRef.current = null;
    const action = {
      type: "failed",
      requestId: outcome.requestId,
      message: outcome.message
    } as const;
    stateRef.current = worldMapTravelReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  const markPresentationComplete = useCallback((requestId: string): void => {
    const current = stateRef.current;
    if (current.phase !== "travelling" || current.requestId !== requestId) {
      return;
    }
    if (performance.now() - current.startedAtMs < current.durationMs) return;
    const action = { type: "presentation_complete", requestId } as const;
    stateRef.current = worldMapTravelReducer(stateRef.current, action);
    dispatch(action);
    if (current.authoritativeSuccess) return;
    // Preparation only warms the destination. Ask the existing authoritative
    // relocation path to commit after the dotted-route journey has finished.
    const pending = commitRequestRef.current;
    commitRequestRef.current = null;
    if (pending?.commit(requestId) !== requestId) {
      pending?.cancel(requestId);
      requestGateRef.current = null;
      const failed = {
        type: "failed", requestId,
        message: "Travel could not be completed while disconnected."
      } as const;
      stateRef.current = worldMapTravelReducer(stateRef.current, failed);
      dispatch(failed);
    }
  }, []);

  const cancel = useCallback((): boolean => {
    if (stateRef.current.phase !== "travelling") return false;
    const requestId = stateRef.current.requestId;
    commitRequestRef.current?.cancel(requestId);
    requestGateRef.current = null;
    commitRequestRef.current = null;
    const action = { type: "reset" } as const;
    stateRef.current = worldMapTravelReducer(stateRef.current, action);
    dispatch(action);
    return true;
  }, []);

  const reset = useCallback((): void => {
    requestGateRef.current = null;
    commitRequestRef.current = null;
    const action = { type: "reset" } as const;
    stateRef.current = worldMapTravelReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  return {
    state,
    begin,
    observeFrame,
    markPresentationComplete,
    cancel,
    reset
  } as const;
}
