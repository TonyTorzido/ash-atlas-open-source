import { describe, expect, it, vi } from "vitest";

import { createConnectionWorldOperations } from "./connectionWorldOperations.js";

describe("connection world operations post-travel intents", () => {
  it("returns the current authority with a recovery combat snapshot", () => {
    const sendCombatScopeSnapshot = vi.fn();
    const operations = createConnectionWorldOperations({
      state: {
        playerId: "player-1",
        connectionId: "connection-1"
      },
      authenticatedSession: null,
      socket: { send: vi.fn() } as never,
      registry: {
        activeConnectionIdForPlayer: vi.fn(() => "connection-1"),
        sendToConnection: vi.fn()
      } as never,
      gameState: {
        getPlayer: vi.fn(() => ({ relocationRevision: 3 }))
      } as never,
      worldRuntime: {
        replication: { requestResync: vi.fn(), snapshotForPlayer: vi.fn(() => []) },
        interestFrameFor: vi.fn(() => ({ nearbyIdsByPlayer: new Map() })),
        hasPlayerWorldTransition: vi.fn(() => false)
      } as never,
      combat: { requestResync: vi.fn(), snapshotForPlayer: vi.fn() } as never,
      playerAuthorityFence: {
        run: (_playerId: string, operation: () => Promise<unknown>) => operation()
      } as never,
      sendManorsForPlayer: vi.fn(async () => undefined),
      sendCombatScopeSnapshot
    });

    operations.requestWorldResync("startup-recovery");

    expect(sendCombatScopeSnapshot).toHaveBeenCalledWith(
      "player-1",
      undefined,
      true
    );
  });

  it("waits for a committed transition and accepts the current connection and revision", async () => {
    const harness = createHarness({ committedRelocationRevision: 7 });
    const result = harness.operations.awaitCommittedPlayerWorldTransition("harvest-1");

    harness.release();

    await expect(result).resolves.toBe(true);
    expect(harness.waitForPlayerWorldTransition).toHaveBeenCalledWith("player-1");
  });

  it("rejects an intent while relocation remains uncommitted", async () => {
    const harness = createHarness({ committedRelocationRevision: null });

    await expect(
      harness.operations.awaitCommittedPlayerWorldTransition("harvest-2")
    ).resolves.toBe(false);
    expect(harness.waitForPlayerWorldTransition).not.toHaveBeenCalled();
  });

  it("discards a committed intent after connection replacement", async () => {
    const harness = createHarness({ committedRelocationRevision: 7 });
    const result = harness.operations.awaitCommittedPlayerWorldTransition("harvest-3");

    harness.replaceConnection();
    harness.release();

    await expect(result).resolves.toBe(false);
  });
});

function createHarness(input: Readonly<{
  committedRelocationRevision: number | null;
}>) {
  let activeConnectionId = "connection-1";
  let transition: Readonly<{
    requestId: string;
    connectionId: string;
    committedRelocationRevision: number | null;
  }> | null = {
    requestId: "travel-1",
    connectionId: "connection-1",
    committedRelocationRevision: input.committedRelocationRevision
  };
  let releaseTransition!: () => void;
  const transitionReleased = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  const waitForPlayerWorldTransition = vi.fn(() => transitionReleased);
  const worldRuntime = {
    playerWorldTransitionState: vi.fn(() => transition),
    waitForPlayerWorldTransition,
    hasPlayerWorldTransition: vi.fn(() => transition !== null)
  };
  const state = {
    playerId: "player-1",
    connectionId: "connection-1"
  };
  const operations = createConnectionWorldOperations({
    state,
    authenticatedSession: null,
    socket: { send: vi.fn() } as never,
    registry: {
      activeConnectionIdForPlayer: () => activeConnectionId
    } as never,
    gameState: {
      getPlayer: () => ({ relocationRevision: 7 })
    } as never,
    worldRuntime: worldRuntime as never,
    playerAuthorityFence: {
      run: (_playerId: string, operation: () => Promise<unknown>) => operation()
    } as never,
    sendManorsForPlayer: vi.fn(async () => undefined)
  });
  return {
    operations,
    waitForPlayerWorldTransition,
    replaceConnection(): void {
      activeConnectionId = "connection-2";
    },
    release(): void {
      transition = null;
      releaseTransition();
    }
  };
}
