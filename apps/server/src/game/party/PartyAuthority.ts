import { PARTY_MEMBER_CAPACITY, type PartyMemberSlot } from "@ash-atlas/shared";

export type PartySnapshot = Readonly<{
  partyId: string;
  leaderPlayerId: string;
  memberPlayerIds: readonly string[];
  allowTravel: boolean;
  autoFollowPlayerIds: readonly string[];
  revision: number;
  memberSlots?: readonly PartyMemberSlot[];
  membershipRevision?: number;
}>;

export type PartyInviteSnapshot = Readonly<{
  invitationId: string;
  partyId: string;
  leaderPlayerId: string;
  inviterPlayerId: string;
  targetPlayerId: string;
  perspective: "incoming" | "outgoing";
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired" | "invalidated";
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
  updatedAt: string;
}>;

export type PartyOutgoingInviteSnapshot = Readonly<{
  invitationId: string;
  targetPlayerId: string;
  expiresAt: string;
}>;

export const PARTY_INVITE_TTL_MS = 5 * 60_000;

/**
 * Read-only authority surface consumed by server-authoritative combat.
 * Membership is always explicit; callers must not infer parties from kingdom,
 * region, location, or combat proximity.
 */
export interface PartyAuthority {
  partyForPlayer(playerId: string): PartySnapshot | null;
  sameParty(leftPlayerId: string, rightPlayerId: string): boolean;
}

export interface MutablePartyAuthority extends PartyAuthority {
  invitesForPlayer(playerId: string): readonly PartyInviteSnapshot[];
  inboxInvitesForPlayer(playerId: string): readonly PartyInviteSnapshot[];
  outgoingInvitesForParty(partyId: string): readonly PartyOutgoingInviteSnapshot[];
  createParty(
    partyId: string,
    leaderPlayerId: string,
    requestId: string
  ): PartySnapshot | Promise<PartySnapshot>;
  inviteMember(
    targetPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): PartyInviteSnapshot | Promise<PartyInviteSnapshot>;
  inviteToParty(
    targetPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): PartyInviteSnapshot | Promise<PartyInviteSnapshot>;
  forwardInvite(
    invitationId: string,
    playerId: string,
    requestId: string
  ): PartyInviteSnapshot | Promise<PartyInviteSnapshot>;
  acceptInvite(invitationId: string, playerId: string, requestId: string): PartySnapshot | Promise<PartySnapshot>;
  declineInvite(invitationId: string, playerId: string, requestId: string): boolean | Promise<boolean>;
  cancelInvite(invitationId: string, playerId: string, requestId: string): boolean | Promise<boolean>;
  removePartyMember(
    targetPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): PartySnapshot | null | Promise<PartySnapshot | null>;
  leaveParty(playerId: string, requestId: string): PartySnapshot | null | Promise<PartySnapshot | null>;
  changePartyLeader(
    leaderPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): PartySnapshot | Promise<PartySnapshot>;
  setTravelAllowed(
    actorPlayerId: string,
    requestId: string,
    allowed: boolean
  ): PartySnapshot | Promise<PartySnapshot>;
  setAutoFollow(
    playerId: string,
    requestId: string,
    enabled: boolean
  ): PartySnapshot | Promise<PartySnapshot>;
  disbandParty(partyId: string, actorPlayerId: string, requestId: string): boolean | Promise<boolean>;
}

export type PartyAuthorityErrorCode =
  | "PARTY_ALREADY_EXISTS"
  | "PARTY_NOT_FOUND"
  | "PLAYER_ALREADY_IN_PARTY"
  | "PARTY_LEADER_NOT_MEMBER"
  | "PARTY_NOT_LEADER"
  | "PARTY_MEMBER_NOT_FOUND"
  | "PARTY_TARGET_OFFLINE"
  | "PARTY_TARGET_ENEMY"
  | "PARTY_TARGET_BLOCKED"
  | "PARTY_TARGET_NOT_LEADER"
  | "PARTY_FULL"
  | "PARTY_INVITE_NOT_FOUND"
  | "PARTY_INVITE_EXPIRED"
  | "PARTY_REQUEST_DUPLICATE"
  | "PARTY_OPERATION_CONFLICT"
  | "PARTY_UNAVAILABLE";

export class PartyAuthorityError extends Error {
  constructor(
    readonly code: PartyAuthorityErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PartyAuthorityError";
  }
}

type PartyRecord = {
  partyId: string;
  leaderPlayerId: string;
  memberPlayerIds: Set<string>;
  allowTravel: boolean;
  autoFollowPlayerIds: Set<string>;
  revision: number;
  memberSlotByPlayer: Map<string, number>;
  membershipRevision: number;
};

type PartyInviteRecord = Omit<PartyInviteSnapshot, "perspective">;
type LegacyPartyInviteSnapshot = Readonly<{
  partyId: string;
  leaderPlayerId: string;
  inviterPlayerId: string;
  targetPlayerId: string;
  expiresAt: string;
}>;
type PartyOperationRecord = Readonly<{ action: string; payload: string }>;

/**
 * Deterministic in-memory party membership authority.
 *
 * Persistence and player-facing party commands are intentionally outside this
 * class. It provides the smallest explicit membership source needed by combat
 * and can later be replaced by any structurally compatible authority.
 */
