import type { WorldViewAuthority } from "@ash-atlas/shared";

export type StartupState = {
  phase: "bootstrap_pending" | "connected" | "recoverable_error" | "presentation_error";
  socket: "connecting" | "open" | "closed";
  welcomeReceived: boolean;
  progressionReceived: boolean;
  locationReceived: boolean;
  mapReady: boolean;
  mapPainted: boolean;
  overlayReady: boolean;
  playerReceived: boolean;
  flagsReceived: boolean;
  worldReady: boolean;
  worldReadyAuthority: WorldViewAuthority | null;
  presentationSnapshotReceived: boolean;
  presentationSnapshotAuthority: WorldViewAuthority | null;
  closeCode: number | null;
  error: string | null;
  attempt: number;
  reconnectFailures: number;
};

export type StartupEvent =
  | { type: "retry" }
  | { type: "socket_open" }
  | { type: "welcome" }
  | { type: "progression" }
  | { type: "location" }
  | { type: "map_ready" }
  | { type: "map_invalidated" }
  | { type: "map_painted" }
  | { type: "overlay_ready" }
  | { type: "player" }
  | { type: "flags" }
  | { type: "world_preparing"; authority: WorldViewAuthority }
  | { type: "world_ready"; authority: WorldViewAuthority }
  | { type: "presentation_snapshot"; authority: WorldViewAuthority }
  | { type: "socket_closed"; code: number }
  | { type: "error"; message: string }
  | { type: "presentation_error"; message: string }
  | { type: "timeout" };

export const initialStartupState: StartupState = {
  phase: "bootstrap_pending",
  socket: "connecting",
  welcomeReceived: false,
  progressionReceived: false,
  locationReceived: false,
  mapReady: false,
  mapPainted: false,
  overlayReady: false,
  playerReceived: false,
  flagsReceived: false,
  worldReady: false,
  worldReadyAuthority: null,
  presentationSnapshotReceived: false,
  presentationSnapshotAuthority: null,
  closeCode: null,
  error: null,
  attempt: 0,
  reconnectFailures: 0
};

export function reduceStartupState(state: StartupState, event: StartupEvent): StartupState {
  if (event.type === "retry") {
    return {
      ...initialStartupState,
      mapReady: state.mapReady,
      mapPainted: state.mapPainted,
      overlayReady: state.overlayReady,
      attempt: state.attempt + 1
    };
  }
  if (event.type === "socket_open" && state.phase === "connected") {
    return {
      ...state,
      phase: "bootstrap_pending",
      socket: "open",
      welcomeReceived: false,
      progressionReceived: false,
      locationReceived: false,
      playerReceived: false,
      flagsReceived: false,
      worldReady: false,
      worldReadyAuthority: null,
      presentationSnapshotReceived: false,
      presentationSnapshotAuthority: null,
      error: null,
      closeCode: null
    };
  }
  if (event.type === "socket_closed") {
    const reconnectFailures = state.reconnectFailures + 1;
    const transient = [1001, 1006, 1011, 1012, 1013].includes(event.code);
    const retrying = transient;
    return {
      ...state,
      phase: retrying ? "bootstrap_pending" : "recoverable_error",
      socket: retrying ? "connecting" : "closed",
      progressionReceived: false,
      locationReceived: false,
      welcomeReceived: false,
      playerReceived: false,
      flagsReceived: false,
      worldReady: false,
      worldReadyAuthority: null,
      presentationSnapshotReceived: false,
      presentationSnapshotAuthority: null,
      closeCode: event.code,
      reconnectFailures,
      error: retrying
        ? "The game service restarted. Reconnecting automatically…"
        : `Game connection closed (code ${event.code}).`
    };
  }
  if (event.type === "error") {
    return { ...state, phase: "recoverable_error", error: event.message };
  }
  if (event.type === "presentation_error") {
    return { ...state, phase: "presentation_error", error: event.message };
  }
  if (event.type === "map_invalidated") {
    return { ...state, mapPainted: false };
  }
  if (event.type === "world_preparing") {
    const retainsMatchingCheckpoint = sameWorldViewAuthority(
      state.presentationSnapshotAuthority,
      event.authority
    );
    return {
      ...state,
      worldReady: false,
      worldReadyAuthority: null,
      presentationSnapshotReceived: retainsMatchingCheckpoint,
      presentationSnapshotAuthority: retainsMatchingCheckpoint
        ? state.presentationSnapshotAuthority
        : null
    };
  }
  if (event.type === "timeout") {
    return {
      ...state,
      phase: "presentation_error",
      error: "Game startup timed out before your map and player data finished loading."
    };
  }

  const next = {
    ...state,
    socket: event.type === "socket_open" || event.type === "welcome" ? "open" as const : state.socket,
    welcomeReceived: state.welcomeReceived || event.type === "welcome",
    progressionReceived: state.progressionReceived || event.type === "progression",
    locationReceived: state.locationReceived || event.type === "location",
    mapReady: state.mapReady || event.type === "map_ready",
    mapPainted: state.mapPainted || event.type === "map_painted",
    overlayReady: state.overlayReady || event.type === "overlay_ready",
    playerReceived: state.playerReceived || event.type === "player",
    flagsReceived: state.flagsReceived || event.type === "flags",
    worldReady: state.worldReady || event.type === "world_ready",
    worldReadyAuthority: event.type === "world_ready"
      ? event.authority
      : state.worldReadyAuthority,
    presentationSnapshotReceived:
      state.presentationSnapshotReceived || event.type === "presentation_snapshot",
    presentationSnapshotAuthority: event.type === "presentation_snapshot"
      ? event.authority
      : state.presentationSnapshotAuthority,
    error: null,
    closeCode: null
  };
  return next.socket === "open" &&
    next.welcomeReceived &&
    next.progressionReceived &&
    next.locationReceived
    ? { ...next, phase: "connected", reconnectFailures: 0 }
    : { ...next, phase: "bootstrap_pending" };
}

export function isStartupPresentationReady(
  state: StartupState,
  requiresWorldPresentation: boolean
): boolean {
  if (state.phase !== "connected") return false;
  return !requiresWorldPresentation || (
    state.mapReady
    && state.mapPainted
    && state.overlayReady
    && state.playerReceived
    && state.flagsReceived
    && state.worldReady
    && state.presentationSnapshotReceived
    && sameWorldViewAuthority(
      state.worldReadyAuthority,
      state.presentationSnapshotAuthority
    )
  );
}

export function sameWorldViewAuthority(
  left: WorldViewAuthority | null,
  right: WorldViewAuthority | null
): boolean {
  return left !== null && right !== null &&
    left.playerId === right.playerId &&
    left.connectionId === right.connectionId &&
    left.connectionGeneration === right.connectionGeneration &&
    left.relocationRevision === right.relocationRevision &&
    left.resourceVisionRevision === right.resourceVisionRevision &&
    left.gameplayViewGeneration === right.gameplayViewGeneration &&
    left.populationPreparationGeneration ===
      right.populationPreparationGeneration;
}

export function isCurrentWorldPresentation(
  captured: WorldViewAuthority | null,
  state: StartupState,
  currentAuthority: WorldViewAuthority | null
): boolean {
  return captured !== null &&
    isStartupPresentationReady(state, true) &&
    sameWorldViewAuthority(captured, state.worldReadyAuthority) &&
    sameWorldViewAuthority(captured, currentAuthority);
}
