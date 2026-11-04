import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PopulationEnvironmentPrefetchTerminalError
} from "./populationZoneV3HabitatCompiler.js";
import {
  DEFAULT_FLAG_PREPARE_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  destinationPoint
} from "@ash-atlas/shared";

import {
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import {
  type PopulationZoneV2BackendZoneActivation,
  type PopulationZonesV2ActivationDelta,
  type PopulationZonesV2RuntimeBackend,
  PopulationZonesV2Runtime
} from "./populationZonesV2Runtime.js";

const CENTER_A = { lat: 35.0844, lon: -106.6504 };
const CENTER_B = { lat: 35.0844, lon: -106.6449 };
const CENTER_C = { lat: 35.0844, lon: -106.62 };
const ZERO_CHALLENGE_PROFILE = {
  currentGearLevel: 0,
  unlockedGearLevel: 0,
  tier: "common" as const,
  contributors: {
    melee: 0,
    chest: 0,
    secondary: 0
  },
  balanceVersion: 2 as const
};

describe("PopulationZonesV2Runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("keeps retained zones warm through twenty adjacent relocations", async () => {
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend, { sleepGraceMs: 60_000 });
    const seenEntityIds = new Set<string>();
    const authoritativeIdsByDestination = new Map<string, string>();
    let postWarmUpserts = 0;
    let retained = 0;
    let activated = 0;

    for (let visit = 0; visit < 20; visit += 1) {
      const delta = await runtime.relocate({
        playerId: "p1",
        connectionId: "c1",
        connectionGeneration: 1,
        area: area(visit % 2 === 0 ? CENTER_A : CENTER_B),
        relocationRevision: visit + 1,
        resourceVisionRevision: visit + 1,
        challengeProfile: ZERO_CHALLENGE_PROFILE,
        trigger: "flag-travel"
      });
      expect(delta).not.toBeNull();
      retained += delta!.retainedZoneIds.length;
      activated += delta!.activatedZoneIds.length;
      if (visit >= 2) postWarmUpserts += delta!.upserts.length;
      for (const entity of delta!.upserts) seenEntityIds.add(entity.entityId);
      const destination = visit % 2 === 0 ? "a" : "b";
      const authoritativeIds = delta!.upserts
        .map((entity) => entity.entityId)
        .sort()
        .join(",");
      const expectedIds = authoritativeIdsByDestination.get(destination);
      if (expectedIds === undefined) {
        authoritativeIdsByDestination.set(destination, authoritativeIds);
      } else {
        expect(authoritativeIds).toBe(expectedIds);
      }
    }

    expect(backend.activatedZoneIds.size).toBeGreaterThanOrEqual(seenEntityIds.size);
    expect(backend.duplicateZoneActivations).toBe(0);
    expect(postWarmUpserts).toBeGreaterThan(0);
    expect(authoritativeIdsByDestination.size).toBe(2);
    expect(retained).toBeGreaterThan(activated);
    expect(runtime.snapshot().connectionLeases).toBe(1);
    await runtime.close();
  });

  it("batches concurrent first references and shares one zone activation", async () => {
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend);

    const [first, second] = await Promise.all([
      runtime.relocate(relocation("p1", "c1", 1)),
      runtime.relocate(relocation("p2", "c2", 1))
    ]);

    expect(first?.activatedZoneIds).toEqual(second?.activatedZoneIds);
    expect(backend.activateCalls).toHaveLength(2);
    expect(backend.duplicateZoneActivations).toBe(0);
    expect(Object.values(runtime.snapshot().refCounts).every((count) => count === 2))
      .toBe(true);
    await runtime.close();
  });

  it("does not fabricate a zero profile for profile-less simulation work", async () => {
    const activateZones = vi.fn(async (
      input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0]
    ) => input.zoneIds.map((zoneId) => ({
      zoneId,
      generationId: null,
      materializationStatus: "generation-missing" as const,
      status: "pending" as const,
      entities: [],
      spawnedRuntimeActors: 0,
      completedStage: null
    })));
    const runtime = new PopulationZonesV2Runtime({
      activateZones,
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    });
    const zoneId = populationZoneV2IdForPoint(CENTER_A);

    const result = await runtime.prepareZones({
      zoneIds: [zoneId],
      trigger: "world-entry",
      priority: 0,
      targetStage: "SIMULATION_READY",
      activateRuntime: true
    });

    expect(result[0]).toMatchObject({
      status: "pending",
      spawnedRuntimeActors: 0
    });
    expect(activateZones).toHaveBeenCalledOnce();
    expect(activateZones.mock.calls[0]![0].challengeProfilesByZone).toEqual({});
    await runtime.close();
  });

  it("prefetches qualifying destination environment before per-zone activation", async () => {
    const order: string[] = [];
    const prefetchPlanEnvironmentForZones = vi.fn(async () => {
      order.push("prefetch");
    });
    const activateZones = vi.fn(async (
      input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0]
    ) => {
      order.push("activate");
      return input.zoneIds.map((zoneId) => readyActivation(zoneId));
    });
    const runtime = new PopulationZonesV2Runtime({
      prefetchPlanEnvironmentForZones,
      activateZones,
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    });
    const zoneIds = populationZonesV2IntersectingCircle({
      lat: 39.7,
      lon: -105.017
    }, 650);

    await runtime.prepareZones({
      zoneIds,
      trigger: "flag-travel",
      priority: 0,
      targetStage: "DURABLE_READY",
      activateRuntime: false
    });

    expect(zoneIds).toHaveLength(6);
    expect(prefetchPlanEnvironmentForZones).toHaveBeenCalledOnce();
    expect(prefetchPlanEnvironmentForZones).toHaveBeenCalledWith({
      zoneIds,
      trigger: "flag-travel",
      priority: 0
    });
    expect(order[0]).toBe("prefetch");
    expect(order.slice(1).every((entry) => entry === "activate")).toBe(true);
    await runtime.close();
  });

  it("falls back once for retryable prefetch failure", async () => {
    const warn = vi.fn();
    const activateZones = vi.fn(async (
      input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0]
    ) => input.zoneIds.map((zoneId) => readyActivation(zoneId)));
    const prefetchPlanEnvironmentForZones = vi.fn(async () => {
      throw new Error("temporary World failure");
    });
    const runtime = new PopulationZonesV2Runtime({
      prefetchPlanEnvironmentForZones,
      activateZones,
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    }, { logger: { warn } });
    const zones = coldDestinationZoneIds().slice(0, 2);

    const result = await runtime.prepareZones({
      zoneIds: zones,
      trigger: "party-travel",
      priority: 1,
      targetStage: "DURABLE_READY",
      activateRuntime: false
    });

    expect(prefetchPlanEnvironmentForZones).toHaveBeenCalledOnce();
    expect(activateZones).toHaveBeenCalled();
    expect(result.every((entry) => entry.status === "ready")).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "fallback-per-zone" }),
      expect.stringContaining("using per-zone path")
    );
    await runtime.close();
  });

  it("fails closed for terminal prefetch facts and starts no activation", async () => {
    const activateZones = vi.fn();
    const runtime = new PopulationZonesV2Runtime({
      prefetchPlanEnvironmentForZones: vi.fn(async () => {
        throw new PopulationEnvironmentPrefetchTerminalError("wrong release");
      }),
      activateZones,
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    });

    await expect(runtime.prepareZones({
      zoneIds: coldDestinationZoneIds().slice(0, 2),
      trigger: "administrative-relocation",
      priority: 0,
      targetStage: "DURABLE_READY",
      activateRuntime: false
    })).rejects.toThrow("wrong release");
    expect(activateZones).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("aborts an unsettled prefetch without starting activation", async () => {
    const controller = new AbortController();
    const activateZones = vi.fn();
    const prefetchPlanEnvironmentForZones = vi.fn(({ signal }: {
      signal?: AbortSignal;
    }) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    }));
    const runtime = new PopulationZonesV2Runtime({
      prefetchPlanEnvironmentForZones,
      activateZones,
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    });
    const operation = runtime.prepareZones({
      zoneIds: coldDestinationZoneIds().slice(0, 2),
      trigger: "separate-space-exit",
      priority: 0,
      targetStage: "DURABLE_READY",
      activateRuntime: false,
      signal: controller.signal
    });
    await Promise.resolve();
    controller.abort(new DOMException("aborted", "AbortError"));

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(activateZones).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("does not prefetch background, simulation, or single-zone work", async () => {
    const prefetchPlanEnvironmentForZones = vi.fn();
    const activateZones = vi.fn(async (
      input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0]
    ) => input.zoneIds.map((zoneId) => readyActivation(zoneId)));
    const runtime = new PopulationZonesV2Runtime({
      prefetchPlanEnvironmentForZones,
      activateZones,
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    });
    const zones = coldDestinationZoneIds().slice(0, 2);
    for (const input of [
      { zoneIds: zones, trigger: "world-entry" as const, priority: 0 as const,
        targetStage: "DURABLE_READY" as const, activateRuntime: false },
      { zoneIds: zones, trigger: "flag-travel" as const, priority: 0 as const,
        targetStage: "SIMULATION_READY" as const, activateRuntime: true },
      { zoneIds: zones, trigger: "flag-travel" as const, priority: 2 as const,
        targetStage: "PLAN_READY" as const, activateRuntime: false },
      { zoneIds: zones.slice(0, 1), trigger: "flag-travel" as const,
        priority: 0 as const, targetStage: "DURABLE_READY" as const,
        activateRuntime: false }
    ]) {
      await runtime.prepareZones(input);
    }
    expect(prefetchPlanEnvironmentForZones).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("diagnoses missing authoritative equipment for player-visible activation", async () => {
    const warn = vi.fn();
    const runtime = new PopulationZonesV2Runtime(new FakeBackend(), {
      logger: { warn }
    });
    const {
      challengeProfile,
      ...profilelessRelocation
    } = relocation("player-missing-profile", "connection-missing-profile", 3);
    expect(challengeProfile).toBeDefined();

    await runtime.relocate({
      ...profilelessRelocation,
      trigger: "flag-travel"
    });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: "player-missing-profile",
        connectionId: "connection-missing-profile",
        connectionGeneration: 1,
        relocationRevision: 3,
        preparationGeneration: 1,
        trigger: "flag-travel",
        zoneIds: expect.any(Array)
      }),
      "player-visible population activation is missing an authoritative challenge profile"
    );
    await runtime.close();
  });

  it("uses the strongest active unlocked profile for overlapping visible work", async () => {
    const activateZones = vi.fn(async (
      input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0]
    ) => input.zoneIds.map((zoneId) => readyActivation(zoneId)));
    const runtime = new PopulationZonesV2Runtime({
      activateZones,
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    });
    const profile = (level: number) => ({
      ...ZERO_CHALLENGE_PROFILE,
      currentGearLevel: level,
      unlockedGearLevel: level,
      contributors: {
        melee: level,
        chest: level,
        secondary: level
      }
    });

    await Promise.all([
      runtime.relocate({
        ...relocation("player-8", "connection-8", 1),
        challengeProfile: profile(8)
      }),
      runtime.relocate({
        ...relocation("player-9", "connection-9", 1),
        challengeProfile: profile(9)
      })
    ]);

    const claimedProfiles = activateZones.mock.calls.flatMap(
      ([input]) => Object.values(input.challengeProfilesByZone ?? {})
    );
    expect(claimedProfiles.length).toBeGreaterThan(0);
    expect(claimedProfiles.every(
      (challengeProfile) => challengeProfile.unlockedGearLevel === 9
    )).toBe(true);
    await runtime.close();
  });

  it("shares one cold activation across twenty concurrent players", async () => {
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const deltas = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      runtime.relocate(relocation(`p${index}`, `c${index}`, 1))
    ));

    expect(deltas.every((delta) => delta?.terminal === true)).toBe(true);
    expect(backend.activateCalls).toHaveLength(2);
    expect(backend.duplicateZoneActivations).toBe(0);
    expect(Object.values(runtime.snapshot().refCounts).every((count) => count === 20))
      .toBe(true);
    await runtime.close();
  });

  it("reuses one generation with exact IDs and counts across twenty returns", async () => {
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 0
    });
    const targetZoneId = populationZoneV2IdForPoint(CENTER_A);
    const relocate = (revision: number) => runtime.relocate({
      playerId: "p1",
      connectionId: "c1",
      connectionGeneration: 1,
      area: area(CENTER_A, 1, 2),
      relocationRevision: revision,
      resourceVisionRevision: revision,
      trigger: "flag-travel"
    });
    const first = await relocate(1);
    const expectedIds = first!.upserts.map((entity) => entity.entityId).sort();
    const expectedCount = first!.upserts.length;

    for (let visit = 1; visit <= 20; visit += 1) {
      runtime.releaseConnection("c1", 1);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
      const returned = await relocate(visit + 1);
      expect(returned!.upserts.map((entity) => entity.entityId).sort())
        .toEqual(expectedIds);
      expect(returned!.upserts).toHaveLength(expectedCount);
      expect(new Set(returned!.upserts.map((entity) => entity.entityId)).size)
        .toBe(expectedCount);
    }

    expect(backend.generationCreationCount(targetZoneId)).toBe(1);
    expect(backend.generatedZoneIds).toEqual(new Set([targetZoneId]));
    await runtime.close();
  });

  it("synchronizes shared and zero-reference runtime cache counts", async () => {
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    await Promise.all([
      runtime.relocate(relocation("p1", "c1", 1)),
      runtime.relocate(relocation("p2", "c2", 1))
    ]);
    const zoneId = runtime.activeZoneIds()[0]!;

    expect(backend.latestReferenceCount(zoneId)).toBe(2);
    runtime.releaseConnection("c1", 1);
    expect(backend.latestReferenceCount(zoneId)).toBe(1);
    runtime.releaseConnection("c2", 1);
    expect(backend.latestReferenceCount(zoneId)).toBe(0);
    expect(backend.latestUnreferencedAt(zoneId)).toEqual(expect.any(Number));
    await runtime.close();
  });

  it("activates certified vision destination-first at simulation-capable priority", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const published: Array<{
      activatedZoneIds: readonly PopulationZoneV2Id[];
      upserts: number;
      visibleZoneCount: number;
      readyVisibleZoneCount: number;
      partial: boolean;
      terminal: boolean;
    }> = [];
    runtime.onDelta((delta) => {
      published.push({
        activatedZoneIds: delta.activatedZoneIds,
        upserts: delta.upserts.length,
        visibleZoneCount: delta.visibleZoneCount,
        readyVisibleZoneCount: delta.readyVisibleZoneCount,
        partial: delta.partial,
        terminal: delta.terminal
      });
    });

    const relocating = runtime.relocate(relocation("p1", "c1", 1));
    await flushMicrotasks();
    expect(backend.callCount()).toBe(1);
    const visibleZoneIds = populationZonesV2IntersectingCircle(
      CENTER_A,
      DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
    );
    const visibleSet = new Set(visibleZoneIds);
    const preparedOnlyZoneIds = populationZonesV2IntersectingCircle(
      CENTER_A,
      DEFAULT_FLAG_PREPARE_RADIUS_M
    ).filter((zoneId) => !visibleSet.has(zoneId));
    const destinationZoneId = populationZoneV2IdForPoint(CENTER_A);
    expect(backend.zoneIdsForCall(0)[0]).toBe(destinationZoneId);
    expect(new Set(backend.zoneIdsForCall(0))).toEqual(new Set(visibleZoneIds));
    expect(backend.prioritiesForCall(0)).toEqual(
      Object.fromEntries(visibleZoneIds.map((zoneId) => [zoneId, 0]))
    );

    backend.resolveCall(0);
    await flushMicrotasks();
    if (preparedOnlyZoneIds.length > 0) {
      expect(new Set(backend.zoneIdsForCall(1))).toEqual(
        new Set(preparedOnlyZoneIds)
      );
      expect(backend.prioritiesForCall(1)).toEqual(
        Object.fromEntries(preparedOnlyZoneIds.map((zoneId) => [zoneId, 2]))
      );
      backend.resolveCall(1);
      await flushMicrotasks();
    }
    await expect(relocating).resolves.toMatchObject({
      partial: false,
      terminal: true,
      visibleZoneCount: visibleZoneIds.length,
      readyVisibleZoneCount: visibleZoneIds.length
    });
    expect(published).toHaveLength(visibleZoneIds.length);
    expect(published.map((delta) => delta.readyVisibleZoneCount)).toEqual(
      visibleZoneIds.map((_, index) => index + 1)
    );
    expect(published.every((delta) =>
      delta.visibleZoneCount === visibleZoneIds.length
    )).toBe(true);
    expect(published[0]).toMatchObject({
      readyVisibleZoneCount: 1,
      partial: visibleZoneIds.length > 1,
      terminal: visibleZoneIds.length === 1
    });
    expect(published.at(-1)).toMatchObject({ partial: false, terminal: true });
    await runtime.close();
  });

  it("resolves usable readiness after the first published Priority-0 zone without waiting for the rest", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const published: boolean[] = [];
    runtime.onDelta((delta) => {
      published.push(delta.terminal);
    });

    const handle = runtime.startRelocation(relocation(
      "p1",
      "c1",
      1
    ));
    let completed = false;
    void handle.completion.then(() => {
      completed = true;
    });
    await flushMicrotasks();
    expect(backend.callCount()).toBe(1);

    backend.resolveCall(0);
    await flushMicrotasks();
    expect(backend.callCount()).toBe(2);
    await expect(handle.visibleReady).resolves.toMatchObject({
      status: "ready",
      pendingVisibleZoneCount: handle.visibleZoneCount - 1,
      delta: { partial: true, terminal: false }
    });
    expect(published.at(-1)).toBe(true);
    expect(published.slice(0, -1).every((terminal) => !terminal)).toBe(true);
    expect(completed).toBe(false);

    backend.resolveCall(1);
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed"
    });
    await runtime.close();
  });

  it("publishes travel from the destination while all visible zones remain simulation-capable", async () => {
    let activationInput:
      | Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0]
      | undefined;
    let resolveBatch!: (
      activations: readonly PopulationZoneV2BackendZoneActivation[]
    ) => void;
    const backend: PopulationZonesV2RuntimeBackend = {
      activateZones: vi.fn((input) => {
        activationInput = input;
        return new Promise<readonly PopulationZoneV2BackendZoneActivation[]>((resolve) => {
          resolveBatch = resolve;
        });
      }),
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    };
    const runtime = new PopulationZonesV2Runtime(backend);
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });
    const handle = runtime.startRelocation({
      ...relocation("p1", "c1", 1),
      area: area(
        CENTER_A,
        DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
        DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M + 1
      )
    });

    await flushMicrotasks();
    const zoneIds = [...(activationInput?.zoneIds ?? [])];
    expect(zoneIds.length).toBeGreaterThan(1);
    expect(zoneIds[0]).toBe(populationZoneV2IdForPoint(CENTER_A));
    expect(zoneIds.every((zoneId) =>
      activationInput?.priorityByZone?.[zoneId] === 0
    )).toBe(true);

    activationInput?.onZoneActivated?.(readyActivation(zoneIds[0]!));
    await expect(handle.visibleReady).resolves.toMatchObject({
      status: "ready",
      pendingVisibleZoneCount: zoneIds.length - 1,
      delta: {
        readyVisibleZoneCount: 1,
        partial: true,
        terminal: false
      }
    });
    expect(published).toHaveLength(1);
    let presentationReady = false;
    void handle.presentationReady.then(() => {
      presentationReady = true;
    });
    await flushMicrotasks();
    expect(presentationReady).toBe(false);

    const remaining = zoneIds.slice(1).map((zoneId) => readyActivation(zoneId));
    for (const activation of remaining) {
      activationInput?.onZoneActivated?.(activation);
    }
    resolveBatch([readyActivation(zoneIds[0]!), ...remaining]);
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      delta: { partial: false, terminal: true }
    });
    await expect(handle.presentationReady).resolves.toMatchObject({
      status: "ready",
      pendingVisibleZoneCount: 0,
      delta: {
        readyVisibleZoneCount: zoneIds.length,
        visibleZoneCount: zoneIds.length,
        partial: false,
        terminal: true
      }
    });
    await runtime.close();
  });

  it("keeps visible readiness pending until a partial visible zone publishes terminal readiness", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const centerZoneId = populationZoneV2IdForPoint(CENTER_A);
    const handle = runtime.startRelocation({
      ...relocation("p1", "c1", 1),
      area: area(CENTER_A, 1, 2)
    });
    let visibleReady = false;
    void handle.visibleReady.then(() => {
      visibleReady = true;
    });

    await flushMicrotasks();
    backend.resolveCallPending(0);
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      delta: { partial: true, terminal: false }
    });
    expect(visibleReady).toBe(false);
    expect(handle.pendingVisibleZoneCount()).toBe(1);

    const ready = runtime.notifyZoneReady(centerZoneId);
    await flushMicrotasks();
    backend.resolveCall(1, "visible-ready");
    await ready;
    await expect(handle.visibleReady).resolves.toMatchObject({
      status: "ready",
      delta: { partial: false, terminal: true }
    });
    await expect(handle.presentationReady).resolves.toMatchObject({
      status: "ready",
      pendingVisibleZoneCount: 0,
      delta: { partial: false, terminal: true }
    });
    await runtime.close();
  });

  it("degrades presentation immediately when a visible plan is terminal", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const handle = runtime.startRelocation({
      ...relocation("p1", "c1", 1),
      area: area(
        CENTER_A,
        DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
        DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M + 1
      )
    });

    await flushMicrotasks();
    const visibleZoneIds = backend.zoneIdsForCall(0);
    expect(visibleZoneIds.length).toBeGreaterThan(1);
    backend.resolveCallWith(0, visibleZoneIds.map((zoneId, index) =>
      index === 0
        ? readyActivation(zoneId, "preserved")
        : {
            zoneId,
            generationId: null,
            materializationStatus: "generation-missing",
            status: "pending",
            entities: [],
            spawnedRuntimeActors: 0,
            reason: "plan-terminal-failure"
          }
    ));

    await expect(handle.visibleReady).resolves.toMatchObject({
      status: "ready",
      pendingVisibleZoneCount: visibleZoneIds.length - 1
    });
    await expect(handle.presentationReady).resolves.toMatchObject({
      status: "degraded",
      pendingVisibleZoneCount: visibleZoneIds.length - 1,
      delta: {
        preparationReason: "plan-terminal-failure",
        preparationResult: "degraded",
        terminal: true
      }
    });
    await expect(handle.completion).resolves.toMatchObject({
      delta: { preparationResult: "degraded", terminal: true }
    });
    await runtime.close();
  });

  it("retries only incomplete visible zones once and then publishes one terminal failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const backend = new DeferredBackend();
    const logger = { warn: vi.fn() };
    const runtime = new PopulationZonesV2Runtime(backend, {
      visiblePreparationStaleMs: 100,
      visiblePreparationTerminalMs: 200,
      visiblePreparationRetryLimit: 1,
      logger
    });
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });
    const handle = runtime.startRelocation({
      ...relocation("p1", "c1", 1),
      area: area(
        CENTER_A,
        DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
        DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M + 1
      )
    });

    await flushMicrotasks();
    const visibleZoneIds = backend.zoneIdsForCall(0);
    expect(visibleZoneIds.length).toBeGreaterThan(1);
    backend.resolveCallWith(0, visibleZoneIds.map((zoneId, index) =>
      index === 0
        ? readyActivation(zoneId, "preserved")
        : {
            zoneId,
            generationId: generationIdForZone(zoneId),
            materializationStatus: "guarded-materialization",
            status: "pending",
            entities: [],
            spawnedRuntimeActors: 0
          }
    ));
    await expect(handle.completion).resolves.toMatchObject({
      delta: { preparationResult: "pending", terminal: false }
    });

    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    expect(backend.callCount()).toBe(2);
    expect(new Set(backend.zoneIdsForCall(1))).toEqual(
      new Set(visibleZoneIds.slice(1))
    );
    backend.resolveCallWith(1, visibleZoneIds.slice(1).map((zoneId) => ({
      zoneId,
      generationId: generationIdForZone(zoneId),
      materializationStatus: "guarded-materialization",
      status: "pending",
      entities: [],
      spawnedRuntimeActors: 0
    })));
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(100);
    await expect(handle.visibleReady).resolves.toMatchObject({
      status: "ready",
      pendingVisibleZoneCount: visibleZoneIds.length - 1
    });
    await expect(handle.presentationReady).resolves.toMatchObject({
      status: "degraded",
      pendingVisibleZoneCount: visibleZoneIds.length - 1
    });
    const terminals = published.filter((delta) => delta.terminal);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      preparationResult: "degraded",
      partial: false,
      readyVisibleZoneCount: 1,
      releasedZoneIds: visibleZoneIds.slice(1).sort(),
      withheldZoneIds: visibleZoneIds.slice(1).sort(),
      upserts: [expect.objectContaining({
        entityId: `preserved:${visibleZoneIds[0]}`
      })]
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    for (const [context] of logger.warn.mock.calls) {
      expect(context).toMatchObject({
        pendingPlanZoneIds: [],
        lifecyclePendingZoneIds: [],
        guardedMaterializationZoneIds: visibleZoneIds.slice(1).sort(),
        replacementRequiredZoneIds: [],
        materializationStatusByIncompleteZone: Object.fromEntries(
          visibleZoneIds.slice(1).map((zoneId) => [
            zoneId,
            "guarded-materialization"
          ])
        ),
        planner: undefined
      });
    }
    expect(runtime.snapshot()).toMatchObject({
      pendingPlanZones: 0,
      pendingActivationZones: visibleZoneIds.length - 1,
      materializationStatusByZone: Object.fromEntries([
        [visibleZoneIds[0], "materialization-current"],
        ...visibleZoneIds.slice(1).map((zoneId) => [
          zoneId,
          "guarded-materialization"
        ])
      ])
    });

    const republished = runtime.republishConnection({
      playerId: "p1",
      connectionId: "c1",
      connectionGeneration: 1,
      preparationGeneration: handle.preparationGeneration,
      relocationRevision: 1,
      resourceVisionRevision: 1
    });
    expect(republished).toMatchObject({
      status: "republished",
      state: {
        preparationResult: "degraded",
        terminal: true
      }
    });
    expect(published.filter((delta) => delta.terminal)).toHaveLength(2);
    expect(published.at(-1)).toEqual(terminals[0]);

    const recoveryPublicationStart = published.length;
    for (const zoneId of visibleZoneIds.slice(1)) {
      const refreshing = runtime.notifyZoneReady(zoneId);
      await flushMicrotasks();
      const callIndex = backend.callCount() - 1;
      expect(backend.zoneIdsForCall(callIndex)).toEqual([zoneId]);
      backend.resolveCall(callIndex, "recovered");
      await refreshing;
    }
    expect(published.at(-1)).toMatchObject({
      preparationResult: "ready",
      terminal: true,
      readyVisibleZoneCount: visibleZoneIds.length,
      withheldZoneIds: []
    });
    expect(published.slice(recoveryPublicationStart, -1).every((delta) =>
      delta.preparationResult === "pending" &&
      !delta.terminal &&
      delta.withheldZoneIds.length > 0
    )).toBe(true);
    await runtime.close();
  });

  it("recovers an isolated visible activation failure without discarding healthy zones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let activationAttempt = 0;
    const activateZones = vi.fn(async (
      input: Parameters<PopulationZonesV2RuntimeBackend["activateZones"]>[0]
    ) => {
      activationAttempt += 1;
      if (activationAttempt === 1) {
        input.onZoneActivated?.(readyActivation(input.zoneIds[0]!, "healthy"));
        throw new Error("one zone could not activate");
      }
      return input.zoneIds.map((zoneId) => readyActivation(zoneId, "recovered"));
    });
    const backend: PopulationZonesV2RuntimeBackend = {
      activateZones,
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    };
    const runtime = new PopulationZonesV2Runtime(backend, {
      visiblePreparationStaleMs: 100,
      visiblePreparationTerminalMs: 200,
      visiblePreparationRetryLimit: 1,
      logger: { warn: vi.fn() }
    });
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });

    const handle = runtime.startRelocation({
      ...relocation("p1", "c1", 1),
      area: area(
        CENTER_A,
        DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
        DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M + 1
      )
    });
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      delta: { preparationResult: "pending", terminal: false }
    });
    expect(published.some((delta) => delta.upserts.some((entity) =>
      entity.entityId.startsWith("healthy:")
    ))).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    await expect(handle.presentationReady).resolves.toMatchObject({
      status: "ready",
      pendingVisibleZoneCount: 0,
      delta: { preparationResult: "ready", terminal: true }
    });
    expect(activateZones).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it("degrades world entry after bounded activation recovery is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const activateZones = vi.fn(async () => {
      throw new Error("population store unavailable");
    });
    const runtime = new PopulationZonesV2Runtime({
      activateZones,
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    }, {
      visiblePreparationStaleMs: 100,
      visiblePreparationTerminalMs: 200,
      visiblePreparationRetryLimit: 1,
      logger: { warn: vi.fn() }
    });
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });

    const handle = runtime.startRelocation(relocation("p1", "c1", 1));
    await expect(handle.completion).resolves.toMatchObject({
      status: "completed",
      delta: { preparationResult: "pending", terminal: false }
    });
    await vi.advanceTimersByTimeAsync(200);

    await expect(handle.presentationReady).resolves.toMatchObject({
      status: "degraded",
      delta: {
        preparationResult: "degraded",
        withheldZoneIds: expect.arrayContaining([expect.any(String)]),
        terminal: true
      }
    });
    expect(activateZones.mock.calls.length).toBeGreaterThan(1);
    expect(published.at(-1)).toMatchObject({
      preparationResult: "degraded",
      partial: false,
      terminal: true
    });
    await runtime.close();
  });

  it("republishes current population authority for matching or older operations without new activation", async () => {
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });
    const delta = await runtime.relocate(relocation("p1", "c1", 1));
    expect(delta).not.toBeNull();
    const activationCalls = backend.activateCalls.length;
    const activatedZoneIds = [...backend.activatedZoneIds].sort();
    const refCounts = runtime.snapshot().refCounts;
    const publicationCount = published.length;

    expect(runtime.republishConnection({
      playerId: "p1",
      connectionId: "c1",
      connectionGeneration: 1,
      preparationGeneration: delta!.preparationGeneration,
      relocationRevision: 1,
      resourceVisionRevision: 1
    })).toMatchObject({ status: "republished" });
    expect(runtime.republishConnection({
      playerId: "p1",
      connectionId: "c1",
      connectionGeneration: 1,
      preparationGeneration: 0,
      relocationRevision: 0,
      resourceVisionRevision: 0
    })).toMatchObject({ status: "republished" });

    expect(published).toHaveLength(publicationCount + 2);
    expect(published.slice(-2)).toEqual([
      expect.objectContaining({
        preparationGeneration: delta!.preparationGeneration,
        preparationResult: "ready",
        terminal: true
      }),
      expect.objectContaining({
        preparationGeneration: delta!.preparationGeneration,
        preparationResult: "ready",
        terminal: true
      })
    ]);
    expect(backend.activateCalls).toHaveLength(activationCalls);
    expect([...backend.activatedZoneIds].sort()).toEqual(activatedZoneIds);
    expect(runtime.snapshot().refCounts).toEqual(refCounts);
    expect(backend.duplicateZoneActivations).toBe(0);
    await runtime.close();
  });

  it("preserves cold-area density and permanent-stone identity while republishing", async () => {
    const activateZones = vi.fn(async (
      input: { zoneIds: readonly PopulationZoneV2Id[] }
    ) => input.zoneIds.map((zoneId) => ({
      zoneId,
      generationId: generationIdForZone(zoneId),
      materializationStatus: "materialization-current" as const,
      status: "ready" as const,
      entities: [
        runtimeEntity(`tree:${zoneId}`, "tree", zoneId, CENTER_A),
        runtimeEntity(`stone:${zoneId}`, "stone", zoneId, CENTER_A)
      ],
      spawnedRuntimeActors: 1
    })));
    const runtime = new PopulationZonesV2Runtime({
      activateZones,
      sleepZones: vi.fn(async () => ({
        removedEntityIds: [],
        sleptRuntimeActors: 0
      }))
    });
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });
    const initial = await runtime.relocate(relocation("p1", "c1", 1));
    expect(initial).not.toBeNull();
    const before = published.at(-1)!;
    const beforeIds = before.upserts.map((entity) => entity.entityId).sort();
    const beforeStones = before.upserts
      .filter((entity) => entity.kind === "stone")
      .map((entity) => ({
        entityId: entity.entityId,
        generationId: entity.generationId
      }))
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    const activationCalls = activateZones.mock.calls.length;
    const refCounts = runtime.snapshot().refCounts;

    expect(runtime.republishConnection({
      playerId: "p1",
      connectionId: "c1",
      connectionGeneration: 1,
      preparationGeneration: initial!.preparationGeneration,
      relocationRevision: 1,
      resourceVisionRevision: 1
    })).toMatchObject({ status: "republished" });

    const recovered = published.at(-1)!;
    expect(recovered.upserts.map((entity) => entity.entityId).sort())
      .toEqual(beforeIds);
    expect(recovered.upserts).toHaveLength(before.upserts.length);
    expect(recovered.upserts
      .filter((entity) => entity.kind === "stone")
      .map((entity) => ({
        entityId: entity.entityId,
        generationId: entity.generationId
      }))
      .sort((left, right) => left.entityId.localeCompare(right.entityId)))
      .toEqual(beforeStones);
    expect(beforeStones.every((stone) => stone.generationId === null)).toBe(true);
    expect(activateZones).toHaveBeenCalledTimes(activationCalls);
    expect(runtime.snapshot().refCounts).toEqual(refCounts);
    await runtime.close();
  });

  it("does not republish authority from a replaced connection generation", async () => {
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    await runtime.relocate(relocation("p1", "c1", 1));
    runtime.releaseConnection("c1", 1);
    await runtime.relocate({
      ...relocation("p1", "c1", 2),
      connectionGeneration: 2
    });

    expect(runtime.republishConnection({
      playerId: "p1",
      connectionId: "c1",
      connectionGeneration: 1,
      preparationGeneration: 1,
      relocationRevision: 1,
      resourceVisionRevision: 1
    })).toMatchObject({ status: "missing" });
    await runtime.close();
  });

  it("settles a superseded visible handle as stale without releasing the replacement lease", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });
    const first = runtime.startRelocation(relocation("p1", "c1", 1));
    await flushMicrotasks();
    const replacement = runtime.startRelocation({
      ...relocation("p1", "c1", 2),
      area: area(CENTER_C, 1, 2)
    });
    await flushMicrotasks();

    backend.resolveCall(0);
    await expect(first.visibleReady).resolves.toMatchObject({ status: "stale" });
    await flushMicrotasks();
    backend.resolveCall(1);
    await expect(replacement.visibleReady).resolves.toMatchObject({
      status: "ready"
    });
    expect(published.find((delta) =>
      delta.preparationResult === "stale"
    )).toMatchObject({
      connectionId: "c1",
      connectionGeneration: 1,
      preparationGeneration: 1,
      preparationResult: "stale",
      terminal: true,
      upserts: []
    });
    expect(published.find((delta) =>
      delta.preparationResult === "ready"
    )?.preparationGeneration).toBe(2);
    expect(runtime.snapshot().connectionLeases).toBe(1);
    await runtime.close();
  });

  it("projects population-owned entities at 649m and leaves permanent stone to repeatable authority", async () => {
    const centerZoneId = populationZoneV2IdForPoint(CENTER_A);
    const inside = destinationPoint(CENTER_A, 649, 0);
    const outside = destinationPoint(CENTER_A, 651, 0);
    const kinds = ["tree", "deer", "stone"] as const;
    const backend: PopulationZonesV2RuntimeBackend = {
      activateZones: async (input) => input.zoneIds.map((zoneId) => ({
        zoneId,
        generationId: generationIdForZone(zoneId),
        materializationStatus: "materialization-current" as const,
        status: "ready" as const,
        entities: zoneId === centerZoneId
          ? kinds.flatMap((kind) => [
              runtimeEntity(`${kind}-649`, kind, centerZoneId, inside),
              runtimeEntity(`${kind}-651`, kind, centerZoneId, outside)
            ])
          : [],
        spawnedRuntimeActors: 0
      })),
      sleepZones: async () => ({ removedEntityIds: [], sleptRuntimeActors: 0 })
    };
    const runtime = new PopulationZonesV2Runtime(backend);
    const delta = await runtime.relocate(relocation("p1", "c1", 1));

    expect(delta?.upserts.map((entity) => entity.entityId).sort()).toEqual([
      "deer-649",
      "tree-649"
    ]);
    expect(delta?.zoneSnapshots).toContainEqual({
      zoneId: centerZoneId,
      generationId: generationIdForZone(centerZoneId),
      entityIds: ["deer-649", "tree-649"]
    });
    expect(delta?.visibleZoneCount).toBe(delta?.readyVisibleZoneCount);
    expect(delta?.zoneSnapshots).toHaveLength(delta?.visibleZoneCount ?? 0);
    expect(Object.keys(runtime.snapshot().refCounts)).toEqual(
      populationZonesV2IntersectingCircle(CENTER_A, DEFAULT_FLAG_PREPARE_RADIUS_M)
    );
    await runtime.close();
  });

  it("publishes a ready certified zone after a pending plan completes", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const centerZoneId = populationZoneV2IdForPoint(CENTER_A);
    const published: Array<{
      upsertIds: string[];
      partial: boolean;
      relocationRevision: number;
    }> = [];
    runtime.onDelta((delta) => {
      published.push({
        upsertIds: delta.upserts.map((entity) => entity.entityId),
        partial: delta.partial,
        relocationRevision: delta.relocationRevision
      });
    });

    const relocating = runtime.relocate({
      ...relocation("p1", "c1", 1),
      area: area(CENTER_A, 1, 2)
    });
    await flushMicrotasks();
    backend.resolveCallPending(0);
    await flushMicrotasks();
    expect(backend.callCount()).toBe(1);
    expect(published[0]).toMatchObject({
      upsertIds: [],
      partial: true,
      relocationRevision: 1
    });

    const ready = runtime.notifyZoneReady(centerZoneId);
    await flushMicrotasks();
    expect(backend.callCount()).toBe(2);
    backend.resolveCall(1, "ready-center");
    await ready;
    expect(published.at(-1)).toMatchObject({
      upsertIds: [`ready-center:${centerZoneId}`],
      partial: false,
      relocationRevision: 1
    });
    await expect(relocating).resolves.toMatchObject({
      partial: true,
      terminal: false
    });
    await runtime.close();
  });

  it("reuses a warm zone with stable IDs before the sleep grace expires", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 60_000
    });
    const initial = await runtime.relocate(relocation("p1", "c1", 1));
    const initialIds = initial!.upserts.map((entity) => entity.entityId);
    runtime.releaseConnection("c1", 1);

    await vi.advanceTimersByTimeAsync(59_000);
    const revisited = await runtime.relocate(relocation("p1", "c1", 2));

    expect(backend.activateCalls).toHaveLength(2);
    expect(revisited?.upserts.map((entity) => entity.entityId)).toEqual(initialIds);
    expect(backend.sleepCalls).toHaveLength(0);
    await runtime.close();
  });

  it("rehydrates stable durable IDs after sleep without duplicating actors", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 100
    });
    const initial = await runtime.relocate(relocation("p1", "c1", 1));
    const initialIds = initial!.upserts.map((entity) => entity.entityId);
    runtime.releaseConnection("c1", 1);
    await vi.advanceTimersByTimeAsync(101);
    await flushMicrotasks();

    expect(runtime.snapshot()).toMatchObject({
      simulationResidentZones: 0,
      descriptorCacheZones: expect.any(Number)
    });
    expect(runtime.snapshot().descriptorCacheZones).toBeGreaterThan(0);
    expect(backend.sleepCalls).toHaveLength(1);
    const revisited = await runtime.relocate(relocation("p1", "c1", 2));

    expect(backend.activateCalls).toHaveLength(3);
    expect(revisited?.upserts.map((entity) => entity.entityId)).toEqual(initialIds);
    expect(backend.duplicateZoneActivations).toBe(0);
    await runtime.close();
  });

  it("joins speculative preparation and visible relocation on one zone flight", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const zoneIds = populationZonesV2IntersectingCircle(
      CENTER_A,
      DEFAULT_FLAG_PREPARE_RADIUS_M
    );

    const prepared = runtime.prepareZones({
      zoneIds,
      trigger: "flag-placement",
      priority: 0,
      activateRuntime: false
    });
    const relocationPromise = runtime.relocate({
      ...relocation("p1", "c1", 1),
      area: area(CENTER_A)
    });
    await flushMicrotasks();

    expect(backend.callCount()).toBe(1);
    backend.resolveCall(0);
    await expect(prepared).resolves.toHaveLength(zoneIds.length);
    await expect(relocationPromise).resolves.toMatchObject({ terminal: true });
    expect(backend.callCount()).toBe(1);
    await runtime.close();
  });

  it("consumes one completed simulation result for a request arriving in flight", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      inflightResultReuseEnabled: true
    });
    const zoneId = populationZonesV2IntersectingCircle(
      CENTER_A,
      DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
    )[0]!;
    const prepared = runtime.prepareZones({
      zoneIds: [zoneId],
      trigger: "flag-travel",
      priority: 1,
      targetStage: "SIMULATION_READY",
      activateRuntime: true
    });
    await flushMicrotasks();
    expect(backend.callCount()).toBe(1);

    const equivalent = runtime.prepareZones({
      zoneIds: [zoneId],
      trigger: "explicit-relocation",
      priority: 0,
      targetStage: "SIMULATION_READY",
      activateRuntime: true
    });
    await flushMicrotasks();
    backend.resolveCallWith(0, [{
      ...readyActivation(zoneId),
      completedStage: "SIMULATION_READY"
    }]);

    await expect(prepared).resolves.toHaveLength(1);
    await expect(equivalent).resolves.toHaveLength(1);
    expect(backend.callCount()).toBe(1);
    expect(runtime.snapshot()).toMatchObject({
      activationRequests: 0,
      activationWaiters: 0
    });
    await runtime.close();
  });

  it("consumes durable work once and requeues only an in-flight simulation promotion", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      inflightResultReuseEnabled: true
    });
    const zoneId = populationZonesV2IntersectingCircle(
      CENTER_A,
      DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
    )[0]!;
    const durable = runtime.prepareZones({
      zoneIds: [zoneId],
      trigger: "flag-travel",
      priority: 1,
      targetStage: "DURABLE_READY",
      activateRuntime: false
    });
    await flushMicrotasks();
    const simulation = runtime.prepareZones({
      zoneIds: [zoneId],
      trigger: "flag-travel",
      priority: 1,
      targetStage: "SIMULATION_READY",
      activateRuntime: true
    });
    await flushMicrotasks();
    backend.resolveCallWith(0, [{
      ...readyActivation(zoneId),
      completedStage: "DURABLE_READY",
      spawnedRuntimeActors: 0
    }]);

    await expect(durable).resolves.toHaveLength(1);
    await flushMicrotasks();
    expect(backend.callCount()).toBe(2);
    backend.resolveCallWith(1, [{
      ...readyActivation(zoneId),
      completedStage: "SIMULATION_READY"
    }]);
    await expect(simulation).resolves.toHaveLength(1);
    expect(backend.callCount()).toBe(2);
    expect(runtime.snapshot()).toMatchObject({
      activationRequests: 0,
      activationWaiters: 0
    });
    await runtime.close();
  });

  it("keeps prepared-radius relocation work durable-only through readiness refresh", async () => {
    const calls: Array<Parameters<
      PopulationZonesV2RuntimeBackend["activateZones"]
    >[0]> = [];
    let backgroundReady = false;
    const backend: PopulationZonesV2RuntimeBackend = {
      async activateZones(input) {
        calls.push(input);
        return input.zoneIds.map((zoneId) => {
          const targetStage = input.targetStageByZone?.[zoneId]
            ?? "SIMULATION_READY";
          if (targetStage === "DURABLE_READY" && !backgroundReady) {
            return {
              zoneId,
              generationId: generationIdForZone(zoneId),
              materializationStatus: "generation-invalid-or-unservable",
              status: "pending",
              entities: [],
              spawnedRuntimeActors: 0,
              completedStage: null
            };
          }
          return {
            ...readyActivation(zoneId),
            completedStage: targetStage
          };
        });
      },
      async sleepZones() {
        return { removedEntityIds: [], sleptRuntimeActors: 0 };
      }
    };
    const runtime = new PopulationZonesV2Runtime(backend, {
      inflightResultReuseEnabled: true
    });
    const relocationArea = area(CENTER_A, 1, DEFAULT_FLAG_PREPARE_RADIUS_M);
    const visibleZoneIds = new Set(populationZonesV2IntersectingCircle(
      relocationArea.center,
      relocationArea.certifiedVisibleRadiusM
    ));

    await runtime.relocate({
      ...relocation("p1", "c1", 1),
      area: relocationArea
    });
    const backgroundCall = calls.find((call) =>
      call.zoneIds.some((zoneId) => !visibleZoneIds.has(zoneId))
    );
    expect(backgroundCall).toBeDefined();
    expect(backgroundCall?.activateRuntime).toBe(false);
    const backgroundZoneId = backgroundCall!.zoneIds.find((zoneId) =>
      !visibleZoneIds.has(zoneId)
    )!;

    backgroundReady = true;
    await runtime.notifyZoneReady(backgroundZoneId);
    expect(calls.at(-1)).toMatchObject({
      zoneIds: [backgroundZoneId],
      activateRuntime: false
    });
    await runtime.close();
  });

  it("retains validated durable descriptors after actor sleep", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 100
    });
    await runtime.relocate(relocation("p1", "c1", 1));
    runtime.releaseConnection("c1", 1);

    await vi.advanceTimersByTimeAsync(101);
    await flushMicrotasks();

    expect(backend.sleepCalls).toHaveLength(1);
    expect(runtime.snapshot()).toMatchObject({
      simulationResidentZones: 0,
      descriptorCacheZones: expect.any(Number)
    });
    expect(runtime.snapshot().descriptorCacheZones).toBeGreaterThan(0);
    await runtime.close();
  });

  it("reuses only descriptors that still match durable authority", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 100
    });
    await runtime.relocate(relocation("p1", "c1", 1));
    runtime.releaseConnection("c1", 1);
    await vi.advanceTimersByTimeAsync(101);
    await flushMicrotasks();

    const cachedZoneCount = runtime.snapshot().descriptorCacheZones;
    expect(cachedZoneCount).toBeGreaterThan(0);
    await runtime.relocate(relocation("p1", "c1", 2));
    expect(runtime.snapshot().descriptorCacheHits).toBe(cachedZoneCount);

    runtime.releaseConnection("c1", 1);
    await vi.advanceTimersByTimeAsync(101);
    await flushMicrotasks();
    backend.stateRevision = 1;
    const changed = await runtime.relocate(relocation("p1", "c1", 3));

    expect(runtime.snapshot().descriptorCacheInvalidations).toBeGreaterThan(0);
    expect(changed?.upserts.every((entity) => entity.stateRevision === 1)).toBe(
      true
    );
    await runtime.close();
  });

  it("bounds dormant descriptors by estimated bytes and TTL", async () => {
    vi.useFakeTimers();
    const byteBounded = new PopulationZonesV2Runtime(new FakeBackend(), {
      sleepGraceMs: 10,
      descriptorCacheMaxBytes: 1
    });
    await byteBounded.relocate(relocation("p1", "c1", 1));
    byteBounded.releaseConnection("c1", 1);
    await vi.advanceTimersByTimeAsync(11);
    await flushMicrotasks();
    expect(byteBounded.snapshot()).toMatchObject({
      descriptorCacheZones: 0,
      descriptorCacheEvictions: expect.any(Number)
    });
    expect(byteBounded.snapshot().descriptorCacheEvictions).toBeGreaterThan(0);
    await byteBounded.close();

    const ttlBounded = new PopulationZonesV2Runtime(new FakeBackend(), {
      sleepGraceMs: 10,
      descriptorCacheTtlMs: 100
    });
    await ttlBounded.relocate(relocation("p2", "c2", 1));
    ttlBounded.releaseConnection("c2", 1);
    await vi.advanceTimersByTimeAsync(11);
    await flushMicrotasks();
    expect(ttlBounded.snapshot().descriptorCacheZones).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(ttlBounded.snapshot()).toMatchObject({
      descriptorCacheZones: 0,
      descriptorCacheBytes: 0
    });
    expect(ttlBounded.snapshot().descriptorCacheEvictions).toBeGreaterThan(0);
    await ttlBounded.close();
  });

  it("evicts the least-recently slept dormant descriptor", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 10,
      descriptorCacheMaxZones: 2
    });
    const zoneA = populationZoneV2IdForPoint(CENTER_A);
    const zoneB = populationZoneV2IdForPoint(
      destinationPoint(CENTER_A, 3_000, 90)
    );
    const zoneC = populationZoneV2IdForPoint(
      destinationPoint(CENTER_A, 3_000, 180)
    );
    expect(new Set([zoneA, zoneB, zoneC]).size).toBe(3);
    const sleepZone = async (sourceId: string, zoneId: PopulationZoneV2Id) => {
      runtime.retainStreamingSource({
        sourceId,
        zoneIds: [zoneId],
        targetStage: "SIMULATION_READY"
      });
      await runtime.prepareZones({
        zoneIds: [zoneId],
        trigger: "flag-placement",
        priority: 1,
        targetStage: "SIMULATION_READY",
        activateRuntime: true
      });
      runtime.releaseStreamingSource(sourceId);
      await vi.advanceTimersByTimeAsync(11);
      await flushMicrotasks();
    };

    await sleepZone("source:a:first", zoneA);
    await sleepZone("source:b", zoneB);
    expect(runtime.snapshot().descriptorCacheZoneIds).toEqual(
      [zoneA, zoneB].sort()
    );
    await sleepZone("source:a:recent", zoneA);
    await sleepZone("source:c", zoneC);

    expect(runtime.snapshot()).toMatchObject({
      descriptorCacheZones: 2,
      descriptorCacheEvictions: 1
    });
    expect(runtime.snapshot().descriptorCacheZoneIds).toEqual(
      [zoneA, zoneC].sort()
    );
    await runtime.close();
  });

  it("sleeps actors while a durable-only descriptor reference remains", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 100
    });
    const zoneId = populationZoneV2IdForPoint(CENTER_A);
    runtime.retainStreamingSource({
      sourceId: "durable:1",
      zoneIds: [zoneId],
      targetStage: "DURABLE_READY"
    });
    runtime.retainStreamingSource({
      sourceId: "simulation:1",
      zoneIds: [zoneId],
      targetStage: "SIMULATION_READY"
    });
    await runtime.prepareZones({
      zoneIds: [zoneId],
      trigger: "flag-placement",
      priority: 1,
      targetStage: "SIMULATION_READY",
      activateRuntime: true
    });

    runtime.releaseStreamingSource("simulation:1");
    await vi.advanceTimersByTimeAsync(101);
    await flushMicrotasks();

    expect(backend.sleepCalls).toEqual([[zoneId]]);
    expect(runtime.snapshot()).toMatchObject({
      refCounts: { [zoneId]: 1 },
      simulationRefCounts: {},
      simulationResidentZones: 0,
      descriptorCacheZones: 1
    });
    runtime.releaseStreamingSource("durable:1");
    await runtime.close();
  });

  it("tracks independent per-stage references for overlapping sources", async () => {
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const zoneId = populationZoneV2IdForPoint(CENTER_A);

    runtime.retainStreamingSource({
      sourceId: "build:1",
      zoneIds: [zoneId],
      targetStage: "SIMULATION_READY"
    });
    runtime.retainStreamingSource({
      sourceId: "envelope:1",
      zoneIds: [zoneId],
      targetStage: "DURABLE_READY"
    });
    runtime.retainStreamingSource({
      sourceId: "plan:1",
      zoneIds: [zoneId],
      targetStage: "PLAN_READY"
    });

    expect(runtime.snapshot()).toMatchObject({
      streamingSourceLeases: 3,
      refCounts: { [zoneId]: 2 },
      stageRefCountsByZone: {
        [zoneId]: {
          PLAN_READY: 1,
          DURABLE_READY: 1,
          SIMULATION_READY: 1
        }
      }
    });
    expect(runtime.releaseStreamingSource("build:1")).toBe(true);
    expect(runtime.snapshot().refCounts[zoneId]).toBe(1);
    expect(runtime.releaseStreamingSource("missing")).toBe(false);
    expect(runtime.releaseStreamingSource("envelope:1")).toBe(true);
    expect(runtime.snapshot().refCounts[zoneId]).toBeUndefined();
    expect(runtime.releaseStreamingSource("plan:1")).toBe(true);
    expect(runtime.snapshot().stageRefCountsByZone[zoneId]).toBeUndefined();
    await runtime.close();
  });

  it("does not publish backend references for plan-only streaming sources", async () => {
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const zoneId = populationZoneV2IdForPoint(CENTER_A);

    runtime.retainStreamingSource({
      sourceId: "travel:1",
      zoneIds: [zoneId],
      targetStage: "PLAN_READY"
    });
    expect(backend.referenceUpdates).toEqual([]);

    runtime.retainStreamingSource({
      sourceId: "travel:1",
      zoneIds: [zoneId],
      targetStage: "DURABLE_READY"
    });
    expect(backend.latestReferenceCount(zoneId)).toBe(1);

    runtime.releaseStreamingSource("travel:1");
    expect(backend.latestReferenceCount(zoneId)).toBe(0);
    await runtime.close();
  });

  it("sleeps only after the final reference and grace period", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    const runtime = new PopulationZonesV2Runtime(backend, { sleepGraceMs: 100 });
    await Promise.all([
      runtime.relocate(relocation("p1", "c1", 1)),
      runtime.relocate(relocation("p2", "c2", 1))
    ]);
    runtime.releaseConnection("c1", 1);
    await vi.advanceTimersByTimeAsync(200);
    expect(backend.sleepCalls).toHaveLength(0);

    runtime.releaseConnection("c2", 1);
    await vi.advanceTimersByTimeAsync(99);
    expect(backend.sleepCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.sleepCalls).toHaveLength(1);
    expect(runtime.snapshot().descriptorCacheZones).toBeGreaterThan(0);
    await runtime.close();
  });

  it("serializes reacquisition behind an in-flight zone sleep", async () => {
    vi.useFakeTimers();
    const backend = new DeferredSleepBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 100
    });
    const initial = await runtime.relocate(relocation("p1", "c1", 1));
    const zoneId = initial!.activatedZoneIds[0]!;
    runtime.releaseConnection("c1", 1);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(backend.sleepCalls).toHaveLength(1);

    let reacquired = false;
    const reacquiring = runtime.relocate(relocation("p1", "c1", 2)).then(
      (delta) => {
        reacquired = true;
        return delta;
      }
    );
    await flushMicrotasks();
    expect(runtime.hasActiveReferences(zoneId)).toBe(true);
    expect(reacquired).toBe(false);
    expect(backend.activateCalls).toHaveLength(2);

    backend.resolveSleep(0);
    await expect(reacquiring).resolves.toMatchObject({ terminal: true });
    expect(backend.activateCalls).toHaveLength(3);
    const closing = runtime.close();
    await flushMicrotasks();
    backend.resolveSleep(1);
    await closing;
  });

  it("does not make foreground activation wait behind unrelated zone sleep", async () => {
    vi.useFakeTimers();
    const backend = new DeferredSleepBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 100
    });
    const first = await runtime.relocate({
      ...relocation("p1", "c1", 1),
      area: area(CENTER_A, 1, 2)
    });
    expect(first?.activatedZoneIds).toHaveLength(1);
    runtime.releaseConnection("c1", 1);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(backend.sleepCalls).toHaveLength(1);

    let reacquired = false;
    const reacquiring = runtime.relocate({
      ...relocation("p2", "c2", 1),
      area: area(CENTER_C, 1, 2)
    }).then((delta) => {
      reacquired = true;
      return delta;
    });
    await flushMicrotasks();

    expect(reacquired).toBe(true);
    await expect(reacquiring).resolves.toMatchObject({ terminal: true });
    expect(backend.sleepCalls).toHaveLength(1);

    backend.resolveSleep(0);
    await flushMicrotasks();
    const closing = runtime.close();
    await flushMicrotasks();
    backend.resolveSleep(1);
    await closing;
  });

  it("waits for an in-flight zone sleep before close returns", async () => {
    vi.useFakeTimers();
    const backend = new DeferredSleepBackend();
    const runtime = new PopulationZonesV2Runtime(backend, {
      sleepGraceMs: 100
    });
    await runtime.relocate(relocation("p1", "c1", 1));
    runtime.releaseConnection("c1", 1);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(backend.sleepCalls).toHaveLength(1);

    let closeResolved = false;
    const closing = runtime.close().then(() => {
      closeResolved = true;
    });
    await flushMicrotasks();
    expect(closeResolved).toBe(false);

    backend.resolveSleep(0);
    await flushMicrotasks();
    expect(backend.sleepCalls).toHaveLength(2);
    backend.resolveSleep(1);
    await closing;
    expect(closeResolved).toBe(true);
    expect(runtime.snapshot().warmZones).toBe(0);
  });

  it("drops a superseded relocation result without publishing stale entities", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const currentOwnershipToken = {};
    const published: Array<{
      relocationRevision: number;
      preparationResult: string;
      upsertCount: number;
    }> = [];
    runtime.onDelta((delta) => {
      published.push({
        relocationRevision: delta.relocationRevision,
        preparationResult: delta.preparationResult,
        upsertCount: delta.upserts.length
      });
    });

    const first = runtime.relocate(relocation("p1", "c1", 1));
    await flushMicrotasks();
    const second = runtime.relocate({
      ...relocation("p1", "c1", 2),
      area: area(CENTER_C, 1, 2),
      ownershipToken: currentOwnershipToken
    });
    await flushMicrotasks();
    backend.resolveCall(0);
    await flushMicrotasks();
    backend.resolveCall(1);
    await expect(second).resolves.toMatchObject({ relocationRevision: 2 });
    await expect(first).resolves.toBeNull();
    expect(published).toEqual([
      {
        relocationRevision: 1,
        preparationResult: "stale",
        upsertCount: 0
      },
      {
        relocationRevision: 2,
        preparationResult: "ready",
        upsertCount: 0
      }
    ]);
    runtime.releaseConnection("c1", 1, {
      relocationRevision: 1,
      resourceVisionRevision: 1,
      ownershipToken: currentOwnershipToken
    });
    expect(runtime.snapshot().connectionLeases).toBe(1);
    runtime.releaseConnection("c1", 1, {
      relocationRevision: 2,
      resourceVisionRevision: 1,
      ownershipToken: currentOwnershipToken
    });
    expect(runtime.snapshot().connectionLeases).toBe(1);
    runtime.releaseConnection("c1", 1, {
      relocationRevision: 2,
      resourceVisionRevision: 2,
      ownershipToken: currentOwnershipToken
    });
    expect(runtime.snapshot().connectionLeases).toBe(0);
    await runtime.close();
  });

  it("rejects resource-vision regression and releases only the owning relocation", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const firstOwnershipToken = {};
    const replacementOwnershipToken = {};
    const first = runtime.relocate({
      ...relocation("p1", "c1", 1),
      area: area(CENTER_A, 1, 2),
      ownershipToken: firstOwnershipToken
    });
    await flushMicrotasks();
    const replacement = runtime.relocate({
      ...relocation("p1", "c1", 1),
      area: area(CENTER_A, 1, 2),
      ownershipToken: replacementOwnershipToken
    });
    await flushMicrotasks();

    backend.resolveCall(0, "first");
    await flushMicrotasks();
    expect(backend.callCount()).toBe(2);
    backend.resolveCall(1, "replacement");
    await expect(replacement).resolves.toMatchObject({
      relocationRevision: 1,
      resourceVisionRevision: 1
    });
    await expect(first).resolves.toBeNull();

    runtime.releaseConnection("c1", 1, {
      relocationRevision: 1,
      resourceVisionRevision: 1,
      ownershipToken: firstOwnershipToken
    });
    expect(runtime.snapshot().connectionLeases).toBe(1);
    await expect(runtime.relocate({
      ...relocation("p1", "c1", 1),
      resourceVisionRevision: 0,
      ownershipToken: {}
    })).resolves.toBeNull();
    expect(runtime.snapshot().connectionLeases).toBe(1);

    runtime.releaseConnection("c1", 1, {
      relocationRevision: 1,
      resourceVisionRevision: 1,
      ownershipToken: replacementOwnershipToken
    });
    expect(runtime.snapshot().connectionLeases).toBe(0);
    await runtime.close();
  });

  it("publishes a current revision delta when a pending plan becomes ready", async () => {
    const backend = new FakeBackend({ pendingFirstActivation: true });
    const runtime = new PopulationZonesV2Runtime(backend);
    const published: Array<{ partial: boolean; upserts: number }> = [];
    runtime.onDelta((delta) => {
      published.push({
        partial: delta.partial,
        upserts: delta.upserts.length
      });
    });

    const initial = await runtime.relocate({
      ...relocation("p1", "c1", 1),
      area: area(CENTER_A, 1, 2)
    });
    expect(initial?.partial).toBe(true);
    const pendingZone = initial!.activatedZoneIds[0]!;
    backend.pendingFirstActivation = false;
    await runtime.notifyZoneReady(pendingZone);

    expect(published[0]).toMatchObject({ partial: true });
    expect(published.at(-1)).toMatchObject({ partial: false, upserts: 1 });
    await runtime.close();
  });

  it("publishes one delta when a warm zone gains a complete Resin Crawler group", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });
    const relocating = runtime.relocate({
      ...relocation("p1", "c1", 1),
      area: area(CENTER_A, 1, 2)
    });
    await flushMicrotasks();
    backend.resolveCall(0, "before-top-up");
    const initial = await relocating;
    const zoneId = initial!.upserts[0]!.zoneId;
    published.length = 0;

    const refreshing = runtime.notifyZoneReady(zoneId);
    await flushMicrotasks();
    const existing = readyActivation(zoneId, "before-top-up").entities[0]!;
    const sapGroup = Array.from({ length: 5 }, (_, packMemberIndex) => ({
      ...existing,
      entityId: `sap-${packMemberIndex}:${zoneId}`,
      kind: "sap_crawler" as const,
      archetype: "sap_crawler",
      encounterId: `sap-encounter:${zoneId}`,
      packId: `sap-pack:${zoneId}`,
      packMemberIndex
    }));
    backend.resolveCallWith(1, [{
      ...readyActivation(zoneId, "before-top-up"),
      entities: [existing, ...sapGroup],
      spawnedRuntimeActors: 5
    }]);
    await refreshing;

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      retainedZoneIds: [zoneId],
      activatedZoneIds: [],
      removedEntityIds: [],
      partial: false,
      terminal: true
    });
    expect(published[0]!.upserts.filter((entity) =>
      entity.kind === "sap_crawler"
    )).toHaveLength(5);
    await runtime.close();
  });

  it("publishes generation rollover removals and replacements to overlapping leases", async () => {
    let entityPrefix = "before-rollover";
    const backend: PopulationZonesV2RuntimeBackend = {
      async activateZones(input) {
        return input.zoneIds.map((zoneId) =>
          readyActivation(zoneId, entityPrefix)
        );
      },
      async sleepZones(input) {
        return {
          removedEntityIds: input.zoneIds.map((zoneId) =>
            `${entityPrefix}:${zoneId}`
          ),
          sleptRuntimeActors: input.zoneIds.length
        };
      }
    };
    const runtime = new PopulationZonesV2Runtime(backend);
    const published: PopulationZonesV2ActivationDelta[] = [];
    runtime.onDelta((delta) => {
      published.push(delta);
    });
    const relocationArea = area(CENTER_A, 1, 2);
    const first = await runtime.relocate({
      ...relocation("p1", "c1", 1),
      area: relocationArea
    });
    await runtime.relocate({
      ...relocation("p2", "c2", 1),
      area: relocationArea
    });
    const zoneId = first!.upserts[0]!.zoneId;
    const oldEntityId = `before-rollover:${zoneId}`;
    published.length = 0;

    entityPrefix = "after-rollover";
    await runtime.notifyZoneReady(zoneId);

    const rolloverDeltas = published.filter((delta) =>
      delta.retainedZoneIds.includes(zoneId)
    );
    expect(rolloverDeltas).toHaveLength(2);
    expect(new Set(rolloverDeltas.map((delta) => delta.connectionId)))
      .toEqual(new Set(["c1", "c2"]));
    for (const delta of rolloverDeltas) {
      expect(delta.removedEntityIds).toContain(oldEntityId);
      expect(delta.upserts).toEqual([
        expect.objectContaining({ entityId: `after-rollover:${zoneId}` })
      ]);
    }
    await runtime.close();
  });

  it("does not resurrect a deferred priority activation after final-reference sleep", async () => {
    vi.useFakeTimers();
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend, { sleepGraceMs: 10 });
    const publishedEntityIds: string[] = [];
    runtime.onDelta((delta) => {
      publishedEntityIds.push(...delta.upserts.map((entity) => entity.entityId));
    });
    const relocating = runtime.relocate({
      ...relocation("p1", "c1", 1),
      area: area(CENTER_A, 1, 2)
    });
    await flushMicrotasks();
    backend.resolveCallPending(0);
    const initial = await relocating;
    const zoneId = initial!.activatedZoneIds[0]!;
    publishedEntityIds.length = 0;

    const refreshing = runtime.notifyZoneReady(zoneId);
    await flushMicrotasks();
    expect(backend.callCount()).toBe(2);
    runtime.releaseConnection("c1", 1);
    await vi.advanceTimersByTimeAsync(11);
    await flushMicrotasks();
    expect(backend.sleepCalls).toHaveLength(1);

    backend.resolveCall(1, "late-priority");
    await refreshing;
    expect(backend.sleepCalls).toHaveLength(2);
    expect(publishedEntityIds).toEqual([]);
    expect(runtime.snapshot()).toMatchObject({
      connectionLeases: 0,
      referencedZones: 0,
      warmZones: 0
    });
    await runtime.close();
  });

  it("does not let an older same-zone activation overwrite a queued refresh", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const first = runtime.relocate(relocation("p1", "c1", 1));
    await flushMicrotasks();
    const zoneId = backend.zoneIdForCall(0);
    const refreshed = runtime.notifyZoneReady(zoneId);
    await flushMicrotasks();

    backend.resolveCall(0, "old");
    await flushMicrotasks();
    expect(backend.callCount()).toBe(2);
    backend.resolveCall(1, "new");

    await refreshed;
    await flushMicrotasks();
    expect(backend.callCount()).toBe(3);
    backend.resolveCall(2);
    const firstDelta = await first;
    expect(firstDelta?.upserts.some(
      (entity) => entity.entityId === `new:${zoneId}`
    )).toBe(true);
    const secondPlayer = await runtime.relocate(relocation("p2", "c2", 1));
    expect(secondPlayer?.upserts).toContainEqual(
      expect.objectContaining({ entityId: `new:${zoneId}` })
    );
    await runtime.close();
  });

  it("rejects in-flight activation and sleeps its actors before close returns", async () => {
    const backend = new DeferredBackend();
    const runtime = new PopulationZonesV2Runtime(backend);
    const relocating = runtime.relocate(relocation("p1", "c1", 1));
    await flushMicrotasks();
    expect(backend.callCount()).toBe(1);
    const activatedZoneIds = backend.zoneIdsForCall(0);
    const relocationRejection = expect(relocating).rejects.toThrow(
      "population v2 runtime is closed"
    );

    let closeResolved = false;
    const closing = runtime.close().then(() => {
      closeResolved = true;
    });
    await relocationRejection;
    await flushMicrotasks();
    expect(closeResolved).toBe(false);

    backend.resolveCall(0);
    await closing;
    expect(backend.sleepCalls).toHaveLength(1);
    expect(new Set(backend.sleepCalls[0])).toEqual(new Set(activatedZoneIds));
    expect(runtime.snapshot()).toMatchObject({
      connectionLeases: 0,
      referencedZones: 0,
      warmZones: 0
    });
  });
});

