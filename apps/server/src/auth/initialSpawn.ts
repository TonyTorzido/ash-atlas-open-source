import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";

import { classifyFlagPlacementTerrain, type LatLon } from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";

export const INITIAL_SPAWN_ALGORITHM_VERSION = "initial-spawn:v1";
export const INITIAL_SPAWN_COORDINATE_TOLERANCE = 1e-9;

type SamplingRegion = Readonly<{
  id: "contiguous-us" | "alaska" | "alaska-west-aleutians" | "hawaii";
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  areaWeight: number;
}>;

const SAMPLING_REGIONS: readonly SamplingRegion[] = [
  region("contiguous-us", 24.35, 49.5, -125, -66.45),
  region("alaska", 51, 71.6, -180, -129),
  region("alaska-west-aleutians", 51, 54.5, 170, 180),
  region("hawaii", 18.8, 22.6, -160.7, -154.7)
];
const TOTAL_AREA_WEIGHT = SAMPLING_REGIONS.reduce(
  (total, candidate) => total + candidate.areaWeight,
  0
);

export type InitialSpawnAssignment = {
  position: LatLon;
  algorithmVersion: typeof INITIAL_SPAWN_ALGORITHM_VERSION;
  landMaskVersion: string;
  worldIdentity: string;
  rejectedCandidates: number;
  stateCode: string | null;
  region: SamplingRegion["id"];
  durationMs: number;
  slotIndex?: number;
  slotGeneration?: number;
};

export type InitialSpawnMetrics = {
  successfulAssignments: number;
  failedAssignments: number;
  reusedAssignments: number;
  rejectedCandidates: number;
  assignmentDurationMs: number;
  coldIndexInitializationMs: number;
  approximateIndexBytes: number;
  algorithmVersion: typeof INITIAL_SPAWN_ALGORITHM_VERSION;
};

export class InitialSpawnError extends Error {
  constructor(
    readonly reason:
      | "WORLD_AUTHORITY_UNAVAILABLE"
      | "MAXIMUM_ATTEMPTS_EXHAUSTED"
      | "INVALID_SEED_INPUT"
  ) {
    super(
      reason === "MAXIMUM_ATTEMPTS_EXHAUSTED"
        ? "No valid United States land spawn could be assigned"
        : reason === "WORLD_AUTHORITY_UNAVAILABLE"
          ? "United States land data is unavailable"
          : "Initial spawn seed input is invalid"
    );
    this.name = "InitialSpawnError";
  }
}

export interface InitialSpawnWorldAuthority {
  lookupGameplayEnvironment(
    lat: number,
    lon: number
  ): Promise<WorldGameplayEnvironmentResult>;
  lookupGameplayEnvironments?(
    points: readonly LatLon[]
  ): Promise<readonly WorldGameplayEnvironmentResult[]>;
}

export class InitialSpawnSampler {
  private readonly metrics: InitialSpawnMetrics;

  constructor(
    private readonly config: Pick<
      AppConfig,
      | "INITIAL_SPAWN_HMAC_KEY"
      | "INITIAL_SPAWN_MAX_ATTEMPTS"
      | "WORLD_ID"
      | "WORLD_REQUIRED_RELEASE_ID"
      | "WORLD_REQUIRED_BOUNDARY_RELEASE_ID"
    >,
    private readonly world: InitialSpawnWorldAuthority
  ) {
    const startedAt = performance.now();
    // Region weights are immutable and calculated once at module initialization.
    this.metrics = {
      successfulAssignments: 0,
      failedAssignments: 0,
      reusedAssignments: 0,
      rejectedCandidates: 0,
      assignmentDurationMs: 0,
      coldIndexInitializationMs: performance.now() - startedAt,
      approximateIndexBytes: JSON.stringify(SAMPLING_REGIONS).length * 2,
      algorithmVersion: INITIAL_SPAWN_ALGORITHM_VERSION
    };
  }

  noteReusedAssignment(): void {
    this.metrics.reusedAssignments += 1;
  }

  metricsSnapshot(): InitialSpawnMetrics {
    return { ...this.metrics };
  }

