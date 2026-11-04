// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlayerActionsSurface, type PlayerActionsTarget } from "./PlayerActionsSurface.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PlayerActionsSurface", () => {
  it("renders the compact hierarchy and routes every action to the selected player", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ player: summary("friends") })));
    const onMessage = vi.fn();
    const onSendTravelInvite = vi.fn(() => true);
    const onViewProfile = vi.fn();
    const onInviteParty = vi.fn(() => true);
    const props = baseProps({
      layout: "phone",
      onMessage,
      onSendTravelInvite,
      onViewProfile,
      onInviteParty
    });
    render(<PlayerActionsSurface {...props} />);

    const prompt = await screen.findByLabelText("Actions for Other Player");
    const primary = within(prompt).getByRole("button", { name: "Send Message" });
    const travelInvite = within(prompt).getByRole("button", { name: "Travel Invite" });
    const viewProfile = within(prompt).getByRole("button", { name: "View Profile" });
    const inviteToParty = within(prompt).getByRole("button", { name: "Invite to Party" });
    expect(prompt.classList.contains("game-compact-prompt")).toBe(true);
    expect(within(prompt).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Send Message",
      "Travel Invite",
      "View Profile",
      "Invite to Party",
      "Cancel"
    ]);
    expect(travelInvite.dataset.actionKey).toBe("travel-invite");
    expect([primary, travelInvite, viewProfile, inviteToParty].every((button) =>
      button.classList.contains("primary")
    )).toBe(true);
    expect(within(prompt).queryByRole("button", { name: "Remove Friend" })).toBeNull();
    expect(within(prompt).queryByRole("button", { name: "Block" })).toBeNull();
    expect(within(prompt).queryByText("Friends")).toBeNull();
    expect(within(prompt).getByText("Online")).toBeTruthy();

    fireEvent.click(primary);
    expect(onMessage).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      "Other Player",
      true
    );
    fireEvent.click(travelInvite);
    expect(onSendTravelInvite).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002");
    fireEvent.click(viewProfile);
    expect(onViewProfile).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002");
    fireEvent.click(inviteToParty);
    expect(onInviteParty).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002");
  });

  it("shows accurate disabled party guidance and suppresses invalid self actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ player: summary("none") })));
    const view = render(<PlayerActionsSurface {...baseProps({
      partyInviteContext: partyInviteContext({ connected: false })
    })} />);
    await screen.findByRole("button", { name: "View Profile" });
    expect(screen.queryByRole("button", { name: "Invite to Party" })).toBeNull();
    expect(screen.queryByText("Reconnect to invite players.")).toBeNull();

    view.rerender(<PlayerActionsSurface {...baseProps({
      ownPlayerId: "00000000-0000-4000-8000-000000000002"
    })} />);
    expect(screen.getByRole("button", { name: "View Profile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send Message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Travel Invite" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite to Party" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Block" })).toBeNull();
  });

  it("hides party invitations for an enemy without explanation text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      player: {
        ...summary("none"),
        relationship: {
          friendship: "none",
          enemyMarkedByViewer: true,
          neutralityRequest: "none"
        }
      }
    })));
    render(<PlayerActionsSurface {...baseProps()} />);
    await screen.findByRole("button", { name: "View Profile" });
    expect(screen.queryByRole("button", { name: "Invite to Party" })).toBeNull();
    expect(screen.queryByText("You cannot invite an enemy to your party.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Request Neutrality" })).toBeNull();
  });

  it("uses the canonical compact prompt, closes with Escape, and renders untrusted names only as text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ player: {
      ...summary("none"),
      displayName: "<img src=x onerror=alert(1)>"
    } })));
    const onClose = vi.fn();
    const view = render(<PlayerActionsSurface {...baseProps({ layout: "phone", onClose })} />);
    const prompt = await screen.findByLabelText("Actions for <img src=x onerror=alert(1)>");
    expect(prompt.classList.contains("game-compact-prompt")).toBe(true);
    expect(view.container.querySelector("img")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the compact prompt open during outside scroll", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ player: summary("none") })));
    const onClose = vi.fn();
    render(<PlayerActionsSurface {...baseProps({ onClose })} />);
    fireEvent.scroll(document);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops action clicks from propagating to the chat row behind the panel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ player: summary("none") })));
    const onBehindClick = vi.fn();
    const onViewProfile = vi.fn();
    render(
      <div onClick={onBehindClick}>
        <PlayerActionsSurface {...baseProps({ onViewProfile })} />
      </div>
    );

    fireEvent.click(await screen.findByRole("button", { name: "View Profile" }));

    expect(onViewProfile).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002");
    expect(onBehindClick).not.toHaveBeenCalled();
  });

  it("delegates navigation with the selected stable player ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ player: {
      ...summary("none"),
      displayName: "Same Name"
    } })));
    const calls: string[] = [];
    render(<PlayerActionsSurface {...baseProps({
      target: { ...target(), displayName: "Same Name" },
      onClose: () => calls.push("close"),
      onViewProfile: (playerId) => calls.push(`profile:${playerId}`)
    })} />);
    fireEvent.click(await screen.findByRole("button", { name: "View Profile" }));
    expect(calls).toEqual(["profile:00000000-0000-4000-8000-000000000002"]);
  });

  it("uses canonical Cancel to close only the prompt without leaving General Chat", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const onClose = vi.fn();
    const onMessage = vi.fn();
    const onViewProfile = vi.fn();
    render(<PlayerActionsSurface {...baseProps({
      layout: "phone",
      onClose,
      onMessage,
      onViewProfile
    })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(back).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onViewProfile).not.toHaveBeenCalled();
  });

  it("uses an outside tap to close only the sheet without leaving General Chat", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const onClose = vi.fn();
    const view = render(<PlayerActionsSurface {...baseProps({
      layout: "phone",
      onClose
    })} />);
    await screen.findByLabelText("Actions for Other Player");

    fireEvent.pointerDown(view.container.querySelector(".player-actions-scrim-phone")!);

    expect(back).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the authoritative sent feedback and highlights Travel Invite briefly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ player: summary("friends") })));
    const view = render(<PlayerActionsSurface {...baseProps()} />);
    await screen.findByRole("button", { name: "Travel Invite" });

    view.rerender(<PlayerActionsSurface {...baseProps({
      travelInviteFeedback: {
        targetPlayerId: "00000000-0000-4000-8000-000000000002",
        revision: 1
      }
    })} />);

    expect((await screen.findByRole("status")).textContent).toBe("Invite Sent");
    expect(view.container.querySelector(".player-actions-prompt-stack")?.getAttribute("data-travel-invite-sent"))
      .toBe("true");
  });

  it("shows and enforces the remaining resend cooldown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ player: summary("friends") })));
    render(<PlayerActionsSurface {...baseProps({
      travelInviteCooldownUntil: Date.now() + 30_000
    })} />);

    await screen.findByRole("button", { name: "View Profile" });
    expect(screen.queryByRole("button", { name: /Travel Invite/ })).toBeNull();
    expect(screen.queryByText(/You can send a fresh invite/)).toBeNull();
  });

});

