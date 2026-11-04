ALTER TABLE cities
  ADD COLUMN IF NOT EXISTS settlement_class text NULL,
  ADD COLUMN IF NOT EXISTS settlement_release_id text NULL,
  ADD COLUMN IF NOT EXISTS settlement_release_fingerprint text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cities'::regclass
      AND conname = 'cities_settlement_class_nonempty'
  ) THEN
    ALTER TABLE cities ADD CONSTRAINT cities_settlement_class_nonempty
      CHECK (settlement_class IS NULL OR length(btrim(settlement_class)) > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cities'::regclass
      AND conname = 'cities_settlement_release_id_nonempty'
  ) THEN
    ALTER TABLE cities ADD CONSTRAINT cities_settlement_release_id_nonempty
      CHECK (settlement_release_id IS NULL OR length(btrim(settlement_release_id)) > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cities'::regclass
      AND conname = 'cities_settlement_release_fingerprint_valid'
  ) THEN
    ALTER TABLE cities ADD CONSTRAINT cities_settlement_release_fingerprint_valid
      CHECK (
        settlement_release_fingerprint IS NULL
        OR settlement_release_fingerprint ~ '^[0-9a-f]{64}$'
      );
  END IF;
END
$$;

COMMENT ON COLUMN cities.settlement_class IS
  'Settlement class returned by World authority when the city was founded; legacy rows remain NULL.';
COMMENT ON COLUMN cities.settlement_release_id IS
  'Immutable World settlement release used at founding; later releases do not rewrite this value.';
COMMENT ON COLUMN cities.settlement_release_fingerprint IS
  'SHA-256 identity of the immutable World settlement release manifest used at founding.';