class FakeBackend implements PopulationZonesV2RuntimeBackend {
  readonly activateCalls: PopulationZoneV2Id[][] = [];
  readonly sleepCalls: PopulationZoneV2Id[][] = [];
  readonly referenceUpdates: Array<Readonly<{
    currentReferencesByZone: Readonly<Record<string, number>>;
    unreferencedAtByZone: Readonly<Record<string, number>>;
  }>> = [];
  readonly activatedZoneIds = new Set<PopulationZoneV2Id>();
  readonly generatedZoneIds = new Set<PopulationZoneV2Id>();
  duplicateZoneActivations = 0;
  pendingFirstActivation: boolean;
  stateRevision = 0;

  constructor(options: { pendingFirstActivation?: boolean } = {}) {
    this.pendingFirstActivation = options.pendingFirstActivation === true;
  }

  updateZoneReferences(input: Readonly<{
    currentReferencesByZone: Readonly<Record<string, number>>;
    unreferencedAtByZone?: Readonly<Record<string, number>>;
  }>): void {
    this.referenceUpdates.push({
      currentReferencesByZone: { ...input.currentReferencesByZone },
      unreferencedAtByZone: { ...input.unreferencedAtByZone }
    });
  }

  latestReferenceCount(zoneId: PopulationZoneV2Id): number | undefined {
    for (let index = this.referenceUpdates.length - 1; index >= 0; index -= 1) {
      const count = this.referenceUpdates[index]!
        .currentReferencesByZone[zoneId];
      if (count !== undefined) return count;
    }
    return undefined;
  }

