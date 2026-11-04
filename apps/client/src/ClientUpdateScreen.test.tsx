// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientUpdateHelpScreen } from "./ui/ClientUpdateStatus.js";
import { ConnectionRecoveryScreen, UpdateBanner } from "./ui/ConnectionRecoveryScreen.js";

describe("client update prompt and recovery help", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the update's version and size and applies when Update now is tapped", () => {
    const onApply = vi.fn();
    render(
      <ConnectionRecoveryScreen
        state="update_ready"
        update={{ version: "0.1.8", sizeBytes: 3 * 1024 * 1024, autoApplyAt: Date.now() + 10_000 }}
        onReconnect={onApply}
      />
    );

    expect(screen.getByRole("alertdialog", { name: "Update available" })).toBeTruthy();
    expect(screen.getByText("Version 0.1.8")).toBeTruthy();
    expect(screen.getByText("3.0 MB")).toBeTruthy();
    expect(screen.getByText("Updating automatically in 10s")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    fireEvent.click(screen.getByRole("button", { name: "Updating…" }));
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("applies the update by itself once when the ten-second countdown ends", () => {
    vi.useFakeTimers();
    const onApply = vi.fn();
    render(
      <ConnectionRecoveryScreen
        state="update_ready"
        update={{ version: null, sizeBytes: null, autoApplyAt: Date.now() + 10_000 }}
        onReconnect={onApply}
      />
    );
    expect(screen.getByText("New version")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(9_500); });
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText("Updating automatically in 1s")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("shows the in-game banner with version and size, and Update now applies once", () => {
    const onApply = vi.fn();
    render(
      <UpdateBanner
        update={{ version: "0.1.8", sizeBytes: 6 * 1024 * 1024, autoApplyAt: Date.now() + 15_000 }}
        embedded
        onApply={onApply}
      />
    );
    expect(screen.getByRole("status", { name: /Update ready, v0\.1\.8 · 6\.0 MB\. Updating automatically in 15 seconds/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    fireEvent.click(screen.getByRole("button", { name: "Updating…" }));
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("updates by itself once the fifteen-second banner countdown ends", () => {
    vi.useFakeTimers();
    const onApply = vi.fn();
    render(<UpdateBanner update={{ version: null, sizeBytes: null, autoApplyAt: Date.now() + 15_000 }} embedded onApply={onApply} />);
    act(() => { vi.advanceTimersByTime(14_500); });
    expect(onApply).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("gives clear browser cache steps for iPhone Safari, installed apps, and Android Chrome", () => {
    render(<ClientUpdateHelpScreen onTryAgain={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Clear cache to continue" })).toBeTruthy();
    expect(screen.getByText("iPhone Safari")).toBeTruthy();
    expect(screen.getByText("Installed web app")).toBeTruthy();
    expect(screen.getByText("Android Chrome")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try loading again" })).toBeTruthy();
  });
});