export class InMemoryPartyAuthority implements MutablePartyAuthority {
  private parties = new Map<string, PartyRecord>();
  private partyIdByPlayer = new Map<string, string>();
  private invitesByPlayer = new Map<string, Map<string, PartyInviteRecord>>();
  private inviteTargetsByParty = new Map<string, Set<string>>();
  private invitesById = new Map<string, PartyInviteRecord>();
  private inboxInviteIdsByPlayer = new Map<string, Set<string>>();
  private operationsByPlayer = new Map<string, Map<string, PartyOperationRecord>>();

  constructor(
    private readonly areEnemies: (leftPlayerId: string, rightPlayerId: string) => boolean = () => false,
    private readonly areBlocked: (leftPlayerId: string, rightPlayerId: string) => boolean = () => false
  ) {}

  loadSnapshots(snapshots: readonly PartySnapshot[]): void {
    const parties = new Map<string, PartyRecord>();
    const partyIdByPlayer = new Map<string, string>();
    for (const party of [...snapshots].sort((left, right) => compareIds(left.partyId, right.partyId))) {
      requireIdentifier(party.partyId, "partyId");
      requireIdentifier(party.leaderPlayerId, "leaderPlayerId");
      if (!Number.isSafeInteger(party.revision) || party.revision < 1) {
        throw new TypeError("party revision must be a positive safe integer");
      }
      if (parties.has(party.partyId)) {
        throw new PartyAuthorityError("PARTY_ALREADY_EXISTS", `Party ${party.partyId} already exists`);
      }
      const members = new Set(party.memberPlayerIds);
      if (!members.has(party.leaderPlayerId)) {
        throw new PartyAuthorityError(
          "PARTY_LEADER_NOT_MEMBER",
          `Player ${party.leaderPlayerId} is not a member of party ${party.partyId}`
        );
      }
      for (const playerId of members) {
        requireIdentifier(playerId, "memberPlayerId");
        const existingPartyId = partyIdByPlayer.get(playerId);
        if (existingPartyId) {
          throw new PartyAuthorityError(
            "PLAYER_ALREADY_IN_PARTY",
            `Player ${playerId} already belongs to party ${existingPartyId}`
          );
        }
        partyIdByPlayer.set(playerId, party.partyId);
      }
      parties.set(party.partyId, {
        partyId: party.partyId,
        leaderPlayerId: party.leaderPlayerId,
        memberPlayerIds: members,
        allowTravel: party.allowTravel,
        autoFollowPlayerIds: new Set(
          party.autoFollowPlayerIds.filter((playerId) => members.has(playerId))
        ),
        revision: party.revision,
        memberSlotByPlayer: normalizeMemberSlots(members, party.memberSlots),
        membershipRevision: party.membershipRevision ?? party.revision
      });
    }
    this.parties = parties;
    this.partyIdByPlayer = partyIdByPlayer;
    this.invitesByPlayer = new Map();
    this.inviteTargetsByParty = new Map();
    this.operationsByPlayer = new Map();
  }

  loadInvites(invites: readonly (PartyInviteSnapshot | LegacyPartyInviteSnapshot)[]): void {
    const invitesByPlayer = new Map<string, Map<string, PartyInviteRecord>>();
    const inviteTargetsByParty = new Map<string, Set<string>>();
    this.invitesById = new Map();
    this.inboxInviteIdsByPlayer = new Map();
    for (const candidate of invites) {
      const invite: PartyInviteSnapshot = "invitationId" in candidate
        ? candidate
        : {
            ...candidate,
            invitationId: crypto.randomUUID(),
            perspective: "incoming",
            status: "pending",
            createdAt: new Date(Math.max(0, Date.parse(candidate.expiresAt) - PARTY_INVITE_TTL_MS)).toISOString(),
            respondedAt: null,
            updatedAt: new Date(Math.max(0, Date.parse(candidate.expiresAt) - PARTY_INVITE_TTL_MS)).toISOString()
          };
      requireIdentifier(invite.targetPlayerId, "targetPlayerId");
      const record: PartyInviteRecord = {
        invitationId: invite.invitationId,
        partyId: invite.partyId,
        leaderPlayerId: invite.leaderPlayerId,
        inviterPlayerId: invite.inviterPlayerId,
        targetPlayerId: invite.targetPlayerId,
        status: invite.status,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        respondedAt: invite.respondedAt,
        updatedAt: invite.updatedAt
      };
      this.rememberInboxInvite(record);
      if (record.status !== "pending" || Date.parse(record.expiresAt) <= Date.now()) continue;
      if (!this.parties.has(record.partyId)) continue;
      const byParty = invitesByPlayer.get(invite.targetPlayerId) ?? new Map<string, PartyInviteRecord>();
      byParty.set(invite.partyId, record);
      invitesByPlayer.set(invite.targetPlayerId, byParty);
      const targets = inviteTargetsByParty.get(invite.partyId) ?? new Set<string>();
      targets.add(invite.targetPlayerId);
      inviteTargetsByParty.set(invite.partyId, targets);
    }
    this.invitesByPlayer = invitesByPlayer;
    this.inviteTargetsByParty = inviteTargetsByParty;
  }

