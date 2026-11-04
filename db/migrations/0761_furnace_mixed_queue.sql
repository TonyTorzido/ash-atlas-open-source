DROP INDEX furnace_smelt_jobs_current_idx;

CREATE INDEX furnace_smelt_jobs_queue_idx
  ON furnace_smelt_jobs (furnace_id, started_at, created_at, job_id)
  WHERE cleared_at IS NULL;
