import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import { createLogger } from "../logger.js";
import { ClosedTestTelemetryService } from "./service.js";

describe("hourly telemetry segment rotation", () => {
  it("rejects expired attribution, rotates consecutive segments, and resumes acceptance", async () => {
    const campaignId = "00000000-0000-4000-8000-000000000100";
    let sequence = 0;
    const rotate = vi.fn(async (_text: string, values?: readonly unknown[]) => {
      sequence += 1;
      const start = values?.[1] as Date;
      return {
        rows: [{
          run_id: values?.[2] as string,
          segment_id: values?.[3] as string,
          campaign_id: campaignId,
          segment_sequence: sequence,
          segment_start_at: start,
          segment_end_at: new Date(Date.now() + 60_000),
          release_sha: "a".repeat(40),
          release_generation: "test/t182",
          world_release_id: "world-test",
          population_plan_version: "population-test",
          population_spawn_rules_version: "spawn-test",
          balance_version: "balance-test"
        }],
        rowCount: 1
      };
    });
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn()
    };
    const pool = {
      query: rotate,
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
      metricsSnapshot: testPoolMetrics
    } as unknown as DbPool;
    const service = new ClosedTestTelemetryService(
      loadConfig({
        NODE_ENV: "test",
        RUNTIME_SHA: "a".repeat(40),
        TELEMETRY_ENABLED: "true",
        TELEMETRY_DATABASE_URL: "postgres://telemetry:test@127.0.0.1/test",
        TELEMETRY_RELEASE_GENERATION: "test/t182",
        TELEMETRY_SEGMENT_DURATION_MS: "60000",
        WORLD_REQUIRED_RELEASE_ID: "world-test"
      }),
      createLogger("test"),
      pool
    );
    const freeze = vi.fn(async () => undefined);
    service.setRunFreezeHandler(freeze);
    service.setActiveRunForTest({
      runId: "00000000-0000-4000-8000-000000000001",
      segmentId: "00000000-0000-4000-8000-000000000010",
      campaignId,
      segmentSequence: 0,
      segmentStartAt: new Date(Date.now() - 60_001),
      segmentEndAt: new Date(Date.now() - 1),
      releaseSha: "a".repeat(40),
      releaseGeneration: "test/t182",
      worldReleaseId: "world-test",
      populationPlanVersion: "population-test",
      populationSpawnRulesVersion: "spawn-test",
      balanceVersion: "balance-test"
    });

    expect(service.recordEvent({
      eventFamily: "session",
      eventType: "must_not_cross_boundary",
      priority: "critical"
    })).toBe(false);

    await service.rotateActiveSegmentForTest();
    expect(freeze).toHaveBeenLastCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "segment_rotation"
    );
    expect(service.recordEvent({
      eventFamily: "session",
      eventType: "new_segment_accepts",
      priority: "critical"
    })).toBe(true);
    const firstSuccessor = service.metricsSnapshot().activeRunId;

    await service.rotateActiveSegmentForTest();
    expect(sequence).toBe(2);
    expect(service.metricsSnapshot().activeRunId).not.toBe(firstSuccessor);
    expect(rotate).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });
});

function testPoolMetrics(): ReturnType<DbPool["metricsSnapshot"]> {
  return {
    configuration: {
      max: 2,
      connectionTimeoutMs: 100,
      idleTimeoutMs: 100,
      queryTimeoutMs: 100,
      statementTimeoutMs: 100,
      applicationName: "telemetry-rotation-test"
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
