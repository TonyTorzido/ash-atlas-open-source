export type PopulationV2MobRolloutStatus =
  | "completed"
  | "completed_with_shortfall"
  | "retryable_failure"
  | "terminal_diagnostic";

export type PopulationV2MobRolloutRequest = Readonly<{
  generationId: string;
  zoneId: string;
  mobKind: string;
  rolloutRevision: string;
  referenced: boolean;
}>;

export type PopulationV2MobRolloutExecution = Readonly<{
  status: PopulationV2MobRolloutStatus;
  insertedGroupCount: number;
  insertedBodyCount: number;
  shortfallGroupCount: number;
  attemptCount: number;
  retryAfterMs?: number;
  changed: boolean;
}>;

export interface PopulationV2MobRolloutExecutor {
  execute(
    request: PopulationV2MobRolloutRequest
  ): Promise<PopulationV2MobRolloutExecution>;
  markRetryExhausted?(
    request: PopulationV2MobRolloutRequest,
    attemptCount: number
  ): Promise<void>;
}

export type PopulationV2MobRolloutMetrics = Readonly<{
  enabled: boolean;
  queueDepth: number;
  active: boolean;
  enqueued: number;
  deduplicated: number;
  dropped: number;
  attempts: number;
  completed: number;
  completedWithShortfall: number;
  retryableFailures: number;
  terminalDiagnostics: number;
  insertedGroups: number;
  insertedBodies: number;
  runtimeRefreshes: number;
  noOpCompletions: number;
  pressurePauses: number;
}>;

type RolloutOptions = Readonly<{
  enabled: boolean;
  queueMax?: number;
  minimumDelayMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  eventLoopPressureElevated?(): boolean;
  postgresPoolWaiters?(): number;
  hostHealthy?(): boolean;
  notifyRuntime?(zoneId: string): void | Promise<void>;
  warn?(message: string): void;
}>;

type QueuedRollout = Readonly<{
  request: PopulationV2MobRolloutRequest;
  sequence: number;
  notBeforeMs: number;
  workerAttemptCount: number;
}>;

const DEFAULT_QUEUE_MAX = 64;
const DEFAULT_MINIMUM_DELAY_MS = 25;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const WARNING_KEY_LIMIT = 32;
const TRANSIENT_POSTGRES_CODES = new Set([
  "40001",
  "40P01",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03"
]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT"
]);

/**
 * Bounded, single-job Population V2 registered-mob maintenance.
 *
 * Enqueue is deliberately synchronous: player readiness never awaits rollout.
 * Durable idempotency and receipt ownership remain the executor's concern.
 */
export class PopulationV2MobRolloutService {
  private readonly queueMax: number;
  private readonly minimumDelayMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  private readonly queuedKeys = new Set<string>();
  private readonly warnings = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private queue: QueuedRollout[] = [];
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAtMs: number | null = null;
  private running = false;
  private closed = false;
  private counters = {
    enqueued: 0,
    deduplicated: 0,
    dropped: 0,
    attempts: 0,
    completed: 0,
    completedWithShortfall: 0,
    retryableFailures: 0,
    terminalDiagnostics: 0,
    insertedGroups: 0,
    insertedBodies: 0,
    runtimeRefreshes: 0,
    noOpCompletions: 0,
    pressurePauses: 0
  };

