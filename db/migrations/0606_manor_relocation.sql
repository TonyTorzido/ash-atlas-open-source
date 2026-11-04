ALTER TABLE player_manors
  ADD COLUMN IF NOT EXISTS placement_revision bigint NOT NULL DEFAULT 0;

UPDATE player_manors
SET placement_revision = 1
WHERE built_at IS NOT NULL AND placement_revision = 0;

ALTER TABLE player_manors DROP CONSTRAINT IF EXISTS player_manors_placement_revision_nonnegative;
ALTER TABLE player_manors ADD CONSTRAINT player_manors_placement_revision_nonnegative
  CHECK (placement_revision >= 0);

CREATE TABLE IF NOT EXISTS manor_placement_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('build', 'destroy')),
  request_hash text NOT NULL,
  applied_revision bigint NOT NULL CHECK (applied_revision > 0),
  original_result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS manor_placement_operations_player_created_idx
  ON manor_placement_operations (player_id, created_at DESC);

INSERT INTO manor_placement_operations
  (operation_key, player_id, manor_id, request_id, operation_type, request_hash,
   applied_revision, original_result, created_at)
SELECT operation_key, player_id, manor_id, request_id, 'build', request_hash,
       1, original_result, created_at
FROM manor_build_operations
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS manor_placement_events (
  id bigserial PRIMARY KEY,
  operation_key text NOT NULL UNIQUE REFERENCES manor_placement_operations(operation_key) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('built', 'destroyed')),
  placement_revision bigint NOT NULL CHECK (placement_revision > 0),
  region_code text,
  lat double precision,
  lon double precision,
  source_flag_id uuid REFERENCES flags(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (event_type = 'built' AND region_code IS NOT NULL AND lat BETWEEN -90 AND 90
      AND lon BETWEEN -180 AND 180)
    OR
    (event_type = 'destroyed' AND region_code IS NULL AND lat IS NULL
      AND lon IS NULL AND source_flag_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS manor_placement_events_manor_revision_idx
  ON manor_placement_events (manor_id, placement_revision DESC);

CREATE OR REPLACE FUNCTION reject_manor_placement_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manor placement events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS manor_placement_events_immutable ON manor_placement_events;
CREATE TRIGGER manor_placement_events_immutable
BEFORE UPDATE OR DELETE ON manor_placement_events
FOR EACH ROW EXECUTE FUNCTION reject_manor_placement_event_mutation();
