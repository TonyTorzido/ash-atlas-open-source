import {
  CHAT_PUBLIC_CHANNEL_KEYS,
  WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS,
  type DeveloperLeaderboardMetric,
  type DeveloperLeaderboardPlayer,
  type DeveloperLeaderboardPlayerInspector,
  type DeveloperLeaderboardPrivateRanking,
  type WeeklyLeaderboardCategory
} from "@ash-atlas/shared";
import type pg from "pg";

import { AtlasClock } from "./atlasClock.js";
import {
  resolveWeeklyLeaderboardPeriod,
  type LeaderboardWeek,
  type WeeklyLeaderboardService
} from "./weeklyLeaderboards.js";

const PRIVATE_CHAT_METRIC_KEY = "public_chat_messages";

type PlayerRow = {
  player_id: string;
  display_name: string;
  eligible: boolean;
};

type PublicMetricRow = {
  category: WeeklyLeaderboardCategory;
  value: string | number;
  reached_at: Date | string;
  rank: string | number | null;
};

type PrivateMetricRow = {
  player_id: string;
  display_name: string;
  eligible: boolean;
  value: string | number;
  reached_at: Date | string;
  general_count: string | number;
  trading_count: string | number;
  hunting_count: string | number;
  rank: string | number | null;
};

type PrivateMetricDefinition = {
  key: string;
  label: string;
  group: string;
  inspect(
    playerId: string,
    period: ReturnType<typeof resolveWeeklyLeaderboardPeriod>
  ): Promise<DeveloperLeaderboardMetric>;
  ranking(
    period: ReturnType<typeof resolveWeeklyLeaderboardPeriod>
  ): Promise<DeveloperLeaderboardPrivateRanking["entries"]>;
};

export class DeveloperLeaderboardError extends Error {
  constructor(
    readonly code: "PLAYER_NOT_FOUND" | "PRIVATE_METRIC_NOT_FOUND",
    message: string,
    readonly statusCode = 404
  ) {
    super(message);
    this.name = "DeveloperLeaderboardError";
  }
}

export class DeveloperLeaderboardService {
  private readonly privateMetrics: readonly PrivateMetricDefinition[];

  constructor(
    private readonly pool: pg.Pool,
    private readonly publicLeaderboards: WeeklyLeaderboardService,
    private readonly clock = new AtlasClock()
  ) {
    this.privateMetrics = [{
      key: PRIVATE_CHAT_METRIC_KEY,
      label: "Public Chat Messages",
      group: "owner_metrics",
      inspect: (playerId, period) => this.inspectPublicChat(playerId, period),
      ranking: (period) => this.rankPublicChat(period)
    }];
  }

  async searchPlayers(search: string): Promise<{ players: DeveloperLeaderboardPlayer[] }> {
    const normalized = search.trim();
    const result = await this.pool.query<PlayerRow>(
      `SELECT player.id AS player_id,player.username AS display_name,
              (player.account_id IS NULL OR account.status='active') AS eligible
       FROM players player
       LEFT JOIN accounts account ON account.id=player.account_id
       WHERE $1='' OR player.id ILIKE '%' || $1 || '%'
          OR player.username ILIKE '%' || $1 || '%'
       ORDER BY
         CASE WHEN lower(player.id)=lower($1) THEN 0
              WHEN lower(player.username)=lower($1) THEN 1 ELSE 2 END,
         player.username_normalized,player.id
       LIMIT 25`,
      [normalized]
    );
    return { players: result.rows.map(playerView) };
  }

