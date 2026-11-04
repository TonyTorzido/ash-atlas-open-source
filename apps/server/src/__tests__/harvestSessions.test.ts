import type {
  CollectibleNode,
  MasteryGrantResult,
  PlayerInventorySnapshot,
  ResourceType,
  XpGrantResult
} from "@ash-atlas/shared";
import { treeHarvestDurationMsForStableId } from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import type {
  CollectiblePlayer,
  CollectibleTransaction,
  HarvestedPopulationTreeTransition,
  HarvestableCollectibleNode
} from "../game/collectibles.js";
import {
  CollectibleHarvestError,
  collectiblePickupOperationKey
} from "../game/collectibles.js";
import {
  HARVEST_SESSION_EXPIRY_GRACE_MS,
  HarvestSessionService
} from "../game/harvestSessions.js";
import type { CreatureBookPlantHarvestInput } from "../game/creatureBook.js";
import type { ProgressionService, XpGrantInput } from "../game/progression.js";
import type { MasteryService } from "../game/masteries.js";

const PLAYER: CollectiblePlayer = {
  playerId: "player-1",
  regionCode: "NM",
  position: { lat: 35, lon: -106 }
};
const OTHER_PLAYER: CollectiblePlayer = {
  ...PLAYER,
  playerId: "player-2"
};
const VISION = {
  flagId: "flag-1",
  flagName: "Test Flag",
  center: PLAYER.position,
  movementLeashRadiusM: 900,
  paddingM: 50,
  radiusM: 950
};

