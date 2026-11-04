import { describe, expect, it, vi } from "vitest";
import { destinationPoint } from "@ash-atlas/shared";

import { CollectibleHarvestError } from "./collectibles.js";
import {
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import {
  type PopulationZoneV2BackendZoneActivation,
  type PopulationZonesV2ActivationDelta,
  type PopulationZonesV2RuntimeBackend,
  PopulationZonesV2Runtime
} from "./populationZonesV2Runtime.js";
import { createHarvestingHandler } from "../realtime/handlers/harvestingHandler.js";

const TREE_POSITION = { lat: 35.0844, lon: -106.6504 };
const TREE_ZONE_ID = populationZoneV2IdForPoint(TREE_POSITION);
const TREE_ID = "00000000-0000-4000-8000-000000000101";
const GENERATION_ID = "00000000-0000-4000-8000-000000000201";
const NEXT_GENERATION_ID = "00000000-0000-4000-8000-000000000202";
const SAP_CRAWLER_ID = "00000000-0000-4000-8000-000000000301";

describe("harvested Population V2 tree regression", () => {
  it("never republishes a harvested tree to returning, reconnecting, or fresh clients", async () => {
    const backend = new HarvestedTreeBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 0
    });
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });

    const initial = await runtime.relocate(relocation({
      connectionId: "connection-original",
      connectionGeneration: 1,
      relocationRevision: 1,
      center: TREE_POSITION,
      trigger: "world-entry"
    }));
    expect(initial?.upserts.map((entity) => entity.entityId)).toContain(TREE_ID);

    backend.harvestTree();
    const safeSendServerMessage = vi.fn(() => true);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const handler = createHarvestingHandler({
      state: {
        playerId: "player-original",
        connectionId: "connection-original",
        connectionGeneration: 1
      },
      socket: {},
      logger,
      registry: {
        activeConnectionIdForPlayer: vi.fn(() => "connection-original"),
        send: vi.fn()
      },
      gameState: {
        getPlayer: vi.fn(() => ({
          playerId: "player-original",
          regionCode: "NM",
          position: TREE_POSITION
        })),
        getResourceVision: vi.fn(() => null)
      },
      harvestSessions: {
        completeHarvest: vi.fn(async () => ({
          session: {
            sessionId: "11111111-1111-4111-8111-111111111111",
            playerId: "player-original",
            nodeId: TREE_ID,
            resourceType: "wood",
            operationKey: `harvest:wood:${TREE_ID}`,
            status: "completed",
            startedAt: "2026-07-27T00:00:00.000Z",
            completesAt: "2026-07-27T00:00:03.000Z",
            expiresAt: "2026-07-27T00:00:13.000Z",
            completedAt: "2026-07-27T00:00:03.000Z",
            cancelledAt: null
          },
          nodeId: TREE_ID,
          nodePosition: TREE_POSITION,
          inventory: { playerId: "player-original", items: [], totals: {} },
          xpGrant: {
            levelsGained: [],
            progression: { playerId: "player-original" }
          },
          masteryGrant: null,
          reward: { itemId: "wood", quantity: 4 },
          node: null,
          nodeRemoved: true,
          populationTreeTransition: treeTransition(),
          replayed: false
        }))
      },
      combat: { isPlayerAlive: vi.fn(() => true) },
      progression: {},
      equipment: {},
      refreshAuthoritativePlayerStats: vi.fn(async () => {
        throw new Error("injected equipment refresh failure");
      }),
      rejectDuringPlayerWorldTransition: vi.fn(() => false),
      safeSendServerMessage,
      sendCollectiblesForPlayer: vi.fn(async () => undefined),
      sendToGameplayCirclesContaining: vi.fn(),
      removeHarvestedTree: (transition: ReturnType<typeof treeTransition>) =>
        runtime.removeHarvestedTree(transition)
    } as never);
    await handler({
      type: "COMPLETE_HARVEST",
      requestId: "complete-with-equipment-failure",
      sessionId: "11111111-1111-4111-8111-111111111111"
    });
    expect(safeSendServerMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "HARVEST_COMPLETED" }),
      logger,
      expect.any(Object)
    );
    expect(safeSendServerMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "ERROR" })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: "equipment-progression-refresh" }),
      "post-commit harvest work failed"
    );

    expect(published.some((delta) =>
      delta.connectionId === "connection-original"
      && delta.removedEntityIds.includes(TREE_ID)
    )).toBe(true);
    expect(runtime.snapshot()).toMatchObject({
      indexedEntities: 0,
      projectedEntities: 0,
      harvestedTreeFences: 1
    });

    const beforeOriginalResync = published.length;
    expect(runtime.republishConnection({
      playerId: "player-original",
      connectionId: "connection-original",
      connectionGeneration: 1,
      preparationGeneration: initial!.preparationGeneration,
      relocationRevision: 1,
      resourceVisionRevision: 1
    }).status).toBe("republished");
    expect(published.slice(beforeOriginalResync).flatMap((delta) => delta.upserts)
      .map((entity) => entity.entityId)).not.toContain(TREE_ID);

    const away = destinationPoint(TREE_POSITION, 90, 2_000);
    await runtime.relocate(relocation({
      connectionId: "connection-original",
      connectionGeneration: 1,
      relocationRevision: 2,
      center: away,
      trigger: "flag-travel"
    }));
    const returned = await runtime.relocate(relocation({
      connectionId: "connection-original",
      connectionGeneration: 1,
      relocationRevision: 3,
      center: TREE_POSITION,
      trigger: "flag-travel"
    }));
    expect(returned?.upserts.map((entity) => entity.entityId))
      .not.toContain(TREE_ID);

    runtime.releaseConnection("connection-original", 1);
    const reconnected = await runtime.relocate(relocation({
      connectionId: "connection-original",
      connectionGeneration: 2,
      relocationRevision: 4,
      center: TREE_POSITION,
      trigger: "reconnect"
    }));
    expect(reconnected?.upserts.map((entity) => entity.entityId))
      .not.toContain(TREE_ID);

    const fresh = await runtime.relocate(relocation({
      playerId: "player-fresh",
      connectionId: "connection-fresh",
      connectionGeneration: 1,
      relocationRevision: 1,
      center: TREE_POSITION,
      trigger: "world-entry"
    }));
    expect(fresh?.upserts.map((entity) => entity.entityId))
      .not.toContain(TREE_ID);

    const beforeResync = published.length;
    expect(runtime.republishConnection({
      playerId: "player-fresh",
      connectionId: "connection-fresh",
      connectionGeneration: 1,
      preparationGeneration: fresh!.preparationGeneration,
      relocationRevision: 1,
      resourceVisionRevision: 1
    }).status).toBe("republished");
    expect(published.slice(beforeResync).flatMap((delta) => delta.upserts)
      .map((entity) => entity.entityId)).not.toContain(TREE_ID);

    runtime.releaseConnection("connection-original", 2);
    runtime.releaseConnection("connection-fresh", 1);
    for (let index = 0; index < 5; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
    }
    expect(runtime.snapshot().warmZones).toBe(0);
    const woke = await runtime.relocate(relocation({
      playerId: "player-wake",
      connectionId: "connection-wake",
      connectionGeneration: 1,
      relocationRevision: 1,
      center: TREE_POSITION,
      trigger: "world-entry"
    }));
    expect(woke?.upserts.map((entity) => entity.entityId)).not.toContain(TREE_ID);

    await runtime.close();
    const restarted = new PopulationZonesV2Runtime(backend);
    const afterRestart = await restarted.relocate(relocation({
      playerId: "player-restart",
      connectionId: "connection-restart",
      connectionGeneration: 1,
      relocationRevision: 1,
      center: TREE_POSITION,
      trigger: "world-entry"
    }));
    expect(afterRestart?.upserts.map((entity) => entity.entityId))
      .not.toContain(TREE_ID);
    await restarted.close();
  });

  it("evicts an existing ghost when the harvested tree is clicked", async () => {
    const backend = new HarvestedTreeBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });
    const initial = await runtime.relocate(relocation({
      connectionId: "connection-ghost",
      connectionGeneration: 1,
      relocationRevision: 1,
      center: TREE_POSITION,
      trigger: "world-entry"
    }));
    expect(initial?.upserts.map((entity) => entity.entityId)).toContain(TREE_ID);
    backend.harvestTree();

    const sendCollectiblesForPlayer = vi.fn(async () => undefined);
    const sendToGameplayCirclesContaining = vi.fn();
    const handler = createHarvestingHandler({
      state: {
        playerId: "player-original",
        connectionId: "connection-ghost",
        connectionGeneration: 1
      },
      socket: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      registry: {
        activeConnectionIdForPlayer: vi.fn(() => "connection-ghost")
      },
      gameState: {
        getPlayer: vi.fn(() => ({
          playerId: "player-original",
          regionCode: "NM",
          position: TREE_POSITION,
          relocationRevision: 1
        })),
        getResourceVision: vi.fn(() => null),
        getResourceVisionRevision: vi.fn(() => 1),
        getGameplayViewCircle: vi.fn(() => ({ generation: 1 }))
      },
      harvestSessions: {
        startHarvest: vi.fn(async () => {
          throw new CollectibleHarvestError(
            "HARVEST_NODE_ALREADY_HARVESTED",
            "This resource has already been harvested.",
            {
              nodeId: TREE_ID,
              stateRevision: 1,
              nodePosition: TREE_POSITION,
              reconciliation: "remove-node",
              populationTreeTransition: treeTransition()
            }
          );
        })
      },
      awaitCommittedPlayerWorldTransition: vi.fn(async () => true),
      safeSendServerMessage: vi.fn(() => true),
      sendCollectiblesForPlayer,
      sendToGameplayCirclesContaining,
      removeHarvestedTree: (transition: ReturnType<typeof treeTransition>) =>
        runtime.removeHarvestedTree(transition)
    } as never);
    await handler({
      type: "START_HARVEST",
      requestId: "click-existing-ghost",
      nodeId: TREE_ID,
      expectedPresentationOwner: "population",
      expectedEntityRevision: 1,
      expectedRelocationRevision: 1,
      expectedResourceVisionRevision: 1,
      expectedGameplayViewGeneration: 1
    });

    expect(runtime.snapshot()).toMatchObject({
      indexedEntities: 0,
      projectedEntities: 0,
      harvestedTreeFences: 1
    });
    expect(sendToGameplayCirclesContaining).toHaveBeenCalledWith(
      TREE_POSITION,
      expect.objectContaining({
        type: "COLLECTIBLE_REMOVED",
        nodeId: TREE_ID
      })
    );
    expect(sendCollectiblesForPlayer).toHaveBeenCalledOnce();

    const beforeResync = published.length;
    expect(runtime.republishConnection({
      playerId: "player-original",
      connectionId: "connection-ghost",
      connectionGeneration: 1,
      preparationGeneration: initial!.preparationGeneration,
      relocationRevision: 1,
      resourceVisionRevision: 1
    }).status).toBe("republished");
    expect(published.slice(beforeResync).flatMap((delta) => delta.upserts)
      .map((entity) => entity.entityId)).not.toContain(TREE_ID);

    runtime.releaseConnection("connection-ghost", 1);
    const reconnected = await runtime.relocate(relocation({
      connectionId: "connection-ghost",
      connectionGeneration: 2,
      relocationRevision: 2,
      center: TREE_POSITION,
      trigger: "reconnect"
    }));
    expect(reconnected?.upserts.map((entity) => entity.entityId))
      .not.toContain(TREE_ID);
    await runtime.close();
  });

  it("fences an older activation without blocking a genuinely new generation", async () => {
    const backend = new DeferredTreeBackend();
    const logger = { warn: vi.fn() };
    const runtime = new PopulationZonesV2Runtime(backend, { logger });
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });

    const relocating = runtime.relocate(relocation({
      connectionId: "connection-race",
      connectionGeneration: 1,
      relocationRevision: 1,
      center: TREE_POSITION,
      trigger: "world-entry"
    }));
    await flushMicrotasks();
    runtime.removeHarvestedTree(treeTransition());
    backend.resolveCall(0, GENERATION_ID, 0);
    const staleActivation = await relocating;

    expect(staleActivation?.upserts.map((entity) => entity.entityId))
      .not.toContain(TREE_ID);
    expect(staleActivation?.removedEntityIds).toContain(TREE_ID);
    expect(runtime.snapshot()).toMatchObject({
      indexedEntities: 0,
      harvestedTreeFences: 1
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: TREE_ID,
        incomingRevision: 0,
        canonicalRevision: 1,
        operationType: "stale-ready-tree-activation-suppressed"
      }),
      "suppressed stale same-generation harvested tree activation"
    );

    const beforeNewGeneration = published.length;
    const refreshing = runtime.notifyZoneReady(TREE_ZONE_ID);
    await flushMicrotasks();
    backend.resolveCall(1, NEXT_GENERATION_ID, 2);
    await refreshing;
    expect(published.slice(beforeNewGeneration).flatMap((delta) => delta.upserts)
      .map((entity) => entity.entityId)).toContain(TREE_ID);
    expect(runtime.snapshot()).toMatchObject({
      indexedEntities: 1,
      harvestedTreeFences: 0
    });
    await runtime.close();
  });

  it("evicts only the harvested tree and never turns a Resin Crawler into a tree tombstone", async () => {
    const backend = new MixedTreeAndSapBackend();
    const logger = { warn: vi.fn() };
    const runtime = new PopulationZonesV2Runtime(backend, { logger });
    const initial = await runtime.relocate(relocation({
      connectionId: "connection-mixed",
      connectionGeneration: 1,
      relocationRevision: 1,
      center: TREE_POSITION,
      trigger: "world-entry"
    }));
    expect(initial?.upserts.map((entity) => entity.entityId).sort())
      .toEqual([SAP_CRAWLER_ID, TREE_ID].sort());

    runtime.removeHarvestedTree(treeTransition());
    expect(runtime.snapshot()).toMatchObject({
      indexedEntities: 1,
      projectedEntities: 1,
      harvestedTreeFences: 1
    });
    const returned = await runtime.relocate(relocation({
      connectionId: "connection-mixed",
      connectionGeneration: 1,
      relocationRevision: 2,
      center: TREE_POSITION,
      trigger: "flag-travel"
    }));
    expect(returned?.upserts.map((entity) => entity.entityId))
      .toEqual([SAP_CRAWLER_ID]);

    runtime.removeHarvestedTree({
      ...treeTransition(),
      entityId: SAP_CRAWLER_ID
    });
    expect(runtime.snapshot()).toMatchObject({
      indexedEntities: 1,
      harvestedTreeFences: 1
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: SAP_CRAWLER_ID,
        operationType: "harvested-tree-kind-mismatch"
      }),
      "refused to evict non-tree population entity for harvested tree transition"
    );

    backend.killSapCrawler();
    await runtime.notifyZoneReady(TREE_ZONE_ID);
    expect(runtime.snapshot()).toMatchObject({
      indexedEntities: 0,
      harvestedTreeFences: 1
    });
    await runtime.close();
  });
});

