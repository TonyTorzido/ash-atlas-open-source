ALTER TABLE player_manors
  ADD COLUMN IF NOT EXISTS world_region_code text,
  ADD COLUMN IF NOT EXISTS world_lat double precision,
  ADD COLUMN IF NOT EXISTS world_lon double precision,
  ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326),
  ADD COLUMN IF NOT EXISTS built_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_flag_id uuid REFERENCES flags(id) ON DELETE SET NULL;

ALTER TABLE player_manors DROP CONSTRAINT IF EXISTS player_manors_world_placement_complete;
ALTER TABLE player_manors ADD CONSTRAINT player_manors_world_placement_complete CHECK (
  (built_at IS NULL AND world_region_code IS NULL AND world_lat IS NULL AND world_lon IS NULL AND geom IS NULL)
  OR
  (built_at IS NOT NULL AND world_region_code IS NOT NULL AND world_lat BETWEEN -90 AND 90
    AND world_lon BETWEEN -180 AND 180 AND geom IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS player_manors_built_region_idx
  ON player_manors (world_region_code, built_at DESC, id)
  WHERE built_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS player_manors_geom_gix
  ON player_manors USING gist (geom)
  WHERE built_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS manor_build_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_hash text NOT NULL,
  original_result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, request_id)
);

CREATE INDEX IF NOT EXISTS manor_build_operations_player_created_idx
  ON manor_build_operations (player_id, created_at DESC);

-- Interior presence from the pre-placement feature is not valid until its
-- preserved manor record is deliberately placed. Storage and manor IDs remain.
DELETE FROM player_manor_presence p
USING player_manors m
WHERE p.manor_id = m.id AND m.built_at IS NULL;
