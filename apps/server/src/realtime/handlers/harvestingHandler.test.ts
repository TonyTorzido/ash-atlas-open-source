import type {
  CollectibleNode,
  HarvestSessionSnapshot,
  PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { BalsamResinError } from "../../game/balsamResin.js";
import { CollectibleHarvestError } from "../../game/collectibles.js";
import { InventoryProtectionError } from "../../game/inventoryProtection.js";
import { RepeatableResourceError } from "../../game/repeatableResources.js";
import { createHarvestingHandler } from "./harvestingHandler.js";

describe("harvesting handler Giving Tree updates", () => {
  it("broadcasts a resin-less update to observers without removing the tree", async () => {
    const tree = collectible({ resinAvailable: false, treeLifeRevision: 3 });
    const fixture = createFixture({
      session: harvestSession("balsam_resin"),
      node: tree,
      nodeRemoved: false,
      rewardItemId: "balsam_resin"
    });

    await fixture.handler({
      type: "COMPLETE_HARVEST",
      requestId: "complete-resin",
      sessionId: fixture.session.sessionId
    });

    expect(fixture.safeSendServerMessage).toHaveBeenCalledWith(
      fixture.socket,
      expect.objectContaining({
        type: "HARVEST_COMPLETED",
        nodeId: tree.id,
        node: tree,
        nodeRemoved: false
      }),
      fixture.logger,
      expect.any(Object)
    );
    expect(fixture.sendToGameplayCirclesContaining).toHaveBeenCalledWith(
      { lat: tree.lat, lon: tree.lon },
      {
        type: "COLLECTIBLE_UPDATED",
        node: tree,
        playerId: "player-1",
        serverTime: expect.any(Number)
      }
    );
    expect(fixture.combat.removeGivingTree).not.toHaveBeenCalled();
  });

  it("publishes the authoritative Population V2 transition when wood chopping removes the tree", async () => {
    const tree = collectible({ resinAvailable: false, treeLifeRevision: 3 });
    const fixture = createFixture({
      session: harvestSession("wood"),
      node: tree,
      nodeRemoved: true,
      rewardItemId: "wood"
    });

    await fixture.handler({
      type: "COMPLETE_HARVEST",
      requestId: "complete-wood",
      sessionId: fixture.session.sessionId
    });

    expect(fixture.removeHarvestedTree).toHaveBeenCalledWith({
      entityId: tree.id,
      entityKind: "tree",
      stateRevision: 3,
      position: { lat: tree.lat, lon: tree.lon },
      zoneId: "ppz2-eag1/000/000",
      generationId: "00000000-0000-4000-8000-000000000201",
      cutoverRevision: 4
    });
    expect(fixture.combat.removeGivingTree).toHaveBeenCalledWith(tree.id);
    expect(fixture.sendToGameplayCirclesContaining).toHaveBeenCalledWith(
      { lat: tree.lat, lon: tree.lon },
      {
        type: "COLLECTIBLE_REMOVED",
        nodeId: tree.id,
        playerId: "player-1",
        stateRevision: 3,
        serverTime: expect.any(Number)
      }
    );
  });

  it("publishes a targeted ground-loot refresh for harvest overflow", async () => {
    const tree = collectible({ resinAvailable: false, treeLifeRevision: 3 });
    const fixture = createFixture({
      session: harvestSession("wood"),
      node: tree,
      nodeRemoved: true,
      rewardItemId: "wood",
      overflowQuantity: 2
    });

    await fixture.handler({
      type: "COMPLETE_HARVEST",
      requestId: "complete-overflow",
      sessionId: fixture.session.sessionId
    });

    expect(fixture.broadcastDroppedItems).toHaveBeenCalledWith([
      { lat: tree.lat, lon: tree.lon }
    ]);
  });

  it("evicts before equipment refresh and never reports a committed harvest as failed", async () => {
    const tree = collectible({ resinAvailable: false, treeLifeRevision: 3 });
    const fixture = createFixture({
      session: harvestSession("wood"),
      node: tree,
      nodeRemoved: true,
      rewardItemId: "wood",
      withSecondaryGrants: true,
      refreshFails: true
    });

    await fixture.handler({
      type: "COMPLETE_HARVEST",
      requestId: "complete-wood-refresh-fails",
      sessionId: fixture.session.sessionId
    });

    expect(fixture.removeHarvestedTree).toHaveBeenCalledOnce();
    expect(fixture.removeHarvestedTree.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.refreshAuthoritativePlayerStats.mock.invocationCallOrder[0]!);
    expect(fixture.safeSendServerMessage).toHaveBeenCalledWith(
      fixture.socket,
      expect.objectContaining({
        type: "HARVEST_COMPLETED",
        requestId: "complete-wood-refresh-fails"
      }),
      fixture.logger,
      expect.any(Object)
    );
    expect(fixture.safeSendServerMessage).toHaveBeenCalledWith(
      fixture.socket,
      expect.objectContaining({ type: "XP_GRANTED" }),
      fixture.logger,
      expect.any(Object)
    );
    expect(fixture.safeSendServerMessage).not.toHaveBeenCalledWith(
      fixture.socket,
      expect.objectContaining({ type: "ERROR" })
    );
    expect(fixture.registry.send).toHaveBeenCalledWith(
      "player-1",
      expect.objectContaining({ type: "MASTERY_SNAPSHOT" })
    );
    expect(fixture.registry.send).toHaveBeenCalledWith(
      "player-1",
      expect.objectContaining({ type: "RESOURCE_GAINED" })
    );
    expect(fixture.sendCollectiblesForPlayer).toHaveBeenCalledOnce();
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: "equipment-progression-refresh" }),
      "post-commit harvest work failed"
    );
  });

  it("re-evicts replayed tree completion without duplicate gain publications", async () => {
    const tree = collectible({ resinAvailable: false, treeLifeRevision: 3 });
    const fixture = createFixture({
      session: harvestSession("wood"),
      node: tree,
      nodeRemoved: true,
      rewardItemId: "wood",
      replayed: true,
      withSecondaryGrants: true
    });

    await fixture.handler({
      type: "COMPLETE_HARVEST",
      requestId: "replay-wood",
      sessionId: fixture.session.sessionId
    });

    expect(fixture.removeHarvestedTree).toHaveBeenCalledOnce();
    expect(fixture.safeSendServerMessage).toHaveBeenCalledWith(
      fixture.socket,
      expect.objectContaining({
        type: "HARVEST_COMPLETED",
        replayed: true
      }),
      fixture.logger,
      expect.any(Object)
    );
    expect(fixture.safeSendServerMessage).not.toHaveBeenCalledWith(
      fixture.socket,
      expect.objectContaining({ type: "XP_GRANTED" })
    );
    expect(fixture.registry.send).not.toHaveBeenCalledWith(
      "player-1",
      expect.objectContaining({ type: "MASTERY_SNAPSHOT" })
    );
    expect(fixture.registry.send).not.toHaveBeenCalledWith(
      "player-1",
      expect.objectContaining({ type: "RESOURCE_GAINED" })
    );
    expect(fixture.refreshAuthoritativePlayerStats).not.toHaveBeenCalled();
  });

  it("refreshes collectibles when a committed replay has no retired tree transition", async () => {
    const tree = collectible({ resinAvailable: false, treeLifeRevision: 3 });
    const fixture = createFixture({
      session: harvestSession("wood"),
      node: tree,
      nodeRemoved: true,
      rewardItemId: "wood",
      replayed: true,
      transitionMissing: true,
      withSecondaryGrants: true
    });

    await fixture.handler({
      type: "COMPLETE_HARVEST",
      requestId: "replay-retired-tree",
      sessionId: fixture.session.sessionId
    });

    expect(fixture.removeHarvestedTree).not.toHaveBeenCalled();
    expect(fixture.safeSendServerMessage).toHaveBeenCalledWith(
      fixture.socket,
      expect.objectContaining({
        type: "HARVEST_COMPLETED",
        requestId: "replay-retired-tree",
        nodeRemoved: true,
        replayed: true
      }),
      fixture.logger,
      expect.any(Object)
    );
    expect(fixture.safeSendServerMessage).not.toHaveBeenCalledWith(
      fixture.socket,
      expect.objectContaining({ type: "ERROR" })
    );
    expect(fixture.sendCollectiblesForPlayer).toHaveBeenCalled();
    expect(fixture.registry.send).not.toHaveBeenCalledWith(
      "player-1",
      expect.objectContaining({ type: "RESOURCE_GAINED" })
    );
  });

  it("sends no cancellation frame when a completed session returns no-op", async () => {
    const socket = {};
    const safeSendServerMessage = vi.fn(() => true);
    const cancelHarvest = vi.fn(async () => null);
    const handler = createHarvestingHandler({
      state: { playerId: "player-1" },
      socket,
      logger: { warn: vi.fn() },
      harvestSessions: { cancelHarvest },
      safeSendServerMessage
    } as never);

    await handler({
      type: "CANCEL_HARVEST",
      requestId: "stale-cancel",
      sessionId: "11111111-1111-4111-8111-111111111111"
    });

    expect(cancelHarvest).toHaveBeenCalledOnce();
    expect(safeSendServerMessage).not.toHaveBeenCalled();
  });
});

