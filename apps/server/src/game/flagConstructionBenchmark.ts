import { randomUUID } from "node:crypto";

import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { createLogger } from "../logger.js";
import { WorldLookupClient } from "../world/worldLookupClient.js";
import { FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";
import { MasteryService } from "./masteries.js";
import type { PlayerRecord } from "./state.js";

const DEFAULT_SAMPLES_PER_TEMPERATURE = 20;

async function main(): Promise<void> {
  const config = loadConfig();
  assertDisposableDatabase(config.DATABASE_URL);
  const samplesPerTemperature = positiveInteger(
    process.env.FLAG_CONSTRUCTION_BENCHMARK_SAMPLES,
    DEFAULT_SAMPLES_PER_TEMPERATURE
  );
  const logger = createLogger("test");
  const pool = createPool({ databaseUrl: config.DATABASE_URL });
  const inventory = new InventoryService(pool);
  const playerId = `flag-construction-benchmark-${randomUUID()}`;
  const worldLookup = new WorldLookupClient(
    config.WORLD_API_BASE,
    logger,
    config.WORLD_LOOKUP_TIMEOUT_MS,
    {
      releaseId: config.WORLD_REQUIRED_RELEASE_ID,
      profileSetFingerprint: config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
      buildContractFingerprint: config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
      boundaryReleaseId: config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID
    },
    config.RESOURCE_ENVIRONMENT_BATCH_TIMEOUT_MS
  );
  const flags = new FlagService(
    pool,
    worldLookup,
    config,
    logger,
    inventory,
    new MasteryService(pool)
  );
  const samples: ConstructionSample[] = [];
  try {
    await worldLookup.verifyRequiredRelease();
    await insertBenchmarkPlayer(pool, playerId);
    await inventory.grantItemsForOperation({
      operationKey: `flag-construction-benchmark-seed:${playerId}`,
      playerId,
      source: "flag_construction_benchmark_seed",
      grants: [
        { itemId: "wood", variant: null, quantity: samplesPerTemperature * 6 },
        { itemId: "leather", variant: null, quantity: samplesPerTemperature * 4 }
      ]
    });

    for (let index = 0; index < samplesPerTemperature * 2; index += 1) {
      const temperature = index % 2 === 0 ? "cold" : "warm";
      const position = benchmarkPosition(index);
      const player: PlayerRecord = {
        playerId,
        username: "Flag Construction Benchmark",
        displayColor: "#38bdf8",
        regionCode: packageIdFor(position),
        position,
        anchor: position,
        moveLeashRadiusM: config.MOVE_LEASH_RADIUS_M,
        movementRevision: index,
        relocationRevision: index,
        target: null,
        online: true,
        updatedAt: new Date()
      };
      if (temperature === "warm") {
        await flags.createPlacementQuote(player);
      }
      const quotePreparationStartedAt = performance.now();
      const quoteId = (await flags.createPlacementQuote(player)).quote.quoteId;
      const quotePreparationMs = performance.now() - quotePreparationStartedAt;
      const admissionStartedAt = performance.now();
      const prepared = await flags.prepareForPlayer(
        player,
        `Benchmark ${index + 1}`,
        quoteId
      );
      const clickToStartedMs = performance.now() - admissionStartedAt;
      const commitStartedAt = performance.now();
      const result = await flags.commitPreparedPlacement(
        prepared,
        true,
        `benchmark-${index}-${randomUUID()}`
      );
      const commitReturnedAt = performance.now();
      const flagCreatedSentAt = performance.now();
      samples.push({
        temperature,
        quotePreparationMs,
        quotePreparationToStartedMs: quotePreparationMs + clickToStartedMs,
        clickToStartedMs,
        timerToCommitMs: result.timings?.totalMs ?? commitReturnedAt - commitStartedAt,
        commitToFlagCreatedSentMs: flagCreatedSentAt - commitReturnedAt,
        worldLookupMs: prepared.admissionTimings.worldLookupMs,
        territoryAdmissionMs: prepared.admissionTimings.territoryAdmissionMs,
        databasePoolWaitMs: result.timings?.databasePoolWaitMs ?? 0,
        spatialLockWaitMs: result.timings?.spatialLockWaitMs ?? 0,
        finalTerritoryRevalidationMs:
          result.timings?.finalTerritoryRevalidationMs ?? 0,
        inventoryDebitMs: result.timings?.inventoryDebitMs ?? 0,
        flagInsertMs: result.timings?.flagInsertMs ?? 0,
        builderOutcomeMs: result.timings?.builderOutcomeMs ?? 0,
        activationJobInsertMs: result.timings?.activationJobInsertMs ?? 0,
        transactionCommitMs: result.timings?.transactionCommitMs ?? 0
      });
    }
  } finally {
    await cleanupBenchmark(pool, playerId);
    await pool.end();
  }

  const cold = summarize(samples.filter(({ temperature }) => temperature === "cold"));
  const warm = summarize(samples.filter(({ temperature }) => temperature === "warm"));
  console.log(JSON.stringify({
    samplesPerTemperature,
    cold,
    warm,
    targets: {
      readyQuoteAdmissionP95Ms: {
        target: 100,
        actual: Math.max(cold.clickToStarted.p95, warm.clickToStarted.p95),
        passed: Math.max(cold.clickToStarted.p95, warm.clickToStarted.p95) <= 100
      },
      warmQuotePreparationToStartedP95Ms: {
        target: 500,
        actual: warm.quotePreparationToStarted.p95,
        passed: warm.quotePreparationToStarted.p95 <= 500
      },
      commitP95Ms: {
        target: 150,
        actual: Math.max(cold.timerToCommit.p95, warm.timerToCommit.p95),
        passed: Math.max(cold.timerToCommit.p95, warm.timerToCommit.p95) <= 150
      },
      commitToSendP95Ms: {
        target: 10,
        actual: Math.max(cold.commitToFlagCreatedSent.p95, warm.commitToFlagCreatedSent.p95),
        passed: Math.max(cold.commitToFlagCreatedSent.p95, warm.commitToFlagCreatedSent.p95) <= 10
      }
    },
    worldCache: worldLookup.gameplayEnvironmentMetrics()
  }, null, 2));
}

type ConstructionSample = {
  temperature: "cold" | "warm";
  quotePreparationMs: number;
  quotePreparationToStartedMs: number;
  clickToStartedMs: number;
  timerToCommitMs: number;
  commitToFlagCreatedSentMs: number;
  worldLookupMs: number;
  territoryAdmissionMs: number;
  databasePoolWaitMs: number;
  spatialLockWaitMs: number;
  finalTerritoryRevalidationMs: number;
  inventoryDebitMs: number;
  flagInsertMs: number;
  builderOutcomeMs: number;
  activationJobInsertMs: number;
  transactionCommitMs: number;
};

function summarize(samples: ConstructionSample[]) {
  const metric = (key: keyof Omit<ConstructionSample, "temperature">) =>
    metricSummary(samples.map((sample) => sample[key]));
  return {
    sampleCount: samples.length,
    quotePreparation: metric("quotePreparationMs"),
    quotePreparationToStarted: metric("quotePreparationToStartedMs"),
    clickToStarted: metric("clickToStartedMs"),
    timerToCommit: metric("timerToCommitMs"),
    commitToFlagCreatedSent: metric("commitToFlagCreatedSentMs"),
    stages: {
      worldLookup: metric("worldLookupMs"),
      territoryAdmission: metric("territoryAdmissionMs"),
      databasePoolWait: metric("databasePoolWaitMs"),
      spatialLockWait: metric("spatialLockWaitMs"),
      finalTerritoryRevalidation: metric("finalTerritoryRevalidationMs"),
      inventoryDebit: metric("inventoryDebitMs"),
      flagInsert: metric("flagInsertMs"),
      builderOutcome: metric("builderOutcomeMs"),
      activationJobInsert: metric("activationJobInsertMs"),
      transactionCommit: metric("transactionCommitMs")
    }
  };
}

function metricSummary(values: number[]) {
  return {
    sampleCount: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(0, ...values)
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function benchmarkPosition(index: number): { lat: number; lon: number } {
  const row = Math.floor(index / 10);
  const column = index % 10;
  return {
    lat: 33.1 + row * 0.3,
    lon: -109.1 + column * 0.3
  };
}

function packageIdFor(position: { lat: number; lon: number }): string {
  return `world_v1_lat${Math.floor(position.lat)}_lon${Math.floor(position.lon)}`;
}

async function insertBenchmarkPlayer(
  pool: ReturnType<typeof createPool>,
  playerId: string
): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id, username, region_code, lat, lon, anchor_lat, anchor_lon,
       move_leash_radius_m, online, geom
     ) VALUES ($1,$2,'GLOBAL',0,0,0,0,1250,false,
               ST_SetSRID(ST_MakePoint(0,0),4326))`,
    [playerId, `Flag Benchmark ${randomUUID().slice(0, 8)}`]
  );
}

async function cleanupBenchmark(
  pool: ReturnType<typeof createPool>,
  playerId: string
): Promise<void> {
  const processingDeadline = Date.now() + 60_000;
  while (Date.now() < processingDeadline) {
    const processingResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM resource_vision_jobs AS jobs
       INNER JOIN flags ON flags.id = jobs.flag_id
       WHERE flags.owner_id = $1
         AND jobs.status = 'processing'`,
      [playerId]
    );
    if (Number(processingResult.rows[0]?.count ?? 0) === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await pool.query("DELETE FROM mastery_progression_operations WHERE player_id = $1", [playerId]);
  await pool.query("ALTER TABLE inventory_events DISABLE TRIGGER inventory_events_immutable");
  await pool.query("ALTER TABLE inventory_operations DISABLE TRIGGER inventory_operations_immutable");
  await pool.query("ALTER TABLE player_inventory DISABLE TRIGGER player_inventory_identity_guard");
  await pool.query("DELETE FROM inventory_events WHERE player_id = $1", [playerId]);
  await pool.query("DELETE FROM inventory_operations WHERE player_id = $1", [playerId]);
  await pool.query("DELETE FROM player_inventory WHERE player_id = $1", [playerId]);
  await pool.query("ALTER TABLE player_inventory ENABLE TRIGGER player_inventory_identity_guard");
  await pool.query("ALTER TABLE inventory_operations ENABLE TRIGGER inventory_operations_immutable");
  await pool.query("ALTER TABLE inventory_events ENABLE TRIGGER inventory_events_immutable");
  await pool.query("DELETE FROM flags WHERE owner_id = $1", [playerId]);
  await pool.query("DELETE FROM players WHERE id = $1", [playerId]);
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("FLAG_CONSTRUCTION_BENCHMARK_SAMPLES must be an integer from 1 through 100");
  }
  return value;
}

function assertDisposableDatabase(databaseUrl: string): void {
  if (!/\/ash_atlas_stability[^/?]*/.test(databaseUrl)) {
    throw new Error("flag construction benchmark requires an ash_atlas_stability database");
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
