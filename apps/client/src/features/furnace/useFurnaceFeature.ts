import type { StationStartOptions } from "../../client/domains/manorClient.js";
import {
  FURNACE_INTERACTION_RADIUS_M,
  distanceMeters,
  type DroppedItemSnapshot,
  type FurnaceBuildSnapshot,
  type FurnaceRecipeId,
  type FurnaceStateSnapshot,
  type FurnaceWorldSnapshot,
  type ManorServerMessage,
  type PlayerInventorySnapshot,
  type PlayerSnapshot,
  type PremiumWalletSnapshot
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
  refine: string | null;
};

type FurnaceStateDestination = "app" | "prompt";

const emptyPending = (): Pending => ({ build: null, open: null, start: null, collect: null, refine: null });

export function useFurnaceFeature(options: Readonly<{
  connectionStatus: "offline" | "connecting" | "online";
  ownPlayerId: string;
  localPlayer: PlayerSnapshot | null;
  getCommands(): ManorClient | null;
  requestMove(lat: number, lon: number): boolean;
  receiveInventory(snapshot: PlayerInventorySnapshot): void;
  receivePremiumWallet?(snapshot: PremiumWalletSnapshot): void;
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
    receivePremiumWallet,
    receiveDroppedItems,
    showActionError,
    onBuildClearanceSuggestion
  } = options;
  const [furnaces, setFurnaces] = useState<FurnaceWorldSnapshot[]>([]);
  const [selectedFurnaceId, setSelectedFurnaceId] = useState<string | null>(null);
  const [state, setState] = useState<FurnaceStateSnapshot | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [construction, setConstruction] = useState<Readonly<{
    requestId: string;
    build: FurnaceBuildSnapshot;
    countdown: FlagBuildCountdown;
  }> | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [approachingId, setApproachingId] = useState<string | null>(null);
  const pendingRef = useRef<Pending>(emptyPending());
  const stateDestinationRef = useRef<FurnaceStateDestination>("app");
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
    () => furnaces.find((furnace) => furnace.furnaceId === selectedFurnaceId) ?? null,
    [furnaces, selectedFurnaceId]
  );

  const requestState = useCallback((
    furnaceId: string,
    destination: FurnaceStateDestination = "app"
  ): boolean => {
    if (connectionStatusRef.current !== "online" || pendingRef.current.open) return false;
    const requestId = getCommands()?.openFurnace(furnaceId) ?? null;
    if (!requestId) return false;
    stateDestinationRef.current = destination;
    updatePending("open", requestId);
    setFeedback("Checking Furnace…");
    return true;
  }, [getCommands, updatePending]);

  const select = useCallback((furnace: FurnaceWorldSnapshot): void => {
    updatePending("open", null);
    setSelectedFurnaceId(furnace.furnaceId);
    setState(null);
    setFeedback(null);
    setActionOpen(true);
    setOpen(false);
    setApproachingId(null);
    const currentPlayer = localPlayerRef.current;
    if (
      furnace.ownerPlayerId === ownPlayerId &&
      connectionStatusRef.current === "online" &&
      currentPlayer &&
      distanceMeters(currentPlayer, furnace) <= FURNACE_INTERACTION_RADIUS_M
    ) {
      requestState(furnace.furnaceId, "prompt");
    }
  }, [ownPlayerId, requestState, updatePending]);

  const smelt = useCallback((furnace: FurnaceWorldSnapshot | null = selected): boolean => {
    if (!furnace) return false;
    if (furnace.ownerPlayerId !== ownPlayerId) {
      showActionError("Only the Furnace owner may operate it.");
      return false;
    }
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot use a Furnace while disconnected.");
      return false;
    }
    const currentPlayer = localPlayerRef.current;
    if (!currentPlayer) {
      showActionError("Your current world position is unavailable.");
      return false;
    }
    const approach = getClosestInteractionApproachPoint(
      currentPlayer,
      furnace,
      FURNACE_INTERACTION_RADIUS_M,
      2
    );
    if (approach) {
      if (!requestMove(approach.lat, approach.lon)) {
        showActionError("Could not begin walking to the Furnace.");
        return false;
      }
      setActionOpen(false);
      setApproachingId(furnace.furnaceId);
      return true;
    }
    if (pendingRef.current.open) {
      stateDestinationRef.current = "app";
      setActionOpen(false);
      setApproachingId(null);
      return true;
    }
    if (!requestState(furnace.furnaceId)) {
      showActionError("Could not open the Furnace.");
      return false;
    }
    setActionOpen(false);
    setApproachingId(null);
    return true;
  }, [ownPlayerId, requestMove, requestState, selected, showActionError]);

  useEffect(() => {
    if (!approachingId || !localPlayer || localPlayer.moving) return;
    const furnace = furnaces.find((candidate) => candidate.furnaceId === approachingId);
    if (!furnace || distanceMeters(localPlayer, furnace) > FURNACE_INTERACTION_RADIUS_M) return;
    setApproachingId(null);
    if (!requestState(furnace.furnaceId)) {
      setActionOpen(true);
      showActionError("Could not open the Furnace.");
    }
  }, [approachingId, furnaces, localPlayer, requestState, showActionError]);

  useEffect(() => {
    const nextCompletesAt = state?.jobs.find((job) => job.nextCompletesAt)?.nextCompletesAt;
    if ((!open && !actionOpen) || !nextCompletesAt) return;
    const delay = Math.max(0, Date.parse(nextCompletesAt) - Date.now() + 150);
    const timer = window.setTimeout(
      () => requestState(state.furnace.furnaceId, actionOpen ? "prompt" : "app"),
      delay
    );
    return () => window.clearTimeout(timer);
  }, [actionOpen, open, requestState, state]);

  const handleServerMessage = useCallback((message: ManorServerMessage): void => {
    switch (message.type) {
      case "FURNACES_SNAPSHOT":
        setFurnaces(message.furnaces);
        return;
      case "FURNACE_BUILD_RESULT":
        if (
          message.requestId !== pendingRef.current.build &&
          message.requestId !== construction?.requestId
        ) return;
        updatePending("build", null);
        setConstruction(null);
        setFurnaces((current) => upsert(current, message.furnace));
        receiveInventory(message.inventory);
        setFeedback(null);
        return;
      case "FURNACE_BUILD_STARTED":
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
        setFeedback(message.replayed ? "Furnace construction resumed." : "Furnace construction started.");
        return;
      case "FURNACE_BUILD_CANCELLED":
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
      case "FURNACE_STATE": {
        if (message.requestId && message.requestId !== pendingRef.current.open) return;
        const destination = stateDestinationRef.current;
        updatePending("open", null);
        setState(message.state);
        setSelectedFurnaceId(message.state.furnace.furnaceId);
        setActionOpen(destination === "prompt");
        setOpen(destination === "app");
        setFeedback(null);
        return;
      }
      case "FURNACE_SMELT_STARTED":
        if (message.requestId !== pendingRef.current.start) return;
        updatePending("start", null);
        setState(message.state);
        receiveInventory(message.inventory);
        setFeedback(message.replayed ? "Smelting job already started." : "Smelting started.");
        return;
      case "FURNACE_OUTPUT_COLLECTED": {
        if (message.requestId !== pendingRef.current.collect) return;
        updatePending("collect", null);
        setState(message.state);
        receiveInventory(message.inventory);
        setFeedback(message.collectedQuantity > 0
          ? `Collected ${message.collectedQuantity} Furnace ${message.collectedQuantity === 1 ? "item" : "items"}.`
          : "Inventory is full; the finished output remains in the Furnace.");
        return;
      }
      case "FURNACE_GLIMMER_OIL_REFINED":
        if (message.requestId !== pendingRef.current.refine) return;
        updatePending("refine", null);
        setState(message.state);
        receiveInventory(message.inventory);
        receivePremiumWallet?.(message.premiumWallet);
        setFeedback(message.replayed
          ? "That Glimmer Oil was already refined."
          : `Refined ${message.refinedQuantity} Glimmer Oil.`);
        return;
      case "FURNACE_ERROR": {
        const matches = !message.requestId || Object.values(pendingRef.current).includes(message.requestId);
        if (!matches) return;
        if (message.requestId === pendingRef.current.build) updatePending("build", null);
        if (message.requestId === pendingRef.current.open) updatePending("open", null);
        if (message.requestId === pendingRef.current.start) updatePending("start", null);
        if (message.requestId === pendingRef.current.collect) updatePending("collect", null);
        if (message.requestId === pendingRef.current.refine) updatePending("refine", null);
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
  }, [construction?.requestId, onBuildClearanceSuggestion, receiveDroppedItems, receiveInventory, receivePremiumWallet, showActionError, updatePending]);

  const build = useCallback((): boolean => {
    if (connectionStatus !== "online") {
      showActionError("Cannot build a Furnace while disconnected.");
      return false;
    }
    if (pendingRef.current.build || construction) {
      showActionError("A Furnace build is already in progress.");
      return false;
    }
    const requestId = getCommands()?.buildFurnace() ?? null;
    if (!requestId) {
      showActionError("Could not send the Furnace build request. Check your connection and try again.");
      return false;
    }
    updatePending("build", requestId);
    setFeedback(null);
    return true;
  }, [connectionStatus, construction, getCommands, showActionError, updatePending]);

  const start = useCallback((recipeId: FurnaceRecipeId | string, quantity: number, options: StationStartOptions = {}): boolean => {
    const furnaceId = state?.furnace.furnaceId;
    if (!furnaceId) {
      showActionError("The Furnace state is unavailable. Close it and try again.");
      return false;
    }
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot start a Furnace job while disconnected.");
      return false;
    }
    if (pendingRef.current.start) return false;
    const requestId = getCommands()?.startFurnaceSmelt(furnaceId, recipeId, quantity, options) ?? null;
    if (!requestId) {
      showActionError("Could not send the Furnace job. Check your connection and try again.");
      return false;
    }
    updatePending("start", requestId);
    setFeedback(null);
    return true;
  }, [getCommands, showActionError, state?.furnace.furnaceId, updatePending]);

  const collect = useCallback((): void => {
    const furnaceId = state?.furnace.furnaceId;
    if (!furnaceId || pendingRef.current.collect) return;
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot collect Furnace output while disconnected.");
      return;
    }
    const requestId = getCommands()?.collectFurnaceOutput(furnaceId) ?? null;
    if (!requestId) {
      showActionError("Could not send the Furnace collection request. Check your connection and try again.");
      return;
    }
    updatePending("collect", requestId);
    setFeedback(null);
  }, [getCommands, showActionError, state?.furnace.furnaceId, updatePending]);

  const refineGlimmerOil = useCallback((quantity: number): boolean => {
    const furnaceId = state?.furnace.furnaceId;
    if (!furnaceId) {
      showActionError("The Furnace state is unavailable. Close it and try again.");
      return false;
    }
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot refine Glimmer Oil while disconnected.");
      return false;
    }
    if (pendingRef.current.refine) return false;
    const requestId = getCommands()?.refineFurnaceGlimmerOil(furnaceId, quantity) ?? null;
    if (!requestId) {
      showActionError("Could not send the refining request. Check your connection and try again.");
      return false;
    }
    updatePending("refine", requestId);
    setFeedback(null);
    return true;
  }, [getCommands, showActionError, state?.furnace.furnaceId, updatePending]);

  const close = useCallback((): void => {
    updatePending("open", null);
    stateDestinationRef.current = "app";
    setActionOpen(false);
    setOpen(false);
    setApproachingId(null);
    setSelectedFurnaceId(null);
    setState(null);
    setFeedback(null);
  }, [updatePending]);

  return {
    view: {
      furnaces,
      selected,
      selectedFurnaceId,
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
      smelt,
      close,
      build,
      start,
      collect,
      refineGlimmerOil,
      refresh: requestState,
      setSelectedFurnaceId,
      handleServerMessage
    }
  };
}

function upsert(
  current: FurnaceWorldSnapshot[],
  furnace: FurnaceWorldSnapshot
): FurnaceWorldSnapshot[] {
  return [
    ...current.filter((candidate) => candidate.furnaceId !== furnace.furnaceId),
    furnace
  ];
}
