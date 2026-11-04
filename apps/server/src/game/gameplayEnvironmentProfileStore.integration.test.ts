import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LatLon } from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../db/migrate.js";
import type { WorldGameplayEnvironmentResult } from "../world/worldTypes.js";
import { GameplayEnvironmentProfileMaterializer } from "./gameplayEnvironmentProfileJobs.js";
import {
  worldEnvironmentProfileRequestForPoint,
  type WorldEnvironmentProfileRequest
} from "./gameplayEnvironmentProfiles.js";
import {
  PostgresWorldEnvironmentProfileStore,
  type ClaimedWorldEnvironmentProfileJob
} from "./gameplayEnvironmentProfileStore.js";

const databaseUrl = process.env.WORLD_ENVIRONMENT_PROFILE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const TARGET_MIGRATION = "0647_durable_world_environment_profiles.sql";
const identity = {
  releaseId: "world-packages-v1",
  profileSetFingerprint: "a".repeat(64),
  buildContractFingerprint: "b".repeat(64),
  boundaryReleaseId: "global-boundaries-v1"
};

describeDatabase("durable World environment profile PostgreSQL store", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
  const regionCode = `profile-test-${randomUUID()}`;
  const upgradeAreaId = `${regionCode}:upgrade-area`;
  const upgradeMobId = `${regionCode}:upgrade-deer`;
  const profileRequest = request(regionCode);
  const workerScope = {
    worldIdentityKey: profileRequest.worldIdentityKey,
    profileVersion: profileRequest.profileVersion,
    candidateSlotVersion: profileRequest.candidateSlotVersion
  };
  const first = new PostgresWorldEnvironmentProfileStore(pool, 8, workerScope);
  const second = new PostgresWorldEnvironmentProfileStore(pool, 8, workerScope);
  let previousMigrationsDirectory = "";
  let targetMigrationsDirectory = "";

  beforeAll(async () => {
    const migrationsDirectory = fileURLToPath(
      new URL("../../../../db/migrations/", import.meta.url)
    );
    previousMigrationsDirectory = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-pre-environment-profile-migrations-")
    );
    targetMigrationsDirectory = await mkdtemp(
      path.join(tmpdir(), "ash-atlas-environment-profile-target-migrations-")
    );
    for (const name of (await readdir(migrationsDirectory)).sort()) {
      if (!name.endsWith(".sql") || name > TARGET_MIGRATION) {
        continue;
      }
      await copyFile(
        path.join(migrationsDirectory, name),
        path.join(targetMigrationsDirectory, name)
      );
      if (name < TARGET_MIGRATION) {
        await copyFile(
          path.join(migrationsDirectory, name),
          path.join(previousMigrationsDirectory, name)
        );
      }
    }
    await runMigrations(databaseUrl!, { migrationsDirectory: previousMigrationsDirectory });
    await pool.query(
      `INSERT INTO environmental_population_areas (
         id,region_code,cell_x,cell_y,center_lat,center_lon
       ) VALUES ($1,$2,1,1,35,-106)`,
      [upgradeAreaId, regionCode]
    );
    await pool.query(
      `INSERT INTO generated_world_mobs (
         entity_id,encounter_id,mob_archetype,pack_id,
         source_population_area_id,source_generation,spawn_cell_id,region_code,
         lat,lon,geom,anchor_lat,anchor_lon,placement_version
       ) VALUES (
         $1,$2,'deer',NULL,$3,1,$4,$5,
         35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326),35,-106,
         'environment-population-mobs-v2'
       )`,
      [upgradeMobId, `${regionCode}:upgrade-encounter`, upgradeAreaId, `${regionCode}:1:1`, regionCode]
    );
    expect(await runMigrations(databaseUrl!, {
      migrationsDirectory: targetMigrationsDirectory
    })).toEqual([TARGET_MIGRATION]);
    expect(await runMigrations(databaseUrl!, {
      migrationsDirectory: targetMigrationsDirectory
    })).toEqual([]);
    const preserved = await pool.query<{
      entity_id: string;
      environment_world_identity_key: string | null;
      environment_snapshot: Record<string, unknown>;
    }>(
      `SELECT entity_id,environment_world_identity_key,environment_snapshot
       FROM generated_world_mobs WHERE entity_id=$1`,
      [upgradeMobId]
    );
    expect(preserved.rows).toEqual([{
      entity_id: upgradeMobId,
      environment_world_identity_key: null,
      environment_snapshot: {}
    }]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM world_environment_profile_jobs WHERE region_code=$1", [
      regionCode
    ]);
    await pool.query("DELETE FROM world_environment_cells WHERE region_code=$1", [
      regionCode
    ]);
    await pool.query("DELETE FROM generated_world_mobs WHERE entity_id=$1", [upgradeMobId]);
    await pool.query("DELETE FROM environmental_population_areas WHERE id=$1", [upgradeAreaId]);
    await pool.end();
    if (previousMigrationsDirectory) {
      await rm(previousMigrationsDirectory, { recursive: true, force: true });
    }
    if (targetMigrationsDirectory) {
      await rm(targetMigrationsDirectory, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent callers and fences an expired worker generation", async () => {
    const foreignRequest = worldEnvironmentProfileRequestForPoint({
      position: profileRequest.center,
      regionCode,
      worldIdentity: { ...identity, releaseId: "world-packages-v2" },
      sourceRuntimeSha: "2".repeat(40),
      priority: 0
    });
    await expect(first.submitJob(foreignRequest)).resolves.toMatchObject({
      created: true,
      status: "pending"
    });
    const admissions = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        (index % 2 === 0 ? first : second).submitJob(profileRequest)
      )
    );
    expect(admissions.filter((entry) => entry.created)).toHaveLength(1);

    const stale = await first.claimJob("worker-a", 100);
    expect(stale).not.toBeNull();
    expect(stale?.worldIdentityKey).toBe(profileRequest.worldIdentityKey);
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(await second.recoverExpiredJobs()).toBe(1);
    const replacement = await second.claimJob("worker-b", 5_000);
    expect(replacement?.ownerGeneration).toBe((stale?.ownerGeneration ?? 0) + 1);

    const profile = await materialize(replacement!);
    expect(await first.completeMaterialization(stale!, profile)).toBe(false);
    await expect(second.completeMaterialization(replacement!, {
      ...profile,
      worldIdentity: { ...profile.worldIdentity, releaseId: "world-packages-v2" }
    })).rejects.toThrow("does not match leased job");
    expect(await second.completeMaterialization(replacement!, profile)).toBe(true);
    await expect(first.findProfile(profileRequest)).resolves.toMatchObject({
      cellId: profileRequest.cellId,
      worldIdentityKey: profileRequest.worldIdentityKey,
      candidateSlots: expect.any(Array)
    });

    const runtimeOnlyChange: WorldEnvironmentProfileRequest = {
      ...profileRequest,
      sourceRuntimeSha: "9".repeat(40)
    };
    await expect(second.submitJob(runtimeOnlyChange)).resolves.toEqual({
      created: false,
      status: "ready"
    });
    await expect(second.findProfile(runtimeOnlyChange)).resolves.toMatchObject({
      sourceRuntimeSha: profile.sourceRuntimeSha
    });
    await expect(second.jobMetrics()).resolves.toEqual({
      pending: 0,
      leased: 0,
      retrying: 0,
      terminalFailed: 0,
      expiredLeases: 0,
      oldestPendingAgeMs: 0
    });
  });

  it("atomically backpressures population v2 profile admission at its durable cap", async () => {
    const capped = new PostgresWorldEnvironmentProfileStore(
      pool,
      8,
      workerScope,
      2
    );
    const requests = [10, 20, 30].map((latitude) => ({
      ...request(regionCode, { lat: latitude, lon: -100 }),
      reason: "population-v2:flag-travel"
    }));

    const admissions = await Promise.all(requests.map((entry) =>
      capped.submitJob(entry)
    ));

    expect(admissions.filter((entry) => entry.created)).toHaveLength(2);
    expect(admissions.filter((entry) => entry.admitted === false)).toEqual([
      { created: false, status: "pending", admitted: false }
    ]);
    const queued = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM world_environment_profile_jobs
       WHERE region_code=$1 AND reason LIKE 'population-v2:%'`,
      [regionCode]
    );
    expect(Number(queued.rows[0]?.count)).toBe(2);
  });

  it("terminalizes only regenerable population profile jobs and preserves ready cells", async () => {
    await expect(first.supersedePopulationV2Jobs(
      "superseded by population-zone-plan-compiler-v3"
    )).resolves.toBe(2);

    const populationJobs = await pool.query<{
      status: string;
      last_error: string | null;
    }>(
      `SELECT status,last_error
       FROM world_environment_profile_jobs
       WHERE region_code=$1 AND reason LIKE 'population-v2:%'
       ORDER BY job_key`,
      [regionCode]
    );
    expect(populationJobs.rows).toHaveLength(2);
    expect(populationJobs.rows.every((row) =>
      row.status === "terminal-failure"
      && row.last_error === "superseded by population-zone-plan-compiler-v3"
    )).toBe(true);
    await expect(first.findProfile(profileRequest)).resolves.toMatchObject({
      cellId: profileRequest.cellId,
      worldIdentityKey: profileRequest.worldIdentityKey
    });
    const unrelated = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM world_environment_profile_jobs
       WHERE region_code=$1
         AND reason NOT LIKE 'population-v2:%'
         AND status <> 'terminal-failure'`,
      [regionCode]
    );
    expect(Number(unrelated.rows[0]?.count)).toBeGreaterThan(0);
  });
});

