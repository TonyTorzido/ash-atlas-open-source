import { describe, expect, it, vi } from "vitest";

import { reserveMarketRate } from "./marketRateLimit.js";

describe("authoritative market rate windows", () => {
  it("uses one PostgreSQL identity window and returns a stable rejection", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ request_count: 1 }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const queryable = { query };
    await expect(reserveMarketRate(queryable as never, "player-one", "book", 1))
      .resolves.toBeUndefined();
    await expect(reserveMarketRate(queryable as never, "player-one", "book", 1))
      .rejects.toMatchObject({ code: "MARKET_RATE_LIMITED", retryable: false });
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ON CONFLICT (player_id, action_bucket, window_started_at)"),
      ["player-one", "book", 1]
    );
  });
});
