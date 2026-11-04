import { describe, expect, it } from "vitest";

import {
  BUG_REPORT_ACTION_LIMIT,
  bugReportCategorySchema,
  bugReportReproducibilitySchema,
  bugReportSubmitMessageSchema
} from "./bugReports.js";

const marker = 1_800_000_000_000;
const valid = {
  type: "BUG_REPORT_SUBMIT" as const,
  requestId: "00000000-0000-4000-8000-000000000001",
  connectionGeneration: 4,
  reportMarkerAt: marker,
  availableWindowStartAt: marker - 60_000,
  windowStartAt: marker - 300_000,
  windowEndAt: marker,
  title: "Tree disappeared",
  category: "gameplay" as const,
  description: "The tree disappeared after harvesting.",
  expectedBehavior: "The stump should remain.",
  reproducibility: "once" as const,
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
    cameraZoom: 11,
    viewportWidth: 390,
    viewportHeight: 844,
    installedPwa: true,
    foregroundState: "foreground" as const,
    socketState: "open" as const,
    connectionGeneration: 4,
    lastAcknowledgedServerTick: 12,
    lastAuthoritativeSnapshotAgeMs: 100,
    pendingOperationIds: [],
    inventoryRevision: 2,
    equipmentRevision: 3,
    transitionState: "world",
    visionAnchor: null,
    movementAnchor: null
  }
};

describe("bug report protocol", () => {
  it("accepts only the controlled category and reproducibility values", () => {
    expect(bugReportCategorySchema.options).toHaveLength(8);
    expect(bugReportReproducibilitySchema.options).toEqual([
      "once", "sometimes", "every_time", "not_sure"
    ]);
    expect(bugReportSubmitMessageSchema.parse(valid)).toEqual(valid);
  });

  it("rejects unknown identity and diagnostic metadata", () => {
    expect(() => bugReportSubmitMessageSchema.parse({
      ...valid,
      playerId: "client-controlled"
    })).toThrow();
    expect(() => bugReportSubmitMessageSchema.parse({
      ...valid,
      diagnostics: {
        ...valid.diagnostics,
        recentClientActions: [{
          timestamp: marker,
          kind: "command_sent",
          operationId: null,
          targetId: null,
          targetType: null,
          action: "MOVE_TO",
          outcome: "sent",
          rejectionCode: null,
          rawPayload: "forbidden"
        }]
      }
    })).toThrow();
  });

  it("enforces UUID, human field, and ring limits", () => {
    expect(() => bugReportSubmitMessageSchema.parse({
      ...valid,
      requestId: "not-an-id"
    })).toThrow();
    expect(() => bugReportSubmitMessageSchema.parse({
      ...valid,
      title: "x".repeat(81)
    })).toThrow();
    expect(() => bugReportSubmitMessageSchema.parse({
      ...valid,
      description: "x".repeat(2_001)
    })).toThrow();
    expect(() => bugReportSubmitMessageSchema.parse({
      ...valid,
      diagnostics: {
        ...valid.diagnostics,
        recentClientActions: Array.from(
          { length: BUG_REPORT_ACTION_LIMIT + 1 },
          () => ({
            timestamp: marker,
            kind: "command_sent",
            operationId: null,
            targetId: null,
            targetType: null,
            action: "MOVE_TO",
            outcome: "sent",
            rejectionCode: null
          })
        )
      }
    })).toThrow();
  });
});