  async inspectPlayer(
    playerId: string,
    requestedWeek: LeaderboardWeek
  ): Promise<DeveloperLeaderboardPlayerInspector> {
    await this.publicLeaderboards.flush().catch(() => undefined);
    const player = await this.requirePlayer(playerId);
    const period = resolveWeeklyLeaderboardPeriod(this.clock, requestedWeek);
    const publicRows = await this.pool.query<PublicMetricRow>(
      `WITH ranked AS (
         SELECT total.category,total.player_id,total.value,total.reached_at,
                row_number() OVER (
                  PARTITION BY total.category
                  ORDER BY total.value DESC,total.reached_at ASC,total.player_id ASC
                ) AS rank
         FROM weekly_leaderboard_totals total
         JOIN players player ON player.id=total.player_id
         LEFT JOIN accounts account ON account.id=player.account_id
         WHERE total.week_start=$1::date
           AND (player.account_id IS NULL OR account.status='active')
       )
       SELECT total.category,total.value,total.reached_at,
              CASE WHEN $3::boolean THEN ranked.rank ELSE NULL END AS rank
       FROM weekly_leaderboard_totals total
       LEFT JOIN ranked
         ON ranked.category=total.category AND ranked.player_id=total.player_id
       WHERE total.week_start=$1::date AND total.player_id=$2`,
      [period.weekStart, playerId, player.eligible]
    );
    const byCategory = new Map(
      publicRows.rows.map((row) => [row.category, row] as const)
    );
    const publicMetrics: DeveloperLeaderboardMetric[] =
      WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS.map((definition) => {
        const row = byCategory.get(definition.key);
        return {
          key: definition.key,
          label: definition.label,
          group: definition.group,
          visibility: "public",
          value: row ? asNumber(row.value) : 0,
          rank: row?.rank === null || row?.rank === undefined
            ? null
            : asNumber(row.rank),
          reachedAt: row ? asIso(row.reached_at) : null
        };
      });
    const privateMetrics = await Promise.all(
      this.privateMetrics.map((metric) => metric.inspect(playerId, period))
    );
    return {
      period: periodView(period),
      player,
      metrics: [...publicMetrics, ...privateMetrics]
    };
  }

  async privateRanking(
    metricKey: string,
    requestedWeek: LeaderboardWeek
  ): Promise<DeveloperLeaderboardPrivateRanking> {
    const metric = this.privateMetrics.find(({ key }) => key === metricKey);
    if (!metric) {
      throw new DeveloperLeaderboardError(
        "PRIVATE_METRIC_NOT_FOUND",
        "Private leaderboard metric does not exist"
      );
    }
    const period = resolveWeeklyLeaderboardPeriod(this.clock, requestedWeek);
    return {
      period: periodView(period),
      metric: { key: metric.key, label: metric.label },
      entries: await metric.ranking(period)
    };
  }

