import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { PlayerPersistenceSupervisor } from "./playerPersistenceSupervisor.js";
import { GameState } from "./state.js";

describe("PlayerPersistenceSupervisor", () => {
  it("coalesces callers and bounds 1,000 latency-injected writes", async () => {
    const state = populatedState(1_000);
    let active = 0;
    let maxActive = 0;
    const persist = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { statements: 1, poolWaitMs: 0.25 };
    });
    const supervisor = new PlayerPersistenceSupervisor(state, persist, 8);

    const first = supervisor.runPass();
    const second = supervisor.runPass();
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({
      dirtyCount: 1_000,
      statements: 1_000,
      successes: 1_000,
      failures: 0
    });
    expect(maxActive).toBe(8);
    expect(state.dirtyPlayerMetrics().count).toBe(0);
  });

  it("keeps failed IDs dirty and retries a 10,000-player pass without unbounded fanout", async () => {
    const state = populatedState(10_000);
    let active = 0;
    let maxActive = 0;
    let attempts = 0;
    let injectFailures = true;
    const supervisor = new PlayerPersistenceSupervisor(state, async () => {
      const attempt = attempts;
      attempts += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      if (injectFailures && attempt % 997 === 0) throw new Error("injected database failure");
      return { statements: 1, poolWaitMs: 0 };
    }, 8);

    await expect(supervisor.runPass()).resolves.toMatchObject({
      dirtyCount: 10_000,
      successes: 9_989,
      retries: 11,
      failures: 11
    });
    expect(state.dirtyPlayerMetrics().count).toBe(11);
    injectFailures = false;
    await expect(supervisor.runPass()).resolves.toMatchObject({
      dirtyCount: 11,
      successes: 11,
      failures: 0
    });
    expect(maxActive).toBe(8);
    expect(state.dirtyPlayerMetrics().count).toBe(0);
  });

  it("refuses scheduled work after shutdown while allowing one mandatory drain", async () => {
    const state = populatedState(1);
    const persist = vi.fn(async () => ({ statements: 1, poolWaitMs: 0 }));
    const supervisor = new PlayerPersistenceSupervisor(state, persist, 2);
    supervisor.stopAccepting();

    await expect(supervisor.runPass()).resolves.toMatchObject({ statements: 0 });
    expect(persist).not.toHaveBeenCalled();
    await expect(supervisor.runPass({ shutdown: true })).resolves.toMatchObject({ statements: 1 });
    expect(state.dirtyPlayerMetrics().count).toBe(0);
  });
});

function populatedState(count: number): GameState {
  const state = new GameState(loadConfig({ NODE_ENV: "test" }));
  for (let index = 0; index < count; index += 1) {
    state.helloPlayer(`p-${index}`, "Player");
  }
  return state;
}
