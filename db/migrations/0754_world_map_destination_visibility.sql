CREATE TABLE IF NOT EXISTS player_world_map_destination_preferences (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  destination_kind text NOT NULL,
  destination_id uuid NOT NULL,
  visible boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, destination_kind, destination_id),
  CONSTRAINT player_world_map_destination_preferences_kind
    CHECK (destination_kind IN ('city', 'manor', 'kingdom', 'atlas_shrine'))
);

CREATE INDEX IF NOT EXISTS player_world_map_destination_preferences_destination_idx
  ON player_world_map_destination_preferences (destination_kind, destination_id, player_id);
