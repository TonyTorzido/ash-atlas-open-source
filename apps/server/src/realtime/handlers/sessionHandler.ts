import {
  BUG_REPORT_WIRE_MAX_BYTES,
  BUG_REPORT_HISTORY_WINDOW_MS,
  type AshAtlasNegotiatedProtocol,
  type BugReportSubmitMessage,
  type BugReportSubmitResultMessage,
  type LatLon,
  type WorldViewAuthority
} from "@ash-atlas/shared";

import type { CombatEngine } from "../../game/combat/combatEngine.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { CreatureBookService } from "../../game/creatureBook.js";
import type { BiomeDiscoveryService } from "../../game/biomeDiscovery.js";
import type { ClosedTestTelemetryService } from "../../telemetry/service.js";
import type { BugReportAuthoritativeContext } from "../../telemetry/service.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type {
  MessageForFamily,
  RealtimeFamilyHandler,
  RealtimeMessageRouter
} from "../messageRouter.js";
import {
  requireHello,
  sendCombatError
} from "./handlerExecutionContext.js";

export type SessionConnectionState = {
  playerId: string | null;
  connectionId: string | null;
  helloReceived: boolean;
  connectionGeneration: number | null;
  socketClosed: boolean;
  greenhouseCropCatalogVersion?: number;
  greenhouseCropPackId?: string | null;
  protocol: AshAtlasNegotiatedProtocol;
  protocolMetadataAdvertised: boolean;
};

type BugReportResultPayload =
  | Omit<
      Extract<BugReportSubmitResultMessage, { success: true }>,
      "type" | "requestId"
    >
  | Omit<
      Extract<BugReportSubmitResultMessage, { success: false }>,
      "type" | "requestId"
    >;

export type SessionHandlerContext = Readonly<{
  state: SessionConnectionState;
  socket: SocketLike;
  registry: ConnectionRegistry;
  worldRuntime?: WorldRuntime | undefined;
  combat?: CombatEngine | undefined;
  creatureBook?: Pick<CreatureBookService, "snapshot"> | undefined;
  biomeDiscovery?: Pick<BiomeDiscoveryService, "discover"> | undefined;
  /** The authoritative position while the player stands in the open world; null otherwise. */
  openWorldPosition?: ((playerId: string) => LatLon | null) | undefined;
  telemetry?: Pick<
    ClosedTestTelemetryService,
    "acceptClientBatch" | "openSession" | "recordEvent" | "submitBugReport"
  > | undefined;
  authSessionId?: string | null | undefined;
  accountRateKey?: string | null | undefined;
  captureBugReportContext?: ((
    playerId: string,
    report: BugReportSubmitMessage
  ) => Promise<BugReportAuthoritativeContext>) | undefined;
  capturePlayerSnapshot?: ((
    playerId: string,
    sessionId: string,
    reason: "login"
  ) => void | Promise<void>) | undefined;
  bootstrapHello(
    message: Extract<MessageForFamily<"session">, { type: "HELLO" }>
  ): Promise<void>;
  suspendConnection(): void;
  rejectDuringPlayerWorldTransition(requestId: string): boolean;
  requestWorldResync(
    requestId: string,
    expectedWorldViewAuthority?: WorldViewAuthority
  ): void;
  requestPopulationResync(
    message: Extract<
      MessageForFamily<"session">,
      { type: "REQUEST_POPULATION_RESYNC" }
    >
  ): void;
}>;

