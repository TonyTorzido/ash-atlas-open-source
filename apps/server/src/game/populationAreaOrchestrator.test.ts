import {
  DEFAULT_FLAG_PREPARE_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
} from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import {
  type PopulationZonesV2RuntimeBackend,
  PopulationZonesV2Runtime
} from "./populationZonesV2Runtime.js";
import { PopulationAreaOrchestrator } from "./populationAreaOrchestrator.js";

const CENTER = { lat: 35.0844, lon: -106.6504 };

describe("PopulationAreaOrchestrator", () => {
  it("prepares exact stage geometry and retains one typed source", async () => {
    const backend = stageBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const orchestrator = new PopulationAreaOrchestrator(runtime);
    const result = await orchestrator.prepareArea({
      area: {
        center: CENTER,
        certifiedVisibleRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
        preparedRadiusM: DEFAULT_FLAG_PREPARE_RADIUS_M,
        sourceType: "flag",
        sourceId: "flag-1",
        generation: 1
      },
      source: {
        sourceId: "build:player-1:connection-1:build-1",
        kind: "flag-build",
        targetStage: "SIMULATION_READY",
        priority: 1,
        createdAtMs: Date.now(),
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 1,
        buildId: "build-1",
        authorityToken: "build-authority-1"
      }
    });

    expect(result.zoneIds).toEqual(populationZonesV2IntersectingCircle(
      CENTER,
      DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
    ));
    expect(result.outcomes.every((outcome) =>
      outcome.status === "ready"
      && outcome.completedStage === "SIMULATION_READY"
      && outcome.reason === "ready"
    )).toBe(true);
    expect(runtime.snapshot()).toMatchObject({
      streamingSourceLeases: 1
    });
    expect(orchestrator.adoptSource({
      sourceId: result.sourceId,
      adoptedSourceId: "post-build:flag-1",
      adoptedKind: "flag-build",
      expectedArea: {
        center: CENTER,
        certifiedVisibleRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
        preparedRadiusM: DEFAULT_FLAG_PREPARE_RADIUS_M,
        sourceType: "flag",
        sourceId: "flag-1",
        generation: 1
      },
      expectedAuthorityToken: "stale-authority",
      expectedPlayerId: "player-1",
      expectedConnectionId: "connection-1",
      expectedConnectionGeneration: 1,
      expectedBuildId: "build-1"
    })).toBe("rejected");
    expect(orchestrator.adoptSource({
      sourceId: result.sourceId,
      adoptedSourceId: "post-build:flag-1",
      adoptedKind: "flag-build",
      expectedArea: {
        center: CENTER,
        certifiedVisibleRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
        preparedRadiusM: DEFAULT_FLAG_PREPARE_RADIUS_M,
        sourceType: "flag",
        sourceId: "flag-1",
        generation: 1
      },
      expectedAuthorityToken: "build-authority-1",
      expectedPlayerId: "player-1",
      expectedConnectionId: "connection-1",
      expectedConnectionGeneration: 1,
      expectedBuildId: "build-1",
      requireReadyAuthority: true
    })).toBe("rejected");
    expect(orchestrator.adoptSource({
      sourceId: result.sourceId,
      adoptedSourceId: "post-build:flag-1",
      adoptedKind: "flag-build",
      expectedArea: {
        center: CENTER,
        certifiedVisibleRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
        preparedRadiusM: DEFAULT_FLAG_PREPARE_RADIUS_M,
        sourceType: "flag",
        sourceId: "flag-1",
        generation: 1
      },
      expectedAuthorityToken: "build-authority-1",
      expectedPlayerId: "player-1",
      expectedConnectionId: "connection-1",
      expectedConnectionGeneration: 1,
      expectedBuildId: "build-1"
    })).toBe("adopted");
    expect(orchestrator.releaseSource(result.sourceId)).toBe(false);
    expect(orchestrator.releaseSource("post-build:flag-1")).toBe(true);
    expect(runtime.snapshot()).toMatchObject({
      streamingSourceLeases: 0,
      referencedZones: 0
    });
    orchestrator.close();
    await runtime.close();
  });

  it("promotes a travel source only after preparation has ready authority", async () => {
    const activationReferences: Readonly<Record<string, number>>[] = [];
    const backend = travelBackend({
      ready: true,
      activationReferences
    });
    const runtime = new PopulationZonesV2Runtime(backend);
    const orchestrator = new PopulationAreaOrchestrator(runtime);

    const result = await orchestrator.prepareArea(travelRequest("travel:ready"));

    expect(result.outcomes.every((outcome) => outcome.status === "ready"))
      .toBe(true);
    expect(activationReferences.every((references) =>
      Object.values(references).every((count) => count === 0)
    )).toBe(true);
    expect(runtime.snapshot().referencedZones).toBe(result.zoneIds.length);
    orchestrator.releaseSource(result.sourceId);
    orchestrator.close();
    await runtime.close();
  });

  it("leaves pending travel preparation without durable references", async () => {
    const activationReferences: Readonly<Record<string, number>>[] = [];
    const backend = travelBackend({
      ready: false,
      activationReferences
    });
    const runtime = new PopulationZonesV2Runtime(backend);
    const orchestrator = new PopulationAreaOrchestrator(runtime);

    const result = await orchestrator.prepareArea(travelRequest("travel:pending"));

    expect(result.outcomes.every((outcome) => outcome.status === "pending"))
      .toBe(true);
    expect(runtime.snapshot()).toMatchObject({
      streamingSourceLeases: 1,
      referencedZones: 0
    });
    expect(activationReferences.every((references) =>
      Object.values(references).every((count) => count === 0)
    )).toBe(true);
    orchestrator.releaseSource(result.sourceId);
    orchestrator.close();
    await runtime.close();
  });

  it("retains durable multi-zone authority while simulation promotion is pending", async () => {
    const backend = travelBackend({ ready: true, activationReferences: [] });
    const originalActivate = backend.activateZones;
    let completePromotion!: () => void;
    const gate = new Promise<void>((resolve) => { completePromotion = resolve; });
    backend.activateZones = vi.fn(async (input) => {
      const results = await originalActivate(input);
      if (Object.values(input.targetStageByZone ?? {}).includes("SIMULATION_READY")) {
        input.onZoneActivated?.(results[0]!);
        await gate;
      }
      return results;
    });
    const runtime = new PopulationZonesV2Runtime(backend, { sleepGraceMs: 5 });
    const orchestrator = new PopulationAreaOrchestrator(runtime);
    const request = travelRequest("travel:promotion");
    try {
      const durable = await orchestrator.prepareArea(request);
      expect(durable.zoneIds.length).toBeGreaterThan(1);
      const promotion = orchestrator.prepareArea({
        ...request, source: { ...request.source, targetStage: "SIMULATION_READY" }
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runtime.snapshot().referencedZones).toBe(durable.zoneIds.length);
      expect(runtime.streamingSourceAuthorities(request.source.sourceId))
        .toEqual(durable.outcomes.map((outcome) => outcome.authority));
      expect(backend.sleepZones).not.toHaveBeenCalled();
      completePromotion();
      const simulation = await promotion;
      expect(simulation.outcomes.every((outcome) =>
        outcome.status === "ready" && outcome.completedStage === "SIMULATION_READY"
      )).toBe(true);
      expect(orchestrator.adoptSource({
        sourceId: request.source.sourceId, adoptedSourceId: "player-visible:promotion",
        adoptedKind: "player-visible", expectedArea: request.area,
        expectedAuthorityToken: request.source.authorityToken,
        expectedTravelId: request.source.travelId, requireReadyAuthority: true
      })).toBe("adopted");
    } finally {
      completePromotion();
      orchestrator.close();
      await runtime.close();
    }
  });

  it.each(["reject", "abort"] as const)("releases completed batch holds on %s and ignores later completion", async (mode) => {
    const backend = travelBackend({ ready: true, activationReferences: [] });
    const originalActivate = backend.activateZones;
    let complete!: () => void;
    let fail!: (error: Error) => void;
    const gate = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    backend.activateZones = vi.fn(async (input) => {
      const results = await originalActivate(input);
      input.onZoneActivated?.(results[0]!);
      await gate;
      return results;
    });
    const runtime = new PopulationZonesV2Runtime(backend, { sleepGraceMs: 5 });
    const controller = new AbortController();
    const zoneIds = populationZonesV2IntersectingCircle(CENTER, DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M);
    const preparation = runtime.prepareZones({
      zoneIds, trigger: "administrative-relocation", priority: 1,
      targetStage: "SIMULATION_READY", activateRuntime: true, signal: controller.signal
    });
    const observed = preparation.then(() => "completed", () => "rejected");
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runtime.snapshot().referencedZones).toBe(1);
      if (mode === "abort") controller.abort();
      else fail(new Error("controlled activation failure"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runtime.snapshot().referencedZones).toBe(0);
      complete();
      expect(await observed).toBe(mode === "abort" ? "completed" : "rejected");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runtime.snapshot()).toMatchObject({ referencedZones: 0, streamingSourceLeases: 0 });
    } finally {
      complete();
      await observed;
      await runtime.close();
    }
  });

  it.each(["authorityToken", "travelId", "connectionId", "requestId"] as const)(
    "does not retain durable authority for a replacement %s", async (field) => {
      const references: Readonly<Record<string, number>>[] = [];
      const backend = travelBackend({ ready: true, activationReferences: references });
      const runtime = new PopulationZonesV2Runtime(backend);
      const orchestrator = new PopulationAreaOrchestrator(runtime);
      const request = travelRequest("travel:replacement");
      try {
        await orchestrator.prepareArea(request);
        references.length = 0;
        await orchestrator.prepareArea({
          ...request, source: { ...request.source, targetStage: "SIMULATION_READY", [field]: "replacement" }
        });
        expect(references.length).toBeGreaterThan(0);
        expect(references.every((entry) => Object.values(entry).every((count) => count === 0)))
          .toBe(true);
      } finally {
        orchestrator.close();
        await runtime.close();
      }
    }
  );

  it("gates flag travel on only the destination-containing zone", async () => {
    const activationZoneIds: PopulationZoneV2Id[][] = [];
    const activationPriorities: number[] = [];
    const backend = travelBackend({
      ready: true,
      activationReferences: [],
      activationZoneIds,
      activationPriorities
    });
    const runtime = new PopulationZonesV2Runtime(backend);
    const orchestrator = new PopulationAreaOrchestrator(runtime);
    const request = {
      ...travelRequest("travel:critical"),
      source: {
        ...travelRequest("travel:critical").source,
        kind: "flag-travel" as const
      }
    };

    const result = await orchestrator.prepareArea(request);
    const destinationZoneId = populationZoneV2IdForPoint(CENTER);

    expect(populationZonesV2IntersectingCircle(
      CENTER,
      DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
    ).length).toBeGreaterThan(1);
    expect(result.zoneIds).toEqual([destinationZoneId]);
    expect(activationZoneIds).toEqual([[destinationZoneId]]);
    expect(activationPriorities).toEqual([0]);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        zoneId: destinationZoneId,
        status: "ready",
        completedStage: "DURABLE_READY"
      })
    ]);
    const simulation = await orchestrator.prepareArea({
      ...request,
      source: {
        ...request.source,
        targetStage: "SIMULATION_READY",
        priority: 0
      }
    });
    expect(simulation.zoneIds).toEqual([destinationZoneId]);
    expect(simulation.outcomes).toEqual([
      expect.objectContaining({
        zoneId: destinationZoneId,
        status: "ready",
        completedStage: "SIMULATION_READY"
      })
    ]);
    expect(activationZoneIds).toEqual([
      [destinationZoneId],
      [destinationZoneId]
    ]);
    expect(activationPriorities).toEqual([0, 0]);
    expect(runtime.snapshot().referencedZones).toBe(1);
    expect(orchestrator.adoptSource({
      sourceId: result.sourceId,
      adoptedSourceId: "player-visible:travel:critical",
      adoptedKind: "player-visible",
      expectedArea: request.area,
      expectedAuthorityToken: request.source.authorityToken,
      expectedTravelId: request.source.travelId,
      requireReadyAuthority: true
    })).toBe("adopted");
    orchestrator.releaseSource("player-visible:travel:critical");
    orchestrator.close();
    await runtime.close();
  });

  it("gates Castle travel on only the destination-containing zone", async () => {
    const activationZoneIds: PopulationZoneV2Id[][] = [];
    const activationPriorities: number[] = [];
    const backend = travelBackend({
      ready: true,
      activationReferences: [],
      activationZoneIds,
      activationPriorities
    });
    const runtime = new PopulationZonesV2Runtime(backend);
    const orchestrator = new PopulationAreaOrchestrator(runtime);
    const request = travelRequest("travel:kingdom");

    const result = await orchestrator.prepareArea({
      ...request,
      source: { ...request.source, kind: "kingdom-travel" }
    });
    const destinationZoneId = populationZoneV2IdForPoint(CENTER);

    expect(result.zoneIds).toEqual([destinationZoneId]);
    expect(activationZoneIds).toEqual([[destinationZoneId]]);
    expect(activationPriorities).toEqual([0]);
    orchestrator.releaseSource(result.sourceId);
    orchestrator.close();
    await runtime.close();
  });
});