  replacePartySnapshot(partyId: string, replacement: PartySnapshot | null): void {
    requireIdentifier(partyId, "partyId");
    if (replacement) {
      if (replacement.partyId !== partyId) throw new TypeError("replacement party ID must match");
      requireIdentifier(replacement.leaderPlayerId, "leaderPlayerId");
      if (!Number.isSafeInteger(replacement.revision) || replacement.revision < 1) {
        throw new TypeError("party revision must be a positive safe integer");
      }
      const members = new Set(replacement.memberPlayerIds);
      if (!members.has(replacement.leaderPlayerId)) {
        throw new PartyAuthorityError(
          "PARTY_LEADER_NOT_MEMBER",
          `Player ${replacement.leaderPlayerId} is not a member of party ${partyId}`
        );
      }
      for (const playerId of members) {
        requireIdentifier(playerId, "memberPlayerId");
        const existingPartyId = this.partyIdByPlayer.get(playerId);
        if (existingPartyId && existingPartyId !== partyId) {
          throw new PartyAuthorityError(
            "PLAYER_ALREADY_IN_PARTY",
            `Player ${playerId} already belongs to party ${existingPartyId}`
          );
        }
      }
    }

    const existing = this.parties.get(partyId);
    if (existing) {
      for (const playerId of existing.memberPlayerIds) this.partyIdByPlayer.delete(playerId);
    }
    if (!replacement) {
      this.parties.delete(partyId);
      this.removePartyInvites(partyId);
      return;
    }
    const members = new Set(replacement.memberPlayerIds);
    this.parties.set(partyId, {
      partyId,
      leaderPlayerId: replacement.leaderPlayerId,
      memberPlayerIds: members,
      allowTravel: replacement.allowTravel,
      autoFollowPlayerIds: new Set(
        replacement.autoFollowPlayerIds.filter((playerId) => members.has(playerId))
      ),
      revision: replacement.revision,
      memberSlotByPlayer: normalizeMemberSlots(members, replacement.memberSlots),
      membershipRevision: replacement.membershipRevision ?? replacement.revision
    });
    for (const playerId of members) this.partyIdByPlayer.set(playerId, partyId);
    this.refreshInviteLeaders(partyId, replacement.leaderPlayerId);
  }

  replaceInvitesForPlayer(
    targetPlayerId: string,
    invites: readonly PartyInviteSnapshot[]
  ): void {
    if (invites.some((invite) => invite.targetPlayerId !== targetPlayerId)) {
      throw new TypeError("replacement invite target must match");
    }
    this.deleteInvitesForTarget(targetPlayerId);
    for (const invite of invites) {
      this.putInvite(invite);
    }
  }

  replaceInvitesForParty(
    partyId: string,
    invites: readonly PartyInviteSnapshot[]
  ): void {
    if (invites.some((invite) => invite.partyId !== partyId)) {
      throw new TypeError("replacement invite party must match");
    }
    this.removePartyInvites(partyId);
    for (const invite of invites) {
      this.putInvite(invite);
    }
  }

  createParty(
    partyId: string,
    leaderPlayerId: string,
    requestId: string
  ): PartySnapshot {
    return this.withOperation(leaderPlayerId, requestId, "create", {}, () => {
      requireIdentifier(partyId, "partyId");
      requireIdentifier(leaderPlayerId, "leaderPlayerId");
      if (this.parties.has(partyId)) {
        throw new PartyAuthorityError("PARTY_ALREADY_EXISTS", `Party ${partyId} already exists`);
      }
      const existingPartyId = this.partyIdByPlayer.get(leaderPlayerId);
      if (existingPartyId) {
        throw new PartyAuthorityError(
          "PLAYER_ALREADY_IN_PARTY",
          `Player ${leaderPlayerId} already belongs to party ${existingPartyId}`
        );
      }
      const party: PartyRecord = {
        partyId,
        leaderPlayerId,
        memberPlayerIds: new Set([leaderPlayerId]),
        allowTravel: false,
        autoFollowPlayerIds: new Set(),
        revision: 1,
        memberSlotByPlayer: new Map([[leaderPlayerId, 0]]),
        membershipRevision: 1
      };
      this.parties.set(partyId, party);
      this.partyIdByPlayer.set(leaderPlayerId, partyId);
      this.deleteInvitesForTarget(leaderPlayerId);
      return snapshot(party);
    });
  }

  inviteMember(
    targetPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): PartyInviteSnapshot {
    return this.withOperation(actorPlayerId, requestId, "invite", { targetPlayerId }, () => {
      requireIdentifier(targetPlayerId, "targetPlayerId");
      const party = this.requirePlayerParty(actorPlayerId);
      requireLeaderActor(party, actorPlayerId);
      if (this.areEnemies(actorPlayerId, targetPlayerId)) {
        throw new PartyAuthorityError(
          "PARTY_TARGET_ENEMY",
          "You cannot invite an enemy to your party."
        );
      }
      if (this.areBlocked(actorPlayerId, targetPlayerId)) {
        throw new PartyAuthorityError(
          "PARTY_TARGET_BLOCKED",
          "Party invitation is unavailable."
        );
      }
      this.assertInvitationTargetAvailable(party, targetPlayerId);
      const invite = createInvite(party, actorPlayerId, targetPlayerId);
      this.putInvite(invite);
      return inviteSnapshot(invite, "incoming");
    });
  }

