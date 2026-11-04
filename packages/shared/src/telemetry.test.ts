import { describe, expect, it } from "vitest";

import {
  clientTelemetryBatchMessageSchema,
  startupTerminalTelemetryMessageSchema
} from "./telemetry.js";

function sample() {
  return {
    sequence: 1,
    reason: "interval",
    deviceCategory: "desktop",
    operatingSystemFamily: "Windows",
    browserFamily: "Chrome",
    browserMajorVersion: 126,
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
    rttMeanMs: 35,
    rttP95Ms: 50,
    authoritativeSnapshotAgeMs: 100,
    websocketReconnectCount: 0,
    websocketSendFailures: { closed: 0, failed: 0 },
    staleSocketEvents: 0,
    visibleFlagCount: 2,
    visibleCollectibleCount: 20,
    visibleCombatEntityCount: 4,
    retainedDisplayObjectCount: 30,
    collectibleRedrawCount: 1,
    collectibleRedrawDurationMs: 2,
    staticOverlayRedrawCount: 1,
    staticOverlayRedrawDurationMs: 3,
    clientReleaseIdentifier: "a".repeat(40)
  } as const;
}

describe("client telemetry protocol", () => {
  it("accepts a strict bounded anonymous performance batch", () => {
    expect(clientTelemetryBatchMessageSchema.parse({
      type: "TELEMETRY_BATCH",
      samples: [sample()]
    }).samples).toHaveLength(1);
  });

  it.each([
    "playerId",
    "accountId",
    "sessionId",
    "email",
    "lat",
    "lon",
    "name",
    "displayName",
    "ip",
    "ipAddress",
    "userAgent",
    "chatContent",
    "messageBody",
    "credential",
    "token"
  ])(
    "rejects forbidden additive identity/content field %s",
    (field) => {
      expect(() => clientTelemetryBatchMessageSchema.parse({
        type: "TELEMETRY_BATCH",
        samples: [{ ...sample(), [field]: "not-allowed" }]
      })).toThrow();
    }
  );

  it("rejects unbounded batches and impossible metrics", () => {
    expect(() => clientTelemetryBatchMessageSchema.parse({
      type: "TELEMETRY_BATCH",
      samples: Array.from({ length: 5 }, sample)
    })).toThrow();
    expect(() => clientTelemetryBatchMessageSchema.parse({
      type: "TELEMETRY_BATCH",
      samples: [{ ...sample(), viewportWidth: 100_000 }]
    })).toThrow();
  });

  it("accepts one bounded sanitized startup terminal event", () => {
    expect(startupTerminalTelemetryMessageSchema.parse({
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
      connectionId: "connection-1",
      connectionGeneration: 2,
      relocationRevision: 3,
      resourceVisionRevision: 4,
      gameplayViewGeneration: 5,
      populationPreparationGeneration: 6,
      deviceCategory: "phone",
      operatingSystemFamily: "Android",
      browserFamily: "Chrome",
      browserMajorVersion: 140,
      installedPwa: true,
      clientReleaseIdentifier: "a".repeat(64)
    })).toMatchObject({
      outcome: "timeout",
      mapPainted: false,
      presentationSnapshotReceived: false
    });
  });

  it.each(["email", "ip", "token", "chatContent", "inventory"])(
    "rejects forbidden startup terminal field %s",
    (field) => {
      const parsed = startupTerminalTelemetryMessageSchema.safeParse({
        type: "STARTUP_TERMINAL_TELEMETRY",
        outcome: "success",
        reason: "initial_presentation_ready",
        elapsedStartupMs: 1_000,
        phase: "connected",
        attempt: 0,
        socketState: "open",
        welcomeReceived: true,
        progressionReceived: true,
        locationReceived: true,
        playerReceived: true,
        flagsReceived: true,
        mapReady: true,
        mapPainted: true,
        overlayReady: true,
        worldReady: true,
        presentationSnapshotReceived: true,
        hasCompletedBootstrap: true,
        connectionId: null,
        connectionGeneration: null,
        relocationRevision: null,
        resourceVisionRevision: null,
        gameplayViewGeneration: null,
        populationPreparationGeneration: null,
        deviceCategory: "desktop",
        operatingSystemFamily: "Windows",
        browserFamily: "Firefox",
        browserMajorVersion: 140,
        installedPwa: false,
        clientReleaseIdentifier: "a".repeat(64),
        [field]: "forbidden"
      });
      expect(parsed.success).toBe(false);
    }
  );
});
