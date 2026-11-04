import {
  CITY_STRUCTURE_SNAPSHOT_RADIUS_M,
  DEFAULT_FLAG_PREPARE_BUFFER_M,
  DEFAULT_FLAG_PREPARE_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  GPS_RELOCATION_COOLDOWN_MS,
  TRAVEL_HUNGER_MAX_RANGE_M,
  TRAVEL_INVITE_AFTER_RELOCATION_COOLDOWN_MS,
  WORLD_EDGE_ERROR_CODE,
  WORLD_EDGE_MESSAGE,
  distanceMeters,
  isWithinWorldEdge,
  worldMapTravelDurationMs,
  type GameplayAreaContract,
  type EquipmentChallengeProfile,
  type FlagAccessDecision,
  type WorldViewAuthority,
  type WorldMapDestination
} from "@ash-atlas/shared";
import type pg from "pg";

import {
  doorwayDestinationForTravel,
  type AltDoorwayGate
} from "../auth/trust/altDoorway.js";
import type { DestinationAnchorGate } from "../auth/trust/destinationAnchorGate.js";
import type { TrustArrivalLog } from "../auth/trust/trustArrivals.js";
import type { AppConfig } from "../config.js";
import { gameplayLatencyTrace } from "../diagnostics/gameplayLatencyTrace.js";
import type { CityService } from "../game/cities.js";
import {
  resourceVisionForFlag,
  type CollectibleService
} from "../game/collectibles.js";
import type { CombatEngine } from "../game/combat/combatEngine.js";
import type { DroppedItemService } from "../game/droppedItems.js";
import { FlagAccessError, type FlagAccessService } from "../game/flagAccess.js";
import type { FlagArrivalReservations } from "../game/flagArrivalAllocator.js";
import type { FlagBuildCoordinator } from "../game/flagBuildCoordinator.js";
import type { FlagService } from "../game/flags.js";
import type { ManorPresenceService } from "../game/manor.js";
import {
  type MilitaryTravelInput
} from "../game/militaryIndustry.js";
import type { MutablePartyAuthority } from "../game/party/PartyAuthority.js";
import { autoFollowPlayerIdsForLeader } from "../game/party/partyTravel.js";
import {
  PlayerRelocationCooldownError,
  TravelHungerInsufficientError,
  TravelHungerReplayConflictError,
  type TravelHungerPersistenceInput,
  type PlayerService
} from "../game/players.js";
import type { PlayerAuthorityFence } from "../game/playerAuthorityFence.js";
import type { ResourceVisionJobQueue } from "../game/resourceVisionJobs.js";
import { resourceVisionForArea } from "../game/resourceVision.js";
import {
  packageIdForPosition,
  zoneIdForPosition
} from "../game/spatialZones.js";
import type { GameState } from "../game/state.js";
import {
  PopulationSoftTravelReservationManager,
  classifyPopulationTravelPreparationReasons,
  reservePopulationTravelArea,
  type PopulationTravelPreparationResult,
  type PopulationTravelReservation
} from "../game/populationTravelReservation.js";
import type {
  PopulationStreamingSourceKind
} from "../game/populationStreamingContract.js";
import {
  getTravelBlockReason,
  type TravelBlockReason
} from "../game/travelEligibility.js";
import type { TravelInviteService } from "../game/travelInvites.js";
import { coordinateAuthoritativeRelocation } from "../game/travel/authoritativeRelocationCoordinator.js";
import type { WorldMapService } from "../game/worldMap.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { XoralEventService } from "../game/xoralEvents.js";
import type { LegendaryBirdEventService } from "../game/legendaryBirdEvents.js";
import type { AppLogger } from "../logger.js";
import type { ClosedTestTelemetryService } from "../telemetry/service.js";
import type { ClassRealtimeState } from "./classRealtimeState.js";
import type { ConnectionGenerationLedger } from "./connectionLifecycle.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";
import type {
  PopulationV2RealtimeHooks,
  RelocationPopulationReadiness,
  ScheduledPopulationV2Relocation
} from "./populationRealtimeOperations.js";
import type { PartyRealtimeState } from "./partyRealtimeState.js";
import type {
  ResolvedTravelDestination,
  TravelArrivalMode,
  TravelArrivalPlan
} from "./travelContracts.js";
export type { TravelArrivalPlan } from "./travelContracts.js";
import type { CombatScopeSnapshotPublication } from "./realtimeSnapshotOperations.js";

const DEFAULT_TRAVEL_PRE_COMMIT_TIMEOUT_MS = 5_000;

export type TravelRealtimeOperations = ReturnType<typeof createTravelRealtimeOperations>;
type PartyFollowAuthorityPlan = Readonly<{
  partyId: string;
  leaderPlayerId: string;
  expectedFollowers: ReadonlyMap<string, Readonly<{
    connectionId: string;
    relocationRevision: number;
  }>>;
}>;

