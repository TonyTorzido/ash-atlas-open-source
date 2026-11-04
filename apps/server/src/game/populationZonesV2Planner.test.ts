import { describe, expect, it, vi } from "vitest";

import {
  populationZoneV2Geometry,
  populationZoneV2IdForPoint,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import {
  generatePopulationZonesV2Plans,
  type GeneratedPopulationZoneV2Plan,
  type PopulationZoneV2Habitat,
  populationZoneV2PlanningHabitatZoneIds
} from "./populationZonesV2Plan.js";
import { populationZoneV2PlanId } from "./populationZonesV2Identity.js";
import { PopulationZonesV2Planner } from "./populationZonesV2Planner.js";
import {
  type ClaimedPopulationZoneV2Plan,
  PopulationPlanCompletionError,
  type PopulationPlanFailureCode,
  type PopulationZoneV2PlanRecord,
  populationZoneV2PlanRequest
} from "./populationZonesV2Store.js";
import { packageIdForPosition } from "./spatialZones.js";

const WORLD_IDENTITY = "a".repeat(64);
const WORLD_SHA = "b".repeat(40);
const ZONE_ID = populationZoneV2IdForPoint({ lat: 39.7392, lon: -104.9903 });

describe("PopulationZonesV2Planner", () => {
  it("shares concurrent preparation and completes one deterministic plan", async () => {
    const harness = createHarness();
    const first = harness.planner.ensureZones({
      zoneIds: [ZONE_ID], regionCode: "test", reason: "flag-travel"
    });
    const second = harness.planner.ensureZones({
      zoneIds: [ZONE_ID], regionCode: "test", reason: "flag-travel"
    });
    const [left, right] = await Promise.all([first, second]);

    expect(left.pendingZoneIds).toEqual([]);
    expect(right.pendingZoneIds).toEqual([]);
    expect(harness.store.claimPlan).toHaveBeenCalledTimes(1);
    expect(harness.store.completePlan).toHaveBeenCalledTimes(1);
    expect(harness.compiler.compileZone).toHaveBeenCalledTimes(1);
    await harness.planner.close();
  });

  it("returns pending immediately and coalesces duplicate background work", async () => {
    const harness = createHarness();
    let releaseCompile!: () => void;
    harness.compiler.compileZone.mockImplementation(async ({ zoneId }) => {
      await new Promise<void>((resolve) => {
        releaseCompile = resolve;
      });
      return fullLandHabitat(zoneId);
    });

    const first = await harness.planner.scheduleZones({
      zoneIds: [ZONE_ID], regionCode: "test", reason: "population-v2:world-entry"
    });
    const second = await harness.planner.scheduleZones({
      zoneIds: [ZONE_ID], regionCode: "test", reason: "population-v2:world-entry"
    });

    expect(first.pendingZoneIds).toEqual([ZONE_ID]);
    expect(second.pendingZoneIds).toEqual([ZONE_ID]);
    expect(harness.planner.snapshot()).toMatchObject({
      activeZonePreparations: 1,
      queuedZones: 0,
      zonePreparationConcurrency: 4
    });
    expect(harness.compiler.compileZone).toHaveBeenCalledTimes(1);

    releaseCompile();
    await waitForCondition(() => harness.store.completePlan.mock.calls.length === 1);
    await harness.planner.close();
  });

  it("does not re-emit plan-ready when activating an already-ready plan", async () => {
    const harness = createHarness();
    const readyNotifications: string[] = [];
    harness.planner.onPlanReady((zoneId) => {
      readyNotifications.push(zoneId);
    });

    await harness.planner.scheduleZones({
      zoneIds: [ZONE_ID], regionCode: "test", reason: "population-v2:world-entry"
    });
    await waitForCondition(() => readyNotifications.length === 1);
    harness.store.ensurePlansForZones.mockImplementation(async (requests) =>
      requests.map((entry) => ({
        ...entry,
        status: "ready" as const,
        claimGeneration: 1,
        attemptCount: 1,
        contentHash: "c".repeat(64)
      }))
    );

    const ready = await harness.planner.scheduleZones({
      zoneIds: [ZONE_ID], regionCode: "test", reason: "population-v2:plan-ready"
    });

    expect(ready.readyZoneIds).toEqual([ZONE_ID]);
    expect(readyNotifications).toEqual([ZONE_ID]);
    await harness.planner.close();
  });

  it("notifies dependents when an existing plan is terminally failed", async () => {
    const harness = createHarness();
    const failures: Array<{
      zoneId: PopulationZoneV2Id;
      outcome: "terminal-failure" | "cancelled";
    }> = [];
    harness.planner.onPlanFailed((zoneId, outcome) => {
      failures.push({ zoneId, outcome });
    });
    harness.store.ensurePlansForZones.mockImplementation(async (requests) =>
      requests.map((entry) => ({
        ...entry,
        status: "terminal-failure" as const,
        claimGeneration: 2,
        attemptCount: 3,
        contentHash: null
      }))
    );

    const result = await harness.planner.scheduleZones({
      zoneIds: [ZONE_ID],
      regionCode: "test",
      reason: "population-v2:world-entry"
    });

    expect(result.pendingZoneIds).toEqual([]);
    expect(result.readyZoneIds).toEqual([]);
    expect(result.terminalFailureZoneIds).toEqual([ZONE_ID]);
    expect(failures).toEqual([{
      zoneId: ZONE_ID,
      outcome: "terminal-failure"
    }]);
    await harness.planner.close();
  });

  it("renews the exact fenced claim and stops after completion", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ planLeaseMs: 300 });
    let finishCompletion!: (completed: boolean) => void;
    harness.store.completePlan.mockImplementation(async () =>
      new Promise<boolean>((resolve) => {
        finishCompletion = resolve;
      })
    );
    try {
      const preparing = harness.planner.ensureZones({
        zoneIds: [ZONE_ID], regionCode: "test", reason: "flag-travel"
      });
      await waitForCondition(() => harness.store.completePlan.mock.calls.length === 1);
      const claim = harness.store.completePlan.mock.calls[0]?.[0];
      if (!claim) throw new Error("expected a claimed plan");

      await vi.advanceTimersByTimeAsync(100);
      expect(harness.store.heartbeatPlan).toHaveBeenCalledWith(claim, 300);

      finishCompletion(true);
      await preparing;
      const heartbeatCount = harness.store.heartbeatPlan.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.store.heartbeatPlan).toHaveBeenCalledTimes(heartbeatCount);
    } finally {
      await harness.planner.close();
      vi.useRealTimers();
    }
  });

  it("does not let one failed zone block the next queued zone", async () => {
    const failedZone = populationZoneV2IdForPoint({ lat: 39.75, lon: -104.99 });
    const harness = createHarness({ activePreparationConcurrency: 1 });
    harness.compiler.compileZone.mockImplementation(async ({ zoneId }) => {
      if (zoneId === failedZone) throw new Error("World unavailable");
      return fullLandHabitat(zoneId);
    });

    await harness.planner.scheduleZones({
      zoneIds: [failedZone, ZONE_ID],
      regionCode: "test",
      reason: "world-entry",
      priority: 0
    });
    await waitForCondition(() =>
      harness.store.completePlan.mock.calls.length === 1
      && harness.store.failPlan.mock.calls.length === 1
    );

    expect(harness.store.failPlan).toHaveBeenCalledTimes(1);
    expect(harness.store.completePlan.mock.calls[0]?.[0].identity.zoneId).toBe(ZONE_ID);
    await harness.planner.close();
  });

  it("terminates deterministic completion conflicts once with safe diagnostics", async () => {
    const harness = createHarness();
    const failures: string[] = [];
    harness.planner.onPlanFailed((zoneId) => {
      failures.push(zoneId);
    });
    harness.store.completePlan.mockImplementation(async (claim) => {
      throw new PopulationPlanCompletionError(
        "immutable permanent stone authority mismatch",
        {
          code: "population-plan-immutable-stone-mismatch",
          retryable: false,
          postgresCode: "23505",
          constraint: "population_spawn_slots_v2_entity_id_key",
          table: "population_spawn_slots_v2",
          zoneId: claim.identity.zoneId,
          planId: claim.planId,
          spawnRulesVersion: claim.identity.spawnRulesVersion,
          slotId: "a300cd8c-ca05-8e89-a210-8600a59fbe09",
          entityId: "8f9a5511-53fb-8af5-9227-6d7d84b7d97b",
          entityKind: "stone",
          generationId: null,
          claimGeneration: claim.claimGeneration,
          attemptCount: claim.attemptCount
        }
      );
    });
    harness.store.failPlan.mockResolvedValue({
      accepted: true,
      status: "terminal-failure",
      errorCode: "population-plan-immutable-stone-mismatch"
    });

    await harness.planner.scheduleZones({
      zoneIds: [ZONE_ID],
      regionCode: "test",
      reason: "world-entry"
    });
    await waitForCondition(() => failures.length === 1);

    expect(harness.store.completePlan).toHaveBeenCalledTimes(1);
    expect(harness.store.failPlan).toHaveBeenCalledTimes(1);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        postgresCode: "23505",
        constraint: "population_spawn_slots_v2_entity_id_key",
        table: "population_spawn_slots_v2",
        zoneId: ZONE_ID,
        planId: expect.any(String),
        spawnRulesVersion: "population-spawn-rules-v4-uniform-tree-varieties",
        slotId: "a300cd8c-ca05-8e89-a210-8600a59fbe09",
        entityId: "8f9a5511-53fb-8af5-9227-6d7d84b7d97b",
        entityKind: "stone",
        generationId: null,
        claimGeneration: 1,
        attemptCount: 1,
        errorCode: "population-plan-immutable-stone-mismatch"
      }),
      "population v3 bounded plan compilation failed"
    );
    await harness.planner.close();
  });

  it("orders queued zones by player priority without increasing concurrency", async () => {
    const blocker = populationZoneV2IdForPoint({ lat: 40, lon: -105 });
    const fringe = populationZoneV2IdForPoint({ lat: 41, lon: -105 });
    const future = populationZoneV2IdForPoint({ lat: 41.5, lon: -105 });
    const center = populationZoneV2IdForPoint({ lat: 42, lon: -105 });
    const harness = createHarness({ activePreparationConcurrency: 1 });
    let releaseBlocker!: () => void;
    harness.compiler.compileZone.mockImplementation(async ({ zoneId }) => {
      if (zoneId === blocker) {
        await new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        });
      }
      return fullLandHabitat(zoneId);
    });

    await harness.planner.scheduleZones({
      zoneIds: [blocker], regionCode: "test", reason: "world-entry", priority: 1
    });
    await harness.planner.scheduleZones({
      zoneIds: [fringe], regionCode: "test", reason: "world-entry", priority: 2
    });
    await harness.planner.scheduleZones({
      zoneIds: [future], regionCode: "test", reason: "flag-construction", priority: 1
    });
    await harness.planner.scheduleZones({
      zoneIds: [center], regionCode: "test", reason: "world-entry", priority: 0
    });
    expect(harness.planner.snapshot().activeZonePreparations).toBe(1);

    releaseBlocker();
    await waitForCondition(() => harness.compiler.compileZone.mock.calls.length === 4);
    expect(harness.compiler.compileZone.mock.calls.map(([input]) => ({
      zoneId: input.zoneId,
      priority: input.priority
    }))).toEqual([
      { zoneId: blocker, priority: 2 },
      { zoneId: center, priority: 0 },
      { zoneId: future, priority: 2 },
      { zoneId: fringe, priority: 3 }
    ]);
    await harness.planner.close();
  });

  it("uses four foreground slots while all background work shares one slot", async () => {
    const zones = Array.from({ length: 7 }, (_, index) =>
      populationZoneV2IdForPoint({ lat: 10 + index, lon: -105 }));
    const harness = createHarness({ activePreparationConcurrency: 4 });
    const releases = new Map<PopulationZoneV2Id, () => void>();
    harness.compiler.compileZone.mockImplementation(async ({ zoneId }) => {
      await new Promise<void>((resolve) => releases.set(zoneId, resolve));
      return fullLandHabitat(zoneId);
    });

    await harness.planner.scheduleZones({
      zoneIds: zones.slice(0, 3),
      regionCode: "test",
      reason: "backfill",
      priority: 3
    });
    await waitForCondition(() =>
      harness.planner.snapshot().activeBackgroundPreparations === 1);
    await harness.planner.scheduleZones({
      zoneIds: zones.slice(3),
      regionCode: "test",
      reason: "flag-travel",
      priority: 0
    });
    await waitForCondition(() =>
      harness.planner.snapshot().activeZonePreparations === 4);
    await waitForCondition(() =>
      harness.compiler.compileZone.mock.calls.length === 4);

    expect(harness.planner.snapshot()).toMatchObject({
      activeZonePreparations: 4,
      activeBackgroundPreparations: 1,
      zonePreparationConcurrency: 4,
      backgroundPreparationConcurrency: 1
    });
    expect(harness.compiler.compileZone.mock.calls.map(([input]) => input.zoneId))
      .toEqual([zones[0], ...zones.slice(3, 6)]);
    for (const release of releases.values()) release();
    releases.clear();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (harness.compiler.compileZone.mock.calls.length === zones.length) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const release of releases.values()) release();
      releases.clear();
    }
    expect(harness.compiler.compileZone).toHaveBeenCalledTimes(zones.length);
    for (const release of releases.values()) release();
    await waitForCondition(() =>
      harness.planner.snapshot().activeZonePreparations === 0);
    await harness.planner.close();
  });

  it("always admits queued foreground before global background work", async () => {
    const zones = Array.from({ length: 3 }, (_, index) =>
      populationZoneV2IdForPoint({ lat: 20 + index, lon: -105 }));
    const harness = createHarness({
      activePreparationConcurrency: 1,
      backgroundStarvationMs: 0,
      backgroundFairnessIntervalMs: 0
    });
    let releaseBlocker!: () => void;
    harness.compiler.compileZone.mockImplementationOnce(async ({ zoneId }) => {
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      return fullLandHabitat(zoneId);
    });

    await harness.planner.scheduleZones({
      zoneIds: [zones[0]!], regionCode: "test", reason: "travel", priority: 0
    });
    await harness.planner.scheduleZones({
      zoneIds: [zones[1]!], regionCode: "background", reason: "backfill", priority: 3
    });
    await harness.planner.scheduleZones({
      zoneIds: [zones[2]!], regionCode: "test", reason: "travel", priority: 0
    });
    releaseBlocker();

    await waitForCondition(() => harness.compiler.compileZone.mock.calls.length === 3);
    expect(harness.compiler.compileZone.mock.calls.map(([input]) => input.zoneId))
      .toEqual([zones[0], zones[2], zones[1]]);
    await harness.planner.close();
  });

  it("gives global recovery one background admission after three locality jobs", async () => {
    const zones = Array.from({ length: 6 }, (_, index) =>
      populationZoneV2IdForPoint({ lat: 10 + index, lon: -105 }));
    const harness = createHarness({
      activePreparationConcurrency: 1,
      backgroundStarvationMs: 60_000
    });
    const releases: Array<() => void> = [];
    harness.compiler.compileZone.mockImplementation(async ({ zoneId }) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return fullLandHabitat(zoneId);
    });

    await harness.planner.scheduleZones({
      zoneIds: [zones[0]!],
      regionCode: "test",
      reason: "travel",
      priority: 0,
      workClass: "foreground"
    });
    await waitForCondition(() => releases.length === 1);
    await harness.planner.scheduleZones({
      zoneIds: zones.slice(1, 5),
      regionCode: "locality",
      reason: "flag-locality-warming",
      priority: 2,
      workClass: "locality"
    });
    await harness.planner.scheduleZones({
      zoneIds: [zones[5]!],
      regionCode: "background",
      reason: "flag-plan-backfill",
      priority: 3,
      workClass: "global"
    });

    for (let expectedCalls = 2; expectedCalls <= 6; expectedCalls += 1) {
      releases.shift()?.();
      await waitForCondition(() =>
        harness.compiler.compileZone.mock.calls.length === expectedCalls);
    }
    expect(harness.compiler.compileZone.mock.calls.map(([input]) =>
      input.cacheClass)).toEqual([
        "protected",
        "protected",
        "protected",
        "protected",
        "probationary",
        "protected"
      ]);
    releases.shift()?.();
    await harness.planner.close();
  });

  it("waits for urgent travel work without bypassing the bounded queue", async () => {
    const blocker = populationZoneV2IdForPoint({ lat: 39.8, lon: -105 });
    const urgent = populationZoneV2IdForPoint({ lat: 40.1, lon: -105 });
    const harness = createHarness({
      activePreparationConcurrency: 1,
      zoneQueueMax: 2
    });
    let releaseBlocker!: () => void;
    let activeCompiles = 0;
    let peakCompiles = 0;
    harness.compiler.compileZone.mockImplementation(async ({ zoneId }) => {
      activeCompiles += 1;
      peakCompiles = Math.max(peakCompiles, activeCompiles);
      try {
        if (zoneId === blocker) {
          await new Promise<void>((resolve) => {
            releaseBlocker = resolve;
          });
        }
        return fullLandHabitat(zoneId);
      } finally {
        activeCompiles -= 1;
      }
    });

    await harness.planner.scheduleZones({
      zoneIds: [blocker], regionCode: "test", reason: "outer", priority: 2
    });
    const waiting = harness.planner.scheduleZonesAndWait({
      zoneIds: [urgent], regionCode: "test", reason: "flag-travel", priority: 0
    });
    await waitForCondition(() => harness.planner.snapshot().queuedZones === 1);
    expect(harness.planner.snapshot()).toMatchObject({
      activeZonePreparations: 1,
      queuedZones: 1,
      zonePreparationConcurrency: 1
    });

    releaseBlocker();
    await expect(waiting).resolves.toMatchObject({
      pendingZoneIds: [],
      readyZoneIds: [urgent]
    });
    expect(peakCompiles).toBe(1);
    expect(harness.compiler.compileZone.mock.calls.map(([input]) => input.zoneId))
      .toEqual([blocker, urgent]);
    await harness.planner.close();
  });

  it("does not enqueue work when cancellation wins during store admission", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    let releaseAdmission!: () => void;
    const ensurePlans = harness.store.ensurePlansForZones.getMockImplementation();
    if (!ensurePlans) throw new Error("expected ensure-plans implementation");
    harness.store.ensurePlansForZones.mockImplementation(async (requests) => {
      await new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      return ensurePlans(requests);
    });

    const scheduling = harness.planner.scheduleZones({
      zoneIds: [ZONE_ID],
      regionCode: "test",
      reason: "active-relocation",
      priority: 0,
      signal: controller.signal
    });
    await waitForCondition(() =>
      harness.store.ensurePlansForZones.mock.calls.length === 1
    );
    controller.abort();
    releaseAdmission();

    await expect(scheduling).resolves.toEqual({
      disabled: false,
      readyZoneIds: [],
      pendingZoneIds: []
    });
    expect(harness.planner.snapshot()).toMatchObject({
      pendingZones: 0,
      queuedZones: 0,
      activeZonePreparations: 0
    });
    expect(harness.compiler.compileZone).not.toHaveBeenCalled();
    await harness.planner.close();
  });

  it("promotes a deduplicated queued zone when it becomes actively required", async () => {
    const blocker = populationZoneV2IdForPoint({ lat: 43, lon: -105 });
    const shared = populationZoneV2IdForPoint({ lat: 44, lon: -105 });
    const other = populationZoneV2IdForPoint({ lat: 45, lon: -105 });
    const harness = createHarness({ activePreparationConcurrency: 1 });
    let releaseBlocker!: () => void;
    harness.compiler.compileZone.mockImplementation(async ({ zoneId }) => {
      if (zoneId === blocker) {
        await new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        });
      }
      return fullLandHabitat(zoneId);
    });

    await harness.planner.scheduleZones({
      zoneIds: [blocker], regionCode: "test", reason: "outer", priority: 2
    });
    await harness.planner.scheduleZones({
      zoneIds: [shared],
      regionCode: "locality",
      reason: "flag-locality-warming",
      priority: 2,
      workClass: "locality"
    });
    await harness.planner.scheduleZones({
      zoneIds: [other], regionCode: "test", reason: "flag-construction", priority: 1
    });
    await harness.planner.scheduleZones({
      zoneIds: [shared], regionCode: "test", reason: "active-relocation", priority: 0
    });

    expect(harness.planner.snapshot().zones.find((entry) => entry.zoneId === shared))
      .toMatchObject({ state: "queued", priority: 0 });
    expect(harness.planner.snapshot().workClasses.foreground.promotions).toBe(1);
    releaseBlocker();
    await waitForCondition(() => harness.compiler.compileZone.mock.calls.length === 3);
    expect(harness.compiler.compileZone.mock.calls.map(([input]) => input.zoneId))
      .toEqual([blocker, shared, other]);
    expect(harness.compiler.compileZone.mock.calls.filter(([input]) => input.zoneId === shared))
      .toHaveLength(1);
    await harness.planner.close();
  });

  it("admits priority zero work without exceeding a full bounded queue", async () => {
    const blocker = populationZoneV2IdForPoint({ lat: 46, lon: -105 });
    const queuedA = populationZoneV2IdForPoint({ lat: 47, lon: -105 });
    const queuedB = populationZoneV2IdForPoint({ lat: 48, lon: -105 });
    const urgent = populationZoneV2IdForPoint({ lat: 49, lon: -105 });
    const harness = createHarness({ activePreparationConcurrency: 1, zoneQueueMax: 2 });
    let releaseBlocker!: () => void;
    harness.compiler.compileZone.mockImplementation(async ({ zoneId }) => {
      if (zoneId === blocker) {
        await new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        });
      }
      return fullLandHabitat(zoneId);
    });

    await harness.planner.scheduleZones({
      zoneIds: [blocker], regionCode: "test", reason: "outer", priority: 2
    });
    await harness.planner.scheduleZones({
      zoneIds: [queuedA, queuedB], regionCode: "test", reason: "outer", priority: 2
    });
    expect(harness.planner.snapshot().queuedZones).toBe(2);
    await harness.planner.scheduleZones({
      zoneIds: [urgent], regionCode: "test", reason: "active-relocation", priority: 0
    });
    expect(harness.planner.snapshot()).toMatchObject({
      activeZonePreparations: 1,
      queuedZones: 2,
      zoneQueueLimit: 2,
      zonePreparationConcurrency: 1
    });

    releaseBlocker();
    await waitForCondition(() => harness.compiler.compileZone.mock.calls.length >= 2);
    expect(harness.compiler.compileZone.mock.calls[1]?.[0].zoneId).toBe(urgent);
    await harness.planner.close();
  });

  it("uses the owner-zone package and the immutable compact environment contract", async () => {
    const harness = createHarness();
    const expectedRegionCode = packageIdForPosition(
      populationZoneV2Geometry(ZONE_ID).center
    );
    await harness.planner.ensureZones({
      zoneIds: [ZONE_ID],
      regionCode: "caller-package",
      reason: "flag-travel"
    });

    expect(harness.compiler.compileZone).toHaveBeenCalledWith({
      zoneId: ZONE_ID,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      regionCode: expectedRegionCode,
      priority: 3,
      cacheClass: "protected"
    });
    const request = harness.store.ensurePlansForZones.mock.calls[0]?.[0][0];
    expect(request?.identity.environmentProfileVersion)
      .toBe("population-compact-gameplay-environment-v3-riverbank-lakeshore");
    await harness.planner.close();
  });

  it("keeps six destination plans independent when the final zone fails", async () => {
    const zones = sixZoneIds();
    const finalZone = zones.at(-1)!;
    const harness = createHarness({ activePreparationConcurrency: 1 });
    harness.compiler.compileZone.mockImplementation(async ({ zoneId }) => {
      if (zoneId === finalZone) throw new Error("final zone World failure");
      return fullLandHabitat(zoneId);
    });

    await harness.planner.scheduleZones({
      zoneIds: zones,
      regionCode: "test",
      reason: "flag-travel",
      priority: 0
    });
    await waitForCondition(() =>
      harness.store.completePlan.mock.calls.length === zones.length - 1
      && harness.store.failPlan.mock.calls.length === 1
    );

    expect(harness.compiler.compileZone).toHaveBeenCalledTimes(zones.length);
    expect(harness.generatePlans).toHaveBeenCalledTimes(zones.length - 1);
    expect(harness.generatePlans.mock.calls.every(
      ([input]) => input.outputZoneIds.length === 1
    )).toBe(true);
    expect(harness.store.completePlan.mock.calls.map(
      ([claim]) => claim.identity.zoneId
    )).toEqual(zones.slice(0, -1));
    expect(harness.store.failPlan.mock.calls[0]?.[0].identity.zoneId)
      .toBe(finalZone);
    await waitForCondition(() =>
      harness.planner.snapshot().activeZonePreparations === 0
    );
    expect(harness.planner.snapshot()).toMatchObject({
      activeZonePreparations: 0,
      zonePreparationConcurrency: 1
    });
    await harness.planner.close();
  });

  it("skips World prefetch when every plan is ready", async () => {
    const harness = createHarness();
    harness.store.ensurePlansForZones.mockImplementation(async (requests) =>
      requests.map((entry) => ({
        ...entry,
        status: "ready" as const,
        claimGeneration: 1,
        attemptCount: 1,
        contentHash: "c".repeat(64)
      }))
    );

    const result = await harness.planner.prefetchEnvironmentForZones({
      zoneIds: sixZoneIds(),
      regionCode: "caller",
      reason: "flag-travel",
      priority: 0
    });

    expect(result.disposition).toBe("skipped-ready");
    expect(result.readyPlanZoneIds).toEqual(sixZoneIds());
    expect(harness.compiler.prefetchWorldEnvironmentForZones)
      .not.toHaveBeenCalled();
    expect(harness.store.claimPlan).not.toHaveBeenCalled();
    expect(harness.planner.snapshot()).toMatchObject({
      pendingZones: 0,
      queuedZones: 0,
      activeZonePreparations: 0
    });
    await harness.planner.close();
  });

  it("prefetches only unresolved plans without entering planner state", async () => {
    const harness = createHarness();
    const zones = sixZoneIds();
    harness.store.ensurePlansForZones.mockImplementation(async (requests) =>
      requests.map((entry, index) => ({
        ...entry,
        status: index < 4 ? "ready" as const : "pending" as const,
        claimGeneration: index < 4 ? 1 : 0,
        attemptCount: index < 4 ? 1 : 0,
        contentHash: index < 4 ? "c".repeat(64) : null
      }))
    );

    const result = await harness.planner.prefetchEnvironmentForZones({
      zoneIds: [...zones].reverse(),
      regionCode: "caller",
      reason: "flag-travel",
      priority: 1
    });

    expect(result).toMatchObject({
      disposition: "prefetched",
      readyPlanZoneIds: zones.slice(0, 4),
      unresolvedPlanZoneIds: zones.slice(4)
    });
    expect(harness.compiler.prefetchWorldEnvironmentForZones)
      .toHaveBeenCalledWith(expect.objectContaining({
        zoneIds: zones.slice(4),
        worldEnvironmentIdentityKey: WORLD_IDENTITY,
        priority: 2
      }));
    expect(harness.store.claimPlan).not.toHaveBeenCalled();
    expect(harness.compiler.compileZone).not.toHaveBeenCalled();
    expect(harness.planner.snapshot()).toMatchObject({
      pendingZones: 0,
      queuedZones: 0,
      activeZonePreparations: 0
    });
    await harness.planner.close();
  });

  it("continues admitted destination warming after its travel waiter cancels", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    let releasePrefetch!: () => void;
    harness.compiler.prefetchWorldEnvironmentForZones.mockImplementationOnce(
      async (input: {
        zoneIds: readonly PopulationZoneV2Id[];
        onWorldAdmitted?: () => void;
      }) => {
        input.onWorldAdmitted?.();
        await new Promise<void>((resolve) => {
          releasePrefetch = resolve;
        });
        return {
          requestedZoneIds: input.zoneIds,
          sampleReferences: input.zoneIds.length * 48,
          uniqueSamples: input.zoneIds.length * 48,
          worldCacheHits: 0,
          sentPointCount: input.zoneIds.length * 48,
          chunkCount: 1,
          chunkSizes: [input.zoneIds.length * 48],
          upstreamBatchCalls: 1,
          backpressureRetries: 0,
          admissionWaitMs: 0,
          upstreamDurationMs: 1
        };
      }
    );
    const prefetch = harness.planner.prefetchEnvironmentForZones({
      zoneIds: [ZONE_ID],
      regionCode: "test",
      reason: "flag-travel",
      priority: 0,
      signal: controller.signal
    });
    await waitForCondition(() =>
      harness.compiler.prefetchWorldEnvironmentForZones.mock.calls.length === 1);
    controller.abort(new DOMException("superseded", "AbortError"));
    await expect(prefetch).rejects.toMatchObject({ name: "AbortError" });
    releasePrefetch();

    await waitForCondition(() => harness.compiler.compileZone.mock.calls.length === 1);
    expect(harness.compiler.compileZone.mock.calls[0]?.[0]).toMatchObject({
      zoneId: ZONE_ID,
      priority: 3
    });
    await harness.planner.close();
  });

  it("does not continue admitted locality warming after its owner cancels", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    let releasePrefetch!: () => void;
    harness.compiler.prefetchWorldEnvironmentForZones.mockImplementationOnce(
      async (input: {
        zoneIds: readonly PopulationZoneV2Id[];
        onWorldAdmitted?: () => void;
      }) => {
        input.onWorldAdmitted?.();
        await new Promise<void>((resolve) => {
          releasePrefetch = resolve;
        });
        return {
          requestedZoneIds: input.zoneIds,
          sampleReferences: input.zoneIds.length * 48,
          uniqueSamples: input.zoneIds.length * 48,
          worldCacheHits: 0,
          sentPointCount: input.zoneIds.length * 48,
          chunkCount: 1,
          chunkSizes: [input.zoneIds.length * 48],
          upstreamBatchCalls: 1,
          backpressureRetries: 0,
          admissionWaitMs: 0,
          upstreamDurationMs: 1
        };
      }
    );
    const prefetch = harness.planner.prefetchEnvironmentForZones({
      zoneIds: [ZONE_ID],
      regionCode: "locality",
      reason: "flag-locality-warming",
      priority: 2,
      workClass: "locality",
      signal: controller.signal
    });
    await waitForCondition(() =>
      harness.compiler.prefetchWorldEnvironmentForZones.mock.calls.length === 1);
    controller.abort(new DOMException("superseded", "AbortError"));
    await expect(prefetch).rejects.toMatchObject({ name: "AbortError" });
    releasePrefetch();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.compiler.compileZone).not.toHaveBeenCalled();
    await harness.planner.close();
  });

  it("discards a destination prefetch cancelled before World admission", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    let internalSignal: AbortSignal | undefined;
    harness.compiler.prefetchWorldEnvironmentForZones.mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) => {
        internalSignal = signal;
        return new Promise((_, reject) => signal?.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true }
        ));
      }
    );
    const prefetch = harness.planner.prefetchEnvironmentForZones({
      zoneIds: [ZONE_ID],
      regionCode: "test",
      reason: "flag-travel",
      priority: 0,
      signal: controller.signal
    });
    await waitForCondition(() => internalSignal !== undefined);
    controller.abort(new DOMException("superseded", "AbortError"));

    await expect(prefetch).rejects.toMatchObject({ name: "AbortError" });
    await waitForCondition(() => internalSignal?.aborted === true);
    expect(harness.compiler.compileZone).not.toHaveBeenCalled();
    await harness.planner.close();
  });

  it("keeps the seam generator supplied across every parent habitat dependency", () => {
    const zoneIds = [
      { lat: 0, lon: 179.999 },
      { lat: 0, lon: -179.999 },
      { lat: 39.7392, lon: -104.9903 },
      { lat: 75, lon: 20 },
      { lat: -75, lon: -20 }
    ].map(populationZoneV2IdForPoint);
    const habitats = new Map(
      populationZoneV2PlanningHabitatZoneIds(zoneIds, 3).map((zoneId) => [
        zoneId,
        fullLandHabitat(zoneId)
      ] as const)
    );

    expect(() => generatePopulationZonesV2Plans({
      outputZoneIds: zoneIds,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: WORLD_SHA,
      habitatForZone: (zoneId) => {
        const habitat = habitats.get(zoneId);
        if (!habitat) throw new Error(`missing test habitat ${zoneId}`);
        return habitat;
      }
    })).not.toThrow();
  });
});

