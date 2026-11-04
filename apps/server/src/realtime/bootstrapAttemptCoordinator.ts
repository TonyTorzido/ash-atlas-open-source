import type { AppLogger } from "../logger.js";
import type { SocketLike } from "./connectionRegistry.js";

const OPEN = 1;

export type BootstrapCancellationReason =
  | "newer-attempt"
  | "socket-close"
  | "socket-error"
  | "timeout"
  | "bootstrap-failure"
  | "shutdown";

export type BootstrapAttempt = {
  readonly accountId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly acceptedAtMs: number;
  readonly authenticatedHelloAtMs: number;
  readonly bootstrapStartedAtMs: number;
  readonly socket: SocketLike;
  readonly isSocketClosed: () => boolean;
  cancelled: boolean;
  cancellationReason: BootstrapCancellationReason | null;
  cancelledAtMs: number | null;
  timedOut: boolean;
  bootstrapFinishedAtMs: number | null;
  registryHandoffOutcome: "pending" | "registered" | "rejected";
  replacedConnectionId: string | null;
  replacedSocketState: number | null;
  welcomed: boolean;
  serverSentCloseCode: number | null;
  serverSentCloseReason: string | null;
  clientObservedCloseCode: number | null;
  lastCommitStage: string | null;
  lastCommitAtMs: number | null;
  lastCommitWasCurrent: boolean | null;
  lastCommitSocketReadyState: number | null;
  staleRejectionRecorded: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
};

export type BootstrapAuthorityMetrics = Readonly<{
  attemptsStarted: number;
  attemptsCancelled: number;
  attemptsTimedOut: number;
  staleAttemptRejections: number;
  registryHandoffs: number;
  welcomesSent: number;
  unexpectedCrossAccountReplacements: number;
}>;

export class BootstrapAttemptInactiveError extends Error {
  constructor(readonly attempt: BootstrapAttempt, readonly stage: string) {
    super(`websocket bootstrap attempt is no longer authoritative at ${stage}`);
    this.name = "BootstrapAttemptInactiveError";
  }
}

export class BootstrapAttemptCoordinator {
  private readonly currentByAccount = new Map<string, BootstrapAttempt>();
  private readonly latestGenerationByAccount = new Map<string, number>();
  private readonly now: () => number;
  private readonly createAttemptId: () => string;
  private readonly metrics = {
    attemptsStarted: 0,
    attemptsCancelled: 0,
    attemptsTimedOut: 0,
    staleAttemptRejections: 0,
    registryHandoffs: 0,
    welcomesSent: 0,
    unexpectedCrossAccountReplacements: 0
  };

  constructor(private readonly options: Readonly<{
    timeoutMs: number;
    logger: Pick<AppLogger, "info" | "warn">;
    now?: () => number;
    createAttemptId?: () => string;
    onMetricsChanged?: (metrics: BootstrapAuthorityMetrics) => void;
  }>) {
    this.now = options.now ?? Date.now;
    this.createAttemptId = options.createAttemptId ?? (() => crypto.randomUUID());
  }

  begin(input: Readonly<{
    accountId: string;
    acceptedAtMs: number;
    authenticatedHelloAtMs: number;
    socket: SocketLike;
    isSocketClosed: () => boolean;
  }>): BootstrapAttempt {
    const previous = this.currentByAccount.get(input.accountId);
    if (previous) this.cancel(previous, "newer-attempt", false);

    const generation = (this.latestGenerationByAccount.get(input.accountId) ?? 0) + 1;
    this.latestGenerationByAccount.set(input.accountId, generation);
    const attempt: BootstrapAttempt = {
      ...input,
      attemptId: this.createAttemptId(),
      generation,
      bootstrapStartedAtMs: this.now(),
      cancelled: false,
      cancellationReason: null,
      cancelledAtMs: null,
      timedOut: false,
      bootstrapFinishedAtMs: null,
      registryHandoffOutcome: "pending",
      replacedConnectionId: null,
      replacedSocketState: null,
      welcomed: false,
      serverSentCloseCode: null,
      serverSentCloseReason: null,
      clientObservedCloseCode: null,
      lastCommitStage: null,
      lastCommitAtMs: null,
      lastCommitWasCurrent: null,
      lastCommitSocketReadyState: null,
      staleRejectionRecorded: false,
      timeout: null
    };
    this.currentByAccount.set(input.accountId, attempt);
    this.metrics.attemptsStarted += 1;
    this.publishMetrics();
    attempt.timeout = setTimeout(() => {
      if (!this.isCurrentOpen(attempt)) return;
      attempt.timedOut = true;
      this.metrics.attemptsTimedOut += 1;
      this.publishMetrics();
      this.cancel(attempt, "timeout");
      this.closeAttemptSocket(attempt, 1011, "session bootstrap timeout");
    }, this.options.timeoutMs);
    attempt.timeout.unref?.();
    this.options.logger.info(this.diagnostics(attempt), "websocket bootstrap attempt started");
    return attempt;
  }

