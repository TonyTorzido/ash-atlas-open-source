import type {
  MapMarkerCommand,
  MapMarkersState,
  PlayerInventorySnapshot,
  ServerMessage
} from "@ash-atlas/shared";
import { useCallback, useRef, useState } from "react";

export type { MapMarkerCommand };
export type MapMarkersServerMessage = Extract<ServerMessage, { type: "MAP_MARKERS_STATE" | "MAP_MARKERS_ERROR" }>;

/** A spot waiting for a name: the player's own position or a tapped building. */
export type PendingMarkerSpot = Readonly<
  | { kind: "here"; defaultName: string }
  | { kind: "point"; lat: number; lon: number; defaultName: string }
>;

export interface MapMarkersOptions {
  /** Sends the command and returns its request id, or null when disconnected. */
  send(command: MapMarkerCommand): string | null;
  receiveInventory?(snapshot: PlayerInventorySnapshot): void;
  onNotice?(notice: string): void;
  onError?(message: string): void;
}

export function useMapMarkers({ send, receiveInventory, onNotice, onError }: MapMarkersOptions) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const [state, setState] = useState<MapMarkersState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSpot, setPendingSpot] = useState<PendingMarkerSpot | null>(null);
  const pendingRef = useRef<string | null>(null);

  const begin = useCallback((command: MapMarkerCommand): boolean => {
    if (pendingRef.current) return false;
    const requestId = send(command);
    if (!requestId) {
      setError("Map markers are unavailable while disconnected.");
      return false;
    }
    pendingRef.current = requestId;
    setBusy(true);
    setError(null);
    return true;
  }, [send]);

  const refresh = useCallback((): boolean => begin({ action: "list" }), [begin]);

  const handleServerMessage = useCallback((message: MapMarkersServerMessage): void => {
    const correlated = Boolean(message.requestId) && message.requestId === pendingRef.current;
    if (correlated) {
      pendingRef.current = null;
      setBusy(false);
    }
    if (message.type === "MAP_MARKERS_STATE") {
      setState(message.state);
      if (message.inventory) receiveInventory?.(message.inventory);
      if (correlated) {
        setError(null);
        setPendingSpot(null);
        if (message.notice) onNotice?.(message.notice);
      }
      return;
    }
    if (correlated || !message.requestId) {
      setError(message.message);
      if (!openRef.current) onError?.(message.message);
    }
  }, [onError, onNotice, receiveInventory]);

  const resetForWelcome = useCallback((): void => {
    setState(null);
    setBusy(false);
    setError(null);
    setPendingSpot(null);
    pendingRef.current = null;
  }, []);

  return {
    view: { open, state, busy, error, pendingSpot },
    actions: {
      setOpen,
      openPanel: (spot?: PendingMarkerSpot): void => {
        setOpen(true);
        setPendingSpot(spot ?? null);
        begin({ action: "list" });
      },
      closePanel: (): void => {
        setOpen(false);
        setPendingSpot(null);
      },
      startMarking: setPendingSpot,
      refresh,
      openCompass: () => begin({ action: "open_compass" }),
      craft: (item: "survey_stake_kit" | "compass") => begin({ action: "craft", item }),
      create: (name: string, spot: PendingMarkerSpot) => begin({
        action: "create",
        name,
        spot: spot.kind === "here" ? { kind: "here" } : { kind: "point", lat: spot.lat, lon: spot.lon }
      }),
      rename: (markerId: string, name: string) => begin({ action: "rename", markerId, name }),
      remove: (markerId: string) => begin({ action: "delete", markerId }),
      setWaypointToMarker: (markerId: string) => begin({
        action: "set_waypoint",
        target: { kind: "marker", markerId }
      }),
      setWaypointToDestination: (destinationKind: "city" | "manor" | "kingdom" | "atlas_shrine", destinationId: string) => begin({
        action: "set_waypoint",
        target: { kind: "destination", destinationKind, destinationId }
      }),
      clearWaypoint: () => begin({ action: "clear_waypoint" }),
      recordLocation: (name: string) => begin({ action: "record_location", name }),
      deleteRecordedLocation: (locationId: string) => begin({ action: "delete_recorded_location", locationId }),
      setWaypointToRecorded: (locationId: string) => begin({
        action: "set_waypoint",
        target: { kind: "recorded", locationId }
      })
    },
    handleServerMessage,
    resetForWelcome
  } as const;
}

export type MapMarkersFeature = ReturnType<typeof useMapMarkers>;
