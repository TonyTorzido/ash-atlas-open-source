import { afterEach, describe, expect, it, vi } from "vitest";

import { ReconnectLeaseCoordinator } from "./reconnectLeaseCoordinator.js";

describe("ReconnectLeaseCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends presence at 30 seconds and finalizes exactly at 180 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const endWorldPresence = vi.fn();
    const finalize = vi.fn(async () => undefined);
    const coordinator = createCoordinator();
    coordinator.start(leaseInput(endWorldPresence, finalize));

    await vi.advanceTimersByTimeAsync(29_999);
    expect(endWorldPresence).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(endWorldPresence).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(149_999);
    expect(finalize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(finalize).toHaveBeenCalledOnce();
    expect(coordinator.activeLeaseCount()).toBe(0);
  });

  it.each([1, 29_000, 31_000, 179_999])(
    "claims the same authenticated account at %d ms",
    async (elapsedMs) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const endWorldPresence = vi.fn();
      const finalize = vi.fn(async () => undefined);
      const coordinator = createCoordinator();
      coordinator.start(leaseInput(endWorldPresence, finalize));
      await vi.advanceTimersByTimeAsync(elapsedMs);

      const claim = await coordinator.claim({
        accountId: "account-1",
        playerId: "player-1"
      });

      expect(claim).toMatchObject({
        previousAuthSessionId: "session-1",
        closingConnectionGeneration: 7,
        worldPresenceEnded: elapsedMs >= 30_000
      });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(finalize).not.toHaveBeenCalled();
    }
  );

  it("rejects another account and drains terminal work once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const finalize = vi.fn(async () => undefined);
    const coordinator = createCoordinator();
    coordinator.start(leaseInput(vi.fn(), finalize));

    await expect(coordinator.claim({
      accountId: "account-2",
      playerId: "player-1"
    })).resolves.toBeNull();
    await Promise.all([coordinator.drain(), coordinator.drain()]);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("does not consume a lease when bootstrap authority is stale", async () => {
    const coordinator = createCoordinator();
    coordinator.start(leaseInput(vi.fn(), vi.fn(async () => undefined)));

    await expect(coordinator.claim({
      accountId: "account-1",
      playerId: "player-1",
      isAuthorized: () => false
    })).resolves.toBeNull();
    expect(coordinator.activeLeaseCount()).toBe(1);
    await expect(coordinator.claim({
      accountId: "account-1",
      playerId: "player-1",
      isAuthorized: () => true
    })).resolves.toMatchObject({ closingConnectionGeneration: 7 });
  });

  it("finalizes before rejecting a claim made at the absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const finalize = vi.fn(async () => undefined);
    const coordinator = createCoordinator();
    coordinator.start(leaseInput(vi.fn(), finalize));
    vi.setSystemTime(180_000);

    await expect(coordinator.claim({
      accountId: "account-1",
      playerId: "player-1"
    })).resolves.toBeNull();
    expect(finalize).toHaveBeenCalledOnce();
    expect(coordinator.activeLeaseCount()).toBe(0);
  });
});

function createCoordinator(): ReconnectLeaseCoordinator {
  return new ReconnectLeaseCoordinator({
    graceMs: 180_000,
    worldPresenceMs: 30_000,
    logger: { info: vi.fn(), warn: vi.fn() }
  });
}

function leaseInput(
  endWorldPresence: () => void,
  finalize: () => Promise<void>
) {
  return {
    accountId: "account-1",
    playerId: "player-1",
    authSessionId: "session-1",
    connectionGeneration: 7,
    endWorldPresence,
    finalize
  };
}