export function createTravelRealtimeOperations(context: Readonly<{
  config?: AppConfig | undefined;
  altDoorway?: AltDoorwayGate | undefined;
  destinationAnchors?: Pick<DestinationAnchorGate, "checkTravel"> | undefined;
  trustArrivals?: Pick<TrustArrivalLog, "noteArrival"> | undefined;
  /** A pet out with the traveller loses a minute of its timer per relocation or teleport. */
  onTravelCommitted?: ((playerId: string) => void) | undefined;
  logger: AppLogger;
  registry: ConnectionRegistry;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  combat?: CombatEngine | undefined;
  telemetry?: ClosedTestTelemetryService | undefined;
  flagService: FlagService;
  flagAccess?: FlagAccessService | undefined;
  flagBuilds: FlagBuildCoordinator | null;
  flagArrivalReservations: FlagArrivalReservations;
  playerService: PlayerService;
  partyAuthority?: MutablePartyAuthority | undefined;
  classRealtimeState: ClassRealtimeState;
  xoralEvents?: XoralEventService | undefined;
  legendaryBirdEvents?: LegendaryBirdEventService | undefined;
  partyRealtimeState: PartyRealtimeState;
  playerAuthorityFence: PlayerAuthorityFence;
  connectionGenerations: ConnectionGenerationLedger;
  populationV2?: Pick<
    PopulationV2RealtimeHooks,
    | "prepareArea"
    | "releaseSource"
    | "adoptSource"
    | "hasPreparedZones"
    | "canAdmitSpeculative"
  > | undefined;
  cities?: CityService | undefined;
  worldMap?: WorldMapService | undefined;
  travelInvites?: TravelInviteService | undefined;
  collectibles?: CollectibleService | undefined;
  resourceVisionJobs?: ResourceVisionJobQueue | undefined;
  droppedItems?: DroppedItemService | undefined;
  manorPresence?: ManorPresenceService | undefined;
  travelPhase2TaskTimeoutMs: number;
  cancelPendingManorEntry(
    playerId: string,
    options?: { stopMovement?: boolean; notify?: boolean; message?: string }
  ): boolean;
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
  schedulePopulationV2RelocationForActivePlayer(
    playerId: string,
    trigger:
      | "flag-travel"
      | "party-travel"
      | "administrative-relocation"
      | "explicit-relocation",
    expectedConnection?: Readonly<{
      connectionId: string;
      connectionGeneration: number;
      requestId?: string;
      challengeProfile?: EquipmentChallengeProfile;
    }>
  ): ScheduledPopulationV2Relocation | null;
  authoritativeChallengeProfile?(
    playerId: string
  ): EquipmentChallengeProfile | undefined;
  activeHarvestSessionForPlayer?(playerId: string): Promise<unknown | null>;
  beginSmoothTravelTransition(playerId: string, requestId: string): symbol | null;
  endSmoothTravelTransition(
    playerId: string,
    requestId: string,
    transition: symbol,
    outcome: "committed" | "failed",
    releaseReason?: string
  ): boolean;
  markSmoothTravelTransitionPhase(
    playerId: string,
    transition: symbol,
    phase: "phase-one-running" | "committed" | "waiting-visible-population"
  ): boolean;
  armCommittedTravelTransitionWatchdog(
    playerId: string,
    requestId: string,
    transition: symbol,
    relocationRevision: number
  ): void;
  waitForRelocationPopulationV2(input: Readonly<{
    playerId: string;
    requestId: string;
    destination: { lat: number; lon: number };
    transitionToken: symbol;
    relocation: ScheduledPopulationV2Relocation | null;
  }>): Promise<RelocationPopulationReadiness>;
  sendDroppedItemsForPlayer(
    playerId: string,
    isCurrent?: () => boolean
  ): Promise<void>;
  sendCombatScopeSnapshot(
    playerId: string,
    expectedAuthority?: WorldViewAuthority
  ): CombatScopeSnapshotPublication | null;
  sendCollectiblesForPlayer(
    player: ReturnType<GameState["getPlayer"]>,
    isCurrent?: () => boolean
  ): Promise<void>;
  sendFlagSnapshotForPlayer?(
    playerId: string,
    isCurrent?: () => boolean
  ): Promise<void>;
  sendTravelInboxForPlayers(
    playerIds: Iterable<string>,
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
  resolveFlagTravelDestination(flagId: string): Promise<ResolvedTravelDestination | null>;
  reserveTravelArrivals(
    destination: ResolvedTravelDestination,
    arrivingPlayerIds: readonly string[]
  ): TravelArrivalPlan | null;
  sendCityScopeForPlayer(
    playerId: string,
    position: { lat: number; lon: number },
    isCurrent?: () => boolean
  ): Promise<void>;
  prepareWorldMapTravelPopulation(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    requestId: string;
    destination: WorldMapDestination;
  }>): "admitted" | "skipped";
  prepareVisibleFlagVisitPopulation(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    preparationId: string;
    destination: ResolvedTravelDestination;
  }>): "admitted" | "skipped";
  cancelVisibleFlagVisitPopulation(
    playerId: string,
    preparationId: string
  ): boolean;
  cancelWorldMapTravelPopulation(
    playerId: string,
    requestId: string
  ): boolean;
  releaseSoftTravelPopulationConnection(
    connectionId: string,
    connectionGeneration: number
  ): number;
  closeSoftTravelPopulation(): void;
  applyAuthoritativeTravelPhase1(input: TravelOperationInput): Promise<
    | {
        success: true;
        player: ReturnType<GameState["snapshotForPlayer"]>;
        phase2: () => Promise<void>;
        populationRelocation: ScheduledPopulationV2Relocation | null;
      }
    | { success: false; reason: TravelBlockReason }
  >;
  performAuthoritativeTravel(input: TravelOperationInput & {
    transitionToken?: symbol;
  }): Promise<
    | { success: true; player: ReturnType<GameState["snapshotForPlayer"]> }
    | { success: false; reason: TravelBlockReason }
  >;
  sendTravelFailure(
    playerId: string,
    kind: "invite" | "party_manual" | "party_auto_follow" | "manor_jump",
    reason: TravelBlockReason,
    requestId?: string
  ): void;
  followPartyLeader(
    leaderPlayerId: string,
    destination: ResolvedTravelDestination,
    transitionEventId: string,
    arrivalPlan?: Readonly<{
      positions: ReadonlyMap<string, { lat: number; lon: number }>;
      release(): void;
    }> | null,
    capturedChallengeProfile?: EquipmentChallengeProfile | null
  ): Promise<void>;
}> {
  const {
    config,
    altDoorway,
    destinationAnchors,
    trustArrivals,
    logger,
    registry,
    gameState,
    worldRuntime,
    combat,
    telemetry,
    flagService,
    flagAccess,
    flagBuilds,
    flagArrivalReservations,
    playerService,
    partyAuthority,
    classRealtimeState,
    partyRealtimeState,
    playerAuthorityFence,
    connectionGenerations,
    populationV2,
    cities,
    worldMap,
    travelInvites,
    collectibles,
    resourceVisionJobs,
    droppedItems,
    manorPresence,
    travelPhase2TaskTimeoutMs,
    cancelPendingManorEntry,
    gameplayInterestCenter,
    gameplayInterestZoneIds,
    syncCombatPlayerAfterRelocation,
    schedulePopulationV2RelocationForActivePlayer,
    authoritativeChallengeProfile,
    activeHarvestSessionForPlayer,
    beginSmoothTravelTransition,
    endSmoothTravelTransition,
    markSmoothTravelTransitionPhase,
    armCommittedTravelTransitionWatchdog,
    waitForRelocationPopulationV2,
    sendDroppedItemsForPlayer,
    sendCombatScopeSnapshot,
    sendCollectiblesForPlayer,
    sendFlagSnapshotForPlayer = async () => undefined,
    sendTravelInboxForPlayers,
    sendTravelResourceVisionReadyAndSnapshot
  } = context;
  const softTravelReservations =
    config?.POPULATION_SOFT_TRAVEL_PREPARE_ENABLED === true
    && populationV2?.prepareArea
    && populationV2.releaseSource
    && populationV2.adoptSource
      ? new PopulationSoftTravelReservationManager(
          {
            prepareArea: (request) => populationV2.prepareArea!(request),
            releaseSource: (sourceId) => populationV2.releaseSource!(sourceId),
            adoptSource: (request) => populationV2.adoptSource!(request),
            ...(populationV2.hasPreparedZones
              ? {
                  hasPreparedZones: (zoneIds, stage) =>
                    populationV2.hasPreparedZones!(zoneIds, stage)
                }
              : {}),
            ...(populationV2.canAdmitSpeculative
              ? {
                  canAdmitSpeculative: () =>
                    populationV2.canAdmitSpeculative!()
                }
              : {})
          },
          {
            durableConcurrency:
              config.POPULATION_SOFT_TRAVEL_DURABLE_CONCURRENCY,
            promotionConcurrency:
              config.POPULATION_SOFT_TRAVEL_PROMOTION_CONCURRENCY,
            reservationTtlMs:
              config.POPULATION_SOFT_TRAVEL_RESERVATION_TTL_MS,
            activationLeadMs:
              config.POPULATION_SOFT_TRAVEL_ACTIVATION_LEAD_MS,
            autoPromote: false
          }
        )
      : null;
  const visibleFlagTravelReservations =
    populationV2?.prepareArea
    && populationV2.releaseSource
    && populationV2.adoptSource
      ? new PopulationSoftTravelReservationManager(
          {
            prepareArea: (request) => populationV2.prepareArea!(request),
            releaseSource: (sourceId) => populationV2.releaseSource!(sourceId),
            adoptSource: (request) => populationV2.adoptSource!(request),
            ...(populationV2.hasPreparedZones
              ? {
                  hasPreparedZones: (zoneIds, stage) =>
                    populationV2.hasPreparedZones!(zoneIds, stage)
                }
              : {}),
            ...(populationV2.canAdmitSpeculative
              ? {
                  canAdmitSpeculative: () =>
                    populationV2.canAdmitSpeculative!()
                }
              : {})
          },
          {
            durableConcurrency:
              config?.POPULATION_SOFT_TRAVEL_DURABLE_CONCURRENCY ?? 2,
            promotionConcurrency: 1,
            reservationTtlMs:
              config?.FLAG_VISIBLE_VISIT_PREPARATION_TTL_MS ?? 15_000,
            activationLeadMs: 0,
            autoPromote: false
          }
        )
      : null;
  const visibleFlagResourcePreparations = new Map<string, Readonly<{
    connectionId: string;
    connectionGeneration: number;
    preparationId: string;
    abortController: AbortController;
  }>>();
  const committedPopulationPreparationIntents = new Map<string, {
    requestId: string;
    connectionId: string | null;
    connectionGeneration: number | undefined;
    state: "preparing" | "transition-owned";
    cancel(reason?: string): void;
  }>();

  const prepareWorldMapTravelPopulation = (input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    requestId: string;
    destination: WorldMapDestination;
  }>): "admitted" | "skipped" => {
    if (!softTravelReservations || input.destination.kind === "manor") {
      return "skipped";
    }
    const player = gameState.getPlayer(input.playerId);
    if (
      !player
      || registry.activeConnectionIdForPlayer(input.playerId) !==
        input.connectionId
      || !connectionGenerations.isCurrent(
        input.playerId,
        input.connectionGeneration
      )
    ) return "skipped";
    const destination = worldMapPopulationDestination(
      input.destination,
      player.moveLeashRadiusM
    );
    const area = travelPopulationArea({
      config,
      gameState,
      playerId: input.playerId,
      destination
    });
    const result = softTravelReservations.prepare({
      area,
      kind: worldMapPopulationSourceKind(input.destination),
      playerId: input.playerId,
      connectionId: input.connectionId,
      connectionGeneration: input.connectionGeneration,
      travelId: input.requestId,
      expectedRelocationRevision: (player.relocationRevision ?? 0) + 1,
      expectedResourceVisionRevision:
        gameState.getResourceVisionRevision(input.playerId) + 1,
      expectedGameplayViewGeneration: area.generation,
      expectedPresentationDurationMs: worldMapTravelDurationMs(
        player.position,
        destination.center
      )
    });
    return result === "reused" ? "admitted" : result;
  };

  const prepareVisibleFlagVisitPopulation = (input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    preparationId: string;
    destination: ResolvedTravelDestination;
  }>): "admitted" | "skipped" => {
    if (!visibleFlagTravelReservations) return "skipped";
    const player = gameState.getPlayer(input.playerId);
    if (
      !player
      || registry.activeConnectionIdForPlayer(input.playerId) !==
        input.connectionId
      || !connectionGenerations.isCurrent(
        input.playerId,
        input.connectionGeneration
      )
    ) return "skipped";
    const area = travelPopulationArea({
      config,
      gameState,
      playerId: input.playerId,
      destination: input.destination
    });
    const challengeProfile = authoritativeChallengeProfile?.(input.playerId);
    const result = visibleFlagTravelReservations.prepare({
      area,
      kind: "flag-travel",
      playerId: input.playerId,
      connectionId: input.connectionId,
      connectionGeneration: input.connectionGeneration,
      travelId: input.preparationId,
      expectedRelocationRevision: (player.relocationRevision ?? 0) + 1,
      expectedResourceVisionRevision:
        gameState.getResourceVisionRevision(input.playerId) + 1,
      expectedGameplayViewGeneration: area.generation,
      expectedPresentationDurationMs: 0,
      ...(challengeProfile === undefined ? {} : { challengeProfile })
    });
    const resourceVision = input.destination.resourceVision ?? (
      input.destination.id
      && input.destination.flagName
      && input.destination.flagCenter
        ? resourceVisionForFlag({
            flagId: input.destination.id,
            flagName: input.destination.flagName,
            flagCenter: input.destination.flagCenter,
            movementLeashRadiusM: player.moveLeashRadiusM,
            visionRadiusM:
              input.destination.resourceVisionRadiusM
              ?? config?.FLAG_RESOURCE_VISION_RADIUS_M
              ?? DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
          })
        : null
    );
    if (result !== "reused") {
      visibleFlagResourcePreparations.get(input.playerId)?.abortController.abort(
        new Error("visible flag resource preparation was superseded")
      );
      visibleFlagResourcePreparations.delete(input.playerId);
    }
    if (result === "admitted" && resourceVision && collectibles) {
      const abortController = new AbortController();
      const resourcePreparation = {
        connectionId: input.connectionId,
        connectionGeneration: input.connectionGeneration,
        preparationId: input.preparationId,
        abortController
      };
      visibleFlagResourcePreparations.set(
        input.playerId,
        resourcePreparation
      );
      void collectibles.prepareResourceVision({
        resourceVision,
        signal: abortController.signal
      }).catch((error: unknown) => {
        if (abortController.signal.aborted) return;
        logger.warn({
          err: error,
          playerId: input.playerId,
          preparationId: input.preparationId,
          flagId: input.destination.id
        }, "visible flag resource descriptor preparation failed");
      }).finally(() => {
        if (
          visibleFlagResourcePreparations.get(input.playerId)
          === resourcePreparation
        ) {
          visibleFlagResourcePreparations.delete(input.playerId);
        }
      });
    }
    return result === "reused" ? "admitted" : result;
  };

  const resolveFlagTravelDestination = async (
    flagId: string
  ): Promise<ResolvedTravelDestination | null> => {
    const flag = await flagService.getFlag(flagId);
    if (!flag) return null;
    const flagCenter = { lat: flag.lat, lon: flag.lon };
    return {
      kind: "flag",
      id: flag.id,
      center: flagCenter,
      flagName: flag.name,
      flagCenter,
      claimRadiusM: flag.claimRadiusM,
      resourceVisionRadiusM: flag.resourceVisionRadiusM,
      ...(flag.controlType === "personal" ? {
        personalFlagId: flag.id,
        jumpTollGold: flag.jumpTollGold ?? "0"
      } : {})
    };
  };

  const reserveTravelArrivals = (
    destination: ResolvedTravelDestination,
    arrivingPlayerIds: readonly string[]
  ): TravelArrivalPlan | null => {
    const arrivalCenter = destination.flagCenter ?? destination.center;
    const reservationId = destination.travelAnchor
      ? `${destination.travelAnchor.scopeId}:${destination.travelAnchor.layerId}`
      : destination.id;
    if (!reservationId) return null;
    const arriving = new Set(arrivingPlayerIds);
    const existingPlayerIds = destination.travelAnchor
      ? gameState.playerIdsInTravelLayer(destination.travelAnchor)
      : destination.id
        ? gameState.playerIdsAtFlag(destination.id)
        : [];
    const existingPlayerPositions = existingPlayerIds
      .filter((playerId) => !arriving.has(playerId))
      .flatMap((playerId) => {
        const player = gameState.getPlayer(playerId);
        return player ? [{ ...player.position }] : [];
      });
    const maximumDistanceM = Math.max(
      80,
      (destination.claimRadiusM ?? destination.resourceVision?.movementLeashRadiusM ?? 150) - 2
    );
    const reservation = flagArrivalReservations.reserve({
      flagId: reservationId,
      flagCenter: arrivalCenter,
      arrivingPlayerIds,
      existingPlayerPositions,
      validateCandidate: (candidate) =>
        distanceMeters(arrivalCenter, candidate) <= maximumDistanceM
    });
    return {
      positions: new Map(reservation.allocations.map((allocation) => [
        allocation.playerId,
        allocation.position
      ])),
      release: reservation.release
    };
  };

  const eligiblePartyFollowers = (
    leaderPlayerId: string,
    kind: "party_auto_follow"
  ): string[] => {
    if (!partyAuthority) return [];
    const party = partyAuthority.partyForPlayer(leaderPlayerId);
    const followers = autoFollowPlayerIdsForLeader(party, leaderPlayerId);
    return followers.filter((memberPlayerId) => {
      if (!registry.activeConnectionIdForPlayer(memberPlayerId) || !worldRuntime) return false;
      if (worldRuntime.hasPlayerWorldTransition(memberPlayerId)) return false;
      const blocked = getTravelBlockReason({
        playerId: memberPlayerId,
        gameState,
        worldRuntime,
        ...(combat ? { combat } : {}),
        hasActiveClassMutation: (id) => classRealtimeState.hasActiveMutation(id),
        xoralExitRole: (id) => context.xoralEvents?.exitRole(id) ?? null
      });
      if (blocked) {
        sendTravelFailure(memberPlayerId, kind, blocked);
        return false;
      }
      return true;
    });
  };

  const sendCityScopeForPlayer = async (
    targetPlayerId: string,
    position: { lat: number; lon: number },
    isCurrent: () => boolean = () => true
  ): Promise<void> => {
    if (worldMap) {
      try {
        const discovery = await worldMap.discoverAtAuthoritativePosition(
          targetPlayerId,
          position
        );
        if (discovery?.discovered && isCurrent()) {
          const snapshot = await worldMap.snapshot(targetPlayerId);
          if (!isCurrent()) return;
          registry.send(targetPlayerId, {
            type: "WORLD_MAP_DESTINATIONS",
            snapshot
          });
        }
      } catch (error) {
        logger.warn(
          { err: error, playerId: targetPlayerId, position },
          "failed to record city discovery after authoritative relocation"
        );
      }
    }
    if (!cities) return;
    try {
      const nearby = await cities.listCitiesNear(position);
      if (!isCurrent()) return;
      registry.send(targetPlayerId, {
        type: "CITIES_SNAPSHOT",
        cities: nearby
      });
      if (cities.structures) {
        registry.send(targetPlayerId, {
          type: "CITY_STRUCTURES_SNAPSHOT",
          structures: await cities.structures.listNear(
            position,
            CITY_STRUCTURE_SNAPSHOT_RADIUS_M
          )
        });
        registry.send(targetPlayerId, {
          type: "OWNER_OIL_WELL_PROJECTION",
          structure: await cities.structures.ownerOilWellProjection(
            targetPlayerId,
            position
          )
        });
      }
    } catch (error) {
      logger.warn(
        { err: error, playerId: targetPlayerId, position },
        "failed to refresh city markers after travel"
      );
    }
  };

  const travelPopulationReservationOrigins = new WeakMap<
    PopulationTravelReservation,
    "passive-taken" | "committed-created"
  >();
  const reserveTravelPopulation = (
    input: TravelOperationInput,
    signal: AbortSignal
  ): PopulationTravelReservation | null => {
    const connectionId = registry.activeConnectionIdForPlayer(input.playerId);
    const connection = connectionId
      ? registry.recordForConnection(connectionId)
      : null;
    const player = gameState.getPlayer(input.playerId);
    const connectionGeneration = connectionGenerations.current(input.playerId);
    if (
      !connection
      || !player
      || connectionGeneration === undefined
      || !populationV2?.prepareArea
      || !populationV2.releaseSource
      || !populationV2.adoptSource
    ) return null;
    const area = travelPopulationArea({
      config,
      gameState,
      playerId: input.playerId,
      destination: input.destination
    });
    if (input.populationPreparationId && visibleFlagTravelReservations) {
      const prepared = visibleFlagTravelReservations.take({
        playerId: input.playerId,
        connectionId: connection.connectionId,
        connectionGeneration,
        travelId: input.populationPreparationId,
        area
      });
      if (prepared) {
        travelPopulationReservationOrigins.set(prepared, "passive-taken");
        return prepared;
      }
    }
    if (softTravelReservations) {
      const prepared = softTravelReservations.take({
        playerId: input.playerId,
        connectionId: connection.connectionId,
        connectionGeneration,
        travelId: input.requestId,
        area
      });
      if (prepared) {
        travelPopulationReservationOrigins.set(prepared, "passive-taken");
        return prepared;
      }
    }
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea: (request) => populationV2.prepareArea!(request),
        releaseSource: (sourceId) => populationV2.releaseSource!(sourceId),
        adoptSource: (request) => populationV2.adoptSource!(request)
      },
      area,
      kind: input.populationSourceKind ?? populationTravelSourceKind(input),
      playerId: input.playerId,
      connectionId: connection.connectionId,
      connectionGeneration,
      travelId: input.requestId,
      expectedRelocationRevision: (player.relocationRevision ?? 0) + 1,
      expectedResourceVisionRevision:
        gameState.getResourceVisionRevision(input.playerId)
        + (input.destination.kind === "manor" ? 0 : 1),
      expectedGameplayViewGeneration: area.generation,
      signal,
      diagnostic: (diagnostic) => logger.warn({
        playerId: input.playerId,
        requestId: input.requestId,
        ...diagnostic
      }, "travel destination preparation failed closed"),
      lifecycle: ({
        sourceId,
        authorityToken,
        event,
        reasons,
        ...details
      }) => gameplayLatencyTrace.record(input.playerId, {
        traceId: input.requestId,
        source: "game",
        category: "population",
        name: `travel_destination_intent_${event}`,
        details: {
          sourceId,
          authorityToken,
          ...details,
          ...(reasons === undefined
            ? {}
            : { reasons: reasons.join(",") }),
          worldCalled: false
        }
      })
    });
    travelPopulationReservationOrigins.set(
      reservation,
      "committed-created"
    );
    return reservation;
  };

  const applyAuthoritativeTravelPhase1 = async (
    input: TravelOperationInput,
    signal: AbortSignal = new AbortController().signal,
    preparedPopulationReservation: PopulationTravelReservation | null = null,
    capturedChallengeProfile: EquipmentChallengeProfile | null = null
  ): Promise<
    {
      success: true;
      player: ReturnType<GameState["snapshotForPlayer"]>;
      phase2: () => Promise<void>;
      populationRelocation: ScheduledPopulationV2Relocation | null;
    } |
    { success: false; reason: TravelBlockReason }
  > => {
    const operation = async (): Promise<
      {
        success: true;
        player: ReturnType<GameState["snapshotForPlayer"]>;
        phase2: () => Promise<void>;
        populationRelocation: ScheduledPopulationV2Relocation | null;
      } |
      { success: false; reason: TravelBlockReason }
    > => {
      let ownArrivalReservation: TravelArrivalPlan | null = null;
      let partyArrivalPlan: TravelArrivalPlan | null = null;
      let partyFollowAuthorityPlan: PartyFollowAuthorityPlan | null = null;
      let phase2OwnsReservations = false;
      let invalidatedInvitePlayerIds: string[] = [];
      let failureReason: TravelBlockReason | null = null;
      let travelerGoldBalance: string | null = null;
      let appliedAccessMode: string | null = null;
      let activatedLegendaryEventId: string | null = null;
      let chargedTollGold: string | null = null;
      let relocationCompletedAt: Date | null = null;
      let relocationTimestampForRollback: Date | null = null;
      const connectionId = registry.activeConnectionIdForPlayer(input.playerId);
      const connection = connectionId ? registry.recordForConnection(connectionId) : null;
      if (!connection || !worldRuntime) {
        return { success: false, reason: { code: "TRAVEL_PLAYER_OFFLINE", message: "Player is not connected." } };
      }
      const worldEdgeBlock = worldEdgeTravelBlock(input);
      if (worldEdgeBlock) {
        preparedPopulationReservation?.release();
        return { success: false, reason: worldEdgeBlock };
      }
      if (input.kind === "flag" && flagBuilds?.activeForPlayer(input.playerId)) {
        preparedPopulationReservation?.release();
        return { success: false, reason: {
          code: "TRAVEL_CONSTRUCTION_ACTIVE",
          message: "Finish or cancel the current flag build before travelling."
        } };
      }
      if (input.kind === "flag" && await activeHarvestSessionForPlayer?.(input.playerId)) {
        preparedPopulationReservation?.release();
        return { success: false, reason: {
          code: "TRAVEL_HARVEST_ACTIVE",
          message: "Finish or cancel the current harvest before travelling."
        } };
      }
      const preCommitAuthorityFailure = await input.validatePreCommit?.();
      if (preCommitAuthorityFailure) {
        preparedPopulationReservation?.release();
        return { success: false, reason: preCommitAuthorityFailure };
      }
      // Anchored destinations (NATIVE_ANTISPOOF_BUILD_PLAN.md 3.3): another
      // player's flag, city or Castle must be anchored to its owner's
      // Settled home (enforce); shadow only records a signal.
      const unanchored = await destinationAnchors?.checkTravel({
        travellerPlayerId: input.playerId,
        kind: input.kind,
        destination: input.destination,
        companionHostPlayerId: input.companionHostPlayerId
      });
      if (unanchored) {
        preparedPopulationReservation?.release();
        return { success: false, reason: unanchored };
      }
      if (
        preparedPopulationReservation
        && input.requireDestinationReady
        && !capturedChallengeProfile
      ) {
        preparedPopulationReservation.release();
        return {
          success: false,
          reason: {
            code: "TRAVEL_PROFILE_PREPARING",
            message: "Your equipment challenge profile is still preparing.",
            retryAfterMs: 500
          }
        };
      }
      if (preparedPopulationReservation && capturedChallengeProfile) {
        const expectedArea = travelPopulationArea({
          config,
          gameState,
          playerId: input.playerId,
          destination: input.destination
        });
        if (
          !preparedPopulationReservation.matchesChallengeProfile(
            capturedChallengeProfile
          )
          || !preparedPopulationReservation.matchesAuthority({
            connectionId: connection.connectionId,
            connectionGeneration: connectionGenerations.current(input.playerId) ?? -1,
            expectedRelocationRevision: (gameState.getPlayer(input.playerId)?.relocationRevision ?? 0) + 1,
            expectedResourceVisionRevision:
              gameState.getResourceVisionRevision(input.playerId)
              + (input.destination.kind === "manor" ? 0 : 1),
            expectedGameplayViewGeneration: expectedArea.generation
          })
        ) {
          preparedPopulationReservation.release();
          return {
            success: false,
            reason: {
              code: "TRAVEL_POPULATION_PREPARING",
              message: "Travel authority changed while destination preparation was pending. Try again shortly.",
              retryAfterMs: 0
            }
          };
        }
      }
      throwIfRelocationAborted(signal);
      if (gameState.isMovementBlocked(input.playerId, "fishing")) {
        const fishingBlocked: TravelBlockReason = {
          code: "FISHING_ACTIVE",
          message: "Leave the active Fishing encounter before travelling."
        };
        softTravelReservations?.releasePlayer(
          input.playerId,
          input.requestId
        );
        return { success: false, reason: fishingBlocked };
      }
      if (input.kind !== "gps_relocate" && !input.skipTravelEligibility) {
        const blocked = getTravelBlockReason({
          playerId: input.playerId,
          gameState,
          worldRuntime,
          ...(combat ? { combat } : {}),
          hasActiveClassMutation: (id) => classRealtimeState.hasActiveMutation(id),
          xoralExitRole: (id) => context.xoralEvents?.exitRole(id) ?? null
        });
        if (blocked) {
          softTravelReservations?.releasePlayer(
            input.playerId,
            input.requestId
          );
          return { success: false, reason: blocked };
        }
      }
      const previous = gameState.capturePlayerViewTransition(input.playerId);
      let militaryTravelWarning: string | null = null;
      let militaryTravelHandled = false;
      const applyMilitaryTravel = async (client?: pg.PoolClient): Promise<void> => {
        if (militaryTravelHandled || !cities?.militaryIndustry) return;
        const militaryInput: MilitaryTravelInput = {
          playerId: input.playerId,
          operationKind: input.kind,
          destinationKind: input.destination.kind,
          destinationId: input.destination.id,
          destinationCenter: input.destination.center,
          lastKnownPosition: previous.position
        };
        const outcome = await cities.militaryIndustry.preserveMilitaryOnTravel(
          militaryInput,
          client
        );
        militaryTravelHandled = true;
        militaryTravelWarning = outcome.warning;
      };
      const travelHunger = shouldChargeTravelHunger(input)
        ? travelHungerInput(input, previous.position)
        : null;
      if (travelHunger) {
        throwIfRelocationAborted(signal);
        let availability: Awaited<ReturnType<PlayerService["travelHungerAvailability"]>> | null = null;
        try {
          availability = typeof playerService.travelHungerAvailability === "function"
            ? await playerService.travelHungerAvailability(
                input.playerId,
                travelHunger
              )
            : null;
        } catch (error) {
          preparedPopulationReservation?.release("travel-hunger-availability-failed");
          logger.warn(
            { err: error, playerId: input.playerId, requestId: input.requestId },
            "travel Hunger availability check failed"
          );
          return {
            success: false,
            reason: {
              code: "TRAVEL_FAILED",
              message: "Travel could not be completed."
            }
          };
        }
        if (
          availability &&
          !availability.replayed &&
          !availability.replayConflict &&
          availability.currentHunger < availability.cost
        ) {
          preparedPopulationReservation?.release("insufficient-hunger");
          return {
            success: false,
            reason: {
              code: "INSUFFICIENT_HUNGER",
              message: `You need ${availability.cost} Hunger to make that journey.`
            }
          };
        }
        if (availability?.replayed && !input.destination.personalFlagId) {
          // Preparation may have run before the idempotency check. A replay
          // is a committed no-op, so do not retain its population lease.
          preparedPopulationReservation?.release("travel-hunger-replay");
          return {
            success: true,
            player: gameState.snapshotForPlayer(input.playerId),
            phase2: async () => undefined,
            populationRelocation: null
          };
        }
      }
      const populationReservation = preparedPopulationReservation
        ?? reserveTravelPopulation(input, signal);
      if (populationReservation && !preparedPopulationReservation) {
        void populationReservation.preparation.catch((error: unknown) => {
          if (signal.aborted) return;
          logger.warn({
            err: error,
            playerId: input.playerId,
            requestId: input.requestId,
            destination: input.destination,
            flagTransactionAffected: false
          }, "travel population reservation failed; relocation fallback remains active");
        });
      }
      let populationAdoptedBeforeCommit = false;
      if (populationReservation && input.requireDestinationReady) {
        const adoptionArea = travelPopulationArea({
          config,
          gameState,
          playerId: input.playerId,
          destination: input.destination
        });
        const adoption = populationReservation.adopt({
          relocationRevision:
            (gameState.getPlayer(input.playerId)?.relocationRevision ?? 0) + 1,
          resourceVisionRevision:
            gameState.getResourceVisionRevision(input.playerId)
            + (input.destination.kind === "manor" ? 0 : 1),
          gameplayViewGeneration: adoptionArea.generation,
          area: adoptionArea
        });
        gameplayLatencyTrace.record(input.playerId, {
          traceId: input.requestId,
          source: "game",
          category: "population",
          name: `population_travel_reservation_${adoption}`,
          details: {
            sourceId: populationReservation.sourceId,
            beforeRelocationMutation: true,
            worldCalled: false
          }
        });
        if (adoption !== "adopted") {
          populationReservation.release("exact-adoption-failed");
          return {
            success: false,
            reason: {
              code: "TRAVEL_POPULATION_PREPARING",
              message:
                "Destination population authority changed before travel committed.",
              retryAfterMs: 0
            }
          };
        }
        populationAdoptedBeforeCommit = true;
      }
      let restoredPrevious = false;
      const restorePrevious = (): void => {
        if (restoredPrevious) return;
        restoredPrevious = true;
        gameState.restorePlayerViewTransition(input.playerId, previous);
      };
      const restoreOnAbort = (): void => restorePrevious();
      signal.addEventListener("abort", restoreOnAbort, { once: true });
      try {
        cancelPendingManorEntry(input.playerId, {
          notify: true,
          message: "Manor entry was cancelled by another relocation."
        });
        throwIfRelocationAborted(signal);
        let playerSpawnPosition = input.playerSpawnPosition;
        const party = partyAuthority?.partyForPlayer(input.playerId);
        const isTravellingLeader = party?.leaderPlayerId === input.playerId &&
          input.kind !== "party_auto_follow" && input.kind !== "dev_mine" && input.kind !== "dev_teleport" &&
          input.kind !== "pet_open_land" &&
          input.destination.kind !== "manor";
        const eligibleFollowers = isTravellingLeader
          ? eligiblePartyFollowers(input.playerId, "party_auto_follow")
          : [];
        if (party && eligibleFollowers.length > 0) {
          partyFollowAuthorityPlan = {
            partyId: party.partyId,
            leaderPlayerId: input.playerId,
            expectedFollowers: new Map(eligibleFollowers.flatMap((memberPlayerId) => {
              const connectionId = registry.activeConnectionIdForPlayer(memberPlayerId);
              const follower = gameState.getPlayer(memberPlayerId);
              return connectionId && follower
                ? [[memberPlayerId, {
                    connectionId,
                    relocationRevision: follower.relocationRevision ?? 0
                  }] as const]
                : [];
            }))
          };
        }
        if ((input.destination.kind === "flag" || input.destination.travelAnchor) && !playerSpawnPosition) {
          const reservation = reserveTravelArrivals(
            input.destination,
            [input.playerId, ...eligibleFollowers.sort()]
          );
          if (reservation) {
            playerSpawnPosition = reservation.positions.get(input.playerId);
            if (eligibleFollowers.length > 0) partyArrivalPlan = reservation;
            else ownArrivalReservation = reservation;
          }
        }
        const commitRelocation = async (
          client?: pg.PoolClient,
          accessReason?: FlagAccessDecision["reasonCode"]
        ) => {
          throwIfRelocationAborted(signal);
          const hasAuthoritativeTravelAnchor = Boolean(
            gameState.getAuthoritativeTravelAnchor(input.playerId)
          );
          // Keep old-anchor invalidation in the same database transaction as
          // paid travel so a failed relocation cannot consume it. Personal
          // flag access already supplies its transaction client; generic
          // travel defers the invalidation until persistTravelSnapshot's
          // transaction hook below.
          const deferTravelInviteInvalidation = Boolean(
            travelHunger && !client && travelInvites && hasAuthoritativeTravelAnchor
          );
          if (
            travelInvites &&
            hasAuthoritativeTravelAnchor &&
            !deferTravelInviteInvalidation
          ) {
            invalidatedInvitePlayerIds = client
              ? await travelInvites.invalidateForInviterInTransaction(
                  client,
                  input.playerId,
                  "The inviter relocated to another gameplay layer."
                )
              : await travelInvites.invalidateForInviter(
                  input.playerId,
                  "The inviter relocated to another gameplay layer."
                );
          }
          throwIfRelocationAborted(signal);
          const commitAuthorityFailure = await input.validatePreCommit?.();
          if (commitAuthorityFailure) {
            failureReason = commitAuthorityFailure;
            throw new Error(commitAuthorityFailure.message);
          }
          throwIfRelocationAborted(signal);
          combat?.cancelCombat(input.playerId);
          gameState.stopPlayer(input.playerId);
          if (input.destination.resourceVision) {
            gameState.applyValidatedFlagVisit(
              input.playerId,
              input.destination.resourceVision,
              playerSpawnPosition
            );
          } else if (input.destination.kind === "flag" && input.destination.id) {
            const connected = gameState.getPlayer(input.playerId)!;
            const vision = resourceVisionForFlag({
              flagId: input.destination.id,
              flagName: input.destination.flagName ?? "Flag",
              flagCenter: input.destination.flagCenter ?? input.destination.center,
              movementLeashRadiusM: connected.moveLeashRadiusM,
              visionRadiusM: input.destination.resourceVisionRadiusM
            });
            gameState.applyValidatedFlagVisit(input.playerId, vision, playerSpawnPosition);
          } else {
            const connected = gameState.getPlayer(input.playerId)!;
            const vision = resourceVisionForArea({
              regionCode: packageIdForPosition(input.destination.center),
              position: input.destination.center,
              movementLeashRadiusM: connected.moveLeashRadiusM,
              visibleRadiusM:
                config?.FLAG_RESOURCE_VISION_RADIUS_M ??
                DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
            });
            gameState.applyAuthoritativeRelocation({
              playerId: input.playerId,
              anchor: input.destination.center,
              ...(playerSpawnPosition ? { playerSpawnPosition } : {}),
              resourceVision: vision
            });
          }
          let committedPlayer = gameState.snapshotForPlayer(input.playerId);
          let travelPersistenceReplayed = false;
          try {
            // A return home never starts or checks the cooldown; a free re-pick
            // starts a new one without the durable guard (its claim is atomic).
            const relocationTimestamp = input.kind === "gps_relocate"
              && input.relocationCooldown !== "return_home"
              ? new Date()
              : undefined;
            relocationTimestampForRollback = relocationTimestamp ?? null;
            const relocationPersistenceOptions = relocationTimestamp
              ? {
                  lastRelocatedAt: relocationTimestamp,
                  requireRelocationCooldownAvailable: input.relocationCooldown !== "free_repick"
                }
              : {};
            relocationCompletedAt = relocationTimestamp ?? null;
            if (travelHunger) {
              let beforePublishInTransaction = false;
              let travelInviteInvalidationInTransaction = false;
              const travelTransactionCommitHook = !client &&
                (deferTravelInviteInvalidation || input.beforePublish || input.chargeInTransaction || cities?.militaryIndustry)
                ? async (transactionClient: pg.PoolClient) => {
                    await input.chargeInTransaction?.(transactionClient);
                    if (deferTravelInviteInvalidation && travelInvites) {
                      invalidatedInvitePlayerIds =
                        await travelInvites.invalidateForInviterInTransaction(
                          transactionClient,
                          input.playerId,
                          "The inviter relocated to another gameplay layer."
                        );
                      travelInviteInvalidationInTransaction = true;
                    }
                    if (input.beforePublish) {
                      await input.beforePublish(transactionClient);
                      beforePublishInTransaction = true;
                    }
                    await applyMilitaryTravel(transactionClient);
                  }
                : undefined;
              const persisted = client
                ? await playerService.persistTravelSnapshotInTransaction(
                    client,
                    committedPlayer,
                    travelHunger,
                    DEFAULT_TRAVEL_PRE_COMMIT_TIMEOUT_MS - 250,
                    relocationPersistenceOptions
                  ).then(async (result) => {
                    if (!result.replayed) await input.chargeInTransaction?.(client);
                    return result;
                  })
                : await playerService.persistTravelSnapshot(
                    committedPlayer,
                    travelHunger,
                    DEFAULT_TRAVEL_PRE_COMMIT_TIMEOUT_MS - 250,
                    relocationPersistenceOptions,
                    travelTransactionCommitHook
                  );
              travelPersistenceReplayed = persisted.replayed;
              gameState.setPlayerHunger(
                input.playerId,
                persisted.hungerAfter,
                persisted.baseCapacity
              );
              if (persisted.replayed) {
                restorePrevious();
              }
              committedPlayer = gameState.snapshotForPlayer(input.playerId);
              if (
                !persisted.replayed &&
                deferTravelInviteInvalidation &&
                !travelInviteInvalidationInTransaction &&
                travelInvites
              ) {
                invalidatedInvitePlayerIds =
                  await travelInvites.invalidateForInviter(
                    input.playerId,
                    "The inviter relocated to another gameplay layer."
                  );
              }
              if (
                !persisted.replayed &&
                input.beforePublish &&
                !beforePublishInTransaction
              ) {
                await input.beforePublish(client);
              }
            } else if (client) {
              await playerService.persistPlayerSnapshotInTransaction(
                client,
                committedPlayer,
                DEFAULT_TRAVEL_PRE_COMMIT_TIMEOUT_MS - 250,
                { ...relocationPersistenceOptions, hungerWriteMode: "exact" }
              );
              await input.chargeInTransaction?.(client);
            } else {
              await playerService.persistPlayerSnapshot(
                committedPlayer,
                DEFAULT_TRAVEL_PRE_COMMIT_TIMEOUT_MS - 250,
                { ...relocationPersistenceOptions, hungerWriteMode: "exact" },
                async (transactionClient) => {
                  await input.chargeInTransaction?.(transactionClient);
                  await applyMilitaryTravel(transactionClient);
                }
              );
            }
            throwIfRelocationAborted(signal);
          } catch (error) {
            if (error instanceof TravelHungerInsufficientError) {
              failureReason = {
                code: error.code,
                message: error.message
              };
            } else if (error instanceof TravelHungerReplayConflictError) {
              failureReason = {
                code: error.code,
                message: error.message
              };
            } else if (input.kind === "flag") {
              failureReason = {
                code: "FLAG_VISIT_PERSISTENCE_FAILED",
                message: "Flag visit could not be persisted."
              };
            } else if (input.kind === "city") {
              failureReason = {
                code: "CITY_VISIT_PERSISTENCE_FAILED",
                message: "City visit could not be persisted."
              };
            } else if (input.chargeInTransaction && isCodedTravelError(error)) {
              failureReason = { code: error.code, message: error.message };
            } else if (input.kind === "gps_relocate") {
              failureReason = error instanceof PlayerRelocationCooldownError
                ? {
                    code: "GPS_RELOCATE_COOLDOWN",
                    message: "You can relocate again after the 7-day cooldown.",
                    ...(error.retryAfterMs > 0 ? { retryAfterMs: error.retryAfterMs } : {})
                  }
                : {
                    code: "GPS_RELOCATE_PERSISTENCE_FAILED",
                    message: "Your relocation could not be saved. Try again."
                  };
            }
            throw error;
          }
          if (input.beforePublish && !(travelHunger && !client)) {
            await input.beforePublish(client);
          }
          if (!travelPersistenceReplayed) {
            await applyMilitaryTravel(client);
          }
          if (
            client && accessReason && input.destination.kind === "flag" &&
            input.destination.personalFlagId && context.legendaryBirdEvents
          ) {
            activatedLegendaryEventId = await context.legendaryBirdEvents.activateForCommittedArrival(
              client,
              input.destination.personalFlagId,
              input.playerId,
              accessReason
            );
          }
          throwIfRelocationAborted(signal);
          return committedPlayer;
        };

        let player: ReturnType<GameState["snapshotForPlayer"]>;
        if (input.destination.personalFlagId) {
          if (!flagAccess) {
            throw new FlagAccessError(
              "TRAVEL_FAILED",
              "Personal flag access authorization is unavailable."
            );
          }
          try {
            const travel = await flagAccess.executeTravel({
              flagId: input.destination.personalFlagId,
              travelerPlayerId: input.playerId,
              ...(input.companionHostPlayerId === undefined
                ? {}
                : { companionHostPlayerId: input.companionHostPlayerId }),
              requestId: input.requestId,
              ...(input.expectedTollGold === undefined
                ? {}
                : { expectedTollGold: input.expectedTollGold }),
              commit: (client, authorization) =>
                commitRelocation(client, authorization.decision.reasonCode)
            });
            throwIfRelocationAborted(signal);
            travelerGoldBalance = travel.travelerGoldBalance;
            appliedAccessMode = travel.authorization.mode;
            chargedTollGold = travel.authorization.decision.tollGold;
            if (
              !travel.replayed &&
              travel.ownerGoldBalance !== null &&
              travel.authorization.ownerPlayerId !== input.playerId &&
              BigInt(travel.authorization.decision.tollGold) > 0n
            ) {
              registry.send(travel.authorization.ownerPlayerId, {
                type: "FLAG_TOLL_RECEIVED",
                flagId: input.destination.personalFlagId,
                amount: travel.authorization.decision.tollGold,
                walletGold: travel.ownerGoldBalance
              });
            }
            player = travel.value ?? gameState.snapshotForPlayer(input.playerId);
          } catch (error) {
            restorePrevious();
            throw error;
          }
        } else {
          try {
            player = await commitRelocation();
          } catch (error) {
            restorePrevious();
            await playerService.persistPlayerSnapshot(
              gameState.snapshotForPlayer(input.playerId),
              DEFAULT_TRAVEL_PRE_COMMIT_TIMEOUT_MS - 250,
              {
                ...(input.kind === "gps_relocate" && input.relocationCooldown !== "return_home"
                  ? {
                      lastRelocatedAt: input.lastRelocatedAt ?? null,
                      ...(relocationTimestampForRollback === null
                        ? {}
                        : { restoreRelocationIfCurrent: relocationTimestampForRollback })
                    }
                  : {}),
                hungerWriteMode: "exact"
              }
            );
            throw error;
          }
        }
        throwIfRelocationAborted(signal);
        if (activatedLegendaryEventId) {
          try {
            await context.legendaryBirdEvents?.spawnActivation?.(activatedLegendaryEventId);
          } catch (error) {
            logger.warn(
              { err: error, eventId: activatedLegendaryEventId, playerId: input.playerId },
              "failed to spawn committed legendary bird activation"
            );
          }
        }
        syncCombatPlayerAfterRelocation(player);
        if (input.arrivalMode === "protected_jump") {
          combat?.grantFlagArrivalProtection(
            input.playerId,
            player.relocationRevision ?? 0
          );
        } else {
          combat?.breakFlagArrivalProtection(input.playerId);
        }
        const resourceVisionRevision =
          gameState.getResourceVisionRevision(input.playerId);
        gameplayLatencyTrace.record(input.playerId, {
          traceId: input.requestId,
          source: "game",
          category: "population",
          name: "flag_travel_authority_applied",
          details: {
            relocationRevision: player.relocationRevision ?? 0,
            mode: appliedAccessMode,
            chargedTollGold,
            worldCalled: false
          }
        });
        gameplayLatencyTrace.record(input.playerId, {
          traceId: input.requestId,
          source: "game",
          category: "database",
          name: "flag_travel_persisted",
          details: {
            relocationRevision: player.relocationRevision ?? 0,
            worldCalled: false
          }
        });
        registry.updateSpatialMembership({
          playerId: input.playerId,
          regionCode: player.regionCode,
          zoneId: zoneIdForPosition({ lat: player.lat, lon: player.lon }),
          interestZoneIds: gameplayInterestZoneIds(
            input.playerId,
            gameplayInterestCenter(input.playerId, { lat: player.lat, lon: player.lon })
          )
        });
        worldRuntime.replication.resetPlayer(input.playerId);
        const connectionGeneration =
          connectionGenerations.current(input.playerId) ?? -1;
        const relocationRevision = player.relocationRevision ?? 0;
        let gameplayViewGeneration =
          gameState.getGameplayViewCircle(input.playerId)?.generation ?? -1;
        const isCurrent = (): boolean =>
          registry.activeConnectionIdForPlayer(input.playerId) === connectionId &&
          connectionGenerations.isCurrent(input.playerId, connectionGeneration) &&
          (gameState.getPlayer(input.playerId)?.relocationRevision ?? -1) ===
            relocationRevision &&
          (gameState.getGameplayViewCircle(input.playerId)?.generation ?? -1) ===
            gameplayViewGeneration &&
          gameState.getResourceVisionRevision(input.playerId) === resourceVisionRevision;
        const populationRelocation =
          schedulePopulationV2RelocationForActivePlayer(
            input.playerId,
            input.kind === "dev_mine" || input.kind === "dev_teleport" || input.kind === "pet_open_land"
              || input.kind === "city"
              || input.kind === "manor_jump"
              || input.kind === "gps_relocate"
              ? "administrative-relocation"
              : input.kind === "flag" ? "flag-travel" : "party-travel",
            {
              connectionId: connection.connectionId,
              connectionGeneration,
              requestId: input.requestId,
              ...(capturedChallengeProfile
                ? { challengeProfile: capturedChallengeProfile }
                : {})
            }
          );
        if (populationReservation && !populationAdoptedBeforeCommit) {
          if (
            populationRelocation
            && populationRelocation.isCurrent()
          ) {
            const adoption = populationReservation.adopt({
              relocationRevision: populationRelocation.relocationRevision,
              resourceVisionRevision:
                populationRelocation.resourceVisionRevision,
              gameplayViewGeneration:
                populationRelocation.gameplayViewGeneration,
              area: populationRelocation.area
            });
            gameplayLatencyTrace.record(input.playerId, {
              traceId: input.requestId,
              source: "game",
              category: "population",
              name: `population_travel_reservation_${adoption}`,
              details: {
                relocationRevision: populationRelocation.relocationRevision,
                resourceVisionRevision:
                  populationRelocation.resourceVisionRevision,
                gameplayViewGeneration:
                  populationRelocation.gameplayViewGeneration,
                worldCalled: false
              }
            });
            if (adoption === "missing" || adoption === "rejected") {
              logger.warn({
                playerId: input.playerId,
                requestId: input.requestId,
                adoption,
                sourceId: populationReservation.sourceId,
                relocationRevision: populationRelocation.relocationRevision,
                resourceVisionRevision:
                  populationRelocation.resourceVisionRevision,
                gameplayViewGeneration:
                  populationRelocation.gameplayViewGeneration,
                area: populationRelocation.area
              }, "prepared travel population could not be adopted; scheduled relocation remains authoritative");
            }
          } else {
            populationReservation.release();
          }
        }
        const phase2 = async (): Promise<void> => {
          const currentPlayerRecord = gameState.getPlayer(input.playerId);
          const currentVision = gameState.getResourceVision(input.playerId);
          const committedDestinationCurrent =
            currentPlayerRecord?.online === true &&
            gameState.isWorldPresent(input.playerId) &&
            (currentPlayerRecord.relocationRevision ?? -1) === relocationRevision &&
            currentPlayerRecord.anchor.lat === input.destination.center.lat &&
            currentPlayerRecord.anchor.lon === input.destination.center.lon &&
            (
              input.destination.kind !== "flag" ||
              !input.destination.id ||
              currentVision?.flagId === input.destination.id
            );
          const publicationPlayer = committedDestinationCurrent
            ? gameState.snapshotForPlayer(input.playerId)
            : null;
          const publicationResourceVisionRevision =
            gameState.getResourceVisionRevision(input.playerId);
          if (
            publicationPlayer &&
            input.destination.kind === "flag" &&
            input.destination.id
          ) {
            registry.send(input.playerId, {
              type: "FLAG_VISITED",
              requestId: input.requestId,
              flagId: input.destination.id,
              resourceVisionRevision: publicationResourceVisionRevision,
              player: publicationPlayer,
              ...(travelerGoldBalance === null
                ? {}
                : { walletGold: travelerGoldBalance }),
              ...(input.arrivalMode === "protected_jump"
                ? { arrivalPresentation: "jump" as const }
                : {}),
              ...(militaryTravelWarning
                ? { warning: militaryTravelWarning }
                : {})
            });
            gameplayLatencyTrace.record(input.playerId, {
              traceId: input.requestId,
              source: "game",
              category: "population",
              name: "flag_visited_published",
              details: {
                requestId: input.requestId,
                flagId: input.destination.id,
                destinationLat: publicationPlayer.lat,
                destinationLon: publicationPlayer.lon,
                destinationZoneId: zoneIdForPosition({
                  lat: publicationPlayer.lat,
                  lon: publicationPlayer.lon
                }),
                populationOwnerRequestId: input.requestId,
                preparationAuthority: "destination-critical",
                connectionGeneration,
                relocationRevision: publicationPlayer.relocationRevision ?? 0,
                resourceVisionRevision: publicationResourceVisionRevision,
                gameplayViewGeneration:
                  populationRelocation?.gameplayViewGeneration ??
                  gameplayViewGeneration,
                populationPreparationGeneration:
                  populationRelocation?.preparationGeneration ?? 0,
                worldCalled: false
              }
            });
          } else if (
            publicationPlayer &&
            input.destination.kind === "city" &&
            input.destination.id
          ) {
            registry.send(input.playerId, {
              type: "CITY_VISITED",
              requestId: input.requestId,
              cityId: input.destination.id,
              player: publicationPlayer,
              resourceVisionRevision: publicationResourceVisionRevision,
              ...(input.arrivalMode === "protected_jump"
                ? { arrivalPresentation: "jump" as const }
                : {}),
              ...(militaryTravelWarning
                ? { warning: militaryTravelWarning }
                : {})
            });
          }
          if (activatedLegendaryEventId) {
            try {
              await context.legendaryBirdEvents?.publishActivation(activatedLegendaryEventId);
            } catch (error) {
              logger.warn(
                { err: error, eventId: activatedLegendaryEventId, playerId: input.playerId },
                "failed to publish committed legendary bird activation"
              );
            }
          }
          if (
            publicationPlayer &&
            input.sendResult !== false &&
            input.kind !== "dev_mine" && input.kind !== "dev_teleport" &&
            input.kind !== "flag" &&
            input.kind !== "city"
          ) {
            const travelResultMessage = input.kind === "invite"
              ? "Travel Invite accepted."
              : input.kind === "gps_relocate"
                ? "Relocated to your current location."
              : input.kind === "manor_jump"
                ? "Jumped to manor."
              : input.kind === "pet_open_land"
                ? "Travelled to open land."
              : input.kind === "whirlpool"
                ? "The whirlpool carries you away."
                : "Travelled to the party leader.";
            registry.send(input.playerId, {
              type: "TRAVEL_RESULT",
              requestId: input.requestId,
              kind: input.kind,
              success: true,
              message: militaryTravelWarning
                ? `${travelResultMessage} ${militaryTravelWarning}`
                : travelResultMessage,
              ...(militaryTravelWarning
                ? { warning: militaryTravelWarning }
                : {}),
              player: publicationPlayer,
              resourceVisionRevision: publicationResourceVisionRevision,
              ...(input.kind === "gps_relocate" && relocationCompletedAt
                ? {
                    relocationAvailableAt:
                      relocationCompletedAt.getTime() + GPS_RELOCATION_COOLDOWN_MS,
                    travelInviteAvailableAt:
                      relocationCompletedAt.getTime() + TRAVEL_INVITE_AFTER_RELOCATION_COOLDOWN_MS
                  }
                : {}),
              ...(input.arrivalMode === "protected_jump"
                ? { arrivalPresentation: "jump" as const }
                : {})
            });
          }
          const startIndependentTask = (
            task: string,
            operation: () => void | Promise<void>,
            onStale?: () => void
          ): void => {
            const work = Promise.resolve().then(async () => {
              if (!isCurrent()) {
                onStale?.();
                return;
              }
              await operation();
            });
            void withSafeReleaseDeadline(
              work,
              travelPhase2TaskTimeoutMs
            ).then((outcome) => {
              if (outcome === "timed-out") {
                logger.warn(
                  {
                    playerId: input.playerId,
                    destination: input.destination,
                    task,
                    timeoutMs: travelPhase2TaskTimeoutMs
                  },
                  "authoritative travel phase 2 task exceeded its background deadline"
                );
              }
            }).catch((error: unknown) => {
              logger.warn(
                {
                  err: error,
                  playerId: input.playerId,
                  destination: input.destination,
                  task
                },
                "authoritative travel phase 2 task failed"
              );
            });
          };
          const waitForForegroundPopulation = async (): Promise<void> => {
            if (
              config?.POPULATION_TRAVEL_OPTIONAL_ARRIVAL_SEQUENCING_ENABLED
                !== true
              || !populationRelocation
            ) return;
            await populationRelocation.visibleReady.catch(() => undefined);
            await new Promise<void>((resolve) => setImmediate(resolve));
          };
          const startOptionalArrivalTask = (
            task: string,
            operation: () => void | Promise<void>,
            onStale?: () => void
          ): void => startIndependentTask(task, async () => {
            await waitForForegroundPopulation();
            if (!isCurrent()) {
              onStale?.();
              return;
            }
            await operation();
          }, onStale);
          try {
            if (!isCurrent()) return;
            const activePlayer = gameState.getPlayer(input.playerId);
            if (!activePlayer) return;
            gameplayViewGeneration =
              gameState.getGameplayViewCircle(input.playerId)?.generation ?? -1;
            if (!isCurrent()) return;
            startIndependentTask(
              "flag-scope",
              () => sendFlagSnapshotForPlayer(input.playerId, isCurrent)
            );
            const travelledParty = partyAuthority?.partyForPlayer(input.playerId);
            if (
              travelledParty?.leaderPlayerId === input.playerId &&
              input.kind !== "party_auto_follow" &&
              input.kind !== "dev_mine" && input.kind !== "dev_teleport" && input.kind !== "pet_open_land" &&
              input.destination.kind !== "manor"
            ) {
              const followerArrivalPlan = partyArrivalPlan;
              const followerAuthorityPlan = partyFollowAuthorityPlan;
              partyArrivalPlan = null;
              partyFollowAuthorityPlan = null;
              if (followerAuthorityPlan) {
                startIndependentTask(
                  "party-follow",
                  () => followPartyLeader(
                    input.playerId,
                    input.destination,
                    input.requestId,
                    followerArrivalPlan,
                    capturedChallengeProfile,
                    followerAuthorityPlan
                  ),
                  () => followerArrivalPlan?.release()
                );
              } else {
                followerArrivalPlan?.release();
              }
            }
            if (droppedItems) {
              startOptionalArrivalTask(
                "dropped-items",
                () => sendDroppedItemsForPlayer(input.playerId, isCurrent)
              );
            }
            if (input.destination.kind === "flag" && input.destination.id) {
              const destinationFlagId = input.destination.id;
              startIndependentTask("flag-resource-stream", async () => {
                const vision = gameState.getResourceVision(input.playerId);
                if (!vision) return;
                if (!isCurrent()) return;
                const flag = await flagService.getFlag(destinationFlagId);
                if (!isCurrent()) return;
                if (collectibles && flag) {
                  const status = await collectibles.resourceVisionStatus(flag.id);
                  if (!isCurrent()) return;
                  if (status?.status === "ready") {
                    await sendTravelResourceVisionReadyAndSnapshot(
                      activePlayer,
                      vision,
                      status,
                      isCurrent
                    );
                  } else {
                    if (!isCurrent()) return;
                    registry.send(input.playerId, {
                      type: "RESOURCE_VISION_LOADING",
                      serverTime: Date.now(),
                      resourceVision: vision,
                      status,
                      message: "Surveying resources around this flag."
                    });
                    if (resourceVisionJobs) {
                      await waitForForegroundPopulation();
                      if (!isCurrent()) return;
                      const travelledPlayerId = input.playerId;
                      void resourceVisionJobs.ensureQueued({
                        flag,
                        regionCode: packageIdForPosition(vision.center),
                        movementLeashRadiusM: activePlayer.moveLeashRadiusM,
                        reason: "flag-visit",
                        onComplete: async (completion) => {
                          if (!isCurrent()) return;
                          const currentPlayer = gameState.getPlayer(travelledPlayerId);
                          const activeVision = gameState.getResourceVision(travelledPlayerId);
                          if (
                            !currentPlayer ||
                            activeVision?.flagId !== completion.resourceVision.flagId
                          ) return;
                          await sendTravelResourceVisionReadyAndSnapshot(
                            currentPlayer,
                            completion.resourceVision,
                            completion.status,
                            isCurrent
                          );
                        }
                      }).catch((error: unknown) => {
                        logger.warn(
                          { err: error, playerId: travelledPlayerId, flagId: flag.id },
                          "failed to enqueue travel resource vision prewarm"
                        );
                      });
                    }
                  }
                } else if (isCurrent()) {
                  registry.send(input.playerId, {
                    type: "RESOURCE_VISION_LOADING",
                    serverTime: Date.now(),
                    resourceVision: vision,
                    status: null,
                    message: "Surveying resources around this flag."
                  });
                }
              });
            }
            startOptionalArrivalTask(
              "city-scope",
              () => sendCityScopeForPlayer(input.playerId, activePlayer.anchor, isCurrent)
            );
            if (manorPresence) {
              startOptionalArrivalTask("manor-scope", async () => {
                const manors = await manorPresence.listBuiltNear(activePlayer);
                if (!isCurrent()) return;
                registry.send(input.playerId, {
                  type: "MANORS_SNAPSHOT",
                  manors
                });
              });
            }
            if (flagBuilds) {
              startOptionalArrivalTask("flag-quote", () => {
                flagBuilds.refreshQuoteForPlayer(
                  input.playerId,
                  `${input.kind}-completed`
                );
              });
            }
            if (input.destination.kind !== "flag") {
              startOptionalArrivalTask(
                "collectibles",
                () => sendCollectiblesForPlayer(
                  gameState.getPlayer(input.playerId),
                  isCurrent
                )
              );
            }
            if (invalidatedInvitePlayerIds.length > 0) {
              startIndependentTask(
                "travel-inbox",
                () => sendTravelInboxForPlayers(
                  invalidatedInvitePlayerIds,
                  isCurrent
                )
              );
            }
          } catch (error) {
            logger.warn(
              { err: error, playerId: input.playerId, destination: input.destination },
              "authoritative travel phase 2 failed"
            );
          } finally {
            ownArrivalReservation?.release();
            partyArrivalPlan?.release();
          }
        };
        ownArrivalReservation?.release();
        ownArrivalReservation = null;
        phase2OwnsReservations = true;
        return { success: true, player, phase2, populationRelocation };
      } catch (error) {
        if (populationAdoptedBeforeCommit) {
          populationReservation?.releaseAdopted("relocation-commit-failed");
        }
        logger.warn({ err: error, playerId: input.playerId, destination: input.destination }, "authoritative shared travel failed");
        const accessReason = error instanceof FlagAccessError
          ? {
              code: error.code,
              message: error.message,
              ...error.details
            }
          : null;
        const hungerReason = error instanceof TravelHungerInsufficientError ||
          error instanceof TravelHungerReplayConflictError
          ? { code: error.code, message: error.message }
          : null;
        return {
          success: false,
          reason: failureReason ?? hungerReason ?? accessReason ?? {
            code: "TRAVEL_FAILED",
            message: "Travel could not be completed."
          }
        };
      } finally {
        signal.removeEventListener("abort", restoreOnAbort);
        populationReservation?.release();
        if (!phase2OwnsReservations) {
          ownArrivalReservation?.release();
          partyArrivalPlan?.release();
        }
      }
    };
    const result = await operation();
    if (result.success) context.onTravelCommitted?.(input.playerId);
    if (
      result.success
      && (input.kind === "invite" || input.kind === "party_manual" || input.kind === "party_auto_follow")
    ) {
      // Arrival raid wait: brought players cannot burn/attack flags right away.
      altDoorway?.noteArrival(input.playerId, input.companionHostPlayerId);
      // Arrival graph + mass-arrival alert (plan 3.2, 3.5).
      trustArrivals?.noteArrival({
        guestPlayerId: input.playerId,
        hostPlayerId: input.companionHostPlayerId,
        kind: input.kind,
        destination: input.destination.center
      });
    }
    return result;
  };

  const performAuthoritativeTravel = async (
    input: TravelOperationInput & { transitionToken?: symbol }
  ): Promise<
    { success: true; player: ReturnType<GameState["snapshotForPlayer"]> } |
    { success: false; reason: TravelBlockReason }
  > => {
    const worldEdgeBlock = worldEdgeTravelBlock(input);
    if (worldEdgeBlock) return { success: false, reason: worldEdgeBlock };
    const startedAt = performance.now();
    const currentPosition = gameState.getPlayer(input.playerId)?.position;
    const startedAtPosition = currentPosition ? { ...currentPosition } : null;
    const connectionId = registry.activeConnectionIdForPlayer(input.playerId);
    const connection = connectionId
      ? registry.recordForConnection(connectionId)
      : null;
    const connectionGeneration = connectionGenerations.current(input.playerId);
    const travelPreflightEnabled = input.requireDestinationReady
      ?? (config?.POPULATION_TRAVEL_PREFLIGHT_ENABLED === true);
    const isCommittedFlagPreflight =
      travelPreflightEnabled && input.kind === "flag";
    const usesCommittedPreparationIntent =
      isCommittedFlagPreflight || input.requireDestinationReady === true;
    let preparedPopulationReservation: PopulationTravelReservation | null =
      null;
    const preparationAbortController = new AbortController();
    if (usesCommittedPreparationIntent) {
      const currentIntent =
        committedPopulationPreparationIntents.get(input.playerId);
      if (currentIntent?.state === "transition-owned") {
        return {
          success: false,
          reason: {
            code: "PLAYER_WORLD_TRANSITION_PENDING",
            message: "Another travel transition is already pending."
          }
        };
      }
      currentIntent?.cancel("superseded");
      committedPopulationPreparationIntents.set(input.playerId, {
        requestId: input.requestId,
        connectionId,
        connectionGeneration,
        state: "preparing",
        cancel: (reason = "cancelled") => {
          preparationAbortController.abort(
            new Error(`travel population preparation ${reason}`)
          );
          preparedPopulationReservation?.release(reason);
        }
      });
    }
    let capturedChallengeProfile: EquipmentChallengeProfile | null =
      input.capturedChallengeProfile ?? null;
    let committedPopulationRelocation:
      ScheduledPopulationV2Relocation | null = null;
    let visibilityRecoveryRequested = false;
    const result = await coordinateAuthoritativeRelocation<
      ReturnType<GameState["snapshotForPlayer"]>,
      TravelBlockReason,
      ScheduledPopulationV2Relocation
    >({
      playerId: input.playerId,
      requestId: input.requestId,
      destinationIdentity: input.destination.id,
      unavailableReason: {
        code: "TRAVEL_PLAYER_OFFLINE",
        message: "Player is not connected."
      },
      transitionPendingReason: {
        code: "PLAYER_WORLD_TRANSITION_PENDING",
        message: "Another travel transition is already pending."
      },
      unexpectedFailureReason: {
        code: "TRAVEL_FAILED",
        message: "Travel could not be completed."
      },
      preCommitTimeoutReason: {
        code: "TRAVEL_FAILED",
        message: "Travel authority timed out before relocation committed."
      },
      preCommitTimeoutMs: Math.min(
        travelPhase2TaskTimeoutMs,
        DEFAULT_TRAVEL_PRE_COMMIT_TIMEOUT_MS
      ),
      preparationTimeoutReason: {
        code: "TRAVEL_POPULATION_PREPARING",
        message: "Destination population is still preparing. Try again shortly.",
        retryAfterMs: 500
      },
      preparationTimeoutMs:
        config?.POPULATION_TRAVEL_PREFLIGHT_TIMEOUT_MS ?? 15_000,
      postCommitVisibilityTimeoutMs:
        config?.POPULATION_TRAVEL_VISIBLE_READY_TIMEOUT_MS ?? 15_000,
      waitForVisibleBeforeRelease:
        travelPreflightEnabled && input.destination.kind !== "flag",
      available: worldRuntime !== undefined,
      beginTransition: () => {
        const transition = input.transitionToken ??
          beginSmoothTravelTransition(input.playerId, input.requestId);
        if (transition && usesCommittedPreparationIntent) {
          const intent =
            committedPopulationPreparationIntents.get(input.playerId);
          if (
            intent?.requestId === input.requestId
            && intent.connectionId === connectionId
            && intent.connectionGeneration === connectionGeneration
          ) {
            intent.state = "transition-owned";
          }
        }
        if (transition) {
          telemetry?.recordEvent({
            eventFamily: "travel",
            eventType: "transition_started",
            priority: "important",
            playerId: input.playerId,
            sessionId: connection?.authSessionId ?? null,
            operationId: input.requestId,
            targetId: input.destination.id,
            sourceType: input.kind
          });
        }
        return transition;
      },
      endTransition: (transition, outcome, reason) => {
        endSmoothTravelTransition(
          input.playerId,
          input.requestId,
          transition,
          outcome,
          reason
        );
      },
      runExclusive: (operation) => playerAuthorityFence.run(input.playerId, operation),
      ...(travelPreflightEnabled ? {
        prepareBeforeExclusive: async (signal: AbortSignal) => {
          const preparationSignal = AbortSignal.any([
            signal,
            preparationAbortController.signal
          ]);
          const preparationDeadline = Date.now() +
            Math.max(
              0,
              (config?.POPULATION_TRAVEL_PREFLIGHT_TIMEOUT_MS ?? 15_000) - 150
            );
          preparedPopulationReservation =
            reserveTravelPopulation(input, preparationSignal);
          if (usesCommittedPreparationIntent) {
            const intent =
              committedPopulationPreparationIntents.get(input.playerId);
            if (
              !intent
              || intent.requestId !== input.requestId
              || intent.connectionId !== connectionId
              || intent.connectionGeneration !== connectionGeneration
            ) {
              preparedPopulationReservation?.release("superseded");
              return {
                success: false as const,
                reason: {
                  code: "TRAVEL_POPULATION_PREPARING",
                  message: "A newer flag travel request replaced this preparation.",
                  retryAfterMs: 0
                }
              };
            }
          }
          if (!preparedPopulationReservation) {
            if (!input.requireDestinationReady) {
              return { success: true as const };
            }
            return {
              success: false as const,
              reason: {
                code: "TRAVEL_POPULATION_PREPARING",
                message:
                  "Destination population authority is unavailable. Try again shortly.",
                retryAfterMs: 500
              }
            };
          }
          gameplayLatencyTrace.record(input.playerId, {
            traceId: input.requestId,
            source: "game",
            category: "population",
            name: "travel_destination_intent_created",
            details: {
              sourceId: preparedPopulationReservation.sourceId,
              sourceOrigin:
                travelPopulationReservationOrigins.get(
                  preparedPopulationReservation
                ) ?? "committed-created",
              worldCalled: false
            }
          });
          const preparedChallengeProfile =
            preparedPopulationReservation.capturedChallengeProfile();
          if (!capturedChallengeProfile && preparedChallengeProfile) {
            capturedChallengeProfile = preparedChallengeProfile;
          }
          let terminalPopulationPreparation = false;
          let lastPopulationPreparation: PopulationTravelPreparationResult
            | null = null;
          for (;;) {
            if (
              preparationSignal.aborted
              || Date.now() >= preparationDeadline
            ) break;
            if (usesCommittedPreparationIntent) {
              const intent =
                committedPopulationPreparationIntents.get(input.playerId);
              if (
                !intent
                || intent.requestId !== input.requestId
                || intent.connectionId !== connectionId
                || intent.connectionGeneration !== connectionGeneration
              ) {
                preparedPopulationReservation.release("superseded");
                return {
                  success: false as const,
                  reason: {
                    code: "TRAVEL_POPULATION_PREPARING",
                    message:
                      "A newer flag travel request replaced this preparation.",
                    retryAfterMs: 0
                  }
                };
              }
            }
            if (!capturedChallengeProfile) {
              const available =
                authoritativeChallengeProfile?.(input.playerId);
              if (available) {
                capturedChallengeProfile = available;
                gameplayLatencyTrace.record(input.playerId, {
                  traceId: input.requestId,
                  source: "game",
                  category: "population",
                  name: "travel_challenge_profile_captured",
                  details: {
                    sourceId: preparedPopulationReservation.sourceId,
                    currentGearLevel: available.currentGearLevel,
                    fingerprint: safeChallengeProfileFingerprint(available),
                    worldCalled: false
                  }
                });
              } else if (input.requireDestinationReady) {
                await waitForPopulationPreparationRetry(preparationSignal);
                continue;
              }
            }
            const preparation = capturedChallengeProfile
              ? await preparedPopulationReservation.ensureSimulation(
                  capturedChallengeProfile
                )
              : await preparedPopulationReservation.ensureDurable();
            lastPopulationPreparation = preparation;
            if (capturedChallengeProfile && preparation.status === "ready") {
              capturedChallengeProfile =
                preparedPopulationReservation.capturedChallengeProfile();
              gameplayLatencyTrace.record(input.playerId, {
                traceId: input.requestId,
                source: "game",
                category: "population",
                name: "flag_travel_simulation_ready",
                details: {
                  sourceId: preparedPopulationReservation.sourceId,
                  worldCalled: false
                }
              });
            } else if (preparation.status === "ready") {
              gameplayLatencyTrace.record(input.playerId, {
                traceId: input.requestId,
                source: "game",
                category: "population",
                name: "flag_travel_durable_ready",
                details: {
                  sourceId: preparedPopulationReservation.sourceId,
                  worldCalled: false
                }
              });
            }
            if (preparation.status === "ready") {
              return { success: true as const };
            }
            const disposition =
              classifyPopulationTravelPreparationReasons(preparation.reasons);
            if (disposition !== "retryable") {
              terminalPopulationPreparation = true;
              break;
            }
            if (
              Date.now() >= preparationDeadline
              || preparationSignal.aborted
            ) break;
            await waitForPopulationPreparationRetry(preparationSignal);
          }
          if (
            capturedChallengeProfile
            && !terminalPopulationPreparation
            && lastPopulationPreparation?.status === "not-ready"
          ) {
            logger.warn({
              playerId: input.playerId,
              requestId: input.requestId,
              destination: input.destination,
              sourceId: preparedPopulationReservation.sourceId,
              reasons: lastPopulationPreparation.reasons,
              pendingZoneIds: lastPopulationPreparation.pendingZoneIds,
              timeoutMs:
                config?.POPULATION_TRAVEL_PREFLIGHT_TIMEOUT_MS ?? 15_000
            }, "travel population preflight exhausted retries");
          }
          preparedPopulationReservation.release(
            terminalPopulationPreparation
              ? "preparation-terminal"
              : capturedChallengeProfile
              ? "preparation-deadline"
              : "profile-deadline"
          );
          return {
            success: false as const,
            reason: terminalPopulationPreparation
              ? {
                  code: "TRAVEL_FAILED",
                  message: "Destination wildlife could not be prepared."
                }
              : capturedChallengeProfile
              ? {
                  code: "TRAVEL_POPULATION_PREPARING",
                  message:
                    "Destination population is still preparing. Try again shortly.",
                  retryAfterMs: 500
                }
              : {
                  code: "TRAVEL_PROFILE_PREPARING",
                  message:
                    "Your equipment challenge profile is still preparing.",
                  retryAfterMs: 500
                }
          };
        }
      } : {}),
      applyPhaseOne: async (signal) => {
        const phaseOne = await applyAuthoritativeTravelPhase1(
          input,
          signal,
          preparedPopulationReservation,
          capturedChallengeProfile
        );
        if (phaseOne.success) {
          committedPopulationRelocation = phaseOne.populationRelocation;
        }
        return phaseOne;
      },
      markTransitionPhase: (transition, phase) => {
        markSmoothTravelTransitionPhase(input.playerId, transition, phase);
      },
      registerPreCommitAbort: (transition, abort) => {
        worldRuntime?.registerPlayerWorldTransitionPreCommitAbort(
          input.playerId,
          transition,
          abort
        );
      },
      relocationRevision: (player) => player.relocationRevision ?? 0,
      armCommittedWatchdog: (transition, relocationRevision) => {
        armCommittedTravelTransitionWatchdog(
          input.playerId,
          input.requestId,
          transition,
          relocationRevision
        );
      },
      waitForVisibleReady: (transition, relocation) =>
        waitForRelocationPopulationV2({
          playerId: input.playerId,
          requestId: input.requestId,
          destination: input.destination.center,
          transitionToken: transition,
          relocation
        }),
      onVisibilitySettled: async (status) => {
        if (
          (status !== "ready" && status !== "degraded") ||
          input.destination.kind === "manor"
        ) return true;
        const relocation = committedPopulationRelocation;
        const activePlayer = gameState.getPlayer(input.playerId);
        if (!activePlayer || !relocation) return false;
        const expectedAuthority: WorldViewAuthority = {
          playerId: input.playerId,
          connectionId: relocation.connectionId,
          connectionGeneration: relocation.connectionGeneration,
          relocationRevision: relocation.relocationRevision,
          resourceVisionRevision: relocation.resourceVisionRevision,
          gameplayViewGeneration: relocation.gameplayViewGeneration,
          populationPreparationGeneration:
            relocation.preparationGeneration ?? 0
        };
        const isCurrent = (): boolean =>
          relocation.playerId === input.playerId &&
          relocation.isCurrent() &&
          registry.activeConnectionIdForPlayer(input.playerId) ===
            expectedAuthority.connectionId &&
          connectionGenerations.current(input.playerId) ===
            expectedAuthority.connectionGeneration &&
          (gameState.getPlayer(input.playerId)?.relocationRevision ?? -1) ===
            expectedAuthority.relocationRevision &&
          gameState.getResourceVisionRevision(input.playerId) ===
            expectedAuthority.resourceVisionRevision &&
          (gameState.getGameplayViewCircle(input.playerId)?.generation ?? -1) ===
            expectedAuthority.gameplayViewGeneration &&
          (relocation.preparationGeneration ?? 0) ===
            expectedAuthority.populationPreparationGeneration;
        if (!isCurrent()) return false;
        const traceAuthority = {
          requestId: input.requestId,
          flagId: input.destination.kind === "flag"
            ? input.destination.id
            : null,
          connectionGeneration: expectedAuthority.connectionGeneration,
          relocationRevision: expectedAuthority.relocationRevision,
          resourceVisionRevision: expectedAuthority.resourceVisionRevision,
          gameplayViewGeneration: expectedAuthority.gameplayViewGeneration,
          populationPreparationGeneration:
            expectedAuthority.populationPreparationGeneration,
          worldCalled: false
        };
        gameplayLatencyTrace.record(input.playerId, {
          traceId: input.requestId,
          source: "game",
          category: "population",
          name: status === "degraded"
            ? "travel_destination_presentation_degraded"
            : "travel_destination_presentation_ready",
          details: traceAuthority
        });
        gameplayLatencyTrace.record(input.playerId, {
          traceId: input.requestId,
          source: "game",
          category: "networking",
          name: "travel_combat_snapshot_requested",
          details: traceAuthority
        });
        const combatSnapshot = sendCombatScopeSnapshot(
          input.playerId,
          expectedAuthority
        );
        if (!combatSnapshot || !isCurrent()) return false;
        gameplayLatencyTrace.record(input.playerId, {
          traceId: input.requestId,
          source: "game",
          category: "networking",
          name: "travel_combat_snapshot_sent",
          details: {
            ...traceAuthority,
            combatSnapshotGeneration:
              combatSnapshot.combatSnapshotGeneration,
            combatEntityCount: combatSnapshot.combatEntityCount,
            mobEntityCount: combatSnapshot.mobEntityCount
          }
        });
        await sendCollectiblesForPlayer(
          activePlayer,
          isCurrent
        );
        if (!isCurrent()) return false;
        if (collectibles) {
          gameplayLatencyTrace.record(input.playerId, {
            traceId: input.requestId,
            source: "game",
            category: "population",
            name: "travel_collectible_snapshot_sent",
            details: traceAuthority
          });
        }
        return true;
      },
      onExclusiveFailure: (error) => {
        logger.warn(
          { err: error, playerId: input.playerId, destination: input.destination },
          "authoritative shared travel fence failed"
        );
      },
      onPreCommitTimeout: (transition) => {
        const state = worldRuntime?.playerWorldTransitionState(input.playerId);
        logger.warn({
          playerId: input.playerId,
          requestId: input.requestId,
          connectionId: state?.connectionId ?? null,
          connectionGeneration: state?.connectionGeneration ?? null,
          relocationRevision:
            gameState.getPlayer(input.playerId)?.relocationRevision ?? null,
          phase: state?.phase ?? "phase-one-running",
          elapsedMs: state ? Date.now() - state.startedAtMs : 0,
          transitionToken: String(transition)
        }, "authoritative relocation exceeded its pre-commit deadline");
        worldRuntime?.replication.requestResync(input.playerId);
        combat?.requestResync(input.playerId);
      },
      onPreparationTimeout: () => {
        preparedPopulationReservation?.release();
        logger.warn({
          playerId: input.playerId,
          requestId: input.requestId,
          destination: input.destination,
          timeoutMs:
            config?.POPULATION_TRAVEL_PREFLIGHT_TIMEOUT_MS ?? 15_000
        }, "travel population preflight exceeded its deadline");
      },
      onPreparationFailure: (error) => {
        preparedPopulationReservation?.release();
        logger.warn({
          err: error,
          playerId: input.playerId,
          requestId: input.requestId,
          destination: input.destination
        }, "travel population preflight failed");
      },
      onVisibilityFailure: (error) => {
        const transitionState =
          worldRuntime?.playerWorldTransitionState(input.playerId);
        logger.warn(
          {
            err: error,
            playerId: input.playerId,
            requestId: input.requestId,
            destination: input.destination,
            relocationRevision:
              gameState.getPlayer(input.playerId)?.relocationRevision ?? null,
            phase: transitionState?.phase ?? null,
            pendingPopulation:
              preparedPopulationReservation?.sourceId ?? null
          },
          "population visibility readiness failed after committed travel"
        );
        if (!visibilityRecoveryRequested) {
          visibilityRecoveryRequested = true;
          worldRuntime?.replication.requestResync(input.playerId);
          combat?.requestResync(input.playerId);
        }
      }
    });
    if (!result.success) {
      const failedReservation =
        preparedPopulationReservation as PopulationTravelReservation | null;
      failedReservation?.release();
    }
    if (
      usesCommittedPreparationIntent
      && committedPopulationPreparationIntents.get(input.playerId)?.requestId ===
        input.requestId
      && committedPopulationPreparationIntents.get(input.playerId)
        ?.connectionId === connectionId
      && committedPopulationPreparationIntents.get(input.playerId)
        ?.connectionGeneration === connectionGeneration
    ) committedPopulationPreparationIntents.delete(input.playerId);
    telemetry?.recordEvent({
      eventFamily: "travel",
      eventType: result.success ? "transition_succeeded" : "transition_failed",
      priority: result.success ? "important" : "critical",
      playerId: input.playerId,
      sessionId: connection?.authSessionId ?? null,
      operationId: input.requestId,
      targetId: input.destination.id,
      sourceType: input.kind,
      gameplayZoneId: result.success
        ? zoneIdForPosition(input.destination.center)
        : null,
      appliedState: result.success ? "applied" : "rejected",
      rejectionCode: result.success ? null : result.reason.code,
      durationMs: performance.now() - startedAt,
      distanceM:
        result.success && startedAtPosition
          ? distanceMeters(startedAtPosition, input.destination.center)
          : null
    });
    return result;
  };

  const sendTravelFailure = (
    playerId: string,
    kind: "invite" | "party_manual" | "party_auto_follow" | "manor_jump",
    reason: TravelBlockReason,
    requestId?: string
  ): void => {
    registry.send(playerId, {
      type: "TRAVEL_RESULT",
      ...(requestId ? { requestId } : {}),
      kind,
      success: false,
      message: reason.message,
      ...(reason.retryAfterMs === undefined ? {} : { retryAfterMs: reason.retryAfterMs })
    });
  };

  const followPartyLeader = async (
    leaderPlayerId: string,
    destination: ResolvedTravelDestination,
    transitionEventId: string,
    arrivalPlan: TravelArrivalPlan | null = null,
    leaderChallengeProfile?: EquipmentChallengeProfile | null,
    authorityPlan?: PartyFollowAuthorityPlan
  ): Promise<void> => {
    if (!partyAuthority) {
      arrivalPlan?.release();
      return;
    }
    const party = partyAuthority.partyForPlayer(leaderPlayerId);
    if (!party || party.leaderPlayerId !== leaderPlayerId || !party.allowTravel) {
      arrivalPlan?.release();
      return;
    }
    const resolvedAuthorityPlan = authorityPlan ?? {
      partyId: party.partyId,
      leaderPlayerId,
      expectedFollowers: new Map(
        autoFollowPlayerIdsForLeader(party, leaderPlayerId)
          .flatMap((memberPlayerId) => {
            const connectionId = registry.activeConnectionIdForPlayer(memberPlayerId);
            const follower = gameState.getPlayer(memberPlayerId);
            return connectionId && follower
              ? [[memberPlayerId, {
                  connectionId,
                  relocationRevision: follower.relocationRevision ?? 0
                }] as const]
              : [];
          })
      )
    };
    const eventKey = `${party.partyId}:${transitionEventId}`;
    if (!partyRealtimeState.claimFollowEvent(eventKey)) {
      arrivalPlan?.release();
      return;
    }
    try {
      const plannedFollowers = autoFollowPlayerIdsForLeader(party, leaderPlayerId)
        .filter((memberPlayerId) =>
          resolvedAuthorityPlan.expectedFollowers.has(memberPlayerId)
          && (!arrivalPlan || arrivalPlan.positions.has(memberPlayerId))
        );
      let followers = plannedFollowers;
      if (altDoorway && plannedFollowers.length > 0) {
        // Alt doorway: the leader must have earned the right to bring others.
        const hostDecision = await altDoorway.checkHost({
          kind: "party_auto_follow",
          hostPlayerId: leaderPlayerId,
          hostPosition: gameState.getPlayer(leaderPlayerId)?.position ?? null,
          destination: doorwayDestinationForTravel(destination)
        });
        if (!hostDecision.allowed) {
          for (const memberPlayerId of plannedFollowers) {
            sendTravelFailure(memberPlayerId, "party_auto_follow", hostDecision);
          }
          return;
        }
        const linked = await Promise.all(plannedFollowers.map(async (memberPlayerId) => ({
          memberPlayerId,
          decision: await altDoorway.checkLinked({
            kind: "party_auto_follow",
            hostPlayerId: leaderPlayerId,
            guestPlayerId: memberPlayerId
          })
        })));
        followers = linked.flatMap(({ memberPlayerId, decision }) => {
          if (decision.allowed) return [memberPlayerId];
          sendTravelFailure(memberPlayerId, "party_auto_follow", decision);
          return [];
        });
      }
      await Promise.allSettled(followers
        .map(async (memberPlayerId) => {
          const expectedFollower =
            resolvedAuthorityPlan.expectedFollowers.get(memberPlayerId)!;
          const validateFollowAuthority = async ():
            Promise<TravelBlockReason | null> => {
            const currentParty = partyAuthority.partyForPlayer(memberPlayerId);
            const currentRelocationRevision =
              gameState.getPlayer(memberPlayerId)?.relocationRevision;
            if (
              resolvedAuthorityPlan.partyId !== currentParty?.partyId
              || resolvedAuthorityPlan.leaderPlayerId !== currentParty.leaderPlayerId
              || !currentParty.allowTravel
              || !currentParty.autoFollowPlayerIds.includes(memberPlayerId)
              || registry.activeConnectionIdForPlayer(memberPlayerId) !==
                expectedFollower.connectionId
              || currentRelocationRevision !== expectedFollower.relocationRevision
            ) {
              return {
                code: "PARTY_AUTO_FOLLOW_STALE",
                message: "A newer party or travel action replaced this Auto-Follow arrival."
              };
            }
            return null;
          };
          if (await validateFollowAuthority()) return;
          const requestId =
            `party-follow:${transitionEventId}:${memberPlayerId}`.slice(0, 128);
          const result = await performAuthoritativeTravel({
            playerId: memberPlayerId,
            destination,
            requestId,
            arrivalMode: destination.kind === "world"
              ? "ordinary_relocation"
              : "protected_jump",
            kind: "party_auto_follow",
            companionHostPlayerId: leaderPlayerId,
            requireDestinationReady: destination.kind !== "flag",
            ...(leaderChallengeProfile
              ? { capturedChallengeProfile: leaderChallengeProfile }
              : {}),
            validatePreCommit: validateFollowAuthority,
            ...(arrivalPlan?.positions.get(memberPlayerId)
              ? { playerSpawnPosition: arrivalPlan.positions.get(memberPlayerId)! }
              : {})
          });
          if (!result.success && result.reason.code !== "PARTY_AUTO_FOLLOW_STALE") {
            sendTravelFailure(memberPlayerId, "party_auto_follow", result.reason);
          }
        }));
    } finally {
      arrivalPlan?.release();
    }
  };

  return {
    resolveFlagTravelDestination,
    reserveTravelArrivals,
    sendCityScopeForPlayer,
    prepareWorldMapTravelPopulation,
    prepareVisibleFlagVisitPopulation,
    cancelVisibleFlagVisitPopulation: (playerId, preparationId) => {
      const resourcePreparation =
        visibleFlagResourcePreparations.get(playerId);
      const cancelledResource =
        resourcePreparation?.preparationId === preparationId;
      if (cancelledResource) {
        resourcePreparation.abortController.abort(
          new Error("visible flag resource preparation was cancelled")
        );
        visibleFlagResourcePreparations.delete(playerId);
      }
      return (
        visibleFlagTravelReservations?.releasePlayer(
        playerId,
        preparationId
        ) ?? false
      ) || cancelledResource;
    },
    cancelWorldMapTravelPopulation: (playerId, requestId) => {
      const intent = committedPopulationPreparationIntents.get(playerId);
      const cancelledCommitted =
        intent?.requestId === requestId && intent.state === "preparing";
      if (cancelledCommitted) {
        committedPopulationPreparationIntents.delete(playerId);
        intent.cancel("client-cancelled");
      }
      return (
        softTravelReservations?.releasePlayer(playerId, requestId) ?? false
      ) || cancelledCommitted;
    },
    releaseSoftTravelPopulationConnection: (
      connectionId,
      connectionGeneration
    ) => {
      let releasedResources = 0;
      let cancelledCommittedPreparations = 0;
      for (
        const [playerId, intent] of committedPopulationPreparationIntents
      ) {
        if (
          intent.state !== "preparing"
          || intent.connectionId !== connectionId
          || intent.connectionGeneration !== connectionGeneration
        ) continue;
        committedPopulationPreparationIntents.delete(playerId);
        intent.cancel("connection-closed");
        cancelledCommittedPreparations += 1;
      }
      for (const [playerId, preparation] of visibleFlagResourcePreparations) {
        if (
          preparation.connectionId !== connectionId
          || preparation.connectionGeneration !== connectionGeneration
        ) continue;
        preparation.abortController.abort(
          new Error("visible flag resource preparation connection closed")
        );
        visibleFlagResourcePreparations.delete(playerId);
        releasedResources += 1;
      }
      return (
        (softTravelReservations?.releaseConnection(
        connectionId,
        connectionGeneration
        ) ?? 0)
        + (visibleFlagTravelReservations?.releaseConnection(
          connectionId,
          connectionGeneration
        ) ?? 0)
        + releasedResources
        + cancelledCommittedPreparations
      );
    },
    closeSoftTravelPopulation: () => {
      softTravelReservations?.close();
      visibleFlagTravelReservations?.close();
      for (const preparation of visibleFlagResourcePreparations.values()) {
        preparation.abortController.abort(
          new Error("visible flag resource preparation manager closed")
        );
      }
      visibleFlagResourcePreparations.clear();
      for (const intent of committedPopulationPreparationIntents.values()) {
        intent.cancel("manager-closed");
      }
      committedPopulationPreparationIntents.clear();
    },
    applyAuthoritativeTravelPhase1,
    performAuthoritativeTravel,
    sendTravelFailure,
    followPartyLeader
  };
}

