import { beforeEach, describe, expect, it } from "vitest";

import {
  clearMovementTrace,
  getMovementTrace,
  MOVEMENT_TRACE_MAX_ENTRIES,
  movementTraceJson,
  recordMovementTrace,
  setMovementTraceEnabled
} from "./movementDebugTrace.js";

describe("development movement trace", () => {
  beforeEach(() => {
    setMovementTraceEnabled(true);
    clearMovementTrace();
  });

  it("captures structured movement evidence that can be copied as JSON", () => {
    recordMovementTrace({
      clientTimeMs: 123,
      messageType: "PLAYER_SNAPSHOT",
      requestId: "move-1",
      movementGeneration: 2,
      movementRevision: 7,
      replicationSequence: 0,
      serverTimeMs: 100,
      authoritativePosition: { lat: 35.0844, lon: -106.6504 },
      renderedBefore: { lat: 35.0844, lon: -106.6503 },
      renderedAfter: { lat: 35.0844, lon: -106.6502 },
      target: { lat: 35.0844, lon: -106.65 },
      anchor: { lat: 35.0844, lon: -106.6504 },
      correctionDistanceM: 8,
      outcome: "interpolated",
      reason: "player-sequence-gap"
    });

    expect(getMovementTrace()).toEqual([
      expect.objectContaining({
        clientTimeMs: 123,
        messageType: "PLAYER_SNAPSHOT",
        replicationSequence: 0,
        outcome: "interpolated"
      })
    ]);
    expect(JSON.parse(movementTraceJson())).toHaveLength(1);
  });

  it("retains only the newest bounded entries", () => {
    for (let index = 0; index < MOVEMENT_TRACE_MAX_ENTRIES + 5; index += 1) {
      recordMovementTrace({
        clientTimeMs: index,
        messageType: "render",
        outcome: "held"
      });
    }

    const entries = getMovementTrace();
    expect(entries).toHaveLength(MOVEMENT_TRACE_MAX_ENTRIES);
    expect(entries[0]?.clientTimeMs).toBe(5);
  });

  it("does not collect entries while the development flag is disabled", () => {
    setMovementTraceEnabled(false);
    recordMovementTrace({
      clientTimeMs: 1,
      messageType: "PLAYER_DELTA",
      outcome: "ignored"
    });

    expect(getMovementTrace()).toEqual([]);
  });
});
