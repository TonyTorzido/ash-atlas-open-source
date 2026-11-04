import type {
  CollectibleNode,
  CollectibleSnapshotAuthority,
  CombatEntitySnapshot
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { CombatStore } from "../combat/combatStore.js";
import { WorldResourcePresentationStore } from "./worldResourcePresentationStore.js";

describe("reported flag spawn-authority convergence", () => {
  it("shows mobs and trees on one cold jump even when the population delta was missed", () => {
    const fixture = freshFixture();
    fixture.combat.applySnapshot(combatBatch(1, liveMobs()));
    applyResource(fixture.resources, mine("ready", 1), 1);

    expect(resourceState(fixture.resources)).toEqual([
      ["tree-a", null],
      ["tree-b", null],
      ["mine-a", "ready"]
    ]);
    expect(fixture.combat.entities().map((entity) => entity.entityId))
      .toEqual(["mob-a", "mob-b", "mob-c"]);
  });

  it("converges a cold first visit in every combat/population/resource order", () => {
    for (const order of permutations(
      ["combat", "population", "resource"] as const
    )) {
      const fixture = freshFixture();
      for (const frame of order) applyFrame(fixture, frame);
      expect(resourceState(fixture.resources)).toEqual([
        ["tree-a", null],
        ["tree-b", null],
        ["mine-a", "ready"]
      ]);
      expect(fixture.combat.entities().map((entity) => entity.entityId))
        .toEqual(["mob-a", "mob-b", "mob-c"]);
    }
  });

  it("keeps exact IDs through 50 revisits, legitimate mob deaths, and one tree harvest", () => {
    const fixture = freshFixture();
    for (const frame of ["combat", "population", "resource"] as const) {
      applyFrame(fixture, frame);
    }
    const expectedResources = ["tree-a", "tree-b", "mine-a"];
    const expectedMobs = ["mob-a", "mob-b", "mob-c"];
    for (let visit = 0; visit < 50; visit += 1) {
      applyPopulation(fixture.resources, [tree("tree-a", 1), tree("tree-b", 1)]);
      applyResource(fixture.resources, mine("ready", 1), visit + 2);
      fixture.combat.applySnapshot(combatBatch(visit + 2, liveMobs()));
      expect(fixture.resources.renderList().map((node) => node.id))
        .toEqual(expectedResources);
      expect(fixture.combat.entities().map((entity) => entity.entityId))
        .toEqual(expectedMobs);
    }

    fixture.combat.applySnapshot(combatBatch(52, []));
    for (let revisit = 0; revisit < 3; revisit += 1) {
      applyPopulation(fixture.resources, [tree("tree-a", 1), tree("tree-b", 1)]);
      applyResource(fixture.resources, mine("ready", 1), 52 + revisit);
      fixture.combat.applySnapshot(combatBatch(53 + revisit, []));
    }
    expect(fixture.combat.entities()).toEqual([]);
    expect(fixture.resources.renderList().map((node) => node.id))
      .toEqual(expectedResources);

    fixture.combat.applySnapshot(combatBatch(60, liveMobs()));
    fixture.resources.remove("population", "tree-a", "harvested");
    applyPopulation(fixture.resources, [tree("tree-b", 1)]);
    expect(resourceState(fixture.resources)).toEqual([
      ["tree-b", null],
      ["mine-a", "ready"]
    ]);
    expect(fixture.combat.entities().map((entity) => entity.entityId))
      .toEqual(expectedMobs);
  });

  it("keeps one depleted mine through 50 revisits and 20 reconnects, then readies once", () => {
    let fixture = freshFixture();
    applyPopulation(fixture.resources, [tree("tree-a", 1), tree("tree-b", 1)]);
    fixture.resources.upsert("repeatable-resource", mine("depleted", 12));
    for (let visit = 0; visit < 50; visit += 1) {
      applyPopulation(fixture.resources, [tree("tree-a", 1), tree("tree-b", 1)]);
      expect(mineState(fixture.resources)).toEqual({
        id: "mine-a",
        state: "depleted",
        revision: 12
      });
    }
    for (let reconnect = 0; reconnect < 20; reconnect += 1) {
      fixture = freshFixture();
      applyPopulation(fixture.resources, [tree("tree-a", 1), tree("tree-b", 1)]);
      applyResource(fixture.resources, mine("depleted", 12), reconnect + 1);
      expect(mineState(fixture.resources)).toEqual({
        id: "mine-a",
        state: "depleted",
        revision: 12
      });
    }

    let readyTransitions = 0;
    let previous = mineState(fixture.resources).state;
    for (const update of [
      mine("depleted", 12),
      mine("ready", 13),
      mine("ready", 13)
    ]) {
      fixture.resources.upsert("repeatable-resource", update);
      const current = mineState(fixture.resources).state;
      if (previous === "depleted" && current === "ready") readyTransitions += 1;
      previous = current;
    }
    expect(readyTransitions).toBe(1);
    expect(mineState(fixture.resources)).toEqual({
      id: "mine-a",
      state: "ready",
      revision: 13
    });
  });

  it("runs 100 mixed refresh and heartbeat cycles without duplicate or unexplained loss", () => {
    const fixture = freshFixture();
    for (const frame of ["resource", "population", "combat"] as const) {
      applyFrame(fixture, frame);
    }
    for (let cycle = 0; cycle < 100; cycle += 1) {
      applyPopulation(fixture.resources, [tree("tree-a", 1), tree("tree-b", 1)]);
      fixture.resources.applySnapshot({
        authority: {
          ...authority(cycle + 2),
          completeness: cycle % 4 === 0 ? "partial" : "complete",
          ordinaryNodesTruncated: cycle % 10 === 0
        },
        nodes: [],
        repeatableNodes: [mine("ready", 1)]
      });
      fixture.combat.applyDelta(combatBatch(
        cycle + 2,
        liveMobs().map((mob) => ({
          ...mob,
          revision: cycle + 2,
          targetEntityId: mob.entityId === "mob-a" ? "player-a" : null
        }))
      ));

      const resourceIds = fixture.resources.renderList().map((node) => node.id);
      const mobIds = fixture.combat.entities().map((entity) => entity.entityId);
      expect(new Set(resourceIds).size).toBe(resourceIds.length);
      expect(new Set(mobIds).size).toBe(mobIds.length);
      expect(resourceIds).toEqual(["tree-a", "tree-b", "mine-a"]);
      expect(mobIds).toEqual(["mob-a", "mob-b", "mob-c"]);
      expect(fixture.combat.get("mob-a")).toMatchObject({
        currentHealth: 70,
        lat: 35,
        lon: -106,
        activityState: "attacking",
        targetEntityId: "player-a"
      });
    }
    expect(fixture.resources.metrics().unexplainedRemovals).toBe(0);
  });
});

type Fixture = {
  resources: WorldResourcePresentationStore;
  combat: CombatStore;
};

function freshFixture(): Fixture {
  return {
    resources: new WorldResourcePresentationStore(),
    combat: new CombatStore()
  };
}

function applyFrame(
  fixture: Fixture,
  frame: "combat" | "population" | "resource"
): void {
  if (frame === "combat") {
    fixture.combat.applySnapshot(combatBatch(1, liveMobs()));
  } else if (frame === "population") {
    applyPopulation(fixture.resources, [tree("tree-a", 1), tree("tree-b", 1)]);
  } else {
    applyResource(fixture.resources, mine("ready", 1), 1);
  }
}

function applyPopulation(
  store: WorldResourcePresentationStore,
  trees: readonly CollectibleNode[]
): void {
  store.replacePopulation(trees, new Set(), false);
}

function applyResource(
  store: WorldResourcePresentationStore,
  permanentMine: CollectibleNode,
  generation: number
): void {
  store.applySnapshot({
    authority: authority(generation),
    nodes: [tree("tree-a", 1), tree("tree-b", 1)],
    repeatableNodes: [permanentMine]
  });
}

function authority(snapshotGeneration: number): CollectibleSnapshotAuthority {
  return {
    snapshotId: `snapshot-${snapshotGeneration}`,
    snapshotGeneration,
    gameplayViewGeneration: 1,
    scope: { kind: "flag", id: "flag-a" },
    includedDomains: ["population", "repeatable-resource"],
    completeness: "complete",
    ordinaryNodesTruncated: false,
    returnedCount: 1,
    authoritativeTotalCount: 1
  };
}

function tree(id: string, revision: number): CollectibleNode {
  return {
    id,
    type: "wood",
    lat: 35,
    lon: -106,
    quantity: 4,
    state: "available",
    createdAt: "",
    harvestedAt: null,
    sourceCellId: "population:flag-a",
    waterKind: null,
    presentationOwner: "population",
    treeLifeRevision: revision
  };
}

function mine(
  state: "ready" | "depleted",
  revision: number
): CollectibleNode {
  return {
    id: "mine-a",
    type: "stone",
    lat: 35,
    lon: -106,
    quantity: 1,
    state: state === "ready" ? "available" : "harvested",
    createdAt: "",
    harvestedAt: state === "ready" ? null : "2026-07-25T00:00:00.000Z",
    sourceCellId: "repeatable:mine-a",
    waterKind: null,
    presentationOwner: "repeatable-resource",
    repeatableNodeType: "stone_mine",
    repeatableState: state,
    repeatableReadyAt: null,
    repeatableRevision: revision
  };
}

function liveMobs(): CombatEntitySnapshot[] {
  return ["mob-a", "mob-b", "mob-c"].map((entityId) => ({
    entityId,
    kind: "mob",
    archetypeKey: "wolf",
    name: entityId,
    level: 1,
    regionCode: "test",
    zoneId: "flag-a",
    lat: 35,
    lon: -106,
    maxHealth: 100,
    currentHealth: entityId === "mob-a" ? 70 : 100,
    lifeState: "alive",
    activityState: entityId === "mob-a" ? "attacking" : "idle",
    targetEntityId: entityId === "mob-a" ? "player-a" : null,
    revision: 1
  }));
}

function combatBatch(
  sequence: number,
  upserts: CombatEntitySnapshot[]
) {
  return {
    serverTick: sequence,
    serverTime: sequence,
    sequence,
    upserts,
    removedEntityIds: [],
    events: []
  };
}

function resourceState(
  store: WorldResourcePresentationStore
): Array<[string, string | null]> {
  return store.renderList().map((node) => [
    node.id,
    node.repeatableState ?? null
  ]);
}

function mineState(store: WorldResourcePresentationStore): {
  id: string;
  state: string | undefined;
  revision: number | undefined;
} {
  const node = store.renderList().find((candidate) => candidate.id === "mine-a");
  if (!node) throw new Error("mine presentation disappeared");
  return {
    id: node.id,
    state: node.repeatableState,
    revision: node.repeatableRevision
  };
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index))
      .map((rest) => [value, ...rest])
  );
}
