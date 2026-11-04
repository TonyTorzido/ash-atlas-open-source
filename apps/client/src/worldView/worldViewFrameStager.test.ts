import type {
  ServerMessage,
  WorldViewAuthority
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { WorldViewConvergenceBarrier } from "./worldViewConvergenceBarrier.js";
import {
  committedWorldViewAuthorityForFrame,
  WorldViewFrameStager,
  worldViewAuthorityForFrame,
  type InstalledRelocationAuthority
} from "./worldViewFrameStager.js";

type MatrixEvent = "travel" | "population" | "combat" | "resources";

describe("WorldViewFrameStager", () => {
  it("converges exactly once for every travel and domain frame order", () => {
    for (const order of permutations<MatrixEvent>([
      "travel",
      "population",
      "combat",
      "resources"
    ])) {
      const ready = vi.fn();
      const barrier = new WorldViewConvergenceBarrier({
        preparing: vi.fn(),
        ready
      });
      const stager = new WorldViewFrameStager();
      let installed = installedAuthority(1, 1);

      for (const event of order) {
        if (event === "travel") {
          installed = installedAuthority(
            AUTHORITY.relocationRevision,
            AUTHORITY.resourceVisionRevision
          );
          for (const frame of stager.takeMatching(installed)) {
            observe(barrier, frame);
          }
          continue;
        }
        const frame = checkpointFrame(event, AUTHORITY);
        if (!stager.stageIfAhead(frame, installed)) {
          observe(barrier, frame);
        }
      }

      expect(stager.pendingCount(), order.join(" -> ")).toBe(0);
      expect(ready, order.join(" -> ")).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledWith({
        ...AUTHORITY,
        combatSnapshotGeneration: 17,
        resourceSnapshotGeneration: 23
      });
    }
  });

  it("keeps duplicates and stale frames from completing the wrong epoch", () => {
    const ready = vi.fn();
    const barrier = new WorldViewConvergenceBarrier({
      preparing: vi.fn(),
      ready
    });
    const stager = new WorldViewFrameStager();
    const installed = installedAuthority(
      AUTHORITY.relocationRevision,
      AUTHORITY.resourceVisionRevision
    );
    const duplicatePopulation = checkpointFrame("population", AUTHORITY);
    observe(barrier, duplicatePopulation);
    observe(barrier, duplicatePopulation);
    observe(barrier, checkpointFrame("combat", AUTHORITY));
    observe(barrier, checkpointFrame("resources", AUTHORITY));
    expect(ready).toHaveBeenCalledOnce();

    const stale = {
      ...AUTHORITY,
      relocationRevision: AUTHORITY.relocationRevision - 1,
      resourceVisionRevision: AUTHORITY.resourceVisionRevision - 1,
      gameplayViewGeneration: AUTHORITY.gameplayViewGeneration - 1,
      populationPreparationGeneration:
        AUTHORITY.populationPreparationGeneration - 1
    };
    const stalePopulation = checkpointFrame("population", stale);
    expect(stager.stageIfAhead(stalePopulation, installed)).toBe(false);
    observe(barrier, stalePopulation);
    expect(ready).toHaveBeenCalledOnce();
  });

  it("supersedes an incomplete epoch and replays only the newer committed relocation", () => {
    const ready = vi.fn();
    const barrier = new WorldViewConvergenceBarrier({
      preparing: vi.fn(),
      ready
    });
    const stager = new WorldViewFrameStager();
    let installed = installedAuthority(
      AUTHORITY.relocationRevision,
      AUTHORITY.resourceVisionRevision
    );
    observe(barrier, checkpointFrame("population", AUTHORITY));

    const newer = {
      ...AUTHORITY,
      relocationRevision: AUTHORITY.relocationRevision + 1,
      resourceVisionRevision: AUTHORITY.resourceVisionRevision + 1,
      gameplayViewGeneration: AUTHORITY.gameplayViewGeneration + 1,
      populationPreparationGeneration:
        AUTHORITY.populationPreparationGeneration + 1
    };
    for (const event of ["resources", "combat", "population"] as const) {
      expect(stager.stageIfAhead(
        checkpointFrame(event, newer),
        installed
      )).toBe(true);
    }

    installed = installedAuthority(
      newer.relocationRevision,
      newer.resourceVisionRevision
    );
    for (const frame of stager.takeMatching(installed)) {
      observe(barrier, frame);
    }

    expect(ready).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledWith({
      ...newer,
      combatSnapshotGeneration: 17,
      resourceSnapshotGeneration: 23
    });
  });

  it("stages a resource snapshot using its partial authority fields", () => {
    const stager = new WorldViewFrameStager();
    const frame = {
      type: "COLLECTIBLES_SNAPSHOT",
      playerId: AUTHORITY.playerId,
      relocationRevision: AUTHORITY.relocationRevision,
      resourceVisionRevision: AUTHORITY.resourceVisionRevision,
      authority: {
        gameplayViewGeneration: AUTHORITY.gameplayViewGeneration
      }
    } as unknown as ServerMessage;

    expect(worldViewAuthorityForFrame(frame)).toBeNull();
    expect(committedWorldViewAuthorityForFrame(frame)).toEqual({
      playerId: AUTHORITY.playerId,
      relocationRevision: AUTHORITY.relocationRevision,
      resourceVisionRevision: AUTHORITY.resourceVisionRevision,
      gameplayViewGeneration: AUTHORITY.gameplayViewGeneration
    });
    expect(stager.stageIfAhead(frame, installedAuthority(1, 1)))
      .toBe(true);
    expect(stager.takeMatching(installedAuthority(
      AUTHORITY.relocationRevision,
      AUTHORITY.resourceVisionRevision
    ))).toEqual([frame]);
  });
});

const AUTHORITY: WorldViewAuthority = {
  playerId: "player-1",
  connectionId: "connection-1",
  connectionGeneration: 4,
  relocationRevision: 7,
  resourceVisionRevision: 9,
  gameplayViewGeneration: 11,
  populationPreparationGeneration: 13
};

function installedAuthority(
  relocationRevision: number,
  resourceVisionRevision: number
): InstalledRelocationAuthority {
  return {
    playerId: AUTHORITY.playerId,
    relocationRevision,
    resourceVisionRevision
  };
}

function checkpointFrame(
  event: Exclude<MatrixEvent, "travel">,
  authority: WorldViewAuthority
): ServerMessage {
  if (event === "population") {
    return {
      type: "POPULATION_ZONE_DELTA",
      playerId: authority.playerId,
      connectionId: authority.connectionId,
      connectionGeneration: authority.connectionGeneration,
      relocationRevision: authority.relocationRevision,
      resourceVisionRevision: authority.resourceVisionRevision,
      gameplayViewGeneration: authority.gameplayViewGeneration,
      preparationGeneration: authority.populationPreparationGeneration
    } as unknown as ServerMessage;
  }
  if (event === "combat") {
    return {
      type: "COMBAT_SNAPSHOT",
      worldViewAuthority: authority,
      combatSnapshotGeneration: 17
    } as unknown as ServerMessage;
  }
  return {
    type: "COLLECTIBLES_SNAPSHOT",
    worldViewAuthority: authority,
    authority: { snapshotGeneration: 23 }
  } as unknown as ServerMessage;
}

function observe(
  barrier: WorldViewConvergenceBarrier,
  frame: ServerMessage
): void {
  const authority = worldViewAuthorityForFrame(frame);
  if (!authority) throw new Error("expected a world-view checkpoint frame");
  if (frame.type === "POPULATION_ZONE_DELTA") {
    barrier.observePopulation(authority, true);
  } else if (frame.type === "COMBAT_SNAPSHOT") {
    barrier.observeCombat(authority, frame.combatSnapshotGeneration ?? 17);
  } else if (frame.type === "COLLECTIBLES_SNAPSHOT") {
    barrier.observeResources(
      authority,
      frame.authority.snapshotGeneration,
      true
    );
  }
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [values.slice()];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index))
      .map((rest) => [value, ...rest])
  );
}
