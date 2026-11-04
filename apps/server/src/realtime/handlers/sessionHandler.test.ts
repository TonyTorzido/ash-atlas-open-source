import type {
  BugReportSubmitMessage,
  ClientTelemetrySample,
  StartupTerminalTelemetryMessage
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import { createSessionHandler, type SessionConnectionState } from "./sessionHandler.js";

const sample: ClientTelemetrySample = {
  sequence: 1,
  reason: "interval",
  deviceCategory: "desktop",
  operatingSystemFamily: "Windows",
  browserFamily: "Chrome",
  browserMajorVersion: 140,
  installedPwa: false,
  foregroundState: "foreground",
  viewportWidth: 1280,
  viewportHeight: 720,
  screenSizeClass: "large",
  fpsMean: 60,
  frameTimeP50Ms: 16,
  frameTimeP95Ms: 20,
  frameTimeP99Ms: 30,
  frameTimeMaxMs: 40,
  longFramesOver50Ms: 0,
  longFramesOver100Ms: 0,
  rttMeanMs: 30,
  rttP95Ms: 40,
  authoritativeSnapshotAgeMs: 20,
  websocketReconnectCount: 0,
  websocketSendFailures: { closed: 0, failed: 0 },
  staleSocketEvents: 0,
  visibleFlagCount: 1,
  visibleCollectibleCount: 2,
  visibleCombatEntityCount: 0,
  retainedDisplayObjectCount: 10,
  collectibleRedrawCount: 1,
  collectibleRedrawDurationMs: 2,
  staticOverlayRedrawCount: 1,
  staticOverlayRedrawDurationMs: 1,
  clientReleaseIdentifier: "test"
};

const startupTerminal: StartupTerminalTelemetryMessage = {
  type: "STARTUP_TERMINAL_TELEMETRY",
  outcome: "timeout",
  reason: "startup_timeout",
  elapsedStartupMs: 30_000,
  phase: "connected",
  attempt: 1,
  socketState: "open",
  welcomeReceived: true,
  progressionReceived: true,
  locationReceived: true,
  playerReceived: true,
  flagsReceived: true,
  mapReady: true,
  mapPainted: false,
  overlayReady: true,
  worldReady: true,
  presentationSnapshotReceived: false,
  hasCompletedBootstrap: false,
  connectionId: "observed-connection",
  connectionGeneration: 6,
  relocationRevision: 2,
  resourceVisionRevision: 3,
  gameplayViewGeneration: 4,
  populationPreparationGeneration: 5,
  deviceCategory: "phone",
  operatingSystemFamily: "Android",
  browserFamily: "Chrome",
  browserMajorVersion: 140,
  installedPwa: true,
  clientReleaseIdentifier: "a".repeat(64)
};

describe("session telemetry handler", () => {
  it("returns the server-redacted creature book snapshot for the authenticated player", async () => {
    const sendToConnection = vi.fn();
    const snapshot = {
      slots: Array.from({ length: 16 }, (_, bookOrder) => ({
        bookOrder,
        unlocked: false as const
      }))
    };
    const creatureBook = { snapshot: vi.fn(async () => snapshot) };
    const handler = createSessionHandler({
      ...context(state("player-server", 7), vi.fn()),
      registry: { sendToConnection } as unknown as ConnectionRegistry,
      creatureBook
    });

    await handler({ type: "REQUEST_CREATURE_BOOK" });

    expect(creatureBook.snapshot).toHaveBeenCalledWith("player-server");
    expect(sendToConnection).toHaveBeenCalledWith("connection-test", {
      type: "CREATURE_BOOK_SNAPSHOT",
      snapshot
    });
  });

  it("resolves biome discovery from the server's open-world position, not the client", async () => {
    const sendToConnection = vi.fn();
    const result = {
      biomes: ["plains" as const],
      newlyDiscovered: "plains" as const,
      celebration: { biome: "plains" as const, achievements: [{ id: "legend_region_plains", title: "Endless Horizon", points: 10 }] },
      current: { biome: "plains" as const, tags: [], heightWord: "Lowland", authority: "world" as const }
    };
    const biomeDiscovery = { discover: vi.fn(async () => result) };
    const openWorldPosition = vi.fn(() => ({ lat: 41, lon: -100 }));
    const handler = createSessionHandler({
      ...context(state("player-server", 7), vi.fn()),
      registry: { sendToConnection } as unknown as ConnectionRegistry,
      biomeDiscovery,
      openWorldPosition
    });

    await handler({ type: "REQUEST_BIOME_DISCOVERY" });

    expect(openWorldPosition).toHaveBeenCalledWith("player-server");
    expect(biomeDiscovery.discover).toHaveBeenCalledWith("player-server", { lat: 41, lon: -100 });
    expect(sendToConnection).toHaveBeenCalledWith("connection-test", {
      type: "BIOME_DISCOVERY_SNAPSHOT",
      ...result
    });

    biomeDiscovery.discover.mockResolvedValueOnce(null as never);
    await handler({ type: "REQUEST_BIOME_DISCOVERY" });
    expect(sendToConnection).toHaveBeenCalledOnce();
  });

  it("rejects telemetry before authoritative HELLO identity exists", async () => {
    const acceptClientBatch = vi.fn();
    const handler = createSessionHandler(context(
      state(null, null),
      acceptClientBatch
    ));

    await expect(handler({ type: "TELEMETRY_BATCH", samples: [sample] }))
      .rejects.toThrow("HELLO is required");
    expect(acceptClientBatch).not.toHaveBeenCalled();
  });

  it("attributes a write-only frame to server-owned identity without replying", async () => {
    const acceptClientBatch = vi.fn();
    const sendToConnection = vi.fn();
    const handler = createSessionHandler({
      ...context(state("player-server", 7), acceptClientBatch),
      registry: { sendToConnection } as unknown as ConnectionRegistry
    });

    await handler({ type: "TELEMETRY_BATCH", samples: [sample] });

    expect(acceptClientBatch).toHaveBeenCalledWith({
      playerId: "player-server",
      sessionId: "00000000-0000-0000-0000-000000000007",
      connectionGeneration: 7,
      samples: [sample]
    });
    expect(sendToConnection).not.toHaveBeenCalled();
  });

  it("records one sanitized startup terminal event under server-owned identity", async () => {
    const recordEvent = vi.fn(() => true);
    const handler = createSessionHandler({
      ...context(state("player-server", 7), vi.fn()),
      telemetry: {
        acceptClientBatch: vi.fn(),
        openSession: vi.fn(),
        recordEvent,
        submitBugReport: vi.fn()
      }
    });

    await handler(startupTerminal);
    await handler(startupTerminal);

    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventFamily: "session",
      eventType: "startup_terminal",
      priority: "important",
      playerId: "player-server",
      sessionId: "00000000-0000-0000-0000-000000000007",
      connectionGeneration: 7,
      durationMs: 30_000,
      metadata: expect.objectContaining({
        outcome: "timeout",
        mapPainted: false,
        presentationSnapshotReceived: false,
        observedConnectionId: "observed-connection",
        observedConnectionGeneration: 6,
        ingestingConnectionId: "connection-test",
        browserFamily: "Chrome",
        clientReleaseIdentifier: "a".repeat(64)
      })
    }));
  });

  it("rejects a bug report from a stale connection generation before capture", async () => {
    const submitBugReport = vi.fn();
    const captureBugReportContext = vi.fn();
    const sendToConnection = vi.fn();
    const handler = createSessionHandler({
      ...context(state("player-server", 7), vi.fn()),
      registry: { sendToConnection } as unknown as ConnectionRegistry,
      accountRateKey: "account-server",
      captureBugReportContext,
      telemetry: {
        acceptClientBatch: vi.fn(),
        openSession: vi.fn(),
        recordEvent: vi.fn(),
        submitBugReport
      }
    });

    await handler(bugReportMessage(6));

    expect(captureBugReportContext).not.toHaveBeenCalled();
    expect(submitBugReport).not.toHaveBeenCalled();
    expect(sendToConnection).toHaveBeenCalledWith(
      "connection-test",
      expect.objectContaining({
        type: "BUG_REPORT_SUBMIT_RESULT",
        success: false,
        code: "BUG_REPORT_SESSION_STALE"
      })
    );
  });

  it("captures server authority and returns the committed public report code", async () => {
    const authoritative = {
      playerState: { playerId: "player-server" },
      nearbyEntities: [],
      relatedOperationIds: [],
      relatedEventIds: []
    };
    const submitBugReport = vi.fn(async () => ({
      success: true as const,
      reportCode: "AA-ABC123",
      duplicate: false
    }));
    const captureBugReportContext = vi.fn(async () => authoritative);
    const sendToConnection = vi.fn();
    const handler = createSessionHandler({
      ...context(state("player-server", 7), vi.fn()),
      registry: { sendToConnection } as unknown as ConnectionRegistry,
      accountRateKey: "account-server",
      captureBugReportContext,
      telemetry: {
        acceptClientBatch: vi.fn(),
        openSession: vi.fn(),
        recordEvent: vi.fn(),
        submitBugReport
      }
    });
    const report = bugReportMessage(7);

    await handler(report);

    expect(captureBugReportContext).toHaveBeenCalledWith("player-server", report);
    expect(submitBugReport).toHaveBeenCalledWith(expect.objectContaining({
      accountRateKey: "account-server",
      connectionKey: "connection-test",
      playerId: "player-server",
      sessionId: "00000000-0000-0000-0000-000000000007",
      connectionGeneration: 7,
      report,
      authoritative
    }));
    expect(sendToConnection).toHaveBeenCalledWith(
      "connection-test",
      expect.objectContaining({
        type: "BUG_REPORT_SUBMIT_RESULT",
        success: true,
        reportCode: "AA-ABC123"
      })
    );
  });
});

