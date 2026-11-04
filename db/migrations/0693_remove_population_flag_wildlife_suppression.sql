CREATE TABLE IF NOT EXISTS population_flag_suppression_cleanup_jobs (
  job_key text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retrying', 'completed')),
  table_index smallint NOT NULL DEFAULT 0
    CHECK (table_index BETWEEN 0 AND 3),
  attempt_count integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_generation bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  rows_cleared bigint NOT NULL DEFAULT 0,
  batches_committed bigint NOT NULL DEFAULT 0,
  last_batch_duration_ms integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

INSERT INTO population_flag_suppression_cleanup_jobs (job_key)
VALUES ('remove-population-flag-wildlife-suppression-v1')
ON CONFLICT (job_key) DO NOTHING;
