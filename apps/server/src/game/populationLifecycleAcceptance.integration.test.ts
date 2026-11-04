import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import {
  applyPopulationZoneDelta,
  emptyPopulationZoneProjection,
  type PopulationZoneDelta
} from "../../../client/src/population/populationZoneProjection.js";
import { runMigrations } from "../db/migrate.js";
import { PopulationRealtimeAdapter } from "../realtime/populationRealtimeAdapter.js";
import { PopulationAreaOrchestrator } from "./populationAreaOrchestrator.js";
import {
  POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION
} from "./populationZoneV3HabitatCompiler.js";
import {
  greatCircleDistanceMeters,
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle
} from "./populationZonesV2Geometry.js";
import {
  generatePopulationZonesV2Plans,
  populationZoneV3ConservativeHabitat
} from "./populationZonesV2Plan.js";
import {
  PopulationZonesV2Backend
} from "./populationZonesV2Backend.js";
import {
  populationZoneV2CanonicalRegionCode
} from "./populationZonesV2Planner.js";
import {
  PopulationZonesV2Runtime,
  type PopulationZonesV2RuntimeBackend
} from "./populationZonesV2Runtime.js";
import {
  populationZoneV2PlanRequest,
  PostgresPopulationZonesV2Store,
  type PopulationZoneV2ReadyEntity
} from "./populationZonesV2Store.js";

