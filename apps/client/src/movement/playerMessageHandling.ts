import type { LatLon, PlayerSnapshot, ServerMessage } from "@ash-atlas/shared";

import type {
  LocalMovementAcceptance,
  LocalMovementRequestTracker
} from "./localMovementRequests.js";
import type { PlayerRenderTimeline } from "./playerRenderSmoothing.js";

type MoveAcceptedMessage = Extract<ServerMessage, { type: "MOVE_ACCEPTED" }>;
type PlayerSnapshotMessage = Extract<ServerMessage, { type: "PLAYER_SNAPSHOT" }>;

export function handleLocalMoveAccepted(
  tracker: LocalMovementRequestTracker,
  message: MoveAcceptedMessage
): LocalMovementAcceptance {
  return tracker.accept(message.requestId);
}

export function isStaleLocalMoveRejection(
  tracker: LocalMovementRequestTracker,
  code: string,
  requestId: string | undefined
): boolean {
  return code === "MOVE_REJECTED" && !tracker.isCurrent(requestId);
}

export function snapshotSequenceBaseline(message: PlayerSnapshotMessage): number {
  return message.sequence;
}

export function snapLifecyclePlayer(
  timeline: PlayerRenderTimeline,
  player: PlayerSnapshot,
  clientNowMs: number,
  reason: "flag-visited" | "city-visited" | "manor-exit" | "dev-teleport",
  movementRequests?: LocalMovementRequestTracker,
  boundTravelRequestId?: string
): ReturnType<LocalMovementRequestTracker["snapshot"]> {
  if (timeline.snapPlayer(player, Date.parse(player.updatedAt), clientNowMs, reason)) {
    if (movementRequests) {
      return boundTravelRequestId
        ? movementRequests.resetUnlessBoundTo(boundTravelRequestId)
        : (movementRequests.reset(), null);
    }
  }
  return null;
}

export function snapRespawnedPlayer(
  timeline: PlayerRenderTimeline,
  playerId: string,
  position: LatLon,
  serverTimeMs: number,
  clientNowMs: number
): void {
  timeline.snapPosition(playerId, position, serverTimeMs, clientNowMs, "respawn");
}
