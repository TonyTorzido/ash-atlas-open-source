import { describe, expect, it } from "vitest";

import { WorldCommandQueue, type WorldCommand } from "./worldCommandQueue.js";

describe("WorldCommandQueue", () => {
  it("enforces stable bounded per-player and global ordering", () => {
    const queue = new WorldCommandQueue(3, 2, 100);
    expect(queue.enqueue(command("p1", "a"))).toMatchObject({ accepted: true, sequence: 1 });
    expect(queue.enqueue(command("p1", "b"))).toMatchObject({ accepted: true, sequence: 2 });
    expect(queue.enqueue(command("p1", "c"))).toEqual({
      accepted: false,
      reason: "player-overflow"
    });
    expect(queue.enqueue(command("p2", "d"))).toMatchObject({ accepted: true, sequence: 3 });
    expect(queue.enqueue(command("p3", "e"))).toEqual({
      accepted: false,
      reason: "global-overflow"
    });

    const processed: string[] = [];
    expect(queue.drain(2, (next) => {
      processed.push(next.requestId);
      return "processed";
    })).toBe(2);
    expect(processed).toEqual(["a", "b"]);
    expect(queue.depth).toBe(1);
  });

  it("rejects duplicate requests before and after processing", () => {
    const queue = new WorldCommandQueue(4, 4, 100);
    expect(queue.enqueue(command("p1", "same"))).toMatchObject({ accepted: true });
    expect(queue.enqueue(command("p1", "same"))).toEqual({
      accepted: false,
      reason: "duplicate"
    });
    queue.drain(1, () => "processed");
    expect(queue.enqueue(command("p1", "same"))).toEqual({
      accepted: false,
      reason: "duplicate"
    });
  });

  it("preserves explicit ability targets for authoritative resolution", () => {
    const queue = new WorldCommandQueue(4, 4, 100);
    const ability: WorldCommand = {
      kind: "normal-ability",
      playerId: "druid",
      accountId: "account:druid",
      connectionId: "connection:druid",
      requestId: "renewal",
      acceptedTick: 1,
      abilityId: "v3_druid_replenish",
      targetEntityId: "ally",
      targetMode: "friendly"
    };
    expect(queue.enqueue(ability)).toMatchObject({ accepted: true });

    const processed: WorldCommand[] = [];
    queue.drain(1, (command) => {
      processed.push(command);
      return "processed";
    });
    expect(processed).toEqual([ability]);
  });

  it("preserves ultimate drag positions for authoritative resolution", () => {
    const queue = new WorldCommandQueue(4, 4, 100);
    const ultimate: WorldCommand = {
      kind: "ultimate-ability",
      playerId: "ranger",
      accountId: "account:ranger",
      connectionId: "connection:ranger",
      requestId: "black-rain",
      acceptedTick: 1,
      abilityId: "ranger_v2_black_rain",
      targetPosition: { lat: 35.0844, lon: -106.6504 }
    };
    expect(queue.enqueue(ultimate)).toMatchObject({ accepted: true });
    const processed: WorldCommand[] = [];
    queue.drain(1, (command) => { processed.push(command); return "processed"; });
    expect(processed).toEqual([ultimate]);
  });

  it("reports accepted movement until that command is drained", () => {
    const queue = new WorldCommandQueue(4, 4, 100);
    expect(queue.enqueue({
      kind: "move",
      playerId: "walker",
      accountId: "account:walker",
      connectionId: "connection:walker",
      requestId: "walk",
      acceptedTick: 1,
      target: { lat: 35, lon: -106 }
    })).toMatchObject({ accepted: true });
    expect(queue.hasPendingMovementForPlayer("walker")).toBe(true);
    expect(queue.hasPendingMovementForPlayer("someone-else")).toBe(false);
    queue.drain(1, () => "processed");
    expect(queue.hasPendingMovementForPlayer("walker")).toBe(false);
  });

  it("never processes more than the requested tick budget", () => {
    const queue = new WorldCommandQueue(10, 10, 100);
    for (let index = 0; index < 8; index += 1) {
      queue.enqueue(command("p1", `request-${index}`));
    }
    expect(queue.drain(3, () => "processed")).toBe(3);
    expect(queue.metricsSnapshot()).toMatchObject({ depth: 5, processed: 3, peakDepth: 8 });
  });

  it("drains dense multi-player command traffic without exceeding its bound", () => {
    const queue = new WorldCommandQueue(1_000, 10, 100);
    for (let player = 0; player < 100; player += 1) {
      for (let request = 0; request < 10; request += 1) {
        expect(queue.enqueue(command(`p${player}`, `r${request}`)).accepted).toBe(true);
      }
    }
    expect(queue.enqueue(command("overflow", "one"))).toEqual({
      accepted: false,
      reason: "global-overflow"
    });
    while (queue.depth > 0) {
      expect(queue.drain(128, () => "processed")).toBeLessThanOrEqual(128);
    }
    expect(queue.metricsSnapshot()).toMatchObject({
      depth: 0,
      peakDepth: 1_000,
      processed: 1_000,
      globalOverflows: 1
    });
  });

  it("keeps the movement index consistent under randomized mixed traffic", () => {
    const queue = new WorldCommandQueue(64, 8, 10_000);
    const model: WorldCommand[] = [];
    let randomState = 0x5eed1234;
    const random = (): number => {
      randomState = (randomState * 1_664_525 + 1_013_904_223) >>> 0;
      return randomState / 0x1_0000_0000;
    };
    let request = 0;

    for (let operation = 0; operation < 5_000; operation += 1) {
      if (random() < 0.7) {
        const playerId = `p${Math.floor(random() * 20)}`;
        const next = mixedCommand(
          playerId,
          `request-${request++}`,
          random() < 0.4,
          operation + 1
        );
        if (queue.enqueue(next).accepted) model.push(next);
      } else {
        const maximum = Math.floor(random() * 6);
        queue.drain(maximum, (next) => {
          expect(next).toEqual(model.shift());
          return random() < 0.1 ? "stale" : "processed";
        });
      }
      const sampledPlayerId = `p${Math.floor(random() * 20)}`;
      expect(queue.hasPendingMovementForPlayer(sampledPlayerId)).toBe(
        model.some((entry) =>
          entry.playerId === sampledPlayerId && entry.kind === "move"
        )
      );
      if (operation % 100 === 0) queue.assertInternalConsistency();
    }

    queue.drain(queue.depth, (next) => {
      expect(next).toEqual(model.shift());
      return "processed";
    });
    expect(model).toEqual([]);
    queue.assertInternalConsistency();
    for (let player = 0; player < 20; player += 1) {
      expect(queue.hasPendingMovementForPlayer(`p${player}`)).toBe(false);
    }
  });

  it("serves movement lookups from an index under a large queued workload", () => {
    const playerCount = 2_000;
    const commandsPerPlayer = 20;
    const queue = new WorldCommandQueue(
      playerCount * commandsPerPlayer,
      commandsPerPlayer,
      100_000
    );
    for (let player = 0; player < playerCount; player += 1) {
      for (let request = 0; request < commandsPerPlayer; request += 1) {
        queue.enqueue(mixedCommand(
          `p${player}`,
          `r${request}`,
          request === commandsPerPlayer - 1,
          request + 1
        ));
      }
    }
    for (let pass = 0; pass < 5; pass += 1) {
      for (let player = 0; player < playerCount; player += 1) {
        expect(queue.hasPendingMovementForPlayer(`p${player}`)).toBe(true);
      }
    }
    queue.assertInternalConsistency();
    queue.drain(queue.depth, () => "processed");
    queue.assertInternalConsistency();
    expect(queue.depth).toBe(0);
    expect(queue.hasPendingMovementForPlayer("p1999")).toBe(false);
  });
});

function command(playerId: string, requestId: string): WorldCommand {
  return {
    kind: "cancel-attack",
    playerId,
    accountId: `account:${playerId}`,
    connectionId: `connection:${playerId}`,
    requestId,
    acceptedTick: 1
  };
}

function mixedCommand(
  playerId: string,
  requestId: string,
  movement: boolean,
  acceptedTick: number
): WorldCommand {
  return movement
    ? {
        kind: "move",
        playerId,
        accountId: `account:${playerId}`,
        connectionId: `connection:${playerId}`,
        requestId,
        acceptedTick,
        target: { lat: 35, lon: -106 }
      }
    : { ...command(playerId, requestId), acceptedTick };
}
