import { randomUUID } from "node:crypto";

import {
  KINGDOM_ACTIVE_MEMBER_WINDOW_MS,
  KINGDOM_ANARCHY_DURATION_MS,
  KINGDOM_REVOLT_BOOST_DURATION_MS,
  KINGDOM_REVOLT_FAILED_COOLDOWN_MS,
  KINGDOM_REVOLT_VOTE_DURATION_MS,
  kingdomRevoltBoostPoints,
  kingdomRevoltPasses,
  kingdomRevoltSupportPercent,
  type KingdomRevoltState,
  type KingdomRole
} from "@ash-atlas/shared";
import type pg from "pg";

import { insertKingdomAuditEvent } from "./kingdomTreasuryLedger.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** Raised with the kingdom service's error codes; the caller maps it to a KingdomError. */
export class KingdomRevoltError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KingdomRevoltError";
  }
}

type RevoltActor = Readonly<{ playerId: string; kingdomId: string; role: KingdomRole }>;
export type KingdomRevoltOutcome = "open" | "succeeded" | "failed" | "cancelled";

type RevoltRow = {
  id: string;
  kingdom_id: string;
  target_leader_player_id: string;
  started_by_player_id: string;
  opened_at: Date;
  closes_at: Date;
};

const REVOLT_COLUMNS = `id::text, kingdom_id::text, target_leader_player_id, started_by_player_id, opened_at, closes_at`;

async function currentLeaderId(queryable: Queryable, kingdomId: string): Promise<string | null> {
  const result = await queryable.query<{ player_id: string }>(
    `SELECT player_id FROM kingdom_memberships
     WHERE kingdom_id = $1::uuid AND status = 'active' AND role = 'leader'`,
    [kingdomId]
  );
  return result.rows[0]?.player_id ?? null;
}

async function anarchyUntil(queryable: Queryable, kingdomId: string): Promise<Date | null> {
  const result = await queryable.query<{ anarchy_until: Date | null }>(
    "SELECT anarchy_until FROM kingdoms WHERE id = $1::uuid",
    [kingdomId]
  );
  return result.rows[0]?.anarchy_until ?? null;
}

/**
 * Votes from members active in the last 6 days (the leader excluded) and the
 * leader's war-death boost from the A3 war-death ledger.
 */
async function revoltTally(
  queryable: Queryable,
  kingdomId: string,
  leaderId: string,
  revoltId: string | null,
  now: Date
): Promise<{ eligibleVoters: number; yesVotes: number; noVotes: number; boostPoints: number; boostEndsAt: Date | null }> {
  const votes = await queryable.query<{ eligible: number; yes: number; no: number }>(
    `WITH eligible AS (
       SELECT membership.player_id FROM kingdom_memberships membership
       JOIN players player ON player.id = membership.player_id
       WHERE membership.kingdom_id = $1::uuid AND membership.status = 'active'
         AND membership.player_id <> $2
         AND player.last_seen_at >= $3::timestamptz - ($4::bigint * interval '1 millisecond')
     )
     SELECT (SELECT count(*)::int FROM eligible) AS eligible,
            (SELECT count(*)::int FROM kingdom_revolt_votes vote JOIN eligible ON eligible.player_id = vote.voter_player_id
             WHERE vote.revolt_id = $5::uuid AND vote.support) AS yes,
            (SELECT count(*)::int FROM kingdom_revolt_votes vote JOIN eligible ON eligible.player_id = vote.voter_player_id
             WHERE vote.revolt_id = $5::uuid AND NOT vote.support) AS no`,
    [kingdomId, leaderId, now, KINGDOM_ACTIVE_MEMBER_WINDOW_MS, revoltId]
  );
  const deaths = await queryable.query<{ deaths: number; latest: Date | null }>(
    `SELECT count(*)::int AS deaths, max(created_at) AS latest
     FROM organization_war_death_losses
     WHERE victim_kingdom_id = $1::uuid AND victim_player_id = $2 AND victim_was_leader
       AND created_at > $3::timestamptz - ($4::bigint * interval '1 millisecond')`,
    [kingdomId, leaderId, now, KINGDOM_REVOLT_BOOST_DURATION_MS]
  );
  const row = votes.rows[0];
  const death = deaths.rows[0];
  const boostPoints = kingdomRevoltBoostPoints(Number(death?.deaths ?? 0));
  return {
    eligibleVoters: Number(row?.eligible ?? 0),
    yesVotes: Number(row?.yes ?? 0),
    noVotes: Number(row?.no ?? 0),
    boostPoints,
    boostEndsAt: boostPoints > 0 && death?.latest
      ? new Date(new Date(death.latest).getTime() + KINGDOM_REVOLT_BOOST_DURATION_MS)
      : null
  };
}

