import type { FlagSnapshot, ServerMessage } from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import type { CollectibleService } from "../game/collectibles.js";
import type { CombatEngine } from "../game/combat/combatEngine.js";
import { FlagArrivalReservations } from "../game/flagArrivalAllocator.js";
import { FlagBuildCoordinator } from "../game/flagBuildCoordinator.js";
import { FlagHardeningCoordinator } from "../game/flagHardeningCoordinator.js";
import { FlagBurnCoordinator, FlagBurnError } from "../game/flagBurning.js";
import { FlagRepairCoordinator, isFlagRepairError } from "../game/flagRepairing.js";
import {
  BUOY_BUILD_RECIPE,
  FLAG_BUILD_RECIPE,
  flagSetRevisionMetadata,
  type FlagService
} from "../game/flags.js";
import type { MasteryService } from "../game/masteries.js";
import { InventoryService } from "../game/inventory.js";
import type { PlayerService } from "../game/players.js";
import type { PlayerAuthorityFence } from "../game/playerAuthorityFence.js";
import type { ResourceVisionJobQueue } from "../game/resourceVisionJobs.js";
import type { GameState } from "../game/state.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";
import type { ConnectionGenerationLedger } from "./connectionLifecycle.js";
import type {
  PopulationV2RealtimeHooks,
  ScheduledPopulationV2Relocation
} from "./populationRealtimeOperations.js";

