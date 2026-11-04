-- Durable geographic provenance for fishing encounters and catches.
--
-- These columns are deliberately nullable: canonical World context is captured
-- when available, while a temporary presentation/admin lookup failure must not
-- prevent the core catch from being committed. Existing source IDs are already
-- canonical waterbody IDs under the current fishing contract, so this migration
-- copies only those retained identities and never derives IDs from display names.

ALTER TABLE fishing_encounters
  ADD COLUMN IF NOT EXISTS country_id text NULL,
  ADD COLUMN IF NOT EXISTS admin1_id text NULL,
  ADD COLUMN IF NOT EXISTS admin1_name text NULL,
  ADD COLUMN IF NOT EXISTS canonical_waterbody_id text NULL,
  ADD COLUMN IF NOT EXISTS gameplay_water_type text NULL,
  ADD COLUMN IF NOT EXISTS canonical_display_name text NULL,
  ADD COLUMN IF NOT EXISTS waterbody_resolution_state text NULL,
  ADD COLUMN IF NOT EXISTS marine_parent_id text NULL,
  ADD COLUMN IF NOT EXISTS marine_parent_name text NULL,
  ADD COLUMN IF NOT EXISTS presentation_name text NULL,
  ADD COLUMN IF NOT EXISTS presentation_relation text NULL,
  ADD COLUMN IF NOT EXISTS presentation_distance_m double precision NULL,
  ADD COLUMN IF NOT EXISTS geo_context_captured_at timestamptz NULL;

