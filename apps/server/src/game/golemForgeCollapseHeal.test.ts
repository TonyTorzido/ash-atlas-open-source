import { DUNGEON_CATALOG } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { DungeonRuntime } from "./dungeon.js";

type Internals = { instances: Map<string, unknown>; sweepGolemForges(now: number): void; golemForgeSweep: Promise<void> | null };

const forge = DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === "golem_forge")!;
const ENTRANCE = "golem_forge_0_0_0";

function runtimeWith(
  instance: Readonly<{ completed: boolean; encounters: Map<string, { state: string; completedAt?: number }> }> | null,
  persistedRows: ReadonlyArray<{ instance_id: string; died_at: string | null }> = []
) {
  const recordForgemasterDeath = vi.fn(async () => undefined);
  const sites = { recordForgemasterDeath, collapsedSites: vi.fn(async () => []), site: vi.fn(), siteForEntrance: vi.fn(), sitesNear: vi.fn() };
  const pool = { query: vi.fn(async () => ({ rows: persistedRows })) };
  const combat = new Proxy({}, { get: () => vi.fn(() => null) });
  const runtime = new DungeonRuntime(pool as never, combat as never, undefined, forge, { golemForgeSites: sites } as never) as unknown as Internals;
  if (instance) runtime.instances.set(`dungeon:${ENTRANCE}`, { dungeon: forge, ...instance });
  return { runtime, recordForgemasterDeath };
}

async function sweep(runtime: Internals, now: number): Promise<void> {
  runtime.sweepGolemForges(now);
  await runtime.golemForgeSweep;
}

describe("golem forge collapse self-heal", () => {
  it("gives a loaded Forge with a dead Forgemaster its death time, else now", async () => {
    const withTime = runtimeWith({ completed: false, encounters: new Map([["forgemaster", { state: "completed", completedAt: 5_000 }]]) });
    await sweep(withTime.runtime, 90_000);
    expect(withTime.recordForgemasterDeath).toHaveBeenCalledWith(ENTRANCE, 5_000);

    const withoutTime = runtimeWith({ completed: true, encounters: new Map([["forgemaster", { state: "completed" }]]) });
    await sweep(withoutTime.runtime, 90_000);
    expect(withoutTime.recordForgemasterDeath).toHaveBeenCalledWith(ENTRANCE, 90_000);
  });

  it("leaves a Forge alone while the Forgemaster lives", async () => {
    const alive = runtimeWith({ completed: false, encounters: new Map([["forgemaster", { state: "idle" }]]) });
    await sweep(alive.runtime, 90_000);
    expect(alive.recordForgemasterDeath).not.toHaveBeenCalled();
  });

  it("heals a Forge that is only in the database (nobody has entered since a restart)", async () => {
    const stored = runtimeWith(null, [
      { instance_id: `dungeon:${ENTRANCE}`, died_at: "7000" },
      { instance_id: "dungeon:golem_forge_0_1_0", died_at: null }
    ]);
    await sweep(stored.runtime, 90_000);
    expect(stored.recordForgemasterDeath).toHaveBeenCalledWith(ENTRANCE, 7_000);
    expect(stored.recordForgemasterDeath).toHaveBeenCalledWith("golem_forge_0_1_0", 90_000);
  });
});