function createHarness(options: Readonly<{
  planLeaseMs?: number;
  activePreparationConcurrency?: number;
  backgroundPreparationConcurrency?: number;
  backgroundStarvationMs?: number;
  backgroundFairnessIntervalMs?: number;
  zoneQueueMax?: number;
}> = {}) {
  type PlanRequest = ReturnType<typeof populationZoneV2PlanRequest>;
  const store = {
    supersedeObsoletePlansForZones: vi.fn(async () => 0),
    ensurePlansForZones: vi.fn(async (
      requests: PlanRequest[]
    ): Promise<PopulationZoneV2PlanRecord[]> => requests.map((entry) => ({
      ...entry,
      status: "pending" as const,
      claimGeneration: 0,
      attemptCount: 0,
      contentHash: null
    }))),
    claimPlan: vi.fn(async (identity: PlanRequest["identity"]) => ({
      identity,
      planId: populationZoneV2PlanId(identity),
      ownerId: "00000000-0000-4000-8000-000000000001",
      claimGeneration: 1,
      attemptCount: 1
    })),
    heartbeatPlan: vi.fn(async (
      claim: ClaimedPopulationZoneV2Plan,
      leaseMs: number
    ) => {
      void claim;
      void leaseMs;
      return true;
    }),
    completePlan: vi.fn(async (
      claim: ClaimedPopulationZoneV2Plan,
      plan: GeneratedPopulationZoneV2Plan
    ) => {
      void claim;
      void plan;
      return true;
    }),
    failPlan: vi.fn(async (
      claim: ClaimedPopulationZoneV2Plan,
      error: unknown
    ): Promise<Readonly<{
      accepted: boolean;
      status: "retryable-failure" | "terminal-failure";
      errorCode?: PopulationPlanFailureCode;
    }>> => {
      void claim;
      void error;
      return {
        accepted: true,
        status: "retryable-failure" as const
      };
    })
  };
  const compiler = {
    compileZone: vi.fn(async ({
      zoneId
    }: {
      zoneId: PopulationZoneV2Id;
      priority?: 0 | 1 | 2 | 3;
      cacheClass?: "protected" | "probationary";
    }) =>
      fullLandHabitat(zoneId)
    ),
    prefetchWorldEnvironmentForZones: vi.fn(async ({ zoneIds }: {
      zoneIds: readonly PopulationZoneV2Id[];
      signal?: AbortSignal;
      onWorldAdmitted?: () => void;
    }) => ({
      requestedZoneIds: zoneIds,
      sampleReferences: zoneIds.length * 48,
      uniqueSamples: zoneIds.length * 48,
      worldCacheHits: 0,
      sentPointCount: zoneIds.length * 48,
      chunkCount: zoneIds.length > 0 ? 1 : 0,
      chunkSizes: zoneIds.length > 0 ? [zoneIds.length * 48] : [],
      upstreamBatchCalls: zoneIds.length > 0 ? 1 : 0,
      backpressureRetries: 0,
      admissionWaitMs: 0,
      upstreamDurationMs: 1
    })),
    snapshot: vi.fn(() => ({
      activeLookups: 0,
      cacheEntries: 0,
      protectedCacheEntries: 0,
      probationaryCacheEntries: 0,
      cacheMetrics: {
        protectedHits: 0,
        probationaryHits: 0,
        promotions: 0,
        protectedEvictions: 0,
        probationaryEvictions: 0
      },
      inFlightSamples: 0,
      zones: []
    }))
  };
  const logger = { warn: vi.fn() };
  const generatePlans = vi.fn(({ outputZoneIds, habitatForZone, environmentProfileVersion }: {
    outputZoneIds: readonly PopulationZoneV2Id[];
    habitatForZone(zoneId: PopulationZoneV2Id): PopulationZoneV2Habitat;
    environmentProfileVersion: string;
  }) => outputZoneIds.map((zoneId) => {
    const zoneRequest = populationZoneV2PlanRequest({
      zoneId,
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: WORLD_SHA,
      environmentProfileVersion,
      regionCode: packageIdForPosition(
        populationZoneV2Geometry(zoneId).center
      )
    });
    return {
      identity: zoneRequest.identity,
      planId: zoneRequest.planId,
      worldPipelineSha: WORLD_SHA,
      geometry: populationZoneV2Geometry(zoneId),
      habitat: habitatForZone(zoneId),
      slots: [],
      contentHash: "c".repeat(64)
    } satisfies GeneratedPopulationZoneV2Plan;
  }));
  const planner = new PopulationZonesV2Planner(
    store,
    compiler,
    {
      worldEnvironmentIdentityKey: WORLD_IDENTITY,
      worldPipelineSha: WORLD_SHA,
      retryMs: 60_000,
      ...(options.planLeaseMs === undefined
        ? {}
        : { planLeaseMs: options.planLeaseMs }),
      ...(options.activePreparationConcurrency === undefined
        ? {}
        : { activePreparationConcurrency: options.activePreparationConcurrency }),
      ...(options.backgroundPreparationConcurrency === undefined
        ? {}
        : {
            backgroundPreparationConcurrency:
              options.backgroundPreparationConcurrency
          }),
      ...(options.backgroundStarvationMs === undefined
        ? {}
        : { backgroundStarvationMs: options.backgroundStarvationMs }),
      ...(options.backgroundFairnessIntervalMs === undefined
        ? {}
        : {
            backgroundFairnessIntervalMs:
              options.backgroundFairnessIntervalMs
          }),
      ...(options.zoneQueueMax === undefined
        ? {}
        : { zoneQueueMax: options.zoneQueueMax }),
      generatePlans
    },
    logger
  );
  return { planner, store, compiler, logger, generatePlans };
}

function sixZoneIds(): PopulationZoneV2Id[] {
  return [
    "ppz2-eag1/b4l/4y6",
    "ppz2-eag1/b4l/4y7",
    "ppz2-eag1/b4l/4y8",
    "ppz2-eag1/b4m/4y5",
    "ppz2-eag1/b4m/4y6",
    "ppz2-eag1/b4m/4y7"
  ];
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("test condition was not reached");
}

function fullLandHabitat(zoneId: PopulationZoneV2Id): PopulationZoneV2Habitat {
  const areaKm2 = populationZoneV2Geometry(zoneId).areaKm2;
  return {
    regionCode: packageIdForPosition(populationZoneV2Geometry(zoneId).center),
    eligibleLandKm2: areaKm2,
    treeKm2: areaKm2,
    deerKm2: areaKm2,
    wolfKm2: areaKm2,
    stoneKm2: areaKm2,
    ogreKm2: areaKm2,
    habitatSummary: {},
    environmentSnapshot: {}
  };
}