class HarvestedTreeBackend implements PopulationZonesV2RuntimeBackend {
  private harvested = false;

  harvestTree(): void {
    this.harvested = true;
  }

  async activateZones(input: {
    zoneIds: readonly PopulationZoneV2Id[];
  }): Promise<readonly PopulationZoneV2BackendZoneActivation[]> {
    return input.zoneIds.map((zoneId) => ({
      zoneId,
      generationId: zoneId === TREE_ZONE_ID ? GENERATION_ID : null,
      materializationStatus: "materialization-current",
      status: "ready",
      entities:
        zoneId !== TREE_ZONE_ID || this.harvested
          ? []
          : [{
              entityId: TREE_ID,
              zoneId,
              generationId: GENERATION_ID,
              kind: "tree",
              archetype: "tree",
              position: TREE_POSITION,
              homePosition: TREE_POSITION,
              stateRevision: 0
            }],
      removedEntityIds: [],
      spawnedRuntimeActors: 0
    }));
  }

  async sleepZones(input: { zoneIds: readonly PopulationZoneV2Id[] }) {
    return {
      removedEntityIds: input.zoneIds.includes(TREE_ZONE_ID) ? [TREE_ID] : [],
      sleptRuntimeActors: 0
    };
  }
}

class DeferredTreeBackend implements PopulationZonesV2RuntimeBackend {
  private readonly calls: Array<{
    zoneIds: readonly PopulationZoneV2Id[];
    resolve: (activations: readonly PopulationZoneV2BackendZoneActivation[]) => void;
  }> = [];

