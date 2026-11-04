ALTER TABLE cities
  ADD COLUMN IF NOT EXISTS settlement_resolution_policy_id text NULL,
  ADD COLUMN IF NOT EXISTS settlement_resolution_policy_fingerprint text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cities_settlement_resolution_policy_id_nonempty'
  ) THEN
    ALTER TABLE cities ADD CONSTRAINT cities_settlement_resolution_policy_id_nonempty
      CHECK (
        settlement_resolution_policy_id IS NULL
        OR length(btrim(settlement_resolution_policy_id)) > 0
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cities_settlement_resolution_policy_fingerprint_sha256'
  ) THEN
    ALTER TABLE cities ADD CONSTRAINT cities_settlement_resolution_policy_fingerprint_sha256
      CHECK (
        settlement_resolution_policy_fingerprint IS NULL
        OR settlement_resolution_policy_fingerprint ~ '^[0-9a-f]{64}$'
      );
  END IF;
END $$;

COMMENT ON COLUMN cities.settlement_resolution_policy_id IS
  'World primary-settlement resolution policy used when the city was founded.';
COMMENT ON COLUMN cities.settlement_resolution_policy_fingerprint IS
  'SHA-256 identity of the World primary-settlement resolution policy.';
