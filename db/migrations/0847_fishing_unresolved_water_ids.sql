-- Allow universal fishing to retain an authoritative water class when the
-- canonical feature identity is unresolved. NULL is explicitly noncanonical;
-- the separate waterbody name remains presentation-only.
ALTER TABLE fishing_encounters
  ALTER COLUMN waterbody_source_id DROP NOT NULL,
  ALTER COLUMN waterbody_name DROP NOT NULL;

ALTER TABLE fishing_catch_records
  ALTER COLUMN waterbody_source_id DROP NOT NULL;

COMMENT ON COLUMN fishing_encounters.waterbody_source_id IS
  'Canonical waterbody source ID; NULL means the exact fishable location was not canonically resolved.';
COMMENT ON COLUMN fishing_catch_records.waterbody_source_id IS
  'Canonical waterbody source ID; NULL means the exact fishable catch location was not canonically resolved.';
