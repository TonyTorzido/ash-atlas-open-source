import type { WorldViewAuthority } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { WorldViewConvergenceBarrier } from "./worldViewConvergenceBarrier.js";

describe("WorldViewConvergenceBarrier", () => {
  it("publishes ready once in every checkpoint order", () => {
    for (const order of permutations(["population", "combat", "resources"])) {
      const preparing = vi.fn();
      const ready = vi.fn();
      const barrier = new WorldViewConvergenceBarrier({ preparing, ready });
      for (const checkpoint of order) {
        if (checkpoint === "population") {
          barrier.observePopulation(AUTHORITY, true);
        } else if (checkpoint === "combat") {
          barrier.observeCombat(AUTHORITY, 17);
        } else {
          barrier.observeResources(AUTHORITY, 23, true);
        }
      }
      expect(preparing).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledWith({
        ...AUTHORITY,
        combatSnapshotGeneration: 17,
        resourceSnapshotGeneration: 23
      });
    }
  });

  it("does not publish a partial domain combination as ready", () => {
    const ready = vi.fn();
    const barrier = new WorldViewConvergenceBarrier({
      preparing: vi.fn(),
      ready
    });
    barrier.observePopulation(AUTHORITY, true);
    barrier.observeCombat(AUTHORITY, 1);
    barrier.observeResources(AUTHORITY, 1, false);
    expect(ready).not.toHaveBeenCalled();
  });

  it("publishes presentation readiness only after population and combat converge", () => {
    const presentationDataReady = vi.fn();
    const barrier = new WorldViewConvergenceBarrier({
      preparing: vi.fn(),
      presentationDataReady,
      ready: vi.fn()
    });

    barrier.observePopulation(AUTHORITY, true);
    expect(presentationDataReady).not.toHaveBeenCalled();

    barrier.observeCombat(AUTHORITY, 1);
    expect(presentationDataReady).toHaveBeenCalledOnce();
    expect(presentationDataReady).toHaveBeenCalledWith(AUTHORITY);

    barrier.observeResources(AUTHORITY, 1, true);
    barrier.observeCombat(AUTHORITY, 2);
    expect(presentationDataReady).toHaveBeenCalledOnce();
  });

  it("keeps combat missing when only an incremental delta is available", () => {
    vi.useFakeTimers();
    try {
      const recover = vi.fn();
      const ready = vi.fn();
      const barrier = new WorldViewConvergenceBarrier({
        preparing: vi.fn(),
        ready,
        recover,
        diagnosticThresholdMs: 100
      });
      barrier.observePopulation(AUTHORITY, true);
      barrier.observeResources(AUTHORITY, 1, true);

      vi.advanceTimersByTime(100);

      expect(ready).not.toHaveBeenCalled();
      expect(recover).toHaveBeenCalledWith(
        AUTHORITY,
        ["combat"],
        1
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let old callbacks satisfy a newer epoch", () => {
    const ready = vi.fn();
    const barrier = new WorldViewConvergenceBarrier({
      preparing: vi.fn(),
      ready
    });
    barrier.observePopulation(AUTHORITY, true);
    barrier.observeCombat(AUTHORITY, 1);
    const newer = {
      ...AUTHORITY,
      resourceVisionRevision: AUTHORITY.resourceVisionRevision + 1,
      gameplayViewGeneration: AUTHORITY.gameplayViewGeneration + 1,
      populationPreparationGeneration:
        AUTHORITY.populationPreparationGeneration + 1
    };
    barrier.observePopulation(newer, true);
    barrier.observeResources(AUTHORITY, 1, true);
    barrier.observeCombat(newer, 2);
    expect(ready).not.toHaveBeenCalled();
    barrier.observeResources(newer, 2, true);
    expect(ready).toHaveBeenCalledOnce();
  });

  it("requests bounded recovery for only the missing checkpoints and completes without reconnecting", () => {
    vi.useFakeTimers();
    try {
      const recover = vi.fn();
      const ready = vi.fn();
      const barrier = new WorldViewConvergenceBarrier({
        preparing: vi.fn(),
        ready,
        recover,
        diagnosticThresholdMs: 100,
        maxRecoveryRequests: 2
      });
      barrier.observePopulation(AUTHORITY, true);
      barrier.observeCombat(AUTHORITY, 7);

      vi.advanceTimersByTime(250);

      expect(recover).toHaveBeenCalledTimes(2);
      expect(recover).toHaveBeenNthCalledWith(
        1,
        AUTHORITY,
        ["resources"],
        1
      );
      expect(recover).toHaveBeenNthCalledWith(
        2,
        AUTHORITY,
        ["resources"],
        2
      );
      barrier.observeResources(AUTHORITY, 9, true);
      expect(ready).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(500);
      expect(recover).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens one bounded recovery cycle after terminal population exhausts the first cycle", () => {
    vi.useFakeTimers();
    try {
      const recover = vi.fn();
      const barrier = new WorldViewConvergenceBarrier({
        preparing: vi.fn(),
        ready: vi.fn(),
        recover,
        diagnosticThresholdMs: 100,
        maxRecoveryRequests: 2
      });
      barrier.observePopulation(AUTHORITY, false);
      barrier.observeResources(AUTHORITY, 1, true);
      vi.advanceTimersByTime(250);

      expect(recover).toHaveBeenCalledTimes(2);
      expect(recover).toHaveBeenLastCalledWith(
        AUTHORITY,
        ["population", "combat"],
        2
      );

      barrier.observePopulation(AUTHORITY, true);
      expect(recover).toHaveBeenCalledTimes(3);
      expect(recover).toHaveBeenNthCalledWith(
        3,
        AUTHORITY,
        ["combat"],
        1
      );
      expect(barrier.diagnostics()).toMatchObject({
        authority: AUTHORITY,
        missing: ["combat"],
        recoveryAttempts: 1
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an older epoch watchdog when a newer committed epoch begins", () => {
    vi.useFakeTimers();
    try {
      const recover = vi.fn();
      const barrier = new WorldViewConvergenceBarrier({
        preparing: vi.fn(),
        ready: vi.fn(),
        recover,
        diagnosticThresholdMs: 100
      });
      barrier.begin(AUTHORITY);
      const newer = {
        ...AUTHORITY,
        relocationRevision: AUTHORITY.relocationRevision + 1,
        resourceVisionRevision: AUTHORITY.resourceVisionRevision + 1
      };
      vi.advanceTimersByTime(50);
      barrier.begin(newer);
      vi.advanceTimersByTime(50);
      expect(recover).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(recover).toHaveBeenCalledWith(
        newer,
        ["population", "combat", "resources"],
        1
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

const AUTHORITY: WorldViewAuthority = {
  playerId: "player-a",
  connectionId: "connection-a",
  connectionGeneration: 7,
  relocationRevision: 11,
  resourceVisionRevision: 13,
  gameplayViewGeneration: 17,
  populationPreparationGeneration: 19
};

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [values.slice()];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index))
      .map((rest) => [value, ...rest])
  );
}
