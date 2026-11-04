import { z } from "zod";

import { clientTelemetrySampleSchema } from "./telemetry.js";

export const BUG_REPORT_WIRE_MAX_BYTES = 2_000_000;
export const BUG_REPORT_CONTEXT_MAX_UNCOMPRESSED_BYTES = 2_000_000;
export const BUG_REPORT_CONTEXT_MAX_COMPRESSED_BYTES = 500_000;
export const BUG_REPORT_NEARBY_ENTITY_LIMIT = 200;
export const BUG_REPORT_ACTION_LIMIT = 800;
export const BUG_REPORT_ERROR_LIMIT = 200;
export const BUG_REPORT_NETWORK_LIMIT = 400;
export const BUG_REPORT_PERFORMANCE_LIMIT = 200;
export const BUG_REPORT_HISTORY_WINDOW_MS = 5 * 60_000;

export const bugReportCategorySchema = z.enum([
  "gameplay",
  "movement_travel",
  "combat",
  "inventory_items",
  "territory_building",
  "ui",
  "connection_performance",
  "other"
]);

export type BugReportCategory = z.infer<typeof bugReportCategorySchema>;

export const bugReportReproducibilitySchema = z.enum([
  "once",
  "sometimes",
  "every_time",
  "not_sure"
]);

export type BugReportReproducibility = z.infer<
  typeof bugReportReproducibilitySchema
>;

const timestampSchema = z.number().finite().int().nonnegative();
const boundedIdentifier = z.string().trim().min(1).max(160);
const nullableIdentifier = boundedIdentifier.nullable();
const operationIdSchema = z.string().trim().min(1).max(160).nullable();
const boundedCoordinate = z.number().finite().min(-180).max(180);
const anchorSchema = z.object({
  id: nullableIdentifier,
  lat: boundedCoordinate.nullable(),
  lon: boundedCoordinate.nullable()
}).strict().nullable();

export const bugReportClientActionSchema = z.object({
  timestamp: timestampSchema,
  kind: z.enum([
    "entity_selected",
    "interaction_opened",
    "action_selected",
    "move_requested",
    "harvest_requested",
    "attack_requested",
    "pickup_requested",
    "travel_requested",
    "building_requested",
    "inventory_action",
    "operation_created",
    "command_sent",
    "command_result",
    "ui_no_command"
  ]),
  operationId: operationIdSchema,
  targetId: nullableIdentifier,
  targetType: z.string().trim().min(1).max(80).nullable(),
  action: z.string().trim().min(1).max(80).nullable(),
  outcome: z.enum([
    "requested",
    "sent",
    "accepted",
    "applied",
    "rejected",
    "replayed",
    "failed",
    "stale",
    "timed_out",
    "no_command"
  ]).nullable(),
  rejectionCode: z.string().trim().min(1).max(120).nullable()
}).strict();

export type BugReportClientAction = z.infer<typeof bugReportClientActionSchema>;

export const bugReportClientErrorSchema = z.object({
  timestamp: timestampSchema,
  category: z.enum([
    "caught_exception",
    "unhandled_rejection",
    "react_error_boundary",
    "rendering",
    "protocol_validation",
    "send_failure",
    "world_resync",
    "severe_frame_stall",
    "gameplay_operation",
    "network_action"
  ]),
  name: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(320),
  stackFingerprint: z.string().regex(/^[a-f0-9]{8,64}$/u).nullable(),
  component: z.string().trim().min(1).max(120).nullable(),
  operationId: operationIdSchema,
  count: z.number().int().min(1).max(1_000_000)
}).strict();

export type BugReportClientError = z.infer<typeof bugReportClientErrorSchema>;

export const bugReportNetworkEntrySchema = z.object({
  timestamp: timestampSchema,
  direction: z.enum(["incoming", "outgoing"]),
  messageType: z.string().regex(/^[A-Z0-9_]{1,80}$/u),
  approximateBytes: z.number().int().min(0).max(BUG_REPORT_WIRE_MAX_BYTES),
  sequence: z.number().int().nonnegative().nullable(),
  serverTick: z.number().int().nonnegative().nullable(),
  operationId: operationIdSchema,
  status: z.enum([
    "observed",
    "sent",
    "accepted",
    "rejected",
    "failed",
    "stale",
    "timed_out"
  ]),
  connectionGeneration: z.number().int().nonnegative()
}).strict();

