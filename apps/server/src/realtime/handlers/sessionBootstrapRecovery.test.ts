import type { PlayerLocationSnapshot } from "@ash-atlas/shared";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { CisternWarrensRuntime } from "../../game/dungeon.js";
import type { ManorPresenceService, ManorRuntime } from "../../game/manor.js";
import type { SalonRuntime, SalonService } from "../../game/salon.js";
import {
  isCurrentPostWelcomeConnection,
  publishStartupPresentationCombatSnapshot,
  reconcileCanonicalInteriorProjections
} from "./sessionBootstrap.js";

describe("post-WELCOME progression authority", () => {
  it("accepts only the active connection with the captured current generation", () => {
    const registry = {
      isActivePlayerConnection: vi.fn(() => true)
    };
    const connectionGenerations = {
      isCurrent: vi.fn(() => true)
    };
    const input = {
      registry,
      connectionGenerations,
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 7
    };

    expect(isCurrentPostWelcomeConnection(input)).toBe(true);
    registry.isActivePlayerConnection.mockReturnValue(false);
    expect(isCurrentPostWelcomeConnection(input)).toBe(false);
    registry.isActivePlayerConnection.mockReturnValue(true);
    connectionGenerations.isCurrent.mockReturnValue(false);
    expect(isCurrentPostWelcomeConnection(input)).toBe(false);
  });
});

const world: PlayerLocationSnapshot = {
  kind: "world",
  regionCode: "package:nm",
  zoneId: "world:package:nm",
  position: { lat: 35.1, lon: -106.6 },
  revision: 8,
  lastPortalId: "manor:exit"
};

describe("canonical interior projection recovery", () => {
  it("removes stale Manor, Salon, and Sewer projections when durable location is world", async () => {
    const manorExit = vi.fn(async () => undefined);
    const manorRuntimeExit = vi.fn();
    const salonExit = vi.fn(async () => undefined);
    const salonRuntimeRemove = vi.fn();
    const sewerDiscard = vi.fn(async () => undefined);

    const result = await reconcileCanonicalInteriorProjections({
      playerId: "player-1",
      canonicalLocation: world,
      manorPresence: {
        load: vi.fn(async () => ({ playerId: "player-1", manorId: "manor-1" })),
        exit: manorExit
      } as unknown as ManorPresenceService,
      manorRuntime: {
        get: vi.fn(() => ({ sessionId: "manor-session" })),
        exit: manorRuntimeExit
      } as unknown as ManorRuntime,
      salon: {
        loadPresence: vi.fn(async () => ({
          playerId: "player-1",
          structureId: "salon-1",
          sessionId: "salon-session"
        })),
        exit: salonExit
      } as unknown as SalonService,
      salonRuntime: { remove: salonRuntimeRemove } as unknown as SalonRuntime,
      dungeon: {
        durableSewerId: vi.fn(async () => "sewer-1"),
        discardStalePresence: sewerDiscard
      } as unknown as CisternWarrensRuntime
    });

    expect(result).toEqual({ manorPresence: null, salonPresence: null });
    expect(manorExit).toHaveBeenCalledWith("player-1");
    expect(manorRuntimeExit).toHaveBeenCalledWith("player-1", "manor-session");
    expect(salonExit).toHaveBeenCalledWith("player-1", "salon-session");
    expect(salonRuntimeRemove).toHaveBeenCalledWith("player-1");
    expect(sewerDiscard).toHaveBeenCalledWith("player-1");
  });

  it("retains only the feature projection matching canonical interior location", async () => {
    const canonicalManor: PlayerLocationSnapshot = {
      kind: "interior",
      locationType: "manor",
      locationId: "manor-1",
      instanceId: "manor:manor-1",
      spaceId: "manor_main_room",
      regionCode: "interior:manor:manor-1",
      zoneId: "interior:manor:manor-1:manor_main_room",
      position: { x: 790, y: 790 },
      revision: 8,
      lastPortalId: "manor:entry"
    };
    const manor = { playerId: "player-1", manorId: "manor-1" };
    const manorExit = vi.fn();
    const salonExit = vi.fn(async () => undefined);
    const sewerDiscard = vi.fn(async () => undefined);

    const result = await reconcileCanonicalInteriorProjections({
      playerId: "player-1",
      canonicalLocation: canonicalManor,
      manorPresence: {
        load: vi.fn(async () => manor),
        exit: manorExit
      } as unknown as ManorPresenceService,
      salon: {
        loadPresence: vi.fn(async () => ({ sessionId: "salon-session" })),
        exit: salonExit
      } as unknown as SalonService,
      dungeon: {
        durableSewerId: vi.fn(async () => "sewer-1"),
        discardStalePresence: sewerDiscard
      } as unknown as CisternWarrensRuntime
    });

    expect(result.manorPresence).toBe(manor);
    expect(result.salonPresence).toBeNull();
    expect(manorExit).not.toHaveBeenCalled();
    expect(salonExit).toHaveBeenCalledWith("player-1", "salon-session");
    expect(sewerDiscard).toHaveBeenCalledWith("player-1");
  });

  it("retains an authored dungeon projection for a canonical dungeon reconnect", async () => {
    const discard = vi.fn(async () => undefined);
    await reconcileCanonicalInteriorProjections({
      playerId: "player-1",
      canonicalLocation: {
        kind: "interior", locationType: "dungeon", locationId: "cave-a",
        instanceId: "dungeon:cave-a:player:player-1", spaceId: "entry",
        regionCode: "interior:dungeon:cave-a:player:player-1",
        zoneId: "interior:dungeon:cave-a:player:player-1:entry",
        position: { x: 10, y: 20 }, revision: 4, lastPortalId: "entry"
      },
      dungeon: {
        durableSewerId: vi.fn(async () => "cave-a"),
        discardStalePresence: discard
      } as unknown as CisternWarrensRuntime
    });
    expect(discard).not.toHaveBeenCalled();
  });
});

