-- Move finite environmental generations from flag ownership to durable spawn-cell areas.
-- Legacy flag generation rows remain intact so populated upgrades lose no history.

CREATE TABLE IF NOT EXISTS environmental_population_areas (
  id text PRIMARY KEY,
  region_code text NOT NULL,
  cell_x integer NOT NULL,
  cell_y integer NOT NULL,
  center_lat double precision NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lon double precision NOT NULL CHECK (center_lon BETWEEN -180 AND 180),
  radius_m double precision NOT NULL DEFAULT 1500 CHECK (radius_m > 0 AND radius_m <= 10000),
  spawn_generation integer NOT NULL DEFAULT 0 CHECK (spawn_generation >= 0),
  next_resource_reset_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_materialized_at timestamptz NULL,
  seed_version text NOT NULL DEFAULT 'environment-population-counts-v1',
  placement_version text NOT NULL DEFAULT 'environment-population-v1',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (region_code, cell_x, cell_y)
);

CREATE TABLE IF NOT EXISTS environmental_population_events (
  area_id text NOT NULL REFERENCES environmental_population_areas(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK (generation > 0),
  seed_version text NOT NULL,
  placement_version text NOT NULL,
  rolled_tree_count smallint NOT NULL CHECK (rolled_tree_count BETWEEN 3 AND 7),
  rolled_wolf_count smallint NOT NULL CHECK (rolled_wolf_count BETWEEN 2 AND 4),
  actual_tree_count smallint NOT NULL CHECK (actual_tree_count BETWEEN 0 AND 7),
  actual_wolf_count smallint NOT NULL CHECK (actual_wolf_count BETWEEN 0 AND 4),
  materialized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expired_at timestamptz NULL,
  PRIMARY KEY (area_id, generation)
);

ALTER TABLE collectible_nodes
  ADD COLUMN IF NOT EXISTS source_population_area_id text NULL
    REFERENCES environmental_population_areas(id) ON DELETE RESTRICT;

ALTER TABLE collectible_nodes
  DROP CONSTRAINT IF EXISTS collectible_nodes_flag_generation_complete,
  ADD CONSTRAINT collectible_nodes_environment_generation_complete CHECK (
    (source_flag_id IS NULL AND source_population_area_id IS NULL
      AND source_generation IS NULL AND placement_version IS NULL)
    OR
    (source_flag_id IS NOT NULL AND source_population_area_id IS NULL
      AND source_generation > 0 AND placement_version IS NOT NULL
      AND resource_type = 'wood' AND quantity = 4)
    OR
    (source_flag_id IS NULL AND source_population_area_id IS NOT NULL
      AND source_generation > 0 AND placement_version IS NOT NULL
      AND resource_type = 'wood' AND quantity = 4)
  );

CREATE INDEX IF NOT EXISTS collectible_nodes_population_area_active_idx
  ON collectible_nodes (source_population_area_id, source_generation)
  WHERE source_population_area_id IS NOT NULL AND state = 'available';

ALTER TABLE generated_resource_wolves
  ALTER COLUMN source_flag_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_population_area_id text NULL
    REFERENCES environmental_population_areas(id) ON DELETE RESTRICT;

ALTER TABLE generated_resource_wolves
  DROP CONSTRAINT IF EXISTS generated_resource_wolves_source_owner,
  ADD CONSTRAINT generated_resource_wolves_source_owner CHECK (
    (source_flag_id IS NOT NULL AND source_population_area_id IS NULL)
    OR (source_flag_id IS NULL AND source_population_area_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS generated_resource_wolves_population_area_living_idx
  ON generated_resource_wolves (source_population_area_id, source_generation)
  WHERE source_population_area_id IS NOT NULL AND killed_at IS NULL;

DROP TRIGGER IF EXISTS collectible_nodes_protect_generated_resource ON collectible_nodes;
CREATE OR REPLACE FUNCTION protect_current_generated_tree()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.source_flag_id IS NOT NULL OR OLD.source_population_area_id IS NOT NULL) AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.lat IS DISTINCT FROM OLD.lat OR
    NEW.lon IS DISTINCT FROM OLD.lon OR NEW.geom IS DISTINCT FROM OLD.geom OR
    NEW.source_flag_id IS DISTINCT FROM OLD.source_flag_id OR
    NEW.source_population_area_id IS DISTINCT FROM OLD.source_population_area_id OR
    NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
    NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
    (OLD.state = 'harvested' AND NEW.state <> 'harvested') OR
    (OLD.harvested_at IS NOT NULL AND NEW.harvested_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'current generated tree identity, placement, ownership, and consumption are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'collectible_nodes_current_generated_tree_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collectible_nodes_protect_generated_resource
BEFORE UPDATE ON collectible_nodes
FOR EACH ROW EXECUTE FUNCTION protect_current_generated_tree();

DROP TRIGGER IF EXISTS generated_resource_wolves_protect_history ON generated_resource_wolves;
CREATE OR REPLACE FUNCTION protect_current_generated_wolf()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id OR
     NEW.source_flag_id IS DISTINCT FROM OLD.source_flag_id OR
     NEW.source_population_area_id IS DISTINCT FROM OLD.source_population_area_id OR
     NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
     NEW.region_code IS DISTINCT FROM OLD.region_code OR
     NEW.lat IS DISTINCT FROM OLD.lat OR NEW.lon IS DISTINCT FROM OLD.lon OR
     NEW.geom IS DISTINCT FROM OLD.geom OR
     NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
     (OLD.killed_at IS NOT NULL AND NEW.killed_at IS NULL) OR
     (OLD.killed_by_player_id IS NOT NULL AND NEW.killed_by_player_id IS NULL)
  THEN
    RAISE EXCEPTION 'current generated wolf identity, placement, ownership, and death are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'generated_resource_wolves_current_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER generated_resource_wolves_protect_history
BEFORE UPDATE ON generated_resource_wolves
FOR EACH ROW EXECUTE FUNCTION protect_current_generated_wolf();

COMMENT ON TABLE environmental_population_areas IS
  'Durable cell-driven environmental generations refreshed only by explicit world entry or relocation.';