  latestUnreferencedAt(zoneId: PopulationZoneV2Id): number | undefined {
    for (let index = this.referenceUpdates.length - 1; index >= 0; index -= 1) {
      const unreferencedAt = this.referenceUpdates[index]!
        .unreferencedAtByZone[zoneId];
      if (unreferencedAt !== undefined) return unreferencedAt;
    }
    return undefined;
  }

  generationCreationCount(zoneId: PopulationZoneV2Id): number {
    return this.generatedZoneIds.has(zoneId) ? 1 : 0;
  }

  async activateZones(input: {
    zoneIds: readonly PopulationZoneV2Id[];
  }): Promise<readonly PopulationZoneV2BackendZoneActivation[]> {
    this.activateCalls.push([...input.zoneIds]);
    return input.zoneIds.map((zoneId) => {
      this.generatedZoneIds.add(zoneId);
      if (this.pendingFirstActivation && !this.activatedZoneIds.has(zoneId)) {
        this.activatedZoneIds.add(zoneId);
        return {
          zoneId,
          generationId: generationIdForZone(zoneId),
          materializationStatus: "generation-invalid-or-unservable" as const,
          status: "pending" as const,
          entities: [],
          spawnedRuntimeActors: 0
        };
      }
      if (this.activatedZoneIds.has(zoneId)) this.duplicateZoneActivations += 1;
      this.activatedZoneIds.add(zoneId);
      return readyActivation(zoneId, "entity", this.stateRevision);
    });
  }

