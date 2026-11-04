import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import {
  DEFAULT_FLAG_PREPARE_BUFFER_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  type EquipmentChallengeProfile,
  type ResourceVision
} from "@ash-atlas/shared";
import { runMigrations } from "../db/migrate.js";
import { CollectibleService } from "./collectibles.js";
import { PopulationAreaOrchestrator } from "./populationAreaOrchestrator.js";
import {
  reservePopulationTravelArea,
  type PopulationTravelLifecycleEvent
} from "./populationTravelReservation.js";
import {
  POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION
} from "./populationZoneV3HabitatCompiler.js";
import {
  POPULATION_ZONE_V2_GEOMETRY_VERSION,
  populationZoneV2Geometry,
  populationZoneV2Halo,
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import {
  generatePopulationZonesV2Plans,
  populationZoneV3ConservativeHabitat
} from "./populationZonesV2Plan.js";
import { PopulationZonesV2Backend } from "./populationZonesV2Backend.js";
import {
  populationZoneV2CanonicalRegionCode
} from "./populationZonesV2Planner.js";
import {
  PopulationZonesV2Runtime,
  type PopulationZonesV2RuntimeBackend
} from "./populationZonesV2Runtime.js";
import {
  POPULATION_V2_READY_ENTITIES_SQL,
  populationZoneV2PlanRequest,
  PostgresPopulationZonesV2Store
} from "./populationZonesV2Store.js";
import { RepeatableResourceService } from "./repeatableResources.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;
const BENCHMARK_CHALLENGE_PROFILE: EquipmentChallengeProfile = Object.freeze({
  balanceVersion: 2,
  currentGearLevel: 12,
  unlockedGearLevel: 12,
  tier: "rare",
  contributors: Object.freeze({
    melee: 12,
    chest: 12,
    secondary: 12
  })
});

describeDatabase("population travel hot-path benchmark", () => {
  const databaseName =
    `ash_atlas_stability_population_travel_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  const worldEnvironmentIdentityKey = "e".repeat(64);
  const worldPipelineSha = "e".repeat(40);
  const runtimeSha = "f".repeat(40);
  let admin: pg.Pool;
  let pool: pg.Pool;
  let zoneIds: readonly PopulationZoneV2Id[];
  let destinationZoneIds: readonly [PopulationZoneV2Id, PopulationZoneV2Id];

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(parsed.toString());
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 16 });

    const firstZone = populationZoneV2IdForPoint({
      lat: 35.0844,
      lon: -106.6504
    });
    const secondZone = populationZoneV2Halo(firstZone, 1)
      .find((zoneId) => zoneId !== firstZone)!;
    destinationZoneIds = [firstZone, secondZone];
    zoneIds = [...new Set(destinationZoneIds.flatMap((zoneId) =>
      populationZonesV2IntersectingCircle(
        populationZoneV2Geometry(zoneId).center,
        DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
      )
    ))].sort();
    const plans = generatePopulationZonesV2Plans({
      outputZoneIds: zoneIds,
      worldEnvironmentIdentityKey,
      worldPipelineSha,
      environmentProfileVersion:
        POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION,
      habitatForZone: (zoneId) => populationZoneV3ConservativeHabitat({
        zoneId,
        worldEnvironmentIdentityKey,
        regionCode: populationZoneV2CanonicalRegionCode(zoneId)
      })
    });
    const seedStore = new PostgresPopulationZonesV2Store(pool);
    for (const plan of plans) {
      const zoneId = plan.identity.zoneId as PopulationZoneV2Id;
      const request = populationZoneV2PlanRequest({
        zoneId,
        worldEnvironmentIdentityKey,
        worldPipelineSha,
        environmentProfileVersion:
          POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION,
        regionCode: populationZoneV2CanonicalRegionCode(zoneId)
      });
      await seedStore.ensurePlanForZone(request);
      const claim = await seedStore.claimPlan(
        request.identity,
        randomUUID(),
        30_000
      );
      if (!claim) throw new Error(`benchmark could not claim ${zoneId}`);
      await seedStore.completePlan(claim, plan);
      await seedStore.createCurrentGeneration({
        zoneId,
        planId: plan.planId,
        now: new Date()
      });
    }
    await seedStore.claimMobCombatProfilesForZones(zoneIds.map((zoneId) => ({
      zoneId,
      level: 12,
      source: "zone_player_profile" as const
    })));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`
    );
    await admin?.end();
  });

  it("asserts the production-shaped heavy canonical fixture", async () => {
    const entities = await new PostgresPopulationZonesV2Store(pool)
      .loadReadyEntitiesForZones(zoneIds);
    const byKind = Object.fromEntries(
      [...new Set(entities.map((entity) => entity.entityKind))]
        .sort()
        .map((kind) => [
          kind,
          entities.filter((entity) => entity.entityKind === kind).length
        ])
    );
    const packSizes = new Map<string, number>();
    for (const entity of entities) {
      if (
        (entity.entityKind !== "wolf"
          && entity.entityKind !== "sap_crawler")
        || !entity.packId
      ) continue;
      packSizes.set(entity.packId, (packSizes.get(entity.packId) ?? 0) + 1);
    }
    expect(entities.length).toBeGreaterThan(100);
    for (const kind of [
      "tree",
      "deer",
      "wolf",
      "ogre",
      "sap_crawler"
    ]) {
      expect(byKind[kind], `expected ${kind} in the heavy fixture`)
        .toBeGreaterThan(0);
    }
    expect((byKind.stone ?? 0) + (byKind.coal ?? 0) + (byKind.iron ?? 0))
      .toBeGreaterThan(0);
    expect([...packSizes.values()].every((size) => size > 1)).toBe(true);
    expect(new Set(entities.map((entity) => entity.entityId)).size)
      .toBe(entities.length);
    console.info("population-heavy-fixture", JSON.stringify({
      zoneCount: zoneIds.length,
      entityCount: entities.length,
      byKind,
      packCount: packSizes.size,
      packSizes: [...packSizes.values()].sort((left, right) => left - right)
    }));
  });

  it("measures before/after one-flight reuse and repeated old-flag hops", async () => {
    const explainClient = await pool.connect();
    let profileNoopExplain = "";
    let profilePartialIndexExplain = "";
    let readyEntitiesExplain: unknown;
    try {
      await explainClient.query("ANALYZE generated_world_mobs");
      await explainClient.query("ANALYZE population_plan_spawn_slots_v2");
      await explainClient.query("ANALYZE population_spawn_slots_v2");
      await explainClient.query("ANALYZE population_entity_state_v2");
      await explainClient.query("BEGIN");
      await explainClient.query("SET LOCAL enable_seqscan=off");
      const explained = await explainClient.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
         SELECT DISTINCT ON (physical_population_zone_v2_id)
                physical_population_zone_v2_id AS zone_id
         FROM generated_world_mobs
         WHERE physical_population_zone_v2_id=ANY($1::text[])
           AND combat_level IS NULL
           AND killed_at IS NULL
           AND NOT population_v2_suppressed
         ORDER BY physical_population_zone_v2_id,
                  population_v2_plan_id,
                  encounter_id`,
        [zoneIds]
      );
      profileNoopExplain = explained.rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      await explainClient.query("ROLLBACK");
      await explainClient.query("BEGIN");
      await explainClient.query("SET LOCAL enable_seqscan=off");
      // The tiny fixture makes PostgreSQL prefer the general living-mob index.
      // A rollback-only removal proves the existing partial index serves the
      // exact query without changing the disposable schema.
      await explainClient.query(
        "DROP INDEX generated_world_mobs_living_geom_idx"
      );
      const partialIndexExplained = await explainClient.query<{
        "QUERY PLAN": string;
      }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
         SELECT DISTINCT ON (physical_population_zone_v2_id)
                physical_population_zone_v2_id AS zone_id
         FROM generated_world_mobs
         WHERE physical_population_zone_v2_id=ANY($1::text[])
           AND combat_level IS NULL
           AND killed_at IS NULL
           AND NOT population_v2_suppressed
         ORDER BY physical_population_zone_v2_id,
                  population_v2_plan_id,
                  encounter_id`,
        [zoneIds]
      );
      profilePartialIndexExplain = partialIndexExplained.rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      await explainClient.query("ROLLBACK");
      const readyEntitiesExplained = await explainClient.query<{
        "QUERY PLAN": unknown;
      }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         ${POPULATION_V2_READY_ENTITIES_SQL}`,
        [zoneIds, POPULATION_ZONE_V2_GEOMETRY_VERSION]
      );
      readyEntitiesExplain = readyEntitiesExplained.rows[0]?.["QUERY PLAN"];
    } finally {
      explainClient.release();
    }
    expect(profileNoopExplain).toMatch(/Index(?: Only)? Scan/);
    expect(profileNoopExplain).toContain("Execution Time");
    expect(profilePartialIndexExplain).toContain(
      "generated_world_mobs_unclaimed_combat_profile_idx"
    );
    const matrix = [];
    for (const configuration of [
      {
        name: "current",
        inflightResultReuseEnabled: false,
        profileClaimNoopFastPathEnabled: false
      },
      {
        name: "inflight-reuse-only",
        inflightResultReuseEnabled: true,
        profileClaimNoopFastPathEnabled: false
      },
      {
        name: "profile-noop-only",
        inflightResultReuseEnabled: false,
        profileClaimNoopFastPathEnabled: true
      },
      {
        name: "both-fast-paths",
        inflightResultReuseEnabled: true,
        profileClaimNoopFastPathEnabled: true
      }
    ] as const) {
      matrix.push({
        ...configuration,
        result: await measureTravelFlight({
          pool,
          zoneIds,
          destinationZoneIds,
          runtimeSha,
          worldEnvironmentIdentityKey,
          worldPipelineSha,
          inflightResultReuseEnabled:
            configuration.inflightResultReuseEnabled,
          profileClaimNoopFastPathEnabled:
            configuration.profileClaimNoopFastPathEnabled,
          repeatHops: true
        })
      });
    }
    const before = matrix[0]!.result;
    const inflightOnly = matrix[1]!.result;
    const profileOnly = matrix[2]!.result;
    const after = matrix[3]!.result;

    expect(before.initialFlightActivationCalls).toBe(2);
    expect(inflightOnly.initialFlightActivationCalls).toBe(2);
    expect(profileOnly.initialFlightActivationCalls).toBe(2);
    expect(after.initialFlightActivationCalls).toBe(2);
    const [durableActivation, simulationActivation] =
      after.initialActivationDiagnostics;
    expect(after.initialActivationDiagnostics).toHaveLength(2);
    expect(durableActivation).toMatchObject({
      call: 1,
      sourceId: after.sourceId,
      lifecycleStage: "DURABLE_READY",
      targetStages: ["DURABLE_READY"],
      activateRuntime: false,
      challengeProfileZoneIds: [],
      actorSpawns: 0
    });
    expect(simulationActivation).toMatchObject({
      call: 2,
      sourceId: after.sourceId,
      lifecycleStage: "SIMULATION_READY",
      targetStages: ["SIMULATION_READY"],
      activateRuntime: true
    });
    expect(
      simulationActivation?.challengeProfileZoneIds
    ).toEqual(simulationActivation?.zoneIds);
    expect(durableActivation?.zoneIds).toEqual(
      simulationActivation?.zoneIds
    );
    expect((durableActivation?.zoneIds as unknown[]).length)
      .toBeGreaterThan(0);
    expect(durableActivation?.durableEntityQueries).toBeGreaterThan(0);
    expect(simulationActivation?.durableEntityQueries).toBeGreaterThan(0);
    expect(simulationActivation?.actorSpawns).toBeGreaterThan(0);
    expect(new Set(after.initialActivationDiagnostics.map(
      (diagnostic) => diagnostic.sourceId
    ))).toEqual(new Set([after.sourceId]));
    // These are two intentional stages on one authority, not a lost
    // one-flight reuse: durable discovery performs no materialization,
    // profile claim, or actor work. Promotion retains the fingerprints,
    // claims the profile once per zone, and is the only actor-spawning call.
    expect(durableActivation?.generationMaterializationCount).toBe(0);
    expect(simulationActivation?.generationMaterializationCount).toBe(0);
    expect(durableActivation?.profileClaimCount).toBe(0);
    expect(simulationActivation?.profileClaimCount).toBe(
      (simulationActivation?.zoneIds as unknown[]).length
    );
    expect(durableActivation?.authorities).toEqual(
      simulationActivation?.authorities
    );
    expect(before.initialProfileForUpdateQueries).toBeGreaterThan(0);
    expect(inflightOnly.initialProfileForUpdateQueries).toBeGreaterThan(0);
    expect(profileOnly.initialProfileForUpdateQueries).toBe(0);
    expect(after.initialProfileForUpdateQueries).toBe(0);
    expect(after.adoptionResult).toBe("adopted");
    expect(after.warningCount).toBe(0);
    expect(after.finalSnapshot).toMatchObject({
      activationRequests: 0,
      activationWaiters: 0
    });
    expect(after.repeatedHopLatencyMs).toHaveLength(100);
    expect(before.repeatedHopLatencyMs).toHaveLength(100);
    expect(after.dormantReactivationLatencyMs).toHaveLength(20);
    expect(before.dormantReactivationLatencyMs).toHaveLength(20);
    expect(after.residentActorReuseHops).toBe(100);
    expect(after.actorSpawnsBeforeDormant)
      .toBe(after.actorSpawnsBeforeRepeatedHops);
    expect(after.dormantActorSpawns).toBeGreaterThan(0);
    console.info("population-travel-hot-path-benchmark", JSON.stringify({
      profileNoopExplain,
      profilePartialIndexExplain,
      readyEntitiesExplain,
      matrix
    }));
    console.info("population-travel-hot-path-summary", JSON.stringify(
      matrix.map(({ name, result }) => ({
        name,
        initialQueryCount: result.initialQueryCount,
        initialPostgresMs: result.initialPostgresMs,
        initialProfileClaimMs: result.initialProfileClaimMs,
        initialDurableLoadMs: result.initialDurableLoadMs,
        initialActorMs: result.initialActorMs,
        initialBackendActivationMs: result.initialBackendActivationMs,
        visibleReadyDurationMs: result.visibleReadyDurationMs,
        totalTransitionDurationMs: result.totalTransitionDurationMs,
        repeatedHopP50Ms: result.repeatedHopP50Ms,
        repeatedHopP95Ms: result.repeatedHopP95Ms,
        repeatedHopP99Ms: result.repeatedHopP99Ms,
        dormantP50Ms: result.dormantP50Ms,
        dormantP95Ms: result.dormantP95Ms,
        dormantP99Ms: result.dormantP99Ms,
        dormantQueryCount: result.dormantQueryCount,
        dormantPostgresMs: result.dormantPostgresMs,
        dormantProfileClaimMs: result.dormantProfileClaimMs,
        dormantDurableLoadMs: result.dormantDurableLoadMs,
        dormantActorMs: result.dormantActorMs,
        dormantBackendActivationMs: result.dormantBackendActivationMs,
        dormantActivationQueueWaitP50Ms:
          result.dormantActivationQueueWaitP50Ms,
        dormantActivationQueueWaitP95Ms:
          result.dormantActivationQueueWaitP95Ms,
        dormantActivationQueueWaitP99Ms:
          result.dormantActivationQueueWaitP99Ms
      }))
    ));
  }, 120_000);

  it("measures cold direct population barriers under the fast-path matrix", async () => {
    const coldMatrix = [];
    for (const configuration of [
      {
        name: "current",
        inflightResultReuseEnabled: false,
        profileClaimNoopFastPathEnabled: false
      },
      {
        name: "inflight-reuse-only",
        inflightResultReuseEnabled: true,
        profileClaimNoopFastPathEnabled: false
      },
      {
        name: "profile-noop-only",
        inflightResultReuseEnabled: false,
        profileClaimNoopFastPathEnabled: true
      },
      {
        name: "both-fast-paths",
        inflightResultReuseEnabled: true,
        profileClaimNoopFastPathEnabled: true
      }
    ] as const) {
      const samples = [];
      for (let sample = 0; sample < 20; sample += 1) {
        samples.push(await measureTravelFlight({
          pool,
          zoneIds,
          destinationZoneIds,
          runtimeSha,
          worldEnvironmentIdentityKey,
          worldPipelineSha,
          inflightResultReuseEnabled:
            configuration.inflightResultReuseEnabled,
          profileClaimNoopFastPathEnabled:
            configuration.profileClaimNoopFastPathEnabled,
          repeatHops: false
        }));
      }
      coldMatrix.push({
        name: configuration.name,
        result: summarizeColdTravelSamples(samples)
      });
    }
    expect(coldMatrix).toHaveLength(4);
    expect(coldMatrix.every(({ result }) => result.sampleCount === 20))
      .toBe(true);
    console.info("population-travel-cold-matrix", JSON.stringify(coldMatrix));
  }, 120_000);

  it("captures Resource Vision PostgreSQL plans and canonical filtering", async () => {
    const vision: ResourceVision = {
      flagId: "11111111-1111-4111-8111-111111111111",
      flagName: "Benchmark Flag",
      center: populationZoneV2Geometry(destinationZoneIds[0]).center,
      movementLeashRadiusM: 900,
      paddingM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M - 900,
      radiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
    };
    const repeatable = new RepeatableResourceService(pool);
    const collectibles = new CollectibleService(
      pool,
      {} as never,
      {} as never,
      { info: vi.fn(), warn: vi.fn() }
    );
    const serviceQueries = [
      await captureAndExplainQuery(
        pool,
        "repeatableResources.listInVision",
        (capturedPool) => new RepeatableResourceService(capturedPool)
          .listInVision("benchmark", vision, "benchmark-player")
      ),
      await captureAndExplainQuery(
        pool,
        "collectibles.listAvailableInVision",
        (capturedPool) => new CollectibleService(
          capturedPool,
          {} as never,
          {} as never,
          { info: vi.fn(), warn: vi.fn() }
        ).listAvailableInVision("benchmark", vision)
      ),
      await captureAndExplainQuery(
        pool,
        "Resource Vision status lookup",
        (capturedPool) => new CollectibleService(
          capturedPool,
          {} as never,
          {} as never,
          { info: vi.fn(), warn: vi.fn() }
        ).resourceVisionStatus(vision.flagId)
      )
    ];
    const [repeatableNodes, trees] = await Promise.all([
      repeatable.listInVision("benchmark", vision, "benchmark-player"),
      collectibles.listAvailableInVision("benchmark", vision)
    ]);
    expect(new Set(repeatableNodes.map((node) => node.id)).size)
      .toBe(repeatableNodes.length);
    expect(new Set(trees.map((tree) => tree.id)).size).toBe(trees.length);
    for (const query of serviceQueries) {
      expect(query.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(query.planRows).toBeGreaterThanOrEqual(0);
    }
    console.info("flag-resource-sql-benchmark", JSON.stringify({
      repeatableNodeCount: repeatableNodes.length,
      collectibleTreeCount: trees.length,
      serviceQueries
    }));
  }, 30_000);

  it("compares concurrent and visible-first cold build preparation", async () => {
    const concurrent = [];
    const visibleFirst = [];
    for (let sample = 0; sample < 20; sample += 1) {
      concurrent.push(await measureBuildPreparationSample({
        pool,
        destinationZoneId: destinationZoneIds[0],
        runtimeSha,
        worldEnvironmentIdentityKey,
        worldPipelineSha,
        strategy: "concurrent",
        sample
      }));
      visibleFirst.push(await measureBuildPreparationSample({
        pool,
        destinationZoneId: destinationZoneIds[0],
        runtimeSha,
        worldEnvironmentIdentityKey,
        worldPipelineSha,
        strategy: "visible-first",
        sample
      }));
    }
    expect(concurrent).toHaveLength(20);
    expect(visibleFirst).toHaveLength(20);
    expect(concurrent.every((sample) => sample.visibleReady)).toBe(true);
    expect(visibleFirst.every((sample) => sample.visibleReady)).toBe(true);
    console.info("flag-build-preparation-benchmark", JSON.stringify({
      concurrent: summarizeBuildSamples(concurrent),
      visibleFirst: summarizeBuildSamples(visibleFirst)
    }));
  }, 120_000);
});

type QueryMetrics = {
  count: number;
  totalMs: number;
  generationQueries: number;
  generationMs: number;
  durableEntityQueries: number;
  durableEntityMs: number;
  profileQueries: number;
  profileMs: number;
  profileForUpdateQueries: number;
  leaseQueries: number;
  leaseMs: number;
};

async function measureTravelFlight(input: Readonly<{
  pool: pg.Pool;
  zoneIds: readonly PopulationZoneV2Id[];
  destinationZoneIds: readonly [PopulationZoneV2Id, PopulationZoneV2Id];
  runtimeSha: string;
  worldEnvironmentIdentityKey: string;
  worldPipelineSha: string;
  inflightResultReuseEnabled: boolean;
  profileClaimNoopFastPathEnabled: boolean;
  repeatHops: boolean;
}>) {
  const queryMetrics: QueryMetrics = {
    count: 0,
    totalMs: 0,
    generationQueries: 0,
    generationMs: 0,
    durableEntityQueries: 0,
    durableEntityMs: 0,
    profileQueries: 0,
    profileMs: 0,
    profileForUpdateQueries: 0,
    leaseQueries: 0,
    leaseMs: 0
  };
  const componentTimings = {
    profileClaimMs: 0,
    durableLoadMs: 0,
    actorMs: 0,
    backendActivationMs: 0
  };
  let profileClaimCalls = 0;
  const baseStore = new PostgresPopulationZonesV2Store(
    measuredPool(input.pool, queryMetrics),
    undefined,
    undefined,
    {
      profileClaimNoopFastPathEnabled:
        input.profileClaimNoopFastPathEnabled
    }
  );
  const store = new Proxy(baseStore, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "claimMobCombatProfilesForZones") {
        return async (...args: unknown[]) => {
          profileClaimCalls += 1;
          const startedAt = performance.now();
          try {
            return await (
              value as (...input: unknown[]) => Promise<unknown>
            ).apply(target, args);
          } finally {
            componentTimings.profileClaimMs += performance.now() - startedAt;
          }
        };
      }
      if (property === "loadReadyEntitiesForZones") {
        return async (...args: unknown[]) => {
          const startedAt = performance.now();
          try {
            return await (
              value as (...input: unknown[]) => Promise<unknown>
            ).apply(target, args);
          } finally {
            componentTimings.durableLoadMs += performance.now() - startedAt;
          }
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const planner = {
    scheduleZones: vi.fn(async (
      request: { zoneIds: readonly PopulationZoneV2Id[] }
    ) => ({
      disabled: false,
      readyZoneIds: request.zoneIds,
      pendingZoneIds: []
    })),
    scheduleZonesAndWait: vi.fn(async (
      request: { zoneIds: readonly PopulationZoneV2Id[] }
    ) => ({
      disabled: false,
      readyZoneIds: request.zoneIds,
      pendingZoneIds: []
    }))
  };
  const activeActors = new Set<string>();
  let actorSpawns = 0;
  let actorReuse = 0;
  const combat = {
    spawnMob: vi.fn((descriptor: { entityId: string }) => {
      const startedAt = performance.now();
      if (activeActors.has(descriptor.entityId)) actorReuse += 1;
      else {
        activeActors.add(descriptor.entityId);
        actorSpawns += 1;
      }
      componentTimings.actorMs += performance.now() - startedAt;
      return descriptor as never;
    }),
    despawnMob: vi.fn((entityId: string) => activeActors.delete(entityId)),
    despawnPopulationManagedMob: vi.fn(() => false),
    rebindPopulationAuthority: vi.fn((entityId: string) => {
      const startedAt = performance.now();
      if (activeActors.has(entityId)) actorReuse += 1;
      const rebound = activeActors.has(entityId);
      componentTimings.actorMs += performance.now() - startedAt;
      return rebound;
    })
  };
  const backend = new PopulationZonesV2Backend(
    store,
    planner as never,
    combat as never,
    {
      regionCode: populationZoneV2CanonicalRegionCode(
        input.destinationZoneIds[0]
      ),
      runtimeSha: input.runtimeSha,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
      worldPipelineSha: input.worldPipelineSha
    }
  );
  const firstFlight = deferred<void>();
  let activationCalls = 0;
  let activationRequestedAt: number | null = null;
  const activationQueueWaitMs: number[] = [];
  let currentTravelSourceId: string | null = null;
  let currentTravelStage: string | null = null;
  const initialActivationDiagnostics: Array<Record<string, unknown>> = [];
  const measuredBackend: PopulationZonesV2RuntimeBackend = {
    updateZoneReferences: (request) => backend.updateZoneReferences(request),
    activateZones: async (request) => {
      activationCalls += 1;
      const call = activationCalls;
      const queriesBefore = { ...queryMetrics };
      const actorSpawnsBefore = actorSpawns;
      const profileClaimCallsBefore = profileClaimCalls;
      const generationsCreatedBefore = backend.snapshot().generationsCreated;
      if (activationRequestedAt !== null) {
        activationQueueWaitMs.push(performance.now() - activationRequestedAt);
        activationRequestedAt = null;
      }
      if (activationCalls === 1) await firstFlight.promise;
      const startedAt = performance.now();
      try {
        const activations = await backend.activateZones(request);
        if (call <= 2) {
          initialActivationDiagnostics.push({
            call,
            sourceId: currentTravelSourceId,
            lifecycleStage: currentTravelStage,
            targetStages: [...new Set(Object.values(
              request.targetStageByZone ?? {}
            ))].sort(),
            zoneIds: [...request.zoneIds],
            activateRuntime: request.activateRuntime ?? true,
            challengeProfileZoneIds: Object.keys(
              request.challengeProfilesByZone ?? {}
            ).sort(),
            materialization: activations.map((activation) => ({
              zoneId: activation.zoneId,
              generationId: activation.generationId,
              status: activation.materializationStatus,
              completedStage: activation.completedStage ?? null
            })),
            generationMaterializationCount:
              backend.snapshot().generationsCreated
              - generationsCreatedBefore,
            durableEntityQueries:
              queryMetrics.durableEntityQueries
              - queriesBefore.durableEntityQueries,
            generationQueries:
              queryMetrics.generationQueries - queriesBefore.generationQueries,
            profileQueries:
              queryMetrics.profileQueries - queriesBefore.profileQueries,
            profileForUpdateQueries:
              queryMetrics.profileForUpdateQueries
              - queriesBefore.profileForUpdateQueries,
            profileClaimCount: profileClaimCalls - profileClaimCallsBefore,
            actorSpawns: actorSpawns - actorSpawnsBefore,
            authorities: activations.map((activation) => ({
              zoneId: activation.zoneId,
              authority: activation.authority ?? null
            }))
          });
        }
        return activations;
      } finally {
        componentTimings.backendActivationMs +=
          performance.now() - startedAt;
      }
    },
    sleepZones: (request) => backend.sleepZones(request)
  };
  const runtime = new PopulationZonesV2Runtime(measuredBackend, {
    inflightResultReuseEnabled: input.inflightResultReuseEnabled,
    sleepGraceMs: 100
  });
  const orchestrator = new PopulationAreaOrchestrator(runtime);
  const firstArea = benchmarkArea(input.destinationZoneIds[0], "flag-a", 1);
  const secondArea = benchmarkArea(input.destinationZoneIds[1], "flag-b", 2);
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const rssBaselineBytes = process.memoryUsage().rss;
  const transitionStartedAt = performance.now();
  const prepareAdmissionStartedAt = performance.now();
  const lifecycleEvents: PopulationTravelLifecycleEvent[] = [];
  const reservation = reservePopulationTravelArea({
    hooks: orchestrator,
    area: firstArea,
    kind: "city-travel",
    playerId: "benchmark-player",
    connectionId: "benchmark-connection",
    connectionGeneration: 1,
    travelId: "benchmark-travel",
    expectedRelocationRevision: 1,
    expectedResourceVisionRevision: 1,
    expectedGameplayViewGeneration: 1,
    lifecycle: (event) => {
      lifecycleEvents.push(event);
      currentTravelSourceId = event.sourceId;
      if (event.stage) currentTravelStage = event.stage;
    }
  });
  const prepareAcknowledgementDurationMs =
    performance.now() - prepareAdmissionStartedAt;
  const rssAfterPrepareAdmissionBytes = process.memoryUsage().rss;
  await vi.waitFor(() => expect(activationCalls).toBe(1));
  firstFlight.resolve();
  const preparation = await reservation.preparation;
  const durablePreparationDurationMs =
    performance.now() - prepareAdmissionStartedAt;
  expect(preparation.status).toBe("ready");
  const promotionStartedAt = performance.now();
  const simulationPreparation = await reservation.promote(
    BENCHMARK_CHALLENGE_PROFILE
  );
  const simulationPreparationDurationMs =
    performance.now() - promotionStartedAt;
  expect(simulationPreparation.status).toBe("ready");
  const relocationStartedAt = performance.now();
  const relocation = runtime.startRelocation({
    playerId: "benchmark-player",
    connectionId: "benchmark-connection",
    connectionGeneration: 1,
    area: firstArea,
    relocationRevision: 1,
    resourceVisionRevision: 1,
    challengeProfile: BENCHMARK_CHALLENGE_PROFILE,
    trigger: "flag-travel"
  });
  const adoptionResult = reservation.adopt({
    relocationRevision: 1,
    resourceVisionRevision: 1,
    gameplayViewGeneration: 1,
    area: firstArea
  });
  const visible = await relocation.visibleReady;
  await relocation.completion;
  const initialFlightActivationCalls = activationCalls;
  const visibleReadyDurationMs = performance.now() - relocationStartedAt;
  const totalTransitionDurationMs = performance.now() - transitionStartedAt;
  const rssPeakBytes = Math.max(
    rssBaselineBytes,
    rssAfterPrepareAdmissionBytes,
    process.memoryUsage().rss
  );
  const initialQueryMetrics = { ...queryMetrics };
  const initialComponentTimings = { ...componentTimings };
  expect(orchestrator.releaseSource(
    "player-visible:benchmark-player:1:1:benchmark-travel"
  )).toBe(true);

  const repeatedHopLatencyMs: number[] = [];
  const dormantReactivationLatencyMs: number[] = [];
  let actorSpawnsBeforeRepeatedHops = actorSpawns;
  let actorSpawnsBeforeDormant = actorSpawns;
  let dormantQueryCount = 0;
  let dormantPostgresMs = 0;
  let dormantProfileClaimMs = 0;
  let dormantDurableLoadMs = 0;
  let dormantActorMs = 0;
  let dormantBackendActivationMs = 0;
  let dormantActivationQueueSampleStart = 0;
  let residentActorReuseHops = 0;
  if (input.repeatHops) {
    const simultaneousBefore = activationCalls;
    const simultaneous = [2, 3].map((generation) => runtime.startRelocation({
      playerId: `benchmark-player-${generation}`,
      connectionId: `benchmark-connection-${generation}`,
      connectionGeneration: 1,
      area: secondArea,
      relocationRevision: 1,
      resourceVisionRevision: 1,
      challengeProfile: BENCHMARK_CHALLENGE_PROFILE,
      trigger: "flag-travel"
    }));
    await Promise.all(simultaneous.map((handle) => handle.visibleReady));
    await Promise.all(simultaneous.map((handle) => handle.completion));
    expect(activationCalls - simultaneousBefore).toBe(1);
    runtime.releaseConnection("benchmark-connection-2", 1);
    runtime.releaseConnection("benchmark-connection-3", 1);
    actorSpawnsBeforeRepeatedHops = actorSpawns;

    for (let hop = 0; hop < 100; hop += 1) {
      const startedAt = performance.now();
      const callsBeforeHop = activationCalls;
      const area = hop % 2 === 0 ? secondArea : firstArea;
      const handle = runtime.startRelocation({
        playerId: "benchmark-player",
        connectionId: "benchmark-connection",
        connectionGeneration: 1,
        area,
        relocationRevision: hop + 2,
        resourceVisionRevision: hop + 2,
        challengeProfile: BENCHMARK_CHALLENGE_PROFILE,
        trigger: "flag-travel"
      });
      await handle.visibleReady;
      await handle.completion;
      if (activationCalls === callsBeforeHop) residentActorReuseHops += 1;
      repeatedHopLatencyMs.push(performance.now() - startedAt);
    }
    actorSpawnsBeforeDormant = actorSpawns;
    runtime.releaseConnection("benchmark-connection", 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const dormantQueryStart = { ...queryMetrics };
    const dormantComponentStart = { ...componentTimings };
    dormantActivationQueueSampleStart = activationQueueWaitMs.length;
    for (let sample = 0; sample < 20; sample += 1) {
      activationRequestedAt = performance.now();
      const startedAt = performance.now();
      const handle = runtime.startRelocation({
        playerId: "benchmark-player",
        connectionId: "benchmark-connection",
        connectionGeneration: sample + 2,
        area: firstArea,
        relocationRevision: sample + 102,
        resourceVisionRevision: sample + 102,
        challengeProfile: BENCHMARK_CHALLENGE_PROFILE,
        trigger: "flag-travel"
      });
      await handle.visibleReady;
      await handle.completion;
      dormantReactivationLatencyMs.push(performance.now() - startedAt);
      runtime.releaseConnection("benchmark-connection", sample + 2);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    dormantQueryCount = queryMetrics.count - dormantQueryStart.count;
    dormantPostgresMs = queryMetrics.totalMs - dormantQueryStart.totalMs;
    dormantProfileClaimMs =
      componentTimings.profileClaimMs - dormantComponentStart.profileClaimMs;
    dormantDurableLoadMs =
      componentTimings.durableLoadMs - dormantComponentStart.durableLoadMs;
    dormantActorMs =
      componentTimings.actorMs - dormantComponentStart.actorMs;
    dormantBackendActivationMs =
      componentTimings.backendActivationMs -
      dormantComponentStart.backendActivationMs;
  }
  eventLoop.disable();
  const finalSnapshot = runtime.snapshot();
  const rssRecoveredBytes = process.memoryUsage().rss;
  const sortedLatencies = [...repeatedHopLatencyMs].sort((a, b) => a - b);
  const sortedDormantLatencies =
    [...dormantReactivationLatencyMs].sort((a, b) => a - b);
  const dormantActivationQueueWaitMs = activationQueueWaitMs
    .slice(dormantActivationQueueSampleStart)
    .sort((a, b) => a - b);
  const result = {
    activationCalls,
    initialFlightActivationCalls,
    initialActivationDiagnostics,
    initialQueryCount: initialQueryMetrics.count,
    initialPostgresMs: round(initialQueryMetrics.totalMs),
    initialGenerationQueries: initialQueryMetrics.generationQueries,
    initialGenerationMs: round(initialQueryMetrics.generationMs),
    initialDurableEntityQueries: initialQueryMetrics.durableEntityQueries,
    initialDurableEntityMs: round(initialQueryMetrics.durableEntityMs),
    initialProfileQueries: initialQueryMetrics.profileQueries,
    initialProfileMs: round(initialQueryMetrics.profileMs),
    initialProfileForUpdateQueries:
      initialQueryMetrics.profileForUpdateQueries,
    initialLeaseQueries: initialQueryMetrics.leaseQueries,
    initialLeaseMs: round(initialQueryMetrics.leaseMs),
    initialProfileClaimMs: round(initialComponentTimings.profileClaimMs),
    initialDurableLoadMs: round(initialComponentTimings.durableLoadMs),
    initialActorMs: round(initialComponentTimings.actorMs),
    initialBackendActivationMs:
      round(initialComponentTimings.backendActivationMs),
    queryCount: queryMetrics.count,
    postgresMs: round(queryMetrics.totalMs),
    generationQueries: queryMetrics.generationQueries,
    durableEntityQueries: queryMetrics.durableEntityQueries,
    profileQueries: queryMetrics.profileQueries,
    profileForUpdateQueries: queryMetrics.profileForUpdateQueries,
    actorSpawns,
    actorSpawnsBeforeRepeatedHops,
    actorSpawnsBeforeDormant,
    dormantActorSpawns: actorSpawns - actorSpawnsBeforeDormant,
    actorReuse,
    componentTimings: {
      profileClaimMs: round(componentTimings.profileClaimMs),
      durableLoadMs: round(componentTimings.durableLoadMs),
      actorMs: round(componentTimings.actorMs),
      backendActivationMs: round(componentTimings.backendActivationMs)
    },
    residentActorReuseHops,
    activeActorCount: activeActors.size,
    adoptionResult,
    sourceId: reservation.sourceId,
    authorityToken: reservation.authorityToken,
    sourceOrigin: "committed-created",
    capturedProfileLevel: BENCHMARK_CHALLENGE_PROFILE.currentGearLevel,
    capturedProfileFingerprint: [
      BENCHMARK_CHALLENGE_PROFILE.balanceVersion,
      BENCHMARK_CHALLENGE_PROFILE.currentGearLevel,
      BENCHMARK_CHALLENGE_PROFILE.unlockedGearLevel,
      BENCHMARK_CHALLENGE_PROFILE.tier
    ].join(":"),
    durableAttemptCount: lifecycleEvents.filter((event) =>
      event.event === "stage-attempt"
      && event.stage === "DURABLE_READY"
    ).length,
    simulationAttemptCount: lifecycleEvents.filter((event) =>
      event.event === "stage-attempt"
      && event.stage === "SIMULATION_READY"
    ).length,
    retryReasons: lifecycleEvents.flatMap((event) =>
      event.event === "stage-result" && event.disposition === "retryable"
        ? event.reasons ?? []
        : []
    ),
    releaseCount: lifecycleEvents.filter((event) =>
      event.event === "release" && event.disposition === "released"
    ).length,
    releaseReason: "adopted",
    durablePreparationDurationMs: round(durablePreparationDurationMs),
    simulationPreparationDurationMs: round(
      simulationPreparationDurationMs
    ),
    visibleStatus: visible.status,
    prepareAcknowledgementDurationMs: round(
      prepareAcknowledgementDurationMs
    ),
    visibleReadyDurationMs: round(visibleReadyDurationMs),
    relocationTransactionDurationMs: null,
    totalTransitionDurationMs: round(totalTransitionDurationMs),
    eventLoopDelayP50Ms: round(eventLoop.percentile(50) / 1_000_000),
    eventLoopDelayP95Ms: round(eventLoop.percentile(95) / 1_000_000),
    eventLoopDelayP99Ms: round(eventLoop.percentile(99) / 1_000_000),
    eventLoopDelayMaxMs: round(eventLoop.max / 1_000_000),
    rssBaselineBytes,
    rssPeakBytes,
    rssRecoveredBytes,
    postgresLockWaits: null,
    warningCount: 0,
    repeatedHopLatencyMs: repeatedHopLatencyMs.map(round),
    repeatedHopP50Ms: percentile(sortedLatencies, 0.5),
    repeatedHopP95Ms: percentile(sortedLatencies, 0.95),
    repeatedHopP99Ms: percentile(sortedLatencies, 0.99),
    repeatedHopMaxMs: round(sortedLatencies.at(-1) ?? 0),
    dormantReactivationLatencyMs:
      dormantReactivationLatencyMs.map(round),
    dormantP50Ms: percentile(sortedDormantLatencies, 0.5),
    dormantP95Ms: percentile(sortedDormantLatencies, 0.95),
    dormantP99Ms: percentile(sortedDormantLatencies, 0.99),
    dormantQueryCount,
    dormantPostgresMs: round(dormantPostgresMs),
    dormantProfileClaimMs: round(dormantProfileClaimMs),
    dormantDurableLoadMs: round(dormantDurableLoadMs),
    dormantActorMs: round(dormantActorMs),
    dormantBackendActivationMs: round(dormantBackendActivationMs),
    dormantActivationQueueWaitP50Ms:
      percentile(dormantActivationQueueWaitMs, 0.5),
    dormantActivationQueueWaitP95Ms:
      percentile(dormantActivationQueueWaitMs, 0.95),
    dormantActivationQueueWaitP99Ms:
      percentile(dormantActivationQueueWaitMs, 0.99),
    finalSnapshot: {
      referencedZones: finalSnapshot.referencedZones,
      simulationResidentZones: finalSnapshot.simulationResidentZones,
      activationRequests: finalSnapshot.activationRequests,
      activationWaiters: finalSnapshot.activationWaiters
    }
  };
  await runtime.close();
  await backend.close();
  return result;
}

async function measureBuildPreparationSample(input: Readonly<{
  pool: pg.Pool;
  destinationZoneId: PopulationZoneV2Id;
  runtimeSha: string;
  worldEnvironmentIdentityKey: string;
  worldPipelineSha: string;
  strategy: "concurrent" | "visible-first";
  sample: number;
}>) {
  const queryMetrics: QueryMetrics = {
    count: 0,
    totalMs: 0,
    generationQueries: 0,
    generationMs: 0,
    durableEntityQueries: 0,
    durableEntityMs: 0,
    profileQueries: 0,
    profileMs: 0,
    profileForUpdateQueries: 0,
    leaseQueries: 0,
    leaseMs: 0
  };
  const store = new PostgresPopulationZonesV2Store(
    measuredPool(input.pool, queryMetrics)
  );
  const planner = {
    scheduleZones: vi.fn(async (
      request: { zoneIds: readonly PopulationZoneV2Id[] }
    ) => ({
      disabled: false,
      readyZoneIds: request.zoneIds,
      pendingZoneIds: []
    })),
    scheduleZonesAndWait: vi.fn(async (
      request: { zoneIds: readonly PopulationZoneV2Id[] }
    ) => ({
      disabled: false,
      readyZoneIds: request.zoneIds,
      pendingZoneIds: []
    }))
  };
  const activeActors = new Set<string>();
  const backend = new PopulationZonesV2Backend(
    store,
    planner as never,
    {
      spawnMob: vi.fn((descriptor: { entityId: string }) => {
        activeActors.add(descriptor.entityId);
        return descriptor;
      }),
      despawnMob: vi.fn((entityId: string) => activeActors.delete(entityId)),
    despawnPopulationManagedMob: vi.fn(() => false),
      rebindPopulationAuthority: vi.fn((entityId: string) =>
        activeActors.has(entityId))
    } as never,
    {
      regionCode: populationZoneV2CanonicalRegionCode(
        input.destinationZoneId
      ),
      runtimeSha: input.runtimeSha,
      worldEnvironmentIdentityKey: input.worldEnvironmentIdentityKey,
      worldPipelineSha: input.worldPipelineSha
    }
  );
  let backendActivationMs = 0;
  const runtime = new PopulationZonesV2Runtime({
    updateZoneReferences: (request) => backend.updateZoneReferences(request),
    activateZones: async (request) => {
      const startedAt = performance.now();
      try {
        return await backend.activateZones(request);
      } finally {
        backendActivationMs += performance.now() - startedAt;
      }
    },
    sleepZones: (request) => backend.sleepZones(request)
  }, {
    inflightResultReuseEnabled: false,
    sleepGraceMs: 60_000
  });
  const orchestrator = new PopulationAreaOrchestrator(runtime);
  const area = benchmarkArea(
    input.destinationZoneId,
    `build-${input.strategy}-${input.sample}`,
    input.sample + 1
  );
  const source = (
    suffix: string,
    targetStage: "DURABLE_READY" | "SIMULATION_READY",
    priority: 0 | 2
  ) => ({
    sourceId: `build:${input.strategy}:${input.sample}:${suffix}`,
    kind: "flag-build" as const,
    targetStage,
    priority,
    createdAtMs: Date.now(),
    playerId: "benchmark-builder",
    connectionId: "benchmark-build-connection",
    connectionGeneration: 1,
    buildId: `benchmark-build-${input.strategy}-${input.sample}`,
    expiresAtMs: Date.now() + 120_000,
    authorityToken: `authority:${input.strategy}:${input.sample}:${suffix}`,
    ...(targetStage === "SIMULATION_READY"
      ? { challengeProfile: BENCHMARK_CHALLENGE_PROFILE }
      : {})
  });
  const startedAt = performance.now();
  const visiblePromise = orchestrator.prepareArea({
    area,
    source: source("visible", "SIMULATION_READY", 0)
  });
  let envelopePromise: ReturnType<PopulationAreaOrchestrator["prepareArea"]>;
  if (input.strategy === "concurrent") {
    envelopePromise = orchestrator.prepareArea({
      area,
      source: source("envelope", "DURABLE_READY", 2)
    });
  } else {
    await visiblePromise;
    envelopePromise = orchestrator.prepareArea({
      area,
      source: source("envelope", "DURABLE_READY", 2)
    });
  }
  const visible = await visiblePromise;
  const visibleReadyMs = performance.now() - startedAt;
  const envelope = await envelopePromise;
  const totalMs = performance.now() - startedAt;
  orchestrator.releaseSource(visible.sourceId);
  orchestrator.releaseSource(envelope.sourceId);
  const snapshot = runtime.snapshot();
  await runtime.close();
  await backend.close();
  return {
    visibleReady: visible.outcomes.every((outcome) =>
      outcome.status === "ready"
    ),
    envelopeReady: envelope.outcomes.every((outcome) =>
      outcome.status === "ready"
    ),
    visibleReadyMs: round(visibleReadyMs),
    totalMs: round(totalMs),
    postgresQueryCount: queryMetrics.count,
    postgresMs: round(queryMetrics.totalMs),
    backendActivationMs: round(backendActivationMs),
    actorCount: activeActors.size,
    finalReferences: snapshot.streamingSourceLeases
  };
}

function summarizeBuildSamples(samples: readonly Awaited<
  ReturnType<typeof measureBuildPreparationSample>
>[]) {
  const summary = (values: readonly number[]) => ({
    p50: percentile([...values].sort((left, right) => left - right), 0.5),
    p95: percentile([...values].sort((left, right) => left - right), 0.95),
    p99: percentile([...values].sort((left, right) => left - right), 0.99)
  });
  return {
    sampleCount: samples.length,
    visibleReadyMs: summary(samples.map((sample) => sample.visibleReadyMs)),
    totalMs: summary(samples.map((sample) => sample.totalMs)),
    postgresQueryCount: summary(
      samples.map((sample) => sample.postgresQueryCount)
    ),
    postgresMs: summary(samples.map((sample) => sample.postgresMs)),
    backendActivationMs: summary(
      samples.map((sample) => sample.backendActivationMs)
    ),
    actorCount: summary(samples.map((sample) => sample.actorCount))
  };
}

function summarizeColdTravelSamples(samples: readonly Awaited<
  ReturnType<typeof measureTravelFlight>
>[]) {
  const summary = (values: readonly number[]) => ({
    p50: percentile([...values].sort((left, right) => left - right), 0.5),
    p95: percentile([...values].sort((left, right) => left - right), 0.95),
    p99: percentile([...values].sort((left, right) => left - right), 0.99)
  });
  return {
    sampleCount: samples.length,
    visibleReadyMs: summary(
      samples.map((sample) => sample.visibleReadyDurationMs)
    ),
    postgresQueryCount: summary(
      samples.map((sample) => sample.initialQueryCount)
    ),
    postgresMs: summary(samples.map((sample) => sample.initialPostgresMs)),
    profileClaimMs: summary(
      samples.map((sample) => sample.initialProfileClaimMs)
    ),
    durableLoadMs: summary(
      samples.map((sample) => sample.initialDurableLoadMs)
    ),
    actorMs: summary(samples.map((sample) => sample.initialActorMs)),
    backendActivationMs: summary(
      samples.map((sample) => sample.initialBackendActivationMs)
    )
  };
}

function benchmarkArea(
  zoneId: PopulationZoneV2Id,
  sourceId: string,
  generation: number
) {
  return {
    center: populationZoneV2Geometry(zoneId).center,
    certifiedVisibleRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
    preparedRadiusM:
      DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
      + DEFAULT_FLAG_PREPARE_BUFFER_M,
    sourceType: "flag" as const,
    sourceId,
    generation
  };
}

function measuredPool(pool: pg.Pool, metrics: QueryMetrics): pg.Pool {
  const classify = (query: string | { text?: string }) => {
    const sql = typeof query === "string" ? query : query.text ?? "";
    return {
      generation: sql.includes("population_zone_generations_v2"),
      durable:
      sql.includes("generated_world_mobs")
      || sql.includes("collectible_nodes")
      || sql.includes("repeatable_resource_nodes"),
      profile: sql.includes("combat_level IS NULL"),
      profileForUpdate:
      sql.includes("generated_world_mobs")
      && sql.includes("FOR UPDATE"),
      lease: sql.includes("population_runtime_leases_v2")
    };
  };
  const record = (
    categories: ReturnType<typeof classify>,
    durationMs: number
  ): void => {
    metrics.count += 1;
    metrics.totalMs += durationMs;
    if (categories.generation) {
      metrics.generationQueries += 1;
      metrics.generationMs += durationMs;
    }
    if (categories.durable) {
      metrics.durableEntityQueries += 1;
      metrics.durableEntityMs += durationMs;
    }
    if (categories.profile) {
      metrics.profileQueries += 1;
      metrics.profileMs += durationMs;
    }
    if (categories.profileForUpdate) metrics.profileForUpdateQueries += 1;
    if (categories.lease) {
      metrics.leaseQueries += 1;
      metrics.leaseMs += durationMs;
    }
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === "query") {
        return async (
          query: string | { text?: string },
          values?: readonly unknown[]
        ) => {
          const categories = classify(query);
          const startedAt = performance.now();
          try {
            return await target.query(query as never, values as never);
          } finally {
            record(categories, performance.now() - startedAt);
          }
        };
      }
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty !== "query") {
                const value = Reflect.get(
                  clientTarget,
                  clientProperty,
                  clientTarget
                ) as unknown;
                return typeof value === "function"
                  ? value.bind(clientTarget)
                  : value;
              }
              return async (
                query: string | { text?: string },
                values?: readonly unknown[]
              ) => {
                const categories = classify(query);
                const startedAt = performance.now();
                try {
                  return await clientTarget.query(
                    query as never,
                    values as never
                  );
                } finally {
                  record(categories, performance.now() - startedAt);
                }
              };
            }
          });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function captureAndExplainQuery(
  pool: pg.Pool,
  name: string,
  operation: (capturedPool: pg.Pool) => Promise<unknown>
) {
  let captured: {
    text: string;
    values: readonly unknown[];
  } | null = null;
  const capturedPool = new Proxy(pool, {
    get(target, property) {
      if (property === "query") {
        return async (
          query: string | { text?: string },
          values: readonly unknown[] = []
        ) => {
          const text = typeof query === "string" ? query : query.text ?? "";
          if (!captured && /^\s*SELECT\b/i.test(text)) {
            captured = { text, values };
          }
          return target.query(query as never, values as never);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  await operation(capturedPool);
  const capturedQuery = captured as {
    text: string;
    values: readonly unknown[];
  } | null;
  if (!capturedQuery) {
    throw new Error(`${name} did not issue a SELECT query`);
  }
  const startedAt = performance.now();
  const explained = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${capturedQuery.text}`,
    capturedQuery.values as never[]
  );
  const wallTimeMs = performance.now() - startedAt;
  const document = explained.rows[0]?.["QUERY PLAN"] as
    | Array<{
        Plan?: {
          "Actual Rows"?: number;
          "Shared Hit Blocks"?: number;
        };
        "Planning Time"?: number;
        "Execution Time"?: number;
      }>
    | undefined;
  const root = document?.[0];
  return {
    name,
    planningTimeMs: round(root?.["Planning Time"] ?? 0),
    executionTimeMs: round(root?.["Execution Time"] ?? 0),
    wallTimeMs: round(wallTimeMs),
    planRows: root?.Plan?.["Actual Rows"] ?? 0,
    sharedHitBlocks: root?.Plan?.["Shared Hit Blocks"] ?? 0,
    indexNames: collectPlanValues(document, "Index Name"),
    nodeTypes: collectPlanValues(document, "Node Type")
  };
}

function collectPlanValues(
  value: unknown,
  key: string,
  found = new Set<string>()
): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectPlanValues(entry, key, found);
  } else if (value && typeof value === "object") {
    for (const [property, child] of Object.entries(value)) {
      if (property === key && typeof child === "string") found.add(child);
      collectPlanValues(child, key, found);
    }
  }
  return [...found].sort();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  return round(values[Math.min(
    values.length - 1,
    Math.ceil(values.length * quantile) - 1
  )]!);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !parsed.pathname.replace(/^\/+/u, "")
      .startsWith("ash_atlas_stability")
  ) {
    throw new Error("benchmark requires a local disposable stability database");
  }
  return parsed;
}

function quoteIdentifier(identifier: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(identifier)) {
    throw new Error("unsafe benchmark database identifier");
  }
  return `"${identifier}"`;
}
