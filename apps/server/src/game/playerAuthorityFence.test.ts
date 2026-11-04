import { describe, expect, it } from "vitest";

import { PlayerAuthorityFence } from "./playerAuthorityFence.js";

describe("PlayerAuthorityFence", () => {
  it("serializes one player while allowing different players to proceed", async () => {
    const fence = new PlayerAuthorityFence();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = fence.run("player-1", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = fence.run("player-1", async () => { order.push("second"); });
    await fence.run("player-2", async () => { order.push("other-player"); });
    expect(order).toEqual(["first-start", "other-player"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "other-player", "first-end", "second"]);
    await Promise.resolve();
    expect(fence.pendingPlayers()).toBe(0);
  });

  it("serializes overlapping multi-player operations in stable order", async () => {
    const fence = new PlayerAuthorityFence();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = fence.runMany(["player-b", "player-a"], async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = fence.runMany(["player-a", "player-b"], async () => {
      order.push("second");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
