import {
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  destinationPoint,
  type FlagSnapshot,
  type HarvestSessionSnapshot,
  type ServerMessage,
  type VisibleFlagDestinationAuthority,
  type WorldMapDestination,
  clampToWorldEdge,
  isFiniteLatLon,
  LOCATION_FIX_REASONS,
  type LocationFixReason,
  attestationRefFromWire,
  parseNativeLocationSignals
} from "@ash-atlas/shared";
import type pg from "pg";

import type { NetworkTelemetry } from "../../auth/networkTelemetry.js";
import type {
  LocationFixEvaluation,
  LocationFixInput,
  LocationReportService
} from "../../auth/trust/trustService.js";
import type { RelocationGate, RelocationZoneDecision } from "../../auth/trust/relocationGate.js";
import type { RelocationExemption, SettlementService } from "../../auth/trust/settlement.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import type { AppConfig } from "../../config.js";
import { gameplayLatencyTrace } from "../../diagnostics/gameplayLatencyTrace.js";
import type { AppLogger } from "../../logger.js";
import type { CityService } from "../../game/cities.js";
import type { CombatEngine } from "../../game/combat/combatEngine.js";
import type { FlagBuildCoordinator } from "../../game/flagBuildCoordinator.js";
import type { FlagRepairCoordinator } from "../../game/flagRepairing.js";
import type { FlagAccessService } from "../../game/flagAccess.js";
import type { FlagService } from "../../game/flags.js";
import type { KingdomService } from "../../game/kingdoms.js";
import type { PlayerService } from "../../game/players.js";
import { resourceVisionForArea } from "../../game/resourceVision.js";
import { packageIdForPosition } from "../../game/spatialZones.js";
import type { GameState } from "../../game/state.js";
import { getTravelBlockReason, type TravelBlockReason } from "../../game/travelEligibility.js";
import type { TravelInviteService } from "../../game/travelInvites.js";
import type { WorldMapService } from "../../game/worldMap.js";
import { MapMarkerError } from "../../game/mapMarkers.js";
import { HollinHutError, type HollinHutService } from "../../game/hollinHuts.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { XoralEventService } from "../../game/xoralEvents.js";
import { resourceVisionForFlag } from "../../game/collectibles.js";
import type { ClassRealtimeState } from "../classRealtimeState.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import type { RelocationPopulationReadiness } from "../populationRealtimeOperations.js";
import type {
  ResolvedTravelDestination,
  TravelArrivalMode,
  TravelArrivalPlan
} from "../travelContracts.js";
export type { ResolvedTravelDestination, TravelArrivalMode } from "../travelContracts.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";

type Position = { lat: number; lon: number };
type PopulationRelocation = Readonly<{
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  relocationRevision: number;
  resourceVisionRevision: number;
  gameplayViewGeneration: number;
  isCurrent(): boolean;
}>;

function sameJumpableStructureAuthority(
  current: { structureId: string; placementRevision: string; type: string; lat: number; lon: number; footprintRadiusM: number },
  expected: { structureId: string; placementRevision: string; type: string; lat: number; lon: number; footprintRadiusM: number }
): boolean {
  return current.structureId === expected.structureId
    && current.placementRevision === expected.placementRevision
    && current.type === expected.type
    && current.lat === expected.lat
    && current.lon === expected.lon
    && current.footprintRadiusM === expected.footprintRadiusM;
}

function resolvedVisibleFlagDestination(
  flag: FlagSnapshot
): ResolvedTravelDestination {
  const center = { lat: flag.lat, lon: flag.lon };
  return {
    kind: "flag",
    id: flag.id,
    center,
    flagName: flag.name,
    flagCenter: center,
    claimRadiusM: flag.claimRadiusM,
    resourceVisionRadiusM: flag.resourceVisionRadiusM,
    ...(flag.controlType === "personal"
      ? {
          personalFlagId: flag.id,
          jumpTollGold: flag.jumpTollGold ?? "0"
        }
      : {})
  };
}

function sameVisibleFlagDestinationAuthority(
  expected: ResolvedTravelDestination,
  current: ResolvedTravelDestination
): boolean {
  return expected.kind === current.kind
    && expected.id === current.id
    && expected.center.lat === current.center.lat
    && expected.center.lon === current.center.lon
    && expected.flagCenter?.lat === current.flagCenter?.lat
    && expected.flagCenter?.lon === current.flagCenter?.lon
    && expected.claimRadiusM === current.claimRadiusM
    && expected.resourceVisionRadiusM === current.resourceVisionRadiusM
    && expected.personalFlagId === current.personalFlagId;
}

function sameSelectedVisibleFlagAuthority(
  expected: VisibleFlagDestinationAuthority,
  current: ResolvedTravelDestination
): boolean {
  return expected.lat === current.center.lat
    && expected.lon === current.center.lon
    && expected.claimRadiusM === current.claimRadiusM
    && expected.resourceVisionRadiusM === current.resourceVisionRadiusM
    && expected.personalFlagId === current.personalFlagId;
}

/**
 * Per-connection passive LOCATION_FIX spacing; faster fixes are dropped
 * silently. Every reason (including legacy pre_action and reason-less fixes)
 * shares one window: max(55 s, TRUST_PASSIVE_FIX_MIN_SECONDS - 5 s).
 */
const PASSIVE_PERIODIC_FIX_FLOOR_MS = 55_000;
const PASSIVE_PERIODIC_FIX_SLACK_MS = 5_000;
const DEFAULT_PASSIVE_FIX_MIN_SECONDS = 180;

export function passivePeriodicFixMinIntervalMs(minSeconds: number | undefined): number {
  const seconds = minSeconds ?? DEFAULT_PASSIVE_FIX_MIN_SECONDS;
  return Math.max(PASSIVE_PERIODIC_FIX_FLOOR_MS, seconds * 1000 - PASSIVE_PERIODIC_FIX_SLACK_MS);
}

/** Passive fix reason, or undefined when absent or not a known value. */
export function locationFixReasonFromWire(value: unknown): LocationFixReason | undefined {
  return typeof value === "string" && (LOCATION_FIX_REASONS as readonly string[]).includes(value)
    ? value as LocationFixReason
    : undefined;
}
const DEVICE_TIME_ZONE_PATTERN = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** IANA time zone from the device, or undefined when absent or malformed. */
// Client address and carrier country for the mismatch signals (A6). The native block
// is parsed leniently; a malformed block only drops the carrier check.
export function mismatchInputFromWire(
  clientIp: string | null | undefined,
  nativeWire: unknown
): Pick<LocationFixInput, "clientIp" | "networkCountryIso"> {
  const parsed = parseNativeLocationSignals(nativeWire);
  const iso = parsed.status === "ok" ? parsed.signals.networkCountryIso : undefined;
  return {
    ...(clientIp ? { clientIp } : {}),
    ...(iso ? { networkCountryIso: iso } : {})
  };
}

// Device trust inputs (A7): the parsed native block, the attestation reference
// and the session that may own it. Malformed values are dropped, never fatal.
export function deviceTrustInputFromWire(
  sessionId: string,
  nativeWire: unknown,
  attestationRefWire: unknown
): Pick<LocationFixInput, "sessionId" | "native" | "attestationRef"> {
  const attestationRef = attestationRefFromWire(attestationRefWire);
  return {
    sessionId,
    native: parseNativeLocationSignals(nativeWire),
    ...(attestationRef === undefined ? {} : { attestationRef })
  };
}

export function deviceTimeZoneFromWire(value: unknown): string | undefined {
  return typeof value === "string" && DEVICE_TIME_ZONE_PATTERN.test(value) ? value : undefined;
}

function wireAccuracyIsValid(accuracy: unknown): boolean {
  return accuracy === undefined || (
    typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0
  );
}

type TravelResult =
  | { success: true; player: ReturnType<GameState["snapshotForPlayer"]> }
  | { success: false; reason: TravelBlockReason };

