import type { StationStartOptions } from "../../client/domains/manorClient.js";
import {
  KITCHEN_INTERACTION_RADIUS_M,
  distanceMeters,
  type DroppedItemSnapshot,
  type KitchenBuildSnapshot,
  type KitchenRecipeId,
  type KitchenStateSnapshot,
  type KitchenWorldSnapshot,
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

type KitchenStateDestination = "app" | "prompt";
const emptyPending = (): Pending => ({ build: null, open: null, start: null, collect: null });

export type KitchenMovementIntent = Readonly<{
  requestId: string;
  generation: number;
}>;

export type KitchenMovementState = Readonly<KitchenMovementIntent & {
  accepted: boolean;
}>;

type PendingApproach = Readonly<KitchenMovementIntent & {
  kitchenId: string;
}>;

/** Client-side interaction state for the shared outdoor Kitchen workstation. */
export function useKitchenFeature(options: Readonly<{
  connectionStatus: "offline" | "connecting" | "online";
  localPlayer: PlayerSnapshot | null;
  getCommands(): ManorClient | null;
  requestMove(lat: number, lon: number): KitchenMovementIntent | null;
  getMovement(): KitchenMovementState | null;
  receiveInventory(snapshot: PlayerInventorySnapshot): void;
  receiveDroppedItems(drops: DroppedItemSnapshot[]): void;
  showActionError(message: string): void;
  onBuildClearanceSuggestion?(position: { lat: number; lon: number }): void;
}>) {
  const {
    connectionStatus,
    localPlayer,
    getCommands,
    requestMove,
    getMovement,
    receiveInventory,
    receiveDroppedItems,
    showActionError,
    onBuildClearanceSuggestion
  } = options;
  const [kitchens, setKitchens] = useState<KitchenWorldSnapshot[]>([]);
  const [selectedKitchenId, setSelectedKitchenId] = useState<string | null>(null);
  const [state, setState] = useState<KitchenStateSnapshot | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [construction, setConstruction] = useState<Readonly<{
    requestId: string;
    build: KitchenBuildSnapshot;
    countdown: FlagBuildCountdown;
  }> | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [approach, setApproach] = useState<PendingApproach | null>(null);
  const pendingRef = useRef<Pending>(emptyPending());
  const stateDestinationRef = useRef<KitchenStateDestination>("app");
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
    () => kitchens.find((kitchen) => kitchen.kitchenId === selectedKitchenId) ?? null,
    [kitchens, selectedKitchenId]
  );

  const requestState = useCallback((
    kitchenId: string,
    destination: KitchenStateDestination = "app"
  ): boolean => {
    if (connectionStatusRef.current !== "online" || pendingRef.current.open) return false;
    const requestId = getCommands()?.openKitchen(kitchenId) ?? null;
    if (!requestId) return false;
    stateDestinationRef.current = destination;
    updatePending("open", requestId);
    setFeedback("Checking Kitchen…");
    return true;
  }, [getCommands, updatePending]);

  const select = useCallback((kitchen: KitchenWorldSnapshot): void => {
    updatePending("open", null);
    setSelectedKitchenId(kitchen.kitchenId);
    setState(null);
    setFeedback(null);
    setActionOpen(true);
    setOpen(false);
    setApproach(null);
    const currentPlayer = localPlayerRef.current;
    if (
      connectionStatusRef.current === "online" &&
      currentPlayer &&
      distanceMeters(currentPlayer, kitchen) <= KITCHEN_INTERACTION_RADIUS_M
    ) requestState(kitchen.kitchenId, "prompt");
  }, [requestState, updatePending]);

  const cook = useCallback((kitchen: KitchenWorldSnapshot | null = selected): boolean => {
    if (!kitchen) return false;
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot use a Kitchen while disconnected.");
      return false;
    }
    const currentPlayer = localPlayerRef.current;
    if (!currentPlayer) {
      showActionError("Your current world position is unavailable.");
      return false;
    }
    const approach = getClosestReachableInteractionApproachPoint(
      currentPlayer, kitchen, KITCHEN_INTERACTION_RADIUS_M, 2
    );
    if (approach) {
      const movement = requestMove(approach.lat, approach.lon);
      if (!movement) {
        showActionError("Could not begin walking to the Kitchen.");
        return false;
      }
      setActionOpen(false);
      setApproach({ kitchenId: kitchen.kitchenId, ...movement });
      return true;
    }
    if (distanceMeters(currentPlayer, kitchen) > KITCHEN_INTERACTION_RADIUS_M) {
      showActionError("This Kitchen is outside your movement range.");
      return false;
    }
    if (pendingRef.current.open) {
      stateDestinationRef.current = "app";
      setActionOpen(false);
      setApproach(null);
      return true;
    }
    if (!requestState(kitchen.kitchenId)) {
      showActionError("Could not open the Kitchen.");
      return false;
    }
    setActionOpen(false);
    setApproach(null);
    return true;
  }, [requestMove, requestState, selected, showActionError]);

  useEffect(() => {
    if (!approach) return;
    const movement = getMovement();
    if (
      !movement ||
      movement.requestId !== approach.requestId ||
      movement.generation !== approach.generation
    ) {
      setApproach(null);
      return;
    }
    if (!localPlayer || !movement.accepted || localPlayer.moving) return;
    const kitchen = kitchens.find((candidate) => candidate.kitchenId === approach.kitchenId);
    if (!kitchen || distanceMeters(localPlayer, kitchen) > KITCHEN_INTERACTION_RADIUS_M) return;
    setApproach(null);
    if (!requestState(kitchen.kitchenId)) {
      setActionOpen(true);
      showActionError("Could not open the Kitchen.");
    }
  }, [approach, getMovement, kitchens, localPlayer, requestState, showActionError]);

  useEffect(() => {
    const nextCompletesAt = state?.jobs.find((job) => !job.productionFinished)?.completesAt;
    if ((!open && !actionOpen) || !nextCompletesAt) return;
    const delay = Math.max(0, Date.parse(nextCompletesAt) - Date.now() + 150);
    const timer = window.setTimeout(
      () => requestState(state.kitchen.kitchenId, actionOpen ? "prompt" : "app"), delay
    );
    return () => window.clearTimeout(timer);
  }, [actionOpen, open, requestState, state]);

  const handleServerMessage = useCallback((message: ManorServerMessage): void => {
    switch (message.type) {
      case "KITCHENS_SNAPSHOT":
        setKitchens(message.kitchens);
        return;
      case "KITCHEN_BUILD_RESULT":
        if (message.requestId !== pendingRef.current.build && message.requestId !== construction?.requestId) return;
        updatePending("build", null);
        setConstruction(null);
        setKitchens((current) => upsert(current, message.kitchen));
        receiveInventory(message.inventory);
        setFeedback(null);
        return;
      case "KITCHEN_BUILD_STARTED":
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
        setFeedback(message.replayed ? "Kitchen construction resumed." : "Kitchen construction started.");
        return;
      case "KITCHEN_BUILD_CANCELLED":
        if (message.requestId !== pendingRef.current.build && message.requestId !== construction?.requestId) return;
        updatePending("build", null);
        setConstruction(null);
        receiveInventory(message.inventory);
        receiveDroppedItems(message.droppedItems);
        setFeedback(message.message);
        showActionError(message.message);
        return;
      case "KITCHEN_STATE": {
        if (message.requestId && message.requestId !== pendingRef.current.open) return;
        const destination = stateDestinationRef.current;
        updatePending("open", null);
        setState(message.state);
        setSelectedKitchenId(message.state.kitchen.kitchenId);
        setActionOpen(destination === "prompt");
        setOpen(destination === "app");
        setFeedback(null);
        return;
      }
      case "KITCHEN_BATCH_STARTED":
        if (message.requestId !== pendingRef.current.start) return;
        updatePending("start", null);
        setState(message.state);
        receiveInventory(message.inventory);
        setFeedback(message.replayed ? "Kitchen batch already started." : "Cooking started.");
        return;
      case "KITCHEN_OUTPUT_COLLECTED":
        if (message.requestId !== pendingRef.current.collect) return;
        updatePending("collect", null);
        setState(message.state);
        receiveInventory(message.inventory);
        setFeedback(message.collectedQuantity > 0
          ? `Collected ${message.collectedQuantity} Simple Food.`
          : "Inventory is full; the finished Simple Food remains in the Kitchen.");
        return;
      case "KITCHEN_ERROR": {
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
      showActionError("Cannot build a Kitchen while disconnected.");
      return false;
    }
    if (pendingRef.current.build || construction) {
      showActionError("A Kitchen build is already in progress.");
      return false;
    }
    const requestId = getCommands()?.buildKitchen() ?? null;
    if (!requestId) {
      showActionError("Could not send the Kitchen build request. Check your connection and try again.");
      return false;
    }
    updatePending("build", requestId);
    setFeedback(null);
    return true;
  }, [connectionStatus, construction, getCommands, showActionError, updatePending]);

  const start = useCallback((recipeId: KitchenRecipeId | "cook_any", quantity: number, options: StationStartOptions = {}): boolean => {
    const kitchenId = state?.kitchen.kitchenId;
    if (!kitchenId) {
      showActionError("The Kitchen state is unavailable. Close it and try again.");
      return false;
    }
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot start a Kitchen batch while disconnected.");
      return false;
    }
    if (pendingRef.current.start) return false;
    const requestId = getCommands()?.startKitchenBatch(kitchenId, recipeId, quantity, options) ?? null;
    if (!requestId) {
      showActionError("Could not send the Kitchen batch. Check your connection and try again.");
      return false;
    }
    updatePending("start", requestId);
    setFeedback(null);
    return true;
  }, [getCommands, showActionError, state?.kitchen.kitchenId, updatePending]);

  const collect = useCallback((): void => {
    const kitchenId = state?.kitchen.kitchenId;
    if (!kitchenId || pendingRef.current.collect) return;
    if (connectionStatusRef.current !== "online") {
      showActionError("Cannot collect Kitchen output while disconnected.");
      return;
    }
    const requestId = getCommands()?.collectKitchenOutput(kitchenId) ?? null;
    if (!requestId) {
      showActionError("Could not send the Kitchen collection request. Check your connection and try again.");
      return;
    }
    updatePending("collect", requestId);
    setFeedback(null);
  }, [getCommands, showActionError, state?.kitchen.kitchenId, updatePending]);

  const close = useCallback((): void => {
    updatePending("open", null);
    stateDestinationRef.current = "app";
    setActionOpen(false);
    setOpen(false);
    setApproach(null);
    setSelectedKitchenId(null);
    setState(null);
    setFeedback(null);
  }, [updatePending]);

  return {
    view: {
      kitchens,
      selected,
      selectedKitchenId,
      state,
      actionOpen,
      open,
      construction,
      feedback,
      approaching: approach !== null,
      pending
    },
    actions: {
      select,
      cook,
      close,
      build,
      start,
      collect,
      refresh: requestState,
      setSelectedKitchenId,
      handleServerMessage
    }
  };
}

function upsert(
  current: KitchenWorldSnapshot[],
  kitchen: KitchenWorldSnapshot
): KitchenWorldSnapshot[] {
  return [...current.filter((candidate) => candidate.kitchenId !== kitchen.kitchenId), kitchen];
}
