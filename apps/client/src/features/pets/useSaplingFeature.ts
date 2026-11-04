import {
  GIVING_BERRY_ITEM_ID,
  GIVING_SAPLING_ITEM_ID,
  PLAYER_SAPLING_TREE_ID_PREFIX,
  SAPLING_INTERACT_RANGE_M,
  SAPLING_LIST_RESYNC_MOVE_M,
  SAPLING_SLOW_RESYNC_MS,
  distanceMeters,
  nearestTreeLatticePoint,
  saplingGrowthFraction,
  saplingGrowthPhase,
  type CollectibleNode,
  type LatLon,
  type PlayerInventorySnapshot,
  type SaplingGrowthPhase,
  type SaplingMapItem,
  type SaplingPlantSource,
  type SaplingWorldSnapshot,
  type ServerMessage
} from "@ash-atlas/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PetClient } from "../../client/domains/petClient.js";
import type { SaplingRenderItem } from "../../map/mapObjects.js";

export type SaplingServerMessage = Extract<
  ServerMessage,
  { type: "SAPLINGS_STATE" | "SAPLING_DELTA" | "SAPLING_DETAIL" | "SAPLING_RESULT" | "SAPLING_ERROR" }
>;
const SAPLING_FRAME_TYPES = new Set<ServerMessage["type"]>([
  "SAPLINGS_STATE", "SAPLING_DELTA", "SAPLING_DETAIL", "SAPLING_RESULT", "SAPLING_ERROR"
]);

export function isSaplingServerMessage(message: ServerMessage): message is SaplingServerMessage {
  return SAPLING_FRAME_TYPES.has(message.type);
}

export type SaplingBusyAction = "plant" | "tend" | "pull" | "gather";

/** A compact map row within reach (Construction cards). */
export type NearbyMapSapling = Readonly<{ item: SaplingMapItem; distanceM: number }>;

/** The tapped tree's detail with the live timers the prompt shows. */
export type NearbySapling = Readonly<{
  sapling: SaplingWorldSnapshot;
  distanceM: number;
  inRange: boolean;
  phase: SaplingGrowthPhase | null;
  /** Whole-percent growth toward maturity (sapling only). */
  growthPercent: number | null;
  tendReadyInMs: number | null;
  diesInMs: number | null;
  maturesInMs: number | null;
  berryReadyInMs: number | null;
}>;

export type SaplingFeatureOptions = {
  getCommands(): PetClient | null;
  online: boolean;
  /** The player's authoritative world position, or null while not on the open world. */
  position: LatLon | null;
  receiveInventory?(snapshot: PlayerInventorySnapshot): void;
  onNotice?(notice: string): void;
  onError?(message: string): void;
};

export type SaplingDetailState = "idle" | "loading" | "ready" | "gone";

