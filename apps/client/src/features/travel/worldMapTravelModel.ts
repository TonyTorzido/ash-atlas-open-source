import {
  WORLD_MAP_ARRIVAL_MS,
  WORLD_MAP_DISTANCE_AT_MAX_DURATION_M,
  WORLD_MAP_TRAVEL_MAX_MS,
  WORLD_MAP_TRAVEL_MIN_MS,
  worldMapTravelDurationMs,
  type LatLon,
  type ServerMessage,
  type TravelServerMessage,
  type WorldMapDestination
} from "@ash-atlas/shared";

export {
  WORLD_MAP_ARRIVAL_MS,
  WORLD_MAP_DISTANCE_AT_MAX_DURATION_M,
  WORLD_MAP_TRAVEL_MAX_MS,
  WORLD_MAP_TRAVEL_MIN_MS,
  worldMapTravelDurationMs
};

export type ActiveWorldMapTravelState = {
  phase: "travelling" | "preparing" | "arriving";
  requestId: string;
  origin: LatLon;
  destination: WorldMapDestination;
  startedAtMs: number;
  durationMs: number;
  authoritativeSuccess: boolean;
  presentationComplete: boolean;
};

export type WorldMapTravelState =
  | { phase: "idle" }
  | ActiveWorldMapTravelState
  | {
      phase: "failed";
      requestId: string;
      origin: LatLon;
      destination: WorldMapDestination;
      message: string;
    };

export type WorldMapTravelAction =
  | {
      type: "started";
      requestId: string;
      origin: LatLon;
      destination: WorldMapDestination;
      startedAtMs: number;
      durationMs: number;
    }
  | { type: "presentation_complete"; requestId: string }
  | { type: "authoritative_success"; requestId: string }
  | { type: "failed"; requestId: string; message: string }
  | { type: "reset" };

type WorldMapTravelFrame =
  | TravelServerMessage
  | Extract<ServerMessage, { type: "ERROR" | "MANOR_ERROR" }>;

export type WorldMapTravelFrameOutcome =
  | { type: "success"; requestId: string }
  | { type: "failure"; requestId: string; message: string }
  | null;

export function isWorldMapTravelActive(
  state: WorldMapTravelState
): state is ActiveWorldMapTravelState {
  return state.phase === "travelling" ||
    state.phase === "preparing" ||
    state.phase === "arriving";
}

export function worldMapTravelFrameOutcome(
  state: WorldMapTravelState,
  message: WorldMapTravelFrame
): WorldMapTravelFrameOutcome {
  if (
    !isWorldMapTravelActive(state) ||
    !("requestId" in message) ||
    message.requestId !== state.requestId
  ) {
    return null;
  }
  if (message.type === "ERROR" || message.type === "MANOR_ERROR") {
    return {
      type: "failure",
      requestId: state.requestId,
      message: message.message
    };
  }
  if (
    state.destination.kind === "city" &&
    message.type === "CITY_VISITED" &&
    message.cityId === state.destination.id
  ) {
    return { type: "success", requestId: state.requestId };
  }
  if (
    state.destination.kind === "kingdom" &&
    message.type === "FLAG_VISITED" &&
    message.flagId === state.destination.seatId
  ) {
    return { type: "success", requestId: state.requestId };
  }
  if (
    state.destination.kind === "atlas_shrine" &&
    message.type === "FLAG_VISITED" &&
    message.flagId === state.destination.id
  ) {
    return { type: "success", requestId: state.requestId };
  }
  if (
    state.destination.kind === "manor" &&
    message.type === "TRAVEL_RESULT" &&
    message.kind === "manor_jump"
  ) {
    return message.success
      ? { type: "success", requestId: state.requestId }
      : {
          type: "failure",
          requestId: state.requestId,
          message: message.message
        };
  }
  return null;
}

export function worldMapTravelReducer(
  state: WorldMapTravelState,
  action: WorldMapTravelAction
): WorldMapTravelState {
  switch (action.type) {
    case "started":
      return {
        phase: "travelling",
        requestId: action.requestId,
        origin: action.origin,
        destination: action.destination,
        startedAtMs: action.startedAtMs,
        durationMs: action.durationMs,
        authoritativeSuccess: false,
        presentationComplete: false
      };
    case "presentation_complete":
      if (!isWorldMapTravelActive(state) || state.requestId !== action.requestId) {
        return state;
      }
      return {
        ...state,
        phase: state.authoritativeSuccess ? "arriving" : "preparing",
        presentationComplete: true
      };
    case "authoritative_success":
      if (!isWorldMapTravelActive(state) || state.requestId !== action.requestId) {
        return state;
      }
      return {
        ...state,
        phase: state.presentationComplete ? "arriving" : "travelling",
        authoritativeSuccess: true,
        presentationComplete: state.presentationComplete
      };
    case "failed":
      if (!isWorldMapTravelActive(state) || state.requestId !== action.requestId) {
        return state;
      }
      return {
        phase: "failed",
        requestId: state.requestId,
        origin: state.origin,
        destination: state.destination,
        message: action.message
      };
    case "reset":
      return { phase: "idle" };
  }
}
