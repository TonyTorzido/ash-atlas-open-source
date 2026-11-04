import { describe, expect, it, vi } from "vitest";

import { FixedStepScheduler, type FixedStepSchedulerMetrics } from "./fixedStepScheduler.js";

describe("fixed-step scheduler", () => {
  it("maintains about 20 fixed steps per wall-clock second through repeated 62 ms callbacks", () => {
    const clock = new LateClock(12);
    const step = vi.fn();
    const scheduler = createScheduler(clock, step);

    scheduler.start();
    clock.advanceTo(1_012);

    expect(step).toHaveBeenCalledTimes(20);
    expect(step).toHaveBeenCalledWith(0.05);
  });

  it("bounds catch-up after a 200 ms stall", () => {
    const clock = new LateClock();
    const step = vi.fn();
    const metrics: FixedStepSchedulerMetrics[] = [];
    const scheduler = createScheduler(clock, step, metrics);
    scheduler.start();

    clock.stallNextCallbackBy(150);
    clock.runNext();
    clock.advanceTo(1_000);

    expect(Math.max(...metrics.map((sample) => sample.maxBurstSteps))).toBeLessThanOrEqual(4);
    expect(step).toHaveBeenCalledTimes(20);
  });

  it("caps and drops a very long backlog instead of processing thousands of steps", () => {
    const clock = new LateClock();
    const step = vi.fn();
    const metrics: FixedStepSchedulerMetrics[] = [];
    const scheduler = createScheduler(clock, step, metrics);
    scheduler.start();

    clock.stallNextCallbackBy(60_000);
    clock.runNext();

    expect(step).toHaveBeenCalledTimes(4);
    expect(metrics.at(-1)).toMatchObject({
      maxBurstSteps: 4,
      backlogResetEvents: 1
    });
    expect(metrics.at(-1)!.droppedBacklogSteps).toBeGreaterThan(1_000);
  });

  it("processes exactly one step per normal 50 ms callback", () => {
    const clock = new LateClock();
    const step = vi.fn();
    const scheduler = createScheduler(clock, step);
    scheduler.start();

    for (let count = 1; count <= 10; count += 1) {
      clock.advanceTo(count * 50);
      expect(step).toHaveBeenCalledTimes(count);
    }
  });

  it("stops cleanly and prevents further ticks", () => {
    const clock = new LateClock();
    const step = vi.fn();
    const scheduler = createScheduler(clock, step);
    scheduler.start();
    clock.advanceTo(50);

    scheduler.stop();
    clock.advanceTo(1_000);

    expect(step).toHaveBeenCalledOnce();
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("never overlaps callbacks", () => {
    const clock = new LateClock();
    let active = false;
    const step = vi.fn(() => {
      expect(active).toBe(false);
      active = true;
      clock.runDueTimers();
      active = false;
    });
    const scheduler = createScheduler(clock, step);

    scheduler.start();
    clock.advanceTo(500);

    expect(step).toHaveBeenCalledTimes(10);
  });
});

function createScheduler(
  clock: LateClock,
  step: (deltaSeconds: number) => void,
  metrics: FixedStepSchedulerMetrics[] = []
): FixedStepScheduler {
  return new FixedStepScheduler({
    stepHz: 20,
    maxCatchUpSteps: 4,
    metricsIntervalMs: 1,
    now: () => clock.now,
    setTimer: (callback, delayMs) => clock.setTimer(callback, delayMs),
    clearTimer: (timer) => clock.clearTimer(timer),
    onStep: step,
    onMetrics: (sample) => metrics.push(sample)
  });
}

class LateClock {
  now = 0;
  private nextId = 1;
  private defaultLatenessMs: number;
  private nextStallMs = 0;
  private readonly timers = new Map<number, { atMs: number; callback: () => void }>();

  constructor(defaultLatenessMs = 0) {
    this.defaultLatenessMs = defaultLatenessMs;
  }

  setTimer(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, {
      atMs: this.now + Math.max(0, delayMs) + this.defaultLatenessMs + this.nextStallMs,
      callback
    });
    this.nextStallMs = 0;
    return id;
  }

  clearTimer(id: unknown): void {
    this.timers.delete(id as number);
  }

  stallNextCallbackBy(delayMs: number): void {
    const next = this.nextTimer();
    if (next) {
      const timer = this.timers.get(next.id)!;
      timer.atMs += delayMs;
      return;
    }
    this.nextStallMs = delayMs;
  }

  runNext(): void {
    const next = this.nextTimer();
    if (!next) {
      return;
    }
    this.now = next.atMs;
    this.timers.delete(next.id);
    next.callback();
  }

  advanceTo(targetMs: number): void {
    while (true) {
      const next = this.nextTimer();
      if (!next || next.atMs > targetMs) {
        break;
      }
      this.now = next.atMs;
      this.timers.delete(next.id);
      next.callback();
    }
    this.now = Math.max(this.now, targetMs);
  }

  runDueTimers(): void {
    const due = [...this.timers.entries()].filter(([, timer]) => timer.atMs <= this.now);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
    }
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  private nextTimer(): { id: number; atMs: number; callback: () => void } | null {
    let next: { id: number; atMs: number; callback: () => void } | null = null;
    for (const [id, timer] of this.timers) {
      if (!next || timer.atMs < next.atMs) {
        next = { id, ...timer };
      }
    }
    return next;
  }
}
