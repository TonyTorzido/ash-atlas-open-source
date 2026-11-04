import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import type { EquipmentChallengeProfile } from "@ash-atlas/shared";

import { runMigrations } from "../db/migrate.js";
import type { AppLogger } from "../logger.js";
import { WORLD_RUNTIME_CONTRACT } from "../runtime/authorityIdentity.js";
import { WorldLookupClient } from "../world/worldLookupClient.js";
import {
  createPopulationZonesV2Composition,
  type PopulationZonesV2Composition
} from "./populationZonesV2Composition.js";
import {
  populationZonesV2IntersectingCircle
} from "./populationZonesV2Geometry.js";
import {
  reservePopulationTravelArea,
  type PopulationTravelLifecycleEvent
} from "./populationTravelReservation.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const DESTINATION = Object.freeze({ lat: 39.7, lon: -105.017 });
const RADIUS_M = 650;
const PROFILE: EquipmentChallengeProfile = Object.freeze({
  balanceVersion: 2,
  currentGearLevel: 12,
  unlockedGearLevel: 12,
  tier: "rare",
  contributors: Object.freeze({ melee: 12, chest: 12, secondary: 12 })
});

describeDatabase("cold destination environment prefetch", () => {
  const databaseName = `ash_atlas_stability_cold_prefetch_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let server: ReturnType<typeof createServer>;
  let world: WorldLookupClient;
  let composition: PopulationZonesV2Composition;
  let upstreamCalls = 0;
  const upstreamPoints: string[][] = [];
  let activeWorldRequests = 0;
  let maximumActiveWorldRequests = 0;
  let worldDelayMs = 0;
  let failuresRemaining = 0;
  const activeActors = new Map<string, unknown>();
  let actorSpawns = 0;
  const lifecycle: PopulationTravelLifecycleEvent[] = [];
  const warn = vi.fn();

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(parsed.toString());
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 8 });

    server = createServer(async (request, response) => {
      if (request.url !== "/api/gameplay-environment-batch") {
        response.writeHead(404).end();
        return;
      }
      upstreamCalls += 1;
      activeWorldRequests += 1;
      maximumActiveWorldRequests = Math.max(
        maximumActiveWorldRequests,
        activeWorldRequests
      );
      try {
        const body = JSON.parse(await readRequestBody(request)) as {
          points: Array<{ latitude: number; longitude: number }>;
        };
        upstreamPoints.push(body.points.map(({ latitude, longitude }) =>
          `${latitude.toFixed(12)}:${longitude.toFixed(12)}`
        ));
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          response.writeHead(503, {
            "Content-Type": "application/json",
            "Retry-After": "0"
          });
          response.end(JSON.stringify({ ok: false }));
          return;
        }
        if (worldDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, worldDelayMs));
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(gameplayEnvironmentBatch(body.points)));
      } finally {
        activeWorldRequests -= 1;
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("controlled World server did not bind");
    }
    const logger = {
      warn,
      info: vi.fn()
    } as unknown as AppLogger;
    world = new WorldLookupClient(
      `http://127.0.0.1:${address.port}`,
      logger,
      2_000,
      WORLD_RUNTIME_CONTRACT.worldRelease,
      10_000
    );
    composition = createPopulationZonesV2Composition({
      pool,
      config: {
        REGION_CODE: "US-CO",
        RUNTIME_SHA: "f9537e81f198bf29d2165bb09d0100dd9d7d1eb6",
        POPULATION_V2_ACTIVE_PREPARATION_CONCURRENCY: 1,
        POPULATION_V2_RETRY_MIN_MS: 20,
        POPULATION_V2_RETRY_MAX_MS: 100,
        POPULATION_V2_SLEEP_GRACE_MS: 5
      },
      worldIdentity: WORLD_RUNTIME_CONTRACT.worldRelease,
      worldLookup: world,
      combat: {
        entity: (entityId) => activeActors.get(entityId) as never ?? null,
        spawnMob: (descriptor) => {
          if (!descriptor.entityId) throw new Error("population actor omitted entity ID");
          actorSpawns += 1;
          activeActors.set(descriptor.entityId, descriptor);
          return descriptor as never;
        },
        despawnMob: (entityId) => activeActors.delete(entityId),
        despawnPopulationManagedMob: () => false,
        rebindPopulationAuthority: (entityId) => activeActors.has(entityId)
      },
      logger
    });
  }, 60_000);

  afterAll(async () => {
    await composition?.close();
    world?.shutdownBatchAdmission();
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => error ? reject(error) : resolve());
    });
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await admin?.end();
  });

  it("warms World once and preserves six independent durable plans and generations", async () => {
    const expectedZoneIds = populationZonesV2IntersectingCircle(
      DESTINATION,
      RADIUS_M
    );
    expect(expectedZoneIds).toEqual([
      "ppz2-eag1/b4l/4y6",
      "ppz2-eag1/b4l/4y7",
      "ppz2-eag1/b4l/4y8",
      "ppz2-eag1/b4m/4y5",
      "ppz2-eag1/b4m/4y6",
      "ppz2-eag1/b4m/4y7"
    ]);
    const compiler = (composition.planner as unknown as {
      compiler: { compileZone(...args: unknown[]): Promise<unknown> };
    }).compiler;
    const compileZone = vi.spyOn(compiler, "compileZone");
    const claimPlan = vi.spyOn(composition.store, "claimPlan");
    const completePlan = vi.spyOn(composition.store, "completePlan");
    const createGeneration = vi.spyOn(
      composition.store,
      "createCurrentGeneration"
    );
    const durableLoads = vi.spyOn(
      composition.store,
      "loadReadyEntitiesForZones"
    );
    const profileClaims = vi.spyOn(
      composition.store,
      "claimMobCombatProfilesForZones"
    );
    const requestId = `cold-prefetch-${randomUUID()}`;
    const area = {
      center: DESTINATION,
      certifiedVisibleRadiusM: RADIUS_M,
      preparedRadiusM: RADIUS_M + 100,
      sourceType: "area" as const,
      sourceId: "cold-prefetch-flag",
      generation: 1
    };
    const startedAt = performance.now();
    const reservation = reservePopulationTravelArea({
      hooks: composition.orchestrator,
      area,
      kind: "city-travel",
      playerId: "cold-prefetch-player",
      connectionId: "cold-prefetch-connection",
      connectionGeneration: 1,
      travelId: requestId,
      expectedRelocationRevision: 1,
      expectedResourceVisionRevision: 1,
      expectedGameplayViewGeneration: 1,
      lifecycle: (event) => lifecycle.push(event)
    });
    try {
      const durable = await reservation.preparation;
      const durableReadyMs = performance.now() - startedAt;
      expect(durable).toMatchObject({ status: "ready", zoneIds: expectedZoneIds });
      const simulationStartedAt = performance.now();
      const simulation = await reservation.promote(PROFILE);
      const simulationReadyMs = performance.now() - simulationStartedAt;
      expect(simulation.status).toBe("ready");
      const transitionStartedAt = performance.now();
      expect(reservation.adopt({
        relocationRevision: 1,
        resourceVisionRevision: 1,
        gameplayViewGeneration: 1,
        area
      })).toBe("adopted");
      const relocation = composition.runtime.startRelocation({
        playerId: "cold-prefetch-player",
        connectionId: "cold-prefetch-connection",
        connectionGeneration: 1,
        area,
        relocationRevision: 1,
        resourceVisionRevision: 1,
        challengeProfile: PROFILE,
        trigger: "administrative-relocation"
      });
      await relocation.visibleReady;
      await relocation.completion;
      const transitionMs = performance.now() - transitionStartedAt;
      const totalMs = performance.now() - startedAt;

      expect(upstreamCalls).toBe(1);
      expect(upstreamPoints).toHaveLength(1);
      expect(upstreamPoints[0]).toHaveLength(280);
      expect(world.gameplayEnvironmentMetrics()).toMatchObject({
        entries: 280,
        batchUpstreamAttempts: 1,
        batchPoints: 280,
        hits: 280
      });
      expect(world.worldBatchAdmissionMetrics()).toMatchObject({
        concurrency: 1,
        maximumActive: 1,
        active: 0,
        queueDepth: 0
      });
      expect(maximumActiveWorldRequests).toBe(1);
      expect(compileZone).toHaveBeenCalledTimes(6);
      expect(claimPlan).toHaveBeenCalledTimes(6);
      expect(completePlan).toHaveBeenCalledTimes(6);
      expect(createGeneration).toHaveBeenCalledTimes(6);
      expect(profileClaims).toHaveBeenCalledTimes(6);
      expect(new Set(completePlan.mock.calls.map(
        ([claim]) => claim.identity.zoneId
      ))).toEqual(new Set(expectedZoneIds));

      const generations = await composition.store
        .loadCurrentServingPlanGenerations(expectedZoneIds);
      expect(generations).toHaveLength(6);
      expect(new Set(generations.map(({ generationId }) => generationId)).size)
        .toBe(6);
      const entities = await composition.store.loadReadyEntitiesForZones(
        expectedZoneIds
      );
      expect(entities.length).toBeGreaterThan(0);
      expect(new Set(entities.map(({ entityId }) => entityId)).size)
        .toBe(entities.length);
      expect(entities.filter(({ entityKind }) =>
        entityKind === "wolf" || entityKind === "ogre"
      ).every(({ combatLevel }) => combatLevel === 12)).toBe(true);
      expect(lifecycle.filter(({ event, stage, disposition }) =>
        event === "stage-result"
        && disposition === "ready"
        && (stage === "DURABLE_READY" || stage === "SIMULATION_READY")
      )).toHaveLength(2);

      expect(composition.orchestrator.releaseSource(
        `player-visible:cold-prefetch-player:1:1:${requestId}`
      )).toBe(true);
      composition.runtime.releaseConnection("cold-prefetch-connection", 1);
      await vi.waitFor(() => {
        expect(activeActors.size).toBe(0);
        expect(composition.runtime.snapshot().sleepInFlightZones).toBe(0);
      }, { timeout: 5_000 });
      expect(composition.runtime.snapshot()).toMatchObject({
        connectionLeases: 0,
        streamingSourceLeases: 0,
        activationRequests: 0,
        activationWaiters: 0,
        sleepInFlightZones: 0
      });
      expect(composition.planner.snapshot()).toMatchObject({
        activeZonePreparations: 0,
        queuedZones: 0,
        zonePreparationConcurrency: 1
      });
      console.info("cold-destination-prefetch-flow", JSON.stringify({
        requestId,
        zoneIds: expectedZoneIds,
        sampleReferences: 288,
        uniquePoints: upstreamPoints[0]?.length,
        upstreamCalls,
        completedPlans: completePlan.mock.calls.length,
        planClaims: claimPlan.mock.calls.length,
        generations: generations.length,
        generationMaterializations: createGeneration.mock.calls.length,
        durableLoads: durableLoads.mock.calls.length,
        profileClaims: profileClaims.mock.calls.length,
        durableEntities: entities.length,
        actorActivations: actorSpawns,
        durableReadyMs: Math.round(durableReadyMs * 100) / 100,
        simulationReadyMs: Math.round(simulationReadyMs * 100) / 100,
        transitionMs: Math.round(transitionMs * 100) / 100,
        totalMs: Math.round(totalMs * 100) / 100,
        lifecycle,
        finalRuntime: composition.runtime.snapshot(),
        finalPlanner: composition.planner.snapshot()
      }));
    } finally {
      reservation.release("test-cleanup");
      composition.orchestrator.releaseSource(`player-visible:cold-prefetch-player:1:1:${requestId}`);
      composition.runtime.releaseConnection("cold-prefetch-connection", 1);
    }
  }, 120_000);

  it("falls back once to the unchanged per-zone path after prefetch exhausts retries", async () => {
    const destination = { lat: 39.7, lon: -99.992 };
    const zoneIds = populationZonesV2IntersectingCircle(destination, RADIUS_M);
    expect(zoneIds).toHaveLength(6);
    failuresRemaining = 2;
    const callsBefore = upstreamCalls;
    const warningsBefore = warn.mock.calls.length;
    const requestId = `cold-fallback-${randomUUID()}`;
    const reservation = reservePopulationTravelArea({
      hooks: composition.orchestrator,
      area: {
        center: destination,
        certifiedVisibleRadiusM: RADIUS_M,
        preparedRadiusM: RADIUS_M + 100,
        sourceType: "area",
        sourceId: "cold-fallback-flag",
        generation: 2
      },
      kind: "city-travel",
      playerId: "cold-fallback-player",
      connectionId: "cold-fallback-connection",
      connectionGeneration: 1,
      travelId: requestId,
      expectedRelocationRevision: 1,
      expectedResourceVisionRevision: 1,
      expectedGameplayViewGeneration: 2
    });

    try {
      await expect(reservation.preparation).resolves.toMatchObject({
        status: "ready",
        zoneIds
      });
      expect(upstreamCalls - callsBefore).toBe(8);
      expect(failuresRemaining).toBe(0);
      expect(warn.mock.calls.slice(warningsBefore)).toEqual(expect.arrayContaining([
        [
          expect.objectContaining({ disposition: "fallback-per-zone" }),
          "population destination environment prefetch failed; using per-zone path"
        ]
      ]));
      const generations = await composition.store
        .loadCurrentServingPlanGenerations(zoneIds);
      expect(generations).toHaveLength(6);
      expect(new Set(generations.map(({ generationId }) => generationId)).size)
        .toBe(6);
      expect(reservation.release("test-cleanup")).toBe(true);
      await vi.waitFor(() => {
        expect(composition.runtime.snapshot()).toMatchObject({
          streamingSourceLeases: 0,
          activationRequests: 0,
          activationWaiters: 0
        });
      });
    } finally {
      reservation.release("test-cleanup");
      composition.runtime.releaseConnection("cold-fallback-connection", 1);
    }
  }, 120_000);

  it("bounds overlapping and nonoverlapping foreground prefetch concurrency", async () => {
    worldDelayMs = 25;
    const used = new Set<string>();
    const overlapping = sixZoneDestination(0, used);
    const callsBeforeOverlap = upstreamCalls;
    const overlapA = coldReservation(
      composition,
      overlapping,
      "overlap-a",
      10
    );
    const overlapB = coldReservation(
      composition,
      overlapping,
      "overlap-b",
      11
    );
    await expect(Promise.all([
      overlapA.preparation,
      overlapB.preparation
    ])).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ status: "ready" })
    ]);
    const overlappingCalls = upstreamCalls - callsBeforeOverlap;
    expect(overlapA.release("test-cleanup")).toBe(true);
    expect(overlapB.release("test-cleanup")).toBe(true);
    expect(overlappingCalls).toBeGreaterThanOrEqual(1);
    expect(overlappingCalls).toBeLessThanOrEqual(2);

    const first = sixZoneDestination(1, used);
    const second = sixZoneDestination(2, used);
    const callsBeforeNonoverlap = upstreamCalls;
    const nonoverlapA = coldReservation(composition, first, "nonoverlap-a", 12);
    const nonoverlapB = coldReservation(composition, second, "nonoverlap-b", 13);
    await Promise.all([nonoverlapA.preparation, nonoverlapB.preparation]);
    const nonoverlapCalls = upstreamCalls - callsBeforeNonoverlap;
    expect(nonoverlapA.release("test-cleanup")).toBe(true);
    expect(nonoverlapB.release("test-cleanup")).toBe(true);
    expect(nonoverlapCalls).toBeGreaterThanOrEqual(2);
    expect(nonoverlapCalls).toBeLessThanOrEqual(14);
    console.info("cold-destination-prefetch-two-player", JSON.stringify({
      overlappingUpstreamCalls: overlappingCalls,
      nonoverlappingUpstreamCalls: nonoverlapCalls,
      worldCacheMaximumNotIncreased: true
    }));
    expect(world.worldBatchAdmissionMetrics()).toMatchObject({
      concurrency: 1,
      maximumActive: 1,
      active: 0,
      queueDepth: 0
    });
    expect(maximumActiveWorldRequests).toBe(1);
    await vi.waitFor(() => expect(composition.planner.snapshot()).toMatchObject({
      activeZonePreparations: 0,
      queuedZones: 0
    }));
    await vi.waitFor(() => expect(pool.waitingCount).toBe(0));
    worldDelayMs = 0;
  }, 120_000);

  it("cancels half of ten queued cold destinations behind Resource Vision", async () => {
    worldDelayMs = 50;
    const eventLoop = monitorEventLoopDelay({ resolution: 10 });
    eventLoop.enable();
    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const callsBefore = upstreamCalls;
    const pointsBefore = upstreamPoints.length;
    const resourceVision = world.lookupGameplayEnvironments(
      [{ lat: -70.123, lon: 10.456 }],
      { caller: "resource-vision", priority: 2 }
    );
    await vi.waitFor(() => expect(activeWorldRequests).toBe(1));
    const used = new Set<string>();
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const reservations = controllers.map((controller, index) =>
      coldReservation(
        composition,
        sixZoneDestination(index + 20, used),
        `ten-${index}`,
        20 + index,
        controller.signal
      )
    );
    controllers.forEach((controller, index) => {
      if (index % 2 === 1) {
        controller.abort(new DOMException("superseded", "AbortError"));
      }
    });
    const outcomes = await Promise.allSettled(
      reservations.map(({ preparation }) => preparation)
    );
    await resourceVision;
    eventLoop.disable();
    expect(outcomes.filter((outcome) =>
      outcome.status === "fulfilled" && outcome.value.status === "ready"
    )).toHaveLength(5);
    expect(outcomes.filter((outcome) =>
      outcome.status === "rejected"
      || outcome.value.status === "not-ready"
    )).toHaveLength(5);
    const readyZoneIds = [...new Set(outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" && outcome.value.status === "ready"
        ? outcome.value.zoneIds
        : []
    ))];
    const generations = await composition.store
      .loadCurrentServingPlanGenerations(readyZoneIds);
    const entities = await composition.store.loadReadyEntitiesForZones(
      readyZoneIds
    );
    expect(generations).toHaveLength(readyZoneIds.length);
    expect(new Set(generations.map(({ generationId }) => generationId)).size)
      .toBe(generations.length);
    expect(new Set(entities.map(({ entityId }) => entityId)).size)
      .toBe(entities.length);
    reservations.forEach((reservation) => reservation.release("test-cleanup"));
    await vi.waitFor(() => {
      expect(composition.runtime.snapshot()).toMatchObject({
        streamingSourceLeases: 0,
        activationRequests: 0,
        activationWaiters: 0
      });
      expect(composition.planner.snapshot()).toMatchObject({
        activeZonePreparations: 0,
        queuedZones: 0
      });
    }, { timeout: 10_000 });
    await vi.waitFor(() => expect(pool.waitingCount).toBe(0), {
      timeout: 10_000
    });
    const requestPoints = upstreamPoints.slice(pointsBefore).flat();
    console.info("cold-destination-prefetch-concurrency", JSON.stringify({
      operations: 10,
      cancelled: 5,
      upstreamBatchCalls: upstreamCalls - callsBefore,
      requestedPoints: requestPoints.length,
      duplicatePointRequests:
        requestPoints.length - new Set(requestPoints).size,
      world: world.worldBatchAdmissionMetrics(),
      planner: composition.planner.snapshot(),
      databasePoolWaiters: pool.waitingCount,
      duplicateGenerations:
        generations.length
        - new Set(generations.map(({ generationId }) => generationId)).size,
      duplicateEntityIds:
        entities.length - new Set(entities.map(({ entityId }) => entityId)).size,
      runtime: composition.runtime.snapshot(),
      cpuUsage: process.cpuUsage(cpuBefore),
      rssDeltaBytes: process.memoryUsage().rss - rssBefore,
      eventLoopP50Ms: eventLoop.percentile(50) / 1_000_000,
      eventLoopP95Ms: eventLoop.percentile(95) / 1_000_000,
      eventLoopP99Ms: eventLoop.percentile(99) / 1_000_000
    }));
    expect(world.worldBatchAdmissionMetrics()).toMatchObject({
      concurrency: 1,
      maximumActive: 1,
      active: 0,
      queueDepth: 0
    });
    expect(maximumActiveWorldRequests).toBe(1);
    expect(pool.waitingCount).toBe(0);
    worldDelayMs = 0;
  }, 180_000);
});

