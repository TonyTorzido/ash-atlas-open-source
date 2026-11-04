import { describe, expect, it, vi } from "vitest";

import type { WorldBatchAdmissionRejectedError } from "./worldBatchAdmission.js";
import { WorldBatchAdmissionController } from "./worldBatchAdmission.js";

describe("WorldBatchAdmissionController", () => {
  it("bounds and serializes the queue while aborting queued work cleanly", async () => {
    const admission = new WorldBatchAdmissionController(2);
    const active = deferred<void>();
    const first = admission.run("population-plan", undefined, async () => {
      await active.promise;
      return "first";
    });
    const abortController = new AbortController();
    const abortedOperation = vi.fn(async () => "aborted-operation");
    const aborted = admission.run(
      "travel",
      abortController.signal,
      abortedOperation
    );
    const thirdOperation = vi.fn(async () => "third");
    const third = admission.run("flag", undefined, thirdOperation);
    const rejected = admission.run("profile", undefined, async () => "fourth");

    await expect(rejected).rejects.toMatchObject({
      reason: "queue-full"
    } satisfies Partial<WorldBatchAdmissionRejectedError>);
    abortController.abort(new DOMException("cancelled", "AbortError"));
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedOperation).not.toHaveBeenCalled();
    expect(admission.metrics()).toMatchObject({
      active: 1,
      queueDepth: 1,
      maximumActive: 1,
      maximumQueueDepth: 2
    });

    active.resolve();
    await expect(first).resolves.toBe("first");
    await expect(third).resolves.toBe("third");
    expect(thirdOperation).toHaveBeenCalledOnce();
    expect(admission.metrics()).toMatchObject({
      active: 0,
      queueDepth: 0,
      maximumActive: 1
    });
  });

  it("releases the active permit and rejects every queued waiter on shutdown", async () => {
    const admission = new WorldBatchAdmissionController(4);
    const activeController = new AbortController();
    const active = admission.run(
      "population-plan",
      activeController.signal,
      () => waitForAbort(activeController.signal)
    );
    const queued = admission.run("city", undefined, async () => "queued");

    admission.close();
    activeController.abort(new DOMException("shutdown", "AbortError"));
    const results = await Promise.allSettled([active, queued]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(admission.metrics()).toMatchObject({
      active: 0,
      queueDepth: 0,
      maximumActive: 1,
      maximumQueueDepth: 1
    });
  });

  it("marks a request admitted only after it leaves the queue", async () => {
    const admission = new WorldBatchAdmissionController(2);
    const activeGate = deferred<void>();
    const active = admission.run("profile", undefined, async () => {
      await activeGate.promise;
    });
    const onAdmitted = vi.fn();
    const abortController = new AbortController();
    const queued = admission.run(
      "population-plan",
      abortController.signal,
      async () => "queued",
      0,
      onAdmitted
    );

    expect(onAdmitted).not.toHaveBeenCalled();
    abortController.abort(new DOMException("cancelled", "AbortError"));
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(onAdmitted).not.toHaveBeenCalled();

    activeGate.resolve();
    await active;
  });

  it("runs required visible work next after twenty older background requests", async () => {
    const admission = new WorldBatchAdmissionController(32);
    const activeGate = deferred<void>();
    const executionOrder: string[] = [];
    const active = admission.run("profile", undefined, async () => {
      executionOrder.push("active");
      await activeGate.promise;
    }, 3);
    const background = Array.from({ length: 20 }, (_, index) =>
      admission.run("profile", undefined, async () => {
        executionOrder.push(`background-${index}`);
      }, 3)
    );
    const required = admission.run("population-plan", undefined, async () => {
      executionOrder.push("required");
    }, 0);

    activeGate.resolve();
    await active;
    await required;
    expect(executionOrder.slice(0, 2)).toEqual(["active", "required"]);
    await Promise.all(background);
    expect(admission.metrics().maximumActive).toBe(1);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return {
    promise,
    resolve: (value?: T) => resolve(value as T)
  };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(signal.reason),
      { once: true }
    );
  });
}
