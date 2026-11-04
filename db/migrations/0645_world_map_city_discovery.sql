CREATE TABLE IF NOT EXISTS player_discovered_cities (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  city_id uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  first_visited_at timestamptz NOT NULL DEFAULT now(),
  last_visited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, city_id),
  CONSTRAINT player_discovered_cities_visit_order
    CHECK (last_visited_at >= first_visited_at)
);

CREATE INDEX IF NOT EXISTS player_discovered_cities_city_idx
  ON player_discovered_cities (city_id, player_id);

-- Founding is the only conservative historical proof that a player was at a
-- city's seat. Membership by itself intentionally does not grant discovery.
INSERT INTO player_discovered_cities (
  player_id,
  city_id,
  first_visited_at,
  last_visited_at
)
SELECT
  founder_player_id,
  id,
  created_at,
  created_at
FROM cities
ON CONFLICT (player_id, city_id) DO NOTHING;
