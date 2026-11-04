import type { WorldViewAuthority } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { CombatStore } from "./combat/combatStore.js";
import { WorldViewConvergenceBarrier } from "./worldView/worldViewConvergenceBarrier.js";

describe("startup causal convergence", () => {
  it("keeps competing ordinary snapshots behind the cover and reveals the qualified mob set", () => {
    const combat = new CombatStore();
    const paintedMobCounts: number[] = [];
    let revealed = false;
    const barrier = new WorldViewConvergenceBarrier({
      preparing: vi.fn(),
      presentationDataReady: () => {
        revealed = true;
        paintedMobCounts.push(mobCount(combat));
      },
      ready: vi.fn()
    });
    const applyOrdinarySnapshot = (
      sequence: number,
      entityIds: readonly string[]
    ): void => {
      combat.applySnapshot(batch(sequence, entityIds));
      if (revealed) paintedMobCounts.push(mobCount(combat));
    };

    applyOrdinarySnapshot(1, ["mob:early"]);
    applyOrdinarySnapshot(2, []);
    barrier.observePopulation(AUTHORITY, true);

    expect(revealed).toBe(false);
    expect(paintedMobCounts).toEqual([]);

    combat.applySnapshot(batch(3, ["mob:final"]));
    barrier.observeCombat(AUTHORITY, 7);

    expect(revealed).toBe(true);
    expect(paintedMobCounts).toEqual([1]);

    combat.applyDelta(batch(4, ["mob:final", "mob:later"]));
    paintedMobCounts.push(mobCount(combat));
    expect(paintedMobCounts).toEqual([1, 2]);
    expect(hasPositiveZeroPositiveTransition(paintedMobCounts)).toBe(false);
  });
});

const AUTHORITY: WorldViewAuthority = {
  playerId: "player-1",
  connectionId: "connection-1",
  connectionGeneration: 2,
  relocationRevision: 3,
  resourceVisionRevision: 4,
  gameplayViewGeneration: 5,
  populationPreparationGeneration: 6
};

function batch(sequence: number, entityIds: readonly string[]) {
  return {
    serverTick: sequence,
    serverTime: sequence * 100,
    sequence,
    upserts: entityIds.map((entityId) => ({
      entityId,
      kind: "mob",
      archetypeKey: "wolf",
      name: entityId,
      level: 1,
      regionCode: "NM",
      zoneId: "world:NM",
      lat: 35,
      lon: -106,
      maxHealth: 100,
      currentHealth: 100,
      lifeState: "alive",
      activityState: "idle",
      targetEntityId: null,
      revision: sequence
    })),
    removedEntityIds: [],
    events: []
  } as never;
}

function mobCount(store: CombatStore): number {
  return store.entities().filter(({ kind }) => kind === "mob").length;
}

function hasPositiveZeroPositiveTransition(counts: readonly number[]): boolean {
  return counts.some((count, index) =>
    count === 0 &&
    counts.slice(0, index).some((candidate) => candidate > 0) &&
    counts.slice(index + 1).some((candidate) => candidate > 0)
  );
}
