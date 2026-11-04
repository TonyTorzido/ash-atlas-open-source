import { performance } from "node:perf_hooks";

import { classifyFlagPlacementTerrain } from "@ash-atlas/shared";

import { loadConfig, type AppConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { WorldLookupClient } from "../world/worldLookupClient.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import {
  INITIAL_SPAWN_COORDINATE_TOLERANCE,
  InitialSpawnSampler,
  type InitialSpawnAssignment
} from "./initialSpawn.js";

const DIAGNOSTIC_HMAC_KEY = "initial-spawn-diagnostic-v1-not-production";
const DIAGNOSTIC_WORLD_ID = "initial-spawn-diagnostic-v1";
const DIAGNOSTIC_CREATED_AT = new Date("2026-01-02T03:04:05.000Z");

type CoverageTarget =
  | "contiguous-us"
  | "alaska"
  | "alaska-west-aleutians"
  | "hawaii"
  | "washington-dc"
  | "corpus";

type DiagnosticCase = Readonly<{
  name: string;
  accountId: string;
  accountCreatedAt: Date;
  coverage: CoverageTarget;
}>;

type DiagnosticAssignment = Readonly<{
  name: string;
  accountId: string;
  accountCreatedAt: string;
  coverage: CoverageTarget;
  position: InitialSpawnAssignment["position"];
  region: InitialSpawnAssignment["region"];
  stateCode: string | null;
  candidateAttempts: number;
  rejectedCandidates: number;
  assignmentDurationMs: number;
  validationLookupDurationMs: number;
  packageId: string;
  worldReleaseId: string;
  boundaryReleaseId: string;
  runtimeSha: string | null;
  worldIdentity: string;
  landMaskVersion: string;
}>;

export type InitialSpawnDiagnosticReport = Readonly<{
  ok: true;
  assignmentCount: number;
  authority: {
    releaseId: string;
    boundaryReleaseId: string;
    profileSetFingerprint: string;
    buildContractFingerprint: string;
  };
  metrics: ReturnType<InitialSpawnSampler["metricsSnapshot"]>;
  assignments: readonly DiagnosticAssignment[];
}>;

const COVERAGE_CASES: readonly DiagnosticCase[] = [
  diagnosticCase(
    "contiguous-us-anchor",
    "00000000-0000-4d1a-8000-00000000227b",
    "contiguous-us"
  ),
  diagnosticCase(
    "hawaii-anchor",
    "00000000-0000-4d1a-8000-00000000d0dc",
    "hawaii"
  ),
  diagnosticCase(
    "alaska-anchor",
    "00000000-0000-4d1a-8000-00000000ff0a",
    "alaska"
  ),
  diagnosticCase(
    "western-aleutians-anchor",
    "00000000-0000-4d1a-8000-000000010b59",
    "alaska-west-aleutians"
  ),
  diagnosticCase(
    "washington-dc-anchor",
    "00000000-0000-4d1a-8000-0000000157c3",
    "washington-dc"
  )
];

const DIAGNOSTIC_CASES: readonly DiagnosticCase[] = [
  ...COVERAGE_CASES,
  ...Array.from({ length: 20 }, (_, index) => ({
    name: `deterministic-corpus-${String(index + 1).padStart(2, "0")}`,
    accountId:
      `00000000-0000-4d1a-8001-${(0x200000 + index).toString(16).padStart(12, "0")}`,
    accountCreatedAt: new Date(
      DIAGNOSTIC_CREATED_AT.getTime() + (index + 1) * 60_000
    ),
    coverage: "corpus" as const
  }))
];

