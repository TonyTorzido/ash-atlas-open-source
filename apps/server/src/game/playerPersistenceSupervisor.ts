import type { PlayerSnapshot } from "@ash-atlas/shared";

import type { AppLogger } from "../logger.js";
import type { GameState, PlayerPersistenceCapture } from "./state.js";

export type PlayerPersistenceStatementMetrics = {
  statements: number;
  poolWaitMs: number;
};

export type PlayerPersistencePassMetrics = {
  dirtyCount: number;
  oldestDirtyAgeMs: number;
  statements: number;
  poolWaitMs: number;
  durationMs: number;
  successes: number;
  retries: number;
  failures: number;
};

export class PlayerPersistenceSupervisor {
  private activePass: Promise<PlayerPersistencePassMetrics> | null = null;
  private accepting = true;

  constructor(
    private readonly gameState: GameState,
    private readonly persist: (
      snapshot: PlayerSnapshot
    ) => Promise<PlayerPersistenceStatementMetrics>,
    private readonly concurrency: number,
    private readonly logger?: Pick<AppLogger, "info" | "warn">
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error("player persistence concurrency must be an integer between 1 and 32");
    }
  }

  runPass(options: { shutdown?: boolean } = {}): Promise<PlayerPersistencePassMetrics> {
    if (this.activePass) return this.activePass;
    if (!this.accepting && !options.shutdown) {
      return Promise.resolve(emptyMetrics(this.gameState.dirtyPlayerMetrics()));
    }
    this.activePass = this.executePass().finally(() => {
      this.activePass = null;
    });
    return this.activePass;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  async waitForIdle(): Promise<void> {
    await this.activePass;
  }

  private async executePass(): Promise<PlayerPersistencePassMetrics> {
    const startedAt = performance.now();
    const dirty = this.gameState.dirtyPlayerMetrics();
    const playerIds = this.gameState.consumeDirtyPlayerIds();
    const captures: PlayerPersistenceCapture[] = [];
    for (const playerId of playerIds) {
      try {
        captures.push(this.gameState.capturePlayerPersistence(playerId));
      } catch {
        // A completed disconnect persistence may have evicted this identity after it was consumed.
      }
    }
    let cursor = 0;
    let statements = 0;
    let poolWaitMs = 0;
    let successes = 0;
    let failures = 0;
    const workers = Array.from(
      { length: Math.min(this.concurrency, captures.length) },
      async () => {
        while (true) {
          const capture = captures[cursor];
          cursor += 1;
          if (!capture) return;
          try {
            const measured = await this.persist(capture.snapshot);
            statements += measured.statements;
            poolWaitMs += measured.poolWaitMs;
            successes += 1;
            this.gameState.acknowledgePlayerPersistence(capture);
          } catch (error) {
            statements += 1;
            failures += 1;
            this.gameState.restoreDirtyPlayerIds([capture.playerId]);
            this.logger?.warn(
              { err: error, playerId: capture.playerId },
              "failed to persist player snapshot"
            );
          }
        }
      }
    );
    await Promise.all(workers);
    const metrics: PlayerPersistencePassMetrics = {
      dirtyCount: dirty.count,
      oldestDirtyAgeMs: dirty.oldestAgeMs,
      statements,
      poolWaitMs,
      durationMs: performance.now() - startedAt,
      successes,
      retries: failures,
      failures
    };
    if (dirty.count > 0 || failures > 0) {
      this.logger?.info(metrics, "player persistence pass completed");
    }
    return metrics;
  }
}

function emptyMetrics(dirty: { count: number; oldestAgeMs: number }): PlayerPersistencePassMetrics {
  return {
    dirtyCount: dirty.count,
    oldestDirtyAgeMs: dirty.oldestAgeMs,
    statements: 0,
    poolWaitMs: 0,
    durationMs: 0,
    successes: 0,
    retries: 0,
    failures: 0
  };
}
