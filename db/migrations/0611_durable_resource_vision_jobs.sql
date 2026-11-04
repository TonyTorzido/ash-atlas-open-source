CREATE TABLE IF NOT EXISTS resource_vision_jobs (
  job_key text PRIMARY KEY,
  flag_id uuid NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  layout_version text NOT NULL,
  radius_m double precision NOT NULL CHECK (radius_m > 0),
  world_release_id text NOT NULL,
  profile_set_fingerprint text NOT NULL CHECK (profile_set_fingerprint ~ '^[a-f0-9]{64}$'),
  build_contract_fingerprint text NOT NULL CHECK (build_contract_fingerprint ~ '^[a-f0-9]{64}$'),
  boundary_release_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('flag-build', 'flag-created', 'flag-visit', 'dev-prewarm')),
  priority smallint NOT NULL CHECK (priority BETWEEN 0 AND 3),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  owner_id text NULL,
  owner_generation bigint NOT NULL DEFAULT 0 CHECK (owner_generation >= 0),
  lease_expires_at timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at timestamptz NULL,
  last_error text NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'processing' AND owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'processing'
  )
);

CREATE INDEX IF NOT EXISTS resource_vision_jobs_claim_idx
  ON resource_vision_jobs (priority, next_retry_at, requested_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS resource_vision_jobs_expired_lease_idx
  ON resource_vision_jobs (lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS resource_vision_jobs_flag_contract_idx
  ON resource_vision_jobs (flag_id, layout_version, radius_m, world_release_id);

DROP TRIGGER IF EXISTS resource_vision_jobs_set_updated_at ON resource_vision_jobs;
CREATE TRIGGER resource_vision_jobs_set_updated_at
BEFORE UPDATE ON resource_vision_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE resource_vision_jobs IS
  'Durable, leased, release-keyed ownership for resource-vision preparation and publication.';
