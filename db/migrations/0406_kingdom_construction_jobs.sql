ALTER TABLE kingdom_cots
  ADD COLUMN IF NOT EXISTS construction_state text NOT NULL DEFAULT 'complete',
  ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL DEFAULT now();

ALTER TABLE kingdom_decorations
  ADD COLUMN IF NOT EXISTS construction_state text NOT NULL DEFAULT 'complete',
  ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL DEFAULT now();

ALTER TABLE kingdom_cots ALTER COLUMN completed_at SET DEFAULT now();
ALTER TABLE kingdom_decorations ALTER COLUMN completed_at SET DEFAULT now();

UPDATE kingdom_cots SET completed_at = COALESCE(completed_at, created_at)
WHERE construction_state = 'complete';
UPDATE kingdom_decorations SET completed_at = COALESCE(completed_at, created_at)
WHERE construction_state = 'complete';

ALTER TABLE kingdom_cots
  DROP CONSTRAINT IF EXISTS kingdom_cots_construction_state_valid,
  ADD CONSTRAINT kingdom_cots_construction_state_valid
    CHECK (construction_state IN ('under_construction', 'complete')),
  DROP CONSTRAINT IF EXISTS kingdom_cots_construction_lifecycle_valid,
  ADD CONSTRAINT kingdom_cots_construction_lifecycle_valid CHECK (
    (construction_state = 'complete' AND completed_at IS NOT NULL) OR
    (construction_state = 'under_construction' AND completed_at IS NULL)
  );

ALTER TABLE kingdom_decorations
  DROP CONSTRAINT IF EXISTS kingdom_decorations_construction_state_valid,
  ADD CONSTRAINT kingdom_decorations_construction_state_valid
    CHECK (construction_state IN ('under_construction', 'complete')),
  DROP CONSTRAINT IF EXISTS kingdom_decorations_construction_lifecycle_valid,
  ADD CONSTRAINT kingdom_decorations_construction_lifecycle_valid CHECK (
    (construction_state = 'complete' AND completed_at IS NOT NULL) OR
    (construction_state = 'under_construction' AND completed_at IS NULL)
  );

CREATE TABLE IF NOT EXISTS kingdom_construction_jobs (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  request_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  cost_snapshot jsonb NOT NULL,
  rules_version integer NOT NULL,
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  failed_at timestamptz NULL,
  failure_code text NULL,
  CONSTRAINT kingdom_construction_jobs_entity_valid
    CHECK (entity_type IN ('seat', 'cot', 'decoration')),
  CONSTRAINT kingdom_construction_jobs_status_valid
    CHECK (status IN ('pending', 'completed', 'cancelled', 'failed')),
  CONSTRAINT kingdom_construction_jobs_time_valid CHECK (completes_at >= started_at),
  CONSTRAINT kingdom_construction_jobs_lifecycle_valid CHECK (
    (status = 'pending' AND completed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL) OR
    (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL AND failed_at IS NULL) OR
    (status = 'cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL AND failed_at IS NULL) OR
    (status = 'failed' AND completed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NOT NULL)
  ),
  CONSTRAINT kingdom_construction_jobs_actor_request_unique UNIQUE (actor_player_id, request_id),
  CONSTRAINT kingdom_construction_jobs_entity_unique UNIQUE (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS kingdom_construction_jobs_due_idx
  ON kingdom_construction_jobs (completes_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS kingdom_construction_jobs_kingdom_idx
  ON kingdom_construction_jobs (kingdom_id, status, started_at DESC);
