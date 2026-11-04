import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../config.js";
import { sendError } from "./errors.js";

export type HttpAdmissionPolicy = "standard" | "expensive";

export type HttpAdmissionMetrics = {
  accepted: number;
  rejected: number;
  rateLimitRejected: number;
  queueCapacityRejected: number;
  handlerTimedOut: number;
  active: number;
  queued: number;
  queueDepth: number;
  timedOut: number;
  clientCancelled: number;
  shutdownCancelled: number;
  completed: number;
  queueWaitCount: number;
  totalQueueWaitMs: number;
  maximumQueueWaitMs: number;
  handlerDurationCount: number;
  totalHandlerDurationMs: number;
  maximumHandlerDurationMs: number;
};

export type HttpAdmissionHealthMetrics = Pick<
  HttpAdmissionMetrics,
  | "accepted"
  | "rejected"
  | "active"
  | "queued"
  | "queueDepth"
  | "timedOut"
  | "handlerTimedOut"
  | "completed"
>;

type Pool = {
  active: number;
  concurrency: number;
  maximumQueueDepth: number;
  queueTimeoutMs: number;
  queue: Waiter[];
};

type Waiter = {
  settled: boolean;
  enqueuedAtMs: number;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  onAbort(): void;
  resolve(result: AcquireResult): void;
};

type AcquireResult = "acquired" | "queue-capacity" | "timed-out" | "cancelled" | "shutdown";

type RequestLifecycle = {
  controller: AbortController;
  cleanup(): void;
};

type Permit = {
  policy: HttpAdmissionPolicy;
  acquiredAtMs: number;
  handlerTimer: NodeJS.Timeout | null;
  released: boolean;
  lifecycle: RequestLifecycle;
};

const WINDOW_MS = 60_000;
const MAXIMUM_RATE_KEYS = 100_000;
export const HTTP_ADMISSION_MAX_HANDLER_MS = 30_000;

export class HttpAdmissionController {
  private readonly limiter = new BoundedFixedWindow(MAXIMUM_RATE_KEYS);
  private readonly pools: Record<HttpAdmissionPolicy, Pool>;
  private readonly permits = new WeakMap<FastifyRequest, Permit>();
  private readonly lifecycles = new WeakMap<FastifyRequest, RequestLifecycle>();
  private shuttingDown = false;
  private readonly counters = {
    accepted: 0,
    rejected: 0,
    rateLimitRejected: 0,
    queueCapacityRejected: 0,
    handlerTimedOut: 0,
    queued: 0,
    timedOut: 0,
    clientCancelled: 0,
    shutdownCancelled: 0,
    completed: 0,
    queueWaitCount: 0,
    totalQueueWaitMs: 0,
    maximumQueueWaitMs: 0,
    handlerDurationCount: 0,
    totalHandlerDurationMs: 0,
    maximumHandlerDurationMs: 0
  };

  constructor(private readonly config: AppConfig) {
    this.pools = {
      standard: {
        active: 0,
        concurrency: config.HTTP_STANDARD_CONCURRENCY,
        maximumQueueDepth: config.HTTP_STANDARD_QUEUE_MAX,
        queueTimeoutMs: config.HTTP_STANDARD_QUEUE_TIMEOUT_MS,
        queue: []
      },
      expensive: {
        active: 0,
        concurrency: config.HTTP_EXPENSIVE_CONCURRENCY,
        maximumQueueDepth: config.HTTP_EXPENSIVE_QUEUE_MAX,
        queueTimeoutMs: config.HTTP_EXPENSIVE_QUEUE_TIMEOUT_MS,
        queue: []
      }
    };
  }

  install(app: FastifyInstance, policies: ReadonlyMap<string, HttpAdmissionPolicy>): void {
    app.addHook("preHandler", async (request, reply) => {
      const route = request.routeOptions.url ?? request.url;
      const policy = policies.get(`${request.method.toUpperCase()} ${route}`);
      if (!policy) return;
      await this.admit(request, reply, policy);
    });
    app.addHook("onResponse", async (request) => {
      this.release(request, true);
    });
    app.addHook("onClose", async () => {
      this.shutdown();
    });
  }

  signalFor(request: FastifyRequest): AbortSignal {
    return this.lifecycles.get(request)?.controller.signal ?? AbortSignal.abort();
  }

