import {
  RESOURCE_TYPES,
  isGivingTreeResinCapable,
  treeVarietyForStableId,
  distanceMeters,
  type CollectibleNode,
  type HarvestSessionSnapshot,
  type PlayerSnapshot,
  type ResourceType
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  HARVEST_RANGE_M,
  HARVEST_APPROACH_BUFFER_M,
  HARVEST_START_ACK_TIMEOUT_MS,
  advanceHarvestTask,
  advanceMineClaimApproach,
  attachHarvestSession,
  canStartHarvestInteraction,
  harvestInProgressLabel,
  collectibleDisplayName,
  collectibleQuickHarvestAction,
  harvestActionLabel,
  collectibleHarvestAvailability,
  harvestConnectionReady,
  correlateQueuedHarvestCompletionRequest,
  getClosestHarvestApproachPoint,
  getClosestReachableHarvestApproachPoint,
  gatheringProgressForTask,
  planHarvestCancellation,
  planMineClaim,
  queueHarvestReplacement,
  replayPendingHarvestCompletion,
  resourceDisplayName,
  resolveActiveHarvestCollectible,
  resumeHarvestTask,
  setCollectibleResinAvailability,
  startHarvestTask,
  type HarvestTask,
  type PendingMineClaim
} from "./harvest.js";
import { collectibleArtworkKey } from "../map/pixiOverlay.js";