describe("HarvestSessionService", () => {
  it("uses server-owned durations when starting wood and stone", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("wood-node", "wood"));
    fixture.gateway.addNode(node("stone-node", "stone"));

    const wood = await fixture.service.startHarvest(PLAYER, "wood-node", VISION);
    fixture.clock.advance(
      deadlineDuration(wood.session) + HARVEST_SESSION_EXPIRY_GRACE_MS + 1
    );
    const stone = await fixture.service.startHarvest(PLAYER, "stone-node", VISION);

    expect(deadlineDuration(wood.session)).toBe(
      treeHarvestDurationMsForStableId("wood-node")
    );
    expect(deadlineDuration(stone.session)).toBe(10_000);
  });

  it("applies the chopping ring only to primary wood harvesting", async () => {
    const woodFixture = createFixture();
    woodFixture.gateway.addNode(node("wood-node", "wood"));
    const wood = await woodFixture.service.startHarvest(
      PLAYER,
      "wood-node",
      VISION,
      "primary",
      undefined,
      1,
      0.8
    );
    expect(deadlineDuration(wood.session)).toBe(
      Math.ceil(treeHarvestDurationMsForStableId("wood-node") * 0.8)
    );

    const stoneFixture = createFixture();
    stoneFixture.gateway.addNode(node("stone-node", "stone"));
    const stone = await stoneFixture.service.startHarvest(
      PLAYER,
      "stone-node",
      VISION,
      "primary",
      undefined,
      1,
      0.8
    );
    expect(deadlineDuration(stone.session)).toBe(10_000);
  });

  it("keeps an instant mastery harvest valid for the durable session clock", async () => {
    const fixture = createFixture({ masteryRank: 3, random: () => 0 });
    fixture.gateway.addNode(node("instant-wood", "wood"));

    const started = await fixture.service.startHarvest(
      PLAYER,
      "instant-wood",
      VISION
    );

    expect(deadlineDuration(started.session)).toBe(1);
    fixture.clock.advance(1);
    await expect(fixture.service.completeHarvest(
      PLAYER,
      started.session.sessionId,
      VISION
    )).resolves.toMatchObject({
      reward: { itemId: "wood" }
    });
  });

  it("runs resin as its own 600ms harvest without removing the tree", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("resin-tree", "wood"));

    const started = await fixture.service.startHarvest(
      PLAYER,
      "resin-tree",
      VISION,
      "resin"
    );
    expect(started.session.resourceType).toBe("balsam_resin");
    expect(deadlineDuration(started.session)).toBe(600);

    fixture.clock.advance(600);
    const completed = await fixture.service.completeHarvest(
      PLAYER,
      started.session.sessionId,
      VISION
    );
    expect(completed.nodeRemoved).toBe(false);
    expect(completed.node).toMatchObject({
      id: "resin-tree",
      state: "available",
      resinAvailable: false
    });
    expect(completed.inventory.totals.balsam_resin).toBe(1);

    const replay = await fixture.service.completeHarvest(
      PLAYER,
      started.session.sessionId,
      VISION
    );
    expect(replay.replayed).toBe(true);
    expect(replay.nodeRemoved).toBe(false);
    expect(replay.populationTreeTransition).toBeNull();
    expect(replay.inventory.totals.balsam_resin).toBe(1);
  });

  it("rejects completion before the server deadline without granting", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("wood-node", "wood"));
    const started = await fixture.service.startHarvest(PLAYER, "wood-node", VISION);

    await expect(
      fixture.service.completeHarvest(PLAYER, started.session.sessionId, VISION)
    ).rejects.toMatchObject({ code: "HARVEST_TOO_EARLY" });
    expect(fixture.gateway.grantCount()).toBe(0);
    expect(fixture.gateway.inventory(PLAYER.playerId).totals.wood).toBe(0);
  });

  it("applies the Deepstone Lore extra unit and rare find rolled when the session started", async () => {
    const fixture = createFixture({ dungeonSkills: { rollHarvestBonus: async () => ({ extraUnit: true, rareItemId: "atlas_shrine_shard" }) } });
    fixture.gateway.addNode(node("stone-node", "stone", 1));
    const started = await fixture.service.startHarvest(PLAYER, "stone-node", VISION);
    fixture.clock.advance(deadlineDuration(started.session));
    await fixture.service.completeHarvest(PLAYER, started.session.sessionId, VISION);
    expect(fixture.gateway.bonusQuantities).toEqual([1]);
    expect(fixture.gateway.rareFinds).toEqual([expect.objectContaining({ playerId: PLAYER.playerId, itemId: "atlas_shrine_shard" })]);
  });

  it("completes after the deadline and grants exactly once on retries", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("wood-node", "wood", 2));
    const started = await fixture.service.startHarvest(PLAYER, "wood-node", VISION);
    fixture.clock.advance(deadlineDuration(started.session));

    const completed = await fixture.service.completeHarvest(
      PLAYER,
      started.session.sessionId,
      VISION
    );
    const replay = await fixture.service.completeHarvest(
      PLAYER,
      started.session.sessionId,
      VISION
    );

    expect(completed.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.inventory.totals.wood).toBe(2);
    expect(replay.nodePosition).toEqual({ lat: 35, lon: -106 });
    expect(replay.populationTreeTransition).toMatchObject({
      entityId: "wood-node",
      entityKind: "tree",
      stateRevision: 1,
      position: { lat: 35, lon: -106 }
    });
    expect(fixture.gateway.grantCount()).toBe(1);
    expect(completed.xpGrant).toBeNull();
    expect(replay.xpGrant).toBeNull();
    expect(fixture.progression.operationCount()).toBe(0);
    expect(completed.masteryGrant).toMatchObject({ requestedXp: 15, grantedXp: 15, replayed: false });
    expect(replay.masteryGrant).toMatchObject({ requestedXp: 15, grantedXp: 15, replayed: true });
  });

  it("replays a committed tree harvest after presentation metadata retires", async () => {
    const fixture = createFixture();
    fixture.gateway.addV2Node(node("retired-tree", "wood", 2), 0);
    const started = await fixture.service.startHarvest(
      PLAYER,
      "retired-tree",
      VISION
    );
    fixture.clock.advance(deadlineDuration(started.session));

    const completed = await fixture.service.completeHarvest(
      PLAYER,
      started.session.sessionId,
      VISION
    );
    await expect(fixture.service.activeSessionForPlayer(PLAYER.playerId))
      .resolves.toBeNull();
    fixture.gateway.retirePresentation("retired-tree");
    const replay = await fixture.service.completeHarvest(
      PLAYER,
      started.session.sessionId,
      VISION
    );

    expect(completed.replayed).toBe(false);
    expect(replay).toMatchObject({
      replayed: true,
      nodeRemoved: true,
      populationTreeTransition: null,
      inventory: { totals: { wood: 2 } },
      xpGrant: null,
      masteryGrant: { replayed: true }
    });
    expect(fixture.gateway.grantCount()).toBe(1);
    expect(fixture.progression.operationCount()).toBe(0);
    expect(fixture.masteries.operationCount()).toBe(1);
  });

  it("serializes concurrent completion requests without duplicating", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("stone-node", "stone", 3));
    const started = await fixture.service.startHarvest(PLAYER, "stone-node", VISION);
    fixture.clock.advance(10_000);

    const results = await Promise.all([
      fixture.service.completeHarvest(PLAYER, started.session.sessionId, VISION),
      fixture.service.completeHarvest(PLAYER, started.session.sessionId, VISION)
    ]);

    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.every((result) => result.inventory.totals.stone === 3)).toBe(true);
    expect(fixture.gateway.grantCount()).toBe(1);
  });

  it("allows exactly one of two players to harvest the same tree", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("contested-tree", "wood", 2));

    const starts = await Promise.allSettled([
      fixture.service.startHarvest(PLAYER, "contested-tree", VISION),
      fixture.service.startHarvest(OTHER_PLAYER, "contested-tree", VISION)
    ]);
    const winner = starts.find(
      (result): result is PromiseFulfilledResult<Awaited<
        ReturnType<HarvestSessionService["startHarvest"]>
      >> => result.status === "fulfilled"
    );

    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(starts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "HARVEST_ALREADY_ACTIVE" }
    });
    expect(winner).toBeDefined();

    fixture.clock.advance(deadlineDuration(winner!.value.session));
    const winningPlayer = winner!.value.session.playerId === PLAYER.playerId
      ? PLAYER
      : OTHER_PLAYER;
    const losingPlayer = winningPlayer.playerId === PLAYER.playerId
      ? OTHER_PLAYER
      : PLAYER;
    await fixture.service.completeHarvest(
      winningPlayer,
      winner!.value.session.sessionId,
      VISION
    );

    expect(fixture.gateway.inventory(winningPlayer.playerId).totals.wood).toBe(2);
    expect(fixture.gateway.inventory(losingPlayer.playerId).totals.wood).toBe(0);
    expect(fixture.gateway.grantCount()).toBe(1);
  });

  it("prevents cancelled sessions from granting", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("food-node", "food"));
    const started = await fixture.service.startHarvest(PLAYER, "food-node", VISION);
    const cancelled = await fixture.service.cancelHarvest(
      PLAYER.playerId,
      started.session.sessionId
    );
    fixture.clock.advance(4_000);

    expect(cancelled).not.toBeNull();
    expect(cancelled!.session.status).toBe("cancelled");
    await expect(
      fixture.service.completeHarvest(PLAYER, started.session.sessionId, VISION)
    ).rejects.toMatchObject({ code: "HARVEST_CANCELLED" });
    expect(fixture.gateway.grantCount()).toBe(0);
    expect(fixture.progression.operationCount()).toBe(0);
  });

  it("treats cancellation after completion as a harmless no-op", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("completed-tree", "wood"));
    const started = await fixture.service.startHarvest(
      PLAYER,
      "completed-tree",
      VISION
    );
    fixture.clock.advance(deadlineDuration(started.session));
    const completed = await fixture.service.completeHarvest(
      PLAYER,
      started.session.sessionId,
      VISION
    );

    await expect(fixture.service.cancelHarvest(
      PLAYER.playerId,
      started.session.sessionId
    )).resolves.toBeNull();
    const replay = await fixture.service.completeHarvest(
      PLAYER,
      started.session.sessionId,
      VISION
    );

    expect(completed.session.status).toBe("completed");
    expect(replay.session.status).toBe("completed");
    expect(replay.replayed).toBe(true);
    expect(fixture.gateway.grantCount()).toBe(1);
  });

  it("rejects another player completing or cancelling a session", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("ore-node", "ore"));
    const started = await fixture.service.startHarvest(PLAYER, "ore-node", VISION);
    fixture.clock.advance(10_000);

    await expect(
      fixture.service.completeHarvest(OTHER_PLAYER, started.session.sessionId, VISION)
    ).rejects.toMatchObject({ code: "HARVEST_NOT_OWNED" });
    await expect(
      fixture.service.cancelHarvest(OTHER_PLAYER.playerId, started.session.sessionId)
    ).rejects.toMatchObject({ code: "HARVEST_NOT_OWNED" });
    expect(fixture.gateway.grantCount()).toBe(0);
  });

  it("rejects harvested nodes at start and at completion", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("spent-node", "wood", 1, "harvested"));
    await expect(
      fixture.service.startHarvest(PLAYER, "spent-node", VISION)
    ).rejects.toThrow(/already been harvested/i);

    fixture.gateway.addNode(node("contested-node", "wood"));
    const started = await fixture.service.startHarvest(PLAYER, "contested-node", VISION);
    fixture.gateway.harvestNode("contested-node");
    fixture.clock.advance(deadlineDuration(started.session));
    await expect(
      fixture.service.completeHarvest(PLAYER, started.session.sessionId, VISION)
    ).rejects.toThrow(/already been harvested/i);
    expect(fixture.gateway.grantCount()).toBe(0);
  });

  it("retires an active session after authoritative node removal", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("obsolete-tree", "wood"));
    fixture.gateway.addNode(node("current-tree", "wood"));
    const started = await fixture.service.startHarvest(
      PLAYER,
      "obsolete-tree",
      VISION
    );
    fixture.clock.advance(deadlineDuration(started.session));
    fixture.gateway.rejectCompletionAsNonAuthoritative();

    await expect(fixture.service.completeHarvest(
      PLAYER,
      started.session.sessionId,
      VISION
    )).rejects.toMatchObject({
      code: "HARVEST_NODE_NOT_FOUND",
      details: { reconciliation: "remove-node" }
    });
    await expect(fixture.service.activeSessionForPlayer(PLAYER.playerId))
      .resolves.toBeNull();
    await expect(fixture.service.startHarvest(
      PLAYER,
      "current-tree",
      VISION
    )).resolves.toMatchObject({
      session: { status: "active", nodeId: "current-tree" }
    });
    expect(fixture.gateway.grantCount()).toBe(0);
  });

  it("expires stale sessions so they do not block later harvesting", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("wood-node", "wood"));
    const first = await fixture.service.startHarvest(PLAYER, "wood-node", VISION);
    fixture.clock.advance(
      deadlineDuration(first.session) + HARVEST_SESSION_EXPIRY_GRACE_MS + 1
    );

    const second = await fixture.service.startHarvest(PLAYER, "wood-node", VISION);

    expect(second.session.sessionId).not.toBe(first.session.sessionId);
    expect(second.session.status).toBe("active");
  });

  it("returns active durable sessions for reconnect recovery", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("food-node", "food"));
    const started = await fixture.service.startHarvest(PLAYER, "food-node", VISION);

    await expect(fixture.service.activeSessionForPlayer(PLAYER.playerId)).resolves.toEqual(
      started.session
    );
  });

  it("grants no character XP for water", async () => {
    const fixture = createFixture();
    fixture.gateway.addNode(node("water-node", "water"));
    const started = await fixture.service.startHarvest(PLAYER, "water-node", VISION);
    fixture.clock.advance(2_000);
    const completed = await fixture.service.completeHarvest(PLAYER, started.session.sessionId, VISION);
    expect(completed.xpGrant).toBeNull();
    expect(fixture.progression.operationCount()).toBe(0);
  });

  it("grants inventory, XP, and mastery once for each stable-id v2 tree life", async () => {
    const fixture = createFixture();
    const nodeId = "00000000-0000-8000-8000-000000000654";
    fixture.gateway.addV2Node(node(nodeId, "wood"), 0);

    const first = await fixture.service.startHarvest(PLAYER, nodeId, VISION);
    fixture.clock.advance(deadlineDuration(first.session));
    const firstResult = await fixture.service.completeHarvest(
      PLAYER,
      first.session.sessionId,
      VISION
    );
    fixture.gateway.respawnV2Node(nodeId);

    const second = await fixture.service.startHarvest(PLAYER, nodeId, VISION);
    fixture.clock.advance(deadlineDuration(second.session));
    const secondResult = await fixture.service.completeHarvest(
      PLAYER,
      second.session.sessionId,
      VISION
    );

    expect(first.session.operationKey).toBe(
      collectiblePickupOperationKey(nodeId, PLAYER.playerId, 0)
    );
    expect(second.session.operationKey).toBe(
      collectiblePickupOperationKey(nodeId, PLAYER.playerId, 2)
    );
    expect(second.session.operationKey).not.toBe(first.session.operationKey);
    expect(firstResult).toMatchObject({
      replayed: false,
      inventory: { totals: { wood: 1 } },
      xpGrant: null,
      masteryGrant: { requestedXp: 15, replayed: false }
    });
    expect(secondResult).toMatchObject({
      replayed: false,
      inventory: { totals: { wood: 2 } },
      xpGrant: null,
      masteryGrant: { requestedXp: 15, replayed: false }
    });
    expect(fixture.gateway.grantCount()).toBe(2);
    expect(fixture.progression.operationCount()).toBe(0);
    expect(fixture.masteries.operationCount()).toBe(2);
  });

  it("records only a committed Flax harvest and not its replay", async () => {
    const plantHarvests: CreatureBookPlantHarvestInput[] = [];
    const fixture = createFixture({
      plantRecorder: {
        async recordPlantHarvestInTransaction(
          _client: pg.PoolClient,
          input: CreatureBookPlantHarvestInput
        ): Promise<void> {
          plantHarvests.push(input);
        }
      }
    });
    fixture.gateway.addNode(node("flax-node", "flax_fiber"));
    const started = await fixture.service.startHarvest(PLAYER, "flax-node", VISION);
    fixture.clock.advance(10_000);

    const completed = await fixture.service.completeHarvest(PLAYER, started.session.sessionId, VISION);
    await fixture.service.completeHarvest(PLAYER, started.session.sessionId, VISION);

    expect(completed.inventory.totals.flax_fiber).toBeGreaterThan(0);
    expect(fixture.gateway.grantCount()).toBe(1);
    expect(plantHarvests).toEqual([{
      playerId: PLAYER.playerId,
      plantKey: "flax",
      sourceId: started.session.operationKey
    }]);
  });
});

