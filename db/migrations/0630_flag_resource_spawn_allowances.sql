-- Finite tree/wolf generations funded by one durable 48-hour allowance per active flag.

CREATE TABLE IF NOT EXISTS flag_resource_spawn_allowances (
  flag_id uuid PRIMARY KEY,
  spawn_generation integer NOT NULL DEFAULT 0 CHECK (spawn_generation >= 0),
  next_spawn_allowance_at timestamptz NOT NULL,
  last_spawn_allowance_at timestamptz NULL,
  placement_version text NOT NULL DEFAULT 'flag-finite-resources-v1',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO flag_resource_spawn_allowances (flag_id, next_spawn_allowance_at)
SELECT id, clock_timestamp() + interval '48 hours'
FROM flags
ON CONFLICT (flag_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS flag_resource_spawn_events (
  flag_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  seed_version text NOT NULL,
  placement_version text NOT NULL,
  rolled_tree_count smallint NOT NULL CHECK (rolled_tree_count BETWEEN 3 AND 7),
  rolled_wolf_count smallint NOT NULL CHECK (rolled_wolf_count BETWEEN 2 AND 4),
  actual_tree_count smallint NOT NULL CHECK (actual_tree_count BETWEEN 0 AND 7),
  actual_wolf_count smallint NOT NULL CHECK (actual_wolf_count BETWEEN 0 AND 4),
  materialized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (flag_id, generation)
);

ALTER TABLE collectible_nodes
  ADD COLUMN IF NOT EXISTS source_flag_id uuid NULL,
  ADD COLUMN IF NOT EXISTS source_generation integer NULL,
  ADD COLUMN IF NOT EXISTS placement_version text NULL;

ALTER TABLE collectible_nodes
  DROP CONSTRAINT IF EXISTS collectible_nodes_flag_generation_complete,
  ADD CONSTRAINT collectible_nodes_flag_generation_complete CHECK (
    (source_flag_id IS NULL AND source_generation IS NULL AND placement_version IS NULL)
    OR
    (source_flag_id IS NOT NULL AND source_generation > 0 AND placement_version IS NOT NULL
      AND resource_type = 'wood' AND quantity = 4)
  );

CREATE INDEX IF NOT EXISTS collectible_nodes_source_flag_active_idx
  ON collectible_nodes (source_flag_id, source_generation)
  WHERE source_flag_id IS NOT NULL AND state = 'available';

CREATE TABLE IF NOT EXISTS generated_resource_wolves (
  entity_id text PRIMARY KEY,
  source_flag_id uuid NOT NULL,
  source_generation integer NOT NULL CHECK (source_generation > 0),
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point, 4326) NOT NULL,
  placement_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  killed_at timestamptz NULL,
  killed_by_player_id text NULL REFERENCES players(id) ON DELETE SET NULL,
  CHECK ((killed_at IS NULL) = (killed_by_player_id IS NULL))
);

CREATE INDEX IF NOT EXISTS generated_resource_wolves_source_flag_living_idx
  ON generated_resource_wolves (source_flag_id, source_generation)
  WHERE killed_at IS NULL;
CREATE INDEX IF NOT EXISTS generated_resource_wolves_living_geom_idx
  ON generated_resource_wolves USING gist (geom)
  WHERE killed_at IS NULL;

CREATE OR REPLACE FUNCTION initialize_flag_resource_spawn_allowance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO flag_resource_spawn_allowances (flag_id, next_spawn_allowance_at)
  VALUES (NEW.id, clock_timestamp() + interval '48 hours')
  ON CONFLICT (flag_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flags_initialize_resource_spawn_allowance ON flags;
CREATE TRIGGER flags_initialize_resource_spawn_allowance
AFTER INSERT ON flags
FOR EACH ROW EXECUTE FUNCTION initialize_flag_resource_spawn_allowance();

CREATE OR REPLACE FUNCTION deactivate_flag_resource_spawn_allowance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE flag_resource_spawn_allowances
  SET active = false, updated_at = clock_timestamp()
  WHERE flag_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS flags_deactivate_resource_spawn_allowance ON flags;
CREATE TRIGGER flags_deactivate_resource_spawn_allowance
BEFORE DELETE ON flags
FOR EACH ROW EXECUTE FUNCTION deactivate_flag_resource_spawn_allowance();

CREATE OR REPLACE FUNCTION protect_generated_resource_placement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_flag_id IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.lat IS DISTINCT FROM OLD.lat OR
    NEW.lon IS DISTINCT FROM OLD.lon OR NEW.geom IS DISTINCT FROM OLD.geom OR
    NEW.source_flag_id IS DISTINCT FROM OLD.source_flag_id OR
    NEW.source_generation IS DISTINCT FROM OLD.source_generation OR
    NEW.placement_version IS DISTINCT FROM OLD.placement_version OR
    (OLD.state = 'harvested' AND NEW.state <> 'harvested')
  ) THEN
    RAISE EXCEPTION 'generated tree identity, placement, and consumption are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'collectible_nodes_generated_tree_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collectible_nodes_protect_generated_resource ON collectible_nodes;
CREATE TRIGGER collectible_nodes_protect_generated_resource
BEFORE UPDATE ON collectible_nodes
FOR EACH ROW EXECUTE FUNCTION protect_generated_resource_placement();

-- Preserve every currently stored ready_at. Only later successful cycles use 48 hours.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'repeatable_resource_nodes'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%node_type%'
      AND pg_get_constraintdef(oid) LIKE '%regeneration_interval%'
  LOOP
    EXECUTE format('ALTER TABLE repeatable_resource_nodes DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

UPDATE repeatable_resource_nodes
SET regeneration_interval = interval '48 hours'
WHERE node_type = 'stone_mine' AND regeneration_interval <> interval '48 hours';

ALTER TABLE repeatable_resource_nodes
  ADD CONSTRAINT repeatable_resource_nodes_stone_mine_interval_check
  CHECK (node_type <> 'stone_mine' OR regeneration_interval = interval '48 hours');