  inviteToParty(
    targetPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): PartyInviteSnapshot {
    return this.withOperation(actorPlayerId, requestId, "invite_to_party", { targetPlayerId }, () => {
      requireIdentifier(targetPlayerId, "targetPlayerId");
      if (this.areEnemies(actorPlayerId, targetPlayerId)) {
        throw new PartyAuthorityError("PARTY_TARGET_ENEMY", "You cannot invite an enemy to your party.");
      }
      if (this.areBlocked(actorPlayerId, targetPlayerId)) {
        throw new PartyAuthorityError("PARTY_TARGET_BLOCKED", "Party invitation is unavailable.");
      }
      let party = this.partyIdByPlayer.has(actorPlayerId)
        ? this.requirePlayerParty(actorPlayerId)
        : null;
      if (party) {
        requireLeaderActor(party, actorPlayerId);
        this.assertInvitationTargetAvailable(party, targetPlayerId);
      } else {
        const targetPartyId = this.partyIdByPlayer.get(targetPlayerId);
        const targetParty = targetPartyId ? this.requireParty(targetPartyId) : null;
        if (targetParty && targetParty.memberPlayerIds.size + 1 > PARTY_MEMBER_CAPACITY) {
          throw new PartyAuthorityError("PARTY_FULL", "No space. The combined party would exceed five members.");
        }
        const partyId = `party:${crypto.randomUUID()}`;
        party = {
          partyId,
          leaderPlayerId: actorPlayerId,
          memberPlayerIds: new Set([actorPlayerId]),
          allowTravel: false,
          autoFollowPlayerIds: new Set(),
          revision: 1,
          memberSlotByPlayer: new Map([[actorPlayerId, 0]]),
          membershipRevision: 1
        };
        this.parties.set(partyId, party);
        this.partyIdByPlayer.set(actorPlayerId, partyId);
        this.deleteInvitesForTarget(actorPlayerId);
      }

      const invite = createInvite(party, actorPlayerId, targetPlayerId);
      this.putInvite(invite);
      return inviteSnapshot(invite, "incoming");
    }, () => {
      const party = this.partyForPlayer(actorPlayerId);
      const invite = [...this.invitesById.values()].find(
        (candidate) =>
          candidate.partyId === party?.partyId &&
          candidate.inviterPlayerId === actorPlayerId &&
          candidate.targetPlayerId === targetPlayerId &&
          candidate.status === "pending"
      );
      if (invite) return inviteSnapshot(invite, "incoming");
      throw new PartyAuthorityError("PARTY_REQUEST_DUPLICATE", "Party request was already committed");
    });
  }

  acceptInvite(invitationId: string, playerId: string, requestId: string): PartySnapshot {
    return this.withOperation(playerId, requestId, "accept", { invitationId }, () => {
      const invite = this.requireInvite(invitationId, playerId);
      if (Date.parse(invite.expiresAt) <= Date.now()) {
        this.finishInvite(invite, "expired");
        throw new PartyAuthorityError("PARTY_INVITE_EXPIRED", "Party invitation has expired");
      }
      if (this.areEnemies(invite.leaderPlayerId, playerId)) {
        throw new PartyAuthorityError(
          "PARTY_TARGET_ENEMY",
          "You cannot join an enemy's party."
        );
      }
      if (this.areBlocked(invite.leaderPlayerId, playerId)) {
        throw new PartyAuthorityError(
          "PARTY_TARGET_BLOCKED",
          "Party invitation is unavailable."
        );
      }
      const party = this.requireParty(invite.partyId);
      const existingPartyId = this.partyIdByPlayer.get(playerId);
      const existingParty = existingPartyId && existingPartyId !== party.partyId
        ? this.requireParty(existingPartyId)
        : null;
      if (existingParty) {
        if (existingParty.leaderPlayerId !== playerId) {
          throw new PartyAuthorityError(
            "PARTY_TARGET_NOT_LEADER",
            "Only your party leader can accept a party merge."
          );
        }
        if (party.memberPlayerIds.size + existingParty.memberPlayerIds.size > PARTY_MEMBER_CAPACITY) {
          throw new PartyAuthorityError("PARTY_FULL", "No space. The combined party would exceed five members.");
        }
        for (const memberPlayerId of existingParty.memberPlayerIds) {
          if (this.areEnemies(invite.leaderPlayerId, memberPlayerId)) {
            throw new PartyAuthorityError("PARTY_TARGET_ENEMY", "An enemy cannot join this party.");
          }
          if (this.areBlocked(invite.leaderPlayerId, memberPlayerId)) {
            throw new PartyAuthorityError("PARTY_TARGET_BLOCKED", "Party invitation is unavailable.");
          }
        }
      } else if (!party.memberPlayerIds.has(playerId) && party.memberPlayerIds.size >= PARTY_MEMBER_CAPACITY) {
        throw new PartyAuthorityError("PARTY_FULL", "The party is full.");
      }
      const result = existingParty
        ? this.mergeParties(party, existingParty)
        : this.addInvitedMember(invite.partyId, playerId);
      this.finishInvite(invite, "accepted");
      return result;
    }, () => {
      const receipt = this.invitesById.get(invitationId);
      const party = receipt ? this.parties.get(receipt.partyId) : undefined;
      if (
        receipt?.targetPlayerId === playerId &&
        receipt.status === "accepted" &&
        party?.memberPlayerIds.has(playerId)
      ) {
        return snapshot(party);
      }
      throw new PartyAuthorityError("PARTY_REQUEST_DUPLICATE", "Party request was already committed");
    });
  }

  declineInvite(invitationId: string, playerId: string, requestId: string): boolean {
    return this.withOperation(playerId, requestId, "decline", { invitationId }, () => {
      const invite = this.requireInvite(invitationId, playerId);
      this.finishInvite(invite, "declined");
      return true;
    }, () => {
      const receipt = this.invitesById.get(invitationId);
      if (receipt?.targetPlayerId === playerId && receipt.status === "declined") return true;
      throw new PartyAuthorityError("PARTY_REQUEST_DUPLICATE", "Party request was already committed");
    });
  }