const adminUrl = process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("Population v2 cold lifecycle acceptance", () => {
  const databaseName =
    `ash_atlas_stability_population_acceptance_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    const parsed = assertStabilityAdminUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(parsed.toString());
    pool = new DisposableTestPool({ connectionString: parsed.toString(), max: 16 });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`
    );
    await admin?.end();
  });

  it("measures template through authoritative visible client replacement", async () => {
    const center = { lat: 35.0844, lon: -106.6504 };
    const visibleRadiusM = 650;
    const visibleZoneIds = populationZonesV2IntersectingCircle(
      center,
      visibleRadiusM
    );
    const worldEnvironmentIdentityKey = randomUUID()
      .replaceAll("-", "")
      .padEnd(64, "0")
      .slice(0, 64);
    const worldPipelineSha = "c".repeat(40);
    const runtimeSha = "d".repeat(40);
    const timings = {
      templatePreparationMs: 0,
      templatePersistenceMs: 0,
      generationCreationMs: 0,
      projectionStatePersistenceMs: 0,
      projectionReloadMs: 0,
      runtimeActivationMs: 0,
      clientAuthoritativeReplacementMs: 0,
      visibleReadinessCompletionMs: 0
    };

    let startedAt = performance.now();
    const plans = generatePopulationZonesV2Plans({
      outputZoneIds: visibleZoneIds,
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
    timings.templatePreparationMs = performance.now() - startedAt;

    const store = new PostgresPopulationZonesV2Store(pool);
    startedAt = performance.now();
    for (const plan of plans) {
      const zoneId = plan.identity.zoneId as typeof visibleZoneIds[number];
      const request = populationZoneV2PlanRequest({
        zoneId,
        worldEnvironmentIdentityKey,
        worldPipelineSha,
        environmentProfileVersion:
          POPULATION_V3_COMPACT_ENVIRONMENT_CONTRACT_VERSION,
        regionCode: populationZoneV2CanonicalRegionCode(zoneId)
      });
      await store.ensurePlanForZone(request);
      const claim = await store.claimPlan(request.identity, randomUUID(), 30_000);
      if (claim === null) {
        throw new Error(`cold lifecycle could not claim ${zoneId}`);
      }
      await store.completePlan(claim, plan);
    }
    timings.templatePersistenceMs = performance.now() - startedAt;

    const projectionTiming = { milliseconds: 0 };
    const timedStore = new PostgresPopulationZonesV2Store(
      projectionTimedPool(pool, projectionTiming)
    );
    startedAt = performance.now();
    const generations = [];
    for (const plan of plans) {
      generations.push(await timedStore.createCurrentGeneration({
        zoneId: plan.identity.zoneId,
        planId: plan.planId,
        now: new Date()
      }));
    }
    const generationAndProjectionMs = performance.now() - startedAt;
    timings.projectionStatePersistenceMs = projectionTiming.milliseconds;
    timings.generationCreationMs = Math.max(
      0,
      generationAndProjectionMs - projectionTiming.milliseconds
    );

    startedAt = performance.now();
    const persistedEntities = await store.loadReadyEntitiesForZones(
      visibleZoneIds
    );
    timings.projectionReloadMs = performance.now() - startedAt;
    expect(generations.every((generation) => generation.created)).toBe(true);
    expect(persistedEntities.length).toBeGreaterThan(0);
    expect(new Set(persistedEntities.map((entity) => entity.zoneId)).size)
      .toBeGreaterThan(1);
    const boundaryViolations = adjacentBoundaryViolations(persistedEntities);
    expect(boundaryViolations).toEqual({
      treeTree: 0,
      stoneTree: 0
    });

    // Encounter origins use ranked soft spacing. The authored pack formations
    // still require complete membership and separated bodies around one anchor.
    const formations = {
      deer: { counts: [1, 2, 3], minRadius: 30, maxRadius: 45, separation: 25 },
      wolf: { counts: [2, 3], minRadius: 46, maxRadius: 50, separation: 55 },
      sap_crawler: { counts: [3, 4], minRadius: 18, maxRadius: 30, separation: 15 }
    };
    const packs = new Map<string, PopulationZoneV2ReadyEntity[]>();
    for (const entity of persistedEntities) {
      if (entity.packId === null) continue;
      const members = packs.get(entity.packId) ?? [];
      members.push(entity);
      packs.set(entity.packId, members);
    }
    expect(packs.size).toBeGreaterThan(0);
    for (const members of packs.values()) {
      const first = members[0]!;
      const formation = formations[first.entityKind as keyof typeof formations];
      expect(formation).toBeDefined();
      expect(formation.counts).toContain(members.length);
      expect(members.map((member) => member.packMemberIndex).sort())
        .toEqual(Array.from({ length: members.length }, (_, index) => index));
      expect(new Set(members.map((member) => member.encounterId)).size).toBe(1);
      for (const member of members) {
        expect(member.entityKind).toBe(first.entityKind);
        expect([member.anchorLat, member.anchorLon])
          .toEqual([first.anchorLat, first.anchorLon]);
        const radius = greatCircleDistanceMeters(member, {
          lat: member.anchorLat, lon: member.anchorLon
        });
        expect(radius).toBeGreaterThanOrEqual(formation.minRadius - 0.01);
        expect(radius).toBeLessThanOrEqual(formation.maxRadius + 0.01);
        for (const other of members) {
          if (member.entityId === other.entityId) continue;
          expect(greatCircleDistanceMeters(member, other))
            .toBeGreaterThanOrEqual(formation.separation - 0.01);
        }
      }
    }

    const planner = {
      scheduleZones: vi.fn(async (input: { zoneIds: typeof visibleZoneIds }) => ({
        disabled: false,
        readyZoneIds: input.zoneIds,
        pendingZoneIds: []
      })),
      scheduleZonesAndWait: vi.fn(
        async (input: { zoneIds: typeof visibleZoneIds }) => ({
          disabled: false,
          readyZoneIds: input.zoneIds,
          pendingZoneIds: []
        })
      )
    };
    const combat = {
      spawnMob: vi.fn((input: { entityId: string }) => input as never),
      despawnMob: vi.fn(),
      despawnPopulationManagedMob: vi.fn(() => false),
      rebindPopulationAuthority: vi.fn(() => true)
    };
    const backend = new PopulationZonesV2Backend(
      store,
      planner as never,
      combat as never,
      {
        regionCode: populationZoneV2CanonicalRegionCode(
          populationZoneV2IdForPoint(center)
        ),
        runtimeSha,
        worldEnvironmentIdentityKey,
        worldPipelineSha
      }
    );
    const runtimeActivationTiming = { milliseconds: 0 };
    const measuredBackend: PopulationZonesV2RuntimeBackend = {
      updateZoneReferences: (input) => backend.updateZoneReferences(input),
      activateZones: async (input) => {
        const activationStartedAt = performance.now();
        try {
          return await backend.activateZones(input);
        } finally {
          runtimeActivationTiming.milliseconds +=
            performance.now() - activationStartedAt;
        }
      },
      sleepZones: (input) => backend.sleepZones(input)
    };
    const runtime = new PopulationZonesV2Runtime(measuredBackend);
    const frames: PopulationZoneDelta[] = [];
    let projection = emptyPopulationZoneProjection();
    let clientFramesAccepted = true;
    const adapter = new PopulationRealtimeAdapter({
      orchestrator: new PopulationAreaOrchestrator(runtime),
      registry: {
        isActivePlayerConnection: () => true,
        sendToConnection: (_connectionId, frame) => {
          const delta = frame as PopulationZoneDelta;
          frames.push(delta);
          const replacementStartedAt = performance.now();
          const applied = applyPopulationZoneDelta(projection, delta, {
            playerId: "cold-lifecycle-player",
            relocationRevision: 1,
            resourceVisionRevision: 1
          });
          timings.clientAuthoritativeReplacementMs +=
            performance.now() - replacementStartedAt;
          clientFramesAccepted &&= applied.accepted;
          projection = applied.state;
        }
      },
    });
    adapter.start();

    try {
      const visibleReadinessStartedAt = performance.now();
      const relocation = adapter.relocate({
        playerId: "cold-lifecycle-player",
        connectionId: "cold-lifecycle-connection",
        connectionGeneration: 1,
        area: {
          center,
          certifiedVisibleRadiusM: visibleRadiusM,
          preparedRadiusM: visibleRadiusM + 1,
          sourceType: "flag",
          sourceId: "cold-lifecycle-flag",
          generation: 1
        },
        relocationRevision: 1,
        resourceVisionRevision: 1,
        challengeProfile: {
          currentGearLevel: 7,
          unlockedGearLevel: 7,
          tier: "uncommon",
          contributors: {
            melee: 10,
            chest: 10,
            secondary: 3
          },
          balanceVersion: 2
        },
        trigger: "flag-travel",
        isCurrent: () => true
      });
      const readiness = await relocation.visibleReady;
      timings.runtimeActivationMs = runtimeActivationTiming.milliseconds;
      timings.visibleReadinessCompletionMs =
        performance.now() - visibleReadinessStartedAt;
      expect(readiness).toEqual({
        status: "ready",
        pendingVisibleZoneCount: visibleZoneIds.length - 1
      });
      await relocation.completion;

      const finalFrame = frames.at(-1);
      expect(clientFramesAccepted).toBe(true);
      expect(finalFrame).toMatchObject({
        preparationResult: "ready",
        partial: false,
        terminal: true,
        visibleZoneCount: visibleZoneIds.length,
        readyVisibleZoneCount: visibleZoneIds.length
      });
      expect(projection.preparationProgress).toMatchObject({
        completed: visibleZoneIds.length,
        total: visibleZoneIds.length,
        status: "ready"
      });
      expect(combat.spawnMob).toHaveBeenCalled();
      expect(combat.spawnMob.mock.calls.every(([input]) =>
        (input as unknown as {
          combatProfile?: {
            level: number;
            tier: string;
            balanceVersion: number;
          };
        }).combatProfile?.level === 7
        && (input as unknown as {
          combatProfile?: { tier: string };
        }).combatProfile?.tier === "uncommon"
        && (input as unknown as {
          combatProfile?: { balanceVersion: number };
        }).combatProfile?.balanceVersion === 2
      )).toBe(true);
      const latestZoneEntities = new Map<string, readonly string[]>();
      for (const frame of frames) {
        for (const snapshot of frame.zoneSnapshots) {
          latestZoneEntities.set(snapshot.zoneId, snapshot.entityIds);
        }
      }
      expect([...projection.entities.keys()].sort()).toEqual(
        [...latestZoneEntities.values()].flat().sort()
      );
      expect(Object.values(timings).every((value) =>
        Number.isFinite(value) && value >= 0
      )).toBe(true);
      console.info("population-cold-lifecycle-timings", JSON.stringify({
        zoneCount: visibleZoneIds.length,
        persistedEntityCount: persistedEntities.length,
        visibleEntityCount: projection.entities.size,
        adjacentBoundaryViolations: boundaryViolations,
        stagesMs: roundedTimings(timings)
      }));
    } finally {
      adapter.stop();
      await runtime.close();
      await backend.close();
    }
  }, 60_000);
});

