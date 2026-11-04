import { distanceMeters, type LatLon, type WaterSiteSnapshot } from "@ash-atlas/shared";
import type maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";

import { WaterSitesMapPresenter } from "../../map/waterSitesMap.js";
import type { WaterSiteActionType } from "./waterSitePrompt.js";

const POLL_MS = 20_000;
/** Ask again once the player has moved this far since the last list. */
const REFRESH_DISTANCE_M = 400;
const PENDING_TIMEOUT_MS = 8_000;

export type WaterSitesFeature = Readonly<{
  sites: readonly WaterSiteSnapshot[];
  tidecraftRank: number;
  tidecraftDiscovered: boolean;
  selected: WaterSiteSnapshot | null;
  pending: boolean;
  pickAt(point: { x: number; y: number }): boolean;
  clearSelection(): void;
  act(type: WaterSiteActionType, siteId: string): void;
  receiveSites(message: Readonly<{ sites: readonly WaterSiteSnapshot[]; tidecraftRank: number; tidecraftDiscovered: boolean }>): void;
  receiveDive(message: Readonly<{ siteId: string; diveReadyAt: number }>): void;
}>;

/**
 * Pearl Beds, whirlpools and Drowned City sites on the client: asks the server
 * for the sites around the player (on a timer and after moving), draws them,
 * and sends the server-authoritative Dive / Ride / Present actions.
 */
export function useWaterSitesFeature(input: Readonly<{
  activeMap: maplibregl.Map | null;
  enabled: boolean;
  position: LatLon | null;
  requestSites(): boolean;
  sendAction(type: WaterSiteActionType, siteId: string): string | null;
  onError(message: string): void;
}>): WaterSitesFeature {
  const [sites, setSites] = useState<readonly WaterSiteSnapshot[]>([]);
  const [rank, setRank] = useState(0);
  const [discovered, setDiscovered] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const presenterRef = useRef<WaterSitesMapPresenter | null>(null);
  const lastRequestPositionRef = useRef<LatLon | null>(null);
  const callbacksRef = useRef(input);
  callbacksRef.current = input;
  const { activeMap, enabled, position } = input;

  const refresh = useCallback(() => {
    if (!callbacksRef.current.enabled) return;
    if (callbacksRef.current.requestSites()) lastRequestPositionRef.current = callbacksRef.current.position;
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSites([]);
      return undefined;
    }
    refresh();
    const poll = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(poll);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !position) return;
    const last = lastRequestPositionRef.current;
    if (!last || distanceMeters(last, position) > REFRESH_DISTANCE_M) refresh();
  }, [enabled, position, refresh]);

  useEffect(() => {
    if (!activeMap) return undefined;
    const presenter = new WaterSitesMapPresenter(activeMap);
    presenterRef.current = presenter;
    return () => {
      presenter.destroy();
      if (presenterRef.current === presenter) presenterRef.current = null;
    };
  }, [activeMap]);

  useEffect(() => {
    presenterRef.current?.update(enabled ? sites : []);
  }, [activeMap, enabled, sites]);

  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setTimeout(() => setPending(false), PENDING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const receiveSites = useCallback((message: Readonly<{ sites: readonly WaterSiteSnapshot[]; tidecraftRank: number; tidecraftDiscovered: boolean }>) => {
    setSites(message.sites);
    setRank(message.tidecraftRank);
    setDiscovered(message.tidecraftDiscovered);
    setPending(false);
  }, []);

  const receiveDive = useCallback((message: Readonly<{ siteId: string; diveReadyAt: number }>) => {
    setSites((current) => current.map((site) => site.siteId === message.siteId ? { ...site, diveReadyAt: message.diveReadyAt } : site));
    setPending(false);
  }, []);

  const act = useCallback((type: WaterSiteActionType, siteId: string) => {
    if (pending) return;
    if (!callbacksRef.current.sendAction(type, siteId)) {
      callbacksRef.current.onError("That could not be sent right now.");
      return;
    }
    setPending(true);
    setSelectedId(null);
    // Ranks, orbs and the map move after an action: ask for a fresh list shortly after.
    window.setTimeout(refresh, 1_500);
  }, [pending, refresh]);

  const pickAt = useCallback((point: { x: number; y: number }): boolean => {
    const id = presenterRef.current?.pickAt(point) ?? null;
    if (id) setSelectedId(id);
    return id !== null;
  }, []);

  return {
    sites,
    tidecraftRank: rank,
    tidecraftDiscovered: discovered,
    selected: selectedId ? sites.find((site) => site.siteId === selectedId) ?? null : null,
    pending,
    pickAt,
    clearSelection: () => setSelectedId(null),
    act,
    receiveSites,
    receiveDive
  };
}
