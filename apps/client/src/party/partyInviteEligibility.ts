import {
  PARTY_MEMBER_CAPACITY,
  type PartyOutgoingInviteSnapshot,
  type PartySnapshot,
  type ViewerRelationship
} from "@ash-atlas/shared";

export type PartyInviteContext = {
  connected: boolean;
  inviterPlayerId: string;
  party: PartySnapshot | null;
  outgoingInvites: readonly PartyOutgoingInviteSnapshot[];
  now: number;
};

export type PartyInviteAvailability = {
  available: boolean;
  reason: string | null;
};

export function partyInviteAvailability(
  context: PartyInviteContext,
  targetPlayerId: string,
  relationship: ViewerRelationship
): PartyInviteAvailability {
  if (!context.connected) return unavailable("Reconnect to invite players.");
  if (context.party && context.party.leaderPlayerId !== context.inviterPlayerId) {
    return unavailable("You do not have permission to invite party members.");
  }
  if (context.party?.memberPlayerIds.includes(targetPlayerId)) {
    return unavailable("This player is already in your party.");
  }
  if ((context.party?.memberPlayerIds.length ?? 1) >= PARTY_MEMBER_CAPACITY) {
    return unavailable("Your party is full.");
  }
  if (relationship.enemyMarkedByViewer) {
    return unavailable("You cannot invite an enemy to your party.");
  }
  if (
    relationship.friendship === "blocked_by_viewer" ||
    relationship.friendship === "unavailable"
  ) {
    return unavailable("Party invitation is unavailable.");
  }
  if (context.outgoingInvites.some((invite) =>
    invite.targetPlayerId === targetPlayerId &&
    Date.parse(invite.expiresAt) > context.now
  )) {
    return unavailable("Party invitation already pending.");
  }
  return { available: true, reason: null };
}

function unavailable(reason: string): PartyInviteAvailability {
  return { available: false, reason };
}