function coldReservation(
  composition: PopulationZonesV2Composition,
  center: Readonly<{ lat: number; lon: number }>,
  suffix: string,
  generation: number,
  signal?: AbortSignal
) {
  return reservePopulationTravelArea({
    hooks: composition.orchestrator,
    area: {
      center,
      certifiedVisibleRadiusM: RADIUS_M,
      preparedRadiusM: RADIUS_M + 100,
      sourceType: "area",
      sourceId: `cold-${suffix}`,
      generation
    },
    kind: "city-travel",
    playerId: `player-${suffix}`,
    connectionId: `connection-${suffix}`,
    connectionGeneration: 1,
    travelId: `travel-${suffix}`,
    expectedRelocationRevision: 1,
    expectedResourceVisionRevision: 1,
    expectedGameplayViewGeneration: generation,
    ...(signal ? { signal } : {})
  });
}

function sixZoneDestination(seed: number, used: Set<string>) {
  const baseLat = -55 + (seed % 12) * 9;
  const baseLon = -160 + (Math.floor(seed / 12) % 8) * 35;
  for (let latStep = 0; latStep < 30; latStep += 1) {
    for (let lonStep = 0; lonStep < 300; lonStep += 1) {
      const center = {
        lat: baseLat + latStep * 0.001,
        lon: baseLon + lonStep * 0.001
      };
      const zoneIds = populationZonesV2IntersectingCircle(center, RADIUS_M);
      if (
        zoneIds.length === 6
        && zoneIds.every((zoneId) => !used.has(zoneId))
      ) {
        zoneIds.forEach((zoneId) => used.add(zoneId));
        return center;
      }
    }
  }
  throw new Error(`could not find a distinct six-zone destination for ${seed}`);
}