function createFixture(options: Readonly<{
  masteryRank?: number;
  random?: () => number;
  dungeonSkills?: Readonly<{ rollHarvestBonus(playerId: string, resourceType: string): Promise<{ extraUnit: boolean; rareItemId: string | null }> }>;
  plantRecorder?: Readonly<{
    recordPlantHarvestInTransaction(
      client: pg.PoolClient,
      input: CreatureBookPlantHarvestInput
    ): Promise<void>;
  }>;
}> = {}) {
  const database = createHarvestDatabase();
  const gateway = new FakeCollectibleGateway();
  const clock = new TestClock(new Date("2026-07-09T12:00:00.000Z"));
  const progression = new FakeProgression();
  const masteries = new FakeMasteries(options.masteryRank);
  return {
    gateway,
    clock,
    progression,
    masteries,
    service: new HarvestSessionService(
      database.pool,
      gateway,
      () => clock.now(),
      progression as unknown as ProgressionService,
      masteries as unknown as MasteryService,
      undefined,
      options.random,
      options.plantRecorder,
      options.dungeonSkills
    )
  };
}

class FakeProgression {
  private readonly operations = new Map<string, XpGrantResult>();

  operationCount(): number {
    return this.operations.size;
  }

  async grantXpInTransaction(
    _queryable: Pick<pg.Pool, "query">,
    input: XpGrantInput
  ): Promise<XpGrantResult> {
    const existing = this.operations.get(input.operationKey);
    if (existing) return { ...existing, replayed: true };
    const result: XpGrantResult = {
      operationKey: input.operationKey,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      requestedXp: input.requestedXp,
      grantedXp: input.requestedXp,
      discardedXp: 0,
      previousXp: 0,
      resultingXp: input.requestedXp,
      previousLevel: 0,
      resultingLevel: 0,
      levelsGained: [],
      replayed: false,
      progression: {
        playerId: input.playerId,
        totalXp: input.requestedXp,
        level: 0,
        curveVersion: 1,
        persistenceVersion: 1,
        xpIntoLevel: input.requestedXp,
        xpForNextLevel: 1_667,
        nextLevelTotalXp: 1_667,
        atCap: false,
        pveStats: { maxHealth: 100, attackPower: 10, defense: 0, attackIntervalMs: 800, attackRangeM: 75 }
      }
    };
    this.operations.set(input.operationKey, result);
    return result;
  }
}

