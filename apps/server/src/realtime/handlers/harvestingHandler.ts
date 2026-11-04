import type {
  EquipmentSnapshotV2,
  HarvestSessionSnapshot,
  LatLon,
  ProgressionSnapshot,
  ServerMessage,
  XpGrantResult
} from "@ash-atlas/shared";
import {
  dungeonLocalToCombatPosition,
  requireBackpackDefinition,
  requireEquipmentDefinition
} from "@ash-atlas/shared";

import type { AppLogger } from "../../logger.js";
import type { ClosedTestTelemetryService } from "../../telemetry/service.js";
import {
  BalsamResinError,
  type BalsamResinService
} from "../../game/balsamResin.js";
import { SimpleFoodError, type SimpleFoodService } from "../../game/simpleFood.js";
import {
  CollectibleHarvestError,
  collectiblePlayerFromRecord,
  isPlayerTreeNodeId,
  type HarvestedPopulationTreeTransition,
  WaterCollectionCadenceError,
  type CollectibleService
} from "../../game/collectibles.js";
import type { CombatEngine } from "../../game/combat/combatEngine.js";
import { DroppedItemError, type DroppedItemService } from "../../game/droppedItems.js";
import type { EquipmentService } from "../../game/equipment.js";
import { wornUtilityGlove } from "../../game/utilityGear.js";
import { HarvestSessionError, type HarvestSessionService } from "../../game/harvestSessions.js";
import {
  gatheringActivityForHarvest,
  type GatheringHarvestSource
} from "../../game/gatheringActivity.js";
import {
  type InventoryService
} from "../../game/inventory.js";
import {
  InventoryProtectionError,
  type InventoryProtectionService
} from "../../game/inventoryProtection.js";
import { requireItemDefinition } from "../../game/items.js";
import type { ProgressionService } from "../../game/progression.js";
import type { PlayerAuthorityFence } from "../../game/playerAuthorityFence.js";
import type { PlayerLocationService } from "../../game/locations/playerLocationService.js";
import {
  repeatableCompletionFailureDisposition,
  RepeatableResourceError,
  type RepeatableTerminalCleanupResult,
  type RepeatableResourceService
} from "../../game/repeatableResources.js";
import type { GameState } from "../../game/state.js";
import type { HollinHutService } from "../../game/hollinHuts.js";
import type { XoralEventService } from "../../game/xoralEvents.js";
import type { CisternWarrensRuntime } from "../../game/dungeon.js";
import type { DungeonResourceHarvestService } from "../../game/dungeonResourceHarvest.js";
import { createDungeonHarvestFlow } from "./dungeonHarvestFlow.js";
import type { ManorRuntime } from "../../game/manor.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";
import {
  craftFieldConsumable,
  isFieldConsumableUse,
  useFieldConsumable,
  type FieldConsumableContext
} from "./fieldConsumableHandler.js";
import type { FieldConsumableService } from "../../game/fieldConsumables.js";
import type { WaterSiteService } from "../../game/waterSites.js";
import { handleWaterSiteMessage, type WhirlpoolTravel } from "./waterSiteHandler.js";

type Position = { lat: number; lon: number };

export type HarvestingHandlerContext = Readonly<{
  state: Pick<
    RealtimeConnectionState,
    "playerId" | "connectionId" | "connectionGeneration"
  >;
  socket: SocketLike;
  logger: AppLogger;
  registry: ConnectionRegistry;
  telemetry?: ClosedTestTelemetryService | undefined;
  authSessionId?: string | null | undefined;
  gameState: GameState;
  collectibles?: CollectibleService | undefined;
  harvestSessions?: HarvestSessionService | undefined;
  hollinHuts?: HollinHutService | undefined;
  dungeonResourceHarvest?: DungeonResourceHarvestService | undefined;
  droppedItems?: DroppedItemService | undefined;
  manorRuntime?: ManorRuntime | undefined;
  dungeon?: CisternWarrensRuntime | undefined;
  combat?: CombatEngine | undefined;
  progression?: ProgressionService | undefined;
  equipment?: EquipmentService | undefined;
  repeatableResources?: RepeatableResourceService | undefined;
  inventory?: InventoryService | undefined;
  playerAuthorityFence?: PlayerAuthorityFence | undefined;
  playerLocations?: Pick<PlayerLocationService, "load"> | undefined;
  inventoryProtection?: InventoryProtectionService | undefined;
  xoralEvents?: XoralEventService | undefined;
  balsamResin?: BalsamResinService | undefined;
  simpleFood?: SimpleFoodService | undefined;
  fieldConsumables?: FieldConsumableService | undefined;
  strikeStructures?: FieldConsumableContext["strikeStructures"];
  /** Pearl Beds, whirlpools and Drowned City sites (water game phases C and D). */
  waterSites?: WaterSiteService | undefined;
  travelThroughWhirlpool?: WhirlpoolTravel | undefined;
  broadcastDroppedItems(
    positions?: readonly Readonly<{ lat: number; lon: number }>[]
  ): Promise<void>;
  refreshAuthoritativePlayerStats(playerId: string): Promise<{
    progression: ProgressionSnapshot;
    equipment: EquipmentSnapshotV2;
  }>;
  awaitCommittedPlayerWorldTransition(requestId: string): Promise<boolean>;
  rejectDuringPlayerWorldTransition(
    requestId: string,
    error?: Readonly<{ code: string; message: string }>
  ): boolean;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
  sendCollectiblesForPlayer(
    player: ReturnType<GameState["getPlayer"]>,
    isCurrent?: () => boolean
  ): Promise<void>;
  sendDroppedItemsForPlayer?(
    playerId: string,
    isCurrent?: () => boolean
  ): Promise<void>;
  sendToGameplayCirclesContaining(position: Position, message: ServerMessage): void;
  removeHarvestedTree(transition: HarvestedPopulationTreeTransition): void;
  /** A grown player-planted tree was chopped: it leaves the healing-aura index. */
  onPlayerTreeChopped?(nodeId: string): void;
}>;

function harvestErrorCode(error: unknown, fallback: string): string {
  return error instanceof HarvestSessionError ||
    error instanceof RepeatableResourceError ||
    error instanceof CollectibleHarvestError
    ? error.code
    : fallback;
}

function harvestErrorMessage(error: unknown, fallback: string): string {
  return error instanceof HarvestSessionError ||
    error instanceof RepeatableResourceError ||
    error instanceof CollectibleHarvestError
    ? error.message
    : fallback;
}