  cancelInvite(invitationId: string, playerId: string, requestId: string): boolean {
    return this.withOperation(playerId, requestId, "cancel", { invitationId }, () => {
      const invite = this.invitesById.get(invitationId);
      if (!invite || invite.status !== "pending" || invite.inviterPlayerId !== playerId) {
        throw new PartyAuthorityError("PARTY_INVITE_NOT_FOUND", "Party invitation does not exist");
      }
      this.finishInvite(invite, "cancelled");
      return true;
    });
  }

  removePartyMember(
    targetPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): PartySnapshot | null {
    return this.withOperation(actorPlayerId, requestId, "remove", { targetPlayerId }, () => {
      const party = this.requirePlayerParty(actorPlayerId);
      requireLeaderActor(party, actorPlayerId);
      return this.removeMemberFromParty(party, targetPlayerId);
    });
  }

  leaveParty(playerId: string, requestId: string): PartySnapshot | null {
    return this.withOperation(playerId, requestId, "leave", {}, () => {
      const party = this.requirePlayerParty(playerId);
      return this.removeMemberFromParty(party, playerId);
    });
  }

  changePartyLeader(
    leaderPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): PartySnapshot {
    return this.withOperation(actorPlayerId, requestId, "change_leader", { leaderPlayerId }, () => {
      const party = this.requirePlayerParty(actorPlayerId);
      requireLeaderActor(party, actorPlayerId);
      if (!party.memberPlayerIds.has(leaderPlayerId)) {
        throw new PartyAuthorityError(
          "PARTY_LEADER_NOT_MEMBER",
          `Player ${leaderPlayerId} is not a member of party ${party.partyId}`
        );
      }
      if (party.leaderPlayerId !== leaderPlayerId) {
        party.leaderPlayerId = leaderPlayerId;
        party.allowTravel = false;
        party.revision += 1;
        this.refreshInviteLeaders(party.partyId, leaderPlayerId);
      }
      return snapshot(party);
    });
  }

  setTravelAllowed(actorPlayerId: string, requestId: string, allowed: boolean): PartySnapshot {
    return this.withOperation(actorPlayerId, requestId, "set_travel_allowed", { allowed }, () => {
      const party = this.requirePlayerParty(actorPlayerId);
      requireLeaderActor(party, actorPlayerId);
      if (party.allowTravel !== allowed) {
        party.allowTravel = allowed;
        party.revision += 1;
      }
      return snapshot(party);
    });
  }

  setAutoFollow(playerId: string, requestId: string, enabled: boolean): PartySnapshot {
    return this.withOperation(playerId, requestId, "set_auto_follow", { enabled }, () => {
      const party = this.requirePlayerParty(playerId);
      const changed = enabled
        ? !party.autoFollowPlayerIds.has(playerId)
        : party.autoFollowPlayerIds.has(playerId);
      if (enabled) party.autoFollowPlayerIds.add(playerId);
      else party.autoFollowPlayerIds.delete(playerId);
      if (changed) party.revision += 1;
      return snapshot(party);
    });
  }

  invitesForPlayer(playerId: string): readonly PartyInviteSnapshot[] {
    const invites = this.invitesByPlayer.get(playerId);
    if (!invites) return [];
    return [...invites.values()]
      .filter((invite) => Date.parse(invite.expiresAt) > Date.now())
      .sort(
        (left, right) =>
          compareIds(left.partyId, right.partyId) ||
          compareIds(left.invitationId, right.invitationId),
      )
      .map((invite) => inviteSnapshot(invite, "incoming"));
  }

  inboxInvitesForPlayer(playerId: string): readonly PartyInviteSnapshot[] {
    return [...(this.inboxInviteIdsByPlayer.get(playerId) ?? [])]
      .map((invitationId) => this.invitesById.get(invitationId))
      .filter((invite): invite is PartyInviteRecord => invite !== undefined)
      .sort((left, right) => compareIds(right.updatedAt, left.updatedAt))
      .map((invite) => inviteSnapshot(
        invite,
        invite.targetPlayerId === playerId ? "incoming" : "outgoing"
      ));
  }

  outgoingInvitesForParty(partyId: string): readonly PartyOutgoingInviteSnapshot[] {
    const targetPlayerIds = this.inviteTargetsByParty.get(partyId);
    if (!targetPlayerIds) return [];
    const now = Date.now();
    return [...targetPlayerIds]
      .map((targetPlayerId) => this.invitesByPlayer.get(targetPlayerId)?.get(partyId))
      .filter((invite): invite is PartyInviteRecord =>
        invite !== undefined && Date.parse(invite.expiresAt) > now
      )
      .sort((left, right) => compareIds(left.targetPlayerId, right.targetPlayerId))
      .map((invite) => ({
        invitationId: invite.invitationId,
        targetPlayerId: invite.targetPlayerId,
        expiresAt: invite.expiresAt
      }));
  }

  private removeMemberFromParty(party: PartyRecord, playerId: string): PartySnapshot | null {
    requireIdentifier(playerId, "playerId");
    if (!party.memberPlayerIds.has(playerId)) {
      throw new PartyAuthorityError("PARTY_MEMBER_NOT_FOUND", "Player is not a member of the party");
    }
    party.memberPlayerIds.delete(playerId);
    party.autoFollowPlayerIds.delete(playerId);
    party.memberSlotByPlayer.delete(playerId);

    this.partyIdByPlayer.delete(playerId);
    if (party.memberPlayerIds.size === 0) {
      this.parties.delete(party.partyId);
      this.removePartyInvites(party.partyId);
      return null;
    }

    this.removeInvitesByInviter(party.partyId, playerId);

    if (party.leaderPlayerId === playerId) {
      party.leaderPlayerId = sortedPlayerIds(party.memberPlayerIds)[0]!;
      party.allowTravel = false;
      this.refreshInviteLeaders(party.partyId, party.leaderPlayerId);
    }
    party.revision += 1;
    party.membershipRevision += 1;
    return snapshot(party);
  }