describe("harvesting handler inventory stack actions", () => {
  it("rejects obsolete grid commands without mutating quantity balances", async () => {
    const inventorySnapshot = playerInventory("wood");
    const socket = {};
    const safeSendServerMessage = vi.fn(() => true);
    const inventory = {
      splitStack: vi.fn(async () => inventorySnapshot),
      restackStack: vi.fn(async () => inventorySnapshot),
      moveStack: vi.fn(async () => inventorySnapshot),
      reorganize: vi.fn(async () => inventorySnapshot)
    };
    const handler = createHarvestingHandler({
      state: { playerId: "player-1" },
      socket,
      logger: { warn: vi.fn() },
      inventory,
      safeSendServerMessage
    } as never);
    const messages = [
      {
        type: "SPLIT_INVENTORY_STACK" as const,
        requestId: "request-split",
        stackId: "stack-1",
        quantity: 1
      },
      {
        type: "RESTACK_INVENTORY_STACK" as const,
        requestId: "request-restack",
        stackId: "stack-1"
      },
      {
        type: "MOVE_INVENTORY_STACK" as const,
        requestId: "request-move",
        stackId: "stack-1",
        targetSlot: 4
      },
      {
        type: "REORGANIZE_INVENTORY" as const,
        requestId: "request-reorganize"
      }
    ];

    for (const message of messages) await handler(message);

    expect(safeSendServerMessage).toHaveBeenCalledTimes(4);
    for (const [index, action] of [
      "split",
      "restack",
      "move",
      "reorganize"
    ].entries()) {
      expect(safeSendServerMessage).toHaveBeenNthCalledWith(
        index + 1,
        socket,
        expect.objectContaining({
          type: "ERROR",
          requestId: messages[index]!.requestId,
          code: "INVENTORY_GRID_ACTION_RETIRED"
        })
      );
      const method = action === "split" ? inventory.splitStack : action === "restack" ? inventory.restackStack : action === "move" ? inventory.moveStack : inventory.reorganize;
      expect(method).not.toHaveBeenCalled();
    }
  });
});

describe("harvesting handler inventory protection", () => {
  it("resynchronizes the authoritative snapshot after a rejected update", async () => {
    const socket = {};
    const safeSendServerMessage = vi.fn(() => true);
    const protection = {
      playerId: "player-1",
      revision: 4,
      materialPolicies: [],
      uniqueItems: [],
      stackAllocations: []
    };
    const inventoryProtection = {
      setMaterialKeep: vi.fn(async () => {
        throw new InventoryProtectionError(
          "INVENTORY_PROTECTION_STALE_REVISION",
          "Protection settings changed in another session."
        );
      }),
      snapshot: vi.fn(async () => protection)
    };
    const handler = createHarvestingHandler({
      state: { playerId: "player-1" },
      socket,
      logger: { warn: vi.fn() },
      inventoryProtection,
      safeSendServerMessage
    } as never);

    await handler({
      type: "UPDATE_MATERIAL_KEEP",
      requestId: "protect-stale",
      itemId: "wood",
      variant: null,
      keepQuantity: 250,
      expectedRevision: 3
    });

    expect(safeSendServerMessage).toHaveBeenNthCalledWith(1, socket, {
      type: "ERROR",
      requestId: "protect-stale",
      code: "INVENTORY_PROTECTION_STALE_REVISION",
      message: "Protection settings changed in another session."
    });
    expect(safeSendServerMessage).toHaveBeenNthCalledWith(2, socket, {
      type: "INVENTORY_PROTECTION_SNAPSHOT",
      protection
    });
  });
});

