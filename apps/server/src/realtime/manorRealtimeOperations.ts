import {
  MANOR_ENTER_DISTANCE_METERS,
  distanceMeters,
  levelUpHealth,
  portalIds,
  type EquipmentSnapshotV2,
  type ManorSpaceId,
  type ProgressionSnapshot
} from "@ash-atlas/shared";

import type { ClassService } from "../game/classes/classService.js";
import {
  playerEquipmentCombatStateFromSnapshot,
  type CombatEngine
} from "../game/combat/combatEngine.js";
import type { CombatProfileService } from "../game/combat/combatProfiles.js";
import type { EquipmentService } from "../game/equipment.js";
import type { DroppedItemService } from "../game/droppedItems.js";
import type { FlagBuildCoordinator } from "../game/flagBuildCoordinator.js";
import type { PlayerLocationService } from "../game/locations/playerLocationService.js";
import type { PortalRegistry } from "../game/locations/portalRegistry.js";
import {
  ManorError,
  type ManorEntryAuthorization,
  type ManorPresence,
  type ManorPresenceService,
  type ManorRuntime,
  type ManorStorageService
} from "../game/manor.js";
import { ManorWarfareError } from "../game/manorWarfare.js";
import type { MutablePartyAuthority } from "../game/party/PartyAuthority.js";
import type { PlayerAuthorityFence } from "../game/playerAuthorityFence.js";
import type {
  PopulationTravelReservation
} from "../game/populationTravelReservation.js";
import type { ProgressionService } from "../game/progression.js";
import {
  adjacentZoneIdsForPosition,
  zoneIdForPosition
} from "../game/spatialZones.js";
import type { GameState, PlayerRecord } from "../game/state.js";
import { getTravelBlockReason } from "../game/travelEligibility.js";
import type { TravelInviteService } from "../game/travelInvites.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { XoralEventService } from "../game/xoralEvents.js";
import type { AppLogger } from "../logger.js";
import type { ClassRealtimeState } from "./classRealtimeState.js";
import type { ConnectionGenerationLedger } from "./connectionLifecycle.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";
import type { SocketLike } from "./connectionRegistry.js";
import type { ManorRealtimeState } from "./manorRealtimeState.js";
import type { ManorDecorationService } from "../game/manorDecorations.js";
import type {
  PopulationV2RealtimeHooks,
  PopulationRelocationTrigger,
  ScheduledPopulationV2Relocation
} from "./populationRealtimeOperations.js";
import type { PartyRealtimeState } from "./partyRealtimeState.js";
import type { TravelRealtimeOperations } from "./travelRealtimeOperations.js";
import type { ResolvedTravelDestination, TravelArrivalPlan } from "./travelContracts.js";
import { safeSendServerMessage } from "./handlers/handlerExecutionContext.js";

const WORLD_ONLY_MANOR_MESSAGE_TYPES = new Set<string>([
  "MOVE_TO", "DASH", "SWING", "BUILD_MANOR", "DESTROY_MANOR", "ATTACK_MANOR", "START_MANOR_REPAIR", "INSTALL_MANOR_SKIN", "OPEN_MANOR_UPGRADES", "UPGRADE_MANOR_STORAGE", "BUILD_FURNACE", "OPEN_FURNACE", "START_FURNACE_SMELT", "COLLECT_FURNACE_OUTPUT", "REFINE_FURNACE_GLIMMER_OIL", "BUILD_FISHING_HUT", "OPEN_FISHING_HUT", "COLLECT_FISHING_HUT", "REQUEST_FISHING_RECORDS", "CRAFT_FISHING_ROD", "UPGRADE_FISHING_TRAINING", "SELECT_FISHING_SPECIALIZATION", "START_FISHING", "FISHING_CAST", "FISHING_HOOK", "FISHING_CONTROL", "FISHING_LAND", "FISHING_CANCEL", "BUILD_GREENHOUSE", "PREVIEW_GREENHOUSE_BUILD", "OPEN_GREENHOUSE", "FILL_WATER_BUCKET", "CANCEL_WATER_BUCKET_FILL", "CRAFT_FERTILIZER", "PLACE_FLAG", "CANCEL_FLAG_BUILD", "REINFORCE_FLAG", "VISIT_FLAG",
  "VISIT_WORLD_MAP_KINGDOM", "VISIT_WORLD_MAP_ATLAS_SHRINE", "VISIT_WORLD_MAP_HOLLIN_HUT", "VISIT_OPEN_LAND", "VISIT_RECORDED_LOCATION", "FOUND_CITY", "ADVANCE_CITY_CONSTRUCTION", "VISIT_CITY", "VISIT_CITY_HOUSE", "VISIT_CITY_MARKET",
  "VISIT_WORLD_MAP_CITY",
  "REQUEST_NEARBY_COLLECTIBLES", "SURVEY_AREA", "CLAIM_MINE", "START_HARVEST", "COMPLETE_HARVEST",
  "CANCEL_HARVEST", "COLLECT_WATER_AT_COORDINATE",
  "START_ATTACK", "CANCEL_ATTACK", "DEV_SPAWN_MOB", "DEV_SPAWN_PLANT", "DEV_CLEAR_MOBS", "DEV_CLEAR_PLANTS", "DEV_TELEPORT", "DEV_VISIT_MINE",
  "REQUEST_WORLD_RESYNC", "REQUEST_POPULATION_RESYNC", "MARKET_OPEN", "MARKET_BROWSE", "MARKET_GET_BOOK", "MARKET_REQUEST_QUOTE",
  "MARKET_CREATE_ORDER", "MARKET_SIMPLE_BUY", "MARKET_CANCEL_ORDER", "MARKET_CLAIM",
  "MARKET_SET_SUBSCRIPTIONS"
]);

