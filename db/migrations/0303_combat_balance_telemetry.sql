CREATE TABLE IF NOT EXISTS combat_balance_summaries (
  combat_session_id text PRIMARY KEY
    CHECK (length(combat_session_id) BETWEEN 1 AND 160),
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  active_class_id text NOT NULL CHECK (length(active_class_id) BETWEEN 1 AND 80),
  active_subclass_id text NULL CHECK (
    active_subclass_id IS NULL OR length(active_subclass_id) BETWEEN 1 AND 80
  ),
  warrior_level smallint NOT NULL CHECK (warrior_level BETWEEN 0 AND 25),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL CHECK (ended_at >= started_at),
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
  initial_enemy_queue_size integer NOT NULL CHECK (initial_enemy_queue_size >= 0),
  maximum_enemy_queue_size integer NOT NULL CHECK (
    maximum_enemy_queue_size >= initial_enemy_queue_size
  ),
  player_survived boolean NOT NULL,
  enemies_defeated integer NOT NULL CHECK (enemies_defeated >= 0),
  combat_end_reason text NOT NULL CHECK (length(combat_end_reason) BETWEEN 1 AND 80),
  payload_sha256 varchar(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  summary jsonb NOT NULL CHECK (
    jsonb_typeof(summary) = 'object' AND pg_column_size(summary) <= 262144
  ),
  action_trace jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(action_trace) = 'array'
    AND jsonb_array_length(action_trace) <= 500
    AND pg_column_size(action_trace) <= 524288
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS combat_balance_summaries_player_ended_idx
  ON combat_balance_summaries (player_id, ended_at DESC, combat_session_id);

COMMENT ON TABLE combat_balance_summaries IS
  'One bounded authoritative balance summary per completed combat session; contains no coordinates, network identifiers, credentials, or social data.';

COMMENT ON COLUMN combat_balance_summaries.action_trace IS
  'Optional first 500 privacy-safe action-order entries using stable action, ability, and enemy-archetype identifiers only.';