  activateZones(input: { zoneIds: readonly PopulationZoneV2Id[] }) {
    return new Promise<readonly PopulationZoneV2BackendZoneActivation[]>((resolve) => {
      this.calls.push({ zoneIds: input.zoneIds, resolve });
    });
  }

  resolveCall(index: number, generationId: string, stateRevision: number): void {
    const call = this.calls[index];
    if (!call) throw new Error(`missing deferred activation ${index}`);
    call.resolve(call.zoneIds.map((zoneId) => ({
      zoneId,
      generationId: zoneId === TREE_ZONE_ID ? generationId : null,
      materializationStatus: "materialization-current",
      status: "ready",
      entities: zoneId === TREE_ZONE_ID
        ? [{
            entityId: TREE_ID,
            zoneId,
            generationId,
            kind: "tree",
            archetype: "tree",
            position: TREE_POSITION,
            homePosition: TREE_POSITION,
            stateRevision
          }]
        : [],
      removedEntityIds: [],
      spawnedRuntimeActors: 0
    })));
  }

  async sleepZones(input: { zoneIds: readonly PopulationZoneV2Id[] }) {
    return {
      removedEntityIds: input.zoneIds.includes(TREE_ZONE_ID) ? [TREE_ID] : [],
      sleptRuntimeActors: 0
    };
  }
}

