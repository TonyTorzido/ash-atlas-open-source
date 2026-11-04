import { describe, expect, it } from "vitest";

import { createPool } from "./pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("database pool PostgreSQL integration", () => {
  it("times out a saturated acquisition and recovers after release", async () => {
    const pool = createPool({
      databaseUrl: databaseUrl!,
      max: 1,
      connectionTimeoutMs: 50,
      idleTimeoutMs: 10_000,
      applicationName: "ash-atlas-pool-test"
    });
    try {
      const held = await pool.connect();
      await expect(pool.connect()).rejects.toThrow(/timeout/i);
      expect(pool.metricsSnapshot()).toMatchObject({
        configuration: { max: 1, connectionTimeoutMs: 50 },
        connections: { total: 1, idle: 0, waiting: 0 },
        acquisitions: { completed: 1, failed: 1, timedOut: 1 }
      });
      held.release();
      await expect(pool.query<{ value: number }>("SELECT 1 AS value"))
        .resolves.toMatchObject({ rows: [{ value: 1 }] });
      expect(pool.metricsSnapshot().acquisitions.completed).toBe(2);
    } finally {
      await pool.end();
    }
    expect(pool.metricsSnapshot().shutdown).toMatchObject({
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      durationMs: expect.any(Number)
    });
  });
});
