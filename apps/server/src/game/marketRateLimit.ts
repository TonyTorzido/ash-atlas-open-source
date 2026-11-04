import type pg from "pg";

import { MarketError } from "./marketRules.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** PostgreSQL-backed quota shared by every server process and WebSocket session. */
export async function reserveMarketRate(
  queryable: Queryable,
  playerId: string,
  bucket: string,
  maximum: number
): Promise<void> {
  const result = await queryable.query(
    `INSERT INTO market_rate_windows (player_id, action_bucket, window_started_at, request_count)
     VALUES ($1,$2,date_trunc('minute', clock_timestamp()),1)
     ON CONFLICT (player_id, action_bucket, window_started_at)
     DO UPDATE SET request_count = market_rate_windows.request_count + 1
     WHERE market_rate_windows.request_count < $3
     RETURNING request_count`,
    [playerId, bucket, maximum]
  );
  if (result.rowCount !== 1) {
    throw new MarketError("MARKET_RATE_LIMITED", "Market request rate limit reached");
  }
}
