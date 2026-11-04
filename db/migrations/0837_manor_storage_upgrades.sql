-- Durable manor storage progression. Existing manors remain at level 0.
ALTER TABLE player_manors
  ADD COLUMN IF NOT EXISTS storage_upgrade_level integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'player_manors'::regclass
      AND conname = 'player_manors_storage_upgrade_level_check'
  ) THEN
    ALTER TABLE player_manors
      ADD CONSTRAINT player_manors_storage_upgrade_level_check
      CHECK (storage_upgrade_level BETWEEN 0 AND 3);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS manor_storage_upgrade_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  target_level integer NOT NULL CHECK (target_level BETWEEN 1 AND 3),
  material_cost jsonb NOT NULL,
  gold_cost bigint NOT NULL CHECK (gold_cost > 0),
  capacity_before_grams bigint NOT NULL CHECK (capacity_before_grams > 0),
  capacity_after_grams bigint NOT NULL CHECK (capacity_after_grams > capacity_before_grams),
  original_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (player_id, request_id),
  CHECK ((original_result IS NULL) = (completed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS manor_storage_upgrade_operations_manor_created_idx
  ON manor_storage_upgrade_operations (manor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS manor_storage_upgrade_events (
  id bigserial PRIMARY KEY,
  operation_key text NOT NULL UNIQUE
    REFERENCES manor_storage_upgrade_operations(operation_key) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  previous_level integer NOT NULL CHECK (previous_level BETWEEN 0 AND 2),
  next_level integer NOT NULL CHECK (next_level = previous_level + 1),
  capacity_before_grams bigint NOT NULL CHECK (capacity_before_grams > 0),
  capacity_after_grams bigint NOT NULL CHECK (capacity_after_grams > capacity_before_grams),
  material_cost jsonb NOT NULL,
  gold_cost bigint NOT NULL CHECK (gold_cost > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS manor_storage_upgrade_events_manor_created_idx
  ON manor_storage_upgrade_events (manor_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS manor_storage_upgrade_events_player_created_idx
  ON manor_storage_upgrade_events (player_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION reject_manor_storage_upgrade_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manor storage upgrade events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS manor_storage_upgrade_events_immutable
  ON manor_storage_upgrade_events;
CREATE TRIGGER manor_storage_upgrade_events_immutable
BEFORE UPDATE OR DELETE ON manor_storage_upgrade_events
FOR EACH ROW EXECUTE FUNCTION reject_manor_storage_upgrade_event_mutation();