describe("harvesting handler Giving Berry use", () => {
  it("rejects legacy resin use without debiting berries or starting recovery", async () => {
    const fixture = createConsumableFixture(99, 100);
    await fixture.handler({ type: "USE_CONSUMABLE", requestId: "resin-denied",
      itemId: "balsam_resin" } as unknown as Parameters<typeof fixture.handler>[0]);
    expect(fixture.consume).not.toHaveBeenCalled();
    expect(fixture.stageBalsamResinEffect).not.toHaveBeenCalled();
    expect(fixture.safeSendServerMessage).toHaveBeenCalledWith(fixture.socket,
      expect.objectContaining({ type: "ERROR", code: "CONSUMABLE_USE_REJECTED" }));
  });

  it("rejects a full-health player before consuming inventory", async () => {
    const fixture = createConsumableFixture(100, 100);

    await fixture.handler({
      type: "USE_CONSUMABLE",
      requestId: "use-resin-full-health",
      itemId: "giving_berry"
    });

    expect(fixture.consume).toHaveBeenCalledWith(
      "player-1",
      "use-resin-full-health",
      undefined,
      { atFullHealth: true }
    );
    expect(fixture.stageBalsamResinEffect).not.toHaveBeenCalled();
    expect(fixture.safeSendServerMessage).toHaveBeenCalledWith(
      fixture.socket,
      {
        type: "ERROR",
        requestId: "use-resin-full-health",
        code: "BALSAM_RESIN_FULL_HEALTH",
        message: "You are already at full health."
      }
    );
  });

  it("continues to consume berries when the player is missing health", async () => {
    const fixture = createConsumableFixture(99, 100);

    await fixture.handler({
      type: "USE_CONSUMABLE",
      requestId: "use-resin-damaged",
      itemId: "giving_berry"
    });

    expect(fixture.consume).toHaveBeenCalledWith(
      "player-1",
      "use-resin-damaged",
      undefined,
      { atFullHealth: false }
    );
    expect(fixture.stageBalsamResinEffect).toHaveBeenCalledOnce();
    expect(fixture.safeSendServerMessage).toHaveBeenCalledWith(
      fixture.socket,
      expect.objectContaining({
        type: "CONSUMABLE_USED",
        requestId: "use-resin-damaged",
        replayed: false
      })
    );
  });
});