/** When the next revolt may start after the latest failed one, or null when it may start now. */
async function nextRevoltAllowedAt(queryable: Queryable, kingdomId: string, now: Date): Promise<Date | null> {
  const result = await queryable.query<{ resolved_at: Date }>(
    `SELECT resolved_at FROM kingdom_revolts
     WHERE kingdom_id = $1::uuid AND status = 'failed'
     ORDER BY resolved_at DESC LIMIT 1`,
    [kingdomId]
  );
  const failedAt = result.rows[0]?.resolved_at;
  if (!failedAt) return null;
  const allowedAt = new Date(failedAt.getTime() + KINGDOM_REVOLT_FAILED_COOLDOWN_MS);
  return allowedAt.getTime() > now.getTime() ? allowedAt : null;
}

async function lockOpenRevolt(client: Queryable, kingdomId: string): Promise<RevoltRow | null> {
  const result = await client.query<RevoltRow>(
    `SELECT ${REVOLT_COLUMNS} FROM kingdom_revolts
     WHERE kingdom_id = $1::uuid AND status = 'open' FOR UPDATE`,
    [kingdomId]
  );
  return result.rows[0] ?? null;
}

async function closeRevolt(
  client: Queryable,
  revolt: RevoltRow,
  status: "failed" | "cancelled",
  now: Date,
  tally: { yesVotes: number; eligibleVoters: number; boostPoints: number } | null
): Promise<void> {
  await client.query(
    `UPDATE kingdom_revolts
     SET status = $2, resolved_at = $3, yes_votes = $4, eligible_voters = $5, boost_points = $6
     WHERE id = $1::uuid AND status = 'open'`,
    [revolt.id, status, now, tally?.yesVotes ?? null, tally?.eligibleVoters ?? null, tally?.boostPoints ?? null]
  );
  await insertKingdomAuditEvent(client, {
    kingdomId: revolt.kingdom_id,
    actorPlayerId: null,
    eventType: `revolt_${status}`,
    entityType: "kingdom_revolt",
    entityId: revolt.id,
    metadata: { targetLeaderPlayerId: revolt.target_leader_player_id, ...(tally ?? {}) }
  });
}

/**
 * Re-counts an open revolt under the kingdom row lock: it passes as soon as
 * the yes share plus the boost is above 55%, fails when its 4 days end
 * without that, and is cancelled when its target no longer leads (a
 * leadership transfer, or the kingdom ended).
 */
async function resolveOpenRevolt(client: Queryable, revolt: RevoltRow, now: Date): Promise<KingdomRevoltOutcome> {
  const leaderId = await currentLeaderId(client, revolt.kingdom_id);
  if (leaderId !== revolt.target_leader_player_id) {
    await closeRevolt(client, revolt, "cancelled", now, null);
    return "cancelled";
  }
  const tally = await revoltTally(client, revolt.kingdom_id, leaderId, revolt.id, now);
  if (kingdomRevoltPasses(tally)) {
    const anarchyEndsAt = new Date(now.getTime() + KINGDOM_ANARCHY_DURATION_MS);
    const demoted = await client.query(
      `UPDATE kingdom_memberships SET role = 'member'
       WHERE kingdom_id = $1::uuid AND player_id = $2 AND status = 'active' AND role = 'leader'`,
      [revolt.kingdom_id, leaderId]
    );
    if (demoted.rowCount !== 1) throw new Error("Revolt target lost the leader role under the kingdom lock");
    await client.query(
      `UPDATE kingdom_revolts
       SET status = 'succeeded', resolved_at = $2, yes_votes = $3, eligible_voters = $4,
           boost_points = $5, anarchy_until = $6
       WHERE id = $1::uuid AND status = 'open'`,
      [revolt.id, now, tally.yesVotes, tally.eligibleVoters, tally.boostPoints, anarchyEndsAt]
    );
    await client.query(
      "UPDATE kingdoms SET anarchy_until = $2, anarchy_revolt_id = $3::uuid WHERE id = $1::uuid",
      [revolt.kingdom_id, anarchyEndsAt, revolt.id]
    );
    await insertKingdomAuditEvent(client, {
      kingdomId: revolt.kingdom_id,
      actorPlayerId: null,
      eventType: "revolt_succeeded",
      entityType: "kingdom_revolt",
      entityId: revolt.id,
      metadata: {
        deposedLeaderPlayerId: leaderId,
        yesVotes: tally.yesVotes,
        eligibleVoters: tally.eligibleVoters,
        boostPoints: tally.boostPoints,
        anarchyUntil: anarchyEndsAt.toISOString()
      }
    });
    return "succeeded";
  }
  if (revolt.closes_at.getTime() <= now.getTime()) {
    await closeRevolt(client, revolt, "failed", now, tally);
    return "failed";
  }
  return "open";
}

