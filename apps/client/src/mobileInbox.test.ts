import type {
  GameInboxNotice,
  KingdomInvitationSnapshot,
  PartyInviteSnapshot,
  PlayerPackageSnapshot,
  TravelInboxEntry
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import type { DirectConversationView } from "./directMessages/directMessageStore.js";
import {
  buildMobileInboxEntries,
  classifyMobileInboxEntry,
  summarizeMobileInboxUnread
} from "./mobileInbox.js";

const NOW = Date.parse("2026-07-22T18:00:00.000Z");

describe("mobile inbox classification", () => {
  it("uses consistent quiet copy for a conversation without messages", () => {
    const entry = classifyMobileInboxEntry({
      kind: "direct_message",
      conversation: { ...conversation(), latestMessage: null }
    }, NOW);

    expect(entry.message).toBe("No messages yet");
  });

  it("deduplicates durable social entries and keeps only pending friends in Requests", () => {
    const request = socialEntry("friend_request", "pending", "00000000-0000-4000-8000-000000000001");
    const enemy = socialEntry("enemy_declaration", "notice", "00000000-0000-4000-8000-000000000002");
    const entries = buildMobileInboxEntries({
      conversations: [],
      travelEntries: [],
      partyInvites: [],
      partyPlayerNames: {},
      kingdomInvitations: [],
      socialEntries: [request, request, enemy],
      ownPlayerId: "self",
      hasKingdomMembership: false
    });
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.key.endsWith(request.id))).toMatchObject({
      category: "invites",
      message: "Player A wants to be your friend.",
      canAccept: true,
      canDecline: true
    });
    expect(entries.find((entry) => entry.key.endsWith(enemy.id))).toMatchObject({
      category: "notifications",
      message: "Player A has declared you an enemy.",
      canAccept: false
    });
  });
  it("maps every authoritative source into one deduplicated attention-first Inbox list", () => {
    const travel = travelEntry("travel-entry", "pending");
    const entries = buildMobileInboxEntries({
      conversations: [conversation()],
      travelEntries: [travel, travel],
      partyInvites: [partyInvite()],
      partyPlayerNames: { inviter: "Party Leader" },
      kingdomInvitations: [kingdomInvite("pending")],
      ownPlayerId: "self",
      hasKingdomMembership: false
    }, NOW);

    expect(entries.map(({ key }) => key)).toEqual([
      "party:00000000-0000-4000-8000-000000000001",
      "kingdom:kingdom-invite",
      "travel:travel-entry",
      "personal:peer"
    ]);
    expect(entries.filter(({ category }) => category === "personal")).toHaveLength(1);
    expect(entries.filter(({ category }) => category === "invites")).toHaveLength(3);
    expect(entries.reduce((total, entry) => total + entry.unreadCount, 0)).toBe(5);
  });

  it("keeps kingdom administration rows out of the participant inbox", () => {
    const incoming = kingdomInvite("pending");
    const outgoing = {
      ...kingdomInvite("pending"),
      id: "kingdom-outgoing",
      targetPlayerId: "target",
      targetDisplayName: "Target",
      invitedByPlayerId: "self"
    };
    const unrelated = {
      ...kingdomInvite("pending"),
      id: "kingdom-admin-only",
      targetPlayerId: "another-target",
      targetDisplayName: "Another Target",
      invitedByPlayerId: "another-officer"
    };
    const entries = buildMobileInboxEntries({
      conversations: [],
      travelEntries: [],
      partyInvites: [],
      partyPlayerNames: {},
      kingdomInvitations: [incoming, outgoing, unrelated],
      ownPlayerId: "self",
      hasKingdomMembership: true
    }, NOW);

    expect(entries.map(({ key }) => key).sort()).toEqual([
      "kingdom:kingdom-invite",
      "kingdom:kingdom-outgoing"
    ]);
    expect(entries.find(({ key }) => key === "kingdom:kingdom-outgoing")).toMatchObject({
      label: "Kingdom Invitation Sent",
      canCancel: true
    });
  });

  it("moves all completed request receipts to Notifications", () => {
    const accepted = classifyMobileInboxEntry({ kind: "travel_invite", entry: travelEntry("accepted", "accepted") }, NOW);
    const expiredParty = classifyMobileInboxEntry({
      kind: "party_invite",
      invite: { ...partyInvite(), expiresAt: "2026-07-21T18:00:00.000Z" },
      inviterName: "Party Leader"
    }, NOW);
    const declinedKingdom = classifyMobileInboxEntry({
      kind: "kingdom_invite",
      invitation: kingdomInvite("declined"),
      ownPlayerId: "self",
      hasMembership: false
    }, NOW);

    expect([accepted, expiredParty, declinedKingdom].map(({ category }) => category)).toEqual([
      "notifications", "notifications", "notifications"
    ]);
    expect([accepted, expiredParty, declinedKingdom].map((entry) =>
      entry.canAccept || entry.canDecline || entry.canCancel
    )).toEqual([false, false, false]);
    expect([accepted.state, expiredParty.state, declinedKingdom.state]).toEqual(["accepted", "expired", "declined"]);
  });

  it("moves accepted travel, party, and Kingdom receipts to Notifications", () => {
    const acceptedParty = classifyMobileInboxEntry({
      kind: "party_invite",
      invite: {
        ...partyInvite(),
        status: "accepted",
        respondedAt: "2026-07-22T17:45:00.000Z",
        updatedAt: "2026-07-22T17:45:00.000Z"
      },
      inviterName: "Party Leader"
    }, NOW);
    const acceptedKingdom = classifyMobileInboxEntry({
      kind: "kingdom_invite",
      invitation: kingdomInvite("accepted"),
      ownPlayerId: "self",
      hasMembership: true
    }, NOW);
    const acceptedTravel = classifyMobileInboxEntry({
      kind: "travel_invite",
      entry: travelEntry("accepted-travel", "accepted")
    }, NOW);

    expect([acceptedTravel, acceptedParty, acceptedKingdom].map(({ category }) => category))
      .toEqual(["notifications", "notifications", "notifications"]);
    expect([acceptedTravel, acceptedParty, acceptedKingdom].every((entry) =>
      !entry.canAccept && !entry.canDecline && !entry.canCancel
    )).toBe(true);
  });

  it("keeps pending incoming travel acceptance eligible from invite authority", () => {
    const pending = classifyMobileInboxEntry({
      kind: "travel_invite",
      entry: travelEntry("pending-invite", "pending")
    }, NOW);

    expect(pending.canAccept).toBe(true);
    expect(pending.acceptDisabledReason).toBeNull();
  });

  it("labels an invite invalidated by inviter movement as canceled", () => {
    const invalidated = classifyMobileInboxEntry({
      kind: "travel_invite",
      entry: {
        ...travelEntry("moved-invite", "invalidated"),
        invalidationReason: "The inviter relocated to another gameplay layer."
      }
    }, NOW);

    expect(invalidated.category).toBe("notifications");
    expect(invalidated.state).toBe("cancelled");
    expect(invalidated.stateLabel).toBe("Invite canceled");
  });

  it("keeps unknown future events visible in Notifications and All", () => {
    const unknown = classifyMobileInboxEntry({
      kind: "unknown",
      eventKind: "Future World Event",
      id: "future-1",
      createdAt: "2026-07-22T17:00:00.000Z",
      message: "Something new happened."
    }, NOW);
    expect(unknown.category).toBe("notifications");
    expect(unknown.label).toBe("Future World Event");
    expect(unknown.message).toBe("Something new happened.");
  });

  it("classifies a legendary bird notice as unread until its exact snapshot is read", () => {
    const notice: GameInboxNotice = {
      eventKind: "legendary_bird_event",
      eventId: "00000000-0000-4000-8000-000000000099",
      message: "An Ice Phoenix is attacking your flag! The flag is around 412 meters northeast of Nearmere!",
      createdAt: "2026-07-22T17:15:00.000Z"
    };
    const key = `game:${notice.eventKind}:${notice.eventId}`;
    const unread = buildMobileInboxEntries({
      conversations: [],
      travelEntries: [],
      partyInvites: [],
      partyPlayerNames: {},
      kingdomInvitations: [],
      gameNotices: [notice, notice],
      ownPlayerId: "self",
      hasKingdomMembership: false
    }, NOW);

    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({
      key,
      revision: notice.createdAt,
      category: "notifications",
      label: "Legendary Bird Event",
      source: "Ash Atlas",
      message: notice.message,
      state: "unread",
      unreadCount: 1
    });
    expect(classifyMobileInboxEntry(
      { kind: "game_notice", notice },
      NOW,
      { [key]: notice.createdAt }
    )).toMatchObject({ state: "read", unreadCount: 0 });
  });

  it("counts unread content rather than rows and sums unread DM messages", () => {
    const acceptedTravel = travelEntry("travel-history", "accepted");
    const declinedKingdom = kingdomInvite("declined");
    const entries = buildMobileInboxEntries({
      conversations: [conversation("peer", 2), conversation("quiet-peer", 0)],
      travelEntries: [travelEntry("travel-pending", "pending"), acceptedTravel],
      partyInvites: [partyInvite()],
      partyPlayerNames: { inviter: "Party Leader" },
      kingdomInvitations: [declinedKingdom],
      ownPlayerId: "self",
      hasKingdomMembership: false,
      readReceipts: {
        "travel:travel-history": acceptedTravel.updatedAt!,
        "kingdom:kingdom-invite": declinedKingdom.respondedAt!
      }
    }, NOW);

    expect(entries).toHaveLength(6);
    expect(summarizeMobileInboxUnread(entries)).toEqual({
      all: 4,
      personal: 2,
      invites: 2,
      notifications: 0
    });
  });

  it("treats a terminal revision as new for the counterpart and read for the actor", () => {
    const pending = travelEntry("travel-revision", "pending");
    const pendingKey = "travel:travel-revision";
    const pendingRevision = pending.updatedAt!;
    const readPending = classifyMobileInboxEntry(
      { kind: "travel_invite", entry: pending },
      NOW,
      { [pendingKey]: pendingRevision }
    );
    expect(readPending.unreadCount).toBe(0);

    const cancelled = {
      ...pending,
      status: "cancelled" as const,
      respondedAt: "2026-07-22T17:00:00.000Z",
      updatedAt: "2026-07-22T17:00:00.000Z"
    };
    expect(classifyMobileInboxEntry(
      { kind: "travel_invite", entry: cancelled },
      NOW,
      { [pendingKey]: pendingRevision }
    ).unreadCount).toBe(1);
    expect(classifyMobileInboxEntry(
      { kind: "travel_invite", entry: cancelled },
      NOW,
      { [pendingKey]: cancelled.updatedAt }
    ).unreadCount).toBe(0);
  });

  it.each([
    ["new unopened package", packageSnapshot(), {}, 1],
    ["receipt at the current revision", packageSnapshot(), { "package:package-one": "1" }, 0],
    ["durable package read time", packageSnapshot({ readAt: "2026-07-22T17:00:00.000Z" }), {}, 0],
    ["partial claim with an older receipt", packageSnapshot({ status: "partial", revision: "2" }), { "package:package-one": "1" }, 0],
    ["partial claim with a durable read time", packageSnapshot({ status: "partial", revision: "2", readAt: "2026-07-22T17:00:00.000Z" }), {}, 0],
    ["completed claim with an older receipt", packageSnapshot({ status: "claimed", revision: "3" }), { "package:package-one": "2" }, 0]
  ] as const)("classifies %s without tying package read state to claim revisions", (
    _label,
    playerPackage,
    readReceipts,
    expectedUnread
  ) => {
    const entry = classifyMobileInboxEntry(
      { kind: "player_package", package: playerPackage },
      NOW,
      readReceipts
    );
    expect(entry.unreadCount).toBe(expectedUnread);
    expect(entry.revision).toBe(playerPackage.revision);
  });
});