export async function runInitialSpawnDiagnostic(
  config: AppConfig = loadConfig()
): Promise<InitialSpawnDiagnosticReport> {
  const logger = createLogger(config.NODE_ENV);
  const world = new WorldLookupClient(
    config.WORLD_API_BASE,
    logger,
    config.WORLD_LOOKUP_TIMEOUT_MS,
    {
      releaseId: config.WORLD_REQUIRED_RELEASE_ID,
      profileSetFingerprint: config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
      buildContractFingerprint: config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
      boundaryReleaseId: config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID
    },
    config.RESOURCE_ENVIRONMENT_BATCH_TIMEOUT_MS,
    {
      maxEntries: config.WORLD_WATER_CACHE_MAX_ENTRIES,
      maxBytes: config.WORLD_WATER_CACHE_MAX_BYTES,
      ttlMs: config.WORLD_WATER_CACHE_TTL_MS
    }
  );
  const authority = await world.verifyRequiredRelease();
  const sampler = new InitialSpawnSampler({
    INITIAL_SPAWN_HMAC_KEY: DIAGNOSTIC_HMAC_KEY,
    INITIAL_SPAWN_MAX_ATTEMPTS: config.INITIAL_SPAWN_MAX_ATTEMPTS,
    WORLD_ID: DIAGNOSTIC_WORLD_ID,
    WORLD_REQUIRED_RELEASE_ID: config.WORLD_REQUIRED_RELEASE_ID,
    WORLD_REQUIRED_BOUNDARY_RELEASE_ID: config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID
  }, world);
  const assignments: DiagnosticAssignment[] = [];

  for (const testCase of DIAGNOSTIC_CASES) {
    const assignment = await sampler.assign({
      accountId: testCase.accountId,
      accountCreatedAt: testCase.accountCreatedAt
    });
    const validationStartedAt = performance.now();
    const environment = await world.lookupGameplayEnvironment(
      assignment.position.lat,
      assignment.position.lon
    );
    const validationLookupDurationMs = performance.now() - validationStartedAt;
    assertValidFinalEnvironment(assignment, environment);
    const release = environment.release;
    if (!release) {
      throw new Error(`${testCase.name}: World response omitted release identity`);
    }
    assignments.push({
      name: testCase.name,
      accountId: testCase.accountId,
      accountCreatedAt: testCase.accountCreatedAt.toISOString(),
      coverage: testCase.coverage,
      position: assignment.position,
      region: assignment.region,
      stateCode: assignment.stateCode,
      candidateAttempts: assignment.rejectedCandidates + 1,
      rejectedCandidates: assignment.rejectedCandidates,
      assignmentDurationMs: assignment.durationMs,
      validationLookupDurationMs,
      packageId: environment.packageId!,
      worldReleaseId: release.releaseId,
      boundaryReleaseId: release.boundaryReleaseId,
      runtimeSha: environment.runtime?.sha ?? null,
      worldIdentity: assignment.worldIdentity,
      landMaskVersion: assignment.landMaskVersion
    });
  }

  assertCoverage(assignments);
  return {
    ok: true,
    assignmentCount: assignments.length,
    authority: {
      releaseId: authority.releaseId,
      boundaryReleaseId: authority.boundaryReleaseId,
      profileSetFingerprint: authority.profileSetFingerprint,
      buildContractFingerprint: authority.buildContractFingerprint
    },
    metrics: sampler.metricsSnapshot(),
    assignments
  };
}

function diagnosticCase(
  name: string,
  accountId: string,
  coverage: Exclude<CoverageTarget, "corpus">
): DiagnosticCase {
  return {
    name,
    accountId,
    accountCreatedAt: DIAGNOSTIC_CREATED_AT,
    coverage
  };
}

function assertValidFinalEnvironment(
  assignment: InitialSpawnAssignment,
  environment: WorldGameplayEnvironmentResult
): void {
  const failure = (message: string): never => {
    throw new Error(
      `${assignment.region} ${assignment.position.lat},${assignment.position.lon}: ${message}`
    );
  };
  if (!environment.ok) {
    failure(`World lookup failed closed (${environment.failure?.code ?? "unknown"})`);
  }
  if (environment.countryCode !== "US") {
    failure(`expected US country authority, received ${environment.countryCode ?? "none"}`);
  }
  if (
    Math.abs(environment.latitude - assignment.position.lat) >
    INITIAL_SPAWN_COORDINATE_TOLERANCE
  ) {
    failure("World latitude did not match the proposed latitude");
  }
  if (
    Math.abs(environment.longitude - assignment.position.lon) >
    INITIAL_SPAWN_COORDINATE_TOLERANCE
  ) {
    failure("World longitude did not match the proposed longitude");
  }
  if (classifyFlagPlacementTerrain(environment) !== "land") {
    failure("gameplay flag-placement classification rejected the final coordinate");
  }
  if (environment.isSaltwater === true) {
    failure("final coordinate is saltwater");
  }
  if (environment.insideMajorLake === true) {
    failure("final coordinate is inside a blocked major lake");
  }
  if (environment.flagPlacementWater?.blocked === true) {
    failure(`final coordinate is blocked by ${environment.flagPlacementWater.kind}`);
  }
  if (!environment.packageId) {
    failure("World response omitted package ID");
  }
}

function assertCoverage(assignments: readonly DiagnosticAssignment[]): void {
  const byCoverage = new Map(assignments.map((assignment) => [
    assignment.coverage,
    assignment
  ]));
  const contiguous = byCoverage.get("contiguous-us");
  if (contiguous?.region !== "contiguous-us") {
    throw new Error("diagnostic did not retain a contiguous-US land assignment");
  }
  const alaska = byCoverage.get("alaska");
  if (alaska?.region !== "alaska" || alaska.stateCode !== "US-AK") {
    throw new Error("diagnostic did not retain an Alaska land assignment");
  }
  const aleutians = byCoverage.get("alaska-west-aleutians");
  if (
    aleutians?.region !== "alaska-west-aleutians" ||
    aleutians.stateCode !== "US-AK" ||
    aleutians.position.lon < 170
  ) {
    throw new Error("diagnostic did not retain a western-Aleutians antimeridian assignment");
  }
  const hawaii = byCoverage.get("hawaii");
  if (hawaii?.region !== "hawaii" || hawaii.stateCode !== "US-HI") {
    throw new Error("diagnostic did not retain a Hawaii land assignment");
  }
  const district = byCoverage.get("washington-dc");
  if (
    district?.region !== "contiguous-us" ||
    district.stateCode !== "US-DC"
  ) {
    throw new Error("diagnostic did not retain a Washington, D.C. assignment");
  }
}

runInitialSpawnDiagnostic()
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
  })
  .catch((error: unknown) => {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, null, 2));
    process.exitCode = 1;
  });