type TravelOperationInput = {
  playerId: string;
  destination: ResolvedTravelDestination;
  requestId: string;
  arrivalMode: TravelArrivalMode;
  populationPreparationId?: string;
  requireDestinationReady?: boolean;
  kind:
    | "flag"
    | "city"
    | "invite"
    | "party_manual"
    | "party_auto_follow"
    | "manor_jump"
    | "dev_mine"
    | "dev_teleport"
    | "pet_open_land"
    | "gps_relocate"
    | "whirlpool";
  populationSourceKind?: TravelPopulationSourceKind;
  lastRelocatedAt?: Date | null;
  // GPS relocation cooldown exemption (NATIVE_ANTISPOOF_BUILD_PLAN.md §6).
  relocationCooldown?: "return_home" | "free_repick";
  sendResult?: boolean;
  playerSpawnPosition?: { lat: number; lon: number };
  expectedTollGold?: string;
  /** Administrative, portal, and recovery relocations can explicitly opt out. */
  chargeTravelHunger?: boolean;
  capturedChallengeProfile?: EquipmentChallengeProfile;
  validatePreCommit?: () => Promise<TravelBlockReason | null>;
  /** Forced relocations (the Expel metal) skip the combat and aggression eligibility checks. */
  skipTravelEligibility?: boolean;
  companionHostPlayerId?: string;
  beforePublish?: (client?: pg.PoolClient) => Promise<void>;
  /**
   * Runs inside the relocation persistence transaction (whirlpool fares): a throw
   * rolls the relocation back. Its error code and message become the failure reason.
   */
  chargeInTransaction?: (client: pg.PoolClient) => Promise<void>;
};