class MixedTreeAndSapBackend implements PopulationZonesV2RuntimeBackend {
  private treeHarvested = false;
  private sapCrawlerKilled = false;

  killSapCrawler(): void {
    this.sapCrawlerKilled = true;
  }

  async activateZones(input: {
    zoneIds: readonly PopulationZoneV2Id[];
  }): Promise<readonly PopulationZoneV2BackendZoneActivation[]> {
    return input.zoneIds.map((zoneId) => ({
      zoneId,
      generationId: zoneId === TREE_ZONE_ID ? GENERATION_ID : null,
      materializationStatus: "materialization-current",
      status: "ready",
      entities: zoneId !== TREE_ZONE_ID
        ? []
        : [
            ...(this.treeHarvested
              ? []
              : [{
                  entityId: TREE_ID,
                  zoneId,
                  generationId: GENERATION_ID,
                  kind: "tree" as const,
                  archetype: "tree",
                  position: TREE_POSITION,
                  homePosition: TREE_POSITION,
                  stateRevision: 0
                }]),
            ...(this.sapCrawlerKilled
              ? []
              : [{
                  entityId: SAP_CRAWLER_ID,
                  zoneId,
                  generationId: GENERATION_ID,
                  kind: "sap_crawler" as const,
                  archetype: "sap_crawler",
                  position: TREE_POSITION,
                  homePosition: TREE_POSITION,
                  stateRevision: 0
                }])
          ],
      removedEntityIds: [],
      spawnedRuntimeActors: this.sapCrawlerKilled ? 0 : 1
    }));
  }

