import type {
  ServerMessage,
  WorldViewAuthority
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  CommittedWorldViewEpochInstaller,
  type CommittedWorldViewAuthority,
  type WorldViewEpochInstallationResult
} from "./committedWorldViewEpoch.js";
import { WorldViewConvergenceBarrier } from "./worldViewConvergenceBarrier.js";
import {
  WorldViewFrameStager,
  worldViewAuthorityForFrame,
  type InstalledRelocationAuthority
} from "./worldViewFrameStager.js";

type OrderingEvent =
  | "player"
  | "flag"
  | "population"
  | "combat"
  | "resources";

describe("CommittedWorldViewEpochInstaller", () => {
  it("installs a relocation once while partial arrival authority becomes exact", () => {
    const installer = new CommittedWorldViewEpochInstaller();

    expect(installer.installCommittedWorldViewEpoch(OLD_AUTHORITY))
      .toBe("new-epoch-installed");
    expect(installer.installCommittedWorldViewEpoch({
      playerId: AUTHORITY.playerId,
      relocationRevision: AUTHORITY.relocationRevision
    })).toBe("new-epoch-installed");
    expect(installer.installCommittedWorldViewEpoch(AUTHORITY))
      .toBe("in-place-authority-advanced");
    expect(installer.current()).toEqual(AUTHORITY);
    expect(installer.installCommittedWorldViewEpoch({
      playerId: AUTHORITY.playerId,
      relocationRevision: AUTHORITY.relocationRevision,
      resourceVisionRevision: AUTHORITY.resourceVisionRevision
    })).toBe("same-epoch-already-installed");
  });

  it("compares the full installed connection and view authority", () => {
    const installer = new CommittedWorldViewEpochInstaller();
    installer.installCommittedWorldViewEpoch(AUTHORITY);

    expect(installer.installCommittedWorldViewEpoch({
      ...AUTHORITY,
      populationPreparationGeneration:
        AUTHORITY.populationPreparationGeneration + 1
    })).toBe("in-place-authority-advanced");
    expect(installer.installCommittedWorldViewEpoch({
      ...AUTHORITY,
      connectionGeneration: AUTHORITY.connectionGeneration - 1
    })).toBe("stale-epoch-ignored");
    expect(installer.installCommittedWorldViewEpoch({
      ...AUTHORITY,
      connectionId: "other-connection"
    })).toBe("stale-epoch-ignored");
  });

  it("preserves the same authoritative tree IDs across every meaningful frame order", () => {
    for (const order of permutations<OrderingEvent>([
      "player",
      "flag",
      "population",
      "combat",
      "resources"
    ])) {
      const harness = new WorldViewOrderingHarness();
      for (const event of order) harness.process(event);
      harness.expectConverged(order.join(" -> "));
    }
  });

  it("keeps presented trees when FLAG_VISITED is the last frame", () => {
    const harness = new WorldViewOrderingHarness();
    for (const event of [
      "player",
      "population",
      "resources",
      "combat"
    ] as const) {
      harness.process(event);
    }
    expect(harness.treeIds()).toEqual(EXPECTED_TREE_IDS);

    harness.process("flag");

    expect(harness.treeIds()).toEqual(EXPECTED_TREE_IDS);
    harness.expectConverged(
      "player -> population -> resources -> combat -> flag"
    );
  });

  it("drains destination combat and resources synchronously when FLAG_VISITED installs the epoch", () => {
    vi.useFakeTimers();
    try {
      const harness = new WorldViewOrderingHarness();
      for (const event of [
        "population",
        "combat",
        "resources"
      ] as const) {
        harness.process(event);
      }
      expect(harness.pendingFrameCount()).toBe(3);
      expect(harness.mobIds()).toEqual([]);

      harness.process("flag");

      expect(harness.pendingFrameCount()).toBe(0);
      expect(harness.mobIds()).toEqual(["destination-mob"]);
      expect(harness.treeIds()).toEqual(EXPECTED_TREE_IDS);
      harness.expectConverged(
        "population -> combat -> resources -> flag"
      );
      vi.advanceTimersByTime(5_000);
      expect(harness.recoveryRequestCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("converges to the same tree set when FLAG_VISITED is first", () => {
    const harness = new WorldViewOrderingHarness();
    for (const event of [
      "flag",
      "resources",
      "combat",
      "population"
    ] as const) {
      harness.process(event);
    }

    expect(harness.treeIds()).toEqual(EXPECTED_TREE_IDS);
    harness.expectConverged(
      "flag -> resources -> combat -> population"
    );
  });

  it("makes duplicate arrivals harmless and rejects a stale prior arrival", () => {
    const harness = new WorldViewOrderingHarness();
    for (const event of [
      "player",
      "population",
      "resources",
      "combat",
      "flag"
    ] as const) {
      harness.process(event);
    }
    const before = harness.treeIds();

    expect(harness.installArrival())
      .toBe("same-epoch-already-installed");
    expect(harness.installArrival())
      .toBe("same-epoch-already-installed");
    expect(harness.install(OLD_AUTHORITY))
      .toBe("stale-epoch-ignored");

    expect(harness.treeIds()).toEqual(before);
    harness.expectConverged("duplicate and stale arrivals");
  });

  it("previews stale authority without mutating the installed epoch", () => {
    const installer = new CommittedWorldViewEpochInstaller();
    installer.installCommittedWorldViewEpoch(AUTHORITY);

    expect(installer.wouldIgnoreCommittedWorldViewEpoch(OLD_AUTHORITY)).toBe(true);
    expect(installer.current()).toEqual(AUTHORITY);
    expect(installer.wouldIgnoreCommittedWorldViewEpoch(AUTHORITY)).toBe(false);
  });
});

class WorldViewOrderingHarness {
  private readonly installer = new CommittedWorldViewEpochInstaller();
  private readonly stager = new WorldViewFrameStager();
  private readonly ready = vi.fn();
  private readonly recover = vi.fn();
  private readonly barrier = new WorldViewConvergenceBarrier({
    preparing: vi.fn(),
    ready: this.ready,
    recover: this.recover
  });
  private readonly trees = new Set(["old-location-tree"]);
  private readonly mobs = new Set<string>();
  private presentedTrees = new Set<string>();
  private retireCount = 0;

  constructor() {
    this.installer.installCommittedWorldViewEpoch(OLD_AUTHORITY);
  }

  process(event: OrderingEvent): void {
    if (event === "player") {
      this.install({
        playerId: AUTHORITY.playerId,
        relocationRevision: AUTHORITY.relocationRevision
      });
      this.replayMatching();
      this.expectPresentedTreesRemain();
      return;
    }
    if (event === "flag") {
      this.installArrival();
      this.replayMatching();
      this.expectPresentedTreesRemain();
      return;
    }

    const frame = checkpointFrame(event, AUTHORITY);
    if (!this.stager.stageIfAhead(frame, this.installedRelocation())) {
      this.present(frame);
    }
    this.expectPresentedTreesRemain();
  }

  installArrival(): WorldViewEpochInstallationResult {
    return this.install({
      playerId: AUTHORITY.playerId,
      relocationRevision: AUTHORITY.relocationRevision,
      resourceVisionRevision: AUTHORITY.resourceVisionRevision
    });
  }

  install(
    authority: CommittedWorldViewAuthority
  ): WorldViewEpochInstallationResult {
    const result =
      this.installer.installCommittedWorldViewEpoch(authority);
    if (result === "new-epoch-installed") {
      this.retireCount += 1;
      this.trees.clear();
      this.barrier.reset();
    }
    return result;
  }

  treeIds(): string[] {
    return [...this.trees].sort();
  }

  mobIds(): string[] {
    return [...this.mobs].sort();
  }

  pendingFrameCount(): number {
    return this.stager.pendingCount();
  }

  recoveryRequestCount(): number {
    return this.recover.mock.calls.length;
  }

  expectConverged(order: string): void {
    expect(this.stager.pendingCount(), order).toBe(0);
    expect(this.treeIds(), order).toEqual(EXPECTED_TREE_IDS);
    expect(this.trees.has("old-location-tree"), order).toBe(false);
    expect(this.retireCount, order).toBe(1);
    expect(this.ready, order).toHaveBeenCalledOnce();
  }

  private installedRelocation(): InstalledRelocationAuthority {
    const installed = this.installer.current();
    if (!installed) throw new Error("expected installed authority");
    return {
      playerId: installed.playerId,
      relocationRevision: installed.relocationRevision,
      ...(installed.resourceVisionRevision !== undefined
        ? {
            resourceVisionRevision:
              installed.resourceVisionRevision
          }
        : {})
    };
  }

  private replayMatching(): void {
    for (
      const frame of this.stager.takeMatching(
        this.installedRelocation()
      )
    ) {
      this.present(frame);
    }
  }

  private present(frame: ServerMessage): void {
    const authority = worldViewAuthorityForFrame(frame);
    if (!authority) throw new Error("expected checkpoint authority");
    if (this.install(authority) === "stale-epoch-ignored") return;

    if (frame.type === "POPULATION_ZONE_DELTA") {
      this.trees.add("population-tree");
      this.presentedTrees.add("population-tree");
      this.barrier.observePopulation(authority, true);
      return;
    }
    if (frame.type === "COMBAT_SNAPSHOT") {
      for (const entity of frame.state.upserts) {
        if (entity.kind === "mob") this.mobs.add(entity.entityId);
      }
      this.barrier.observeCombat(
        authority,
        frame.combatSnapshotGeneration ?? 17
      );
      return;
    }
    if (frame.type === "COLLECTIBLES_SNAPSHOT") {
      this.trees.add("resource-tree");
      this.presentedTrees.add("resource-tree");
      this.barrier.observeResources(
        authority,
        frame.authority.snapshotGeneration,
        true
      );
    }
  }

  private expectPresentedTreesRemain(): void {
    for (const treeId of this.presentedTrees) {
      expect(this.trees.has(treeId)).toBe(true);
    }
  }
}

const AUTHORITY: WorldViewAuthority = {
  playerId: "player-1",
  connectionId: "connection-2",
  connectionGeneration: 2,
  relocationRevision: 7,
  resourceVisionRevision: 9,
  gameplayViewGeneration: 11,
  populationPreparationGeneration: 13
};

const OLD_AUTHORITY: WorldViewAuthority = {
  ...AUTHORITY,
  connectionId: "connection-1",
  connectionGeneration: 1,
  relocationRevision: 6,
  resourceVisionRevision: 8,
  gameplayViewGeneration: 10,
  populationPreparationGeneration: 12
};

const EXPECTED_TREE_IDS = ["population-tree", "resource-tree"];

function checkpointFrame(
  event: Exclude<OrderingEvent, "player" | "flag">,
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
      combatSnapshotGeneration: 17,
      state: {
        serverTick: 1,
        serverTime: 1,
        sequence: 1,
        upserts: [{
          entityId: "destination-mob",
          kind: "mob"
        }],
        removedEntityIds: [],
        events: []
      }
    } as unknown as ServerMessage;
  }
  return {
    type: "COLLECTIBLES_SNAPSHOT",
    worldViewAuthority: authority,
    authority: { snapshotGeneration: 23 }
  } as unknown as ServerMessage;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [values.slice()];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index))
      .map((rest) => [value, ...rest])
  );
}
