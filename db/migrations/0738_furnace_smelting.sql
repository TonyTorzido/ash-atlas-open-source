INSERT INTO item_definitions (
  item_id, display_name, category, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES (
  'iron_bar', 'Iron Bar', 'resource', true, 250,
  true, true, false, false, NULL, ARRAY['default']::text[]
)
ON CONFLICT (item_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    category = EXCLUDED.category,
    stackable = EXCLUDED.stackable,
    max_stack = EXCLUDED.max_stack,
    droppable = EXCLUDED.droppable,
    manor_storable = EXCLUDED.manor_storable,
    market_tradable = EXCLUDED.market_tradable,
    market_fungible = EXCLUDED.market_fungible,
    market_identity = EXCLUDED.market_identity,
    supported_variants = EXCLUDED.supported_variants,
    updated_at = now();

CREATE TABLE player_furnaces (
  furnace_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point, 4326) NOT NULL,
  placement_revision bigint NOT NULL DEFAULT 1 CHECK (placement_revision > 0),
  built_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX player_furnaces_world_geom_idx
  ON player_furnaces USING gist (geom);
CREATE INDEX player_furnaces_owner_idx
  ON player_furnaces (owner_player_id, built_at DESC);

CREATE TABLE furnace_smelt_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  furnace_id uuid NOT NULL REFERENCES player_furnaces(furnace_id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  requested_quantity integer NOT NULL CHECK (requested_quantity BETWEEN 1 AND 5),
  collected_quantity integer NOT NULL DEFAULT 0 CHECK (collected_quantity >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (collected_quantity <= requested_quantity)
);

CREATE UNIQUE INDEX furnace_smelt_jobs_current_idx
  ON furnace_smelt_jobs (furnace_id)
  WHERE cleared_at IS NULL;
CREATE INDEX furnace_smelt_jobs_owner_idx
  ON furnace_smelt_jobs (owner_player_id, started_at DESC);

CREATE TABLE furnace_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('build', 'start', 'collect')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  furnace_id uuid NOT NULL REFERENCES player_furnaces(furnace_id) ON DELETE RESTRICT,
  job_id uuid NULL REFERENCES furnace_smelt_jobs(job_id) ON DELETE RESTRICT,
  result_quantity integer NOT NULL DEFAULT 0 CHECK (result_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, request_id)
);

CREATE INDEX furnace_operations_furnace_idx
  ON furnace_operations (furnace_id, created_at DESC);
