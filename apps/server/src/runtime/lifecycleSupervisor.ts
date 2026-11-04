import { awaitMandatoryShutdownStep } from "./shutdownDrain.js";

export type LifecycleService = Readonly<{
  name: string;
  start?(): unknown | Promise<unknown>;
  stop(): unknown | Promise<unknown>;
  mandatory?: boolean;
}>;

export type LifecycleStepResult = Readonly<{
  name: string;
  durationMs: number;
  mandatory: boolean;
  timedOut: boolean;
  error: unknown | null;
}>;

export type LifecycleShutdownReport = Readonly<{
  durable: boolean;
  durationMs: number;
  steps: readonly LifecycleStepResult[];
}>;

export class LifecycleSupervisor {
  private readonly services: Array<LifecycleService & { started: boolean }> = [];
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<LifecycleShutdownReport> | null = null;

  constructor(
    private readonly shutdownDeadlineMs: number,
    private readonly observe?: (step: LifecycleStepResult) => void
  ) {
    if (!Number.isFinite(shutdownDeadlineMs) || shutdownDeadlineMs < 0) {
      throw new Error("lifecycle shutdown deadline must be non-negative");
    }
  }

  register(service: LifecycleService): void {
    if (this.startPromise || this.shutdownPromise) {
      throw new Error("cannot register a lifecycle service after startup");
    }
    if (this.services.some((candidate) => candidate.name === service.name)) {
      throw new Error(`duplicate lifecycle service ${service.name}`);
    }
    this.services.push({ ...service, started: false });
  }

  adopt(service: Omit<LifecycleService, "start">): void {
    if (this.shutdownPromise) throw new Error("cannot adopt a service during shutdown");
    if (this.services.some((candidate) => candidate.name === service.name)) {
      throw new Error(`duplicate lifecycle service ${service.name}`);
    }
    this.services.push({ ...service, started: true });
  }

  start(): Promise<void> {
    this.startPromise ??= this.startServices();
    return this.startPromise;
  }

  shutdown(): Promise<LifecycleShutdownReport> {
    this.shutdownPromise ??= this.stopStartedServices();
    return this.shutdownPromise;
  }

  private async startServices(): Promise<void> {
    try {
      for (const service of this.services) {
        await service.start?.();
        service.started = true;
      }
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  private async stopStartedServices(): Promise<LifecycleShutdownReport> {
    const startedAt = Date.now();
    const deadline = startedAt + this.shutdownDeadlineMs;
    const steps: LifecycleStepResult[] = [];
    for (const service of [...this.services].reverse()) {
      if (!service.started) continue;
      service.started = false;
      const stepStartedAt = Date.now();
      let work: Promise<unknown>;
      try {
        work = Promise.resolve(service.stop());
      } catch (error) {
        work = Promise.reject(error);
      }
      const outcome = await awaitMandatoryShutdownStep(
        work,
        Math.max(0, deadline - Date.now())
      );
      const result = {
        name: service.name,
        durationMs: Date.now() - stepStartedAt,
        mandatory: service.mandatory !== false,
        timedOut: outcome.timedOut,
        error: outcome.error
      } satisfies LifecycleStepResult;
      steps.push(result);
      this.observe?.(result);
    }
    return {
      durable: steps.every((step) =>
        !step.mandatory || (!step.timedOut && step.error === null)
      ),
      durationMs: Date.now() - startedAt,
      steps
    };
  }
}

export type PeriodicOverlapPolicy = "skip-while-running" | "coalesce-one";

export class PeriodicTask {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private pending = false;
  private stopped = false;

  constructor(private readonly options: Readonly<{
    name: string;
    intervalMs: number;
    overlap: PeriodicOverlapPolicy;
    run(): unknown | Promise<unknown>;
    onError?(error: unknown): void;
  }>) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error(`${options.name} interval must be positive`);
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.trigger(), this.options.intervalMs);
    this.timer.unref?.();
  }

  trigger(): void {
    if (this.stopped) return;
    if (this.running) {
      if (this.options.overlap === "coalesce-one") this.pending = true;
      return;
    }
    this.running = Promise.resolve()
      .then(() => this.options.run())
      .catch((error: unknown) => this.options.onError?.(error))
      .then(() => undefined)
      .finally(() => {
        this.running = null;
        if (this.pending && !this.stopped) {
          this.pending = false;
          this.trigger();
        }
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  isRunning(): boolean {
    return this.running !== null;
  }
}
