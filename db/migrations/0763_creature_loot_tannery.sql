INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  ('deer_hide', 'Deer Hide', 'resource', 'common', true, 250, true, true, true, true, 'deer_hide', ARRAY['default']::text[]),
  ('hog_hide', 'Hog Hide', 'resource', 'common', true, 250, true, true, true, true, 'hog_hide', ARRAY['default']::text[]),
  ('wolf_pelt', 'Wolf Pelt', 'resource', 'uncommon', true, 250, true, true, true, true, 'wolf_pelt', ARRAY['default']::text[]),
  ('bear_hide', 'Bear Hide', 'resource', 'uncommon', true, 250, true, true, true, true, 'bear_hide', ARRAY['default']::text[]),
  ('alligator_hide', 'Alligator Hide', 'resource', 'uncommon', true, 250, true, true, true, true, 'alligator_hide', ARRAY['default']::text[])
ON CONFLICT (item_id) DO UPDATE
SET display_name=EXCLUDED.display_name, category=EXCLUDED.category, rarity=EXCLUDED.rarity,
    stackable=EXCLUDED.stackable, max_stack=EXCLUDED.max_stack,
    droppable=EXCLUDED.droppable, manor_storable=EXCLUDED.manor_storable,
    market_tradable=EXCLUDED.market_tradable, market_fungible=EXCLUDED.market_fungible,
    market_identity=EXCLUDED.market_identity, supported_variants=EXCLUDED.supported_variants,
    updated_at=now();

CREATE TABLE player_tanneries (
  tannery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  placement_revision bigint NOT NULL DEFAULT 1 CHECK (placement_revision > 0),
  built_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  removal_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_tanneries_world_geom_idx ON player_tanneries USING gist (geom);
CREATE UNIQUE INDEX player_tanneries_active_owner_unique
  ON player_tanneries(owner_player_id) WHERE removed_at IS NULL;

CREATE TABLE tannery_build_jobs (
  build_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  status text NOT NULL DEFAULT 'constructing' CHECK (status IN ('constructing','completed','cancelled')),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  tannery_id uuid NULL REFERENCES player_tanneries(tannery_id) ON DELETE RESTRICT,
  cancel_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_player_id,request_id),
  CHECK (completes_at > started_at),
  CHECK ((status='completed')=(tannery_id IS NOT NULL))
);
CREATE UNIQUE INDEX tannery_build_jobs_active_owner_idx
  ON tannery_build_jobs(owner_player_id) WHERE status='constructing';
CREATE INDEX tannery_build_jobs_due_idx
  ON tannery_build_jobs(completes_at,build_id) WHERE status='constructing';

CREATE TABLE tannery_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tannery_id uuid NOT NULL REFERENCES player_tanneries(tannery_id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  recipe_id text NOT NULL CHECK (recipe_id IN ('deer_hide','hog_hide','wolf_pelt','bear_hide','alligator_hide')),
  requested_input_quantity integer NOT NULL CHECK (requested_input_quantity BETWEEN 1 AND 25),
  output_quantity integer NOT NULL CHECK (output_quantity BETWEEN 1 AND 375),
  collected_quantity integer NOT NULL DEFAULT 0 CHECK (collected_quantity >= 0),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  cleared_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completes_at > started_at),
  CHECK (collected_quantity <= output_quantity)
);
CREATE INDEX tannery_jobs_queue_idx
  ON tannery_jobs(tannery_id,started_at,created_at,job_id) WHERE cleared_at IS NULL;
CREATE INDEX tannery_jobs_owner_idx ON tannery_jobs(owner_player_id,started_at DESC);

CREATE TABLE tannery_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('build','start','collect')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  tannery_id uuid NOT NULL REFERENCES player_tanneries(tannery_id) ON DELETE RESTRICT,
  job_id uuid NULL REFERENCES tannery_jobs(job_id) ON DELETE RESTRICT,
  result_quantity integer NOT NULL DEFAULT 0 CHECK (result_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(player_id,request_id)
);
CREATE INDEX tannery_operations_tannery_idx ON tannery_operations(tannery_id,created_at DESC);
