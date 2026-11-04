-- Universal fishing rods, exact waterbody provenance, and hut progression.
-- Forward-only and repeat-safe: the previous freshwater fishing tables remain
-- valid history while new encounters may be started away from a hut.

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES (
  'fishing_rod', 'Fishing Rod', 'resource', 'common', false, 1,
  false, true, false, false, NULL, ARRAY['default']::text[]
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
  updated_at=clock_timestamp();

CREATE TABLE IF NOT EXISTS fishing_rods (
  rod_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  uses_remaining integer NOT NULL DEFAULT 100 CHECK (uses_remaining BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fishing_rods_player_idx ON fishing_rods(player_id, created_at, rod_id);

CREATE TABLE IF NOT EXISTS fishing_player_progression (
  player_id text PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  cast_range_rank smallint NOT NULL DEFAULT 0 CHECK (cast_range_rank BETWEEN 0 AND 3),
  reel_power_rank smallint NOT NULL DEFAULT 0 CHECK (reel_power_rank BETWEEN 0 AND 3),
  line_control_rank smallint NOT NULL DEFAULT 0 CHECK (line_control_rank BETWEEN 0 AND 3),
  specialization_type text NULL CHECK (specialization_type IN ('river','lake','ocean')),
  specialization_selected_at timestamptz NULL,
  specialization_unlocks_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((specialization_type IS NULL) = (specialization_selected_at IS NULL AND specialization_unlocks_at IS NULL)),
  CHECK (specialization_unlocks_at IS NULL OR specialization_selected_at IS NOT NULL AND specialization_unlocks_at > specialization_selected_at)
);

ALTER TABLE fishing_hut_build_jobs
  DROP CONSTRAINT IF EXISTS fishing_hut_build_jobs_waterbody_kind_check;
ALTER TABLE fishing_hut_build_jobs
  ADD CONSTRAINT fishing_hut_build_jobs_waterbody_kind_check CHECK (waterbody_kind IN ('lake','river','ocean'));
ALTER TABLE player_fishing_huts
  DROP CONSTRAINT IF EXISTS player_fishing_huts_waterbody_kind_check;
ALTER TABLE player_fishing_huts
  ADD CONSTRAINT player_fishing_huts_waterbody_kind_check CHECK (waterbody_kind IN ('lake','river','ocean'));

ALTER TABLE fishing_encounters
  ALTER COLUMN fishing_hut_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS fishing_encounters_waterbody_kind_check;
ALTER TABLE fishing_encounters
  ADD CONSTRAINT fishing_encounters_waterbody_kind_check CHECK (waterbody_kind IS NULL OR waterbody_kind IN ('lake','river','ocean'));
ALTER TABLE fishing_encounters
  ADD COLUMN IF NOT EXISTS rod_id uuid NULL REFERENCES fishing_rods(rod_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS waterbody_source_revision text NULL,
  ADD COLUMN IF NOT EXISTS waterbody_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS origin_lat double precision NULL CHECK (origin_lat IS NULL OR origin_lat BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS origin_lon double precision NULL CHECK (origin_lon IS NULL OR origin_lon BETWEEN -180 AND 180),
  ADD COLUMN IF NOT EXISTS region_name text NULL,
  ADD COLUMN IF NOT EXISTS country_name text NULL,
  ADD COLUMN IF NOT EXISTS cast_range_m double precision NOT NULL DEFAULT 300 CHECK (cast_range_m BETWEEN 300 AND 600),
  ADD COLUMN IF NOT EXISTS matching_specialization boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS fishing_encounters_rod_idx ON fishing_encounters(rod_id, created_at DESC);

ALTER TABLE fishing_catch_records
  ALTER COLUMN fishing_hut_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS fishing_catch_records_waterbody_kind_check;
ALTER TABLE fishing_catch_records
  ADD CONSTRAINT fishing_catch_records_waterbody_kind_check CHECK (waterbody_kind IN ('lake','river','ocean')),
  ADD COLUMN IF NOT EXISTS waterbody_source_revision text NULL,
  ADD COLUMN IF NOT EXISTS fish_species text NOT NULL DEFAULT 'freshwater_fish',
  ADD COLUMN IF NOT EXISTS percentile double precision NOT NULL DEFAULT 0 CHECK (percentile BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS region_name text NOT NULL DEFAULT 'Unknown region',
  ADD COLUMN IF NOT EXISTS country_name text NOT NULL DEFAULT 'Unknown country',
  ADD COLUMN IF NOT EXISTS cast_lat double precision NULL CHECK (cast_lat IS NULL OR cast_lat BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS cast_lon double precision NULL CHECK (cast_lon IS NULL OR cast_lon BETWEEN -180 AND 180),
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'active' CHECK (source IN ('active','passive'));
CREATE INDEX IF NOT EXISTS fishing_catch_records_source_idx ON fishing_catch_records(source, created_at DESC);
CREATE INDEX IF NOT EXISTS fishing_catch_records_species_percentile_idx ON fishing_catch_records(fish_species, percentile);

ALTER TABLE fishing_operations
  DROP CONSTRAINT IF EXISTS fishing_operations_action_check;
ALTER TABLE fishing_operations
  ADD CONSTRAINT fishing_operations_action_check CHECK (action IN ('build','collect','start','cast','hook','control','land','cancel','craft_rod','upgrade','specialize'));
ALTER TABLE fishing_operations
  ADD COLUMN IF NOT EXISTS result_jsonb jsonb NULL;

COMMENT ON COLUMN fishing_catch_records.source IS
  'Immutable provenance: active rod catch or passive Fishing Hut production. Passive rows are never leaderboard records.';
COMMENT ON COLUMN fishing_catch_records.percentile IS
  'Empirical percentile from the deterministic catchMetrics generator, not a normal-distribution estimate.';
