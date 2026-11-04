ALTER TABLE players DROP CONSTRAINT IF EXISTS players_location_shape_check;
ALTER TABLE players ADD CONSTRAINT players_location_shape_check CHECK (
  (location_kind = 'world' AND location_type IS NULL AND location_id IS NULL
    AND location_instance_id IS NULL AND location_space_id IS NULL
    AND location_local_x IS NULL AND location_local_y IS NULL AND location_facing IS NULL)
  OR
  (location_kind = 'interior'
    AND location_type IN ('manor', 'salon', 'cistern_warrens', 'dungeon')
    AND length(location_id) > 0 AND length(location_instance_id) > 0
    AND length(location_space_id) > 0
    AND location_local_x > '-Infinity'::double precision
    AND location_local_x < 'Infinity'::double precision
    AND location_local_y > '-Infinity'::double precision
    AND location_local_y < 'Infinity'::double precision
    AND (location_facing IS NULL OR (location_facing > '-Infinity'::double precision
      AND location_facing < 'Infinity'::double precision)))
);

CREATE TABLE dungeon_instance_runs (
  instance_id text PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (instance_id, run_id),
  CHECK (length(instance_id) > 0)
);

CREATE TABLE dungeon_presence (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  entrance_id text NOT NULL,
  dungeon_id text NOT NULL,
  instance_id text NOT NULL,
  run_id uuid NOT NULL,
  session_id uuid NOT NULL UNIQUE,
  space_id text NOT NULL,
  local_x double precision NOT NULL,
  local_y double precision NOT NULL,
  return_region_code text NOT NULL,
  return_lat double precision NOT NULL CHECK (return_lat BETWEEN -90 AND 90),
  return_lon double precision NOT NULL CHECK (return_lon BETWEEN -180 AND 180),
  entered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (instance_id, run_id)
    REFERENCES dungeon_instance_runs(instance_id, run_id) ON DELETE RESTRICT,
  CHECK (length(entrance_id) > 0 AND length(dungeon_id) > 0
    AND length(instance_id) > 0 AND length(space_id) > 0
    AND local_x > '-Infinity'::double precision AND local_x < 'Infinity'::double precision
    AND local_y > '-Infinity'::double precision AND local_y < 'Infinity'::double precision)
);
CREATE INDEX dungeon_presence_instance_idx ON dungeon_presence (instance_id, space_id);

CREATE TABLE dungeon_reward_claims (
  instance_id text NOT NULL,
  run_id uuid NOT NULL,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  reward_source_id text NOT NULL,
  dungeon_id text NOT NULL,
  reward_table_id text NOT NULL,
  reward_revision text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, player_id, reward_source_id),
  CHECK (length(instance_id) > 0 AND length(reward_source_id) > 0
    AND length(dungeon_id) > 0 AND length(reward_table_id) > 0
    AND length(reward_revision) > 0)
);
