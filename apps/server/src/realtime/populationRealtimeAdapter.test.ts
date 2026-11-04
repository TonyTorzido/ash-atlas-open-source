import { GIVING_TREE_AURA_INTERVAL_MS } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { CombatEngine } from "../game/combat/combatEngine.js";
import {
  type PopulationZoneV2Id
} from "../game/populationZonesV2Geometry.js";
import type { PopulationZonesV2ActivationDelta } from "../game/populationZonesV2Runtime.js";
import type { PopulationV2RealtimeHooks } from "./websocket.js";
import { PopulationRealtimeAdapter } from "./populationRealtimeAdapter.js";

/** Ticks (20 Hz) between two Giving Tree aura heals. */
const AURA_TICKS = GIVING_TREE_AURA_INTERVAL_MS * 20 / 1_000;

describe("PopulationRealtimeAdapter", () => {
  it("fences stale relocation results with the exact ownership token", async () => {
    let current = true;
    let resolveVisible!: (value: never) => void;
    let resolvePresentation!: (value: never) => void;
    let resolveCompletion!: (value: never) => void;
    const visibleReady = new Promise((resolve) => { resolveVisible = resolve; });
    const presentationReady = new Promise((resolve) => {
      resolvePresentation = resolve;
    });
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const runtime = {
      onDelta: vi.fn(() => vi.fn()),
      startRelocation: vi.fn((input: Record<string, unknown>) => {
        void input;
        return {
          visibleReady,
          presentationReady,
          completion,
          pendingVisibleZoneCount: () => 2
        };
      }),
      releaseConnection: vi.fn()
    };
    const adapter = createAdapter({ runtime });
    const handle = adapter.relocate(relocationInput(() => current));
    const startInput = runtime.startRelocation.mock.calls[0]?.[0];
    expect(startInput).toBeDefined();
    const ownershipToken = startInput!.ownershipToken;
    expect(ownershipToken).toBeTypeOf("object");

    current = false;
    resolveVisible({ status: "failed", delta: null, pendingVisibleZoneCount: 2 } as never);
    await expect(handle.visibleReady).resolves.toEqual({
      status: "stale",
      pendingVisibleZoneCount: 2
    });
    resolvePresentation({
      status: "failed",
      delta: null,
      pendingVisibleZoneCount: 2
    } as never);
    await expect(handle.presentationReady).resolves.toEqual({
      status: "stale",
      pendingVisibleZoneCount: 2
    });
    expect(runtime.releaseConnection).toHaveBeenCalledWith("connection-1", 3, {
      relocationRevision: 7,
      resourceVisionRevision: 11,
      ownershipToken
    });
    resolveCompletion({ status: "stale", delta: null } as never);
    await handle.completion;
  });

  it("does not create relocation ownership for an already stale generation", async () => {
    const runtime = runtimeStub();
    const handle = createAdapter({ runtime }).relocate(relocationInput(() => false));
    await expect(handle.visibleReady).resolves.toEqual({
      status: "stale",
      pendingVisibleZoneCount: 0
    });
    expect(runtime.startRelocation).not.toHaveBeenCalled();
  });

  it("forwards a fenced recovery request to the current runtime lease", () => {
    const runtime = runtimeStub();
    runtime.republishConnection.mockReturnValue({
      status: "republished",
      state: null
    });
    const adapter = createAdapter({ runtime });
    const input = {
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 3,
      preparationGeneration: 5,
      relocationRevision: 7,
      resourceVisionRevision: 11,
      preparationTrigger: "flag-travel" as const,
      preparationScope: "required-visible" as const
    };

    expect(adapter.resync(input)).toEqual({
      status: "republished",
      state: null
    });
    expect(runtime.republishConnection).toHaveBeenCalledWith(input);
  });

  it("admits rollout only from terminal post-world-entry background state", async () => {
    let publishDelta!: (delta: PopulationZonesV2ActivationDelta) => void;
    const runtime = {
      ...runtimeStub(),
      onDelta: vi.fn((
        listener: (delta: PopulationZonesV2ActivationDelta) => void
      ) => {
        publishDelta = listener;
        return vi.fn();
      }),
      startRelocation: vi.fn(() => ({
        visibleReady: Promise.resolve(readyVisible()),
        presentationReady: Promise.resolve(readyVisible()),
        completion: Promise.resolve({
          status: "completed",
          delta: populationDelta()
        }),
        pendingVisibleZoneCount: () => 0
      }))
    };
    const queueBackgroundMobRollout = vi.fn((
      zoneIds: readonly PopulationZoneV2Id[]
    ) => {
      void zoneIds;
    });
    const adapter = createAdapter({
      runtime,
      queueBackgroundMobRollout
    });
    adapter.start();

    await expect(adapter.relocate(
      relocationInput(() => true)
    ).visibleReady).resolves.toMatchObject({
      status: "ready"
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(queueBackgroundMobRollout).not.toHaveBeenCalled();

    publishDelta(populationDelta({
      preparationTrigger: "reconnect"
    }));
    publishDelta(populationDelta({
      preparationTrigger: "world-entry",
      preparationResult: "pending",
      terminal: false
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(queueBackgroundMobRollout).not.toHaveBeenCalled();

    const worldEntryReady = populationDelta({
      preparationTrigger: "world-entry"
    });
    publishDelta(worldEntryReady);
    publishDelta(worldEntryReady);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(queueBackgroundMobRollout).toHaveBeenCalledOnce();
    expect(queueBackgroundMobRollout.mock.calls[0]![0]).toEqual(
      worldEntryReady.zoneSnapshots.map((snapshot) => snapshot.zoneId)
    );
  });

  it("publishes exact cloned frames only to the active connection and unsubscribes", async () => {
    let listener!: (delta: PopulationZonesV2ActivationDelta) => void;
    const unsubscribe = vi.fn();
    const runtime = {
      ...runtimeStub(),
      onDelta: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      })
    };
    const registry = {
      isActivePlayerConnection: vi.fn(() => true),
      sendToConnection: vi.fn()
    };
    const adapter = createAdapter({ runtime, registry });
    adapter.start();
    const delta = populationDelta();
    listener(delta);
    await Promise.resolve();
    expect(registry.sendToConnection).toHaveBeenCalledWith("connection-1", {
      type: "POPULATION_ZONE_DELTA",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 3,
      preparationGeneration: 5,
      preparationTrigger: "flag-travel",
      preparationScope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: 7,
      resourceVisionRevision: 11,
      gameplayViewGeneration: 1,
      retainedZoneIds: ["population-v2:3:1:2"],
      activatedZoneIds: [],
      releasedZoneIds: [],
      withheldZoneIds: [],
      upserts: [],
      removedEntityIds: [],
      visibleZoneCount: 1,
      readyVisibleZoneCount: 1,
      backgroundZoneCount: 2,
      readyBackgroundZoneCount: 1,
      zoneSnapshots: [{
        zoneId: "population-v2:3:1:2",
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: []
      }],
      preparationResult: "ready",
      preparationReason: "durable-rehydration",
      partial: false,
      terminal: true
    });
    registry.isActivePlayerConnection.mockReturnValue(false);
    listener(delta);
    expect(registry.sendToConnection).toHaveBeenCalledOnce();
    adapter.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("publishes one terminal teleport reconciliation when all visible zones are ready", () => {
    let listener!: (delta: PopulationZonesV2ActivationDelta) => void;
    const sendToConnection = vi.fn();
    const runtime = {
      ...runtimeStub(),
      onDelta: vi.fn((next) => {
        listener = next;
        return vi.fn();
      })
    };
    const adapter = createAdapter({
      runtime,
      registry: {
        isActivePlayerConnection: vi.fn(() => true),
        sendToConnection
      },
      teleportPublicationCoalescingEnabled: true
    });
    adapter.start();
    const first = populationTree(
      "tree-a",
      "population-v2:3:1:2" as never,
      -106,
      false
    );
    const second = populationTree(
      "tree-b",
      "population-v2:3:1:3" as never,
      -105.99,
      false
    );
    listener(populationDelta({
      upserts: [first],
      readyVisibleZoneCount: 1,
      visibleZoneCount: 2,
      zoneSnapshots: [],
      preparationResult: "pending",
      partial: true,
      terminal: false
    }));
    expect(sendToConnection).not.toHaveBeenCalled();

    listener(populationDelta({
      retainedZoneIds: ["population-v2:3:1:3" as never],
      upserts: [second],
      readyVisibleZoneCount: 2,
      visibleZoneCount: 2,
      zoneSnapshots: [{
        zoneId: "population-v2:3:1:3" as never,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: [second.entityId]
      }]
    }));

    expect(sendToConnection).toHaveBeenCalledOnce();
    expect(sendToConnection.mock.calls[0]?.[1]).toMatchObject({
      terminal: true,
      partial: false,
      upserts: expect.arrayContaining([first, second])
    });
  });

  it("coalesces fourteen dense zone publications with linear serialization and bounded chunks", async () => {
    let listener!: (delta: PopulationZonesV2ActivationDelta) => void;
    const runtime = {
      ...runtimeStub(),
      onDelta: vi.fn((next) => {
        listener = next;
        return vi.fn();
      })
    };
    const registry = {
      isActivePlayerConnection: vi.fn(() => true),
      sendToConnection: vi.fn()
    };
    const adapter = createAdapter({ runtime, registry });
    adapter.start();
    let nextEntity = 0;
    for (let zoneIndex = 0; zoneIndex < 14; zoneIndex += 1) {
      const zoneId = `population-v2:dense:${zoneIndex}` as never;
      const count = zoneIndex < 6 ? 72 : 71;
      const upserts = Array.from({ length: count }, () => {
        const entity = populationTree(
          `tree-${nextEntity}`,
          zoneId,
          -106 + nextEntity * 0.000001,
          false
        );
        nextEntity += 1;
        return entity;
      });
      listener(populationDelta({
        retainedZoneIds: [],
        activatedZoneIds: [zoneId],
        upserts,
        zoneSnapshots: [{
          zoneId,
          generationId: "00000000-0000-4000-8000-000000000001",
          entityIds: upserts.map((entity) => entity.entityId)
        }],
        partial: zoneIndex < 13,
        terminal: zoneIndex === 13
      }));
    }

    await Promise.resolve();

    expect(nextEntity).toBe(1_000);
    expect(registry.sendToConnection).toHaveBeenCalledTimes(4);
    const metrics = adapter.deltaCoalescingMetrics();
    expect(metrics).toMatchObject({
      framesReceived: 14,
      framesSent: 4,
      coalescedFrames: 13,
      entityOccurrencesSerialized: 2_000,
      uniqueEntitiesSerialized: 1_000,
      duplicateEntityOccurrences: 1_000,
      largestPreparationFrameCount: 4
    });
    expect(metrics.largestFrameBytes)
      .toBeLessThan(256 * 1_024);
    console.info("population-frame-payload-benchmark", JSON.stringify(metrics));
  });

  it("heals a player and enemy immediately, then waits the full interval without stacking", () => {
    let listener!: (delta: PopulationZonesV2ActivationDelta) => void;
    const engine = healingEngine();
    addHealingPlayer(engine, 90);
    const dummy = engine.spawnMob({
      archetype: "training_dummy",
      position: { lat: 35, lon: -106 },
      regionCode: "NM",
      zoneId: "world:NM"
    });
    // Spawned mob health is level-scaled, so start the dummy 10 below whatever its maximum is.
    const dummyStart = engine.entity(dummy.entityId)!.maxHealth - 10;
    setHealth(engine, dummy.entityId, dummyStart);
    const runtime = {
      ...runtimeStub(),
      onDelta: vi.fn((next) => {
        listener = next;
        return vi.fn();
      })
    };
    const adapter = createAdapter({ runtime, combat: engine });
    adapter.start();
    const zoneId = "population-v2:3:1:2" as never;
    const trees = [
      populationTree("tree-a", zoneId, -106, true),
      populationTree("tree-b", zoneId, -105.99995, false)
    ];
    listener(populationDelta({
      retainedZoneIds: [],
      activatedZoneIds: [zoneId],
      upserts: trees,
      zoneSnapshots: [{
        zoneId,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: trees.map((tree) => tree.entityId)
      }]
    }));

    engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(93);
    expect(engine.entity(dummy.entityId)?.currentHealth).toBe(dummyStart + 3);
    for (let tick = 0; tick < AURA_TICKS - 1; tick += 1) engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(93);
    expect(engine.entity(dummy.entityId)?.currentHealth).toBe(dummyStart + 3);
    engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(96);
    expect(engine.entity(dummy.entityId)?.currentHealth).toBe(dummyStart + 6);
  });

  it("moves healing to a corrected same-ID population coordinate", () => {
    let listener!: (delta: PopulationZonesV2ActivationDelta) => void;
    const engine = healingEngine();
    addHealingPlayer(engine, 90);
    const runtime = {
      ...runtimeStub(),
      onDelta: vi.fn((next) => {
        listener = next;
        return vi.fn();
      })
    };
    const adapter = createAdapter({ runtime, combat: engine });
    adapter.start();
    const zoneId = "population-v2:3:1:2" as never;
    const tree = populationTree("tree-a", zoneId, -106, true);
    listener(populationDelta({
      upserts: [tree],
      zoneSnapshots: [{
        zoneId,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: [tree.entityId]
      }]
    }));
    engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(93);

    const correctedPosition = { lat: 35, lon: -105.9975 };
    syncHealingPlayer(engine, correctedPosition);
    engine.tick();
    setHealth(engine, "player-1", 90);
    listener(populationDelta({
      upserts: [{
        ...tree,
        position: correctedPosition,
        homePosition: correctedPosition,
        stateRevision: 2
      }],
      zoneSnapshots: [{
        zoneId,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: [tree.entityId]
      }]
    }));
    engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(93);

    setHealth(engine, "player-1", 90);
    syncHealingPlayer(engine, { lat: 35, lon: -106 });
    engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(90);
  });

  it("keeps resin-harvested trees healing and removes only authoritative removals", () => {
    let listener!: (delta: PopulationZonesV2ActivationDelta) => void;
    const engine = healingEngine();
    addHealingPlayer(engine, 90);
    const runtime = {
      ...runtimeStub(),
      onDelta: vi.fn((next) => {
        listener = next;
        return vi.fn();
      })
    };
    const adapter = createAdapter({ runtime, combat: engine });
    adapter.start();
    const zoneId = "population-v2:3:1:2" as never;
    const tree = populationTree("tree-a", zoneId, -106, true);
    listener(populationDelta({
      upserts: [tree],
      zoneSnapshots: [{
        zoneId,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: [tree.entityId]
      }]
    }));
    engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(93);

    setHealth(engine, "player-1", 90);
    listener(populationDelta({
      upserts: [{
        ...tree,
        stateRevision: 2,
        resinAvailable: false
      }],
      zoneSnapshots: [{
        zoneId,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: [tree.entityId]
      }]
    }));
    for (let tick = 0; tick < AURA_TICKS - 1; tick += 1) engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(90);
    engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(93);

    setHealth(engine, "player-1", 90);
    listener(populationDelta({
      upserts: [],
      removedEntityIds: [tree.entityId],
      zoneSnapshots: [{
        zoneId,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: []
      }]
    }));
    for (let tick = 0; tick < 33; tick += 1) engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(90);

    listener(populationDelta({
      upserts: [tree],
      zoneSnapshots: [{
        zoneId,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: [tree.entityId]
      }]
    }));
    const transition = {
      entityId: tree.entityId,
      entityKind: "tree" as const,
      stateRevision: 2,
      position: tree.position,
      zoneId,
      generationId: tree.generationId!,
      cutoverRevision: 1
    };
    adapter.removeHarvestedTree(transition);
    expect(runtime.removeHarvestedTree).toHaveBeenCalledWith(transition);
    listener(populationDelta({
      upserts: [],
      zoneSnapshots: [{
        zoneId,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: [tree.entityId]
      }]
    }));
    for (let tick = 0; tick < 33; tick += 1) engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(90);

    listener(populationDelta({
      upserts: [tree],
      zoneSnapshots: [{
        zoneId,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: [tree.entityId]
      }]
    }));
    listener(populationDelta({
      retainedZoneIds: [],
      releasedZoneIds: [zoneId],
      upserts: [],
      zoneSnapshots: []
    }));
    for (let tick = 0; tick < 33; tick += 1) engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(90);
  });

  it("deduplicates overlapping connection sources until the final reference releases", () => {
    let listener!: (delta: PopulationZonesV2ActivationDelta) => void;
    const engine = healingEngine();
    addHealingPlayer(engine, 90);
    const runtime = {
      ...runtimeStub(),
      onDelta: vi.fn((next) => {
        listener = next;
        return vi.fn();
      })
    };
    const adapter = createAdapter({ runtime, combat: engine });
    adapter.start();
    const zoneId = "population-v2:3:1:2" as never;
    const tree = populationTree("tree-shared", zoneId, -106, true);
    const delta = populationDelta({
      upserts: [tree],
      zoneSnapshots: [{
        zoneId,
        generationId: "00000000-0000-4000-8000-000000000001",
        entityIds: [tree.entityId]
      }]
    });
    listener(delta);
    listener({
      ...delta,
      playerId: "player-2",
      connectionId: "connection-2"
    });

    adapter.releaseConnection({
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 3
    });
    engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(93);

    setHealth(engine, "player-1", 90);
    adapter.releaseConnection({
      playerId: "player-2",
      connectionId: "connection-2",
      connectionGeneration: 3
    });
    engine.tick();
    expect(engine.entity("player-1")?.currentHealth).toBe(90);
  });
});

function createAdapter(overrides: Readonly<{
  runtime?: ReturnType<typeof runtimeStub> | Record<string, unknown>;
  orchestrator?: Record<string, unknown>;
  registry?: Record<string, unknown>;
  combat?: CombatEngine;
  queueBackgroundMobRollout?: (
    zoneIds: readonly PopulationZoneV2Id[]
  ) => void;
  teleportPublicationCoalescingEnabled?: boolean;
}> = {}): PopulationRealtimeAdapter {
  const runtime = overrides.runtime ?? runtimeStub();
  return new PopulationRealtimeAdapter({
    orchestrator: (overrides.orchestrator ?? runtime) as never,
    registry: (overrides.registry ?? {
      isActivePlayerConnection: vi.fn(() => true),
      sendToConnection: vi.fn()
    }) as never,
    ...(overrides.combat ? { combat: overrides.combat } : {}),
    ...(overrides.queueBackgroundMobRollout
      ? { queueBackgroundMobRollout: overrides.queueBackgroundMobRollout }
      : {}),
    ...(overrides.teleportPublicationCoalescingEnabled === undefined
      ? {}
      : {
          teleportPublicationCoalescingEnabled:
            overrides.teleportPublicationCoalescingEnabled
        })
  });
}

function runtimeStub() {
  return {
    onDelta: vi.fn(() => vi.fn()),
    startRelocation: vi.fn(),
    releaseConnection: vi.fn(),
    republishConnection: vi.fn(),
    removeHarvestedTree: vi.fn()
  };
}

function relocationInput(
  isCurrent: () => boolean
): Parameters<PopulationV2RealtimeHooks["relocate"]>[0] {
  return {
    playerId: "player-1",
    connectionId: "connection-1",
    connectionGeneration: 3,
    area: {
      center: { lat: 35, lon: -106 },
      certifiedVisibleRadiusM: 650,
      preparedRadiusM: 750,
      sourceType: "flag",
      sourceId: "flag-1",
      generation: 1
    },
    relocationRevision: 7,
    resourceVisionRevision: 11,
    trigger: "flag-travel",
    isCurrent
  };
}

function populationDelta(
  overrides: Partial<PopulationZonesV2ActivationDelta> = {}
): PopulationZonesV2ActivationDelta {
  return {
    playerId: "player-1",
    connectionId: "connection-1",
    connectionGeneration: 3,
    preparationGeneration: 5,
    preparationTrigger: "flag-travel",
    relocationRevision: 7,
    resourceVisionRevision: 11,
    gameplayViewGeneration: 1,
    retainedZoneIds: ["population-v2:3:1:2" as never],
    activatedZoneIds: [],
    releasedZoneIds: [],
    withheldZoneIds: [],
    upserts: [],
    removedEntityIds: [],
    visibleZoneCount: 1,
    readyVisibleZoneCount: 1,
    backgroundZoneCount: 2,
    readyBackgroundZoneCount: 1,
    zoneSnapshots: [{
      zoneId: "population-v2:3:1:2" as never,
      generationId: "00000000-0000-4000-8000-000000000001",
      entityIds: []
    }],
    preparationReason: "durable-rehydration",
    preparationResult: "ready",
    partial: false,
    terminal: true,
    ...overrides
  };
}

function readyVisible() {
  return {
    status: "ready" as const,
    delta: populationDelta(),
    pendingVisibleZoneCount: 0
  };
}

function healingEngine(): CombatEngine {
  return new CombatEngine({
    tickRateHz: 20,
    playerMovementSpeedMps: 40,
    isPlayerAuthorityActive: () => true
  });
}

function addHealingPlayer(engine: CombatEngine, currentHealth: number): void {
  engine.connectPlayer({
    playerId: "player-1",
    name: "player-1",
    regionCode: "NM",
    zoneId: "world:NM",
    position: { lat: 35, lon: -106 },
    accountId: "account-player-1",
    connectionId: "connection-player-1",
    profile: {
      playerId: "player-1",
      maxHealth: 100,
      currentHealth,
      baseAttackDamage: 10
    }
  });
}

function setHealth(
  engine: CombatEngine,
  entityId: string,
  currentHealth: number
): void {
  const internals = engine as unknown as {
    entities: Map<string, { currentHealth: number }>;
  };
  internals.entities.get(entityId)!.currentHealth = currentHealth;
}

function syncHealingPlayer(
  engine: CombatEngine,
  position: { lat: number; lon: number }
): void {
  engine.syncPlayer({
    playerId: "player-1",
    position,
    regionCode: "NM",
    zoneId: "world:NM"
  });
}

function populationTree(
  entityId: string,
  zoneId: PopulationZonesV2ActivationDelta["zoneSnapshots"][number]["zoneId"],
  lon: number,
  resinAvailable: boolean
): PopulationZonesV2ActivationDelta["upserts"][number] {
  return {
    entityId,
    zoneId,
    generationId: "00000000-0000-4000-8000-000000000001",
    kind: "tree",
    archetype: "tree",
    position: { lat: 35, lon },
    homePosition: { lat: 35, lon },
    stateRevision: 1,
    resinAvailable
  };
}