describe("collectible harvesting", () => {
  it("gathers fruit from quick actions while detail chopping and plain trees retain primary harvest", () => {
    const fruiting = { ...collectible("wood", 0), berryAvailable: true };
    const quickAction = collectibleQuickHarvestAction(fruiting);
    expect(startHarvestTask(player(0), fruiting, quickAction).action).toBe("resin");
    expect(harvestActionLabel(fruiting, quickAction)).toBe("Gather");
    expect(startHarvestTask(player(0), fruiting).action).toBe("primary");
    expect(harvestActionLabel(fruiting)).toBe("Chop");
    const plain = { ...fruiting, berryAvailable: false };
    expect(collectibleQuickHarvestAction(plain)).toBe("primary");
    expect(harvestActionLabel(plain, collectibleQuickHarvestAction(plain))).toBe("Chop");
    expect(collectibleQuickHarvestAction(collectible("stone", 0))).toBe("primary");
  });

  it("taps a Elder Fern with sap and chops it once tapped", () => {
    const fern = { ...collectible("wood", 0), id: "node-wood", berryAvailable: false, sapReadyAt: null };
    expect(collectibleQuickHarvestAction(fern)).toBe("resin");
    expect(collectibleDisplayName(fern)).toBe("Elder Fern (Sap)");
    expect(harvestInProgressLabel(fern, "resin")).toBe("Tapping Frond Sap");
    const tapped = { ...fern, sapReadyAt: new Date(Date.now() + 60_000).toISOString() };
    expect(collectibleQuickHarvestAction(tapped)).toBe("primary");
    expect(collectibleDisplayName(tapped)).toBe("Elder Fern (Tapped)");
    const refilled = { ...fern, sapReadyAt: new Date(Date.now() - 1).toISOString() };
    expect(collectibleQuickHarvestAction(refilled)).toBe("resin");
    // Berry flags never make a fern fruit.
    expect(collectibleQuickHarvestAction({ ...tapped, berryAvailable: true })).toBe("primary");
  });

  it("labels mined iron as ore while keeping the node named Iron Mine", () => {
    const node = {
      ...collectible("iron", 0),
      repeatableNodeType: "iron_mine" as const
    };

    expect(resourceDisplayName("iron")).toBe("Iron Ore");
    expect(collectibleDisplayName(node)).toBe("Iron Mine");
  });

  it("labels the processed crab material and legacy shell distinctly", () => {
    expect(resourceDisplayName("chitin")).toBe("Chitin");
    expect(resourceDisplayName("shell")).toBe("Shell (Legacy)");
  });

  it("labels each deterministic tree variety", () => {
    expect(collectibleDisplayName({
      ...collectible("wood", 0),
      id: "tree-0"
    })).toBe("Giving Tree");
    expect(collectibleDisplayName({
      ...collectible("wood", 0),
      id: "tree-200"
    })).toBe("Willow Tree");
    expect(collectibleDisplayName({
      ...collectible("wood", 0),
      id: "tree-204"
    })).toBe("Chinese Pistache");
  });

  it("starts in range and completes only from the authoritative server deadline", () => {
    const node = collectible("wood", 0);
    const starting = startHarvestTask(player(0), node, "primary", 1_000);

    expect(HARVEST_RANGE_M).toBe(50);
    expect(starting.phase).toBe("starting");
    expect(advanceHarvestTask(starting, player(0), node, 3_999).shouldComplete).toBe(
      false
    );

    const task = attachHarvestSession(starting, session(node, 4_000), 1_000, 1_000);
    expect(task.phase).toBe("harvesting");
    expect(advanceHarvestTask(task, player(0), node, 3_999).shouldComplete).toBe(false);

    const completed = advanceHarvestTask(task, player(0), node, 4_000);
    expect(completed.task?.phase).toBe("harvesting");
    expect(completed.shouldComplete).toBe(true);
    expect(gatheringProgressForTask(task, node, 2_500)).toEqual({
      nodeId: node.id,
      label: "Chopping",
      progress: 0.5,
      remainingMs: 1_500
    });
  });

  it("releases a gathering start when the authoritative acknowledgement never arrives", () => {
    const node = collectible("stone", 0);
    const starting = startHarvestTask(player(0), node, "primary", 1_000);

    expect(advanceHarvestTask(
      starting,
      player(0),
      node,
      1_000 + HARVEST_START_ACK_TIMEOUT_MS - 1
    )).toMatchObject({
      task: starting,
      cancellationReason: null
    });
    expect(advanceHarvestTask(
      starting,
      player(0),
      node,
      1_000 + HARVEST_START_ACK_TIMEOUT_MS
    )).toEqual({
      task: null,
      shouldStart: false,
      shouldComplete: false,
      resinPresentationNodeId: null,
      cancellationReason: "start-timeout"
    });
  });

  it("keeps fruiting artwork through one millisecond before the authoritative deadline", () => {
    const tree = {
      ...collectible("wood", 0),
      resinAvailable: false,
      berryAvailable: true,
      treeLifeRevision: 7
    };
    const task = attachHarvestSession(
      startHarvestTask(player(0), tree, "resin"),
      session(tree, 4_000),
      1_000,
      1_000
    );
    const transition = advanceHarvestTask(task, player(0), tree, 3_999);
    const rendered = transition.resinPresentationNodeId
      ? setCollectibleResinAvailability(
          [tree],
          transition.resinPresentationNodeId,
          false
        )
      : [tree];

    expect(transition.shouldComplete).toBe(false);
    expect(transition.resinPresentationNodeId).toBeNull();
    expect(collectibleArtworkKey(rendered[0]!)).toBe("resinTree");
  });

  it("presents the same tree without fruit at the authoritative deadline", () => {
    const tree = {
      ...collectible("wood", 0),
      resinAvailable: false,
      berryAvailable: true,
      treeLifeRevision: 7
    };
    const task = attachHarvestSession(
      startHarvestTask(player(0), tree, "resin"),
      session(tree, 4_000),
      1_000,
      1_000
    );
    const transition = advanceHarvestTask(task, player(0), tree, 4_000);
    const rendered = setCollectibleResinAvailability(
      [tree],
      transition.resinPresentationNodeId!,
      false
    );

    expect(transition.shouldComplete).toBe(true);
    expect(transition.resinPresentationNodeId).toBe(tree.id);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({
      id: tree.id,
      lat: tree.lat,
      lon: tree.lon,
      resinAvailable: false,
      berryAvailable: false,
      treeLifeRevision: 7
    });
    expect(collectibleArtworkKey(rendered[0]!)).toBe("tree");
  });

  it("depletes fruit at the authoritative deadline and resumes berries after reconnect", () => {
    const tree = { ...collectible("wood", 0),
      id: Array.from({ length: 100 }, (_, index) => `berry-test-${index}`).find((id) => treeVarietyForStableId(id) === "giving_tree" && isGivingTreeResinCapable(id))!, resinAvailable: false,
      berryAvailable: true, treeLifeRevision: 7 };
    const berrySession = { ...session(tree, 4_000), resourceType: "giving_berry" as const };
    const task = attachHarvestSession(startHarvestTask(player(0), tree, "resin"),
      berrySession, 1_000, 1_000);
    expect(task.action).toBe("resin");
    expect(collectibleArtworkKey(tree)).toBe("resinTree");
    const transition = advanceHarvestTask(task, player(0), tree, 4_000);
    const depleted = setCollectibleResinAvailability([tree], transition.resinPresentationNodeId!, false)[0]!;
    expect(depleted).toMatchObject({ berryAvailable: false, resinAvailable: false });
    expect(collectibleArtworkKey(depleted)).toBe("tree");
    expect(setCollectibleResinAvailability([depleted], tree.id, true)[0]!.berryAvailable).toBe(true);
  });

  it("associates server-confirmed mining progress only with the active task mine", () => {
    const mine = {
      ...collectible("stone", 0),
      repeatableNodeType: "stone_mine" as const,
      repeatableState: "ready" as const,
      repeatableReadyAt: null
    };
    const task = attachHarvestSession(
      startHarvestTask(player(0), mine),
      session(mine, 11_000),
      1_000,
      1_000
    );
    expect(gatheringProgressForTask(task, mine, 6_000)).toMatchObject({
      nodeId: mine.id,
      label: "Mining",
      progress: 0.5,
      remainingMs: 5_000
    });
    expect(gatheringProgressForTask(task, collectible("wood", 0), 6_000)).toBeNull();
  });

  it("resolves the active task node independently from inspection selection", () => {
    const treeA = collectible("wood", 0);
    const mineB = {
      ...collectible("stone", 20),
      id: "mine-b",
      repeatableNodeType: "stone_mine" as const,
      repeatableState: "ready" as const
    };
    const taskA = startHarvestTask(player(0), treeA);

    expect(resolveActiveHarvestCollectible(taskA, [treeA, mineB])).toBe(treeA);
    expect(collectibleHarvestAvailability(mineB, taskA, true)).toEqual({
      enabled: true,
      disabledReason: null
    });
    expect(collectibleHarvestAvailability(treeA, taskA, true)).toEqual({
      enabled: false,
      disabledReason: "Finish the current gathering action first."
    });
    expect(collectibleHarvestAvailability(mineB, null, true)).toEqual({
      enabled: true,
      disabledReason: null
    });
    expect(collectibleHarvestAvailability(mineB, null, true, {
      sessionId: "11111111-1111-4111-8111-111111111111",
      requestId: "pending-completion",
      nodeId: treeA.id,
      lastAttemptAtMs: 0
    })).toEqual({
      enabled: true,
      disabledReason: null
    });
  });

  it("replaces only the queued target while preserving source correlation", () => {
    const source = startHarvestTask(player(0), collectible("wood", 0), "primary", 1_000);
    const first = queueHarvestReplacement(
      null,
      source,
      null,
      "source-request",
      "node-stone",
      "primary"
    );
    const replaced = queueHarvestReplacement(
      first,
      source,
      null,
      "unrelated-request",
      "node-ore",
      "resin"
    );

    expect(replaced).toEqual({
      sourceNodeId: source.nodeId,
      sourceRequestId: "source-request",
      sourceSessionId: null,
      targetNodeId: "node-ore",
      targetAction: "resin"
    });
  });

  it("captures the exact repeatable completion request for a queued source", () => {
    const source: HarvestTask = {
      ...startHarvestTask(player(0), collectible("stone", 0)),
      phase: "completing",
      sessionId: "session-source"
    };
    const queued = queueHarvestReplacement(
      null,
      source,
      null,
      null,
      "node-wood",
      "primary"
    );

    expect(correlateQueuedHarvestCompletionRequest(
      queued,
      source,
      null,
      "complete-source"
    )).toEqual(expect.objectContaining({
      sourceNodeId: source.nodeId,
      sourceSessionId: "session-source",
      sourceRequestId: "complete-source"
    }));
  });

  it("approaches distant nodes, requests a session in range, and cancels when leaving", () => {
    const node = collectible("stone", 300);
    const approaching = startHarvestTask(player(0), node);
    expect(approaching.phase).toBe("approaching");

    const enteredRange = advanceHarvestTask(approaching, player(255), node, 2_000);
    expect(enteredRange.task?.phase).toBe("starting");
    expect(enteredRange.task?.startRequestedAtMs).toBe(2_000);
    expect(enteredRange.shouldStart).toBe(true);

    const active = attachHarvestSession(
      enteredRange.task!,
      session(node, 12_000),
      2_000,
      2_000
    );
    const cancelled = advanceHarvestTask(active, player(0), node, 2_500);
    expect(cancelled.task).toBeNull();
    expect(cancelled.cancellationReason).toBe("out-of-range");
  });

  it("sends at most one cancellation and never cancels completion", () => {
    const node = collectible("wood", 0);
    let task: ReturnType<typeof attachHarvestSession> | null =
      attachHarvestSession(
        startHarvestTask(player(0), node),
        session(node, 4_000),
        1_000,
        1_000
      );
    const sentSessionIds: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cancellation = planHarvestCancellation(task, true);
      if (cancellation?.sessionId) {
        sentSessionIds.push(cancellation.sessionId);
      }
      task = null;
    }
    expect(sentSessionIds).toEqual([
      "11111111-1111-4111-8111-111111111111"
    ]);
    expect(planHarvestCancellation(null, true)).toBeNull();
    expect(planHarvestCancellation({
      nodeId: node.id,
      action: "primary",
      phase: "completing",
      sessionId: sentSessionIds[0]!,
      completesAtMs: 4_000,
      startedAtMs: 1_000,
      startRequestedAtMs: null
    }, true)).toBeNull();
    expect(canStartHarvestInteraction(null, {
      sessionId: sentSessionIds[0]!,
      requestId: "completion-request",
      nodeId: node.id,
      lastAttemptAtMs: 0
    })).toBe(false);
    expect(canStartHarvestInteraction(null, null)).toBe(true);
  });

  it("retains transient completion failures, bounds retries, and re-correlates after welcome", () => {
    const pendingCompletionRef = {
      current: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        requestId: "completion-before-disconnect",
        nodeId: "tree-1",
        lastAttemptAtMs: 0
      }
    };
    const requestSentRef = {
      current: "completion-before-disconnect" as string | null
    };
    let replayedSessionId: string | null = null;

    expect(replayPendingHarvestCompletion(
      pendingCompletionRef,
      requestSentRef,
      (sessionId) => {
        replayedSessionId = sessionId;
        return {
          requestId: "completion-after-welcome",
          outcome: { status: "sent" }
        };
      },
      1_000,
      true
    )).toBe("sent");
    expect(replayedSessionId).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    expect(pendingCompletionRef.current).toEqual({
      sessionId: "11111111-1111-4111-8111-111111111111",
      requestId: "completion-after-welcome",
      nodeId: "tree-1",
      lastAttemptAtMs: 1_000
    });
    expect(requestSentRef.current).toBe("completion-after-welcome");

    expect(replayPendingHarvestCompletion(
      pendingCompletionRef,
      requestSentRef,
      () => ({
        requestId: "closed-replay",
        outcome: { status: "connecting" }
      }),
      2_000,
      true
    )).toBe("retained");
    expect(pendingCompletionRef.current).toMatchObject({
      requestId: null,
      lastAttemptAtMs: 2_000
    });
    const send = vi.fn(() => ({
      requestId: "bounded-retry",
      outcome: { status: "sent" }
    }));
    expect(replayPendingHarvestCompletion(
      pendingCompletionRef,
      requestSentRef,
      send,
      2_500
    )).toBe("retained");
    expect(send).not.toHaveBeenCalled();
    expect(replayPendingHarvestCompletion(
      pendingCompletionRef,
      requestSentRef,
      send,
      4_000
    )).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
    expect(replayPendingHarvestCompletion(
      pendingCompletionRef,
      requestSentRef,
      () => ({
        requestId: "terminal-replay",
        outcome: { status: "protocol-incompatible" }
      }),
      5_000,
      true
    )).toBe("released");
    expect(pendingCompletionRef.current).toBeNull();
    expect(requestSentRef.current).toBeNull();
    expect(canStartHarvestInteraction(null, pendingCompletionRef.current))
      .toBe(true);
  });

  it("resumes an active durable server session", () => {
    const node = collectible("food", 0);
    const resumed = resumeHarvestTask(session(node, 8_000), 2_000, 2_000);

    expect(resumed).toMatchObject({
      nodeId: node.id,
      phase: "harvesting",
      sessionId: "11111111-1111-4111-8111-111111111111",
      completesAtMs: 8_000
    });
  });

  it("starts at the node radius edge instead of requiring the node center", () => {
    const node = collectible("food", 300);

    expect(startHarvestTask(player(251), node).phase).toBe("starting");
    expect(startHarvestTask(player(249), node).phase).toBe("approaching");
  });

  it("uses the same center-based harvest radius for every resource type", () => {
    for (const resourceType of RESOURCE_TYPES) {
      const node = collectible(resourceType, 100);
      expect(startHarvestTask(player(51), node).phase).toBe("starting");
      expect(startHarvestTask(player(49), node).phase).toBe("approaching");

      const approachPoint = getClosestHarvestApproachPoint(player(0), {
        lat: node.lat,
        lon: node.lon
      });
      expect(approachPoint).not.toBeNull();
      expect(distanceMeters(node, approachPoint!)).toBeCloseTo(45, 0);
    }
  });

  it("approaches the nearest buffered point inside the node radius", () => {
    const playerPosition = player(0);
    const node = collectible("ore", 400);
    const nodePosition = { lat: node.lat, lon: node.lon };
    const approachPoint = getClosestHarvestApproachPoint(playerPosition, nodePosition);

    expect(HARVEST_APPROACH_BUFFER_M).toBe(5);
    expect(approachPoint).not.toBeNull();
    expect(distanceMeters(nodePosition, approachPoint!)).toBeCloseTo(45, 0);
    expect(distanceMeters(playerPosition, approachPoint!)).toBeLessThan(
      distanceMeters(playerPosition, nodePosition)
    );
  });

  it("uses the same buffered boundary from cardinal and diagonal approaches", () => {
    const nodePosition = { lat: 35, lon: -106 };
    const bearings = [0, 45, 90, 135, 180, 225, 270, 315];

    for (const bearing of bearings) {
      const playerPosition = destinationPoint(nodePosition, 300, bearing);
      const approachPoint = getClosestHarvestApproachPoint(playerPosition, nodePosition);

      expect(approachPoint).not.toBeNull();
      expect(distanceMeters(nodePosition, approachPoint!)).toBeCloseTo(45, 2);
      expect(distanceMeters(playerPosition, approachPoint!)).toBeCloseTo(255, 1);
    }
  });

  it("does not create an approach target when already in range", () => {
    const node = collectible("wood", 200);

    expect(
      getClosestHarvestApproachPoint(player(160), { lat: node.lat, lon: node.lon })
    ).toBeNull();
  });

  it("keeps an off-center edge-tree approach inside the movement leash", () => {
    const anchor = { lat: 35.0844, lon: -106.6504 };
    const edgePlayer = playerAt(
      destinationPoint(anchor, 400, 90),
      anchor,
      600
    );
    const tree = destinationPoint(anchor, 640, 0);
    const approach = getClosestReachableHarvestApproachPoint(edgePlayer, tree);

    expect(approach).not.toBeNull();
    expect(distanceMeters(anchor, approach!)).toBeLessThanOrEqual(600);
    expect(distanceMeters(tree, approach!)).toBeCloseTo(45, 2);
  });

  it("uses the full interaction radius when an edge resource leaves no buffer", () => {
    const anchor = { lat: 35.0844, lon: -106.6504 };
    const edgePlayer = playerAt(
      destinationPoint(anchor, 400, 90),
      anchor,
      600
    );
    const tree = destinationPoint(anchor, 649, 0);
    const approach = getClosestReachableHarvestApproachPoint(edgePlayer, tree);

    expect(approach).not.toBeNull();
    expect(distanceMeters(anchor, approach!)).toBeLessThanOrEqual(600);
    expect(distanceMeters(tree, approach!)).toBeCloseTo(49, 2);
  });

  it("resolves edge approaches across bearings and rejects unreachable resources", () => {
    const anchor = { lat: 35.0844, lon: -106.6504 };
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const edgePlayer = playerAt(
        destinationPoint(anchor, 400, bearing + 90),
        anchor,
        600
      );
      const tree = destinationPoint(anchor, 640, bearing);
      const approach = getClosestReachableHarvestApproachPoint(edgePlayer, tree);

      expect(approach).not.toBeNull();
      expect(distanceMeters(anchor, approach!)).toBeLessThanOrEqual(600);
      expect(distanceMeters(tree, approach!)).toBeLessThanOrEqual(HARVEST_RANGE_M);
    }

    expect(getClosestReachableHarvestApproachPoint(
      playerAt(anchor, anchor, 600),
      destinationPoint(anchor, 651, 0)
    )).toBeNull();
  });

  it("plans an in-range mine claim without movement", () => {
    const plan = planMineClaim(player(0), mine(30));

    expect(plan).toEqual({ kind: "claim-now" });
  });

  it("plans a buffered reachable mine approach", () => {
    const node = mine(300);
    const plan = planMineClaim(player(0), node);

    expect(plan.kind).toBe("approach");
    if (plan.kind === "approach") {
      expect(distanceMeters(node, plan.target)).toBeCloseTo(
        HARVEST_RANGE_M - HARVEST_APPROACH_BUFFER_M,
        0
      );
    }
  });

  it("rejects a mine approach outside the movement leash", () => {
    const anchor = { lat: 35, lon: -106 };
    const edgePlayer = playerAt(anchor, anchor, 100);

    expect(planMineClaim(edgePlayer, destinationPoint(anchor, 151, 0))).toEqual({
      kind: "unreachable"
    });
  });

  it("waits while the pending mine approach is still moving", () => {
    const pending = pendingMineClaim();
    const node = mine(300);

    expect(advanceMineClaimApproach({
      pending,
      node,
      player: { ...player(200), moving: true },
      movement: movementRequest(),
      connectionGeneration: pending.connectionGeneration
    })).toBe("waiting");
  });

  it("claims only after a newer stopped snapshot reaches the mine", () => {
    const pending = pendingMineClaim();
    const node = mine(300);

    expect(advanceMineClaimApproach({
      pending,
      node,
      player: { ...player(255), movementRevision: pending.movementRevision + 1 },
      movement: movementRequest(),
      connectionGeneration: pending.connectionGeneration
    })).toBe("claim");
  });

  it("cancels a pending mine claim when target or authority changes", () => {
    const pending = pendingMineClaim();
    const base = {
      pending,
      player: { ...player(255), movementRevision: pending.movementRevision + 1 },
      movement: movementRequest(),
      connectionGeneration: pending.connectionGeneration
    };

    expect(advanceMineClaimApproach({ ...base, node: mine(300, 8) })).toBe("cancel");
    expect(advanceMineClaimApproach({
      ...base,
      node: { ...mine(300), id: "other-mine" }
    })).toBe("cancel");
    expect(advanceMineClaimApproach({
      ...base,
      node: { ...mine(300), repeatableOwnerPlayerId: "other-player" }
    })).toBe("cancel");
  });

  it("cancels a pending mine claim when movement, relocation, or connection authority changes", () => {
    const pending = pendingMineClaim();
    const base = {
      pending,
      node: mine(300),
      player: { ...player(255), movementRevision: pending.movementRevision + 1 },
      movement: movementRequest(),
      connectionGeneration: pending.connectionGeneration
    };

    expect(advanceMineClaimApproach({
      ...base,
      movement: { requestId: "move-2", generation: 2 }
    })).toBe("cancel");
    expect(advanceMineClaimApproach({
      ...base,
      player: {
        ...base.player,
        relocationRevision: pending.relocationRevision + 1
      }
    })).toBe("cancel");
    expect(advanceMineClaimApproach({
      ...base,
      connectionGeneration: pending.connectionGeneration + 1
    })).toBe("cancel");
  });

  it("releases a stopped mine approach that remains outside the harvest radius", () => {
    const pending = pendingMineClaim();
    const node = mine(300);

    expect(advanceMineClaimApproach({
      pending,
      node,
      player: { ...player(200), movementRevision: pending.movementRevision + 1 },
      movement: movementRequest(),
      connectionGeneration: pending.connectionGeneration
    })).toBe("unreachable");
  });
});

