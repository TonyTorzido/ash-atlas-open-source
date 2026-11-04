// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublicProfile, SocialAction, TravelInboxEntry } from "@ash-atlas/shared";
import { ProfileApiClient } from "../profiles/profileClient.js";
import { ContactsPanel } from "./ContactsPanel.js";
import { formatRelativeInteractionTime, SocialProfileOverlay } from "./SocialProfileOverlay.js";

vi.mock("./RigPortrait.js", () => ({
  RigPortrait: ({ ariaLabel }: { ariaLabel?: string }) => (
    <div data-testid="profile-character-preview" aria-label={ariaLabel} />
  )
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("labels encounters older than the bounded recent window honestly", () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  expect(formatRelativeInteractionTime("2026-06-01T00:00:00.000Z", now)).toBe("30+ days ago");
});

describe("SocialProfileOverlay target lifecycle", () => {
  it("uses one phone destination shell with top-aligned profile content", async () => {
    const requests = profileRequests();
    const view = renderOverlay({ playerId: "a", expanded: true, layout: "phone" });
    await resolve(requests.for("a"), profile("a", "Player A"));
    const shell = await screen.findByRole("dialog", { name: "Profile" });
    const panel = view.container.querySelector<HTMLElement>(".profile-ledger");
    expect(shell.classList.contains("phone-destination-shell")).toBe(true);
    expect(panel).toBeTruthy();
    expect(panel?.querySelector(".profile-hero")).toBeTruthy();
    expect(panel?.querySelector(".profile-header")).toBeTruthy();
    expect(screen.getByTestId("profile-character-preview")).toBeTruthy();
    expect(shell.querySelector(".phone-destination-body")).toBeTruthy();
    expect(shell.textContent).not.toContain("Player Ledger");
    expect(shell.textContent).not.toContain("Identity and relationships");
    expect(shell.textContent).not.toContain("Current Appearance");
    expect(shell.textContent).not.toContain("Appearance");
    expect(shell.textContent).not.toContain("Player portrait");
    expect(shell.textContent).not.toContain("Identity & Affiliations");
    expect(shell.textContent).not.toContain("Standing");
  });

  it("invalidates A and exposes no stale action while B is loading", async () => {
    const requests = profileRequests();
    const mutate = vi.spyOn(ProfileApiClient.prototype, "mutate");
    const view = renderOverlay({ playerId: "a", expanded: true });
    await resolve(requests.for("a"), profile("a", "Player A"));
    expect(await screen.findByText("Player A")).toBeTruthy();
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();

    view.rerender(overlay({ playerId: "b", expanded: true }));
    expect(screen.queryByText("Player A")).toBeNull();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.getByText("Loading profile...")).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("ignores A when its response arrives after B", async () => {
    const requests = profileRequests();
    const view = renderOverlay({ playerId: "a", expanded: true });
    view.rerender(overlay({ playerId: "b", expanded: true }));
    await resolve(requests.for("b"), profile("b", "Player B"));
    expect(await screen.findByText("Player B")).toBeTruthy();
    await resolve(requests.for("a"), profile("a", "Player A"));
    expect(screen.getByText("Player B")).toBeTruthy();
    expect(screen.queryByText("Player A")).toBeNull();
  });

  it("cannot use a detached A action after list-style navigation to B", async () => {
    const mutate = vi.spyOn(ProfileApiClient.prototype, "mutate");
    vi.spyOn(ProfileApiClient.prototype, "list").mockResolvedValue({
      kind: "friends",
      entries: [{
        playerId: "a",
        displayName: "Player A",
        level: 4,
        portrait: { kind: "player_sprite", displayColor: null },
        title: null,
        presence: "online",
        class: null,
        kingdom: null,
        settlement: null,
        relationship: { friendship: "friends", enemyMarkedByViewer: false }
      }],
      offset: 0,
      limit: 25,
      hasMore: false
    });
    const requests = profileRequests();
    render(<ContactsNavigationHarness />);
    fireEvent.click(await screen.findByRole("button", { name: /Player A/ }));
    await resolve(requests.for("a"), profile("a", "Player A"));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const staleAction = screen.getByRole("menuitem", { name: "Add Friend" });

    fireEvent.click(screen.getByRole("button", { name: "Open B" }));
    fireEvent.click(staleAction);
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Player A")).toBeNull();
  });

  it("shows only the unavailable state after a selected target leaves visibility", async () => {
    const requests = profileRequests();
    const view = renderOverlay({ playerId: "a", expanded: true, available: true });
    await resolve(requests.for("a"), profile("a", "Player A"));
    expect(await screen.findByText("Player A")).toBeTruthy();

    view.rerender(overlay({ playerId: "a", expanded: true, available: false }));
    expect(screen.getByText("Player unavailable")).toBeTruthy();
    expect(screen.queryByText("Player A")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Friend" })).toBeNull();
  });
});

describe("SocialProfileOverlay interactions", () => {
  it("opens blocked players directly from Manage without a transient menu", async () => {
    vi.spyOn(ProfileApiClient.prototype, "list").mockImplementation(async (kind) => ({
      kind,
      entries: [],
      offset: 0,
      limit: 25,
      hasMore: false
    }));
    render(
      <ContactsPanel
        open
        ownPlayerId="self"
        serverHttpBase="http://127.0.0.1:3001"
        csrfToken="csrf"
        refreshToken={0}
        layout="phone"
        onOpenPlayer={() => undefined}
        onClose={() => undefined}
      />
    );

    const manage = await screen.findByRole("button", { name: "Manage" });
    fireEvent.click(manage);

    expect(manage.getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByText("No blocked players.")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("uses a single Back action for a profile opened from the player's connections", async () => {
    const requests = profileRequests();
    vi.spyOn(ProfileApiClient.prototype, "list").mockResolvedValue({
      kind: "friends",
      entries: [{
        playerId: "a",
        displayName: "Player A",
        level: 4,
        portrait: { kind: "player_sprite", displayColor: null },
        title: null,
        presence: "online",
        class: null,
        kingdom: null,
        settlement: null,
        relationship: { friendship: "friends", enemyMarkedByViewer: false }
      }],
      offset: 0,
      limit: 25,
      hasMore: false
    });
    render(<ContactsNavigationHarness layout="phone" />);
    fireEvent.click(await screen.findByRole("button", { name: /Player A/ }));
    await resolve(requests.for("a"), profile("a", "Player A"));

    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to Game Menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Return to Game" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Contacts" })).toBeTruthy();
  });

  it("does not offer a body or gender selector", async () => {
    const requests = profileRequests();
    vi.spyOn(ProfileApiClient.prototype, "list").mockResolvedValue({
      kind: "friends", entries: [], offset: 0, limit: 25, hasMore: false
    });
    renderOverlay({ playerId: "self", expanded: true });
    await resolve(requests.for("self"), {
      ...profile("self", "Self"),
      isSelf: true
    });

    fireEvent.click(await screen.findByRole("button", { name: "Edit Profile" }));
    expect(screen.queryByRole("combobox", { name: "Body" })).toBeNull();
    expect(screen.queryByText("Male")).toBeNull();
    expect(screen.queryByText("Female")).toBeNull();
  });

  it("shows the authoritative pending count beside Incoming and hides zero", async () => {
    vi.spyOn(ProfileApiClient.prototype, "list").mockResolvedValue({
      kind: "friends", entries: [], offset: 0, limit: 25, hasMore: false
    });
    const view = render(
      <ContactsPanel
        open
        ownPlayerId="self"
        serverHttpBase="http://127.0.0.1:3001"
        csrfToken="csrf"
        refreshToken={0}
        pendingIncomingFriendRequestCount={2}
        onOpenPlayer={() => undefined}
        onClose={() => undefined}
      />
    );
    expect((await screen.findByRole("tab", { name: "Requests, 2 pending" })).textContent).toBe("Requests2");
    view.rerender(
      <ContactsPanel
        open
        ownPlayerId="self"
        serverHttpBase="http://127.0.0.1:3001"
        csrfToken="csrf"
        refreshToken={0}
        pendingIncomingFriendRequestCount={0}
        onOpenPlayer={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(screen.queryByLabelText(/pending incoming friend requests/)).toBeNull();
  });
  it("shows the authoritative resend cooldown after the outgoing invite arrives", async () => {
    const requests = profileRequests();
    const onSendTravelInvite = vi.fn(() => true);
    const view = renderOverlay({
      playerId: "a",
      expanded: true,
      onSendTravelInvite
    });
    await resolve(requests.for("a"), profile("a", "Player A"));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const button = screen.getByRole("menuitem", { name: "Send Travel Invite" });
    fireEvent.click(button);
    expect(onSendTravelInvite).toHaveBeenCalledWith("a");
    expect((button as HTMLButtonElement).disabled).toBe(false);

    view.rerender(overlay({
      playerId: "a",
      expanded: true,
      onSendTravelInvite,
      outgoingTravelInvite: travelInvite("a")
    }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const confirmed = screen.getByRole("menuitem", { name: /Travel Invite in \d+s/ });
    expect((confirmed as HTMLButtonElement).disabled).toBe(true);
    expect(confirmed.getAttribute("title")).toMatch(/send a fresh invite in \d+ seconds/);
  });

  it.each(["accepted", "declined", "cancelled", "expired", "invalidated"] as const)(
    "preserves the resend cooldown after authoritative %s closure",
    async (status) => {
      const requests = profileRequests();
      renderOverlay({
        playerId: "a",
        expanded: true,
        onSendTravelInvite: vi.fn(() => true),
        outgoingTravelInvite: travelInvite("a", { status })
      });
      await resolve(requests.for("a"), profile("a", "Player A"));
      fireEvent.click(await screen.findByRole("button", { name: "More" }));
      expect((screen.getByRole("menuitem", {
        name: /Travel Invite in \d+s/
      }) as HTMLButtonElement).disabled).toBe(true);
    }
  );

  it("restores the button when the server-issued resend cooldown passes", async () => {
    const requests = profileRequests();
    renderOverlay({
      playerId: "a",
      expanded: true,
      onSendTravelInvite: vi.fn(() => true),
      outgoingTravelInvite: travelInvite("a", {
        createdAt: "2000-01-01T00:00:00.000Z"
      })
    });
    await resolve(requests.for("a"), profile("a", "Player A"));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect((screen.getByRole("menuitem", { name: "Send Travel Invite" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it("scopes confirmed state to its recipient and restores it after remount", async () => {
    const requests = profileRequests();
    const props = {
      playerId: "a",
      expanded: true,
      onSendTravelInvite: vi.fn(() => true),
      outgoingTravelInvite: travelInvite("a")
    };
    const first = renderOverlay(props);
    await resolve(requests.for("a"), profile("a", "Player A"));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect((screen.getByRole("menuitem", { name: /Travel Invite in \d+s/ }) as HTMLButtonElement).disabled)
      .toBe(true);
    first.unmount();

    renderOverlay(props);
    await resolve(requests.for("a"), profile("a", "Player A"));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect((screen.getByRole("menuitem", { name: /Travel Invite in \d+s/ }) as HTMLButtonElement).disabled)
      .toBe(true);

    cleanup();
    renderOverlay({
      playerId: "b",
      expanded: true,
      onSendTravelInvite: vi.fn(() => true),
      outgoingTravelInvite: travelInvite("a")
    });
    await resolve(requests.for("b"), profile("b", "Player B"));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect((screen.getByRole("menuitem", { name: "Send Travel Invite" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it("shows bounded Recent Players with reason/time and routes the shared actions surface", async () => {
    vi.spyOn(ProfileApiClient.prototype, "list").mockResolvedValue({
      kind: "friends", entries: [], offset: 0, limit: 25, hasMore: false
    });
    vi.spyOn(ProfileApiClient.prototype, "listRecent").mockResolvedValue({
      entries: [{
        playerId: "recent-player",
        displayName: "Recent Player",
        portrait: { kind: "player_sprite", displayColor: "#38bdf8" },
        presence: "hidden",
        relationship: { friendship: "none", enemyMarkedByViewer: false },
        interactionType: "local_chat",
        interactionAt: new Date().toISOString()
      }]
    });
    const onOpenPlayerActions = vi.fn();
    const onInviteParty = vi.fn(() => true);
    render(
      <ContactsPanel
        open
        ownPlayerId="self"
        serverHttpBase="http://127.0.0.1:3001"
        csrfToken="csrf"
        refreshToken={0}
        onOpenPlayer={() => undefined}
        onOpenPlayerActions={onOpenPlayerActions}
        onInviteParty={onInviteParty}
        partyInviteContext={inviteContext()}
        onClose={() => undefined}
      />
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Recent" }));
    expect(await screen.findByText("Local chat · Just now")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(onOpenPlayerActions).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: "recent-player", displayName: "Recent Player" }),
      expect.objectContaining({ left: expect.any(Number), bottom: expect.any(Number) })
    );
    expect(screen.queryByRole("button", { name: "Invite to Party" })).toBeNull();
    expect(screen.queryByText(/coordinates|location|latitude|longitude/i)).toBeNull();
  });

  it("invites a Friend by stable player ID and explains pending state inline", async () => {
    vi.spyOn(ProfileApiClient.prototype, "list").mockResolvedValue({
      kind: "friends",
      entries: [{
        playerId: "friend-anywhere",
        displayName: "Friend Anywhere",
        level: 4,
        portrait: { kind: "player_sprite", displayColor: null },
        title: null,
        presence: "offline",
        class: null,
        kingdom: null,
        settlement: null,
        relationship: { friendship: "friends", enemyMarkedByViewer: false }
      }],
      offset: 0,
      limit: 25,
      hasMore: false
    });
    const onInviteParty = vi.fn(() => true);
    render(
      <ContactsPanel
        open
        ownPlayerId="self"
        serverHttpBase="http://127.0.0.1:3001"
        csrfToken="csrf"
        refreshToken={0}
        onInviteParty={onInviteParty}
        partyInviteContext={inviteContext()}
        onOpenPlayer={() => undefined}
        onClose={() => undefined}
      />
    );
    await screen.findByText("Friend Anywhere");
    expect(screen.queryByRole("button", { name: "Invite to Party" })).toBeNull();
    expect(onInviteParty).not.toHaveBeenCalled();
  });

  it("opens the expanded profile from the compact nearby-player card", async () => {
    const requests = profileRequests();
    const onExpand = vi.fn();
    renderOverlay({ playerId: "a", expanded: false, onExpand });
    await resolve(requests.for("a"), profile("a", "Player A"));
    fireEvent.click(await screen.findByRole("button", { name: "View Profile" }));
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it("submits once while loading and replaces state with the server response", async () => {
    const requests = profileRequests();
    const mutation = deferred<PublicProfile>();
    const mutate = vi.spyOn(ProfileApiClient.prototype, "mutate").mockReturnValue(mutation.promise);
    renderOverlay({ playerId: "a", expanded: true });
    await resolve(requests.for("a"), profile("a", "Player A"));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Friend" }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const again = screen.getByRole("menuitem", { name: "Add Friend" }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    expect(mutate).toHaveBeenCalledTimes(1);

    await resolve(mutation, profile("a", "Player A", "friends"));
    expect(await screen.findByRole("menuitem", { name: "Remove Friend" })).toBeTruthy();
  });

  it("restores controls after a server error", async () => {
    const requests = profileRequests();
    const mutation = deferred<PublicProfile>();
    vi.spyOn(ProfileApiClient.prototype, "mutate").mockReturnValue(mutation.promise);
    renderOverlay({ playerId: "a", expanded: true });
    await resolve(requests.for("a"), profile("a", "Player A"));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Friend" }));
    await reject(mutation, new Error("Try again"));
    expect(await screen.findByText("Try again")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect((screen.getByRole("menuitem", { name: "Add Friend" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports a successful local block so chat safety state can refresh", async () => {
    const requests = profileRequests();
    const onRelationshipMutated = vi.fn();
    vi.spyOn(ProfileApiClient.prototype, "mutate").mockResolvedValue(
      profile("a", "Player A", "blocked_by_viewer")
    );
    renderOverlay({
      playerId: "a",
      expanded: true,
      onRelationshipMutated
    });
    await resolve(requests.for("a"), profile("a", "Player A"));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Block Player" }));

    await vi.waitFor(() => {
      expect(onRelationshipMutated).toHaveBeenCalledWith("a", "block");
    });
  });

  it("stops profile clicks from propagating to map-level selection handlers", async () => {
    const requests = profileRequests();
    const parentClick = vi.fn();
    vi.spyOn(ProfileApiClient.prototype, "mutate").mockResolvedValue(profile("a", "Player A"));
    render(<div onClick={parentClick}>{overlay({ playerId: "a", expanded: true })}</div>);
    await resolve(requests.for("a"), profile("a", "Player A"));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Friend" }));
    expect(parentClick).not.toHaveBeenCalled();
  });
});

function renderOverlay(options: OverlayOptions) {
  return render(overlay(options));
}

function ContactsNavigationHarness({ layout }: {
  layout?: ComponentProps<typeof SocialProfileOverlay>["layout"];
} = {}) {
  const [playerId, setPlayerId] = useState<string | null>(null);
  return (
    <>
      <button type="button" onClick={() => setPlayerId("b")}>Open B</button>
      <ContactsPanel
        open={playerId === null}
        ownPlayerId="self"
        serverHttpBase="http://127.0.0.1:3001"
        csrfToken="csrf"
        refreshToken={0}
        onOpenPlayer={setPlayerId}
        onClose={() => setPlayerId(null)}
      />
      <SocialProfileOverlay
        playerId={playerId}
        ownPlayerId="self"
        expanded
        available
        serverHttpBase="http://127.0.0.1:3001"
        csrfToken="csrf"
        refreshToken={0}
        onExpand={() => undefined}
        onOpenPlayer={setPlayerId}
        {...(layout ? { layout, closeLabel: "Back" } : {})}
        onClose={() => setPlayerId(null)}
      />
    </>
  );
}

type OverlayOptions = {
  playerId: string;
  expanded: boolean;
  available?: boolean;
  onExpand?: () => void;
  onRelationshipMutated?: (playerId: string, action: SocialAction) => void;
  onOpenPlayerActions?: ComponentProps<typeof SocialProfileOverlay>["onOpenPlayerActions"];
  partyInviteContext?: ComponentProps<typeof SocialProfileOverlay>["partyInviteContext"];
  onInviteParty?: ComponentProps<typeof SocialProfileOverlay>["onInviteParty"];
  onSendTravelInvite?: ComponentProps<typeof SocialProfileOverlay>["onSendTravelInvite"];
  outgoingTravelInvite?: ComponentProps<typeof SocialProfileOverlay>["outgoingTravelInvite"];
  layout?: ComponentProps<typeof SocialProfileOverlay>["layout"];
  pendingIncomingFriendRequestCount?: number;
};

function overlay({
  playerId,
  expanded,
  available = true,
  onExpand = () => undefined,
  onRelationshipMutated,
  onOpenPlayerActions,
  partyInviteContext,
  onInviteParty,
  onSendTravelInvite,
  outgoingTravelInvite,
  layout,
  pendingIncomingFriendRequestCount
}: OverlayOptions) {
  return (
    <SocialProfileOverlay
      playerId={playerId}
      ownPlayerId="self"
      expanded={expanded}
      available={available}
      serverHttpBase="http://127.0.0.1:3001"
      csrfToken="csrf"
      refreshToken={0}
      {...(pendingIncomingFriendRequestCount !== undefined ? { pendingIncomingFriendRequestCount } : {})}
      {...(layout ? { layout } : {})}
      onExpand={onExpand}
      onOpenPlayer={() => undefined}
      {...(onOpenPlayerActions ? { onOpenPlayerActions } : {})}
      {...(onRelationshipMutated ? { onRelationshipMutated } : {})}
      {...(partyInviteContext ? { partyInviteContext } : {})}
      {...(onInviteParty ? { onInviteParty } : {})}
      {...(onSendTravelInvite ? { onSendTravelInvite } : {})}
      {...(outgoingTravelInvite !== undefined ? { outgoingTravelInvite } : {})}
      onClose={() => undefined}
    />
  );
}

function travelInvite(
  counterpartPlayerId: string,
  overrides: Partial<TravelInboxEntry> = {}
): TravelInboxEntry {
  return {
    entryId: "00000000-0000-4000-8000-000000000031",
    inviteId: "00000000-0000-4000-8000-000000000032",
    perspective: "sender",
    counterpartPlayerId,
    counterpartName: counterpartPlayerId,
    message: `You invited ${counterpartPlayerId} to your current area.`,
    status: "pending",
    invalidationReason: null,
    sourceType: "area",
    sourceId: "area:test",
    createdAt: new Date(Date.now()).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    respondedAt: null,
    ...overrides
  };
}

function inviteContext(
  overrides: Partial<NonNullable<ComponentProps<typeof SocialProfileOverlay>["partyInviteContext"]>> = {}
) {
  return {
    connected: true,
    inviterPlayerId: "self",
    party: {
      partyId: "party-1",
      leaderPlayerId: "self",
      memberPlayerIds: ["self"],
      allowTravel: false,
      autoFollowPlayerIds: [],
      revision: 1
    },
    outgoingInvites: [],
    now: Date.parse("2026-07-18T00:00:00.000Z"),
    ...overrides
  };
}

function profile(
  playerId: string,
  displayName: string,
  friendship: PublicProfile["relationship"]["friendship"] = "none"
): PublicProfile {
  return {
    playerId,
    displayName,
    level: 4,
    portrait: { kind: "player_sprite", displayColor: null },
    title: null,
    biography: "Plain biography",
    presence: "online",
    class: null,
    kingdom: null,
    settlement: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    isSelf: false,
    relationship: { friendship, enemyMarkedByViewer: false }
  };
}

function profileRequests() {
  const requests = new Map<string, Deferred<PublicProfile>>();
  vi.spyOn(ProfileApiClient.prototype, "getProfile").mockImplementation((playerId) => {
    const request = deferred<PublicProfile>();
    requests.set(playerId, request);
    return request.promise;
  });
  return {
    for(playerId: string): Deferred<PublicProfile> {
      const request = requests.get(playerId);
      if (!request) throw new Error(`No request for ${playerId}`);
      return request;
    }
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function resolve<T>(request: Deferred<T>, value: T): Promise<void> {
  await act(async () => {
    request.resolve(value);
    await request.promise;
  });
}

async function reject<T>(request: Deferred<T>, reason: unknown): Promise<void> {
  await act(async () => {
    request.reject(reason);
    await request.promise.catch(() => undefined);
  });
}
