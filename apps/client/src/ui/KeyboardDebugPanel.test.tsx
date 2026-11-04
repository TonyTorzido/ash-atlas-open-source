// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetMobileKeyboardDockingForTests } from "../mobileKeyboardDocking.js";
import { KeyboardDebugPanel } from "./KeyboardDebugPanel.js";

afterEach(() => {
  cleanup();
  resetMobileKeyboardDockingForTests();
  vi.restoreAllMocks();
});

describe("KeyboardDebugPanel", () => {
  it("stays absent unless owner-gated query handling enables it", () => {
    const view = render(<KeyboardDebugPanel enabled={false} />);
    expect(view.container.innerHTML).toBe("");
  });

  it("copies a bounded physical-device diagnostic report", async () => {
    const writeText = vi.fn((text: string) => {
      void text;
      return Promise.resolve();
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(<KeyboardDebugPanel enabled />);
    expect(screen.getByRole("button", { name: "Show KB debug" })).toBeTruthy();
    expect(screen.queryByText("final gap")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show KB debug" }));
    expect(screen.getByText("final gap")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const report = JSON.parse(writeText.mock.calls[0]![0] as string) as {
      current: {
        phase: string;
        activeChatType: string;
        rawCandidateInset: number;
        acceptedCandidateInset: number;
        committedKeyboardInset: number;
        committedInsetUpdateCount: number;
        invariants: {
          fullOverlayGeometryStable: boolean;
          committedInsetUpdateCount: number;
          composerOnlyDocking: boolean;
        };
      };
      events: unknown[];
    };
    expect(report.current.phase).toBe("closed");
    expect(report.current.activeChatType).toBe("none");
    expect(report.current.rawCandidateInset).toBe(0);
    expect(report.current.acceptedCandidateInset).toBe(0);
    expect(report.current.committedKeyboardInset).toBe(0);
    expect(report.current.committedInsetUpdateCount).toBe(0);
    expect(report.current.invariants).toMatchObject({
      fullOverlayGeometryStable: true,
      committedInsetUpdateCount: 0,
      composerOnlyDocking: true
    });
    expect(report.events.length).toBeLessThanOrEqual(160);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });
});
