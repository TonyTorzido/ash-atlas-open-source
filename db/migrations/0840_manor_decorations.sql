-- Studio-published Manor decoration definitions are immutable content. These
-- tables hold only per-Manor item reservations and player placement state.

CREATE TABLE IF NOT EXISTS manor_decoration_placements (
  placement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE CASCADE,
  definition_id text NOT NULL,
  item_id text NOT NULL REFERENCES item_definitions(item_id),
  item_variant text NOT NULL DEFAULT 'default',
  room_id text NOT NULL,
  surface_id text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  rotation_deg double precision NOT NULL,
  width double precision NOT NULL CHECK (width > 0),
  height double precision NOT NULL CHECK (height > 0),
  scale_x double precision NOT NULL CHECK (scale_x <> 0),
  scale_y double precision NOT NULL CHECK (scale_y <> 0),
  anchor_x double precision NOT NULL CHECK (anchor_x >= 0 AND anchor_x <= 1),
  anchor_y double precision NOT NULL CHECK (anchor_y >= 0 AND anchor_y <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS manor_decoration_placements_manor_idx
  ON manor_decoration_placements (manor_id, room_id, surface_id);
CREATE INDEX IF NOT EXISTS manor_decoration_placements_item_idx
  ON manor_decoration_placements (manor_id, item_id, item_variant);

CREATE TABLE IF NOT EXISTS manor_decoration_operations (
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('place', 'move', 'remove')),
  request_hash text NOT NULL,
  original_result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CHECK ((original_result IS NULL) = (completed_at IS NULL)),
  PRIMARY KEY (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS manor_decoration_operations_manor_idx
  ON manor_decoration_operations (manor_id, created_at);