  disbandParty(partyId: string, actorPlayerId: string, requestId: string): boolean {
    return this.withOperation(actorPlayerId, requestId, "disband", { partyId }, () => {
      const party = this.parties.get(partyId);
      if (!party) return false;
      requireLeaderActor(party, actorPlayerId);
      this.parties.delete(partyId);
      for (const playerId of party.memberPlayerIds) this.partyIdByPlayer.delete(playerId);
      this.removePartyInvites(partyId);
      return true;
    });
  }

  party(partyId: string): PartySnapshot | null {
    const party = this.parties.get(partyId);
    return party ? snapshot(party) : null;
  }

  partyForPlayer(playerId: string): PartySnapshot | null {
    const partyId = this.partyIdByPlayer.get(playerId);
    if (!partyId) return null;
    const party = this.parties.get(partyId);
    return party ? snapshot(party) : null;
  }

  sameParty(leftPlayerId: string, rightPlayerId: string): boolean {
    const partyId = this.partyIdByPlayer.get(leftPlayerId);
    return partyId !== undefined && partyId === this.partyIdByPlayer.get(rightPlayerId);
  }

  private requireParty(partyId: string): PartyRecord {
    requireIdentifier(partyId, "partyId");
    const party = this.parties.get(partyId);
    if (!party) throw new PartyAuthorityError("PARTY_NOT_FOUND", `Party ${partyId} does not exist`);
    return party;
  }

  private requirePlayerParty(playerId: string): PartyRecord {
    const partyId = this.partyIdByPlayer.get(playerId);
    if (!partyId) throw new PartyAuthorityError("PARTY_NOT_FOUND", "Player does not belong to a party");
    return this.requireParty(partyId);
  }

  private requireInvite(invitationId: string, playerId: string): PartyInviteRecord {
    const invite = this.invitesById.get(invitationId)
      ?? this.invitesByPlayer.get(playerId)?.get(invitationId)
      ?? [...this.invitesById.values()].find(
        (candidate) =>
          candidate.partyId === invitationId &&
          candidate.targetPlayerId === playerId &&
          candidate.status === "pending",
      );
    if (invite?.targetPlayerId !== playerId || invite.status !== "pending") {
      throw new PartyAuthorityError("PARTY_INVITE_NOT_FOUND", "Party invitation does not exist");
    }
    return invite;
  }

  private addInvitedMember(partyId: string, playerId: string): PartySnapshot {
    const party = this.requireParty(partyId);
    const existingPartyId = this.partyIdByPlayer.get(playerId);
    if (existingPartyId && existingPartyId !== partyId) {
      throw new PartyAuthorityError("PLAYER_ALREADY_IN_PARTY", "Player already belongs to another party");
    }
    if (!existingPartyId) {
      party.memberPlayerIds.add(playerId);
      party.memberSlotByPlayer.set(playerId, lowestAvailableSlot(party.memberSlotByPlayer.values()));
      this.partyIdByPlayer.set(playerId, partyId);
      party.revision += 1;
      party.membershipRevision += 1;
    }
    this.deleteInvitesForTarget(playerId);
    return snapshot(party);
  }

  forwardInvite(invitationId: string, playerId: string, requestId: string): PartyInviteSnapshot {
    return this.withOperation(playerId, requestId, "forward", { invitationId }, () => {
      const invite = this.requireInvite(invitationId, playerId);
      const sourceParty = this.requirePlayerParty(playerId);
      if (sourceParty.leaderPlayerId === playerId) {
        throw new PartyAuthorityError("PARTY_UNAVAILABLE", "You are the party leader and can accept this merge directly.");
      }
      const destinationParty = this.requireParty(invite.partyId);
      if (destinationParty.partyId === sourceParty.partyId) {
        throw new PartyAuthorityError("PLAYER_ALREADY_IN_PARTY", "Player already belongs to your party.");
      }
      if (destinationParty.memberPlayerIds.size + sourceParty.memberPlayerIds.size > PARTY_MEMBER_CAPACITY) {
        throw new PartyAuthorityError("PARTY_FULL", "No space. The combined party would exceed five members.");
      }
      if (this.invitesByPlayer.get(sourceParty.leaderPlayerId)?.has(destinationParty.partyId)) {
        throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Your party leader already has this invitation.");
      }
      if (this.areEnemies(invite.leaderPlayerId, sourceParty.leaderPlayerId)) {
        throw new PartyAuthorityError("PARTY_TARGET_ENEMY", "You cannot forward this invitation to an enemy.");
      }
      if (this.areBlocked(invite.leaderPlayerId, sourceParty.leaderPlayerId)) {
        throw new PartyAuthorityError("PARTY_TARGET_BLOCKED", "Party invitation is unavailable.");
      }

      this.invitesByPlayer.get(playerId)?.delete(invite.partyId);
      if (this.invitesByPlayer.get(playerId)?.size === 0) this.invitesByPlayer.delete(playerId);
      this.removeInviteTargetIndex(invite.partyId, playerId);
      this.inboxInviteIdsByPlayer.get(playerId)?.delete(invite.invitationId);
      const forwarded = {
        ...invite,
        targetPlayerId: sourceParty.leaderPlayerId,
        updatedAt: new Date().toISOString()
      };
      this.putInvite(forwarded);
      return inviteSnapshot(forwarded, "incoming");
    }, () => {
      const forwarded = this.invitesById.get(invitationId);
      if (forwarded && forwarded.targetPlayerId !== playerId) {
        return inviteSnapshot(forwarded, "incoming");
      }
      throw new PartyAuthorityError("PARTY_REQUEST_DUPLICATE", "Party request was already committed");
    });
  }