describe("harvesting handler authoritative rejection outcomes", () => {
  it("returns a typed depleted-node result and immediately sends reconciliation", async () => {
    const socket = {};
    const safeSendServerMessage = vi.fn(() => true);
    const sendCollectiblesForPlayer = vi.fn(async () => undefined);
    const sendToGameplayCirclesContaining = vi.fn();
    const removeHarvestedTree = vi.fn();
    const removeGivingTree = vi.fn();
    const populationTreeTransition = {
      entityId: "tree:gone",
      entityKind: "tree" as const,
      stateRevision: 9,
      position: { lat: 35, lon: -106 },
      zoneId: "ppz2-eag1/000/000" as const,
      generationId: "00000000-0000-4000-8000-000000000201",
      cutoverRevision: 4
    };
    const handler = createHarvestingHandler({
      state: {
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 4
      },
      socket,
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: {
        activeConnectionIdForPlayer: vi.fn(() => "connection-1")
      },
      gameState: {
        getPlayer: vi.fn(() => ({
          playerId: "player-1",
          regionCode: "NM",
          position: { lat: 35, lon: -106 }
        })),
        playerIdsWhoseGameplayViewCircleContains:
          vi.fn(() => ["player-1"]),
        getResourceVision: vi.fn(() => null),
        getResourceVisionRevision: vi.fn(() => 0),
        getGameplayViewCircle: vi.fn(() => ({ generation: 0 }))
      },
      harvestSessions: {
        startHarvest: vi.fn(async () => {
          throw new CollectibleHarvestError(
            "HARVEST_NODE_ALREADY_HARVESTED",
            "This resource has already been harvested.",
            {
              nodeId: "tree:gone",
              stateRevision: 9,
              nodePosition: { lat: 35, lon: -106 },
              reconciliation: "remove-node",
              populationTreeTransition
            }
          );
        })
      },
      awaitCommittedPlayerWorldTransition: vi.fn(async () => true),
      safeSendServerMessage,
      sendCollectiblesForPlayer,
      sendToGameplayCirclesContaining,
      removeHarvestedTree,
      combat: {
        isPlayerAlive: vi.fn(() => true),
        removeGivingTree
      }
    } as never);

    await handler({
      type: "START_HARVEST",
      requestId: "harvest-gone",
      nodeId: "tree:gone",
      expectedPresentationOwner: "population",
      expectedEntityRevision: 9,
      expectedRelocationRevision: 0,
      expectedResourceVisionRevision: 0,
      expectedGameplayViewGeneration: 0
    });

    expect(safeSendServerMessage).toHaveBeenCalledWith(socket, {
      type: "ERROR",
      requestId: "harvest-gone",
      code: "HARVEST_NODE_ALREADY_HARVESTED",
      message: "This resource has already been harvested.",
      details: {
        nodeId: "tree:gone",
        stateRevision: 9,
        reconciliation: "remove-node"
      }
    });
    expect(sendToGameplayCirclesContaining).toHaveBeenCalledWith(
      { lat: 35, lon: -106 },
      {
        type: "COLLECTIBLE_REMOVED",
        nodeId: "tree:gone",
        playerId: "player-1",
        stateRevision: 9,
        serverTime: expect.any(Number)
      }
    );
    expect(removeHarvestedTree).toHaveBeenCalledWith(populationTreeTransition);
    expect(removeGivingTree).toHaveBeenCalledWith("tree:gone");
    expect(removeHarvestedTree.mock.invocationCallOrder[0])
      .toBeLessThan(sendToGameplayCirclesContaining.mock.invocationCallOrder[0]!);
    expect(sendCollectiblesForPlayer).toHaveBeenCalledOnce();
  });

  it("commits terminal mining cleanup before publishing the structured rejection", async () => {
    const safeSendServerMessage = vi.fn(() => true);
    const sendCollectiblesForPlayer = vi.fn(async () => undefined);
    const terminateActiveSessionAfterTerminalFailure = vi.fn(async () => ({
      sessionId: "session-mine",
      nodeId: "mine-1",
      statusBefore: "active" as const,
      statusAfter: "cancelled" as const,
      outcome: "cancelled" as const
    }));
    const completeMining = vi.fn(async () => {
      throw new RepeatableResourceError(
        "HARVEST_NODE_CHANGED",
        "Stone mine state changed during mining",
        undefined,
        {
          nodeId: "mine-1",
          stateRevision: 13,
          populationV2StateRevision: 6,
          authoritativeDistanceM: 12,
          reconciliation: "refresh-node"
        }
      );
    });
    const handler = createHarvestingHandler({
      state: { playerId: "player-1" },
      socket: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: { send: vi.fn() },
      gameState: {
        getPlayer: vi.fn(() => ({
          playerId: "player-1",
          regionCode: "NM",
          position: { lat: 35, lon: -106 }
        })),
        getResourceVision: vi.fn(() => null),
        getResourceVisionRevision: vi.fn(() => 9)
      },
      harvestSessions: {},
      repeatableResources: {
        hasSession: vi.fn(async () => true),
        completeMining,
        terminateActiveSessionAfterTerminalFailure
      },
      combat: { isPlayerAlive: vi.fn(() => true) },
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage,
      sendCollectiblesForPlayer
    } as never);

    await handler({
      type: "COMPLETE_HARVEST",
      requestId: "complete-mine",
      sessionId: "session-mine"
    });

    expect(terminateActiveSessionAfterTerminalFailure).toHaveBeenCalledWith(
      "player-1",
      "session-mine",
      "HARVEST_NODE_CHANGED"
    );
    expect(
      terminateActiveSessionAfterTerminalFailure.mock.invocationCallOrder[0]
    ).toBeLessThan(safeSendServerMessage.mock.invocationCallOrder[0]!);
    expect(safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "ERROR",
        code: "HARVEST_NODE_CHANGED",
        details: expect.objectContaining({
          nodeId: "mine-1",
          sessionId: "session-mine",
          populationV2StateRevision: 6,
          authoritativeDistanceM: 12,
          resourceVisionRevision: 9,
          sessionStatusBeforeCleanup: "active",
          sessionStatusAfterCleanup: "cancelled",
          terminalCleanupOutcome: "cancelled"
        })
      })
    );
    expect(sendCollectiblesForPlayer).toHaveBeenCalledOnce();
  });

  it("resyncs a lost mining completion and sends nearby personalized snapshots", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    };
    const send = vi.fn()
      .mockReturnValueOnce("closed")
      .mockReturnValue("sent");
    const sendCollectiblesForPlayer = vi.fn(async () => undefined);
    const sendToGameplayCirclesContaining = vi.fn();
    const completeMining = vi.fn(async () => ({
      session: {
        sessionId: "session-mine",
        playerId: "player-1",
        nodeId: "mine-1",
        resourceType: "stone",
        operationKey: "repeatable-harvest:session-mine",
        status: "completed",
        startedAt: "2026-07-28T20:00:00.000Z",
        completesAt: "2026-07-28T20:00:10.000Z",
        expiresAt: "2026-07-28T20:05:10.000Z",
        completedAt: "2026-07-28T20:00:10.000Z",
        cancelledAt: null
      },
      node: {
        id: "mine-1",
        nodeType: "stone_mine",
        lat: 35,
        lon: -106,
        yieldItemId: "stone",
        yieldQuantity: 1,
        state: "depleted",
        authorityRevision: 4,
        readyAt: "2026-07-29T01:50:10.000Z",
        timerVisibility: "visible"
      },
      inventory: {
        playerId: "player-1",
        revision: 12,
        items: [],
        totals: {
          wood: 0,
          stone: 1,
          food: 0,
          ore: 0,
          water: 0,
          leather: 0,
          giving_berry: 0,
          balsam_resin: 0,
          crude_oil: 0,
          crystal: 0, pearl: 0, atlas_shrine_shard: 0,
          enchantment_stone: 0
        }
      },
      replayed: false,
      masteryGrant: null,
      diagnostics: {
        startingHarvestRevision: 1,
        completionHarvestRevision: 2,
        startingCanonicalStateRevision: 1,
        completionCanonicalStateRevision: 2,
        inventoryRevisionBefore: 11,
        inventoryRevisionAfter: 12,
        inventoryOperation: "applied"
      }
    }));
    const handler = createHarvestingHandler({
      state: {
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 7
      },
      socket: {},
      logger,
      registry: {
        send,
        activeConnectionIdForPlayer: vi.fn(() => "connection-1")
      },
      gameState: {
        getPlayer: vi.fn((playerId: string) => ({
          playerId,
          regionCode: "NM",
          position: { lat: 35, lon: -106 }
        })),
        playerIdsWhoseGameplayViewCircleContains:
          vi.fn(() => ["player-1", "eligible-2", "hidden-3"]),
        getResourceVision: vi.fn(() => null),
        getResourceVisionRevision: vi.fn(() => 4)
      },
      harvestSessions: {},
      repeatableResources: {
        hasSession: vi.fn(async () => true),
        completeMining
      },
      combat: { isPlayerAlive: vi.fn(() => true) },
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage: vi.fn(() => true),
      sendCollectiblesForPlayer,
      sendToGameplayCirclesContaining
    } as never);

    await handler({
      type: "COMPLETE_HARVEST",
      requestId: "complete-mine",
      sessionId: "session-mine"
    });

    expect(completeMining).toHaveBeenCalledOnce();
    expect(sendCollectiblesForPlayer).toHaveBeenCalledTimes(3);
    expect(sendCollectiblesForPlayer).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: "eligible-2" })
    );
    expect(sendCollectiblesForPlayer).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: "hidden-3" })
    );
    expect(sendToGameplayCirclesContaining).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: "player-1",
        sessionId: "session-mine",
        inventoryRevision: 12,
        completionPublication: "closed",
        connectionGeneration: 7
      }),
      "mining-reward-committed-publication-failed"
    );
  });

  it("terminates only the matching session and explains a full mining inventory", async () => {
    const safeSendServerMessage = vi.fn(() => true);
    const sendCollectiblesForPlayer = vi.fn(async () => undefined);
    const terminateActiveSessionAfterTerminalFailure = vi.fn(async () => ({
      sessionId: "session-full",
      nodeId: "mine-1",
      statusBefore: "active" as const,
      statusAfter: "cancelled" as const,
      outcome: "cancelled" as const
    }));
    const handler = createHarvestingHandler({
      state: { playerId: "player-1" },
      socket: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: { send: vi.fn() },
      gameState: {
        getPlayer: vi.fn(() => ({
          playerId: "player-1",
          regionCode: "NM",
          position: { lat: 35, lon: -106 }
        })),
        getResourceVision: vi.fn(() => null),
        getResourceVisionRevision: vi.fn(() => 2)
      },
      harvestSessions: {},
      repeatableResources: {
        hasSession: vi.fn(async () => true),
        completeMining: vi.fn(async () => {
          throw new RepeatableResourceError(
            "HARVEST_INVENTORY_FULL",
            "Carrying capacity is full. Reduce carried weight and mine again.",
            undefined,
            {
              nodeId: "mine-1",
              maximumWeightGrams: "100000",
              currentWeightGrams: "100000",
              availableWeightGrams: "0",
              requestedYield: 1,
              reconciliation: "refresh-node"
            }
          );
        }),
        terminateActiveSessionAfterTerminalFailure
      },
      combat: { isPlayerAlive: vi.fn(() => true) },
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage,
      sendCollectiblesForPlayer
    } as never);

    await handler({
      type: "COMPLETE_HARVEST",
      requestId: "complete-full",
      sessionId: "session-full"
    });

    expect(terminateActiveSessionAfterTerminalFailure).toHaveBeenCalledWith(
      "player-1",
      "session-full",
      "HARVEST_INVENTORY_FULL"
    );
    expect(safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "ERROR",
        code: "HARVEST_INVENTORY_FULL",
        message: "Carrying capacity is full. Reduce carried weight and mine again.",
        details: expect.objectContaining({
          sessionId: "session-full",
          nodeId: "mine-1",
          maximumWeightGrams: "100000",
          currentWeightGrams: "100000",
          availableWeightGrams: "0",
          requestedYield: 1,
          terminalCleanupOutcome: "cancelled"
        })
      })
    );
    expect(sendCollectiblesForPlayer).toHaveBeenCalledOnce();
  });

  it("keeps too-early mining active and publishes the authoritative retry delay", async () => {
    const safeSendServerMessage = vi.fn(() => true);
    const terminateActiveSessionAfterTerminalFailure = vi.fn();
    const handler = createHarvestingHandler({
      state: { playerId: "player-1" },
      socket: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: { send: vi.fn() },
      gameState: {
        getPlayer: vi.fn(() => ({
          playerId: "player-1",
          regionCode: "NM",
          position: { lat: 35, lon: -106 }
        })),
        getResourceVision: vi.fn(() => null),
        getResourceVisionRevision: vi.fn(() => 3)
      },
      harvestSessions: {},
      repeatableResources: {
        hasSession: vi.fn(async () => true),
        completeMining: vi.fn(async () => {
          throw new RepeatableResourceError(
            "HARVEST_TOO_EARLY",
            "Mining is not complete yet",
            420
          );
        }),
        terminateActiveSessionAfterTerminalFailure
      },
      combat: { isPlayerAlive: vi.fn(() => true) },
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage,
      sendCollectiblesForPlayer: vi.fn(async () => undefined)
    } as never);

    await handler({
      type: "COMPLETE_HARVEST",
      requestId: "complete-early",
      sessionId: "session-early"
    });

    expect(terminateActiveSessionAfterTerminalFailure).not.toHaveBeenCalled();
    expect(safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "ERROR",
        code: "HARVEST_TOO_EARLY",
        details: expect.objectContaining({ retryAfterMs: 420 })
      })
    );
  });

  it("resumes the player's existing mining session instead of leaving it server-only", async () => {
    const safeSendServerMessage = vi.fn(() => true);
    const session = {
      ...harvestSession("wood"),
      sessionId: "session-existing-mine",
      nodeId: "mine-existing",
      resourceType: "stone" as const,
      status: "active" as const,
      completedAt: null
    };
    const startMining = vi.fn();
    const handler = createHarvestingHandler({
      state: { playerId: "player-1" },
      socket: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: {},
      gameState: {
        getPlayer: vi.fn(() => ({
          playerId: "player-1",
          regionCode: "NM",
          position: { lat: 35, lon: -106 },
          relocationRevision: 0
        })),
        getResourceVision: vi.fn(() => null),
        getResourceVisionRevision: vi.fn(() => 0),
        getGameplayViewCircle: vi.fn(() => ({ generation: 0 }))
      },
      harvestSessions: {
        activeSessionForPlayer: vi.fn(async () => null)
      },
      repeatableResources: {
        hasNode: vi.fn(async () => true),
        activeSessionForPlayer: vi.fn(async () => session),
        startMining
      },
      awaitCommittedPlayerWorldTransition: vi.fn(async () => true),
      safeSendServerMessage,
      sendCollectiblesForPlayer: vi.fn(async () => undefined)
    } as never);

    await handler({
      type: "START_HARVEST",
      requestId: "start-new-mine",
      nodeId: "mine-new",
      expectedPresentationOwner: "repeatable-resource",
      expectedEntityRevision: 1,
      expectedRelocationRevision: 0,
      expectedResourceVisionRevision: 0,
      expectedGameplayViewGeneration: 0
    });

    expect(startMining).not.toHaveBeenCalled();
    expect(safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      {
        type: "HARVEST_STARTED",
        requestId: "resume",
        session,
        serverTime: expect.any(Number)
      }
    );
  });

  it("self-heals the warm tree cache when completion finds an existing ghost", async () => {
    const socket = {};
    const safeSendServerMessage = vi.fn(() => true);
    const sendCollectiblesForPlayer = vi.fn(async () => undefined);
    const sendToGameplayCirclesContaining = vi.fn();
    const removeHarvestedTree = vi.fn();
    const populationTreeTransition = {
      entityId: "tree:gone",
      entityKind: "tree" as const,
      stateRevision: 9,
      position: { lat: 35, lon: -106 },
      zoneId: "ppz2-eag1/000/000" as const,
      generationId: "00000000-0000-4000-8000-000000000201",
      cutoverRevision: 4
    };
    const handler = createHarvestingHandler({
      state: {
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 4
      },
      socket,
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: {
        activeConnectionIdForPlayer: vi.fn(() => "connection-1")
      },
      gameState: {
        getPlayer: vi.fn(() => ({
          playerId: "player-1",
          regionCode: "NM",
          position: { lat: 35, lon: -106 }
        })),
        getResourceVision: vi.fn(() => null),
        getResourceVisionRevision: vi.fn(() => 0)
      },
      harvestSessions: {
        completeHarvest: vi.fn(async () => {
          throw new CollectibleHarvestError(
            "HARVEST_NODE_ALREADY_HARVESTED",
            "This resource has already been harvested.",
            {
              nodeId: "tree:gone",
              stateRevision: 9,
              nodePosition: { lat: 35, lon: -106 },
              reconciliation: "remove-node",
              populationTreeTransition
            }
          );
        })
      },
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage,
      sendCollectiblesForPlayer,
      sendToGameplayCirclesContaining,
      removeHarvestedTree
    } as never);

    await handler({
      type: "COMPLETE_HARVEST",
      requestId: "complete-ghost",
      sessionId: "session-ghost"
    });

    expect(removeHarvestedTree).toHaveBeenCalledWith(populationTreeTransition);
    expect(sendToGameplayCirclesContaining).toHaveBeenCalledWith(
      populationTreeTransition.position,
      expect.objectContaining({
        type: "COLLECTIBLE_REMOVED",
        nodeId: populationTreeTransition.entityId
      })
    );
    expect(sendCollectiblesForPlayer).toHaveBeenCalledOnce();
  });

  it("rejects an old connection generation before it can start a harvest", async () => {
    const socket = {};
    const safeSendServerMessage = vi.fn(() => true);
    const startHarvest = vi.fn();
    const handler = createHarvestingHandler({
      state: {
        playerId: "player-1",
        connectionId: "connection-old",
        connectionGeneration: 3
      },
      socket,
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: {
        activeConnectionIdForPlayer: vi.fn(() => "connection-new")
      },
      harvestSessions: { startHarvest },
      safeSendServerMessage
    } as never);

    await handler({
      type: "START_HARVEST",
      requestId: "harvest-stale",
      nodeId: "tree:one",
      expectedPresentationOwner: "population",
      expectedEntityRevision: 0,
      expectedRelocationRevision: 0,
      expectedResourceVisionRevision: 0,
      expectedGameplayViewGeneration: 0
    });

    expect(safeSendServerMessage).toHaveBeenCalledWith(socket, {
      type: "ERROR",
      requestId: "harvest-stale",
      code: "HARVEST_STALE_CONNECTION_GENERATION",
      message: "This gathering request belongs to a replaced connection."
    });
    expect(startHarvest).not.toHaveBeenCalled();
  });
});