  async sleepZones(input: { zoneIds: readonly PopulationZoneV2Id[] }) {
    return {
      removedEntityIds: input.zoneIds.includes(TREE_ZONE_ID)
        ? [TREE_ID, SAP_CRAWLER_ID]
        : [],
      sleptRuntimeActors: this.sapCrawlerKilled ? 0 : 1
    };
  }
}

function treeTransition() {
  return {
    entityId: TREE_ID,
    entityKind: "tree" as const,
    stateRevision: 1,
    position: TREE_POSITION,
    zoneId: TREE_ZONE_ID,
    generationId: GENERATION_ID,
    cutoverRevision: 1
  };
}

function relocation(input: {
  playerId?: string;
  connectionId: string;
  connectionGeneration: number;
  relocationRevision: number;
  center: { lat: number; lon: number };
  trigger: "world-entry" | "reconnect" | "flag-travel";
}) {
  return {
    playerId: input.playerId ?? "player-original",
    connectionId: input.connectionId,
    connectionGeneration: input.connectionGeneration,
    area: {
      center: input.center,
      certifiedVisibleRadiusM: 25,
      preparedRadiusM: 50,
      sourceType: "flag" as const,
      sourceId: "flag-1",
      generation: input.relocationRevision
    },
    relocationRevision: input.relocationRevision,
    resourceVisionRevision: input.relocationRevision,
    trigger: input.trigger
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
