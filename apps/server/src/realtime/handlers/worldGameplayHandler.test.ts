import { describe, expect, it, vi } from "vitest";

import { createWorldGameplayHandler } from "./worldGameplayHandler.js";

describe("world gameplay movement flag upgrade cancellation", () => {
  it("cancels an active flag upgrade only after MOVE_TO is accepted", async () => {
    const cancelPlayer = vi.fn();
    const cancelBomberDemolitions = vi.fn(async () => undefined);
    let accepted = false;
    const player = {
      position: { lat: 40, lon: -105 }, target: null, movementRevision: 1,
      relocationRevision: 0
    };
    const handler = createWorldGameplayHandler({
      state: { playerId: "player-1" },
      logger: { warn: vi.fn(), info: vi.fn() },
      gameState: {
        getPlayer: vi.fn(() => player),
        isMovementBlocked: vi.fn(() => false)
      },
      flagBuilds: null,
      flagHardenings: { cancelPlayer },
      cancelBomberDemolitionsForMovement: cancelBomberDemolitions,
      cancelPendingManorEntry: vi.fn(() => false),
      enqueueWorldCommand: vi.fn(() => accepted),
      runMovementLifecycle: (operation: () => Promise<unknown>) => operation()
    } as never);
    const message = { type: "MOVE_TO" as const, requestId: "move-1", lat: 40, lon: -105 };
    await handler(message);
    expect(cancelPlayer).not.toHaveBeenCalled();
    expect(cancelBomberDemolitions).not.toHaveBeenCalled();
    accepted = true;
    await handler({ ...message, requestId: "move-2" });
    expect(cancelPlayer).toHaveBeenCalledWith("player-1", "movement");
    expect(cancelBomberDemolitions).toHaveBeenCalledWith("player-1");
  });
});

