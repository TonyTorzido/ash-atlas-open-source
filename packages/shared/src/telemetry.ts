import { z } from "zod";

const boundedMetric = z.number().finite().min(0).max(86_400_000);
const boundedCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const nullableGeneration = boundedCount.nullable();

export const clientTelemetrySampleSchema = z.object({
  sequence: boundedCount,
  reason: z.enum([
    "interval",
    "reconnect_success",
    "reconnect_failure",
    "protocol_failure",
    "severe_frame_stall",
    "world_resync",
    "repeated_send_failure"
  ]),
  deviceCategory: z.enum(["phone", "tablet", "desktop", "unknown"]),
  operatingSystemFamily: z.string().trim().min(1).max(40),
  browserFamily: z.string().trim().min(1).max(40),
  browserMajorVersion: z.number().int().min(0).max(10_000).nullable(),
  installedPwa: z.boolean(),
  foregroundState: z.enum(["foreground", "background"]),
  viewportWidth: z.number().int().min(1).max(16_384),
  viewportHeight: z.number().int().min(1).max(16_384),
  screenSizeClass: z.enum(["small", "medium", "large"]),
  fpsMean: z.number().finite().min(0).max(1_000),
  frameTimeP50Ms: boundedMetric,
  frameTimeP95Ms: boundedMetric,
  frameTimeP99Ms: boundedMetric,
  frameTimeMaxMs: boundedMetric,
  longFramesOver50Ms: boundedCount,
  longFramesOver100Ms: boundedCount,
  rttMeanMs: boundedMetric.nullable(),
  rttP95Ms: boundedMetric.nullable(),
  authoritativeSnapshotAgeMs: boundedMetric.nullable(),
  websocketReconnectCount: boundedCount,
  websocketSendFailures: z.object({
    closed: boundedCount,
    failed: boundedCount
  }).strict(),
  staleSocketEvents: boundedCount,
  visibleFlagCount: boundedCount,
  visibleCollectibleCount: boundedCount,
  visibleCombatEntityCount: boundedCount,
  retainedDisplayObjectCount: boundedCount,
  collectibleRedrawCount: boundedCount,
  collectibleRedrawDurationMs: boundedMetric,
  staticOverlayRedrawCount: boundedCount,
  staticOverlayRedrawDurationMs: boundedMetric,
  clientReleaseIdentifier: z.string().trim().min(1).max(160)
}).strict();

export type ClientTelemetrySample = z.infer<typeof clientTelemetrySampleSchema>;

export const clientTelemetryBatchMessageSchema = z.object({
  type: z.literal("TELEMETRY_BATCH"),
  samples: z.array(clientTelemetrySampleSchema).min(1).max(4)
}).strict();

export type ClientTelemetryBatchMessage = z.infer<
  typeof clientTelemetryBatchMessageSchema
>;

export const startupTerminalTelemetryMessageSchema = z.object({
  type: z.literal("STARTUP_TERMINAL_TELEMETRY"),
  outcome: z.enum(["success", "timeout"]),
  reason: z.enum(["initial_presentation_ready", "startup_timeout"]),
  elapsedStartupMs: boundedMetric,
  phase: z.enum([
    "bootstrap_pending",
    "connected",
    "recoverable_error",
    "presentation_error"
  ]),
  attempt: z.number().int().min(0).max(100),
  socketState: z.enum(["connecting", "open", "closed"]),
  welcomeReceived: z.boolean(),
  progressionReceived: z.boolean(),
  locationReceived: z.boolean(),
  playerReceived: z.boolean(),
  flagsReceived: z.boolean(),
  mapReady: z.boolean(),
  mapPainted: z.boolean(),
  overlayReady: z.boolean(),
  worldReady: z.boolean(),
  presentationSnapshotReceived: z.boolean(),
  hasCompletedBootstrap: z.boolean(),
  connectionId: z.string().trim().min(1).max(160).nullable(),
  connectionGeneration: nullableGeneration,
  relocationRevision: nullableGeneration,
  resourceVisionRevision: nullableGeneration,
  gameplayViewGeneration: nullableGeneration,
  populationPreparationGeneration: nullableGeneration,
  deviceCategory: z.enum(["phone", "tablet", "desktop", "unknown"]),
  operatingSystemFamily: z.string().trim().min(1).max(40),
  browserFamily: z.string().trim().min(1).max(40),
  browserMajorVersion: z.number().int().min(0).max(10_000).nullable(),
  installedPwa: z.boolean(),
  clientReleaseIdentifier: z.string().trim().min(1).max(160)
}).strict();

export type StartupTerminalTelemetryMessage = z.infer<
  typeof startupTerminalTelemetryMessageSchema
>;