describe("harvesting handler dropped-item authority", () => {
  it("routes owner Manor equipment drops locally and denies guest pickup", async () => {
    const socket = {};
    const safeSendServerMessage = vi.fn(() => true);
    const manorId = "00000000-0000-4000-8000-000000000077";
    const manorSessionId = "00000000-0000-4000-8000-000000000078";
    const equipmentInstanceId = "00000000-0000-4000-8000-000000000079";
    const dropId = "00000000-0000-4000-8000-000000000080";
    let accessSource: "OWNER" | "PARTY" = "OWNER";
    const drop = {
      dropId,
      droppedBy: "player-1",
      regionCode: `interior:manor:${manorId}`,
      zoneId: `manor:${manorId}:manor_main_room`,
      pileId: "manor-pile",
      pileOrder: 0,
      itemId: "starter_staff",
      equipmentInstanceId,
      variant: null,
      quantity: 1,
      maxStack: 1,
      status: "active" as const,
      lat: 0,
      lon: 0,
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-24T00:10:00.000Z",
      pickedUpBy: null,
      pickedUpAt: null,
      manorId,
      spaceId: "manor_main_room" as const,
      localX: 320,
      localY: 420
    };
    const dropManorEquipment = vi.fn(async () => ({ drop, replayed: false }));
    const pickupDroppedEquipment = vi.fn(async () => ({ drop: { ...drop, status: "picked_up" as const, quantity: 0 }, replayed: false }));
    const handler = createHarvestingHandler({
      state: {
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 1
      },
      socket,
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: {
        isActivePlayerConnection: vi.fn(() => true),
        activeConnectionIdForPlayer: vi.fn(() => "connection-1"),
        send: vi.fn()
      },
      gameState: {
        getPlayer: vi.fn(() => ({
          playerId: "player-1",
          regionCode: "GLOBAL",
          position: { lat: 35, lon: -106 }
        }))
      },
      playerAuthorityFence: {
        run: vi.fn(async (_playerId: string, operation: () => Promise<unknown>) => operation())
      },
      manorRuntime: {
        get: vi.fn(() => ({
          manorId,
          sessionId: manorSessionId,
          spaceId: "manor_main_room",
          position: { x: 320, y: 420 },
          accessSource
        })),
        playerIdsInManor: vi.fn(() => ["player-1"])
      },
      droppedItems: {
        dropManorEquipment,
        pickupDroppedEquipment,
        isEquipmentDrop: vi.fn(async () => true),
        listActiveManorDrops: vi.fn(async () => []),
        listActiveManorEquipment: vi.fn(async () => [])
      },
      equipment: {
        refreshInventorySlots: vi.fn(async () => ({ playerId: "player-1" }))
      },
      broadcastDroppedItems: vi.fn(async () => undefined),
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage
    } as never);

    await handler({
      type: "DROP_EQUIPMENT",
      requestId: "00000000-0000-4000-8000-000000000081",
      equipmentInstanceId,
      expectedEquipmentRevision: 3,
      manorSessionId
    });
    expect(dropManorEquipment).toHaveBeenCalledWith("player-1", expect.objectContaining({
      manorId,
      spaceId: "manor_main_room",
      position: { x: 320, y: 420 }
    }));
    expect(safeSendServerMessage).toHaveBeenCalledWith(
      socket,
      expect.objectContaining({ type: "EQUIPMENT_DROP_RESULT", drop })
    );

    accessSource = "PARTY";
    await handler({
      type: "PICKUP_DROPPED_ITEM",
      requestId: "00000000-0000-4000-8000-000000000082",
      dropId,
      manorSessionId,
      pickup: { mode: "all" }
    });
    expect(pickupDroppedEquipment).not.toHaveBeenCalled();
    expect(safeSendServerMessage).toHaveBeenLastCalledWith(
      socket,
      expect.objectContaining({
        type: "ERROR",
        code: "DROP_EQUIPMENT_NOT_ELIGIBLE"
      })
    );

    accessSource = "OWNER";
    await handler({
      type: "PICKUP_DROPPED_ITEM",
      requestId: "00000000-0000-4000-8000-000000000083",
      dropId,
      manorSessionId,
      pickup: { mode: "all" }
    });
    expect(pickupDroppedEquipment).toHaveBeenCalledWith(
      expect.objectContaining({ manorId, spaceId: "manor_main_room", localPosition: { x: 320, y: 420 } }),
      "00000000-0000-4000-8000-000000000083",
      dropId
    );
    expect(safeSendServerMessage).toHaveBeenLastCalledWith(
      socket,
      expect.objectContaining({ type: "DROPPED_EQUIPMENT_PICKUP_RESULT" })
    );
  });

  it("serializes pickup with portal authority and targets the changed gameplay area", async () => {
    const socket = {};
    const safeSendServerMessage = vi.fn(() => true);
    const pickupDroppedItem = vi.fn(async () => ({
      drop: {
        dropId: "drop-1",
        itemId: "leather",
        quantity: 15,
        lat: 35,
        lon: -106
      },
      inventory: playerInventory("wood"),
      replayed: false,
      requestedQuantity: 15,
      pickedUpQuantity: 15,
      remainingQuantity: 0,
      removed: true
    }));
    const run = vi.fn(async (_playerId: string, operation: () => Promise<unknown>) =>
      operation()
    );
    const broadcastDroppedItems = vi.fn(async () => undefined);
    const handler = createHarvestingHandler({
      state: {
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 4
      },
      socket,
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: {
        isActivePlayerConnection: vi.fn(() => true),
        activeConnectionIdForPlayer: vi.fn(() => "connection-1")
      },
      gameState: {
        isWorldPresent: vi.fn(() => true),
        getPlayer: vi.fn(() => ({
          playerId: "player-1",
          regionCode: "package-a",
          position: { lat: 35, lon: -106 }
        }))
      },
      playerAuthorityFence: { run },
      playerLocations: {
        load: vi.fn(async () => ({
          kind: "world",
          regionCode: "package-a",
          zoneId: "world:package-a",
          position: { lat: 35, lon: -106 },
          revision: 8
        }))
      },
      droppedItems: { isEquipmentDrop: vi.fn(async () => false), pickupDroppedItem },
      broadcastDroppedItems,
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage
    } as never);

    await handler({
      type: "PICKUP_DROPPED_ITEM",
      requestId: "pickup-1",
      dropId: "drop-1",
      pickup: { mode: "all" }
    });

    expect(run).toHaveBeenCalledOnce();
    expect(pickupDroppedItem).toHaveBeenCalledOnce();
    expect(broadcastDroppedItems).toHaveBeenCalledWith([{ lat: 35, lon: -106 }]);
    expect(safeSendServerMessage).toHaveBeenCalledWith(
      socket,
      expect.objectContaining({ type: "DROPPED_ITEM_PICKUP_RESULT" })
    );
  });

  it("does not let an interior login mutate world loot", async () => {
    const socket = {};
    const safeSendServerMessage = vi.fn(() => true);
    const pickupDroppedItem = vi.fn();
    const handler = createHarvestingHandler({
      state: {
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 4
      },
      socket,
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: {
        isActivePlayerConnection: vi.fn(() => true),
        activeConnectionIdForPlayer: vi.fn(() => "connection-1")
      },
      gameState: {
        isWorldPresent: vi.fn(() => false),
        getPlayer: vi.fn(() => ({
          playerId: "player-1",
          regionCode: "package-a",
          position: { lat: 35, lon: -106 }
        }))
      },
      playerAuthorityFence: {
        run: vi.fn(async (_playerId: string, operation: () => Promise<unknown>) =>
          operation()
        )
      },
      playerLocations: {
        load: vi.fn(async () => ({
          kind: "interior",
          locationType: "manor",
          locationId: "manor-1",
          instanceId: "manor-1",
          spaceId: "main",
          regionCode: "interior:manor-1",
          zoneId: "interior:manor-1:main",
          position: { x: 1, y: 1 },
          revision: 9,
          lastPortalId: "manor:entry"
        }))
      },
      droppedItems: { isEquipmentDrop: vi.fn(async () => false), pickupDroppedItem },
      broadcastDroppedItems: vi.fn(async () => undefined),
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage
    } as never);

    await handler({
      type: "PICKUP_DROPPED_ITEM",
      requestId: "pickup-interior",
      dropId: "drop-1",
      pickup: { mode: "all" }
    });

    expect(pickupDroppedItem).not.toHaveBeenCalled();
    expect(safeSendServerMessage).toHaveBeenCalledWith(
      socket,
      expect.objectContaining({
        type: "ERROR",
        code: "DROPPED_ITEM_OUT_OF_RANGE"
      })
    );
  });

  it("resynchronizes a replacement connection without forwarding the old pickup result", async () => {
    const socket = {};
    const safeSendServerMessage = vi.fn(() => true);
    const sendToConnection = vi.fn();
    const sendDroppedItemsForPlayer = vi.fn(async () => undefined);
    let activeConnectionId = "connection-a";
    const inventorySnapshot = playerInventory("wood");
    const handler = createHarvestingHandler({
      state: {
        playerId: "player-1",
        connectionId: "connection-a",
        connectionGeneration: 4
      },
      socket,
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: {
        isActivePlayerConnection: vi.fn((_playerId: string, connectionId: string) =>
          connectionId === activeConnectionId
        ),
        activeConnectionIdForPlayer: vi.fn(() => activeConnectionId),
        sendToConnection
      },
      gameState: {
        isWorldPresent: vi.fn(() => true),
        getPlayer: vi.fn(() => ({
          playerId: "player-1",
          regionCode: "package-a",
          position: { lat: 35, lon: -106 }
        }))
      },
      playerAuthorityFence: {
        run: vi.fn(async (_playerId: string, operation: () => Promise<unknown>) =>
          operation()
        )
      },
      playerLocations: {
        load: vi.fn(async () => ({
          kind: "world",
          regionCode: "package-a",
          zoneId: "world:package-a",
          position: { lat: 35, lon: -106 },
          revision: 8
        }))
      },
      inventory: { getInventorySnapshot: vi.fn(async () => inventorySnapshot) },
      droppedItems: {
        isEquipmentDrop: vi.fn(async () => false),
        pickupDroppedItem: vi.fn(async () => {
          activeConnectionId = "connection-b";
          return {
            drop: {
              dropId: "drop-1",
              itemId: "leather",
              quantity: 15,
              lat: 35,
              lon: -106
            },
            inventory: inventorySnapshot,
            replayed: false,
            requestedQuantity: 15,
            pickedUpQuantity: 15,
            remainingQuantity: 0,
            removed: true
          };
        })
      },
      broadcastDroppedItems: vi.fn(async () => undefined),
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage,
      sendDroppedItemsForPlayer
    } as never);

    await handler({
      type: "PICKUP_DROPPED_ITEM",
      requestId: "pickup-replaced",
      dropId: "drop-1",
      pickup: { mode: "all" }
    });

    expect(safeSendServerMessage).not.toHaveBeenCalledWith(
      socket,
      expect.objectContaining({ type: "DROPPED_ITEM_PICKUP_RESULT" })
    );
    expect(sendToConnection).toHaveBeenCalledWith(
      "connection-b",
      expect.objectContaining({
        type: "PLAYER_RESOURCES_UPDATED",
        inventory: inventorySnapshot
      })
    );
    expect(sendDroppedItemsForPlayer).toHaveBeenCalledWith(
      "player-1",
      expect.any(Function)
    );
  });

  it("refreshes drops with the existing nearby-world request", async () => {
    const sendCollectiblesForPlayer = vi.fn(async () => undefined);
    const sendDroppedItemsForPlayer = vi.fn(async () => undefined);
    const handler = createHarvestingHandler({
      state: { playerId: "player-1" },
      socket: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      gameState: { getPlayer: vi.fn(() => ({ playerId: "player-1" })) },
      collectibles: {},
      droppedItems: {},
      awaitCommittedPlayerWorldTransition: vi.fn(async () => true),
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage: vi.fn(() => true),
      sendCollectiblesForPlayer,
      sendDroppedItemsForPlayer
    } as never);

    await handler({ type: "REQUEST_NEARBY_COLLECTIBLES", requestId: "refresh-nearby" });

    expect(sendCollectiblesForPlayer).toHaveBeenCalledOnce();
    expect(sendDroppedItemsForPlayer).toHaveBeenCalledWith("player-1");
  });
});

