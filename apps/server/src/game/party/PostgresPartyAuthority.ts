import type pg from "pg";
import { enqueueNativePush, type NativePushAudience } from "../../notifications/nativePushOutbox.js";
import { PARTY_MEMBER_CAPACITY } from "@ash-atlas/shared";

import {
  InMemoryPartyAuthority,
  PARTY_INVITE_TTL_MS,
  PartyAuthorityError,
  type MutablePartyAuthority,
  type PartyInviteSnapshot,
  type PartyOutgoingInviteSnapshot,
  type PartySnapshot
} from "./PartyAuthority.js";

const PARTY_LEASE_KEY_A = 1_094_597_043;
const PARTY_LEASE_KEY_B = 1_346_458_196;

type PartyRow = {
  party_id: string;
  leader_player_id: string;
  allow_party_travel: boolean;
  revision: string | number;
  membership_revision: string | number;
  player_id: string;
  auto_follow_party_leader: boolean;
  slot_index: number;
};

type InviteRow = {
  id: string;
  party_id: string;
  leader_player_id: string;
  invited_by_player_id: string;
  target_player_id: string;
  status: PartyInviteSnapshot["status"];
  issued_at: Date | string;
  expires_at: Date | string;
  responded_at: Date | string | null;
  updated_at: Date | string;
};

type AuthorityState = {
  parties: PartySnapshot[];
  invites: PartyInviteSnapshot[];
};

type PartyOperation =
  | "create"
  | "invite"
  | "invite_to_party"
  | "accept"
  | "forward"
  | "decline"
  | "cancel"
  | "remove"
  | "leave"
  | "change_leader"
  | "set_travel_allowed"
  | "set_auto_follow"
  | "disband";

type DatabaseError = Error & { code?: string; constraint?: string };

export class PostgresPartyAuthority implements MutablePartyAuthority {
  private readonly cache = new InMemoryPartyAuthority();
  private mutationTail: Promise<void> = Promise.resolve();
  private leaseClient: pg.PoolClient | null = null;
  private initialized = false;
  private closing = false;