function playerAt(
  position: { lat: number; lon: number },
  anchor: { lat: number; lon: number },
  moveLeashRadiusM: number
): PlayerSnapshot {
  return {
    ...player(0),
    lat: position.lat,
    lon: position.lon,
    anchorLat: anchor.lat,
    anchorLon: anchor.lon,
    moveLeashRadiusM
  };
}

function player(eastM: number): PlayerSnapshot {
  return {
    playerId: "player-1",
    username: "Avery",
    displayColor: null,
    regionCode: "NM",
    zoneId: "test",
    lat: 35,
    lon: -106 + eastM / 91_188,
    anchorLat: 35,
    anchorLon: -106,
    moveLeashRadiusM: 1_000,
    movementRevision: 0,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: "2026-07-09T00:00:00.000Z"
  };
}

function collectible(type: ResourceType, eastM: number): CollectibleNode {
  return {
    // "node-wood" hashes to a Elder Fern; "node-wood-1" stays a Giving Tree.
    id: type === "wood" ? "node-wood-1" : `node-${type}`,
    type,
    lat: 35,
    lon: -106 + eastM / 91_188,
    quantity: 1,
    state: "available",
    createdAt: "2026-07-09T00:00:00.000Z",
    harvestedAt: null,
    sourceCellId: "cell-1",
    waterKind: null
  };
}

