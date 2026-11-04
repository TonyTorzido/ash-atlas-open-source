import {
  MAX_VISIBLE_COLLECTIBLE_NODES,
  type CollectibleNode,
  type CollectibleSnapshotAuthority,
  type HarvestSessionSnapshot,
  type RepeatableResourceNode,
  type ResourceVision,
  type ResourceVisionStatus,
  type ServerMessage,
  type TravelInboxEntry,
  type WorldViewAuthority
} from "@ash-atlas/shared";
import { randomUUID } from "node:crypto";

import type { CollectibleService } from "../game/collectibles.js";
import type { SettlementService } from "../auth/trust/settlement.js";
import type { LandActionGate } from "../auth/trust/trustService.js";
import type { CombatEngine } from "../game/combat/combatEngine.js";
import type { DroppedItemService } from "../game/droppedItems.js";
import type { HarvestSessionService } from "../game/harvestSessions.js";
import type { PlayerService } from "../game/players.js";
import type { RepeatableResourceService } from "../game/repeatableResources.js";
import {
  adjacentZoneIdsForPosition,
  packageIdForPosition,
  zoneIdForPosition
} from "../game/spatialZones.js";
import type { GameState, PlayerRecord } from "../game/state.js";
import type { TravelInviteService } from "../game/travelInvites.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { AppLogger } from "../logger.js";
import type { ConnectionGenerationLedger } from "./connectionLifecycle.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";

export type CombatScopeSnapshotPublication = Readonly<{
  worldViewAuthority: WorldViewAuthority | null;
  combatSnapshotGeneration: number | null;
  combatEntityCount: number;
  mobEntityCount: number;
  expectedMobActorCount: number;
}>;

