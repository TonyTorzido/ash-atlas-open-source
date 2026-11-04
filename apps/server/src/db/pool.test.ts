import { describe, expect, it, vi } from "vitest";

import { createPool } from "./pool.js";

describe("database pool configuration", () => {
  it("preserves the existing pool size and timeout defaults", async () => {
    const pool = createPool({
      databaseUrl: "postgres://example:example@127.0.0.1:1/example"
    });
    expect(pool.metricsSnapshot()).toMatchObject({
      configuration: {
        max: 10,
        connectionTimeoutMs: 0,
        idleTimeoutMs: 10_000,
        applicationName: null
      },
      connections: { total: 0, idle: 0, waiting: 0 },
      acquisitions: { completed: 0, failed: 0, timedOut: 0 }
    });
    await pool.end();
    expect(pool.metricsSnapshot().shutdown.durationMs).toEqual(expect.any(Number));
  });

  it("records unexpected idle client errors without exposing credentials", async () => {
    const error = vi.fn();
    const pool = createPool({
      databaseUrl: "postgres://secret-user:secret-password@127.0.0.1:1/secret-db",
      applicationName: "ash-atlas-test",
      logger: { error }
    });
    pool.emit("error", new Error("simulated idle client failure"));
    const metrics = pool.metricsSnapshot();
    expect(metrics.unexpectedIdleErrors).toMatchObject({
      count: 1,
      lastMessage: "simulated idle client failure"
    });
    expect(JSON.stringify(metrics)).not.toContain("secret-password");
    expect(error).toHaveBeenCalledOnce();
    await pool.end();
  });
});
