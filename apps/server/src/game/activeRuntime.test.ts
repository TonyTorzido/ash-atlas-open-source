import { destinationPoint } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { GameState } from "./state.js";

describe("active runtime indexes", () => {
  it("ticks only moving online players regardless of loaded offline identities", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    for (let index = 0; index < 10_000; index += 1) {
      const player = state.helloPlayer(`offline-${index}`, `Offline ${index}`);
      state.markOffline(player.playerId);
    }
    const moving = state.helloPlayer("moving", "Moving");
    state.setTarget(moving.playerId, { lat: moving.anchor.lat, lon: moving.anchor.lon + 0.001 });
    let multiplierCalls = 0;

    state.tick(0.01, () => {
      multiplierCalls += 1;
      return 1;
    });

    expect(multiplierCalls).toBe(1);
    expect(state.activeRuntimeMetrics()).toMatchObject({
      loadedPlayers: 10_001,
      onlinePlayers: 1,
      movingPlayers: 1,
      replicationPlayers: 1
    });
  });

  it("evicts an offline player only after the same generation and version persist", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const player = state.helloPlayer("player-1", "Ash");
    state.markOffline(player.playerId);
    const persisted = state.capturePlayerPersistence(player.playerId);

    expect(state.acknowledgePlayerPersistence(persisted)).toBe(true);
    expect(state.getPlayer(player.playerId)).toBeUndefined();
    expect(state.activeRuntimeMetrics().loadedPlayers).toBe(0);
  });

  it("does not let a stale persistence completion evict a reconnect", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const player = state.helloPlayer("player-1", "Ash");
    state.markOffline(player.playerId);
    const stale = state.capturePlayerPersistence(player.playerId);
    state.markOnlinePreservingView(player.playerId);

    expect(state.acknowledgePlayerPersistence(stale)).toBe(false);
    expect(state.getPlayer(player.playerId)?.online).toBe(true);
    expect(state.activeRuntimeMetrics().replicationPlayers).toBe(1);
  });

  it("updates flag, vision, movement, and replication membership incrementally", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const player = state.helloPlayer("player-1", "Ash");
    state.setResourceVision(player.playerId, {
      flagId: "11111111-1111-4111-8111-111111111111",
      flagName: "Mesa",
      center: player.anchor,
      movementLeashRadiusM: player.moveLeashRadiusM,
      paddingM: 50,
      radiusM: player.moveLeashRadiusM + 50
    });

    expect(state.playerIdsAtFlag("11111111-1111-4111-8111-111111111111")).toEqual([player.playerId]);
    expect(state.activeRuntimeMetrics()).toMatchObject({
      resourceVisionPlayers: 1,
      flagMemberships: 1,
      replicationPlayers: 1
    });

    state.setWorldPresence(player.playerId, false);
    expect(state.playerIdsAtFlag("11111111-1111-4111-8111-111111111111")).toEqual([]);
    expect(state.activeRuntimeMetrics()).toMatchObject({
      resourceVisionPlayers: 0,
      flagMemberships: 0,
      replicationPlayers: 0
    });
  });

  it("selects replication audiences by anchor-centered gameplay geometry", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const centerA = { lat: 35.0844, lon: -106.6504 };
    const centerB = destinationPoint(centerA, 1_200, 90);
    const overlap = destinationPoint(centerA, 600, 90);
    const onlyA = destinationPoint(centerA, 649, 270);
    const openAnchor = destinationPoint(centerA, 3_000, 0);
    const playerA = state.helloPlayer("player-a", "A");
    const playerB = state.helloPlayer("player-b", "B");
    const noCircle = state.helloPlayer("no-circle", "No Circle");
    state.applyValidatedFlagVisit(playerA.playerId, vision("flag-a", centerA));
    state.applyValidatedFlagVisit(playerB.playerId, vision("flag-b", centerB));
    state.applyAuthoritativeRelocation({
      playerId: noCircle.playerId,
      anchor: openAnchor,
      resourceVision: null
    });

    expect(state.playerIdsWhoseGameplayViewCircleContains(overlap)).toEqual(["player-a", "player-b"]);
    expect(state.playerIdsWhoseGameplayViewCircleContains(onlyA)).toEqual(["player-a"]);
    expect(state.playerIdsWhoseGameplayViewCircleContains(openAnchor)).toEqual([noCircle.playerId]);
    expect(state.playerIdsWithGameplayViewCircle()).toEqual(["no-circle", "player-a", "player-b"]);
  });

  it("keeps an open-area vision active without treating it as a durable flag", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const player = state.helloPlayer("open-land", "Open Land");
    const syntheticAreaId = "146f170f-0000-4000-8000-000000000000";
    state.setResourceVision(player.playerId, {
      flagId: syntheticAreaId,
      flagName: "Open area",
      destinationKind: "area",
      center: player.anchor,
      movementLeashRadiusM: player.moveLeashRadiusM,
      paddingM: 0,
      radiusM: 1_500
    });

    expect(state.currentFlagId(player.playerId)).toBeNull();
    expect(state.snapshotForPlayer(player.playerId).currentFlagId).toBeNull();
    expect(state.playerIdsAtFlag(syntheticAreaId)).toEqual([]);
    expect(state.playerIdsWithGameplayViewCircle()).toEqual([player.playerId]);
    expect(state.activeRuntimeMetrics()).toMatchObject({
      resourceVisionPlayers: 1,
      flagMemberships: 0
    });
  });

  it("keeps the resource vision when a death recovery restores the owned anchor", () => {
    const state = new GameState(loadConfig({ NODE_ENV: "test" }));
    const player = state.helloPlayer("dies-at-flag", "Mortal");
    state.applyValidatedFlagVisit(player.playerId, vision("flag-death", player.anchor));
    const visionBefore = state.getResourceVision(player.playerId);
    expect(visionBefore).not.toBeNull();

    // Death recovery lands on the existing anchor; the vision (and so the harvestable view) must survive.
    const recovered = state.restoreWorldPosition(player.playerId, player.anchor, player.regionCode);

    expect(recovered.anchor).toEqual(player.anchor);
    expect(state.getResourceVision(player.playerId)).toEqual(visionBefore);
    expect(state.currentFlagId(player.playerId)).toBe("flag-death");

    // A plain teleport (the old recovery path) wipes it, which is what broke harvesting after death.
    state.teleportPlayer(player.playerId, player.anchor, player.regionCode);
    expect(state.getResourceVision(player.playerId)).toBeNull();
  });
});

function vision(flagId: string, center: { lat: number; lon: number }) {
  return {
    flagId,
    flagName: flagId,
    center,
    movementLeashRadiusM: 600,
    paddingM: 50,
    radiusM: 650
  };
}
