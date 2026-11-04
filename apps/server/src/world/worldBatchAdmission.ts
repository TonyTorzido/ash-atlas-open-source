export const WORLD_BATCH_CALLERS = [
  "population-plan",
  "travel",
  "flag",
  "city",
  "wildlife",
  "profile",
  "resource-vision",
  "other"
] as const;

export type WorldBatchCaller = (typeof WORLD_BATCH_CALLERS)[number];
export type WorldBatchPriority = 0 | 1 | 2 | 3;

export type WorldBatchAdmissionResult =
  | "succeeded"
  | "failed"
  | "aborted"
  | "queue-full"
  | "shutdown";

export type WorldBatchCallerMetrics = Readonly<{
  admitted: number;
  succeeded: number;
  failed: number;
  aborted: number;
  rejected: number;
  totalWaitMs: number;
  maximumWaitMs: number;
}>;

export type WorldBatchAdmissionMetrics = Readonly<{
  concurrency: 1;
  queueCapacity: number;
  active: number;
  queueDepth: number;
  maximumActive: number;
  maximumQueueDepth: number;
  callers: Readonly<Record<WorldBatchCaller, WorldBatchCallerMetrics>>;
}>;

type MutableCallerMetrics = {
  admitted: number;
  succeeded: number;
  failed: number;
  aborted: number;
  rejected: number;
  totalWaitMs: number;
  maximumWaitMs: number;
};

type QueuedAdmission = {
  caller: WorldBatchCaller;
  priority: WorldBatchPriority;
  sequence: number;
  enqueuedAt: number;
  signal: AbortSignal | undefined;
  start(): void;
  reject(error: unknown): void;
  removeAbortListener(): void;
};

export class WorldBatchAdmissionRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: "queue-full" | "shutdown",
    readonly retryAfterMs: number
  ) {
    super(message);
    this.name = "WorldBatchAdmissionRejectedError";
  }
}

/**
 * The game process has one World client. This controller is shared by every
 * expensive materializing batch endpoint on that client.
 */
export class WorldBatchAdmissionController {
  private readonly queue: QueuedAdmission[] = [];
  private readonly callers = Object.fromEntries(
    WORLD_BATCH_CALLERS.map((caller) => [
      caller,
      {
        admitted: 0,
        succeeded: 0,
        failed: 0,
        aborted: 0,
        rejected: 0,
        totalWaitMs: 0,
        maximumWaitMs: 0
      }
    ])
  ) as Record<WorldBatchCaller, MutableCallerMetrics>;
  private active = 0;
  private maximumActive = 0;
  private maximumQueueDepth = 0;
  private nextSequence = 0;
  private closed = false;

  constructor(private readonly queueCapacity = 128) {
    if (!Number.isSafeInteger(queueCapacity) || queueCapacity < 1) {
      throw new Error("World batch queue capacity must be a positive safe integer");
    }
  }

  run<T>(
    caller: WorldBatchCaller,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    priority: WorldBatchPriority = defaultWorldBatchPriority(caller),
    onAdmitted?: () => void
  ): Promise<T> {
    throwIfAborted(signal);
    if (this.closed) {
      this.callers[caller].rejected += 1;
      return Promise.reject(new WorldBatchAdmissionRejectedError(
        "World batch admission is shutting down",
        "shutdown",
        1_000
      ));
    }
    if (this.active === 0) {
      return this.start(caller, 0, signal, operation, onAdmitted);
    }
    if (this.queue.length >= this.queueCapacity) {
      this.callers[caller].rejected += 1;
      return Promise.reject(new WorldBatchAdmissionRejectedError(
        "World batch admission queue is full",
        "queue-full",
        1_000
      ));
    }

    return new Promise<T>((resolve, reject) => {
      const enqueuedAt = performance.now();
      const onAbort = (): void => {
        const index = this.queue.indexOf(queued);
        if (index < 0) return;
        this.queue.splice(index, 1);
        queued.removeAbortListener();
        this.callers[caller].aborted += 1;
        reject(abortReason(signal!));
      };
      const queued: QueuedAdmission = {
        caller,
        priority,
        sequence: this.nextSequence++,
        enqueuedAt,
        signal,
        start: () => {
          queued.removeAbortListener();
          void this.start(
            caller,
            performance.now() - enqueuedAt,
            signal,
            operation,
            onAdmitted
          ).then(resolve, reject);
        },
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", onAbort)
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(queued);
      this.queue.sort((left, right) =>
        left.priority - right.priority ||
        left.sequence - right.sequence
      );
      this.maximumQueueDepth = Math.max(this.maximumQueueDepth, this.queue.length);
    });
  }

  close(reason: unknown = new Error("World batch admission is shutting down")): void {
    if (this.closed) return;
    this.closed = true;
    for (const queued of this.queue.splice(0)) {
      queued.removeAbortListener();
      this.callers[queued.caller].rejected += 1;
      queued.reject(reason);
    }
  }

  metrics(): WorldBatchAdmissionMetrics {
    return {
      concurrency: 1,
      queueCapacity: this.queueCapacity,
      active: this.active,
      queueDepth: this.queue.length,
      maximumActive: this.maximumActive,
      maximumQueueDepth: this.maximumQueueDepth,
      callers: Object.fromEntries(
        WORLD_BATCH_CALLERS.map((caller) => [caller, { ...this.callers[caller] }])
      ) as Record<WorldBatchCaller, WorldBatchCallerMetrics>
    };
  }

  private async start<T>(
    caller: WorldBatchCaller,
    waitMs: number,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    onAdmitted?: () => void
  ): Promise<T> {
    throwIfAborted(signal);
    const metrics = this.callers[caller];
    metrics.admitted += 1;
    metrics.totalWaitMs += waitMs;
    metrics.maximumWaitMs = Math.max(metrics.maximumWaitMs, waitMs);
    onAdmitted?.();
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      const result = await operation();
      metrics.succeeded += 1;
      return result;
    } catch (error) {
      if (signal?.aborted) metrics.aborted += 1;
      else metrics.failed += 1;
      throw error;
    } finally {
      this.active -= 1;
      this.admitNext();
    }
  }

  private admitNext(): void {
    while (!this.closed && this.active === 0) {
      const queued = this.queue.shift();
      if (!queued) return;
      if (queued.signal?.aborted) {
        queued.removeAbortListener();
        this.callers[queued.caller].aborted += 1;
        queued.reject(abortReason(queued.signal));
        continue;
      }
      queued.start();
      return;
    }
  }
}

export function defaultWorldBatchPriority(
  caller: WorldBatchCaller
): WorldBatchPriority {
  switch (caller) {
    case "travel":
    case "flag":
      return 0;
    case "resource-vision":
    case "wildlife":
      return 1;
    case "population-plan":
      return 2;
    case "profile":
    case "city":
    case "other":
      return 3;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
