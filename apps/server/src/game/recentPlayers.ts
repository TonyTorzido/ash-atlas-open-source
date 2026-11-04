import type {
  RecentPlayerInteractionType,
  RecentPlayersResponse,
  SocialPlayerSummary,
  ViewerRelationship
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../logger.js";

const NEARBY_COOLDOWN_MS = 5 * 60_000;
const LOCAL_CHAT_COOLDOWN_MS = 30_000;
const PARTY_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_KEYS = 50_000;
const MAX_PENDING_INTERACTIONS = 10_000;

type PendingInteraction = {
  ownerPlayerId: string;
  recentPlayerId: string;
  interactionType: RecentPlayerInteractionType;
  interactionAt: Date;
};

type RecentPlayerRow = {
  player_id: string;
  username: string;
  display_color: string | null;
  interaction_type: RecentPlayerInteractionType;
  interaction_at: Date | string;
  viewer_blocked: boolean;
  target_blocked: boolean;
  friends: boolean;
  outgoing: boolean;
  incoming: boolean;
  enemy: boolean;
};

export type RecentPlayersServiceOptions = {
  isPlayerOnline?(playerId: string): boolean;
  playerPresence?(playerId: string): "online" | "recently_active" | "offline";
  now?(): Date;
  logger?: AppLogger;
  scheduleFlush?(flush: () => void): void;
};

export class RecentPlayersService {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly recentEvents = new Map<string, {
    interactionType: RecentPlayerInteractionType;
    recordedAt: number;
  }>();
  private flushScheduled = false;
  private flushPromise: Promise<void> | null = null;
  private readonly metrics = {
    interactionsQueued: 0,
    interactionsDropped: 0,
    batchesPersisted: 0,
    batchRetries: 0,
    batchFailures: 0
  };
  private readonly playerPresence: (
    playerId: string
  ) => "online" | "recently_active" | "offline";
  private readonly now: () => Date;

  constructor(
    private readonly pool: pg.Pool,
    private readonly options: RecentPlayersServiceOptions = {}
  ) {
    this.playerPresence = options.playerPresence ??
      ((playerId) => options.isPlayerOnline?.(playerId) ? "online" : "offline");
    this.now = options.now ?? (() => new Date());
  }

  recordMutualVisibility(pairs: readonly (readonly [string, string])[]): void {
    const interactionAt = this.now();
    for (const [left, right] of pairs) {
      this.enqueuePair(left, right, "nearby", interactionAt, NEARBY_COOLDOWN_MS);
    }
  }

  recordLocalDelivery(senderPlayerId: string, recipientPlayerIds: readonly string[]): void {
    const interactionAt = this.now();
    for (const recipientPlayerId of new Set(recipientPlayerIds)) {
      this.enqueuePair(
        senderPlayerId,
        recipientPlayerId,
        "local_chat",
        interactionAt,
        LOCAL_CHAT_COOLDOWN_MS
      );
    }
  }

  recordPartyInteraction(memberPlayerIds: readonly string[]): void {
    const interactionAt = this.now();
    const members = [...new Set(memberPlayerIds)].sort();
    for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
        this.enqueuePair(
          members[leftIndex]!,
          members[rightIndex]!,
          "party",
          interactionAt,
          PARTY_COOLDOWN_MS
        );
      }
    }
  }

  recordPartyJoin(joiningPlayerId: string, existingMemberPlayerIds: readonly string[]): void {
    const interactionAt = this.now();
    for (const memberPlayerId of new Set(existingMemberPlayerIds)) {
      this.enqueuePair(
        joiningPlayerId,
        memberPlayerId,
        "party",
        interactionAt,
        PARTY_COOLDOWN_MS
      );
    }
  }

  async list(ownerPlayerId: string, limit: number): Promise<RecentPlayersResponse> {
    const result = await this.pool.query<RecentPlayerRow>(
      `SELECT p.id AS player_id, p.username, p.display_color,
              recent.interaction_type, recent.interaction_at,
              EXISTS (SELECT 1 FROM player_blocks
                      WHERE blocker_id = $1 AND blocked_id = p.id) AS viewer_blocked,
              EXISTS (SELECT 1 FROM player_blocks
                      WHERE blocker_id = p.id AND blocked_id = $1) AS target_blocked,
              EXISTS (SELECT 1 FROM friendships
                      WHERE player_low_id = LEAST($1, p.id)
                        AND player_high_id = GREATEST($1, p.id)) AS friends,
              EXISTS (SELECT 1 FROM friend_requests
                      WHERE requester_id = $1 AND recipient_id = p.id) AS outgoing,
              EXISTS (SELECT 1 FROM friend_requests
                      WHERE requester_id = p.id AND recipient_id = $1) AS incoming,
              EXISTS (SELECT 1 FROM player_enemy_marks
                      WHERE owner_id = LEAST($1, p.id)
                        AND target_id = GREATEST($1, p.id)) AS enemy
       FROM recent_players recent
       JOIN players p ON p.id = recent.recent_player_id
       WHERE recent.owner_player_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM player_blocks blocks
           WHERE (blocks.blocker_id = $1 AND blocks.blocked_id = recent.recent_player_id)
              OR (blocks.blocker_id = recent.recent_player_id AND blocks.blocked_id = $1)
         )
       ORDER BY recent.interaction_at DESC, recent.recent_player_id
       LIMIT $2`,
      [ownerPlayerId, limit]
    );
    return {
      entries: result.rows.map((row) => ({
        ...summaryFromRow(row, ownerPlayerId, this.playerPresence),
        interactionType: row.interaction_type,
        interactionAt: asIso(row.interaction_at)
      }))
    };
  }

  async summary(viewerPlayerId: string, targetPlayerId: string): Promise<SocialPlayerSummary> {
    const result = await this.pool.query<RecentPlayerRow>(
      `SELECT p.id AS player_id, p.username, p.display_color,
              'nearby'::text AS interaction_type, now() AS interaction_at,
              EXISTS (SELECT 1 FROM player_blocks
                      WHERE blocker_id = $1 AND blocked_id = p.id) AS viewer_blocked,
              EXISTS (SELECT 1 FROM player_blocks
                      WHERE blocker_id = p.id AND blocked_id = $1) AS target_blocked,
              EXISTS (SELECT 1 FROM friendships
                      WHERE player_low_id = LEAST($1, p.id)
                        AND player_high_id = GREATEST($1, p.id)) AS friends,
              EXISTS (SELECT 1 FROM friend_requests
                      WHERE requester_id = $1 AND recipient_id = p.id) AS outgoing,
              EXISTS (SELECT 1 FROM friend_requests
                      WHERE requester_id = p.id AND recipient_id = $1) AS incoming,
              EXISTS (SELECT 1 FROM player_enemy_marks
                      WHERE owner_id = LEAST($1, p.id)
                        AND target_id = GREATEST($1, p.id)) AS enemy
       FROM players p
       WHERE p.id = $2`,
      [viewerPlayerId, targetPlayerId]
    );
    const row = result.rows[0];
    if (!row) throw new RecentPlayersError("PLAYER_NOT_FOUND", "Player not found", 404);
    return summaryFromRow(row, viewerPlayerId, this.playerPresence);
  }

  metricsSnapshot(): Readonly<typeof this.metrics> {
    return { ...this.metrics };
  }

  async flushPending(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (this.pending.size === 0) {
      this.flushScheduled = false;
      return;
    }
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.flushScheduled = false;
    this.flushPromise = this.persist(batch).catch(async (firstError: unknown) => {
      this.metrics.batchRetries += 1;
      try {
        await this.persist(batch);
      } catch (error) {
        this.metrics.batchFailures += 1;
        this.metrics.interactionsDropped += batch.length;
        this.options.logger?.warn(
          { err: error, firstError, recentPlayerInteractionCount: batch.length },
          "recent player interaction batch failed after retry"
        );
      }
    }).finally(() => {
      this.flushPromise = null;
      if (this.pending.size > 0) this.schedule();
    });
    return this.flushPromise;
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0 || this.flushPromise) {
      await (this.flushPromise ?? this.flushPending());
    }
  }

  private enqueuePair(
    leftPlayerId: string,
    rightPlayerId: string,
    interactionType: RecentPlayerInteractionType,
    interactionAt: Date,
    cooldownMs: number
  ): void {
    if (!leftPlayerId || !rightPlayerId || leftPlayerId === rightPlayerId) return;
    const pairKey = canonicalPairKey(leftPlayerId, rightPlayerId);
    const previous = this.recentEvents.get(pairKey);
    const nowMs = interactionAt.getTime();
    if (
      previous &&
      nowMs - previous.recordedAt < Math.max(cooldownMs, cooldownFor(previous.interactionType)) &&
      interactionPriority(interactionType) <= interactionPriority(previous.interactionType)
    ) return;
    this.recentEvents.set(pairKey, { interactionType, recordedAt: nowMs });
    this.pruneCooldowns(nowMs);
    this.enqueueDirectional(leftPlayerId, rightPlayerId, interactionType, interactionAt);
    this.enqueueDirectional(rightPlayerId, leftPlayerId, interactionType, interactionAt);
    this.schedule();
  }

  private enqueueDirectional(
    ownerPlayerId: string,
    recentPlayerId: string,
    interactionType: RecentPlayerInteractionType,
    interactionAt: Date
  ): void {
    const key = directionalKey(ownerPlayerId, recentPlayerId);
    const existing = this.pending.get(key);
    if (!existing || existing.interactionAt <= interactionAt) {
      if (!existing && this.pending.size >= MAX_PENDING_INTERACTIONS) {
        const oldest = this.pending.keys().next().value as string | undefined;
        if (oldest) {
          this.pending.delete(oldest);
          this.metrics.interactionsDropped += 1;
        }
      }
      this.pending.set(key, { ownerPlayerId, recentPlayerId, interactionType, interactionAt });
      this.metrics.interactionsQueued += 1;
    }
  }

  private schedule(): void {
    if (this.flushScheduled || this.flushPromise) return;
    this.flushScheduled = true;
    const schedule = this.options.scheduleFlush ?? ((flush: () => void) => queueMicrotask(flush));
    schedule(() => { void this.flushPending(); });
  }

  private async persist(batch: readonly PendingInteraction[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended(
             LEAST(source.owner_player_id, source.recent_player_id) || chr(31) ||
             GREATEST(source.owner_player_id, source.recent_player_id),
             0
           )
         )
         FROM unnest($1::text[], $2::text[])
           AS source(owner_player_id, recent_player_id)
         WHERE source.owner_player_id <> source.recent_player_id
         GROUP BY LEAST(source.owner_player_id, source.recent_player_id),
                  GREATEST(source.owner_player_id, source.recent_player_id)
         ORDER BY LEAST(source.owner_player_id, source.recent_player_id),
                  GREATEST(source.owner_player_id, source.recent_player_id)`,
        [
          batch.map((entry) => entry.ownerPlayerId),
          batch.map((entry) => entry.recentPlayerId)
        ]
      );
      await client.query(
      `INSERT INTO recent_players (
         owner_player_id, recent_player_id, interaction_type, interaction_at
       )
       SELECT source.owner_player_id, source.recent_player_id,
              source.interaction_type, source.interaction_at
       FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[])
         AS source(owner_player_id, recent_player_id, interaction_type, interaction_at)
       WHERE source.owner_player_id <> source.recent_player_id
         AND NOT EXISTS (
           SELECT 1 FROM player_blocks blocks
           WHERE (blocks.blocker_id = source.owner_player_id
                  AND blocks.blocked_id = source.recent_player_id)
              OR (blocks.blocker_id = source.recent_player_id
                  AND blocks.blocked_id = source.owner_player_id)
         )
         AND NOT EXISTS (
           SELECT 1 FROM recent_player_pair_suppressions suppression
           WHERE suppression.player_low_id = LEAST(
                   source.owner_player_id,
                   source.recent_player_id
                 )
             AND suppression.player_high_id = GREATEST(
                   source.owner_player_id,
                   source.recent_player_id
                 )
             AND suppression.suppressed_at >= source.interaction_at
         )
       ON CONFLICT (owner_player_id, recent_player_id) DO UPDATE
       SET interaction_type = EXCLUDED.interaction_type,
           interaction_at = EXCLUDED.interaction_at
       WHERE recent_players.interaction_at < EXCLUDED.interaction_at
         AND (
           CASE EXCLUDED.interaction_type
             WHEN 'trade' THEN 4 WHEN 'party' THEN 3 WHEN 'local_chat' THEN 2 ELSE 1 END
           >
           CASE recent_players.interaction_type
             WHEN 'trade' THEN 4 WHEN 'party' THEN 3 WHEN 'local_chat' THEN 2 ELSE 1 END
           OR (
             EXCLUDED.interaction_type = recent_players.interaction_type
             AND recent_players.interaction_at <= EXCLUDED.interaction_at -
               CASE EXCLUDED.interaction_type
                 WHEN 'local_chat' THEN interval '30 seconds'
                 ELSE interval '5 minutes'
               END
           )
           OR (
             CASE EXCLUDED.interaction_type
               WHEN 'trade' THEN 4 WHEN 'party' THEN 3 WHEN 'local_chat' THEN 2 ELSE 1 END
             <
             CASE recent_players.interaction_type
               WHEN 'trade' THEN 4 WHEN 'party' THEN 3 WHEN 'local_chat' THEN 2 ELSE 1 END
             AND recent_players.interaction_at <= EXCLUDED.interaction_at - interval '5 minutes'
           )
         )`,
      [
        batch.map((entry) => entry.ownerPlayerId),
        batch.map((entry) => entry.recentPlayerId),
        batch.map((entry) => entry.interactionType),
        batch.map((entry) => entry.interactionAt.toISOString())
      ]
      );
      await client.query(
        `WITH ranked AS (
           SELECT owner_player_id, recent_player_id,
                  row_number() OVER (
                    PARTITION BY owner_player_id
                    ORDER BY interaction_at DESC, recent_player_id
                  ) AS position
           FROM recent_players
           WHERE owner_player_id = ANY($1::text[])
         )
         DELETE FROM recent_players recent
         USING ranked
         WHERE recent.owner_player_id = ranked.owner_player_id
           AND recent.recent_player_id = ranked.recent_player_id
           AND ranked.position > 100`,
        [[...new Set(batch.map((entry) => entry.ownerPlayerId))]]
      );
      await client.query("COMMIT");
      this.metrics.batchesPersisted += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private pruneCooldowns(nowMs: number): void {
    if (this.recentEvents.size <= MAX_COOLDOWN_KEYS) return;
    const cutoff = nowMs - NEARBY_COOLDOWN_MS;
    for (const [key, value] of this.recentEvents) {
      if (value.recordedAt <= cutoff) this.recentEvents.delete(key);
    }
    while (this.recentEvents.size > MAX_COOLDOWN_KEYS) {
      const oldest = this.recentEvents.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recentEvents.delete(oldest);
    }
  }
}

export class RecentPlayersError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "RecentPlayersError";
  }
}

function summaryFromRow(
  row: RecentPlayerRow,
  viewerPlayerId: string,
  playerPresence: (playerId: string) => "online" | "recently_active" | "offline"
): SocialPlayerSummary {
  const self = viewerPlayerId === row.player_id;
  const relationship = relationshipFromRow(row, self);
  return {
    playerId: row.player_id,
    displayName: row.username,
    portrait: { kind: "player_sprite", displayColor: row.display_color },
    presence: self || relationship.friendship === "friends"
      ? playerPresence(row.player_id)
      : "hidden",
    relationship
  };
}

function relationshipFromRow(row: RecentPlayerRow, self: boolean): ViewerRelationship {
  if (self) return { friendship: "none", enemyMarkedByViewer: false };
  const friendship = row.viewer_blocked
    ? "blocked_by_viewer"
    : row.target_blocked
      ? "unavailable"
      : row.friends
        ? "friends"
        : row.outgoing
          ? "outgoing_request"
          : row.incoming
            ? "incoming_request"
            : "none";
  return { friendship, enemyMarkedByViewer: row.enemy };
}

function canonicalPairKey(left: string, right: string): string {
  return left < right ? `${left}\u001f${right}` : `${right}\u001f${left}`;
}

function directionalKey(owner: string, recent: string): string {
  return `${owner}\u001f${recent}`;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function interactionPriority(interactionType: RecentPlayerInteractionType): number {
  switch (interactionType) {
    case "nearby": return 1;
    case "local_chat": return 2;
    case "party": return 3;
    case "trade": return 4;
  }
}

function cooldownFor(interactionType: RecentPlayerInteractionType): number {
  switch (interactionType) {
    case "nearby": return NEARBY_COOLDOWN_MS;
    case "local_chat": return LOCAL_CHAT_COOLDOWN_MS;
    case "party": return PARTY_COOLDOWN_MS;
    case "trade": return PARTY_COOLDOWN_MS;
  }
}
