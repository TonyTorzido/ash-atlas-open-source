import type { AppLogger } from "../logger.js";
import type {
  MarketReconciliationOptions,
  MarketReconciliationRunResult
} from "./marketReconciliation.js";

type ReconciliationRunner = {
  reconcileRun(options?: MarketReconciliationOptions): Promise<MarketReconciliationRunResult>;
};

export type MarketReconciliationSupervisorOptions = {
  intervalMs: number;
  staleAfterMs: number;
  reconciliationOptions?: MarketReconciliationOptions;
  requireStartupProtection?: boolean;
};

export type MarketReconciliationOperationalState = {
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastSuccessfulCompletionAt: string | null;
  lastDurationMs: number | null;
  issueCount: number | null;
  lastError: string | null;
  protectionApplied: boolean;
  affectedBookIds: string[];
  globalReadOnly: boolean | null;
  runInProgress: boolean;
  ageOfLastSuccessfulReconciliationMs: number | null;
  stale: boolean;
  runCount: number;
  failureCount: number;
  automaticProtectionCount: number;
};

export type MarketReconciliationReadiness = {
  ok: boolean;
  reason: "healthy" | "never_succeeded" | "stale" | "issues_detected" | "run_failed" | "read_only";
  state: MarketReconciliationOperationalState;
};

/** Owns startup gating, periodic full runs, coalescing, and readiness state. */
export class MarketReconciliationSupervisor {
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly reconciliationOptions: MarketReconciliationOptions;
  private readonly requireStartupProtection: boolean;
  private interval: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<MarketReconciliationRunResult> | null = null;
  private rerunRequested = false;
  private started = false;
  private stopping = false;
  private state: Omit<
    MarketReconciliationOperationalState,
    "ageOfLastSuccessfulReconciliationMs" | "stale"
  > = {
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastSuccessfulCompletionAt: null,
    lastDurationMs: null,
    issueCount: null,
    lastError: null,
    protectionApplied: false,
    affectedBookIds: [],
    globalReadOnly: null,
    runInProgress: false,
    runCount: 0,
    failureCount: 0,
    automaticProtectionCount: 0
  };

  constructor(
    private readonly runner: ReconciliationRunner,
    private readonly logger: AppLogger,
    options: MarketReconciliationSupervisorOptions,
    private readonly now: () => Date = () => new Date()
  ) {
    this.intervalMs = positiveSafeInteger(options.intervalMs, "interval");
    this.staleAfterMs = positiveSafeInteger(options.staleAfterMs, "stale threshold");
    this.reconciliationOptions = options.reconciliationOptions ?? {};
    this.requireStartupProtection = options.requireStartupProtection !== false;
  }

  async start(): Promise<MarketReconciliationOperationalState> {
    if (this.started) throw new Error("Market reconciliation supervisor is already started");
    this.started = true;
    this.stopping = false;
    try {
      const result = await this.run("startup");
      if (
        this.requireStartupProtection &&
        !result.report.ok &&
        !result.protection.protectionApplied
      ) {
        throw new Error("Startup reconciliation found issues but did not commit market protection");
      }
      this.interval = setInterval(() => {
        this.requestImmediate("scheduled");
      }, this.intervalMs);
      return this.snapshot();
    } catch (error) {
      this.started = false;
      this.stopping = true;
      throw error;
    }
  }

  requestImmediate(reason = "market_invariant_failure"): void {
    if (!this.started || this.stopping) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    void this.run(reason).catch(() => undefined);
  }

  async runNow(reason = "manual"): Promise<MarketReconciliationRunResult> {
    return this.run(reason);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.rerunRequested = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const pending = this.inFlight;
    if (pending) await pending.catch(() => undefined);
    this.started = false;
  }

  snapshot(): MarketReconciliationOperationalState {
    const lastSuccessful = this.state.lastSuccessfulCompletionAt;
    const age = lastSuccessful === null
      ? null
      : Math.max(0, this.now().getTime() - new Date(lastSuccessful).getTime());
    return {
      ...this.state,
      affectedBookIds: [...this.state.affectedBookIds],
      ageOfLastSuccessfulReconciliationMs: age,
      stale: age === null || age > this.staleAfterMs
    };
  }

  readiness(): MarketReconciliationReadiness {
    const state = this.snapshot();
    let reason: MarketReconciliationReadiness["reason"] = "healthy";
    if (state.lastSuccessfulCompletionAt === null) reason = "never_succeeded";
    else if (state.lastError !== null) reason = "run_failed";
    else if ((state.issueCount ?? 0) > 0) reason = "issues_detected";
    else if (state.stale) reason = "stale";
    else if (state.globalReadOnly === true) reason = "read_only";
    return { ok: reason === "healthy", reason, state };
  }

  private async run(reason: string): Promise<MarketReconciliationRunResult> {
    if (this.inFlight) return this.inFlight;
    const execution = this.performRun(reason);
    this.inFlight = execution;
    try {
      return await execution;
    } finally {
      this.inFlight = null;
      if (this.rerunRequested && this.started && !this.stopping) {
        this.rerunRequested = false;
        queueMicrotask(() => this.requestImmediate("coalesced_priority"));
      }
    }
  }

  private async performRun(reason: string): Promise<MarketReconciliationRunResult> {
    const startedAt = this.now();
    this.state = {
      ...this.state,
      lastRunStartedAt: startedAt.toISOString(),
      runInProgress: true,
      runCount: this.state.runCount + 1
    };
    this.logger.info({ reason, startedAt: startedAt.toISOString() }, "market reconciliation started");
    try {
      const result = await this.runner.reconcileRun(this.reconciliationOptions);
      const completedAt = this.now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      this.state = {
        ...this.state,
        lastRunCompletedAt: completedAt.toISOString(),
        lastSuccessfulCompletionAt: result.report.ok
          ? completedAt.toISOString()
          : this.state.lastSuccessfulCompletionAt,
        lastDurationMs: durationMs,
        issueCount: result.report.issues.length,
        lastError: null,
        protectionApplied: result.protection.protectionApplied,
        affectedBookIds: [...result.protection.affectedBookIds].slice(0, 100),
        globalReadOnly: result.protection.globalReadOnly,
        runInProgress: false,
        automaticProtectionCount: this.state.automaticProtectionCount +
          (result.protection.protectionApplied ? 1 : 0)
      };
      const context = {
        reason,
        durationMs,
        issueCount: result.report.issues.length,
        protectionApplied: result.protection.protectionApplied,
        affectedBookCount: result.protection.affectedBookIds.length,
        globalReadOnly: result.protection.globalReadOnly
      };
      if (result.report.ok) {
        this.logger.info(context, "market reconciliation completed");
      } else {
        this.logger.error(context, "market reconciliation detected invariant issues");
      }
      return result;
    } catch (error) {
      const completedAt = this.now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      this.state = {
        ...this.state,
        lastRunCompletedAt: completedAt.toISOString(),
        lastDurationMs: durationMs,
        issueCount: null,
        lastError: safeErrorMessage(error),
        protectionApplied: false,
        affectedBookIds: [],
        runInProgress: false,
        failureCount: this.state.failureCount + 1
      };
      this.logger.error(
        { err: error, reason, durationMs },
        "market reconciliation run failed"
      );
      throw error;
    }
  }
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Market reconciliation supervisor ${name} must be a positive safe integer`);
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown reconciliation failure";
  return message.slice(0, 500);
}