/**
 * Ends a due anarchy. The successor is the revolt's starter when still a
 * member active in the last 6 days; otherwise the longest-serving member
 * active in the last 6 days (the deposed leader only as a last resort);
 * otherwise the longest-serving member. A kingdom with no members stays in
 * anarchy until someone joins. Uses the same leader-role and
 * kingdoms.leader_player_id pair as a leadership transfer.
 */
async function endDueAnarchy(client: Queryable, kingdomId: string, now: Date): Promise<boolean> {
  const state = await client.query<{
    anarchy_until: Date | null;
    revolt_id: string | null;
    started_by_player_id: string | null;
    target_leader_player_id: string | null;
  }>(
    `SELECT kingdom.anarchy_until, revolt.id::text AS revolt_id,
            revolt.started_by_player_id, revolt.target_leader_player_id
     FROM kingdoms kingdom
     LEFT JOIN kingdom_revolts revolt ON revolt.id = kingdom.anarchy_revolt_id
     WHERE kingdom.id = $1::uuid`,
    [kingdomId]
  );
  const row = state.rows[0];
  if (!row?.anarchy_until || row.anarchy_until.getTime() > now.getTime()) return false;
  if (await currentLeaderId(client, kingdomId)) throw new Error("Kingdom in anarchy already has a leader");
  const successor = await client.query<{ id: string; player_id: string }>(
    `SELECT membership.id::text, membership.player_id
     FROM kingdom_memberships membership
     JOIN players player ON player.id = membership.player_id
     WHERE membership.kingdom_id = $1::uuid AND membership.status = 'active'
     ORDER BY (membership.player_id = $2
                 AND player.last_seen_at >= $4::timestamptz - ($5::bigint * interval '1 millisecond')) DESC,
              (player.last_seen_at >= $4::timestamptz - ($5::bigint * interval '1 millisecond')) DESC,
              (membership.player_id = $3) ASC,
              membership.joined_at ASC, membership.player_id ASC
     LIMIT 1
     FOR UPDATE OF membership`,
    [kingdomId, row.started_by_player_id, row.target_leader_player_id, now, KINGDOM_ACTIVE_MEMBER_WINDOW_MS]
  );
  const next = successor.rows[0];
  if (!next) return false;
  await client.query("UPDATE kingdom_memberships SET role = 'leader' WHERE id = $1::uuid", [next.id]);
  await client.query(
    `UPDATE kingdoms SET leader_player_id = $2, anarchy_until = NULL, anarchy_revolt_id = NULL,
       spatial_revision = nextval('kingdom_spatial_revision_seq')
     WHERE id = $1::uuid`,
    [kingdomId, next.player_id]
  );
  if (row.revolt_id) {
    await client.query("UPDATE kingdom_revolts SET successor_player_id = $2 WHERE id = $1::uuid",
      [row.revolt_id, next.player_id]);
  }
  await insertKingdomAuditEvent(client, {
    kingdomId,
    actorPlayerId: null,
    eventType: "anarchy_ended",
    entityType: "kingdom_revolt",
    entityId: row.revolt_id,
    metadata: { newLeaderPlayerId: next.player_id }
  });
  return true;
}

/**
 * Settles one kingdom's revolt work: an open vote is re-counted (passed,
 * expired or cancelled) and a finished anarchy installs its successor.
 * The caller holds the kingdom row lock.
 */
export async function settleKingdomRevoltInTransaction(
  client: Queryable,
  kingdomId: string,
  now: Date
): Promise<boolean> {
  let changed = await endDueAnarchy(client, kingdomId, now);
  const open = await lockOpenRevolt(client, kingdomId);
  if (open) changed = (await resolveOpenRevolt(client, open, now)) !== "open" || changed;
  return changed;
}

