CREATE TABLE IF NOT EXISTS player_manors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS player_manors_set_updated_at ON player_manors;
CREATE TRIGGER player_manors_set_updated_at
BEFORE UPDATE ON player_manors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS player_manor_presence (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  manor_id uuid NOT NULL UNIQUE REFERENCES player_manors(id) ON DELETE CASCADE,
  return_region_code text NOT NULL,
  return_lat double precision NOT NULL CHECK (return_lat BETWEEN -90 AND 90),
  return_lon double precision NOT NULL CHECK (return_lon BETWEEN -180 AND 180),
  entered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS player_manor_presence_set_updated_at ON player_manor_presence;
CREATE TRIGGER player_manor_presence_set_updated_at
BEFORE UPDATE ON player_manor_presence
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS manor_storage_stacks (
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES item_definitions(item_id),
  variant text NOT NULL DEFAULT 'default',
  quantity bigint NOT NULL CHECK (quantity BETWEEN 0 AND 9007199254740991),
  version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manor_id, item_id, variant)
);

CREATE TABLE IF NOT EXISTS manor_transfer_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_hash text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
  item_id text NOT NULL REFERENCES item_definitions(item_id),
  variant text NOT NULL,
  requested_quantity bigint NOT NULL CHECK (requested_quantity > 0),
  original_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (player_id, request_id),
  CHECK ((original_result IS NULL) = (completed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS manor_transfer_operations_player_created_idx
  ON manor_transfer_operations (player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS manor_storage_events (
  id bigserial PRIMARY KEY,
  operation_key text NOT NULL UNIQUE REFERENCES manor_transfer_operations(operation_key) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
  item_id text NOT NULL REFERENCES item_definitions(item_id),
  variant text NOT NULL,
  quantity_moved bigint NOT NULL CHECK (quantity_moved > 0),
  storage_delta bigint NOT NULL CHECK (storage_delta <> 0),
  storage_quantity_after bigint NOT NULL CHECK (storage_quantity_after >= 0),
  storage_version_after bigint NOT NULL CHECK (storage_version_after > 0),
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (abs(storage_delta) = quantity_moved),
  CHECK ((direction = 'deposit' AND storage_delta > 0)
      OR (direction = 'withdrawal' AND storage_delta < 0))
);

CREATE INDEX IF NOT EXISTS manor_storage_events_manor_created_idx
  ON manor_storage_events (manor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS manor_storage_events_player_created_idx
  ON manor_storage_events (player_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_manor_storage_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manor storage events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS manor_storage_events_immutable ON manor_storage_events;
CREATE TRIGGER manor_storage_events_immutable
BEFORE UPDATE OR DELETE ON manor_storage_events
FOR EACH ROW EXECUTE FUNCTION reject_manor_storage_event_mutation();