export type TravelHandlerContext = Readonly<{
  state: RealtimeConnectionState;
  socket: SocketLike;
  authenticatedSession: AuthenticatedSession | null | undefined;
  config?: AppConfig | undefined;
  logger: AppLogger;
  registry: ConnectionRegistry;
  gameState: GameState;
  flagService: FlagService;
  flagAccess?: FlagAccessService | undefined;
  playerService: PlayerService;
  worldRuntime?: WorldRuntime | undefined;
  combat?: CombatEngine | undefined;
  cities?: CityService | undefined;
  kingdoms?: KingdomService | undefined;
  travelInvites?: TravelInviteService | undefined;
  worldMap?: WorldMapService | undefined;
  hollinHuts?: HollinHutService | undefined;
  /** Find Open Land: the spot the owner's Trail Hound just found (one use). */
  takeOpenLandGrant?: ((playerId: string) => Position | null) | undefined;
  /** Voyager: the spot of one of the player's recorded locations (throws unless an active Voyager). */
  recordedTravelTarget?: ((playerId: string, locationId: string) => Promise<Position>) | undefined;
  classRealtimeState: ClassRealtimeState;
  xoralEvents?: XoralEventService | undefined;
  flagBuilds: FlagBuildCoordinator | null;
  flagRepairs?: FlagRepairCoordinator;
  locationReports?: LocationReportService | undefined;
  settlement?: SettlementService | undefined;
  relocationGate?: RelocationGate | undefined;
  connectionNetwork?: NetworkTelemetry | null | undefined;
  // Trusted-proxy client address: IP-geo signals only, never stored or logged.
  connectionIp?: string | null | undefined;
  clientPlatform?: "web" | "ios" | "android" | undefined;
  activeHarvestSessionForPlayer(playerId: string): Promise<HarvestSessionSnapshot | null>;
  beginSmoothTravelTransition(playerId: string, requestId: string): symbol | null;
  endSmoothTravelTransition(
    playerId: string,
    requestId: string,
    transition: symbol,
    outcome: "committed" | "failed",
    releaseReason?: string
  ): boolean;
  followPartyLeader(
    leaderPlayerId: string,
    destination: ResolvedTravelDestination,
    transitionEventId: string,
    arrivalPlan?: Readonly<{
      positions: ReadonlyMap<string, Position>;
      release(): void;
    }> | null
  ): Promise<void>;
  gameplayInterestCenter(playerId: string, fallback: Position): Position;
  gameplayInterestZoneIds(playerId: string, fallback: Position): string[];
  performAuthoritativeTravel(input: {
    playerId: string;
    destination: ResolvedTravelDestination;
    requestId: string;
    arrivalMode: TravelArrivalMode;
    kind:
      | "flag"
      | "city"
      | "invite"
      | "party_manual"
      | "party_auto_follow"
      | "manor_jump"
      | "dev_mine"
      | "pet_open_land"
      | "gps_relocate";
    populationSourceKind?:
      | "flag-travel"
      | "shrine-travel"
      | "city-travel"
      | "kingdom-travel"
      | "party-travel"
      | "administrative-relocation";
    lastRelocatedAt?: Date | null;
    relocationCooldown?: "return_home" | "free_repick";
    sendResult?: boolean;
    playerSpawnPosition?: Position;
    transitionToken?: symbol;
    expectedTollGold?: string;
    chargeTravelHunger?: boolean;
    validatePreCommit?: () => Promise<TravelBlockReason | null>;
    populationPreparationId?: string;
    requireDestinationReady?: boolean;
    beforePublish?: (client?: pg.PoolClient) => Promise<void>;
  }): Promise<TravelResult>;
  prepareWorldMapTravelPopulation(input: Readonly<{
    playerId: string;
    connectionId: string;
    connectionGeneration: number;
    requestId: string;
    destination: WorldMapDestination;
  }>): "admitted" | "skipped";
  resolveFlagTravelDestination(
    flagId: string
  ): Promise<ResolvedTravelDestination | null>;
  reserveTravelArrivals(
    destination: ResolvedTravelDestination,
    arrivingPlayerIds: readonly string[]
  ): TravelArrivalPlan | null;
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
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
  schedulePopulationV2RelocationForActivePlayer(
    playerId: string,
    trigger:
      | "world-entry"
      | "reconnect"
      | "flag-travel"
      | "party-travel"
      | "flag-placement"
      | "separate-space-exit"
      | "administrative-relocation"
      | "explicit-relocation",
    expectedConnection?: Readonly<{
      connectionId: string;
      connectionGeneration: number;
      requestId?: string;
    }>
  ): PopulationRelocation | null;
  sendCityScopeForPlayer(playerId: string, position: Position, isCurrent?: () => boolean): Promise<void>;
  sendCollectiblesForPlayer(
    player: ReturnType<GameState["getPlayer"]>,
    isCurrent?: () => boolean
  ): Promise<void>;
  sendCombatError(
    socket: SocketLike,
    requestId: string,
    code: string,
    message: string,
    details?: {
      retryAfterMs?: number;
      retryable?: boolean;
      currentTollGold?: string;
      requiredGold?: string;
    }
  ): void;
  sendCombatScopeSnapshot(playerId: string): void;
  sendDroppedItemsToSocket(playerId: string, isCurrent?: () => boolean): Promise<void>;
  sendManorsForPlayer(player: ReturnType<GameState["getPlayer"]>): Promise<void>;
  sendTravelInboxForPlayers(playerIds: Iterable<string>, isCurrent?: () => boolean): Promise<void>;
  syncCombatPlayerAfterRelocation(player: ReturnType<GameState["snapshotForPlayer"]>): void;
  waitForRelocationPopulationV2(input: Readonly<{
    playerId: string;
    requestId: string;
    destination: Position;
    transitionToken: symbol;
    relocation: PopulationRelocation | null;
  }>): Promise<RelocationPopulationReadiness>;
}>;