export function createRealtimeSnapshotOperations(context: Readonly<{
  logger: AppLogger;
  registry: ConnectionRegistry;
  connectionGenerations?: Pick<ConnectionGenerationLedger, "current" | "isCurrent"> | undefined;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  combat?: CombatEngine | undefined;
  collectibles?: CollectibleService | undefined;
  droppedItems?: DroppedItemService | undefined;
  harvestSessions?: HarvestSessionService | undefined;
  repeatableResources?: RepeatableResourceService | undefined;
  travelInvites?: TravelInviteService | undefined;
  playerService?: PlayerService | undefined;
  landActions?: Pick<LandActionGate, "availableAt"> | undefined;
  settlement?: Pick<SettlementService, "relocationExemptionAvailable"> | undefined;
  currentGameplayViewCircle?(playerId: string): ReturnType<GameState["getGameplayViewCircle"]>;
  currentWorldViewAuthority?(playerId: string): WorldViewAuthority | null;
}>): Readonly<{
  sendToGameplayCirclesContaining(
    position: { lat: number; lon: number },
    message: ServerMessage
  ): void;
  sendCombatScopeSnapshot(
    playerId: string,
    expectedAuthority?: WorldViewAuthority,
    presentationEligible?: boolean
  ): CombatScopeSnapshotPublication | null;
  gameplayInterestCenter(
    playerId: string,
    fallback: { lat: number; lon: number }
  ): { lat: number; lon: number };
  gameplayInterestZoneIds(
    playerId: string,
    fallback: { lat: number; lon: number }
  ): string[];
  syncCombatPlayerAfterRelocation(
    player: ReturnType<GameState["snapshotForPlayer"]>
  ): void;
  activeHarvestSessionForPlayer(playerId: string): Promise<HarvestSessionSnapshot | null>;
  sendCollectiblesForPlayer(
    player: PlayerRecord | undefined,
    isCurrent?: () => boolean
  ): Promise<void>;
  sendDroppedItemsForPlayer(
    playerId: string,
    isCurrent?: () => boolean
  ): Promise<void>;
  refreshDroppedItemsNear(
    positions: readonly Readonly<{ lat: number; lon: number }>[]
  ): Promise<void>;
  travelInboxEntriesForPlayer(playerId: string): Promise<TravelInboxEntry[]>;
  sendTravelInboxForPlayers(
    playerIds: Iterable<string>,
    isCurrent?: () => boolean
  ): Promise<void>;
  sendTravelResourceVisionReadyAndSnapshot(
    player: PlayerRecord,
    resourceVision: ResourceVision,
    resourceVisionStatus: NonNullable<
      Awaited<ReturnType<CollectibleService["resourceVisionStatus"]>>
    >,
    isCurrent?: () => boolean
  ): Promise<void>;
}> {
  const {
    logger,
    registry,
    connectionGenerations,
    gameState,
    worldRuntime,
    combat,
    collectibles,
    droppedItems,
    harvestSessions,
    repeatableResources,
    travelInvites,
    playerService,
    landActions,
    settlement,
    currentGameplayViewCircle,
    currentWorldViewAuthority
  } = context;
  let collectibleSnapshotGeneration = 0;
  let combatSnapshotGeneration = 0;

  const sendToGameplayCirclesContaining = (position: { lat: number; lon: number }, message: ServerMessage): void => {
    for (const subscribedPlayerId of gameState.playerIdsWhoseGameplayViewCircleContains(position)) {
      registry.send(subscribedPlayerId, message);
    }
  };
  const sendCombatScopeSnapshot = (
    targetPlayerId: string,
    expectedAuthority?: WorldViewAuthority,
    presentationEligible = true
  ): CombatScopeSnapshotPublication | null => {
    if (!combat || !worldRuntime) return null;
    const worldViewAuthority =
      currentWorldViewAuthority?.(targetPlayerId) ?? null;
    if (
      expectedAuthority &&
      (
        !worldViewAuthority ||
        worldViewAuthority.playerId !== expectedAuthority.playerId ||
        worldViewAuthority.connectionId !== expectedAuthority.connectionId ||
        worldViewAuthority.connectionGeneration !==
          expectedAuthority.connectionGeneration ||
        worldViewAuthority.relocationRevision !==
          expectedAuthority.relocationRevision ||
        worldViewAuthority.resourceVisionRevision !==
          expectedAuthority.resourceVisionRevision ||
        worldViewAuthority.gameplayViewGeneration !==
          expectedAuthority.gameplayViewGeneration ||
        worldViewAuthority.populationPreparationGeneration !==
          expectedAuthority.populationPreparationGeneration
      )
    ) {
      return null;
    }
    combat.requestResync(targetPlayerId);
    const interest = worldRuntime.interestFrameFor([targetPlayerId]);
    const state = combat.snapshotForPlayer(targetPlayerId, interest);
    const presentationAuthority = presentationEligible
      ? worldViewAuthority
      : null;
    const snapshotGeneration = presentationAuthority
      ? ++combatSnapshotGeneration
      : null;
    const combatEntityCount = state.upserts.filter(
      (entity) => entity.kind !== "player"
    ).length;
    const mobEntityCount = state.upserts.filter(
      (entity) => entity.kind === "mob"
    ).length;
    const expectedMobActorCount = [
      ...(interest.nearbyIdsByPlayer.get(targetPlayerId) ?? [])
    ].filter((entityId) => combat.entity(entityId)?.kind === "mob").length;
    const sendResult = registry.send(targetPlayerId, {
      type: "COMBAT_SNAPSHOT",
      state,
      ...(presentationAuthority && snapshotGeneration !== null
        ? {
            worldViewAuthority: presentationAuthority,
            combatSnapshotGeneration: snapshotGeneration
          }
        : {})
    });
    if (sendResult === "sent" && presentationAuthority) {
      worldRuntime.markMobAiPresentationAuthority(
        presentationAuthority,
        state.upserts
          .filter((entity) => entity.kind === "mob")
          .map((entity) => entity.entityId)
      );
    }
    if (expectedMobActorCount > 0 && combatEntityCount === 0) {
      logger.warn({
        playerId: targetPlayerId,
        expectedMobActorCount,
        combatEntityCount,
        mobEntityCount,
        combatSnapshotGeneration: snapshotGeneration,
        worldViewAuthority: presentationAuthority
      }, "visible destination population has mob actors but combat snapshot is empty");
    }
    return {
      worldViewAuthority: presentationAuthority,
      combatSnapshotGeneration: snapshotGeneration,
      combatEntityCount,
      mobEntityCount,
      expectedMobActorCount
    };
  };
  const gameplayInterestCenter = (
    targetPlayerId: string,
    fallback: { lat: number; lon: number }
  ): { lat: number; lon: number } =>
    gameState.getGameplayViewCircle(targetPlayerId)?.center ?? fallback;
  const gameplayInterestZoneIds = (
    targetPlayerId: string,
    fallback: { lat: number; lon: number }
  ): string[] => {
    const eligibleZoneIds = gameState.getGameplayViewCircle(targetPlayerId)?.eligibleZoneIds;
    return eligibleZoneIds ? [...eligibleZoneIds] : adjacentZoneIdsForPosition(fallback);
  };
  const syncCombatPlayerAfterRelocation = (
    player: ReturnType<GameState["snapshotForPlayer"]>
  ): void => {
    combat?.syncPlayer({
      playerId: player.playerId,
      position: { lat: player.lat, lon: player.lon },
      regionCode: player.regionCode,
      zoneId: zoneIdForPosition({ lat: player.lat, lon: player.lon }),
      name: player.username
    });
  };
  const activeHarvestSessionForPlayer = async (playerId: string) =>
    (await harvestSessions?.activeSessionForPlayer(playerId)) ??
    (await repeatableResources?.activeSessionForPlayer(playerId)) ??
    null;
  const reconcileGivingTreeSnapshot = (
    playerId: string,
    nodes: readonly Readonly<{
      id: string;
      type: string;
      state: string;
      lat: number;
      lon: number;
    }>[]
  ): void => {
    combat?.replaceGivingTreeSource(
      playerId,
      nodes
        .filter((node) => node.type === "wood" && node.state === "available")
        .map((node) => ({ id: node.id, lat: node.lat, lon: node.lon }))
    );
  };
  const sendCollectiblesForPlayer = async (
    player: ReturnType<GameState["getPlayer"]>,
    isCurrent: () => boolean = () => true
  ): Promise<void> => {
    if (!player || !collectibles) return;
    const relocationRevision = player.relocationRevision ?? 0;
    const resourceVisionRevision = gameState.getResourceVisionRevision(player.playerId);
    const gameplayViewGeneration =
      gameState.getGameplayViewCircle(player.playerId)?.generation ?? 0;
    const connectionId = registry.activeConnectionIdForPlayer(player.playerId);
    const isSnapshotCurrent = (): boolean =>
      isCurrent() &&
      Boolean(connectionId) &&
      registry.activeConnectionIdForPlayer(player.playerId) === connectionId &&
      (gameState.getPlayer(player.playerId)?.relocationRevision ?? -1) ===
        relocationRevision &&
      gameState.getResourceVisionRevision(player.playerId) === resourceVisionRevision &&
      (gameState.getGameplayViewCircle(player.playerId)?.generation ?? 0) ===
        gameplayViewGeneration;
    const resourceVision = gameState.getResourceVision(player.playerId);
    const gameplayRegionCode = packageIdForPosition(
      resourceVision?.center ?? player.anchor
    );
    const resourceVisionStatus = resourceVision
      ? resourceVision.destinationKind === "area"
        ? null
        : await collectibles.resourceVisionStatus(resourceVision.flagId)
      : null;
    const [repeatableNodes, waterHighlights] = await Promise.all([
      repeatableResources
        ? repeatableResources.listInVision(gameplayRegionCode, resourceVision, player.playerId)
        : Promise.resolve([]),
      collectibles.waterHighlightsForVision(resourceVision)
    ]);
    if (!isSnapshotCurrent()) return;
    const nodes = await collectibles.listAvailableInVision(
      gameplayRegionCode,
      resourceVision
    );
    if (!isSnapshotCurrent()) return;
    reconcileGivingTreeSnapshot(player.playerId, nodes);
    registry.send(player.playerId, {
      type: "COLLECTIBLES_SNAPSHOT",
      playerId: player.playerId,
      relocationRevision,
      resourceVisionRevision,
      authority: collectibleSnapshotAuthority({
        snapshotGeneration: ++collectibleSnapshotGeneration,
        player,
        resourceVision,
        resourceVisionStatus,
        gameplayViewGeneration,
        nodes,
        repeatableNodes
      }),
      ...(currentWorldViewAuthority?.(player.playerId)
        ? {
            worldViewAuthority:
              currentWorldViewAuthority(player.playerId)!
          }
        : {}),
      serverTime: Date.now(),
      visibleRadiusM: resourceVision?.radiusM ?? 0,
      activationRadiusM: resourceVision?.radiusM ?? 0,
      resourceVision,
      resourceVisionStatus,
      waterHighlights,
      nodes,
      repeatableNodes
    });
    if (!isSnapshotCurrent()) return;
    const inventory = await collectibles.inventoryForPlayer(player.playerId);
    if (!isSnapshotCurrent()) return;
    registry.send(player.playerId, {
      type: "PLAYER_RESOURCES_UPDATED",
      playerId: player.playerId,
      inventory,
      serverTime: Date.now()
    });
  };
  const sendDroppedItemsForPlayer = async (
    targetPlayerId: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> => {
    if (!droppedItems) return;
    const connectionId = registry.activeConnectionIdForPlayer(targetPlayerId);
    const connectionGeneration = connectionGenerations?.current(targetPlayerId);
    if (!connectionId) return;
    const gameplayCircle = currentGameplayViewCircle?.(targetPlayerId)
      ?? gameState.getGameplayViewCircle(targetPlayerId);
    if (!gameplayCircle) return;
    const relocationRevision =
      gameState.getPlayer(targetPlayerId)?.relocationRevision ?? -1;
    const resourceVisionRevision =
      gameState.getResourceVisionRevision(targetPlayerId);
    const drops = await droppedItems.listActiveInGameplayCircle(
      gameplayCircle.center,
      gameplayCircle.radiusM,
      gameplayCircle.eligibleRegionCodes,
      gameplayCircle.eligibleZoneIds,
      targetPlayerId
    );
    if (
      !isCurrent() ||
      registry.activeConnectionIdForPlayer(targetPlayerId) !== connectionId ||
      (connectionGeneration !== undefined &&
        connectionGenerations?.isCurrent(targetPlayerId, connectionGeneration) !== true) ||
      (gameState.getPlayer(targetPlayerId)?.relocationRevision ?? -1) !==
        relocationRevision ||
      gameState.getResourceVisionRevision(targetPlayerId) !==
        resourceVisionRevision ||
      (currentGameplayViewCircle?.(targetPlayerId)
        ?? gameState.getGameplayViewCircle(targetPlayerId))?.generation !==
        gameplayCircle.generation
    ) return;
    registry.sendToConnection(connectionId, {
      type: "DROPPED_ITEMS_SNAPSHOT",
      drops,
      serverTime: Date.now()
    });
  };

  const refreshDroppedItemsNear = async (
    positions: readonly Readonly<{ lat: number; lon: number }>[]
  ): Promise<void> => {
    if (!droppedItems || positions.length === 0) return;
    const playerIds = new Set<string>();
    for (const position of positions) {
      for (const playerId of gameState.playerIdsWhoseGameplayViewCircleContains(position)) {
        playerIds.add(playerId);
      }
    }
    await Promise.all([...playerIds].map((playerId) =>
      sendDroppedItemsForPlayer(playerId)
    ));
  };


  const travelInboxEntriesForPlayer = async (targetPlayerId: string) => {
    if (!travelInvites) return [];
    return travelInvites.inboxForPlayer(targetPlayerId);
  };

  const sendTravelInboxForPlayers = async (
    playerIds: Iterable<string>,
    isCurrent: () => boolean = () => true
  ): Promise<void> => {
    if (!travelInvites) return;
    await Promise.allSettled([...new Set(playerIds)].map(async (targetPlayerId) => {
      const connectionId = registry.activeConnectionIdForPlayer(targetPlayerId);
      if (!connectionId) return;
      try {
        const entries = await travelInboxEntriesForPlayer(targetPlayerId);
        const relocationStatus = playerService
          ? await playerService.relocationStatus(targetPlayerId)
          : null;
        const accountId = landActions || settlement
          ? registry.recordForConnection(connectionId)?.accountId ?? null
          : null;
        const landActionAvailableAt = landActions && accountId
          ? await landActions.availableAt(accountId)
          : undefined;
        const relocationExemptionAvailable = settlement && accountId && relocationStatus
          ? await settlement.relocationExemptionAvailable(accountId, relocationStatus.lastRelocatedAt)
          : undefined;
        if (!isCurrent()) return;
        registry.send(targetPlayerId, {
          type: "TRAVEL_INBOX_SNAPSHOT",
          entries,
          serverTime: relocationStatus?.serverTime ?? Date.now(),
          ...(relocationStatus
            ? {
                relocationAvailableAt: relocationStatus.relocationAvailableAt,
                travelInviteAvailableAt: relocationStatus.travelInviteAvailableAt
              }
            : {}),
          ...(landActionAvailableAt === undefined ? {} : { landActionAvailableAt }),
          ...(relocationExemptionAvailable === undefined ? {} : { relocationExemptionAvailable })
        });
      } catch (error) {
        logger.warn({ err: error, playerId: targetPlayerId }, "failed to refresh Travel Inbox");
      }
    }));
  };

  const sendTravelResourceVisionReadyAndSnapshot = async (
    player: NonNullable<ReturnType<GameState["getPlayer"]>>,
    resourceVision: NonNullable<ReturnType<GameState["getResourceVision"]>>,
    resourceVisionStatus: NonNullable<Awaited<ReturnType<CollectibleService["resourceVisionStatus"]>>>,
    isCurrent: () => boolean = () => true
  ): Promise<void> => {
    if (!collectibles) return;
    const relocationRevision = player.relocationRevision ?? 0;
    const resourceVisionRevision =
      gameState.getResourceVisionRevision(player.playerId);
    const gameplayViewGeneration =
      gameState.getGameplayViewCircle(player.playerId)?.generation ?? 0;
    const connectionId = registry.activeConnectionIdForPlayer(player.playerId);
    const isSnapshotCurrent = (): boolean =>
      isCurrent() &&
      Boolean(connectionId) &&
      registry.activeConnectionIdForPlayer(player.playerId) === connectionId &&
      (gameState.getPlayer(player.playerId)?.relocationRevision ?? -1) ===
        relocationRevision &&
      gameState.getResourceVisionRevision(player.playerId) ===
        resourceVisionRevision &&
      (gameState.getGameplayViewCircle(player.playerId)?.generation ?? 0) ===
        gameplayViewGeneration;
    const gameplayRegionCode = packageIdForPosition(resourceVision.center);
    const [waterHighlights, repeatableNodes, inventory] = await Promise.all([
      collectibles.waterHighlightsForVision(resourceVision),
      repeatableResources?.listInVision(gameplayRegionCode, resourceVision, player.playerId) ?? Promise.resolve([]),
      collectibles.inventoryForPlayer(player.playerId)
    ]);
    if (!isSnapshotCurrent()) return;
    const nodes = await collectibles.listAvailableInVision(
      gameplayRegionCode,
      resourceVision
    );
    if (!isSnapshotCurrent()) return;
    reconcileGivingTreeSnapshot(player.playerId, nodes);
    registry.send(player.playerId, {
      type: "RESOURCE_VISION_READY",
      serverTime: Date.now(),
      resourceVision,
      status: resourceVisionStatus
    });
    if (!isSnapshotCurrent()) return;
    registry.send(player.playerId, {
      type: "COLLECTIBLES_SNAPSHOT",
      playerId: player.playerId,
      relocationRevision,
      resourceVisionRevision,
      authority: collectibleSnapshotAuthority({
        snapshotGeneration: ++collectibleSnapshotGeneration,
        player,
        resourceVision,
        resourceVisionStatus,
        gameplayViewGeneration,
        nodes,
        repeatableNodes
      }),
      ...(currentWorldViewAuthority?.(player.playerId)
        ? {
            worldViewAuthority:
              currentWorldViewAuthority(player.playerId)!
          }
        : {}),
      serverTime: Date.now(),
      visibleRadiusM: resourceVision.radiusM,
      activationRadiusM: resourceVision.radiusM,
      resourceVision,
      resourceVisionStatus,
      waterHighlights,
      nodes,
      repeatableNodes
    });
    if (!isSnapshotCurrent()) return;
    registry.send(player.playerId, {
      type: "PLAYER_RESOURCES_UPDATED",
      playerId: player.playerId,
      inventory,
      serverTime: Date.now()
    });
  };


  return {
    sendToGameplayCirclesContaining,
    sendCombatScopeSnapshot,
    gameplayInterestCenter,
    gameplayInterestZoneIds,
    syncCombatPlayerAfterRelocation,
    activeHarvestSessionForPlayer,
    sendCollectiblesForPlayer,
    sendDroppedItemsForPlayer,
    refreshDroppedItemsNear,
    travelInboxEntriesForPlayer,
    sendTravelInboxForPlayers,
    sendTravelResourceVisionReadyAndSnapshot
  };
}

function collectibleSnapshotAuthority(input: Readonly<{
  snapshotGeneration: number;
  player: PlayerRecord;
  resourceVision: ResourceVision | null;
  resourceVisionStatus: ResourceVisionStatus | null;
  gameplayViewGeneration: number;
  nodes: readonly CollectibleNode[];
  repeatableNodes: readonly RepeatableResourceNode[];
}>): CollectibleSnapshotAuthority {
  const ordinaryNodesTruncated =
    input.nodes.length >= MAX_VISIBLE_COLLECTIBLE_NODES;
  const completeness = input.resourceVision === null
    ? "partial"
    : input.resourceVisionStatus === null
      ? "loading"
      : input.resourceVisionStatus.status === "failed"
      ? "failed"
      : input.resourceVisionStatus.status !== "ready"
        ? "loading"
        : ordinaryNodesTruncated
          ? "partial"
          : "complete";
  return {
    snapshotId: randomUUID(),
    snapshotGeneration: input.snapshotGeneration,
    gameplayViewGeneration: input.gameplayViewGeneration,
    scope: input.resourceVision === null
      ? { kind: "player-anchor", id: input.player.playerId }
      : input.resourceVision.destinationKind === "kingdom_seat"
        ? { kind: "kingdom-seat", id: input.resourceVision.flagId }
        : input.resourceVision.destinationKind === "area"
          ? { kind: "open-area", id: input.resourceVision.flagId }
          : { kind: "flag", id: input.resourceVision.flagId },
    includedDomains: input.resourceVision === null
      ? []
      : ["population", "repeatable-resource"],
    completeness,
    ordinaryNodesTruncated,
    returnedCount: input.nodes.length + input.repeatableNodes.length,
    authoritativeTotalCount: ordinaryNodesTruncated
      ? null
      : input.nodes.length + input.repeatableNodes.length
  };
}

