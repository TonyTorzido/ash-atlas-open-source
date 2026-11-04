import type pg from "pg";

import type {
  ClaimedResourceVisionJob,
  DurableResourceVisionJobMetrics,
  ResourceVisionJobAdmission,
  ResourceVisionJobContract,
  ResourceVisionJobFailure,
  ResourceVisionJobPayload,
  ResourceVisionJobStatus,
  ResourceVisionJobStore
} from "./resourceVisionJobContracts.js";

export { resourceVisionJobIdentity } from "./resourceVisionJobContracts.js";
export type {
  ClaimedResourceVisionJob,
  DurableResourceVisionJobMetrics,
  ResourceVisionJobAdmission,
  ResourceVisionJobContract,
  ResourceVisionJobFailure,
  ResourceVisionJobPayload,
  ResourceVisionJobStatus,
  ResourceVisionJobStore
} from "./resourceVisionJobContracts.js";

export async function insertResourceVisionJobInTransaction(
  queryable: Pick<pg.PoolClient, "query">,
  job: ResourceVisionJobContract
): Promise<boolean> {
  const result = await queryable.query(
    `INSERT INTO resource_vision_jobs (
       job_key, flag_id, layout_version, radius_m, world_release_id,
       profile_set_fingerprint, build_contract_fingerprint, boundary_release_id,
       reason, priority, payload, status, next_retry_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'pending',now())
     ON CONFLICT (job_key) DO NOTHING`,
    [
      job.jobKey,
      job.flagId,
      job.layoutVersion,
      job.radiusM,
      job.worldReleaseId,
      job.profileSetFingerprint,
      job.buildContractFingerprint,
      job.boundaryReleaseId,
      job.payload.reason,
      job.priority,
      JSON.stringify(job.payload)
    ]
  );
  return result.rowCount === 1;
}

export class ResourceVisionJobCapacityError extends Error {
  readonly code = "RESOURCE_JOB_CAPACITY";

  constructor(readonly maximumPending: number) {
    super(`Resource preparation capacity is limited to ${maximumPending} durable jobs`);
    this.name = "ResourceVisionJobCapacityError";
  }
}

type JobRow = {
  job_key: string;
  flag_id: string;
  layout_version: string;
  radius_m: number;
  world_release_id: string;
  profile_set_fingerprint: string;
  build_contract_fingerprint: string;
  boundary_release_id: string;
  priority: number;
  payload: ResourceVisionJobPayload;
  status: ResourceVisionJobStatus;
  owner_id: string;
  owner_generation: string | number;
  attempt_count: number;
};

