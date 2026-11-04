import { randomUUID } from "node:crypto";

import {
  TRAVEL_INVITE_AFTER_RELOCATION_COOLDOWN_MS,
  TRAVEL_INVITE_PAIR_COOLDOWN_MS,
  TRAVEL_INVITE_TTL_MS,
  type TravelInboxEntry
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AuthoritativeTravelAnchor } from "./state.js";

export type TravelInviteDestination = Readonly<{
  inviteId: string;
  inviterPlayerId: string;
  inviteePlayerId: string;
  inviterSessionId: string;
  anchor: AuthoritativeTravelAnchor;
  expiresAt: string;
}>;

export type TravelInviteErrorCode =
  | "TRAVEL_INVITE_NOT_FOUND"
  | "TRAVEL_INVITE_TARGET_INVALID"
  | "TRAVEL_INVITE_EXISTS"
  | "TRAVEL_INVITE_FORBIDDEN"
  | "TRAVEL_INVITE_RATE_LIMITED"
  | "TRAVEL_INVITE_RELOCATION_COOLDOWN"
  | "TRAVEL_INVITE_EXPIRED"
  | "TRAVEL_INVITE_NOT_PENDING"
  | "TRAVEL_INVITE_REQUEST_CONFLICT"
  // Alt doorway refusals (auth/trust/altDoorway.ts).
  | "TRAVEL_DOORWAY_UNCONFIRMED"
  | "TRAVEL_DOORWAY_NO_PRESENCE"
  | "TRAVEL_LINKED_ACCOUNT";

export class TravelInviteError extends Error {
  constructor(
    readonly code: TravelInviteErrorCode,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "TravelInviteError";
  }
}

const TRAVEL_INVITE_SEND_LIMIT = 5;
const TRAVEL_INVITE_SEND_WINDOW_MS = 60_000;

type InviteRow = {
  id: string;
  inviter_player_id: string;
  invitee_player_id: string;
  inviter_session_id: string;
  layer_scope_id: AuthoritativeTravelAnchor["scopeId"];
  layer_id: string;
  layer_relocation_revision: number | string;
  layer_generation: number | string;
  source_type: AuthoritativeTravelAnchor["sourceType"];
  source_id: string | null;
  destination_anchor_lat: number;
  destination_anchor_lon: number;
  status: "pending" | "accepting" | "accepted" | "declined" | "cancelled" | "expired" | "invalidated";
  expires_at: Date | string;
  acceptance_request_id: string | null;
};

type InvitePlayerRow = {
  id: string;
  username: string;
};

type InboxRow = {
  entry_id: string;
  invite_id: string;
  perspective: "sender" | "recipient";
  counterpart_player_id: string;
  counterpart_name: string;
  message: string;
  status: InviteRow["status"];
  invalidation_reason: string | null;
  source_type: string;
  source_id: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  responded_at: Date | string | null;
  updated_at: Date | string;
};

type OperationRow = {
  action: string;
  travel_invite_id: string | null;
  payload_matches: boolean;
  completed_at: Date | string | null;
};

