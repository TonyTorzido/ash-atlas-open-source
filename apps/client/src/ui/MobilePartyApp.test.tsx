// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobilePartyApp } from "./MobilePartyApp.js";

const ownPlayerId = "00000000-0000-4000-8000-000000000001";
const allyPlayerId = "00000000-0000-4000-8000-000000000002";

afterEach(cleanup);

function props() {
  return {
    open: true,
    ownPlayerId,
    ownPlayerName: "Atlas",
    party: null,
    invites: [],
    outgoingInvites: [],
    playerNames: { [allyPlayerId]: "Ariadne" },
    visiblePlayers: [{
      playerId: allyPlayerId,
      username: "Ariadne",
      displayColor: null,
      regionCode: "us",
      zoneId: "zone",
      lat: 0,
      lon: 0,
      anchorLat: 0,
      anchorLon: 0,
      moveLeashRadiusM: 10,
      movementRevision: 1,
      targetLat: null,
      targetLon: null,
      moving: false,
      online: true,
      updatedAt: new Date(0).toISOString()
    }],
    connected: true,
    onBack: vi.fn(),
    onCreate: vi.fn(() => true),
    onInvite: vi.fn(() => true),
    onAccept: vi.fn(() => true),
    onForward: vi.fn(() => true),
    onDecline: vi.fn(() => true),
    onCancelInvite: vi.fn(() => true),
    onRemove: vi.fn(() => true),
    onLeave: vi.fn(() => true),
    onChangeLeader: vi.fn(() => true),
    onSetTravelAllowed: vi.fn(() => true),
    onSetAutoFollow: vi.fn(() => true),
    onTravelToLeader: vi.fn(() => true),
    onOpenMessages: vi.fn(),
    onMessage: vi.fn(),
    onViewProfile: vi.fn()
  };
}

describe("MobilePartyApp", () => {
  it("creates a party from the themed empty state", () => {
    const options = props();
    render(<MobilePartyApp {...options} />);
    expect(screen.getByRole("dialog", { name: "Party" })).toBeTruthy();
    expect(screen.queryByText("Open Slot")).toBeNull();
    expect(screen.getByText("5 open places")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create Party" }));
    expect(options.onCreate).toHaveBeenCalledOnce();
  });

  it("shows leader controls, travel authority, and confirms destructive roster actions", () => {
    const options = props();
    render(<MobilePartyApp
      {...options}
      party={{
        partyId: "party",
        leaderPlayerId: ownPlayerId,
        memberPlayerIds: [ownPlayerId, allyPlayerId],
        allowTravel: false,
        autoFollowPlayerIds: [],
        revision: 1
      }}
    />);
    expect(screen.getByText("Allow Party Travel")).toBeTruthy();
    expect(screen.getByText("3 open places")).toBeTruthy();
    expect(screen.getByText("Profile")).toBeTruthy();
    expect(screen.getByText("Manage")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ariadne actions" }));
    expect(screen.getByRole("button", { name: "Make Leader" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Kick from Party" }));
    expect(screen.getByRole("heading", { name: "Kick Ariadne?" })).toBeTruthy();
    expect(screen.getByText("Ariadne will be removed from the party. They can be invited again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(options.onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Kick from Party" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Kick from Party" }).at(-1)!);
    expect(options.onRemove).toHaveBeenCalledWith(allyPlayerId);
    fireEvent.click(screen.getByRole("button", { name: "Atlas actions" }));
    expect(screen.queryByRole("button", { name: "Kick from Party" })).toBeNull();
  });

  it("disables kicking while disconnected", () => {
    render(<MobilePartyApp
      {...props()}
      connected={false}
      party={{
        partyId: "party",
        leaderPlayerId: ownPlayerId,
        memberPlayerIds: [ownPlayerId, allyPlayerId],
        allowTravel: false,
        autoFollowPlayerIds: [],
        revision: 1
      }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Ariadne actions" }));
    expect(screen.getByRole("button", { name: "Kick from Party" }).hasAttribute("disabled")).toBe(true);
  });

  it.each([
    ["Leave Party", "Leave party?", "onLeave"],
    ["Disband Party", "Disband party?", "onDisband"]
  ] as const)("keeps the %s confirmation inside the Party app", (actionLabel, title, handler) => {
    const options = { ...props(), onDisband: vi.fn(() => true) };
    render(<MobilePartyApp
      {...options}
      party={{
        partyId: "party",
        leaderPlayerId: ownPlayerId,
        memberPlayerIds: [ownPlayerId],
        allowTravel: false,
        autoFollowPlayerIds: [],
        revision: 1
      }}
    />);

    const partyApp = screen.getByRole("dialog", { name: "Party" });
    fireEvent.click(screen.getByRole("button", { name: actionLabel }));

    expect(screen.getByRole("heading", { name: title }).closest(".phone-party-layer"))
      .toBe(partyApp);
    expect(partyApp.querySelector(".phone-party-command-layout")?.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: actionLabel }).at(-1)!);
    expect(options[handler]).toHaveBeenCalledOnce();
  });

  it("shows member Auto-Follow and Travel to Leader without leader-only controls", () => {
    const options = props();
    render(<MobilePartyApp
      {...options}
      party={{
        partyId: "party",
        leaderPlayerId: allyPlayerId,
        memberPlayerIds: [allyPlayerId, ownPlayerId],
        allowTravel: true,
        autoFollowPlayerIds: [ownPlayerId],
        revision: 2
      }}
    />);
    expect(screen.getByRole("button", { name: "Travel to Leader" })).toBeTruthy();
    expect(screen.getByText("Auto-Follow")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ariadne actions" }));
    expect(screen.queryByRole("button", { name: "Make Leader" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kick from Party" })).toBeNull();
  });

  it("routes incoming party invitations to the Messages request inbox", () => {
    const options = props();
    render(<MobilePartyApp
      {...options}
      party={{
        partyId: "party",
        leaderPlayerId: allyPlayerId,
        memberPlayerIds: [allyPlayerId, ownPlayerId],
        allowTravel: false,
        autoFollowPlayerIds: [],
        revision: 1
      }}
      invites={[{
        invitationId: "00000000-0000-4000-8000-000000000010",
        partyId: "other-party",
        leaderPlayerId: "other-leader",
        inviterPlayerId: "other-leader",
        targetPlayerId: ownPlayerId,
        perspective: "incoming",
        status: "pending",
        createdAt: "2099-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:05:00.000Z",
        respondedAt: null,
        updatedAt: "2099-01-01T00:00:00.000Z"
      }]}
    />);

    fireEvent.click(screen.getByRole("button", { name: "View Requests in Messages (1)" }));
    expect(options.onOpenMessages).toHaveBeenCalledOnce();
  });
});