  private assertInvitationTargetAvailable(party: PartyRecord, targetPlayerId: string): void {
    const targetPartyId = this.partyIdByPlayer.get(targetPlayerId);
    if (!targetPartyId) {
      if (party.memberPlayerIds.size >= PARTY_MEMBER_CAPACITY) {
        throw new PartyAuthorityError("PARTY_FULL", "Your party is full.");
      }
      return;
    }
    if (targetPartyId === party.partyId) {
      throw new PartyAuthorityError("PLAYER_ALREADY_IN_PARTY", "Player already belongs to your party.");
    }
    const targetParty = this.requireParty(targetPartyId);
    if (party.memberPlayerIds.size + targetParty.memberPlayerIds.size > PARTY_MEMBER_CAPACITY) {
      throw new PartyAuthorityError("PARTY_FULL", "No space. The combined party would exceed five members.");
    }
  }

  private mergeParties(destination: PartyRecord, source: PartyRecord): PartySnapshot {
    const movedPlayerIds = [...source.memberSlotByPlayer.entries()]
      .sort((left, right) => left[1] - right[1] || compareIds(left[0], right[0]))
      .map(([playerId]) => playerId);
    this.parties.delete(source.partyId);
    this.removePartyInvites(source.partyId);
    for (const playerId of movedPlayerIds) {
      destination.memberPlayerIds.add(playerId);
      destination.memberSlotByPlayer.set(
        playerId,
        lowestAvailableSlot(destination.memberSlotByPlayer.values())
      );
      this.partyIdByPlayer.set(playerId, destination.partyId);
      this.deleteInvitesForTarget(playerId);
    }
    destination.revision += 1;
    destination.membershipRevision += 1;
    return snapshot(destination);
  }

  private withOperation<T>(
    playerId: string,
    requestId: string,
    action: string,
    payload: unknown,
    operation: () => T,
    replay?: () => T
  ): T {
    requireIdentifier(playerId, "playerId");
    requireIdentifier(requestId, "requestId");
    const serializedPayload = JSON.stringify(payload);
    const byRequest = this.operationsByPlayer.get(playerId) ?? new Map<string, PartyOperationRecord>();
    const existing = byRequest.get(requestId);
    if (existing) {
      if (existing.action !== action || existing.payload !== serializedPayload) {
        throw new PartyAuthorityError("PARTY_OPERATION_CONFLICT", "Party request ID conflicts with another operation");
      }
      if (replay) return replay();
      throw new PartyAuthorityError("PARTY_REQUEST_DUPLICATE", "Party request was already committed");
    }
    byRequest.set(requestId, { action, payload: serializedPayload });
    this.operationsByPlayer.set(playerId, byRequest);
    try {
      return operation();
    } catch (error) {
      byRequest.delete(requestId);
      if (byRequest.size === 0) this.operationsByPlayer.delete(playerId);
      throw error;
    }
  }

  private removePartyInvites(partyId: string): void {
    for (const playerId of [...(this.inviteTargetsByParty.get(partyId) ?? [])]) {
      const invite = this.invitesByPlayer.get(playerId)?.get(partyId);
      if (invite) this.finishInvite(invite, "invalidated");
    }
    this.inviteTargetsByParty.delete(partyId);
  }

  private removeInvitesByInviter(partyId: string, inviterPlayerId: string): void {
    for (const targetPlayerId of [...(this.inviteTargetsByParty.get(partyId) ?? [])]) {
      const invites = this.invitesByPlayer.get(targetPlayerId);
      if (!invites) continue;
      const invite = invites.get(partyId);
      if (invite?.inviterPlayerId === inviterPlayerId) {
        this.finishInvite(invite, "invalidated");
      }
      if (invites.size === 0) this.invitesByPlayer.delete(targetPlayerId);
    }
  }

  private refreshInviteLeaders(partyId: string, leaderPlayerId: string): void {
    for (const targetPlayerId of this.inviteTargetsByParty.get(partyId) ?? []) {
      const invites = this.invitesByPlayer.get(targetPlayerId);
      if (!invites) continue;
      const invite = invites.get(partyId);
      if (invite) {
        const updated = { ...invite, leaderPlayerId, updatedAt: new Date().toISOString() };
        invites.set(partyId, updated);
        this.rememberInboxInvite(updated);
      }
    }
  }

  private putInvite(invite: PartyInviteRecord): void {
    this.rememberInboxInvite(invite);
    if (invite.status !== "pending") return;
    if (!this.parties.has(invite.partyId)) return;
    const byParty = this.invitesByPlayer.get(invite.targetPlayerId) ?? new Map<string, PartyInviteRecord>();
    byParty.set(invite.partyId, { ...invite });
    this.invitesByPlayer.set(invite.targetPlayerId, byParty);
    const targets = this.inviteTargetsByParty.get(invite.partyId) ?? new Set<string>();
    targets.add(invite.targetPlayerId);
    this.inviteTargetsByParty.set(invite.partyId, targets);
  }