function isCodedTravelError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

/**
 * Every travel kind (flag, quick jump, party, auto-follow, invite, pet, dev,
 * manor) must land inside the world edge. Explicit destinations past it are
 * refused; arrival scatter around an edge destination is clamped by GameState.
 */
export function worldEdgeTravelBlock(
  input: Pick<TravelOperationInput, "destination">
): TravelBlockReason | null {
  const points = [
    input.destination.center,
    input.destination.flagCenter,
    input.destination.travelAnchor?.center
  ];
  return points.every((point) => !point || isWithinWorldEdge(point))
    ? null
    : { code: WORLD_EDGE_ERROR_CODE, message: WORLD_EDGE_MESSAGE };
}

function shouldChargeTravelHunger(input: TravelOperationInput): boolean {
  if (input.chargeTravelHunger !== undefined) return input.chargeTravelHunger;
  if (input.destination.kind === "manor") return false;
  return input.kind === "flag"
    || input.kind === "city"
    || input.kind === "invite"
    || input.kind === "party_manual"
    || input.kind === "party_auto_follow";
}

function travelHungerInput(
  input: TravelOperationInput,
  origin: { lat: number; lon: number }
): TravelHungerPersistenceInput {
  return {
    requestId: input.requestId,
    destinationIdentity: JSON.stringify({
      operationKind: input.kind,
      destinationKind: input.destination.kind,
      destinationId: input.destination.id ?? null,
      personalFlagId: input.destination.personalFlagId ?? null,
      center: input.destination.center
    }),
    distanceM: distanceMeters(origin, input.destination.center),
    maxRangeM: TRAVEL_HUNGER_MAX_RANGE_M
  };
}