function mine(eastM: number, revision = 9): CollectibleNode {
  return {
    ...collectible("stone", eastM),
    id: "mine-1",
    repeatableNodeType: "stone_mine",
    repeatableRevision: revision,
    repeatableOwnerPlayerId: null
  };
}

function pendingMineClaim(
  overrides: Partial<PendingMineClaim> = {}
): PendingMineClaim {
  return {
    nodeId: "mine-1",
    authorityRevision: 9,
    movementRequestId: "move-1",
    movementGeneration: 1,
    movementRevision: 0,
    connectionGeneration: 7,
    relocationRevision: 0,
    ...overrides
  };
}

function movementRequest(
  overrides: Partial<{ requestId: string; generation: number }> = {}
): { requestId: string; generation: number } {
  return {
    requestId: "move-1",
    generation: 1,
    ...overrides
  };
}

function session(node: CollectibleNode, completesAtMs: number): HarvestSessionSnapshot {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    playerId: "player-1",
    nodeId: node.id,
    resourceType: node.type,
    operationKey: `collect:${node.id}:player-1`,
    status: "active",
    startedAt: new Date(1_000).toISOString(),
    completesAt: new Date(completesAtMs).toISOString(),
    expiresAt: new Date(completesAtMs + 300_000).toISOString(),
    completedAt: null,
    cancelledAt: null
  };
}

