import { destinationPoint } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { resourceVisionForFlag } from "./collectibles.js";
import { GameState } from "./state.js";
import { WorldReplicationService } from "./worldReplication.js";
import type { CombatInterestFrame } from "./combat/combatEngine.js";

describe("WorldReplicationService", () => {
  it("sends nearby upserts and removals without regional full snapshots", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    state.helloPlayer("p1", "ScoutOne");
    state.helloPlayer("p2", "ScoutTwo");
    state.helloPlayer("far", "FarScout");
    const replication = new WorldReplicationService(state);
    const initial = interest({ p1: ["p1", "p2"] });

    expect(replication.snapshotForPlayer("p1", initial).map((player) => player.playerId)).toEqual([
      "p1",
      "p2"
    ]);
    state.setTarget("p2", { lat: 35.0845, lon: -106.6504 });
    const changed = replication.deltaForPlayer("p1", initial);
    expect(changed?.upserts).toEqual([
      expect.objectContaining({ kind: "movement", playerId: "p2" })
    ]);
    expect(changed?.removedPlayerIds).toEqual([]);

    state.setPlayerColor("p2", "#ffffff");
    state.getPlayer("p2")!.updatedAt = new Date("2030-01-01T00:00:00.000Z");
    const staticChange = replication.deltaForPlayer("p1", initial);
    expect(staticChange?.upserts).toEqual([
      expect.objectContaining({
        kind: "full",
        player: expect.objectContaining({ playerId: "p2", displayColor: "#ffffff" })
      })
    ]);

    const afterExit = replication.deltaForPlayer("p1", interest({ p1: ["p1"] }));
    expect(afterExit?.removedPlayerIds).toEqual(["p2"]);
    expect(afterExit?.upserts).toEqual([]);
  });

  it("shows other players each player's active class and sends a full upsert when it changes", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    state.helloPlayer("p1", "ScoutOne");
    state.helloPlayer("p2", "ScoutTwo");
    const classes = new Map<string, "ronin" | "warrior">();
    state.setPlayerClassIdResolver((playerId) => classes.get(playerId) ?? null);
    const replication = new WorldReplicationService(state);
    const visible = interest({ p1: ["p1", "p2"] });
    const initial = replication.snapshotForPlayer("p1", visible);
    expect(initial.find((player) => player.playerId === "p2")).not.toHaveProperty("classId");
    expect(replication.deltaForPlayer("p1", visible)).toBeNull();

    classes.set("p2", "ronin");
    expect(replication.deltaForPlayer("p1", visible)?.upserts).toEqual([
      { kind: "full", player: expect.objectContaining({ playerId: "p2", classId: "ronin" }) }
    ]);
    classes.delete("p2");
    const dropped = replication.deltaForPlayer("p1", visible)?.upserts ?? [];
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ kind: "full", player: { playerId: "p2" } });
    expect(dropped[0]?.kind === "full" ? dropped[0].player : null).not.toHaveProperty("classId");
  });

  it("adds the effective walking speed to the owner's own movement upsert only", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    state.helloPlayer("p1", "ScoutOne");
    state.helloPlayer("p2", "ScoutTwo");
    const replication = new WorldReplicationService(state);
    const visible = interest({ p1: ["p1", "p2"], p2: ["p1", "p2"] });
    replication.snapshotForPlayer("p1", visible);
    replication.snapshotForPlayer("p2", visible);
    const start = state.getPlayer("p1")!.position;
    state.setTarget("p1", destinationPoint(start, 90, 40));
    state.setTarget("p2", destinationPoint(state.getPlayer("p2")!.position, 90, 40));
    // The tick caches the multiplier it applied (armour, slows, class bonuses).
    state.tick(0.05, (playerId) => (playerId === "p1" ? 0.9 : 1.1));
    const own = replication.deltaForPlayer("p1", visible)!.upserts;
    const basis = state.playerMovementSpeedMps;
    expect(own.find((u) => u.kind === "movement" && u.playerId === "p1"))
      .toMatchObject({ speedMps: expect.closeTo(basis * 0.9, 9) });
    expect(own.find((u) => u.kind === "movement" && u.playerId === "p2")).not.toHaveProperty("speedMps");
    const theirs = replication.deltaForPlayer("p2", visible)!.upserts;
    expect(theirs.find((u) => u.kind === "movement" && u.playerId === "p2"))
      .toMatchObject({ speedMps: expect.closeTo(basis * 1.1, 9) });
    // A mid-walk slow reaches the owner on the next delta.
    state.tick(0.05, () => 0.5);
    expect(replication.deltaForPlayer("p1", visible)!.upserts.find((u) => u.kind === "movement" && u.playerId === "p1"))
      .toMatchObject({ speedMps: expect.closeTo(basis * 0.5, 9) });
  });

  it("replicates gathering start and stop as full upserts and clears it on movement", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    state.helloPlayer("p1", "ScoutOne");
    state.helloPlayer("p2", "ScoutTwo");
    const replication = new WorldReplicationService(state);
    const visible = interest({ p1: ["p1", "p2"] });
    expect(replication.snapshotForPlayer("p1", visible)
      .find((player) => player.playerId === "p2")).not.toHaveProperty("gathering");
    const activity = {
      kind: "chop" as const,
      toolDefinitionId: "stone_axe",
      targetLat: 35.0845,
      targetLon: -106.6504,
      startedAt: "2030-01-01T00:00:00.000Z",
      completesAt: "2030-01-01T00:00:05.000Z"
    };
    state.setGatheringActivity("p2", activity);
    expect(replication.deltaForPlayer("p1", visible)?.upserts).toEqual([
      expect.objectContaining({
        kind: "full",
        player: expect.objectContaining({ playerId: "p2", gathering: activity })
      })
    ]);
    expect(replication.deltaForPlayer("p1", visible)).toBeNull();

    state.setTarget("p2", { lat: 35.0846, lon: -106.6504 });
    expect(state.gatheringActivity("p2")).toBeNull();
    const stopped = replication.deltaForPlayer("p1", visible)?.upserts ?? [];
    expect(stopped).toEqual([expect.objectContaining({ kind: "full" })]);
    expect((stopped[0] as { player: object }).player).not.toHaveProperty("gathering");
  });

  it("restarts delta sequencing after every full snapshot baseline", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    state.helloPlayer("p1", "ScoutOne");
    const replication = new WorldReplicationService(state);
    const visible = interest({ p1: ["p1"] });
    replication.snapshotForPlayer("p1", visible);
    state.setTarget("p1", { lat: 35.0845, lon: -106.6504 });
    state.getPlayer("p1")!.updatedAt = new Date("2030-01-01T00:00:00.000Z");
    expect(replication.deltaForPlayer("p1", visible)?.sequence).toBe(1);

    replication.snapshotForPlayer("p1", visible);
    state.setTarget("p1", { lat: 35.0846, lon: -106.6504 });
    state.getPlayer("p1")!.updatedAt = new Date("2030-01-01T00:00:01.000Z");

    expect(replication.deltaForPlayer("p1", visible)?.sequence).toBe(1);
  });

  it("replicates a relocation revision even when timestamps collide", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    state.helloPlayer("p1", "ScoutOne");
    state.helloPlayer("p2", "ScoutTwo");
    const replication = new WorldReplicationService(state);
    const visible = interest({ p1: ["p1", "p2"] });
    replication.snapshotForPlayer("p1", visible);
    const previousUpdatedAt = new Date(state.getPlayer("p2")!.updatedAt);

    state.teleportPlayer("p2", destinationPoint({ lat: 35.0844, lon: -106.6504 }, 500, 90));
    state.getPlayer("p2")!.updatedAt = previousUpdatedAt;

    expect(replication.deltaForPlayer("p1", visible)?.upserts).toEqual([
      expect.objectContaining({
        kind: "full",
        player: expect.objectContaining({ playerId: "p2", relocationRevision: 1 })
      })
    ]);
  });

  it("does not widen an authoritative interest frame from shared-flag membership", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const first = state.helloPlayer("p1", "ScoutOne");
    const second = state.helloPlayer("p2", "ScoutTwo");
    const center = { lat: 35.0844, lon: -106.6504 };
    const vision = resourceVisionForFlag({
      flagId: "shared-flag",
      flagName: "Shared Flag",
      flagCenter: center,
      movementLeashRadiusM: first.moveLeashRadiusM
    });
    state.applyValidatedFlagVisit(first.playerId, vision, destinationPoint(center, 140, 0));
    state.applyValidatedFlagVisit(second.playerId, vision, destinationPoint(center, 140, 180));
    const replication = new WorldReplicationService(state);
    const distanceOnlyInterest = interest({ p1: ["p1"] });

    expect(replication.snapshotForPlayer("p1", distanceOnlyInterest).map((player) => player.playerId))
      .toEqual(["p1"]);

    state.setTarget("p2", destinationPoint(center, 139, 175));
    state.getPlayer("p2")!.updatedAt = new Date("2031-01-01T00:00:00.000Z");
    const movement = replication.deltaForPlayer("p1", distanceOnlyInterest);
    expect(movement).toBeNull();
  });

  it("removes a player when the authoritative interest frame excludes them", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const first = state.helloPlayer("p1", "ScoutOne");
    const second = state.helloPlayer("p2", "ScoutTwo");
    const center = { lat: 35.0844, lon: -106.6504 };
    const sharedVision = resourceVisionForFlag({
      flagId: "shared-flag",
      flagName: "Shared Flag",
      flagCenter: center,
      movementLeashRadiusM: first.moveLeashRadiusM
    });
    state.applyValidatedFlagVisit(first.playerId, sharedVision, destinationPoint(center, 140, 0));
    state.applyValidatedFlagVisit(second.playerId, sharedVision, destinationPoint(center, 140, 180));
    const replication = new WorldReplicationService(state);
    replication.snapshotForPlayer("p1", interest({ p1: ["p1", "p2"] }));

    expect(replication.deltaForPlayer("p1", interest({ p1: ["p1"] }))?.removedPlayerIds)
      .toEqual(["p2"]);
  });

  it.each([
    ["private world", (state: GameState) => state.setWorldPresence("p2", false)],
    ["disconnect", (state: GameState) => state.markOffline("p2")]
  ])("does not leak same-flag players after %s", (_case, removePresence) => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const first = state.helloPlayer("p1", "ScoutOne");
    const second = state.helloPlayer("p2", "ScoutTwo");
    const center = { lat: 35.0844, lon: -106.6504 };
    const vision = resourceVisionForFlag({
      flagId: "shared-flag",
      flagName: "Shared Flag",
      flagCenter: center,
      movementLeashRadiusM: first.moveLeashRadiusM
    });
    state.applyValidatedFlagVisit(first.playerId, vision, destinationPoint(center, 100, 0));
    state.applyValidatedFlagVisit(second.playerId, vision, destinationPoint(center, 100, 180));
    const replication = new WorldReplicationService(state);
    const distanceOnlyInterest = interest({ p1: ["p1", "p2"] });
    replication.snapshotForPlayer("p1", distanceOnlyInterest);

    removePresence(state);

    expect(replication.deltaForPlayer("p1", distanceOnlyInterest)?.removedPlayerIds).toEqual(["p2"]);
  });
});

function interest(entries: Record<string, string[]>): CombatInterestFrame {
  return {
    nearbyIdsByPlayer: new Map(
      Object.entries(entries).map(([playerId, entityIds]) => [playerId, new Set(entityIds)])
    ),
    cacheHits: 0,
    cacheMisses: Object.keys(entries).length
  };
}