  constructor(
    private readonly executor: PopulationV2MobRolloutExecutor,
    private readonly options: RolloutOptions
  ) {
    this.queueMax = positiveInteger(
      options.queueMax ?? DEFAULT_QUEUE_MAX,
      "Population V2 mob rollout queue maximum"
    );
    this.minimumDelayMs = nonNegativeInteger(
      options.minimumDelayMs ?? DEFAULT_MINIMUM_DELAY_MS,
      "Population V2 mob rollout minimum delay"
    );
    this.retryBaseMs = positiveInteger(
      options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      "Population V2 mob rollout retry base"
    );
    this.retryMaxMs = positiveInteger(
      options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
      "Population V2 mob rollout retry maximum"
    );
    this.maxAttempts = positiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "Population V2 mob rollout attempt maximum"
    );
  }

  enqueue(request: PopulationV2MobRolloutRequest): boolean {
    assertRolloutRequest(request);
    if (!this.options.enabled || this.closed) return false;
    const key = rolloutKey(request);
    if (this.queuedKeys.has(key)) {
      this.counters.deduplicated += 1;
      return false;
    }
    if (this.queue.length >= this.queueMax) {
      this.counters.dropped += 1;
      this.warnOnce(
        `queue-full:${request.mobKind}:${request.rolloutRevision}`,
        "Population V2 mob rollout queue is full; optional work was dropped"
      );
      return false;
    }
    this.queuedKeys.add(key);
    this.queue.push({
      request,
      sequence: this.sequence,
      notBeforeMs: Date.now(),
      workerAttemptCount: 0
    });
    this.sequence += 1;
    this.counters.enqueued += 1;
    this.schedule(0);
    return true;
  }

  snapshot(): PopulationV2MobRolloutMetrics {
    return {
      enabled: this.options.enabled,
      queueDepth: this.queue.length,
      active: this.running,
      ...this.counters
    };
  }

  async whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0 && this.timer === null) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.timerDueAtMs = null;
    }
    this.queue = [];
    this.queuedKeys.clear();
    if (this.running) await this.whenIdle();
    this.resolveIdle();
  }

  private schedule(delayMs: number): void {
    if (this.closed || this.running) return;
    const boundedDelayMs = Math.max(0, delayMs);
    const dueAtMs = Date.now() + boundedDelayMs;
    if (
      this.timer !== null
      && this.timerDueAtMs !== null
      && this.timerDueAtMs <= dueAtMs
    ) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timerDueAtMs = dueAtMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAtMs = null;
      void this.runNext();
    }, boundedDelayMs);
    this.timer.unref?.();
  }

  private async runNext(): Promise<void> {
    if (this.closed || this.running) return;
    const next = this.takeNext();
    if (next === null) {
      this.resolveIdle();
      return;
    }
    const remainingDelay = next.notBeforeMs - Date.now();
    if (remainingDelay > 0) {
      this.queue.push(next);
      this.schedule(remainingDelay);
      return;
    }
    if (this.pressureElevated()) {
      this.counters.pressurePauses += 1;
      this.queue.push(next);
      this.schedule(Math.max(1, this.minimumDelayMs));
      return;
    }
    this.running = true;
    const workerAttemptCount = next.workerAttemptCount + 1;
    try {
      await eventLoopYield();
      this.counters.attempts += 1;
      const result = await this.executor.execute(next.request);
      this.recordResult(result);
      const effectiveAttemptCount = Math.max(
        workerAttemptCount,
        result.attemptCount
      );
      if (
        result.status === "retryable_failure"
        && effectiveAttemptCount < this.maxAttempts
        && !this.closed
      ) {
        this.queue.push({
          ...next,
          notBeforeMs: Date.now() + this.retryDelayMs(
            effectiveAttemptCount,
            result.retryAfterMs
          ),
          workerAttemptCount: effectiveAttemptCount
        });
      } else {
        this.queuedKeys.delete(rolloutKey(next.request));
        if (
          result.status === "retryable_failure"
          && effectiveAttemptCount >= this.maxAttempts
        ) {
          await this.executor.markRetryExhausted?.(
            next.request,
            effectiveAttemptCount
          );
          this.counters.terminalDiagnostics += 1;
          this.warnOnce(
            `retry-exhausted:${rolloutKey(next.request)}`,
            "Population V2 mob rollout exhausted its bounded retry budget"
          );
        }
      }
      if (result.changed && result.insertedBodyCount > 0) {
        await this.options.notifyRuntime?.(next.request.zoneId);
        this.counters.runtimeRefreshes += 1;
      }
      await eventLoopYield();
    } catch (error) {
      if (
        isTransientRolloutError(error)
        && workerAttemptCount < this.maxAttempts
        && !this.closed
      ) {
        this.counters.retryableFailures += 1;
        this.queue.push({
          ...next,
          notBeforeMs: Date.now() + this.retryDelayMs(workerAttemptCount),
          workerAttemptCount
        });
      } else {
        this.queuedKeys.delete(rolloutKey(next.request));
        this.counters.terminalDiagnostics += 1;
        if (isTransientRolloutError(error)) {
          this.counters.retryableFailures += 1;
          await this.executor.markRetryExhausted?.(
            next.request,
            workerAttemptCount
          );
        }
        this.warnOnce(
          `executor-threw:${rolloutKey(next.request)}`,
          "Population V2 mob rollout executor exhausted or rejected work: "
            + boundedError(error)
        );
      }
    } finally {
      this.running = false;
      if (this.closed) {
        this.resolveIdle();
      } else if (this.queue.length > 0) {
        this.schedule(this.minimumDelayMs);
      } else {
        this.resolveIdle();
      }
    }
  }

  private takeNext(): QueuedRollout | null {
    if (this.queue.length === 0) return null;
    const now = Date.now();
    this.queue.sort((left, right) =>
      Number(right.notBeforeMs <= now) - Number(left.notBeforeMs <= now)
      || (
        left.notBeforeMs <= now
          ? (
              Number(right.request.referenced)
                - Number(left.request.referenced)
              || left.request.zoneId.localeCompare(right.request.zoneId)
              || left.sequence - right.sequence
            )
          : (
              left.notBeforeMs - right.notBeforeMs
              || Number(right.request.referenced)
                - Number(left.request.referenced)
              || left.request.zoneId.localeCompare(right.request.zoneId)
              || left.sequence - right.sequence
            )
      )
    );
    return this.queue.shift() ?? null;
  }

  private retryDelayMs(
    attemptCount: number,
    requestedDelayMs?: number
  ): number {
    return Math.min(
      this.retryMaxMs,
      requestedDelayMs
        ?? this.retryBaseMs * 2 ** Math.max(0, attemptCount - 1)
    );
  }

  private pressureElevated(): boolean {
    return this.options.eventLoopPressureElevated?.() === true
      || (this.options.postgresPoolWaiters?.() ?? 0) > 0
      || this.options.hostHealthy?.() === false;
  }

  private recordResult(result: PopulationV2MobRolloutExecution): void {
    assertRolloutExecution(result);
    this.counters.insertedGroups += result.insertedGroupCount;
    this.counters.insertedBodies += result.insertedBodyCount;
    if (!result.changed) this.counters.noOpCompletions += 1;
    switch (result.status) {
      case "completed":
        this.counters.completed += 1;
        break;
      case "completed_with_shortfall":
        this.counters.completedWithShortfall += 1;
        break;
      case "retryable_failure":
        this.counters.retryableFailures += 1;
        break;
      case "terminal_diagnostic":
        this.counters.terminalDiagnostics += 1;
        break;
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warnings.has(key) || this.warnings.size >= WARNING_KEY_LIMIT) {
      return;
    }
    this.warnings.add(key);
    this.options.warn?.(message);
  }

  private resolveIdle(): void {
    if (this.running || this.queue.length > 0 || this.timer !== null) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function rolloutKey(request: PopulationV2MobRolloutRequest): string {
  return [
    request.generationId,
    request.mobKind,
    request.rolloutRevision
  ].join("/");
}

function assertRolloutRequest(request: PopulationV2MobRolloutRequest): void {
  for (const [label, value] of [
    ["generation ID", request.generationId],
    ["zone ID", request.zoneId],
    ["mob kind", request.mobKind],
    ["rollout revision", request.rolloutRevision]
  ] as const) {
    if (value.trim().length === 0) {
      throw new Error(`Population V2 mob rollout ${label} is required`);
    }
  }
}

function assertRolloutExecution(
  result: PopulationV2MobRolloutExecution
): void {
  for (const [label, value] of [
    ["inserted group count", result.insertedGroupCount],
    ["inserted body count", result.insertedBodyCount],
    ["shortfall group count", result.shortfallGroupCount],
    ["attempt count", result.attemptCount]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Population V2 mob rollout ${label} is invalid`);
    }
  }
  if (result.changed && result.insertedBodyCount === 0) {
    throw new Error(
      "Population V2 mob rollout cannot report a visible change without inserted bodies"
    );
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function isTransientRolloutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = String((error as { code?: unknown }).code ?? "");
  return code.startsWith("08")
    || TRANSIENT_POSTGRES_CODES.has(code)
    || TRANSIENT_NETWORK_CODES.has(code);
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

async function eventLoopYield(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