function createConsumableFixture(currentHealth: number, maxHealth: number) {
  const socket = {};
  const safeSendServerMessage = vi.fn(() => true);
  const effect = {
    effectId: "effect-1",
    playerId: "player-1",
    startedAt: "2026-07-24T00:00:00.000Z",
    endsAt: "2026-07-24T00:00:09.600Z"
  };
  const consume = vi.fn(async (
    _playerId: string,
    _requestId: string,
    _stackId: string | undefined,
    options: { atFullHealth?: boolean }
  ) => {
    if (options.atFullHealth) {
      throw new BalsamResinError(
        "BALSAM_RESIN_FULL_HEALTH",
        "You are already at full health."
      );
    }
    return {
      effect,
      inventory: playerInventory("balsam_resin"),
      replayed: false
    };
  });
  const stageBalsamResinEffect = vi.fn();
  const handler = createHarvestingHandler({
    state: { playerId: "player-1" },
    socket,
    logger: { warn: vi.fn() },
    combat: {
      isPlayerAlive: vi.fn(() => true),
      entity: vi.fn(() => ({ currentHealth, maxHealth })),
      stageBalsamResinEffect
    },
    balsamResin: { consume },
    rejectDuringPlayerWorldTransition: vi.fn(() => false),
    safeSendServerMessage
  } as never);
  return {
    handler,
    socket,
    consume,
    stageBalsamResinEffect,
    safeSendServerMessage
  };
}

