import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startCombatTelemetryFlushLoop
} from "./combatTelemetryStartup.js";

describe("combat telemetry startup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a bounded batch on schedule and stops cleanly", async () => {
    vi.useFakeTimers();
    const flush = vi.fn(async () => 3);
    const logger = { warn: vi.fn() };
    const loop = startCombatTelemetryFlushLoop(
      { flush },
      logger,
      { intervalMs: 25, batchSize: 7 }
    );

    await vi.advanceTimersByTimeAsync(25);
    expect(flush).toHaveBeenCalledWith(7);

    loop.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("drains the remaining queue without a batch limit for shutdown", async () => {
    vi.useFakeTimers();
    const flush = vi.fn(async () => 9);
    const loop = startCombatTelemetryFlushLoop(
      { flush },
      { warn: vi.fn() },
      { intervalMs: 100, batchSize: 4 }
    );

    await expect(loop.flushRemaining()).resolves.toBe(9);
    expect(flush).toHaveBeenCalledWith();
    loop.stop();
  });

  it("keeps telemetry persistence failures out of the server lifecycle", async () => {
    vi.useFakeTimers();
    const failure = new Error("database unavailable");
    const logger = { warn: vi.fn() };
    const loop = startCombatTelemetryFlushLoop(
      { flush: vi.fn(async () => Promise.reject(failure)) },
      logger,
      { intervalMs: 100, batchSize: 4 }
    );

    await expect(loop.flushBatch()).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: failure },
      "failed to flush combat telemetry"
    );
    loop.stop();
  });

  it("constructs, exposes, schedules, and drains telemetry from server startup", () => {
    const applicationSource = readFileSync(
      fileURLToPath(new URL("./application.ts", import.meta.url)),
      "utf8"
    );

    expect(applicationSource).toContain("new CombatTelemetryService(pool, undefined, logger)");
    expect(applicationSource).toContain(
      "registerCombatTelemetryRoutes(app, config, combatTelemetry, logger, authService)"
    );
    expect(applicationSource).toContain(
      "startCombatTelemetryFlushLoop(combatTelemetry, logger)"
    );
    expect(applicationSource).toContain("combatTelemetryFlush.stop()");
    expect(applicationSource).toContain("combatTelemetryFlush.flushRemaining()");
  });
});