ALTER TABLE fishing_catch_records
  ADD COLUMN IF NOT EXISTS country_id text NULL,
  ADD COLUMN IF NOT EXISTS admin1_id text NULL,
  ADD COLUMN IF NOT EXISTS admin1_name text NULL,
  ADD COLUMN IF NOT EXISTS canonical_waterbody_id text NULL,
  ADD COLUMN IF NOT EXISTS gameplay_water_type text NULL,
  ADD COLUMN IF NOT EXISTS canonical_display_name text NULL,
  ADD COLUMN IF NOT EXISTS waterbody_resolution_state text NULL,
  ADD COLUMN IF NOT EXISTS marine_parent_id text NULL,
  ADD COLUMN IF NOT EXISTS marine_parent_name text NULL,
  ADD COLUMN IF NOT EXISTS presentation_name text NULL,
  ADD COLUMN IF NOT EXISTS presentation_relation text NULL,
  ADD COLUMN IF NOT EXISTS presentation_distance_m double precision NULL,
  ADD COLUMN IF NOT EXISTS catch_lat double precision NULL,
  ADD COLUMN IF NOT EXISTS catch_lon double precision NULL,
  ADD COLUMN IF NOT EXISTS caught_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fishing_encounters_geo_water_type_check'
      AND conrelid = 'fishing_encounters'::regclass
  ) THEN
    ALTER TABLE fishing_encounters ADD CONSTRAINT fishing_encounters_geo_water_type_check
      CHECK (gameplay_water_type IS NULL OR gameplay_water_type IN ('river','lake','ocean'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fishing_encounters_geo_resolution_state_check'
      AND conrelid = 'fishing_encounters'::regclass
  ) THEN
    ALTER TABLE fishing_encounters ADD CONSTRAINT fishing_encounters_geo_resolution_state_check
      CHECK (waterbody_resolution_state IS NULL OR waterbody_resolution_state IN ('resolved','unresolved','ambiguous','invalid','not_applicable'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fishing_encounters_geo_presentation_relation_check'
      AND conrelid = 'fishing_encounters'::regclass
  ) THEN
    ALTER TABLE fishing_encounters ADD CONSTRAINT fishing_encounters_geo_presentation_relation_check
      CHECK (presentation_relation IS NULL OR presentation_relation IN ('exact','near','unnamed','open_ocean'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fishing_encounters_geo_presentation_distance_check'
      AND conrelid = 'fishing_encounters'::regclass
  ) THEN
    ALTER TABLE fishing_encounters ADD CONSTRAINT fishing_encounters_geo_presentation_distance_check
      CHECK (presentation_distance_m IS NULL OR presentation_distance_m >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fishing_catch_records_geo_water_type_check'
      AND conrelid = 'fishing_catch_records'::regclass
  ) THEN
    ALTER TABLE fishing_catch_records ADD CONSTRAINT fishing_catch_records_geo_water_type_check
      CHECK (gameplay_water_type IS NULL OR gameplay_water_type IN ('river','lake','ocean'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fishing_catch_records_geo_resolution_state_check'
      AND conrelid = 'fishing_catch_records'::regclass
  ) THEN
    ALTER TABLE fishing_catch_records ADD CONSTRAINT fishing_catch_records_geo_resolution_state_check
      CHECK (waterbody_resolution_state IS NULL OR waterbody_resolution_state IN ('resolved','unresolved','ambiguous','invalid','not_applicable'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fishing_catch_records_geo_presentation_relation_check'
      AND conrelid = 'fishing_catch_records'::regclass
  ) THEN
    ALTER TABLE fishing_catch_records ADD CONSTRAINT fishing_catch_records_geo_presentation_relation_check
      CHECK (presentation_relation IS NULL OR presentation_relation IN ('exact','near','unnamed','open_ocean'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fishing_catch_records_geo_presentation_distance_check'
      AND conrelid = 'fishing_catch_records'::regclass
  ) THEN
    ALTER TABLE fishing_catch_records ADD CONSTRAINT fishing_catch_records_geo_presentation_distance_check
      CHECK (presentation_distance_m IS NULL OR presentation_distance_m >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fishing_catch_records_catch_point_pair_check'
      AND conrelid = 'fishing_catch_records'::regclass
  ) THEN
    ALTER TABLE fishing_catch_records ADD CONSTRAINT fishing_catch_records_catch_point_pair_check
      CHECK ((catch_lat IS NULL) = (catch_lon IS NULL));
  END IF;
END $$;

-- Existing fishing source IDs are the canonical IDs used by the current World
-- adapter. Preserve them explicitly for future consumers without guessing any
-- rows whose identity was absent.
UPDATE fishing_encounters
SET canonical_waterbody_id = COALESCE(NULLIF(BTRIM(canonical_waterbody_id), ''), NULLIF(BTRIM(waterbody_source_id), '')),
    gameplay_water_type = COALESCE(NULLIF(BTRIM(gameplay_water_type), ''), NULLIF(BTRIM(waterbody_kind), '')),
    canonical_display_name = COALESCE(NULLIF(BTRIM(canonical_display_name), ''), NULLIF(BTRIM(waterbody_name), '')),
    waterbody_resolution_state = COALESCE(NULLIF(BTRIM(waterbody_resolution_state), ''), CASE WHEN NULLIF(BTRIM(waterbody_source_id), '') IS NOT NULL THEN 'resolved' ELSE 'unresolved' END),
    admin1_name = COALESCE(NULLIF(BTRIM(admin1_name), ''), NULLIF(BTRIM(region_name), '')),
    geo_context_captured_at = COALESCE(geo_context_captured_at, updated_at)
WHERE canonical_waterbody_id IS NULL
   OR gameplay_water_type IS NULL
   OR canonical_display_name IS NULL
   OR waterbody_resolution_state IS NULL
   OR admin1_name IS NULL
   OR geo_context_captured_at IS NULL;

UPDATE fishing_catch_records AS catches
SET canonical_waterbody_id = COALESCE(NULLIF(BTRIM(catches.canonical_waterbody_id), ''), NULLIF(BTRIM(catches.waterbody_source_id), '')),
    gameplay_water_type = COALESCE(NULLIF(BTRIM(catches.gameplay_water_type), ''), NULLIF(BTRIM(catches.waterbody_kind), '')),
    canonical_display_name = COALESCE(NULLIF(BTRIM(catches.canonical_display_name), ''), NULLIF(BTRIM(catches.waterbody_name), '')),
    waterbody_resolution_state = COALESCE(NULLIF(BTRIM(catches.waterbody_resolution_state), ''), CASE WHEN NULLIF(BTRIM(catches.waterbody_source_id), '') IS NOT NULL THEN 'resolved' ELSE 'unresolved' END),
    admin1_id = COALESCE(catches.admin1_id, encounters.admin1_id),
    admin1_name = COALESCE(NULLIF(BTRIM(catches.admin1_name), ''), NULLIF(BTRIM(encounters.admin1_name), ''), NULLIF(BTRIM(catches.region_name), '')),
    country_id = COALESCE(catches.country_id, encounters.country_id),
    country_name = COALESCE(NULLIF(BTRIM(catches.country_name), ''), NULLIF(BTRIM(encounters.country_name), '')),
    catch_lat = COALESCE(catches.catch_lat, catches.cast_lat),
    catch_lon = COALESCE(catches.catch_lon, catches.cast_lon),
    caught_at = COALESCE(catches.caught_at, catches.created_at)
FROM fishing_encounters AS encounters
WHERE catches.encounter_id = encounters.encounter_id;

CREATE INDEX IF NOT EXISTS fishing_encounters_geo_waterbody_idx
  ON fishing_encounters(canonical_waterbody_id, created_at DESC)
  WHERE canonical_waterbody_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fishing_encounters_geo_admin_idx
  ON fishing_encounters(country_id, admin1_id, created_at DESC)
  WHERE country_id IS NOT NULL OR admin1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fishing_catch_records_geo_waterbody_idx
  ON fishing_catch_records(canonical_waterbody_id, caught_at DESC, catch_id)
  WHERE canonical_waterbody_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fishing_catch_records_geo_admin_idx
  ON fishing_catch_records(country_id, admin1_id, caught_at DESC, catch_id)
  WHERE country_id IS NOT NULL OR admin1_id IS NOT NULL;

COMMENT ON COLUMN fishing_catch_records.canonical_waterbody_id IS
  'World identity overlay ID; NULL is retained for unresolved or ambiguous water.';
COMMENT ON COLUMN fishing_catch_records.presentation_name IS
  'Display-only water name, including typed or same-class nearest fallbacks; never an identity.';
COMMENT ON COLUMN fishing_catch_records.caught_at IS
  'Authoritative catch timestamp captured in the same transaction as the catch record.';