export function isWorldOnlyWhileInManor(messageType: string): boolean {
  return WORLD_ONLY_MANOR_MESSAGE_TYPES.has(messageType);
}

export function sendManorError(
  socket: SocketLike,
  requestId: string | undefined,
  error: unknown
): void {
  const manorError = error instanceof ManorError || error instanceof ManorWarfareError ? error : null;
  safeSendServerMessage(socket, {
    type: "MANOR_ERROR",
    ...(requestId === undefined ? {} : { requestId }),
    code: manorError?.code ?? "MANOR_REQUEST_REJECTED",
    message: error instanceof Error ? error.message : "Manor request rejected"
  });
}

export function requireManorOwnerPresentForGuest(
  manorRuntime: ManorRuntime,
  authorization: ManorEntryAuthorization
): void {
  if (authorization.accessSource === "OWNER") return;
  const ownerSession = manorRuntime.get(authorization.manor.ownerPlayerId);
  if (ownerSession?.manorId !== authorization.manor.manorId) {
    throw new ManorError(
      "MANOR_OWNER_ABSENT",
      "The manor owner must be inside before guests can enter."
    );
  }
}

export function createCancelPendingManorEntry(context: Readonly<{
  manorRealtimeState: ManorRealtimeState;
  gameState: GameState;
  registry: ConnectionRegistry;
  worldRuntime?: WorldRuntime | undefined;
}>): (
  playerId: string,
  options?: { stopMovement?: boolean; notify?: boolean; message?: string }
) => boolean {
  const { manorRealtimeState, gameState, registry, worldRuntime } = context;
  return (
    playerId: string,
    options: { stopMovement?: boolean; notify?: boolean; message?: string } = {}
  ): boolean => {
    const pending = manorRealtimeState.takePending(playerId);
    if (!pending) return false;
    pending.unsubscribe();
    if (options.stopMovement) {
      gameState.stopPlayer(playerId);
      const activeConnectionId = registry.activeConnectionIdForPlayer(playerId);
      const connection = activeConnectionId
        ? registry.recordForConnection(activeConnectionId)
        : null;
      if (worldRuntime && activeConnectionId && connection?.accountId) {
        worldRuntime.enqueue({
          kind: "lifecycle-cancel",
          reason: "manor-entry",
          playerId,
          accountId: connection.accountId,
          connectionId: activeConnectionId,
          requestId: `cancel-manor-entry:${pending.requestId}`.slice(0, 128)
        });
      }
    }
    if (options.notify) {
      registry.send(playerId, {
        type: "MANOR_ERROR",
        requestId: pending.requestId,
        code: "MANOR_ENTRY_CANCELLED",
        message: options.message ?? "Manor entry was cancelled."
      });
    }
    return true;
  };
}