  async sleepZones(input: { zoneIds: readonly PopulationZoneV2Id[] }) {
    this.sleepCalls.push([...input.zoneIds]);
    for (const zoneId of input.zoneIds) this.activatedZoneIds.delete(zoneId);
    return {
      removedEntityIds: input.zoneIds.map(entityIdForZone),
      sleptRuntimeActors: input.zoneIds.length
    };
  }
}

class DeferredBackend implements PopulationZonesV2RuntimeBackend {
  readonly sleepCalls: PopulationZoneV2Id[][] = [];
  private readonly calls: Array<{
    zoneIds: readonly PopulationZoneV2Id[];
    priorityByZone: Readonly<Record<string, number>>;
    resolve: (value: readonly PopulationZoneV2BackendZoneActivation[]) => void;
  }> = [];

  activateZones(input: {
    zoneIds: readonly PopulationZoneV2Id[];
    priorityByZone?: Readonly<Record<string, number>>;
  }) {
    return new Promise<readonly PopulationZoneV2BackendZoneActivation[]>((resolve) => {
      this.calls.push({
        zoneIds: input.zoneIds,
        priorityByZone: input.priorityByZone ?? {},
        resolve
      });
    });
  }

  callCount(): number {
    return this.calls.length;
  }

  zoneIdForCall(index: number): PopulationZoneV2Id {
    const call = this.calls[index];
    if (!call) throw new Error(`missing deferred activation ${index}`);
    const zoneId = call.zoneIds[0];
    if (!zoneId) throw new Error(`deferred activation ${index} has no zones`);
    return zoneId;
  }

