// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConnectionRecoveryScreen } from "./ConnectionRecoveryScreen.js";

describe("connection recovery screen", () => {
  it("keeps a temporary outage in automatic reconnect state", () => {
    vi.useFakeTimers();
    render(<ConnectionRecoveryScreen state="reconnecting" onReconnect={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByRole("status", { name: "Reconnecting…" })).toBeTruthy();
    expect(screen.queryByText(/session is reserved/i)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    vi.useRealTimers();
  });

  it("offers an in-place return after the bounded recovery process is exhausted", () => {
    const onReconnect = vi.fn();
    render(<ConnectionRecoveryScreen state="ended" onReconnect={onReconnect} />);
    expect(screen.getByRole("alert", { name: "Connection lost" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("distinguishes an offline device from a server recovery attempt", () => {
    render(<ConnectionRecoveryScreen state="offline" onReconnect={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Offline · Waiting for network" })).toBeTruthy();
  });

  it("offers an explicit retry when initial startup times out", () => {
    const onReconnect = vi.fn();
    render(<ConnectionRecoveryScreen
      state="startup_failed"
      detail="Game startup timed out before your map and player data finished loading."
      onReconnect={onReconnect}
    />);

    expect(
      screen.getByText("Couldn’t finish loading").closest('[role="alert"]')
    ).toBeTruthy();
    expect(screen.getByText(/startup timed out/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("shows truthful update download progress and the current version fallback", () => {
    render(<ConnectionRecoveryScreen
      state="content_loading"
      progress={{ loadedBytes: 48 * 1024, totalBytes: 108 * 1024 }}
      onReconnect={vi.fn()}
    />);
    expect(screen.getByText("48 KB of 108 KB")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Update download progress" }).getAttribute("aria-valuenow")).toBe("44");

    cleanup();
    const onReconnect = vi.fn();
    const onContinue = vi.fn();
    render(<ConnectionRecoveryScreen state="content_failed" onReconnect={onReconnect} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Current Version" }));
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("shows signed bundle progress and keeps a blocked bundle on the installed version", () => {
    render(<ConnectionRecoveryScreen
      state="bundle_loading"
      progress={{ loadedBytes: 20 * 1024, totalBytes: 40 * 1024 }}
      onReconnect={vi.fn()}
    />);
    expect(screen.getByText("20 KB of 40 KB")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Update download progress" }).getAttribute("aria-valuenow"))
      .toBe("50");

    cleanup();
    const onContinue = vi.fn();
    render(<ConnectionRecoveryScreen
      state="bundle_blocked"
      detail="This update was blocked after a failed startup. Continue with the installed version."
      onReconnect={vi.fn()}
      onContinue={onContinue}
    />);
    expect(screen.getByText("Update blocked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try Again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Current Version" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("blocks on an immediate updating screen with no countdown or continue option", () => {
    cleanup();
    render(<ConnectionRecoveryScreen state="update_applying" onReconnect={vi.fn()} />);
    expect(screen.getByText("Updating…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers Try again when the launch update cannot reach the server or fails", () => {
    cleanup();
    const onReconnect = vi.fn();
    render(<ConnectionRecoveryScreen state="update_unreachable" onReconnect={onReconnect} />);
    expect(screen.getByText("Can’t reach Ash Atlas")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with Current Version" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(onReconnect).toHaveBeenCalledOnce();

    cleanup();
    render(<ConnectionRecoveryScreen state="bundle_failed" detail="Signature mismatch" onReconnect={onReconnect} />);
    expect(screen.getByText("Signature mismatch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("shows Downloading update without byte counts until the total is known", () => {
    cleanup();
    render(<ConnectionRecoveryScreen
      state="bundle_loading"
      phase="downloading"
      progress={{ loadedBytes: 0, totalBytes: 0 }}
      onReconnect={vi.fn()}
    />);
    expect(screen.getByText("Downloading update…")).toBeTruthy();
    expect(screen.queryByText(/of 0/)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