function projectionTimedPool(
  pool: pg.Pool,
  timing: { milliseconds: number }
): pg.Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property !== "connect") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
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
              const sql = typeof query === "string"
                ? query
                : query.text ?? "";
              const startedAt = performance.now();
              try {
                return await clientTarget.query(query as never, values as never);
              } finally {
                if (
                  /INSERT INTO (?:population_spawn_slots_v2|population_entity_state_v2|collectible_nodes|generated_world_mobs|repeatable_resource_nodes)/u
                    .test(sql)
                ) {
                  timing.milliseconds += performance.now() - startedAt;
                }
              }
            };
          }
        });
      };
    }
  });
}

function roundedTimings(
  timings: Readonly<Record<string, number>>
): Record<string, number> {
  return Object.fromEntries(Object.entries(timings).map(([key, value]) => [
    key,
    Math.round(value * 100) / 100
  ]));
}

function assertStabilityAdminUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !parsed.pathname.replace(/^\/+/u, "")
      .startsWith("ash_atlas_stability")
  ) {
    throw new Error(
      "population acceptance requires a local disposable stability database"
    );
  }
  return parsed;
}

function quoteIdentifier(identifier: string): string {
  if (!/^ash_atlas_stability_[a-z0-9_]+$/u.test(identifier)) {
    throw new Error("unsafe population acceptance database identifier");
  }
  return `"${identifier}"`;
}

function adjacentBoundaryViolations(
  entities: readonly PopulationZoneV2ReadyEntity[]
): Record<string, number> {
  const trees = entities.filter((entity) => entity.entityKind === "tree");
  const stones = entities.filter((entity) => entity.entityKind === "stone");
  return {
    treeTree: countPairsBelow(trees, trees, 70),
    stoneTree: countPairsBelow(stones, trees, 50)
  };
}

function countPairsBelow(
  left: readonly PopulationZoneV2ReadyEntity[],
  right: readonly PopulationZoneV2ReadyEntity[],
  minimumM: number,
  useAnchors = false
): number {
  let violations = 0;
  const seen = new Set<string>();
  for (const first of left) {
    for (const second of right) {
      if (
        first.entityId === second.entityId
        || first.zoneId === second.zoneId
      ) continue;
      const key = [first.entityId, second.entityId].sort().join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      const firstPosition = useAnchors
        ? { lat: first.anchorLat, lon: first.anchorLon }
        : { lat: first.lat, lon: first.lon };
      const secondPosition = useAnchors
        ? { lat: second.anchorLat, lon: second.anchorLon }
        : { lat: second.lat, lon: second.lon };
      if (
        greatCircleDistanceMeters(firstPosition, secondPosition)
        < minimumM
      ) {
        violations += 1;
      }
    }
  }
  return violations;
}