class FakeMasteries {
  private readonly operations = new Map<string, MasteryGrantResult>();

  constructor(private readonly rank = 0) {}

  operationCount(): number {
    return this.operations.size;
  }

  async professionRankInTransaction(): Promise<number> {
    return this.rank;
  }

  async grantProfessionXpInTransaction(
    _queryable: Pick<pg.Pool, "query">,
    input: {
      operationKey: string;
      playerId: string;
      activity: { kind: "wood-harvest" };
    }
  ): Promise<MasteryGrantResult> {
    const existing = this.operations.get(input.operationKey);
    if (existing) return { ...existing, replayed: true };
    const result = {
      operationKey: input.operationKey,
      playerId: input.playerId,
      trackId: "woodcutter",
      requestedXp: 15,
      grantedXp: 15,
      previousXp: 0,
      resultingXp: 15,
      previousRank: 0,
      resultingRank: 0,
      replayed: false,
      newlyMastered: false,
      snapshot: {}
    } as MasteryGrantResult;
    this.operations.set(input.operationKey, result);
    return result;
  }
}

class TestClock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

class FakeCollectibleGateway {
  private readonly nodes = new Map<string, CollectibleNode>();
  private readonly v2StateRevisions = new Map<string, number>();
  private readonly inventories = new Map<string, Record<ResourceType, number>>();
  private readonly inventoryOperations = new Set<string>();
  private grants = 0;
  private rejectCompletionForAuthority = false;

