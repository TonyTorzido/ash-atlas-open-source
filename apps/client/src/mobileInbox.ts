import {
  gameInboxEntryKey,
  type GameInboxNotice,
  type KingdomInvitationSnapshot,
  type PartyInviteSnapshot,
  type PlayerPackageSnapshot,
  type SocialInboxEntry,
  type TravelInboxEntry
} from "@ash-atlas/shared";

import type { DirectConversationView } from "./directMessages/directMessageStore.js";

export type MobileInboxCategory = "personal" | "invites" | "notifications";
export type MobileInboxState =
  | "unread"
  | "active"
  | "read"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired"
  | "completed";

export type MobileInboxSource =
  | { kind: "direct_message"; conversation: DirectConversationView }
  | { kind: "travel_invite"; entry: TravelInboxEntry }
  | { kind: "party_invite"; invite: PartyInviteSnapshot; inviterName: string }
  | { kind: "kingdom_invite"; invitation: KingdomInvitationSnapshot; ownPlayerId: string; hasMembership: boolean }
  | { kind: "player_package"; package: PlayerPackageSnapshot }
  | { kind: "social"; entry: SocialInboxEntry }
  | { kind: "game_notice"; notice: GameInboxNotice }
  | { kind: "unknown"; eventKind: string; id: string; createdAt: string; message: string; source?: string };

export type MobileInboxEntry = Readonly<{
  key: string;
  revision: string;
  category: MobileInboxCategory;
  label: string;
  source: string;
  message: string;
  createdAt: string;
  activityAt: string;
  expiresAt: string | null;
  state: MobileInboxState;
  stateLabel: string;
  unreadCount: number;
  canAccept: boolean;
  acceptDisabledReason: string | null;
  canDecline: boolean;
  declineDisabledReason: string | null;
  canCancel: boolean;
  cancelDisabledReason: string | null;
  variant: "personal" | "invitation" | "request" | "notice";
  sourceEntry: MobileInboxSource;
}>;

export type MobileInboxSources = Readonly<{
  conversations: readonly DirectConversationView[];
  travelEntries: readonly TravelInboxEntry[];
  partyInvites: readonly PartyInviteSnapshot[];
  partyPlayerNames: Readonly<Record<string, string>>;
  kingdomInvitations: readonly KingdomInvitationSnapshot[];
  playerPackages?: readonly PlayerPackageSnapshot[];
  socialEntries?: readonly SocialInboxEntry[];
  gameNotices?: readonly GameInboxNotice[];
  ownPlayerId: string;
  hasKingdomMembership: boolean;
  readReceipts?: Readonly<Record<string, string>>;
}>;

export function buildMobileInboxEntries(sources: MobileInboxSources, now = Date.now()): MobileInboxEntry[] {
  const readReceipts = sources.readReceipts ?? {};
  const entries = [
    ...sources.conversations.map((conversation) => classifyMobileInboxEntry({ kind: "direct_message", conversation }, now, readReceipts)),
    ...sources.travelEntries.map((entry) => classifyMobileInboxEntry({ kind: "travel_invite", entry }, now, readReceipts)),
    ...sources.partyInvites.map((invite) => classifyMobileInboxEntry({
      kind: "party_invite",
      invite,
      inviterName: sources.partyPlayerNames[
        invite.perspective === "incoming" ? invite.inviterPlayerId : invite.targetPlayerId
      ] ?? "Another player"
    }, now, readReceipts)),
    ...sources.kingdomInvitations
      .filter((invitation) =>
        invitation.targetPlayerId === sources.ownPlayerId ||
        invitation.invitedByPlayerId === sources.ownPlayerId
      )
      .map((invitation) => classifyMobileInboxEntry({
        kind: "kingdom_invite",
        invitation,
        ownPlayerId: sources.ownPlayerId,
        hasMembership: sources.hasKingdomMembership
      }, now, readReceipts)),
    ...(sources.playerPackages ?? []).map((playerPackage) =>
      classifyMobileInboxEntry({ kind: "player_package", package: playerPackage }, now, readReceipts)
    ),
    ...(sources.socialEntries ?? []).map((entry) =>
      classifyMobileInboxEntry({ kind: "social", entry }, now, readReceipts)
    ),
    ...(sources.gameNotices ?? []).map((notice) =>
      classifyMobileInboxEntry({ kind: "game_notice", notice }, now, readReceipts)
    )
  ];
  const unique = new Map<string, MobileInboxEntry>();
  for (const entry of entries) if (!unique.has(entry.key)) unique.set(entry.key, entry);
  return [...unique.values()].sort((left, right) => {
    const priorityDifference = inboxPriority(left) - inboxPriority(right);
    return priorityDifference !== 0
      ? priorityDifference
      : timestamp(right.activityAt) - timestamp(left.activityAt);
  });
}

