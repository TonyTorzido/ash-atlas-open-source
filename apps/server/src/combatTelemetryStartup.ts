import type { CombatTelemetryService } from "./game/combat/combatTelemetry.js";
import type { AppLogger } from "./logger.js";

export const COMBAT_TELEMETRY_FLUSH_INTERVAL_MS = 5_000;
export const COMBAT_TELEMETRY_FLUSH_BATCH_SIZE = 100;

type CombatTelemetryFlusher = Pick<CombatTelemetryService, "flush">;
type TelemetryLogger = Pick<AppLogger, "warn">;

export type CombatTelemetryFlushLoop = {
  flushBatch(): Promise<number>;
  flushRemaining(): Promise<number>;
  stop(): void;
};

export function startCombatTelemetryFlushLoop(
  telemetry: CombatTelemetryFlusher,
  logger: TelemetryLogger,
  options: {
    intervalMs?: number;
    batchSize?: number;
  } = {}
): CombatTelemetryFlushLoop {
  const intervalMs = options.intervalMs ?? COMBAT_TELEMETRY_FLUSH_INTERVAL_MS;
  const batchSize = options.batchSize ?? COMBAT_TELEMETRY_FLUSH_BATCH_SIZE;
  assertPositiveInteger(intervalMs, "combat telemetry flush interval");
  assertPositiveInteger(batchSize, "combat telemetry flush batch size");

  const flushSafely = async (maximum?: number): Promise<number> => {
    try {
      return maximum === undefined
        ? await telemetry.flush()
        : await telemetry.flush(maximum);
    } catch (error) {
      logger.warn({ err: error }, "failed to flush combat telemetry");
      return 0;
    }
  };

  const timer = setInterval(() => {
    void flushSafely(batchSize);
  }, intervalMs);
  timer.unref();

  let stopped = false;
  return {
    flushBatch: () => flushSafely(batchSize),
    flushRemaining: () => flushSafely(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    }
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}
