import type { StationStartOptions } from "../../client/domains/manorClient.js";
import {
  TANNERY_INTERACTION_RADIUS_M,
  distanceMeters,
  type DroppedItemSnapshot,
  type TanneryBuildSnapshot,
  type TanneryStateSnapshot,
  type TanneryRecipeId,
  type TanneryWorldSnapshot,
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
import { getClosestInteractionApproachPoint } from "../../movement/interactionApproach.js";

type Pending = {
  build: string | null;
  open: string | null;
  start: string | null;
  collect: string | null;
};

type TanneryStateDestination = "app" | "prompt";

const emptyPending = (): Pending => ({ build: null, open: null, start: null, collect: null });

export function useTanneryFeature(options: Readonly<{
  connectionStatus: "offline" | "connecting" | "online";
  ownPlayerId: string;
  localPlayer: PlayerSnapshot | null;
  getCommands(): ManorClient | null;
  requestMove(lat: number, lon: number): boolean;
  receiveInventory(snapshot: PlayerInventorySnapshot): void;
  receiveDroppedItems(drops: DroppedItemSnapshot[]): void;
  showActionError(message: string): void;
  onBuildClearanceSuggestion?(position: { lat: number; lon: number }): void;
}>) {
  const {
    connectionStatus,
    ownPlayerId,
    localPlayer,
    getCommands,
    requestMove,
    receiveInventory,
    receiveDroppedItems,
    showActionError,
    onBuildClearanceSuggestion
  } = options;
  const [tanneries, setTanneries] = useState<TanneryWorldSnapshot[]>([]);
  const [selectedTanneryId, setSelectedTanneryId] = useState<string | null>(null);
  const [state, setState] = useState<TanneryStateSnapshot | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [construction, setConstruction] = useState<Readonly<{
    requestId: string;
    build: TanneryBuildSnapshot;
    countdown: FlagBuildCountdown;
  }> | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [approachingId, setApproachingId] = useState<string | null>(null);
  const pendingRef = useRef<Pending>(emptyPending());
  const stateDestinationRef = useRef<TanneryStateDestination>("app");
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
    () => tanneries.find((tannery) => tannery.tanneryId === selectedTanneryId) ?? null,
    [tanneries, selectedTanneryId]
  );

  const requestState = useCallback((
    tanneryId: string,
    destination: TanneryStateDestination = "app"
  ): boolean => {
    if (connectionStatusRef.current !== "online" || pendingRef.current.open) return false;
    const requestId = getCommands()?.openTannery(tanneryId) ?? null;
    if (!requestId) return false;
    stateDestinationRef.current = destination;
    updatePending("open", requestId);
    setFeedback("Checking Tannery…");
    return true;
  }, [getCommands, updatePending]);

  const select = useCallback((tannery: TanneryWorldSnapshot): void => {
    updatePending("open", null);
    setSelectedTanneryId(tannery.tanneryId);
    setState(null);
    setFeedback(null);
    setActionOpen(true);
    setOpen(false);
    setApproachingId(null);
    const currentPlayer = localPlayerRef.current;
    if (
      tannery.ownerPlayerId === ownPlayerId &&
      connectionStatusRef.current === "online" &&
      currentPlayer &&
      distanceMeters(currentPlayer, tannery) <= TANNERY_INTERACTION_RADIUS_M
    ) {
      requestState(tannery.tanneryId, "prompt");
    }
  }, [ownPlayerId, requestState, updatePending]);

  const batch = useCallback((tannery: TanneryWorldSnapshot | null = selected): boolean => {
    if (!tannery) return false;
    if (tannery.ownerPlayerId !== ownPlayerId) {
      showActionError("Only the Tannery owner may operate it.");
      return false;
    }
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot use a Tannery while disconnected.");
      return false;
    }
    const currentPlayer = localPlayerRef.current;
    if (!currentPlayer) {
      showActionError("Your current world position is unavailable.");
      return false;
    }
    const approach = getClosestInteractionApproachPoint(
      currentPlayer,
      tannery,
      TANNERY_INTERACTION_RADIUS_M,
      2
    );
    if (approach) {
      if (!requestMove(approach.lat, approach.lon)) {
        showActionError("Could not begin walking to the Tannery.");
        return false;
      }
      setActionOpen(false);
      setApproachingId(tannery.tanneryId);
      return true;
    }
    if (pendingRef.current.open) {
      stateDestinationRef.current = "app";
      setActionOpen(false);
      setApproachingId(null);
      return true;
    }
    if (!requestState(tannery.tanneryId)) {
      showActionError("Could not open the Tannery.");
      return false;
    }
    setActionOpen(false);
    setApproachingId(null);
    return true;
  }, [ownPlayerId, requestMove, requestState, selected, showActionError]);

  useEffect(() => {
    if (!approachingId || !localPlayer || localPlayer.moving) return;
    const tannery = tanneries.find((candidate) => candidate.tanneryId === approachingId);
    if (!tannery || distanceMeters(localPlayer, tannery) > TANNERY_INTERACTION_RADIUS_M) return;
    setApproachingId(null);
    if (!requestState(tannery.tanneryId)) {
      setActionOpen(true);
      showActionError("Could not open the Tannery.");
    }
  }, [approachingId, tanneries, localPlayer, requestState, showActionError]);

  useEffect(() => {
    const nextCompletesAt = state?.jobs.find((job) => !job.productionFinished)?.completesAt;
    if ((!open && !actionOpen) || !nextCompletesAt) return;
    const delay = Math.max(0, Date.parse(nextCompletesAt) - Date.now() + 150);
    const timer = window.setTimeout(
      () => requestState(state.tannery.tanneryId, actionOpen ? "prompt" : "app"),
      delay
    );
    return () => window.clearTimeout(timer);
  }, [actionOpen, open, requestState, state]);

  const handleServerMessage = useCallback((message: ManorServerMessage): void => {
    switch (message.type) {
      case "TANNERIES_SNAPSHOT":
        setTanneries(message.tanneries);
        return;
      case "TANNERY_BUILD_RESULT":
        if (
          message.requestId !== pendingRef.current.build &&
          message.requestId !== construction?.requestId
        ) return;
        updatePending("build", null);
        setConstruction(null);
        setTanneries((current) => upsert(current, message.tannery));
        receiveInventory(message.inventory);
        setFeedback(null);
        return;
      case "TANNERY_BUILD_STARTED":
        if (pendingRef.current.build && message.requestId !== pendingRef.current.build) return;
        updatePending("build", null);
        setConstruction({
          requestId: message.requestId,
          build: message.build,
          countdown: createFlagBuildCountdown({
            startedAt: message.build.startedAt,
            completesAt: message.build.completesAt,
            durationMs: message.build.durationMs,
            serverTime: message.serverTime
          }, performance.now())
        });
        receiveInventory(message.inventory);
        setFeedback(message.replayed ? "Tannery construction resumed." : "Tannery construction started.");
        return;
      case "TANNERY_BUILD_CANCELLED":
        if (
          message.requestId !== pendingRef.current.build &&
          message.requestId !== construction?.requestId
        ) return;
        updatePending("build", null);
        setConstruction(null);
        receiveInventory(message.inventory);
        receiveDroppedItems(message.droppedItems);
        setFeedback(message.message);
        showActionError(message.message);
        return;
      case "TANNERY_STATE": {
        if (message.requestId && message.requestId !== pendingRef.current.open) return;
        const destination = stateDestinationRef.current;
        updatePending("open", null);
        setState(message.state);
        setSelectedTanneryId(message.state.tannery.tanneryId);
        setActionOpen(destination === "prompt");
        setOpen(destination === "app");
        setFeedback(null);
        return;
      }
      case "TANNERY_BATCH_STARTED":
        if (message.requestId !== pendingRef.current.start) return;
        updatePending("start", null);
        setState(message.state);
        receiveInventory(message.inventory);
        setFeedback(message.replayed ? "Tannery batch already started." : "Tanning started.");
        return;
      case "TANNERY_OUTPUT_COLLECTED": {
        if (message.requestId !== pendingRef.current.collect) return;
        updatePending("collect", null);
        setState(message.state);
        receiveInventory(message.inventory);
        setFeedback(message.collectedQuantity > 0
          ? `Collected ${message.collectedQuantity} Tannery ${message.collectedQuantity === 1 ? "item" : "items"}.`
          : "Inventory is full; the finished output remains in the Tannery.");
        return;
      }
      case "TANNERY_ERROR": {
        const matches = !message.requestId || Object.values(pendingRef.current).includes(message.requestId);
        if (!matches) return;
        if (message.requestId === pendingRef.current.build) updatePending("build", null);
        if (message.requestId === pendingRef.current.open) updatePending("open", null);
        if (message.requestId === pendingRef.current.start) updatePending("start", null);
        if (message.requestId === pendingRef.current.collect) updatePending("collect", null);
        setApproachingId(null);
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
      showActionError("Cannot build a Tannery while disconnected.");
      return false;
    }
    if (pendingRef.current.build || construction) {
      showActionError("A Tannery build is already in progress.");
      return false;
    }
    const requestId = getCommands()?.buildTannery() ?? null;
    if (!requestId) {
      showActionError("Could not send the Tannery build request. Check your connection and try again.");
      return false;
    }
    updatePending("build", requestId);
    setFeedback(null);
    return true;
  }, [connectionStatus, construction, getCommands, showActionError, updatePending]);

  const start = useCallback((recipeId: TanneryRecipeId, quantity: number, options: StationStartOptions = {}): boolean => {
    const tanneryId = state?.tannery.tanneryId;
    if (!tanneryId) {
      showActionError("The Tannery state is unavailable. Close it and try again.");
      return false;
    }
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot start a Tannery job while disconnected.");
      return false;
    }
    if (pendingRef.current.start) return false;
    const requestId = getCommands()?.startTanneryBatch(tanneryId, recipeId, quantity, options) ?? null;
    if (!requestId) {
      showActionError("Could not send the Tannery job. Check your connection and try again.");
      return false;
    }
    updatePending("start", requestId);
    setFeedback(null);
    return true;
  }, [getCommands, showActionError, state?.tannery.tanneryId, updatePending]);

  const collect = useCallback((): void => {
    const tanneryId = state?.tannery.tanneryId;
    if (!tanneryId || pendingRef.current.collect) return;
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot collect Tannery output while disconnected.");
      return;
    }
    const requestId = getCommands()?.collectTanneryOutput(tanneryId) ?? null;
    if (!requestId) {
      showActionError("Could not send the Tannery collection request. Check your connection and try again.");
      return;
    }
    updatePending("collect", requestId);
    setFeedback(null);
  }, [getCommands, showActionError, state?.tannery.tanneryId, updatePending]);

  const close = useCallback((): void => {
    updatePending("open", null);
    stateDestinationRef.current = "app";
    setActionOpen(false);
    setOpen(false);
    setApproachingId(null);
    setSelectedTanneryId(null);
    setState(null);
    setFeedback(null);
  }, [updatePending]);

  return {
    view: {
      tanneries,
      selected,
      selectedTanneryId,
      state,
      actionOpen,
      open,
      construction,
      feedback,
      approaching: approachingId !== null,
      pending
    },
    actions: {
      select,
      batch,
      close,
      build,
      start,
      collect,
      refresh: requestState,
      setSelectedTanneryId,
      handleServerMessage
    }
  };
}

function upsert(
  current: TanneryWorldSnapshot[],
  tannery: TanneryWorldSnapshot
): TanneryWorldSnapshot[] {
  return [
    ...current.filter((candidate) => candidate.tanneryId !== tannery.tanneryId),
    tannery
  ];
}
