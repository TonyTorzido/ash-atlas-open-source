import type { PlayerDeltaUpsert, PlayerSnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { applyPlayerDelta, classifyPlayerDeltaSequence, playerDeltaAction } from "./playerReplication.js";

describe("playerDeltaAction", () => {
  it("drops old and duplicate deltas, applies the next one, and applies a delta past a gap while asking for a resync", () => {
    expect(playerDeltaAction(7, 7)).toEqual({ apply: false, resync: false });
    expect(playerDeltaAction(7, 3)).toEqual({ apply: false, resync: false });
    expect(playerDeltaAction(7, 8)).toEqual({ apply: true, resync: false });
    expect(playerDeltaAction(7, 9)).toEqual({ apply: true, resync: true });
    // After a resync snapshot the baseline is 0 and the new numbering starts at 1.
    expect(playerDeltaAction(0, 1)).toEqual({ apply: true, resync: false });
  });
});

describe("player delta application", () => {
  it("ignores duplicate and old deltas while detecting a sequence gap for resync", () => {
    expect(classifyPlayerDeltaSequence(7, 7)).toBe("ignore");
    expect(classifyPlayerDeltaSequence(7, 6)).toBe("ignore");
    expect(classifyPlayerDeltaSequence(7, 8)).toBe("apply");
    expect(classifyPlayerDeltaSequence(7, 9)).toBe("gap");
  });

  it("applies delta one after a full snapshot resets the replication baseline to zero", () => {
    const snapshotSequence = 0;
    expect(classifyPlayerDeltaSequence(snapshotSequence, 1)).toBe("apply");
    expect(classifyPlayerDeltaSequence(snapshotSequence, 2)).toBe("gap");
  });

  it("updates movement without clearing unchanged identity, anchor, or leash fields", () => {
    const original = playerSnapshot("p1");
    const movement: PlayerDeltaUpsert = {
      kind: "movement",
      playerId: "p1",
      lat: 35.0845,
      lon: -106.6503,
      movementRevision: 1,
      targetLat: 35.085,
      targetLon: -106.65,
      moving: true,
      online: true,
      updatedAt: "2026-07-09T00:00:00.100Z"
    };

    expect(applyPlayerDelta([original], [movement], [])[0]).toEqual({
      ...original,
      lat: movement.lat,
      lon: movement.lon,
      movementRevision: movement.movementRevision,
      relocationRevision: 0,
      targetLat: movement.targetLat,
      targetLon: movement.targetLon,
      moving: true,
      updatedAt: movement.updatedAt
    });
  });

  it("removes departed players and accepts full AOI entrants", () => {
    const entrant = playerSnapshot("p2");
    expect(applyPlayerDelta([playerSnapshot("p1")], [{ kind: "full", player: entrant }], ["p1"]))
      .toEqual([entrant]);
  });

  it("does not prune a distant player without an authoritative removal", () => {
    const local = playerSnapshot("p1");
    const distant = {
      ...playerSnapshot("p2"),
      lat: 35.9,
      lon: -107.4
    };

    expect(applyPlayerDelta([local, distant], [], [])).toEqual([local, distant]);
  });

  it("rejects stale relocation epochs while accepting movement in the current epoch", () => {
    const relocated = { ...playerSnapshot("p1"), relocationRevision: 2, lat: 36, lon: -107 };
    const stale: PlayerDeltaUpsert = {
      kind: "movement",
      playerId: "p1",
      lat: 35,
      lon: -106,
      movementRevision: 99,
      relocationRevision: 1,
      targetLat: 35.1,
      targetLon: -106.1,
      moving: true,
      online: true,
      updatedAt: "2030-01-01T00:00:00.000Z"
    };
    const current = { ...stale, lat: 36.1, lon: -107.1, relocationRevision: 2 };

    expect(applyPlayerDelta([relocated], [stale], [])).toEqual([relocated]);
    expect(applyPlayerDelta([relocated], [current], [])[0]).toMatchObject({
      lat: 36.1,
      lon: -107.1,
      relocationRevision: 2
    });
    expect(applyPlayerDelta([relocated], [{
      kind: "full",
      player: { ...playerSnapshot("p1"), relocationRevision: 1 }
    }], [])).toEqual([relocated]);
  });

  it("does not let a stale full upsert roll back a newer appearance revision", () => {
    const current = {
      ...playerSnapshot("p1"),
      appearance: appearance(8, "secondary")
    };
    const incoming = {
      ...playerSnapshot("p1"),
      appearance: appearance(7, "melee")
    };

    expect(applyPlayerDelta(
      [current],
      [{ kind: "full", player: incoming }],
      []
    )[0]?.appearance).toEqual(current.appearance);
  });
});

function appearance(
  revision: number,
  activeHand: "melee" | "secondary"
): NonNullable<PlayerSnapshot["appearance"]> {
  return {
    schemaVersion: 1,
    catalogRevision: 1,
    revision,
    bodyVariantId: "default",
    poseId: "idle",
    slots: {},
    activeHand
  };
}

function playerSnapshot(playerId: string): PlayerSnapshot {
  return {
    playerId,
    username: `Player ${playerId}`,
    displayColor: "#38bdf8",
    regionCode: "NM",
    zoneId: "world:NM",
    lat: 35.0844,
    lon: -106.6504,
    anchorLat: 35.0844,
    anchorLon: -106.6504,
    moveLeashRadiusM: 900,
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-07-09T00:00:00.000Z"
  };
}