  zoneIdsForCall(index: number): PopulationZoneV2Id[] {
    const call = this.calls[index];
    if (!call) throw new Error(`missing deferred activation ${index}`);
    return [...call.zoneIds];
  }

  prioritiesForCall(index: number): Readonly<Record<string, number>> {
    const call = this.calls[index];
    if (!call) throw new Error(`missing deferred activation ${index}`);
    return call.priorityByZone;
  }

  resolveCall(index: number, entityPrefix = "entity"): void {
    const call = this.calls[index];
    if (!call) throw new Error(`missing deferred activation ${index}`);
    call.resolve(call.zoneIds.map((zoneId) => readyActivation(zoneId, entityPrefix)));
  }

  resolveCallPending(index: number): void {
    const call = this.calls[index];
    if (!call) throw new Error(`missing deferred activation ${index}`);
    call.resolve(call.zoneIds.map((zoneId) => ({
      zoneId,
      generationId: generationIdForZone(zoneId),
      materializationStatus: "generation-invalid-or-unservable" as const,
      status: "pending" as const,
      entities: [],
      spawnedRuntimeActors: 0
    })));
  }

  resolveCallWith(
    index: number,
    activations: readonly PopulationZoneV2BackendZoneActivation[]
  ): void {
    const call = this.calls[index];
    if (!call) throw new Error(`missing deferred activation ${index}`);
    call.resolve(activations);
  }

