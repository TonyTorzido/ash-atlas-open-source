import type { CollectibleNode, PopulationZoneEntitySnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  applyPopulationZoneDelta,
  coalescePopulationZoneDeltas,
  emptyPopulationZoneProjection,
  mergeCollectibleSnapshotWithPopulation,
  mergePopulationCollectibles,
  populationProjectionMatchesAuthority,
  removePopulationCollectible,
  type PopulationZoneDelta
} from "./populationZoneProjection.js";

describe("population zone client projection", () => {
  it.each([
    { relocationRevision: 6, resourceVisionRevision: 9 },
    { relocationRevision: 7, resourceVisionRevision: 8 }
  ])("rejects deltas unless both authority revisions match exactly", (revisions) => {
    const current = emptyPopulationZoneProjection();
    const result = applyPopulationZoneDelta(
      current,
      delta({ ...revisions, upserts: [entity("tree-a", "tree", 1)] }),
      {
        playerId: "player-1",
        relocationRevision: 7,
        resourceVisionRevision: 9
      }
    );

    expect(result.accepted).toBe(false);
    expect(result.state).toBe(current);
    expect(result.collectibleUpserts).toEqual([]);
  });

  it("accepts population that arrives before the committed relocation frame", () => {
    const initial = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: ["zone-old"],
        zoneSnapshots: [
          zoneSnapshot("zone-old", "generation-old", ["tree-old"])
        ],
        upserts: [
          entity("tree-old", "tree", 1, 35, "zone-old", "generation-old")
        ]
      }),
      authority
    );
    const nextAuthority = {
      playerId: authority.playerId,
      relocationRevision: authority.relocationRevision + 1,
      resourceVisionRevision: authority.resourceVisionRevision + 1
    };
    const arrivedBeforeTravelFrame = applyPopulationZoneDelta(
      initial.state,
      delta({
        ...nextAuthority,
        releasedZoneIds: ["zone-old"],
        activatedZoneIds: ["zone-new"],
        zoneSnapshots: [
          zoneSnapshot("zone-new", "generation-new", ["tree-new"])
        ],
        upserts: [
          entity("tree-new", "tree", 1, 35, "zone-new", "generation-new")
        ],
        preparationResult: "ready"
      }),
      authority
    );

    expect(arrivedBeforeTravelFrame.accepted).toBe(true);
    expect(arrivedBeforeTravelFrame.replacesProjection).toBe(false);
    expect([...arrivedBeforeTravelFrame.state.entities.keys()])
      .toEqual(["tree-new"]);
    expect(populationProjectionMatchesAuthority(
      arrivedBeforeTravelFrame.state,
      nextAuthority
    )).toBe(true);

    const terminalBeforeTravelFrame = applyPopulationZoneDelta(
      arrivedBeforeTravelFrame.state,
      delta({
        ...nextAuthority,
        retainedZoneIds: ["zone-new"],
        preparationResult: "ready"
      }),
      authority
    );
    expect(terminalBeforeTravelFrame.accepted).toBe(true);
    expect(terminalBeforeTravelFrame.replacesProjection).toBe(false);
    expect([...terminalBeforeTravelFrame.state.entities.keys()])
      .toEqual(["tree-new"]);

    const staleAfterAdvance = applyPopulationZoneDelta(
      terminalBeforeTravelFrame.state,
      delta({
        ...authority,
        activatedZoneIds: ["zone-old"],
        zoneSnapshots: [
          zoneSnapshot("zone-old", "generation-old", ["tree-old"])
        ],
        upserts: [
          entity("tree-old", "tree", 2, 35, "zone-old", "generation-old")
        ]
      }),
      authority
    );

    expect(staleAfterAdvance.accepted).toBe(false);
    expect(staleAfterAdvance.state).toBe(terminalBeforeTravelFrame.state);
  });

  it("retains overlapping resources while merging stable fringe entity ids", () => {
    const initial = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: ["zone-a"],
        upserts: [entity("tree-a", "tree", 1)]
      }),
      authority
    );
    const shifted = applyPopulationZoneDelta(
      initial.state,
      delta({
        retainedZoneIds: ["zone-a"],
        activatedZoneIds: ["zone-b"],
        upserts: [
          entity("tree-a", "tree", 2, 35.2),
          entity("stone-b", "stone", 1)
        ]
      }),
      authority
    );
    const merged = mergePopulationCollectibles(
      initial.collectibleUpserts,
      shifted.collectibleUpserts,
      shifted.removedCollectibleIds
    );

    expect([...shifted.state.activeZoneIds]).toEqual(["zone-a", "zone-b"]);
    expect(merged.map((node) => node.id)).toEqual(["tree-a"]);
    expect(merged[0]?.lat).toBe(35.2);
    expect(shifted.state.entities.has("stone-b")).toBe(true);
  });

  it("retains four-zone authority across a partial same-location operation advance", () => {
    const zones = ["zone-a", "zone-b", "zone-c", "zone-d"];
    const initial = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: zones,
        zoneSnapshots: zones.map((zoneId, index) =>
          zoneSnapshot(zoneId, "generation-a", [`tree-${index}`])
        ),
        upserts: zones.map((zoneId, index) =>
          entity(
            `tree-${index}`,
            "tree",
            1,
            35 + index / 100,
            zoneId,
            "generation-a"
          )
        )
      }),
      authority
    );
    const nextAuthority = {
      ...authority,
      resourceVisionRevision: authority.resourceVisionRevision + 1
    };
    const partial = applyPopulationZoneDelta(
      initial.state,
      delta({
        ...nextAuthority,
        preparationGeneration: operation.preparationGeneration + 1,
        retainedZoneIds: ["zone-a"],
        zoneSnapshots: [
          zoneSnapshot("zone-a", "generation-a", ["tree-0"])
        ],
        upserts: [
          entity("tree-0", "tree", 2, 35, "zone-a", "generation-a")
        ],
        visibleZoneCount: 4,
        readyVisibleZoneCount: 1,
        preparationResult: "pending",
        partial: true,
        terminal: false
      }),
      authority
    );

    expect(partial.replacesProjection).toBe(false);
    expect([...partial.state.entities.keys()].sort()).toEqual([
      "tree-0",
      "tree-1",
      "tree-2",
      "tree-3"
    ]);

    const terminal = applyPopulationZoneDelta(
      partial.state,
      delta({
        ...nextAuthority,
        preparationGeneration: operation.preparationGeneration + 1,
        retainedZoneIds: zones,
        zoneSnapshots: zones.map((zoneId, index) =>
          zoneSnapshot(zoneId, "generation-a", [`tree-${index}`])
        ),
        upserts: zones.slice(1).map((zoneId, index) =>
          entity(
            `tree-${index + 1}`,
            "tree",
            1,
            35 + (index + 1) / 100,
            zoneId,
            "generation-a"
          )
        ),
        visibleZoneCount: 4,
        readyVisibleZoneCount: 4,
        preparationResult: "ready",
        partial: false,
        terminal: true
      }),
      authority
    );

    expect([...terminal.state.entities.keys()].sort()).toEqual([
      "tree-0",
      "tree-1",
      "tree-2",
      "tree-3"
    ]);
  });

  it("reports completed and total visible-zone preparation progress", () => {
    const partial = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        visibleZoneCount: 4,
        readyVisibleZoneCount: 1,
        preparationResult: "pending",
        partial: true,
        terminal: false
      }),
      authority
    );
    expect(partial.preparationProgress).toEqual({
      completed: 1,
      total: 4,
      status: "pending",
      reason: "durable-rehydration",
      operation
    });

    const ready = applyPopulationZoneDelta(
      partial.state,
      delta({
        visibleZoneCount: 4,
        readyVisibleZoneCount: 4,
        preparationResult: "ready",
        partial: false,
        terminal: true
      }),
      authority
    );
    expect(ready.preparationProgress).toEqual({
      completed: 4,
      total: 4,
      status: "ready",
      reason: "durable-rehydration",
      operation
    });

    const stale = applyPopulationZoneDelta(
      ready.state,
      delta({
        relocationRevision: authority.relocationRevision - 1,
        visibleZoneCount: 5,
        readyVisibleZoneCount: 2,
        preparationResult: "pending",
        partial: true,
        terminal: false
      }),
      authority
    );
    expect(stale.accepted).toBe(false);
    expect(stale.preparationProgress).toEqual(ready.preparationProgress);

    const failed = applyPopulationZoneDelta(
      ready.state,
      delta({
        visibleZoneCount: 4,
        readyVisibleZoneCount: 2,
        preparationResult: "retryable-failure"
      }),
      authority
    );
    expect(failed.preparationProgress).toEqual({
      completed: 2,
      total: 4,
      status: "failed",
      reason: "durable-rehydration",
      operation
    });
  });

  it("does not invent pending progress for an already warm visible footprint", () => {
    const warm = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        visibleZoneCount: 3,
        readyVisibleZoneCount: 3,
        preparationResult: "ready",
        partial: false,
        terminal: true
      }),
      authority
    );

    expect(warm.preparationProgress).toEqual({
      completed: 3,
      total: 3,
      status: "ready",
      reason: "durable-rehydration",
      operation
    });
  });

  it("treats a degraded terminal as usable while withholding every bad-zone entity", () => {
    const initial = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: ["zone-bad"],
        visibleZoneCount: 1,
        readyVisibleZoneCount: 1,
        zoneSnapshots: [zoneSnapshot(
          "zone-bad",
          "generation-old",
          ["tree-old"]
        )],
        upserts: [entity(
          "tree-old",
          "tree",
          1,
          35,
          "zone-bad",
          "generation-old"
        )]
      }),
      authority
    );
    expect(initial.state.entities.has("tree-old")).toBe(true);

    const degraded = applyPopulationZoneDelta(
      initial.state,
      delta({
        retainedZoneIds: [],
        activatedZoneIds: [],
        releasedZoneIds: ["zone-bad"],
        withheldZoneIds: ["zone-bad"],
        visibleZoneCount: 2,
        readyVisibleZoneCount: 1,
        zoneSnapshots: [zoneSnapshot(
          "zone-bad",
          "generation-stale",
          ["tree-stale"]
        )],
        upserts: [entity(
          "tree-stale",
          "tree",
          2,
          35,
          "zone-bad",
          "generation-stale"
        )],
        preparationResult: "degraded",
        partial: false,
        terminal: true
      }),
      authority
    );

    expect(degraded.preparationProgress).toMatchObject({
      completed: 1,
      total: 2,
      status: "degraded"
    });
    expect(degraded.state.activeZoneIds.has("zone-bad")).toBe(false);
    expect(degraded.state.zoneAuthorities.has("zone-bad")).toBe(false);
    expect(degraded.state.entities.has("tree-old")).toBe(false);
    expect(degraded.state.entities.has("tree-stale")).toBe(false);
  });

  it("lets exact late recovery supersede a coalesced degraded release", () => {
    const coalesced = coalescePopulationZoneDeltas([
      delta({
        releasedZoneIds: ["zone-bad"],
        withheldZoneIds: ["zone-bad"],
        visibleZoneCount: 2,
        readyVisibleZoneCount: 1,
        preparationResult: "degraded",
        terminal: true
      }),
      delta({
        retainedZoneIds: ["zone-bad"],
        withheldZoneIds: [],
        visibleZoneCount: 2,
        readyVisibleZoneCount: 2,
        zoneSnapshots: [zoneSnapshot(
          "zone-bad",
          "generation-current",
          ["tree-current"]
        )],
        upserts: [entity(
          "tree-current",
          "tree",
          1,
          35,
          "zone-bad",
          "generation-current"
        )],
        preparationResult: "ready",
        terminal: true
      })
    ]);

    expect(coalesced.releasedZoneIds).toEqual([]);
    expect(coalesced.retainedZoneIds).toContain("zone-bad");
    expect(coalesced.withheldZoneIds).toEqual([]);
    expect(coalesced.zoneSnapshots).toContainEqual(
      expect.objectContaining({ zoneId: "zone-bad" })
    );
  });

  it("ignores optional neighbor failure for player-facing progress", () => {
    const required = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        visibleZoneCount: 4,
        readyVisibleZoneCount: 2,
        preparationResult: "pending",
        partial: true,
        terminal: false
      }),
      authority
    );
    const optionalFailure = applyPopulationZoneDelta(
      required.state,
      delta({
        preparationGeneration: 8,
        preparationScope: "neighbor-preload",
        requiredForGameplay: false,
        visibleZoneCount: 0,
        readyVisibleZoneCount: 0,
        backgroundZoneCount: 3,
        readyBackgroundZoneCount: 1,
        preparationResult: "retryable-failure"
      }),
      authority
    );

    expect(optionalFailure.accepted).toBe(true);
    expect(optionalFailure.preparationProgress)
      .toEqual(required.preparationProgress);
  });

  it.each(["stale", "cancelled"] as const)(
    "clears pending preparation after an authoritative %s terminal",
    (preparationResult) => {
      const pending = applyPopulationZoneDelta(
        emptyPopulationZoneProjection(),
        delta({
          visibleZoneCount: 4,
          readyVisibleZoneCount: 2,
          preparationResult: "pending",
          partial: true,
          terminal: false
        }),
        authority
      );
      const terminal = applyPopulationZoneDelta(
        pending.state,
        delta({
          preparationResult,
          partial: false,
          terminal: true
        }),
        authority
      );

      expect(terminal.preparationProgress).toEqual({
        completed: 0,
        total: 0,
        status: "idle",
        reason: null,
        operation: null
      });
    }
  );

  it("fences older preparation generations and replaced connections", () => {
    const current = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        connectionId: "connection-2",
        connectionGeneration: 2,
        preparationGeneration: 12,
        visibleZoneCount: 4,
        readyVisibleZoneCount: 2,
        preparationResult: "pending",
        partial: true,
        terminal: false
      }),
      authority
    );
    const olderOperation = applyPopulationZoneDelta(
      current.state,
      delta({
        connectionId: "connection-2",
        connectionGeneration: 2,
        preparationGeneration: 11,
        preparationResult: "retryable-failure"
      }),
      authority
    );
    const replacedConnection = applyPopulationZoneDelta(
      current.state,
      delta({
        connectionId: "connection-1",
        connectionGeneration: 1,
        preparationGeneration: 99,
        preparationResult: "retryable-failure"
      }),
      authority
    );

    expect(olderOperation.accepted).toBe(false);
    expect(replacedConnection.accepted).toBe(false);
    expect(olderOperation.preparationProgress.status).toBe("pending");
    expect(replacedConnection.preparationProgress.status).toBe("pending");
  });

  it("does not route mob or unknown removals through collectible ownership", () => {
    const legacy = collectible("legacy-tree");
    const withMob = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: ["zone-a"],
        upserts: [entity("wolf-a", "wolf", 1)]
      }),
      authority
    );
    const removed = applyPopulationZoneDelta(
      withMob.state,
      delta({ removedEntityIds: ["wolf-a", "unknown-entity"] }),
      authority
    );

    expect([...removed.removedCollectibleIds]).toEqual([]);
    expect(mergePopulationCollectibles([legacy], [], removed.removedCollectibleIds))
      .toEqual([legacy]);
  });

  it("removes only authoritative projected resources and ignores older upserts", () => {
    const initial = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: ["zone-a"],
        upserts: [
          entity("tree-a", "tree", 3),
          entity("stone-a", "stone", 2)
        ]
      }),
      authority
    );
    const older = applyPopulationZoneDelta(
      initial.state,
      delta({
        zoneSnapshots: [
          zoneSnapshot("zone-a", "generation-a", ["tree-a", "stone-a"])
        ],
        upserts: [entity("tree-a", "tree", 2, 40)]
      }),
      authority
    );
    const removed = applyPopulationZoneDelta(
      older.state,
      delta({
        retainedZoneIds: ["zone-a"],
        removedEntityIds: ["stone-a"]
      }),
      authority
    );
    const merged = mergePopulationCollectibles(
      initial.collectibleUpserts,
      older.collectibleUpserts,
      removed.removedCollectibleIds
    );

    expect(older.collectibleUpserts).toEqual([]);
    expect([...removed.removedCollectibleIds]).toEqual([]);
    expect(merged.map((node) => node.id)).toEqual(["tree-a"]);
    expect(merged[0]?.lat).toBe(35);
  });

  it("releases every entity owned by a released zone without explicit removals", () => {
    const initial = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: ["zone-a", "zone-b"],
        upserts: [
          entity("tree-a", "tree", 1, 35, "zone-a"),
          entity("tree-b", "tree", 1, 36, "zone-b")
        ]
      }),
      authority
    );
    const shifted = applyPopulationZoneDelta(
      initial.state,
      delta({
        retainedZoneIds: ["zone-b"],
        activatedZoneIds: ["zone-c"],
        releasedZoneIds: ["zone-a"]
      }),
      authority
    );

    expect([...shifted.state.activeZoneIds]).toEqual(["zone-b", "zone-c"]);
    expect(shifted.state.entities.has("tree-a")).toBe(false);
    expect(shifted.state.entities.has("tree-b")).toBe(true);
    expect([...shifted.removedCollectibleIds]).toEqual(["tree-a"]);
  });

  it("removes entities omitted from a complete same-generation snapshot", () => {
    const initial = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: ["zone-a"],
        upserts: [
          entity("tree-a", "tree", 1),
          entity("tree-b", "tree", 1)
        ]
      }),
      authority
    );
    const corrected = applyPopulationZoneDelta(
      initial.state,
      delta({
        retainedZoneIds: ["zone-a"],
        zoneSnapshots: [
          zoneSnapshot("zone-a", "generation-a", ["tree-b"])
        ]
      }),
      authority
    );

    expect([...corrected.state.entities.keys()]).toEqual(["tree-b"]);
    expect([...corrected.removedCollectibleIds]).toEqual(["tree-a"]);
  });

  it("replaces non-stone authority when a zone generation changes", () => {
    const initial = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: ["zone-a"],
        upserts: [
          entity("old-tree", "tree", 1),
          entity("stone-a", "stone", 1)
        ]
      }),
      authority
    );
    const replacement = applyPopulationZoneDelta(
      initial.state,
      delta({
        retainedZoneIds: ["zone-a"],
        zoneSnapshots: [
          zoneSnapshot(
            "zone-a",
            "generation-b",
            ["old-tree", "new-tree", "stone-a"]
          )
        ],
        upserts: [
          entity("old-tree", "tree", 2, 40, "zone-a", "generation-a"),
          entity("new-tree", "tree", 1, 36, "zone-a", "generation-b")
        ]
      }),
      authority
    );

    expect([...replacement.state.entities.keys()].sort()).toEqual([
      "new-tree",
      "stone-a"
    ]);
    expect(replacement.state.zoneAuthorities.get("zone-a")?.generationId)
      .toBe("generation-b");
    expect([...replacement.removedCollectibleIds]).toEqual(["old-tree"]);
  });

  it("does not grow after twenty repetitions of one authoritative snapshot", () => {
    let state = emptyPopulationZoneProjection();
    let collectibles: CollectibleNode[] = [];
    const repeated = delta({
      activatedZoneIds: ["zone-a"],
      upserts: [
        entity("tree-a", "tree", 1),
        entity("tree-b", "tree", 1)
      ]
    });

    for (let visit = 0; visit < 20; visit += 1) {
      const result = applyPopulationZoneDelta(state, repeated, authority);
      state = result.state;
      collectibles = mergePopulationCollectibles(
        collectibles,
        result.collectibleUpserts,
        result.removedCollectibleIds
      );
    }

    expect([...state.entities.keys()]).toEqual(["tree-a", "tree-b"]);
    expect(collectibles.map((node) => node.id)).toEqual(["tree-a", "tree-b"]);
  });

  it("replaces the same generation exactly after twenty away-and-back trips", () => {
    let state = emptyPopulationZoneProjection();
    let collectibles: CollectibleNode[] = [];
    const home = delta({
      activatedZoneIds: ["zone-a"],
      zoneSnapshots: [
        zoneSnapshot("zone-a", "generation-a", ["tree-a", "tree-b"])
      ],
      upserts: [
        entity("tree-a", "tree", 1),
        entity("tree-b", "tree", 1)
      ]
    });

    for (let visit = 0; visit < 20; visit += 1) {
      const away = applyPopulationZoneDelta(state, delta({
        releasedZoneIds: ["zone-a"]
      }), authority);
      state = away.state;
      collectibles = mergePopulationCollectibles(
        collectibles,
        away.collectibleUpserts,
        away.removedCollectibleIds
      );
      expect(state.entities.size).toBe(0);

      const returned = applyPopulationZoneDelta(state, home, authority);
      state = returned.state;
      collectibles = mergePopulationCollectibles(
        collectibles,
        returned.collectibleUpserts,
        returned.removedCollectibleIds
      );
      expect([...state.entities.keys()]).toEqual(["tree-a", "tree-b"]);
      expect(state.zoneAuthorities.get("zone-a")?.generationId)
        .toBe("generation-a");
      expect(collectibles.map((node) => node.id))
        .toEqual(["tree-a", "tree-b"]);
    }

    expect(state.entities.size).toBe(2);
    expect(collectibles).toHaveLength(2);
  });

  it("does not let direct snapshot omission remove retained population entities", () => {
    const projection = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: ["zone-a"],
        upserts: [entity("tree-a", "tree", 1)]
      }),
      authority
    );
    const retainedTree = projection.collectibleUpserts[0]!;
    const refreshedLegacy = {
      ...collectible("legacy-tree"),
      lat: 36
    };

    expect(mergeCollectibleSnapshotWithPopulation(
      [retainedTree, collectible("legacy-tree"), collectible("stale-legacy")],
      [refreshedLegacy, collectible("new-legacy")],
      projection.state
    )).toEqual([
      retainedTree,
      refreshedLegacy,
      collectible("new-legacy")
    ]);
  });

  it("blocks stale resurrection after removal and permits a newer respawn", () => {
    const initial = applyPopulationZoneDelta(
      emptyPopulationZoneProjection(),
      delta({
        activatedZoneIds: ["zone-a"],
        upserts: [entity("tree-a", "tree", 4)]
      }),
      authority
    );
    const removed = removePopulationCollectible(initial.state, "tree-a");
    let stale = removed;
    for (let frame = 0; frame < 20; frame += 1) {
      const result = applyPopulationZoneDelta(
        stale,
        delta({
          upserts: [
            entity("tree-a", "tree", 4),
            entity(`unrelated-${frame}`, "deer", 1)
          ]
        }),
        authority
      );
      expect(result.collectibleUpserts).toEqual([]);
      stale = result.state;
    }
    expect(mergeCollectibleSnapshotWithPopulation(
      initial.collectibleUpserts,
      [collectible("tree-a")],
      stale
    )).toEqual([]);

    const respawn = applyPopulationZoneDelta(
      stale,
      delta({ upserts: [entity("tree-a", "tree", 5)] }),
      authority
    );
    expect(respawn.collectibleUpserts.map((node) => node.id)).toEqual(["tree-a"]);
    expect(respawn.state.collectibleTombstones.has("tree-a")).toBe(false);
  });
});