function destinationPoint(
  center: { lat: number; lon: number },
  distanceM: number,
  bearingDegrees: number
): { lat: number; lon: number } {
  const earthRadiusM = 6_371_008.8;
  const angularDistance = distanceM / earthRadiusM;
  const bearing = (bearingDegrees * Math.PI) / 180;
  const lat1 = (center.lat * Math.PI) / 180;
  const lon1 = (center.lon * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: (lat2 * 180) / Math.PI,
    lon: (lon2 * 180) / Math.PI
  };
}

describe("harvestConnectionReady", () => {
  it("needs the world player above ground", () => {
    expect(harvestConnectionReady({ connectionStatus: "online", hasWorldPlayer: false, interiorRoomLoaded: null })).toBe(false);
    expect(harvestConnectionReady({ connectionStatus: "online", hasWorldPlayer: true, interiorRoomLoaded: null })).toBe(true);
  });

  it("uses the loaded room indoors, where the world player may be absent", () => {
    expect(harvestConnectionReady({ connectionStatus: "online", hasWorldPlayer: false, interiorRoomLoaded: true })).toBe(true);
    expect(harvestConnectionReady({ connectionStatus: "online", hasWorldPlayer: true, interiorRoomLoaded: false })).toBe(false);
    expect(harvestConnectionReady({ connectionStatus: "connecting", hasWorldPlayer: true, interiorRoomLoaded: true })).toBe(false);
  });
});

describe("harvestInProgressLabel", () => {
  it("names the running action with -ing", () => {
    expect(harvestInProgressLabel({ type: "wood" })).toBe("Chopping");
    expect(harvestInProgressLabel({ type: "stone", repeatableNodeType: "stone" } as never)).toBe("Mining");
    expect(harvestInProgressLabel({ type: "stone" })).toBe("Gathering");
    expect(harvestInProgressLabel({ type: "wood" }, "resin")).toBe("Gathering Berries");
  });
});
