CREATE TABLE IF NOT EXISTS player_water_collection_cadence (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  last_collected_at timestamptz NULL,
  next_allowed_at timestamptz NOT NULL DEFAULT 'epoch'::timestamptz,
  CHECK (last_collected_at IS NULL OR next_allowed_at >= last_collected_at)
);

CREATE TABLE IF NOT EXISTS water_collection_operations (
  operation_key text PRIMARY KEY
    REFERENCES inventory_operations(operation_key) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  source_entity_id text NOT NULL,
  water_kind text NOT NULL CHECK (water_kind IN ('default', 'fresh', 'salt')),
  result_message text NOT NULL,
  collected_at timestamptz NOT NULL,
  next_allowed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, request_id),
  CHECK (next_allowed_at >= collected_at)
);

CREATE INDEX IF NOT EXISTS water_collection_operations_player_collected_idx
  ON water_collection_operations (player_id, collected_at DESC);

COMMENT ON TABLE player_water_collection_cadence IS
  'Durable per-player authority for water collection timing across sockets and runtimes.';

COMMENT ON TABLE water_collection_operations IS
  'Completed idempotent water outcomes paired transactionally with inventory operations.';
