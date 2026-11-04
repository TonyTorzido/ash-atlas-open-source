import type { StationStartOptions } from "../../client/domains/manorClient.js";
import {
  LOOM_INTERACTION_RADIUS_M,
  distanceMeters,
  type DroppedItemSnapshot,
  type LoomBuildSnapshot,
  type LoomStateSnapshot,
  type LoomWorldSnapshot,
  type ManorServerMessage,
  type PlayerInventorySnapshot,
  type PlayerSnapshot
} from "@ash-atlas/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ManorClient } from "../../client/domains/manorClient.js";
import {
  createFlagBuildCountdown,
  type FlagBuildCountdown
} from "../../flags/flagBuildCountdown.js";
import { getClosestReachableInteractionApproachPoint } from "../../movement/interactionApproach.js";

type Pending = {
  build: string | null;
  open: string | null;
  start: string | null;
  collect: string | null;
};

type LoomStateDestination = "app" | "prompt";
const emptyPending = (): Pending => ({ build: null, open: null, start: null, collect: null });

export type LoomMovementIntent = Readonly<{
  requestId: string;
  generation: number;
}>;

export type LoomMovementState = Readonly<LoomMovementIntent & {
  accepted: boolean;
}>;

type PendingApproach = Readonly<LoomMovementIntent & {
  loomId: string;
}>;