function travelRequest(sourceId: string) {
  return {
    area: {
      center: CENTER,
      certifiedVisibleRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
      preparedRadiusM: DEFAULT_FLAG_PREPARE_RADIUS_M,
      sourceType: "area" as const,
      sourceId: "shrine-1",
      generation: 1
    },
    source: {
      sourceId,
      kind: "shrine-travel" as const,
      targetStage: "DURABLE_READY" as const,
      priority: 0 as const,
      createdAtMs: Date.now(),
      travelId: sourceId,
      authorityToken: `authority:${sourceId}`
    }
  };
}

function travelBackend(input: Readonly<{
  ready: boolean;
  activationReferences: Readonly<Record<string, number>>[];
  activationZoneIds?: PopulationZoneV2Id[][];
  activationPriorities?: number[];
}>): PopulationZonesV2RuntimeBackend {
  return {
    activateZones: vi.fn(async (activation) => {
      input.activationZoneIds?.push([...activation.zoneIds]);
      input.activationPriorities?.push(
        ...activation.zoneIds.map((zoneId: PopulationZoneV2Id) =>
          activation.priorityByZone?.[zoneId] ?? -1
        )
      );
      input.activationReferences.push({
        ...activation.currentReferencesByZone
      });
      return activation.zoneIds.map((zoneId: PopulationZoneV2Id) => ({
        zoneId,
        generationId: input.ready ? `generation:${zoneId}` : null,
        materializationStatus: input.ready
          ? "materialization-current" as const
          : "generation-lifecycle-pending" as const,
        status: input.ready ? "ready" as const : "pending" as const,
        entities: [],
        spawnedRuntimeActors: 0,
        completedStage: input.ready
          ? activation.targetStageByZone?.[zoneId] ?? "DURABLE_READY" as const
          : null,
        reason: input.ready ? "ready" as const : "plan-pending" as const,
        authority: input.ready ? {
          zoneId,
          selectedPlanId: `plan:${zoneId}`,
          generationId: `generation:${zoneId}`,
          cutoverRevision: 1,
          commonSchemaRevision: "test-schema-v1",
          registryRevision: "test-registry-v1",
          stateRevisionFingerprint: "state:1",
          ownershipToken: `owner:${zoneId}`
        } : null
      }));
    }),
    sleepZones: vi.fn(async () => ({
      removedEntityIds: [],
      sleptRuntimeActors: 0
    }))
  };
}

function stageBackend(): PopulationZonesV2RuntimeBackend {
  return {
    activateZones: vi.fn(async (input) =>
      input.zoneIds.map((zoneId: PopulationZoneV2Id) => ({
        zoneId,
        generationId: `generation:${zoneId}`,
        materializationStatus: "materialization-current" as const,
        status: "ready" as const,
        entities: [],
        removedEntityIds: [],
        spawnedRuntimeActors: 0,
        completedStage:
          input.targetStageByZone?.[zoneId] ?? "DURABLE_READY",
        reason: "ready" as const,
        authority: null
      }))
    ),
    sleepZones: vi.fn(async (input) => ({
      removedEntityIds: input.zoneIds.map((zoneId: PopulationZoneV2Id) =>
        `entity:${zoneId}`
      ),
      sleptRuntimeActors: 0
    }))
  };
}