export function classifyMobileInboxEntry(
  source: MobileInboxSource,
  now = Date.now(),
  readReceipts: Readonly<Record<string, string>> = {}
): MobileInboxEntry {
  switch (source.kind) {
    case "direct_message": {
      const { conversation } = source;
      const unread = Math.max(0, conversation.unreadCount);
      return {
        key: `personal:${conversation.peer.playerId}`,
        revision: conversation.latestSequence,
        category: "personal",
        label: "Personal Message",
        source: conversation.peer.displayName,
        message: conversation.latestMessage?.body ?? "No messages yet",
        createdAt: conversation.latestMessage?.createdAt ?? conversation.updatedAt,
        activityAt: conversation.latestMessage?.createdAt ?? conversation.updatedAt,
        expiresAt: null,
        state: unread > 0 ? "unread" : "read",
        stateLabel: unread > 0 ? `${unread} unread` : "Read",
        unreadCount: unread,
        canAccept: false,
        acceptDisabledReason: null,
        canDecline: false,
        declineDisabledReason: null,
        canCancel: false,
        cancelDisabledReason: null,
        variant: "personal",
        sourceEntry: source
      };
    }
    case "travel_invite": {
      const { entry } = source;
      const expired = entry.status === "pending" && timestamp(entry.expiresAt) <= now;
      const active = entry.status === "pending" && !expired;
      const state = expired ? "expired" : travelState(entry.status);
      const cancelled = entry.status === "cancelled" || entry.status === "invalidated";
      const incoming = entry.perspective === "recipient";
      const key = `travel:${entry.entryId}`;
      const revision = entry.updatedAt ?? entry.respondedAt ?? entry.createdAt;
      const unread = readReceipts[key] === revision ? 0 : 1;
      const acceptReason = !active
        ? "This invitation is no longer pending."
        : null;
      return {
        key,
        revision,
        category: active ? "invites" : "notifications",
        label: incoming ? "Travel Invitation" : "Travel Invitation Sent",
        source: entry.counterpartName,
        message: entry.message,
        createdAt: entry.createdAt,
        activityAt: revision,
        expiresAt: entry.expiresAt,
        state,
        stateLabel: cancelled ? "Invite canceled" : stateLabel(state),
        unreadCount: unread,
        canAccept: incoming && active && acceptReason === null,
        acceptDisabledReason: incoming ? acceptReason : null,
        canDecline: incoming && active,
        declineDisabledReason: incoming && !active ? "This invitation is no longer pending." : null,
        canCancel: !incoming && active,
        cancelDisabledReason: !incoming && !active ? "This invitation is no longer pending." : null,
        variant: "invitation",
        sourceEntry: source
      };
    }
    case "party_invite": {
      const expired = source.invite.status === "pending" && timestamp(source.invite.expiresAt) <= now;
      const active = source.invite.status === "pending" && !expired;
      const incoming = source.invite.perspective === "incoming";
      const key = `party:${source.invite.invitationId}`;
      const revision = source.invite.updatedAt;
      const unread = readReceipts[key] === revision ? 0 : 1;
      const state = expired ? "expired" : partyState(source.invite.status);
      return {
        key,
        revision,
        category: active ? "invites" : "notifications",
        label: incoming ? "Party Invitation" : "Party Invitation Sent",
        source: source.inviterName,
        message: incoming ? "You were invited to join a party." : "You invited this player to your party.",
        createdAt: source.invite.createdAt,
        activityAt: revision,
        expiresAt: source.invite.expiresAt,
        state,
        stateLabel: stateLabel(state),
        unreadCount: unread,
        canAccept: incoming && active,
        acceptDisabledReason: incoming && !active ? "This invitation is no longer pending." : null,
        canDecline: incoming && active,
        declineDisabledReason: incoming && !active ? "This invitation is no longer pending." : null,
        canCancel: !incoming && active,
        cancelDisabledReason: !incoming && !active ? "This invitation is no longer pending." : null,
        variant: "invitation",
        sourceEntry: source
      };
    }
    case "kingdom_invite": {
      const { invitation } = source;
      const expired = invitation.status === "pending" && timestamp(invitation.expiresAt) <= now;
      const active = invitation.status === "pending" && !expired;
      const incoming = invitation.targetPlayerId === source.ownPlayerId;
      const outgoing = invitation.invitedByPlayerId === source.ownPlayerId;
      const state = expired ? "expired" : kingdomState(invitation.status);
      const key = `kingdom:${invitation.id}`;
      const revision = invitation.respondedAt ?? invitation.createdAt;
      const unread = readReceipts[key] === revision ? 0 : 1;
      const acceptReason = !active
        ? "This invitation is no longer pending."
        : source.hasMembership
          ? "Leave your current Kingdom before accepting another invitation."
          : null;
      return {
        key,
        revision,
        category: active ? "invites" : "notifications",
        label: incoming ? "Kingdom Invitation" : "Kingdom Invitation Sent",
        source: incoming ? invitation.kingdomName : invitation.targetDisplayName,
        message: incoming
          ? `Join ${invitation.kingdomName}.`
          : `${invitation.targetDisplayName} was invited to ${invitation.kingdomName}.`,
        createdAt: invitation.createdAt,
        activityAt: revision,
        expiresAt: invitation.expiresAt,
        state,
        stateLabel: stateLabel(state),
        unreadCount: unread,
        canAccept: incoming && active && acceptReason === null,
        acceptDisabledReason: incoming ? acceptReason : null,
        canDecline: incoming && active,
        declineDisabledReason: incoming && !active ? "This invitation is no longer pending." : null,
        canCancel: outgoing && active,
        cancelDisabledReason: outgoing && !active ? "This invitation is no longer pending." : null,
        variant: "invitation",
        sourceEntry: source
      };
    }
    case "player_package": {
      const playerPackage = source.package;
      const key = `package:${playerPackage.packageId}`;
      const unread = playerPackage.readAt !== null
        || Object.prototype.hasOwnProperty.call(readReceipts, key)
        ? 0
        : 1;
      return {
        key,
        revision: playerPackage.revision,
        category: "notifications",
        label: playerPackage.title,
        source: playerPackage.sender,
        message: playerPackage.message,
        createdAt: playerPackage.createdAt,
        activityAt: playerPackage.createdAt,
        expiresAt: null,
        state: playerPackage.status === "claimed" ? "completed" : "active",
        stateLabel: playerPackage.status === "claimed"
          ? "Claimed"
          : playerPackage.status === "partial"
            ? "Partially opened"
            : "Unopened",
        unreadCount: unread,
        canAccept: playerPackage.status !== "claimed",
        acceptDisabledReason: playerPackage.status === "claimed" ? playerPackage.kind === "player_gift" ? "This gift is fully claimed." : "This package is fully claimed." : null,
        canDecline: false,
        declineDisabledReason: null,
        canCancel: false,
        cancelDisabledReason: null,
        variant: "notice",
        sourceEntry: source
      };
    }
    case "social": {
      const { entry } = source;
      const key = `social:${entry.id}`;
      const unread = readReceipts[key] === entry.updatedAt ? 0 : 1;
      const friendRequest = entry.kind === "friend_request";
      const state = entry.state === "pending"
        ? "active"
        : entry.state === "notice"
          ? "unread"
          : entry.state;
      return {
        key,
        revision: entry.updatedAt,
        category: friendRequest && entry.state === "pending" ? "invites" : "notifications",
        label: friendRequest ? "Friendship Request" : "Enemy Declaration",
        source: entry.actorDisplayName,
        message: friendRequest
          ? `${entry.actorDisplayName} wants to be your friend.`
          : `${entry.actorDisplayName} has declared you an enemy.`,
        createdAt: entry.createdAt,
        activityAt: entry.updatedAt,
        expiresAt: null,
        state,
        stateLabel: entry.state === "notice" ? "Notice" : stateLabel(state),
        unreadCount: unread,
        canAccept: friendRequest && entry.state === "pending",
        acceptDisabledReason: friendRequest && entry.state !== "pending"
          ? "This friendship request is no longer pending."
          : null,
        canDecline: friendRequest && entry.state === "pending",
        declineDisabledReason: friendRequest && entry.state !== "pending"
          ? "This friendship request is no longer pending."
          : null,
        canCancel: false,
        cancelDisabledReason: null,
        variant: friendRequest ? "request" : "notice",
        sourceEntry: source
      };
    }
    case "game_notice": {
      const { notice } = source;
      const key = gameInboxEntryKey(notice.eventKind, notice.eventId);
      const unread = readReceipts[key] === notice.createdAt ? 0 : 1;
      return {
        key,
        revision: notice.createdAt,
        category: "notifications",
        label: notice.eventKind === "legendary_bird_event" ? "Legendary Bird Event" : notice.eventKind === "market_sale" ? "Market Sale" : "Game Notice",
        source: "Ash Atlas",
        message: notice.message,
        createdAt: notice.createdAt,
        activityAt: notice.createdAt,
        expiresAt: null,
        state: unread > 0 ? "unread" : "read",
        stateLabel: unread > 0 ? "Unread" : "Read",
        unreadCount: unread,
        canAccept: false,
        acceptDisabledReason: null,
        canDecline: false,
        declineDisabledReason: null,
        canCancel: false,
        cancelDisabledReason: null,
        variant: "notice",
        sourceEntry: source
      };
    }
    case "unknown":
      return {
        key: `unknown:${source.eventKind}:${source.id}`,
        revision: source.createdAt,
        category: "notifications",
        label: source.eventKind || "Game Notice",
        source: source.source ?? "Ash Atlas",
        message: source.message,
        createdAt: source.createdAt,
        activityAt: source.createdAt,
        expiresAt: null,
        state: "read",
        stateLabel: "Notice",
        unreadCount: readReceipts[`unknown:${source.eventKind}:${source.id}`] === source.createdAt ? 0 : 1,
        canAccept: false,
        acceptDisabledReason: null,
        canDecline: false,
        declineDisabledReason: null,
        canCancel: false,
        cancelDisabledReason: null,
        variant: "notice",
        sourceEntry: source
      };
  }
}

