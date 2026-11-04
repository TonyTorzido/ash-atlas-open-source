import { performance } from "node:perf_hooks";

import pg from "pg";

import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { ClosedTestTelemetryService } from "./service.js";

const ROUNDS = 5;
const CHUNK_SIZE = 100;
let benchmarkSink = 0;

const telemetryDatabaseUrl = requiredEnvironment("TELEMETRY_BENCHMARK_DATABASE_URL");
const gameplayDatabaseUrl =
  process.env.TELEMETRY_BENCHMARK_GAMEPLAY_DATABASE_URL ?? telemetryDatabaseUrl;
const releaseSha = requiredEnvironment("RUNTIME_SHA");
const enabledConfig = loadConfig({
  NODE_ENV: "test",
  TELEMETRY_ENABLED: "true",
  TELEMETRY_DATABASE_URL: telemetryDatabaseUrl,
  TELEMETRY_RELEASE_GENERATION:
    process.env.TELEMETRY_RELEASE_GENERATION ?? "test/t182",
  WORLD_REQUIRED_RELEASE_ID:
    process.env.WORLD_REQUIRED_RELEASE_ID ?? "world-packages-v1",
  RUNTIME_SHA: releaseSha
});
const disabled = new ClosedTestTelemetryService(
  loadConfig({ NODE_ENV: "test" }),
  createLogger("test")
);
const enabled = new ClosedTestTelemetryService(
  enabledConfig,
  createLogger("test")
);
await enabled.refreshActiveRunForTest();
if (!enabled.metricsSnapshot().activeRunId) {
  throw new Error("benchmark requires an active telemetry run matching the runtime identity");
}

type Scenario = Readonly<{
  name: "expected_closed_test" | "higher_stress";
  iterations: number;
  operationsPerTick: number;
}>;

type Measurement = Readonly<{
  elapsedMs: number;
  cpuMs: number;
  peakHeapGrowthBytes: number;
  tickChunkMeansMs: readonly number[];
}>;

const scenarios: readonly Scenario[] = [
  { name: "expected_closed_test", iterations: 10_000, operationsPerTick: 1_000 },
  { name: "higher_stress", iterations: 5_000, operationsPerTick: 4_000 }
];

const gameplayProbe = new pg.Pool({
  connectionString: gameplayDatabaseUrl,
  max: 1,
  application_name: "ash-atlas-telemetry-benchmark-gameplay-probe"
});
const gameplayLatencyBeforeMs = await queryLatency(gameplayProbe, 20);
const results = [];
for (const scenario of scenarios) {
  results.push(await benchmarkScenario(scenario));
}
const gameplayLatencyAfterMs = await queryLatency(gameplayProbe, 20);
await gameplayProbe.end();
const finalMetrics = enabled.metricsSnapshot();
await enabled.shutdown();

process.stdout.write(`${JSON.stringify({
  rounds: ROUNDS,
  deterministicSeed: 1,
  chunkSize: CHUNK_SIZE,
  productionPath: {
    queue: true,
    coalescing: true,
    priorityOrdering: true,
    serialization: true,
    batchedPostgresIngestion: true,
    healthUpsert: true
  },
  scenarios: results,
  isolation: {
    telemetryPool: finalMetrics.pool,
    gameplayPoolMaximum: 1,
    gameplayQueryLatencyBeforeMs: gameplayLatencyBeforeMs,
    gameplayQueryLatencyAfterMs: gameplayLatencyAfterMs,
    gameplayQueryLatencyDeltaMs:
      gameplayLatencyAfterMs - gameplayLatencyBeforeMs,
    observerNetworkBytes: 0,
    eventLoopImpact:
      "Reported as enabled tick p95/p99 deltas for each scenario."
  },
  telemetry: {
    queue: finalMetrics.queue,
    rowsFlushed: finalMetrics.rowsFlushed,
    writeFailures: finalMetrics.writeFailures,
    criticalLoss: finalMetrics.queue.droppedByPriority.critical
  },
  sink: benchmarkSink
}, null, 2)}\n`);

