-- PvP post-kill safety (strike-block rule).
--
-- A player killed by a player is safe from every player for 20 hours. The
-- combat engine lifts the safety while the player is Aggressive again (they
-- attacked something and their aggression timer is running) and it resumes
-- for the rest of the 20 hours once their aggression drops. One row per
-- player, refreshed by each new PvP death; expired rows are pruned by the
-- server on start.

CREATE TABLE IF NOT EXISTS player_pvp_defeat_safety (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_pvp_defeat_safety_expires_idx
  ON player_pvp_defeat_safety (expires_at);

COMMENT ON TABLE player_pvp_defeat_safety IS
  'Active 20-hour PvP post-kill safety per player; lifted in combat while the player is Aggressive.';