  private async requirePlayer(playerId: string): Promise<DeveloperLeaderboardPlayer> {
    const result = await this.pool.query<PlayerRow>(
      `SELECT player.id AS player_id,player.username AS display_name,
              (player.account_id IS NULL OR account.status='active') AS eligible
       FROM players player
       LEFT JOIN accounts account ON account.id=player.account_id
       WHERE player.id=$1`,
      [playerId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new DeveloperLeaderboardError("PLAYER_NOT_FOUND", "Player does not exist");
    }
    return playerView(row);
  }

  private async inspectPublicChat(
    playerId: string,
    period: ReturnType<typeof resolveWeeklyLeaderboardPeriod>
  ): Promise<DeveloperLeaderboardMetric> {
    const result = await this.publicChatRows(period, playerId);
    const row = result[0];
    return {
      key: PRIVATE_CHAT_METRIC_KEY,
      label: "Public Chat Messages",
      group: "owner_metrics",
      visibility: "owner_only",
      value: row ? asNumber(row.value) : 0,
      rank: row?.rank === null || row?.rank === undefined ? null : asNumber(row.rank),
      reachedAt: row ? asIso(row.reached_at) : null,
      breakdown: [
        { key: "general", label: "General", value: row ? asNumber(row.general_count) : 0 },
        { key: "trading", label: "Trading", value: row ? asNumber(row.trading_count) : 0 },
        { key: "hunting", label: "Hunting", value: row ? asNumber(row.hunting_count) : 0 }
      ]
    };
  }

  private async rankPublicChat(
    period: ReturnType<typeof resolveWeeklyLeaderboardPeriod>
  ): Promise<DeveloperLeaderboardPrivateRanking["entries"]> {
    const rows = await this.publicChatRows(period, null);
    return rows.slice(0, 100).map((row) => ({
      rank: asNumber(row.rank!),
      playerId: row.player_id,
      displayName: row.display_name,
      value: asNumber(row.value),
      reachedAt: asIso(row.reached_at)
    }));
  }

  private async publicChatRows(
    period: ReturnType<typeof resolveWeeklyLeaderboardPeriod>,
    selectedPlayerId: string | null
  ): Promise<PrivateMetricRow[]> {
    const result = await this.pool.query<PrivateMetricRow>(
      `WITH totals AS (
         SELECT message.sender_player_id AS player_id,
                count(*)::bigint AS value,
                max(message.created_at) AS reached_at,
                count(*) FILTER (WHERE channel.channel_key=$3)::bigint AS general_count,
                count(*) FILTER (WHERE channel.channel_key=$4)::bigint AS trading_count,
                count(*) FILTER (WHERE channel.channel_key=$5)::bigint AS hunting_count
         FROM chat_messages message
         JOIN chat_channels channel ON channel.id=message.channel_id
         WHERE message.created_at >= $1
           AND message.created_at < $2
           AND message.message_status='visible'
           AND channel.channel_key=ANY($6::text[])
         GROUP BY message.sender_player_id
       ), ranked AS (
         SELECT totals.*,
                row_number() OVER (
                  ORDER BY totals.value DESC,totals.reached_at ASC,totals.player_id ASC
                ) AS rank
         FROM totals
         JOIN players player ON player.id=totals.player_id
         LEFT JOIN accounts account ON account.id=player.account_id
         WHERE player.account_id IS NULL OR account.status='active'
       )
       SELECT totals.player_id,player.username AS display_name,
              (player.account_id IS NULL OR account.status='active') AS eligible,
              totals.value,totals.reached_at,totals.general_count,
              totals.trading_count,totals.hunting_count,
              CASE WHEN player.account_id IS NULL OR account.status='active'
                   THEN ranked.rank ELSE NULL END AS rank
       FROM totals
       JOIN players player ON player.id=totals.player_id
       LEFT JOIN accounts account ON account.id=player.account_id
       LEFT JOIN ranked ON ranked.player_id=totals.player_id
       WHERE $7::text IS NULL OR totals.player_id=$7
       ORDER BY ranked.rank NULLS LAST,totals.player_id
       LIMIT 100`,
      [
        period.weekStartAt,
        period.nextWeekStartAt,
        CHAT_PUBLIC_CHANNEL_KEYS[0],
        CHAT_PUBLIC_CHANNEL_KEYS[1],
        CHAT_PUBLIC_CHANNEL_KEYS[2],
        [...CHAT_PUBLIC_CHANNEL_KEYS],
        selectedPlayerId
      ]
    );
    return result.rows;
  }
}

function playerView(row: PlayerRow): DeveloperLeaderboardPlayer {
  return {
    playerId: row.player_id,
    displayName: row.display_name,
    eligible: row.eligible
  };
}

function periodView(
  period: ReturnType<typeof resolveWeeklyLeaderboardPeriod>
): DeveloperLeaderboardPlayerInspector["period"] {
  return {
    timezone: period.timezone,
    weekStart: period.weekStart,
    weekStartAt: period.weekStartAt.toISOString(),
    nextWeekStart: period.nextWeekStartAt.toISOString(),
    archived: period.archived
  };
}

function asNumber(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("leaderboard value is outside the safe integer range");
  }
  return parsed;
}

function asIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("leaderboard date is invalid");
  return parsed.toISOString();
}
