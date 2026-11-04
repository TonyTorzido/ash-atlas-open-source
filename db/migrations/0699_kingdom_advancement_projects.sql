CREATE TABLE IF NOT EXISTS kingdom_projects (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  project_type text NOT NULL,
  rules_version integer NOT NULL,
  target_level integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  cost_snapshot jsonb NOT NULL,
  xp_snapshot jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  failed_at timestamptz NULL,
  failure_code text NULL,
  CONSTRAINT kingdom_projects_type_valid CHECK (project_type IN ('advancement')),
  CONSTRAINT kingdom_projects_rules_version_valid CHECK (rules_version > 0),
  CONSTRAINT kingdom_projects_target_level_valid CHECK (target_level BETWEEN 2 AND 5),
  CONSTRAINT kingdom_projects_status_valid
    CHECK (status IN ('pending', 'completed', 'cancelled', 'failed')),
  CONSTRAINT kingdom_projects_cost_snapshot_valid
    CHECK (jsonb_typeof(cost_snapshot) = 'array'),
  CONSTRAINT kingdom_projects_xp_snapshot_valid
    CHECK (jsonb_typeof(xp_snapshot) = 'object'),
  CONSTRAINT kingdom_projects_time_valid CHECK (completes_at >= started_at),
  CONSTRAINT kingdom_projects_lifecycle_valid CHECK (
    (status = 'pending' AND completed_at IS NULL AND cancelled_at IS NULL
      AND failed_at IS NULL AND failure_code IS NULL) OR
    (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL
      AND failed_at IS NULL AND failure_code IS NULL) OR
    (status = 'cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL
      AND failed_at IS NULL AND failure_code IS NULL) OR
    (status = 'failed' AND completed_at IS NULL AND cancelled_at IS NULL
      AND failed_at IS NOT NULL AND failure_code IS NOT NULL)
  ),
  CONSTRAINT kingdom_projects_actor_request_unique UNIQUE (actor_player_id, request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS kingdom_projects_one_pending_advancement_idx
  ON kingdom_projects (kingdom_id)
  WHERE project_type = 'advancement' AND status = 'pending';
CREATE INDEX IF NOT EXISTS kingdom_projects_due_idx
  ON kingdom_projects (completes_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS kingdom_projects_kingdom_history_idx
  ON kingdom_projects (kingdom_id, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS kingdom_treasury_expenditures (
  id uuid PRIMARY KEY,
  kingdom_id uuid NOT NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES kingdom_projects(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  resource_type text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  direction text NOT NULL,
  quantity integer NOT NULL,
  balance_before bigint NOT NULL,
  balance_after bigint NOT NULL,
  source_type text NOT NULL,
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kingdom_treasury_expenditures_direction_valid
    CHECK (direction IN ('debit', 'refund')),
  CONSTRAINT kingdom_treasury_expenditures_quantity_valid CHECK (quantity > 0),
  CONSTRAINT kingdom_treasury_expenditures_balance_valid CHECK (
    balance_before >= 0 AND balance_after >= 0 AND (
      (direction = 'debit' AND balance_after = balance_before - quantity) OR
      (direction = 'refund' AND balance_after = balance_before + quantity)
    )
  ),
  CONSTRAINT kingdom_treasury_expenditures_source_valid
    CHECK (source_type IN ('project_start', 'project_cancel', 'kingdom_dissolution')),
  CONSTRAINT kingdom_treasury_expenditures_source_resource_unique
    UNIQUE (project_id, direction, resource_type, variant)
);

CREATE INDEX IF NOT EXISTS kingdom_treasury_expenditures_kingdom_history_idx
  ON kingdom_treasury_expenditures (kingdom_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS kingdom_treasury_expenditures_project_idx
  ON kingdom_treasury_expenditures (project_id, created_at, id);

DROP TRIGGER IF EXISTS kingdom_treasury_expenditures_append_only
  ON kingdom_treasury_expenditures;
CREATE TRIGGER kingdom_treasury_expenditures_append_only
BEFORE UPDATE OR DELETE ON kingdom_treasury_expenditures
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

ALTER TABLE kingdom_xp_ledger
  DROP CONSTRAINT IF EXISTS kingdom_xp_ledger_source_valid,
  ADD CONSTRAINT kingdom_xp_ledger_source_valid
    CHECK (source_type IN ('donation', 'construction', 'development', 'advancement_project')),
  DROP CONSTRAINT IF EXISTS kingdom_xp_ledger_delta_valid,
  ADD CONSTRAINT kingdom_xp_ledger_delta_valid
    CHECK (xp_delta >= 0 AND xp_after = xp_before + xp_delta);
