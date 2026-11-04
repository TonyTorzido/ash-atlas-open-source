import { describe, expect, it, vi } from "vitest";

import { PendingDeathPenaltyCoordinator } from "./pendingDeathPenaltyCoordinator.js";

describe("PendingDeathPenaltyCoordinator", () => {
  it("deduplicates the initial attempt and respawn settlement until it resolves", async () => {
    let resolveAttempt = (): void => undefined;
    const gate = new Promise<void>((resolve) => { resolveAttempt = resolve; });
    const attempt = vi.fn(() => gate);
    const input = { operationKey: "death:one", playerId: "player-1", metadata: { deathId: "one" } };
    const coordinator = new PendingDeathPenaltyCoordinator();
    void coordinator.begin("player-1", input, attempt);
    const respawn = vi.fn(() => true);
    let settled = false;
    const settlement = coordinator.settleAndComplete("player-1", respawn).then((value) => { settled = value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(respawn).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
    resolveAttempt();
    await settlement;
    expect(settled).toBe(true);
    expect(respawn).toHaveBeenCalledTimes(1);
  });

  it("keeps the same operation after failure and retries before completion", async () => {
    const inputs: unknown[] = [];
    const attempt = vi.fn(async (input: unknown) => {
      inputs.push(input);
      if (inputs.length === 1) throw new Error("database unavailable");
    });
    const input = { operationKey: "death:retry", playerId: "player-1" };
    const coordinator = new PendingDeathPenaltyCoordinator();
    await expect(coordinator.begin("player-1", input, attempt)).rejects.toThrow("database unavailable");
    const respawn = vi.fn(() => true);
    await expect(coordinator.settleAndComplete("player-1", respawn)).resolves.toBe(true);
    expect(inputs).toEqual([input, input]);
    expect(respawn).toHaveBeenCalledTimes(1);
    await expect(coordinator.settle("player-1")).resolves.toBe(false);
  });

  it("reconstructs a persisted death operation and keeps it until async completion succeeds", async () => {
    const attempt = vi.fn(async () => undefined);
    const input = { operationKey: "player-death:persisted", playerId: "player-1" };
    const coordinator = new PendingDeathPenaltyCoordinator();
    coordinator.ensure("player-1", input, attempt);
    const complete = vi.fn(async () => true);

    await expect(coordinator.settleAndComplete("player-1", complete)).resolves.toBe(true);
    expect(attempt).toHaveBeenCalledWith(input);
    expect(complete).toHaveBeenCalledWith(input);
    await expect(coordinator.settle("player-1")).resolves.toBe(false);
  });

  it("shares one completion attempt across concurrent settlements", async () => {
    let resolveCompletion = (_value: boolean): void => { void _value; };
    const completionGate = new Promise<boolean>((resolve) => { resolveCompletion = resolve; });
    const coordinator = new PendingDeathPenaltyCoordinator();
    coordinator.ensure(
      "player-1",
      { operationKey: "death:concurrent-completion", playerId: "player-1" },
      vi.fn(async () => undefined)
    );
    const firstComplete = vi.fn(() => completionGate);
    const overlappingComplete = vi.fn(async () => true);

    const first = coordinator.settleAndComplete("player-1", firstComplete);
    const overlapping = coordinator.settleAndComplete("player-1", overlappingComplete);
    await vi.waitFor(() => expect(firstComplete).toHaveBeenCalledOnce());
    expect(overlappingComplete).not.toHaveBeenCalled();
    resolveCompletion(true);

    await expect(Promise.all([first, overlapping])).resolves.toEqual([true, true]);
    expect(firstComplete).toHaveBeenCalledOnce();
    expect(overlappingComplete).not.toHaveBeenCalled();
    await expect(coordinator.settle("player-1")).resolves.toBe(false);
  });

  it("keeps completion retryable after false and thrown results", async () => {
    const coordinator = new PendingDeathPenaltyCoordinator();
    coordinator.ensure(
      "player-1",
      { operationKey: "death:completion-retry", playerId: "player-1" },
      vi.fn(async () => undefined)
    );

    await expect(coordinator.settleAndComplete("player-1", async () => false))
      .resolves.toBe(false);
    await expect(coordinator.settleAndComplete("player-1", async () => {
      throw new Error("projection unavailable");
    })).rejects.toThrow("projection unavailable");
    await expect(coordinator.settleAndComplete("player-1", async () => true))
      .resolves.toBe(true);
    await expect(coordinator.settle("player-1")).resolves.toBe(false);
  });
});
