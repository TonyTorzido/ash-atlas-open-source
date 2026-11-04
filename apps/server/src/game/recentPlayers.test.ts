import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { RecentPlayersService } from "./recentPlayers.js";

describe("RecentPlayersService", () => {
  it("retries one failed batch and drains the successful retry", async () => {
    const first = client(true);
    const second = client(false);
    const pool = { connect: vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second) } as unknown as pg.Pool;
    const service = new RecentPlayersService(pool, {
      now: () => new Date("2026-07-15T12:00:00.000Z"),
      scheduleFlush: () => undefined
    });

    service.recordLocalDelivery("a", ["b"]);
    await service.drain();

    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(first.query).toHaveBeenCalledWith("ROLLBACK");
    expect(second.query).toHaveBeenCalledWith("COMMIT");
    expect(service.metricsSnapshot()).toMatchObject({
      batchRetries: 1,
      batchFailures: 0,
      batchesPersisted: 1
    });
  });

  it("keeps the deferred interaction buffer bounded under pathological entry volume", () => {
    const pool = { connect: vi.fn() } as unknown as pg.Pool;
    const service = new RecentPlayersService(pool, { scheduleFlush: () => undefined });
    service.recordMutualVisibility(
      Array.from({ length: 5_100 }, (_, index) => [`owner-${index}`, `peer-${index}`] as const)
    );
    expect(service.metricsSnapshot().interactionsDropped).toBeGreaterThan(0);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

function client(failInsert: boolean) {
  let failed = false;
  return {
    query: vi.fn(async (sql: string) => {
      if (failInsert && !failed && sql.includes("INSERT INTO recent_players")) {
        failed = true;
        throw new Error("transient database failure");
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn()
  };
}