type TravelPopulationSourceKind = Extract<
  PopulationStreamingSourceKind,
  | "flag-travel"
  | "shrine-travel"
  | "city-travel"
  | "kingdom-travel"
  | "party-travel"
  | "administrative-relocation"
>;

function waitForPopulationPreparationRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const settle = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(settle, 125);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function safeChallengeProfileFingerprint(
  profile: EquipmentChallengeProfile
): string {
  return [
    profile.balanceVersion,
    profile.currentGearLevel,
    profile.unlockedGearLevel,
    profile.tier,
    profile.contributors.melee,
    profile.contributors.chest,
    profile.contributors.secondary
  ].join(":");
}

function worldMapPopulationDestination(
  destination: WorldMapDestination,
  movementLeashRadiusM: number
): ResolvedTravelDestination {
  const center = { lat: destination.lat, lon: destination.lon };
  if (destination.kind === "city") {
    return {
      kind: "city",
      id: destination.id,
      center
    };
  }
  const flagId = destination.kind === "kingdom"
    ? destination.seatId
    : destination.id;
  const resourceVision = {
    ...resourceVisionForFlag({
      flagId,
      flagName: destination.name,
      flagCenter: center,
      movementLeashRadiusM
    }),
    ...(destination.kind === "kingdom"
      ? { destinationKind: "kingdom_seat" as const }
      : {})
  };
  return {
    kind: "flag",
    id: flagId,
    center,
    resourceVision,
    flagName: destination.name,
    flagCenter: center
  };
}

