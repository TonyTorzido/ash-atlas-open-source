CREATE TABLE developer_spawned_plants (
  entity_id TEXT PRIMARY KEY,
  creator_player_id TEXT NULL REFERENCES players(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  plant_key TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  region_code TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  spawn_lat DOUBLE PRECISION NOT NULL,
  spawn_lon DOUBLE PRECISION NOT NULL,
  state TEXT NOT NULL DEFAULT 'available',
  state_revision BIGINT NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  harvested_at TIMESTAMPTZ NULL,
  harvested_by_player_id TEXT NULL REFERENCES players(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (creator_player_id, request_id),
  CHECK (length(entity_id) > 0),
  CHECK (length(request_id) > 0),
  CHECK (length(plant_key) > 0),
  CHECK (length(resource_type) > 0),
  CHECK (length(region_code) > 0),
  CHECK (length(zone_id) > 0),
  CHECK (spawn_lat >= -90 AND spawn_lat <= 90),
  CHECK (spawn_lon >= -180 AND spawn_lon <= 180),
  CHECK (state IN ('available', 'harvested')),
  CHECK (
    (state = 'available' AND harvested_at IS NULL AND harvested_by_player_id IS NULL)
    OR
    (state = 'harvested' AND harvested_at IS NOT NULL)
  )
);

CREATE INDEX developer_spawned_plants_available_idx
  ON developer_spawned_plants (region_code, state)
  WHERE state = 'available';
