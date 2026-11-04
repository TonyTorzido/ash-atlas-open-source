ALTER TABLE cities
  ADD COLUMN IF NOT EXISTS settlement_founding_policy_fingerprint text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cities'::regclass
      AND conname = 'cities_settlement_founding_policy_fingerprint_sha256'
  ) THEN
    ALTER TABLE cities ADD CONSTRAINT cities_settlement_founding_policy_fingerprint_sha256
      CHECK (
        settlement_founding_policy_fingerprint IS NULL
        OR settlement_founding_policy_fingerprint ~ '^[0-9a-f]{64}$'
      );
  END IF;
END $$;

COMMENT ON COLUMN cities.settlement_founding_policy_fingerprint IS
  'Immutable canonical SHA-256 of the World gameplay founding policy used for this city claim.';
