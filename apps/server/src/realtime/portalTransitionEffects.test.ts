import type { PlayerLocationSnapshot, PortalDefinition } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { createPortalTransitionEffects } from "./portalTransitionEffects.js";

const world: Extract<PlayerLocationSnapshot, { kind: "world" }> = {
  kind: "world",
  regionCode: "package:nm",
  zoneId: "world:package:nm",
  position: { lat: 35.1, lon: -106.6 },
  revision: 3,
  lastPortalId: "spawn"
};
const manor: Extract<PlayerLocationSnapshot, { kind: "interior" }> = {
  kind: "interior",
  locationType: "manor",
  locationId: "manor-1",
  instanceId: "manor:manor-1",
  spaceId: "manor_main_room",
  regionCode: "interior:manor:manor-1",
  zoneId: "interior:manor:manor-1:manor_main_room",
  position: { x: 790, y: 790 },
  revision: 4,
  lastPortalId: "manor:entry"
};
const sewer: Extract<PlayerLocationSnapshot, { kind: "interior" }> = {
  ...manor,
  locationType: "cistern_warrens",
  locationId: "sewer-1",
  instanceId: "sewer:sewer-1",
  spaceId: "sewer_entrance",
  regionCode: "interior:sewer:sewer-1",
  zoneId: "interior:sewer:sewer-1:sewer_entrance"
};

describe("portal transition generic effects", () => {
  it("owns world-to-Manor presence, combat, replication, and membership exactly once", async () => {
    const harness = createHarness();
    const effects = createPortalTransitionEffects(harness.context);
    const input = transitionInput(world, manor);

    await effects.prepare(input);
    await effects.apply({ ...input, destination: manor });
    await effects.release({ ...input, committed: true });

    expect(harness.beginTransition).toHaveBeenCalledOnce();
    expect(harness.beginTransition).toHaveBeenCalledWith(
      "player-1",
      "request-1",
      { withholdPlayerReplication: false }
    );
    expect(harness.stopPlayer).toHaveBeenCalledOnce();
    expect(harness.cancelCombat).toHaveBeenCalledOnce();
    expect(harness.setLocationKind).toHaveBeenCalledWith("player-1", "interior");
    expect(harness.disconnectCombat).toHaveBeenCalledOnce();
    expect(harness.removeReplication).toHaveBeenCalledOnce();
    expect(harness.updateMembership).toHaveBeenCalledWith({
      playerId: "player-1",
      regionCode: manor.regionCode,
      zoneId: manor.zoneId,
      interestZoneIds: []
    });
    await vi.waitFor(() => expect(harness.releasePopulation).toHaveBeenCalledOnce());
    expect(harness.endTransition).toHaveBeenCalledWith(
      "player-1",
      harness.transitionToken,
      "committed",
      "portal-transition-complete"
    );
  });

  it("withholds replication for world-to-world recovery", async () => {
    const harness = createHarness();
    const effects = createPortalTransitionEffects(harness.context);
    const destination = {
      ...world,
      position: { lat: 35.2, lon: -106.5 },
      revision: 5
    };

    await effects.prepare(transitionInput(world, destination));

    expect(harness.beginTransition).toHaveBeenCalledWith(
      "player-1",
      "request-1"
    );
  });

  it("releases a cancelled transition as failed", async () => {
    const harness = createHarness();
    const effects = createPortalTransitionEffects(harness.context);
    const input = transitionInput(world, manor);

    await effects.prepare(input);
    await effects.release({ ...input, committed: false });

    expect(harness.endTransition).toHaveBeenCalledWith(
      "player-1",
      harness.transitionToken,
      "failed",
      "portal-transition-cancelled"
    );
  });

  it("replaces the movement anchor when restoring Sewer-to-world state", async () => {
    const harness = createHarness();
    const destination: Extract<PlayerLocationSnapshot, { kind: "world" }> = {
      ...world,
      position: { lat: 35.1002, lon: -106.6002 },
      revision: 5,
      lastPortalId: "sewer:exit"
    };
    const effects = createPortalTransitionEffects(harness.context);
    const input = transitionInput(sewer, destination);

    await effects.prepare(input);
    await effects.apply({ ...input, destination });
    await effects.release({ ...input, committed: true });

    expect(harness.beginTransition).toHaveBeenCalledWith(
      "player-1",
      "request-1"
    );
    expect(harness.stopDungeon).toHaveBeenCalledOnce();
    expect(harness.teleportWorld).toHaveBeenCalledWith(
      "player-1",
      destination.position,
      destination.regionCode
    );
    expect(harness.setLocationKind).toHaveBeenCalledWith("player-1", "world");
    expect(harness.syncCombat).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "player-1",
      position: destination.position,
      regionCode: destination.regionCode
    }));
    expect(harness.resetReplication).toHaveBeenCalledOnce();
    expect(harness.updateMembership).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "player-1",
      regionCode: destination.regionCode,
      interestZoneIds: []
    }));
    expect(harness.endTransition).toHaveBeenCalledWith(
      "player-1",
      harness.transitionToken,
      "committed",
      "portal-transition-complete"
    );
  });

  it("rebuilds authoritative world-object presentation after death recovery", async () => {
    const harness = createHarness();
    const player = {
      playerId: "player-1",
      anchor: { lat: 35.2, lon: -106.5 },
      position: { lat: 35.2, lon: -106.5 }
    };
    harness.context.gameState.getPlayer = vi.fn(() => player as never);
    const destination = {
      ...world,
      position: player.anchor,
      revision: world.revision + 1
    };
    const baseInput = transitionInput(world, destination);
    const input = {
      ...baseInput,
      requestId: "player-death:one",
      portal: { ...baseInput.portal, portalId: "recovery:death-anchor" }
    };
    const effects = createPortalTransitionEffects(harness.context);

    await effects.prepare(input);
    await effects.apply({ ...input, destination });
    await effects.complete?.({ ...input, destination });
    await effects.release({ ...input, committed: true });

    // The anchor stays put, so the Resource Vision must be kept (no plain teleport, which clears it).
    expect(harness.restoreWorld).toHaveBeenCalledWith(
      "player-1",
      player.anchor,
      destination.regionCode
    );
    expect(harness.teleportWorld).not.toHaveBeenCalled();
    expect(harness.schedulePopulation).toHaveBeenCalledWith(
      "player-1",
      "explicit-relocation"
    );
    expect(harness.sendWorldBootstrap).toHaveBeenCalledWith(
      player,
      "death-respawn",
      false
    );
  });
});

