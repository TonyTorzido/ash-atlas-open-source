import { describe, expect, it, vi } from "vitest";

import {
  PopulationV2GenerationFactory,
  PopulationV2GenerationServer,
  PopulationV2PlanAuthority,
  PopulationV2ZoneActivationScheduler
} from "./populationV2GenerationServices.js";
import { populationZoneV2IdForPoint } from "./populationZonesV2Geometry.js";
import type {
  PopulationZoneV2GenerationRecord,
  PopulationZoneV2PlanRequest
} from "./populationZonesV2Store.js";
import {
  commonSchemaRevisionForGeneration,
  POPULATION_GENERATION_MATERIALIZATION_REVISION
} from
  "./populationZonesV2Store.js";

const ZONE_ID = populationZoneV2IdForPoint({
  lat: 39.7392,
  lon: -104.9903
});
const GENERATION_ID = "00000000-0000-4000-8000-000000000011";

describe("Population V2 generation service boundaries", () => {
  it.each([
    [
      POPULATION_GENERATION_MATERIALIZATION_REVISION,
      "materialization-current"
    ],
    [
      "population-generation-materialization-v10-flax-plant",
      "materialization-stale-but-servable"
    ],
    [
      "population-generation-materialization-v9-coastal-body-density",
      "materialization-stale-but-servable"
    ],
    [
      "population-generation-materialization-v8-coastal-crab",
      "materialization-stale-but-servable"
    ],
    [
      "population-generation-materialization-v7-jellyfish-water-balance",
      "materialization-stale-but-servable"
    ],
    [
      "population-generation-materialization-v6-mysterious-traveler",
      "materialization-stale-but-servable"
    ],
    [
      "population-generation-materialization-v4-encounter-tables-v1",
      "materialization-stale-but-servable"
    ],
    [
      "population-generation-materialization-v5-land-balance-v2",
      "materialization-stale-but-servable"
    ],
    [
      "population-generation-materialization-v2",
      "materialization-stale-but-servable"
    ],
    [
      "population-generation-materialization-v1",
      "materialization-stale-but-servable"
    ],
    [
      "population-generation-materialization-v3",
      "materialization-stale-but-servable"
    ],
    ["legacy-unverified", "materialization-stale-but-servable"]
  ] as const)(
    "serves compatible %s generations read-only",
    async (materializationRevision, materializationStatus) => {
      const generation = generationRecord(materializationRevision);
      const store = generationServerStore([generation]);
      const server = new PopulationV2GenerationServer(store);

      const loaded = await server.loadCurrentGenerations([ZONE_ID]);
      const assessment = server.assess(
        loaded.get(ZONE_ID)!,
        new Date("2026-03-01T01:00:00.000Z")
      );

      expect(assessment).toEqual({
        status: "servable",
        materializationStatus,
        materializationRevision
      });
      expect(store.loadCurrentServingPlanGenerations).toHaveBeenCalledWith([
        ZONE_ID
      ]);
      expect(store.loadCurrentGenerations).not.toHaveBeenCalled();
      expect(store.loadReadyEntitiesForZones).not.toHaveBeenCalled();
      expect(store.acquireRuntimeEntityLeases).not.toHaveBeenCalled();
    }
  );

  it("guards an unknown future materialization with one bounded warning", () => {
    const logger = { warn: vi.fn() };
    const server = new PopulationV2GenerationServer(
      generationServerStore([]),
      logger
    );
    const generation = generationRecord("future-materialization-v99");
    const now = new Date("2026-03-01T01:00:00.000Z");

    expect(server.assess(generation, now)).toEqual({
      status: "guarded-materialization",
      materializationRevision: "future-materialization-v99"
    });
    expect(server.assess(generation, now)).toEqual({
      status: "guarded-materialization",
      materializationRevision: "future-materialization-v99"
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("derives the v2 common schema for the retained v9 materialization", () => {
    expect(commonSchemaRevisionForGeneration(
      generationRecord(
        "population-generation-materialization-v9-coastal-body-density"
      )
    )).toBe("population-common-schema-v2-encounter-identity");
  });

  it("derives the v2 common schema for the retained v10 materialization", () => {
    expect(commonSchemaRevisionForGeneration(
      generationRecord("population-generation-materialization-v10-flax-plant")
    )).toBe("population-common-schema-v2-encounter-identity");
  });

  it("serves a valid legacy generation without any mob manifest lookup", async () => {
    const generation = generationRecord(
      "population-generation-materialization-v3"
    );
    const store = {
      ...generationServerStore([generation]),
      loadMobRolloutReceipts: vi.fn(async () => [])
    };
    const server = new PopulationV2GenerationServer(store);

    const loaded = await server.loadCurrentGenerations([ZONE_ID]);
    expect(server.assess(
      loaded.get(ZONE_ID)!,
      new Date("2026-03-01T01:00:00.000Z")
    )).toMatchObject({ status: "servable" });
    expect(store.loadMobRolloutReceipts).not.toHaveBeenCalled();
  });

  it("keeps priority-2 work as non-serving preparation", async () => {
    const store = {
      ensurePlansForZones: vi.fn(async (
        requests: readonly PopulationZoneV2PlanRequest[]
      ) =>
        requests.map((request) => ({
          ...request,
          planId: "00000000-0000-4000-8000-000000000010",
          status: "ready" as const,
          claimGeneration: 1,
          attemptCount: 1,
          contentHash: "ready"
        }))
      ),
      ensurePlanForZone: vi.fn()
    };
    const planner = {
      scheduleZones: vi.fn(async () => ({
        disabled: false,
        readyZoneIds: [ZONE_ID],
        pendingZoneIds: []
      })),
      scheduleZonesAndWait: vi.fn()
    };
    const authority = new PopulationV2PlanAuthority(store, planner, {
      regionCode: "US",
      worldEnvironmentIdentityKey: "e".repeat(64),
      worldPipelineSha: "9".repeat(40)
    });

    const result = await authority.prepareNonServingZones({
      zoneIds: [ZONE_ID],
      trigger: "preload"
    });

    expect(result.pendingZoneIds).toEqual([]);
    expect(result.readyPlansByZone.size).toBe(1);
    expect(planner.scheduleZones).toHaveBeenCalledWith({
      zoneIds: [ZONE_ID],
      regionCode: "US",
      reason: "population-v2:preload",
      priority: 2
    });
    expect(planner.scheduleZonesAndWait).not.toHaveBeenCalled();
    expect(store.ensurePlansForZones).toHaveBeenCalledOnce();
  });

  it("propagates terminal plan preparation without reporting it pending", async () => {
    const store = {
      ensurePlansForZones: vi.fn(async () => []),
      ensurePlanForZone: vi.fn()
    };
    const planner = {
      scheduleZones: vi.fn(),
      scheduleZonesAndWait: vi.fn(async () => ({
        disabled: false,
        readyZoneIds: [],
        pendingZoneIds: [],
        terminalFailureZoneIds: [ZONE_ID]
      }))
    };
    const authority = new PopulationV2PlanAuthority(store, planner, {
      regionCode: "US",
      worldEnvironmentIdentityKey: "e".repeat(64),
      worldPipelineSha: "9".repeat(40)
    });

    const result = await authority.prepareMissingZones({
      zoneIds: [ZONE_ID],
      trigger: "flag-travel",
      priority: 1
    });

    expect(result.readyPlansByZone.size).toBe(0);
    expect(result.pendingZoneIds).toEqual([]);
    expect(result.terminalFailureZoneIds).toEqual([ZONE_ID]);
  });

  it("delegates missing creation without exposing density reconciliation", async () => {
    const materialization = {
      generation: generationRecord("population-generation-materialization-v2"),
      created: true,
      entityIds: [],
      shortfallByKind: {
        tree: 0,
        deer: 0,
        wolf_pack: 0,
        sap_crawler_group: 0
      }
    };
    const store = {
      createCurrentGeneration: vi.fn(async () => materialization),
      reconcileCurrentGenerationDensity: vi.fn()
    };
    const factory = new PopulationV2GenerationFactory(store);

    await expect(factory.createMissingGeneration({
      zoneId: ZONE_ID,
      planId: "00000000-0000-4000-8000-000000000010"
    })).resolves.toBe(materialization);
    expect(store.createCurrentGeneration).toHaveBeenCalledOnce();
    expect(store.reconcileCurrentGenerationDensity).not.toHaveBeenCalled();
  });
});

describe("PopulationV2ZoneActivationScheduler", () => {
  it("coalesces equivalent overlapping serving work for one zone", async () => {
    const scheduler = new PopulationV2ZoneActivationScheduler<string>(3);
    const gate = deferred<void>();
    const work = vi.fn(async () => {
      await gate.promise;
      return "ready";
    });

    const first = scheduler.schedule(ZONE_ID, 1, work);
    const second = scheduler.schedule(ZONE_ID, 1, work);

    expect(second).toBe(first);
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "ready",
      "ready"
    ]);
    expect(work).toHaveBeenCalledOnce();
  });

  it("serializes non-equivalent work at the same zone and priority", async () => {
    const scheduler = new PopulationV2ZoneActivationScheduler<string>(3);
    const durableGate = deferred<void>();
    let simulationStarted = false;
    const durableWork = vi.fn(async () => {
      await durableGate.promise;
      return "durable";
    });
    const simulationWork = vi.fn(async () => {
      simulationStarted = true;
      return "simulation";
    });

    const durable = scheduler.schedule(
      ZONE_ID,
      0,
      durableWork,
      "durable-ready"
    );
    const simulation = scheduler.schedule(
      ZONE_ID,
      0,
      simulationWork,
      "simulation-ready:profile-7"
    );

    expect(simulation).not.toBe(durable);
    await Promise.resolve();
    expect(simulationStarted).toBe(false);
    durableGate.resolve();
    await expect(durable).resolves.toBe("durable");
    await expect(simulation).resolves.toBe("simulation");
    expect(durableWork).toHaveBeenCalledOnce();
    expect(simulationWork).toHaveBeenCalledOnce();
  });

  it("runs independent zones concurrently within the bound", async () => {
    const scheduler = new PopulationV2ZoneActivationScheduler<string>(3);
    const firstGate = deferred<void>();
    const secondStarted = deferred<void>();
    const first = scheduler.schedule("zone-a", 1, async () => {
      await firstGate.promise;
      return "a";
    });
    const second = scheduler.schedule("zone-b", 1, async () => {
      secondStarted.resolve();
      return "b";
    });

    await secondStarted.promise;
    await expect(second).resolves.toBe("b");
    firstGate.resolve();
    await expect(first).resolves.toBe("a");
  });

  it("serializes same-zone preparation while preserving another urgent lane", async () => {
    const scheduler = new PopulationV2ZoneActivationScheduler<string>(2);
    const preparationGate = deferred<void>();
    let sameZoneUrgentStarted = false;
    const preparation = scheduler.schedule(ZONE_ID, 2, async () => {
      await preparationGate.promise;
      return "prepared";
    });
    const sameZoneUrgent = scheduler.schedule(
      ZONE_ID,
      0,
      async () => {
        sameZoneUrgentStarted = true;
        return "same-zone-urgent";
      }
    );
    const independentUrgent = scheduler.schedule(
      "independent-zone",
      0,
      async () => "independent-urgent"
    );

    await expect(independentUrgent).resolves.toBe("independent-urgent");
    expect(sameZoneUrgentStarted).toBe(false);
    preparationGate.resolve();
    await expect(preparation).resolves.toBe("prepared");
    await expect(sameZoneUrgent).resolves.toBe("same-zone-urgent");
  });
});

function generationRecord(
  materializationRevision: string
): PopulationZoneV2GenerationRecord {
  return {
    generationId: GENERATION_ID,
    zoneId: ZONE_ID,
    planId: "00000000-0000-4000-8000-000000000010",
    generationNumber: 1,
    generatedAt: new Date("2026-03-01T00:00:00.000Z"),
    expiresAt: new Date("2026-03-03T00:00:00.000Z"),
    status: "active",
    plannedNonStoneCount: 0,
    currentReferenceCount: 0,
    unreferencedAt: null,
    isCurrent: true,
    cleanedAt: null,
    materializationRevision
  };
}

function generationServerStore(
  generations: readonly PopulationZoneV2GenerationRecord[]
) {
  return {
    loadCurrentServingPlanGenerations:
      vi.fn(async () => [...generations]),
    loadCurrentGenerations: vi.fn(async () => [...generations]),
    loadReadyEntitiesForZones: vi.fn(async () => []),
    acquireRuntimeEntityLeases: vi.fn(async () => [])
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