function baseProps(overrides: Partial<ComponentProps<typeof PlayerActionsSurface>> = {}) {
  return {
    target: target(),
    ownPlayerId: "00000000-0000-4000-8000-000000000001",
    layout: "desktop" as const,
    serverHttpBase: "http://example.test",
    csrfToken: "csrf",
    partyInviteContext: partyInviteContext(),
    refreshToken: 0,
    onMessage: vi.fn(),
    onSendTravelInvite: vi.fn(() => true),
    onViewProfile: vi.fn(),
    onInviteParty: vi.fn(() => true),
    onClose: vi.fn(),
    ...overrides
  };
}

function partyInviteContext(overrides: Partial<ComponentProps<typeof PlayerActionsSurface>["partyInviteContext"]> = {}) {
  return {
    connected: true,
    inviterPlayerId: "00000000-0000-4000-8000-000000000001",
    party: {
      partyId: "party-1",
      leaderPlayerId: "00000000-0000-4000-8000-000000000001",
      memberPlayerIds: ["00000000-0000-4000-8000-000000000001"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 1
    },
    outgoingInvites: [],
    now: Date.parse("2026-07-18T00:00:00.000Z"),
    ...overrides
  };
}

function target(): PlayerActionsTarget {
  return {
    playerId: "00000000-0000-4000-8000-000000000002",
    displayName: "Other Player",
    anchorRect: { left: 10, right: 80, top: 100, bottom: 120 }
  };
}

function summary(friendship: "none" | "friends") {
  return {
    playerId: "00000000-0000-4000-8000-000000000002",
    displayName: "Other Player",
    portrait: { kind: "player_sprite", displayColor: "#38bdf8" },
    presence: "online",
    relationship: { friendship, enemyMarkedByViewer: false }
  };
}

function response(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as Response;
}
