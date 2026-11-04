-- Greenhouses are durable, owner-scoped locations.  Eligibility is captured
-- at final placement so later World data changes cannot rewrite a build.
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_location_shape_check;
ALTER TABLE players ADD CONSTRAINT players_location_shape_check CHECK (
  (location_kind = 'world' AND location_type IS NULL AND location_id IS NULL
    AND location_instance_id IS NULL AND location_space_id IS NULL
    AND location_local_x IS NULL AND location_local_y IS NULL AND location_facing IS NULL)
  OR
  (location_kind = 'interior'
    AND location_type IN ('manor', 'salon', 'cistern_warrens', 'dungeon', 'greenhouse')
    AND length(location_id) > 0 AND length(location_instance_id) > 0
    AND length(location_space_id) > 0
    AND location_local_x > '-Infinity'::double precision
    AND location_local_x < 'Infinity'::double precision
    AND location_local_y > '-Infinity'::double precision
    AND location_local_y < 'Infinity'::double precision
    AND (location_facing IS NULL OR (location_facing > '-Infinity'::double precision
      AND location_facing < 'Infinity'::double precision)))
);

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  ('wheat_seed', 'Wheat Seed', 'resource', 'common', true, 250,
   true, true, true, true, 'wheat_seed', ARRAY['default']::text[]),
  ('wheat', 'Wheat', 'resource', 'common', true, 250,
   true, true, true, true, 'wheat', ARRAY['default']::text[]),
  ('gardening_bucket', 'Gardening Bucket', 'resource', 'common', false, 1,
   true, true, false, false, NULL, ARRAY['default']::text[]),
  ('water_bucket', 'Water Bucket', 'resource', 'common', false, 1,
   true, true, false, false, NULL, ARRAY['default']::text[])
ON CONFLICT (item_id) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  category=EXCLUDED.category,
  rarity=EXCLUDED.rarity,
  stackable=EXCLUDED.stackable,
  max_stack=EXCLUDED.max_stack,
  droppable=EXCLUDED.droppable,
  manor_storable=EXCLUDED.manor_storable,
  market_tradable=EXCLUDED.market_tradable,
  market_fungible=EXCLUDED.market_fungible,
  market_identity=EXCLUDED.market_identity,
  supported_variants=EXCLUDED.supported_variants,
  updated_at=now();

CREATE TABLE greenhouse_build_jobs (
  build_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  is_riverbank boolean NOT NULL,
  riverbank_policy text NOT NULL,
  riverbank_distance_m integer NOT NULL CHECK (riverbank_distance_m > 0),
  eligibility_checked_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'constructing'
    CHECK (status IN ('constructing','completed','cancelled')),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  greenhouse_id uuid NULL,
  cancel_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_player_id,request_id),
  CHECK (completes_at > started_at),
  CHECK ((status='completed')=(greenhouse_id IS NOT NULL))
);
CREATE UNIQUE INDEX greenhouse_build_jobs_active_owner_idx
  ON greenhouse_build_jobs(owner_player_id) WHERE status='constructing';
CREATE INDEX greenhouse_build_jobs_due_idx
  ON greenhouse_build_jobs(completes_at,build_id) WHERE status='constructing';

CREATE TABLE player_greenhouses (
  greenhouse_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  placement_revision bigint NOT NULL DEFAULT 1 CHECK (placement_revision > 0),
  room_count integer NOT NULL DEFAULT 1 CHECK (room_count > 0),
  planter_capacity integer NOT NULL DEFAULT 15 CHECK (planter_capacity > 0),
  tank_water_tenths integer NOT NULL DEFAULT 0 CHECK (tank_water_tenths BETWEEN 0 AND 200),
  is_riverbank boolean NOT NULL,
  riverbank_policy text NOT NULL,
  riverbank_distance_m integer NOT NULL CHECK (riverbank_distance_m > 0),
  eligibility_checked_at timestamptz NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE greenhouse_build_jobs
  ADD CONSTRAINT greenhouse_build_jobs_greenhouse_fk
  FOREIGN KEY (greenhouse_id) REFERENCES player_greenhouses(greenhouse_id) ON DELETE RESTRICT;
CREATE INDEX player_greenhouses_world_geom_idx ON player_greenhouses USING gist (geom);
CREATE UNIQUE INDEX player_greenhouses_active_owner_unique
  ON player_greenhouses(owner_player_id) WHERE removed_at IS NULL;

CREATE TABLE greenhouse_plant_anchors (
  anchor_id text NOT NULL,
  greenhouse_id uuid NOT NULL REFERENCES player_greenhouses(greenhouse_id) ON DELETE RESTRICT,
  room_id text NOT NULL,
  row_index integer NOT NULL CHECK (row_index >= 0),
  column_index integer NOT NULL CHECK (column_index >= 0),
  x double precision NOT NULL,
  y double precision NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (greenhouse_id,anchor_id),
  UNIQUE(greenhouse_id,room_id,row_index,column_index)
);
CREATE INDEX greenhouse_plant_anchors_greenhouse_idx
  ON greenhouse_plant_anchors(greenhouse_id,room_id,row_index,column_index);

CREATE TABLE greenhouse_plants (
  anchor_id text NOT NULL,
  greenhouse_id uuid NOT NULL REFERENCES player_greenhouses(greenhouse_id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  stage integer NOT NULL CHECK (stage BETWEEN 1 AND 4),
  planted_at timestamptz NOT NULL,
  watered_at timestamptz NULL,
  next_stage_at timestamptz NULL,
  dry boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (greenhouse_id,anchor_id),
  FOREIGN KEY (greenhouse_id,anchor_id) REFERENCES greenhouse_plant_anchors(greenhouse_id,anchor_id) ON DELETE RESTRICT,
  CHECK ((dry AND next_stage_at IS NULL) OR (NOT dry AND next_stage_at IS NOT NULL))
);
CREATE INDEX greenhouse_plants_due_idx
  ON greenhouse_plants(next_stage_at,anchor_id) WHERE dry=false;

CREATE TABLE greenhouse_water_buckets (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  water_bucket_tenths integer NOT NULL DEFAULT 0 CHECK (water_bucket_tenths BETWEEN 0 AND 50),
  gardening_bucket_tenths integer NOT NULL DEFAULT 0 CHECK (gardening_bucket_tenths BETWEEN 0 AND 10),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE greenhouse_water_fills (
  fill_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  target_lat double precision NOT NULL CHECK (target_lat BETWEEN -90 AND 90),
  target_lon double precision NOT NULL CHECK (target_lon BETWEEN -180 AND 180),
  requested_tenths integer NOT NULL CHECK (requested_tenths BETWEEN 10 AND 50),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  credited_tenths integer NOT NULL DEFAULT 0 CHECK (credited_tenths BETWEEN 0 AND requested_tenths),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completes_at > started_at)
);
CREATE UNIQUE INDEX greenhouse_water_fills_active_player_idx
  ON greenhouse_water_fills(player_id) WHERE status='active';

CREATE TABLE greenhouse_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  action text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  greenhouse_id uuid NULL REFERENCES player_greenhouses(greenhouse_id) ON DELETE RESTRICT,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(player_id,request_id)
);
CREATE INDEX greenhouse_operations_greenhouse_idx
  ON greenhouse_operations(greenhouse_id,created_at DESC);