describe("world gameplay raft launch", () => {
  const leg = {
    origin: { lat: 40, lon: -105 },
    relocationRevision: 0,
    segments: [
      { startM: 0, multiplier: 1, surface: "land" as const },
      { startM: 40, multiplier: 0.5, surface: "open_water" as const }
    ]
  };

  const shoreStop = { lat: 40, lon: -104.9999 };
  const shore = { at: { lat: 40, lon: -105 }, normalDeg: 90, gapM: 1.2 };

  function setup(launchStatus: "launched" | "replayed" | "insufficient", afloatAfterLaunch = true) {
    let afloat = false;
    const planMove = vi.fn();
    const sent: Array<{ type: string; code?: string }> = [];
    const enqueueWorldCommand = vi.fn((_command: unknown) => true);
    const launchRaft = vi.fn(async () => {
      if (launchStatus === "launched") afloat = afloatAfterLaunch;
      return launchStatus === "launched"
        ? { status: "launched" as const, inventory: { playerId: "player-1", revision: 1, items: [] } as never }
        : { status: launchStatus };
    });
    const player = {
      position: { lat: 40, lon: -105 }, target: null, movementRevision: 1, relocationRevision: 0
    };
    const handler = createWorldGameplayHandler({
      state: { playerId: "player-1" },
      logger: { warn: vi.fn(), info: vi.fn() },
      gameState: {
        getPlayer: vi.fn(() => player),
        isMovementBlocked: vi.fn(() => false),
        isAfloat: vi.fn(() => afloat)
      },
      flagBuilds: null,
      flagHardenings: { cancelPlayer: vi.fn() },
      cancelPendingManorEntry: vi.fn(() => false),
      enqueueWorldCommand,
      runMovementLifecycle: (operation: () => Promise<unknown>) => operation(),
      waterTravel: {
        planMove: planMove.mockImplementation(async (
          _playerId: string,
          target: { lat: number; lon: number },
          options?: { walk?: boolean }
        ) => {
          if (afloat) return { target, needsRaft: false, leg };
          if (options?.walk) return { target: shoreStop, needsRaft: false, blocked: true, leg, shore };
          return { target, needsRaft: true, leg };
        }),
        launchRaft
      },
      send: (message: { type: string; code?: string }) => { sent.push(message); }
    } as never);
    return { handler, sent, enqueueWorldCommand, launchRaft, planMove };
  }

  const move = { type: "MOVE_TO" as const, requestId: "move-raft-1", lat: 40, lon: -104.99 };

  it("denies a move into ocean without a raft and offers the launch", async () => {
    const { handler, sent, enqueueWorldCommand, launchRaft } = setup("launched");
    await handler(move);
    expect(sent).toEqual([expect.objectContaining({
      type: "RAFT_REQUIRED",
      requestId: "move-raft-1",
      cost: [
        { itemId: "wood", quantity: 3 },
        { itemId: "crude_oil", quantity: 3 },
        { itemId: "leather", quantity: 2 }
      ]
    })]);
    expect(launchRaft).not.toHaveBeenCalled();
    expect(enqueueWorldCommand).not.toHaveBeenCalled();
  });

  it("walks to the shore without a raft prompt and forwards the shore wall", async () => {
    const { handler, sent, enqueueWorldCommand, launchRaft, planMove } = setup("launched");
    await handler({ ...move, walk: true });
    expect(planMove).toHaveBeenCalledWith("player-1", { lat: 40, lon: -104.99 }, { walk: true });
    expect(sent.map((message) => message.type)).not.toContain("RAFT_REQUIRED");
    expect(launchRaft).not.toHaveBeenCalled();
    expect(enqueueWorldCommand).toHaveBeenCalledWith(expect.objectContaining({
      kind: "move", requestId: "move-raft-1", target: shoreStop, waterLeg: leg, shore
    }));
  });

  it("allows the move after a confirmed launch and sends the new inventory", async () => {
    const { handler, sent, enqueueWorldCommand, launchRaft } = setup("launched");
    await handler({ ...move, launchRaft: true });
    expect(launchRaft).toHaveBeenCalledWith("player-1", "move-raft-1");
    expect(sent.map((message) => message.type)).toEqual(["PLAYER_RESOURCES_UPDATED"]);
    expect(enqueueWorldCommand).toHaveBeenCalledWith(expect.objectContaining({
      kind: "move", requestId: "move-raft-1", waterLeg: leg
    }));
    // A replay of the same request is a plain move now that the player is afloat.
    await handler({ ...move, launchRaft: true });
    expect(launchRaft).toHaveBeenCalledTimes(1);
    expect(enqueueWorldCommand).toHaveBeenCalledTimes(2);
  });

  it("never grants a second raft for a replayed request id", async () => {
    const { handler, sent, enqueueWorldCommand } = setup("replayed");
    await handler({ ...move, launchRaft: true });
    expect(sent.map((message) => message.type)).toEqual(["RAFT_REQUIRED"]);
    expect(enqueueWorldCommand).not.toHaveBeenCalled();
  });

  it("rejects the move when the raft materials are missing", async () => {
    const { handler, sent, enqueueWorldCommand } = setup("insufficient");
    await handler({ ...move, launchRaft: true });
    expect(sent).toEqual([expect.objectContaining({ type: "ERROR", code: "MOVE_REJECTED" })]);
    expect(enqueueWorldCommand).not.toHaveBeenCalled();
  });
});

describe("world gameplay SWING", () => {
  it("enqueues a swing command without the movement lifecycle or movement cancels", async () => {
    const enqueueWorldCommand = vi.fn((command: unknown) => Boolean(command));
    const runMovementLifecycle = vi.fn((operation: () => Promise<unknown>) => operation());
    const cancelPlayer = vi.fn();
    const cancelPendingManorEntry = vi.fn(() => false);
    const handler = createWorldGameplayHandler({
      state: { playerId: "player-1" },
      logger: { warn: vi.fn(), info: vi.fn() },
      gameState: { getPlayer: vi.fn(() => null) },
      flagBuilds: null,
      flagHardenings: { cancelPlayer },
      cancelPendingManorEntry,
      enqueueWorldCommand,
      runMovementLifecycle
    } as never);
    await handler({ type: "SWING", requestId: "swing-1", seq: 7, dirX: 0, dirY: 1, lagMs: 80 });
    expect(enqueueWorldCommand).toHaveBeenCalledTimes(1);
    expect(enqueueWorldCommand.mock.calls[0]![0]).toMatchObject({
      kind: "swing", requestId: "swing-1", seq: 7, dirX: 0, dirY: 1, lagMs: 80
    });
    expect(runMovementLifecycle).not.toHaveBeenCalled();
    expect(cancelPlayer).not.toHaveBeenCalled();
    expect(cancelPendingManorEntry).not.toHaveBeenCalled();
  });
});
