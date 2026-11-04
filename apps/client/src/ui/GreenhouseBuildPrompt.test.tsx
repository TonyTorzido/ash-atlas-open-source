// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GreenhouseBuildPrompt } from "./GreenhouseBuildPrompt.js";

afterEach(cleanup);

const preview = {
  position: { lat: 35, lon: -106 },
  eligibility: {
    isRiverbank: true,
    policyId: "canonical-water-surface-land-within-500m-v1",
    policyDistanceM: 500,
    checkedAt: "2026-01-01T00:00:00.000Z"
  },
  stageDurationMs: 8 * 60 * 60 * 1_000,
  serverTime: Date.UTC(2026, 0, 1)
} as const;

describe("GreenhouseBuildPrompt", () => {
  it("shows authoritative river-coast timing before build and leaves Cancel usable while pending", () => {
    const onClose = vi.fn();
    render(<GreenhouseBuildPrompt
      open
      busy
      disabled={false}
      error={null}
      preview={preview}
      previewBusy={false}
      previewError={null}
      build={null}
      cancelBusy={false}
      onBuild={vi.fn()}
      onRetryPreview={vi.fn()}
      onCancelBuild={vi.fn()}
      onClose={onClose}
    />);

    expect(screen.getByText(/River-coast \(riverbank\) placement — 8h per stage/)).toBeTruthy();
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    expect(cancelButtons).toHaveLength(1);
    const enabledCancel = cancelButtons.find((button) => !(button as HTMLButtonElement).disabled);
    expect(enabledCancel).toBeTruthy();
    fireEvent.click(enabledCancel!);
    expect(onClose).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Building…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders one Close dismissal alongside construction cancellation", () => {
    render(<GreenhouseBuildPrompt
      open
      busy={false}
      disabled={false}
      error={null}
      preview={null}
      previewBusy={false}
      previewError={null}
      build={{
        buildId: "build-1",
        position: preview.position,
        eligibility: preview.eligibility,
        startedAt: preview.serverTime,
        completesAt: preview.serverTime + 30_000,
        durationMs: 30_000
      }}
      cancelBusy={false}
      onBuild={vi.fn()}
      onRetryPreview={vi.fn()}
      onCancelBuild={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "Cancel Construction" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(screen.getByText(/Move to cancel and refund/)).toBeTruthy();
    expect(screen.queryByText(/Track progress in the activity timer/)).toBeNull();
    expect(screen.queryByRole("status", { name: "Greenhouse construction time remaining" })).toBeNull();
  });
});