function transitionInput(
  source: PlayerLocationSnapshot,
  destination: PlayerLocationSnapshot
) {
  const portal: PortalDefinition = {
    portalId: "portal-1",
    source: source.kind === "world"
      ? { kind: "world", regionCode: source.regionCode, position: source.position }
      : {
          kind: "interior",
          locationType: source.locationType,
          locationId: source.locationId,
          instanceId: source.instanceId,
          spaceId: source.spaceId,
          position: source.position
        },
    destination: destination.kind === "world"
      ? { kind: "world", regionCode: destination.regionCode, position: destination.position }
      : {
          kind: "interior",
          locationType: destination.locationType,
          locationId: destination.locationId,
          instanceId: destination.instanceId,
          spaceId: destination.spaceId,
          position: destination.position
        },
    sourceApproach: source.position,
    sourceThreshold: source.position,
    destinationArrival: destination.position,
    interactionLabel: "Use",
    transitionPresentation: "door",
    enabled: true,
    revision: "1"
  };
  return {
    playerId: "player-1",
    requestId: "request-1",
    transitionId: "transition-1",
    portal,
    source
  };
}

function createHarness() {
  const transitionToken = Symbol("portal");
  const beginTransition = vi.fn(() => transitionToken);
  const endTransition = vi.fn();
  const stopPlayer = vi.fn();
  const stopDungeon = vi.fn();
  const cancelCombat = vi.fn();
  const disconnectCombat = vi.fn();
  const syncCombat = vi.fn();
  const setLocationKind = vi.fn();
  const teleportWorld = vi.fn((_playerId, position, regionCode) => ({
    playerId: "player-1",
    username: "Player",
    position,
    anchor: position,
    regionCode
  }));
  const restoreWorld = vi.fn((_playerId, position, regionCode) => ({
    playerId: "player-1",
    username: "Player",
    position,
    anchor: position,
    regionCode
  }));
  const removeReplication = vi.fn();
  const resetReplication = vi.fn();
  const updateMembership = vi.fn();
  const releasePopulation = vi.fn();
  const schedulePopulation = vi.fn(() => null);
  const waitForRelocation = vi.fn();
  const sendWorldBootstrap = vi.fn();
  const context = {
    logger: { warn: vi.fn() },
    authenticatedSession: null,
    registry: {
      isActivePlayerConnection: vi.fn(() => true),
      updateSpatialMembership: updateMembership
    },
    gameState: {
      stopPlayer,
      setPlayerLocationKind: setLocationKind,
      teleportPlayer: teleportWorld,
      restoreWorldPosition: restoreWorld,
      getPlayer: vi.fn(() => null)
    },
    worldRuntime: {
      beginPlayerWorldTransition: beginTransition,
      endPlayerWorldTransition: endTransition,
      replication: { removePlayer: removeReplication, resetPlayer: resetReplication }
    },
    manorRuntime: { stop: vi.fn() },
    salonRuntime: { stop: vi.fn() },
    dungeon: { stop: stopDungeon },
    combat: {
      cancelCombat,
      disconnectPlayer: disconnectCombat,
      syncPlayer: syncCombat
    },
    flagBuilds: null,
    populationV2: { releaseConnection: releasePopulation },
    connectionGenerations: { current: vi.fn(() => 1) },
    connectionId: vi.fn(() => "connection-1"),
    refreshAuthoritativePlayerStats: vi.fn(),
    reservePopulationV2CurrentArea: vi.fn(() => null),
    schedulePopulationV2RelocationForActivePlayer: schedulePopulation,
    waitForRelocationPopulationV2: waitForRelocation,
    sendWorldBootstrapForPlayer: sendWorldBootstrap
  } as unknown as Parameters<typeof createPortalTransitionEffects>[0];
  return {
    context,
    transitionToken,
    beginTransition,
    endTransition,
    stopPlayer,
    stopDungeon,
    cancelCombat,
    disconnectCombat,
    syncCombat,
    setLocationKind,
    teleportWorld,
    restoreWorld,
    removeReplication,
    resetReplication,
    updateMembership,
    releasePopulation,
    schedulePopulation,
    waitForRelocation,
    sendWorldBootstrap
  };
}