/** Kingdoms with an open revolt or a finished anarchy, for the settlement tick. */
export async function kingdomsWithRevoltWork(queryable: Queryable, now: Date): Promise<string[]> {
  const result = await queryable.query<{ kingdom_id: string }>(
    `SELECT kingdom_id::text FROM kingdom_revolts WHERE status = 'open'
     UNION
     SELECT id::text FROM kingdoms WHERE anarchy_until IS NOT NULL AND anarchy_until <= $1`,
    [now]
  );
  return result.rows.map((row) => row.kingdom_id);
}

/** Cheap read-only check so a state read takes the kingdom lock only when work is due. */
export async function kingdomRevoltWorkDue(queryable: Queryable, kingdomId: string, now: Date): Promise<boolean> {
  const result = await queryable.query(
    `SELECT 1 FROM kingdoms WHERE id = $1::uuid AND anarchy_until IS NOT NULL AND anarchy_until <= $2
     UNION ALL
     SELECT 1 FROM kingdom_revolts WHERE kingdom_id = $1::uuid AND status = 'open' AND closes_at <= $2
     LIMIT 1`,
    [kingdomId, now]
  );
  return Boolean(result.rowCount);
}

/**
 * Starts a revolt vote against the leader; the starter's yes vote is cast
 * with it, so a kingdom whose only other active member starts it passes at
 * once. Runs inside the kingdom mutation (player, kingdom and membership
 * rows locked, request id replay-protected).
 */
export async function startKingdomRevoltInTransaction(
  client: Queryable,
  actor: RevoltActor,
  now: Date
): Promise<{ revoltId: string; outcome: KingdomRevoltOutcome }> {
  await settleKingdomRevoltInTransaction(client, actor.kingdomId, now);
  if (await anarchyUntil(client, actor.kingdomId)) {
    throw new KingdomRevoltError("KINGDOM_REVOLT_ANARCHY", "The Kingdom is in anarchy; there is no leader to revolt against");
  }
  if (actor.role === "leader") {
    throw new KingdomRevoltError("KINGDOM_REVOLT_LEADER_CANNOT_VOTE", "The leader cannot start or vote in a revolt");
  }
  if (await lockOpenRevolt(client, actor.kingdomId)) {
    throw new KingdomRevoltError("KINGDOM_REVOLT_ALREADY_OPEN", "A revolt vote is already open");
  }
  const allowedAt = await nextRevoltAllowedAt(client, actor.kingdomId, now);
  if (allowedAt) {
    throw new KingdomRevoltError(
      "KINGDOM_REVOLT_COOLDOWN",
      "A revolt failed in the last 24 hours; a new vote can start after the cooldown"
    );
  }
  const leaderId = await currentLeaderId(client, actor.kingdomId);
  if (!leaderId) {
    throw new KingdomRevoltError("KINGDOM_REVOLT_ANARCHY", "The Kingdom has no leader to revolt against");
  }
  if (leaderId === actor.playerId) {
    throw new KingdomRevoltError("KINGDOM_REVOLT_LEADER_CANNOT_VOTE", "The leader cannot start or vote in a revolt");
  }
  const revoltId = randomUUID();
  const inserted = await client.query<RevoltRow>(
    `INSERT INTO kingdom_revolts (id, kingdom_id, target_leader_player_id, started_by_player_id, opened_at, closes_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
     RETURNING ${REVOLT_COLUMNS}`,
    [revoltId, actor.kingdomId, leaderId, actor.playerId, now, new Date(now.getTime() + KINGDOM_REVOLT_VOTE_DURATION_MS)]
  );
  await client.query(
    "INSERT INTO kingdom_revolt_votes (revolt_id, voter_player_id, support, voted_at) VALUES ($1::uuid, $2, true, $3)",
    [revoltId, actor.playerId, now]
  );
  await insertKingdomAuditEvent(client, {
    kingdomId: actor.kingdomId,
    actorPlayerId: actor.playerId,
    eventType: "revolt_started",
    entityType: "kingdom_revolt",
    entityId: revoltId,
    metadata: { targetLeaderPlayerId: leaderId }
  });
  return { revoltId, outcome: await resolveOpenRevolt(client, inserted.rows[0]!, now) };
}