  private rememberInboxInvite(invite: PartyInviteRecord): void {
    this.invitesById.set(invite.invitationId, { ...invite });
    for (const playerId of new Set([invite.targetPlayerId, invite.inviterPlayerId])) {
      const ids = this.inboxInviteIdsByPlayer.get(playerId) ?? new Set<string>();
      ids.add(invite.invitationId);
      this.inboxInviteIdsByPlayer.set(playerId, ids);
    }
  }

  private finishInvite(
    invite: PartyInviteRecord,
    status: Exclude<PartyInviteRecord["status"], "pending">
  ): void {
    const now = new Date().toISOString();
    const finished = { ...invite, status, respondedAt: now, updatedAt: now };
    const active = this.invitesByPlayer.get(invite.targetPlayerId);
    active?.delete(invite.partyId);
    if (active?.size === 0) this.invitesByPlayer.delete(invite.targetPlayerId);
    this.removeInviteTargetIndex(invite.partyId, invite.targetPlayerId);
    this.rememberInboxInvite(finished);
  }

  private deleteInvitesForTarget(targetPlayerId: string): void {
    const invites = this.invitesByPlayer.get(targetPlayerId);
    if (!invites) return;
    for (const invite of [...invites.values()]) this.finishInvite(invite, "invalidated");
    this.invitesByPlayer.delete(targetPlayerId);
  }

  private removeInviteTargetIndex(partyId: string, targetPlayerId: string): void {
    const targets = this.inviteTargetsByParty.get(partyId);
    targets?.delete(targetPlayerId);
    if (targets?.size === 0) this.inviteTargetsByParty.delete(partyId);
  }
}

function snapshot(party: PartyRecord): PartySnapshot {
  const memberSlots = [...party.memberSlotByPlayer]
    .map(([playerId, slotIndex]) => ({ playerId, slotIndex }))
    .sort((left, right) => left.slotIndex - right.slotIndex || compareIds(left.playerId, right.playerId));
  const memberPlayerIds = Object.freeze(sortedPlayerIds(party.memberPlayerIds));
  return Object.freeze({
    partyId: party.partyId,
    leaderPlayerId: party.leaderPlayerId,
    memberPlayerIds,
    allowTravel: party.allowTravel,
    autoFollowPlayerIds: sortedPlayerIds(party.autoFollowPlayerIds),
    revision: party.revision,
    memberSlots: Object.freeze(memberSlots),
    membershipRevision: party.membershipRevision
  });
}

function createInvite(
  party: PartyRecord,
  inviterPlayerId: string,
  targetPlayerId: string
): PartyInviteRecord {
  const now = new Date();
  return {
    invitationId: crypto.randomUUID(),
    partyId: party.partyId,
    leaderPlayerId: party.leaderPlayerId,
    inviterPlayerId,
    targetPlayerId,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PARTY_INVITE_TTL_MS).toISOString(),
    respondedAt: null,
    updatedAt: now.toISOString()
  };
}

function normalizeMemberSlots(
  memberPlayerIds: ReadonlySet<string>,
  memberSlots: readonly PartyMemberSlot[] | undefined
): Map<string, number> {
  const normalized = new Map<string, number>();
  const occupied = new Set<number>();
  for (const candidate of memberSlots ?? []) {
    if (
      memberPlayerIds.has(candidate.playerId) &&
      Number.isInteger(candidate.slotIndex) &&
      candidate.slotIndex >= 0 &&
      candidate.slotIndex < PARTY_MEMBER_CAPACITY &&
      !normalized.has(candidate.playerId) &&
      !occupied.has(candidate.slotIndex)
    ) {
      normalized.set(candidate.playerId, candidate.slotIndex);
      occupied.add(candidate.slotIndex);
    }
  }
  for (const playerId of sortedPlayerIds(memberPlayerIds)) {
    if (normalized.has(playerId)) continue;
    const slot = lowestAvailableSlot(occupied);
    normalized.set(playerId, slot);
    occupied.add(slot);
  }
  return normalized;
}

function lowestAvailableSlot(occupiedSlots: Iterable<number>): number {
  const occupied = new Set(occupiedSlots);
  for (let slot = 0; slot < PARTY_MEMBER_CAPACITY; slot += 1) {
    if (!occupied.has(slot)) return slot;
  }
  throw new PartyAuthorityError("PARTY_FULL", "The party is full.");
}

function inviteSnapshot(
  invite: PartyInviteRecord,
  perspective: PartyInviteSnapshot["perspective"]
): PartyInviteSnapshot {
  return Object.freeze({
    invitationId: invite.invitationId,
    partyId: invite.partyId,
    leaderPlayerId: invite.leaderPlayerId,
    inviterPlayerId: invite.inviterPlayerId,
    targetPlayerId: invite.targetPlayerId,
    perspective,
    status: invite.status,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    respondedAt: invite.respondedAt,
    updatedAt: invite.updatedAt
  });
}

function sortedPlayerIds(playerIds: Iterable<string>): string[] {
  return [...playerIds].sort(compareIds);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireIdentifier(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
}

function requireLeaderActor(party: PartyRecord, actorPlayerId: string | undefined): void {
  if (actorPlayerId !== undefined && party.leaderPlayerId !== actorPlayerId) {
    throw new PartyAuthorityError("PARTY_NOT_LEADER", "Only the party leader can perform this action");
  }
}
