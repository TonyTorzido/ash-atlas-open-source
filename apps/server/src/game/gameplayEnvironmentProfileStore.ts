import type pg from "pg";

import {
  worldEnvironmentIdentityKey,
  worldEnvironmentProfileJobKey,
  type CompactGameplayEnvironmentFacts,
  type WorldEnvironmentCandidateSlot,
  type WorldEnvironmentCellProfile,
  type WorldEnvironmentProfileJobAdmission,
  type WorldEnvironmentProfileJobStatus,
  type WorldEnvironmentProfilePersistence,
  type WorldEnvironmentProfileRequest
} from "./gameplayEnvironmentProfiles.js";

export type ClaimedWorldEnvironmentProfileJob = WorldEnvironmentProfileRequest & Readonly<{
  jobKey: string;
  ownerId: string;
  ownerGeneration: number;
  attemptCount: number;
}>;

export type WorldEnvironmentProfileJobFailure = Readonly<{
  accepted: boolean;
  terminal: boolean;
}>;

export type WorldEnvironmentProfileJobMetrics = Readonly<{
  pending: number;
  leased: number;
  retrying: number;
  terminalFailed: number;
  expiredLeases: number;
  oldestPendingAgeMs: number;
}>;

export type WorldEnvironmentProfileWorkerScope = Readonly<{
  worldIdentityKey: string;
  profileVersion: string;
  candidateSlotVersion: string;
}>;

export interface WorldEnvironmentProfileJobStore extends WorldEnvironmentProfilePersistence {
  claimJob(ownerId: string, leaseMs: number): Promise<ClaimedWorldEnvironmentProfileJob | null>;
  heartbeatJob(job: ClaimedWorldEnvironmentProfileJob, leaseMs: number): Promise<boolean>;
  completeMaterialization(
    job: ClaimedWorldEnvironmentProfileJob,
    profile: WorldEnvironmentCellProfile
  ): Promise<boolean>;
  failJob(
    job: ClaimedWorldEnvironmentProfileJob,
    error: unknown
  ): Promise<WorldEnvironmentProfileJobFailure>;
  recoverExpiredJobs(): Promise<number>;
  jobMetrics(): Promise<WorldEnvironmentProfileJobMetrics>;
}

type JobRow = {
  job_key: string;
  world_identity_key: string;
  release_id: string;
  profile_set_fingerprint: string;
  build_contract_fingerprint: string;
  boundary_release_id: string;
  profile_version: string;
  candidate_slot_version: string;
  source_runtime_sha: string;
  cell_id: string;
  region_code: string;
  center_lat: string | number;
  center_lon: string | number;
  reason: string;
  priority: string | number;
  owner_id: string;
  owner_generation: string | number;
  attempt_count: string | number;
};

type ProfileRow = {
  world_identity_key: string;
  release_id: string;
  profile_set_fingerprint: string;
  build_contract_fingerprint: string;
  boundary_release_id: string;
  profile_version: string;
  candidate_slot_version: string;
  source_runtime_sha: string;
  cell_id: string;
  region_code: string;
  center_lat: string | number;
  center_lon: string | number;
  package_id: string | null;
  country_id: string | null;
  country_name: string | null;
  region_id: string | null;
  region_name: string | null;
  settlement_id: string | null;
  settlement_name: string | null;
  biome_id: string | null;
  biome_name: string | null;
  ecoregion_id: string | null;
  ecoregion_name: string | null;
  land_cover_class: string | null;
  terrain_class: string | null;
  elevation_m: string | number | null;
  elevation_band: string | null;
  is_land: boolean;
  is_saltwater: boolean;
  inside_major_lake: boolean;
  is_coastal: boolean | null;
  spawn_profile_key: string;
  spawn_rules_version: string;
  environment_profile: CompactGameplayEnvironmentFacts;
  candidate_slots: WorldEnvironmentCandidateSlot[];
  created_at: Date | string;
};

export class WorldEnvironmentProfileConflictError extends Error {
  constructor(readonly cellId: string) {
    super(`immutable World environment profile conflict for ${cellId}`);
    this.name = "WorldEnvironmentProfileConflictError";
  }
}