export function createTravelHandler(
  context: TravelHandlerContext
): RealtimeFamilyHandler<"travel"> {
  let acceptedVisibleFlagPreparation: Readonly<{
    preparationId: string;
    flagId: string;
    destination: ResolvedTravelDestination;
    arrivalReservation: TravelArrivalPlan;
    expiresAt: number;
  }> | null = null;
  const releaseAcceptedVisibleFlagPreparation = (): void => {
    acceptedVisibleFlagPreparation?.arrivalReservation.release();
    acceptedVisibleFlagPreparation = null;
  };
  let lastPassiveLocationFixAt = Number.NEGATIVE_INFINITY;
  const recordPassiveLocationFix = async (
    message: Extract<Parameters<RealtimeFamilyHandler<"travel">>[0], { type: "LOCATION_FIX" }>
  ): Promise<void> => {
    // Trust ledger only: no reply and no avatar movement. The only gameplay
    // effect is a transit hold, which binds only when TRUST_LAND_ACTION_MODE=enforce.
    const { state, authenticatedSession, config, logger, gameState, locationReports } = context;
    const reason = locationFixReasonFromWire(message.reason);
    const minIntervalMs = passivePeriodicFixMinIntervalMs(config?.TRUST_PASSIVE_FIX_MIN_SECONDS);
    const now = Date.now();
    if (now - lastPassiveLocationFixAt < minIntervalMs) return;
    lastPassiveLocationFixAt = now;
    const playerId = state.playerId;
    if (
      !config?.TRUST_PASSIVE_FIX_ENABLED ||
      !locationReports ||
      !playerId ||
      !authenticatedSession ||
      !isFiniteLatLon(message.lat, message.lon) ||
      !wireAccuracyIsValid(message.accuracy)
    ) return;
    const deviceTimeZone = deviceTimeZoneFromWire(message.deviceTimeZone);
    const avatar = gameState.getPlayer(playerId)?.position ?? null;
    const fixInput: LocationFixInput = {
      accountId: authenticatedSession.account.id,
      playerId,
      source: "passive",
      lat: message.lat as number,
      lon: message.lon as number,
      ...(typeof message.accuracy === "number" ? { accuracyM: message.accuracy } : {}),
      ...(context.clientPlatform === undefined ? {} : { clientPlatform: context.clientPlatform }),
      deviceInstallationId: authenticatedSession.deviceInstallationId,
      networkHash: context.connectionNetwork?.networkHash ?? null,
      networkPrefixHash: context.connectionNetwork?.networkPrefixHash ?? null,
      ...(deviceTimeZone === undefined ? {} : { deviceTimeZone }),
      ...mismatchInputFromWire(context.connectionIp, message.native),
      ...deviceTrustInputFromWire(authenticatedSession.sessionId, message.native, message.attestationRef),
      ...(reason === undefined ? {} : { fixReason: reason }),
      avatarPosition: avatar ? { lat: avatar.lat, lon: avatar.lon } : null
    };
    try {
      const evaluation = await locationReports.evaluate(fixInput);
      // Passive fixes may set transit holds only, never relocation cooldowns.
      const transitHold = evaluation.holdReason === "transit" && evaluation.holdUntil !== null;
      await locationReports.record(
        fixInput,
        transitHold ? evaluation : { ...evaluation, holdUntil: null, holdReason: null },
        "accepted"
      );
    } catch (error) {
      logger.warn(
        { err: error, playerId, accountId: authenticatedSession.account.id },
        "Passive location fix could not be recorded"
      );
    }
  };
  return async (message) => {
    switch (message.type) {
      case "LOCATION_FIX":
        await recordPassiveLocationFix(message);
        return;
    }
    const {
      state,
      socket,
      authenticatedSession,
      config,
      logger,
      registry,
      gameState,
      flagService,
      flagAccess,
      worldRuntime,
      combat,
      cities,
      kingdoms,
      worldMap,
      hollinHuts,
      takeOpenLandGrant,
      recordedTravelTarget,
      classRealtimeState,
      xoralEvents,
      flagBuilds,
      flagRepairs,
      activeHarvestSessionForPlayer,
      beginSmoothTravelTransition,
      endSmoothTravelTransition,
      playerService,
      performAuthoritativeTravel,
      resolveFlagTravelDestination,
      reserveTravelArrivals,
      prepareVisibleFlagVisitPopulation,
      cancelVisibleFlagVisitPopulation,
      prepareWorldMapTravelPopulation,
      cancelWorldMapTravelPopulation,
      safeSendServerMessage,
      sendCombatError,
      locationReports,
      connectionNetwork,
      connectionIp,
      clientPlatform
    } = context;
    const sendTravelBlockAsCombatError = (
      targetSocket: SocketLike,
      requestId: string,
      reason: TravelBlockReason
    ): void => {
      sendCombatError(
        targetSocket,
        requestId,
        reason.code === "TRAVEL_AGGRESSIVE"
          ? "FLAG_VISIT_AGGRESSIVE"
          : reason.code === "TRAVEL_ACTION_PENDING"
            ? "FLAG_VISIT_ACTION_PENDING"
            : reason.code,
        reason.message,
        {
          ...(reason.retryable === undefined ? {} : { retryable: reason.retryable }),
          ...(reason.retryAfterMs === undefined ? {} : { retryAfterMs: reason.retryAfterMs }),
          ...(reason.currentTollGold === undefined ? {} : { currentTollGold: reason.currentTollGold }),
          ...(reason.requiredGold === undefined ? {} : { requiredGold: reason.requiredGold }),
          ...(reason.relocationRevision === undefined ? {} : { relocationRevision: reason.relocationRevision }),
          ...(reason.resourceVisionRevision === undefined ? {} : { resourceVisionRevision: reason.resourceVisionRevision }),
          ...(reason.gameplayViewGeneration === undefined ? {} : { gameplayViewGeneration: reason.gameplayViewGeneration })
        }
      );
    };
    const validateVisibleFlagAuthority = async (input: Readonly<{
      accessFlagId?: string;
      expectedConnectionGeneration?: number;
      expectedGameplayViewGeneration?: number;
      expectedResourceVisionRevision?: number;
      expectedFlagSetRevision?: number;
      expectedDestination?: VisibleFlagDestinationAuthority;
      currentDestination?: ResolvedTravelDestination;
      expectedTollGold?: string;
    }>): Promise<TravelBlockReason | null> => {
      const playerId = state.playerId;
      if (!playerId) {
        return {
          code: "VISIBLE_FLAG_PLAYER_INACTIVE",
          message: "The active gameplay player is unavailable."
        };
      }
      const player = gameState.getPlayer(playerId);
      if (!player?.online || !gameState.isWorldPresent(playerId)) {
        return {
          code: "VISIBLE_FLAG_PLAYER_INACTIVE",
          message: "The active gameplay player is unavailable."
        };
      }
      if (
        !state.connectionId
        || state.connectionGeneration === null
        || (
          input.expectedConnectionGeneration !== undefined
          && input.expectedConnectionGeneration !== state.connectionGeneration
        )
        || !registry.isActivePlayerConnection(
          playerId,
          state.connectionId
        )
      ) {
        return {
          code: "VISIBLE_FLAG_CONNECTION_STALE",
          message: "The gameplay connection changed. Select the flag again."
        };
      }
      // Population adoption can advance the view generation without changing the
      // player's connection, Resource Vision, visible flags, or destination.
      // Those exact authorities are validated below, so generation alone is not stale.
      const currentResourceVisionRevision =
        gameState.getResourceVisionRevision(playerId);
      if (
        input.expectedResourceVisionRevision !== undefined
        && currentResourceVisionRevision !== input.expectedResourceVisionRevision
      ) return {
        code: "VISIBLE_FLAG_RESOURCE_VISION_STALE",
        message: "The map updated before travel completed.",
        retryable: true,
        relocationRevision: player.relocationRevision ?? 0,
        resourceVisionRevision: currentResourceVisionRevision,
        gameplayViewGeneration:
          gameState.getGameplayViewCircle(playerId)?.generation ?? 0
      };
      if (input.expectedDestination) {
        if (
          !input.currentDestination
          || !sameSelectedVisibleFlagAuthority(
            input.expectedDestination,
            input.currentDestination
          )
        ) {
          return {
            code: "VISIBLE_FLAG_DESTINATION_STALE",
            message: "That flag changed after it was selected. Select it again."
          };
        }
      } else {
        const flagSetRevision =
          typeof flagService.currentFlagSetRevision === "function"
            ? await flagService.currentFlagSetRevision()
            : input.expectedFlagSetRevision ?? 0;
        if (
          input.expectedFlagSetRevision !== undefined
          && input.expectedFlagSetRevision !== flagSetRevision
        ) {
          return {
            code: "VISIBLE_FLAG_SET_STALE",
            message: "The visible flag set changed. Select the flag again."
          };
        }
      }
      if (input.accessFlagId && flagAccess) {
        const authorization = await flagAccess.authorize(
          input.accessFlagId,
          playerId
        );
        if (!authorization.decision.allowed) {
          return {
            code: authorization.decision.reasonCode,
            message: "You do not currently have access to that flag."
          };
        }
        if (
          input.expectedTollGold !== undefined
          && input.expectedTollGold !== authorization.decision.tollGold
        ) {
          return {
            code: "FLAG_TOLL_CHANGED",
            message: "The flag toll changed. Review it and try again.",
            currentTollGold: authorization.decision.tollGold,
            requiredGold: authorization.decision.tollGold
          };
        }
      }
      return null;
    };
    if (
      state.playerId &&
      !message.type.startsWith("CANCEL_") &&
      gameState.isMovementBlocked(state.playerId, "city-construction")
    ) {
      const cancelled = await cities?.structures?.cancelOilWellConstruction(
        state.playerId,
        "travel"
      ) ?? null;
      if (cancelled) {
        gameState.setMovementBlocked(
          state.playerId,
          false,
          "city-construction"
        );
        registry.broadcast({
          type: "CITY_FACILITY_CHANGED",
          requestId: message.requestId,
          structure: cancelled.structure,
          ...(cancelled.droppedItems
            ? { droppedItems: cancelled.droppedItems }
            : {})
        });
        registry.send(state.playerId, {
          type: "OWNER_OIL_WELL_PROJECTION",
          structure: null
        });
        if (cancelled.inventory) {
          registry.send(state.playerId, {
            type: "PLAYER_RESOURCES_UPDATED",
            playerId: state.playerId,
            inventory: cancelled.inventory,
            serverTime: Date.now()
          });
        }
      }
    }
    if (
      state.playerId &&
      (message.type.startsWith("VISIT_") ||
        message.type === "PREPARE_VISIBLE_FLAG_VISIT" ||
        message.type === "COMMIT_VISIBLE_FLAG_VISIT" ||
        message.type === "PREPARE_WORLD_MAP_TRAVEL")
    ) {
      flagRepairs?.cancelPlayer(state.playerId, "travel");
    }
    switch (message.type) {
      case "RELOCATE_TO_CURRENT_LOCATION": {
        requireHello(state.playerId);
        const playerId = state.playerId;
        const sendRelocationResult = (input: {
          success: boolean;
          message: string;
          retryAfterMs?: number;
          relocationAvailableAt?: number | null;
          travelInviteAvailableAt?: number | null;
          relocationExemptionAvailable?: boolean;
          player?: ReturnType<GameState["snapshotForPlayer"]>;
          resourceVisionRevision?: number;
        }): void => {
          safeSendServerMessage(socket, {
            type: "TRAVEL_RESULT",
            requestId: message.requestId,
            kind: "gps_relocate",
            success: input.success,
            message: input.message,
            ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
            ...(input.relocationAvailableAt === undefined
              ? {}
              : { relocationAvailableAt: input.relocationAvailableAt }),
            ...(input.travelInviteAvailableAt === undefined
              ? {}
              : { travelInviteAvailableAt: input.travelInviteAvailableAt }),
            ...(input.relocationExemptionAvailable === undefined
              ? {}
              : { relocationExemptionAvailable: input.relocationExemptionAvailable }),
            ...(input.player === undefined ? {} : { player: input.player }),
            ...(input.resourceVisionRevision === undefined
              ? {}
              : { resourceVisionRevision: input.resourceVisionRevision })
          }, logger, { playerId, requestId: message.requestId });
        };
        const malformed = !isFiniteLatLon(message.lat, message.lon) || (
          message.accuracy !== undefined &&
          (typeof message.accuracy !== "number" ||
            !Number.isFinite(message.accuracy) ||
            message.accuracy < 0)
        );
        if (malformed) {
          logger.warn(
            {
              playerId,
              requestId: message.requestId,
              latitude: message.lat,
              longitude: message.lon,
              accuracy: message.accuracy
            },
            "GPS relocation rejected malformed device coordinates"
          );
          sendRelocationResult({
            success: false,
            message: "Your device returned an invalid location. Try again."
          });
          return;
        }
        if (
          !worldRuntime ||
          !state.connectionId ||
          !authenticatedSession ||
          !gameState.isWorldPresent(playerId)
        ) {
          logger.warn(
            { playerId, requestId: message.requestId },
            "GPS relocation rejected because the world session is unavailable"
          );
          sendRelocationResult({
            success: false,
            message: "Relocate is available from the World Map only."
          });
          return;
        }
        const relocationGate = context.relocationGate;
        if (relocationGate) {
          let platformRefusal: string | null = null;
          try {
            platformRefusal = await relocationGate.checkPlatform({
              accountId: authenticatedSession.account.id,
              clientPlatform
            });
          } catch (error) {
            logger.warn(
              { err: error, playerId, requestId: message.requestId },
              "GPS relocation platform check failed"
            );
          }
          if (platformRefusal) {
            logger.warn(
              { playerId, requestId: message.requestId, clientPlatform },
              "GPS relocation refused outside the phone app"
            );
            sendRelocationResult({ success: false, message: platformRefusal });
            return;
          }
        }
        let cooldownExemption: RelocationExemption | null = null;
        let zoneDecision: RelocationZoneDecision | null = null;
        let relocationCommitted = false;
        const releaseClaims = async (): Promise<void> => {
          await cooldownExemption?.release().catch((error: unknown) => {
            logger.warn({ err: error, playerId }, "Free re-pick claim could not be released");
          });
          if (zoneDecision?.allowed) {
            await zoneDecision.release().catch((error: unknown) => {
              logger.warn({ err: error, playerId }, "Alert-zone allowance could not be released");
            });
          }
        };
        try {
          const status = await playerService.relocationStatus(playerId);
          const inCooldown = status.relocationAvailableAt !== null &&
            status.relocationAvailableAt > status.serverTime;
          if (context.settlement) {
            try {
              cooldownExemption = await context.settlement.relocationExemption({
                accountId: authenticatedSession.account.id,
                lat: message.lat as number,
                lon: message.lon as number,
                inCooldown,
                lastRelocatedAt: status.lastRelocatedAt
              });
            } catch (error) {
              logger.warn(
                { err: error, playerId, requestId: message.requestId },
                "GPS relocation cooldown exemption could not be checked"
              );
            }
          }
          if (inCooldown && !cooldownExemption && status.relocationAvailableAt !== null) {
            const retryAfterMs = status.relocationAvailableAt - status.serverTime;
            logger.warn(
              { playerId, requestId: message.requestId, retryAfterMs },
              "GPS relocation rejected during cooldown"
            );
            let relocationExemptionAvailable: boolean | undefined;
            if (context.settlement) {
              relocationExemptionAvailable = await context.settlement
                .relocationExemptionAvailable(authenticatedSession.account.id, status.lastRelocatedAt)
                .catch(() => undefined);
            }
            sendRelocationResult({
              success: false,
              message: "You can relocate again after the 7-day cooldown.",
              retryAfterMs,
              relocationAvailableAt: status.relocationAvailableAt,
              travelInviteAvailableAt: status.travelInviteAvailableAt,
              ...(relocationExemptionAvailable === undefined ? {} : { relocationExemptionAvailable })
            });
            return;
          }
          const previousCoordinates = gameState.getPlayer(playerId)?.position ?? null;
          const relocationTimeZone = deviceTimeZoneFromWire(message.deviceTimeZone);
          // Location trust ledger. Failures here never change the relocation outcome.
          const fixInput: LocationFixInput | null = locationReports
            ? {
                accountId: authenticatedSession.account.id,
                playerId,
                source: "relocation",
                requestId: message.requestId,
                lat: message.lat as number,
                lon: message.lon as number,
                ...(typeof message.accuracy === "number" ? { accuracyM: message.accuracy } : {}),
                ...(clientPlatform === undefined ? {} : { clientPlatform }),
                deviceInstallationId: authenticatedSession.deviceInstallationId,
                networkHash: connectionNetwork?.networkHash ?? null,
                networkPrefixHash: connectionNetwork?.networkPrefixHash ?? null,
                ...(relocationTimeZone === undefined ? {} : { deviceTimeZone: relocationTimeZone }),
                ...mismatchInputFromWire(connectionIp, message.native),
                ...deviceTrustInputFromWire(authenticatedSession.sessionId, message.native, message.attestationRef),
                avatarPosition: previousCoordinates
                  ? { lat: previousCoordinates.lat, lon: previousCoordinates.lon }
                  : null
              }
            : null;
          let fixEvaluation: LocationFixEvaluation | null = null;
          if (locationReports && fixInput) {
            try {
              fixEvaluation = await locationReports.evaluate(fixInput);
            } catch (error) {
              logger.warn(
                { err: error, playerId, requestId: message.requestId },
                "GPS relocation trust evaluation failed"
              );
            }
          }
          const recordLocationReport = async (
            outcome: "accepted" | "travel_failed"
          ): Promise<void> => {
            if (!locationReports || !fixInput || !fixEvaluation) return;
            try {
              await locationReports.record(fixInput, fixEvaluation, outcome);
              if (outcome === "accepted" && fixEvaluation.holdUntil) {
                await context.sendTravelInboxForPlayers([playerId]);
              }
            } catch (error) {
              logger.warn(
                { err: error, playerId, requestId: message.requestId },
                "GPS relocation trust report could not be recorded"
              );
            }
          };
          if (fixEvaluation?.verdict === "rejected") {
            logger.warn(
              {
                playerId,
                accountId: authenticatedSession.account.id,
                requestId: message.requestId,
                reason: fixEvaluation.reason,
                impliedKmh: fixEvaluation.impliedKmh
              },
              "GPS relocation rejected by location trust"
            );
            // A rejected fix never skips the alert zone: red still files the
            // alert + signal and locks a brand-new account (enforce).
            let refusedZone: Awaited<ReturnType<RelocationGate["checkRefusedDestination"]>> = { message: null };
            if (relocationGate) {
              try {
                refusedZone = await relocationGate.checkRefusedDestination({
                  accountId: authenticatedSession.account.id,
                  lat: message.lat as number,
                  lon: message.lon as number
                });
              } catch (error) {
                logger.warn(
                  { err: error, playerId, requestId: message.requestId },
                  "GPS relocation alert-zone check failed"
                );
              }
            }
            sendRelocationResult({
              success: false,
              message: refusedZone.message ?? "Your device location could not be confirmed. Try again later."
            });
            await cooldownExemption?.release().catch(() => undefined);
            await recordLocationReport("travel_failed");
            if (refusedZone.afterRefusal) void refusedZone.afterRefusal().catch(() => undefined);
            return;
          }
          if (relocationGate) {
            try {
              zoneDecision = await relocationGate.checkDestination({
                accountId: authenticatedSession.account.id,
                lat: message.lat as number,
                lon: message.lon as number
              });
            } catch (error) {
              logger.warn(
                { err: error, playerId, requestId: message.requestId },
                "GPS relocation alert-zone check failed"
              );
            }
            if (zoneDecision && !zoneDecision.allowed) {
              const afterRefusal = zoneDecision.afterRefusal;
              logger.warn(
                {
                  playerId,
                  accountId: authenticatedSession.account.id,
                  requestId: message.requestId,
                  accountLocked: afterRefusal !== undefined
                },
                "GPS relocation refused by alert zone"
              );
              sendRelocationResult({ success: false, message: zoneDecision.message });
              // Refused relocations never use the cooldown or a free re-pick.
              await cooldownExemption?.release().catch(() => undefined);
              await recordLocationReport("travel_failed");
              // A locked account's connections close after the answer. Not
              // awaited: the close runs this same connection's close handlers.
              if (afterRefusal) void afterRefusal().catch(() => undefined);
              return;
            }
          }
          const destination: ResolvedTravelDestination = {
            kind: "world",
            id: null,
            // A phone near a pole relocates to the nearest point on the world edge.
            center: clampToWorldEdge({ lat: message.lat as number, lon: message.lon as number })
          };
          const result = await performAuthoritativeTravel({
            playerId,
            destination,
            requestId: message.requestId,
            arrivalMode: "ordinary_relocation",
            kind: "gps_relocate",
            chargeTravelHunger: false,
            populationSourceKind: "administrative-relocation",
            lastRelocatedAt: status.lastRelocatedAt,
            ...(cooldownExemption ? { relocationCooldown: cooldownExemption.kind } : {})
          });
          if (!result.success) {
            await releaseClaims();
            logger.warn(
              {
                playerId,
                accountId: authenticatedSession.account.id,
                requestId: message.requestId,
                reason: result.reason.code,
                previousCoordinates,
                newCoordinates: destination.center,
                reportedAccuracy: message.accuracy
              },
              "GPS relocation failed"
            );
            const nextStatus = await playerService.relocationStatus(playerId);
            sendRelocationResult({
              success: false,
              message: result.reason.message,
              ...(result.reason.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: result.reason.retryAfterMs }),
              relocationAvailableAt: nextStatus.relocationAvailableAt,
              travelInviteAvailableAt: nextStatus.travelInviteAvailableAt
            });
            await recordLocationReport("travel_failed");
            return;
          }
          relocationCommitted = true;
          await recordLocationReport("accepted");
          // After the report: the home move may re-roll targets that the zone
          // difficulty then rescales.
          if (zoneDecision?.allowed) await zoneDecision.committed();
          // Refresh the client's cooldown + exemption hint (free re-pick window).
          if (context.settlement && !fixEvaluation?.holdUntil) {
            await context.sendTravelInboxForPlayers([playerId]).catch(() => undefined);
          }
          logger.info(
            {
              playerId,
              accountId: authenticatedSession.account.id,
              requestId: message.requestId,
              previousCoordinates,
              newCoordinates: destination.center,
              reportedAccuracy: message.accuracy,
              timestamp: new Date().toISOString()
            },
            "GPS relocation completed"
          );
        } catch (error) {
          if (!relocationCommitted) await releaseClaims();
          logger.warn(
            { err: error, playerId, requestId: message.requestId },
            "GPS relocation request failed"
          );
          sendRelocationResult({
            success: false,
            message: "Your relocation could not be completed. Try again."
          });
        }
        return;
      }
      case "PREPARE_VISIBLE_FLAG_VISIT": {
        requireHello(state.playerId);
        releaseAcceptedVisibleFlagPreparation();
        if (
          !worldRuntime
          || !state.connectionId
          || state.connectionGeneration === null
          || !authenticatedSession
        ) {
          sendCombatError(
            socket,
            message.requestId,
            "WORLD_RUNTIME_UNAVAILABLE",
            "World runtime is unavailable"
          );
          return;
        }
        const travelBlock = getTravelBlockReason({
          playerId: state.playerId,
          gameState,
          worldRuntime,
          ...(combat ? { combat } : {}),
          hasActiveClassMutation: (id) =>
            classRealtimeState.hasActiveMutation(id),
          xoralExitRole: (id) => xoralEvents?.exitRole(id) ?? null
        });
        if (travelBlock) {
          sendTravelBlockAsCombatError(socket, message.requestId, travelBlock);
          return;
        }
        if (flagBuilds?.activeForPlayer(state.playerId)) {
          sendCombatError(
            socket,
            message.requestId,
            "TRAVEL_CONSTRUCTION_ACTIVE",
            "Finish or cancel the current flag build before travelling."
          );
          return;
        }
        if (await activeHarvestSessionForPlayer(state.playerId)) {
          sendCombatError(
            socket,
            message.requestId,
            "TRAVEL_HARVEST_ACTIVE",
            "Finish or cancel the current harvest before travelling."
          );
          return;
        }
        const flagDestination =
          await resolveFlagTravelDestination(message.flagId);
        const kingdomSeat = flagDestination
          ? null
          : await kingdoms?.getSeatTravelDestination(message.flagId) ?? null;
        const destination: ResolvedTravelDestination | null =
          flagDestination ?? (kingdomSeat
            ? {
                kind: "flag",
                id: kingdomSeat.id,
                center: { lat: kingdomSeat.lat, lon: kingdomSeat.lon },
                flagName: kingdomSeat.name,
                flagCenter: { lat: kingdomSeat.lat, lon: kingdomSeat.lon },
                claimRadiusM: kingdomSeat.claimRadiusM
              }
            : null);
        if (!destination) {
          sendCombatError(
            socket,
            message.requestId,
            "FLAG_NOT_FOUND",
            "Flag does not exist"
          );
          return;
        }
        const authorityFailure = await validateVisibleFlagAuthority({
          ...(destination.personalFlagId
            ? { accessFlagId: destination.personalFlagId }
            : {}),
          expectedConnectionGeneration:
            message.expectedConnectionGeneration,
          expectedGameplayViewGeneration:
            message.expectedGameplayViewGeneration,
          expectedResourceVisionRevision:
            message.expectedResourceVisionRevision,
          expectedFlagSetRevision: message.expectedFlagSetRevision,
          ...(message.expectedDestination === undefined
            ? {}
            : {
                expectedDestination: message.expectedDestination,
                currentDestination: destination
              }),
          ...(message.expectedTollGold === undefined
            ? {}
            : { expectedTollGold: message.expectedTollGold })
        });
        if (authorityFailure) {
          sendTravelBlockAsCombatError(
            socket,
            message.requestId,
            authorityFailure
          );
          return;
        }
        const arrivalReservation = reserveTravelArrivals(
          destination,
          [state.playerId]
        );
        const playerSpawnPosition = arrivalReservation?.positions.get(
          state.playerId
        );
        if (!arrivalReservation || !playerSpawnPosition) {
          arrivalReservation?.release();
          sendCombatError(
            socket,
            message.requestId,
            "FLAG_ARRIVAL_UNAVAILABLE",
            "A safe arrival position is unavailable."
          );
          return;
        }
        const expiresInMs =
          config?.FLAG_VISIBLE_VISIT_PREPARATION_TTL_MS ?? 15_000;
        acceptedVisibleFlagPreparation = {
          preparationId: message.requestId,
          flagId: message.flagId,
          destination,
          arrivalReservation,
          expiresAt: Date.now() + expiresInMs
        };
        prepareVisibleFlagVisitPopulation({
          playerId: state.playerId,
          connectionId: state.connectionId,
          connectionGeneration: state.connectionGeneration,
          preparationId: message.requestId,
          destination
        });
        if (
          registry.connectionSupports(
            state.connectionId,
            "prepared-flag-arrival-v1"
          ) && !safeSendServerMessage(socket, {
            type: "VISIBLE_FLAG_VISIT_PREPARED",
            requestId: message.requestId,
            flagId: message.flagId,
            playerSpawnPosition,
            expiresInMs
          }, logger, {
            playerId: state.playerId,
            flagId: message.flagId
          })
        ) {
          cancelVisibleFlagVisitPopulation(state.playerId, message.requestId);
          releaseAcceptedVisibleFlagPreparation();
          return;
        }
        gameplayLatencyTrace.record(state.playerId, {
          traceId: message.requestId,
          source: "game",
          category: "population",
          name: "visible_flag_durable_preparation_started",
          details: {
            flagId: message.flagId,
            connectionGeneration: state.connectionGeneration,
            gameplayViewGeneration:
              message.expectedGameplayViewGeneration,
            resourceVisionRevision:
              message.expectedResourceVisionRevision,
            flagSetRevision: message.expectedFlagSetRevision
          }
        });
        return;
      }
      case "CANCEL_VISIBLE_FLAG_VISIT": {
        requireHello(state.playerId);
        if (
          acceptedVisibleFlagPreparation?.preparationId === message.requestId
        ) {
          releaseAcceptedVisibleFlagPreparation();
        }
        cancelVisibleFlagVisitPopulation(
          state.playerId,
          message.requestId
        );
        return;
      }
      case "PREPARE_WORLD_MAP_TRAVEL": {
        requireHello(state.playerId);
        if (
          !worldMap ||
          !worldRuntime ||
          !state.connectionId ||
          state.connectionGeneration === null ||
          !authenticatedSession
        ) {
          sendCombatError(
            socket,
            message.requestId,
            "WORLD_RUNTIME_UNAVAILABLE",
            "World Map travel is unavailable"
          );
          return;
        }
        const travelBlock = getTravelBlockReason({
          playerId: state.playerId,
          gameState,
          worldRuntime,
          ...(combat ? { combat } : {}),
          hasActiveClassMutation: (id) => classRealtimeState.hasActiveMutation(id),
          xoralExitRole: (id) => xoralEvents?.exitRole(id) ?? null
        });
        if (travelBlock) {
          sendTravelBlockAsCombatError(socket, message.requestId, travelBlock);
          return;
        }
        if (flagBuilds?.activeForPlayer(state.playerId)) {
          sendCombatError(
            socket,
            message.requestId,
            "TRAVEL_CONSTRUCTION_ACTIVE",
            "Finish or cancel the current flag build before travelling."
          );
          return;
        }
        if (await activeHarvestSessionForPlayer(state.playerId)) {
          sendCombatError(
            socket,
            message.requestId,
            "TRAVEL_HARVEST_ACTIVE",
            "Finish or cancel the current harvest before travelling."
          );
          return;
        }
        const destination = (await worldMap.snapshot(state.playerId))
          .destinations
          .find((candidate) =>
            candidate.kind === message.destinationKind &&
            candidate.id === message.destinationId
          );
        if (!destination) {
          sendCombatError(
            socket,
            message.requestId,
            "WORLD_MAP_DESTINATION_UNAVAILABLE",
            "That World Map destination is no longer available."
          );
          return;
        }
        prepareWorldMapTravelPopulation({
          playerId: state.playerId,
          connectionId: state.connectionId,
          connectionGeneration: state.connectionGeneration,
          requestId: message.requestId,
          destination
        });
        return;
      }
      case "CANCEL_WORLD_MAP_TRAVEL": {
        requireHello(state.playerId);
        cancelWorldMapTravelPopulation(state.playerId, message.requestId);
        return;
      }
      case "VISIT_OPEN_LAND":
      case "VISIT_RECORDED_LOCATION":
      case "VISIT_WORLD_MAP_HOLLIN_HUT": {
        requireHello(state.playerId);
        // Find Open Land travels exactly like a World Map destination jump, to the spot the
        // Trail Hound found (granted server-side, one use).
        if (worldRuntime?.hasPlayerWorldTransition(state.playerId)) {
          sendCombatError(socket, message.requestId, "PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is already pending");
          return;
        }
        if (!worldRuntime || !state.connectionId || !authenticatedSession ||
          (message.type === "VISIT_WORLD_MAP_HOLLIN_HUT" ? !hollinHuts : message.type === "VISIT_RECORDED_LOCATION" ? !recordedTravelTarget : !takeOpenLandGrant)) {
          sendCombatError(socket, message.requestId, "WORLD_RUNTIME_UNAVAILABLE", "World runtime is unavailable");
          return;
        }
        const transitionToken = beginSmoothTravelTransition(state.playerId, message.requestId);
        if (!transitionToken) {
          sendCombatError(socket, message.requestId, "PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is already pending");
          return;
        }
        let transitionDelegated = false;
        try {
          const travelBlock = getTravelBlockReason({
            playerId: state.playerId,
            gameState,
            worldRuntime,
            ...(combat ? { combat } : {}),
            hasActiveClassMutation: (id) => classRealtimeState.hasActiveMutation(id),
            xoralExitRole: (id) => xoralEvents?.exitRole(id) ?? null
          });
          if (travelBlock) {
            sendTravelBlockAsCombatError(socket, message.requestId, travelBlock);
            return;
          }
          if (flagBuilds?.activeForPlayer(state.playerId)) {
            sendCombatError(socket, message.requestId, "TRAVEL_CONSTRUCTION_ACTIVE", "Finish or cancel the current flag build before travelling.");
            return;
          }
          if (await activeHarvestSessionForPlayer(state.playerId)) {
            sendCombatError(socket, message.requestId, "TRAVEL_HARVEST_ACTIVE", "Finish or cancel the current harvest before travelling.");
            return;
          }
          let hutCenter: Position;
          try {
            if (message.type === "VISIT_OPEN_LAND") {
              const found = takeOpenLandGrant!(state.playerId);
              if (!found) {
                sendCombatError(socket, message.requestId, "OPEN_LAND_EXPIRED", "Use Find Open Land again to pick a spot.");
                return;
              }
              hutCenter = found;
            } else if (message.type === "VISIT_RECORDED_LOCATION") {
              hutCenter = await recordedTravelTarget!(state.playerId, message.locationId);
            } else {
              hutCenter = await hollinHuts!.visitTarget(state.playerId, message.hutId);
            }
          } catch (error) {
            sendCombatError(
              socket,
              message.requestId,
              error instanceof HollinHutError || error instanceof MapMarkerError ? error.code : "HOLLIN_VISIT_FAILED",
              error instanceof Error ? error.message : "That Hollin Hut cannot be visited."
            );
            return;
          }
          const connectedPlayer = gameState.getPlayer(state.playerId);
          if (!connectedPlayer) throw new Error("player is not connected");
          const destination: ResolvedTravelDestination = {
            kind: "world",
            id: message.type === "VISIT_WORLD_MAP_HOLLIN_HUT" ? message.hutId : null,
            center: hutCenter,
            resourceVision: resourceVisionForArea({
              regionCode: packageIdForPosition(hutCenter),
              position: hutCenter,
              movementLeashRadiusM: connectedPlayer.moveLeashRadiusM,
              visibleRadiusM: config?.FLAG_RESOURCE_VISION_RADIUS_M ?? DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
            })
          };
          transitionDelegated = true;
          // Find Open Land reports through TRAVEL_RESULT with the jump presentation, which the
          // client plays exactly like a flag jump (camera, reveal, settled states).
          const result = await performAuthoritativeTravel({
            playerId: state.playerId,
            destination,
            requestId: message.requestId,
            arrivalMode: "protected_jump",
            kind: message.type === "VISIT_OPEN_LAND" || message.type === "VISIT_RECORDED_LOCATION" ? "pet_open_land" : "city",
            chargeTravelHunger: true,
            populationSourceKind: "city-travel",
            sendResult: message.type === "VISIT_OPEN_LAND" || message.type === "VISIT_RECORDED_LOCATION",
            transitionToken
          });
          if (!result.success) {
            sendTravelBlockAsCombatError(socket, message.requestId, result.reason);
          }
        } finally {
          if (!transitionDelegated) {
            endSmoothTravelTransition(state.playerId, message.requestId, transitionToken, "failed");
          }
        }
        return;
      }
      case "VISIT_CITY":
      case "VISIT_CITY_HOUSE":
      case "VISIT_CITY_MARKET":
      case "VISIT_CITY_WAREHOUSE":
      case "VISIT_WORLD_MAP_CITY": {
        requireHello(state.playerId);
        const structureTravelType = message.type === "VISIT_CITY_MARKET"
          ? "market"
          : message.type === "VISIT_CITY_WAREHOUSE"
            ? "warehouse"
            : null;
        const expectedPlacementRevision = structureTravelType !== null
          && "expectedPlacementRevision" in message
          ? message.expectedPlacementRevision
          : null;
        const requestedStructureId = "structureId" in message
          ? message.structureId
          : null;
        const requestedCityId =
          message.type === "VISIT_CITY_HOUSE" ||
          structureTravelType !== null
            ? null
            : "cityId" in message ? message.cityId : null;
        if (worldRuntime?.hasPlayerWorldTransition(state.playerId)) {
          sendCombatError(socket, message.requestId, "PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is already pending");
          return;
        }
        requireHello(state.playerId);
        if (!worldRuntime || !state.connectionId || !authenticatedSession) {
          sendCombatError(
            socket,
            message.requestId,
            "WORLD_RUNTIME_UNAVAILABLE",
            "World runtime is unavailable"
          );
          return;
        }
        if (!cities) {
          throw new Error("city service is unavailable");
        }
        if (message.type === "VISIT_WORLD_MAP_CITY" &&
          (!worldMap || !await worldMap.canTravelToCity(state.playerId, message.cityId))) {
          sendCombatError(
            socket,
            message.requestId,
            "CITY_NOT_DISCOVERED",
            "That city is not available on your World Map."
          );
          return;
        }
        const transitionToken = structureTravelType === null
          ? beginSmoothTravelTransition(state.playerId, message.requestId)
          : null;
        if (structureTravelType === null && !transitionToken) {
          sendCombatError(
            socket,
            message.requestId,
            "PLAYER_WORLD_TRANSITION_PENDING",
            "A player world transition is already pending"
          );
          return;
        }
        let transitionDelegated = false;
        try {
          const travelBlock = getTravelBlockReason({
            playerId: state.playerId,
            gameState,
            worldRuntime,
            ...(combat ? { combat } : {}),
            hasActiveClassMutation: (id) => classRealtimeState.hasActiveMutation(id),
            xoralExitRole: (id) => xoralEvents?.exitRole(id) ?? null
          });
          if (travelBlock) {
            sendTravelBlockAsCombatError(socket, message.requestId, travelBlock);
            return;
          }
          if (flagBuilds?.activeForPlayer(state.playerId)) {
            sendCombatError(
              socket,
              message.requestId,
              "TRAVEL_CONSTRUCTION_ACTIVE",
              "Finish or cancel the current flag build before travelling."
            );
            return;
          }
          if (await activeHarvestSessionForPlayer(state.playerId)) {
            sendCombatError(
              socket,
              message.requestId,
              "TRAVEL_HARVEST_ACTIVE",
              "Finish or cancel the current harvest before travelling."
            );
            return;
          }
          const house = message.type === "VISIT_CITY_HOUSE"
            ? await cities.structures?.getActiveHouse(requestedStructureId!) ?? null
            : null;
          const structure = structureTravelType
            ? await cities.structures?.getActiveJumpableStructure(
                requestedStructureId!,
                expectedPlacementRevision!,
                structureTravelType
              ) ?? null
            : null;
          if (message.type === "VISIT_CITY_HOUSE" && !house) {
            safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "CITY_HOUSE_NOT_FOUND",
              message: "That City House does not exist or is no longer active"
            });
            return;
          }
          if (structureTravelType !== null && !structure) {
            safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: structureTravelType === "market"
                ? "CITY_MARKET_NOT_ACTIVE"
                : "CITY_WAREHOUSE_NOT_ACTIVE",
              message: structureTravelType === "market"
                ? "This Market is not active."
                : "This City Warehouse is not active."
            });
            return;
          }
          const destinationCityId =
            house?.cityId ?? structure?.cityId ?? requestedCityId;
          if (!destinationCityId) throw new Error("city travel destination is unavailable");
          const city = await cities.getCity(destinationCityId);
          if (!city || !city.jumpable) {
            safeSendServerMessage(socket, {
              type: "ERROR",
              requestId: message.requestId,
              code: "CITY_NOT_FOUND",
              message: "city center does not exist or is not jumpable"
            });
            return;
          }
          if (
            !registry.isActiveConnection(authenticatedSession.account.id, state.connectionId) ||
            !registry.isActivePlayerConnection(state.playerId, state.connectionId)
          ) {
            return;
          }
          const cityCenter = structure
            ? destinationPoint(
                { lat: structure.lat, lon: structure.lon },
                structure.footprintRadiusM + 5,
                0
              )
            : house
              ? { lat: house.lat, lon: house.lon }
              : { lat: city.lat, lon: city.lon };
          const connectedPlayer = gameState.getPlayer(state.playerId);
          if (!connectedPlayer) throw new Error("player is not connected");
          const destination: ResolvedTravelDestination = {
            kind: "city",
            id: city.id,
            center: cityCenter,
            resourceVision: resourceVisionForArea({
              regionCode: packageIdForPosition(cityCenter),
              position: cityCenter,
              movementLeashRadiusM: connectedPlayer.moveLeashRadiusM,
              visibleRadiusM:
                config?.FLAG_RESOURCE_VISION_RADIUS_M ??
                DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
            })
          };
          transitionDelegated = true;
          const result = await performAuthoritativeTravel({
            playerId: state.playerId,
            destination,
            requestId: message.requestId,
            arrivalMode: "protected_jump",
            kind: "city",
            chargeTravelHunger:
              message.type !== "VISIT_CITY_HOUSE" && structureTravelType === null,
            populationSourceKind: "city-travel",
            sendResult: false,
            ...(transitionToken ? { transitionToken } : {}),
            ...(structure && structureTravelType
              ? {
                  requireDestinationReady: true,
                  validatePreCommit: async () => {
                    const current = await cities.structures?.getActiveJumpableStructure(
                      structure.structureId,
                      structure.placementRevision,
                      structureTravelType
                    ) ?? null;
                    return current && sameJumpableStructureAuthority(current, structure)
                      ? null
                      : {
                          code: "CITY_STRUCTURE_STALE",
                          message: "That City structure changed before travel committed."
                        };
                  }
                }
              : {})
          });
          if (!result.success) {
            sendTravelBlockAsCombatError(
              socket,
              message.requestId,
              result.reason
            );
          }
        } finally {
          if (!transitionDelegated && transitionToken) {
            endSmoothTravelTransition(
              state.playerId,
              message.requestId,
              transitionToken,
              "failed"
            );
          }
        }
        return;
      }
      case "VISIT_FLAG":
      case "COMMIT_VISIBLE_FLAG_VISIT":
      case "VISIT_WORLD_MAP_ATLAS_SHRINE":
      case "VISIT_WORLD_MAP_KINGDOM": {
        requireHello(state.playerId);
        const travellingPlayerId = state.playerId;
        if (!travellingPlayerId) return;
        const destinationId: string =
          message.type === "VISIT_WORLD_MAP_KINGDOM" ? message.seatId : message.flagId;
        const worldMapKingdomTravel = message.type === "VISIT_WORLD_MAP_KINGDOM";
        const worldMapAtlasShrineTravel =
          message.type === "VISIT_WORLD_MAP_ATLAS_SHRINE";
        const worldMapFlagTravel =
          worldMapKingdomTravel || worldMapAtlasShrineTravel;
        const recordFlagVisitRejected = (reason: TravelBlockReason): void => {
          if (message.type !== "VISIT_FLAG") return;
          gameplayLatencyTrace.record(state.playerId, {
            traceId: message.requestId,
            source: "game",
            category: "networking",
            name: "flag_visit_rejected",
            details: {
              flagId: destinationId,
              rejectionCode: reason.code,
              connectionId: state.connectionId ?? null,
              connectionGeneration: state.connectionGeneration ?? -1,
              worldCalled: false
            },
            failure: true
          });
        };
        if (message.type === "VISIT_FLAG") {
          if (message.source !== "visible_map") {
            sendCombatError(
              socket,
              message.requestId,
              "REMOTE_FLAG_TRAVEL_UNSUPPORTED",
              "Open and select the flag on the gameplay map to travel there."
            );
            return;
          }
          gameplayLatencyTrace.record(state.playerId, {
            traceId: message.requestId,
            source: "game",
            category: "networking",
            name: "flag_visit_received",
            details: {
              flagId: destinationId,
              connectionId: state.connectionId ?? null,
              connectionGeneration: state.connectionGeneration ?? -1,
              expectedTollGold: message.expectedTollGold ?? null,
              worldCalled: false
            }
          });
        }
        if (!worldRuntime || !state.connectionId || !authenticatedSession) {
          recordFlagVisitRejected({ code: "WORLD_RUNTIME_UNAVAILABLE", message: "World runtime is unavailable" });
          sendCombatError(socket, message.requestId, "WORLD_RUNTIME_UNAVAILABLE", "World runtime is unavailable");
          return;
        }
        try {
          const travelBlock = getTravelBlockReason({
            playerId: state.playerId,
            gameState,
            worldRuntime,
            ...(combat ? { combat } : {}),
            hasActiveClassMutation: (id) => classRealtimeState.hasActiveMutation(id),
            xoralExitRole: (id) => xoralEvents?.exitRole(id) ?? null
          });
          if (travelBlock) {
            recordFlagVisitRejected(travelBlock);
            sendTravelBlockAsCombatError(socket, message.requestId, travelBlock);
            return;
          }
          if (
            (worldMapFlagTravel
              || message.type === "VISIT_FLAG"
              || message.type === "COMMIT_VISIBLE_FLAG_VISIT")
            && flagBuilds?.activeForPlayer(state.playerId)
          ) {
            sendCombatError(
              socket,
              message.requestId,
              "TRAVEL_CONSTRUCTION_ACTIVE",
              "Finish or cancel the current flag build before travelling."
            );
            return;
          }
          if (
            (worldMapFlagTravel
              || message.type === "VISIT_FLAG"
              || message.type === "COMMIT_VISIBLE_FLAG_VISIT")
            && await activeHarvestSessionForPlayer(state.playerId)
          ) {
            sendCombatError(
              socket,
              message.requestId,
              "TRAVEL_HARVEST_ACTIVE",
              "Finish or cancel the current harvest before travelling."
            );
            return;
          }
          const shrineFlag = worldMapAtlasShrineTravel
            ? await worldMap?.getOwnedAtlasShrine(state.playerId, destinationId) ?? null
            : null;
          const ordinaryFlag = worldMapFlagTravel
            ? null
            : await flagService.getFlag(destinationId);
          const kingdomSeat = ordinaryFlag
            ? null
            : worldMapAtlasShrineTravel
              ? null
              : await kingdoms?.getSeatTravelDestination(destinationId) ?? null;
          const flag = ordinaryFlag ?? kingdomSeat ?? shrineFlag;
          if (!flag) {
            recordFlagVisitRejected({
              code: worldMapAtlasShrineTravel
                ? "ATLAS_SHRINE_DESTINATION_UNAVAILABLE"
                : kingdoms ? "KINGDOM_DESTINATION_UNAVAILABLE" : "FLAG_NOT_FOUND",
              message: worldMapAtlasShrineTravel
                ? "That owned Atlas Shrine is no longer available."
                : kingdoms ? "Flag or completed Castle destination is unavailable" : "Flag does not exist"
            });
            sendCombatError(
              socket,
              message.requestId,
              worldMapAtlasShrineTravel
                ? "ATLAS_SHRINE_DESTINATION_UNAVAILABLE"
                : kingdoms ? "KINGDOM_DESTINATION_UNAVAILABLE" : "FLAG_NOT_FOUND",
              worldMapAtlasShrineTravel
                ? "That owned Atlas Shrine is no longer available."
                : kingdoms ? "Flag or completed Castle destination is unavailable" : "Flag does not exist"
            );
            return;
          }
          const currentVisibleFlagDestination = ordinaryFlag
            ? resolvedVisibleFlagDestination(ordinaryFlag)
            : kingdomSeat
              ? {
                  kind: "flag" as const,
                  id: kingdomSeat.id,
                  center: { lat: kingdomSeat.lat, lon: kingdomSeat.lon },
                  flagName: kingdomSeat.name,
                  flagCenter: { lat: kingdomSeat.lat, lon: kingdomSeat.lon },
                  claimRadiusM: kingdomSeat.claimRadiusM
                }
              : null;
          if (
            acceptedVisibleFlagPreparation
            && acceptedVisibleFlagPreparation.expiresAt <= Date.now()
          ) {
            releaseAcceptedVisibleFlagPreparation();
          }
          const matchingAcceptedPreparation =
            message.type === "COMMIT_VISIBLE_FLAG_VISIT"
            && message.preparationId !== undefined
            && acceptedVisibleFlagPreparation?.preparationId
              === message.preparationId
            && acceptedVisibleFlagPreparation.flagId === message.flagId
              ? acceptedVisibleFlagPreparation
              : null;
          if (
            matchingAcceptedPreparation
            && (
              !currentVisibleFlagDestination
              || !sameVisibleFlagDestinationAuthority(
                matchingAcceptedPreparation.destination,
                currentVisibleFlagDestination
              )
            )
          ) {
            const reason = {
              code: "VISIBLE_FLAG_DESTINATION_STALE",
              message: "That flag changed while destination preparation was pending."
            };
            recordFlagVisitRejected(reason);
            sendTravelBlockAsCombatError(socket, message.requestId, reason);
            return;
          }
          if (
            message.type === "VISIT_FLAG"
            || message.type === "COMMIT_VISIBLE_FLAG_VISIT"
          ) {
            const authorityFailure = await validateVisibleFlagAuthority({
              // War Towers / Outposts: only members reach an Outpost; a Tower is no destination.
              ...(ordinaryFlag?.controlType === "personal" || ordinaryFlag?.warStructureKind
                ? { accessFlagId: ordinaryFlag.id }
                : {}),
              ...(message.type === "COMMIT_VISIBLE_FLAG_VISIT"
                ? {
                    expectedConnectionGeneration:
                      message.expectedConnectionGeneration,
                    ...(matchingAcceptedPreparation
                      ? {}
                      : {
                          expectedFlagSetRevision:
                            message.expectedFlagSetRevision,
                          ...(message.expectedDestination === undefined
                            || !currentVisibleFlagDestination
                            ? {}
                            : {
                                expectedDestination:
                                  message.expectedDestination,
                                currentDestination:
                                  currentVisibleFlagDestination
                              })
                        })
                  }
                : {}),
              ...(message.expectedTollGold === undefined
                ? {}
                : { expectedTollGold: message.expectedTollGold })
            });
            if (authorityFailure) {
              recordFlagVisitRejected(authorityFailure);
              sendTravelBlockAsCombatError(
                socket,
                message.requestId,
                authorityFailure
              );
              return;
            }
          }
          if (worldMapKingdomTravel && kingdomSeat) {
            const kingdomState = await kingdoms?.getState(state.playerId);
            if (kingdomState?.kingdom?.id !== kingdomSeat.kingdomId) {
              sendCombatError(
                socket,
                message.requestId,
                "KINGDOM_DESTINATION_FORBIDDEN",
                "You may only travel to your current Castle."
              );
              return;
            }
          }
          if (
            !registry.isActiveConnection(authenticatedSession.account.id, state.connectionId) ||
            !registry.isActivePlayerConnection(state.playerId, state.connectionId)
          ) {
            return;
          }
          const connectedPlayer = gameState.getPlayer(state.playerId);
          if (!connectedPlayer) return;
          const resourceVision = {
            ...resourceVisionForFlag({
              flagId: flag.id,
              flagName: flag.name,
              flagCenter: { lat: flag.lat, lon: flag.lon },
              movementLeashRadiusM: connectedPlayer.moveLeashRadiusM,
              ...("resourceVisionRadiusM" in flag
                ? { visionRadiusM: flag.resourceVisionRadiusM }
                : {})
            }),
            ...(kingdomSeat ? { destinationKind: "kingdom_seat" as const } : {})
          };
          const destination: ResolvedTravelDestination = {
            kind: "flag",
            id: flag.id,
            center: resourceVision.center,
            resourceVision,
            flagName: flag.name,
            flagCenter: { lat: flag.lat, lon: flag.lon },
            claimRadiusM: "claimRadiusM" in flag
              ? flag.claimRadiusM
              : Number(flag.claim_radius_m),
            ...(ordinaryFlag?.controlType === "personal"
              ? {
                  personalFlagId: ordinaryFlag.id,
                  jumpTollGold: ordinaryFlag.jumpTollGold ?? "0"
                }
              : {})
          };
          const preparedArrivalReservation = matchingAcceptedPreparation
            ?.arrivalReservation ?? null;
          const preparedPlayerSpawnPosition = preparedArrivalReservation
            ?.positions.get(state.playerId);
          if (matchingAcceptedPreparation) {
            acceptedVisibleFlagPreparation = null;
          }
          let result: TravelResult;
          try {
            result = await performAuthoritativeTravel({
            playerId: state.playerId,
            destination,
            requestId: message.requestId,
            arrivalMode: "protected_jump",
            kind: "flag",
            populationSourceKind: worldMapAtlasShrineTravel
              ? "shrine-travel"
              : kingdomSeat
                ? "kingdom-travel"
                : "flag-travel",
            sendResult: false,
            ...(preparedPlayerSpawnPosition
              ? { playerSpawnPosition: preparedPlayerSpawnPosition }
              : {}),
            ...(message.type === "COMMIT_VISIBLE_FLAG_VISIT"
              && message.preparationId
              ? { populationPreparationId: message.preparationId }
              : {}),
            requireDestinationReady: false,
            ...(worldMapAtlasShrineTravel
              ? {
                  beforePublish: async (client?: pg.PoolClient) => {
                    const current = await worldMap?.getOwnedAtlasShrine(
                      travellingPlayerId,
                      destinationId,
                      client
                    );
                    if (
                      !current ||
                      Number(current.lat) !== Number(flag.lat) ||
                      Number(current.lon) !== Number(flag.lon)
                    ) {
                      throw new Error("Atlas Shrine destination changed during travel");
                    }
                  }
                }
              : {}),
            ...((message.type === "VISIT_FLAG"
              || message.type === "COMMIT_VISIBLE_FLAG_VISIT")
              && message.expectedTollGold !== undefined
              ? { expectedTollGold: message.expectedTollGold }
              : {}),
            ...((message.type === "VISIT_FLAG"
              || message.type === "COMMIT_VISIBLE_FLAG_VISIT")
              ? {
                  validatePreCommit: async () => {
                    const authorityFailure = await validateVisibleFlagAuthority({
                      ...(ordinaryFlag?.controlType === "personal" || ordinaryFlag?.warStructureKind
                        ? { accessFlagId: ordinaryFlag.id }
                        : {}),
                      ...(message.type === "COMMIT_VISIBLE_FLAG_VISIT"
                        ? {
                            expectedConnectionGeneration:
                              message.expectedConnectionGeneration,
                            expectedGameplayViewGeneration:
                              message.expectedGameplayViewGeneration,
                            expectedResourceVisionRevision:
                              message.expectedResourceVisionRevision
                          }
                        : {}),
                      ...(message.expectedTollGold === undefined
                        ? {}
                        : { expectedTollGold: message.expectedTollGold })
                    });
                    if (authorityFailure) return authorityFailure;
                    const currentFlag = await flagService.getFlag(destinationId);
                    if (
                      !currentFlag
                      || !ordinaryFlag
                      || !currentVisibleFlagDestination
                      || !sameVisibleFlagDestinationAuthority(
                        currentVisibleFlagDestination,
                        resolvedVisibleFlagDestination(currentFlag)
                      )
                    ) return {
                      code: "VISIBLE_FLAG_DESTINATION_STALE",
                      message: "That flag changed while destination preparation was pending."
                    };
                    return null;
                  }
                }
              : {})
            });
          } finally {
            preparedArrivalReservation?.release();
          }
          if (!result.success) {
            recordFlagVisitRejected(result.reason);
            sendTravelBlockAsCombatError(socket, message.requestId, result.reason);
          }
        } catch (error) {
          logger.warn({ err: error, playerId: state.playerId, flagId: destinationId }, "validated flag visit failed");
          if (
            registry.isActiveConnection(authenticatedSession.account.id, state.connectionId) &&
            registry.isActivePlayerConnection(state.playerId, state.connectionId)
          ) {
            recordFlagVisitRejected({ code: "FLAG_VISIT_FAILED", message: "Flag visit could not be completed" });
            sendCombatError(socket, message.requestId, "FLAG_VISIT_FAILED", "Flag visit could not be completed");
          }
        }
        return;
      }
    }
  };
}

export function registerTravelHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"travel">
): void {
  router.register("travel", handler);
}
