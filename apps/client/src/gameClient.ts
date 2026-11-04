import type { ChatPartyListingInput, ChatTradeListing, GearScrollMemoryGroup } from "@ash-atlas/shared";
import type { EquipmentDefinitionId, EquipmentGameplayFamilyId, EquipmentMetal, FieldConsumableItemId, UtilityGearDefinitionId, FlagReinforcementTarget, GoblinMarketBuyLine, GoblinMarketLine, LocationFixReason } from "@ash-atlas/shared";
import type {
  AbilityTargetMode,
  BugReportSubmitMessage,
  ClassId,
  LaunchClassId,
  CityConstructionAction,
  CityDistrictType,
  ClientMessage,
  ClientTelemetrySample,
  EquipmentSlot,
  MapMarkerCommand,
  MarketCollectionScope,
  MarketInteger,
  MarketOrderSide,
  MarketPriceCurrency,
  PersonalAnchorKind,
  ClassLoadoutView,
  LatLon,
  DevProgressionType,
  GeneralActiveSlotId,
  GeneralSkillId,
  SkillPointMutationTarget,
  SpecializationId,
  DirectMessagePreferences,
  DungeonSnapshot,
  DungeonSnapshotUpdate,
  HarvestStartAuthority,
  SubclassId,
  MobAppearanceVariant,
  MobArchetypeKey,
  PlantBookKey,
  DeveloperTestFlagKind,
  DeveloperTestUnitType,
  ResourceType,
  InventoryItemType,
  ServerMessage,
  StartupTerminalTelemetryMessage,
  WorldViewAuthority,
  WorldViewEpoch,
  WorldMapDestination,
  WorldMapSocialAudience,
  PlayerSalonStyles,
  PlayerLocationSnapshot
} from "@ash-atlas/shared";
import {
  ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
  ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_REASON,
  ASH_ATLAS_CLIENT_RELEASE_QUERY_KEYS,
  ServerMessageParseError,
  addAshAtlasProtocolQuery,
  negotiateAshAtlasProtocol,
  parseServerMessage,
  portalIds,
  type AshAtlasNegotiatedProtocol
} from "@ash-atlas/shared";

import { clientConfig } from "./config.js";
import {
  BrowserWebSocketTransport
} from "./browserWebSocketTransport.js";
import type {
  ClientCommandPort,
  ClientSendOutcome,
  GameplayCommandAttempt
} from "./client/clientCommandPort.js";
import { createGameClientDomains } from "./client/gameClientDomains.js";
import type {
  PopulationResyncOperation
} from "./client/domains/worldGameplayClient.js";
import type {
  LocationTrustFields,
  VisibleFlagVisitAuthority
} from "./client/domains/travelClient.js";
import { perfMetrics } from "./perf/perfMetrics.js";
import { perfRecorder } from "./perf/perfRecorder.js";
import { requestIdCrypto as crypto } from "./requestId.js";
import { gameplayLatencyTrace } from "./diagnostics/gameplayLatencyTrace.js";
import { flagTravelPresentationInstrumentation } from "./map/flagTravelPresentationInstrumentation.js";
import { bugReportDiagnostics } from "./diagnostics/bugReportDiagnostics.js";
import { selectedRuntimePngContentPack } from "./map/runtimePngAssetUrl.js";
import { noteTelegraphRtt } from "./map/telegraphWindow.js";

const TRACE_TRAFFIC_SUMMARY_INTERVAL_MS = 5_000;
const SOCKET_ACTIVITY_STALE_MS = 20_000;
const SOCKET_ACTIVITY_TIMEOUT_CLOSE_CODE = 4000;
const SOCKET_ACTIVITY_TIMEOUT_CLOSE_REASON = "server activity timeout";
const TRACE_RELEVANT_SERVER_MESSAGE =
  /(?:ERROR|FAILED|REJECTED|INVALID|SESSION_REPLACED|FLAG_BUILD|FLAG_CREATED|MOVE_ACCEPTED)/;
const SAFE_SERVER_MESSAGE_TYPE = /^[A-Z0-9_]{1,80}$/;
const MAX_PROTOCOL_FAILURES_PER_CONNECTION = 3;
const RECONNECT_MAX_DELAY_MS = 5_000;
const RECONNECT_JITTER_MIN = 0.75;
const RECONNECT_JITTER_SPAN = 0.5;
const RECONNECT_WINDOW_MS = 180_000;
const RETRYABLE_CLOSE_CODES = new Set([
  1001,
  1006,
  1011,
  1012,
  1013,
  SOCKET_ACTIVITY_TIMEOUT_CLOSE_CODE
]);
const CLIENT_TELEMETRY_INTERVAL_MS = 30_000;
const CLIENT_TELEMETRY_MAX_PENDING = 4;
const CLIENT_TELEMETRY_RTT_SAMPLES = 120;

type StartupTerminalTelemetryInput = Omit<
  StartupTerminalTelemetryMessage,
  | "type"
  | "deviceCategory"
  | "operatingSystemFamily"
  | "browserFamily"
  | "browserMajorVersion"
  | "installedPwa"
  | "clientReleaseIdentifier"
>;

export type WorldViewReadiness = "idle" | "preparing" | "ready" | "degraded";

export type ClientCommandAdmissionPolicy = Readonly<{
  family: "session" | "movement" | "world-entity";
  requiresSessionBootstrap: true;
  worldViewAdmission: "not-required" | "server-authoritative";
}>;

const WORLD_ENTITY_COMMAND_TYPES = new Set<ClientMessage["type"]>([
  "START_ATTACK",
  "START_XORAL_EVENT",
  "START_HARVEST",
  "COMPLETE_HARVEST",
  "PICKUP_DROPPED_ITEM",
  "COLLECT_WATER_AT_COORDINATE"
]);

export function clientCommandAdmissionPolicy(
  type: ClientMessage["type"]
): ClientCommandAdmissionPolicy {
  if (type === "MOVE_TO") {
    return {
      family: "movement",
      requiresSessionBootstrap: true,
      worldViewAdmission: "server-authoritative"
    };
  }
  if (WORLD_ENTITY_COMMAND_TYPES.has(type)) {
    return {
      family: "world-entity",
      requiresSessionBootstrap: true,
      worldViewAdmission: "server-authoritative"
    };
  }
  return {
    family: "session",
    requiresSessionBootstrap: true,
    worldViewAdmission: "not-required"
  };
}

export type GameClientHandlers = {
  onOpen(): void;
  onClose(event: CloseEvent): boolean | void;
  onMessage(message: ServerMessage): void;
  onError(message: string): void;
  onProtocolCompatibility?(
    protocol: AshAtlasNegotiatedProtocol,
    mode: "current" | "legacy"
  ): void;
  onProtocolIncompatible?(message: string): void;
  onServerComponentRelease?(serverComponentSha: string): void;
  onRecoveryWindowEnded?(): void;
  onSessionInvalid(
    reason:
      | "SESSION_EXPIRED"
      | "SESSION_REVOKED"
      | "SESSION_REPLACED"
      | "ACCOUNT_SUSPENDED"
      | "TEST_ACCESS_PENDING"
      | "TEST_ACCESS_DENIED"
      | "TEST_ACCESS_REVOKED",
    message?: string
  ): void;
};

export class GameClient {
  private readonly transport = new BrowserWebSocketTransport();
  private readonly commandPort: ClientCommandPort = {
    send: (message, expectedGeneration) =>
      this.sendCommandOutcome(message, expectedGeneration),
    connectionGeneration: () => this.transport.currentGeneration()
  };
  private readonly domains = createGameClientDomains(this.commandPort);
  readonly combatEquipment = this.domains.combat;
  readonly backpacks = this.domains.backpack;
  readonly developer = this.domains.developer;
  readonly dungeon = this.domains.dungeon;
  readonly flags = this.domains.flag;
  readonly harvesting = this.domains.harvesting;
  readonly manor = this.domains.manor;
  readonly greenhouse = this.domains.manor;
  readonly market = this.domains.market;
  readonly party = this.domains.party;
  readonly pets = this.domains.pet;
  readonly packages = this.domains.packages;
  readonly gifts = this.domains.gifts;
  readonly settlements = this.domains.settlement;
  readonly social = this.domains.social;
  readonly travel = this.domains.travel;
  readonly world = this.domains.world;
  readonly portals = this.domains.portal;
  readonly salon = this.domains.salon;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private hasOpened = false;
  private intentionallyDisconnected = false;
  private protocolIncompatible = false;
  private lastActivityAt: number | null = null;
  private traceOrdinaryMessageCount = 0;
  private traceTrafficSummaryTimer: number | null = null;
  private protocolFailures = 0;
  private transportReady = false;
  private sessionBootstrapComplete = false;
  private worldViewState: WorldViewReadiness = "idle";
  private worldViewAuthority: WorldViewAuthority | null = null;
  private suspended = false;
  private networkOnline = true;
  private recoveryStartedAt: number | null = null;
  private recoveryWindowEnded = false;
  private telemetryTimer: number | null = null;
  private telemetrySequence = 0;
  private readonly telemetryPending: ClientTelemetrySample[] = [];
  private readonly pendingStartupTerminalTelemetry: StartupTerminalTelemetryMessage[] = [];
  private readonly startupTerminalTelemetryKeys = new Set<string>();
  private readonly rttSamplesMs: number[] = [];
  private serverConnectionGeneration: number | null = null;
  private telemetryPreviousCollectibleRedrawCount = 0;
  private telemetryPreviousCollectibleDrawMs = 0;
  private telemetryPreviousStaticRedrawCount = 0;
  private lastSevereFrameStallTelemetryAt = 0;
  private pendingReconnectFailureTelemetry = false;
  private readonly refreshWebSocketProtocols: (() => Promise<readonly string[]>) | undefined;
  private currentWebSocketProtocols: readonly string[];
  private refreshWebSocketProtocolsPending = false;
  private socketOpenAttempt = 0;
  private consecutiveSendFailures = 0;
  private completedAuthoritativeBootstrapOnce = false;
  private serverClockOffsetMs = 0;
  private readonly telemetryEnabled =
    import.meta.env.VITE_CLOSED_TEST_TELEMETRY_ENABLED === "true";

  constructor(
    private readonly wsBase: string,
    private readonly handlers: GameClientHandlers,
    private readonly random: () => number = Math.random,
    webSocketProtocols: readonly string[] = [],
    refreshWebSocketProtocols?: () => Promise<readonly string[]>
  ) {
    this.currentWebSocketProtocols = webSocketProtocols;
    this.refreshWebSocketProtocols = refreshWebSocketProtocols;
  }

