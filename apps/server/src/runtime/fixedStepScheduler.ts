export type FixedStepSchedulerMetrics = {
  elapsedMs: number;
  callbackCount: number;
  meanCallbackIntervalMs: number | null;
  minCallbackIntervalMs: number | null;
  maxCallbackIntervalMs: number | null;
  p95CallbackIntervalMs: number | null;
  p99CallbackIntervalMs: number | null;
  simulationSteps: number;
  simulationStepsPerSecond: number;
  catchUpSteps: number;
  maxBurstSteps: number;
  droppedBacklogSteps: number;
  backlogResetEvents: number;
};

type FixedStepSchedulerOptions = {
  stepHz: number;
  onStep: (deltaSeconds: number) => void;
  maxCatchUpSteps?: number;
  metricsIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  onMetrics?: (metrics: FixedStepSchedulerMetrics) => void;
};

type MetricsWindow = {
  startedAtMs: number;
  callbackCount: number;
  callbackIntervalCount: number;
  callbackIntervalTotalMs: number;
  minCallbackIntervalMs: number;
  maxCallbackIntervalMs: number;
  callbackIntervalsMs: number[];
  simulationSteps: number;
  catchUpSteps: number;
  maxBurstSteps: number;
  droppedBacklogSteps: number;
  backlogResetEvents: number;
};

export class FixedStepScheduler {
  private readonly stepMs: number;
  private readonly stepSeconds: number;
  private readonly maxCatchUpSteps: number;
  private readonly metricsIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly onStep: (deltaSeconds: number) => void;
  private readonly onMetrics: ((metrics: FixedStepSchedulerMetrics) => void) | undefined;
  private timer: unknown = null;
  private running = false;
  private nextStepAtMs = 0;
  private lastCallbackAtMs: number | null = null;
  private metrics: MetricsWindow | null = null;

  constructor(options: FixedStepSchedulerOptions) {
    if (!Number.isFinite(options.stepHz) || options.stepHz <= 0) {
      throw new Error("Fixed step rate must be positive and finite");
    }
    const maxCatchUpSteps = options.maxCatchUpSteps ?? 4;
    if (!Number.isInteger(maxCatchUpSteps) || maxCatchUpSteps < 1) {
      throw new Error("Maximum catch-up steps must be a positive integer");
    }
    const metricsIntervalMs = options.metricsIntervalMs ?? 30_000;
    if (!Number.isFinite(metricsIntervalMs) || metricsIntervalMs <= 0) {
      throw new Error("Metrics interval must be positive and finite");
    }

    this.stepMs = 1_000 / options.stepHz;
    this.stepSeconds = 1 / options.stepHz;
    this.maxCatchUpSteps = maxCatchUpSteps;
    this.metricsIntervalMs = metricsIntervalMs;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.onStep = options.onStep;
    this.onMetrics = options.onMetrics;
  }

  start(): void {
    if (this.running) {
      return;
    }
    const nowMs = this.now();
    this.running = true;
    this.nextStepAtMs = nowMs + this.stepMs;
    this.lastCallbackAtMs = null;
    this.metrics = createMetricsWindow(nowMs);
    this.schedule(nowMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private schedule(nowMs: number): void {
    if (!this.running) {
      return;
    }
    const delayMs = Math.max(0, this.nextStepAtMs - nowMs);
    this.timer = this.setTimer(() => this.runCallback(), delayMs);
  }

  private runCallback(): void {
    if (!this.running) {
      return;
    }
    this.timer = null;
    const callbackAtMs = this.now();
    const metrics = this.metrics ?? createMetricsWindow(callbackAtMs);
    this.metrics = metrics;
    metrics.callbackCount += 1;
    if (this.lastCallbackAtMs !== null) {
      const intervalMs = Math.max(0, callbackAtMs - this.lastCallbackAtMs);
      metrics.callbackIntervalCount += 1;
      metrics.callbackIntervalTotalMs += intervalMs;
      metrics.minCallbackIntervalMs = Math.min(metrics.minCallbackIntervalMs, intervalMs);
      metrics.maxCallbackIntervalMs = Math.max(metrics.maxCallbackIntervalMs, intervalMs);
      metrics.callbackIntervalsMs.push(intervalMs);
    }
    this.lastCallbackAtMs = callbackAtMs;

    if (callbackAtMs + Number.EPSILON >= this.nextStepAtMs) {
      const dueSteps = Math.floor((callbackAtMs - this.nextStepAtMs) / this.stepMs) + 1;
      const stepsToProcess = Math.min(dueSteps, this.maxCatchUpSteps);
      metrics.simulationSteps += stepsToProcess;
      metrics.catchUpSteps += Math.max(0, stepsToProcess - 1);
      metrics.maxBurstSteps = Math.max(metrics.maxBurstSteps, stepsToProcess);

      for (let step = 0; step < stepsToProcess; step += 1) {
        this.onStep(this.stepSeconds);
      }

      if (dueSteps > this.maxCatchUpSteps) {
        metrics.droppedBacklogSteps += dueSteps - stepsToProcess;
        metrics.backlogResetEvents += 1;
        this.nextStepAtMs = callbackAtMs + this.stepMs;
      } else {
        this.nextStepAtMs += dueSteps * this.stepMs;
      }
    }

    this.emitMetricsIfDue(callbackAtMs);
    this.schedule(this.now());
  }

  private emitMetricsIfDue(nowMs: number): void {
    const metrics = this.metrics;
    if (!metrics || nowMs - metrics.startedAtMs < this.metricsIntervalMs) {
      return;
    }
    const elapsedMs = Math.max(0, nowMs - metrics.startedAtMs);
    this.onMetrics?.({
      elapsedMs,
      callbackCount: metrics.callbackCount,
      meanCallbackIntervalMs: metrics.callbackIntervalCount > 0
        ? metrics.callbackIntervalTotalMs / metrics.callbackIntervalCount
        : null,
      minCallbackIntervalMs: Number.isFinite(metrics.minCallbackIntervalMs)
        ? metrics.minCallbackIntervalMs
        : null,
      maxCallbackIntervalMs: Number.isFinite(metrics.maxCallbackIntervalMs)
        ? metrics.maxCallbackIntervalMs
        : null,
      p95CallbackIntervalMs: percentile(metrics.callbackIntervalsMs, 0.95),
      p99CallbackIntervalMs: percentile(metrics.callbackIntervalsMs, 0.99),
      simulationSteps: metrics.simulationSteps,
      simulationStepsPerSecond: elapsedMs > 0
        ? metrics.simulationSteps * 1_000 / elapsedMs
        : 0,
      catchUpSteps: metrics.catchUpSteps,
      maxBurstSteps: metrics.maxBurstSteps,
      droppedBacklogSteps: metrics.droppedBacklogSteps,
      backlogResetEvents: metrics.backlogResetEvents
    });
    this.metrics = createMetricsWindow(nowMs);
  }
}

function createMetricsWindow(startedAtMs: number): MetricsWindow {
  return {
    startedAtMs,
    callbackCount: 0,
    callbackIntervalCount: 0,
    callbackIntervalTotalMs: 0,
    minCallbackIntervalMs: Number.POSITIVE_INFINITY,
    maxCallbackIntervalMs: Number.NEGATIVE_INFINITY,
    callbackIntervalsMs: [],
    simulationSteps: 0,
    catchUpSteps: 0,
    maxBurstSteps: 0,
    droppedBacklogSteps: 0,
    backlogResetEvents: 0
  };
}

function percentile(values: readonly number[], percentileRank: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileRank) - 1)
  )] ?? null;
}