function bugReportMessage(connectionGeneration: number): BugReportSubmitMessage {
  const marker = 1_750_000_000_000;
  return {
    type: "BUG_REPORT_SUBMIT",
    requestId: "00000000-0000-4000-8000-000000000123",
    connectionGeneration,
    reportMarkerAt: marker,
    availableWindowStartAt: marker,
    windowStartAt: marker - 300_000,
    windowEndAt: marker,
    title: "Test report",
    category: "gameplay",
    description: "A bounded test report.",
    expectedBehavior: "",
    reproducibility: "once",
    diagnostics: {
      recentClientActions: [],
      recentClientErrors: [],
      networkTimeline: [],
      performanceHistory: []
    },
    clientState: {
      openApp: "bug-report",
      openModal: null,
      selectedEntityId: null,
      selectedEntityType: null,
      combatTargetId: null,
      combatTargetType: null,
      mapMode: "world",
      cameraZoom: 15,
      viewportWidth: 390,
      viewportHeight: 844,
      installedPwa: false,
      foregroundState: "foreground",
      socketState: "open",
      connectionGeneration,
      lastAcknowledgedServerTick: null,
      lastAuthoritativeSnapshotAgeMs: 100,
      pendingOperationIds: [],
      inventoryRevision: null,
      equipmentRevision: null,
      transitionState: "world",
      visionAnchor: null,
      movementAnchor: null
    }
  };
}

function state(
  playerId: string | null,
  connectionGeneration: number | null
): SessionConnectionState {
  return {
    playerId,
    connectionId: playerId ? "connection-test" : null,
    helloReceived: playerId !== null,
    connectionGeneration,
    socketClosed: false,
    protocol: {
      protocolId: "ash-atlas",
      minVersion: 1,
      maxVersion: 1,
      version: 1,
      capabilities: []
    },
    protocolMetadataAdvertised: false
  };
}

function context(
  connectionState: SessionConnectionState,
  acceptClientBatch: ReturnType<typeof vi.fn>
) {
  const socket: SocketLike = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn()
  };
  return {
    state: connectionState,
    socket,
    registry: { sendToConnection: vi.fn() } as unknown as ConnectionRegistry,
    telemetry: {
      acceptClientBatch,
      openSession: vi.fn(),
      recordEvent: vi.fn(),
      submitBugReport: vi.fn()
    },
    authSessionId: "00000000-0000-0000-0000-000000000007",
    bootstrapHello: vi.fn(),
    suspendConnection: vi.fn(),
    rejectDuringPlayerWorldTransition: vi.fn(() => false),
    requestWorldResync: vi.fn(),
    requestPopulationResync: vi.fn()
  };
}
