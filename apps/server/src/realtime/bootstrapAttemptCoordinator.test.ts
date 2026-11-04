import { describe, expect, it, vi } from "vitest";

import type { SocketLike } from "./connectionRegistry.js";
import {
  BootstrapAttemptCoordinator,
  BootstrapAttemptInactiveError,
  type BootstrapAttempt
} from "./bootstrapAttemptCoordinator.js";

type SideEffects = {
  reconnectLeaseClaims: number;
  connectionGenerations: number;
  onlineWrites: number;
  runtimeRestores: number;
  registryHandoffs: number;
  disconnectedEvents: number;
  welcomes: number;
};

describe("BootstrapAttemptCoordinator", () => {
  it.each([
    ["closed", true],
    ["open", false]
  ] as const)("rejects a stale %s attempt after a newer attempt wins", async (_label, closeStale) => {
    const fixture = createFixture();
    const firstGate = deferred<void>();
    const firstEffects = emptySideEffects();
    const secondEffects = emptySideEffects();
    const first = fixture.begin("account-1");
    const firstRun = commitAfter(firstGate.promise, fixture.coordinator, first, firstEffects);

    const second = fixture.begin("account-1");
    expect(fixture.coordinator.currentAttempt("account-1")).toBe(second);
    commit(fixture.coordinator, second, secondEffects);
    expect(fixture.coordinator.currentAttempt("account-1")).toBe(second);
    if (closeStale) {
      first.socket.readyState = 3;
      fixture.coordinator.observeSocketClose(first, 1006);
    }

    firstGate.resolve();
    await firstRun;

    expect(firstEffects).toEqual(emptySideEffects());
    expect(secondEffects).toEqual(committedSideEffects());
    expect(second.socket.readyState).toBe(1);
    expect(fixture.coordinator.currentAttempt("account-1")).toBe(second);
    fixture.coordinator.markWelcomed(second);
    fixture.coordinator.complete(second);
    expect(fixture.coordinator.currentAttempt("account-1")).toBeNull();
  });

  it("cancels a timed-out attempt and fences its late continuation", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture(25);
      const gate = deferred<void>();
      const effects = emptySideEffects();
      const attempt = fixture.begin("account-1");
      const run = commitAfter(gate.promise, fixture.coordinator, attempt, effects);

      await vi.advanceTimersByTimeAsync(25);
      expect(attempt.cancelled).toBe(true);
      expect(attempt.timedOut).toBe(true);
      expect(attempt.socket.close).toHaveBeenCalledWith(1011, "session bootstrap timeout");
      expect(fixture.coordinator.currentAttempt("account-1")).toBeNull();

      const winnerEffects = emptySideEffects();
      const winner = fixture.begin("account-1");
      commit(fixture.coordinator, winner, winnerEffects);

      gate.resolve();
      await run;
      expect(effects).toEqual(emptySideEffects());
      expect(winnerEffects).toEqual(committedSideEffects());
      expect(winner.socket.readyState).toBe(1);
      expect(fixture.coordinator.metricsSnapshot().attemptsTimedOut).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a completed attempt followed by a genuinely newer attempt", () => {
    const fixture = createFixture();
    const firstEffects = emptySideEffects();
    const first = fixture.begin("account-1");
    commit(fixture.coordinator, first, firstEffects);
    fixture.coordinator.markWelcomed(first);
    fixture.coordinator.complete(first);

    const secondEffects = emptySideEffects();
    const second = fixture.begin("account-1");
    commit(fixture.coordinator, second, secondEffects);

    expect(second.generation).toBe(first.generation + 1);
    expect(firstEffects).toEqual(committedSideEffects());
    expect(secondEffects).toEqual(committedSideEffects());
  });

  it("cancels on socket close before bootstrap completion", async () => {
    const fixture = createFixture();
    const gate = deferred<void>();
    const effects = emptySideEffects();
    const attempt = fixture.begin("account-1");
    const run = commitAfter(gate.promise, fixture.coordinator, attempt, effects);

    attempt.socket.readyState = 3;
    fixture.coordinator.observeSocketClose(attempt, 1006);
    gate.resolve();
    await run;

    expect(effects).toEqual(emptySideEffects());
    expect(attempt.cancellationReason).toBe("socket-close");
  });

  it("isolates attempt ownership, cancellation, and generations by account", () => {
    const fixture = createFixture();
    const firstA = fixture.begin("account-a");
    const firstB = fixture.begin("account-b");
    const secondA = fixture.begin("account-a");
    const accountBEffects = emptySideEffects();
    commit(fixture.coordinator, firstB, accountBEffects);

    expect(firstA.cancelled).toBe(true);
    expect(firstB.cancelled).toBe(false);
    expect(firstB.generation).toBe(1);
    expect(secondA.generation).toBe(2);
    expect(fixture.coordinator.currentAttempt("account-a")).toBe(secondA);
    expect(fixture.coordinator.currentAttempt("account-b")).toBe(firstB);
    expect(accountBEffects).toEqual(committedSideEffects());
    expect(() => fixture.coordinator.assertCurrentOpen(firstB, "account-isolation")).not.toThrow();
  });
});

function createFixture(timeoutMs = 10_000) {
  let attemptId = 0;
  const coordinator = new BootstrapAttemptCoordinator({
    timeoutMs,
    logger: { info: vi.fn(), warn: vi.fn() } as never,
    createAttemptId: () => `attempt-${++attemptId}`
  });
  return {
    coordinator,
    begin(accountId: string): BootstrapAttempt {
      const socket = createSocket();
      return coordinator.begin({
        accountId,
        acceptedAtMs: 1,
        authenticatedHelloAtMs: 2,
        socket,
        isSocketClosed: () => socket.readyState !== 1
      });
    }
  };
}

function createSocket(): SocketLike & { close: ReturnType<typeof vi.fn> } {
  const socket = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn((() => {
      socket.readyState = 3;
    }) as SocketLike["close"])
  };
  return socket;
}

async function commitAfter(
  gate: Promise<void>,
  coordinator: BootstrapAttemptCoordinator,
  attempt: BootstrapAttempt,
  effects: SideEffects
): Promise<void> {
  await gate;
  try {
    coordinator.assertCurrentOpen(attempt, "test-commit");
    commit(coordinator, attempt, effects);
  } catch (error) {
    if (!(error instanceof BootstrapAttemptInactiveError)) throw error;
  }
}

function commit(
  coordinator: BootstrapAttemptCoordinator,
  attempt: BootstrapAttempt,
  effects: SideEffects
): void {
  coordinator.assertCurrentOpen(attempt, "test-commit");
  effects.reconnectLeaseClaims += 1;
  effects.connectionGenerations += 1;
  effects.onlineWrites += 1;
  effects.runtimeRestores += 1;
  effects.registryHandoffs += 1;
  effects.disconnectedEvents += 0;
  effects.welcomes += 1;
  coordinator.markRegistryHandoff(attempt, {
    replacedConnectionId: null,
    replacedAccountId: null,
    replacedSocketState: null
  });
}

function emptySideEffects(): SideEffects {
  return {
    reconnectLeaseClaims: 0,
    connectionGenerations: 0,
    onlineWrites: 0,
    runtimeRestores: 0,
    registryHandoffs: 0,
    disconnectedEvents: 0,
    welcomes: 0
  };
}

function committedSideEffects(): SideEffects {
  return {
    reconnectLeaseClaims: 1,
    connectionGenerations: 1,
    onlineWrites: 1,
    runtimeRestores: 1,
    registryHandoffs: 1,
    disconnectedEvents: 0,
    welcomes: 1
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