  async assign(input: {
    accountId: string;
    accountCreatedAt: Date;
  }): Promise<InitialSpawnAssignment> {
    const startedAt = performance.now();
    if (
      !input.accountId ||
      !Number.isFinite(input.accountCreatedAt.getTime())
    ) {
      this.metrics.failedAssignments += 1;
      throw new InitialSpawnError("INVALID_SEED_INPUT");
    }
    const random = new DeterministicRandom(
      this.config.INITIAL_SPAWN_HMAC_KEY,
      [
        INITIAL_SPAWN_ALGORITHM_VERSION,
        this.config.WORLD_ID,
        input.accountCreatedAt.toISOString(),
        input.accountId
      ].join("|")
    );

    for (let attempt = 0; attempt < this.config.INITIAL_SPAWN_MAX_ATTEMPTS; attempt += 1) {
      const selected = selectRegion(random.nextUnit());
      const position = pointInRegion(selected, random.nextUnit(), random.nextUnit());
      const environment = await this.world.lookupGameplayEnvironment(
        position.lat,
        position.lon
      );
      if (!environment.ok) {
        if (
          environment.failure?.code !== "WORLD_COORDINATE_UNCOVERED" &&
          environment.failure?.code !== "WORLD_RESPONSE_INVALID"
        ) {
          this.metrics.failedAssignments += 1;
          throw new InitialSpawnError("WORLD_AUTHORITY_UNAVAILABLE");
        }
        this.metrics.rejectedCandidates += 1;
        continue;
      }
      if (
        environment.countryCode !== "US" ||
        !Number.isFinite(environment.latitude) ||
        !Number.isFinite(environment.longitude) ||
        environment.latitude < -90 ||
        environment.latitude > 90 ||
        environment.longitude < -180 ||
        environment.longitude > 180 ||
        Math.abs(environment.latitude - position.lat) >
          INITIAL_SPAWN_COORDINATE_TOLERANCE ||
        Math.abs(environment.longitude - position.lon) >
          INITIAL_SPAWN_COORDINATE_TOLERANCE ||
        classifyFlagPlacementTerrain(environment) !== "land"
      ) {
        this.metrics.rejectedCandidates += 1;
        continue;
      }

      const durationMs = performance.now() - startedAt;
      this.metrics.successfulAssignments += 1;
      this.metrics.assignmentDurationMs += durationMs;
      return {
        position,
        algorithmVersion: INITIAL_SPAWN_ALGORITHM_VERSION,
        landMaskVersion: landMaskVersion(environment, this.config),
        worldIdentity: worldIdentity(environment, this.config),
        rejectedCandidates: attempt,
        stateCode: environment.regionCode,
        region: selected.id,
        durationMs
      };
    }

    this.metrics.failedAssignments += 1;
    throw new InitialSpawnError("MAXIMUM_ATTEMPTS_EXHAUSTED");
  }

}

class DeterministicRandom {
  private counter = 0;
  private buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(
    private readonly secret: string,
    private readonly seedInput: string
  ) {}

  nextUnit(): number {
    if (this.offset + 8 > this.buffer.length) {
      this.buffer = createHmac("sha256", this.secret)
        .update(`${this.seedInput}|${this.counter}`)
        .digest();
      this.counter += 1;
      this.offset = 0;
    }
    const value = this.buffer.readBigUInt64BE(this.offset) >> 11n;
    this.offset += 8;
    return Number(value) / 0x20000000000000;
  }
}

function region(
  id: SamplingRegion["id"],
  minLat: number,
  maxLat: number,
  minLon: number,
  maxLon: number
): SamplingRegion {
  const radians = Math.PI / 180;
  return {
    id,
    minLat,
    maxLat,
    minLon,
    maxLon,
    areaWeight:
      (maxLon - minLon) *
      radians *
      (Math.sin(maxLat * radians) - Math.sin(minLat * radians))
  };
}

function selectRegion(value: number): SamplingRegion {
  let cursor = value * TOTAL_AREA_WEIGHT;
  for (const candidate of SAMPLING_REGIONS) {
    cursor -= candidate.areaWeight;
    if (cursor < 0) return candidate;
  }
  return SAMPLING_REGIONS[SAMPLING_REGIONS.length - 1]!;
}

function pointInRegion(region: SamplingRegion, lonUnit: number, latUnit: number): LatLon {
  const radians = Math.PI / 180;
  const minSin = Math.sin(region.minLat * radians);
  const maxSin = Math.sin(region.maxLat * radians);
  return {
    lat: Math.asin(minSin + (maxSin - minSin) * latUnit) / radians,
    lon: region.minLon + (region.maxLon - region.minLon) * lonUnit
  };
}

function landMaskVersion(
  environment: WorldGameplayEnvironmentResult,
  config: Pick<AppConfig, "WORLD_REQUIRED_RELEASE_ID" | "WORLD_REQUIRED_BOUNDARY_RELEASE_ID">
): string {
  const release = environment.release;
  return [
    release?.releaseId ?? config.WORLD_REQUIRED_RELEASE_ID,
    release?.boundaryReleaseId ?? config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID,
    environment.environmentSchemaVersion ?? environment.contractVersion
  ].join("|");
}

function worldIdentity(
  environment: WorldGameplayEnvironmentResult,
  config: Pick<AppConfig, "WORLD_ID" | "WORLD_REQUIRED_RELEASE_ID">
): string {
  return [
    config.WORLD_ID,
    environment.release?.releaseId ?? config.WORLD_REQUIRED_RELEASE_ID,
    environment.runtime?.sha ?? "runtime-unavailable"
  ].join("|");
}
