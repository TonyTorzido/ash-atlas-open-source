import type { PlayerSnapshot, ServerMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { LocalMovementRequestTracker } from "./localMovementRequests.js";
import {
  handleLocalMoveAccepted,
  isStaleLocalMoveRejection,
  snapshotSequenceBaseline,
  snapLifecyclePlayer,
  snapRespawnedPlayer
} from "./playerMessageHandling.js";
import { classifyPlayerDeltaSequence } from "./playerReplication.js";
import { PlayerRenderTimeline } from "./playerRenderSmoothing.js";

describe("App player message handling", () => {
  it("classifies rapid out-of-order acceptances without changing rendered position", () => {
    const tracker = new LocalMovementRequestTracker();
    const timeline = new PlayerRenderTimeline(0);
    const player = playerSnapshot();
    timeline.configureTracedPlayer(player.playerId);
    timeline.applySnapshot([player], 1_000, 1_000, { sequence: 0 });
    const renderedBefore = timeline.renderPosition(player.playerId, 1_000);
    tracker.record("move-a", { lat: 35.0845, lon: -106.6504 }, 10);
    tracker.record("move-b", { lat: 35.0846, lon: -106.6504 }, 20);

    const stale = handleLocalMoveAccepted(tracker, moveAccepted("move-a", 1, 35.0845));
    const current = handleLocalMoveAccepted(tracker, moveAccepted("move-b", 2, 35.0846));
    const duplicate = handleLocalMoveAccepted(tracker, moveAccepted("move-b", 2, 35.0846));

    expect(stale.status).toBe("stale");
    expect(current.status).toBe("accepted");
    expect(duplicate.status).toBe("duplicate");
    expect(timeline.renderPosition(player.playerId, 1_500)).toEqual(renderedBefore);
  });

  it("ignores a stale movement rejection without suppressing the current request", () => {
    const tracker = new LocalMovementRequestTracker();
    const timeline = new PlayerRenderTimeline(0);
    const player = playerSnapshot();
    timeline.configureLocalPlayer(player.playerId, { speedMps: 500, serverTickHz: 20 });
    timeline.applySnapshot([player], 1_000, 1_000, { sequence: 0 });
    const renderedBefore = timeline.renderPosition(player.playerId, 1_000)!;
    const requestA = tracker.record("move-a", { lat: 35.0845, lon: -106.6504 }, 10);
    timeline.beginLocalAnticipation(
      requestA.requestId,
      requestA.generation,
      requestA.target,
      1_000
    );
    const requestB = tracker.record("move-b", { lat: 35.0846, lon: -106.6504 }, 20);
    timeline.beginLocalAnticipation(
      requestB.requestId,
      requestB.generation,
      requestB.target,
      1_000
    );
    const beforeStaleRejection = timeline.renderPosition(player.playerId, 1_016)!;

    expect(isStaleLocalMoveRejection(tracker, "MOVE_REJECTED", "move-a")).toBe(true);
    expect(isStaleLocalMoveRejection(tracker, "MOVE_REJECTED", "move-b")).toBe(false);
    expect(isStaleLocalMoveRejection(tracker, "OTHER_ERROR", "move-a")).toBe(false);
    expect(timeline.rejectLocalAnticipation("move-a", 1_016)).toBe(false);
    const afterStaleRejection = timeline.renderPosition(player.playerId, 1_032)!;
    expect(afterStaleRejection.lat).toBeGreaterThan(beforeStaleRejection.lat);
    expect(afterStaleRejection.lat).toBeGreaterThan(renderedBefore.lat);
  });

  it("adopts snapshot zero as the baseline for the next delta", () => {
    const snapshot = {
      type: "PLAYER_SNAPSHOT",
      serverTime: 100,
      sequence: 0,
      players: []
    } satisfies Extract<ServerMessage, { type: "PLAYER_SNAPSHOT" }>;

    const baseline = snapshotSequenceBaseline(snapshot);

    expect(baseline).toBe(0);
    expect(classifyPlayerDeltaSequence(baseline, 1)).toBe("apply");
  });

  it("routes visits, dev teleports, and respawns through explicit snap reasons", () => {
    const snapPlayer = vi
      .fn<PlayerRenderTimeline["snapPlayer"]>()
      .mockReturnValue(true);
    const snapPosition = vi.fn();
    const timeline = { snapPlayer, snapPosition } as unknown as PlayerRenderTimeline;
    const player = playerSnapshot();
    const tracker = new LocalMovementRequestTracker();
    tracker.record("pre-travel", { lat: 35.1, lon: -106.7 }, 100);

    snapLifecyclePlayer(timeline, player, 200, "flag-visited", tracker);
    snapLifecyclePlayer(timeline, player, 210, "city-visited");
    snapLifecyclePlayer(timeline, player, 220, "dev-teleport");
    snapRespawnedPlayer(
      timeline,
      player.playerId,
      { lat: player.lat, lon: player.lon },
      300,
      230
    );

    expect(snapPlayer.mock.calls.map((call) => call[3])).toEqual([
      "flag-visited",
      "city-visited",
      "dev-teleport"
    ]);
    expect(tracker.snapshot()).toBeNull();
    expect(snapPosition).toHaveBeenCalledWith(
      player.playerId,
      { lat: player.lat, lon: player.lon },
      300,
      230,
      "respawn"
    );
  });

  it("preserves a matching request-bound movement through the flag arrival snap", () => {
    const snapPlayer = vi
      .fn<PlayerRenderTimeline["snapPlayer"]>()
      .mockReturnValue(true);
    const timeline = { snapPlayer } as unknown as PlayerRenderTimeline;
    const player = playerSnapshot();
    const tracker = new LocalMovementRequestTracker();
    const request = tracker.record(
      "move-after-travel",
      { lat: 35.1, lon: -106.7 },
      100,
      "travel-a"
    );

    expect(snapLifecyclePlayer(
      timeline,
      player,
      200,
      "flag-visited",
      tracker,
      "travel-a"
    )).toEqual(request);
    expect(tracker.snapshot()).toEqual(request);
  });
});

function moveAccepted(
  requestId: string,
  movementRevision: number,
  lat: number
): Extract<ServerMessage, { type: "MOVE_ACCEPTED" }> {
  return {
    type: "MOVE_ACCEPTED",
    requestId,
    movementRevision,
    target: { lat, lon: -106.6504 }
  };
}

function playerSnapshot(): PlayerSnapshot {
  return {
    playerId: "player-1",
    username: "Ash",
    displayColor: "#38bdf8",
    regionCode: "NM",
    zoneId: "world:NM",
    lat: 35.0844,
    lon: -106.6504,
    anchorLat: 35.0844,
    anchorLon: -106.6504,
    moveLeashRadiusM: 900,
    movementRevision: 2,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-07-09T00:00:00.000Z"
  };
}