export class PostgresWorldEnvironmentProfileStore implements WorldEnvironmentProfileJobStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly maximumAttempts: number,
    private readonly workerScope: WorldEnvironmentProfileWorkerScope,
    private readonly populationV2QueueMaximum = 256
  ) {
    if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 32) {
      throw new Error("environment profile maximum attempts must be an integer from 1 through 32");
    }
    if (
      !/^[a-f0-9]{64}$/.test(workerScope.worldIdentityKey) ||
      workerScope.profileVersion.length === 0 ||
      workerScope.candidateSlotVersion.length === 0
    ) {
      throw new Error("environment profile worker scope must contain exact immutable identities");
    }
    if (
      !Number.isInteger(populationV2QueueMaximum)
      || populationV2QueueMaximum < 1
    ) {
      throw new Error("population v2 profile queue maximum must be positive");
    }
  }

  async findProfile(
    request: WorldEnvironmentProfileRequest
  ): Promise<WorldEnvironmentCellProfile | null> {
    validateRequest(request);
    return findProfile(this.pool, request);
  }

  async supersedePopulationV2Jobs(reason: string): Promise<number> {
    if (reason.trim().length === 0 || reason.length > 500) {
      throw new Error("population profile-job supersession reason is invalid");
    }
    const result = await this.pool.query(
      `UPDATE world_environment_profile_jobs
       SET status='terminal-failure',
           owner_id=NULL,
           lease_expires_at=NULL,
           next_retry_at=NULL,
           last_error=$1,
           updated_at=clock_timestamp()
       WHERE reason LIKE 'population-v2:%'
         AND status IN ('pending','leased','retryable-failure')`,
      [reason]
    );
    return result.rowCount ?? 0;
  }

  async submitJob(
    request: WorldEnvironmentProfileRequest
  ): Promise<WorldEnvironmentProfileJobAdmission> {
    validateRequest(request);
    if (request.reason.startsWith("population-v2:")) {
      return this.submitPopulationV2Job(request);
    }
    const inserted = await this.pool.query<{ status: WorldEnvironmentProfileJobStatus }>(
      `INSERT INTO world_environment_profile_jobs (
         job_key, world_identity_key, release_id, profile_set_fingerprint,
         build_contract_fingerprint, boundary_release_id, profile_version,
         candidate_slot_version, source_runtime_sha, cell_id, region_code,
         center_lat, center_lon, reason, priority, status, next_retry_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',clock_timestamp()
       )
       ON CONFLICT DO NOTHING
       RETURNING status`,
      jobParameters(request)
    );
    if (inserted.rows[0]) {
      return { created: true, status: inserted.rows[0].status };
    }
    const existing = await this.pool.query<{ status: WorldEnvironmentProfileJobStatus }>(
      `SELECT status
       FROM world_environment_profile_jobs
       WHERE world_identity_key=$1 AND profile_version=$2
         AND candidate_slot_version=$3 AND cell_id=$4`,
      [
        request.worldIdentityKey,
        request.profileVersion,
        request.candidateSlotVersion,
        request.cellId
      ]
    );
    const status = existing.rows[0]?.status;
    if (!status) {
      throw new Error(`environment profile job admission lost ${worldEnvironmentProfileJobKey(request)}`);
    }
    return { created: false, status };
  }

  private async submitPopulationV2Job(
    request: WorldEnvironmentProfileRequest
  ): Promise<WorldEnvironmentProfileJobAdmission> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('population-v2-profile-admission-v1'))"
      );
      const existing = await client.query<{
        status: WorldEnvironmentProfileJobStatus;
      }>(
        `SELECT status
         FROM world_environment_profile_jobs
         WHERE world_identity_key=$1 AND profile_version=$2
           AND candidate_slot_version=$3 AND cell_id=$4`,
        [
          request.worldIdentityKey,
          request.profileVersion,
          request.candidateSlotVersion,
          request.cellId
        ]
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { created: false, status: existing.rows[0].status };
      }
      const queued = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM world_environment_profile_jobs
         WHERE reason LIKE 'population-v2:%'
           AND status IN ('pending', 'leased', 'retryable-failure')`
      );
      if (Number(queued.rows[0]?.count ?? 0) >= this.populationV2QueueMaximum) {
        await client.query("COMMIT");
        return { created: false, status: "pending", admitted: false };
      }
      const inserted = await client.query<{
        status: WorldEnvironmentProfileJobStatus;
      }>(
        `INSERT INTO world_environment_profile_jobs (
           job_key, world_identity_key, release_id, profile_set_fingerprint,
           build_contract_fingerprint, boundary_release_id, profile_version,
           candidate_slot_version, source_runtime_sha, cell_id, region_code,
           center_lat, center_lon, reason, priority, status, next_retry_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',clock_timestamp()
         )
         RETURNING status`,
        jobParameters(request)
      );
      await client.query("COMMIT");
      return { created: true, status: inserted.rows[0]!.status };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimJob(
    ownerId: string,
    leaseMs: number
  ): Promise<ClaimedWorldEnvironmentProfileJob | null> {
    if (ownerId.length === 0) throw new Error("environment profile owner must not be empty");
    validateLease(leaseMs);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ job_key: string }>(
        `SELECT job_key
         FROM world_environment_profile_jobs
         WHERE world_identity_key=$2
           AND profile_version=$3
           AND candidate_slot_version=$4
           AND (
             (
               status IN ('pending', 'retryable-failure')
               AND next_retry_at <= clock_timestamp()
             )
             OR (
               status = 'leased'
               AND lease_expires_at <= clock_timestamp()
               AND attempt_count < $1
             )
           )
         ORDER BY priority ASC, requested_at ASC, job_key ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [
          this.maximumAttempts,
          this.workerScope.worldIdentityKey,
          this.workerScope.profileVersion,
          this.workerScope.candidateSlotVersion
        ]
      );
      const jobKey = selected.rows[0]?.job_key;
      if (!jobKey) {
        await client.query("COMMIT");
        return null;
      }
      const claimed = await client.query<JobRow>(
        `UPDATE world_environment_profile_jobs
         SET status='leased',
             owner_id=$2,
             owner_generation=owner_generation + 1,
             lease_expires_at=clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             attempt_count=attempt_count + 1,
             next_retry_at=NULL,
             started_at=clock_timestamp(),
             last_error=NULL
         WHERE job_key=$1
         RETURNING job_key, world_identity_key, release_id, profile_set_fingerprint,
                   build_contract_fingerprint, boundary_release_id, profile_version,
                   candidate_slot_version, source_runtime_sha, cell_id, region_code,
                   center_lat, center_lon, reason, priority, owner_id,
                   owner_generation, attempt_count`,
        [jobKey, ownerId, leaseMs]
      );
      await client.query("COMMIT");
      return claimed.rows[0] ? rowToClaimedJob(claimed.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeatJob(job: ClaimedWorldEnvironmentProfileJob, leaseMs: number): Promise<boolean> {
    validateLease(leaseMs);
    const result = await this.pool.query(
      `UPDATE world_environment_profile_jobs
       SET lease_expires_at=clock_timestamp() + ($4::bigint * interval '1 millisecond')
       WHERE job_key=$1 AND status='leased' AND owner_id=$2 AND owner_generation=$3
         AND lease_expires_at > clock_timestamp()`,
      [job.jobKey, job.ownerId, job.ownerGeneration, leaseMs]
    );
    return result.rowCount === 1;
  }

  async completeMaterialization(
    job: ClaimedWorldEnvironmentProfileJob,
    profile: WorldEnvironmentCellProfile
  ): Promise<boolean> {
    validateProfileForJob(job, profile);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ownership = await client.query(
        `SELECT 1
         FROM world_environment_profile_jobs
         WHERE job_key=$1 AND status='leased' AND owner_id=$2 AND owner_generation=$3
           AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [job.jobKey, job.ownerId, job.ownerGeneration]
      );
      if (ownership.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      const inserted = await insertProfile(client, profile);
      if (!inserted) {
        const existing = await findProfile(client, job);
        if (!existing || profileContentFingerprint(existing) !== profileContentFingerprint(profile)) {
          throw new WorldEnvironmentProfileConflictError(job.cellId);
        }
      }
      const completed = await client.query(
        `UPDATE world_environment_profile_jobs
         SET status='ready',
             owner_id=NULL,
             lease_expires_at=NULL,
             next_retry_at=NULL,
             last_error=NULL,
             completed_at=clock_timestamp()
         WHERE job_key=$1 AND status='leased' AND owner_id=$2 AND owner_generation=$3`,
        [job.jobKey, job.ownerId, job.ownerGeneration]
      );
      if (completed.rowCount !== 1) {
        throw new Error(`environment profile job ${job.jobKey} lost completion ownership`);
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async failJob(
    job: ClaimedWorldEnvironmentProfileJob,
    error: unknown
  ): Promise<WorldEnvironmentProfileJobFailure> {
    const terminal = job.attemptCount >= this.maximumAttempts;
    const result = await this.pool.query(
      `UPDATE world_environment_profile_jobs
       SET status=CASE WHEN $4::boolean THEN 'terminal-failure' ELSE 'retryable-failure' END,
           owner_id=NULL,
           lease_expires_at=NULL,
           next_retry_at=CASE
             WHEN $4::boolean THEN NULL
             ELSE clock_timestamp() +
               (LEAST(60, POWER(2, LEAST(attempt_count, 6))) * interval '1 second')
           END,
           last_error=$5
       WHERE job_key=$1 AND status='leased' AND owner_id=$2 AND owner_generation=$3
         AND lease_expires_at > clock_timestamp()`,
      [job.jobKey, job.ownerId, job.ownerGeneration, terminal, errorSummary(error)]
    );
    return { accepted: result.rowCount === 1, terminal };
  }

  async recoverExpiredJobs(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE world_environment_profile_jobs
       SET status=CASE
             WHEN attempt_count >= $1 THEN 'terminal-failure'
             ELSE 'retryable-failure'
           END,
           owner_id=NULL,
           lease_expires_at=NULL,
           next_retry_at=CASE
             WHEN attempt_count >= $1 THEN NULL
             ELSE clock_timestamp()
           END,
           last_error=COALESCE(last_error, 'worker lease expired')
       WHERE status='leased' AND lease_expires_at <= clock_timestamp()
         AND world_identity_key=$2
         AND profile_version=$3
         AND candidate_slot_version=$4`,
      [
        this.maximumAttempts,
        this.workerScope.worldIdentityKey,
        this.workerScope.profileVersion,
        this.workerScope.candidateSlotVersion
      ]
    );
    return result.rowCount ?? 0;
  }

  async jobMetrics(): Promise<WorldEnvironmentProfileJobMetrics> {
    const result = await this.pool.query<{
      pending: string;
      leased: string;
      retrying: string;
      terminal_failed: string;
      expired_leases: string;
      oldest_pending_age_ms: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status='pending')::text AS pending,
         count(*) FILTER (WHERE status='leased')::text AS leased,
         count(*) FILTER (WHERE status='retryable-failure')::text AS retrying,
         count(*) FILTER (WHERE status='terminal-failure')::text AS terminal_failed,
         count(*) FILTER (
           WHERE status='leased' AND lease_expires_at <= clock_timestamp()
         )::text AS expired_leases,
         COALESCE(EXTRACT(epoch FROM (
           clock_timestamp() - min(requested_at) FILTER (
             WHERE status IN ('pending', 'retryable-failure')
           )
         )) * 1000, 0)::text AS oldest_pending_age_ms
       FROM world_environment_profile_jobs
       WHERE status <> 'ready'
         AND world_identity_key=$1
         AND profile_version=$2
         AND candidate_slot_version=$3`,
      [
        this.workerScope.worldIdentityKey,
        this.workerScope.profileVersion,
        this.workerScope.candidateSlotVersion
      ]
    );
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      leased: Number(row?.leased ?? 0),
      retrying: Number(row?.retrying ?? 0),
      terminalFailed: Number(row?.terminal_failed ?? 0),
      expiredLeases: Number(row?.expired_leases ?? 0),
      oldestPendingAgeMs: Number(row?.oldest_pending_age_ms ?? 0)
    };
  }
}

async function findProfile(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  request: Pick<
    WorldEnvironmentProfileRequest,
    "worldIdentityKey" | "profileVersion" | "candidateSlotVersion" | "cellId"
  >
): Promise<WorldEnvironmentCellProfile | null> {
  const result = await queryable.query<ProfileRow>(
    `SELECT world_identity_key, release_id, profile_set_fingerprint,
            build_contract_fingerprint, boundary_release_id, profile_version,
            candidate_slot_version, source_runtime_sha, cell_id, region_code,
            center_lat, center_lon, package_id, country_id, country_name,
            region_id, region_name, settlement_id, settlement_name, biome_id,
            biome_name, ecoregion_id, ecoregion_name, land_cover_class,
            terrain_class, elevation_m, elevation_band, is_land, is_saltwater,
            inside_major_lake, is_coastal, spawn_profile_key, spawn_rules_version,
            environment_profile, candidate_slots, created_at
     FROM world_environment_cells
     WHERE world_identity_key=$1 AND profile_version=$2
       AND candidate_slot_version=$3 AND cell_id=$4`,
    [
      request.worldIdentityKey,
      request.profileVersion,
      request.candidateSlotVersion,
      request.cellId
    ]
  );
  return result.rows[0] ? rowToProfile(result.rows[0]) : null;
}

async function insertProfile(
  queryable: Pick<pg.PoolClient, "query">,
  profile: WorldEnvironmentCellProfile
): Promise<boolean> {
  const result = await queryable.query(
    `INSERT INTO world_environment_cells (
       world_identity_key, release_id, profile_set_fingerprint,
       build_contract_fingerprint, boundary_release_id, profile_version,
       candidate_slot_version, source_runtime_sha, cell_id, region_code,
       center_lat, center_lon, center_geom, package_id, country_id, country_name,
       region_id, region_name, settlement_id, settlement_name, biome_id, biome_name,
       ecoregion_id, ecoregion_name, land_cover_class, terrain_class, elevation_m,
       elevation_band, is_land, is_saltwater, inside_major_lake, is_coastal,
       spawn_profile_key, spawn_rules_version, environment_profile, candidate_slots,
       created_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
       ST_SetSRID(ST_MakePoint($12,$11),4326),
       $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
       $30,$31,$32,$33,$34::jsonb,$35::jsonb,$36::timestamptz,$36::timestamptz
     )
     ON CONFLICT (world_identity_key, profile_version, candidate_slot_version, cell_id)
     DO NOTHING`,
    [
      profile.worldIdentityKey,
      profile.worldIdentity.releaseId,
      profile.worldIdentity.profileSetFingerprint,
      profile.worldIdentity.buildContractFingerprint,
      profile.worldIdentity.boundaryReleaseId,
      profile.profileVersion,
      profile.candidateSlotVersion,
      profile.sourceRuntimeSha,
      profile.cellId,
      profile.regionCode,
      profile.centerLat,
      profile.centerLon,
      profile.packageId,
      profile.countryId,
      profile.countryName,
      profile.regionId,
      profile.regionName,
      profile.settlementId,
      profile.settlementName,
      profile.biomeId,
      profile.biomeName,
      profile.ecoregionId,
      profile.ecoregionName,
      profile.landCoverClass,
      profile.terrainClass,
      profile.elevationM,
      profile.elevationBand,
      profile.isLand,
      profile.isSaltwater,
      profile.insideMajorLake,
      profile.isCoastal,
      profile.spawnProfileKey,
      profile.spawnRulesVersion,
      JSON.stringify(profile.environmentProfile),
      JSON.stringify(profile.candidateSlots),
      profile.createdAt
    ]
  );
  return result.rowCount === 1;
}

function jobParameters(request: WorldEnvironmentProfileRequest): unknown[] {
  return [
    worldEnvironmentProfileJobKey(request),
    request.worldIdentityKey,
    request.worldIdentity.releaseId,
    request.worldIdentity.profileSetFingerprint,
    request.worldIdentity.buildContractFingerprint,
    request.worldIdentity.boundaryReleaseId,
    request.profileVersion,
    request.candidateSlotVersion,
    request.sourceRuntimeSha,
    request.cellId,
    request.regionCode,
    request.center.lat,
    request.center.lon,
    request.reason,
    request.priority
  ];
}

function rowToClaimedJob(row: JobRow): ClaimedWorldEnvironmentProfileJob {
  return {
    jobKey: row.job_key,
    cellId: row.cell_id,
    worldIdentityKey: row.world_identity_key,
    worldIdentity: {
      releaseId: row.release_id,
      profileSetFingerprint: row.profile_set_fingerprint,
      buildContractFingerprint: row.build_contract_fingerprint,
      boundaryReleaseId: row.boundary_release_id
    },
    profileVersion: row.profile_version,
    candidateSlotVersion: row.candidate_slot_version,
    sourceRuntimeSha: row.source_runtime_sha,
    regionCode: row.region_code,
    center: { lat: Number(row.center_lat), lon: Number(row.center_lon) },
    reason: row.reason,
    priority: Number(row.priority),
    ownerId: row.owner_id,
    ownerGeneration: Number(row.owner_generation),
    attemptCount: Number(row.attempt_count)
  };
}

function rowToProfile(row: ProfileRow): WorldEnvironmentCellProfile {
  return {
    cellId: row.cell_id,
    worldIdentityKey: row.world_identity_key,
    worldIdentity: {
      releaseId: row.release_id,
      profileSetFingerprint: row.profile_set_fingerprint,
      buildContractFingerprint: row.build_contract_fingerprint,
      boundaryReleaseId: row.boundary_release_id
    },
    profileVersion: row.profile_version,
    candidateSlotVersion: row.candidate_slot_version,
    sourceRuntimeSha: row.source_runtime_sha,
    regionCode: row.region_code,
    centerLat: Number(row.center_lat),
    centerLon: Number(row.center_lon),
    packageId: row.package_id,
    countryId: row.country_id,
    countryName: row.country_name,
    regionId: row.region_id,
    regionName: row.region_name,
    settlementId: row.settlement_id,
    settlementName: row.settlement_name,
    biomeId: row.biome_id,
    biomeName: row.biome_name,
    ecoregionId: row.ecoregion_id,
    ecoregionName: row.ecoregion_name,
    landCoverClass: row.land_cover_class,
    terrainClass: row.terrain_class,
    elevationM: row.elevation_m === null ? null : Number(row.elevation_m),
    elevationBand: row.elevation_band,
    isLand: row.is_land,
    isSaltwater: row.is_saltwater,
    insideMajorLake: row.inside_major_lake,
    // Riverbank/lakeshore are additive facts stored in the immutable compact
    // environment snapshot; keep the profile-level projection in lockstep
    // without introducing a second mutable authority column.
    isRiverbank: row.environment_profile.isRiverbank,
    isLakeshore: row.environment_profile.isLakeshore,
    isCoastal: row.is_coastal,
    spawnProfileKey: row.spawn_profile_key,
    spawnRulesVersion: row.spawn_rules_version,
    environmentProfile: row.environment_profile,
    candidateSlots: row.candidate_slots,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function validateRequest(request: WorldEnvironmentProfileRequest): void {
  if (request.worldIdentityKey !== worldEnvironmentIdentityKey(request.worldIdentity)) {
    throw new Error("World environment request identity key does not match its immutable fields");
  }
}

function validateProfileForJob(
  job: ClaimedWorldEnvironmentProfileJob,
  profile: WorldEnvironmentCellProfile
): void {
  validateRequest(job);
  const profileIdentityKey = worldEnvironmentIdentityKey(profile.worldIdentity);
  if (
    profileIdentityKey !== profile.worldIdentityKey ||
    profile.worldIdentityKey !== job.worldIdentityKey ||
    profile.worldIdentity.releaseId !== job.worldIdentity.releaseId ||
    profile.worldIdentity.profileSetFingerprint !== job.worldIdentity.profileSetFingerprint ||
    profile.worldIdentity.buildContractFingerprint !== job.worldIdentity.buildContractFingerprint ||
    profile.worldIdentity.boundaryReleaseId !== job.worldIdentity.boundaryReleaseId ||
    profile.profileVersion !== job.profileVersion ||
    profile.candidateSlotVersion !== job.candidateSlotVersion ||
    profile.cellId !== job.cellId ||
    profile.regionCode !== job.regionCode ||
    profile.centerLat !== job.center.lat ||
    profile.centerLon !== job.center.lon ||
    profile.environmentProfile.latitude !== job.center.lat ||
    profile.environmentProfile.longitude !== job.center.lon ||
    profile.isRiverbank !== profile.environmentProfile.isRiverbank ||
    profile.isLakeshore !== profile.environmentProfile.isLakeshore
  ) {
    throw new Error(`materialized profile does not match leased job ${job.jobKey}`);
  }
  if (profile.candidateSlots.length < 96 || profile.candidateSlots.length > 128) {
    throw new Error("materialized environment profile must contain 96 through 128 candidate slots");
  }
}

function profileContentFingerprint(profile: WorldEnvironmentCellProfile): string {
  return canonicalJson(Object.fromEntries(
    Object.entries(profile).filter(([key]) => key !== "sourceRuntimeSha" && key !== "createdAt")
  ));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validateLease(leaseMs: number): void {
  if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 15 * 60_000) {
    throw new Error("environment profile lease must be 100ms through 15 minutes");
  }
}

function errorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