export function useLoomFeature(options: Readonly<{
  connectionStatus: "offline" | "connecting" | "online";
  /** Legacy compatibility; Loom access is determined by server-side exterior authority. */
  ownPlayerId?: string;
  localPlayer: PlayerSnapshot | null;
  getCommands(): ManorClient | null;
  requestMove(lat: number, lon: number): LoomMovementIntent | null;
  getMovement(): LoomMovementState | null;
  receiveInventory(snapshot: PlayerInventorySnapshot): void;
  receiveDroppedItems(drops: DroppedItemSnapshot[]): void;
  showActionError(message: string): void;
  onBuildClearanceSuggestion?(position: { lat: number; lon: number }): void;
}>) {
  const {
    connectionStatus, localPlayer, getCommands, requestMove, getMovement,
    receiveInventory, receiveDroppedItems, showActionError, onBuildClearanceSuggestion
  } = options;
  const [looms, setLooms] = useState<LoomWorldSnapshot[]>([]);
  const [selectedLoomId, setSelectedLoomId] = useState<string | null>(null);
  const [state, setState] = useState<LoomStateSnapshot | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [construction, setConstruction] = useState<Readonly<{
    requestId: string;
    build: LoomBuildSnapshot;
    countdown: FlagBuildCountdown;
  }> | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [approach, setApproach] = useState<PendingApproach | null>(null);
  const pendingRef = useRef<Pending>(emptyPending());
  const completedBuildRequestRef = useRef<string | null>(null);
  const stateDestinationRef = useRef<LoomStateDestination>("app");
  const connectionStatusRef = useRef(connectionStatus);
  connectionStatusRef.current = connectionStatus;
  const localPlayerRef = useRef(localPlayer);
  localPlayerRef.current = localPlayer;
  const [pending, setPending] = useState<Pending>(pendingRef.current);
  const updatePending = useCallback((key: keyof Pending, value: string | null): void => {
    pendingRef.current = { ...pendingRef.current, [key]: value };
    setPending(pendingRef.current);
  }, []);
  const selected = useMemo(
    () => looms.find((loom) => loom.loomId === selectedLoomId) ?? null,
    [looms, selectedLoomId]
  );

  const requestState = useCallback((
    loomId: string,
    destination: LoomStateDestination = "app"
  ): boolean => {
    if (connectionStatusRef.current !== "online" || pendingRef.current.open) return false;
    const requestId = getCommands()?.openLoom(loomId) ?? null;
    if (!requestId) return false;
    stateDestinationRef.current = destination;
    updatePending("open", requestId);
    setFeedback("Checking Loom…");
    return true;
  }, [getCommands, updatePending]);

  const select = useCallback((loom: LoomWorldSnapshot): void => {
    updatePending("open", null);
    setSelectedLoomId(loom.loomId);
    setState(null);
    setFeedback(null);
    setActionOpen(true);
    setOpen(false);
    setApproach(null);
    const currentPlayer = localPlayerRef.current;
    if (
      connectionStatusRef.current === "online" &&
      currentPlayer && distanceMeters(currentPlayer, loom) <= LOOM_INTERACTION_RADIUS_M
    ) requestState(loom.loomId, "prompt");
  }, [requestState, updatePending]);

  const weave = useCallback((loom: LoomWorldSnapshot | null = selected): boolean => {
    if (!loom) return false;
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot use a Loom while disconnected.");
      return false;
    }
    const currentPlayer = localPlayerRef.current;
    if (!currentPlayer) {
      showActionError("Your current world position is unavailable.");
      return false;
    }
    const approach = getClosestReachableInteractionApproachPoint(
      currentPlayer, loom, LOOM_INTERACTION_RADIUS_M, 2
    );
    if (approach) {
      const movement = requestMove(approach.lat, approach.lon);
      if (!movement) {
        showActionError("Could not begin walking to the Loom.");
        return false;
      }
      setActionOpen(false);
      setApproach({ loomId: loom.loomId, ...movement });
      return true;
    }
    if (distanceMeters(currentPlayer, loom) > LOOM_INTERACTION_RADIUS_M) {
      showActionError("This Loom is outside your movement range.");
      return false;
    }
    if (pendingRef.current.open) {
      stateDestinationRef.current = "app";
      setActionOpen(false);
      setApproach(null);
      return true;
    }
    if (!requestState(loom.loomId)) {
      showActionError("Could not open the Loom.");
      return false;
    }
    setActionOpen(false);
    setApproach(null);
    return true;
  }, [requestMove, requestState, selected, showActionError]);

  useEffect(() => {
    if (!approach || !localPlayer) return;
    const movement = getMovement();
    if (
      !movement ||
      movement.requestId !== approach.requestId ||
      movement.generation !== approach.generation
    ) {
      setApproach(null);
      return;
    }
    if (!movement.accepted || localPlayer.moving) return;
    const loom = looms.find((candidate) => candidate.loomId === approach.loomId);
    if (!loom || distanceMeters(localPlayer, loom) > LOOM_INTERACTION_RADIUS_M) return;
    setApproach(null);
    if (!requestState(loom.loomId)) {
      setActionOpen(true);
      showActionError("Could not open the Loom.");
    }
  }, [approach, getMovement, looms, localPlayer, requestState, showActionError]);

  useEffect(() => {
    const nextCompletesAt = state?.jobs.find((job) => !job.productionFinished)?.completesAt;
    if ((!open && !actionOpen) || !nextCompletesAt) return;
    const delay = Math.max(0, Date.parse(nextCompletesAt) - Date.now() + 150);
    const timer = window.setTimeout(
      () => requestState(state.loom.loomId, actionOpen ? "prompt" : "app"), delay
    );
    return () => window.clearTimeout(timer);
  }, [actionOpen, open, requestState, state]);

  const handleServerMessage = useCallback((message: ManorServerMessage): void => {
    switch (message.type) {
      case "LOOMS_SNAPSHOT":
        setLooms(message.looms);
        if (
          construction &&
          message.looms.some((loom) =>
            distanceMeters(loom, construction.build.position) <= 1
          )
        ) {
          completedBuildRequestRef.current = construction.requestId;
          updatePending("build", null);
          setConstruction(null);
        }
        return;
      case "LOOM_BUILD_RESULT":
        if (
          message.requestId !== pendingRef.current.build &&
          message.requestId !== construction?.requestId &&
          message.requestId !== completedBuildRequestRef.current
        ) return;
        completedBuildRequestRef.current = null;
        updatePending("build", null);
        setConstruction(null);
        setLooms((current) => upsert(current, message.loom));
        receiveInventory(message.inventory);
        setFeedback(null);
        return;
      case "LOOM_BUILD_STARTED":
        if (pendingRef.current.build && message.requestId !== pendingRef.current.build) return;
        completedBuildRequestRef.current = null;
        updatePending("build", null);
        setConstruction({
          requestId: message.requestId,
          build: message.build,
          countdown: createFlagBuildCountdown({
            startedAt: message.build.startedAt, completesAt: message.build.completesAt,
            durationMs: message.build.durationMs, serverTime: message.serverTime
          }, performance.now())
        });
        receiveInventory(message.inventory);
        setFeedback(message.replayed ? "Loom construction resumed." : "Loom construction started.");
        return;
      case "LOOM_BUILD_CANCELLED":
        if (message.requestId !== pendingRef.current.build && message.requestId !== construction?.requestId) return;
        completedBuildRequestRef.current = null;
        updatePending("build", null);
        setConstruction(null);
        receiveInventory(message.inventory);
        receiveDroppedItems(message.droppedItems);
        setFeedback(message.message);
        showActionError(message.message);
        return;
      case "LOOM_STATE": {
        if (message.requestId && message.requestId !== pendingRef.current.open) return;
        const destination = stateDestinationRef.current;
        updatePending("open", null);
        setState(message.state);
        setSelectedLoomId(message.state.loom.loomId);
        setActionOpen(destination === "prompt");
        setOpen(destination === "app");
        setFeedback(null);
        return;
      }
      case "LOOM_BATCH_STARTED":
        if (message.requestId !== pendingRef.current.start) return;
        updatePending("start", null);
        setState(message.state);
        receiveInventory(message.inventory);
        setFeedback(message.replayed ? "Weaving job already started." : "Weaving started.");
        return;
      case "LOOM_OUTPUT_COLLECTED":
        if (message.requestId !== pendingRef.current.collect) return;
        updatePending("collect", null);
        setState(message.state);
        receiveInventory(message.inventory);
        setFeedback(message.collectedQuantity > 0
          ? `Collected ${message.collectedQuantity} Cloth.`
          : "Inventory is full; the finished Cloth remains in the Loom.");
        return;
      case "LOOM_ERROR": {
        const matches = !message.requestId || Object.values(pendingRef.current).includes(message.requestId);
        if (!matches) return;
        if (message.requestId === pendingRef.current.build) updatePending("build", null);
        if (message.requestId === pendingRef.current.open) updatePending("open", null);
        if (message.requestId === pendingRef.current.start) updatePending("start", null);
        if (message.requestId === pendingRef.current.collect) updatePending("collect", null);
        setApproach(null);
        setFeedback(message.message);
        if (message.code === "OUTDOOR_STATION_CLEARANCE_REQUIRED" && message.suggestedPosition) {
          onBuildClearanceSuggestion?.(message.suggestedPosition);
          return;
        }
        showActionError(message.message);
        return;
      }
      default:
        return;
    }
  }, [construction?.requestId, onBuildClearanceSuggestion, receiveDroppedItems, receiveInventory, showActionError, updatePending]);

  const build = useCallback((): boolean => {
    if (connectionStatus !== "online") {
      showActionError("Cannot build a Loom while disconnected.");
      return false;
    }
    if (pendingRef.current.build || construction) {
      showActionError("A Loom build is already in progress.");
      return false;
    }
    const requestId = getCommands()?.buildLoom() ?? null;
    if (!requestId) {
      showActionError("Could not send the Loom build request. Check your connection and try again.");
      return false;
    }
    updatePending("build", requestId);
    setFeedback(null);
    return true;
  }, [connectionStatus, construction, getCommands, showActionError, updatePending]);

  const start = useCallback((quantity: number, recipeId = "flax_fiber", options: StationStartOptions = {}): boolean => {
    const loomId = state?.loom.loomId;
    if (!loomId) {
      showActionError("The Loom state is unavailable. Close it and try again.");
      return false;
    }
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot start a Loom job while disconnected.");
      return false;
    }
    if (pendingRef.current.start) return false;
    const requestId = getCommands()?.startLoomBatch(loomId, quantity, recipeId, options) ?? null;
    if (!requestId) {
      showActionError("Could not send the Loom job. Check your connection and try again.");
      return false;
    }
    updatePending("start", requestId);
    setFeedback(null);
    return true;
  }, [getCommands, showActionError, state?.loom.loomId, updatePending]);

  const collect = useCallback((): void => {
    const loomId = state?.loom.loomId;
    if (!loomId || pendingRef.current.collect) return;
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot collect Loom output while disconnected.");
      return;
    }
    const requestId = getCommands()?.collectLoomOutput(loomId) ?? null;
    if (!requestId) {
      showActionError("Could not send the Loom collection request. Check your connection and try again.");
      return;
    }
    updatePending("collect", requestId);
    setFeedback(null);
  }, [getCommands, showActionError, state?.loom.loomId, updatePending]);

  const close = useCallback((): void => {
    updatePending("open", null);
    stateDestinationRef.current = "app";
    setActionOpen(false);
    setOpen(false);
    setApproach(null);
    setSelectedLoomId(null);
    setState(null);
    setFeedback(null);
  }, [updatePending]);

  return {
    view: {
      looms, selected, selectedLoomId, state, actionOpen, open, construction,
      feedback, approaching: approach !== null, pending
    },
    actions: {
      select, weave, close, build, start, collect,
      refresh: requestState, setSelectedLoomId, handleServerMessage
    }
  };
}

function upsert(current: LoomWorldSnapshot[], loom: LoomWorldSnapshot): LoomWorldSnapshot[] {
  return [...current.filter((candidate) => candidate.loomId !== loom.loomId), loom];
}
