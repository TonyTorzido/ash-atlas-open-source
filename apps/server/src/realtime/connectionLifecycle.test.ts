import { describe, expect, it, vi } from "vitest";

import {
  ConnectionCloseRegistry,
  ConnectionGenerationLedger,
  runIndependentBootstrapTask
} from "./connectionLifecycle.js";

describe("realtime connection lifecycle", () => {
  it("never lets stale cleanup remove a newer connection generation", () => {
    const generations = new ConnectionGenerationLedger();
    const first = generations.allocate("player");
    const replacement = generations.allocate("player");

    expect(generations.deleteIfCurrent("player", first)).toBe(false);
    expect(generations.current("player")).toBe(replacement);
    expect(generations.deleteIfCurrent("player", replacement)).toBe(true);
    expect(generations.current("player")).toBeUndefined();
  });

  it("isolates an independent bootstrap failure", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    await expect(runIndependentBootstrapTask({
      subsystem: "optional",
      connectionId: "connection",
      playerId: "player",
      releaseSha: "a".repeat(40),
      logger,
      operation: async () => {
        throw new Error("failed");
      }
    })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrapSubsystem: "optional" }),
      "websocket bootstrap subsystem failed"
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrapSubsystem: "optional",
        bootstrapOutcome: "failed",
        durationMs: expect.any(Number),
        completedAt: expect.any(String)
      }),
      "websocket post-welcome bootstrap subsystem finished"
    );
  });

  it("records the duration of a successful post-welcome subsystem", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    await runIndependentBootstrapTask({
      subsystem: "flags",
      connectionId: "connection",
      playerId: "player",
      releaseSha: "a".repeat(40),
      logger,
      operation: async () => undefined
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection",
        releaseSha: "a".repeat(40),
        bootstrapSubsystem: "flags",
        bootstrapOutcome: "success",
        durationMs: expect.any(Number),
        completedAt: expect.any(String)
      }),
      "websocket post-welcome bootstrap subsystem finished"
    );
  });

  it("owns close-handler registration and cleanup", () => {
    const closes = new ConnectionCloseRegistry();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    closes.register("first", first);
    closes.register("second", second);
    expect(closes.handlersFor(["missing", "first", "second"])).toEqual([first, second]);
    closes.remove("first");
    expect(closes.handlersFor(["first", "second"])).toEqual([second]);
  });
});