export class PostgresResourceVisionJobStore implements ResourceVisionJobStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly maximumPending: number,
    private readonly maximumAttempts = 8
  ) {}

  async status(jobKey: string): Promise<ResourceVisionJobStatus | null> {
    const result = await this.pool.query<{ status: ResourceVisionJobStatus }>(
      "SELECT status FROM resource_vision_jobs WHERE job_key = $1",
      [jobKey]
    );
    return result.rows[0]?.status ?? null;
  }

  async submit(job: ResourceVisionJobContract): Promise<ResourceVisionJobAdmission> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('resource-vision-job-admission-v1'))");
      const existing = await client.query<{
        status: ResourceVisionJobStatus;
        next_retry_at: Date | null;
        priority: number;
      }>(
        "SELECT status, next_retry_at, priority FROM resource_vision_jobs WHERE job_key = $1 FOR UPDATE",
        [job.jobKey]
      );
      const row = existing.rows[0];
      if (row) {
        if (row.status === "failed" && row.next_retry_at === null) {
          await client.query(
            `UPDATE resource_vision_jobs
             SET status = 'pending', attempt_count = 0, next_retry_at = now(), last_error = NULL,
                 owner_id = NULL, lease_expires_at = NULL, requested_at = now(),
                 reason = $2, priority = $3, payload = $4::jsonb
             WHERE job_key = $1`,
            [job.jobKey, job.payload.reason, job.priority, JSON.stringify(job.payload)]
          );
          await client.query("COMMIT");
          return { admitted: true, status: "pending" };
        }
        if (
          job.priority < Number(row.priority) &&
          (row.status === "pending" || row.status === "failed")
        ) {
          await client.query(
            `UPDATE resource_vision_jobs
             SET reason = $2, priority = $3, payload = $4::jsonb
             WHERE job_key = $1`,
            [job.jobKey, job.payload.reason, job.priority, JSON.stringify(job.payload)]
          );
        }
        await client.query("COMMIT");
        return { admitted: false, status: row.status };
      }

      const capacity = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM resource_vision_jobs
         WHERE status IN ('pending', 'processing')
            OR (status = 'failed' AND next_retry_at IS NOT NULL)`
      );
      if (Number(capacity.rows[0]?.count ?? 0) >= this.maximumPending) {
        throw new ResourceVisionJobCapacityError(this.maximumPending);
      }
      await insertResourceVisionJobInTransaction(client, job);
      await client.query("COMMIT");
      return { admitted: true, status: "pending" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(ownerId: string, leaseMs: number): Promise<ClaimedResourceVisionJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ job_key: string }>(
        `SELECT job_key FROM resource_vision_jobs
         WHERE (status = 'pending' AND next_retry_at <= now())
            OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= now())
            OR (status = 'processing' AND lease_expires_at < now() AND attempt_count < $1)
         ORDER BY priority ASC, requested_at ASC, job_key ASC
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [this.maximumAttempts]
      );
      const jobKey = selected.rows[0]?.job_key;
      if (!jobKey) {
        await client.query("COMMIT");
        return null;
      }
      const claimed = await client.query<JobRow>(
        `UPDATE resource_vision_jobs
         SET status = 'processing', owner_id = $2, owner_generation = owner_generation + 1,
             lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             attempt_count = attempt_count + 1, started_at = clock_timestamp(),
             next_retry_at = NULL
         WHERE job_key = $1
         RETURNING job_key, flag_id, layout_version, radius_m, world_release_id,
                   profile_set_fingerprint, build_contract_fingerprint, boundary_release_id,
                   priority, payload, status, owner_id, owner_generation, attempt_count`,
        [jobKey, ownerId, leaseMs]
      );
      await client.query("COMMIT");
      return claimed.rows[0] ? rowToClaimedJob(claimed.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimByKey(
    jobKey: string,
    ownerId: string,
    leaseMs: number
  ): Promise<ClaimedResourceVisionJob | null> {
    const result = await this.pool.query<JobRow>(
      `UPDATE resource_vision_jobs
       SET status = 'processing', owner_id = $2, owner_generation = owner_generation + 1,
           lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
           attempt_count = attempt_count + 1, started_at = clock_timestamp(),
           next_retry_at = NULL
       WHERE job_key = $1
         AND attempt_count < $4
         AND (
           (status = 'pending' AND next_retry_at <= now())
           OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= now())
           OR (status = 'processing' AND lease_expires_at < now())
         )
       RETURNING job_key, flag_id, layout_version, radius_m, world_release_id,
                 profile_set_fingerprint, build_contract_fingerprint, boundary_release_id,
                 priority, payload, status, owner_id, owner_generation, attempt_count`,
      [jobKey, ownerId, leaseMs, this.maximumAttempts]
    );
    return result.rows[0] ? rowToClaimedJob(result.rows[0]) : null;
  }

  async heartbeat(job: ClaimedResourceVisionJob, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE resource_vision_jobs
       SET lease_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond')
       WHERE job_key = $1 AND status = 'processing' AND owner_id = $2 AND owner_generation = $3`,
      [job.jobKey, job.ownerId, job.ownerGeneration, leaseMs]
    );
    return result.rowCount === 1;
  }

  async isOwned(job: ClaimedResourceVisionJob): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM resource_vision_jobs
       WHERE job_key = $1 AND status = 'processing' AND owner_id = $2
         AND owner_generation = $3 AND lease_expires_at > clock_timestamp()`,
      [job.jobKey, job.ownerId, job.ownerGeneration]
    );
    return result.rowCount === 1;
  }

  async complete(job: ClaimedResourceVisionJob): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE resource_vision_jobs
       SET status = 'completed', completed_at = clock_timestamp(), owner_id = NULL,
           lease_expires_at = NULL, next_retry_at = NULL, last_error = NULL
       WHERE job_key = $1 AND status = 'processing' AND owner_id = $2 AND owner_generation = $3`,
      [job.jobKey, job.ownerId, job.ownerGeneration]
    );
    return result.rowCount === 1;
  }

  async fail(
    job: ClaimedResourceVisionJob,
    error: unknown,
    maxAttempts: number
  ): Promise<ResourceVisionJobFailure> {
    const terminal = job.attemptCount >= maxAttempts;
    const result = await this.pool.query(
      `UPDATE resource_vision_jobs
       SET status = 'failed', owner_id = NULL, lease_expires_at = NULL,
           next_retry_at = CASE WHEN $4::boolean THEN NULL ELSE
             clock_timestamp() + (LEAST(60, POWER(2, LEAST(attempt_count, 6))) * interval '1 second')
           END,
           last_error = $5
       WHERE job_key = $1 AND status = 'processing' AND owner_id = $2 AND owner_generation = $3`,
      [job.jobKey, job.ownerId, job.ownerGeneration, terminal, errorSummary(error)]
    );
    return { accepted: result.rowCount === 1, terminal };
  }

  async recoverExpired(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE resource_vision_jobs
       SET status = 'failed', owner_id = NULL, lease_expires_at = NULL,
           next_retry_at = CASE WHEN attempt_count >= $1 THEN NULL ELSE now() END,
           last_error = COALESCE(last_error, 'worker lease expired')
       WHERE status = 'processing' AND lease_expires_at < now()`
      , [this.maximumAttempts]
    );
    return result.rowCount ?? 0;
  }

  async metrics(): Promise<DurableResourceVisionJobMetrics> {
    const result = await this.pool.query<{
      pending: string;
      processing: string;
      retrying: string;
      terminal_failed: string;
      completed: string;
      oldest_pending_age_ms: string;
      expired_leases: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'pending')::text AS pending,
         count(*) FILTER (WHERE status = 'processing')::text AS processing,
         count(*) FILTER (WHERE status = 'failed' AND next_retry_at IS NOT NULL)::text AS retrying,
         count(*) FILTER (WHERE status = 'failed' AND next_retry_at IS NULL)::text AS terminal_failed,
         count(*) FILTER (WHERE status = 'completed')::text AS completed,
         COALESCE(EXTRACT(epoch FROM (now() - min(requested_at) FILTER (
           WHERE status = 'pending' OR (status = 'failed' AND next_retry_at IS NOT NULL)
         ))) * 1000, 0)::text AS oldest_pending_age_ms,
         count(*) FILTER (WHERE status = 'processing' AND lease_expires_at < now())::text AS expired_leases
       FROM resource_vision_jobs`
    );
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      processing: Number(row?.processing ?? 0),
      retrying: Number(row?.retrying ?? 0),
      terminalFailed: Number(row?.terminal_failed ?? 0),
      completed: Number(row?.completed ?? 0),
      oldestPendingAgeMs: Number(row?.oldest_pending_age_ms ?? 0),
      expiredLeases: Number(row?.expired_leases ?? 0)
    };
  }
}

function rowToClaimedJob(row: JobRow): ClaimedResourceVisionJob {
  return {
    jobKey: row.job_key,
    flagId: row.flag_id,
    layoutVersion: row.layout_version,
    radiusM: Number(row.radius_m),
    worldReleaseId: row.world_release_id,
    profileSetFingerprint: row.profile_set_fingerprint,
    buildContractFingerprint: row.build_contract_fingerprint,
    boundaryReleaseId: row.boundary_release_id,
    priority: Number(row.priority),
    payload: row.payload,
    ownerId: row.owner_id,
    ownerGeneration: Number(row.owner_generation),
    attemptCount: Number(row.attempt_count)
  };
}

function errorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