export type MobileInboxUnreadSummary = Readonly<{
  all: number;
  personal: number;
  invites: number;
  notifications: number;
}>;

export function summarizeMobileInboxUnread(
  entries: readonly MobileInboxEntry[]
): MobileInboxUnreadSummary {
  const personal = unreadFor(entries, "personal");
  const invites = unreadFor(entries, "invites");
  const notifications = unreadFor(entries, "notifications");
  return { all: personal + invites + notifications, personal, invites, notifications };
}

function unreadFor(entries: readonly MobileInboxEntry[], category: MobileInboxCategory): number {
  return entries
    .filter((entry) => entry.category === category)
    .reduce((total, entry) => total + entry.unreadCount, 0);
}

function travelState(status: TravelInboxEntry["status"]): MobileInboxState {
  switch (status) {
    case "pending": return "active";
    case "accepted": return "accepted";
    case "declined": return "declined";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    case "invalidated": return "cancelled";
  }
}

function kingdomState(status: KingdomInvitationSnapshot["status"]): MobileInboxState {
  switch (status) {
    case "pending": return "active";
    case "accepted": return "accepted";
    case "declined": return "declined";
    case "cancelled":
    case "revoked": return "cancelled";
    case "expired": return "expired";
  }
}

function partyState(status: PartyInviteSnapshot["status"]): MobileInboxState {
  switch (status) {
    case "pending": return "active";
    case "accepted": return "accepted";
    case "declined": return "declined";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    case "invalidated": return "completed";
  }
}

function stateLabel(state: MobileInboxState): string {
  switch (state) {
    case "active": return "Pending";
    case "unread": return "Unread";
    case "read": return "Read";
    case "accepted": return "Accepted";
    case "declined": return "Declined";
    case "cancelled": return "Cancelled";
    case "expired": return "Expired";
    case "completed": return "Completed";
  }
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function inboxPriority(entry: MobileInboxEntry): number {
  if (entry.category === "invites" && entry.state === "active" && entry.unreadCount > 0) return 0;
  if (entry.category === "personal" && entry.unreadCount > 0) return 1;
  if (entry.unreadCount > 0) return 2;
  if (entry.category === "invites" && entry.state === "active") return 3;
  if (entry.category === "personal") return 4;
  return 5;
}