function request(
  regionCode: string,
  position = { lat: 35.0844, lon: -106.6504 }
): WorldEnvironmentProfileRequest {
  return worldEnvironmentProfileRequestForPoint({
    position,
    regionCode,
    worldIdentity: identity,
    sourceRuntimeSha: "1".repeat(40)
  });
}

async function materialize(job: ClaimedWorldEnvironmentProfileJob) {
  return new GameplayEnvironmentProfileMaterializer({
    lookupGameplayEnvironments: vi.fn(async (points: readonly LatLon[]) =>
      points.map((point) => compactResult(point, job))
    )
  }).materialize(job);
}

function compactResult(
  point: LatLon,
  job: ClaimedWorldEnvironmentProfileJob
): WorldGameplayEnvironmentResult {
  return {
    ok: true,
    contractVersion: "gameplay-environment-v1",
    runtime: { sha: "c".repeat(40), branch: "main" },
    packageId: "package-1",
    latitude: point.lat,
    longitude: point.lon,
    countryId: "country-1",
    countryName: "Test Country",
    countryCode: "TC",
    regionId: "region-1",
    regionName: "Test Region",
    regionCode: "TR",
    settlementId: null,
    settlementName: null,
    elevationM: 125,
    elevationBand: "lowland",
    terrainClass: "forest",
    landCoverClass: "forest",
    biome: "Temperate Forest",
    biomeName: "Temperate Forest",
    biomeId: "temperate-forest",
    ecoregion: "Test Ecoregion",
    ecoregionName: "Test Ecoregion",
    ecoregionId: "ecoregion-1",
    isLand: true,
    isSaltwater: false,
    isCoastalLand: false,
    isRiverbank: false,
    isLakeshore: false,
    isCoastal: false,
    insideMajorLake: false,
    majorLakeId: null,
    majorLakeName: null,
    majorLakeDistanceM: null,
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
      sourceId: null,
      sourceName: null,
      distanceM: null,
      corridorRadiusM: null,
      reason: "authoritative land",
      resolution: "exact",
      releaseId: job.worldIdentity.releaseId
    },
    release: { ...job.worldIdentity, packageCount: 1 },
    raw: {}
  };
}