export type BugReportNetworkEntry = z.infer<typeof bugReportNetworkEntrySchema>;

export const bugReportPerformanceEntrySchema = z.object({
  timestamp: timestampSchema,
  sample: clientTelemetrySampleSchema
}).strict();

export type BugReportPerformanceEntry = z.infer<
  typeof bugReportPerformanceEntrySchema
>;

export const bugReportClientStateSchema = z.object({
  openApp: z.string().trim().min(1).max(80),
  openModal: z.string().trim().min(1).max(80).nullable(),
  selectedEntityId: nullableIdentifier,
  selectedEntityType: z.string().trim().min(1).max(80).nullable(),
  combatTargetId: nullableIdentifier,
  combatTargetType: z.string().trim().min(1).max(80).nullable(),
  mapMode: z.string().trim().min(1).max(80),
  cameraZoom: z.number().finite().min(0).max(40).nullable(),
  viewportWidth: z.number().int().min(1).max(16_384),
  viewportHeight: z.number().int().min(1).max(16_384),
  installedPwa: z.boolean(),
  foregroundState: z.enum(["foreground", "background"]),
  socketState: z.enum(["connecting", "open", "closing", "closed"]),
  connectionGeneration: z.number().int().nonnegative(),
  lastAcknowledgedServerTick: z.number().int().nonnegative().nullable(),
  lastAuthoritativeSnapshotAgeMs: z.number().finite().min(0).max(86_400_000).nullable(),
  pendingOperationIds: z.array(boundedIdentifier).max(32),
  inventoryRevision: z.number().int().nonnegative().nullable(),
  equipmentRevision: z.number().int().nonnegative().nullable(),
  transitionState: z.string().trim().min(1).max(80),
  visionAnchor: anchorSchema,
  movementAnchor: anchorSchema
}).strict();

export type BugReportClientState = z.infer<typeof bugReportClientStateSchema>;

export const bugReportFrozenDiagnosticsSchema = z.object({
  recentClientActions: z.array(bugReportClientActionSchema).max(BUG_REPORT_ACTION_LIMIT),
  recentClientErrors: z.array(bugReportClientErrorSchema).max(BUG_REPORT_ERROR_LIMIT),
  networkTimeline: z.array(bugReportNetworkEntrySchema).max(BUG_REPORT_NETWORK_LIMIT),
  performanceHistory: z.array(bugReportPerformanceEntrySchema).max(BUG_REPORT_PERFORMANCE_LIMIT)
}).strict();

export type BugReportFrozenDiagnostics = z.infer<
  typeof bugReportFrozenDiagnosticsSchema
>;

export const bugReportSubmitMessageSchema = z.object({
  type: z.literal("BUG_REPORT_SUBMIT"),
  requestId: z.string().uuid(),
  connectionGeneration: z.number().int().nonnegative(),
  reportMarkerAt: timestampSchema,
  availableWindowStartAt: timestampSchema,
  windowStartAt: timestampSchema,
  windowEndAt: timestampSchema,
  title: z.string().trim().min(1).max(80),
  category: bugReportCategorySchema,
  description: z.string().trim().min(1).max(2_000),
  expectedBehavior: z.string().trim().max(1_000),
  reproducibility: bugReportReproducibilitySchema,
  diagnostics: bugReportFrozenDiagnosticsSchema,
  clientState: bugReportClientStateSchema
}).strict();

export type BugReportSubmitMessage = z.infer<typeof bugReportSubmitMessageSchema>;

export type BugReportSubmitResultMessage =
  | {
      type: "BUG_REPORT_SUBMIT_RESULT";
      requestId: string;
      success: true;
      reportCode: string;
    }
  | {
      type: "BUG_REPORT_SUBMIT_RESULT";
      requestId: string;
      success: false;
      code: string;
      message: string;
      retryable: boolean;
      retryAfterMs?: number;
    };

export const bugReportSubmitResultServerSchema = z.discriminatedUnion("success", [
  z.object({
    type: z.literal("BUG_REPORT_SUBMIT_RESULT"),
    requestId: z.string().uuid(),
    success: z.literal(true),
    reportCode: z.string().regex(/^AA-[A-Z0-9]{6}$/u)
  }).strict(),
  z.object({
    type: z.literal("BUG_REPORT_SUBMIT_RESULT"),
    requestId: z.string().uuid(),
    success: z.literal(false),
    code: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(240),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().min(0).max(600_000).optional()
  }).strict()
]);
