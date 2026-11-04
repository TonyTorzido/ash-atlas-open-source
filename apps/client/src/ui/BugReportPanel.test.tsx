// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  BugReportClientState,
  BugReportSubmitMessage
} from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BugReportPanel } from "./BugReportPanel.js";

const clientState: BugReportClientState = {
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

afterEach(cleanup);

describe("Report a Bug mobile app", () => {
  it("validates required fields and suppresses duplicate taps", () => {
    const submit = vi.fn<(message: BugReportSubmitMessage) => boolean>(() => true);
    const onBack = vi.fn();
    const onReturnToGame = vi.fn();
    render(<BugReportPanel
      open
      result={null}
      synchronizedNow={() => 2_000_000_000_000}
      connectionGeneration={() => 1}
      captureClientState={() => clientState}
      submit={submit}
      onBack={onBack}
      onReturnToGame={onReturnToGame}
    />);

    fireEvent.submit(screen.getByRole("button", { name: "Submit Bug" }).closest("form")!);
    expect(screen.getByRole("alert").textContent).toContain(
      "Add a title and describe what happened."
    );
    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: "Tree disappeared" }
    });
    fireEvent.change(screen.getByLabelText(/What happened/), {
      target: { value: "It vanished after harvesting." }
    });
    const button = screen.getByRole("button", { name: "Submit Bug" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "Submitting…" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to Game Menu" }));
    expect(onReturnToGame).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByText(/does not include chat or private messages/)).toBeTruthy();
  });

  it("keeps the draft tied to the server connection that opened it", () => {
    const submit = vi.fn<(message: BugReportSubmitMessage) => boolean>(() => true);
    let generation = 1;
    render(<BugReportPanel
      open
      result={null}
      synchronizedNow={() => 2_000_000_000_000}
      connectionGeneration={() => generation}
      captureClientState={() => clientState}
      submit={submit}
      onBack={vi.fn()}
      onReturnToGame={vi.fn()}
    />);

    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: "Tree disappeared" }
    });
    fireEvent.change(screen.getByLabelText(/What happened/), {
      target: { value: "It vanished." }
    });
    generation = 2;
    fireEvent.click(screen.getByRole("button", { name: "Submit Bug" }));

    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].connectionGeneration).toBe(1);
  });

  it("keeps the form on failure and displays the report ID on success", () => {
    const submit = vi.fn<(message: BugReportSubmitMessage) => boolean>(() => true);
    const view = render(<BugReportPanel
      open
      result={null}
      synchronizedNow={() => 2_000_000_000_000}
      connectionGeneration={() => 1}
      captureClientState={() => clientState}
      submit={submit}
      onBack={vi.fn()}
      onReturnToGame={vi.fn()}
    />);
    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: "Tree disappeared" }
    });
    fireEvent.change(screen.getByLabelText(/What happened/), {
      target: { value: "It vanished." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit Bug" }));
    const requestId = submit.mock.calls[0]![0].requestId;
    view.rerender(<BugReportPanel
      open
      result={{
        type: "BUG_REPORT_SUBMIT_RESULT",
        requestId,
        success: false,
        code: "BUG_REPORT_SAVE_FAILED",
        message: "Please retry.",
        retryable: true
      }}
      synchronizedNow={() => 2_000_000_000_000}
      connectionGeneration={() => 1}
      captureClientState={() => clientState}
      submit={submit}
      onBack={vi.fn()}
      onReturnToGame={vi.fn()}
    />);
    expect(screen.getByDisplayValue("Tree disappeared")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Please retry.");
    fireEvent.click(screen.getByRole("button", { name: "Submit Bug" }));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]![0].requestId).toBe(requestId);
    view.rerender(<BugReportPanel
      open
      result={{
        type: "BUG_REPORT_SUBMIT_RESULT",
        requestId,
        success: true,
        reportCode: "AA-7F3C21"
      }}
      synchronizedNow={() => 2_000_000_000_000}
      connectionGeneration={() => 1}
      captureClientState={() => clientState}
      submit={submit}
      onBack={vi.fn()}
      onReturnToGame={vi.fn()}
    />);
    expect(screen.getByText("Bug report submitted")).toBeTruthy();
    expect(screen.getByText("AA-7F3C21")).toBeTruthy();
  });
});
