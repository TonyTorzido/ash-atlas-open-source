-- Kitchen production and the first edible food item.
-- Simple Food is intentionally a plain player-market item. It is not a
-- Goblin Market line; player demand should establish its initial value.

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES (
  'simple_food', 'Simple Food', 'consumable', 'common', true, 250,
  true, true, true, true, 'simple_food', ARRAY['default']::text[]
)
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

CREATE TABLE kitchen_build_jobs (
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
  status text NOT NULL DEFAULT 'constructing'
    CHECK (status IN ('constructing','completed','cancelled')),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  kitchen_id uuid NULL,
  cancel_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_player_id,request_id),
  CHECK (completes_at > started_at),
  CHECK ((status='completed')=(kitchen_id IS NOT NULL))
);
CREATE UNIQUE INDEX kitchen_build_jobs_active_owner_idx
  ON kitchen_build_jobs(owner_player_id) WHERE status='constructing';
CREATE INDEX kitchen_build_jobs_due_idx
  ON kitchen_build_jobs(completes_at,build_id) WHERE status='constructing';

CREATE TABLE player_kitchens (
  kitchen_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
CREATE INDEX player_kitchens_world_geom_idx ON player_kitchens USING gist (geom);
CREATE UNIQUE INDEX player_kitchens_active_owner_unique
  ON player_kitchens(owner_player_id) WHERE removed_at IS NULL;
ALTER TABLE kitchen_build_jobs
  ADD CONSTRAINT kitchen_build_jobs_kitchen_fk
  FOREIGN KEY (kitchen_id) REFERENCES player_kitchens(kitchen_id) ON DELETE RESTRICT;

CREATE TABLE kitchen_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kitchen_id uuid NOT NULL REFERENCES player_kitchens(kitchen_id) ON DELETE RESTRICT,
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  recipe_id text NOT NULL CHECK (recipe_id IN (
    'deer_meat','wolf_meat','hog_meat','bear_meat','alligator_meat','wild_meat','squid_meat'
  )),
  requested_input_quantity integer NOT NULL CHECK (
    requested_input_quantity BETWEEN 10 AND 50
    AND requested_input_quantity % 10 = 0
  ),
  output_quantity integer NOT NULL CHECK (
    output_quantity BETWEEN 1 AND 5
    AND output_quantity * 10 = requested_input_quantity
  ),
  collected_quantity integer NOT NULL DEFAULT 0 CHECK (collected_quantity >= 0),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  cleared_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completes_at > started_at),
  CHECK (collected_quantity <= output_quantity)
);
CREATE INDEX kitchen_jobs_queue_idx
  ON kitchen_jobs(kitchen_id,started_at,created_at,job_id) WHERE cleared_at IS NULL;
CREATE INDEX kitchen_jobs_owner_idx ON kitchen_jobs(owner_player_id,started_at DESC);

CREATE TABLE kitchen_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('build','start','collect')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  kitchen_id uuid NOT NULL REFERENCES player_kitchens(kitchen_id) ON DELETE RESTRICT,
  job_id uuid NULL REFERENCES kitchen_jobs(job_id) ON DELETE RESTRICT,
  result_quantity integer NOT NULL DEFAULT 0 CHECK (result_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(player_id,request_id)
);
CREATE INDEX kitchen_operations_kitchen_idx ON kitchen_operations(kitchen_id,created_at DESC);

CREATE TABLE simple_food_consumption_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  hunger_before integer NOT NULL CHECK (hunger_before >= 0),
  hunger_after integer NOT NULL CHECK (hunger_after >= hunger_before AND hunger_after <= 2000),
  restored_quantity integer NOT NULL CHECK (restored_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(player_id,request_id)
);
CREATE INDEX simple_food_consumption_operations_player_idx
  ON simple_food_consumption_operations(player_id,created_at DESC);