  isCurrentOpen(attempt: BootstrapAttempt): boolean {
    return this.currentByAccount.get(attempt.accountId) === attempt &&
      !attempt.cancelled &&
      !attempt.isSocketClosed() &&
      attempt.socket.readyState === OPEN;
  }

  assertCurrentOpen(attempt: BootstrapAttempt, stage: string): void {
    attempt.lastCommitStage = stage;
    attempt.lastCommitAtMs = this.now();
    attempt.lastCommitWasCurrent = this.currentByAccount.get(attempt.accountId) === attempt;
    attempt.lastCommitSocketReadyState = attempt.socket.readyState;
    if (this.isCurrentOpen(attempt)) return;
    attempt.registryHandoffOutcome = attempt.registryHandoffOutcome === "pending"
      ? "rejected"
      : attempt.registryHandoffOutcome;
    if (!attempt.staleRejectionRecorded) {
      attempt.staleRejectionRecorded = true;
      this.metrics.staleAttemptRejections += 1;
      this.publishMetrics();
      if (shouldLogIncidentCount(this.metrics.staleAttemptRejections)) {
        this.options.logger.warn(
          { ...this.diagnostics(attempt), bootstrapCommitStage: stage },
          "stale websocket bootstrap attempt rejected"
        );
      }
    }
    if (attempt.socket.readyState === OPEN) {
      if (attempt.cancellationReason === "newer-attempt") {
        this.closeAttemptSocket(attempt, 4002, "newer gameplay connection opened");
      } else if (attempt.cancellationReason === "shutdown") {
        this.closeAttemptSocket(attempt, 1012, "service restart");
      } else {
        this.closeAttemptSocket(attempt, 1011, "session bootstrap cancelled");
      }
    }
    throw new BootstrapAttemptInactiveError(attempt, stage);
  }

  cancel(
    attempt: BootstrapAttempt,
    reason: BootstrapCancellationReason,
    removeIfCurrent = true
  ): void {
    if (!attempt.cancelled) {
      attempt.cancelled = true;
      attempt.cancellationReason = reason;
      attempt.cancelledAtMs = this.now();
      this.metrics.attemptsCancelled += 1;
      this.publishMetrics();
      if (attempt.timeout) clearTimeout(attempt.timeout);
      attempt.timeout = null;
      this.options.logger.info(this.diagnostics(attempt), "websocket bootstrap attempt cancelled");
    }
    if (removeIfCurrent) this.removeIfCurrent(attempt);
  }

  observeSocketClose(attempt: BootstrapAttempt, code: number): void {
    attempt.clientObservedCloseCode = code;
    this.cancel(attempt, "socket-close");
  }

  close(attempt: BootstrapAttempt, code: number, reason: string): void {
    if (attempt.socket.readyState === OPEN) this.closeAttemptSocket(attempt, code, reason);
  }