export function createManorRealtimeOperations(context: Readonly<{
  logger: AppLogger;
  registry: ConnectionRegistry;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  combat?: CombatEngine | undefined;
  combatProfiles?: CombatProfileService | undefined;
  progression?: ProgressionService | undefined;
  equipment?: EquipmentService | undefined;
  classes?: ClassService | undefined;
  classRealtimeState: ClassRealtimeState;
  xoralEvents?: XoralEventService | undefined;
  flagBuilds: FlagBuildCoordinator | null;
  manorPresence?: ManorPresenceService | undefined;
  manorStorage?: ManorStorageService | undefined;
  manorRuntime?: ManorRuntime | undefined;
  manorDecorations?: ManorDecorationService | undefined;
  droppedItems?: DroppedItemService | undefined;
  playerLocations?: PlayerLocationService | undefined;
  portals?: PortalRegistry | undefined;
  manorRealtimeState: ManorRealtimeState;
  partyAuthority?: MutablePartyAuthority | undefined;
  partyRealtimeState: PartyRealtimeState;
  travelInvites?: TravelInviteService | undefined;
  playerAuthorityFence: PlayerAuthorityFence;
  populationV2?: PopulationV2RealtimeHooks | undefined;
  connectionGenerations: ConnectionGenerationLedger;
  activeHarvestSessionForPlayer(playerId: string): Promise<unknown | null>;
  cancelPendingManorEntry(
    playerId: string,
    options?: { stopMovement?: boolean; notify?: boolean; message?: string }
  ): boolean;
  sendTravelInboxForPlayers(playerIds: Iterable<string>): Promise<void>;
  refreshAuthoritativePlayerStats(playerId: string): Promise<{
    progression: ProgressionSnapshot;
    equipment: EquipmentSnapshotV2;
  }>;
  reserveTravelArrivals: TravelRealtimeOperations["reserveTravelArrivals"];
  reservePopulationV2CurrentArea(input: Readonly<{
    playerId: string;
    requestId: string;
    kind: "separate-space-exit";
    center?: { lat: number; lon: number };
    preserveCurrentVision?: boolean;
    signal?: AbortSignal;
  }>): PopulationTravelReservation | null;
  sendCityScopeForPlayer: TravelRealtimeOperations["sendCityScopeForPlayer"];
  sendCollectiblesForPlayer(
    player: PlayerRecord | undefined,
    isCurrent?: () => boolean
  ): Promise<void>;
  schedulePopulationV2RelocationForActivePlayer(
    playerId: string,
    trigger: PopulationRelocationTrigger,
    expectedConnection?: Readonly<{
      connectionId: string;
      connectionGeneration: number;
      requestId?: string;
    }>
  ): ScheduledPopulationV2Relocation | null;
}>): Readonly<{
  activePartyMemberOfOwner(playerId: string, ownerPlayerId: string): boolean;
  resolveManorEntryAuthorization(
    playerId: string,
    manorId: string
  ): Promise<ManorEntryAuthorization>;
  sendManorManagementSnapshot(
    ownerPlayerId: string,
    manorId: string,
    requestId?: string
  ): Promise<void>;
  authorizePortalManorEntry(playerId: string, manorId: string): Promise<void>;
  projectPortalManorEntry(input: {
    playerId: string;
    manorId: string;
    requestId: string;
    expectedPlacementRevision: number;
    spaceId?: ManorSpaceId;
  }): Promise<void>;
  projectPortalManorExit(input: {
    playerId: string;
    requestId: string;
  }): Promise<void>;
  enterManorNow(input: {
    playerId: string;
    manorId: string;
    requestId: string;
    expectedPlacementRevision?: number;
    reservedInviteId?: string;
    skipProximity?: boolean;
    transitionToken?: symbol;
  }): Promise<boolean>;
  forceManorEjection(presence: ManorPresence, reason: string): Promise<void>;
  respawnManorOwnerAfterSkinChange(playerId: string, manorId: string): Promise<void>;
  enforcePartyManorAccess(playerIds: Iterable<string>): Promise<void>;
}> {
  const {
    logger,
    registry,
    gameState,
    worldRuntime,
    combat,
    combatProfiles,
    progression,
    equipment,
    classes,
    classRealtimeState,
    flagBuilds,
    manorPresence,
    manorStorage,
    manorRuntime,
    manorDecorations,
    droppedItems,
    playerLocations,
    portals,
    manorRealtimeState,
    partyAuthority,
    partyRealtimeState,
    travelInvites,
    playerAuthorityFence,
    populationV2,
    connectionGenerations,
    activeHarvestSessionForPlayer,
    cancelPendingManorEntry,
    sendTravelInboxForPlayers,
    refreshAuthoritativePlayerStats,
    reserveTravelArrivals,
    reservePopulationV2CurrentArea,
    sendCityScopeForPlayer,
    sendCollectiblesForPlayer,
    schedulePopulationV2RelocationForActivePlayer
  } = context;

  const activePartyMemberOfOwner = (playerId: string, ownerPlayerId: string): boolean => {
    if (playerId === ownerPlayerId) return true;
    const party = partyAuthority?.partyForPlayer(ownerPlayerId);
    return Boolean(party?.memberPlayerIds.includes(playerId));
  };

  const resolveManorEntryAuthorization = async (
    playerId: string,
    manorId: string
  ): Promise<ManorEntryAuthorization> => {
    if (!manorPresence) throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
    const manor = await manorPresence.builtManor(manorId);
    if (!manor) throw new ManorError("MANOR_NOT_BUILT", "That manor no longer exists.");
    await Promise.all([
      partyRealtimeState.waitForMutation(playerId),
      partyRealtimeState.waitForMutation(manor.ownerPlayerId)
    ]);
    const activeTravelInviteId = playerId === manor.ownerPlayerId
      ? null
      : await travelInvites?.activeManorInviteFor(playerId, manorId) ?? null;
    return manorPresence.authorizeEntry({
      playerId,
      manorId,
      activePartyMember: activePartyMemberOfOwner(playerId, manor.ownerPlayerId),
      activeTravelInviteId
    });
  };

  const sendManorManagementSnapshot = async (
    ownerPlayerId: string,
    manorId: string,
    requestId?: string
  ): Promise<void> => {
    if (!manorPresence || !manorRuntime) return;
    const snapshot = await manorPresence.managementSnapshot(
      ownerPlayerId,
      manorId,
      manorRuntime.playerIdsInManor(manorId)
    );
    registry.send(ownerPlayerId, {
      type: "MANOR_GUESTS",
      ...(requestId ? { requestId } : {}),
      snapshot
    });
  };

  const authorizePortalManorEntry = async (
    playerId: string,
    manorId: string
  ): Promise<void> => {
    if (!manorPresence || !manorStorage || !manorRuntime || !worldRuntime) {
      throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
    }
    const player = gameState.getPlayer(playerId);
    if (!player || !registry.activeConnectionIdForPlayer(playerId)) {
      throw new ManorError("NOT_CONNECTED", "Player state is unavailable.");
    }
    const authorization = await resolveManorEntryAuthorization(playerId, manorId);
    requireManorOwnerPresentForGuest(manorRuntime, authorization);
    if (manorRuntime.isInside(playerId) || await manorPresence.load(playerId)) {
      throw new ManorError("ALREADY_INSIDE", "You are already inside a manor.");
    }
    const travelBlocked = getTravelBlockReason({
      playerId,
      gameState,
      worldRuntime,
      ...(combat ? { combat } : {}),
      hasActiveClassMutation: (id) => classRealtimeState.hasActiveMutation(id),
      xoralExitRole: (id) => context.xoralEvents?.exitRole(id) ?? null
    });
    if (travelBlocked) throw new ManorError(travelBlocked.code, travelBlocked.message);
    if (worldRuntime.hasPlayerWorldTransition(playerId)) {
      throw new ManorError(
        "TRANSITION_PENDING",
        "Finish the current world action before entering the manor."
      );
    }
    if (flagBuilds?.activeForPlayer(playerId)) {
      throw new ManorError("FLAG_BUILD_ACTIVE", "Finish or cancel the current flag build first.");
    }
    if (await activeHarvestSessionForPlayer(playerId)) {
      throw new ManorError("ACTION_ACTIVE", "Finish or cancel the current harvest first.");
    }
  };

  const projectManorEntry = async (input: Readonly<{
    player: PlayerRecord;
    authorization: ManorEntryAuthorization;
    requestId: string;
    reservedInviteId?: string;
    deferAncillary?: boolean;
    spaceId?: ManorSpaceId;
    beforeRuntime(): void;
  }>): Promise<void> => {
    if (!manorPresence || !manorStorage || !manorRuntime || !worldRuntime) {
      throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
    }
    const spaceId = input.spaceId ?? "manor_main_room";
    let reservedInviteId = input.reservedInviteId ?? null;
    let inviteCompleted = false;
    try {
      requireManorOwnerPresentForGuest(manorRuntime, input.authorization);
      if (input.authorization.accessSource === "TRAVEL_INVITE") {
        if (!travelInvites || !input.authorization.travelInviteId) {
          throw new ManorError("MANOR_ACCESS_DENIED", "The manor invitation is no longer active.");
        }
        if (!reservedInviteId) {
          const invite = await travelInvites.reserveAcceptance(
            input.authorization.travelInviteId,
            input.player.playerId,
            input.requestId
          );
          if (
            invite.anchor.sourceType !== "manor" ||
            invite.anchor.sourceId !== input.authorization.manor.manorId ||
            invite.inviterPlayerId !== input.authorization.manor.ownerPlayerId
          ) {
            await travelInvites.releaseAcceptance(
              invite.inviteId,
              input.player.playerId,
              input.requestId
            );
            throw new ManorError("MANOR_ACCESS_DENIED", "The manor invitation is no longer valid.");
          }
          const ownerSession = manorRuntime.get(invite.inviterPlayerId);
          if (ownerSession?.manorId !== input.authorization.manor.manorId) {
            await travelInvites.releaseAcceptance(
              invite.inviteId,
              input.player.playerId,
              input.requestId
            );
            await travelInvites.invalidateForManor(
              input.authorization.manor.manorId,
              "The manor owner left the manor."
            );
            throw new ManorError("MANOR_OWNER_LEFT", "The manor owner left before entry.");
          }
          reservedInviteId = invite.inviteId;
        }
      }
      const presence = await manorPresence.enter(
        input.player,
        input.authorization,
        reservedInviteId && travelInvites
          ? async (client) => {
              await travelInvites.completeAcceptanceInTransaction(
                client,
                reservedInviteId!,
                input.player.playerId,
                input.requestId
              );
              inviteCompleted = true;
            }
          : undefined
      );
      if (
        presence.accessSource === "PARTY" &&
        !activePartyMemberOfOwner(presence.playerId, presence.ownerPlayerId)
      ) {
        await manorPresence.exit(presence.playerId);
        throw new ManorError(
          "MANOR_ACCESS_DENIED",
          "Your party access ended before entry completed."
        );
      }
      let storageSnapshot = null;
      let decorationSnapshot = null;
      let manorEquipmentDrops = [];
      try {
        if (presence.accessSource === "OWNER") {
          storageSnapshot = await manorStorage.snapshotForPlayer(input.player.playerId);
        }
        decorationSnapshot = manorDecorations
          ? await manorDecorations.snapshotForPlayer(input.player.playerId, presence.manorId)
          : null;
        manorEquipmentDrops = droppedItems
          ? await droppedItems.listActiveManorDrops(presence.manorId)
          : [];
      } catch (error) {
        await manorPresence.exit(input.player.playerId).catch(() => undefined);
        throw error;
      }
      manorRuntime.setManorType(presence.manorId, presence.manorTypeId);
      if (decorationSnapshot) {
        manorRuntime.setManorNavigation(
          presence.manorId,
          spaceId,
          manorDecorations!.navigationForManor(presence.manorId, spaceId)
        );
      }
      input.beforeRuntime();
      const session = manorRuntime.enter(
        input.player.playerId,
        presence.manorId,
        presence.accessSource,
        spaceId
      );
      registry.send(input.player.playerId, {
        type: "MANOR_ENTERED",
        requestId: input.requestId,
        manorId: presence.manorId,
        spaceId: session.spaceId,
        manorTypeId: manorRuntime.manorTypeOf(presence.manorId),
        manorSessionId: session.sessionId,
        displayColor: input.player.displayColor,
        ...(input.player.appearance ? { appearance: input.player.appearance } : {}),
        position: session.position,
        movementSequence: session.movementSequence,
        serverTime: Date.now(),
        accessSource: presence.accessSource,
        storage: storageSnapshot,
        droppedItems: manorEquipmentDrops,
        ...(decorationSnapshot ? { decorations: decorationSnapshot } : {})
      });
      const completeAncillary = async (): Promise<void> => {
        if (presence.accessSource === "OWNER" && travelInvites) {
          const affected = await travelInvites.invalidateForInviter(
            input.player.playerId,
            "The inviter entered a private location."
          );
          await sendTravelInboxForPlayers(affected);
        }
        await sendManorManagementSnapshot(presence.ownerPlayerId, presence.manorId);
        worldRuntime.sendManorOccupants(presence.manorId);
        if (inviteCompleted && travelInvites) {
          await sendTravelInboxForPlayers([presence.ownerPlayerId, presence.playerId]);
        }
      };
      if (input.deferAncillary) {
        void completeAncillary().catch((error: unknown) => {
          logger.warn({
            err: error,
            playerId: input.player.playerId,
            manorId: presence.manorId,
            requestId: input.requestId
          }, "portal Manor entry ancillary projection failed after acknowledgment");
        });
      } else {
        await completeAncillary();
      }
    } catch (error) {
      if (reservedInviteId && !inviteCompleted && travelInvites) {
        await travelInvites.releaseAcceptance(
          reservedInviteId,
          input.player.playerId,
          input.requestId
        ).catch(() => undefined);
      }
      throw error;
    }
  };

  const projectPortalManorEntry = async (input: {
    playerId: string;
    manorId: string;
    requestId: string;
    expectedPlacementRevision: number;
    spaceId?: ManorSpaceId;
  }): Promise<void> => {
    if (!manorRuntime || !manorPresence) {
      throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
    }
    const player = gameState.getPlayer(input.playerId);
    if (!player) throw new ManorError("NOT_CONNECTED", "Player state is unavailable.");
    const authorization = await resolveManorEntryAuthorization(input.playerId, input.manorId);
    if (authorization.manor.placementRevision !== input.expectedPlacementRevision) {
      throw new ManorError("MANOR_CHANGED", "That manor changed before you arrived.");
    }
    if (manorRuntime.isInside(input.playerId) || await manorPresence.load(input.playerId)) {
      throw new ManorError("ALREADY_INSIDE", "You are already inside a manor.");
    }
    await projectManorEntry({
      player,
      authorization,
      requestId: input.requestId,
      deferAncillary: true,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      beforeRuntime() {}
    });
  };

  const projectPortalManorExit = async (input: {
    playerId: string;
    requestId: string;
  }): Promise<void> => {
    if (!manorPresence || !manorRuntime || !worldRuntime) {
      throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
    }
    const session = manorRuntime.get(input.playerId);
    if (!session) throw new ManorError("NOT_INSIDE", "You are not inside a manor.");
    const presence = await manorPresence.load(input.playerId);
    if (!presence) throw new ManorError("NOT_INSIDE", "You are not inside a manor.");
    await manorPresence.exit(input.playerId);
    manorRuntime.exit(input.playerId, session.sessionId);
    registry.send(input.playerId, {
      type: "MANOR_EXITED",
      requestId: input.requestId,
      player: gameState.snapshotForPlayer(input.playerId),
      resourceVisionRevision: gameState.getResourceVisionRevision(input.playerId)
    });
    const completeAncillary = async (): Promise<void> => {
      if (presence.playerId === presence.ownerPlayerId && travelInvites) {
        const affected = await travelInvites.invalidateForManor(
          presence.manorId,
          "The manor owner left the manor."
        );
        await sendTravelInboxForPlayers(affected);
      }
      await sendManorManagementSnapshot(presence.ownerPlayerId, presence.manorId);
      worldRuntime.sendManorOccupants(presence.manorId);
    };
    void completeAncillary().catch((error: unknown) => {
      logger.warn({
        err: error,
        playerId: input.playerId,
        manorId: presence.manorId,
        requestId: input.requestId
      }, "portal Manor exit ancillary projection failed after acknowledgment");
    });
  };

  const enterManorNow = async (input: {
    playerId: string;
    manorId: string;
    requestId: string;
    expectedPlacementRevision?: number;
    reservedInviteId?: string;
    skipProximity?: boolean;
    transitionToken?: symbol;
  }): Promise<boolean> => {
    if (!manorPresence || !manorStorage || !manorRuntime || !worldRuntime) {
      throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
    }
    const player = gameState.getPlayer(input.playerId);
    if (!player) throw new ManorError("NOT_CONNECTED", "Player state is unavailable.");
    const connectionId = registry.activeConnectionIdForPlayer(input.playerId);
    if (!connectionId) throw new ManorError("NOT_CONNECTED", "Player is not connected.");
    const authorization = input.reservedInviteId
      ? await manorPresence.authorizeEntry({
          playerId: input.playerId,
          manorId: input.manorId,
          activePartyMember: false,
          activeTravelInviteId: input.reservedInviteId
        })
      : await resolveManorEntryAuthorization(input.playerId, input.manorId);
    if (
      input.expectedPlacementRevision !== undefined &&
      authorization.manor.placementRevision !== input.expectedPlacementRevision
    ) {
      throw new ManorError("MANOR_CHANGED", "That manor changed before you arrived.");
    }
    if (!input.skipProximity && distanceMeters(player.position, authorization.manor) > MANOR_ENTER_DISTANCE_METERS) {
      throw new ManorError("MANOR_TARGET_UNREACHABLE", "You could not reach the manor entrance.");
    }
    if (manorRuntime.isInside(player.playerId) || await manorPresence.load(player.playerId)) {
      throw new ManorError("ALREADY_INSIDE", "You are already inside a manor.");
    }
    const travelBlocked = getTravelBlockReason({
      playerId: player.playerId,
      gameState,
      worldRuntime,
      ...(combat ? { combat } : {}),
      hasActiveClassMutation: (id) => classRealtimeState.hasActiveMutation(id),
      xoralExitRole: (id) => context.xoralEvents?.exitRole(id) ?? null
    });
    if (travelBlocked) throw new ManorError(travelBlocked.code, travelBlocked.message);
    if (worldRuntime.hasPlayerWorldTransition(player.playerId)) {
      throw new ManorError("TRANSITION_PENDING", "Finish the current world action before entering the manor.");
    }
    if (flagBuilds?.activeForPlayer(player.playerId)) {
      throw new ManorError("FLAG_BUILD_ACTIVE", "Finish or cancel the current flag build first.");
    }
    if (await activeHarvestSessionForPlayer(player.playerId)) {
      throw new ManorError("ACTION_ACTIVE", "Finish or cancel the current harvest first.");
    }
    const ownsTransition = !input.transitionToken;
    const transition = input.transitionToken ??
      worldRuntime.beginPlayerWorldTransition(player.playerId, input.requestId);
    if (!transition) throw new ManorError("TRANSITION_PENDING", "Another transition is active.");
    try {
      gameState.stopPlayer(player.playerId);
      combat?.cancelCombat(player.playerId);
      await projectManorEntry({
        player,
        authorization,
        requestId: input.requestId,
        ...(input.reservedInviteId ? { reservedInviteId: input.reservedInviteId } : {}),
        beforeRuntime() {
          gameState.setWorldPresence(player.playerId, false);
          combat?.disconnectPlayer(player.playerId);
          worldRuntime.replication.removePlayer(player.playerId);
          registry.updateSpatialMembership({
            playerId: player.playerId,
            regionCode: `manor:${authorization.manor.manorId}`,
            zoneId: `manor:${authorization.manor.manorId}`,
            interestZoneIds: []
          });
          if (populationV2) {
            void Promise.resolve(populationV2.releaseConnection({
              playerId: player.playerId,
              connectionId,
              connectionGeneration: connectionGenerations.current(player.playerId) ?? 0
            })).catch((error: unknown) => {
              logger.warn(
                { err: error, playerId: player.playerId },
                "population v2 separate-space release failed"
              );
            });
          }
        }
      });
      return true;
    } finally {
      if (ownsTransition) worldRuntime.endPlayerWorldTransition(player.playerId, transition);
    }
  };

  const forceManorEjection = async (
    presence: ManorPresence,
    reason: string
  ): Promise<void> => {
    if (!manorRuntime || !worldRuntime) return;
    const player = gameState.getPlayer(presence.playerId);
    const session = manorRuntime.get(presence.playerId);
    const connectionId = registry.activeConnectionIdForPlayer(presence.playerId);
    const connection = connectionId ? registry.recordForConnection(connectionId) : null;
    if (!player || !session || !connection || !connectionId || !connection.accountId) {
      if (session) {
        await manorRuntime.disconnect(presence.playerId, session.sessionId);
      }
      return;
    }
    const transition = worldRuntime.beginPlayerWorldTransition(presence.playerId);
    if (!transition) {
      await worldRuntime.waitForPlayerWorldTransition(presence.playerId);
      return forceManorEjection(presence, reason);
    }
    let arrivalPlan: TravelArrivalPlan | null = null;
    let populationReservation: PopulationTravelReservation | null = null;
    try {
      manorRuntime.stop(presence.playerId);
      const [combatProfile, refreshed, classState, manor] = await Promise.all([
        combatProfiles ? combatProfiles.getOrCreate(presence.playerId) : null,
        progression && equipment ? refreshAuthoritativePlayerStats(presence.playerId) : null,
        classes ? Promise.all([
          classes.getOrCreate(presence.playerId),
          classes.loadRuntime(presence.playerId)
        ]) : null,
        manorPresence?.builtManor(presence.manorId) ?? null
      ]);
      populationReservation = reservePopulationV2CurrentArea({
        playerId: presence.playerId,
        requestId:
          `manor-ejection:${presence.manorId}:`
          + `${player.relocationRevision ?? 0}`,
        kind: "separate-space-exit",
        ...(manor
          ? {
              center: { lat: manor.lat, lon: manor.lon },
              preserveCurrentVision: false
            }
          : {})
      });
      void populationReservation?.preparation.catch((error: unknown) => {
        logger.warn({
          err: error,
          playerId: presence.playerId,
          manorId: presence.manorId
        }, "manor exit population reservation failed; relocation fallback remains active");
      });
      let canonicalWorldLocation: Extract<
        Awaited<ReturnType<PlayerLocationService["load"]>>,
        { kind: "world" }
      > | null = null;
      if (playerLocations) {
        const canonical = await playerLocations.load(presence.playerId);
        if (canonical.kind === "interior" && canonical.locationType === "manor" &&
            canonical.locationId === presence.manorId) {
          let portalId = "recovery:manor-ejection";
          let destination = {
            kind: "world" as const,
            regionCode: presence.returnRegionCode,
            position: { lat: presence.returnLat, lon: presence.returnLon }
          };
          if (manor && portals) {
            const resolved = await portals.resolve(
              portalIds.manorFoyerToWorld(presence.manorId),
              { ...canonical, spaceId: "manor_foyer" }
            );
            if (resolved.destination.kind === "world" && "lat" in resolved.destinationArrival) {
              portalId = resolved.portalId;
              destination = { ...resolved.destination, position: resolved.destinationArrival };
            }
          }
          const committed = await playerLocations.commitPortalTransition({
            playerId: presence.playerId,
            requestId: `manor-ejection:${presence.manorId}:${canonical.revision}`,
            portalId,
            expectedRevision: canonical.revision,
            destination
          });
          if (committed.location.kind === "world") canonicalWorldLocation = committed.location;
        }
      }
      let restored;
      if (canonicalWorldLocation) {
        restored = gameState.teleportPlayer(
          presence.playerId,
          canonicalWorldLocation.position,
          canonicalWorldLocation.regionCode
        );
      } else if (manor) {
        const destination: ResolvedTravelDestination = {
          kind: "manor",
          id: manor.manorId,
          center: { lat: manor.lat, lon: manor.lon },
          travelAnchor: {
            scopeId: "world",
            layerId: `manor:${manor.manorId}`,
            center: { lat: manor.lat, lon: manor.lon },
            relocationRevision: player.relocationRevision ?? 0,
            layerGeneration: manor.placementRevision,
            sourceType: "manor",
            sourceId: manor.manorId
          }
        };
        arrivalPlan = reserveTravelArrivals(destination, [presence.playerId]);
        restored = gameState.relocateToAnchor(
          presence.playerId,
          destination.center,
          arrivalPlan?.positions.get(presence.playerId) ?? destination.center
        );
      } else {
        restored = gameState.teleportPlayer(
          presence.playerId,
          { lat: presence.returnLat, lon: presence.returnLon },
          presence.returnRegionCode
        );
      }
      gameState.setWorldPresence(presence.playerId, true);
      registry.updateSpatialMembership({
        playerId: presence.playerId,
        regionCode: restored.regionCode,
        zoneId: zoneIdForPosition(restored.position),
        interestZoneIds: adjacentZoneIdsForPosition(restored.position)
      });
      if (combat && combatProfile) {
        const stats = refreshed?.progression.pveStats;
        combat.connectPlayer({
          playerId: restored.playerId,
          name: restored.username,
          regionCode: restored.regionCode,
          zoneId: zoneIdForPosition(restored.position),
          position: restored.position,
          accountId: connection.accountId,
          connectionId,
          profile: stats ? {
            ...combatProfile,
            level: refreshed!.progression.level,
            maxHealth: stats.maxHealth,
            currentHealth: levelUpHealth(combatProfile.currentHealth, combatProfile.maxHealth, stats.maxHealth),
            baseAttackDamage: stats.attackPower,
            defense: stats.defense
          } : combatProfile
        });
        if (classState && refreshed?.equipment) {
          combat.updatePlayerClassState(
            restored.playerId,
            classState[0],
            refreshed.equipment,
            classState[1] ?? undefined
          );
          combat.syncPlayerEquipmentCombatState(
            restored.playerId,
            playerEquipmentCombatStateFromSnapshot(refreshed.equipment)
          );
        }
      }
      worldRuntime.replication.resetPlayer(presence.playerId);
      const populationRelocation =
        schedulePopulationV2RelocationForActivePlayer(
          restored.playerId,
          "separate-space-exit",
          {
            connectionId,
            connectionGeneration:
              connectionGenerations.current(restored.playerId) ?? 0
          }
        );
      if (populationReservation && populationRelocation?.isCurrent()) {
        populationReservation.adopt({
          relocationRevision: populationRelocation.relocationRevision,
          resourceVisionRevision: populationRelocation.resourceVisionRevision,
          gameplayViewGeneration: populationRelocation.gameplayViewGeneration,
          area: populationRelocation.area
        });
      }
      manorRuntime.exit(presence.playerId, session.sessionId);
      worldRuntime.sendManorOccupants(presence.manorId);
      registry.send(presence.playerId, {
        type: "MANOR_EXITED",
        reason,
        player: gameState.snapshotForPlayer(presence.playerId),
        resourceVisionRevision: gameState.getResourceVisionRevision(presence.playerId)
      });
      await Promise.allSettled([
        sendCityScopeForPlayer(restored.playerId, restored.position),
        sendCollectiblesForPlayer(restored),
        manorPresence
          ? manorPresence.listBuiltNear(restored).then((manors) => {
              registry.send(restored.playerId, { type: "MANORS_SNAPSHOT", manors });
            })
          : Promise.resolve()
      ]);
      await sendManorManagementSnapshot(presence.ownerPlayerId, presence.manorId);
    } finally {
      populationReservation?.release();
      arrivalPlan?.release();
      worldRuntime.endPlayerWorldTransition(presence.playerId, transition);
    }
  };

  const enforcePartyManorAccess = async (playerIds: Iterable<string>): Promise<void> => {
    if (!manorPresence || !manorRuntime) return;
    await Promise.all([...new Set(playerIds)].map(async (candidatePlayerId) => {
      const pending = manorRealtimeState.pending(candidatePlayerId);
      if (pending) {
        try {
          await resolveManorEntryAuthorization(candidatePlayerId, pending.manorId);
        } catch {
          cancelPendingManorEntry(candidatePlayerId, {
            stopMovement: true,
            notify: true,
            message: "Your access to that manor ended."
          });
        }
      }
      const session = manorRuntime.get(candidatePlayerId);
      if (!session || session.accessSource !== "PARTY") return;
      await playerAuthorityFence.run(candidatePlayerId, async () => {
        const presence = await manorPresence.load(candidatePlayerId);
        if (
          !presence ||
          presence.accessSource !== "PARTY" ||
          activePartyMemberOfOwner(candidatePlayerId, presence.ownerPlayerId)
        ) return;
        const removed = await manorPresence.exit(candidatePlayerId);
        await forceManorEjection(removed, "Your party access to this manor ended.");
      });
    }));
  };

  /**
   * After the owner equips a skin while inside: the durable location already
   * points at the new type's lobby spawn (ManorPresenceService.equipSkin), so
   * replace the runtime session with a fresh one there and resend the entry
   * snapshot, exactly like a normal entry (rooms, decorations, storage).
   */
  const respawnManorOwnerAfterSkinChange = async (playerId: string, manorId: string): Promise<void> => {
    if (!manorPresence || !manorRuntime) return;
    const previous = manorRuntime.get(playerId);
    const player = gameState.getPlayer(playerId);
    if (!previous || previous.manorId !== manorId || !player) return;
    const presence = await manorPresence.load(playerId);
    if (!presence || presence.manorId !== manorId) return;
    const spaceId: ManorSpaceId = "manor_main_room";
    const storageSnapshot = presence.accessSource === "OWNER" && manorStorage
      ? await manorStorage.snapshotForPlayer(playerId)
      : null;
    const decorationSnapshot = manorDecorations ? await manorDecorations.snapshotForPlayer(playerId, manorId) : null;
    const drops = droppedItems ? await droppedItems.listActiveManorDrops(manorId) : [];
    manorRuntime.setManorType(manorId, presence.manorTypeId);
    if (decorationSnapshot) {
      manorRuntime.setManorNavigation(manorId, spaceId, manorDecorations!.navigationForManor(manorId, spaceId));
    }
    const current = manorRuntime.get(playerId);
    if (current?.sessionId !== previous.sessionId) return;
    manorRuntime.exit(playerId, previous.sessionId);
    const session = manorRuntime.enter(playerId, manorId, presence.accessSource, spaceId);
    registry.send(playerId, {
      type: "MANOR_ENTERED",
      manorId,
      spaceId: session.spaceId,
      manorTypeId: manorRuntime.manorTypeOf(manorId),
      manorSessionId: session.sessionId,
      displayColor: player.displayColor,
      ...(player.appearance ? { appearance: player.appearance } : {}),
      position: session.position,
      movementSequence: session.movementSequence,
      serverTime: Date.now(),
      accessSource: presence.accessSource,
      storage: storageSnapshot,
      droppedItems: drops,
      ...(decorationSnapshot ? { decorations: decorationSnapshot } : {})
    });
    worldRuntime?.sendManorOccupants(manorId);
  };

  return {
    activePartyMemberOfOwner,
    resolveManorEntryAuthorization,
    sendManorManagementSnapshot,
    authorizePortalManorEntry,
    projectPortalManorEntry,
    projectPortalManorExit,
    enterManorNow,
    forceManorEjection,
    respawnManorOwnerAfterSkinChange,
    enforcePartyManorAccess
  };
}