  connect(): void {
    this.closeSocket();
    this.clearReconnect();
    this.reconnectAttempts = 0;
    this.intentionallyDisconnected = false;
    this.protocolIncompatible = false;
    this.suspended = false;
    this.networkOnline = true;
    this.transportReady = false;
    this.sessionBootstrapComplete = false;
    this.worldViewState = "idle";
    this.worldViewAuthority = null;
    this.recoveryStartedAt = null;
    this.recoveryWindowEnded = false;
    this.completedAuthoritativeBootstrapOnce = false;
    this.pendingReconnectFailureTelemetry = false;
    this.pendingStartupTerminalTelemetry.length = 0;
    this.startupTerminalTelemetryKeys.clear();
    this.clearTelemetry();
    this.refreshWebSocketProtocolsPending = false;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.refreshWebSocketProtocolsPending && this.refreshWebSocketProtocols) {
      const attempt = ++this.socketOpenAttempt;
      void this.refreshWebSocketProtocols().then((protocols) => {
        if (
          attempt !== this.socketOpenAttempt ||
          this.intentionallyDisconnected ||
          this.suspended ||
          !this.networkOnline
        ) return;
        this.currentWebSocketProtocols = protocols;
        this.refreshWebSocketProtocolsPending = false;
        this.openSocketNow();
      }).catch(() => {
        if (
          attempt !== this.socketOpenAttempt ||
          this.intentionallyDisconnected ||
          this.suspended ||
          !this.networkOnline
        ) return;
        this.refreshWebSocketProtocolsPending = false;
        this.openSocketNow();
      });
      return;
    }
    this.openSocketNow();
  }

  private openSocketNow(): void {
    if (this.hasOpened || this.reconnectAttempts > 0) {
      perfMetrics.noteWebSocketReconnect();
    }
    this.serverConnectionGeneration = null;
    this.protocolFailures = 0;
    const url = new URL(`${this.wsBase}/ws`);
    addAshAtlasProtocolQuery(url.searchParams);
    url.searchParams.set(
      ASH_ATLAS_CLIENT_RELEASE_QUERY_KEYS.platform,
      clientConfig.nativePlatformName ?? (clientConfig.nativePlatform ? "ios" : "web")
    );
    if (clientConfig.buildSha) {
      url.searchParams.set(ASH_ATLAS_CLIENT_RELEASE_QUERY_KEYS.clientSha, clientConfig.buildSha);
    }
    const generation = this.transport.open(url.toString(), {
      onOpen: (activeGeneration) => {
      this.clearReconnect();
      this.hasOpened = true;
      this.transportReady = true;
      this.sessionBootstrapComplete = false;
      this.worldViewState = "idle";
      this.worldViewAuthority = null;
      this.lastActivityAt = Date.now();
      perfMetrics.setWebSocketReadyState(this.transport.readyState());
      perfMetrics.markLoadMilestone("websocket connected");
      perfRecorder.recordEvent("websocket_connected", {
        readyState: this.transport.readyState()
      });
      gameplayLatencyTrace.record("networking", "websocket_connected", {
        readyState: this.transport.readyState(),
        reconnectAttempt: this.reconnectAttempts
      });
      bugReportDiagnostics.noteConnected(this.synchronizedNow());
      const contentPackId = selectedRuntimePngContentPack().packId;
      this.sendProtocol({
        type: "HELLO",
        ...(contentPackId ? {
          greenhouseCropCatalogVersion: 1 as const,
          greenhouseCropPackId: contentPackId
        } : {})
      }, activeGeneration);
      gameplayLatencyTrace.record("networking", "hello_sent");
      this.handlers.onOpen();
      this.pingTimer = window.setInterval(() => {
        const now = Date.now();
        if (
          activeGeneration === this.transport.currentGeneration() &&
          this.lastActivityAt !== null &&
          now - this.lastActivityAt > SOCKET_ACTIVITY_STALE_MS
        ) {
          gameplayLatencyTrace.record("networking", "websocket_activity_timeout", {
            inactiveMs: now - this.lastActivityAt
          }, { failure: true });
          bugReportDiagnostics.recordError({
            category: "network_action",
            name: "WebSocketActivityTimeout",
            message: SOCKET_ACTIVITY_TIMEOUT_CLOSE_REASON,
            component: "game-client"
          });
          this.pendingReconnectFailureTelemetry = true;
          this.transport.close(
            SOCKET_ACTIVITY_TIMEOUT_CLOSE_CODE,
            SOCKET_ACTIVITY_TIMEOUT_CLOSE_REASON
          );
          this.handleSocketClose({
            code: SOCKET_ACTIVITY_TIMEOUT_CLOSE_CODE,
            reason: SOCKET_ACTIVITY_TIMEOUT_CLOSE_REASON,
            wasClean: false
          } as CloseEvent);
          return;
        }
        this.sendProtocol({
          type: "PING",
          clientTime: performance.now()
        }, activeGeneration);
      }, 5_000);
      },
      onMessage: (_activeGeneration, event) => {
      this.lastActivityAt = Date.now();
      try {
        const message = parseServerMessage(String(event.data));
        let suppressPortalPlan = false;
        if (message.type === "PLAYER_LOCATION_SNAPSHOT") {
          this.domains.portal.installLocation(message.location);
        } else if (message.type === "PORTAL_TRANSITION_PLANNED") {
          suppressPortalPlan = !this.domains.portal.notePlan(
            message.requestId,
            message.transitionId
          );
        } else if (message.type === "PORTAL_TRANSITION_FAILED") {
          this.domains.portal.noteFailure(message.requestId, message.transitionId);
        }
        bugReportDiagnostics.recordIncoming(
          message,
          this.synchronizedNow(),
          this.transport.currentGeneration(),
          incomingByteLength(event.data)
        );
        this.noteTraceServerMessage(message.type);
        perfMetrics.noteWebSocketMessage();
        if (message.type === "PLAYER_DELTA") perfMetrics.noteServerDelta("player");
        else if (message.type === "COMBAT_DELTA") perfMetrics.noteServerDelta("combat");
        if (message.type === "PLAYER_SNAPSHOT" || message.type === "PLAYER_DELTA") {
          perfMetrics.notePlayerSnapshot();
          const movementRevisions = message.type === "PLAYER_SNAPSHOT"
            ? message.players.map((player) => player.movementRevision)
            : message.upserts.map((upsert) =>
                upsert.kind === "full" ? upsert.player.movementRevision : upsert.movementRevision
              );
          perfRecorder.recordEvent(
            message.type === "PLAYER_SNAPSHOT" ? "player_snapshot_received" : "player_delta_received",
            {
              serverTime: message.serverTime,
              sequence: message.sequence,
              maxMovementRevision: movementRevisions.length > 0
                ? Math.max(...movementRevisions)
                : -1
            }
          );
        }
        if (message.type === "PONG") {
          const rttMs = performance.now() - message.clientTime;
          if (Number.isFinite(rttMs) && rttMs >= 0) {
            perfMetrics.noteRtt(rttMs);
            noteTelegraphRtt(rttMs);
            this.rttSamplesMs.push(rttMs);
            if (this.rttSamplesMs.length > CLIENT_TELEMETRY_RTT_SAMPLES) {
              this.rttSamplesMs.splice(
                0,
                this.rttSamplesMs.length - CLIENT_TELEMETRY_RTT_SAMPLES
              );
            }
            this.serverClockOffsetMs =
              message.serverTime + rttMs / 2 - Date.now();
          }
        }
        if (message.type === "MOVE_ACCEPTED") {
          perfRecorder.recordEvent("move_accepted_received", {
            requestId: message.requestId,
            movementRevision: message.movementRevision,
            lat: message.target.lat,
            lon: message.target.lon
          });
          gameplayLatencyTrace.record("movement", "movement_acceptance_received", {
            requestId: message.requestId,
            movementRevision: message.movementRevision,
            targetLat: message.target.lat,
            targetLon: message.target.lon
          }, { traceId: message.requestId });
        }
        if (message.type === "WELCOME") {
          this.serverClockOffsetMs = message.serverTime - Date.now();
          const negotiation = negotiateAshAtlasProtocol(message.protocol);
          if (
            negotiation.status !== "compatible-current" &&
            negotiation.status !== "compatible-legacy"
          ) {
            this.stopForIncompatibleProtocol();
            return;
          }
          this.protocolFailures = 0;
          this.serverConnectionGeneration = message.connectionGeneration ?? null;
          this.handlers.onProtocolCompatibility?.(
            negotiation.protocol,
            negotiation.status === "compatible-current" ? "current" : "legacy"
          );
          const liveServerVersion = message.serverVersion ?? message.releaseSha;
          if (liveServerVersion) this.handlers.onServerComponentRelease?.(liveServerVersion);
          this.sessionBootstrapComplete = true;
          this.flushStartupTerminalTelemetry();
          gameplayLatencyTrace.record("networking", "welcome_received");
        }
        if (message.type === "FLAG_BUILD_STARTED") {
          gameplayLatencyTrace.record("build", "construction_start_received", {
            requestId: message.requestId,
            buildId: message.buildId,
            startsAt: message.startedAt,
            completesAt: message.completesAt
          }, { traceId: message.requestId });
        }
        if (message.type === "FLAG_CREATED") {
          gameplayLatencyTrace.record("build", "construction_completed_received", {
            requestId: message.requestId ?? null
          }, { ...(message.requestId ? { traceId: message.requestId } : {}) });
        }
        if (message.type === "FLAG_VISITED") {
          flagTravelPresentationInstrumentation.event("flag-visited-received");
          gameplayLatencyTrace.recordFlagVisitedReceived({
            flagId: message.flagId,
            relocationRevision: message.player.relocationRevision ?? 0
          }, message.requestId);
        }
        if (message.type === "COLLECTIBLES_SNAPSHOT") {
          gameplayLatencyTrace.record("population", "collectibles_snapshot_received", {
            entityCount: message.nodes.length
          });
        }
        if (message.type === "FLAGS_SNAPSHOT") {
          perfMetrics.noteFlagsSnapshot();
        }
        if (message.type === "COLLECTIBLES_SNAPSHOT") {
          perfMetrics.noteCollectibleSnapshot(message.nodes.length);
        }
        if (
          message.type === "PLAYER_RESOURCES_UPDATED" ||
          message.type === "COLLECTIBLE_PICKED_UP" ||
          message.type === "HARVEST_COMPLETED" ||
          message.type === "REPEATABLE_RESOURCE_HARVESTED" ||
          message.type === "FLAG_REINFORCED" ||
          message.type === "WATER_COLLECTED" ||
          message.type === "ITEM_DROP_RESULT" ||
          message.type === "DROPPED_ITEM_PICKUP_RESULT" ||
          message.type === "DROPPED_BACKPACK_PICKUP_RESULT"
        ) {
          perfMetrics.noteInventorySnapshot();
        }
        if (message.type === "SESSION_REPLACED") {
          this.handlers.onSessionInvalid("SESSION_REPLACED", message.message);
          this.disconnect();
          return;
        }
        if (message.type === "AUTH_SESSION_INVALID") {
          this.handlers.onSessionInvalid(message.code, message.message);
          this.disconnect();
          return;
        }
        if (!suppressPortalPlan) this.handlers.onMessage(message);
      } catch (error) {
        this.handleServerFrameFailure(error);
      }
      },
      onClose: (_activeGeneration, event) => this.handleSocketClose(event),
      onError: () => {
      perfMetrics.setWebSocketReadyState(this.transport.readyState());
      if (!this.intentionallyDisconnected && this.hasOpened) {
        this.pendingReconnectFailureTelemetry = true;
      }
      this.handlers.onError("websocket connection error");
      bugReportDiagnostics.recordError({
        category: "network_action",
        name: "WebSocketError",
        message: "websocket connection error",
        component: "game-client"
      });
      },
      onStaleEvent: () => perfMetrics.noteWebSocketStaleEvent()
    }, this.currentWebSocketProtocols);
    if (generation !== this.transport.currentGeneration()) {
      perfMetrics.noteWebSocketStaleEvent();
    }
    perfMetrics.setWebSocketReadyState(this.transport.readyState());
  }

  disconnect(): void {
    this.intentionallyDisconnected = true;
    this.clearReconnect();
    this.transportReady = false;
    this.sessionBootstrapComplete = false;
    this.worldViewState = "idle";
    this.worldViewAuthority = null;
    this.pendingReconnectFailureTelemetry = false;
    this.domains.dungeon.clearScene();
    this.clearTelemetry();
    this.closeSocket();
  }

  suspend(): void {
    if (this.intentionallyDisconnected || this.suspended) return;
    if (this.transport.readyState() === 1) {
      this.sendProtocol({ type: "APP_SUSPEND" }, this.transport.currentGeneration());
    }
    this.suspended = true;
    if (this.refreshWebSocketProtocols) this.refreshWebSocketProtocolsPending = true;
    this.transportReady = false;
    this.sessionBootstrapComplete = false;
    this.worldViewState = "idle";
    this.worldViewAuthority = null;
    this.clearTelemetry();
    this.recoveryStartedAt ??= Date.now();
    this.clearReconnect();
    this.transport.close(1001, "application suspended");
    this.clearPing();
    this.lastActivityAt = null;
  }

  setNetworkOnline(online: boolean): void {
    this.networkOnline = online;
    if (!online) {
      this.clearReconnect();
      return;
    }
    if (!this.intentionallyDisconnected && !this.suspended && this.transport.readyState() !== 1) {
      this.recoverIfNeeded();
    }
  }

  markAuthoritativeBootstrapComplete(epoch?: WorldViewEpoch): void {
    if (this.transport.readyState() !== 1 || this.intentionallyDisconnected) return;
    this.sessionBootstrapComplete = true;
    this.worldViewState = "ready";
    if (epoch) this.worldViewAuthority = epoch;
    const reconnectSucceeded = this.completedAuthoritativeBootstrapOnce;
    this.completedAuthoritativeBootstrapOnce = true;
    this.reconnectAttempts = 0;
    this.recoveryStartedAt = null;
    this.recoveryWindowEnded = false;
    this.startTelemetry();
    if (this.pendingReconnectFailureTelemetry) {
      this.pendingReconnectFailureTelemetry = false;
      this.enqueueTelemetrySample("reconnect_failure");
    }
    if (reconnectSucceeded) this.enqueueTelemetrySample("reconnect_success");
  }

  reconnectInPlace(): void {
    if (this.protocolIncompatible || this.intentionallyDisconnected) return;
    this.suspended = false;
    this.networkOnline = true;
    this.transportReady = false;
    this.sessionBootstrapComplete = false;
    this.worldViewState = "idle";
    this.worldViewAuthority = null;
    this.reconnectAttempts = 0;
    this.recoveryStartedAt = Date.now();
    this.recoveryWindowEnded = false;
    this.clearReconnect();
    if (this.refreshWebSocketProtocols) this.refreshWebSocketProtocolsPending = true;
    this.closeSocket();
    this.openSocket();
  }

  currentConnectionGeneration(): number {
    return this.transport.currentGeneration();
  }

  currentServerConnectionGeneration(): number {
    return this.serverConnectionGeneration ?? 0;
  }

  synchronizedNow(): number {
    return Math.round(Date.now() + this.serverClockOffsetMs);
  }

  socketState(): "connecting" | "open" | "closing" | "closed" {
    switch (this.transport.readyState()) {
      case 0: return "connecting";
      case 1: return "open";
      case 2: return "closing";
      default: return "closed";
    }
  }

  recordStartupTerminal(input: StartupTerminalTelemetryInput): boolean {
    if (!this.telemetryEnabled) return false;
    const key = `${input.attempt}:${input.outcome}`;
    if (this.startupTerminalTelemetryKeys.has(key)) return false;
    this.startupTerminalTelemetryKeys.add(key);
    const device = normalizedClientPlatform();
    const message: StartupTerminalTelemetryMessage = {
      type: "STARTUP_TERMINAL_TELEMETRY",
      ...input,
      elapsedStartupMs: boundedMetric(input.elapsedStartupMs),
      ...device,
      installedPwa: window.matchMedia?.("(display-mode: standalone)").matches ?? false,
      clientReleaseIdentifier:
        import.meta.env.VITE_GAME_BUILD_SHA ?? "development"
    };
    if (
      this.sessionBootstrapComplete &&
      this.transport.readyState() === 1 &&
      this.sendProtocol(message)
    ) {
      return true;
    }
    if (this.pendingStartupTerminalTelemetry.length >= 4) {
      this.pendingStartupTerminalTelemetry.shift();
    }
    this.pendingStartupTerminalTelemetry.push(message);
    return true;
  }

  submitBugReport(message: BugReportSubmitMessage): boolean {
    return this.sendOutcome(message).status === "sent";
  }

  recoverIfNeeded(now = Date.now()): "healthy" | "reconnecting" | "stopped" {
    if (this.intentionallyDisconnected) return "stopped";
    if (this.suspended) {
      // Coming back from the background: the window starts now, not when the app was hidden.
      this.recoveryStartedAt = now;
      this.reconnectAttempts = 0;
    }
    if (this.recoveryWindowEnded) {
      this.recoveryWindowEnded = false;
      this.recoveryStartedAt = now;
      this.reconnectAttempts = 0;
      this.suspended = false;
      if (!this.networkOnline) return "reconnecting";
      this.clearReconnect();
      if (this.refreshWebSocketProtocols) this.refreshWebSocketProtocolsPending = true;
      this.closeSocket();
      this.openSocket();
      return "reconnecting";
    }
    if (
      this.recoveryStartedAt !== null &&
      now - this.recoveryStartedAt >= RECONNECT_WINDOW_MS
    ) {
      this.endRecoveryWindow();
      return "stopped";
    }
    this.suspended = false;
    if (!this.networkOnline) return "reconnecting";
    if (this.transport.readyState() === 1) {
      if (this.lastActivityAt !== null && now - this.lastActivityAt <= SOCKET_ACTIVITY_STALE_MS) {
        return "healthy";
      }
      if (this.refreshWebSocketProtocols) this.refreshWebSocketProtocolsPending = true;
      this.closeSocket();
    } else if (this.transport.readyState() === 0) {
      return "reconnecting";
    }
    this.clearReconnect();
    this.recoveryStartedAt ??= now;
    this.openSocket();
    return "reconnecting";
  }

  private closeSocket(): void {
    this.socketOpenAttempt += 1;
    this.clearPing();
    this.flushTraceTrafficSummary();
    this.transportReady = false;
    this.transport.close();
    this.lastActivityAt = null;
    perfMetrics.setWebSocketReadyState(this.transport.readyState());
  }

  private handleSocketClose(event: CloseEvent): void {
    this.clearPing();
    this.flushTraceTrafficSummary();
    this.lastActivityAt = null;
    this.transportReady = false;
    this.sessionBootstrapComplete = false;
    this.worldViewState = "idle";
    this.worldViewAuthority = null;
    this.clearTelemetry();
    perfMetrics.setWebSocketReadyState(this.transport.readyState());
    perfRecorder.recordEvent("websocket_closed", {
      readyState: this.transport.readyState()
    });
    gameplayLatencyTrace.record("networking", "websocket_disconnected", {
      readyState: this.transport.readyState(),
      closeCode: event.code
    }, { failure: !this.intentionallyDisconnected });
    if (event.code === ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE) {
      this.stopForIncompatibleProtocol();
      return;
    }
    if (event.code === 4002) {
      this.intentionallyDisconnected = true;
      this.clearReconnect();
      this.handlers.onSessionInvalid(
        "SESSION_REPLACED",
        "Ash Atlas was opened on another device."
      );
      return;
    }
    this.handlers.onClose(event);
    if (
      !this.intentionallyDisconnected &&
      RETRYABLE_CLOSE_CODES.has(event.code)
    ) {
      if (this.refreshWebSocketProtocols) this.refreshWebSocketProtocolsPending = true;
      if (this.reconnectAttempts > 0) {
        this.pendingReconnectFailureTelemetry = true;
      }
      this.recoveryStartedAt ??= Date.now();
      this.scheduleReconnect();
    }
  }

  private handleServerFrameFailure(error: unknown): void {
    const kind = error instanceof ServerMessageParseError
      ? error.kind
      : "malformed-frame";
    perfMetrics.noteWebSocketProtocolFailure(kind);
    this.protocolFailures += 1;
    this.handlers.onError(error instanceof Error ? error.message : "bad server message");
    gameplayLatencyTrace.record("networking", "websocket_protocol_failure", {
      kind,
      failuresOnConnection: this.protocolFailures
    }, { failure: true });
    this.enqueueTelemetrySample("protocol_failure");
    bugReportDiagnostics.recordError({
      category: "protocol_validation",
      name: error instanceof Error ? error.name : "ProtocolValidationError",
      message: error instanceof Error ? error.message : "bad server message",
      stack: error instanceof Error ? error.stack ?? null : null,
      component: "game-client"
    });
    if (this.protocolFailures < MAX_PROTOCOL_FAILURES_PER_CONNECTION) return;
    this.transport.close(1002, "invalid server frames");
    this.clearPing();
    this.lastActivityAt = null;
    this.scheduleReconnect();
  }

  private stopForIncompatibleProtocol(): void {
    const message = "This Ash Atlas client is not compatible with the game server. Refresh to update.";
    perfMetrics.noteWebSocketProtocolFailure("incompatible-protocol");
    gameplayLatencyTrace.record(
      "networking",
      "websocket_protocol_incompatible",
      undefined,
      { failure: true }
    );
    this.intentionallyDisconnected = true;
    this.protocolIncompatible = true;
    this.transportReady = false;
    this.sessionBootstrapComplete = false;
    this.worldViewState = "idle";
    this.worldViewAuthority = null;
    this.clearReconnect();
    this.clearPing();
    this.transport.close(
      ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
      ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_REASON
    );
    this.handlers.onProtocolIncompatible?.(message);
    this.handlers.onError(message);
  }

  private noteTraceServerMessage(type: ServerMessage["type"]): void {
    if (!gameplayLatencyTrace.isRecording()) return;
    const wireType = SAFE_SERVER_MESSAGE_TYPE.test(type) ? type : "UNKNOWN";
    if (TRACE_RELEVANT_SERVER_MESSAGE.test(wireType)) {
      gameplayLatencyTrace.record(
        "networking",
        "websocket_relevant_message_received",
        { wireType }
      );
      return;
    }
    this.traceOrdinaryMessageCount += 1;
    if (this.traceTrafficSummaryTimer !== null) return;
    this.traceTrafficSummaryTimer = window.setTimeout(() => {
      this.traceTrafficSummaryTimer = null;
      this.flushTraceTrafficSummary();
    }, TRACE_TRAFFIC_SUMMARY_INTERVAL_MS);
  }

  private flushTraceTrafficSummary(): void {
    if (this.traceTrafficSummaryTimer !== null) {
      window.clearTimeout(this.traceTrafficSummaryTimer);
      this.traceTrafficSummaryTimer = null;
    }
    const messageCount = this.traceOrdinaryMessageCount;
    this.traceOrdinaryMessageCount = 0;
    if (messageCount === 0) return;
    gameplayLatencyTrace.record("networking", "websocket_traffic_summary", {
      messageCount
    });
  }

  dash(
    dirX: number,
    dirY: number,
    lastDash?: { requestId: string; pressToAcceptMs: number; correctionM: number; startOffsetM?: number } | null
  ): string | null {
    return this.domains.world.dash(dirX, dirY, lastDash);
  }

  /** Action combat SWING: world-space unit vector, per-connection seq, lag hint in ms. */
  swing(seq: number, dirX: number, dirY: number, lagMs: number): string | null {
    return this.domains.world.swing(seq, dirX, dirY, lagMs);
  }

  moveTo(lat: number, lon: number, boundTravelRequestId?: string, launchRaft = false, walk = false): string | null{
    return this.domains.world.moveTo(lat, lon, boundTravelRequestId, launchRaft, walk);
  }

  jumpToManor(manorId: string, requestId?: string): string | null{
    return this.domains.manor.jumpToManor(manorId, requestId);
  }

  enterManor(manorId: string): string | null{
    return this.domains.manor.enterManor(manorId);
  }

  cancelManorEntry(): boolean{
    return this.domains.manor.cancelManorEntry();
  }

  requestManorGuests(manorId: string): boolean{
    return this.domains.manor.requestManorGuests(manorId);
  }

  kickManorGuest(manorId: string, targetPlayerId: string): boolean{
    return this.domains.manor.kickManorGuest(manorId, targetPlayerId);
  }

  banManorGuest(manorId: string, targetPlayerId: string): boolean{
    return this.domains.manor.banManorGuest(manorId, targetPlayerId);
  }

  unbanManorGuest(manorId: string, targetPlayerId: string): boolean{
    return this.domains.manor.unbanManorGuest(manorId, targetPlayerId);
  }

  buildManor(): string | null{
    return this.domains.manor.buildManor();
  }

  buildGreenhouse(): string | null { return this.domains.manor.buildGreenhouse(); }
  previewGreenhouseBuild(): string | null { return this.domains.manor.previewGreenhouseBuild(); }
  cancelGreenhouseBuild(): string | null { return this.domains.manor.cancelGreenhouseBuild(); }
  destroyGreenhouse(greenhouseId: string): string | null { return this.domains.manor.destroyGreenhouse(greenhouseId); }
  enterGreenhouse(greenhouseId: string): string | null { return this.domains.manor.enterGreenhouse(greenhouseId); }
  exitGreenhouse(greenhouseSessionId: string): string | null { return this.domains.manor.exitGreenhouse(greenhouseSessionId); }
  openGreenhouse(greenhouseId: string): string | null { return this.domains.manor.openGreenhouse(greenhouseId); }
  rememberGreenhouse(greenhouseId: string): void { this.domains.manor.rememberGreenhouse(greenhouseId); }
  greenhouseMoveTo(sessionId: string, x: number, y: number): string | null { return this.domains.manor.greenhouseMoveTo(sessionId, x, y); }
  plantGreenhouse(sessionId: string, anchorId: string, cropId = "wheat"): string | null { return this.domains.manor.plantGreenhouse(sessionId, anchorId, cropId); }
  waterGreenhouse(sessionId: string, anchorId: string): string | null { return this.domains.manor.waterGreenhouse(sessionId, anchorId); }
  clipGreenhouse(sessionId: string, anchorId: string): string | null { return this.domains.manor.clipGreenhouse(sessionId, anchorId); }
  harvestGreenhouse(sessionId: string, anchorId: string): string | null { return this.domains.manor.harvestGreenhouse(sessionId, anchorId); }
  tapGreenhouseTree(sessionId: string, anchorId: string): string | null { return this.domains.manor.tapGreenhouseTree(sessionId, anchorId); }
  craftWaterBucket(): string | null { return this.domains.manor.craftWaterBucket(); }
  craftFertilizer(): string | null { return this.domains.manor.craftFertilizer(); }
  fillWaterBucket(lat: number, lon: number, gallons: number): string | null { return this.domains.manor.fillWaterBucket(lat, lon, gallons); }
  cancelWaterBucketFill(): string | null { return this.domains.manor.cancelWaterBucketFill(); }
  depositGreenhouseWater(sessionId: string): string | null { return this.domains.manor.depositGreenhouseWater(sessionId); }
  refillGardeningBucket(sessionId: string): string | null { return this.domains.manor.refillGardeningBucket(sessionId); }

  destroyManor(): string | null{
    return this.domains.manor.destroyManor();
  }

  attackManor(manorId: string): string | null {
    return this.domains.manor.attackManor(manorId);
  }

  startManorRepair(manorId: string): string | null {
    return this.domains.manor.startManorRepair(manorId);
  }

  stopManorRepair(): string | null {
    return this.domains.manor.stopManorRepair();
  }

  installManorSkin(manorTypeId: string, copyId?: string): string | null {
    return this.domains.manor.installManorSkin(manorTypeId, copyId);
  }

  exitManor(manorSessionId: string): string | null{
    return this.domains.manor.exitManor(manorSessionId);
  }

  manorMoveTo(manorSessionId: string, x: number, y: number): string | null{
    return this.domains.manor.manorMoveTo(manorSessionId, x, y);
  }

  enterSalon(structureId: string, expectedPlacementRevision: string): string | null {
    return this.domains.portal.use(
      portalIds.salonWorldToMain(structureId), expectedPlacementRevision
    );
  }

  salonMoveTo(salonSessionId: string, x: number, y: number): string | null {
    return this.domains.salon.moveTo(salonSessionId, x, y);
  }

  beginSalonCustomize(
    salonSessionId: string,
    movementSequence: number
  ): string | null {
    return this.domains.salon.beginCustomize(salonSessionId, movementSequence);
  }

  saveSalonAppearance(input: {
    editorSessionId: string;
    expectedAppearanceRevision: number;
    catalogRevision: number;
    changes: PlayerSalonStyles;
  }): string | null {
    return this.domains.salon.saveAppearance(input);
  }

  cancelSalonCustomize(editorSessionId: string): string | null {
    return this.domains.salon.cancelCustomize(editorSessionId);
  }

  exitSalon(salonSessionId: string): string | null {
    void salonSessionId;
    const location = this.currentPortalLocation();
    return location?.kind === "interior" && location.locationType === "salon"
      ? this.domains.portal.use(portalIds.salonMainToWorld(location.locationId)) : null;
  }

  requestDungeonEntrances(): string | null {
    return this.domains.dungeon.requestEntrances();
  }

  usePortal(
    portalId: string,
    expectedPortalRevision?: string,
    options?: Readonly<{ approach?: "normal" | "immediate"; lantern?: "cinder" | "challenger" }>
  ): string | null {
    return this.domains.portal.use(portalId, expectedPortalRevision, options);
  }

  portalDestinationReady(transitionId: string, sceneKey: string): boolean {
    return this.domains.portal.destinationReady(transitionId, sceneKey);
  }

  cancelPortalTransition(): boolean {
    return this.domains.portal.cancel();
  }

  private currentPortalLocation(): PlayerLocationSnapshot | null {
    return this.domains.portal.snapshot();
  }

  dungeonMoveTo(sessionId: string, x: number, y: number): string | null {
    return this.domains.dungeon.moveTo(sessionId, x, y);
  }

  dungeonInteract(sessionId: string, objectId: string): string | null {
    return this.domains.dungeon.interact(sessionId, objectId);
  }

  dungeonPuzzleActive(sessionId: string, roomId: string, active: boolean): string | null {
    return this.domains.dungeon.puzzleActive(sessionId, roomId, active);
  }

  dungeonPuzzleSolve(sessionId: string, roomId: string, clientSolveMs: number): string | null {
    return this.domains.dungeon.puzzleSolve(sessionId, roomId, clientSolveMs);
  }

  dungeonTorchLobbyJoin(entranceId: string): string | null {
    return this.domains.dungeon.torchLobbyJoin(entranceId);
  }

  dungeonTorchLobbySetTorches(lobbyId: string, torches: number): string | null {
    return this.domains.dungeon.torchLobbySetTorches(lobbyId, torches);
  }

  dungeonTorchLobbyReady(lobbyId: string, ready: boolean): string | null {
    return this.domains.dungeon.torchLobbyReady(lobbyId, ready);
  }

  dungeonTorchLobbyStart(lobbyId: string): string | null {
    return this.domains.dungeon.torchLobbyStart(lobbyId);
  }

  dungeonTorchLobbyLeave(lobbyId: string): string | null {
    return this.domains.dungeon.torchLobbyLeave(lobbyId);
  }

  materializeDungeonSnapshot(
    snapshot: DungeonSnapshot | DungeonSnapshotUpdate
  ): DungeonSnapshot | null {
    return this.domains.dungeon.materializeSnapshot(snapshot);
  }

  clearDungeonScene(): void {
    this.domains.dungeon.clearScene();
  }

  placeFlag(name?: string, quoteId?: string, anchorKind?: PersonalAnchorKind): string | null{
    return this.domains.flag.placeFlag(name, quoteId, anchorKind);
  }

  cancelFlagBuild(buildId: string): boolean{
    return this.domains.flag.cancelFlagBuild(buildId);
  }

  reinforceFlag(flagId: string): boolean{
    return this.domains.flag.reinforceFlag(flagId);
  }

  upgradeFlag(flagId: string, targetTier: FlagReinforcementTarget, targetTowerLevel?: number): boolean{
    return this.domains.flag.upgradeFlag(flagId, targetTier, targetTowerLevel);
  }

  devTeleport(lat: number, lon: number): string | null{
    return this.domains.developer.devTeleport(lat, lon);
  }

  devVisitMine(mineId: string): string | null{
    return this.domains.developer.devVisitMine(mineId);
  }

  buildDevManor(): string | null {
    return this.domains.developer.buildDevManor();
  }

  buildDevSalon(): string | null {
    return this.domains.developer.buildDevSalon();
  }

  advanceAllGreenhouseCrops(): string | null {
    return this.domains.developer.advanceAllGreenhouseCrops();
  }

  grantMetalEquipment(kind: "sword" | "chest", metal: EquipmentMetal): string | null {
    return this.domains.developer.grantMetalEquipment(kind, metal);
  }

  waterAllGreenhouseCrops(): string | null {
    return this.domains.developer.waterAllGreenhouseCrops();
  }

  visitFlag(
      flagId: string,
      requestId = crypto.randomUUID(),
      expectedTollGold?: string
    ): string | null{
    return this.domains.travel.visitFlag(flagId, requestId, expectedTollGold);
  }

  prepareVisibleFlagVisit(
    flagId: string,
    authority: VisibleFlagVisitAuthority,
    requestId = crypto.randomUUID(),
    expectedTollGold?: string
  ): string | null {
    return this.domains.travel.prepareVisibleFlagVisit(
      flagId,
      authority,
      requestId,
      expectedTollGold
    );
  }

  commitVisibleFlagVisit(
    flagId: string,
    authority: VisibleFlagVisitAuthority,
    requestId = crypto.randomUUID(),
    preparationId?: string,
    expectedTollGold?: string
  ): string | null {
    return this.domains.travel.commitVisibleFlagVisit(
      flagId,
      authority,
      requestId,
      preparationId,
      expectedTollGold
    );
  }

  cancelVisibleFlagVisit(requestId: string): boolean {
    return this.domains.travel.cancelVisibleFlagVisit(requestId);
  }

  visitWorldMapKingdom(
      seatId: string,
      requestId = crypto.randomUUID()
    ): string | null{
    return this.domains.travel.visitWorldMapKingdom(seatId, requestId);
  }

  visitWorldMapAtlasShrine(
      flagId: string,
      requestId = crypto.randomUUID()
    ): string | null{
    return this.domains.travel.visitWorldMapAtlasShrine(flagId, requestId);
  }

  visitWorldMapHollinHut(
      hutId: string,
      requestId = crypto.randomUUID()
    ): string | null {
    return this.domains.travel.visitWorldMapHollinHut(hutId, requestId);
  }

  visitOpenLand(requestId = crypto.randomUUID()): string | null {
    return this.domains.travel.visitOpenLand(requestId);
  }

  visitRecordedLocation(locationId: string, requestId = crypto.randomUUID()): string | null {
    return this.domains.travel.visitRecordedLocation(locationId, requestId);
  }

  prepareWorldMapTravel(
      destination: WorldMapDestination,
      requestId = crypto.randomUUID()
    ): string | null{
    return this.domains.travel.prepareWorldMapTravel(destination, requestId);
  }

  cancelWorldMapTravel(requestId: string): boolean {
    return this.domains.travel.cancelWorldMapTravel(requestId);
  }

  previewCityFounding(flagId: string): void{
    return this.domains.settlement.previewCityFounding(flagId);
  }

  foundCity(flagId: string): void{
    return this.domains.settlement.foundCity(flagId);
  }

  advanceCityConstruction(
    cityId: string,
    action: CityConstructionAction
  ): string | null {
    return this.domains.settlement.advanceCityConstruction(cityId, action);
  }

  requestCityInfo(cityId: string): void{
    return this.domains.settlement.requestCityInfo(cityId);
  }

  requestCityApp(): void{
    return this.domains.settlement.requestCityApp();
  }

  openGoblinMarket(marketStructureId: string): boolean {
    return this.domains.settlement.openGoblinMarket(marketStructureId);
  }

  openHollinHut(hutId: string): boolean {
    return this.domains.settlement.openHollinHut(hutId);
  }

  buyFromHollinHut(hutId: string, itemId: string, quantity: number, expectedUnitPriceGold: string): boolean {
    return this.domains.settlement.buyFromHollinHut(hutId, itemId, quantity, expectedUnitPriceGold);
  }

  listWanderingMerchants(): boolean {
    return this.domains.settlement.listWanderingMerchants();
  }

  openWanderingMerchant(merchantId: string): boolean {
    return this.domains.settlement.openWanderingMerchant(merchantId);
  }

  buyFromWanderingMerchant(merchantId: string, itemId: string, quantity: number, expectedUnitPriceGold: string): boolean {
    return this.domains.settlement.buyFromWanderingMerchant(merchantId, itemId, quantity, expectedUnitPriceGold);
  }

  craftCinderLantern(lantern: "cinder" | "challenger" = "cinder"): boolean {
    return this.domains.settlement.craftCinderLantern(lantern);
  }

  offerBerryToHollins(hutId: string): boolean {
    return this.domains.settlement.offerBerryToHollins(hutId);
  }

  useHollinHutService(hutId: string, service: "heal" | "turn_in_eggs"): boolean {
    return this.domains.settlement.useHollinHutService(hutId, service);
  }

  sellToGoblinMarket(
    marketStructureId: string,
    line: GoblinMarketLine
  ): boolean {
    return this.domains.settlement.sellToGoblinMarket(marketStructureId, line);
  }

  buyFromGoblinMarket(
    marketStructureId: string,
    line: GoblinMarketBuyLine,
    quantity = 1
  ): boolean {
    return this.domains.settlement.buyFromGoblinMarket(marketStructureId, line, quantity);
  }

  buildCityHouse(): string | null {
    return this.domains.settlement.buildCityHouse();
  }

  buildOilWell(cityId: string, structureType: "oil_well" | "quartz_hut" | "library" = "oil_well"): string | null {
    return this.domains.settlement.buildOilWell(cityId, crypto.randomUUID(), structureType);
  }

  openLibrary(structureId: string): string | null {
    return this.domains.settlement.openLibrary(structureId);
  }

  studyLibrary(structureId: string): string | null {
    return this.domains.settlement.studyLibrary(structureId);
  }

  openOilWell(structureId: string, remote = false): string | null {
    return this.domains.settlement.openOilWell(structureId, crypto.randomUUID(), remote);
  }

  harvestOilWell(structureId: string, remote = false): string | null {
    return this.domains.settlement.harvestOilWell(structureId, crypto.randomUUID(), remote);
  }

  destroyOilWell(
    structureId: string,
    expectedPlacementRevision: string
  ): boolean {
    return this.domains.settlement.destroyOilWell(
      structureId,
      expectedPlacementRevision
    );
  }

  destroyCityHouse(structureId: string, expectedPlacementRevision: string): boolean {
    return this.domains.settlement.destroyCityHouse(structureId, expectedPlacementRevision);
  }

  buildCityFacility(
      cityId: string,
      facilityType: "warehouse" | "cistern_warrens" | "salon" | "city_kennel"
    ): string | null {
    return this.domains.settlement.buildCityFacility(cityId, facilityType);
  }

  buildMilitaryFacility(
    cityId: string,
    facilityType: "barracks" | "demolition_factory"
  ): string | null {
    return this.domains.settlement.buildMilitaryFacility(cityId, facilityType);
  }

  buildLodge(): string | null {
    return this.domains.settlement.buildLodge();
  }

  upgradeLodge(expectedLevel: number): string | null {
    return this.domains.settlement.upgradeLodge(expectedLevel);
  }

  destroyLodge(): boolean {
    return this.domains.settlement.destroyLodge();
  }

  requestMilitaryIndustry(): string | null {
    return this.domains.settlement.requestMilitaryIndustry();
  }

  trainSiegeCrew(facilityStructureId: string): string | null {
    return this.domains.settlement.trainSiegeCrew(facilityStructureId);
  }

  trainMilitaryUnit(facilityStructureId: string, unitType: "infantry" | "archer" | "bomber"): string | null {
    return this.domains.settlement.trainMilitaryUnit(facilityStructureId, unitType);
  }

  manufactureFieldBallista(facilityStructureId: string): string | null {
    return this.domains.settlement.manufactureFieldBallista(facilityStructureId);
  }

  startMilitaryProduction(
    facilityStructureId: string,
    production: "repair_kit_batch" | "torch_batch",
    quantity: number
  ): string | null {
    return this.domains.settlement.startMilitaryProduction(facilityStructureId, production, quantity);
  }

  combineMilitaryGroups(groupIds: string[]): string | null {
    return this.domains.settlement.combineMilitaryGroups(groupIds);
  }

  splitMilitaryGroup(groupId: string, splitSizes: number[]): string | null {
    return this.domains.settlement.splitMilitaryGroup(groupId, splitSizes);
  }

  buildWarCamp(): string | null {
    return this.domains.settlement.buildWarCamp();
  }

  relocateWarCamp(): string | null {
    return this.domains.settlement.relocateWarCamp();
  }

  removeWarCamp(): string | null {
    return this.domains.settlement.removeWarCamp();
  }

  /** Hand attack, Bomber strike or Siege volley on another player's War Camp. */
  attackWarCamp(campId: string, mode: "hand" | "bomber" | "siege", groupId?: string): string | null {
    return this.domains.settlement.attackWarCamp(campId, mode, groupId);
  }

  callTroops(): string | null {
    return this.domains.settlement.callTroops();
  }

  followMilitaryGroup(groupId: string): string | null {
    return this.domains.settlement.followMilitaryGroup(groupId);
  }

  stayMilitaryGroup(groupId: string): string | null {
    return this.domains.settlement.stayMilitaryGroup(groupId);
  }

  packUpMilitaryGroup(groupId: string): string | null {
    return this.domains.settlement.packUpMilitaryGroup(groupId);
  }

  deployMilitaryGroup(groupId: string, position?: { lat: number; lon: number }): string | null {
    return this.domains.settlement.deployMilitaryGroup(groupId, position);
  }

  defendMilitaryGroup(groupId: string): string | null {
    return this.domains.settlement.defendMilitaryGroup(groupId);
  }

  returnMilitaryGroup(groupId: string): string | null {
    return this.domains.settlement.returnMilitaryGroup(groupId);
  }

  stopMilitaryGroup(groupId: string): string | null {
    return this.domains.settlement.stopMilitaryGroup(groupId);
  }

  moveMilitaryGroup(groupId: string, position: { lat: number; lon: number }): string | null {
    return this.domains.settlement.moveMilitaryGroup(groupId, position);
  }

  attackMilitaryGroup(groupId: string, targetEntityId: string): string | null {
    return this.domains.settlement.attackMilitaryGroup(groupId, targetEntityId);
  }

  attackMilitarySiege(groupId: string): string | null {
    return this.domains.settlement.attackMilitarySiege(groupId);
  }

  demolishFlag(groupId: string, targetFlagId: string, targetKind: "flag" | "city_structure" = "flag"): string | null {
    return this.domains.settlement.demolishFlag(groupId, targetFlagId, undefined, targetKind);
  }

  fireBallistaVolley(groupId: string, targetFlagId: string, targetKind: "flag" | "city_structure" = "flag"): string | null {
    return this.domains.settlement.fireBallistaVolley(groupId, targetFlagId, undefined, targetKind);
  }

  attackCityStructure(structureId: string): string | null {
    return this.domains.settlement.attackCityStructure(structureId);
  }

  startCityStructureRepair(structureId: string): string | null {
    return this.domains.settlement.startCityStructureRepair(structureId);
  }

  stopCityStructureRepair(): string | null {
    return this.domains.settlement.stopCityStructureRepair();
  }

  repairBallista(unitId: string): string | null {
    return this.domains.settlement.repairBallista(unitId);
  }

  collectMilitaryJob(jobId: string): string | null {
    return this.domains.settlement.collectMilitaryJob(jobId);
  }

  upgradeCityFacility(structureId: string, expectedTier: number): string | null {
    return this.domains.settlement.upgradeCityFacility(structureId, expectedTier);
  }

  destroyCityFacility(structureId: string, expectedPlacementRevision: string): boolean {
    return this.domains.settlement.destroyCityFacility(
      structureId,
      expectedPlacementRevision
    );
  }

  openCityWarehouse(structureId: string, requestId?: string): string | null{
    return this.domains.settlement.openCityWarehouse(structureId, requestId);
  }

  donateCityWarehouse(
    structureId: string,
    stackId: string,
    quantity: number,
    requestId?: string
  ): string | null{
    return this.domains.settlement.donateCityWarehouse(
      structureId,
      stackId,
      quantity,
      requestId
    );
  }

  donateAllCityWarehouse(structureId: string, requestId?: string): string | null{
    return this.domains.settlement.donateAllCityWarehouse(structureId, requestId);
  }

  moveCityWarehouseStack(
    structureId: string,
    stackId: string,
    targetSlot: number,
    requestId?: string
  ): string | null{
    return this.domains.settlement.moveCityWarehouseStack(
      structureId,
      stackId,
      targetSlot,
      requestId
    );
  }

  reorganizeCityWarehouse(structureId: string, requestId?: string): string | null {
    return this.domains.settlement.reorganizeCityWarehouse(structureId, requestId);
  }

  donateCityGold(
    structureId: string,
    amount: string,
    requestId?: string
  ): string | null {
    return this.domains.settlement.donateCityGold(structureId, amount, requestId);
  }

  joinCity(cityId: string): void{
    return this.domains.settlement.joinCity(cityId);
  }

  leaveCity(cityId: string): void{
    return this.domains.settlement.leaveCity(cityId);
  }

  claimCityMayor(cityId: string): void{
    return this.domains.settlement.claimCityMayor(cityId);
  }

  relinquishCityMayor(cityId: string): void{
    return this.domains.settlement.relinquishCityMayor(cityId);
  }

  convertCityFlag(flagId: string, requestId?: string): string | null {
    return this.domains.settlement.convertCityFlag(flagId, requestId);
  }

  visitCity(cityId: string): string | null{
    return this.domains.travel.visitCity(cityId);
  }

  visitCityHouse(structureId: string): string | null{
    return this.domains.travel.visitCityHouse(structureId);
  }

  visitCityMarket(
    structureId: string,
    expectedPlacementRevision: string,
    requestId = crypto.randomUUID()
  ): string | null {
    return this.domains.travel.visitCityMarket(
      structureId,
      expectedPlacementRevision,
      requestId
    );
  }

  visitCityWarehouse(
    structureId: string,
    expectedPlacementRevision: string,
    requestId = crypto.randomUUID()
  ): string | null {
    return this.domains.travel.visitCityWarehouse(
      structureId,
      expectedPlacementRevision,
      requestId
    );
  }

  visitWorldMapCity(cityId: string, requestId?: string): string | null{
    return this.domains.travel.visitWorldMapCity(cityId, requestId);
  }

  requestBiomeDiscovery(): boolean {
    return this.domains.world.requestBiomeDiscovery();
  }

  mapMarkerCommand(
    command: MapMarkerCommand
  ): string | null {
    return this.domains.world.mapMarkerCommand(command);
  }

  requestWorldMapDestinations(): boolean{
    return this.domains.world.requestWorldMapDestinations();
  }

  setWorldMapDestinationVisibility(
    destination: Pick<WorldMapDestination, "kind" | "id">,
    visible: boolean
  ): boolean {
    return this.domains.world.setWorldMapDestinationVisibility(destination, visible);
  }

  setWorldMapSocialVisibility(
    audience: WorldMapSocialAudience,
    visible: boolean
  ): boolean {
    return this.domains.world.setWorldMapSocialVisibility(audience, visible);
  }

  requestNearbyCollectibles(): void{
    return this.domains.harvesting.requestNearbyCollectibles();
  }

  surveyArea(): void{
    return this.domains.flag.surveyArea();
  }

  startHarvest(
    nodeId: string,
    authority: HarvestStartAuthority,
    action: "primary" | "resin" = "primary"
  ): GameplayCommandAttempt{
    return this.domains.harvesting.startHarvest(nodeId, authority, action);
  }

  claimMine(nodeId: string, expectedAuthorityRevision: number): string | null {
    return this.domains.harvesting.claimMine(nodeId, expectedAuthorityRevision);
  }

  markAuthoritativeViewPreparing(authority?: WorldViewAuthority): void {
    this.worldViewState = "preparing";
    if (authority) this.worldViewAuthority = authority;
  }

  markAuthoritativeViewDegraded(authority: WorldViewAuthority): void {
    if (
      this.worldViewAuthority &&
      !sameWorldViewAuthority(this.worldViewAuthority, authority)
    ) return;
    this.worldViewState = "degraded";
    this.worldViewAuthority = authority;
  }

  readinessState(): Readonly<{
    transportReady: boolean;
    sessionBootstrapComplete: boolean;
    worldViewState: WorldViewReadiness;
    worldViewAuthority: WorldViewAuthority | null;
  }> {
    return {
      transportReady: this.transportReady,
      sessionBootstrapComplete: this.sessionBootstrapComplete,
      worldViewState: this.worldViewState,
      worldViewAuthority: this.worldViewAuthority
    };
  }

  useBalsamResin(stackId?: string): boolean{
    return this.domains.harvesting.useBalsamResin(stackId);
  }

  useFieldConsumable(itemId: FieldConsumableItemId, stackId?: string, targetEntityId?: string): boolean {
    return this.domains.harvesting.useFieldConsumable(itemId, stackId, targetEntityId);
  }

  craftFieldConsumable(itemId: FieldConsumableItemId): boolean {
    return this.domains.harvesting.craftFieldConsumable(itemId);
  }

  requestWaterSites(): boolean {
    return this.domains.harvesting.requestWaterSites();
  }

  waterSiteAction(type: "DIVE_PEARL_BED" | "ENTER_WHIRLPOOL" | "PRESENT_ABYSSAL_ORBS", siteId: string): string | null {
    return this.domains.harvesting.waterSiteAction(type, siteId);
  }

  useSimpleFood(stackId?: string): boolean {
    return this.domains.harvesting.useSimpleFood(stackId);
  }

  completeHarvest(sessionId: string): GameplayCommandAttempt{
    return this.domains.harvesting.completeHarvest(sessionId);
  }

  cancelHarvest(sessionId: string): void{
    return this.domains.harvesting.cancelHarvest(sessionId);
  }

  dropItem(itemId: ResourceType, variant: string | null, quantity = 1, stackId?: string, manorSessionId?: string): boolean{
    return this.domains.harvesting.dropItem(itemId, variant, quantity, stackId, manorSessionId);
  }

  dropEquipment(
    equipmentInstanceId: string,
    expectedEquipmentRevision: number,
    manorSessionId?: string
  ): boolean{
    return this.domains.harvesting.dropEquipment(
      equipmentInstanceId,
      expectedEquipmentRevision,
      manorSessionId
    );
  }

  updateMaterialKeep(
    itemId: ResourceType,
    variant: string | null,
    keepQuantity: number,
    expectedRevision: number
  ): string | null {
    return this.domains.harvesting.updateMaterialKeep(
      itemId, variant, keepQuantity, expectedRevision
    );
  }

  updateUniqueItemProtection(
    equipmentInstanceId: string,
    protectedValue: boolean,
    expectedRevision: number
  ): string | null {
    return this.domains.harvesting.updateUniqueItemProtection(
      equipmentInstanceId, protectedValue, expectedRevision
    );
  }

  splitInventoryStack(stackId: string, quantity: number): string | null{
    return this.domains.harvesting.splitInventoryStack(stackId, quantity);
  }

  restackInventoryStack(stackId: string): string | null{
    return this.domains.harvesting.restackInventoryStack(stackId);
  }

  moveInventoryStack(stackId: string, targetSlot: number): string | null{
    return this.domains.harvesting.moveInventoryStack(stackId, targetSlot);
  }

  reorganizeInventory(): string | null{
    return this.domains.harvesting.reorganizeInventory();
  }

  pickupDroppedItem(
      dropId: string,
      pickup: { mode: "all" } | { mode: "quantity"; quantity: number },
      manorSessionId?: string
    ): boolean{
    return this.domains.harvesting.pickupDroppedItem(dropId, pickup, manorSessionId);
  }

  collectWaterAtCoordinate(lat: number, lon: number): void{
    return this.domains.harvesting.collectWaterAtCoordinate(lat, lon);
  }

  requestPetState(): string | null{
    return this.domains.pet.requestPetState();
  }

  commandPet(petId: string, command: "stay" | "follow", destination?: Readonly<{ lat: number; lon: number }>): string | null{
    return this.domains.pet.commandPet(petId, command, destination);
  }

  startAttack(targetEntityId: string, confirmNpcHostility = false): GameplayCommandAttempt{
    return this.domains.combat.startAttack(targetEntityId, confirmNpcHostility);
  }

  respawnPlayer(): GameplayCommandAttempt {
    return this.domains.combat.respawnPlayer();
  }

  startXoralEvent(xoralEntityId: string): GameplayCommandAttempt {
    return this.domains.combat.startXoralEvent(xoralEntityId);
  }

  confirmXoralExit(): GameplayCommandAttempt {
    return this.domains.combat.confirmXoralExit();
  }

  pickupXoralRingDrop(dropId: string): GameplayCommandAttempt {
    return this.domains.combat.pickupXoralRingDrop(dropId);
  }

  spawnMob(archetype: MobArchetypeKey, lat: number, lon: number, appearanceVariant?: MobAppearanceVariant): boolean{
    return this.domains.developer.spawnMob(archetype, lat, lon, appearanceVariant);
  }

  spawnPlant(plantKey: PlantBookKey, lat: number, lon: number): boolean {
    return this.domains.developer.spawnPlant(plantKey, lat, lon);
  }

  spawnTestFlag(targetKind: DeveloperTestFlagKind, lat: number, lon: number): string | null {
    return this.domains.developer.spawnTestFlag(targetKind, lat, lon);
  }

  spawnTestUnit(unitType: DeveloperTestUnitType, lat: number, lon: number): string | null {
    return this.domains.developer.spawnTestUnit(unitType, lat, lon);
  }

  spawnGoblinVillage(lat: number, lon: number): string | null {
    return this.domains.developer.spawnGoblinVillage(lat, lon);
  }

  foundCapital(input: { requestId: string; dryRun: boolean; leaveCurrentCity: boolean }): boolean {
    return this.domains.developer.foundCapital(input);
  }

  collapseTerritory(input: { requestId: string; kind: "city" | "kingdom"; targetId?: string }): boolean {
    return this.domains.developer.collapseTerritory(input);
  }

  spawnDungeonEntrance(templateId: string, lat: number, lon: number): string | null {
    return this.domains.developer.spawnDungeonEntrance(templateId, lat, lon);
  }

  listDungeonEntrances(): string | null {
    return this.domains.developer.listDungeonEntrances();
  }

  deleteDungeonEntrance(entranceId: string): string | null {
    return this.domains.developer.deleteDungeonEntrance(entranceId);
  }

  listGoblinVillages(): string | null {
    return this.domains.developer.listGoblinVillages();
  }

  deleteGoblinVillage(cityId: string): string | null {
    return this.domains.developer.deleteGoblinVillage(cityId);
  }

  resetDevDungeonRun(): string | null {
    return this.domains.developer.resetDungeonRun();
  }

  clearMobs(): boolean{
    return this.domains.developer.clearMobs();
  }

  clearPlants(): boolean {
    return this.domains.developer.clearPlants();
  }

  resetOwnDevClassCooldowns(): string | null{
    return this.domains.developer.resetOwnDevClassCooldowns();
  }

  requestProgressionSnapshot(): boolean{
    return this.domains.combat.requestProgressionSnapshot();
  }

  requestCreatureBook(): boolean {
    return this.domains.combat.requestCreatureBook();
  }

  requestClassSnapshot(): boolean{
    return this.domains.combat.requestClassSnapshot();
  }

  requestSkillTreeV3Snapshot(requestId?: string): string | null {
    return this.domains.combat.requestSkillTreeV3Snapshot(requestId);
  }

  spendSkillTreeV3Point(
    expectedRevision: number,
    target: SkillPointMutationTarget,
    requestId?: string
  ): string | null {
    return this.domains.combat.spendSkillTreeV3Point(expectedRevision, target, requestId);
  }

  refundSkillTreeV3Rank(
    expectedRevision: number,
    target: Exclude<SkillPointMutationTarget, { kind: "world_knowledge" }>,
    requestId?: string
  ): string | null {
    return this.domains.combat.refundSkillTreeV3Rank(expectedRevision, target, requestId);
  }

  resetOwnDevSkillTreeV3(
    expectedRevision: number,
    requestId?: string
  ): string | null {
    return this.domains.combat.resetOwnDevSkillTreeV3(expectedRevision, requestId);
  }

  offerSkillTreeV3Unlock(skillId: GeneralSkillId, requestId?: string): string | null {
    return this.domains.combat.offerSkillTreeV3Unlock(skillId, requestId);
  }

  respecSkillTreeV3Build(
    expectedRevision: number,
    requestId?: string,
    expectedGlimmerCost: number | null = null
  ): string | null {
    return this.domains.combat.respecSkillTreeV3Build(expectedRevision, requestId, expectedGlimmerCost);
  }

  confirmLevelUp(targetLevel: number, expectedGlimmerCost: number, requestId?: string): string | null {
    return this.domains.combat.confirmLevelUp(targetLevel, expectedGlimmerCost, requestId);
  }

  activateSkillTreeV3Specialization(
    expectedRevision: number,
    specializationId: SpecializationId | null,
    requestId?: string
  ): string | null {
    return this.domains.combat.activateSkillTreeV3Specialization(expectedRevision, specializationId, requestId);
  }

  equipSkillTreeV3GeneralActive(
    expectedRevision: number,
    slot: GeneralActiveSlotId,
    skillId: GeneralSkillId | null,
    requestId?: string
  ): string | null {
    return this.domains.combat.equipSkillTreeV3GeneralActive(expectedRevision, slot, skillId, requestId);
  }

  useSkillTreeV3GeneralActive(
    expectedRevision: number,
    skillId: GeneralSkillId | "edict_stride",
    options: Readonly<{
      targetEntityId?: string;
      targetMode?: "hostile" | "friendly" | "self" | "position" | "direction";
      targetPosition?: LatLon;
      directionDegrees?: number;
    }> = {},
    requestId?: string
  ): string | null {
    return this.domains.combat.useSkillTreeV3GeneralActive(expectedRevision, skillId, options, requestId);
  }

  adjustOwnDevProgression(progressionType: DevProgressionType, targetRank: number): boolean{
    return this.domains.combat.adjustOwnDevProgression(progressionType, targetRank);
  }

  setOwnDevSubclassUnlock(subclassId: SubclassId, unlocked: boolean): boolean{
    return this.domains.combat.setOwnDevSubclassUnlock(subclassId, unlocked);
  }

  updateClassLoadout(loadout: ClassLoadoutView): boolean{
    return this.domains.combat.updateClassLoadout(loadout);
  }

  activateSubclass(subclassId: SubclassId | null): boolean{
    return this.domains.combat.activateSubclass(subclassId);
  }

  grantOwnDevelopmentAssets(
      grant: {
        gold?: number;
        cityCoins?: number;
        glimmer?: number;
        lumen?: number;
        materials?: readonly { itemId: InventoryItemType; quantity: number }[];
      },
      requestId = crypto.randomUUID()
    ): string | null{
    return this.domains.developer.grantOwnDevelopmentAssets(grant, requestId);
  }

  activateClass(classId: ClassId): boolean{
    return this.domains.combat.activateClass(classId);
  }

  unlockClass(classId: LaunchClassId): boolean{
    return this.domains.combat.unlockClass(classId);
  }

  useNormalAbility(
      abilityId: string,
      targetEntityId?: string,
      targetMode?: AbilityTargetMode,
      targetPosition?: LatLon
    ): boolean{
    return this.domains.combat.useNormalAbility(abilityId, targetEntityId, targetMode, targetPosition);
  }

  useResetAbility(
      abilityId: string,
      targetEntityId?: string,
      targetMode?: AbilityTargetMode
    ): boolean{
    return this.domains.combat.useResetAbility(abilityId, targetEntityId, targetMode);
  }

  useUniversalTaunt(): boolean{
    return this.domains.combat.useUniversalTaunt();
  }

  createParty(): boolean{
    return this.domains.party.createParty();
  }

  invitePartyMember(targetPlayerId: string): boolean{
    return this.domains.party.invitePartyMember(targetPlayerId);
  }

  inviteToParty(targetPlayerId: string): boolean{
    return this.domains.party.inviteToParty(targetPlayerId);
  }

  acceptPartyInvite(invitationId: string): boolean{
    return this.domains.party.acceptPartyInvite(invitationId);
  }

  acceptPartyInviteRequest(invitationId: string, requestId = crypto.randomUUID()): string | null{
    return this.domains.party.acceptPartyInviteRequest(invitationId, requestId);
  }

  forwardPartyInvite(invitationId: string): boolean{
    return this.domains.party.forwardPartyInvite(invitationId);
  }

  forwardPartyInviteRequest(invitationId: string, requestId = crypto.randomUUID()): string | null{
    return this.domains.party.forwardPartyInviteRequest(invitationId, requestId);
  }

  declinePartyInvite(invitationId: string): boolean{
    return this.domains.party.declinePartyInvite(invitationId);
  }

  declinePartyInviteRequest(invitationId: string, requestId = crypto.randomUUID()): string | null{
    return this.domains.party.declinePartyInviteRequest(invitationId, requestId);
  }

  cancelPartyInvite(invitationId: string): boolean{
    return this.domains.party.cancelPartyInvite(invitationId);
  }

  cancelPartyInviteRequest(invitationId: string, requestId = crypto.randomUUID()): string | null{
    return this.domains.party.cancelPartyInviteRequest(invitationId, requestId);
  }

  sendTravelInvite(targetPlayerId: string, requestId = crypto.randomUUID()): string | null{
    return this.domains.travel.sendTravelInvite(targetPlayerId, requestId);
  }

  relocateToCurrentLocation(
    lat: number,
    lon: number,
    accuracy?: number,
    requestId = crypto.randomUUID(),
    deviceTimeZone?: string,
    trust?: LocationTrustFields
  ): string | null {
    return this.domains.travel.relocateToCurrentLocation(
      lat,
      lon,
      accuracy,
      requestId,
      deviceTimeZone,
      trust
    );
  }

  sendLocationFix(
    lat: number,
    lon: number,
    accuracy?: number,
    deviceTimeZone?: string,
    reason?: LocationFixReason,
    trust?: LocationTrustFields
  ): boolean {
    return this.domains.travel.sendLocationFix(lat, lon, accuracy, deviceTimeZone, reason, trust);
  }

  respondTravelInvite(
      inviteId: string,
      response: "accept" | "decline",
      requestId = crypto.randomUUID()
    ): string | null{
    return this.domains.travel.respondTravelInvite(inviteId, response, requestId);
  }

  cancelTravelInvite(inviteId: string): boolean{
    return this.domains.travel.cancelTravelInvite(inviteId);
  }

  cancelTravelInviteRequest(inviteId: string, requestId = crypto.randomUUID()): string | null{
    return this.domains.travel.cancelTravelInviteRequest(inviteId, requestId);
  }

  requestTravelInbox(): boolean{
    return this.domains.travel.requestTravelInbox();
  }

  setPartyTravelAllowed(allowed: boolean): boolean{
    return this.domains.party.setPartyTravelAllowed(allowed);
  }

  setPartyAutoFollow(enabled: boolean): boolean{
    return this.domains.party.setPartyAutoFollow(enabled);
  }

  travelToPartyLeader(
      requestId = crypto.randomUUID()
    ): string | null{
    return this.domains.travel.travelToPartyLeader(requestId);
  }

  removePartyMember(targetPlayerId: string): boolean{
    return this.domains.party.removePartyMember(targetPlayerId);
  }

  leaveParty(): boolean{
    return this.domains.party.leaveParty();
  }

  disbandParty(): boolean{
    return this.domains.party.disbandParty();
  }

  changePartyLeader(targetPlayerId: string): boolean{
    return this.domains.party.changePartyLeader(targetPlayerId);
  }

  requestPartyCombatSnapshot(): boolean{
    return this.domains.party.requestPartyCombatSnapshot();
  }

  startPartyReadyCheck(): boolean{
    return this.domains.party.startPartyReadyCheck();
  }

  respondPartyReadyCheck(readyCheckId: string, response: "ready" | "not_ready"): boolean{
    return this.domains.party.respondPartyReadyCheck(readyCheckId, response);
  }

  cancelPartyReadyCheck(readyCheckId: string): boolean{
    return this.domains.party.cancelPartyReadyCheck(readyCheckId);
  }

  equipItem(
      instanceId: string,
      slot: EquipmentSlot,
      requestId: string = crypto.randomUUID()
    ): string | null{
    return this.domains.combat.equipItem(instanceId, slot, requestId);
  }

  unequipItem(instanceId: string, requestId: string = crypto.randomUUID()): string | null{
    return this.domains.combat.unequipItem(instanceId, requestId);
  }

  upgradeEquipment(
      instanceId: string,
      expectedLevel: number,
      requestId: string = crypto.randomUUID(),
      manorSessionId?: string,
      manorMovementSequence?: number
    ): string | null{
    return this.domains.combat.upgradeEquipment(
      instanceId,
      expectedLevel,
      requestId,
      manorSessionId,
      manorMovementSequence
    );
  }

  craftEquipment(
    familyId: EquipmentGameplayFamilyId,
    requestId: string,
    manorSessionId: string,
    manorMovementSequence: number,
    swagDefinitionId?: EquipmentDefinitionId
  ): string | null {
    return this.domains.combat.craftEquipment(
      familyId,
      requestId,
      manorSessionId,
      manorMovementSequence,
      swagDefinitionId
    );
  }

  craftPortableEquipment(familyId: EquipmentGameplayFamilyId, requestId: string): string | null {
    return this.domains.combat.craftPortableEquipment(familyId, requestId);
  }

  craftRepairKit(
    requestId: string,
    manorSessionId: string,
    manorMovementSequence: number
  ): string | null {
    return this.domains.combat.craftRepairKit(
      requestId,
      manorSessionId,
      manorMovementSequence
    );
  }

  startFlagBurn(flagId: string, requestId: string = crypto.randomUUID()): string | null {
    return this.domains.flag.startFlagBurn(flagId, requestId);
  }

  attackFlag(flagId: string, requestId: string = crypto.randomUUID()): string | null {
    return this.domains.flag.attackFlag(flagId, requestId);
  }

  startFlagRepair(flagId: string, requestId: string = crypto.randomUUID()): string | null {
    return this.domains.flag.startFlagRepair(flagId, requestId);
  }

  cancelFlagRepair(flagId: string, operationId: string, requestId: string = crypto.randomUUID()): boolean {
    return this.domains.flag.cancelFlagRepair(flagId, operationId, requestId);
  }

  startFlagRepairDisrupt(flagId: string, repairOperationId: string, requestId: string = crypto.randomUUID()): string | null {
    return this.domains.flag.startFlagRepairDisrupt(flagId, repairOperationId, requestId);
  }

  cancelFlagRepairDisrupt(flagId: string, operationId: string, requestId: string = crypto.randomUUID()): boolean {
    return this.domains.flag.cancelFlagRepairDisrupt(flagId, operationId, requestId);
  }

  craftTorch(requestId: string = crypto.randomUUID()): string | null {
    return this.domains.flag.craftTorch(requestId);
  }

  polishRing(instanceId: string, requestId: string = crypto.randomUUID()): string | null {
    return this.domains.combat.polishRing(instanceId, requestId);
  }

  /** Tiller Boot: plant a 3x3 block of saplings around the player. */
  plantSaplingsGrid(): string | null {
    return this.domains.pet.plantSaplingsGrid();
  }

  craftGearScroll(requestId: string = crypto.randomUUID()): string | null {
    return this.domains.combat.craftGearScroll(requestId);
  }

  requestGearScrolls(requestId: string = crypto.randomUUID()): string | null {
    return this.domains.combat.requestGearScrolls(requestId);
  }

  rememberGearScroll(position: number, group: GearScrollMemoryGroup, requestId: string = crypto.randomUUID()): string | null {
    return this.domains.combat.rememberGearScroll(position, group, requestId);
  }

  equipGearScroll(position: number, requestId: string = crypto.randomUUID()): string | null {
    return this.domains.combat.equipGearScroll(position, requestId);
  }

  craftUtilityGear(definitionId: UtilityGearDefinitionId, requestId: string = crypto.randomUUID()): string | null {
    return this.domains.combat.craftUtilityGear(definitionId, requestId);
  }

  dumpRing(instanceId: string, requestId: string = crypto.randomUUID()): string | null {
    return this.domains.combat.dumpRing(instanceId, requestId);
  }

  mendEquipment(instanceId: string, requestId: string, stackId?: string): string | null {
    return this.domains.combat.mendEquipment(instanceId, requestId, stackId);
  }

  repairEquipment(
    instanceId: string,
    expectedCondition: number,
    requestId: string,
    manorSessionId: string,
    manorMovementSequence: number
  ): string | null {
    return this.domains.combat.repairEquipment(
      instanceId,
      expectedCondition,
      requestId,
      manorSessionId,
      manorMovementSequence
    );
  }

  purchaseLimitedEquipment(
    definitionId: EquipmentDefinitionId,
    requestId: string,
    manorSessionId: string,
    manorMovementSequence: number
  ): string | null {
    return this.domains.combat.purchaseLimitedEquipment(
      definitionId,
      requestId,
      manorSessionId,
      manorMovementSequence
    );
  }

  saveCombatKit(
      kitIndex: number,
      expectedInventoryRevision: number,
      requestId: string = crypto.randomUUID()
    ): string | null{
    return this.domains.combat.saveCombatKit(kitIndex, expectedInventoryRevision, requestId);
  }

  renameCombatKit(
      kitIndex: number,
      name: string,
      requestId: string = crypto.randomUUID()
    ): string | null{
    return this.domains.combat.renameCombatKit(kitIndex, name, requestId);
  }

  clearCombatKit(
      kitIndex: number,
      expectedInventoryRevision: number,
      requestId: string = crypto.randomUUID()
    ): string | null{
    return this.domains.combat.clearCombatKit(kitIndex, expectedInventoryRevision, requestId);
  }

  activateCombatKit(
      kitIndex: number,
      expectedInventoryRevision: number,
      requestId: string = crypto.randomUUID()
    ): string | null{
    return this.domains.combat.activateCombatKit(kitIndex, expectedInventoryRevision, requestId);
  }

  toggleReadiedWeapon(
      readiedWeaponSlot: "melee" | "secondary",
      expectedInventoryRevision: number,
      requestId: string = crypto.randomUUID()
    ): string | null{
    return this.domains.combat.toggleReadiedWeapon(readiedWeaponSlot, expectedInventoryRevision, requestId);
  }

  requestKingdomState(): boolean{
    return this.domains.settlement.requestKingdomState();
  }

  sendKingdomChat(content: string, requestId: string = crypto.randomUUID()): boolean{
    return this.domains.settlement.sendKingdomChat(content, requestId);
  }

  requestWorldResync(
    combatSequence: number,
    playerSequence: number,
    expectedWorldViewAuthority?: WorldViewAuthority
  ): boolean{
    const sent = this.domains.world.requestWorldResync(
      combatSequence,
      playerSequence,
      expectedWorldViewAuthority
    );
    if (sent) this.enqueueTelemetrySample("world_resync");
    return sent;
  }

  noteFrameForTelemetry(frameMs: number): void {
    if (
      !this.telemetryEnabled ||
      frameMs < 250 ||
      Date.now() - this.lastSevereFrameStallTelemetryAt <
        CLIENT_TELEMETRY_INTERVAL_MS
    ) {
      return;
    }
    this.lastSevereFrameStallTelemetryAt = Date.now();
    this.enqueueTelemetrySample("severe_frame_stall");
  }

  requestPopulationResync(operation: PopulationResyncOperation): string | null {
    return this.domains.world.requestPopulationResync(operation);
  }

  selectChatChannel(channelKey: string, afterSequence?: number): string | null{
    return this.domains.social.selectChatChannel(channelKey, afterSequence);
  }

  requestChatBootstrap(): boolean{
    return this.domains.social.requestChatBootstrap();
  }

  sendChatMessage(
      channelKey: string,
      body: string,
      requestId: string = crypto.randomUUID(),
      tradeListing?: ChatTradeListing,
      partyListing?: ChatPartyListingInput
    ): string | null{
    return this.domains.social.sendChatMessage(channelKey, body, requestId, tradeListing, partyListing);
  }

  joinPartyListing(messageId: string): boolean {
    return this.domains.party.joinPartyListing(messageId);
  }

  cancelPartyListing(messageId: string): boolean {
    return this.domains.party.cancelPartyListing(messageId);
  }

  respondPartyJoinRequest(joinRequestId: string, response: "accept" | "decline"): boolean {
    return this.domains.party.respondPartyJoinRequest(joinRequestId, response);
  }

  deleteChatMessage(messageId: string, requestId: string = crypto.randomUUID()): string | null {
    return this.domains.social.deleteChatMessage(messageId, requestId);
  }

  bootstrapDirectMessages(afterEventSequence?: string): string | null{
    return this.domains.social.bootstrapDirectMessages(afterEventSequence);
  }

  listDirectMessages(cursor: string | null = null, search?: string, limit = 25): string | null{
    return this.domains.social.listDirectMessages(cursor, search, limit);
  }

  openDirectMessage(peerPlayerId: string): string | null{
    return this.domains.social.openDirectMessage(peerPlayerId);
  }

  requestDirectMessageHistory(
      conversationId: string,
      beforeSequence: string | null,
      limit = 50
    ): string | null{
    return this.domains.social.requestDirectMessageHistory(conversationId, beforeSequence, limit);
  }

  sendDirectMessage(
      conversationId: string,
      clientMessageId: string,
      body: string
    ): string | null{
    return this.domains.social.sendDirectMessage(conversationId, clientMessageId, body);
  }

  updateDirectMessageRead(conversationId: string, throughSequence: string): string | null{
    return this.domains.social.updateDirectMessageRead(conversationId, throughSequence);
  }

  acknowledgeDirectMessageDelivery(conversationId: string, throughSequence: string): boolean{
    return this.domains.social.acknowledgeDirectMessageDelivery(conversationId, throughSequence);
  }

  setDirectMessageMute(conversationId: string, muted: boolean): boolean{
    return this.domains.social.setDirectMessageMute(conversationId, muted);
  }

  setDirectMessagePreferences(preferences: DirectMessagePreferences): boolean{
    return this.domains.social.setDirectMessagePreferences(preferences);
  }

  syncDirectMessages(afterEventSequence: string, limit = 100): string | null{
    return this.domains.social.syncDirectMessages(afterEventSequence, limit);
  }

  acknowledgeDirectMessageEvents(throughEventSequence: string): boolean{
    return this.domains.social.acknowledgeDirectMessageEvents(throughEventSequence);
  }

  requestChatHistory(
      channelKey: string,
      direction: "older" | "newer",
      cursorSequence: number | null,
      limit = 50
    ): string | null{
    return this.domains.social.requestChatHistory(channelKey, direction, cursorSequence, limit);
  }

  updateChatRead(channelKey: string, lastReadSequence: number): boolean{
    return this.domains.social.updateChatRead(channelKey, lastReadSequence);
  }

  marketOpen(
    requestId: string,
    marketStructureId: string,
    expectedPlacementRevision: string,
    options: { listedOnly?: boolean } = {}
  ): boolean {
    return this.domains.market.marketOpen(
      requestId,
      marketStructureId,
      expectedPlacementRevision,
      options
    );
  }

  marketBrowse(
      requestId: string,
      marketSessionId: string,
      options: {
        search?: string;
        category?: string;
        cursor?: string | null;
        limit?: number;
        listedOnly?: boolean;
      } = {}
    ): boolean{
    return this.domains.market.marketBrowse(requestId, marketSessionId, options);
  }

  buyCityMarketDaily(cityId: string): string | null {
    return this.domains.settlement.buyCityMarketDaily(cityId);
  }

  buildCityMarket(cityId: string, expectedCityRevision: string): string | null {
    return this.domains.settlement.buildCityMarket(cityId, expectedCityRevision);
  }

  buildCityMonument(
    cityId: string,
    districtType: CityDistrictType,
    expectedCityRevision: string,
    expectedDistrictRevision: string
  ): string | null {
    return this.domains.settlement.buildCityMonument(
      cityId,
      districtType,
      expectedCityRevision,
      expectedDistrictRevision
    );
  }

  upgradeCityMonument(
    structureId: string,
    expectedTier: 1 | 2,
    expectedPlacementRevision: string,
    expectedDistrictRevision: string
  ): string | null {
    return this.domains.settlement.upgradeCityMonument(
      structureId,
      expectedTier,
      expectedPlacementRevision,
      expectedDistrictRevision
    );
  }

  destroyCityMonument(
    structureId: string,
    expectedPlacementRevision: string,
    expectedDistrictRevision: string
  ): boolean {
    return this.domains.settlement.destroyCityMonument(
      structureId,
      expectedPlacementRevision,
      expectedDistrictRevision
    );
  }

  marketGetBook(
    requestId: string,
    marketSessionId: string,
    itemId: string,
    depth?: number,
    priceCurrency?: MarketPriceCurrency
  ): boolean{
    return this.domains.market.marketGetBook(requestId, marketSessionId, itemId, depth, priceCurrency);
  }

  marketRequestQuote(
      requestId: string,
      marketSessionId: string,
      itemId: string,
      quantity: MarketInteger,
      maximumUnitPrice: MarketInteger,
      priceCurrency?: MarketPriceCurrency
    ): boolean{
    return this.domains.market.marketRequestQuote(
      requestId,
      marketSessionId,
      itemId,
      quantity,
      maximumUnitPrice,
      priceCurrency
    );
  }

  marketCreateOrder(
      requestId: string,
      marketSessionId: string,
      interfaceMode: "simple" | "merchant",
      side: MarketOrderSide,
      itemId: string,
      quantity: MarketInteger,
      unitPrice: MarketInteger,
      priceCurrency?: MarketPriceCurrency
    ): boolean{
    return this.domains.market.marketCreateOrder(
      requestId,
      marketSessionId,
      interfaceMode,
      side,
      itemId,
      quantity,
      unitPrice,
      priceCurrency
    );
  }

  marketSimpleBuy(
      requestId: string,
      marketSessionId: string,
      quoteId: string,
      maximumTotal: MarketInteger
    ): boolean{
    return this.domains.market.marketSimpleBuy(
      requestId,
      marketSessionId,
      quoteId,
      maximumTotal
    );
  }

  marketCancelOrder(requestId: string, marketSessionId: string, orderId: string): boolean{
    return this.domains.market.marketCancelOrder(requestId, marketSessionId, orderId);
  }

  marketClaim(
    requestId: string,
    marketSessionId: string,
    scope: MarketCollectionScope
  ): boolean{
    return this.domains.market.marketClaim(requestId, marketSessionId, scope);
  }

  marketCreateEquipmentListing(
    requestId: string,
    marketSessionId: string,
    equipmentInstanceId: string,
    askingPrice: MarketInteger,
    expectedEquipmentRevision: MarketInteger,
    priceCurrency?: MarketPriceCurrency
  ): boolean {
    return this.domains.market.marketCreateEquipmentListing(
      requestId,
      marketSessionId,
      equipmentInstanceId,
      askingPrice,
      expectedEquipmentRevision,
      priceCurrency
    );
  }

  marketPurchaseEquipmentListing(
    requestId: string,
    marketSessionId: string,
    listingId: string,
    expectedListingVersion: MarketInteger,
    maximumBuyerTotal: MarketInteger,
    expectedTaxRevision: MarketInteger,
    expectedPriceCurrency?: MarketPriceCurrency
  ): boolean {
    return this.domains.market.marketPurchaseEquipmentListing(
      requestId,
      marketSessionId,
      listingId,
      expectedListingVersion,
      maximumBuyerTotal,
      expectedTaxRevision,
      expectedPriceCurrency
    );
  }

  marketCancelEquipmentListing(
    requestId: string,
    marketSessionId: string,
    listingId: string,
    expectedListingVersion: MarketInteger
  ): boolean {
    return this.domains.market.marketCancelEquipmentListing(
      requestId,
      marketSessionId,
      listingId,
      expectedListingVersion
    );
  }

  marketSetSubscriptions(
      requestId: string,
      marketSessionId: string,
      visibleItemIdentities: string[],
      focusedItemIdentity: string | null,
      privateState: boolean,
      revision: number
    ): boolean{
    return this.domains.market.marketSetSubscriptions(
      requestId,
      marketSessionId,
      visibleItemIdentities,
      focusedItemIdentity,
      privateState,
      revision
    );
  }

  private sendProtocol(message: ClientMessage, expectedGeneration?: number): boolean {
    const outcome = this.transport.send(message, expectedGeneration);
    bugReportDiagnostics.recordOutgoing(
      message,
      this.synchronizedNow(),
      this.transport.currentGeneration(),
      outcome.status === "sent"
        ? "sent"
        : outcome.status === "stale-socket"
          ? "stale"
          : "failed",
      wireBytes(message)
    );
    return outcome.status === "sent";
  }

  private sendCommandOutcome(
    message: ClientMessage,
    expectedGeneration?: number
  ): ClientSendOutcome {
    const outcome = this.sendOutcome(message, expectedGeneration);
    if (outcome.status === "sent") {
      this.consecutiveSendFailures = 0;
      return outcome;
    }
    if (outcome.status === "stale-socket-generation") {
      perfMetrics.noteWebSocketStaleEvent();
    } else if (
      outcome.status === "connecting" ||
      outcome.status === "session-bootstrap-pending" ||
      outcome.status === "suspended" ||
      outcome.status === "network-offline" ||
      outcome.status === "intentionally-disconnected"
    ) {
      perfMetrics.noteWebSocketSendFailure("closed");
    } else if (outcome.status === "send-failed") {
      perfMetrics.noteWebSocketSendFailure("failed");
      this.handlers.onError(
        outcome.error instanceof Error
          ? outcome.error.message
          : "websocket send failed"
      );
    }
    this.consecutiveSendFailures += 1;
    if (this.consecutiveSendFailures >= 3) {
      bugReportDiagnostics.recordError({
        category: "send_failure",
        name: "RepeatedSendFailure",
        message: "Three consecutive game commands could not be sent.",
        component: "game-client"
      });
      this.enqueueTelemetrySample("repeated_send_failure");
      this.consecutiveSendFailures = 0;
    }
    return outcome;
  }

  private sendOutcome(
    message: ClientMessage,
    expectedGeneration?: number
  ): ClientSendOutcome {
    if (this.protocolIncompatible) return this.recordFailedCommand(message, { status: "protocol-incompatible" });
    if (this.intentionallyDisconnected) return this.recordFailedCommand(message, { status: "intentionally-disconnected" });
    if (this.suspended) return this.recordFailedCommand(message, { status: "suspended" });
    if (!this.networkOnline) return this.recordFailedCommand(message, { status: "network-offline" });
    const activeGeneration = this.transport.currentGeneration();
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== activeGeneration
    ) {
      return this.recordFailedCommand(message, {
        status: "stale-socket-generation",
        expectedGeneration,
        activeGeneration
      });
    }
    if (!this.transportReady || this.transport.readyState() !== 1) {
      return this.recordFailedCommand(message, { status: "connecting" });
    }
    const admission = clientCommandAdmissionPolicy(message.type);
    if (admission.requiresSessionBootstrap && !this.sessionBootstrapComplete) {
      return this.recordFailedCommand(message, { status: "session-bootstrap-pending" });
    }
    const outcome = this.transport.send(message, expectedGeneration);
    switch (outcome.status) {
      case "sent":
        bugReportDiagnostics.recordOutgoing(
          message,
          this.synchronizedNow(),
          activeGeneration,
          "sent",
          wireBytes(message)
        );
        return {
          status: "sent",
          readiness: this.worldViewState === "ready"
            ? "ready"
            : "world-preparing",
          connectionGeneration: activeGeneration
        };
      case "stale-socket":
        return this.recordFailedCommand(message, {
          status: "stale-socket-generation",
          expectedGeneration: outcome.expectedGeneration,
          activeGeneration: outcome.activeGeneration
        });
      case "serialization-failed":
        return this.recordFailedCommand(message, {
          status: "send-failed",
          error: outcome.error,
          failure: "serialization"
        });
      case "send-failed":
        return this.recordFailedCommand(message, {
          status: "send-failed",
          error: outcome.error,
          failure: "transport"
        });
      case "socket-not-open":
        return this.recordFailedCommand(message, { status: "connecting" });
      case "intentionally-disconnected":
        return this.recordFailedCommand(message, { status: "intentionally-disconnected" });
      case "protocol-incompatible":
        return this.recordFailedCommand(message, { status: "protocol-incompatible" });
    }
  }

  private recordFailedCommand(
    message: ClientMessage,
    outcome: ClientSendOutcome
  ): ClientSendOutcome {
    bugReportDiagnostics.recordOutgoing(
      message,
      this.synchronizedNow(),
      this.transport.currentGeneration(),
      outcome.status === "stale-socket-generation" ? "stale" : "failed",
      wireBytes(message)
    );
    return outcome;
  }

  private clearPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startTelemetry(): void {
    if (!this.telemetryEnabled || this.telemetryTimer !== null) return;
    perfMetrics.resetRateSample("closed-test-telemetry");
    perfMetrics.getFrameTimeHistogram("closed-test-telemetry");
    this.telemetryTimer = window.setInterval(() => {
      if (
        this.worldViewState !== "ready" ||
        this.transport.readyState() !== 1 ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      const histogram = perfMetrics.getFrameTimeHistogram("closed-test-telemetry");
      this.enqueueTelemetrySample(
        histogram.maxMs >= 250 || histogram.p99Ms >= 100
          ? "severe_frame_stall"
          : "interval",
        histogram
      );
    }, CLIENT_TELEMETRY_INTERVAL_MS);
  }

  private clearTelemetry(): void {
    if (this.telemetryTimer !== null) {
      window.clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    this.telemetryPending.length = 0;
  }

  private flushStartupTerminalTelemetry(): void {
    while (this.pendingStartupTerminalTelemetry.length > 0) {
      const pending = this.pendingStartupTerminalTelemetry[0]!;
      if (!this.sendProtocol(pending)) return;
      this.pendingStartupTerminalTelemetry.shift();
    }
  }

  private enqueueTelemetrySample(
    reason: ClientTelemetrySample["reason"],
    suppliedHistogram?: ReturnType<typeof perfMetrics.getFrameTimeHistogram>
  ): void {
    if (
      !this.telemetryEnabled ||
      this.worldViewState !== "ready" ||
      this.transport.readyState() !== 1 ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const snapshot = perfMetrics.getSnapshot("closed-test-telemetry");
    const histogram =
      suppliedHistogram ?? perfMetrics.getFrameTimeHistogram("closed-test-telemetry");
    const rtt = [...this.rttSamplesMs].sort((left, right) => left - right);
    const device = normalizedClientPlatform();
    const collectibleRedrawCount = nonnegativeDelta(
      snapshot.collectibleRedrawCount,
      this.telemetryPreviousCollectibleRedrawCount
    );
    const collectibleRedrawDurationMs = nonnegativeDelta(
      snapshot.collectibleDrawMs,
      this.telemetryPreviousCollectibleDrawMs
    );
    const staticOverlayRedrawCount = nonnegativeDelta(
      snapshot.staticOverlayRedrawCount,
      this.telemetryPreviousStaticRedrawCount
    );
    this.telemetryPreviousCollectibleRedrawCount = snapshot.collectibleRedrawCount;
    this.telemetryPreviousCollectibleDrawMs = snapshot.collectibleDrawMs;
    this.telemetryPreviousStaticRedrawCount = snapshot.staticOverlayRedrawCount;
    const sample: ClientTelemetrySample = {
      sequence: this.telemetrySequence++,
      reason,
      ...device,
      installedPwa: window.matchMedia?.("(display-mode: standalone)").matches ?? false,
      foregroundState: "foreground",
      viewportWidth: boundedInteger(window.innerWidth, 1, 16_384),
      viewportHeight: boundedInteger(window.innerHeight, 1, 16_384),
      screenSizeClass:
        window.innerWidth < 640 ? "small" : window.innerWidth < 1_024 ? "medium" : "large",
      fpsMean: boundedMetric(
        histogram.meanMs > 0 ? 1_000 / histogram.meanMs : snapshot.fps,
        1_000
      ),
      frameTimeP50Ms: boundedMetric(histogram.p50Ms),
      frameTimeP95Ms: boundedMetric(histogram.p95Ms),
      frameTimeP99Ms: boundedMetric(histogram.p99Ms),
      frameTimeMaxMs: boundedMetric(histogram.maxMs),
      longFramesOver50Ms: histogram.over50Ms,
      longFramesOver100Ms: histogram.over100Ms,
      rttMeanMs:
        rtt.length === 0
          ? null
          : boundedMetric(rtt.reduce((total, value) => total + value, 0) / rtt.length),
      rttP95Ms: nullableBoundedMetric(clientPercentile(rtt, 0.95)),
      authoritativeSnapshotAgeMs: nullableBoundedMetric(snapshot.lastSnapshotAgeMs),
      websocketReconnectCount: snapshot.websocketReconnectCount,
      websocketSendFailures: {
        closed: snapshot.websocketSendClosedCount,
        failed: snapshot.websocketSendFailedCount
      },
      staleSocketEvents: snapshot.websocketStaleEventCount,
      visibleFlagCount: snapshot.visibleFlagCount,
      visibleCollectibleCount: snapshot.collectibleCount,
      visibleCombatEntityCount: snapshot.combatEntityCount,
      retainedDisplayObjectCount: snapshot.retainedDisplayObjectCount,
      collectibleRedrawCount,
      collectibleRedrawDurationMs: boundedMetric(collectibleRedrawDurationMs),
      staticOverlayRedrawCount,
      staticOverlayRedrawDurationMs: boundedMetric(snapshot.maxStaticOverlayDrawMs),
      clientReleaseIdentifier:
        import.meta.env.VITE_GAME_BUILD_SHA ?? "development"
    };
    bugReportDiagnostics.recordPerformance(sample, this.synchronizedNow());
    if (this.telemetryPending.length >= CLIENT_TELEMETRY_MAX_PENDING) {
      const routineIndex = this.telemetryPending.findIndex(
        (pending) => pending.reason === "interval"
      );
      this.telemetryPending.splice(routineIndex >= 0 ? routineIndex : 0, 1);
    }
    this.telemetryPending.push(sample);
    const batch = this.telemetryPending.splice(0, CLIENT_TELEMETRY_MAX_PENDING);
    if (!this.sendProtocol({ type: "TELEMETRY_BATCH", samples: batch })) {
      this.telemetryPending.length = 0;
    }
  }

  private scheduleReconnect(): void {
    if (
      this.reconnectTimer !== null ||
      this.intentionallyDisconnected ||
      this.suspended ||
      !this.networkOnline
    ) return;
    const now = Date.now();
    this.recoveryStartedAt ??= now;
    if (now - this.recoveryStartedAt >= RECONNECT_WINDOW_MS) {
      this.endRecoveryWindow();
      return;
    }
    const retryDelays = [0, 250, 500, 1_000, 2_000, 3_000, 5_000];
    const baseDelay = retryDelays[Math.min(this.reconnectAttempts, retryDelays.length - 1)]!;
    const jitter = RECONNECT_JITTER_MIN + this.random() * RECONNECT_JITTER_SPAN;
    const delayMs = baseDelay === 0
      ? 0
      : Math.min(RECONNECT_MAX_DELAY_MS, Math.round(baseDelay * jitter));
    this.reconnectAttempts += 1;
    const generation = this.transport.currentGeneration();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (
        !this.intentionallyDisconnected &&
        generation === this.transport.currentGeneration()
      ) {
        this.openSocket();
      }
    }, delayMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private endRecoveryWindow(): void {
    if (this.recoveryWindowEnded) return;
    this.recoveryWindowEnded = true;
    this.handlers.onRecoveryWindowEnded?.();
  }
}

function normalizedClientPlatform(): Pick<
  ClientTelemetrySample,
  | "deviceCategory"
  | "operatingSystemFamily"
  | "browserFamily"
  | "browserMajorVersion"
> {
  const userAgent = navigator.userAgent;
  const deviceCategory: ClientTelemetrySample["deviceCategory"] =
    /iPad|Tablet|Android(?!.*Mobile)/i.test(userAgent)
      ? "tablet"
      : /Mobi|iPhone|Android/i.test(userAgent)
        ? "phone"
        : "desktop";
  const operatingSystemFamily =
    /Windows/i.test(userAgent)
      ? "Windows"
      : /Android/i.test(userAgent)
        ? "Android"
        : /iPhone|iPad|iPod/i.test(userAgent)
          ? "iOS"
          : /Mac OS X|Macintosh/i.test(userAgent)
            ? "macOS"
            : /Linux/i.test(userAgent)
              ? "Linux"
              : "Unknown";
  const browserMatch =
    userAgent.match(/Edg\/(\d+)/i) ??
    userAgent.match(/Firefox\/(\d+)/i) ??
    userAgent.match(/(?:Chrome|CriOS)\/(\d+)/i) ??
    userAgent.match(/Version\/(\d+).+Safari/i);
  const browserFamily =
    /Edg\//i.test(userAgent)
      ? "Edge"
      : /Firefox\//i.test(userAgent)
        ? "Firefox"
        : /(?:Chrome|CriOS)\//i.test(userAgent)
          ? "Chrome"
          : /Safari\//i.test(userAgent)
            ? "Safari"
            : "Unknown";
  return {
    deviceCategory,
    operatingSystemFamily,
    browserFamily,
    browserMajorVersion: browserMatch?.[1] ? Number(browserMatch[1]) : null
  };
}

function clientPercentile(values: readonly number[], rank: number): number | null {
  if (values.length === 0) return null;
  return values[
    Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * rank) - 1))
  ] ?? null;
}

function nonnegativeDelta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function boundedMetric(value: number, maximum = 86_400_000): number {
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));
}

function nullableBoundedMetric(value: number | null): number | null {
  return value === null ? null : boundedMetric(value);
}

function sameWorldViewAuthority(
  left: WorldViewAuthority,
  right: WorldViewAuthority
): boolean {
  return left.playerId === right.playerId &&
    left.connectionId === right.connectionId &&
    left.connectionGeneration === right.connectionGeneration &&
    left.relocationRevision === right.relocationRevision &&
    left.resourceVisionRevision === right.resourceVisionRevision &&
    left.gameplayViewGeneration === right.gameplayViewGeneration &&
    left.populationPreparationGeneration ===
      right.populationPreparationGeneration;
}

function incomingByteLength(data: unknown): number {
  // Frames are JSON text; UTF-16 length is a close enough byte count for diagnostics and avoids a full re-encode.
  return typeof data === "string" ? data.length : 0;
}

function wireBytes(message: ClientMessage): number {
  try {
    return new TextEncoder().encode(JSON.stringify(message)).byteLength;
  } catch {
    return 0;
  }
}