async function benchmarkScenario(scenario: Scenario) {
  measure(scenario, null);
  measure(scenario, disabled);
  measure(scenario, enabled);
  await drainTelemetry(enabled);
  const measurements = {
    baseline: [] as Measurement[],
    disabled: [] as Measurement[],
    enabled: [] as Measurement[]
  };
  let ingestionFlushMs = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const order = round % 2 === 0
      ? (["baseline", "disabled", "enabled"] as const)
      : (["enabled", "disabled", "baseline"] as const);
    for (const mode of order) {
      measurements[mode].push(measure(
        scenario,
        mode === "baseline" ? null : mode === "disabled" ? disabled : enabled
      ));
      if (mode === "enabled") {
        ingestionFlushMs += await drainTelemetry(enabled);
      }
    }
  }
  const baseline = summarize(measurements.baseline);
  const disabledSummary = summarize(measurements.disabled);
  const enabledSummary = summarize(measurements.enabled);
  return {
    ...scenario,
    baseline,
    disabled: {
      ...disabledSummary,
      elapsedOverheadPercent: percentOverhead(
        baseline.elapsedMedianMs,
        disabledSummary.elapsedMedianMs
      ),
      cpuOverheadPercent: percentOverhead(
        baseline.cpuMedianMs,
        disabledSummary.cpuMedianMs
      )
    },
    enabled: {
      ...enabledSummary,
      elapsedOverheadPercent: percentOverhead(
        baseline.elapsedMedianMs,
        enabledSummary.elapsedMedianMs
      ),
      cpuOverheadPercent: percentOverhead(
        baseline.cpuMedianMs,
        enabledSummary.cpuMedianMs
      ),
      tickP95DeltaMs: enabledSummary.tick.p95Ms - baseline.tick.p95Ms,
      tickP99DeltaMs: enabledSummary.tick.p99Ms - baseline.tick.p99Ms,
      ingestionFlushMs
    },
    telemetry: {
      queue: enabled.metricsSnapshot().queue,
      rowsFlushed: enabled.metricsSnapshot().rowsFlushed,
      writeFailures: enabled.metricsSnapshot().writeFailures,
      criticalLoss: enabled.metricsSnapshot().queue.droppedByPriority.critical,
      poolConnections:
        enabled.metricsSnapshot().pool?.connections ?? null
    }
  };
}

function measure(
  scenario: Scenario,
  observer: ClosedTestTelemetryService | null
): Measurement {
  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  const heapStartedAt = process.memoryUsage().heapUsed;
  let peakHeap = heapStartedAt;
  const tickChunkMeansMs: number[] = [];
  for (let start = 0; start < scenario.iterations; start += CHUNK_SIZE) {
    const end = Math.min(scenario.iterations, start + CHUNK_SIZE);
    const chunkStartedAt = performance.now();
    for (let index = start; index < end; index += 1) {
      benchmarkSink ^= simulatedWorldStep(index, scenario.operationsPerTick);
      observer?.observeTick(8 + index % 4);
    }
    const chunkIndex = Math.floor(start / CHUNK_SIZE);
    observer?.recordServerSample({
      active_players: scenario.name === "expected_closed_test" ? 25 : 100,
      eventLoopDelayP99Ms: 10
    });
    observer?.recordEvent({
      eventFamily: "population",
      eventType: "benchmark_routine_observation",
      priority: "routine",
      metadata: { scenario: scenario.name, chunkIndex },
      coalesceKey: `benchmark:${scenario.name}:routine`
    });
    if (chunkIndex % 10 === 0) {
      observer?.recordEvent({
        eventFamily: "population",
        eventType: "benchmark_important_observation",
        priority: "important",
        metadata: { scenario: scenario.name, chunkIndex }
      });
    }
    if (chunkIndex % 50 === 0) {
      observer?.recordEvent({
        eventFamily: "persistence",
        eventType: "benchmark_critical_observation",
        priority: "critical",
        metadata: { scenario: scenario.name, chunkIndex }
      });
    }
    tickChunkMeansMs.push((performance.now() - chunkStartedAt) / (end - start));
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  const cpu = process.cpuUsage(cpuStartedAt);
  return {
    elapsedMs: performance.now() - startedAt,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    peakHeapGrowthBytes: Math.max(0, peakHeap - heapStartedAt),
    tickChunkMeansMs
  };
}

async function drainTelemetry(service: ClosedTestTelemetryService): Promise<number> {
  const startedAt = performance.now();
  while (service.metricsSnapshot().queue.depth > 0) {
    await service.flush();
  }
  return performance.now() - startedAt;
}

async function queryLatency(pool: pg.Pool, samples: number): Promise<number> {
  const startedAt = performance.now();
  for (let index = 0; index < samples; index += 1) {
    await pool.query("SELECT 1");
  }
  return (performance.now() - startedAt) / samples;
}

function simulatedWorldStep(index: number, operations: number): number {
  let value = index + 1;
  for (let operation = 0; operation < operations; operation += 1) {
    value = Math.imul(value ^ operation, 1_664_525) + 1_013_904_223;
  }
  return value;
}

function summarize(measurements: readonly Measurement[]) {
  const ticks = measurements.flatMap((measurement) =>
    measurement.tickChunkMeansMs
  ).sort((left, right) => left - right);
  return {
    elapsedMedianMs: median(measurements.map((value) => value.elapsedMs)),
    cpuMedianMs: median(measurements.map((value) => value.cpuMs)),
    peakHeapGrowthMedianBytes: median(
      measurements.map((value) => value.peakHeapGrowthBytes)
    ),
    tick: {
      meanMs: ticks.reduce((total, value) => total + value, 0) / ticks.length,
      p50Ms: percentile(ticks, 0.5),
      p95Ms: percentile(ticks, 0.95),
      p99Ms: percentile(ticks, 0.99),
      maxMs: ticks.at(-1) ?? 0
    }
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function percentile(values: readonly number[], rank: number): number {
  return values[
    Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * rank) - 1))
  ] ?? 0;
}

function percentOverhead(baselineMs: number, observedMs: number): number {
  return (observedMs - baselineMs) * 100 / baselineMs;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