export function createFlagRealtimeOperations(context: Readonly<{
  config?: AppConfig | undefined;
  logger: AppLogger;
  registry: ConnectionRegistry;
  gameState: GameState;
  playerService: Pick<PlayerService, "persistPlayerSnapshot">;
  connectionGenerations: ConnectionGenerationLedger;
  flagService: FlagService;
  collectibles?: CollectibleService | undefined;
  combat?: CombatEngine | undefined;
  worldRuntime?: WorldRuntime | undefined;
  playerAuthorityFence: PlayerAuthorityFence;
  resourceVisionJobs?: ResourceVisionJobQueue | undefined;
  masteries?: MasteryService | undefined;
  inventory?: InventoryService | undefined;
  populationV2?: Pick<
    PopulationV2RealtimeHooks,
    "prepareArea" | "releaseSource" | "adoptSource"
  > | undefined;
  sendToGameplayCirclesContaining(
    position: { lat: number; lon: number },
    message: ServerMessage
  ): void;
  schedulePopulationV2RelocationForActivePlayer(
    playerId: string,
    trigger: "flag-placement",
    expectedConnection: Readonly<{
      connectionId: string;
      connectionGeneration: number;
      requestId: string;
    }>
  ): ScheduledPopulationV2Relocation | null;
  syncCombatPlayerAfterRelocation(
    player: ReturnType<GameState["snapshotForPlayer"]>
  ): void;
  sendCombatScopeSnapshot(playerId: string): void;
  sendCollectiblesForPlayer(
    player: ReturnType<GameState["getPlayer"]>,
    isCurrent?: () => boolean
  ): Promise<void>;
  sendTravelResourceVisionReadyAndSnapshot(
    player: NonNullable<ReturnType<GameState["getPlayer"]>>,
    resourceVision: NonNullable<ReturnType<GameState["getResourceVision"]>>,
    resourceVisionStatus: NonNullable<
      Awaited<ReturnType<CollectibleService["resourceVisionStatus"]>>
    >,
    isCurrent?: () => boolean
  ): Promise<void>;
}>): Readonly<{
  flagBuilds: FlagBuildCoordinator | null;
  flagHardenings: FlagHardeningCoordinator;
  flagBurns: FlagBurnCoordinator;
  flagRepairs: FlagRepairCoordinator;
  flagArrivalReservations: FlagArrivalReservations;
}> {
  const {
    config,
    logger,
    registry,
    gameState,
    connectionGenerations,
    flagService,
    collectibles,
    combat,
    worldRuntime,
    playerAuthorityFence,
    resourceVisionJobs,
    masteries,
    inventory,
    populationV2,
  } = context;

  const flagBuilds = collectibles && config
    ? new FlagBuildCoordinator(config, flagService, logger, {
        currentPlayer: (id) => gameState.getPlayer(id) ?? null,
        isEligible: (id) => Boolean(
          gameState.getPlayer(id)?.online &&
          (!combat || (combat.isPlayerAlive(id) && !combat.isInCombat(id) && !combat.hasQueuedAbility(id)))
        ),
        isMovementPending: (id) => worldRuntime?.hasPendingMovementCommand(id) ?? false,
        isWorldTransitionPending: (id) => worldRuntime?.hasPlayerWorldTransition(id) ?? false,
        subscribeMovementSettled: (id, listener) =>
          worldRuntime?.subscribeMovementSettled(id, listener) ?? (() => {}),
        runAuthorityFence: (id, operation) => playerAuthorityFence.run(id, operation),
        currentConnectionAuthority: (id) => {
          const connectionId = registry.activeConnectionIdForPlayer(id);
          const connectionGeneration = connectionGenerations.current(id);
          return connectionId && connectionGeneration !== undefined
            ? { connectionId, connectionGeneration }
            : null;
        },
        replayCompleted: async (request) => {
          const revisionMetadata =
            await flagSetRevisionMetadata(flagService);
          const flag = await flagService.getFlag(request.flagId);
          if (!flag) throw new Error("completed flag replay is no longer available");
          registry.send(request.playerId, {
            type: "FLAG_CREATED",
            requestId: request.requestId,
            buildId: request.buildId,
            flag,
            serverTime: Date.now(),
            ...revisionMetadata
          });
          registry.send(request.playerId, {
            type: "PLAYER_RESOURCES_UPDATED",
            playerId: request.playerId,
            inventory: await collectibles.inventoryForPlayer(request.playerId),
            serverTime: Date.now()
          });
        },
        sendQueued: (session) => {
          const flagName = session.name?.trim();
          registry.send(session.playerId, {
            type: "FLAG_BUILD_QUEUED",
            buildId: session.buildId,
            requestId: session.requestId,
            queuedAt: session.queuedAt,
            anchorKind: session.anchorKind,
            ...(flagName ? { flagName } : {})
          });
        },
        sendStarted: (session) => {
          const serverTime = Date.now();
          registry.send(session.playerId, {
            type: "FLAG_BUILD_STARTED",
            buildId: session.buildId,
            requestId: session.requestId,
            startedAt: session.startedAt,
            completesAt: session.completesAt,
            durationMs: session.completesAt - session.startedAt,
            serverTime,
            position: { lat: session.preparedFlag.lat, lon: session.preparedFlag.lon },
            anchorKind: session.preparedFlag.anchorKind,
            ...(session.preparedFlag.name ? { flagName: session.preparedFlag.name } : {})
          });
        },
        sendCancelled: (session, reason) => {
          registry.send(session.playerId, {
            type: "FLAG_BUILD_CANCELLED",
            buildId: session.buildId,
            requestId: session.requestId,
            reason,
            serverTime: Date.now()
          });
        },
        queuedRejected: (session, message) => {
          registry.send(session.playerId, {
            type: "ERROR",
            requestId: session.requestId,
            code: "FLAG_BUILD_REJECTED",
            message
          });
        },
        ...(populationV2?.prepareArea
          ? {
              reservePopulation: async (input) => {
                const createdAtMs = Date.now();
                await Promise.all([
                  populationV2.prepareArea!({
                    area: input.area,
                    source: {
                      sourceId: input.sourceId,
                      kind: "flag-build",
                      targetStage: "SIMULATION_READY",
                      priority: 1,
                      createdAtMs,
                      playerId: input.playerId,
                      connectionId: input.connectionId,
                      connectionGeneration: input.connectionGeneration,
                      buildId: input.buildId,
                      expiresAtMs: input.expiresAtMs,
                      authorityToken: input.authorityToken
                    },
                    signal: input.signal
                  }),
                  populationV2.prepareArea!({
                    area: input.area,
                    source: {
                      sourceId: `${input.sourceId}:envelope`,
                      kind: "flag-build",
                      targetStage: "DURABLE_READY",
                      priority: 2,
                      createdAtMs,
                      playerId: input.playerId,
                      connectionId: input.connectionId,
                      connectionGeneration: input.connectionGeneration,
                      buildId: input.buildId,
                      expiresAtMs: input.expiresAtMs,
                      authorityToken: `${input.authorityToken}:envelope`
                    },
                    signal: input.signal
                  })
                ]);
              },
              releasePopulation: (sourceId: string) => {
                const visibleReleased =
                  populationV2.releaseSource?.(sourceId) === true;
                const envelopeReleased =
                  populationV2.releaseSource?.(`${sourceId}:envelope`) === true;
                return visibleReleased || envelopeReleased;
              },
              adoptPopulation: (input) => {
                const adoption = populationV2.adoptSource?.({
                  sourceId: input.sourceId,
                  adoptedSourceId: input.adoptedSourceId,
                  adoptedKind: "flag-build",
                  expectedArea: input.area,
                  expectedAuthorityToken: input.authorityToken,
                  expectedPlayerId: input.playerId,
                  expectedConnectionId: input.connectionId,
                  expectedConnectionGeneration: input.connectionGeneration,
                  expectedBuildId: input.buildId,
                  expiresAtMs: input.expiresAtMs
                }) ?? "missing";
                populationV2.adoptSource?.({
                  sourceId: `${input.sourceId}:envelope`,
                  adoptedSourceId: `${input.adoptedSourceId}:envelope`,
                  adoptedKind: "flag-build",
                  expectedArea: input.area,
                  expectedAuthorityToken: `${input.authorityToken}:envelope`,
                  expectedPlayerId: input.playerId,
                  expectedConnectionId: input.connectionId,
                  expectedConnectionGeneration: input.connectionGeneration,
                  expectedBuildId: input.buildId,
                  expiresAtMs: input.expiresAtMs
                });
                return adoption;
              }
            }
          : {}),
        prepareResourceVision: ({
          resourceVision,
          signal
        }) => collectibles.prepareResourceVision({
          resourceVision,
          signal
        }),
        committed: ({ session, result }) => {
          const flag = result.flag;
          registry.send(session.playerId, {
            type: "FLAG_CREATED",
            requestId: session.requestId,
            buildId: session.buildId,
            flag,
            ...(result.warning ? { warning: result.warning } : {}),
            serverTime: Date.now(),
            ...(result.inventory ? { inventory: result.inventory } : {}),
            ...(result.inventory
              ? { consumedMaterials: [...(
                  session.preparedFlag.anchorKind === "buoy"
                    ? BUOY_BUILD_RECIPE
                    : FLAG_BUILD_RECIPE
                )] }
              : {}),
            ...(result.materialsRefunded
              ? { recoveredMaterials: [...(
                  session.preparedFlag.anchorKind === "buoy"
                    ? BUOY_BUILD_RECIPE
                    : FLAG_BUILD_RECIPE
                )] }
              : {}),
            ...(result.flagSetRevision === undefined
              ? {}
              : { flagSetRevision: result.flagSetRevision })
          });
        },
        completed: async ({
          session,
          result,
          preparedResourceVisionPlan,
          pendingResourceVisionPlan
        }) => {
          const flag = result.flag;
          if (resourceVisionJobs && result.activationJobKey) {
            let adopted = false;
            let preparationTimer: ReturnType<typeof setTimeout> | null = null;
            const preparedPlan = preparedResourceVisionPlan ?? (
              pendingResourceVisionPlan
                ? await Promise.race([
                    pendingResourceVisionPlan,
                    new Promise<null>((resolve) => {
                      preparationTimer = setTimeout(
                        () => resolve(null),
                        config?.RESOURCE_ENVIRONMENT_BATCH_TIMEOUT_MS ?? 10_000
                      );
                      preparationTimer.unref?.();
                    })
                  ]).finally(() => {
                    if (preparationTimer) clearTimeout(preparationTimer);
                  })
                : null
            );
            if (preparedPlan) {
              try {
                adopted = await resourceVisionJobs.adoptPreparedExisting(
                  result.activationJobKey,
                  {
                    buildId: session.buildId,
                    sessionToken: session.token,
                    prepared: preparedPlan,
                    flag,
                    regionCode: session.regionCode,
                    movementLeashRadiusM: session.movementLeashRadiusM,
                    reason: "flag-build",
                    onComplete: async () => undefined
                  }
                );
              } catch (error) {
                logger.warn(
                  { err: error, flagId: flag.id, buildId: session.buildId },
                  "prepared flag Resource Vision adoption failed"
                );
              }
            }
            if (!adopted) {
              await resourceVisionJobs.subscribeOrReplayCompletion(
                result.activationJobKey,
                {
                  flag,
                  regionCode: session.regionCode,
                  movementLeashRadiusM: session.movementLeashRadiusM,
                  reason: "flag-build"
                },
                async () => undefined
              );
            }
          }
          const sentAt = Date.now();
          registry.broadcast({
            type: "FLAG_UPSERTED",
            flag,
            serverTime: sentAt,
            ...(result.flagSetRevision === undefined
              ? {}
              : { flagSetRevision: result.flagSetRevision })
          });
          if (result.inventory) {
            registry.send(session.playerId, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: session.playerId,
              inventory: result.inventory,
              serverTime: sentAt
            });
          }
          if (result.masteryGrant && masteries) {
            void masteries.getOrCreate(session.playerId).then((snapshot) => {
              registry.send(session.playerId, {
                type: "MASTERY_SNAPSHOT",
                masteries: snapshot
              });
            });
          }
        }
      })
    : null;
  const flagHardenings = new FlagHardeningCoordinator(flagService, logger, {
    sendStarted: (session) => {
      registry.send(session.playerId, {
        type: "FLAG_REINFORCEMENT_STARTED",
        requestId: session.requestId,
        flagId: session.flagId,
        flagName: session.flagName,
        startedAt: session.startedAt,
        completesAt: session.completesAt,
        durationMs: session.durationMs,
        targetTier: session.targetTier,
        ...(session.targetTowerLevel === undefined ? {} : { targetTowerLevel: session.targetTowerLevel }),
        serverTime: Date.now(),
        position: session.position
      });
    },
    sendCancelled: (session, reason) => {
      registry.send(session.playerId, {
        type: "FLAG_REINFORCEMENT_CANCELLED",
        requestId: session.requestId,
        flagId: session.flagId,
        reason,
        serverTime: Date.now()
      });
    },
    completed: async (session, result) => {
      const revisionMetadata = await flagSetRevisionMetadata(flagService);
      registry.send(session.playerId, {
        type: "FLAG_REINFORCED",
        requestId: session.requestId,
        flag: result.flag,
        inventory: result.inventory,
        replayed: result.replayed,
        ...revisionMetadata
      });
      if (result.masteryGrant) {
        registry.send(session.playerId, {
          type: "MASTERY_SNAPSHOT",
          masteries: result.masteryGrant.snapshot
        });
      }
      if (!result.replayed) {
        registry.broadcast({
          type: "FLAG_UPDATED",
          flag: result.flag,
          ...revisionMetadata
        });
      }
    },
    failed: (session, error) => {
      registry.send(session.playerId, {
        type: "ERROR",
        requestId: session.requestId,
        code: "FLAG_REINFORCEMENT_REJECTED",
        message: error instanceof Error ? error.message : "Flag reinforcement rejected"
      });
    }
  });
  const burnInventory = inventory ?? new InventoryService(flagService.databasePool);
  const flagBurns = new FlagBurnCoordinator(flagService, burnInventory, logger, {
    currentPlayer: (playerId) => gameState.getPlayer(playerId) ?? null,
    isPlayerAlive: (playerId) => combat?.isPlayerAlive(playerId) ?? true,
    sendStarted: (session) => {
      registry.send(session.playerId, {
        type: "FLAG_BURN_STARTED",
        operationId: session.operationId,
        requestId: session.requestId,
        flagId: session.flagId,
        flagName: session.flagName,
        startedAt: session.startedAt,
        completesAt: session.completesAt,
        durationMs: session.durationMs,
        serverTime: Date.now(),
        position: session.position
      });
      void flagService.getFlag(session.flagId).then((flag) => {
        if (flag) registry.broadcast({ type: "FLAG_UPSERTED", flag, serverTime: Date.now() });
      }).catch((error: unknown) => logger.warn({ err: error, flagId: session.flagId }, "failed to publish burning Flag presentation"));
    },
    sendVictimNotice: (session) => {
      registry.send(session.victimPlayerId, {
        type: "FLAG_BURN_NOTICE",
        operationId: session.operationId,
        flagId: session.flagId,
        flagName: session.flagName,
        message: session.noticeMessage,
        completesAt: session.completesAt,
        serverTime: Date.now()
      });
    },
    sendCancelled: (session, reason) => {
      registry.send(session.playerId, {
        type: "FLAG_BURN_CANCELLED",
        operationId: session.operationId,
        requestId: session.requestId,
        flagId: session.flagId,
        reason,
        serverTime: Date.now()
      });
      void flagService.getFlag(session.flagId).then((flag) => {
        if (flag) registry.broadcast({ type: "FLAG_UPSERTED", flag, serverTime: Date.now() });
      }).catch((error: unknown) => logger.warn({ err: error, flagId: session.flagId }, "failed to clear burning Flag presentation"));
    },
    healthChanged: async (flagId) => {
      const flag = await flagService.getMapFlag(flagId);
      if (flag) registry.broadcast({ type: "FLAG_UPDATED", flag, ...await flagSetRevisionMetadata(flagService) });
    },
    completed: async (session, result) => {
      registry.send(session.playerId, {
        type: "PLAYER_RESOURCES_UPDATED",
        playerId: session.playerId,
        inventory: result.inventory,
        serverTime: Date.now()
      });
      // A burnt-out city or kingdom structure stays at zero health until the
      // organization fall sweep breaks it (or collapses the territory).
      const remaining = await flagService.getMapFlag(session.flagId);
      if (remaining) {
        registry.broadcast({ type: "FLAG_UPDATED", flag: remaining, ...await flagSetRevisionMetadata(flagService) });
        return;
      }
      registry.broadcast({ type: "FLAG_DELETED", flagId: session.flagId, reason: "destroyed", ...await flagSetRevisionMetadata(flagService) });
    },
    failed: (session, error) => {
      registry.send(session.playerId, {
        type: "ERROR",
        requestId: session.requestId,
        code: error instanceof FlagBurnError ? error.code : "FLAG_BURN_REJECTED",
        message: error instanceof Error ? error.message : "Flag burn rejected"
      });
    }
  }, Date.now, flagService.structureWarfare);
  void flagBurns.reconcile().catch((error: unknown) => {
    logger.warn({ err: error }, "durable Flag burn reconciliation failed");
  });
  const flagRepairs = new FlagRepairCoordinator(
    flagService.structureWarfare,
    logger,
    {
      sendStarted: (session, inventorySnapshot) => {
        registry.broadcast({
          type: "FLAG_REPAIR_STARTED",
          operationId: session.operationId,
          requestId: session.requestId,
          flagId: session.structureId,
          ownerId: session.playerId,
          flagName: session.structureName,
          startedAt: session.startedAt,
          completesAt: session.completesAt,
          durationMs: session.durationMs,
          pausedBurnRemainingMs: session.pausedBurnRemainingMs,
          repairKitQuantity: session.repairKitQuantity,
          stoneQuantity: session.stoneQuantity,
          serverTime: Date.now(),
          position: session.position
        });
        if (inventorySnapshot) {
          registry.send(session.playerId, {
            type: "PLAYER_RESOURCES_UPDATED",
            playerId: session.playerId,
            inventory: inventorySnapshot,
            serverTime: Date.now()
          });
        }
      },
      sendCancelled: (session, reason) => {
        registry.broadcast({
          type: "FLAG_REPAIR_CANCELLED",
          operationId: session.operationId,
          requestId: session.requestId,
          flagId: session.structureId,
          reason,
          serverTime: Date.now()
        });
        void flagService.getFlag(session.structureId).then((flag) => {
          if (flag) registry.broadcast({ type: "FLAG_UPSERTED", flag, serverTime: Date.now() });
        }).catch((error: unknown) => logger.warn({ err: error, flagId: session.structureId }, "failed to publish cancelled Flag repair"));
      },
      completed: async (session, result) => {
        const flag = result.structure as FlagSnapshot;
        registry.send(session.playerId, {
          type: "FLAG_REPAIRED",
          operationId: session.operationId,
          requestId: session.requestId,
          flag,
          inventory: result.inventory,
          replayed: result.replayed,
          serverTime: Date.now()
        });
        registry.broadcast({
          type: "FLAG_REPAIR_CANCELLED",
          operationId: session.operationId,
          requestId: session.requestId,
          flagId: session.structureId,
          reason: "completed",
          serverTime: Date.now()
        });
        registry.broadcast({ type: "FLAG_UPSERTED", flag, serverTime: Date.now() });
      },
      progressed: (session, structure, projectionChanged) => {
        if (structure) {
          registry.broadcast({ type: "FLAG_UPSERTED", flag: structure as FlagSnapshot, serverTime: Date.now() });
        }
        if (projectionChanged) {
          registry.broadcast({
            type: "FLAG_REPAIR_STARTED",
            operationId: session.operationId,
            requestId: session.requestId,
            flagId: session.structureId,
            ownerId: session.playerId,
            flagName: session.structureName,
            startedAt: session.startedAt,
            completesAt: session.completesAt,
            durationMs: session.durationMs,
            pausedBurnRemainingMs: session.pausedBurnRemainingMs,
            repairKitQuantity: session.repairKitQuantity,
            stoneQuantity: session.stoneQuantity,
            serverTime: Date.now(),
            position: session.position
          });
        }
      },
      failed: (session, error) => {
        registry.send(session.playerId, {
          type: "ERROR",
          requestId: session.requestId,
          code: isFlagRepairError(error) ? error.code : "FLAG_REPAIR_REJECTED",
          message: error instanceof Error ? error.message : "Flag repair rejected"
        });
      },
      sendDisruptStarted: (session) => {
        registry.broadcast({
          type: "FLAG_REPAIR_DISRUPT_STARTED",
          operationId: session.operationId,
          requestId: session.requestId,
          flagId: session.structureId,
          repairOperationId: session.repairOperationId,
          startedAt: session.startedAt,
          completesAt: session.completesAt,
          durationMs: session.durationMs,
          serverTime: Date.now(),
          position: session.position
        });
      },
      sendDisruptCancelled: (session, reason) => {
        registry.broadcast({
          type: "FLAG_REPAIR_DISRUPT_CANCELLED",
          operationId: session.operationId,
          requestId: session.requestId,
          flagId: session.structureId,
          reason,
          serverTime: Date.now()
        });
      },
      disrupted: async (session, result) => {
        registry.broadcast({
          type: "FLAG_REPAIR_DISRUPTED",
          operationId: session.operationId,
          requestId: session.requestId,
          flagId: session.structureId,
          repairOperationId: result.repairOperationId,
          replayed: result.replayed,
          serverTime: Date.now()
        });
        const flag = await flagService.getFlag(session.structureId);
        if (flag) registry.broadcast({ type: "FLAG_UPSERTED", flag, serverTime: Date.now() });
      },
      disruptFailed: (session, error) => {
        registry.send(session.playerId, {
          type: "ERROR",
          requestId: session.requestId,
          code: isFlagRepairError(error) ? error.code : "FLAG_DISRUPT_REJECTED",
          message: error instanceof Error ? error.message : "Repair disruption rejected"
        });
      }
    },
    Date.now,
    (playerId) => gameState.isWorldPresent(playerId) ? gameState.getPlayer(playerId) ?? null : null,
    (playerId) => combat?.isPlayerAlive(playerId) ?? true,
    (playerId) => !combat?.isInCombat(playerId) && !combat?.hasQueuedAbility(playerId)
  );
  void flagRepairs.reconcile().catch((error: unknown) => {
    logger.warn({ err: error }, "durable Flag repair reconciliation failed");
  });
  const flagArrivalReservations = new FlagArrivalReservations();


  return { flagBuilds, flagHardenings, flagBurns, flagRepairs, flagArrivalReservations };
}

