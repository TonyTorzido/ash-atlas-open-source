-- Durable flag-centered Resource Vision and deterministic permanent mine allocation.

ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS resource_vision_radius_m double precision;

UPDATE flags
SET resource_vision_radius_m = 1500
WHERE resource_vision_radius_m IS NULL;

ALTER TABLE flags
  ALTER COLUMN resource_vision_radius_m SET DEFAULT 1500,
  ALTER COLUMN resource_vision_radius_m SET NOT NULL,
  ADD CONSTRAINT flags_resource_vision_radius_domain
    CHECK (resource_vision_radius_m > 0 AND resource_vision_radius_m <= 10000);

ALTER TABLE repeatable_resource_nodes
  ADD COLUMN IF NOT EXISTS placement_bucket_key text,
  ADD COLUMN IF NOT EXISTS placement_version text;

UPDATE repeatable_resource_nodes
SET placement_bucket_key = 'authored:' || id::text,
    placement_version = 'authored-v1'
WHERE placement_bucket_key IS NULL OR placement_version IS NULL;

ALTER TABLE repeatable_resource_nodes
  ALTER COLUMN placement_bucket_key SET NOT NULL,
  ALTER COLUMN placement_version SET NOT NULL,
  ADD CONSTRAINT repeatable_resource_nodes_placement_bucket_unique UNIQUE (placement_bucket_key);

CREATE TABLE IF NOT EXISTS permanent_mine_allocation_buckets (
  bucket_key text PRIMARY KEY,
  placement_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  candidate_index smallint NULL CHECK (candidate_index >= 0),
  mine_id uuid NULL UNIQUE,
  lat double precision NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NULL CHECK (lon BETWEEN -180 AND 180),
  region_code text NULL,
  world_package_id text NULL,
  world_ecoregion text NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (decision = 'accepted' AND candidate_index IS NOT NULL AND mine_id IS NOT NULL
      AND lat IS NOT NULL AND lon IS NOT NULL AND region_code IS NOT NULL)
    OR
    (decision = 'rejected' AND candidate_index IS NULL AND mine_id IS NULL
      AND lat IS NULL AND lon IS NULL AND region_code IS NULL)
  )
);

CREATE OR REPLACE FUNCTION protect_permanent_mine_placement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.placement_version <> 'authored-v1' AND (
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.lat IS DISTINCT FROM OLD.lat OR
    NEW.lon IS DISTINCT FROM OLD.lon OR
    NEW.geom IS DISTINCT FROM OLD.geom OR
    NEW.placement_bucket_key IS DISTINCT FROM OLD.placement_bucket_key OR
    NEW.placement_version IS DISTINCT FROM OLD.placement_version
  ) THEN
    RAISE EXCEPTION 'permanent mine placement is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'repeatable_resource_nodes_placement_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS repeatable_resource_nodes_protect_placement ON repeatable_resource_nodes;
CREATE TRIGGER repeatable_resource_nodes_protect_placement
BEFORE UPDATE ON repeatable_resource_nodes
FOR EACH ROW EXECUTE FUNCTION protect_permanent_mine_placement();