function harvestErrorDetails(
  error: unknown,
  identity: Readonly<{
    nodeId?: string;
    sessionId?: string;
    resourceVisionRevision?: number;
  }>,
  cleanup?: RepeatableTerminalCleanupResult
): {
  nodeId?: string;
  sessionId?: string;
  retryAfterMs?: number;
  stateRevision?: number;
  populationV2StateRevision?: number;
  resourceVisionRevision?: number;
  sessionStatusBeforeCleanup?: Exclude<
    RepeatableTerminalCleanupResult["statusBefore"],
    null
  >;
  sessionStatusAfterCleanup?: Exclude<
    RepeatableTerminalCleanupResult["statusAfter"],
    null
  >;
  terminalCleanupOutcome?: RepeatableTerminalCleanupResult["outcome"];
  authoritativeDistanceM?: number;
  maximumDistanceM?: number;
  reconciliation?: "remove-node" | "refresh-node";
  presentationOwner?: "population" | "repeatable-resource" | "resource-vision";
  authorityFailureReason?:
    | "projection-harvest-revision-changed"
    | "canonical-state-revision-mismatch"
    | "canonical-state-not-ready"
    | "projection-suppressed"
    | "projection-canonical-entity-mismatch"
    | "projection-plan-cutover-mismatch"
    | "projection-definition-mismatch"
    | "canonical-lifecycle-invalid";
  startingHarvestRevision?: number;
  completionHarvestRevision?: number;
  projectionStateRevision?: number;
  canonicalStateRevision?: number;
  canonicalState?: "ready" | "harvested" | "dead";
  currentWeightGrams?: string;
  maximumWeightGrams?: string;
  availableWeightGrams?: string;
  requestedYield?: number;
} {
  const collectibleDetails = error instanceof CollectibleHarvestError
    ? {
        ...(error.details.nodeId === undefined
          ? {}
          : { nodeId: error.details.nodeId }),
        ...(error.details.stateRevision === undefined
          ? {}
          : { stateRevision: error.details.stateRevision }),
        ...(error.details.authoritativeDistanceM === undefined
          ? {}
          : { authoritativeDistanceM: error.details.authoritativeDistanceM }),
        ...(error.details.maximumDistanceM === undefined
          ? {}
          : { maximumDistanceM: error.details.maximumDistanceM }),
        ...(error.details.reconciliation === undefined
          ? {}
          : { reconciliation: error.details.reconciliation })
      }
    : {};
  const repeatableDetails = error instanceof RepeatableResourceError
    ? {
        ...(error.details.nodeId === undefined
          ? {}
          : { nodeId: error.details.nodeId }),
        ...(error.details.stateRevision === undefined
          ? {}
          : { stateRevision: error.details.stateRevision }),
        ...(error.details.populationV2StateRevision === undefined
          ? {}
          : {
              populationV2StateRevision:
                error.details.populationV2StateRevision
            }),
        ...(error.details.authoritativeDistanceM === undefined
          ? {}
          : {
              authoritativeDistanceM:
                error.details.authoritativeDistanceM
            }),
        ...(error.details.reconciliation === undefined
          ? {}
          : { reconciliation: error.details.reconciliation }),
        ...(error.details.authorityFailureReason === undefined
          ? {}
          : { authorityFailureReason: error.details.authorityFailureReason }),
        ...(error.details.startingHarvestRevision === undefined
          ? {}
          : { startingHarvestRevision: error.details.startingHarvestRevision }),
        ...(error.details.completionHarvestRevision === undefined
          ? {}
          : { completionHarvestRevision: error.details.completionHarvestRevision }),
        ...(error.details.projectionStateRevision === undefined
          ? {}
          : { projectionStateRevision: error.details.projectionStateRevision }),
        ...(error.details.canonicalStateRevision === undefined
          ? {}
          : { canonicalStateRevision: error.details.canonicalStateRevision }),
        ...(error.details.canonicalState === undefined
          ? {}
          : { canonicalState: error.details.canonicalState }),
        ...(error.details.currentWeightGrams === undefined
          ? {} : { currentWeightGrams: error.details.currentWeightGrams }),
        ...(error.details.maximumWeightGrams === undefined
          ? {} : { maximumWeightGrams: error.details.maximumWeightGrams }),
        ...(error.details.availableWeightGrams === undefined
          ? {} : { availableWeightGrams: error.details.availableWeightGrams }),
        ...(error.details.requestedYield === undefined
          ? {}
          : { requestedYield: error.details.requestedYield })
      }
    : {};
  return {
    ...identity,
    ...collectibleDetails,
    ...repeatableDetails,
    ...(cleanup?.statusBefore === null || cleanup?.statusBefore === undefined
      ? {}
      : { sessionStatusBeforeCleanup: cleanup.statusBefore }),
    ...(cleanup?.statusAfter === null || cleanup?.statusAfter === undefined
      ? {}
      : { sessionStatusAfterCleanup: cleanup.statusAfter }),
    ...(cleanup === undefined
      ? {}
      : { terminalCleanupOutcome: cleanup.outcome }),
    ...(
      (error instanceof HarvestSessionError ||
        error instanceof RepeatableResourceError) &&
      error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}
    )
  };
}

function droppedItemErrorCode(error: unknown, fallback: string): string {
  return error instanceof DroppedItemError ? error.code : fallback;
}

function droppedItemErrorMessage(error: unknown, fallback: string): string {
  return error instanceof DroppedItemError ? error.message : fallback;
}