function socialEntry(
  kind: "friend_request" | "enemy_declaration",
  state: "pending" | "notice",
  id: string
) {
  return {
    id,
    kind,
    actorPlayerId: "player-a",
    actorDisplayName: "Player A",
    state,
    createdAt: "2026-07-22T18:00:00.000Z",
    updatedAt: "2026-07-22T18:00:00.000Z"
  } as const;
}

function conversation(peerId = "peer", unreadCount = 2): DirectConversationView {
  return {
    conversationId: `conversation:${peerId}`,
    peer: { playerId: peerId, displayName: peerId === "peer" ? "Courier" : "Quiet Courier", online: true },
    latestMessage: { body: "Meet me at the flag.", senderPlayerId: peerId, sequence: "2", createdAt: "2026-07-22T14:00:00.000Z" },
    latestSequence: "2",
    unreadCount,
    muted: false,
    blocked: false,
    canMessage: true,
    hasOlderMessages: false,
    lastReadSequence: "0",
    deliveredThroughSequence: "2",
    peerReadThroughSequence: "0",
    transient: false,
    updatedAt: "2026-07-22T14:00:00.000Z"
  };
}

function packageSnapshot(
  overrides: Partial<PlayerPackageSnapshot> = {}
): PlayerPackageSnapshot {
  return {
    packageId: "package-one",
    campaignId: "campaign-one",
    title: "Founder supplies",
    message: "Welcome.",
    sender: "Ash Atlas",
    kind: "admin",
    senderPlayerId: null,
    status: "unopened",
    readAt: null,
    firstClaimedAt: null,
    claimedAt: null,
    createdAt: "2026-07-22T16:30:00.000Z",
    revision: "1",
    items: [],
    ...overrides
  };
}