  metricsSnapshot(): HttpAdmissionMetrics {
    return {
      ...this.counters,
      active: this.pools.standard.active + this.pools.expensive.active,
      queueDepth: this.pools.standard.queue.length + this.pools.expensive.queue.length
    };
  }

  healthMetricsSnapshot(): HttpAdmissionHealthMetrics {
    const metrics = this.metricsSnapshot();
    return {
      accepted: metrics.accepted,
      rejected: metrics.rejected,
      active: metrics.active,
      queued: metrics.queued,
      queueDepth: metrics.queueDepth,
      timedOut: metrics.timedOut,
      handlerTimedOut: metrics.handlerTimedOut,
      completed: metrics.completed
    };
  }

  private async admit(
    request: FastifyRequest,
    reply: FastifyReply,
    policy: HttpAdmissionPolicy
  ): Promise<void> {
    const lifecycle = this.createLifecycle(request, reply);
    if (lifecycle.controller.signal.aborted) return;
    const maximum = policy === "expensive"
      ? this.config.HTTP_EXPENSIVE_RATE_PER_MINUTE
      : this.config.HTTP_STANDARD_RATE_PER_MINUTE;
    const identity = request.authSession?.player?.id
      ? `player:${request.authSession.player.id}`
      : request.authSession?.account.id
        ? `account:${request.authSession.account.id}`
        : "unauthenticated";
    const now = Date.now();
    const identityRate = this.limiter.reserve(`${policy}:identity:${identity}`, maximum, now);
    const networkRate = this.limiter.reserve(
      `${policy}:network:${request.ip}`,
      maximum * this.config.HTTP_NETWORK_RATE_MULTIPLIER,
      now
    );
    if (!identityRate.allowed || !networkRate.allowed) {
      this.counters.rejected += 1;
      this.counters.rateLimitRejected += 1;
      const retryAfterSeconds = Math.max(
        identityRate.allowed ? 0 : identityRate.retryAfterSeconds,
        networkRate.allowed ? 0 : networkRate.retryAfterSeconds,
        1
      );
      reply.header("Retry-After", String(retryAfterSeconds));
      sendError(reply, 429, "HTTP_RATE_LIMITED", "request rate limit exceeded; retry later");
      lifecycle.cleanup();
      return;
    }

    const acquired = await this.acquire(this.pools[policy], lifecycle.controller.signal);
    if (acquired !== "acquired") {
      lifecycle.cleanup();
      if (acquired === "cancelled" || acquired === "shutdown") return;
      this.counters.rejected += 1;
      if (acquired === "queue-capacity") this.counters.queueCapacityRejected += 1;
      reply.header("Retry-After", "1");
      sendError(reply, 429, "HTTP_ADMISSION_BUSY", "request capacity is busy; retry later");
      return;
    }
    const permit: Permit = {
      policy,
      acquiredAtMs: performance.now(),
      handlerTimer: null,
      released: false,
      lifecycle
    };
    this.permits.set(request, permit);
    permit.handlerTimer = setTimeout(() => {
      if (permit.released) return;
      this.counters.handlerTimedOut += 1;
      permit.lifecycle.controller.abort();
      this.release(request, false);
    }, HTTP_ADMISSION_MAX_HANDLER_MS);
    permit.handlerTimer.unref?.();
    this.counters.accepted += 1;
    if (lifecycle.controller.signal.aborted) this.release(request, false);
  }

