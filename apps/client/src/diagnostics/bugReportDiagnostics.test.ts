import { describe, expect, it } from "vitest";

import {
  BUG_REPORT_ACTION_LIMIT,
  BUG_REPORT_NETWORK_LIMIT,
  type BugReportClientState
} from "@ash-atlas/shared";

import {
  BugReportDiagnostics,
  sanitizeDiagnosticText
} from "./bugReportDiagnostics.js";

const state: BugReportClientState = {
  openApp: "bug-report",
  openModal: null,
  selectedEntityId: null,
  selectedEntityType: null,
  combatTargetId: null,
  combatTargetType: null,
  mapMode: "world",
  cameraZoom: 10,
  viewportWidth: 390,
  viewportHeight: 844,
  installedPwa: true,
  foregroundState: "foreground",
  socketState: "open",
  connectionGeneration: 1,
  lastAcknowledgedServerTick: null,
  lastAuthoritativeSnapshotAgeMs: null,
  pendingOperationIds: [],
  inventoryRevision: null,
  equipmentRevision: null,
  transitionState: "world",
  visionAnchor: null,
  movementAnchor: null
};

describe("bug report diagnostics", () => {
  it("remains fixed-capacity and evicts entries older than five minutes", () => {
    const diagnostics = new BugReportDiagnostics();
    const now = 2_000_000_000_000;
    for (let index = 0; index < BUG_REPORT_ACTION_LIMIT + 20; index += 1) {
      diagnostics.recordSelection(`entity-${index}`, "resource", now + index);
    }
    for (let index = 0; index < BUG_REPORT_NETWORK_LIMIT + 20; index += 1) {
      diagnostics.recordOutgoing(
        { type: "HELLO" },
        now + index,
        1,
        "sent",
        10
      );
    }
    expect(diagnostics.sizes()).toMatchObject({
      actions: BUG_REPORT_ACTION_LIMIT,
      network: BUG_REPORT_NETWORK_LIMIT
    });
    const marker = now + 5 * 60_000 + 1_000;
    const draft = diagnostics.startDraft(marker);
    expect(draft.diagnostics.recentClientActions).toHaveLength(0);
  });

  it("freezes the marker and history while the player types and reuses the request ID", () => {
    const diagnostics = new BugReportDiagnostics();
    const marker = 2_000_000_000_000;
    diagnostics.noteConnected(marker - 45_000);
    diagnostics.recordSelection("tree-1", "resource", marker - 1_000);
    const draft = diagnostics.startDraft(marker);
    diagnostics.recordSelection("tree-2", "resource", marker + 120_000);
    const fields = {
      title: "Tree disappeared",
      category: "gameplay" as const,
      description: "It vanished.",
      expectedBehavior: "",
      reproducibility: "once" as const
    };
    const first = diagnostics.buildSubmission(draft.draftId, 1, fields, state);
    const retry = diagnostics.buildSubmission(draft.draftId, 1, fields, state);
    expect(first.message.reportMarkerAt).toBe(marker);
    expect(first.message.windowEndAt).toBe(marker);
    expect(first.message.availableWindowStartAt).toBe(marker - 45_000);
    expect(first.message.diagnostics.recentClientActions.map((entry) => entry.targetId))
      .toEqual(["tree-1"]);
    expect(retry.message.requestId).toBe(first.message.requestId);
  });

  it("discards cancelled drafts and sanitizes secrets without capturing payload bodies", () => {
    const diagnostics = new BugReportDiagnostics();
    const draft = diagnostics.startDraft(2_000_000_000_000);
    diagnostics.discardDraft(draft.draftId);
    expect(diagnostics.getDraft(draft.draftId)).toBeNull();
    expect(
      sanitizeDiagnosticText(
        "user@example.com https://game.invalid token=super-secret-token",
        320
      )
    ).toBe("[redacted email] [redacted URL] [redacted secret]");
  });
});