function worldMapPopulationSourceKind(
  destination: WorldMapDestination
): Extract<
  TravelPopulationSourceKind,
  "flag-travel" | "shrine-travel" | "city-travel" | "kingdom-travel"
> {
  switch (destination.kind) {
    case "city": return "city-travel";
    case "kingdom": return "kingdom-travel";
    case "atlas_shrine":
    case "pathfinder_mark": return "shrine-travel";
    case "hollin_hut": return "city-travel";
    case "manor": return "flag-travel";
  }
}

function travelPopulationArea(input: Readonly<{
  config: AppConfig | undefined;
  gameState: GameState;
  playerId: string;
  destination: ResolvedTravelDestination;
}>): GameplayAreaContract {
  const player = gameStatePlayer(input.gameState, input.playerId);
  const configuredVisibleRadiusM =
    input.config?.FLAG_RESOURCE_VISION_RADIUS_M
    ?? DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M;
  const futureVision = input.destination.resourceVision
    ?? (
      input.destination.kind === "flag" && input.destination.id
        ? resourceVisionForFlag({
            flagId: input.destination.id,
            flagName: input.destination.flagName ?? "Flag",
            flagCenter:
              input.destination.flagCenter ?? input.destination.center,
            movementLeashRadiusM: player.moveLeashRadiusM,
            visionRadiusM: input.destination.resourceVisionRadiusM
          })
        : resourceVisionForArea({
            regionCode: packageIdForPosition(input.destination.center),
            position: input.destination.center,
            movementLeashRadiusM: player.moveLeashRadiusM,
            visibleRadiusM: configuredVisibleRadiusM
          })
    );
  const certifiedVisibleRadiusM =
    futureVision?.radiusM ?? configuredVisibleRadiusM;
  const preparationBufferM =
    input.config?.FLAG_PREPARE_BUFFER_M ?? DEFAULT_FLAG_PREPARE_BUFFER_M;
  return {
    center: { ...input.destination.center },
    certifiedVisibleRadiusM,
    preparedRadiusM: Math.max(
      input.config?.FLAG_PREPARE_RADIUS_M ?? DEFAULT_FLAG_PREPARE_RADIUS_M,
      certifiedVisibleRadiusM + preparationBufferM
    ),
    sourceType: futureVision?.destinationKind === "kingdom_seat"
      ? "kingdom_seat"
      : futureVision?.destinationKind === "area"
        ? "area"
        : futureVision
          ? "flag"
          : "player_anchor",
    sourceId: futureVision?.flagId ?? input.playerId,
    generation:
      (input.gameState.getGameplayViewCircle(input.playerId)?.generation ?? 0)
      + 1
  };
}

