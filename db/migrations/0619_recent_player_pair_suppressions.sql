CREATE TABLE recent_player_pair_suppressions (
  player_low_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_high_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  suppressed_at timestamptz NOT NULL,
  PRIMARY KEY (player_low_id, player_high_id),
  CONSTRAINT recent_player_pair_suppressions_ordered CHECK (player_low_id < player_high_id)
);
