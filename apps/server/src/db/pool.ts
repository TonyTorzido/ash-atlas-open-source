import { performance } from "node:perf_hooks";

import pg from "pg";

const { Pool } = pg;

export type DbPoolConfiguration = Readonly<{
  databaseUrl: string;
  max?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  queryTimeoutMs?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  logger?: Readonly<{
    error(fields: Record<string, unknown>, message: string): void;
  }>;
}>;

export type DbPoolMetrics = Readonly<{
  configuration: Readonly<{
    max: number;
    connectionTimeoutMs: number;
    idleTimeoutMs: number;
    queryTimeoutMs: number;
    statementTimeoutMs: number;
    applicationName: string | null;
  }>;
  connections: Readonly<{
    total: number;
    idle: number;
    waiting: number;
  }>;
  acquisitions: Readonly<{
    completed: number;
    failed: number;
    timedOut: number;
    totalWaitMs: number;
    averageWaitMs: number;
    maxWaitMs: number;
    lastWaitMs: number | null;
  }>;
  unexpectedIdleErrors: Readonly<{
    count: number;
    lastAt: string | null;
    lastMessage: string | null;
  }>;
  shutdown: Readonly<{
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
  }>;
}>;

export class DbPool extends Pool {
  private readonly configuredMax: number;
  private readonly configuredConnectionTimeoutMs: number;
  private readonly configuredIdleTimeoutMs: number;
  private readonly configuredQueryTimeoutMs: number;
  private readonly configuredStatementTimeoutMs: number;
  private readonly configuredApplicationName: string | null;
  private acquisitionCompleted = 0;
  private acquisitionFailed = 0;
  private acquisitionTimedOut = 0;
  private acquisitionTotalWaitMs = 0;
  private acquisitionMaxWaitMs = 0;
  private acquisitionLastWaitMs: number | null = null;
  private idleErrorCount = 0;
  private idleErrorLastAt: string | null = null;
  private idleErrorLastMessage: string | null = null;
  private shutdownStartedAt: Date | null = null;
  private shutdownCompletedAt: Date | null = null;
  private shutdownDurationMs: number | null = null;

  constructor(configuration: DbPoolConfiguration) {
    const max = configuration.max ?? 10;
    const connectionTimeoutMs = configuration.connectionTimeoutMs ?? 0;
    const idleTimeoutMs = configuration.idleTimeoutMs ?? 10_000;
    const queryTimeoutMs = configuration.queryTimeoutMs ?? 0;
    const statementTimeoutMs = configuration.statementTimeoutMs ?? 0;
    super({
      connectionString: configuration.databaseUrl,
      max,
      connectionTimeoutMillis: connectionTimeoutMs,
      idleTimeoutMillis: idleTimeoutMs,
      query_timeout: queryTimeoutMs,
      statement_timeout: statementTimeoutMs,
      ...(configuration.applicationName
        ? { application_name: configuration.applicationName }
        : {})
    });
    this.configuredMax = max;
    this.configuredConnectionTimeoutMs = connectionTimeoutMs;
    this.configuredIdleTimeoutMs = idleTimeoutMs;
    this.configuredQueryTimeoutMs = queryTimeoutMs;
    this.configuredStatementTimeoutMs = statementTimeoutMs;
    this.configuredApplicationName = configuration.applicationName ?? null;
    this.on("error", (error: Error) => {
      this.idleErrorCount += 1;
      this.idleErrorLastAt = new Date().toISOString();
      this.idleErrorLastMessage = error.message;
      configuration.logger?.error(
        { err: error, databasePool: this.metricsSnapshot() },
        "unexpected error from an idle PostgreSQL client"
      );
    });
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(
    callback: (
      err: Error | undefined,
      client: pg.PoolClient | undefined,
      done: (release?: unknown) => void
    ) => void
  ): void;
  override connect(
    callback?: (
      err: Error | undefined,
      client: pg.PoolClient | undefined,
      done: (release?: unknown) => void
    ) => void
  ): Promise<pg.PoolClient> | void {
    const startedAt = performance.now();
    if (callback) {
      return super.connect((error, client, done) => {
        this.recordAcquisition(performance.now() - startedAt, error);
        callback(error, client, done);
      });
    }
    return super.connect().then(
      (client) => {
        this.recordAcquisition(performance.now() - startedAt);
        return client;
      },
      (error: unknown) => {
        this.recordAcquisition(performance.now() - startedAt, error);
        throw error;
      }
    );
  }

  override end(): Promise<void>;
  override end(callback: () => void): void;
  override end(callback?: () => void): Promise<void> | void {
    const startedAt = performance.now();
    this.shutdownStartedAt ??= new Date();
    const complete = (): void => {
      this.shutdownCompletedAt = new Date();
      this.shutdownDurationMs = performance.now() - startedAt;
      callback?.();
    };
    if (callback) return super.end(complete);
    return super.end().finally(complete);
  }

  metricsSnapshot(): DbPoolMetrics {
    const attempted = this.acquisitionCompleted + this.acquisitionFailed;
    return {
      configuration: {
        max: this.configuredMax,
        connectionTimeoutMs: this.configuredConnectionTimeoutMs,
        idleTimeoutMs: this.configuredIdleTimeoutMs,
        queryTimeoutMs: this.configuredQueryTimeoutMs,
        statementTimeoutMs: this.configuredStatementTimeoutMs,
        applicationName: this.configuredApplicationName
      },
      connections: {
        total: this.totalCount,
        idle: this.idleCount,
        waiting: this.waitingCount
      },
      acquisitions: {
        completed: this.acquisitionCompleted,
        failed: this.acquisitionFailed,
        timedOut: this.acquisitionTimedOut,
        totalWaitMs: this.acquisitionTotalWaitMs,
        averageWaitMs: attempted === 0 ? 0 : this.acquisitionTotalWaitMs / attempted,
        maxWaitMs: this.acquisitionMaxWaitMs,
        lastWaitMs: this.acquisitionLastWaitMs
      },
      unexpectedIdleErrors: {
        count: this.idleErrorCount,
        lastAt: this.idleErrorLastAt,
        lastMessage: this.idleErrorLastMessage
      },
      shutdown: {
        startedAt: this.shutdownStartedAt?.toISOString() ?? null,
        completedAt: this.shutdownCompletedAt?.toISOString() ?? null,
        durationMs: this.shutdownDurationMs
      }
    };
  }

  private recordAcquisition(waitMs: number, error?: unknown): void {
    this.acquisitionLastWaitMs = waitMs;
    this.acquisitionTotalWaitMs += waitMs;
    this.acquisitionMaxWaitMs = Math.max(this.acquisitionMaxWaitMs, waitMs);
    if (error) {
      this.acquisitionFailed += 1;
      if (
        this.configuredConnectionTimeoutMs > 0 &&
        (waitMs >= this.configuredConnectionTimeoutMs ||
          (error instanceof Error && /timeout/i.test(error.message)))
      ) {
        this.acquisitionTimedOut += 1;
      }
      return;
    }
    this.acquisitionCompleted += 1;
  }
}

export function createPool(configuration: DbPoolConfiguration): DbPool {
  return new DbPool(configuration);
}