  constructor(private readonly pool: pg.Pool, private readonly pushEnqueueEnabled = false, private readonly pushAudience?: NativePushAudience) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.enqueue(async () => {
      const leaseClient = await this.pool.connect();
      try {
        const lease = await leaseClient.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock($1,$2) AS acquired`,
          [PARTY_LEASE_KEY_A, PARTY_LEASE_KEY_B]
        );
        if (!lease.rows[0]?.acquired) {
          throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Another party authority owns the writer lease");
        }
        const state = await readAuthorityState(leaseClient);
        this.cache.loadSnapshots(state.parties);
        this.cache.loadInvites(state.invites);
        this.leaseClient = leaseClient;
        this.initialized = true;
        this.closing = false;
      } catch (error) {
        leaseClient.release();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.mutationTail;
    const leaseClient = this.leaseClient;
    this.leaseClient = null;
    this.initialized = false;
    if (!leaseClient) return;
    try {
      await leaseClient.query(`SELECT pg_advisory_unlock($1,$2)`, [PARTY_LEASE_KEY_A, PARTY_LEASE_KEY_B]);
    } finally {
      leaseClient.release();
    }
  }

  async reconcileCache(): Promise<void> {
    this.requireInitialized();
    await this.enqueue(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        const state = await readAuthorityState(client);
        await client.query("COMMIT");
        this.cache.loadSnapshots(state.parties);
        this.cache.loadInvites(state.invites);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  partyForPlayer(playerId: string): PartySnapshot | null {
    this.requireInitialized();
    return this.cache.partyForPlayer(playerId);
  }

  sameParty(leftPlayerId: string, rightPlayerId: string): boolean {
    this.requireInitialized();
    return this.cache.sameParty(leftPlayerId, rightPlayerId);
  }

  invitesForPlayer(playerId: string): readonly PartyInviteSnapshot[] {
    this.requireInitialized();
    return this.cache.invitesForPlayer(playerId);
  }

  inboxInvitesForPlayer(playerId: string): readonly PartyInviteSnapshot[] {
    this.requireInitialized();
    return this.cache.inboxInvitesForPlayer(playerId);
  }

  outgoingInvitesForParty(partyId: string): readonly PartyOutgoingInviteSnapshot[] {
    this.requireInitialized();
    return this.cache.outgoingInvitesForParty(partyId);
  }

  async createParty(
    partyId: string,
    leaderPlayerId: string,
    requestId: string
  ): Promise<PartySnapshot> {
    requireIdentifier(partyId, "partyId");
    requireIdentifier(leaderPlayerId, "leaderPlayerId");
    return this.runMutation(
      "create",
      leaderPlayerId,
      requestId,
      {},
      async (client) => {
        await client.query(
          `INSERT INTO parties (party_id, leader_player_id, revision, membership_revision)
           VALUES ($1,$2,1,1)`,
          [partyId, leaderPlayerId]
        );
        await client.query(
          `INSERT INTO party_members (party_id, player_id, slot_index) VALUES ($1,$2,0)`,
          [partyId, leaderPlayerId]
        );
        await invalidatePendingInvitesForTarget(client, leaderPlayerId);
        return partyId;
      },
      (createdPartyId) => requireSnapshot(this.cache.party(createdPartyId), "Created party was not hydrated")
    );
  }

  async inviteMember(
    targetPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): Promise<PartyInviteSnapshot> {
    requireIdentifier(targetPlayerId, "targetPlayerId");
    return this.runMutation(
      "invite",
      actorPlayerId,
      requestId,
      { targetPlayerId },
      async (client) => {
        const party = await lockActorParty(client, actorPlayerId);
        const partyId = party.party_id;
        requireLeaderActor(party, actorPlayerId);
        await lockSocialPair(client, actorPlayerId, targetPlayerId);
        await assertPartyRelationshipAvailable(client, actorPlayerId, targetPlayerId, "invite");
        await assertInvitationTargetAvailable(client, partyId, targetPlayerId);
        const expiresAt = new Date(Date.now() + PARTY_INVITE_TTL_MS);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO party_invites (
             id, party_id, leader_player_id, target_player_id,
             invited_by_player_id, issued_at, expires_at
           ) VALUES (gen_random_uuid(),$1,$3,$2,$3,now(),$4)
           ON CONFLICT (party_id, target_player_id) WHERE status = 'pending' DO UPDATE SET
             invited_by_player_id = EXCLUDED.invited_by_player_id,
             leader_player_id = EXCLUDED.leader_player_id,
             issued_at = EXCLUDED.issued_at,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()
           RETURNING id`,
          [partyId, targetPlayerId, actorPlayerId, expiresAt]
        );
        await enqueueNativePush(client, { enabled: this.pushEnqueueEnabled, audience:this.pushAudience, kind: "party_invite", playerId: targetPlayerId, sourceId: inserted.rows[0]!.id, eventKey: `party:${inserted.rows[0]!.id}`, expiresAt });
        return { invitationId: inserted.rows[0]!.id, partyId, targetPlayerId };
      },
      ({ invitationId, targetPlayerId: invitedPlayerId }) =>
        requireInvite(this.cache.invitesForPlayer(invitedPlayerId), invitationId)
    );
  }

  async inviteToParty(
    targetPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): Promise<PartyInviteSnapshot> {
    requireIdentifier(targetPlayerId, "targetPlayerId");
    try {
      return await this.runMutation(
        "invite_to_party",
        actorPlayerId,
        requestId,
        { targetPlayerId },
        async (client) => {
          await lockSocialPair(client, actorPlayerId, targetPlayerId);
          await assertPartyRelationshipAvailable(client, actorPlayerId, targetPlayerId, "invite");
          const actorMembership = await client.query<{
            party_id: string;
            leader_player_id: string;
          }>(
            `SELECT party.party_id, party.leader_player_id
             FROM parties party
             JOIN party_members member ON member.party_id = party.party_id
             WHERE member.player_id = $1
             FOR UPDATE OF party`,
            [actorPlayerId]
          );
          let partyId = actorMembership.rows[0]?.party_id;
          if (partyId) {
            requireLeaderActor(actorMembership.rows[0]!, actorPlayerId);
          } else {
            partyId = `party:${crypto.randomUUID()}`;
            await client.query(
              `INSERT INTO parties (party_id, leader_player_id, revision, membership_revision)
               VALUES ($1,$2,1,1)`,
              [partyId, actorPlayerId]
            );
            await client.query(
              `INSERT INTO party_members (party_id, player_id, slot_index) VALUES ($1,$2,0)`,
              [partyId, actorPlayerId]
            );
            await invalidatePendingInvitesForTarget(client, actorPlayerId);
          }
          await assertInvitationTargetAvailable(client, partyId, targetPlayerId);

          const expiresAt = new Date(Date.now() + PARTY_INVITE_TTL_MS);
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO party_invites (
               id, party_id, leader_player_id, target_player_id,
               invited_by_player_id, issued_at, expires_at
             ) VALUES (gen_random_uuid(),$1,$3,$2,$3,now(),$4)
             ON CONFLICT (party_id, target_player_id) WHERE status = 'pending' DO UPDATE SET
               invited_by_player_id = EXCLUDED.invited_by_player_id,
               leader_player_id = EXCLUDED.leader_player_id,
               issued_at = EXCLUDED.issued_at,
               expires_at = EXCLUDED.expires_at,
               updated_at = now()
             RETURNING id`,
            [partyId, targetPlayerId, actorPlayerId, expiresAt]
          );
          await enqueueNativePush(client, { enabled: this.pushEnqueueEnabled, audience:this.pushAudience, kind: "party_invite", playerId: targetPlayerId, sourceId: inserted.rows[0]!.id, eventKey: `party:${inserted.rows[0]!.id}`, expiresAt });
          return { invitationId: inserted.rows[0]!.id, targetPlayerId };
        },
        ({ invitationId, targetPlayerId: invitedPlayerId }) =>
          requireInvite(this.cache.invitesForPlayer(invitedPlayerId), invitationId)
      );
    } catch (error) {
      if (isPartyError(error, "PARTY_REQUEST_DUPLICATE")) {
        const party = this.cache.partyForPlayer(actorPlayerId);
        const invite = this.cache.invitesForPlayer(targetPlayerId).find(
          (candidate) =>
            candidate.partyId === party?.partyId &&
            candidate.inviterPlayerId === actorPlayerId &&
            candidate.status === "pending"
        );
        if (invite) return invite;
      }
      throw error;
    }
  }

  async acceptInvite(invitationId: string, playerId: string, requestId: string): Promise<PartySnapshot> {
    try {
      return await this.runMutation(
      "accept",
      playerId,
      requestId,
      { invitationId },
      async (client) => {
        const invite = await lockInvite(client, invitationId, playerId);
        const partyId = invite.party_id;
        const party = await lockParty(client, partyId);
        await lockSocialPair(client, party.leader_player_id, playerId);
        await assertPartyRelationshipAvailable(client, party.leader_player_id, playerId, "join");
        if (new Date(invite.expires_at).getTime() <= Date.now()) {
          throw new PartyAuthorityError("PARTY_INVITE_EXPIRED", "Party invitation has expired");
        }
        const membership = await client.query<{ party_id: string }>(
          `SELECT party_id FROM party_members WHERE player_id = $1 FOR UPDATE`,
          [playerId]
        );
        const existingPartyId = membership.rows[0]?.party_id;
        let movedPlayerIds = [playerId];
        if (existingPartyId && existingPartyId !== partyId) {
          const sourceParty = await lockParty(client, existingPartyId);
          if (sourceParty.leader_player_id !== playerId) {
            throw new PartyAuthorityError(
              "PARTY_TARGET_NOT_LEADER",
              "Only your party leader can accept a party merge."
            );
          }
          const sourceMembers = await client.query<{ player_id: string }>(
            `SELECT player_id
             FROM party_members
             WHERE party_id = $1
             ORDER BY slot_index, player_id
             FOR UPDATE`,
            [existingPartyId]
          );
          movedPlayerIds = sourceMembers.rows.map(({ player_id }) => player_id);
          await assertPartyCanReceiveMembers(
            client,
            partyId,
            movedPlayerIds.length,
            "No space. The combined party would exceed five members."
          );
          for (const memberPlayerId of movedPlayerIds) {
            await lockSocialPair(client, party.leader_player_id, memberPlayerId);
            await assertPartyRelationshipAvailable(client, party.leader_player_id, memberPlayerId, "join");
          }
          await client.query(
            `UPDATE party_invites
             SET status = 'invalidated', responded_at = now(), updated_at = now()
             WHERE party_id = $1 AND status = 'pending'`,
            [existingPartyId]
          );
          await client.query(`DELETE FROM party_members WHERE party_id = $1`, [existingPartyId]);
          for (const memberPlayerId of movedPlayerIds) {
            await insertPartyMember(client, partyId, memberPlayerId);
          }
          await client.query(
            `UPDATE parties
             SET revision = revision + 1,
                 membership_revision = membership_revision + 1
             WHERE party_id = $1`,
            [partyId]
          );
        } else if (!existingPartyId) {
          await assertPartyCanReceiveMembers(client, partyId, 1, "The party is full.");
          await insertPartyMember(client, partyId, playerId);
          await client.query(
            `UPDATE parties
             SET revision = revision + 1,
                 membership_revision = membership_revision + 1
             WHERE party_id = $1`,
            [partyId]
          );
        }
        await client.query(
          `UPDATE party_invites
           SET status = CASE WHEN id = $2 THEN 'accepted' ELSE 'invalidated' END,
               responded_at = now(), updated_at = now()
           WHERE target_player_id = ANY($1::text[]) AND status = 'pending'`,
          [movedPlayerIds, invite.id]
        );
        return partyId;
      },
      (acceptedPartyId) => requireSnapshot(this.cache.party(acceptedPartyId), "Accepted party was not hydrated")
      );
    } catch (error) {
      if (isPartyError(error, "PARTY_REQUEST_DUPLICATE")) {
        const receipt = this.cache.inboxInvitesForPlayer(playerId)
          .find((invite) =>
            invite.invitationId === invitationId || invite.partyId === invitationId
          );
        const party = this.cache.partyForPlayer(playerId);
        if (receipt?.status === "accepted" && party?.partyId === receipt.partyId) return party;
      }
      throw error;
    }
  }

  async forwardInvite(
    invitationId: string,
    playerId: string,
    requestId: string
  ): Promise<PartyInviteSnapshot> {
    try {
      return await this.runMutation(
        "forward",
        playerId,
        requestId,
        { invitationId },
        async (client) => {
          const invite = await lockInvite(client, invitationId, playerId);
          const sourceParty = await lockActorParty(client, playerId);
          if (sourceParty.leader_player_id === playerId) {
            throw new PartyAuthorityError(
              "PARTY_UNAVAILABLE",
              "You are the party leader and can accept this merge directly."
            );
          }
          if (sourceParty.party_id === invite.party_id) {
            throw new PartyAuthorityError("PLAYER_ALREADY_IN_PARTY", "Player already belongs to your party.");
          }
          const destinationParty = await lockParty(client, invite.party_id);
          const sourceMembers = await client.query<{ player_id: string }>(
            `SELECT player_id FROM party_members WHERE party_id = $1 ORDER BY slot_index, player_id FOR UPDATE`,
            [sourceParty.party_id]
          );
          await assertPartyCanReceiveMembers(
            client,
            invite.party_id,
            sourceMembers.rowCount ?? sourceMembers.rows.length,
            "No space. The combined party would exceed five members."
          );
          await lockSocialPair(client, destinationParty.leader_player_id, sourceParty.leader_player_id);
          await assertPartyRelationshipAvailable(
            client,
            destinationParty.leader_player_id,
            sourceParty.leader_player_id,
            "invite"
          );
          const alreadyPending = await client.query(
            `SELECT 1 FROM party_invites
             WHERE party_id = $1 AND target_player_id = $2 AND status = 'pending' AND id <> $3
             FOR UPDATE`,
            [invite.party_id, sourceParty.leader_player_id, invite.id]
          );
          if (alreadyPending.rowCount) {
            throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Your party leader already has this invitation.");
          }
          await client.query(
            `UPDATE party_invites SET target_player_id = $2, updated_at = now() WHERE id = $1`,
            [invite.id, sourceParty.leader_player_id]
          );
          return { invitationId: invite.id, leaderPlayerId: sourceParty.leader_player_id };
        },
        ({ invitationId: forwardedInvitationId, leaderPlayerId }) =>
          requireInvite(this.cache.invitesForPlayer(leaderPlayerId), forwardedInvitationId)
      );
    } catch (error) {
      if (isPartyError(error, "PARTY_REQUEST_DUPLICATE")) {
        const forwarded = await this.pool.query<InviteRow>(
          `SELECT invite.id, invite.party_id, invite.leader_player_id, invite.invited_by_player_id,
                  invite.target_player_id, invite.status, invite.issued_at, invite.expires_at,
                  invite.responded_at, invite.updated_at
           FROM party_invites invite
           WHERE invite.id::text = $1`,
          [invitationId]
        );
        if (forwarded.rows[0] && forwarded.rows[0].target_player_id !== playerId) {
          return inviteSnapshotFromRow(forwarded.rows[0]);
        }
      }
      throw error;
    }
  }

  async declineInvite(invitationId: string, playerId: string, requestId: string): Promise<boolean> {
    try {
      return await this.runMutation(
      "decline",
      playerId,
      requestId,
      { invitationId },
      async (client) => {
        const updated = await client.query(
          `UPDATE party_invites SET status = 'declined', responded_at = now(), updated_at = now()
           WHERE (id::text = $1 OR party_id = $1) AND target_player_id = $2 AND status = 'pending'`,
          [invitationId, playerId]
        );
        if (!updated.rowCount) {
          throw new PartyAuthorityError("PARTY_INVITE_NOT_FOUND", "Party invitation does not exist");
        }
        return true;
      },
      (updated) => updated
      );
    } catch (error) {
      if (
        isPartyError(error, "PARTY_REQUEST_DUPLICATE") &&
        this.cache.inboxInvitesForPlayer(playerId).some(
          (invite) =>
            (invite.invitationId === invitationId || invite.partyId === invitationId) &&
            invite.status === "declined"
        )
      ) return true;
      throw error;
    }
  }

  async cancelInvite(invitationId: string, playerId: string, requestId: string): Promise<boolean> {
    return this.runMutation(
      "cancel",
      playerId,
      requestId,
      { invitationId },
      async (client) => {
        const updated = await client.query(
          `UPDATE party_invites SET status = 'cancelled', responded_at = now(), updated_at = now()
           WHERE id = $1 AND invited_by_player_id = $2 AND status = 'pending'`,
          [invitationId, playerId]
        );
        if (!updated.rowCount) {
          throw new PartyAuthorityError("PARTY_INVITE_NOT_FOUND", "Party invitation does not exist");
        }
        return true;
      },
      (updated) => updated
    );
  }

  async removePartyMember(
    playerId: string,
    actorPlayerId: string,
    requestId: string
  ): Promise<PartySnapshot | null> {
    return this.runMutation(
      "remove",
      actorPlayerId,
      requestId,
      { playerId },
      async (client) => {
        const party = await lockActorParty(client, actorPlayerId);
        const partyId = party.party_id;
        requireLeaderActor(party, actorPlayerId);
        const member = await client.query(
          `SELECT 1 FROM party_members WHERE party_id = $1 AND player_id = $2`,
          [partyId, playerId]
        );
        if (!member.rowCount) {
          throw new PartyAuthorityError("PARTY_MEMBER_NOT_FOUND", "Player is not a member of the party");
        }
        await client.query(`DELETE FROM party_members WHERE party_id = $1 AND player_id = $2`, [partyId, playerId]);
        await invalidateInvitesAfterMemberDeparture(client, partyId, playerId);
        return partyId;
      },
      (updatedPartyId) => this.cache.party(updatedPartyId)
    );
  }

  async leaveParty(playerId: string, requestId: string): Promise<PartySnapshot | null> {
    return this.runMutation(
      "leave",
      playerId,
      requestId,
      {},
      async (client) => {
        const party = await lockActorParty(client, playerId);
        await client.query(
          `DELETE FROM party_members WHERE party_id = $1 AND player_id = $2`,
          [party.party_id, playerId]
        );
        await invalidateInvitesAfterMemberDeparture(client, party.party_id, playerId);
        return party.party_id;
      },
      (updatedPartyId) => this.cache.party(updatedPartyId)
    );
  }

  async changePartyLeader(
    leaderPlayerId: string,
    actorPlayerId: string,
    requestId: string
  ): Promise<PartySnapshot> {
    return this.runMutation(
      "change_leader",
      actorPlayerId,
      requestId,
      { leaderPlayerId },
      async (client) => {
        const party = await lockActorParty(client, actorPlayerId);
        const partyId = party.party_id;
        requireLeaderActor(party, actorPlayerId);
        const member = await client.query(
          `SELECT 1 FROM party_members WHERE party_id = $1 AND player_id = $2`,
          [partyId, leaderPlayerId]
        );
        if (!member.rowCount) {
          throw new PartyAuthorityError(
            "PARTY_LEADER_NOT_MEMBER",
            `Player ${leaderPlayerId} is not a member of party ${partyId}`
          );
        }
        if (party.leader_player_id !== leaderPlayerId) {
          await client.query(
            `UPDATE parties
             SET leader_player_id = $2, allow_party_travel = false, revision = revision + 1
             WHERE party_id = $1`,
            [partyId, leaderPlayerId]
          );
          await client.query(
            `UPDATE party_invites SET leader_player_id = $2, updated_at = now()
             WHERE party_id = $1 AND status = 'pending'`,
            [partyId, leaderPlayerId]
          );
        }
        return partyId;
      },
      (updatedPartyId) => requireSnapshot(this.cache.party(updatedPartyId), "Updated party was not hydrated")
    );
  }

  async setTravelAllowed(
    actorPlayerId: string,
    requestId: string,
    allowed: boolean
  ): Promise<PartySnapshot> {
    return this.runMutation(
      "set_travel_allowed",
      actorPlayerId,
      requestId,
      { allowed },
      async (client) => {
        const party = await lockActorParty(client, actorPlayerId);
        requireLeaderActor(party, actorPlayerId);
        if (party.allow_party_travel !== allowed) {
          await client.query(
            `UPDATE parties SET allow_party_travel = $2, revision = revision + 1 WHERE party_id = $1`,
            [party.party_id, allowed]
          );
        }
        return party.party_id;
      },
      (partyId) => requireSnapshot(this.cache.party(partyId), "Updated party travel setting was not hydrated")
    );
  }

  async setAutoFollow(
    playerId: string,
    requestId: string,
    enabled: boolean
  ): Promise<PartySnapshot> {
    return this.runMutation(
      "set_auto_follow",
      playerId,
      requestId,
      { enabled },
      async (client) => {
        const party = await lockActorParty(client, playerId);
        const changed = await client.query(
          `UPDATE party_members
           SET auto_follow_party_leader = $3
           WHERE party_id = $1 AND player_id = $2
             AND auto_follow_party_leader IS DISTINCT FROM $3`,
          [party.party_id, playerId, enabled]
        );
        if (changed.rowCount) {
          await client.query(`UPDATE parties SET revision = revision + 1 WHERE party_id = $1`, [party.party_id]);
        }
        return party.party_id;
      },
      (partyId) => requireSnapshot(this.cache.party(partyId), "Updated auto-follow setting was not hydrated")
    );
  }

  async disbandParty(partyId: string, actorPlayerId: string, requestId: string): Promise<boolean> {
    return this.runMutation(
      "disband",
      actorPlayerId,
      requestId,
      { partyId },
      async (client) => {
        const party = await client.query<{ leader_player_id: string }>(
          `SELECT leader_player_id FROM parties WHERE party_id = $1 FOR UPDATE`,
          [partyId]
        );
        if (!party.rowCount) return false;
        requireLeaderActor(party.rows[0]!, actorPlayerId);
        await client.query(
          `UPDATE party_invites SET status = 'invalidated', responded_at = now(), updated_at = now()
           WHERE party_id = $1 AND status = 'pending'`,
          [partyId]
        );
        const deleted = await client.query(`DELETE FROM parties WHERE party_id = $1`, [partyId]);
        return Boolean(deleted.rowCount);
      },
      (deleted) => deleted
    );
  }

  private async runMutation<T, R>(
    action: PartyOperation,
    actorPlayerId: string,
    requestId: string,
    payload: unknown,
    mutation: (client: pg.PoolClient) => Promise<T>,
    resolve: (value: T) => R
  ): Promise<R> {
    this.requireInitialized();
    requireIdentifier(actorPlayerId, "actorPlayerId");
    requireIdentifier(requestId, "requestId");
    return this.enqueue(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await reserveOperation(client, actorPlayerId, requestId, action, payload);
        const value = await mutation(client);
        await client.query(
          `UPDATE party_operations SET completed_at = now() WHERE player_id = $1 AND request_id = $2`,
          [actorPlayerId, requestId]
        );
        const state = await readAuthorityState(client);
        await client.query("COMMIT");
        this.cache.loadSnapshots(state.parties);
        this.cache.loadInvites(state.invites);
        return resolve(value);
      } catch (error) {
        await client.query("ROLLBACK");
        throw translateDatabaseError(error);
      } finally {
        client.release();
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireInitialized(): void {
    if (!this.initialized || this.closing) {
      throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Party authority is not available");
    }
  }
}

async function reserveOperation(
  client: pg.PoolClient,
  playerId: string,
  requestId: string,
  action: PartyOperation,
  payload: unknown
): Promise<void> {
  const serializedPayload = JSON.stringify(payload);
  const inserted = await client.query(
    `INSERT INTO party_operations (player_id, request_id, action, payload)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (player_id, request_id) DO NOTHING
     RETURNING request_id`,
    [playerId, requestId, action, serializedPayload]
  );
  if (inserted.rowCount) return;
  const existing = await client.query<{ action: string; payload_matches: boolean }>(
    `SELECT action, payload = $3::jsonb AS payload_matches
     FROM party_operations WHERE player_id = $1 AND request_id = $2`,
    [playerId, requestId, serializedPayload]
  );
  const row = existing.rows[0];
  if (!row || row.action !== action || !row.payload_matches) {
    throw new PartyAuthorityError("PARTY_OPERATION_CONFLICT", "Party request ID conflicts with another operation");
  }
  throw new PartyAuthorityError("PARTY_REQUEST_DUPLICATE", "Party request was already committed");
}

async function readAuthorityState(
  queryable: Pick<pg.Pool, "query"> | pg.PoolClient
): Promise<AuthorityState> {
  await queryable.query(
    `UPDATE party_invites
     SET status = 'expired', responded_at = now(), updated_at = now()
     WHERE status = 'pending' AND expires_at <= now()`
  );
  const [partyResult, inviteResult] = await Promise.all([
    queryable.query<PartyRow>(
      `SELECT party.party_id, party.leader_player_id, party.allow_party_travel,
              party.revision, party.membership_revision, member.player_id,
              member.auto_follow_party_leader, member.slot_index
       FROM parties party
       JOIN party_members member ON member.party_id = party.party_id
       ORDER BY party.party_id, member.slot_index, member.player_id`
    ),
    queryable.query<InviteRow>(
      `SELECT invite.id, invite.party_id, invite.leader_player_id, invite.invited_by_player_id,
              invite.target_player_id, invite.status, invite.issued_at, invite.expires_at,
              invite.responded_at, invite.updated_at
       FROM party_invites invite
       WHERE invite.status = 'pending' OR invite.updated_at > now() - interval '90 days'
       ORDER BY invite.target_player_id, invite.party_id`
    )
  ]);
  return {
    parties: [...partySnapshotsById(partyResult.rows).values()],
    invites: inviteResult.rows.map(inviteSnapshotFromRow)
  };
}

function partySnapshotsById(rows: PartyRow[]): Map<string, PartySnapshot> {
  const parties = new Map<string, {
    leaderPlayerId: string;
    allowTravel: boolean;
    revision: number;
    membershipRevision: number;
    memberPlayerIds: string[];
    memberSlots: Array<{ playerId: string; slotIndex: number }>;
    autoFollowPlayerIds: string[];
  }>();
  for (const row of rows) {
    const existing = parties.get(row.party_id);
    if (existing) {
      existing.memberPlayerIds.push(row.player_id);
      existing.memberSlots.push({ playerId: row.player_id, slotIndex: row.slot_index });
      if (row.auto_follow_party_leader) existing.autoFollowPlayerIds.push(row.player_id);
    }
    else parties.set(row.party_id, {
      leaderPlayerId: row.leader_player_id,
      allowTravel: row.allow_party_travel,
      revision: Number(row.revision),
      membershipRevision: Number(row.membership_revision),
      memberPlayerIds: [row.player_id],
      memberSlots: [{ playerId: row.player_id, slotIndex: row.slot_index }],
      autoFollowPlayerIds: row.auto_follow_party_leader ? [row.player_id] : []
    });
  }
  return new Map(
    [...parties.entries()].map(([partyId, party]) => [partyId, { partyId, ...party }])
  );
}

function inviteSnapshotFromRow(row: InviteRow): PartyInviteSnapshot {
  return {
    invitationId: row.id,
    partyId: row.party_id,
    leaderPlayerId: row.leader_player_id,
    inviterPlayerId: row.invited_by_player_id,
    targetPlayerId: row.target_player_id,
    perspective: "incoming",
    status: row.status,
    createdAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

async function lockParty(
  client: pg.PoolClient,
  partyId: string
): Promise<{ leader_player_id: string; revision: string | number }> {
  const result = await client.query<{ leader_player_id: string; revision: string | number }>(
    `SELECT leader_player_id, revision FROM parties WHERE party_id = $1 FOR UPDATE`,
    [partyId]
  );
  const party = result.rows[0];
  if (!party) throw new PartyAuthorityError("PARTY_NOT_FOUND", `Party ${partyId} does not exist`);
  return party;
}

async function lockActorParty(
  client: pg.PoolClient,
  playerId: string
): Promise<{
  party_id: string;
  leader_player_id: string;
  allow_party_travel: boolean;
  revision: string | number;
}> {
  const result = await client.query<{
    party_id: string;
    leader_player_id: string;
    allow_party_travel: boolean;
    revision: string | number;
  }>(
    `SELECT party.party_id, party.leader_player_id, party.allow_party_travel, party.revision
     FROM parties party
     JOIN party_members member ON member.party_id = party.party_id
     WHERE member.player_id = $1
     FOR UPDATE OF party`,
    [playerId]
  );
  const party = result.rows[0];
  if (!party) throw new PartyAuthorityError("PARTY_NOT_FOUND", "Player does not belong to a party");
  return party;
}

async function lockInvite(
  client: pg.PoolClient,
  invitationId: string,
  playerId: string
): Promise<{ id: string; party_id: string; expires_at: Date | string }> {
  const result = await client.query<{
    id: string;
    party_id: string;
    expires_at: Date | string;
    status: PartyInviteSnapshot["status"];
  }>(
    `SELECT id, party_id, expires_at, status FROM party_invites
     WHERE (id::text = $1 OR party_id = $1) AND target_player_id = $2
     ORDER BY (status = 'pending') DESC, updated_at DESC
     LIMIT 1
     FOR UPDATE`,
    [invitationId, playerId]
  );
  const invite = result.rows[0];
  if (!invite) throw new PartyAuthorityError("PARTY_INVITE_NOT_FOUND", "Party invitation does not exist");
  if (invite.status === "expired") {
    throw new PartyAuthorityError("PARTY_INVITE_EXPIRED", "Party invitation has expired");
  }
  if (invite.status !== "pending") {
    throw new PartyAuthorityError("PARTY_INVITE_NOT_FOUND", "Party invitation is no longer pending");
  }
  return invite;
}

async function invalidatePendingInvitesForTarget(
  client: pg.PoolClient,
  playerId: string
): Promise<void> {
  await client.query(
    `UPDATE party_invites SET status = 'invalidated', responded_at = now(), updated_at = now()
     WHERE target_player_id = $1 AND status = 'pending'`,
    [playerId]
  );
}

async function invalidateInvitesAfterMemberDeparture(
  client: pg.PoolClient,
  partyId: string,
  playerId: string
): Promise<void> {
  await client.query(
    `UPDATE party_invites SET status = 'invalidated', responded_at = now(), updated_at = now()
     WHERE status = 'pending'
       AND (invited_by_player_id = $2 OR (party_id = $1 AND NOT EXISTS (
         SELECT 1 FROM parties WHERE party_id = $1
       )))`,
    [partyId, playerId]
  );
}

async function assertInvitationTargetAvailable(
  client: pg.PoolClient,
  destinationPartyId: string,
  targetPlayerId: string
): Promise<void> {
  const targetParty = await client.query<{ party_id: string }>(
    `SELECT party.party_id
     FROM party_members target
     JOIN parties party ON party.party_id = target.party_id
     WHERE target.player_id = $1
     FOR UPDATE OF party`,
    [targetPlayerId]
  );
  const source = targetParty.rows[0];
  if (!source) {
    await assertPartyCanReceiveMembers(client, destinationPartyId, 1, "Your party is full.");
    return;
  }
  if (source.party_id === destinationPartyId) {
    throw new PartyAuthorityError("PLAYER_ALREADY_IN_PARTY", "Player already belongs to your party.");
  }
  await assertPartyCanReceiveMembers(
    client,
    destinationPartyId,
    await partyMemberCount(client, source.party_id),
    "No space. The combined party would exceed five members."
  );
}

async function partyMemberCount(client: pg.PoolClient, partyId: string): Promise<number> {
  const result = await client.query<{ member_count: string | number }>(
    `SELECT count(*) AS member_count FROM party_members WHERE party_id = $1`,
    [partyId]
  );
  return Number(result.rows[0]?.member_count ?? 0);
}

async function assertPartyCanReceiveMembers(
  client: pg.PoolClient,
  partyId: string,
  incomingMemberCount: number,
  message: string
): Promise<void> {
  if (await partyMemberCount(client, partyId) + incomingMemberCount > PARTY_MEMBER_CAPACITY) {
    throw new PartyAuthorityError("PARTY_FULL", message);
  }
}

async function insertPartyMember(
  client: pg.PoolClient,
  partyId: string,
  playerId: string
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO party_members (party_id, player_id, slot_index)
     SELECT $1, $2, candidate.slot_index
     FROM generate_series(0, $3 - 1) AS candidate(slot_index)
     WHERE NOT EXISTS (
       SELECT 1 FROM party_members
       WHERE party_id = $1 AND slot_index = candidate.slot_index
     )
     ORDER BY candidate.slot_index
     LIMIT 1`,
    [partyId, playerId, PARTY_MEMBER_CAPACITY]
  );
  if (!inserted.rowCount) {
    throw new PartyAuthorityError("PARTY_FULL", "No space. The party is full.");
  }
}

async function lockSocialPair(
  client: pg.PoolClient,
  leftPlayerId: string,
  rightPlayerId: string
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(LEAST($1, $2) || chr(31) || GREATEST($1, $2), 0)
     )`,
    [leftPlayerId, rightPlayerId]
  );
}

async function assertPartyRelationshipAvailable(
  client: pg.PoolClient,
  leftPlayerId: string,
  rightPlayerId: string,
  action: "invite" | "join"
): Promise<void> {
  const result = await client.query<{ enemies: boolean; blocked: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM player_enemy_marks
         WHERE owner_id = LEAST($1, $2) AND target_id = GREATEST($1, $2)
       ) AS enemies,
       EXISTS (
         SELECT 1 FROM player_blocks
         WHERE (blocker_id = $1 AND blocked_id = $2)
            OR (blocker_id = $2 AND blocked_id = $1)
       ) AS blocked`,
    [leftPlayerId, rightPlayerId]
  );
  if (result.rows[0]?.enemies) {
    throw new PartyAuthorityError(
      "PARTY_TARGET_ENEMY",
      action === "invite"
        ? "You cannot invite an enemy to your party."
        : "You cannot join an enemy's party."
    );
  }
  if (result.rows[0]?.blocked) {
    throw new PartyAuthorityError(
      "PARTY_TARGET_BLOCKED",
      "Party invitation is unavailable."
    );
  }
}