export function createHarvestingHandler(
  context: HarvestingHandlerContext
): RealtimeFamilyHandler<"harvesting"> {
  return async (message) => {
    const {
      state,
      socket,
      logger,
      registry,
      telemetry,
      authSessionId,
      gameState,
      collectibles,
      harvestSessions,
      hollinHuts,
      dungeonResourceHarvest,
      droppedItems,
      manorRuntime,
      dungeon,
      combat,
      progression,
      equipment,
      repeatableResources,
      inventory,
      playerAuthorityFence,
      playerLocations,
      inventoryProtection,
      xoralEvents,
      balsamResin,
      simpleFood,
      broadcastDroppedItems,
      refreshAuthoritativePlayerStats,
      awaitCommittedPlayerWorldTransition,
      rejectDuringPlayerWorldTransition,
      safeSendServerMessage,
      sendCollectiblesForPlayer,
      sendDroppedItemsForPlayer,
      sendToGameplayCirclesContaining,
      removeHarvestedTree,
      onPlayerTreeChopped
    } = context;
    const fieldConsumableContext = (playerId: string | null | undefined): FieldConsumableContext => ({
      playerId: playerId as string,
      socket,
      logger,
      gameState,
      combat,
      fieldConsumables: context.fieldConsumables,
      strikeStructures: context.strikeStructures,
      safeSendServerMessage
    });
    const dungeonHarvestFlow = createDungeonHarvestFlow({
      playerId: () => state.playerId ?? null,
      registry,
      service: dungeonResourceHarvest,
      dungeon,
      combat,
      equipment,
      send: (outgoing) => {
        safeSendServerMessage(socket, outgoing, logger, {
          playerId: state.playerId,
          operationType: "dungeon-harvest-publication"
        });
      },
      broadcastDroppedItems,
      warn: (error, step) => {
        logger.warn({ err: error, playerId: state.playerId, step }, "dungeon harvest work failed");
      }
    });
    const currentDroppedItemActor = () => {
      const actorPlayerId = state.playerId;
      if (!actorPlayerId) return null;
      const worldPlayer = gameState.getPlayer(actorPlayerId);
      if (!worldPlayer) return null;
      const dungeonSnapshot = dungeon?.get(actorPlayerId);
      if (!dungeonSnapshot) {
        return {
          ...worldPlayer,
          zoneId: `world:${worldPlayer.regionCode}`
        };
      }
      return {
        ...worldPlayer,
        regionCode: `interior:${dungeonSnapshot.instanceId}`,
        zoneId: `interior:${dungeonSnapshot.instanceId}:${dungeonSnapshot.spaceId}`,
        position: dungeonLocalToCombatPosition(
          dungeonSnapshot.player.x,
          dungeonSnapshot.player.y
        )
      };
    };
    const currentWorldDroppedItemActor = async () => {
      const actorPlayerId = state.playerId;
      if (!actorPlayerId) return null;
      const location = await playerLocations?.load(actorPlayerId);
      if (location?.kind === "interior" || !gameState.isWorldPresent(actorPlayerId)) {
        throw new DroppedItemError(
          "DROPPED_ITEM_OUT_OF_RANGE",
          "Ground items can only be used in the world"
        );
      }
      return currentDroppedItemActor();
    };
    const currentManorDroppedItemActor = (
      expectedSessionId?: string
    ) => {
      const actorPlayerId = state.playerId;
      if (!actorPlayerId) return null;
      const session = manorRuntime?.get(actorPlayerId);
      if (!session || (expectedSessionId && session.sessionId !== expectedSessionId)) {
        throw new DroppedItemError(
          "DROPPED_ITEM_OUT_OF_RANGE",
          "Your Manor session is no longer active"
        );
      }
      const worldPlayer = gameState.getPlayer(actorPlayerId);
      if (!worldPlayer) return null;
      return {
        ...worldPlayer,
        regionCode: `interior:manor:${session.manorId}`,
        zoneId: `manor:${session.manorId}:${session.spaceId}`,
        manorId: session.manorId,
        spaceId: session.spaceId,
        localPosition: { x: session.position.x, y: session.position.y },
        position: { lat: 0, lon: 0 }
      };
    };
    const broadcastManorEquipmentDrops = async (manorId: string): Promise<void> => {
      if (!droppedItems || !manorRuntime) return;
      const drops = await droppedItems.listActiveManorDrops(manorId);
      for (const occupantId of manorRuntime.playerIdsInManor(manorId)) {
        const session = manorRuntime.get(occupantId);
        if (!session || session.manorId !== manorId) continue;
        registry.send(occupantId, {
          type: "MANOR_EQUIPMENT_DROPS_UPDATED",
          manorId,
          drops,
          serverTime: Date.now()
        });
      }
    };
    const runDroppedItemAuthority = <T>(
      playerId: string,
      operation: () => Promise<T>
    ): Promise<T> => playerAuthorityFence?.run(playerId, operation) ?? operation();
    const isCurrentConnection = (playerId: string): boolean =>
      Boolean(
        state.connectionId &&
        registry.isActivePlayerConnection(playerId, state.connectionId)
      );
    const refreshReplacementAfterInventoryCommit = async (
      playerId: string,
      originalConnectionId: string | null
    ): Promise<void> => {
      const replacementConnectionId = registry.activeConnectionIdForPlayer(playerId);
      if (!replacementConnectionId || replacementConnectionId === originalConnectionId) return;
      if (inventory) {
        const inventorySnapshot = await inventory.getInventorySnapshot(playerId);
        if (registry.activeConnectionIdForPlayer(playerId) === replacementConnectionId) {
          registry.sendToConnection(replacementConnectionId, {
            type: "PLAYER_RESOURCES_UPDATED",
            playerId,
            inventory: inventorySnapshot,
            serverTime: Date.now()
          });
        }
      }
      await sendDroppedItemsForPlayer?.(
        playerId,
        () => registry.activeConnectionIdForPlayer(playerId) === replacementConnectionId
      );
    };
    /** Show nearby players this gathering action; a replay without a node keeps the known target. */
    const publishGatheringStart = (
      playerId: string,
      session: HarvestSessionSnapshot,
      source: GatheringHarvestSource,
      nodePosition: LatLon | null
    ): void => {
      const previous = gameState.gatheringActivity(playerId);
      const target = nodePosition ?? (previous && previous.startedAt === session.startedAt
        ? { lat: previous.targetLat, lon: previous.targetLon }
        : null);
      gameState.setGatheringActivity(playerId, gatheringActivityForHarvest({
        session,
        source,
        target,
        equipment: equipment?.runtimeSnapshot(playerId)
      }));
    };
    const recordHarvest = (
      eventType: string,
      input: {
        operationId?: string;
        targetId?: string;
        itemId?: string;
        quantity?: number;
        replayed?: boolean;
        rejectionCode?: string;
      }
    ): void => {
      telemetry?.recordEvent({
        eventFamily: "harvest",
        eventType,
        priority: input.rejectionCode ? "important" : "routine",
        playerId: state.playerId,
        sessionId: authSessionId ?? null,
        operationId: input.operationId ?? null,
        targetId: input.targetId ?? null,
        itemOrCurrencyId: input.itemId ?? null,
        quantityDelta: input.quantity ?? null,
        appliedState: input.rejectionCode
          ? "rejected"
          : input.replayed
            ? "replayed"
            : "applied",
        rejectionCode: input.rejectionCode ?? null
      });
    };
    const sendXpGrant = (targetSocket: SocketLike, grant: XpGrantResult): void => {
      safeSendServerMessage(
        targetSocket,
        { type: "XP_GRANTED", grant },
        logger,
        { playerId: state.playerId, operationType: "harvest-xp-publication" }
      );
      for (const level of grant.levelsGained) {
        safeSendServerMessage(
          targetSocket,
          {
            type: "LEVEL_UP",
            level,
            progression: grant.progression
          },
          logger,
          { playerId: state.playerId, operationType: "harvest-level-publication" }
        );
      }
    };
    const runPostCommitHarvestStep = async <T,>(
      step: string,
      task: () => T | Promise<T>
    ): Promise<T | undefined> => {
      try {
        return await task();
      } catch (error) {
        logger.warn(
          { err: error, playerId: state.playerId, step },
          "post-commit harvest work failed"
        );
        return undefined;
      }
    };
    const rejectStaleHarvestAuthority = (requestId: string): boolean => {
      if (
        !state.playerId ||
        !state.connectionId ||
        registry.activeConnectionIdForPlayer(state.playerId) === state.connectionId
      ) return false;
      logger.info({
        playerId: state.playerId,
        requestId,
        originatingConnectionId: state.connectionId,
        originatingConnectionGeneration: state.connectionGeneration,
        currentConnectionId: registry.activeConnectionIdForPlayer(state.playerId)
      }, "stale harvest command rejected");
      safeSendServerMessage(socket, {
        type: "ERROR",
        requestId,
        code: "HARVEST_STALE_CONNECTION_GENERATION",
        message: "This gathering request belongs to a replaced connection."
      });
      return true;
    };
    // Inside a dungeon only dungeon harvest sessions may complete or cancel; world sessions wait
    // until the player is back in the world.
    const rejectWorldHarvestInsideDungeon = (requestId: string): boolean => {
      if (!state.playerId || !dungeon?.isInside(state.playerId)) return false;
      safeSendServerMessage(socket, {
        type: "DUNGEON_ERROR",
        requestId,
        code: "WORLD_ACTION_UNAVAILABLE",
        message: "That world action is unavailable inside the dungeon."
      });
      return true;
    };
    const refreshCollectiblesAfterHarvestRejection = async (): Promise<void> => {
      if (!state.playerId) return;
      try {
        await sendCollectiblesForPlayer(gameState.getPlayer(state.playerId));
      } catch (error) {
        logger.warn(
          { err: error, playerId: state.playerId },
          "collectible reconciliation after harvest rejection failed"
        );
      }
    };
    const broadcastAuthoritativeHarvestRemoval = (error: unknown): void => {
      if (
        !(error instanceof CollectibleHarvestError) ||
        error.code === "HARVEST_OUTSIDE_RESOURCE_VISION" ||
        error.details.reconciliation !== "remove-node" ||
        !error.details.nodeId ||
        !error.details.nodePosition
      ) return;
      if (
        error.code === "HARVEST_NODE_ALREADY_HARVESTED" &&
        error.details.populationTreeTransition
      ) {
        try {
          removeHarvestedTree(error.details.populationTreeTransition);
        } catch (evictionError) {
          logger.warn(
            {
              err: evictionError,
              playerId: state.playerId,
              nodeId: error.details.nodeId
            },
            "already-harvested tree runtime eviction failed"
          );
        }
      }
      combat?.removeGivingTree(error.details.nodeId);
      try {
        sendToGameplayCirclesContaining(error.details.nodePosition, {
          type: "COLLECTIBLE_REMOVED",
          nodeId: error.details.nodeId,
          playerId: state.playerId!,
          ...(error.details.stateRevision === undefined
            ? {}
            : { stateRevision: error.details.stateRevision }),
          serverTime: Date.now()
        });
      } catch (publicationError) {
        logger.warn(
          {
            err: publicationError,
            playerId: state.playerId,
            nodeId: error.details.nodeId
          },
          "authoritative harvest removal publication failed"
        );
      }
    };
    switch (message.type) {
      case "CLAIM_MINE": {
        requireHello(state.playerId);
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        if (!repeatableResources) {
          safeSendServerMessage(socket, { type: "ERROR", requestId: message.requestId, code: "MINES_UNAVAILABLE", message: "Mines are unavailable." });
          return;
        }
        try {
          const player = gameState.getPlayer(state.playerId);
          if (!player) throw new RepeatableResourceError("HARVEST_PLAYER_UNAVAILABLE", "Player is not connected.");
          const result = await repeatableResources.claimMine(
            collectiblePlayerFromRecord(player), message.nodeId, message.requestId,
            message.expectedAuthorityRevision
          );
          safeSendServerMessage(socket, {
            type: "MINE_CLAIMED", requestId: message.requestId, node: result.node,
            inventory: result.inventory, replayed: result.replayed,
            message: "Mine claimed. It is private until you make it public in Tolls.", serverTime: Date.now()
          });
          if (!result.replayed) {
            await Promise.all(
              gameState.playerIdsWhoseGameplayViewCircleContains(result.node)
                .filter((recipientId) => recipientId !== state.playerId)
                .map((recipientId) => sendCollectiblesForPlayer(gameState.getPlayer(recipientId)))
            );
          }
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR", requestId: message.requestId,
            code: harvestErrorCode(error, "MINE_CLAIM_FAILED"),
            message: harvestErrorMessage(error, "Mine could not be claimed.")
          });
        }
        return;
      }
      case "REQUEST_NEARBY_COLLECTIBLES": {
        requireHello(state.playerId);
        if (!(await awaitCommittedPlayerWorldTransition(message.requestId))) {
          rejectDuringPlayerWorldTransition(message.requestId);
          return;
        }
        if (!collectibles && (!droppedItems || !sendDroppedItemsForPlayer)) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "COLLECTIBLES_UNAVAILABLE",
              message: "collectibles service is unavailable"
            });
          return;
        }
        const refreshes = [
          ...(collectibles
            ? [sendCollectiblesForPlayer(gameState.getPlayer(state.playerId))]
            : []),
          ...(droppedItems && sendDroppedItemsForPlayer
            ? [sendDroppedItemsForPlayer(state.playerId)]
            : [])
        ];
        const outcomes = await Promise.allSettled(refreshes);
        if (outcomes.length > 0 && outcomes.every(({ status }) => status === "rejected")) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "COLLECTIBLES_REFRESH_FAILED",
              message: "nearby world state refresh failed"
            });
        }
        return;
      }
      case "SURVEY_AREA": {
        requireHello(state.playerId);
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        if (!collectibles) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "COLLECTIBLES_UNAVAILABLE",
              message: "collectibles service is unavailable"
            });
          return;
        }
        try {
          await sendCollectiblesForPlayer(gameState.getPlayer(state.playerId));
        } catch {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "COLLECTIBLES_REFRESH_FAILED",
              message: "collectibles refresh failed"
            });
        }
        return;
      }
      case "START_HARVEST": {
        requireHello(state.playerId);
        if (rejectStaleHarvestAuthority(message.requestId)) return;
        if (await dungeonHarvestFlow.start(message)) return;
        if (!(await awaitCommittedPlayerWorldTransition(message.requestId))) {
          const preparingPlayer = gameState.getPlayer(state.playerId);
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: "HARVEST_AUTHORITY_PREPARING",
            message: "Gathering cannot begin until relocation authority settles.",
            retryable: true,
            details: {
              nodeId: message.nodeId,
              relocationRevision: preparingPlayer?.relocationRevision ?? 0,
              resourceVisionRevision:
                gameState.getResourceVisionRevision(state.playerId),
              gameplayViewGeneration:
                gameState.getGameplayViewCircle(state.playerId)?.generation ?? 0,
              reconciliation: "refresh-node"
            }
          });
          return;
        }
        if (!harvestSessions && !repeatableResources) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "HARVEST_UNAVAILABLE",
              message: "harvest session service is unavailable"
            });
          return;
        }
        const player = gameState.getPlayer(state.playerId);
        if (!player) {
          throw new Error("player is not connected");
        }
        const currentRelocationRevision = player.relocationRevision ?? 0;
        const currentResourceVisionRevision =
          gameState.getResourceVisionRevision(player.playerId);
        const currentGameplayViewGeneration =
          gameState.getGameplayViewCircle(player.playerId)?.generation ?? 0;
        if (
          message.expectedRelocationRevision !== currentRelocationRevision ||
          message.expectedResourceVisionRevision !==
            currentResourceVisionRevision ||
          message.expectedGameplayViewGeneration !==
            currentGameplayViewGeneration
        ) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: "HARVEST_VIEW_EPOCH_CHANGED",
            message: "The nearby world changed before gathering began.",
            details: {
              nodeId: message.nodeId,
              relocationRevision: currentRelocationRevision,
              resourceVisionRevision: currentResourceVisionRevision,
              gameplayViewGeneration: currentGameplayViewGeneration,
              reconciliation: "refresh-node"
            }
          });
          await refreshCollectiblesAfterHarvestRejection();
          return;
        }
        try {
          const repeatableNode =
            Boolean(repeatableResources) &&
            await repeatableResources!.hasNode(message.nodeId);
          const presentationOwner = repeatableNode
            ? "repeatable-resource"
            : "population";
          if (message.expectedPresentationOwner !== presentationOwner) {
            safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "HARVEST_PRESENTATION_OWNER_CHANGED",
              message: "The resource authority changed before gathering began.",
              details: {
                nodeId: message.nodeId,
                presentationOwner,
                reconciliation: "refresh-node"
              }
            });
            await refreshCollectiblesAfterHarvestRejection();
            return;
          }
          if (repeatableResources && repeatableNode) {
            if (await harvestSessions?.activeSessionForPlayer(player.playerId)) {
              throw new RepeatableResourceError("HARVEST_ALREADY_ACTIVE", "Player already has an active gathering action");
            }
            const activeMining =
              await repeatableResources.activeSessionForPlayer(player.playerId);
            if (activeMining) {
              publishGatheringStart(player.playerId, activeMining, "mine", null);
              safeSendServerMessage(socket, {
                type: "HARVEST_STARTED",
                requestId: "resume",
                session: activeMining,
                serverTime: Date.now()
              });
              return;
            }
            if (combat && !combat.isPlayerAlive(player.playerId)) {
              throw new RepeatableResourceError("HARVEST_PLAYER_UNAVAILABLE", "Unable to mine while defeated");
            }
            const result = await repeatableResources.startMining(
              collectiblePlayerFromRecord(player),
              message.nodeId,
              gameState.getResourceVision(player.playerId),
              message.expectedEntityRevision,
              equipment?.runtimeSnapshot(player.playerId)?.derivedStats
                .actionDurationMultiplier ?? 1,
              equipment?.runtimeSnapshot(player.playerId)?.derivedStats
                .miningDurationMultiplier ?? 1,
              equipment?.runtimeSnapshot(player.playerId)?.derivedStats
                .ringBonuses?.fleet_miner ?? 0,
              wornUtilityGlove(equipment?.runtimeSnapshot(player.playerId))
            );
            publishGatheringStart(player.playerId, result.session, "mine", result.nodePosition ?? null);
            safeSendServerMessage(socket, {
              type: "HARVEST_STARTED",
              requestId: message.requestId,
              session: result.session,
              serverTime: Date.now()
            });
            recordHarvest("harvest_started", {
              operationId: message.requestId,
              targetId: message.nodeId
            });
            return;
          }
          if (!harvestSessions) {
            throw new Error("Harvest session service is unavailable");
          }
          const activeMining =
            await repeatableResources?.activeSessionForPlayer(player.playerId);
          if (activeMining) {
            publishGatheringStart(player.playerId, activeMining, "mine", null);
            safeSendServerMessage(socket, {
              type: "HARVEST_STARTED",
              requestId: "resume",
              session: activeMining,
              serverTime: Date.now()
            });
            return;
          }
          if (combat && !combat.isPlayerAlive(player.playerId)) {
            throw new RepeatableResourceError("HARVEST_PLAYER_UNAVAILABLE", "Unable to gather while defeated");
          }
          const result = await harvestSessions.startHarvest(
            collectiblePlayerFromRecord(player),
            message.nodeId,
            gameState.getResourceVision(player.playerId),
            message.action ?? "primary",
            message.expectedEntityRevision,
            equipment?.runtimeSnapshot(player.playerId)?.derivedStats
              .actionDurationMultiplier ?? 1,
            equipment?.runtimeSnapshot(player.playerId)?.derivedStats
              .choppingDurationMultiplier ?? 1,
            equipment?.runtimeSnapshot(player.playerId)?.derivedStats
              .ringBonuses?.fleet_chopper ?? 0,
            equipment?.runtimeSnapshot(player.playerId)?.derivedStats
              .ringBonuses?.fleet_miner ?? 0,
            wornUtilityGlove(equipment?.runtimeSnapshot(player.playerId))
          );
          publishGatheringStart(
            player.playerId,
            result.session,
            message.action === "resin" ? "resin" : "collectible",
            result.nodePosition ?? null
          );
          if (!result.replayed) {
            // Guarded orchards: harvesting without Hollin Lore rank 2 angers that hut's Hollins.
            void hollinHuts?.onOrchardHarvestStart(player.playerId, message.nodeId).catch((error: unknown) => {
              logger.warn({ err: error, playerId: player.playerId }, "Hollin orchard anger failed");
            });
            // Greed: chopping any tree within sight of a Hollin Hut angers its Hollins (Hollin Lore 2 exempt).
            if (
              result.session.resourceType === "wood" ||
              result.session.resourceType === "giving_berry" ||
              result.session.resourceType === "balsam_resin"
            ) {
              void hollinHuts?.onTreeChopStart(player.playerId, player.position, message.nodeId).catch((error: unknown) => {
                logger.warn({ err: error, playerId: player.playerId }, "Hollin tree-chop anger failed");
              });
            }
          }
          safeSendServerMessage(socket, {
              type: "HARVEST_STARTED",
              requestId: message.requestId,
              session: result.session,
              serverTime: Date.now()
            });
          recordHarvest("harvest_started", {
            operationId: message.requestId,
            targetId: message.nodeId
          });
        } catch (error) {
          const code = harvestErrorCode(error, "HARVEST_INTERNAL_FAILURE");
          logger.info({
            playerId: state.playerId,
            requestId: message.requestId,
            nodeId: message.nodeId,
            code
          }, "harvest request rejected");
          if (
            !(error instanceof HarvestSessionError) &&
            !(error instanceof RepeatableResourceError) &&
            !(error instanceof CollectibleHarvestError)
          ) {
            logger.warn(
              { err: error, playerId: state.playerId, requestId: message.requestId },
              "internal harvest start failure"
            );
          }
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code,
              message: harvestErrorMessage(error, "Gathering could not begin."),
              details: harvestErrorDetails(error, { nodeId: message.nodeId })
            });
          broadcastAuthoritativeHarvestRemoval(error);
          await refreshCollectiblesAfterHarvestRejection();
          logger.info({
            playerId: state.playerId,
            requestId: message.requestId,
            code
          }, "harvest reconciliation snapshot requested");
          recordHarvest("harvest_start_rejected", {
            operationId: message.requestId,
            targetId: message.nodeId,
            rejectionCode: code
          });
        }
        return;
      }
      case "COMPLETE_HARVEST": {
        requireHello(state.playerId);
        if (rejectStaleHarvestAuthority(message.requestId)) return;
        if (await dungeonHarvestFlow.complete(message)) return;
        if (rejectWorldHarvestInsideDungeon(message.requestId)) return;
        if (rejectDuringPlayerWorldTransition(message.requestId, {
            code: "HARVEST_PLAYER_WORLD_TRANSITION",
            message: "Gathering cannot finish while relocation authority is changing."
          })) return;
        if (!harvestSessions) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "HARVEST_UNAVAILABLE",
              message: "harvest session service is unavailable"
            });
          return;
        }
        const player = gameState.getPlayer(state.playerId);
        if (!player) {
          throw new Error("player is not connected");
        }
        let repeatableMiningSession = false;
        try {
          repeatableMiningSession = Boolean(
            repeatableResources &&
            await repeatableResources.hasSession(message.sessionId)
          );
          if (repeatableResources && repeatableMiningSession) {
            if (combat && !combat.isPlayerAlive(player.playerId)) {
              throw new RepeatableResourceError("HARVEST_PLAYER_UNAVAILABLE", "Unable to finish mining while defeated");
            }
            const result = await repeatableResources.completeMining(
              collectiblePlayerFromRecord(player),
              message.sessionId,
              gameState.getResourceVision(player.playerId)
            );
            gameState.setGatheringActivity(player.playerId, null);
            const completionPublication = registry.send(state.playerId, {
              type: "REPEATABLE_RESOURCE_HARVESTED",
              requestId: message.requestId,
              node: result.node,
              playerId: state.playerId,
              inventory: result.inventory,
              replayed: result.replayed,
              professionResults: result.professionResults,
              tollGold: result.tollGold,
              walletGold: result.walletGold,
              walletRevision: result.walletRevision,
              serverTime: Date.now()
            });
            logger.debug({
              playerId: state.playerId,
              requestId: message.requestId,
              sessionId: message.sessionId,
              nodeId: result.node.id,
              operationKey: result.session.operationKey,
              replayed: result.replayed,
              completionPublication,
              diagnostics: result.diagnostics
            }, "mining completion committed");
            if (completionPublication !== "sent") {
              logger.warn({
                playerId: state.playerId,
                requestId: message.requestId,
                sessionId: message.sessionId,
                nodeId: result.node.id,
                operationKey: result.session.operationKey,
                replayed: result.replayed,
                inventoryRevision: result.inventory.revision,
                completionPublication,
                connectionId: state.connectionId,
                connectionGeneration: state.connectionGeneration,
                currentConnectionId:
                  registry.activeConnectionIdForPlayer(state.playerId)
              }, "mining-reward-committed-publication-failed");
              await runPostCommitHarvestStep(
                "mining-completion-resync",
                () => sendCollectiblesForPlayer(player)
              );
            }
            if ((result.droppedItems?.length ?? 0) > 0) {
              await runPostCommitHarvestStep(
                "mining-overflow-publication",
                () => broadcastDroppedItems(result.droppedItems.map(({ lat, lon }) => ({ lat, lon })))
              );
            }
            if (result.masteryGrant) {
              registry.send(state.playerId, { type: "MASTERY_SNAPSHOT", masteries: result.masteryGrant.snapshot });
            }
            if (!result.replayed) {
              registry.send(state.playerId, {
                type: "RESOURCE_GAINED",
                playerId: state.playerId,
                gain: {
                  eventId: result.session.operationKey,
                  itemId: result.node.yieldItemId,
                  quantity: result.rewardQuantity
                },
                serverTime: Date.now()
              });
              await runPostCommitHarvestStep(
                "mining-nearby-personalized-snapshots",
                () => Promise.all(
                  gameState
                    .playerIdsWhoseGameplayViewCircleContains(result.node)
                    .filter((recipientId) => recipientId !== state.playerId)
                    .map((recipientId) =>
                      sendCollectiblesForPlayer(
                        gameState.getPlayer(recipientId)
                      )
                    )
                )
              );
            }
            recordHarvest("harvest_completed", {
              operationId: result.session.operationKey,
              targetId: result.node.id,
              itemId: result.node.yieldItemId,
              quantity: result.node.yieldQuantity,
              replayed: result.replayed
            });
            return;
          }
          if (combat && !combat.isPlayerAlive(player.playerId)) {
            throw new RepeatableResourceError("HARVEST_PLAYER_UNAVAILABLE", "Unable to finish gathering while defeated");
          }
          const result = await harvestSessions.completeHarvest(
            collectiblePlayerFromRecord(player),
            message.sessionId,
            gameState.getResourceVision(player.playerId)
          );
          gameState.setGatheringActivity(player.playerId, null);
          // Tactics grows with every tree chopped.
          if (!result.replayed && result.reward.itemId === "wood") combat?.recordTreeChopped(player.playerId);
          if (result.nodeRemoved && result.reward.itemId === "wood" && isPlayerTreeNodeId(result.nodeId)) {
            await runPostCommitHarvestStep("player-tree-aura-removal", () => onPlayerTreeChopped?.(result.nodeId));
          } else if (result.nodeRemoved && result.reward.itemId === "wood") {
            await runPostCommitHarvestStep("runtime-tree-eviction", () => {
              if (!result.populationTreeTransition) {
                if (result.replayed) return;
                throw new Error(
                  "completed Population V2 tree harvest has no authoritative transition"
                );
              }
              removeHarvestedTree(result.populationTreeTransition);
            });
          }
          if (
            !result.replayed &&
            result.nodeRemoved &&
            result.populationTreeTransition &&
            xoralEvents
          ) {
            await runPostCommitHarvestStep("xoral-spawn-roll", async () => {
              const combatPlayer = combat?.entity(player.playerId);
              await xoralEvents.maybeSpawnAfterTreeHarvest({
                playerId: player.playerId,
                transition: result.populationTreeTransition!,
                regionCode: player.regionCode,
                combatZoneId: combatPlayer?.zoneId ?? `world:${player.regionCode}`
              });
            });
          }
          await runPostCommitHarvestStep("completion-publication", () => {
            safeSendServerMessage(
              socket,
              {
                type: "HARVEST_COMPLETED",
                requestId: message.requestId,
                session: result.session,
                nodeId: result.nodeId,
                playerId: player.playerId,
                inventory: result.inventory,
                ...(result.node ? { node: result.node } : {}),
                nodeRemoved: result.nodeRemoved,
                replayed: result.replayed,
                professionResults: result.professionResults,
                serverTime: Date.now()
              },
              logger,
              {
                playerId: player.playerId,
                operationType: "harvest-completion-publication"
              }
            );
          });
          if ((result.droppedItems?.length ?? 0) > 0) {
            await runPostCommitHarvestStep(
              "harvest-overflow-publication",
              () => broadcastDroppedItems(result.droppedItems.map(({ lat, lon }) => ({ lat, lon })))
            );
          }
          if (
            result.replayed &&
            result.nodeRemoved &&
            !result.populationTreeTransition
          ) {
            await runPostCommitHarvestStep(
              "completed-replay-collectible-refresh",
              () => sendCollectiblesForPlayer(player)
            );
          }
          const refreshed =
            !result.replayed && result.xpGrant && equipment && progression
              ? await runPostCommitHarvestStep(
                  "equipment-progression-refresh",
                  () => refreshAuthoritativePlayerStats(player.playerId)
                ) ?? null
              : null;
          if (!result.replayed && result.xpGrant) {
            const grant = refreshed !== null
              ? { ...result.xpGrant, progression: refreshed.progression }
              : result.xpGrant;
            await runPostCommitHarvestStep("xp-publication", () => {
              sendXpGrant(socket, grant);
            });
            if (refreshed !== null) {
              await runPostCommitHarvestStep("equipment-publication", () => {
                registry.send(player.playerId, {
                  type: "EQUIPMENT_SNAPSHOT",
                  equipment: refreshed.equipment
                });
              });
            }
          }
          if (!result.replayed && result.masteryGrant) {
            await runPostCommitHarvestStep("mastery-publication", () => {
              registry.send(player.playerId, {
                type: "MASTERY_SNAPSHOT",
                masteries: result.masteryGrant!.snapshot
              });
            });
          }
          if (!result.replayed) {
            await runPostCommitHarvestStep("resource-gain-publication", () => {
              registry.send(player.playerId, {
                type: "RESOURCE_GAINED",
                playerId: player.playerId,
                gain: {
                  eventId: `harvest:${result.session.sessionId}`,
                  itemId: result.reward.itemId,
                  quantity: result.reward.quantity
                },
                serverTime: Date.now()
              });
            });
            const nodePosition =
              result.nodePosition ?? result.populationTreeTransition?.position;
            if (result.nodeRemoved) {
              await runPostCommitHarvestStep("tree-removal-publication", () => {
                if (!nodePosition) {
                  throw new Error(
                    "completed Population V2 tree harvest has no node position"
                  );
                }
                sendToGameplayCirclesContaining(nodePosition, {
                  type: "COLLECTIBLE_REMOVED",
                  nodeId: result.nodeId,
                  playerId: player.playerId,
                  ...(result.node?.treeLifeRevision === undefined
                    ? {}
                    : { stateRevision: result.node.treeLifeRevision }),
                  serverTime: Date.now()
                });
              });
            } else if (result.node) {
              await runPostCommitHarvestStep("collectible-update-publication", () => {
                if (!nodePosition) {
                  throw new Error("completed resource harvest has no node position");
                }
                sendToGameplayCirclesContaining(nodePosition, {
                  type: "COLLECTIBLE_UPDATED",
                  node: result.node!,
                  playerId: player.playerId,
                  serverTime: Date.now()
                });
              });
            }
          }
          await runPostCommitHarvestStep("collectible-snapshot-refresh", () =>
            sendCollectiblesForPlayer(player)
          );
          await runPostCommitHarvestStep("telemetry-publication", () => {
            recordHarvest("harvest_completed", {
              operationId: result.session.operationKey,
              targetId: result.nodeId,
              itemId: result.reward.itemId,
              quantity: result.reward.quantity,
              replayed: result.replayed
            });
          });
        } catch (error) {
          const code = harvestErrorCode(error, "HARVEST_INTERNAL_FAILURE");
          let terminalCleanup:
            | RepeatableTerminalCleanupResult
            | undefined;
          if (
            repeatableMiningSession &&
            repeatableResources &&
            error instanceof RepeatableResourceError &&
            (
              repeatableCompletionFailureDisposition(error.code) ===
                "terminal-cancelled" ||
              repeatableCompletionFailureDisposition(error.code) ===
                "terminal-expired"
            )
          ) {
            try {
              terminalCleanup =
                await repeatableResources
                  .terminateActiveSessionAfterTerminalFailure(
                    player.playerId,
                    message.sessionId,
                    error.code
                  );
              logger.info({
                playerId: player.playerId,
                sessionId: message.sessionId,
                nodeId:
                  terminalCleanup.nodeId ?? error.details.nodeId ?? null,
                code: error.code,
                sessionStatusBeforeCleanup: terminalCleanup.statusBefore,
                sessionStatusAfterCleanup: terminalCleanup.statusAfter,
                cleanupOutcome: terminalCleanup.outcome,
                populationV2StateRevision:
                  error.details.populationV2StateRevision,
                authoritativeDistanceM:
                  error.details.authoritativeDistanceM,
                resourceVisionRevision:
                  gameState.getResourceVisionRevision(player.playerId)
              }, "terminal mining completion rejected and reconciled");
            } catch (cleanupError) {
              logger.warn({
                err: cleanupError,
                playerId: player.playerId,
                sessionId: message.sessionId,
                nodeId: error.details.nodeId ?? null,
                code: error.code,
                populationV2StateRevision:
                  error.details.populationV2StateRevision,
                authoritativeDistanceM:
                  error.details.authoritativeDistanceM,
                resourceVisionRevision:
                  gameState.getResourceVisionRevision(player.playerId)
              }, "terminal mining completion cleanup failed");
            }
          }
          logger.info({
            playerId: state.playerId,
            requestId: message.requestId,
            sessionId: message.sessionId,
            code,
            details: harvestErrorDetails(
              error,
              {
                sessionId: message.sessionId,
                resourceVisionRevision:
                  gameState.getResourceVisionRevision(player.playerId)
              },
              terminalCleanup
            )
          }, "harvest request rejected");
          if (
            !(error instanceof HarvestSessionError) &&
            !(error instanceof RepeatableResourceError) &&
            !(error instanceof CollectibleHarvestError)
          ) {
            logger.warn(
              { err: error, playerId: state.playerId, requestId: message.requestId },
              "internal harvest completion failure"
            );
          }
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code,
              message: harvestErrorMessage(error, "Gathering could not be completed."),
              details: harvestErrorDetails(
                error,
                {
                  sessionId: message.sessionId,
                  resourceVisionRevision:
                    gameState.getResourceVisionRevision(player.playerId)
                },
                terminalCleanup
              )
            });
          broadcastAuthoritativeHarvestRemoval(error);
          await refreshCollectiblesAfterHarvestRejection();
          logger.info({
            playerId: state.playerId,
            requestId: message.requestId,
            code
          }, "harvest reconciliation snapshot requested");
          recordHarvest("harvest_completion_rejected", {
            operationId: message.requestId,
            targetId: message.sessionId,
            rejectionCode: code
          });
        }
        return;
      }
      case "USE_CONSUMABLE": {
        requireHello(state.playerId);
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        if (message.itemId === "simple_food") {
          if (!simpleFood) {
            safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "CONSUMABLE_UNAVAILABLE",
              message: "Simple Food is unavailable."
            });
            return;
          }
          if (combat && !combat.isPlayerAlive(state.playerId)) {
            safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "CONSUMABLE_PLAYER_UNAVAILABLE",
              message: "Simple Food cannot be used while defeated."
            });
            return;
          }
          try {
            const result = await runDroppedItemAuthority(state.playerId, () =>
              simpleFood.consume(state.playerId!, message.requestId, message.stackId)
            );
            gameState.setPlayerHunger(
              state.playerId,
              result.hunger.current,
              result.hunger.baseCapacity
            );
            safeSendServerMessage(socket, {
              type: "SIMPLE_FOOD_CONSUMED",
              requestId: message.requestId,
              itemId: "simple_food",
              playerId: state.playerId,
              inventory: result.inventory,
              hunger: result.hunger,
              restoredQuantity: result.restoredQuantity,
              replayed: result.replayed,
              serverTime: Date.now(),
              message: result.replayed
                ? "Simple Food consumption already applied."
                : `Restored ${result.restoredQuantity} Hunger.`
            });
          } catch (error) {
            safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: error instanceof SimpleFoodError
                ? error.code
                : "CONSUMABLE_USE_REJECTED",
              message: error instanceof SimpleFoodError
                ? error.message
                : "Simple Food could not be used."
            });
          }
          return;
        }
        if (isFieldConsumableUse(message.itemId)) {
          await useFieldConsumable(fieldConsumableContext(state.playerId), {
            requestId: message.requestId,
            itemId: message.itemId,
            stackId: message.stackId,
            targetEntityId: message.targetEntityId
          });
          return;
        }
        if (message.itemId !== "giving_berry") {
          safeSendServerMessage(socket, {
            type: "ERROR", requestId: message.requestId,
            code: "CONSUMABLE_USE_REJECTED", message: "That item cannot be consumed."
          });
          return;
        }
        if (!balsamResin || !combat) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: "CONSUMABLE_UNAVAILABLE",
            message: "Giving Berry is unavailable."
          });
          return;
        }
        if (!combat.isPlayerAlive(state.playerId)) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: "CONSUMABLE_PLAYER_UNAVAILABLE",
            message: "Giving Berry cannot be used while defeated."
          });
          return;
        }
        const playerCombat = combat.entity(state.playerId);
        try {
          const result = await balsamResin.consume(
            state.playerId,
            message.requestId,
            message.stackId,
            {
              atFullHealth: playerCombat !== null &&
                playerCombat.currentHealth >= playerCombat.maxHealth
            }
          );
          combat.stageBalsamResinEffect(result.effect, {
            fresh: !result.replayed
          });
          safeSendServerMessage(socket, {
            type: "CONSUMABLE_USED",
            requestId: message.requestId,
            itemId: message.itemId,
            playerId: state.playerId,
            inventory: result.inventory,
            effect: result.effect,
            replayed: result.replayed,
            serverTime: Date.now(),
            message: result.replayed
              ? "Giving Berry remains active."
              : "Giving Berry restores 3 health now and every 1.4 seconds."
          });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof BalsamResinError
              ? error.code
              : "CONSUMABLE_USE_REJECTED",
            message: error instanceof BalsamResinError
              ? error.message
              : "Giving Berry could not be used."
          });
        }
        return;
      }
      case "CRAFT_FIELD_CONSUMABLE": {
        requireHello(state.playerId);
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        await craftFieldConsumable(fieldConsumableContext(state.playerId), message);
        return;
      }
      case "REQUEST_WATER_SITES":
      case "DIVE_PEARL_BED":
      case "ENTER_WHIRLPOOL":
      case "PRESENT_ABYSSAL_ORBS": {
        requireHello(state.playerId);
        if (message.type !== "REQUEST_WATER_SITES" && rejectDuringPlayerWorldTransition(message.requestId)) return;
        await handleWaterSiteMessage({
          playerId: state.playerId,
          socket,
          logger,
          gameState,
          waterSites: context.waterSites,
          travelThroughWhirlpool: context.travelThroughWhirlpool,
          inventorySnapshot: async (playerId) => {
            if (!inventory) throw new Error("inventory unavailable");
            return inventory.getInventorySnapshot(playerId);
          },
          safeSendServerMessage
        }, message);
        return;
      }
      case "SPLIT_INVENTORY_STACK":
      case "RESTACK_INVENTORY_STACK":
      case "MOVE_INVENTORY_STACK":
      case "REORGANIZE_INVENTORY": {
        requireHello(state.playerId);
        safeSendServerMessage(socket, {
          type: "ERROR",
          requestId: message.requestId,
          code: "INVENTORY_GRID_ACTION_RETIRED",
          message: "Inventory uses quantity balances. Refresh to use the current inventory."
        });
        return;
      }
      case "CANCEL_HARVEST": {
        requireHello(state.playerId);
        if (rejectStaleHarvestAuthority(message.requestId)) return;
        if (dungeonHarvestFlow.cancel(message)) return;
        if (rejectWorldHarvestInsideDungeon(message.requestId)) return;
        if (!harvestSessions) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "HARVEST_UNAVAILABLE",
              message: "harvest session service is unavailable"
            });
          return;
        }
        try {
          const result = repeatableResources && await repeatableResources.hasSession(message.sessionId)
            ? await repeatableResources.cancelMining(state.playerId, message.sessionId)
            : await harvestSessions.cancelHarvest(state.playerId, message.sessionId);
          if (result === null) return;
          gameState.setGatheringActivity(state.playerId!, null);
          safeSendServerMessage(socket, {
              type: "HARVEST_CANCELLED",
            requestId: message.requestId,
              session: result.session,
            serverTime: Date.now()
            });
        } catch (error) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: harvestErrorCode(error, "HARVEST_CANCEL_REJECTED"),
              message: harvestErrorMessage(error, "harvest cancellation rejected")
            });
        }
        return;
      }
      case "UPDATE_MATERIAL_KEEP":
      case "UPDATE_UNIQUE_ITEM_PROTECTION": {
        requireHello(state.playerId);
        if (!inventoryProtection) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: "INVENTORY_PROTECTION_UNAVAILABLE",
            message: "Inventory protection is unavailable."
          });
          return;
        }
        try {
          const result = message.type === "UPDATE_MATERIAL_KEEP"
            ? await inventoryProtection.setMaterialKeep({
                playerId: state.playerId,
                requestId: message.requestId,
                itemId: message.itemId,
                variant: message.variant,
                keepQuantity: message.keepQuantity,
                expectedRevision: message.expectedRevision
              })
            : await inventoryProtection.setUniqueProtection({
                playerId: state.playerId,
                requestId: message.requestId,
                equipmentInstanceId: message.equipmentInstanceId,
                protected: message.protected,
                expectedRevision: message.expectedRevision
              });
          safeSendServerMessage(socket, {
            type: "INVENTORY_PROTECTION_UPDATED",
            requestId: message.requestId,
            protection: result.protection,
            replayed: result.replayed,
            message: result.message
          });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof InventoryProtectionError
              ? error.code
              : "INVENTORY_PROTECTION_REJECTED",
            message: error instanceof Error
              ? error.message
              : "Inventory protection update rejected."
          });
          try {
            safeSendServerMessage(socket, {
              type: "INVENTORY_PROTECTION_SNAPSHOT",
              protection: await inventoryProtection.snapshot(state.playerId)
            });
          } catch {
            // Preserve the original authoritative rejection.
          }
        }
        return;
      }
      case "DROP_EQUIPMENT": {
        requireHello(state.playerId);
        if (!droppedItems || !equipment) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: "DROP_SERVICE_UNAVAILABLE",
            message: "equipment drop service is unavailable"
          });
          return;
        }
        const dropPlayerId = state.playerId;
        const dropConnectionId = state.connectionId;
        try {
          const committed = await runDroppedItemAuthority(dropPlayerId, async () => {
            if (!isCurrentConnection(dropPlayerId)) return null;
            if (rejectDuringPlayerWorldTransition(message.requestId)) return null;
            const manorSession = manorRuntime?.get(dropPlayerId);
            if (manorSession) {
              const player = currentManorDroppedItemActor(message.manorSessionId);
              if (!player || !isCurrentConnection(dropPlayerId)) return null;
              if (manorSession.accessSource !== "OWNER") {
                throw new DroppedItemError(
                  "DROP_EQUIPMENT_NOT_ELIGIBLE",
                  "Only the manor owner may drop equipment here"
                );
              }
              const result = await droppedItems.dropManorEquipment(dropPlayerId, {
                requestId: message.requestId,
                equipmentInstanceId: message.equipmentInstanceId,
                expectedEquipmentRevision: message.expectedEquipmentRevision,
                manorId: manorSession.manorId,
                spaceId: manorSession.spaceId,
                position: {
                  x: manorSession.position.x,
                  y: manorSession.position.y
                }
              });
              return { kind: "manor" as const, player, result };
            }
            const player = await currentWorldDroppedItemActor();
            if (!player || !isCurrentConnection(dropPlayerId)) return null;
            const result = await droppedItems.dropEquipment(player, {
              requestId: message.requestId,
              equipmentInstanceId: message.equipmentInstanceId,
              expectedEquipmentRevision: message.expectedEquipmentRevision
            });
            return { kind: "world" as const, player, result };
          });
          if (!committed) return;
          const { player, result } = committed;
          const equipmentSnapshot = await equipment.refreshInventorySlots(dropPlayerId);
          const itemName = requireEquipmentDefinition(result.drop.itemId).displayName;
          if (isCurrentConnection(dropPlayerId)) safeSendServerMessage(socket, {
            type: "EQUIPMENT_DROP_RESULT",
            requestId: message.requestId,
            drop: result.drop,
            equipment: equipmentSnapshot,
            replayed: result.replayed,
            serverTime: Date.now(),
            message: `Dropped ${itemName}.`
          });
          logger.info({
            playerId: player.playerId,
            dropId: result.drop.dropId,
            equipmentInstanceId: result.drop.equipmentInstanceId,
            itemId: result.drop.itemId,
            replayed: result.replayed
          }, "equipment dropped");
          if (!isCurrentConnection(dropPlayerId)) {
            await refreshReplacementAfterInventoryCommit(dropPlayerId, dropConnectionId);
          }
          if (committed.kind === "manor" && result.drop.manorId) {
            await broadcastManorEquipmentDrops(result.drop.manorId);
          } else {
            await broadcastDroppedItems([{ lat: result.drop.lat, lon: result.drop.lon }]);
          }
        } catch (error) {
          if (isCurrentConnection(dropPlayerId)) safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: droppedItemErrorCode(error, "DROP_EQUIPMENT_REJECTED"),
            message: droppedItemErrorMessage(error, "equipment drop rejected")
          });
        }
        return;
      }
      case "DROP_ITEM": {
        requireHello(state.playerId);
        if (!droppedItems) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "DROP_SERVICE_UNAVAILABLE",
              message: "item drop service is unavailable"
            });
          return;
        }
        const dropPlayerId = state.playerId;
        const dropConnectionId = state.connectionId;
        try {
          const committed = await runDroppedItemAuthority(dropPlayerId, async () => {
            if (!isCurrentConnection(dropPlayerId)) return null;
            if (rejectDuringPlayerWorldTransition(message.requestId)) return null;
            const manorSession = manorRuntime?.get(dropPlayerId);
            const player = manorSession
              ? currentManorDroppedItemActor(message.manorSessionId)
              : await currentWorldDroppedItemActor();
            if (!player || !isCurrentConnection(dropPlayerId)) return null;
            if (manorSession?.accessSource !== undefined && manorSession.accessSource !== "OWNER") {
              throw new DroppedItemError(
                "DROP_ITEM_NOT_DROPPABLE",
                "Only the manor owner may drop items here"
              );
            }
            const result = await droppedItems.dropItem(player, {
              requestId: message.requestId,
              itemId: message.itemId,
              variant: message.variant,
              quantity: message.quantity,
              ...(message.stackId ? { stackId: message.stackId } : {})
            });
            return { kind: manorSession ? "manor" as const : "world" as const, player, result };
          });
          if (!committed) return;
          const { player, result } = committed;
          const itemName = requireItemDefinition(result.drop.itemId).displayName;
          if (isCurrentConnection(dropPlayerId)) safeSendServerMessage(socket, {
              type: "ITEM_DROP_RESULT",
              requestId: message.requestId,
              drop: result.drop,
              inventory: result.inventory,
              replayed: result.replayed,
              serverTime: Date.now(),
              message: `Dropped ${itemName} x${result.drop.quantity}.`
            });
          logger.info(
            {
              playerId: player.playerId,
              dropId: result.drop.dropId,
              itemId: result.drop.itemId,
              quantity: result.drop.quantity,
              replayed: result.replayed
            },
            "inventory item dropped"
          );
          if (!isCurrentConnection(dropPlayerId)) {
            await refreshReplacementAfterInventoryCommit(dropPlayerId, dropConnectionId);
          }
          if (committed.kind === "manor" && result.drop.manorId) {
            await broadcastManorEquipmentDrops(result.drop.manorId);
          } else {
            await broadcastDroppedItems([{ lat: result.drop.lat, lon: result.drop.lon }]);
          }
        } catch (error) {
          if (isCurrentConnection(dropPlayerId)) safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: droppedItemErrorCode(error, "DROP_ITEM_REJECTED"),
              message: droppedItemErrorMessage(error, "item drop rejected")
            });
        }
        return;
      }
      case "PICKUP_DROPPED_ITEM": {
        requireHello(state.playerId);
        if (!droppedItems) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "DROPPED_ITEM_SERVICE_UNAVAILABLE",
              message: "dropped item pickup service is unavailable"
            });
          return;
        }
        const pickupPlayerId = state.playerId;
        const pickupConnectionId = state.connectionId;
        try {
          const committed = await runDroppedItemAuthority(pickupPlayerId, async () => {
            if (!isCurrentConnection(pickupPlayerId)) return null;
            if (rejectDuringPlayerWorldTransition(message.requestId)) return null;
            const manorSession = manorRuntime?.get(pickupPlayerId);
            const player = manorSession
              ? currentManorDroppedItemActor(message.manorSessionId)
              : await currentWorldDroppedItemActor();
            if (!player || !isCurrentConnection(pickupPlayerId)) return null;
            const dropKind = droppedItems.resolveDropKind
              ? await droppedItems.resolveDropKind(message.dropId)
              : ((await droppedItems.isEquipmentDrop(message.dropId))
                ? "equipment" as const
                : "item" as const);
            if (dropKind === "equipment") {
              if (!equipment) {
                throw new DroppedItemError(
                  "DROPPED_ITEM_NOT_ACTIVE",
                  "equipment service is unavailable"
                );
              }
              if (manorSession?.accessSource !== undefined && manorSession.accessSource !== "OWNER") {
                throw new DroppedItemError(
                  "DROP_EQUIPMENT_NOT_ELIGIBLE",
                  "Only the manor owner may pick up Manor equipment"
                );
              }
              return {
                kind: "equipment" as const,
                player,
                result: await droppedItems.pickupDroppedEquipment(
                  player,
                  message.requestId,
                  message.dropId
                )
              };
            }
            if (dropKind === "backpack") {
              if (manorSession?.accessSource !== undefined && manorSession.accessSource !== "OWNER") {
                throw new DroppedItemError(
                  "DROPPED_ITEM_OUT_OF_RANGE",
                  "Only the manor owner may pick up Manor backpacks"
                );
              }
              return {
                kind: "backpack" as const,
                player,
                result: await droppedItems.pickupDroppedBackpack(
                  player,
                  message.requestId,
                  message.dropId
                )
              };
            }
            if (manorSession?.accessSource !== undefined && manorSession.accessSource !== "OWNER") {
              throw new DroppedItemError(
                "DROPPED_ITEM_OUT_OF_RANGE",
                "Only the manor owner may pick up floor items"
              );
            }
            return {
              kind: "item" as const,
              player,
              result: await droppedItems.pickupDroppedItem(
                player,
                message.requestId,
                message.dropId,
                message.pickup
              )
            };
          });
          if (!committed) return;
          if (committed.kind === "equipment") {
            const equipmentSnapshot = await equipment!.refreshInventorySlots(pickupPlayerId);
            const itemName = requireEquipmentDefinition(committed.result.drop.itemId).displayName;
            if (isCurrentConnection(pickupPlayerId)) safeSendServerMessage(socket, {
              type: "DROPPED_EQUIPMENT_PICKUP_RESULT",
              requestId: message.requestId,
              itemId: committed.result.drop.itemId,
              drop: committed.result.drop,
              equipment: equipmentSnapshot,
              replayed: committed.result.replayed,
              serverTime: Date.now(),
              message: `Picked up ${itemName}.`
            });
            logger.info({
              playerId: committed.player.playerId,
              dropId: committed.result.drop.dropId,
              equipmentInstanceId: committed.result.drop.equipmentInstanceId,
              itemId: committed.result.drop.itemId,
              replayed: committed.result.replayed
            }, "dropped equipment picked up");
            if (committed.result.drop.manorId) {
              await broadcastManorEquipmentDrops(committed.result.drop.manorId);
            } else {
              await broadcastDroppedItems([{ lat: committed.result.drop.lat, lon: committed.result.drop.lon }]);
            }
            return;
          }
          if (committed.kind === "backpack") {
            const itemName = committed.result.drop.backpack.displayName ||
              requireBackpackDefinition(committed.result.drop.itemId).displayName;
            if (isCurrentConnection(pickupPlayerId)) safeSendServerMessage(socket, {
              type: "DROPPED_BACKPACK_PICKUP_RESULT",
              requestId: message.requestId,
              itemId: committed.result.drop.itemId,
              drop: committed.result.drop,
              backpacks: committed.result.backpacks,
              inventory: committed.result.inventory,
              replayed: committed.result.replayed,
              serverTime: Date.now(),
              message: `Picked up ${itemName}.`
            });
            if (committed.result.drop.manorId) {
              await broadcastManorEquipmentDrops(committed.result.drop.manorId);
            } else {
              await broadcastDroppedItems([{ lat: committed.result.drop.lat, lon: committed.result.drop.lon }]);
            }
            return;
          }
          const { player, result } = committed;
          const itemName = requireItemDefinition(result.drop.itemId).displayName;
          if (isCurrentConnection(pickupPlayerId)) safeSendServerMessage(socket, {
              type: "DROPPED_ITEM_PICKUP_RESULT",
              requestId: message.requestId,
              itemId: result.drop.itemId,
              requestedQuantity: result.requestedQuantity,
              drop: result.drop,
              pickedUpQuantity: result.pickedUpQuantity,
              remainingQuantity: result.remainingQuantity,
              removed: result.removed,
              inventory: result.inventory,
              replayed: result.replayed,
              serverTime: Date.now(),
              message: `Picked up ${itemName} x${result.pickedUpQuantity}.`
            });
          logger.info(
            {
              playerId: player.playerId,
              dropId: result.drop.dropId,
              itemId: result.drop.itemId,
              quantity: result.pickedUpQuantity,
              remainingQuantity: result.remainingQuantity,
              replayed: result.replayed
            },
            "dropped item picked up"
          );
          if (!isCurrentConnection(pickupPlayerId)) {
            await refreshReplacementAfterInventoryCommit(
              pickupPlayerId,
              pickupConnectionId
            );
          }
          if (result.drop.manorId) {
            await broadcastManorEquipmentDrops(result.drop.manorId);
          } else {
            await broadcastDroppedItems([{ lat: result.drop.lat, lon: result.drop.lon }]);
          }
        } catch (error) {
          if (isCurrentConnection(pickupPlayerId)) safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: droppedItemErrorCode(error, "DROPPED_ITEM_PICKUP_REJECTED"),
              message: droppedItemErrorMessage(error, "dropped item pickup rejected"),
              ...(error instanceof DroppedItemError && error.details
                ? { details: error.details }
                : {})
            });
        }
        return;
      }
      case "COLLECT_WATER_AT_COORDINATE": {
        requireHello(state.playerId);
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        if (!collectibles) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "COLLECTIBLES_UNAVAILABLE",
              message: "collectibles service is unavailable"
            });
          return;
        }
        const player = gameState.getPlayer(state.playerId);
        if (!player) {
          throw new Error("player is not connected");
        }
        try {
          const result = await collectibles.collectWaterAt(
            collectiblePlayerFromRecord(player),
            {
              lat: message.lat,
              lon: message.lon
            },
            message.requestId
          );
          safeSendServerMessage(socket, {
              type: "WATER_COLLECTED",
              requestId: message.requestId,
              playerId: player.playerId,
              waterKind: result.waterKind,
              inventory: result.inventory,
              serverTime: Date.now(),
              message: result.message
            });
        } catch (error) {
          safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code:
                error instanceof WaterCollectionCadenceError
                  ? error.code
                  : "WATER_COLLECT_REJECTED",
              message:
                error instanceof WaterCollectionCadenceError
                  ? error.message
                  : "water collection rejected"
            });
        }
        return;
      }
    }
  };
}

export function registerHarvestingHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"harvesting">
): void {
  router.register("harvesting", handler);
}
