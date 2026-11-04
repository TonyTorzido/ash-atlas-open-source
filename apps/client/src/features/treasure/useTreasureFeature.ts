import { TREASURE_DIG_RADIUS_M, distanceMeters, type LatLon, type TreasureCacheSnapshot, type TreasureStateSnapshot } from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";

import { TreasureMapPresenter } from "../../map/treasureMap.js";
import { requestIdCrypto as crypto } from "../../requestId.js";

const POLL_MS = 20_000;
const CLOCK_MS = 30_000;

type MutationResponse = { message: string; replayed: boolean; state: TreasureStateSnapshot; inventory?: unknown };

async function treasureRequest<T>(serverHttpBase: string, csrfToken: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, serverHttpBase), {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-csrf-token": csrfToken
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? "Treasure request failed.");
  return payload as T;
}

export type TreasureFeature = Readonly<{
  state: TreasureStateSnapshot | null;
  /** Server clock now, re-derived every 30 s for lifetime labels. */
  serverNowMs: number;
  pending: boolean;
  refresh(): void;
  artisanShovel(): void;
  dig(treasureId: string): void;
  /**
   * Shovel Use: digs the nearest listed cache within the dig radius of `position`, or shows a short
   * toast. Always handled (true) so the caller can close its popup.
   */
  digNearest(position: LatLon | null): boolean;
  /** The cache the player tapped on the map (the Dig prompt), or null. */
  selected: TreasureCacheSnapshot | null;
  /** The cache marker under a map tap, selecting it; false when the tap hit none. */
  pickAt(point: { x: number; y: number }): boolean;
  clearSelection(): void;
}>;

/**
 * Buried treasure on the client: polls the nearby caches (the server only lists
 * the tiers this player may see), draws them on the map, and sends the
 * server-authoritative Dig and Artisan Shovel actions (the server uses the live
 * position; the client never sends coordinates).
 */
export function useTreasureFeature(input: Readonly<{
  activeMap: maplibregl.Map | null;
  serverHttpBase: string;
  csrfToken: string;
  enabled: boolean;
  receiveInventory(snapshot: unknown): void;
  onMessage(message: string): void;
  onError(message: string): void;
}>): TreasureFeature {
  const [state, setState] = useState<TreasureStateSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [localNowMs, setLocalNowMs] = useState(() => Date.now());
  const presenterRef = useRef<TreasureMapPresenter | null>(null);
  const callbacksRef = useRef(input);
  callbacksRef.current = input;
  const { serverHttpBase, csrfToken, enabled, activeMap } = input;

  const receive = useCallback((next: TreasureStateSnapshot) => {
    setState(next);
    setClockOffsetMs(Date.parse(next.serverTime) - Date.now());
    setLocalNowMs(Date.now());
  }, []);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void treasureRequest<{ state: TreasureStateSnapshot }>(serverHttpBase, csrfToken, "/api/treasure")
      .then((result) => receive(result.state))
      .catch(() => undefined);
  }, [csrfToken, enabled, receive, serverHttpBase]);

  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    const poll = window.setInterval(refresh, POLL_MS);
    const clock = window.setInterval(() => setLocalNowMs(Date.now()), CLOCK_MS);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!activeMap) return undefined;
    const presenter = new TreasureMapPresenter(activeMap);
    presenterRef.current = presenter;
    return () => {
      presenter.destroy();
      if (presenterRef.current === presenter) presenterRef.current = null;
    };
  }, [activeMap]);

  useEffect(() => {
    presenterRef.current?.update(enabled ? state?.caches ?? [] : []);
  }, [activeMap, enabled, state]);

  const mutate = useCallback((path: string, body: Record<string, unknown>) => {
    if (pending) return;
    setPending(true);
    void treasureRequest<MutationResponse>(serverHttpBase, csrfToken, path, { ...body, requestId: crypto.randomUUID() })
      .then((result) => {
        receive(result.state);
        setSelectedId(null);
        if (result.inventory) callbacksRef.current.receiveInventory(result.inventory);
        callbacksRef.current.onMessage(result.message);
      })
      .catch((error: unknown) => {
        callbacksRef.current.onError(error instanceof Error ? error.message : "Treasure request failed.");
        refresh();
      })
      .finally(() => setPending(false));
  }, [csrfToken, pending, receive, refresh, serverHttpBase]);

  const dig = useCallback((treasureId: string) => mutate("/api/treasure/dig", { treasureId }), [mutate]);

  const digNearest = useCallback((position: LatLon | null): boolean => {
    const { onError } = callbacksRef.current;
    if (!enabled || !state) {
      onError("Treasure is not available here.");
      return true;
    }
    const nearest = position
      ? state.caches
        .map((cache) => ({ cache, distanceM: distanceMeters(position, cache) }))
        .filter((entry) => entry.distanceM <= TREASURE_DIG_RADIUS_M)
        .sort((left, right) => left.distanceM - right.distanceM)[0]
      : undefined;
    if (!nearest) onError(`No buried treasure within ${TREASURE_DIG_RADIUS_M} m.`);
    else if (state.shovels < 1) onError("You need a Shovel to dig.");
    else dig(nearest.cache.id);
    return true;
  }, [dig, enabled, state]);

  const pickAt = useCallback((point: { x: number; y: number }): boolean => {
    const id = presenterRef.current?.pickAt(point) ?? null;
    if (id) setSelectedId(id);
    return id !== null;
  }, []);
  const clearSelection = useCallback(() => setSelectedId(null), []);
  const selected = selectedId ? state?.caches.find((cache) => cache.id === selectedId) ?? null : null;

  return {
    state,
    serverNowMs: localNowMs + clockOffsetMs,
    pending,
    refresh,
    artisanShovel: () => mutate("/api/treasure/artisan-shovel", {}),
    dig,
    digNearest,
    selected,
    pickAt,
    clearSelection
  };
}
