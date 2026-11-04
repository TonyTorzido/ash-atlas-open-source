CREATE TABLE IF NOT EXISTS city_settlement_reconciliation_runs (
  id uuid PRIMARY KEY,
  world_id text NOT NULL,
  operation text NOT NULL,
  actor text NOT NULL,
  source_run_id uuid NULL REFERENCES city_settlement_reconciliation_runs(id) ON DELETE RESTRICT,
  target_release_id text NOT NULL,
  target_release_fingerprint text NOT NULL,
  target_founding_policy_id text NOT NULL,
  target_founding_policy_fingerprint text NOT NULL,
  target_resolution_policy_id text NOT NULL,
  target_resolution_policy_fingerprint text NOT NULL,
  report_sha256 text NOT NULL,
  planned_count integer NOT NULL,
  changed_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT city_settlement_reconciliation_operation_valid
    CHECK (operation IN ('reconcile', 'reverse')),
  CONSTRAINT city_settlement_reconciliation_actor_nonempty
    CHECK (length(btrim(actor)) > 0),
  CONSTRAINT city_settlement_reconciliation_report_sha256
    CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT city_settlement_reconciliation_counts_valid
    CHECK (planned_count >= 0 AND changed_count >= 0 AND changed_count <= planned_count),
  CONSTRAINT city_settlement_reconciliation_release_sha256
    CHECK (target_release_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT city_settlement_reconciliation_founding_sha256
    CHECK (target_founding_policy_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT city_settlement_reconciliation_resolution_sha256
    CHECK (target_resolution_policy_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS city_settlement_reconciliation_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES city_settlement_reconciliation_runs(id) ON DELETE RESTRICT,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT city_settlement_reconciliation_event_unique UNIQUE (run_id, city_id),
  CONSTRAINT city_settlement_reconciliation_state_objects
    CHECK (jsonb_typeof(before_state) = 'object' AND jsonb_typeof(after_state) = 'object')
);

CREATE INDEX IF NOT EXISTS city_settlement_reconciliation_runs_created_idx
  ON city_settlement_reconciliation_runs(created_at DESC, id);
CREATE INDEX IF NOT EXISTS city_settlement_reconciliation_events_city_idx
  ON city_settlement_reconciliation_events(city_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION reject_city_settlement_reconciliation_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'city settlement reconciliation events are append-only';
END
$$;

DROP TRIGGER IF EXISTS city_settlement_reconciliation_events_immutable
  ON city_settlement_reconciliation_events;
CREATE TRIGGER city_settlement_reconciliation_events_immutable
BEFORE UPDATE OR DELETE ON city_settlement_reconciliation_events
FOR EACH ROW EXECUTE FUNCTION reject_city_settlement_reconciliation_event_mutation();

COMMENT ON TABLE city_settlement_reconciliation_runs IS
  'Audited bounded operator runs that reconcile retained cities to immutable World settlement authority.';
COMMENT ON TABLE city_settlement_reconciliation_events IS
  'Append-only before/after authority records supporting exact review and reversal.';
