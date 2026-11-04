-- Bind the requested overworld cast spot to the durable encounter.  The
-- pair-check prevents a partially persisted point from being interpreted as
-- an authoritative cast after reconnect.
ALTER TABLE fishing_encounters
  ADD COLUMN IF NOT EXISTS cast_lat double precision,
  ADD COLUMN IF NOT EXISTS cast_lon double precision;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fishing_encounters_cast_point_pair_check'
      AND conrelid = 'fishing_encounters'::regclass
  ) THEN
    ALTER TABLE fishing_encounters
      ADD CONSTRAINT fishing_encounters_cast_point_pair_check
      CHECK ((cast_lat IS NULL) = (cast_lon IS NULL));
  END IF;
END $$;
