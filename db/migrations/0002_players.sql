CREATE TABLE IF NOT EXISTS players (
  id text PRIMARY KEY,
  username text NOT NULL,
  display_color text NULL,
  region_code text NOT NULL DEFAULT 'NM',
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  anchor_lat double precision NOT NULL,
  anchor_lon double precision NOT NULL,
  move_leash_radius_m double precision NOT NULL,
  online boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  geom geometry(Point, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS players_region_code_idx ON players (region_code);
CREATE INDEX IF NOT EXISTS players_online_idx ON players (online);
CREATE INDEX IF NOT EXISTS players_last_seen_at_idx ON players (last_seen_at);
CREATE INDEX IF NOT EXISTS players_geom_gix ON players USING gist (geom);

DROP TRIGGER IF EXISTS players_set_updated_at ON players;
CREATE TRIGGER players_set_updated_at
BEFORE UPDATE ON players
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