function createFixture(input: Readonly<{
  session: HarvestSessionSnapshot;
  node: CollectibleNode;
  nodeRemoved: boolean;
  rewardItemId: "wood" | "balsam_resin";
  replayed?: boolean;
  transitionMissing?: boolean;
  withSecondaryGrants?: boolean;
  refreshFails?: boolean;
  overflowQuantity?: number;
}>) {
  const inventory = playerInventory(input.rewardItemId);
  const socket = {};
  const safeSendServerMessage = vi.fn(() => true);
  const sendToGameplayCirclesContaining = vi.fn();
  const sendCollectiblesForPlayer = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const broadcastDroppedItems = vi.fn(async () => undefined);
  const registry = { send: vi.fn() };
  const refreshAuthoritativePlayerStats = vi.fn(async () => {
    if (input.refreshFails) throw new Error("injected equipment refresh failure");
    return {
      progression: { playerId: "player-1" },
      equipment: { playerId: "player-1" }
    };
  });
  const combat = {
    isPlayerAlive: vi.fn(() => true),
    removeGivingTree: vi.fn()
  };
  const removeHarvestedTree = vi.fn((transition: { entityId: string }) => {
    combat.removeGivingTree(transition.entityId);
  });
  const harvestSessions = {
    completeHarvest: vi.fn(async () => ({
      session: input.session,
      nodeId: input.node.id,
      nodePosition: { lat: input.node.lat, lon: input.node.lon },
      inventory,
      xpGrant: input.withSecondaryGrants
        ? {
            levelsGained: [],
            progression: { playerId: "player-1" }
          }
        : null,
      masteryGrant: input.withSecondaryGrants
        ? { snapshot: { playerId: "player-1" } }
        : null,
      reward: { itemId: input.rewardItemId, quantity: 1 },
      node: input.replayed ? null : input.node,
      nodeRemoved: input.nodeRemoved,
      populationTreeTransition: input.nodeRemoved && !input.transitionMissing
        ? {
            entityId: input.node.id,
            entityKind: "tree" as const,
            stateRevision: input.node.treeLifeRevision!,
            position: { lat: input.node.lat, lon: input.node.lon },
            zoneId: "ppz2-eag1/000/000" as const,
            generationId: "00000000-0000-4000-8000-000000000201",
            cutoverRevision: 4
          }
        : null,
      droppedItems: input.overflowQuantity
        ? [{
            dropId: "00000000-0000-4000-8000-000000000301",
            droppedBy: "player-1",
            regionCode: "package:tree",
            zoneId: "world:package:tree",
            pileId: "harvest:test",
            pileOrder: 0,
            itemId: input.rewardItemId,
            variant: null,
            quantity: input.overflowQuantity,
            status: "active" as const,
            lat: input.node.lat,
            lon: input.node.lon,
            createdAt: "2026-07-24T00:00:00.600Z",
            expiresAt: "2026-07-24T00:05:00.600Z",
            pickedUpBy: null,
            pickedUpAt: null
          }]
        : [],
      replayed: input.replayed ?? false
    }))
  };
  const handler = createHarvestingHandler({
    state: { playerId: "player-1" },
    socket,
    logger,
    registry,
    gameState: {
      getPlayer: vi.fn(() => ({
        playerId: "player-1",
        regionCode: "NM",
        position: { lat: input.node.lat, lon: input.node.lon }
      })),
      getResourceVision: vi.fn(() => null)
    },
    harvestSessions,
    combat,
    ...(input.withSecondaryGrants
      ? { progression: {}, equipment: {} }
      : {}),
    broadcastDroppedItems,
    refreshAuthoritativePlayerStats,
    awaitCommittedPlayerWorldTransition: vi.fn(async () => true),
    rejectDuringPlayerWorldTransition: vi.fn(() => false),
    safeSendServerMessage,
    sendCollectiblesForPlayer,
    sendToGameplayCirclesContaining,
    removeHarvestedTree
  } as never);
  return {
    handler,
    session: input.session,
    socket,
    safeSendServerMessage,
    sendToGameplayCirclesContaining,
    combat,
    removeHarvestedTree,
    refreshAuthoritativePlayerStats,
    sendCollectiblesForPlayer,
    registry,
    logger,
    broadcastDroppedItems
  };
}

