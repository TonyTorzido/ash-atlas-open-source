import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import { createLogger } from "../logger.js";
import { ClosedTestTelemetryService } from "./service.js";

describe("closed-test telemetry recovery", () => {
  it("starts without blocking gameplay when telemetry PostgreSQL is unavailable", async () => {
    const pool = {
      query: async () => {
        throw new Error("expected unavailable telemetry database");
      },
      connect: async () => {
        throw new Error("expected unavailable telemetry database");
      },
      end: async () => undefined,
      metricsSnapshot: testPoolMetrics
    } as unknown as DbPool;
    const service = new ClosedTestTelemetryService(
      loadConfig({
        NODE_ENV: "test",
        RUNTIME_SHA: "a".repeat(40),
        TELEMETRY_ENABLED: "true",
        TELEMETRY_DATABASE_URL: "postgres://telemetry:test@127.0.0.1/test",
        TELEMETRY_RELEASE_GENERATION: "test/t182",
        TELEMETRY_FLUSH_INTERVAL_MS: "1",
        WORLD_REQUIRED_RELEASE_ID: "world-test"
      }),
      createLogger("test"),
      pool
    );

    expect(() => service.start()).not.toThrow();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (service.metricsSnapshot().lastDatabaseError !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(service.metricsSnapshot()).toMatchObject({
      activeRunId: null,
      queue: { depth: 0 },
      writeFailures: 0,
      lastDatabaseError: "expected unavailable telemetry database"
    });
    await service.shutdown();
  });

  it("uses health-only writes to recover after failures empty the queue", async () => {
    let rejectConnections = true;
    const queries: string[] = [];
    const client = {
      query: async (query: string) => {
        queries.push(query);
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => {
        if (rejectConnections) throw new Error("expected telemetry database failure");
        return client;
      },
      end: async () => undefined,
      metricsSnapshot: testPoolMetrics
    } as unknown as DbPool;
    const releaseSha = "a".repeat(40);
    const service = new ClosedTestTelemetryService(
      loadConfig({
        NODE_ENV: "test",
        RUNTIME_SHA: releaseSha,
        TELEMETRY_ENABLED: "true",
        TELEMETRY_DATABASE_URL: "postgres://telemetry:test@127.0.0.1/test",
        TELEMETRY_RELEASE_GENERATION: "test/t182",
        TELEMETRY_FLUSH_INTERVAL_MS: "1",
        TELEMETRY_RECOVERY_HEALTHY_INTERVALS: "3",
        WORLD_REQUIRED_RELEASE_ID: "world-test"
      }),
      createLogger("test"),
      pool
    );
    service.setActiveRunForTest({
      runId: "00000000-0000-4000-8000-000000000001",
      segmentId: null,
      campaignId: null,
      segmentSequence: null,
      segmentStartAt: null,
      segmentEndAt: null,
      releaseSha,
      releaseGeneration: "test/t182",
      worldReleaseId: "world-test",
      populationPlanVersion: "population-test",
      populationSpawnRulesVersion: "spawn-test",
      balanceVersion: "balance-test"
    });

    for (let failure = 0; failure < 3; failure += 1) {
      expect(service.recordEvent({
        eventFamily: "connection",
        eventType: `failure-${failure}`,
        priority: "routine"
      })).toBe(true);
      await service.flush();
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    expect(service.metricsSnapshot()).toMatchObject({
      degraded: true,
      queue: { depth: 0 },
      writeFailures: 3
    });

    rejectConnections = false;
    for (let interval = 0; interval < 3; interval += 1) {
      await service.flush();
    }

    expect(service.metricsSnapshot()).toMatchObject({
      degraded: false,
      queue: { depth: 0 },
      rowsFlushed: 0
    });
    expect(
      queries.filter((query) => query.includes("INSERT INTO telemetry.telemetry_health"))
    ).toHaveLength(3);
    await service.shutdown();
  });
});

function testPoolMetrics(): ReturnType<DbPool["metricsSnapshot"]> {
  return {
    configuration: {
      max: 1,
      connectionTimeoutMs: 100,
      idleTimeoutMs: 100,
      queryTimeoutMs: 100,
      statementTimeoutMs: 100,
      applicationName: "telemetry-recovery-test"
    },
    connections: { total: 1, idle: 1, waiting: 0 },
    acquisitions: {
      completed: 0,
      failed: 0,
      timedOut: 0,
      totalWaitMs: 0,
      averageWaitMs: 0,
      maxWaitMs: 0,
      lastWaitMs: null
    },
    unexpectedIdleErrors: { count: 0, lastAt: null, lastMessage: null },
    shutdown: { startedAt: null, completedAt: null, durationMs: null }
  };
}
