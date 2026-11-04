CREATE TABLE IF NOT EXISTS population_flag_plan_backfill_jobs (
  plan_version text PRIMARY KEY,
  strategy text NOT NULL
    CHECK (strategy = 'destination_backfill_required'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retrying', 'completed')),
  sweep smallint NOT NULL DEFAULT 0 CHECK (sweep BETWEEN 0 AND 1),
  cursor_created_at timestamptz,
  cursor_flag_id uuid,
  flags_discovered bigint NOT NULL DEFAULT 0,
  zones_discovered bigint NOT NULL DEFAULT 0,
  zones_ready bigint NOT NULL DEFAULT 0,
  zones_failed bigint NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_generation bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

INSERT INTO population_flag_plan_backfill_jobs (plan_version, strategy)
VALUES (
  'population-zone-plan-compiler-v5-stone-authority-compat',
  'destination_backfill_required'
)
ON CONFLICT (plan_version) DO NOTHING;