function harvestSession(
  resourceType: "wood" | "balsam_resin"
): HarvestSessionSnapshot {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    playerId: "player-1",
    nodeId: "tree-1",
    resourceType,
    operationKey: `harvest:${resourceType}:tree-1`,
    status: "completed",
    startedAt: "2026-07-24T00:00:00.000Z",
    completesAt: "2026-07-24T00:00:00.600Z",
    expiresAt: "2026-07-24T00:05:00.600Z",
    completedAt: "2026-07-24T00:00:00.600Z",
    cancelledAt: null
  };
}

function collectible(
  overrides: Partial<CollectibleNode> = {}
): CollectibleNode {
  return {
    id: "tree-1",
    type: "wood",
    lat: 35,
    lon: -106,
    quantity: 4,
    state: "available",
    createdAt: "",
    harvestedAt: null,
    sourceCellId: "population-v2:zone-1",
    waterKind: null,
    ...overrides
  };
}

function playerInventory(
  itemId: "wood" | "balsam_resin"
): PlayerInventorySnapshot {
  return {
    playerId: "player-1",
    revision: 0,
    items: [{
      playerId: "player-1",
      resourceType: itemId,
      variant: null,
      quantity: 1
    }],
    totals: {
      wood: itemId === "wood" ? 1 : 0,
      stone: 0,
      coal: 0,
      iron: 0,
      sulfur: 0,
      iron_bar: 0,
      venomsteel_bar: 0,
      venomsteel_core: 0,
      fire_feather: 0, tempest_quill: 0, ice_feather: 0,
      fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0,
      food: 0,
      ore: 0,
      water: 0,
      leather: 0,
      deer_hide: 0,
      hog_hide: 0,
      wolf_pelt: 0,
      bear_hide: 0,
    alligator_hide: 0,
    squid_flesh: 0,
    crab_carapace: 0,
    raw_meat: 0,
    shell: 0,
      giving_berry: 0,
      balsam_resin: itemId === "balsam_resin" ? 1 : 0,
      crude_oil: 0,
      jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0,
      crystal: 0, pearl: 0, atlas_shrine_shard: 0,
      enchantment_stone: 0
    }
  };
}
