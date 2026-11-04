CREATE TABLE IF NOT EXISTS world_item_drops (
  id uuid PRIMARY KEY,
  operation_key text NOT NULL UNIQUE
    REFERENCES inventory_operations(operation_key) ON DELETE RESTRICT,
  dropped_by text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  region_code text NOT NULL,
  item_id text NOT NULL REFERENCES item_definitions(item_id),
  variant text NOT NULL DEFAULT 'default',
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'picked_up', 'expired', 'cancelled')),
  lat double precision NOT NULL CHECK (lat >= -90 AND lat <= 90),
  lon double precision NOT NULL CHECK (lon >= -180 AND lon <= 180),
  geom geometry(Point, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  pickup_operation_key text NULL UNIQUE
    REFERENCES inventory_operations(operation_key) ON DELETE RESTRICT,
  picked_up_by text NULL REFERENCES players(id) ON DELETE RESTRICT,
  picked_up_at timestamptz NULL,
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'picked_up'
      AND pickup_operation_key IS NOT NULL
      AND picked_up_by IS NOT NULL
      AND picked_up_at IS NOT NULL)
    OR
    (status <> 'picked_up'
      AND pickup_operation_key IS NULL
      AND picked_up_by IS NULL
      AND picked_up_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS world_item_drops_active_geom_idx
  ON world_item_drops USING gist (geom)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS world_item_drops_region_status_expiry_idx
  ON world_item_drops (region_code, status, expires_at);

CREATE INDEX IF NOT EXISTS world_item_drops_dropped_by_created_idx
  ON world_item_drops (dropped_by, created_at DESC);

CREATE INDEX IF NOT EXISTS world_item_drops_item_created_idx
  ON world_item_drops (item_id, created_at DESC);