function gameplayEnvironmentBatch(
  points: Array<{ latitude: number; longitude: number }>
) {
  const release = WORLD_RUNTIME_CONTRACT.worldRelease;
  return {
    ok: true,
    contract_version: "gameplay-environment-v1",
    release: {
      release_id: release.releaseId,
      profile_set_fingerprint: release.profileSetFingerprint,
      build_contract_fingerprint: release.buildContractFingerprint,
      boundary_release_id: release.boundaryReleaseId,
      package_count: 64_800
    },
    runtime: {
      sha: WORLD_RUNTIME_CONTRACT.worldPipelineSha,
      branch: "main"
    },
    results: points.map(({ latitude, longitude }) => ({
      latitude,
      longitude,
      packageId: "world_v1_lat39_lon-106",
      isLand: true,
      isSaltwater: false,
      insideMajorLake: false,
      isCoastal: false,
      isCoastalLand: false,
      majorLakeId: null,
      majorLakeName: null,
      majorLakeDistanceM: null,
      elevationM: 1_600,
      elevationBand: "highland",
      terrainClass: "rolling",
      landCoverClass: "forest",
      biomeId: "temperate-forest",
      biomeName: "Temperate forest",
      ecoregionId: "rockies",
      ecoregionName: "Rockies",
      countryId: "usa",
      countryName: "United States",
      regionId: "colorado",
      regionName: "Colorado",
      settlementId: null,
      settlementName: null,
      countryCode: "US",
      regionCode: "US-CO",
      namedRiverId: null,
      namedRiverName: null,
      riverClass: null,
      riverDistanceM: null,
      supportingRiverId: null,
      supportingRiverFlowOrder: null,
      supportingRiverDischargeCms: null,
      supportingRiverDrainageAreaSqKm: null,
      supportingRiverDistanceM: null,
      flagPlacementWater: {
        blocked: false,
        kind: "land",
        source_id: null,
        source_name: null,
        distance_m: null,
        corridor_radius_m: null,
        reason: "authoritative land",
        resolution: "water-placement-surface-v1",
        release_id: release.releaseId
      }
    }))
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.hostname !== "127.0.0.1"
    || !parsed.pathname.startsWith("/ash_atlas_stability")
    || parsed.pathname === "/ash_atlas_game"
  ) {
    throw new Error("test requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(value)) {
    throw new Error("unsafe disposable database identifier");
  }
  return `"${value}"`;
}
