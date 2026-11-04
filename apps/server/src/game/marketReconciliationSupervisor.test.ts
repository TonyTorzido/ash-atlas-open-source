import type { MarketReconciliationReport } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppLogger } from "../logger.js";
import type { MarketReconciliationRunResult } from "./marketReconciliation.js";
import { MarketReconciliationSupervisor } from "./marketReconciliationSupervisor.js";

describe("MarketReconciliationSupervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("permits startup only after a clean full reconciliation completes", async () => {
    let now = new Date("2026-07-10T00:00:00.000Z");
    const runner = { reconcileRun: vi.fn(async () => cleanResult()) };
    const supervisor = new MarketReconciliationSupervisor(
      runner,
      logger(),
      { intervalMs: 60_000, staleAfterMs: 180_000 },
      () => now
    );

    const state = await supervisor.start();
    expect(runner.reconcileRun).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      lastRunStartedAt: now.toISOString(),
      lastRunCompletedAt: now.toISOString(),
      lastSuccessfulCompletionAt: now.toISOString(),
      issueCount: 0,
      runInProgress: false,
      stale: false
    });
    expect(supervisor.readiness()).toMatchObject({ ok: true, reason: "healthy" });

    now = new Date(now.getTime() + 180_001);
    expect(supervisor.readiness()).toMatchObject({ ok: false, reason: "stale" });
    await supervisor.stop();
  });

  it("allows protected startup but rejects issues without committed protection", async () => {
    const protectedRunner = { reconcileRun: vi.fn(async () => issueResult(true)) };
    const protectedSupervisor = new MarketReconciliationSupervisor(
      protectedRunner,
      logger(),
      { intervalMs: 60_000, staleAfterMs: 180_000 }
    );
    const state = await protectedSupervisor.start();
    expect(state).toMatchObject({
      issueCount: 1,
      protectionApplied: true,
      globalReadOnly: true
    });
    expect(protectedSupervisor.readiness()).toMatchObject({
      ok: false,
      reason: "never_succeeded"
    });
    await protectedSupervisor.stop();

    const unprotectedSupervisor = new MarketReconciliationSupervisor(
      { reconcileRun: vi.fn(async () => issueResult(false)) },
      logger(),
      { intervalMs: 60_000, staleAfterMs: 180_000 }
    );
    await expect(unprotectedSupervisor.start())
      .rejects.toThrow(/did not commit market protection/i);
  });

  it("fails startup when reconciliation or protection throws", async () => {
    const supervisor = new MarketReconciliationSupervisor(
      { reconcileRun: vi.fn(async () => { throw new Error("protection commit failed"); }) },
      logger(),
      { intervalMs: 60_000, staleAfterMs: 180_000 }
    );
    await expect(supervisor.start()).rejects.toThrow("protection commit failed");
    expect(supervisor.snapshot()).toMatchObject({
      lastError: "protection commit failed",
      runInProgress: false
    });
  });

  it("coalesces concurrent runs and never overlaps them", async () => {
    const gate = deferred<MarketReconciliationRunResult>();
    let active = 0;
    let maximumActive = 0;
    const runner = {
      reconcileRun: vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (runner.reconcileRun.mock.calls.length === 1) return cleanResult();
          return await gate.promise;
        } finally {
          active -= 1;
        }
      })
    };
    const supervisor = new MarketReconciliationSupervisor(
      runner,
      logger(),
      { intervalMs: 60_000, staleAfterMs: 180_000 }
    );
    await supervisor.start();

    const first = supervisor.runNow("manual-one");
    const second = supervisor.runNow("manual-two");
    expect(runner.reconcileRun).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    gate.resolve(cleanResult());
    await Promise.all([first, second]);
    expect(runner.reconcileRun).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    await supervisor.stop();
  });

  it("does not overlap periodic runs when an interval fires during reconciliation", async () => {
    vi.useFakeTimers();
    const gate = deferred<MarketReconciliationRunResult>();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const runner = {
      reconcileRun: vi.fn(async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return calls === 1 ? cleanResult() : await gate.promise;
        } finally {
          active -= 1;
        }
      })
    };
    const supervisor = new MarketReconciliationSupervisor(
      runner,
      logger(),
      { intervalMs: 100, staleAfterMs: 500 }
    );
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(runner.reconcileRun).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(runner.reconcileRun).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);

    gate.resolve(cleanResult());
    await Promise.resolve();
    await Promise.resolve();
    expect(maximumActive).toBe(1);
    expect(runner.reconcileRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    await supervisor.stop();
  });

  it("schedules prompt invariant runs and cancels periodic work on shutdown", async () => {
    vi.useFakeTimers();
    const runner = { reconcileRun: vi.fn(async () => cleanResult()) };
    const supervisor = new MarketReconciliationSupervisor(
      runner,
      logger(),
      { intervalMs: 1_000, staleAfterMs: 3_000 }
    );
    await supervisor.start();
    supervisor.requestImmediate("market_invariant_failure");
    await Promise.resolve();
    expect(runner.reconcileRun).toHaveBeenCalledTimes(2);

    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runner.reconcileRun).toHaveBeenCalledTimes(2);
  });
});

function cleanResult(): MarketReconciliationRunResult {
  return {
    report: report([]),
    protection: {
      protectionApplied: false,
      auditRecorded: false,
      globalReadOnly: false,
      affectedBookIds: [],
      frozenBookIds: []
    }
  };
}

function issueResult(protectionApplied: boolean): MarketReconciliationRunResult {
  const bookId = "20000000-0000-4000-8000-000000000001";
  return {
    report: report([{
      code: "TEST_INVARIANT",
      scope: "book",
      entityId: bookId,
      details: { bookId }
    }]),
    protection: {
      protectionApplied,
      auditRecorded: protectionApplied,
      globalReadOnly: protectionApplied,
      affectedBookIds: [bookId],
      frozenBookIds: protectionApplied ? [bookId] : []
    }
  };
}

function report(issues: MarketReconciliationReport["issues"]): MarketReconciliationReport {
  return {
    ok: issues.length === 0,
    checkedAt: "2026-07-10T00:00:00.000Z",
    orderCount: 0,
    tradeCount: 0,
    ledgerGroupCount: 0,
    collectionCount: 0,
    issues
  };
}

function logger(): AppLogger {
  return {
    info: vi.fn(),
    error: vi.fn()
  } as unknown as AppLogger;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
