ALTER TABLE player_combat_profiles
  ADD COLUMN IF NOT EXISTS death_penalty_operation_key text NULL;

UPDATE player_combat_profiles
SET life_state = 'respawning',
    death_penalty_operation_key = 'player-death:legacy:' || player_id || ':' || persistence_version
WHERE (life_state = 'respawning' OR current_health = 0)
  AND death_penalty_operation_key IS NULL;

ALTER TABLE player_combat_profiles
  DROP CONSTRAINT IF EXISTS player_combat_profiles_death_penalty_operation_key_check;

ALTER TABLE player_combat_profiles
  ADD CONSTRAINT player_combat_profiles_death_penalty_operation_key_check CHECK (
    (life_state = 'respawning') = (death_penalty_operation_key IS NOT NULL)
    AND (death_penalty_operation_key IS NULL OR length(death_penalty_operation_key) BETWEEN 1 AND 240)
  );

CREATE TABLE IF NOT EXISTS player_death_xp_penalties (
  operation_id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  penalty_basis_points integer NOT NULL CHECK (penalty_basis_points = 1000),
  previous_xp bigint NOT NULL CHECK (previous_xp >= 0),
  resulting_xp bigint NOT NULL CHECK (resulting_xp >= 0),
  xp_lost bigint NOT NULL CHECK (xp_lost >= 0),
  previous_level integer NOT NULL CHECK (previous_level BETWEEN 0 AND 25),
  resulting_level integer NOT NULL CHECK (resulting_level BETWEEN 0 AND 25),
  replay_result jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(operation_key) BETWEEN 1 AND 240),
  CHECK (jsonb_typeof(replay_result) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (xp_lost = previous_xp / 10),
  CHECK (resulting_xp = previous_xp - xp_lost),
  CHECK (resulting_level <= previous_level)
);

CREATE INDEX IF NOT EXISTS player_death_xp_penalties_player_created_idx
  ON player_death_xp_penalties (player_id, created_at DESC);

COMMENT ON TABLE player_death_xp_penalties IS
  'Append-only, idempotent ledger of server-authoritative character XP lost on player defeat.';