  markRegistryHandoff(
    attempt: BootstrapAttempt,
    input: Readonly<{
      replacedConnectionId: string | null;
      replacedAccountId: string | null;
      replacedSocketState: number | null;
    }>
  ): void {
    attempt.registryHandoffOutcome = "registered";
    attempt.replacedConnectionId = input.replacedConnectionId;
    attempt.replacedSocketState = input.replacedSocketState;
    this.metrics.registryHandoffs += 1;
    if (input.replacedAccountId && input.replacedAccountId !== attempt.accountId) {
      this.metrics.unexpectedCrossAccountReplacements += 1;
      if (shouldLogIncidentCount(this.metrics.unexpectedCrossAccountReplacements)) {
        this.options.logger.warn(
          this.diagnostics(attempt),
          "websocket bootstrap attempted cross-account replacement"
        );
      }
    }
    this.publishMetrics();
  }

  markWelcomed(attempt: BootstrapAttempt): void {
    attempt.welcomed = true;
    this.metrics.welcomesSent += 1;
    this.publishMetrics();
  }

  complete(attempt: BootstrapAttempt): void {
    if (attempt.bootstrapFinishedAtMs !== null) return;
    attempt.bootstrapFinishedAtMs = this.now();
    if (attempt.timeout) clearTimeout(attempt.timeout);
    attempt.timeout = null;
    this.removeIfCurrent(attempt);
    this.options.logger.info(this.diagnostics(attempt), "websocket bootstrap attempt finished");
  }

  currentAttempt(accountId: string): BootstrapAttempt | null {
    return this.currentByAccount.get(accountId) ?? null;
  }

  metricsSnapshot(): BootstrapAuthorityMetrics {
    return { ...this.metrics };
  }

  shutdown(): void {
    for (const attempt of [...this.currentByAccount.values()]) {
      this.cancel(attempt, "shutdown");
    }
  }

  private removeIfCurrent(attempt: BootstrapAttempt): boolean {
    if (this.currentByAccount.get(attempt.accountId) !== attempt) return false;
    this.currentByAccount.delete(attempt.accountId);
    return true;
  }

  private closeAttemptSocket(attempt: BootstrapAttempt, code: number, reason: string): void {
    attempt.serverSentCloseCode = code;
    attempt.serverSentCloseReason = reason;
    attempt.socket.close(code, reason);
  }

  private diagnostics(attempt: BootstrapAttempt): Record<string, unknown> {
    return {
      accountId: attempt.accountId,
      bootstrapAttemptId: attempt.attemptId,
      bootstrapAttemptGeneration: attempt.generation,
      acceptedAtMs: attempt.acceptedAtMs,
      authenticatedHelloAtMs: attempt.authenticatedHelloAtMs,
      bootstrapStartedAtMs: attempt.bootstrapStartedAtMs,
      bootstrapFinishedAtMs: attempt.bootstrapFinishedAtMs,
      cancelledAtMs: attempt.cancelledAtMs,
      cancellationReason: attempt.cancellationReason,
      bootstrapTimedOut: attempt.timedOut,
      socketReadyState: attempt.socket.readyState,
      socketClosed: attempt.isSocketClosed(),
      currentAttempt: this.currentByAccount.get(attempt.accountId) === attempt,
      registryHandoffOutcome: attempt.registryHandoffOutcome,
      replacedConnectionId: attempt.replacedConnectionId,
      replacedSocketState: attempt.replacedSocketState,
      welcomeSent: attempt.welcomed,
      serverSentCloseCode: attempt.serverSentCloseCode,
      serverSentCloseReason: attempt.serverSentCloseReason,
      clientObservedCloseCode: attempt.clientObservedCloseCode,
      lastCommitStage: attempt.lastCommitStage,
      lastCommitAtMs: attempt.lastCommitAtMs,
      lastCommitWasCurrent: attempt.lastCommitWasCurrent,
      lastCommitSocketReadyState: attempt.lastCommitSocketReadyState,
      bootstrapAuthorityMetrics: this.metricsSnapshot()
    };
  }

  private publishMetrics(): void {
    this.options.onMetricsChanged?.(this.metricsSnapshot());
  }
}

function shouldLogIncidentCount(count: number): boolean {
  return count === 1 || count % 100 === 0;
}