  readonly bonusQuantities: number[] = [];
  readonly rareFinds: Array<{ playerId: string; itemId: string; operationKey: string }> = [];

  async grantRareFindInTransaction(_queryable: unknown, playerId: string, itemId: string, operationKey: string): Promise<void> {
    this.rareFinds.push({ playerId, itemId, operationKey });
  }

  addNode(value: CollectibleNode): void {
    this.nodes.set(value.id, { ...value });
    this.v2StateRevisions.set(value.id, 0);
  }

  addV2Node(value: CollectibleNode, stateRevision: number): void {
    this.addNode(value);
    this.v2StateRevisions.set(value.id, stateRevision);
  }

  respawnV2Node(nodeId: string): void {
    const value = this.nodes.get(nodeId);
    const stateRevision = this.v2StateRevisions.get(nodeId);
    if (!value || stateRevision === undefined || value.state !== "harvested") {
      throw new Error("Population v2 test node cannot respawn");
    }
    value.state = "available";
    value.harvestedAt = null;
    this.v2StateRevisions.set(nodeId, stateRevision + 1);
  }

  harvestNode(nodeId: string): void {
    const value = this.nodes.get(nodeId);
    if (value) {
      value.state = "harvested";
    }
  }

  rejectCompletionAsNonAuthoritative(): void {
    this.rejectCompletionForAuthority = true;
  }

  async validateHarvestStartInTransaction(
    _queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    nodeId: string
  ): Promise<HarvestableCollectibleNode> {
    const value = this.availableNode(nodeId);
    return {
      ...value,
      stateRevision: this.v2StateRevisions.get(nodeId) ?? 0,
      harvestOperationKey: this.operationKey(value, player.playerId)
    };
  }

  async validateResinHarvestStartInTransaction(
    queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    nodeId: string
  ): Promise<HarvestableCollectibleNode> {
    const node = await this.validateHarvestStartInTransaction(
      queryable,
      player,
      nodeId
    );
    return {
      ...node,
      type: "balsam_resin",
      quantity: 1,
      harvestOperationKey: `resin:${node.id}`
    };
  }

  async completeHarvestInTransaction(
    _queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    nodeId: string,
    _resourceVision: unknown,
    bonusQuantity?: number,
    operationKey?: string
  ): Promise<{
    node: CollectibleNode;
    inventory: PlayerInventorySnapshot;
    droppedItems: [];
    populationTreeTransition: HarvestedPopulationTreeTransition | null;
  }> {
    this.bonusQuantities.push(bonusQuantity ?? 0);
    if (this.rejectCompletionForAuthority) {
      this.rejectCompletionForAuthority = false;
      throw new CollectibleHarvestError(
        "HARVEST_NODE_NOT_FOUND",
        "This resource is no longer part of the current population.",
        { nodeId, reconciliation: "remove-node" }
      );
    }
    const value = this.availableNode(nodeId);
    if (!operationKey || operationKey !== this.operationKey(value, player.playerId)) {
      throw new Error("Collectible life changed during harvesting");
    }
    value.state = "harvested";
    value.harvestedAt = new Date().toISOString();
    const stateRevision = this.v2StateRevisions.get(nodeId);
    if (stateRevision !== undefined) {
      this.v2StateRevisions.set(nodeId, stateRevision + 1);
    }
    if (this.inventoryOperations.has(operationKey)) {
      return {
        node: { ...value },
        inventory: this.inventory(player.playerId),
        droppedItems: [],
        populationTreeTransition: value.type === "wood"
          ? this.harvestedTreeTransition(value)
          : null
      };
    }
    this.inventoryOperations.add(operationKey);
    this.grants += 1;
    const totals = this.inventoryTotals(player.playerId);
    totals[value.type] += value.quantity;
    return {
      node: { ...value },
      inventory: this.inventory(player.playerId),
      droppedItems: [],
      populationTreeTransition: value.type === "wood"
        ? this.harvestedTreeTransition(value)
        : null
    };
  }