describe("startup presentation combat convergence", () => {
  it("publishes the reveal checkpoint after bootstrap HUD snapshots", () => {
    const source = readFileSync(new URL("./sessionBootstrap.ts", import.meta.url), "utf8");
    const classSnapshotIndex = source.indexOf('type: "CLASS_SNAPSHOT"');
    const revealCheckpointIndex = source.indexOf(
      "publishStartupPresentationCombatSnapshot({",
      classSnapshotIndex
    );
    const petStateIndex = source.indexOf('type: "PET_STATE"', revealCheckpointIndex);
    const presentationCompleteIndex = source.indexOf(
      'type: "PRESENTATION_SNAPSHOT_COMPLETE"',
      petStateIndex
    );

    expect(classSnapshotIndex).toBeGreaterThanOrEqual(0);
    expect(revealCheckpointIndex).toBeGreaterThan(classSnapshotIndex);
    expect(petStateIndex).toBeGreaterThan(revealCheckpointIndex);
    expect(presentationCompleteIndex).toBeGreaterThan(petStateIndex);
  });

  it("publishes no eligible combat snapshot until exact visible population is ready", async () => {
    let resolvePresentation!: (value: {
      status: "ready";
      pendingVisibleZoneCount: number;
    }) => void;
    const presentationReady = new Promise<{
      status: "ready";
      pendingVisibleZoneCount: number;
    }>((resolve) => {
      resolvePresentation = resolve;
    });
    const sendCombatScopeSnapshot = vi.fn(() => ({
      worldViewAuthority: null,
      combatSnapshotGeneration: 7,
      combatEntityCount: 4,
      mobEntityCount: 3,
      expectedMobActorCount: 3
    }));
    const publication = publishStartupPresentationCombatSnapshot({
      relocation: relocation({
        visibleReady: Promise.resolve({
          status: "ready",
          pendingVisibleZoneCount: 1
        }),
        presentationReady
      }),
      sendCombatScopeSnapshot
    });

    await Promise.resolve();
    expect(sendCombatScopeSnapshot).not.toHaveBeenCalled();

    resolvePresentation({ status: "ready", pendingVisibleZoneCount: 0 });
    await expect(publication).resolves.toMatchObject({
      combatSnapshotGeneration: 7,
      mobEntityCount: 3
    });
    expect(sendCombatScopeSnapshot).toHaveBeenCalledOnce();
    expect(sendCombatScopeSnapshot).toHaveBeenCalledWith(
      "player-1",
      {
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 2,
        relocationRevision: 3,
        resourceVisionRevision: 4,
        gameplayViewGeneration: 5,
        populationPreparationGeneration: 6
      }
    );
  });

  it("does not publish when visible population becomes stale", async () => {
    const sendCombatScopeSnapshot = vi.fn();
    await expect(publishStartupPresentationCombatSnapshot({
      relocation: relocation({
        visibleReady: Promise.resolve({
          status: "ready" as const,
          pendingVisibleZoneCount: 1
        }),
        presentationReady: Promise.resolve({
          status: "stale" as const,
          pendingVisibleZoneCount: 1
        })
      }),
      sendCombatScopeSnapshot
    })).resolves.toBeNull();
    expect(sendCombatScopeSnapshot).not.toHaveBeenCalled();
  });

  it("publishes the fenced baseline when unresolved zones are explicitly degraded", async () => {
    const sendCombatScopeSnapshot = vi.fn(() => ({
      worldViewAuthority: null,
      combatSnapshotGeneration: 8,
      combatEntityCount: 2,
      mobEntityCount: 1,
      expectedMobActorCount: 1
    }));
    await expect(publishStartupPresentationCombatSnapshot({
      relocation: relocation({
        visibleReady: Promise.resolve({
          status: "degraded" as const,
          pendingVisibleZoneCount: 2
        }),
        presentationReady: Promise.resolve({
          status: "degraded" as const,
          pendingVisibleZoneCount: 2
        })
      }),
      sendCombatScopeSnapshot
    })).resolves.toMatchObject({ combatSnapshotGeneration: 8 });
    expect(sendCombatScopeSnapshot).toHaveBeenCalledOnce();
  });
});

function relocation(overrides: Readonly<{
  visibleReady: Promise<Readonly<{
    status: "ready" | "degraded" | "stale" | "closed" | "failed";
    pendingVisibleZoneCount: number;
  }>>;
  presentationReady: Promise<Readonly<{
    status: "ready" | "degraded" | "stale" | "closed" | "failed";
    pendingVisibleZoneCount: number;
  }>>;
}>) {
  return {
    playerId: "player-1",
    connectionId: "connection-1",
    connectionGeneration: 2,
    relocationRevision: 3,
    resourceVisionRevision: 4,
    gameplayViewGeneration: 5,
    preparationGeneration: 6,
    area: {
      center: { lat: 35, lon: -106 },
      certifiedVisibleRadiusM: 650,
      preparedRadiusM: 750,
      sourceType: "player_anchor" as const,
      sourceId: "player-1",
      generation: 5
    },
    trigger: "world-entry" as const,
    startedAtMs: 0,
    visibleReady: overrides.visibleReady,
    presentationReady: overrides.presentationReady,
    completion: Promise.resolve(),
    pendingVisibleZoneCount: () => 0,
    isCurrent: () => true
  };
}
