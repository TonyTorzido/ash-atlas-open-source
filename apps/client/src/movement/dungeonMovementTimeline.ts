import type { DungeonPlayerSnapshot, IndoorPosition } from "@ash-atlas/shared";

import {
  IndoorMovementTimeline,
  type IndoorMovementApplyResult,
  type IndoorRenderedPosition
} from "./indoorMovementTimeline.js";

export type DungeonRenderedPosition = IndoorRenderedPosition;
export type DungeonMovementApplyResult = IndoorMovementApplyResult;

/** Dungeon-shaped adapter over the canonical indoor reconciliation timeline. */
export class DungeonMovementTimeline {
  private readonly timeline = new IndoorMovementTimeline<IndoorPosition>(0);

  start(runId: string, player: DungeonPlayerSnapshot, serverTime: number, clientNowMs: number): void {
    this.timeline.setMovementSpeed(player.movementSpeed);
    this.timeline.start(runId, timelinePosition(player), player.movementRevision, serverTime, clientNowMs);
  }

  applySnapshot(
    runId: string,
    player: DungeonPlayerSnapshot,
    serverTime: number,
    clientNowMs: number
  ): DungeonMovementApplyResult {
    this.timeline.setMovementSpeed(player.movementSpeed);
    return this.timeline.applySnapshot(
      runId,
      timelinePosition(player),
      player.movementRevision,
      serverTime,
      clientNowMs
    );
  }

  render(clientNowMs: number): DungeonRenderedPosition | null {
    return this.timeline.render(clientNowMs);
  }

  beginDash(to: IndoorPosition | { x: number; y: number }, durationMs: number, clientNowMs: number): void {
    this.timeline.beginDash({ x: to.x, y: to.y }, durationMs, clientNowMs);
  }

  currentRunId(): string | null {
    return this.timeline.currentSessionId();
  }

  clear(): void {
    this.timeline.clear();
  }
}

function timelinePosition(player: DungeonPlayerSnapshot): IndoorPosition {
  const moving = player.targetX !== null && player.targetY !== null;
  return {
    x: player.x,
    y: player.y,
    targetX: player.targetX,
    targetY: player.targetY,
    moving,
    revision: player.movementRevision
  };
}