function populationTravelSourceKind(
  input: TravelOperationInput
): TravelPopulationSourceKind {
  if (
    input.kind === "party_manual"
    || input.kind === "party_auto_follow"
  ) return "party-travel";
  if (input.kind === "city" || input.destination.kind === "city") {
    return "city-travel";
  }
  if (
    input.destination.resourceVision?.destinationKind === "kingdom_seat"
  ) return "kingdom-travel";
  if (
    input.kind === "dev_mine" ||
    input.kind === "dev_teleport" ||
    input.kind === "pet_open_land" ||
    input.kind === "manor_jump" ||
    input.kind === "gps_relocate" ||
    input.kind === "whirlpool"
  ) {
    return "administrative-relocation";
  }
  return "flag-travel";
}

function gameStatePlayer(gameState: GameState, playerId: string) {
  const player = gameState.getPlayer(playerId);
  if (!player) throw new Error("player is not connected");
  return player;
}

function throwIfRelocationAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("authoritative relocation was aborted");
}

function withSafeReleaseDeadline(
  work: Promise<unknown>,
  timeoutMs: number
): Promise<"completed" | "timed-out"> {
  let released = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      released = true;
      resolve("timed-out");
    }, timeoutMs);
    timer.unref?.();
    void work.then(
      () => {
        if (released) return;
        clearTimeout(timer);
        resolve("completed");
      },
      (error: unknown) => {
        if (released) return;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