function travelEntry(entryId: string, status: TravelInboxEntry["status"]): TravelInboxEntry {
  return {
    entryId,
    inviteId: "travel-invite",
    perspective: "recipient",
    counterpartPlayerId: "traveler",
    counterpartName: "Traveler",
    message: "Travel to Traveler's flag.",
    status,
    invalidationReason: null,
    sourceType: "flag",
    sourceId: "flag-1",
    createdAt: "2026-07-22T16:00:00.000Z",
    expiresAt: "2026-07-23T18:00:00.000Z",
    respondedAt: status === "pending" ? null : "2026-07-22T17:00:00.000Z",
    updatedAt: status === "pending" ? "2026-07-22T16:00:00.000Z" : "2026-07-22T17:00:00.000Z"
  };
}

function partyInvite(): PartyInviteSnapshot {
  return {
    invitationId: "00000000-0000-4000-8000-000000000001",
    partyId: "party-1",
    leaderPlayerId: "leader",
    inviterPlayerId: "inviter",
    targetPlayerId: "self",
    perspective: "incoming",
    status: "pending",
    createdAt: "2026-07-22T17:30:00.000Z",
    expiresAt: "2026-07-23T17:00:00.000Z",
    respondedAt: null,
    updatedAt: "2026-07-22T17:30:00.000Z"
  };
}

function kingdomInvite(status: KingdomInvitationSnapshot["status"]): KingdomInvitationSnapshot {
  return {
    id: "kingdom-invite",
    kingdomId: "kingdom-1",
    kingdomName: "Atlas Wardens",
    targetPlayerId: "self",
    targetDisplayName: "Player",
    invitedByPlayerId: "warden",
    status,
    createdAt: "2026-07-22T17:00:00.000Z",
    expiresAt: "2026-07-23T18:00:00.000Z",
    respondedAt: status === "pending" ? null : "2026-07-22T17:30:00.000Z"
  };
}
