import {
  populationZoneV2Geometry,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import {
  type PopulationZonesV2PlannerStore,
  PopulationZonesV2Planner
} from "./populationZonesV2Planner.js";
import {
  populationZoneV3ConservativeHabitat,
  type GeneratedPopulationZoneV2Plan
} from "./populationZonesV2Plan.js";
import {
  populationZoneV2PlanRequest,
  type ClaimedPopulationZoneV2Plan,
  type PopulationZoneV2PlanRecord,
  type PopulationZoneV2PlanRequest
} from "./populationZonesV2Store.js";
import { packageIdForPosition } from "./spatialZones.js";

const DIAGNOSTIC_WORLD_IDENTITY = "a".repeat(64);
const DIAGNOSTIC_WORLD_SHA = "b".repeat(40);

export function createPopulationPreparationDiagnosticComposition(input: Readonly<{
  mode: "explicit-diagnostic-fake";
  preparedZoneIds: ReadonlySet<PopulationZoneV2Id>;
  activePreparationConcurrency: number;
  zoneQueueMaximum: number;
}>) {
  const ready = new Set(input.preparedZoneIds);
  const metrics = {
    requestedZoneCount: 0,
    compilerCalls: 0,
    activeCompilerCalls: 0,
    peakCompilerConcurrency: 0,
    compiledZoneIds: new Set<PopulationZoneV2Id>()
  };
  const store: PopulationZonesV2PlannerStore = {
    async ensurePlansForZones(requests): Promise<PopulationZoneV2PlanRecord[]> {
      metrics.requestedZoneCount += requests.length;
      return requests.map((request) => ({
        ...request,
        status: ready.has(request.identity.zoneId as PopulationZoneV2Id)
          ? "ready" as const
          : "pending" as const,
        claimGeneration: ready.has(request.identity.zoneId as PopulationZoneV2Id) ? 1 : 0,
        attemptCount: ready.has(request.identity.zoneId as PopulationZoneV2Id) ? 1 : 0,
        contentHash: ready.has(request.identity.zoneId as PopulationZoneV2Id)
          ? "c".repeat(64)
          : null
      }));
    },
    async claimPlan(identity, ownerId): Promise<ClaimedPopulationZoneV2Plan | null> {
      if (ready.has(identity.zoneId as PopulationZoneV2Id)) return null;
      return {
        identity,
        planId: populationZoneV2PlanRequest({
          zoneId: identity.zoneId as PopulationZoneV2Id,
          worldEnvironmentIdentityKey: identity.worldEnvironmentIdentityKey,
          worldPipelineSha: DIAGNOSTIC_WORLD_SHA,
          environmentProfileVersion: identity.environmentProfileVersion,
          regionCode: packageIdForPosition(
            populationZoneV2Geometry(identity.zoneId as PopulationZoneV2Id).center
          )
        }).planId,
        ownerId,
        claimGeneration: 1,
        attemptCount: 1
      };
    },
    async heartbeatPlan(): Promise<boolean> {
      return true;
    },
    async completePlan(claim): Promise<boolean> {
      ready.add(claim.identity.zoneId as PopulationZoneV2Id);
      return true;
    },
    async failPlan(): Promise<Readonly<{
      accepted: boolean;
      status: "retryable-failure";
    }>> {
      return { accepted: true, status: "retryable-failure" };
    },
    async supersedeObsoletePlansForZones(): Promise<number> {
      return 0;
    }
  };
  const compiler = {
    async compileZone(compileInput: Readonly<{ zoneId: PopulationZoneV2Id }>) {
      metrics.compilerCalls += 1;
      metrics.activeCompilerCalls += 1;
      metrics.peakCompilerConcurrency = Math.max(
        metrics.peakCompilerConcurrency,
        metrics.activeCompilerCalls
      );
      try {
        await delay(2);
        metrics.compiledZoneIds.add(compileInput.zoneId);
        return populationZoneV3ConservativeHabitat({
          zoneId: compileInput.zoneId,
          worldEnvironmentIdentityKey: DIAGNOSTIC_WORLD_IDENTITY,
          regionCode: packageIdForPosition(populationZoneV2Geometry(compileInput.zoneId).center)
        });
      } finally {
        metrics.activeCompilerCalls -= 1;
      }
    },
    snapshot() {
      return {
        activeLookups: metrics.activeCompilerCalls,
        cacheEntries: ready.size,
        protectedCacheEntries: ready.size,
        probationaryCacheEntries: 0,
        cacheMetrics: {
          protectedHits: 0,
          probationaryHits: 0,
          promotions: 0,
          protectedEvictions: 0,
          probationaryEvictions: 0
        },
        inFlightSamples: metrics.activeCompilerCalls,
        zones: []
      };
    }
  };
  const planner = new PopulationZonesV2Planner(
    store,
    compiler,
    {
      worldEnvironmentIdentityKey: DIAGNOSTIC_WORLD_IDENTITY,
      worldPipelineSha: DIAGNOSTIC_WORLD_SHA,
      activePreparationConcurrency: input.activePreparationConcurrency,
      zoneQueueMax: input.zoneQueueMaximum,
      generatePlans: ({ outputZoneIds, habitatForZone }) =>
        outputZoneIds.map((zoneId) => diagnosticPlan(zoneId, habitatForZone(zoneId)))
    }
  );
  return { planner, metrics };
}

function diagnosticPlan(
  zoneId: PopulationZoneV2Id,
  habitat: ReturnType<typeof populationZoneV3ConservativeHabitat>
): GeneratedPopulationZoneV2Plan {
  const request: PopulationZoneV2PlanRequest = populationZoneV2PlanRequest({
    zoneId,
    worldEnvironmentIdentityKey: DIAGNOSTIC_WORLD_IDENTITY,
    worldPipelineSha: DIAGNOSTIC_WORLD_SHA,
    environmentProfileVersion: "population-compact-gameplay-environment-v1",
    regionCode: packageIdForPosition(populationZoneV2Geometry(zoneId).center)
  });
  return {
    identity: request.identity,
    planId: request.planId,
    worldPipelineSha: DIAGNOSTIC_WORLD_SHA,
    geometry: populationZoneV2Geometry(zoneId),
    habitat,
    slots: [],
    contentHash: "c".repeat(64)
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
