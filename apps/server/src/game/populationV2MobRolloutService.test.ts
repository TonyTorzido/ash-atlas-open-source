import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type PopulationV2MobRolloutExecution,
  PopulationV2MobRolloutService
} from "./populationV2MobRolloutService.js";

const request = (overrides: Partial<{
  generationId: string;
  zoneId: string;
  mobKind: string;
  rolloutRevision: string;
  referenced: boolean;
}> = {}) => ({
  generationId: "00000000-0000-8000-8000-000000000001",
  zoneId: "population-zone-v2:1:1",
  mobKind: "sap_crawler",
  rolloutRevision: "sap-crawler-flat-anchor-v1",
  referenced: true,
  ...overrides
});

const result = (
  overrides: Partial<PopulationV2MobRolloutExecution> = {}
): PopulationV2MobRolloutExecution => ({
  status: "completed",
  insertedGroupCount: 1,
  insertedBodyCount: 6,
  shortfallGroupCount: 0,
  attemptCount: 1,
  changed: true,
  ...overrides
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PopulationV2MobRolloutService", () => {
  it("deduplicates one generation/mob/revision and refreshes only after insertion", async () => {
    const execute = vi.fn(async () => result());
    const notifyRuntime = vi.fn();
    const service = new PopulationV2MobRolloutService(
      { execute },
      { enabled: true, minimumDelayMs: 0, notifyRuntime }
    );

    expect(service.enqueue(request())).toBe(true);
    expect(service.enqueue(request())).toBe(false);
    await service.whenIdle();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(notifyRuntime).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toMatchObject({
      deduplicated: 1,
      completed: 1,
      insertedGroups: 1,
      insertedBodies: 6,
      runtimeRefreshes: 1
    });
    await service.close();
  });

  it("records deterministic shortfall once without refresh or retry", async () => {
    const execute = vi.fn(async () => result({
      status: "completed_with_shortfall",
      insertedGroupCount: 0,
      insertedBodyCount: 0,
      shortfallGroupCount: 1,
      changed: false
    }));
    const notifyRuntime = vi.fn();
    const service = new PopulationV2MobRolloutService(
      { execute },
      { enabled: true, minimumDelayMs: 0, notifyRuntime }
    );

    service.enqueue(request());
    await service.whenIdle();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(notifyRuntime).not.toHaveBeenCalled();
    expect(service.snapshot()).toMatchObject({
      completedWithShortfall: 1,
      noOpCompletions: 1,
      runtimeRefreshes: 0
    });
    await service.close();
  });

  it("bounds transient retries and makes exhaustion terminal", async () => {
    const execute = vi.fn(async () => result({
      status: "retryable_failure",
      insertedGroupCount: 0,
      insertedBodyCount: 0,
      attemptCount: execute.mock.calls.length,
      changed: false,
      retryAfterMs: 1
    }));
    const markRetryExhausted = vi.fn();
    const service = new PopulationV2MobRolloutService(
      { execute, markRetryExhausted },
      {
        enabled: true,
        minimumDelayMs: 0,
        retryBaseMs: 1,
        retryMaxMs: 1,
        maxAttempts: 3
      }
    );

    service.enqueue(request());
    await service.whenIdle();

    expect(execute).toHaveBeenCalledTimes(3);
    expect(markRetryExhausted).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toMatchObject({
      retryableFailures: 3,
      terminalDiagnostics: 1,
      runtimeRefreshes: 0
    });
    await service.close();
  });

  it("retries transient executor throws with bounded backoff", async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("connection lost"), { code: "08006" });
    });
    const markRetryExhausted = vi.fn();
    const service = new PopulationV2MobRolloutService(
      { execute, markRetryExhausted },
      {
        enabled: true,
        minimumDelayMs: 0,
        retryBaseMs: 1,
        retryMaxMs: 1,
        maxAttempts: 3
      }
    );

    service.enqueue(request());
    await service.whenIdle();

    expect(execute).toHaveBeenCalledTimes(3);
    expect(markRetryExhausted).toHaveBeenCalledWith(request(), 3);
    expect(service.snapshot()).toMatchObject({
      attempts: 3,
      retryableFailures: 3,
      terminalDiagnostics: 1,
      runtimeRefreshes: 0
    });
    await service.close();
  });

  it("runs newly ready work before a referenced retry that is not due", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const execute = vi.fn(async (entry: ReturnType<typeof request>) => {
      order.push(entry.zoneId);
      return entry.zoneId === "referenced" && order.length === 1
        ? result({
            status: "retryable_failure",
            insertedGroupCount: 0,
            insertedBodyCount: 0,
            changed: false,
            retryAfterMs: 1_000
          })
        : result({
            insertedGroupCount: 0,
            insertedBodyCount: 0,
            changed: false
          });
    });
    const service = new PopulationV2MobRolloutService(
      { execute },
      {
        enabled: true,
        minimumDelayMs: 0,
        retryBaseMs: 1_000,
        retryMaxMs: 1_000
      }
    );

    service.enqueue(request({ zoneId: "referenced" }));
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(["referenced"]);

    service.enqueue(request({
      generationId: "00000000-0000-8000-8000-000000000004",
      zoneId: "ready-unreferenced",
      referenced: false
    }));
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(["referenced", "ready-unreferenced"]);

    await vi.advanceTimersByTimeAsync(1_000);
    await service.whenIdle();
    expect(order).toEqual([
      "referenced",
      "ready-unreferenced",
      "referenced"
    ]);
    await service.close();
  });

  it("prioritizes referenced work and pauses while the pool has waiters", async () => {
    let poolWaiters = 1;
    const order: string[] = [];
    const execute = vi.fn(async (entry: ReturnType<typeof request>) => {
      order.push(entry.zoneId);
      return result();
    });
    const service = new PopulationV2MobRolloutService(
      { execute },
      {
        enabled: true,
        minimumDelayMs: 1,
        postgresPoolWaiters: () => poolWaiters
      }
    );

    service.enqueue(request({
      generationId: "00000000-0000-8000-8000-000000000002",
      zoneId: "unreferenced",
      referenced: false
    }));
    service.enqueue(request({
      generationId: "00000000-0000-8000-8000-000000000003",
      zoneId: "referenced",
      referenced: true
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(execute).not.toHaveBeenCalled();
    poolWaiters = 0;
    await service.whenIdle();

    expect(order).toEqual(["referenced", "unreferenced"]);
    expect(service.snapshot().pressurePauses).toBeGreaterThan(0);
    await service.close();
  });

  it("pauses while host health is degraded", async () => {
    let healthy = false;
    const execute = vi.fn(async () => result());
    const service = new PopulationV2MobRolloutService(
      { execute },
      {
        enabled: true,
        minimumDelayMs: 1,
        hostHealthy: () => healthy
      }
    );

    service.enqueue(request());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(execute).not.toHaveBeenCalled();
    healthy = true;
    await service.whenIdle();

    expect(execute).toHaveBeenCalledOnce();
    expect(service.snapshot().pressurePauses).toBeGreaterThan(0);
    await service.close();
  });

  it("honors the kill switch without scheduling work", async () => {
    const execute = vi.fn(async () => result());
    const service = new PopulationV2MobRolloutService(
      { execute },
      { enabled: false }
    );

    expect(service.enqueue(request())).toBe(false);
    await service.whenIdle();
    expect(execute).not.toHaveBeenCalled();
    await service.close();
  });
});
