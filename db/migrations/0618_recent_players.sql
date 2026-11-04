CREATE TABLE recent_players (
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  recent_player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  interaction_type text NOT NULL CHECK (
    interaction_type IN ('nearby', 'local_chat', 'party', 'trade')
  ),
  interaction_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_player_id, recent_player_id),
  CONSTRAINT recent_players_no_self CHECK (owner_player_id <> recent_player_id)
);

CREATE INDEX recent_players_owner_recent_idx
  ON recent_players (owner_player_id, interaction_at DESC, recent_player_id);

DROP TRIGGER IF EXISTS recent_players_set_updated_at ON recent_players;
CREATE TRIGGER recent_players_set_updated_at
BEFORE UPDATE ON recent_players
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
