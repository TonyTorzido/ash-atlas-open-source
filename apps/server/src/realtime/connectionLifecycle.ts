export type BootstrapLogger = Readonly<{
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}>;

export class ConnectionGenerationLedger {
  private readonly latestByPlayer = new Map<string, number>();
  private nextGeneration = 0;

  allocate(playerId: string): number {
    const generation = ++this.nextGeneration;
    this.latestByPlayer.set(playerId, generation);
    return generation;
  }

  current(playerId: string): number | undefined {
    return this.latestByPlayer.get(playerId);
  }

  isCurrent(playerId: string, generation: number): boolean {
    return this.latestByPlayer.get(playerId) === generation;
  }

  deleteIfCurrent(playerId: string, generation: number): boolean {
    if (!this.isCurrent(playerId, generation)) return false;
    this.latestByPlayer.delete(playerId);
    return true;
  }
}

export class ConnectionCloseRegistry {
  private readonly handlers = new Map<string, () => Promise<void>>();

  register(connectionId: string, handler: () => Promise<void>): void {
    this.handlers.set(connectionId, handler);
  }

  remove(connectionId: string): void {
    this.handlers.delete(connectionId);
  }

  handlersFor(connectionIds: Iterable<string>): readonly (() => Promise<void>)[] {
    const handlers: (() => Promise<void>)[] = [];
    for (const connectionId of connectionIds) {
      const handler = this.handlers.get(connectionId);
      if (handler) handlers.push(handler);
    }
    return handlers;
  }
}

export async function runIndependentBootstrapTask(input: Readonly<{
  subsystem: string;
  connectionId: string;
  playerId: string;
  releaseSha: string | null;
  logger: BootstrapLogger;
  operation: () => void | Promise<void>;
}>): Promise<void> {
  const startedAt = performance.now();
  let outcome: "success" | "failed" = "success";
  try {
    await input.operation();
  } catch (error) {
    outcome = "failed";
    input.logger.warn(
      {
        err: error,
        playerId: input.playerId,
        connectionId: input.connectionId,
        releaseSha: input.releaseSha,
        bootstrapSubsystem: input.subsystem
      },
      "websocket bootstrap subsystem failed"
    );
  } finally {
    input.logger.info(
      {
        connectionId: input.connectionId,
        releaseSha: input.releaseSha,
        bootstrapSubsystem: input.subsystem,
        bootstrapOutcome: outcome,
        durationMs: Math.max(0, performance.now() - startedAt),
        completedAt: new Date().toISOString()
      },
      "websocket post-welcome bootstrap subsystem finished"
    );
  }
}
