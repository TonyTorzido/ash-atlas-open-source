import {
  INTERIOR_LOCATION_CAPABILITIES,
  WORLD_LOCATION_CAPABILITIES,
  type LocationCapabilities,
  type PlayerLocationSnapshot,
  type PortalServerMessage,
  type ServerMessage,
  type WorldViewAuthority
} from "@ash-atlas/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GameClient } from "../../gameClient.js";
import { locationSceneKey, type LocationSceneKey } from "./LocationSceneHost.js";

export type ClientPortalPhase =
  | "idle" | "requesting" | "approaching" | "threshold_reached"
  | "covered" | "committed" | "revealing" | "failed";

export function isPortalServerMessage(message: ServerMessage): message is PortalServerMessage {
  return message.type === "PORTAL_TRANSITION_PLANNED" ||
    message.type === "PORTAL_TRANSITION_PHASE" ||
    message.type === "PLAYER_LOCATION_SNAPSHOT" ||
    message.type === "PORTAL_TRANSITION_FAILED";
}

export function usePortalLocationController(
  client: React.RefObject<GameClient | null>,
  onError: (message: string) => void,
  onLocation?: (location: PlayerLocationSnapshot) => void,
  options: Readonly<{
    destinationReadinessTimeoutMs?: number;
    onDestinationReadinessTimeout?: (
      location: PlayerLocationSnapshot
    ) => void;
    isWorldPresentationReady?: () => boolean;
    isWorldPresentationAuthorityCurrent?: (
      authority: WorldViewAuthority
    ) => boolean;
  }> = {}
) {
  const {
    destinationReadinessTimeoutMs = 5_000,
    onDestinationReadinessTimeout,
    isWorldPresentationReady,
    isWorldPresentationAuthorityCurrent
  } = options;
  const [location, setLocation] = useState<PlayerLocationSnapshot | null>(null);
  const [phase, setPhase] = useState<ClientPortalPhase>("idle");
  const [transitionId, setTransitionId] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<string>("door");
  const transitionIdRef = useRef<string | null>(null);
  const plannedDestinationKindRef = useRef<"world" | "interior" | null>(null);
  const committedLocationRef = useRef<PlayerLocationSnapshot | null>(null);
  const destinationSceneKeyRef = useRef<LocationSceneKey | null>(null);
  const destinationSceneMountedRef = useRef(false);
  const destinationPresentationReadyRef = useRef(false);
  const revealFrameRef = useRef<number | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const destinationReadinessTimerRef = useRef<number | null>(null);

  const mark = useCallback((name: string): void => {
    if (import.meta.env.DEV) performance.mark(`ash-atlas:portal:${name}`);
  }, []);

  const clearReadinessTimers = useCallback((): void => {
    if (revealFrameRef.current !== null) {
      window.cancelAnimationFrame(revealFrameRef.current);
      revealFrameRef.current = null;
    }
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    if (destinationReadinessTimerRef.current !== null) {
      window.clearTimeout(destinationReadinessTimerRef.current);
      destinationReadinessTimerRef.current = null;
    }
  }, []);

  const finishReveal = useCallback((id: string): void => {
    if (transitionIdRef.current !== id) return;
    if (revealTimerRef.current !== null) return;
    mark("destination-mounted");
    setPhase("revealing");
    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = null;
      if (transitionIdRef.current !== id) return;
      setPhase("idle");
      setTransitionId(null);
      transitionIdRef.current = null;
      committedLocationRef.current = null;
      destinationSceneKeyRef.current = null;
      plannedDestinationKindRef.current = null;
      destinationSceneMountedRef.current = false;
      destinationPresentationReadyRef.current = false;
      mark("reveal-complete");
    }, 180);
  }, [mark]);

  const revealWhenDestinationReady = useCallback((): void => {
    const id = transitionIdRef.current;
    const destination = committedLocationRef.current;
    if (!id || !destination || revealFrameRef.current !== null) return;
    const destinationReady = destination.kind === "world"
      ? destinationPresentationReadyRef.current
      : destinationSceneMountedRef.current;
    if (!destinationReady) return;
    revealFrameRef.current = window.requestAnimationFrame(() => {
      revealFrameRef.current = null;
      if (transitionIdRef.current !== id) return;
      const currentDestination = committedLocationRef.current;
      const ready = currentDestination?.kind === "world"
        ? destinationPresentationReadyRef.current
        : destinationSceneMountedRef.current;
      if (ready) finishReveal(id);
    });
  }, [finishReveal]);

  const destinationSceneMounted = useCallback((sceneKey: string): void => {
    const destination = committedLocationRef.current;
    if (
      !transitionIdRef.current ||
      !destination ||
      destination.kind !== "interior" ||
      (destinationSceneKeyRef.current !== null &&
        destinationSceneKeyRef.current !== sceneKey)
    ) return;
    destinationSceneMountedRef.current = true;
    mark("destination-scene-mounted");
    revealWhenDestinationReady();
  }, [mark, revealWhenDestinationReady]);

  const destinationPresentationReady = useCallback((
    authority?: WorldViewAuthority
  ): void => {
    const destination = committedLocationRef.current;
    if (
      authority &&
      isWorldPresentationAuthorityCurrent &&
      !isWorldPresentationAuthorityCurrent(authority)
    ) return;
    if (
      !transitionIdRef.current ||
      (destination
        ? destination.kind !== "world"
        : plannedDestinationKindRef.current !== "world")
    ) return;
    destinationPresentationReadyRef.current = true;
    mark("destination-presentation-ready");
    revealWhenDestinationReady();
  }, [
    isWorldPresentationAuthorityCurrent,
    mark,
    revealWhenDestinationReady
  ]);

  useEffect(() => clearReadinessTimers, [clearReadinessTimers]);

  const handleServerMessage = useCallback((message: PortalServerMessage): void => {
    if (message.type === "PORTAL_TRANSITION_PLANNED") {
      clearReadinessTimers();
      transitionIdRef.current = message.transitionId;
      committedLocationRef.current = null;
      plannedDestinationKindRef.current = message.destination.kind;
      destinationSceneKeyRef.current = message.preloadSceneKey as LocationSceneKey;
      destinationSceneMountedRef.current = false;
      destinationPresentationReadyRef.current = false;
      setTransitionId(message.transitionId);
      setPresentation(message.presentation);
      setPhase("approaching");
      mark("plan-received");
      mark("preload-started");
      // Current scenes are bundled providers. This seam becomes an asset loader
      // without changing transition authority.
      void Promise.resolve().then(() => {
        mark("preload-ready");
        client.current?.portalDestinationReady(message.transitionId, message.preloadSceneKey);
      });
      return;
    }
    if (message.type === "PORTAL_TRANSITION_PHASE") {
      if (
        transitionIdRef.current &&
        message.transitionId !== transitionIdRef.current
      ) return;
      if (message.phase === "threshold_reached" || message.phase === "waiting_for_destination") {
        setPhase("threshold_reached");
        mark("threshold-reached");
      } else if (message.phase === "covered" || message.phase === "committing") {
        setPhase("covered");
      } else {
        setPhase("approaching");
      }
      return;
    }
    if (message.type === "PLAYER_LOCATION_SNAPSHOT") {
      setLocation(message.location);
      onLocation?.(message.location);
      if (!message.transitionId) {
        clearReadinessTimers();
        transitionIdRef.current = null;
        committedLocationRef.current = null;
        destinationSceneKeyRef.current = null;
        plannedDestinationKindRef.current = null;
        destinationSceneMountedRef.current = false;
        destinationPresentationReadyRef.current = false;
        setPhase("idle");
        setTransitionId(null);
        return;
      }
      clearReadinessTimers();
      transitionIdRef.current = message.transitionId;
      committedLocationRef.current = message.location;
      destinationSceneKeyRef.current = locationSceneKey(message.location);
      destinationSceneMountedRef.current = false;
      destinationPresentationReadyRef.current =
        message.location.kind === "world" &&
        (destinationPresentationReadyRef.current ||
          isWorldPresentationReady?.() === true);
      setPhase("committed");
      mark("server-commit");
      destinationReadinessTimerRef.current = window.setTimeout(() => {
        destinationReadinessTimerRef.current = null;
        if (
          transitionIdRef.current !== message.transitionId ||
          committedLocationRef.current === null
        ) return;
        onDestinationReadinessTimeout?.(committedLocationRef.current);
        mark("destination-readiness-timeout");
        finishReveal(message.transitionId!);
      }, destinationReadinessTimeoutMs);
      revealWhenDestinationReady();
      return;
    }
    clearReadinessTimers();
    transitionIdRef.current = null;
    committedLocationRef.current = null;
    destinationSceneKeyRef.current = null;
    plannedDestinationKindRef.current = null;
    destinationSceneMountedRef.current = false;
    destinationPresentationReadyRef.current = false;
    setLocation(message.location);
    if (message.code === "CANCELLED") {
      setPhase("idle");
      setTransitionId(null);
      return;
    }
    setPhase("failed");
    setTransitionId(null);
    onError(message.message);
    window.setTimeout(() => setPhase("idle"), 250);
  }, [
    clearReadinessTimers,
    client,
    finishReveal,
    mark,
    onError,
    onLocation,
    onDestinationReadinessTimeout,
    destinationReadinessTimeoutMs,
    isWorldPresentationReady,
    revealWhenDestinationReady
  ]);

  const capabilities: LocationCapabilities = useMemo(() =>
    location?.kind === "interior"
      ? INTERIOR_LOCATION_CAPABILITIES[location.locationType]
      : WORLD_LOCATION_CAPABILITIES,
  [location]);

  return {
    location,
    phase,
    transitionId,
    presentation,
    capabilities,
    handleServerMessage,
    destinationSceneMounted,
    destinationPresentationReady
  };
}