/** One vote per member per revolt; the leader cannot vote. Same locks as starting. */
export async function castKingdomRevoltVoteInTransaction(
  client: Queryable,
  actor: RevoltActor,
  input: Readonly<{ revoltId: string; support: boolean }>,
  now: Date
): Promise<{ revoltId: string; outcome: KingdomRevoltOutcome }> {
  if (actor.role === "leader") {
    throw new KingdomRevoltError("KINGDOM_REVOLT_LEADER_CANNOT_VOTE", "The leader cannot start or vote in a revolt");
  }
  await settleKingdomRevoltInTransaction(client, actor.kingdomId, now);
  const open = await lockOpenRevolt(client, actor.kingdomId);
  if (!open || open.id !== input.revoltId) {
    throw new KingdomRevoltError("KINGDOM_REVOLT_NOT_FOUND", "That revolt vote is no longer open");
  }
  const voted = await client.query(
    `INSERT INTO kingdom_revolt_votes (revolt_id, voter_player_id, support, voted_at)
     VALUES ($1::uuid, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [open.id, actor.playerId, input.support, now]
  );
  if (voted.rowCount !== 1) {
    throw new KingdomRevoltError("KINGDOM_REVOLT_ALREADY_VOTED", "You have already voted in this revolt");
  }
  return { revoltId: open.id, outcome: await resolveOpenRevolt(client, open, now) };
}

/** The kingdom app's revolt panel: the open vote, the anarchy countdown and the boost. */
export async function loadKingdomRevoltState(
  queryable: Queryable,
  kingdomId: string,
  viewerId: string,
  now: Date
): Promise<KingdomRevoltState> {
  const [leaderId, anarchy, open, nextRevoltAt] = await Promise.all([
    currentLeaderId(queryable, kingdomId),
    queryable.query<{ anarchy_until: Date; revolt_id: string; deposed: string; deposed_name: string }>(
      `SELECT kingdom.anarchy_until, revolt.id::text AS revolt_id,
              revolt.target_leader_player_id AS deposed, player.username AS deposed_name
       FROM kingdoms kingdom
       JOIN kingdom_revolts revolt ON revolt.id = kingdom.anarchy_revolt_id
       JOIN players player ON player.id = revolt.target_leader_player_id
       WHERE kingdom.id = $1::uuid`,
      [kingdomId]
    ),
    queryable.query<RevoltRow & { target_name: string; starter_name: string; viewer_support: boolean | null }>(
      `SELECT revolt.id::text, revolt.kingdom_id::text, revolt.target_leader_player_id, revolt.started_by_player_id,
              revolt.opened_at, revolt.closes_at, target.username AS target_name, starter.username AS starter_name,
              (SELECT vote.support FROM kingdom_revolt_votes vote
               WHERE vote.revolt_id = revolt.id AND vote.voter_player_id = $2) AS viewer_support
       FROM kingdom_revolts revolt
       JOIN players target ON target.id = revolt.target_leader_player_id
       JOIN players starter ON starter.id = revolt.started_by_player_id
       WHERE revolt.kingdom_id = $1::uuid AND revolt.status = 'open'`,
      [kingdomId, viewerId]
    ),
    nextRevoltAllowedAt(queryable, kingdomId, now)
  ]);
  const anarchyRow = anarchy.rows[0];
  const openRow = open.rows[0];
  const tally = leaderId ? await revoltTally(queryable, kingdomId, leaderId, openRow?.id ?? null, now) : null;
  return {
    serverTime: now.toISOString(),
    boostPoints: tally?.boostPoints ?? 0,
    nextRevoltAt: nextRevoltAt?.toISOString() ?? null,
    anarchy: anarchyRow
      ? {
          endsAt: anarchyRow.anarchy_until.toISOString(),
          revoltId: anarchyRow.revolt_id,
          deposedLeaderPlayerId: anarchyRow.deposed,
          deposedLeaderName: anarchyRow.deposed_name
        }
      : null,
    revolt: openRow && tally
      ? {
          revoltId: openRow.id,
          targetLeaderPlayerId: openRow.target_leader_player_id,
          targetLeaderName: openRow.target_name,
          startedByPlayerId: openRow.started_by_player_id,
          startedByName: openRow.starter_name,
          openedAt: openRow.opened_at.toISOString(),
          closesAt: openRow.closes_at.toISOString(),
          yesVotes: tally.yesVotes,
          noVotes: tally.noVotes,
          eligibleVoters: tally.eligibleVoters,
          boostPoints: tally.boostPoints,
          boostEndsAt: tally.boostEndsAt?.toISOString() ?? null,
          supportPercent: Math.round(kingdomRevoltSupportPercent(tally) * 10) / 10,
          viewerVote: openRow.viewer_support === null ? null : openRow.viewer_support ? "yes" : "no",
          viewerCanVote: openRow.viewer_support === null && viewerId !== leaderId
        }
      : null
  };
}
