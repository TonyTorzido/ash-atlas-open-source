// @vitest-environment jsdom

import type { KingdomInvitationSnapshot, PartyInviteSnapshot, PlayerPackageSnapshot, TravelInboxEntry } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectMessageStore } from "../directMessages/directMessageStore.js";
import type { DirectConversationView } from "../directMessages/directMessageStore.js";
import { DirectMessagesPanel, type DirectMessagesPanelProps } from "./DirectMessagesPanel.js";

afterEach(cleanup);

describe("phone Messages inbox", () => {
  it("resolves a durable friendship request by stable player ID and opens that profile", async () => {
    const onRespondFriendRequest = vi.fn(async () => true);
    const onOpenPlayerProfile = vi.fn();
    render(<DirectMessagesPanel
      {...baseProps()}
      socialEntries={[{
        id: "00000000-0000-4000-8000-000000000010",
        kind: "friend_request",
        actorPlayerId: "00000000-0000-4000-8000-000000000002",
        actorDisplayName: "Twin Name",
        state: "pending",
        createdAt: "2026-07-22T18:00:00.000Z",
        updatedAt: "2026-07-22T18:00:00.000Z"
      }]}
      onRespondFriendRequest={onRespondFriendRequest}
      onOpenPlayerProfile={onOpenPlayerProfile}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    const card = screen.getByText("Friendship Request").closest("article")!;
    const heading = card.querySelector(":scope > .mobile-inbox-entry-heading") as HTMLElement;
    expect(within(heading).getByText("Twin Name")).toBeTruthy();
    expect(heading.querySelector("time")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "View Profile" }));
    expect(onOpenPlayerProfile).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002");
    fireEvent.click(within(card).getByRole("button", { name: "Accept Friend" }));
    await waitFor(() => expect(onRespondFriendRequest).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      "accept_friend_request"
    ));
  });

  it("presents resolved social notifications with the compact personal-message hierarchy", () => {
    const id = "00000000-0000-4000-8000-000000000011";
    const revision = "2026-07-22T19:00:00.000Z";
    render(<DirectMessagesPanel
      {...baseProps()}
      socialEntries={[{
        id,
        kind: "friend_request",
        actorPlayerId: "00000000-0000-4000-8000-000000000003",
        actorDisplayName: "DapperHobo",
        state: "accepted",
        createdAt: "2026-07-22T18:00:00.000Z",
        updatedAt: revision
      }]}
      readReceipts={{ [`social:${id}`]: revision }}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    const entry = screen.getByText("Friendship Request · DapperHobo").closest("article")!;
    expect(entry.classList.contains("has-compact-profile-action")).toBe(true);
    expect(entry.querySelector("header span")).toBeNull();
    const heading = entry.querySelector(".mobile-inbox-entry-heading") as HTMLElement;
    expect(heading.querySelector("strong")?.textContent).toBe("Friendship Request · DapperHobo");
    expect(heading.querySelector("time")).toBeTruthy();
    expect(within(entry).queryByText("DapperHobo")).toBeNull();
    expect(entry.querySelector(".mobile-inbox-notification-state")?.textContent).toBe("Accepted");
    expect(within(entry).getByRole("button", { name: "View Profile" })).toBeTruthy();
  });

  it("uses a meaningful system-notice title without repeating Ash Atlas or read metadata", () => {
    const notice = {
      eventKind: "legendary_bird_event",
      eventId: "00000000-0000-4000-8000-000000000099",
      message: "An Ice Phoenix is attacking your flag!",
      createdAt: "2026-07-22T17:15:00.000Z"
    } as const;
    render(<DirectMessagesPanel
      {...baseProps()}
      gameNotices={[notice]}
      readReceipts={{ [`game:${notice.eventKind}:${notice.eventId}`]: notice.createdAt }}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    const entry = screen.getByText("Legendary Bird Event").closest("article")!;
    expect(entry.querySelector("strong")?.textContent).toBe("Legendary Bird Event");
    expect(within(entry).queryByText("Ash Atlas")).toBeNull();
    expect(entry.querySelector(".mobile-inbox-notification-state")).toBeNull();
    expect(within(entry).getByText(notice.message)).toBeTruthy();
  });

  it("renders empty Requests as a quiet unboxed state", () => {
    render(<DirectMessagesPanel {...baseProps()} />);

    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    const empty = screen.getByText("No pending requests");
    expect(empty.closest("[role=\"status\"]")).not.toBeNull();
    expect(empty.closest(".mobile-inbox-ledger")?.classList.contains("is-empty")).toBe(true);
    expect(empty.closest(".mobile-inbox-ledger")?.classList.contains("category-invites")).toBe(true);
  });

  it("marks a package read on open and claims it only from the explicit package action", async () => {
    const onMarkInboxRead = vi.fn(async () => true);
    const onClaimPlayerPackage = vi.fn(async () => "Package opened.");
    render(<ControlledDirectMessagesPanel
      {...baseProps()}
      playerPackages={[playerPackage()]}
      onMarkInboxRead={onMarkInboxRead}
      onClaimPlayerPackage={onClaimPlayerPackage}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    fireEvent.click(screen.getByRole("button", { name: /Read Founder supplies from Ash Atlas/ }));
    await waitFor(() => expect(onMarkInboxRead).toHaveBeenCalledWith([
      { entryKey: "package:00000000-0000-4000-8000-000000000099", revision: "1" }
    ]));
    expect(onClaimPlayerPackage).not.toHaveBeenCalled();
    expect(screen.getByText("250 of 250 remaining")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Package" }));
    await waitFor(() => expect(onClaimPlayerPackage).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000099",
      "1"
    ));
    expect(screen.getByText("Package opened.")).toBeTruthy();
  });

  it("keeps a package read through partial and complete claim revisions, including a late read response", async () => {
    let finishRead: (() => void) | undefined;
    const pendingRead = new Promise<void>((resolve) => {
      finishRead = resolve;
    });

    function Harness(): React.JSX.Element {
      const [packages, setPackages] = useState<readonly PlayerPackageSnapshot[]>([
        playerPackage()
      ]);
      const [readReceipts, setReadReceipts] = useState<Readonly<Record<string, string>>>({});
      const [selectedNotificationKey, setSelectedNotificationKey] = useState<string | null>(null);
      return <DirectMessagesPanel
        {...baseProps()}
        playerPackages={packages}
        readReceipts={readReceipts}
        selectedNotificationKey={selectedNotificationKey}
        onSelectNotification={setSelectedNotificationKey}
        onMarkInboxRead={async (entries) => {
          await pendingRead;
          setReadReceipts(Object.fromEntries(
            entries.map(({ entryKey, revision }) => [entryKey, revision])
          ));
          return true;
        }}
        onClaimPlayerPackage={async (_packageId, revision) => {
          setPackages((current) => current.map((entry) => revision === "1"
            ? {
                ...entry,
                status: "partial",
                readAt: "2026-01-01T00:01:00.000Z",
                firstClaimedAt: "2026-01-01T00:01:00.000Z",
                revision: "2",
                items: entry.items.map((item) => ({ ...item, remainingQuantity: 50 }))
              }
            : {
                ...entry,
                status: "claimed",
                readAt: "2026-01-01T00:01:00.000Z",
                claimedAt: "2026-01-01T00:02:00.000Z",
                revision: "3",
                items: entry.items.map((item) => ({ ...item, remainingQuantity: 0 }))
              }));
          return revision === "1" ? "Some items remain." : "Package opened.";
        }}
      />;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    expect(screen.getByRole("tab", { name: /Notifications/ }).textContent).toContain("1");
    fireEvent.click(screen.getByRole("button", { name: /Read Founder supplies from Ash Atlas/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open Package" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Claim Remaining" })).toBeTruthy());
    expect(screen.getByText("50 of 250 remaining")).toBeTruthy();

    finishRead?.();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Notifications" }).textContent).toBe("Notifications"));

    fireEvent.click(screen.getByRole("button", { name: /Read Founder supplies from Ash Atlas/ }));
    fireEvent.click(screen.getByRole("button", { name: "Claim Remaining" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Package Claimed" })).toBeTruthy());
    expect(screen.getByText("0 of 250 remaining")).toBeTruthy();
    expect(screen.getByText("Claimed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Founder supplies")).toBeTruthy();
    expect(screen.getByText("Claimed")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Notifications" }).textContent).toBe("Notifications");
  });

  it("switches all three categories and delegates invitation actions to authoritative handlers", async () => {
    const onAcceptTravelInvite = vi.fn(() => true);
    const onDeclineTravelInvite = vi.fn(() => true);
    const onAcceptPartyInvite = vi.fn(() => true);
    const onRespondKingdomInvitation = vi.fn(() => Promise.resolve(true));
    const onInboxActionConfirmed = vi.fn();
    render(<DirectMessagesPanel
      {...baseProps()}
      travelEntries={[
        travel("pending"),
        travel("accepted", "travel-history"),
        travel("declined", "travel-declined")
      ]}
      partyInvites={[party()]}
      partyPlayerNames={{ inviter: "Party Leader" }}
      kingdomInvitations={[kingdom()]}
      ownPlayerId="self"
      onAcceptTravelInvite={onAcceptTravelInvite}
      onDeclineTravelInvite={onDeclineTravelInvite}
      onAcceptPartyInvite={onAcceptPartyInvite}
      onRespondKingdomInvitation={onRespondKingdomInvitation}
      onInboxActionConfirmed={onInboxActionConfirmed}
    />);

    expect(screen.queryByRole("tab", { name: "Inbox" })).toBeNull();
    expect(screen.getByRole("tab", { name: /Personal/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    expect(screen.getAllByText("Travel Invitation")).toHaveLength(1);
    const travelCard = screen.getByText("Travel Invitation").closest("article")!;
    fireEvent.click(within(travelCard).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(
      (within(travelCard).getByRole("button", { name: "Decline" }) as HTMLButtonElement).disabled,
    ).toBe(false));
    fireEvent.click(within(travelCard).getByRole("button", { name: "Decline" }));
    expect(onAcceptTravelInvite).toHaveBeenCalledWith("travel-invite");
    expect(onDeclineTravelInvite).toHaveBeenCalledWith("travel-invite");

    expect(screen.getAllByText("Travel Invitation")).toHaveLength(1);
    expect(screen.queryByText("Accepted")).toBeNull();
    const partyCard = screen.getByText("Party Invitation").closest("article")!;
    fireEvent.pointerDown(within(partyCard).getByRole("button", { name: "Accept" }));
    fireEvent.click(within(partyCard).getByRole("button", { name: "Accept" }));
    expect(onAcceptPartyInvite).toHaveBeenCalledOnce();
    expect(onAcceptPartyInvite).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    await waitFor(() => expect(onInboxActionConfirmed).toHaveBeenCalledWith(
      "party:00000000-0000-4000-8000-000000000001",
      "2099-01-01T00:00:00.000Z"
    ));
    const kingdomCard = screen.getByText("Kingdom Invitation").closest("article")!;
    fireEvent.click(within(kingdomCard).getByRole("button", { name: "Decline" }));
    expect(onRespondKingdomInvitation).toHaveBeenCalledWith("kingdom-invite", "decline");

    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    expect(screen.getByText("Declined")).toBeTruthy();
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Personal/ }));
    expect(screen.getByText("No personal messages")).toBeTruthy();
  });

  it("offers party members a send-to-leader action for merge invitations", async () => {
    const onForwardPartyInvite = vi.fn(() => Promise.resolve(true));
    render(<DirectMessagesPanel
      {...baseProps()}
      partyInvites={[party()]}
      partyPlayerNames={{ inviter: "Party Leader" }}
      ownPlayerId="self"
      forwardPartyInvitesToLeader
      onForwardPartyInvite={onForwardPartyInvite}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    const partyCard = screen.getByText("Party Invitation").closest("article")!;
    fireEvent.click(within(partyCard).getByRole("button", { name: "Send to Leader" }));
    await waitFor(() => expect(onForwardPartyInvite).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001"
    ));
  });

  it("labels a leader's party acceptance as a merge review", () => {
    render(<DirectMessagesPanel
      {...baseProps()}
      partyInvites={[party()]}
      partyPlayerNames={{ inviter: "Party Leader" }}
      partyInviteRequiresMergeReview
      onAcceptPartyInvite={vi.fn(() => true)}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    expect(screen.getByRole("button", { name: "Review Merge" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("opens a notification as a focused message and marks it read", async () => {
    const onMarkInboxRead = vi.fn(() => Promise.resolve(true));
    const onClose = vi.fn();
    const onReturnToGame = vi.fn();
    function Harness(): React.JSX.Element {
      const [selectedNotificationKey, setSelectedNotificationKey] = useState<string | null>(null);
      return <DirectMessagesPanel
        {...baseProps()}
        travelEntries={[travel("declined", "travel-declined")]}
        selectedNotificationKey={selectedNotificationKey}
        onSelectNotification={setSelectedNotificationKey}
        onMarkInboxRead={onMarkInboxRead}
        onClose={onClose}
        onReturnToGame={onReturnToGame}
      />;
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    fireEvent.click(screen.getByRole("button", {
      name: "Read Travel Invitation from Traveler"
    }));

    const detail = screen.getByRole("region", {
      name: "Travel Invitation from Traveler"
    });
    expect(detail).toBeTruthy();
    expect(screen.getByText("Travel to the active flag.")).toBeTruthy();
    expect(detail.querySelector(":scope > header button")).toBeNull();
    const footer = document.querySelector(".phone-menu-footer") as HTMLElement;
    expect(within(footer).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "Back",
      "Return to Game"
    ]);
    await waitFor(() => expect(onMarkInboxRead).toHaveBeenCalledWith([{
      entryKey: "travel:travel-declined",
      revision: "2026-01-01T01:00:00.000Z"
    }]));

    fireEvent.click(within(footer).getByRole("button", { name: "Return to Game" }));
    expect(onReturnToGame).toHaveBeenCalledTimes(1);
    fireEvent.click(within(footer).getByRole("button", { name: "Back" }));
    expect(screen.getByRole("tab", { name: /Notifications/ })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not treat opening a category as handling an event", () => {
    const onAcceptTravelInvite = vi.fn();
    render(<DirectMessagesPanel {...baseProps()} travelEntries={[travel("pending")]} onAcceptTravelInvite={onAcceptTravelInvite} />);
    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    expect(onAcceptTravelInvite).not.toHaveBeenCalled();
    expect(screen.getByText("Pending")).toBeTruthy();
  });

  it("renders an invite invalidated by inviter movement as canceled", () => {
    render(<DirectMessagesPanel
      {...baseProps()}
      travelEntries={[{
        ...travel("invalidated"),
        invalidationReason: "The inviter relocated to another gameplay layer."
      }]}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    expect(screen.getByText("Invite canceled")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.getByText("Travel Invitation · Traveler").closest("article")?.classList.contains("category-notifications")).toBe(true);
  });

  it("submits the exact hosted travel invite once", async () => {
    let confirm!: (value: boolean) => void;
    const authoritativeResult = new Promise<boolean>((resolve) => { confirm = resolve; });
    const onAcceptTravelInvite = vi.fn(() => authoritativeResult);
    const onDeclineTravelInvite = vi.fn(() => true);
    const entry = {
      ...travel("pending"),
      inviteId: "exact-travel-invite"
    } satisfies TravelInboxEntry;
    render(<DirectMessagesPanel
      {...baseProps()}
      travelEntries={[entry]}
      onAcceptTravelInvite={onAcceptTravelInvite}
      onDeclineTravelInvite={onDeclineTravelInvite}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    const card = screen.getByText("Travel Invitation").closest("article")!;
    const accept = within(card).getByRole("button", { name: "Accept" }) as HTMLButtonElement;
    const decline = within(card).getByRole("button", { name: "Decline" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    expect(decline.disabled).toBe(false);

    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(onAcceptTravelInvite).toHaveBeenCalledOnce();
    expect(onAcceptTravelInvite).toHaveBeenCalledWith("exact-travel-invite");
    expect(within(card).getByRole("button", { name: "Accepting…" })).toBeTruthy();
    expect((within(card).getByRole("button", { name: "Accepting…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(decline.disabled).toBe(true);

    confirm(true);
    await waitFor(() => expect(
      (within(card).getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled
    ).toBe(false));
  });

  it("preserves accepted and rejected travel receipts from authoritative results", async () => {
    function SuccessHarness(): React.JSX.Element {
      const [entry, setEntry] = useState(travel("pending"));
      return <DirectMessagesPanel
        {...baseProps()}
        travelEntries={[entry]}
        onAcceptTravelInvite={async () => {
          setEntry({
            ...entry,
            status: "accepted",
            respondedAt: "2099-01-01T01:00:00.000Z",
            updatedAt: "2099-01-01T01:00:00.000Z"
          });
          return true;
        }}
      />;
    }
    const success = render(<SuccessHarness />);
    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Accept" })).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(screen.getByText("Travel Invitation · Traveler").closest("article")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    success.unmount();

    const onAcceptTravelInvite = vi.fn(() => Promise.reject(new Error("The inviter moved away.")));
    render(<DirectMessagesPanel
      {...baseProps()}
      travelEntries={[travel("pending")]}
      onAcceptTravelInvite={onAcceptTravelInvite}
    />);
    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("The inviter moved away."));
    expect(screen.getByText("Pending")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables travel actions when offline, expired, or already used while decline remains available online", () => {
    const online = render(<DirectMessagesPanel
      {...baseProps()}
      travelEntries={[travel("pending")]}
      onAcceptTravelInvite={vi.fn(() => true)}
      onDeclineTravelInvite={vi.fn(() => true)}
    />);
    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Decline" }) as HTMLButtonElement).disabled).toBe(false);
    online.unmount();

    const offlineProps = baseProps();
    const offline = render(<DirectMessagesPanel
      {...offlineProps}
      connectionStatus="offline"
      travelEntries={[travel("pending")]}
      onAcceptTravelInvite={vi.fn(() => true)}
      onDeclineTravelInvite={vi.fn(() => true)}
    />);
    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Decline" }) as HTMLButtonElement).disabled).toBe(true);
    offline.unmount();

    const expired = render(<DirectMessagesPanel
      {...baseProps()}
      travelEntries={[{ ...travel("pending"), expiresAt: "2020-01-01T00:00:00.000Z" }]}
      onAcceptTravelInvite={vi.fn(() => true)}
      onDeclineTravelInvite={vi.fn(() => true)}
    />);
    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Decline" }) as HTMLButtonElement).disabled).toBe(true);
    expired.unmount();

    render(<DirectMessagesPanel {...baseProps()} travelEntries={[travel("accepted")]} />);
    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  it("keeps category badge totals stable without player-search controls", () => {
    render(<DirectMessagesPanel
      {...baseProps()}
      travelEntries={[travel("pending"), travel("accepted", "travel-history")]}
      partyInvites={[party()]}
      partyPlayerNames={{ inviter: "Party Leader" }}
      kingdomInvitations={[kingdom()]}
      ownPlayerId="self"
    />);
    expect(screen.getByRole("tab", { name: /Requests/ }).textContent).toContain("3");
    expect(screen.getByRole("tab", { name: /Notifications/ }).textContent).toContain("1");
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("highlights the active tab and distinguishes unread rows from read rows", () => {
    const props = baseProps();
    render(<DirectMessagesPanel
      {...props}
      snapshot={{
        ...props.snapshot,
        conversations: [directConversation("peer-a", 2), directConversation("peer-b", 0)],
        totalUnreadCount: 2
      }}
    />);

    const personalTab = screen.getByRole("tab", { name: /Personal/ });
    expect(personalTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "Inbox" })).toBeNull();
    expect(screen.getByText("Peer A").closest("button")?.classList.contains("unread")).toBe(true);
    expect(screen.getByText("Peer B").closest("button")?.classList.contains("read")).toBe(true);
  });

  it("shows personal message dates and times without repeating the active category", () => {
    const props = baseProps();
    const conversation = directConversation("peer-a", 0);
    render(<DirectMessagesPanel
      {...props}
      snapshot={{
        ...props.snapshot,
        conversations: [conversation]
      }}
    />);

    const row = screen.getByText("Peer A").closest("button")!;
    expect(within(row).queryByText("Personal Message")).toBeNull();
    expect(row.querySelector("time")?.textContent).toBe(
      new Date(conversation.latestMessage!.createdAt).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      })
    );
  });

  it("marks the full active category read rather than only search results", async () => {
    const onReadDirectMessages = vi.fn(() => Promise.resolve(true));
    const onMarkInboxRead = vi.fn(() => Promise.resolve(true));
    const props = baseProps();
    render(<DirectMessagesPanel
      {...props}
      snapshot={{
        ...props.snapshot,
        conversations: [directConversation("peer-a", 3), directConversation("peer-b", 2)],
        totalUnreadCount: 5
      }}
      travelEntries={[
        travel("pending"),
        travel("accepted", "travel-history"),
        travel("declined", "travel-declined")
      ]}
      onReadDirectMessages={onReadDirectMessages}
      onMarkInboxRead={onMarkInboxRead}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Personal/ }));
    fireEvent.click(screen.getByRole("button", { name: "Read All Personal" }));
    await waitFor(() => expect(onReadDirectMessages).toHaveBeenCalledWith([
      { conversationId: "conversation:peer-a", throughSequence: "3" },
      { conversationId: "conversation:peer-b", throughSequence: "2" }
    ]));

    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    fireEvent.click(screen.getByRole("button", { name: "Read All Invites" }));
    await waitFor(() => expect(onMarkInboxRead).toHaveBeenCalledWith([
      { entryKey: "travel:travel-entry", revision: "2099-01-01T00:00:00.000Z" }
    ]));
    expect(screen.getByText("Pending")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    fireEvent.click(screen.getByRole("button", { name: "Read All Notifications" }));
    await waitFor(() => expect(onMarkInboxRead).toHaveBeenLastCalledWith([
      { entryKey: "travel:travel-history", revision: "2026-01-01T01:00:00.000Z" },
      { entryKey: "travel:travel-declined", revision: "2026-01-01T01:00:00.000Z" }
    ]));
    expect(screen.getByText("Declined")).toBeTruthy();
  });

  it("keeps decline enabled when accept is ineligible and reports action failure without removing the row", async () => {
    const onRespondKingdomInvitation = vi.fn(() => Promise.resolve(true));
    const onAcceptPartyInvite = vi.fn(() => Promise.reject(new Error("The party is full.")));
    render(<DirectMessagesPanel
      {...baseProps()}
      partyInvites={[party()]}
      partyPlayerNames={{ inviter: "Party Leader" }}
      kingdomInvitations={[kingdom()]}
      ownPlayerId="self"
      hasKingdomMembership
      onRespondKingdomInvitation={onRespondKingdomInvitation}
      onAcceptPartyInvite={onAcceptPartyInvite}
    />);

    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    const kingdomCard = screen.getByText("Kingdom Invitation").closest("article")!;
    expect((within(kingdomCard).getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(kingdomCard).getByRole("button", { name: "Decline" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(kingdomCard).getByRole("button", { name: "Decline" }));
    expect(onRespondKingdomInvitation).toHaveBeenCalledOnce();

    const partyCard = screen.getByText("Party Invitation").closest("article")!;
    const accept = within(partyCard).getByRole("button", { name: "Accept" });
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(onAcceptPartyInvite).toHaveBeenCalledOnce();
    await waitFor(() => expect(within(partyCard).getByRole("status").textContent).toContain("The party is full."));
    expect(within(partyCard).getByText("Pending")).toBeTruthy();
  });

  it("calls outgoing travel, party, and kingdom cancellation exactly once", () => {
    const onCancelTravelInvite = vi.fn(() => true);
    const onCancelPartyInvite = vi.fn(() => true);
    const onCancelKingdomInvitation = vi.fn(() => true);
    render(<DirectMessagesPanel
      {...baseProps()}
      travelEntries={[{ ...travel("pending"), perspective: "sender" }]}
      partyInvites={[{ ...party(), perspective: "outgoing" }]}
      partyPlayerNames={{ self: "Target Player" }}
      kingdomInvitations={[{ ...kingdom(), targetPlayerId: "target", invitedByPlayerId: "self" }]}
      ownPlayerId="self"
      onCancelTravelInvite={onCancelTravelInvite}
      onCancelPartyInvite={onCancelPartyInvite}
      onCancelKingdomInvitation={onCancelKingdomInvitation}
    />);
    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    for (const button of screen.getAllByRole("button", { name: "Cancel" })) {
      fireEvent.pointerDown(button);
      fireEvent.click(button);
    }
    expect(onCancelTravelInvite).toHaveBeenCalledOnce();
    expect(onCancelPartyInvite).toHaveBeenCalledOnce();
    expect(onCancelKingdomInvitation).toHaveBeenCalledOnce();
  });

  it("category Read All clears non-DM badges while retaining their rows", async () => {
    function Harness(): React.JSX.Element {
      const [readReceipts, setReadReceipts] = useState<Readonly<Record<string, string>>>({});
      return <DirectMessagesPanel
        {...baseProps()}
        travelEntries={[travel("pending"), travel("accepted", "travel-history")]}
        readReceipts={readReceipts}
        onMarkInboxRead={async (entries) => {
          setReadReceipts((current) => ({
            ...current,
            ...Object.fromEntries(entries.map(({ entryKey, revision }) => [entryKey, revision]))
          }));
          return true;
        }}
      />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: /Requests/ }));
    expect(screen.getByRole("tab", { name: /Requests/ }).textContent).toContain("1");
    fireEvent.click(screen.getByRole("button", { name: "Read All Invites" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Requests" }).textContent).toBe("Requests"));
    expect(screen.getByText("Travel Invitation")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Notifications/ }));
    expect(screen.getByRole("tab", { name: /Notifications/ }).textContent).toContain("1");
    fireEvent.click(screen.getByRole("button", { name: "Read All Notifications" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Notifications" }).textContent).toBe("Notifications"));
    expect(screen.getByText("Travel Invitation · Traveler")).toBeTruthy();
  });
});

function baseProps(): DirectMessagesPanelProps {
  const store = new DirectMessageStore({ ownPlayerId: "self" });
  return {
    open: true,
    minimized: false,
    layout: "phone",
    snapshot: store.getSnapshot(),
    connectionStatus: "online",
    onClose: vi.fn(),
    onReturnToGame: vi.fn(),
    onMinimizedChange: vi.fn(),
    onSelectPeer: vi.fn(),
    onSend: vi.fn(() => true),
    onRetry: vi.fn(),
    onLoadOlder: vi.fn()
  };
}

function ControlledDirectMessagesPanel(props: DirectMessagesPanelProps): React.JSX.Element {
  const [selectedNotificationKey, setSelectedNotificationKey] = useState<string | null>(null);
  return <DirectMessagesPanel
    {...props}
    selectedNotificationKey={selectedNotificationKey}
    onSelectNotification={setSelectedNotificationKey}
  />;
}

function travel(status: TravelInboxEntry["status"], entryId = "travel-entry"): TravelInboxEntry {
  return {
    entryId,
    inviteId: "travel-invite",
    perspective: "recipient",
    counterpartPlayerId: "traveler",
    counterpartName: "Traveler",
    message: "Travel to the active flag.",
    status,
    invalidationReason: null,
    sourceType: "flag",
    sourceId: "flag-1",
    createdAt: status === "pending" ? "2099-01-01T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-02T00:00:00.000Z",
    respondedAt: status === "pending" ? null : "2026-01-01T01:00:00.000Z"
  };
}

function playerPackage(): PlayerPackageSnapshot {
  return {
    packageId: "00000000-0000-4000-8000-000000000099",
    campaignId: "00000000-0000-4000-8000-000000000098",
    title: "Founder supplies",
    message: "Welcome to Ash Atlas.",
    sender: "Ash Atlas",
    kind: "admin",
    senderPlayerId: null,
    status: "unopened",
    readAt: null,
    firstClaimedAt: null,
    claimedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    revision: "1",
    items: [{
      lineNumber: 1,
      itemKind: "resource",
      itemId: "wood",
      variant: "default",
      displayName: "Wood",
      iconKey: "wood",
      category: "resource",
      originalQuantity: 250,
      remainingQuantity: 250
    }]
  };
}

function party(): PartyInviteSnapshot {
  return {
    invitationId: "00000000-0000-4000-8000-000000000001",
    partyId: "party-1",
    leaderPlayerId: "leader",
    inviterPlayerId: "inviter",
    targetPlayerId: "self",
    perspective: "incoming",
    status: "pending",
    createdAt: "2099-01-01T00:00:00.000Z",
    expiresAt: "2099-01-03T00:00:00.000Z",
    respondedAt: null,
    updatedAt: "2099-01-01T00:00:00.000Z"
  };
}

function kingdom(): KingdomInvitationSnapshot {
  return {
    id: "kingdom-invite",
    kingdomId: "kingdom-1",
    kingdomName: "Atlas Wardens",
    targetPlayerId: "self",
    targetDisplayName: "Player",
    invitedByPlayerId: "warden",
    status: "pending",
    createdAt: "2099-01-01T02:00:00.000Z",
    expiresAt: "2099-01-04T00:00:00.000Z"
  };
}

function directConversation(peerId: string, unreadCount: number): DirectConversationView {
  return {
    conversationId: `conversation:${peerId}`,
    peer: { playerId: peerId, displayName: peerId === "peer-a" ? "Peer A" : "Peer B", online: true },
    latestMessage: {
      body: `Message from ${peerId}`,
      senderPlayerId: peerId,
      sequence: String(unreadCount),
      createdAt: "2099-01-01T03:00:00.000Z"
    },
    latestSequence: String(unreadCount),
    unreadCount,
    muted: false,
    blocked: false,
    canMessage: true,
    hasOlderMessages: false,
    lastReadSequence: "0",
    deliveredThroughSequence: String(unreadCount),
    peerReadThroughSequence: "0",
    transient: false,
    updatedAt: "2099-01-01T03:00:00.000Z"
  };
}
