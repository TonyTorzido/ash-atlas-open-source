CREATE TABLE IF NOT EXISTS spawn_cells (
  id text PRIMARY KEY,
  region_code text NOT NULL DEFAULT 'NM',
  cell_x integer NOT NULL,
  cell_y integer NOT NULL,
  center_lat double precision NOT NULL,
  center_lon double precision NOT NULL,
  world_release text NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  env_snapshot jsonb NULL,
  UNIQUE (region_code, cell_x, cell_y)
);

CREATE TABLE IF NOT EXISTS collectible_nodes (
  id text PRIMARY KEY,
  cell_id text NOT NULL REFERENCES spawn_cells(id) ON DELETE CASCADE,
  region_code text NOT NULL DEFAULT 'NM',
  resource_type text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  state text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now(),
  harvested_at timestamptz NULL,
  harvested_by_player_id text NULL REFERENCES players(id),
  env_snapshot jsonb NULL
);

CREATE TABLE IF NOT EXISTS player_inventory (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  resource_type text NOT NULL,
  variant text NULL,
  quantity integer NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, resource_type, variant)
);

CREATE INDEX IF NOT EXISTS collectible_nodes_geom_gix
  ON collectible_nodes USING gist (geom);

CREATE INDEX IF NOT EXISTS collectible_nodes_region_state_idx
  ON collectible_nodes (region_code, state);

CREATE INDEX IF NOT EXISTS spawn_cells_region_cell_idx
  ON spawn_cells (region_code, cell_x, cell_y);
