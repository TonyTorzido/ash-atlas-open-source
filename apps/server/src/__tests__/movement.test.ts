import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../config.js";
import { GameState } from "../game/state.js";
import { distanceMeters, moveToward } from "../game/movement.js";

const DEFAULT_DEV_PLAYER_SPEED_MPS = 125;
const TEST_PLAYER_SPEED_MPS = 125;
const DEV_MOVE_LEASH_RADIUS_M = 600;

describe("movement", () => {
  it("keeps Flags development tuning aligned across config, launcher, and documentation", () => {
    const config = loadConfig({});
    const launcher = readFileSync(new URL("../../../../tools/dev/run-main.ps1", import.meta.url), "utf8");
    const envExample = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");

    expect(config.PLAYER_SPEED_MPS).toBe(DEFAULT_DEV_PLAYER_SPEED_MPS);
    expect(config.SERVER_TICK_HZ).toBe(20);
    expect(config.WORLD_DELTA_HZ).toBe(20);
    expect(config.MOVE_LEASH_RADIUS_M).toBeCloseTo(DEV_MOVE_LEASH_RADIUS_M, 3);
    expect(envExample).toMatch(/^PLAYER_SPEED_MPS=125$/m);
    expect(envExample).toMatch(/^SERVER_TICK_HZ=20$/m);
    expect(envExample).toMatch(/^WORLD_DELTA_HZ=20$/m);
    expect(readme).toMatch(/^PLAYER_SPEED_MPS=125$/m);
    expect(readme).toMatch(/^WORLD_DELTA_HZ=20$/m);
    for (const assignment of [
      "$PlayerSpeedMps = 125",
      "$ServerTickHz = 20",
      "$WorldDeltaHz = 20",
      '$env:PLAYER_SPEED_MPS = "$PlayerSpeedMps"',
      '$env:SERVER_TICK_HZ = "$ServerTickHz"',
      '$env:WORLD_DELTA_HZ = "$WorldDeltaHz"',
      "${childDollar}env:PLAYER_SPEED_MPS = '$PlayerSpeedMps'",
      "${childDollar}env:SERVER_TICK_HZ = '$ServerTickHz'",
      "${childDollar}env:WORLD_DELTA_HZ = '$WorldDeltaHz'"
    ]) {
      expect(launcher).toContain(assignment);
    }
  });

  it("computes plausible meter distance between nearby Albuquerque points", () => {
    const distance = distanceMeters(
      { lat: 35.0844, lon: -106.6504 },
      { lat: 35.0854, lon: -106.6504 }
    );
    expect(distance).toBeGreaterThan(100);
    expect(distance).toBeLessThan(120);
  });

  it("moves toward the target without overshooting", () => {
    const current = { lat: 35.0844, lon: -106.6504 };
    const target = { lat: 35.0854, lon: -106.6504 };
    const next = moveToward(current, target, 10);

    expect(distanceMeters(current, next)).toBeCloseTo(10, 1);
    expect(distanceMeters(next, target)).toBeLessThan(distanceMeters(current, target));
  });

  it("travels half the former distance over the same authoritative tick", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const start = { ...player.position };
    gameState.setTarget(player.playerId, pointEastMeters(player.anchor, 500));

    gameState.tick(1);

    expect(distanceMeters(start, player.position)).toBeCloseTo(125, 1);
    expect(distanceMeters(start, player.position)).toBeCloseTo(250 / 2, 1);
  });

  it("snaps to the target when the step is large enough", () => {
    const target = { lat: 35.0854, lon: -106.6504 };
    const next = moveToward({ lat: 35.0844, lon: -106.6504 }, target, 1_000);
    expect(next).toEqual(target);
  });

  it("accepts movement targets inside the active leash", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const target = pointEastMeters(player.anchor, 599);

    gameState.setTarget(player.playerId, target);

    expect(distanceMeters(player.anchor, target)).toBeLessThan(DEV_MOVE_LEASH_RADIUS_M);
    expect(gameState.snapshotForPlayer(player.playerId)).toMatchObject({
      targetLat: target.lat,
      targetLon: target.lon,
      anchorLat: player.anchor.lat,
      anchorLon: player.anchor.lon,
      moveLeashRadiusM: DEV_MOVE_LEASH_RADIUS_M,
      movementRevision: 1
    });
  });

  it("deduplicates the same destination and advances authority for a newer destination", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const firstTarget = pointEastMeters(player.anchor, 400);
    const secondTarget = pointEastMeters(player.anchor, 590);

    gameState.setTarget(player.playerId, firstTarget);
    expect(gameState.snapshotForPlayer(player.playerId).movementRevision).toBe(1);
    gameState.setTarget(player.playerId, firstTarget);
    expect(gameState.snapshotForPlayer(player.playerId)).toMatchObject({
      movementRevision: 1,
      targetLat: firstTarget.lat,
      targetLon: firstTarget.lon
    });

    gameState.setTarget(player.playerId, secondTarget);
    expect(gameState.snapshotForPlayer(player.playerId)).toMatchObject({
      movementRevision: 2,
      targetLat: secondTarget.lat,
      targetLon: secondTarget.lon
    });
  });

  it("rejects movement targets outside the active leash", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const target = pointEastMeters(player.anchor, 601);

    expect(distanceMeters(player.anchor, target)).toBeGreaterThan(DEV_MOVE_LEASH_RADIUS_M);
    expect(() => gameState.setTarget(player.playerId, target)).toThrow(/movement leash/);
    expect(gameState.snapshotForPlayer(player.playerId).targetLat).toBeNull();
  });

  it("preserves active movement and revision when a new target is rejected outside the leash", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const validTarget = pointEastMeters(player.anchor, 500);
    const invalidTarget = pointEastMeters(player.anchor, 601);

    gameState.setTarget(player.playerId, validTarget);
    const before = gameState.snapshotForPlayer(player.playerId);
    expect(() => gameState.setTarget(player.playerId, invalidTarget)).toThrow(/movement leash/);

    expect(gameState.snapshotForPlayer(player.playerId)).toMatchObject({
      lat: before.lat,
      lon: before.lon,
      movementRevision: before.movementRevision,
      targetLat: validTarget.lat,
      targetLon: validTarget.lon,
      moving: true
    });
  });

  it("leaves a corrupted position untouched during invalid command rejection", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const corruptedPosition = pointEastMeters(player.anchor, 601);
    const invalidTarget = pointEastMeters(player.anchor, 700);
    player.position = corruptedPosition;
    const revision = player.movementRevision;

    expect(() => gameState.setTarget(player.playerId, invalidTarget)).toThrow(/movement leash/);

    expect(player.position).toEqual(corruptedPosition);
    expect(player.target).toBeNull();
    expect(player.movementRevision).toBe(revision);

    const corrected = gameState.snapshotForPlayer(player.playerId);
    expect(distanceMeters(
      { lat: corrected.anchorLat, lon: corrected.anchorLon },
      { lat: corrected.lat, lon: corrected.lon }
    )).toBeLessThanOrEqual(DEV_MOVE_LEASH_RADIUS_M + 0.1);
    expect(corrected.movementRevision).toBe(revision + 1);
  });

  it("prevents server ticks and snapshots from exposing a player outside the leash", () => {
    const gameState = new GameState(createConfig({ PLAYER_SPEED_MPS: 100 }));
    const player = gameState.helloPlayer("player-1", "Ash");
    gameState.setTarget(player.playerId, pointEastMeters(player.anchor, 599));
    player.position = pointEastMeters(player.anchor, 601);

    gameState.tick(1);
    const snapshot = gameState.snapshotForPlayer(player.playerId);
    const distanceFromAnchor = distanceMeters(
      { lat: snapshot.anchorLat, lon: snapshot.anchorLon },
      { lat: snapshot.lat, lon: snapshot.lon }
    );

    expect(distanceFromAnchor).toBeLessThanOrEqual(DEV_MOVE_LEASH_RADIUS_M + 0.1);
    expect(snapshot.targetLat).toBeNull();
    expect(snapshot.targetLon).toBeNull();
    expect(snapshot.moving).toBe(false);
  });

  it("visiting a flag updates player position and movement anchor", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const flagPosition = { lat: 35.0845, lon: -106.6501 };

    gameState.visitFlag(player.playerId, flagPosition);

    expect(gameState.snapshotForPlayer(player.playerId)).toMatchObject({
      lat: flagPosition.lat,
      lon: flagPosition.lon,
      anchorLat: flagPosition.lat,
      anchorLon: flagPosition.lon,
      moveLeashRadiusM: DEV_MOVE_LEASH_RADIUS_M,
      movementRevision: 1,
      targetLat: null,
      targetLon: null
    });
  });

  it("keeps an arbitrary teleport coordinate as the exact gameplay anchor", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const destination = { lat: 35.1234567, lon: -106.7654321 };

    gameState.teleportPlayer(player.playerId, destination);

    expect(gameState.snapshotForPlayer(player.playerId)).toMatchObject({
      lat: destination.lat,
      lon: destination.lon,
      anchorLat: destination.lat,
      anchorLon: destination.lon
    });
    expect(gameState.getGameplayViewCircle(player.playerId)?.center).toEqual(destination);
  });

  it("blocks movement while defeated and restores it at the authoritative anchor", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    gameState.setMovementBlocked(player.playerId, true);
    expect(() => gameState.setTarget(player.playerId, pointEastMeters(player.anchor, 10))).toThrow(
      /defeated/
    );
    expect(gameState.respawnPlayerAtAnchor(player.playerId)).toEqual(player.anchor);
    expect(() => gameState.setTarget(player.playerId, pointEastMeters(player.anchor, 10))).not.toThrow();
  });

  it("does not clear a construction movement lock when another reason resolves", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    gameState.setMovementBlocked(player.playerId, true, "city-construction");
    gameState.setMovementBlocked(player.playerId, true);
    gameState.respawnPlayerAtAnchor(player.playerId);

    expect(gameState.isMovementBlocked(
      player.playerId,
      "city-construction"
    )).toBe(true);
    expect(() =>
      gameState.setTarget(player.playerId, pointEastMeters(player.anchor, 10))
    ).toThrow();

    gameState.setMovementBlocked(player.playerId, false, "city-construction");
    expect(() =>
      gameState.setTarget(player.playerId, pointEastMeters(player.anchor, 10))
    ).not.toThrow();
  });

  it("keeps resource vision anchored while the player walks", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const flagPosition = { lat: 35.0845, lon: -106.6501 };
    const resourceVision = {
      flagId: "11111111-1111-4111-8111-111111111111",
      flagName: "Mesa Camp",
      center: flagPosition,
      movementLeashRadiusM: player.moveLeashRadiusM,
      paddingM: 50,
      radiusM: player.moveLeashRadiusM + 50
    };

    gameState.visitFlag(player.playerId, flagPosition);
    gameState.setResourceVision(player.playerId, resourceVision);
    gameState.setTarget(player.playerId, pointEastMeters(flagPosition, 120));
    gameState.tick(0.1);

    expect(gameState.getResourceVision(player.playerId)).toEqual(resourceVision);
  });

  it("applies and restores flag position, anchor, vision, and generation coherently", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const before = gameState.capturePlayerViewTransition(player.playerId);
    const center = pointEastMeters(player.anchor, 500);
    const spawnPosition = pointEastMeters(center, 50);
    const vision = {
      flagId: "11111111-1111-4111-8111-111111111111",
      flagName: "Mesa Camp",
      center,
      movementLeashRadiusM: player.moveLeashRadiusM,
      paddingM: 50,
      radiusM: player.moveLeashRadiusM + 50
    };

    gameState.applyValidatedFlagVisit(player.playerId, vision, spawnPosition);
    expect(gameState.snapshotForPlayer(player.playerId)).toMatchObject({
      lat: spawnPosition.lat,
      lon: spawnPosition.lon,
      anchorLat: center.lat,
      anchorLon: center.lon,
      relocationRevision: before.relocationRevision + 1
    });
    expect(distanceMeters(center, spawnPosition)).toBeCloseTo(50, 1);
    expect(gameState.getResourceVision(player.playerId)).toEqual(vision);
    expect(gameState.getGameplayViewCircle(player.playerId)).toMatchObject({
      anchorType: "flag",
      center,
      radiusM: vision.radiusM,
      generation: before.viewGeneration + 1
    });
    expect(gameState.getResourceVisionRevision(player.playerId)).toBe(
      before.resourceVisionRevision + 1
    );

    gameState.restorePlayerViewTransition(player.playerId, before);
    expect(gameState.capturePlayerViewTransition(player.playerId)).toEqual(before);
  });

  it("keeps the anchor, vision, and view revisions fixed while walking across a package boundary", () => {
    const gameState = new GameState(createConfig({ PLAYER_SPEED_MPS: 1_000 }));
    const player = gameState.helloPlayer("player-1", "Ash");
    const center = { lat: 35.1, lon: -106.0005 };
    const vision = {
      flagId: "11111111-1111-4111-8111-111111111111",
      flagName: "Boundary Camp",
      center,
      movementLeashRadiusM: player.moveLeashRadiusM,
      paddingM: 50,
      radiusM: 650
    };
    gameState.applyValidatedFlagVisit(player.playerId, vision);
    const before = gameState.capturePlayerViewTransition(player.playerId);
    const target = pointEastMeters(center, 550);

    gameState.setTarget(player.playerId, target);
    gameState.tick(1);

    const after = gameState.capturePlayerViewTransition(player.playerId);
    expect(after.position).toEqual(target);
    expect(after.regionCode).not.toBe(before.regionCode);
    expect(after.anchor).toEqual(center);
    expect(after.resourceVision?.center).toEqual(center);
    expect(after.relocationRevision).toBe(before.relocationRevision);
    expect(after.viewGeneration).toBe(before.viewGeneration);
    expect(after.resourceVisionRevision).toBe(before.resourceVisionRevision);
  });

  it("repairs a persisted resource-vision center from the persisted anchor", () => {
    const warn = vi.fn();
    const gameState = new GameState(createConfig(), { warn });
    const anchor = { lat: 35.1, lon: -106.7 };
    const staleCenter = pointEastMeters(anchor, 200);

    gameState.connectPlayer({
      playerId: "player-1",
      username: "Ash",
      displayColor: "#38bdf8",
      regionCode: "stale",
      position: pointEastMeters(anchor, 100),
      anchor,
      moveLeashRadiusM: DEV_MOVE_LEASH_RADIUS_M,
      movementRevision: 7,
      relocationRevision: 3,
      target: null,
      online: false,
      updatedAt: new Date("2026-07-08T09:00:00.000Z"),
      resourceVision: {
        flagId: "11111111-1111-4111-8111-111111111111",
        flagName: "Mesa Camp",
        center: staleCenter,
        movementLeashRadiusM: DEV_MOVE_LEASH_RADIUS_M,
        paddingM: 50,
        radiusM: 650
      }
    });

    expect(gameState.getResourceVision("player-1")?.center).toEqual(anchor);
    expect(gameState.getGameplayViewCircle("player-1")?.center).toEqual(anchor);
    expect(gameState.getResourceVisionRevision("player-1")).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: "player-1",
        persistedAnchor: anchor,
        persistedResourceVisionCenter: staleCenter
      }),
      "resource vision center repaired to the persisted player anchor"
    );
    expect(gameState.consumeDirtyPlayerIds()).toContain("player-1");
  });

  it("rejects a mismatched attached vision without mutating the active view", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const before = gameState.capturePlayerViewTransition(player.playerId);
    const mismatchedCenter = pointEastMeters(player.anchor, 100);

    expect(() => gameState.setResourceVision(player.playerId, {
      flagId: "11111111-1111-4111-8111-111111111111",
      flagName: "Wrong Center",
      center: mismatchedCenter,
      movementLeashRadiusM: player.moveLeashRadiusM,
      paddingM: 50,
      radiusM: 650
    })).toThrow(/must equal the authoritative player anchor/);
    expect(gameState.capturePlayerViewTransition(player.playerId)).toEqual(before);
  });

  it("preserves anchor-centered vision and relocation authority on respawn", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const center = pointEastMeters(player.anchor, 500);
    const spawn = pointEastMeters(center, 200);
    const vision = {
      flagId: "11111111-1111-4111-8111-111111111111",
      flagName: "Mesa Camp",
      center,
      movementLeashRadiusM: player.moveLeashRadiusM,
      paddingM: 50,
      radiusM: 650
    };
    gameState.applyValidatedFlagVisit(player.playerId, vision, spawn);
    const before = gameState.capturePlayerViewTransition(player.playerId);

    expect(gameState.respawnPlayerAtAnchor(player.playerId)).toEqual(center);

    const after = gameState.capturePlayerViewTransition(player.playerId);
    expect(after.position).toEqual(center);
    expect(after.anchor).toEqual(center);
    expect(after.resourceVision).toEqual(vision);
    expect(after.movementRevision).toBe(before.movementRevision + 1);
    expect(after.relocationRevision).toBe(before.relocationRevision);
    expect(after.viewGeneration).toBe(before.viewGeneration);
    expect(after.resourceVisionRevision).toBe(before.resourceVisionRevision);
  });

  it("increments relocation revision only for discontinuous movement", () => {
    const gameState = new GameState(createConfig());
    const player = gameState.helloPlayer("player-1", "Ash");
    const initial = gameState.snapshotForPlayer(player.playerId).relocationRevision;

    gameState.setTarget(player.playerId, pointEastMeters(player.anchor, 10));
    gameState.tick(0.01);
    expect(gameState.snapshotForPlayer(player.playerId).relocationRevision).toBe(initial);

    gameState.teleportPlayer(player.playerId, pointEastMeters(player.anchor, 100));
    expect(gameState.snapshotForPlayer(player.playerId).relocationRevision).toBe((initial ?? 0) + 1);
    gameState.respawnPlayerAtAnchor(player.playerId);
    expect(gameState.snapshotForPlayer(player.playerId).relocationRevision).toBe((initial ?? 0) + 1);
  });

  it("hydrates a persisted player and snapshots multiple online players", () => {
    const gameState = new GameState(createConfig());

    gameState.connectPlayer({
      playerId: "player-1",
      username: "Ash",
      displayColor: "#38bdf8",
      regionCode: "NM",
      position: { lat: 35.1, lon: -106.7 },
      anchor: { lat: 35.1, lon: -106.7 },
      moveLeashRadiusM: DEV_MOVE_LEASH_RADIUS_M,
      movementRevision: 0,
      target: null,
      online: true,
      updatedAt: new Date("2026-07-08T09:00:00.000Z")
    });
    gameState.helloPlayer("player-2", "Bex");

    expect(gameState.snapshots()).toMatchObject([
      {
        playerId: "player-1",
        lat: 35.1,
        lon: -106.7,
        online: true,
        zoneId: "world:world_v1_lat35_lon-107"
      },
      {
        playerId: "player-2",
        online: true
      }
    ]);
  });
});

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      NODE_ENV: "test",
      PLAYER_SPEED_MPS: String(TEST_PLAYER_SPEED_MPS),
      MOVE_LEASH_RADIUS_M: String(DEV_MOVE_LEASH_RADIUS_M)
    }),
    ...overrides
  };
}

function pointEastMeters(origin: { lat: number; lon: number }, distanceM: number): {
  lat: number;
  lon: number;
} {
  return moveToward(origin, { lat: origin.lat, lon: origin.lon + 0.02 }, distanceM);
}