  async completeResinHarvestInTransaction(
    _queryable: CollectibleTransaction,
    player: CollectiblePlayer,
    nodeId: string
  ): Promise<{
    node: CollectibleNode;
    inventory: PlayerInventorySnapshot;
    rewardQuantity: 1;
    droppedItems: [];
  }> {
    const node = this.availableNode(nodeId);
    const totals = this.inventoryTotals(player.playerId);
    totals.balsam_resin += 1;
    return {
      node: { ...node, resinAvailable: false },
      inventory: this.inventory(player.playerId),
      rewardQuantity: 1,
      droppedItems: []
    };
  }

  async inventoryForPlayerInTransaction(
    _queryable: CollectibleTransaction,
    playerId: string
  ): Promise<PlayerInventorySnapshot> {
    return this.inventory(playerId);
  }

  async harvestedPopulationTreeTransitionInTransaction(
    _queryable: CollectibleTransaction,
    nodeId: string
  ): Promise<HarvestedPopulationTreeTransition> {
    const value = this.nodes.get(nodeId);
    if (!value || value.type !== "wood" || value.state !== "harvested") {
      throw new Error("test node is not a harvested Population V2 tree");
    }
    return this.harvestedTreeTransition(value);
  }

  retirePresentation(nodeId: string): void {
    this.nodes.delete(nodeId);
    this.v2StateRevisions.delete(nodeId);
  }

  async findHarvestedPopulationTreeTransitionInTransaction(
    _queryable: CollectibleTransaction,
    nodeId: string
  ): Promise<HarvestedPopulationTreeTransition | null> {
    const value = this.nodes.get(nodeId);
    return !value || value.type !== "wood" || value.state !== "harvested"
      ? null
      : this.harvestedTreeTransition(value);
  }

  inventory(playerId: string): PlayerInventorySnapshot {
    const totals = this.inventoryTotals(playerId);
    return {
      playerId,
      revision: 0,
      totals: { ...totals },
      items: Object.entries(totals)
        .filter(([, quantity]) => quantity > 0)
        .map(([resourceType, quantity]) => ({
          playerId,
          resourceType: resourceType as ResourceType,
          variant: null,
          quantity
        }))
    };
  }

  private harvestedTreeTransition(
    value: CollectibleNode
  ): HarvestedPopulationTreeTransition {
    return {
      entityId: value.id,
      entityKind: "tree",
      stateRevision: this.v2StateRevisions.get(value.id) ?? 1,
      position: { lat: value.lat, lon: value.lon },
      zoneId: "ppz2-eag1/000/000",
      generationId: "00000000-0000-4000-8000-000000000201",
      cutoverRevision: 1
    };
  }

  grantCount(): number {
    return this.grants;
  }

  private availableNode(nodeId: string): CollectibleNode {
    const value = this.nodes.get(nodeId);
    if (!value) {
      throw new Error("Collectible does not exist");
    }
    if (value.state !== "available") {
      throw new Error("Collectible has already been harvested");
    }
    return value;
  }

