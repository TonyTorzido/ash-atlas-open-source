import {
  WEEKLY_LEADERBOARD_CATEGORIES,
  type WeeklyLeaderboardCategory,
  type WeeklyLeaderboardSnapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../logger.js";
import {
  ATLAS_TIME_ZONE,
  AtlasClock,
  mountainMidnight,
  mountainWeek,
  shiftIsoDate
} from "./atlasClock.js";

const PROJECTION_BATCH_SIZE = 2_000;
const PROJECTION_INTERVAL_MS = 60_000;
const MAX_PROJECTION_BATCHES_PER_FLUSH = 10;

export type LeaderboardWeek = "current" | "previous";

export type WeeklyLeaderboardPeriod = {
  timezone: typeof ATLAS_TIME_ZONE;
  weekStart: string;
  weekStartAt: Date;
  nextWeekStartAt: Date;
  archived: boolean;
};

type RankedRow = {
  category: WeeklyLeaderboardCategory;
  player_id: string;
  display_name: string;
  value: string | number;
  reached_at: Date | string;
  rank: string | number;
  own_rank: string | number | null;
};

export class WeeklyLeaderboardService {
  private supervisor: NodeJS.Timeout | null = null;
  private flushing: Promise<number> | null = null;
  private lastProjectionError: string | null = null;
  private lastSuccessfulProjectionAt: string | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: AppLogger,
    private readonly clock = new AtlasClock()
  ) {}

  start(): void {
    if (this.supervisor) throw new Error("weekly leaderboard supervisor is already running");
    void this.flush().catch((error: unknown) => {
      this.noteProjectionFailure(error);
    });
    this.supervisor = setInterval(() => {
      void this.flush().catch((error: unknown) => {
        this.noteProjectionFailure(error);
      });
    }, PROJECTION_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.supervisor) {
      clearInterval(this.supervisor);
      this.supervisor = null;
    }
    await this.flushing?.catch(() => undefined);
  }

  flush(): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = this.projectPending()
      .then((projected) => {
        this.lastProjectionError = null;
        this.lastSuccessfulProjectionAt = new Date().toISOString();
        return projected;
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  diagnostics(): Readonly<{
    running: boolean;
    flushInProgress: boolean;
    lastError: string | null;
    lastSuccessfulProjectionAt: string | null;
  }> {
    return {
      running: this.supervisor !== null,
      flushInProgress: this.flushing !== null,
      lastError: this.lastProjectionError,
      lastSuccessfulProjectionAt: this.lastSuccessfulProjectionAt
    };
  }

  async snapshot(
    playerId: string,
    requestedWeek: LeaderboardWeek = "current"
  ): Promise<WeeklyLeaderboardSnapshot> {
    try {
      await this.flush();
    } catch (error) {
      this.noteProjectionFailure(error);
    }

    const now = this.clock.now();
    const period = resolveWeeklyLeaderboardPeriod(this.clock, requestedWeek);
    const { weekStart, weekStartAt, nextWeekStartAt } = period;

    const ranked = await this.pool.query<RankedRow>(
      `WITH ranked AS (
         SELECT total.category,total.player_id,player.username AS display_name,
                total.value,total.reached_at,
                row_number() OVER (
                  PARTITION BY total.category
                  ORDER BY total.value DESC,total.reached_at ASC,total.player_id ASC
                ) AS rank
         FROM weekly_leaderboard_totals total
         JOIN players player ON player.id=total.player_id
         LEFT JOIN accounts account ON account.id=player.account_id
         WHERE total.week_start=$1::date
           AND (player.account_id IS NULL OR account.status='active')
       ),
       own AS (
         SELECT category,rank AS own_rank
         FROM ranked
         WHERE player_id=$2
       )
       SELECT ranked.category,ranked.player_id,ranked.display_name,
              ranked.value,ranked.reached_at,ranked.rank,own.own_rank
       FROM ranked
       LEFT JOIN own ON own.category=ranked.category
       WHERE ranked.rank <= 100
          OR (
            own.own_rank > 100
            AND ranked.rank BETWEEN own.own_rank - 2 AND own.own_rank + 2
          )
       ORDER BY ranked.category,ranked.rank`,
      [weekStart, playerId]
    );

    const byCategory = new Map<WeeklyLeaderboardCategory, RankedRow[]>();
    for (const row of ranked.rows) {
      const rows = byCategory.get(row.category) ?? [];
      rows.push(row);
      byCategory.set(row.category, rows);
    }
    const boards = WEEKLY_LEADERBOARD_CATEGORIES.map((category) => {
      const rows = byCategory.get(category) ?? [];
      const own = rows.find((row) => row.player_id === playerId);
      const ownRank = own ? asNumber(own.rank) : null;
      return {
        category,
        top: rows
          .filter((row) => asNumber(row.rank) <= 100)
          .map(publicEntry),
        personal: {
          category,
          value: own ? asNumber(own.value) : 0,
          rank: ownRank,
          reachedAt: own ? asIso(own.reached_at) : null,
          nearby: ownRank !== null && ownRank > 100
            ? rows
                .filter((row) => Math.abs(asNumber(row.rank) - ownRank) <= 2)
                .map(publicEntry)
            : []
        }
      };
    });

    return {
      timezone: ATLAS_TIME_ZONE,
      weekStart,
      weekStartAt: weekStartAt.toISOString(),
      nextWeekStart: nextWeekStartAt.toISOString(),
      previousWeekStart: shiftIsoDate(weekStart, -7),
      serverNow: now.toISOString(),
      remainingSeconds: requestedWeek === "current"
        ? Math.max(0, Math.floor((nextWeekStartAt.getTime() - now.getTime()) / 1_000))
        : 0,
      archived: period.archived,
      boards
    };
  }

  private async projectPending(): Promise<number> {
    let projected = 0;
    for (let batch = 0; batch < MAX_PROJECTION_BATCHES_PER_FLUSH; batch += 1) {
      const batchSize = await this.projectBatch();
      projected += batchSize;
      if (batchSize < PROJECTION_BATCH_SIZE) break;
    }
    return projected;
  }

  private async projectBatch(): Promise<number> {
    const result = await this.pool.query(
      `WITH claimed AS MATERIALIZED (
         SELECT event_id,week_start,player_id,category,value,occurred_at
         FROM weekly_leaderboard_events
         WHERE projected_at IS NULL
         ORDER BY event_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       ),
       aggregated AS (
         SELECT week_start,player_id,category,
                sum(value)::bigint AS value,
                max(occurred_at) AS reached_at
         FROM claimed
         GROUP BY week_start,player_id,category
       ),
       upserted AS (
         INSERT INTO weekly_leaderboard_totals (
           week_start,player_id,category,value,reached_at
         )
         SELECT week_start,player_id,category,value,reached_at
         FROM aggregated
         ON CONFLICT (week_start,player_id,category) DO UPDATE
         SET value=weekly_leaderboard_totals.value + EXCLUDED.value,
             reached_at=GREATEST(
               weekly_leaderboard_totals.reached_at,
               EXCLUDED.reached_at
             ),
             updated_at=now()
         RETURNING 1
       )
       UPDATE weekly_leaderboard_events event
       SET projected_at=now()
       FROM claimed
       WHERE event.event_id=claimed.event_id
         AND (SELECT count(*) FROM upserted) >= 0`,
      [PROJECTION_BATCH_SIZE]
    );
    return result.rowCount ?? 0;
  }

  private noteProjectionFailure(error: unknown): void {
    const summary = (error instanceof Error ? error.message : String(error)).slice(0, 240);
    this.lastProjectionError = summary;
    this.logger.warn(
      { err: error, leaderboard: this.diagnostics() },
      "weekly leaderboard projection failed; durable events remain retryable"
    );
  }
}

export function resolveWeeklyLeaderboardPeriod(
  clock: AtlasClock,
  requestedWeek: LeaderboardWeek
): WeeklyLeaderboardPeriod {
  const current = mountainWeek(clock.now());
  const weekStart = requestedWeek === "current"
    ? current.weekStart
    : shiftIsoDate(current.weekStart, -7);
  const weekStartAt = requestedWeek === "current"
    ? current.weekStartAt
    : mountainMidnight(weekStart);
  const nextWeekStartAt = requestedWeek === "current"
    ? current.nextWeekStartAt
    : mountainMidnight(shiftIsoDate(weekStart, 7));
  return {
    timezone: ATLAS_TIME_ZONE,
    weekStart,
    weekStartAt,
    nextWeekStartAt,
    archived: requestedWeek === "previous"
  };
}

function publicEntry(row: RankedRow): WeeklyLeaderboardSnapshot["boards"][number]["top"][number] {
  return {
    rank: asNumber(row.rank),
    playerId: row.player_id,
    displayName: row.display_name,
    value: asNumber(row.value),
    reachedAt: asIso(row.reached_at)
  };
}

function asNumber(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("weekly leaderboard value is outside the safe integer range");
  }
  return parsed;
}

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("weekly leaderboard timestamp is invalid");
  }
  return date.toISOString();
}
