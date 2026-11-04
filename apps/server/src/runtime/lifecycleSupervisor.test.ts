import { afterEach, describe, expect, it, vi } from "vitest";

import { LifecycleSupervisor, PeriodicTask } from "./lifecycleSupervisor.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("LifecycleSupervisor", () => {
  it("starts in order and stops in reverse order", async () => {
    const events: string[] = [];
    const lifecycle = new LifecycleSupervisor(1_000);
    for (const name of ["one", "two", "three"]) {
      lifecycle.register({
        name,
        start: () => { events.push(`start:${name}`); },
        stop: () => { events.push(`stop:${name}`); }
      });
    }
    await lifecycle.start();
    const report = await lifecycle.shutdown();
    expect(events).toEqual([
      "start:one", "start:two", "start:three",
      "stop:three", "stop:two", "stop:one"
    ]);
    expect(report.durable).toBe(true);
  });

  it.each([0, 1, 2])("cleans up every partial-start failure at stage %s", async (failureStage) => {
    const stopped: number[] = [];
    const lifecycle = new LifecycleSupervisor(1_000);
    for (const stage of [0, 1, 2]) {
      lifecycle.register({
        name: `stage-${stage}`,
        start: () => {
          if (stage === failureStage) throw new Error(`failed ${stage}`);
        },
        stop: () => { stopped.push(stage); }
      });
    }
    await expect(lifecycle.start()).rejects.toThrow(`failed ${failureStage}`);
    expect(stopped).toEqual([...Array(failureStage).keys()].reverse());
  });

  it("returns the same idempotent shutdown report", async () => {
    const stop = vi.fn();
    const lifecycle = new LifecycleSupervisor(1_000);
    lifecycle.adopt({ name: "adopted", stop });
    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();
    await expect(first).resolves.toBe(await second);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("reports timeout and mandatory failure while continuing later stops", async () => {
    vi.useFakeTimers();
    const observed: string[] = [];
    const lifecycle = new LifecycleSupervisor(20, (step) => observed.push(step.name));
    lifecycle.adopt({ name: "later", stop: vi.fn() });
    lifecycle.adopt({
      name: "slow",
      stop: () => new Promise<void>((resolve) => setTimeout(resolve, 40))
    });
    const shutdown = lifecycle.shutdown();
    await vi.advanceTimersByTimeAsync(40);
    const report = await shutdown;
    expect(report.durable).toBe(false);
    expect(report.steps.map((step) => step.name)).toEqual(["slow", "later"]);
    expect(report.steps[0]?.timedOut).toBe(true);
    expect(observed).toEqual(["slow", "later"]);
  });

  it("records optional failures without failing durability", async () => {
    const lifecycle = new LifecycleSupervisor(1_000);
    lifecycle.adopt({
      name: "optional",
      mandatory: false,
      stop: () => { throw new Error("optional failure"); }
    });
    const report = await lifecycle.shutdown();
    expect(report.durable).toBe(true);
    expect(report.steps[0]?.error).toBeInstanceOf(Error);
  });
});

describe("PeriodicTask", () => {
  it.each(["skip-while-running", "coalesce-one"] as const)(
    "never overlaps asynchronous work with %s",
    async (overlap) => {
      let active = 0;
      let maximumActive = 0;
      let release!: () => void;
      const task = new PeriodicTask({
        name: "bounded",
        intervalMs: 10,
        overlap,
        run: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise<void>((resolve) => { release = resolve; });
          active -= 1;
        }
      });
      task.trigger();
      await vi.waitFor(() => expect(active).toBe(1));
      task.trigger();
      task.trigger();
      expect(maximumActive).toBe(1);
      release();
      await vi.waitFor(() => expect(task.isRunning()).toBe(overlap === "coalesce-one"));
      if (overlap === "coalesce-one") release();
      await task.stop();
      expect(maximumActive).toBe(1);
    }
  );

  it("clears its timer and does not leak work after stop", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const task = new PeriodicTask({
      name: "timer",
      intervalMs: 10,
      overlap: "skip-while-running",
      run
    });
    task.start();
    await vi.advanceTimersByTimeAsync(25);
    await task.stop();
    const calls = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
});