  private acquire(pool: Pool, signal: AbortSignal): Promise<AcquireResult> {
    if (this.shuttingDown) return Promise.resolve("shutdown");
    if (signal.aborted) return Promise.resolve("cancelled");
    if (pool.active < pool.concurrency) {
      pool.active += 1;
      return Promise.resolve("acquired");
    }
    if (pool.queue.length >= pool.maximumQueueDepth) {
      return Promise.resolve("queue-capacity");
    }
    this.counters.queued += 1;
    return new Promise<AcquireResult>((resolve) => {
      const waiter: Waiter = {
        settled: false,
        enqueuedAtMs: performance.now(),
        timer: undefined as unknown as NodeJS.Timeout,
        signal,
        onAbort: () => undefined,
        resolve
      };
      const settle = (result: AcquireResult): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        const index = pool.queue.indexOf(waiter);
        if (index >= 0) pool.queue.splice(index, 1);
        this.recordQueueWait(performance.now() - waiter.enqueuedAtMs);
        resolve(result);
      };
      waiter.onAbort = () => {
        settle("cancelled");
      };
      waiter.timer = setTimeout(() => {
        this.counters.timedOut += 1;
        settle("timed-out");
      }, pool.queueTimeoutMs);
      waiter.timer.unref?.();
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      pool.queue.push(waiter);
    });
  }

  private release(request: FastifyRequest, completed: boolean): void {
    const permit = this.permits.get(request);
    if (!permit || permit.released) return;
    permit.released = true;
    this.permits.delete(request);
    if (permit.handlerTimer) clearTimeout(permit.handlerTimer);
    permit.lifecycle.cleanup();
    const pool = this.pools[permit.policy];
    pool.active = Math.max(0, pool.active - 1);
    if (completed) {
      this.counters.completed += 1;
      const durationMs = Math.max(0, performance.now() - permit.acquiredAtMs);
      this.counters.handlerDurationCount += 1;
      this.counters.totalHandlerDurationMs += durationMs;
      this.counters.maximumHandlerDurationMs = Math.max(
        this.counters.maximumHandlerDurationMs,
        durationMs
      );
    }
    for (;;) {
      const waiter = pool.queue.shift();
      if (!waiter) return;
      if (waiter.settled || waiter.signal.aborted) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.recordQueueWait(performance.now() - waiter.enqueuedAtMs);
      pool.active += 1;
      waiter.resolve("acquired");
      return;
    }
  }

  private createLifecycle(request: FastifyRequest, reply: FastifyReply): RequestLifecycle {
    const controller = new AbortController();
    const abort = (): void => {
      if (controller.signal.aborted) return;
      this.counters.clientCancelled += 1;
      controller.abort();
      this.release(request, false);
    };
    const onClose = (): void => {
      if (reply.raw.writableFinished) this.release(request, true);
      else abort();
    };
    const onFinish = (): void => this.release(request, true);
    request.raw.once("aborted", abort);
    reply.raw.once("close", onClose);
    reply.raw.once("finish", onFinish);
    const lifecycle: RequestLifecycle = {
      controller,
      cleanup: () => {
        request.raw.removeListener("aborted", abort);
        reply.raw.removeListener("close", onClose);
        reply.raw.removeListener("finish", onFinish);
        this.lifecycles.delete(request);
      }
    };
    this.lifecycles.set(request, lifecycle);
    return lifecycle;
  }

  private recordQueueWait(durationMs: number): void {
    this.counters.queueWaitCount += 1;
    this.counters.totalQueueWaitMs += durationMs;
    this.counters.maximumQueueWaitMs = Math.max(
      this.counters.maximumQueueWaitMs,
      durationMs
    );
  }

  private shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const pool of Object.values(this.pools)) {
      const waiters = pool.queue.splice(0);
      for (const waiter of waiters) {
        if (waiter.settled) continue;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        this.recordQueueWait(performance.now() - waiter.enqueuedAtMs);
        this.counters.shutdownCancelled += 1;
        waiter.resolve("shutdown");
      }
    }
  }
}

type RateResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

class BoundedFixedWindow {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private overflowWindow = { startedAt: 0, count: 0 };

  constructor(private readonly maximumKeys: number) {}

  reserve(key: string, maximum: number, now: number): RateResult {
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= WINDOW_MS) {
      if (!window && !this.ensureCapacity(now)) {
        window = this.overflowWindow;
        if (now - window.startedAt >= WINDOW_MS) {
          window.startedAt = now;
          window.count = 0;
        }
      } else {
        window = { startedAt: now, count: 0 };
        this.windows.delete(key);
        this.windows.set(key, window);
      }
    }
    if (window.count >= maximum) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - window.startedAt)) / 1_000))
      };
    }
    window.count += 1;
    return { allowed: true };
  }

  private ensureCapacity(now: number): boolean {
    if (this.windows.size < this.maximumKeys) return true;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= WINDOW_MS) this.windows.delete(key);
    }
    return this.windows.size < this.maximumKeys;
  }
}