  private inventoryTotals(playerId: string): Record<ResourceType, number> {
    let totals = this.inventories.get(playerId);
    if (!totals) {
      totals = {
        wood: 0,
        stone: 0,
        coal: 0,
        iron: 0,
        sulfur: 0,
        slag: 0,
        iron_bar: 0,
        venomsteel_bar: 0,
        venomsteel_core: 0,
        fire_feather: 0, tempest_quill: 0, ice_feather: 0,
        fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0,
        food: 0,
        bone: 0,
        fertilizer: 0,
        flux_plant: 0,
        simple_food: 0,
        freshwater_fish: 0,
        ashen_fish: 0,
        ore: 0,
        water: 0,
        leather: 0,
        flax_fiber: 0,
        cloth: 0,
        deer_hide: 0,
        hog_hide: 0,
        wolf_pelt: 0,
        bear_hide: 0,
        alligator_hide: 0,
        deer_carcass: 0,
        wolf_carcass: 0,
        hog_carcass: 0,
        bear_carcass: 0,
        alligator_carcass: 0,
        wild_carcass: 0,
        squid_flesh: 0,
        squid_meat: 0,
        deer_meat: 0,
        wolf_meat: 0,
        hog_meat: 0,
        bear_meat: 0,
        alligator_meat: 0,
        wild_meat: 0,
        crab_carapace: 0,
        raw_meat: 0,
        shell: 0,
        chitin: 0,
        giving_berry: 0,
        balsam_resin: 0,
        repair_kit: 0,
        torch: 0,
        shovel: 0,
        crude_oil: 0,
        jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0, bricks: 0,
        crystal: 0, pearl: 0, atlas_shrine_shard: 0,
        enchantment_stone: 0,
        lumen: 0,
        frog_legs: 0,
        frost_frog_legs: 0,
        poison_frog_legs: 0,
        desert_toad_legs: 0,
        crab_meat: 0,
        ice_crab_meat: 0,
        sand_crab_meat: 0,
        mangrove_crab_meat: 0,
        small_catch: 0,
        jellyfish_jelly: 0,
        crawler_flesh: 0,
        squid_cut: 0,
        wolf_cut: 0,
        frost_wolf_cut: 0,
        dune_wolf_cut: 0,
        jungle_wolf_cut: 0,
        bog_wolf_cut: 0,
        deer_cut: 0,
        frost_deer_cut: 0,
        jungle_deer_cut: 0,
        marsh_deer_cut: 0,
        sand_deer_cut: 0,
        hog_cut: 0,
        woolly_hog_cut: 0,
        warthog_cut: 0,
        jungle_hog_cut: 0,
        mud_hog_cut: 0,
        javelina_cut: 0,
        alligator_tail: 0,
        caiman_tail: 0,
        crocodile_tail: 0,
        bear_cut: 0,
        snow_bear_cut: 0,
        black_bear_cut: 0,
        sun_bear_cut: 0,
        jungle_tapir_cut: 0,
        jaguar_cut: 0,
        mandrill_cut: 0,
        capercaillie_meat: 0,
        elk_cut: 0,
        red_squirrel_cut: 0,
        badger_cut: 0,
        grey_squirrel_cut: 0,
        stag_beetle_cut: 0,
        great_grey_owl_meat: 0,
        flying_squirrel_cut: 0,
        plains_bison_cut: 0,
        prairie_dog_cut: 0,
        burrowing_owl_meat: 0,
        giraffe_cut: 0,
        lioness_cut: 0,
        spotted_hyena_cut: 0,
        sitatunga_cut: 0,
        emperor_dragonfly_cut: 0,
        mountain_ibex_cut: 0,
        wild_yak_cut: 0,
        alpine_marmot_cut: 0,
        wild_scrub_goat_cut: 0,
        crested_porcupine_cut: 0,
        spur_thighed_tortoise_cut: 0,
        dromedary_cut: 0,
        fennec_fox_cut: 0,
        sidewinder_cut: 0,
        desert_lion_cut: 0,
        saiga_cut: 0,
        wild_horse_cut: 0,
        steppe_marmot_cut: 0,
        lemming_cut: 0,
        snow_goose_meat: 0,
        mammoth_cut: 0,
        dire_wolf_cut: 0,
        drake_cut: 0,
        dragon_cut: 0,
        grub_meat: 0,
        emperor_penguin_meat: 0,
        peary_caribou_cut: 0,
        ice_worm_cut: 0,
        sea_otter_cut: 0,
        herring_gull_meat: 0,
        spiny_lobster_tail: 0,
        hammerhead_shark_steak: 0,
        manta_ray_wing: 0,
        humpback_whale_cut: 0,
        muskellunge_fillet: 0,
        mute_swan_meat: 0,
        pike_fillet: 0,
        snapping_turtle_cut: 0,
        beaver_cut: 0,
        otter_cut: 0,
        salmon_fillet: 0,
        elemental_ration: 0,
        scorching_bird_meat: 0,
        zappy_bird_meat: 0,
        freezing_bird_meat: 0,
        field_ration: 0,
        hearty_ration: 0,
        xoral_essence: 0
      } as Record<ResourceType, number>;
      this.inventories.set(playerId, totals);
    }
    return totals;
  }

  private operationKey(value: CollectibleNode, playerId: string): string {
    const stateRevision = this.v2StateRevisions.get(value.id);
    if (stateRevision === undefined) {
      throw new Error("Population v2 test node is missing its state revision");
    }
    return collectiblePickupOperationKey(
      value.id,
      playerId,
      stateRevision
    );
  }
}

type SessionRow = {
  id: string;
  player_id: string;
  node_id: string;
  resource_type: string;
  operation_key: string;
  status: "active" | "completed" | "cancelled" | "expired";
  started_at: Date;
  completes_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
};

function createHarvestDatabase(): { pool: pg.Pool } {
  let committed = new Map<string, SessionRow>();
  let transactionTail = Promise.resolve();

  const acquire = async (): Promise<() => void> => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = transactionTail;
    transactionTail = previous.then(() => gate);
    await previous;
    return release;
  };

  return {
    pool: {
      connect: async () => {
        let transaction: Map<string, SessionRow> | null = null;
        let release: (() => void) | null = null;
        return {
          query: async <T>(text: string, values?: readonly unknown[]) => {
            if (text === "BEGIN") {
              release = await acquire();
              transaction = cloneSessions(committed);
              return emptyResult<T>();
            }
            if (text === "COMMIT") {
              committed = cloneSessions(requireTransaction(transaction));
              transaction = null;
              release?.();
              release = null;
              return emptyResult<T>();
            }
            if (text === "ROLLBACK") {
              transaction = null;
              release?.();
              release = null;
              return emptyResult<T>();
            }
            if (
              text === "SAVEPOINT harvest_completion"
              || text === "ROLLBACK TO SAVEPOINT harvest_completion"
            ) {
              return emptyResult<T>();
            }
            return querySessions<T>(requireTransaction(transaction), text, values);
          },
          release: () => undefined
        };
      }
    } as unknown as pg.Pool
  };
}

