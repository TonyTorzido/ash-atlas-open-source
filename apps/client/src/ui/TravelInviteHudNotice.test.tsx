// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TravelInboxEntry } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TravelInviteHudNotice } from "./TravelInviteHudNotice.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TravelInviteHudNotice", () => {
  it("shows an incoming invite with Accept and Close for seven seconds", () => {
    vi.useFakeTimers();
    render(<TravelInviteHudNotice entries={[incomingInvite()]} connected onAccept={vi.fn()} />);

    expect(screen.getByText("OmniMan invited you to travel to their current area.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();

    act(() => { vi.advanceTimersByTime(6_999); });
    expect(screen.getByLabelText("Travel invitation")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByLabelText("Travel invitation")).toBeNull();
  });

  it("accepts once and lets Close dismiss without declining", async () => {
    const onAccept = vi.fn(async () => true);
    const view = render(<TravelInviteHudNotice
      entries={[incomingInvite()]}
      connected
      onAccept={onAccept}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await act(async () => undefined);
    expect(onAccept).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Travel invitation")).toBeNull();

    view.rerender(<TravelInviteHudNotice
      entries={[incomingInvite({ inviteId: "invite-2", entryId: "entry-2" })]}
      connected
      onAccept={onAccept}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Travel invitation")).toBeNull();
    expect(onAccept).toHaveBeenCalledOnce();
  });
});

function incomingInvite(overrides: Partial<TravelInboxEntry> = {}): TravelInboxEntry {
  return {
    entryId: "entry-1",
    inviteId: "invite-1",
    perspective: "recipient",
    counterpartPlayerId: "omnimon",
    counterpartName: "OmniMan",
    message: "OmniMan invited you to travel to their current area.",
    status: "pending",
    invalidationReason: null,
    sourceType: "flag",
    sourceId: "flag-1",
    createdAt: "2026-08-18T12:00:00.000Z",
    expiresAt: "2026-08-18T12:10:00.000Z",
    respondedAt: null,
    ...overrides
  };
}
