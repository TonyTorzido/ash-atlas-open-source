import type {
  CollectibleNode,
  CollectibleSnapshotAuthority
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { WorldResourcePresentationStore } from "./worldResourcePresentationStore.js";

describe("WorldResourcePresentationStore", () => {
  it("converges population delta and collectible snapshot in either order", () => {
    for (const snapshotFirst of [true, false]) {
      const store = new WorldResourcePresentationStore();
      const applyDelta = () =>
        store.replacePopulation([
          { ...tree("tree-a", 7), resinAvailable: false }
        ], new Set(), false);
      const applySnapshot = () =>
        store.applySnapshot({
          authority: {
            ...snapshotAuthority(1, "complete"),
            includedDomains: ["population", "repeatable-resource"]
          },
          nodes: [{ ...tree("tree-a", 7), resinAvailable: true }],
          repeatableNodes: []
        });

      if (snapshotFirst) {
        applySnapshot();
        applyDelta();
      } else {
        applyDelta();
        applySnapshot();
      }

      expect(store.renderList()).toEqual([
        expect.objectContaining({
          id: "tree-a",
          presentationOwner: "population",
          treeLifeRevision: 7,
          resinAvailable: false
        })
      ]);
    }
  });

  it("keeps berries depleted through reconnect snapshots until the next tree life", () => {
    const store = new WorldResourcePresentationStore();
    store.replacePopulation([{ ...tree("berry-tree", 7), resinAvailable: false, berryAvailable: false }], new Set(), false);
    store.applySnapshot({ authority: { ...snapshotAuthority(1, "complete"), includedDomains: ["population"] },
      nodes: [{ ...tree("berry-tree", 7), resinAvailable: false, berryAvailable: true }], repeatableNodes: [] });
    expect(store.renderList()[0]!.berryAvailable).toBe(false);
    store.replacePopulation([{ ...tree("berry-tree", 8), resinAvailable: false, berryAvailable: true }], new Set(), false);
    expect(store.renderList()[0]!.berryAvailable).toBe(true);
  });

  it("keeps a tapped Elder Fern tapped through a stale population snapshot in either order", () => {
    const tappedAt = "2026-10-07T05:47:15.212Z";
    // "node-wood" is a Elder Fern. The population runtime can still carry the pre-tap null.
    const listingFirst = new WorldResourcePresentationStore();
    listingFirst.applySnapshot({ authority: { ...snapshotAuthority(1, "complete"), includedDomains: ["population"] },
      nodes: [{ ...tree("node-wood", 7), sapReadyAt: tappedAt }], repeatableNodes: [] });
    listingFirst.replacePopulation([{ ...tree("node-wood", 7), sapReadyAt: null }], new Set(), false);
    expect(listingFirst.renderList()[0]!.sapReadyAt).toBe(tappedAt);
    const populationFirst = new WorldResourcePresentationStore();
    populationFirst.replacePopulation([{ ...tree("node-wood", 7), sapReadyAt: null }], new Set(), false);
    populationFirst.upsert("population", { ...tree("node-wood", 7), sapReadyAt: tappedAt });
    populationFirst.replacePopulation([{ ...tree("node-wood", 7), sapReadyAt: null }], new Set(), false);
    expect(populationFirst.renderList()[0]!.sapReadyAt).toBe(tappedAt);
  });

  it("does not resurrect a removed population life from a late snapshot", () => {
    const store = new WorldResourcePresentationStore();
    store.replacePopulation([tree("tree-a", 7)], new Set(), false);
    store.removeBatch([{
      domain: "population",
      nodeId: "tree-a",
      stateRevision: 7,
      reason: "harvested"
    }]);
    store.applySnapshot({
      authority: {
        ...snapshotAuthority(2, "complete"),
        includedDomains: ["population", "repeatable-resource"]
      },
      nodes: [tree("tree-a", 7)],
      repeatableNodes: []
    });

    expect(store.renderList()).toEqual([]);
  });

  it("converges to the same two trees and depleted mine in every frame order", () => {
    const populationTrees = [tree("tree-a", 4), tree("tree-b", 7)];
    const depletedMine = mine("mine-a", "depleted", 12);
    const water = resource("water-a");
    const operations = [
      (store: WorldResourcePresentationStore) =>
        store.replacePopulation(populationTrees, new Set(), true),
      (store: WorldResourcePresentationStore) =>
        store.applySnapshot({
          authority: snapshotAuthority(1, "complete"),
          nodes: [water],
          repeatableNodes: [depletedMine]
        })
    ] as const;

    for (const order of [operations, [...operations].reverse()]) {
      const store = new WorldResourcePresentationStore();
      for (const operation of order) operation(store);
      expect(store.renderList().map((node) => [
        node.id,
        node.presentationOwner,
        node.repeatableState ?? null
      ])).toEqual([
        ["water-a", "resource-vision", null],
        ["tree-a", "population", null],
        ["tree-b", "population", null],
        ["mine-a", "repeatable-resource", "depleted"]
      ]);
    }
  });

  it("never lets population replacement erase a depleted permanent mine", () => {
    for (const depletedFirst of [true, false]) {
      const store = new WorldResourcePresentationStore();
      if (depletedFirst) {
        store.upsert("repeatable-resource", mine("mine-a", "depleted", 8));
      }
      store.replacePopulation([tree("tree-a", 1)], new Set(), true);
      if (!depletedFirst) {
        store.upsert("repeatable-resource", mine("mine-a", "depleted", 8));
      }
      for (let visit = 0; visit < 50; visit += 1) {
        store.replacePopulation([tree("tree-a", 1)], new Set(), true);
        expect(store.renderList().find((node) => node.id === "mine-a"))
          .toMatchObject({
            repeatableState: "depleted",
            repeatableRevision: 8
          });
      }
    }
  });

  it.each([
    ["partial", false, "partial-snapshot-omission"],
    ["loading", false, "loading-snapshot-omission"],
    ["failed", false, "failed-snapshot-omission"],
    ["partial", true, "truncated-snapshot-omission"]
  ] as const)(
    "blocks %s snapshot omission instead of deleting retained nodes",
    (completeness, truncated, reason) => {
      const store = new WorldResourcePresentationStore();
      store.applySnapshot({
        authority: snapshotAuthority(1, "complete"),
        nodes: [resource("water-a"), resource("water-b")],
        repeatableNodes: [mine("mine-a", "ready", 1)]
      });
      store.applySnapshot({
        authority: {
          ...snapshotAuthority(2, completeness),
          ordinaryNodesTruncated: truncated,
          returnedCount: 1,
          authoritativeTotalCount: truncated ? null : 2
        },
        nodes: [resource("water-a")],
        repeatableNodes: []
      });

      expect(store.renderList().map((node) => node.id)).toEqual([
        "water-a",
        "water-b",
        "mine-a"
      ]);
      expect(store.metrics().blockedRemovals[reason]).toBeGreaterThan(0);
      expect(store.metrics()).toMatchObject({
        incompleteSnapshots: 1,
        truncatedSnapshots: truncated ? 1 : 0,
        unexplainedRemovals: 0
      });
    }
  );

  it("lets a complete owner snapshot remove only that owner's omission", () => {
    const store = new WorldResourcePresentationStore();
    store.replacePopulation([tree("tree-a", 1)], new Set(), true);
    store.applySnapshot({
      authority: snapshotAuthority(1, "complete"),
      nodes: [resource("water-a"), resource("water-b")],
      repeatableNodes: [mine("mine-a", "depleted", 5)]
    });
    store.applySnapshot({
      authority: {
        ...snapshotAuthority(2, "complete"),
        includedDomains: ["resource-vision"]
      },
      nodes: [resource("water-a")],
      repeatableNodes: []
    });

    expect(store.renderList().map((node) => node.id)).toEqual([
      "water-a",
      "tree-a",
      "mine-a"
    ]);
  });

  it("treats a null-vision player-anchor snapshot as a non-deleting update", () => {
    const store = new WorldResourcePresentationStore();
    store.replacePopulation([tree("tree-a", 1)], new Set(), true);
    store.applySnapshot({
      authority: snapshotAuthority(1, "complete"),
      nodes: [resource("water-a")],
      repeatableNodes: [mine("mine-a", "depleted", 5)]
    });
    store.applySnapshot({
      authority: {
        ...snapshotAuthority(2, "partial"),
        scope: { kind: "player-anchor", id: "player-a" },
        includedDomains: [],
        returnedCount: 0,
        authoritativeTotalCount: null
      },
      nodes: [],
      repeatableNodes: []
    });

    expect(store.renderList().map((node) => node.id)).toEqual([
      "water-a",
      "tree-a",
      "mine-a"
    ]);
  });

  it("keeps the newest repeatable revision through stale direct and snapshot frames", () => {
    const store = new WorldResourcePresentationStore();
    store.upsert("repeatable-resource", mine("mine-a", "depleted", 20));
    store.upsert("repeatable-resource", mine("mine-a", "ready", 19));
    store.applySnapshot({
      authority: snapshotAuthority(1, "complete"),
      nodes: [],
      repeatableNodes: [mine("mine-a", "ready", 19)]
    });
    expect(store.renderList()).toEqual([
      expect.objectContaining({
        id: "mine-a",
        repeatableState: "depleted",
        repeatableRevision: 20
      })
    ]);

    store.upsert("repeatable-resource", mine("mine-a", "ready", 21));
    store.upsert("repeatable-resource", mine("mine-a", "depleted", 20));
    expect(store.renderList()[0]).toMatchObject({
      repeatableState: "ready",
      repeatableRevision: 21
    });
  });

  it("reconnect replacement reconstructs the same entity IDs twenty times", () => {
    const expected = ["water-a", "tree-a", "tree-b", "mine-a"];
    const store = new WorldResourcePresentationStore();
    for (let reconnect = 0; reconnect < 20; reconnect += 1) {
      store.reset();
      store.replacePopulation([tree("tree-a", 3), tree("tree-b", 5)], new Set(), true);
      store.applySnapshot({
        authority: snapshotAuthority(reconnect + 1, "complete"),
        nodes: [resource("water-a")],
        repeatableNodes: [mine("mine-a", "depleted", 11)]
      });
      expect(store.renderList().map((node) => node.id)).toEqual(expected);
    }
  });

  it("counts and diagnoses an invalid cross-domain removal without deleting", () => {
    const diagnostic = vi.fn();
    const store = new WorldResourcePresentationStore([], diagnostic);
    store.setWorldEpoch("player-a:connection-a:7:11:13:17:19:23:29");
    store.applySnapshot({
      authority: snapshotAuthority(7, "complete"),
      nodes: [],
      repeatableNodes: [mine("mine-a", "depleted", 11)]
    });

    store.remove("population", "mine-a", "explicit-server-removal");

    expect(store.renderList().map((node) => node.id)).toEqual(["mine-a"]);
    expect(store.metrics().unexplainedRemovals).toBe(1);
    expect(diagnostic).toHaveBeenCalledWith({
      domain: "population",
      actualDomain: "repeatable-resource",
      entityKind: "stone_mine",
      entityId: "mine-a",
      worldEpoch: "player-a:connection-a:7:11:13:17:19:23:29",
      reason: "cross-domain-removal",
      attemptedReason: "explicit-server-removal"
    });
  });

  it("records zero unexplained removals across one thousand valid mixed updates", () => {
    const store = new WorldResourcePresentationStore();
    for (let revision = 1; revision <= 1_000; revision += 1) {
      store.replacePopulation(
        [tree("tree-a", revision)],
        new Set(),
        false
      );
      store.upsert(
        "repeatable-resource",
        mine(
          "mine-a",
          revision % 2 === 0 ? "ready" : "depleted",
          revision
        )
      );
      store.upsert("resource-vision", resource("water-a"));
    }

    expect(store.metrics().unexplainedRemovals).toBe(0);
    expect(store.renderList().map((node) => node.id)).toEqual([
      "water-a",
      "tree-a",
      "mine-a"
    ]);
  });

  it("materializes one render list for a one-thousand-node snapshot", () => {
    const store = new WorldResourcePresentationStore();
    const nodes = Array.from({ length: 1_000 }, (_, index) =>
      resource(`water-${index}`)
    );

    store.applySnapshot({
      authority: {
        ...snapshotAuthority(1, "complete"),
        returnedCount: nodes.length,
        authoritativeTotalCount: nodes.length
      },
      nodes,
      repeatableNodes: []
    });

    expect(store.metrics().renderMaterializations).toBe(1);
  });

  it("materializes one render list while removing 250 nodes", () => {
    const store = new WorldResourcePresentationStore();
    store.replacePopulation(
      Array.from({ length: 1_000 }, (_, index) =>
        tree(`tree-${index}`, 1)
      ),
      new Set(),
      true
    );
    const before = store.metrics().renderMaterializations;

    store.removeBatch(
      Array.from({ length: 250 }, (_, index) => ({
        domain: "population" as const,
        nodeId: `tree-${index}`,
        reason: "explicit-server-removal" as const
      }))
    );

    expect(store.metrics().renderMaterializations - before).toBe(1);
  });

  it("keeps a harvested tree's old life absent after reset", () => {
    const store = new WorldResourcePresentationStore();
    store.replacePopulation([tree("tree-a", 4)], new Set(), true);
    store.removeBatch([{
      domain: "population",
      nodeId: "tree-a",
      stateRevision: 9,
      reason: "harvested"
    }]);

    store.reset();
    store.replacePopulation([tree("tree-a", 4)], new Set(), true);
    expect(store.renderList()).toEqual([]);
  });

  it("admits a newer tree life after a harvested-life tombstone", () => {
    const store = new WorldResourcePresentationStore();
    store.replacePopulation([tree("tree-a", 4)], new Set(), true);
    store.removeBatch([{
      domain: "population",
      nodeId: "tree-a",
      stateRevision: 9,
      reason: "harvested"
    }]);
    store.reset();
    store.replacePopulation([tree("tree-a", 10)], new Set(), true);
    expect(store.renderList()).toEqual([
      expect.objectContaining({ id: "tree-a", treeLifeRevision: 10 })
    ]);
  });

  it("admits a depleted mine again only at a newer repeatable revision", () => {
    const store = new WorldResourcePresentationStore();
    store.upsert("repeatable-resource", mine("mine-a", "depleted", 12));
    store.removeBatch([{
      domain: "repeatable-resource",
      nodeId: "mine-a",
      stateRevision: 13,
      reason: "depleted-state-representation-change"
    }]);
    store.reset();

    store.upsert("repeatable-resource", mine("mine-a", "ready", 13));
    expect(store.renderList()).toEqual([]);

    store.upsert("repeatable-resource", mine("mine-a", "ready", 14));
    expect(store.renderList()).toEqual([
      expect.objectContaining({
        id: "mine-a",
        repeatableState: "ready",
        repeatableRevision: 14
      })
    ]);
  });

  it("does not permanently block an unversioned Resource Vision node", () => {
    const store = new WorldResourcePresentationStore();
    store.upsert("resource-vision", resource("water-a"));
    store.removeBatch([{
      domain: "resource-vision",
      nodeId: "water-a",
      stateRevision: 18,
      reason: "harvested"
    }]);
    store.reset();

    store.upsert("resource-vision", resource("water-a"));
    expect(store.renderList()).toEqual([
      expect.objectContaining({
        id: "water-a",
        presentationOwner: "resource-vision"
      })
    ]);
  });

  it("rejects stale applicable population and repeatable revisions", () => {
    const store = new WorldResourcePresentationStore();
    store.replacePopulation([tree("tree-a", 7)], new Set(), true);
    store.upsert("repeatable-resource", mine("mine-a", "depleted", 14));
    store.removeBatch([
      {
        domain: "population",
        nodeId: "tree-a",
        stateRevision: 99,
        reason: "harvested"
      },
      {
        domain: "repeatable-resource",
        nodeId: "mine-a",
        stateRevision: 14,
        reason: "depleted-state-representation-change"
      }
    ]);
    store.reset();

    store.replacePopulation([tree("tree-a", 6)], new Set(), true);
    store.upsert("repeatable-resource", mine("mine-a", "ready", 13));
    expect(store.renderList()).toEqual([]);
  });

  it("bounds cross-reset revision tombstones to 512 entries", () => {
    const store = new WorldResourcePresentationStore();
    const trees = Array.from({ length: 513 }, (_, index) =>
      tree(`tree-${index}`, 3)
    );
    store.replacePopulation(trees, new Set(), true);
    store.removeBatch(trees.map((node) => ({
      domain: "population" as const,
      nodeId: node.id,
      reason: "harvested" as const
    })));
    store.reset();

    store.replacePopulation(
      [tree("tree-0", 3), tree("tree-512", 3)],
      new Set(),
      true
    );
    expect(store.renderList().map((node) => node.id)).toEqual(["tree-0"]);
  });
});

function snapshotAuthority(
  snapshotGeneration: number,
  completeness: CollectibleSnapshotAuthority["completeness"]
): CollectibleSnapshotAuthority {
  return {
    snapshotId: `snapshot-${snapshotGeneration}`,
    snapshotGeneration,
    gameplayViewGeneration: 4,
    scope: { kind: "flag", id: "flag-a" },
    includedDomains: ["resource-vision", "repeatable-resource"],
    completeness,
    ordinaryNodesTruncated: false,
    returnedCount: 2,
    authoritativeTotalCount: completeness === "complete" ? 2 : null
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
    sourceCellId: "population-v2:zone-a",
    waterKind: null,
    presentationOwner: "population",
    treeLifeRevision: revision
  };
}

function mine(
  id: string,
  state: "ready" | "depleted",
  revision: number
): CollectibleNode {
  return {
    id,
    type: "stone",
    lat: 35,
    lon: -106,
    quantity: 4,
    state: state === "ready" ? "available" : "harvested",
    createdAt: "",
    harvestedAt: state === "ready" ? null : "2026-07-25T00:00:00.000Z",
    sourceCellId: "population-v2:zone-a",
    waterKind: null,
    presentationOwner: "repeatable-resource",
    repeatableNodeType: "stone_mine",
    repeatableState: state,
    repeatableRevision: revision
  };
}

function resource(id: string): CollectibleNode {
  return {
    id,
    type: "water",
    lat: 35,
    lon: -106,
    quantity: 1,
    state: "available",
    createdAt: "",
    harvestedAt: null,
    sourceCellId: "world:water",
    waterKind: "fresh",
    presentationOwner: "resource-vision"
  };
}
