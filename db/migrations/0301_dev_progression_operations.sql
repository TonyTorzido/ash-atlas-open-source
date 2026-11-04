CREATE TABLE IF NOT EXISTS dev_progression_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  progression_type text NOT NULL CHECK (progression_type IN (
    'character_level', 'warrior_mastery', 'reaver_mastery', 'warden_mastery'
  )),
  target_rank integer NOT NULL CHECK (target_rank BETWEEN 0 AND 25),
  character_xp_delta integer NOT NULL DEFAULT 0,
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS dev_progression_operations_player_created_idx
  ON dev_progression_operations (player_id, created_at DESC);