  async sleepZones(input: { zoneIds: readonly PopulationZoneV2Id[] }) {
    this.sleepCalls.push([...input.zoneIds]);
    return {
      removedEntityIds: input.zoneIds.map(entityIdForZone),
      sleptRuntimeActors: input.zoneIds.length
    };
  }
}

class DeferredSleepBackend extends FakeBackend {
  private readonly sleepResolvers: Array<() => void> = [];

  override sleepZones(input: { zoneIds: readonly PopulationZoneV2Id[] }) {
    this.sleepCalls.push([...input.zoneIds]);
    return new Promise<{
      removedEntityIds: string[];
      sleptRuntimeActors: number;
    }>((resolve) => {
      this.sleepResolvers.push(() => {
        for (const zoneId of input.zoneIds) this.activatedZoneIds.delete(zoneId);
        resolve({
          removedEntityIds: input.zoneIds.map(entityIdForZone),
          sleptRuntimeActors: input.zoneIds.length
        });
      });
    });
  }

  resolveSleep(index: number): void {
    const resolve = this.sleepResolvers[index];
    if (!resolve) throw new Error(`missing deferred sleep ${index}`);
    resolve();
  }
}

function relocation(playerId: string, connectionId: string, revision: number) {
  return {
    playerId,
    connectionId,
    connectionGeneration: 1,
    area: area(CENTER_A),
    relocationRevision: revision,
    resourceVisionRevision: revision,
    challengeProfile: ZERO_CHALLENGE_PROFILE,
    trigger: "flag-travel" as const
  };
}

