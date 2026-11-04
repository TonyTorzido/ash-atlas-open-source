import type { ServerMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { CollectibleService } from "../game/collectibles.js";
import type { FlagService, PreparedFlagPlacement } from "../game/flags.js";
import { PlayerAuthorityFence } from "../game/playerAuthorityFence.js";
import { GameState } from "../game/state.js";
import type { AppLogger } from "../logger.js";
import { ConnectionGenerationLedger } from "./connectionLifecycle.js";
import { ConnectionRegistry } from "./connectionRegistry.js";
import { createFlagRealtimeOperations } from "./flagRealtimeOperations.js";

describe("flag realtime construction payloads", () => {
  it("replays the same named ten-second start for duplicate requests and reconnects", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const gameState = new GameState(config);
    const player = gameState.helloPlayer("flag-builder", "Flag Builder");
    const sent: ServerMessage[] = [];
    const registry = new ConnectionRegistry();
    const connectionGenerations = new ConnectionGenerationLedger();
    connectionGenerations.allocate(player.playerId);
    registry.add({
      playerId: player.playerId,
      username: player.username,
      regionCode: player.regionCode,
      zoneId: "test-zone",
      socket: {
        readyState: 1,
        bufferedAmount: 0,
        send: (payload) => sent.push(JSON.parse(payload) as ServerMessage),
        close: vi.fn()
      }
    });
    const preparedFlag: PreparedFlagPlacement = {
      flagId: "11111111-1111-4111-8111-111111111111",
      anchorKind: "flag",
      ownerId: player.playerId,
      ownerUsername: player.username,
      name: "Northwatch",
      lat: player.position.lat,
      lon: player.position.lon,
      regionCode: player.regionCode,
      movementLeashRadiusM: player.moveLeashRadiusM,
      movementRevision: player.movementRevision,
      relocationRevision: player.relocationRevision ?? 0,
      builderRank: 8,
      buildDurationMs: 10_000,
      materialAffordable: true,
      world: {
        ok: true,
        packageId: player.regionCode,
        elevationM: 1,
        terrainClass: "flat",
        biome: "plain",
        ecoregion: "plain",
        isLand: true,
        isSaltwater: false,
        raw: {}
      },
      admissionTimings: {
        defaultNameMs: 0,
        territoryAdmissionMs: 0,
        worldLookupMs: 0,
        builderRankMs: 0,
        affordabilityMs: 0,
        totalMs: 0,
        quoteState: "hit"
      }
    };
    const flagService = {
      prepareForPlayer: vi.fn(async () => preparedFlag),
      notePostBuildQuoteSuppressed: vi.fn()
    } as unknown as FlagService;
    const collectibles = {
      prepareResourceVision: vi.fn(async () => ({})),
      inventoryForPlayer: vi.fn()
    } as unknown as CollectibleService;
    const operations = createFlagRealtimeOperations({
      config,
      logger: {
        info: vi.fn(),
        warn: vi.fn()
      } as unknown as AppLogger,
      registry,
      gameState,
      playerService: { persistPlayerSnapshot: vi.fn(async () => undefined) },
      connectionGenerations,
      flagService,
      collectibles,
      playerAuthorityFence: new PlayerAuthorityFence(),
      sendToGameplayCirclesContaining: vi.fn(),
      schedulePopulationV2RelocationForActivePlayer: vi.fn(() => null),
      syncCombatPlayerAfterRelocation: vi.fn(),
      sendCombatScopeSnapshot: vi.fn(),
      sendCollectiblesForPlayer: vi.fn(async () => undefined),
      sendTravelResourceVisionReadyAndSnapshot: vi.fn(async () => undefined)
    });
    const builds = operations.flagBuilds;
    expect(builds).not.toBeNull();

    await builds!.start(player, "request-1", "Northwatch");
    await builds!.start(player, "request-1", "Northwatch");
    builds!.connectPlayer(player.playerId);
    builds!.cancelPlayer(player.playerId, "explicit");

    const starts = sent.filter(
      (message): message is Extract<ServerMessage, { type: "FLAG_BUILD_STARTED" }> =>
        message.type === "FLAG_BUILD_STARTED"
    );
    expect(starts).toHaveLength(3);
    for (const start of starts) {
      expect(start).toMatchObject({
        requestId: "request-1",
        durationMs: 10_000,
        flagName: "Northwatch"
      });
    }
    expect(new Set(starts.map((message) => message.buildId)).size).toBe(1);
    expect(new Set(starts.map((message) => message.completesAt)).size).toBe(1);
  });

  it("publishes globally while leaving builder authority unchanged", async () => {
    vi.useFakeTimers();
    try {
      const config = loadConfig({
        NODE_ENV: "test",
        FLAG_BUILD_DURATION_MS: "10000"
      });
      const gameState = new GameState(config);
      const player = gameState.helloPlayer("flag-builder", "Flag Builder");
      const sent: ServerMessage[] = [];
      const farSent: ServerMessage[] = [];
      const publicationOrder: string[] = [];
      const registry = new ConnectionRegistry();
      const connectionGenerations = new ConnectionGenerationLedger();
      connectionGenerations.allocate(player.playerId);
      registry.add({
        playerId: player.playerId,
        username: player.username,
        regionCode: player.regionCode,
        zoneId: "test-zone",
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send: (payload) => {
            const message = JSON.parse(payload) as ServerMessage;
            sent.push(message);
            publicationOrder.push(message.type);
          },
          close: vi.fn()
        }
      });
      registry.add({
        playerId: "far-player",
        username: "Far Player",
        regionCode: "far-region",
        zoneId: "far-zone",
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send: (payload) => {
            farSent.push(JSON.parse(payload) as ServerMessage);
          },
          close: vi.fn()
        }
      });
      const authorityBeforeBuild =
        gameState.capturePlayerViewTransition(player.playerId);
      const preparedFlag: PreparedFlagPlacement = {
        flagId: "22222222-2222-4222-8222-222222222222",
        anchorKind: "flag",
        ownerId: player.playerId,
        ownerUsername: player.username,
        name: "Southwatch",
        lat: player.position.lat,
        lon: player.position.lon,
        regionCode: player.regionCode,
        movementLeashRadiusM: player.moveLeashRadiusM,
        movementRevision: player.movementRevision,
        relocationRevision: player.relocationRevision ?? 0,
        builderRank: 8,
        buildDurationMs: 10_000,
        materialAffordable: true,
        world: {
          ok: true,
          packageId: player.regionCode,
          elevationM: 1,
          terrainClass: "flat",
          biome: "plain",
          ecoregion: "plain",
          isLand: true,
          isSaltwater: false,
          raw: {}
        },
        admissionTimings: {
          defaultNameMs: 0,
          territoryAdmissionMs: 0,
          worldLookupMs: 0,
          builderRankMs: 0,
          affordabilityMs: 0,
          totalMs: 0,
          quoteState: "hit"
        }
      };
      const flag = {
        id: preparedFlag.flagId,
        controlType: "personal" as const,
        ownerId: player.playerId,
        name: preparedFlag.name,
        lat: preparedFlag.lat,
        lon: preparedFlag.lon,
        packageId: preparedFlag.regionCode,
        elevationM: 1,
        terrainClass: "flat",
        biome: "plain",
        ecoregion: "plain",
        claimRadiusM: 1_000,
        cityId: null,
        createdAt: new Date().toISOString()
      };
      const inventory = {
        playerId: player.playerId,
        items: [],
        totals: {
          wood: 9,
          stone: 0,
          food: 0,
          ore: 0,
          water: 0,
          leather: 0,
          balsam_resin: 0
        }
      };
      const flagService = {
        prepareForPlayer: vi.fn(async () => preparedFlag),
        commitPreparedPlacement: vi.fn(async () => ({ flag, inventory })),
        getFlag: vi.fn(async () => flag),
        notePostBuildQuoteSuppressed: vi.fn()
      } as unknown as FlagService;
      const prepareArea = vi.fn(async (input: {
        source: { sourceId: string };
      }) => ({
        sourceId: input.source.sourceId,
        zoneIds: [],
        outcomes: []
      }));
      const releaseSource = vi.fn(() => true);
      const adoptSource = vi.fn(() => "adopted" as const);
      const logger = {
        info: vi.fn(),
        warn: vi.fn()
      } as unknown as AppLogger;
      const activeOgre = {
        entityId: "33333333-3333-4333-8333-333333333333",
        health: 41,
        position: { lat: flag.lat + 0.00001, lon: flag.lon },
        homePosition: { lat: flag.lat + 0.00001, lon: flag.lon },
        aiState: "aggressive",
        targetEntityId: player.playerId,
        runtimeLease: {
          ownerToken: "44444444-4444-4444-8444-444444444444",
          fencingGeneration: 3,
          cutoverRevision: 9
        }
      };
      const combat = {
        isPlayerAlive: vi.fn(() => true),
        isInCombat: vi.fn(() => false),
        hasQueuedAbility: vi.fn(() => false),
        entity: vi.fn(() => activeOgre),
        despawnMob: vi.fn()
      };
      const ogreBeforeFlag = structuredClone(activeOgre);
      const sendToGameplayCirclesContaining = vi.fn();
      const persistPlayerSnapshot = vi.fn(async () => undefined);
      const schedulePopulationV2RelocationForActivePlayer = vi.fn(() => ({
        visibleReady: Promise.resolve({
          status: "ready",
          pendingVisibleZoneCount: 0
        }),
        completion: Promise.resolve(),
        preparationGeneration: 1,
        visibleZoneCount: 1,
        pendingVisibleZoneCount: () => 0,
        playerId: player.playerId,
        connectionId: registry.activeConnectionIdForPlayer(player.playerId),
        connectionGeneration: 1,
        relocationRevision: 1,
        resourceVisionRevision: 1,
        gameplayViewGeneration: 1,
        trigger: "flag-placement",
        startedAtMs: 0,
        isCurrent: () => true
      } as never));
      const syncCombatPlayerAfterRelocation = vi.fn();
      const sendCombatScopeSnapshot = vi.fn(() => {
        publicationOrder.push("COMBAT_SNAPSHOT");
      });
      const sendCollectiblesForPlayer = vi.fn(async () => {
        publicationOrder.push("COLLECTIBLES_SNAPSHOT");
      });
      const sendTravelResourceVisionReadyAndSnapshot =
        vi.fn(async () => undefined);
      const operations = createFlagRealtimeOperations({
        config,
        logger,
        registry,
        gameState,
        playerService: {
          persistPlayerSnapshot
        },
        connectionGenerations,
        flagService,
        collectibles: {
          prepareResourceVision: vi.fn(async () => ({})),
          inventoryForPlayer: vi.fn(async () => inventory),
          resourceVisionStatus: vi.fn(async () => ({
            flagId: flag.id,
            layoutVersion: "resource-layout-v2",
            status: "pending",
            radiusM: 1_000,
            nodeCount: 0,
            waterHighlightCount: 0,
            requestedAt: new Date().toISOString(),
            generatedAt: null,
            lastError: null,
            updatedAt: new Date().toISOString()
          }))
        } as unknown as CollectibleService,
        combat: combat as never,
        playerAuthorityFence: new PlayerAuthorityFence(),
        populationV2: {
          prepareArea: prepareArea as never,
          releaseSource,
          adoptSource: adoptSource as never
        },
        sendToGameplayCirclesContaining,
        schedulePopulationV2RelocationForActivePlayer,
        syncCombatPlayerAfterRelocation,
        sendCombatScopeSnapshot,
        sendCollectiblesForPlayer,
        sendTravelResourceVisionReadyAndSnapshot
      });

      await operations.flagBuilds!.start(
        player,
        "request-optional-warm",
        "Southwatch"
      );
      connectionGenerations.allocate(player.playerId);
      expect(sendCombatScopeSnapshot).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(sent).toContainEqual(expect.objectContaining({
        type: "FLAG_CREATED",
        requestId: "request-optional-warm",
        flag: expect.objectContaining({ id: flag.id })
      }));
      const created = sent.find((message) =>
        message.type === "FLAG_CREATED" &&
        message.requestId === "request-optional-warm"
      );
      expect(created).not.toHaveProperty("player");
      expect(created).not.toHaveProperty("resourceVisionRevision");
      expect(flagService.commitPreparedPlacement).toHaveBeenCalledOnce();
      expect(combat.despawnMob).not.toHaveBeenCalled();
      expect(combat.entity()).toEqual(ogreBeforeFlag);
      expect(persistPlayerSnapshot).not.toHaveBeenCalled();
      expect(gameState.capturePlayerViewTransition(player.playerId))
        .toEqual(authorityBeforeBuild);
      expect(schedulePopulationV2RelocationForActivePlayer)
        .not.toHaveBeenCalled();
      expect(syncCombatPlayerAfterRelocation).not.toHaveBeenCalled();
      expect(sendCombatScopeSnapshot).not.toHaveBeenCalled();
      expect(sendCollectiblesForPlayer).not.toHaveBeenCalled();
      expect(sendToGameplayCirclesContaining).not.toHaveBeenCalled();
      expect(farSent).toContainEqual(expect.objectContaining({
        type: "FLAG_UPSERTED",
        flag: expect.objectContaining({ id: flag.id })
      }));
      expect(sent).toContainEqual(expect.objectContaining({
        type: "PLAYER_RESOURCES_UPDATED",
        playerId: player.playerId,
        inventory
      }));
      expect(prepareArea).toHaveBeenCalledTimes(2);
      expect(prepareArea).toHaveBeenCalledWith(expect.objectContaining({
        area: expect.objectContaining({
          center: { lat: flag.lat, lon: flag.lon },
          certifiedVisibleRadiusM: 650,
          preparedRadiusM: 1_350
        }),
        source: expect.objectContaining({
          kind: "flag-build",
          targetStage: "SIMULATION_READY",
          priority: 1
        })
      }));
      expect(adoptSource).toHaveBeenCalledTimes(2);
      expect(sent.some((message) => message.type === "ERROR")).toBe(false);

      await vi.advanceTimersByTimeAsync(25_000);
      expect(sent.filter((message) => message.type === "FLAG_CREATED"))
        .toHaveLength(1);
      expect(sent.some((message) =>
        message.type === "FLAG_BUILD_CANCELLED"
      )).toBe(false);
      expect(sent.some((message) => message.type === "ERROR")).toBe(false);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        "completed flag population preparation failed"
      );

      await operations.flagBuilds!.start(
        player,
        "request-optional-warm",
        "Southwatch"
      );
      operations.flagBuilds!.connectPlayer(player.playerId);
      expect(sent.filter((message) =>
        message.type === "FLAG_CREATED" &&
        message.flag.id === flag.id
      )).toHaveLength(2);
      expect(flagService.commitPreparedPlacement).toHaveBeenCalledOnce();
      expect(sendToGameplayCirclesContaining).not.toHaveBeenCalled();
      expect(prepareArea).toHaveBeenCalledTimes(2);
      expect(persistPlayerSnapshot).not.toHaveBeenCalled();
      expect(schedulePopulationV2RelocationForActivePlayer)
        .not.toHaveBeenCalled();
      expect(sendCombatScopeSnapshot).not.toHaveBeenCalled();
      expect(gameState.capturePlayerViewTransition(player.playerId))
        .toEqual(authorityBeforeBuild);
    } finally {
      vi.useRealTimers();
    }
  });
});
