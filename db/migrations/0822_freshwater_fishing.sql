-- Freshwater Fishing V1: one World-authoritative outdoor hut per player,
-- finite passive storage, durable active encounters/catch records, and
-- replay-safe operation keys. This migration is forward-only and repeat-safe.

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES
  ('freshwater_fish', 'Freshwater Fish', 'resource', 'common', true, 250,
   true, true, true, true, 'freshwater_fish', ARRAY['default']::text[]),
  ('ashen_fish', 'Ashen Fish', 'resource', 'legendary', true, 25,
   true, true, true, true, 'ashen_fish', ARRAY['default']::text[])
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
  updated_at=clock_timestamp();

ALTER TABLE kitchen_jobs
  DROP CONSTRAINT IF EXISTS kitchen_jobs_recipe_id_check,
  ADD CONSTRAINT kitchen_jobs_recipe_id_check CHECK (recipe_id IN (
    'deer_meat','wolf_meat','hog_meat','bear_meat','alligator_meat',
    'wild_meat','squid_meat','freshwater_fish'
  ));

CREATE TABLE IF NOT EXISTS fishing_hut_build_jobs (
  build_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  waterbody_kind text NOT NULL CHECK (waterbody_kind IN ('lake','river')),
  waterbody_source_id text NOT NULL,
  waterbody_name text NOT NULL,
  waterbody_distance_m double precision NOT NULL CHECK (waterbody_distance_m BETWEEN 0 AND 500),
  world_source_revision text NULL,
  world_source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'constructing'
    CHECK (status IN ('constructing','completed','cancelled')),
  started_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  fishing_hut_id uuid NULL,
  cancel_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_player_id, request_id),
  CHECK (completes_at > started_at),
  CHECK ((status='completed')=(fishing_hut_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fishing_hut_build_jobs_active_owner_idx
  ON fishing_hut_build_jobs(owner_player_id) WHERE status='constructing';
CREATE INDEX IF NOT EXISTS fishing_hut_build_jobs_due_idx
  ON fishing_hut_build_jobs(completes_at,build_id) WHERE status='constructing';

CREATE TABLE IF NOT EXISTS player_fishing_huts (
  fishing_hut_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  world_id text NOT NULL,
  region_code text NOT NULL,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom geometry(Point,4326) NOT NULL,
  waterbody_kind text NOT NULL CHECK (waterbody_kind IN ('lake','river')),
  waterbody_source_id text NOT NULL,
  waterbody_name text NOT NULL,
  waterbody_distance_m double precision NOT NULL CHECK (waterbody_distance_m BETWEEN 0 AND 500),
  world_source_revision text NULL,
  world_source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  placement_revision bigint NOT NULL DEFAULT 1 CHECK (placement_revision > 0),
  built_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  removal_reason text NULL,
  passive_last_produced_at timestamptz NOT NULL DEFAULT now(),
  passive_stored_quantity integer NOT NULL DEFAULT 0 CHECK (passive_stored_quantity BETWEEN 0 AND 16),
  passive_capacity integer NOT NULL DEFAULT 16 CHECK (passive_capacity = 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_fishing_huts_world_geom_idx ON player_fishing_huts USING gist (geom);
CREATE INDEX IF NOT EXISTS player_fishing_huts_waterbody_idx
  ON player_fishing_huts(waterbody_kind,waterbody_source_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS player_fishing_huts_active_owner_unique
  ON player_fishing_huts(owner_player_id) WHERE removed_at IS NULL;
ALTER TABLE fishing_hut_build_jobs
  DROP CONSTRAINT IF EXISTS fishing_hut_build_jobs_hut_fk;
DO $$
BEGIN
  ALTER TABLE fishing_hut_build_jobs
    ADD CONSTRAINT fishing_hut_build_jobs_hut_fk
    FOREIGN KEY (fishing_hut_id) REFERENCES player_fishing_huts(fishing_hut_id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

CREATE TABLE IF NOT EXISTS fishing_food_accumulators (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  accumulator_milli bigint NOT NULL DEFAULT 0 CHECK (accumulator_milli BETWEEN 0 AND 999),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fishing_encounters (
  encounter_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  fishing_hut_id uuid NOT NULL REFERENCES player_fishing_huts(fishing_hut_id) ON DELETE RESTRICT,
  waterbody_kind text NOT NULL CHECK (waterbody_kind IN ('lake','river')),
  waterbody_source_id text NOT NULL,
  waterbody_name text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('cast','bite','hooked','fighting','landed','escaped','expired','cancelled')),
  behavior_profile text NOT NULL CHECK (behavior_profile IN ('runner','darter','tank','feinter')),
  seed bigint NOT NULL,
  difficulty double precision NOT NULL CHECK (difficulty BETWEEN 0 AND 1),
  ashen boolean NOT NULL DEFAULT false,
  cast_quality double precision NULL CHECK (cast_quality IS NULL OR cast_quality BETWEEN 0 AND 1),
  length_in double precision NULL CHECK (length_in IS NULL OR length_in > 0),
  weight_lb double precision NULL CHECK (weight_lb IS NULL OR weight_lb > 0),
  size_percentile double precision NULL CHECK (size_percentile IS NULL OR size_percentile BETWEEN 0 AND 1),
  score integer NULL CHECK (score IS NULL OR score BETWEEN 0 AND 1000),
  perfect boolean NOT NULL DEFAULT false,
  tension double precision NOT NULL DEFAULT 45 CHECK (tension BETWEEN 0 AND 100),
  distance double precision NOT NULL DEFAULT 75 CHECK (distance BETWEEN 0 AND 100),
  stamina double precision NOT NULL DEFAULT 100 CHECK (stamina BETWEEN 0 AND 100),
  slack_ms integer NOT NULL DEFAULT 0 CHECK (slack_ms >= 0),
  critical_ms integer NOT NULL DEFAULT 0 CHECK (critical_ms >= 0),
  fish_direction text NOT NULL DEFAULT 'left' CHECK (fish_direction IN ('left','right','neutral')),
  fish_pull double precision NOT NULL DEFAULT 1 CHECK (fish_pull BETWEEN 0.1 AND 3),
  execution_quality double precision NOT NULL DEFAULT 0 CHECK (execution_quality BETWEEN 0 AND 1),
  started_at timestamptz NOT NULL DEFAULT now(),
  bite_at timestamptz NOT NULL,
  hooked_at timestamptz NULL,
  last_action_at timestamptz NOT NULL DEFAULT now(),
  reconnect_deadline_at timestamptz NOT NULL,
  disconnected_at timestamptz NULL,
  completed_at timestamptz NULL,
  result_quantity integer NOT NULL DEFAULT 0 CHECK (result_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fishing_encounters
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fishing_encounters_active_player_unique
  ON fishing_encounters(player_id)
  WHERE phase IN ('cast','bite','hooked','fighting');
CREATE INDEX IF NOT EXISTS fishing_encounters_reconnect_idx
  ON fishing_encounters(player_id,reconnect_deadline_at DESC)
  WHERE phase IN ('cast','bite','hooked','fighting');
CREATE INDEX IF NOT EXISTS fishing_encounters_hut_idx
  ON fishing_encounters(fishing_hut_id,created_at DESC);

CREATE TABLE IF NOT EXISTS fishing_catch_records (
  catch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL UNIQUE REFERENCES fishing_encounters(encounter_id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  fishing_hut_id uuid NOT NULL REFERENCES player_fishing_huts(fishing_hut_id) ON DELETE RESTRICT,
  waterbody_kind text NOT NULL CHECK (waterbody_kind IN ('lake','river')),
  waterbody_source_id text NOT NULL,
  waterbody_name text NOT NULL,
  fish_item_id text NOT NULL CHECK (fish_item_id IN ('freshwater_fish','ashen_fish')),
  ashen boolean NOT NULL DEFAULT false,
  behavior_profile text NOT NULL CHECK (behavior_profile IN ('runner','darter','tank','feinter')),
  difficulty double precision NOT NULL CHECK (difficulty BETWEEN 0 AND 1),
  world_source_revision text NULL,
  environment_schema_version text NULL,
  length_in double precision NOT NULL CHECK (length_in > 0),
  weight_lb double precision NOT NULL CHECK (weight_lb > 0),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 1000),
  perfect boolean NOT NULL DEFAULT false,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  week_start date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fishing_catch_records
  ADD COLUMN IF NOT EXISTS world_source_revision text NULL,
  ADD COLUMN IF NOT EXISTS environment_schema_version text NULL;
CREATE INDEX IF NOT EXISTS fishing_catch_records_weekly_score_idx
  ON fishing_catch_records(week_start,score DESC,created_at ASC,catch_id);
CREATE INDEX IF NOT EXISTS fishing_catch_records_player_week_idx
  ON fishing_catch_records(player_id,week_start,score DESC,created_at ASC,catch_id);
CREATE INDEX IF NOT EXISTS fishing_catch_records_player_ashen_idx
  ON fishing_catch_records(player_id,created_at DESC,catch_id) WHERE ashen;
CREATE INDEX IF NOT EXISTS fishing_catch_records_waterbody_weight_idx
  ON fishing_catch_records(waterbody_kind,waterbody_source_id,weight_lb DESC,created_at ASC,catch_id);
CREATE INDEX IF NOT EXISTS fishing_catch_records_waterbody_score_idx
  ON fishing_catch_records(waterbody_kind,waterbody_source_id,score DESC,created_at ASC,catch_id);

CREATE TABLE IF NOT EXISTS fishing_operations (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('build','collect','start','cast','hook','control','land','cancel')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  fishing_hut_id uuid NULL REFERENCES player_fishing_huts(fishing_hut_id) ON DELETE RESTRICT,
  encounter_id uuid NULL REFERENCES fishing_encounters(encounter_id) ON DELETE RESTRICT,
  result_quantity integer NOT NULL DEFAULT 0 CHECK (result_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(player_id,request_id)
);
CREATE INDEX IF NOT EXISTS fishing_operations_player_idx ON fishing_operations(player_id,created_at DESC);
CREATE INDEX IF NOT EXISTS fishing_operations_encounter_idx ON fishing_operations(encounter_id,created_at DESC);