export class TravelInviteService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID
  ) {}

  async send(input: {
    inviterPlayerId: string;
    inviteePlayerId: string;
    inviterSessionId: string;
    anchor: AuthoritativeTravelAnchor;
    requestId: string;
    // Runs only for a new send (never for a replay); throwing rolls back the
    // operation reservation so a later retry is checked again.
    beforeCreate?: () => Promise<void>;
  }): Promise<{ inviteId: string; playerIds: string[]; replayed: boolean }> {
    if (input.inviterPlayerId === input.inviteePlayerId) {
      throw new TravelInviteError("TRAVEL_INVITE_TARGET_INVALID", "You cannot invite yourself to travel.");
    }
    if (!validAnchor(input.anchor)) {
      throw new TravelInviteError("TRAVEL_INVITE_TARGET_INVALID", "Travel destination is invalid.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await reserveOperation(client, input.inviterPlayerId, input.requestId, "send", {
        targetPlayerId: input.inviteePlayerId
      });
      if (replay) {
        await client.query("COMMIT");
        if (!replay.travel_invite_id) throw new TravelInviteError("TRAVEL_INVITE_REQUEST_CONFLICT", "Travel invite replay is incomplete.");
        return { inviteId: replay.travel_invite_id, playerIds: [input.inviterPlayerId, input.inviteePlayerId].sort(), replayed: true };
      }
      await input.beforeCreate?.();
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('travel-invite-send:' || $1, 0))`,
        [input.inviterPlayerId]
      );
      const players = await client.query<InvitePlayerRow>(
        `SELECT id, username FROM players
         WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE`,
        [[input.inviterPlayerId, input.inviteePlayerId]]
      );
      const inviter = players.rows.find((row) => row.id === input.inviterPlayerId);
      const invitee = players.rows.find((row) => row.id === input.inviteePlayerId);
      if (!inviter || !invitee) {
        throw new TravelInviteError("TRAVEL_INVITE_TARGET_INVALID", "The selected player does not exist.");
      }
      const createdAt = this.now();
      const relocationResult = await client.query<{
        last_relocated_at: Date | string | null;
      }>(
        "SELECT last_relocated_at FROM players WHERE id = $1",
        [input.inviterPlayerId]
      );
      const lastRelocatedAt = relocationResult.rows[0]?.last_relocated_at == null
        ? null
        : asDate(relocationResult.rows[0]!.last_relocated_at);
      const inviteAvailableAt = lastRelocatedAt
        ? lastRelocatedAt.getTime() + TRAVEL_INVITE_AFTER_RELOCATION_COOLDOWN_MS
        : null;
      if (inviteAvailableAt !== null && inviteAvailableAt > createdAt.getTime()) {
        const retryAfterMs = inviteAvailableAt - createdAt.getTime();
        throw new TravelInviteError(
          "TRAVEL_INVITE_RELOCATION_COOLDOWN",
          `You cannot send Travel Invites for ${Math.ceil(retryAfterMs / 60_000)} more minutes after relocating.`,
          retryAfterMs
        );
      }
      if (await pairBlocked(client, input.inviterPlayerId, input.inviteePlayerId)) {
        throw new TravelInviteError("TRAVEL_INVITE_FORBIDDEN", "Travel invitation is unavailable.");
      }
      await expirePending(client, createdAt);
      const activePairResult = await client.query<Pick<InviteRow, "id" | "status">>(
        `SELECT id, status
         FROM travel_invites
         WHERE inviter_player_id = $1 AND invitee_player_id = $2
           AND status IN ('pending', 'accepting')
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [input.inviterPlayerId, input.inviteePlayerId]
      );
      const activePair = activePairResult.rows[0] ?? null;
      const recent = await client.query<{
        invitee_player_id: string;
        status: InviteRow["status"];
        created_at: Date | string;
      }>(
        `SELECT invitee_player_id, status, created_at
         FROM travel_invites
         WHERE inviter_player_id = $1 AND created_at > $2
         ORDER BY created_at ASC, id ASC`,
        [input.inviterPlayerId, new Date(createdAt.getTime() - TRAVEL_INVITE_SEND_WINDOW_MS)]
      );
      const latestPair = recent.rows.slice().reverse().find((row) =>
        row.invitee_player_id === input.inviteePlayerId
      );
      const latestPairElapsedMs = latestPair
        ? createdAt.getTime() - asDate(latestPair.created_at).getTime()
        : TRAVEL_INVITE_PAIR_COOLDOWN_MS;
      if (latestPair && latestPairElapsedMs < TRAVEL_INVITE_PAIR_COOLDOWN_MS) {
        const retryAfterMs = TRAVEL_INVITE_PAIR_COOLDOWN_MS - latestPairElapsedMs;
        throw new TravelInviteError(
          "TRAVEL_INVITE_RATE_LIMITED",
          `You can invite this player again in ${Math.ceil(retryAfterMs / 1_000)} seconds.`,
          retryAfterMs
        );
      }
      if (recent.rows.length >= TRAVEL_INVITE_SEND_LIMIT) {
        const retryAfterMs = Math.max(
          1,
          TRAVEL_INVITE_SEND_WINDOW_MS - (createdAt.getTime() - asDate(recent.rows[0]!.created_at).getTime())
        );
        throw new TravelInviteError(
          "TRAVEL_INVITE_RATE_LIMITED",
          "Too many Travel Invites were sent. Please wait and try again.",
          retryAfterMs
        );
      }
      if (activePair?.status === "accepting") {
        throw new TravelInviteError(
          "TRAVEL_INVITE_EXISTS",
          "This player is already accepting your Travel Invite."
        );
      }
      if (activePair) {
        await markTerminal(
          client,
          activePair.id,
          "invalidated",
          "Replaced by a newer Travel Invite.",
          createdAt
        );
      }
      const inviteId = this.createId();
      const senderEntryId = this.createId();
      const recipientEntryId = this.createId();
      const expiresAt = new Date(createdAt.getTime() + TRAVEL_INVITE_TTL_MS);
      try {
        await client.query(
          `INSERT INTO travel_invites (
             id, inviter_player_id, invitee_player_id, inviter_session_id,
             layer_scope_id, layer_id, layer_relocation_revision, layer_generation,
             source_type, source_id, destination_anchor_lat, destination_anchor_lon,
             create_request_id, created_at, expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [inviteId, input.inviterPlayerId, input.inviteePlayerId, input.inviterSessionId,
            input.anchor.scopeId, input.anchor.layerId, input.anchor.relocationRevision,
            input.anchor.layerGeneration, input.anchor.sourceType, input.anchor.sourceId,
            input.anchor.center.lat, input.anchor.center.lon, input.requestId, createdAt, expiresAt]
        );
      } catch (error) {
        if ((error as { code?: string; constraint?: string }).code === "23505") {
          throw new TravelInviteError("TRAVEL_INVITE_EXISTS", "A pending Travel Invite already exists for this player.");
        }
        throw error;
      }
      await client.query(
        `INSERT INTO player_inbox_entries (id, player_id, travel_invite_id, perspective, message, created_at)
         VALUES ($1,$2,$3,'sender',$4,$7), ($5,$6,$3,'recipient',$8,$7)`,
        [senderEntryId, input.inviterPlayerId, inviteId,
          `You invited ${invitee.username} to your current area.`, recipientEntryId, input.inviteePlayerId,
          createdAt, `${inviter.username} invited you to travel to their current area.`]
      );
      await completeOperation(client, input.inviterPlayerId, input.requestId, inviteId);
      await client.query("COMMIT");
      return { inviteId, playerIds: [input.inviterPlayerId, input.inviteePlayerId].sort(), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async inboxForPlayer(playerId: string): Promise<TravelInboxEntry[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await expirePending(client, this.now());
      const result = await client.query<InboxRow>(
        `SELECT entry.id AS entry_id, invite.id AS invite_id, entry.perspective,
                CASE WHEN entry.perspective = 'sender' THEN invite.invitee_player_id ELSE invite.inviter_player_id END AS counterpart_player_id,
                counterpart.username AS counterpart_name, entry.message, invite.status,
                invite.invalidation_reason, invite.source_type, invite.source_id, invite.created_at,
                 invite.expires_at, invite.responded_at, invite.updated_at
         FROM player_inbox_entries entry
         JOIN travel_invites invite ON invite.id = entry.travel_invite_id
         JOIN players counterpart ON counterpart.id = CASE
           WHEN entry.perspective = 'sender' THEN invite.invitee_player_id ELSE invite.inviter_player_id END
         WHERE entry.player_id = $1
         ORDER BY entry.created_at DESC, entry.id DESC
         LIMIT 100`,
        [playerId]
      );
      await client.query("COMMIT");
      return result.rows.map(inboxSnapshot);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async activeManorInviteFor(inviteePlayerId: string, manorId: string): Promise<string | null> {
    await expirePending(this.pool, this.now());
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM travel_invites
       WHERE invitee_player_id=$1 AND source_type='manor' AND source_id=$2
         AND status='pending' AND expires_at>$3
       ORDER BY created_at DESC,id DESC
       LIMIT 1`,
      [inviteePlayerId, manorId, this.now()]
    );
    return result.rows[0]?.id ?? null;
  }

  async invalidateForManor(
    manorId: string,
    reason: string,
    inviteePlayerId?: string
  ): Promise<string[]> {
    const result = await this.pool.query<{ inviter_player_id: string; invitee_player_id: string }>(
      `UPDATE travel_invites
       SET status='invalidated',invalidation_reason=$2,responded_at=$3
       WHERE source_type='manor' AND source_id=$1
         AND status IN ('pending','accepting')
         AND ($4::text IS NULL OR invitee_player_id=$4)
       RETURNING inviter_player_id,invitee_player_id`,
      [manorId, reason, this.now(), inviteePlayerId ?? null]
    );
    return uniquePlayers(result.rows);
  }

  async reserveAcceptance(inviteId: string, inviteePlayerId: string, requestId: string): Promise<TravelInviteDestination> {
    const client = await this.pool.connect();
    let committedError: TravelInviteError | null = null;
    let reservedDestination: TravelInviteDestination | null = null;
    try {
      await client.query("BEGIN");
      const replay = await reserveOperation(client, inviteePlayerId, requestId, "accept", { inviteId });
      if (replay?.completed_at) {
        throw new TravelInviteError("TRAVEL_INVITE_NOT_PENDING", "This Travel Invite was already handled.");
      }
      const result = await client.query<InviteRow>(
        `SELECT id, inviter_player_id, invitee_player_id, inviter_session_id,
                layer_scope_id, layer_id, layer_relocation_revision, layer_generation,
                source_type, source_id, destination_anchor_lat, destination_anchor_lon,
                status, expires_at, acceptance_request_id
         FROM travel_invites WHERE id = $1 FOR UPDATE`,
        [inviteId]
      );
      const invite = result.rows[0];
      if (!invite || invite.invitee_player_id !== inviteePlayerId) {
        throw new TravelInviteError("TRAVEL_INVITE_NOT_FOUND", "Travel Invite not found.");
      }
      if (invite.status === "pending" && asDate(invite.expires_at).getTime() <= this.now().getTime()) {
        await markTerminal(client, invite.id, "expired", "The Travel Invite expired.", this.now());
        await completeOperation(client, inviteePlayerId, requestId, invite.id);
        committedError = new TravelInviteError("TRAVEL_INVITE_EXPIRED", "This Travel Invite has expired.");
      } else if (await pairBlocked(client, invite.inviter_player_id, invite.invitee_player_id)) {
        await markTerminal(client, invite.id, "invalidated", "Travel invitation is unavailable.", this.now());
        await completeOperation(client, inviteePlayerId, requestId, invite.id);
        committedError = new TravelInviteError("TRAVEL_INVITE_FORBIDDEN", "Travel invitation is unavailable.");
      } else if (invite.status === "accepting" && invite.acceptance_request_id === requestId) {
        reservedDestination = destination(invite);
      } else if (invite.status !== "pending") {
        throw new TravelInviteError("TRAVEL_INVITE_NOT_PENDING", "This Travel Invite is no longer pending.");
      } else {
        await client.query(
          `UPDATE travel_invites
           SET status = 'accepting', acceptance_request_id = $2, acceptance_reserved_at = $3
           WHERE id = $1 AND status = 'pending'`,
          [invite.id, requestId, this.now()]
        );
        reservedDestination = destination(invite);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (committedError) throw committedError;
    if (!reservedDestination) {
      throw new TravelInviteError("TRAVEL_INVITE_NOT_PENDING", "Travel Invite acceptance was not reserved.");
    }
    return reservedDestination;
  }

  async completeAcceptance(inviteId: string, inviteePlayerId: string, requestId: string): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const playerIds = await this.completeAcceptanceInTransaction(
        client,
        inviteId,
        inviteePlayerId,
        requestId
      );
      await client.query("COMMIT");
      return playerIds;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeAcceptanceInTransaction(
    client: pg.PoolClient,
    inviteId: string,
    inviteePlayerId: string,
    requestId: string
  ): Promise<string[]> {
    const result = await client.query<{ inviter_player_id: string; invitee_player_id: string }>(
      `UPDATE travel_invites
       SET status = 'accepted', responded_at = $4
       WHERE id = $1 AND invitee_player_id = $2 AND status = 'accepting' AND acceptance_request_id = $3
       RETURNING inviter_player_id, invitee_player_id`,
      [inviteId, inviteePlayerId, requestId, this.now()]
    );
    const row = result.rows[0];
    if (!row) throw new TravelInviteError("TRAVEL_INVITE_NOT_PENDING", "Travel Invite acceptance was not reserved.");
    await client.query(
      `UPDATE travel_invite_operations SET completed_at = $3, travel_invite_id = $4
       WHERE player_id = $1 AND request_id = $2 AND action = 'accept'`,
      [inviteePlayerId, requestId, this.now(), inviteId]
    );
    return [row.inviter_player_id, row.invitee_player_id].sort();
  }

  async releaseAcceptance(inviteId: string, inviteePlayerId: string, requestId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE travel_invites
         SET status = 'pending', acceptance_request_id = NULL, acceptance_reserved_at = NULL
         WHERE id = $1 AND invitee_player_id = $2 AND status = 'accepting' AND acceptance_request_id = $3`,
        [inviteId, inviteePlayerId, requestId]
      );
      await client.query(
        `DELETE FROM travel_invite_operations
         WHERE player_id = $1 AND request_id = $2 AND action = 'accept' AND completed_at IS NULL`,
        [inviteePlayerId, requestId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async decline(inviteId: string, inviteePlayerId: string, requestId: string): Promise<string[]> {
    return this.finish(inviteId, inviteePlayerId, requestId, "decline", "declined", "recipient");
  }

  async cancel(inviteId: string, inviterPlayerId: string, requestId: string): Promise<string[]> {
    return this.finish(inviteId, inviterPlayerId, requestId, "cancel", "cancelled", "sender");
  }

  async invalidateForInviter(
    inviterPlayerId: string,
    reason: string,
    options: { sessionId?: string } = {}
  ): Promise<string[]> {
    await expirePending(this.pool, this.now());
    return this.invalidateForInviterInTransaction(this.pool, inviterPlayerId, reason, options);
  }

  async invalidateForInviterInTransaction(
    queryable: Pick<pg.Pool, "query"> | pg.PoolClient,
    inviterPlayerId: string,
    reason: string,
    options: { sessionId?: string } = {}
  ): Promise<string[]> {
    const result = await queryable.query<{ inviter_player_id: string; invitee_player_id: string }>(
      `UPDATE travel_invites
       SET status = 'invalidated', invalidation_reason = $2, responded_at = $3
       WHERE inviter_player_id = $1 AND status IN ('pending', 'accepting')
         AND ($4::uuid IS NULL OR inviter_session_id = $4)
       RETURNING inviter_player_id, invitee_player_id`,
      [inviterPlayerId, reason, this.now(), options.sessionId ?? null]
    );
    return uniquePlayers(result.rows);
  }

  private async finish(
    inviteId: string,
    actorPlayerId: string,
    requestId: string,
    action: "decline" | "cancel",
    status: "declined" | "cancelled",
    perspective: "recipient" | "sender"
  ): Promise<string[]> {
    await expirePending(this.pool, this.now());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await reserveOperation(client, actorPlayerId, requestId, action, { inviteId });
      if (replay?.completed_at) {
        await client.query("COMMIT");
        return [];
      }
      const result = await client.query<InviteRow>(
        `SELECT id, inviter_player_id, invitee_player_id, inviter_session_id,
                layer_scope_id, layer_id, layer_relocation_revision, layer_generation,
                source_type, source_id, destination_anchor_lat, destination_anchor_lon,
                status, expires_at, acceptance_request_id
         FROM travel_invites WHERE id = $1 FOR UPDATE`,
        [inviteId]
      );
      const invite = result.rows[0];
      const authorized = perspective === "recipient"
        ? invite?.invitee_player_id === actorPlayerId
        : invite?.inviter_player_id === actorPlayerId;
      if (!invite || !authorized) throw new TravelInviteError("TRAVEL_INVITE_NOT_FOUND", "Travel Invite not found.");
      if (invite.status !== "pending") {
        throw new TravelInviteError("TRAVEL_INVITE_NOT_PENDING", "This Travel Invite is no longer pending.");
      }
      await markTerminal(client, invite.id, status, null, this.now());
      await completeOperation(client, actorPlayerId, requestId, invite.id);
      await client.query("COMMIT");
      return [invite.inviter_player_id, invite.invitee_player_id].sort();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function reserveOperation(
  client: pg.PoolClient,
  playerId: string,
  requestId: string,
  action: "send" | "accept" | "decline" | "cancel",
  payload: unknown
): Promise<OperationRow | null> {
  const serialized = JSON.stringify(payload);
  const inserted = await client.query(
    `INSERT INTO travel_invite_operations (player_id, request_id, action, payload)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (player_id, request_id) DO NOTHING
     RETURNING request_id`,
    [playerId, requestId, action, serialized]
  );
  if (inserted.rowCount) return null;
  const existing = await client.query<OperationRow>(
    `SELECT action, travel_invite_id, payload = $3::jsonb AS payload_matches, completed_at
     FROM travel_invite_operations WHERE player_id = $1 AND request_id = $2`,
    [playerId, requestId, serialized]
  );
  const row = existing.rows[0];
  if (!row || row.action !== action || !row.payload_matches) {
    throw new TravelInviteError("TRAVEL_INVITE_REQUEST_CONFLICT", "Travel request ID conflicts with another operation.");
  }
  return row;
}

async function completeOperation(client: pg.PoolClient, playerId: string, requestId: string, inviteId: string): Promise<void> {
  await client.query(
    `UPDATE travel_invite_operations SET travel_invite_id = $3, completed_at = now()
     WHERE player_id = $1 AND request_id = $2`,
    [playerId, requestId, inviteId]
  );
}

async function pairBlocked(
  queryable: Pick<pg.Pool, "query"> | pg.PoolClient,
  leftPlayerId: string,
  rightPlayerId: string
): Promise<boolean> {
  const result = await queryable.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM player_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)
     ) AS blocked`,
    [leftPlayerId, rightPlayerId]
  );
  return Boolean(result.rows[0]?.blocked);
}

async function expirePending(
  queryable: Pick<pg.Pool, "query"> | pg.PoolClient,
  now: Date
): Promise<void> {
  await queryable.query(
    `UPDATE travel_invites
     SET status = 'expired', invalidation_reason = 'The Travel Invite expired.', responded_at = $1
     WHERE status = 'pending' AND expires_at <= $1`,
    [now]
  );
  await queryable.query(
    `UPDATE travel_invites
     SET status = 'invalidated',
         invalidation_reason = 'Acceptance could not be completed.',
         responded_at = $1
     WHERE status = 'accepting' AND acceptance_reserved_at <= $1::timestamptz - interval '2 minutes'`,
    [now]
  );
}

async function markTerminal(
  client: pg.PoolClient,
  inviteId: string,
  status: "accepted" | "declined" | "cancelled" | "expired" | "invalidated",
  reason: string | null,
  now: Date
): Promise<void> {
  await client.query(
    `UPDATE travel_invites
     SET status = $2, invalidation_reason = $3, responded_at = $4
     WHERE id = $1`,
    [inviteId, status, reason, now]
  );
}

function destination(row: InviteRow): TravelInviteDestination {
  return {
    inviteId: row.id,
    inviterPlayerId: row.inviter_player_id,
    inviteePlayerId: row.invitee_player_id,
    inviterSessionId: row.inviter_session_id,
    anchor: {
      scopeId: row.layer_scope_id,
      layerId: row.layer_id,
      center: {
        lat: Number(row.destination_anchor_lat),
        lon: Number(row.destination_anchor_lon)
      },
      relocationRevision: Number(row.layer_relocation_revision),
      layerGeneration: Number(row.layer_generation),
      sourceType: row.source_type,
      sourceId: row.source_id
    },
    expiresAt: asDate(row.expires_at).toISOString()
  };
}

function inboxSnapshot(row: InboxRow): TravelInboxEntry {
  return {
    entryId: row.entry_id,
    inviteId: row.invite_id,
    perspective: row.perspective,
    counterpartPlayerId: row.counterpart_player_id,
    counterpartName: row.counterpart_name,
    message: row.message,
    status: row.status === "accepting" ? "pending" : row.status,
    invalidationReason: row.invalidation_reason,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdAt: asDate(row.created_at).toISOString(),
    expiresAt: asDate(row.expires_at).toISOString(),
    respondedAt: row.responded_at ? asDate(row.responded_at).toISOString() : null,
    updatedAt: asDate(row.updated_at).toISOString()
  };
}

function uniquePlayers(rows: readonly { inviter_player_id: string; invitee_player_id: string }[]): string[] {
  return [...new Set(rows.flatMap((row) => [row.inviter_player_id, row.invitee_player_id]))].sort();
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function validAnchor(anchor: AuthoritativeTravelAnchor): boolean {
  return (anchor.scopeId === "world" || anchor.scopeId === "manor") &&
    anchor.layerId.length > 0 && anchor.layerId.length <= 200 &&
    Number.isSafeInteger(anchor.relocationRevision) && anchor.relocationRevision >= 0 &&
    Number.isSafeInteger(anchor.layerGeneration) && anchor.layerGeneration >= 0 &&
    Number.isFinite(anchor.center.lat) && Math.abs(anchor.center.lat) <= 90 &&
    Number.isFinite(anchor.center.lon) && Math.abs(anchor.center.lon) <= 180 &&
    anchor.sourceType.length > 0 && anchor.sourceType.length <= 32 &&
    (anchor.sourceId === null || (anchor.sourceId.length > 0 && anchor.sourceId.length <= 160));
}