function translateDatabaseError(error: unknown): unknown {
  if (error instanceof PartyAuthorityError) return error;
  const databaseError = error as DatabaseError;
  if (databaseError.code === "23505") {
    if (databaseError.constraint === "party_members_one_party_per_player_key") {
      return new PartyAuthorityError("PLAYER_ALREADY_IN_PARTY", "Player already belongs to another party");
    }
    if (databaseError.constraint === "parties_pkey") {
      return new PartyAuthorityError("PARTY_ALREADY_EXISTS", "Party already exists");
    }
  }
  return error;
}

function requireInvite(invites: readonly PartyInviteSnapshot[], invitationId: string): PartyInviteSnapshot {
  const invite = invites.find((candidate) => candidate.invitationId === invitationId);
  if (!invite) throw new Error("Committed party invitation was not hydrated");
  return invite;
}

function requireSnapshot(snapshot: PartySnapshot | null, message: string): PartySnapshot {
  if (!snapshot) throw new Error(message);
  return snapshot;
}

function requireIdentifier(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
}

function isPartyError(error: unknown, code: string): error is PartyAuthorityError {
  return error instanceof PartyAuthorityError && error.code === code;
}

function requireLeaderActor(
  party: { leader_player_id: string },
  actorPlayerId: string | undefined
): void {
  if (actorPlayerId !== undefined && party.leader_player_id !== actorPlayerId) {
    throw new PartyAuthorityError("PARTY_NOT_LEADER", "Only the party leader can perform this action");
  }
}