const authority = {
  playerId: "player-1",
  relocationRevision: 7,
  resourceVisionRevision: 9
} as const;

const operation = {
  playerId: authority.playerId,
  connectionId: "connection-1",
  connectionGeneration: 1,
  preparationGeneration: 7,
  trigger: "flag-placement",
  scope: "required-visible",
  requiredForGameplay: true,
  relocationRevision: authority.relocationRevision,
  resourceVisionRevision: authority.resourceVisionRevision,
  gameplayViewGeneration: 11
} as const;

function delta(
  overrides: Partial<PopulationZoneDelta> = {}
): PopulationZoneDelta {
  const upserts = overrides.upserts ?? [];
  const snapshotsByZone = new Map<string, {
    generationId: string | null;
    entityIds: string[];
  }>();
  for (const entity of upserts) {
    const snapshot = snapshotsByZone.get(entity.zoneId) ?? {
      generationId: entity.kind === "stone" ? null : entity.generationId,
      entityIds: []
    };
    if (entity.kind !== "stone") snapshot.generationId = entity.generationId;
    snapshot.entityIds.push(entity.entityId);
    snapshotsByZone.set(entity.zoneId, snapshot);
  }
  return {
    type: "POPULATION_ZONE_DELTA",
    connectionId: operation.connectionId,
    connectionGeneration: operation.connectionGeneration,
    preparationGeneration: operation.preparationGeneration,
    preparationTrigger: operation.trigger,
    preparationScope: operation.scope,
    requiredForGameplay: operation.requiredForGameplay,
    gameplayViewGeneration: operation.gameplayViewGeneration,
    ...authority,
    retainedZoneIds: [],
    activatedZoneIds: [],
    releasedZoneIds: [],
    withheldZoneIds: [],
    upserts,
    removedEntityIds: [],
    visibleZoneCount: 0,
    readyVisibleZoneCount: 0,
    backgroundZoneCount: 0,
    readyBackgroundZoneCount: 0,
    zoneSnapshots: [...snapshotsByZone].map(([zoneId, snapshot]) =>
      zoneSnapshot(zoneId, snapshot.generationId, snapshot.entityIds)
    ),
    preparationReason: "durable-rehydration",
    preparationResult: "ready",
    partial: false,
    terminal: true,
    ...overrides
  };
}

function entity(
  entityId: string,
  kind: PopulationZoneEntitySnapshot["kind"],
  stateRevision: number,
  lat = 35,
  zoneId = "zone-a",
  generationId = kind === "stone" ? null : "generation-a"
): PopulationZoneEntitySnapshot {
  return {
    entityId,
    zoneId,
    generationId,
    kind,
    archetype: `${kind}-default`,
    position: { lat, lon: -106 },
    homePosition: { lat, lon: -106 },
    stateRevision
  };
}

function zoneSnapshot(
  zoneId: string,
  generationId: string | null,
  entityIds: string[]
): PopulationZoneDelta["zoneSnapshots"][number] {
  return { zoneId, generationId, entityIds };
}

function collectible(id: string): CollectibleNode {
  return {
    id,
    type: "wood",
    lat: 35,
    lon: -106,
    quantity: 1,
    state: "available",
    createdAt: "",
    harvestedAt: null,
    sourceCellId: "legacy",
    waterKind: null
  };
}