function coldDestinationZoneIds(): PopulationZoneV2Id[] {
  return [
    "ppz2-eag1/b4l/4y6",
    "ppz2-eag1/b4l/4y7",
    "ppz2-eag1/b4l/4y8",
    "ppz2-eag1/b4m/4y5",
    "ppz2-eag1/b4m/4y6",
    "ppz2-eag1/b4m/4y7"
  ];
}

function area(
  center = CENTER_A,
  certifiedVisibleRadiusM = DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  preparedRadiusM = DEFAULT_FLAG_PREPARE_RADIUS_M
) {
  return {
    center,
    certifiedVisibleRadiusM,
    preparedRadiusM,
    sourceType: "flag" as const,
    sourceId: "flag-1",
    generation: 1
  };
}

function readyActivation(
  zoneId: PopulationZoneV2Id,
  entityPrefix = "entity",
  stateRevision = 0
): PopulationZoneV2BackendZoneActivation {
  return {
    zoneId,
    generationId: generationIdForZone(zoneId),
    materializationStatus: "materialization-current",
    status: "ready",
    entities: [{
      entityId: `${entityPrefix}:${zoneId}`,
      zoneId,
      generationId: generationIdForZone(zoneId),
      kind: "deer",
      archetype: "deer",
      position: CENTER_A,
      homePosition: CENTER_A,
      stateRevision
    }],
    spawnedRuntimeActors: 1,
    reason: "ready",
    authority: {
      zoneId,
      selectedPlanId: `plan:${zoneId}`,
      generationId: generationIdForZone(zoneId),
      cutoverRevision: 1,
      commonSchemaRevision: "test-schema-v1",
      registryRevision: "test-registry-v1",
      stateRevisionFingerprint: `state:${stateRevision}`,
      ownershipToken: `owner:${generationIdForZone(zoneId)}`
    }
  };
}

function runtimeEntity(
  entityId: string,
  kind: "tree" | "deer" | "stone",
  zoneId: PopulationZoneV2Id,
  position: { lat: number; lon: number }
) {
  return {
    entityId,
    zoneId,
    generationId: kind === "stone" ? null : generationIdForZone(zoneId),
    kind,
    archetype: kind,
    position,
    homePosition: position,
    stateRevision: 0
  };
}

function entityIdForZone(zoneId: PopulationZoneV2Id): string {
  return `entity:${zoneId}`;
}

function generationIdForZone(zoneId: PopulationZoneV2Id): string {
  return `generation:${zoneId}`;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
