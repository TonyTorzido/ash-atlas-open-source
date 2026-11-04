import { performance } from "node:perf_hooks";

import {
  DEFAULT_FLAG_PREPARE_RADIUS_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  destinationPoint,
  type LatLon
} from "@ash-atlas/shared";

import { loadConfig } from "../config.js";
import {
  populationZoneV2Geometry,
  populationZoneV2IdForPoint,
  populationZonesV2IntersectingCircle,
  type PopulationZoneV2Id
} from "./populationZonesV2Geometry.js";
import { createPopulationPreparationDiagnosticComposition } from "./populationZonesV2DiagnosticComposition.js";
import { packageIdForPosition } from "./spatialZones.js";

const MID_LATITUDE = { lat: 35.0844, lon: -106.6504 };
const MID_ZONE = populationZoneV2Geometry(populationZoneV2IdForPoint(MID_LATITUDE));
const config = loadConfig({ NODE_ENV: "test" });

const CASES: ReadonlyArray<Readonly<{ name: string; center: LatLon }>> = [
  { name: "mid-latitude", center: MID_LATITUDE },
  { name: "high-latitude", center: { lat: 75, lon: 20 } },
  {
    name: "zone-boundary",
    center: { lat: MID_ZONE.center.lat, lon: MID_ZONE.bounds.eastLon }
  },
  {
    name: "four-way-intersection",
    center: { lat: MID_ZONE.bounds.northLat, lon: MID_ZONE.bounds.eastLon }
  },
  { name: "antimeridian", center: { lat: 0.5, lon: 179.9999 } }
];

const results = [];
for (const testCase of CASES) {
  const visible = populationZonesV2IntersectingCircle(
    testCase.center,
    DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
  );
  const prepared = populationZonesV2IntersectingCircle(
    testCase.center,
    DEFAULT_FLAG_PREPARE_RADIUS_M
  );
  const future = [];
  for (const offsetM of [500, 600] as const) {
    future.push(await measureFuture(new Set(prepared), testCase.center, offsetM));
  }
  results.push({
    name: testCase.name,
    center: testCase.center,
    visibleZones: visible.length,
    preparedZones: prepared.length,
    preparedOnlyZones: prepared.filter((zoneId) => !visible.includes(zoneId)).length,
    future
  });
}

console.log(JSON.stringify({
  contract: {
    visibleRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
    preparedRadiusM: DEFAULT_FLAG_PREPARE_RADIUS_M,
    activePreparationConcurrency:
      config.POPULATION_V2_ACTIVE_PREPARATION_CONCURRENCY,
    zoneQueueMaximum: config.POPULATION_V2_ZONE_QUEUE_MAX
  },
  note: "Measurements exercise the production planner queue, cache, deduplication, promotion, and configured concurrency with an instrumented in-memory compiler. World-call counts are compiler-call proxies; production external World latency still requires the disposable integration benchmark.",
  cases: results
}, null, 2));

async function measureFuture(
  preparedZoneIds: ReadonlySet<PopulationZoneV2Id>,
  center: LatLon,
  offsetM: 500 | 600
): Promise<Readonly<Record<string, number>>> {
  const futureCenter = destinationPoint(center, offsetM, 90);
  const required = populationZonesV2IntersectingCircle(
    futureCenter,
    DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
  );
  const cacheHits = required.filter((zoneId) => preparedZoneIds.has(zoneId)).length;
  const harness = createPopulationPreparationDiagnosticComposition({
    mode: "explicit-diagnostic-fake",
    preparedZoneIds,
    activePreparationConcurrency:
      config.POPULATION_V2_ACTIVE_PREPARATION_CONCURRENCY,
    zoneQueueMaximum: config.POPULATION_V2_ZONE_QUEUE_MAX
  });
  let peakQueueDepth = 0;
  let peakActivePreparations = 0;
  let settled = false;
  const startedAt = performance.now();
  const request = {
    zoneIds: required,
    regionCode: packageIdForPosition(futureCenter),
    reason: "diagnostic-future-flag",
    priority: 1
  } as const;
  const first = harness.planner.scheduleZonesAndWait(request);
  const duplicate = harness.planner.scheduleZonesAndWait(request);
  void Promise.all([first, duplicate]).finally(() => {
    settled = true;
  });
  while (!settled) {
    const snapshot = harness.planner.snapshot();
    peakQueueDepth = Math.max(peakQueueDepth, snapshot.queuedZones);
    peakActivePreparations = Math.max(
      peakActivePreparations,
      snapshot.activeZonePreparations
    );
    await delay(1);
  }
  await Promise.all([first, duplicate]);
  const readyMs = performance.now() - startedAt;
  const finalSnapshot = harness.planner.snapshot();
  peakQueueDepth = Math.max(peakQueueDepth, finalSnapshot.queuedZones);
  peakActivePreparations = Math.max(
    peakActivePreparations,
    finalSnapshot.activeZonePreparations
  );
  await harness.planner.close();
  return {
    offsetM,
    visibleZones: required.length,
    cacheHits,
    newlyCompiledZones: harness.metrics.compiledZoneIds.size,
    deduplicatedRequests:
      Math.max(0, harness.metrics.requestedZoneCount - required.length),
    compilerWorldCallProxy: harness.metrics.compilerCalls,
    peakQueueDepth,
    peakActivePreparations,
    peakCompilerConcurrency: harness.metrics.peakCompilerConcurrency,
    measuredReadyMs: Math.round(readyMs * 100) / 100
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
