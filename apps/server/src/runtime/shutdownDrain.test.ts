import { describe, expect, it, vi } from "vitest";

import { awaitMandatoryShutdownStep } from "./shutdownDrain.js";

describe("awaitMandatoryShutdownStep", () => {
  it("reports a deadline but remains pending until in-flight durability work settles", async () => {
    vi.useFakeTimers();
    let resolveWork!: () => void;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    const step = awaitMandatoryShutdownStep(work, 50);
    let completed = false;
    void step.then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(completed).toBe(false);
    resolveWork();
    await expect(step).resolves.toEqual({ timedOut: true, error: null });
    vi.useRealTimers();
  });

  it("returns a mandatory failure without throwing away the error", async () => {
    const failure = new Error("database unavailable");
    await expect(awaitMandatoryShutdownStep(Promise.reject(failure), 50)).resolves.toEqual({
      timedOut: false,
      error: failure
    });
  });
});