export function useSaplingFeature({ getCommands, online, position, receiveInventory, onNotice, onError }: SaplingFeatureOptions) {
  const [items, setItems] = useState<ReadonlyMap<string, SaplingMapItem>>(() => new Map());
  const [detail, setDetail] = useState<{ sapling: SaplingWorldSnapshot | null; skewMs: number } | null>(null);
  const [detailState, setDetailState] = useState<SaplingDetailState>("idle");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState<SaplingBusyAction | null>(null);
  const listPendingRef = useRef<string | null>(null);
  const listPendingAtRef = useRef(0);
  const detailPendingRef = useRef<string | null>(null);
  const detailIdRef = useRef<string | null>(null);
  const actionPendingRef = useRef<string | null>(null);
  const lastListPositionRef = useRef<LatLon | null>(null);
  const positionRef = useRef(position);
  positionRef.current = position;

  /** Full list: on connect or reconnect, after moving far, and as a slow safety resync. */
  const refresh = useCallback((): void => {
    const commands = getCommands();
    const here = positionRef.current;
    // A reply that never came back must not block the next list forever.
    if (!commands || !here || (listPendingRef.current && Date.now() - listPendingAtRef.current < 30_000)) return;
    const requestId = commands.requestSaplings();
    if (!requestId) return;
    listPendingRef.current = requestId;
    listPendingAtRef.current = Date.now();
    lastListPositionRef.current = here;
  }, [getCommands]);

  // Connect and reconnect: ask once. While offline the stale view is dropped.
  useEffect(() => {
    if (!online) {
      listPendingRef.current = null;
      lastListPositionRef.current = null;
      setItems((current) => (current.size === 0 ? current : new Map()));
      return undefined;
    }
    refresh();
    const timer = window.setInterval(refresh, SAPLING_SLOW_RESYNC_MS);
    return () => window.clearInterval(timer);
  }, [online, refresh]);

  // Entering the open world, and moving far from where the last list was taken.
  const lat = position?.lat ?? null;
  const lon = position?.lon ?? null;
  useEffect(() => {
    if (!online || lat === null || lon === null) return;
    const last = lastListPositionRef.current;
    if (!last || distanceMeters(last, { lat, lon }) >= SAPLING_LIST_RESYNC_MOVE_M) refresh();
  }, [online, lat, lon, refresh]);

  // The prompt's timers tick locally while a detail is open.
  const detailOpen = detailState === "ready";
  useEffect(() => {
    if (!detailOpen) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [detailOpen]);

  const handleServerMessage = useCallback((message: SaplingServerMessage): void => {
    switch (message.type) {
      case "SAPLINGS_STATE": {
        if (message.requestId && message.requestId === listPendingRef.current) listPendingRef.current = null;
        else if (!message.requestId) listPendingRef.current = null;
        setItems(new Map((message.saplings as SaplingMapItem[]).map((item) => [item.id, item])));
        return;
      }
      case "SAPLING_DELTA": {
        const upserts = message.upserts as SaplingMapItem[];
        setItems((current) => {
          const next = new Map(current);
          for (const id of message.removed) next.delete(id);
          for (const item of upserts) next.set(item.id, item);
          return next;
        });
        if (detailIdRef.current && message.removed.includes(detailIdRef.current)) {
          setDetail({ sapling: null, skewMs: 0 });
          setDetailState("gone");
        }
        return;
      }
      case "SAPLING_DETAIL": {
        if (message.saplingId !== detailIdRef.current) return;
        if (message.requestId === detailPendingRef.current) detailPendingRef.current = null;
        setDetail({ sapling: message.sapling as SaplingWorldSnapshot | null, skewMs: message.serverNowMs - Date.now() });
        setDetailState(message.sapling ? "ready" : "gone");
        setNowMs(Date.now());
        return;
      }
      case "SAPLING_RESULT": {
        if (message.requestId === actionPendingRef.current) actionPendingRef.current = null;
        setBusy(null);
        if (message.inventory) receiveInventory?.(message.inventory);
        if (message.notice) onNotice?.(message.notice);
        const sapling = message.sapling as SaplingWorldSnapshot | null;
        if (sapling && sapling.saplingId === detailIdRef.current) {
          setDetail({ sapling, skewMs: message.serverNowMs - Date.now() });
          setDetailState("ready");
          setNowMs(Date.now());
        } else if (!sapling && message.action === "pull" && detailIdRef.current) {
          setDetail({ sapling: null, skewMs: 0 });
          setDetailState("gone");
        }
        return;
      }
      case "SAPLING_ERROR": {
        if (message.requestId && message.requestId === actionPendingRef.current) {
          actionPendingRef.current = null;
          setBusy(null);
          onError?.(message.message);
        } else if (message.requestId && message.requestId === listPendingRef.current) {
          listPendingRef.current = null;
        } else if (message.requestId && message.requestId === detailPendingRef.current) {
          detailPendingRef.current = null;
          setDetailState("gone");
        }
        return;
      }
    }
  }, [onError, onNotice, receiveInventory]);

  const begin = useCallback((action: SaplingBusyAction, send: (commands: PetClient) => string | null): boolean => {
    if (actionPendingRef.current) return false;
    const commands = getCommands();
    const requestId = commands ? send(commands) : null;
    if (!requestId) {
      onError?.("Disconnected. Reconnect and try again.");
      return false;
    }
    actionPendingRef.current = requestId;
    setBusy(action);
    return true;
  }, [getCommands, onError]);

  const actions = useMemo(() => ({
    plant: (source: SaplingPlantSource, target?: LatLon) => begin("plant", (commands) => commands.plantSapling(source, target)),
    tend: (saplingId: string) => begin("tend", (commands) => commands.tendSapling(saplingId)),
    pull: (saplingId: string) => begin("pull", (commands) => commands.pullSapling(saplingId)),
    gather: (saplingId: string) => begin("gather", (commands) => commands.gatherSaplingBerry(saplingId))
  }), [begin]);

  /**
   * Quick slot and planting planner: plants a Giving Berry (else a pulled sapling), where the player
   * stands, or at the tree-lattice point nearest the player when `snapToLattice` (the planner is on).
   * The server re-snaps and range-checks that point itself.
   */
  const plantNext = useCallback((totals: Readonly<Partial<Record<string, number>>>, snapToLattice: boolean): boolean => {
    const source: SaplingPlantSource | null = (totals[GIVING_BERRY_ITEM_ID] ?? 0) > 0
      ? "berry"
      : (totals[GIVING_SAPLING_ITEM_ID] ?? 0) > 0 ? "sapling" : null;
    const here = positionRef.current;
    if (!source) {
      onError?.("You need a Giving Berry to plant.");
      return false;
    }
    if (snapToLattice && !here) {
      onError?.("Your position is unavailable.");
      return false;
    }
    return actions.plant(source, snapToLattice && here ? nearestTreeLatticePoint(here) : undefined);
  }, [actions, onError]);

  /** The tap: one single-tree read for the owner and the exact timers. */
  const loadDetail = useCallback((saplingId: string): void => {
    detailIdRef.current = saplingId;
    setDetail(null);
    setDetailState("loading");
    const requestId = getCommands()?.requestSaplingDetail(saplingId) ?? null;
    detailPendingRef.current = requestId;
    if (!requestId) setDetailState("gone");
  }, [getCommands]);

  const clearDetail = useCallback((): void => {
    detailIdRef.current = null;
    detailPendingRef.current = null;
    setDetail(null);
    setDetailState("idle");
  }, []);

  const renderItems = useMemo<SaplingRenderItem[]>(() => [...items.values()].map((item) => ({
    id: item.id, lat: item.lat, lon: item.lon, state: item.state, growth: item.growth / 10, phase: item.phase,
    berryAvailable: item.berryAvailable
  })), [items]);

  const nearby = useMemo<NearbyMapSapling[]>(() => {
    if (!position) return [];
    return [...items.values()]
      .map((item) => ({ item, distanceM: distanceMeters(position, item) }))
      .filter((entry) => entry.distanceM <= SAPLING_INTERACT_RANGE_M)
      .sort((left, right) => left.distanceM - right.distanceM);
  }, [items, position]);

  const selected = useMemo<NearbySapling | null>(() => {
    const sapling = detail?.sapling;
    if (!sapling || !position) return null;
    const serverNow = nowMs + detail.skewMs;
    const distanceM = distanceMeters(position, { lat: sapling.lat, lon: sapling.lon });
    const until = (iso: string | null): number | null => iso === null ? null : Math.max(0, Date.parse(iso) - serverNow);
    const growing = sapling.state === "sapling";
    return {
      sapling,
      distanceM,
      inRange: distanceM <= SAPLING_INTERACT_RANGE_M,
      phase: growing
        ? saplingGrowthPhase({
            tendReadyAtMs: Date.parse(sapling.tendReadyAt ?? sapling.plantedAt),
            diesAtMs: Date.parse(sapling.diesAt ?? sapling.plantedAt)
          }, serverNow)
        : null,
      growthPercent: growing
        ? Math.round(100 * saplingGrowthFraction({
            plantedAtMs: Date.parse(sapling.plantedAt),
            maturesAtMs: Date.parse(sapling.maturesAt ?? sapling.plantedAt)
          }, serverNow))
        : null,
      tendReadyInMs: until(sapling.tendReadyAt),
      diesInMs: until(sapling.diesAt),
      maturesInMs: until(sapling.maturesAt),
      berryReadyInMs: until(sapling.berryReadyAt)
    };
  }, [detail, position, nowMs]);

  /** Where every known tree stands (the planting planner marks those grid points occupied). */
  const positionedTrees = useMemo<LatLon[]>(() => [...items.values()].map((item) => ({ lat: item.lat, lon: item.lon })), [items]);

  // Grown player trees are choppable like wild trees: the harvest flow reads them as collectible nodes.
  // A tree's life revision only changes when it is chopped (and it is then gone), so it is always 0.
  const grownCollectibles = useMemo<CollectibleNode[]>(() => [...items.values()]
    .filter((item) => item.state === "grown")
    .map((item) => ({
      id: `${PLAYER_SAPLING_TREE_ID_PREFIX}${item.id}`,
      type: "wood" as const,
      lat: item.lat,
      lon: item.lon,
      quantity: 4,
      state: "available" as const,
      createdAt: new Date(0).toISOString(),
      harvestedAt: null,
      sourceCellId: `player-tree:${item.id}`,
      waterKind: null,
      presentationOwner: "population" as const,
      treeLifeRevision: 0,
      berryAvailable: false,
      resinAvailable: false
    })), [items]);

  return {
    renderItems, nearby, selected, detailState, grownCollectibles, busy, actions,
    refresh, loadDetail, clearDetail, handleServerMessage, plantNext, positionedTrees
  };
}

export type SaplingFeature = ReturnType<typeof useSaplingFeature>;
