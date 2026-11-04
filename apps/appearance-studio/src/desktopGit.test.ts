import { describe, expect, it } from "vitest";

import {
  assertApprovedIntegrationTest,
  contentBatchIntegrationArgs,
  contentBatchSlug,
  contentBatchSummary,
  remoteGeneration
} from "./desktopGit.js";

describe("Appearance Studio desktop Git workflow", () => {
  it("normalizes bounded content batch names", () => {
    expect(contentBatchSlug(" Ember Weapons ")).toBe("ember-weapons");
    expect(() => contentBatchSlug("---")).toThrow(/1-26/u);
    expect(() => contentBatchSlug("a".repeat(27))).toThrow(/1-26/u);
  });

  it("accepts concise commit summaries and rejects control text", () => {
    expect(contentBatchSummary("  add ember weapons  ")).toBe("add ember weapons");
    expect(() => contentBatchSummary("bad\nsubject")).toThrow(/plain-text/u);
  });

  it("uses only the fixed generic player note for Studio integrations", () => {
    const worktreePath = "C:\\worktrees\\private-asset-batch";
    const privateCommitSummary = contentBatchSummary("add named author asset");

    expect(privateCommitSummary).toBe("add named author asset");
    expect(contentBatchIntegrationArgs(worktreePath)).toEqual([
      "Integrate",
      "-FeatureWorktree", worktreePath,
      "-DisplayName", "Appearance Content",
      "-PlayerPatchNote", "Improved Visuals",
      "-ConfirmIntegration",
      "-ConfirmGenerationCheckpoint"
    ]);
    expect(contentBatchIntegrationArgs(worktreePath)).not.toContain(privateCommitSummary);
  });

  it("requires exactly one generation tag at the integration tip", () => {
    const snapshot = [
      "abc123\trefs/heads/integration/test",
      "old000\trefs/tags/test/t333",
      "abc123\trefs/tags/test/t334"
    ].join("\n");
    expect(remoteGeneration(snapshot)).toEqual({ tag: "t334", sha: "abc123" });
    expect(() => remoteGeneration(
      "abc123\trefs/heads/integration/test\nold000\trefs/tags/test/t333"
    )).toThrow(/exactly one/u);
  });

  it("refuses deployment when Integration Test changes after confirmation", () => {
    const approved = { approvedGeneration: "t399", approvedSha: "a".repeat(40) };
    expect(() => assertApprovedIntegrationTest(approved, {
      integrationGeneration: "t399",
      integrationSha: "a".repeat(40)
    })).not.toThrow();
    expect(() => assertApprovedIntegrationTest(approved, {
      integrationGeneration: "t400",
      integrationSha: "b".repeat(40)
    })).toThrow(/changed after confirmation/u);
  });
});