export function createSessionHandler(
  context: SessionHandlerContext
): RealtimeFamilyHandler<"session"> {
  const recordedStartupTerminals = new Set<string>();
  return async (message) => {
    const {
      state,
      socket,
      registry,
      worldRuntime,
      combat,
      creatureBook,
      biomeDiscovery,
      openWorldPosition,
      telemetry,
      authSessionId,
      accountRateKey,
      captureBugReportContext,
      capturePlayerSnapshot,
      bootstrapHello,
      suspendConnection,
      rejectDuringPlayerWorldTransition,
      requestWorldResync,
      requestPopulationResync
    } = context;
    switch (message.type) {
      case "HELLO":
        await bootstrapHello(message);
        if (
          telemetry &&
          authSessionId &&
          state.playerId &&
          state.connectionGeneration !== null
        ) {
          const playerId = state.playerId;
          const telemetrySessionId = telemetry.openSession({
            playerId,
            sessionId: authSessionId,
            connectionGeneration: state.connectionGeneration
          });
          if (capturePlayerSnapshot) {
            void Promise.resolve()
              .then(() => capturePlayerSnapshot(
                playerId,
                telemetrySessionId ?? authSessionId,
                "login"
              ))
              .catch(() => undefined);
          }
        }
        return;
      case "APP_SUSPEND":
        requireHello(state.playerId);
        if (telemetry && authSessionId && state.connectionGeneration !== null) {
          telemetry.recordEvent({
            eventFamily: "connection",
            eventType: "application_suspend",
            priority: "important",
            playerId: state.playerId,
            sessionId: authSessionId,
            connectionGeneration: state.connectionGeneration
          });
        }
        suspendConnection();
        return;
      case "TELEMETRY_BATCH":
        requireHello(state.playerId);
        if (
          telemetry &&
          authSessionId &&
          state.connectionGeneration !== null
        ) {
          telemetry.acceptClientBatch({
            playerId: state.playerId,
            sessionId: authSessionId,
            connectionGeneration: state.connectionGeneration,
            samples: message.samples
          });
        }
        return;
      case "STARTUP_TERMINAL_TELEMETRY": {
        requireHello(state.playerId);
        if (
          !telemetry ||
          !authSessionId ||
          state.connectionGeneration === null
        ) return;
        const terminalKey = `${message.attempt}:${message.outcome}`;
        if (
          recordedStartupTerminals.has(terminalKey) ||
          recordedStartupTerminals.size >= 8
        ) return;
        recordedStartupTerminals.add(terminalKey);
        telemetry.recordEvent({
          eventFamily: "session",
          eventType: "startup_terminal",
          priority: message.outcome === "timeout" ? "important" : "routine",
          playerId: state.playerId,
          sessionId: authSessionId,
          connectionGeneration: state.connectionGeneration,
          durationMs: message.elapsedStartupMs,
          metadata: {
            outcome: message.outcome,
            reason: message.reason,
            phase: message.phase,
            attempt: message.attempt,
            socketState: message.socketState,
            welcomeReceived: message.welcomeReceived,
            progressionReceived: message.progressionReceived,
            locationReceived: message.locationReceived,
            playerReceived: message.playerReceived,
            flagsReceived: message.flagsReceived,
            mapReady: message.mapReady,
            mapPainted: message.mapPainted,
            overlayReady: message.overlayReady,
            worldReady: message.worldReady,
            presentationSnapshotReceived:
              message.presentationSnapshotReceived,
            hasCompletedBootstrap: message.hasCompletedBootstrap,
            observedConnectionId: message.connectionId,
            observedConnectionGeneration: message.connectionGeneration,
            ingestingConnectionId: state.connectionId,
            relocationRevision: message.relocationRevision,
            resourceVisionRevision: message.resourceVisionRevision,
            gameplayViewGeneration: message.gameplayViewGeneration,
            populationPreparationGeneration:
              message.populationPreparationGeneration,
            deviceCategory: message.deviceCategory,
            operatingSystemFamily: message.operatingSystemFamily,
            browserFamily: message.browserFamily,
            browserMajorVersion: message.browserMajorVersion,
            installedPwa: message.installedPwa,
            clientReleaseIdentifier: message.clientReleaseIdentifier
          }
        });
        return;
      }
      case "BUG_REPORT_SUBMIT": {
        requireHello(state.playerId);
        const connectionId = state.connectionId;
        const sendResult = (result: BugReportResultPayload): void => {
          if (!connectionId) return;
          registry.sendToConnection(connectionId, {
            type: "BUG_REPORT_SUBMIT_RESULT",
            requestId: message.requestId,
            ...result
          });
        };
        if (
          Buffer.byteLength(JSON.stringify(message), "utf8") >
          BUG_REPORT_WIRE_MAX_BYTES
        ) {
          sendResult({
            success: false,
            code: "BUG_REPORT_TOO_LARGE",
            message: "The diagnostic snapshot is too large. Reopen Report a Bug and retry.",
            retryable: false
          });
          return;
        }
        if (
          message.windowEndAt !== message.reportMarkerAt ||
          message.windowStartAt !==
            message.reportMarkerAt - BUG_REPORT_HISTORY_WINDOW_MS ||
          message.availableWindowStartAt < message.windowStartAt ||
          message.availableWindowStartAt > message.windowEndAt
        ) {
          sendResult({
            success: false,
            code: "BUG_REPORT_WINDOW_INVALID",
            message: "The diagnostic timing was invalid. Reopen Report a Bug and retry.",
            retryable: false
          });
          return;
        }
        if (
          state.connectionGeneration === null ||
          message.connectionGeneration !== state.connectionGeneration
        ) {
          sendResult({
            success: false,
            code: "BUG_REPORT_SESSION_STALE",
            message: "The connection changed. Reopen Report a Bug and retry.",
            retryable: false
          });
          return;
        }
        if (
          !telemetry ||
          !authSessionId ||
          !accountRateKey ||
          !connectionId ||
          !captureBugReportContext
        ) {
          sendResult({
            success: false,
            code: "BUG_REPORTS_DISABLED",
            message: "Bug reporting is temporarily unavailable.",
            retryable: true
          });
          return;
        }
        let authoritative: BugReportAuthoritativeContext;
        try {
          authoritative = await captureBugReportContext(state.playerId, message);
        } catch {
          sendResult({
            success: false,
            code: "BUG_REPORT_SNAPSHOT_FAILED",
            message: "The report snapshot could not be created. Please retry.",
            retryable: true
          });
          return;
        }
        const result = await telemetry.submitBugReport({
          accountRateKey,
          connectionKey: connectionId,
          playerId: state.playerId,
          sessionId: authSessionId,
          connectionGeneration: state.connectionGeneration,
          report: message,
          authoritative
        });
        if (result.success) {
          sendResult({
            success: true,
            reportCode: result.reportCode
          });
        } else {
          sendResult({
            success: false,
            code: result.code,
            message: result.message,
            retryable: result.retryable,
            ...("retryAfterMs" in result
              ? { retryAfterMs: result.retryAfterMs }
              : {})
          });
        }
        return;
      }
      case "REQUEST_WORLD_RESYNC": {
        requireHello(state.playerId);
        const transition = state.playerId
          ? worldRuntime?.playerWorldTransitionState(state.playerId)
          : null;
        if (
          transition?.committedRelocationRevision === null &&
          rejectDuringPlayerWorldTransition(message.requestId)
        ) return;
        if (!worldRuntime || !combat) {
          sendCombatError(
            socket,
            message.requestId,
            "RESYNC_UNAVAILABLE",
            "World resync is unavailable"
          );
          return;
        }
        requestWorldResync(
          message.requestId,
          message.expectedWorldViewAuthority
        );
        return;
      }
      case "REQUEST_POPULATION_RESYNC":
        requireHello(state.playerId);
        requestPopulationResync(message);
        return;
      case "REQUEST_CREATURE_BOOK":
        requireHello(state.playerId);
        if (!state.connectionId || !creatureBook) return;
        registry.sendToConnection(state.connectionId, {
          type: "CREATURE_BOOK_SNAPSHOT",
          snapshot: await creatureBook.snapshot(state.playerId)
        });
        return;
      case "REQUEST_BIOME_DISCOVERY": {
        requireHello(state.playerId);
        const { playerId, connectionId } = state;
        if (!connectionId || !biomeDiscovery) return;
        const result = await biomeDiscovery.discover(
          playerId,
          openWorldPosition?.(playerId) ?? null
        );
        if (!result) return;
        registry.sendToConnection(connectionId, { type: "BIOME_DISCOVERY_SNAPSHOT", ...result });
        return;
      }
      case "PING":
        if (state.connectionId) {
          registry.sendToConnection(state.connectionId, {
            type: "PONG",
            clientTime: message.clientTime,
            serverTime: Date.now()
          });
        }
        return;
    }
  };
}
export function registerSessionHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"session">
): void {
  router.register("session", handler);
}
