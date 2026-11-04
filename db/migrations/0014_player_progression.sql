CREATE TABLE IF NOT EXISTS player_progression_profiles (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  total_xp integer NOT NULL DEFAULT 0 CHECK (total_xp BETWEEN 0 AND 500000),
  level integer NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 25),
  curve_version integer NOT NULL DEFAULT 1 CHECK (curve_version > 0),
  persistence_version bigint NOT NULL DEFAULT 0 CHECK (persistence_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO player_progression_profiles (player_id)
SELECT id FROM players
ON CONFLICT (player_id) DO NOTHING;

DROP TRIGGER IF EXISTS player_progression_profiles_set_updated_at ON player_progression_profiles;
CREATE TRIGGER player_progression_profiles_set_updated_at
BEFORE UPDATE ON player_progression_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS xp_operations (
  operation_id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('combat', 'harvest', 'development')),
  source_id text NULL,
  requested_xp integer NOT NULL CHECK (requested_xp >= 0),
  granted_xp integer NOT NULL CHECK (granted_xp >= 0),
  discarded_xp integer NOT NULL CHECK (discarded_xp >= 0),
  previous_xp integer NOT NULL CHECK (previous_xp BETWEEN 0 AND 500000),
  resulting_xp integer NOT NULL CHECK (resulting_xp BETWEEN 0 AND 500000),
  previous_level integer NOT NULL CHECK (previous_level BETWEEN 0 AND 25),
  resulting_level integer NOT NULL CHECK (resulting_level BETWEEN 0 AND 25),
  replay_result jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_xp = granted_xp + discarded_xp),
  CHECK (resulting_xp = previous_xp + granted_xp),
  CHECK (resulting_level >= previous_level)
);

CREATE INDEX IF NOT EXISTS xp_operations_player_created_idx
  ON xp_operations (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS xp_operations_source_idx
  ON xp_operations (source_type, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS xp_events (
  id bigserial PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES xp_operations(operation_id) ON DELETE RESTRICT,
  operation_key text NOT NULL REFERENCES xp_operations(operation_key) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('xp_granted', 'level_up')),
  xp_delta integer NOT NULL DEFAULT 0 CHECK (xp_delta >= 0),
  resulting_xp integer NOT NULL CHECK (resulting_xp BETWEEN 0 AND 500000),
  resulting_level integer NOT NULL CHECK (resulting_level BETWEEN 0 AND 25),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, event_type, resulting_level)
);

CREATE INDEX IF NOT EXISTS xp_events_player_created_idx
  ON xp_events (player_id, created_at DESC);

