CREATE TABLE IF NOT EXISTS player_world_map_social_preferences (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  audience text NOT NULL,
  visible boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, audience),
  CONSTRAINT player_world_map_social_preferences_audience
    CHECK (audience IN ('friends', 'kingdom_members', 'city_members'))
);

CREATE TABLE IF NOT EXISTS player_world_map_social_positions (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_world_map_social_positions_published_idx
  ON player_world_map_social_positions (published_at DESC);