function querySessions<T>(
  sessions: Map<string, SessionRow>,
  text: string,
  values: readonly unknown[] | undefined
): { rows: T[]; rowCount: number } {
  if (text.includes("UPDATE harvest_sessions") && text.includes("expires_at <=")) {
    const now = date(values?.[0]);
    const playerId = String(values?.[1]);
    const nodeId = values?.[2] === null ? null : String(values?.[2]);
    for (const row of sessions.values()) {
      if (
        row.status === "active" &&
        row.expires_at <= now &&
        (row.player_id === playerId || row.node_id === nodeId)
      ) {
        row.status = "expired";
      }
    }
    return emptyResult<T>();
  }
  if (text.includes("INSERT INTO harvest_sessions")) {
    const playerId = String(values?.[1]);
    const nodeId = String(values?.[2]);
    if (
      [...sessions.values()].some(
        (row) =>
          row.status === "active" &&
          (row.player_id === playerId || row.node_id === nodeId)
      )
    ) {
      throw Object.assign(new Error("duplicate active harvest"), { code: "23505" });
    }
    const row: SessionRow = {
      id: String(values?.[0]),
      player_id: playerId,
      node_id: nodeId,
      resource_type: String(values?.[3]),
      operation_key: String(values?.[4]),
      status: "active",
      started_at: date(values?.[5]),
      completes_at: date(values?.[6]),
      expires_at: date(values?.[7]),
      completed_at: null,
      cancelled_at: null,
      ...(values?.[8] ? { mastery_results: JSON.parse(String(values[8])) } : {})
    };
    if (row.completes_at <= row.started_at || row.expires_at <= row.completes_at) {
      throw Object.assign(new Error("harvest session timestamps violate ordering"), {
        code: "23514"
      });
    }
    sessions.set(row.id, row);
    return oneResult<T>(row);
  }
  if (text.includes("FROM harvest_sessions") && text.includes("WHERE id = $1")) {
    const row = sessions.get(String(values?.[0]));
    return row ? oneResult<T>(row) : emptyResult<T>();
  }
  if (text.includes("FROM harvest_sessions") && text.includes("node_id = $2")) {
    const row = [...sessions.values()].find(
      (candidate) =>
        candidate.status === "active" &&
        (candidate.player_id === values?.[0] || candidate.node_id === values?.[1])
    );
    return row ? oneResult<T>(row) : emptyResult<T>();
  }
  if (text.includes("FROM harvest_sessions") && text.includes("player_id = $1")) {
    const row = [...sessions.values()].find(
      (candidate) => candidate.status === "active" && candidate.player_id === values?.[0]
    );
    return row ? oneResult<T>(row) : emptyResult<T>();
  }
  if (text.includes("UPDATE harvest_sessions") && text.includes("SET status = $2")) {
    const row = sessions.get(String(values?.[0]));
    if (!row) {
      return emptyResult<T>();
    }
    row.status = String(values?.[1]) as SessionRow["status"];
    const at = date(values?.[2]);
    if (row.status === "completed") {
      row.completed_at = at;
    }
    if (row.status === "cancelled") {
      row.cancelled_at = at;
    }
    return oneResult<T>(row);
  }
  if (
    text ===
    "UPDATE player_mastery_state SET last_woodcut_completed_at = $2 WHERE player_id = $1"
  ) {
    return emptyResult<T>();
  }
  throw new Error(`Unhandled harvest session test query: ${text}`);
}

function node(
  id: string,
  type: ResourceType,
  quantity = 1,
  state: CollectibleNode["state"] = "available"
): CollectibleNode {
  return {
    id,
    type,
    lat: PLAYER.position.lat,
    lon: PLAYER.position.lon,
    quantity,
    state,
    createdAt: "2026-07-09T00:00:00.000Z",
    harvestedAt: state === "harvested" ? "2026-07-09T00:01:00.000Z" : null,
    sourceCellId: "cell-1",
    waterKind: null
  };
}

function deadlineDuration(session: { startedAt: string; completesAt: string }): number {
  return Date.parse(session.completesAt) - Date.parse(session.startedAt);
}

function requireTransaction<T>(value: T | null): T {
  if (!value) {
    throw new Error("Harvest query must run in a transaction");
  }
  return value;
}

function cloneSessions(sessions: Map<string, SessionRow>): Map<string, SessionRow> {
  return new Map(
    [...sessions].map(([id, row]) => [
      id,
      {
        ...row,
        started_at: new Date(row.started_at),
        completes_at: new Date(row.completes_at),
        expires_at: new Date(row.expires_at),
        completed_at: row.completed_at ? new Date(row.completed_at) : null,
        cancelled_at: row.cancelled_at ? new Date(row.cancelled_at) : null
      }
    ])
  );
}

function date(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

function oneResult<T>(row: unknown): { rows: T[]; rowCount: number } {
  return { rows: [{ ...(row as object) } as T], rowCount: 1 };
}

function emptyResult<T>(): { rows: T[]; rowCount: number } {
  return { rows: [], rowCount: 0 };
}
